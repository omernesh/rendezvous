// SPEC §7.7: fetching a file reference, under the rules for peer URLs.
//
// A URL in a file reference is peer data. This helper is the only place core
// touches one, and only when the caller asks: nothing is fetched because a
// reference arrived. Rules:
//   - https only, no userinfo; at most 3 redirects, each re-validated;
//   - never to private, loopback, link-local, multicast or otherwise special
//     addresses. The name is resolved here, every address is checked, and the
//     connection is pinned to the checked address (a custom `lookup`), so a
//     DNS answer that changes between check and connect (rebinding) cannot
//     move it; the socket's peer address is checked again on connect;
//   - no credentials: no cookies, no Authorization, no client certificate, a
//     fresh agent per request (no shared sessions), proxies not consulted;
//   - at most min(`size`, `maxBytes`) bytes, enforced while streaming; no
//     content encodings, so the cap counts what was sent;
//   - an overall deadline across redirects;
//   - the bytes are verified against `sha256` (then decrypted and checked
//     against `plain_sha256`) before anything is returned.
//
// It uses `node:https` rather than global `fetch`: Node's fetch cannot pin the
// resolved address without the `undici` package (its `dispatcher` option),
// and pinning is what closes DNS rebinding. Node built-ins only.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import { DEFAULT_MAX_FILE_BYTES, type FileRef, FileRefError, checkFileUri, parseFileRef, verifyAndDecrypt } from './files.js';

export const MAX_FILE_REDIRECTS = 3;
export const DEFAULT_FILE_FETCH_TIMEOUT_MS = 30_000;

export interface FetchFileRefOptions {
  /** The receiver's cap in bytes [DEFAULT_MAX_FILE_BYTES]. A reference whose `size` is larger is refused unfetched. */
  maxBytes?: number;
  /** Overall deadline, redirects included [30 s]. */
  timeoutMs?: number;
  /** When set, only these host names (exact, case-insensitive) are fetched, redirect targets included. */
  allowHosts?: readonly string[];
  /** At most MAX_FILE_REDIRECTS; lower it to follow fewer. */
  maxRedirects?: number;
  /** Extra TLS trust anchors (PEM), for a store with its own CA. */
  ca?: string | Buffer | Array<string | Buffer>;
  signal?: AbortSignal;
  /**
   * The resolver to use instead of the system's (e.g. DNS over HTTPS). Every
   * answer is still checked, and the connection pinned to a checked one; it
   * is called once per connection.
   */
  resolve?: Resolver;
  /**
   * TEST ONLY. Literal IP addresses exempt from the special-address block,
   * e.g. `['127.0.0.1']` for a local test server. Never set this from peer
   * data or configuration a peer can influence.
   */
  unsafeAllowAddresses?: readonly string[];
}

export interface FetchedFile {
  /** The verified plaintext (decrypted when the reference has `enc`). */
  bytes: Uint8Array;
  /** Which source served it: `uri` or one of `mirrors`. */
  source: string;
}

// ---------------------------------------------------------------------------
// Address classification

function v4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const o = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function v4Blocked(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 address to 8 hextets (an embedded dotted IPv4 tail included); null if malformed. */
function v6Hextets(ip: string): number[] | null {
  if (ip.includes('%')) return null; // zone IDs only make sense for link-local
  let head = ip;
  const lastColon = ip.lastIndexOf(':');
  if (ip.slice(lastColon + 1).includes('.')) {
    const o = v4Octets(ip.slice(lastColon + 1));
    if (!o) return null;
    head = ip.slice(0, lastColon + 1) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if ([...left, ...right].some(Number.isNaN)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  return fill < 1 ? null : [...left, ...Array<number>(fill).fill(0), ...right];
}

function v4FromWords(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * True for any address a peer's URL must not reach (§7.7): private,
 * loopback, link-local, CGNAT, multicast, documentation, benchmarking and
 * reserved ranges, IPv4-mapped/compatible, NAT64, 6to4 and Teredo forms that
 * embed or tunnel to them, and anything that does not parse.
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const o = v4Octets(ip);
    return o === null || v4Blocked(o);
  }
  if (family !== 6) return true;
  const w = v6Hextets(ip);
  if (!w) return true;
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return true; // ::, ::1, IPv4-compatible (deprecated)
  if (zero(0, 5) && w[5] === 0xffff) return v4Blocked(v4FromWords(w[6], w[7])); // IPv4-mapped
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return true; // IPv4-translated
  if (w[0] === 0x64 && w[1] === 0xff9b) {
    if (zero(2, 6)) return v4Blocked(v4FromWords(w[6], w[7])); // NAT64 well-known prefix
    return true; // 64:ff9b:1::/48 local-use NAT64 and the rest of 64:ff9b::/32
  }
  if (w[0] === 0x0100 && zero(1, 4)) return true; // discard-only 100::/64
  if (w[0] === 0x2001 && w[1] < 0x0200) return true; // IETF assignments 2001::/23, Teredo 2001::/32
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x2002) return v4Blocked(v4FromWords(w[1], w[2])); // 6to4
  if (w[0] === 0x3fff && w[1] < 0x1000) return true; // documentation 3fff::/20
  if (w[0] === 0x5f00) return true; // SRv6 SIDs
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// ---------------------------------------------------------------------------
// The fetch

function fail(code: string, message: string): FileRefError {
  return new FileRefError(code, message);
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/** A `lookup` that resolves, refuses if any answer is a blocked address, and pins the connection to one checked address. */
function pinnedLookup(allowed: (ip: string) => boolean, resolve: Resolver): LookupFunction {
  return ((hostname: string, options: { family?: number | string; all?: boolean }, cb: (...args: unknown[]) => void) => {
    resolve(hostname).then(
      (addrs) => answer(null, addrs),
      (err: Error) => answer(err, []),
    );
    function answer(err: Error | null, addrs: LookupAddress[]) {
      if (err) return cb(err instanceof FileRefError ? err : fail('dns', 'host did not resolve'));
      if (!Array.isArray(addrs) || addrs.length === 0) return cb(fail('dns', 'host has no address'));
      if (addrs.some((a) => typeof a?.address !== 'string' || isIP(a.address) === 0)) return cb(fail('dns', 'resolver answered a non-address'));
      addrs = addrs.map((a) => ({ address: a.address, family: isIP(a.address) }));
      if (addrs.some((a) => !allowed(a.address))) return cb(fail('blocked-address', 'host resolves to a private or reserved address'));
      const fam = options?.family === 6 || options?.family === 'IPv6' ? 6 : options?.family === 4 || options?.family === 'IPv4' ? 4 : 0;
      const pick = addrs.find((a) => fam === 0 || a.family === fam) ?? addrs[0];
      if (options?.all) cb(null, [pick]);
      else cb(null, pick.address, pick.family);
    }
  }) as unknown as LookupFunction;
}

/** Resolves a host name to every address it has. */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
  );

function mapError(e: Error, signal: AbortSignal): FileRefError {
  if (e instanceof FileRefError) return e;
  if (signal.aborted) return fail('timeout', 'fetch timed out or was aborted');
  const code = (e as NodeJS.ErrnoException).code;
  return fail('network', `fetch failed (${typeof code === 'string' ? code.replace(/[^A-Z0-9_]/g, '') : 'error'})`);
}

interface Hop {
  status: number;
  location?: string;
  bytes?: Uint8Array;
}

function getOnce(
  u: URL,
  limit: number,
  size: number,
  allowed: (ip: string) => boolean,
  opts: FetchFileRefOptions,
  signal: AbortSignal,
): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const host = bareHost(u);
    if (isIP(host) && !allowed(host)) return reject(fail('blocked-address', 'URL host is a private or reserved address'));
    let settled = false;
    const done = (err: Error | null, hop?: Hop) => {
      if (settled) return;
      settled = true;
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(hop!);
    };
    const checkSocket = (s: Socket | null | undefined) => {
      const ip = s?.remoteAddress;
      if (ip !== undefined && !allowed(ip)) done(fail('blocked-address', 'connected to a private or reserved address'));
    };
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port: u.port === '' ? 443 : Number(u.port),
        path: u.pathname + u.search,
        method: 'GET',
        // No Cookie, no Authorization; identity encoding so the cap counts wire bytes.
        headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'rendezvous-file-fetch/1' },
        agent: false, // a fresh agent: no pooled sockets, no TLS session reuse across fetches
        lookup: pinnedLookup(allowed, opts.resolve ?? systemResolver),
        ca: opts.ca,
        signal,
        maxHeaderSize: 16 * 1024,
      },
      (res: IncomingMessage) => {
        checkSocket(res.socket);
        if (settled) return void res.destroy();
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const loc = res.headers.location;
          return done(null, { status, location: typeof loc === 'string' ? loc : undefined });
        }
        if (status !== 200) {
          res.resume();
          return done(fail('http-status', `server answered ${status}`));
        }
        const encoding = res.headers['content-encoding'];
        if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
          return done(fail('encoded', 'server sent a content encoding'));
        }
        const declared = res.headers['content-length'];
        if (declared !== undefined) {
          const n = Number(declared);
          if (!Number.isSafeInteger(n) || n > limit) return done(fail('too-large', 'file is larger than the cap'));
          if (n !== size) return done(fail('size-mismatch', 'file length differs from the reference'));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > limit) return done(fail('too-large', 'file is larger than the cap'));
          chunks.push(chunk);
        });
        res.on('end', () => done(null, { status, bytes: new Uint8Array(Buffer.concat(chunks, total)) }));
        res.on('error', (e) => done(mapError(e, signal)));
        res.on('aborted', () => done(mapError(new Error('aborted'), signal)));
      },
    );
    req.on('socket', (s: Socket) => s.once('connect', () => checkSocket(s)));
    req.on('error', (e: Error) => done(mapError(e, signal)));
    req.end();
  });
}

async function fetchOne(
  start: string,
  ref: FileRef,
  limit: number,
  allowed: (ip: string) => boolean,
  opts: FetchFileRefOptions,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const maxRedirects = Math.min(MAX_FILE_REDIRECTS, Math.max(0, opts.maxRedirects ?? MAX_FILE_REDIRECTS));
  const hosts = opts.allowHosts ? new Set(opts.allowHosts.map((h) => h.toLowerCase())) : undefined;
  let current = start;
  for (let hop = 0; ; hop++) {
    const checked = checkFileUri(current);
    if (!checked.ok) throw fail('bad-uri', `refused URL: ${checked.reason}`);
    if (hosts && !hosts.has(bareHost(checked.value))) throw fail('host-not-allowed', 'host is not in allowHosts');
    const res = await getOnce(checked.value, limit, ref.size, allowed, opts, signal);
    if (res.bytes) return res.bytes;
    if (res.location === undefined) throw fail('http-status', 'redirect without a location');
    if (hop >= maxRedirects) throw fail('too-many-redirects', `more than ${maxRedirects} redirects`);
    let next: URL;
    try {
      next = new URL(res.location, checked.value);
    } catch {
      throw fail('bad-uri', 'redirect location is not a URL');
    }
    current = next.href;
  }
}

/**
 * Fetches a file reference over https under the §7.7 rules (see the module
 * comment) and returns the verified plaintext. Tries `uri`, then each mirror,
 * until one verifies; throws the last `FileRefError` otherwise. Only call it
 * for a reference the owner's agent chose to fetch, never on arrival.
 */
export async function fetchFileRef(input: FileRef, opts: FetchFileRefOptions = {}): Promise<FetchedFile> {
  const parsed = parseFileRef(input);
  if (!parsed.ok) throw fail('malformed', `bad file reference: ${parsed.reason}`);
  const ref = parsed.value;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw fail('bad-option', 'maxBytes must be a non-negative integer');
  if (ref.size > maxBytes) throw fail('too-large', 'file is larger than the cap');
  const sources = [ref.uri, ...(ref.mirrors ?? [])].filter((s): s is string => s !== undefined);
  if (sources.length === 0) throw fail('no-uri', 'reference offers only a direct transfer');

  const exempt = new Set(opts.unsafeAllowAddresses ?? []);
  const allowed = (ip: string) => exempt.has(ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')) || !isBlockedAddress(ip);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FILE_FETCH_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;

  let last: FileRefError = fail('no-uri', 'no source tried');
  for (const source of sources) {
    if (signal.aborted) throw fail('timeout', 'fetch timed out or was aborted');
    try {
      const bytes = await fetchOne(source, ref, ref.size, allowed, opts, signal);
      return { bytes: verifyAndDecrypt(ref, bytes), source };
    } catch (e) {
      last = e instanceof FileRefError ? e : fail('network', 'fetch failed');
      if (last.code === 'timeout') throw last;
    }
  }
  throw last;
}
