// Regression tests from the security review of slice 1: wrong-PIN backoff and
// the owner's way out, per-client counting behind a trusted tunnel header,
// pending approvals that can't be flooded away, a new PIN ending sessions,
// cleared limits, local paths, and https-only approvals.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentState, MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import type { ApprovalAsk } from '@rendezvous/mcp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { Approvals, MAX_APPROVALS, MAX_APPROVALS_PER_PRINCIPAL, PIN_FREE_TRIES } from '../src/index.js';
import { api, Browser, hidden, PIN, rawRequest, startGateway, type TestGateway, waitApi } from './helpers.js';

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
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-h-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.h${process.pid}.${++n}@example.com`, ...opts });
  gws.push(g);
  return g;
}

const fakeAsk = (i: number, principal: string): ApprovalAsk => ({
  tool: 'rdv_grant',
  args: { request_id: `r${i}` },
  form: { message: `Rendezvous: approve ${i}?`, properties: { approve: { type: 'boolean' } }, required: ['approve'], digest: `d${i}` },
  suggestions: [],
  principal,
});

describe('pending approvals cannot be flooded away', () => {
  it('refuses new asks when a client or the page is full, and keeps every waiting one', () => {
    const a = new Approvals((id) => `http://x/approve/${id}`);
    const first = a.ask(fakeAsk(0, 'muse'));
    for (let i = 1; i < MAX_APPROVALS_PER_PRINCIPAL; i++) a.ask(fakeAsk(i, 'muse'));
    expect(() => a.ask(fakeAsk(999, 'muse'))).toThrow(/already wait for your user; nothing new was asked/);
    // The same call asked again is not a new one.
    expect(a.ask(fakeAsk(0, 'muse'))).toBe(first);
    // Others can still ask, until the page is full; then everyone is refused, and nothing is dropped.
    let k = 0;
    for (let c = 0; a.list().length < MAX_APPROVALS; c++) for (let i = 0; i < MAX_APPROVALS_PER_PRINCIPAL && a.list().length < MAX_APPROVALS; i++) a.ask(fakeAsk(1000 + k++, `client${c}`));
    expect(() => a.ask(fakeAsk(5000, 'fresh'))).toThrow(/too many approvals already wait/);
    expect(a.list()).toHaveLength(MAX_APPROVALS);
    expect(a.get(new URL(first).pathname.split('/').pop()!)).toBeDefined();
  });

  it('the refusal reaches the client as an error, not an approve_url', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request'], 'flood');
    const john = await makeSide('john', join(root, 'john'));
    sides.push(john);
    await ok(john, 'rdv_init', { profile: 'john', email: `john.h${process.pid}.${n}@doe.com`, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    const tokenId = g.gw.store.listTokens()[0].id;
    for (let i = 0; i < MAX_APPROVALS_PER_PRINCIPAL; i++) g.gw.approvals.ask(fakeAsk(i, tokenId));
    const me = g.home.readConfig().addresses[0].value;
    await ok(john, 'rdv_request_contact', { target: me });
    const ev = await waitApi(g.base, t, (e) => e.type === 'contact_request', 'the request');
    const r = await api(g.base, t, 'rdv_grant', { request_id: ev.request_id });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/nothing new was asked/);
  });
});

describe('wrong PINs: a backoff with a way out', () => {
  it('a stranger guessing makes the owner wait, never forever: the owner clears it in their terminal, and quiet days forget it', async () => {
    const g = await gateway();
    const b = new Browser(g.base);
    for (let i = 0; i < PIN_FREE_TRIES; i++) expect((await b.unlock('/approve', 'guess-pin')).status).toBe(403);
    const blocked = await b.unlock('/approve', PIN);
    expect(blocked.status).toBe(403);
    expect(blocked.text).toContain('rdv-gateway pin unlock');
    // `rdv-gateway pin unlock`, run by the owner:
    await g.gw.store.clearLockout();
    expect((await b.unlock('/approve', PIN)).status).toBe(303);
    // Failures a day apart never add up to a wait.
    const t0 = Date.now();
    for (let i = 0; i < PIN_FREE_TRIES + 3; i++) expect((await g.gw.store.checkPin('guess-pin', t0 + i * 25 * 60 * 60_000)).lockedFor).toBeUndefined();
  });

  it('behind a trusted tunnel header, one client\'s guesses back off that client, not the owner', async () => {
    const g = await gateway({ clientIpHeader: 'cf-connecting-ip' });
    const attacker = new Browser(g.base);
    const owner = new Browser(g.base);
    const as = (ip: string) => ({ 'cf-connecting-ip': ip });
    const tryPin = async (br: Browser, ip: string, pin: string) => {
      const page = await br.get('/approve');
      return br.post('/approve/unlock', { csrf: hidden(page.text, 'csrf'), next: '/approve', pin }, as(ip));
    };
    for (let i = 0; i < 3; i++) expect((await tryPin(attacker, '203.0.113.7', 'guess-pin')).status).toBe(403);
    const backoff = await tryPin(attacker, '203.0.113.7', 'guess-pin');
    expect(backoff.status).toBe(429);
    // Even the right PIN waits from there; the owner, elsewhere, gets in.
    expect((await tryPin(attacker, '203.0.113.7', PIN)).status).toBe(429);
    expect((await tryPin(owner, '198.51.100.2', PIN)).status).toBe(303);
  });
});

describe('sessions, limits, paths', () => {
  it('a new PIN ends every unlocked session', async () => {
    const g = await gateway();
    const b = new Browser(g.base);
    expect((await b.unlock()).status).toBe(303);
    expect((await b.get('/approve')).text).toContain('Waiting for you');
    await g.gw.store.setPin('7391-new-pin');
    expect((await b.get('/approve')).text).toContain('Enter your gateway PIN');
  });

  it('a limit the owner clears on the page is not granted', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request']);
    const john = await makeSide('john', join(root, 'john'));
    sides.push(john);
    const j = await ok(john, 'rdv_init', { profile: 'john', email: `john.l${process.pid}.${n}@doe.com`, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    await ok(john, 'rdv_request_contact', { target: g.home.readConfig().addresses[0].value });
    const ev = await waitApi(g.base, t, (e) => e.type === 'contact_request', 'the request');
    const asked = await api(g.base, t, 'rdv_grant', { request_id: ev.request_id, limits: { [MEETINGS_CAPABILITY]: { max_open: 32 } } });
    const path = new URL(asked.body.result.approve_url).pathname;
    const b = new Browser(g.base);
    await b.unlock(path);
    const page = await b.get(path);
    expect(page.text).toMatch(/name="f_limit_open_0"[^>]*value="32"/);
    const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_label: '', f_limit_frequency_0: '', f_limit_open_0: '' });
    expect(done.text).toContain('Approved');
    const c = (g.home.readAgentState() as AgentState).book.contacts[j.agent_id];
    expect(JSON.stringify(c)).toContain(MEETINGS_CAPABILITY);
    expect(JSON.stringify(c)).not.toContain('"max_open":32');
  });

  it('a limit that does not parse keeps the ask open and says so to the owner; blank approves with no limit', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request']);
    const john = await makeSide('john', join(root, 'john'));
    sides.push(john);
    const j = await ok(john, 'rdv_init', { profile: 'john', email: `john.b${process.pid}.${n}@doe.com`, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    await ok(john, 'rdv_request_contact', { target: g.home.readConfig().addresses[0].value });
    const ev = await waitApi(g.base, t, (e) => e.type === 'contact_request', 'the request');
    const asked = await api(g.base, t, 'rdv_grant', { request_id: ev.request_id });
    const path = new URL(asked.body.result.approve_url).pathname;
    const b = new Browser(g.base);
    await b.unlock(path);
    const page = await b.get(path);
    expect(page.text).toMatch(/name="f_limit_open_0"[^>]*autocomplete="off"/);
    const base = { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_limit_open_0: '' };
    const bad = await b.post(path, { ...base, f_label: 'Johnny', f_limit_frequency_0: 'whenever' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Dinner proposals: rate limit: write it like 3/day (per minute, hour or day), or leave it blank for no limit. Nothing was done yet.');
    expect(bad.text).not.toMatch(/your user|max_frequency|ask them again/);
    expect(bad.text).toMatch(/name="f_label"[^>]*value="Johnny"/);
    expect(bad.text).toMatch(/name="f_limit_frequency_0"[^>]*value="whenever"/);
    expect((g.home.readAgentState() as AgentState).book.contacts[j.agent_id]).toBeUndefined();
    expect((await b.get('/approve')).text).toContain(path);
    const done = await b.post(path, { ...base, csrf: hidden(bad.text, 'csrf'), digest: hidden(bad.text, 'digest'), f_label: '', f_limit_frequency_0: '' });
    expect(done.text).toContain('Approved');
    const c = (g.home.readAgentState() as AgentState).book.contacts[j.agent_id];
    expect(c).toBeDefined();
    expect(JSON.stringify(c)).not.toContain('"max_frequency":"whenever"');
    expect(JSON.stringify(c.inboundScope.invoke[MEETINGS_CAPABILITY])).toBe('{}');
  });

  it('a bad entry shows the form again: values are escaped, an unticked box stays unticked, no approval event, a clashing label keeps the ask', async () => {
    const g = await gateway();
    const t = await g.token(['read', 'contact:request']);
    const sideFor = async (name: string) => {
      const side = await makeSide(name, join(root, name));
      sides.push(side);
      const info = await ok(side, 'rdv_init', { profile: name, email: `${name}.c${process.pid}.${n}@doe.com`, relays: [relay.url] });
      await new Promise((r) => setTimeout(r, 300));
      await ok(side, 'rdv_request_contact', { target: g.home.readConfig().addresses[0].value });
      return info;
    };
    const first = await sideFor('johnone');
    const ev1 = await waitApi(g.base, t, (e) => e.type === 'contact_request', 'the first request');
    const capability = (await api(g.base, t, 'rdv_status', {})).body.result.tasks.capabilities[0] as string;
    const asked = await api(g.base, t, 'rdv_grant', { request_id: ev1.request_id, invoke: [capability] });
    const path = new URL(asked.body.result.approve_url).pathname;
    const b = new Browser(g.base);
    await b.unlock(path);
    const page = await b.get(path);
    expect(page.text).toMatch(/name="f_allow_invoke"[^>]*checked/);
    const base = { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_label: '', f_limit_open_0: '' };
    // An echoed value is escaped.
    const evil = await b.post(path, { ...base, f_limit_frequency_0: '"><b>x</b>' });
    expect(evil.status).toBe(400);
    expect(evil.text).not.toContain('<b>x</b>');
    expect(evil.text).toContain('&lt;b&gt;x&lt;/b&gt;');
    // A field the page can't type (FormInputError) re-renders with the box still unticked.
    const typo = await b.post(path, { ...base, f_limit_frequency_0: '', f_limit_open_0: 'many' });
    expect(typo.status).toBe(400);
    expect(typo.text).not.toMatch(/name="f_allow_invoke"[^>]*checked/);
    // Nothing reached the assistant about the failed tries.
    const inbox = await api(g.base, t, 'rdv_inbox', { since: 0 });
    expect(inbox.body.result.events.filter((e: { type: string }) => e.type === 'approval')).toEqual([]);
    expect((g.home.readAgentState() as AgentState).book.contacts[first.agent_id]).toBeUndefined();
    // Another contact's nickname is refused as a label, and the ask stays open.
    await (g.gw.server as unknown as { withAgent(f: (a: { book: { addAlias(p: string, a: string): unknown } }) => Promise<unknown>): Promise<unknown> }).withAgent(async () => undefined);
    const done = await b.post(path, { ...base, csrf: hidden(typo.text, 'csrf'), digest: hidden(typo.text, 'digest'), f_limit_frequency_0: '' });
    expect(done.text).toContain('Approved');
    const second = await sideFor('johntwo');
    const ev2 = await waitApi(g.base, t, (e) => e.type === 'contact_request' && e.request_id !== ev1.request_id, 'the second request');
    expect(second.agent_id).not.toBe(first.agent_id);
    await (g.gw.server as unknown as { withAgent(f: (a: { book: { addAlias(p: string, a: string): unknown } }) => Promise<unknown>): Promise<unknown> }).withAgent(async (a) => a.book.addAlias(first.agent_id, 'Ran'));
    const asked2 = await api(g.base, t, 'rdv_grant', { request_id: ev2.request_id });
    const path2 = new URL(asked2.body.result.approve_url).pathname;
    const page2 = await b.get(path2);
    const clash = await b.post(path2, { csrf: hidden(page2.text, 'csrf'), digest: hidden(page2.text, 'digest'), decision: 'approve', f_tier: 'friend', f_label: 'Ran', f_limit_frequency_0: '', f_limit_open_0: '' });
    expect(clash.status).toBe(400);
    expect(clash.text).toContain('Nothing was done yet.');
    expect(clash.text).not.toMatch(/your user|ask them again/);
    expect((g.home.readAgentState() as AgentState).book.contacts[second.agent_id]).toBeUndefined();
    expect((await b.get('/approve')).text).toContain(path2);
    const fixed = await b.post(path2, { csrf: hidden(clash.text, 'csrf'), digest: hidden(clash.text, 'digest'), decision: 'approve', f_tier: 'friend', f_label: 'Ran Two', f_limit_frequency_0: '', f_limit_open_0: '' });
    expect(fixed.text).toContain('Approved');
  });

  it('no local path leaves: the home, calendars, and any other absolute path', async () => {
    const g = await gateway();
    const redact = (v: unknown) => (g.gw.server as unknown as { redactPaths(v: unknown): unknown }).redactPaths(v);
    const homeOther = g.home.dir.replace(/\\/g, '/').toUpperCase();
    expect(redact({ a: `see ${g.home.dir}/x.json`, b: `in ${homeOther}/tasks.json` })).toEqual({ a: 'see <rendezvous home>/x.json', b: 'in <rendezvous home>/tasks.json' });
    // To the end of the field, quote or line: a path may hold spaces.
    expect(redact('read from C:\\Users\\omer\\Documents\\x.pdf')).toBe('read from <local path>');
    expect(redact({ a: 'D:\\My Documents\\Taxes\\2026.pdf', b: '/home/omer/My Files/x.pdf', c: 'see ~/secret/notes.txt', d: 'file "\\\\nas\\share\\a b.txt" (2 KB)' })).toEqual({
      a: '<local path>',
      b: '<local path>',
      c: 'see <local path>',
      d: 'file "<local path>" (2 KB)',
    });
    // URLs, IDs and rates are not paths.
    const keep = 'wss://relay.example.com/nostr https://rendezvous.nesher.co/ext/meetings/v1 rdv1:abc 3/day';
    expect(redact(keep)).toBe(keep);
  });

  it('behind https, approvals open only at the public address', async () => {
    const g = await gateway({ publicUrl: 'https://rdv.example.com', clientIpHeader: 'cf-connecting-ip' });
    const port = (g.gw as unknown as { http: { address(): { port: number } } }).http.address().port;
    const r = await rawRequest(`http://127.0.0.1:${port}`, '/approve', { Host: `127.0.0.1:${port}` });
    expect(r.status).toBe(421);
    expect(r.text).toContain('https://rdv.example.com/approve');
    expect((await rawRequest(`http://127.0.0.1:${port}`, '/approve', { Host: 'rdv.example.com' })).status).toBe(200);
  });
});
