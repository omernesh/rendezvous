// site/install-gateway.sh: syntax, the pure helpers (sourced, not run), and a
// --dry-run that must change nothing and touch no network. Needs a POSIX `sh`
// (Git for Windows ships one); skipped without it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RELAYS } from '@rendezvous/core';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO, 'site', 'install-gateway.sh');
const SH_PATH = SCRIPT.split('\\').join('/');
const text = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src = text(SCRIPT);

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const noSh = hasSh ? null : 'no POSIX sh on PATH';
// No terminal in tests, whatever the host: every question takes its default or needs a flag.
const env = { ...process.env, RDV_GW_NO_TTY: '1' };

/** Run the installer with these flags, stdin closed. Async, so the dry runs below run side by side (sh is slow to fork on Windows). */
function install(args: string[]): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [SH_PATH, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** Source the script without running main, then run a snippet of sh against its functions. */
function lib(snippet: string) {
  const r = spawnSync('sh', ['-c', `RDV_GW_SOURCE_ONLY=1 . "${SH_PATH}"; ${snippet}`], { encoding: 'utf8', env, timeout: 20_000 });
  return { status: r.status, out: (r.stdout ?? '').trim() };
}
const ok = (fn: string, value: string) => lib(`if ${fn} '${value.replace(/'/g, `'\\''`)}'; then echo yes; else echo no; fi`).out === 'yes';

const DIR = '/nonexistent-rdv-gateway-test/gw';
const BASE = ['--dry-run', '--dir', DIR, '--runtime', 'docker', '--agent', 'new', '--email', 'omer@example.com'];

describe('install-gateway.sh: the file', () => {
  it.skipIf(noSh !== null)(`parses (sh -n)${noSh ? ` (SKIPPED: ${noSh})` : ''}`, () => {
    expect(spawnSync('sh', ['-n', SH_PATH], { encoding: 'utf8' }).status).toBe(0);
  });

  const sc = spawnSync('shellcheck', ['--version']).status === 0;
  it.skipIf(!sc)(`is shellcheck-clean${sc ? '' : ' (SKIPPED: shellcheck not installed)'}`, () => {
    const r = spawnSync('shellcheck', ['-s', 'sh', SH_PATH], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('runs from main() on the last line, so a cut-short download runs nothing', () => {
    const lines = src.trimEnd().split('\n');
    expect(lines.at(-1)).toBe('[ "${RDV_GW_SOURCE_ONLY:-0}" = 1 ] || main "$@"');
    expect(src.startsWith('#!/bin/sh\n')).toBe(true);
    expect(readFileSync(SCRIPT).includes(13)).toBe(false); // LF only
  });

  it('pins both images by digest, and a new agent gets relay.nesher.co plus the default public relays', () => {
    expect(src).toMatch(/^NODE_IMAGE_DEFAULT='node:22[\w.-]*-alpine@sha256:[0-9a-f]{64}'$/m);
    expect(src).toMatch(/^CLOUDFLARED_IMAGE_DEFAULT='cloudflare\/cloudflared:[\d.]+@sha256:[0-9a-f]{64}'$/m);
    const relays = /^DEFAULT_RELAYS='([^']+)'$/m.exec(src)?.[1].split(' ');
    expect(relays).toEqual(['wss://relay.nesher.co', ...DEFAULT_RELAYS]);
  });

  it('never takes a secret as an argument, and never pipes a download into a shell', () => {
    expect(src).not.toMatch(/--pin[ =]["$]|--stdin/);
    for (const line of src.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      expect(line, line).not.toMatch(/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
      expect(line, line).not.toMatch(/^\s*sudo\b/);
    }
  });

  it('is served as plain text by both hosts, like the other installers', () => {
    const pages = text(join(REPO, 'site', '_headers'));
    expect(pages).toMatch(/^\/install-gateway\.sh\n(?: {2}.*\n)*? {2}Content-Type: text\/plain; charset=utf-8$/m);
    const nginx = text(join(REPO, 'impl', 'deploy', 'site', 'nginx.conf'));
    expect(nginx).toMatch(/location = \/install-gateway\.sh \{\n\s+types \{ \}\n\s+default_type text\/plain;/);
  });

  it('the deploy doc leads with the one-liner and keeps the steps by hand', () => {
    const doc = text(join(REPO, 'docs', 'gateway-deploy.md'));
    const one = 'curl -fsSL https://rendezvous.nesher.co/install-gateway.sh | sh';
    expect(doc).toContain(one);
    expect(doc.indexOf(one)).toBeLessThan(doc.indexOf('## 1.'));
    expect(doc).toMatch(/## By hand/);
  });
});

describe.skipIf(noSh !== null)('install-gateway.sh: helpers', () => {
  const CASES: [string, string, boolean][] = [
    ['valid_https_url', 'https://gw.example.com', true],
    ['valid_https_url', 'https://gw.example.com:8443', true],
    ['valid_https_url', 'http://gw.example.com', false],
    ['valid_https_url', 'https://gw.example.com/mcp', false],
    ['valid_https_url', 'https://gw.example.com\nhttps://x', false],
    ['valid_https_url', 'https://$(id).example.com', false],
    ['valid_header', 'cf-connecting-ip', true],
    ['valid_header', 'x real ip', false],
    ['valid_port', '8787', true],
    ['valid_port', '0', false],
    ['valid_port', '70000', false],
    ['valid_email', 'omer@example.com', true],
    ['valid_email', 'omer@example', false],
    ['valid_email', 'omer@example.com --public-pointer', false],
    ['valid_relay', 'wss://relay.nesher.co', true],
    ['valid_relay', 'wss://relay.example.com:7777/nostr', true],
    ['valid_relay', 'ws://relay.example.com', false],
    ['valid_ref', 'main', true],
    ['valid_ref', 'v1.2.0', true],
    ['valid_ref', '--upload-pack=x', false],
    ['valid_ref', 'feat/gateway-installer', true],
    ['valid_ref', 'refs/pull/1/head', false],
    ['valid_ref', 'pull/1/head', false],
    ['valid_ref', 'refs/heads/main', false],
    ['valid_ref', 'main..evil', false],
    ['valid_ref', '0123abc', true],
    ['valid_path', '/srv/gw:/etc', false],
    ['valid_path', '/srv//gw', false],
    ['valid_path', '/srv/./gw', false],
    ['valid_path', '/home/omer/../../etc', false],
    ['valid_path', '/srv/gw/.', false],
    ['valid_path', '/srv/gw/..', false],
    ['valid_path', '/srv/gw.d/x..y', true],
    ['valid_path', '/srv/a,b', false],
    ['system_dir', '/', true],
    ['system_dir', '/tmp', true],
    ['system_dir', '/home', true],
    ['system_dir', '/usr/local/gw', true],
    ['system_dir', '/volume1', true],
    ['system_dir', '/volume1/docker', true],
    ['system_dir', '/gw', true],
    ['system_dir', '/volume1/docker/rendezvous-gateway', false],
    ['system_dir', '/srv/rendezvous-gateway', false],
    ['valid_path', '/home/omer/rendezvous-gateway', true],
    ['valid_path', '/home/omer/my gateway', false],
    ['valid_path', '/home/omer/$(x)', false],
    ['valid_path', 'relative/dir', false],
    ['valid_token', 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoiWFlaIn0=xxxxxxxxxx', true],
    ['valid_token', 'short', false],
  ];
  it('validate what they are given', () => {
    // One sh for the whole table: each case prints yes or no on its own line.
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const got = lib(CASES.map(([fn, v]) => `if ${fn} ${q(v)}; then echo yes; else echo no; fi`).join('; ')).out.split(/\r?\n/);
    expect(CASES.map(([fn, v], i) => `${fn} ${JSON.stringify(v)} -> ${got[i]}`)).toEqual(CASES.map(([fn, v, want]) => `${fn} ${JSON.stringify(v)} -> ${want ? 'yes' : 'no'}`));
  });

  it('expands ~ and relative paths, and trims a trailing slash', () => {
    expect(lib('HOME=/home/omer; abs_path "~/gw/"').out).toBe('/home/omer/gw');
    expect(lib('cd /; abs_path "srv/gw"').out).toBe('/srv/gw');
    expect(lib('trim_url "https://gw.example.com/"').out).toBe('https://gw.example.com');
  });

  it('picks the client-IP header each tunnel sets', () => {
    expect(lib('header_for cloudflare-token').out).toBe('cf-connecting-ip');
    expect(lib('header_for cloudflare-quick').out).toBe('cf-connecting-ip');
    expect(lib('header_for tailscale').out).toBe('x-forwarded-for');
    expect(lib('header_for own-url').out).toBe('');
  });

  it('never takes your home, or anything above it, as the install folder', () => {
    expect(lib('HOME=/home/omer; if system_dir /home/omer; then echo yes; fi; if system_dir /home/omer/; then echo yes; fi; if system_dir /home/omer/gw; then echo no; fi').out).toBe('yes\nyes');
  });

  it('refuses a folder with other files in it, a symlinked folder, and writing through a symlink', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rdv-gw-dir-'));
    // sh's own spelling of the path (Git for Windows: /c/Users/...).
    const t = process.platform === 'win32' ? spawnSync('cygpath', ['-u', tmp], { encoding: 'utf8' }).stdout.trim() : tmp;
    try {
      mkdirSync(join(tmp, 'busy'));
      writeFileSync(join(tmp, 'busy', 'notes.txt'), 'x');
      mkdirSync(join(tmp, 'empty'));
      mkdirSync(join(tmp, 'old'));
      writeFileSync(join(tmp, 'old', 'install.conf'), 'RUNTIME=docker\n');
      writeFileSync(join(tmp, 'old', 'other.txt'), 'x');
      // The dirs exist only from node's point of view on Windows; the checks run in sh on the same paths.
      const run = (d: string) => lib(`HOME=/home/nobody; check_install_dir "${t}/${d}" 2>&1; echo ok`).out;
      expect(run('busy')).toMatch(/already has other files in it and no gateway install/);
      expect(run('busy')).not.toMatch(/ok$/);
      expect(run('empty')).toMatch(/ok$/);
      expect(run('old')).toMatch(/ok$/);
      expect(run('new/sub')).toMatch(/ok$/);
      // write_file never follows a symlink left at the target.
      const link = lib(`cd "${t}/empty" && ln -s ../busy/notes.txt target 2>/dev/null && [ -L target ] && { DRY_RUN=0; printf 'x' | write_file "${t}/empty/target" 600 2>&1; echo reached; } || echo nolink`).out;
      if (link !== 'nolink') {
        expect(link).toMatch(/symbolic link/);
        expect(link).not.toContain('reached');
        expect(readFileSync(join(tmp, 'busy', 'notes.txt'), 'utf8')).toBe('x');
      }
      // A fresh write: the file and no temp left behind.
      expect(lib(`DRY_RUN=0; printf 'hello' | write_file "${t}/empty/out" 600; cat "${t}/empty/out"; ls "${t}/empty"`).out).toMatch(/^hello/);
      expect(readdirSync(join(tmp, 'empty')).filter((f) => f.startsWith('out.'))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads the whole ls mode: a trailing + is an ACL, group write is fine only for your own private group', () => {
    const fake = (mode: string, uid = '$(id -u)', gid = '$(id -g)') => `ls() { echo "${mode} 1 ${uid} ${gid} 74 Oct 26 20:52 x"; }`;
    const yes = (fn: string, pre: string) => lib(`${pre}; if ${fn} /x; then echo yes; else echo no; fi`).out;
    // The Synology case, seen on a real NAS: the share has an ACL, a folder made over SSH has none.
    expect(yes('has_acl', `${fake('drwxrwxrwx+', '0', '0')}; syno_acl_tool() { return 1; }`)).toBe('yes');
    expect(yes('has_acl', `${fake('drwxr-xr-x', '0', '0')}; syno_acl_tool() { return 1; }`)).toBe('no');
    expect(yes('others_can_write', fake('drwxrwxrwx+', '0', '0'))).toBe('yes');
    expect(yes('others_can_write', fake('drwx---rwx'))).toBe('yes');
    expect(yes('others_can_write', fake('drwx------'))).toBe('no');
    // Group write: refused for a shared group, fine for a user private group (group named like you, your gid).
    expect(yes('others_can_write', `${fake('drwxrwx---', '$(id -u)', '4242')}`)).toBe('yes');
    expect(yes('others_can_write', `${fake('drwxrwx---')}; id() { case "$1" in -gn | -un) echo omer ;; -g) command id -g ;; -u) command id -u ;; esac; }`)).toBe('no');
    // DSM: synoacltool -get lists entries for a folder with an ACL, and says "Linux mode" for one without.
    const tool = `syno_acl_tool() { echo synofake; }; synofake() { printf '%s\\n' 'ACL version: 1' '	 [0] group:administrators:allow:rwxpdDaARWc--:fd-- (level:0)'; }`;
    expect(yes('has_acl', `${fake('drwx------')}; ${tool}`)).toBe('yes');
    expect(yes('has_acl', `${fake('drwx------')}; syno_acl_tool() { echo synofake; }; synofake() { echo "It's Linux mode"; return 255; }`)).toBe('no');
  });

  it('a shared parent (the NAS docker share) is allowed with a warning; the install folder itself must be private', () => {
    if (process.platform === 'win32') return; // chmod and ownership need a POSIX filesystem
    const tmp = mkdtempSync(join(tmpdir(), 'rdv-gw-share-'));
    try {
      const share = join(tmp, 'docker');
      mkdirSync(share, { mode: 0o777 });
      spawnSync('chmod', ['777', share]);
      const r = lib(`DRY_RUN=0 YES=1 DIR="${share}/rendezvous-gateway"; check_install_dir "$DIR" 2>&1; make_install_dir 2>&1; ls -ld "$DIR" | cut -c1-10; echo ok`);
      expect(r.out).toMatch(/is shared \(others can write it, or it has an ACL\)/);
      expect(r.out).toMatch(/drwx------\nok$/);
      // An install folder others can write is refused, shared parent or not.
      mkdirSync(join(share, 'open'));
      spawnSync('chmod', ['777', join(share, 'open')]);
      expect(lib(`check_install_dir "${share}/open" 2>&1; echo reached`).out).toMatch(/can be written by other users/);
      // Swapped for a symlink before a write: the recheck stops it.
      const s = lib(`DRY_RUN=0 DIR="${share}/rendezvous-gateway"; mv "$DIR" "$DIR.real"; ln -s "$DIR.real" "$DIR"; printf x | write_file "$DIR/x" 600 2>&1; echo reached`);
      expect(s.out).toMatch(/symbolic link/);
      expect(s.out).not.toContain('reached');
      // physical_path resolves symlinks in the existing part.
      expect(lib(`physical_path "${share}/rendezvous-gateway/sub"`).out).toBe(`${share}/rendezvous-gateway.real/sub`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to build or run code another user owns (./gw update would run it)', () => {
    // A stand-in `id` makes us someone who does not own the script file.
    const r = lib(`id() { if [ "$1" = -u ]; then echo 4242; else command id "$@"; fi; }; check_owned "${SH_PATH}"; echo reached`);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('reached');
    expect(lib(`check_owned "${SH_PATH}" /nonexistent-rdv-file; echo reached`).out).toBe('reached');
  });

  it('as root, runs the gateway as the user who ran sudo (or --uid), never a fixed or root id', () => {
    expect(lib('YES=1 UID_FLAG= SUDO_UID=1001 SUDO_GID=1002; choose_uid >/dev/null; echo "$RDV_UID:$RDV_GID"').out).toBe('1001:1002');
    expect(lib('YES=1 UID_FLAG=1003 SUDO_UID=1001 SUDO_GID=1002; choose_uid >/dev/null; echo "$RDV_UID"').out).toBe('1003');
    expect(lib('YES=1 UID_FLAG=0; choose_uid; echo reached').out).not.toContain('reached');
    // No sudo user, no flag, no terminal: it asks, so it stops and names the flag.
    const r = lib('YES=0 DRY_RUN=0 UID_FLAG= SUDO_UID=; unset SUDO_UID; choose_uid 2>&1; echo reached');
    expect(r.out).toMatch(/pass --uid/);
    expect(r.out).not.toContain('reached');
  });

  it("reads a quick tunnel's address from cloudflared's log", () => {
    const log = [
      '2026-10-31T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2026-10-31T10:00:02Z INF |  https://brave-lions-sing-gently.trycloudflare.com                              |',
    ].join('\\n');
    expect(lib(`quick_url_from "$(printf '${log}')"`).out).toBe('https://brave-lions-sing-gently.trycloudflare.com');
    expect(lib('quick_url_from "no address yet"').out).toBe('');
  });
});

describe.concurrent.skipIf(noSh !== null)('install-gateway.sh: --dry-run', () => {
  it('a Cloudflare named tunnel: hardened compose on 127.0.0.1, the token kept out of .env, nothing written', async () => {
    const r = await install([...BASE, '--tunnel', 'cloudflare-token', '--public-url', 'https://gw.example.com/']);
    expect(r.out).toMatch(/Dry run: nothing is changed/);
    expect(r.status, r.out).toBe(0);
    for (let n = 1; n <= 7; n++) expect(r.out).toContain(`Step ${n} of 7 done.`);
    const compose = /--- would write \S+docker-compose\.yml[^\n]*\n([\s\S]*?)--- end of/.exec(r.out)?.[1] ?? '';
    for (const s of ['read_only: true', '- ALL', 'no-new-privileges:true', '- 127.0.0.1', '/healthz', './repo:/app:ro', 'user: "${RDV_UID}:${RDV_GID}"', '--token-file', './cloudflared.token:/etc/cloudflared/cloudflared.token:ro', 'user: "${TUNNEL_UID}:${TUNNEL_GID}"', 'pids_limit: 256', 'mem_limit: 512m', 'pids_limit: 128']) {
      expect(compose, s).toContain(s);
    }
    expect(compose).not.toMatch(/allow-remote-bind|0\.0\.0\.0|ports:/);
    const dotenv = /--- would write \S+\/\.env \(mode 600\)\n([\s\S]*?)--- end of/.exec(r.out)?.[1] ?? '';
    expect(dotenv).toContain('GW_PUBLIC_URL=https://gw.example.com\n');
    expect(dotenv).toContain('GW_CLIENT_IP_HEADER=cf-connecting-ip\n');
    expect(dotenv).toMatch(/NODE_IMAGE=node:[^\n]+@sha256:/);
    expect(dotenv).not.toMatch(/TOKEN/);
    expect(r.out).toMatch(/Would ask for the tunnel token here \(never shown\)/);
    // A new token means a new tunnel container: cloudflared reads the file once.
    expect(r.out).toContain('$ compose up -d --force-recreate tunnel');
    // The helper it writes is valid sh, and ./gw update checks the folder and the installer copy first.
    const helper = /--- would write \S+\/gw \(mode 755\)\n([\s\S]*?)--- end of/.exec(r.out)?.[1] ?? '';
    expect(helper).toContain('update) mine "$DIR" && mine "$DIR/install-gateway.sh" ||');
    expect(spawnSync('sh', ['-n'], { input: helper, encoding: 'utf8' }).status).toBe(0);
    const mine = (mode: string) => spawnSync('sh', ['-c', `${/^mine\(\) \{[\s\S]*?^\}$/m.exec(helper)?.[0]}\nls() { echo "${mode} 1 $(id -u) 0 1 x"; }\nmine /x && echo yes || echo no`], { encoding: 'utf8' }).stdout.trim();
    expect(mine('drwx------')).toBe('yes');
    expect(mine('drwxrwxrwx')).toBe('no');
    expect(mine('drwx------+')).toBe('no');
    // The owner-only steps read the terminal themselves; the installer never handles the PIN.
    expect(r.out).toMatch(/\$ compose run --rm --no-deps gateway node packages\/gateway\/dist\/src\/bin\.js pin set --home \/data/);
    expect(r.out).toContain('init --email omer@example.com --relay wss://relay.nesher.co');
    expect(r.out).not.toContain('--public-pointer');
    expect(r.out).toContain('https://gw.example.com/mcp');
    expect(r.out).toContain('claude mcp add --transport http rendezvous https://gw.example.com/mcp');
    expect(r.out).toMatch(/gw token create --name hermes --scope read,send/);
    expect(r.out).not.toMatch(/\$ \S*gw token create/); // shown, never run
    expect(existsSync(DIR)).toBe(false);
  });

  it('own proxy: asks for nothing more with flags, and uses the header given', async () => {
    const r = await install([...BASE, '--public-pointer', '--relay', 'wss://relay.example.com', '--tunnel', 'own-url', '--public-url', 'https://gw.example.com', '--client-ip-header', 'x-real-ip']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('GW_CLIENT_IP_HEADER=x-real-ip');
    expect(r.out).toContain('init --email omer@example.com --relay wss://relay.example.com --public-pointer --home /data');
    expect(r.out).toContain('card publish --home /data');
    expect(r.out).not.toMatch(/^ {2}tunnel:/m);
  });

  it('restore: the passphrase is typed into rdv restore, from a private copy that is removed after', async () => {
    const r = await install(['--dry-run', '--dir', DIR, '--runtime', 'docker', '--agent', 'restore', '--backup', '/backups/agent.rdvbackup', '--tunnel', 'cloudflare-quick']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`$ cp /backups/agent.rdvbackup ${DIR}/.restore/agent.rdvbackup`);
    expect(r.out).toContain(`-v ${DIR}/.restore:/backup:ro gateway node packages/cli/dist/src/bin.js restore /backup/agent.rdvbackup --home /data`);
    expect(r.out).toContain(`$ rm -rf ${DIR}/.restore`);
    expect(r.out).toMatch(/quick tunnel is for trying it out/);
    expect(r.out).toContain('$ compose up -d tunnel');
  });

  it('as root (NAS): builds as root, chowns only data/ to the sudo user, and ./gw update runs the copy outside repo/', async () => {
    const root = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const script = `id() { case "$1" in -u) echo 0 ;; -g) echo 0 ;; *) command id "$@" ;; esac; }; RDV_GW_SOURCE_ONLY=1 . "${SH_PATH}"; owner_of() { echo 0; }; main "$@"`;
      const child = spawn('sh', ['-c', script, 'sh', ...BASE, '--allow-root', '--tunnel', 'own-url', '--public-url', 'https://gw.example.com', '--client-ip-header', 'x-real-ip'], {
        env: { ...env, SUDO_UID: '1001', SUDO_GID: '1001' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (status) => resolve({ status, out }));
    });
    expect(root.status, root.out).toBe(0);
    expect(root.out).toContain(`$ chown 1001:1001 ${DIR}/data\n`);
    expect(root.out).not.toMatch(/chown[^\n]*\/repo/);
    expect(root.out).toMatch(/docker run --rm --user 0:0 --cap-drop ALL --security-opt no-new-privileges/);
    expect(root.out).toContain('RDV_UID=1001');
    expect(root.out).not.toContain('safe.directory');
    expect(root.out).toContain(`$ cp ${DIR}/repo/site/install-gateway.sh ${DIR}/install-gateway.sh`);
    expect(root.out).toContain('exec sh "$DIR/install-gateway.sh" --dir "$DIR" --update --allow-root --uid 1001 "$@"');
    // Without --allow-root it refuses.
    expect(src).toMatch(/do not run this as root/);
  });

  it('refuses secrets as arguments', async () => {
    for (const flag of ['--pin', '--passphrase', '--token', '--tunnel-token']) {
      const r = await install([...BASE, flag, 'x']);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/never passed as arguments/);
    }
  });

  it('refuses an http public address and an unknown tunnel', async () => {
    let r = await install([...BASE, '--tunnel', 'own-url', '--public-url', 'http://gw.example.com', '--client-ip-header', 'x-real-ip']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/must be https:\/\/host/);
    r = await install([...BASE, '--tunnel', 'ngrok']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--tunnel is cloudflare-token, cloudflare-quick, own-url or tailscale/);
  });

  it('without a terminal, a question with no default names the flag to pass', async () => {
    const r = await install(['--dry-run', '--dir', DIR, '--runtime', 'docker', '--tunnel', 'own-url']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no terminal to ask .*pass --public-url/);
  });

  it('refuses a pull request ref, and takes no default for the own proxy client-IP header', async () => {
    let r = await install([...BASE, '--ref', 'refs/pull/7/head', '--tunnel', 'own-url', '--public-url', 'https://gw.example.com', '--client-ip-header', 'x-real-ip']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--ref is a branch, tag or commit/);
    r = await install([...BASE, '--tunnel', 'own-url', '--public-url', 'https://gw.example.com']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/nginx +x-real-ip/);
    expect(r.out).toMatch(/no terminal to ask .*pass --client-ip-header/);
  });

  it('refuses a system folder as the install folder', async () => {
    for (const d of ['/', '/tmp', '/usr/local', '/volume1/docker']) {
      const r = await install(['--dry-run', '--dir', d, '--runtime', 'docker', '--tunnel', 'own-url']);
      expect(r.status, d).toBe(1);
      expect(r.out, d).toMatch(/system or shared folder/);
    }
  });

  it('--update needs an existing install', async () => {
    const r = await install(['--dry-run', '--dir', DIR, '--update']);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/--update needs an existing install/);
  });
});
