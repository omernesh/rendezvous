import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  type ChannelState,
  Channels,
  createCard,
  createReverseGrant,
  dtopic,
  type Envelope,
  generateKey,
  NostrTransport,
  openEnvelope,
  type Payload,
  REVERSE_GRANT_LIMIT,
  sealEnvelope,
  type Transport,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

function waitFor<T>(agent: Agent, event: 'request' | 'candidate' | 'contact' | 'message' | 'revoked', ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    agent.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve((args.length === 1 ? args[0] : args) as T);
    });
  });
}

/** A topic probe's grant is only a candidate: the owner confirms it (security review H1). */
async function confirmNext(agent: Agent): Promise<unknown> {
  const c = await waitFor<{ grant: { id: string } }>(agent, 'candidate');
  return agent.confirmCandidate(c.grant.id);
}

describe('two agents over a Nostr relay', () => {
  let relay: TestRelay;
  let agents: Agent[] = [];

  beforeEach(async () => {
    relay = await startTestRelay();
  });
  afterEach(async () => {
    for (const a of agents) a.close();
    agents = [];
    await relay.close();
  });

  const make = (email: string, opts: { pointer?: boolean } = {}) => {
    const a = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [relay.url] }), {
      rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }],
      discovery: { addresses: [{ type: 'email', value: email }], public_pointer: !!opts.pointer },
      policy: { public: !!opts.pointer },
    });
    a.on('error', (e) => {
      throw e;
    });
    a.start();
    agents.push(a);
    return a;
  };

  it('discovers by email (listen mode), asks consent, then exchanges encrypted messages', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200)); // let subscriptions settle

    const pending = waitFor<{ request: { id: string; greeting: string } }>(john, 'request');
    await omer.requestContact('John@Doe.com', "Omer's agent would like to plan dinner.");
    const req = await pending;
    expect(req.request.greeting).toContain('dinner');
    expect(john.contacts()).toHaveLength(0);

    const omerSeesGrant = confirmNext(omer);
    const grantedContact = await john.grant(req.request.id, { tier: 'friend' });
    expect(grantedContact.peer).toBe(omer.id);
    await omerSeesGrant;
    expect(omer.contacts().map((c) => c.peer)).toEqual([john.id]);

    const got = waitFor<[string, Payload, Envelope]>(john, 'message');
    await omer.send(john.id, { type: 'a2a/message', text: 'Thursday 20:00?' });
    const [from, payload] = await got;
    expect(from).toBe(omer.id);
    expect(payload).toEqual({ type: 'a2a/message', text: 'Thursday 20:00?' });

    const reply = waitFor<[string, Payload]>(omer, 'message');
    await john.send(omer.id, { type: 'a2a/message', text: 'Works for me.' });
    expect((await reply)[1].text).toBe('Works for me.');

    // The relay only ever saw ciphertext.
    expect(relay.events.map((e) => e.content).join('')).not.toContain('Thursday');
  });

  it('finds a public pointer, contacts by card, and stops after revocation', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com', { pointer: true });
    await john.publishPointers();
    const cards = await omer.lookup('john@doe.com');
    expect(cards.map((c) => c.id)).toEqual([john.id]);

    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(cards[0], 'hello');
    const req = await pending;
    const contact = waitFor(omer, 'contact');
    await john.grant(req.request.id);
    await contact;
    expect(john.contacts()[0].tier).toBe('stranger'); // claimed binding default
    expect(omer.contacts()[0].binding).toBe('claimed'); // a public pointer is self-asserted

    const revoked = waitFor(omer, 'revoked');
    await john.revoke(omer.id);
    await revoked;
    await expect(omer.send(john.id, { type: 'a2a/message' })).rejects.toThrow(/no active contact/);
  });

  it('ignores a probe re-posted on another address topic (security review L2)', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    const carol = make('carol@example.com');
    await new Promise((r) => setTimeout(r, 200));
    const dropped = new Promise<string>((resolve) => carol.once('dropped', (reason) => resolve(reason)));
    const johnSees = waitFor(john, 'request');
    const req = await omer.requestContact('john@doe.com', 'hi'); // meant for John
    await johnSees;
    // Someone else copies it onto Carol's topic. (From another Nostr key: the same content from the same key has the
    // same `d`, so a NIP-01 relay, the test relay included, would keep only one of the two events.)
    const mallory = new NostrTransport({ key: generateKey(), relays: [relay.url] });
    await mallory.publishTopic(dtopic({ type: 'email', value: 'carol@example.com' }), req);
    mallory.close();
    expect(await dropped).toBe('topic doc is not a probe for this topic');
    expect(carol.pendingRequests()).toEqual([]);
  });

  it('several addresses: a probe on each reaches the agent; after removal it does not, and a running agent re-subscribes live', async () => {
    const omer = make('omer@example.com');
    const john = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [relay.url] }), {
      rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }],
      discovery: {
        addresses: [
          { type: 'email', value: 'john@doe.com' },
          { type: 'email', value: 'john@work.doe.com' },
          { type: 'phone', value: '+15555550123' },
          { type: 'phone', value: '+15555550124' },
        ],
        public_pointer: false,
      },
    });
    john.on('error', (e) => {
      throw e;
    });
    john.start();
    agents.push(john);
    await new Promise((r) => setTimeout(r, 200));
    for (const addr of ['john@doe.com', 'JOHN@work.doe.com', '+1 555 555 0123', '+15555550124']) {
      const seen = waitFor<{ request: { id: string; to_hint: string } }>(john, 'request');
      await omer.requestContact(addr, `hi ${addr}`);
      const p = await seen;
      expect(p.request.to_hint).toBe(addr);
      john.decline(p.request.id); // a sender may have only a few pending at once
    }

    // Live: drop the work email, add a third phone, without restarting.
    const before = john.card;
    const r = john.setAddresses([
      { type: 'email', value: 'john@doe.com' },
      { type: 'phone', value: '+15555550123' },
      { type: 'phone', value: '+15555550124' },
      { type: 'phone', value: '+1-555-555-0125' },
    ]);
    expect(r.added).toEqual([{ type: 'phone', value: '+15555550125' }]);
    expect(r.removed).toEqual([{ type: 'email', value: 'john@work.doe.com' }]);
    expect(Date.parse(john.card.created)).toBeGreaterThan(Date.parse(before.created));
    expect(john.topics()).not.toContain(dtopic({ type: 'email', value: 'john@work.doe.com' }));
    await new Promise((r) => setTimeout(r, 200));
    const added = waitFor<{ request: { to_hint: string } }>(john, 'request');
    await omer.requestContact('+15555550125', 'new phone');
    expect((await added).request.to_hint).toBe('+15555550125');
    // The removed topic is no longer subscribed: a probe there never arrives.
    const got: string[] = [];
    john.on('request', (p) => got.push(p.request.to_hint));
    john.on('dropped', (reason) => got.push(reason));
    await omer.requestContact('john@work.doe.com', 'old email');
    await new Promise((r) => setTimeout(r, 400));
    expect(got).toEqual([]);
    // Even fed by hand (a listener that has not re-subscribed yet), it is refused.
    const req = (await import('../src/index.js')).createContactRequest(omer.key, omer.card, { toHint: 'john@work.doe.com', greeting: 'x' });
    const dropped = new Promise<string>((resolve) => john.once('dropped', (reason) => resolve(reason)));
    (john as unknown as { handleTopicDoc(d: unknown, t: string): Promise<void> }).handleTopicDoc(req, dtopic({ type: 'email', value: 'john@work.doe.com' }));
    expect(await dropped).toBe('topic doc is not a probe for this topic');
    // Too many, or a bad one: refused, card unchanged.
    const card = john.card;
    expect(() => john.setAddresses(Array.from({ length: 9 }, (_, i) => ({ type: 'email' as const, value: `john+${i}@doe.com` })))).toThrow(/too many/);
    expect(() => john.setAddresses([{ type: 'phone', value: '555' }])).toThrow();
    expect(john.card).toBe(card);
  }, 20_000);

  it('a removed address leaves the public pointer: the newer card replaces the old one on its topic', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com', { pointer: true });
    john.setAddresses([
      { type: 'email', value: 'john@doe.com' },
      { type: 'email', value: 'john@work.doe.com' },
    ]);
    expect(await john.publishPointers()).toHaveLength(2);
    expect((await omer.lookup('john@work.doe.com')).map((c) => c.id)).toEqual([john.id]);
    const old = (await omer.lookup('john@work.doe.com'))[0];

    const { removed } = john.setAddresses([{ type: 'email', value: 'john@doe.com' }]);
    expect(await john.publishPointers(removed)).toEqual([dtopic({ type: 'email', value: 'john@doe.com' }), dtopic({ type: 'email', value: 'john@work.doe.com' })]);
    expect(await omer.lookup('john@work.doe.com')).toEqual([]);
    expect((await omer.lookup('john@doe.com')).map((c) => c.created)).toEqual([john.card.created]);
    // One card event per topic on the relay (replaceable), not one per version.
    const workTopic = dtopic({ type: 'email', value: 'john@work.doe.com' });
    const onWork = relay.events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === workTopic));
    expect(onWork).toHaveLength(1);
    expect(JSON.parse(onWork[0].content).created).toBe(john.card.created);
    // Someone replays the old card on the topic: the newer one still wins.
    await omer.transport.publishTopic(workTopic, old);
    expect(await omer.lookup('john@work.doe.com')).toEqual([]);
  });

  it('ignores messages from strangers', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200));
    const dropped = new Promise<string>((resolve) => john.once('dropped', (reason) => resolve(reason)));
    // Bypass Agent.send's own check by sealing directly.
    const { sealEnvelope } = await import('../src/index.js');
    await omer.transport.sendEnvelope(sealEnvelope(omer.key, john.id, { type: 'a2a/message' }, { seq: 1, prev: null }));
    expect(await dropped).toBe('no grant for sender');
  });

  it('survives a save/restore round-trip', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200));
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact('john@doe.com', 'hi');
    const contact = confirmNext(omer);
    await john.grant((await pending).request.id);
    await contact;

    const saved = JSON.parse(JSON.stringify(omer.toJSON()));
    omer.close();
    agents = agents.filter((a) => a !== omer);
    const restored = Agent.fromJSON(saved, (key) => new NostrTransport({ key, relays: [relay.url] }));
    agents.push(restored);
    restored.start();
    expect(restored.id).toBe(omer.id);

    const got = waitFor<[string, Payload]>(john, 'message');
    await restored.send(john.id, { type: 'a2a/message', text: 'still me' });
    expect((await got)[1].text).toBe('still me');
  });

  it('persists seq before an envelope leaves, so a crash after send cannot fork the chain (issue #4)', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200));
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact('john@doe.com', 'hi');
    const contact = confirmNext(omer);
    await john.grant((await pending).request.id);
    await contact;
    const beforeCrash = JSON.parse(JSON.stringify(omer.toJSON())); // what a save-after-send caller had on disk
    omer.close();
    agents = agents.filter((a) => a !== omer);

    // The process "dies" right after the envelope goes out: the caller never
    // gets to save. Only what beforeSend persisted survives.
    let disk = beforeCrash;
    const crashing = Agent.fromJSON(structuredClone(beforeCrash), (key) => {
      const real = new NostrTransport({ key, relays: [relay.url] });
      const t: Transport = {
        sendEnvelope: async (e, r) => {
          await real.sendEnvelope(e, r);
          throw new Error('crash after send');
        },
        onEnvelopes: (me, h) => real.onEnvelopes(me, h),
        publishTopic: (topic, doc, extra) => real.publishTopic(topic, doc, extra),
        onTopics: (topics, h) => real.onTopics(topics, h),
        fetchTopic: (topic, ms) => real.fetchTopic(topic, ms),
        close: () => real.close(),
      };
      return t;
    });
    crashing.beforeSend = (a) => {
      disk = JSON.parse(JSON.stringify(a.toJSON()));
    };
    const drops: string[] = [];
    john.on('dropped', (reason) => drops.push(reason));
    const got: Payload[] = [];
    john.on('message', (_from, p) => got.push(p));
    await expect(crashing.send(john.id, { type: 'a2a/message', text: 'first' })).rejects.toThrow('crash after send');
    crashing.close();

    // Without the fix the restart would reuse seq 1 from the stale state.
    expect(beforeCrash.channels[john.id].outSeq).toBe(0);
    expect(disk.channels[john.id].outSeq).toBe(1);

    const restarted = Agent.fromJSON(disk, (key) => new NostrTransport({ key, relays: [relay.url] }));
    agents.push(restarted);
    const env = await restarted.send(john.id, { type: 'a2a/message', text: 'second' });
    expect(env.seq).toBe(2);
    const deadline = Date.now() + 5000;
    while (got.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(got.map((p) => p.text)).toEqual(['first', 'second']);
    expect(drops).toEqual([]);
  });

  it('sends nothing when beforeSend fails', async () => {
    const sent: Envelope[] = [];
    const t: Transport = {
      sendEnvelope: async (e) => void sent.push(e),
      onEnvelopes: () => () => {},
      publishTopic: async () => {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close: () => {},
    };
    const a = Agent.create(() => t, { rendezvous: [{ type: 'nostr', relay: 'ws://x', pref: 1 }] });
    const peer = generateKey();
    const peerCard = createCard(peer, { rendezvous: [{ type: 'nostr', relay: 'ws://x', pref: 1 }] });
    a.beforeSend = () => {
      throw new Error('disk full');
    };
    await expect(a.requestContact(peerCard, 'hi')).rejects.toThrow('disk full');
    expect(sent).toHaveLength(0);
  });
});

describe('ordering over a lossy pipe', () => {
  it('buffers out-of-order envelopes and recovers a dropped one via resend', async () => {
    // A shared in-memory bus whose first delivery of seq 2 (omer → john) is lost.
    const handlers = new Map<string, (e: unknown) => void>();
    let dropped = false;
    const bus = (): Transport => ({
      async sendEnvelope(e) {
        if (!dropped && e.seq === 2 && e.to === johnId) {
          dropped = true;
          return;
        }
        queueMicrotask(() => handlers.get(e.to)?.(structuredClone(e)));
      },
      onEnvelopes(me, h) {
        handlers.set(me, h);
        return () => handlers.delete(me);
      },
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };
    const omer = Agent.create(bus, card);
    const john = Agent.create(bus, card);
    const johnId = john.id;
    omer.start();
    john.start();

    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(john.card, 'hi'); // omer→john seq 1
    const contact = waitFor(omer, 'contact');
    await john.grant((await pending).request.id);
    await contact;

    const texts: string[] = [];
    john.on('message', (_p, payload) => texts.push(String(payload.text)));
    await omer.send(john.id, { type: 'a2a/message', text: 'two' }); // seq 2, lost
    await omer.send(john.id, { type: 'a2a/message', text: 'three' }); // seq 3 → gap → resend
    for (let i = 0; i < 20 && texts.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await john.idle();
      await omer.idle();
    }
    expect(texts).toEqual(['two', 'three']);
  });
});

describe('requester-side binding and restart safety', () => {
  // A shared in-memory bus; `hold` decides which deliveries to swallow.
  function makeBus(hold: (e: Envelope) => boolean) {
    const handlers = new Map<string, (e: unknown) => void>();
    const bus = (): Transport => ({
      async sendEnvelope(e) {
        if (hold(e)) return;
        queueMicrotask(() => handlers.get(e.to)?.(structuredClone(e)));
      },
      onEnvelopes(me, h) {
        handlers.set(me, h);
        return () => handlers.delete(me);
      },
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    return { bus, handlers };
  }
  const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };

  async function connect(omer: Agent, john: Agent, binding?: 'in-person') {
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(john.card, 'hi', { binding });
    const contact = waitFor(omer, 'contact');
    await john.grant((await pending).request.id);
    await contact;
  }

  it('records the binding the requester actually used', async () => {
    const { bus } = makeBus(() => false);
    const omer = Agent.create(bus, card);
    const john = Agent.create(bus, card);
    omer.start();
    john.start();
    await connect(omer, john, 'in-person');
    expect(omer.book.contact(john.id)?.binding).toBe('in-person');
  });

  it('keeps buffered out-of-order envelopes across save/restore', async () => {
    let holdSeq2 = true;
    let johnId = '';
    const { bus, handlers } = makeBus((e) => holdSeq2 && e.to === johnId && e.seq === 2);
    const omer = Agent.create(bus, card);
    const john = Agent.create(bus, card);
    johnId = john.id;
    omer.start();
    john.start();
    await connect(omer, john);

    await omer.send(john.id, { type: 'a2a/message', text: 'two' }); // seq 2, held
    await omer.send(john.id, { type: 'a2a/message', text: 'three' }); // seq 3, buffered by john
    await new Promise((r) => setTimeout(r, 20));
    await john.idle();
    expect(john.toJSON().buffer?.[omer.id]?.map((e) => e.seq)).toEqual([3]);

    const saved = JSON.parse(JSON.stringify(john.toJSON()));
    john.stop();
    const restored = Agent.fromJSON(saved, bus);
    const texts: string[] = [];
    restored.on('message', (_p, payload) => texts.push(String(payload.text)));
    restored.start();

    holdSeq2 = false;
    const seq2 = omer.toJSON().outbox[john.id].find((e) => e.seq === 2)!;
    handlers.get(john.id)?.(structuredClone(seq2));
    await new Promise((r) => setTimeout(r, 20));
    await restored.idle();
    expect(texts).toEqual(['two', 'three']);
  });
});

describe('reverse grant (issue #14)', () => {
  const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };
  function bus() {
    const handlers = new Map<string, (e: unknown) => void>();
    const t = (): Transport => ({
      async sendEnvelope(e) {
        queueMicrotask(() => handlers.get(e.to)?.(structuredClone(e)));
      },
      onEnvelopes(me, h) {
        handlers.set(me, h);
        return () => handlers.delete(me);
      },
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    return { t, deliver: (e: Envelope) => handlers.get(e.to)?.(structuredClone(e)) };
  }
  const settle = async (...agents: Agent[]) => {
    await new Promise((r) => setTimeout(r, 20));
    for (const a of agents) await a.idle();
  };

  it("the requester's human grants back: the grantor learns it may propose meetings; strangers and revocation can't keep it", async () => {
    const { t, deliver } = bus();
    const omer = Agent.create(t, card);
    const john = Agent.create(t, card);
    omer.start();
    john.start();
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(john.card, 'hi');
    const contact = waitFor(omer, 'contact');
    await john.grant((await pending).request.id, { tier: 'friend' });
    await contact;
    // John granted; nothing tells him yet what Omer allows back.
    expect(john.book.contact(omer.id)?.outboundScope?.may_propose_meetings).not.toBe(true);
    const johnInbound = structuredClone(john.book.contact(omer.id)!.inboundScope);

    const reversed: Array<{ peer: string }> = [];
    john.on('reverse-grant', (c) => reversed.push(c));
    const dropped: Array<[string, unknown]> = [];
    john.on('dropped', (r, d) => dropped.push([r, d]));

    // Omer's human approves the reverse direction.
    const mine = await omer.allowInbound(john.id, { tier: 'friend' });
    expect(mine).toMatchObject({ tier: 'friend', inboundGranted: true });
    await settle(omer, john);
    expect(reversed.map((c) => c.peer)).toEqual([omer.id]);
    const c = john.book.contact(omer.id)!;
    expect(c.outboundScope?.may_propose_meetings).toBe(true);
    expect(c.inboundScope).toEqual(johnInbound); // Omer's grant never touches what Omer may do towards John
    // Only allowInbound sends one: an application payload can't carry a grant (e.g. a model calling send).
    await expect(omer.send(john.id, { type: 'rdv/contact-grant', grant_ref: c.grantId })).rejects.toThrow(/dedicated method/);

    // A stranger's reverse grant (well signed, naming the real grant) is dropped and changes nothing.
    const mallory = generateKey();
    const forged = createReverseGrant(mallory, createCard(mallory, card), { peer: john.id, grantId: c.grantId }, {
      tier: 'spouse',
      scope: { may_propose_meetings: true },
    });
    deliver(sealEnvelope(mallory, john.id, forged, { seq: 1, prev: null }));
    await settle(john);
    expect(dropped).toContainEqual(['unexpected or invalid grant', 'reverse grant: not-contact']);
    expect(john.book.contact(mallory.id)).toBeUndefined();
    expect(reversed).toHaveLength(1);

    // Revocation removes it.
    const revoked = waitFor(john, 'revoked');
    await omer.revoke(john.id);
    await revoked;
    expect(john.book.contact(omer.id)).toBeUndefined();
  });

  it('re-sending the same reverse grant in a fresh envelope changes nothing', async () => {
    const { t, deliver } = bus();
    const omer = Agent.create(t, card);
    const john = Agent.create(t, card);
    omer.start();
    john.start();
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(john.card, 'hi');
    const contact = waitFor(omer, 'contact');
    await john.grant((await pending).request.id);
    await contact;
    let sent: unknown;
    const realSend = omer.transport.sendEnvelope.bind(omer.transport);
    omer.transport.sendEnvelope = async (e, relays) => {
      sent = e;
      return realSend(e, relays);
    };
    await omer.allowInbound(john.id, { scope: { may_initiate: true, may_propose_meetings: true } });
    await settle(omer, john);
    const before = JSON.stringify(john.book.contact(omer.id));
    const doc = openEnvelope(john.key, sent);
    expect(doc.ok).toBe(true);
    const reasons: Array<[string, unknown]> = [];
    john.on('dropped', (r, d) => reasons.push([r, d]));
    // Only Omer can seal as Omer: re-seal the same grant under the next seq, as a peer replaying it would.
    const { seq, prev } = omer.channels.nextOutbound(john.id);
    const again = sealEnvelope(omer.key, john.id, doc.ok ? doc.payload : {}, { seq, prev });
    omer.channels.commitOutbound(john.id, again);
    deliver(again);
    await settle(john);
    expect(reasons).toContainEqual(['unexpected or invalid grant', 'reverse grant: stale']);
    expect(JSON.stringify(john.book.contact(omer.id))).toBe(before);
    // A contact that keeps sending them is rate-limited (each one would rewrite the contact).
    for (let i = 0; i < REVERSE_GRANT_LIMIT.count; i++) {
      const n = omer.channels.nextOutbound(john.id);
      const e = sealEnvelope(omer.key, john.id, doc.ok ? doc.payload : {}, n);
      omer.channels.commitOutbound(john.id, e);
      deliver(e);
    }
    await settle(john);
    expect(reasons.map((r) => r[0])).toContain('reverse grant rate-limited');
  });
});

describe('gap buffer bounds (security regression)', () => {
  const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };
  const nullBus = (): Transport => ({
    async sendEnvelope() {},
    onEnvelopes: () => () => {},
    async publishTopic() {},
    onTopics: () => () => {},
    fetchTopic: async () => [],
    close() {},
  });
  // Feed raw envelopes straight into an agent through its transport.
  function feedable() {
    let handler: (e: unknown) => void = () => {};
    const t = (): Transport => ({ ...nullBus(), onEnvelopes: (_me, h) => ((handler = h), () => {}) });
    return { t, feed: (e: unknown) => handler(e) };
  }

  it('does not buffer or persist out-of-order envelopes from non-contacts', async () => {
    const { t, feed } = feedable();
    const john = Agent.create(t, card);
    john.start();
    const stranger = generateKey();
    const reasons: string[] = [];
    john.on('dropped', (r) => reasons.push(r));
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message' }, { seq: 3, prev: null }));
    await john.idle();
    expect(reasons).toContain('out-of-order envelope from a non-contact');
    expect(john.toJSON().buffer).toEqual({});
  });

  it('caps the number of peers with buffered envelopes', async () => {
    const { t, feed } = feedable();
    const john = Agent.create(t, card);
    john.start();
    const peers = Array.from({ length: 20 }, () => generateKey());
    for (const p of peers) {
      // Pretend each is a contact (only contacts may buffer).
      john.book.state.contacts[p.id] = {
        peer: p.id,
        card: createCard(p, card),
        tier: 'friend',
        inboundScope: { may_initiate: true },
        outboundScope: { may_initiate: true },
        binding: 'claimed',
        grantId: 'g',
        expires: null,
        since: new Date().toISOString(),
      };
      feed(sealEnvelope(p, john.id, { type: 'a2a/message' }, { seq: 5, prev: null }));
    }
    await john.idle();
    const buffered = Object.keys(john.toJSON().buffer ?? {});
    expect(buffered).toHaveLength(16);
    expect(buffered).toEqual(peers.slice(4).map((p) => p.id)); // oldest four evicted
  });
});

describe('peer rollback (issue #13)', () => {
  const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };
  function feedable() {
    let handler: (e: unknown) => void = () => {};
    const t = (): Transport => ({
      async sendEnvelope() {},
      onEnvelopes: (_me, h) => ((handler = h), () => {}),
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    return { t, feed: (e: unknown) => handler(e) };
  }
  const contactOf = (p: AgentKey) => ({
    peer: p.id,
    card: createCard(p, card),
    tier: 'friend' as const,
    inboundScope: { may_initiate: true },
    outboundScope: { may_initiate: true },
    binding: 'claimed' as const,
    grantId: 'g',
    expires: null,
    since: new Date().toISOString(),
  });

  it('reports a restored peer, refuses it across a restart, and takes it back only after the owner re-syncs', async () => {
    const { t, feed } = feedable();
    const omer = generateKey();
    let john = Agent.create(t, card);
    john.book.state.contacts[omer.id] = contactOf(omer);
    const drops: Array<[string, unknown]> = [];
    const texts: unknown[] = [];
    const watch = (a: Agent) => {
      a.on('dropped', (r, d) => drops.push([r, d]));
      a.on('message', (_p, payload) => texts.push(payload.n));
    };
    watch(john);
    john.start();

    // Omer sends six notes; his state after the first is his "backup".
    const base = Date.now() - 60_000;
    let omerState: Record<string, ChannelState> = {};
    let backup = '';
    const sent: Envelope[] = [];
    const sendFrom = (state: Record<string, ChannelState>, n: number, at: number) => {
      const ch = new Channels(state);
      const { seq, prev } = ch.nextOutbound(john.id);
      const e = sealEnvelope(omer, john.id, { type: 'a2a/message', n }, { seq, prev, now: new Date(at) });
      ch.commitOutbound(john.id, e);
      return e;
    };
    for (let n = 1; n <= 6; n++) {
      const e = sendFrom(omerState, n, base + n * 1000);
      sent.push(e);
      if (n === 1) backup = JSON.stringify(omerState);
      feed(e);
    }
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5, 6]);

    // He restores the backup (a rollback by 5) and carries on.
    omerState = JSON.parse(backup);
    const forked1 = sendFrom(omerState, 7, base + 30_000);
    const forked2 = sendFrom(omerState, 8, base + 31_000);
    feed(forked1);
    feed(forked2);
    for (const e of sent) feed(structuredClone(e)); // the relay replays the old chain: silent
    feed(structuredClone(forked1)); // and the forking envelope: already reported
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(drops).toEqual([
      ['envelope chain fork (rollback)', { peer: omer.id, seq: 2, accepted: 6 }],
      ['envelope chain fork (channel refused until resync)', { peer: omer.id, seq: 3, accepted: 6 }],
    ]);
    expect(john.refusedChannels()).toMatchObject([{ peer: omer.id, kind: 'rollback', seq: 2, accepted: 6 }]);

    // A restart keeps the refusal: nothing is trusted on its own.
    const saved = JSON.parse(JSON.stringify(john.toJSON()));
    john.stop();
    john = Agent.fromJSON(saved, t);
    watch(john);
    john.start();
    feed(structuredClone(forked2));
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(drops).toHaveLength(3);

    // The owner checked with Omer and re-syncs: his current chain is accepted from its next new envelope.
    john.resyncChannel(omer.id);
    expect(john.refusedChannels()).toEqual([]);
    feed(structuredClone(sent[5])); // an old replay can't become the head
    feed(structuredClone(forked2));
    feed(sendFrom(omerState, 9, base + 32_000));
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(drops).toHaveLength(3);

    // The relay replays the old chain around the new head (seq 4): old 4 reads as a rollback, old 5 as a fork, old 6 as a gap.
    // no re-refusal, no buffering, no resend, before or after a restart.
    const replayAll = async () => {
      for (const e of sent) feed(structuredClone(e));
      await john.idle();
    };
    await replayAll();
    const again = JSON.parse(JSON.stringify(john.toJSON()));
    john.stop();
    john = Agent.fromJSON(again, t);
    watch(john);
    john.start();
    await replayAll();
    expect(drops).toHaveLength(3);
    expect(john.refusedChannels()).toEqual([]);
    expect(john.toJSON().buffer).toEqual({});
    expect(john.toJSON().outbox[omer.id] ?? []).toEqual([]); // no rdv/resend went out
    feed(sendFrom(omerState, 10, base + 33_000));
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10]);
  });

  it("keeps a stranger's forks out of the owner's view", async () => {
    const { t, feed } = feedable();
    const john = Agent.create(t, card);
    const reasons: string[] = [];
    john.on('dropped', (r) => reasons.push(r));
    john.start();
    const stranger = generateKey();
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message' }, { seq: 1, prev: null }));
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message', other: true }, { seq: 1, prev: null }));
    await john.idle();
    expect(reasons).toEqual(['no grant for sender', 'envelope chain fork from a non-contact']);
  });
});

describe('relay drops', () => {
  it('close() while a relay socket is still connecting does not crash the process', async () => {
    // A TCP server that never answers the WebSocket handshake.
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const t = new NostrTransport({ key: generateKey(), relays: [`ws://127.0.0.1:${port}`] });
      void t.fetchTopic('x', 2000).catch(() => {});
      await new Promise((r) => setTimeout(r, 100)); // the handshake is now pending
      t.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });

  it('re-joins one relay of a multi-relay subscription; every event arrives once (issue #6)', async () => {
    let a = await startTestRelay();
    const b = await startTestRelay();
    const portA = Number(new URL(a.url).port);
    const urlA = a.url;
    const sub = new NostrTransport({ key: generateKey(), relays: [urlA, b.url], reconnectBaseMs: 100 });
    const pub = new NostrTransport({ key: generateKey(), relays: [urlA, b.url] });
    const pubA = new NostrTransport({ key: generateKey(), relays: [urlA] });
    const pubB = new NostrTransport({ key: generateKey(), relays: [b.url] });
    const got: string[] = [];
    const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
    const until = async (n: number) => {
      for (let i = 0; i < 50 && got.length < n; i++) await settle(100);
    };
    sub.onTopics(['t'], (doc) => got.push((doc as { n: string }).n));
    try {
      await settle();
      await pub.publishTopic('t', { n: 'both' }); // on A and B: delivered once
      await until(1);
      await a.close(); // A drops; B keeps running
      await pubB.publishTopic('t', { n: 'while-a-down' });
      await until(2);
      a = await startTestRelay(portA);
      await settle(800); // backoff + re-join of A alone
      await pubA.publishTopic('t', { n: 'a-only' });
      await until(3);
      await settle();
      expect(got.sort()).toEqual(['a-only', 'both', 'while-a-down']);
    } finally {
      for (const t of [sub, pub, pubA, pubB]) t.close();
      await a.close();
      await b.close();
    }
  });

  it('re-joins from the newest created_at seen minus the margin', async () => {
    let a = await startTestRelay();
    const port = Number(new URL(a.url).port);
    const url = a.url;
    const sub = new NostrTransport({ key: generateKey(), relays: [url], reconnectBaseMs: 100, rejoinMarginSeconds: 60 });
    const pub = new NostrTransport({ key: generateKey(), relays: [url] });
    const got: string[] = [];
    sub.onTopics(['t'], (doc) => got.push((doc as { n: string }).n));
    try {
      await new Promise((r) => setTimeout(r, 300));
      await pub.publishTopic('t', { n: 'first' });
      await new Promise((r) => setTimeout(r, 300));
      const createdAt = a.events[0].created_at;
      expect(a.requests[0].since).toBeLessThan(createdAt - 86_400); // first join: full lookback
      await a.close();
      a = await startTestRelay(port);
      for (let i = 0; i < 30 && a.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(a.requests[0].since).toBe(createdAt - 60);
      expect(got).toEqual(['first']);
    } finally {
      sub.close();
      pub.close();
      await a.close();
    }
  });

  it('re-subscribes after the relay goes away and comes back', async () => {
    let relay = await startTestRelay();
    const port = Number(new URL(relay.url).port);
    const url = relay.url;
    const make = (email: string) => {
      const a = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [url], reconnectBaseMs: 100 }), {
        rendezvous: [{ type: 'nostr', relay: url, pref: 1 }],
        discovery: { addresses: [{ type: 'email', value: email }], public_pointer: false },
      });
      a.start();
      return a;
    };
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    try {
      await new Promise((r) => setTimeout(r, 200));
      await relay.close(); // drops every socket
      relay = await startTestRelay(port);
      await new Promise((r) => setTimeout(r, 1000)); // backoff + resubscribe
      const pending = waitFor<{ request: { id: string } }>(john, 'request', 5000);
      await omer.requestContact('john@doe.com', 'after the restart');
      expect((await pending).request.id).toBeTruthy();
    } finally {
      omer.close();
      john.close();
      await relay.close();
    }
  });
});

