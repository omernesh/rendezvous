// §4.3: the address card ("calling card").
import type { AgentKey } from './identity.js';
import { isAgentId } from './identity.js';
import { isPast, parseTimestamp } from './encoding.js';
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

/** SPEC §4.3: `capabilities` lists at most 32 entries (protocol versions and extension URIs), each at most 200 characters. */
export const MAX_CARD_CAPABILITIES = 32;
export const MAX_CAPABILITY_CHARS = 200;

/** Why a `capabilities` list breaks the §4.3 limits, or null when it is fine. */
export function capabilitiesProblem(v: unknown): string | null {
  if (!Array.isArray(v)) return 'missing capabilities';
  if (v.length > MAX_CARD_CAPABILITIES) return `more than ${MAX_CARD_CAPABILITIES} capabilities`;
  if (!v.every((c) => typeof c === 'string' && c.length <= MAX_CAPABILITY_CHARS)) return `a capability must be a string of at most ${MAX_CAPABILITY_CHARS} characters`;
  return null;
}

export function createCard(key: AgentKey, opts: CardOptions): AddressCard {
  const problem = opts.capabilities === undefined ? null : capabilitiesProblem(opts.capabilities);
  if (problem) throw new Error(`card: ${problem}`);
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

/**
 * A newer card with the same key and hints but other discovery addresses.
 * `created` is at least a second past both the old card and now, so the
 * newest card always sorts last (lookup prefers it), and as a replaceable
 * Nostr event (dated max(now, created), `NostrTransport.publishTopic`) it is
 * in a later second than any earlier publish of the card it replaces: relays
 * keep the newest per `d`, and a tie would keep a random one (NOTES 63).
 */
export function reissueCard(
  key: AgentKey,
  card: AddressCard,
  discovery: { addresses: DiscoveryAddress[]; public_pointer: boolean },
  now: Date = new Date(),
): AddressCard {
  return resignCard(key, card, {
    discovery: discovery.addresses.length || discovery.public_pointer ? { addresses: discovery.addresses.map((a) => ({ ...a })), public_pointer: discovery.public_pointer } : undefined,
  }, now);
}

/**
 * A newer card with the same key, hints and addresses but other
 * `capabilities` (issue #43), dated like reissueCard: at least a second past
 * the old card and now.
 */
export function reissueCardCapabilities(key: AgentKey, card: AddressCard, capabilities: string[], now: Date = new Date()): AddressCard {
  const problem = capabilitiesProblem(capabilities);
  if (problem) throw new Error(`card: ${problem}`);
  return resignCard(key, card, { capabilities: [...capabilities] }, now);
}

/**
 * A newer card with the same key, addresses and capabilities but other Nostr
 * relays (`rdv relays`): the relays become the card's `nostr` hints in this
 * order (`pref` 1, 2, ...); other hints are kept after them. Dated like
 * reissueCard.
 */
export function reissueCardRelays(key: AgentKey, card: AddressCard, relays: readonly string[], now: Date = new Date()): AddressCard {
  if (relays.length === 0) throw new Error('card: at least one relay');
  const nostr: RendezvousHint[] = [...new Set(relays)].map((relay, i) => ({ type: 'nostr', relay, pref: i + 1 }));
  const others = card.rendezvous.filter((h) => h.type !== 'nostr').map((h) => (h.pref > 0 ? { ...h, pref: h.pref + nostr.length } : { ...h }));
  return resignCard(key, card, { rendezvous: [...nostr, ...others] as RendezvousHint[] }, now);
}

function resignCard(key: AgentKey, card: AddressCard, change: Partial<Pick<CardBody, 'discovery' | 'capabilities' | 'rendezvous'>>, now: Date): AddressCard {
  if (card.id !== key.id) throw new Error('card belongs to another key');
  const prev = parseTimestamp(card.created) ?? 0;
  const created = new Date(Math.max(now.getTime(), prev) + 1000);
  const { sig: _sig, ...body } = card;
  return signDoc({ ...body, ...change, created: created.toISOString() } as CardBody, key);
}

/**
 * The capabilities a card should list so that it advertises everything in
 * `wanted` (what this software now routes, SPEC §4.3): `wanted` in its order,
 * then what the card listed besides, within MAX_CARD_CAPABILITIES. Null when
 * the card already lists all of `wanted` (in any order): nothing to re-sign,
 * so a restart on the same code never churns the card. A capability the card
 * lists and the code dropped stays listed (a task for it is answered as
 * unsupported, §7.5); hosts with different registries on one home then never
 * take turns re-signing.
 */
export function missingCapabilities(card: CardBody, wanted: readonly string[]): string[] | null {
  const have = Array.isArray(card.capabilities) ? card.capabilities : [];
  if (wanted.every((c) => have.includes(c))) return null;
  const merged = [...new Set([...wanted, ...have])];
  return merged.slice(0, MAX_CARD_CAPABILITIES);
}

/** The newer of two cards of one agent (by `created`). */
export function newerCard(a: AddressCard, b: AddressCard): AddressCard {
  return (parseTimestamp(b.created) ?? 0) > (parseTimestamp(a.created) ?? 0) ? b : a;
}

export type CardCheck = { ok: true; card: AddressCard } | { ok: false; reason: string };

/** Structural + signature + expiry check. Cards are self-signed by `id`. */
export function verifyCard(input: unknown, now: Date = new Date()): CardCheck {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'not an object' };
  const card = input as AddressCard;
  if (card.v !== 1) return { ok: false, reason: 'unsupported card version' };
  if (!isAgentId(card.id)) return { ok: false, reason: 'bad agent id' };
  if (!Array.isArray(card.rendezvous)) return { ok: false, reason: 'missing rendezvous list' };
  const capabilities = capabilitiesProblem(card.capabilities);
  if (capabilities) return { ok: false, reason: capabilities };
  if (!verifyDoc(card, card.id)) return { ok: false, reason: 'bad signature' };
  if (parseTimestamp(card.created) === null) return { ok: false, reason: 'bad created' };
  if (isPast(card.expires, now)) return { ok: false, reason: 'card expired' };
  return { ok: true, card };
}

/** Delivery hints in preference order (pref 0 entries are lookup-only). */
export function deliveryHints(card: CardBody): RendezvousHint[] {
  return card.rendezvous.filter((h) => h.pref > 0).sort((a, b) => a.pref - b.pref);
}
