// A gateway restart is named, not blamed on the owner (issue #140): approvals and held invite links live in
// memory, so a second Gateway on the same home does not know the first one's ids.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { api, Browser, hidden, startGateway, type TestGateway } from './helpers.js';

let relay: TestRelay;
let root: string;
let gws: TestGateway[] = [];
let side: Side | undefined;
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  await side?.close();
  side = undefined;
  for (const g of gws) await g.gw.close();
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

const STAMP = /\d{4}-\d\d-\d\d \d\d:\d\d UTC/;
const LOST = new RegExp(`lost in a gateway restart \\(this gateway started on ${STAMP.source}\\)`);
const tagOf = (url: string) => /\/approve\/apr_([0-9a-f]{6})_/.exec(url)?.[1];
const stamp = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** Gateway one (closed) and gateway two on the same home; the token of one still works on two. */
async function restarted() {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-restart-'));
  const dir = join(root, 'omer');
  const g1 = await startGateway(dir, { relays: [relay.url], email: `omer.${process.pid}.${Date.now()}@example.com` });
  const token = await g1.token(['read', 'contact:request'], 'asker');
  const first = await api(g1.base, token, 'rdv_invite', { action: 'create', label: 'Dana' });
  expect(first.body.result.status).toBe('awaiting_human');
  const bootOne = first.body.result.gateway_started_at as string;
  expect(bootOne).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect((await api(g1.base, token, 'rdv_status')).body.result.gateway_started_at).toBe(bootOne);
  return { g1, dir, token, oldUrl: first.body.result.approve_url as string, bootOne };
}

describe('gateway restart', () => {
  it('an id from the first process says the gateway restarted (full date, after the PIN); an id of this process does not', { timeout: 90_000 }, async () => {
    const { g1, dir, token, oldUrl, bootOne } = await restarted();
    const oldPath = new URL(oldUrl).pathname;
    await g1.gw.close();
    await new Promise((r) => setTimeout(r, 1100)); // a distinct boot minute is not needed: the tag is
    const g2 = await startGateway(dir, { init: false, pin: false });
    gws.push(g2);

    // Locked: no restart text before the PIN.
    expect((await new Browser(g2.base).get(oldPath)).text).not.toMatch(/restarted on/);
    const b = new Browser(g2.base);
    await b.unlock(oldPath);
    const gone = await b.get(oldPath);
    expect(gone.status).toBe(404);
    expect(gone.text).toMatch(LOST);

    // The assistant sees a different boot time on the new process, in status and in a new ask.
    const bootTwo = (await api(g2.base, token, 'rdv_status')).body.result.gateway_started_at as string;
    expect(bootTwo).not.toBe(bootOne);
    expect(gone.text).toContain(stamp(bootTwo));
    const again = await api(g2.base, token, 'rdv_invite', { action: 'create', label: 'Dana' });
    expect(again.body.result.gateway_started_at).toBe(bootTwo);
    expect(again.body.result.approve_url).not.toBe(oldUrl);
    expect(tagOf(oldUrl)).toMatch(/^[0-9a-f]{6}$/);
    expect(tagOf(again.body.result.approve_url)).not.toBe(tagOf(oldUrl));

    // A tagless id (an older format, or invented) reads as lost in a restart, still only behind the PIN.
    const tagless = await b.get(`/approve/apr_${'B'.repeat(24)}`);
    expect(tagless.status).toBe(404);
    expect(tagless.text).toMatch(LOST);
    // Not an approval id at all: no restart claim.
    expect((await b.get('/approve/zzz')).text).not.toMatch(/started on/);

    // An id this process made and dropped (decided or expired): no restart claim.
    const id = new URL(again.body.result.approve_url).pathname.split('/').pop()!;
    g2.gw.approvals.drop(id);
    const same = await b.get(`/approve/${id}`);
    expect(same.status).toBe(404);
    expect(same.text).not.toMatch(/restarted/);
    expect(same.text).toContain('decided or it expired');

    // The empty list says when the last restart was and that an open approval did not run.
    const list = await b.get('/approve');
    expect(list.text).toContain('Nothing waits for you');
    expect(list.text).toContain(`This gateway started on ${stamp(bootTwo)}`);
    expect(list.text).toContain('may not have been carried out');
  });

  it('a held invite link lost in a restart says so, and that the invite still works until revoked', { timeout: 90_000 }, async () => {
    const { g1, dir, token, oldUrl } = await restarted();
    const path = new URL(oldUrl).pathname;
    const b1 = new Browser(g1.base);
    await b1.unlock(path);
    const page = await b1.get(oldUrl);
    const done = await b1.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '', f_name: 'Omer', f_label: 'Dana' });
    expect(done.status).toBe(200);
    const approvalId = path.split('/').pop()!;
    expect((await api(g1.base, token, 'rdv_invite', { action: 'list' })).body.result.invites).toHaveLength(1);
    await g1.gw.close();
    const g2 = await startGateway(dir, { init: false, pin: false });
    gws.push(g2);

    const lost = await api(g2.base, token, 'rdv_invite', { action: 'link', approval_id: approvalId });
    const text = JSON.stringify(lost.body);
    expect(text).toMatch(LOST);
    expect(text).toContain('works until it is used, expires or is revoked');
    expect(text).toContain('Ask your user before you revoke it');
    // The invite is still there to list, and revoking it after the restart works.
    const listed = (await api(g2.base, token, 'rdv_invite', { action: 'list' })).body.result.invites as Array<{ invite_id: string }>;
    expect(listed).toHaveLength(1);
    const rev = await api(g2.base, token, 'rdv_invite', { action: 'revoke', invite_id: listed[0].invite_id });
    expect(rev.status).toBe(200);
    expect(JSON.stringify((await api(g2.base, token, 'rdv_invite', { action: 'list' })).body.result.invites)).toContain('revoked');
  });

  it('the same process: a link taken once reads as taken, another client gets no revoke advice, a revoked token\'s ask reads as disconnected', { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-restart-'));
    const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.${process.pid}.${Date.now()}@example.com` });
    gws.push(g);
    const mk = await g.gw.store.createToken('asker', ['read', 'contact:request']);
    const other = await g.token(['read', 'contact:request'], 'other');
    const r = await api(g.base, mk.token, 'rdv_invite', { action: 'create', label: 'Dana' });
    const url = r.body.result.approve_url as string;
    const path = new URL(url).pathname;
    const b = new Browser(g.base);
    await b.unlock(path);
    const page = await b.get(url);
    await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '', f_name: 'Omer', f_label: 'Dana' });
    const id = path.split('/').pop()!;
    const stolen = JSON.stringify((await api(g.base, other, 'rdv_invite', { action: 'link', approval_id: id })).body);
    expect(stolen).toContain('another client asked for it');
    expect(stolen).not.toMatch(/revoke/);
    expect((await api(g.base, mk.token, 'rdv_invite', { action: 'link', approval_id: id })).body.result.url).toBeTruthy();
    const second = JSON.stringify((await api(g.base, mk.token, 'rdv_invite', { action: 'link', approval_id: id })).body);
    expect(second).toContain('may already be with someone');
    expect(second).toContain('Ask your user before you revoke it');

    const mk2 = await g.gw.store.createToken('asker2', ['read', 'contact:request']);
    const ask = await api(g.base, mk2.token, 'rdv_invite', { action: 'create', label: 'Eli' });
    const askPath = new URL(ask.body.result.approve_url).pathname;
    expect((await b.get(askPath)).status).toBe(200);
    await g.gw.store.revokeToken(mk2.info.id);
    const gone = await b.get(askPath);
    expect(gone.status).toBe(404);
    expect(gone.text).toContain('disconnected');
    expect(gone.text).not.toMatch(/started on/);
  });

  it('local mode has no gateway_started_at', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-restart-'));
    side = await makeSide('john', join(root, 'john'));
    await ok(side, 'rdv_init', { profile: 'john', email: `john.${process.pid}@doe.com`, relays: [relay.url] });
    expect(await ok(side, 'rdv_status')).not.toHaveProperty('gateway_started_at');
  });
});
