// Regression tests from the second review of PR #86: changing the PIN needs a
// terminal and the current PIN, a no runs nothing, flooding without the form
// spends no PIN budget, https needs the tunnel's client header, sessions are
// capped per token, and approvals belong to a token id (dropped on revoke).
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentState } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { Home } from '@rendezvous/cli/lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { Gateway, GatewayStore, MAX_MCP_SESSIONS_PER_TOKEN } from '../src/index.js';
import { api, Browser, callJson, mcpClient, startGateway, type TestGateway, waitApi } from './helpers.js';

const BIN = fileURLToPath(new URL('../dist/src/bin.js', import.meta.url));

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
  for (const g of gws) await g.gw.close();
  sides = [];
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function gateway(opts: Parameters<typeof startGateway>[1] = {}): Promise<TestGateway> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-r2-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.r${process.pid}.${++n}@example.com`, ...opts });
  gws.push(g);
  return g;
}

/** The built bin with piped stdin (no terminal), as a model's shell would run it. */
function bin(args: string[], input: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { timeout: 30_000 }, (err, _out, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr: String(stderr) }),
    );
    child.stdin!.end(input);
  });
}

/** A pending request from John, and the assistant's ask for it. */
async function asked(g: TestGateway, token: string) {
  const john = await makeSide('john', join(root, 'john'));
  sides.push(john);
  await ok(john, 'rdv_init', { profile: 'john', email: `john.r${process.pid}.${n}@doe.com`, relays: [relay.url] });
  await new Promise((r) => setTimeout(r, 300));
  await ok(john, 'rdv_request_contact', { target: g.home.readConfig().addresses[0].value });
  const ev = await waitApi(g.base, token, (e) => e.type === 'contact_request', 'the request');
  const r = await api(g.base, token, 'rdv_grant', { request_id: ev.request_id });
  expect(r.body.result.status).toBe('awaiting_human');
  return { requestId: ev.request_id as string, url: r.body.result.approve_url as string };
}

describe('changing the PIN needs the owner', () => {
  it('pin set refuses piped stdin without --stdin, and with --stdin needs the current PIN', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-r2-'));
    const dir = join(root, 'h');
    const store = new GatewayStore(new Home(dir));
    // The first PIN, from a script the owner runs (--stdin).
    expect((await bin(['pin', 'set', '--home', dir, '--stdin'], '482916-first\n')).code).toBe(0);
    // `echo 123456 | rdv-gateway pin set`: no terminal, refused, nothing changed.
    const piped = await bin(['pin', 'set', '--home', dir], '123456\n');
    expect(piped.code).not.toBe(0);
    expect(piped.stderr).toMatch(/needs your own terminal/);
    expect((await store.checkPin('482916-first', Date.now())).ok).toBe(true);
    // --stdin without the right current PIN: refused.
    const wrong = await bin(['pin', 'set', '--home', dir, '--stdin'], 'guess-pin\n777111-mine\n');
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toMatch(/not the current PIN/);
    expect((await store.checkPin('777111-mine', Date.now())).ok).toBe(false);
    // With it: changed.
    expect((await bin(['pin', 'set', '--home', dir, '--stdin'], '482916-first\n777111-mine\n')).code).toBe(0);
    expect((await store.checkPin('777111-mine', Date.now())).ok).toBe(true);
    // The store refuses the same way.
    await expect(store.changePin(undefined, 'abcdef-9', Date.now())).rejects.toThrow(/give the current one/);
  });
});

describe('a no runs nothing', () => {
  it('answer() with decline does not re-run the step, even one that needs no one', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request']);
    const { requestId } = await asked(g, t);
    // rdv_revoke never asks; before the fix a "no" re-ran it and declined the request.
    const out = await g.gw.server.answer({ tool: 'rdv_revoke', args: { request_id: requestId } }, { digest: 'x', decision: 'decline', content: {} }, 'apr_test');
    expect(out.kind).toBe('done');
    expect(Object.keys((g.home.readAgentState() as AgentState).book.pending)).toEqual([requestId]);
    const ev = await waitApi(g.base, t, (e) => e.type === 'approval' && e.approval_id === 'apr_test', 'the declined event');
    expect(ev.outcome).toBe('declined');
  });
});

describe('PIN budget and https', () => {
  it('posts without our form spend nothing: the owner still unlocks after a flood', async () => {
    const g = await gateway();
    const b = new Browser(g.base);
    for (let i = 0; i < 60; i++) expect((await b.post('/approve/unlock', { pin: 'x', next: '/approve' })).status).toBe(403);
    expect((await b.unlock()).status).toBe(303);
  });

  it('behind https the gateway needs the tunnel\'s client header', () => {
    expect(() => new Gateway({ home: new Home(join(tmpdir(), 'nope')), publicUrl: 'https://rdv.example.com' })).toThrow(/--client-ip-header/);
  });
});

describe('tokens own their sessions and approvals', () => {
  it('one token holds at most a few MCP sessions; another token is untouched', async () => {
    const g = await gateway();
    const t = await g.token(['read'], 'busy');
    const other = await mcpClient(g.base, await g.token(['read'], 'quiet'));
    const clients = [];
    for (let i = 0; i <= MAX_MCP_SESSIONS_PER_TOKEN; i++) clients.push(await mcpClient(g.base, t));
    // The oldest of the busy token's sessions was closed to make room; the newest and the other token's work.
    await expect(clients[0].callTool({ name: 'rdv_status', arguments: {} })).rejects.toThrow();
    expect((await callJson(clients.at(-1)!, 'rdv_status')).isError).toBe(false);
    expect((await callJson(other, 'rdv_status')).isError).toBe(false);
    for (const c of [...clients.slice(1), other]) await c.close();
  });

  it('names are unique, the page names the token by id, and a revoke drops its pending approvals', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request'], 'muse');
    await expect(g.gw.store.createToken('Muse', ['read'])).rejects.toThrow(/exists already/);
    const { url } = await asked(g, t);
    const b = new Browser(g.base);
    await b.unlock(new URL(url).pathname);
    const id = g.gw.store.listTokens()[0].id;
    expect((await b.get(url)).text).toContain(`muse (${id})`);
    await new GatewayStore(new Home(g.home.dir)).revokeToken(id);
    const gone = await b.get(url);
    expect(gone.status).toBe(404);
    expect(g.gw.approvals.list()).toEqual([]);
  });
});
