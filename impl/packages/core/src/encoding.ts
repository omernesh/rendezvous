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

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Strict RFC 3339 date-time with an explicit offset (what toISOString emits,
 * plus `±HH:MM`), as epoch ms; null for anything else, including impossible
 * dates. Every peer-supplied timestamp goes through this: `Date.parse` gives
 * NaN for garbage, and NaN makes every expiry comparison false, i.e. "never
 * expires" (fail-open).
 */
export function parseTimestamp(s: unknown): number | null {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  if (m[8] !== 'Z' && (Number(m[10]) > 14 || Number(m[11]) > 59)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Expired, or not a valid timestamp (fail closed). `null`/absent means no expiry. */
export function isPast(expires: unknown, now: Date): boolean {
  if (expires === undefined || expires === null) return false;
  const t = parseTimestamp(expires);
  return t === null || t <= now.getTime();
}
