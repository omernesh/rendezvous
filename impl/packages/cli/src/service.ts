// The background listener (issue #102 item 6, NOTES 100): `rdv listen` for one
// home, started by the OS at the user's login so the agent stays reachable
// while no chat client or terminal is open.
//
//   Windows  a scheduled task (logon trigger, this user only, least privilege)
//            whose action is `wscript.exe //B //Nologo <home>\service\listen.vbs`:
//            the script starts node hidden (window style 0), so no console
//            ever flashes, and starts it again when it stops with an error
//   macOS    a LaunchAgent, ~/Library/LaunchAgents/rdv-listen-<profile>.plist
//            (RunAtLoad, KeepAlive)
//   Linux    a systemd user unit, ~/.config/systemd/user/rdv-listen-<profile>.service
//            (Restart=on-failure), enabled with `systemctl --user enable --now`
//
// What runs is always `<node> <rdv bin.js> listen --service <name> --home <home>`
// with absolute paths (no PATH lookup) and a scrubbed environment: `env -i` on
// macOS and Linux, an allow-list of Windows' own variables in the script.
// It never carries a flag that passes a gate (--auto-grant, --auto-confirm,
// --exec, --negotiate): approvals still wait for the human, as with any listener.
//
// The definition is a pure function of the platform, the paths and the
// profile (serviceDefinition), so it is tested for every OS on any OS; the
// side effects (files, the OS's own commands) go through an injected runner.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './commands.js';
import { longLockHolder } from './fsutil.js';
import { CliError, type Home } from './home.js';

export type ServicePlatform = 'win32' | 'darwin' | 'linux';

/** Where the definition is generated for: the OS, the absolute paths it runs, and the user it runs as. */
export interface ServiceEnv {
  platform: ServicePlatform;
  /** Absolute path of the node that runs rdv (the installed one: process.execPath). */
  node: string;
  /** Absolute path of the rdv CLI entry (dist/src/bin.js). */
  bin: string;
  /** The user's home directory (where ~/Library/LaunchAgents and ~/.config/systemd/user are). */
  userHome: string;
  /** Windows: %SystemRoot% (wscript.exe lives in its System32). */
  systemRoot?: string;
  /** Windows: the account the logon trigger and the task run as (DOMAIN\user). */
  user?: string;
  /** macOS: the user's uid (the gui/<uid> launchd domain). */
  uid?: number;
}

export interface ServiceFile {
  path: string;
  content: string;
  /** utf16le files are written with a BOM (what wscript and schtasks read Unicode from). */
  encoding: 'utf8' | 'utf16le';
}

export interface ServiceDefinition {
  platform: ServicePlatform;
  /** rdv-listen-<profile>: the task, launchd label and unit name. Unique per profile. */
  name: string;
  profile: string;
  home: string;
  /** What runs in the end: node, the rdv bin, and its arguments. */
  argv: string[];
  /** argv quoted for the platform: the exact command line the approval form shows. */
  commandLine: string;
  /** What the OS starts: wscript and the script (Windows), env -i and argv (macOS, Linux). */
  launcher: string[];
  launcherLine: string;
  /** In words: "a Windows scheduled task" … */
  kind: string;
  /** Where it is registered: the task name, the plist or the unit file. */
  location: string;
  files: ServiceFile[];
  /** The OS commands that register and start it, in order. */
  install: string[][];
  /** The OS commands that stop and unregister it (each may fail: it is gone already). */
  remove: string[][];
  /** sha256 over everything above: what an approval is bound to. */
  digest: string;
}

/** The flags that pass a human gate: the service never runs with any of them (issue #102). */
export const GATE_FLAGS = ['--auto-grant', '--auto-grant-any-tier', '--auto-confirm', '--exec', '--negotiate', '--calendar'];

export const SERVICE_NAME_RE = /^rdv-listen-[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** listener.lock's role while the service holds it, so status can tell it from a terminal's `rdv listen`. */
export const serviceRole = (name: string): string => `rdv service ${name}`;
/** How long the Windows script waits before it starts `rdv listen` again after it stopped with an error. */
export const RESTART_SECONDS = 30;

/** rdv-listen-<profile>, from the home's profile (characters outside the profile alphabet become "-"). */
export function serviceName(profile: string): string {
  const p = profile.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return `rdv-listen-${p || 'default'}`;
}

// --- quoting ------------------------------------------------------------------

function refuseControl(arg: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(arg)) throw new CliError(`a path for the service has a control character in it: ${JSON.stringify(arg)}`);
}

/** One Windows command-line argument, as CommandLineToArgvW reads it back. Paths are always quoted. */
export function quoteWin(arg: string, always = false): string {
  refuseControl(arg);
  if (arg.includes('"')) throw new CliError(`a path for the service has a double quote in it: ${arg}`);
  if (!always && arg !== '' && !/[\s]/.test(arg)) return arg;
  // Backslashes before the closing quote are doubled, so the quote stays a quote.
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

/** One POSIX shell word (for the form and docs; the OS itself gets an argv). */
export function quoteSh(arg: string): string {
  refuseControl(arg);
  return arg !== '' && /^[A-Za-z0-9_./:=+@%,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** One systemd ExecStart word: quoted, with \ " escaped and % $ doubled (specifiers and variables expand otherwise). */
export function quoteSystemd(arg: string): string {
  refuseControl(arg);
  const escaped = arg.replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /^[A-Za-z0-9_./:=+@,-]+$/.test(arg) ? escaped : `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const vbsString = (s: string): string => `"${s.replace(/"/g, '""')}"`;
/** The home a definition was made for, in a comment line any of our files can carry ("-" escaped, so it never ends an XML comment). */
const marker = (home: string): string => `rdv-home: ${JSON.stringify(home).replace(/-/g, '\\u002d')}`;

/** The home named by a definition's marker (rdv-home: "…"), or null. */
export function markedHome(text: string): string | null {
  const m = /rdv-home: ("(?:[^"\\]|\\.)*")/.exec(text.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

// --- the definition -----------------------------------------------------------

/** The Windows variables the hidden script keeps for node (everything else the logon session has is dropped). */
const WIN_KEEP = ['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'COMPUTERNAME', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'PATHEXT', 'COMSPEC', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

/**
 * The service for one home, as files and OS commands (pure: nothing is read
 * or written). Throws a CliError when a path cannot be put into the
 * definition safely (relative, or with a quote or control character).
 */
export function serviceDefinition(homeDir: string, profile: string, env: ServiceEnv): ServiceDefinition {
  const p = env.platform === 'win32' ? win32 : posix;
  for (const [what, v] of [['node', env.node], ['the rdv entry point', env.bin], ['the home', homeDir], ['the user home', env.userHome]] as const) {
    if (!p.isAbsolute(v)) throw new CliError(`${what} must be an absolute path for the service (got ${v})`);
    refuseControl(v);
  }
  const name = serviceName(profile);
  const argv = [env.node, env.bin, 'listen', '--service', name, '--home', homeDir];
  const head = `Rendezvous: keeps profile ${JSON.stringify(profile)} reachable (rdv listen). Made by "rdv service install"; "rdv service remove" deletes it.`;
  let d: Omit<ServiceDefinition, 'digest'>;
  if (env.platform === 'win32') {
    const root = env.systemRoot ?? 'C:\\Windows';
    if (!win32.isAbsolute(root)) throw new CliError(`SystemRoot must be an absolute path (got ${root})`);
    const user = env.user;
    if (!user || /["<>&\u0000-\u001f]/.test(user)) throw new CliError('the Windows account the service runs as is unknown');
    const commandLine = [quoteWin(env.node, true), quoteWin(env.bin, true), 'listen', '--service', name, '--home', quoteWin(homeDir, true)].join(' ');
    const dir = win32.join(homeDir, 'service');
    const vbsPath = win32.join(dir, `${name}.vbs`);
    const xmlPath = win32.join(dir, `${name}.xml`);
    const wscript = win32.join(root, 'System32', 'wscript.exe');
    const launcher = [wscript, '//B', '//Nologo', vbsPath];
    const launcherArgs = ['//B', '//Nologo', quoteWin(vbsPath, true)].join(' ');
    const vbs = [
      `' ${head}`,
      `' ${marker(homeDir)}`,
      "' Runs the command below hidden (window style 0: no console), with only Windows' own variables, and again",
      `' ${RESTART_SECONDS} s after it stops with an error, while this file exists.`,
      'Option Explicit',
      'Dim sh, fso, env, item, k, keep, names, i, cmd, rc',
      'Set sh = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set env = sh.Environment("Process")',
      `keep = "|${WIN_KEEP.join('|')}|"`,
      'names = Array()',
      'For Each item In env',
      '  k = InStr(2, item, "=")',
      '  If k > 1 Then',
      '    If InStr(keep, "|" & UCase(Left(item, k - 1)) & "|") = 0 Then',
      '      ReDim Preserve names(UBound(names) + 1)',
      '      names(UBound(names)) = Left(item, k - 1)',
      '    End If',
      '  End If',
      'Next',
      'For i = 0 To UBound(names)',
      '  env.Remove names(i)',
      'Next',
      `env("PATH") = ${vbsString(`${win32.join(root, 'System32')};${root}`)}`,
      `cmd = ${vbsString(commandLine)}`,
      'Do',
      '  rc = sh.Run(cmd, 0, True)',
      '  If rc = 0 Or Not fso.FileExists(WScript.ScriptFullName) Then Exit Do',
      `  WScript.Sleep ${RESTART_SECONDS * 1000}`,
      '  If Not fso.FileExists(WScript.ScriptFullName) Then Exit Do',
      'Loop',
      '',
    ].join('\r\n');
    const task = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      `    <Description>${xml(`${head} ${marker(homeDir)}`)}</Description>`,
      `    <URI>\\${xml(name)}</URI>`,
      '  </RegistrationInfo>',
      '  <Triggers>',
      '    <LogonTrigger>',
      '      <Enabled>true</Enabled>',
      `      <UserId>${xml(user)}</UserId>`,
      '    </LogonTrigger>',
      '  </Triggers>',
      '  <Principals>',
      '    <Principal id="Author">',
      `      <UserId>${xml(user)}</UserId>`,
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <AllowHardTerminate>true</AllowHardTerminate>',
      '    <StartWhenAvailable>true</StartWhenAvailable>',
      '    <AllowStartOnDemand>true</AllowStartOnDemand>',
      '    <Enabled>true</Enabled>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <RestartOnFailure>',
      '      <Interval>PT1M</Interval>',
      '      <Count>3</Count>',
      '    </RestartOnFailure>',
      '  </Settings>',
      '  <Actions Context="Author">',
      '    <Exec>',
      `      <Command>${xml(wscript)}</Command>`,
      `      <Arguments>${xml(launcherArgs)}</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      '',
    ].join('\r\n');
    d = {
      platform: 'win32',
      name,
      profile,
      home: homeDir,
      argv,
      commandLine,
      launcher,
      launcherLine: `${quoteWin(wscript, true)} ${launcherArgs}`,
      kind: `a Windows scheduled task "${name}" that starts at your logon through a hidden launcher (wscript.exe and a small script in the agent's home), so no window opens`,
      location: `Task Scheduler: \\${name}`,
      files: [
        { path: vbsPath, content: vbs, encoding: 'utf16le' },
        { path: xmlPath, content: task, encoding: 'utf16le' },
      ],
      install: [
        ['schtasks', '/Create', '/TN', name, '/XML', xmlPath, '/F'],
        ['schtasks', '/Run', '/TN', name],
      ],
      remove: [
        ['schtasks', '/End', '/TN', name],
        ['schtasks', '/Delete', '/TN', name, '/F'],
      ],
    };
  } else {
    const launcher = ['/usr/bin/env', '-i', `HOME=${env.userHome}`, 'PATH=/usr/bin:/bin', ...argv];
    const commandLine = argv.map(quoteSh).join(' ');
    const launcherLine = launcher.map(quoteSh).join(' ');
    if (env.platform === 'darwin') {
      if (typeof env.uid !== 'number') throw new CliError('the uid the LaunchAgent runs as is unknown');
      const plist = posix.join(env.userHome, 'Library', 'LaunchAgents', `${name}.plist`);
      const log = posix.join(homeDir, 'service', `${name}.log`);
      const content = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        `<!-- ${xml(head)} -->`,
        `<!-- ${xml(marker(homeDir))} -->`,
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  <string>${xml(name)}</string>`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...launcher.map((a) => `    <string>${xml(a)}</string>`),
        '  </array>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <true/>',
        '  <key>ThrottleInterval</key>',
        `  <integer>${RESTART_SECONDS}</integer>`,
        '  <key>ProcessType</key>',
        '  <string>Background</string>',
        '  <key>StandardOutPath</key>',
        '  <string>/dev/null</string>',
        '  <key>StandardErrorPath</key>',
        `  <string>${xml(log)}</string>`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n');
      const domain = `gui/${env.uid}`;
      d = {
        platform: 'darwin',
        name,
        profile,
        home: homeDir,
        argv,
        commandLine,
        launcher,
        launcherLine,
        kind: `a macOS LaunchAgent "${name}" that launchd starts at your login and keeps running`,
        location: plist,
        files: [{ path: plist, content, encoding: 'utf8' }],
        install: [
          ['launchctl', 'bootout', `${domain}/${name}`],
          ['launchctl', 'bootstrap', domain, plist],
        ],
        remove: [['launchctl', 'bootout', `${domain}/${name}`]],
      };
    } else {
      const unit = posix.join(env.userHome, '.config', 'systemd', 'user', `${name}.service`);
      const content = [
        `# ${head}`,
        `# ${marker(homeDir)}`,
        '[Unit]',
        `Description=Rendezvous listener (profile ${profile.replace(/[%$\\]/g, '-')})`,
        'StartLimitIntervalSec=0',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${launcher.map(quoteSystemd).join(' ')}`,
        'Restart=on-failure',
        `RestartSec=${RESTART_SECONDS}`,
        'NoNewPrivileges=true',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n');
      d = {
        platform: 'linux',
        name,
        profile,
        home: homeDir,
        argv,
        commandLine,
        launcher,
        launcherLine,
        kind: `a systemd user service "${name}" that starts when you log in and restarts if it fails`,
        location: unit,
        files: [{ path: unit, content, encoding: 'utf8' }],
        install: [
          ['systemctl', '--user', 'daemon-reload'],
          ['systemctl', '--user', 'enable', '--now', `${name}.service`],
        ],
        // Then the unit file is deleted and systemd reloaded (removeService).
        remove: [['systemctl', '--user', 'disable', '--now', `${name}.service`]],
      };
    }
  }
  for (const a of d.argv) if (GATE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) throw new Error(`the service would run with ${a}`);
  const digest = createHash('sha256').update(`rdv1/service\u0000${JSON.stringify(d)}`).digest('hex');
  return { ...d, digest };
}

/** The definition's own file a status reads back (the script on Windows, the plist or the unit elsewhere). */
const mainFile = (d: ServiceDefinition): ServiceFile => d.files[0];

/** This process's platform, node and rdv entry point. Throws on an OS without a supported service manager. */
export function defaultServiceEnv(): ServiceEnv {
  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') throw new CliError(`a background service is not supported on ${platform}: run "rdv listen" yourself`);
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USERNAME ?? '';
    }
  })();
  return {
    platform,
    node: process.execPath,
    bin: fileURLToPath(new URL('./bin.js', import.meta.url)),
    userHome: homedir(),
    ...(platform === 'win32' ? { systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', user: process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user } : {}),
    ...(platform === 'darwin' && typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
  };
}

// --- running it ---------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs an OS command (argv, no shell, never a window). Injected in tests, so nothing is registered there. */
export type ServiceRunner = (argv: string[]) => RunResult;

export const spawnRunner: ServiceRunner = (argv) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : '') };
};

export interface ServiceStatus {
  platform: ServicePlatform;
  name: string;
  profile: string;
  /** This home. */
  home: string;
  location: string;
  installed: boolean;
  /** The home the installed service runs for (null: not installed, or not one of ours). */
  installed_home: string | null;
  /** Installed for this home. */
  ours: boolean;
  /** Installed exactly as this version would install it now (same node, rdv entry point and definition). */
  current: boolean;
  /** Whether the OS says it is running (null: it cannot tell). */
  running: boolean | null;
  /** Who holds this home's listener.lock now. */
  listener: { holder: string; pid: number; host: string; since: string } | null;
  /** The service itself holds listener.lock. */
  holds_listener_lock: boolean;
}

/** The OS's view of the installed service: whether it exists, the text to check, and whether it runs. */
function inspect(d: ServiceDefinition, run: ServiceRunner): { installed: boolean; text: string; running: boolean | null } {
  const file = mainFile(d);
  const onDisk = existsSync(file.path) ? readText(file) : '';
  if (d.platform === 'win32') {
    const q = run(['schtasks', '/Query', '/TN', d.name, '/XML']);
    if (q.code !== 0) return { installed: false, text: '', running: null };
    const csv = run(['schtasks', '/Query', '/TN', d.name, '/FO', 'CSV', '/NH']);
    const state = csv.code === 0 ? (csv.stdout.trim().split(/\r?\n/).pop() ?? '').split('","').pop()?.replace(/"$/, '') : undefined;
    // The task's XML names the home; the script must be the one this version writes.
    return { installed: true, text: `${q.stdout}\n${onDisk}`, running: state === undefined ? null : /running/i.test(state) };
  }
  if (!onDisk) return { installed: false, text: '', running: null };
  if (d.platform === 'darwin') {
    const p = run(['launchctl', 'print', d.remove[0][2]]);
    return { installed: true, text: onDisk, running: p.code === 0 ? /\bstate = running\b/.test(p.stdout) : false };
  }
  const a = run(['systemctl', '--user', 'is-active', `${d.name}.service`]);
  return { installed: true, text: onDisk, running: a.stdout.trim() === 'active' };
}

function readText(f: ServiceFile): string {
  const buf = readFileSync(f.path);
  if (f.encoding === 'utf16le') return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8');
}

function writeText(f: ServiceFile): void {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.encoding === 'utf16le' ? Buffer.from(`\uFEFF${f.content}`, 'utf16le') : f.content, { mode: 0o644 });
}

/** The service for this home: installed or not, running or not, and who holds listener.lock (read-only). */
export function serviceStatus(home: Home, profile: string, env: ServiceEnv, run: ServiceRunner = spawnRunner): ServiceStatus {
  const d = serviceDefinition(home.dir, profile, env);
  const seen = inspect(d, run);
  const installedHome = seen.installed ? markedHome(seen.text) : null;
  const ours = installedHome !== null && samePath(installedHome, home.dir, d.platform);
  const file = mainFile(d);
  const current = ours && existsSync(file.path) && readText(file) === file.content;
  const holder = longLockHolder(home.listenerLockPath);
  return {
    platform: d.platform,
    name: d.name,
    profile,
    home: home.dir,
    location: d.location,
    installed: seen.installed,
    installed_home: installedHome,
    ours,
    current,
    running: seen.installed ? seen.running : false,
    listener: holder ? { holder: holder.role ?? 'unknown', pid: holder.pid, host: holder.host, since: holder.since } : null,
    holds_listener_lock: holder?.role === serviceRole(d.name),
  };
}

const samePath = (a: string, b: string, platform: ServicePlatform): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A failed OS command, as one line for the human (stderr trimmed). */
function failed(argv: string[], r: RunResult): CliError {
  const why = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 3).join(' ').slice(0, 300);
  return new CliError(`"${argv.join(' ')}" failed (exit ${r.code})${why ? `: ${why}` : ''}`);
}

/**
 * Write the definition's files and register and start it. Replaces an older
 * definition of ours; refuses one installed for another home.
 */
export function installService(home: Home, d: ServiceDefinition, run: ServiceRunner = spawnRunner): void {
  const before = inspect(d, run);
  if (before.installed) {
    const other = markedHome(before.text);
    if (other === null || !samePath(other, home.dir, d.platform)) throw notOurs(d, other);
  }
  for (const f of d.files) writeText(f);
  for (const [i, argv] of d.install.entries()) {
    const r = run(argv);
    // bootout of a LaunchAgent that is not loaded fails: that is the point of running it first.
    if (r.code !== 0 && !(d.platform === 'darwin' && i === 0)) throw failed(argv, r);
  }
  // A systemd unit that was running the older definition: start it again on the new one.
  if (d.platform === 'linux' && before.installed) {
    const r = run(['systemctl', '--user', 'restart', `${d.name}.service`]);
    if (r.code !== 0) throw failed(['systemctl', '--user', 'restart', `${d.name}.service`], r);
  }
}

const notOurs = (d: ServiceDefinition, other: string | null): CliError =>
  new CliError(
    `${d.location} is already installed ${other ? `for another home (${other})` : 'and was not made by rdv service install'}. ` +
      'Nothing was changed: remove it from that home first, or use another profile name.',
  );

/**
 * Stop and unregister this home's service and delete its files. Returns
 * whether one was installed. Refuses a service of the same name installed for
 * another home. On Windows, a listener the service started that is still
 * running afterwards (it holds listener.lock under the service's role) is
 * stopped too.
 */
export function removeService(home: Home, d: ServiceDefinition, run: ServiceRunner = spawnRunner): boolean {
  const before = inspect(d, run);
  if (before.installed) {
    const other = markedHome(before.text);
    if (other === null || !samePath(other, home.dir, d.platform)) throw notOurs(d, other);
  }
  // Windows: the files first, so the script stops starting the listener again once its own file is gone.
  if (d.platform === 'win32') for (const f of d.files) rmSync(f.path, { force: true });
  if (!before.installed) {
    for (const f of d.files) rmSync(f.path, { force: true });
    return false;
  }
  for (const [i, argv] of d.remove.entries()) {
    const r = run(argv);
    // Ending a task that is not running, or stopping what is stopped already, fails harmlessly; deleting the task must work.
    if (r.code !== 0 && d.platform === 'win32' && i === 1) throw failed(argv, r);
  }
  for (const f of d.files) rmSync(f.path, { force: true });
  if (d.platform === 'linux') run(['systemctl', '--user', 'daemon-reload']);
  if (d.platform === 'win32') {
    const h = longLockHolder(home.listenerLockPath);
    if (h?.here && h.role === serviceRole(d.name)) {
      try {
        process.kill(h.pid);
      } catch {
        // gone already
      }
    }
  }
  if (inspect(d, run).installed) throw new CliError(`${d.location} is still registered after removing it`);
  return true;
}

/** Wait up to `ms` for the service to hold listener.lock. */
export async function waitForService(home: Home, name: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (longLockHolder(home.listenerLockPath)?.role === serviceRole(name)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The service's description for a form or the terminal: what, the command line, profile, home, when, how to remove it. */
export function describeService(d: ServiceDefinition, opts: { removeHint: string }): string {
  return [
    `  What:      ${d.kind}`,
    `  Where:     ${d.location}`,
    ...(d.platform === 'win32' ? [`  Starts:    ${d.launcherLine}`, `  Which runs (hidden): ${d.commandLine}`] : [`  Runs:      ${d.launcherLine}`]),
    `  Profile:   ${d.profile}`,
    `  Home:      ${d.home}`,
    `  Files:     ${d.files.map((f) => f.path).join(', ')}`,
    `  When:      at every login of this user, as you, with your user's privileges only (no administrator rights); started again if it stops with an error`,
    `  Remove it: ${opts.removeHint}`,
  ].join('\n');
}

/** The service's name and definition for this home (its profile from config.json). */
export function homeService(home: Home, env: ServiceEnv = defaultServiceEnv()): ServiceDefinition {
  return serviceDefinition(home.dir, home.readConfig().profile, env);
}

/** The README line for Linux: a user unit runs only while the user is logged in, unless lingering is on. */
export const LINGER_NOTE = 'On Linux, a user service runs only while you are logged in; to keep it running after you log out, run "loginctl enable-linger" yourself once.';

// --- rdv service install | remove | status ---------------------------------------

/** The terminal's way to remove it (what forms and results name). */
export const removeCommand = (home: Home): string => `rdv service remove --home "${home.dir}"`;

function statusText(s: ServiceStatus): string {
  const lock = s.listener ? `${s.listener.holder} (pid ${s.listener.pid} on ${s.listener.host}, since ${s.listener.since})` : 'nobody';
  return [
    `${s.name}: ${s.installed ? (s.ours ? `installed (${s.location})${s.current ? '' : ', an older definition: "rdv service install" replaces it'}` : `installed for another home (${s.installed_home ?? 'unknown'})`) : 'not installed'}`,
    `  running:       ${s.running === null ? 'unknown' : s.running ? 'yes' : 'no'}`,
    `  profile, home: ${s.profile}, ${s.home}`,
    `  listener.lock: ${lock}${s.holds_listener_lock ? ' (the service)' : ''}`,
  ].join('\n');
}

export async function serviceStatusCmd({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const s = serviceStatus(home, home.readConfig().profile, defaultServiceEnv());
  out.emit(s, statusText(s));
}

export async function serviceInstallCmd({ home, out, values }: Ctx): Promise<void> {
  home.requireInit();
  const env = defaultServiceEnv();
  const d = homeService(home, env);
  const text = describeService(d, { removeHint: removeCommand(home) });
  if (values['dry-run'] === true) {
    out.emit(
      { name: d.name, platform: d.platform, command_line: d.commandLine, launcher: d.launcher, files: d.files.map((f) => ({ path: f.path, content: f.content })), install: d.install },
      `Would install:\n${text}\n\n${d.files.map((f) => `--- ${f.path}\n${f.content}`).join('\n')}`,
    );
    return;
  }
  const before = serviceStatus(home, d.profile, env);
  if (before.installed && before.ours && before.current) {
    out.emit({ ...before, changed: false }, `${d.name} is installed already, as this version would install it.\n${statusText(before)}`);
    return;
  }
  installService(home, d);
  const holds = await waitForService(home, d.name, 10_000);
  const after = serviceStatus(home, d.profile, env);
  const holder = after.listener && !after.holds_listener_lock ? after.listener.holder : undefined;
  out.emit(
    { ...after, changed: true },
    `Installed ${d.name}:\n${text}\n\n` +
      (holds
        ? 'It is running and receives for this agent now.'
        : holder
          ? `${holder} receives for this agent now; the service takes over within ${RESTART_SECONDS} s of it stopping.`
          : 'It is starting.') +
      (d.platform === 'linux' ? `\n${LINGER_NOTE}` : ''),
  );
}

export async function serviceRemoveCmd({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const d = homeService(home);
  const removed = removeService(home, d);
  out.emit({ removed, name: d.name }, removed ? `Removed ${d.name}: it no longer starts at login.` : `${d.name} was not installed; nothing changed.`);
}
