// The owner's gateway settings page (issue #102 item 7, NOTES 110): tokens,
// connected apps, the PIN and webhooks behind the approval page's PIN unlock,
// session and CSRF token. No bearer token reaches it, whatever its scopes, and
// no tool or REST route administers the gateway. Changes apply to the running
// gateway at once, and share the terminal's locks.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home, initHome } from '@rendezvous/cli/lib';
import { afterEach, describe, expect, it } from 'vitest';
import { clientRef, Gateway, NotifyStore, ROOT_BINDING, SCOPES, secretFileName } from '../src/index.js';
import { api, Browser, gatewayArgv, hidden, mcpClient, PIN, rawRequest, startGateway, type TestGateway } from './helpers.js';

let root: string;
let gws: Gateway[] = [];
afterEach(async () => {
  for (const g of gws) await g.close().catch(() => {});
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

async function one(): Promise<TestGateway> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-admin-'));
  const g = await startGateway(join(root, 'omer'));
  gws.push(g.gw);
  return g;
}

async function owner(base: string): Promise<{ b: Browser; csrf: string; page: string }> {
  const b = new Browser(base);
  const u = await b.unlock('/approve/admin');
  expect(u.status).toBe(303);
  expect(u.headers.get('location')).toBe('/approve/admin');
  const page = await b.get('/approve/admin');
  expect(page.status).toBe(200);
  return { b, csrf: hidden(page.text, 'csrf'), page: page.text };
}

/** A connected OAuth app with one grant for `agent` (as the consent page would have made it). */
async function oauthGrant(gw: Gateway, base: string, agent: string, agentId: string, name = 'Chat <b>Helper</b>') {
  const clientId = `rdvcl_test${Math.random().toString(36).slice(2)}`;
  const meta = { clientId, ref: clientRef(clientId), name, redirectUris: ['https://chat.example/cb'], authMethod: 'none' as const, created: new Date().toISOString() };
  const now = Date.now();
  return gw.oauth.store.createGrant(meta, ['read'], `${base}/mcp`, now, now, undefined, agent, agentId);
}

const tokenCount = (g: TestGateway) => g.gw.store.listTokens().length;

describe('gateway settings page: the owner only', () => {
  it('shows nothing before the PIN; a post without the session is refused', async () => {
    const g = await one();
    await g.token(['read'], 'existing-token');
    const b = new Browser(g.base);
    const locked = await b.get('/approve/admin');
    expect(locked.status).toBe(200);
    expect(locked.text).toContain('Enter your gateway PIN');
    expect(locked.text).not.toContain('existing-token');
    expect(hidden(locked.text, 'next')).toBe('/approve/admin');
    const post = await b.post('/approve/admin/token/create', { agent: 'omer', name: 'x', s_read: '1', pin: PIN, csrf: 'x' });
    expect(post.status).toBe(401);
    expect(tokenCount(g)).toBe(1);
  });

  it('no bearer token reaches it, with every scope: refused with or without the owner cookie; no admin tool or REST route exists', async () => {
    const g = await one();
    const all = await g.token([...SCOPES], 'all-scopes');
    const bearer = { authorization: `Bearer ${all}` };
    // Even riding on the owner's own unlocked session (and its CSRF token), a request carrying a bearer is refused.
    const { b, csrf } = await owner(g.base);
    for (const [path, form] of [
      ['/approve/admin', undefined],
      ['/approve/admin/token/create', { agent: 'omer', name: 'stolen', s_read: '1', s_send: '1', pin: PIN, csrf }],
      ['/approve/admin/token/revoke', { agent: 'omer', id: g.gw.store.listTokens()[0].id, csrf }],
      ['/approve/admin/pin', { current: PIN, next: 'new-pin-7731', again: 'new-pin-7731', csrf }],
      ['/approve/admin/notify/clear', { agent: 'omer', csrf }],
      ['/approve/admin/oauth/revoke', { agent: '*', id: 'cli_000000000000000000000000', csrf }],
    ] as const) {
      const cookie = [...b.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const r = form
        ? await b.post(path, form, bearer)
        : await fetch(new URL(path, g.base), { headers: { ...bearer, cookie } }).then(async (x) => ({ status: x.status, text: await x.text() }));
      expect(r.status, path).toBe(403);
      expect(r.text).not.toContain('all-scopes');
    }
    expect(g.gw.store.listTokens().map((t) => t.name)).toEqual(['all-scopes']);
    expect(await g.gw.store.checkPin(PIN, Date.now())).toEqual({ ok: true });
    expect(g.log.some((l) => /Authorization header was refused on the gateway settings page/.test(l))).toBe(true);

    // The bearer alone (no cookie) gets the same refusal, not an unlock form.
    expect((await fetch(new URL('/approve/admin', g.base), { headers: bearer })).status).toBe(403);
    // Under an agent's URL there is no settings page at all.
    expect((await fetch(new URL('/a/omer/approve/admin', g.base), { headers: bearer })).status).toBe(404);

    // No tool and no REST route administers the gateway.
    const ADMIN = /token|pin|admin|oauth|webhook|notify|gateway/i;
    const list = await fetch(new URL('/api/v1/tools', g.base), { headers: bearer });
    const names = ((await list.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => ADMIN.test(n))).toEqual([]);
    for (const tool of ['rdv_admin', 'rdv_token', 'rdv_tokens', 'rdv_pin', 'rdv_notify', 'rdv_oauth', 'rdv_gateway']) {
      expect((await api(g.base, all, tool, { action: 'create', name: 'x', scopes: ['read'] })).status, tool).toBe(404);
    }
    const mcp = await mcpClient(g.base, all);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    await mcp.close();
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.filter((n) => ADMIN.test(n))).toEqual([]);
    expect(tokenCount(g)).toBe(1);
  });

  it('every post needs the session CSRF token and a same-origin request', async () => {
    const g = await one();
    const { b, csrf } = await owner(g.base);
    const form = { agent: 'omer', name: 'helper', s_read: '1', pin: PIN, csrf };
    expect((await b.post('/approve/admin/token/create', { ...form, csrf: 'forged' })).status).toBe(403);
    expect((await b.post('/approve/admin/token/create', form, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await b.post('/approve/admin/token/create', form, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // DNS rebinding: a foreign Host is refused before anything.
    const rebound = await rawRequest(g.base, '/approve/admin', { host: 'evil.example:80' });
    expect(rebound.status).toBe(421);
    expect(tokenCount(g)).toBe(0);
  });
});

describe('gateway settings page: tokens', () => {
  it('lists tokens without their value or hash; makes one (PIN again, nothing ticked by default) shown once; it works at once', async () => {
    const g = await one();
    const old = await g.token(['read', 'send'], 'old-assistant');
    const { b, csrf, page } = await owner(g.base);
    const stored = readFileSync(join(g.home.dir, 'gateway.json'), 'utf8');
    const hash = (JSON.parse(stored) as { tokens: Record<string, { hash: string }> }).tokens;
    expect(page).toContain('old-assistant');
    expect(page).toContain('read, send');
    expect(page).not.toContain(old);
    for (const t of Object.values(hash)) expect(page).not.toContain(t.hash);
    expect(page).not.toMatch(/name="s_[^"]+" value="1" checked/);
    expect(page).not.toContain('<script');

    // Wrong PIN, no scope, a bad name: nothing made.
    const form = { agent: 'omer', name: 'claude-ai', s_read: '1', s_negotiate: '1', pin: PIN, csrf };
    const wrong = await b.post('/approve/admin/token/create', { ...form, pin: 'not-the-pin' });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('No token was made');
    expect(g.log.some((l) => l.includes('wrong PIN was entered on the gateway settings page (token create)'))).toBe(true);
    const { s_read: _r, s_negotiate: _n, ...noScopes } = form;
    expect((await b.post('/approve/admin/token/create', noScopes)).status).toBe(400);
    expect((await b.post('/approve/admin/token/create', { ...form, name: '<b>x</b>' })).status).toBe(400);
    expect((await b.post('/approve/admin/token/create', { ...form, agent: 'nobody' })).status).toBe(400);
    expect((await b.post('/approve/admin/token/create', { ...noScopes, s_approve: '1', s_admin: '1' })).status).toBe(400);
    expect(tokenCount(g)).toBe(1);

    const made = await b.post('/approve/admin/token/create', form);
    expect(made.status).toBe(200);
    expect(made.headers.get('cache-control')).toMatch(/no-store/);
    expect(made.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const value = /<pre class="msg">(rdvg_[A-Za-z0-9_-]+)<\/pre>/.exec(made.text)?.[1];
    expect(value).toBeDefined();
    const info = g.gw.store.listTokens().find((t) => t.name === 'claude-ai')!;
    expect(info.scopes).toEqual(['read', 'negotiate']);
    expect(info.agent).toBe(ROOT_BINDING);
    expect(info.agentId).toBe(g.gw.primary.id);
    // It works on the running gateway at once, with its scopes only.
    expect((await api(g.base, value!, 'rdv_status')).status).toBe(200);
    expect((await api(g.base, value!, 'rdv_send', { agent_id: 'rdv1:x', payload: { type: 'note' } })).status).toBe(403);
    // Never logged, never shown again.
    expect(g.log.join('\n')).not.toContain(value!);
    expect(g.log.some((l) => l.includes(`admin: token ${info.id} ("claude-ai") made for agent omer, scopes read, negotiate`))).toBe(true);
    const after = await b.get('/approve/admin');
    expect(after.text).toContain('claude-ai');
    expect(after.text).not.toContain(value!);
    // A replayed post makes no second token (names are unique).
    expect((await b.post('/approve/admin/token/create', form)).status).toBe(400);
    expect(tokenCount(g)).toBe(2);
  });

  it('revokes a token for its own agent only; the running gateway refuses it at once', async () => {
    const g = await one();
    const t = await g.token(['read'], 'to-revoke');
    const id = g.gw.store.listTokens()[0].id;
    expect((await api(g.base, t, 'rdv_status')).status).toBe(200);
    const { b, csrf } = await owner(g.base);
    // Under another agent, or as an orphan, it is not found: nothing revoked.
    expect((await b.post('/approve/admin/token/revoke', { agent: 'kids', id, csrf })).status).toBe(404);
    expect((await b.post('/approve/admin/token/revoke', { agent: '-', id, csrf })).status).toBe(404);
    expect((await api(g.base, t, 'rdv_status')).status).toBe(200);
    const r = await b.post('/approve/admin/token/revoke', { agent: 'omer', id, csrf });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Revoked');
    expect((await api(g.base, t, 'rdv_status')).status).toBe(401);
    expect(g.log.some((l) => l.includes(`admin: token ${id} ("to-revoke") of agent omer revoked`))).toBe(true);
    expect((await b.post('/approve/admin/token/revoke', { agent: 'omer', id, csrf })).status).toBe(404);
  });

  it("a token the terminal makes at the same moment as the page's: both kept (the same lock)", { timeout: 60_000 }, async () => {
    const g = await one();
    const { b, csrf } = await owner(g.base);
    const cli = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, gatewayArgv(['token', 'create', '--name', 'from-terminal', '--scope', 'read', '--home', g.home.dir]), { timeout: 50_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
      );
      child.stdin!.end();
    });
    const pages = Promise.all(
      Array.from({ length: 5 }, (_, i) => b.post('/approve/admin/token/create', { agent: 'omer', name: `from-page-${i}`, s_read: '1', pin: PIN, csrf })),
    );
    const [c, p] = await Promise.all([cli, pages]);
    expect(c.code, c.stderr).toBe(0);
    for (const r of p) expect(r.status).toBe(200);
    const names = g.gw.store.listTokens().map((t) => t.name).sort();
    expect(names).toEqual(['from-page-0', 'from-page-1', 'from-page-2', 'from-page-3', 'from-page-4', 'from-terminal']);
    // The terminal's token works on the running gateway too.
    expect((await api(g.base, c.stdout.trim(), 'rdv_status')).status).toBe(200);
  });
});

describe('gateway settings page: connected apps, webhooks, PIN', () => {
  it('lists connected apps as untrusted text and disconnects a grant or removes an app; the gateway refuses their tokens at once', async () => {
    const g = await one();
    const id = g.gw.primary.id!;
    const a = await oauthGrant(g.gw, g.base, ROOT_BINDING, id);
    const c = await oauthGrant(g.gw, g.base, ROOT_BINDING, id, 'Other App');
    expect((await api(g.base, a.accessToken, 'rdv_status')).status).toBe(200);
    const { b, csrf, page } = await owner(g.base);
    expect(page).toContain('Chat &lt;b&gt;Helper&lt;/b&gt;');
    expect(page).not.toContain('<b>Helper</b>');
    expect(page).toContain(a.grant.id);
    expect(page).toContain('chat.example');
    expect(page).not.toContain(a.accessToken);
    expect(page).not.toContain(a.refreshToken);
    // Bound to its agent: not under another.
    expect((await b.post('/approve/admin/oauth/revoke', { agent: 'kids', id: a.grant.id, csrf })).status).toBe(404);
    const r = await b.post('/approve/admin/oauth/revoke', { agent: 'omer', id: a.grant.id, csrf });
    expect(r.status).toBe(200);
    expect((await api(g.base, a.accessToken, 'rdv_status')).status).toBe(401);
    expect((await api(g.base, c.accessToken, 'rdv_status')).status).toBe(200);
    // A whole app.
    const ref = c.grant.clientId;
    expect((await b.post('/approve/admin/oauth/revoke', { agent: 'omer', id: ref, csrf })).status).toBe(404);
    const rm = await b.post('/approve/admin/oauth/revoke', { agent: '*', id: ref, csrf });
    expect(rm.status).toBe(200);
    expect((await api(g.base, c.accessToken, 'rdv_status')).status).toBe(401);
    expect(g.gw.oauth.store.list().clients.map((x) => x.id)).not.toContain(ref);
    expect(g.log.some((l) => l.includes(`admin: OAuth client ${ref} and its 1 grant(s) removed`))).toBe(true);
  });

  it('shows the webhook (scheme and host only, never the secret) and turns it off; setting one stays in the terminal', async () => {
    const g = await one();
    const notify = new NotifyStore(g.home);
    const secret = 'rdv-admin-test-secret-0123456789abcdef';
    await notify.set(ROOT_BINDING, { url: 'https://hooks.example/p/receiver-own-token-998877', events: ['invite_redeemed', 'message'], insecureHosts: [] }, Buffer.from(secret), 0, new Date(), g.gw.primary.id);
    const kept = join(g.home.dir, secretFileName(ROOT_BINDING));
    expect(existsSync(kept)).toBe(true);
    const { b, csrf, page } = await owner(g.base);
    expect(page).toContain('https://hooks.example');
    expect(page).toContain('invite_redeemed, message');
    expect(page).not.toContain('receiver-own-token-998877');
    expect(page).not.toContain(secret);
    expect(page).toContain('rdv-gateway notify set omer');
    expect(page).not.toMatch(/action="\/approve\/admin\/notify\/set"/);
    expect((await b.post('/approve/admin/notify/set', { agent: 'omer', url: 'https://x.example', csrf })).status).toBe(404);
    expect((await b.post('/approve/admin/notify/clear', { agent: 'kids', csrf })).status).toBe(400);
    const r = await b.post('/approve/admin/notify/clear', { agent: 'omer', csrf });
    expect(r.status).toBe(200);
    expect(r.text).toContain('posts nothing now');
    expect(notify.config(ROOT_BINDING)).toBeUndefined();
    expect(existsSync(kept)).toBe(false);
    expect(g.log.some((l) => l.includes('admin: the webhook of agent omer was turned off'))).toBe(true);
    expect(g.log.join('\n')).not.toContain(secret);
  });

  it('changes the PIN with the current one; a weak or mismatched one spends no attempt; every session ends', async () => {
    const g = await one();
    const { b, csrf } = await owner(g.base);
    const other = await owner(g.base);
    const NEW = 'new-pin-7731';
    expect((await b.post('/approve/admin/pin', { current: PIN, next: NEW, again: 'different-1', csrf })).status).toBe(400);
    expect((await b.post('/approve/admin/pin', { current: 'whatever', next: '111111', again: '111111', csrf })).status).toBe(400);
    expect((JSON.parse(readFileSync(join(g.home.dir, 'gateway.json'), 'utf8')) as { lockout: { failures: number } }).lockout.failures).toBe(0);
    const wrong = await b.post('/approve/admin/pin', { current: 'not-the-pin', next: NEW, again: NEW, csrf });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('Nothing changed');
    expect((JSON.parse(readFileSync(join(g.home.dir, 'gateway.json'), 'utf8')) as { lockout: { failures: number } }).lockout.failures).toBe(1);
    expect(await g.gw.store.checkPin(PIN, Date.now())).toEqual({ ok: true });

    const done = await b.post('/approve/admin/pin', { current: PIN, next: NEW, again: NEW, csrf });
    expect(done.status).toBe(200);
    expect(done.text).toContain('Your PIN is changed');
    expect(g.log.some((l) => l.includes('admin: the PIN was changed'))).toBe(true);
    expect(g.log.join('\n')).not.toContain(NEW);
    // Both sessions are over; the old PIN no longer unlocks, the new one does.
    expect((await b.get('/approve/admin')).text).toContain('Enter your gateway PIN');
    expect((await other.b.get('/approve/admin')).text).toContain('Enter your gateway PIN');
    expect((await new Browser(g.base).unlock('/approve/admin', PIN)).status).toBe(403);
    expect((await new Browser(g.base).unlock('/approve/admin', NEW)).status).toBe(303);
  });
});

describe('gateway settings page: several agents', () => {
  it('lists each agent apart; makes a token for the agent chosen; refuses an action under another agent', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-admin-multi-'));
    const ids: Record<string, string> = {};
    for (const name of ['kids', 'omer']) ids[name] = (await initHome(new Home(join(root, 'agents', name)), { profile: name, emails: [`${name}.${process.pid}@example.com`] })).id;
    const log: string[] = [];
    const gw = new Gateway({ home: new Home(root), port: 0, humanLog: (l) => log.push(l), pollMs: 150, sweepMs: 3_600_000 });
    gws.push(gw);
    await gw.store.setPin(PIN);
    const base = await gw.start();
    const kidsTok = (await gw.store.createToken('kids-assistant', ['read'], 'kids', ids.kids)).info.id;
    // An orphan: bound to an agent not served here.
    const gone = (await gw.store.createToken('orphan', ['read'], 'removed')).info.id;
    const { b, csrf, page } = await owner(base);
    expect(page).toContain('kids-assistant');
    expect(page).toContain('Reaching no agent here');
    expect(page.indexOf('kids-assistant')).toBeLessThan(page.indexOf('<b>omer</b>'));

    const made = await b.post('/approve/admin/token/create', { agent: 'omer', name: 'omer-assistant', s_read: '1', pin: PIN, csrf });
    expect(made.status).toBe(200);
    const value = /<pre class="msg">(rdvg_[A-Za-z0-9_-]+)<\/pre>/.exec(made.text)![1];
    expect((await api(base, value, 'rdv_status')).body.result.agent_id).toBe(ids.omer);
    expect(gw.store.listTokens().find((t) => t.name === 'omer-assistant')).toMatchObject({ agent: 'omer', agentId: ids.omer });

    // The kids' token is not revoked by a form that says omer; the orphan only as an orphan.
    expect((await b.post('/approve/admin/token/revoke', { agent: 'omer', id: kidsTok, csrf })).status).toBe(404);
    expect((await b.post('/approve/admin/token/revoke', { agent: 'kids', id: gone, csrf })).status).toBe(404);
    expect((await b.post('/approve/admin/token/revoke', { agent: '-', id: gone, csrf })).status).toBe(200);
    expect((await b.post('/approve/admin/token/revoke', { agent: 'kids', id: kidsTok, csrf })).status).toBe(200);
    expect(gw.store.listTokens().map((t) => t.name)).toEqual(['omer-assistant']);
    expect(log.some((l) => l.includes(`token ${gone} ("orphan") of no agent served here revoked`))).toBe(true);
  });
});
