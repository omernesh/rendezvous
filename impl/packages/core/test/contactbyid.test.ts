// Contact by a pasted agent ID alone (issue #62, NOTES 83): the card is also
// published on the ID's topic, and a lookup by ID takes only a card signed by
// that ID.
import { sha256 } from '@noble/hashes/sha256';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  b32encode,
  canonAgentId,
  createCard,
  dtopic,
  generateKey,
  idtopic,
  NostrTransport,
  type Payload,
  signDoc,
  utf8ToBytes,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const JOHN_ID = 'rdv1:ucnkl5d2m5myal7zkx4nyljkcss4thjdx2l7qzasp74tqncvutya'; // vectors/v1.json, seed 22…

describe('idtopic and canonAgentId', () => {
  it('is base32(SHA-256("rdv1/id:" ‖ id))[0:26], apart from the address topics', () => {
    const t = idtopic(JOHN_ID);
    expect(t).toBe(b32encode(sha256(utf8ToBytes('rdv1/id:' + JOHN_ID))).slice(0, 26));
    expect(t).toMatch(/^[a-z2-7]{26}$/);
    expect(t).not.toBe(dtopic({ type: 'email', value: 'john@doe.com' }));
    expect(idtopic(generateKey().id)).not.toBe(t);
  });

  it('derives from the canonical ID: case and surrounding space do not matter', () => {
    const upper = 'rdv1:' + JOHN_ID.slice(5).toUpperCase();
    expect(canonAgentId(`  ${upper}\n`)).toBe(JOHN_ID);
    expect(idtopic(upper)).toBe(idtopic(JOHN_ID));
  });

  it('refuses a malformed ID with a message that says how to fix it', () => {
    expect(() => canonAgentId('john@doe.com')).toThrow(/must start with rdv1:/);
    expect(() => canonAgentId(JOHN_ID.slice(0, -1))).toThrow(/malformed agent ID.*52 base32 characters/);
    expect(() => canonAgentId(JOHN_ID.slice(0, -1) + '1')).toThrow(/malformed agent ID/); // 1 is not base32
    expect(() => idtopic('rdv1:')).toThrow(/malformed agent ID/);
  });
});

describe('lookup by agent ID over a relay', () => {
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

  const make = (email: string, opts: { pointer?: boolean; key?: AgentKey } = {}) => {
    const a = Agent.create(
      (key: AgentKey) => new NostrTransport({ key, relays: [relay.url] }),
      {
        rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }],
        discovery: { addresses: [{ type: 'email', value: email }], public_pointer: !!opts.pointer },
        policy: { public: !!opts.pointer },
      },
      opts.key,
    );
    a.on('error', (e) => {
      throw e;
    });
    a.start();
    agents.push(a);
    return a;
  };

  const once = <T>(agent: Agent, event: 'request' | 'contact' | 'message'): Promise<T> =>
    new Promise((resolve) => agent.once(event, (...args: unknown[]) => resolve((args.length === 1 ? args[0] : args) as T)));

  it('B publishes; A, holding only B\'s ID, requests contact; B grants; they exchange a message', async () => {
    const john = make('john@doe.com', { pointer: true });
    const topics = await john.publishPointers();
    expect(topics).toEqual([dtopic({ type: 'email', value: 'john@doe.com' }), idtopic(john.id)]);
    expect(await john.ownCardById()).toBe(true);

    const omer = make('omer@example.com');
    const card = await omer.lookupById(john.id);
    expect(card?.id).toBe(john.id);
    expect(card?.sig).toBe(john.card.sig);

    const pending = once<{ request: { id: string } }>(john, 'request');
    await omer.requestContact(card!, 'hello by ID');
    const req = await pending;
    const contact = once(omer, 'contact');
    await john.grant(req.request.id); // John's human decides; nothing here auto-grants
    await contact;
    expect(omer.contacts().map((c) => [c.peer, c.binding, c.label])).toEqual([[john.id, 'claimed', undefined]]);

    const got = once<[string, Payload]>(john, 'message');
    await omer.send(john.id, { type: 'note', text: 'Found you by ID.' });
    const [from, payload] = await got;
    expect(from).toBe(omer.id);
    expect(payload.text).toBe('Found you by ID.');
  });

  it('takes only a card whose id is the requested ID, and the newest of those', async () => {
    const john = make('john@doe.com', { pointer: true });
    const mallory = make('john@doe.com', { pointer: true });
    const omer = make('omer@example.com');
    await john.publishPointers();
    const first = john.card;

    // Mallory posts her own valid card, and a card claiming John's id that she signed, on John's ID topic.
    const forged = signDoc({ ...createCard(mallory.key, { rendezvous: john.card.rendezvous }), id: john.id }, mallory.key);
    await mallory.transport.publishTopic(idtopic(john.id), mallory.card);
    await mallory.transport.publishTopic(idtopic(john.id), forged);
    // And replays John's card from another Nostr key (it stays valid, but a newer one wins).
    await mallory.transport.publishTopic(idtopic(john.id), first);
    expect(relay.events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === idtopic(john.id)))).toHaveLength(4);

    expect((await omer.lookupById(john.id))?.sig).toBe(first.sig);

    john.setAddresses([{ type: 'email', value: 'john@doe.com' }, { type: 'phone', value: '+15555550142' }]); // re-signed, later created
    await john.publishPointers();
    const found = await omer.lookupById(john.id);
    expect(found?.created).toBe(john.card.created);
    expect(found?.created).not.toBe(first.created);

    // Mallory's own ID finds only her card, never John's.
    expect(await omer.lookupById(mallory.id)).toBeNull(); // she posted on John's topic, not hers
    await mallory.publishPointers();
    expect((await omer.lookupById(mallory.id))?.id).toBe(mallory.id);
  });

  it('not found, our own ID, and a malformed ID', async () => {
    const omer = make('omer@example.com', { pointer: true });
    await omer.publishPointers();
    expect(await omer.lookupById(generateKey().id)).toBeNull();
    expect(await omer.lookupById(omer.id)).toBeNull();
    await expect(omer.lookupById('rdv1:nope')).rejects.toThrow(/malformed agent ID/);
  });

  it('without the public pointer the card is published nowhere, not under the ID either', async () => {
    const john = make('john@doe.com');
    expect(await john.publishPointers()).toEqual([]);
    expect(relay.events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === idtopic(john.id)))).toHaveLength(0);
    expect(await make('omer@example.com').lookupById(john.id)).toBeNull();
    await expect(john.mirrorPointers({ relays: [] })).rejects.toThrow(/public pointer is off/);
  });

  it('the mirror run carries the ID topic too', async () => {
    const john = make('john@doe.com', { pointer: true });
    const report = await john.mirrorPointers({ relays: [], gapMs: 0 });
    expect(report.topics).toEqual([dtopic({ type: 'email', value: 'john@doe.com' }), idtopic(john.id)]);
    expect(report.relays.map((r) => [r.result, r.served])).toEqual([['accepted', true]]);
    expect((await make('omer@example.com').lookupById(john.id))?.id).toBe(john.id);
  });
});
