// An agent ties the layers together: identity + card, contact book (consent),
// per-peer channels (ordering), and a transport. It holds no LLM and makes no
// judgment calls — the owner (human, CLI script, or MCP host) decides on
// pending requests through `grant` / `decline`.
import { EventEmitter } from 'node:events';
import { type AddressCard, type CardOptions, createCard, verifyCard } from './card.js';
import {
  type Contact,
  ContactBook,
  type ContactBookState,
  type ContactRequest,
  type GrantCandidate,
  type GrantScope,
  type ProbeOverflow,
  type PendingRequest,
  type Tier,
  createContactRequest,
  createGrant,
  createRevoke,
  defaultTier,
  verifyContactRequest,
} from './contact.js';
import { type Binding, dtopic, topicForHint } from './discovery.js';
import { b64decode, b64encode } from './encoding.js';
import { Channels, type ChannelState, type Envelope, type Payload, openEnvelope, sealEnvelope } from './envelope.js';
import { type AgentKey, generateKey, keyFromSecret } from './identity.js';
import type { Transport } from './transport/transport.js';

const OUTBOX_LIMIT = 64;
/** Gap buffer bounds: per peer (OUTBOX_LIMIT envelopes) and across peers. */
const BUFFER_PEER_LIMIT = 16;
/** The scope the owner grants when it doesn't pick one. */
export const DEFAULT_GRANT_SCOPE: Readonly<GrantScope> = Object.freeze({ may_initiate: true, may_propose_meetings: true, max_frequency: '100/day' });
const CONTROL_TYPES = new Set(['rdv/contact-request', 'rdv/contact-grant', 'rdv/revoke', 'rdv/resend']);

export interface AgentState {
  secretKey: string;
  card: AddressCard;
  book: ContactBookState;
  channels: Record<string, ChannelState>;
  outbox: Record<string, Envelope[]>;
  /** Out-of-order envelopes waiting for a gap to fill (kept so a restart doesn't lose them). */
  buffer?: Record<string, Envelope[]>;
}

export interface AgentEvents {
  request: [PendingRequest];
  /** A grant answering one of our topic probes, waiting for our human (confirmCandidate / rejectCandidate). */
  candidate: [GrantCandidate];
  /** Answers to one of our probes were dropped (too many). Emitted on the first drop per probe; see probeOverflows(). */
  'probe-overflow': [ProbeOverflow];
  /** The pending list was full and a request was dropped; `total` counts all such drops (someone may be flooding us). */
  'pending-evicted': [total: number];
  contact: [Contact];
  message: [peer: string, payload: Payload, envelope: Envelope];
  revoked: [peer: string];
  dropped: [reason: string, detail?: unknown];
  error: [Error];
}

export class Agent extends EventEmitter<AgentEvents> {
  readonly book: ContactBook;
  readonly channels: Channels;
  private outbox: Record<string, Envelope[]>;
  private buffer: Record<string, Envelope[]>;
  private unsubscribers: Array<() => void> = [];
  private queue: Promise<void> = Promise.resolve();

  /**
   * Called after an outbound envelope is committed to the channel state and
   * the outbox, and before it leaves the process. Save `toJSON()` here: if the
   * process dies right after the send, the next start must not reuse the
   * envelope's `seq` (the peer would see a fork). If it throws, nothing is sent.
   */
  beforeSend?: (agent: Agent) => void | Promise<void>;

  constructor(
    readonly key: AgentKey,
    public card: AddressCard,
    readonly transport: Transport,
    state?: Partial<Pick<AgentState, 'book' | 'channels' | 'outbox' | 'buffer'>>,
  ) {
    super();
    this.book = new ContactBook({ policy: card.policy.inbound, ...state?.book });
    this.channels = new Channels(state?.channels ?? {});
    this.outbox = state?.outbox ?? {};
    this.buffer = state?.buffer ?? {};
  }

  static create(transport: (key: AgentKey) => Transport, card: CardOptions, key: AgentKey = generateKey()): Agent {
    return new Agent(key, createCard(key, card), transport(key));
  }

  static fromJSON(state: AgentState, transport: (key: AgentKey) => Transport): Agent {
    const key = keyFromSecret(b64decode(state.secretKey));
    return new Agent(key, state.card, transport(key), state);
  }

  toJSON(): AgentState {
    return {
      secretKey: b64encode(this.key.secretKey),
      card: this.card,
      book: this.book.toJSON(),
      channels: this.channels.state,
      outbox: this.outbox,
      buffer: this.bufferToPersist(),
    };
  }

  get id(): string {
    return this.key.id;
  }

  /** Listen for envelopes and on our own discovery topics (listen mode, §4.4). */
  start(): void {
    this.unsubscribers.push(this.transport.onEnvelopes(this.id, (raw) => this.enqueue(() => this.handleEnvelope(raw))));
    const topics = (this.card.discovery?.addresses ?? []).map(dtopic);
    this.unsubscribers.push(this.transport.onTopics(topics, (doc, topic) => this.enqueue(() => this.handleTopicDoc(doc, topic))));
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
  }

  close(): void {
    this.stop();
    this.transport.close();
  }

  /** Resolves once every inbound event received so far has been processed. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Public pointer mode: publish our card on each discovery topic (opt-in). */
  async publishPointers(): Promise<void> {
    if (!this.card.discovery?.public_pointer || !this.card.policy.public) return;
    for (const addr of this.card.discovery.addresses) await this.transport.publishTopic(dtopic(addr), this.card);
  }

  /** Look up public pointers for an address. Only verified cards that claim the address come back. */
  async lookup(address: string): Promise<AddressCard[]> {
    const topic = topicForHint(address);
    if (!topic) return [];
    const docs = await this.transport.fetchTopic(topic);
    const seen = new Set<string>();
    const cards: AddressCard[] = [];
    for (const d of docs) {
      const check = verifyCard(d);
      if (!check.ok || seen.has(check.card.id) || check.card.id === this.id) continue;
      if (check.card.discovery?.addresses.some((a) => topicForHint(a.value) === topic)) {
        seen.add(check.card.id);
        cards.push(check.card);
      }
    }
    return cards;
  }

  /**
   * Ask for contact. With a card, the request goes straight to the peer in an
   * envelope; with only an address, it is posted on the address's discovery
   * topic for a listening agent to pick up.
   *
   * `binding` records how we got the peer's card (§4.4) and is stored on the
   * contact once the grant arrives. A topic probe is always `claimed`; a card
   * defaults to `claimed` unless the caller knows better (e.g. `in-person`
   * for a card scanned from a QR code).
   */
  async requestContact(
    target: AddressCard | string,
    greeting: string,
    opts: { binding?: Binding } = {},
  ): Promise<ContactRequest> {
    const toHint = typeof target === 'string' ? target : target.id;
    const binding: Binding = typeof target === 'string' ? 'claimed' : (opts.binding ?? 'claimed');
    const req = createContactRequest(this.key, this.card, { toHint, greeting });
    this.book.trackOutstanding(req, binding, typeof target === 'string' ? undefined : target.id);
    if (typeof target === 'string') {
      const topic = topicForHint(target);
      if (!topic) throw new Error(`cannot derive a discovery topic from "${target}"`);
      await this.transport.publishTopic(topic, req);
    } else {
      const check = verifyCard(target);
      if (!check.ok) throw new Error(`refusing to contact an invalid card: ${check.reason}`);
      await this.deliver(target.id, req, relaysOf(target));
    }
    return req;
  }

  pendingRequests(): PendingRequest[] {
    return Object.values(this.book.state.pending);
  }

  /** Owner approves a pending request. Tier defaults per binding (§4.4). */
  async grant(requestId: string, opts: { tier?: Tier; scope?: GrantScope; expires?: string | null } = {}): Promise<Contact> {
    const pending = this.book.state.pending[requestId];
    if (!pending) throw new Error(`no pending request ${requestId}`);
    return this.issueGrant(pending.request, pending.binding, opts);
  }

  decline(requestId: string, opts: { block?: boolean } = {}): void {
    this.book.decline(requestId, opts.block);
  }

  /** Probe answers waiting for the owner to pick the right grantor. */
  grantCandidates(): GrantCandidate[] {
    return Object.values(this.book.state.candidates);
  }

  /** Owner confirms a probe answer: that grantor becomes the contact (outbound per its grant, inbound the local default). */
  confirmCandidate(grantId: string): Contact {
    const contact = this.book.confirmCandidate(grantId);
    this.emit('contact', contact);
    return contact;
  }

  rejectCandidate(grantId: string, opts: { block?: boolean } = {}): GrantCandidate | undefined {
    return this.book.rejectCandidate(grantId, opts.block);
  }

  /** Owner grants an existing contact rights towards us (local; see ContactBook.allowInbound). */
  allowInbound(peer: string, opts: { tier?: Tier; scope?: GrantScope } = {}): Contact {
    const c = this.book.contact(peer);
    if (!c) throw new Error(`no active contact ${peer}`);
    return this.book.allowInbound(peer, { tier: opts.tier ?? defaultTier(c.binding), scope: opts.scope ?? { ...DEFAULT_GRANT_SCOPE } });
  }

  async revoke(peer: string): Promise<void> {
    const c = this.book.contact(peer);
    this.book.revoke(peer);
    if (c) await this.deliver(peer, createRevoke(this.key, peer, c.grantId), relaysOf(c.card));
  }

  contacts(): Contact[] {
    return Object.values(this.book.state.contacts);
  }

  /** Send an application payload (A2A task, message, proposal) to a contact. */
  async send(peer: string, payload: Payload): Promise<Envelope> {
    if (CONTROL_TYPES.has(payload.type)) throw new Error(`use the dedicated method for ${payload.type}`);
    const c = this.book.contact(peer);
    if (!c) throw new Error(`no active contact with ${peer}`);
    if (c.outboundScope && c.outboundScope.may_initiate === false) throw new Error('grant does not allow initiating');
    return this.deliver(peer, payload, relaysOf(c.card));
  }

  // -------------------------------------------------------------------------

  private enqueue(fn: () => Promise<void> | void): void {
    this.queue = this.queue.then(fn).catch((err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async deliver(peer: string, payload: { type: string }, relays: string[]): Promise<Envelope> {
    const { seq, prev } = this.channels.nextOutbound(peer);
    const env = sealEnvelope(this.key, peer, payload, { seq, prev });
    this.channels.commitOutbound(peer, env);
    const box = (this.outbox[peer] ??= []);
    box.push(env);
    if (box.length > OUTBOX_LIMIT) box.splice(0, box.length - OUTBOX_LIMIT);
    await this.beforeSend?.(this);
    await this.transport.sendEnvelope(env, relays);
    return env;
  }

  private async issueGrant(
    request: ContactRequest,
    binding: Binding,
    opts: { tier?: Tier; scope?: GrantScope; expires?: string | null },
  ): Promise<Contact> {
    const grant = createGrant(this.key, this.card, request, {
      tier: opts.tier ?? defaultTier(binding),
      scope: opts.scope ?? { ...DEFAULT_GRANT_SCOPE },
      expires: opts.expires,
    });
    const contact = this.book.recordIssuedGrant(grant, request, binding);
    await this.deliver(request.from, grant, relaysOf(request.card));
    this.emit('contact', contact);
    return contact;
  }

  private async handleTopicDoc(doc: unknown, topic: string): Promise<void> {
    if (!verifyContactRequest(doc)) return this.drop('topic doc is not a valid contact request');
    if (doc.from === this.id) return;
    // Bound to where it arrived (security review L2): a probe for someone else,
    // re-posted on our topic, is not a probe for us.
    const ours = (this.card.discovery?.addresses ?? []).map(dtopic);
    if (!ours.includes(topic) || topicForHint(doc.to_hint) !== topic) return this.drop('topic doc is not a probe for this topic');
    await this.handleContactRequest(doc, 'claimed', 'topic');
  }

  private async handleContactRequest(req: ContactRequest, binding: Binding, via: 'envelope' | 'topic'): Promise<void> {
    const outcome = this.book.receiveRequest(req, binding, new Date(), { via, me: this.id });
    switch (outcome.status) {
      case 'pending':
        if (outcome.evicted) this.emit('pending-evicted', outcome.evicted.total);
        this.emit('request', outcome.pending);
        return;
      case 'evicted':
        this.emit('pending-evicted', outcome.total);
        return;
      case 'auto-grant':
        await this.issueGrant(req, binding, { tier: outcome.tier, scope: outcome.scope });
        return;
      default:
        this.drop(`contact request ${outcome.status}`, req.id);
    }
  }

  private async handleEnvelope(raw: unknown): Promise<void> {
    const opened = openEnvelope(this.key, raw);
    if (!opened.ok) return this.drop(opened.reason);
    const env = opened.envelope;
    if (this.book.isBlocked(env.from)) return this.drop('blocked sender');

    const order = this.channels.acceptInbound(env);
    if (order.kind === 'duplicate') return;
    if (order.kind === 'fork') return this.drop('envelope chain fork', env.seq);
    if (order.kind === 'gap') {
      this.bufferEnvelope(env);
      const c = this.book.contact(env.from);
      if (c) {
        const resend: Payload = { type: 'rdv/resend', from_seq: order.missingFrom, to_seq: order.missingTo };
        await this.deliver(c.peer, resend, relaysOf(c.card));
      }
      return;
    }

    await this.dispatch(env, opened.payload);
    await this.drainBuffer(env.from);
  }

  /** Only contacts (or agents we asked by card) may park envelopes with us. */
  private mayBuffer(peer: string): boolean {
    return !!this.book.contact(peer) || this.book.outstandingTargets().has(peer);
  }

  private bufferEnvelope(env: Envelope): void {
    if (!this.mayBuffer(env.from)) return this.drop('out-of-order envelope from a non-contact', env.from);
    let buf = this.buffer[env.from];
    if (!buf) {
      const peers = Object.keys(this.buffer);
      // Evict the peer whose buffer was created first (insertion order).
      if (peers.length >= BUFFER_PEER_LIMIT) delete this.buffer[peers[0]];
      buf = this.buffer[env.from] = [];
    }
    if (!buf.some((e) => e.seq === env.seq) && buf.length < OUTBOX_LIMIT) buf.push(env);
  }

  private bufferToPersist(): Record<string, Envelope[]> {
    const out: Record<string, Envelope[]> = {};
    for (const [peer, buf] of Object.entries(this.buffer)) {
      if (buf.length && this.mayBuffer(peer)) out[peer] = buf;
    }
    return out;
  }

  private async drainBuffer(peer: string): Promise<void> {
    const buf = this.buffer[peer];
    while (buf?.length) {
      buf.sort((a, b) => a.seq - b.seq);
      const next = buf[0];
      const order = this.channels.acceptInbound(next);
      if (order.kind === 'gap') return;
      buf.shift();
      if (order.kind !== 'in-order') continue;
      const opened = openEnvelope(this.key, next);
      if (opened.ok) await this.dispatch(next, opened.payload);
    }
    if (buf && buf.length === 0) delete this.buffer[peer];
  }

  private async dispatch(env: Envelope, payload: Payload): Promise<void> {
    const from = env.from;
    switch (payload.type) {
      case 'rdv/contact-request': {
        const req = payload as unknown as ContactRequest;
        if (req.from !== from) return this.drop('request signer differs from envelope sender');
        return this.handleContactRequest(req, 'claimed', 'envelope');
      }
      case 'rdv/contact-grant': {
        if ((payload as { from?: unknown }).from !== from) return this.drop('grant signer differs from envelope sender');
        const got = this.book.receiveGrant(payload, this.id);
        if (!got) return this.drop('unexpected or invalid grant');
        if ('candidate' in got) {
          this.emit('candidate', got.candidate);
          return;
        }
        if ('overflow' in got) {
          if (got.overflow.dropped === 1) this.emit('probe-overflow', got.overflow);
          return;
        }
        this.emit('contact', got.contact);
        return;
      }
      case 'rdv/revoke':
        if (this.book.receiveRevoke(payload, this.id)) this.emit('revoked', from);
        return;
      case 'rdv/resend': {
        const c = this.book.contact(from);
        if (!c) return;
        const lo = Number(payload.from_seq);
        const hi = Number(payload.to_seq);
        for (const e of this.outbox[from] ?? []) {
          if (e.seq >= lo && e.seq <= hi) await this.transport.sendEnvelope(e, relaysOf(c.card));
        }
        return;
      }
      default:
        if (!this.book.admitInbound(from)) return this.drop('no grant for sender', from);
        this.emit('message', from, payload, env);
    }
  }

  private drop(reason: string, detail?: unknown): void {
    this.emit('dropped', reason, detail);
  }
}

export function relaysOf(card: AddressCard): string[] {
  return card.rendezvous.flatMap((h) => (h.type === 'nostr' ? [h.relay] : []));
}
