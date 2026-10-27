// The background listener (issue #102 item 6, NOTES 100): the definition is a
// pure function of the platform, so every OS is tested here on any OS. The OS
// commands go through a fake runner: no test registers a real service.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rdv } from '../scenarios/harness.js';
import { spawn } from 'node:child_process';
import { createBackup, readBackupFile, restoreBackup, writeBackupFile } from '../src/backup.js';
import { initHome } from '../src/commands.js';
import { Home } from '../src/home.js';
import {
  checkServiceArgv,
  homeService,
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
    // A profile outside the profile alphabet is refused, never cleaned up (H1 of the PR #117 review).
    expect(() => serviceName('a b/c')).toThrow(/cannot name a background service/);
    for (const env of [WIN, MAC, LINUX]) {
      expect(() => serviceDefinition(LINUX_HOME, "x)\nExecStartPre=/bin/sh -c 'id >/tmp/pwn'\n#", env)).toThrow(/cannot name a background service/);
    }
    // WshShell.Run expands %VAR%: no Windows path may hold a % (M2).
    expect(() => serviceDefinition('C:\\Users\\%USERNAME%\\.rendezvous\\x', 'x', WIN)).toThrow(/"%"/);
    expect(() => serviceDefinition(WIN_HOME, 'omer', { ...WIN, node: 'C:\\n%PATH%\\node.exe' })).toThrow(/"%"/);
    expect(quoteWin('C:\\dir with space\\', true)).toBe('"C:\\dir with space\\\\"');
    // A home with "--" in it stays inside the plist's comment.
    const d = serviceDefinition('/Users/x/my--home', 'a--b', MAC);
    for (const c of d.files[0].content.matchAll(/<!--([\s\S]*?)-->/g)) expect(c[1]).not.toContain('--');
    expect(markedHome(d.files[0].content)).toBe('/Users/x/my--home');
  });

  it('the unit Description is the service name; the marker is ASCII only and round-trips any home', () => {
    expect(serviceDefinition(LINUX_HOME, 'omer', LINUX).files[0].content).toContain('Description=Rendezvous listener rdv-listen-omer\n');
    const home = 'C:\\Users\\\u00d6mer \u05e2\u05d5\u05de\u05e8\\.rendezvous\\omer';
    const d = serviceDefinition(home, 'omer', WIN);
    const line = /rdv-home: .*/.exec(d.files[1].content)![0];
    expect(line).toMatch(/^[\x20-\x7e]+$/);
    expect(markedHome(d.files[1].content)).toBe(home);
  });

  it('restarts back off: doubling up to a cap on Windows and systemd', () => {
    const [vbs] = serviceDefinition(WIN_HOME, 'omer', WIN).files;
    expect(vbs.content).toContain('delay = delay * 2: If delay > 300 Then delay = 300');
    expect(vbs.content).toContain('If DateDiff("s", started, Now) >= 600 Then delay = 30');
    expect(vbs.content).toContain('rdv-listen-omer.log');
    const [unit] = serviceDefinition(LINUX_HOME, 'omer', LINUX).files;
    expect(unit.content).toContain('RestartSteps=4');
    expect(unit.content).toContain('RestartMaxDelaySec=300');
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

/**
 * An agent home (profile "omer": the record of what was installed is MACed
 * with its key) and an OS that only records what it is asked. What the OS
 * reports as registered (the task XML, the unit's ExecStart and drop-ins, the
 * LaunchAgent's arguments) is what install gave it, unless a test changes it.
 */
async function machine(platform: 'linux' | 'darwin' | 'win32') {
  const root = rootFor(platform);
  const j = platform === 'win32' ? join : posix.join;
  const home = new Home(j(root, 'home dir', 'omer'));
  mkdirSync(home.dir, { recursive: true });
  await initHome(home, { profile: 'omer', relays: ['ws://127.0.0.1:9'] });
  const node = platform === 'win32' ? process.execPath : '/usr/local/bin/node';
  const env: ServiceEnv = { platform, node, bin: j(root, 'bin.js'), userHome: j(root, 'user home'), uid: 501, systemRoot: 'C:\\Windows', user: 'HOST\\omer' };
  const calls: string[][] = [];
  const tasks = new Map<string, string>();
  const m = {
    home,
    env,
    calls,
    tasks,
    /** linux/darwin: what the OS says it runs (undefined: nothing loaded). */
    registered: undefined as string | undefined,
    dropins: '',
    /** powershell's answer about a pid (L1). */
    process: '',
    fail: undefined as string | undefined,
    run: (_argv: string[]): RunResult => ({ code: 0, stdout: '', stderr: '' }),
  };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  m.run = (argv: string[]): RunResult => {
    calls.push(argv);
    if (m.fail && argv.join(' ').includes(m.fail)) return { code: 1, stdout: '', stderr: 'Access is denied.' };
    if (argv[0] === 'powershell.exe') return ok(m.process);
    if (argv[0] === 'systemctl') {
      if (argv.includes('enable')) m.registered = serviceDefinition(home.dir, 'omer', env).registered;
      if (argv.includes('disable')) m.registered = undefined;
      if (argv.includes('show')) return ok(`ExecStart={ path=/usr/bin/env ; argv[]=${m.registered ?? ''} ; ignore_errors=no ; start_time=[n/a] }\nDropInPaths=${m.dropins}\n`);
      return ok();
    }
    if (argv[0] === 'launchctl') {
      if (argv[1] === 'bootstrap') m.registered = serviceDefinition(home.dir, 'omer', env).registered;
      if (argv[1] === 'bootout') m.registered = undefined;
      if (argv[1] === 'print') return m.registered === undefined ? { code: 113, stdout: '', stderr: 'Could not find service' } : ok(`\tstate = running\n\targuments = {\n${m.registered.split('\n').map((a) => `\t\t${a}`).join('\n')}\n\t}\n`);
      return ok();
    }
    const name = argv[argv.indexOf('/TN') + 1];
    if (argv[1] === '/Create') tasks.set(name, readFileSync(argv[argv.indexOf('/XML') + 1]).toString('utf16le'));
    if (!tasks.has(name)) return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    if (argv[1] === '/Delete') tasks.delete(name);
    if (argv[1] === '/Query') return ok(argv.includes('/XML') ? tasks.get(name) : `"\\${name}","N/A","Ready"`);
    return ok();
  };
  return m;
}

const platforms = (['linux', 'darwin', 'win32'] as const).filter((p) => p !== 'win32' || process.platform === 'win32');

describe('install, status and remove', () => {
  // The Windows definition's files are Windows paths: written only where they mean something.
  it.each(platforms)('%s: installs, reports, refuses another home, removes', async (platform) => {
    const m = await machine(platform);
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    const none = serviceStatus(m.home, 'omer', m.env, m.run);
    expect(none).toMatchObject({ installed: false, ours: false, running: false, listener: null, holds_listener_lock: false });
    // Status is read-only: it only asks.
    expect(m.calls.every((c) => /^(is-active|show|print|\/Query)$/.test(c[0] === 'systemctl' ? c[2] : c[1]))).toBe(true);

    installService(m.home, d, m.run);
    for (const f of d.files) expect(existsSync(f.path)).toBe(true);
    for (const c of d.install) expect(m.calls).toContainEqual(c);
    const st = serviceStatus(m.home, 'omer', m.env, m.run);
    expect(st).toMatchObject({ installed: true, ours: true, current: true, tampered: false, state: 'current', installed_home: m.home.dir, name: 'rdv-listen-omer', profile: 'omer', home: m.home.dir });

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

    // This version would install another node now: the installed one is older, not changed.
    const newer = { ...m.env, node: `${m.env.node}-new` };
    expect(serviceDefinition(m.home.dir, 'omer', newer).digest).not.toBe(d.digest);
    expect(serviceStatus(m.home, 'omer', newer, m.run)).toMatchObject({ ours: true, current: false, tampered: false, state: 'older' });

    m.calls.length = 0;
    expect(removeService(m.home, d, m.run)).toBe(true);
    for (const c of d.remove) expect(m.calls).toContainEqual(c);
    for (const f of d.files) expect(existsSync(f.path)).toBe(false);
    expect(serviceStatus(m.home, 'omer', m.env, m.run).installed).toBe(false);
    expect(removeService(m.home, d, m.run)).toBe(false);
  });

  it('a unit that is not ours (no marker) is never replaced', async () => {
    const m = await machine('linux');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    mkdirSync(join(d.files[0].path, '..'), { recursive: true });
    writeFileSync(d.files[0].path, '[Service]\nExecStart=/bin/true\n');
    expect(() => installService(m.home, d, m.run)).toThrow(/not made by rdv service install/);
    expect(readFileSync(d.files[0].path, 'utf8')).toContain('/bin/true');
  });

  it('a failed OS command is reported with its own words', async () => {
    const m = await machine('linux');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    const failing = (argv: string[]): RunResult => (argv.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' } : { code: 0, stdout: '', stderr: '' });
    expect(() => installService(m.home, d, failing)).toThrow(/enable --now rdv-listen-omer.service" failed \(exit 1\): Failed to connect to bus/);
  });

  // M3: a failure after the first OS command undoes everything.
  it.each(platforms)('%s: a partial install is undone, never left registered', async (platform) => {
    const m = await machine(platform);
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    m.fail = d.install[d.install.length - 1].join(' ');
    expect(() => installService(m.home, d, m.run)).toThrow(/Nothing was left installed/);
    for (const c of d.remove) expect(m.calls).toContainEqual(c);
    for (const f of d.files) expect(existsSync(f.path)).toBe(false);
    m.fail = undefined;
    expect(serviceStatus(m.home, 'omer', m.env, m.run)).toMatchObject({ installed: false, state: 'not-installed' });
    expect(m.tasks.size).toBe(0);
  });

  // M1: changed outside Rendezvous is told apart from an older version.
  it.each(platforms)('%s: a definition changed after install is reported as tampered', async (platform) => {
    const m = await machine(platform);
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    installService(m.home, d, m.run);
    const status = () => serviceStatus(m.home, 'omer', m.env, m.run);
    expect(status().tampered).toBe(false);
    // The file is edited to pass a gate.
    const f = d.files[0];
    const edited = f.content.includes('listen --service')
      ? f.content.replace('listen --service', 'listen --auto-grant friend --service')
      : f.content.replace('<string>listen</string>', '<string>listen</string><string>--auto-grant</string><string>friend</string>');
    writeFileSync(f.path, f.encoding === 'utf16le' ? Buffer.from(`\uFEFF${edited}`, 'utf16le') : edited);
    const t = status();
    expect(t).toMatchObject({ tampered: true, current: false, state: 'tampered' });
    expect(t.tamper_reasons.join('\n')).toContain(`${f.path} was changed`);
    expect(t.tamper_reasons.join('\n')).toContain('it runs with --auto-grant');
    // Installing again puts it back, and the record with it.
    installService(m.home, d, m.run);
    expect(status()).toMatchObject({ tampered: false, state: 'current' });
    // What the OS runs is changed (schtasks /Change, a unit edited and reloaded, a plist reloaded).
    if (platform === 'win32') m.tasks.set(d.name, m.tasks.get(d.name)!.replace('//B //Nologo', '//B //Nologo C:\\evil.vbs'));
    else m.registered = `${m.registered!} --exec /tmp/x`;
    expect(status().tamper_reasons.join('\n')).toMatch(/what the OS runs is not what was installed/);
    installService(m.home, d, m.run);
    expect(status().tampered).toBe(false);
    // The record itself is edited (its MAC no longer holds).
    const rec = join(m.home.dir, 'service', `${d.name}.json`);
    writeFileSync(rec, readFileSync(rec, 'utf8').replace(/"digest": "[0-9a-f]+"/, `"digest": "${'0'.repeat(64)}"`));
    expect(status().tamper_reasons).toContain('the record of what was installed was changed');
    rmSync(rec);
    expect(status().tamper_reasons).toContain('there is no record of what was installed');
  });

  it('linux: a drop-in or a second ExecStart is reported as tampered', async () => {
    const m = await machine('linux');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    installService(m.home, d, m.run);
    m.dropins = '/home/u/.config/systemd/user/rdv-listen-omer.service.d/override.conf';
    expect(serviceStatus(m.home, 'omer', m.env, m.run).tamper_reasons.join('\n')).toContain('a drop-in changes the unit');
  });

  it.skipIf(process.platform !== 'win32')('win32: whose task it is comes from the registered task only; reinstall stops the old one first; remove stops only a verified listener', async () => {
    const m = await machine('win32');
    const d = serviceDefinition(m.home.dir, 'omer', m.env);
    installService(m.home, d, m.run);
    // L2: a task without our marker is not ours, even with our script in the home.
    const xml = m.tasks.get(d.name)!;
    m.tasks.set(d.name, xml.replace(/rdv-home: [^<]*/, ''));
    expect(serviceStatus(m.home, 'omer', m.env, m.run)).toMatchObject({ installed: true, ours: false, state: 'other-home' });
    m.tasks.set(d.name, xml);
    // Reinstall: /End before /Create, so the old script does not keep running the old command.
    m.calls.length = 0;
    installService(m.home, serviceDefinition(m.home.dir, 'omer', { ...m.env, node: `${m.env.node}x` }), m.run);
    const end = m.calls.findIndex((c) => c[1] === '/End');
    const create = m.calls.findIndex((c) => c[1] === '/Create');
    expect(end).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThan(create);
    // L1: the pid in listener.lock is stopped only when it is node running --service <name>.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      writeFileSync(m.home.listenerLockPath, JSON.stringify({ pid: child.pid, host: hostname(), since: '2026-10-27T00:00:00Z', role: serviceRole(d.name) }));
      m.process = `node.exe\r\n"node" something-else.js`;
      const d2 = serviceDefinition(m.home.dir, 'omer', { ...m.env, node: `${m.env.node}x` });
      removeService(m.home, d2, m.run);
      await new Promise((r) => setTimeout(r, 300));
      expect(child.exitCode === null && child.signalCode === null).toBe(true);
      installService(m.home, d2, m.run);
      writeFileSync(m.home.listenerLockPath, JSON.stringify({ pid: child.pid, host: hostname(), since: '2026-10-27T00:00:00Z', role: serviceRole(d.name) }));
      m.process = `node.exe\r\n"node" bin.js listen --service ${d.name} --home x`;
      removeService(m.home, d2, m.run);
      for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await new Promise((r) => setTimeout(r, 50));
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      child.kill();
    }
  });
});

describe('profile names (H1 of the PR #117 review)', () => {
  it('initHome and a restored backup refuse a profile outside the profile alphabet', async () => {
    const home = new Home(join(tmp(), 'omer'));
    await expect(initHome(home, { profile: 'x)\nExecStartPre=/bin/sh', relays: ['ws://127.0.0.1:9'] })).rejects.toThrow(/invalid profile name/);
    await initHome(home, { profile: 'omer', relays: ['ws://127.0.0.1:9'] });
    home.writeConfig({ ...home.readConfig(), profile: 'x)\nExecStartPre=/bin/sh -c id' });
    const bundle = await createBackup(home, 'a long backup passphrase 42');
    const file = writeBackupFile(home, join(tmp(), 'b.rdvbackup'), bundle);
    const { bytes } = readBackupFile(home, file);
    await expect(restoreBackup(new Home(join(tmp(), 'fresh')), bytes, 'a long backup passphrase 42')).rejects.toThrow(/config/);
    // An existing home with such a profile: the service refuses, and says why.
    expect(() => homeService(home, LINUX)).toThrow(/cannot name a background service/);
  });
});

describe('rdv listen --service checks its own command line', () => {
  it('only exactly listen --service <name> --home <home> for this profile', async () => {
    const home = new Home(join(tmp(), 'omer'));
    await initHome(home, { profile: 'omer', relays: ['ws://127.0.0.1:9'] });
    expect(() => checkServiceArgv(home, 'rdv-listen-omer', ['listen', '--service', 'rdv-listen-omer', '--home', home.dir])).not.toThrow();
    for (const args of [
      ['listen', '--service', 'rdv-listen-omer', '--home', home.dir, '--auto-grant', 'friend'],
      ['listen', '--auto-confirm', '--service', 'rdv-listen-omer', '--home', home.dir],
      ['listen', '--service', 'rdv-listen-other', '--home', home.dir],
      ['listen', '--service', 'rdv-listen-omer', '--home', `${home.dir}-x`],
      ['listen', '--service', 'rdv-listen-omer'],
    ]) {
      expect(() => checkServiceArgv(home, args[2] === 'rdv-listen-other' ? 'rdv-listen-other' : 'rdv-listen-omer', args), args.join(' ')).toThrow(/not the command line/);
    }
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
