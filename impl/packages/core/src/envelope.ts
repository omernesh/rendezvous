// §6.4: the signed, end-to-end encrypted envelope, plus per-peer ordering (§7).
//
// Encryption: ephemeral X25519 (sender) × recipient's X25519 key (derived from
// its Ed25519 identity) → HKDF-SHA256 → AES-256-GCM, with the cleartext header
// as associated data. The Ed25519 signature covers the whole envelope
// including `content`, so a relay can't graft foreign ciphertext under a
// genuine header (see impl/NOTES.md, "spec deltas").
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { b64decode, b64encode, bytesToHex, canonicalBytes, parseTimestamp } from './encoding.js';
import { type AgentKey, isAgentId, x25519PublicFromAgentId, x25519Secret } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';
import { ACK_TYPE } from './delivery.js';

export const ENVELOPE_ALG = 'x25519+aes256gcm';

/**
 * Largest envelope plaintext (the payload's canonical JSON, UTF-8), SPEC §6.4.
 * Sealed, such an envelope is about 45 KB as a Nostr event, well under the
 * 128 KB message cap of the smallest relay we use (NOTES 70).
 */
export const MAX_PLAINTEXT_BYTES = 32 * 1024;

/** AES-GCM adds a 16-byte tag; base64 of the largest ciphertext we accept. */
const MAX_CIPHERTEXT_B64 = Math.ceil((MAX_PLAINTEXT_BYTES + 16) / 3) * 4;

/** Thrown by `sealEnvelope` for a payload over MAX_PLAINTEXT_BYTES. Holds no payload content. */
export class EnvelopeTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`payload is ${bytes} bytes; an envelope carries at most ${MAX_PLAINTEXT_BYTES} bytes of plaintext (SPEC §6.4)`);
    this.name = 'EnvelopeTooLargeError';
  }
}

export interface EnvelopeHeader {
  v: 1;
  from: string;
  to: string;
  seq: number;
  prev: string | null;
  created: string;
  ttl: string;
}

export interface EnvelopeBody extends EnvelopeHeader {
  content: { alg: typeof ENVELOPE_ALG; epk: string; nonce: string; ciphertext: string };
}

export type Envelope = Signed<EnvelopeBody>;

/** Anything the agents exchange inside an envelope; `type` routes it. */
export interface Payload {
  type: string;
  [k: string]: unknown;
}

function headerOf(e: EnvelopeHeader): EnvelopeHeader {
  const { v, from, to, seq, prev, created, ttl } = e;
  return { v, from, to, seq, prev, created, ttl };
}

function deriveKey(shared: Uint8Array, epk: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(epk, recipientPub), utf8ToBytes('rdv1/envelope'), 32);
}

export function sealEnvelope(
  sender: AgentKey,
  to: string,
  payload: { type: string },
  opts: { seq: number; prev: string | null; ttl?: string; now?: Date },
): Envelope {
  const header: EnvelopeHeader = {
    v: 1,
    from: sender.id,
    to,
    seq: opts.seq,
    prev: opts.prev,
    created: (opts.now ?? new Date()).toISOString(),
    ttl: opts.ttl ?? '48h',
  };
  if (parseTtl(header.ttl) > MAX_TTL_MS) throw new Error(`ttl ${header.ttl} exceeds 7 days`);
  const recipientPub = x25519PublicFromAgentId(to);
  const esk = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(esk);
  const key = deriveKey(x25519.getSharedSecret(esk, recipientPub), epk, recipientPub);
  const plain = canonicalBytes(payload);
  if (plain.length > MAX_PLAINTEXT_BYTES) throw new EnvelopeTooLargeError(plain.length);
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce, canonicalBytes(header)).encrypt(plain);
  return signDoc<EnvelopeBody>(
    {
      ...header,
      content: { alg: ENVELOPE_ALG, epk: b64encode(epk), nonce: b64encode(nonce), ciphertext: b64encode(ciphertext) },
    },
    sender,
  );
}

export type OpenResult = { ok: true; payload: Payload; envelope: Envelope } | { ok: false; reason: string };

export function openEnvelope(recipient: AgentKey, input: unknown, now: Date = new Date()): OpenResult {
  const e = input as Envelope;
  if (!e || e.v !== 1 || !isAgentId(e.from) || !Number.isSafeInteger(e.seq) || e.seq < 0) return { ok: false, reason: 'malformed' };
  // `seq` 0 is outside every chain (a receipt, SPEC §6.4.2): it has no predecessor.
  if (e.seq === 0 && e.prev !== null) return { ok: false, reason: 'malformed' };
  if (e.to !== recipient.id) return { ok: false, reason: 'not addressed to us' };
  if (!e.content || e.content.alg !== ENVELOPE_ALG) return { ok: false, reason: 'unsupported alg' };
  // Before the signature check and decryption: a length is cheap (SPEC §6.4).
  if (typeof e.content.ciphertext !== 'string' || e.content.ciphertext.length > MAX_CIPHERTEXT_B64) {
    return { ok: false, reason: 'too large' };
  }
  if (!verifyDoc(e, e.from)) return { ok: false, reason: 'bad signature' };
  const created = parseTimestamp(e.created);
  if (created === null) return { ok: false, reason: 'bad created' };
  if (isExpired(e, now)) return { ok: false, reason: 'expired' };
  // Replay protection must not rest on seq alone (security review L5).
  if (parseTtl(e.ttl) > MAX_TTL_MS) return { ok: false, reason: 'ttl too long' };
  if (created > now.getTime() + MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'created in the future' };
  try {
    const epk = b64decode(e.content.epk);
    const myPub = x25519PublicFromAgentId(recipient.id);
    const key = deriveKey(x25519.getSharedSecret(x25519Secret(recipient), epk), epk, myPub);
    const plain = gcm(key, b64decode(e.content.nonce), canonicalBytes(headerOf(e))).decrypt(
      b64decode(e.content.ciphertext),
    );
    if (plain.length > MAX_PLAINTEXT_BYTES) return { ok: false, reason: 'too large' };
    const payload = JSON.parse(new TextDecoder().decode(plain)) as Payload;
    if (!payload || typeof payload.type !== 'string') return { ok: false, reason: 'payload without type' };
    // Only a receipt lives outside the chains (SPEC §6.4.2): anything else at seq 0 is malformed.
    if (e.seq === 0 && payload.type !== ACK_TYPE) return { ok: false, reason: 'malformed' };
    return { ok: true, payload, envelope: e };
  } catch {
    return { ok: false, reason: 'decryption failed' };
  }
}

/** Hash used for `prev` chaining and as a stable envelope identifier. */
export function envelopeHash(e: Envelope): string {
  return bytesToHex(sha256(canonicalBytes(e)));
}

/** Longest envelope lifetime we accept, and how far ahead of our clock `created` may be. */
export const MAX_TTL_MS = 7 * 86_400_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export function parseTtl(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) throw new Error(`bad ttl: ${ttl}`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

export function isExpired(e: EnvelopeHeader, now: Date): boolean {
  try {
    const created = parseTimestamp(e.created);
    return created === null || created + parseTtl(e.ttl) <= now.getTime();
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Ordering: `seq` is per-direction monotonic, `prev` chains to the previous
// envelope in that direction; gaps trigger a resend request (§7).

export interface ChannelState {
  outSeq: number;
  outPrev: string | null;
  inSeq: number;
  inPrev: string | null;
  /** Hashes of the last accepted inbound envelopes, oldest first; the last one is `inPrev` (at most ROLLBACK_WINDOW). */
  inRecent?: string[];
  /** Newest `created` (ms) among accepted inbound envelopes: a relay replay can't be newer than this. */
  inNewest?: number;
  /** Set when the peer forked or rolled back its chain: inbound is refused until the owner calls `resync`. */
  refused?: RefusedChannel;
  /** The owner allowed a re-sync: the next inbound envelope newer than `inNewest` becomes the chain head. */
  resync?: true;
  /**
   * Set by a re-sync: the newest `created` of the chain it replaced. Anything
   * not newer is a replay of that chain and stays a duplicate on every path
   * (gap and fork included), so a relay can't re-refuse the channel.
   */
  inFloor?: number;
  /**
   * After a restore from a backup (NOTES 91): `due` until our `rdv/restored`
   * notice to this peer is sealed, then that notice's hash until the peer's
   * `rdv/restored-ack` for it arrives.
   */
  restoreNotice?: 'due' | string;
}

export interface RefusedChannel {
  kind: 'fork' | 'rollback';
  /** The offending envelope's seq and hash (a relay replay of it stays silent). */
  seq: number;
  hash: string;
  /** Its `created` (ms): the re-sync floor when the channel has no `inNewest` (state saved before it existed). */
  created?: number;
  /** Our `inSeq` when it arrived. */
  accepted: number;
}

/** How many accepted inbound hashes a channel keeps to tell a replay from a rollback (NOTES 56). */
export const ROLLBACK_WINDOW = 8;

export type InboundOrder =
  | { kind: 'in-order' }
  | { kind: 'duplicate' }
  | { kind: 'gap'; missingFrom: number; missingTo: number }
  /** `prev` doesn't match our chain head. The channel is refused from now on. */
  | { kind: 'fork'; seq: number; accepted: number }
  /** A seq we already accepted, with different content: the peer restored older state. Refused from now on. */
  | { kind: 'rollback'; seq: number; accepted: number }
  /** The channel is refused (an earlier fork or rollback) until the owner re-syncs it. */
  | { kind: 'refused'; seq: number; accepted: number };

export class Channels {
  constructor(public state: Record<string, ChannelState> = {}) {}

  private get(peer: string): ChannelState {
    return (this.state[peer] ??= { outSeq: 0, outPrev: null, inSeq: 0, inPrev: null });
  }

  nextOutbound(peer: string): { seq: number; prev: string | null } {
    const c = this.get(peer);
    return { seq: c.outSeq + 1, prev: c.outPrev };
  }

  commitOutbound(peer: string, e: Envelope): void {
    const c = this.get(peer);
    c.outSeq = e.seq;
    c.outPrev = envelopeHash(e);
  }

  /** Why inbound from `peer` is refused, if it is. */
  refused(peer: string): RefusedChannel | undefined {
    return this.state[peer]?.refused;
  }

  /**
   * The owner's decision after a fork or rollback, never the library's: the
   * next envelope from `peer` that is newer than everything accepted so far
   * becomes the new chain head. Relay replays of the old chain stay
   * duplicates, because none of them is newer.
   */
  resync(peer: string): void {
    const c = this.state[peer];
    if (!c?.refused) throw new Error(`channel with ${peer} is not refused`);
    // Everything of the replaced chain is at or below this: it can never come back as a gap or fork.
    const floor = c.inNewest ?? (c.refused.created === undefined ? undefined : c.refused.created - 1);
    if (floor !== undefined) c.inFloor = Math.max(c.inFloor ?? floor, floor);
    if (c.inNewest === undefined && floor !== undefined) c.inNewest = floor; // so only something newer is adopted
    delete c.refused;
    c.resync = true;
  }

  /**
   * A peer's signed `rdv/restored` notice (NOTES 91): its new chain starts at
   * `e`. Everything not newer than `e` is a replay of the chain it replaced
   * (inFloor), and the next envelope must follow `e`. The caller checked
   * that `e` is newer than everything we accepted from the peer, and that the
   * channel is not refused (a refusal stays the human's to lift, by resync).
   * Returns the state it replaced, for the event.
   */
  rebase(e: Envelope): { inSeq: number; refused?: RefusedChannel['kind'] } {
    const c = this.get(e.from);
    const before = { inSeq: c.inSeq, ...(c.refused ? { refused: c.refused.kind } : {}) };
    const created = parseTimestamp(e.created);
    if (created === null) throw new Error('rebase: envelope without a valid created');
    const hash = envelopeHash(e);
    c.inFloor = Math.max(c.inFloor ?? Number.NEGATIVE_INFINITY, c.inNewest ?? Number.NEGATIVE_INFINITY, created - 1);
    delete c.refused;
    delete c.resync;
    c.inSeq = e.seq;
    c.inPrev = hash;
    c.inRecent = [hash];
    c.inNewest = created;
    return before;
  }

  /**
   * Our own restore, closed by the peer's `rdv/restored-ack` (NOTES 91): the
   * peer's chain towards us goes on at `fromSeq`, after an envelope whose hash
   * is `prev`; what it sent before that is gone with the copy we lost. Moves
   * only forward. `floor`: what is not newer is a replay of the skipped part.
   */
  skipTo(peer: string, fromSeq: number, prev: string | null, floor: number): boolean {
    const c = this.state[peer];
    if (!c || fromSeq <= c.inSeq + 1) return false;
    c.inSeq = fromSeq - 1;
    c.inPrev = prev;
    c.inRecent = prev === null ? [] : [prev];
    c.inFloor = Math.max(c.inFloor ?? Number.NEGATIVE_INFINITY, floor);
    return true;
  }

  /** The hash we accepted at `seq`, if it is still in the window. */
  private acceptedHash(c: ChannelState, seq: number): string | undefined {
    const back = c.inSeq - seq;
    if (back < 0) return undefined;
    const recent = c.inRecent ?? (c.inPrev === null ? [] : [c.inPrev]); // state saved before the window existed
    return back < recent.length ? recent[recent.length - 1 - back] : undefined;
  }

  private advance(c: ChannelState, e: Envelope, hash: string, created: number): void {
    c.inSeq = e.seq;
    c.inPrev = hash;
    c.inRecent = [...(c.inRecent ?? []), hash].slice(-ROLLBACK_WINDOW);
    if (Number.isFinite(created)) c.inNewest = Math.max(c.inNewest ?? created, created);
  }

  private refuse(c: ChannelState, kind: 'fork' | 'rollback', e: Envelope, hash: string): InboundOrder {
    const created = parseTimestamp(e.created);
    c.refused = { kind, seq: e.seq, hash, accepted: c.inSeq, ...(created === null ? {} : { created }) };
    return { kind, seq: e.seq, accepted: c.inSeq };
  }

  /** Drop all state for `peer` (a sender we no longer keep a channel for, NOTES 64). */
  forget(peer: string): void {
    delete this.state[peer];
  }

  /**
   * Classify an inbound envelope; advances state only when in order. With
   * `adopt`, a sender we hold no state for starts its chain at `e`, whatever
   * its seq: the receiver keeps no state for senders it hasn't admitted, so
   * such a sender's chain may already be under way (NOTES 64).
   */
  acceptInbound(e: Envelope, opts: { adopt?: boolean } = {}): InboundOrder {
    if (opts.adopt && !Object.hasOwn(this.state, e.from)) {
      this.advance(this.get(e.from), e, envelopeHash(e), parseTimestamp(e.created) ?? Number.NEGATIVE_INFINITY);
      return { kind: 'in-order' };
    }
    const c = this.get(e.from);
    const hash = envelopeHash(e);
    const created = parseTimestamp(e.created) ?? Number.NEGATIVE_INFINITY;
    const newer = c.inNewest === undefined || created > c.inNewest;
    // A replay of a chain the owner re-synced away from (before gap or fork can be reported).
    if (c.inFloor !== undefined && !(created > c.inFloor)) return { kind: 'duplicate' };
    if (c.resync) {
      // Only something newer than all we accepted can be the peer's current chain.
      if (!newer) return { kind: 'duplicate' };
      delete c.resync;
      c.inRecent = [];
      this.advance(c, e, hash, created);
      return { kind: 'in-order' };
    }
    if (e.seq <= c.inSeq) {
      // Identical bytes are a relay replay. A different envelope at a seq we
      // still hold a hash for, or one newer than everything we accepted, means
      // the peer reused seqs: it restored older state (L4, issue #13).
      const known = this.acceptedHash(c, e.seq);
      if (known === hash || hash === c.refused?.hash) return { kind: 'duplicate' };
      if (known === undefined && (c.inNewest === undefined || !newer)) return { kind: 'duplicate' }; // too old to tell (NOTES 56)
      if (c.refused) return { kind: 'refused', seq: e.seq, accepted: c.inSeq };
      return this.refuse(c, 'rollback', e, hash);
    }
    if (c.refused) return hash === c.refused.hash ? { kind: 'duplicate' } : { kind: 'refused', seq: e.seq, accepted: c.inSeq };
    if (e.seq > c.inSeq + 1) return { kind: 'gap', missingFrom: c.inSeq + 1, missingTo: e.seq - 1 };
    if (e.prev !== c.inPrev) return this.refuse(c, 'fork', e, hash);
    this.advance(c, e, hash, created);
    return { kind: 'in-order' };
  }
}
