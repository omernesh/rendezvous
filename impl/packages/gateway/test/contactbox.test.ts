// "Don't ask again for this contact" through the gateway (NOTES 112): on the
// PIN page that approves a contact or makes an invite, only the owner's answer
// sets it, and the settings page lists who is on it, with a Turn off button
// behind the session and CSRF checks that no bearer token reaches.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { api, Browser, callJson, hidden, mcpClient, startGateway, type TestGateway, waitApi } from './helpers.js';

let relay: TestRelay;
let root: string;
let cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const c of cleanup) await c().catch(() => {});
  cleanup = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ g: TestGateway; token: string; b: Browser; dana: Side; danaId: string }> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-box-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.${process.pid}.${Date.now()}@example.com` });
  cleanup.push(() => g.gw.close());
  const dana = await makeSide('dana', join(root, 'dana'), { unsafeInviteRelays: [relay.url] });
  cleanup.push(() => dana.close());
  const d = await ok(dana, 'rdv_init', { profile: 'dana', email: `dana.${process.pid}.${Date.now()}@example.com`, relays: [relay.url] });
  const token = await g.token(['read', 'contact:request'], 'assistant');
  const b = new Browser(g.base);
  await b.unlock('/approve');
  return { g, token, b, dana, danaId: d.agent_id };
}

const linkIn = (html: string) => /<pre class="msg">(https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+)<\/pre>/.exec(html)![1];
const autoFile = (g: TestGateway) => g.home.readAutoApprove();

/** The owner answers an approval on the page, with these fields. */
async function answer(b: Browser, url: string, fields: Record<string, string>) {
  const path = new URL(url).pathname;
  const page = await b.get(path);
  expect(page.status).toBe(200);
  const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', ...fields });
  expect(done.status).toBe(200);
  return { page: page.text, done: done.text };
}

/** Dana's request waiting at the gateway: a revoked invite makes it an ordinary one. */
async function waiting(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const asked = await api(s.g.base, s.token, 'rdv_invite', { action: 'create' });
  const { done } = await answer(s.b, asked.body.result.approve_url, { f_tier: 'friend', f_expires_days: '2', f_name: '', f_label: '' });
  const ev = await waitApi(s.g.base, s.token, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the invite');
  await api(s.g.base, s.token, 'rdv_invite', { action: 'revoke', invite_id: ev.result.invite_id });
  await ok(s.dana, 'rdv_accept_invite', { invite: linkIn(done) });
  const req = await waitApi(s.g.base, s.token, (e) => e.type === 'contact_request', 'the request');
  return req.request_id as string;
}

describe('the box on the gateway page', () => {
  it('rdv_grant: a tool argument sets nothing, the box starts unticked, an answer without it leaves it off; the label and text inputs read right', { timeout: 90_000 }, async () => {
    const s = await setup();
    const requestId = await waiting(s);
    // REST refuses the unknown argument outright; over MCP the schema drops it and the page still starts unticked.
    const rest = await api(s.g.base, s.token, 'rdv_grant', { request_id: requestId, always_allow: true });
    expect(rest.status).toBe(400);
    const cloud = await mcpClient(s.g.base, s.token);
    cleanup.push(() => cloud.close());
    const asked = await callJson(cloud, 'rdv_grant', { request_id: requestId, always_allow: true, auto_approve: true });
    expect(asked.json.status).toBe('awaiting_human');
    expect(JSON.stringify((await cloud.listTools()).tools.map((x) => x.inputSchema))).not.toContain('always_allow');
    const path = new URL(asked.json.approve_url).pathname;
    const page = (await s.b.get(path)).text;
    expect(page).toMatch(/<input type="checkbox" id="f_always_allow" name="f_always_allow" value="1">/);
    expect(page).toContain('Don&#39;t ask again for this contact');
    expect(page).toContain(fingerprint(s.danaId));
    expect(page).toContain('a dinner they propose is accepted');
    expect(page).toContain('until you turn it off');
    expect(page).toContain('gateway&#39;s settings page');
    // The small form fix: the owner's name for them, no browser autofill on text inputs.
    expect(page).toContain('What you call them, e.g. Ran');
    expect(page).not.toContain('Local label');
    expect(page).toMatch(/<input type="text" id="f_label" name="f_label"[^>]* autocomplete="off">/);

    const done = await s.b.post(path, { csrf: hidden(page, 'csrf'), digest: hidden(page, 'digest'), decision: 'approve', f_tier: 'friend', f_label: 'Dana' });
    expect(done.status).toBe(200);
    const ev = await waitApi(s.g.base, s.token, (e) => e.type === 'approval' && e.tool === 'rdv_grant', 'the grant');
    expect(ev.result.granted).toBe(true);
    expect(ev.result.auto_approve).toBeUndefined();
    expect(autoFile(s.g)).toEqual({});
  });

  it('rdv_grant: ticked on the page it turns on, covering the grant', { timeout: 90_000 }, async () => {
    const s = await setup();
    const requestId = await waiting(s);
    const asked = await api(s.g.base, s.token, 'rdv_grant', { request_id: requestId });
    await answer(s.b, asked.body.result.approve_url, { f_tier: 'friend', f_label: 'Dana', f_always_allow: '1' });
    const ev = await waitApi(s.g.base, s.token, (e) => e.type === 'approval' && e.tool === 'rdv_grant', 'the grant');
    expect(ev.result.auto_approve).toMatchObject({ state: 'on', agent_id: s.danaId, covers: [MEETINGS_CAPABILITY] });
    expect(Object.keys(autoFile(s.g))).toEqual([s.danaId]);
    expect(s.g.home.readAudit().find((a) => a.gate === 'auto-approve')).toMatchObject({ peer: s.danaId, action: 'set', by: 'human', via: 'form' });
  });

  it('rdv_grant: with nothing to cover there is no box, and a posted one is not read', { timeout: 90_000 }, async () => {
    const s = await setup();
    const requestId = await waiting(s);
    const none = await api(s.g.base, s.token, 'rdv_grant', { request_id: requestId, may_propose_meetings: false, tier: 'stranger' });
    const nonePath = new URL(none.body.result.approve_url).pathname;
    const nonePage = (await s.b.get(nonePath)).text;
    expect(nonePage).not.toContain('f_always_allow');
    await s.b.post(nonePath, { csrf: hidden(nonePage, 'csrf'), digest: hidden(nonePage, 'digest'), decision: 'approve', f_tier: 'stranger', f_label: '', f_always_allow: '1' });
    await waitApi(s.g.base, s.token, (e) => e.type === 'approval' && e.tool === 'rdv_grant' && e.result?.granted === true, 'the plain grant');
    expect(autoFile(s.g)).toEqual({});
    expect(s.g.home.readAudit().filter((a) => a.gate === 'auto-approve')).toEqual([]);
  });

  it('rdv_invite: the owner ticks it, the redeemer goes on it, the settings page lists it and Turn off works; a bearer never reaches that', { timeout: 90_000 }, async () => {
    const s = await setup();
    expect((await api(s.g.base, s.token, 'rdv_invite', { action: 'create', always_allow: true })).status).toBe(400);
    const asked = await api(s.g.base, s.token, 'rdv_invite', { action: 'create' });
    const url = asked.body.result.approve_url as string;
    const { page, done } = await answer(s.b, url, { f_tier: 'friend', f_expires_days: '2', f_name: '', f_label: 'Dana <b>', f_may_propose_meetings: '1', f_always_allow: '1' });
    expect(page).toMatch(/<input type="checkbox" id="f_always_allow" name="f_always_allow" value="1">/);
    expect(page).toContain('whoever uses this link, and nobody else');
    expect(autoFile(s.g)).toEqual({});
    const made = await waitApi(s.g.base, s.token, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the invite');
    expect(made.result.auto_approve_when_used).toMatchObject({ state: 'chosen', covers: [MEETINGS_CAPABILITY] });

    await ok(s.dana, 'rdv_accept_invite', { invite: linkIn(done) });
    const on = await waitApi(s.g.base, s.token, (e) => e.type === 'auto_approve_on' && e.agent_id === s.danaId, 'auto_approve_on');
    expect(on).toMatchObject({ via: 'invite link', covers: [MEETINGS_CAPABILITY] });
    expect(Object.keys(autoFile(s.g))).toEqual([s.danaId]);

    // Settings page: fingerprint, the owner's label (escaped), coverage in words, a Turn off that needs the session's CSRF token.
    const admin = await s.b.get('/approve/admin');
    expect(admin.text).toContain('Auto-approved contacts');
    expect(admin.text).toContain(fingerprint(s.danaId));
    expect(admin.text).toContain('Dana &lt;b&gt;');
    expect(admin.text).not.toContain('Dana <b>');
    expect(admin.text).toContain('dinners they propose');
    expect(admin.text).toContain('action="/approve/admin/auto-approve/off"');
    const csrf = hidden(admin.text, 'csrf');
    const form = { agent: 'omer', peer: s.danaId, csrf };

    // No bearer, with or without the owner's session; no CSRF token, no change; no route turns it on.
    const all = await s.g.token(['read', 'send', 'contact:request', 'negotiate'], 'all');
    expect((await s.b.post('/approve/admin/auto-approve/off', form, { authorization: `Bearer ${all}` })).status).toBe(403);
    expect((await s.b.post('/approve/admin/auto-approve/off', { agent: 'omer', peer: s.danaId, csrf: 'nope' })).status).toBeGreaterThanOrEqual(400);
    expect((await new Browser(s.g.base).post('/approve/admin/auto-approve/off', form)).status).toBeGreaterThanOrEqual(400);
    expect((await s.b.post('/approve/admin/auto-approve/on', form)).status).toBe(404);
    expect((await api(s.g.base, all, 'rdv_auto_approve', { action: 'on', agent_id: s.danaId })).status).not.toBe(200);
    expect(Object.keys(autoFile(s.g))).toEqual([s.danaId]);

    const off = await s.b.post('/approve/admin/auto-approve/off', form);
    expect(off.status).toBe(200);
    expect(off.text).toContain('Auto-approve is off for Dana &lt;b&gt;');
    expect(off.text).toContain('No contact is on auto-approve');
    expect(autoFile(s.g)).toEqual({});
    expect(s.g.log.some((l) => l.startsWith('admin: auto-approve for ') && l.includes(fingerprint(s.danaId)))).toBe(true);
    expect(s.g.home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'owner', via: 'settings', peer: s.danaId });
    const told = await waitApi(s.g.base, s.token, (e) => e.type === 'auto_approve_off' && e.peer === s.danaId, 'auto_approve_off');
    expect(told.reason).toBe('owner');

    // Again, or for an agent or peer that is not there: nothing changes.
    expect((await s.b.post('/approve/admin/auto-approve/off', form)).status).toBe(404);
    expect((await s.b.post('/approve/admin/auto-approve/off', { ...form, peer: '<script>' })).status).toBe(404);
    expect((await s.b.post('/approve/admin/auto-approve/off', { ...form, agent: 'nobody' })).status).toBe(400);
  });
});
