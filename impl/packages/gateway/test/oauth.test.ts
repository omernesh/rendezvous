// Slice 2: the built-in OAuth 2.1 authorization server. Dynamic registration,
// the authorization code with PKCE S256 and the owner's consent on the
// PIN-locked page, rotating refresh tokens with reuse detection, revocation,
// resource binding, and the grant as a principal like a static token.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Home } from '@rendezvous/cli/lib';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { ACCESS_TTL_MS, Gateway, OAuthStore } from '../src/index.js';
import { api, Browser, callJson, hidden, mcpClient, PIN, startGateway, type TestGateway, waitApi } from './helpers.js';

let relay: TestRelay;
let root: string;
let gws: TestGateway[] = [];
let sides: Side[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const s of sides) await s.close();
  for (const g of gws) await g.gw.close().catch(() => {});
  sides = [];
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function gateway(opts: Parameters<typeof startGateway>[1] = {}): Promise<TestGateway & { local: string }> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-oauth-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.o${process.pid}.${++n}@example.com`, ...opts });
  gws.push(g);
  return { ...g, local: localUrl(g.gw) };
}

/** Where the gateway really listens (its base may be a public URL the test cannot reach). */
function localUrl(gw: Gateway): string {
  return `http://127.0.0.1:${(gw as unknown as { http: { address(): { port: number } } }).http.address().port}`;
}

const REDIRECT = 'https://client.example/oauth/callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function json(r: Response): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function register(local: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const r = await fetch(`${local}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...body }),
  });
  return { status: r.status, body: await json(r) };
}

async function token(local: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const r = await fetch(`${local}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { status: r.status, body: await json(r) };
}

function authorizeUrl(local: string, p: Record<string, string | undefined>): string {
  const u = new URL(`${local}/oauth/authorize`);
  for (const [k, v] of Object.entries(p)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** The browser leg: authorize, unlock with the PIN, the consent page. Returns the page and its path. */
async function toConsent(b: Browser, url: string): Promise<{ path: string; page: string }> {
  // The owner's own browser starts it (the gateway binds the request to it with a cookie).
  const r = await b.get(url);
  expect(r.status, r.text).toBe(303);
  const path = r.headers.get('location')!;
  expect(path).toMatch(/^\/approve\/oauth\/oar_/);
  const locked = await b.get(path);
  if (locked.text.includes('name="pin"')) {
    const u = await b.unlock(path);
    expect(u.status).toBe(303);
    expect(u.headers.get('location')).toBe(path);
  }
  const page = await b.get(path);
  expect(page.status).toBe(200);
  return { path, page: page.text };
}

/** Approve (or decline) on the consent page; returns the redirect back to the client. */
async function decide(b: Browser, c: { path: string; page: string }, decision: 'approve' | 'decline', scopes?: string[], extra: Record<string, string> = {}) {
  const form: Record<string, string> = { csrf: hidden(c.page, 'csrf'), digest: hidden(c.page, 'digest'), decision, ...extra };
  const ticked = scopes ?? [...c.page.matchAll(/name="s_([a-z:]+)" value="1" checked/g)].map((m) => m[1]);
  for (const s of ticked) form[`s_${s}`] = '1';
  return b.post(c.path, form);
}

interface Flow {
  clientId: string;
  secret?: string;
  verifier: string;
  code: string;
  state: string;
}

/** DCR, authorize, the owner approves: a code for the client. */
async function approvedCode(g: { local: string }, b: Browser, opts: { scope?: string; keep?: string[]; register?: Record<string, unknown>; resource?: string } = {}): Promise<Flow> {
  const reg = await register(g.local, opts.register);
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const { verifier, challenge } = pkce();
  const state = randomBytes(8).toString('hex');
  const c = await toConsent(
    b,
    authorizeUrl(g.local, {
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: opts.scope ?? 'read send',
      state,
      resource: opts.resource,
    }),
  );
  const back = await decide(b, c, 'approve', opts.keep);
  expect(back.status, back.text).toBe(303);
  const loc = new URL(back.headers.get('location')!);
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe(state);
  return { clientId: reg.body.client_id, secret: reg.body.client_secret, verifier, code: loc.searchParams.get('code')!, state };
}

async function exchange(g: { local: string; base: string }, f: Flow, extra: Record<string, string> = {}) {
  return token(g.local, { grant_type: 'authorization_code', code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier, client_id: f.clientId, resource: `${g.base}/mcp`, ...extra });
}

describe('OAuth metadata and discovery', () => {
  it('serves RFC 9728 and RFC 8414 metadata, and a 401 from /mcp points to it', async () => {
    const g = await gateway();
    const prm = await json(await fetch(`${g.local}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.resource).toBe(`${g.base}/mcp`);
    expect(prm.authorization_servers).toEqual([g.base]);
    expect(prm.scopes_supported).toEqual(['read', 'send', 'contact:request', 'negotiate']);
    expect(await json(await fetch(`${g.local}/.well-known/oauth-protected-resource`))).toEqual(prm);
    const as = await json(await fetch(`${g.local}/.well-known/oauth-authorization-server`));
    expect(as.issuer).toBe(g.base);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.response_types_supported).toEqual(['code']);
    expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(as.registration_endpoint).toBe(`${g.base}/oauth/register`);
    expect(as.revocation_endpoint).toBe(`${g.base}/oauth/revoke`);
    const r = await fetch(`${g.local}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${g.base}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await fetch(`${g.local}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer rdvo_notarealaccesstokenatall' }, body: '{}' });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('OAuth: the full flow', () => {
  it('DCR, authorize with the PIN and consent, token, then MCP and REST calls as that grant', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b, { scope: 'read send' });
    const t = await exchange(g, f);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.token_type).toBe('Bearer');
    expect(t.body.scope).toBe('read send');
    expect(t.body.expires_in).toBeGreaterThan(3000);
    expect(t.body.access_token).toMatch(/^rdvo_/);
    expect(t.body.refresh_token).toMatch(/^rdvr_/);

    const mcp = await mcpClient(g.local, t.body.access_token);
    const st = await callJson(mcp, 'rdv_status');
    expect(st.isError, st.text).toBe(false);
    const names = (await mcp.listTools()).tools.map((x) => x.name);
    expect(names).toContain('rdv_send');
    expect(names).not.toContain('rdv_grant'); // contact:request was not asked for
    await mcp.close();
    expect((await api(g.local, t.body.access_token, 'rdv_status')).status).toBe(200);

    // Stored hashed only, mode 600 where the OS has modes.
    const file = readFileSync(join(g.home.dir, 'gateway-oauth.json'), 'utf8');
    for (const secret of [t.body.access_token, t.body.refresh_token, f.code]) expect(file).not.toContain(secret);
    if (process.platform !== 'win32') expect(statSync(join(g.home.dir, 'gateway-oauth.json')).mode & 0o777).toBe(0o600);
  });

  it('works with the MCP SDK OAuth client (discovery, DCR, PKCE, resource) end to end', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    let info: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    let tokens: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    let verifier = '';
    let authUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata() {
        return { client_name: 'SDK client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
      },
      clientInformation: () => info,
      saveClientInformation: (i) => void (info = i),
      tokens: () => tokens,
      saveTokens: (t) => void (tokens = t),
      redirectToAuthorization: (u) => void (authUrl = u),
      saveCodeVerifier: (v) => void (verifier = v),
      codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(new URL(`${g.local}/mcp`), { authProvider: provider });
    const first = new Client({ name: 'sdk', version: '0.0.0' });
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authUrl).toBeDefined();
    expect(authUrl!.searchParams.get('resource')).toBe(`${g.base}/mcp`);
    // The SDK asked for every advertised scope; the owner keeps only read.
    const c = await toConsent(b, authUrl!.toString().replace(g.base, g.local));
    expect(c.page).toContain('SDK client');
    expect(c.page).toContain('client.example');
    const back = await decide(b, c, 'approve', ['read']);
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    await transport.finishAuth(code);
    expect(tokens.scope).toBe('read');
    const client = new Client({ name: 'sdk', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${g.local}/mcp`), { authProvider: provider }));
    expect((await callJson(client, 'rdv_status')).isError).toBe(false);
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('rdv_send');
    await client.close();
  });

  it('serves MCP over the legacy SSE transport too, bound to the principal', async () => {
    const g = await gateway();
    const tok = await g.token(['read'], 'sse');
    const client = new Client({ name: 'sse', version: '0.0.0' });
    const auth = { authorization: `Bearer ${tok}` };
    await client.connect(
      new SSEClientTransport(new URL(`${g.local}/sse`), {
        requestInit: { headers: auth },
      }),
    );
    expect((await callJson(client, 'rdv_status')).isError).toBe(false);
    // Another principal cannot post into this session.
    const other = await g.token(['read'], 'other');
    const sid = [...(g.gw as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0];
    const r = await fetch(`${g.local}/messages?sessionId=${sid}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${other}` }, body: '{}' });
    expect(r.status).toBe(404);
    expect((await fetch(`${g.local}/sse`)).status).toBe(401);
    await client.close();
  });
});

describe('OAuth: PKCE, redirect URIs, codes', () => {
  it('a wrong PKCE verifier gets nothing, and the code is spent', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const wrong = await exchange(g, f, { code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    expect((await exchange(g, f)).body.error).toBe('invalid_grant');
    expect((await exchange(g, f, { code_verifier: '' })).body.error).toBe('invalid_grant');
  });

  it('refuses an authorization request without S256 PKCE (missing, or plain), back to the client', async () => {
    const g = await gateway();
    const reg = await register(g.local);
    const { challenge } = pkce();
    for (const method of [undefined, 'plain']) {
      const r = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: method, state: 's1' }), { redirect: 'manual' });
      expect(r.status).toBe(303);
      const loc = new URL(r.headers.get('location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('s1');
      expect(loc.searchParams.get('iss')).toBe(g.base);
    }
    const noChallenge = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge_method: 'S256' }), { redirect: 'manual' });
    expect(new URL(noChallenge.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    // Implicit (token) and other response types are refused.
    const implicit = await fetch(authorizeUrl(g.local, { response_type: 'token', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
    expect(new URL(implicit.headers.get('location')!).searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('a redirect_uri that differs is never redirected to, and the token endpoint checks it too', async () => {
    const g = await gateway();
    const reg = await register(g.local);
    const { challenge } = pkce();
    for (const redirect of [`${REDIRECT}/x`, `${REDIRECT}?a=1`, 'https://client.example.evil.test/oauth/callback', 'https://evil.test/', undefined]) {
      const r = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
      expect(r.status, String(redirect)).toBe(400);
      expect(r.headers.get('location')).toBeNull();
    }
    // An unknown client with any redirect: an error page here, no redirect.
    const unknown = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: 'cli_doesnotexist', redirect_uri: 'https://evil.test/', code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
    // A duplicated parameter is refused before anything is trusted.
    const dup = await fetch(`${g.local}/oauth/authorize?client_id=${reg.body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&redirect_uri=https%3A%2F%2Fevil.test%2F`, { redirect: 'manual' });
    expect(dup.status).toBe(400);
    expect(dup.headers.get('location')).toBeNull();

    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const t = await exchange(g, f, { redirect_uri: 'https://client.example/other' });
    expect(t.body.error).toBe('invalid_grant');
  });

  it('registration takes https redirect URIs only and records a cleaned name', async () => {
    let clock = Date.now();
    const g = await gateway({ now: () => clock });
    for (const uri of ['http://client.example/cb', 'javascript:alert(1)', 'https://client.example/cb#frag', 'https://user:pw@client.example/cb', '/relative', 'https://client.example/a b']) {
      const r = await register(g.local, { redirect_uris: [uri] });
      expect(r.status, uri).toBe(400);
      expect(r.body.error).toBe('invalid_redirect_uri');
    }
    expect((await register(g.local, { redirect_uris: [] })).status).toBe(400);
    clock += 10 * 60_000; // failed registrations spend the rate too
    expect((await register(g.local, { grant_types: ['authorization_code', 'password'] })).body.error).toBe('invalid_client_metadata');
    expect((await register(g.local, { grant_types: ['implicit'] })).body.error).toBe('invalid_client_metadata');
    expect((await register(g.local, { response_types: ['token'] })).body.error).toBe('invalid_client_metadata');
    expect((await register(g.local, { scope: 'read approve' })).body.error).toBe('invalid_client_metadata');
    const ok = await register(g.local, { client_name: 'Chat\u202eGPT\u0007 <b>x</b>' });
    expect(ok.status).toBe(201);
    expect(ok.body.client_name).toBe('ChatGPT <b>x</b>');
    expect(ok.body.client_secret).toBeUndefined();
    const secret = await register(g.local, { token_endpoint_auth_method: 'client_secret_post' });
    expect(secret.body.client_secret).toMatch(/^rdvs_/);
    expect(readFileSync(join(g.home.dir, 'gateway-oauth.json'), 'utf8')).not.toContain(secret.body.client_secret);
  });

  it('registration is rate limited per client, a rate that refills', async () => {
    let clock = Date.now();
    const g = await gateway({ now: () => clock });
    for (let i = 0; i < 30; i++) expect((await register(g.local, { client_name: `c${i}` })).status).toBe(201);
    const over = await register(g.local);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('slow_down');
    clock += 2 * 60_000;
    expect((await register(g.local)).status).toBe(201);
  });

  it('a code used twice ends the grant it made', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const t = await exchange(g, f);
    expect(t.status).toBe(200);
    expect((await api(g.local, t.body.access_token, 'rdv_status')).status).toBe(200);
    const again = await exchange(g, f);
    expect(again.body.error).toBe('invalid_grant');
    expect((await api(g.local, t.body.access_token, 'rdv_status')).status).toBe(401);
    expect((await token(g.local, { grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: f.clientId })).body.error).toBe('invalid_grant');
  });

  it('a code is only for the client it was issued to, and unsupported grants are refused', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const other = await register(g.local, { client_name: 'other' });
    expect((await exchange(g, f, { client_id: other.body.client_id })).body.error).toBe('invalid_grant');
    expect((await exchange(g, f, { client_id: 'cli_nonexistent00' })).status).toBe(401);
    expect((await token(g.local, { grant_type: 'password', username: 'omer', password: PIN, client_id: f.clientId })).body.error).toBe('unsupported_grant_type');
    expect((await token(g.local, { grant_type: 'client_credentials', client_id: f.clientId })).body.error).toBe('unsupported_grant_type');
    expect((await exchange(g, f)).status).toBe(200); // not spent by the other client's attempt
  });

  it('a secret client authenticates with its secret (post or basic)', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b, { register: { token_endpoint_auth_method: 'client_secret_basic' } });
    expect(f.secret).toMatch(/^rdvs_/);
    expect((await exchange(g, f)).status).toBe(401); // no secret
    expect((await exchange(g, f, { client_secret: 'rdvs_wrong' })).status).toBe(401);
    const basic = `Basic ${Buffer.from(`${f.clientId}:${f.secret}`).toString('base64')}`;
    const { client_id: _c, ...rest } = { grant_type: 'authorization_code', code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier, client_id: f.clientId, resource: `${g.base}/mcp` };
    const t = await token(g.local, rest, { authorization: basic });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    // client_secret_post works the same for the refresh.
    const r = await token(g.local, { grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: f.clientId, client_secret: f.secret! });
    expect(r.status).toBe(200);
  });
});

describe('OAuth: refresh, reuse, revocation, expiry', () => {
  it('rotates refresh tokens; reusing a rotated one ends the whole grant', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const t0 = (await exchange(g, f)).body;
    const r1 = await token(g.local, { grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: f.clientId });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t0.refresh_token);
    expect((await api(g.local, r1.body.access_token, 'rdv_status')).status).toBe(200);
    // Narrowing on refresh is fine; widening is not.
    const wide = await token(g.local, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: f.clientId, scope: 'read negotiate' });
    expect(wide.body.error).toBe('invalid_scope');
    const r2 = await token(g.local, { grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: f.clientId, scope: 'read' });
    expect(r2.status).toBe(200);
    expect(r2.body.scope).toBe('read');
    expect((await api(g.local, r2.body.access_token, 'rdv_send', { agent_id: 'rdv1:x', payload: { type: 'note' } })).status).toBe(403);
    // The first refresh token again: someone else has it. The family ends.
    const reuse = await token(g.local, { grant_type: 'refresh_token', refresh_token: t0.refresh_token, client_id: f.clientId });
    expect(reuse.body.error).toBe('invalid_grant');
    for (const a of [t0.access_token, r1.body.access_token, r2.body.access_token]) expect((await api(g.local, a, 'rdv_status')).status).toBe(401);
    expect((await token(g.local, { grant_type: 'refresh_token', refresh_token: r2.body.refresh_token, client_id: f.clientId })).body.error).toBe('invalid_grant');
    expect(g.gw.oauth.store.list().grants).toEqual([]);
  });

  it('an access token expires; the refresh token still works', async () => {
    let clock = Date.now();
    const g = await gateway({ now: () => clock });
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const t = (await exchange(g, f)).body;
    expect((await api(g.local, t.access_token, 'rdv_status')).status).toBe(200);
    clock += ACCESS_TTL_MS + 1000;
    expect((await api(g.local, t.access_token, 'rdv_status')).status).toBe(401);
    const r = await token(g.local, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.clientId });
    expect(r.status).toBe(200);
    expect((await api(g.local, r.body.access_token, 'rdv_status')).status).toBe(200);
  });

  it('RFC 7009: revoking the refresh token ends the grant; another client cannot revoke it', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const t = (await exchange(g, f)).body;
    const other = await register(g.local, { client_name: 'other' });
    const revoke = (client: string, tok: string) =>
      fetch(`${g.local}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok, client_id: client }).toString() });
    expect((await revoke(other.body.client_id, t.refresh_token)).status).toBe(200);
    expect((await api(g.local, t.access_token, 'rdv_status')).status).toBe(200);
    expect((await revoke(f.clientId, t.refresh_token)).status).toBe(200);
    expect((await api(g.local, t.access_token, 'rdv_status')).status).toBe(401);
    expect((await revoke(f.clientId, 'rdvr_unknown')).status).toBe(200);
  });

  it('the owner revokes a client from the terminal: its tokens and pending approvals end at once', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b, { scope: 'read contact:request' });
    const t = (await exchange(g, f)).body;
    // A pending approval asked by this grant shows the client's name and grant id.
    const john = await makeSide('john', join(root, 'john'));
    sides.push(john);
    await ok(john, 'rdv_init', { profile: 'john', email: `john.o${process.pid}.${n}@doe.com`, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    await ok(john, 'rdv_request_contact', { target: g.home.readConfig().addresses[0].value });
    const ev = await waitApi(g.local, t.access_token, (e) => e.type === 'contact_request', 'the request');
    const asked = await api(g.local, t.access_token, 'rdv_grant', { request_id: ev.request_id });
    expect(asked.body.result.status).toBe('awaiting_human');
    const grantId = g.gw.oauth.store.list().grants[0].id;
    expect((await b.get(new URL(asked.body.result.approve_url).pathname)).text).toContain(`ChatGPT (OAuth ${grantId})`);
    // `rdv-gateway oauth revoke <client>` from a terminal: another store on the same home.
    const r = await new OAuthStore(new Home(g.home.dir)).revoke(f.clientId);
    expect(r?.grants.map((x) => x.id)).toEqual([grantId]);
    expect((await api(g.local, t.access_token, 'rdv_status')).status).toBe(401);
    expect((await token(g.local, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.clientId })).status).toBe(401);
    expect(g.gw.approvals.list()).toEqual([]);
  });

  it('tokens survive a restart and are bound to this gateway: another resource or a changed public URL is refused', async () => {
    const g = await gateway({ publicUrl: 'http://localhost:9' });
    expect(g.base).toBe('http://localhost:9');
    const b = new Browser(g.local);
    // Asking for another resource at authorize: back to the client with invalid_target.
    const reg = await register(g.local);
    const { challenge } = pkce();
    const wrong = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' }), { redirect: 'manual' });
    expect(new URL(wrong.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    const f = await approvedCode(g, b);
    expect((await exchange(g, f, { resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    const f2 = await approvedCode(g, b);
    const t = await exchange(g, f2);
    expect(t.status).toBe(200);
    expect((await token(g.local, { grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: f2.clientId, resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');

    // Restart on the same home and public URL: the token still works.
    await g.gw.close();
    const again = new Gateway({ home: g.home, port: 0, publicUrl: 'http://localhost:9', humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    await again.start();
    gws.push({ ...g, gw: again });
    expect((await api(localUrl(again), t.body.access_token, 'rdv_status')).status).toBe(200);
    await again.close();
    // The same home under another public URL is another resource: the token is refused.
    const moved = new Gateway({ home: g.home, port: 0, publicUrl: 'http://localhost:10', humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    await moved.start();
    gws.push({ ...g, gw: moved });
    expect((await api(localUrl(moved), t.body.access_token, 'rdv_status')).status).toBe(401);
  });
});

describe('OAuth: the consent page', () => {
  it('needs the PIN, shows the client name, return host and scopes, and never auto-approves', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local, { client_name: '<script>alert(1)</script>' });
    const { challenge } = pkce();
    const url = authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read contact:request' });
    const r = await fetch(url, { redirect: 'manual' });
    const path = r.headers.get('location')!;
    // Locked: the unlock page, not the consent.
    const locked = await b.get(path);
    expect(locked.text).toContain('name="pin"');
    expect(locked.text).not.toContain('client.example');
    const c = await toConsent(b, url);
    expect(c.page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(c.page).not.toContain('<script>');
    expect(c.page).toContain('<b>client.example</b>');
    expect(c.page).toContain('name="s_read"');
    expect(c.page).toContain('name="s_contact:request"');
    expect(c.page).not.toContain('name="s_send"');
    const page = await b.get(c.path);
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' https://client.example");
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.text).not.toMatch(/<script/i);
    // Approved once; the same client asking again gets the consent page again.
    await decide(b, c, 'approve');
    const again = await fetch(url, { redirect: 'manual' });
    expect(again.headers.get('location')).toMatch(/^\/approve\/oauth\/oar_/);
  });

  it('the owner narrows the scopes; widening is refused and issues nothing', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { verifier, challenge } = pkce();
    const url = authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read send' });
    const c = await toConsent(b, url);
    const wider = await decide(b, c, 'approve', ['read', 'negotiate']);
    expect(wider.status).toBe(409);
    expect(wider.headers.get('location')).toBeNull();
    const none = await decide(b, c, 'approve', []);
    expect(none.status).toBe(409);
    const narrowed = await decide(b, c, 'approve', ['read']);
    expect(narrowed.status).toBe(303);
    const code = new URL(narrowed.headers.get('location')!).searchParams.get('code')!;
    const t = await token(g.local, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.body.client_id });
    expect(t.body.scope).toBe('read');
    expect((await api(g.local, t.body.access_token, 'rdv_send', { agent_id: 'rdv1:x', payload: { type: 'note' } })).status).toBe(403);
    // Decided: the consent is gone.
    expect((await decide(b, c, 'approve')).status).toBe(404);
  });

  it('a "no" sends access_denied back and issues nothing', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { challenge } = pkce();
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' }));
    const no = await decide(b, c, 'decline');
    const loc = new URL(no.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('refuses forged posts (CSRF, foreign Origin, cross-site fetch, locked) and a stale digest', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { challenge } = pkce();
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    const base = { digest: hidden(c.page, 'digest'), decision: 'approve', s_read: '1' };
    expect((await b.post(c.path, { ...base, csrf: 'forged' })).status).toBe(403);
    expect((await b.post(c.path, base)).status).toBe(403);
    expect((await b.post(c.path, { ...base, csrf: hidden(c.page, 'csrf') }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await b.post(c.path, { ...base, csrf: hidden(c.page, 'csrf') }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const stale = await b.post(c.path, { ...base, csrf: hidden(c.page, 'csrf'), digest: 'f'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.headers.get('location')).toBeNull();
    // Without the owner's session (another browser): the unlock page, nothing decided.
    const stranger = new Browser(g.local);
    const locked = await stranger.post(c.path, { ...base, csrf: hidden(c.page, 'csrf') });
    expect(locked.status).toBe(401);
    expect(locked.headers.get('location')).toBeNull();
    // Still waiting, and the owner can still approve it.
    expect((await decide(b, c, 'approve')).status).toBe(303);
  });

  it('a client removed while its consent waits is not approved', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { challenge } = pkce();
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    await new OAuthStore(new Home(g.home.dir)).revoke(reg.body.client_id);
    const r = await decide(b, c, 'approve');
    expect(r.status).toBe(409);
    expect(r.headers.get('location')).toBeNull();
  });
});

describe('OAuth: security review fixes', () => {
  it('a consent link forwarded to the owner (a stranger started it) shows nothing and approves nothing', async () => {
    const g = await gateway();
    const reg = await register(g.local);
    const { challenge } = pkce();
    // The stranger's browser starts connecting its own ChatGPT account to the owner's gateway.
    const stranger = new Browser(g.local);
    const started = await stranger.get(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    const path = started.headers.get('location')!;
    expect(path).toMatch(/^\/approve\/oauth\/oar_/);
    // The owner, unlocked in their own browser, opens the forwarded link.
    const owner = new Browser(g.local);
    await owner.unlock(path);
    const page = await owner.get(path);
    expect(page.status).toBe(403);
    expect(page.text).not.toContain('name="digest"');
    expect(page.text).not.toContain('client.example');
    const csrf = hidden((await owner.get('/approve')).text, 'csrf');
    const post = await owner.post(path, { csrf, digest: 'x', decision: 'approve', s_read: '1' });
    expect(post.status).toBe(403);
    expect(post.headers.get('location')).toBeNull();
  });

  it('a stranger flooding parked requests cannot push out the owner\'s, nor fill the page', async () => {
    const g = await gateway({ clientIpHeader: 'cf-connecting-ip' });
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { verifier, challenge } = pkce();
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    for (let i = 0; i < 40; i++) {
      const r = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' }), {
        redirect: 'manual',
        headers: { 'cf-connecting-ip': '203.0.113.9' },
      });
      expect(r.status).toBe(303);
    }
    const back = await decide(b, c, 'approve');
    expect(back.status).toBe(303);
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    expect((await token(g.local, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: reg.body.client_id })).status).toBe(200);
  });

  it('young unapproved clients are never evicted: registration waits instead', async () => {
    let clock = Date.now();
    const g = await gateway({ now: () => clock });
    const store = g.gw.oauth.store;
    const first = await store.registerClient({ name: 'owner app', redirectUris: [REDIRECT], authMethod: 'none' }, clock);
    for (let i = 1; i < 200; i++) await store.registerClient({ name: `flood ${i}`, redirectUris: [REDIRECT], authMethod: 'none' }, clock);
    await expect(store.registerClient({ name: 'one more', redirectUris: [REDIRECT], authMethod: 'none' }, clock)).rejects.toThrow(/retry in a few minutes/);
    expect(store.client(first.client.id)).toBeDefined();
    const r = await register(g.local);
    expect(r.status).toBe(429);
    clock += 16 * 60_000;
    expect((await register(g.local)).status).toBe(201);
  }, 60_000);

  it('two consent posts at once decide once', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const reg = await register(g.local);
    const { challenge } = pkce();
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    const both = await Promise.all([decide(b, c, 'approve'), decide(b, c, 'approve')]);
    expect(both.filter((r) => r.status === 303)).toHaveLength(1);
  });

  it('a code presented twice at once yields no working grant', async () => {
    const g = await gateway();
    const b = new Browser(g.local);
    const f = await approvedCode(g, b);
    const both = await Promise.all([exchange(g, f), exchange(g, f)]);
    for (const t of both) if (t.status === 200) expect((await api(g.local, t.body.access_token, 'rdv_status')).status).toBe(401);
    expect(g.gw.oauth.store.list().grants).toEqual([]);
  });

  it('OAuth over the legacy SSE transport: its own metadata, and a terminal revoke closes the stream', async () => {
    const g = await gateway();
    const prm = await json(await fetch(`${g.local}/.well-known/oauth-protected-resource/sse`));
    expect(prm.resource).toBe(`${g.base}/sse`);
    const r401 = await fetch(`${g.local}/sse`);
    expect(r401.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/sse"');
    const b = new Browser(g.local);
    const f = await approvedCode(g, b, { resource: `${g.base}/sse` });
    const t = await exchange(g, f, { resource: `${g.base}/sse` });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const client = new Client({ name: 'sse-oauth', version: '0.0.0' });
    const transport = new SSEClientTransport(new URL(`${g.local}/sse`), { requestInit: { headers: { authorization: `Bearer ${t.body.access_token}` } } });
    await client.connect(transport);
    expect((await callJson(client, 'rdv_status')).isError).toBe(false);
    await new OAuthStore(new Home(g.home.dir)).revoke(f.clientId);
    (g.gw as unknown as { sweepSessions(): void }).sweepSessions();
    await new Promise((r) => setTimeout(r, 300));
    await expect(client.callTool({ name: 'rdv_status', arguments: {} })).rejects.toThrow();
    expect((g.gw as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it('a request never gets more than the client registered for', async () => {
    const g = await gateway();
    const reg = await register(g.local, { scope: 'read' });
    const { challenge } = pkce();
    const b = new Browser(g.local);
    const c = await toConsent(b, authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read send' }));
    expect(c.page).toContain('name="s_read"');
    expect(c.page).not.toContain('name="s_send"');
    const none = await fetch(authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'send' }), { redirect: 'manual' });
    expect(new URL(none.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
  });

  it('behind https the consent works on the public host only, with __Host- cookies', async () => {
    const g = await gateway({ publicUrl: 'https://rdv.example.com', clientIpHeader: 'cf-connecting-ip' });
    const reg = await register(g.local);
    const { challenge } = pkce();
    const url = authorizeUrl(g.local, { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    // On the loopback host behind https: refused (the page answers only on the public address).
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(421);
    // On the public host (the tunnel's Host header): parked, the cookie is __Host- and Secure.
    const u = new URL(url);
    const r = await rawGet(g.local, `${u.pathname}${u.search}`, { host: 'rdv.example.com', 'cf-connecting-ip': '198.51.100.7' });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/approve\/oauth\/oar_/);
    expect(r.cookie).toMatch(/^__Host-rdvg_oar=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  });
});

function rawGet(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; location?: string; cookie?: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, cookie: res.headers['set-cookie']?.[0] }));
    });
    req.on('error', reject);
    req.end();
  });
}
