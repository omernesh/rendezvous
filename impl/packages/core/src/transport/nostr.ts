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
  /**
   * On re-joining a relay, fetch from the newest `created_at` seen on it minus
   * this margin (seconds), to cover clock skew and events stored while we were
   * away. Default 300.
   */
  rejoinMarginSeconds?: number;
}

/** Event ids remembered per subscription for de-duplication across relays. */
const SEEN_IDS = 4096;

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
   * One subscription per relay, each with its own reconnect and backoff, so a
   * relay that drops out of a multi-relay subscription is re-joined while the
   * others keep running (public relays close idle sockets). A re-join asks for
   * events since the newest `created_at` that relay gave us, minus a margin;
   * events are de-duplicated by id across relays and re-joins.
   */
  private subscribe(filter: (since: number) => Filter, onevent: (ev: Event) => void): () => void {
    let closed = false;
    const seen = new Set<string>();
    const fresh = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > SEEN_IDS) seen.delete(seen.values().next().value as string);
      return true;
    };
    const subs = new Set<{ close(): void }>();
    const margin = this.opts.rejoinMarginSeconds ?? 300;
    const join = (relay: string) => {
      let attempt = 0;
      let newest: number | undefined; // newest created_at seen on this relay, capped at now
      const open = () => {
        let dropped = false;
        const since = newest === undefined ? this.since() : Math.max(this.since(), newest - margin);
        const sub = this.pool.subscribeMany([relay], filter(since), {
          onevent: (ev) => {
            newest = Math.max(newest ?? 0, Math.min(ev.created_at, Math.floor(Date.now() / 1000)));
            if (fresh(ev.id)) onevent(ev);
          },
          oneose: () => {
            // nostr-tools also fires oneose just before onclose when the
            // connect fails; only a subscription still open resets backoff.
            queueMicrotask(() => {
              if (!dropped) attempt = 0;
            });
          },
          onclose: () => {
            dropped = true;
            subs.delete(sub);
            if (closed || this.destroyed) return;
            const delay = Math.min(30_000, (this.opts.reconnectBaseMs ?? 1000) * 2 ** attempt++);
            const t = setTimeout(() => {
              this.timers.delete(t);
              if (!closed && !this.destroyed) open();
            }, delay);
            this.timers.add(t);
          },
        });
        if (!dropped) subs.add(sub);
      };
      open();
    };
    for (const relay of new Set(this.opts.relays)) join(relay);
    return () => {
      closed = true;
      for (const sub of subs) sub.close();
      subs.clear();
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
      (since) => ({ kinds: [ENVELOPE_KIND], '#p': [agentTag(me)], since }),
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
      (since) => ({ kinds: [ENVELOPE_KIND], '#t': topics, since }),
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
    // nostr-tools detaches its handlers before closing a socket; `ws` then
    // emits 'error' for a socket that is still connecting, and an 'error' with
    // no listener crashes the process. Swallow it: we are shutting down.
    const relays = (this.pool as unknown as { relays: Map<string, { ws?: { on?: (ev: string, fn: () => void) => void } }> }).relays;
    for (const r of relays.values()) r.ws?.on?.('error', () => {});
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
