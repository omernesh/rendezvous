// §5: contact request, grant, revocation, and the local contact book that
// enforces consent, policy, replay protection and grant-scoped rate limits.
import type { AddressCard, InboundPolicy } from './card.js';
import { verifyCard } from './card.js';
import { BINDING_STRENGTH, type Binding } from './discovery.js';
import type { AgentKey } from './identity.js';
import { isAgentId } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';

export type Tier = 'spouse' | 'family' | 'friend' | 'colleague' | 'business' | 'stranger';

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

export function verifyContactRequest(input: unknown, now = new Date()): input is ContactRequest {
  const r = input as ContactRequest;
  if (!r || r.v !== 1 || r.type !== 'rdv/contact-request' || typeof r.id !== 'string') return false;
  if (!isAgentId(r.from) || !verifyDoc(r, r.from)) return false;
  const card = verifyCard(r.card, now);
  return card.ok && card.card.id === r.from;
}

export function verifyGrant(input: unknown, now = new Date()): input is ContactGrant {
  const g = input as ContactGrant;
  if (!g || g.v !== 1 || g.type !== 'rdv/contact-grant' || typeof g.id !== 'string') return false;
  if (!isAgentId(g.from) || !isAgentId(g.to) || !verifyDoc(g, g.from)) return false;
  const card = verifyCard(g.card, now);
  return card.ok && card.card.id === g.from;
}

export function verifyRevoke(input: unknown): input is Revoke {
  const r = input as Revoke;
  return !!r && r.v === 1 && r.type === 'rdv/revoke' && isAgentId(r.from) && verifyDoc(r, r.from);
}

// ---------------------------------------------------------------------------

export interface Contact {
  peer: string;
  card: AddressCard;
  tier: Tier;
  /** What the peer may do towards us (grants we issued). */
  inboundScope: GrantScope | null;
  /** What we may do towards the peer (grants we received). */
  outboundScope: GrantScope | null;
  binding: Binding;
  grantId: string;
  expires: string | null;
  since: string;
}

export interface PendingRequest {
  request: ContactRequest;
  binding: Binding;
  received: string;
}

export type RequestOutcome =
  | { status: 'pending'; pending: PendingRequest }
  | { status: 'auto-grant'; tier: Tier; scope: GrantScope }
  | { status: 'blocked' | 'duplicate' | 'invalid' | 'already-contact' };

export interface ContactBookState {
  policy: InboundPolicy;
  contacts: Record<string, Contact>;
  pending: Record<string, PendingRequest>;
  /**
   * Outbound requests awaiting a grant: request id -> target hint, how we found
   * the peer, and (for requests sent to a known card) the only agent whose
   * grant we will accept.
   */
  outstanding: Record<string, { to_hint: string; sent: string; binding?: Binding; to?: string }>;
  blocked: string[];
  allowlist: Record<string, { tier: Tier; scope: GrantScope }>;
  seenIds: string[];
  rate: Record<string, number[]>;
}

const SEEN_LIMIT = 5000;
const CLAIMED_TIER_CAP: Tier = 'stranger';

export class ContactBook {
  state: ContactBookState;

  constructor(state?: Partial<ContactBookState>) {
    this.state = {
      policy: 'prompt',
      contacts: {},
      pending: {},
      outstanding: {},
      blocked: [],
      allowlist: {},
      seenIds: [],
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
  receiveRequest(input: unknown, binding: Binding, now = new Date()): RequestOutcome {
    if (!verifyContactRequest(input, now)) return { status: 'invalid' };
    const req = input;
    if (!this.markSeen(req.id)) return { status: 'duplicate' };
    if (this.isBlocked(req.from) || this.state.policy === 'block') return { status: 'blocked' };
    if (this.contact(req.from, now)) return { status: 'already-contact' };
    const allowed = this.state.allowlist[req.from];
    if (allowed) return { status: 'auto-grant', ...allowed };
    if (this.state.policy === 'allow') return { status: 'blocked' }; // allow = allowlist only
    const pending: PendingRequest = { request: req, binding, received: now.toISOString() };
    this.state.pending[req.id] = pending;
    return { status: 'pending', pending };
  }

  /** The human approved (or the allowlist did): record the relationship we granted. */
  recordIssuedGrant(grant: ContactGrantBody, request: ContactRequestBody, binding: Binding): Contact {
    const contact: Contact = {
      peer: request.from,
      card: request.card,
      tier: grant.tier,
      inboundScope: grant.scope,
      outboundScope: this.state.contacts[request.from]?.outboundScope ?? { may_initiate: true },
      binding,
      grantId: grant.id,
      expires: grant.expires,
      since: grant.ts,
    };
    this.state.contacts[request.from] = contact;
    delete this.state.pending[request.id];
    return contact;
  }

  /** A grant arrived for one of our outstanding requests. */
  receiveGrant(input: unknown, me: string, now = new Date()): Contact | null {
    if (!verifyGrant(input, now)) return null;
    const g = input;
    const outstanding = this.state.outstanding[g.request_ref];
    if (g.to !== me || !outstanding) return null;
    // A request sent to a specific agent can only be granted by that agent.
    if (outstanding.to !== undefined && g.from !== outstanding.to) return null;
    if (this.isBlocked(g.from) || !this.markSeen(g.id)) return null;
    delete this.state.outstanding[g.request_ref];
    // We initiated, so we accept the grantor contacting us within the same scope.
    const contact: Contact = {
      peer: g.from,
      card: g.card,
      tier: g.tier,
      inboundScope: { ...g.scope, may_initiate: true },
      outboundScope: g.scope,
      binding: outstanding.to !== undefined ? (outstanding.binding ?? 'claimed') : 'claimed',
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
    if (p && block) this.block(p.request.from);
  }

  block(peer: string): void {
    if (!this.state.blocked.includes(peer)) this.state.blocked.push(peer);
    delete this.state.contacts[peer];
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
