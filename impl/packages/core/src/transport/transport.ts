// A transport is a dumb pipe (§3.4): it moves opaque envelopes and discovery
// documents, and is never trusted with anything it carries.
import type { LookupFunction } from 'node:net';
import type { Envelope } from '../envelope.js';

export interface TopicPublishOptions {
  /**
   * The document replaces the one this sender published on the topic before
   * (a public-pointer card): on Nostr, one addressable event per sender and
   * topic instead of one per content.
   */
  replaceable?: boolean;
  /** Unix seconds the document dates from; a replaceable event is never dated earlier. */
  createdAt?: number;
}

/** Why a relay did not take an event. */
export type RelayErrorKind = 'blocked' | 'rate-limited' | 'rejected' | 'timeout' | 'connection';

/** What a publish did per relay (a relay transport returns it; a plain pipe may return nothing). */
export interface PublishReport {
  /** Relays that answered `OK true` (or `duplicate`). */
  accepted: string[];
  rejected: Array<{ url: string; kind: RelayErrorKind; message: string }>;
  /** Relays skipped because they are cooling down. */
  skipped: string[];
}

/** How to mirror a card (NOTES 81): strictly serial, paced, one try per relay. */
export interface MirrorOptions {
  /** Relays to mirror to, besides our own (duplicates of ours are dropped). */
  relays: readonly string[];
  /** Pause between two relays. Default 1500 ms. */
  gapMs?: number;
  /** Connect timeout and `OK` timeout per relay. Default 6000 ms each. */
  timeoutMs?: number;
  /** Read the card back from each relay that took it. Default true. */
  readBack?: boolean;
  /** How long a read-back waits for the relay. Default 5000 ms. */
  readBackWaitMs?: number;
}

export interface MirrorRelayResult {
  url: string;
  /** Ours: a listening relay (envelopes go there too); else a mirror (cards only). */
  role: 'listen' | 'mirror';
  /** `skipped`: cooling down after an earlier ban or failure, not contacted. */
  result: 'accepted' | 'rejected' | 'timeout' | 'skipped';
  kind?: RelayErrorKind;
  message?: string;
  /** Read-back: whether the relay serves every topic's document; null when not checked. */
  served: boolean | null;
}

export interface MirrorReport {
  topics: string[];
  relays: MirrorRelayResult[];
  accepted: number;
  rejected: number;
  timeout: number;
  skipped: number;
  /** Relays whose read-back found the card. */
  served: number;
}

export interface Transport {
  /** Deliver to the recipient; `recipientRelays` come from the peer's card. */
  sendEnvelope(e: Envelope, recipientRelays?: string[]): Promise<PublishReport | void>;
  /**
   * Deliver to `relays` only, over connections of its own that resolve every
   * host through `opts.lookup`, closed afterwards; our own relay connections
   * are never used or changed. For relays someone else named (an invite
   * link, NOTES 101). Optional: without it an invite cannot be accepted.
   */
  sendEnvelopeIsolated?(e: Envelope, relays: string[], opts: { lookup: LookupFunction }): Promise<PublishReport | void>;
  /** Stream raw (unverified) envelopes addressed to `me`. Returns an unsubscribe. */
  onEnvelopes(me: string, handler: (envelope: unknown) => void): () => void;
  /**
   * Called once a listening relay that was really down (or failed its echo
   * check) is back and has delivered what it stored meanwhile (EOSE): the
   * agent then republishes what its contacts have not confirmed (NOTES 98).
   * A blip of a second is not reported. Optional.
   */
  onReconnect?(handler: (relay: string) => void): () => void;
  /** Which senders count as traffic for a liveness check (our contacts, NOTES 98). Optional. */
  setTrafficFilter?(fn: (from: string) => boolean): void;
  /** Post a signed document on a discovery topic (§4.4). */
  publishTopic(topic: string, doc: object, extraRelays?: string[], opts?: TopicPublishOptions): Promise<PublishReport | void>;
  onTopics(topics: string[], handler: (doc: unknown, topic: string) => void): () => void;
  /** Documents stored on a topic; `mirrors: false` asks our own relays only (not the discovery mirrors). */
  fetchTopic(topic: string, maxWaitMs?: number, opts?: { mirrors?: boolean }): Promise<unknown[]>;
  /**
   * Publish replaceable documents (our card on each topic) to our relays and
   * then to `opts.relays`, one relay at a time (NOTES 81). Optional: a relay
   * transport implements it.
   */
  mirrorTopics?(docs: Array<{ topic: string; doc: object; createdAt?: number }>, opts: MirrorOptions): Promise<MirrorReport>;
  /** Move to another set of relays at once (`rdv relays`); open subscriptions follow. Optional. */
  setRelays?(relays: readonly string[], mirrorRelays?: readonly string[]): void;
  close(): void;
}
