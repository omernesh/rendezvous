// A transport is a dumb pipe (§3.4): it moves opaque envelopes and discovery
// documents, and is never trusted with anything it carries.
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

export interface Transport {
  /** Deliver to the recipient; `recipientRelays` come from the peer's card. */
  sendEnvelope(e: Envelope, recipientRelays?: string[]): Promise<PublishReport | void>;
  /** Stream raw (unverified) envelopes addressed to `me`. Returns an unsubscribe. */
  onEnvelopes(me: string, handler: (envelope: unknown) => void): () => void;
  /** Post a signed document on a discovery topic (§4.4). */
  publishTopic(topic: string, doc: object, extraRelays?: string[], opts?: TopicPublishOptions): Promise<PublishReport | void>;
  onTopics(topics: string[], handler: (doc: unknown, topic: string) => void): () => void;
  fetchTopic(topic: string, maxWaitMs?: number): Promise<unknown[]>;
  close(): void;
}
