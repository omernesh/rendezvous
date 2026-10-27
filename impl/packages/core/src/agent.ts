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
import {
  ACK_TYPE,
  ackDue,
  ackSeq,
  confirmsDelivery,
  type DeliveryState,
  type DeliverySummary,
  deliveryOf,
  deliverySummary,
  type PeerDelivery,
  RECEIPT_TIMING,
  type ReceiptTiming,
  retryDue,
} from './delivery.js';
import { type Binding, canonAgentId, dtopic, idtopic, normalizeAddresses, topicForHint } from './discovery.js';
import { b64decode, b64encode, parseTimestamp } from './encoding.js';
import {
  Channels,
  type ChannelState,
  type Envelope,
  type Payload,
  type RefusedChannel,
  envelopeHash,
  isExpired,
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
import {
  GROUP_LEAVE_TYPE,
  GROUP_MSG_TYPE,
  GROUP_MSG_TYPES,
  GROUP_PROOF_TYPE,
  GROUP_REPORT_TYPE,
  type GroupBody,
  type GroupDelivery,
  type GroupEffects,
  type GroupEquivocation,
  type GroupGap,
  type GroupMsg,
  type GroupMute,
  type GroupReport,
  createGroupLeave,
  groupRecipients,
  groupResend,
  leaveRecipients,
  prepareGroupMessage,
  receiveGroupLeave,
  receiveGroupMessage,
  receiveGroupProof,
  receiveGroupReport,
  resyncMember,
  takeWaiting,
} from './groupmsg.js';
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
/** A restored agent's notice to a peer (SPEC §6.4.1, NOTES 91): my chain to you starts again here. */
export const RESTORED_TYPE = 'rdv/restored';
/** The peer's answer: my chain to you goes on at `from_seq`. */
export const RESTORED_ACK_TYPE = 'rdv/restored-ack';
/** `rdv/restored` notices we act on per peer: each one re-bases its chain, so a few a day at most. */
export const RESTORED_LIMIT = { count: 3, windowMs: 86_400_000 };
const CONTROL_TYPES = new Set(['rdv/contact-request', 'rdv/contact-grant', 'rdv/revoke', 'rdv/resend', CARD_UPDATE_TYPE, RESTORED_TYPE, RESTORED_ACK_TYPE, ACK_TYPE, ...GROUP_TYPES, ...GROUP_MSG_TYPES]);

/** Envelopes of ours a contact did not confirm, by what happened to them (NOTES 98). */
export interface DeliveryNews {
  peer: string;
  seqs: number[];
}

/** Republished from the outbox: on the backoff (`retry`), or because a relay came back (`reconnect`). */
export interface DeliveryResent extends DeliveryNews {
  reason: 'retry' | 'reconnect';
}

/** Still no receipt after every retry; `since`: when the oldest of them was sent. The owner is told. */
export interface DeliveryUnconfirmed extends DeliveryNews {
  since: string;
}

/** A peer restored its agent from a backup and re-based its chain to us (NOTES 91). */
export interface ContactRestored {
  peer: string;
  /** When the peer says its backup was made (its claim: a timestamp, or null). */
  backup_created: string | null;
  /** Its new chain's first seq, and the last one we had accepted of the old one. */
  seq: number;
  previous_seq: number;
  /** The old chain is refused after a fork or rollback. */
  was_refused?: 'fork' | 'rollback';
  /** True when the chain was refused: nothing was re-based, and the human re-syncs it after checking with them. */
  pending_resync?: true;
}

/** After our own restore: a peer acknowledged our notice; `skipped`: its envelopes we lost with the old copy. */
export interface RestoreConfirmed {
  peer: string;
  skipped: number;
}

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
  /** Set by a restore from a backup (NOTES 91): when, and when the backup was made. */
  restored?: { at: string; backup_created: string };
  /** Delivery receipts per contact (NOTES 98): what it has not confirmed, and the ack we owe it. Absent until the first. */
  delivery?: Record<string, PeerDelivery>;
}

/** A failed send in a group fan-out (the others still went). */
export interface GroupSendFailure {
  peer: string;
  error: string;
}

/** What `sendGroup` did: the signed header, and who got it. */
export interface GroupSendReport {
  msg: GroupMsg;
  sent: string[];
  failed: GroupSendFailure[];
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
  /** A member's group message (§7.8.3), in its chain's order. The body is that member's words (peer text). */
  'group-message': [GroupDelivery];
  /** A member signed two conflicting board messages (§7.8.6): its group messages are refused until our human re-syncs it. */
  'group-equivocation': [GroupEquivocation];
  /** A member's board messages never came (a group resend did not fill the gap): it may have left us out. The chain moved on. */
  'group-gap': [GroupGap];
  /** A member went over member_rate or our ceiling (§7.8.7): muted until our human re-syncs it; the admins were told. */
  'group-mute': [GroupMute];
  /** As admin: a member reported muting another (§7.8.7). Nothing was removed. */
  'group-report': [GroupReport];
  /** A member left a group (rdv/group-leave, §7.8.5): nothing more goes to it. */
  'group-left': [{ group: string; member: string }];
  /** A contact restored its agent from a backup: its chain to us starts again (`rdv/restored`, NOTES 91). Tell the human. */
  'contact-restored': [ContactRestored];
  /** After our own restore: a contact acknowledged our notice; its chain to us goes on. */
  'restore-confirmed': [RestoreConfirmed];
  /** Envelopes a contact has not confirmed were published again (NOTES 98). */
  'delivery-resent': [DeliveryResent];
  /** A contact never confirmed these envelopes, after every retry: tell the human ("not confirmed delivered"). */
  'delivery-unconfirmed': [DeliveryUnconfirmed];
  /** A contact confirmed envelopes we had reported as not confirmed: they arrived after all. */
  'delivery-confirmed': [DeliveryNews];
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
  private delivery: Record<string, PeerDelivery>;
  /** Receipt and resend timing (NOTES 98); a host may shorten it for tests. */
  receiptTiming: ReceiptTiming = RECEIPT_TIMING;
  /** Whether we confirm what contacts send (NOTES 98, the owner's opt-out). Their envelopes are still received and waited for. */
  sendReceipts = true;
  private tickQueued = false;
  private resendQueued = false;
  /** Our own restore from a backup, if this state came from one (NOTES 91). */
  restored?: { at: string; backup_created: string };
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
    state?: Partial<Pick<AgentState, 'book' | 'channels' | 'outbox' | 'buffer' | 'cardSent' | 'groups' | 'restored' | 'delivery'>>,
  ) {
    super();
    this.book = new ContactBook({ policy: card.policy.inbound, ...state?.book });
    this.channels = new Channels(state?.channels ?? {});
    this.outbox = state?.outbox ?? {};
    this.buffer = state?.buffer ?? {};
    this.cardSent = state?.cardSent && typeof state.cardSent === 'object' ? { ...state.cardSent } : {};
    this.delivery = {};
    for (const [peer, d] of Object.entries(state?.delivery && typeof state.delivery === 'object' ? state.delivery : {})) {
      if (d && typeof d === 'object' && typeof d.acked === 'number' && Array.isArray(d.pending)) this.delivery[peer] = d;
    }
    this.groups = new GroupBook(state?.groups && typeof state.groups === 'object' ? state.groups : undefined);
    const r = state?.restored;
    if (r && typeof r === 'object' && typeof r.at === 'string' && typeof r.backup_created === 'string') this.restored = { at: r.at, backup_created: r.backup_created };
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
      ...(this.restored ? { restored: this.restored } : {}),
      ...this.deliveryToPersist(),
    };
  }

  /** Only contacts' receipts are kept (a revoked or removed contact's go with it). */
  private deliveryToPersist(): { delivery?: Record<string, PeerDelivery> } {
    const kept = Object.entries(this.delivery).filter(([peer]) => Object.hasOwn(this.book.state.contacts, peer));
    return kept.length ? { delivery: Object.fromEntries(kept) } : {};
  }

  get id(): string {
    return this.key.id;
  }

  /**
   * Listen for envelopes and on our own discovery topics (listen mode, §4.4).
   * When a relay comes back, what contacts have not confirmed is published
   * again (NOTES 98). Unless `deliveryTimer: false`, a timer also sends the
   * receipts we owe and retries on the backoff; a host that builds an agent
   * per item turns it off and calls `deliveryTick` itself.
   */
  start(opts: { deliveryTimer?: boolean } = {}): void {
    this.unsubscribers.push(this.transport.onEnvelopes(this.id, (raw) => this.enqueue(() => this.handleEnvelope(raw))));
    const off = this.transport.onReconnect?.(() => {
      // Several relays coming back at once make one pass.
      if (this.resendQueued) return;
      this.resendQueued = true;
      this.enqueue(async () => {
        this.resendQueued = false;
        await this.resendUnconfirmed();
      });
    });
    if (off) this.unsubscribers.push(off);
    if (opts.deliveryTimer !== false) {
      const every = Math.max(20, Math.min(1000, this.receiptTiming.ackDelayMs));
      const timer = setInterval(() => {
        if (this.tickQueued) return;
        this.tickQueued = true;
        this.enqueue(async () => {
          this.tickQueued = false;
          await this.deliveryTick();
        });
      }, every);
      timer.unref?.();
      this.unsubscribers.push(() => clearInterval(timer));
    }
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
  refreshCapabilities(capabilities: readonly string[], opts: { now?: Date; drop?: readonly string[] } = {}): boolean {
    const have = Array.isArray(this.card.capabilities) ? this.card.capabilities : [];
    const drop = (opts.drop ?? []).filter((c) => have.includes(c));
    const next = missingCapabilities(this.card, capabilities.filter((c) => !(opts.drop ?? []).includes(c))) ?? (drop.length ? have : null);
    if (!next) return false;
    // `drop`: what the owner turned off (receipts, NOTES 98) leaves the card, so contacts stop waiting for it.
    this.card = reissueCardCapabilities(this.key, this.card, next.filter((c) => !drop.includes(c)), opts.now);
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

  /**
   * Our notice to `peer` went unanswered and can no longer arrive (NOTES 91):
   * it expired, or our outbox no longer holds it, or `covered` (a resend
   * range asking for it again) says the peer missed it. Such a notice is sent
   * afresh; the peer's checks (newer than all it accepted, 3 a day) keep a
   * repeat safe.
   */
  private restoreNoticeStale(peer: string, covered?: (seq: number) => boolean): boolean {
    const hash = this.channels.state[peer]?.restoreNotice;
    if (typeof hash !== 'string' || hash === 'due') return false;
    const env = (this.outbox[peer] ?? []).find((e) => envelopeHash(e) === hash);
    return !env || isExpired(env, new Date()) || covered?.(env.seq) === true;
  }

  /** The `rdv/restored` payload for `peer`: where our inbound chain from it stood in the backup (NOTES 91). */
  private restoredNotice(peer: string): Payload {
    return { type: RESTORED_TYPE, v: 1, in_seq: this.channels.state[peer]?.inSeq ?? 0, backup_created: this.restored?.backup_created ?? null };
  }

  /**
   * After a restore from a backup (NOTES 91): send our `rdv/restored` notice
   * to every contact and group co-member still owed one, so each re-bases our
   * chain instead of refusing it. A peer we cannot reach now gets it before
   * the next envelope we send it (deliver). One failed send does not stop the
   * others; that peer stays due. Call it at a listener's start.
   */
  async sendRestoredNotices(): Promise<CardUpdateReport> {
    const report: CardUpdateReport = { sent: [], failed: [] };
    for (const [peer, c] of Object.entries(this.channels.state)) {
      if (!(c.restoreNotice === 'due' || this.restoreNoticeStale(peer)) || !this.restorePeer(peer) || this.book.isBlocked(peer)) continue;
      try {
        await this.deliverTo(peer, this.restoredNotice(peer));
        report.sent.push(peer);
      } catch (err) {
        report.failed.push({ peer, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  /** After our restore: the peers still owed our notice, and those whose acknowledgement has not come yet. Null if not restored. */
  restoreStatus(): { at: string; backup_created: string; notice_due: string[]; awaiting_ack: string[] } | null {
    if (!this.restored) return null;
    const due: string[] = [];
    const awaiting: string[] = [];
    for (const [peer, c] of Object.entries(this.channels.state)) {
      if (c.restoreNotice === 'due' || this.restoreNoticeStale(peer)) due.push(peer);
      else if (typeof c.restoreNotice === 'string') awaiting.push(peer);
    }
    return { ...this.restored, notice_due: due, awaiting_ack: awaiting };
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

  /**
   * Say something to a group (§7.8.3): signed once, sealed to each member we
   * send to over its pairwise channel. Board-visible by default (every member
   * our human approved, or our policy did; consumes our group chain); with
   * `to`, private to those members. One failed send does not stop the rest;
   * its envelope stays in the outbox for a resend.
   */
  async sendGroup(groupId: string, body: GroupBody, opts: { to?: string[] } = {}): Promise<GroupSendReport> {
    const { payload, recipients } = prepareGroupMessage(this.groups, this.key, groupId, body, { to: opts.to, isBlocked: (p) => this.book.isBlocked(p) });
    const report: GroupSendReport = { msg: payload.msg, sent: [], failed: [] };
    for (const peer of recipients) {
      try {
        await this.deliverTo(peer, payload);
        report.sent.push(peer);
      } catch (err) {
        report.failed.push({ peer, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  /**
   * Our human leaves a group (§7.8.5): a signed rdv/group-leave to every other
   * member, then nothing more goes to them, and the channels kept only for
   * the group are dropped. The last admin hands the role on first.
   */
  async leaveGroup(groupId: string): Promise<GroupRecord> {
    const problem = this.groups.leaveProblem(groupId, this.id);
    if (problem) throw new Error(problem);
    const r = this.groups.group(groupId)!;
    const peers = r.status === 'active' ? leaveRecipients(r, this.id) : [];
    if (r.status === 'active') {
      const leave = createGroupLeave(this.key, r);
      for (const peer of peers) {
        if (this.book.isBlocked(peer)) continue;
        try {
          await this.deliverTo(peer, leave);
        } catch (err) {
          this.drop('group leave send failed', { peer, group: groupId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } else if (r.via) peers.push(r.via);
    const out = this.groups.markLeft(groupId);
    this.dropGroupChannels(peers);
    return out;
  }

  /**
   * As admin, our human removes a member (§7.8.5): the next state without it,
   * sent to every member and to it. Nothing is rotated (there is no group
   * key); its channel is dropped unless we are contacts or share a group.
   */
  async removeGroupMember(groupId: string, member: string): Promise<GroupChange> {
    const removedCard = this.book.contact(member)?.card ?? this.groups.memberCard(member);
    const change = this.groups.remove(this.key, groupId, member, this.groupCtx());
    this.emit('group-state', change);
    await this.fanOutState(change.record, change.added, change.removed.map((id) => ({ id, card: id === member ? removedCard : undefined })));
    this.dropGroupChannels(change.removed);
    return change;
  }

  /**
   * As admin, our human makes another member an admin (§7.8.5: the last admin
   * hands the role on before leaving). The next state goes to every member.
   */
  async promoteGroupMember(groupId: string, member: string): Promise<GroupChange> {
    const change = this.groups.promote(this.key, groupId, member, this.groupCtx());
    this.emit('group-state', change);
    await this.fanOutState(change.record, []);
    return change;
  }

  /**
   * Our human changes our own terms in a group (§7.8.2): our join, signed
   * again with the new scope, goes to the members we send to and to the
   * admins (who give it to later newcomers). What members may invoke on us is
   * enforced by our own host from our record at once; the new join tells
   * them. Never on a model's or a peer's say-so.
   */
  async updateGroupTerms(groupId: string, opts: { scope: GroupScope; policy?: NewcomerPolicy }): Promise<{ join: GroupJoin; sent: string[]; failed: GroupSendFailure[] }> {
    const join = this.groups.updateTerms(this.key, groupId, opts);
    const r = this.groups.group(groupId)!;
    const admins = r.state.members.filter((m) => m.role === 'admin').map((m) => m.id);
    const to = [...new Set([...groupRecipients(r, this.id), ...admins])].filter((id) => id !== this.id && !(r.departed && Object.hasOwn(r.departed, id)) && !this.book.isBlocked(id));
    const sent: string[] = [];
    const failed: GroupSendFailure[] = [];
    for (const peer of to) {
      try {
        await this.deliverTo(peer, { type: GROUP_MEMBERS_TYPE, group: groupId, joins: [join] } as { type: string });
        sent.push(peer);
      } catch (err) {
        failed.push({ peer, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { join, sent, failed };
  }

  /** Our human checked with a member's human after it equivocated or was muted: its group messages are taken again (§7.8.6). */
  resyncGroupMember(groupId: string, member: string): void {
    resyncMember(this.groups, groupId, member);
  }

  /**
   * Forget the pairwise channels of former co-members (§7.8.5): unless they
   * are contacts, pending, or share another group with us, nothing of the
   * channel stays (even though we wrote to them).
   */
  private dropGroupChannels(peers: string[]): void {
    const kept = this.keptPeers();
    for (const peer of peers) {
      if (peer === this.id || kept.has(peer)) continue;
      this.channels.forget(peer);
      delete this.outbox[peer];
      delete this.buffer[peer];
    }
  }

  /** Emit a group item's effects and perform its sends (resend requests, evidence, reports). */
  private async applyGroupEffects(fx: GroupEffects, from: string): Promise<void> {
    for (const e of fx.equivocations) this.emit('group-equivocation', e);
    for (const g of fx.gaps) this.emit('group-gap', g);
    for (const m of fx.mutes) this.emit('group-mute', m);
    for (const d of fx.delivered) this.emit('group-message', d);
    for (const s of fx.send) {
      if (this.book.isBlocked(s.to)) continue;
      try {
        await this.deliverTo(s.to, s.payload);
      } catch (err) {
        this.drop('group send failed', { peer: s.to, type: s.payload.type, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (fx.drop && !fx.drop.endsWith('duplicate')) this.drop(fx.drop, { peer: from });
  }

  /** After a state applied: the channels of members it removed (all of them if it removed us), and messages that waited for its epoch. */
  private async afterGroupChange(change: GroupChange): Promise<void> {
    if (change.left) this.dropGroupChannels([...memberIds(change.record.prevState ?? change.record.state), ...change.removed]);
    else if (change.removed.length) this.dropGroupChannels(change.removed);
    for (const w of takeWaiting(this.groups, change.record.group)) {
      await this.applyGroupEffects(receiveGroupMessage(this.groups, w.payload, w.from, this.groupCtx()), w.from);
    }
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
  private async fanOutState(r: GroupRecord, added: string[], removed: Array<{ id: string; card?: AddressCard }> = []): Promise<void> {
    const state = r.state;
    const joinsOf = (ids: string[]): GroupJoin[] => ids.flatMap((id) => (Object.hasOwn(r.joins, id) ? [r.joins[id]] : []));
    // The removed get the state that removes them (§7.8.5), on the card we held for them.
    for (const { id, card } of removed) {
      if (id === this.id || this.book.isBlocked(id)) continue;
      const to = this.book.contact(id)?.card ?? card;
      if (!to) continue;
      try {
        await this.deliver(id, state, relaysOf(to));
      } catch (err) {
        this.drop('group fan-out send failed', { peer: id, group: state.group, error: err instanceof Error ? err.message : String(err) });
      }
    }
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

  // -------------------------------------------------------------------------
  // Delivery receipts (SPEC §6.4.2, NOTES 98).

  /** Whether we wait for `peer`'s receipts: a contact whose card says its agent sends them. */
  private tracksDelivery(peer: string): boolean {
    return confirmsDelivery(this.book.contact(peer)?.card);
  }

  private peerDelivery(peer: string): PeerDelivery {
    return (this.delivery[peer] ??= { acked: 0, pending: [] });
  }

  /** Delivery to one contact as its owner sees it: confirmed up to, waiting, not confirmed. */
  deliveryStatus(peer: string): DeliverySummary {
    return deliverySummary(this.delivery[peer], this.book.contact(peer)?.card);
  }

  /** What became of the envelope we sent `peer` at `seq`. */
  deliveryOf(peer: string, seq: number): DeliveryState {
    return deliveryOf(this.delivery[peer], seq);
  }

  /** An envelope of ours to `peer` that wants a receipt: kept until the peer confirms it. */
  private trackPending(peer: string, env: Envelope): void {
    const d = this.peerDelivery(peer);
    d.from ??= env.seq;
    d.pending.push({ seq: env.seq, hash: envelopeHash(env), sent: env.created, tries: 0 });
    if (d.pending.length <= OUTBOX_LIMIT) return;
    // Out of the outbox too, so it can no longer be resent: say so rather than forget it.
    const gone = d.pending.splice(0, d.pending.length - OUTBOX_LIMIT).filter((p) => !p.unconfirmed);
    if (gone.length) this.emit('delivery-unconfirmed', { peer, seqs: gone.map((p) => p.seq), since: gone[0].sent });
  }

  /**
   * Note that we owe `env.from` a receipt, after an envelope of its chain was
   * accepted (or arrived again). Receipts themselves are never acknowledged,
   * or two agents would answer each other's forever. A duplicate of what we
   * already confirmed may be the sender retrying because our receipt was
   * lost, or anyone re-publishing an old envelope: nothing about it tells
   * which (the carrier's timestamp is the publisher's word, review of #112).
   * So it earns another receipt at most `maxRetries + 1` times between two
   * new envelopes from that peer, at least `retryAfterMs / 2` apart; that
   * covers the sender's retries, and a receipt costs no chain state anyway.
   */
  private oweAck(env: Envelope, payload: Payload, duplicate = false): void {
    if (payload.type === ACK_TYPE || !this.sendReceipts) return;
    const peer = env.from;
    if (!this.tracksDelivery(peer)) return;
    const ch = this.channels.state[peer];
    if (!ch || ch.inSeq < 1 || ch.refused) return;
    const d = this.peerDelivery(peer);
    const sent = d.ack_sent;
    const now = Date.now();
    if (duplicate) {
      if (env.seq > ch.inSeq) return; // not something we hold (a replay below a re-sync floor)
      if (sent && sent.seq >= env.seq) {
        const t = this.receiptTiming;
        const last = d.reack_at === undefined ? Number.NEGATIVE_INFINITY : Date.parse(d.reack_at);
        if ((d.reacks ?? 0) > t.maxRetries || now - last < t.retryAfterMs / 2) return;
        d.reacks = (d.reacks ?? 0) + 1;
        d.reack_at = new Date(now).toISOString();
      }
    } else {
      delete d.reacks; // a new envelope: the sender's retries of it may each need an answer again
      delete d.reack_at;
      if (sent && sent.seq >= ch.inSeq) return;
    }
    // The receipt waits for the quiet period plus up to ackJitterMs, so its timing says less about the message's.
    d.ack_owed ??= new Date(now + Math.floor(Math.random() * (this.receiptTiming.ackJitterMs + 1))).toISOString();
  }

  /**
   * A contact's `rdv/ack`, an envelope outside every chain (`seq` 0): a
   * receipt is true whatever waits in a gap, and a replay of an older one
   * says less, never more. Only from a contact, only up to what we sent it;
   * it moves only forward.
   */
  private handleAck(env: Envelope, payload: Payload): void {
    const from = env.from;
    if (!this.book.contact(from)) return this.drop('ack from a non-contact', from);
    const ch = this.channels.state[from];
    if (ch?.refused) return; // a forked chain's word is not taken until the human re-syncs it
    const seq = ackSeq(payload);
    if (seq === null) return this.drop('ack malformed', { peer: from });
    if (!ch || seq > ch.outSeq) return this.drop('ack beyond our chain', { peer: from, seq });
    const d = this.peerDelivery(from);
    if (seq <= d.acked) return;
    d.acked = seq;
    const late = d.pending.filter((p) => p.seq <= seq && p.unconfirmed).map((p) => p.seq);
    d.pending = d.pending.filter((p) => p.seq > seq);
    if (late.length) this.emit('delivery-confirmed', { peer: from, seqs: late });
  }

  private outboxEnvelope(peer: string, hash: string): Envelope | undefined {
    return (this.outbox[peer] ?? []).find((e) => envelopeHash(e) === hash);
  }

  /** Publish envelopes again, as they are (the receiver drops what it holds). False if none went out. */
  private async republish(peer: string, envs: Envelope[], relays: string[]): Promise<boolean> {
    let sent = 0;
    for (const e of envs) {
      try {
        await this.transport.sendEnvelope(e, relays);
        sent++;
      } catch (err) {
        this.drop('resend failed', { peer, seq: e.seq, error: err instanceof Error ? err.message : String(err) });
        break; // the relays are not taking anything now: the next retry or reconnect tries again
      }
    }
    return sent > 0;
  }

  /**
   * Send the receipts that are due and republish what contacts have not
   * confirmed, on the backoff; report what is still not confirmed after the
   * last retry (`delivery-unconfirmed`). Every call moves each due time past
   * now, so a host that loops on `nextDeliveryDue` cannot spin.
   */
  async deliveryTick(now = new Date()): Promise<void> {
    const t = this.receiptTiming;
    for (const peer of Object.keys(this.delivery)) {
      const d = this.delivery[peer];
      const c = this.book.contact(peer, now);
      if (!c || this.book.isBlocked(peer)) {
        delete this.delivery[peer]; // no longer a contact: nothing to confirm either way
        continue;
      }
      const relays = relaysOf(c.card);
      const due = ackDue(d, t);
      if (due !== null && due <= now.getTime()) await this.sendAck(peer, d, relays, now);
      const resend: Envelope[] = [];
      const spent: typeof d.pending = [];
      for (const p of d.pending) {
        const at = retryDue(p, t);
        if (at === null || at > now.getTime()) continue;
        const env = p.tries < t.maxRetries ? this.outboxEnvelope(peer, p.hash) : undefined;
        if (!env || isExpired(env, now)) {
          p.unconfirmed = true;
          spent.push(p);
          continue;
        }
        p.tries++;
        p.last = now.toISOString();
        resend.push(env);
      }
      if (resend.length && (await this.republish(peer, resend, relays))) {
        this.emit('delivery-resent', { peer, seqs: resend.map((e) => e.seq), reason: 'retry' });
      }
      if (spent.length) this.emit('delivery-unconfirmed', { peer, seqs: spent.map((p) => p.seq), since: spent[0].sent });
    }
  }

  /**
   * Our receipt to `peer`: the highest seq of its chain we hold without a
   * gap. It is outside our chain (`seq` 0, `prev` null, SPEC §6.4.2): it takes
   * no seq, no outbox slot and no restore notice, so however many go out,
   * nothing of the chain is used up (review of #112). Encrypted and signed
   * like any envelope.
   */
  private async sendAck(peer: string, d: PeerDelivery, relays: string[], now: Date): Promise<void> {
    const seq = this.channels.state[peer]?.inSeq ?? 0;
    const owed = d.ack_owed;
    delete d.ack_owed;
    if (seq < 1) return;
    d.ack_sent = { at: now.toISOString(), seq };
    try {
      await this.transport.sendEnvelope(sealEnvelope(this.key, peer, { type: ACK_TYPE, v: 1, seq } as Payload, { seq: 0, prev: null }), relays);
    } catch (err) {
      d.ack_owed = owed; // again after ackMinIntervalMs
      this.drop('ack send failed', { peer, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * A listening relay is back (NOTES 98): republish what contacts have not
   * confirmed, after the catch-up has been read. Not a retry: the backoff
   * restarts from now. At most once per contact per `retryAfterMs`, however
   * often relays come and go, and an envelope already reported as not
   * confirmed goes again on at most `maxRetries` reconnects (review of #112).
   */
  async resendUnconfirmed(now = new Date()): Promise<void> {
    const t = this.receiptTiming;
    for (const [peer, d] of Object.entries(this.delivery)) {
      const c = this.book.contact(peer, now);
      if (!c || this.book.isBlocked(peer) || d.pending.length === 0) continue;
      if (d.flushed_at !== undefined && now.getTime() - Date.parse(d.flushed_at) < t.retryAfterMs) continue;
      const due = d.pending.flatMap((p) => {
        if (p.unconfirmed && (p.flushes ?? 0) >= t.maxRetries) return [];
        const env = this.outboxEnvelope(peer, p.hash);
        return env && !isExpired(env, now) ? [{ p, env }] : [];
      });
      if (due.length === 0) continue;
      d.flushed_at = now.toISOString();
      for (const x of due) {
        x.p.last = now.toISOString();
        if (x.p.unconfirmed) x.p.flushes = (x.p.flushes ?? 0) + 1;
      }
      if (await this.republish(peer, due.map((x) => x.env), relaysOf(c.card))) {
        this.emit('delivery-resent', { peer, seqs: due.map((x) => x.env.seq), reason: 'reconnect' });
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
    // After a restore, the first envelope to each peer is our notice (NOTES 91), whatever we send.
    const notice = payload.type === RESTORED_TYPE;
    if (!notice && (this.channels.state[peer]?.restoreNotice === 'due' || this.restoreNoticeStale(peer))) await this.deliver(peer, this.restoredNotice(peer), relays);
    const { seq, prev } = this.channels.nextOutbound(peer);
    const env = sealEnvelope(this.key, peer, payload, { seq, prev });
    this.channels.commitOutbound(peer, env);
    if (notice) this.channels.state[peer].restoreNotice = envelopeHash(env); // saved by beforeSend, with the envelope
    const box = (this.outbox[peer] ??= []);
    box.push(env);
    if (box.length > OUTBOX_LIMIT) box.splice(0, box.length - OUTBOX_LIMIT);
    if (this.tracksDelivery(peer)) this.trackPending(peer, env);
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
    if (env.from === this.id) return this.drop('own envelope (a relay echo)');
    if (this.book.isBlocked(env.from)) return this.drop('blocked sender');

    try {
      await this.handleOpened(env, opened.payload);
    } finally {
      // Only admitted senders keep channel state; a stranger's goes with its envelope (NOTES 64).
      this.pruneChannels();
    }
  }

  private async handleOpened(env: Envelope, payload: Payload): Promise<void> {
    // Outside every chain: only a receipt may be (SPEC §6.4.2). It changes no channel state.
    if (env.seq === 0) return payload.type === ACK_TYPE ? this.handleAck(env, payload) : this.drop('unchained envelope', { peer: env.from, type: payload.type });
    // A peer that restored from a backup starts its chain again: judged before ordering (NOTES 91).
    if (payload.type === RESTORED_TYPE && (await this.handleRestored(env, payload))) return;
    // What waited for the gap the ack closed is in order now: before the ack itself, which comes after it.
    if (payload.type === RESTORED_ACK_TYPE && this.handleRestoredAck(env, payload)) await this.drainBuffer(env.from);
    const order = this.channels.acceptInbound(env, { adopt: !this.keepsChannel(env.from) });
    if (order.kind === 'duplicate') return this.oweAck(env, payload, true);
    if (order.kind === 'fork' || order.kind === 'rollback' || order.kind === 'refused') return this.dropForked(env, order);
    if (order.kind === 'gap') {
      this.bufferEnvelope(env);
      // A contact, or a co-member (group traffic between non-contacts rides this channel too, §7.8.2).
      const card = this.book.contact(env.from)?.card ?? (this.groups.admittedPeers(this.id).has(env.from) ? this.groups.memberCard(env.from) : undefined);
      if (card) {
        const resend: Payload = { type: 'rdv/resend', from_seq: order.missingFrom, to_seq: order.missingTo };
        await this.deliver(env.from, resend, relaysOf(card));
      }
      return;
    }

    await this.dispatch(env, payload);
    // After dispatch: a grant makes its sender a contact, whose receipt is then owed.
    this.oweAck(env, payload);
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
      if (opened.ok) {
        await this.dispatch(next, opened.payload);
        this.oweAck(next, opened.payload);
      }
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
        if (!got) return this.drop('unexpected or invalid grant', { peer: from });
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
          for (const change of [out.change, ...out.also]) await this.afterGroupChange(change);
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
      // Group messages (§7.8.3, §7.8.5–§7.8.7). From a member that is not a contact, only these and the
      // group control payloads above are taken, for groups both are in: nothing pairwise (§7.8.2).
      case GROUP_MSG_TYPE: {
        if (!this.groups.admittedPeers(this.id).has(from)) return this.drop('group message from a non-member', from);
        return this.applyGroupEffects(receiveGroupMessage(this.groups, payload, from, this.groupCtx()), from);
      }
      case GROUP_PROOF_TYPE: {
        if (!this.groups.admittedPeers(this.id).has(from)) return this.drop('group proof from a non-member', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        return this.applyGroupEffects(receiveGroupProof(this.groups, payload, from, this.groupCtx()), from);
      }
      case GROUP_LEAVE_TYPE: {
        if (!this.groups.admittedPeers(this.id).has(from)) return this.drop('group leave from a non-member', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        // The leaver's card, before its join goes with the state that removes it.
        const card = this.book.contact(from)?.card ?? this.groups.memberCard(from);
        const out = receiveGroupLeave(this.groups, this.key, payload, from, this.groupCtx());
        if (!out.ok) return this.drop(out.reason, { peer: from });
        this.emit('group-left', { group: out.group, member: out.member });
        if (out.change) {
          this.emit('group-state', out.change);
          await this.fanOutState(out.change.record, out.change.added, out.change.removed.map((id) => ({ id, card: id === from ? card : undefined })));
        }
        this.dropGroupChannels([from]);
        return;
      }
      case GROUP_REPORT_TYPE: {
        if (!this.groups.admittedPeers(this.id).has(from)) return this.drop('group report from a non-member', from);
        if (!this.book.admitControl('group', from, GROUP_CONTROL_LIMIT)) return this.drop('group payload rate-limited', { peer: from });
        const out = receiveGroupReport(this.groups, payload, from, this.groupCtx());
        if (!out.ok) return this.drop(out.reason, { peer: from });
        this.emit('group-report', out.report);
        return;
      }
      // Handled before ordering (handleOpened); in order here, nothing more to do.
      case RESTORED_TYPE:
      case RESTORED_ACK_TYPE:
        return;
      // A receipt counts only outside the chain (seq 0, handleOpened); one inside a chain is nobody's.
      case ACK_TYPE:
        return this.drop('chained ack', { peer: from });
      case 'rdv/resend': {
        const c = this.book.contact(from);
        const member = this.groups.admittedPeers(this.id).has(from);
        if (!c && !member) return;
        if (!this.book.admitControl('resend', from, RESEND_LIMIT)) return this.drop('resend rate-limited', from);
        if (payload.group !== undefined) {
          // A group resend (§7.8.6 layer 2): our board messages in the range, re-sealed to this member only.
          const got = groupResend(this.groups, payload.group, from, payload.from_gseq, payload.to_gseq, this.id);
          if ('rejected' in got) return this.drop(`group resend refused: ${got.rejected}`, { peer: from });
          for (const p of got) await this.deliverTo(from, p);
          return;
        }
        const card = c?.card ?? this.groups.memberCard(from);
        if (!card) return;
        const lo = Number(payload.from_seq);
        const hi = Number(payload.to_seq);
        // After our restore: a notice the peer missed (asked for again) or one that expired unanswered is sent
        // fresh, never replayed: an expired envelope would only be dropped there (NOTES 91).
        let replaced: string | undefined;
        if (this.restoreNoticeStale(from, (seq) => seq >= lo && seq <= hi)) {
          replaced = this.channels.state[from].restoreNotice;
          this.channels.state[from].restoreNotice = 'due';
          await this.deliverTo(from, this.restoredNotice(from));
        }
        for (const e of this.outbox[from] ?? []) {
          if (e.seq >= lo && e.seq <= hi && !(replaced && envelopeHash(e) === replaced)) await this.transport.sendEnvelope(e, relaysOf(card));
        }
        return;
      }
      default:
        if (!this.book.admitInbound(from)) return this.drop('no grant for sender', from);
        this.emit('message', from, payload, env);
    }
  }

  /** A peer whose chain a restore notice may re-base: a contact, or a group co-member (their pairwise channel). */
  private restorePeer(peer: string): boolean {
    return !!this.book.contact(peer) || this.groups.admittedPeers(this.id).has(peer);
  }

  /**
   * A peer's `rdv/restored` notice (SPEC §6.4.1, NOTES 91): it restored its
   * agent from a backup, so its chain to us starts again at this envelope.
   * Acted on only from a contact or co-member (the envelope is signed by its
   * key, and only its own chain is re-based), only when newer than everything
   * we accepted from it (a relay replay of this or an older notice is not),
   * and at most RESTORED_LIMIT a day. We answer `rdv/restored-ack` (where our
   * chain to it goes on) and resend what our outbox still holds of that
   * chain. The human is told (`contact-restored`). False: the envelope goes on
   * to the ordinary checks (a replay, or a sender we keep no contact with).
   */
  private async handleRestored(env: Envelope, payload: Payload): Promise<boolean> {
    const from = env.from;
    if (!this.restorePeer(from)) return false;
    const p = payload as Record<string, unknown>;
    const created = parseTimestamp(env.created);
    const c = this.channels.state[from];
    // Not newer than all we accepted: a replay (of this notice, or of an older restore's). Nothing to act on.
    if (created === null || (c?.inNewest !== undefined && !(created > c.inNewest)) || (c?.inFloor !== undefined && !(created > c.inFloor))) return false;
    const inSeq = p.in_seq;
    const backupCreated = p.backup_created === null ? null : parseTimestamp(p.backup_created) === null ? undefined : (p.backup_created as string);
    const keys = Object.keys(p).sort().join(',');
    if (keys !== 'backup_created,in_seq,type,v' || p.v !== 1 || typeof inSeq !== 'number' || !Number.isSafeInteger(inSeq) || inSeq < 0 || backupCreated === undefined) {
      this.drop('restored notice malformed', { peer: from });
      return true;
    }
    if (!this.book.admitControl('restored', from, RESTORED_LIMIT)) {
      this.drop('restored notice rate-limited', { peer: from });
      return true;
    }
    // A chain refused after a fork stays the human's to re-sync: a notice from the key (the very copy that forked,
    // perhaps) never lifts that on its own. The human is told; the envelope is then refused as any other.
    if (c?.refused) {
      this.emit('contact-restored', { peer: from, backup_created: backupCreated, seq: env.seq, previous_seq: c.inSeq, was_refused: c.refused.kind, pending_resync: true });
      return false;
    }
    const before = this.channels.rebase(env);
    // What waited in the buffer for a gap of the old chain is that chain's.
    const kept = this.buffer[from]?.filter((e) => e.seq > env.seq);
    if (kept?.length) this.buffer[from] = kept;
    else delete this.buffer[from];
    this.emit('contact-restored', {
      peer: from,
      backup_created: backupCreated,
      seq: env.seq,
      previous_seq: before.inSeq,
      ...(before.refused ? { was_refused: before.refused } : {}),
    });
    this.oweAck(env, payload); // the notice is the new chain's head: confirm it like any envelope
    // Our chain to it: from what its backup had accepted, as far back as our outbox goes without a hole.
    const out = this.channels.state[from];
    const resend: Envelope[] = [];
    const box = [...(this.outbox[from] ?? [])].sort((a, b) => a.seq - b.seq);
    // Stop at the first expired envelope: it would only be dropped there, and the gap it left would never close.
    const now = new Date();
    for (let i = box.length - 1, next = out.outSeq; i >= 0 && next > inSeq && box[i].seq === next && !isExpired(box[i], now); i--, next--) resend.unshift(box[i]);
    const fromSeq = resend.length ? resend[0].seq : out.outSeq + 1;
    const prev = resend.length ? resend[0].prev : out.outPrev;
    // What it can't get again is older than the first envelope it does get again: a replay of it is a duplicate there.
    const floor = (resend.length ? (parseTimestamp(resend[0].created) ?? Date.now()) : Date.now()) - 1;
    // Receipts: its backup holds our chain only up to in_seq, whatever it confirmed since. What we resend is waited for
    // again (review of #112); the rest after in_seq is gone with its old copy and was confirmed by that copy.
    if (this.tracksDelivery(from)) {
      const d = this.peerDelivery(from);
      d.acked = Math.min(d.acked, inSeq);
      for (const e of resend) {
        if (!d.pending.some((p) => p.seq === e.seq)) d.pending.push({ seq: e.seq, hash: envelopeHash(e), sent: now.toISOString(), tries: 0 });
      }
      d.pending.sort((a, b) => a.seq - b.seq);
    }
    const ack: Payload = { type: RESTORED_ACK_TYPE, v: 1, notice: envelopeHash(env), from_seq: fromSeq, prev, floor: new Date(floor).toISOString() };
    try {
      await this.deliverTo(from, ack);
      const card = this.book.contact(from)?.card ?? this.groups.memberCard(from);
      if (card) for (const e of resend) await this.transport.sendEnvelope(e, relaysOf(card));
    } catch (err) {
      this.drop('restored ack send failed', { peer: from, error: err instanceof Error ? err.message : String(err) });
    }
    await this.drainBuffer(from);
    return true;
  }

  /**
   * The answer to our own notice (NOTES 91): the peer's chain to us goes on
   * at `from_seq`. Taken only for the notice we sent this peer last (by its
   * hash), once; it moves our inbound chain only forward, past envelopes the
   * copy we lost had received. The ack envelope itself then goes through the
   * ordinary checks. True when it moved the chain.
   */
  private handleRestoredAck(env: Envelope, payload: Payload): boolean {
    const from = env.from;
    const c = this.channels.state[from];
    const p = payload as Record<string, unknown>;
    if (!c || typeof c.restoreNotice !== 'string' || c.restoreNotice === 'due' || p.notice !== c.restoreNotice) return false;
    const fromSeq = p.from_seq;
    const floor = parseTimestamp(p.floor);
    const created = parseTimestamp(env.created);
    const okPrev = p.prev === null || (typeof p.prev === 'string' && /^[0-9a-f]{64}$/.test(p.prev));
    const keys = Object.keys(p).sort().join(',');
    if (
      keys !== 'floor,from_seq,notice,prev,type,v' ||
      p.v !== 1 ||
      typeof fromSeq !== 'number' ||
      !Number.isSafeInteger(fromSeq) ||
      fromSeq < 1 ||
      fromSeq > env.seq ||
      !okPrev ||
      floor === null ||
      created === null ||
      floor > created
    ) {
      this.drop('restored ack malformed', { peer: from });
      return false;
    }
    const was = c.inSeq;
    const skipped = this.channels.skipTo(from, fromSeq, p.prev as string | null, floor);
    if (skipped) {
      const kept = this.buffer[from]?.filter((e) => e.seq >= fromSeq);
      if (kept?.length) this.buffer[from] = kept;
      else delete this.buffer[from];
    }
    delete c.restoreNotice;
    // The peer's own count (its from_seq): bounded, it is only shown.
    this.emit('restore-confirmed', { peer: from, skipped: skipped ? Math.min(Math.max(fromSeq - 1 - was, 0), OUTBOX_LIMIT * 1000) : 0 });
    return skipped;
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
