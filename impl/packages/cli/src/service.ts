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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './commands.js';
import { longLockHolder } from './fsutil.js';
import { b64decode } from '@rendezvous/core';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CliError, type Home, PROFILE_RE } from './home.js';

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
  /**
   * What the OS has registered, as status reads it back (registeredOf): the
   * task's command and arguments, the unit's ExecStart argv, the LaunchAgent's
   * arguments. Anything else there was changed outside Rendezvous.
   */
  registered: string;
  /** sha256 over everything above: what an approval is bound to. */
  digest: string;
}

/** The flags that pass a human gate: the service never runs with any of them (issue #102). */
export const GATE_FLAGS = ['--auto-grant', '--auto-grant-any-tier', '--auto-confirm', '--exec', '--negotiate', '--calendar'];

export const SERVICE_NAME_RE = /^rdv-listen-[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** listener.lock's role while the service holds it, so status can tell it from a terminal's `rdv listen`. */
export const serviceRole = (name: string): string => `rdv service ${name}`;
/** How long the service waits before it starts `rdv listen` again after it stopped with an error (then twice that, up to RESTART_MAX_SECONDS). */
export const RESTART_SECONDS = 30;
/** The longest wait between restarts (Windows script, systemd); a run of 10 minutes or more starts the backoff over. */
export const RESTART_MAX_SECONDS = 300;

/**
 * rdv-listen-<profile>. A profile outside PROFILE_RE is refused, never
 * cleaned up (security review of PR #117: a newline in it would have become
 * a systemd directive).
 */
export function serviceName(profile: string): string {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new CliError(
      `this agent's profile name ${JSON.stringify(profile)} cannot name a background service (letters, digits, ".", "_" and "-" only). ` +
        'Nothing was installed. Make the agent again under a plain profile name (rdv init --force --profile <name>), or run "rdv listen" yourself.',
    );
  }
  return `rdv-listen-${profile}`;
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
/**
 * The home a definition was made for, in a comment line any of our files can
 * carry: ASCII only (anything else as \uXXXX, so no code page or XML round
 * trip changes it), and "-" escaped, so it never ends an XML comment.
 */
const marker = (home: string): string =>
  `rdv-home: ${JSON.stringify(home).replace(/[^\x20-\x2c\x2e-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
/** Text for an XML comment: no "--" in it. */
const xmlComment = (s: string): string => xml(s).replace(/-(?=-)/g, '- ');

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
  const name = serviceName(profile); // first: a profile that cannot name a service says so, whatever else is wrong
  const p = env.platform === 'win32' ? win32 : posix;
  for (const [what, v] of [['node', env.node], ['the rdv entry point', env.bin], ['the home', homeDir], ['the user home', env.userHome]] as const) {
    if (!p.isAbsolute(v)) throw new CliError(`${what} must be an absolute path for the service (got ${v})`);
    refuseControl(v);
  }
  const argv = [env.node, env.bin, 'listen', '--service', name, '--home', homeDir];
  const head = `Rendezvous: ${name} keeps this agent reachable (rdv listen). Made by "rdv service install"; "rdv service remove" deletes it.`;
  let d: Omit<ServiceDefinition, 'digest'>;
  if (env.platform === 'win32') {
    const root = env.systemRoot ?? 'C:\\Windows';
    if (!win32.isAbsolute(root)) throw new CliError(`SystemRoot must be an absolute path (got ${root})`);
    // WshShell.Run expands %VAR%: a path with a % in it could run another program or home than the form showed.
    for (const v of [env.node, env.bin, homeDir, root]) {
      if (v.includes('%')) throw new CliError(`a path for the service has a "%" in it, which Windows would expand: ${v}. Nothing was installed; run "rdv listen" yourself.`);
    }
    const user = env.user;
    if (!user || /["<>&\u0000-\u001f]/.test(user)) throw new CliError('the Windows account the service runs as is unknown');
    const commandLine = [quoteWin(env.node, true), quoteWin(env.bin, true), 'listen', '--service', name, '--home', quoteWin(homeDir, true)].join(' ');
    const dir = win32.join(homeDir, 'service');
    const vbsPath = win32.join(dir, `${name}.vbs`);
    const xmlPath = win32.join(dir, `${name}.xml`);
    const wscript = win32.join(root, 'System32', 'wscript.exe');
    const launcher = [wscript, '//B', '//Nologo', vbsPath];
    const launcherArgs = ['//B', '//Nologo', quoteWin(vbsPath, true)].join(' ');
    const logPath = win32.join(dir, `${name}.log`);
    const vbs = [
      `' ${head}`,
      `' ${marker(homeDir)}`,
      "' Runs the command below hidden (window style 0: no console), with only Windows' own variables, and again",
      `' after it stops with an error (${RESTART_SECONDS} s, doubling up to ${RESTART_MAX_SECONDS} s), while this file exists.`,
      'Option Explicit',
      'Dim sh, fso, env, item, k, keep, names, i, cmd, rc, delay, started, logf',
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
      `delay = ${RESTART_SECONDS}`,
      'Do',
      '  started = Now',
      '  rc = sh.Run(cmd, 0, True)',
      '  If rc = 0 Or Not fso.FileExists(WScript.ScriptFullName) Then Exit Do',
      `  If DateDiff("s", started, Now) >= 600 Then delay = ${RESTART_SECONDS}`,
      // One line per restart, for the human (the file starts over past 256 KB).
      `  If fso.FileExists(${vbsString(logPath)}) Then`,
      `    If fso.GetFile(${vbsString(logPath)}).Size > 262144 Then fso.DeleteFile ${vbsString(logPath)}`,
      '  End If',
      `  Set logf = fso.OpenTextFile(${vbsString(logPath)}, 8, True)`,
      '  logf.WriteLine Now & " rdv listen stopped (exit " & rc & "); starting it again in " & delay & " s"',
      '  logf.Close',
      '  WScript.Sleep delay * 1000',
      `  delay = delay * 2: If delay > ${RESTART_MAX_SECONDS} Then delay = ${RESTART_MAX_SECONDS}`,
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
      registered: `${wscript}\n${launcherArgs}`,
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
        `<!-- ${xmlComment(head)} -->`,
        `<!-- ${xmlComment(marker(homeDir))} -->`,
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
        registered: launcher.join('\n'),
      };
    } else {
      const unit = posix.join(env.userHome, '.config', 'systemd', 'user', `${name}.service`);
      const content = [
        `# ${head}`,
        `# ${marker(homeDir)}`,
        '[Unit]',
        `Description=Rendezvous listener ${name}`,
        'StartLimitIntervalSec=0',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${launcher.map(quoteSystemd).join(' ')}`,
        'Restart=on-failure',
        `RestartSec=${RESTART_SECONDS}`,
        // systemd 254 and later: the wait doubles up to the cap (older ones ignore these two and keep 30 s).
        'RestartSteps=4',
        `RestartMaxDelaySec=${RESTART_MAX_SECONDS}`,
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
        registered: launcher.join(' '),
      };
    }
  }
  for (const a of d.argv) if (GATE_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) throw new Error(`the service would run with ${a}`);
  const digest = createHash('sha256').update(`rdv1/service\u0000${JSON.stringify(d)}`).digest('hex');
  return { ...d, digest };
}

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
  /** Installed exactly as this version would install it now, and unchanged since. */
  current: boolean;
  /** Ours, and changed outside Rendezvous since it was installed (its files, what the OS runs, a drop-in): see tamper_reasons. */
  tampered: boolean;
  tamper_reasons: string[];
  /** not-installed, current, older (installed by another version or another node path), tampered, or other-home. */
  state: 'not-installed' | 'current' | 'older' | 'tampered' | 'other-home';
  /** Whether the OS says it is running (null: it cannot tell). */
  running: boolean | null;
  /** Who holds this home's listener.lock now. */
  listener: { holder: string; pid: number; host: string; since: string } | null;
  /** The service itself holds listener.lock. */
  holds_listener_lock: boolean;
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const unxml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * What the OS has registered, read back: the task XML (`schtasks /Query
 * /XML`), the unit (`systemctl --user show`), the LaunchAgent (`launchctl
 * print`). `marker`: the text whose rdv-home marker says whose it is (on
 * Windows only the registered task's own XML, never a file left in a home).
 */
interface Seen {
  installed: boolean;
  marker: string;
  /** registeredOf the definition, as the OS reports it (undefined: it cannot tell). */
  registered?: string;
  /** More than one action or ExecStart, or a drop-in: always a change made outside Rendezvous. */
  extra: string[];
  running: boolean | null;
}

function inspect(d: ServiceDefinition, run: ServiceRunner): Seen {
  if (d.platform === 'win32') {
    const q = run(['schtasks', '/Query', '/TN', d.name, '/XML']);
    if (q.code !== 0) return { installed: false, marker: '', extra: [], running: null };
    let xmlText = q.stdout;
    // schtasks prints in the console's code page, which loses any non-ASCII path (measured on Windows 11): read the
    // task as UTF-8 through Export-ScheduledTask instead, so what the OS runs is compared exactly.
    if (/[^\x00-\x7f]/.test(d.registered)) {
      const u = run([
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Export-ScheduledTask -TaskName '${d.name}' -TaskPath '\\'`,
      ]);
      if (u.code === 0 && u.stdout.includes('<Task')) xmlText = u.stdout;
    }
    const execs = [...xmlText.matchAll(/<Exec>([\s\S]*?)<\/Exec>/g)];
    const extra = execs.length === 1 ? [] : [`the task has ${execs.length} actions`];
    const one = execs[0]?.[1] ?? '';
    const cmd = unxml(/<Command>([\s\S]*?)<\/Command>/.exec(one)?.[1] ?? '').trim();
    const args = unxml(/<Arguments>([\s\S]*?)<\/Arguments>/.exec(one)?.[1] ?? '').trim();
    const csv = run(['schtasks', '/Query', '/TN', d.name, '/FO', 'CSV', '/NH']);
    const state = csv.code === 0 ? (csv.stdout.trim().split(/\r?\n/).pop() ?? '').split('","').pop()?.replace(/"$/, '') : undefined;
    return { installed: true, marker: xmlText, registered: `${cmd}\n${args}`, extra, running: state === undefined ? null : /running/i.test(state) };
  }
  const file = d.files[0];
  if (!existsSync(file.path)) return { installed: false, marker: '', extra: [], running: null };
  const text = readText(file);
  if (d.platform === 'darwin') {
    const p = run(['launchctl', 'print', d.remove[0][2]]);
    if (p.code !== 0) return { installed: true, marker: text, extra: [], running: false };
    const block = /\n\s*arguments = \{\n([\s\S]*?)\n\s*\}/.exec(p.stdout);
    return { installed: true, marker: text, registered: block ? block[1].split('\n').map((l) => l.trim()).join('\n') : undefined, extra: [], running: /\bstate = running\b/.test(p.stdout) };
  }
  const show = run(['systemctl', '--user', 'show', '-p', 'ExecStart', '-p', 'DropInPaths', `${d.name}.service`]);
  const a = run(['systemctl', '--user', 'is-active', `${d.name}.service`]);
  let registered: string | undefined;
  const extra: string[] = [];
  if (show.code === 0) {
    const starts = [...show.stdout.matchAll(/argv\[\]=(.*?) ; ignore_errors=/g)].map((m) => m[1]);
    if (starts.length > 1) extra.push(`the unit runs ${starts.length} commands`);
    registered = starts[0];
    const drop = /^DropInPaths=(.*)$/m.exec(show.stdout)?.[1].trim();
    if (drop) extra.push(`a drop-in changes the unit (${drop})`);
  }
  return { installed: true, marker: text, registered, extra, running: a.stdout.trim() === 'active' };
}

function readText(f: ServiceFile): string {
  const buf = readFileSync(f.path);
  if (f.encoding === 'utf16le') return buf.toString('utf16le').replace(/^﻿/, '');
  return buf.toString('utf8');
}

function fileBytes(f: ServiceFile): Buffer {
  return f.encoding === 'utf16le' ? Buffer.from(`﻿${f.content}`, 'utf16le') : Buffer.from(f.content, 'utf8');
}

function writeText(f: ServiceFile): void {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, fileBytes(f), { mode: 0o644 });
}

// --- what was installed (MACed with the agent key) -------------------------------

/**
 * The record of what install wrote and registered: the definition's digest,
 * each file's hash, and what the OS should report. MACed with the agent's key
 * (which the assistant cannot read), so a file, a task or a unit changed
 * afterwards is told apart from an older version of ours.
 */
interface Record_ {
  v: 1;
  name: string;
  digest: string;
  files: Record<string, string>;
  registered: string;
}

const recordPath = (home: Home, name: string): string => join(home.dir, 'service', `${name}.json`);
const agentKey = (home: Home): Uint8Array | undefined => {
  try {
    return b64decode(home.readAgentState().secretKey);
  } catch {
    return undefined;
  }
};
const recordMac = (key: Uint8Array, r: Record_): string => createHmac('sha256', key).update(`rdv1/service-record\u0000${JSON.stringify(r)}`).digest('hex');

function writeRecord(home: Home, d: ServiceDefinition): void {
  const key = agentKey(home);
  if (!key) throw new CliError(`no agent at ${home.dir}`);
  const r: Record_ = { v: 1, name: d.name, digest: d.digest, files: Object.fromEntries(d.files.map((f) => [f.path, sha(fileBytes(f))])), registered: d.registered };
  mkdirSync(join(home.dir, 'service'), { recursive: true });
  writeFileSync(recordPath(home, d.name), JSON.stringify({ ...r, mac: recordMac(key, r) }, null, 2) + '\n', { mode: 0o600 });
}

function readRecord(home: Home, name: string): Record_ | 'missing' | 'forged' {
  const path = recordPath(home, name);
  if (!existsSync(path)) return 'missing';
  const key = agentKey(home);
  try {
    const { mac, ...r } = JSON.parse(readFileSync(path, 'utf8')) as Record_ & { mac?: string };
    if (!key || typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac) || r.v !== 1 || r.name !== name) return 'forged';
    const body: Record_ = { v: 1, name: r.name, digest: String(r.digest), files: r.files ?? {}, registered: String(r.registered) };
    if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(recordMac(key, body), 'hex'))) return 'forged';
    return body;
  } catch {
    return 'forged';
  }
}

/** Why the installed service is not what install made (empty: unchanged). */
function tamperReasons(home: Home, d: ServiceDefinition, seen: Seen): string[] {
  const reasons = [...seen.extra];
  const rec = readRecord(home, d.name);
  if (rec === 'missing') reasons.push('there is no record of what was installed');
  else if (rec === 'forged') reasons.push('the record of what was installed was changed');
  else {
    for (const [path, want] of Object.entries(rec.files)) {
      if (!existsSync(path)) reasons.push(`${path} is gone`);
      else if (sha(readFileSync(path)) !== want) reasons.push(`${path} was changed`);
    }
    if (seen.registered !== undefined && seen.registered !== rec.registered) reasons.push(`what the OS runs is not what was installed: ${seen.registered.replace(/\n/g, ' ')}`);
  }
  const texts = [seen.registered ?? '', ...d.files.filter((f) => existsSync(f.path)).map(readText)];
  for (const flag of GATE_FLAGS) if (texts.some((t) => t.includes(flag))) reasons.push(`it runs with ${flag}`);
  return [...new Set(reasons)];
}

/** The service for this home: installed or not, running or not, changed or not, and who holds listener.lock (read-only). */
export function serviceStatus(home: Home, profile: string, env: ServiceEnv, run: ServiceRunner = spawnRunner): ServiceStatus {
  const d = serviceDefinition(home.dir, profile, env);
  const seen = inspect(d, run);
  const installedHome = seen.installed ? markedHome(seen.marker) : null;
  const ours = installedHome !== null && samePath(installedHome, home.dir, d.platform);
  const reasons = ours ? tamperReasons(home, d, seen) : [];
  const rec = ours ? readRecord(home, d.name) : 'missing';
  const tampered = reasons.length > 0;
  const current = ours && !tampered && typeof rec === 'object' && rec.digest === d.digest;
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
    tampered,
    tamper_reasons: reasons,
    state: !seen.installed ? 'not-installed' : !ours ? 'other-home' : tampered ? 'tampered' : current ? 'current' : 'older',
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
 * Windows: stop the listener the service started, if it still runs. Only a
 * process on this host that holds listener.lock under the service's role,
 * whose image is node and whose command line runs `--service <name>` (read
 * from Win32_Process), is stopped; a pid reused by anything else never is.
 */
function stopWindowsListener(home: Home, d: ServiceDefinition, run: ServiceRunner): void {
  const h = longLockHolder(home.listenerLockPath);
  if (!h?.here || h.role !== serviceRole(d.name) || !Number.isSafeInteger(h.pid) || h.pid <= 0) return;
  const q = run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${h.pid}'; if ($p) { $p.Name; $p.CommandLine }`]);
  const [image, ...rest] = q.stdout.trim().split(/\r?\n/);
  const cmdline = rest.join(' ');
  if (q.code !== 0 || !/^node(\.exe)?$/i.test((image ?? '').trim()) || !cmdline.includes(`--service ${d.name}`)) return;
  try {
    process.kill(h.pid);
  } catch {
    // gone already
  }
}

const notOurs = (d: ServiceDefinition, other: string | null): CliError =>
  new CliError(
    `${d.location} is already installed ${other ? `for another home (${other})` : 'and was not made by rdv service install'}. ` +
      'Nothing was changed: remove it from that home first, or use another profile name.',
  );

/** Stop and unregister, delete the files and the record (each step may find it gone already). */
function teardown(home: Home, d: ServiceDefinition, run: ServiceRunner, strict: boolean): void {
  // Windows: the files first, so the script stops starting the listener again once its own file is gone.
  if (d.platform === 'win32') for (const f of d.files) rmSync(f.path, { force: true });
  for (const [i, argv] of d.remove.entries()) {
    const r = run(argv);
    // Ending a task that is not running, or stopping what is stopped already, fails harmlessly; deleting the task must work.
    if (strict && r.code !== 0 && d.platform === 'win32' && i === 1) throw failed(argv, r);
  }
  for (const f of d.files) rmSync(f.path, { force: true });
  rmSync(recordPath(home, d.name), { force: true });
  if (d.platform === 'linux') run(['systemctl', '--user', 'daemon-reload']);
  if (d.platform === 'win32') stopWindowsListener(home, d, run);
}

/**
 * Write the definition's files, register and start it, and record what was
 * installed. Replaces an older (or changed) definition of ours; refuses one
 * installed for another home. A failure after the first OS command undoes
 * everything (security review of PR #117), so nothing half-installed stays
 * registered.
 */
export function installService(home: Home, d: ServiceDefinition, run: ServiceRunner = spawnRunner): void {
  const before = inspect(d, run);
  if (before.installed) {
    const other = markedHome(before.marker);
    if (other === null || !samePath(other, home.dir, d.platform)) throw notOurs(d, other);
    // Windows: /Create /F does not stop the script already running the old command.
    if (d.platform === 'win32') {
      run(['schtasks', '/End', '/TN', d.name]);
      stopWindowsListener(home, d, run);
    }
  }
  for (const f of d.files) writeText(f);
  const steps = [...d.install, ...(d.platform === 'linux' && before.installed ? [['systemctl', '--user', 'restart', `${d.name}.service`]] : [])];
  for (const [i, argv] of steps.entries()) {
    const r = run(argv);
    // bootout of a LaunchAgent that is not loaded fails: that is the point of running it first.
    if (r.code === 0 || (d.platform === 'darwin' && i === 0)) continue;
    const err = failed(argv, r);
    teardown(home, d, run, false);
    throw new CliError(`${err.message}. Nothing was left installed${before.installed ? ' (the one installed before was removed too)' : ''}.`);
  }
  writeRecord(home, d);
}

/**
 * Stop and unregister this home's service and delete its files. Returns
 * whether one was installed. Refuses a service of the same name installed for
 * another home.
 */
export function removeService(home: Home, d: ServiceDefinition, run: ServiceRunner = spawnRunner): boolean {
  const before = inspect(d, run);
  if (before.installed) {
    const other = markedHome(before.marker);
    if (other === null || !samePath(other, home.dir, d.platform)) throw notOurs(d, other);
  }
  if (!before.installed) {
    for (const f of d.files) rmSync(f.path, { force: true });
    rmSync(recordPath(home, d.name), { force: true });
    return false;
  }
  teardown(home, d, run, true);
  if (inspect(d, run).installed) throw new CliError(`${d.location} is still registered after removing it`);
  return true;
}

// --- handing listener.lock to the service -------------------------------------------

/** The longest an rdv-mcp leaves listener.lock to a starting service (a file written by hand cannot hold it longer). */
export const YIELD_MAX_MS = 120_000;
const yieldPath = (home: Home): string => join(home.dir, 'listener.yield');

/** Every rdv-mcp on this home leaves listener.lock free for `ms`, so the service starting now takes it. */
export function setListenerYield(home: Home, ms: number): void {
  writeFileSync(yieldPath(home), JSON.stringify({ until: Date.now() + Math.min(ms, YIELD_MAX_MS) }) + '\n');
}

export function clearListenerYield(home: Home): void {
  rmSync(yieldPath(home), { force: true });
}

/** Whether listener.lock is being left to the service now (read by every rdv-mcp before it takes the lock). */
export function listenerYielded(home: Home): boolean {
  try {
    const until = (JSON.parse(readFileSync(yieldPath(home), 'utf8')) as { until?: unknown }).until;
    return typeof until === 'number' && until > Date.now() && until <= Date.now() + YIELD_MAX_MS;
  } catch {
    return false;
  }
}

/**
 * `rdv listen --service <name>`: the command line must be exactly the one
 * the service runs (listen --service <name> --home <home>, for this home's
 * profile), so a script or unit edited to add a flag starts nothing.
 */
export function checkServiceArgv(home: Home, name: string, args: string[]): void {
  const want = serviceName(home.readConfig().profile);
  const at = args.indexOf('--home');
  const ok = args.length === 5 && args[0] === 'listen' && args[1] === '--service' && args[2] === name && at === 3 && samePath(resolve(args[4]), home.dir, process.platform === 'win32' ? 'win32' : 'linux');
  if (name !== want || !ok) {
    throw new CliError(`this is not the command line "rdv service install" wrote (${args.join(' ')}): the background listener runs exactly "listen --service ${want} --home <home>". Nothing was started; reinstall it ("rdv service install").`, 2);
  }
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
    `${s.name}: ${
      s.state === 'not-installed'
        ? 'not installed'
        : s.state === 'other-home'
          ? `installed for another home (${s.installed_home ?? 'unknown'})`
          : s.state === 'tampered'
            ? `installed (${s.location}), but CHANGED OUTSIDE RENDEZVOUS: ${s.tamper_reasons.join('; ')}. "rdv service install" puts it back as it should be, or "rdv service remove" removes it`
            : `installed (${s.location})${s.current ? '' : ', an older definition: "rdv service install" replaces it'}`
    }`,
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
  if (before.tampered) out.error(`the installed service was modified outside Rendezvous (${before.tamper_reasons.join('; ')}); installing it again as it should be`);
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
