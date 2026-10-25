// SPEC §7.7: file references (issue #26). A file too big to travel inline is
// referenced: a URL the sender chose (any store, Blossom optional) or a direct
// transfer, plus the SHA-256 of exactly the bytes the receiver will get and,
// when encrypted, the AES-256-GCM key, nonce and the plaintext's SHA-256.
//
// Everything here is pure: types, strict validation, encryption and
// verification. Fetching lives in `filefetch.ts`, transfer negotiation in
// `transfer.ts`. Nothing in core fetches a URL because a reference arrived.
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { b64decode, b64encode, bytesToHex, parseTimestamp } from './encoding.js';

/** The files extension (§7.7): its metadata key on a `FilePart`. */
export const FILES_EXT = 'https://rendezvous.nesher.co/ext/files/v1';
/** `enc.alg` of an encrypted file. */
export const FILE_ENC_ALG = 'aes256gcm';
/** AES-GCM associated data for file bytes, so a file ciphertext is never mistaken for an envelope's. */
export const FILE_AD = 'rdv1/blob';
/** Largest file that may travel inline (`file.bytes`), decoded (§7.4). */
export const MAX_INLINE_FILE_BYTES = 16 * 1024;
/** The reference receiver's default cap on a referenced file (§7.4, receiver policy). */
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Upper bound on a `size` we even parse (1 TiB); the receiver's own cap applies on fetch. */
export const MAX_FILE_REF_SIZE = 2 ** 40;
export const MAX_URI_LENGTH = 2048;
export const MAX_MIRRORS = 8;
export const MAX_P2P_PROTOCOLS = 8;
export const MAX_FILE_NAME_LENGTH = 255;

const HEX64 = /^[0-9a-f]{64}$/;
/** A transfer protocol name, `<name>/<version>` (e.g. `webrtc-datachannel/1`). */
const PROTOCOL = /^[a-z][a-z0-9.-]{0,47}\/[0-9]{1,4}$/;
/** A transfer protocol name as `p2p` and `rdv/transfer` carry it: `<name>/<version>`, at most 53 chars. */
export function isTransferProtocol(s: unknown): s is string {
  return typeof s === 'string' && PROTOCOL.test(s);
}
/** RFC 6838 type/subtype, no parameters, lowercase. */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
// C0, DEL, C1, and bidi / zero-width controls that can disguise a name.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

export interface FileEnc {
  alg: typeof FILE_ENC_ALG;
  /** base64, 32 bytes. Fresh per file, never reused. */
  key: string;
  /** base64, 12 bytes. */
  nonce: string;
  /** hex SHA-256 of the plaintext. */
  plain_sha256: string;
}

/** The files-extension metadata on a `FilePart` (§7.7). */
export interface FileRefMeta {
  /** hex SHA-256 of exactly the bytes the receiver fetches (the ciphertext when `enc` is present). */
  sha256: string;
  /** Their length in bytes. */
  size: number;
  enc?: FileEnc;
  mirrors?: string[];
  p2p?: string[];
  expires?: string;
}

/** A file reference in one flat object: what the helpers take. `uri` is absent only when `p2p` is offered. */
export interface FileRef extends FileRefMeta {
  uri?: string;
  mimeType?: string;
  /** Display only, sanitized (`sanitizeFileName`). */
  name?: string;
}

/** A2A `FilePart` carrying a reference, as it goes on the wire. */
export interface FileRefPart {
  kind: 'file';
  file: { uri?: string; mimeType?: string; name?: string };
  metadata: { [FILES_EXT]: FileRefMeta; [k: string]: unknown };
}

/** A2A `FilePart` with inline bytes (at most MAX_INLINE_FILE_BYTES decoded). */
export interface InlineFilePart {
  kind: 'file';
  file: { bytes: string; mimeType?: string; name?: string };
  metadata?: Record<string, unknown>;
}

export type ParsedFilePart =
  | { kind: 'inline'; bytes: Uint8Array; mimeType?: string; name?: string }
  | { kind: 'ref'; ref: FileRef };

export type FileResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Thrown by `verifyAndDecrypt` and the fetch helper. `code` is stable; the message holds no peer text. */
export class FileRefError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileRefError';
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(o).every((k) => allowed.includes(k));
}

function decodedLength(b64: unknown): number | null {
  if (typeof b64 !== 'string' || b64.length > 64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    return b64decode(b64).length;
  } catch {
    return null;
  }
}

/**
 * Validates a URL a peer sent for a file: `https` only, no userinfo (a peer
 * must not make us send credentials), a host, at most MAX_URI_LENGTH chars and
 * nothing a URL parser would rewrite silently (whitespace, controls,
 * backslashes). Returns the parsed URL or a reason. It says nothing about the
 * address the host resolves to; the fetch helper checks that.
 */
export function checkFileUri(uri: unknown): FileResult<URL> {
  if (typeof uri !== 'string' || uri.length === 0) return { ok: false, reason: 'uri not a string' };
  if (uri.length > MAX_URI_LENGTH) return { ok: false, reason: 'uri too long' };
  if (/[\s\u0000-\u001f\u007f-\u009f\\]/.test(uri)) return { ok: false, reason: 'uri has whitespace or control characters' };
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, reason: 'uri not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'uri scheme not https' };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'uri carries credentials' };
  if (u.hostname === '') return { ok: false, reason: 'uri has no host' };
  return { ok: true, value: u };
}

/**
 * Display form of a peer-supplied file name (§5.6 rule 5): no control, bidi
 * or zero-width characters, no path separators, no leading dots or spaces,
 * at most MAX_FILE_NAME_LENGTH chars. Undefined when nothing is left.
 */
export function sanitizeFileName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const s = name
    .slice(0, 4 * MAX_FILE_NAME_LENGTH)
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/[/\\]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return s === '' ? undefined : s;
}

function parseEnc(x: unknown, size: number): FileResult<FileEnc> {
  if (!isPlainObject(x) || !onlyKeys(x, ['alg', 'key', 'nonce', 'plain_sha256'])) return { ok: false, reason: 'enc malformed' };
  if (x.alg !== FILE_ENC_ALG) return { ok: false, reason: 'enc alg unsupported' };
  if (decodedLength(x.key) !== 32) return { ok: false, reason: 'enc key not 32 bytes' };
  if (decodedLength(x.nonce) !== 12) return { ok: false, reason: 'enc nonce not 12 bytes' };
  if (typeof x.plain_sha256 !== 'string' || !HEX64.test(x.plain_sha256)) return { ok: false, reason: 'enc plain_sha256 malformed' };
  if (size < 16) return { ok: false, reason: 'enc size shorter than the GCM tag' };
  return { ok: true, value: { alg: FILE_ENC_ALG, key: x.key as string, nonce: x.nonce as string, plain_sha256: x.plain_sha256 } };
}

function parseStringList(x: unknown, max: number, check: (s: string) => boolean, what: string): FileResult<string[]> {
  if (!Array.isArray(x) || x.length === 0 || x.length > max) return { ok: false, reason: `${what} not a list of 1..${max}` };
  if (!x.every((s) => typeof s === 'string' && check(s))) return { ok: false, reason: `${what} entry malformed` };
  if (new Set(x).size !== x.length) return { ok: false, reason: `${what} has duplicates` };
  return { ok: true, value: [...(x as string[])] };
}

/** Validates the files-extension metadata (§7.7). Unknown keys are refused: this metadata is not ignorable. */
export function parseFileRefMeta(x: unknown): FileResult<FileRefMeta> {
  if (!isPlainObject(x) || !onlyKeys(x, ['sha256', 'size', 'enc', 'mirrors', 'p2p', 'expires'])) {
    return { ok: false, reason: 'file metadata malformed' };
  }
  if (typeof x.sha256 !== 'string' || !HEX64.test(x.sha256)) return { ok: false, reason: 'sha256 malformed' };
  const size = x.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_REF_SIZE) {
    return { ok: false, reason: 'size malformed' };
  }
  const meta: FileRefMeta = { sha256: x.sha256, size };
  if (x.enc !== undefined) {
    const enc = parseEnc(x.enc, size);
    if (!enc.ok) return enc;
    meta.enc = enc.value;
  }
  if (x.mirrors !== undefined) {
    const m = parseStringList(x.mirrors, MAX_MIRRORS, (s) => checkFileUri(s).ok, 'mirrors');
    if (!m.ok) return m;
    meta.mirrors = m.value;
  }
  if (x.p2p !== undefined) {
    const p = parseStringList(x.p2p, MAX_P2P_PROTOCOLS, isTransferProtocol, 'p2p');
    if (!p.ok) return p;
    meta.p2p = p.value;
  }
  if (x.expires !== undefined) {
    if (parseTimestamp(x.expires) === null) return { ok: false, reason: 'expires malformed' };
    meta.expires = x.expires as string;
  }
  return { ok: true, value: meta };
}

function parseMime(x: unknown): FileResult<string | undefined> {
  if (x === undefined) return { ok: true, value: undefined };
  if (typeof x !== 'string' || !MIME.test(x.toLowerCase())) return { ok: false, reason: 'mimeType malformed' };
  return { ok: true, value: x.toLowerCase() };
}

/** Validates a flat `FileRef` (what the helpers take), e.g. one an application built or stored. */
export function parseFileRef(x: unknown): FileResult<FileRef> {
  if (!isPlainObject(x)) return { ok: false, reason: 'file ref malformed' };
  const { uri, mimeType, name, ...rest } = x;
  const meta = parseFileRefMeta(rest);
  if (!meta.ok) return meta;
  return assemble(meta.value, uri, mimeType, name);
}

function assemble(meta: FileRefMeta, uri: unknown, mimeType: unknown, name: unknown): FileResult<FileRef> {
  const ref: FileRef = { ...meta };
  if (uri !== undefined) {
    const u = checkFileUri(uri);
    if (!u.ok) return u;
    ref.uri = uri as string;
  } else if (!meta.p2p) {
    return { ok: false, reason: 'neither uri nor p2p' };
  }
  const mime = parseMime(mimeType);
  if (!mime.ok) return mime;
  if (mime.value !== undefined) ref.mimeType = mime.value;
  if (name !== undefined && typeof name !== 'string') return { ok: false, reason: 'name malformed' };
  const clean = sanitizeFileName(name);
  if (clean !== undefined) ref.name = clean;
  return { ok: true, value: ref };
}

/**
 * Validates an A2A `FilePart` (§7.7): inline bytes up to 16 KiB, or a
 * reference with the files-extension metadata. A part with neither is
 * refused, so an agent never holds a URL without a hash to check. Other
 * `metadata` keys are ignorable (§7.5) and dropped from the result.
 */
export function parseFilePart(x: unknown): FileResult<ParsedFilePart> {
  if (!isPlainObject(x) || x.kind !== 'file' || !onlyKeys(x, ['kind', 'file', 'metadata'])) {
    return { ok: false, reason: 'not a file part' };
  }
  const file = x.file;
  if (!isPlainObject(file)) return { ok: false, reason: 'file malformed' };
  if (x.metadata !== undefined && !isPlainObject(x.metadata)) return { ok: false, reason: 'metadata malformed' };
  const extMeta = x.metadata?.[FILES_EXT];
  if (file.bytes !== undefined) {
    if (!onlyKeys(file, ['bytes', 'mimeType', 'name']) || file.uri !== undefined || extMeta !== undefined) {
      return { ok: false, reason: 'inline file malformed' };
    }
    if (typeof file.bytes !== 'string' || file.bytes.length > Math.ceil(MAX_INLINE_FILE_BYTES / 3) * 4) {
      return { ok: false, reason: 'inline file too large' };
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.bytes)) return { ok: false, reason: 'inline bytes not base64' };
    let bytes: Uint8Array;
    try {
      bytes = b64decode(file.bytes);
    } catch {
      return { ok: false, reason: 'inline bytes not base64' };
    }
    if (bytes.length > MAX_INLINE_FILE_BYTES) return { ok: false, reason: 'inline file too large' };
    const mime = parseMime(file.mimeType);
    if (!mime.ok) return mime;
    if (file.name !== undefined && typeof file.name !== 'string') return { ok: false, reason: 'name malformed' };
    const out: ParsedFilePart = { kind: 'inline', bytes };
    if (mime.value !== undefined) out.mimeType = mime.value;
    const clean = sanitizeFileName(file.name);
    if (clean !== undefined) out.name = clean;
    return { ok: true, value: out };
  }
  if (!onlyKeys(file, ['uri', 'mimeType', 'name'])) return { ok: false, reason: 'file malformed' };
  if (extMeta === undefined) return { ok: false, reason: 'file part without inline bytes or files metadata' };
  const meta = parseFileRefMeta(extMeta);
  if (!meta.ok) return meta;
  const ref = assemble(meta.value, file.uri, file.mimeType, file.name);
  return ref.ok ? { ok: true, value: { kind: 'ref', ref: ref.value } } : ref;
}

/** The wire `FilePart` for a reference. Validates first and throws on a bad one. */
export function fileRefPart(ref: FileRef): FileRefPart {
  const r = parseFileRef(ref);
  if (!r.ok) throw new FileRefError('malformed', `bad file reference: ${r.reason}`);
  const { uri, mimeType, name, ...meta } = r.value;
  const file: FileRefPart['file'] = {};
  if (uri !== undefined) file.uri = uri;
  if (mimeType !== undefined) file.mimeType = mimeType;
  if (name !== undefined) file.name = name;
  return { kind: 'file', file, metadata: { [FILES_EXT]: meta } };
}

/** The wire `FilePart` for a small file carried inline. Throws over MAX_INLINE_FILE_BYTES. */
export function inlineFilePart(bytes: Uint8Array, opts: { mimeType?: string; name?: string } = {}): InlineFilePart {
  if (bytes.length > MAX_INLINE_FILE_BYTES) throw new FileRefError('too-large', `inline files are at most ${MAX_INLINE_FILE_BYTES} bytes`);
  const part: InlineFilePart = { kind: 'file', file: { bytes: b64encode(bytes) } };
  const mime = parseMime(opts.mimeType);
  if (!mime.ok) throw new FileRefError('malformed', mime.reason);
  if (mime.value !== undefined) part.file.mimeType = mime.value;
  const name = sanitizeFileName(opts.name);
  if (name !== undefined) part.file.name = name;
  return part;
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** A reference to a plaintext file (no `enc`), for one already public. Add `uri` (or `p2p`) before sending. */
export function plainFileRef(bytes: Uint8Array): FileRefMeta {
  return { sha256: sha256Hex(bytes), size: bytes.length };
}

/**
 * Encrypts a file for a store the sender does not control (§7.7): a fresh
 * random key and nonce, AES-256-GCM with associated data `"rdv1/blob"`. The
 * reference it returns has no `uri`; the caller uploads `ciphertext` wherever
 * it likes and adds the URL (or `p2p`). The key travels only inside the
 * envelope.
 */
export function encryptFile(plaintext: Uint8Array): { ciphertext: Uint8Array; ref: FileRefMeta } {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce, utf8ToBytes(FILE_AD)).encrypt(plaintext);
  return {
    ciphertext,
    ref: {
      sha256: sha256Hex(ciphertext),
      size: ciphertext.length,
      enc: { alg: FILE_ENC_ALG, key: b64encode(key), nonce: b64encode(nonce), plain_sha256: sha256Hex(plaintext) },
    },
  };
}

/**
 * Checks fetched bytes against a reference and returns the plaintext. Fails
 * closed (throws `FileRefError`) on a wrong length, a `sha256` mismatch, a
 * failed decryption or a `plain_sha256` mismatch.
 */
export function verifyAndDecrypt(ref: FileRefMeta, bytes: Uint8Array): Uint8Array {
  const meta = parseFileRefMeta({ sha256: ref.sha256, size: ref.size, enc: ref.enc });
  if (!meta.ok) throw new FileRefError('malformed', `bad file reference: ${meta.reason}`);
  if (bytes.length !== meta.value.size) throw new FileRefError('size-mismatch', 'file length differs from the reference');
  if (sha256Hex(bytes) !== meta.value.sha256) throw new FileRefError('hash-mismatch', 'file sha256 differs from the reference');
  const enc = meta.value.enc;
  if (!enc) return bytes;
  let plain: Uint8Array;
  try {
    plain = gcm(b64decode(enc.key), b64decode(enc.nonce), utf8ToBytes(FILE_AD)).decrypt(bytes);
  } catch {
    throw new FileRefError('decrypt-failed', 'file decryption failed');
  }
  if (sha256Hex(plain) !== enc.plain_sha256) throw new FileRefError('plain-hash-mismatch', 'decrypted file sha256 differs from the reference');
  return plain;
}
