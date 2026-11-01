// The human-only commands need an interactive terminal (issue #126): the
// boundary behind the plugin's best-effort consent guard. A spawned rdv (an
// assistant's shell, a script, a pipe) has none, so each one is refused,
// nothing on disk changes, and no flag or environment variable turns it off.
// The allowed path runs through main's in-process `interactive` option.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RDV_BIN, rdv } from '../scenarios/harness.js';
import { rdvHumanOnly } from '../src/humanonly.js';
import { humanOnlyArgv, main } from '../src/main.js';

/** The plain bin, as an assistant's shell runs it: stdin and stdout are pipes. */
function spawned(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [RDV_BIN, ...args], { windowsHide: true, timeout: 60_000, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
    child.stdin?.end('yes\n');
  });
}

/** Every file under `dir`, with its size, mtime and content hash. */
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

/** Every human-only command (the consent guard's list), with arguments that pass rdv's own usage checks. */
const HUMAN_ONLY = (file: string): string[][] => [
  ['contact', 'grant', 'req-1'],
  ['contact', 'confirm', 'grant-1'],
  ['contact', 'resync', 'rdv1:x'],
  ['contact', 'label', 'rdv1:x', 'John'],
  ['contact', 'alias', 'add', 'rdv1:x', 'Johnny'],
  ['contact', 'alias', 'remove', 'rdv1:x', 'Johnny'],
  ['contact', 'pending'],
  ['contact', 'auto-approve', 'rdv1:x', 'off'],
  ['contact', 'auto-approve', 'rdv1:x', 'all'],
  ['contact', 'request', 'rdv1:x', '--label', 'John'],
  ['dinner', 'list'],
  ['dinner', 'confirm', 'task-1', '--hold', 'code'],
  ['dinner', 'cancel', 'task-1'],
  ['task', 'list'],
  ['task', 'approve', 'task-1', '--code', 'code'],
  ['task', 'release', 'task-1', '--code', 'code'],
  ['task', 'request', 'rdv1:x', '--text', 'hi', '--inline', file],
  ['file', 'direct-transfer', 'on'],
  ['file', 'direct-transfer', 'off'],
  ['owner-secret', 'set'],
  ['owner-secret', 'reset'],
  ['relays', 'list'],
  ['relays', 'add', 'wss://relay.example.com'],
  ['relays', 'remove', 'wss://relay.example.com'],
  ['group', 'invite', 'grp-1', 'rdv1:x'],
  ['group', 'join', 'inv-1', '--code', 'code'],
  ['group', 'approve', 'grp-1', 'rdv1:x', '--code', 'code'],
  ['group', 'resync', 'grp-1'],
  ['group', 'pending'],
  ['group', 'leave', 'grp-1'],
  ['group', 'remove', 'grp-1', 'rdv1:x'],
  ['group', 'terms', 'grp-1'],
  ['group', 'promote', 'grp-1', 'rdv1:x'],
  ['service', 'install'],
  ['invite', 'create'],
  ['agent-name', 'set', 'Sammie'],
  ['agent-name', 'clear'],
  ['backup', join(file, '..', 'new.rdvbackup')],
  ['restore', file, '--replace'],
  ['backup', join(file, '..', 'new.rdvbackup'), '--stdin'],
  ['init', '--force', '--email', 'omer@example.com'],
  ['init', '--agent-name', 'Sammie', '--email', 'omer@example.com'],
  ['listen', '--auto-grant', 'friend'],
  ['listen', '--negotiate', '--auto-confirm'],
];

describe('human-only commands need an interactive terminal (issue #126)', () => {
  let relay: TestRelay;
  let root: string;
  let home: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-tty-'));
    home = join(root, 'omer');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], home);
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a spawned rdv (no terminal) refuses every one, says what to use instead, and changes nothing', { timeout: 180_000 }, async () => {
    const file = join(root, 'note.txt');
    const cases = HUMAN_ONLY(file);
    for (const args of cases) expect(humanOnlyArgv(args), args.join(' ')).toBeDefined();
    const before = snapshot(home);
    // A few at a time: each is a process of its own.
    for (let i = 0; i < cases.length; i += 8) {
      const results = await Promise.all(cases.slice(i, i + 8).map((args) => spawned([...args, '--home', home])));
      results.forEach((r, k) => {
        const what = cases[i + k].join(' ');
        expect(r.code, `${what}: ${r.stderr}`).toBe(1);
        expect(r.stderr, what).toContain('is for you, in your own terminal: it needs an interactive terminal');
        expect(r.stderr, what).toContain('Nothing was changed');
        expect(r.stdout, what).toBe('');
      });
    }
    expect(snapshot(home)).toEqual(before);
    // The message names the chat tool where there is one, also in --json mode (on stderr).
    const grant = await spawned(['contact', 'grant', 'req-1', '--home', home, '--json']);
    expect(JSON.parse(grant.stderr.trim()).error).toMatch(/rdv contact grant is for you.*ask it to use rdv_grant instead/);
    // No environment variable turns it off.
    const env = await spawned(['agent-name', 'set', 'Sammie', '--home', home], { RDV_INTERACTIVE: '1', CI: '', TERM: 'xterm-256color', FORCE_COLOR: '1' });
    expect(env.code).toBe(1);
    expect(snapshot(home)).toEqual(before);
  });

  it('read-only commands and the ones anyone may run stay open without a terminal', { timeout: 60_000 }, async () => {
    for (const args of [
      ['whoami'],
      ['contact', 'list'],
      ['contact', 'alias', 'list'],
      ['service', 'install', '--dry-run'],
      ['contact', 'request', 'john@doe.com', '--label', 'John'],
      ['task', 'request', 'rdv1:x', '--text', 'hi'],
      ['listen'],
      ['init', '--email', 'omer@example.com'],
      ['contact', 'grant', 'req-1', '--help'],
    ]) {
      expect(humanOnlyArgv(args), args.join(' ')).toBeUndefined();
    }
    const who = await spawned(['whoami', '--home', home, '--json']);
    expect(who.code, who.stderr).toBe(0);
    expect(rdvHumanOnly('contact list', {}, [])).toBeUndefined();
  });

  it('through main, the same command is refused unless the terminal is interactive, and then runs', { timeout: 60_000 }, async () => {
    const argv = ['agent-name', 'set', 'Sammie', '--home', home, '--json'];
    const before = snapshot(home);
    expect(await main(argv, { interactive: () => false })).toBe(1);
    expect(snapshot(home)).toEqual(before);
    // The harness's stand-in for the human's terminal (rdvArgv): the same seam, in a process of its own.
    const set = await rdv(['agent-name', 'set', 'Sammie'], home);
    expect(set.code).toBe(0);
    const who = await rdv(['whoami'], home);
    expect(JSON.stringify(who.lines)).toContain('Sammie');
  });
});
