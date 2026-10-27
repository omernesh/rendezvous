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
import { normalizeURL } from 'nostr-tools/utils';
import WebSocket from 'ws';
import { bytesToHex, canonicalize } from '../encoding.js';
import type { Envelope } from '../envelope.js';
import { envelopeHash } from '../envelope.js';
import { type AgentKey, publicKeyFromAgentId } from '../identity.js';
import type {
  MirrorOptions,
  MirrorRelayResult,
  MirrorReport,
  PublishReport,
  RelayErrorKind,
  TopicPublishOptions,
  Transport,
} from './transport.js';

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

/**
 * Relays a card may be mirrored to for discovery (NOTES 81): cards only, never
 * envelopes, so an agent stays findable when its own few relays are not the
 * ones a peer asks. Chosen by the serial mirror survey (deploy/mirror-survey.mjs):
 * each took one kind 30417 card from a throwaway key and served it back on a
 * new connection (2026-10-25, 46 relays, 15 did). Excludes relays known to
 * ban bursts (relay.damus.io) and two that took the card but apply a web of
 * trust after a few events from an unknown key (offchain.pub,
 * nostr.bitcoiner.social; NOTES 11a). It includes DEFAULT_RELAYS, so an agent
 * on other relays is mirrored there too; an agent's own relays are skipped.
 * Lookups query them too; `rdv card publish --mirror` publishes to them, one
 * at a time. Core never applies it on its own.
 */
export const DEFAULT_MIRROR_RELAYS: readonly string[] = Object.freeze([
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.azzamo.net',
  'wss://relay.nostr.wirednet.jp',
  'wss://relay.angor.io',
  'wss://relay.ditto.pub',
  'wss://nostr.chaima.info',
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
  /** Liveness: how often an open relay socket is pinged (ms). Default 30000. */
  pingIntervalMs?: number;
  /** Liveness: how long to wait for the pong before the socket is torn down and re-joined (ms). Default 20000. */
  pingTimeoutMs?: number;
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
  /**
   * Discovery mirrors (NOTES 81): `fetchTopic` asks them too, with bounded
   * concurrency; `mirrorTopics` publishes cards to them. Nothing else goes
   * there: no envelope, no subscription.
   */
  mirrorRelays?: string[];
  /** Mirror relays a lookup asks at once. Default 4. */
  lookupConcurrency?: number;
  /** Status saved by an earlier process for our relays: its cooldowns still hold. */
  relayState?: readonly RelayStatus[];
  /** Called after a publish that went to one of our own relays (`relays` or `mirrorRelays`), with their status. */
  onRelayStatus?: (status: RelayStatus[]) => void;
  /**
   * Called when a listening relay's subscription is confirmed (`up: true`,
   * the first time after start or after a drop) or drops (`up: false`, the
   * first drop of an outage). `down_since` is set while it is down. NOTES 90.
   */
  onRelayLink?: (link: RelayLink) => void;
}

export interface RelayLink {
  url: string;
  up: boolean;
  down_since: string | null;
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
  /**
   * Since when the listening subscription to this relay has been down (ISO),
   * or null while it is up. Absent when this process does not listen on the
   * relay (a one-shot `rdv send`): a merge then keeps the listener's value.
   */
  down_since?: string | null;
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

/**
 * No relay took the event. The message lists each relay's kind and text (for
 * a human's terminal); `report` holds the same per relay, so a host that
 * shows it to a model can quarantine the relays' text (they are parties we do
 * not trust either).
 */
export class NoRelayAcceptedError extends Error {
  constructor(
    message: string,
    readonly report: PublishReport,
  ) {
    super(message);
    this.name = 'NoRelayAcceptedError';
  }
}

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

/**
 * A pool whose relay sockets are pinged, so a half-open connection (the peer
 * vanished without a close, issue #101) is noticed. nostr-tools only exposes
 * on/off for this, and its failed ping calls `ws.close()`, which waits for the
 * close handshake of a peer that is not there (30 s in `ws`); so the interval
 * and timeout are set per relay here and a failed ping `terminate()`s the
 * socket, which closes at once and runs the subscription's `onclose`.
 */
class LivePool extends SimplePool {
  constructor(
    private readonly pingFrequencyMs: number,
    private readonly pingTimeoutMs: number,
  ) {
    super({ enablePing: true });
  }

  override ensureRelay(url: string, params?: Parameters<SimplePool['ensureRelay']>[1]): ReturnType<SimplePool['ensureRelay']> {
    const connecting = super.ensureRelay(url, params);
    // The relay object exists as soon as ensureRelay starts; the ping timer is armed only when its socket opens.
    const relay = this.relays.get(normalizeURL(url)) as unknown as LiveRelay | undefined;
    if (relay && !relay.liveness) {
      relay.liveness = true;
      relay.pingFrequency = this.pingFrequencyMs;
      relay.pingTimeout = this.pingTimeoutMs;
      relay.pingpong = async () => {
        const ws = relay.ws;
        if (!ws || ws.readyState !== 1) return;
        const alive = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => done(false), this.pingTimeoutMs);
          const done = (ok: boolean) => {
            clearTimeout(timer);
            ws.off?.('pong', onPong);
            resolve(ok);
          };
          const onPong = () => done(true);
          ws.on('pong', onPong);
          try {
            ws.ping();
          } catch {
            done(false);
          }
        });
        if (!alive && relay.ws === ws) ws.terminate();
      };
    }
    return connecting;
  }
}

/** The parts of nostr-tools' relay (and its `ws` socket) that LivePool reaches into. */
interface LiveRelay {
  liveness?: boolean;
  pingFrequency: number;
  pingTimeout: number;
  pingpong: () => Promise<void>;
  ws?: {
    readyState: number;
    on(event: 'pong', fn: () => void): void;
    off?(event: 'pong', fn: () => void): void;
    ping(): void;
    terminate(): void;
  };
}

export class NostrTransport implements Transport {
  readonly pool: SimplePool;
  private readonly carrier: Uint8Array;
  readonly carrierPubkey: string;

  /** Per-relay diagnostics and cooldowns, keyed by the URL as configured or as a peer card gave it. */
  private readonly state = new Map<string, RelayStatus>();
  private readonly pacers = new Map<string, Pacer>();
  /** Pending sleeps; close() wakes them, so nothing waits on a closed transport. */
  private readonly sleepers = new Set<() => void>();
  /** Relays whose listening subscription this transport has started: only they carry `down_since`. */
  private readonly linked = new Set<string>();
  private readonly confirmedOnce = new Set<string>();

  /** Our listening relays (envelopes, subscriptions) and our discovery mirrors (cards only). */
  private listen: string[];
  private mirrors: string[];
  /** Open subscriptions, so `setRelays` can join new relays and leave dropped ones. */
  private readonly subscriptions = new Set<{ joined: Map<string, () => void>; join: (relay: string) => () => void }>();

  constructor(private readonly opts: NostrTransportOptions) {
    this.pool = new LivePool(opts.pingIntervalMs ?? 30_000, opts.pingTimeoutMs ?? 20_000);
    this.carrier = nostrCarrierKey(opts.key);
    this.carrierPubkey = getPublicKey(this.carrier);
    this.listen = [...new Set(opts.relays)];
    this.mirrors = [...new Set(opts.mirrorRelays ?? [])].filter((r) => !this.listen.includes(r));
    for (const st of opts.relayState ?? []) {
      if (st && typeof st.url === 'string' && this.isOwn(st.url)) {
        this.state.set(st.url, {
          url: st.url,
          last_ok: typeof st.last_ok === 'string' ? st.last_ok : null,
          last_error: st.last_error && typeof st.last_error === 'object' ? st.last_error : null,
          cooldown_until: typeof st.cooldown_until === 'string' ? st.cooldown_until : null,
          // down_since is per process: the listening link is unknown until this one joins it.
        });
      }
    }
  }

  get relays(): string[] {
    return [...this.listen];
  }

  get mirrorRelays(): string[] {
    return [...this.mirrors];
  }

  private isOwn(url: string): boolean {
    return this.listen.includes(url) || this.mirrors.includes(url);
  }

  /**
   * Move to other relays (`rdv relays add/remove`) without a restart: open
   * subscriptions join the new relays and leave the dropped ones; later
   * publishes and lookups use the new sets. State and cooldowns are kept.
   */
  setRelays(relays: readonly string[], mirrorRelays: readonly string[] = this.mirrors): void {
    const next = [...new Set(relays)];
    if (next.length === 0) throw new Error('a transport needs at least one relay');
    const dropped = this.listen.filter((r) => !next.includes(r));
    const added = next.filter((r) => !this.listen.includes(r));
    this.listen = next;
    this.mirrors = [...new Set(mirrorRelays)].filter((r) => !next.includes(r));
    for (const sub of this.subscriptions) {
      for (const r of dropped) {
        sub.joined.get(r)?.();
        sub.joined.delete(r);
      }
      for (const r of added) if (!sub.joined.has(r)) sub.joined.set(r, sub.join(r));
    }
    for (const r of dropped) if (!this.mirrors.includes(r)) this.pool.close([r]);
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
    const join = (relay: string): (() => void) => {
      let left = false; // this relay was dropped by setRelays
      let current: { close(): void } | undefined;
      let attempt = 0;
      let newest: number | undefined; // newest created_at seen on this relay, capped at now
      let confirmed = false; // the link was confirmed up since it was last down (or since start)
      this.linked.add(relay);
      this.status(relay).down_since = null;
      const open = () => {
        let dropped = false;
        const since = newest === undefined ? this.since() : Math.max(this.since(), newest - margin);
        const sub = this.pool.subscribeMany([relay], filter(since), {
          onevent: (ev) => {
            newest = Math.max(newest ?? 0, Math.min(ev.created_at, Math.floor(Date.now() / 1000)));
            if (!dropped && !left && !confirmed) {
              confirmed = true;
              this.linkUp(relay);
            }
            if (fresh(ev.id)) onevent(ev);
          },
          oneose: () => {
            // nostr-tools also fires oneose just before onclose when the
            // connect fails; only a subscription still open resets backoff.
            queueMicrotask(() => {
              if (dropped) return;
              attempt = 0;
              if (!confirmed && !left) {
                confirmed = true;
                this.linkUp(relay);
              }
            });
          },
          onclose: (reasons) => {
            dropped = true;
            subs.delete(sub);
            if (closed || left || this.destroyed) return;
            confirmed = false;
            this.linkDown(relay, reasons?.[0]?.reason);
            const delay = Math.min(30_000, (this.opts.reconnectBaseMs ?? 1000) * 2 ** attempt++);
            const t = setTimeout(() => {
              this.timers.delete(t);
              if (!closed && !left && !this.destroyed) open();
            }, delay);
            this.timers.add(t);
          },
        });
        if (!dropped) {
          subs.add(sub);
          current = sub;
        }
      };
      open();
      return () => {
        left = true;
        if (current) {
          subs.delete(current);
          current.close();
        }
      };
    };
    const entry = { joined: new Map<string, () => void>(), join };
    for (const relay of this.listen) entry.joined.set(relay, join(relay));
    this.subscriptions.add(entry);
    return () => {
      closed = true;
      this.subscriptions.delete(entry);
      for (const sub of subs) sub.close();
      subs.clear();
    };
  }

  /** A listening subscription is confirmed (EOSE or an event): the relay is up. Persist only a change. */
  private linkUp(url: string): void {
    const st = this.status(url);
    const wasDown = typeof st.down_since === 'string';
    const first = !this.confirmedOnce.has(url);
    st.down_since = null;
    this.confirmedOnce.add(url);
    // First confirmation also clears a stale mark a crashed listener left in relays.json.
    if (wasDown || first) this.reportStatus();
    this.emitLink({ url, up: true, down_since: null });
  }

  /** A listening subscription dropped. The first drop of an outage starts `down_since`; later ones only refresh the error. */
  private linkDown(url: string, reason: unknown): void {
    if (this.destroyed || !this.isOwn(url)) return;
    const st = this.status(url);
    const c = classifyRelayError(typeof reason === 'string' && reason ? reason : 'connection closed');
    st.last_error = { at: new Date().toISOString(), kind: c.kind, message: c.message };
    if (st.down_since === null || st.down_since === undefined) {
      st.down_since = st.last_error.at;
      this.reportStatus();
      this.emitLink({ url, up: false, down_since: st.down_since });
    }
  }

  private emitLink(link: RelayLink): void {
    try {
      this.opts.onRelayLink?.(link);
    } catch {
      // diagnostics only: never break the subscription over a callback
    }
  }

  private since(): number {
    return Math.floor(Date.now() / 1000) - (this.opts.lookbackSeconds ?? 2 * 86_400);
  }

  /** Our relays' diagnostics, in configured order. Relays from peer cards are not listed (their URLs are peer text). */
  relayStatus(): RelayStatus[] {
    return this.statusOf(this.listen);
  }

  /** Our mirrors' diagnostics (bans and cooldowns earned by a mirror run). */
  mirrorStatus(): RelayStatus[] {
    return this.statusOf(this.mirrors);
  }

  private statusOf(urls: string[]): RelayStatus[] {
    return urls.map((url) => {
      const st = this.state.get(url);
      const out: RelayStatus = st ? { ...st } : { url, last_ok: null, last_error: null, cooldown_until: null };
      if (!this.linked.has(url)) delete out.down_since;
      return out;
    });
  }

  private status(url: string): RelayStatus {
    let st = this.state.get(url);
    if (!st) {
      if (this.state.size >= MAX_RELAY_STATE) {
        // Drop the oldest peer relay's state; ours stay.
        for (const k of this.state.keys()) {
          if (!this.isOwn(k)) {
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
    const relays = [...new Set([...this.listen, ...extraRelays])];
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
    if (targets.some((u) => this.isOwn(u))) this.reportStatus();
    if (report.accepted.length === 0) {
      const reasons = [
        ...report.rejected.map((r) => `${r.url}: ${r.kind}: ${r.message}`),
        ...skipped.map((u) => `${u}: cooling down`),
      ].join('; ');
      throw new NoRelayAcceptedError(`no relay accepted the event: ${reasons}`, report);
    }
    return report;
  }

  private reportStatus(): void {
    try {
      this.opts.onRelayStatus?.([...this.relayStatus(), ...this.mirrorStatus()]);
    } catch {
      // diagnostics only: never fail a publish over them
    }
  }

  private async publishTo(
    url: string,
    event: Event,
    retries: number,
    timeouts: { connectMs?: number; okMs?: number } = {},
  ): Promise<{ url: string; ok: true } | { url: string; ok: false; kind: RelayErrorKind; message: string }> {
    for (let attempt = 0; ; attempt++) {
      await this.sleep(this.pacer(url).take());
      if (this.destroyed) return { url, ok: false, kind: 'connection', message: 'transport closed' };
      let c: ClassifiedRelayError;
      try {
        let relay: Awaited<ReturnType<SimplePool['ensureRelay']>>;
        try {
          relay = await this.pool.ensureRelay(url, { connectionTimeout: timeouts.connectMs ?? this.opts.connectTimeoutMs ?? 3000 });
        } catch (err) {
          // Not connected at all (refused, timed out, DNS): always a connection problem, always worth a retry.
          throw new ConnectError(`connection failure: ${errorText(err)}`);
        }
        relay.publishTimeout = timeouts.okMs ?? this.opts.publishTimeoutMs ?? 4400;
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
    return this.publish(this.topicEvent(topic, doc, opts), extraRelays);
  }

  private topicEvent(topic: string, doc: object, opts: TopicPublishOptions): Event {
    const content = canonicalize(doc);
    const now = Math.floor(Date.now() / 1000);
    return finalizeEvent(
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
  }

  /**
   * Mirror replaceable documents (our card on each of its topics) for
   * discovery (NOTES 81): our listening relays first, then `opts.relays`.
   * Strictly serial and gentle: one relay at a time, a pause between relays,
   * one try each (no retry burst), the transport's pacing and cooldowns (a
   * relay cooling down after a ban or failure is skipped, not contacted). A
   * relay that turns down one document gets no more. Then, unless
   * `readBack: false`, each relay that took them is asked for them on its own
   * (by our carrier pubkey and `d`), also serially. Never throws for a relay;
   * the report says what each did.
   */
  async mirrorTopics(docs: Array<{ topic: string; doc: object; createdAt?: number }>, opts: MirrorOptions): Promise<MirrorReport> {
    const events = docs.map((d) => this.topicEvent(d.topic, d.doc, { replaceable: true, createdAt: d.createdAt }));
    const order = [...new Set([...this.listen, ...opts.relays])];
    const gap = Math.max(0, opts.gapMs ?? 1500);
    const timeout = Math.max(100, opts.timeoutMs ?? 6000);
    const results: MirrorRelayResult[] = [];
    let contacted = 0;
    for (const url of order) {
      if (this.destroyed) break;
      const role = this.listen.includes(url) ? 'listen' : 'mirror';
      if (this.coolingDown(url, Date.now())) {
        results.push({ url, role, result: 'skipped', message: 'cooling down', served: null });
        continue;
      }
      if (contacted++ > 0) await this.sleep(gap);
      let row: MirrorRelayResult = { url, role, result: 'accepted', served: null };
      for (const ev of events) {
        const r = await this.publishTo(url, ev, 0, { connectMs: timeout, okMs: timeout });
        if (!r.ok) {
          row = { url, role, result: r.kind === 'timeout' ? 'timeout' : 'rejected', kind: r.kind, message: r.message, served: null };
          break;
        }
      }
      results.push(row);
    }
    if (opts.readBack !== false) {
      const wait = opts.readBackWaitMs ?? 5000;
      for (const row of results) {
        if (row.result !== 'accepted' || this.destroyed) continue;
        row.served = await this.serves(row.url, events, wait);
      }
    }
    for (const url of order) if (!this.listen.includes(url)) this.pool.close([url]); // no idle sockets left on mirrors
    this.reportStatus();
    const count = (r: MirrorRelayResult['result']) => results.filter((x) => x.result === r).length;
    return {
      topics: docs.map((d) => d.topic),
      relays: results,
      accepted: count('accepted'),
      rejected: count('rejected'),
      timeout: count('timeout'),
      skipped: count('skipped'),
      served: results.filter((x) => x.served === true).length,
    };
  }

  /** Whether `url` serves each of these events (or a newer one with the same `d`) from our carrier pubkey. */
  private async serves(url: string, events: Event[], maxWaitMs: number): Promise<boolean> {
    const dOf = (e: Event) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    try {
      const got = await this.pool.querySync(
        [url],
        { kinds: [ENVELOPE_KIND], authors: [this.carrierPubkey], '#d': events.map(dOf) },
        { maxWait: maxWaitMs },
      );
      return events.every((e) => got.some((g) => dOf(g) === dOf(e) && (g.id === e.id || g.created_at >= e.created_at)));
    } catch {
      return false;
    }
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

  /**
   * One-shot fetch of documents already stored on a topic (public pointers):
   * our relays at once, and the mirrors (NOTES 81) at most
   * `lookupConcurrency` at a time, each within `maxWaitMs`. Events are
   * de-duplicated by id; a mirror's socket is closed after its answer.
   */
  async fetchTopic(topic: string, maxWaitMs = 3000, opts: { mirrors?: boolean } = {}): Promise<unknown[]> {
    const filter: Filter = { kinds: [ENVELOPE_KIND], '#t': [topic] };
    const seen = new Map<string, Event>();
    const keep = (evs: Event[]) => {
      for (const ev of evs) if (!seen.has(ev.id)) seen.set(ev.id, ev);
    };
    const query = (relays: string[]) => this.pool.querySync(relays, filter, { maxWait: maxWaitMs }).catch(() => [] as Event[]);
    const mirrors = opts.mirrors === false ? [] : [...this.mirrors];
    const own = query(this.listen).then(keep);
    const workers = Array.from({ length: Math.min(mirrors.length, Math.max(1, this.opts.lookupConcurrency ?? 4)) }, async () => {
      for (let url = mirrors.shift(); url !== undefined && !this.destroyed; url = mirrors.shift()) {
        keep(await query([url]));
        if (!this.listen.includes(url)) this.pool.close([url]);
      }
    });
    await Promise.all([own, ...workers]);
    return [...seen.values()].map((ev) => safeParse(ev.content));
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
