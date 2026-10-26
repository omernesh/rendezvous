// An agent ties the layers together: identity + card, contact book (consent),
// per-peer channels (ordering), and a transport. It holds no LLM and makes no
// judgment calls — the owner (human, CLI script, or MCP host) decides on
// pending requests through `grant` / `decline`.
import { EventEmitter } from 'node:events';
import { type AddressCard, type CardOptions, createCard, type DiscoveryAddress, missingCapabilities, newerCard, reissueCard, reissueCardCapabilities, reissueCardRelays, verifyCard } from './card.js';
import {
  type Contact,
  ContactBook,
  type ContactBookState,
  type ContactRequest,
  type GrantCandidate,
  type GrantScope,
  type ProbeOverflow,
  type PendingRequest,
  type TaskAbuse,
  type TaskAdmission,
  type Tier,
  createContactRequest,
  createGrant,
  createReverseGrant,
  createRevoke,
  defaultTier,
  grantScope,
  isReverseGrant,
  MEETING_CAPABILITIES,
  verifyContactRequest,
} from './contact.js';
import { type Binding, canonAgentId, dtopic, idtopic, normalizeAddresses, topicForHint } from './discovery.js';
import { b64decode, b64encode, parseTimestamp } from './encoding.js';
import {
  Channels,
  type ChannelState,
  type Envelope,
  type Payload,
  type RefusedChannel,
  openEnvelope,
  sealEnvelope,
} from './envelope.js';
import {
  GROUP_CONTROL_LIMIT,
  GROUP_INVITE_TYPE,
  GROUP_JOIN_TYPE,
  GROUP_MEMBERS_TYPE,
  GROUP_STATE_TYPE,
  GROUP_TYPES,
  GROUPS_EXTENSION,
  GroupBook,
  type GroupBookState,
  type GroupChange,
  type GroupContext,
  type GroupInvite,
  type GroupJoin,
  type GroupRecord,
  type GroupScope,
  memberIds,
  membersPayloads,
  type NewcomerPolicy,
  type ReceivedInvite,
} from './group.js';
import { type AgentKey, generateKey, keyFromSecret } from './identity.js';
import type { MirrorOptions, MirrorReport, Transport } from './transport/transport.js';

const OUTBOX_LIMIT = 64;
/** Gap buffer bounds: per peer (OUTBOX_LIMIT envelopes) and across peers. */
const BUFFER_PEER_LIMIT = 16;
/** The scope the owner grants when it doesn't pick one. */
/** The scope the owner grants when it doesn't pick one: meetings, and no other capability (§5.3). */
export const DEFAULT_GRANT_SCOPE: Readonly<GrantScope> = Object.freeze({
  may_initiate: true,
  may_propose_meetings: true,
  max_frequency: '100/day',
  invoke: Object.freeze(Object.fromEntries(MEETING_CAPABILITIES.map((u) => [u, Object.freeze({})]))) as GrantScope['invoke'],
});
/** `rdv/resend` requests we honor per contact (each can make us republish up to OUTBOX_LIMIT envelopes). */
export const RESEND_LIMIT = { count: 10, windowMs: 3_600_000 };
/** Reverse grants we process per contact (each one rewrites the contact; NOTES 60). */
export const REVERSE_GRANT_LIMIT = { count: 10, windowMs: 3_600_000 };
/** Card updates we apply per contact (each one rewrites the contact; NOTES 82). */
export const CARD_UPDATE_LIMIT = { count: 20, windowMs: 3_600_000 };
export const CARD_UPDATE_TYPE = 'rdv/card-update';
const CONTROL_TYPES = new Set(['rdv/contact-request', 'rdv/contact-grant', 'rdv/revoke', 'rdv/resend', CARD_UPDATE_TYPE, ...GROUP_TYPES]);

/** What a contact's new card changed (NOTES 82): relays and capabilities, as lists. */
export interface CardChange {
  relays: { added: string[]; removed: string[] };
  capabilities: { added: string[]; removed: string[] };
  /** Whether the card's discovery addresses changed (its own claims, never a label). */
  addresses_changed: boolean;
}

/** A contact's card replaced by an `rdv/card-update`. */
export interface CardUpdate {
  contact: Contact;
  previous: AddressCard;
  change: CardChange;
}

/** What `sendCardUpdates` did: the contacts that got our current card, and the ones whose send failed (retried by the next one). */
export interface CardUpdateReport {
  sent: string[];
  failed: Array<{ peer: string; error: string }>;
}

export function cardChange(previous: AddressCard, next: AddressCard): CardChange {
  const diff = (a: string[], b: string[]) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
  const caps = (c: AddressCard) => (Array.isArray(c.capabilities) ? c.capabilities : []);
  const addrs = (c: AddressCard) => JSON.stringify((c.discovery?.addresses ?? []).map((a) => `${a.type}:${a.value}`).sort());
  return {
    relays: diff(relaysOf(previous), relaysOf(next)),
    capabilities: diff(caps(previous), caps(next)),
    addresses_changed: addrs(previous) !== addrs(next),
  };
}

export interface AgentState {
  secretKey: string;
  card: AddressCard;
  book: ContactBookState;
  channels: Record<string, ChannelState>;
  outbox: Record<string, Envelope[]>;
  /** Out-of-order envelopes waiting for a gap to fill (kept so a restart doesn't lose them). */
  buffer?: Record<string, Envelope[]>;
  /**
   * Per contact, the `created` of our card it was last sent (in our grant or
   * an `rdv/card-update`), so `sendCardUpdates` sends each contact a newer
   * card once (NOTES 82). Absent for contacts made before it: they get one.
   */
  cardSent?: Record<string, string>;
  /** Groups (SPEC §7.8): their states, invites waiting for our human, our open invites. Absent until the first. */
  groups?: GroupBookState;
}

/** A failed send in a group fan-out (the others still went). */
export interface GroupSendFailure {
  peer: string;
  error: string;
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
  /** A contact's human granted us rights towards it: `outboundScope` changed (NOTES 60). */
  'reverse-grant': [Contact];
  /** A contact sent its newer card (`rdv/card-update`): we now reach it on its relays and see its capabilities. Nothing the human approved changed. */
  'card-update': [CardUpdate];
  message:[peer: string, payload: Payload, envelope: Envelope];
  revoked: [peer: string];
  /**
   * We revoked a contact's grant for gross abuse of per-capability limits
   * (§5.3 (b)); an `rdv/revoke` went to the peer. Distinct from `revoked`
   * (the peer revoked us) and from the grant-wide `max_frequency` revoke.
   */
  'task-abuse': [TaskAbuse];
  /** A contact (an admin) invited us to a group: waiting for our human (`joinGroup` / `declineGroupInvite`). */
  'group-invite': [ReceivedInvite];
  /** The invite list was full and the oldest invite was dropped; `total` counts all such drops. */
  'group-invites-evicted': [total: number];
  /**
   * A group state was applied: members added or removed, newcomers now
   * waiting for our human (policy `ask`), the state that admitted us, or the
   * one that removed us. As admin, also after we added a joiner.
   */
  'group-state': [GroupChange];
  /** Two states at one epoch from one admin (§7.8.6): the group's membership is frozen until our human re-syncs it. */
  'group-fork': [GroupRecord];
  dropped: [reason: string, detail?: unknown];
  error: [Error];
}

export class Agent extends EventEmitter<AgentEvents> {
  readonly book: ContactBook;
  readonly channels: Channels;
  readonly groups: GroupBook;
  private outbox: Record<string, Envelope[]>;
  private buffer: Record<string, Envelope[]>;
  private cardSent: Record<string, string>;
  private unsubscribers: Array<() => void> = [];
  /** The discovery-topic subscription, kept apart so `setAddresses` can replace it. */
  private topicUnsub?: () => void;
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
    state?: Partial<Pick<AgentState, 'book' | 'channels' | 'outbox' | 'buffer' | 'cardSent' | 'groups'>>,
  ) {
    super();
    this.book = new ContactBook({ policy: card.policy.inbound, ...state?.book });
    this.channels = new Channels(state?.channels ?? {});
    this.outbox = state?.outbox ?? {};
    this.buffer = state?.buffer ?? {};
    this.cardSent = state?.cardSent && typeof state.cardSent === 'object' ? { ...state.cardSent } : {};
    this.groups = new GroupBook(state?.groups && typeof state.groups === 'object' ? state.groups : undefined);
    this.pruneChannels(); // state saved before NOTES 64 may hold strangers' channels
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
      channels: this.channelsToPersist(),
      outbox: this.outbox,
      buffer: this.bufferToPersist(),
      cardSent: Object.fromEntries(Object.entries(this.cardSent).filter(([peer]) => Object.hasOwn(this.book.state.contacts, peer))),
      ...(this.groups.isEmpty() ? {} : { groups: this.groups.toJSON() }),
    };
  }

  get id(): string {
    return this.key.id;
  }

  /** Listen for envelopes and on our own discovery topics (listen mode, §4.4). */
  start(): void {
    this.unsubscribers.push(this.transport.onEnvelopes(this.id, (raw) => this.enqueue(() => this.handleEnvelope(raw))));
    this.subscribeTopics();
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) u();
    this.topicUnsub?.();
    this.topicUnsub = undefined;
  }

  /** The discovery topics we listen on: one per address listed on our card (§4.3, §4.4). */
  topics(): string[] {
    return (this.card.discovery?.addresses ?? []).map(dtopic);
  }

  private subscribeTopics(): void {
    this.topicUnsub?.();
    this.topicUnsub = this.transport.onTopics(this.topics(), (doc, topic) => this.enqueue(() => this.handleTopicDoc(doc, topic)));
  }

  /**
   * Replace the addresses listed on our card (the owner's own setup, never a
   * peer's): canonicalized, deduplicated, at most MAX_ADDRESSES. The card is
   * re-signed with a later `created`; if the agent is listening, it moves to
   * the new set of topics at once, and a probe on a dropped topic is refused
   * from now on. Contacts are untouched. Call `publishPointers(removed)`
   * afterwards to replace the card on the relays.
   */
  setAddresses(
    addresses: DiscoveryAddress[],
    opts: { publicPointer?: boolean; now?: Date } = {},
  ): { card: AddressCard; added: DiscoveryAddress[]; removed: DiscoveryAddress[] } {
    const next = normalizeAddresses(addresses);
    const prev = this.card.discovery?.addresses ?? [];
    const key = (a: DiscoveryAddress) => `${a.type}:${a.value}`;
    const added = next.filter((a) => !prev.some((p) => key(p) === key(a)));
    const removed = prev.filter((p) => !next.some((a) => key(p) === key(a)));
    const publicPointer = opts.publicPointer ?? this.card.discovery?.public_pointer ?? false;
    this.card = reissueCard(this.key, this.card, { addresses: next, public_pointer: publicPointer }, opts.now);
    if (this.topicUnsub) this.subscribeTopics();
    return { card: this.card, added, removed };
  }

  /**
   * Make the card advertise `capabilities`, what this software now routes
   * (§4.3; issue #43: a card signed by older code lacks tasks/v1). Re-signed
   * with a later `created` only when the card lacks one of them; identity,
   * contacts, addresses and hints are untouched. Returns whether it changed;
   * call `publishPointers()` afterwards to replace the card on the relays.
   */
  refreshCapabilities(capabilities: readonly string[], opts: { now?: Date } = {}): boolean {
    const next = missingCapabilities(this.card, capabilities);
    if (!next) return false;
    this.card = reissueCardCapabilities(this.key, this.card, next, opts.now);
    return true;
  }

  /**
   * Replace the relays on our card (the owner's own setup, `rdv relays`):
   * re-signed with a later `created`, the relays as its `nostr` hints in this
   * order. The transport moves to them if it can (`Transport.setRelays`).
   * Contacts keep the card they hold until they get a newer one. Call
   * `publishPointers()` afterwards to replace the card on the relays.
   */
  setRelays(relays: readonly string[], opts: { mirrorRelays?: readonly string[]; now?: Date } = {}): AddressCard {
    this.card = reissueCardRelays(this.key, this.card, relays, opts.now);
    this.transport.setRelays?.(relays, opts.mirrorRelays);
    return this.card;
  }

  /** Active contacts that have not been sent our current card yet (NOTES 82). */
  cardUpdatesDue(now = new Date()): string[] {
    return this.contacts()
      .filter((c) => this.book.contact(c.peer, now) && !this.book.isBlocked(c.peer))
      .filter((c) => this.cardSent[c.peer] !== this.card.created)
      .map((c) => c.peer);
  }

  /**
   * Send our current card to every active contact that has not had it
   * (`rdv/card-update`, SPEC §4.3, NOTES 82), so they reach us on our current
   * relays and see our current capabilities. Call it after re-signing the
   * card (`setRelays`, `setAddresses`, `refreshCapabilities`) and at a
   * listener's start (a contact made before this existed, or a send that
   * failed, gets it then). `alsoRelays` (our relays before a change) get the
   * envelopes too, besides our relays now and the contact's: a contact that
   * still sends to and reads from the old set is reached there. One failed
   * send does not stop the others; that contact stays due.
   */
  async sendCardUpdates(opts: { alsoRelays?: readonly string[] } = {}): Promise<CardUpdateReport> {
    const report: CardUpdateReport = { sent: [], failed: [] };
    const card = this.card;
    for (const peer of this.cardUpdatesDue()) {
      const c = this.book.contact(peer);
      if (!c) continue;
      try {
        await this.deliver(peer, { type: CARD_UPDATE_TYPE, card } as Payload, [...new Set([...relaysOf(c.card), ...(opts.alsoRelays ?? [])])]);
        this.cardSent[peer] = card.created;
        report.sent.push(peer);
      } catch (err) {
        report.failed.push({ peer, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  close(): void {
    this.stop();
    this.transport.close();
  }

  /** Resolves once every inbound event received so far has been processed. */
  idle(): Promise<void> {
    return this.queue;
  }

  /**
   * Public pointer mode: publish our card on each discovery topic (opt-in),
   * as a replaceable event, so it supersedes the card we published there
   * before. `alsoOn` are addresses we no longer list (just removed): the
   * current card goes there too, so a lookup for them finds a newer card that
   * no longer claims them (NOTES 63). `extraRelays` get it too besides ours
   * (a relay just dropped by `setRelays`, so it serves the newer card). Returns
   * the topics published on: the address topics, then our agent ID's topic
   * (`idtopic`, NOTES 83), where a requester holding only our ID finds it.
   */
  async publishPointers(alsoOn: DiscoveryAddress[] = [], extraRelays: string[] = []): Promise<string[]> {
    const topics = this.pointerTopics(alsoOn);
    if (topics.length === 0) return [];
    const createdAt = Math.floor((parseTimestamp(this.card.created) ?? 0) / 1000);
    for (const topic of topics) await this.transport.publishTopic(topic, this.card, extraRelays, { replaceable: true, createdAt });
    return topics;
  }

  /**
   * Mirror our card for discovery (NOTES 81): on each of our address topics
   * and our agent ID's topic (NOTES 83), to our relays and then to
   * `opts.relays`, one relay at a time (see `NostrTransport.mirrorTopics`).
   * Public pointer only, like
   * `publishPointers`. Throws if the transport cannot mirror.
   */
  async mirrorPointers(opts: MirrorOptions): Promise<MirrorReport> {
    if (!this.card.discovery?.public_pointer || !this.card.policy.public) throw new Error('public pointer is off for this agent');
    if (!this.transport.mirrorTopics) throw new Error('this transport cannot mirror cards');
    const createdAt = Math.floor((parseTimestamp(this.card.created) ?? 0) / 1000);
    return this.transport.mirrorTopics(this.pointerTopics().map((topic) => ({ topic, doc: this.card, createdAt })), opts);
  }

  /**
   * Where the public card goes (public pointer on, else nothing): the topic of
   * each listed address and of each of `alsoOn`, then the agent ID's topic.
   * The ID topic follows the same opt-in as the address topics: without the
   * public pointer the card (and the addresses it lists) is on no relay at
   * all, and publishing it by ID would put it there (NOTES 83).
   */
  private pointerTopics(alsoOn: DiscoveryAddress[] = []): string[] {
    if (!this.card.discovery?.public_pointer || !this.card.policy.public) return [];
    return [...new Set([...[...this.card.discovery.addresses, ...alsoOn].map(dtopic), idtopic(this.id)])];
  }

  /**
   * Look up public pointers for an address. Per agent only its newest valid
   * card counts, and it comes back only if it still claims the address: an
   * older card that did (replayed, or kept by a relay) loses to the newer one.
   */
  async lookup(address: string): Promise<AddressCard[]> {
    const topic = topicForHint(address);
    if (!topic) return [];
    const docs = await this.transport.fetchTopic(topic);
    const newest = new Map<string, AddressCard>();
    for (const d of docs) {
      const check = verifyCard(d);
      if (!check.ok || check.card.id === this.id) continue;
      const had = newest.get(check.card.id);
      newest.set(check.card.id, had ? newerCard(had, check.card) : check.card);
    }
    return [...newest.values()].filter((c) => c.discovery?.addresses.some((a) => topicForHint(a.value) === topic));
  }

  /**
   * Fetch an agent's public card by its agent ID (NOTES 83): from the ID's
   * topic on our relays and the discovery mirrors. Only a card that verifies
   * and whose `id` is the requested ID counts (anyone can post on any topic),
   * and of those the newest. Null when no relay serves one, and for our own
   * ID. Throws on a malformed ID. The card's address claims prove nothing.
   */
  async lookupById(agentId: string): Promise<AddressCard | null> {
    const id = canonAgentId(agentId);
    if (id === this.id) return null;
    let newest: AddressCard | null = null;
    for (const d of await this.transport.fetchTopic(idtopic(id))) {
      const check = verifyCard(d);
      if (!check.ok || check.card.id !== id) continue;
      newest = newest ? newerCard(newest, check.card) : check.card;
    }
    return newest;
  }

  /** Whether our relays serve our current card on our agent ID's topic (the read-back after publishing, like ownCardOn). */
  async ownCardById(): Promise<boolean> {
    let newest: AddressCard | undefined;
    for (const d of await this.transport.fetchTopic(idtopic(this.id), undefined, { mirrors: false })) {
      const check = verifyCard(d);
      if (!check.ok || check.card.id !== this.id) continue;
      newest = newest ? newerCard(newest, check.card) : check.card;
    }
    return !!newest && newest.created === this.card.created && newest.sig === this.card.sig;
  }

  /**
   * Whether the relays serve our own current card on an address's topic: the
   * check after publishing (lookup never returns our own card, so it can't be
   * used for that). True only if our newest valid card there is the one we
   * hold now and it still claims the address. Never a discovered peer.
   */
  async ownCardOn(address: string): Promise<boolean> {
    const topic = topicForHint(address);
    if (!topic) return false;
    let newest: AddressCard | undefined;
    // Our relays only: they are where publishPointers just put it (a mirror may hold an older copy, which loses anyway).
    for (const d of await this.transport.fetchTopic(topic, undefined, { mirrors: false })) {
      const check = verifyCard(d);
      if (!check.ok || check.card.id !== this.id) continue;
      newest = newest ? newerCard(newest, check.card) : check.card;
    }
    if (!newest || newest.created !== this.card.created || newest.sig !== this.card.sig) return false;
    return newest.discovery?.addresses.some((a) => topicForHint(a.value) === topic) === true;
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
    opts: { binding?: Binding; label?: string } = {},
  ): Promise<ContactRequest> {
    const toHint = typeof target === 'string' ? target : target.id;
    const binding: Binding = typeof target === 'string' ? 'claimed' : (opts.binding ?? 'claimed');
    const req = createContactRequest(this.key, this.card, { toHint, greeting });
    this.book.trackOutstanding(req, binding, typeof target === 'string' ? undefined : target.id, opts.label);
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
  async grant(requestId: string, opts: { tier?: Tier; scope?: GrantScope; expires?: string | null; label?: string } = {}): Promise<Contact> {
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
  confirmCandidate(grantId: string, opts: { label?: string } = {}): Contact {
    const sentCard = this.requestCard(this.book.state.candidates[grantId]?.request_ref);
    const contact = this.book.confirmCandidate(grantId, new Date(), opts.label);
    if (sentCard) this.cardSent[contact.peer] = sentCard;
    this.emit('contact', contact);
    return contact;
  }

  rejectCandidate(grantId: string, opts: { block?: boolean } = {}): GrantCandidate | undefined {
    return this.book.rejectCandidate(grantId, opts.block);
  }

  /**
   * Owner grants an existing contact rights towards us (ContactBook.allowInbound),
   * then tells the peer with a signed reverse grant, so it may use them, e.g.
   * propose a meeting (NOTES 60). Only the owner calls this; nothing in the
   * library does on a peer's behalf.
   */
  async allowInbound(peer: string, opts: { tier?: Tier; scope?: GrantScope } = {}): Promise<Contact> {
    const c = this.book.contact(peer);
    if (!c) throw new Error(`no active contact ${peer}`);
    const tier = opts.tier ?? defaultTier(c.binding);
    // Both fields, consistent (§5.3): the peer may run an older version that reads only may_propose_meetings.
    const scope = grantScope(opts.scope ?? DEFAULT_GRANT_SCOPE);
    const contact = this.book.allowInbound(peer, { tier, scope });
    // Our rights for the peer end with the contact itself.
    const grant = createReverseGrant(this.key, this.card, contact, { tier, scope: grantScope(scope), expires: contact.expires });
    await this.deliver(peer, grant, relaysOf(contact.card));
    return contact;
  }

  async revoke(peer: string): Promise<void> {
    const c = this.book.contact(peer);
    this.book.revoke(peer);
    this.groups.forgetPeer(peer);
    if (c) await this.deliver(peer, createRevoke(this.key, peer, c.grantId), relaysOf(c.card));
  }

  /**
   * `ContactBook.admitTask`, plus the revoke for gross abuse: when the answer
   * carries `abuse`, the grant is revoked at once (later tasks in the same
   * batch are refused), an `rdv/revoke` is queued to the peer (it goes
   * through `beforeSend`, so the cleared counters are saved first; await
   * `idle()`), and `task-abuse` is emitted for the human. Synchronous, so a
   * task engine can call it as its limiter.
   */
  admitTask(peer: string, capability: string, opts: { open?: number; maxOpen?: number } = {}, now = new Date()): TaskAdmission {
    const c = this.book.contact(peer, now);
    const answer = this.book.admitTask(peer, capability, opts, now);
    if (!answer.ok && answer.code === 'rate' && answer.abuse && c) {
      const abuse = answer.abuse;
      this.book.revoke(peer);
      this.enqueue(() => this.deliver(peer, createRevoke(this.key, peer, c.grantId), relaysOf(c.card)).then(() => undefined));
      this.emit('task-abuse', abuse);
    }
    return answer;
  }

  contacts(): Contact[] {
    return Object.values(this.book.state.contacts);
  }

  // --- groups (SPEC §7.8) -----------------------------------------------------

  private groupCtx(now = new Date()): GroupContext {
    return { me: this.id, isContact: (p) => !!this.book.contact(p, now) && !this.book.isBlocked(p), now };
  }

  /** A contact, or another member of a group we are in (or the admin a join of ours waits on). */
  private isGroupPeer(peer: string): boolean {
    return !!this.book.contact(peer) || this.groups.admittedPeers(this.id).has(peer);
  }

  /** Groups we are in, joining, or were removed from. */
  groupList(): GroupRecord[] {
    return this.groups.records();
  }

  /**
   * A new group with us as its only member and admin (epoch 0). `scope` is
   * our own group-scoped grant (what members may invoke on us through the
   * group; default nothing). No message leaves.
   */
  createGroup(name: string, opts: { scope?: GroupScope; policy?: NewcomerPolicy; now?: Date } = {}): GroupRecord {
    return this.groups.create(this.key, this.card, { name, scope: opts.scope, policy: opts.policy, now: opts.now });
  }

  /**
   * Invite a contact to a group we administer (§7.8.2). Only an active,
   * unblocked contact whose card lists the groups extension is invited; the
   * invite carries the group's current state. `name` is how the group's state
   * will name the invitee to the others (display text our human gives; never
   * our local label unless they typed it).
   */
  async inviteToGroup(groupId: string, peer: string, opts: { greeting?: string; name?: string; expires?: string } = {}): Promise<GroupInvite> {
    const c = this.book.contact(peer);
    if (!c || this.book.isBlocked(peer)) throw new Error(`only contacts are invited, and ${peer} is not an active contact`);
    if (!(Array.isArray(c.card.capabilities) && c.card.capabilities.includes(GROUPS_EXTENSION))) {
      throw new Error("the contact's card does not list groups, so its agent may not support them");
    }
    const invite = this.groups.invite(this.key, groupId, peer, opts);
    await this.deliver(peer, invite, relaysOf(c.card));
    return invite;
  }

  /** Invites waiting for our human (expired ones dropped). */
  groupInvites(): ReceivedInvite[] {
    this.groups.prune();
    return this.groups.invites();
  }

  /**
   * Our human approved joining (§5.5): our join document, a group-scoped grant
   * (`scope`, what members may invoke on us through the group), goes to the
   * inviting admin, and the group waits for the state that admits us. Only
   * for the human's own decision: never on a model's or a peer's say-so, and
   * no standing approval covers it (§5.5.1).
   */
  async joinGroup(inviteId: string, opts: { scope?: GroupScope; policy?: NewcomerPolicy } = {}): Promise<GroupRecord> {
    const entry = Object.hasOwn(this.groups.state.invites, inviteId) ? this.groups.state.invites[inviteId] : undefined;
    if (!entry) throw new Error(`no pending group invite ${inviteId}`);
    const admin = entry.invite.from;
    const c = this.book.contact(admin);
    if (!c || this.book.isBlocked(admin)) throw new Error('the admin who invited us is no longer an active contact');
    const { join, record } = this.groups.join(this.key, this.card, inviteId, opts);
    await this.deliver(admin, join, relaysOf(c.card));
    return record;
  }

  /** Our human said no to an invite (reduce-only; nothing is sent). */
  declineGroupInvite(inviteId: string): ReceivedInvite | undefined {
    return this.groups.decline(inviteId);
  }

  /** Our human approved a newcomer under `ask`: from now on it may receive our group traffic. Never automatic (§5.5.1). */
  approveGroupNewcomer(groupId: string, member: string): GroupRecord {
    return this.groups.approveNewcomer(groupId, member);
  }

  /** Our human checked with the admin after a membership fork: the group thaws at the state we hold (§7.8.6). */
  resyncGroup(groupId: string): GroupRecord {
    return this.groups.resync(groupId);
  }

  /** Send to a contact, or to a group co-member on the card its join carries (pinned by the state). */
  private async deliverTo(peer: string, payload: { type: string }): Promise<Envelope> {
    const c = this.book.contact(peer);
    const card = c ? c.card : this.groups.memberCard(peer);
    if (!card) throw new Error(`no card to reach ${peer}`);
    return this.deliver(peer, payload, relaysOf(card));
  }

  /**
   * As admin, after a state that adds `added`: the state to every other
   * member (blocked keys excepted), the newcomers' joins to the others, and
   * everyone else's joins to the newcomers (§7.8.2). One failed send does not
   * stop the rest; its envelope stays in the outbox for a resend.
   */
  private async fanOutState(r: GroupRecord, added: string[]): Promise<void> {
    const state = r.state;
    const joinsOf = (ids: string[]): GroupJoin[] => ids.flatMap((id) => (Object.hasOwn(r.joins, id) ? [r.joins[id]] : []));
    for (const peer of memberIds(state)) {
      if (peer === this.id || this.book.isBlocked(peer)) continue;
      try {
        await this.deliverTo(peer, state);
        const joins = added.includes(peer) ? joinsOf(memberIds(state).filter((id) => id !== peer)) : joinsOf(added.filter((id) => id !== peer));
        for (const p of membersPayloads(state.group, joins)) await this.deliverTo(peer, p);
      } catch (err) {
        this.drop('group fan-out send failed', { peer, group: state.group, error: err instanceof Error ? err.message : String(err) });
      }
    }
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

  /** `created` of the card our outstanding request carried (what its grantor holds of ours). */
  private requestCard(requestRef: unknown): string | undefined {
    if (typeof requestRef !== 'string' || !Object.hasOwn(this.book.state.outstanding, requestRef)) return undefined;
    return this.book.state.outstanding[requestRef].card_created;
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
    opts: { tier?: Tier; scope?: GrantScope; expires?: string | null; label?: string },
  ): Promise<Contact> {
    const grant = createGrant(this.key, this.card, request, {
      tier: opts.tier ?? defaultTier(binding),
      // Both fields, consistent (§5.3); throws on a malformed invoke before anything is recorded or sent.
      scope: grantScope(opts.scope ?? DEFAULT_GRANT_SCOPE),
      expires: opts.expires,
    });
    const contact = this.book.recordIssuedGrant(grant, request, binding, opts.label);
    this.cardSent[request.from] = this.card.created; // the grant carries our card
    await this.deliver(request.from, grant, relaysOf(request.card));
    this.emit('contact', contact);
    return contact;
  }

  private async handleTopicDoc(doc: unknown, topic: string): Promise<void> {
    if (!verifyContactRequest(doc)) return this.drop('topic doc is not a valid contact request');
    if (doc.from === this.id) return;
    // Bound to where it arrived (security review L2): a probe for someone else,
    // re-posted on our topic, is not a probe for us.
    const ours = this.topics();
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

    try {
      await this.handleOpened(env, opened.payload);
    } finally {
      // Only admitted senders keep channel state; a stranger's goes with its envelope (NOTES 64).
      this.pruneChannels();
    }
  }

  private async handleOpened(env: Envelope, payload: Payload): Promise<void> {
    const order = this.channels.acceptInbound(env, { adopt: !this.keepsChannel(env.from) });
    if (order.kind === 'duplicate') return;
    if (order.kind === 'fork' || order.kind === 'rollback' || order.kind === 'refused') return this.dropForked(env, order);
    if (order.kind === 'gap') {
      this.bufferEnvelope(env);
      const c = this.book.contact(env.from);
      if (c) {
        const resend: Payload = { type: 'rdv/resend', from_seq: order.missingFrom, to_seq: order.missingTo };
        await this.deliver(c.peer, resend, relaysOf(c.card));
      }
      return;
    }

    await this.dispatch(env, payload);
    await this.drainBuffer(env.from);
  }

  /**
   * Senders whose channel state we keep (NOTES 64): contacts (expired ones
   * too), allowlisted agents, pending requesters, probe candidates, agents we
   * asked by card, and anyone we have sent to. Every entry but the pending
   * requests (capped, NOTES 46) and probe candidates (capped per probe, and
   * probes are our own) stems from our human's actions, so a flood of fresh
   * keys can't grow this.
   */
  private keepsChannel(peer: string, kept = this.keptPeers()): boolean {
    return kept.has(peer) || (this.channels.state[peer]?.outSeq ?? 0) > 0;
  }

  private keptPeers(): Set<string> {
    const b = this.book.state;
    const kept = this.book.outstandingTargets();
    for (const peer of Object.keys(b.contacts)) kept.add(peer);
    for (const peer of Object.keys(b.allowlist)) kept.add(peer);
    for (const p of Object.values(b.pending)) kept.add(p.request.from);
    for (const c of Object.values(b.candidates)) kept.add(c.grant.from);
    // Group members while both are members (§6.4, §7.8.2), bounded by groups × members, never by peers.
    for (const peer of this.groups.admittedPeers(this.id)) kept.add(peer);
    return kept;
  }

  /** Forget the channels of senders we don't keep (a declined or evicted requester, a stranger). */
  private pruneChannels(): void {
    const kept = this.keptPeers();
    for (const peer of Object.keys(this.channels.state)) if (!this.keepsChannel(peer, kept)) this.channels.forget(peer);
  }

  private channelsToPersist(): Record<string, ChannelState> {
    const kept = this.keptPeers();
    return Object.fromEntries(Object.entries(this.channels.state).filter(([peer]) => this.keepsChannel(peer, kept)));
  }

  /** Only contacts (or agents we asked by card) may park envelopes with us. */
  private mayBuffer(peer: string): boolean {
    return !!this.book.contact(peer) || this.book.outstandingTargets().has(peer) || this.groups.admittedPeers(this.id).has(peer);
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
      if (order.kind === 'fork' || order.kind === 'rollback' || order.kind === 'refused') this.dropForked(next, order);
      if (order.kind !== 'in-order') continue;
      const opened = openEnvelope(this.key, next);
      if (opened.ok) await this.dispatch(next, opened.payload);
      // The chain moves on either way (it would stall otherwise), but say so (L4).
      else this.drop(`buffered envelope lost (${opened.reason})`, next.seq);
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
        if (isReverseGrant(payload)) {
          // Rate-limited per contact only: a stranger's grant is refused below without touching state.
          if (this.book.contact(from) && !this.book.admitControl('reverse-grant', from, REVERSE_GRANT_LIMIT)) {
            return this.drop('reverse grant rate-limited', from);
          }
          const rev = this.book.receiveReverseGrant(payload, this.id);
          if ('rejected' in rev) return this.drop('unexpected or invalid grant', `reverse grant: ${rev.rejected}`);
          this.emit('reverse-grant', rev.contact);
          return;
        }
        const sentCard = this.requestCard((payload as { request_ref?: unknown }).request_ref);
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
        if (sentCard) this.cardSent[got.contact.peer] = sentCard;
        this.emit('contact', got.contact);
        return;
      }
      case 'rdv/revoke':
        if (this.book.receiveRevoke(payload, this.id)) {
          this.groups.forgetPeer(from);
          this.emit('revoked', from);
        }
        return;
      case CARD_UPDATE_TYPE: {
        // Rate-limited per contact only: a stranger's update is refused below without touching state.
        if (!this.book.contact(from)) return this.drop('card update from a non-contact', from);
        if (!this.book.admitControl('card-update', from, CARD_UPDATE_LIMIT)) return this.drop('card update rate-limited', { peer: from });
        // A new ws:// relay only when we are on one ourselves (a test or dev setup; NOTES 82).
        const got = this.book.receiveCardUpdate(payload.card, from, new Date(), { allowWs: relaysOf(this.card).some((r) => r.startsWith('ws://')) });
        if ('unchanged' in got) return;
        if ('rejected' in got) return this.drop(`card update rejected: ${got.reason}`, { peer: from, code: got.rejected });
        this.emit('card-update', { contact: got.contact, previous: got.previous, change: cardChange(got.previous, got.contact.card) });
        return;
      }
      case GROUP_INVITE_TYPE: {
        // Only contacts invite (§7.8.2): a stranger's invite is dropped before any state is kept.
        if (!this.book.contact(from)) return this.drop('group invite from a non-contact', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        const out = this.groups.receiveInvite(payload, from, this.groupCtx());
        if (out.status === 'pending') {
          if (out.evicted) this.emit('group-invites-evicted', this.groups.state.invitesEvicted ?? 1);
          this.emit('group-invite', out.invite);
          return;
        }
        return this.drop(`group invite ${out.status === 'invalid' ? `invalid: ${out.reason}` : out.status}`, { peer: from });
      }
      case GROUP_JOIN_TYPE: {
        // A join answers an invite of ours, and we invite only contacts.
        if (!this.book.contact(from)) return this.drop('group join from a non-contact', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        const out = this.groups.receiveJoin(this.key, payload, from, this.groupCtx());
        if (!out.ok) return this.drop(`group join ${out.code === 'duplicate' ? 'duplicate' : 'refused'}: ${out.reason}`, { peer: from, code: out.code });
        this.emit('group-state', out.change);
        await this.fanOutState(out.record, [from]);
        return;
      }
      case GROUP_STATE_TYPE: {
        if (!this.isGroupPeer(from)) return this.drop('group state from a non-member', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        const out = this.groups.receiveState(payload, from, this.groupCtx());
        if (out.kind === 'applied') {
          for (const change of [out.change, ...out.also]) this.emit('group-state', change);
          return;
        }
        if (out.kind === 'fork') {
          this.emit('group-fork', out.record);
          return;
        }
        if (out.kind === 'duplicate' || out.kind === 'future') return;
        return this.drop(`group state ${out.kind}: ${out.reason}`, { peer: from });
      }
      case GROUP_MEMBERS_TYPE: {
        if (!this.isGroupPeer(from)) return this.drop('group members from a non-member', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        const out = this.groups.receiveMembers(payload, from, this.groupCtx());
        if ('rejected' in out) return this.drop(`group members refused: ${out.rejected}`, { peer: from });
        return;
      }
      case 'rdv/resend': {
        const c = this.book.contact(from);
        if (!c) return;
        if (!this.book.admitControl('resend', from, RESEND_LIMIT)) return this.drop('resend rate-limited', from);
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

  /**
   * A peer that forked or rolled back its chain (it restored older state, or
   * two copies of it run) is refused until the owner calls `resyncChannel`:
   * the library never picks a chain on its own (issue #13). A stranger can
   * fork only its own channel, so its drops are quiet (STRANGER_DROPS).
   */
  private dropForked(env: Envelope, order: { kind: 'fork' | 'rollback' | 'refused'; seq: number; accepted: number }): void {
    const detail = { peer: env.from, seq: order.seq, accepted: order.accepted };
    if (!this.mayBuffer(env.from)) return this.drop('envelope chain fork from a non-contact', detail);
    if (order.kind === 'fork') return this.drop('envelope chain fork', detail);
    if (order.kind === 'rollback') return this.drop('envelope chain fork (rollback)', detail);
    this.drop('envelope chain fork (channel refused until resync)', detail);
  }

  /**
   * Owner action after an `envelope chain fork` drop, once they have checked
   * with the peer's human: accept the peer's current chain. The next envelope
   * newer than everything accepted from it so far becomes the chain head;
   * envelopes refused in between are not replayed.
   */
  resyncChannel(peer: string): void {
    this.channels.resync(peer);
    delete this.buffer[peer];
  }

  /** Peers whose channel is refused after a fork or rollback, waiting for `resyncChannel`. */
  refusedChannels(): Array<{ peer: string } & RefusedChannel> {
    return Object.entries(this.channels.state).flatMap(([peer, c]) => (c.refused ? [{ peer, ...c.refused }] : []));
  }

  private drop(reason: string, detail?: unknown): void {
    this.emit('dropped', reason, detail);
  }
}

export function relaysOf(card: AddressCard): string[] {
  return card.rendezvous.flatMap((h) => (h.type === 'nostr' ? [h.relay] : []));
}
