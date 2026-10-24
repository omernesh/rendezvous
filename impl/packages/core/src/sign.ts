// Signed JSON documents: every protocol object carries `sig`, an Ed25519
// signature (base64) over the canonical JSON of the object without `sig`.
import { ed25519 } from '@noble/curves/ed25519';
import { b64decode, b64encode, canonicalBytes } from './encoding.js';
import { type AgentKey, publicKeyFromAgentId } from './identity.js';

export type Signed<T> = T & { sig: string };

/** Domain separation so a signature over one document type can't be replayed as another. */
const SIG_CONTEXT = 'rdv1/sig:';

function signingBytes(doc: object): Uint8Array {
  const { sig: _omit, ...rest } = doc as Record<string, unknown>;
  const body = canonicalBytes(rest);
  const ctx = new TextEncoder().encode(SIG_CONTEXT);
  const out = new Uint8Array(ctx.length + body.length);
  out.set(ctx);
  out.set(body, ctx.length);
  return out;
}

export function signDoc<T extends object>(doc: T, key: AgentKey): Signed<T> {
  const sig = b64encode(ed25519.sign(signingBytes(doc), key.secretKey));
  return { ...doc, sig } as Signed<T>;
}

/** Verify `doc.sig` against the given agent ID. Never throws on bad input. */
export function verifyDoc(doc: unknown, signerId: string): boolean {
  if (!doc || typeof doc !== 'object' || typeof (doc as { sig?: unknown }).sig !== 'string') {
    return false;
  }
  try {
    const pk = publicKeyFromAgentId(signerId);
    const sig = b64decode((doc as { sig: string }).sig);
    return ed25519.verify(sig, signingBytes(doc), pk);
  } catch {
    return false;
  }
}
