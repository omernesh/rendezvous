// §6.2: Nostr as the primary relay. Envelopes and discovery documents ride a
// dedicated event kind; relays only ever see the envelope's cleartext header.
//
// Nostr events are signed with secp256k1, not the agent's Ed25519 key, so each
// agent derives a stable Nostr "carrier" key from its seed. The carrier key
// authenticates nothing at the protocol level — the envelope signature does.
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { type Event, finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import WebSocket from 'ws';
import { bytesToHex, canonicalize } from '../encoding.js';
import type { Envelope } from '../envelope.js';
import { envelopeHash } from '../envelope.js';
import { type AgentKey, publicKeyFromAgentId } from '../identity.js';
import type { Transport } from './transport.js';

/**
 * Spec proposal is 30417. That number sits in the addressable (30000–39999)
 * range, so every event needs a unique `d` tag or relays will overwrite it;
 * we set `d` to the envelope hash. See NOTES.md.
 */
export const ENVELOPE_KIND = 30417;

// Node's built-in (undici) WebSocket re-enters nostr-tools' onerror handler on
// a failed connect and overflows the stack; the `ws` package doesn't.
useWebSocketImplementation(WebSocket);

export interface NostrTransportOptions {
  key: AgentKey;
  relays: string[];
  /** How far back to fetch stored events on subscribe (seconds). Default 2 days. */
  lookbackSeconds?: number;
  /** First re-subscribe delay after a relay drops us; doubles up to 30 s. Default 1000. */
  reconnectBaseMs?: number;
}

export function nostrCarrierKey(key: AgentKey): Uint8Array {
  return hkdf(sha256, key.secretKey, undefined, utf8ToBytes('rdv1/nostr-carrier'), 32);
}

/** `p` tag value for an agent: hex of its Ed25519 public key. */
export function agentTag(id: string): string {
  return bytesToHex(publicKeyFromAgentId(id));
}

export class NostrTransport implements Transport {
  readonly pool = new SimplePool();
  private readonly carrier: Uint8Array;
  readonly carrierPubkey: string;

  constructor(private readonly opts: NostrTransportOptions) {
    this.carrier = nostrCarrierKey(opts.key);
    this.carrierPubkey = getPublicKey(this.carrier);
  }

  get relays(): string[] {
    return this.opts.relays;
  }

  private destroyed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * A subscription that comes back after its relays drop it (public relays
   * close idle sockets). Re-subscribing replays the lookback window; the agent
   * drops the duplicates.
   */
  private subscribe(filter: () => Filter, onevent: (ev: Event) => void): () => void {
    let closed = false;
    let attempt = 0;
    let sub: { close(): void } | undefined;
    const open = () => {
      sub = this.pool.subscribeMany(this.opts.relays, filter(), {
        onevent,
        oneose: () => {
          attempt = 0;
        },
        onclose: () => {
          if (closed || this.destroyed) return;
          const delay = Math.min(30_000, (this.opts.reconnectBaseMs ?? 1000) * 2 ** attempt++);
          const t = setTimeout(() => {
            this.timers.delete(t);
            if (!closed && !this.destroyed) open();
          }, delay);
          this.timers.add(t);
        },
      });
    };
    open();
    return () => {
      closed = true;
      sub?.close();
    };
  }

  private since(): number {
    return Math.floor(Date.now() / 1000) - (this.opts.lookbackSeconds ?? 2 * 86_400);
  }

  private async publish(event: Event, extraRelays: string[] = []): Promise<void> {
    const relays = [...new Set([...this.opts.relays, ...extraRelays])];
    const results = await Promise.allSettled(this.pool.publish(relays, event));
    if (!results.some((r) => r.status === 'fulfilled')) {
      const reasons = results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')).join('; ');
      throw new Error(`no relay accepted the event: ${reasons}`);
    }
  }

  async sendEnvelope(e: Envelope, recipientRelays: string[] = []): Promise<void> {
    const event = finalizeEvent(
      {
        kind: ENVELOPE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', agentTag(e.to)],
          ['d', envelopeHash(e)],
        ],
        content: JSON.stringify(e),
      },
      this.carrier,
    );
    await this.publish(event, recipientRelays);
  }

  onEnvelopes(me: string, handler: (envelope: unknown) => void): () => void {
    return this.subscribe(
      () => ({ kinds: [ENVELOPE_KIND], '#p': [agentTag(me)], since: this.since() }),
      (ev) => handler(safeParse(ev.content)),
    );
  }

  async publishTopic(topic: string, doc: object, extraRelays: string[] = []): Promise<void> {
    const content = canonicalize(doc);
    const event = finalizeEvent(
      {
        kind: ENVELOPE_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', topic],
          ['d', bytesToHex(sha256(utf8ToBytes(content)))],
        ],
        content,
      },
      this.carrier,
    );
    await this.publish(event, extraRelays);
  }

  onTopics(topics: string[], handler: (doc: unknown, topic: string) => void): () => void {
    if (topics.length === 0) return () => {};
    return this.subscribe(
      () => ({ kinds: [ENVELOPE_KIND], '#t': topics, since: this.since() }),
      (ev) => {
        const topic = ev.tags.find((t) => t[0] === 't' && topics.includes(t[1]))?.[1];
        if (topic) handler(safeParse(ev.content), topic);
      },
    );
  }

  /** One-shot fetch of documents already stored on a topic (public pointers). */
  async fetchTopic(topic: string, maxWaitMs = 3000): Promise<unknown[]> {
    const events = await this.pool.querySync(this.opts.relays, { kinds: [ENVELOPE_KIND], '#t': [topic] }, {
      maxWait: maxWaitMs,
    });
    return events.map((ev) => safeParse(ev.content));
  }

  close(): void {
    this.destroyed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pool.destroy();
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
