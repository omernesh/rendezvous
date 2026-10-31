// Invite links through the gateway (NOTES 101, review of PR #120): the link
// an approved rdv_invite "create" makes is never in the shared event log, so
// another token (even read-only) cannot redeem it first; it goes to the token
// that asked (once) and to the owner on the page that approved it. The
// model's tier, name, label and capabilities are only suggestions there.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, Browser, hidden, startGateway, type TestGateway, waitApi } from './helpers.js';

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

describe('rdv_invite through the gateway', () => {
  it('M1 + L5: the link reaches only the asking token and the owner\'s page; suggestions are not preselected', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-invite-'));
    const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.${process.pid}.${Date.now()}@example.com` });
    gws.push(g);
    const asker = await g.token(['read', 'contact:request'], 'asker');
    const reader = await g.token(['read'], 'reader');
    const other = await g.token(['read', 'contact:request'], 'other');

    const r = await api(g.base, asker, 'rdv_invite', {
      action: 'create',
      tier: 'colleague',
      name: 'Evil $(touch pwned)',
      label: 'Dana',
      invoke: ['https://example.com/ext/review/v1'],
    });
    expect(r.body.result).toMatchObject({ status: 'awaiting_human' });
    const url = r.body.result.approve_url as string;

    const b = new Browser(g.base);
    const path = new URL(url).pathname;
    await b.unlock(path);
    const page = await b.get(url);
    // L5: the page starts at the defaults; the model's choices are suggestions beside the fields.
    expect(page.text).toMatch(/<option value="friend" selected/);
    expect(page.text).not.toMatch(/<option value="colleague" selected/);
    expect(page.text).toContain('Your assistant suggests the tier &quot;colleague&quot;');
    expect(page.text).toContain('Your assistant suggests the label &quot;Dana&quot;');
    expect(page.text).toContain('Evil $(touch pwned)'); // shown as a suggestion only, escaped
    expect(page.text).not.toMatch(/name="f_name"[^>]*value="Evil/);
    expect(page.text).not.toMatch(/name="f_allow_invoke"[^>]*checked/);

    const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '2', f_name: 'Omer', f_label: '' });
    expect(done.status).toBe(200);
    // The owner sees the link on the page that approved it, escaped.
    const link = /<pre class="msg">(https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+)<\/pre>/.exec(done.text)?.[1];
    expect(link).toBeTruthy();
    expect(done.text).toContain('Message ready to send');

    // Every token sees the approval event, and none of them sees the link in it.
    const ev = await waitApi(g.base, reader, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval event');
    expect(ev.outcome).toBe('decided');
    expect(ev.result).toMatchObject({ created: true, tier: 'friend', name: 'Omer', invoke: [] });
    expect(JSON.stringify(ev)).not.toContain(link!.split('#')[1]);
    expect(ev.held_for_you).toMatch(/rdv_invite action "link"/);
    expect(readFileSync(join(g.home.dir, 'events.jsonl'), 'utf8')).not.toContain(link!.split('#')[1]);

    // Only the asking token takes it, once.
    const stolen = await api(g.base, other, 'rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect(JSON.stringify(stolen.body)).not.toContain(link!.split('#')[1]);
    expect(JSON.stringify(stolen.body)).toMatch(/nothing is held/);
    expect((await api(g.base, reader, 'rdv_invite', { action: 'link', approval_id: ev.approval_id })).status).not.toBe(200);
    const mine = await api(g.base, asker, 'rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect(mine.body.result.url).toBe(link);
    expect(mine.body.result.share_text).toContain(link);
    const again = await api(g.base, asker, 'rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect(JSON.stringify(again.body)).toMatch(/nothing is held/);
  });

  it('another token asking the same call gets its own approval and never takes the first one\'s link; a blank days field is the default', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-invite-'));
    const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.${process.pid}.${Date.now()}@example.com` });
    gws.push(g);
    const a = await g.token(['read', 'contact:request'], 'first');
    const b = await g.token(['read', 'contact:request'], 'second');
    const args = { action: 'create', label: 'Dana' };
    const urlA = (await api(g.base, a, 'rdv_invite', args)).body.result.approve_url as string;
    // The same call from another token: its own entry, not a rebinding of the first one.
    const urlB = (await api(g.base, b, 'rdv_invite', args)).body.result.approve_url as string;
    expect(urlB).not.toBe(urlA);
    // A asking again reuses its own.
    expect((await api(g.base, a, 'rdv_invite', args)).body.result.approve_url).toBe(urlA);

    const br = new Browser(g.base);
    const path = new URL(urlA).pathname;
    await br.unlock(path);
    const page = await br.get(urlA);
    expect(page.text).toContain('first'); // asked by the first token
    expect(page.text).not.toMatch(/Asked by[^<]*second/);
    const done = await br.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_tier: 'friend', f_expires_days: '', f_name: 'Omer', f_label: 'Dana' });
    expect(done.status).toBe(200);
    const link = /<pre class="msg">(https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+)<\/pre>/.exec(done.text)?.[1];
    expect(link).toBeTruthy();

    const ev = await waitApi(g.base, a, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval event');
    // Blank days: the form's 7, not an error.
    expect(Date.parse(ev.result.expires) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 120_000);
    expect(JSON.stringify((await api(g.base, b, 'rdv_invite', { action: 'link', approval_id: ev.approval_id })).body)).toMatch(/nothing is held/);
    expect((await api(g.base, a, 'rdv_invite', { action: 'link', approval_id: ev.approval_id })).body.result.url).toBe(link);
    // B's own ask still waits for the owner, on its own page.
    expect((await br.get(urlB)).status).toBe(200);
  });
});
