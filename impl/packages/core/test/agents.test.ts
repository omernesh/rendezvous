import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  createCard,
  type Envelope,
  generateKey,
  NostrTransport,
  type Payload,
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

