// Invite links (SPEC §5.2.3, NOTES 101): the payload, the inviter's book, and
// the whole flow on the in-memory relay.
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentKey,
  canonicalize,
  checkInviteRelays,
  guardedLookup,
  ContactBook,
  dtopic,
  inviteRelayProblem,
  restoredAgentState,
  restoreRevokedInvites,
  createCard,
  createContactRequest,
  DEFAULT_RELAYS,
  encodeInviteV1,
  type Invite,
  INVITE_KNOWN_RELAYS,
  keyFromSecret,
  generateKey,
  type InviteRedeemed,
  INVITE_TIERS,
  inviteExpired,
  inviteSecretHash,
  inviteShareText,
  inviteUrl,
  isInviteSecret,
  newInviteSecret,
  openEnvelope,
  NostrTransport,
  parseInvite,
  type PendingRequest,
  sameHash,
  utf8ToBytes,
  verifyContactRequest,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const DAY = 86_400_000;
// v2 carries the expiry in whole minutes.
const inv = (over: Partial<Parameters<typeof inviteUrl>[0]> = {}) => ({
  agentId: generateKey().id,
  relays: ['wss://relay.example.com'],
  secret: newInviteSecret(),
  expires: new Date(Math.floor((Date.now() + 7 * DAY) / 60_000) * 60_000).toISOString(),
  name: 'Omer',
  ...over,
});
const payloadOf = (url: string) => url.slice(url.indexOf('#') + 1);
const encodeRaw = (o: unknown) => base64urlnopad.encode(utf8ToBytes(typeof o === 'string' ? o : canonicalize(o)));
const CUT = /looks cut off or changed.*ask the person who sent it for the full link, exactly as it was sent/;
const VECTORS = JSON.parse(readFileSync(new URL('../vectors/invite-v2.json', import.meta.url), 'utf8')) as { valid: Array<{ name: string; url: string; invite: Invite }> };
/** A v2 payload's bytes with a fresh check (to test the fields behind it). */
const recheck = (body: Uint8Array) => {
  const tag = utf8ToBytes('rdv1/invite-link\u0000');
  const all = new Uint8Array(tag.length + body.length);
  all.set(tag);
  all.set(body, tag.length);
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  out.set(sha256(all).slice(0, 2), body.length);
  return base64urlnopad.encode(out);
};
const bodyOf = (url: string) => base64urlnopad.decode(payloadOf(url)).slice(0, -2);

describe('invite payload', () => {
  it('v2 round-trips through the link, the payload alone and rdv-invite:', () => {
    const i = inv();
    const url = inviteUrl(i);
    expect(url.startsWith('https://rendezvous.nesher.co/i#A')).toBe(true);
    const back = parseInvite(url);
    expect(back).toEqual(i);
    expect(parseInvite(payloadOf(url))).toEqual(back);
    expect(parseInvite(`rdv-invite:${payloadOf(url)}`)).toEqual(back);
    // Pasted in a sentence: surrounding space, the words after it and trailing punctuation are not part of it.
    expect(parseInvite(`  ${url}.\n`)).toEqual(back);
    expect(parseInvite(`${url}")`)).toEqual(back);
    expect(parseInvite(`${url} please`)).toEqual(back);
    // Any host: the payload is what counts (the inviter's agent checks the secret).
    expect(parseInvite(`https://example.org/x#${payloadOf(url)}`)).toEqual(back);
    const { name: _n, ...noName } = i;
    expect(parseInvite(inviteUrl(noName))).toEqual(noName);
    // The expiry is kept to the minute (floored).
    expect(parseInvite(inviteUrl({ ...noName, expires: '2026-11-08T12:00:59.999Z' })).expires).toBe('2026-11-08T12:00:00.000Z');
  });

  it('v2 is short: about 106 characters with known relays, under 160 with a custom one', () => {
    const base = { agentId: generateKey().id, secret: newInviteSecret(), expires: new Date(Date.now() + 30 * DAY).toISOString() };
    // An agent on the default relays (the CLI's and rdv-mcp's), three of them in the link.
    expect(inviteUrl({ ...base, relays: [...DEFAULT_RELAYS] }).length).toBeLessThanOrEqual(110);
    expect(inviteUrl({ ...base, relays: ['wss://relay.nesher.co'] }).length).toBeLessThanOrEqual(110);
    expect(inviteUrl({ ...base, relays: ['wss://relay.nesher.co', 'wss://relay.example.com'] }).length).toBeLessThanOrEqual(160);
    expect(inviteUrl({ ...base, relays: ['wss://relay.nesher.co', 'wss://nos.lol', 'wss://relay.example.com'] }).length).toBeLessThanOrEqual(160);
    // Known relays read back in table order, then the others in the order given.
    expect(parseInvite(inviteUrl({ ...base, relays: ['wss://relay.example.com', 'wss://nos.lol', 'wss://relay.nesher.co'] })).relays).toEqual(['wss://relay.nesher.co', 'wss://nos.lol', 'wss://relay.example.com']);
    expect(INVITE_KNOWN_RELAYS.length).toBeLessThanOrEqual(8);
    for (const r of INVITE_KNOWN_RELAYS) expect(inviteRelayProblem(r)).toBeNull();
  });

  it('matches the v2 vectors exactly, both ways', () => {
    expect(VECTORS.valid.length).toBeGreaterThan(0);
    for (const v of VECTORS.valid) {
      expect(parseInvite(v.url), v.name).toEqual(v.invite);
      expect(inviteUrl(v.invite), v.name).toBe(v.url);
    }
    expect(keyFromSecret(new Uint8Array(32).fill(7)).id).toBe(VECTORS.valid[0].invite.agentId);
  });

  it('a link cut short, shortened with "…" or with a character changed says to ask for the full link', () => {
    const url = inviteUrl(inv({ name: undefined }));
    const p = payloadOf(url);
    // The 2026-11-01 failure: an assistant showed the link with "…" in the middle.
    expect(() => parseInvite(`${url.slice(0, 50)}…${url.slice(-20)}`)).toThrow(CUT);
    expect(() => parseInvite(`${url.slice(0, 50)}...${url.slice(-20)}`)).toThrow(CUT);
    expect(() => parseInvite(`${url.slice(0, 60)}…`)).toThrow(CUT);
    expect(() => parseInvite(`${url.slice(0, 60)}...`)).toThrow(CUT);
    for (let n = 1; n < p.length; n += 7) expect(() => parseInvite(url.slice(0, url.length - n)), `cut ${n}`).toThrow(CUT);
    // Wrapped by a chat client: the second half is not part of the first word.
    expect(() => parseInvite(`${url.slice(0, 70)}\n${url.slice(70)}`)).toThrow(CUT);
    // One character changed anywhere: the check bytes catch it (2 bytes: 1 in 65536 slips through, by design never forgery-proof).
    for (const at of [0, 5, 20, 40, 60, p.length - 3]) {
      const c = p[at] === 'A' ? 'B' : 'A';
      expect(() => parseInvite(`${p.slice(0, at)}${c}${p.slice(at + 1)}`), `at ${at}`).toThrow(/cut off or changed|not an invite|newer version|canonical/);
    }
    expect(() => parseInvite('https://rendezvous.nesher.co/i#')).toThrow(/missing\. Ask the person who sent it for the full link/);
    expect(() => parseInvite('')).toThrow(/not an invite/);
    expect(() => parseInvite('a'.repeat(2000))).toThrow(/not an invite/);
    expect(() => parseInvite(`${p.slice(0, 10)}%${p.slice(11)}`)).toThrow(/not an invite/);
  });

  it('v2 refuses trailing bytes, a non-canonical encoding, unknown fields and bad values', () => {
    const i = inv({ name: undefined, relays: ['wss://relay.nesher.co'] });
    const body = bodyOf(inviteUrl(i));
    const withByte = (b: Uint8Array, ...x: number[]) => Uint8Array.from([...b, ...x]);
    expect(parseInvite(recheck(body))).toEqual(i);
    // Bytes after the check, or extra bytes behind the header (with a valid check).
    expect(() => parseInvite(base64urlnopad.encode(withByte(base64urlnopad.decode(recheck(body)), 0)))).toThrow(/cut off or changed/);
    expect(() => parseInvite(recheck(withByte(body, 0)))).toThrow(/malformed/);
    expect(() => parseInvite(recheck(withByte(body, 9, 1, 0x41)))).toThrow(/unknown or misplaced/);
    // Stray low bits in the last character.
    const p = recheck(body);
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bumped = p.slice(0, -1) + last[last.indexOf(p[p.length - 1]) + 1];
    expect(() => parseInvite(bumped)).toThrow(/canonical|cut off/);
    // A relay bit this version does not know, no relays, too many, a known relay written out, a repeat, a bad URL.
    const masked = (m: number) => { const b = body.slice(); b[53] = m; return b; };
    expect(() => parseInvite(recheck(masked(0x80)))).toThrow(/relays/);
    expect(() => parseInvite(recheck(masked(0)))).toThrow(/relays/);
    expect(() => parseInvite(recheck(masked(0x0f)))).toThrow(/relays/);
    const rec = (type: number, s: string) => { const t = utf8ToBytes(s); return [type, t.length, ...t]; };
    expect(parseInvite(recheck(withByte(body, ...rec(1, 'wss://relay.example.com')))).relays).toEqual(['wss://relay.nesher.co', 'wss://relay.example.com']);
    expect(() => parseInvite(recheck(withByte(body, ...rec(1, 'wss://nos.lol'))))).toThrow(/relays/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(1, 'wss://a.example.com'), ...rec(1, 'wss://a.example.com'))))).toThrow(/relays/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(1, 'https://a.example.com'))))).toThrow(/relays/);
    expect(() => parseInvite(recheck(withByte(masked(0x07), ...rec(1, 'wss://a.example.com'))))).toThrow(/relays/);
    // A custom relay is still held to the public wss:// rules (and the DNS guard where it is dialled).
    expect(() => parseInvite(recheck(withByte(body, ...rec(1, 'wss://192.168.0.2'))))).toThrow(/not a usable invite link/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(1, 'ws://relay.example.com'))))).toThrow(/not a usable invite link/);
    // Names: canonical (trimmed, printable, at most 64), once, after the relays.
    expect(parseInvite(recheck(withByte(body, ...rec(2, 'Omer')))).name).toBe('Omer');
    expect(() => parseInvite(recheck(withByte(body, ...rec(2, ' Omer'))))).toThrow(/name/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(2, 'Omer‮'))))).toThrow(/name/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(2, 'x'.repeat(65)))))).toThrow(/name/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(2, 'A'), ...rec(2, 'B'))))).toThrow(/misplaced/);
    expect(() => parseInvite(recheck(withByte(body, ...rec(2, 'A'), ...rec(1, 'wss://a.example.com'))))).toThrow(/misplaced/);
    expect(() => parseInvite(recheck(withByte(body, 2, 2, 0xff, 0xfe)))).toThrow(/malformed/);
    expect(() => parseInvite(recheck(withByte(body, 2, 0)))).toThrow(/malformed/);
    expect(() => parseInvite(recheck(withByte(body, 2, 9, 0x41)))).toThrow(/malformed/);
    // Not a curve point; no expiry; a newer version.
    const keyed = body.slice(); keyed.set(new Uint8Array(32).fill(0xff), 1);
    expect(() => parseInvite(recheck(keyed))).toThrow(/agent ID/);
    const zero = body.slice(); zero.set([0, 0, 0, 0], 49);
    expect(() => parseInvite(recheck(zero))).toThrow(/expiry/);
    const v3 = body.slice(); v3[0] = 3;
    expect(() => parseInvite(recheck(v3))).toThrow(/newer version/);
    const junk = body.slice(); junk[0] = 0x99;
    expect(() => parseInvite(recheck(junk))).toThrow(/not an invite link/);
  });

  it('still reads v1 links (canonical JSON), strictly', () => {
    const i = { ...inv(), expires: new Date(Math.floor((Date.now() + 7 * DAY) / 1000) * 1000).toISOString() };
    const v1 = `https://rendezvous.nesher.co/i#${encodeInviteV1(i)}`;
    expect(v1.length).toBeGreaterThan(200);
    expect(parseInvite(v1)).toEqual(i);
    const p = payloadOf(v1);
    expect(() => parseInvite(p.slice(0, -6))).toThrow(/not an invite|cut off/);
    expect(() => parseInvite(`${v1.slice(0, 80)}…${v1.slice(-30)}`)).toThrow(CUT);
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

describe('invite relay names resolve only to public addresses (re-review of PR #120)', () => {
  let relay: TestRelay;
  let other: TestRelay;
  const agents: Agent[] = [];
  beforeEach(async () => {
    relay = await startTestRelay();
    other = await startTestRelay();
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) a.close();
    await relay.close();
    await other.close();
  });
  const port = (u: string) => new URL(u).port;
  /** A stub resolver: the name answers 127.0.0.1, like 127.0.0.1.nip.io or a rebinding domain. */
  const toLoopback = async () => [{ address: '127.0.0.1', family: 4 }];

  const mk = (url: string, email?: string) => {
      const a = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [url] }), {
        rendezvous: [{ type: 'nostr', relay: url, pref: 1 }],
        ...(email ? { discovery: { addresses: [{ type: 'email', value: email }], public_pointer: false } } : {}),
      });
      a.on('error', () => {});
      a.start();
      agents.push(a);
      return a;
    };

  it('a link\'s relay name that resolves to loopback never reaches the inviter; the same name, unguarded, would', async () => {
    const omer = mk(relay.url, 'omer@example.com');
    // The link names Omer's (listening) relay by a host name that resolves to 127.0.0.1; Dana listens elsewhere.
    const evil = `ws://loop.example:${port(relay.url)}`;
    const linkFor = () => ({ ...parseInvite(omer.createInvite({ tier: 'friend' }).url, { unsafeAllowRelays: [relay.url] }), relays: [evil] });
    const dana = mk(other.url);
    // Control: with a lookup that lets 127.0.0.1 through, the name reaches Omer's relay and the invite is redeemed.
    const redeemed = new Promise((r) => omer.once('invite-redeemed', r));
    await dana.acceptInvite(linkFor(), 'hi', new Date(), { unsafeAllowRelays: [evil], lookup: guardedLookup({ resolve: toLoopback, allowed: () => true }) });
    await redeemed;
    // The real guard (only the resolver stubbed): refused at connect, nothing reaches Omer.
    const eve = mk(other.url);
    let got = false;
    omer.on('request', () => (got = true));
    omer.on('invite-redeemed', () => (got = true));
    await expect(eve.acceptInvite(linkFor(), 'hi', new Date(), { unsafeAllowRelays: [evil], resolve: toLoopback })).rejects.toThrow(/private or reserved|no relay accepted/);
    await new Promise((r) => setTimeout(r, 1000));
    expect(got).toBe(false);
    expect(omer.contacts().map((c) => c.peer)).toEqual([dana.id]);
  });

  it('a crafted invite naming our own relay changes nothing about our connection or later ones', async () => {
    // Dana's own relay by name (the system resolves localhost; a guard would refuse its loopback answer).
    const own = `ws://localhost:${port(other.url)}`;
    const dana = mk(own);
    const omer = mk(relay.url, 'omer@example.com');
    const crafted = { agentId: generateKey().id, relays: [own], secret: newInviteSecret(), name: 'x' };
    // Expired: refused before anything happens.
    await expect(dana.acceptInvite({ ...crafted, expires: new Date(Date.now() - 1000).toISOString() }, 'hi', new Date(), { unsafeAllowRelays: [own], resolve: toLoopback })).rejects.toThrow(/expired/);
    // Valid: its own connection to our relay's name is refused (loopback), and that is all it does.
    await expect(dana.acceptInvite({ ...crafted, expires: new Date(Date.now() + 86_400_000).toISOString() }, 'hi', new Date(), { unsafeAllowRelays: [own], resolve: toLoopback })).rejects.toThrow();
    // A new connection to our relay (what a reconnect opens) still works ...
    const fresh = new NostrTransport({ key: generateKey(), relays: [own] });
    expect((await fresh.publishTopic('aaaaaaaaaaaaaaaaaaaaaaaaaa', { still: 'fine' }))?.accepted).toEqual([own]);
    fresh.close();
    // ... and Dana still receives on it: Omer's grant for a real invite comes back to her own relay.
    const contact = new Promise<{ peer: string }>((r) => dana.once('contact', r));
    await dana.acceptInvite(parseInvite(omer.createInvite({ tier: 'friend' }).url, { unsafeAllowRelays: [relay.url] }), 'hi', new Date(), { unsafeAllowRelays: [relay.url] });
    expect((await contact).peer).toBe(omer.id);
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

describe('every envelope to an invite\'s relays goes through the guarded per-call sender (review of PR #120)', () => {
  it('a restored agent accepting an invite sends its restore notice and the request only through sendEnvelopeIsolated', async () => {
    const plain: Array<{ relays?: string[] }> = [];
    const isolated: Array<{ env: unknown; relays: string[] }> = [];
    const fake = () => ({
      async sendEnvelope(_e: unknown, relays?: string[]) {
        plain.push({ relays });
      },
      async sendEnvelopeIsolated(env: unknown, relays: string[]) {
        isolated.push({ env, relays });
      },
      onEnvelopes: () => () => {},
      async publishTopic() {},
      onTopics: () => () => {},
      fetchTopic: async () => [],
      close() {},
    });
    const omer = generateKey();
    const relays = ['wss://relay.example.com'];
    const link = (): Parameters<Agent['acceptInvite']>[0] => ({ agentId: omer.id, relays, secret: newInviteSecret(), expires: new Date(Date.now() + 86_400_000).toISOString() });
    const first = Agent.create(fake as never, { rendezvous: [{ type: 'nostr', relay: 'wss://own.example.com', pref: 1 }] });
    // A first invite from Omer: Dana's agent now has a channel to him (it was never answered).
    await first.acceptInvite(link(), 'hi');
    first.close();
    // Dana restores from a backup: her channel to Omer owes him a restore notice first.
    const dana = Agent.fromJSON(restoredAgentState(first.toJSON(), { backupCreated: new Date().toISOString() }), fake as never);
    plain.length = 0;
    isolated.length = 0;
    await dana.acceptInvite(link(), 'hi again');
    expect(plain).toEqual([]); // nothing through the transport to anyone's relays
    const types = isolated.map((x) => {
      const o = openEnvelope(omer, x.env);
      return o.ok ? o.payload.type : 'unreadable';
    });
    expect(types).toEqual(['rdv/restored', 'rdv/contact-request']);
    expect(isolated.every((x) => x.relays === relays)).toBe(true);
    dana.close();
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
