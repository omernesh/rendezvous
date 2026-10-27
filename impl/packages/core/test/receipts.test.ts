// Delivery receipts and echo checks (SPEC §6.4.2, NOTES 98, issue #104): a
// contact confirms what it holds, the sender republishes what it does not,
// and a deaf relay subscription is caught by our own echo. No network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACK_TYPE,
  ackSeq,
  Agent,
  type AgentEvents,
  type AgentKey,
  type Envelope,
  envelopeHash,
  type EnvelopeMeta,
  generateKey,
  nextDeliveryDue,
  NostrTransport,
  type NostrTransportOptions,
  type PeerDelivery,
  RECEIPTS_EXTENSION,
  type ReceiptTiming,
  type RelayLink,
  retryDue,
  sealEnvelope,
  signDoc,
  type Transport,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

vi.setConfig({ testTimeout: 30_000 }); // two agents and a relay on a busy machine

const FAST: ReceiptTiming = { ackDelayMs: 40, ackMinIntervalMs: 80, retryAfterMs: 250, maxRetries: 2 };
const CAPS = ['rdv/v1', 'a2a/0.3', RECEIPTS_EXTENSION];

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close();
});

async function relay(port = 0): Promise<TestRelay> {
  const r = await startTestRelay(port);
  open.push(r);
  return r;
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/** A pipe that loses envelopes while `lose` is set: the relay "took" them and nobody ever gets them (the 2026-10-27 incident). */
class LossyTransport implements Transport {
  lose = false;
  lost: Envelope[] = [];
  constructor(readonly real: NostrTransport) {}
  async sendEnvelope(e: Envelope, relays?: string[]) {
    if (this.lose) {
      this.lost.push(e);
      return;
    }
    return this.real.sendEnvelope(e, relays);
  }
  onEnvelopes(me: string, handler: (e: unknown, meta?: EnvelopeMeta) => void) {
    return this.real.onEnvelopes(me, handler);
  }
  onReconnect(handler: (relay: string) => void) {
    return this.real.onReconnect(handler);
  }
  publishTopic(topic: string, doc: object, extra?: string[]) {
    return this.real.publishTopic(topic, doc, extra);
  }
  onTopics(topics: string[], handler: (doc: unknown, topic: string) => void) {
    return this.real.onTopics(topics, handler);
  }
  fetchTopic(topic: string, maxWaitMs?: number) {
    return this.real.fetchTopic(topic, maxWaitMs);
  }
  close() {
    this.real.close();
  }
}

function make(relays: string[], opts: { receipts?: boolean; transport?: Partial<NostrTransportOptions> } = {}): { agent: Agent; pipe: LossyTransport } {
  let pipe!: LossyTransport;
  const agent = Agent.create(
    (key: AgentKey) => (pipe = new LossyTransport(new NostrTransport({ key, relays, maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20, ...opts.transport }))),
    { rendezvous: relays.map((relay, i) => ({ type: 'nostr', relay, pref: i + 1 })), capabilities: opts.receipts === false ? ['rdv/v1', 'a2a/0.3'] : CAPS },
  );
  agent.receiptTiming = FAST;
  agent.on('error', (e) => {
    throw e;
  });
  agent.start();
  open.push(agent);
  return { agent, pipe };
}

function events<K extends keyof AgentEvents>(agent: Agent, name: K): AgentEvents[K][] {
  const got: AgentEvents[K][] = [];
  (agent as unknown as { on(e: string, f: (...a: unknown[]) => void): void }).on(name as string, (...args: unknown[]) => got.push(args as AgentEvents[K]));
  return got;
}

/** Omer asks John by card; John's human grants. */
async function contacts(omer: Agent, john: Agent): Promise<void> {
  await settle();
  const asked = new Promise<AgentEvents['request']>((r) => john.once('request', (...a) => r(a)));
  await omer.requestContact(john.card, 'hi', { label: 'John' });
  const [p] = await asked;
  const got = new Promise((r) => omer.once('contact', r));
  await john.grant(p.request.id, { tier: 'friend', label: 'Omer' });
  await got;
}

/** Envelopes on the relay from `from` to `to` (we can't read them: we count them). */
const between = (r: TestRelay, from: Agent, to: Agent) =>
  r.events.flatMap((ev) => {
    try {
      const e = JSON.parse(ev.content) as Envelope;
      return e.from === from.id && e.to === to.id ? [e] : [];
    } catch {
      return [];
    }
  });

describe('rdv/ack payload and timing (pure)', () => {
  it('takes exactly {type, v: 1, seq >= 1}', () => {
    expect(ackSeq({ type: ACK_TYPE, v: 1, seq: 3 })).toBe(3);
    expect(ackSeq({ type: ACK_TYPE, v: 1, seq: 0 })).toBeNull();
    expect(ackSeq({ type: ACK_TYPE, v: 1, seq: 1.5 })).toBeNull();
    expect(ackSeq({ type: ACK_TYPE, v: 2, seq: 3 })).toBeNull();
    expect(ackSeq({ type: ACK_TYPE, v: 1, seq: 3, extra: true })).toBeNull();
    expect(ackSeq({ type: ACK_TYPE, v: 1, seq: '3' })).toBeNull();
  });

  it('backs off per retry, stops once reported, and reports the earliest due time', () => {
    const t: ReceiptTiming = { ackDelayMs: 1000, ackMinIntervalMs: 5000, retryAfterMs: 60_000, maxRetries: 4 };
    const sent = '2026-10-27T10:00:00.000Z';
    const at = Date.parse(sent);
    expect(retryDue({ seq: 1, hash: 'h', sent, tries: 0 }, t)).toBe(at + 60_000);
    expect(retryDue({ seq: 1, hash: 'h', sent, tries: 2, last: '2026-10-27T10:03:00.000Z' }, t)).toBe(at + 180_000 + 240_000);
    expect(retryDue({ seq: 1, hash: 'h', sent, tries: 4, unconfirmed: true }, t)).toBeNull();
    const d: Record<string, PeerDelivery> = {
      a: { acked: 0, pending: [{ seq: 1, hash: 'h', sent, tries: 0 }] },
      b: { acked: 0, pending: [], ack_owed: sent, ack_sent: { at: '2026-10-27T09:59:59.000Z', seq: 1 } },
    };
    expect(nextDeliveryDue(d, t)).toBe(at + 4000); // b's ack: past the quiet period, held back by the minimum interval
    expect(nextDeliveryDue({}, t)).toBeNull();
  });
});

describe('delivery receipts between two agents', () => {
  it('round trip: the receiver confirms, the sender sees it delivered, and no one acknowledges an ack', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0); // the grant itself is confirmed
    const env = await john.send(omer.id, { type: 'note', text: 'hi' });
    expect(john.deliveryOf(omer.id, env.seq)).toBe('pending');
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    expect(john.deliveryStatus(omer.id)).toMatchObject({ confirms_delivery: true, waiting: 0, not_confirmed: 0 });
    await settle(400);
    // Omer's acks to John are envelopes in his chain, but John never answers them.
    const acksFromJohn = between(r, john, omer).length;
    await settle(400);
    expect(between(r, john, omer).length).toBe(acksFromJohn);
    expect(omer.deliveryStatus(john.id).waiting).toBe(0); // an ack is never waited for
    // Persisted with the state, and the agent comes back with it.
    const again = Agent.fromJSON(john.toJSON(), () => john.transport);
    expect(again.deliveryOf(omer.id, env.seq)).toBe('delivered');
  });

  it('a lost envelope is republished on the backoff and then confirmed', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    const resent = events(john, 'delivery-resent');
    const got = new Promise<AgentEvents['message']>((res) => omer.once('message', (...a) => res(a)));
    pipe.lose = true;
    const env = await john.send(omer.id, { type: 'note', text: 'lost once' });
    pipe.lose = false;
    expect(pipe.lost.map((e) => e.seq)).toEqual([env.seq]);
    const [, payload] = await got;
    expect(payload).toMatchObject({ text: 'lost once' });
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    expect(resent.some(([e]) => e.reason === 'retry' && e.seqs.includes(env.seq))).toBe(true);
  });

  it('after every retry the owner is told; a reconnect resends it, and a late receipt says it arrived after all', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    const unconfirmed = events(john, 'delivery-unconfirmed');
    const confirmed = events(john, 'delivery-confirmed');
    pipe.lose = true;
    const env = await john.send(omer.id, { type: 'note', text: 'never arrives' });
    await until(() => unconfirmed.length > 0, 10_000);
    expect(unconfirmed[0][0]).toMatchObject({ peer: omer.id, seqs: [env.seq] });
    expect(pipe.lost.filter((e) => e.seq === env.seq)).toHaveLength(1 + FAST.maxRetries);
    expect(john.deliveryOf(omer.id, env.seq)).toBe('not_confirmed');
    expect(john.deliveryStatus(omer.id)).toMatchObject({ waiting: 0, not_confirmed: 1 });
    await settle(600);
    expect(pipe.lost.filter((e) => e.seq === env.seq)).toHaveLength(1 + FAST.maxRetries); // reported: no more retries on the timer
    // Connectivity is back: the reconnect pass republishes it, and Omer's receipt clears it.
    pipe.lose = false;
    await john.resendUnconfirmed();
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    expect(confirmed.at(-1)?.[0]).toMatchObject({ peer: omer.id, seqs: [env.seq] });
  });

  it('a lost ack: the sender retries, the receiver acks again (a newer copy), and the sender is satisfied', async () => {
    const r = await relay();
    const { agent: omer, pipe: omerPipe } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    omerPipe.lose = true; // Omer's next envelope (his ack) is lost
    const env = await john.send(omer.id, { type: 'note', text: 'ack me twice' });
    await until(() => omerPipe.lost.length > 0);
    omerPipe.lose = false;
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered', 10_000);
    // The second ack left a gap where the lost one was: John asked for it again (rdv/resend) and his chain closes.
    const lostSeq = omerPipe.lost[0].seq;
    await until(() => (john.channels.state[omer.id]?.inSeq ?? 0) > lostSeq, 10_000);
  });

  it('a forged receipt is rejected: signed by someone else under the contact\'s name', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    john.stop(); // John is away: nothing of his confirms Omer's message
    const env = await omer.send(john.id, { type: 'note', text: 'for John' });
    const dropped = events(omer, 'dropped');
    const mallory = generateKey();
    const real = new NostrTransport({ key: mallory, relays: [r.url] });
    open.push(real);
    const genuine = sealEnvelope(mallory, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq } as { type: string }, { seq: 9, prev: null });
    const { sig: _s, ...body } = { ...genuine, from: john.id };
    await real.sendEnvelope(signDoc(body, mallory) as Envelope);
    await until(() => dropped.some(([reason]) => reason === 'bad signature'));
    expect(omer.deliveryOf(john.id, env.seq)).toBe('pending');
  });

  it("a non-contact's receipt is ignored", async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    john.stop();
    const env = await omer.send(john.id, { type: 'note', text: 'for John' });
    const dropped = events(omer, 'dropped');
    const mallory = generateKey();
    const real = new NostrTransport({ key: mallory, relays: [r.url] });
    open.push(real);
    await real.sendEnvelope(sealEnvelope(mallory, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq } as { type: string }, { seq: 1, prev: null }));
    await until(() => dropped.some(([reason]) => reason === 'ack from a non-contact'));
    expect(omer.deliveryOf(john.id, env.seq)).toBe('pending');
    expect(omer.deliveryStatus(mallory.id).confirmed_seq).toBe(0);
  });

  it('a contact cannot confirm what we never sent, and a malformed receipt is dropped', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => omer.deliveryStatus(john.id).waiting === 0);
    john.stop();
    const dropped = events(omer, 'dropped');
    const env = await omer.send(john.id, { type: 'note', text: 'one' });
    // John's own key, with his chain, but claiming far more than Omer sent.
    const ch = john.channels.nextOutbound(omer.id);
    const beyond = sealEnvelope(john.key, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq + 50 } as { type: string }, ch);
    await john.transport.sendEnvelope(beyond);
    await until(() => dropped.some(([reason]) => reason === 'ack beyond our chain'));
    const odd = sealEnvelope(john.key, omer.id, { type: ACK_TYPE, v: 1, seq: String(env.seq) } as { type: string }, { seq: ch.seq + 1, prev: envelopeHash(beyond) });
    await john.transport.sendEnvelope(odd);
    await until(() => dropped.some(([reason]) => reason === 'ack malformed'));
    expect(omer.deliveryOf(john.id, env.seq)).toBe('pending');
  });

  it('interop: a peer whose card lists no receipts gets no acks and is not waited for', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: old } = make([r.url], { receipts: false });
    await contacts(omer, old);
    const messages = events(old, 'message');
    const env = await omer.send(old.id, { type: 'note', text: 'to an old agent' });
    expect(omer.deliveryOf(old.id, env.seq)).toBe('untracked');
    expect(omer.deliveryStatus(old.id)).toMatchObject({ confirms_delivery: false, waiting: 0 });
    const got = new Promise((res) => omer.once('message', res));
    await old.send(omer.id, { type: 'note', text: 'from an old agent' });
    await got;
    const before = between(r, omer, old).length;
    await settle(500);
    expect(between(r, omer, old).length).toBe(before); // no ack went to it
    expect(messages.every(([, p]) => p.type !== ACK_TYPE)).toBe(true);
    expect(omer.toJSON().delivery?.[old.id]?.pending ?? []).toEqual([]);
  });
});

describe('echo check (NOTES 98)', () => {
  it('catches a deaf subscription, re-joins, reports the link, and catches up', async () => {
    const r = await relay();
    const me = generateKey();
    const links: RelayLink[] = [];
    const rx = new NostrTransport({ key: me, relays: [r.url], reconnectBaseMs: 30, echoIntervalMs: 150, echoTimeoutMs: 200, onRelayLink: (l) => links.push(l) });
    open.push(rx);
    const got: unknown[] = [];
    const reconnects: string[] = [];
    rx.onEnvelopes(me.id, (e) => got.push(e));
    rx.onReconnect((url) => reconnects.push(url));
    await until(() => links.some((l) => l.up));
    await settle(500);
    expect(got).toEqual([]); // our own echoes never reach the handler
    expect(links.filter((l) => !l.up)).toEqual([]); // and a healthy relay passes them
    const before = r.connections;
    r.deafen(); // pings and OKs go on; the subscription gets nothing more
    const tx = new NostrTransport({ key: generateKey(), relays: [r.url] });
    open.push(tx);
    const sender = generateKey();
    const env = sealEnvelope(sender, me.id, { type: 'note' }, { seq: 1, prev: null });
    await tx.sendEnvelope(env);
    await until(() => links.some((l) => !l.up));
    expect(rx.relayStatus()[0].last_error?.message).toMatch(/echo check failed/);
    await until(() => got.length === 1 && reconnects.length === 1);
    expect(r.connections).toBeGreaterThan(before);
    expect((got[0] as Envelope).seq).toBe(1); // the look-back of the re-join delivered it
    expect(links.at(-1)?.up).toBe(true);
  });

  it('is skipped while traffic flows, and off with echoIntervalMs 0', async () => {
    const r = await relay();
    const me = generateKey();
    const rx = new NostrTransport({ key: me, relays: [r.url], echoIntervalMs: 300 });
    open.push(rx);
    rx.onEnvelopes(me.id, () => {});
    const offKey = generateKey();
    const off = new NostrTransport({ key: offKey, relays: [r.url], echoIntervalMs: 0 });
    open.push(off);
    off.onEnvelopes(offKey.id, () => {});
    const tx = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(tx);
    const sender = generateKey();
    const echoes = () => r.events.filter((ev) => ev.pubkey === rx.carrierPubkey || ev.pubkey === off.carrierPubkey).length;
    for (let i = 1; i <= 10; i++) {
      await tx.sendEnvelope(sealEnvelope(sender, me.id, { type: 'note' }, { seq: i, prev: null }));
      await settle(100);
    }
    expect(echoes()).toBe(0);
    await settle(800); // quiet now: rx echoes, off never does
    expect(r.events.filter((ev) => ev.pubkey === rx.carrierPubkey).length).toBeGreaterThan(0);
    expect(r.events.filter((ev) => ev.pubkey === off.carrierPubkey).length).toBe(0);
  });

  it('an agent behind a deaf relay recovers by itself: the message arrives and is confirmed', async () => {
    const rOmer = await relay();
    const rJohn = await relay();
    const { agent: omer } = make([rOmer.url], { transport: { echoIntervalMs: 150, echoTimeoutMs: 200 } });
    const { agent: john } = make([rJohn.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    // John's retries are far off: what follows is the echo check alone.
    john.receiptTiming = { ...FAST, retryAfterMs: 60_000 };
    rOmer.deafen(); // Omer's relay keeps answering pings and OKs but delivers him nothing more
    const got = new Promise<AgentEvents['message']>((res) => omer.once('message', (...a) => res(a)));
    const env = await john.send(omer.id, { type: 'note', text: 'through a deaf relay' });
    const [, payload] = await got;
    expect(payload).toMatchObject({ text: 'through a deaf relay' });
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    expect(omer.transport instanceof LossyTransport && omer.transport.real.relayStatus()[0].last_error?.message).toMatch(/echo check failed/);
  });

  it('when its relay comes back, the sender republishes what was not confirmed', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    john.receiptTiming = { ...FAST, retryAfterMs: 60_000 }; // only the reconnect resends
    const resent = events(john, 'delivery-resent');
    pipe.lose = true;
    const env = await john.send(omer.id, { type: 'note', text: 'sent while cut off' });
    pipe.lose = false;
    // John's socket dies and comes back: catch-up, then the flush.
    const pool = pipe.real.pool as unknown as { relays: Map<string, { ws?: { terminate(): void } }> };
    for (const rel of pool.relays.values()) rel.ws?.terminate();
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    expect(resent.map(([e]) => e)).toEqual([{ peer: omer.id, seqs: [env.seq], reason: 'reconnect' }]);
  });
});
