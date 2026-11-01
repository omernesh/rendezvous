// rdv-gateway's owner commands need an interactive terminal (issue #126): a
// spawned bin (an assistant's shell, a script, a pipe) is refused before it
// reads or writes anything; read-only commands stay open. The allowed path runs
// through gatewayMain's in-process `interactive` option (helpers: gatewayArgv).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home, initHome } from '@rendezvous/cli/lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gatewayHumanOnlyArgv } from '../src/args.js';
import { GatewayStore } from '../src/store.js';
import { gatewayArgv } from './helpers.js';

function bin(args: string[], input: string, asOwner: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, gatewayArgv(args, asOwner), { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin!.end(input);
  });
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).size}:${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

describe('rdv-gateway owner commands need an interactive terminal (issue #126)', () => {
  let root: string;
  let home: string;
  let secretFile: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-tty-'));
    home = join(root, 'gw');
    await initHome(new Home(home), { profile: 'omer', relays: ['wss://relay.example.com'], emails: ['omer@example.com'] });
    secretFile = join(root, 'hook.secret');
    writeFileSync(secretFile, 'a'.repeat(64));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a spawned bin refuses each one with the message, nonzero, and nothing changes; read-only ones run', { timeout: 120_000 }, async () => {
    const h = ['--home', home];
    const owner = [
      ['pin', 'set', ...h],
      ['pin', 'set', '--stdin', ...h],
      ['pin', 'unlock', ...h],
      ['token', 'create', '--name', 'x', '--scope', 'read', ...h],
      ['token', 'revoke', 'tok_x', ...h],
      ['oauth', 'revoke', 'cli_x', ...h],
      ['agent', 'add', 'kids', 'new', '--email', 'kids@example.com', ...h],
      ['agent', 'remove', 'kids', ...h],
      ['agent', 'migrate', '--name', 'main', ...h],
      ['notify', 'set', 'omer', '--url', 'https://hooks.example.com/rdv', '--secret-file', secretFile, ...h],
      ['notify', 'clear', 'omer', ...h],
      ['notify', 'dead-letter', 'omer', '--retry', ...h],
    ];
    for (const args of owner) expect(gatewayHumanOnlyArgv(args), args.join(' ')).toBe(true);
    const before = snapshot(root);
    const results = await Promise.all(owner.map((args) => bin(args, '482916-first\n482916-first\n', false)));
    results.forEach((r, i) => {
      const what = owner[i].slice(0, 2).join(' ');
      expect(r.code, `${what}: ${r.stderr}`).toBe(1);
      expect(r.stderr, what).toContain(`rdv-gateway ${what} is for you, in your own terminal: it needs an interactive terminal`);
      expect(r.stdout, what).toBe('');
    });
    expect(snapshot(root)).toEqual(before);
    expect(new GatewayStore(new Home(home)).hasPin()).toBe(false);

    for (const args of [['token', 'list', ...h], ['oauth', 'list', ...h], ['agent', 'list', ...h], ['notify', 'show', ...h], ['pin', 'set', '--help']]) {
      expect(gatewayHumanOnlyArgv(args), args.join(' ')).toBe(false);
      const r = await bin(args, '', false);
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
    }
  });

  it('in the owner\'s terminal (the in-process seam) the same command runs', { timeout: 60_000 }, async () => {
    const r = await bin(['pin', 'set', '--stdin', '--home', home], '482916-first\n', true);
    expect(r.code, r.stderr).toBe(0);
    expect((await new GatewayStore(new Home(home)).checkPin('482916-first', Date.now())).ok).toBe(true);
  });
});
