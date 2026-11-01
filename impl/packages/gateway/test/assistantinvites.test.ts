// "My assistant may create invites without asking" (NOTES 113): the owner's
// standing choice per agent on the settings page. On, rdv_invite "create" gives
// the asking assistant a link at once, on terms the server forces; anything
// more, or a sixth open one, goes to the ordinary approval page. No bearer
// reaches the setting, and neither the event log nor the webhook holds a link.
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home, initHome } from '@rendezvous/cli/lib';
import { parseInvite } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { DEFAULT_NOTIFY_EVENTS, eventData, Gateway, GatewayStore, ROOT_BINDING, SCOPES } from '../src/index.js';
import { api, Browser, callJson, gatewayArgv, hidden, mcpClient, PIN, startGateway, type TestGateway, waitApi } from './helpers.js';

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
  for (const c of cleanup.reverse()) await c().catch(() => {});
  cleanup = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
const uniq = (who: string) => `${who}.ai${process.pid}.${Date.now()}.${++n}@example.com`;

async function gateway(extra: Parameters<typeof startGateway>[1] = {}): Promise<{ g: TestGateway; token: string; b: Browser }> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-ainv-'));
  const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: uniq('omer'), ...extra });
  cleanup.push(() => g.gw.close());
  const token = await g.token(['read', 'contact:request'], 'assistant');
  const b = new Browser(g.base);
  await b.unlock('/approve/admin');
  return { g, token, b };
}

async function side(name: string): Promise<Side> {
  const s = await makeSide(name, join(root, name), { unsafeInviteRelays: [relay.url] });
  cleanup.push(() => s.close());
  await ok(s, 'rdv_init', { profile: name, email: uniq(name), relays: [relay.url] });
  return s;
}

/** The owner turns the setting on (PIN again) for this agent. */
async function turnOn(b: Browser, agent = 'omer') {
  const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
  const r = await b.post('/approve/admin/assistant-invites/on', { csrf, agent, pin: PIN });
  expect(r.status, r.text).toBe(200);
  return r;
}

const create = (g: TestGateway, token: string, args: Record<string, unknown> = {}) => api(g.base, token, 'rdv_invite', { action: 'create', ...args });

/** A direct result: the link is there, and nothing waits for the owner. */
function direct(r: Awaited<ReturnType<typeof create>>) {
  expect(r.status, r.text).toBe(200);
  expect(r.body.result.status, r.text).toBeUndefined();
  expect(r.body.result.url).toMatch(/^https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+$/);
  return r.body.result;
}

const secretOf = (url: string) => url.split('#')[1];
const eventsFile = (g: TestGateway) => readFileSync(join(g.home.dir, 'events.jsonl'), 'utf8');
const auditFile = (g: TestGateway) => readFileSync(join(g.home.dir, 'audit.jsonl'), 'utf8');

/** Change this temp home's invite records as if time had passed or they had been used. */
async function editInvites(g: TestGateway, fn: (r: Record<string, Record<string, unknown>>) => void) {
  await g.home.locked(async () => {
    const s = g.home.readAgentState();
    fn(s.book.invites as never);
    g.home.writeAgentState(s);
  });
}

describe('off by default', () => {
  it('a new agent asks on the page exactly as before, and the result says the owner can turn it on', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    const page = await b.get('/approve/admin');
    expect(page.text).toContain('My assistant may create invites without asking');
    expect(page.text).toContain('Off: every invite asks you');
    // It says what it allows and the risk, in plain words.
    expect(page.text).toContain('cannot propose meetings, cannot invoke anything and get no standing approval');
    expect(page.text).toContain('prompt injection');
    expect(JSON.parse(readFileSync(join(g.home.dir, 'gateway.json'), 'utf8')).assistantInvites).toBeUndefined();

    const r = await create(g, token, { tier: 'stranger', may_propose_meetings: false });
    expect(r.body.result.status).toBe('awaiting_human');
    expect(r.body.result.url).toBeUndefined();
    expect(r.body.result.note).toContain('settings page');
    const form = await b.get(r.body.result.approve_url);
    expect(form.text).toMatch(/<option value="friend" selected/); // the page starts at its defaults, not the model's
    expect(form.text).not.toContain('open invite links it made'); // no cap note
    const done = await b.post(new URL(r.body.result.approve_url).pathname, { csrf: hidden(form.text, 'csrf'), digest: hidden(form.text, 'digest'), decision: 'approve', f_tier: 'colleague', f_expires_days: '20', f_name: '', f_label: 'Dana' });
    expect(done.status).toBe(200);
    const ev = await waitApi(g.base, token, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval');
    expect(ev.result).toMatchObject({ created: true, tier: 'colleague', local_label: 'Dana' });
    expect(ev.result.via).toBeUndefined();
    const list = (await api(g.base, token, 'rdv_invite', { action: 'list' })).body.result.invites;
    expect(list[0].via).toBeUndefined();
    expect(eventsFile(g)).not.toContain('invite_created_by_assistant');
  });
});

describe('on: a link at once, on forced terms', () => {
  it('returns url and share_text with stranger terms; list and page show it; events, audit and the log hold no link', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    expect(g.log.some((l) => l.startsWith('admin:') && l.includes('may now create invites'))).toBe(true);
    const r = direct(await create(g, token));
    expect(r).toMatchObject({ created: true, tier: 'stranger', may_propose_meetings: false, invoke: [], name: null, local_label: null, via: 'assistant' });
    expect(r.share_text).toContain(r.url);
    expect(r.auto_approve_when_used).toBeUndefined();
    const days = (Date.parse(r.expires) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    // Never on the wire: the link says nothing about how it was made.
    expect(Object.keys(parseInvite(r.url, { unsafeAllowRelays: [relay.url] })).sort()).toEqual(['agentId', 'expires', 'relays', 'secret']);
    // Stored as the server forced it, and marked.
    const rec = g.home.readAgentState().book.invites![r.invite_id];
    expect(rec).toMatchObject({ tier: 'stranger', via: 'assistant', scope: { may_propose_meetings: false, invoke: {} } });
    expect(rec.standing).toBeUndefined();
    expect(rec.label).toBeUndefined();

    const list = (await api(g.base, token, 'rdv_invite', { action: 'list' })).body.result.invites;
    expect(list[0]).toMatchObject({ invite_id: r.invite_id, status: 'open', tier: 'stranger', via: 'assistant' });
    const page = await b.get('/approve/admin');
    expect(page.text).toContain(r.invite_id);
    expect(page.text).toContain('/approve/admin/invite/revoke');
    expect(page.text).not.toContain(secretOf(r.url));

    // Every other client reads this event; none of it is the link.
    const ev = await waitApi(g.base, token, (e) => e.type === 'invite_created_by_assistant', 'the event');
    expect(ev).toMatchObject({ invite_id: r.invite_id, tier: 'stranger', via: 'assistant' });
    expect(JSON.stringify(ev)).not.toContain(secretOf(r.url));
    expect(ev.url).toBeUndefined();
    expect(ev.share_text).toBeUndefined();
    expect(eventsFile(g)).not.toContain(secretOf(r.url));
    expect(auditFile(g)).toContain(`"invite":"${r.invite_id}"`);
    expect(auditFile(g)).toContain('"by":"assistant-setting"');
    expect(auditFile(g)).not.toContain(secretOf(r.url));
    expect(g.log.some((l) => l.startsWith('admin:') && l.includes(r.invite_id))).toBe(true);
    expect(g.log.join('\n')).not.toContain(secretOf(r.url));
    // Nothing waited for the owner.
    expect(g.gw.approvals.size).toBe(0);
  });

  it('a shorter expiry is kept; asking exactly the forced terms stays direct; MCP gets the same; a redeemer is an unnamed stranger, and invite_redeemed says via', { timeout: 90_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const short = direct(await create(g, token, { tier: 'stranger', may_propose_meetings: false, invoke: [], expires_days: 3 }));
    expect((Date.parse(short.expires) - Date.now()) / 86_400_000).toBeLessThanOrEqual(3);
    const cloud = await mcpClient(g.base, token);
    cleanup.push(() => cloud.close());
    const viaMcp = await callJson(cloud, 'rdv_invite', { action: 'create', label: 'Ran' });
    expect(viaMcp.json).toMatchObject({ tier: 'stranger', via: 'assistant', local_label: null, suggested_label: 'Ran' });
    expect(viaMcp.json.url).toMatch(/#/);

    const ran = await side('ran');
    await ok(ran, 'rdv_accept_invite', { invite: viaMcp.json.url });
    const red = await waitApi(g.base, token, (e) => e.type === 'invite_redeemed', 'the redemption', 30_000);
    expect(red).toMatchObject({ invite_id: viaMcp.json.invite_id, via: 'assistant', tier: 'stranger', local_label: null, suggested_label: 'Ran' });
    expect(red.next_step).toContain('rdv_label');
    const contacts = (await api(g.base, token, 'rdv_status')).body.result.contacts as Array<Record<string, unknown>>;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ tier: 'stranger' });
    expect(contacts[0].local_label ?? null).toBeNull();
    const contact = Object.values(g.home.readAgentState().book.contacts)[0];
    expect(contact.inboundScope?.may_propose_meetings).toBe(false);
    expect(Object.keys(contact.inboundScope?.invoke ?? {})).toEqual([]);
    expect(contact.label).toBeUndefined();
    expect(JSON.stringify(g.home.readAutoApprove())).not.toContain(contact.peer); // no standing approval
  });
});

describe('on: anything more goes to the page, never lowered', () => {
  it.each([
    ['tier friend', { tier: 'friend' }],
    ['tier colleague', { tier: 'colleague' }],
    ['tier business', { tier: 'business' }],
    ['meetings', { may_propose_meetings: true }],
    ['invoke', { invoke: ['https://example.com/ext/review/v1'] }],
    ['8 days', { expires_days: 8 }],
    ['30 days', { expires_days: 30 }],
    ['stranger but 8 days', { tier: 'stranger', expires_days: 8 }],
  ])('%s', { timeout: 30_000 }, async (_what, args) => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const r = await create(g, token, args);
    expect(r.body.result.status).toBe('awaiting_human');
    expect(r.body.result.url).toBeUndefined();
    expect(r.body.result.note).toContain('Nothing was lowered');
    expect(g.home.readAgentState().book.invites ?? {}).toEqual({});
    expect(g.gw.approvals.size).toBe(1);
  });

  it('the owner can still grant more there, with the setting on, and that invite is not marked', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const r = await create(g, token, { tier: 'friend', may_propose_meetings: true });
    const url = r.body.result.approve_url as string;
    const form = await b.get(url);
    const done = await b.post(new URL(url).pathname, { csrf: hidden(form.text, 'csrf'), digest: hidden(form.text, 'digest'), decision: 'approve', f_tier: 'friend', f_may_propose_meetings: '1', f_expires_days: '14', f_name: '', f_label: 'Ran' });
    expect(done.status, done.text).toBe(200);
    expect(done.text).toContain('Invite link');
    const ev = await waitApi(g.base, token, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval');
    expect(ev.outcome).toBe('decided');
    expect(ev.result).toMatchObject({ tier: 'friend', may_propose_meetings: true, local_label: 'Ran' });
    const rec = Object.values(g.home.readAgentState().book.invites ?? {})[0];
    expect(rec.via).toBeUndefined();
    expect(rec.suggestedLabel).toBeUndefined();
  });

  it('turning it off sends the next one to the page, keeps open links and lists them', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const made = direct(await create(g, token));
    const page = await b.get('/approve/admin');
    const off = await b.post('/approve/admin/assistant-invites/off', { csrf: hidden(page.text, 'csrf'), agent: 'omer' });
    expect(off.status).toBe(200);
    expect(off.text).toContain('Off: every invite asks you');
    expect(off.text).toContain(made.invite_id);
    expect(g.log.some((l) => l.startsWith('admin:') && l.includes('no longer create invites'))).toBe(true);
    expect((await create(g, token)).body.result.status).toBe('awaiting_human');
    expect(g.home.readAgentState().book.invites![made.invite_id].revoked).toBeUndefined();
  });
});

describe('the cap: five open', () => {
  it('the 6th goes to the page with a note that is outside the digest; revoked, used and expired ones free a slot', { timeout: 90_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const made = [];
    for (let i = 0; i < 5; i += 1) made.push(direct(await create(g, token)));
    const sixth = await create(g, token);
    expect(sixth.body.result.status).toBe('awaiting_human');
    expect(sixth.body.result.note).toContain('still open');
    const url = sixth.body.result.approve_url as string;
    const form = await b.get(url);
    expect(form.text).toContain('5 open invite links it made without asking');
    expect(Object.keys(g.home.readAgentState().book.invites ?? {})).toHaveLength(5);

    // A revoke through the tool frees one, and the owner's answer to the form still matches: the note is not in its digest.
    await api(g.base, token, 'rdv_invite', { action: 'revoke', invite_id: made[0].invite_id });
    const approved = await b.post(new URL(url).pathname, { csrf: hidden(form.text, 'csrf'), digest: hidden(form.text, 'digest'), decision: 'approve', f_tier: 'stranger', f_expires_days: '1', f_name: '', f_label: '' });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.text).toContain('Invite link');
    // That one was the owner's: it takes no slot, so the revoke's slot is still free.
    direct(await create(g, token));
    expect((await create(g, token)).body.result.status).toBe('awaiting_human');

    // Used and expired ones free a slot too.
    await editInvites(g, (r) => {
      r[made[1].invite_id].used = { at: new Date().toISOString(), by: `rdv1:${'a'.repeat(52)}`, request: 'r' };
    });
    direct(await create(g, token));
    expect((await create(g, token)).body.result.status).toBe('awaiting_human');
    await editInvites(g, (r) => {
      r[made[2].invite_id].expires = new Date(Date.now() - 1000).toISOString();
    });
    direct(await create(g, token));
    expect((await create(g, token)).body.result.status).toBe('awaiting_human');
  });

  it('parallel calls cannot pass it', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => create(g, token, { expires_days: 1 + (i % 7) })));
    const links = all.filter((r) => r.body.result.url);
    expect(links).toHaveLength(5);
    const open = Object.values(g.home.readAgentState().book.invites ?? {}).filter((r) => r.via === 'assistant');
    expect(open).toHaveLength(5);
  });
});

describe('who can reach it', () => {
  it('a read-only token is refused; a token without contact:request is too', { timeout: 30_000 }, async () => {
    const { g, b } = await gateway();
    await turnOn(b);
    const reader = await g.token(['read'], 'reader');
    const sender = await g.token(['read', 'send', 'negotiate'], 'sender');
    for (const t of [reader, sender]) {
      const r = await create(g, t);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain('rendezvous.nesher.co/i#');
    }
    expect(g.home.readAgentState().book.invites ?? {}).toEqual({});
  });

  it('no bearer reaches the setting or the revoke, with every scope, even on the owner\'s cookie; no tool or argument turns it on', { timeout: 60_000 }, async () => {
    const { g, b } = await gateway();
    const all = await g.token([...SCOPES], 'all-scopes');
    const bearer = { authorization: `Bearer ${all}` };
    const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
    for (const [path, form] of [
      ['/approve/admin/assistant-invites/on', { agent: 'omer', pin: PIN, csrf }],
      ['/approve/admin/assistant-invites/off', { agent: 'omer', csrf }],
      ['/approve/admin/invite/revoke', { agent: 'omer', id: '0123456789abcdef', csrf }],
    ] as const) {
      expect((await b.post(path, form, bearer)).status, path).toBe(403);
      // The bearer alone, no cookie.
      const r = await fetch(new URL(path, g.base), { method: 'POST', headers: { ...bearer, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
      expect(r.status, path).toBe(403);
      // Nothing under an agent's URL.
      expect((await fetch(new URL(`/a/omer${path}`, g.base), { method: 'POST', headers: bearer })).status, path).toBe(404);
    }
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, g.gw.primary.id!)).toBe(false);
    // No REST route or tool for it, and an argument is refused or dropped rather than obeyed.
    const names = ((await (await fetch(new URL('/api/v1/tools', g.base), { headers: bearer })).json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names.filter((x) => /setting|admin|assistant/i.test(x))).toEqual([]);
    expect((await api(g.base, all, 'rdv_invite', { action: 'create', assistant_invites: true })).status).toBe(400);
    const cloud = await mcpClient(g.base, all);
    cleanup.push(() => cloud.close());
    const r = await callJson(cloud, 'rdv_invite', { action: 'create', assistant_invites: true, via: 'assistant' });
    expect(r.json.status).toBe('awaiting_human');
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, g.gw.primary.id!)).toBe(false);
  });

  it('turning on needs the PIN again, the session CSRF token and a same-origin post; turning off needs only the session', { timeout: 60_000 }, async () => {
    const { g, b } = await gateway();
    const id = g.gw.primary.id!;
    const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
    const on = (form: Record<string, string>, extra: Record<string, string> = {}) => b.post('/approve/admin/assistant-invites/on', form, extra);
    const wrong = await on({ csrf, agent: 'omer', pin: 'not-the-pin' });
    expect(wrong.status).toBe(403);
    expect(wrong.text).toContain('Nothing changed');
    expect(g.log.some((l) => l.includes('wrong PIN was entered on the gateway settings page (assistant invites)'))).toBe(true);
    expect((await on({ csrf, agent: 'omer' })).status).toBe(403);
    expect((await on({ csrf: 'forged', agent: 'omer', pin: PIN })).status).toBe(403);
    expect((await on({ csrf, agent: 'omer', pin: PIN }, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await on({ csrf, agent: 'omer', pin: PIN }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await on({ csrf, agent: 'nobody', pin: PIN })).status).toBe(400);
    expect((await new Browser(g.base).post('/approve/admin/assistant-invites/on', { csrf, agent: 'omer', pin: PIN })).status).toBe(401);
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, id)).toBe(false);
    expect((await on({ csrf, agent: 'omer', pin: PIN })).status).toBe(200);
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, id)).toBe(true);
    // Off asks no PIN; still the session and CSRF.
    expect((await b.post('/approve/admin/assistant-invites/off', { csrf: 'forged', agent: 'omer' })).status).toBe(403);
    expect((await new Browser(g.base).post('/approve/admin/assistant-invites/off', { csrf, agent: 'omer' })).status).toBe(401);
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, id)).toBe(true);
    expect((await b.post('/approve/admin/assistant-invites/off', { csrf, agent: 'omer' })).status).toBe(200);
    expect(g.gw.store.assistantInvitesOn(ROOT_BINDING, id)).toBe(false);
  });

  it('Revoke on the page: only an open invite the assistant made; audited and logged', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const made = direct(await create(g, token));
    const asked = await create(g, token, { tier: 'friend' });
    const form = await b.get(asked.body.result.approve_url);
    await b.post(new URL(asked.body.result.approve_url).pathname, { csrf: hidden(form.text, 'csrf'), digest: hidden(form.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '2', f_name: '', f_label: '' });
    const owners = (await waitApi(g.base, token, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the owner\'s invite')).result.invite_id as string;
    const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
    const revoke = (id: string, agent = 'omer') => b.post('/approve/admin/invite/revoke', { csrf, agent, id });
    expect((await revoke(owners)).status).toBe(404);
    expect((await revoke('../../etc')).status).toBe(404);
    expect((await revoke(made.invite_id, 'nobody')).status).toBe(400);
    const done = await revoke(made.invite_id);
    expect(done.status).toBe(200);
    expect(done.text).toContain('revoked');
    const invites = g.home.readAgentState().book.invites!;
    expect(invites[made.invite_id].revoked).toBeTruthy();
    expect(invites[owners].revoked).toBeUndefined();
    expect((await revoke(made.invite_id)).status).toBe(404);
    expect(g.log.some((l) => l.startsWith('admin:') && l.includes(made.invite_id) && l.includes('revoked'))).toBe(true);
    expect(auditFile(g)).toMatch(new RegExp(`"action":"revoke"[^\\n]*"invite":"${made.invite_id}"[^\\n]*"via":"settings"|"invite":"${made.invite_id}"[^\\n]*"action":"revoke"`));
  });
});

describe('the label: a model never names a contact', () => {
  it('a label that collides with a contact\'s label or nickname takes nothing, and neither does a free one; the redeemer stays unnamed; "tell John" still reaches John', { timeout: 120_000 }, async () => {
    const { g, token, b } = await gateway();
    // John is a contact the owner named on the page, with a nickname.
    const john = await side('john');
    const asked = await create(g, token);
    const form = await b.get(asked.body.result.approve_url);
    const done = await b.post(new URL(asked.body.result.approve_url).pathname, { csrf: hidden(form.text, 'csrf'), digest: hidden(form.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '2', f_name: '', f_label: 'John' });
    const johnsLink = /<pre class="msg">(https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+)<\/pre>/.exec(done.text)![1];
    await ok(john, 'rdv_accept_invite', { invite: johnsLink });
    await waitApi(g.base, token, (e) => e.type === 'invite_redeemed', 'John', 30_000);
    await g.home.locked(async () => {
      const s = g.home.readAgentState();
      Object.values(s.book.contacts)[0].aliases = ['Johnny'];
      g.home.writeAgentState(s);
    });
    const johnPeer = Object.values(g.home.readAgentState().book.contacts)[0].peer;

    await turnOn(b);
    for (const taken of ['John', 'john', "John's agent", 'Johnny', 'JOHNNY']) {
      const r = direct(await create(g, token, { label: taken, name: taken }));
      expect(r.local_label, taken).toBeNull();
      expect(r.suggested_label, taken).toBeUndefined();
      expect(r.label_note, taken).toContain('not kept');
      expect(r.name_note, taken).toBeDefined();
      expect(g.home.readAgentState().book.invites![r.invite_id].suggestedLabel, taken).toBeUndefined();
      await api(g.base, token, 'rdv_invite', { action: 'revoke', invite_id: r.invite_id });
    }
    const attack = direct(await create(g, token, { label: 'John', name: 'John' }));
    expect(parseInvite(attack.url, { unsafeAllowRelays: [relay.url] }).name).toBeUndefined();
    const eve = await side('eve');
    await ok(eve, 'rdv_accept_invite', { invite: attack.url });
    const red = await waitApi(g.base, token, (e) => e.type === 'invite_redeemed' && e.invite_id === attack.invite_id, 'Eve', 30_000);
    expect(red.local_label).toBeNull();
    expect(red.suggested_label).toBeNull();
    const eveContact = Object.values(g.home.readAgentState().book.contacts).find((c) => c.peer !== johnPeer)!;
    expect(eveContact.label).toBeUndefined();
    expect(eveContact.aliases).toBeUndefined();
    // "John" resolves to John alone.
    const send = await api(g.base, await g.token(['send'], 'sender'), 'rdv_send', { to: 'John', payload: { type: 'note', text: 'hello' } });
    expect(send.status, send.text).toBe(200);
    expect(JSON.stringify(send.body.result)).toContain(johnPeer);

    // A free name is only a note: the page says whose words it is, escaped, and it names nobody either.
    const free = direct(await create(g, token, { label: 'Ran <b>x</b>' }));
    expect(free).toMatchObject({ local_label: null });
    expect(free.label_note).toContain('rdv_label');
    const rec = g.home.readAgentState().book.invites![free.invite_id];
    expect(rec.label).toBeUndefined();
    expect(rec.suggestedLabel).toBe('Ran <b>x</b>');
    const page = await b.get('/approve/admin');
    expect(page.text).toContain('Ran &lt;b&gt;x&lt;/b&gt;');
    expect(page.text).not.toContain('Ran <b>x</b>');
  });
});

describe('the setting persists, bound to its agent', () => {
  it('survives a restart; the store holds no secret for it; another identity under the binding reads as off', { timeout: 60_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    const home = g.home;
    await g.gw.close();
    const again = new Gateway({ home, port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    cleanup.push(() => again.close());
    const base = await again.start();
    const r = await api(base, token, 'rdv_invite', { action: 'create' });
    expect(r.body.result.url).toMatch(/#/);
    const id = again.primary.id!;
    const stored = JSON.parse(readFileSync(join(home.dir, 'gateway.json'), 'utf8')).assistantInvites;
    expect(Object.keys(stored)).toEqual([ROOT_BINDING]);
    expect(stored[ROOT_BINDING].agentId).toBe(id);
    expect(again.store.assistantInvitesOn(ROOT_BINDING, `rdv1:${'b'.repeat(52)}`)).toBe(false);
    expect(again.store.assistantInvitesOn('someone', id)).toBe(false);
    expect(again.store.assistantInvitesOn('__proto__', id)).toBe(false);
  });

  it('does not leak across agents: each has its own setting, cap and page section', { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-ainv-'));
    for (const name of ['kids', 'work']) await initHome(new Home(join(root, 'agents', name)), { profile: name, relays: [relay.url], emails: [uniq(name)], publicPointer: true });
    const gw = new Gateway({ home: new Home(root), port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    cleanup.push(() => gw.close());
    await gw.store.setPin(PIN);
    const base = await gw.start();
    const kids = (await gw.store.createToken('kids-a', ['read', 'contact:request'], 'kids')).token;
    const work = (await gw.store.createToken('work-a', ['read', 'contact:request'], 'work')).token;
    const b = new Browser(base);
    await b.unlock('/approve/admin');
    await turnOn(b, 'kids');
    const mine = await api(base, kids, 'rdv_invite', { action: 'create' });
    expect(mine.body.result.url).toMatch(/#/);
    const theirs = await api(base, work, 'rdv_invite', { action: 'create', tier: 'stranger', may_propose_meetings: false });
    expect(theirs.body.result.status).toBe('awaiting_human');
    expect(theirs.body.result.note).toContain('settings page');
    // The work token sees none of kids' invites, nor revokes one by id on the page under its own agent.
    expect((await api(base, work, 'rdv_invite', { action: 'list' })).body.result.invites).toEqual([]);
    const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
    expect((await b.post('/approve/admin/invite/revoke', { csrf, agent: 'work', id: mine.body.result.invite_id })).status).toBe(404);
    expect((await b.post('/approve/admin/assistant-invites/off', { csrf, agent: 'work' })).text).toContain('already off');
    expect(gw.store.assistantInvitesOn('kids', gw.agent('kids')!.id!)).toBe(true);
  });

  it('follows the agent through migrate and its undo, and `agent remove` takes it away', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-ainv-'));
    const store = new GatewayStore(new Home(root));
    const id = `rdv1:${'c'.repeat(52)}`;
    await store.setPin(PIN);
    await store.enableAssistantInvites(ROOT_BINDING, id, store.pinSetAt()!);
    await store.rebindAgent('omer', 'main');
    expect(store.assistantInvitesOn(ROOT_BINDING, id)).toBe(false);
    expect(store.assistantInvitesOn('main', id)).toBe(true);
    await store.unbindAgent('main');
    expect(store.assistantInvitesOn(ROOT_BINDING, id)).toBe(true);
    await store.rebindAgent('omer', 'main');
    await store.revokeAgent('main');
    expect(store.assistantInvitesOn('main', id)).toBe(false);
    // An old PIN check authorizes nothing once the PIN changed.
    await expect(store.enableAssistantInvites(ROOT_BINDING, id, 'stale')).rejects.toThrow(/PIN changed/);
    expect(store.assistantInvitesOn(ROOT_BINDING, id)).toBe(false);
  });

  it('`agent migrate` itself keeps it on for that agent', { timeout: 90_000 }, async () => {
    const { g, token, b } = await gateway();
    await turnOn(b);
    await g.gw.close();
    const dir = g.home.dir;
    const m = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, gatewayArgv(['agent', 'migrate', '--home', dir]), { timeout: 60_000 }, (err, _o, stderr) => resolve({ code: err ? 1 : 0, stderr: String(stderr) }));
    });
    expect(m.code, m.stderr).toBe(0);
    const gw2 = new Gateway({ home: new Home(dir), port: 0, humanLog: () => {}, pollMs: 150, sweepMs: 3_600_000 });
    cleanup.push(() => gw2.close());
    const base = await gw2.start();
    expect(gw2.primary.root).toBe(false);
    expect((await api(base, token, 'rdv_invite', { action: 'create' })).body.result.url).toMatch(/#/);
  });
});

describe('the owner hears it without the assistant', () => {
  it('eventData: only checked metadata, never a link; invite_redeemed says via; the new event is in the default set', () => {
    expect(DEFAULT_NOTIFY_EVENTS).toContain('invite_created_by_assistant');
    const made = eventData(
      { event: 'mcp', item: { type: 'invite_created_by_assistant', invite_id: '0123456789abcdef', tier: 'stranger', expires: '2026-11-08T00:00:00.000Z', via: 'assistant', asked_by: 'tok_abc', url: 'https://rendezvous.nesher.co/i#SECRET', share_text: 'SECRET' } },
      () => undefined,
    )!;
    expect(made).toEqual({ event: 'invite_created_by_assistant', data: { invite_id: '0123456789abcdef', tier: 'stranger', expires: '2026-11-08T00:00:00.000Z', via: 'assistant', asked_by: 'tok_abc' } });
    // Junk is nulled; other server events carry nothing to a webhook.
    expect(eventData({ event: 'mcp', item: { type: 'invite_created_by_assistant', invite_id: 'x', tier: 'god', asked_by: 'rdvg_secret' } }, () => undefined)!.data).toMatchObject({ invite_id: null, tier: null, asked_by: null });
    expect(eventData({ event: 'mcp', item: { type: 'approval', result: {} } }, () => undefined)).toBeUndefined();
    expect(eventData({ event: 'mcp' }, () => undefined)).toBeUndefined();
    const red = eventData({ event: 'invite-redeemed', invite_id: '0123456789abcdef', tier: 'stranger', peer: `rdv1:${'a'.repeat(52)}`, via: 'assistant', suggested_label: 'Ran' }, () => undefined)!;
    expect(red.data.via).toBe('assistant');
    expect(JSON.stringify(red)).not.toContain('Ran');
    expect(eventData({ event: 'invite-redeemed', invite_id: '0123456789abcdef', tier: 'friend', peer: `rdv1:${'a'.repeat(52)}` }, () => undefined)!.data.via).toBeUndefined();
  });

  it('a serving gateway posts invite_created_by_assistant: signed metadata, and no link anywhere in it', { timeout: 60_000 }, async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push(body);
        res.end('ok');
      });
    });
    cleanup.push(() => new Promise((r) => server.close(r)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const { g, token, b } = await gateway({ notify: { tickMs: 50, settleMs: 5 } });
    await g.gw.notifyStore.set(ROOT_BINDING, { url: `http://127.0.0.1:${port}/rdv`, events: [...DEFAULT_NOTIFY_EVENTS], insecureHosts: ['127.0.0.1'] }, Buffer.from('rdv-test-secret-0123456789abcdef'), 0, new Date(), g.gw.primary.id);
    await turnOn(b);
    const r = direct(await create(g, token));
    const until = Date.now() + 15_000;
    while (hits.length === 0 && Date.now() < until) await new Promise((x) => setTimeout(x, 50));
    expect(hits).toHaveLength(1);
    const body = JSON.parse(hits[0]);
    expect(body).toMatchObject({ event: 'invite_created_by_assistant', data: { invite_id: r.invite_id, tier: 'stranger', via: 'assistant' } });
    expect(hits[0]).not.toContain(secretOf(r.url));
    expect(hits[0]).not.toContain('rendezvous.nesher.co');
  });
});
