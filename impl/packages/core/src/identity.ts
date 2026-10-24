// §4.1–4.2: agent keys and agent IDs.
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub } from '@noble/curves/ed25519';
import { b32decode, b32encode } from './encoding.js';

export const ID_PREFIX = 'rdv1:';

export interface AgentKey {
  /** 32-byte Ed25519 seed. Never leaves the agent. */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  id: string;
}

export function generateKey(): AgentKey {
  return keyFromSecret(ed25519.utils.randomPrivateKey());
}

export function keyFromSecret(secretKey: Uint8Array): AgentKey {
  if (secretKey.length !== 32) throw new Error('agent secret key must be 32 bytes');
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, id: agentIdFromPublicKey(publicKey) };
}

export function agentIdFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return ID_PREFIX + b32encode(publicKey);
}

/** Parse and validate an agent ID; returns the Ed25519 public key. */
export function publicKeyFromAgentId(id: string): Uint8Array {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX)) {
    throw new Error(`not an agent ID: ${String(id)}`);
  }
  let pk: Uint8Array;
  try {
    pk = b32decode(id.slice(ID_PREFIX.length));
  } catch {
    throw new Error(`malformed agent ID: ${id}`);
  }
  if (pk.length !== 32) throw new Error(`malformed agent ID: ${id}`);
  ed25519.ExtendedPoint.fromHex(pk); // throws if not a curve point
  return pk;
}

export function isAgentId(id: unknown): id is string {
  try {
    publicKeyFromAgentId(id as string);
    return true;
  } catch {
    return false;
  }
}

/** Human-facing short form, e.g. `rdv1:7f3a…9c2d` (§4.2). */
export function fingerprint(id: string): string {
  const body = id.slice(ID_PREFIX.length);
  return `${ID_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** X25519 keys derived from the Ed25519 identity, used for envelope encryption. */
export function x25519Secret(key: AgentKey): Uint8Array {
  return edwardsToMontgomeryPriv(key.secretKey);
}

export function x25519PublicFromAgentId(id: string): Uint8Array {
  return edwardsToMontgomeryPub(publicKeyFromAgentId(id));
}
