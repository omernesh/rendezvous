import { describe, expect, it } from 'vitest';
import {
  Channels,
  ContactBook,
  canonicalize,
  createCard,
  createContactRequest,
  createGrant,
  createRevoke,
  defaultTier,
  dtopic,
  fingerprint,
  generateKey,
  isAgentId,
  openEnvelope,
  sealEnvelope,
  signDoc,
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
    aliceBook.trackOutstanding(req);

    const outcome = bobBook.receiveRequest(req, 'claimed');
    expect(outcome.status).toBe('pending');
    expect(bobBook.receiveRequest(req, 'claimed').status).toBe('duplicate');
    expect(bobBook.admitInbound(alice.id)).toBe(false);

    const grant = createGrant(bob, bobCard, req, { tier: 'friend', scope: { may_initiate: true, max_frequency: '2/minute' } });
    bobBook.recordIssuedGrant(grant, req, 'claimed');
    expect(bobBook.state.pending).toEqual({});

    const c = aliceBook.receiveGrant(grant, alice.id);
    expect(c?.peer).toBe(bob.id);
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
    book.trackOutstanding(req);
    const grant = createGrant(bob, bobCard, req, { tier: 'friend', scope: {} });
    book.receiveGrant(grant, alice.id);
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
    expect(real?.peer).toBe(john.id);
    expect(real?.binding).toBe('in-person');
  });

  it('accepts any grantor for a topic probe, but only as claimed', () => {
    const { omer, mallory, req, grantFrom } = setup();
    const book = new ContactBook();
    book.trackOutstanding(req, 'in-person'); // no target: a topic probe
    const c = book.receiveGrant(grantFrom(mallory), omer.id);
    expect(c?.peer).toBe(mallory.id);
    expect(c?.binding).toBe('claimed');
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

