// auto_approve: all per contact (SPEC §5.5.1, issue #25, design A.5.1).
//
// Our human may mark one trusted contact so that the start and release gates
// pass for its tasks without asking. It is the human's alone:
//
// - set only with the owner passphrase (ownersecret.ts), after a warning:
//   `rdv contact auto-approve <contact> all` in an interactive terminal, or
//   rdv-mcp's `rdv_auto_approve` "on", whose approval form takes the
//   passphrase where only the server sees it (issue #44); or, for the one
//   capability being approved, by ticking "Don't ask again for this contact"
//   on that gate's approval form or the gateway's PIN-locked page
//   (allowAlways, issue #103): the human's own channel, never the model; no
//   confirm phrase, tool argument or peer can set, extend or change it;
//   turning it off needs nothing (both hosts);
// - local state (autoapprove.json, mode 600), never on the wire; each entry is
//   MACed with the agent's secret key, so a file written by anything that
//   cannot read agent.json approves nothing;
// - bound to the grant it was set on: revoked, blocked, revoked for abuse, or
//   a forked or rolled-back channel, and it is off. A re-grant, or a widened
//   or narrowed grant, that our own human makes to the same contact keeps it
//   (issue #93, NOTES 92): our code rebinds the entry at that moment, under
//   the lock, to what it covered before that the new grant still allows;
//   capabilities the grant adds are not covered until the owner turns it on
//   for them. Any other change to the grant (one our code did not rebind:
//   approving a new request, which re-founds the contact, a grant received
//   from the peer, or the allowlist's) ends it;
// - bound to the owner passphrase record it was set under: a change, a reset
//   or a deleted passphrase file ends it for good (issue #47 follow-up);
// - optional expiry; an unreadable, expired, future-dated or malformed entry
//   approves nothing (fail closed) and is removed;
// - every action it approves, and every set, extend and end, is a line in
//   audit.jsonl (no peer text), set and off with where the owner did it
//   (`via`: cli or mcp).
//
// It covers the task gates (tasks.ts) and, since issue #44, the meeting
// confirm of a negotiation the contact started (listen.ts, the engine's
// `autoConfirmPeerStarted`); one our human started still waits for them.
// Contacts, groups, grants, invoke, limits, cancelling an agreed meeting and
// auto-approve itself stay with the human every time.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Agent, type AgentState, b64decode, type Contact, ContactBook, effectiveInvoke, fingerprint, type GrantScope, GROUPS_EXTENSION, MEETING_CANCEL_CAPABILITY, MEETINGS_CAPABILITY, parseTimestamp } from '@rendezvous/core';
import { type AuditEntry, type AutoApproveEntry, type AutoApproveOff, CliError, type Home } from './home.js';
import { sha, stable } from './hash.js';
import { clean } from './output.js';
import { ownerSecretBinding, ownerSecretEverSet } from './ownersecret.js';

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
  /** `capabilities`: covered now; `uncovered`: the grant allows them, auto-approve does not (they ask the human). */
  | { ok: true; entry: AutoApproveEntry; capabilities: string[]; uncovered: string[] }
  /** `clock` / `owner-unreadable`: our clock, or owner-secret.json, is unreadable; nothing is approved and nothing removed. */
  | { ok: false; reason: AutoApproveOff | 'clock' | 'owner-unreadable' };

/** Is it a reason to remove the entry (and audit that), or only to approve nothing now? */
const ends = (reason: AutoApproveOff | 'clock' | 'owner-unreadable'): reason is AutoApproveOff => reason !== 'clock' && reason !== 'owner-unreadable';

/**
 * The binding of a home where no owner passphrase was EVER set (issue #103):
 * an entry set from an approval form ("Don't ask again") there stores it, and
 * holds only while that stays true. Never a binding digest (those are hex),
 * so no other entry can match it. Once a passphrase existed, a reset or a
 * deleted file binds to nothing (null), so such an entry can never revive.
 */
export const UNBOUND_OWNER = 'none';

/**
 * The owner passphrase record auto-approve is bound to now (ownerSecretBinding):
 * UNBOUND_OWNER when none was ever set; null when one existed and is gone (reset,
 * or the file deleted: nothing holds and the form's box sets nothing until the
 * owner sets a new one); undefined when the file is unreadable.
 */
export function ownerBinding(home: Home): string | null | undefined {
  try {
    const b = ownerSecretBinding(home);
    if (b !== null) return b;
    return ownerSecretEverSet(home) ? null : UNBOUND_OWNER;
  } catch {
    return undefined;
  }
}

/** A binding made by an owner passphrase (not UNBOUND_OWNER, not none): what the terminal and rdv_auto_approve "on" need. */
export const passphraseBound = (owner: string | null | undefined): owner is string => typeof owner === 'string' && owner !== UNBOUND_OWNER;

/**
 * Does `entry` (stored under `peer`) hold at `now`, with `owner` the current
 * passphrase binding (ownerBinding)? Every doubt fails closed.
 */
export function checkAutoApprove(entry: AutoApproveEntry | undefined, subject: AutoApproveSubject, peer: string, now: Date, owner: string | null | undefined): AutoApproveCheck {
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
  // Issue #47 follow-up: set under another passphrase record, or none is set now. It never comes back on its own.
  if (owner === undefined) return { ok: false, reason: 'owner-unreadable' };
  // A form-set entry with no passphrase ever set holds only while that stays true (issue #103): a set, reset or
  // deleted file ends it for good (owner is then another binding, or null).
  if (owner === null || typeof entry.owner !== 'string' || entry.owner !== owner) return { ok: false, reason: 'owner-secret' };
  if (subject.isBlocked(peer)) return { ok: false, reason: 'blocked' };
  const c = subject.contact(peer, now);
  if (!c) return { ok: false, reason: 'revoked' };
  if (c.inboundGranted !== true || c.grantId !== entry.grantId || c.since !== entry.since || scopeDigest(c.inboundScope) !== entry.scope) {
    return { ok: false, reason: 'grant-changed' };
  }
  if (subject.refused(peer)) return { ok: false, reason: 'fork' };
  if (entry.covers !== undefined && !(Array.isArray(entry.covers) && entry.covers.every((u) => typeof u === 'string'))) return { ok: false, reason: 'invalid' };
  const capabilities = coveredBy(entry, c.inboundScope);
  return { ok: true, entry, capabilities, uncovered: covered(c.inboundScope).filter((u) => !capabilities.includes(u)) };
}

/**
 * What an entry covers now: what the owner was shown when setting it
 * (`covers`, MACed), intersected with what the grant allows now, so never
 * more than either. An entry from before issue #44 has no `covers`: task
 * capabilities only, never the meeting confirm it was not set for.
 */
function coveredBy(entry: AutoApproveEntry, scope: GrantScope | null | undefined): string[] {
  const now = covered(scope);
  if (entry.covers === undefined) return now.filter((u) => u !== MEETINGS_CAPABILITY);
  return now.filter((u) => entry.covers!.includes(u));
}

/** Auto-approve for one task capability of `peer` (a task gate): only if the entry covers that capability now. */
export function autoApprovedFor(home: Home, subject: AutoApproveSubject, peer: string, capability: string, now = new Date()): boolean {
  const r = autoApproved(home, subject, peer, now);
  return r !== null && r.capabilities.includes(capability);
}

/**
 * What auto-approve covers: the task capabilities a grant lets the contact
 * invoke, and the meetings URI when it may propose meetings (the confirm of a
 * negotiation it starts, issue #44). Never meeting-cancel: calling off an
 * agreed meeting stays the human's. Never the groups extension either:
 * joining a group and approving a newcomer are the human's every time
 * (§5.5.1), and the URI is no capability a grant could carry (a hand-edited
 * scope that lists it gets nothing for it here).
 */
const covered = (scope: GrantScope | null | undefined): string[] =>
  Object.keys(effectiveInvoke(scope)).filter((u) => u !== MEETING_CANCEL_CAPABILITY && u !== GROUPS_EXTENSION);

/**
 * May auto-approve confirm a meeting in a negotiation `peer` started, now?
 * The same check as a task gate (inside the home lock; an entry that no
 * longer holds is removed and audited), and the grant must still allow the
 * contact to propose meetings.
 */
export function meetingAutoApproved(home: Home, subject: AutoApproveSubject, peer: string, now = new Date()): boolean {
  const r = autoApproved(home, subject, peer, now);
  return r !== null && r.capabilities.includes(MEETINGS_CAPABILITY);
}

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
 * file approves nothing (sweepAutoApprove reports it). It holds only under the
 * owner passphrase record it was set under (issue #47): with none set, or
 * another one, the entry is removed, and setting a passphrase never brings it
 * back; the owner turns it on again.
 */
export function autoApproved(home: Home, subject: AutoApproveSubject, peer: string, now = new Date()): { entry: AutoApproveEntry; capabilities: string[]; uncovered: string[] } | null {
  const owner = ownerBinding(home);
  if (owner === undefined) return null;
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    return null;
  }
  if (!Object.hasOwn(all, peer)) return null;
  const r = checkAutoApprove(all[peer], subject, peer, now, owner);
  if (r.ok) return r;
  if (ends(r.reason)) {
    delete all[peer];
    home.writeAutoApprove(all);
    home.appendAudit([offLine(now, peer, r.reason)]);
  }
  return null;
}

/**
 * Inside the home lock, after each inbound item: end every entry that no
 * longer holds (expired, contact revoked or blocked, revoked for abuse, a
 * grant change our code did not rebind, a fork), so it is off, and audited,
 * even before a gate asks.
 */
export function sweepAutoApprove(home: Home, subject: AutoApproveSubject, now = new Date()): { ended: Array<{ peer: string; reason: AutoApproveOff }>; error?: string } {
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch (err) {
    return { ended: [], error: `${(err as Error).message}: no contact is on auto-approve until it is fixed (rdv contact auto-approve <contact> off rewrites it)` };
  }
  const ended: Array<{ peer: string; reason: AutoApproveOff }> = [];
  const owner = ownerBinding(home);
  for (const peer of Object.keys(all)) {
    const r = checkAutoApprove(all[peer], subject, peer, now, owner);
    if (!r.ok && ends(r.reason)) {
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

/** One contact's auto-approve as shown: what it covers now, and what the grant allows that it does not cover. */
export interface AutoApproveShown {
  until: string | null;
  set: string;
  capabilities: string[];
  uncovered: string[];
}

/** Contacts on auto-approve now, for display only (writes nothing). */
export function autoApproveStatus(home: Home, subject: AutoApproveSubject, now = new Date()): Map<string, AutoApproveShown> {
  const out = new Map<string, AutoApproveShown>();
  const owner = ownerBinding(home);
  if (owner === undefined) return out;
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    return out;
  }
  for (const peer of Object.keys(all)) {
    const r = checkAutoApprove(all[peer], subject, peer, now, owner);
    if (r.ok) out.set(peer, { until: r.entry.until, set: r.entry.set, capabilities: r.capabilities, uncovered: r.uncovered });
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

// --- a grant our human changes (issue #93, NOTES 92) -----------------------------------

/** What a grant change our human approved did to the contact's auto-approve. */
export interface AutoApproveKept {
  /** Still covered, without asking. */
  capabilities: string[];
  /** The grant allows these and auto-approve does not cover them: they ask the human, as before. */
  uncovered: string[];
  /** Covered before; the new grant no longer allows them. */
  dropped: string[];
  /** Nothing it covered is left: it is off (the sweep after the grant removes and audits it, reason grant-changed). */
  ended: boolean;
}

/**
 * Our human's own grant to an existing contact `peer` (allowInbound: a
 * re-grant, or a widened or narrowed one), already approved through the grant
 * gate, applied by `grant` inside the home lock. If the contact was on auto-approve just before, it stays on for what
 * it covered then that the new grant still allows; what the grant adds is not
 * covered. This is the only path that rebinds an entry, and only to the grant
 * our own code just made: any other change to the grant still ends it.
 */
export async function grantKeepingAutoApprove<T>(
  home: Home,
  subject: AutoApproveSubject,
  peer: string,
  grant: () => Promise<T>,
  via: 'cli' | 'mcp' = 'cli',
): Promise<{ result: T; autoApprove: AutoApproveKept | null }> {
  // Checked in full (MAC, expiry, passphrase, the grant it is bound to, fork) before the grant; one that fails is off.
  const before = autoApproved(home, subject, peer);
  const result = await grant();
  return { result, autoApprove: before ? keepAutoApprove(home, subject, peer, before, via) : null };
}

function keepAutoApprove(home: Home, subject: AutoApproveSubject, peer: string, before: { entry: AutoApproveEntry; capabilities: string[] }, via: 'cli' | 'mcp'): AutoApproveKept | null {
  const now = new Date();
  if (!Number.isFinite(now.getTime()) || subject.isBlocked(peer) || subject.refused(peer)) return null;
  const c = subject.contact(peer, now);
  if (!c || c.inboundGranted !== true) return null; // the sweep ends it, with its reason
  const allowed = covered(c.inboundScope);
  const capabilities = before.capabilities.filter((u) => allowed.includes(u));
  const kept: AutoApproveKept = {
    capabilities,
    uncovered: allowed.filter((u) => !capabilities.includes(u)),
    dropped: before.capabilities.filter((u) => !allowed.includes(u)),
    ended: capabilities.length === 0,
  };
  const e = before.entry;
  const scope = scopeDigest(c.inboundScope);
  // The same grant: nothing to rebind, and the entry (which held a moment ago) is left as it is.
  if (c.grantId === e.grantId && c.since === e.since && scope === e.scope) return { ...kept, ended: false };
  if (kept.ended) return kept;
  // Still the entry checked before the grant, under the passphrase record it was set under.
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    return null;
  }
  const owner = ownerBinding(home);
  if (!owner || !Object.hasOwn(all, peer) || all[peer]?.mac !== e.mac || owner !== e.owner) return null;
  const body: Omit<AutoApproveEntry, 'mac'> = {
    v: 1,
    peer,
    mode: 'all',
    set: e.set,
    until: e.until,
    grantId: c.grantId,
    since: c.since,
    scope,
    owner: e.owner,
    covers: capabilities,
  };
  all[peer] = { ...body, mac: macOf(subject.secretKey, body) };
  home.writeAutoApprove(all);
  home.appendAudit([
    {
      ts: now.toISOString(),
      peer,
      gate: 'auto-approve',
      by: 'human',
      action: 'keep',
      until: e.until,
      capabilities,
      ...(kept.uncovered.length ? { uncovered: kept.uncovered } : {}),
      ...(kept.dropped.length ? { dropped: kept.dropped } : {}),
      via,
    },
  ]);
  return kept;
}

/** The one line a grant change shows the human about auto-approve: informational, never a prompt to turn it on. */
export function autoApproveKeptText(peer: string, k: AutoApproveKept): string {
  const list = (xs: string[]) => xs.map((u) => clean(u)).join(', ');
  if (k.ended) return `auto-approve for ${clean(peer)} is off: the new grant allows nothing it covered`;
  return `auto-approve for ${clean(peer)} still covers ${list(k.capabilities)}` + (k.uncovered.length ? `; not covered (asks you as before): ${list(k.uncovered)}` : '');
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

/** A contact the owner may put on auto-approve, with what it would cover. Refused (CliError) otherwise. */
export function autoApproveTarget(subject: AutoApproveSubject, peer: string, now = new Date()): { contact: Contact; capabilities: string[] } {
  if (subject.isBlocked(peer)) throw new CliError(`${peer} is blocked`);
  const c = subject.contact(peer, now);
  if (!c) throw new CliError(`no active contact ${peer}`);
  if (c.inboundGranted !== true) throw new CliError(`you have not granted ${peer} anything yet (rdv contact grant <agent-id> --invoke <capability>): auto-approve would cover nothing`);
  const capabilities = covered(c.inboundScope);
  if (capabilities.length === 0) throw new CliError(`your grant to ${peer} allows no task capability and no meetings: auto-approve would cover nothing`);
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
    '  Mode:         all (every capability below)',
    `  Covers today: ${capabilities.join(', ')}`,
    `  Until:        ${until ?? 'you turn it off'}`,
    '',
    "  This contact's agent can then make your agent act on its tasks and send back",
    '  whatever they produce, with nobody asking you first. Text and files from this',
    "  contact reach your agent's model together with its tools: a prompt injection",
    "  from this contact (its own model tricked by a document, a stolen key) gets the",
    "  power of your agent's tools for every capability above. The grant and its",
    '  limits are then the only boundary.',
    ...(capabilities.includes(MEETINGS_CAPABILITY)
      ? ['', '  Meetings: a dinner this contact proposes is accepted and confirmed for you', '  without asking (one you propose still asks you).']
      : []),
    '',
    '  It never covers new contacts, groups, grants (this one included), calling off',
    '  an agreed meeting, or this setting itself. Every action it approves is written',
    '  to audit.jsonl ("rdv audit").',
    `  Turn it off any time: rdv contact auto-approve ${c.peer} off`,
    '',
  ].join('\n');
}

/**
 * Put `peer` on auto-approve (the owner's decision, already warned and
 * confirmed). Inside the home lock. Bound to the contact's grant now; a
 * second call extends or changes the expiry (audited as `extend`).
 */
export function setAutoApprove(
  home: Home,
  subject: AutoApproveSubject,
  peer: string,
  until: string | null,
  now = new Date(),
  via: 'cli' | 'mcp' = 'cli',
): { action: 'set' | 'extend'; entry: AutoApproveEntry; capabilities: string[] } {
  const { contact, capabilities } = autoApproveTarget(subject, peer, now);
  const owner = ownerBinding(home);
  if (!passphraseBound(owner)) throw new CliError('set your owner passphrase first, in your own terminal: rdv owner-secret set (turning auto-approve on asks for it, so an assistant cannot)');
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    all = {}; // unreadable approves nobody; the owner's new decision replaces it
  }
  const action = Object.hasOwn(all, peer) && checkAutoApprove(all[peer], subject, peer, now, owner).ok ? 'extend' : 'set';
  const body: Omit<AutoApproveEntry, 'mac'> = {
    v: 1,
    peer,
    mode: 'all',
    set: now.toISOString(),
    until,
    grantId: contact.grantId,
    since: contact.since,
    scope: scopeDigest(contact.inboundScope),
    owner,
    covers: capabilities,
  };
  const entry: AutoApproveEntry = { ...body, mac: macOf(subject.secretKey, body) };
  all[peer] = entry;
  home.writeAutoApprove(all);
  home.appendAudit([{ ts: entry.set, peer, gate: 'auto-approve', by: 'human', action, until, capabilities, via }]);
  return { action, entry, capabilities };
}

/**
 * What the owner is shown and approves when turning it on (the MCP form):
 * the contact, its grant as bound, what it covers and the expiry, under the
 * current passphrase record. Consent is bound to this digest: anything that
 * changes between the form and the write refuses it.
 */
export function autoApproveDigest(c: Contact, capabilities: string[], until: string | null, owner: string): string {
  return sha('rdv1/auto-approve-consent', { peer: c.peer, label: c.label ?? null, grantId: c.grantId, since: c.since, scope: scopeDigest(c.inboundScope), mode: 'all', capabilities, until, owner });
}

/** Turn it off (reduce-only: no confirmation). Inside the home lock. False when it was not on. */
export function turnOffAutoApprove(home: Home, peer: string, now = new Date(), via: 'cli' | 'mcp' = 'cli'): boolean {
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    // Unreadable: drop the whole file; it approves nobody either way.
    home.writeAutoApprove({});
    home.appendAudit([{ ...offLine(now, peer, 'owner'), via }]);
    return true;
  }
  if (!Object.hasOwn(all, peer)) return false;
  delete all[peer];
  home.writeAutoApprove(all);
  home.appendAudit([{ ...offLine(now, peer, 'owner'), via }]);
  return true;
}

/** Turn it off for every contact (reduce-only). Inside the home lock. The contacts it was on for; an unreadable file is dropped. */
export function turnOffAllAutoApprove(home: Home, now = new Date(), via: 'cli' | 'mcp' = 'cli'): string[] {
  let peers: string[];
  try {
    peers = Object.keys(home.readAutoApprove());
  } catch {
    home.writeAutoApprove({});
    home.appendAudit([{ ...offLine(now, '*', 'owner'), via }]);
    return [];
  }
  if (peers.length === 0) return [];
  home.writeAutoApprove({});
  home.appendAudit(peers.map((p) => ({ ...offLine(now, p, 'owner'), via })));
  return peers;
}

// --- "Don't ask again" on an approval form (issue #103, NOTES 96) ------------------------

/**
 * Whether an approval form for `capability` from `peer` may offer "Don't ask
 * again for this contact": the contact is ours, granted by our human, not
 * blocked or refused, the grant allows the capability, and auto-approve does
 * not cover it yet. Display only: reads, writes nothing. An unreadable owner
 * passphrase file approves nothing, so it offers nothing either.
 */
export function alwaysAllowOffer(
  home: Home,
  subject: AutoApproveSubject,
  peer: string,
  capability: string,
  now = new Date(),
): { contact: Contact; until: string | null; was: AlwaysAllowSeen } | null {
  let target: { contact: Contact; capabilities: string[] };
  try {
    target = autoApproveTarget(subject, peer, now);
  } catch {
    return null;
  }
  if (!target.capabilities.includes(capability)) return null;
  if (!ownerBinding(home)) return null; // unreadable, or a passphrase existed and is gone: nothing is offered
  const on = autoApproveStatus(home, subject, now).get(peer);
  if (on?.capabilities.includes(capability)) return null;
  // Already on for other capabilities with an expiry: this one joins it until then (allowAlways keeps the expiry).
  return { contact: target.contact, until: on?.until ?? null, was: on ? { set: on.set, until: on.until } : null };
}

/** The contact's auto-approve as the form saw it (null: off), so allowAlways writes only onto that same state. */
export type AlwaysAllowSeen = { set: string; until: string | null } | null;

/**
 * Our human ticked "Don't ask again for this contact" and approved, on an
 * approval form (the MCP client's own UI) or the gateway's PIN-locked page:
 * auto-approve for `peer` now also covers `capability`. Inside the home lock,
 * after the gate's own step went through. The answer came from the human's
 * channel, never from the model, which is the trust the owner passphrase buys
 * on the other paths, so none is asked here. Bound to the grant now and to
 * the passphrase record now (none: UNBOUND_OWNER, which ends the moment one
 * is set). An entry that holds keeps its expiry and gains the capability; one
 * that does not is replaced, until turned off. MACed and audited (`via:
 * "form"`) like every other set.
 */
export function allowAlways(
  home: Home,
  subject: AutoApproveSubject,
  peer: string,
  capability: string,
  now = new Date(),
  seen?: AlwaysAllowSeen,
): { action: 'set' | 'extend'; entry: AutoApproveEntry; capabilities: string[] } {
  const { contact, capabilities: allowed } = autoApproveTarget(subject, peer, now);
  if (!allowed.includes(capability)) throw new CliError(`your grant to ${peer} no longer allows ${capability}: auto-approve was not turned on`);
  const owner = ownerBinding(home);
  if (owner === undefined) throw new CliError('the owner passphrase file is unreadable: auto-approve was not turned on');
  if (owner === null) {
    throw new CliError('your owner passphrase was reset or its file deleted: auto-approve was not turned on. Set a new one in your own terminal (rdv owner-secret set) first');
  }
  // The full check first: an entry that no longer holds is removed and audited here.
  const before = autoApproved(home, subject, peer, now);
  // Only onto the state the form described (security review): an entry that expired, was turned off or changed
  // since must not become one "until turned off" behind the owner's back.
  if (seen !== undefined) {
    const same = seen === null ? before === null : before !== null && before.entry.set === seen.set && before.entry.until === seen.until;
    if (!same) throw new CliError(`auto-approve for ${peer} changed while the form was open (it ended, was turned off or changed): it was not turned on`);
  }
  const covers = before ? [...before.capabilities.filter((u) => u !== capability), capability] : [capability];
  let all: Record<string, AutoApproveEntry>;
  try {
    all = home.readAutoApprove();
  } catch {
    all = {}; // unreadable approves nobody; the owner's new decision replaces it
  }
  const until = before ? before.entry.until : null;
  const body: Omit<AutoApproveEntry, 'mac'> = {
    v: 1,
    peer,
    mode: 'all',
    set: now.toISOString(),
    until,
    grantId: contact.grantId,
    since: contact.since,
    scope: scopeDigest(contact.inboundScope),
    owner,
    covers,
  };
  const entry: AutoApproveEntry = { ...body, mac: macOf(subject.secretKey, body) };
  all[peer] = entry;
  home.writeAutoApprove(all);
  const action = before ? 'extend' : 'set';
  home.appendAudit([{ ts: entry.set, peer, gate: 'auto-approve', by: 'human', action, until, capabilities: covers, via: 'form' }]);
  return { action, entry, capabilities: covers };
}
