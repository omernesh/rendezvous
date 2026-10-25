import { describe, expect, it } from 'vitest';
import {
  Channels,
  ContactBook,
  canonicalize,
  createCard,
  createContactRequest,
  createGrant,
  createRevoke,
  CANDIDATES_PER_PROBE,
  DEFAULT_INBOUND_SCOPE,
  PENDING_LIMIT,
  PENDING_PER_SENDER,
  defaultTier,
  dtopic,
  fingerprint,
  generateKey,
  isAgentId,
  openEnvelope,
  sealEnvelope,
  signDoc,
  TIERS,
  verifyCard,
  verifyContactRequest,
  verifyGrant,
  verifyDoc,
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
    // The newest are kept, the oldest evicted.
    const received = Object.values(book.state.pending).map((p) => Date.parse(p.received));
    expect(Math.min(...received)).toBe(t0 + (200 - PENDING_LIMIT) * 1000);

    const one = new ContactBook();
    const mallory = generateKey();
    const outcomes = Array.from({ length: PENDING_PER_SENDER + 2 }, () => one.receiveRequest(reqFrom(mallory), 'claimed').status);
    expect(outcomes.filter((s) => s === 'pending')).toHaveLength(PENDING_PER_SENDER);
    expect(outcomes.at(-1)).toBe('rate-limited');
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

