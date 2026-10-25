// auto_approve: all per contact (SPEC §5.5.1, issue #25, design A.5.1).
//
// Our human may mark one trusted contact so that the start and release gates
// pass for its tasks without asking. It is the human's alone:
//
// - set only by `rdv contact auto-approve <contact> all` in an interactive
//   terminal, after a warning and the fingerprint retyped (commands.ts); no
//   MCP tool, confirm phrase or peer can set, extend or change it;
// - local state (autoapprove.json, mode 600), never on the wire; each entry is
//   MACed with the agent's secret key, so a file written by anything that
//   cannot read agent.json approves nothing;
// - bound to the grant it was set on: revoked, blocked, revoked for abuse,
//   re-granted or widened, or a forked or rolled-back channel, and it is off;
// - optional expiry; an unreadable, expired, future-dated or malformed entry
//   approves nothing (fail closed) and is removed;
// - every action it approves, and every set, extend and end, is a line in
//   audit.jsonl (no peer text).
//
// It covers only the task gates (tasks.ts). Contacts, groups, grants, invoke,
// limits and auto-approve itself stay with the human every time.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Agent, type AgentState, b64decode, type Contact, ContactBook, effectiveInvoke, fingerprint, type GrantScope, MEETING_CAPABILITIES, parseTimestamp } from '@rendezvous/core';
import { type AuditEntry, type AutoApproveEntry, type AutoApproveOff, CliError, type Home } from './home.js';
import { sha, stable } from './hash.js';

/** What the check reads of an agent: its key (the MAC), its contacts, and its channels. */
export interface AutoApproveSubject {
  secretKey: Uint8Array;
  contact(peer: string, now: Date): Contact | undefined;
  isBlocked(peer: string): boolean;
  /** The peer's channel is refused after a fork or rollback (SPEC §6.4). */
  refused(peer: string): boolean;
}

export const subjectOf = (agent: Agent): AutoApproveSubject => ({
  get secretKey() {
    return agent.key.secretKey;
  },
  contact: (peer, now) => agent.book.contact(peer, now) ?? undefined,
  isBlocked: (peer) => agent.book.isBlocked(peer),
  refused: (peer) => agent.refusedChannels().some((c) => c.peer === peer),
});

/** The same, from agent.json as read (a read-only view: rdv_status, rdv_task). */
export function subjectOfState(state: AgentState): AutoApproveSubject {
  const book = new ContactBook(state.book);
  return {
    secretKey: b64decode(state.secretKey),
    contact: (peer, now) => book.contact(peer, now) ?? undefined,
    isBlocked: (peer) => book.isBlocked(peer),
    refused: (peer) => !!(state.channels && Object.hasOwn(state.channels, peer) && state.channels[peer]?.refused),
  };
}

/** The contact's grant as it binds an entry: another grant (or a widened one) is another decision. */
export const scopeDigest = (scope: GrantScope | null | undefined): string => sha('rdv1/auto-approve-scope', scope ?? null);

function macOf(secretKey: Uint8Array, body: Omit<AutoApproveEntry, 'mac'>): string {
  return createHmac('sha256', secretKey).update(`rdv1/auto-approve\0${stable(body)}`).digest('hex');
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

export type AutoApproveCheck =
  | { ok: true; entry: AutoApproveEntry; capabilities: string[] }
  /** `clock`: our own clock is unreadable; nothing is approved and nothing removed. */
  | { ok: false; reason: AutoApproveOff | 'clock' };

/** Does `entry` (stored under `peer`) hold at `now`? Every doubt fails closed. */
export function checkAutoApprove(entry: AutoApproveEntry | undefined, subject: AutoApproveSubject, peer: string, now: Date): AutoApproveCheck {
  const t = now.getTime();
  if (!Number.isFinite(t)) return { ok: false, reason: 'clock' };
  if (!entry || typeof entry !== 'object' || entry.v !== 1 || entry.mode !== 'all' || entry.peer !== peer || typeof entry.mac !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  const { mac, ...body } = entry;
  if (!/^[0-9a-f]{64}$/.test(mac) || !sameMac(mac, macOf(subject.secretKey, body))) return { ok: false, reason: 'invalid' };
  const set = parseTimestamp(entry.set);
  // Set in the future: a clock that went back, or not ours. Either way it approves nothing.
  if (set === null || set > t) return { ok: false, reason: 'invalid' };
  if (entry.until !== null) {
    const until = parseTimestamp(entry.until);
    if (until === null || until <= set) return { ok: false, reason: 'invalid' };
    if (t >= until) return { ok: false, reason: 'expired' };
  }
  if (subject.isBlocked(peer)) return { ok: false, reason: 'blocked' };
  const c = subject.contact(peer, now);
  if (!c) return { ok: false, reason: 'revoked' };
  if (c.inboundGranted !== true || c.grantId !== entry.grantId || c.since !== entry.since || scopeDigest(c.inboundScope) !== entry.scope) {
    return { ok: false, reason: 'grant-changed' };
  }
  if (subject.refused(peer)) return { ok: false, reason: 'fork' };
  return { ok: true, entry, capabilities: covered(c.inboundScope) };
}

/** The task capabilities a grant lets the contact invoke: what auto-approve covers (meetings have their own confirm, §5.5). */
const covered = (scope: GrantScope | null | undefined): string[] => Object.keys(effectiveInvoke(scope)).filter((u) => !MEETING_CAPABILITIES.includes(u));

const offLine = (now: Date, peer: string, reason: AutoApproveOff): AuditEntry => ({
  ts: Number.isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString(),
  peer,
  gate: 'auto-approve',
  by: reason === 'owner' ? 'human' : 'auto-approve',
  action: 'off',
  reason,
});

/**
 * The contact's auto-approve, if it holds now. Call inside the home lock: an
 * entry that no longer holds is removed and its end audited. An unreadable
 * file approves nothing (sweepAutoApprove reports it).
 */
export function autoApproved(home: Home, subject: AutoApproveSubject, peer: string, now = new Date()): { entry: AutoApproveEntry; capabilities: string[] } | null {
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    return null;
  }
  if (!Object.hasOwn(all, peer)) return null;
  const r = checkAutoApprove(all[peer], subject, peer, now);
  if (r.ok) return r;
  if (r.reason !== 'clock') {
    delete all[peer];
    home.writeAutoApprove(all);
    home.appendAudit([offLine(now, peer, r.reason)]);
  }
  return null;
}

/**
 * Inside the home lock, after each inbound item: end every entry that no
 * longer holds (expired, contact revoked or blocked, revoked for abuse,
 * re-granted, a fork), so it is off, and audited, even before a gate asks.
 */
export function sweepAutoApprove(home: Home, subject: AutoApproveSubject, now = new Date()): { ended: Array<{ peer: string; reason: AutoApproveOff }>; error?: string } {
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch (err) {
    return { ended: [], error: `${(err as Error).message}: no contact is on auto-approve until it is fixed (rdv contact auto-approve <contact> off rewrites it)` };
  }
  const ended: Array<{ peer: string; reason: AutoApproveOff }> = [];
  for (const peer of Object.keys(all)) {
    const r = checkAutoApprove(all[peer], subject, peer, now);
    if (!r.ok && r.reason !== 'clock') {
      ended.push({ peer, reason: r.reason });
      delete all[peer];
    }
  }
  if (ended.length) {
    home.writeAutoApprove(all);
    home.appendAudit(ended.map((e) => offLine(now, e.peer, e.reason)));
  }
  return { ended };
}

/** Contacts on auto-approve now, for display only (writes nothing). */
export function autoApproveStatus(home: Home, subject: AutoApproveSubject, now = new Date()): Map<string, { until: string | null; set: string; capabilities: string[] }> {
  const out = new Map<string, { until: string | null; set: string; capabilities: string[] }>();
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    return out;
  }
  for (const peer of Object.keys(all)) {
    const r = checkAutoApprove(all[peer], subject, peer, now);
    if (r.ok) out.set(peer, { until: r.entry.until, set: r.entry.set, capabilities: r.capabilities });
  }
  return out;
}

/** How many actions auto-approve passed (audit.jsonl, as far back as it is kept), per peer. */
export function autoApprovedCounts(home: Home): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const a of home.readAudit()) if (a.by === 'auto-approve' && a.gate !== 'auto-approve') out.set(a.peer, (out.get(a.peer) ?? 0) + 1);
  } catch {
    // diagnostics only
  }
  return out;
}

// --- the owner's command (commands.ts) -------------------------------------------------

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
/** Longest auto-approve with an expiry (longer: leave out --until and turn it off by hand). */
export const AUTO_APPROVE_MAX_MS = 366 * 86_400_000;

/** `--until`: a duration (30m, 12h, 7d, 2w) or an RFC 3339 time with an offset; in the future, at most a year away. */
export function parseUntil(v: string, now = new Date()): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new CliError('your clock is unreadable');
  const m = /^\s*(\d{1,4})\s*([mhdw])\s*$/i.exec(v);
  const at = m ? t + Number(m[1]) * UNIT_MS[m[2].toLowerCase()] : parseTimestamp(v.trim());
  if (at === null || !Number.isFinite(at)) throw new CliError('--until takes a duration (30m, 12h, 7d, 2w) or an RFC 3339 time with an offset', 2);
  if (at <= t) throw new CliError('--until must be in the future', 2);
  if (at - t > AUTO_APPROVE_MAX_MS) throw new CliError('--until is more than a year away; leave it out to keep auto-approve until you turn it off', 2);
  return new Date(at).toISOString();
}

/** The fingerprint as the owner retypes it: its 8 characters, any case, with or without `rdv1:` and the ellipsis. */
export const fingerprintChars = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/^rdv1:/, '')
    .replace(/[^a-z0-9]/g, '');

/** A contact the owner may put on auto-approve, with what it would cover. Refused (CliError) otherwise. */
export function autoApproveTarget(subject: AutoApproveSubject, peer: string, now = new Date()): { contact: Contact; capabilities: string[] } {
  if (subject.isBlocked(peer)) throw new CliError(`${peer} is blocked`);
  const c = subject.contact(peer, now);
  if (!c) throw new CliError(`no active contact ${peer}`);
  if (c.inboundGranted !== true) throw new CliError(`you have not granted ${peer} anything yet (rdv contact grant <agent-id> --invoke <capability>): auto-approve would cover nothing`);
  const capabilities = covered(c.inboundScope);
  if (capabilities.length === 0) throw new CliError(`your grant to ${peer} allows no task capability (meetings keep their own confirm): auto-approve would cover nothing`);
  if (subject.refused(peer)) throw new CliError(`the channel with ${peer} is refused after a fork or rollback; settle that first`);
  return { contact: c, capabilities };
}

/** The warning shown before it is set (SPEC §5.5.1): what it allows, which capabilities, the injection risk, the expiry, how to turn it off. */
export function autoApproveWarning(c: Contact, capabilities: string[], until: string | null): string {
  const name = c.label ? `${c.label} (${c.peer})` : c.peer;
  return [
    '',
    'WARNING: auto-approve-all ("dangerous mode") for one contact',
    '',
    `  Contact:      ${name}`,
    `  Fingerprint:  ${fingerprint(c.peer)}`,
    `  Covers today: ${capabilities.join(', ')}`,
    `  Until:        ${until ?? 'you turn it off'}`,
    '',
    "  This contact's agent can then make your agent act on its tasks and send back",
    '  whatever they produce, with nobody asking you first. Text and files from this',
    "  contact reach your agent's model together with its tools: a prompt injection",
    "  from this contact (its own model tricked by a document, a stolen key) gets the",
    "  power of your agent's tools for every capability above. The grant and its",
    '  limits are then the only boundary.',
    '',
    '  It never covers new contacts, groups, grants (this one included) or this',
    '  setting itself. Every action it approves is written to audit.jsonl ("rdv audit").',
    `  Turn it off any time: rdv contact auto-approve ${c.peer} off`,
    '',
  ].join('\n');
}

/**
 * Put `peer` on auto-approve (the owner's decision, already warned and
 * confirmed). Inside the home lock. Bound to the contact's grant now; a
 * second call extends or changes the expiry (audited as `extend`).
 */
export function setAutoApprove(home: Home, subject: AutoApproveSubject, peer: string, until: string | null, now = new Date()): { action: 'set' | 'extend'; entry: AutoApproveEntry; capabilities: string[] } {
  const { contact, capabilities } = autoApproveTarget(subject, peer, now);
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    all = {}; // unreadable approves nobody; the owner's new decision replaces it
  }
  const action = Object.hasOwn(all, peer) && checkAutoApprove(all[peer], subject, peer, now).ok ? 'extend' : 'set';
  const body: Omit<AutoApproveEntry, 'mac'> = {
    v: 1,
    peer,
    mode: 'all',
    set: now.toISOString(),
    until,
    grantId: contact.grantId,
    since: contact.since,
    scope: scopeDigest(contact.inboundScope),
  };
  const entry: AutoApproveEntry = { ...body, mac: macOf(subject.secretKey, body) };
  all[peer] = entry;
  home.writeAutoApprove(all);
  home.appendAudit([{ ts: entry.set, peer, gate: 'auto-approve', by: 'human', action, until, capabilities }]);
  return { action, entry, capabilities };
}

/** Turn it off (reduce-only: no confirmation). Inside the home lock. False when it was not on. */
export function turnOffAutoApprove(home: Home, peer: string, now = new Date()): boolean {
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    // Unreadable: drop the whole file; it approves nobody either way.
    home.writeAutoApprove({});
    home.appendAudit([offLine(now, peer, 'owner')]);
    return true;
  }
  if (!Object.hasOwn(all, peer)) return false;
  delete all[peer];
  home.writeAutoApprove(all);
  home.appendAudit([offLine(now, peer, 'owner')]);
  return true;
}
