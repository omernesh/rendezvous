// The Nostr transport's publish path against the in-memory relay's failure
// modes (NOTES 69), and the envelope size cap (SPEC §6.4, NOTES 70).
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';
import {
  b64encode,
  classifyRelayError,
  DEFAULT_RELAYS,
  ENVELOPE_KIND,
  EnvelopeTooLargeError,
  generateKey,
  MAX_PLAINTEXT_BYTES,
  NostrTransport,
  type NostrTransportOptions,
  openEnvelope,
  type RelayStatus,
  sealEnvelope,
  signDoc,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close();
});

async function relay(faults = {}): Promise<TestRelay> {
  const r = await startTestRelay(0, faults);
  open.push(r);
  return r;
}

/** Fast defaults for tests: short backoff, no pacing unless a test asks for it. */
function transport(relays: string[], opts: Partial<NostrTransportOptions> = {}): NostrTransport {
  const t = new NostrTransport({ key: generateKey(), relays, retryBaseMs: 20, maxEventsPerSecond: 1000, burst: 1000, ...opts });
  open.push(t);
  return t;
}

describe('default relays', () => {
  it('are the four surveyed public relays, frozen', () => {
    expect(DEFAULT_RELAYS).toEqual(['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.net', 'wss://nostr.oxtr.dev']);
    expect(Object.isFrozen(DEFAULT_RELAYS)).toBe(true);
  });
});

describe('publish: retries, per-relay results, cooldown', () => {
  it('retries after a dropped connection and records the OK', async () => {
    const r = await relay({ dropOnEvent: 1 });
    const t = transport([r.url]);
    const report = await t.publishTopic('t', { n: 1 });
    expect(report.accepted).toEqual([r.url]);
    expect(r.received).toHaveLength(2); // dropped once, then accepted
    expect(r.events).toHaveLength(1);
    const [s] = t.relayStatus();
    expect(s.last_ok).not.toBeNull();
    expect(s.cooldown_until).toBeNull();
  });

  it("retries a relay's transient OK-false (error:, rate-limited:)", async () => {
    for (const reason of ['error: database busy', 'rate-limited: slow down']) {
      const r = await relay({ okFalse: reason, okFalseTimes: 1 });
      const t = transport([r.url]);
      await t.publishTopic('t', { reason });
      expect(r.received).toHaveLength(2);
      expect(r.events).toHaveLength(1);
    }
  });

  it('gives up after the retries, reports each reason and cools the relay down briefly', async () => {
    const r = await relay({ dropOnEvent: 10 });
    const t = transport([r.url], { publishRetries: 2, failureCooldownMs: 60_000 });
    await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow(/no relay accepted the event: .*connection/);
    expect(r.received).toHaveLength(3); // 1 + 2 retries
    const [s] = t.relayStatus();
    expect(s.last_error?.kind).toBe('connection');
    expect(Date.parse(s.cooldown_until ?? '')).toBeGreaterThan(Date.now());
  });

  it('does not retry a permanent rejection (invalid:) and does not cool down for it', async () => {
    const r = await relay({ okFalse: 'invalid: event too large' });
    const t = transport([r.url]);
    await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow(/rejected: invalid: event too large/);
    expect(r.received).toHaveLength(1);
    const [s] = t.relayStatus();
    expect(s.last_error).toMatchObject({ kind: 'rejected', message: 'invalid: event too large' });
    expect(s.cooldown_until).toBeNull();
  });

  it('succeeds when one relay accepts; a blocking relay is tried once, then skipped while it cools down', async () => {
    const bad = await relay({ okFalse: 'blocked: you are banned from posting here' });
    const good = await relay();
    const seen: RelayStatus[][] = [];
    const t = transport([bad.url, good.url], { onRelayStatus: (s) => seen.push(s) });
    const first = await t.publishTopic('t', { n: 1 });
    expect(first.accepted).toEqual([good.url]);
    expect(first.rejected).toEqual([{ url: bad.url, kind: 'blocked', message: 'blocked: you are banned from posting here' }]);
    expect(bad.received).toHaveLength(1); // no retry for a ban
    const status = t.relayStatus();
    expect(status.map((s) => s.url)).toEqual([bad.url, good.url]);
    expect(status[0].last_error?.kind).toBe('blocked');
    expect(Date.parse(status[0].cooldown_until ?? '') - Date.now()).toBeGreaterThan(25 * 60_000); // default 30 min
    expect(status[1].last_ok).not.toBeNull();
    expect(seen.at(-1)).toEqual(status);

    const second = await t.publishTopic('t', { n: 2 });
    expect(second.skipped).toEqual([bad.url]);
    expect(bad.received).toHaveLength(1); // not hammered
    expect(good.events).toHaveLength(2);
  });

  it('when every relay is cooling down, tries each once instead of failing without trying', async () => {
    const r = await relay({ okFalse: 'restricted: not allowed', okFalseTimes: 1 });
    const t = transport([r.url]);
    await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow(/blocked: restricted/);
    await t.publishTopic('t', { n: 2 }); // the restriction is gone now
    expect(r.received).toHaveLength(2);
    expect(t.relayStatus()[0].cooldown_until).toBeNull(); // an OK clears the cooldown
  });

  it('times out a slow ack and retries; a slow but timely ack is fine', async () => {
    const slow = await relay({ ackDelayMs: 400 });
    const t = transport([slow.url], { publishTimeoutMs: 100, publishRetries: 1 });
    await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow(/timeout: publish timed out/);
    expect(slow.received).toHaveLength(2);
    expect(t.relayStatus()[0].last_error?.kind).toBe('timeout');

    const ok = await relay({ ackDelayMs: 100 });
    const t2 = transport([ok.url], { publishTimeoutMs: 2000 });
    expect((await t2.publishTopic('t', { n: 1 })).accepted).toEqual([ok.url]);
  });

  it('an unreachable relay next to a good one: the publish succeeds and the dead one is reported', async () => {
    const good = await relay();
    const dead = 'ws://127.0.0.1:9';
    const t = transport([dead, good.url], { connectTimeoutMs: 500 });
    const report = await t.publishTopic('t', { n: 1 });
    expect(report.accepted).toEqual([good.url]);
    expect(report.rejected[0]).toMatchObject({ url: dead, kind: 'connection' });
    expect(t.relayStatus()[0].last_error?.kind).toBe('connection');
  });

  it('a connect timeout on a relay that never answers the handshake does not crash the process', async () => {
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const t = transport([`ws://127.0.0.1:${port}`], { connectTimeoutMs: 150, publishRetries: 1 });
      await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow(/connection: connection failure: connection timed out/);
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });

  it('starts from saved cooldowns, and lists only our own relays (a peer card relay is peer text)', async () => {
    const ours = await relay();
    const cooled = await relay();
    const peers = await relay();
    const until = new Date(Date.now() + 60_000).toISOString();
    const saved: RelayStatus[] = [
      { url: cooled.url, last_ok: null, last_error: { at: new Date().toISOString(), kind: 'blocked', message: 'blocked' }, cooldown_until: until },
      { url: 'wss://not-ours.example', last_ok: null, last_error: null, cooldown_until: until },
    ];
    const t = transport([ours.url, cooled.url], { relayState: saved });
    const report = await t.publishTopic('t', { n: 1 }, [peers.url]);
    expect(report.skipped).toEqual([cooled.url]);
    expect(report.accepted.sort()).toEqual([ours.url, peers.url].sort());
    expect(cooled.received).toHaveLength(0);
    expect(t.relayStatus().map((s) => s.url)).toEqual([ours.url, cooled.url]);
  });

  it("strips control characters from a relay's message", async () => {
    const r = await relay({ okFalse: 'blocked: \u001b[31mred‮ text' });
    const t = transport([r.url]);
    await expect(t.publishTopic('t', { n: 1 })).rejects.toThrow();
    const msg = t.relayStatus()[0].last_error?.message ?? '';
    expect(msg).toBe('blocked: ?[31mred? text');
  });

  it('reuses one connection per relay across publishes', async () => {
    const r = await relay();
    const t = transport([r.url]);
    for (let i = 0; i < 5; i++) await t.publishTopic('t', { i });
    t.onTopics(['t'], () => {});
    await t.fetchTopic('t', 500);
    expect(r.connections).toBe(1);
  });

  it('close() wakes a publish waiting on backoff', async () => {
    const r = await relay({ dropOnEvent: 10 });
    const t = new NostrTransport({ key: generateKey(), relays: [r.url], retryBaseMs: 60_000 });
    const p = t.publishTopic('t', { n: 1 });
    await new Promise((res) => setTimeout(res, 200));
    t.close();
    await expect(p).rejects.toThrow(/transport closed/);
  });
});

describe('publish: client-side pacing', () => {
  it('lets a burst through, then paces to maxEventsPerSecond per relay', async () => {
    const r = await relay();
    const t = transport([r.url], { maxEventsPerSecond: 5, burst: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, i) => t.publishTopic(`t${i}`, { i })));
    expect(r.events).toHaveLength(6);
    const span = r.received[5] - r.received[0];
    expect(span).toBeGreaterThanOrEqual(700); // 4 paced events at 5/s: about 800 ms
  });

  it('the default (burst 6) sends a card republish to six topics at once', async () => {
    const r = await relay();
    const t = new NostrTransport({ key: generateKey(), relays: [r.url] });
    open.push(t);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, (_, i) => t.publishTopic(`t${i}`, { i })));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.events).toHaveLength(6);
  });
});

describe('classifyRelayError', () => {
  it('maps NIP-01 prefixes and connection errors', () => {
    const c = (m: unknown) => {
      const x = classifyRelayError(m);
      return [x.kind, x.retry, x.duplicate ?? false];
    };
    expect(c(new Error('blocked: spam'))).toEqual(['blocked', false, false]);
    expect(c(new Error('restricted: wot'))).toEqual(['blocked', false, false]);
    expect(c(new Error('you are banned'))).toEqual(['blocked', false, false]);
    expect(c(new Error('rate-limited: slow down'))).toEqual(['rate-limited', true, false]);
    expect(c(new Error('publish timed out'))).toEqual(['timeout', true, false]);
    expect(c('connection failure: connection failed')).toEqual(['connection', true, false]);
    expect(c(new Error('relay connection closed'))).toEqual(['connection', true, false]);
    expect(c(new Error('error: internal'))).toEqual(['rejected', true, false]);
    expect(c(new Error('invalid: kind 30417 not accepted'))).toEqual(['rejected', false, false]);
    expect(c(new Error('pow: difficulty 20 required'))).toEqual(['rejected', false, false]);
    expect(c(new Error('duplicate: already have it'))).toEqual(['rejected', false, true]);
    expect(classifyRelayError(new Error('x'.repeat(500))).message.length).toBeLessThanOrEqual(203);
  });
});

describe('envelope size cap (SPEC §6.4)', () => {
  const omer = generateKey();
  const john = generateKey();
  // canonical {"text":"…","type":"note"} is 25 bytes plus the text
  const payload = (bytes: number) => ({ type: 'note', text: 'x'.repeat(bytes - 25) });

  it('seals a payload of exactly the cap and opens it', () => {
    const e = sealEnvelope(omer, john.id, payload(MAX_PLAINTEXT_BYTES), { seq: 1, prev: null });
    const r = openEnvelope(john, e);
    expect(r.ok).toBe(true);
  });

  it('refuses to seal one byte more, with a clear error', () => {
    expect(() => sealEnvelope(omer, john.id, payload(MAX_PLAINTEXT_BYTES + 1), { seq: 1, prev: null })).toThrow(EnvelopeTooLargeError);
    expect(() => sealEnvelope(omer, john.id, payload(MAX_PLAINTEXT_BYTES + 1), { seq: 1, prev: null })).toThrow(
      /payload is 32769 bytes; an envelope carries at most 32768 bytes/,
    );
    // multi-byte characters count as UTF-8 bytes
    expect(() => sealEnvelope(omer, john.id, { type: 'note', text: 'ש'.repeat(16_400) }, { seq: 1, prev: null })).toThrow(
      EnvelopeTooLargeError,
    );
  });

  it('drops an oversized envelope on receive before decrypting, even with a valid signature', () => {
    const e = sealEnvelope(omer, john.id, payload(100), { seq: 1, prev: null });
    const { sig: _sig, ...body } = e;
    const big = signDoc({ ...body, content: { ...body.content, ciphertext: b64encode(new Uint8Array(MAX_PLAINTEXT_BYTES + 17)) } }, omer);
    expect(openEnvelope(john, big)).toEqual({ ok: false, reason: 'too large' });
    const notString = signDoc({ ...body, content: { ...body.content, ciphertext: 42 as unknown as string } }, omer);
    expect(openEnvelope(john, notString)).toEqual({ ok: false, reason: 'too large' });
  });

  it('a sealed envelope at the cap stays under the 128 KB relay message cap', async () => {
    const r = await relay();
    const t = transport([r.url]);
    await t.sendEnvelope(sealEnvelope(omer, john.id, payload(MAX_PLAINTEXT_BYTES), { seq: 1, prev: null }));
    const wire = JSON.stringify(['EVENT', r.events[0]]);
    expect(wire.length).toBeLessThan(128 * 1024);
    expect(wire.length).toBeLessThan(50_000);
  });

  it('the transport does not parse oversized event content from a relay', async () => {
    const r = await relay();
    const t = transport([r.url]);
    const got: unknown[] = [];
    t.onEnvelopes(john.id, (env) => got.push(env));
    await new Promise((res) => setTimeout(res, 200));
    const carrier = generateKey().secretKey;
    const { agentTag } = await import('../src/index.js');
    const pub = transport([r.url]);
    const ev = (content: string) =>
      finalizeEvent({ kind: ENVELOPE_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['p', agentTag(john.id)], ['d', String(content.length)]], content }, carrier);
    const relayHandle = await pub.pool.ensureRelay(r.url);
    await relayHandle.publish(ev(JSON.stringify({ x: 'y'.repeat(140_000) })));
    await relayHandle.publish(ev(JSON.stringify({ small: true })));
    for (let i = 0; i < 30 && got.length < 2; i++) await new Promise((res) => setTimeout(res, 50));
    expect(got).toEqual([undefined, { small: true }]);
  });
});
