// §7.8: groups, v1 (design Part B, slice 1: membership). A group has no key
// of its own: its membership is an admin-signed document (`rdv/group-state`)
// chained by `epoch` and `prev`, and everything a member says to the group is
// sealed to each other member over the pairwise channels (§6.4). This module
// holds the signed documents, their verification, and the local book that
// keeps each group's state, the invites waiting for our human, and who our
// human agreed to disclose to (the newcomer policy). It never decides on its
// own whether to join or approve anyone: those are `GroupBook.join` and
// `GroupBook.approveNewcomer`, called only for the human.
import { sha256 } from '@noble/hashes/sha256';
import { type AddressCard, verifyCard } from './card.js';
import { type InvokeLimits, invokeProblem, isDocId, parseFrequency } from './contact.js';
import { bytesToHex, canonicalBytes, isPast, parseTimestamp } from './encoding.js';
import { type AgentKey, isAgentId } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';

/** The groups extension (SPEC §7.8): a profile extension listed on the card. Admins invite only peers that list it. */
export const GROUPS_EXTENSION = 'https://rendezvous.nesher.co/ext/groups/v1';

export const GROUP_STATE_TYPE = 'rdv/group-state';
export const GROUP_INVITE_TYPE = 'rdv/group-invite';
export const GROUP_JOIN_TYPE = 'rdv/group-join';
export const GROUP_MEMBERS_TYPE = 'rdv/group-members';
export const GROUP_TYPES: readonly string[] = Object.freeze([GROUP_STATE_TYPE, GROUP_INVITE_TYPE, GROUP_JOIN_TYPE, GROUP_MEMBERS_TYPE]);

/** Bounds (SPEC §7.8.1, §7.8.2; reference values). */
export const GROUP_LIMITS = Object.freeze({
  /** Members per group, admins included (owner decision C.6 2). */
  members: 16,
  /** Invites waiting for our human, in all and per inviting admin. */
  pendingInvites: 16,
  invitesPerAdmin: 2,
  /** Groups an agent belongs to (or is joining). */
  groups: 32,
  /** Characters of the group's name and of a member's admin-written name. */
  nameChars: 100,
  memberNameChars: 64,
  /** Characters of an invite's greeting (peer text, display only). */
  greetingChars: 280,
  /** Lifetime of an invite: default, and the most a receiver accepts. */
  inviteTtlMs: 7 * 86_400_000,
  inviteMaxTtlMs: 14 * 86_400_000,
  /** How far ahead of our clock a document's `ts` may be. */
  skewMs: 5 * 60_000,
  /** States ahead of ours kept until the chain reaches them, per group. */
  futureStates: 4,
  /** Recent (epoch, hash, signer) kept per group, to tell a fork from a replay. */
  history: 16,
  /** Canonical JSON of a state and of a join document. */
  stateBytes: 8192,
  joinBytes: 24_576,
  /** One `rdv/group-members` payload: under the 32 KiB envelope cap (§6.4). */
  membersPayloadBytes: 28_672,
  /** Ids of invites and joins remembered for replay protection. */
  seen: 2000,
  /** A joining record we never got admitted by is dropped this long after its invite expired. */
  joiningGraceMs: 7 * 86_400_000,
});

/** Group control payloads we process per peer (each can rewrite a group): dropped over it, never revoking. */
export const GROUP_CONTROL_LIMIT = { count: 60, windowMs: 3_600_000 };
export const DEFAULT_MEMBER_RATE = '60/hour';

export type GroupRole = 'admin' | 'member';
/** Chosen by each member when it joins (SPEC §7.8.2): `ask` (default) or `trust-admin`. Local, never on the wire. */
export type NewcomerPolicy = 'ask' | 'trust-admin';
export const NEWCOMER_POLICIES: readonly NewcomerPolicy[] = ['ask', 'trust-admin'];

export interface GroupMember {
  id: string;
  role: GroupRole;
  /** Hex SHA-256 of the canonical JSON of the member's card (the card inside its join document). */
  card: string;
  /** Display text the admin wrote for this member (§5.6); never a local label, never verified. */
  name?: string;
}

export interface GroupPolicy {
  member_rate: string;
  /** Reserved: this version writes `false` and only admins invite. */
  members_may_invite: boolean;
}

export interface GroupStateBody {
  v: 1;
  type: typeof GROUP_STATE_TYPE;
  group: string;
  epoch: number;
  /** Hash (§4.6) of the state at `epoch - 1`; null at epoch 0. */
  prev: string | null;
  /** The admin that signed it: the creator at epoch 0, else an admin of the previous state. */
  from: string;
  members: GroupMember[];
  policy: GroupPolicy;
  /** The group's name, admin-written display text (§5.6). */
  name: string;
  ts: string;
}
export type GroupState = Signed<GroupStateBody>;

/**
 * A group-scoped grant (SPEC §7.8.2): what any member may invoke on the
 * joiner through the group. Creates no pairwise contact. Deny by default:
 * no `invoke`, or an empty one, allows nothing.
 */
export interface GroupScope {
  invoke?: Record<string, InvokeLimits>;
  max_frequency?: string;
}

export interface GroupInviteBody {
  v: 1;
  type: typeof GROUP_INVITE_TYPE;
  id: string;
  group: string;
  from: string;
  to: string;
  /** The group's current state, signed by its admin. */
  state: GroupState;
  /** Peer text: display only (§5.6). */
  greeting: string;
  expires: string;
  ts: string;
}
export type GroupInvite = Signed<GroupInviteBody>;

export interface GroupJoinBody {
  v: 1;
  type: typeof GROUP_JOIN_TYPE;
  id: string;
  group: string;
  from: string;
  /** The admin it is sent to (the creator's own join: itself). */
  to: string;
  /** The invite it answers; null for the creator's own join. */
  invite_ref: string | null;
  /** Hash of the state the joiner's human approved. */
  state: string;
  /** The joiner's card: members reach it through this one, and the state pins its hash. */
  card: AddressCard;
  scope: GroupScope;
  ts: string;
}
export type GroupJoin = Signed<GroupJoinBody>;

/** Members' join documents (cards inside), sent by an admin after a state that adds members. Unsigned: each join is. */
export interface GroupMembersPayload {
  type: typeof GROUP_MEMBERS_TYPE;
  group: string;
  joins: GroupJoin[];
}

// --- hashes and shapes ---------------------------------------------------------

/** Lowercase hex SHA-256 of a document's canonical JSON, `sig` included (§4.6): `prev`, card hashes, join `state`. */
export function docHash(doc: unknown): string {
  return bytesToHex(sha256(canonicalBytes(doc)));
}

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Display text: a string of at most `max` characters with no control characters (C0, C1). */
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\p{Cc}]/u.test(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const byteLength = (doc: unknown): number => canonicalBytes(doc).length;

/** Why a group-scoped grant is malformed, or null. Only `invoke` (as §5.3) and `max_frequency`. */
export function groupScopeProblem(scope: unknown): string | null {
  if (!isPlainObject(scope)) return 'scope must be a JSON object';
  if (!onlyKeys(scope, ['invoke', 'max_frequency'])) return 'a group scope holds only invoke and max_frequency';
  if (scope.invoke !== undefined) {
    const p = invokeProblem(scope.invoke);
    if (p) return p;
    if (Object.hasOwn(scope.invoke as object, GROUPS_EXTENSION)) return 'the groups extension is not a capability to invoke';
  }
  if (scope.max_frequency !== undefined && (typeof scope.max_frequency !== 'string' || !parseFrequency(scope.max_frequency))) {
    return 'max_frequency must be "<n>/<minute|hour|day>"';
  }
  return null;
}

/** A group scope as we write it in our own join: validated and copied. Throws when malformed. */
export function groupScope(scope: GroupScope = {}): GroupScope {
  const p = groupScopeProblem(scope);
  if (p) throw new Error(p);
  return {
    invoke: Object.fromEntries(Object.entries(scope.invoke ?? {}).map(([k, l]) => [k, { ...l }])),
    ...(scope.max_frequency !== undefined ? { max_frequency: scope.max_frequency } : {}),
  };
}

export type GroupCheck<T> = { ok: true; doc: T } | { ok: false; reason: string };

const STATE_KEYS = ['v', 'type', 'group', 'epoch', 'prev', 'from', 'members', 'policy', 'name', 'ts', 'sig'];
const MEMBER_KEYS = ['id', 'role', 'card', 'name'];

/**
 * A signed group state on its own (§7.8.1): shape, bounds, signature by
 * `from`. Strict: unknown keys are refused. At epoch 0 the signer must be an
 * admin listed in it (the creator); later, that it was an admin of the state
 * before is `checkSuccessor`'s job.
 */
export function verifyGroupState(input: unknown, now = new Date()): GroupCheck<GroupState> {
  if (!isPlainObject(input)) return { ok: false, reason: 'not an object' };
  const s = input as unknown as GroupState;
  if (!onlyKeys(input, STATE_KEYS)) return { ok: false, reason: 'unknown field in group state' };
  if (s.v !== 1 || s.type !== GROUP_STATE_TYPE || !isDocId(s.group)) return { ok: false, reason: 'not a group state' };
  if (!Number.isSafeInteger(s.epoch) || s.epoch < 0) return { ok: false, reason: 'bad epoch' };
  if (s.epoch === 0 ? s.prev !== null : !isHex64(s.prev)) return { ok: false, reason: 'bad prev' };
  if (!isAgentId(s.from)) return { ok: false, reason: 'bad signer' };
  const ts = parseTimestamp(s.ts);
  if (ts === null || ts > now.getTime() + GROUP_LIMITS.skewMs) return { ok: false, reason: 'bad ts' };
  if (!isText(s.name, GROUP_LIMITS.nameChars)) return { ok: false, reason: 'bad name' };
  if (!isPlainObject(s.policy) || !onlyKeys(s.policy, ['member_rate', 'members_may_invite'])) return { ok: false, reason: 'bad policy' };
  if (typeof s.policy.member_rate !== 'string' || !parseFrequency(s.policy.member_rate) || typeof s.policy.members_may_invite !== 'boolean') {
    return { ok: false, reason: 'bad policy' };
  }
  if (!Array.isArray(s.members) || s.members.length < 1 || s.members.length > GROUP_LIMITS.members) return { ok: false, reason: `a group has 1 to ${GROUP_LIMITS.members} members` };
  const ids = new Set<string>();
  for (const m of s.members) {
    if (!isPlainObject(m) || !onlyKeys(m, MEMBER_KEYS)) return { ok: false, reason: 'bad member entry' };
    if (!isAgentId(m.id) || (m.role !== 'admin' && m.role !== 'member') || !isHex64(m.card)) return { ok: false, reason: 'bad member entry' };
    if (m.name !== undefined && !isText(m.name, GROUP_LIMITS.memberNameChars)) return { ok: false, reason: 'bad member name' };
    if (ids.has(m.id)) return { ok: false, reason: 'a member is listed twice' };
    ids.add(m.id);
  }
  if (!s.members.some((m) => m.role === 'admin')) return { ok: false, reason: 'a group state lists at least one admin' };
  if (s.epoch === 0 && !isAdmin(s, s.from)) return { ok: false, reason: 'epoch 0 is signed by its creator, an admin in it' };
  if (byteLength(s) > GROUP_LIMITS.stateBytes) return { ok: false, reason: 'group state too large' };
  if (!verifyDoc(s, s.from)) return { ok: false, reason: 'bad signature' };
  return { ok: true, doc: s };
}

export const memberOf = (s: GroupStateBody, id: string): GroupMember | undefined => s.members.find((m) => m.id === id);
export const isAdmin = (s: GroupStateBody, id: string): boolean => memberOf(s, id)?.role === 'admin';
export const memberIds = (s: GroupStateBody): string[] => s.members.map((m) => m.id);

/** Why `next` does not apply on top of `prev` (§7.8.1), or null: same group, epoch one higher, `prev` its hash, signed by an admin of `prev`. */
export function successorProblem(prev: GroupState, next: GroupState): string | null {
  if (next.group !== prev.group) return 'another group';
  if (next.epoch !== prev.epoch + 1) return `epoch ${next.epoch} does not follow ${prev.epoch}`;
  if (next.prev !== docHash(prev)) return 'prev is not the hash of the state we hold';
  if (!isAdmin(prev, next.from)) return 'not signed by an admin of the previous state';
  return null;
}

const INVITE_KEYS = ['v', 'type', 'id', 'group', 'from', 'to', 'state', 'greeting', 'expires', 'ts', 'sig'];

/** A signed invite (§7.8.2): shape, its state, the inviter an admin of it, the invitee not yet a member, room for one more. */
export function verifyGroupInvite(input: unknown, now = new Date()): GroupCheck<GroupInvite> {
  if (!isPlainObject(input)) return { ok: false, reason: 'not an object' };
  const i = input as unknown as GroupInvite;
  if (!onlyKeys(input, INVITE_KEYS)) return { ok: false, reason: 'unknown field in group invite' };
  if (i.v !== 1 || i.type !== GROUP_INVITE_TYPE || !isDocId(i.id) || !isDocId(i.group)) return { ok: false, reason: 'not a group invite' };
  if (!isAgentId(i.from) || !isAgentId(i.to) || i.from === i.to) return { ok: false, reason: 'bad from or to' };
  if (!isText(i.greeting, GROUP_LIMITS.greetingChars)) return { ok: false, reason: 'bad greeting' };
  const ts = parseTimestamp(i.ts);
  const expires = parseTimestamp(i.expires);
  if (ts === null || ts > now.getTime() + GROUP_LIMITS.skewMs) return { ok: false, reason: 'bad ts' };
  if (expires === null || expires <= now.getTime()) return { ok: false, reason: 'invite expired' };
  if (expires > now.getTime() + GROUP_LIMITS.inviteMaxTtlMs + GROUP_LIMITS.skewMs) return { ok: false, reason: 'invite lasts too long' };
  const state = verifyGroupState(i.state, now);
  if (!state.ok) return { ok: false, reason: `invite state: ${state.reason}` };
  if (i.state.group !== i.group) return { ok: false, reason: 'invite state is for another group' };
  if (!isAdmin(i.state, i.from)) return { ok: false, reason: 'the inviter is not an admin of the group' };
  if (memberOf(i.state, i.to)) return { ok: false, reason: 'already a member' };
  if (i.state.members.length >= GROUP_LIMITS.members) return { ok: false, reason: 'the group is full' };
  if (!verifyDoc(i, i.from)) return { ok: false, reason: 'bad signature' };
  return { ok: true, doc: i };
}

const JOIN_KEYS = ['v', 'type', 'id', 'group', 'from', 'to', 'invite_ref', 'state', 'card', 'scope', 'ts', 'sig'];

/** A signed join document (§7.8.2): shape, the joiner's own card, a well-formed group scope, signature by the joiner. */
export function verifyGroupJoin(input: unknown, now = new Date()): GroupCheck<GroupJoin> {
  if (!isPlainObject(input)) return { ok: false, reason: 'not an object' };
  const j = input as unknown as GroupJoin;
  if (!onlyKeys(input, JOIN_KEYS)) return { ok: false, reason: 'unknown field in group join' };
  if (j.v !== 1 || j.type !== GROUP_JOIN_TYPE || !isDocId(j.id) || !isDocId(j.group)) return { ok: false, reason: 'not a group join' };
  if (!isAgentId(j.from) || !isAgentId(j.to)) return { ok: false, reason: 'bad from or to' };
  if (j.invite_ref === null ? j.to !== j.from : !isDocId(j.invite_ref) || j.to === j.from) return { ok: false, reason: 'bad invite_ref' };
  if (!isHex64(j.state)) return { ok: false, reason: 'bad state hash' };
  const ts = parseTimestamp(j.ts);
  if (ts === null || ts > now.getTime() + GROUP_LIMITS.skewMs) return { ok: false, reason: 'bad ts' };
  const scope = groupScopeProblem(j.scope);
  if (scope) return { ok: false, reason: `scope: ${scope}` };
  const card = verifyCard(j.card, now);
  if (!card.ok) return { ok: false, reason: `card: ${card.reason}` };
  if (j.card.id !== j.from) return { ok: false, reason: "the card is not the joiner's" };
  if (byteLength(j) > GROUP_LIMITS.joinBytes) return { ok: false, reason: 'group join too large' };
  if (!verifyDoc(j, j.from)) return { ok: false, reason: 'bad signature' };
  return { ok: true, doc: j };
}

// --- creating documents --------------------------------------------------------------

const uuid = () => crypto.randomUUID();

export function createGroupState(key: AgentKey, body: Omit<GroupStateBody, 'v' | 'type' | 'from' | 'ts'> & { ts?: string }): GroupState {
  const doc = signDoc<GroupStateBody>(
    { v: 1, type: GROUP_STATE_TYPE, group: body.group, epoch: body.epoch, prev: body.prev, from: key.id, members: body.members, policy: body.policy, name: body.name, ts: body.ts ?? new Date().toISOString() },
    key,
  );
  const check = verifyGroupState(doc, new Date(Math.max(Date.now(), parseTimestamp(doc.ts) ?? 0)));
  if (!check.ok) throw new Error(`group state: ${check.reason}`);
  return doc;
}

export function createGroupInvite(key: AgentKey, opts: { state: GroupState; to: string; greeting?: string; expires?: string; now?: Date }): GroupInvite {
  const now = opts.now ?? new Date();
  return signDoc<GroupInviteBody>(
    {
      v: 1,
      type: GROUP_INVITE_TYPE,
      id: uuid(),
      group: opts.state.group,
      from: key.id,
      to: opts.to,
      state: opts.state,
      greeting: opts.greeting ?? '',
      expires: opts.expires ?? new Date(now.getTime() + GROUP_LIMITS.inviteTtlMs).toISOString(),
      ts: now.toISOString(),
    },
    key,
  );
}

export function createGroupJoin(
  key: AgentKey,
  opts: { group: string; to: string; inviteRef: string | null; state: GroupState; card: AddressCard; scope: GroupScope; now?: Date },
): GroupJoin {
  return signDoc<GroupJoinBody>(
    {
      v: 1,
      type: GROUP_JOIN_TYPE,
      id: uuid(),
      group: opts.group,
      from: key.id,
      to: opts.to,
      invite_ref: opts.inviteRef,
      state: docHash(opts.state),
      card: opts.card,
      scope: groupScope(opts.scope),
      ts: (opts.now ?? new Date()).toISOString(),
    },
    key,
  );
}

/**
 * Members' joins in as few `rdv/group-members` payloads as fit under the
 * envelope cap (GROUP_LIMITS.membersPayloadBytes each; a join alone always
 * fits, since it is at most joinBytes).
 */
export function membersPayloads(group: string, joins: GroupJoin[]): GroupMembersPayload[] {
  const out: GroupMembersPayload[] = [];
  let cur: GroupJoin[] = [];
  const size = (js: GroupJoin[]) => byteLength({ type: GROUP_MEMBERS_TYPE, group, joins: js });
  for (const j of joins) {
    if (cur.length && size([...cur, j]) > GROUP_LIMITS.membersPayloadBytes) {
      out.push({ type: GROUP_MEMBERS_TYPE, group, joins: cur });
      cur = [];
    }
    cur.push(j);
  }
  if (cur.length) out.push({ type: GROUP_MEMBERS_TYPE, group, joins: cur });
  return out;
}

// --- the book ------------------------------------------------------------------------

export interface GroupRecord {
  group: string;
  /**
   * `joining`: our join is sent and we wait for the state that lists us
   * (`state` is then the one our human approved). `active`: a member.
   * `removed`: a state without us arrived; kept for display only.
   */
  status: 'joining' | 'active' | 'removed';
  state: GroupState;
  /** The state before `state`: its admins may still send the state that follows it. */
  prevState?: GroupState;
  /** Recent states accepted, oldest first: a different state at a known epoch from the same admin is a fork. */
  history: Array<{ epoch: number; hash: string; from: string }>;
  /** Members' join documents (their cards and group-scoped grants), by member, ours included. */
  joins: Record<string, GroupJoin>;
  /** Members we may send group traffic to: our contacts, approved by policy, or by our human. Never ourselves. */
  approved: string[];
  /** Members waiting for our human under `ask`: they get nothing from us until approved. */
  newcomers: Record<string, { epoch: number; since: string }>;
  policy: NewcomerPolicy;
  /** Our own join's scope: what members may invoke on us through this group. */
  scope: GroupScope;
  /** The admin we joined through (it delivers the state that admits us), and its invite. */
  via?: string;
  invite_ref?: string;
  /** joining: when the invite we answered expired (a record never admitted is dropped some time after). */
  invite_expires?: string;
  joined: string;
  /** States ahead of ours, waiting for the chain to reach them. */
  future: GroupState[];
  /**
   * Two different states at one epoch (§7.8.1, §7.8.6 layer 4), from one
   * admin or from two: membership is frozen until our human re-syncs.
   * `signers` are the admins that signed them.
   */
  frozen?: { epoch: number; hashes: string[]; signers: string[]; since: string };
}

export interface ReceivedInvite {
  invite: GroupInvite;
  received: string;
}

export interface SentInvite {
  group: string;
  to: string;
  /** The name our human gave the invitee in the group (display text in the state). */
  name?: string;
  /** Hash of the state the invite carried: the joiner's approval is bound to it. */
  state: string;
  expires: string;
  sent: string;
}

export interface GroupBookState {
  groups: Record<string, GroupRecord>;
  /** Invites waiting for our human, by invite id. */
  invites: Record<string, ReceivedInvite>;
  /** Invites we sent as admin, waiting for a join, by invite id. */
  sent: Record<string, SentInvite>;
  /** Invite and join ids seen (replay protection). */
  seen: string[];
  /** Invites dropped because the list was full (shown to the human). */
  invitesEvicted?: number;
}

/** What a newly applied state changed for us. */
export interface GroupChange {
  record: GroupRecord;
  added: string[];
  removed: string[];
  /** Members that now wait for our human (policy `ask`, not our contact). */
  newcomers: string[];
  /** This state admitted us (joining → active). */
  admitted: boolean;
  /** The state removed us. */
  left: boolean;
}

export type InviteOutcome =
  | { status: 'pending'; invite: ReceivedInvite; evicted?: string }
  | { status: 'evicted' }
  | { status: 'invalid'; reason: string }
  | { status: 'not-contact' | 'duplicate' | 'member' | 'rate-limited' | 'no-groups' };

export type JoinOutcome =
  | { ok: true; state: GroupState; join: GroupJoin; record: GroupRecord; change: GroupChange }
  | { ok: false; reason: string; code: 'invalid' | 'no-invite' | 'not-admin' | 'full' | 'stale' | 'duplicate' };

export type StateOutcome =
  | { kind: 'applied'; change: GroupChange; also: GroupChange[] }
  | { kind: 'duplicate' }
  | { kind: 'future' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'fork'; record: GroupRecord }
  | { kind: 'invalid'; reason: string };

/** Who may be told what about contacts: `isContact(peer)` is "an active, unblocked contact of ours". */
export interface GroupContext {
  me: string;
  isContact: (peer: string) => boolean;
  now?: Date;
}

const ts = (now: Date) => now.toISOString();

export class GroupBook {
  state: GroupBookState;

  constructor(state?: Partial<GroupBookState>) {
    this.state = { groups: {}, invites: {}, sent: {}, seen: [], ...state };
  }

  toJSON(): GroupBookState {
    return this.state;
  }

  isEmpty(): boolean {
    const s = this.state;
    return !Object.keys(s.groups).length && !Object.keys(s.invites).length && !Object.keys(s.sent).length && !s.seen.length && !s.invitesEvicted;
  }

  group(id: string): GroupRecord | undefined {
    return Object.hasOwn(this.state.groups, id) ? this.state.groups[id] : undefined;
  }

  records(): GroupRecord[] {
    return Object.values(this.state.groups);
  }

  invites(): ReceivedInvite[] {
    return Object.values(this.state.invites);
  }

  /**
   * Peers whose channels we keep for groups (§6.4 admission): every other
   * member of a group we are in (approved or not: under `ask` we still
   * receive a newcomer's group messages), and the admin a join of ours waits
   * on. Bounded by GROUP_LIMITS (groups × members), never by peers.
   */
  admittedPeers(me: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.records()) {
      if (r.status === 'removed') continue;
      if (r.status === 'joining') {
        if (r.via) out.add(r.via);
        continue;
      }
      for (const id of memberIds(r.state)) if (id !== me) out.add(id);
    }
    return out;
  }

  /** The card we reach a co-member on (from its join, pinned by the state), if any. */
  memberCard(peer: string): AddressCard | undefined {
    for (const r of this.records()) {
      if (r.status !== 'active') continue;
      const m = memberOf(r.state, peer);
      const j = Object.hasOwn(r.joins, peer) ? r.joins[peer] : undefined;
      if (m && j && docHash(j.card) === m.card) return j.card;
    }
    return undefined;
  }

  private markSeen(id: string): boolean {
    if (this.state.seen.includes(id)) return false;
    this.state.seen.push(id);
    if (this.state.seen.length > GROUP_LIMITS.seen) this.state.seen.splice(0, this.state.seen.length - GROUP_LIMITS.seen);
    return true;
  }

  private unmarkSeen(id: string): void {
    const i = this.state.seen.lastIndexOf(id);
    if (i >= 0) this.state.seen.splice(i, 1);
  }

  /** Drop what has expired: invites, sent invites, and joining records never admitted (some time after their invite expired). */
  prune(now = new Date()): void {
    for (const [id, i] of Object.entries(this.state.invites)) if (isPast(i.invite.expires, now)) delete this.state.invites[id];
    for (const [id, s] of Object.entries(this.state.sent)) if (isPast(s.expires, now)) delete this.state.sent[id];
    for (const [id, r] of Object.entries(this.state.groups)) {
      if (r.status !== 'joining') continue;
      const ends = parseTimestamp(r.invite_expires);
      if (ends === null || ends + GROUP_LIMITS.joiningGraceMs <= now.getTime()) delete this.state.groups[id];
    }
  }

  /** Groups we are in or joining (removed ones do not count, and are evicted first when we need room). */
  private makeRoom(): boolean {
    const live = this.records().filter((r) => r.status !== 'removed');
    if (live.length >= GROUP_LIMITS.groups) return false;
    const all = this.records();
    if (all.length >= GROUP_LIMITS.groups) {
      const victim = all.filter((r) => r.status === 'removed').sort((a, b) => a.joined.localeCompare(b.joined))[0];
      if (victim) delete this.state.groups[victim.group];
    }
    return true;
  }

  // --- creating and inviting (our own agent, as admin) ---------------------------------

  /** A new group with us as its only member and admin (epoch 0), and our own join (no invite). */
  create(key: AgentKey, card: AddressCard, opts: { name: string; scope?: GroupScope; policy?: NewcomerPolicy; memberRate?: string; now?: Date }): GroupRecord {
    const now = opts.now ?? new Date();
    this.prune(now);
    if (!isText(opts.name, GROUP_LIMITS.nameChars) || opts.name.trim() === '') throw new Error(`a group name is 1 to ${GROUP_LIMITS.nameChars} printable characters`);
    if (!this.makeRoom()) throw new Error(`already in ${GROUP_LIMITS.groups} groups`);
    const memberRate = opts.memberRate ?? DEFAULT_MEMBER_RATE;
    if (!parseFrequency(memberRate)) throw new Error('member_rate must be "<n>/<minute|hour|day>"');
    const group = uuid();
    const state = createGroupState(key, {
      group,
      epoch: 0,
      prev: null,
      members: [{ id: key.id, role: 'admin', card: docHash(card) }],
      policy: { member_rate: memberRate, members_may_invite: false },
      name: opts.name,
      ts: ts(now),
    });
    const scope = groupScope(opts.scope);
    const join = createGroupJoin(key, { group, to: key.id, inviteRef: null, state, card, scope, now });
    const record: GroupRecord = {
      group,
      status: 'active',
      state,
      history: [{ epoch: 0, hash: docHash(state), from: key.id }],
      joins: { [key.id]: join },
      approved: [],
      newcomers: {},
      policy: opts.policy ?? 'ask',
      scope,
      joined: ts(now),
      future: [],
    };
    this.state.groups[group] = record;
    return record;
  }

  /**
   * An invite from us (an admin) to `to`, one of our contacts whose card lists
   * the groups extension (checked by the caller, which knows contacts). Room
   * counts open invites too, so the group can never be promised past 16.
   */
  invite(key: AgentKey, groupId: string, to: string, opts: { greeting?: string; name?: string; expires?: string; now?: Date } = {}): GroupInvite {
    const now = opts.now ?? new Date();
    this.prune(now);
    const r = this.group(groupId);
    if (!r || r.status !== 'active') throw new Error(`not a member of group ${groupId}`);
    if (r.frozen) throw new Error('membership of this group is frozen (a fork was seen); re-sync it first');
    if (!isAdmin(r.state, key.id)) throw new Error('only an admin of the group invites');
    if (to === key.id) throw new Error('cannot invite ourselves');
    if (memberOf(r.state, to)) throw new Error('already a member of the group');
    if (opts.greeting !== undefined && !isText(opts.greeting, GROUP_LIMITS.greetingChars)) throw new Error(`a greeting is at most ${GROUP_LIMITS.greetingChars} printable characters`);
    if (opts.name !== undefined && (!isText(opts.name, GROUP_LIMITS.memberNameChars) || opts.name.trim() === '')) {
      throw new Error(`a member name is 1 to ${GROUP_LIMITS.memberNameChars} printable characters`);
    }
    if (opts.expires !== undefined) {
      const e = parseTimestamp(opts.expires);
      if (e === null || e <= now.getTime() || e > now.getTime() + GROUP_LIMITS.inviteMaxTtlMs) throw new Error('an invite expires within 14 days');
    }
    const open = Object.values(this.state.sent).filter((s) => s.group === groupId);
    if (open.some((s) => s.to === to)) throw new Error('an invite to this contact is already open');
    if (r.state.members.length + open.length >= GROUP_LIMITS.members) throw new Error(`a group has at most ${GROUP_LIMITS.members} members (open invites count)`);
    const invite = createGroupInvite(key, { state: r.state, to, greeting: opts.greeting, expires: opts.expires, now });
    this.state.sent[invite.id] = { group: groupId, to, ...(opts.name !== undefined ? { name: opts.name.trim() } : {}), state: docHash(r.state), expires: invite.expires, sent: ts(now) };
    return invite;
  }

  // --- invites to us ---------------------------------------------------------------------

  /**
   * An invite arrived over the pairwise channel from `from` (§7.8.2). Kept
   * for our human only when it verifies, comes from a current contact that
   * signed it and is an admin of the group, is addressed to us, and we are
   * not already in (or joining) that group. Bounded: 2 per admin (more are
   * refused, a retry later is welcome), 16 in all (the oldest goes).
   */
  receiveInvite(input: unknown, from: string, ctx: GroupContext): InviteOutcome {
    const now = ctx.now ?? new Date();
    this.prune(now);
    const check = verifyGroupInvite(input, now);
    if (!check.ok) return { status: 'invalid', reason: check.reason };
    const inv = check.doc;
    if (inv.from !== from || inv.to !== ctx.me) return { status: 'invalid', reason: 'invite not from its sender, or not for us' };
    if (!ctx.isContact(from)) return { status: 'not-contact' };
    const have = this.group(inv.group);
    if (have && have.status !== 'removed') return { status: 'member' };
    if (!this.markSeen(inv.id)) return { status: 'duplicate' };
    // A newer invite to the same group from the same admin replaces the older one.
    for (const [id, i] of Object.entries(this.state.invites)) if (i.invite.group === inv.group && i.invite.from === from) delete this.state.invites[id];
    const all = this.invites();
    if (all.filter((i) => i.invite.from === from).length >= GROUP_LIMITS.invitesPerAdmin) {
      this.unmarkSeen(inv.id);
      return { status: 'rate-limited' };
    }
    const entry: ReceivedInvite = { invite: inv, received: ts(now) };
    let evicted: string | undefined;
    if (all.length >= GROUP_LIMITS.pendingInvites) {
      const victim = [...all].sort((a, b) => a.received.localeCompare(b.received))[0];
      delete this.state.invites[victim.invite.id];
      this.unmarkSeen(victim.invite.id); // so the admin's retry is accepted
      this.state.invitesEvicted = (this.state.invitesEvicted ?? 0) + 1;
      evicted = victim.invite.id;
    }
    this.state.invites[inv.id] = entry;
    return { status: 'pending', invite: entry, ...(evicted ? { evicted } : {}) };
  }

  /** Our human said no (reduce-only). */
  decline(inviteId: string): ReceivedInvite | undefined {
    const i = Object.hasOwn(this.state.invites, inviteId) ? this.state.invites[inviteId] : undefined;
    delete this.state.invites[inviteId];
    return i;
  }

  /**
   * Our human approved joining (never call it otherwise: §5.5, and
   * auto-approve never covers it, §5.5.1). Makes our join document, a
   * group-scoped grant for `scope`, and a `joining` record holding the state
   * the human saw; the caller sends the join to the inviting admin.
   */
  join(key: AgentKey, card: AddressCard, inviteId: string, opts: { scope?: GroupScope; policy?: NewcomerPolicy; now?: Date } = {}): { join: GroupJoin; record: GroupRecord } {
    const now = opts.now ?? new Date();
    this.prune(now);
    const entry = Object.hasOwn(this.state.invites, inviteId) ? this.state.invites[inviteId] : undefined;
    if (!entry) throw new Error(`no pending group invite ${inviteId}`);
    const inv = entry.invite;
    if (isPast(inv.expires, now)) throw new Error(`group invite ${inviteId} has expired`);
    const policy = opts.policy ?? 'ask';
    if (!NEWCOMER_POLICIES.includes(policy)) throw new Error('newcomer policy is ask or trust-admin');
    const have = this.group(inv.group);
    if (have && have.status !== 'removed') throw new Error('already in or joining this group');
    if (have) delete this.state.groups[inv.group];
    if (!this.makeRoom()) throw new Error(`already in ${GROUP_LIMITS.groups} groups`);
    const scope = groupScope(opts.scope);
    const join = createGroupJoin(key, { group: inv.group, to: inv.from, inviteRef: inv.id, state: inv.state, card, scope, now });
    const record: GroupRecord = {
      group: inv.group,
      status: 'joining',
      state: inv.state,
      history: [{ epoch: inv.state.epoch, hash: docHash(inv.state), from: inv.state.from }],
      joins: { [key.id]: join },
      approved: [],
      newcomers: {},
      policy,
      scope,
      via: inv.from,
      invite_ref: inv.id,
      invite_expires: inv.expires,
      joined: ts(now),
      future: [],
    };
    this.state.groups[inv.group] = record;
    delete this.state.invites[inviteId];
    return { join, record };
  }

  // --- joins to us (as admin) ------------------------------------------------------------------

  /**
   * A join answering one of our invites (§7.8.2). Accepted only from the
   * invitee itself, for an open, unexpired invite of ours, bound to the state
   * that invite carried, while we are still an admin and the group has room.
   * Issues the next state with the joiner in it; the caller fans it out.
   */
  receiveJoin(key: AgentKey, input: unknown, from: string, ctx: GroupContext): JoinOutcome {
    const now = ctx.now ?? new Date();
    this.prune(now);
    const check = verifyGroupJoin(input, now);
    if (!check.ok) return { ok: false, code: 'invalid', reason: check.reason };
    const j = check.doc;
    if (j.from !== from || j.to !== key.id || j.invite_ref === null) return { ok: false, code: 'invalid', reason: 'join not from its sender, or not for us' };
    const sent = Object.hasOwn(this.state.sent, j.invite_ref) ? this.state.sent[j.invite_ref] : undefined;
    if (!sent || sent.to !== from || sent.group !== j.group) return { ok: false, code: 'no-invite', reason: 'no open invite of ours for this join' };
    if (j.state !== sent.state) return { ok: false, code: 'stale', reason: 'the join approves another state than our invite carried' };
    const r = this.group(j.group);
    if (!r || r.status !== 'active' || !isAdmin(r.state, key.id)) return { ok: false, code: 'not-admin', reason: 'we are no longer an admin of the group' };
    if (r.frozen) return { ok: false, code: 'not-admin', reason: 'membership of this group is frozen (a fork was seen)' };
    if (memberOf(r.state, from)) return { ok: false, code: 'duplicate', reason: 'already a member' };
    if (r.state.members.length >= GROUP_LIMITS.members) return { ok: false, code: 'full', reason: 'the group is full' };
    if (!this.markSeen(j.id)) return { ok: false, code: 'duplicate', reason: 'join seen before' };
    const prev = r.state;
    const member: GroupMember = { id: from, role: 'member', card: docHash(j.card), ...(sent.name !== undefined ? { name: sent.name } : {}) };
    const next = createGroupState(key, {
      group: prev.group,
      epoch: prev.epoch + 1,
      prev: docHash(prev),
      members: [...prev.members, member],
      policy: prev.policy,
      name: prev.name,
      ts: ts(now),
    });
    delete this.state.sent[j.invite_ref];
    r.joins[from] = j;
    const change = this.advance(r, next, ctx, now, { prevState: prev, before: prev });
    return { ok: true, state: next, join: j, record: r, change };
  }

  // --- states ----------------------------------------------------------------------------------

  /**
   * A group state from `from`, the admin that signed it (it travels over the
   * signer's own pairwise channel). Applied only on top of the state we hold
   * (§7.8.1). A newer epoch waits for the ones before it (at most 4). Two
   * different states at one epoch are a fork, whoever signed them (one
   * admin restored a backup or lies, or two admins changed the group at
   * once): membership freezes and our human is told (§7.8.6 layer 4).
   * Nothing picks a winner on its own; a hash-based tie-break could be
   * ground by an admin re-signing until its state wins.
   */
  receiveState(input: unknown, from: string, ctx: GroupContext): StateOutcome {
    const now = ctx.now ?? new Date();
    const check = verifyGroupState(input, now);
    if (!check.ok) return { kind: 'invalid', reason: check.reason };
    const s = check.doc;
    if (s.from !== from) return { kind: 'invalid', reason: 'state not from its signer' };
    const r = this.group(s.group);
    if (!r) return { kind: 'ignored', reason: 'not a group we are in' };
    const hash = docHash(s);
    if (r.history.some((h) => h.hash === hash) || r.future.some((f) => docHash(f) === hash)) return { kind: 'duplicate' };
    if (r.status === 'joining') return this.receiveAdmission(r, s, from, ctx, now);
    if (!memberOf(r.state, from) && !(r.prevState && memberOf(r.prevState, from))) return { kind: 'ignored', reason: 'state from a non-member' };
    if (r.status === 'removed') return { kind: 'ignored', reason: 'not a group we are in' };
    // Another state at an epoch we hold or wait for is a fork, but only if it could have been legitimate:
    // a successor of the state before ours, or, ahead of us, signed by an admin of ours. Anything else
    // (a member, or an epoch we cannot check) is ignored, so a non-admin cannot freeze the group.
    const held = r.history.find((h) => h.epoch === s.epoch);
    if (held) {
      if (s.epoch !== r.state.epoch || !r.prevState || successorProblem(r.prevState, s)) return { kind: 'ignored', reason: 'a state at an epoch we hold that we cannot check' };
      return this.fork(r, s, held.hash, now);
    }
    const waiting = r.future.find((f) => f.epoch === s.epoch);
    if (waiting) {
      if (!isAdmin(r.state, s.from)) return { kind: 'ignored', reason: 'a state ahead of ours not signed by an admin' };
      return this.fork(r, s, docHash(waiting), now);
    }
    if (r.frozen) return { kind: 'ignored', reason: 'membership is frozen until our human re-syncs' };
    if (s.epoch < r.state.epoch) return { kind: 'ignored', reason: 'older than the state we hold' };
    if (s.epoch > r.state.epoch + 1) {
      // Only an admin of the state we hold may queue one (one per epoch: a second is a fork, above).
      if (!isAdmin(r.state, s.from)) return { kind: 'ignored', reason: 'a state ahead of ours not signed by an admin' };
      if (!r.future.some((f) => f.epoch === s.epoch)) {
        r.future.push(s);
        r.future.sort((a, b) => a.epoch - b.epoch);
        if (r.future.length > GROUP_LIMITS.futureStates) r.future.splice(GROUP_LIMITS.futureStates);
      }
      return { kind: 'future' };
    }
    const problem = successorProblem(r.state, s);
    if (problem) return { kind: 'invalid', reason: problem };
    const change = this.advance(r, s, ctx, now, { prevState: r.state, before: r.state });
    return { kind: 'applied', change, also: this.drainFuture(r, ctx, now) };
  }

  /**
   * The state that admits us, for a `joining` record: from the admin we
   * joined through, listing us. Either on top of the state our human
   * approved, or, when the group moved on meanwhile, a later state signed
   * by that admin (our contact) as an admin in it: we cannot check the
   * epochs in between, so the chain starts again there.
   */
  private receiveAdmission(r: GroupRecord, s: GroupState, from: string, ctx: GroupContext, now: Date): StateOutcome {
    if (from !== r.via) return { kind: 'ignored', reason: 'not from the admin we joined through' };
    if (!memberOf(s, ctx.me)) return { kind: 'ignored', reason: 'a state that does not list us yet' };
    if (s.epoch <= r.state.epoch) return { kind: 'ignored', reason: 'not newer than the state we approved' };
    const approved = r.state;
    let prevState: GroupState | undefined;
    if (s.epoch === approved.epoch + 1) {
      const problem = successorProblem(approved, s);
      if (problem) return { kind: 'invalid', reason: problem };
      prevState = approved;
    } else {
      if (!isAdmin(s, from)) return { kind: 'invalid', reason: 'the admitting state is not signed by an admin in it' };
      r.history = [];
    }
    r.status = 'active';
    delete r.invite_expires;
    const change = this.advance(r, s, ctx, now, { prevState, before: approved, admitted: true });
    return { kind: 'applied', change, also: this.drainFuture(r, ctx, now) };
  }

  /**
   * Move `r` to `next` and work out who we may send to: a member new to us
   * is approved at once if it is our contact or our policy is `trust-admin`;
   * otherwise it waits for our human (`ask`). Members gone from the state
   * lose their approval and their join. On the state that admits us, every
   * other member is new to us (design B.5: Dana approves John, who is not her
   * contact, after she joined).
   */
  private advance(r: GroupRecord, next: GroupState, ctx: GroupContext, now: Date, opts: { prevState: GroupState | undefined; before: GroupState; admitted?: boolean }): GroupChange {
    const before = new Set(memberIds(opts.before));
    const after = new Set(memberIds(next));
    r.prevState = opts.prevState;
    r.state = next;
    r.history.push({ epoch: next.epoch, hash: docHash(next), from: next.from });
    if (r.history.length > GROUP_LIMITS.history) r.history.splice(0, r.history.length - GROUP_LIMITS.history);
    r.future = r.future.filter((f) => f.epoch > next.epoch);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    const base = { record: r, added, removed, admitted: opts.admitted === true };
    if (!after.has(ctx.me)) {
      // Nothing more goes to anyone in it (admittedPeers skips a removed group).
      r.status = 'removed';
      r.approved = [];
      r.newcomers = {};
      return { ...base, newcomers: [], left: true };
    }
    for (const id of Object.keys(r.joins)) {
      if (id === ctx.me) continue;
      const m = memberOf(next, id);
      // Gone, or listed with another card than the join we hold: that join no longer describes the member.
      if (!m || docHash(r.joins[id].card) !== m.card) delete r.joins[id];
    }
    r.approved = r.approved.filter((id) => after.has(id));
    for (const id of Object.keys(r.newcomers)) if (!after.has(id)) delete r.newcomers[id];
    const fresh = opts.admitted ? [...after].filter((id) => id !== ctx.me) : added.filter((id) => id !== ctx.me);
    const newcomers: string[] = [];
    for (const id of fresh) {
      if (r.approved.includes(id) || Object.hasOwn(r.newcomers, id)) continue;
      if (ctx.isContact(id) || r.policy === 'trust-admin') r.approved.push(id);
      else {
        r.newcomers[id] = { epoch: next.epoch, since: ts(now) };
        newcomers.push(id);
      }
    }
    return { ...base, newcomers, left: false };
  }

  private drainFuture(r: GroupRecord, ctx: GroupContext, now: Date): GroupChange[] {
    const out: GroupChange[] = [];
    for (;;) {
      if (r.status !== 'active' || r.frozen) return out;
      const i = r.future.findIndex((f) => !successorProblem(r.state, f));
      if (i < 0) {
        r.future = r.future.filter((f) => f.epoch > r.state.epoch + 1);
        return out;
      }
      const [s] = r.future.splice(i, 1);
      out.push(this.advance(r, s, ctx, now, { prevState: r.state, before: r.state }));
    }
  }

  private fork(r: GroupRecord, s: GroupState, knownHash: string, now: Date): StateOutcome {
    const hash = docHash(s);
    if (r.frozen && r.frozen.epoch === s.epoch && r.frozen.hashes.includes(hash)) return { kind: 'duplicate' };
    const same = r.frozen?.epoch === s.epoch ? r.frozen : undefined;
    const firstSigner = r.history.find((h) => h.hash === knownHash)?.from ?? r.future.find((f) => docHash(f) === knownHash)?.from;
    r.frozen = {
      epoch: s.epoch,
      hashes: [...new Set([...(same ? same.hashes : [knownHash]), hash])].slice(0, 4),
      signers: [...new Set([...(same ? same.signers : firstSigner ? [firstSigner] : []), s.from])].slice(0, 4),
      since: ts(now),
    };
    r.future = [];
    return { kind: 'fork', record: r };
  }

  /**
   * Our human checked with the admin after a fork (§7.8.6): membership thaws
   * at the state we hold, and later states apply on top of it again. The
   * equivocating admin's other state is not adopted.
   */
  resync(groupId: string): GroupRecord {
    const r = this.group(groupId);
    if (!r) throw new Error(`no group ${groupId}`);
    delete r.frozen;
    return r;
  }

  // --- members' joins ----------------------------------------------------------------------

  /**
   * Members' join documents from an admin of the group (`rdv/group-members`):
   * each kept only if it verifies, is for this group, comes from a member of
   * the state we hold whose card hash it matches. Ours is never replaced.
   * Returns the members whose join we now hold.
   */
  receiveMembers(input: unknown, from: string, ctx: GroupContext): { group: string; stored: string[] } | { rejected: string } {
    const now = ctx.now ?? new Date();
    if (!isPlainObject(input) || input.type !== GROUP_MEMBERS_TYPE || !isDocId(input.group) || !Array.isArray(input.joins)) return { rejected: 'malformed' };
    if (input.joins.length > GROUP_LIMITS.members) return { rejected: 'too many joins' };
    const r = this.group(input.group);
    if (!r || r.status !== 'active') return { rejected: 'not a group we are in' };
    if (!isAdmin(r.state, from)) return { rejected: 'not from an admin of the group' };
    const stored: string[] = [];
    for (const raw of input.joins) {
      const check = verifyGroupJoin(raw, now);
      if (!check.ok) continue;
      const j = check.doc;
      const m = memberOf(r.state, j.from);
      if (j.group !== r.group || !m || j.from === ctx.me || docHash(j.card) !== m.card) continue;
      const had = Object.hasOwn(r.joins, j.from) ? r.joins[j.from] : undefined;
      if (had && docHash(had.card) === m.card && (parseTimestamp(had.ts) ?? 0) >= (parseTimestamp(j.ts) ?? 0)) continue;
      r.joins[j.from] = j;
      stored.push(j.from);
    }
    return { group: r.group, stored };
  }

  /** Our human approved a newcomer under `ask` (never call it otherwise; auto-approve never covers it, §5.5.1). */
  approveNewcomer(groupId: string, member: string): GroupRecord {
    const r = this.group(groupId);
    if (!r || r.status !== 'active') throw new Error(`not a member of group ${groupId}`);
    if (!Object.hasOwn(r.newcomers, member)) throw new Error(`${member} is not waiting for approval in this group`);
    if (!memberOf(r.state, member)) throw new Error(`${member} is not a member of the group`);
    delete r.newcomers[member];
    if (!r.approved.includes(member)) r.approved.push(member);
    return r;
  }

  /** A contact we no longer have (revoked, blocked) loses nothing here: approval in a group is our human's, kept with the group. */
  forgetPeer(peer: string): void {
    for (const [id, i] of Object.entries(this.state.invites)) if (i.invite.from === peer) delete this.state.invites[id];
    for (const [id, s] of Object.entries(this.state.sent)) if (s.to === peer) delete this.state.sent[id];
  }
}
