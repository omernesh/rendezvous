// §5: contact request, grant, revocation, and the local contact book that
// enforces consent, policy, replay protection and grant-scoped rate limits.
import type { AddressCard, InboundPolicy } from './card.js';
import { cardUpdateProblem, verifyCard } from './card.js';
import { BINDING_STRENGTH, type Binding, topicForHint } from './discovery.js';
import type { AgentKey } from './identity.js';
import { fingerprint, isAgentId } from './identity.js';
import { canonicalize, isPast, parseTimestamp } from './encoding.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';
import { INVITE_KEEP_MS, INVITE_TIERS, INVITE_MAX_TTL_MS, INVITES_OPEN_MAX, cleanInviteName, inviteSecretHash, isInviteSecret, newInviteSecret, sameHash } from './invite.js';

export type Tier = 'spouse' | 'family' | 'friend' | 'colleague' | 'business' | 'stranger';
/** The tier enum, closest first. A grant with any other tier is rejected. */
export const TIERS: readonly Tier[] = ['spouse', 'family', 'friend', 'colleague', 'business', 'stranger'];
export const isTier = (t: unknown): t is Tier => typeof t === 'string' && (TIERS as readonly string[]).includes(t);

export interface GrantScope {
  may_initiate?: boolean;
  /** Read as `invoke` holding MEETING_CAPABILITIES (§5.3). Written beside `invoke` until v0.5. */
  may_propose_meetings?: boolean;
  may_access_calendar?: 'none' | 'free_busy' | 'full';
  /** "<n>/<minute|hour|day>" */
  max_frequency?: string;
  /** Capability URIs the grantee may invoke on the grantor, each with its own limits. Deny by default, no wildcard. */
  invoke?: Record<string, InvokeLimits>;
  [extra: string]: unknown;
}

/** Per-capability limits in `scope.invoke` (§5.3). Unknown fields are ignored, like other open scope fields. */
export interface InvokeLimits {
  /** "<n>/<minute|hour|day>", as the grant-wide one. */
  max_frequency?: string;
  /** Tasks for this capability not yet terminal (default 4). */
  max_open?: number;
  [extra: string]: unknown;
}

/** The meeting capabilities: `may_propose_meetings: true` means `invoke` holds both (§5.3, §7.4). */
export const MEETINGS_CAPABILITY = 'https://rendezvous.nesher.co/ext/meetings/v1';
export const MEETING_CANCEL_CAPABILITY = 'https://rendezvous.nesher.co/ext/meeting-cancel/v1';
export const MEETING_CAPABILITIES: readonly string[] = Object.freeze([MEETINGS_CAPABILITY, MEETING_CANCEL_CAPABILITY]);
/** Bounds on `scope.invoke`: keys (as card capabilities, §4.3) and URI length. */
export const INVOKE_MAX = 32;
export const CAPABILITY_URI_MAX = 200;
/** Default `max_open` per capability (§5.3). */
export const DEFAULT_MAX_OPEN = 4;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** A capability URI as `invoke` keys and card capabilities use it: https, at most 200 characters, no wildcard. */
export function isCapabilityUri(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > CAPABILITY_URI_MAX) return false;
  if (!/^https:\/\/[\x21-\x7e]+$/.test(v) || v.includes('*')) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname.length > 0 && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** Why `invoke` is malformed, or null when it is well formed. */
export function invokeProblem(invoke: unknown): string | null {
  if (!isPlainObject(invoke)) return 'scope.invoke must be a JSON object';
  const keys = Object.keys(invoke);
  if (keys.length > INVOKE_MAX) return `scope.invoke may list at most ${INVOKE_MAX} capabilities`;
  for (const k of keys) {
    if (!isCapabilityUri(k)) return `scope.invoke: not a capability URI (https, at most ${CAPABILITY_URI_MAX} characters, no wildcard)`;
    const l = invoke[k];
    if (!isPlainObject(l)) return 'scope.invoke: each capability maps to an object of limits';
    if (l.max_frequency !== undefined && (typeof l.max_frequency !== 'string' || !parseFrequency(l.max_frequency))) {
      return 'scope.invoke: max_frequency must be "<n>/<minute|hour|day>"';
    }
    if (l.max_open !== undefined && !(Number.isSafeInteger(l.max_open) && (l.max_open as number) >= 1)) {
      return 'scope.invoke: max_open must be a positive integer';
    }
  }
  return null;
}

/**
 * Does `scope` let its grantee invoke `capability` (§5.3)? The v0.3 reading
 * rule: `invoke` first, then `may_propose_meetings` for the meeting
 * capabilities. Deny by default: a capability that is not a key of `invoke`
 * is refused, and with no `invoke` only the meeting capabilities can be
 * allowed, by the boolean. When both fields are present and disagree on
 * meetings, the narrower wins (no meetings). A malformed `invoke` allows
 * nothing. Applied as is to stored contacts: nothing is rewritten on disk.
 */
export function scopeAllows(scope: GrantScope | null | undefined, capability: string): boolean {
  if (!isPlainObject(scope)) return false;
  const meeting = MEETING_CAPABILITIES.includes(capability);
  if (scope.invoke === undefined) return meeting && scope.may_propose_meetings === true;
  if (invokeProblem(scope.invoke) !== null || !Object.hasOwn(scope.invoke, capability)) return false;
  return !meeting || scope.may_propose_meetings === undefined || scope.may_propose_meetings === true;
}

/** The limits `scope` sets on `capability`, or null when it is not allowed (scopeAllows). */
export function invokeLimits(scope: GrantScope | null | undefined, capability: string): InvokeLimits | null {
  if (!scopeAllows(scope, capability)) return null;
  const l = scope!.invoke?.[capability];
  return { ...(l ?? {}), max_open: typeof l?.max_open === 'number' ? l.max_open : DEFAULT_MAX_OPEN };
}

/** The capabilities `scope` allows, in a stable order (the migration rule applied). */
export function allowedCapabilities(scope: GrantScope | null | undefined): string[] {
  if (!isPlainObject(scope)) return [];
  const keys = scope.invoke === undefined ? [...MEETING_CAPABILITIES] : isPlainObject(scope.invoke) ? Object.keys(scope.invoke) : [];
  return keys.filter((k) => scopeAllows(scope, k)).sort();
}

/**
 * The `invoke` map a scope stands for, the reading rule applied: what a task
 * engine is given (never the raw field). A malformed `invoke` gives `{}`; a
 * grant without `invoke` gives the meeting URIs when its boolean allows them.
 */
export function effectiveInvoke(scope: GrantScope | null | undefined): Record<string, InvokeLimits> {
  return Object.fromEntries(allowedCapabilities(scope).map((u) => [u, { ...(scope?.invoke?.[u] ?? {}) }]));
}

/**
 * A scope as v0.3 writes it in a grant (§5.3): `invoke` validated and copied,
 * and `may_propose_meetings` written beside it, consistent with it, so an
 * older peer that reads only the boolean reaches the same answer. A scope
 * without `invoke` gets one from the boolean (`true` = the meeting
 * capabilities, nothing else). Throws on a malformed `invoke` or one that
 * disagrees with the boolean: our human's grant must say one thing.
 */
export function grantScope(scope: GrantScope): GrantScope {
  if (!isPlainObject(scope)) throw new Error('scope must be a JSON object');
  const out: GrantScope = { ...scope };
  if (scope.invoke === undefined) {
    const meet = scope.may_propose_meetings === true;
    out.may_propose_meetings = meet;
    out.invoke = meet ? Object.fromEntries(MEETING_CAPABILITIES.map((u) => [u, {}])) : {};
    return out;
  }
  const problem = invokeProblem(scope.invoke);
  if (problem) throw new Error(problem);
  const invoke: Record<string, InvokeLimits> = {};
  for (const [k, l] of Object.entries(scope.invoke)) invoke[k] = { ...l };
  const meet = Object.hasOwn(invoke, MEETINGS_CAPABILITY);
  if (!meet && Object.hasOwn(invoke, MEETING_CANCEL_CAPABILITY)) throw new Error('scope.invoke: meeting-cancel goes with meetings');
  if (scope.may_propose_meetings !== undefined && scope.may_propose_meetings !== meet) {
    throw new Error('scope: may_propose_meetings and scope.invoke disagree on meetings');
  }
  if (meet && !Object.hasOwn(invoke, MEETING_CANCEL_CAPABILITY)) invoke[MEETING_CANCEL_CAPABILITY] = {};
  out.invoke = invoke;
  out.may_propose_meetings = meet;
  return out;
}

export interface ContactRequestBody {
  v: 1;
  type: 'rdv/contact-request';
  id: string;
  from: string;
  to_hint: string;
  card: AddressCard;
  greeting: string;
  capabilities_offered: string[];
  ts: string;
  /**
   * The secret of an invite link the requester's human was given (SPEC
   * §5.2.3, NOTES 101). Optional; base64url of 16 bytes. Only ever sent in
   * an envelope to the inviter, never on a topic. A receiver that does not
   * know invites ignores it (the request is then an ordinary one).
   */
  invite?: string;
}
export type ContactRequest = Signed<ContactRequestBody>;

export interface ContactGrantBody {
  v: 1;
  type: 'rdv/contact-grant';
  id: string;
  from: string;
  to: string;
  request_ref: string;
  tier: Tier;
  scope: GrantScope;
  expires: string | null;
  ts: string;
  /** Grantor's card, so the requester can reach it (SYN-ACK carries the card, §5.2.1). */
  card: AddressCard;
}
export type ContactGrant = Signed<ContactGrantBody>;

/**
 * Reverse grant (NOTES 60): the same `rdv/contact-grant` document, sent to an
 * existing contact when our human grants it rights towards us. It answers no
 * request, so it has `grant_ref` (the grant that founded the contact, which
 * both sides store as `Contact.grantId`) instead of `request_ref`. A document
 * with both fields, or neither, is invalid.
 */
export interface ReverseGrantBody extends Omit<ContactGrantBody, 'request_ref'> {
  grant_ref: string;
}
export type ReverseGrant = Signed<ReverseGrantBody>;

export interface RevokeBody {
  v: 1;
  type: 'rdv/revoke';
  id: string;
  from: string;
  to: string;
  grant_ref: string | null;
  ts: string;
}
export type Revoke = Signed<RevokeBody>;

const uuid = () => crypto.randomUUID();

/** Longest local label kept (an email address is at most 320). */
export const LABEL_MAX = 320;

/**
 * A local label as given by our human: trimmed, 1..LABEL_MAX characters, no
 * control or format characters. Throws otherwise.
 */
export function cleanLabel(label: string): string {
  const l = label.trim();
  if (l.length === 0 || l.length > LABEL_MAX || /[\p{Cc}\p{Cf}]/u.test(l)) throw new Error('a label must be 1 to 320 printable characters');
  return l;
}

/**
 * A name as people type it: Unicode NFKC, trimmed, runs of white space as one
 * space. "Ｒａｎ  Cohen " and "Ran Cohen" are the same name.
 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/**
 * Names (labels and aliases) compare by address (canonical discovery topic)
 * when they are one, else normalized (normalizeName) and case-insensitively.
 */
export function labelKey(label: string): string {
  const n = normalizeName(label);
  return topicForHint(n) ?? n.toLowerCase();
}

/**
 * The name inside a possessive way of naming someone's agent: "Ran's agent",
 * "Ran’s agent", "Ran's", "James' agent", "agent of Ran", "the agent of
 * Ran" all give "Ran" (or "James"). Null when `text` is not such a form.
 * Only our human's own names are then looked up (byLabel): a possessive
 * never reaches a card's addresses or a name a peer chose.
 */
export function possessiveName(text: string): string | null {
  const n = normalizeName(text);
  const m =
    /^(?:the )?agent of (.+)$/iu.exec(n) ??
    /^(.+?)['\u2019]s(?: agent)?$/iu.exec(n) ??
    /^(.+s)['\u2019](?: agent)?$/iu.exec(n);
  const inner = m?.[1]?.trim();
  return inner ? inner : null;
}

/** Most aliases (nicknames) one contact may have besides its label, and the longest one. */
export const ALIASES_MAX = 8;
export const ALIAS_MAX = 64;

/**
 * An alias (nickname) as our human typed it: validated like a label
 * (cleanLabel), at most ALIAS_MAX characters, normalized (normalizeName), and
 * never an agent ID (which always means itself). Throws otherwise.
 */
export function cleanAlias(alias: string): string {
  if (typeof alias !== 'string') throw new Error(`a nickname must be 1 to ${ALIAS_MAX} printable characters`);
  const a = normalizeName(alias);
  // Characters are code points (SPEC §4.3), not UTF-16 units: 64 emoji are 64 characters.
  const n = [...a].length;
  if (n === 0 || n > ALIAS_MAX || /[\p{Cc}\p{Cf}]/u.test(a)) throw new Error(`a nickname must be 1 to ${ALIAS_MAX} printable characters`);
  if (isAgentId(a)) throw new Error('a nickname cannot be an agent ID');
  return a;
}

/**
 * The keys a name can be reached by: its own (labelKey) and, when it is a
 * possessive ("Ran's agent"), its inner name's. Two names whose keys meet can
 * be reached by one query (byLabel), so they clash.
 */
export function nameKeys(name: string): string[] {
  const inner = possessiveName(name);
  return inner === null ? [labelKey(name)] : [...new Set([labelKey(name), labelKey(inner)])];
}

const keysMeet = (a: string, b: string): boolean => {
  const kb = nameKeys(b);
  return nameKeys(a).some((k) => kb.includes(k));
};

/** Every name our human gave a contact: its label, then its aliases. */
export function contactNames(c: Pick<Contact, 'label' | 'aliases'>): string[] {
  return [...(typeof c.label === 'string' ? [c.label] : []), ...(Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === 'string') : [])];
}

export function createContactRequest(
  key: AgentKey,
  card: AddressCard,
  opts: { toHint: string; greeting: string; capabilities?: string[]; now?: Date; invite?: string },
): ContactRequest {
  if (opts.invite !== undefined && !isInviteSecret(opts.invite)) throw new Error('not an invite secret');
  return signDoc<ContactRequestBody>(
    {
      v: 1,
      type: 'rdv/contact-request',
      id: uuid(),
      from: key.id,
      to_hint: opts.toHint,
      card,
      greeting: opts.greeting,
      capabilities_offered: opts.capabilities ?? ['a2a/0.3'],
      ts: (opts.now ?? new Date()).toISOString(),
      ...(opts.invite !== undefined ? { invite: opts.invite } : {}),
    },
    key,
  );
}

export function createGrant(
  key: AgentKey,
  card: AddressCard,
  request: ContactRequestBody,
  opts: { tier: Tier; scope: GrantScope; expires?: string | null; now?: Date },
): ContactGrant {
  return signDoc<ContactGrantBody>(
    {
      v: 1,
      type: 'rdv/contact-grant',
      id: uuid(),
      from: key.id,
      to: request.from,
      request_ref: request.id,
      tier: opts.tier,
      scope: opts.scope,
      expires: opts.expires ?? null,
      ts: (opts.now ?? new Date()).toISOString(),
      card,
    },
    key,
  );
}

/** Our human granted `contact.peer` rights towards us: tell the peer, so it knows what it may do (NOTES 60). */
export function createReverseGrant(
  key: AgentKey,
  card: AddressCard,
  contact: Pick<Contact, 'peer' | 'grantId'>,
  opts: { tier: Tier; scope: GrantScope; expires?: string | null; now?: Date },
): ReverseGrant {
  return signDoc<ReverseGrantBody>(
    {
      v: 1,
      type: 'rdv/contact-grant',
      id: uuid(),
      from: key.id,
      to: contact.peer,
      grant_ref: contact.grantId,
      tier: opts.tier,
      scope: opts.scope,
      expires: opts.expires ?? null,
      ts: (opts.now ?? new Date()).toISOString(),
      card,
    },
    key,
  );
}

export function createRevoke(key: AgentKey, peer: string, grantRef: string | null, now = new Date()): Revoke {
  return signDoc<RevokeBody>(
    { v: 1, type: 'rdv/revoke', id: uuid(), from: key.id, to: peer, grant_ref: grantRef, ts: now.toISOString() },
    key,
  );
}

/** Document IDs are UUIDs (crypto.randomUUID). Anything else is rejected, so peer IDs are safe to print. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDocId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id);

export function verifyContactRequest(input: unknown, now = new Date()): input is ContactRequest {
  const r = input as ContactRequest;
  if (!r || r.v !== 1 || r.type !== 'rdv/contact-request' || !isDocId(r.id) || parseTimestamp(r.ts) === null) return false;
  // Optional, but well formed when present (NOTES 101).
  if (Object.hasOwn(r, 'invite') && !isInviteSecret(r.invite)) return false;
  if (!isAgentId(r.from) || !verifyDoc(r, r.from)) return false;
  const card = verifyCard(r.card, now);
  return card.ok && card.card.id === r.from;
}

/** Checks shared by forward and reverse grants: shape, tier, scope, dates, signature, and the grantor's card. */
function verifyGrantDoc(g: ContactGrant | ReverseGrant, now: Date): boolean {
  if (g.v !== 1 || g.type !== 'rdv/contact-grant' || !isDocId(g.id)) return false;
  if (!isTier(g.tier) || !g.scope || typeof g.scope !== 'object' || Array.isArray(g.scope)) return false;
  // `invoke` is optional (older peers never send it); when present it must be well formed (§5.3).
  if (g.scope.invoke !== undefined && invokeProblem(g.scope.invoke) !== null) return false;
  if (parseTimestamp(g.ts) === null || (g.expires !== null && parseTimestamp(g.expires) === null)) return false;
  if (!isAgentId(g.from) || !isAgentId(g.to) || !verifyDoc(g, g.from)) return false;
  const card = verifyCard(g.card, now);
  return card.ok && card.card.id === g.from;
}

/** A forward grant: answers one of our requests (`request_ref`) and never carries `grant_ref`. */
export function verifyGrant(input: unknown, now = new Date()): input is ContactGrant {
  const g = input as ContactGrant;
  if (!g || typeof g !== 'object' || Object.hasOwn(g, 'grant_ref') || !isDocId(g.request_ref)) return false;
  return verifyGrantDoc(g, now);
}

/** A grant document that claims to be a reverse grant (it has `grant_ref`). Says nothing about validity. */
export const isReverseGrant = (doc: unknown): boolean => !!doc && typeof doc === 'object' && Object.hasOwn(doc, 'grant_ref');

/** A reverse grant: refers to an existing relationship (`grant_ref`) and never carries `request_ref`. */
export function verifyReverseGrant(input: unknown, now = new Date()): input is ReverseGrant {
  const g = input as ReverseGrant;
  if (!g || typeof g !== 'object' || Object.hasOwn(g, 'request_ref') || !isDocId(g.grant_ref)) return false;
  return verifyGrantDoc(g, now);
}

export function verifyRevoke(input: unknown): input is Revoke {
  const r = input as Revoke;
  return (
    !!r && r.v === 1 && r.type === 'rdv/revoke' && isDocId(r.id) && isAgentId(r.from) && parseTimestamp(r.ts) !== null && verifyDoc(r, r.from)
  );
}

// ---------------------------------------------------------------------------

/**
 * What a peer may do towards us before our own human has granted anything
 * (§5.3): it may write to us, slowly, but not drive meetings or see the
 * calendar. A grant we *receive* never widens this; only our human does.
 */
export const DEFAULT_INBOUND_SCOPE: Readonly<GrantScope> = Object.freeze({
  may_initiate: true,
  may_propose_meetings: false,
  may_access_calendar: 'none',
  max_frequency: '50/day',
  invoke: Object.freeze({}) as Record<string, InvokeLimits>,
});

/** The same scope, compared canonically (an unencodable one is never the same). */
function sameScope(a: GrantScope | null, b: GrantScope): boolean {
  try {
    return a !== null && canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

/** A Contact.grantStamp: 128 random bits, lowercase hex. */
const newStamp = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A fresh, mutable copy of DEFAULT_INBOUND_SCOPE. */
const defaultInbound = (): GrantScope => ({ ...DEFAULT_INBOUND_SCOPE, invoke: {} });

export interface Contact {
  peer: string;
  card: AddressCard;
  /** Our tier for the peer. `stranger` until our human grants (a received grant does not set it). */
  tier: Tier;
  /** What the peer may do towards us: our own grant, or DEFAULT_INBOUND_SCOPE until our human grants. */
  inboundScope: GrantScope | null;
  /** True once our human granted the peer (issued grant or allowInbound); false while inbound is the local default. */
  inboundGranted?: boolean;
  /** What we may do towards the peer: the grant we received, or the peer's latest reverse grant (NOTES 60). */
  outboundScope: GrantScope | null;
  /** The tier the peer's grant put us in (display only). */
  grantedTier?: Tier;
  /** `ts` of the peer's grant behind `outboundScope`; a reverse grant that is not newer is stale. */
  outboundTs?: string;
  /** Id of the last reverse grant from the peer that we applied. */
  reverseGrantId?: string;
  /**
   * Local only, never sent: what our own human called this peer when they
   * asked for or approved the contact (the address they looked up, probed or
   * typed). Unlike the addresses in the peer's card, which the peer chose,
   * this is the only name that may resolve "tell John" to a contact.
   */
  label?: string;
  /**
   * Local only, never sent: other names our own human gave this peer
   * (nicknames such as "Ran" or "joe"), at most ALIASES_MAX, each unique
   * across contacts (addAlias). They resolve "tell Ran" like the label.
   * Absent in state saved before nicknames: none.
   */
  aliases?: string[];
  binding: Binding;
  grantId: string;
  expires: string | null;
  since: string;
  /**
   * Local only, never sent: a fresh random value (32 hex) each time our
   * human's own grant (`allowInbound`) changes what the peer may do towards
   * us under this founding grant (absent: never). `grantId` and `since` stay
   * the same across such a change, so standing approvals bound to the grant
   * also bind to this, and an older copy bound to an earlier change no longer
   * matches (issue #94). Random rather than a counter, so a timeline lost to
   * a restore from backup never repeats a value.
   */
  grantStamp?: string;
}

export interface PendingRequest {
  request: ContactRequest;
  binding: Binding;
  received: string;
  /**
   * Recorded at receipt, never taken from the request: it came in an
   * envelope addressed to our key with `to_hint` = our own id (someone held
   * our card), rather than from a public discovery topic.
   */
  direct?: boolean;
}

/**
 * A grant that answered one of our topic probes. Anyone who saw the probe can
 * answer it, so it is parked here until our human picks the right grantor
 * (§5.3). Its card claims the probed address; that claim alone proves nothing.
 */
export interface GrantCandidate {
  grant: ContactGrant;
  request_ref: string;
  to_hint: string;
  received: string;
}

export interface OutstandingRequest {
  to_hint: string;
  sent: string;
  binding?: Binding;
  to?: string;
  /** Topic probes: answers refused because the probe already had CANDIDATES_PER_PROBE of them (a flood). */
  dropped?: number;
  /** Our human's name for the target (Contact.label), carried to the contact the grant creates. */
  label?: string;
  /** `created` of our card the request carried: the card a grantor holds (Agent `cardSent`, NOTES 82). */
  card_created?: string;
}

/** A probe got more answers than we keep: someone may be flooding it. */
export interface ProbeOverflow {
  request_ref: string;
  to_hint: string;
  dropped: number;
}

export type RequestOutcome =
  | { status: 'pending'; pending: PendingRequest; evicted?: { id: string; total: number } }
  /** The pending list was full of stronger requests: this one was not kept (retrying later is accepted). */
  | { status: 'evicted'; evicted: string; total: number }
  | { status: 'auto-grant'; tier: Tier; scope: GrantScope; invite?: InviteRecord; label?: string }
  | { status: 'blocked' | 'duplicate' | 'invalid' | 'already-contact' | 'rate-limited' };

/**
 * What our human chose for an invite on its approval form (NOTES 112): the
 * contact that redeems it goes on their standing approval for `covers`, under
 * the owner record `owner` as it was then. Local only, never in the link or on
 * the wire, and core does nothing with it but keep it while the invite is open:
 * the host applies it at `invite-redeemed`, and every other end drops it.
 */
export interface InviteStanding {
  covers: string[];
  owner: string;
}

/**
 * An invite link our human made (SPEC §5.2.3, NOTES 101): their consent, in
 * advance, to whoever redeems it first, on these terms. Only a hash of the
 * secret is kept; the link itself is shown once, when it is made.
 */
export interface InviteRecord {
  /** Local handle (16 hex), for list and revoke. Not in the link. */
  id: string;
  /** inviteSecretHash of the secret. */
  hash: string;
  created: string;
  expires: string;
  /** What the redeemer gets, as our human chose it. */
  tier: Tier;
  scope: GrantScope;
  /** The display name the link carries (our human's own words). */
  name?: string;
  /** Our human's name for the person they invite: the contact's local label. */
  label?: string;
  /** Set once redeemed: single use. */
  used?: { at: string; by: string; request: string };
  /** Set when it was revoked. */
  revoked?: string;
  /**
   * Who revoked it: our human (`owner`, also when absent), a restore from a
   * backup (`restore`: an invite in a backup may have been used since), or
   * the agent itself because its secret was seen in the clear (`exposed`).
   */
  revokedBy?: 'owner' | 'restore' | 'exposed';
  /** Only while the invite is open; gone once it was used, revoked or expired. */
  standing?: InviteStanding;
}

/** An invite as `listInvites` shows it: never the hash. */
export type InviteView = Omit<InviteRecord, 'hash'> & { status: 'open' | 'used' | 'revoked' | 'expired' };

export function inviteStatus(r: Pick<InviteRecord, 'used' | 'revoked' | 'expires'>, now = new Date()): InviteView['status'] {
  if (r.used) return 'used';
  if (r.revoked) return 'revoked';
  return isPast(r.expires, now) ? 'expired' : 'open';
}

const inviteView = (r: InviteRecord, now: Date): InviteView => {
  const { hash: _hash, ...rest } = r;
  return { ...rest, status: inviteStatus(r, now) };
};

export interface ContactBookState {
  policy: InboundPolicy;
  contacts: Record<string, Contact>;
  pending: Record<string, PendingRequest>;
  /**
   * Outbound requests awaiting a grant: request id -> target hint, how we found
   * the peer, and (for requests sent to a known card) the only agent whose
   * grant we will accept.
   */
  outstanding: Record<string, OutstandingRequest>;
  /** Grants answering our topic probes, by grant id, awaiting our human (confirmCandidate). */
  candidates: Record<string, GrantCandidate>;
  blocked: string[];
  allowlist: Record<string, { tier: Tier; scope: GrantScope }>;
  seenIds: string[];
  /**
   * Request ids our human declined. Kept apart from `seenIds`, which a flood
   * of fresh ids can evict, so a declined request can't come back on replay.
   */
  declined: string[];
  /** Pending requests dropped because the list was full (shown to the human: someone may be flooding us). */
  pendingEvicted?: number;
  rate: Record<string, number[]>;
  /**
   * Per-capability task counters, by contact (§5.3, issue #28): created only
   * for a current contact whose grant allows the capability, so a stranger's
   * flood never adds a key. Absent in state saved before v0.3.
   */
  taskRate?: Record<string, TaskRateState>;
  /** Invite links our human made, by id (NOTES 101). Absent in state saved before them. */
  invites?: Record<string, InviteRecord>;
}

/** One contact's per-capability task counters (epoch ms, oldest first). */
export interface TaskRateState {
  /** Tasks admitted, per capability, within that capability's `max_frequency` window. */
  admitted: Record<string, number[]>;
  /** Tasks rejected for a per-capability limit, per capability, within 24 hours (at most TASK_RATE.rejectedKept). */
  rejected: Record<string, number[]>;
  /** Every such rejection since the contact's counters began (shown to the human). */
  total: number;
}

/** Gross-abuse thresholds for per-capability limits (§5.3, owner decision C.6 4). */
export const TASK_RATE = Object.freeze({
  /** (b) one capability: revoke when its rejections in its window exceed this times its `max_frequency` count. */
  abuseFactor: 3,
  /** (b) all capabilities: revoke when rejections in `dayMs` exceed this. */
  dailyRejections: 50,
  dayMs: 86_400_000,
  /** Rejection timestamps kept per capability: one past the daily threshold, which fires first beyond it. */
  rejectedKept: 51,
});

/** Which per-capability limit refused a task. `clock`: our own clock is unreadable, so nothing is admitted or counted. */
export type TaskLimit = 'max_open' | 'max_frequency' | 'clock';

/** The gross-abuse trigger (b) that revoked a grant. */
export interface TaskAbuse {
  peer: string;
  capability: string;
  /** `capability`: more than abuseFactor × limit in that capability's window; `daily`: more than dailyRejections in 24 h. */
  trigger: 'capability' | 'daily';
  /** Rejections counted in the trigger's window, this one included. */
  rejected: number;
  /** The threshold it went over. */
  threshold: number;
  windowMs: number;
}

/**
 * The answer to `admitTask`. `scope` is never counted (no contact, or the
 * grant does not allow the capability); `rate` is a per-capability limit,
 * counted towards gross abuse unless `limit` is `clock`.
 */
export type TaskAdmission =
  | { ok: true }
  | { ok: false; code: 'scope'; reason: string }
  | { ok: false; code: 'rate'; limit: TaskLimit; reason: string; abuse?: TaskAbuse };

/**
 * A stored timestamp list as of `now`, oldest first, within `windowMs`. An
 * entry that is not a finite number or lies ahead of `now` (a clock that went
 * back, a hand-edited file) is read as `now`: it still counts, for one
 * window, instead of vanishing (NaN compares false) or never expiring.
 */
function within(list: unknown, windowMs: number, now: number): number[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === 'number' && Number.isFinite(t) && t <= now ? t : now))
    .filter((t) => t > now - windowMs)
    .sort((a, b) => a - b);
}

/** Eviction order for a full pending list: smaller goes first. */
function pendingRank(p: PendingRequest): [number, number, string] {
  // Recorded at receipt (receiveRequest `arrival`), not read from the sender-chosen to_hint.
  return [BINDING_STRENGTH[p.binding] ?? 0, p.direct === true ? 1 : 0, p.received];
}

function rankLess(a: [number, number, string], b: [number, number, string]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}

const SEEN_LIMIT = 5000;
const CLAIMED_TIER_CAP: Tier = 'stranger';
/** Pending inbound requests kept: in total (oldest evicted) and per sender (newer ones refused). */
export const PENDING_LIMIT = 64;
export const PENDING_PER_SENDER = 4;
const DECLINED_LIMIT = 1000;
/**
 * Probe answers kept per probe, one per distinct grantor. There is no global
 * cap that could let one probe's flood evict another probe's answers: the
 * total is bounded by this times the probes our owner has open. Grantor keys
 * are free, so a flood can still fill one probe; the overflow is counted and
 * shown to the human, who should redo that contact by card or in person.
 */
export const CANDIDATES_PER_PROBE = 16;
/** How far ahead of our clock a reverse grant's `ts` may be, so a peer can't make later updates look stale. */
export const REVERSE_GRANT_SKEW_MS = 5 * 60_000;
/** How far ahead of our clock a card update's `created` may be (a burst of re-signs runs a few seconds ahead). */
export const CARD_UPDATE_SKEW_MS = 10 * 60_000;

export class ContactBook {
  state: ContactBookState;

  constructor(state?: Partial<ContactBookState>) {
    this.state = {
      policy: 'prompt',
      contacts: {},
      pending: {},
      outstanding: {},
      candidates: {},
      blocked: [],
      allowlist: {},
      seenIds: [],
      declined: [],
      rate: {},
      ...state,
    };
  }

  /** Agent IDs we have sent a still-outstanding request to (by card). */
  outstandingTargets(): Set<string> {
    const out = new Set<string>();
    for (const o of Object.values(this.state.outstanding)) if (o.to) out.add(o.to);
    return out;
  }

  toJSON(): ContactBookState {
    return this.state;
  }

  /** Records an id; returns false if it was already seen (replay). */
  markSeen(id: string): boolean {
    if (this.state.seenIds.includes(id)) return false;
    this.state.seenIds.push(id);
    if (this.state.seenIds.length > SEEN_LIMIT) this.state.seenIds.splice(0, this.state.seenIds.length - SEEN_LIMIT);
    return true;
  }

  /**
   * May `peer` invoke `capability` on us (`inbound`, the scope our human
   * granted), or may we invoke it on `peer` (`outbound`, the peer's grant)?
   * The migration rule of scopeAllows; false for no active contact.
   */
  mayInvoke(peer: string, capability: string, direction: 'inbound' | 'outbound' = 'inbound', now = new Date()): boolean {
    const c = this.contact(peer, now);
    if (!c || this.isBlocked(peer)) return false;
    return scopeAllows(direction === 'inbound' ? c.inboundScope : c.outboundScope, capability);
  }

  isBlocked(peer: string): boolean {
    return this.state.blocked.includes(peer);
  }

  contact(peer: string, now = new Date()): Contact | undefined {
    const c = this.state.contacts[peer];
    if (!c) return undefined;
    if (isPast(c.expires, now)) return undefined;
    return c;
  }

  /**
   * Remember an outbound request. `to` is the target agent ID when the request
   * went to a specific card; omit it for a topic probe (anyone may answer, and
   * the binding is then always `claimed`).
   */
  trackOutstanding(req: ContactRequestBody, binding: Binding = 'claimed', to?: string, label?: string): void {
    // A probe is labeled with the address our human probed, unless they named the peer otherwise.
    const l = label !== undefined ? this.freeLabel(label, to) : to ? undefined : req.to_hint;
    const card = typeof req.card?.created === 'string' ? { card_created: req.card.created } : {};
    this.state.outstanding[req.id] = to
      ? { to_hint: req.to_hint, sent: req.ts, binding, to, ...(l ? { label: l } : {}), ...card }
      : { to_hint: req.to_hint, sent: req.ts, binding: 'claimed', ...(l ? { label: l } : {}), ...card };
  }

  /**
   * The contacts our human named `name`: by label or alias (labelKey), and
   * also by the name inside a possessive ("Ran's agent", "agent of Ran":
   * possessiveName). More than one means the name is ambiguous. Only our
   * human's own names count, never a card's addresses or a peer's name.
   */
  byLabel(name: string, now = new Date()): Contact[] {
    const keys = new Set([labelKey(name)]);
    const inner = possessiveName(name);
    if (inner !== null) keys.add(labelKey(inner));
    return Object.values(this.state.contacts).filter((c) => !isPast(c.expires, now) && contactNames(c).some((n) => keys.has(labelKey(n))));
  }

  /** Active contacts that hold exactly this name (label or alias, by labelKey; no possessive reading). */
  holdersOf(name: string, now = new Date()): Contact[] {
    const key = labelKey(name);
    return Object.values(this.state.contacts).filter((c) => !isPast(c.expires, now) && contactNames(c).some((n) => labelKey(n) === key));
  }

  /**
   * Our human gives a contact a nickname (local only). Refused when it is
   * not a valid name (cleanAlias), the contact already has it (as its label
   * or an alias), it has ALIASES_MAX already, or another active contact has
   * this name: a nickname picks exactly one recipient.
   */
  addAlias(peer: string, alias: string, now = new Date()): Contact {
    const c = this.state.contacts[peer];
    if (!c) throw new Error(`no contact ${peer}`);
    const a = cleanAlias(alias);
    const key = labelKey(a);
    if (contactNames(c).some((n) => labelKey(n) === key)) throw new Error(`this contact is already called "${a}"`);
    // Also through a possessive: "Ran's agent" here and "Ran" there would both answer "Ran's agent".
    const other = this.nameClash(a, peer, 'names', now);
    if (other) {
      throw new Error(`"${a}" is already the name of another contact (fingerprint ${fingerprint(other.peer)}): a name belongs to one contact only. Remove it there first, or pick another name`);
    }
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    if (aliases.length >= ALIASES_MAX) throw new Error(`this contact already has ${ALIASES_MAX} nicknames, the most it may have: remove one first`);
    c.aliases = [...aliases, a];
    return c;
  }

  /** Our human takes a nickname off a contact (by labelKey). Refused when the contact does not have it. */
  removeAlias(peer: string, alias: string): Contact {
    const c = this.state.contacts[peer];
    if (!c) throw new Error(`no contact ${peer}`);
    const key = labelKey(alias);
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    const next = aliases.filter((n) => labelKey(n) !== key);
    if (next.length === aliases.length) throw new Error(`this contact has no nickname "${normalizeName(alias)}"`);
    if (next.length) c.aliases = next;
    else delete c.aliases;
    return c;
  }

  /**
   * Another active contact one of whose names (`which`: every name, or only
   * its aliases) a query for `name` could also reach (nameKeys), else undefined.
   */
  nameClash(name: string, except: string, which: 'names' | 'aliases' = 'names', now = new Date()): Contact | undefined {
    return Object.values(this.state.contacts).find(
      (c) => c.peer !== except && !isPast(c.expires, now) && (which === 'names' ? contactNames(c) : contactNames({ aliases: c.aliases })).some((n) => keysMeet(n, name)),
    );
  }

  /**
   * A label our human gives (a request, a grant, a probe answer, an invite;
   * re-review L4), cleaned: refused when another contact's nickname already
   * reaches it, so it never shadows one. A label that comes by default (the
   * probed address) is kept as is: when it is alike another contact's name,
   * rdv_status flags it and sending by it is refused as ambiguous.
   */
  freeLabel(label: string, peer: string | undefined, now = new Date()): string {
    const l = cleanLabel(label);
    const other = this.nameClash(l, peer ?? '', 'aliases', now);
    if (other) throw new Error(`"${l}" is already a nickname of another contact (fingerprint ${fingerprint(other.peer)}): pick another label, or remove the nickname there first`);
    return l;
  }

  /**
   * Our human names a contact (local only). A label another contact's
   * nickname already reaches is refused (a nickname is one contact's only);
   * two labels may still be alike (a probe labels with the probed address),
   * which callers refuse when the name is used.
   */
  setLabel(peer: string, label: string): Contact {
    const c = this.state.contacts[peer];
    if (!c) throw new Error(`no contact ${peer}`);
    const l = cleanLabel(label);
    const other = this.nameClash(l, peer, 'aliases');
    if (other) throw new Error(`"${l}" is already a nickname of another contact (fingerprint ${fingerprint(other.peer)}): remove it there first, or pick another name`);
    c.label = l;
    return c;
  }

  /** Inbound contact request: verify, dedupe, apply policy (§5.4). */
  /**
   * `arrival` says how the request reached us (the caller knows; the request
   * can't vouch for itself). Only `via: 'envelope'` with `to_hint` equal to
   * `me` counts as direct, which ranks it above topic probes when the
   * pending list is full.
   */
  receiveRequest(input: unknown, binding: Binding, now = new Date(), arrival?: { via: 'envelope' | 'topic'; me: string }): RequestOutcome {
    if (!verifyContactRequest(input, now)) return { status: 'invalid' };
    const req = input;
    if (this.state.declined.includes(req.id) || !this.markSeen(req.id)) return { status: 'duplicate' };
    if (this.isBlocked(req.from) || this.state.policy === 'block') return { status: 'blocked' };
    if (this.contact(req.from, now)) return { status: 'already-contact' };
    // An invite our human made is their consent in advance (NOTES 101): only in an envelope (a topic is public),
    // only an open one, once. Anything else is an ordinary request from here on: no answer tells a wrong secret apart.
    const invite = arrival?.via === 'envelope' && req.invite !== undefined ? this.redeemInvite(req.invite, req, now) : undefined;
    if (invite) return { status: 'auto-grant', tier: invite.tier, scope: invite.scope, invite, ...(invite.label ? { label: invite.label } : {}) };
    const allowed = this.state.allowlist[req.from];
    if (allowed) return { status: 'auto-grant', ...allowed };
    if (this.state.policy === 'allow') return { status: 'blocked' }; // allow = allowlist only
    // Bounded: keys cost an attacker nothing, so the overall cap is what holds.
    const all = Object.values(this.state.pending);
    if (all.filter((p) => p.request.from === req.from).length >= PENDING_PER_SENDER) {
      this.unmarkSeen(req.id); // a later retry from this sender is welcome
      return { status: 'rate-limited' };
    }
    const direct = arrival?.via === 'envelope' && req.to_hint === arrival.me;
    const pending: PendingRequest = { request: req, binding, received: now.toISOString(), ...(direct ? { direct: true } : {}) };
    if (all.length >= PENDING_LIMIT) {
      // Evict the weakest: lowest binding, then topic probes before requests
      // sent to our card, then the oldest. The newcomer competes too.
      const victim = [...all, pending].reduce((a, b) => (rankLess(pendingRank(b), pendingRank(a)) ? b : a));
      this.state.pendingEvicted = (this.state.pendingEvicted ?? 0) + 1;
      this.unmarkSeen(victim.request.id); // so the requester's retry is accepted
      if (victim === pending) return { status: 'evicted', evicted: req.id, total: this.state.pendingEvicted };
      delete this.state.pending[victim.request.id];
      this.state.pending[req.id] = pending;
      return { status: 'pending', pending, evicted: { id: victim.request.id, total: this.state.pendingEvicted } };
    }
    this.state.pending[req.id] = pending;
    return { status: 'pending', pending };
  }

  /**
   * Our human makes an invite link: what whoever redeems it first gets
   * (tier, scope), until when, the display name the link carries and their
   * own label for the person. Returns the record and the secret; the secret
   * is not stored (only its hash), so the link can only be shown now.
   */
  addInvite(
    opts: { tier: Tier; scope: GrantScope; expires: string; name?: string; label?: string; standing?: InviteStanding },
    now = new Date(),
  ): { record: InviteRecord; secret: string } {
    if (!isTier(opts.tier)) throw new Error(`unknown tier ${String(opts.tier)}`);
    if (!(INVITE_TIERS as readonly string[]).includes(opts.tier)) throw new Error(`an invite can give tiers ${INVITE_TIERS.join(', ')}; grant "${opts.tier}" to the contact afterwards`);
    const scope = grantScope(opts.scope); // throws on a malformed invoke
    if (opts.label !== undefined) this.freeLabel(opts.label, undefined, now);
    const exp = parseTimestamp(opts.expires);
    if (exp === null || exp <= now.getTime()) throw new Error('an invite must expire in the future');
    if (exp > now.getTime() + INVITE_MAX_TTL_MS + 60_000) throw new Error('an invite may last at most 30 days');
    this.pruneInvites(now);
    const invites = (this.state.invites ??= {});
    if (Object.values(invites).filter((r) => inviteStatus(r, now) === 'open').length >= INVITES_OPEN_MAX) {
      throw new Error(`there are already ${INVITES_OPEN_MAX} open invites: revoke some first`);
    }
    const secret = newInviteSecret();
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
    const record: InviteRecord = {
      id,
      hash: inviteSecretHash(secret),
      created: now.toISOString(),
      expires: new Date(exp).toISOString(),
      tier: opts.tier,
      scope,
      ...(opts.name !== undefined ? { name: cleanInviteName(opts.name) } : {}),
      ...(opts.label !== undefined ? { label: cleanLabel(opts.label) } : {}),
      ...(opts.standing ? { standing: { covers: [...opts.standing.covers], owner: opts.standing.owner } } : {}),
    };
    invites[id] = record;
    return { record, secret };
  }

  /** Our invites, newest first, without their hashes. */
  listInvites(now = new Date()): InviteView[] {
    this.pruneInvites(now);
    return Object.values(this.state.invites ?? {})
      .map((r) => inviteView(r, now))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  /** Our human revokes an invite (it only narrows). Returns it, or undefined when there is none by that id. */
  revokeInvite(id: string, now = new Date()): InviteView | undefined {
    const r = this.state.invites && Object.hasOwn(this.state.invites, id) ? this.state.invites[id] : undefined;
    if (!r) return undefined;
    if (!r.used && !r.revoked) {
      r.revoked = now.toISOString();
      r.revokedBy = 'owner';
    }
    delete r.standing;
    return inviteView(r, now);
  }

  /**
   * A request carrying the secret of one of our open invites came on a
   * public topic, so anyone could have read the secret (review of PR #120).
   * The request itself stays an ordinary one; the invite is revoked (only
   * our human made it, and only they can make a new one) and returned, so
   * the owner can be told. Undefined when the secret matches no open invite.
   */
  exposeInvite(req: ContactRequestBody, now = new Date()): InviteView | undefined {
    if (req.invite === undefined || !isInviteSecret(req.invite) || !this.state.invites) return undefined;
    const hash = inviteSecretHash(req.invite);
    let hit: InviteRecord | undefined;
    for (const r of Object.values(this.state.invites)) if (sameHash(r.hash, hash) && !hit) hit = r;
    if (!hit || inviteStatus(hit, now) !== 'open') return undefined;
    hit.revoked = now.toISOString();
    hit.revokedBy = 'exposed';
    delete hit.standing;
    return inviteView(hit, now);
  }

  /**
   * The open invite this secret belongs to, now marked used by `req.from`,
   * or undefined. Every stored hash is compared in constant time and the
   * loop never stops early, so its timing says nothing about a near miss.
   */
  private redeemInvite(secret: string, req: ContactRequestBody, now: Date): InviteRecord | undefined {
    const invites = this.state.invites;
    if (!invites || !isInviteSecret(secret)) return undefined;
    const hash = inviteSecretHash(secret);
    let hit: InviteRecord | undefined;
    for (const r of Object.values(invites)) if (sameHash(r.hash, hash) && !hit) hit = r;
    if (!hit || inviteStatus(hit, now) !== 'open') return undefined;
    hit.used = { at: now.toISOString(), by: req.from, request: req.id };
    return hit;
  }

  /** An invite that ended keeps no standing choice (NOTES 112): none is left behind for anything to find later. */
  dropEndedStanding(now = new Date()): void {
    for (const r of Object.values(this.state.invites ?? {})) if (r.standing && inviteStatus(r, now) !== 'open') delete r.standing;
  }

  /** Drop used, revoked and expired invites INVITE_KEEP_MS after they ended. */
  private pruneInvites(now: Date): void {
    const invites = this.state.invites;
    if (!invites) return;
    this.dropEndedStanding(now);
    for (const [id, r] of Object.entries(invites)) {
      if (inviteStatus(r, now) === 'open') continue;
      const ended = parseTimestamp(r.used?.at ?? r.revoked ?? r.expires) ?? 0;
      if (ended + INVITE_KEEP_MS < now.getTime()) delete invites[id];
    }
  }

  private unmarkSeen(id: string): void {
    const i = this.state.seenIds.lastIndexOf(id);
    if (i >= 0) this.state.seenIds.splice(i, 1);
  }

  /** The human approved (or the allowlist did): record the relationship we granted. */
  recordIssuedGrant(grant: ContactGrantBody, request: ContactRequestBody, binding: Binding, label?: string): Contact {
    const prev = this.state.contacts[request.from];
    // The human's grant checks its label first (Agent.grant, freeLabel); an invite's, set when it was made, is kept here.
    const l = label !== undefined ? cleanLabel(label) : prev?.label;
    const contact: Contact = {
      peer: request.from,
      card: request.card,
      tier: grant.tier,
      inboundScope: grant.scope,
      inboundGranted: true,
      outboundScope: prev?.outboundScope ?? { may_initiate: true },
      ...(prev?.grantedTier ? { grantedTier: prev.grantedTier } : {}),
      ...(prev?.outboundTs ? { outboundTs: prev.outboundTs } : {}),
      ...(prev?.reverseGrantId ? { reverseGrantId: prev.reverseGrantId } : {}),
      ...(l ? { label: l } : {}),
      ...(prev?.aliases?.length ? { aliases: [...prev.aliases] } : {}),
      binding,
      grantId: grant.id,
      expires: grant.expires,
      since: grant.ts,
    };
    this.state.contacts[request.from] = contact;
    delete this.state.pending[request.id];
    return contact;
  }

  /**
   * A grant arrived for one of our outstanding requests.
   *
   * The grant sets only what *we* may do towards the grantor (outbound). What
   * the grantor may do towards us stays DEFAULT_INBOUND_SCOPE until our human
   * grants (`allowInbound`): a peer's own grant can't hand it meetings or an
   * unlimited rate (security review H1/H2).
   *
   * A request sent to a card becomes a contact at once. A topic probe can be
   * answered by anyone who saw it, so its answers become candidates for our
   * human to confirm (`confirmCandidate`): only grantors whose card claims the
   * probed address qualify, and the probe stays open until one is confirmed.
   */
  receiveGrant(
    input: unknown,
    me: string,
    now = new Date(),
  ): { contact: Contact } | { candidate: GrantCandidate } | { overflow: ProbeOverflow } | null {
    if (!verifyGrant(input, now)) return null;
    const g = input;
    const outstanding = this.state.outstanding[g.request_ref];
    if (g.to !== me || !outstanding) return null;
    if (outstanding.to !== undefined) {
      // A request sent to a specific agent can only be granted by that agent.
      if (g.from !== outstanding.to) return null;
      if (this.isBlocked(g.from) || !this.markSeen(g.id)) return null;
      delete this.state.outstanding[g.request_ref];
      return { contact: this.addReceivedGrant(g, outstanding.binding ?? 'claimed', now, outstanding.label) };
    }
    // Topic probe: the grantor's card must at least claim the address we probed (NOTES 18).
    const probed = topicForHint(outstanding.to_hint);
    if (!probed || !(g.card.discovery?.addresses ?? []).some((a) => topicForHint(a.value) === probed)) return null;
    if (this.isBlocked(g.from)) return null;
    const rivals = Object.values(this.state.candidates).filter((c) => c.request_ref === g.request_ref);
    if (rivals.some((c) => c.grant.from === g.from)) return null;
    if (!this.markSeen(g.id)) return null;
    if (rivals.length >= CANDIDATES_PER_PROBE) {
      outstanding.dropped = (outstanding.dropped ?? 0) + 1;
      return { overflow: { request_ref: g.request_ref, to_hint: outstanding.to_hint, dropped: outstanding.dropped } };
    }
    const candidate: GrantCandidate = { grant: g, request_ref: g.request_ref, to_hint: outstanding.to_hint, received: now.toISOString() };
    this.state.candidates[g.id] = candidate;
    return { candidate };
  }

  /** Open probes that had answers dropped because they overflowed (shown to the human). */
  probeOverflows(): ProbeOverflow[] {
    return Object.entries(this.state.outstanding)
      .filter(([, o]) => o.to === undefined && (o.dropped ?? 0) > 0)
      .map(([id, o]) => ({ request_ref: id, to_hint: o.to_hint, dropped: o.dropped! }));
  }

  /** Our human picked this probe answer: it becomes the contact, and the probe's other answers are dropped. */
  confirmCandidate(grantId: string, now = new Date(), label?: string): Contact {
    const c = this.state.candidates[grantId];
    // The probed address is what our human looked for; the candidate's card only claims it.
    const l = label !== undefined ? this.freeLabel(label, c?.grant.from, now) : (this.state.outstanding[c?.request_ref]?.label ?? c?.to_hint);
    if (!c) throw new Error(`no grant candidate ${grantId}`);
    if (isPast(c.grant.expires, now)) throw new Error(`grant ${grantId} has expired`);
    if (this.isBlocked(c.grant.from)) throw new Error(`${c.grant.from} is blocked`);
    for (const [id, x] of Object.entries(this.state.candidates)) if (x.request_ref === c.request_ref) delete this.state.candidates[id];
    delete this.state.outstanding[c.request_ref];
    return this.addReceivedGrant(c.grant, 'claimed', now, l);
  }

  /** Our human turned this probe answer down (optionally blocking the grantor). The probe stays open. */
  rejectCandidate(grantId: string, block = false): GrantCandidate | undefined {
    const c = this.state.candidates[grantId];
    delete this.state.candidates[grantId];
    if (c && block) this.block(c.grant.from);
    return c;
  }

  /**
   * Our human's own grant to an existing contact (e.g. one we requested):
   * sets what the peer may do towards us. The book only records it;
   * `Agent.allowInbound` also sends the peer a reverse grant (NOTES 60).
   */
  allowInbound(peer: string, opts: { tier: Tier; scope: GrantScope }): Contact {
    const c = this.state.contacts[peer];
    if (!c) throw new Error(`no contact ${peer}`);
    if (!isTier(opts.tier)) throw new Error(`unknown tier ${String(opts.tier)}`);
    const scope = grantScope(opts.scope); // throws on a malformed or self-contradicting invoke
    if (c.inboundGranted !== true || !sameScope(c.inboundScope, scope)) c.grantStamp = newStamp();
    c.tier = opts.tier;
    c.inboundScope = scope;
    c.inboundGranted = true;
    delete this.state.rate[peer];
    this.forgetTaskRate(peer);
    return c;
  }

  /**
   * A reverse grant from a contact (NOTES 60): its human granted us rights
   * towards it. Like any received grant it sets only what *we* may do towards
   * the peer (`outboundScope`), never what the peer may do towards us.
   *
   * Accepted only from a current, unblocked contact, addressed to us, naming
   * the grant that founded that contact (`grant_ref` = `Contact.grantId`),
   * not expired, newer than the grant behind `outboundScope` and at most
   * REVERSE_GRANT_SKEW_MS ahead of our clock, and not seen before. Its
   * `expires` can shorten the contact (it ends when either side's grant
   * does), never extend it.
   */
  receiveReverseGrant(
    input: unknown,
    me: string,
    now = new Date(),
  ): { contact: Contact } | { rejected: 'invalid' | 'not-contact' | 'expired' | 'stale' | 'replay' } {
    if (!verifyReverseGrant(input, now) || input.to !== me) return { rejected: 'invalid' };
    const g = input;
    const c = this.contact(g.from, now);
    if (!c || this.isBlocked(g.from) || c.grantId !== g.grant_ref) return { rejected: 'not-contact' };
    if (isPast(g.expires, now)) return { rejected: 'expired' };
    const ts = parseTimestamp(g.ts)!;
    const prior = c.outboundTs === undefined ? null : parseTimestamp(c.outboundTs);
    if (ts > now.getTime() + REVERSE_GRANT_SKEW_MS || (prior !== null && ts <= prior)) return { rejected: 'stale' };
    if (!this.markSeen(g.id)) return { rejected: 'replay' };
    c.outboundScope = { ...g.scope };
    c.grantedTier = g.tier;
    c.outboundTs = g.ts;
    c.reverseGrantId = g.id;
    const ends = g.expires === null ? null : parseTimestamp(g.expires)!;
    const current = c.expires === null ? null : parseTimestamp(c.expires);
    if (ends !== null && (current === null || ends < current)) c.expires = g.expires;
    return { contact: c };
  }

  /**
   * A contact's new card, from `rdv/card-update` (SPEC §4.3, NOTES 82): the
   * card we use to reach it (relays) and to see what it supports
   * (capabilities). `from` is the authenticated envelope sender.
   *
   * Accepted only from a current, unblocked contact, for a card that passes
   * verifyCard and cardUpdateProblem, whose key is the contact's, whose
   * `created` is strictly later than the card we hold and at most
   * CARD_UPDATE_SKEW_MS ahead of our clock. The same card again is
   * `unchanged` (idempotent, no drop). Only `contact.card` changes: tier,
   * scopes, grant, label, binding and expiry are never touched, so nothing
   * the human approved moves.
   */
  receiveCardUpdate(
    input: unknown,
    from: string,
    now = new Date(),
    opts: { allowWs?: boolean } = {},
  ): { contact: Contact; previous: AddressCard } | { unchanged: true } | { rejected: 'not-contact' | 'invalid' | 'foreign-key' | 'stale' | 'future' | 'bounds'; reason: string } {
    const c = this.contact(from, now);
    if (!c || this.isBlocked(from)) return { rejected: 'not-contact', reason: 'not a contact' };
    const check = verifyCard(input, now);
    if (!check.ok) return { rejected: 'invalid', reason: check.reason };
    const card = check.card;
    if (card.id !== from || card.id !== c.peer) return { rejected: 'foreign-key', reason: "the card is not the sender's" };
    const problem = cardUpdateProblem(card, { allowWs: opts.allowWs, held: c.card });
    if (problem) return { rejected: 'bounds', reason: problem };
    if (card.created === c.card.created && card.sig === c.card.sig) return { unchanged: true };
    const created = parseTimestamp(card.created)!;
    const held = parseTimestamp(c.card.created) ?? 0;
    if (created <= held) return { rejected: 'stale', reason: 'not newer than the card we hold' };
    if (created > now.getTime() + CARD_UPDATE_SKEW_MS) return { rejected: 'future', reason: 'created too far ahead of our clock' };
    const previous = c.card;
    c.card = card;
    return { contact: c, previous };
  }

  private addReceivedGrant(g: ContactGrant, binding: Binding, now: Date, label?: string): Contact {
    const prev = this.state.contacts[g.from];
    const granted = prev?.inboundGranted === true;
    const l = label ?? prev?.label;
    const contact: Contact = {
      peer: g.from,
      card: g.card,
      tier: granted ? prev.tier : CLAIMED_TIER_CAP,
      inboundScope: granted ? prev.inboundScope : defaultInbound(),
      inboundGranted: granted,
      outboundScope: { ...g.scope },
      grantedTier: g.tier,
      outboundTs: g.ts,
      ...(l ? { label: l } : {}),
      ...(prev?.aliases?.length ? { aliases: [...prev.aliases] } : {}),
      binding,
      grantId: g.id,
      expires: g.expires,
      since: now.toISOString(),
    };
    this.state.contacts[g.from] = contact;
    return contact;
  }

  decline(requestId: string, block = false): void {
    const p = this.state.pending[requestId];
    delete this.state.pending[requestId];
    if (p && !this.state.declined.includes(requestId)) {
      this.state.declined.push(requestId);
      if (this.state.declined.length > DECLINED_LIMIT) this.state.declined.splice(0, this.state.declined.length - DECLINED_LIMIT);
    }
    if (p && block) this.block(p.request.from);
  }

  block(peer: string): void {
    if (!this.state.blocked.includes(peer)) this.state.blocked.push(peer);
    delete this.state.contacts[peer];
    this.forgetTaskRate(peer);
    for (const [id, c] of Object.entries(this.state.candidates)) if (c.grant.from === peer) delete this.state.candidates[id];
  }

  revoke(peer: string): void {
    delete this.state.contacts[peer];
    this.forgetTaskRate(peer);
  }

  receiveRevoke(input: unknown, me: string): boolean {
    if (!verifyRevoke(input) || input.to !== me || !this.markSeen(input.id)) return false;
    delete this.state.contacts[input.from];
    this.forgetTaskRate(input.from);
    return true;
  }

  /** The counters go with the contact (bounded by our contacts, never by peers). */
  private forgetTaskRate(peer: string): void {
    if (this.state.taskRate && Object.hasOwn(this.state.taskRate, peer)) delete this.state.taskRate[peer];
  }

  /** Tasks from `peer` rejected for a per-capability limit so far (for the human). */
  taskRejections(peer: string): number {
    const r = this.state.taskRate && Object.hasOwn(this.state.taskRate, peer) ? this.state.taskRate[peer] : undefined;
    return r?.total ?? 0;
  }

  /**
   * May `peer` open one more task for `capability` now (§5.3, issue #28)?
   * Call it once per new task, after every other check (capability known,
   * input valid), right before the task would be kept: an admitted task
   * counts towards the capability's `max_frequency`.
   *
   * - No current contact, a blocked one, or a grant (our human's, inbound)
   *   that does not allow the capability: `scope`, and nothing is counted (a
   *   stranger's flood touches no counter, NOTES 64).
   * - `open` (the peer's tasks for this capability not yet terminal, from
   *   the task engine) at or over `maxOpen` (the engine's figure, which knows
   *   the capability's default; else the grant's `max_open`, default 4), or
   *   the capability's `max_frequency` window full: `rate`. The task is
   *   refused and nothing else changes, but the rejection is counted, and
   *   when it crosses a gross-abuse threshold the answer carries `abuse`:
   *   the caller revokes the grant (`Agent.admitTask` does, with `rdv/revoke`).
   * - An unreadable `now` refuses (`rate`, limit `clock`) without counting.
   *
   * Rejections for a closed gate, our human's "no" or an unsupported
   * capability never come here, so they never count.
   */
  admitTask(peer: string, capability: string, opts: { open?: number; maxOpen?: number } = {}, now = new Date()): TaskAdmission {
    const t = now.getTime();
    if (!Number.isFinite(t)) return { ok: false, code: 'rate', limit: 'clock', reason: 'our clock is unreadable' };
    const c = this.contact(peer, now);
    if (!c || this.isBlocked(peer)) return { ok: false, code: 'scope', reason: 'not a contact' };
    const limits = invokeLimits(c.inboundScope, capability);
    if (!limits) return { ok: false, code: 'scope', reason: 'the grant does not allow this capability (invoke)' };
    const all = (this.state.taskRate ??= {});
    const r: TaskRateState = Object.hasOwn(all, peer) ? all[peer] : { admitted: {}, rejected: {}, total: 0 };
    // Capabilities the grant no longer allows keep nothing.
    for (const k of Object.keys(r.admitted)) if (!scopeAllows(c.inboundScope, k)) delete r.admitted[k];
    for (const k of Object.keys(r.rejected)) if (!scopeAllows(c.inboundScope, k)) delete r.rejected[k];
    const freq = parseFrequency(limits.max_frequency);
    const maxOpen = Number.isSafeInteger(opts.maxOpen) && opts.maxOpen! >= 1 ? opts.maxOpen! : limits.max_open!;
    const open = Number.isSafeInteger(opts.open) && opts.open! >= 0 ? opts.open! : 0;
    const admitted = freq ? within(r.admitted[capability], freq.windowMs, t) : [];
    let over: { limit: TaskLimit; reason: string } | null = null;
    if (open >= maxOpen) over = { limit: 'max_open', reason: `too many open tasks for this capability (max_open ${maxOpen})` };
    else if (freq && admitted.length >= freq.count) over = { limit: 'max_frequency', reason: `over this capability's max_frequency (${limits.max_frequency})` };
    if (!over) {
      if (freq) r.admitted[capability] = [...admitted, t];
      all[peer] = r;
      return { ok: true };
    }
    if (freq) r.admitted[capability] = admitted;
    const rejected = [...within(r.rejected[capability], TASK_RATE.dayMs, t), t].slice(-TASK_RATE.rejectedKept);
    r.rejected[capability] = rejected;
    r.total += 1;
    all[peer] = r;
    const abuse = this.taskAbuse(peer, capability, r, freq, t);
    return { ok: false, code: 'rate', ...over, ...(abuse ? { abuse } : {}) };
  }

  /** Gross abuse (b): more rejections for one capability in its window than 3× its limit, or more than 50 in 24 hours. */
  private taskAbuse(peer: string, capability: string, r: TaskRateState, freq: { count: number; windowMs: number } | null, t: number): TaskAbuse | null {
    if (freq) {
      // A "0/<unit>" capability refuses every task; its threshold is read as for a limit of 1.
      const threshold = TASK_RATE.abuseFactor * Math.max(freq.count, 1);
      const n = within(r.rejected[capability], freq.windowMs, t).length;
      if (n > threshold) return { peer, capability, trigger: 'capability', rejected: n, threshold, windowMs: freq.windowMs };
    }
    const daily = Object.values(r.rejected).reduce((sum, list) => sum + within(list, TASK_RATE.dayMs, t).length, 0);
    if (daily > TASK_RATE.dailyRejections) {
      return { peer, capability, trigger: 'daily', rejected: daily, threshold: TASK_RATE.dailyRejections, windowMs: TASK_RATE.dayMs };
    }
    return null;
  }

  /**
   * Rate limit for control messages a contact can make us act on (e.g.
   * `rdv/resend`, which makes us republish envelopes). Exceeding it drops the
   * message but, unlike admitInbound, does not revoke (security review L3).
   */
  admitControl(kind: string, peer: string, limit: { count: number; windowMs: number }, now = new Date()): boolean {
    const key = `${kind}:${peer}`;
    if (!Number.isFinite(now.getTime())) return false; // an unreadable clock admits nothing (fail closed)
    const window = within(this.state.rate[key], limit.windowMs, now.getTime());
    if (window.length >= limit.count) {
      this.state.rate[key] = window;
      return false;
    }
    window.push(now.getTime());
    this.state.rate[key] = window;
    return true;
  }

  /**
   * May `peer` deliver a (non-contact-request) message to us now? Enforces
   * `max_frequency`; exceeding it revokes the grant (§10).
   */
  admitInbound(peer: string, now = new Date()): boolean {
    // An unreadable clock admits nothing and revokes nothing (fail closed; it is our fault, not the peer's).
    if (!Number.isFinite(now.getTime())) return false;
    const c = this.contact(peer, now);
    if (!c || this.isBlocked(peer)) return false;
    const limit = parseFrequency(c.inboundScope?.max_frequency);
    if (!limit) return true;
    const window = within(this.state.rate[peer], limit.windowMs, now.getTime());
    window.push(now.getTime());
    this.state.rate[peer] = window;
    if (window.length > limit.count) {
      this.revoke(peer);
      return false;
    }
    return true;
  }
}

/**
 * Default tier offered at consent time (§4.4): a `claimed` binding caps at
 * `stranger` unless the human explicitly picks a higher tier.
 */
export function defaultTier(binding: Binding): Tier {
  return BINDING_STRENGTH[binding] === 0 ? CLAIMED_TIER_CAP : 'friend';
}

export function parseFrequency(spec: string | undefined): { count: number; windowMs: number } | null {
  if (!spec) return null;
  const m = /^(\d+)\/(minute|hour|day)$/.exec(spec);
  if (!m) return null;
  const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[m[2] as 'minute' | 'hour' | 'day'];
  return { count: Number(m[1]), windowMs: unit };
}
