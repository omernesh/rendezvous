// Invite links (SPEC §5.2.3, NOTES 101): a one-time secret the inviter's
// human hands to someone through any channel (a WhatsApp or SMS message, an
// email), as a link whose payload sits in the URL fragment. The invitee's
// agent sends an ordinary contact request carrying the secret; the inviter's
// agent grants it on the terms its human chose when making the invite, once.
import { isIP } from 'node:net';
import { sha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';
import { canonicalize, parseTimestamp, utf8ToBytes } from './encoding.js';
import { isBlockedAddress } from './filefetch.js';
import { isAgentId } from './identity.js';

/** Where invite links point: the landing page, which reads the fragment in the browser only. */
export const INVITE_BASE_URL = 'https://rendezvous.nesher.co/i';
/**
 * The tiers an invite may give: `friend` and below. A link travels through
 * channels anyone can forward, so `family` and `spouse` are granted to the
 * contact afterwards, by the owner, as for any contact.
 */
export const INVITE_TIERS = Object.freeze(['friend', 'colleague', 'business', 'stranger'] as const);
/** Default lifetime of an invite: 7 days. */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** Longest lifetime an invite may have: 30 days. */
export const INVITE_MAX_TTL_MS = 30 * 86_400_000;
/** Invites not used, revoked or expired, at most (keys cost nothing, but invites are made by our own human). */
export const INVITES_OPEN_MAX = 32;
/** Used, revoked and expired invites are kept this long for `list`, then dropped. */
export const INVITE_KEEP_MS = 30 * 86_400_000;
/** Longest display name a link carries. */
export const INVITE_NAME_MAX = 64;
/** At most this many relays in a link. */
export const INVITE_RELAYS_MAX = 3;
/** Longest relay URL in a link. */
export const INVITE_RELAY_MAX = 200;
/** Longest payload (base64url) accepted from a link: well above a real one (about 300 characters). */
export const INVITE_PAYLOAD_MAX = 1024;

/** The secret: 128 random bits, base64url without padding (22 characters). */
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;
export const isInviteSecret = (s: unknown): s is string => typeof s === 'string' && SECRET_RE.test(s) && secretBytes(s) !== null;

function secretBytes(s: string): Uint8Array | null {
  try {
    const b = base64urlnopad.decode(s);
    // 22 characters carry 132 bits: only the encoding of 16 bytes round-trips (no stray low bits).
    return b.length === 16 && base64urlnopad.encode(b) === s ? b : null;
  } catch {
    return null;
  }
}

/**
 * The link's payload: canonical JSON, short keys (it has to fit an SMS).
 * `a` the inviter's agent ID, `r` its relays, `s` the secret, `e` the expiry
 * (Unix seconds), `n` an optional display name (the inviter's own words,
 * unverified: anyone can make a link with any name), `v` the version.
 */
export interface InvitePayload {
  v: 1;
  a: string;
  r: string[];
  s: string;
  e: number;
  n?: string;
}

/** A parsed invite, with readable names. */
export interface Invite {
  agentId: string;
  relays: string[];
  secret: string;
  /** RFC 3339, from the payload's `e`. */
  expires: string;
  /** Unverified display name, if the link has one: show it as the inviter's claim, never as fact. */
  name?: string;
}

/** A display name: trimmed, 1..64 characters, no control or format characters. Throws otherwise. */
export function cleanInviteName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > INVITE_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(n)) throw new Error(`an invite name must be 1 to ${INVITE_NAME_MAX} printable characters`);
  return n;
}

const isRelayUrl = (r: unknown): r is string => typeof r === 'string' && r.length <= INVITE_RELAY_MAX && /^wss?:\/\/[^\s/?#]+[^\s]*$/.test(r);

/** Host names that only mean something inside one network: never dialled for a link from someone else. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

/**
 * Why a relay from an invite link must not be dialled, or null when it may
 * (NOTES 101, review of PR #120). The link is someone else's text, and the
 * invitee's agent connects to its relays at once, so a link could aim that
 * connection at the invitee's own network. Only `wss://` to a public host:
 * no `ws://`, no loopback, private (RFC 1918, CGNAT 100.64/10, ULA
 * fc00::/7), link-local or other special-use address literal (the same list
 * as file fetches, §7.7), no `localhost` and no `.local`, `.internal` or like
 * names, no bare single-label host, no credentials. `unsafeAllow` lists
 * exact URLs exempt from this (tests and local development only).
 */
export function inviteRelayProblem(url: string, unsafeAllow: readonly string[] = []): string | null {
  if (unsafeAllow.includes(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'wss:') return 'an invite relay must be wss://';
  if (u.username || u.password) return 'an invite relay must not carry credentials';
  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase();
  if (host === '') return 'no host';
  if (isIP(host)) return isBlockedAddress(host) ? 'an invite relay must not be a private, loopback or link-local address' : null;
  // A dotted-quad lookalike that is not one (e.g. 0x7f.1) is refused rather than left to the resolver.
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return 'not a host name';
  if (!host.includes('.') || LOCAL_NAME.test(host)) return 'an invite relay must be a public host name';
  return null;
}

/** Throws when any relay of a parsed invite is one an invitee must not dial. */
export function checkInviteRelays(inv: Pick<Invite, 'relays'>, unsafeAllow: readonly string[] = []): void {
  for (const r of inv.relays) {
    const why = inviteRelayProblem(r, unsafeAllow);
    if (why) throw new Error(`not a usable invite link (relay ${r.slice(0, 80)}: ${why})`);
  }
}

/** A fresh secret: 128 bits from the platform's CSPRNG. */
export function newInviteSecret(): string {
  return base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(16)));
}

/** What the inviter stores for a secret: SHA-256 over a domain tag and its bytes (the secret has 128 bits, so no slow hash is needed). */
export function inviteSecretHash(secret: string): string {
  const b = secretBytes(secret);
  if (!b) throw new Error('not an invite secret');
  const tag = utf8ToBytes('rdv1/invite\u0000');
  const all = new Uint8Array(tag.length + b.length);
  all.set(tag);
  all.set(b, tag.length);
  return Array.from(sha256(all), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality of two hex strings of the same length. */
export function sameHash(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The payload (base64url of canonical JSON) for an invite. Checks every field. */
export function encodeInvite(inv: Invite): string {
  const p = payloadOf(inv);
  return base64urlnopad.encode(utf8ToBytes(canonicalize(p)));
}

/** The full link: `https://rendezvous.nesher.co/i#<payload>`. */
export function inviteUrl(inv: Invite, base = INVITE_BASE_URL): string {
  return `${base}#${encodeInvite(inv)}`;
}

function payloadOf(inv: Invite): InvitePayload {
  if (!isAgentId(inv.agentId)) throw new Error('an invite needs the inviter\'s agent ID');
  const relays = [...new Set(inv.relays)].slice(0, INVITE_RELAYS_MAX);
  if (relays.length === 0 || !relays.every(isRelayUrl)) throw new Error(`an invite needs 1 to ${INVITE_RELAYS_MAX} ws:// or wss:// relays of at most ${INVITE_RELAY_MAX} characters`);
  if (!isInviteSecret(inv.secret)) throw new Error('not an invite secret');
  const ms = parseTimestamp(inv.expires);
  if (ms === null) throw new Error('an invite needs an RFC 3339 expiry');
  return {
    v: 1,
    a: inv.agentId,
    r: relays,
    s: inv.secret,
    e: Math.floor(ms / 1000),
    ...(inv.name !== undefined ? { n: cleanInviteName(inv.name) } : {}),
  };
}

const PAYLOAD_KEYS = new Set(['v', 'a', 'r', 's', 'e', 'n']);

/**
 * Read an invite from what a person pasted: the link (any host: the payload
 * is what counts, and the inviter's agent checks the secret), `rdv-invite:`
 * followed by the payload, or the payload alone. Strict: a field missing,
 * malformed or unknown, or non-canonical JSON, and it throws. It does not
 * check the expiry (`inviteExpired`): an expired link still parses, so the
 * invitee can be told why it no longer works.
 */
export function parseInvite(text: string, opts: { unsafeAllowRelays?: readonly string[] } = {}): Invite {
  if (typeof text !== 'string') throw new Error('not an invite link');
  let s = text.trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1);
  else if (s.toLowerCase().startsWith('rdv-invite:')) s = s.slice('rdv-invite:'.length);
  // A link pasted at the end of a sentence: the punctuation is not part of it (base64url has none of these).
  s = s.trim().replace(/[.,;:!?)\]}"'>’”]+$/u, '');
  if (s.length === 0 || s.length > INVITE_PAYLOAD_MAX || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('not an invite link: the part after "#" is missing or not an invite');
  let p: Record<string, unknown>;
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(base64urlnopad.decode(s));
    p = JSON.parse(json);
  } catch {
    throw new Error('not an invite link: the part after "#" does not decode (was it cut off?)');
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an invite link');
  if (p.v !== 1) throw new Error('this invite was made by a newer version of Rendezvous: update and try again');
  for (const k of Object.keys(p)) if (!PAYLOAD_KEYS.has(k)) throw new Error(`not an invite link (unknown field "${k.slice(0, 16)}")`);
  if (!isAgentId(p.a)) throw new Error('not an invite link (bad agent ID)');
  if (!Array.isArray(p.r) || p.r.length === 0 || p.r.length > INVITE_RELAYS_MAX || !p.r.every(isRelayUrl) || new Set(p.r).size !== p.r.length) {
    throw new Error('not an invite link (bad relays)');
  }
  if (!isInviteSecret(p.s)) throw new Error('not an invite link (bad secret)');
  if (typeof p.e !== 'number' || !Number.isSafeInteger(p.e) || p.e <= 0 || p.e > 32503680000) throw new Error('not an invite link (bad expiry)');
  let name: string | undefined;
  if (p.n !== undefined) {
    if (typeof p.n !== 'string') throw new Error('not an invite link (bad name)');
    try {
      name = cleanInviteName(p.n);
    } catch {
      throw new Error('not an invite link (bad name)');
    }
    if (name !== p.n) throw new Error('not an invite link (bad name)');
  }
  // The canonical form only: one link per invite, so what a person compares is what the agent reads.
  if (canonicalize(p) !== json) throw new Error('not an invite link (not in canonical form)');
  const inv: Invite = { agentId: p.a as string, relays: [...(p.r as string[])], secret: p.s as string, expires: new Date(p.e * 1000).toISOString(), ...(name !== undefined ? { name } : {}) };
  checkInviteRelays(inv, opts.unsafeAllowRelays);
  return inv;
}

export function inviteExpired(inv: Pick<Invite, 'expires'>, now = new Date()): boolean {
  const ms = parseTimestamp(inv.expires);
  return ms === null || ms <= now.getTime();
}

/**
 * A ready-to-send message for the inviter's human to paste into WhatsApp, an
 * SMS or an email. Plain words; the link last, so a messenger shows its preview.
 */
export function inviteShareText(url: string, opts: { name?: string; expires: string } = { expires: '' }): string {
  const who = opts.name ? `${opts.name} invites you` : "I'm inviting you";
  const until = parseTimestamp(opts.expires) !== null ? ` The link works once, until ${opts.expires.slice(0, 10)}.` : ' The link works once.';
  return (
    `${who} to connect your AI agent with mine on Rendezvous, so our assistants can message each other securely.` +
    `${until} Open it, or tell your AI agent: "accept my Rendezvous invite ${url}"\n${url}`
  );
}
