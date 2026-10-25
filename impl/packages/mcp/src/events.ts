// The server's event log: what `rdv_inbox` and the `rdv://inbox` resource
// return. Inbound items become model-facing events here, with every
// peer-written string wrapped by `untrusted()`. Kept in `mcp-events.jsonl`
// in the home so a restart doesn't reset the cursor.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeSlot, isA2APayload, type Slot, TASK_STATES } from '@rendezvous/a2a';
import { fingerprint } from '@rendezvous/core';
import { type Home, parseJsonLines, writeAtomic } from '@rendezvous/cli/lib';
import { address, agentId, isPlain, oneOf, safe, token, untrusted, uuid } from './untrusted.js';

const TIERS = ['spouse', 'family', 'friend', 'colleague', 'business', 'stranger'];
const BINDINGS = ['in-person', 'dns', 'mailbox', 'claimed'];
const KINDS = ['proposed', 'offer-received', 'countered', 'accepted', 'completed', 'rejected', 'canceled', 'expired', 'status', 'duplicate', 'ignored', 'invalid'];
const state = oneOf(TASK_STATES);
/** Drop reasons a stranger can trigger at will; not worth the model's attention. */
const STRANGER_DROPS = [
  'contact request',
  'no grant for sender',
  'out-of-order envelope from a non-contact',
  'unexpected or invalid grant',
  'topic doc',
  'request signer differs',
  'grant signer differs',
  'blocked sender',
];
/** Events kept in memory and in mcp-events.jsonl (the file is compacted at twice this). */
export const EVENTS_KEPT = 1000;
/** Fingerprint only for a well-formed agent ID. */
const fp = (id: unknown) => (isPlain(agentId(id)) ? fingerprint(id as string) : untrusted(id));

export interface McpEvent {
  /** Cursor: strictly increasing. */
  n: number;
  ts: string;
  type: string;
  [k: string]: unknown;
}

type Raw = { event: string } & Record<string, unknown>;

const who = (id: unknown): string => {
  const f = fp(id);
  return isPlain(f) ? f : 'the peer';
};
const slotText = (s: unknown) => safe(describeSlot(s as Slot));

/** Plain-language line for a negotiation step, written by us from validated fields only. */
function dinnerSummary(e: Raw): string {
  const peer = who(e.peer);
  const slots = Array.isArray(e.slots) ? e.slots.map(slotText).join('; ') : '';
  const slot = e.slot ? slotText(e.slot) : '';
  switch (e.kind) {
    case 'proposed':
      return `You proposed dinner to ${peer}: ${slots}.`;
    case 'offer-received':
      return `${peer} offered: ${slots}.`;
    case 'countered':
      return `None of ${peer}'s times work here; countered with: ${slots}.`;
    case 'accepted':
      return `Accepted ${slot} with ${peer}; it is held in your calendar.`;
    case 'completed':
      return `Agreed with ${peer}: dinner ${slot}. It is held in your calendar.`;
    case 'rejected':
      return `No agreement with ${peer}; the negotiation ended (rejected).`;
    case 'canceled':
      return `The dinner negotiation with ${peer} was canceled.`;
    case 'expired':
      return `The dinner negotiation with ${peer} expired.`;
    case 'status':
      return `${peer} reports the negotiation as ${isPlain(state(e.state)) ? e.state : 'updated'}.`;
    case 'ignored':
    case 'invalid':
      return `Ignored a negotiation message from ${peer}.`;
    default:
      return `Negotiation update with ${peer}.`;
  }
}

/** Turn one inbound item into a model-facing event, or null to hide it. */
export function toModelEvent(e: Raw, negotiating: boolean): Omit<McpEvent, 'n' | 'ts'> | null {
  switch (e.event) {
    case 'request':
      return {
        type: 'contact_request',
        request_id: uuid(e.id),
        from: agentId(e.from),
        fingerprint: fp(e.from),
        binding: oneOf(BINDINGS)(e.binding),
        to_hint: isPlain(agentId(e.to_hint)) ? e.to_hint : address(e.to_hint),
        greeting: untrusted(e.greeting),
        next_step: 'Tell your user who is asking (fingerprint, binding) and ask whether to approve. rdv_grant only succeeds with their confirmation.',
      };
    case 'candidate':
      // An answer to our discovery probe: anyone who saw the probe could have sent it.
      return {
        type: 'contact_candidate',
        grant_id: uuid(e.grant_id),
        from: agentId(e.from),
        fingerprint: fp(e.from),
        probe_for: address(e.to_hint),
        their_tier_for_you: oneOf(TIERS)(e.granted_tier),
        next_step:
          'Someone answered your discovery probe. Show your user the fingerprint and ask whether this is the person they meant; it becomes a contact only when they confirm (rdv_grant with grant_id).',
      };
    case 'pending-evicted': {
      const total = typeof e.total === 'number' && Number.isSafeInteger(e.total) ? e.total : null;
      // First drop, then every 50th, so a flood can't fill the log with these.
      if (total !== null && total !== 1 && total % 50 !== 0) return null;
      return {
        type: 'pending_flooded',
        dropped_requests: total,
        next_step:
          'Your pending contact requests were full, so the weakest were dropped; someone may be flooding this agent. Tell your user. A dropped requester can ask again.',
      };
    }
    case 'probe-overflow':
      return {
        type: 'probe_flooded',
        request_id: uuid(e.request_ref),
        probe_for: address(e.to_hint),
        dropped: typeof e.dropped === 'number' && Number.isSafeInteger(e.dropped) ? e.dropped : null,
        next_step:
          'Your discovery probe got more answers than are kept, so someone may be flooding it and the real person may be among the dropped ones. ' +
          'Tell your user; the safe route is to get their card through a channel they trust (in person, a QR code) and request contact by card.',
      };
    case 'contact':
      return { type: 'contact', peer: agentId(e.peer), fingerprint: fp(e.peer), tier: oneOf(TIERS)(e.tier), binding: oneOf(BINDINGS)(e.binding) };
    case 'message': {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      if (negotiating && isA2APayload(payload)) return null; // the engine's dinner events cover these
      const { type, ...rest } = payload;
      const seq = typeof e.seq === 'number' && Number.isSafeInteger(e.seq) ? e.seq : null;
      return { type: 'message', from: agentId(e.from), seq, payload_type: token(type), payload: untrusted(rest) };
    }
    case 'revoked':
      return { type: 'revoked', peer: agentId(e.peer) };
    case 'dropped':
      if (String(e.reason).includes('duplicate') || String(e.reason).includes('replay')) return null; // relays replay on every restart
      // Anyone can cause these by writing to us; they would only push real events out of the log (M1).
      if (STRANGER_DROPS.some((r) => String(e.reason).startsWith(r))) return null;
      // Core's reasons are fixed strings, but some carry decoder detail: quarantine them all.
      return { type: 'dropped', reason: untrusted(e.reason) };
    case 'error':
      // May quote peer or calendar-file content: the server logs it for the human (see RdvMcpServer.record).
      return { type: 'error', message: 'Something failed while handling an inbound item; the details are in the rdv-mcp server log (stderr).' };
    case 'dinner': {
      if (e.kind === 'duplicate') return null;
      const peerText = Array.isArray(e.peer_text) ? e.peer_text.map(untrusted) : undefined;
      return {
        type: 'dinner',
        kind: oneOf(KINDS)(e.kind),
        task_id: e.task === null || e.task === undefined ? null : uuid(e.task),
        peer: agentId(e.peer),
        state: e.state === undefined ? undefined : state(e.state),
        round: e.round,
        slots: e.slots,
        slot: e.slot,
        summary: dinnerSummary(e),
        reason: e.reason === undefined ? undefined : untrusted(e.reason),
        peer_text: peerText?.length ? peerText : undefined,
      };
    }
    default:
      return null;
  }
}

export class EventLog {
  private next: number;
  private waiters: Array<() => void> = [];
  /** The last EVENTS_KEPT events, oldest first; reads never re-parse the file. */
  private events: McpEvent[];
  /** Lines in the file, to know when to compact it. */
  private lines: number;

  constructor(private readonly home: Home) {
    const all = this.readFile();
    this.events = all.slice(-EVENTS_KEPT);
    this.lines = all.length;
    this.next = all.length ? all[all.length - 1].n + 1 : 1;
    if (this.lines > EVENTS_KEPT) this.compact();
  }

  get path(): string {
    return join(this.home.dir, 'mcp-events.jsonl');
  }

  /** The cursor the next event will get; `since` = this returns nothing yet. */
  get cursor(): number {
    return this.next - 1;
  }

  private readFile(): McpEvent[] {
    if (!existsSync(this.path)) return [];
    return parseJsonLines<McpEvent>(readFileSync(this.path, 'utf8'));
  }

  /** Rewrite the file with only the events we keep. */
  private compact(): void {
    writeAtomic(this.path, this.events.map((e) => JSON.stringify(e) + '\n').join(''), 0o600);
    this.lines = this.events.length;
  }

  append(items: Array<Omit<McpEvent, 'n' | 'ts'>>): McpEvent[] {
    if (items.length === 0) return [];
    this.home.ensureDir();
    const ts = new Date().toISOString();
    const out = items.map((it) => ({ n: this.next++, ts, ...it }) as McpEvent);
    appendFileSync(this.path, out.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
    this.events.push(...out);
    if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
    this.lines += out.length;
    if (this.lines > 2 * EVENTS_KEPT) this.compact();
    for (const w of this.waiters.splice(0)) w();
    return out;
  }

  since(cursor: number, limit: number): McpEvent[] {
    // Cursors are increasing, so binary-search the first event after `cursor`.
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].n > cursor) hi = mid;
      else lo = mid + 1;
    }
    return this.events.slice(lo, lo + limit);
  }

  tail(limit: number): McpEvent[] {
    return this.events.slice(-limit);
  }

  /** Resolves when something is appended, or after `ms`. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.push(done);
    });
  }
}
