// Byte/text encodings and canonical JSON shared by every layer.
import { base32nopad, base64 } from '@scure/base';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export { bytesToHex, hexToBytes, utf8ToBytes };

/** RFC 4648 base32, lowercase, no padding (agent IDs, discovery topics). */
export function b32encode(bytes: Uint8Array): string {
  return base32nopad.encode(bytes).toLowerCase();
}

export function b32decode(text: string): Uint8Array {
  return base32nopad.decode(text.toUpperCase());
}

export function b64encode(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function b64decode(text: string): Uint8Array {
  return base64.decode(text);
}

/**
 * Canonical JSON (RFC 8785 subset): object keys sorted by UTF-16 code units,
 * no whitespace, `undefined` members dropped. Numbers must be finite; the
 * protocol only uses integers, for which ES serialization matches JCS.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8ToBytes(canonicalize(value));
}
