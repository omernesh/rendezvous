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
import type { PublishReport, RelayErrorKind, TopicPublishOptions, Transport } from './transport.js';

/**
 * Spec proposal is 30417. That number sits in the addressable (30000–39999)
 * range, so every event needs a unique `d` tag or relays will overwrite it;
 * we set `d` to the envelope hash. See NOTES.md.
 */
export const ENVELOPE_KIND = 30417;

/**
 * The relays a new agent uses when its owner names none (NOTES 69). Chosen by
 * the 2026-10-25 survey (NOTES 11a): each passed the contact and dinner
 * scenarios and a 10-minute retention check, and none filters kind 30417,
 * needs a web of trust, payment or NIP-05, or banned a modest test volume.
 * Core never applies it on its own (a `NostrTransport` always takes explicit
 * relays); `rdv init` and `rdv_init` do, and an agent keeps whatever relays it
 * was created with. Ordered by preference (the card's `pref`).
 */
export const DEFAULT_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
]);

/** Largest event `content` we parse from a relay; a sealed envelope stays far below it (NOTES 70). */
export const MAX_EVENT_CONTENT = 128 * 1024;

// Node's built-in (undici) WebSocket re-enters nostr-tools' onerror handler on
// a failed connect and overflows the stack; the `ws` package doesn't.
// nostr-tools also closes a socket that is still connecting when its connect
// timeout fires, after detaching its own handlers; `ws` then emits 'error' with
// no listener, which crashes the process. Every socket gets a no-op listener;
// nostr-tools still sees errors through `onerror` while it is attached.
class QuietWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('error', () => {});
  }
}
useWebSocketImplementation(QuietWebSocket);

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
  /** Extra tries per relay after a transient publish failure (connection, timeout, rate limit, `error:`). Default 2. */
  publishRetries?: number;
  /** First retry delay; doubles per retry (x4 after a rate limit) and is jittered by +-50 %. Default 400. */
  retryBaseMs?: number;
  /** Client-side pacing: sustained events per second per relay. Default 3. */
  maxEventsPerSecond?: number;
  /** Events a relay may get at once before pacing starts (a card republish to several topics). Default 6. */
  burst?: number;
  /** Cooldown for a relay that answers `blocked`, `restricted` or `banned`. Default 30 min. */
  blockedCooldownMs?: number;
  /** Cooldown for a relay that failed every try of a publish (unreachable, timing out, rate limiting). Default 60 s. */
  failureCooldownMs?: number;
  /** Connect timeout per try. Default 3000. */
  connectTimeoutMs?: number;
  /** How long to wait for a relay's `OK` per try. Default 4400 (nostr-tools' default). */
  publishTimeoutMs?: number;
  /** Status saved by an earlier process for our relays: its cooldowns still hold. */
  relayState?: readonly RelayStatus[];
  /** Called after a publish that went to one of our own relays (`relays`), with their status. */
  onRelayStatus?: (status: RelayStatus[]) => void;
}

export const RELAY_ERROR_KINDS: readonly RelayErrorKind[] = ['blocked', 'rate-limited', 'rejected', 'timeout', 'connection'];

export interface RelayError {
  at: string;
  kind: RelayErrorKind;
  /** The relay's `OK false` message or the connection error: control characters replaced, at most 200 chars. */
  message: string;
}

/** Diagnostics for one of our relays (`rdv whoami`, `rdv_status`). Never holds peer text. Timestamps are ISO 8601. */
export interface RelayStatus {
  url: string;
  /** Last time the relay answered `OK true` to one of our events. */
  last_ok: string | null;
  last_error: RelayError | null;
  /** Until then publishes skip this relay (unless every relay is cooling down). */
  cooldown_until: string | null;
}

/** Peer cards name relays too; state is kept for at most this many URLs. */
const MAX_RELAY_STATE = 256;

// C0/C1 controls and bidi overrides: a relay's message is shown to humans and models.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const s = raw.replace(UNSAFE, '?');
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

export interface ClassifiedRelayError {
  kind: RelayErrorKind;
  message: string;
  /** The relay already holds the event: that counts as accepted. */
  duplicate?: true;
  /** Worth another try (the cause is transient). */
  retry: boolean;
}

/** Map a NIP-01 `OK false` message or a nostr-tools connection error to what we do about it. */
export function classifyRelayError(err: unknown): ClassifiedRelayError {
  const message = errorText(err);
  const m = message.toLowerCase();
  if (m.startsWith('duplicate')) return { kind: 'rejected', message, duplicate: true, retry: false };
  if (/^(blocked|restricted)\b/.test(m) || /\bbann?ed\b/.test(m)) return { kind: 'blocked', message, retry: false };
  if (m.startsWith('rate-limited') || /rate.?limit|too many|slow down/.test(m)) return { kind: 'rate-limited', message, retry: true };
  if (m.includes('timed out') || m.includes('timeout')) return { kind: 'timeout', message, retry: true };
  if (/connection|websocket|socket|closed|econn|enotfound|eai_again/.test(m)) return { kind: 'connection', message, retry: true };
  // `error:` is the relay's own trouble; the rest (invalid, pow, auth-required, payment) won't change on a retry.
  return { kind: 'rejected', message, retry: m.startsWith('error') };
}

class ConnectError extends Error {}

/** Token bucket: `burst` events at once, then `rate` per second. `take()` says how long to wait first. */
class Pacer {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  take(): number {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    this.tokens -= 1; // may go negative: later callers queue behind earlier ones
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}

/** Event ids remembered per subscription for de-duplication across relays. */
const SEEN_IDS = 4096;

export function nostrCarrierKey(key: AgentKey): Uint8Array {
  return hkdf(sha256, key.secretKey, undefined, utf8ToBytes('rdv1/nostr-carrier'), 32);
}

/** `d` tag of a public-pointer card on a topic: one per sender and topic, so a newer card replaces the older. */
export function cardTag(topic: string): string {
  return `rdv1/card:${topic}`;
}

/** `p` tag value for an agent: hex of its Ed25519 public key. */
export function agentTag(id: string): string {
  return bytesToHex(publicKeyFromAgentId(id));
}

export class NostrTransport implements Transport {
  readonly pool = new SimplePool();
  private readonly carrier: Uint8Array;
  readonly carrierPubkey: string;

  /** Per-relay diagnostics and cooldowns, keyed by the URL as configured or as a peer card gave it. */
  private readonly state = new Map<string, RelayStatus>();
  private readonly pacers = new Map<string, Pacer>();
  /** Pending sleeps; close() wakes them, so nothing waits on a closed transport. */
  private readonly sleepers = new Set<() => void>();

  constructor(private readonly opts: NostrTransportOptions) {
    this.carrier = nostrCarrierKey(opts.key);
    this.carrierPubkey = getPublicKey(this.carrier);
    for (const st of opts.relayState ?? []) {
      if (st && typeof st.url === 'string' && opts.relays.includes(st.url)) {
        this.state.set(st.url, {
          url: st.url,
          last_ok: typeof st.last_ok === 'string' ? st.last_ok : null,
          last_error: st.last_error && typeof st.last_error === 'object' ? st.last_error : null,
          cooldown_until: typeof st.cooldown_until === 'string' ? st.cooldown_until : null,
        });
      }
    }
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

  /** Our relays' diagnostics, in configured order. Relays from peer cards are not listed (their URLs are peer text). */
  relayStatus(): RelayStatus[] {
    return [...new Set(this.opts.relays)].map((url) => {
      const st = this.state.get(url);
      return st ? { ...st } : { url, last_ok: null, last_error: null, cooldown_until: null };
    });
  }

  private status(url: string): RelayStatus {
    let st = this.state.get(url);
    if (!st) {
      if (this.state.size >= MAX_RELAY_STATE) {
        // Drop the oldest peer relay's state; ours stay.
        for (const k of this.state.keys()) {
          if (!this.opts.relays.includes(k)) {
            this.state.delete(k);
            this.pacers.delete(k);
            break;
          }
        }
      }
      st = { url, last_ok: null, last_error: null, cooldown_until: null };
      this.state.set(url, st);
    }
    return st;
  }

  private coolingDown(url: string, now: number): boolean {
    const until = this.state.get(url)?.cooldown_until;
    return typeof until === 'string' && Date.parse(until) > now;
  }

  private pacer(url: string): Pacer {
    let p = this.pacers.get(url);
    if (!p) {
      p = new Pacer(Math.max(0.1, this.opts.maxEventsPerSecond ?? 3), Math.max(1, this.opts.burst ?? 6));
      this.pacers.set(url, p);
    }
    return p;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.sleepers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  /**
   * Publish to every relay that isn't cooling down (if all are, try each
   * once). Each relay is paced and retried with jittered backoff after a
   * transient failure; `blocked`/`restricted`/`banned` starts a long cooldown
   * at once, and a relay that failed every try cools down briefly. Succeeds
   * once at least one relay answered `OK true` (NOTES 69). Connections are
   * the pool's, one per relay, shared with the subscriptions.
   */
  private async publish(event: Event, extraRelays: string[] = []): Promise<PublishReport> {
    const relays = [...new Set([...this.opts.relays, ...extraRelays])];
    const now = Date.now();
    let targets = relays.filter((r) => !this.coolingDown(r, now));
    let retries = Math.max(0, this.opts.publishRetries ?? 2);
    if (targets.length === 0) {
      targets = relays;
      retries = 0;
    }
    const skipped = relays.filter((r) => !targets.includes(r));
    const results = await Promise.all(targets.map((url) => this.publishTo(url, event, retries)));
    const report: PublishReport = { accepted: [], rejected: [], skipped };
    for (const r of results) {
      if (r.ok) report.accepted.push(r.url);
      else report.rejected.push({ url: r.url, kind: r.kind, message: r.message });
    }
    if (targets.some((u) => this.opts.relays.includes(u))) {
      try {
        this.opts.onRelayStatus?.(this.relayStatus());
      } catch {
        // diagnostics only: never fail a publish over them
      }
    }
    if (report.accepted.length === 0) {
      const reasons = [
        ...report.rejected.map((r) => `${r.url}: ${r.kind}: ${r.message}`),
        ...skipped.map((u) => `${u}: cooling down`),
      ].join('; ');
      throw new Error(`no relay accepted the event: ${reasons}`);
    }
    return report;
  }

  private async publishTo(
    url: string,
    event: Event,
    retries: number,
  ): Promise<{ url: string; ok: true } | { url: string; ok: false; kind: RelayErrorKind; message: string }> {
    for (let attempt = 0; ; attempt++) {
      await this.sleep(this.pacer(url).take());
      if (this.destroyed) return { url, ok: false, kind: 'connection', message: 'transport closed' };
      let c: ClassifiedRelayError;
      try {
        let relay: Awaited<ReturnType<SimplePool['ensureRelay']>>;
        try {
          relay = await this.pool.ensureRelay(url, { connectionTimeout: this.opts.connectTimeoutMs ?? 3000 });
        } catch (err) {
          // Not connected at all (refused, timed out, DNS): always a connection problem, always worth a retry.
          throw new ConnectError(`connection failure: ${errorText(err)}`);
        }
        relay.publishTimeout = this.opts.publishTimeoutMs ?? 4400;
        await relay.publish(event);
        c = { kind: 'rejected', message: '', duplicate: true, retry: false };
      } catch (err) {
        c = err instanceof ConnectError ? { kind: 'connection', message: errorText(err), retry: true } : classifyRelayError(err);
      }
      const st = this.status(url);
      const at = new Date().toISOString();
      if (c.duplicate) {
        st.last_ok = at;
        st.cooldown_until = null;
        return { url, ok: true };
      }
      if (c.kind === 'blocked' || !c.retry || attempt >= retries) {
        st.last_error = { at, kind: c.kind, message: c.message };
        const cool =
          c.kind === 'blocked' ? (this.opts.blockedCooldownMs ?? 30 * 60_000) : c.retry ? (this.opts.failureCooldownMs ?? 60_000) : 0;
        if (cool > 0) st.cooldown_until = new Date(Date.now() + cool).toISOString();
        return { url, ok: false, kind: c.kind, message: c.message };
      }
      const base = (this.opts.retryBaseMs ?? 400) * 2 ** attempt * (c.kind === 'rate-limited' ? 4 : 1);
      await this.sleep(Math.round(base * (0.5 + Math.random())));
    }
  }

  async sendEnvelope(e: Envelope, recipientRelays: string[] = []): Promise<PublishReport> {
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
    return this.publish(event, recipientRelays);
  }

  onEnvelopes(me: string, handler: (envelope: unknown) => void): () => void {
    return this.subscribe(
      (since) => ({ kinds: [ENVELOPE_KIND], '#p': [agentTag(me)], since }),
      (ev) => handler(safeParse(ev.content)),
    );
  }

  /**
   * A probe gets `d` = hash of its content (one event each). A replaceable
   * document (a public-pointer card) gets `d` = `rdv1/card:` + topic, so
   * relays keep only the newest one per sender and topic (NOTES 63); it is
   * dated no earlier than the card, so a newer card has a later `created_at`.
   */
  async publishTopic(
    topic: string,
    doc: object,
    extraRelays: string[] = [],
    opts: TopicPublishOptions = {},
  ): Promise<PublishReport> {
    const content = canonicalize(doc);
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: ENVELOPE_KIND,
        created_at: opts.replaceable ? Math.max(now, opts.createdAt ?? 0) : now,
        tags: [
          ['t', topic],
          ['d', opts.replaceable ? cardTag(topic) : bytesToHex(sha256(utf8ToBytes(content)))],
        ],
        content,
      },
      this.carrier,
    );
    return this.publish(event, extraRelays);
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
    for (const wake of [...this.sleepers]) wake();
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
  // A relay may hold events far bigger than anything we send; don't parse those.
  if (typeof text !== 'string' || text.length > MAX_EVENT_CONTENT) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
