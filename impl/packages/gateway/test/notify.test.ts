// Outbound notifications (NOTES 106): signed webhooks per agent, at least
// once, from a persisted outbox. The signature vector is fixed (computed
// independently: Python hmac), so a receiver in any language can check
// against it. Delivery runs against a local receiver: 2xx delivers, 429/5xx
// and network errors are retried, any other answer is a dead letter; the
// outbox survives a restart; an invite's expiry is sent once; one agent's
// events never reach another's URL or another identity's receiver; private
// addresses are refused unless the owner allowed them; the state file is
// schema-checked and fails closed.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEvents, Home, initHome } from '@rendezvous/cli/lib';
import { agentIdFromPublicKey, generateKey } from '@rendezvous/core';
import { startTestRelay } from '@rendezvous/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addressAllowed,
  AgentRoot,
  checkInsecureHost,
  checkNotifyUrl,
  classifyStatus,
  DEAD_LETTER_MAX,
  DEAD_LETTER_PER_AGENT,
  type DeadLetter,
  embeddedV4,
  eventBody,
  eventData,
  Gateway,
  Notifier,
  type NotifierOptions,
  NotifyStore,
  OUTBOX_PER_AGENT,
  parseSecret,
  postWebhook,
  rdvSignature,
  readSecretFile,
  receiverName,
  ROOT_BINDING,
  SECRET_OVERLAP_MS,
  secretFileName,
  signatureHeader,
  validateNotifyData,
  verifyRdvSignature,
} from '../src/index.js';
import { PIN } from './helpers.js';

const BIN = fileURLToPath(new URL('../dist/src/bin.js', import.meta.url));
const SECRET = 'rdv-test-secret-0123456789abcdef';
const SECRET2 = 'rdv-test-secret-2-fedcba9876543210';
const PEER = 'rdv1:' + 'a'.repeat(52);
const PEER2 = 'rdv1:' + 'b'.repeat(51) + 'a';
const KEY = Buffer.from(SECRET);

let dirs: string[] = [];
let servers: Server[] = [];
let notifiers: Notifier[] = [];
let gws: Gateway[] = [];
afterEach(async () => {
  for (const n of notifiers) await n.close();
  for (const g of gws) await g.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  servers = [];
  notifiers = [];
  gws = [];
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'rdv-gw-notify-'));
  dirs.push(d);
  return d;
};

function secretFile(dir: string, value = SECRET, name = 'owner-copy.secret'): string {
  const p = join(dir, name);
  writeFileSync(p, `${value}\n`);
  chmodSync(p, 0o600);
  return p;
}

const evt = (n: number) => `evt_${n.toString(16).padStart(32, '0')}`;

interface Hit {
  headers: IncomingHttpHeaders;
  body: string;
  path: string;
}

/** A receiver on 127.0.0.1 that answers each request with the next status of `statuses` (then 200). */
async function receiver(statuses: number[] = []): Promise<{ url: string; hits: Hit[]; statuses: number[] }> {
  const hits: Hit[] = [];
  const s = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ headers: req.headers, body, path: req.url ?? '' });
      const st = statuses.length ? statuses.shift()! : 200;
      res.writeHead(st, st >= 300 && st < 400 ? { location: 'http://127.0.0.1:1/elsewhere' } : {});
      res.end('ok');
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`, hits, statuses };
}

type Agent = { name: string; home: Home; binding: string; id: string };

/** A gateway root with agents/<name>/ for each name (ids only: nothing listens). */
async function agents(names: string[]): Promise<{ root: string; list: Agent[] }> {
  const root = tmp();
  const list = [];
  for (const name of names) {
    const home = new Home(join(root, 'agents', name));
    const r = await initHome(home, { profile: name, emails: [`${name}@example.com`] });
    list.push({ name, home, binding: name, id: r.id });
  }
  return { root, list };
}

function notifier(store: NotifyStore, list: NotifierOptions['agents'], clock: { t: number }, log: string[] = [], extra: Partial<NotifierOptions> = {}): Notifier {
  const n = new Notifier({ store, agents: list, log: (l) => log.push(l), now: () => clock.t, tickMs: 3_600_000, sweepMs: 0, settleMs: 5, baseDelayMs: 1000, ...extra });
  notifiers.push(n);
  return n;
}

/** One round: queue, sweep, send; then wait for the sends and their writes. */
async function round(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

const local = (url: string, events: string[] = ['invite_redeemed']) => ({ url, events: events as never[], insecureHosts: ['127.0.0.1'] });

const redeemed = (inviteId = '0123456789abcdef', extra: Record<string, unknown> = {}) => ({
  event: 'invite-redeemed',
  invite_id: inviteId,
  invite_label: 'Dana',
  peer: PEER,
  fingerprint: 'x',
  label: 'Dana',
  tier: 'friend',
  binding: 'claimed',
  ...extra,
});

const dead = (n: number, agent: string, agentId: string): DeadLetter => ({ id: evt(n), agent, agentId, event: 'invite_redeemed', body: '{}', attempts: 1, first: 0, next: 0, deadAt: '2026-11-01T00:00:00.000Z', reason: 'x' });

describe('signature', () => {
  it('matches the fixed vector, and the receiver helper verifies it', () => {
    const body = '{"v":1,"id":"evt_00","event":"invite_redeemed"}';
    expect(rdvSignature(SECRET, 1700000000, body)).toBe('e55b0f7eb9b3378f13cae1cb9993dfd604eeec9b3301dcb7af6e5a82c2dc8276');
    const h = signatureHeader(SECRET, body, 1700000000);
    expect(h).toBe('t=1700000000,v1=e55b0f7eb9b3378f13cae1cb9993dfd604eeec9b3301dcb7af6e5a82c2dc8276');
    expect(verifyRdvSignature(SECRET, h, body, { now: 1700000000 })).toBe(true);
    expect(verifyRdvSignature(KEY, h, Buffer.from(body), { now: 1700000299 })).toBe(true);
    // Too old, too far ahead, another body, another secret.
    expect(verifyRdvSignature(SECRET, h, body, { now: 1700000301 })).toBe(false);
    expect(verifyRdvSignature(SECRET, h, body, { now: 1699999699 })).toBe(false);
    expect(verifyRdvSignature(SECRET, h, body.replace('00', '01'), { now: 1700000000 })).toBe(false);
    expect(verifyRdvSignature('another-secret-0123456789', h, body, { now: 1700000000 })).toBe(false);
    for (const bad of [undefined, '', 'v1=abc', 't=1700000000', 't=x,v1=' + 'a'.repeat(64), 't=1700000000,t=1700000000,v1=' + 'a'.repeat(64), 'garbage']) {
      expect(verifyRdvSignature(SECRET, bad, body, { now: 1700000000 }), String(bad)).toBe(false);
    }
    // Rotation: the gateway sends the new secret's v1 first, the old one's second; a receiver on either secret, or holding both, accepts.
    const both = signatureHeader([SECRET2, SECRET], body, 1700000000);
    expect(both).toBe(`t=1700000000,v1=${rdvSignature(SECRET2, 1700000000, body)},v1=${rdvSignature(SECRET, 1700000000, body)}`);
    expect(verifyRdvSignature(SECRET, both, body, { now: 1700000000 })).toBe(true);
    expect(verifyRdvSignature(SECRET2, both, body, { now: 1700000000 })).toBe(true);
    expect(verifyRdvSignature([SECRET2, SECRET], h, body, { now: 1700000000 })).toBe(true);
    expect(verifyRdvSignature(['x'.repeat(20)], both, body, { now: 1700000000 })).toBe(false);
  });

  it('reads the secret as ASCII bytes from a file only its owner can read; a BOM or UTF-16 is refused', () => {
    const d = tmp();
    const p = secretFile(d);
    expect(readSecretFile(p).toString('latin1')).toBe(SECRET);
    // Only ASCII white space is trimmed.
    expect(parseSecret(Buffer.from(`\t ${SECRET} \r\n`), 'x').toString()).toBe(SECRET);
    expect(() => parseSecret(Buffer.from(` ${SECRET}`), 'x')).toThrow(/printable ASCII/);
    expect(() => parseSecret(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SECRET)]), 'x')).toThrow(/byte-order mark.*WriteAllText/);
    expect(() => parseSecret(Buffer.from(`﻿${SECRET}`, 'utf16le'), 'x')).toThrow(/UTF-16/);
    expect(() => parseSecret(Buffer.from(SECRET, 'utf16le'), 'x')).toThrow(/UTF-16/);
    writeFileSync(join(d, 'short'), 'abc');
    chmodSync(join(d, 'short'), 0o600);
    expect(() => readSecretFile(join(d, 'short'))).toThrow(/shorter than/);
    expect(() => readSecretFile(join(d, 'missing'))).toThrow(/cannot be read/);
    if (process.platform !== 'win32') {
      chmodSync(p, 0o640);
      expect(() => readSecretFile(p)).toThrow(/may be read by others/);
    }
  });

  it('notify set copies the secret into the root under a fixed name; a new one keeps the old signing for 24 h', async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver();
    const store = new NotifyStore(new Home(root));
    const t0 = Date.now();
    await store.set('omer', local(rcv.url), readSecretFile(secretFile(root)), 0, new Date(t0));
    const kept = join(root, secretFileName('omer'));
    expect(secretFileName(ROOT_BINDING)).toBe('notify-_root.secret');
    expect(readFileSync(kept, 'utf8')).toBe(SECRET);
    if (process.platform !== 'win32') expect((await import('node:fs')).statSync(kept).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, 'gateway-notify.json'), 'utf8')).not.toContain(SECRET);
    // The same secret again: no rotation.
    await store.set('omer', local(rcv.url), Buffer.from(SECRET), 0, new Date(t0));
    expect(store.config('omer')?.previousUntil).toBeUndefined();
    // A new secret: the old one signs too (second), for 24 h.
    await store.set('omer', local(rcv.url), Buffer.from(SECRET2), 0, new Date(t0));
    expect(store.config('omer')?.previousUntil).toBe(new Date(t0 + SECRET_OVERLAP_MS).toISOString());
    const clock = { t: t0 };
    const n = notifier(store, list, clock);
    await appendEvents(list[0].home, [redeemed()]);
    await round(n);
    const h = rcv.hits[0];
    const sig = h.headers['x-rdv-signature'] as string;
    expect(sig.split(',v1=')).toHaveLength(3);
    expect(verifyRdvSignature(SECRET, sig, h.body, { now: Math.floor(clock.t / 1000) })).toBe(true);
    expect(verifyRdvSignature(SECRET2, sig, h.body, { now: Math.floor(clock.t / 1000) })).toBe(true);
    // After the 24 h, the new secret alone.
    clock.t = t0 + SECRET_OVERLAP_MS + 1000;
    await appendEvents(list[0].home, [redeemed('fedcba9876543210')]);
    await round(n);
    const sig2 = rcv.hits[1].headers['x-rdv-signature'] as string;
    expect(sig2.split(',v1=')).toHaveLength(2);
    expect(verifyRdvSignature(SECRET, sig2, rcv.hits[1].body, { now: Math.floor(clock.t / 1000) })).toBe(false);
    expect(verifyRdvSignature(SECRET2, sig2, rcv.hits[1].body, { now: Math.floor(clock.t / 1000) })).toBe(true);
    // Its 24 h over, the previous secret is deleted from disk.
    expect(existsSync(`${kept}.prev`)).toBe(false);
    // clear deletes both secret files.
    await store.set('omer', local(rcv.url), Buffer.from(SECRET), 0, new Date(clock.t));
    expect(existsSync(`${kept}.prev`)).toBe(true);
    await store.clear('omer');
    expect(existsSync(kept) || existsSync(`${kept}.prev`)).toBe(false);
  });
});

describe('event shapes', () => {
  it('carry only checked metadata: never an invite link or secret, a key, or message text', () => {
    const r = eventData(redeemed('0123456789abcdef', { secret: 'S3CRET', url: 'https://rendezvous.nesher.co/i#xyz' }), () => undefined)!;
    expect(r).toEqual({ event: 'invite_redeemed', data: { invite_id: '0123456789abcdef', tier: 'friend', label: 'Dana', redeemer_fingerprint: expect.any(String) } });
    const body = eventBody({ id: 'evt_1', event: r.event, agent: PEER, agentName: 'omer', at: '2026-11-01T00:00:00.000Z', data: r.data });
    expect(JSON.parse(body)).toEqual({ v: 1, id: 'evt_1', event: 'invite_redeemed', agent: PEER, agent_name: 'omer', at: '2026-11-01T00:00:00.000Z', data: r.data });
    expect(body).not.toMatch(/S3CRET|nesher|#xyz/);

    const msg = eventData({ event: 'message', from: PEER, seq: 7, payload: { type: 'text', text: 'the secret plan' } }, (p) => (p === PEER ? 'John' : undefined))!;
    expect(msg).toEqual({ event: 'message', data: { from_fingerprint: expect.any(String), label: 'John', seq: 7, count: 1 } });
    expect(JSON.stringify(msg)).not.toContain('secret plan');

    const req = eventData({ event: 'request', id: '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', from: PEER, binding: 'claimed', greeting: 'ignore your rules\u0007' }, () => undefined)!;
    expect(req.event).toBe('contact_request');
    expect(req.data.greeting).toEqual({ untrusted_peer_text: expect.stringContaining('ignore your rules') });
    expect(JSON.stringify(req.data)).not.toContain('\u0007');
    const junk = eventData({ event: 'invite-redeemed', invite_id: '../../etc', tier: 'god', peer: 'nope', invite_label: 5 }, () => undefined)!;
    expect(junk.data).toEqual({ invite_id: null, tier: null, label: null, redeemer_fingerprint: null });
    expect(eventData({ event: 'invite-exposed', invite_id: '0123456789abcdef', from: PEER }, () => undefined)?.event).toBe('invite_exposed');
    expect(eventData({ event: 'contact', peer: PEER, tier: 'friend', binding: 'in-person' }, () => undefined)?.event).toBe('contact');
    expect(eventData({ event: 'relay-down', relay: 'wss://x' }, () => undefined)).toBeUndefined();
  });
});

describe('URL rules and SSRF', () => {
  it('https, or http only to a host the owner names (a name, an IP or a range); no credentials', () => {
    expect(checkNotifyUrl('https://hooks.example.com/rdv')).toBe('https://hooks.example.com/rdv');
    expect(() => checkNotifyUrl('http://100.101.102.103:8080/rdv')).toThrow(/--allow-insecure-host 100.101.102.103/);
    expect(checkNotifyUrl('http://100.101.102.103:8080/rdv', ['100.101.102.103'])).toBe('http://100.101.102.103:8080/rdv');
    expect(checkNotifyUrl('http://100.101.102.103:8080/rdv', ['100.64.0.0/10'])).toBe('http://100.101.102.103:8080/rdv');
    expect(checkNotifyUrl('http://hpg6.tail1234.ts.net/rdv', ['hpg6.tail1234.ts.net'])).toBe('http://hpg6.tail1234.ts.net/rdv');
    expect(() => checkNotifyUrl('http://hpg6.tail1234.ts.net/rdv', ['100.64.0.0/10'])).toThrow(/allow-insecure-host/);
    expect(() => checkNotifyUrl('https://u:p@hooks.example.com/')).toThrow(/user name or password/);
    expect(() => checkNotifyUrl('ftp://hooks.example.com/')).toThrow(/https/);
    expect(() => checkNotifyUrl('file:///etc/passwd')).toThrow(/https/);
    expect(checkInsecureHost('100.64.0.0/10')).toBe('100.64.0.0/10');
    expect(checkInsecureHost('[FD7A:115C:A1E0::]/48')).toBe('fd7a:115c:a1e0::/48');
    // IPv6 entries are stored in canonical form, so the same address is one entry and matches its own URL.
    expect(checkInsecureHost('FD7A:115C:A1E0:0:0:0:0:0/48')).toBe('fd7a:115c:a1e0::/48');
    expect(checkInsecureHost('FD7A:0115:C0A8:0000:0000:0000:0000:0001')).toBe('fd7a:115:c0a8::1');
    expect(checkNotifyUrl('http://[fd7a:115:c0a8::1]:8080/rdv', [checkInsecureHost('FD7A:0115:C0A8:0:0:0:0:1')])).toBe('http://[fd7a:115:c0a8::1]:8080/rdv');
    for (const bad of ['http://x', 'x:8080', '10.0.0.0/33', '', 'a b']) expect(() => checkInsecureHost(bad), bad).toThrow(/--allow-insecure-host/);
    // The show and log form: scheme and host only.
    expect(receiverName('https://hooks.example.com/rdv/SECRET-TOKEN?k=v')).toBe('https://hooks.example.com');
  });

  it('a range or a named host opens private addresses, never loopback, link-local or metadata (only an exact IP does)', () => {
    const range = addressAllowed('100.101.102.103', ['100.64.0.0/10']);
    expect(range('100.101.102.103')).toBe(true);
    expect(range('10.0.0.1')).toBe(false);
    expect(range('8.8.8.8')).toBe(true);
    const named = addressAllowed('box.lan', ['box.lan']);
    expect(named('192.168.1.20')).toBe(true);
    expect(named('127.0.0.1')).toBe(false);
    expect(named('169.254.169.254')).toBe(false);
    expect(named('::1')).toBe(false);
    expect(named('::ffff:127.0.0.1')).toBe(false);
    const wide = addressAllowed('x', ['0.0.0.0/0', '::/0']);
    expect(wide('127.0.0.1')).toBe(false);
    expect(wide('169.254.169.254')).toBe(false);
    expect(wide('fe80::1')).toBe(false);
    // IPv6 forms that carry a loopback or metadata IPv4 (mapped, compatible, NAT64, 6to4): refused unless named exactly.
    expect(embeddedV4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedV4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(embeddedV4('2002:7f00:1::')).toBe('127.0.0.1');
    expect(embeddedV4('::a9fe:a9fe')).toBe('169.254.169.254');
    // IPv4-translated (::ffff:0:0/96) and local-use NAT64 (64:ff9b:1::/48).
    expect(embeddedV4('::ffff:0:a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedV4('64:ff9b:1::7f00:1')).toBe('127.0.0.1');
    for (const ip of ['::ffff:0:a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '240.0.0.1', '255.255.255.255', '::ffff:255.255.255.255']) expect(wide(ip), ip).toBe(false);
    for (const ip of ['::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::169.254.169.254', '64:ff9b::7f00:1']) {
      expect(wide(ip), ip).toBe(false);
      expect(named(ip), ip).toBe(false);
      expect(addressAllowed('x', [ip])(ip), ip).toBe(true);
    }
    expect(addressAllowed('127.0.0.1', ['127.0.0.1'])('127.0.0.1')).toBe(true);
    expect(addressAllowed('169.254.169.254', ['169.254.169.254'])('169.254.169.254')).toBe(true);
  });

  it('refuses loopback, link-local and metadata addresses, and names that resolve to them, unless that host is allowed', async () => {
    const rcv = await receiver();
    const port = new URL(rcv.url).port;
    for (const url of [`https://127.0.0.1:${port}/hook`, 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://10.0.0.1/x', 'https://100.100.1.1/x']) {
      expect(await postWebhook(url, '{}', {}), url).toEqual({ error: expect.stringMatching(/private or reserved/), permanent: true });
    }
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await postWebhook(`https://hooks.evil.example:${port}/hook`, '{}', {}, { resolve })).toEqual({ error: expect.stringMatching(/private or reserved/), permanent: true });
    // Naming the host does not open loopback for it (only the exact IP does).
    expect(await postWebhook(`http://hooks.evil.example:${port}/hook`, '{}', {}, { resolve, insecureHosts: ['hooks.evil.example'] })).toEqual({ error: expect.stringMatching(/private or reserved/), permanent: true });
    expect(rcv.hits).toHaveLength(0);
    expect(await postWebhook(rcv.url, '{}', {}, { insecureHosts: ['127.0.0.1'] })).toEqual({ status: 200 });
    expect(rcv.hits).toHaveLength(1);
  });

  it('follows no redirect, and times out', async () => {
    const rcv = await receiver([302]);
    expect(await postWebhook(rcv.url, '{}', {}, { insecureHosts: ['127.0.0.1'] })).toEqual({ status: 302 });
    expect(classifyStatus(302)).toBe('permanent');
    expect(rcv.hits).toHaveLength(1);
    const slow = createServer(() => {});
    servers.push(slow);
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
    slow.on('connection', (s) => s.unref());
    const r = await postWebhook(`http://127.0.0.1:${(slow.address() as AddressInfo).port}/`, '{}', {}, { insecureHosts: ['127.0.0.1'], timeoutMs: 300 });
    expect(r).toEqual({ error: expect.stringMatching(/no answer/), permanent: false });
    slow.closeAllConnections();
  });
});

describe('the state file', () => {
  it('is schema-checked: bad JSON, a bad shape or a URL the rules refuse fails closed, also at gateway start', async () => {
    const { root } = await agents(['omer']);
    const store = new NotifyStore(new Home(root));
    const path = join(root, 'gateway-notify.json');
    const cfg = { url: 'https://hooks.example.com/rdv', events: ['invite_redeemed'], insecureHosts: [], created: '2026-11-01T00:00:00.000Z' };
    const good = { v: 1, agents: { omer: cfg }, state: {}, outbox: [], dead: [] };
    expect(validateNotifyData(good).agents.omer.url).toBe(cfg.url);
    for (const [what, data] of [
      ['json', '{not json'],
      ['version', { ...good, v: 2 }],
      ['http without allow', { ...good, agents: { omer: { ...cfg, url: 'http://10.0.0.1/rdv' } } }],
      ['bad host entry', { ...good, agents: { omer: { ...cfg, insecureHosts: ['http://x'] } } }],
      ['bad event', { ...good, agents: { omer: { ...cfg, events: ['everything'] } } }],
      ['bad binding', { ...good, agents: { '../x': cfg } }],
      ['bad item', { ...good, outbox: [{ id: 'evt_x', agent: 'omer' }] }],
      ['outbox not a list', { ...good, outbox: {} }],
    ] as const) {
      writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
      expect(() => store.read(), what).toThrow(/gateway-notify\.json/);
    }
    // A gateway refuses to start on it; a notifier tick logs it once and does not throw.
    const gw = new Gateway({ home: new Home(root), port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    gws.push(gw);
    await gw.store.setPin(PIN);
    await expect(gw.start()).rejects.toThrow(/notifications: .*gateway-notify\.json/);
    const log: string[] = [];
    const n = notifier(store, [], { t: Date.now() }, log);
    await n.tick();
    await n.tick();
    expect(log.filter((l) => l.includes('gateway-notify.json'))).toHaveLength(1);
  });
});

describe('delivery', () => {
  it('classifies answers: 2xx delivered, 429 and 5xx retried, any other 4xx dropped', () => {
    for (const s of [200, 201, 204]) expect(classifyStatus(s)).toBe('delivered');
    for (const s of [429, 500, 502, 503, 504]) expect(classifyStatus(s)).toBe('retry');
    for (const s of [400, 401, 403, 404, 410, 413, 301, 100]) expect(classifyStatus(s)).toBe('permanent');
  });

  it('signs each POST, retries 5xx and 429 with the same id and body, and drops a 4xx to the dead letters', async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver([503, 429]);
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(rcv.url), KEY, 0);
    const clock = { t: Date.now() };
    const log: string[] = [];
    const n = notifier(store, list, clock, log);
    await appendEvents(list[0].home, [redeemed()]);
    await round(n);
    expect(rcv.hits).toHaveLength(1);
    await round(n);
    expect(rcv.hits).toHaveLength(1);
    clock.t += 60_000;
    await round(n);
    clock.t += 60_000;
    await round(n);
    expect(rcv.hits).toHaveLength(3);
    expect(store.read().outbox).toHaveLength(0);
    const [a, b, c] = rcv.hits;
    expect(new Set([a.body, b.body, c.body]).size).toBe(1);
    const body = JSON.parse(c.body);
    expect(body).toMatchObject({ v: 1, event: 'invite_redeemed', agent: list[0].id, agent_name: 'omer', data: { invite_id: '0123456789abcdef', tier: 'friend', label: 'Dana' } });
    expect(body.id).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(c.headers['content-type']).toBe('application/json');
    expect(verifyRdvSignature(SECRET, c.headers['x-rdv-signature'] as string, c.body, { now: Math.floor(clock.t / 1000) })).toBe(true);
    expect(log.join('\n')).not.toContain(SECRET);
    expect(log.join('\n')).not.toContain('/hook');

    rcv.statuses.push(400);
    await appendEvents(list[0].home, [redeemed('fedcba9876543210')]);
    await round(n);
    clock.t += 3_600_000;
    await round(n);
    expect(rcv.hits).toHaveLength(4);
    const dl = store.deadLetters('omer', list[0].id);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ event: 'invite_redeemed', reason: 'the receiver answered 400', attempts: 1, agentId: list[0].id });
    expect(store.read().outbox).toHaveLength(0);

    expect(await store.retryDead('omer', list[0].id, clock.t)).toEqual({ queued: 1, refused: 0 });
    await round(n);
    expect(rcv.hits).toHaveLength(5);
    expect(JSON.parse(rcv.hits[4].body).id).toBe(dl[0].id);
    expect(store.deadLetters('omer', list[0].id)).toHaveLength(0);
  });

  it('gives up after 24 h of network errors: a dead letter, bounded per agent and in all', async () => {
    const { root, list } = await agents(['omer']);
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local('http://127.0.0.1:1/hook'), KEY, 0);
    const clock = { t: Date.now() };
    const n = notifier(store, list, clock);
    await appendEvents(list[0].home, [redeemed()]);
    await round(n);
    expect(store.read().outbox[0]).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/network error/) });
    for (let i = 0; i < 40 && store.read().outbox.length; i++) {
      clock.t += 3_600_000;
      await round(n);
    }
    expect(store.read().outbox).toHaveLength(0);
    expect(store.deadLetters('omer', list[0].id)[0]).toMatchObject({ reason: expect.stringMatching(/^gave up after \d+ tries: network error/) });

    // Bounded: an agent's own oldest go first; one agent's flood never evicts another's.
    await store.update((d) => {
      d.dead = [dead(1, 'kids', list[0].id)];
      for (let i = 0; i < DEAD_LETTER_MAX + 20; i++) d.dead.push(dead(100 + i, 'omer', list[0].id));
    });
    const all = store.read().dead;
    expect(all.filter((x) => x.agent === 'omer')).toHaveLength(DEAD_LETTER_PER_AGENT);
    expect(all.find((x) => x.agent === 'omer')!.id).toBe(evt(100 + DEAD_LETTER_MAX + 20 - DEAD_LETTER_PER_AGENT));
    expect(all.some((x) => x.id === evt(1))).toBe(true);
  });

  it('per-agent outbox quota: a flood from one agent ends as its own dead letters, never another agent\'s waiting events', async () => {
    const { root, list } = await agents(['kids', 'omer']);
    const store = new NotifyStore(new Home(root));
    const [kids, omer] = list;
    await store.update((d) => {
      d.outbox.push({ id: evt(1), agent: 'omer', agentId: omer.id, event: 'invite_redeemed', body: '{}', attempts: 3, first: 0, next: 9e15 });
      for (let i = 0; i < OUTBOX_PER_AGENT + 50; i++) d.outbox.push({ id: evt(1000 + i), agent: 'kids', agentId: kids.id, event: 'contact_request', body: '{}', attempts: 0, first: 0, next: 0 });
    });
    const d = store.read();
    expect(d.outbox.some((x) => x.id === evt(1))).toBe(true);
    expect(d.outbox.filter((x) => x.agent === 'kids')).toHaveLength(OUTBOX_PER_AGENT);
    expect(d.outbox.find((x) => x.agent === 'kids')!.id).toBe(evt(1050));
    expect(d.dead.every((x) => x.agent === 'kids' && x.reason === 'the outbox was full')).toBe(true);
  });

  it('a burst of requests or messages from one peer is one event with a count; deliveries go on past 4 without waiting for a tick', async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver();
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(rcv.url, ['message', 'invite_redeemed']), KEY, 0);
    const clock = { t: Date.now() };
    const n = notifier(store, list, clock);
    await round(n);
    const msgs = (from: string, k: number) => Array.from({ length: k }, (_, i) => ({ event: 'message', from, seq: i + 1, payload: { type: 'text', text: 'x' } }));
    await appendEvents(list[0].home, [...msgs(PEER, 30), ...msgs(PEER2, 5)]);
    await round(n);
    const got = rcv.hits.map((h) => JSON.parse(h.body)).sort((a, b) => b.data.count - a.data.count);
    expect(got.map((g) => g.data.count)).toEqual([30, 5]);
    expect(got[0].data.seq).toBe(1);
    expect(verifyRdvSignature(SECRET, rcv.hits[0].headers['x-rdv-signature'] as string, rcv.hits[0].body)).toBe(true);
    // Ten distinct events: all go out in one tick (dispatch runs again as each one ends).
    await appendEvents(list[0].home, Array.from({ length: 10 }, (_, i) => redeemed(`${i}`.padStart(16, 'a'))));
    await round(n);
    expect(rcv.hits).toHaveLength(12);
    expect(store.read().outbox).toHaveLength(0);
  });

  it('the outbox survives a restart: an event queued while the receiver was down is sent by the next process', async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver([500]);
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(rcv.url), KEY, 0);
    const clock = { t: Date.now() };
    const first = notifier(store, list, clock);
    await appendEvents(list[0].home, [redeemed()]);
    await round(first);
    await first.close();
    const id = store.read().outbox[0].id;
    expect(rcv.hits).toHaveLength(1);
    clock.t += 60_000;
    const second = notifier(new NotifyStore(new Home(root)), list, clock);
    await round(second);
    await round(second);
    expect(rcv.hits).toHaveLength(2);
    expect(JSON.parse(rcv.hits[1].body).id).toBe(id);
    expect(store.read().outbox).toHaveLength(0);
  });

  it('starts at the end of the log (history is never sent) and sends only subscribed events', async () => {
    const { root, list } = await agents(['omer']);
    await appendEvents(list[0].home, [redeemed('1111111111111111')]);
    const rcv = await receiver();
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(rcv.url, ['invite_redeemed', 'invite_exposed']), KEY, 0);
    await store.update((d) => {
      delete d.state.omer;
    });
    const clock = { t: Date.now() };
    const n = notifier(store, list, clock);
    await round(n);
    await appendEvents(list[0].home, [
      { event: 'message', from: PEER, seq: 1, payload: { type: 'text', text: 'hi' } },
      { event: 'invite-exposed', invite_id: '2222222222222222', from: PEER },
    ]);
    await round(n);
    expect(rcv.hits.map((h) => JSON.parse(h.body).event)).toEqual(['invite_exposed']);
  });
});

describe('invite_expired', () => {
  it('is sent once per open invite that passes its expiry unused, never for used, revoked or earlier ones', async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver();
    const store = new NotifyStore(new Home(root));
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const inv = (id: string, expires: number, extra: Record<string, unknown> = {}) => ({ id, hash: 'h', created: iso(t0 - 86_400_000), expires: iso(expires), tier: 'friend', scope: {}, label: 'Dana', ...extra });
    const s = list[0].home.readAgentState();
    s.book.invites = {
      aaaaaaaaaaaaaaaa: inv('aaaaaaaaaaaaaaaa', t0 + 3_600_000),
      bbbbbbbbbbbbbbbb: inv('bbbbbbbbbbbbbbbb', t0 + 3_600_000, { used: { at: iso(t0), by: PEER, request: 'r' } }),
      cccccccccccccccc: inv('cccccccccccccccc', t0 + 3_600_000, { revoked: iso(t0) }),
      dddddddddddddddd: inv('dddddddddddddddd', t0 - 3_600_000),
    } as never;
    list[0].home.writeAgentState(s);
    await store.set('omer', local(rcv.url, ['invite_expired']), KEY, 0, new Date(t0));
    const clock = { t: t0 };
    const n = notifier(store, list, clock);
    await round(n);
    expect(rcv.hits).toHaveLength(0);
    clock.t = t0 + 2 * 3_600_000;
    await round(n);
    await round(n);
    expect(rcv.hits).toHaveLength(1);
    const body = JSON.parse(rcv.hits[0].body);
    expect(body).toMatchObject({ event: 'invite_expired', at: iso(t0 + 3_600_000), data: { invite_id: 'aaaaaaaaaaaaaaaa', tier: 'friend', label: 'Dana', expired_at: iso(t0 + 3_600_000) } });
    expect(rcv.hits[0].body).not.toContain('"h"');
    await n.close();
    const again = notifier(new NotifyStore(new Home(root)), list, clock);
    await round(again);
    expect(rcv.hits).toHaveLength(1);
    expect(store.read().state.omer.expired).toEqual(['aaaaaaaaaaaaaaaa']);
  });
});

describe('per-agent isolation', () => {
  it("agent A's events go to A's URL only, never B's; clearing A leaves B", async () => {
    const { root, list } = await agents(['kids', 'omer']);
    const ra = await receiver();
    const rb = await receiver();
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(ra.url), KEY, 0);
    await store.set('kids', local(rb.url), Buffer.from(SECRET2), 0);
    const clock = { t: Date.now() };
    const n = notifier(store, list, clock);
    const [kids, omer] = list;
    await appendEvents(omer.home, [redeemed('0000000000000001')]);
    await round(n);
    expect(ra.hits).toHaveLength(1);
    expect(rb.hits).toHaveLength(0);
    expect(JSON.parse(ra.hits[0].body)).toMatchObject({ agent: omer.id, agent_name: 'omer' });
    await appendEvents(kids.home, [redeemed('0000000000000002')]);
    await round(n);
    expect(rb.hits).toHaveLength(1);
    expect(JSON.parse(rb.hits[0].body)).toMatchObject({ agent: kids.id, agent_name: 'kids', data: { invite_id: '0000000000000002' } });
    // Each signed with its own agent's secret.
    expect(verifyRdvSignature(SECRET2, rb.hits[0].headers['x-rdv-signature'] as string, rb.hits[0].body)).toBe(true);
    expect(verifyRdvSignature(SECRET, rb.hits[0].headers['x-rdv-signature'] as string, rb.hits[0].body)).toBe(false);
    ra.statuses.push(503);
    await appendEvents(omer.home, [redeemed('0000000000000003')]);
    await round(n);
    expect(ra.hits).toHaveLength(2);
    await store.clear('omer');
    clock.t += 3_600_000;
    await round(n);
    expect(ra.hits).toHaveLength(2);
    expect(rb.hits).toHaveLength(1);
    expect(store.read().outbox).toHaveLength(0);
  });

  it("dead letters belong to an identity: another agent that takes the name never gets them, as --retry or as a send", async () => {
    const { root, list } = await agents(['kids']);
    const store = new NotifyStore(new Home(root));
    const rcv = await receiver();
    const OLD = PEER2;
    await store.set('kids', local(rcv.url), KEY, 0);
    await store.update((d) => {
      d.dead.push({ ...dead(7, 'kids', OLD), body: '{"agent":"old","data":{"label":"old private label"}}' });
      d.outbox.push({ id: evt(8), agent: 'kids', agentId: OLD, event: 'invite_redeemed', body: '{"old":1}', attempts: 0, first: 0, next: 0 });
    });
    expect(store.deadLetters('kids', list[0].id)).toEqual([]);
    expect(await store.retryDead('kids', list[0].id)).toEqual({ queued: 0, refused: 1 });
    // An item queued for the old identity is dropped, not sent to the new agent's receiver.
    const n = notifier(store, list, { t: Date.now() });
    await round(n);
    expect(rcv.hits).toHaveLength(0);
    expect(store.read().outbox).toHaveLength(0);
    // agent add / remove: clear with dead letters.
    await store.clear('kids', { dead: true });
    expect(store.read().dead).toEqual([]);
  });
});

describe('in the gateway', () => {
  it("a serving gateway posts the root agent's invite_redeemed, signed, from its own event log", { timeout: 30_000 }, async () => {
    const dir = tmp();
    const home = new Home(dir);
    const relay = await startTestRelay();
    const id = (await initHome(home, { profile: 'omer', relays: [relay.url], emails: ['omer@example.com'] })).id;
    const rcv = await receiver();
    const gw = new Gateway({ home, port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000, notify: { tickMs: 50, settleMs: 5 } });
    gws.push(gw);
    await gw.store.setPin(PIN);
    expect(new AgentRoot(dir).bindingOf('omer')).toBe(ROOT_BINDING);
    await gw.notifyStore.set(ROOT_BINDING, local(rcv.url), KEY, 0);
    expect(existsSync(join(dir, 'notify-_root.secret'))).toBe(true);
    await gw.start();
    await appendEvents(home, [redeemed()]);
    const until = Date.now() + 10_000;
    while (rcv.hits.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(rcv.hits).toHaveLength(1);
    const h = rcv.hits[0];
    expect(JSON.parse(h.body)).toMatchObject({ v: 1, event: 'invite_redeemed', agent: id, agent_name: 'omer' });
    expect(verifyRdvSignature(SECRET, h.headers['x-rdv-signature'] as string, h.body)).toBe(true);
    await gw.close();
    await relay.close();
  });
});

/** The built bin, stdin closed. */
function bin(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin!.end();
  });
}

describe('fairness and floods (re-review of PR #131)', () => {
  it("one agent's hung receiver never holds back another's: a slot per agent, agents take turns", { timeout: 30_000 }, async () => {
    const { root, list } = await agents(['alice', 'bob']);
    const good = await receiver();
    const hang = createServer(() => {}); // never answers
    servers.push(hang);
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    hang.on('connection', (s) => s.unref());
    const store = new NotifyStore(new Home(root));
    const [alice, bob] = list;
    await store.set('alice', local(good.url), KEY, 0);
    await store.set('bob', local(`http://127.0.0.1:${(hang.address() as AddressInfo).port}/`), KEY, 0);
    // Bob has 40 distinct invite events waiting (none coalesce), all due before alice's.
    await appendEvents(bob.home, Array.from({ length: 40 }, (_, i) => redeemed(`${i}`.padStart(16, 'b'))));
    const n = notifier(store, list, { t: Date.now() }, [], { timeoutMs: 1500 });
    await n.tick();
    await appendEvents(alice.home, [redeemed()]);
    const t0 = Date.now();
    await n.tick();
    while (good.hits.length === 0 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(good.hits).toHaveLength(1);
    // Well within one of bob's timeouts: alice never queued behind bob's slots.
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(JSON.parse(good.hits[0].body).agent).toBe(alice.id);
    hang.closeAllConnections();
  });

  it("a stranger flood (a new key per request) never evicts the agent's invite_redeemed: requests roll into one event", async () => {
    const { root, list } = await agents(['omer']);
    const rcv = await receiver(Array(10_000).fill(503));
    const store = new NotifyStore(new Home(root));
    await store.set('omer', local(rcv.url, ['invite_redeemed', 'contact_request']), KEY, 0);
    const clock = { t: Date.now() };
    const n = notifier(store, list, clock);
    await appendEvents(list[0].home, [redeemed()]);
    await round(n);
    const key = (_i: number) => agentIdFromPublicKey(generateKey().publicKey);
    let k = 0;
    for (let r = 0; r < 60; r++) {
      await appendEvents(
        list[0].home,
        Array.from({ length: 10 }, () => ({ event: 'request', id: '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f', from: key(k++), binding: 'claimed', greeting: 'hi' })),
      );
      clock.t += 1000;
      await round(n);
    }
    const d = store.read();
    expect(d.outbox.some((i) => i.event === 'invite_redeemed')).toBe(true);
    const req = d.outbox.filter((i) => i.event === 'contact_request');
    expect(req).toHaveLength(1);
    const body = JSON.parse(req[0].body);
    expect(body.data.count).toBe(600);
    expect(body.data.recent_fingerprints).toHaveLength(5);
    expect(body.data.from_fingerprint).toBe(body.data.recent_fingerprints[0]);
    expect(d.dead).toHaveLength(0);
  });

  it('when over its cap an agent loses requests and messages first, invites last', async () => {
    const { root, list } = await agents(['omer']);
    const store = new NotifyStore(new Home(root));
    const id = list[0].id;
    await store.update((d) => {
      d.outbox.push({ id: evt(1), agent: 'omer', agentId: id, event: 'invite_redeemed', body: '{}', attempts: 0, first: 0, next: 9e15 });
      d.outbox.push({ id: evt(2), agent: 'omer', agentId: id, event: 'contact', body: '{}', attempts: 0, first: 0, next: 9e15 });
      for (let i = 0; i < OUTBOX_PER_AGENT + 10; i++) d.outbox.push({ id: evt(100 + i), agent: 'omer', agentId: id, event: 'message', body: '{}', attempts: 0, first: 0, next: 9e15 });
      d.dead.push(dead(3, 'omer', id));
      for (let i = 0; i < DEAD_LETTER_PER_AGENT + 10; i++) d.dead.push({ ...dead(1000 + i, 'omer', id), event: 'message' });
    });
    const d = store.read();
    expect(d.outbox.map((i) => i.id)).toEqual(expect.arrayContaining([evt(1), evt(2)]));
    expect(d.outbox).toHaveLength(OUTBOX_PER_AGENT);
    expect(d.dead.some((i) => i.id === evt(3))).toBe(true);
    expect(d.dead).toHaveLength(DEAD_LETTER_PER_AGENT);
  });
});

describe('agent migrate with a webhook (re-review H1)', () => {
  it('moves the root agent, renames its secrets (also .prev) through rebind only, and keeps the webhook', { timeout: 60_000 }, async () => {
    const root = tmp();
    const id = (await initHome(new Home(root), { profile: 'omer', emails: ['omer@example.com'] })).id;
    await appendEvents(new Home(root), [redeemed()]);
    const store = new NotifyStore(new Home(root));
    await store.set(ROOT_BINDING, { url: 'https://hooks.example.com/rdv', events: ['invite_redeemed'], insecureHosts: [] }, KEY, 1);
    await store.set(ROOT_BINDING, { url: 'https://hooks.example.com/rdv', events: ['invite_redeemed'], insecureHosts: [] }, Buffer.from(SECRET2), 1);
    expect(existsSync(join(root, 'notify-_root.secret.prev'))).toBe(true);
    const m = await bin(['agent', 'migrate', '--home', root]);
    expect(m.code, m.stderr).toBe(0);
    expect(readFileSync(join(root, 'notify-omer.secret'), 'utf8')).toBe(SECRET2);
    expect(readFileSync(join(root, 'notify-omer.secret.prev'), 'utf8')).toBe(SECRET);
    expect(existsSync(join(root, 'notify-_root.secret')) || existsSync(join(root, 'notify-_root.secret.prev'))).toBe(false);
    const d = new NotifyStore(new Home(root)).read();
    expect(Object.keys(d.agents)).toEqual(['omer']);
    expect(d.state.omer.cursor).toBe(1);
    expect(new Home(join(root, 'agents', 'omer')).readAgentState().card.id).toBe(id);
    // The secrets were never copied into the agent's folder or the kept originals.
    const kept = (await import('node:fs')).readdirSync(root).find((f) => f.startsWith('.premigrate-'))!;
    for (const dir of [join(root, 'agents', 'omer'), join(root, kept)]) {
      expect((await import('node:fs')).readdirSync(dir).filter((f) => f.startsWith('notify-')), dir).toEqual([]);
    }
  });

  it('a failure halfway puts everything back as it was, and says so once', async () => {
    const root = tmp();
    await initHome(new Home(root), { profile: 'omer', emails: ['omer@example.com'] });
    const store = new NotifyStore(new Home(root));
    await store.set(ROOT_BINDING, { url: 'https://hooks.example.com/rdv', events: ['invite_redeemed'], insecureHosts: [] }, KEY, 0);
    const fs = await import('node:fs');
    const listing = () => fs.readdirSync(root).filter((f) => !/lock$/.test(f)).sort();
    const before = listing();
    const keyBefore = readFileSync(new Home(root).agentPath);
    let unbound = 0;
    await expect(
      new AgentRoot(root).migrate(
        undefined,
        async (_from, to) => {
          await store.rebind(ROOT_BINDING, to);
          throw new Error('disk full');
        },
        new Date(),
        async (_from, to) => {
          unbound++;
          await store.rebind(to, ROOT_BINDING);
        },
      ),
    ).rejects.toThrow(/^agent migrate failed \(disk full\); everything was put back as it was$/);
    expect(unbound).toBe(1);
    expect(listing()).toEqual(before);
    expect(readFileSync(new Home(root).agentPath).equals(keyBefore)).toBe(true);
    expect(existsSync(join(root, 'agents', 'omer'))).toBe(false);
    expect(Object.keys(store.read().agents)).toEqual([ROOT_BINDING]);
    expect(existsSync(join(root, 'notify-_root.secret'))).toBe(true);
  });
});

describe('rdv-gateway notify', () => {
  it('set, show, dead-letter and clear, per agent, in the gateway root', { timeout: 60_000 }, async () => {
    const { root, list } = await agents(['kids', 'omer']);
    const sf = secretFile(tmp());
    await appendEvents(list[1].home, [redeemed('9999999999999999')]);
    expect((await bin(['notify', 'set', 'omer', '--home', root, '--url', 'http://100.101.102.103:8080/rdv', '--secret-file', sf])).stderr).toMatch(/--allow-insecure-host 100.101.102.103/);
    expect((await bin(['notify', 'set', 'omer', '--home', root, '--url', 'https://hooks.example.com/rdv', '--secret-file', sf, '--events', 'invite_redeemed,nope'])).stderr).toMatch(/not nope/);
    expect((await bin(['notify', 'set', 'nobody', '--home', root, '--url', 'https://hooks.example.com/rdv', '--secret-file', sf])).stderr).toMatch(/no agent "nobody"/);
    const ok = await bin(['notify', 'set', 'omer', '--home', root, '--url', 'http://100.101.102.103:8080/rdv/TOKEN123', '--allow-insecure-host', '100.64.0.0/10', '--secret-file', sf]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stderr).toContain('invite_redeemed, invite_expired, invite_exposed');
    expect(ok.stderr).toContain('notify-omer.secret');
    expect(ok.stderr).not.toContain(SECRET);
    expect(ok.stderr).not.toContain('TOKEN123');
    // The secret is copied under the fixed name; the owner's file may go.
    rmSync(sf);
    expect(readFileSync(join(root, 'notify-omer.secret'), 'utf8')).toBe(SECRET);
    const d = new NotifyStore(new Home(root)).read();
    expect(d.agents.omer).toMatchObject({ url: 'http://100.101.102.103:8080/rdv/TOKEN123', events: ['invite_redeemed', 'invite_expired', 'invite_exposed'], insecureHosts: ['100.64.0.0/10'] });
    expect(d.state.omer.cursor).toBe(1);
    expect(readFileSync(join(root, 'gateway-notify.json'), 'utf8')).not.toContain(SECRET);
    const show = await bin(['notify', 'show', '--home', root]);
    expect(show.stdout).toMatch(/^kids {2}\(no webhook\)$/m);
    expect(show.stdout).toMatch(/^omer {2}http:\/\/100\.101\.102\.103:8080 {2}events invite_redeemed,invite_expired,invite_exposed {2}insecure hosts 100\.64\.0\.0\/10/m);
    expect(show.stdout).not.toMatch(/TOKEN123|secret/);

    const omerId = list[1].id;
    await new NotifyStore(new Home(root)).update((x) => {
      x.dead.push({ ...dead(0xdead, 'omer', omerId), attempts: 3, reason: 'the receiver answered 404' });
      x.dead.push({ ...dead(0xbeef, 'omer', PEER), reason: 'an earlier agent named omer' });
    });
    const dl = await bin(['notify', 'dead-letter', 'omer', '--home', root]);
    expect(dl.stdout).toBe(`${evt(0xdead)}  invite_redeemed  2026-11-01T00:00:00.000Z  tries 3  the receiver answered 404\n`);
    expect((await bin(['notify', 'show', 'omer', '--home', root])).stdout).toMatch(/dead letters 1$/m);
    expect((await bin(['notify', 'dead-letter', 'kids', '--home', root])).stderr).toContain('no dead letters');
    const retry = await bin(['notify', 'dead-letter', 'omer', '--retry', '--home', root]);
    expect(retry.stderr).toMatch(/^1 event\(s\) of agent omer queued again/);
    expect(retry.stderr).toMatch(/1 dead letter\(s\) of an earlier agent under that name were not queued/);
    expect(new NotifyStore(new Home(root)).read().outbox.map((i) => i.id)).toEqual([evt(0xdead)]);
    const clear = await bin(['notify', 'clear', 'omer', '--home', root]);
    expect(clear.stderr).toMatch(/posts nothing now \(1 waiting event\(s\) dropped\)/);
    expect(new NotifyStore(new Home(root)).read().agents).toEqual({});
    expect(existsSync(join(root, 'notify-omer.secret'))).toBe(false);
  });
});
