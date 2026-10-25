// A local HTTPS file store for tests (SPEC §7.7): serves what a test puts at a
// path, with a self-signed certificate generated per run, so no key material
// is checked in. Exported from `@rendezvous/core/testing` so the CLI and MCP
// tests can upload a file "anywhere" and have a peer fetch it, without network.
//
// The fetch helper refuses 127.0.0.1 by default; a test passes this server's
// `ca` and `unsafeAllowAddresses: ['127.0.0.1']` explicitly.
import { generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';

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

/** A minimal self-signed X.509 certificate (ECDSA P-256) for localhost and 127.0.0.1, DER by hand. */
export function selfSignedCert(): { key: string; cert: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algo = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('rendezvous test')))));
  const san = seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, 0x27])),
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

export interface TestFileServer {
  /** `https://127.0.0.1:<port>` */
  base: string;
  /** The certificate to trust (`ca` of the fetch options). */
  ca: string;
  /** Serve `bytes` at `path` (starting with `/`); returns its URL. */
  put(path: string, bytes: Uint8Array): string;
  /** Every request: path and headers (to check that no credentials were sent). */
  seen: Array<{ path: string; headers: IncomingHttpHeaders }>;
  close(): Promise<void>;
}

export async function startTestFileServer(): Promise<TestFileServer> {
  const { key, cert } = selfSignedCert();
  const files = new Map<string, Uint8Array>();
  const seen: TestFileServer['seen'] = [];
  const server = createServer({ key, cert }, (req, res) => {
    const path = new URL(req.url ?? '/', 'https://127.0.0.1').pathname;
    seen.push({ path, headers: req.headers });
    const body = files.get(path);
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    ca: cert,
    seen,
    put(path, bytes) {
      files.set(path, bytes);
      return `${base}${path}`;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
