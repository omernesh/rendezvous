// A transport is a dumb pipe (§3.4): it moves opaque envelopes and discovery
// documents, and is never trusted with anything it carries.
import type { Envelope } from '../envelope.js';

export interface Transport {
  /** Deliver to the recipient; `recipientRelays` come from the peer's card. */
  sendEnvelope(e: Envelope, recipientRelays?: string[]): Promise<void>;
  /** Stream raw (unverified) envelopes addressed to `me`. Returns an unsubscribe. */
  onEnvelopes(me: string, handler: (envelope: unknown) => void): () => void;
  /** Post a signed document on a discovery topic (§4.4). */
  publishTopic(topic: string, doc: object, extraRelays?: string[]): Promise<void>;
  onTopics(topics: string[], handler: (doc: unknown, topic: string) => void): () => void;
  fetchTopic(topic: string, maxWaitMs?: number): Promise<unknown[]>;
  close(): void;
}
