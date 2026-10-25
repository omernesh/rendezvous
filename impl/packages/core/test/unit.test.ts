import { describe, expect, it } from 'vitest';
import {
  Channels,
  ContactBook,
  canonicalize,
  createCard,
  createContactRequest,
  createGrant,
  createReverseGrant,
  createRevoke,
  CANDIDATES_PER_PROBE,
  REVERSE_GRANT_SKEW_MS,
  verifyReverseGrant,
  DEFAULT_INBOUND_SCOPE,
  PENDING_LIMIT,
  PENDING_PER_SENDER,
  RESEND_LIMIT,
  defaultTier,
  dtopic,
  envelopeHash,
  fingerprint,
  generateKey,
  isAgentId,
  openEnvelope,
  sealEnvelope,
  isExpired,
  isPast,
  parseTimestamp,
  signDoc,
  TIERS,
  verifyCard,
  verifyContactRequest,
  verifyGrant,
  verifyDoc,
  MAX_ADDRESSES,
  newerCard,
  normalizeAddresses,
  parseAddress,
  reissueCard,
} from '../src/index.js';

const hints = [{ type: 'nostr' as const, relay: 'ws://127.0.0.1:1', pref: 1 }];

describe('encoding', () => {
  it('canonicalizes with sorted keys and no whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 1, y: undefined } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"z":1}}',
    );
  });
});

describe('identity', () => {
  it('produces rdv1 ids that round-trip', () => {
    const k = generateKey();
    expect(k.id).toMatch(/^rdv1:[a-z2-7]{52}$/);
    expect(isAgentId(k.id)).toBe(true);
    expect(isAgentId('rdv1:abc')).toBe(false);
    expect(fingerprint(k.id)).toMatch(/^rdv1:.{4}….{4}$/);
  });
});

describe('signed documents', () => {
  it('verifies and detects tampering', () => {
    const k = generateKey();
    const doc = signDoc({ hello: 'world', n: 1 }, k);
    expect(verifyDoc(doc, k.id)).toBe(true);
    expect(verifyDoc({ ...doc, n: 2 }, k.id)).toBe(false);
    expect(verifyDoc(doc, generateKey().id)).toBe(false);
  });
});

describe('address card', () => {
  it('verifies, rejects tampering and expiry', () => {
    const k = generateKey();
    const card = createCard(k, { rendezvous: hints });
    expect(card.policy).toEqual({ inbound: 'prompt', public: false });
    expect(verifyCard(card).ok).toBe(true);
    expect(verifyCard({ ...card, policy: { inbound: 'allow', public: true } }).ok).toBe(false);
    const expired = createCard(k, { rendezvous: hints, expires: '2000-01-01T00:00:00Z' });
    expect(verifyCard(expired)).toEqual({ ok: false, reason: 'card expired' });
  });
});

describe('discovery topics', () => {
  it('canonicalizes addresses before hashing', () => {
    expect(dtopic({ type: 'email', value: ' John@Doe.com ' })).toBe(dtopic({ type: 'email', value: 'john@doe.com' }));
    expect(dtopic({ type: 'phone', value: '+972-54-000-0000' })).toBe(dtopic({ type: 'phone', value: '+972540000000' }));
    expect(dtopic({ type: 'email', value: 'john@doe.com' })).toHaveLength(26);
    expect(() => dtopic({ type: 'phone', value: '054-000-0000' })).toThrow();
  });

  it('parses, canonicalizes, dedupes and caps an address list', () => {
    expect(parseAddress(' Omer@Work.Example.com ')).toEqual({ type: 'email', value: 'omer@work.example.com' });
    expect(parseAddress('+1 (555) 555-0123')).toEqual({ type: 'phone', value: '+15555550123' });
    expect(() => parseAddress('omer')).toThrow(/not an email address or \+phone/);
    expect(() => parseAddress('+12')).toThrow(/E\.164/);
    const list = normalizeAddresses([
      { type: 'email', value: 'omer@example.com' },
      { type: 'email', value: 'OMER@example.com' },
      { type: 'phone', value: '+1-555-555-0123' },
      { type: 'phone', value: '+15555550123' },
      { type: 'email', value: 'omer@work.example.com' },
    ]);
    expect(list).toEqual([
      { type: 'email', value: 'omer@example.com' },
      { type: 'phone', value: '+15555550123' },
      { type: 'email', value: 'omer@work.example.com' },
    ]);
    const many = Array.from({ length: MAX_ADDRESSES + 1 }, (_, i) => ({ type: 'email' as const, value: `omer+${i}@example.com` }));
    expect(normalizeAddresses(many.slice(0, MAX_ADDRESSES))).toHaveLength(MAX_ADDRESSES);
    expect(() => normalizeAddresses(many)).toThrow(/too many addresses/);
  });

  it('a reissued card is newer, re-signed, keeps everything but the addresses', () => {
    const k = generateKey();
    const now = new Date('2026-10-25T10:00:00.000Z');
    const card = createCard(k, { rendezvous: hints, discovery: { addresses: [{ type: 'email', value: 'omer@example.com' }], public_pointer: true }, policy: { public: true }, now });
    // Even with a clock that has not moved, created moves forward by a second.
    const next = reissueCard(k, card, { addresses: [{ type: 'email', value: 'omer@work.example.com' }], public_pointer: true }, now);
    expect(verifyCard(next).ok).toBe(true);
    expect(next.created).toBe('2026-10-25T10:00:01.000Z');
    expect(next.discovery).toEqual({ addresses: [{ type: 'email', value: 'omer@work.example.com' }], public_pointer: true });
    expect({ ...next, created: card.created, discovery: card.discovery, sig: card.sig }).toEqual(card);
    expect(newerCard(card, next)).toBe(next);
    expect(newerCard(next, card)).toBe(next);
    // No addresses and no pointer: no discovery block, as at init.
    expect(reissueCard(k, next, { addresses: [], public_pointer: false }).discovery).toBeUndefined();
    expect(() => reissueCard(generateKey(), card, { addresses: [], public_pointer: false })).toThrow(/another key/);
  });

  it('caps the default tier for claimed bindings', () => {
    expect(defaultTier('claimed')).toBe('stranger');
    expect(defaultTier('mailbox')).toBe('friend');
  });
});

describe('envelope', () => {
  const alice = generateKey();
  const bob = generateKey();

  it('round-trips and hides the payload', () => {
    const env = sealEnvelope(alice, bob.id, { type: 'note', text: 'secret' }, { seq: 1, prev: null });
    expect(JSON.stringify(env)).not.toContain('secret');
    const opened = openEnvelope(bob, env);
    expect(opened.ok && opened.payload).toEqual({ type: 'note', text: 'secret' });
  });

  it('rejects the wrong recipient, tampering, grafted ciphertext and expiry', () => {
    const env = sealEnvelope(alice, bob.id, { type: 'note' }, { seq: 1, prev: null });
    expect(openEnvelope(alice, env).ok).toBe(false);
    expect(openEnvelope(bob, { ...env, seq: 2 })).toMatchObject({ ok: false, reason: 'bad signature' });
    const mallory = generateKey();
    const forged = sealEnvelope(mallory, bob.id, { type: 'evil' }, { seq: 1, prev: null });
    expect(openEnvelope(bob, { ...env, content: forged.content })).toMatchObject({ ok: false, reason: 'bad signature' });
    const old = sealEnvelope(alice, bob.id, { type: 'note' }, { seq: 1, prev: null, ttl: '1h', now: new Date(0) });
    expect(openEnvelope(bob, old)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects an over-long ttl and a created date from the future (security review L5)', () => {
    const a = generateKey();
    const b = generateKey();
    const now = new Date('2026-10-25T10:00:00Z');
    expect(() => sealEnvelope(a, b.id, { type: 'x' }, { seq: 1, prev: null, ttl: '99999d', now })).toThrow(/7 days/);
    const long = signDoc({ ...sealEnvelope(a, b.id, { type: 'x' }, { seq: 1, prev: null, now }), sig: undefined, ttl: '99999d' }, a);
    expect(openEnvelope(b, long, now)).toMatchObject({ ok: false, reason: 'ttl too long' });
    const future = sealEnvelope(a, b.id, { type: 'x' }, { seq: 1, prev: null, now: new Date(now.getTime() + 10 * 60_000) });
    expect(openEnvelope(b, future, now)).toMatchObject({ ok: false, reason: 'created in the future' });
    const skewed = sealEnvelope(a, b.id, { type: 'x' }, { seq: 1, prev: null, now: new Date(now.getTime() + 2 * 60_000) });
    expect(openEnvelope(b, skewed, now).ok).toBe(true);
  });

  it('garbage timestamps fail closed: never "never expires"', () => {
    const a = generateKey();
    const b = generateKey();
    const now = new Date('2026-10-25T10:00:00Z');
    const env = signDoc({ ...sealEnvelope(a, b.id, { type: 'x' }, { seq: 1, prev: null, now }), sig: undefined, created: 'garbage' }, a);
    expect(openEnvelope(b, env, now)).toMatchObject({ ok: false, reason: 'bad created' });
    expect(isExpired({ ...env, created: 'garbage' }, now)).toBe(true);
    expect(parseTimestamp('2026-02-31T10:00:00Z')).toBeNull();
    expect(parseTimestamp('2026-10-25T10:00:00.000Z')).toBe(now.getTime());
    expect(parseTimestamp('2026-10-25T12:00:00+02:00')).toBe(now.getTime());
    expect(isPast('garbage', now)).toBe(true);
    expect(isPast(null, now)).toBe(false);

    const card = createCard(a, { rendezvous: hints });
    expect(verifyCard(signDoc({ ...card, sig: undefined, expires: 'garbage' }, a)).ok).toBe(false);
    const req = createContactRequest(b, createCard(b, { rendezvous: hints }), { toHint: a.id, greeting: 'hi' });
    const grant = createGrant(a, card, req, { tier: 'friend', scope: {}, expires: 'garbage' });
    expect(verifyGrant(grant)).toBe(false);
    expect(verifyContactRequest(signDoc({ ...req, sig: undefined, ts: 'garbage' }, b))).toBe(false);
    // A contact whose stored expiry is unreadable counts as expired.
    const book = new ContactBook({ contacts: { [a.id]: { peer: a.id, card, tier: 'friend', inboundScope: {}, outboundScope: {}, binding: 'claimed', grantId: grant.id, expires: 'garbage', since: '' } } });
    expect(book.contact(a.id, now)).toBeUndefined();
  });

  it('reports a reused seq as a fork, not a duplicate (security review L4)', () => {
    const a = generateKey();
    const b = generateKey();
    const ch = new Channels();
    const first = sealEnvelope(a, b.id, { type: 'x', n: 1 }, { seq: 1, prev: null });
    expect(ch.acceptInbound(first).kind).toBe('in-order');
    expect(ch.acceptInbound(first).kind).toBe('duplicate'); // the same envelope again
    const reused = sealEnvelope(a, b.id, { type: 'x', n: 2 }, { seq: 1, prev: null }); // peer restored old state
    expect(ch.acceptInbound(reused).kind).toBe('rollback'); // a fork by rollback (issue #13), never a duplicate
  });

  it('orders per direction and detects gaps, duplicates and forks', () => {
    const out = new Channels();
    const inn = new Channels();
    const send = (text: string) => {
      const { seq, prev } = out.nextOutbound(bob.id);
      const e = sealEnvelope(alice, bob.id, { type: 'note', text }, { seq, prev });
      out.commitOutbound(bob.id, e);
      return e;
    };
    const e1 = send('1');
    const e2 = send('2');
    const e3 = send('3');
    expect(inn.acceptInbound(e1).kind).toBe('in-order');
    expect(inn.acceptInbound(e3)).toEqual({ kind: 'gap', missingFrom: 2, missingTo: 2 });
    expect(inn.acceptInbound(e2).kind).toBe('in-order');
    expect(inn.acceptInbound(e2).kind).toBe('duplicate');
    const rogue = sealEnvelope(alice, bob.id, { type: 'note' }, { seq: 4, prev: 'deadbeef' });
    expect(inn.acceptInbound(e3).kind).toBe('in-order');
    expect(inn.acceptInbound(rogue).kind).toBe('fork');
  });

  it('rejects a seq that is not a positive integer', () => {
    for (const seq of [0, -5, 1.5]) {
      expect(openEnvelope(bob, sealEnvelope(alice, bob.id, { type: 'x' }, { seq, prev: null }))).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('peer rollback (issue #13)', () => {
  const omer = generateKey();
  const john = generateKey();
  const t0 = Date.parse('2026-10-25T10:00:00Z');
  /** Omer's sending side; `at(i)` puts envelope i one second after the previous one. */
  function sender() {
    const ch = new Channels();
    let clock = t0;
    const send = (n: number, now = new Date((clock += 1000))) => {
      const { seq, prev } = ch.nextOutbound(john.id);
      const e = sealEnvelope(omer, john.id, { type: 'note', n }, { seq, prev, now });
      ch.commitOutbound(john.id, e);
      return e;
    };
    return { ch, send };
  }
  /** John accepts `count` envelopes from Omer; returns them plus Omer's state after each. */
  function history(count: number) {
    const s = sender();
    const states: string[] = [JSON.stringify(s.ch.state)];
    const sent = [];
    const inn = new Channels();
    for (let i = 1; i <= count; i++) {
      const e = s.send(i);
      sent.push(e);
      states.push(JSON.stringify(s.ch.state));
      expect(inn.acceptInbound(e).kind).toBe('in-order');
    }
    return { sent, states, inn, s };
  }
  /** Omer restores his state from `k` envelopes ago and sends again, later than anything before. */
  function rolledBack(states: string[], k: number, at = t0 + 10_000_000) {
    const ch = new Channels(JSON.parse(states[states.length - 1 - k]));
    const { seq, prev } = ch.nextOutbound(john.id);
    const e = sealEnvelope(omer, john.id, { type: 'note', forked: true }, { seq, prev, now: new Date(at) });
    ch.commitOutbound(john.id, e);
    return { ch, e };
  }

  for (const k of [1, 5, 70]) {
    it(`detects a rollback by ${k}${k > 64 ? ' (more than the outbox)' : ''} and refuses the peer`, () => {
      const { states, inn } = history(80);
      const { e } = rolledBack(states, k);
      expect(e.seq).toBe(80 - k + 1);
      expect(inn.acceptInbound(e)).toEqual({ kind: 'rollback', seq: 80 - k + 1, accepted: 80 });
      expect(inn.refused(omer.id)).toMatchObject({ kind: 'rollback', seq: 80 - k + 1, accepted: 80 });
      // A relay replay of the forking envelope stays silent; anything else from Omer is refused.
      expect(inn.acceptInbound(structuredClone(e)).kind).toBe('duplicate');
      const next = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 81, prev: inn.state[omer.id].inPrev, now: new Date(t0 + 20_000_000) });
      expect(inn.acceptInbound(next).kind).toBe('refused');
      expect(inn.state[omer.id].inSeq).toBe(80); // the forked chain was never accepted
    });
  }

  it('ignores a relay replay of every envelope already accepted (identical bytes)', () => {
    const { sent, inn } = history(80);
    for (const e of sent) expect(inn.acceptInbound(structuredClone(e)).kind).toBe('duplicate');
    expect(inn.refused(omer.id)).toBeUndefined();
    expect(inn.state[omer.id].inRecent).toHaveLength(8); // bounded, not a hash per seq
  });

  it('detects the same seq with different content inside the window, whatever its clock says', () => {
    const { sent, inn } = history(10);
    const old = sent[6]; // seq 7, within the last 8
    const twin = sealEnvelope(omer, john.id, { type: 'note', other: true }, { seq: old.seq, prev: old.prev, now: new Date(t0) }); // older clock
    expect(inn.acceptInbound(twin)).toEqual({ kind: 'rollback', seq: 7, accepted: 10 });
  });

  it('treats an old, unknown envelope below the window as a duplicate (cannot tell; NOTES 56)', () => {
    const { inn } = history(20);
    const stale = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 2, prev: null, now: new Date(t0 + 500) });
    expect(inn.acceptInbound(stale).kind).toBe('duplicate');
    expect(inn.refused(omer.id)).toBeUndefined();
  });

  it('reports a fork past our head and refuses the peer', () => {
    const { inn } = history(3);
    const rogue = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 4, prev: 'deadbeef', now: new Date(t0 + 9_000) });
    expect(inn.acceptInbound(rogue)).toEqual({ kind: 'fork', seq: 4, accepted: 3 });
    const gap = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 9, prev: null, now: new Date(t0 + 9_500) });
    expect(inn.acceptInbound(gap).kind).toBe('refused'); // no resend dance for a refused channel
  });

  it('recovers only after the owner re-syncs, and never re-adopts the old chain', () => {
    const { sent, states, inn } = history(80);
    const { ch, e } = rolledBack(states, 5);
    expect(inn.acceptInbound(e).kind).toBe('rollback');
    expect(() => inn.resync(john.id)).toThrow(/not refused/);
    inn.resync(omer.id);
    // Relay replays of the old chain cannot become the head: none is newer.
    for (const old of sent.slice(-10)) expect(inn.acceptInbound(structuredClone(old)).kind).toBe('duplicate');
    // The forked envelope (newer than all we accepted) becomes the head, and the chain goes on from it.
    expect(inn.acceptInbound(structuredClone(e)).kind).toBe('in-order');
    expect(inn.state[omer.id]).toMatchObject({ inSeq: 76, inPrev: envelopeHash(e) });
    expect(inn.state[omer.id].resync).toBeUndefined();
    const { seq, prev } = ch.nextOutbound(john.id);
    const after = sealEnvelope(omer, john.id, { type: 'note' }, { seq, prev, now: new Date(t0 + 11_000_000) });
    expect(inn.acceptInbound(after).kind).toBe('in-order');
    expect(inn.acceptInbound(structuredClone(e)).kind).toBe('duplicate');
  });

  it('after a re-sync, replays of the old chain stay duplicates on the gap and fork paths too, across a restart', () => {
    const { sent, states, inn } = history(80);
    const { ch, e } = rolledBack(states, 5); // seq 76
    expect(inn.acceptInbound(e).kind).toBe('rollback');
    inn.resync(omer.id);
    expect(inn.acceptInbound(structuredClone(e)).kind).toBe('in-order');
    // Old 77 has a prev that isn't our head (fork path); old 78..80 are past it (gap path).
    for (const old of sent.slice(76)) expect(inn.acceptInbound(structuredClone(old)).kind).toBe('duplicate');
    expect(inn.refused(omer.id)).toBeUndefined();
    const restarted = new Channels(JSON.parse(JSON.stringify(inn.state)));
    for (const old of sent) expect(restarted.acceptInbound(structuredClone(old)).kind).toBe('duplicate');
    expect(restarted.refused(omer.id)).toBeUndefined();
    const { seq, prev } = ch.nextOutbound(john.id);
    const next = sealEnvelope(omer, john.id, { type: 'note' }, { seq, prev, now: new Date(t0 + 11_000_000) });
    expect(restarted.acceptInbound(next).kind).toBe('in-order');
  });

  it('a re-sync of state saved before inNewest existed still never adopts the old chain', () => {
    const { sent, inn } = history(5);
    const legacy = new Channels({ [omer.id]: { outSeq: 0, outPrev: null, inSeq: 5, inPrev: inn.state[omer.id].inPrev } });
    const twin = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 5, prev: sent[4].prev, now: new Date(t0 + 60_000) });
    expect(legacy.acceptInbound(twin).kind).toBe('rollback');
    legacy.resync(omer.id);
    for (const old of sent) expect(legacy.acceptInbound(structuredClone(old)).kind).toBe('duplicate');
    expect(legacy.acceptInbound(structuredClone(twin)).kind).toBe('in-order');
  });

  it('keeps refusal and re-sync across toJSON/fromJSON', () => {
    const { states, inn } = history(80);
    const { e } = rolledBack(states, 70);
    expect(inn.acceptInbound(e).kind).toBe('rollback');
    const saved = new Channels(JSON.parse(JSON.stringify(inn.state)));
    expect(saved.refused(omer.id)).toMatchObject({ kind: 'rollback', seq: 11 });
    expect(saved.acceptInbound(structuredClone(e)).kind).toBe('duplicate');
    const later = rolledBack(states, 70, t0 + 12_000_000).e;
    expect(saved.acceptInbound(later).kind).toBe('refused');
    saved.resync(omer.id);
    const again = new Channels(JSON.parse(JSON.stringify(saved.state)));
    expect(again.acceptInbound(later).kind).toBe('in-order');
    expect(again.state[omer.id].inSeq).toBe(11);
  });

  it('upgrades channel state saved before the window existed', () => {
    const { sent, inn } = history(5);
    const legacy = new Channels({ [omer.id]: { outSeq: 0, outPrev: null, inSeq: 5, inPrev: inn.state[omer.id].inPrev } });
    expect(legacy.acceptInbound(structuredClone(sent[4])).kind).toBe('duplicate');
    expect(legacy.acceptInbound(structuredClone(sent[1])).kind).toBe('duplicate'); // too old to tell without a window
    const twin = sealEnvelope(omer, john.id, { type: 'note' }, { seq: 5, prev: sent[4].prev, now: new Date(t0) });
    expect(legacy.acceptInbound(twin).kind).toBe('rollback');
  });
});

describe('contact book', () => {
  const alice = generateKey();
  const bob = generateKey();
  const aliceCard = createCard(alice, { rendezvous: hints });
  const bobCard = createCard(bob, { rendezvous: hints });

  it('runs request → pending → grant on both sides', () => {
    const aliceBook = new ContactBook();
    const bobBook = new ContactBook();
    const req = createContactRequest(alice, aliceCard, { toHint: bob.id, greeting: 'hi' });
    aliceBook.trackOutstanding(req, 'claimed', bob.id);

    const outcome = bobBook.receiveRequest(req, 'claimed');
    expect(outcome.status).toBe('pending');
    expect(bobBook.receiveRequest(req, 'claimed').status).toBe('duplicate');
    expect(bobBook.admitInbound(alice.id)).toBe(false);

    const grant = createGrant(bob, bobCard, req, { tier: 'friend', scope: { may_initiate: true, max_frequency: '2/minute' } });
    bobBook.recordIssuedGrant(grant, req, 'claimed');
    expect(bobBook.state.pending).toEqual({});

    const c = aliceBook.receiveGrant(grant, alice.id);
    expect(c && 'contact' in c && c.contact.peer).toBe(bob.id);
    expect(aliceBook.receiveGrant(grant, alice.id)).toBeNull(); // replay

    expect(bobBook.admitInbound(alice.id)).toBe(true);
    expect(bobBook.admitInbound(alice.id)).toBe(true);
    expect(bobBook.admitInbound(alice.id)).toBe(false); // over max_frequency → revoked
    expect(bobBook.contact(alice.id)).toBeUndefined();
  });

  it('rejects unsolicited grants, forged requests, and honors block/allow', () => {
    const book = new ContactBook();
    const req = createContactRequest(alice, aliceCard, { toHint: bob.id, greeting: 'hi' });
    const grant = createGrant(bob, bobCard, req, { tier: 'friend', scope: {} });
    expect(book.receiveGrant(grant, alice.id)).toBeNull(); // never requested

    expect(book.receiveRequest({ ...req, greeting: 'tampered' }, 'claimed').status).toBe('invalid');
    const mallory = generateKey();
    const stolenCard = createContactRequest(mallory, aliceCard, { toHint: bob.id, greeting: 'hi' });
    expect(book.receiveRequest(stolenCard, 'claimed').status).toBe('invalid');

    const blocked = new ContactBook({ blocked: [alice.id] });
    expect(blocked.receiveRequest(req, 'claimed').status).toBe('blocked');

    const allow = new ContactBook({ policy: 'allow', allowlist: { [alice.id]: { tier: 'family', scope: {} } } });
    expect(allow.receiveRequest(req, 'claimed')).toMatchObject({ status: 'auto-grant', tier: 'family' });
    const req2 = createContactRequest(mallory, createCard(mallory, { rendezvous: hints }), { toHint: bob.id, greeting: 'x' });
    expect(allow.receiveRequest(req2, 'claimed').status).toBe('blocked');
  });

  it('applies revocations from the peer only', () => {
    const book = new ContactBook();
    const req = createContactRequest(alice, aliceCard, { toHint: bob.id, greeting: 'hi' });
    book.trackOutstanding(req, 'claimed', bob.id);
    const grant = createGrant(bob, bobCard, req, { tier: 'friend', scope: {} });
    expect(book.receiveGrant(grant, alice.id)).not.toBeNull();
    expect(book.receiveRevoke(createRevoke(bob, generateKey().id, grant.id), alice.id)).toBe(false);
    expect(book.receiveRevoke(createRevoke(bob, alice.id, grant.id), alice.id)).toBe(true);
    expect(book.contact(bob.id)).toBeUndefined();
  });

  it('labels a contact only with what the local human used, never with what its card claims', () => {
    const claims = (k: ReturnType<typeof generateKey>, email: string) =>
      createCard(k, { rendezvous: hints, discovery: { addresses: [{ type: 'email', value: email }], public_pointer: false } });
    const john = generateKey();
    const mallory = generateKey();
    const book = new ContactBook();
    // A request by card, labeled with the address the human looked up.
    const toJohn = createContactRequest(alice, aliceCard, { toHint: john.id, greeting: 'hi' });
    book.trackOutstanding(toJohn, 'claimed', john.id, ' john@doe.com ');
    book.receiveGrant(createGrant(john, claims(john, 'john@doe.com'), toJohn, { tier: 'friend', scope: {} }), alice.id);
    expect(book.contact(john.id)?.label).toBe('john@doe.com');
    // Mallory's card claims John's address, but nobody local named her: no label, so "john@doe.com" still means John.
    const fromMallory = createContactRequest(mallory, claims(mallory, 'john@doe.com'), { toHint: alice.id, greeting: 'hi' });
    book.receiveRequest(fromMallory, 'claimed');
    book.recordIssuedGrant(createGrant(alice, aliceCard, fromMallory, { tier: 'friend', scope: {} }), fromMallory, 'claimed');
    expect(book.contact(mallory.id)?.label).toBeUndefined();
    expect(book.byLabel('JOHN@doe.com').map((c) => c.peer)).toEqual([john.id]);
    // A probe is labeled with the probed address; confirming a claimant makes the label ambiguous, which callers must refuse.
    const probe = createContactRequest(alice, aliceCard, { toHint: 'john@doe.com', greeting: 'hi' });
    book.trackOutstanding(probe);
    expect(book.state.outstanding[probe.id].label).toBe('john@doe.com');
    const mallory2 = generateKey();
    const eg = createGrant(mallory2, claims(mallory2, 'john@doe.com'), probe, { tier: 'friend', scope: {} });
    book.receiveGrant(eg, alice.id);
    expect(book.confirmCandidate(eg.id).label).toBe('john@doe.com');
    expect(book.byLabel('john@doe.com').map((c) => c.peer).sort()).toEqual([john.id, mallory2.id].sort());
    // The human renames; labels are local and checked.
    book.setLabel(mallory2.id, 'Not John');
    expect(book.byLabel('john@doe.com').map((c) => c.peer)).toEqual([john.id]);
    expect(() => book.setLabel(mallory2.id, 'a\u202eb')).toThrow(/label/);
    expect(() => book.setLabel(mallory2.id, '  ')).toThrow(/label/);
  });
});

describe('grant acceptance (security regression)', () => {
  const setup = () => {
    const omer = generateKey();
    const john = generateKey();
    const mallory = generateKey();
    const card = (k: ReturnType<typeof generateKey>) => createCard(k, { rendezvous: hints });
    const req = createContactRequest(omer, card(omer), { toHint: john.id, greeting: 'hi' });
    const scope = { may_initiate: true };
    const grantFrom = (k: ReturnType<typeof generateKey>) => createGrant(k, card(k), req, { tier: 'friend', scope });
    return { omer, john, mallory, req, grantFrom };
  };

  it('rejects a grant from anyone but the agent a card request was sent to', () => {
    const { omer, john, mallory, req, grantFrom } = setup();
    const book = new ContactBook();
    book.trackOutstanding(req, 'in-person', john.id);
    const forged = grantFrom(mallory);
    expect(book.receiveGrant(forged, omer.id)).toBeNull();
    // Rejected before any state was touched.
    expect(book.state.outstanding[req.id]).toBeDefined();
    expect(book.state.seenIds).not.toContain(forged.id);
    expect(book.state.contacts).toEqual({});

    const real = book.receiveGrant(grantFrom(john), omer.id);
    expect(real && 'contact' in real && real.contact.peer).toBe(john.id);
    expect(real && 'contact' in real && real.contact.binding).toBe('in-person');
  });
});

describe('received grants never widen inbound rights (security review H1/H2)', () => {
  const key = () => generateKey();
  const cardFor = (k: ReturnType<typeof generateKey>, email?: string) =>
    createCard(k, { rendezvous: hints, discovery: email ? { addresses: [{ type: 'email', value: email }], public_pointer: false } : undefined });
  const bob = key();
  const alice = key();
  const mallory = key();
  const bobCard = cardFor(bob, 'bob@x.com');
  const loud = { may_initiate: true, may_propose_meetings: true, may_access_calendar: 'full' as const };

  it('a topic probe answer is a candidate for the human, needs a card claiming the address, and does not drop the real one', () => {
    const book = new ContactBook();
    const probe = createContactRequest(bob, bobCard, { toHint: 'alice@x.com', greeting: 'hi' });
    book.trackOutstanding(probe);
    // Mallory's card does not claim alice@x.com: refused outright.
    expect(book.receiveGrant(createGrant(mallory, cardFor(mallory), probe, { tier: 'spouse', scope: loud }), bob.id)).toBeNull();
    // Mallory claims the address too: she becomes a candidate, not a contact, and the probe stays open.
    const mg = createGrant(mallory, cardFor(mallory, 'Alice@X.com'), probe, { tier: 'spouse', scope: loud });
    const m = book.receiveGrant(mg, bob.id);
    expect(m && 'candidate' in m).toBe(true);
    expect(book.contact(mallory.id)).toBeUndefined();
    expect(book.state.outstanding[probe.id]).toBeDefined();
    // A second claimant from the same grantor is ignored; Alice's genuine grant still lands as a candidate.
    expect(book.receiveGrant(createGrant(mallory, cardFor(mallory, 'alice@x.com'), probe, { tier: 'friend', scope: {} }), bob.id)).toBeNull();
    const ag = createGrant(alice, cardFor(alice, 'alice@x.com'), probe, { tier: 'friend', scope: { may_initiate: true } });
    const a = book.receiveGrant(ag, bob.id);
    expect(a && 'candidate' in a).toBe(true);
    expect(Object.keys(book.state.candidates).sort()).toEqual([ag.id, mg.id].sort());

    // The human picks Alice: contact, claimed, inbound the local default; Mallory's candidate and the probe are gone.
    const c = book.confirmCandidate(ag.id);
    expect(c).toMatchObject({ peer: alice.id, binding: 'claimed', tier: 'stranger', grantedTier: 'friend', inboundGranted: false });
    expect(c.inboundScope).toEqual(DEFAULT_INBOUND_SCOPE);
    expect(book.state.candidates).toEqual({});
    expect(book.state.outstanding[probe.id]).toBeUndefined();
    expect(() => book.confirmCandidate(mg.id)).toThrow(/no grant candidate/);
  });

  it('the grantor picks only our outbound scope: inbound stays the local default until our human grants', () => {
    const book = new ContactBook();
    const back = createContactRequest(bob, bobCard, { toHint: mallory.id, greeting: 'hi' });
    book.trackOutstanding(back, 'claimed', mallory.id);
    const got = book.receiveGrant(createGrant(mallory, cardFor(mallory), back, { tier: 'family', scope: loud }), bob.id);
    const c = got && 'contact' in got ? got.contact : undefined;
    expect(c?.outboundScope).toEqual(loud);
    expect(c?.tier).toBe('stranger');
    expect(c?.inboundScope).toEqual(DEFAULT_INBOUND_SCOPE);
    expect(c?.inboundScope?.may_propose_meetings).toBe(false);
    // The local default rate limit applies, not "unlimited because the grant omitted max_frequency".
    let admitted = 0;
    for (let i = 0; i < 200; i++) if (book.admitInbound(mallory.id)) admitted++;
    expect(admitted).toBe(50);

    // Only the human widens it.
    const book2 = new ContactBook();
    book2.trackOutstanding(back, 'claimed', mallory.id);
    book2.receiveGrant(createGrant(mallory, cardFor(mallory), back, { tier: 'friend', scope: {} }), bob.id);
    const up = book2.allowInbound(mallory.id, { tier: 'friend', scope: { may_initiate: true, may_propose_meetings: true } });
    expect(up).toMatchObject({ tier: 'friend', inboundGranted: true });
    expect(up.inboundScope?.may_propose_meetings).toBe(true);
  });

  it('a flood of answers fills only its own probe, is counted, and never evicts another probe', () => {
    const book = new ContactBook();
    const flooded = createContactRequest(bob, bobCard, { toHint: 'alice@x.com', greeting: 'hi' });
    const other = createContactRequest(bob, bobCard, { toHint: 'carol@x.com', greeting: 'hi' });
    book.trackOutstanding(other);
    book.trackOutstanding(flooded);
    const carol = key();
    const real = book.receiveGrant(createGrant(carol, cardFor(carol, 'carol@x.com'), other, { tier: 'friend', scope: {} }), bob.id);
    expect(real && 'candidate' in real).toBe(true);

    const results = Array.from({ length: CANDIDATES_PER_PROBE + 5 }, () => {
      const k = key();
      return book.receiveGrant(createGrant(k, cardFor(k, 'alice@x.com'), flooded, { tier: 'friend', scope: {} }), bob.id);
    });
    expect(results.filter((r) => r && 'candidate' in r)).toHaveLength(CANDIDATES_PER_PROBE);
    const last = results.at(-1);
    expect(last && 'overflow' in last && last.overflow).toEqual({ request_ref: flooded.id, to_hint: 'alice@x.com', dropped: 5 });
    // Carol's answer to the other probe survived the flood.
    expect(Object.values(book.state.candidates).filter((c) => c.request_ref === other.id).map((c) => c.grant.from)).toEqual([carol.id]);
    expect(book.probeOverflows()).toEqual([{ request_ref: flooded.id, to_hint: 'alice@x.com', dropped: 5 }]);
  });

  it('rejects a grant whose tier is not in the enum', () => {
    const book = new ContactBook();
    const back = createContactRequest(bob, bobCard, { toHint: mallory.id, greeting: 'hi' });
    book.trackOutstanding(back, 'claimed', mallory.id);
    const weird = createGrant(mallory, cardFor(mallory), back, { tier: 'x\u001b[31m' as never, scope: {} });
    expect(verifyGrant(weird)).toBe(false);
    expect(book.receiveGrant(weird, bob.id)).toBeNull();
    expect(TIERS).toContain('stranger');
  });
});

describe('bounded peer-driven state (security review M1)', () => {
  const card = (k: ReturnType<typeof generateKey>) => createCard(k, { rendezvous: hints });
  const reqFrom = (k = generateKey()) => createContactRequest(k, card(k), { toHint: 'bob@x.com', greeting: 'x' });

  it('caps pending requests overall and per sender', () => {
    const book = new ContactBook();
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    for (let i = 0; i < 200; i++) book.receiveRequest(reqFrom(), 'claimed', new Date(t0 + i * 1000));
    expect(Object.keys(book.state.pending)).toHaveLength(PENDING_LIMIT);
    // Same rank: the newest are kept, the oldest evicted.
    const received = Object.values(book.state.pending).map((p) => Date.parse(p.received));
    expect(Math.min(...received)).toBe(t0 + (200 - PENDING_LIMIT) * 1000);

    const one = new ContactBook();
    const mallory = generateKey();
    const outcomes = Array.from({ length: PENDING_PER_SENDER + 2 }, () => one.receiveRequest(reqFrom(mallory), 'claimed').status);
    expect(outcomes.filter((s) => s === 'pending')).toHaveLength(PENDING_PER_SENDER);
    expect(outcomes.at(-1)).toBe('rate-limited');
  });

  it('a flood of probes evicts probes, not a request sent to our card; evicted requesters can retry', () => {
    const book = new ContactBook();
    const me = generateKey();
    const friend = generateKey();
    const direct = createContactRequest(friend, card(friend), { toHint: me.id, greeting: 'hi' });
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    expect(book.receiveRequest(direct, 'claimed', new Date(t0), { via: 'envelope', me: me.id }).status).toBe('pending');
    const flood = Array.from({ length: 200 }, () => reqFrom());
    flood.forEach((r, i) => book.receiveRequest(r, 'claimed', new Date(t0 + (i + 1) * 1000), { via: 'topic', me: me.id }));
    expect(Object.keys(book.state.pending)).toHaveLength(PENDING_LIMIT);
    expect(book.state.pending[direct.id]).toBeDefined(); // oldest, but sent to our card: kept
    expect(book.state.pendingEvicted).toBe(200 + 1 - PENDING_LIMIT);
    // An evicted probe is no longer "seen": its retry is accepted (evicting the oldest probe).
    const gone = flood[0];
    expect(book.state.seenIds).not.toContain(gone.id);
    const retry = book.receiveRequest(gone, 'claimed', new Date(t0 + 999_000), { via: 'topic', me: me.id });
    expect(retry).toMatchObject({ status: 'pending', evicted: { id: flood[200 + 1 - PENDING_LIMIT].id } });
    expect(book.state.pending[gone.id]).toBeDefined();
  });

  it('a forged to_hint does not make a flood look direct', () => {
    const book = new ContactBook();
    const me = generateKey();
    const friend = generateKey();
    const t0 = Date.parse('2026-10-25T10:00:00Z');
    const real = createContactRequest(friend, card(friend), { toHint: me.id, greeting: 'hi' });
    book.receiveRequest(real, 'claimed', new Date(t0), { via: 'envelope', me: me.id });
    for (let i = 0; i < 150; i++) {
      const k = generateKey();
      // Half claim to be addressed to us but were posted on a topic; half came in envelopes naming someone else.
      const forged = createContactRequest(k, card(k), { toHint: i % 2 ? me.id : generateKey().id, greeting: 'x' });
      book.receiveRequest(forged, 'claimed', new Date(t0 + (i + 1) * 1000), { via: i % 2 ? 'topic' : 'envelope', me: me.id });
    }
    expect(book.state.pending[real.id]).toMatchObject({ direct: true });
    expect(Object.values(book.state.pending).filter((p) => p.direct)).toHaveLength(1);
  });

  it('control messages are rate-limited without revoking (security review L3)', () => {
    const book = new ContactBook();
    const now = new Date('2026-10-25T10:00:00Z');
    const limit = { count: 10, windowMs: 3_600_000 };
    const ok = Array.from({ length: 25 }, () => book.admitControl('resend', 'rdv1:peer', limit, now)).filter(Boolean);
    expect(ok).toHaveLength(10);
    expect(book.admitControl('resend', 'rdv1:peer', limit, new Date(now.getTime() + 3_600_001))).toBe(true);
    expect(RESEND_LIMIT.count).toBeLessThanOrEqual(10);
  });

  it('a declined request stays declined after a flood evicts the replay ids', () => {
    const book = new ContactBook();
    const req = reqFrom();
    expect(book.receiveRequest(req, 'claimed').status).toBe('pending');
    book.decline(req.id);
    for (let i = 0; i < 5001; i++) book.markSeen(crypto.randomUUID());
    expect(book.state.seenIds).not.toContain(req.id);
    expect(book.receiveRequest(req, 'claimed').status).toBe('duplicate');
    expect(book.state.pending).toEqual({});
  });
});

describe('document ids (security regression)', () => {
  it('rejects request and grant ids that are not UUIDs, e.g. with an ESC sequence', () => {
    const omer = generateKey();
    const john = generateKey();
    const evilId = '\u001b[2J\u001b]0;pwned\u0007';
    const req = signDoc(
      { ...createContactRequest(omer, createCard(omer, { rendezvous: hints }), { toHint: 'x', greeting: 'hi' }), sig: undefined, id: evilId },
      omer,
    );
    expect(verifyContactRequest(req)).toBe(false);
    const good = createContactRequest(omer, createCard(omer, { rendezvous: hints }), { toHint: 'x', greeting: 'hi' });
    expect(verifyContactRequest(good)).toBe(true);
    const grant = createGrant(john, createCard(john, { rendezvous: hints }), good, { tier: 'friend', scope: {} });
    expect(verifyGrant(grant)).toBe(true);
    expect(verifyGrant(signDoc({ ...grant, sig: undefined, id: evilId }, john))).toBe(false);
    expect(verifyGrant(signDoc({ ...grant, sig: undefined, request_ref: evilId }, john))).toBe(false);
  });
});

describe('reverse grants (issue #14, NOTES 60)', () => {
  const card = (k: ReturnType<typeof generateKey>) => createCard(k, { rendezvous: hints });
  const meet = { may_initiate: true, may_propose_meetings: true, max_frequency: '100/day' };
  const loud = { may_initiate: true, may_propose_meetings: true, may_access_calendar: 'full' as const };
  /** Omer requested John by card and John granted: both books hold the contact under John's grant id. */
  const setup = () => {
    const omer = generateKey();
    const john = generateKey();
    const mallory = generateKey();
    const req = createContactRequest(omer, card(omer), { toHint: john.id, greeting: 'hi' });
    const omerBook = new ContactBook();
    const johnBook = new ContactBook();
    omerBook.trackOutstanding(req, 'claimed', john.id);
    expect(johnBook.receiveRequest(req, 'claimed').status).toBe('pending');
    const grant = createGrant(john, card(john), req, { tier: 'friend', scope: { may_initiate: true, may_propose_meetings: true } });
    johnBook.recordIssuedGrant(grant, req, 'claimed');
    expect(omerBook.receiveGrant(grant, omer.id)).not.toBeNull();
    const reverse = (opts: { from?: ReturnType<typeof generateKey>; scope?: object; ts?: Date; expires?: string | null; ref?: string } = {}) =>
      createReverseGrant(opts.from ?? omer, card(opts.from ?? omer), { peer: john.id, grantId: opts.ref ?? grant.id }, {
        tier: 'friend',
        scope: opts.scope ?? meet,
        now: opts.ts,
        expires: opts.expires,
      });
    return { omer, john, mallory, req, grant, omerBook, johnBook, reverse };
  };

  it('the grantor applies it to its outbound scope only, and can then propose meetings', () => {
    const { john, omer, johnBook, reverse } = setup();
    const before = structuredClone(johnBook.contact(omer.id)!);
    expect(before.outboundScope?.may_propose_meetings).not.toBe(true); // the gap issue #14 closes
    const rev = reverse({ scope: loud });
    expect(verifyReverseGrant(rev)).toBe(true);
    expect(verifyGrant(rev)).toBe(false); // never mistaken for a forward grant
    const got = johnBook.receiveReverseGrant(rev, john.id);
    expect('contact' in got && got.contact.outboundScope).toEqual(loud);
    const c = johnBook.contact(omer.id)!;
    expect(c).toMatchObject({ grantedTier: 'friend', reverseGrantId: rev.id, grantId: before.grantId });
    // What Omer may do towards John is still John's own grant: a received grant never sets it.
    expect([c.tier, c.inboundScope, c.inboundGranted]).toEqual([before.tier, before.inboundScope, true]);
  });

  it('works the other way too, and never widens the receiver’s inbound default', () => {
    const { john, omer, omerBook, grant } = setup();
    // John's human re-grants Omer: Omer applies it to outbound; its inbound for John stays the local default.
    const rev = createReverseGrant(john, card(john), { peer: omer.id, grantId: grant.id }, { tier: 'spouse', scope: loud });
    const got = omerBook.receiveReverseGrant(rev, omer.id);
    expect('contact' in got && got.contact.outboundScope).toEqual(loud);
    expect(omerBook.contact(john.id)).toMatchObject({ tier: 'stranger', inboundGranted: false, inboundScope: DEFAULT_INBOUND_SCOPE });
  });

  it('rejects reverse grants from non-contacts or for another relationship', () => {
    const { john, mallory, johnBook, reverse, omer } = setup();
    const seen = johnBook.state.seenIds.length;
    // Mallory is no contact of John's, even naming the real grant id.
    expect(johnBook.receiveReverseGrant(reverse({ from: mallory }), john.id)).toEqual({ rejected: 'not-contact' });
    // Omer's, but naming a grant that did not found this contact.
    expect(johnBook.receiveReverseGrant(reverse({ ref: crypto.randomUUID() }), john.id)).toEqual({ rejected: 'not-contact' });
    // Addressed to someone else.
    const toOther = createReverseGrant(omer, card(omer), { peer: mallory.id, grantId: johnBook.contact(omer.id)!.grantId }, { tier: 'friend', scope: meet });
    expect(johnBook.receiveReverseGrant(toOther, john.id)).toEqual({ rejected: 'invalid' });
    // A blocked contact.
    const blocked = new ContactBook(structuredClone(johnBook.state));
    blocked.state.blocked.push(omer.id);
    expect(blocked.receiveReverseGrant(reverse(), john.id)).toEqual({ rejected: 'not-contact' });
    // A book with no contacts at all.
    expect(new ContactBook().receiveReverseGrant(reverse(), john.id)).toEqual({ rejected: 'not-contact' });
    expect(johnBook.contact(omer.id)?.outboundScope?.may_propose_meetings).not.toBe(true);
    expect(johnBook.state.seenIds.length).toBe(seen); // refused grants leave no trace
  });

  it('rejects forged and malformed reverse grants', () => {
    const { john, mallory, johnBook, reverse, omer } = setup();
    const rev = reverse();
    expect(johnBook.receiveReverseGrant({ ...rev, scope: loud }, john.id)).toEqual({ rejected: 'invalid' }); // tampered
    // Signed by Mallory but claiming to be from Omer.
    expect(johnBook.receiveReverseGrant(signDoc({ ...rev, sig: undefined }, mallory), john.id)).toEqual({ rejected: 'invalid' });
    // Both refs, or a grant_ref that is not a UUID: ambiguous, refused by both verifiers.
    const both = signDoc({ ...rev, sig: undefined, request_ref: crypto.randomUUID() }, omer);
    expect([verifyReverseGrant(both), verifyGrant(both)]).toEqual([false, false]);
    expect(verifyReverseGrant(signDoc({ ...rev, sig: undefined, grant_ref: '\u001b[2J' }, omer))).toBe(false);
    expect(verifyReverseGrant(signDoc({ ...rev, sig: undefined, tier: 'overlord' }, omer))).toBe(false);
    expect(verifyReverseGrant(signDoc({ ...rev, sig: undefined, scope: [] }, omer))).toBe(false);
    expect(johnBook.contact(omer.id)?.outboundScope?.may_propose_meetings).not.toBe(true);
  });

  it('rejects replayed, stale, future-dated and expired reverse grants', () => {
    const { john, johnBook, reverse, omer } = setup();
    const t0 = Date.now();
    const old = reverse({ scope: loud, ts: new Date(t0 - 60_000) });
    const narrow = reverse({ scope: { may_initiate: true }, ts: new Date(t0) });
    expect('contact' in johnBook.receiveReverseGrant(narrow, john.id)).toBe(true);
    expect(johnBook.receiveReverseGrant(narrow, john.id)).toMatchObject({ rejected: expect.stringMatching(/stale|replay/) });
    // An older, wider grant can't undo Omer's narrowing, even once its id has left seenIds.
    for (let i = 0; i < 5001; i++) johnBook.markSeen(crypto.randomUUID());
    expect(johnBook.receiveReverseGrant(old, john.id)).toEqual({ rejected: 'stale' });
    expect(johnBook.contact(omer.id)?.outboundScope).toEqual({ may_initiate: true });
    // Too far ahead of our clock (it would make every later update stale).
    const future = reverse({ ts: new Date(t0 + REVERSE_GRANT_SKEW_MS + 60_000) });
    expect(johnBook.receiveReverseGrant(future, john.id)).toEqual({ rejected: 'stale' });
    expect(johnBook.receiveReverseGrant(reverse({ expires: new Date(t0 - 1000).toISOString() }), john.id)).toEqual({ rejected: 'expired' });
    // A replay that is not stale (same doc, outboundTs gone) is still caught by seenIds.
    const fresh = reverse({ ts: new Date(t0 + 1000) });
    expect('contact' in johnBook.receiveReverseGrant(fresh, john.id)).toBe(true);
    delete johnBook.state.contacts[omer.id].outboundTs;
    expect(johnBook.receiveReverseGrant(fresh, john.id)).toEqual({ rejected: 'replay' });
  });

  it('an expiring reverse grant can shorten the contact, never extend it', () => {
    const { john, johnBook, reverse, omer } = setup();
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect('contact' in johnBook.receiveReverseGrant(reverse({ expires: soon }), john.id)).toBe(true);
    expect(johnBook.contact(omer.id)?.expires).toBe(soon);
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect('contact' in johnBook.receiveReverseGrant(reverse({ expires: later, ts: new Date(Date.now() + 1000) }), john.id)).toBe(true);
    expect(johnBook.contact(omer.id)?.expires).toBe(soon);
  });

  it('revocation removes what a reverse grant set, and the reverse grant cannot bring it back', () => {
    const { john, johnBook, reverse, omer, grant } = setup();
    expect('contact' in johnBook.receiveReverseGrant(reverse(), john.id)).toBe(true);
    expect(johnBook.receiveRevoke(createRevoke(omer, john.id, grant.id), john.id)).toBe(true);
    expect(johnBook.contact(omer.id)).toBeUndefined();
    expect(johnBook.receiveReverseGrant(reverse({ ts: new Date(Date.now() + 1000) }), john.id)).toEqual({ rejected: 'not-contact' });
    // Our own revoke too.
    const s2 = setup();
    expect('contact' in s2.johnBook.receiveReverseGrant(s2.reverse(), s2.john.id)).toBe(true);
    s2.johnBook.revoke(s2.omer.id);
    expect(s2.johnBook.contact(s2.omer.id)).toBeUndefined();
  });
});

