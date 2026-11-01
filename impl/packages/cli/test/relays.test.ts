// `rdv relays` and `rdv card publish --mirror` (NOTES 81), on real `rdv`
// processes and the in-memory relay. Never touches the network: an agent on
// ws:// relays gets no default mirrors.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MIRROR_RELAYS, DEFAULT_RELAYS, relaysOf, verifyCard } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv, rdvArgv } from '../scenarios/harness.js';
import { checkPhrase, issuePhrase, relaysTarget } from '../src/consent.js';
import { Home } from '../src/home.js';
import { checkRelayUrl, mirrorRelaysOf } from '../src/transport.js';

let root: string;
const relays: TestRelay[] = [];
const start = async (faults = {}) => {
  const r = await startTestRelay(0, faults);
  relays.push(r);
  return r;
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rdv-relays-'));
});
afterAll(async () => {
  for (const r of relays) await r.close();
});

const json = (home: string, file: string) => JSON.parse(readFileSync(join(home, file), 'utf8'));
const cardsOn = (r: TestRelay) => r.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1].startsWith('rdv1/card:')));

describe('relay URL validation', () => {
  it('takes wss://, ws:// only on this machine, and normalizes', () => {
    expect(checkRelayUrl('wss://Relay.Example.com/')).toEqual({ url: 'wss://relay.example.com' });
    expect(checkRelayUrl(' wss://relay.example.com/path ')).toEqual({ url: 'wss://relay.example.com/path' });
    expect(checkRelayUrl('ws://127.0.0.1:7777')).toEqual({ url: 'ws://127.0.0.1:7777' });
    expect(checkRelayUrl('ws://localhost:7777')).toEqual({ url: 'ws://localhost:7777' });
    for (const bad of ['ws://relay.example.com', 'https://relay.example.com', 'relay.example.com', 'wss://u:p@relay.example.com', 'wss://relay.example.com/#x', '', 'wss://']) {
      expect('problem' in checkRelayUrl(bad), bad).toBe(true);
    }
    expect((checkRelayUrl('ws://relay.example.com') as { problem: string }).problem).toContain('only for a relay on this machine');
  });

  it('mirrors default to the surveyed set for a wss:// agent, to none for a ws:// one, and never repeat our relays', () => {
    expect(mirrorRelaysOf({ relays: [...DEFAULT_RELAYS] })).toEqual(DEFAULT_MIRROR_RELAYS.filter((r) => !DEFAULT_RELAYS.includes(r)));
    expect(mirrorRelaysOf({ relays: ['ws://127.0.0.1:1'] })).toEqual([]);
    expect(mirrorRelaysOf({ relays: ['wss://a.example'], mirror_relays: ['wss://b.example', 'wss://a.example', 'wss://b.example'] })).toEqual(['wss://b.example']);
    expect(mirrorRelaysOf({ relays: ['wss://a.example'], mirror_relays: [] })).toEqual([]);
  });
});

describe('rdv relays', () => {
  it('lists, adds and removes listening relays; re-signs and republishes the card; refuses bad input and the last relay', async () => {
    const one = await start();
    const two = await start();
    const home = join(root, 'omer');
    await rdv(['init', '--email', 'omer@example.com', '--relay', one.url, '--public-pointer'], home);
    await rdv(['card', 'publish'], home);
    const before = json(home, 'agent.json').card;

    const list = (await rdv(['relays', 'list'], home)).lines[0];
    expect(list).toMatchObject({ event: 'relays', relays: [one.url], mirror_relays: [], mirror_default: true });

    for (const bad of ['ws://relay.example.com', 'http://x.example', 'nope']) {
      expect((await rdv(['relays', 'add', bad], home, { check: false })).code, bad).toBe(2);
    }
    expect((await rdv(['relays', 'add', one.url], home, { check: false })).stderr).toContain('already one of');
    expect((await rdv(['relays', 'remove', 'wss://nowhere.example'], home, { check: false })).code).toBe(1);
    const last = await rdv(['relays', 'remove', one.url], home, { check: false });
    expect(last.code).toBe(1);
    expect(last.stderr).toContain('last relay');

    const added = (await rdv(['relays', 'add', two.url], home)).lines[0];
    expect(added).toMatchObject({ event: 'relay-added', change: 'added', set: 'listen', url: two.url, relays: [one.url, two.url] });
    expect(added.published).toHaveLength(2); // the address and the agent ID (NOTES 83)
    const card = json(home, 'agent.json').card;
    expect(verifyCard(card).ok).toBe(true);
    expect(relaysOf(card)).toEqual([one.url, two.url]);
    expect(Date.parse(card.created)).toBeGreaterThan(Date.parse(before.created));
    expect(json(home, 'config.json').relays).toEqual([one.url, two.url]);
    expect(cardsOn(two)).toHaveLength(2); // on the address topic and the agent ID's (NOTES 83)

    const removed = (await rdv(['relays', 'remove', one.url], home)).lines[0];
    expect(removed).toMatchObject({ event: 'relay-removed', relays: [two.url] });
    expect(removed.warning).toContain('contacts keep the card');
    // The dropped relay got the newer card too, so a lookup there no longer finds one that lists it.
    const onOne = cardsOn(one);
    expect(onOne).toHaveLength(2);
    for (const e of onOne) expect(relaysOf(JSON.parse(e.content))).toEqual([two.url]);
    expect(relaysOf(json(home, 'agent.json').card)).toEqual([two.url]);
  });

  it('a running rdv listen moves to the new relays without a restart', async () => {
    const one = await start();
    const two = await start();
    const home = join(root, 'john');
    await rdv(['init', '--email', 'john@doe.com', '--relay', one.url], home);
    const l = new Listener('john', home);
    try {
      await l.waitFor((x) => x.event === 'ready', 'ready', 10_000);
      await rdv(['relays', 'add', two.url], home);
      const moved = await l.waitFor((x) => x.event === 'relays', 'relays changed', 10_000);
      expect(moved.relays).toEqual([one.url, two.url]);
      const end = Date.now() + 5000;
      while (two.requests.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(two.requests.length).toBeGreaterThan(0); // it subscribed there
    } finally {
      await l.stop();
    }
  }, 30_000);
});

describe('a relay change the assistant asked for (rdv_relays)', () => {
  it('rdv relays list shows its confirm phrase in the human\'s terminal (text mode only), bound to the change', async () => {
    const one = await start();
    const home = join(root, 'asked');
    await rdv(['init', '--email', 'asked@example.com', '--relay', one.url], home);
    const h = new Home(home);
    const target = relaysTarget('add', 'wss://relay.example.com', [one.url]);
    await h.locked(async () => issuePhrase(h, target));
    const text = execFileSync(process.execPath, rdvArgv(['relays', 'list', '--home', home]), { encoding: 'utf8', windowsHide: true });
    expect(text).toContain('Your assistant asks to change your relays: listen on wss://relay.example.com');
    const phrase = /confirm phrase \(relays\): ([a-z]+-[a-z]+-[a-z]+-\d{3})/.exec(text)?.[1];
    expect(phrase).toBeDefined();
    // --json (what a tool would read) never carries it.
    const json = await rdv(['relays', 'list'], home);
    expect(json.stdout).not.toContain(phrase!);
    expect(json.stdout).not.toContain('confirm phrase');
    // It approves this change, not another URL.
    expect((await h.locked(async () => checkPhrase(h, relaysTarget('add', 'wss://other.example.com', [one.url]), phrase!))).ok).toBe(false);
    expect((await h.locked(async () => checkPhrase(h, target, phrase!))).ok).toBe(true);
  });
});

describe('a publish no relay took', () => {
  it('the terminal shows each relay\'s reason; nothing changed', async () => {
    const refusing = await start({ okFalse: 'blocked: no thanks' });
    const other = await start({ okFalse: 'rate-limited: slow down' });
    const home = join(root, 'refused');
    await rdv(['init', '--email', 'refused@example.com', '--relay', refusing.url, '--public-pointer'], home);
    const r = await rdv(['relays', 'add', other.url], home, { check: false });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('could not publish the new card on any relay, so nothing changed');
    expect(r.stderr).toContain('blocked: no thanks');
    expect(json(home, 'config.json').relays).toEqual([refusing.url]);
    expect(relaysOf(json(home, 'agent.json').card)).toEqual([refusing.url]);
    const m = await rdv(['card', 'publish', '--mirror'], home, { check: false, timeoutMs: 60_000 });
    expect(m.code).toBe(1);
    expect(m.stderr).toContain('no relay accepted the card');
    expect(m.stderr).toContain(refusing.url);
  }, 60_000);
});

describe('rdv card publish --mirror', () => {
  it('publishes to our relay and each mirror one at a time, reports per relay, reads back, and lookups find it on a mirror', async () => {
    const own = await start();
    const mirror = await start();
    const refusing = await start({ okFalse: 'blocked: kind 30417 is not allowed' });
    const home = join(root, 'mirror');
    await rdv(['init', '--email', 'omer.mirror@example.com', '--relay', own.url, '--public-pointer'], home);
    expect((await rdv(['relays', 'add', '--mirror', mirror.url], home)).lines[0]).toMatchObject({ set: 'mirror', mirror_relays: [mirror.url] });
    await rdv(['relays', 'add', '--mirror', refusing.url], home);
    expect((await rdv(['relays', 'add', '--mirror', own.url], home, { check: false })).stderr).toContain('listening relays');
    expect(json(home, 'config.json').mirror_relays).toEqual([mirror.url, refusing.url]);
    // A mirror change is config only: the card (and its relays) stay.
    expect(relaysOf(json(home, 'agent.json').card)).toEqual([own.url]);

    const r = await rdv(['card', 'publish', '--mirror'], home, { timeoutMs: 60_000 });
    const rows = r.lines.filter((x) => x.event === 'mirror-relay');
    expect(rows.map((x) => [x.url, x.role, x.result, x.served])).toEqual([
      [own.url, 'listen', 'accepted', true],
      [mirror.url, 'mirror', 'accepted', true],
      [refusing.url, 'mirror', 'rejected', null],
    ]);
    expect(rows[2]).toMatchObject({ kind: 'blocked', message: 'blocked: kind 30417 is not allowed' });
    expect(r.lines.at(-1)).toMatchObject({ event: 'mirrored', relays: 3, accepted: 2, rejected: 1, timeout: 0, skipped: 0, served: 2 });
    expect(refusing.received).toHaveLength(1); // one try, no retry burst
    expect(mirror.received[0] - own.received[0]).toBeGreaterThanOrEqual(1000); // paced

    // John is on another relay; with our mirror as one of his, his lookup finds the card.
    const other = await start();
    const john = join(root, 'john-lookup');
    await rdv(['init', '--email', 'john.mirror@doe.com', '--relay', other.url], john);
    expect((await rdv(['lookup', 'omer.mirror@example.com'], john, { check: false })).code).toBe(1);
    await rdv(['relays', 'add', '--mirror', mirror.url], john);
    const found = await rdv(['lookup', 'omer.mirror@example.com'], john);
    expect(found.lines[0].id).toBe(json(home, 'agent.json').card.id);

    // The banning mirror cools down: the next run skips it without contacting it.
    const again = await rdv(['card', 'publish', '--mirror'], home, { timeoutMs: 60_000 });
    expect(again.lines.find((x) => x.url === refusing.url)).toMatchObject({ result: 'skipped' });
    expect(refusing.received).toHaveLength(1);
    // Removing a mirror is config only too.
    expect((await rdv(['relays', 'remove', '--mirror', refusing.url], home)).lines[0].mirror_relays).toEqual([mirror.url]);
  }, 90_000);

  it('refuses without the public pointer', async () => {
    const own = await start();
    const home = join(root, 'no-pointer');
    await rdv(['init', '--email', 'nobody@example.com', '--relay', own.url], home);
    const r = await rdv(['card', 'publish', '--mirror'], home, { check: false });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('public pointer is off');
  });
});
