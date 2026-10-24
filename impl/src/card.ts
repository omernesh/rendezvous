// §4.3: the address card ("calling card").
import type { AgentKey } from './identity.js';
import { isAgentId } from './identity.js';
import { type Signed, signDoc, verifyDoc } from './sign.js';

export type InboundPolicy = 'allow' | 'block' | 'prompt';

export type RendezvousHint =
  | { type: 'nostr'; relay: string; pref: number }
  | { type: 'ntfy'; topic: string; server?: string; pref: number }
  | { type: 'mqtt'; broker: string; topic: string; pref: number }
  | { type: 'email'; to: string; pref: number }
  | { type: 'dns'; domain: string; pref: 0 };

export interface DiscoveryAddress {
  type: 'email' | 'phone';
  value: string;
}

export interface CardBody {
  v: 1;
  id: string;
  created: string;
  expires: string | null;
  capabilities: string[];
  owner?: { name?: string; contact?: string[] };
  discovery?: { addresses: DiscoveryAddress[]; public_pointer: boolean };
  rendezvous: RendezvousHint[];
  policy: { inbound: InboundPolicy; public: boolean };
}

export type AddressCard = Signed<CardBody>;

export interface CardOptions {
  rendezvous: RendezvousHint[];
  capabilities?: string[];
  owner?: CardBody['owner'];
  discovery?: CardBody['discovery'];
  policy?: Partial<CardBody['policy']>;
  expires?: string | null;
  now?: Date;
}

export function createCard(key: AgentKey, opts: CardOptions): AddressCard {
  const body: CardBody = {
    v: 1,
    id: key.id,
    created: (opts.now ?? new Date()).toISOString(),
    expires: opts.expires ?? null,
    capabilities: opts.capabilities ?? ['rdv/v1', 'a2a/0.3'],
    owner: opts.owner,
    discovery: opts.discovery,
    rendezvous: [...opts.rendezvous].sort((a, b) => a.pref - b.pref),
    policy: { inbound: 'prompt', public: false, ...opts.policy },
  };
  return signDoc(body, key);
}

export type CardCheck = { ok: true; card: AddressCard } | { ok: false; reason: string };

/** Structural + signature + expiry check. Cards are self-signed by `id`. */
export function verifyCard(input: unknown, now: Date = new Date()): CardCheck {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'not an object' };
  const card = input as AddressCard;
  if (card.v !== 1) return { ok: false, reason: 'unsupported card version' };
  if (!isAgentId(card.id)) return { ok: false, reason: 'bad agent id' };
  if (!Array.isArray(card.rendezvous)) return { ok: false, reason: 'missing rendezvous list' };
  if (!Array.isArray(card.capabilities)) return { ok: false, reason: 'missing capabilities' };
  if (!verifyDoc(card, card.id)) return { ok: false, reason: 'bad signature' };
  if (card.expires && Date.parse(card.expires) <= now.getTime()) {
    return { ok: false, reason: 'card expired' };
  }
  return { ok: true, card };
}

/** Delivery hints in preference order (pref 0 entries are lookup-only). */
export function deliveryHints(card: CardBody): RendezvousHint[] {
  return card.rendezvous.filter((h) => h.pref > 0).sort((a, b) => a.pref - b.pref);
}
