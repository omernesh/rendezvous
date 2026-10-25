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

export const ENVELOPE_ALG = 'x25519+aes256gcm';

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
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce, canonicalBytes(header)).encrypt(canonicalBytes(payload));
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
  if (!e || e.v !== 1 || !isAgentId(e.from) || typeof e.seq !== 'number') return { ok: false, reason: 'malformed' };
  if (e.to !== recipient.id) return { ok: false, reason: 'not addressed to us' };
  if (!e.content || e.content.alg !== ENVELOPE_ALG) return { ok: false, reason: 'unsupported alg' };
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
    const payload = JSON.parse(new TextDecoder().decode(plain)) as Payload;
    if (!payload || typeof payload.type !== 'string') return { ok: false, reason: 'payload without type' };
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
}

export type InboundOrder =
  | { kind: 'in-order' }
  | { kind: 'duplicate' }
  | { kind: 'gap'; missingFrom: number; missingTo: number }
  | { kind: 'fork' };

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

  /** Classify an inbound envelope; advances state only when in order. */
  acceptInbound(e: Envelope): InboundOrder {
    const c = this.get(e.from);
    // A different envelope with the seq we last accepted: the peer reused a
    // seq (e.g. restored old state). Report it instead of calling it a
    // duplicate (security review L4). Older seqs can't be told apart cheaply.
    if (e.seq === c.inSeq && c.inPrev !== null && envelopeHash(e) !== c.inPrev) return { kind: 'fork' };
    if (e.seq <= c.inSeq) return { kind: 'duplicate' };
    if (e.seq > c.inSeq + 1) return { kind: 'gap', missingFrom: c.inSeq + 1, missingTo: e.seq - 1 };
    if (e.prev !== c.inPrev) return { kind: 'fork' };
    c.inSeq = e.seq;
    c.inPrev = envelopeHash(e);
    return { kind: 'in-order' };
  }
}
