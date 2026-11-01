import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  type ChannelState,
  Channels,
  createCard,
  createContactRequest,
  createReverseGrant,
  dtopic,
  idtopic,
  type Envelope,
  envelopeHash,
  FREE_MESSAGE_TYPES,
  generateKey,
  MEETING_CAPABILITIES,
  MEETINGS_CAPABILITY,
  NostrTransport,
  openEnvelope,
  plainSendFamily,
  PlainSendRefused,
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
    await omer.send(john.id, { type: 'note', text: 'Thursday 20:00?' });
    const [from, payload] = await got;
    expect(from).toBe(omer.id);
    expect(payload).toEqual({ type: 'note', text: 'Thursday 20:00?' });

    const reply = waitFor<[string, Payload]>(omer, 'message');
    await john.send(omer.id, { type: 'note', text: 'Works for me.' });
    expect((await reply)[1].text).toBe('Works for me.');

    // The relay only ever saw ciphertext.
    expect(relay.events.map((e) => e.content).join('')).not.toContain('Thursday');

    // A plain send carries only free messages (issue #133): every gated flow's type is refused, nothing leaves.
    const seqBefore = omer.channels.state[john.id].outSeq;
    for (const [type, family] of [
      ['a2a/message', 'a2a'],
      ['a2a/task-update', 'a2a'],
      ['a2a/artifact-update', 'a2a'],
      ['meeting/accept', 'a2a'],
      ['rdv/transfer', 'transfer'],
      ['rdv/group-msg', 'group'],
      ['rdv/group-invite', 'group'],
      ['rdv/auto-approve', 'control'],
      ['chat', 'other'],
      ['NOTE', 'other'],
    ] as const) {
      const err = await omer.send(john.id, { type }).catch((e: unknown) => e);
      expect(err, type).toBeInstanceOf(PlainSendRefused);
      expect((err as PlainSendRefused).family, type).toBe(family);
      expect(plainSendFamily(type), type).toBe(family);
    }
    expect(plainSendFamily('note')).toBe('free');
    expect(FREE_MESSAGE_TYPES).toEqual(['note']);
    expect(omer.channels.state[john.id].outSeq).toBe(seqBefore);
    // An engine's own send (its gate already ran) still goes through; control types never do.
    const viaEngine = waitFor<[string, Payload]>(john, 'message');
    await omer.sendGated(john.id, { type: 'a2a/task-update', taskId: 'x' });
    expect((await viaEngine)[1].type).toBe('a2a/task-update');
    await expect(omer.sendGated(john.id, { type: 'rdv/revoke' })).rejects.toThrow(/dedicated method/);
    await expect(omer.sendGated(john.id, { type: 'rdv/group-msg' })).rejects.toThrow(/dedicated method/);
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
    await expect(omer.send(john.id, { type: 'note' })).rejects.toThrow(/no active contact/);
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
    expect(await john.publishPointers()).toHaveLength(3); // two addresses and the agent ID (NOTES 83)
    expect((await omer.lookup('john@work.doe.com')).map((c) => c.id)).toEqual([john.id]);
    const old = (await omer.lookup('john@work.doe.com'))[0];

    const { removed } = john.setAddresses([{ type: 'email', value: 'john@doe.com' }]);
    expect(await john.publishPointers(removed)).toEqual([dtopic({ type: 'email', value: 'john@doe.com' }), dtopic({ type: 'email', value: 'john@work.doe.com' }), idtopic(john.id)]);
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
    await restored.send(john.id, { type: 'note', text: 'still me' });
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
    await expect(crashing.send(john.id, { type: 'note', text: 'first' })).rejects.toThrow('crash after send');
    crashing.close();

    // Without the fix the restart would reuse seq 1 from the stale state.
    expect(beforeCrash.channels[john.id].outSeq).toBe(0);
    expect(disk.channels[john.id].outSeq).toBe(1);

    const restarted = Agent.fromJSON(disk, (key) => new NostrTransport({ key, relays: [relay.url] }));
    agents.push(restarted);
    const env = await restarted.send(john.id, { type: 'note', text: 'second' });
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
    await omer.send(john.id, { type: 'note', text: 'two' }); // seq 2, lost
    await omer.send(john.id, { type: 'note', text: 'three' }); // seq 3 → gap → resend
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

    await omer.send(john.id, { type: 'note', text: 'two' }); // seq 2, held
    await omer.send(john.id, { type: 'note', text: 'three' }); // seq 3, buffered by john
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

  const REVIEW = 'https://rendezvous.nesher.co/ext/review/v1';
  const linked = async () => {
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
    return { omer, john, deliver };
  };

  it('a reverse grant carries scope.invoke; it sets only what the receiver may invoke on the sender (issue #23)', async () => {
    const { omer, john } = await linked();
    const johnInbound = structuredClone(john.book.contact(omer.id)!.inboundScope);
    // Omer's human lets John invoke review/v1 (no meetings).
    const mine = await omer.allowInbound(john.id, { tier: 'friend', scope: { may_initiate: true, invoke: { [REVIEW]: { max_frequency: '5/day', max_open: 2 } } } });
    // Written as v0.3 writes it: both fields, consistent.
    expect(mine.inboundScope).toMatchObject({ may_propose_meetings: false, invoke: { [REVIEW]: { max_frequency: '5/day', max_open: 2 } } });
    expect([omer.book.mayInvoke(john.id, REVIEW), omer.book.mayInvoke(john.id, MEETINGS_CAPABILITY)]).toEqual([true, false]);
    await settle(omer, john);
    const c = john.book.contact(omer.id)!;
    expect(c.outboundScope?.invoke).toEqual({ [REVIEW]: { max_frequency: '5/day', max_open: 2 } });
    expect(c.outboundScope?.may_propose_meetings).toBe(false);
    expect([john.book.mayInvoke(omer.id, REVIEW, 'outbound'), john.book.mayInvoke(omer.id, MEETINGS_CAPABILITY, 'outbound')]).toEqual([true, false]);
    // The invariant: a received grant never sets what the sender may invoke on the receiver.
    expect(c.inboundScope).toEqual(johnInbound);
    expect(john.book.mayInvoke(omer.id, REVIEW)).toBe(false);
  });

  it('a forward grant carries invoke to the requester, written with the boolean beside it', async () => {
    const { t } = bus();
    const omer = Agent.create(t, card);
    const john = Agent.create(t, card);
    omer.start();
    john.start();
    const pending = waitFor<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(john.card, 'hi');
    const contact = waitFor(omer, 'contact');
    await expect(john.grant((await pending).request.id, { scope: { invoke: { '*': {} } } })).rejects.toThrow(/capability URI/);
    expect(john.book.contact(omer.id)).toBeUndefined(); // nothing recorded, nothing sent
    await john.grant((await pending).request.id, { tier: 'friend', scope: { may_initiate: true, invoke: { [REVIEW]: {} } } });
    await contact;
    expect(omer.book.contact(john.id)?.outboundScope).toEqual({ may_initiate: true, may_propose_meetings: false, invoke: { [REVIEW]: {} } });
    expect(omer.book.mayInvoke(john.id, REVIEW, 'outbound')).toBe(true);
    expect(omer.book.mayInvoke(john.id, REVIEW)).toBe(false); // the grant set only what Omer may do
  });

  it('a malformed or self-contradicting invoke is refused before anything is recorded or sent', async () => {
    const { omer, john } = await linked();
    const before = JSON.stringify(omer.book.contact(john.id));
    const outSeq = omer.channels.state[john.id]?.outSeq;
    for (const scope of [
      { invoke: { '*': {} } },
      { invoke: { 'http://example.com/ext/x/v1': {} } },
      { invoke: { [REVIEW]: { max_open: 0 } } },
      { invoke: [REVIEW] },
      { may_propose_meetings: true, invoke: { [REVIEW]: {} } },
    ]) {
      await expect(omer.allowInbound(john.id, { scope: scope as never })).rejects.toThrow(/invoke/);
    }
    expect(JSON.stringify(omer.book.contact(john.id))).toBe(before);
    expect(omer.channels.state[john.id]?.outSeq).toBe(outSeq);
  });

  it('an older peer: its boolean-only grant still decides meetings, and ours reads the same to it', async () => {
    const { omer, john, deliver } = await linked();
    // John runs a version before scope.invoke: a reverse grant with the boolean only.
    const grantId = john.book.contact(omer.id)!.grantId;
    const old = createReverseGrant(john.key, john.card, { peer: omer.id, grantId }, { tier: 'friend', scope: { may_initiate: true, may_propose_meetings: true } });
    const n = john.channels.nextOutbound(omer.id);
    const env = sealEnvelope(john.key, omer.id, old, n);
    john.channels.commitOutbound(omer.id, env);
    deliver(env);
    await settle(omer);
    expect(omer.book.contact(john.id)?.outboundScope).toEqual({ may_initiate: true, may_propose_meetings: true });
    expect(omer.book.mayInvoke(john.id, MEETINGS_CAPABILITY, 'outbound')).toBe(true);
    expect(omer.book.mayInvoke(john.id, REVIEW, 'outbound')).toBe(false); // nothing else without invoke
    // What our default grant says to a reader of the boolean only is what invoke says.
    const s = john.book.contact(omer.id)!.inboundScope!;
    expect(s.may_propose_meetings).toBe(true);
    expect(Object.keys(s.invoke ?? {}).sort()).toEqual([...MEETING_CAPABILITIES].sort());
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
    // A pending requester has a channel (NOTES 64), but may not park envelopes with us.
    const stranger = generateKey();
    const reasons: string[] = [];
    john.on('dropped', (r) => reasons.push(r));
    const req = createContactRequest(stranger, createCard(stranger, card), { toHint: john.id, greeting: 'hi' });
    const first = sealEnvelope(stranger, john.id, req, { seq: 1, prev: null });
    feed(first);
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message' }, { seq: 3, prev: envelopeHash(first) }));
    await john.idle();
    expect(john.pendingRequests()).toHaveLength(1);
    expect(reasons).toContain('out-of-order envelope from a non-contact');
    expect(john.toJSON().buffer).toEqual({});
    // A sender we hold nothing for starts its chain where it is (NOTES 64): nothing to buffer either.
    feed(sealEnvelope(generateKey(), john.id, { type: 'a2a/message' }, { seq: 3, prev: null }));
    await john.idle();
    expect(reasons.at(-1)).toBe('no grant for sender');
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
    // A pending requester keeps a channel (NOTES 64), so it can fork it, quietly.
    const requester = generateKey();
    const req = createContactRequest(requester, createCard(requester, card), { toHint: john.id, greeting: 'hi' });
    feed(sealEnvelope(requester, john.id, req, { seq: 1, prev: null }));
    feed(sealEnvelope(requester, john.id, { type: 'a2a/message', other: true }, { seq: 1, prev: null }));
    await john.idle();
    expect(reasons).toEqual(['envelope chain fork from a non-contact']);
    // A stranger keeps none: every envelope starts its chain afresh and is refused for want of a grant.
    const stranger = generateKey();
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message' }, { seq: 1, prev: null }));
    feed(sealEnvelope(stranger, john.id, { type: 'a2a/message', other: true }, { seq: 1, prev: null }));
    await john.idle();
    expect(reasons).toEqual(['envelope chain fork from a non-contact', 'no grant for sender', 'no grant for sender']);
    expect(john.refusedChannels()).toEqual([{ peer: requester.id, kind: 'rollback', seq: 1, hash: expect.any(String), created: expect.any(Number), accepted: 1 }]);
    expect(john.channels.state[stranger.id]).toBeUndefined();
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


describe('channel state for strangers (issue #3, NOTES 64)', () => {
  const card = { rendezvous: [{ type: 'nostr' as const, relay: 'ws://unused', pref: 1 }] };
  function feedable() {
    let handler: (e: unknown) => void = () => {};
    const sent: Envelope[] = [];
    const t = (): Transport => ({
      async sendEnvelope(e) {
        sent.push(e);
      },
      onEnvelopes: (_me, h) => ((handler = h), () => {}),
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    return { t, feed: (e: unknown) => handler(e), sent };
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
  /** A sender's side of one channel: seals the next envelope in its chain. */
  function chainOf(key: AgentKey, to: string) {
    const out = new Channels();
    return (payload: Payload): Envelope => {
      const e = sealEnvelope(key, to, payload, out.nextOutbound(to));
      out.commitOutbound(to, e);
      return e;
    };
  }
  const requestTo = (key: AgentKey, to: string) => createContactRequest(key, createCard(key, card), { toHint: to, greeting: 'hi' });
  function watch(agent: Agent) {
    const texts: unknown[] = [];
    const drops: string[] = [];
    agent.on('message', (_p, payload) => texts.push(payload.text));
    agent.on('dropped', (r) => drops.push(r));
    return { texts, drops };
  }

  // 2k IDs keep `npm test` fast (~11 ms of crypto each); RDV_FLOOD_N=10000 runs the full flood.
  const FLOOD_N = Number(process.env.RDV_FLOOD_N) || 2_000;
  it(`keeps memory and the saved state bounded under envelopes from ${FLOOD_N} fresh IDs`, async () => {
    const { t, feed } = feedable();
    const john = Agent.create(t, card);
    const omer = generateKey();
    john.book.state.contacts[omer.id] = contactOf(omer);
    const fromOmer = chainOf(omer, john.id);
    const { texts } = watch(john);
    john.start();
    feed(fromOmer({ type: 'chat', text: 1 }));
    await john.idle();
    // The saved state without seenIds, which has its own cap (SEEN_LIMIT) and only grows with request ids.
    const sizeOf = () => {
      const st = john.toJSON();
      return JSON.stringify({ ...st, book: { ...st.book, seenIds: [] } }).length;
    };
    let early = 0;
    for (let i = 0; i < FLOOD_N; i++) {
      const k = generateKey();
      // Every tenth one asks for contact (kept, but the pending list is capped, NOTES 46); the rest just write, some mid-chain.
      const payload = i % 10 === 0 ? requestTo(k, john.id) : { type: 'chat', text: 'spam' };
      feed(sealEnvelope(k, john.id, payload, { seq: 1 + (i % 3), prev: null }));
      if (i % 500 === 499) {
        await john.idle();
        expect(Object.keys(john.channels.state).length).toBeLessThanOrEqual(1 + 64);
      }
      if (i === 999) early = sizeOf();
    }
    await john.idle();
    const state = john.toJSON();
    expect(Object.keys(john.channels.state).length).toBeLessThanOrEqual(1 + 64);
    expect(Object.keys(state.channels).length).toBeLessThanOrEqual(1 + 64);
    expect(Object.keys(state.book.pending)).toHaveLength(64);
    expect(state.buffer).toEqual({});
    // Past the first thousand, every further fresh ID leaves the saved state the same size.
    expect(sizeOf()).toBeLessThanOrEqual(early * 1.05);
    expect(state.book.seenIds.length).toBeLessThanOrEqual(5000);
    // The contact's channel came through untouched.
    expect(state.channels[omer.id]).toMatchObject({ inSeq: 1 });
    feed(fromOmer({ type: 'chat', text: 2 }));
    await john.idle();
    expect(texts).toEqual([1, 2]);
  }, 300_000);

  it("can't evict a contact's state: replay, gap/resend and rollback detection still hold", async () => {
    const { t, feed, sent } = feedable();
    const john = Agent.create(t, card);
    const omer = generateKey();
    john.book.state.contacts[omer.id] = contactOf(omer);
    const fromOmer = chainOf(omer, john.id);
    const { texts, drops } = watch(john);
    john.start();
    const early = [1, 2, 3].map((n) => fromOmer({ type: 'chat', text: n }));
    for (const e of early) feed(e);
    await john.idle();
    // More strangers than any table we keep (64 pending requests), half of them asking for contact.
    for (let i = 0; i < 500; i++) {
      const k = generateKey();
      feed(sealEnvelope(k, john.id, i % 2 ? requestTo(k, john.id) : { type: 'chat', text: 'spam' }, { seq: 1, prev: null }));
    }
    await john.idle();
    expect(john.channels.state[omer.id]).toMatchObject({ inSeq: 3, inPrev: envelopeHash(early[2]) });
    for (const e of early) feed(structuredClone(e)); // relay replays: silent duplicates
    const [e4, e5] = [4, 5].map((n) => fromOmer({ type: 'chat', text: n }));
    feed(e5); // a gap: buffered, and a resend goes out
    await john.idle();
    expect(texts).toEqual([1, 2, 3]);
    expect(sent.map((e) => openEnvelope(omer, e)).map((o) => (o.ok ? o.payload : o))).toEqual([{ type: 'rdv/resend', from_seq: 4, to_seq: 4 }]);
    feed(e4);
    await john.idle();
    expect(texts).toEqual([1, 2, 3, 4, 5]);
    // A different envelope reusing seq 5 is still a rollback (NOTES 56).
    feed(sealEnvelope(omer, john.id, { type: 'chat', text: 'old' }, { seq: 5, prev: envelopeHash(e4) }));
    await john.idle();
    expect(drops.filter((r) => r !== 'no grant for sender')).toEqual(['envelope chain fork (rollback)']);
    expect(john.refusedChannels()).toMatchObject([{ peer: omer.id, kind: 'rollback', seq: 5 }]);
  });

  it('persists only kept channels across toJSON/fromJSON, and they work after it', async () => {
    const { t, feed } = feedable();
    let john = Agent.create(t, card);
    const omer = generateKey();
    const asker = generateKey();
    john.book.state.contacts[omer.id] = contactOf(omer);
    const fromOmer = chainOf(omer, john.id);
    const fromAsker = chainOf(asker, john.id);
    john.start();
    feed(fromOmer({ type: 'chat', text: 1 }));
    feed(fromAsker(requestTo(asker, john.id)));
    for (let i = 0; i < 200; i++) feed(sealEnvelope(generateKey(), john.id, { type: 'chat', text: 'spam' }, { seq: 1, prev: null }));
    await john.idle();
    const saved = JSON.parse(JSON.stringify(john.toJSON()));
    expect(Object.keys(saved.channels).sort()).toEqual([omer.id, asker.id].sort());
    john.stop();
    // State saved before NOTES 64 may still hold strangers' channels: they go on load.
    const legacy = structuredClone(saved);
    legacy.channels[generateKey().id] = { outSeq: 0, outPrev: null, inSeq: 4, inPrev: 'ab' };
    john = Agent.fromJSON(legacy, t);
    expect(Object.keys(john.channels.state).sort()).toEqual([omer.id, asker.id].sort());
    expect(john.toJSON().channels).toEqual(saved.channels);
    const { texts, drops } = watch(john);
    john.start();
    const pending = john.pendingRequests();
    expect(pending.map((p) => p.request.from)).toEqual([asker.id]);
    await john.grant(pending[0].request.id);
    feed(fromOmer({ type: 'chat', text: 2 }));
    feed(fromAsker({ type: 'chat', text: 'asker 2' }));
    await john.idle();
    expect(texts).toEqual([2, 'asker 2']);
    expect(drops).toEqual([]);
  });

  it('a pending requester that becomes a contact keeps its chain from the request on', async () => {
    const { t, feed, sent } = feedable();
    const john = Agent.create(t, card);
    const { texts, drops } = watch(john);
    john.start();
    const asker = generateKey();
    const fromAsker = chainOf(asker, john.id);
    // It wrote before asking: that envelope is refused and leaves nothing behind.
    feed(fromAsker({ type: 'chat', text: 'too early' }));
    await john.idle();
    expect(drops).toEqual(['no grant for sender']);
    expect(john.channels.state[asker.id]).toBeUndefined();
    // Its request comes at seq 2: the chain starts there (NOTES 64), and the request is kept.
    const reqEnv = fromAsker(requestTo(asker, john.id));
    feed(reqEnv);
    await john.idle();
    expect(john.channels.state[asker.id]).toMatchObject({ inSeq: 2, inPrev: envelopeHash(reqEnv) });
    feed(structuredClone(reqEnv)); // a relay replay of the request stays a duplicate
    await john.idle();
    expect(john.pendingRequests()).toHaveLength(1);
    const contact = await john.grant(john.pendingRequests()[0].request.id);
    expect(contact.peer).toBe(asker.id);
    // After the grant its chain goes on from the request: in order, and a gap is resent.
    const [m3, m4, m5] = [3, 4, 5].map((n) => fromAsker({ type: 'chat', text: n }));
    feed(m3);
    feed(m5);
    await john.idle();
    expect(texts).toEqual([3]);
    const resends = sent.filter((e) => e.to === asker.id).map((e) => openEnvelope(asker, e)).flatMap((o) => (o.ok && o.payload.type === 'rdv/resend' ? [o.payload] : []));
    expect(resends).toEqual([{ type: 'rdv/resend', from_seq: 4, to_seq: 4 }]);
    feed(m4);
    await john.idle();
    expect(texts).toEqual([3, 4, 5]);
    expect(drops).toEqual(['no grant for sender']);
  });

  it('a declined requester can ask again later', async () => {
    const { t, feed } = feedable();
    const john = Agent.create(t, card);
    john.start();
    const asker = generateKey();
    const fromAsker = chainOf(asker, john.id);
    feed(fromAsker(requestTo(asker, john.id)));
    await john.idle();
    john.decline(john.pendingRequests()[0].request.id);
    expect(john.toJSON().channels[asker.id]).toBeUndefined(); // declined: nothing kept for it
    feed(fromAsker({ type: 'chat', text: 'still there?' })); // seq 2
    await john.idle();
    expect(john.channels.state[asker.id]).toBeUndefined();
    const again = requestTo(asker, john.id); // a new request, at seq 3
    feed(fromAsker(again));
    await john.idle();
    expect(john.pendingRequests().map((p) => p.request.id)).toEqual([again.id]);
    expect(john.channels.state[asker.id]).toMatchObject({ inSeq: 3 });
  });
});
