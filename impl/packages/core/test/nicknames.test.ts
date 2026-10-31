// Contact nicknames (aliases), possessive names and the agent's own name (NOTES 103).
import { describe, expect, it } from 'vitest';
import {
  Agent,
  ALIASES_MAX,
  backupAgentState,
  canonicalize,
  cardAgentName,
  cleanAgentName,
  cleanAlias,
  ContactBook,
  createCard,
  createContactRequest,
  createGrant,
  fingerprint,
  generateKey,
  labelKey,
  nameKeys,
  normalizeName,
  NostrTransport,
  possessiveName,
  reissueCardAgentName,
  verifyCard,
  type AgentKey,
} from '../src/index.js';

const hints = [{ type: 'nostr' as const, relay: 'ws://127.0.0.1:1', pref: 1 }];

/** A contact made the usual way: our request to the peer's card, its grant back. */
function befriend(book: ContactBook, me: AgentKey, peer: AgentKey = generateKey(), label?: string): string {
  const req = createContactRequest(me, createCard(me, { rendezvous: hints }), { toHint: peer.id, greeting: 'hi' });
  book.trackOutstanding(req, 'claimed', peer.id, label);
  book.receiveGrant(createGrant(peer, createCard(peer, { rendezvous: hints }), req, { tier: 'friend', scope: {} }), me.id);
  expect(book.contact(peer.id)).toBeDefined();
  return peer.id;
}

describe('names: normalizing and possessives', () => {
  it('normalizes with NFKC, trims and collapses white space; compares case-insensitively', () => {
    expect(normalizeName('  Ｒａｎ \t  Cohen ')).toBe('Ran Cohen');
    expect(labelKey('RAN  cohen')).toBe(labelKey('ran cohen'));
    expect(labelKey('ﬁona')).toBe(labelKey('Fiona')); // the ligature folds under NFKC
    // An address still compares by its canonical topic.
    expect(labelKey(' John@Doe.com ')).toBe(labelKey('john@doe.com'));
  });

  it('reads the possessive forms of "someone\'s agent"', () => {
    for (const s of ["Ran's agent", 'Ran’s agent', "Ran's", 'agent of Ran', 'the agent of Ran', "  RAN's   AGENT ", 'Agent of  Ran'])
      expect(possessiveName(s)?.toLowerCase(), s).toBe('ran');
    expect(possessiveName("James' agent")).toBe('James');
    expect(possessiveName("john@doe.com's agent")).toBe('john@doe.com');
    for (const s of ['Ran', 'agent', "'s agent", 'Ran agent']) expect(possessiveName(s), s).toBeNull();
  });

  it('validates a nickname like a label, at most 64 characters, never an agent ID', () => {
    expect(cleanAlias('  joe  ')).toBe('joe');
    expect(() => cleanAlias('')).toThrow(/nickname/);
    expect(() => cleanAlias('a‮b')).toThrow(/nickname/);
    expect(() => cleanAlias('x'.repeat(65))).toThrow(/64/);
    expect(cleanAlias('x'.repeat(64))).toHaveLength(64);
    expect(() => cleanAlias(generateKey().id)).toThrow(/agent ID/);
  });
});

describe('contact nicknames', () => {
  it('resolves a label or any nickname, case- and form-insensitively, also as a possessive', () => {
    const me = generateKey();
    const book = new ContactBook();
    const ran = befriend(book, me, generateKey(), 'ran@example.com');
    const joe = befriend(book, me);
    book.addAlias(ran, 'Ran');
    book.addAlias(joe, 'joe');
    book.addAlias(joe, 'Joseph  Doe');
    const one = (q: string) => book.byLabel(q).map((c) => c.peer);
    expect(one('ran@example.com')).toEqual([ran]);
    for (const q of ['Ran', 'RAN', ' ran ', "Ran's agent", 'Ran’s agent', 'agent of Ran', "ran's"]) expect(one(q), q).toEqual([ran]);
    for (const q of ['joe', "Joe's agent", 'joseph doe', 'Ｊｏｓｅｐｈ Doe']) expect(one(q), q).toEqual([joe]);
    expect(one("ran@example.com's agent")).toEqual([ran]);
    expect(one('Dana')).toEqual([]);
    expect(book.contact(joe)?.aliases).toEqual(['joe', 'Joseph Doe']);
  });

  it('a name belongs to one contact: a nickname another contact has (label or nickname) is refused', () => {
    const me = generateKey();
    const book = new ContactBook();
    const a = befriend(book, me, generateKey(), 'Ran');
    const b = befriend(book, me);
    expect(() => book.addAlias(b, 'ran')).toThrow(new RegExp(`another contact.*${fingerprint(a)}`));
    book.addAlias(b, 'joe');
    expect(() => book.addAlias(a, 'JOE')).toThrow(/another contact/);
    expect(() => book.addAlias(b, 'Joe')).toThrow(/already called/);
    expect(() => book.addAlias(a, 'ran')).toThrow(/already called/); // its own label
    // Removed there, it may go elsewhere.
    book.removeAlias(b, 'JOE');
    expect(book.contact(b)?.aliases).toBeUndefined();
    book.addAlias(a, 'joe');
    expect(() => book.removeAlias(b, 'joe')).toThrow(/no nickname/);
  });

  it('a clash through a possessive is refused too; a label another contact\'s nickname reaches is refused (security review L2)', () => {
    const me = generateKey();
    const book = new ContactBook();
    const a = befriend(book, me, generateKey(), 'Ran');
    const b = befriend(book, me);
    const c = befriend(book, me);
    // "Ran's agent" here and the label "Ran" there would both answer "Ran's agent".
    expect(() => book.addAlias(b, "Ran's agent")).toThrow(new RegExp(`another contact.*${fingerprint(a)}`));
    expect(() => book.addAlias(b, 'agent of ran')).toThrow(/another contact/);
    book.addAlias(b, "Joe's");
    expect(() => book.addAlias(c, 'joe')).toThrow(/another contact/);
    // A label may not take another contact's nickname, directly or through a possessive.
    expect(() => book.setLabel(c, 'JOE')).toThrow(/nickname of another contact/);
    expect(() => book.setLabel(c, "joe's agent")).toThrow(/nickname of another contact/);
    // Two labels may still be alike (a probe labels with the probed address): resolution refuses them.
    book.setLabel(c, 'Ran');
    expect(book.byLabel('Ran')).toHaveLength(2);
    expect(nameKeys("Ran's agent").sort()).toEqual([labelKey("Ran's agent"), labelKey('Ran')].sort());
  });

  it('counts lengths in characters (code points), not UTF-16 units (security review L5)', () => {
    expect(cleanAlias('\u{1F600}'.repeat(64))).toHaveLength(128);
    expect(() => cleanAlias('\u{1F600}'.repeat(65))).toThrow(/64/);
    expect(cleanAgentName('\u{1F600}'.repeat(64))).toHaveLength(128);
    expect(() => cleanAgentName('\u{1F600}'.repeat(65))).toThrow(/64/);
  });

  it('at most 8 nicknames per contact', () => {
    const me = generateKey();
    const book = new ContactBook();
    const p = befriend(book, me);
    for (let i = 0; i < ALIASES_MAX; i++) book.addAlias(p, `n${i}`);
    expect(() => book.addAlias(p, 'one more')).toThrow(/8 nicknames/);
  });

  it('a name two contacts share is ambiguous (callers refuse it), including through a possessive', () => {
    const me = generateKey();
    const book = new ContactBook();
    // Labels may still collide (a probe labels with the probed address); a possessive can also reach two names.
    const a = befriend(book, me, generateKey(), 'Ran');
    const b = befriend(book, me, generateKey(), "Ran's agent");
    expect(book.byLabel('Ran').map((c) => c.peer)).toEqual([a]);
    expect(book.byLabel("Ran's agent").map((c) => c.peer).sort()).toEqual([a, b].sort());
    // Never a card's addresses or what the peer's agent calls itself.
    const named = generateKey();
    const req = createContactRequest(me, createCard(me, { rendezvous: hints }), { toHint: named.id, greeting: 'hi' });
    book.trackOutstanding(req, 'claimed', named.id);
    const card = createCard(named, { rendezvous: hints, agentName: 'Dana', discovery: { addresses: [{ type: 'email', value: 'dana@example.com' }], public_pointer: false } });
    book.receiveGrant(createGrant(named, card, req, { tier: 'friend', scope: {} }), me.id);
    expect(book.byLabel('Dana')).toEqual([]);
    expect(book.byLabel("Dana's agent")).toEqual([]);
    expect(book.byLabel('dana@example.com')).toEqual([]);
  });

  it('nicknames survive a new grant, toJSON/fromJSON and a backup; old state has none', () => {
    const me = generateKey();
    const book = new ContactBook();
    const peer = generateKey();
    const id = befriend(book, me, peer);
    book.addAlias(id, 'Ran');
    // The peer grants again (a re-founded contact): our human's nicknames stay.
    befriend(book, me, peer);
    expect(book.contact(id)?.aliases).toEqual(['Ran']);
    const again = new ContactBook(JSON.parse(JSON.stringify(book.toJSON())));
    expect(again.byLabel("Ran's agent").map((c) => c.peer)).toEqual([id]);
    // State saved before nicknames existed: no aliases field at all.
    const old = JSON.parse(JSON.stringify(book.toJSON()));
    delete old.contacts[id].aliases;
    const legacy = new ContactBook(old);
    expect(legacy.byLabel('Ran')).toEqual([]);
    legacy.addAlias(id, 'Ran');
    expect(legacy.byLabel('ran').map((c) => c.peer)).toEqual([id]);

    const agent = Agent.create((key) => new NostrTransport({ key, relays: ['ws://127.0.0.1:1'] }), { rendezvous: hints, agentName: 'Sammie' });
    agent.book.state = JSON.parse(JSON.stringify(book.toJSON()));
    const saved = agent.toJSON();
    const restored = Agent.fromJSON(JSON.parse(JSON.stringify(saved)), (key) => new NostrTransport({ key, relays: ['ws://127.0.0.1:1'] }));
    expect(restored.book.contact(id)?.aliases).toEqual(['Ran']);
    expect(restored.card.agent_name).toBe('Sammie');
    expect(backupAgentState(saved).book.contacts[id].aliases).toEqual(['Ran']);
    agent.close();
    restored.close();
  });
});

describe("the agent's own name on its card", () => {
  it('is an optional, signed field; a card without it has no such key (the vectors are unchanged)', () => {
    const k = generateKey();
    const plain = createCard(k, { rendezvous: hints });
    expect('agent_name' in plain).toBe(false);
    expect(canonicalize(plain)).not.toContain('agent_name');
    const named = createCard(k, { rendezvous: hints, agentName: '  Sammie ' });
    expect(named.agent_name).toBe('Sammie');
    expect(verifyCard(named).ok).toBe(true);
    expect(cardAgentName(named)).toBe('Sammie');
    // Tampering with it breaks the signature, like any card field.
    expect(verifyCard({ ...named, agent_name: 'Mallory' }).ok).toBe(false);
    expect(() => createCard(k, { rendezvous: hints, agentName: 'x'.repeat(65) })).toThrow(/agent name/);
    expect(() => cleanAgentName('a\u0007b')).toThrow(/agent name/);
  });

  it('re-signs to set or clear it; a malformed one keeps the card valid but is not shown', () => {
    const k = generateKey();
    const card = createCard(k, { rendezvous: hints, now: new Date('2026-10-01T00:00:00Z') });
    const named = reissueCardAgentName(k, card, 'Sammie', new Date('2026-10-02T00:00:00Z'));
    expect(named.agent_name).toBe('Sammie');
    expect(Date.parse(named.created)).toBeGreaterThan(Date.parse(card.created));
    const cleared = reissueCardAgentName(k, named, null, new Date('2026-10-03T00:00:00Z'));
    expect('agent_name' in cleared).toBe(false);
    expect(verifyCard(cleared).ok).toBe(true);
    expect(cardAgentName({ agent_name: 'a‮b' })).toBeNull();
    expect(cardAgentName({ agent_name: 42 })).toBeNull();
    expect(cardAgentName(undefined)).toBeNull();
  });

  it('Agent.setAgentName changes the card only when the name changes', () => {
    const agent = Agent.create((key) => new NostrTransport({ key, relays: ['ws://127.0.0.1:1'] }), { rendezvous: hints });
    const before = agent.card.created;
    expect(agent.setAgentName('Sammie')).toBe(true);
    expect(agent.card.agent_name).toBe('Sammie');
    expect(agent.card.created).not.toBe(before);
    expect(agent.setAgentName('Sammie')).toBe(false);
    expect(agent.setAgentName(null)).toBe(true);
    expect(agent.card.agent_name).toBeUndefined();
    expect(agent.setAgentName(null)).toBe(false);
    agent.close();
  });
});
