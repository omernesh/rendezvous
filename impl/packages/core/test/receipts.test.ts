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
  ECHO_KIND,
  ECHO_EXPIRES_S,
  agentTag,
  envelopeHash,
  RECEIPT_TIMING,
  receiptTimingOf,
  pendingInBackup,
  restoredAgentState,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import WebSocket, { WebSocketServer } from 'ws';

vi.setConfig({ testTimeout: 30_000 }); // two agents and a relay on a busy machine

const FAST: ReceiptTiming = { ackDelayMs: 40, ackMinIntervalMs: 80, ackJitterMs: 0, retryAfterMs: 250, maxRetries: 2 };
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
  onEnvelopes(me: string, handler: (e: unknown) => void) {
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

function make(relays: string[], opts: { receipts?: boolean; timer?: boolean; transport?: Partial<NostrTransportOptions> } = {}): { agent: Agent; pipe: LossyTransport } {
  let pipe!: LossyTransport;
  const agent = Agent.create(
    (key: AgentKey) => (pipe = new LossyTransport(new NostrTransport({ key, relays, maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20, ...opts.transport }))),
    { rendezvous: relays.map((relay, i) => ({ type: 'nostr', relay, pref: i + 1 })), capabilities: opts.receipts === false ? ['rdv/v1', 'a2a/0.3'] : CAPS },
  );
  agent.receiptTiming = FAST;
  agent.on('error', (e) => {
    throw e;
  });
  agent.start({ deliveryTimer: opts.timer !== false });
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
    const t: ReceiptTiming = { ackDelayMs: 1000, ackMinIntervalMs: 5000, ackJitterMs: 0, retryAfterMs: 60_000, maxRetries: 4 };
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

  it('a lost ack: the sender retries, the receiver acks the duplicate again, and the sender is satisfied', async () => {
    // No timers: each side's tick runs by hand at a clock we move, so nothing races the wall clock (review of #112).
    const r = await relay();
    const { agent: omer, pipe: omerPipe } = make([r.url], { timer: false });
    const { agent: john } = make([r.url], { timer: false });
    await contacts(omer, john);
    let clock = Date.now();
    const later = () => new Date((clock += 60_000));
    const got = new Promise((res) => omer.once('message', res));
    const env = await john.send(omer.id, { type: 'note', text: 'ack me twice' });
    await got;
    omerPipe.lose = true; // Omer's receipt (for the grant and the message at once) is lost
    await omer.deliveryTick(later());
    expect(omerPipe.lost).toHaveLength(1);
    omerPipe.lose = false;
    expect(john.deliveryOf(omer.id, env.seq)).toBe('pending');
    await john.deliveryTick(later()); // John's retry: the same envelopes, published again
    await until(() => omer.toJSON().delivery?.[john.id]?.ack_owed !== undefined); // the duplicate earned another receipt
    await omer.deliveryTick(later());
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
    // Receipts are outside the chain: the lost one left no gap, and none took a seq or an outbox slot.
    expect(omerPipe.lost.every((e) => e.seq === 0 && e.prev === null)).toBe(true);
    expect((omer as unknown as { outbox: Record<string, Envelope[]> }).outbox[john.id]?.some((e) => e.seq === 0) ?? false).toBe(false);
  });

  it('a third party re-publishing an old envelope gets one receipt per window at most, and costs the chain nothing (review H1)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    john.receiptTiming = { ...FAST, retryAfterMs: 60_000 }; // a re-ack window of 30 s
    pipe.lose = true;
    await john.send(omer.id, { type: 'note', text: 'important' });
    pipe.lose = false;
    const old = between(r, omer, john).find((e) => e.seq > 0)!; // Omer's request, a public envelope on the relay
    const attacker = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(attacker);
    const outSeq = john.channels.state[omer.id].outSeq;
    const box = (john as unknown as { outbox: Record<string, Envelope[]> }).outbox[omer.id].map((e) => e.seq);
    const acks = () => between(r, john, omer).filter((e) => e.seq === 0).length;
    await settle(300);
    const before = acks();
    for (let i = 0; i < 10; i++) {
      await attacker.sendEnvelope(old, [r.url]); // the same signed envelope, a fresh carrier event each time
      await settle(150);
    }
    await settle(500);
    expect(john.channels.state[omer.id].outSeq).toBe(outSeq);
    expect((john as unknown as { outbox: Record<string, Envelope[]> }).outbox[omer.id].map((e) => e.seq)).toEqual(box);
    // John never confirmed that envelope (Omer was no contact yet), so its first copy earns the receipt it never had;
    // after that, at most one per retryAfterMs / 2 for duplicates, however many come.
    expect(acks() - before).toBeLessThanOrEqual(2);
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
    await real.sendEnvelope(sealEnvelope(mallory, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq } as { type: string }, { seq: 0, prev: null }));
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
    const ch = { seq: 0, prev: null }; // receipts are outside every chain
    const beyond = sealEnvelope(john.key, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq + 50 } as { type: string }, ch);
    await john.transport.sendEnvelope(beyond);
    await until(() => dropped.some(([reason]) => reason === 'ack beyond our chain'));
    const odd = sealEnvelope(john.key, omer.id, { type: ACK_TYPE, v: 1, seq: String(env.seq) } as { type: string }, ch);
    await john.transport.sendEnvelope(odd);
    await until(() => dropped.some(([reason]) => reason === 'ack malformed'));
    expect(omer.deliveryOf(john.id, env.seq)).toBe('pending');
  });

  it('an unchained envelope that is not a receipt, and a receipt inside a chain, count for nothing', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    john.stop();
    const env = await omer.send(john.id, { type: 'note', text: 'one' });
    const dropped = events(omer, 'dropped');
    const messages = events(omer, 'message');
    await john.transport.sendEnvelope(sealEnvelope(john.key, omer.id, { type: 'note', text: 'sneaky' }, { seq: 0, prev: null }));
    await until(() => dropped.some(([reason]) => reason === 'malformed'));
    await john.transport.sendEnvelope(sealEnvelope(john.key, omer.id, { type: ACK_TYPE, v: 1, seq: env.seq } as { type: string }, john.channels.nextOutbound(omer.id)));
    await until(() => dropped.some(([reason]) => reason === 'chained ack'));
    expect(messages).toEqual([]);
    expect(omer.deliveryOf(john.id, env.seq)).toBe('pending');
  });

  it('an owner who turned receipts off sends none, and receipts wait for a jitter on top of the quiet period', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    omer.sendReceipts = false;
    const arrived = new Promise((res) => omer.once('message', res));
    const env = await john.send(omer.id, { type: 'note', text: 'no receipt please' });
    await arrived;
    await settle(400);
    expect(john.deliveryOf(omer.id, env.seq)).toBe('pending');
    // Jitter: the owed receipt is stamped up to ackJitterMs later than now.
    omer.sendReceipts = true;
    omer.receiptTiming = { ...FAST, ackJitterMs: 3000, ackDelayMs: 60_000 };
    const t0 = Date.now();
    const env2 = await john.send(omer.id, { type: 'note', text: 'with jitter' });
    await until(() => omer.toJSON().delivery?.[john.id]?.ack_owed !== undefined);
    const owed = Date.parse(omer.toJSON().delivery![john.id].ack_owed!);
    expect(owed).toBeGreaterThanOrEqual(t0);
    expect(owed).toBeLessThanOrEqual(Date.now() + 3000);
    expect(john.deliveryOf(omer.id, env2.seq)).toBe('pending');
  });

  it('refreshCapabilities can take a capability off the card (the receipts opt-out)', () => {
    const a = Agent.create(() => ({ sendEnvelope: async () => {}, onEnvelopes: () => () => {}, publishTopic: async () => {}, onTopics: () => () => {}, fetchTopic: async () => [], close() {} }), {
      rendezvous: [{ type: 'nostr', relay: 'wss://a.example', pref: 1 }],
      capabilities: CAPS,
    });
    expect(a.refreshCapabilities(['rdv/v1', 'a2a/0.3'], { drop: [RECEIPTS_EXTENSION] })).toBe(true);
    expect(a.card.capabilities).not.toContain(RECEIPTS_EXTENSION);
    expect(a.refreshCapabilities(['rdv/v1', 'a2a/0.3'], { drop: [RECEIPTS_EXTENSION] })).toBe(false); // nothing more to do
    a.close();
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
    const echoes = () => r.ephemeral.filter((ev) => ev.pubkey === rx.carrierPubkey || ev.pubkey === off.carrierPubkey).length;
    for (let i = 1; i <= 10; i++) {
      await tx.sendEnvelope(sealEnvelope(sender, me.id, { type: 'note' }, { seq: i, prev: null }));
      await settle(100);
    }
    expect(echoes()).toBe(0);
    await settle(800); // quiet now: rx echoes, off never does
    const sent = r.ephemeral.filter((ev) => ev.pubkey === rx.carrierPubkey);
    expect(sent.length).toBeGreaterThan(0);
    expect(r.ephemeral.filter((ev) => ev.pubkey === off.carrierPubkey).length).toBe(0);
    // Ephemeral: the relay stores none of them, so nobody can list who is listening (review M2).
    expect(sent.every((ev) => ev.kind === ECHO_KIND && !ev.tags.some((t) => t[0] === 'd'))).toBe(true);
    expect(r.events.filter((ev) => ev.pubkey === rx.carrierPubkey)).toEqual([]);
  });

  it("strangers' junk on our tag does not keep the echo quiet (review L2)", async () => {
    const r = await relay();
    const me = generateKey();
    const rx = new NostrTransport({ key: me, relays: [r.url], echoIntervalMs: 300 });
    open.push(rx);
    rx.onEnvelopes(me.id, () => {});
    const spam = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(spam);
    const junk = { ...sealEnvelope(generateKey(), me.id, { type: 'note' }, { seq: 1, prev: null }), sig: 'AAAA' } as Envelope;
    for (let i = 0; i < 12; i++) {
      await spam.sendEnvelope({ ...junk, created: new Date(Date.now() - i).toISOString() } as Envelope);
      await settle(100);
    }
    expect(r.ephemeral.filter((ev) => ev.pubkey === rx.carrierPubkey).length).toBeGreaterThan(0);
  });

  it('a failed echo publish leaves the relay record alone (review L1)', async () => {
    const r = await relay();
    const me = generateKey();
    const links: RelayLink[] = [];
    const rx = new NostrTransport({ key: me, relays: [r.url], echoIntervalMs: 150, onRelayLink: (l) => links.push(l) });
    open.push(rx);
    rx.onEnvelopes(me.id, () => {});
    await until(() => links.some((l) => l.up));
    const n = r.received.length;
    r.faults.okFalse = 'blocked: not today';
    await until(() => r.received.length > n + 1); // at least two echoes refused
    const [st] = rx.relayStatus();
    expect(st.last_error).toBeNull();
    expect(st.cooldown_until).toBeNull();
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
    const { agent: john, pipe } = make([r.url], { transport: { reconnectMinDownMs: 0 } });
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

describe('review of #112', () => {
  it('a relay that answers EOSE and then CLOSED does not make us republish every second (H2)', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((res) => wss.once('listening', () => res()));
    open.push({ close: () => new Promise<void>((res) => wss.close(() => res())) });
    let reqs = 0;
    wss.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        if (m[0] === 'REQ') {
          reqs++;
          ws.send(JSON.stringify(['EOSE', m[1]]));
          setTimeout(() => ws.send(JSON.stringify(['CLOSED', m[1], 'error: too many subscriptions'])), 50);
        }
        if (m[0] === 'EVENT') ws.send(JSON.stringify(['OK', m[1].id, true, '']));
      }),
    );
    const flappy = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
    const r = await relay();
    const { agent: omer, pipe: opipe } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0);
    const slow = { ...FAST, retryAfterMs: 600_000 };
    john.receiptTiming = slow;
    opipe.lose = true; // Omer's receipts are lost: John's messages stay unconfirmed
    pipe.lose = true;
    for (let i = 0; i < 5; i++) await john.send(omer.id, { type: 'note', text: `m${i}` });
    pipe.lose = false;
    const t2 = new NostrTransport({ key: john.key, relays: [r.url, flappy], maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 200, retryBaseMs: 20, echoIntervalMs: 0 });
    const reconnects: string[] = [];
    t2.onReconnect((url) => reconnects.push(url));
    const john2 = Agent.fromJSON(john.toJSON(), () => t2);
    john.stop();
    john2.receiptTiming = slow;
    open.push(john2);
    const resent = events(john2, 'delivery-resent');
    john2.start();
    await settle(4000);
    // Each flap waits longer (the backoff starts over only after 10 s up), and a blip under 3 s is no reconnect.
    expect(reqs).toBeLessThanOrEqual(6);
    expect(reconnects.length).toBeLessThanOrEqual(1);
    // And however many reconnects come, a contact gets one republish per retryAfterMs.
    for (let i = 0; i < 5; i++) await john2.resendUnconfirmed();
    expect(resent.filter(([e]) => e.reason === 'reconnect').length).toBeLessThanOrEqual(1);
  });

  it('a message unconfirmed in a backup is not reported delivered after the restore (M1)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    pipe.lose = true;
    const lost = await john.send(omer.id, { type: 'note', text: 'never arrives' });
    const backup = john.toJSON();
    john.close();
    expect(pendingInBackup(backup)).toBe(1);
    const state = restoredAgentState(backup, { backupCreated: new Date().toISOString() });
    expect(state.delivery).toBeUndefined();
    const t2 = new NostrTransport({ key: john.key, relays: [r.url], maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20 });
    const john2 = Agent.fromJSON(state, () => t2);
    john2.receiptTiming = FAST;
    open.push(john2);
    const confirmed = events(john2, 'delivery-confirmed');
    john2.start();
    await settle(300);
    const after = await john2.send(omer.id, { type: 'note', text: 'after restore' });
    await until(() => john2.deliveryOf(omer.id, after.seq) === 'delivered');
    expect(john2.deliveryOf(omer.id, lost.seq)).toBe('untracked'); // never "delivered": nobody holds it
    expect(confirmed).toEqual([]);
  });

  it('when a contact restores from a backup, what we resend it is waited for again (L3)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    const m1 = await omer.send(john.id, { type: 'note', text: 'm1' });
    await until(() => omer.deliveryOf(john.id, m1.seq) === 'delivered');
    const backup = structuredClone(john.toJSON()); // John's backup holds m1 (a copy: toJSON shares live state)
    const m2 = await omer.send(john.id, { type: 'note', text: 'm2' });
    await until(() => omer.deliveryOf(john.id, m2.seq) === 'delivered');
    john.close();
    // The relay has since dropped m2 (retention), so the restored John cannot catch it up: only Omer's outbox has it.
    const i = r.events.findIndex((ev) => { const e = JSON.parse(ev.content) as Envelope; return e.from === omer.id && e.seq === m2.seq; });
    r.events.splice(i, 1);
    const t2 = new NostrTransport({ key: john.key, relays: [r.url], maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20 });
    const john2 = Agent.fromJSON(restoredAgentState(backup, { backupCreated: new Date().toISOString() }), () => t2);
    john2.receiptTiming = FAST;
    open.push(john2);
    let seen: string | undefined;
    omer.once('contact-restored', () => queueMicrotask(() => (seen = omer.deliveryOf(john.id, m2.seq))));
    const got = new Promise<AgentEvents['message']>((res) => john2.once('message', (...a) => res(a)));
    john2.start();
    await settle(200);
    await john2.sendRestoredNotices();
    const [, payload] = await got; // m2 again, from Omer's outbox
    expect(payload).toMatchObject({ text: 'm2' });
    expect(seen).toBe('pending'); // John's backup never had it: it is waited for again
    await until(() => omer.deliveryOf(john.id, m2.seq) === 'delivered');
  });
});

describe('re-review of #112', () => {
  it("an old receipt replayed after the contact restored does not confirm what we resent it (H-NEW-1)", async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john, pipe } = make([r.url]);
    await contacts(omer, john);
    const m1 = await john.send(omer.id, { type: 'note', text: 'm1' });
    await until(() => john.deliveryOf(omer.id, m1.seq) === 'delivered');
    const omerBackup = structuredClone(omer.toJSON());
    const m2 = await john.send(omer.id, { type: 'note', text: 'm2' });
    await until(() => john.deliveryOf(omer.id, m2.seq) === 'delivered');
    const oldAck = between(r, omer, john).filter((e) => e.seq === 0).pop()!;
    omer.close();
    // Relay retention ran out for m2: the restored Omer can only get it from John's outbox.
    for (let i = r.events.length - 1; i >= 0; i--) {
      const e = JSON.parse(r.events[i].content) as Envelope;
      if (e.from === john.id && e.seq >= m2.seq) r.events.splice(i, 1);
    }
    const t2 = new NostrTransport({ key: omer.key, relays: [r.url], maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20 });
    const omer2 = Agent.fromJSON(restoredAgentState(omerBackup, { backupCreated: new Date().toISOString() }), () => t2);
    omer2.receiptTiming = FAST;
    omer2.sendReceipts = false; // the restored Omer never confirms, so only the replay could
    open.push(omer2);
    omer2.start();
    await settle(300);
    pipe.lose = true; // John's resend to Omer is lost too: m2 never reaches him
    const restored = new Promise((res) => john.once('contact-restored', res));
    await omer2.sendRestoredNotices();
    await restored;
    await until(() => john.deliveryOf(omer.id, m2.seq) === 'pending');
    const dropped = events(john, 'dropped');
    const attacker = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(attacker);
    await attacker.sendEnvelope(oldAck, [r.url]);
    await until(() => dropped.some(([reason]) => reason === 'ack replay from before the floor'));
    expect(john.deliveryOf(omer.id, m2.seq)).toBe('pending');
    expect(john.toJSON().delivery?.[omer.id]?.ack_floor).toBeTruthy(); // persisted
  });

  it('an old receipt replayed after a revoke and a new contact does not confirm the new messages', async () => {
    const r = await relay();
    const { agent: omer, pipe: opipe } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    let last!: Envelope;
    for (let i = 0; i < 3; i++) last = await john.send(omer.id, { type: 'note', text: `old${i}` });
    await until(() => john.deliveryOf(omer.id, last.seq) === 'delivered');
    const oldAck = between(r, omer, john).filter((e) => e.seq === 0).pop()!;
    await john.revoke(omer.id);
    await settle(1100); // the new period's request is dated in a later second
    await contacts(omer, john);
    opipe.lose = true; // Omer's real receipts are lost
    let m!: Envelope;
    do m = await john.send(omer.id, { type: 'note', text: 'new' });
    while ((john.channels.state[omer.id]?.outSeq ?? 0) < last.seq);
    const dropped = events(john, 'dropped');
    const attacker = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(attacker);
    await attacker.sendEnvelope(oldAck, [r.url]);
    await until(() => dropped.some(([reason]) => reason === 'ack replay from before the floor'));
    expect(john.deliveryOf(omer.id, m.seq)).toBe('pending');
  });

  it('re-acks are one per window per peer, and the window never runs out (L-NEW-1)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    john.receiptTiming = { ...FAST, retryAfterMs: 400 }; // a 200 ms window
    const old = between(r, omer, john).find((e) => e.seq > 0)!;
    const acks = () => between(r, john, omer).filter((e) => e.seq === 0).length;
    // The same envelope from new carrier keys each time, so the relay passes every copy on.
    const replay = async () => {
      const t = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
      open.push(t);
      await t.sendEnvelope(old, [r.url]);
    };
    const before = acks();
    for (let round = 0; round < 3; round++) {
      await Promise.all([replay(), replay(), replay()]); // three in one window: one receipt
      await settle(1000);
    }
    expect(acks() - before).toBe(3); // one per window, in every window
  });

  it('a partial or bad timing falls back to the defaults instead of throwing (L-NEW-3)', async () => {
    expect(receiptTimingOf({ ackDelayMs: 50 })).toEqual({ ...RECEIPT_TIMING, ackDelayMs: 50 });
    expect(receiptTimingOf({ retryAfterMs: Number.NaN, maxRetries: -1, ackJitterMs: Infinity })).toEqual(RECEIPT_TIMING);
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    omer.receiptTiming = { ackDelayMs: 40, ackMinIntervalMs: 80, retryAfterMs: 250, maxRetries: 2 } as ReceiptTiming; // no ackJitterMs
    expect(omer.receiptTiming.ackJitterMs).toBe(RECEIPT_TIMING.ackJitterMs);
    omer.receiptTiming = { ...omer.receiptTiming, ackJitterMs: 0 };
    await contacts(omer, john);
    const env = await john.send(omer.id, { type: 'note', text: 'no crash' });
    await until(() => john.deliveryOf(omer.id, env.seq) === 'delivered');
  });

  it('the echo expires in a minute, and our subscription ignores an expired event (M2)', async () => {
    const r = await relay();
    const me = generateKey();
    const rx = new NostrTransport({ key: me, relays: [r.url], echoIntervalMs: 150 });
    open.push(rx);
    const got: unknown[] = [];
    rx.onEnvelopes(me.id, (e) => got.push(e));
    await until(() => r.ephemeral.some((ev) => ev.pubkey === rx.carrierPubkey));
    const echo = r.ephemeral.find((ev) => ev.pubkey === rx.carrierPubkey)!;
    const exp = Number(echo.tags.find((t) => t[0] === 'expiration')?.[1]);
    expect(exp - echo.created_at).toBe(ECHO_EXPIRES_S);
    // A stranger's envelope that has expired: the relay passes it on live, we drop it.
    const sender = generateKey();
    const env = sealEnvelope(sender, me.id, { type: 'note' }, { seq: 1, prev: null });
    const stale = finalizeEvent(
      { kind: 30417, created_at: Math.floor(Date.now() / 1000) - 120, tags: [['p', agentTag(me.id)], ['d', envelopeHash(env)], ['expiration', String(Math.floor(Date.now() / 1000) - 60)]], content: JSON.stringify(env) },
      generateSecretKey(),
    );
    const ws = new WebSocket(r.url);
    await new Promise((res) => ws.once('open', res));
    ws.send(JSON.stringify(['EVENT', stale]));
    await settle(400);
    ws.close();
    expect(got).toEqual([]);
  });

  it("a stranger's valid envelope does not count as traffic when the agent says who its contacts are (L2)", async () => {
    const r = await relay();
    const me = generateKey();
    const rx = new NostrTransport({ key: me, relays: [r.url], echoIntervalMs: 300 });
    open.push(rx);
    rx.setTrafficFilter(() => false); // nobody sending is a contact
    rx.onEnvelopes(me.id, () => {});
    const tx = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(tx);
    const stranger = generateKey();
    for (let i = 1; i <= 12; i++) {
      await tx.sendEnvelope(sealEnvelope(stranger, me.id, { type: 'note' }, { seq: i, prev: null }));
      await settle(100);
    }
    expect(r.ephemeral.filter((ev) => ev.pubkey === rx.carrierPubkey).length).toBeGreaterThan(0);
  });
});

describe('issue #113', () => {
  /**
   * John never confirmed Omer's request (Omer was no contact yet), so its first copy earns the receipt it never had,
   * outside any re-ack count (review H1 above). Spend that first, and let John's re-ack window pass.
   */
  async function warmUp(r: TestRelay, omer: Agent, john: Agent, old: Envelope) {
    const acks = () => between(r, john, omer).filter((e) => e.seq === 0).length;
    const before = acks();
    const t = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(t);
    await t.sendEnvelope(old, [r.url]);
    await until(() => acks() > before);
    await settle(250);
    delete (john as unknown as { delivery: Record<string, PeerDelivery> }).delivery[omer.id].reack_day;
  }

  /**
   * Omer, restored from a backup taken after m1 and before m2; John's resend of m2 is lost for now. `slow`: the
   * contact began two hours ago, m1 and m2 went 30 minutes ago (so Omer's last receipt is that old), and the
   * restored Omer's clock is an hour behind, so his notice says an hour ago. Everything runs on a fake clock
   * that moves with real time; only the stamps differ.
   */
  async function restoredOmer(r: TestRelay, slow: boolean) {
    const real = Date.now();
    if (slow) vi.useFakeTimers({ toFake: ['Date'], now: real - 2 * 3_600_000, shouldAdvanceTime: true });
    try {
      const { agent: omer } = make([r.url]);
      const { agent: john, pipe } = make([r.url]);
      await contacts(omer, john);
      if (slow) vi.setSystemTime(real - 30 * 60_000);
      const m1 = await john.send(omer.id, { type: 'note', text: 'm1' });
      await until(() => john.deliveryOf(omer.id, m1.seq) === 'delivered');
      const omerBackup = structuredClone(omer.toJSON());
      const m2 = await john.send(omer.id, { type: 'note', text: 'm2' });
      await until(() => john.deliveryOf(omer.id, m2.seq) === 'delivered');
      const oldAck = between(r, omer, john).filter((e) => e.seq === 0).pop()!;
      omer.close();
      for (let i = r.events.length - 1; i >= 0; i--) {
        const e = JSON.parse(r.events[i].content) as Envelope;
        if (e.from === john.id && e.seq >= m2.seq) r.events.splice(i, 1); // retention ran out for m2
      }
      if (slow) vi.setSystemTime(real);
      const pipe2 = new LossyTransport(new NostrTransport({ key: omer.key, relays: [r.url], maxEventsPerSecond: 1000, burst: 1000, reconnectBaseMs: 30, retryBaseMs: 20 }));
      const omer2 = Agent.fromJSON(restoredAgentState(omerBackup, { backupCreated: new Date().toISOString() }), () => pipe2);
      omer2.receiptTiming = FAST;
      open.push(omer2);
      omer2.start();
      await settle(300);
      pipe.lose = true;
      // The notice is sealed on Omer's clock and published as it is; John gets it on his own.
      pipe2.lose = true;
      if (slow) vi.setSystemTime(Date.now() - 3_600_000);
      await omer2.sendRestoredNotices();
      if (slow) vi.useRealTimers();
      pipe2.lose = false;
      const restored = new Promise((res) => john.once('contact-restored', res));
      for (const e of pipe2.lost.splice(0)) await pipe2.real.sendEnvelope(e, [r.url]);
      await restored;
      await until(() => john.deliveryOf(omer.id, m2.seq) === 'pending');
      return { omer2, john, pipe, oldAck, m2 };
    } finally {
      vi.useRealTimers();
    }
  }

  it('a contact restoring onto a clock far behind cannot let a pre-restore receipt through (floor)', async () => {
    const r = await relay();
    const { omer2, john, oldAck, m2 } = await restoredOmer(r, true);
    omer2.sendReceipts = false; // the restored Omer never confirms, so only the replay could
    const floor = Date.parse(john.toJSON().delivery![omer2.id].ack_floor!);
    expect(floor).toBeGreaterThan(Date.now() - 6 * 60_000); // our receipt time minus the skew, not the hour-old stamp
    // The replay is 30 minutes old: newer than the notice says, so a floor from the notice alone let it in.
    expect(Date.parse(oldAck.created)).toBeGreaterThan(Date.now() - 3_600_000);
    expect(Date.parse(oldAck.created)).toBeLessThan(floor);
    const dropped = events(john, 'dropped');
    const attacker = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(attacker);
    await attacker.sendEnvelope(oldAck, [r.url]);
    await until(() => dropped.some(([reason]) => reason === 'ack replay from before the floor'));
    expect(john.deliveryOf(omer2.id, m2.seq)).toBe('pending');
    // Persisted with the delivery state.
    expect(Date.parse((john.toJSON().delivery as Record<string, PeerDelivery>)[omer2.id].ack_floor!)).toBe(floor);
  });

  it('a contact restoring with a normal clock still gets its new receipts taken (floor)', async () => {
    const r = await relay();
    const { omer2, john, pipe, m2 } = await restoredOmer(r, false);
    pipe.lose = false;
    // Omer gets m2 again from John's next retry and confirms it: his new receipt is past the floor.
    await until(() => john.deliveryOf(omer2.id, m2.seq) === 'delivered', 15_000);
  });

  it('duplicate-triggered receipts are capped per contact per day; fresh envelopes are still confirmed (cap)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    const old = between(r, omer, john).find((e) => e.seq > 0)!;
    const acks = () => between(r, john, omer).filter((e) => e.seq === 0).length;
    const replay = async () => {
      const t = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
      open.push(t);
      await t.sendEnvelope(old, [r.url]);
    };
    await warmUp(r, omer, john, old);
    john.receiptTiming = { ...FAST, retryAfterMs: 2, reackPerDay: 3 }; // a 1 ms window: only the cap holds them back
    const before = acks();
    for (let i = 0; i < 6; i++) {
      await replay();
      await settle(250); // past the quiet period and the minimum interval: each re-ack would go out on its own
    }
    expect(acks() - before).toBe(3);
    expect(john.toJSON().delivery?.[omer.id]?.reack_day?.n).toBe(3); // persisted, one small record per contact
    // A fresh envelope is confirmed as always, cap or not.
    const env = await omer.send(john.id, { type: 'note', text: 'fresh' });
    await until(() => omer.deliveryOf(john.id, env.seq) === 'delivered');
    expect(john.toJSON().delivery?.[omer.id]?.reack_day?.n).toBe(3);
  });

  it('the daily count starts over after 24 h, and a bad stored count does not throw (cap)', async () => {
    const r = await relay();
    const { agent: omer } = make([r.url]);
    const { agent: john } = make([r.url]);
    await contacts(omer, john);
    await until(() => john.deliveryStatus(omer.id).waiting === 0 && omer.deliveryStatus(john.id).waiting === 0);
    const old = between(r, omer, john).find((e) => e.seq > 0)!;
    await warmUp(r, omer, john, old);
    john.receiptTiming = { ...FAST, retryAfterMs: 2, reackPerDay: 1 };
    const d = (john as unknown as { delivery: Record<string, PeerDelivery> }).delivery[omer.id];
    d.reack_day = { since: new Date(Date.now() - 25 * 3_600_000).toISOString(), n: 1 }; // yesterday's window, spent
    const acks = () => between(r, john, omer).filter((e) => e.seq === 0).length;
    const before = acks();
    const t = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(t);
    await t.sendEnvelope(old, [r.url]);
    await until(() => acks() - before === 1);
    expect(d.reack_day?.n).toBe(1);
    expect(Date.parse(d.reack_day!.since)).toBeGreaterThan(Date.now() - 60_000);
    d.reack_day = { since: 'garbage', n: Number.NaN } as unknown as PeerDelivery['reack_day'];
    await settle(250);
    const t2 = new NostrTransport({ key: generateKey(), relays: [r.url], maxEventsPerSecond: 1000, burst: 1000 });
    open.push(t2);
    await t2.sendEnvelope(old, [r.url]);
    await until(() => acks() - before === 2);
  });
});
