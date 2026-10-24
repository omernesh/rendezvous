// §4.4: deterministic discovery topics and binding levels.
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { DiscoveryAddress } from './card.js';
import { b32encode } from './encoding.js';

export type Binding = 'in-person' | 'dns' | 'mailbox' | 'claimed';

/** Strength order, strongest first. */
export const BINDING_STRENGTH: Record<Binding, number> = {
  'in-person': 3,
  dns: 2,
  mailbox: 1,
  claimed: 0,
};

/** `canon`: emails lowercased; phones in E.164. Returns the bare canonical value. */
export function canonAddress(addr: DiscoveryAddress): string {
  if (addr.type === 'email') {
    const v = addr.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(v)) throw new Error(`not an email address: ${addr.value}`);
    return v;
  }
  if (addr.type === 'phone') {
    const raw = addr.value.trim();
    if (!raw.startsWith('+')) throw new Error(`phone must be in international form: ${addr.value}`);
    const digits = raw.slice(1).replace(/[\s\-().]/g, '');
    if (!/^\d{6,15}$/.test(digits)) throw new Error(`not an E.164 phone number: ${addr.value}`);
    return `+${digits}`;
  }
  throw new Error(`unsupported address type: ${(addr as DiscoveryAddress).type}`);
}

/** dtopic(address) = base32(SHA-256("rdv1/disc:" ‖ canon(address)))[0:26] */
export function dtopic(addr: DiscoveryAddress): string {
  return b32encode(sha256(utf8ToBytes('rdv1/disc:' + canonAddress(addr)))).slice(0, 26);
}

/**
 * Listen mode (§4.4): a topic probe is simply a signed contact request posted
 * on the target's discovery topic, with `to_hint` set to the address. The
 * listener gates it exactly like any other inbound request (binding `claimed`).
 */
export function topicForHint(toHint: string): string | null {
  const type = toHint.includes('@') ? 'email' : toHint.startsWith('+') ? 'phone' : null;
  if (!type) return null;
  try {
    return dtopic({ type, value: toHint });
  } catch {
    return null;
  }
}
