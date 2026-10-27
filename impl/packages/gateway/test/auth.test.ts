// Tokens, scopes and hardening: who may call what, and what never leaves.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home, tryLongLock } from '@rendezvous/cli/lib';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authorizeCall, Gateway, GatewayStore, PIN_FREE_TRIES, requiredScope } from '../src/index.js';
import { api, callJson, mcpClient, PIN, rawRequest, startGateway, type TestGateway } from './helpers.js';

let relay: TestRelay;
let root: string;
let gws: TestGateway[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const g of gws) await g.gw.close();
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

async function gateway(opts: Parameters<typeof startGateway>[1] = {}): Promise<TestGateway> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], ...opts });
  gws.push(g);
  return g;
}

describe('scopes', () => {
  it('maps every call to one scope, deny by default, and no scope approves', () => {
    expect(requiredScope('rdv_status', {})).toBe('read');
    expect(requiredScope('rdv_send', {})).toBe('send');
    expect(requiredScope('rdv_negotiate', {})).toBe('negotiate');
    expect(requiredScope('rdv_negotiate', { action: 'status' })).toBe('read');
    expect(requiredScope('rdv_task', { action: 'list' })).toBe('read');
    expect(requiredScope('rdv_task', { action: 'approve-start' })).toBe('send');
    expect(requiredScope('rdv_grant', {})).toBe('contact:request');
    expect(requiredScope('rdv_init', {})).toBeUndefined();
    expect(requiredScope('rdv_backup', { action: 'create' })).toBeUndefined();
    expect(requiredScope('rdv_backup', { action: 'restore' })).toBeUndefined();
    expect(requiredScope('rdv_auto_approve', { action: 'on' })).toBeUndefined();
    expect(requiredScope('rdv_file', { action: 'prepare' })).toBeUndefined();
    // Issue #102: the owner's settings that go through the page ask under contact:request; the passphrase never does.
    expect(requiredScope('rdv_label', { agent_id: 'rdv1:x' })).toBe('contact:request');
    expect(requiredScope('rdv_resync', { agent_id: 'rdv1:x' })).toBe('contact:request');
    expect(requiredScope('rdv_file', { action: 'direct-transfer', direct_transfer: 'on' })).toBe('contact:request');
    expect(requiredScope('rdv_owner_passphrase', {})).toBeUndefined();
    expect(requiredScope('rdv_service', { action: 'install' })).toBeUndefined();
    expect(requiredScope('rdv_service', { action: 'status' })).toBeUndefined();
    expect(authorizeCall(['read', 'send', 'contact:request', 'negotiate'], 'rdv_service', { action: 'status' })).toMatch(/not available/);
    expect(authorizeCall(['read'], 'rdv_send', {})).toMatch(/lacks the "send" scope/);
    expect(authorizeCall(['read', 'send', 'contact:request', 'negotiate'], 'rdv_init', {})).toMatch(/not available/);
  });
});

describe('tokens', () => {
  it('stores tokens hashed, refuses unknown scopes, and a revoke applies at once', async () => {
    const g = await gateway();
    const token = await g.token(['read'], 'muse');
    const file = readFileSync(join(g.home.dir, 'gateway.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).not.toContain(PIN);
    expect(JSON.parse(file).tokens).toBeTypeOf('object');
    await expect(g.gw.store.createToken('x', ['approve'])).rejects.toThrow(/unknown scope/);
    await expect(g.gw.store.createToken('x', [])).rejects.toThrow(/at least one scope/);

    expect((await api(g.base, token, 'rdv_status')).status).toBe(200);
    // A terminal revokes it (another store object on the same home, as `rdv-gateway token revoke` would).
    const other = new GatewayStore(new Home(g.home.dir));
    const [info] = other.listTokens();
    expect(await other.revokeToken(info.id)).toBe(true);
    expect((await api(g.base, token, 'rdv_status')).status).toBe(401);
  });

  it('401 without a token or with a wrong one, with a Bearer challenge', async () => {
    const g = await gateway();
    const none = await api(g.base, undefined, 'rdv_status');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect((await api(g.base, 'rdvg_notarealtokenatallnope', 'rdv_status')).status).toBe(401);
  });
});

describe('REST', () => {
  it('scopes decide per call, human-only tools and fields are gone, and paths stay local', async () => {
    const g = await gateway();
    const read = await g.token(['read']);
    const status = await api(g.base, read, 'rdv_status');
    expect(status.status).toBe(200);
    expect(status.body.result.approval).toMatch(/approval page/);
    expect(status.text).not.toContain(g.home.dir.replace(/\\/g, '\\\\'));
    expect(status.text).not.toContain(g.home.dir);
    expect((await api(g.base, read, 'rdv_task', { action: 'list' })).status).toBe(200);
    const send = await api(g.base, read, 'rdv_send', { agent_id: 'rdv1:x', payload: { type: 'note' } });
    expect(send.status).toBe(403);
    expect(send.body.code).toBe('insufficient_scope');
    expect((await api(g.base, read, 'rdv_init', {})).status).toBe(404);

    const all = await g.token(['read', 'send', 'contact:request', 'negotiate']);
    // No confirm phrase anywhere, and no passphrase path.
    const phrase = await api(g.base, all, 'rdv_grant', { request_id: 'x', confirm_phrase: 'alpha-beta-gamma-123' });
    expect(phrase.status).toBe(400);
    expect(phrase.body.error).toMatch(/invalid input/);
    expect((await api(g.base, all, 'rdv_auto_approve', { action: 'on', agent_id: 'rdv1:x' })).status).toBe(400);
    expect((await api(g.base, all, 'rdv_file', { action: 'prepare', path: '/etc/passwd' })).status).toBe(400);
    expect((await api(g.base, all, 'rdv_task', { action: 'submit', task_id: 't', inline_files: ['/etc/passwd'] })).status).toBe(400);
    expect((await api(g.base, all, 'rdv_negotiate', { action: 'propose', agent_id: 'rdv1:x', calendar: '/tmp/x.json' })).status).toBe(400);
    expect((await api(g.base, all, 'rdv_relays', { action: 'add', url: 'wss://evil.example' })).status).toBe(400);
    const relays = await api(g.base, all, 'rdv_relays', {});
    expect(relays.body.result.relays).toEqual([relay.url]);
    // A tool's own refusal is a 422 with its message.
    const grant = await api(g.base, all, 'rdv_grant', { request_id: 'nope' });
    expect(grant.status).toBe(422);
    expect(grant.body.error).toMatch(/no pending request/);
  });

  it('serves an OpenAPI document of the remote tools only', async () => {
    const g = await gateway();
    const r = await fetch(`${g.base}/openapi.json`);
    const doc = await r.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/api/v1/tools/rdv_send');
    expect(Object.keys(doc.paths)).not.toContain('/api/v1/tools/rdv_init');
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"confirm_phrase"');
    expect(text).not.toContain('"inline_files"');
  });

  it('limits bodies and rates, and refuses foreign Host headers (DNS rebinding)', async () => {
    const g = await gateway({ tokenRate: 5 });
    const t = await g.token(['read']);
    const big = await fetch(`${g.base}/api/v1/tools/rdv_status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ x: 'a'.repeat(300 * 1024) }),
    });
    expect(big.status).toBe(413);
    const port = new URL(g.base).port;
    expect((await rawRequest(g.base, '/healthz', { Host: 'attacker.example' })).status).toBe(421);
    expect((await rawRequest(g.base, '/healthz', { Host: `localhost:${port}` })).status).toBe(200);
    let limited = false;
    for (let i = 0; i < 8; i++) if ((await api(g.base, t, 'rdv_status')).status === 429) limited = true;
    expect(limited).toBe(true);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('lists only what the token covers, calls tools, and binds a session to its token', async () => {
    const g = await gateway();
    const read = await g.token(['read'], 'reader');
    const client = await mcpClient(g.base, read);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('rdv_status');
    expect(names).toContain('rdv_inbox');
    expect(names).not.toContain('rdv_send');
    expect(names).not.toContain('rdv_init');
    expect(names).not.toContain('rdv_backup');
    const s = await callJson(client, 'rdv_status');
    expect(s.isError).toBe(false);
    expect(s.json.agent_id).toMatch(/^rdv1:/);
    const denied = await callJson(client, 'rdv_task', { action: 'request', agent_id: 'rdv1:x', text: 'hi' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/lacks the "send" scope/);
    // Another token cannot use this session.
    const other = await g.token(['read'], 'other');
    const sid = (client.transport as { sessionId?: string }).sessionId!;
    const hijack = await fetch(`${g.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${other}`, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(404);
    await client.close();
  });
});

describe('startup and the listener lock', () => {
  it('binds loopback only unless told otherwise, and needs a PIN', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-'));
    const home = new Home(join(root, 'h'));
    expect(() => new Gateway({ home, host: '0.0.0.0' })).toThrow(/allow-remote-bind/);
    expect(() => new Gateway({ home, publicUrl: 'http://rdv.example.com' })).toThrow(/https/);
    const g = await startGateway(join(root, 'nopin'), { relays: [relay.url], pin: false, port: 0 }).catch((e: Error) => e);
    expect(g).toBeInstanceOf(Error);
    expect((g as Error).message).toMatch(/PIN/);
  });

  it('attaches when another process receives for the home (one inbound consumer, issue #9)', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-'));
    const dir = join(root, 'omer');
    const g0 = await startGateway(dir, { relays: [relay.url] });
    await g0.gw.close();
    const held = tryLongLock(new Home(dir).listenerLockPath, 'rdv listen');
    expect(held.release).toBeDefined();
    const g = await startGateway(dir, { relays: [relay.url], init: false, pin: false });
    gws.push(g);
    const t = await g.token(['read']);
    expect((await api(g.base, t, 'rdv_status')).body.result.inbound).toBe('attached');
    held.release!();
  });

  it('locks the PIN after repeated failures, even for the right PIN, across restarts', async () => {
    const g = await gateway();
    const now = Date.now();
    for (let i = 0; i < PIN_FREE_TRIES; i++) expect((await g.gw.store.checkPin('wrong-pin', now)).ok).toBe(false);
    const locked = await g.gw.store.checkPin(PIN, now + 1000);
    expect(locked.ok).toBe(false);
    expect((locked as { lockedFor?: number }).lockedFor).toBeGreaterThan(0);
    // A fresh store (a restart) sees the same lockout.
    expect((await new GatewayStore(new Home(g.home.dir)).checkPin(PIN, now + 2000)).ok).toBe(false);
    expect((await g.gw.store.checkPin(PIN, now + 61 * 60_000)).ok).toBe(true);
  });
});
