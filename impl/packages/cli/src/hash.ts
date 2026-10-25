// Hashing for what a human approves (task gates, auto-approve): JSON with
// sorted keys, canonical enough to hash. Unlike core's canonicalize it allows
// non-integers (capability data may hold them).
import { createHash } from 'node:crypto';

/** JSON with sorted keys; undefined members are left out. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** SHA-256 (hex) of `stable(v)`, domain-separated by `tag`. */
export const sha = (tag: string, v: unknown): string => createHash('sha256').update(`${tag}\0${stable(v)}`).digest('hex');

/** SHA-256 (hex) of a string or bytes. */
export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
