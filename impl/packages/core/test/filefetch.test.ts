// fetchFileRef against a local HTTPS server (SPEC §7.7, issue #26). The TLS
// certificate is generated per run, so no key material is checked in.
import { generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileRefError,
  encryptFile,
  fetchFileRef,
  plainFileRef,
  utf8ToBytes,
  type FetchFileRefOptions,
  type FileRef,
} from '../src/index.js';

// --- a minimal self-signed X.509 certificate (ECDSA P-256), DER by hand -----
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let len: Buffer;
  if (body.length < 128) len = Buffer.from([body.length]);
  else {
    const b: number[] = [];
    for (let n = body.length; n > 0; n >>= 8) b.unshift(n & 0xff);
    len = Buffer.from([0x80 | b.length, ...b]);
  }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
function oid(s: string): Buffer {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const t = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) t.unshift((x & 0x7f) | 0x80);
    out.push(...t);
  }
  return der(0x06, Buffer.from(out));
}
function selfSigned(): { key: string; cert: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algo = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('rendezvous test')))));
  const san = seq(der(0x82, Buffer.from('localhost')), der(0x82, Buffer.from('files.test')), der(0x87, Buffer.from([127, 0, 0, 1])));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, 0x26])),
    algo,
    name,
    seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('491231235959Z'))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(seq(oid('2.5.29.17'), der(0x04, san)))),
  );
  const cert = seq(tbs, algo, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: pem };
}

// --- the server ------------------------------------------------------------
const plain = utf8ToBytes('The microsite copy John asked Omer to review.');
const { ciphertext, ref: encRef } = encryptFile(plain);
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
let server: Server;
let base = '';
let port = 0;
let ca = '';

function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  seen.push({ path: url.pathname, headers: req.headers });
  const go = (status: number, location: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { location, ...extra });
    res.end();
  };
  switch (url.pathname) {
    case '/file':
      res.writeHead(200, { 'content-length': String(ciphertext.length) });
      return res.end(ciphertext);
    case '/chunked': // no content-length: the cap must hold while streaming
      res.writeHead(200);
      res.write(ciphertext);
      res.write(Buffer.alloc(64 * 1024, 1));
      return res.end();
    case '/endless': {
      res.writeHead(200);
      const pump = () => {
        if (!res.destroyed && res.write(Buffer.alloc(16 * 1024, 2))) setImmediate(pump);
        else if (!res.destroyed) res.once('drain', pump);
      };
      return pump();
    }
    case '/biglen':
      res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
      return res.end();
    case '/gzip':
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(ciphertext.length) });
      return res.end(ciphertext);
    case '/slow':
      return; // never answers
    case '/missing':
      res.writeHead(404);
      return res.end();
    case '/cookie': // sets a cookie and redirects: the next hop must not carry it
      return go(302, '/file', { 'set-cookie': 'session=omer-secret; Path=/' });
    case '/to-private':
      return go(302, 'https://10.0.0.1/file');
    case '/to-metadata':
      return go(307, 'https://169.254.169.254/latest/meta-data/');
    case '/to-other-loopback':
      return go(302, `https://127.0.0.2:${port}/file`);
    case '/to-mapped':
      return go(302, `https://[::ffff:7f00:1]:${port}/file`);
    case '/to-localhost':
      return go(302, `https://localhost:${port}/file`);
    case '/to-http':
      return go(302, `http://127.0.0.1:${port}/file`);
    case '/to-file':
      return go(302, 'file:///etc/passwd');
    case '/hop': {
      const n = Number(url.searchParams.get('n'));
      return n <= 0 ? go(302, '/file') : go(302, `/hop?n=${n - 1}`);
    }
  }
  res.writeHead(500);
  res.end();
}

beforeAll(async () => {
  const tls = selfSigned();
  ca = tls.cert;
  server = createServer({ key: tls.key, cert: tls.cert }, route);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `https://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const local: FetchFileRefOptions = { get ca() { return ca; }, unsafeAllowAddresses: ['127.0.0.1'], timeoutMs: 5000 };
const at = (path: string, ref: Partial<FileRef> = {}): FileRef => ({ ...encRef, uri: base + path, ...ref });

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FileRefError) return e.code;
    throw e;
  }
  throw new Error('expected the fetch to fail');
}

function requestsTo(path: string): number {
  return seen.filter((s) => s.path === path).length;
}

describe('fetchFileRef', () => {
  it('fetches, verifies and decrypts, with the test-only allow for 127.0.0.1', async () => {
    const got = await fetchFileRef(at('/file'), local);
    expect(got.bytes).toEqual(plain);
    expect(got.source).toBe(base + '/file');
  });

  it('blocks 127.0.0.1 by default, before connecting', async () => {
    const before = requestsTo('/file');
    expect(await failure(fetchFileRef(at('/file'), { ca, timeoutMs: 5000 }))).toBe('blocked-address');
    expect(requestsTo('/file')).toBe(before);
  });

  it('blocks a host name that resolves to loopback (resolve, then check)', async () => {
    expect(await failure(fetchFileRef({ ...encRef, uri: `https://localhost:${port}/file` }, { ca, timeoutMs: 5000 }))).toBe('blocked-address');
  });

  it('refuses a resolver answer with any blocked address, and pins to the checked one', async () => {
    const calls: string[] = [];
    const resolve = async (host: string) => {
      calls.push(host);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    const got = await fetchFileRef({ ...encRef, uri: `https://files.test:${port}/file` }, { ...local, resolve });
    expect(got.bytes).toEqual(plain);
    expect(calls).toEqual(['files.test']); // one resolution, used for the connection itself
    const mixed = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ];
    expect(await failure(fetchFileRef({ ...encRef, uri: `https://files.test:${port}/file` }, { ...local, resolve: mixed }))).toBe('blocked-address');
    const rebound = async () => [{ address: '169.254.169.254', family: 4 }];
    expect(await failure(fetchFileRef({ ...encRef, uri: `https://files.test:${port}/file` }, { ...local, resolve: rebound }))).toBe('blocked-address');
  });

  it.each([
    ['a private IP', '/to-private'],
    ['the cloud metadata address', '/to-metadata'],
    ['another loopback address', '/to-other-loopback'],
    ['an IPv4-mapped loopback', '/to-mapped'],
    ['a name that resolves to loopback', '/to-localhost'],
  ])('refuses a redirect to %s', async (_label, path) => {
    expect(await failure(fetchFileRef(at(path), local))).toBe('blocked-address');
  });

  it('refuses redirects to http and file URLs', async () => {
    const before = requestsTo('/file');
    expect(await failure(fetchFileRef(at('/to-http'), local))).toBe('bad-uri');
    expect(await failure(fetchFileRef(at('/to-file'), local))).toBe('bad-uri');
    expect(requestsTo('/file')).toBe(before);
  });

  it('follows at most 3 redirects', async () => {
    expect((await fetchFileRef(at('/hop?n=2'), local)).bytes).toEqual(plain); // 3 redirects
    expect(await failure(fetchFileRef(at('/hop?n=3'), local))).toBe('too-many-redirects');
    expect(await failure(fetchFileRef(at('/hop?n=0'), { ...local, maxRedirects: 0 }))).toBe('too-many-redirects');
  });

  it('sends no cookies or credentials, even after a Set-Cookie', async () => {
    seen.length = 0;
    expect((await fetchFileRef(at('/cookie'), local)).bytes).toEqual(plain);
    expect(seen.map((s) => s.path)).toEqual(['/cookie', '/file']);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers['proxy-authorization']).toBeUndefined();
      expect(headers['accept-encoding']).toBe('identity');
    }
    expect(await failure(fetchFileRef({ ...encRef, uri: `https://omer:pw@127.0.0.1:${port}/file` }, local))).toBe('malformed');
  });

  it('enforces the size cap: by size, by Content-Length, and mid-stream', async () => {
    expect(await failure(fetchFileRef(at('/file'), { ...local, maxBytes: ciphertext.length - 1 }))).toBe('too-large');
    expect(await failure(fetchFileRef(at('/biglen'), local))).toBe('too-large');
    expect(await failure(fetchFileRef(at('/chunked'), local))).toBe('too-large');
    const started = Date.now();
    expect(await failure(fetchFileRef(at('/endless'), local))).toBe('too-large');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('times out', async () => {
    const started = Date.now();
    expect(await failure(fetchFileRef(at('/slow'), { ...local, timeoutMs: 300 }))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('fails the file on a hash mismatch', async () => {
    const wrong = plainFileRef(ciphertext);
    wrong.sha256 = 'cd'.repeat(32);
    expect(await failure(fetchFileRef({ ...wrong, uri: base + '/file' }, local))).toBe('hash-mismatch');
    const otherFile = encryptFile(plain).ref; // same length, other key and hash
    expect(await failure(fetchFileRef({ ...otherFile, uri: base + '/file' }, local))).toBe('hash-mismatch');
  });

  it('refuses a content encoding, a non-200 answer, and an untrusted certificate', async () => {
    expect(await failure(fetchFileRef(at('/gzip'), local))).toBe('encoded');
    expect(await failure(fetchFileRef(at('/missing'), local))).toBe('http-status');
    expect(await failure(fetchFileRef(at('/file'), { ...local, ca: undefined }))).toBe('network');
  });

  it('falls back to a mirror, and honours allowHosts', async () => {
    const got = await fetchFileRef(at('/missing', { mirrors: [base + '/file'] }), local);
    expect(got.source).toBe(base + '/file');
    expect(await failure(fetchFileRef(at('/file'), { ...local, allowHosts: ['files.example.com'] }))).toBe('host-not-allowed');
    expect((await fetchFileRef(at('/file'), { ...local, allowHosts: ['127.0.0.1'] })).bytes).toEqual(plain);
  });

  it('refuses a reference with no URL, or one that is malformed, without fetching', async () => {
    const { uri: _u, ...p2pOnly } = at('/file');
    expect(await failure(fetchFileRef({ ...p2pOnly, p2p: ['webrtc-datachannel/1'] }, local))).toBe('no-uri');
    expect(await failure(fetchFileRef({ ...encRef, uri: `http://127.0.0.1:${port}/file` }, local))).toBe('malformed');
  });
});
