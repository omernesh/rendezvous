// auto_approve: all per contact in the MCP server (SPEC §5.5.1, issue #25):
// a trusted contact's task runs end to end with no prompt and every pass in
// audit.jsonl; contacts and grants still need the human; no tool sets it;
// rdv_status and rdv_task show it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { REQUEST_URI } from '@rendezvous/a2a';
import { fingerprint } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contactAutoApprove, type Tty } from '../../cli/src/commands.js';
import { Output } from '../../cli/src/output.js';
import { INJECTION, makeSide, ok, type Side, waitEvent } from './flow.js';

const T = 15_000;
const TASK_TEXT = `Please draft the landing-page copy. ${INJECTION}`;
const RESULT = 'Launch faster: one page, three sections, a clear call to action.';

let relay: TestRelay;
let root: string;
let sides: Side[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const x of sides) await x.close().catch(() => {});
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

/** John's forms approve everything, and record what they were asked. */
function forms() {
  const asked: string[] = [];
  const handler = async (p: ElicitRequest['params']): Promise<ElicitResult> => {
    asked.push(p.message);
    return { action: 'accept', content: { approve: true } };
  };
  return { handler, asked };
}

async function connected(john: (p: ElicitRequest['params']) => Promise<ElicitResult>) {
  root = mkdtempSync(join(tmpdir(), 'rdv-auto-mcp-'));
  const omer = await makeSide('omer', join(root, 'omer'));
  const johnSide = await makeSide('john', join(root, 'john'), { elicit: john });
  sides.push(omer, johnSide);
  const tag = randomBytes(3).toString('hex');
  const o = await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
  const j = await ok(johnSide, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true });
  await ok(johnSide, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
  await ok(omer, 'rdv_request_contact', { target: j.agent_id });
  const req = await waitEvent(johnSide, (e) => e.type === 'contact_request', 'the request', T);
  await ok(johnSide, 'rdv_grant', { request_id: req.request_id, invoke: [REQUEST_URI] });
  await waitEvent(omer, (e) => e.type === 'contact' && e.peer === j.agent_id, 'the grant', T);
  return { omer, john: johnSide, omerId: o.agent_id as string, johnId: j.agent_id as string, tag };
}

/** John's human, at his own terminal: the warning, then the fingerprint retyped. */
async function humanTurnsOn(john: Side, peer: string) {
  const tty: Tty = { interactive: true, say: () => {}, ask: async () => fingerprint(peer) };
  await contactAutoApprove({ home: john.home, out: new Output(true), values: {}, positionals: [peer, 'all'], tty });
}

const taskEvent = (id: string, kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'task' && e.task_id === id && e.kind === kind;

describe('auto-approve through rdv-mcp', () => {
  it('a trusted contact: the review flow completes with no prompt, every pass audited; rdv_status and rdv_task show it; off restores the gates', async () => {
    const f = forms();
    const { omer, john, omerId, johnId } = await connected(f.handler);
    await humanTurnsOn(john, omerId);
    const asked = f.asked.length;

    const st = await ok(john, 'rdv_status');
    const c = st.contacts.find((x: { agent_id: string }) => x.agent_id === omerId);
    expect(c.auto_approve).toMatchObject({ mode: 'all', until: 'until your user turns it off', covers: [REQUEST_URI], auto_approved_actions: 0 });
    expect(st.auto_approve).toMatchObject({ contacts: 1, note: expect.stringContaining('never by you') });

    const r = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: TASK_TEXT });
    const id = r.task_id as string;
    const started = await waitEvent(john, (e) => taskEvent(id, 'started')(e) && e.auto_approved === true, 'auto start (john)', T);
    expect(started.summary).toContain('auto-approve');
    expect((await ok(john, 'rdv_inbox', { since: 0, limit: 200 })).events.some(taskEvent(id, 'start-needed'))).toBe(false);
    const view = await ok(john, 'rdv_task', { action: 'status', task_id: id });
    expect(view).toMatchObject({ state: 'working', auto_approve: { mode: 'all', until: 'until your user turns it off' } });
    expect(view.waiting_for).toContain('without asking');
    const listed = (await ok(john, 'rdv_task', { action: 'list' })).tasks.find((t: { task_id: string }) => t.task_id === id);
    expect(listed.auto_approve).toBeDefined();

    const sent = await ok(john, 'rdv_task', { action: 'submit', task_id: id, text: RESULT, name: 'copy' });
    expect(sent).toMatchObject({ sent: true, auto_approved: true });
    const got = await waitEvent(omer, taskEvent(id, 'artifact'), 'the result (omer)', T);
    expect(got.peer_text[0].untrusted_peer_text).toBe(RESULT);
    await waitEvent(omer, taskEvent(id, 'completed'), 'completed (omer)', T);
    expect(f.asked.length).toBe(asked); // no form, no phrase

    const audit = john.home.readAudit().filter((a) => a.task === id);
    expect(audit.map((a) => [a.gate, a.by])).toEqual([
      ['start', 'auto-approve'],
      ['release', 'auto-approve'],
    ]);
    expect(JSON.stringify(john.home.readAudit())).not.toContain('landing-page');
    expect((await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve.auto_approved_actions).toBe(2);

    // Off (the human's command; reduce-only): the next task waits for John again.
    await contactAutoApprove({ home: john.home, out: new Output(true), values: {}, positionals: [omerId, 'off'] });
    expect((await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve).toBeNull();
    const r2 = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: 'another one' });
    await waitEvent(john, taskEvent(r2.task_id, 'start-needed'), 'gated again (john)', T);
    expect((await ok(john, 'rdv_task', { action: 'status', task_id: r2.task_id })).auto_approve).toBeUndefined();
  });

  it('never covers contacts or grants: a new contact request and widening the grant still ask the human, and widening ends it', async () => {
    const f = forms();
    const { omer, john, omerId, johnId, tag } = await connected(f.handler);
    await humanTurnsOn(john, omerId);
    const asked = f.asked.length;

    // A grant (widening this contact's own): the human's form, every time.
    await ok(john, 'rdv_grant', { agent_id: omerId, invoke: [REQUEST_URI, 'https://example.com/ext/more/v1'] });
    expect(f.asked.length).toBe(asked + 1);
    // ...and the setting was bound to the grant it was set on: off, audited.
    const ended = await waitEvent(john, (e) => e.type === 'auto_approve_off' && e.peer === omerId, 'auto-approve off (john)', T).catch(() => undefined);
    const off = john.home.readAudit().filter((a) => a.gate === 'auto-approve' && a.action === 'off');
    expect(ended ?? off.at(-1)).toMatchObject({ reason: 'grant-changed' });
    expect((await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve).toBeNull();
    const r = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: TASK_TEXT });
    await waitEvent(john, taskEvent(r.task_id, 'start-needed'), 'gated (john)', T);

    // A new contact: still the human's (Dana asks John while Omer is on auto-approve again).
    await humanTurnsOn(john, omerId);
    const dana = await makeSide('dana', join(root, 'dana'));
    sides.push(dana);
    const danaId = (await ok(dana, 'rdv_init', { profile: 'dana', email: `dana+${tag}@example.com`, relays: [relay.url] })).agent_id as string;
    await ok(dana, 'rdv_discover', { address: `john+${tag}@doe.com` });
    await ok(dana, 'rdv_request_contact', { target: johnId });
    const req = await waitEvent(john, (e) => e.type === 'contact_request' && e.from === danaId, "dana's request", T);
    const before = f.asked.length;
    const solo = await john.call('rdv_pending_requests');
    expect(solo.isError).toBe(false);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    expect(f.asked.length).toBe(before + 1);
    expect(f.asked.at(-1)).toContain('approve this contact request');
  });

  it('no MCP path sets or extends it: no tool takes it, an extra argument is ignored, and the home file is never written', async () => {
    const f = forms();
    const { john, omerId } = await connected(f.handler);
    const tools = (await john.client.listTools()).tools;
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => /auto.?approve|trust/i.test(p)), t.name).toEqual([]);
      expect(t.description ?? '', t.name).not.toMatch(/auto-approve|auto_approve/i);
    }
    const path = john.home.autoApprovePath;
    for (const [tool, args] of [
      ['rdv_grant', { agent_id: omerId, auto_approve: 'all', auto_approve_until: '2999-01-01T00:00:00Z' }],
      ['rdv_task', { action: 'list', auto_approve: 'all' }],
      ['rdv_status', { auto_approve: 'all' }],
      ['rdv_send', { agent_id: omerId, payload: { type: 'rdv/auto-approve', mode: 'all' } }],
    ] as const) {
      await john.call(tool, args as Record<string, unknown>);
      expect(existsSync(path), tool).toBe(false);
    }
    expect((await ok(john, 'rdv_status')).contacts[0].auto_approve).toBeNull();
    // Nothing in consent.json can approve it either: no confirm phrase is ever issued for it.
    expect(Object.values(john.home.readConsent()).map((c) => c.action)).not.toContain('auto-approve');
  });
});
