import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv, until } from '../scenarios/harness.js';
import { acquireLock, LockTimeoutError, writeAtomic } from '../src/fsutil.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'rdv-test-'));

describe('lock and atomic writes', () => {
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

    const johnL = new Listener('john', johnHome, ['--auto-grant', 'colleague']);
    const omerL = new Listener('omer', omerHome);
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      const req = await rdv(['contact', 'request', cardFile, '--in-person', '--greeting', 'hi'], omerHome);
      expect(req.lines[0]).toMatchObject({ via: 'card', binding: 'in-person' });
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
      expect(contacts[0]).toMatchObject({ peer: card.id, tier: 'colleague', binding: 'in-person' });

      const rv = await rdv(['contact', 'revoke', card.id], omerHome);
      expect(rv.lines[0]).toMatchObject({ event: 'revoked', peer: card.id });
      await johnL.waitFor((l) => l.event === 'revoked', 'john sees revoke', 10_000);
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  });
});
