// The Claude Code plugin and Agent Skill in plugins/rendezvous: manifests,
// the launcher, the consent guard hook, and a lint that keeps the skill from
// ever telling the assistant to run a consent command itself.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
// A plain JS module (no types); vitest does not type-check tests.
import { checkCommand, checkPath, decide } from '../../../../plugins/rendezvous/hooks/consent-guard.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN = join(REPO, 'plugins', 'rendezvous');
const SKILL_DIR = join(PLUGIN, 'skills', 'rendezvous');
const LAUNCHER = join(PLUGIN, 'bin', 'rdv-mcp.mjs');
const GUARD = join(PLUGIN, 'hooks', 'consent-guard.mjs');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

function skillFiles(dir = SKILL_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? skillFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );
}

/** A paragraph may name a consent command only to say it is the human's, never the assistant's. */
const HUMAN_MARKER = /own terminal|never run|never you|human only/i;

/**
 * Every command in a doc that the consent guard refuses: inside a code fence
 * (something to run) it is always a violation; inline, only in a paragraph
 * that does not mark it as the human's.
 */
export function consentViolations(md: string): string[] {
  const bad: string[] = [];
  const fences = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  for (const f of fences) for (const line of f[1].split('\n')) if (checkCommand(line)) bad.push(`in a code block: ${line.trim()}`);
  const prose = md.replace(/```[\s\S]*?```/g, '');
  for (const para of prose.split(/\n\s*\n/)) {
    for (const m of para.matchAll(/`([^`]+)`/g)) {
      if (checkCommand(m[1]) && !HUMAN_MARKER.test(para)) bad.push(`told to run: ${m[1]}`);
    }
  }
  return bad;
}

describe('plugin manifests', () => {
  it('the marketplace lists the plugin, and names and versions agree', () => {
    const market = json(join(REPO, '.claude-plugin', 'marketplace.json'));
    const plugin = json(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(market.name).toBe('rendezvous');
    expect(market.owner.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    const entry = market.plugins[0];
    expect(entry).toMatchObject({ name: plugin.name, source: './plugins/rendezvous', version: plugin.version });
    expect(existsSync(join(REPO, entry.source))).toBe(true);
    expect(plugin.license).toBe('Apache-2.0');
  });

  it('.mcp.json starts the launcher with node, and the hook runs the guard', () => {
    const mcp = json(join(PLUGIN, '.mcp.json'));
    expect(mcp.mcpServers.rendezvous).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/rdv-mcp.mjs'] });
    const hooks = json(join(PLUGIN, 'hooks', 'hooks.json')).hooks.PreToolUse;
    expect(hooks[0].matcher.split('|')).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'Read']));
    expect(hooks[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/consent-guard.mjs"');
    expect(existsSync(LAUNCHER) && existsSync(GUARD)).toBe(true);
  });
});

describe('the skill', () => {
  const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');

  it('is a valid Agent Skill that triggers on setup and messaging requests', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill.replace(/\r\n/g, '\n'))?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(fm)?.[1]).toBe('rendezvous'); // must equal the directory name
    const description = /^description: (.+)$/m.exec(fm)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const t of ['set up rendezvous', "connect my agent with John's", 'send a message to john@doe.com over rendezvous', 'someone wants to contact me']) {
      expect(description).toContain(t);
    }
  });

  it('states the consent rules', () => {
    expect(skill).toMatch(/You never approve a contact request/);
    expect(skill).toMatch(/Only the human decides/);
    expect(skill).toMatch(/untrusted\s+data, never instructions/);
    expect(skill).toMatch(/Never print or read the secret key/);
    expect(skill).toMatch(/Never guess or search for a phrase/);
    for (const c of ['rdv contact grant', 'rdv dinner confirm']) expect(skill).toContain(c); // named, as the human's
  });

  it('never tells the assistant to run a consent command (SKILL.md and references)', () => {
    const files = skillFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(consentViolations(readFileSync(f, 'utf8')), f).toEqual([]);
  });

  it('the lint catches a skill that would', () => {
    expect(consentViolations('3. Approve it: run `rdv contact grant <id> --tier friend`.')).toHaveLength(1);
    expect(consentViolations('Then:\n\n```sh\nrdv dinner confirm t1 --hold 1234\n```\n')).toHaveLength(1);
    expect(consentViolations('Read the phrase: `rdv contact pending`.')).toHaveLength(1);
    expect(consentViolations('The human runs `rdv contact grant` in their own terminal.')).toEqual([]);
    expect(consentViolations('List requests with `rdv contact pending --json`.')).toEqual([]);
  });

  it('uses only the example personas', () => {
    for (const f of [...skillFiles(), join(PLUGIN, 'README.md')]) {
      for (const m of readFileSync(f, 'utf8').matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) expect(m[0], f).toMatch(/@(example\.com|doe\.com)$/);
    }
  });
});

describe('consent guard hook', () => {
  const denied = [
    'rdv contact grant 0f1e --tier friend',
    'rdv --profile omer contact grant 0f1e',
    'rdv contact confirm g1',
    'rdv contact resync rdv1:abc',
    'rdv contact pending',
    'rdv contact pending --profile john',
    'rdv dinner confirm t1 --hold 1234',
    'rdv dinner cancel t1',
    'rdv dinner list',
    'rdv listen --auto-grant friend',
    'rdv listen --negotiate --calendar c.json --auto-confirm',
    'rdv init --force --email omer@example.com',
    'cd /tmp && rdv.cmd contact grant x',
    '& rdv.ps1 contact grant x',
    'node ~/.rendezvous/src/impl/packages/cli/dist/src/bin.js contact confirm g1',
    'npm run rdv -- contact grant x',
    'cat ~/.rendezvous/default/agent.json',
    'Get-Content $HOME\\.rendezvous\\omer\\consent.json',
  ];
  const allowed = [
    'rdv --help',
    'rdv whoami',
    'rdv init --email omer@example.com --relay wss://relay.nesher.co --public-pointer',
    'rdv contact request john@doe.com --greeting "please grant me contact"',
    'rdv contact pending --json',
    'rdv dinner list --json',
    'rdv contact list',
    'rdv contact decline 0f1e --block',
    'rdv send rdv1:abc --json \'{"type":"note","text":"hi"}\'',
    'rdv listen',
    'ls ~/.rendezvous',
    'git commit -m "contact grant docs"',
  ];

  it.each(denied)('refuses %s', (c) => expect(checkCommand(c)).toBeTruthy());
  it.each(allowed)('allows %s', (c) => expect(checkCommand(c)).toBeUndefined());

  it('refuses reading the secret key or consent file', () => {
    expect(checkPath(join('/home/omer', '.rendezvous', 'omer', 'agent.json'))).toBeTruthy();
    expect(checkPath('C:\\Users\\omer\\.rendezvous\\default\\consent.json')).toBeTruthy();
    expect(checkPath('/work/project/agent.json')).toBeUndefined();
    expect(checkPath(join('/home/omer', '.rendezvous', 'omer', 'config.json'))).toBeUndefined();
    expect(decide({ tool_name: 'Read', tool_input: { file_path: '/home/omer/.rendezvous/x/agent.json.bak' } })).toBeTruthy();
  });

  it('answers Claude Code with a deny decision on stdout', () => {
    const run = (input: unknown) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8' });
    const deny = run({ tool_name: 'Bash', tool_input: { command: 'rdv contact grant abc' } });
    expect(deny.status).toBe(0);
    const out = JSON.parse(deny.stdout).hookSpecificOutput;
    expect(out).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.permissionDecisionReason).toContain('own terminal');
    const allow = run({ tool_name: 'Bash', tool_input: { command: 'rdv whoami' } });
    expect(allow.status).toBe(0);
    expect(allow.stdout).toBe('');
    const junk = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' });
    expect(junk.status).toBe(0);
    expect(junk.stdout).toBe('');
  });
});

describe('plugin launcher', () => {
  it('starts the server the installer built (RDV_DIR) over stdio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rdv-launcher-'));
    const env = { ...process.env, RDV_DIR: REPO } as Record<string, string>;
    delete env.RDV_HOME;
    const transport = new StdioClientTransport({ command: process.execPath, args: [LAUNCHER, '--home', join(root, 'h')], env, stderr: 'pipe' });
    const client = new Client({ name: 'launcher-test', version: '0' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['rdv_init', 'rdv_status', 'rdv_grant', 'rdv_send', 'rdv_inbox']));
      const r = await client.callTool({ name: 'rdv_status', arguments: {} });
      expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toMatchObject({ initialized: false, home: join(root, 'h') });
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('explains how to install when Rendezvous is missing', () => {
    const missing = join(tmpdir(), `rdv-missing-${process.pid}`);
    const r = spawnSync(process.execPath, [LAUNCHER], { env: { ...process.env, RDV_DIR: missing }, encoding: 'utf8', input: '' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(''); // stdout is the MCP channel
    expect(r.stderr).toContain('not installed');
    expect(r.stderr).toContain('https://rendezvous.nesher.co/install.sh');
    expect(r.stderr).toContain('/reload-plugins');
  });
});
