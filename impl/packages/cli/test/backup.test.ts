// rdv backup / rdv restore (issue #88, NOTES 91): an encrypted bundle, a clean
// restore that contacts follow without a resync, and auto-approve that holds
// across it ("until I say otherwise").
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_URI } from '@rendezvous/a2a';
import { type AgentState, sealBackup } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, RDV_BIN, rdv, rdvArgv } from '../scenarios/harness.js';
import { backupCmd, contactAutoApprove, restoreCmd, type Tty, whoami } from '../src/commands.js';
import { Home } from '../src/home.js';
import { storeOwnerSecret } from '../src/ownersecret.js';
import { Output } from '../src/output.js';

const PASS = 'correct horse battery staple 42';
const OWNER = 'OWNER-PASS correct horse';

function tty(answer: string | string[], interactive = true): Tty & { shown: string[]; secrets: number } {
  const shown: string[] = [];
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const next = () => (answers.length > 1 ? answers.shift()! : answers[0]);
  const t = {
    interactive,
    shown,
    secrets: 0,
    say: (x: string) => void shown.push(x),
    ask: async (q: string) => (shown.push(q), next()),
    secret: async (q: string) => (t.secrets++, shown.push(q), next()),
  };
  return t;
}

/** Collect what a command prints as JSON lines. */
function capture(): { out: Output; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const out = new Output(true);
  (out as unknown as { emit: (o: Record<string, unknown>) => void }).emit = (o) => void lines.push(o);
  return { out, lines };
}

/**
 * `rdv <args>` with `input` on stdin: as the human in their own terminal (rdvArgv), or with `asHuman: false` as an
 * assistant's shell or a script would run it (bin.js, no terminal).
 */
function rdvStdin(args: string[], home: string, input: string, asHuman = true): Promise<{ code: number; stdout: string; stderr: string }> {
  const full = [...args, '--home', home, '--json'];
  return new Promise((resolve) => {
    const child = execFile(process.execPath, asHuman ? rdvArgv(full) : [RDV_BIN, ...full], { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}

describe('rdv backup and rdv restore', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-backup-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes an encrypted bundle only from a terminal (or --stdin), never over a file or into a home; restores only what the passphrase opens', { timeout: 60_000 }, async () => {
    const srcDir = join(root, 'src');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], srcDir);
    const src = new Home(srcDir);
    await storeOwnerSecret(src, OWNER);
    writeFileSync(src.consentPath, JSON.stringify({ 'request:x': { salt: 'SALT-NEVER-IN-BUNDLE', hash: 'h', action: 'request', created: 'now', attempts: 0 } }));
    const id = src.readAgentState().card.id;
    const file = join(root, 'omer.rdvbackup');

    // Not a terminal: refused, nothing written. A spawned rdv has none.
    const piped = await rdv(['backup', file], srcDir, { check: false });
    expect([piped.code, piped.stderr]).toEqual([1, expect.stringContaining('never an argument')]);
    await expect(backupCmd({ home: src, out: capture().out, values: {}, positionals: [file], tty: tty(PASS, false) })).rejects.toThrow(/terminal/);
    // Weak, or typed differently the second time: nothing written.
    await expect(backupCmd({ home: src, out: capture().out, values: {}, positionals: [file], tty: tty('short') })).rejects.toThrow(/at least 12/);
    await expect(backupCmd({ home: src, out: capture().out, values: {}, positionals: [file], tty: tty([PASS, `${PASS}!`]) })).rejects.toThrow(/did not match/);
    expect(existsSync(file)).toBe(false);
    // Inside a home: refused.
    await expect(backupCmd({ home: src, out: capture().out, values: {}, positionals: [join(srcDir, 'b.json')], tty: tty(PASS) })).rejects.toThrow(/inside a Rendezvous home/);

    const t = tty(PASS);
    const made = capture();
    await backupCmd({ home: src, out: made.out, values: {}, positionals: [file], tty: t });
    expect(made.lines[0]).toMatchObject({ event: 'backup', agent: id });
    expect(t.shown.join('\n')).not.toContain(PASS);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    const state = src.readAgentState();
    for (const secret of [state.secretKey, 'SALT-NEVER-IN-BUNDLE', JSON.parse(readFileSync(src.ownerSecretPath, 'utf8')).hash, PASS]) expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({ format: 'rdv-backup', v: 1, agent: id });
    // Never over an existing file.
    await expect(backupCmd({ home: src, out: capture().out, values: {}, positionals: [file], tty: tty(PASS) })).rejects.toThrow(/already exists/);
    expect(src.readAudit().filter((a) => a.gate === 'backup').map((a) => [a.action, a.via])).toEqual([['create', 'cli']]);

    // Restore: never over an existing agent without --replace; a terminal (or --stdin); the passphrase and an untouched file.
    await expect(restoreCmd({ home: src, out: capture().out, values: {}, positionals: [file], tty: tty(PASS) })).rejects.toThrow(/--replace/);
    const dst = new Home(join(root, 'dst'));
    const spawned = await rdv(['restore', file], dst.dir, { check: false });
    expect([spawned.code, spawned.stderr]).toEqual([1, expect.stringContaining('never an argument')]);
    const wrong = tty('correct horse battery staple 43');
    await expect(restoreCmd({ home: dst, out: capture().out, values: {}, positionals: [file], tty: wrong })).rejects.toThrow(/wrong passphrase/);
    expect(wrong.shown.join('\n')).toContain(id); // the form shows who is in the bundle before asking
    expect(dst.initialized()).toBe(false);
    const tampered = join(root, 'tampered.rdvbackup');
    const doc = JSON.parse(text);
    writeFileSync(tampered, JSON.stringify({ ...doc, created: '2020-01-01T00:00:00.000Z' }));
    await expect(restoreCmd({ home: dst, out: capture().out, values: {}, positionals: [tampered], tty: tty(PASS) })).rejects.toThrow(/changed or damaged/);
    writeFileSync(tampered, JSON.stringify({ ...doc, extra: true }));
    await expect(restoreCmd({ home: dst, out: capture().out, values: {}, positionals: [tampered], tty: tty(PASS) })).rejects.toThrow(/unexpected fields/);
    expect(dst.initialized()).toBe(false);

    const restored = capture();
    await restoreCmd({ home: dst, out: restored.out, values: {}, positionals: [file], tty: tty(PASS) });
    expect(restored.lines[0]).toMatchObject({ event: 'restore', id, contacts: 0 });
    expect(dst.readAgentState().card.id).toBe(id);
    expect(existsSync(dst.consentPath)).toBe(false); // confirm phrases never travel
    expect(readFileSync(dst.ownerSecretPath, 'utf8')).toBe(readFileSync(src.ownerSecretPath, 'utf8')); // the passphrase record, as stored
    expect(dst.readAudit().map((a) => [a.gate, a.action])).toEqual([['backup', 'restore']]);
    const who = capture();
    await whoami({ home: dst, out: who.out, values: {}, positionals: [] });
    expect(who.lines[0]).toMatchObject({ id, restored: { backup_created: doc.created } });

    // A pipe is no terminal (issue #126): `echo pass | rdv restore --stdin` from a script or an assistant's shell is
    // refused before anything is read, and the agent here is untouched.
    const agentBefore = readFileSync(dst.agentPath, 'utf8');
    for (const args of [['restore', file, '--replace', '--stdin'], ['backup', join(root, 'piped.rdvbackup'), '--stdin']]) {
      const piped = await rdvStdin(args, dst.dir, `${PASS}\n`, false);
      expect([piped.code, piped.stderr], args[0]).toEqual([1, expect.stringContaining('needs an interactive terminal')]);
    }
    expect(existsSync(join(root, 'piped.rdvbackup'))).toBe(false);
    expect(readFileSync(dst.agentPath, 'utf8')).toBe(agentBefore);
    // --replace, explicitly, with --stdin in the human's own terminal.
    const again = await rdvStdin(['restore', file, '--replace', '--stdin'], dst.dir, `${PASS}\n`);
    expect([again.code, again.stderr]).toEqual([0, '']);
    expect(JSON.parse(again.stdout.trim().split('\n').at(-1)!)).toMatchObject({ event: 'restore', id, replaced: id });
    const viaStdin = await rdvStdin(['backup', join(root, 'stdin.rdvbackup'), '--stdin'], dst.dir, `${PASS}\n`);
    expect(viaStdin.code).toBe(0);

    // A bundle that decrypts but holds odd state (review of #92): with --replace, nothing of the agent here is touched.
    const before = [readFileSync(dst.agentPath, 'utf8'), readFileSync(dst.agentBackupPath, 'utf8')];
    const good = { v: 1, agent: dst.readAgentState(), config: dst.readConfig(), files: {} } as Record<string, unknown> & { agent: AgentState };
    for (const [why, agent] of [
      ['groups', { ...good.agent, groups: 'x' }],
      ['channel', { ...good.agent, channels: { [id]: null } }],
    ] as const) {
      const odd = join(root, `odd-${why}.rdvbackup`);
      writeFileSync(odd, JSON.stringify(await sealBackup(id, PASS, { ...good, agent: agent as unknown as AgentState })));
      await expect(restoreCmd({ home: dst, out: capture().out, values: { replace: true }, positionals: [odd], tty: tty(PASS) }), why).rejects.toThrow(/nothing was restored/);
      expect([readFileSync(dst.agentPath, 'utf8'), readFileSync(dst.agentBackupPath, 'utf8')], why).toEqual(before);
    }
    // A good --replace leaves no copy of the replaced state behind: agent.json.bak is the new state too.
    const other = join(root, 'other');
    await rdv(['init', '--profile', 'x', '--email', 'x@example.com', '--relay', relay.url], other);
    await restoreCmd({ home: new Home(other), out: capture().out, values: { replace: true }, positionals: [file], tty: tty(PASS) });
    expect(JSON.parse(readFileSync(new Home(other).agentBackupPath, 'utf8')).card.id).toBe(id);
  });

  it('after a restore, the contact goes on without a resync, and its auto-approve still holds: its task starts without asking', { timeout: 120_000 }, async () => {
    const omerHome = join(root, 'omer2');
    const johnHome = join(root, 'john2');
    await rdv(['init', '--profile', 'omer', '--email', 'omer2@example.com', '--relay', relay.url], omerHome);
    await rdv(['init', '--profile', 'john', '--email', 'john2@doe.com', '--relay', relay.url], johnHome);
    const cardFile = join(root, 'john2-card.json');
    writeFileSync(cardFile, JSON.stringify((await rdv(['whoami'], johnHome)).lines[0].card));
    const john = new Home(johnHome);
    let johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    const omerL = new Listener('omer', omerHome);
    const fresh = new Home(join(root, 'john2-new-machine'));
    let johnL2: Listener | undefined;
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', cardFile], omerHome);
      const johnId = (await omerL.waitFor((l) => l.event === 'contact', 'omer contact', 10_000)).peer as string;
      const omerId = (await rdv(['whoami'], omerHome)).lines[0].id as string;
      await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome);
      await omerL.waitFor((l) => l.event === 'reverse-grant', 'reverse grant', 10_000);
      // John puts Omer on auto-approve, in his own terminal.
      await storeOwnerSecret(john, OWNER);
      await contactAutoApprove({ home: john, out: capture().out, values: {}, positionals: [omerId, 'all'], tty: tty(OWNER) });
      // A first task: auto-started on the old machine.
      const first = await rdv(['task', 'request', johnId, '--text', 'before'], omerHome);
      const firstId = first.lines.find((l) => l.kind === 'requested')!.task as string;
      await johnL.waitFor((l) => l.event === 'task' && l.task === firstId && l.auto_approved === true, 'auto start before', 10_000);

      // John backs up, then his disk dies; he restores on a new machine.
      const file = join(root, 'john2.rdvbackup');
      await backupCmd({ home: john, out: capture().out, values: {}, positionals: [file], tty: tty(PASS) });
      await johnL.stop();
      const restoredOut = capture();
      await restoreCmd({ home: fresh, out: restoredOut.out, values: {}, positionals: [file], tty: tty(PASS) });
      expect(Object.keys(fresh.readAutoApprove())).toEqual([omerId]);
      // The standing decisions that came back are shown to the human.
      expect(restoredOut.lines[0]).toMatchObject({ auto_approve: [omerId], owner_passphrase_set: expect.any(String) });
      expect(existsSync(fresh.ownerSecretMarkerPath)).toBe(true);

      johnL2 = new Listener('john-restored', fresh.dir);
      const told = await johnL2.waitFor((l) => l.event === 'restore-notified', 'notices sent', 10_000);
      expect(told.sent).toEqual([omerId]);
      const seen = await omerL.waitFor((l) => l.event === 'contact-restored', 'omer told', 10_000);
      expect(seen).toMatchObject({ peer: johnId, backup_created: expect.any(String) });
      await johnL2.waitFor((l) => l.event === 'restore-confirmed' && l.peer === omerId, 'confirmed', 10_000);

      // A task from Omer starts without asking: the restore is no fork, and the entry verifies on the new machine.
      const req = await rdv(['task', 'request', johnId, '--text', 'after the restore'], omerHome);
      const taskId = req.lines.find((l) => l.kind === 'requested')!.task as string;
      const started = await johnL2.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'started' && l.auto_approved === true, 'auto start after', 15_000);
      expect(started.auto_approved).toBe(true);
      expect(johnL2.lines.some((l) => l.task === taskId && l.kind === 'start-needed')).toBe(false);
      expect(johnL2.lines.some((l) => l.event === 'auto-approve-off')).toBe(false);
      expect(johnL2.lines.some((l) => l.event === 'dropped' && /fork/.test(String(l.reason)))).toBe(false);
      expect(omerL.lines.some((l) => l.event === 'dropped' && /fork/.test(String(l.reason)))).toBe(false);
      const who = capture();
      await whoami({ home: fresh, out: who.out, values: {}, positionals: [] });
      expect(who.lines[0].restored).toMatchObject({ notice_due: [], awaiting_ack: [] });
      // The old machine's audit and Omer's contact list are untouched; John's new audit shows the restore and the auto start.
      expect(fresh.readAudit().map((a) => a.gate)).toEqual(expect.arrayContaining(['backup', 'start']));
    } finally {
      await johnL2?.stop();
      await johnL.stop().catch(() => {});
      await omerL.stop();
      johnL = undefined as never;
    }
  });
});
