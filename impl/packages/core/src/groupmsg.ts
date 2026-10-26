// §7.8.3, §7.8.5–§7.8.7: what members say to a group (design Part B, slice 2).
// A group message is signed once by its sender and sealed to each recipient
// over the pairwise channels (§6.4). Board-visible messages (`to: "*"`) carry
// a per-sender group chain (`gseq`/`gprev`) and the sender's `heads`, so a
// member that leaves someone out, or tells John one thing and Dana another,
// is caught: a gap asks for a group resend, and two messages signed by one
// sender at one `gseq` are proof of equivocation.
//
// The signature covers a header that commits to the body by hash
// (`body_hash`), not the body itself, so evidence (the headers alone) can be
// shown to another member without disclosing what the sender said to us.
//
// Everything here is checked before it changes anything: a message, a proof,
// a leave or a report from someone who is not a member, or whose signature
// does not verify, triggers nothing (no freeze, no mute, no queue). Only two
// headers signed by the same member make it refused, and only our human
// re-syncs it (`resyncMember`).
import { isDocId, parseFrequency } from './contact.js';
import { canonicalBytes, parseTimestamp } from './encoding.js';
import { docHash, GROUP_LIMITS, type GroupBook, type GroupChange, type GroupContext, type GroupRecord, isAdmin, memberIds, memberOf } from './group.js';
import { type AgentKey, isAgentId } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';

export const GROUP_MSG_TYPE = 'rdv/group-msg';
export const GROUP_LEAVE_TYPE = 'rdv/group-leave';
export const GROUP_PROOF_TYPE = 'rdv/group-proof';
export const GROUP_REPORT_TYPE = 'rdv/group-report';
export const GROUP_MSG_TYPES: readonly string[] = Object.freeze([GROUP_MSG_TYPE, GROUP_LEAVE_TYPE, GROUP_PROOF_TYPE, GROUP_REPORT_TYPE]);

/** Bounds (SPEC §7.8.3, §7.8.6, §7.8.7; reference values). */
export const GROUP_MSG_LIMITS = Object.freeze({
  /** Canonical JSON of a signed header (heads and a private `to` list included). */
  headBytes: 4096,
  /** Canonical JSON of a body: header and body together stay under the 32 KiB envelope cap (§6.4). */
  bodyBytes: 24_576,
  bodyTypeChars: 100,
  /** Accepted board hashes kept per member: duplicates, and the heads comparison. */
  chainHashes: 64,
  /** Accepted board headers kept in full per member: the evidence we can forward. */
  chainHeaders: 8,
  /** Out-of-order board messages buffered per member while a gap is asked for. */
  buffer: 16,
  /** Our own board messages kept per group for a group resend. */
  outbox: 32,
  /** Most gseqs one group resend asks for, or answers. */
  resendSpan: 32,
  /** Messages for a newer epoch kept per group until its state arrives, and per sender. */
  waiting: 16,
  waitingPerSender: 4,
  /** How long a gap stays open before our human is told and the chain moves on. */
  gapWaitMs: 10 * 60_000,
  /** Private message hashes remembered per member (duplicates). */
  privateSeen: 32,
  /** Evidence forwards remembered per group. */
  forwarded: 64,
  /** The receiver's own ceiling on any member's group messages, whatever member_rate says. */
  memberCeiling: '600/hour',
  /** Members other than the sender in a private `to` list. */
  privateTo: GROUP_LIMITS.members - 1,
});

/** `"*"`: board-visible, to every member the sender approved, consuming its gseq. A list: private, to those members only. */
export type GroupTo = '*' | string[];

/** The signed header of a group message (§7.8.3). */
export interface GroupMsgHeader {
  v: 1;
  type: typeof GROUP_MSG_TYPE;
  group: string;
  from: string;
  /** The sender's state: its epoch and hash (§4.6). */
  epoch: number;
  state: string;
  /** Board-visible only: the sender's group chain, from 1; `gprev` the hash of its previous board header (null at 1). */
  gseq?: number;
  gprev?: string | null;
  to: GroupTo;
  /** Per other member: the newest gseq the sender accepted from it and the first 16 hex digits of that header's hash. */
  heads?: Record<string, [number, string]>;
  /** Hash (§4.6) of the body: the signature covers it, so evidence travels without the body. */
  body_hash: string;
  ts: string;
}
export type GroupMsg = Signed<GroupMsgHeader>;

/** What a member says: a free note or an A2A payload (§7.1, §7.6), any JSON object with a `type`. */
export interface GroupBody {
  type: string;
  [k: string]: unknown;
}

/** The pairwise payload: the signed header and the body it commits to. */
export interface GroupMsgPayload {
  type: typeof GROUP_MSG_TYPE;
  msg: GroupMsg;
  body: GroupBody;
}

/** `rdv/group-leave` (§7.8.5): signed by the member that leaves, bound to the state it left. */
export interface GroupLeaveBody {
  v: 1;
  type: typeof GROUP_LEAVE_TYPE;
  group: string;
  from: string;
  epoch: number;
  state: string;
  ts: string;
}
export type GroupLeave = Signed<GroupLeaveBody>;

/** Evidence (§7.8.6 layer 3): one or two headers signed by the same member. Unsigned: each header is. */
export interface GroupProofPayload {
  type: typeof GROUP_PROOF_TYPE;
  group: string;
  msgs: GroupMsg[];
}

/** To an admin (§7.8.7): a member went over the rate, so we muted it. Rides the pairwise channel, which authenticates it. */
export interface GroupReportPayload {
  type: typeof GROUP_REPORT_TYPE;
  group: string;
  member: string;
  count: number;
  limit: string;
}

/** Per other member: its board chain as we accepted it, and why we refuse or mute it. */
export interface MemberChain {
  /** Newest gseq accepted in order (0: none yet; the chain starts at the first we see). */
  gseq: number;
  /** Hash of the header at `gseq`; null when unknown (a gap skipped). */
  head: string | null;
  /** Accepted board header hashes, `[gseq, hash]`, oldest first. */
  recent: Array<[number, string]>;
  /** The last few accepted board headers in full, oldest first. */
  headers: GroupMsg[];
  /** Newest `ts` (ms) accepted from it on the board. */
  newest?: number;
  /** After a re-sync: board messages not newer than this are replays of the old chain. */
  floor?: number;
  /** Our human re-synced it: the next board message newer than `newest` starts its chain again. */
  resync?: true;
  /** When our human last re-synced it (ms): evidence written before then is about the history they accepted. */
  resynced?: number;
  /** Board messages after a gap, waiting for it to fill. */
  buffer: Array<{ msg: GroupMsg; body: GroupBody }>;
  /** The gap we asked a group resend for. */
  gap?: { from: number; to: number; asked: string };
  /** Two headers it signed conflict (§7.8.6): its group messages are refused until our human re-syncs it. */
  refused?: { gseq: number; hashes: string[]; since: string; via?: string };
  /** Over member_rate or our ceiling (§7.8.7): its group messages are refused until our human re-syncs it. */
  muted?: { since: string; count: number; limit: string };
  /** Fixed windows, one per limit (member_rate, our ceiling). */
  rate?: Array<{ start: number; count: number }>;
  /** Hashes of private messages accepted from it (duplicates). */
  priv?: string[];
}

/** Our own board chain in a group, and our recent board messages (for a group resend). */
export interface OutChain {
  gseq: number;
  head: string | null;
  sent: Array<{ msg: GroupMsg; body: GroupBody }>;
}

/** A group message handed to the host: the body is the sender's words (peer text, §5.6). */
export interface GroupDelivery {
  group: string;
  from: string;
  msg: GroupMsg;
  body: GroupBody;
  /** Board-visible (`to: "*"`); otherwise private to the listed members. */
  board: boolean;
}

/** A member signed two conflicting board headers: refused until our human re-syncs it. */
export interface GroupEquivocation {
  group: string;
  member: string;
  gseq: number;
  /** The conflicting headers' hashes. */
  hashes: string[];
  /** The signed headers we hold (ours first when we had one). */
  headers: GroupMsg[];
  /** The member whose evidence showed it, when it was not our own copy. */
  via?: string;
}

export interface GroupGap {
  group: string;
  member: string;
  from: number;
  to: number;
}

export interface GroupMute {
  group: string;
  member: string;
  count: number;
  limit: string;
}

export interface GroupReport {
  group: string;
  /** The member that reported. */
  from: string;
  member: string;
  count: number;
  limit: string;
}

type OutPayload = { type: string } & Record<string, unknown>;

/** What handling one group item did; the agent performs the sends and emits the rest. */
export interface GroupEffects {
  delivered: GroupDelivery[];
  equivocations: GroupEquivocation[];
  gaps: GroupGap[];
  mutes: GroupMute[];
  /** Payloads to send: resend requests, evidence, reports. */
  send: Array<{ to: string; payload: OutPayload }>;
  /** Why the item itself was not taken (other effects may still be present). */
  drop?: string;
  /** Held for a newer epoch until its state arrives. */
  waiting?: boolean;
}

const effects = (): GroupEffects => ({ delivered: [], equivocations: [], gaps: [], mutes: [], send: [] });
const dropped = (reason: string, fx = effects()): GroupEffects => ({ ...fx, drop: reason });

// --- shapes --------------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const tsOk = (ts: unknown, now: Date): boolean => {
  const t = parseTimestamp(ts);
  return t !== null && t <= now.getTime() + GROUP_LIMITS.skewMs;
};
const size = (doc: unknown): number => {
  try {
    return canonicalBytes(doc).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export type GroupMsgCheck<T> = { ok: true; doc: T } | { ok: false; reason: string };

const HEADER_KEYS = ['v', 'type', 'group', 'from', 'epoch', 'state', 'gseq', 'gprev', 'to', 'heads', 'body_hash', 'ts', 'sig'];

/** Why a `heads` map is malformed, or null: at most 15 other members, each `[gseq ≥ 1, 16 hex digits]`. */
function headsProblem(heads: unknown, from: string): string | null {
  if (!isPlainObject(heads)) return 'heads must be an object';
  const entries = Object.entries(heads);
  if (entries.length > GROUP_LIMITS.members - 1) return 'too many heads';
  for (const [id, v] of entries) {
    if (!isAgentId(id) || id === from) return 'bad heads member';
    if (!Array.isArray(v) || v.length !== 2 || !isCount(v[0]) || typeof v[1] !== 'string' || !HEX16.test(v[1])) return 'bad heads entry';
  }
  return null;
}

/**
 * A signed group message header on its own (§7.8.3): shape, bounds,
 * signature by `from`. Strict: unknown keys are refused. Board-visible
 * (`to: "*"`) carries `gseq` and `gprev`; a private one (a list of members)
 * carries neither.
 */
export function verifyGroupMsg(input: unknown, now = new Date()): GroupMsgCheck<GroupMsg> {
  if (!isPlainObject(input)) return { ok: false, reason: 'not an object' };
  const m = input as unknown as GroupMsg;
  if (!onlyKeys(input, HEADER_KEYS)) return { ok: false, reason: 'unknown field in group message' };
  if (m.v !== 1 || m.type !== GROUP_MSG_TYPE || !isDocId(m.group)) return { ok: false, reason: 'not a group message' };
  if (!isAgentId(m.from)) return { ok: false, reason: 'bad sender' };
  if (!Number.isSafeInteger(m.epoch) || m.epoch < 0 || !isHex64(m.state)) return { ok: false, reason: 'bad epoch or state' };
  if (!isHex64(m.body_hash)) return { ok: false, reason: 'bad body_hash' };
  if (!tsOk(m.ts, now)) return { ok: false, reason: 'bad ts' };
  if (m.to === '*') {
    if (!isCount(m.gseq)) return { ok: false, reason: 'bad gseq' };
    if (m.gseq === 1 ? m.gprev !== null : !isHex64(m.gprev)) return { ok: false, reason: 'bad gprev' };
  } else {
    if (!Array.isArray(m.to) || m.to.length < 1 || m.to.length > GROUP_MSG_LIMITS.privateTo) return { ok: false, reason: 'bad to' };
    if (!m.to.every((id) => isAgentId(id) && id !== m.from) || new Set(m.to).size !== m.to.length) return { ok: false, reason: 'bad to' };
    if (Object.hasOwn(input, 'gseq') || Object.hasOwn(input, 'gprev')) return { ok: false, reason: 'a private group message has no gseq or gprev' };
  }
  if (m.heads !== undefined) {
    const p = headsProblem(m.heads, m.from);
    if (p) return { ok: false, reason: p };
  }
  if (size(m) > GROUP_MSG_LIMITS.headBytes) return { ok: false, reason: 'group message header too large' };
  if (!verifyDoc(m, m.from)) return { ok: false, reason: 'bad signature' };
  return { ok: true, doc: m };
}

/** Canonical JSON (§4.6) has integers only; deeper than 32 levels is refused too. */
function integersOnly(v: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (typeof v === 'number') return Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.every((x) => integersOnly(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).every((x) => integersOnly(x, depth + 1));
  return true;
}

/** Why a body is unusable, or null: a JSON object with a short `type`, canonical (integers only), at most 24 KiB. */
export function groupBodyProblem(body: unknown): string | null {
  if (!isPlainObject(body)) return 'the body must be a JSON object';
  if (typeof body.type !== 'string' || body.type === '' || body.type.length > GROUP_MSG_LIMITS.bodyTypeChars || /[\p{Cc}\p{Cf}]/u.test(body.type)) {
    return 'the body needs a short "type" string';
  }
  const n = size(body);
  if (!Number.isFinite(n) || !integersOnly(body, 0)) return 'the body is not canonical JSON (integers only, §4.6)';
  if (n > GROUP_MSG_LIMITS.bodyBytes) return `the body is larger than ${GROUP_MSG_LIMITS.bodyBytes} bytes`;
  return null;
}

/** An `rdv/group-msg` payload: its header, its body, and that the header commits to that body. */
export function verifyGroupMsgPayload(input: unknown, now = new Date()): { ok: true; msg: GroupMsg; body: GroupBody } | { ok: false; reason: string } {
  if (!isPlainObject(input) || input.type !== GROUP_MSG_TYPE || !onlyKeys(input, ['type', 'msg', 'body'])) return { ok: false, reason: 'malformed group message payload' };
  const head = verifyGroupMsg(input.msg, now);
  if (!head.ok) return head;
  const p = groupBodyProblem(input.body);
  if (p) return { ok: false, reason: p };
  if (docHash(input.body) !== head.doc.body_hash) return { ok: false, reason: 'the body is not the one the header signs' };
  return { ok: true, msg: head.doc, body: input.body as GroupBody };
}

export function createGroupMsg(key: AgentKey, fields: Omit<GroupMsgHeader, 'v' | 'type' | 'from' | 'body_hash' | 'ts'> & { body: GroupBody; ts?: string }): GroupMsg {
  const { body, ts, ...rest } = fields;
  const p = groupBodyProblem(body);
  if (p) throw new Error(p);
  const doc = signDoc<GroupMsgHeader>(
    {
      v: 1,
      type: GROUP_MSG_TYPE,
      group: rest.group,
      from: key.id,
      epoch: rest.epoch,
      state: rest.state,
      ...(rest.to === '*' ? { gseq: rest.gseq, gprev: rest.gprev ?? null } : {}),
      to: rest.to,
      ...(rest.heads !== undefined && Object.keys(rest.heads).length ? { heads: rest.heads } : {}),
      body_hash: docHash(body),
      ts: ts ?? new Date().toISOString(),
    },
    key,
  );
  const check = verifyGroupMsg(doc, new Date(Math.max(Date.now(), parseTimestamp(doc.ts) ?? 0)));
  if (!check.ok) throw new Error(`group message: ${check.reason}`);
  return doc;
}

const LEAVE_KEYS = ['v', 'type', 'group', 'from', 'epoch', 'state', 'ts', 'sig'];

/** A signed `rdv/group-leave` on its own (§7.8.5). */
export function verifyGroupLeave(input: unknown, now = new Date()): GroupMsgCheck<GroupLeave> {
  if (!isPlainObject(input)) return { ok: false, reason: 'not an object' };
  const l = input as unknown as GroupLeave;
  if (!onlyKeys(input, LEAVE_KEYS)) return { ok: false, reason: 'unknown field in group leave' };
  if (l.v !== 1 || l.type !== GROUP_LEAVE_TYPE || !isDocId(l.group) || !isAgentId(l.from)) return { ok: false, reason: 'not a group leave' };
  if (!Number.isSafeInteger(l.epoch) || l.epoch < 0 || !isHex64(l.state)) return { ok: false, reason: 'bad epoch or state' };
  if (!tsOk(l.ts, now)) return { ok: false, reason: 'bad ts' };
  if (!verifyDoc(l, l.from)) return { ok: false, reason: 'bad signature' };
  return { ok: true, doc: l };
}

export function createGroupLeave(key: AgentKey, r: Pick<GroupRecord, 'group' | 'state'>, now = new Date()): GroupLeave {
  return signDoc<GroupLeaveBody>({ v: 1, type: GROUP_LEAVE_TYPE, group: r.group, from: key.id, epoch: r.state.epoch, state: docHash(r.state), ts: now.toISOString() }, key);
}

/**
 * Whether two board headers prove their signer equivocated (§7.8.6): the
 * same signer and group, and either the same `gseq` with different
 * contents, or one at the next `gseq` whose `gprev` is not the other's hash.
 */
export function equivocationProof(a: GroupMsg, b: GroupMsg): boolean {
  if (a.from !== b.from || a.group !== b.group || a.to !== '*' || b.to !== '*') return false;
  const ha = docHash(a);
  const hb = docHash(b);
  if (ha === hb) return false;
  if (a.gseq === b.gseq) return true;
  if (b.gseq === (a.gseq ?? 0) + 1) return b.gprev !== ha;
  if (a.gseq === (b.gseq ?? 0) + 1) return a.gprev !== hb;
  return false;
}

// --- the receiver's records ------------------------------------------------------------------

const newChain = (): MemberChain => ({ gseq: 0, head: null, recent: [], headers: [], buffer: [] });

function chainOf(r: GroupRecord, member: string): MemberChain {
  r.chains ??= {};
  if (!Object.hasOwn(r.chains, member)) r.chains[member] = newChain();
  return r.chains[member];
}

const peekChain = (r: GroupRecord, member: string): MemberChain | undefined => (r.chains && Object.hasOwn(r.chains, member) ? r.chains[member] : undefined);
const hashAt = (c: MemberChain, gseq: number): string | undefined => c.recent.find(([g]) => g === gseq)?.[1];
const headerAt = (c: MemberChain, gseq: number): GroupMsg | undefined => c.headers.find((h) => h.gseq === gseq);

/** A member we take group messages from: listed in our state (or the one before, during a change), not departed, not us. */
export function isSendingMember(r: GroupRecord, id: string, me: string): boolean {
  if (id === me || (r.departed && Object.hasOwn(r.departed, id))) return false;
  return !!memberOf(r.state, id) || (!!r.prevState && !!memberOf(r.prevState, id));
}

/** Members we send our group traffic to: approved by policy or by our human, still listed, not departed. */
export function groupRecipients(r: GroupRecord, me: string): string[] {
  return r.approved.filter((id) => id !== me && !!memberOf(r.state, id) && !(r.departed && Object.hasOwn(r.departed, id)));
}

/** Our heads (§7.8.3): per other member we accepted board messages from, its newest gseq and 16 hex digits of that header's hash. */
export function headsOf(r: GroupRecord, me: string): Record<string, [number, string]> {
  const out: Record<string, [number, string]> = {};
  for (const [id, c] of Object.entries(r.chains ?? {})) {
    if (id === me || !memberOf(r.state, id) || c.head === null || c.gseq < 1) continue;
    out[id] = [c.gseq, c.head.slice(0, 16)];
  }
  return out;
}

function take(c: MemberChain, msg: GroupMsg, hash: string): void {
  c.gseq = msg.gseq ?? c.gseq;
  c.head = hash;
  c.recent.push([c.gseq, hash]);
  if (c.recent.length > GROUP_MSG_LIMITS.chainHashes) c.recent.splice(0, c.recent.length - GROUP_MSG_LIMITS.chainHashes);
  c.headers.push(msg);
  if (c.headers.length > GROUP_MSG_LIMITS.chainHeaders) c.headers.splice(0, c.headers.length - GROUP_MSG_LIMITS.chainHeaders);
  const t = parseTimestamp(msg.ts);
  if (t !== null) c.newest = Math.max(c.newest ?? t, t);
  if (c.gap && c.gseq >= c.gap.to) delete c.gap;
}

/** Count one message against member_rate (the state's) and our own ceiling; over either, false with the limit hit. */
function admitRate(r: GroupRecord, c: MemberChain, now: Date): { ok: true } | { ok: false; count: number; limit: string } {
  const specs = [r.state.policy.member_rate, GROUP_MSG_LIMITS.memberCeiling];
  const t = now.getTime();
  if (!Number.isFinite(t)) return { ok: false, count: 0, limit: specs[0] };
  const windows = (c.rate ??= []);
  for (let i = 0; i < specs.length; i++) {
    const lim = parseFrequency(specs[i]);
    if (!lim) continue;
    const w = windows[i] && t - windows[i].start < lim.windowMs && t >= windows[i].start ? windows[i] : { start: t, count: 0 };
    windows[i] = w;
    if (w.count >= lim.count) return { ok: false, count: w.count + 1, limit: specs[i] };
  }
  for (const w of windows) if (w) w.count++;
  return { ok: true };
}

/** Mute a member (§7.8.7): tell our human, and each admin (other than us and it) gets an rdv/group-report. */
function mute(r: GroupRecord, c: MemberChain, member: string, me: string, over: { count: number; limit: string }, now: Date, fx: GroupEffects): void {
  c.muted = { since: now.toISOString(), count: over.count, limit: over.limit };
  c.buffer = [];
  fx.mutes.push({ group: r.group, member, count: over.count, limit: over.limit });
  for (const m of r.state.members) {
    if (m.role !== 'admin' || m.id === me || m.id === member) continue;
    fx.send.push({ to: m.id, payload: { type: GROUP_REPORT_TYPE, group: r.group, member, count: over.count, limit: over.limit } satisfies GroupReportPayload });
  }
}

function refuse(r: GroupRecord, c: MemberChain, member: string, headers: GroupMsg[], now: Date, fx: GroupEffects, via?: string): void {
  const hashes = [...new Set(headers.map(docHash))];
  const gseq = Math.min(...headers.map((h) => h.gseq ?? 0));
  c.refused = { gseq, hashes, since: now.toISOString(), ...(via ? { via } : {}) };
  c.buffer = [];
  delete c.gap;
  fx.equivocations.push({ group: r.group, member, gseq, hashes, headers, ...(via ? { via } : {}) });
}

/** Remember that we sent `to` our header for (member, gseq); false if we already did. */
function markForwarded(r: GroupRecord, member: string, gseq: number, to: string): boolean {
  const key = `${member}:${gseq}:${to}`;
  r.forwarded ??= [];
  if (r.forwarded.includes(key)) return false;
  r.forwarded.push(key);
  if (r.forwarded.length > GROUP_MSG_LIMITS.forwarded) r.forwarded.splice(0, r.forwarded.length - GROUP_MSG_LIMITS.forwarded);
  return true;
}

/** Our copy of (member, gseq) to `to` as evidence, once, and only to a member we send to (under `ask` an unapproved one gets nothing). */
function forwardEvidence(r: GroupRecord, member: string, gseq: number, to: string, me: string, fx: GroupEffects): void {
  const c = peekChain(r, member);
  const ours = c ? headerAt(c, gseq) : undefined;
  if (!ours || to === member || !groupRecipients(r, me).includes(to) || !markForwarded(r, member, gseq, to)) return;
  fx.send.push({ to, payload: { type: GROUP_PROOF_TYPE, group: r.group, msgs: [ours] } satisfies GroupProofPayload });
}

/**
 * The heads of a message we accepted from `from` (§7.8.6 layer 3). Their
 * claims are not proof (anyone can write any hash), so nothing is refused
 * here: a hash that differs from ours makes us send `from` our signed copy,
 * the evidence it needs to check; a gseq beyond ours asks the sender for a
 * group resend.
 */
function compareHeads(r: GroupRecord, from: string, msg: GroupMsg, me: string, now: Date, fx: GroupEffects): void {
  for (const [member, [gseq, prefix]] of Object.entries(msg.heads ?? {})) {
    if (member === me || member === from || !isSendingMember(r, member, me)) continue;
    const c = peekChain(r, member);
    if (!c || c.refused || c.muted || c.resync || c.gseq < 1) continue;
    if (gseq > c.gseq) {
      askResend(r, c, member, c.gseq + 1, Math.min(gseq, firstBuffered(c) - 1), now, fx);
      continue;
    }
    const known = hashAt(c, gseq);
    if (known !== undefined && known.slice(0, 16) !== prefix) forwardEvidence(r, member, gseq, from, me, fx);
  }
}

/** The lowest gseq waiting in the buffer (what we ask for ends before it), or +∞. */
const firstBuffered = (c: MemberChain): number => (c.buffer.length ? Math.min(...c.buffer.map((b) => b.msg.gseq ?? 0)) : Number.POSITIVE_INFINITY);

function askResend(r: GroupRecord, c: MemberChain, member: string, from: number, to: number, now: Date, fx: GroupEffects): void {
  if (c.gap && c.gap.to >= to) return;
  const lo = c.gap ? Math.max(from, c.gap.to + 1) : from;
  const hi = Math.min(to, lo + GROUP_MSG_LIMITS.resendSpan - 1);
  if (hi < lo) return;
  c.gap = { from: c.gap?.from ?? from, to: hi, asked: c.gap?.asked ?? now.toISOString() };
  fx.send.push({ to: member, payload: { type: 'rdv/resend', group: r.group, from_gseq: lo, to_gseq: hi } });
}

/** Deliver the buffered messages that now continue the chain. */
function drain(r: GroupRecord, c: MemberChain, member: string, me: string, now: Date, fx: GroupEffects): void {
  c.buffer.sort((a, b) => (a.msg.gseq ?? 0) - (b.msg.gseq ?? 0));
  while (c.buffer.length && !c.refused) {
    const next = c.buffer[0];
    const g = next.msg.gseq ?? 0;
    if (g <= c.gseq) {
      c.buffer.shift();
      continue;
    }
    if (g !== c.gseq + 1) return;
    c.buffer.shift();
    if (c.head !== null && next.msg.gprev !== c.head) {
      const ours = headerAt(c, c.gseq);
      refuse(r, c, member, ours ? [ours, next.msg] : [next.msg], now, fx);
      return;
    }
    take(c, next.msg, docHash(next.msg));
    fx.delivered.push({ group: r.group, from: member, msg: next.msg, body: next.body, board: true });
    compareHeads(r, member, next.msg, me, now, fx);
  }
}

/** A gap that stayed open past gapWaitMs (or a full buffer): tell our human, and move the chain on to what we hold. */
function expireGaps(r: GroupRecord, me: string, now: Date, fx: GroupEffects, force?: string): void {
  for (const [member, c] of Object.entries(r.chains ?? {})) {
    if (!c.gap || c.refused || c.muted) continue;
    const asked = parseTimestamp(c.gap.asked) ?? 0;
    if (member !== force && asked + GROUP_MSG_LIMITS.gapWaitMs > now.getTime()) continue;
    if (!c.buffer.length) {
      // Only a member's heads said there was more: nothing waits on it, so it is not reported.
      if (member !== force) delete c.gap;
      continue;
    }
    c.buffer.sort((a, b) => (a.msg.gseq ?? 0) - (b.msg.gseq ?? 0));
    const first = c.buffer[0].msg.gseq ?? 0;
    if (first > c.gseq + 1) fx.gaps.push({ group: r.group, member, from: c.gseq + 1, to: first - 1 });
    c.gseq = first - 1;
    c.head = null;
    delete c.gap;
    drain(r, c, member, me, now, fx);
  }
}

/**
 * An `rdv/group-msg` from `from` over its pairwise channel (§7.8.3). Taken
 * only when it verifies, comes from its signer, a member of a group we are
 * in (the state we hold or the one before) that has not left, is addressed to
 * us, and was written under a state we hold; one for a newer epoch waits for
 * its state. Board messages then continue the sender's group chain: a gap
 * asks for a group resend, two headers at one gseq refuse the sender
 * (§7.8.6). Over member_rate or our ceiling, the sender is muted (§7.8.7).
 */
export function receiveGroupMessage(book: GroupBook, input: unknown, from: string, ctx: GroupContext): GroupEffects {
  const now = ctx.now ?? new Date();
  const check = verifyGroupMsgPayload(input, now);
  if (!check.ok) return dropped(`group message invalid: ${check.reason}`);
  const { msg, body } = check;
  if (msg.from !== from) return dropped('group message not from its signer');
  const r = book.group(msg.group);
  if (!r || r.status !== 'active' || !isSendingMember(r, from, ctx.me)) return dropped('group message from a non-member');
  if (msg.to !== '*' && !msg.to.includes(ctx.me)) return dropped('group message not addressed to us');
  if (!r.history.some((h) => h.epoch === msg.epoch && h.hash === msg.state)) {
    if (msg.epoch <= r.state.epoch) return dropped('group message for a state we do not hold');
    // A newer epoch waits for its state (only from a member of ours: checked above), bounded per sender and per group.
    r.waiting ??= [];
    const hash = docHash(msg);
    if (!r.waiting.some((w) => docHash((w.payload as GroupMsgPayload).msg) === hash)) {
      if (r.waiting.filter((w) => w.from === from).length >= GROUP_MSG_LIMITS.waitingPerSender || r.waiting.length >= GROUP_MSG_LIMITS.waiting) {
        return dropped('group message for a newer epoch: too many waiting');
      }
      r.waiting.push({ from, payload: { type: GROUP_MSG_TYPE, msg, body } });
    }
    return { ...effects(), waiting: true };
  }
  return accept(r, msg, body, from, ctx.me, now);
}

function accept(r: GroupRecord, msg: GroupMsg, body: GroupBody, from: string, me: string, now: Date): GroupEffects {
  const fx = effects();
  expireGaps(r, me, now, fx);
  const c = chainOf(r, from);
  const hash = docHash(msg);
  if (c.refused) return dropped(c.refused.hashes.includes(hash) ? 'group message duplicate' : 'group message refused: its sender equivocated (until our human re-syncs it)', fx);
  if (c.muted) return dropped('group message refused: its sender is muted (until our human re-syncs it)', fx);

  if (msg.to !== '*') {
    if (c.priv?.includes(hash)) return dropped('group message duplicate', fx);
    const over = admitRate(r, c, now);
    if (!over.ok) {
      mute(r, c, from, me, over, now, fx);
      return dropped('group message over the rate: sender muted', fx);
    }
    c.priv = [...(c.priv ?? []), hash].slice(-GROUP_MSG_LIMITS.privateSeen);
    fx.delivered.push({ group: r.group, from, msg, body, board: false });
    compareHeads(r, from, msg, me, now, fx);
    return fx;
  }

  const ts = parseTimestamp(msg.ts) ?? Number.NEGATIVE_INFINITY;
  if (c.floor !== undefined && !(ts > c.floor)) return dropped('group message duplicate', fx);
  const gseq = msg.gseq as number;
  if (!c.resync) {
    const known = hashAt(c, gseq);
    if (known === hash || c.buffer.some((b) => docHash(b.msg) === hash)) return dropped('group message duplicate', fx);
    if (known !== undefined) {
      // The same sender, the same gseq, another message: its own signatures prove it (§7.8.6 layer 2).
      const ours = headerAt(c, gseq);
      refuse(r, c, from, ours ? [ours, msg] : [msg], now, fx);
      return dropped('group message equivocation', fx);
    }
    if (c.gseq > 0 && gseq <= c.gseq) return dropped('group message duplicate', fx); // too old to tell
  }
  const over = admitRate(r, c, now);
  if (!over.ok) {
    mute(r, c, from, me, over, now, fx);
    return dropped('group message over the rate: sender muted', fx);
  }
  if (c.resync) {
    // Our human re-synced it: only something newer than all we accepted starts its chain again.
    if (c.newest !== undefined && !(ts > c.newest)) return dropped('group message duplicate', fx);
    delete c.resync;
    c.recent = [];
    c.headers = [];
    c.buffer = [];
    delete c.gap;
    c.gseq = gseq - 1;
    c.head = null;
  }
  if (c.gseq === 0 || gseq === c.gseq + 1) {
    if (c.gseq > 0 && c.head !== null && msg.gprev !== c.head) {
      const ours = headerAt(c, c.gseq);
      refuse(r, c, from, ours ? [ours, msg] : [msg], now, fx);
      return dropped('group message equivocation', fx);
    }
    take(c, msg, hash);
    fx.delivered.push({ group: r.group, from, msg, body, board: true });
    compareHeads(r, from, msg, me, now, fx);
    drain(r, c, from, me, now, fx);
    return fx;
  }
  // A gap in the sender's group chain (§7.8.6 layer 2): it may have left us out. Ask for it, keep what came.
  if (c.buffer.length < GROUP_MSG_LIMITS.buffer) c.buffer.push({ msg, body });
  askResend(r, c, from, c.gseq + 1, firstBuffered(c) - 1, now, fx);
  if (c.buffer.length >= GROUP_MSG_LIMITS.buffer) expireGaps(r, me, now, fx, from);
  return fx;
}

/** Messages that waited for a newer epoch and may now apply (call after a state applied). They are handled again as if just received. */
export function takeWaiting(book: GroupBook, group: string): Array<{ from: string; payload: unknown }> {
  const r = book.group(group);
  if (!r?.waiting?.length) return [];
  if (r.status !== 'active') {
    delete r.waiting;
    return [];
  }
  const ready = r.waiting.filter((w) => (w.payload as GroupMsgPayload).msg.epoch <= r.state.epoch);
  r.waiting = r.waiting.filter((w) => (w.payload as GroupMsgPayload).msg.epoch > r.state.epoch);
  if (!r.waiting.length) delete r.waiting;
  return ready;
}

/**
 * Evidence from `from`, a member (§7.8.6 layer 3): one or two headers
 * signed by another member. Only a real conflict counts: two headers that
 * member signed (or one and ours) at one gseq, or a `gprev` that skips ours.
 * Then that member is refused, our human is told, and `from` gets our copy
 * back if it showed us a conflict with it. A forged or non-conflicting
 * header triggers nothing.
 */
export function receiveGroupProof(book: GroupBook, input: unknown, from: string, ctx: GroupContext): GroupEffects {
  const now = ctx.now ?? new Date();
  if (!isPlainObject(input) || input.type !== GROUP_PROOF_TYPE || !onlyKeys(input, ['type', 'group', 'msgs']) || !isDocId(input.group)) return dropped('group proof malformed');
  const r = book.group(input.group);
  if (!r || r.status !== 'active' || !isSendingMember(r, from, ctx.me)) return dropped('group proof from a non-member');
  if (!Array.isArray(input.msgs) || input.msgs.length < 1 || input.msgs.length > 2) return dropped('group proof malformed');
  const msgs: GroupMsg[] = [];
  for (const raw of input.msgs) {
    const check = verifyGroupMsg(raw, now);
    if (!check.ok) return dropped(`group proof invalid: ${check.reason}`);
    msgs.push(check.doc);
  }
  const member = msgs[0].from;
  if (msgs.some((m) => m.from !== member || m.group !== r.group || m.to !== '*')) return dropped('group proof invalid: headers of different senders or groups');
  if (member === ctx.me || !isSendingMember(r, member, ctx.me)) return dropped('group proof about a non-member');
  const c = peekChain(r, member);
  // Headers of a chain our human re-synced away from are replays of it: they prove nothing about the current one.
  const cutoff = c?.resynced ?? c?.floor;
  if (cutoff !== undefined && msgs.some((m) => !((parseTimestamp(m.ts) ?? Number.NEGATIVE_INFINITY) > cutoff))) return dropped('group proof about a chain our human re-synced');
  // Candidate pairs: the two headers sent, and each against the headers we hold.
  const ours = c ? c.headers : [];
  let pair: { ours?: GroupMsg; headers: GroupMsg[]; gseq: number } | undefined;
  if (msgs.length === 2 && equivocationProof(msgs[0], msgs[1])) pair = { headers: msgs, gseq: Math.min(msgs[0].gseq ?? 0, msgs[1].gseq ?? 0) };
  for (const m of msgs) {
    if (pair) break;
    const known = c ? hashAt(c, m.gseq as number) : undefined;
    const mine = ours.find((o) => equivocationProof(o, m));
    if (mine) pair = { ours: mine, headers: [mine, m], gseq: Math.min(mine.gseq ?? 0, m.gseq ?? 0) };
    else if (known !== undefined && known !== docHash(m)) pair = { headers: [m], gseq: m.gseq as number }; // ours is older than the headers we keep
  }
  if (!pair) return dropped('group proof shows no conflict');
  const fx = effects();
  const chain = chainOf(r, member);
  if (!chain.refused) refuse(r, chain, member, pair.headers, now, fx, from);
  // Our copy to the member that showed us the conflict, so it holds the proof too.
  if (pair.ours) forwardEvidence(r, member, pair.ours.gseq as number, from, ctx.me, fx);
  return fx;
}

/** A group resend (`rdv/resend` with `group`) from `peer`: our board messages in the range, only to a member we send to. */
export function groupResend(book: GroupBook, group: unknown, peer: string, fromGseq: unknown, toGseq: unknown, me: string): GroupMsgPayload[] | { rejected: string } {
  if (!isDocId(group)) return { rejected: 'malformed' };
  const r = book.group(group);
  if (!r || r.status !== 'active') return { rejected: 'not a group we are in' };
  if (!groupRecipients(r, me).includes(peer)) return { rejected: 'not a member we send to' };
  const lo = Number(fromGseq);
  const hi = Number(toGseq);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 1 || hi < lo) return { rejected: 'bad range' };
  const top = Math.min(hi, lo + GROUP_MSG_LIMITS.resendSpan - 1);
  return (r.out?.sent ?? []).filter((s) => (s.msg.gseq ?? 0) >= lo && (s.msg.gseq ?? 0) <= top).map((s) => ({ type: GROUP_MSG_TYPE, msg: s.msg, body: s.body }));
}

/**
 * A member's `rdv/group-leave` (§7.8.5). Only its own, for a group both are
 * in, bound to a state we hold (or a newer one), and not older than the
 * epoch it was last added at (a replay). We stop sending to it at once; as an
 * admin we also issue the state without it (the caller fans it out).
 */
export function receiveGroupLeave(book: GroupBook, key: AgentKey, input: unknown, from: string, ctx: GroupContext): { ok: true; group: string; member: string; change?: GroupChange } | { ok: false; reason: string } {
  const now = ctx.now ?? new Date();
  const check = verifyGroupLeave(input, now);
  if (!check.ok) return { ok: false, reason: `group leave invalid: ${check.reason}` };
  const l = check.doc;
  if (l.from !== from) return { ok: false, reason: 'group leave not from its signer' };
  const r = book.group(l.group);
  if (!r || r.status !== 'active' || !isSendingMember(r, from, ctx.me) || !memberOf(r.state, from)) return { ok: false, reason: 'group leave from a non-member' };
  const known = r.history.some((h) => h.epoch === l.epoch && h.hash === l.state);
  if (!known && l.epoch <= r.state.epoch) return { ok: false, reason: 'group leave for a state we do not hold' };
  if (l.epoch < (r.added?.[from] ?? 0)) return { ok: false, reason: 'group leave older than the member: a replay' };
  r.departed = { ...(r.departed ?? {}), [from]: { epoch: l.epoch, since: now.toISOString() } };
  r.approved = r.approved.filter((id) => id !== from);
  delete r.newcomers[from];
  if (r.chains) delete r.chains[from];
  if (r.waiting) r.waiting = r.waiting.filter((w) => w.from !== from);
  let change: GroupChange | undefined;
  if (isAdmin(r.state, key.id) && !r.frozen) {
    try {
      change = book.remove(key, r.group, from, { ...ctx, now });
    } catch {
      // e.g. it was the last admin; it stays listed but departed
    }
  }
  return { ok: true, group: r.group, member: from, ...(change ? { change } : {}) };
}

/** An admin's `rdv/group-report` from a member (§7.8.7): shown to our human only. Nothing is removed on a report. */
export function receiveGroupReport(book: GroupBook, input: unknown, from: string, ctx: GroupContext): { ok: true; report: GroupReport } | { ok: false; reason: string } {
  if (!isPlainObject(input) || input.type !== GROUP_REPORT_TYPE || !onlyKeys(input, ['type', 'group', 'member', 'count', 'limit']) || !isDocId(input.group)) {
    return { ok: false, reason: 'group report malformed' };
  }
  const r = book.group(input.group);
  if (!r || r.status !== 'active' || !isSendingMember(r, from, ctx.me)) return { ok: false, reason: 'group report from a non-member' };
  if (!isAdmin(r.state, ctx.me)) return { ok: false, reason: 'group report: we are not an admin' };
  const { member, count, limit } = input;
  if (!isAgentId(member) || member === from || !memberOf(r.state, member)) return { ok: false, reason: 'group report about a non-member' };
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 1_000_000 || typeof limit !== 'string' || !parseFrequency(limit)) {
    return { ok: false, reason: 'group report malformed' };
  }
  return { ok: true, report: { group: r.group, from, member, count: count as number, limit } };
}

// --- our own side --------------------------------------------------------------------------

/**
 * A group message from us (§7.8.3): signed once, for the caller to seal to
 * each recipient. Board-visible (`to` omitted) goes to every member we may
 * send to and consumes our gseq; a private one names members we may send to
 * (approved: under `ask` a newcomer our human has not approved gets nothing).
 */
export function prepareGroupMessage(
  book: GroupBook,
  key: AgentKey,
  groupId: string,
  body: GroupBody,
  opts: { to?: string[]; isBlocked?: (peer: string) => boolean; now?: Date } = {},
): { payload: GroupMsgPayload; recipients: string[] } {
  const now = opts.now ?? new Date();
  const r = book.group(groupId);
  if (!r || r.status !== 'active') throw new Error(`not a member of group ${groupId}`);
  const p = groupBodyProblem(body);
  if (p) throw new Error(p);
  const may = groupRecipients(r, key.id).filter((id) => !opts.isBlocked?.(id));
  const heads = headsOf(r, key.id);
  const base = { group: r.group, epoch: r.state.epoch, state: docHash(r.state), heads, body, ts: now.toISOString() };
  if (opts.to !== undefined) {
    const to = [...new Set(opts.to)];
    if (to.length < 1 || to.length > GROUP_MSG_LIMITS.privateTo) throw new Error(`a private group message names 1 to ${GROUP_MSG_LIMITS.privateTo} members`);
    const not = to.filter((id) => !may.includes(id));
    if (not.length) throw new Error(`not members this agent sends to in the group (not listed, left, or not approved by your user): ${not.join(', ')}`);
    return { payload: { type: GROUP_MSG_TYPE, msg: createGroupMsg(key, { ...base, to }), body }, recipients: to };
  }
  const out = (r.out ??= { gseq: 0, head: null, sent: [] });
  const msg = createGroupMsg(key, { ...base, to: '*', gseq: out.gseq + 1, gprev: out.gseq === 0 ? null : out.head });
  out.gseq = msg.gseq as number;
  out.head = docHash(msg);
  out.sent.push({ msg, body });
  if (out.sent.length > GROUP_MSG_LIMITS.outbox) out.sent.splice(0, out.sent.length - GROUP_MSG_LIMITS.outbox);
  return { payload: { type: GROUP_MSG_TYPE, msg, body }, recipients: may };
}

/**
 * Our human's re-sync of one member (§7.8.6, as §6.4): after checking with
 * that member's human, its group messages are accepted again. A refused
 * chain starts again at its next board message newer than everything we
 * accepted from it (replays of the old one stay duplicates); a mute is
 * lifted and its counts start over.
 */
export function resyncMember(book: GroupBook, groupId: string, member: string, now = new Date()): MemberChain {
  const r = book.group(groupId);
  if (!r || r.status !== 'active') throw new Error(`not a member of group ${groupId}`);
  const c = peekChain(r, member);
  if (!c || (!c.refused && !c.muted)) throw new Error(`${member} is neither refused nor muted in group ${groupId}`);
  if (c.refused) {
    if (c.newest !== undefined) c.floor = Math.max(c.floor ?? c.newest, c.newest);
    c.resync = true;
    c.resynced = now.getTime();
    delete c.refused;
  }
  delete c.muted;
  delete c.rate;
  c.buffer = [];
  delete c.gap;
  return c;
}

/** Members whose group messages we refuse (equivocation) or mute (rate), per group: for the hosts. */
export function refusedMembers(r: GroupRecord): Array<{ member: string; kind: 'equivocation' | 'muted'; since: string; gseq?: number; count?: number; limit?: string }> {
  return Object.entries(r.chains ?? {}).flatMap(([member, c]) => [
    ...(c.refused ? [{ member, kind: 'equivocation' as const, since: c.refused.since, gseq: c.refused.gseq }] : []),
    ...(c.muted ? [{ member, kind: 'muted' as const, since: c.muted.since, count: c.muted.count, limit: c.muted.limit }] : []),
  ]);
}

/** The members a leave goes to: everyone else listed, who has not left. */
export const leaveRecipients = (r: GroupRecord, me: string): string[] => memberIds(r.state).filter((id) => id !== me && !(r.departed && Object.hasOwn(r.departed, id)));
