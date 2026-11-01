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
import { agentIdFromPublicKey, isAgentId, publicKeyFromAgentId } from './identity.js';

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
/** Longest payload (base64url) accepted from a link: well above a real one (75 characters for v2 with known relays, about 300 for v1). */
export const INVITE_PAYLOAD_MAX = 1024;

/**
 * Relays a v2 link names by one bit each (NOTES 105). Fixed for version 2
 * (a later version may add one at bit 7, which v2 readers refuse): the
 * project's own relay, then DEFAULT_RELAYS, then two widely used public relays.
 */
export const INVITE_KNOWN_RELAYS: readonly string[] = Object.freeze([
  'wss://relay.nesher.co',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
  'wss://relay.damus.io',
]);

/** What `parseInvite` says when a link was cut short or shortened with "…" (the 2026-11-01 failure: an assistant abbreviated a link). */
export const INVITE_CUT_MESSAGE =
  'this invite link looks cut off or changed (it was shortened, has "…" in it, or is missing its end): ask the person who sent it for the full link, exactly as it was sent';

/** v2 header: version, Ed25519 public key, secret, expiry (Unix minutes, uint32 big-endian), relay bitmask. */
const V2_VERSION = 2;
const V2_HEADER = 1 + 32 + 16 + 4 + 1;
/** v2 trailer: the first 2 bytes of SHA-256(tag ‖ everything before them); catches a cut or a changed character, not forgery. */
const V2_CHECK = 2;
const V2_RELAY = 1;
const V2_NAME = 2;
const V2_CHECK_TAG = utf8ToBytes('rdv1/invite-link\u0000');

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
 * A v1 link's payload (NOTES 101; read, no longer made): canonical JSON, short keys.
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

/** A display name: trimmed, 1..64 characters, no control, format, line or paragraph separator, private-use or unassigned characters. Throws otherwise. */
export function cleanInviteName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > INVITE_NAME_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u.test(n)) throw new Error(`an invite name must be 1 to ${INVITE_NAME_MAX} printable characters`);
  return n;
}

const isRelayUrl = (r: unknown): r is string => typeof r === 'string' && r.length <= INVITE_RELAY_MAX && /^wss?:\/\/[^\s/?#]+[^\s]*$/.test(r);

/**
 * A relay URL's one spelling in a v2 link (security review of PR #129, L3/L4):
 * the WHATWG href (lowercase host, punycode, default port dropped, ASCII
 * only, no credentials, no trailing-dot host) without a lone "/" path, so `wss://RELAY.nesher.co/` is the table's
 * `wss://relay.nesher.co` and a record's length always fits one byte. Null
 * when it is not a ws:// or wss:// URL of at most 200 characters.
 */
export function canonicalInviteRelay(r: string): string | null {
  if (!isRelayUrl(r)) return null;
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return null;
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  // No credentials and no trailing-dot host: neither has a second spelling we would have to match (narrow review).
  if (u.username || u.password || u.hostname.endsWith('.')) return null;
  // Only a lone trailing "/" goes (not an empty "?" or "#"), so canonicalInviteRelay(x) is x for every result.
  const root = `${u.protocol}//${u.host}/`;
  const href = u.href === root ? root.slice(0, -1) : u.href;
  return href.length <= INVITE_RELAY_MAX && /^[\x21-\x7e]+$/.test(href) ? href : null;
}

/** The latest expiry a link may carry, as v1: the year 3000 (Unix seconds). */
const EXPIRY_MAX_S = 32503680000;

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

/**
 * The payload of a v2 link (NOTES 105): base64url of the compact binary form,
 * 75 characters with known relays and no name. Checks every field. Relays from
 * `INVITE_KNOWN_RELAYS` go in the bitmask (and read back in table order),
 * others follow as text, then the name if there is one.
 */
export function encodeInvite(inv: Invite): string {
  const relays = checkedRelays(inv);
  const secret = isInviteSecret(inv.secret) ? secretBytes(inv.secret) : null;
  if (!secret) throw new Error('not an invite secret');
  const ms = parseTimestamp(inv.expires);
  const minutes = ms === null ? 0 : Math.floor(ms / 60_000);
  if (minutes <= 0 || minutes * 60 > EXPIRY_MAX_S) throw new Error('an invite needs an RFC 3339 expiry before the year 3000');
  const name = inv.name !== undefined ? utf8ToBytes(cleanInviteName(inv.name)) : undefined;
  let mask = 0;
  const custom: Uint8Array[] = [];
  for (const r of relays) {
    const i = INVITE_KNOWN_RELAYS.indexOf(r);
    if (i >= 0) mask |= 1 << i;
    else custom.push(utf8ToBytes(r));
  }
  const parts: number[] = [V2_VERSION, ...publicKeyFromAgentId(inv.agentId), ...secret, (minutes >>> 24) & 0xff, (minutes >>> 16) & 0xff, (minutes >>> 8) & 0xff, minutes & 0xff, mask];
  for (const c of custom) parts.push(V2_RELAY, c.length, ...c);
  if (name) parts.push(V2_NAME, name.length, ...name);
  const body = Uint8Array.from(parts);
  const out = new Uint8Array(body.length + V2_CHECK);
  out.set(body);
  out.set(v2Check(body), body.length);
  return base64urlnopad.encode(out);
}

function checkedRelays(inv: Invite): string[] {
  if (!isAgentId(inv.agentId)) throw new Error('an invite needs the inviter\'s agent ID');
  const canon = inv.relays.map((r) => canonicalInviteRelay(r));
  if (canon.length === 0 || canon.some((r) => r === null)) throw new Error(`an invite needs 1 to ${INVITE_RELAYS_MAX} ws:// or wss:// relays of at most ${INVITE_RELAY_MAX} characters`);
  return [...new Set(canon as string[])].slice(0, INVITE_RELAYS_MAX);
}

function v2Check(body: Uint8Array): Uint8Array {
  const all = new Uint8Array(V2_CHECK_TAG.length + body.length);
  all.set(V2_CHECK_TAG);
  all.set(body, V2_CHECK_TAG.length);
  return sha256(all).slice(0, V2_CHECK);
}

/** The full link: `https://rendezvous.nesher.co/i#<payload>`. */
export function inviteUrl(inv: Invite, base = INVITE_BASE_URL): string {
  return `${base}#${encodeInvite(inv)}`;
}

/** The v1 payload (canonical JSON, NOTES 101). Readers still take it; nothing makes one any more (tests and interop only). */
export function encodeInviteV1(inv: Invite): string {
  const relays = checkedRelays(inv);
  if (!isInviteSecret(inv.secret)) throw new Error('not an invite secret');
  const ms = parseTimestamp(inv.expires);
  if (ms === null) throw new Error('an invite needs an RFC 3339 expiry');
  const p: InvitePayload = {
    v: 1,
    a: inv.agentId,
    r: relays,
    s: inv.secret,
    e: Math.floor(ms / 1000),
    ...(inv.name !== undefined ? { n: cleanInviteName(inv.name) } : {}),
  };
  return base64urlnopad.encode(utf8ToBytes(canonicalize(p)));
}

const PAYLOAD_KEYS = new Set(['v', 'a', 'r', 's', 'e', 'n']);

/**
 * Read an invite from what a person pasted: the link (any host: the payload
 * is what counts, and the inviter's agent checks the secret), `rdv-invite:`
 * followed by the payload, or the payload alone; v2 (binary, NOTES 105) or
 * v1 (JSON, NOTES 101). Strict: a field missing, malformed or unknown, bytes
 * left over, or a non-canonical encoding, and it throws. A link cut short,
 * shortened with "…", or with a character changed (v2's check bytes) throws
 * `INVITE_CUT_MESSAGE`, which tells the user to ask for the full link. It does not
 * check the expiry (`inviteExpired`): an expired link still parses, so the
 * invitee can be told why it no longer works.
 */
export function parseInvite(text: string, opts: { unsafeAllowRelays?: readonly string[] } = {}): Invite {
  if (typeof text !== 'string') throw new Error('not an invite link');
  // A whole pasted message may hold other "#"s ("Re issue #12: <link>", "Team #3 invites you … <link>") and "…"
  // (security review of PR #129, L1). Every candidate that looks like an invite must read, and they must all be the
  // same invite (narrow review, MED): a cut or failing link is never skipped for another one later in the text, and
  // two different invites are refused, so the user never connects to a link they did not choose.
  const found: Invite[] = [];
  for (const c of inviteCandidates(text)) {
    // Another "#" (a hashtag, "#12", a page's "#section"): an invite only if it has an invite's shape, or "…" after it.
    if (!c.strong && !(c.run.length >= 8 && CUT_AFTER.test(c.rest)) && !looksLikePayload(c.run)) continue;
    const inv = parsePayload(c);
    checkInviteRelays(inv, opts.unsafeAllowRelays);
    found.push(inv);
  }
  if (found.length === 0) throw new Error('not an invite link');
  const inv = found[0];
  if (found.some((f) => f.agentId !== inv.agentId || f.secret !== inv.secret)) {
    throw new Error('this text holds more than one invite link: paste just the one link you mean');
  }
  return inv;
}

/** At least 16 characters of canonical base64url whose first byte is a version this reader knows. */
function looksLikePayload(run: string): boolean {
  if (run.length < 16 || run.length > INVITE_PAYLOAD_MAX) return false;
  try {
    const b = base64urlnopad.decode(run);
    return base64urlnopad.encode(b) === run && (b[0] === V2_VERSION || b[0] === 0x7b);
  } catch {
    return false;
  }
}

/** An ellipsis right after a payload: someone shortened the link (2026-11-01). */
const CUT_AFTER = /^(…|\.\.\.|%E2%80%A6)/iu;
const B64_RUN = /[A-Za-z0-9_-]*/y;

/** A payload candidate: its base64url run, the few characters after it, and whether it is surely meant as an invite. */
interface Candidate {
  run: string;
  rest: string;
  strong: boolean;
}

/**
 * The base64url run after each "/i#" (strong), after every other "#" (only
 * when it looks like a payload), after `rdv-invite:` (strong) and, with none
 * of those, the text alone. Linear in the text (narrow review, LOW).
 */
function inviteCandidates(text: string): Candidate[] {
  const at = (i: number, strong: boolean): Candidate => {
    B64_RUN.lastIndex = i;
    const run = B64_RUN.exec(text)![0];
    return { run, rest: text.slice(i + run.length, i + run.length + 9), strong };
  };
  const out: Candidate[] = [];
  for (let i = text.indexOf('#'); i >= 0; i = text.indexOf('#', i + 1)) out.push(at(i + 1, i >= 2 && text[i - 2] === '/' && text[i - 1] === 'i'));
  const tag = text.toLowerCase().indexOf('rdv-invite:');
  if (tag >= 0) {
    let i = tag + 'rdv-invite:'.length;
    while (i < text.length && /\s/u.test(text[i])) i++;
    out.push(at(i, true));
  }
  if (out.length === 0) {
    // The payload alone: the whole first word, nothing else in it.
    const word = text.trim().split(/\s/u)[0] ?? '';
    const c = at(text.indexOf(word), true);
    if (word.replace(/[.,;:!?)\]}"'>’”]+$/u, '') !== c.run && !CUT_AFTER.test(c.rest)) throw new Error('not an invite link');
    out.push(c);
  }
  return out;
}

/** One candidate: an ellipsis right after it or a cut says so. */
function parsePayload(c: Candidate): Invite {
  if (CUT_AFTER.test(c.rest)) throw new Error(INVITE_CUT_MESSAGE);
  const s = c.run;
  if (s.length === 0) throw new Error('not an invite link: the part after "#" is missing. Ask the person who sent it for the full link, exactly as it was sent');
  if (s.length > INVITE_PAYLOAD_MAX) throw new Error('not an invite link: the part after "#" is not an invite');
  let bytes: Uint8Array;
  try {
    bytes = base64urlnopad.decode(s);
  } catch {
    // base64url of no length can be cut at a length no encoding has.
    throw new Error(INVITE_CUT_MESSAGE);
  }
  // Stray low bits in the last character: one invite has one link. A cut payload usually ends like this.
  if (base64urlnopad.encode(bytes) !== s) throw new Error(INVITE_CUT_MESSAGE);
  return bytes[0] === 0x7b ? parseV1(bytes) : bytes[0] === V2_VERSION ? parseV2(bytes) : versionProblem(bytes[0]);
}

function versionProblem(b: number | undefined): never {
  if (b !== undefined && b > V2_VERSION && b < 0x20) throw new Error('this invite was made by a newer version of Rendezvous: update and try again');
  throw new Error('not an invite link');
}

/** v2 (NOTES 105): the header, then records (custom relays, then at most one name), then the check bytes, and nothing else. */
function parseV2(b: Uint8Array): Invite {
  // Too short for its header and check, or a check that fails: cut (the common case) or changed.
  if (b.length < V2_HEADER + V2_CHECK) throw new Error(INVITE_CUT_MESSAGE);
  const body = b.subarray(0, b.length - V2_CHECK);
  const check = v2Check(body);
  if (check[0] !== b[b.length - 2] || check[1] !== b[b.length - 1]) throw new Error(INVITE_CUT_MESSAGE);
  const agentId = agentIdFromPublicKey(body.slice(1, 33));
  if (!isAgentId(agentId)) throw new Error('not an invite link (bad agent ID)');
  const secret = base64urlnopad.encode(body.slice(33, 49));
  const minutes = body[49] * 0x1000000 + body[50] * 0x10000 + body[51] * 0x100 + body[52];
  if (minutes === 0 || minutes * 60 > EXPIRY_MAX_S) throw new Error('not an invite link (bad expiry)');
  const mask = body[53];
  if (mask >= 1 << INVITE_KNOWN_RELAYS.length) throw new Error('not an invite link (bad relays: a relay this version does not know)');
  const relays = INVITE_KNOWN_RELAYS.filter((_, i) => (mask & (1 << i)) !== 0);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let name: string | undefined;
  for (let at = V2_HEADER; at < body.length; ) {
    const type = body[at];
    const len = body[at + 1];
    if (len === undefined || len === 0 || at + 2 + len > body.length) throw new Error('not an invite link (malformed)');
    let value: string;
    try {
      value = utf8.decode(body.subarray(at + 2, at + 2 + len));
    } catch {
      throw new Error('not an invite link (malformed)');
    }
    if (type === V2_RELAY && name === undefined) {
      // A known relay goes in the bitmask, never as text: one invite has one link.
      // Only the canonical spelling (canonicalInviteRelay), so a table relay cannot hide as `wss://RELAY.nesher.co/`.
      if (canonicalInviteRelay(value) !== value || relays.includes(value) || INVITE_KNOWN_RELAYS.includes(value)) throw new Error('not an invite link (bad relays)');
      relays.push(value);
    } else if (type === V2_NAME && name === undefined) {
      try {
        name = cleanInviteName(value);
      } catch {
        throw new Error('not an invite link (bad name)');
      }
      if (name !== value) throw new Error('not an invite link (bad name)');
    } else {
      throw new Error('not an invite link (unknown or misplaced field)');
    }
    at += 2 + len;
  }
  if (relays.length === 0 || relays.length > INVITE_RELAYS_MAX) throw new Error('not an invite link (bad relays)');
  return { agentId, relays, secret, expires: new Date(minutes * 60_000).toISOString(), ...(name !== undefined ? { name } : {}) };
}

/** v1 (NOTES 101): canonical JSON. */
function parseV1(bytes: Uint8Array): Invite {
  let p: Record<string, unknown>;
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    p = JSON.parse(json);
  } catch {
    throw new Error(INVITE_CUT_MESSAGE);
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an invite link');
  if (p.v !== 1) throw new Error('this invite was made by a newer version of Rendezvous: update and try again');
  for (const k of Object.keys(p)) if (!PAYLOAD_KEYS.has(k)) throw new Error(`not an invite link (unknown field "${k.slice(0, 16)}")`);
  if (!isAgentId(p.a)) throw new Error('not an invite link (bad agent ID)');
  if (!Array.isArray(p.r) || p.r.length === 0 || p.r.length > INVITE_RELAYS_MAX || !p.r.every(isRelayUrl) || new Set(p.r).size !== p.r.length) {
    throw new Error('not an invite link (bad relays)');
  }
  if (!isInviteSecret(p.s)) throw new Error('not an invite link (bad secret)');
  if (typeof p.e !== 'number' || !Number.isSafeInteger(p.e) || p.e <= 0 || p.e > EXPIRY_MAX_S) throw new Error('not an invite link (bad expiry)');
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
  return { agentId: p.a as string, relays: [...(p.r as string[])], secret: p.s as string, expires: new Date(p.e * 1000).toISOString(), ...(name !== undefined ? { name } : {}) };
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
