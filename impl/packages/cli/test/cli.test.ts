import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv, until } from '../scenarios/harness.js';
import { acquireLock, LockTimeoutError, writeAtomic } from '../src/fsutil.js';
import { clean, contactText, inboxText, requestText } from '../src/output.js';
import { DEFAULT_INBOUND_SCOPE, type Contact, type PendingRequest } from '@rendezvous/core';
import { type Ctx, emptyState, type MeetingScope, parseWindow, propose, receive } from '@rendezvous/a2a';
import { inboundMeetingScope, meetingScope } from '../src/negotiate.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'rdv-test-'));

describe('lock and atomic writes', () => {
  it('breaking a stale lock never removes a lock someone just took (security review L1)', async () => {
    const { breakStale } = await import('../src/fsutil.js');
    const dir = tmp();
    const path = join(dir, 'lock');
    const stale = JSON.stringify({ pid: 999999, host: hostname(), since: '2020-01-01T00:00:00Z' });
    writeFileSync(path, stale);
    // Waiter A breaks the stale lock and takes its own.
    breakStale(path, stale);
    const release = await acquireLock(path, { timeoutMs: 150 });
    const fresh = readFileSync(path, 'utf8');
    // Waiter B read the same stale content earlier and now tries to break it: A's lock survives.
    breakStale(path, stale);
    expect(readFileSync(path, 'utf8')).toBe(fresh);
    // And while another waiter holds the breaker, nobody removes the lock.
    writeFileSync(path, stale);
    writeFileSync(`${path}.break`, '');
    breakStale(path, stale);
    expect(readFileSync(path, 'utf8')).toBe(stale);
    release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listener.lock: one holder, owner named, dead owner broken, age alone never breaks a live one (issue #9)', async () => {
    const { tryLongLock } = await import('../src/fsutil.js');
    const dir = tmp();
    const path = join(dir, 'listener.lock');
    const first = tryLongLock(path, 'rdv listen', { heartbeatMs: 20, staleMs: 100 });
    expect(first.release).toBeTypeOf('function');
    await new Promise((r) => setTimeout(r, 250)); // older than staleMs, but the heartbeat keeps it fresh
    const second = tryLongLock(path, 'rdv-mcp', { staleMs: 100 });
    expect(second.owner).toMatch(new RegExp(`^rdv listen, pid ${process.pid} on `));
    first.release!();
    const third = tryLongLock(path, 'rdv-mcp');
    expect(third.release).toBeTypeOf('function');
    third.release!();
    // A crashed owner on this host: its lock is broken.
    writeFileSync(path, JSON.stringify({ pid: 999999, host: hostname(), since: '2020-01-01T00:00:00Z', role: 'rdv listen' }));
    const taken = tryLongLock(path, 'rdv-mcp');
    expect(taken.release).toBeTypeOf('function');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, role: 'rdv-mcp' });
    taken.release!();
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes a second holder until released', async () => {
    const dir = tmp();
    const path = join(dir, 'lock');
    const release = await acquireLock(path);
    await expect(acquireLock(path, { timeoutMs: 150 })).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    const again = await acquireLock(path, { timeoutMs: 150 });
    again();
    rmSync(dir, { recursive: true, force: true });
  });

  it('breaks a lock left by a dead process on this host', async () => {
    const dir = tmp();
    const path = join(dir, 'lock');
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), since: new Date().toISOString() }));
    const release = await acquireLock(path, { timeoutMs: 500 });
    release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically without leaving temp files', () => {
    const dir = tmp();
    const path = join(dir, 'a.json');
    writeAtomic(path, '{"a":1}', 0o600);
    writeAtomic(path, '{"a":2}', 0o600);
    expect(readFileSync(path, 'utf8')).toBe('{"a":2}');
    expect(readdirSync(dir)).toEqual(['a.json']);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('rdv commands', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = tmp();
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('init writes state, refuses to clobber it, and never prints the secret key', async () => {
    const home = join(root, 'solo');
    const init = await rdv(['init', '--profile', 'solo', '--email', 'Omer@Example.com', '--relay', relay.url], home);
    expect(init.lines[0].event).toBe('init');
    const state = JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8'));
    if (process.platform !== 'win32') expect(statSync(join(home, 'agent.json')).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config.addresses).toEqual([{ type: 'email', value: 'omer@example.com' }]);

    const who = await rdv(['whoami'], home);
    expect(who.lines[0].id).toBe(init.lines[0].id);
    for (const out of [init.stdout, who.stdout]) expect(out).not.toContain(state.secretKey);

    const again = await rdv(['init', '--relay', relay.url], home, { check: false });
    expect(again.code).toBe(1);
    const usage = await rdv(['contact', 'grant'], home, { check: false });
    expect(usage.code).toBe(2);
  });

  it('several emails and phones: init dedupes, rdv address adds, removes, caps and canonicalizes', async () => {
    const home = join(root, 'multi');
    const state = () => JSON.parse(readFileSync(join(home, ['agent', 'json'].join('.')), 'utf8'));
    await rdv(
      ['init', '--email', 'omer@example.com', '--email', 'Omer@Work.Example.com', '--email', 'OMER@example.com', '--phone', '+1 555 555 0123', '--phone', '+15555550124', '--phone', '+1-555-555-0123', '--relay', relay.url],
      home,
    );
    const four = [
      { type: 'email', value: 'omer@example.com' },
      { type: 'email', value: 'omer@work.example.com' },
      { type: 'phone', value: '+15555550123' },
      { type: 'phone', value: '+15555550124' },
    ];
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).addresses).toEqual(four);
    expect(state().card.discovery.addresses).toEqual(four);
    const list = await rdv(['address', 'list'], home);
    expect(list.lines.map((l) => [l.value, l.public, typeof l.topic])).toEqual(four.map((a) => [a.value, true, 'string']));

    // Duplicates (in any spelling) and bad input are refused; nothing changes.
    const created = state().card.created;
    expect((await rdv(['address', 'add', 'OMER@WORK.example.com'], home, { check: false })).code).toBe(1);
    expect((await rdv(['address', 'add', '+1 (555) 555-0124'], home, { check: false })).code).toBe(1);
    expect((await rdv(['address', 'add', 'omer'], home, { check: false })).code).toBe(2);
    expect((await rdv(['address', 'add', '+12'], home, { check: false })).code).toBe(2);
    expect((await rdv(['address', 'add', 'x@example.com', '--public', '--private'], home, { check: false })).code).toBe(2);
    expect((await rdv(['address', 'remove', 'nobody@example.com'], home, { check: false })).code).toBe(1);
    expect(state().card.created).toBe(created);

    // Add: canonical, listed on a newer card; a private one is kept off the card.
    const add = await rdv(['address', 'add', 'Omer@Home.Example.com'], home);
    expect(add.lines[0]).toMatchObject({ event: 'address-added', address: { type: 'email', value: 'omer@home.example.com', public: true }, published: [] });
    expect(Date.parse(state().card.created)).toBeGreaterThan(Date.parse(created));
    expect(state().card.discovery.addresses.at(-1)).toEqual({ type: 'email', value: 'omer@home.example.com' });
    const priv = await rdv(['address', 'add', '+15555550125', '--private'], home);
    expect(priv.lines[0].address).toEqual({ type: 'phone', value: '+15555550125', public: false });
    expect(priv.lines[0].card_created).toBeUndefined();
    expect(state().card.discovery.addresses).toHaveLength(5);
    expect((await rdv(['whoami'], home)).lines[0].addresses.at(-1)).toEqual({ type: 'phone', value: '+15555550125', public: false });

    // The cap counts private addresses too.
    await rdv(['address', 'add', 'omer@a.example.com'], home);
    await rdv(['address', 'add', 'omer@b.example.com'], home);
    const full = await rdv(['address', 'add', 'omer@c.example.com'], home, { check: false });
    expect([full.code, full.stderr]).toEqual([1, expect.stringContaining('the most it may hold')]);

    // Remove: off the card and the config; the private one goes from the config only.
    const rm = await rdv(['address', 'remove', 'OMER@work.example.com'], home);
    expect(rm.lines[0]).toMatchObject({ event: 'address-removed', address: { value: 'omer@work.example.com', public: true } });
    expect(state().card.discovery.addresses.map((a: { value: string }) => a.value)).not.toContain('omer@work.example.com');
    const before = state().card;
    await rdv(['address', 'remove', '+15555550125'], home);
    expect(state().card).toEqual(before);
    const left = await rdv(['address', 'list'], home);
    expect(left.lines.map((l) => l.value)).toEqual(['omer@example.com', '+15555550123', '+15555550124', 'omer@home.example.com', 'omer@a.example.com', 'omer@b.example.com']);

    // More than the cap at init is a usage error.
    const many = Array.from({ length: 9 }, (_, i) => ['--email', `omer+${i}@example.com`]).flat();
    expect((await rdv(['init', ...many, '--relay', relay.url], join(root, 'many'), { check: false })).code).toBe(2);
  });

  it('auto-grant above stranger needs --auto-grant-any-tier (security review L7)', async () => {
    const home = join(root, 'cap');
    await rdv(['init', '--email', 'cap@example.com', '--relay', 'ws://127.0.0.1:9'], home);
    const r = await rdv(['listen', '--auto-grant', 'spouse'], home, { check: false });
    expect([r.code, r.stderr]).toEqual([2, expect.stringContaining('--auto-grant-any-tier')]);
  });

  it('public pointer, lookup, card-file request with --in-person, auto-grant, revoke', async () => {
    const omerHome = join(root, 'omer');
    const johnHome = join(root, 'john');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url, '--public-pointer'], johnHome);
    const pub = await rdv(['card', 'publish'], johnHome);
    expect(pub.lines[0].event).toBe('published');
    const found = await rdv(['lookup', 'john@doe.com'], omerHome);
    const card = found.lines[0].card;
    const cardFile = join(root, 'john-card.json');
    writeFileSync(cardFile, JSON.stringify(card));

    const johnL = new Listener('john', johnHome, ['--auto-grant', 'colleague', '--auto-grant-any-tier']);
    const omerL = new Listener('omer', omerHome);
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      const bad = await rdv(['contact', 'request', cardFile, '--label', ' '], omerHome, { check: false });
      expect(bad.code).toBe(2);
      const req = await rdv(['contact', 'request', cardFile, '--in-person', '--greeting', 'hi', '--label', 'john@doe.com'], omerHome);
      expect(req.lines[0]).toMatchObject({ via: 'card', binding: 'in-person', label: 'john@doe.com' });
      await johnL.waitFor((l) => l.event === 'contact', 'john contact (auto-grant)', 10_000);
      await omerL.waitFor((l) => l.event === 'contact' && l.peer === card.id, 'omer contact', 10_000);
      const contacts = await until(
        async () => {
          const r = await rdv(['contact', 'list'], omerHome);
          return r.lines.length ? r.lines : undefined;
        },
        'omer contact list',
        10_000,
      );
      // John's grant sets what Omer may do; John's rights towards Omer stay the local default.
      expect(contacts[0]).toMatchObject({ peer: card.id, granted_tier: 'colleague', tier: 'stranger', inbound: 'default', binding: 'in-person' });
      // The label Omer used, kept locally; the human can rename the contact.
      expect(contacts[0].label).toBe('john@doe.com');
      const renamed = await rdv(['contact', 'label', card.id, 'John Doe'], omerHome);
      expect(renamed.lines[0]).toMatchObject({ event: 'labeled', peer: card.id, label: 'John Doe' });
      expect((await rdv(['contact', 'label', 'rdv1:nobody', 'x'], omerHome, { check: false })).code).not.toBe(0);

      const rv = await rdv(['contact', 'revoke', card.id], omerHome);
      expect(rv.lines[0]).toMatchObject({ event: 'revoked', peer: card.id });
      await johnL.waitFor((l) => l.event === 'revoked', 'john sees revoke', 10_000);
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  });
});

describe('terminal safety (security regression)', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const CSI1 = String.fromCharCode(0x9b); // single-byte CSI
  const RLO = String.fromCharCode(0x202e);
  const evil = `${ESC}[2J${ESC}]0;pwned${BEL}${CSI1}31m${RLO}\nfake line`;
  const unsafe = [ESC, BEL, CSI1, RLO, '\n'];

  it('strips escape sequences from every peer-controlled field', () => {
    const p = {
      request: { id: evil, from: 'rdv1:x', to_hint: evil, greeting: evil },
      binding: 'claimed',
      received: evil,
    } as unknown as PendingRequest;
    const c = { peer: 'rdv1:x', tier: evil, binding: 'claimed', since: evil, expires: evil } as unknown as Contact;
    const texts = [
      requestText(p),
      contactText(c),
      inboxText({ ts: evil, from: 'rdv1:x', seq: 1, payload: { type: evil, text: evil } }),
    ];
    for (const t of texts) {
      // A view may use its own newlines between lines, never a peer's.
      for (const line of t.split('\n')) for (const ch of unsafe.slice(0, 4)) expect(line).not.toContain(ch);
      expect(t).not.toContain('\nfake line');
    }
    expect(clean(evil)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});


describe('inbound items that change nothing (security review M1)', () => {
  it('junk is filtered before the lock, and a replay does not rewrite agent.json', async () => {
    const { utimesSync } = await import('node:fs');
    const { createCard, createContactRequest, generateKey, keyFromSecret, b64decode, sealEnvelope, dtopic } = await import('@rendezvous/core');
    const { FeedTransport, handleInbound, isJunk } = await import('../src/listen.js');
    const { Home } = await import('../src/home.js');
    const { initHome } = await import('../src/commands.js');
    const dir = tmp();
    try {
      const home = new Home(join(dir, 'h'));
      await initHome(home, { profile: 'bob', relays: ['ws://127.0.0.1:9'], emails: ['bob@x.com'] });
      const me = keyFromSecret(b64decode(home.readAgentState().secretKey));
      const k = generateKey();
      const req = createContactRequest(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: 'ws://127.0.0.1:9', pref: 1 }] }), {
        toHint: 'bob@x.com',
        greeting: 'hi',
      });
      // Stateless junk: wrong recipient, garbage, our own request.
      expect(isJunk(me, { envelope: sealEnvelope(k, k.id, { type: 'note' }, { seq: 1, prev: null }) })).toBe(true);
      expect(isJunk(me, { doc: { junk: true } })).toBe(true);
      expect(isJunk(me, { doc: req })).toBe(false);

      const real = { sendEnvelope: async () => {}, publishTopic: async () => {}, fetchTopic: async () => [], onEnvelopes: () => () => {}, onTopics: () => () => {}, close() {} };
      const topic = dtopic({ type: 'email', value: 'bob@x.com' });
      const feed = (t: InstanceType<typeof FeedTransport>) => t.feedTopic(req, topic);
      await handleInbound(home, real, feed, {});
      expect(Object.keys(home.readAgentState().book.pending)).toEqual([req.id]);
      const old = new Date('2020-01-01T00:00:00Z');
      utimesSync(home.agentPath, old, old);
      const again = await handleInbound(home, real, feed, {}); // relay replay
      expect(again.map((e) => e.obj.event)).toEqual(['dropped']);
      expect(statSync(home.agentPath).mtimeMs).toBe(old.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent.json durability (security review M3)', () => {
  it('keeps the last good state as agent.json.bak and falls back to it when agent.json is torn', async () => {
    const dir = tmp();
    try {
      const home = join(dir, 'h');
      const first = await rdv(['init', '--email', 'bob@x.com', '--relay', 'ws://127.0.0.1:9'], home);
      const id = first.lines[0].id;
      const { Home } = await import('../src/home.js');
      const h = new Home(home);
      h.writeAgentState(h.readAgentState()); // a second save: the backup now holds the first state
      const bak = JSON.parse(readFileSync(join(home, 'agent.json.bak'), 'utf8'));
      expect(bak.card.id).toBe(id);
      writeFileSync(join(home, 'agent.json'), ''); // power cut after the rename
      const who = await rdv(['whoami'], home);
      expect(who.lines[0].id).toBe(id);
      expect(who.stderr).toContain('agent.json.bak');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('floods are shown to the human', () => {
  it('rdv contact pending reports dropped probe answers and dropped requests', async () => {
    const dir = tmp();
    try {
      const home = join(dir, 'h');
      await rdv(['init', '--email', 'bob@x.com', '--relay', 'ws://127.0.0.1:9'], home);
      const path = join(home, 'agent.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      const ref = '00000000-0000-4000-8000-0000000000aa';
      state.book.outstanding[ref] = { to_hint: 'alice@x.com', sent: new Date().toISOString(), binding: 'claimed', dropped: 7 };
      state.book.pendingEvicted = 12;
      writeFileSync(path, JSON.stringify(state));
      const r = await rdv(['contact', 'pending'], home);
      expect(r.lines).toContainEqual({ event: 'probe-overflow', request_ref: ref, to_hint: 'alice@x.com', dropped: 7 });
      expect(r.lines).toContainEqual({ event: 'pending-evicted', total: 12 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a contact that rolled back its chain (issue #13)', () => {
  it('listen reports it with the resync hint, refuses it, and rdv contact resync takes it back', async () => {
    const { Channels, createCard, generateKey, sealEnvelope } = await import('@rendezvous/core');
    const { handleInbound } = await import('../src/listen.js');
    const { Home } = await import('../src/home.js');
    const { initHome } = await import('../src/commands.js');
    const dir = tmp();
    try {
      const home = new Home(join(dir, 'h'));
      await initHome(home, { profile: 'john', relays: ['ws://127.0.0.1:9'], emails: ['john@doe.com'] });
      const omer = generateKey();
      const state = home.readAgentState();
      const johnId = state.card.id;
      state.book.contacts[omer.id] = {
        peer: omer.id,
        card: createCard(omer, { rendezvous: [{ type: 'nostr', relay: 'ws://127.0.0.1:9', pref: 1 }] }),
        tier: 'friend',
        inboundScope: { may_initiate: true },
        outboundScope: { may_initiate: true },
        binding: 'claimed',
        grantId: 'g',
        expires: null,
        since: new Date().toISOString(),
      };
      home.writeAgentState(state);
      const real = { sendEnvelope: async () => {}, publishTopic: async () => {}, fetchTopic: async () => [], onEnvelopes: () => () => {}, onTopics: () => () => {}, close() {} };
      const omerCh = new Channels();
      const base = Date.now() - 60_000;
      const send = (ch: InstanceType<typeof Channels>, text: string, at: number) => {
        const { seq, prev } = ch.nextOutbound(johnId);
        const e = sealEnvelope(omer, johnId, { type: 'note', text }, { seq, prev, now: new Date(at) });
        ch.commitOutbound(johnId, e);
        return e;
      };
      const inbound = (e: unknown) => handleInbound(home, real, (t) => t.feedEnvelope(e), {});
      await inbound(send(omerCh, 'one', base));
      const backup = JSON.stringify(omerCh.state);
      await inbound(send(omerCh, 'two', base + 1000));
      const restored = new Channels(JSON.parse(backup)); // Omer restored an old agent.json
      const forked = send(restored, 'two again', base + 30_000);
      const events = await inbound(forked);
      expect(events.map((e) => e.obj)).toEqual([{ event: 'dropped', reason: 'envelope chain fork (rollback)', detail: { peer: omer.id, seq: 2, accepted: 2 } }]);
      expect(events[0].human).toContain(`rdv contact resync ${omer.id}`);
      expect((await inbound(send(restored, 'three', base + 31_000))).map((e) => e.obj.event)).toEqual(['dropped']);

      const notRefused = await rdv(['contact', 'resync', generateKey().id], home.dir, { check: false });
      expect(notRefused.code).not.toBe(0);
      const r = await rdv(['contact', 'resync', omer.id], home.dir);
      expect(r.lines[0]).toEqual({ event: 'resync', peer: omer.id, kind: 'rollback', seq: 2, accepted: 2 });
      const back = await inbound(send(restored, 'four', base + 32_000));
      expect(back.map((e) => [e.obj.event, (e.obj.payload as { text?: string } | undefined)?.text])).toEqual([['message', 'four']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a busy lock does not lose inbound items (security review L8)', () => {
  it('handleInbound waits out a held lock instead of dropping the item', async () => {
    const { createCard, createContactRequest, generateKey, dtopic } = await import('@rendezvous/core');
    const { handleInbound } = await import('../src/listen.js');
    const { Home } = await import('../src/home.js');
    const { initHome } = await import('../src/commands.js');
    const dir = tmp();
    try {
      const home = new Home(join(dir, 'h'));
      await initHome(home, { profile: 'bob', relays: ['ws://127.0.0.1:9'], emails: ['bob@x.com'] });
      const k = generateKey();
      const req = createContactRequest(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: 'ws://127.0.0.1:9', pref: 1 }] }), {
        toHint: 'bob@x.com',
        greeting: 'hi',
      });
      const real = { sendEnvelope: async () => {}, publishTopic: async () => {}, fetchTopic: async () => [], onEnvelopes: () => () => {}, onTopics: () => () => {}, close() {} };
      const feed = (t: InstanceType<typeof import('../src/listen.js').FeedTransport>) => t.feedTopic(req, dtopic({ type: 'email', value: 'bob@x.com' }));
      const release = await acquireLock(home.lockPath); // another command is busy
      // One short attempt times out (the caller sees it)...
      await expect(handleInbound(home, real, feed, {}, false, { timeoutMs: 150, attempts: 1 })).rejects.toBeInstanceOf(LockTimeoutError);
      // ...more attempts outlast the holder, and the item is handled.
      setTimeout(release, 400);
      const events = await handleInbound(home, real, feed, {}, false, { timeoutMs: 150, attempts: 10 });
      expect(events.map((e) => e.obj.event)).toEqual(['request']);
      expect(Object.keys(home.readAgentState().book.pending)).toEqual([req.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000); // the old code waited a fixed 60 s, then dropped the item
});

describe('negotiation scope by direction (security review H2)', () => {
  const NOW = new Date('2026-10-25T10:00:00Z');
  const window = parseWindow('next week evenings', { now: NOW, offsetMinutes: 120 });
  const ctx = (scope: MeetingScope): Ctx => ({
    now: NOW,
    busy: [],
    busyRange: { start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
    window,
    offsetMinutes: 120,
    scope,
    autoConfirm: true,
  });
  const loud = { may_initiate: true, may_propose_meetings: true, may_access_calendar: 'full' } as const;
  // We requested Mallory; her grant gave us `loud`, our human gave her nothing yet.
  const contact = {
    peer: 'rdv1:mallory',
    inboundScope: { ...DEFAULT_INBOUND_SCOPE },
    inboundGranted: false,
    outboundScope: loud,
  } as unknown as Contact;

  it('a peer whose grant we hold cannot start a negotiation with us', () => {
    const theirs = propose(emptyState(), 'rdv1:us', ctx(loud));
    const payload = theirs.outgoing[0].payload;
    const state = emptyState();
    const step = receive(state, 'rdv1:mallory', payload, ctx(inboundMeetingScope(contact, state, payload)));
    expect(step.events[0]).toMatchObject({ kind: 'invalid' });
    expect(step.outgoing).toEqual([]);
    expect(step.effects).toEqual([]);
  });

  it('replies on a negotiation we proposed ride our outbound grant', () => {
    const ours = propose(emptyState(), 'rdv1:mallory', ctx(meetingScope(contact, 'outbound')));
    const hers = receive(emptyState(), 'rdv1:us', ours.outgoing[0].payload, ctx(loud));
    const reply = hers.outgoing.find((o) => o.payload.type === 'a2a/message')!.payload;
    const step = receive(ours.state, 'rdv1:mallory', reply, ctx(inboundMeetingScope(contact, ours.state, reply)));
    expect(step.events.map((e) => e.kind)).toContain('completed');
  });
});
