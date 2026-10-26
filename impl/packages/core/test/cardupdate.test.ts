// `rdv/card-update` (SPEC §4.3, NOTES 82, issue #45): a contact's newer card
// replaces the one we hold, and nothing the human approved changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentEvents,
  type AgentKey,
  CARD_UPDATE_LIMIT,
  CARD_UPDATE_SKEW_MS,
  type CardUpdate,
  ContactBook,
  cardUpdateProblem,
  createCard,
  createContactRequest,
  createGrant,
  DEFAULT_GRANT_SCOPE,
  generateKey,
  grantScope,
  MAX_CARD_BYTES,
  MAX_CARD_RELAYS,
  NostrTransport,
  reissueCardCapabilities,
  reissueCardRelays,
  relaysOf,
  signDoc,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const TASKS = 'https://rendezvous.dev/ext/tasks/v1';
const T0 = new Date('2026-10-20T10:00:00Z');

function contactBook() {
  const omer = generateKey();
  const john = generateKey();
  const hints = (relay: string) => [{ type: 'nostr' as const, relay, pref: 1 }];
  const omerCard = createCard(omer, { rendezvous: hints('wss://a.example'), now: T0 });
  const johnCard = createCard(john, { rendezvous: hints('wss://a.example'), now: T0 });
  const req = createContactRequest(john, johnCard, { toHint: omer.id, greeting: 'hi', now: T0 });
  const grant = createGrant(omer, omerCard, req, { tier: 'friend', scope: grantScope(DEFAULT_GRANT_SCOPE), now: T0 });
  const book = new ContactBook();
  book.recordIssuedGrant(grant, req, 'claimed', 'John');
  return { omer, john, johnCard, book };
}

describe('ContactBook.receiveCardUpdate', () => {
  const now = new Date(T0.getTime() + 3_600_000);

  it('accepts a newer card from the contact and changes only the card', () => {
    const { john, johnCard, book } = contactBook();
    const before = structuredClone(book.state.contacts[john.id]);
    const next = reissueCardCapabilities(john, reissueCardRelays(john, johnCard, ['wss://b.example', 'wss://c.example'], now), [...johnCard.capabilities, TASKS], now);
    const got = book.receiveCardUpdate(next, john.id, now);
    expect('contact' in got).toBe(true);
    const c = book.state.contacts[john.id];
    expect(c.card).toEqual(next);
    expect(relaysOf(c.card)).toEqual(['wss://b.example', 'wss://c.example']);
    expect(c.card.capabilities).toContain(TASKS);
    // Consent untouched: everything but the card is as it was.
    expect({ ...c, card: before.card }).toEqual(before);
    if ('previous' in got) expect(got.previous).toEqual(johnCard);
  });

  it('the same card again is unchanged (idempotent); an older or equally dated other card is stale', () => {
    const { john, johnCard, book } = contactBook();
    const next = reissueCardRelays(john, johnCard, ['wss://b.example'], now);
    expect('contact' in book.receiveCardUpdate(next, john.id, now)).toBe(true);
    expect(book.receiveCardUpdate(next, john.id, now)).toEqual({ unchanged: true });
    // The handshake card, replayed: older.
    expect(book.receiveCardUpdate(johnCard, john.id, now)).toMatchObject({ rejected: 'stale' });
    // Same `created`, other content: not newer either.
    const { sig: _s, ...body } = next;
    const twin = signDoc({ ...body, rendezvous: [{ type: 'nostr', relay: 'wss://evil.example', pref: 1 }] }, john);
    expect(twin.created).toBe(next.created);
    expect(book.receiveCardUpdate(twin, john.id, now)).toMatchObject({ rejected: 'stale' });
    expect(book.state.contacts[john.id].card).toEqual(next);
  });

  it("refuses another key's card, a stranger, a bad signature, a card far ahead of our clock, and an oversized one", () => {
    const { omer, john, johnCard, book } = contactBook();
    const stranger = generateKey();
    const strangerCard = createCard(stranger, { rendezvous: [{ type: 'nostr', relay: 'wss://x.example', pref: 1 }], now });
    // A valid card, but not the sender's.
    expect(book.receiveCardUpdate(strangerCard, john.id, now)).toMatchObject({ rejected: 'foreign-key' });
    // The stranger's own card, from the stranger: not a contact.
    expect(book.receiveCardUpdate(strangerCard, stranger.id, now)).toMatchObject({ rejected: 'not-contact' });
    // A card for John's id signed by someone else.
    const { sig: _s, ...body } = reissueCardRelays(john, johnCard, ['wss://b.example'], now);
    expect(book.receiveCardUpdate(signDoc(body, omer), john.id, now)).toMatchObject({ rejected: 'invalid' });
    expect(book.receiveCardUpdate({ junk: true }, john.id, now)).toMatchObject({ rejected: 'invalid' });
    const ahead = reissueCardRelays(john, johnCard, ['wss://b.example'], new Date(now.getTime() + CARD_UPDATE_SKEW_MS + 60_000));
    expect(book.receiveCardUpdate(ahead, john.id, now)).toMatchObject({ rejected: 'future' });
    const huge = signDoc({ ...body, owner: { name: 'x'.repeat(MAX_CARD_BYTES) } }, john);
    expect(book.receiveCardUpdate(huge, john.id, now)).toMatchObject({ rejected: 'bounds' });
    expect(book.state.contacts[john.id].card).toEqual(johnCard);
  });

  it('bounds the relays a card update may list', () => {
    const k = generateKey();
    const card = (relays: string[]) => reissueCardRelays(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: 'wss://a.example', pref: 1 }] }), relays);
    expect(cardUpdateProblem(card(['wss://a.example']))).toBeNull();
    expect(cardUpdateProblem(card(Array.from({ length: MAX_CARD_RELAYS + 1 }, (_, i) => `wss://r${i}.example`)))).toMatch(/more than/);
    expect(cardUpdateProblem(card(['https://not-a-relay.example']))).toMatch(/not a ws/);
    expect(cardUpdateProblem(createCard(k, { rendezvous: [] }))).toMatch(/no relay/);
    // A new ws:// relay: only for an agent on ws:// itself, or one the held card listed.
    const lan = card(['ws://192.168.1.20:7777']);
    expect(cardUpdateProblem(lan)).toMatch(/new ws:\/\//);
    expect(cardUpdateProblem(lan, { allowWs: true })).toBeNull();
    expect(cardUpdateProblem(card(['wss://b.example', 'ws://192.168.1.20:7777']), { held: lan })).toBeNull();
  });

  it('an expired or revoked contact gets no update', () => {
    const { john, johnCard, book } = contactBook();
    const next = reissueCardRelays(john, johnCard, ['wss://b.example'], now);
    book.revoke(john.id);
    expect(book.receiveCardUpdate(next, john.id, now)).toMatchObject({ rejected: 'not-contact' });
  });
});

function once<K extends keyof AgentEvents>(agent: Agent, event: K, ms = 5000): Promise<AgentEvents[K]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), ms);
    (agent as unknown as { once(e: string, f: (...a: unknown[]) => void): void }).once(event as string, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args as AgentEvents[K]);
    });
  });
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('two agents over Nostr relays', () => {
  let a: TestRelay;
  let b: TestRelay;
  let agents: Agent[] = [];
  beforeEach(async () => {
    a = await startTestRelay();
    b = await startTestRelay();
  });
  afterEach(async () => {
    for (const x of agents) x.close();
    agents = [];
    await a.close();
    await b.close();
  });

  const make = (relays: string[], capabilities?: string[], email?: string) => {
    // Unpaced: the rate-limit test sends more than the default pacing allows in a second.
    const agent = Agent.create((key: AgentKey) => new NostrTransport({ key, relays, maxEventsPerSecond: 1000, burst: 1000 }), {
      rendezvous: relays.map((relay, i) => ({ type: 'nostr', relay, pref: i + 1 })),
      ...(capabilities ? { capabilities } : {}),
      ...(email ? { discovery: { addresses: [{ type: 'email' as const, value: email }], public_pointer: false } } : {}),
    });
    agent.on('error', (e) => {
      throw e;
    });
    agent.start();
    agents.push(agent);
    return agent;
  };

  /** Omer asks John by card; John's human grants. */
  async function contacts(omer: Agent, john: Agent) {
    await settle();
    const asked = once(john, 'request');
    await omer.requestContact(john.card, 'hi', { label: 'John' });
    const [p] = await asked;
    const got = once(omer, 'contact');
    await john.grant(p.request.id, { tier: 'friend', label: 'Omer' });
    await got;
  }

  it('a contact that moved relays sends its new card; we then reach it there, and consent is untouched', async () => {
    const omer = make([a.url]);
    const john = make([a.url]);
    await contacts(omer, john);
    const before = structuredClone(john.book.contact(omer.id)!);
    expect(relaysOf(before.card)).toEqual([a.url]);
    // John's grant carried his card and Omer's request carried his: nothing to send.
    expect(john.cardUpdatesDue()).toEqual([]);
    expect(omer.cardUpdatesDue()).toEqual([]);

    // Omer moves to relay B only, then tells his contacts, also on his old relays.
    omer.setRelays([b.url]);
    await settle();
    const updated = once(john, 'card-update');
    const report = await omer.sendCardUpdates({ alsoRelays: [a.url] });
    expect(report).toEqual({ sent: [john.id], failed: [] });
    const [u] = (await updated) as [CardUpdate];
    expect(u.change.relays).toEqual({ added: [b.url], removed: [a.url] });
    expect(u.change.capabilities).toEqual({ added: [], removed: [] });
    expect(u.contact.peer).toBe(omer.id);
    const after = john.book.contact(omer.id)!;
    expect(after.card).toEqual(omer.card);
    expect({ ...after, card: before.card }).toEqual(before); // tier, scopes, grant, label, expiry unchanged

    // John now sends to Omer's new relay, where Omer listens (and no longer on A).
    const got = once(omer, 'message');
    await john.send(omer.id, { type: 'note', text: 'found you' });
    const [from, payload] = await got;
    expect(from).toBe(john.id);
    expect(payload).toMatchObject({ text: 'found you' });

    // Sent once: nothing due now, and a second call sends nothing.
    expect(omer.cardUpdatesDue()).toEqual([]);
    expect(await omer.sendCardUpdates()).toEqual({ sent: [], failed: [] });
  });

  it('a capability added after the handshake reaches the contact (the issue #45 repro, core side)', async () => {
    const omer = make([a.url]);
    const john = make([a.url], ['rdv/v1', 'a2a/0.3']);
    await contacts(omer, john);
    expect(omer.book.contact(john.id)!.card.capabilities).not.toContain(TASKS);
    expect(john.refreshCapabilities(['rdv/v1', 'a2a/0.3', TASKS])).toBe(true);
    const updated = once(omer, 'card-update');
    expect((await john.sendCardUpdates()).sent).toEqual([omer.id]);
    const [u] = (await updated) as [CardUpdate];
    expect(u.change.capabilities.added).toEqual([TASKS]);
    expect(omer.book.contact(john.id)!.card.capabilities).toContain(TASKS);
    expect(omer.book.mayInvoke(john.id, TASKS, 'outbound')).toBe(false); // advertising is not a grant
  });

  it('a stale card sent again is dropped with a reason; a stranger cannot send one', async () => {
    const omer = make([a.url]);
    const john = make([a.url]);
    await contacts(omer, john);
    const old = john.card;
    john.setRelays([a.url, b.url]);
    const first = once(omer, 'card-update');
    await john.sendCardUpdates();
    await first;
    // John's agent (say, a restored backup) sends its old card.
    const dropped = once(omer, 'dropped');
    await (john as unknown as { deliver(p: string, x: object, r: string[]): Promise<unknown> }).deliver(omer.id, { type: 'rdv/card-update', card: old }, [a.url]);
    const [reason, detail] = await dropped;
    expect(reason).toBe('card update rejected: not newer than the card we hold');
    expect(detail).toMatchObject({ peer: john.id, code: 'stale' });
    expect(omer.book.contact(john.id)!.card).toEqual(john.card);
    // A stranger, by a sealed envelope: refused before any state is kept.
    const eve = make([a.url]);
    const strangerDrop = once(omer, 'dropped');
    await (eve as unknown as { deliver(p: string, x: object, r: string[]): Promise<unknown> }).deliver(omer.id, { type: 'rdv/card-update', card: eve.card }, [a.url]);
    expect((await strangerDrop)[0]).toBe('card update from a non-contact');
    expect(omer.book.contact(eve.id)).toBeUndefined();
    // And it is not an application payload: send() refuses it.
    await expect(john.send(omer.id, { type: 'rdv/card-update', card: john.card })).rejects.toThrow(/dedicated method/);
  });

  it('card updates are rate-limited per contact', async () => {
    const omer = make([a.url]);
    const john = make([a.url]);
    await contacts(omer, john);
    const seen: CardUpdate[] = [];
    const drops: string[] = [];
    omer.on('card-update', (u) => seen.push(u));
    omer.on('dropped', (r) => drops.push(r));
    for (let i = 0; i <= CARD_UPDATE_LIMIT.count; i++) {
      john.refreshCapabilities([...john.card.capabilities, `https://example.com/ext/x${i}/v1`]);
      await john.sendCardUpdates();
    }
    await waitUntil(() => seen.length + drops.length === CARD_UPDATE_LIMIT.count + 1);
    expect(seen).toHaveLength(CARD_UPDATE_LIMIT.count);
    expect(drops).toEqual(['card update rate-limited']);
  }, 20_000);

  it('a contact made by a topic probe holds the card the probe carried: not due', async () => {
    const omer = make([a.url]);
    const john = make([a.url], undefined, 'john@doe.com');
    await settle();
    const asked = once(john, 'request');
    await omer.requestContact('john@doe.com', 'hi');
    const [p] = await asked;
    const candidate = once(omer, 'candidate');
    await john.grant(p.request.id, { tier: 'friend' });
    const [c] = await candidate;
    omer.confirmCandidate(c.grant.id);
    expect(omer.cardUpdatesDue()).toEqual([]);
    expect(john.cardUpdatesDue()).toEqual([]);
  });

  it('who is due survives a restart; a contact from state without cardSent gets one update', async () => {
    const omer = make([a.url]);
    const john = make([a.url]);
    await contacts(omer, john);
    omer.setRelays([a.url, b.url]);
    const state = omer.toJSON();
    expect(Agent.fromJSON(state, (key) => new NostrTransport({ key, relays: [a.url] })).cardUpdatesDue()).toEqual([john.id]);
    // State saved before card updates existed: every contact is due once.
    const legacy = john.toJSON();
    delete legacy.cardSent;
    expect(Agent.fromJSON(legacy, (key) => new NostrTransport({ key, relays: [a.url] })).cardUpdatesDue()).toEqual([omer.id]);
    expect(john.toJSON().cardSent).toEqual({ [omer.id]: john.card.created });
  });
});

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await settle(50);
  }
}
