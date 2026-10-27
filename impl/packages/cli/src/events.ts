// `events.jsonl`: the home's shared, append-only event log (issue #9).
//
// The home's one inbound consumer (whoever holds `listener.lock`: `rdv listen`
// or `rdv-mcp`) appends every event it handles, inside the state lock, after
// the state that produced it is on disk. `rdv-mcp` also appends its own
// events (tool results such as a grant). Readers (an `rdv-mcp` attached to
// another consumer, or a restarted one) follow the file by cursor `n`, which
// only grows, so nothing is lost or seen twice across processes.
//
// Appends take `events.lock`, so `n` is assigned by one writer at a time. The
// file is compacted (rewritten atomically to its last EVENTS_FILE_KEPT lines)
// when it doubles; readers re-read the whole file, so compaction is invisible
// to them apart from dropping very old events.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { acquireLock, writeAtomic } from './fsutil.js';
import { type Home, parseJsonLines } from './home.js';
import { clean } from './output.js';

/** Lines kept after compaction; the file is compacted at twice this. */
export const EVENTS_FILE_KEPT = 1000;

export interface LoggedEvent {
  /** Cursor: strictly increasing in the file. */
  n: number;
  ts: string;
  /** The writer ran the negotiation engine (its dinner events cover a2a messages). */
  negotiated?: boolean;
  obj: { event: string } & Record<string, unknown>;
}

/**
 * Drop reasons any stranger can trigger at will. Writing them would only push
 * real events out of the log (security review M1), so they are not logged.
 */
export const STRANGER_DROPS = [
  'contact request',
  'no grant for sender',
  'out-of-order envelope from a non-contact',
  'unexpected or invalid grant',
  'topic doc',
  'request signer differs',
  'grant signer differs',
  'blocked sender',
  'envelope chain fork from a non-contact',
  'card update from a non-contact',
  // Receipts (issue #104): only contacts' count; our own echo is the relay's, not news.
  'ack from a non-contact',
  'own envelope',
  // Groups (issue #77): only contacts invite and join, only members send states.
  'group invite from a non-contact',
  'group join from a non-contact',
  'group state from a non-member',
  'group members from a non-member',
  // Group messages (issue #78): only members talk in a group.
  'group message from a non-member',
  'group proof from a non-member',
  'group leave from a non-member',
  'group report from a non-member',
];

/** Events not worth a line in the log: relay replays, stranger-caused drops, all but every 50th eviction. */
export function isNoise(obj: { event: string } & Record<string, unknown>): boolean {
  if (obj.event === 'dropped') {
    const reason = String(obj.reason);
    return reason.includes('duplicate') || reason.includes('replay') || STRANGER_DROPS.some((r) => reason.startsWith(r));
  }
  if (obj.event === 'pending-evicted') {
    const total = obj.total;
    return typeof total === 'number' && total !== 1 && total % 50 !== 0;
  }
  return false;
}

const REFUSED_GRANT = 'unexpected or invalid grant';
const TRACE_LINES_MAX = 20;
let traced = 0;

/**
 * A grant (a probe answer, a reverse grant) that was refused is kept out of the
 * log and the inbox on purpose: any stranger can send one, and it would push
 * real events out (STRANGER_DROPS). But a legitimate answer refused for a
 * reason of ours (expired, wrong sender) then leaves no trace at all (issue
 * #101). So one stderr line, which is the process log (`rdv listen`, or the MCP
 * client's server log), capped per process so a flood cannot fill it.
 */
function traceRefusedGrants(objs: Array<{ event: string } & Record<string, unknown>>): void {
  for (const o of objs) {
    if (o.event !== 'dropped' || !String(o.reason).startsWith(REFUSED_GRANT)) continue;
    if (traced >= TRACE_LINES_MAX) return;
    traced++;
    const detail = o.detail === undefined ? '' : ` (${clean(typeof o.detail === 'string' ? o.detail : JSON.stringify(o.detail)).slice(0, 200)})`;
    const more = traced === TRACE_LINES_MAX ? '; further ones are not logged' : '';
    process.stderr.write(`rdv: refused a grant: ${REFUSED_GRANT}${detail}${more}
`);
  }
}

/** Every event in the file (a torn last line is skipped until it is complete). */
export function readEvents(home: Home): LoggedEvent[] {
  if (!existsSync(home.eventsPath)) return [];
  return parseEvents(readFileSync(home.eventsPath, 'utf8'));
}

function parseEvents(text: string): LoggedEvent[] {
  return parseJsonLines<LoggedEvent>(text).filter((e) => typeof e?.n === 'number' && typeof e.obj?.event === 'string');
}

/** Size and mtime of the file, to skip re-reading it when nothing changed. */
export function eventsStamp(home: Home): string {
  try {
    const s = statSync(home.eventsPath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/**
 * Append events (noise dropped) under `events.lock`; returns what was written.
 * Never throws a LockTimeoutError: callers that retry on one (handleInbound)
 * must not re-handle an item just because the log was busy.
 */
export async function appendEvents(
  home: Home,
  objs: Array<{ event: string } & Record<string, unknown>>,
  extra: { negotiated?: boolean } = {},
): Promise<LoggedEvent[]> {
  traceRefusedGrants(objs);
  const kept = objs.filter((o) => !isNoise(o));
  if (kept.length === 0) return [];
  home.ensureDir();
  let release: () => void;
  try {
    release = await acquireLock(home.eventsLockPath, { timeoutMs: 60_000 });
  } catch (err) {
    throw new Error(`cannot append to ${home.eventsPath}: ${(err as Error).message}`);
  }
  try {
    const text = existsSync(home.eventsPath) ? readFileSync(home.eventsPath, 'utf8') : '';
    const all = parseEvents(text);
    let next = all.length ? all[all.length - 1].n + 1 : 1;
    const ts = new Date().toISOString();
    const out = kept.map((obj) => ({ n: next++, ts, ...(extra.negotiated ? { negotiated: true } : {}), obj }));
    if (all.length + out.length > 2 * EVENTS_FILE_KEPT) {
      const lines = [...all, ...out].slice(-EVENTS_FILE_KEPT);
      writeAtomic(home.eventsPath, lines.map((e) => JSON.stringify(e) + '\n').join(''), 0o600);
    } else {
      // A crash can leave a torn last line: start on a fresh one so ours stays readable.
      const sep = text && !text.endsWith('\n') ? '\n' : '';
      appendFileSync(home.eventsPath, sep + out.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
    }
    return out;
  } finally {
    release();
  }
}
