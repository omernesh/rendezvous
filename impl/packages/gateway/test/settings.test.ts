// The owner's settings through the gateway (issue #102): rdv_label,
// rdv_resync and rdv_file "direct-transfer" ask on the PIN-locked page; the
// assistant's label is only a suggestion there (the field starts at the
// current label). The owner passphrase and replacing the identity are not
// offered at all.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentState, b64decode } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side } from '../../mcp/test/flow.js';
import { api, Browser, callJson, hidden, mcpClient, startGateway, type TestGateway, waitApi } from './helpers.js';

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

/** Answer an approval page as the owner: unlock, read the form, post the decision with the fields given. */
async function decide(g: TestGateway, url: string, fields: Record<string, string> = {}, decision = 'approve') {
  const b = new Browser(g.base);
  const path = new URL(url).pathname;
  await b.unlock(path);
  const page = await b.get(url);
  const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision, ...fields });
  return { page: page.text, done };
}

const directOn = (g: TestGateway) => g.home.readOwner(b64decode(g.home.readAgentState().secretKey)).direct_transfer === true;

describe('owner settings through the gateway', () => {
  it('lists rdv_label and rdv_resync, never the passphrase or a replacement; label is a suggestion on the page; direct transfer on asks there', { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-settings-'));
    const tag = `${process.pid}.${Date.now()}`;
    const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.${tag}@example.com` });
    gws.push(g);
    const token = await g.token(['read', 'send', 'contact:request']);
    const client = await mcpClient(g.base, token);
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const t of ['rdv_label', 'rdv_resync', 'rdv_file']) expect(names).toContain(t);
    for (const t of ['rdv_owner_passphrase', 'rdv_init', 'rdv_backup']) expect(names).not.toContain(t);
    const labelSchema = tools.find((t) => t.name === 'rdv_label')!.inputSchema as { required?: string[] };
    expect(labelSchema.required ?? []).toEqual(['agent_id']);
    // A read-only token sees neither.
    const reader = await mcpClient(g.base, await g.token(['read']));
    expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain('rdv_label');
    await reader.close();

    // John becomes Omer's contact, labeled "John" by Omer on the page.
    const john = await makeSide('john', join(root, 'john'));
    sides.push(john);
    const j = await ok(john, 'rdv_init', { profile: 'john', email: `john.${tag}@doe.com`, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    await ok(john, 'rdv_request_contact', { target: `omer.${tag}@example.com` });
    const req = await waitApi(g.base, token, (e) => e.type === 'contact_request', 'the request');
    const grant = await api(g.base, token, 'rdv_grant', { request_id: req.request_id });
    await decide(g, grant.body.result.approve_url, { f_tier: 'friend', f_label: 'John' });
    const label = () => (g.home.readAgentState() as AgentState).book.contacts[j.agent_id]?.label;
    expect(label()).toBe('John');

    // The assistant suggests "Johnny": nothing changes until the owner types a name on the page.
    const asked = await callJson(client, 'rdv_label', { agent_id: j.agent_id, label: 'Johnny' });
    expect(asked.json).toMatchObject({ status: 'awaiting_human' });
    expect(label()).toBe('John');
    const b = new Browser(g.base);
    const path = new URL(asked.json.approve_url).pathname;
    await b.unlock(path);
    const page = await b.get(asked.json.approve_url);
    expect(page.text).toMatch(/name="f_label" maxlength="\d+" value="John"/);
    expect(page.text).toMatch(/suggests the label &quot;Johnny&quot;/);
    const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_label: 'Jonathan' });
    expect(done.status).toBe(200);
    expect(label()).toBe('Jonathan');

    // Direct transfers: on asks on the page, a no there leaves it off; off needs no one.
    const on = await callJson(client, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'on' });
    expect(on.json).toMatchObject({ status: 'awaiting_human' });
    await decide(g, on.json.approve_url, {}, 'decline');
    expect(directOn(g)).toBe(false);
    const on2 = await callJson(client, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'on' });
    const { page: shown } = await decide(g, on2.json.approve_url);
    expect(shown).toMatch(/network address/);
    expect(directOn(g)).toBe(true);
    expect((await callJson(client, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'off' })).json).toMatchObject({ direct_transfer: 'off', changed: true });
    expect(directOn(g)).toBe(false);

    // Nothing to resync: refused before any page.
    const rs = await callJson(client, 'rdv_resync', { agent_id: j.agent_id });
    expect([rs.isError, rs.text]).toEqual([true, expect.stringContaining('not refusing')]);
    await client.close();
  });
});
