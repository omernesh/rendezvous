// One gateway, several agents (NOTES 104): every token and OAuth grant reaches
// exactly one agent, and nothing of another (tools, inbox events, approvals,
// held invite links; REST, MCP and the /a/<name>/ URLs alike). The page names
// the agent of every approval. Both agents listen in one process and talk to
// each other over the in-memory relay. A gateway from before keeps working
// unchanged, and `rdv-gateway agent migrate|add|remove` move nothing silently.
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, Home, initHome, writeBackupFile } from '@rendezvous/cli/lib';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentRoot, Gateway, GatewayStore, OAuthStore } from '../src/index.js';
import { api, Browser, callJson, hidden, mcpClient, PIN, waitApi } from './helpers.js';

const BIN = fileURLToPath(new URL('../dist/src/bin.js', import.meta.url));

let relay: TestRelay;
let root: string;
let gws: Gateway[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const g of gws) await g.close().catch(() => {});
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
const email = (who: string) => `${who}.m${process.pid}.${++n}@example.com`;

/** A gateway root with agents/<name>/ for each name (public pointer on, so each can be found by its ID). */
async function multi(names: string[], opts: { legacy?: string } = {}): Promise<{ gw: Gateway; base: string; log: string[]; ids: Record<string, string> }> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-multi-'));
  const ids: Record<string, string> = {};
  if (opts.legacy) ids[opts.legacy] = (await initHome(new Home(root), { profile: opts.legacy, relays: [relay.url], emails: [email(opts.legacy)], publicPointer: true })).id;
  for (const name of names) {
    ids[name] = (await initHome(new Home(join(root, 'agents', name)), { profile: name, relays: [relay.url], emails: [email(name)], publicPointer: true })).id;
  }
  const log: string[] = [];
  const gw = new Gateway({ home: new Home(root), port: 0, humanLog: (l) => log.push(l), pollMs: 150, sweepMs: 3_600_000 });
  gws.push(gw);
  await gw.store.setPin(PIN);
  const base = await gw.start();
  return { gw, base, log, ids };
}

const tok = async (gw: Gateway, agent: string | undefined, scopes: string[], name = `t-${++n}`) => (await gw.store.createToken(name, scopes, agent)).token;

/** The built bin, stdin piped (no terminal). */
function bin(args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin!.end(input);
  });
}

async function events(base: string, token: string): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await api(base, token, 'rdv_inbox', { since: 0 });
  expect(r.status, r.text).toBe(200);
  return r.body.result.events;
}

describe('one gateway, two agents: isolation', () => {
  it('a token of one agent never reaches the other: tools, inbox, approvals, the held invite link; REST and MCP', { timeout: 90_000 }, async () => {
    const { gw, base, ids } = await multi(['kids', 'omer']);
    expect(gw.agents.map((a) => a.name)).toEqual(['kids', 'omer']);
    const a = await tok(gw, 'omer', ['read', 'send', 'contact:request'], 'sammie');
    const b = await tok(gw, 'kids', ['read', 'send', 'contact:request'], 'kids-claude');

    // Unprefixed routes serve the caller's own agent.
    expect((await api(base, a, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect((await api(base, b, 'rdv_status')).body.result.agent_id).toBe(ids.kids);
    // /a/<name>/ only to that agent's own principals; an unknown agent is not found.
    expect((await api(`${base}/a/omer`, a, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    const cross = await api(`${base}/a/omer`, b, 'rdv_status');
    expect(cross.status).toBe(403);
    expect(cross.body.code).toBe('wrong_agent');
    expect(cross.text).not.toContain(ids.omer);
    expect((await api(`${base}/a/omer`, b, 'rdv_inbox', { since: 0 })).status).toBe(403);
    expect((await api(`${base}/a/nobody`, a, 'rdv_status')).status).toBe(404);
    expect((await fetch(`${base}/a/kids/api/v1/tools`, { headers: { authorization: `Bearer ${a}` } })).status).toBe(403);
    expect((await fetch(`${base}/a/kids/approve`)).status).toBe(404);

    // MCP: the same, on the agent's own URL and on /mcp.
    const mb = await mcpClient(`${base}/a/kids`, b);
    expect((await callJson(mb, 'rdv_status')).json.agent_id).toBe(ids.kids);
    const ma = await mcpClient(base, a);
    expect((await callJson(ma, 'rdv_status')).json.agent_id).toBe(ids.omer);
    await expect(mcpClient(`${base}/a/kids`, a)).rejects.toThrow();
    // A session opened by one token is no session for another.
    const init = await fetch(`${base}/a/kids/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    });
    const sid = init.headers.get('mcp-session-id')!;
    expect(sid).toBeTruthy();
    const hijack = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a}`, 'mcp-session-id': sid, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(404);
    await ma.close();
    await mb.close();

    // An approval asked through omer's token is omer's: its own list, its page names omer and its fingerprint.
    const asked = await api(base, a, 'rdv_invite', { action: 'create' });
    expect(asked.body.result.status).toBe('awaiting_human');
    const url = asked.body.result.approve_url as string;
    expect(gw.agent('omer')!.approvals.list()).toHaveLength(1);
    expect(gw.agent('kids')!.approvals.list()).toHaveLength(0);
    const br = new Browser(base);
    const path = new URL(url).pathname;
    await br.unlock('/approve');
    const list = await br.get('/approve');
    const fpOmer = gw.agent('omer')!.fingerprint!;
    const fpKids = gw.agent('kids')!.fingerprint!;
    expect(list.text).toContain('This gateway serves 2 agents');
    expect(list.text).toContain(fpOmer);
    expect(list.text).toContain(fpKids);
    // Listed under omer's section, not kids'.
    const kidsSection = list.text.slice(list.text.indexOf('<b>kids</b>'), list.text.indexOf('<b>omer</b>'));
    expect(kidsSection).toContain('Nothing waits for you.');
    expect(list.text.slice(list.text.indexOf('<b>omer</b>'))).toContain(path);
    const page = await br.get(path);
    expect(page.text).toContain('For your agent <span class="agent"><b>omer</b>');
    expect(page.text).toContain(fpOmer);
    expect(page.text).not.toContain(fpKids);
    const done = await br.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '2', f_name: 'Omer', f_label: '' });
    expect(done.status).toBe(200);
    expect(done.text).toContain('<b>omer</b>');
    const link = /<pre class="msg">(https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+)<\/pre>/.exec(done.text)?.[1];
    expect(link).toBeTruthy();
    const secret = link!.split('#')[1];

    // Omer's inbox has the approval; kids' inbox, events file and tools never see it, nor the link.
    const ev = await waitApi(base, a, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval event');
    const kidsEvents = await events(base, b);
    expect(kidsEvents.some((e) => e.type === 'approval')).toBe(false);
    expect(JSON.stringify(kidsEvents)).not.toContain(ev.approval_id);
    const kidsLog = join(root, 'agents', 'kids', 'events.jsonl');
    if (existsSync(kidsLog)) expect(readFileSync(kidsLog, 'utf8')).not.toContain(ev.approval_id);
    expect(readFileSync(join(root, 'agents', 'omer', 'events.jsonl'), 'utf8')).toContain(ev.approval_id);
    const stolen = await api(base, b, 'rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect(JSON.stringify(stolen.body)).not.toContain(secret);
    expect(JSON.stringify(stolen.body)).toMatch(/nothing is held/);
    expect((await api(`${base}/a/omer`, b, 'rdv_invite', { action: 'link', approval_id: ev.approval_id })).status).toBe(403);
    expect((await api(base, a, 'rdv_invite', { action: 'link', approval_id: ev.approval_id })).body.result.url).toBe(link);
    expect(JSON.stringify(await events(base, b))).not.toContain(secret);
  });

  it('both agents listen in one process and exchange messages over the relay', { timeout: 90_000 }, async () => {
    const { gw, base, ids } = await multi(['kids', 'omer']);
    const a = await tok(gw, 'omer', ['read', 'send', 'contact:request']);
    const b = await tok(gw, 'kids', ['read', 'send', 'contact:request']);
    // Each agent holds its own listener lock.
    for (const name of ['kids', 'omer']) expect(existsSync(join(root, 'agents', name, 'listener.lock'))).toBe(true);
    const pub = await api(base, a, 'rdv_publish_card');
    expect(pub.status, pub.text).toBe(200);
    const req = await api(`${base}/a/kids`, b, 'rdv_request_contact', { target: ids.omer, greeting: 'Hi from the kids' });
    expect(req.status, req.text).toBe(200);
    const ask = await waitApi(base, a, (e) => e.type === 'contact_request', 'the contact request at omer', 30_000);
    expect(ask.agent_id ?? ask.from).toBe(ids.kids);
    const g = await api(base, a, 'rdv_grant', { request_id: ask.request_id });
    expect(g.body.result.status).toBe('awaiting_human');
    const br = new Browser(base);
    const path = new URL(g.body.result.approve_url).pathname;
    await br.unlock(path);
    const page = await br.get(path);
    expect(page.text).toContain('For your agent <span class="agent"><b>omer</b>');
    const done = await br.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_label: 'Kids' });
    expect(done.text).toContain('Approved');
    await waitApi(base, b, (e) => e.type === 'contact', 'the contact at kids', 30_000);
    const sent = await api(base, b, 'rdv_send', { agent_id: ids.omer, payload: { type: 'note', text: 'Dinner at six?' } });
    expect(sent.status, sent.text).toBe(200);
    const atOmer = await waitApi(base, a, (e) => e.type === 'message', 'the message at omer', 30_000);
    expect(JSON.stringify(atOmer)).toContain('Dinner at six?');
    await api(base, a, 'rdv_send', { to: 'Kids', payload: { type: 'note', text: 'Yes!' } });
    const atKids = await waitApi(base, b, (e) => e.type === 'message', 'the message at kids', 30_000);
    expect(JSON.stringify(atKids)).toContain('Yes!');
    // Neither saw the other's side of it as its own: kids never got omer's approval event.
    expect((await events(base, b)).some((e) => e.type === 'approval')).toBe(false);
  });

  it('refuses two folders holding one identity, and a shared calendar', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-multi-'));
    await initHome(new Home(join(root, 'agents', 'omer')), { profile: 'omer', relays: [relay.url], emails: [email('omer')] });
    await initHome(new Home(join(root, 'agents', 'kids')), { profile: 'kids', relays: [relay.url], emails: [email('kids')] });
    expect(() => new Gateway({ home: new Home(root), port: 0, calendar: join(root, 'cal.json') })).toThrow(/say whose calendar/);
    expect(() => new Gateway({ home: new Home(root), port: 0, calendar: { dana: join(root, 'cal.json') } })).toThrow(/not an agent here/);
    cpSync(join(root, 'agents', 'omer'), join(root, 'agents', 'twin'), { recursive: true });
    const gw = new Gateway({ home: new Home(root), port: 0, humanLog: () => {} });
    await gw.store.setPin(PIN);
    await expect(gw.start()).rejects.toThrow(/same identity/);
  });
});

// --- OAuth ---------------------------------------------------------------------------

const REDIRECT = 'https://client.example/oauth/callback';

async function connect(base: string, br: Browser, resource: string | undefined, choose?: string): Promise<{ status: number; text: string; token?: string }> {
  const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const u = new URL(`${base}/oauth/authorize`);
  const q = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read send', state: 'st', ...(resource ? { resource } : {}) };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const r = await br.get(u.toString());
  expect(r.status, r.text).toBe(303);
  const path = r.headers.get('location')!;
  if ((await br.get(path)).text.includes('name="pin"')) await br.unlock(path);
  const page = await br.get(path);
  const form: Record<string, string> = { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', s_read: '1', s_send: '1', ...(choose !== undefined ? { agent: choose } : {}) };
  const back = await br.post(path, form);
  if (back.status !== 303) return { status: back.status, text: page.text + back.text };
  const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
  const t = await (
    await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.client_id, ...(resource ? { resource } : {}) }).toString(),
    })
  ).json();
  expect(t.access_token, JSON.stringify(t)).toBeTruthy();
  return { status: 200, text: page.text, token: t.access_token };
}

describe('one gateway, two agents: OAuth', () => {
  it('a grant reaches the one agent its resource names, or the one the owner picks; metadata per agent', { timeout: 60_000 }, async () => {
    const { base, ids } = await multi(['kids', 'omer']);
    // Per-agent protected-resource metadata, and the 401 challenge under /a/<name>/ points to it.
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/a/kids/mcp`)).json();
    expect(prm.resource).toBe(`${base}/a/kids/mcp`);
    expect(prm.authorization_servers).toEqual([base]);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/a/nobody/mcp`)).status).toBe(404);
    const unauth = await fetch(`${base}/a/kids/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/a/kids/mcp"`);

    // 1. The client connects to kids' URL: the page fixes the agent to kids; the grant reaches kids only.
    const br = new Browser(base);
    const k = await connect(base, br, `${base}/a/kids/mcp`);
    expect(k.text).toContain('It reaches only your agent <span class="agent"><b>kids</b>');
    expect((await api(`${base}/a/kids`, k.token, 'rdv_status')).body.result.agent_id).toBe(ids.kids);
    expect((await api(base, k.token, 'rdv_status')).body.result.agent_id).toBe(ids.kids);
    expect((await api(`${base}/a/omer`, k.token, 'rdv_status')).status).toBe(403);
    const grants = new OAuthStore(new Home(root)).list().grants;
    expect(grants).toHaveLength(1);
    expect(grants[0].agent).toBe('kids');

    // 2. A forged post naming another agent than the one asked for approves nothing.
    const forged = await connect(base, br, `${base}/a/kids/mcp`, 'omer');
    expect(forged.status).toBe(409);
    expect(forged.text).toContain('asked for another agent');

    // 3. At the gateway's own /mcp the owner must pick: nothing is preselected; then the grant reaches that one.
    const none = await connect(base, br, `${base}/mcp`, '');
    expect(none.status).toBe(409);
    expect(none.text).toContain('<option value="" selected>Choose an agent</option>');
    expect(none.text).toContain('Choose the agent it connects to.');
    const o = await connect(base, br, undefined, 'omer');
    expect((await api(base, o.token, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect((await api(`${base}/a/kids`, o.token, 'rdv_status')).status).toBe(403);
  });
});

// --- backward compatibility, migration and the agent commands ------------------------------

describe('a gateway from before multi-agent, and its migration', () => {
  it('a single-home root keeps working unchanged; a token made before reaches only the root agent', { timeout: 60_000 }, async () => {
    const { gw, base, ids } = await multi([], { legacy: 'omer' });
    expect(gw.agents.map((a) => [a.name, a.root])).toEqual([['omer', true]]);
    // A token from before NOTES 104 has no agent: it reaches the root agent.
    const old = await tok(gw, undefined, ['read']);
    expect(new GatewayStore(new Home(root)).listTokens()[0].agent).toBeUndefined();
    expect((await api(base, old, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect((await api(`${base}/a/omer`, old, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    const st = await mcpClient(base, old);
    expect((await callJson(st, 'rdv_status')).json.agent_id).toBe(ids.omer);
    await st.close();
    // The single-agent page reads as before, with the agent named.
    const br = new Browser(base);
    await br.unlock('/approve');
    const list = await br.get('/approve');
    expect(list.text).toContain('Waiting for you');
    expect(list.text).toContain('<b>omer</b>');
    await gw.close();

    // An agent added beside the root home: the old token still reaches only the root agent.
    await initHome(new Home(join(root, 'agents', 'kids')), { profile: 'kids', relays: [relay.url], emails: [email('kids')] });
    const gw2 = new Gateway({ home: new Home(root), port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    gws.push(gw2);
    const base2 = await gw2.start();
    expect(gw2.agents.map((a) => a.name)).toEqual(['omer', 'kids']);
    expect((await api(base2, old, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect((await api(`${base2}/a/kids`, old, 'rdv_status')).status).toBe(403);
  });

  it('agent migrate moves the root agent into agents/<name>/, keeps the originals, and its tokens follow it', { timeout: 90_000 }, async () => {
    const { gw, ids } = await multi([], { legacy: 'omer' });
    const old = await tok(gw, undefined, ['read']);
    // Refused while the gateway listens for the root home.
    const busy = await bin(['agent', 'migrate', '--home', root]);
    expect(busy.code).not.toBe(0);
    expect(busy.stderr).toMatch(/is running for/);
    expect(existsSync(join(root, 'agents'))).toBe(false);
    await gw.close();
    gws = [];

    const keyBefore = readFileSync(join(root, 'agent.json'));
    const m = await bin(['agent', 'migrate', '--home', root]);
    expect(m.code, m.stderr).toBe(0);
    expect(m.stderr).toContain('Moved the root agent');
    expect(readFileSync(join(root, 'agents', 'omer', 'agent.json')).equals(keyBefore)).toBe(true);
    expect(existsSync(join(root, 'agent.json'))).toBe(false);
    // The originals are kept, the key among them; the gateway's own files stay in the root.
    const kept = readdirSync(root).find((f) => f.startsWith('.premigrate-'))!;
    expect(readFileSync(join(root, kept, 'agent.json')).equals(keyBefore)).toBe(true);
    expect(existsSync(join(root, 'gateway.json'))).toBe(true);
    expect(new GatewayStore(new Home(root)).listTokens()[0].agent).toBe('omer');
    // A second migrate finds nothing to move.
    expect((await bin(['agent', 'migrate', '--home', root])).stderr).toMatch(/no agent in the root/);

    const gw2 = new Gateway({ home: new Home(root), port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    gws.push(gw2);
    const base2 = await gw2.start();
    expect(gw2.agents.map((a) => [a.name, a.root])).toEqual([['omer', false]]);
    expect((await api(base2, old, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect((await api(`${base2}/a/omer`, old, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
  });

  it('agent add (new and --restore), token create --agent, list, remove: refused while bound, kept with its key', { timeout: 120_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-multi-'));
    const h = ['--home', root];
    const add = await bin(['agent', 'add', 'omer', 'new', '--email', email('omer'), '--relay', relay.url, ...h]);
    expect(add.code, add.stderr).toBe(0);
    expect(add.stderr).toContain('Added agent omer');
    expect((await bin(['agent', 'add', 'omer', 'new', '--email', email('x'), ...h])).stderr).toMatch(/exists already/);
    expect((await bin(['agent', 'add', 'Bad.Name', 'new', ...h])).stderr).toMatch(/invalid agent name/);
    expect((await bin(['agent', 'add', 'kids', ...h])).stderr).toMatch(/exactly one of "new"/);

    // Restore: from a backup, as a new agent; the same identity a second time is refused.
    const src = new Home(join(mkdtempSync(join(tmpdir(), 'rdv-gw-src-')), 'kids'));
    const kidsId = (await initHome(src, { profile: 'kids', relays: [relay.url], emails: [email('kids')] })).id;
    const pass = 'correct horse battery staple 42';
    const file = writeBackupFile(src, join(tmpdir(), `rdv-gw-kids-${process.pid}-${n}.rdvbackup`), await createBackup(src, pass));
    try {
      const r = await bin(['agent', 'add', 'kids', '--restore', file, '--stdin', ...h], `${pass}\n`);
      expect(r.code, r.stderr).toBe(0);
      expect(new Home(join(root, 'agents', 'kids')).readAgentState().card.id).toBe(kidsId);
      const twin = await bin(['agent', 'add', 'kids2', '--restore', file, '--stdin', ...h], `${pass}\n`);
      expect(twin.code).not.toBe(0);
      expect(twin.stderr).toMatch(/serves already/);
      expect(existsSync(join(root, 'agents', 'kids2', 'agent.json'))).toBe(false);
    } finally {
      rmSync(file, { force: true });
      rmSync(src.dir, { recursive: true, force: true });
    }

    // Tokens: with two agents, --agent is required and must name one.
    expect((await bin(['token', 'create', '--name', 'x', '--scope', 'read', ...h])).stderr).toMatch(/--agent <name>/);
    expect((await bin(['token', 'create', '--name', 'x', '--scope', 'read', '--agent', 'dana', ...h])).stderr).toMatch(/no agent "dana"/);
    const t = await bin(['token', 'create', '--name', 'kids-claude', '--scope', 'read', '--agent', 'kids', ...h]);
    expect(t.code, t.stderr).toBe(0);
    expect(t.stdout).toMatch(/^rdvg_/);
    expect((await bin(['token', 'list', ...h])).stdout).toContain('agent kids');
    const listed = (await bin(['agent', 'list', ...h])).stdout;
    expect(listed).toMatch(/^kids {2}rdv1:\S+ {2}\S+ .*tokens 1 {2}oauth grants 0$/m);
    expect(listed).toMatch(/^omer .*tokens 0/m);

    // Remove: refused while a token is bound; --force revokes it and keeps the folder, key and all.
    const keyBefore = readFileSync(join(root, 'agents', 'kids', 'agent.json'));
    const refused = await bin(['agent', 'remove', 'kids', ...h]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/still has 1 token/);
    expect(existsSync(join(root, 'agents', 'kids', 'agent.json'))).toBe(true);
    const removed = await bin(['agent', 'remove', 'kids', '--force', ...h]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(removed.stderr).toContain('WITH ITS KEY');
    expect(existsSync(join(root, 'agents', 'kids'))).toBe(false);
    const parked = readdirSync(join(root, 'agents', '.removed'));
    expect(parked).toHaveLength(1);
    expect(readFileSync(join(root, 'agents', '.removed', parked[0], 'agent.json')).equals(keyBefore)).toBe(true);
    expect(new GatewayStore(new Home(root)).listTokens()).toHaveLength(0);
    expect(new AgentRoot(root).list().map((a) => a.name)).toEqual(['omer']);
  });

  it('agent remove is refused while the gateway listens for that agent, and for the root agent', { timeout: 60_000 }, async () => {
    const { gw } = await multi(['kids'], { legacy: 'omer' });
    const r = await bin(['agent', 'remove', 'kids', '--home', root]);
    expect(r.stderr).toMatch(/is running for/);
    expect((await bin(['agent', 'remove', 'omer', '--home', root])).stderr).toMatch(/root agent/);
  });
});
