// Invite links (SPEC §5.2.3, NOTES 101): the payload, the inviter's book, and
// the whole flow on the in-memory relay.
import { base64urlnopad } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  canonicalize,
  checkInviteRelays,
  ContactBook,
  dtopic,
  inviteRelayProblem,
  restoredAgentState,
  restoreRevokedInvites,
  createCard,
  createContactRequest,
  generateKey,
  type InviteRedeemed,
  INVITE_TIERS,
  inviteExpired,
  inviteSecretHash,
  inviteShareText,
  inviteUrl,
  isInviteSecret,
  newInviteSecret,
  NostrTransport,
  parseInvite,
  type PendingRequest,
  sameHash,
  utf8ToBytes,
  verifyContactRequest,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const DAY = 86_400_000;
const inv = (over: Partial<Parameters<typeof inviteUrl>[0]> = {}) => ({
  agentId: generateKey().id,
  relays: ['wss://relay.example.com'],
  secret: newInviteSecret(),
  expires: new Date(Date.now() + 7 * DAY).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  name: 'Omer',
  ...over,
});
const payloadOf = (url: string) => url.slice(url.indexOf('#') + 1);
const encodeRaw = (o: unknown) => base64urlnopad.encode(utf8ToBytes(typeof o === 'string' ? o : canonicalize(o)));

describe('invite payload', () => {
  it('round-trips through the link, the payload alone and rdv-invite:, and fits a text message', () => {
    const i = inv();
    const url = inviteUrl(i);
    expect(url.startsWith('https://rendezvous.nesher.co/i#')).toBe(true);
    expect(url.length).toBeLessThan(400);
    const back = parseInvite(url);
    expect(back).toEqual({ ...i, expires: new Date(Math.floor(Date.parse(i.expires) / 1000) * 1000).toISOString() });
    expect(parseInvite(payloadOf(url))).toEqual(back);
    expect(parseInvite(`rdv-invite:${payloadOf(url)}`)).toEqual(back);
    // Pasted in a sentence: surrounding space and trailing punctuation are not part of it.
    expect(parseInvite(`  ${url}.\n`)).toEqual(back);
    expect(parseInvite(`${url}")`)).toEqual(back);
    // Any host: the payload is what counts (the inviter's agent checks the secret).
    expect(parseInvite(`https://example.org/x#${payloadOf(url)}`)).toEqual(back);
    const { name: _n, ...noName } = i;
    expect(parseInvite(inviteUrl(noName)).name).toBeUndefined();
  });

  it('refuses a tampered, cut, non-canonical or unknown payload', () => {
    const i = inv();
    const p = payloadOf(inviteUrl(i));
    expect(() => parseInvite(p.slice(0, -6))).toThrow(/not an invite/);
    expect(() => parseInvite('')).toThrow(/not an invite/);
    expect(() => parseInvite('https://rendezvous.nesher.co/i#')).toThrow(/not an invite/);
    expect(() => parseInvite('a'.repeat(2000))).toThrow(/not an invite/);
    const base = { v: 1, a: i.agentId, r: i.relays, s: i.secret, e: Math.floor(Date.parse(i.expires) / 1000), n: 'Omer' };
    expect(parseInvite(encodeRaw(base)).agentId).toBe(i.agentId);
    expect(() => parseInvite(encodeRaw({ ...base, v: 2 }))).toThrow(/newer version/);
    expect(() => parseInvite(encodeRaw({ ...base, x: 1 }))).toThrow(/unknown field/);
    expect(() => parseInvite(encodeRaw({ ...base, a: 'rdv1:nope' }))).toThrow(/agent ID/);
    expect(() => parseInvite(encodeRaw({ ...base, r: [] }))).toThrow(/relays/);
    expect(() => parseInvite(encodeRaw({ ...base, r: ['https://x'] }))).toThrow(/relays/);
    expect(() => parseInvite(encodeRaw({ ...base, r: ['wss://a.example', 'wss://a.example'] }))).toThrow(/relays/);
    expect(() => parseInvite(encodeRaw({ ...base, r: ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'] }))).toThrow(/relays/);
    expect(() => parseInvite(encodeRaw({ ...base, s: 'short' }))).toThrow(/secret/);
    expect(() => parseInvite(encodeRaw({ ...base, s: `${i.secret.slice(0, 21)}B` }))).toThrow(/secret/); // stray low bits
    expect(() => parseInvite(encodeRaw({ ...base, e: 1.5 }))).toThrow(/expiry/);
    expect(() => parseInvite(encodeRaw({ ...base, e: '2026' }))).toThrow(/expiry/);
    expect(() => parseInvite(encodeRaw({ ...base, n: 'Omer‮' }))).toThrow(/name/);
    expect(() => parseInvite(encodeRaw({ ...base, n: ' Omer' }))).toThrow(/name/);
    expect(() => parseInvite(encodeRaw({ ...base, n: 'x'.repeat(65) }))).toThrow(/name/);
    // The same fields, not in canonical form (whitespace, key order): one link per invite.
    expect(() => parseInvite(encodeRaw(JSON.stringify(base, null, 1)))).toThrow(/canonical/);
    expect(() => parseInvite(encodeRaw(JSON.stringify({ v: 1, a: base.a, r: base.r, s: base.s, e: base.e })))).toThrow(/canonical/);
    expect(() => parseInvite(encodeRaw('[1]'))).toThrow(/not an invite/);
    expect(() => parseInvite(`${p.slice(0, 10)}%${p.slice(11)}`)).toThrow(/not an invite/);
  });

  it('says when it expired, and making one checks its fields', () => {
    expect(inviteExpired({ expires: new Date(Date.now() - 1000).toISOString() })).toBe(true);
    expect(inviteExpired({ expires: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
    expect(inviteExpired({ expires: 'soon' })).toBe(true);
    // An expired link still parses, so the invitee can be told why it no longer works.
    expect(parseInvite(inviteUrl(inv({ expires: new Date(Date.now() - DAY).toISOString() }))).agentId).toMatch(/^rdv1:/);
    expect(() => inviteUrl(inv({ relays: [] }))).toThrow(/relays/);
    expect(() => inviteUrl(inv({ secret: 'x' }))).toThrow(/secret/);
    expect(() => inviteUrl(inv({ name: '' }))).toThrow(/name/);
    // More than three relays: the first three go in.
    expect(parseInvite(inviteUrl(inv({ relays: ['wss://a.example', 'wss://b.example', 'wss://c.example', 'wss://d.example'] }))).relays).toEqual(['wss://a.example', 'wss://b.example', 'wss://c.example']);
  });

  it('secrets are 128 random bits; the stored hash is compared in constant time', () => {
    const a = newInviteSecret();
    expect(isInviteSecret(a)).toBe(true);
    expect(a).not.toBe(newInviteSecret());
    expect(inviteSecretHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(inviteSecretHash(a), inviteSecretHash(a))).toBe(true);
    expect(sameHash(inviteSecretHash(a), inviteSecretHash(newInviteSecret()))).toBe(false);
    expect(sameHash('ab', 'abc')).toBe(false);
    expect(() => inviteSecretHash('nope')).toThrow();
  });

  it('the share text says what it is, that it works once, and ends with the link', () => {
    const url = inviteUrl(inv());
    const t = inviteShareText(url, { name: 'Omer', expires: '2026-11-07T10:00:00.000Z' });
    expect(t).toContain('Omer invites you');
    expect(t).toContain('works once, until 2026-11-07');
    expect(t).toContain(`accept my Rendezvous invite ${url}`);
    expect(t.endsWith(url)).toBe(true);
  });
});

describe('a contact request carrying an invite', () => {
  it('signs the secret with the request; a malformed one makes the request invalid', () => {
    const k = generateKey();
    const card = createCard(k, { rendezvous: [{ type: 'nostr', relay: 'wss://relay.example.com', pref: 1 }] });
    const secret = newInviteSecret();
    const r = createContactRequest(k, card, { toHint: generateKey().id, greeting: 'hi', invite: secret });
    expect(r.invite).toBe(secret);
    expect(verifyContactRequest(r)).toBe(true);
    expect(verifyContactRequest({ ...r, invite: newInviteSecret() })).toBe(false); // signed
    expect(verifyContactRequest(createContactRequest(k, card, { toHint: 'x', greeting: 'hi' }))).toBe(true); // optional
    expect(() => createContactRequest(k, card, { toHint: 'x', greeting: 'hi', invite: 'bad' })).toThrow(/invite secret/);
    // A request whose invite field is not a secret is invalid, even signed.
    const { sig: _sig, ...body } = r;
    const bad = { ...body, invite: 'x'.repeat(22) };
    expect(verifyContactRequest(bad)).toBe(false);
  });
});

describe('the inviter\'s book', () => {
  const card = () => createCard(generateKey(), { rendezvous: [{ type: 'nostr', relay: 'wss://relay.example.com', pref: 1 }] });
  const request = (secret?: string) => {
    const k = generateKey();
    return createContactRequest(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: 'wss://relay.example.com', pref: 1 }] }), {
      toHint: 'me',
      greeting: 'hi',
      ...(secret ? { invite: secret } : {}),
    });
  };
  const arrival = { via: 'envelope' as const, me: 'me' };
  void card;

  it('grants once, on the terms chosen, only by envelope; everything else is an ordinary request', () => {
    const book = new ContactBook();
    const { record, secret } = book.addInvite({ tier: 'colleague', scope: { may_initiate: true }, expires: new Date(Date.now() + DAY).toISOString(), label: 'Dana' });
    expect(record.hash).toBe(inviteSecretHash(secret));
    expect(JSON.stringify(book.toJSON())).not.toContain(secret); // only the hash is kept

    // Wrong secret: pending, exactly like a request without one.
    expect(book.receiveRequest(request(newInviteSecret()), 'claimed', new Date(), arrival).status).toBe('pending');
    // The right secret on a public topic: it was posted in the clear, so it counts for nothing.
    expect(book.receiveRequest(request(secret), 'claimed', new Date(), { via: 'topic', me: 'me' }).status).toBe('pending');
    expect(book.listInvites()[0].status).toBe('open');

    const r = request(secret);
    const out = book.receiveRequest(r, 'claimed', new Date(), arrival);
    expect(out).toMatchObject({ status: 'auto-grant', tier: 'colleague', label: 'Dana' });
    expect(book.listInvites()[0]).toMatchObject({ status: 'used', used: { by: r.from, request: r.id } });
    expect(book.listInvites()[0]).not.toHaveProperty('hash');
    // Used up: a second redeemer waits for the human.
    expect(book.receiveRequest(request(secret), 'claimed', new Date(), arrival).status).toBe('pending');
  });

  it('expired and revoked invites grant nothing; revoke only narrows', () => {
    const book = new ContactBook();
    const now = Date.now();
    const old = book.addInvite({ tier: 'friend', scope: {}, expires: new Date(now - DAY).toISOString() }, new Date(now - 2 * DAY));
    expect(book.receiveRequest(request(old.secret), 'claimed', new Date(), arrival).status).toBe('pending');
    expect(book.listInvites()[0].status).toBe('expired');

    const live = book.addInvite({ tier: 'friend', scope: {}, expires: new Date(now + DAY).toISOString() });
    expect(book.revokeInvite(live.record.id)?.status).toBe('revoked');
    expect(book.receiveRequest(request(live.secret), 'claimed', new Date(), arrival).status).toBe('pending');
    expect(book.revokeInvite('nope')).toBeUndefined();
  });

  it('refuses close tiers, long or past expiries, and too many open invites; prunes old ones', () => {
    const book = new ContactBook();
    const soon = new Date(Date.now() + DAY).toISOString();
    expect(INVITE_TIERS).toEqual(['friend', 'colleague', 'business', 'stranger']);
    expect(() => book.addInvite({ tier: 'family', scope: {}, expires: soon })).toThrow(/tiers friend/);
    expect(() => book.addInvite({ tier: 'spouse', scope: {}, expires: soon })).toThrow(/tiers friend/);
    expect(() => book.addInvite({ tier: 'friend', scope: {}, expires: new Date(Date.now() + 31 * DAY).toISOString() })).toThrow(/30 days/);
    expect(() => book.addInvite({ tier: 'friend', scope: {}, expires: new Date(Date.now() - 1).toISOString() })).toThrow(/future/);
    expect(() => book.addInvite({ tier: 'friend', scope: {}, expires: soon, name: '\u0007' })).toThrow(/name/);
    for (let i = 0; i < 32; i++) book.addInvite({ tier: 'friend', scope: {}, expires: soon });
    expect(() => book.addInvite({ tier: 'friend', scope: {}, expires: soon })).toThrow(/32 open invites/);
    book.revokeInvite(book.listInvites()[0].id);
    expect(book.addInvite({ tier: 'friend', scope: {}, expires: soon }).record.id).toMatch(/^[0-9a-f]{16}$/);
    // Ended more than 30 days ago: gone from the list.
    const later = new Date(Date.now() + 40 * DAY);
    expect(book.listInvites(later).length).toBe(0);
  });
});

describe('invite links over a relay', () => {
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

  const make = (email?: string) => {
    const a = Agent.create(
      (key: AgentKey) => new NostrTransport({ key, relays: [relay.url] }),
      { rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }], ...(email ? { discovery: { addresses: [{ type: 'email', value: email }], public_pointer: false } } : {}) },
    );
    a.on('error', (e) => {
      throw e;
    });
    a.start();
    agents.push(a);
    return a;
  };
  // The test relay is ws://127.0.0.1: allowed here only through the test hook (review of PR #120).
  const pi = (u: string) => parseInvite(u, { unsafeAllowRelays: [relay.url] });
  const accept = (a: Agent, link: ReturnType<typeof parseInvite>, greeting: string, now = new Date()) => a.acceptInvite(link, greeting, now, { unsafeAllowRelays: [relay.url] });
  const once = <T>(agent: Agent, event: 'request' | 'contact' | 'invite-redeemed' | 'invite-exposed'): Promise<T> =>
    new Promise((resolve) => agent.once(event, (x: unknown) => resolve(x as T)));

  it('the invitee, with no card published anywhere, becomes a contact on the inviter\'s terms; the inviter is told', async () => {
    const omer = make('omer@example.com');
    const made = omer.createInvite({ tier: 'colleague', name: 'Omer', label: 'Dana' });
    expect(made.link).toMatchObject({ agentId: omer.id, relays: [relay.url], name: 'Omer' });
    expect(Date.parse(made.invite.expires) - Date.now()).toBeGreaterThan(7 * DAY - 60_000);

    const dana = make(); // no address at all: a fresh agent that only has the link
    const redeemed = once<InviteRedeemed>(omer, 'invite-redeemed');
    const contact = once<{ peer: string }>(dana, 'contact');
    await accept(dana, pi(made.url), 'Dana here');
    const r = await redeemed;
    expect(r.invite).toMatchObject({ id: made.invite.id, status: 'used', label: 'Dana' });
    expect(r.contact).toMatchObject({ peer: dana.id, tier: 'colleague', label: 'Dana', binding: 'claimed', inboundGranted: true });
    expect((await contact).peer).toBe(omer.id);
    // Dana's side: what Omer may do towards her stays her local default until her own human grants more.
    expect(dana.book.contact(omer.id)).toMatchObject({ tier: 'stranger', inboundGranted: false });
    expect(dana.book.contact(omer.id)?.label).toBeUndefined(); // the name in the link is Omer's claim, not Dana's word

    // Accepting again: already a contact.
    await expect(accept(dana, pi(made.url), 'again')).rejects.toThrow(/already a contact/);
    // Someone else with the same link: used up, so it waits for Omer's human.
    const eve = make();
    const pending = once<PendingRequest>(omer, 'request');
    await accept(eve, pi(made.url), 'me too');
    expect((await pending).request.from).toBe(eve.id);
    expect(omer.book.contact(eve.id)).toBeUndefined();
  });

  it('expired, revoked and wrong secrets end up pending; own and expired links are refused on the invitee side', async () => {
    const omer = make('omer@example.com');
    const past = new Date(Date.now() - 8 * DAY);
    const stale = omer.createInvite({ tier: 'friend' }, past); // 7 days from 8 days ago
    const revoked = omer.createInvite({ tier: 'friend' });
    omer.book.revokeInvite(revoked.invite.id);
    const real = omer.createInvite({ tier: 'friend' });
    const wrong = { ...pi(real.url), secret: newInviteSecret() };

    await expect(accept(omer, pi(real.url), 'me')).rejects.toThrow(/your own/);
    const dana = make();
    await expect(accept(dana, pi(stale.url), 'x')).rejects.toThrow(/expired/);

    for (const [link, now] of [
      [pi(stale.url), past],
      [pi(revoked.url), new Date()],
      [wrong, new Date()],
    ] as const) {
      const who = make();
      const got = once<PendingRequest>(omer, 'request');
      await accept(who, link, 'hello', now);
      expect((await got).request.from).toBe(who.id);
    }
    expect(omer.contacts()).toEqual([]);
    expect(omer.book.listInvites().find((v) => v.id === real.invite.id)?.status).toBe('open');
  });

  it('the invite survives a restart (toJSON / fromJSON) and is still single use', async () => {
    const first = make('omer@example.com');
    const made = first.createInvite({ tier: 'business' });
    const saved = first.toJSON();
    first.close();
    agents = agents.filter((a) => a !== first);
    const omer = Agent.fromJSON(saved, (key) => new NostrTransport({ key, relays: [relay.url] }));
    omer.on('error', (e) => {
      throw e;
    });
    omer.start();
    agents.push(omer);
    const dana = make();
    const redeemed = once<InviteRedeemed>(omer, 'invite-redeemed');
    await accept(dana, pi(made.url), 'hi');
    expect((await redeemed).contact.tier).toBe('business');
  });

  it('L2: a secret posted on a public topic revokes its invite and tells the owner; it never grants', async () => {
    const omer = make('omer@example.com');
    const made = omer.createInvite({ tier: 'friend', label: 'Dana' });
    const dana = make();
    // Dana's agent (or anyone who copied the secret) posts a probe with it on Omer's address topic, in the clear.
    const req = createContactRequest(dana.key, dana.card, { toHint: 'omer@example.com', greeting: 'hi', invite: pi(made.url).secret });
    const exposed = once<{ invite: { id: string; status: string; revokedBy?: string }; from: string }>(omer, 'invite-exposed');
    const pending = once<PendingRequest>(omer, 'request');
    await dana.transport.publishTopic(dtopic({ type: 'email', value: 'omer@example.com' }), req);
    const x = await exposed;
    expect(x).toMatchObject({ from: dana.id, invite: { id: made.invite.id, status: 'revoked', revokedBy: 'exposed', label: 'Dana' } });
    expect((await pending).request.id).toBe(req.id);
    expect(omer.contacts()).toEqual([]);
    // The link no longer works by envelope either.
    const eve = make();
    const waits = once<PendingRequest>(omer, 'request');
    await accept(eve, pi(made.url), 'me');
    expect((await waits).request.from).toBe(eve.id);
    expect(omer.book.listInvites()[0]).toMatchObject({ status: 'revoked', revokedBy: 'exposed' });
  });

  it('L4: acceptInvite refuses a link whose relays are not public wss:// hosts, without the test hook', async () => {
    const omer = make('omer@example.com');
    const link = pi(omer.createInvite({ tier: 'friend' }).url);
    const dana = make();
    await expect(dana.acceptInvite(link, 'hi')).rejects.toThrow(/not a usable invite link.*wss:\/\//);
    expect(() => parseInvite(omer.createInvite({ tier: 'friend' }).url)).toThrow(/not a usable invite link/);
    expect(dana.book.state.outstanding).toEqual({}); // nothing was sent or tracked
  });
});

describe('invite relays (L4, review of PR #120)', () => {
  it('only wss:// to a public host name or address', () => {
    expect(inviteRelayProblem('wss://relay.example.com')).toBeNull();
    expect(inviteRelayProblem('wss://relay.example.com:7447/path')).toBeNull();
    expect(inviteRelayProblem('wss://8.8.8.8')).toBeNull();
    for (const bad of [
      'ws://relay.example.com',
      'https://relay.example.com',
      'wss://localhost',
      'wss://localhost:7777',
      'wss://relay.localhost',
      'wss://nas.local',
      'wss://db.internal',
      'wss://router.lan',
      'wss://intranet',
      'wss://127.0.0.1',
      'wss://10.0.0.5',
      'wss://172.16.1.1',
      'wss://192.168.1.10',
      'wss://100.64.0.1',
      'wss://100.114.126.43',
      'wss://169.254.169.254',
      'wss://0.0.0.0',
      'wss://[::1]',
      'wss://[fd00::1]',
      'wss://[fe80::1]',
      'wss://[::ffff:127.0.0.1]',
      'wss://0x7f.1',
      'wss://2130706433',
      'wss://user:pw@relay.example.com',
    ]) {
      expect(inviteRelayProblem(bad), bad).not.toBeNull();
    }
    expect(inviteRelayProblem('ws://127.0.0.1:4000', ['ws://127.0.0.1:4000'])).toBeNull();
    expect(() => checkInviteRelays({ relays: ['wss://relay.example.com', 'wss://10.1.2.3'] })).toThrow(/10\.1\.2\.3/);
  });

  it('parseInvite refuses a link that names one, and takes it with the test hook', () => {
    const url = inviteUrl(inv({ relays: ['ws://127.0.0.1:4000'] }));
    expect(() => parseInvite(url)).toThrow(/not a usable invite link/);
    expect(parseInvite(url, { unsafeAllowRelays: ['ws://127.0.0.1:4000'] }).relays).toEqual(['ws://127.0.0.1:4000']);
    expect(() => parseInvite(inviteUrl(inv({ relays: ['wss://relay.example.com', 'wss://192.168.0.2'] })))).toThrow(/192\.168\.0\.2/);
  });
});

describe('restore (L1, review of PR #120)', () => {
  it('revokes every invite still open in the backup and lists them; used and revoked ones stay as they were', () => {
    const a = Agent.create(() => ({ async sendEnvelope() {}, onEnvelopes: () => () => {}, async publishTopic() {}, onTopics: () => () => {}, fetchTopic: async () => [], close() {} }), {
      rendezvous: [{ type: 'nostr', relay: 'wss://relay.example.com', pref: 1 }],
    });
    const open = a.createInvite({ tier: 'friend', label: 'Dana' });
    const gone = a.createInvite({ tier: 'friend' });
    a.book.revokeInvite(gone.invite.id);
    const used = a.createInvite({ tier: 'friend' });
    a.book.state.invites![used.invite.id].used = { at: new Date().toISOString(), by: generateKey().id, request: crypto.randomUUID() };
    const now = new Date(Date.now() + 60_000);
    const restored = restoredAgentState(a.toJSON(), { backupCreated: new Date().toISOString(), now });
    expect(restoreRevokedInvites(restored)).toEqual([{ id: open.invite.id, label: 'Dana' }]);
    const back = new ContactBook(restored.book);
    const byId = Object.fromEntries(back.listInvites(now).map((v) => [v.id, v]));
    expect(byId[open.invite.id]).toMatchObject({ status: 'revoked', revokedBy: 'restore' });
    expect(byId[gone.invite.id]).toMatchObject({ status: 'revoked', revokedBy: 'owner' });
    expect(byId[used.invite.id].status).toBe('used');
    // The restored agent never redeems the old secret.
    const k = generateKey();
    const req = createContactRequest(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: 'wss://relay.example.com', pref: 1 }] }), {
      toHint: a.id,
      greeting: 'hi',
      invite: parseInvite(open.url).secret,
    });
    expect(back.receiveRequest(req, 'claimed', now, { via: 'envelope', me: a.id }).status).toBe('pending');
    a.close();
  });
});
