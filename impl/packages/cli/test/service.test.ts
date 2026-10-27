// The background listener (issue #102 item 6, NOTES 100): the definition is a
// pure function of the platform, so every OS is tested here on any OS. The OS
// commands go through a fake runner: no test registers a real service.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rdv } from '../scenarios/harness.js';
import { Home } from '../src/home.js';
import {
  GATE_FLAGS,
  installService,
  markedHome,
  quoteSystemd,
  quoteWin,
  removeService,
  type RunResult,
  serviceDefinition,
  type ServiceEnv,
  serviceName,
  serviceRole,
  serviceStatus,
} from '../src/service.js';

const WIN: ServiceEnv = {
  platform: 'win32',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  bin: 'C:\\Users\\First Last\\.rendezvous\\src\\impl\\packages\\cli\\dist\\src\\bin.js',
  userHome: 'C:\\Users\\First Last',
  systemRoot: 'C:\\Windows',
  user: 'DESKTOP\\First Last',
};
const WIN_HOME = 'C:\\Users\\First Last\\.rendezvous\\omer';
const MAC: ServiceEnv = { platform: 'darwin', node: '/Users/first last/.nvm/versions/node/v22.11.0/bin/node', bin: '/Users/first last/.rendezvous/src/impl/packages/cli/dist/src/bin.js', userHome: '/Users/first last', uid: 501 };
const MAC_HOME = '/Users/first last/.rendezvous/omer';
const LINUX: ServiceEnv = { platform: 'linux', node: '/usr/bin/node', bin: '/home/first last/.rendezvous/src/impl/packages/cli/dist/src/bin.js', userHome: '/home/first last', uid: 1000 };
const LINUX_HOME = '/home/first last/.rendezvous/omer';

const all = [
  ['win32', WIN, WIN_HOME],
  ['darwin', MAC, MAC_HOME],
  ['linux', LINUX, LINUX_HOME],
] as const;

describe('the definition, per OS', () => {
  it('Windows: a logon task for this user only, through wscript and a hidden script in the home; paths with spaces quoted', () => {
    const d = serviceDefinition(WIN_HOME, 'omer', WIN);
    expect(d.name).toBe('rdv-listen-omer');
    expect(d.commandLine).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\First Last\\.rendezvous\\src\\impl\\packages\\cli\\dist\\src\\bin.js" listen --service rdv-listen-omer --home "C:\\Users\\First Last\\.rendezvous\\omer"',
    );
    // The task's action is wscript, never node or powershell.
    expect(d.launcher[0]).toBe('C:\\Windows\\System32\\wscript.exe');
    expect(d.launcherLine).toBe('"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\Users\\First Last\\.rendezvous\\omer\\service\\rdv-listen-omer.vbs"');
    const [vbs, task] = d.files;
    expect(vbs.path).toBe('C:\\Users\\First Last\\.rendezvous\\omer\\service\\rdv-listen-omer.vbs');
    expect(vbs.encoding).toBe('utf16le');
    // Hidden (window style 0), with the command's quotes doubled inside the VBScript string.
    expect(vbs.content).toContain('rc = sh.Run(cmd, 0, True)');
    expect(vbs.content).toContain('cmd = """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\First Last\\');
    expect(vbs.content).toContain('--home ""C:\\Users\\First Last\\.rendezvous\\omer"""');
    // Only Windows' own variables reach node; PATH is System32 only.
    expect(vbs.content).toContain('env.Remove names(i)');
    expect(vbs.content).toContain('env("PATH") = "C:\\Windows\\System32;C:\\Windows"');
    expect(vbs.content).not.toMatch(/NODE_OPTIONS|RDV_/);
    expect(task.content).toContain('<LogonTrigger>');
    expect(task.content).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DESKTOP\\First Last<\/UserId>/);
    expect(task.content).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(task.content).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(task.content).toContain('<Command>C:\\Windows\\System32\\wscript.exe</Command>');
    expect(task.content).toContain('<Arguments>//B //Nologo &quot;C:\\Users\\First Last\\.rendezvous\\omer\\service\\rdv-listen-omer.vbs&quot;</Arguments>');
    expect(task.content).toContain('<RestartOnFailure>');
    expect(task.content).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(d.install).toEqual([
      ['schtasks', '/Create', '/TN', 'rdv-listen-omer', '/XML', task.path, '/F'],
      ['schtasks', '/Run', '/TN', 'rdv-listen-omer'],
    ]);
    expect(markedHome(task.content)).toBe(WIN_HOME);
    expect(markedHome(vbs.content)).toBe(WIN_HOME);
  });

  it('macOS: a LaunchAgent with RunAtLoad and KeepAlive, env -i and absolute paths', () => {
    const d = serviceDefinition(MAC_HOME, 'omer', MAC);
    const [plist] = d.files;
    expect(plist.path).toBe('/Users/first last/Library/LaunchAgents/rdv-listen-omer.plist');
    expect(plist.content).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist.content).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist.content).toMatch(/<key>Label<\/key>\s*<string>rdv-listen-omer<\/string>/);
    expect(d.launcher).toEqual(['/usr/bin/env', '-i', 'HOME=/Users/first last', 'PATH=/usr/bin:/bin', MAC.node, MAC.bin, 'listen', '--service', 'rdv-listen-omer', '--home', MAC_HOME]);
    // Each argument is one <string>: a space never splits one.
    expect(plist.content).toContain(`<string>${MAC_HOME}</string>`);
    expect(d.launcherLine).toContain(`'${MAC_HOME}'`);
    expect(d.install).toEqual([
      ['launchctl', 'bootout', 'gui/501/rdv-listen-omer'],
      ['launchctl', 'bootstrap', 'gui/501', plist.path],
    ]);
    expect(markedHome(plist.content)).toBe(MAC_HOME);
  });

  it('Linux: a systemd user unit with Restart=on-failure, enabled with enable --now; ExecStart quoted and escaped', () => {
    const d = serviceDefinition(LINUX_HOME, 'omer', LINUX);
    const [unit] = d.files;
    expect(unit.path).toBe('/home/first last/.config/systemd/user/rdv-listen-omer.service');
    expect(unit.content).toContain('Restart=on-failure');
    expect(unit.content).toContain('WantedBy=default.target');
    expect(unit.content).toContain(
      'ExecStart=/usr/bin/env -i "HOME=/home/first last" PATH=/usr/bin:/bin /usr/bin/node "/home/first last/.rendezvous/src/impl/packages/cli/dist/src/bin.js" listen --service rdv-listen-omer --home "/home/first last/.rendezvous/omer"',
    );
    expect(d.install).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'rdv-listen-omer.service'],
    ]);
    // systemd expands % specifiers and $ variables: they are doubled.
    expect(quoteSystemd('/home/a%b/$x')).toBe('"/home/a%%b/$$x"');
    expect(quoteSystemd('/home/a "b"\\c')).toBe('"/home/a \\"b\\"\\\\c"');
    expect(markedHome(unit.content)).toBe(LINUX_HOME);
  });

  it.each(all)('%s: never a flag that passes a human gate, never a PATH lookup', (_p, env, home) => {
    const d = serviceDefinition(home, 'omer', env);
    const text = [d.commandLine, d.launcherLine, ...d.launcher, ...d.argv, ...d.files.map((f) => f.content)].join('\n');
    for (const flag of [...GATE_FLAGS, '--auto-grant', '--auto-confirm', '--auto-grant-any-tier']) expect(text).not.toContain(flag);
    expect(d.argv).toEqual([env.node, env.bin, 'listen', '--service', 'rdv-listen-omer', '--home', home]);
    // The OS starts an absolute path: wscript, or /usr/bin/env, which runs node by its absolute path.
    expect(d.launcher[0]).toMatch(/^(C:\\Windows\\System32\\wscript\.exe|\/usr\/bin\/env)$/);
  });

  it.each(all)('%s: one name per profile, so profiles coexist', (_p, env, home) => {
    const a = serviceDefinition(home, 'omer', env);
    const b = serviceDefinition(`${home}-work`, 'work', env);
    expect([a.name, b.name]).toEqual(['rdv-listen-omer', 'rdv-listen-work']);
    expect(a.files.map((f) => f.path)).not.toEqual(b.files.map((f) => f.path));
    expect(a.location).not.toBe(b.location);
    expect(a.digest).not.toBe(b.digest);
  });

  it('refuses what cannot be put in a definition safely', () => {
    expect(() => serviceDefinition('relative/home', 'omer', LINUX)).toThrow(/absolute/);
    expect(() => serviceDefinition(LINUX_HOME, 'omer', { ...LINUX, node: 'node' })).toThrow(/absolute/);
    expect(() => serviceDefinition('C:\\Users\\a"b\\.rendezvous\\x', 'x', WIN)).toThrow(/double quote/);
    expect(() => serviceDefinition('/home/a\nb', 'x', LINUX)).toThrow(/control character/);
    expect(() => serviceDefinition(WIN_HOME, 'omer', { ...WIN, user: undefined })).toThrow(/account/);
    expect(() => serviceDefinition(MAC_HOME, 'omer', { ...MAC, uid: undefined })).toThrow(/uid/);
    expect(serviceName('a b/c')).toBe('rdv-listen-a-b-c');
    expect(quoteWin('C:\\dir with space\\', true)).toBe('"C:\\dir with space\\\\"');
    // A home with "--" in it stays inside the plist's comment.
    const d = serviceDefinition('/Users/x/my--home', 'x', MAC);
    expect(d.files[0].content).not.toMatch(/<!--[^>]*my--home/);
    expect(markedHome(d.files[0].content)).toBe('/Users/x/my--home');
  });
});

// --- install, status, remove, with fake OS commands ------------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rdv-service-'));
  dirs.push(d);
  return d;
}

/**
 * A scratch directory whose path the platform under test reads as absolute. A
 * macOS or Linux definition made on Windows gets a drive-relative POSIX path
 * (\docker\… on the current drive), which this process's fs still opens.
 */
function rootFor(platform: 'linux' | 'darwin' | 'win32'): string {
  if (process.platform !== 'win32' || platform === 'win32') return tmp();
  const base = mkdtempSync(join(process.cwd(), '.rdv-service-'));
  dirs.push(base);
  return base.slice(2).replace(/\\/g, '/');
}

/** A home with a config (the profile) and an OS that only records what it is asked. */
function machine(platform: 'linux' | 'darwin' | 'win32') {
  const root = rootFor(platform);
  const j = platform === 'win32' ? join : posix.join;
  const home = new Home(j(root, 'home dir', 'omer'));
  mkdirSync(home.dir, { recursive: true });
  const node = platform === 'win32' ? process.execPath : '/usr/local/bin/node';
  const env: ServiceEnv = { platform, node, bin: j(root, 'bin.js'), userHome: j(root, 'user home'), uid: 501, systemRoot: 'C:\\Windows', user: 'HOST\\omer' };
  const calls: string[][] = [];
  const tasks = new Map<string, string>();
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const run = (argv: string[]): RunResult => {
    calls.push(argv);
    if (argv[0] !== 'schtasks') return ok();
    const name = argv[argv.indexOf('/TN') + 1];
    if (argv[1] === '/Create') tasks.set(name, readFileSync(argv[argv.indexOf('/XML') + 1]).toString('utf16le'));
    if (!tasks.has(name)) return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    if (argv[1] === '/Delete') tasks.delete(name);
    if (argv[1] === '/Query') return ok(argv.includes('/XML') ? tasks.get(name) : `"\\${name}","N/A","Ready"`);
    return ok();
  };
  return { home, env, run, calls, tasks };
}

describe('install, status and remove', () => {
  // The Windows definition's files are Windows paths: written only where they mean something.
  it.each((['linux', 'darwin', 'win32'] as const).filter((p) => p !== 'win32' || process.platform === 'win32'))('%s: installs, reports, refuses another home, removes', (platform) => {
    const m = machine(platform);
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    const none = serviceStatus(m.home, 'omer', m.env, m.run);
    expect(none).toMatchObject({ installed: false, ours: false, running: false, listener: null, holds_listener_lock: false });
    // Status is read-only: it only asks.
    expect(m.calls.every((c) => /^(is-active|print|\/Query)$/.test(c[0] === 'systemctl' ? c[2] : c[1]))).toBe(true);

    installService(m.home, d, m.run);
    for (const f of d.files) expect(existsSync(f.path)).toBe(true);
    for (const c of d.install) expect(m.calls).toContainEqual(c);
    const st = serviceStatus(m.home, 'omer', m.env, m.run);
    expect(st).toMatchObject({ installed: true, ours: true, current: true, installed_home: m.home.dir, name: 'rdv-listen-omer', profile: 'omer', home: m.home.dir });

    // The lock: who holds it, and whether it is the service.
    writeFileSync(m.home.listenerLockPath, JSON.stringify({ pid: process.pid, host: hostname(), since: '2026-10-27T00:00:00Z', role: serviceRole(d.name) }));
    expect(serviceStatus(m.home, 'omer', m.env, m.run)).toMatchObject({ holds_listener_lock: true, listener: { holder: 'rdv service rdv-listen-omer', pid: process.pid } });
    writeFileSync(m.home.listenerLockPath, JSON.stringify({ pid: process.pid, host: hostname(), since: '2026-10-27T00:00:00Z', role: 'rdv-mcp' }));
    expect(serviceStatus(m.home, 'omer', m.env, m.run)).toMatchObject({ holds_listener_lock: false, listener: { holder: 'rdv-mcp' } });
    rmSync(m.home.listenerLockPath);

    // Another home with the same profile name: never replaced, never removed from here.
    const other = new Home(`${m.home.dir}-elsewhere`);
    const theirs = serviceDefinition(other.dir, 'omer', m.env);
    expect(() => installService(other, theirs, m.run)).toThrow(/another home/);
    expect(() => removeService(other, theirs, m.run)).toThrow(/another home/);
    expect(serviceStatus(other, 'omer', m.env, m.run)).toMatchObject({ installed: true, ours: false, installed_home: m.home.dir });

    // An older definition (another node) is reported as not current.
    const older = serviceDefinition(m.home.dir, 'omer', { ...m.env, node: `${m.env.node}-old` });
    expect(older.digest).not.toBe(d.digest);

    m.calls.length = 0;
    expect(removeService(m.home, d, m.run)).toBe(true);
    for (const c of d.remove) expect(m.calls).toContainEqual(c);
    for (const f of d.files) expect(existsSync(f.path)).toBe(false);
    expect(serviceStatus(m.home, 'omer', m.env, m.run).installed).toBe(false);
    expect(removeService(m.home, d, m.run)).toBe(false);
  });

  it('a unit that is not ours (no marker) is never replaced', () => {
    const m = machine('linux');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    mkdirSync(join(d.files[0].path, '..'), { recursive: true });
    writeFileSync(d.files[0].path, '[Service]\nExecStart=/bin/true\n');
    expect(() => installService(m.home, d, m.run)).toThrow(/not made by rdv service install/);
    expect(readFileSync(d.files[0].path, 'utf8')).toContain('/bin/true');
  });

  it('a failed OS command is reported with its own words', () => {
    const m = machine('linux');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    const failing = (argv: string[]): RunResult => (argv.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } : { code: 0, stdout: '', stderr: '' });
    expect(() => installService(m.home, d, failing)).toThrow(/enable --now rdv-listen-omer.service" failed \(exit 1\): Failed to connect to bus/);
  });
});

describe('rdv listen --service', () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  });
  afterAll(async () => {
    await relay.close();
  });

  it('takes only the service name, and never with a flag that passes a gate', { timeout: 60_000 }, async () => {
    const home = join(tmp(), 'omer');
    await rdv(['init', '--profile', 'omer', '--email', `omer.${process.pid}@example.com`, '--relay', relay.url], home);
    const bad = await rdv(['listen', '--service', 'nope'], home, { check: false });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--service takes the service name');
    const gate = await rdv(['listen', '--service', 'rdv-listen-omer', '--auto-grant', 'stranger'], home, { check: false });
    expect(gate.code).toBe(2);
    expect(gate.stderr).toMatch(/no --auto-grant/);
    const dry = await rdv(['service', 'install', '--dry-run'], home);
    expect(dry.lines[0]).toMatchObject({ name: 'rdv-listen-omer', platform: process.platform });
    expect(dry.lines[0].command_line).toContain('listen --service rdv-listen-omer --home');
    expect(dry.lines[0].command_line).not.toMatch(/--auto-|--exec|--negotiate/);
  });
});
