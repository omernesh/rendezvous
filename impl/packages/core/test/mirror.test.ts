// Discovery mirrors and relay changes (NOTES 81): the serial mirror publisher
// against the in-memory relay's failure modes, lookups that ask the mirrors,
// and moving a live transport to other relays.
import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  createCard,
  DEFAULT_MIRROR_RELAYS,
  DEFAULT_RELAYS,
  dtopic,
  generateKey,
  NostrTransport,
  type NostrTransportOptions,
  reissueCardRelays,
  relaysOf,
  verifyCard,
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

function transport(relays: string[], opts: Partial<NostrTransportOptions> = {}): NostrTransport {
  const t = new NostrTransport({ key: generateKey(), relays, retryBaseMs: 20, maxEventsPerSecond: 1000, burst: 1000, ...opts });
  open.push(t);
  return t;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const cardAt = (address: string) => {
  const key = generateKey();
  const a = { type: 'email' as const, value: address };
  return { key, topic: dtopic(a), card: createCard(key, { rendezvous: [{ type: 'nostr', relay: 'wss://x.example', pref: 1 }], discovery: { addresses: [a], public_pointer: true }, policy: { public: true } }) };
};

describe('default mirror relays', () => {
  it('are frozen wss:// URLs, contain the default relays and never relay.damus.io', () => {
    expect(Object.isFrozen(DEFAULT_MIRROR_RELAYS)).toBe(true);
    expect(DEFAULT_MIRROR_RELAYS.every((r) => r.startsWith('wss://'))).toBe(true);
    for (const r of DEFAULT_RELAYS) expect(DEFAULT_MIRROR_RELAYS).toContain(r);
    expect(DEFAULT_MIRROR_RELAYS.some((r) => r.includes('damus'))).toBe(false);
    expect(new Set(DEFAULT_MIRROR_RELAYS).size).toBe(DEFAULT_MIRROR_RELAYS.length);
  });
});

describe('mirrorTopics: serial, paced, one try per relay, per-relay result and read-back', () => {
  it('reports accepted / rejected / timeout per relay, one relay at a time, and reads the card back', async () => {
    const own = await relay();
    const good = await relay();
    const blocked = await relay({ okFalse: 'blocked: kind 30417 is not allowed' });
    const slow = await relay({ ackDelayMs: 2000 });
    const t = transport([own.url]);
    const docs = [
      { topic: 'topic-a', doc: { n: 1 } },
      { topic: 'topic-b', doc: { n: 2 } },
    ];
    const report = await t.mirrorTopics(docs, { relays: [good.url, blocked.url, slow.url, own.url], gapMs: 150, timeoutMs: 400, readBackWaitMs: 1000 });
    expect(report.relays.map((r) => [r.url, r.role, r.result])).toEqual([
      [own.url, 'listen', 'accepted'],
      [good.url, 'mirror', 'accepted'],
      [blocked.url, 'mirror', 'rejected'],
      [slow.url, 'mirror', 'timeout'],
    ]);
    expect(report).toMatchObject({ topics: ['topic-a', 'topic-b'], accepted: 2, rejected: 1, timeout: 1, skipped: 0, served: 2 });
    expect(report.relays[2]).toMatchObject({ kind: 'blocked', message: 'blocked: kind 30417 is not allowed', served: null });
    expect(report.relays.slice(0, 2).every((r) => r.served === true)).toBe(true);
    // Both documents on the relays that took them; a rejecting relay got one try and no second document.
    expect(own.events).toHaveLength(2);
    expect(good.events).toHaveLength(2);
    expect(blocked.received).toHaveLength(1);
    expect(slow.received).toHaveLength(1);
    // Serial: each relay's first event comes after the previous relay's last, with the gap between.
    expect(good.received[0] - own.received[1]).toBeGreaterThanOrEqual(140);
    expect(blocked.received[0] - good.received[1]).toBeGreaterThanOrEqual(140);
    expect(slow.received[0]).toBeGreaterThan(blocked.received[0]);
  });

  it('skips a mirror that banned us (cooling down) on the next run, without contacting it', async () => {
    const own = await relay();
    const banning = await relay({ okFalse: 'blocked: pubkey banned' });
    const statuses: string[][] = [];
    const t = transport([own.url], { mirrorRelays: [banning.url], onRelayStatus: (s) => statuses.push(s.map((x) => x.url)) });
    const first = await t.mirrorTopics([{ topic: 'x', doc: { n: 1 } }], { relays: [banning.url], gapMs: 0, timeoutMs: 400, readBack: false });
    expect(first.relays[1].result).toBe('rejected');
    const second = await t.mirrorTopics([{ topic: 'x', doc: { n: 2 } }], { relays: [banning.url], gapMs: 0, timeoutMs: 400, readBack: false });
    expect(second.relays[1]).toMatchObject({ result: 'skipped', served: null });
    expect(banning.received).toHaveLength(1);
    // The mirror's cooldown is saved with ours (so the next process keeps it), but never listed as one of our relays.
    expect(statuses.at(-1)).toEqual([own.url, banning.url]);
    expect(t.relayStatus().map((s) => s.url)).toEqual([own.url]);
    expect(t.mirrorStatus()[0].cooldown_until).not.toBeNull();
  });

  it('a replaceable mirror event replaces the older card on the relay (same d), and reads back as served', async () => {
    const own = await relay();
    const t = transport([own.url]);
    await t.mirrorTopics([{ topic: 'x', doc: { n: 1 }, createdAt: 1000 }], { relays: [], gapMs: 0, readBack: false });
    await new Promise((r) => setTimeout(r, 1100));
    const r = await t.mirrorTopics([{ topic: 'x', doc: { n: 2 }, createdAt: 1000 }], { relays: [], gapMs: 0, readBackWaitMs: 1000 });
    expect(r.served).toBe(1);
    expect(own.events).toHaveLength(1);
    expect(JSON.parse(own.events[0].content)).toEqual({ n: 2 });
  });
});

describe('lookups ask the mirrors too', () => {
  it('finds a card that only a mirror holds, with bounded concurrency, and survives a dead mirror', async () => {
    const own = await relay();
    const mirrors = await Promise.all([relay(), relay(), relay()]);
    const { key, topic, card } = cardAt('omer@example.com');
    const publisher = transport([mirrors[2].url], { key });
    await publisher.publishTopic(topic, card, [], { replaceable: true });
    const dead = 'ws://127.0.0.1:1';
    const t = transport([own.url], { mirrorRelays: [mirrors[0].url, dead, mirrors[1].url, mirrors[2].url], lookupConcurrency: 2 });
    const docs = await t.fetchTopic(topic, 1500);
    expect(docs).toHaveLength(1);
    expect(verifyCard(docs[0]).ok).toBe(true);
    // Every mirror was asked; without mirrors the same lookup finds nothing.
    for (const m of mirrors) expect(m.requests.length).toBe(1);
    expect(await transport([own.url]).fetchTopic(topic, 500)).toEqual([]);
    // Our own relays only (the check after publishing): the mirrors are not asked.
    expect(await t.fetchTopic(topic, 500, { mirrors: false })).toEqual([]);
    for (const m of mirrors) expect(m.requests.length).toBe(1);
  });

  it('de-duplicates a card held by our relay and a mirror', async () => {
    const own = await relay();
    const mirror = await relay();
    const { key, topic, card } = cardAt('john@doe.com');
    await transport([own.url, mirror.url], { key }).publishTopic(topic, card, [], { replaceable: true });
    expect(await transport([own.url], { mirrorRelays: [mirror.url, own.url] }).fetchTopic(topic, 1000)).toHaveLength(1);
  });
});

describe('setRelays: a live transport moves to other relays', () => {
  it('subscriptions join the added relay and leave the dropped one; publishes follow', async () => {
    const a = await relay();
    const b = await relay();
    const me = generateKey();
    const t = transport([a.url], { key: me });
    const got: unknown[] = [];
    t.onTopics(['live'], (doc) => got.push(doc));
    await until(() => a.requests.length === 1);
    t.setRelays([b.url]);
    await until(() => b.requests.length === 1);
    expect(t.relays).toEqual([b.url]);
    const other = transport([a.url, b.url]);
    await other.publishTopic('live', { on: 'both' });
    await until(() => got.length === 1);
    // Only on the dropped relay: not heard.
    await transport([a.url]).publishTopic('live', { on: 'a' });
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([{ on: 'both' }]);
    const report = await t.publishTopic('mine', { n: 1 });
    expect(report.accepted).toEqual([b.url]);
    expect(() => t.setRelays([])).toThrow(/at least one relay/);
  });

  it('Agent.setRelays re-signs the card with the relays as its nostr hints, later created', async () => {
    const r = await relay();
    const agent = Agent.create((key) => transport([r.url], { key }), {
      rendezvous: [{ type: 'nostr', relay: r.url, pref: 1 }],
      discovery: { addresses: [{ type: 'email', value: 'omer@example.com' }], public_pointer: true },
      policy: { public: true },
    });
    const before = agent.card;
    const card = agent.setRelays(['wss://two.example', 'wss://one.example', 'wss://two.example']);
    expect(relaysOf(card)).toEqual(['wss://two.example', 'wss://one.example']);
    expect(card.rendezvous.map((h) => h.pref)).toEqual([1, 2]);
    expect(Date.parse(card.created)).toBeGreaterThan(Date.parse(before.created));
    expect(verifyCard(card).ok).toBe(true);
    expect(card.discovery).toEqual(before.discovery);
    expect((agent.transport as NostrTransport).relays).toEqual(['wss://two.example', 'wss://one.example']);
    expect(() => reissueCardRelays(agent.key, card, [])).toThrow();
  });

  it('Agent.mirrorPointers refuses without the public pointer', async () => {
    const r = await relay();
    const agent = Agent.create((key) => transport([r.url], { key }), { rendezvous: [{ type: 'nostr', relay: r.url, pref: 1 }] });
    await expect(agent.mirrorPointers({ relays: [] })).rejects.toThrow(/public pointer is off/);
  });
});
