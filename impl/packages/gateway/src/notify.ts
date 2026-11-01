// Outbound notifications (NOTES 106): the gateway POSTs a signed JSON event to
// a URL the owner set, per agent, the moment something they asked to hear
// about happens (an open invite was accepted, expired unused, or exposed;
// optionally contact requests, new contacts and message metadata).
//
// It only reads: the home's shared events.jsonl (by its own cursor) and the
// invites in the agent's state (for the expiry sweep). It never writes an
// agent's home, never holds its lock, and nothing it receives back is read, so
// a webhook cannot approve, grant or revoke anything.
//
// Everything lives in the gateway's root: `gateway-notify.json` (mode 600,
// read-modify-write under `gateway-notify.lock`, like gateway.json) holds the
// owner's settings per agent (`rdv-gateway notify set|clear`), each agent's
// cursor and the invites whose expiry was sent, the outbox (so a restart loses
// nothing: delivery is at least once, the event id stays the same across
// retries) and the dead letters (`rdv-gateway notify dead-letter`). Each
// agent's secret is copied at `notify set` into a fixed file beside it,
// `notify-<agent>.secret` (mode 600; the previous one is kept for 24 h as
// `….secret.prev`), so the consent guard knows every name to protect.
//
// Wire format (v1), one event per request:
//   POST <url>   Content-Type: application/json
//   X-Rdv-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>[,v1=<previous secret's>]
//   {"v":1,"id":"evt_…","event":"invite_redeemed","agent":"rdv1:…","agent_name":"omer","at":"<ISO>","data":{…}}
// Never an invite link or secret, a key, or message text. A string a peer
// wrote appears only as {"untrusted_peer_text": "…"}.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { acquireLock, clean, eventsStamp, type Home, type LoggedEvent, readEvents, writeAtomic } from '@rendezvous/cli/lib';
import { fingerprint, guardedLookup, isAgentId, isBlockedAddress, isCapabilityUri, type Resolver } from '@rendezvous/core';
import { AGENT_NAME_RE, NOTIFY_SECRET_RE, ROOT_BINDING } from './agents.js';

export const NOTIFY_FILE = 'gateway-notify.json';
export const NOTIFY_LOCK = 'gateway-notify.lock';
/** Every event a webhook can carry. */
export const NOTIFY_EVENTS = ['invite_redeemed', 'invite_expired', 'invite_exposed', 'auto_approve_on', 'contact_request', 'contact', 'message'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
/** What `notify set` subscribes to without --events. */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEvent[] = ['invite_redeemed', 'invite_expired', 'invite_exposed', 'auto_approve_on'];
/** The signature header, and how far a receiver should let its timestamp be from its own clock. */
export const SIGNATURE_HEADER = 'X-Rdv-Signature';
export const SIGNATURE_TOLERANCE_S = 300;
/** One request's whole time, connect to response. */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** Retries (network errors, 429, 5xx) stop this long after the first try; the event then goes to the dead letters. */
export const NOTIFY_MAX_AGE_MS = 24 * 60 * 60_000;
export const NOTIFY_BASE_DELAY_MS = 5_000;
export const NOTIFY_MAX_DELAY_MS = 60 * 60_000;
/** Requests in flight at once, across every agent. */
export const NOTIFY_CONCURRENCY = 4;
/** Events waiting: in all, and per agent. Past either, that agent's own oldest go to the dead letters. */
export const OUTBOX_MAX = 1000;
export const OUTBOX_PER_AGENT = 250;
/** Dead letters kept: in all, and per agent; the oldest of the agent with the most are dropped first. */
export const DEAD_LETTER_MAX = 500;
export const DEAD_LETTER_PER_AGENT = 125;
/** contact_request events of one agent, and message events from one peer, waiting to go out are one event with a count. */
export const COALESCE_MS = 60_000;
/** The senders a merged contact_request names (the latest first). */
export const RECENT_SENDERS = 5;
/** Requests in flight per agent: a receiver that hangs holds only its own agent's slot. */
export const NOTIFY_PER_AGENT = 1;
/** The previous secret signs too for this long after `notify set` replaced it. */
export const SECRET_OVERLAP_MS = 24 * 60 * 60_000;
/** Invite ids whose expiry was sent, kept per agent (an agent has at most 32 open invites). */
const EXPIRED_KEPT = 512;
const SECRET_MIN = 16;
const SECRET_MAX = 4096;
const BODY_MAX = 16 * 1024;
const LABEL_MAX = 200;
const PEER_TEXT_MAX = 500;
const TIERS = ['spouse', 'family', 'friend', 'colleague', 'business', 'stranger'];
const BINDINGS = ['in-person', 'dns', 'mailbox', 'claimed'];

export class NotifyError extends Error {}

export interface NotifyConfig {
  url: string;
  events: NotifyEvent[];
  /** Hosts, IP addresses or CIDR ranges the owner allowed over http, and to private addresses (a Tailscale or LAN receiver). */
  insecureHosts: string[];
  /** When it was set: invites that expired before are not reported. */
  created: string;
  /** Until when the previous secret (`….secret.prev`) signs too. */
  previousUntil?: string;
  /** The identity (rdv1:…) of the agent it was set for: a migrate or resume never moves it to another. */
  agentId?: string;
}

export interface AgentNotifyState {
  /** The last events.jsonl `n` looked at. */
  cursor?: number;
  /** Invite ids whose invite_expired was queued (once per invite). */
  expired: string[];
}

export interface OutboxItem {
  id: string;
  /** The agent's binding (the root marker for the root agent, else its name): its own settings only, never another's. */
  agent: string;
  /** The identity (rdv1:…) it was made for: never sent for, or re-queued under, another agent that took the binding. */
  agentId: string;
  event: NotifyEvent;
  /** The exact bytes sent, the same on every retry. */
  body: string;
  attempts: number;
  /** Epoch ms of the first try's schedule, and of the next try. */
  first: number;
  next: number;
  lastError?: string;
  /** contact_request and message: the peer it is about, so a burst becomes one event with a count. */
  key?: string;
  count?: number;
}

export interface DeadLetter extends OutboxItem {
  deadAt: string;
  reason: string;
}

export interface NotifyData {
  v: 1;
  agents: Record<string, NotifyConfig>;
  state: Record<string, AgentNotifyState>;
  outbox: OutboxItem[];
  dead: DeadLetter[];
}

const empty = (): NotifyData => ({ v: 1, agents: {}, state: {}, outbox: [], dead: [] });

// --- signing -----------------------------------------------------------------

type Secret = string | Uint8Array;
const secretBytes = (s: Secret) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s);

/** hex HMAC-SHA256(secret, `${t}.${body}`). */
export function rdvSignature(secret: Secret, t: number, body: string): string {
  return createHmac('sha256', secretBytes(secret)).update(`${t}.`, 'utf8').update(body, 'utf8').digest('hex');
}

/** The X-Rdv-Signature value: `t=<unix seconds>,v1=<hex>`, one v1= per secret (the current one first, during a rotation). */
export function signatureHeader(secret: Secret | readonly Secret[], body: string, t: number): string {
  const all = Array.isArray(secret) ? (secret as readonly Secret[]) : [secret as Secret];
  return `t=${t},${all.map((s) => `v1=${rdvSignature(s, t, body)}`).join(',')}`;
}

/**
 * For receivers: true only if `header` (X-Rdv-Signature) signs `rawBody` (the bytes as received, before any JSON
 * parsing) with `secret` (or one of several, while a receiver rotates), and its timestamp is within `toleranceS` of
 * `now` (unix seconds). Constant-time compare; every v1= value is tried. Dedupe by the body's `id` yourself, on disk:
 * delivery is at least once.
 */
export function verifyRdvSignature(
  secret: Secret | readonly Secret[],
  header: string | undefined | null,
  rawBody: string | Uint8Array,
  opts: { now?: number; toleranceS?: number } = {},
): boolean {
  if (typeof header !== 'string' || header.length > 1024) return false;
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) return false;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') {
      if (t !== undefined || !/^\d{1,12}$/.test(v)) return false;
      t = Number(v);
    } else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (t === undefined || sigs.length === 0 || sigs.length > 8) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceS ?? SIGNATURE_TOLERANCE_S)) return false;
  const body = typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8');
  const secrets = Array.isArray(secret) ? (secret as readonly Secret[]) : [secret as Secret];
  let ok = false;
  for (const sec of secrets) {
    const want = Buffer.from(rdvSignature(sec, t, body), 'hex');
    for (const s of sigs) if (timingSafeEqual(want, Buffer.from(s, 'hex'))) ok = true;
  }
  return ok;
}

const ASCII_SPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

/**
 * A secret from a file's bytes: ASCII white space trimmed at both ends, then printable ASCII only (hex, base64, …).
 * A byte-order mark or UTF-16 text (PowerShell's `>` and `Out-File` write it) is refused with a clear error.
 */
export function parseSecret(raw: Uint8Array, where: string): Buffer {
  const b = Buffer.from(raw);
  if ((b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff) || b.includes(0)) {
    throw new NotifyError(
      `the secret in ${where} is not plain ASCII (it has a byte-order mark, or is UTF-16, as PowerShell's ">" writes): write it as ASCII, e.g. [IO.File]::WriteAllText("notify.secret", $s, [Text.Encoding]::ASCII)`,
    );
  }
  let start = 0;
  let end = b.length;
  while (start < end && ASCII_SPACE.has(b[start])) start++;
  while (end > start && ASCII_SPACE.has(b[end - 1])) end--;
  const s = b.subarray(start, end);
  if (s.some((c) => c < 0x20 || c > 0x7e)) throw new NotifyError(`the secret in ${where} must be printable ASCII (for example hex: openssl rand -hex 32)`);
  if (s.length < SECRET_MIN) throw new NotifyError(`the secret in ${where} is shorter than ${SECRET_MIN} characters (make one with: openssl rand -hex 32)`);
  return Buffer.from(s);
}

/** The secret in a file only its owner may read (POSIX: no group or other bits), as raw bytes. */
export function readSecretFile(path: string): Buffer {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new NotifyError(`the secret file ${path} cannot be read`);
  }
  if (!st.isFile()) throw new NotifyError(`the secret file ${path} is not a file`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new NotifyError(`the secret file ${path} may be read by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
  }
  if (st.size > SECRET_MAX) throw new NotifyError(`the secret file ${path} is too large to be a secret`);
  return parseSecret(readFileSync(path), path);
}

/** The fixed file an agent's secret is kept in, in the gateway root: `notify-<agent>.secret` (`notify-_root.secret` for the root agent). */
export const secretFileName = (binding: string) => `notify-${binding === ROOT_BINDING ? '_root' : binding}.secret`;
/** Every name a secret file of ours may have (the consent guard refuses the same pattern). */
export const SECRET_FILE_RE = NOTIFY_SECRET_RE;

// --- URL rules -----------------------------------------------------------------

const bare = (host: string) => host.replace(/[[\]]/g, '').toLowerCase();
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * An --allow-insecure-host entry: a host name, an IP address, or a CIDR range (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`).
 * No scheme, no port.
 */
export function checkInsecureHost(h: string): string {
  const v = bare(String(h).trim());
  const cidr = /^(.+)\/(\d{1,3})$/.exec(v);
  if (cidr) {
    const fam = isIP(cidr[1]);
    const bits = Number(cidr[2]);
    if (fam && bits <= (fam === 4 ? 32 : 128)) return `${canonIp(cidr[1])}/${bits}`;
  } else if (v && v.length <= 253 && (isIP(v) || HOSTNAME_RE.test(v))) return isIP(v) ? canonIp(v) : v;
  throw new NotifyError(`--allow-insecure-host ${JSON.stringify(h)}: a host name, an IP address or a CIDR range only (no scheme, no port)`);
}

/** An IP address in canonical form (IPv6 compressed and lowercased, as a URL writes it). */
function canonIp(ip: string): string {
  if (ip.includes('%')) throw new NotifyError(`--allow-insecure-host ${JSON.stringify(ip)}: no IPv6 zone id`);
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

interface Allowed {
  names: Set<string>;
  ips: Set<string>;
  ranges: BlockList;
  hasRanges: boolean;
}

const normIp = (ip: string) => canonIp(ip);

function allowList(entries: readonly string[]): Allowed {
  const a: Allowed = { names: new Set(), ips: new Set(), ranges: new BlockList(), hasRanges: false };
  for (const e of entries) {
    const m = /^(.+)\/(\d+)$/.exec(e);
    if (m) {
      a.ranges.addSubnet(m[1], Number(m[2]), isIP(m[1]) === 6 ? 'ipv6' : 'ipv4');
      a.hasRanges = true;
    } else if (isIP(e)) a.ips.add(normIp(e));
    else a.names.add(e);
  }
  return a;
}

const inRange = (a: Allowed, ip: string) => a.hasRanges && a.ranges.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** Loopback, link-local (the cloud metadata address among them), unspecified, multicast: reached only when named as that exact IP. */
const NEVER = new BlockList();
for (const [n, p] of [['0.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) NEVER.addSubnet(n, p, 'ipv4');
for (const [n, p] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) NEVER.addSubnet(n, p, 'ipv6');

/**
 * Whether a connection for `host` may reach `ip`: any public address; an address the owner named exactly; a private
 * one (LAN, CGNAT/Tailscale, ULA) inside a range the owner allowed, or for a host name the owner allowed. Loopback,
 * link-local and metadata addresses only when named as that exact IP.
 */
export function addressAllowed(host: string, entries: readonly string[]): (ip: string) => boolean {
  const a = allowList(entries);
  const h = bare(host);
  return (ip) => {
    if (a.ips.has(normIp(ip))) return true;
    if (!isBlockedAddress(ip)) return true;
    if (NEVER.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')) return false;
    // An IPv6 form that carries an IPv4 address (mapped, compatible, NAT64, 6to4) is judged by that address too.
    const v4 = embeddedV4(ip);
    if (v4 && NEVER.check(v4, 'ipv4')) return false;
    return a.names.has(h) || inRange(a, ip);
  };
}

/** The eight hextets of an IPv6 address (a dotted IPv4 tail included), or undefined. */
function hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const dot = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dot) {
    const o = dot[1].split('.').map(Number);
    s = s.slice(0, -dot[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [l, r] = s.split('::');
  const left = l ? l.split(':') : [];
  const right = r === undefined ? [] : r ? r.split(':') : [];
  const fill = r === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : undefined;
}

/**
 * The IPv4 address an IPv6 address embeds: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d,
 * NAT64 64:ff9b::a.b.c.d and its local-use 64:ff9b:1::/48 (the last 32 bits), 6to4 2002:aabb:ccdd::.
 */
export function embeddedV4(ip: string): string | undefined {
  if (isIP(ip) !== 6) return undefined;
  const w = hextets(ip);
  if (!w) return undefined;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (w[5] === 0xffff || w[5] === 0)) return v4(w[6], w[7]);
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return v4(w[6], w[7]);
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return v4(w[6], w[7]);
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return v4(w[6], w[7]);
  if (w[0] === 0x2002) return v4(w[1], w[2]);
  return undefined;
}

/** The webhook URL rules: https, or http only to a host the owner allowed (by name, IP or range); no credentials in it. */
export function checkNotifyUrl(url: string, insecureHosts: readonly string[] = []): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new NotifyError(`--url ${JSON.stringify(url)} is not a URL`);
  }
  if (u.username || u.password) throw new NotifyError('--url must not hold a user name or password (the signature is what authenticates)');
  const host = bare(u.hostname);
  if (u.protocol === 'http:') {
    const a = allowList(insecureHosts);
    const ok = a.names.has(host) || (isIP(host) > 0 && (a.ips.has(normIp(host)) || inRange(a, host)));
    if (!ok) throw new NotifyError(`--url is http: allowed only to a host you name with --allow-insecure-host ${host} (a Tailscale or LAN address of your receiver); use https otherwise`);
  } else if (u.protocol !== 'https:') throw new NotifyError('--url must be https:// (http only with --allow-insecure-host)');
  if (u.hash) throw new NotifyError('--url must not have a #fragment');
  return u.toString();
}

/** How `notify show` and the log name a receiver: scheme and host only (a path or query may hold a token). */
export const receiverName = (url: string) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
};

export type PostResult = { status: number } | { error: string; permanent: boolean };

/**
 * One POST, no redirects followed, the response body ignored (read to at most 4 KiB). The connection is pinned to an
 * address that passed the SSRF check, so a name that rebinds cannot switch after the check.
 */
export function postWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { insecureHosts?: readonly string[]; timeoutMs?: number; resolve?: Resolver } = {},
): Promise<PostResult> {
  const u = new URL(url);
  const host = bare(u.hostname);
  const allowed = addressAllowed(host, opts.insecureHosts ?? []);
  // An IP literal never goes through `lookup`: check it here.
  if (isIP(host) && !allowed(host)) return Promise.resolve({ error: 'the URL is a private or reserved address (allow it with --allow-insecure-host)', permanent: true });
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: PostResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = send(
      u,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'User-Agent': 'rdv-gateway-notify/1' },
        lookup: guardedLookup({ allowed, ...(opts.resolve ? { resolve: opts.resolve } : {}) }),
        agent: false,
      },
      (res) => {
        let got = 0;
        res.on('data', (c: Buffer) => {
          got += c.length;
          if (got > 4096) res.destroy();
        });
        res.on('error', () => {});
        res.on('close', () => finish({ status: res.statusCode ?? 0 }));
        res.on('end', () => finish({ status: res.statusCode ?? 0 }));
      },
    );
    const timer = setTimeout(() => {
      finish({ error: `no answer within ${Math.round((opts.timeoutMs ?? NOTIFY_TIMEOUT_MS) / 1000)} s`, permanent: false });
      req.destroy();
    }, opts.timeoutMs ?? NOTIFY_TIMEOUT_MS);
    req.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'blocked-address') return finish({ error: 'the host resolves to a private or reserved address (allow it with --allow-insecure-host)', permanent: true });
      finish({ error: `network error (${err.code ?? 'unknown'})`, permanent: false });
    });
    req.end(body);
  });
}

/** How a response is handled: delivered, tried again later (429, 5xx), or dropped to the dead letters (any other). */
export function classifyStatus(status: number): 'delivered' | 'retry' | 'permanent' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 429 || (status >= 500 && status < 600)) return 'retry';
  return 'permanent';
}

// --- the state file -------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isBinding = (b: string) => b === ROOT_BINDING || AGENT_NAME_RE.test(b);

function checkItem(x: unknown, where: string, dead: boolean): void {
  const bad = (what: string) => {
    throw new NotifyError(`${where}: ${what}`);
  };
  if (!isObj(x)) bad('not an object');
  const i = x as Record<string, unknown>;
  if (typeof i.id !== 'string' || !/^evt_[0-9a-f]{32}$/.test(i.id)) bad('bad id');
  if (typeof i.agent !== 'string' || !isBinding(i.agent)) bad('bad agent');
  if (!isAgentId(i.agentId)) bad('bad agentId');
  if (!(NOTIFY_EVENTS as readonly unknown[]).includes(i.event)) bad('bad event');
  if (typeof i.body !== 'string' || i.body.length > BODY_MAX) bad('bad body');
  if (!isInt(i.attempts) || typeof i.first !== 'number' || typeof i.next !== 'number') bad('bad schedule');
  if (i.key !== undefined && (typeof i.key !== 'string' || i.key.length > 200)) bad('bad key');
  if (i.count !== undefined && !isInt(i.count)) bad('bad count');
  if (i.lastError !== undefined && typeof i.lastError !== 'string') bad('bad lastError');
  if (dead && (typeof i.deadAt !== 'string' || typeof i.reason !== 'string')) bad('bad dead letter');
}

/** The whole file, checked against its schema and the URL rules: anything else is refused (fail closed), never half-used. */
export function validateNotifyData(raw: unknown, path = NOTIFY_FILE): NotifyData {
  const fail = (what: string): never => {
    throw new NotifyError(`${path}: ${what}. Fix or remove it in your own terminal (rdv-gateway notify clear, or delete the file to start over)`);
  };
  if (!isObj(raw) || raw.v !== 1) fail('unknown version or not an object');
  const r = raw as Record<string, unknown>;
  const d: NotifyData = { ...empty(), ...(r as Partial<NotifyData>) } as NotifyData;
  if (!isObj(d.agents) || !isObj(d.state) || !Array.isArray(d.outbox) || !Array.isArray(d.dead)) fail('bad shape');
  for (const [b, c] of Object.entries(d.agents)) {
    if (!isBinding(b) || !isObj(c)) fail(`bad agent entry ${JSON.stringify(b)}`);
    const cfg = c as unknown as Record<string, unknown>;
    if (!Array.isArray(cfg.insecureHosts) || cfg.insecureHosts.some((h) => typeof h !== 'string')) fail(`agent ${b}: bad insecureHosts`);
    if (!Array.isArray(cfg.events) || cfg.events.length === 0 || cfg.events.some((e) => !(NOTIFY_EVENTS as readonly unknown[]).includes(e))) fail(`agent ${b}: bad events`);
    if (!isTime(cfg.created) || (cfg.previousUntil !== undefined && !isTime(cfg.previousUntil))) fail(`agent ${b}: bad times`);
    if (cfg.agentId !== undefined && !isAgentId(cfg.agentId)) fail(`agent ${b}: bad agentId`);
    try {
      const hosts = (cfg.insecureHosts as string[]).map(checkInsecureHost);
      if (hosts.join() !== (cfg.insecureHosts as string[]).join()) fail(`agent ${b}: insecureHosts not in normal form`);
      if (typeof cfg.url !== 'string' || checkNotifyUrl(cfg.url, hosts) !== cfg.url) fail(`agent ${b}: url not in normal form`);
    } catch (err) {
      if (err instanceof NotifyError && !err.message.startsWith(path)) fail(`agent ${b}: ${err.message}`);
      throw err;
    }
  }
  for (const [b, s] of Object.entries(d.state)) {
    if (!isBinding(b) || !isObj(s)) fail(`bad state entry ${JSON.stringify(b)}`);
    const st = s as unknown as Record<string, unknown>;
    if (st.cursor !== undefined && !isInt(st.cursor)) fail(`state ${b}: bad cursor`);
    if (!Array.isArray(st.expired) || st.expired.some((x) => typeof x !== 'string' || !/^[0-9a-f]{16}$/.test(x))) fail(`state ${b}: bad expired`);
  }
  try {
    d.outbox.forEach((x, k) => checkItem(x, `outbox[${k}]`, false));
    d.dead.forEach((x, k) => checkItem(x, `dead[${k}]`, true));
  } catch (err) {
    fail((err as Error).message);
  }
  return d;
}

/** What goes first when an agent is over its cap: requests and messages, then contacts; invites only when nothing else is left. */
const PRIORITY: Record<NotifyEvent, number> = { contact_request: 0, message: 0, contact: 1, invite_redeemed: 2, invite_expired: 2, invite_exposed: 2, auto_approve_on: 2 };

/**
 * Per-agent and total caps: an agent over its share loses its own items, never another agent's: the lowest priority
 * first (PRIORITY), the oldest of those.
 */
function enforceCaps(d: NotifyData, now: number): void {
  const busiest = (items: OutboxItem[]) => {
    const n = new Map<string, number>();
    for (const i of items) n.set(i.agent, (n.get(i.agent) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0];
  };
  const trim = <T extends OutboxItem>(items: T[], per: number, total: number, evict: (x: T) => void): T[] => {
    for (;;) {
      const [agent, n] = busiest(items) ?? ['', 0];
      if (n <= per && items.length <= total) return items;
      let at = -1;
      for (let k = 0; k < items.length; k++) {
        if (items[k].agent !== agent) continue;
        if (at < 0 || PRIORITY[items[k].event] < PRIORITY[items[at].event]) at = k;
      }
      evict(items[at]);
      items = [...items.slice(0, at), ...items.slice(at + 1)];
    }
  };
  d.outbox = trim(d.outbox, OUTBOX_PER_AGENT, OUTBOX_MAX, (old) => d.dead.push({ ...old, deadAt: new Date(now).toISOString(), reason: 'the outbox was full' }));
  d.dead = trim(d.dead, DEAD_LETTER_PER_AGENT, DEAD_LETTER_MAX, () => {});
}

export class NotifyStore {
  readonly path: string;
  private readonly lockPath: string;
  private cache?: { stamp: string; data: NotifyData };

  constructor(readonly home: Home) {
    this.path = join(home.dir, NOTIFY_FILE);
    this.lockPath = join(home.dir, NOTIFY_LOCK);
  }

  /** The current state, schema-checked (re-read when the file changed). Throws NotifyError on a bad file. */
  read(): NotifyData {
    if (!existsSync(this.path)) return empty();
    const st = statSync(this.path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (this.cache?.stamp === stamp) return this.cache.data;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new NotifyError(`${this.path}: not valid JSON. Fix or remove it in your own terminal`);
    }
    const data = validateNotifyData(raw, this.path);
    this.cache = { stamp, data };
    return data;
  }

  /** Read, change, write under gateway-notify.lock (compact JSON): the terminal's commands and a serving gateway both write it. */
  async update<T>(fn: (d: NotifyData) => T, now = Date.now()): Promise<T> {
    this.home.ensureDir();
    const release = await acquireLock(this.lockPath);
    try {
      this.cache = undefined;
      const d = structuredClone(this.read());
      const r = fn(d);
      enforceCaps(d, now);
      writeAtomic(this.path, `${JSON.stringify(d)}\n`, 0o600);
      this.cache = undefined;
      return r;
    } finally {
      release();
    }
  }

  config(binding: string): NotifyConfig | undefined {
    const d = this.read();
    return Object.hasOwn(d.agents, binding) ? d.agents[binding] : undefined;
  }

  secretPath(binding: string): string {
    return join(this.home.dir, secretFileName(binding));
  }

  /** The secrets that sign for an agent now: its current one, then the previous one while its 24 h last. */
  secrets(binding: string, now = Date.now()): Buffer[] {
    const out = [readSecretFile(this.secretPath(binding))];
    const until = this.config(binding)?.previousUntil;
    const prev = `${this.secretPath(binding)}.prev`;
    // Its 24 h are over: the previous secret is deleted, not kept on disk.
    if (until && Date.parse(until) <= now) rmSync(prev, { force: true });
    if (until && Date.parse(until) > now && existsSync(prev)) {
      try {
        out.push(readSecretFile(`${this.secretPath(binding)}.prev`));
      } catch {
        // an unreadable previous secret only ends the overlap early
      }
    }
    return out;
  }

  /**
   * `notify set`: the settings for one agent, and its secret copied to notify-<agent>.secret (mode 600). A different
   * secret than before keeps the old one as ….secret.prev, signing too for 24 h. Its cursor starts at the end of its
   * events (history is never sent).
   */
  async set(binding: string, cfg: Pick<NotifyConfig, 'url' | 'events' | 'insecureHosts'>, secret: Buffer, cursor: number, now = new Date(), agentId?: string): Promise<NotifyConfig> {
    if (!isBinding(binding)) throw new NotifyError(`invalid agent binding ${JSON.stringify(binding)}`);
    const hosts = cfg.insecureHosts.map(checkInsecureHost);
    const url = checkNotifyUrl(cfg.url, hosts);
    const sec = parseSecret(secret, 'the secret given');
    return this.update((d) => {
      const prev = Object.hasOwn(d.agents, binding) ? d.agents[binding] : undefined;
      const path = this.secretPath(binding);
      let previousUntil = prev?.previousUntil;
      let old: Buffer | undefined;
      try {
        old = existsSync(path) ? readSecretFile(path) : undefined;
      } catch {
        old = undefined;
      }
      if (old && !old.equals(sec)) {
        writeAtomic(`${path}.prev`, old.toString('latin1'), 0o600);
        previousUntil = new Date(now.getTime() + SECRET_OVERLAP_MS).toISOString();
      }
      if (!old || !old.equals(sec)) writeAtomic(path, sec.toString('latin1'), 0o600);
      const id = agentId ?? prev?.agentId;
      const next: NotifyConfig = {
        url,
        events: [...cfg.events],
        insecureHosts: hosts,
        created: prev?.created ?? now.toISOString(),
        ...(previousUntil ? { previousUntil } : {}),
        ...(id ? { agentId: id } : {}),
      };
      d.agents[binding] = next;
      if (!Object.hasOwn(d.state, binding)) d.state[binding] = { cursor, expired: [] };
      return next;
    }, now.getTime());
  }

  /**
   * `notify clear`: its settings, secret, cursor and queued events go. Its dead letters stay to be read, unless
   * `dead` (`agent add`, `agent remove`: the binding's identity ends or changes, so they go too).
   */
  async clear(binding: string, opts: { dead?: boolean } = {}): Promise<{ had: boolean; dropped: number }> {
    return this.update((d) => {
      const had = Object.hasOwn(d.agents, binding);
      delete d.agents[binding];
      delete d.state[binding];
      const before = d.outbox.length;
      d.outbox = d.outbox.filter((i) => i.agent !== binding);
      if (opts.dead) d.dead = d.dead.filter((i) => i.agent !== binding);
      rmSync(this.secretPath(binding), { force: true });
      rmSync(`${this.secretPath(binding)}.prev`, { force: true });
      return { had, dropped: before - d.outbox.length };
    });
  }

  /** `agent migrate`: the root agent's settings, secret and events now belong to its new name (the same identity). */
  async rebind(from: string, to: string): Promise<void> {
    await this.update((d) => {
      if (Object.hasOwn(d.agents, from)) {
        d.agents[to] = d.agents[from];
        delete d.agents[from];
      }
      if (Object.hasOwn(d.state, from)) {
        d.state[to] = d.state[from];
        delete d.state[from];
      }
      for (const i of d.outbox) if (i.agent === from) i.agent = to;
      for (const i of d.dead) if (i.agent === from) i.agent = to;
      for (const suffix of ['', '.prev']) {
        if (existsSync(this.secretPath(from) + suffix)) renameSync(this.secretPath(from) + suffix, this.secretPath(to) + suffix);
      }
    });
  }

  /** Webhook settings made before identities were recorded get the identity their agent has now. */
  async stampIdentities(identityOf: (binding: string, created: string) => string | undefined): Promise<number> {
    if (!Object.entries(this.read().agents).some(([b, c]) => c.agentId === undefined && identityOf(b, c.created))) return 0;
    return this.update((d) => {
      let n = 0;
      for (const [b, c] of Object.entries(d.agents)) {
        const id = c.agentId === undefined ? identityOf(b, c.created) : undefined;
        if (id) {
          c.agentId = id;
          n += 1;
        }
      }
      return n;
    });
  }

  /** The dead letters of this binding made for this identity. */
  deadLetters(binding: string, agentId: string): DeadLetter[] {
    return this.read().dead.filter((i) => i.agent === binding && i.agentId === agentId);
  }

  /**
   * `notify dead-letter --retry`: this identity's dead letters back into the outbox, due now, with a fresh 24 h; the
   * same ids, so receivers dedupe. Any of another identity (an agent that had this name before) is refused and kept.
   */
  async retryDead(binding: string, agentId: string, now = Date.now()): Promise<{ queued: number; refused: number }> {
    return this.update((d) => {
      const mine = d.dead.filter((i) => i.agent === binding && i.agentId === agentId);
      const refused = d.dead.filter((i) => i.agent === binding && i.agentId !== agentId).length;
      d.dead = d.dead.filter((i) => !mine.includes(i));
      for (const { deadAt: _d, reason: _r, lastError: _e, ...item } of mine) d.outbox.push({ ...item, attempts: 0, first: now, next: now });
      return { queued: mine.length, refused };
    }, now);
  }
}

// --- event shapes ----------------------------------------------------------------

const inviteId = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{16}$/.test(v) ? v : null);
const oneOf = (list: string[]) => (v: unknown) => (typeof v === 'string' && list.includes(v) ? v : null);
const tier = oneOf(TIERS);
/** Our own user's words (a label): plain, with control characters replaced. */
const ownText = (v: unknown) => (typeof v === 'string' && v ? clean(v).slice(0, LABEL_MAX) : null);
const fp = (id: unknown) => (isAgentId(id) ? fingerprint(id) : null);
const peerText = (v: unknown) => (typeof v === 'string' && v ? { untrusted_peer_text: clean(v).slice(0, PEER_TEXT_MAX) } : null);
const seq = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** The data of one logged event, if it is one a webhook carries (and which). Only fields we checked; never text. */
export function eventData(obj: LoggedEvent['obj'], contactLabel: (peer: string) => string | undefined): { event: NotifyEvent; data: Record<string, unknown> } | undefined {
  switch (obj.event) {
    case 'invite-redeemed':
      return {
        event: 'invite_redeemed',
        data: { invite_id: inviteId(obj.invite_id), tier: tier(obj.tier), label: ownText(obj.invite_label ?? obj.label), redeemer_fingerprint: fp(obj.peer) },
      };
    case 'invite-exposed':
      return { event: 'invite_exposed', data: { invite_id: inviteId(obj.invite_id), label: ownText(obj.invite_label), from_fingerprint: fp(obj.from) } };
    case 'auto-approve-on':
      // An invite the owner armed with the "Don't ask again" box was used (NOTES 112): metadata only, so the human hears it without the assistant.
      return {
        event: 'auto_approve_on',
        data: {
          invite_id: inviteId(obj.invite_id),
          fingerprint: fp(obj.peer),
          covers: (Array.isArray(obj.covers) ? obj.covers : []).slice(0, 32).filter((c): c is string => isCapabilityUri(c)),
          until: typeof obj.until === 'string' ? clean(obj.until).slice(0, 64) : null,
        },
      };
    case 'request':
      return {
        event: 'contact_request',
        data: {
          request_id: typeof obj.id === 'string' && /^[0-9a-f-]{36}$/i.test(obj.id) ? obj.id : null,
          from_fingerprint: fp(obj.from),
          binding: oneOf(BINDINGS)(obj.binding),
          greeting: peerText(obj.greeting),
          count: 1,
        },
      };
    case 'contact':
      return { event: 'contact', data: { fingerprint: fp(obj.peer), label: ownText(obj.label), tier: tier(obj.tier), binding: oneOf(BINDINGS)(obj.binding) } };
    case 'message': {
      const from = isAgentId(obj.from) ? obj.from : undefined;
      return { event: 'message', data: { from_fingerprint: from ? fingerprint(from) : null, label: from ? ownText(contactLabel(from)) : null, seq: seq(obj.seq), count: 1 } };
    }
    default:
      return undefined;
  }
}

/** One event's body: the exact bytes that are signed and sent. */
export function eventBody(x: { id: string; event: NotifyEvent; agent: string; agentName: string; at: string; data: Record<string, unknown> }): string {
  return JSON.stringify({ v: 1, id: x.id, event: x.event, agent: x.agent, agent_name: x.agentName, at: x.at, data: x.data });
}

const newId = () => `evt_${randomBytes(16).toString('hex')}`;

// --- the notifier -----------------------------------------------------------------

/** An agent the notifier watches: the gateway's runtime for it. */
export interface NotifyAgent {
  name: string;
  home: Home;
  /** Its binding in the settings (the root marker for the root agent). */
  binding: string;
  /** Its agent ID (rdv1:…). */
  id?: string;
}

export interface NotifierOptions {
  store: NotifyStore;
  agents: readonly NotifyAgent[];
  log: (line: string) => void;
  now?: () => number;
  /** How often events are looked for and due events sent (default 1 s). */
  tickMs?: number;
  /** How often expired invites are looked for (default 60 s). */
  sweepMs?: number;
  /** Outcomes are written together, at most this often (default 100 ms). */
  settleMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** In flight per agent (default NOTIFY_PER_AGENT). */
  perAgent?: number;
  maxAgeMs?: number;
  baseDelayMs?: number;
  /** Replaces the system resolver (tests). */
  resolve?: Resolver;
  /** The identity settings that record none belong to (the gateway's shared rule; 'unknown' sends nothing). */
  legacyIdentity?: (binding: string, created: string) => string | undefined;
}

type Outcome = { id: string; how: 'drop' | 'retry' | 'dead'; why?: string; next?: number };

export class Notifier {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private lastSweep = -Infinity;
  private lastError?: string;
  private readonly stamps = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** The agent (binding) of each item in flight, for the per-agent slots. */
  private readonly inflightAgent = new Map<string, string>();
  private turn = 0;
  private readonly warnedIdentity = new Set<string>();
  /** Outcomes not yet written: their items stay out of dispatch until they are. */
  private readonly outcomes: Outcome[] = [];
  private readonly settling = new Set<string>();
  private flushing?: Promise<void>;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly opts: NotifierOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    const d = this.opts.store.read();
    for (const a of this.opts.agents) {
      const cfg = Object.hasOwn(d.agents, a.binding) ? d.agents[a.binding] : undefined;
      if (cfg) this.opts.log(`notify: agent ${a.name} posts ${cfg.events.join(', ')} to ${receiverName(cfg.url)}`);
    }
    if (d.outbox.length) this.opts.log(`notify: ${d.outbox.length} event(s) waiting from before; sending them`);
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 1000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking?.catch(() => {});
    await this.idle();
  }

  /** One round: new events queued, expired invites queued (every sweepMs), due events sent. Never throws. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.scan();
        if (this.now() - this.lastSweep >= (this.opts.sweepMs ?? 60_000)) {
          this.lastSweep = this.now();
          await this.sweep();
        }
        this.dispatch();
        this.lastError = undefined;
      } catch (err) {
        // Once per distinct problem, not every second.
        const m = (err as Error).message;
        if (m !== this.lastError) this.opts.log(`notify: ${m}`);
        this.lastError = m;
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  /** Wait until nothing is in flight or waiting to be written (tests, close). */
  async idle(): Promise<void> {
    while (this.inflight.size || this.flushing) {
      await Promise.allSettled([...this.inflight.values()]);
      await this.flushing;
    }
  }

  private enqueue(d: NotifyData, a: NotifyAgent, event: NotifyEvent, at: string, data: Record<string, unknown>): void {
    if (!a.id) return;
    const now = this.now();
    // Requests are one rolling event per agent (strangers' keys are free, so per sender would be no bound), messages
    // one per peer (only contacts send them): merged into a waiting item that was never sent (a try may have reached
    // the receiver, which then drops a retry with new content under the same id). A request's item carries the latest
    // one's fields and its last few senders.
    const key = event === 'contact_request' ? 'contact_request' : event === 'message' ? `message:${String(data.from_fingerprint)}` : undefined;
    if (event === 'contact_request') data = { ...data, recent_fingerprints: data.from_fingerprint ? [data.from_fingerprint] : [] };
    if (key) {
      const same = d.outbox.find((i) => i.agent === a.binding && i.agentId === a.id && i.key === key && i.attempts === 0 && !this.inflight.has(i.id) && !this.settling.has(i.id));
      if (same) {
        same.count = (same.count ?? 1) + 1;
        const body = JSON.parse(same.body) as { at: string; data: Record<string, unknown> };
        const merged =
          event === 'contact_request'
            ? {
                ...data,
                count: same.count,
                recent_fingerprints: [...new Set([...((data.recent_fingerprints as string[]) ?? []), ...((body.data.recent_fingerprints as string[]) ?? [])])].slice(0, RECENT_SENDERS),
              }
            : { ...body.data, count: same.count };
        same.body = eventBody({ id: same.id, event, agent: a.id, agentName: a.name, at: event === 'contact_request' ? at : body.at, data: merged });
        return;
      }
    }
    const id = newId();
    d.outbox.push({ id, agent: a.binding, agentId: a.id, event, body: eventBody({ id, event, agent: a.id, agentName: a.name, at, data }), attempts: 0, first: now, next: now, ...(key ? { key, count: 1 } : {}) });
  }

  /** Each watched agent's new events.jsonl lines (past its cursor), queued for the events it subscribes to. */
  private async scan(): Promise<void> {
    const cfgs = this.opts.store.read().agents;
    for (const a of this.opts.agents) {
      if (!Object.hasOwn(cfgs, a.binding)) continue;
      const stamp = eventsStamp(a.home);
      if (this.stamps.get(a.binding) === stamp) continue;
      const events = readEvents(a.home);
      const last = events.length ? events[events.length - 1].n : 0;
      let labels: Record<string, { label?: string }> | undefined;
      const label = (peer: string) => {
        try {
          labels ??= a.home.readAgentState().book.contacts as Record<string, { label?: string }>;
        } catch {
          labels = {};
        }
        return Object.hasOwn(labels, peer) ? labels[peer].label : undefined;
      };
      await this.opts.store.update((d) => {
        const cfg = Object.hasOwn(d.agents, a.binding) ? d.agents[a.binding] : undefined;
        if (!cfg || !this.sameIdentity(cfg, a)) return;
        const st = (d.state[a.binding] ??= { expired: [] });
        if (st.cursor === undefined) {
          st.cursor = last;
          return;
        }
        // The log was replaced (a restore, or deleted by hand): its counter started again. Go on from its end.
        if (last < st.cursor) {
          this.opts.log(`notify: agent ${a.name}'s event log was reset; going on from its end`);
          st.cursor = last;
          return;
        }
        for (const e of events) {
          if (e.n <= st.cursor) continue;
          const x = eventData(e.obj, label);
          if (x && cfg.events.includes(x.event)) this.enqueue(d, a, x.event, typeof e.ts === 'string' ? e.ts : new Date(this.now()).toISOString(), x.data);
        }
        st.cursor = last;
      }, this.now());
      this.stamps.set(a.binding, stamp);
    }
  }

  /** Open invites that passed their expiry unused since the settings were made: invite_expired, once per invite. */
  private async sweep(): Promise<void> {
    const cfgs = this.opts.store.read().agents;
    for (const a of this.opts.agents) {
      const cfg0 = Object.hasOwn(cfgs, a.binding) ? cfgs[a.binding] : undefined;
      if (!cfg0?.events.includes('invite_expired')) continue;
      let invites: Record<string, { id?: unknown; expires?: unknown; used?: unknown; revoked?: unknown; tier?: unknown; label?: unknown }>;
      try {
        invites = (a.home.readAgentState().book.invites ?? {}) as typeof invites;
      } catch {
        continue;
      }
      const now = this.now();
      await this.opts.store.update((d) => {
        const cfg = Object.hasOwn(d.agents, a.binding) ? d.agents[a.binding] : undefined;
        if (!cfg?.events.includes('invite_expired') || !this.sameIdentity(cfg, a)) return;
        const st = (d.state[a.binding] ??= { expired: [] });
        const since = Date.parse(cfg.created);
        for (const [key, r] of Object.entries(invites)) {
          const id = inviteId(r.id ?? key);
          const exp = typeof r.expires === 'string' ? Date.parse(r.expires) : NaN;
          if (!id || r.used || r.revoked || !Number.isFinite(exp) || exp > now || exp <= since || st.expired.includes(id)) continue;
          st.expired.push(id);
          this.enqueue(d, a, 'invite_expired', new Date(exp).toISOString(), { invite_id: id, tier: tier(r.tier), label: ownText(r.label), expired_at: new Date(exp).toISOString() });
        }
        st.expired = st.expired.slice(-EXPIRED_KEPT);
      }, now);
    }
  }

  /** Due events, a few at a time; called on every tick and again as each delivery ends. */
  private dispatch(): void {
    if (this.closed) return;
    const room = (this.opts.concurrency ?? NOTIFY_CONCURRENCY) - this.inflight.size;
    if (room <= 0) return;
    const now = this.now();
    let outbox: OutboxItem[];
    try {
      outbox = this.opts.store.read().outbox;
    } catch {
      return; // tick() reports a bad file
    }
    // At most NOTIFY_PER_AGENT in flight per agent, and agents take turns, so one agent's stuck receiver or long
    // queue never holds back another's events.
    const per = this.opts.perAgent ?? NOTIFY_PER_AGENT;
    const busy = new Map<string, number>();
    for (const b of this.inflightAgent.values()) busy.set(b, (busy.get(b) ?? 0) + 1);
    const queues = new Map<string, OutboxItem[]>();
    for (const i of outbox) {
      if (i.next > now || this.inflight.has(i.id) || this.settling.has(i.id)) continue;
      const q = queues.get(i.agent) ?? [];
      q.push(i);
      queues.set(i.agent, q);
    }
    const order = [...queues.keys()].sort();
    const start = order.length ? this.turn++ % order.length : 0;
    const turns = [...order.slice(start), ...order.slice(0, start)];
    const due: OutboxItem[] = [];
    for (let progress = true; progress && due.length < room; ) {
      progress = false;
      for (const b of turns) {
        if (due.length >= room) break;
        if ((busy.get(b) ?? 0) >= per) continue;
        const next = queues.get(b)!.shift();
        if (!next) continue;
        due.push(next);
        busy.set(b, (busy.get(b) ?? 0) + 1);
        progress = true;
      }
    }
    for (const item of due) {
      this.inflightAgent.set(item.id, item.agent);
      this.settling.add(item.id);
      const p = this.deliver(item)
        .catch((err) => {
          this.opts.log(`notify: ${(err as Error).message}`);
          this.settling.delete(item.id);
        })
        .finally(() => {
          this.inflight.delete(item.id);
          this.inflightAgent.delete(item.id);
          this.dispatch();
        });
      this.inflight.set(item.id, p);
    }
  }

  /**
   * Settings made for another identity than the agent served under that binding now (its home was restored as or
   * replaced by another agent) send nothing: said once per binding.
   */
  private sameIdentity(cfg: NotifyConfig, a: NotifyAgent): boolean {
    // Settings that record none (not stamped: unknowable) are judged by the gateway's rule when it gives one.
    const id = cfg.agentId ?? this.opts.legacyIdentity?.(a.binding, cfg.created);
    if (id === undefined || id === a.id) return true;
    if (!this.warnedIdentity.has(a.binding)) {
      this.warnedIdentity.add(a.binding);
      this.opts.log(`notify: agent ${a.name}'s webhook was set for another agent identity; nothing is sent until you set it again (rdv-gateway notify set ${a.name} …) or clear it`);
    }
    return false;
  }

  private agent(binding: string): NotifyAgent | undefined {
    return this.opts.agents.find((a) => a.binding === binding);
  }

  private async deliver(item: OutboxItem): Promise<void> {
    const cfg = this.opts.store.config(item.agent);
    const a = this.agent(item.agent);
    const name = a?.name ?? item.agent;
    // Settings cleared, the event unsubscribed, or another identity holds this binding now: nothing to send it to.
    if (!cfg || !cfg.events.includes(item.event) || !a || a.id !== item.agentId || !this.sameIdentity(cfg, a)) return this.settle({ id: item.id, how: 'drop' });
    let result: PostResult;
    try {
      const secrets = this.opts.store.secrets(item.agent, this.now());
      const t = Math.floor(this.now() / 1000);
      result = await postWebhook(cfg.url, item.body, { [SIGNATURE_HEADER]: signatureHeader(secrets, item.body, t) }, { insecureHosts: cfg.insecureHosts, timeoutMs: this.opts.timeoutMs, resolve: this.opts.resolve });
    } catch (err) {
      // A secret file the owner can fix (its mode, its contents): retried like a network error.
      result = { error: (err as Error).message, permanent: false };
    }
    const host = receiverName(cfg.url);
    if ('status' in result) {
      const c = classifyStatus(result.status);
      if (c === 'delivered') return this.settle({ id: item.id, how: 'drop' });
      if (c === 'permanent') {
        this.opts.log(`notify: ${name} ${item.event} ${item.id}: ${host} answered ${result.status}; not retried (dead letter)`);
        return this.settle({ id: item.id, how: 'dead', why: `the receiver answered ${result.status}${result.status >= 300 && result.status < 400 ? ' (redirects are not followed)' : ''}` });
      }
      return this.retry(item, name, host, `the receiver answered ${result.status}`);
    }
    if (result.permanent) {
      this.opts.log(`notify: ${name} ${item.event} ${item.id}: ${result.error}; not retried (dead letter)`);
      return this.settle({ id: item.id, how: 'dead', why: result.error });
    }
    return this.retry(item, name, host, result.error);
  }

  private retry(item: OutboxItem, name: string, host: string, why: string): Promise<void> {
    const now = this.now();
    const maxAge = this.opts.maxAgeMs ?? NOTIFY_MAX_AGE_MS;
    if (now - item.first >= maxAge) {
      this.opts.log(`notify: ${name} ${item.event} ${item.id}: gave up after ${Math.round(maxAge / 3_600_000)} h (${why}; dead letter)`);
      return this.settle({ id: item.id, how: 'dead', why: `gave up after ${item.attempts + 1} tries: ${why}` });
    }
    const base = this.opts.baseDelayMs ?? NOTIFY_BASE_DELAY_MS;
    const delay = Math.min(NOTIFY_MAX_DELAY_MS, base * 2 ** Math.min(item.attempts, 20)) * (0.8 + Math.random() * 0.4);
    if (item.attempts === 0) this.opts.log(`notify: ${name} ${item.event} ${item.id}: ${host}: ${why}; trying again`);
    return this.settle({ id: item.id, how: 'retry', why, next: Math.min(now + delay, item.first + maxAge) });
  }

  /** Queue one delivery's outcome; outcomes are written together (one write for many), soon after. */
  private settle(o: Outcome): Promise<void> {
    this.outcomes.push(o);
    this.flushing ??= this.flush();
    return this.flushing;
  }

  private async flush(): Promise<void> {
    try {
      while (this.outcomes.length) {
        await new Promise((r) => setTimeout(r, this.opts.settleMs ?? 100));
        const batch = this.outcomes.splice(0);
        try {
          await this.opts.store.update((d) => {
            for (const o of batch) {
              const i = d.outbox.findIndex((x) => x.id === o.id);
              if (i < 0) continue;
              const cur = d.outbox[i];
              if (o.how === 'retry') {
                cur.attempts += 1;
                cur.next = o.next!;
                cur.lastError = o.why;
                continue;
              }
              d.outbox.splice(i, 1);
              if (o.how === 'dead') d.dead.push({ ...cur, attempts: cur.attempts + 1, lastError: o.why, deadAt: new Date(this.now()).toISOString(), reason: o.why ?? 'dropped' });
            }
          }, this.now());
        } catch (err) {
          // Not written: the items are sent again (at least once), never lost.
          this.opts.log(`notify: ${(err as Error).message}`);
        } finally {
          for (const o of batch) this.settling.delete(o.id);
        }
      }
    } finally {
      this.flushing = undefined;
    }
    this.dispatch();
  }
}
