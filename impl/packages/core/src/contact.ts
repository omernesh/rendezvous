// §5: contact request, grant, revocation, and the local contact book that
// enforces consent, policy, replay protection and grant-scoped rate limits.
import type { AddressCard, InboundPolicy } from './card.js';
import { verifyCard } from './card.js';
import { BINDING_STRENGTH, type Binding, topicForHint } from './discovery.js';
import type { AgentKey } from './identity.js';
import { isAgentId } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';

export type Tier = 'spouse' | 'family' | 'friend' | 'colleague' | 'business' | 'stranger';
/** The tier enum, closest first. A grant with any other tier is rejected. */
export const TIERS: readonly Tier[] = ['spouse', 'family', 'friend', 'colleague', 'business', 'stranger'];
export const isTier = (t: unknown): t is Tier => typeof t === 'string' && (TIERS as readonly string[]).includes(t);

export interface GrantScope {
  may_initiate?: boolean;
  may_propose_meetings?: boolean;
  may_access_calendar?: 'none' | 'free_busy' | 'full';
  /** "<n>/<minute|hour|day>" */
  max_frequency?: string;
  [extra: string]: unknown;
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

export function createContactRequest(
  key: AgentKey,
  card: AddressCard,
  opts: { toHint: string; greeting: string; capabilities?: string[]; now?: Date },
): ContactRequest {
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
  if (!r || r.v !== 1 || r.type !== 'rdv/contact-request' || !isDocId(r.id)) return false;
  if (!isAgentId(r.from) || !verifyDoc(r, r.from)) return false;
  const card = verifyCard(r.card, now);
  return card.ok && card.card.id === r.from;
}

export function verifyGrant(input: unknown, now = new Date()): input is ContactGrant {
  const g = input as ContactGrant;
  if (!g || g.v !== 1 || g.type !== 'rdv/contact-grant' || !isDocId(g.id) || !isDocId(g.request_ref)) return false;
  if (!isTier(g.tier) || !g.scope || typeof g.scope !== 'object' || Array.isArray(g.scope)) return false;
  if (!isAgentId(g.from) || !isAgentId(g.to) || !verifyDoc(g, g.from)) return false;
  const card = verifyCard(g.card, now);
  return card.ok && card.card.id === g.from;
}

export function verifyRevoke(input: unknown): input is Revoke {
  const r = input as Revoke;
  return !!r && r.v === 1 && r.type === 'rdv/revoke' && isDocId(r.id) && isAgentId(r.from) && verifyDoc(r, r.from);
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
});

export interface Contact {
  peer: string;
  card: AddressCard;
  /** Our tier for the peer. `stranger` until our human grants (a received grant does not set it). */
  tier: Tier;
  /** What the peer may do towards us: our own grant, or DEFAULT_INBOUND_SCOPE until our human grants. */
  inboundScope: GrantScope | null;
  /** True once our human granted the peer (issued grant or allowInbound); false while inbound is the local default. */
  inboundGranted?: boolean;
  /** What we may do towards the peer (the grant we received). */
  outboundScope: GrantScope | null;
  /** The tier the peer's grant put us in (display only). */
  grantedTier?: Tier;
  binding: Binding;
  grantId: string;
  expires: string | null;
  since: string;
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
  | { status: 'auto-grant'; tier: Tier; scope: GrantScope }
  | { status: 'blocked' | 'duplicate' | 'invalid' | 'already-contact' | 'rate-limited' };

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

  isBlocked(peer: string): boolean {
    return this.state.blocked.includes(peer);
  }

  contact(peer: string, now = new Date()): Contact | undefined {
    const c = this.state.contacts[peer];
    if (!c) return undefined;
    if (c.expires && Date.parse(c.expires) <= now.getTime()) return undefined;
    return c;
  }

  /**
   * Remember an outbound request. `to` is the target agent ID when the request
   * went to a specific card; omit it for a topic probe (anyone may answer, and
   * the binding is then always `claimed`).
   */
  trackOutstanding(req: ContactRequestBody, binding: Binding = 'claimed', to?: string): void {
    this.state.outstanding[req.id] = to
      ? { to_hint: req.to_hint, sent: req.ts, binding, to }
      : { to_hint: req.to_hint, sent: req.ts, binding: 'claimed' };
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

  private unmarkSeen(id: string): void {
    const i = this.state.seenIds.lastIndexOf(id);
    if (i >= 0) this.state.seenIds.splice(i, 1);
  }

  /** The human approved (or the allowlist did): record the relationship we granted. */
  recordIssuedGrant(grant: ContactGrantBody, request: ContactRequestBody, binding: Binding): Contact {
    const prev = this.state.contacts[request.from];
    const contact: Contact = {
      peer: request.from,
      card: request.card,
      tier: grant.tier,
      inboundScope: grant.scope,
      inboundGranted: true,
      outboundScope: prev?.outboundScope ?? { may_initiate: true },
      ...(prev?.grantedTier ? { grantedTier: prev.grantedTier } : {}),
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
      return { contact: this.addReceivedGrant(g, outstanding.binding ?? 'claimed', now) };
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
  confirmCandidate(grantId: string, now = new Date()): Contact {
    const c = this.state.candidates[grantId];
    if (!c) throw new Error(`no grant candidate ${grantId}`);
    if (c.grant.expires && Date.parse(c.grant.expires) <= now.getTime()) throw new Error(`grant ${grantId} has expired`);
    if (this.isBlocked(c.grant.from)) throw new Error(`${c.grant.from} is blocked`);
    for (const [id, x] of Object.entries(this.state.candidates)) if (x.request_ref === c.request_ref) delete this.state.candidates[id];
    delete this.state.outstanding[c.request_ref];
    return this.addReceivedGrant(c.grant, 'claimed', now);
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
   * sets what the peer may do towards us. Local only; nothing is sent.
   */
  allowInbound(peer: string, opts: { tier: Tier; scope: GrantScope }): Contact {
    const c = this.state.contacts[peer];
    if (!c) throw new Error(`no contact ${peer}`);
    if (!isTier(opts.tier)) throw new Error(`unknown tier ${String(opts.tier)}`);
    c.tier = opts.tier;
    c.inboundScope = { ...opts.scope };
    c.inboundGranted = true;
    delete this.state.rate[peer];
    return c;
  }

  private addReceivedGrant(g: ContactGrant, binding: Binding, now: Date): Contact {
    const prev = this.state.contacts[g.from];
    const granted = prev?.inboundGranted === true;
    const contact: Contact = {
      peer: g.from,
      card: g.card,
      tier: granted ? prev.tier : CLAIMED_TIER_CAP,
      inboundScope: granted ? prev.inboundScope : { ...DEFAULT_INBOUND_SCOPE },
      inboundGranted: granted,
      outboundScope: { ...g.scope },
      grantedTier: g.tier,
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
    for (const [id, c] of Object.entries(this.state.candidates)) if (c.grant.from === peer) delete this.state.candidates[id];
  }

  revoke(peer: string): void {
    delete this.state.contacts[peer];
  }

  receiveRevoke(input: unknown, me: string): boolean {
    if (!verifyRevoke(input) || input.to !== me || !this.markSeen(input.id)) return false;
    delete this.state.contacts[input.from];
    return true;
  }

  /**
   * May `peer` deliver a (non-contact-request) message to us now? Enforces
   * `max_frequency`; exceeding it revokes the grant (§10).
   */
  admitInbound(peer: string, now = new Date()): boolean {
    const c = this.contact(peer, now);
    if (!c || this.isBlocked(peer)) return false;
    const limit = parseFrequency(c.inboundScope?.max_frequency);
    if (!limit) return true;
    const window = (this.state.rate[peer] ?? []).filter((t) => t > now.getTime() - limit.windowMs);
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
