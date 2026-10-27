// auto_approve: all per contact in the MCP server (SPEC §5.5.1, issues #25,
// #44): a trusted contact's task runs end to end with no prompt and every pass
// in audit.jsonl; so does the confirm of a dinner that contact proposes, never
// one we propose; contacts and grants still need the human; rdv_auto_approve
// turns it off freely and on only with the owner passphrase in its form;
// rdv_status and rdv_task show it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { REQUEST_URI } from '@rendezvous/a2a';
import { fingerprint, MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { contactAutoApprove, ownerSecretSet, type Tty } from '../../cli/src/commands.js';
import { rdv } from '../../cli/scenarios/harness.js';
import { hasOwnerSecret, storeOwnerSecret } from '../../cli/src/ownersecret.js';
import { Output } from '../../cli/src/output.js';
import { INJECTION, makeSide, ok, type Side, TZ, WINDOW, waitEvent, writeCalendars } from './flow.js';

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

const OWNER_PASS = 'JOHN-OWNER-PASS 1234';

/** John's human, at his own terminal: their owner passphrase (set once), the warning, then the passphrase typed (issue #47). */
async function humanTurnsOn(john: Side, peer: string) {
  const tty: Tty = { interactive: true, say: () => {}, ask: async () => fingerprint(peer), secret: async () => OWNER_PASS };
  if (!hasOwnerSecret(john.home)) await ownerSecretSet({ home: john.home, out: new Output(true), values: {}, positionals: [], tty });
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
    // The default grant also lets Omer propose meetings: their confirm is covered too (issue #44).
    expect(c.auto_approve).toMatchObject({ mode: 'all', until: 'until your user turns it off', covers: [MEETINGS_CAPABILITY, REQUEST_URI], auto_approved_actions: 0 });
    expect(st.auto_approve).toMatchObject({ contacts: 1, note: expect.stringContaining('turned on only by your user') });
    expect(st.auto_approve.note).toContain('never ask for the passphrase');
    // The first passphrase is trust on first use (issue #47): rdv_status says when it was set and how to reset it, never the hash.
    expect(st.owner_passphrase).toMatchObject({ set: expect.any(String), note: expect.stringContaining('rdv owner-secret reset') });
    expect(JSON.stringify(st)).not.toMatch(/"hash"|"salt"|JOHN-OWNER-PASS/);
    expect((await ok(omer, 'rdv_status')).owner_passphrase).toMatchObject({ set: null, note: expect.stringContaining('rdv owner-secret set') });

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

  it('never covers contacts or grants: a new contact request and widening the grant still ask the human; a grant change keeps what it still covers (issue #93)', async () => {
    const MORE = 'https://example.com/ext/more/v1';
    const f = forms();
    const { omer, john, omerId, johnId, tag } = await connected(f.handler);
    await humanTurnsOn(john, omerId);
    const asked = f.asked.length;
    const statusOf = async () => (await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve;

    // A grant (widening this contact's own): the human's form, every time.
    const wide = await ok(john, 'rdv_grant', { agent_id: omerId, invoke: [REQUEST_URI, MORE] });
    expect(f.asked.length).toBe(asked + 1);
    // ...and it stays on for what it covered; the new capability is not covered. Told as information, never as a prompt.
    expect(wide.auto_approve).toMatchObject({ state: 'on', covers: [MEETINGS_CAPABILITY, REQUEST_URI], not_covered: [MORE] });
    expect(wide.auto_approve.note).toContain('Never suggest turning auto-approve on');
    expect(wide.next).toContain('confirms without asking');
    expect(await statusOf()).toMatchObject({ covers: [MEETINGS_CAPABILITY, REQUEST_URI], not_covered: [MORE] });
    expect(john.home.readAudit().filter((a) => a.gate === 'auto-approve').at(-1)).toMatchObject({ action: 'keep', by: 'human', via: 'mcp', uncovered: [MORE] });
    expect(john.home.readAudit().some((a) => a.gate === 'auto-approve' && a.action === 'off')).toBe(false);
    const r = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: TASK_TEXT });
    await waitEvent(john, (e) => taskEvent(r.task_id, 'started')(e) && e.auto_approved === true, 'still auto (john)', T);
    expect(f.asked.length).toBe(asked + 1);

    // Narrowed (no meetings): just the request capability; meetings granted back are not covered again.
    const narrow = await ok(john, 'rdv_grant', { agent_id: omerId, may_propose_meetings: false, invoke: [REQUEST_URI] });
    expect(narrow.auto_approve).toMatchObject({ state: 'on', covers: [REQUEST_URI], not_covered: [], no_longer_granted: [MEETINGS_CAPABILITY] });
    const back = await ok(john, 'rdv_grant', { agent_id: omerId, invoke: [REQUEST_URI] });
    expect(back.auto_approve).toMatchObject({ state: 'on', covers: [REQUEST_URI], not_covered: [MEETINGS_CAPABILITY] });
    expect(back.next).toContain('still need your user to confirm');
    // Re-granted on the same terms: still on, the same coverage, nothing new in the audit log.
    const lines = john.home.readAudit().length;
    const same = await ok(john, 'rdv_grant', { agent_id: omerId, invoke: [REQUEST_URI] });
    expect(same.auto_approve).toMatchObject({ state: 'on', covers: [REQUEST_URI], not_covered: [MEETINGS_CAPABILITY] });
    expect(john.home.readAudit().length).toBe(lines);
    // Nothing left it covered: off, with the auto_approve_off event.
    const none = await ok(john, 'rdv_grant', { agent_id: omerId, may_propose_meetings: false, invoke: [MORE] });
    expect(none.auto_approve).toMatchObject({ state: 'off' });
    await waitEvent(john, (e) => e.type === 'auto_approve_off' && e.peer === omerId && e.reason === 'grant-changed', 'auto-approve off (john)', T);
    expect(await statusOf()).toBeNull();
    await ok(john, 'rdv_grant', { agent_id: omerId, invoke: [REQUEST_URI] });
    const r2 = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: TASK_TEXT });
    await waitEvent(john, taskEvent(r2.task_id, 'start-needed'), 'gated (john)', T);

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

  it('only rdv_auto_approve "on" with the passphrase form sets it: no other tool takes it, an extra argument is ignored, no phrase is ever issued', async () => {
    const f = forms();
    const { john, omerId } = await connected(f.handler);
    const tools = (await john.client.listTools()).tools;
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props.filter((p) => /auto.?approve|trust|passphrase|secret|phrase/i.test(p)), t.name).toEqual(t.name === 'rdv_auto_approve' ? [] : props.filter((p) => /^confirm_phrase$/.test(p)));
      if (t.name !== 'rdv_auto_approve') expect(t.description ?? '', t.name).not.toMatch(/auto-approve|auto_approve/i);
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

// --- rdv_auto_approve (issue #44) ----------------------------------------------------------

/** John's human at their own terminal, once: the owner passphrase (issue #47). */
async function setPassphrase(side: Side, pass = OWNER_PASS) {
  const tty: Tty = { interactive: true, say: () => {}, ask: async () => '', secret: async () => pass };
  await ownerSecretSet({ home: side.home, out: new Output(true), values: {}, positionals: [], tty });
}

/** A human answering the auto-approve form with `answer` (and every other form with a plain yes), recording what each form showed. */
function passForms(answer: () => ElicitResult | Promise<ElicitResult>) {
  const asked: Array<ElicitRequest['params']> = [];
  const handler = async (p: ElicitRequest['params']): Promise<ElicitResult> => {
    asked.push(p);
    if (/auto-approve ON/.test(p.message)) return answer();
    return { action: 'accept', content: { approve: true } };
  };
  return { handler, asked, autoForms: () => asked.filter((p) => /auto-approve ON/.test(p.message)) };
}

/** Everything the model or any reader could see: tool results, the inbox events, the shared event log, the audit log. */
function everythingVisible(side: Side): string {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return [side.transcript.join('\n'), read(side.home.eventsPath), read(side.home.auditPath)].join('\n');
}

describe('rdv_auto_approve', () => {
  it('off needs no form; on with the right passphrase in the form turns it on, audited via mcp; the passphrase is in no result, event or log', async () => {
    let answer: () => ElicitResult = () => ({ action: 'accept', content: { approve: true, passphrase: OWNER_PASS } });
    const f = passForms(() => answer());
    const { john, omerId } = await connected(f.handler);

    // No passphrase set yet: refused before any form, pointing to the terminal command that sets one.
    const none = await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('rdv owner-secret set');
    expect(f.autoForms()).toHaveLength(0);
    await setPassphrase(john);

    // Wrong passphrase: refused, counted toward the lockout, nothing set.
    answer = () => ({ action: 'accept', content: { approve: true, passphrase: 'not the passphrase at all' } });
    const wrong = await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/wrong \(2 more tries before a lockout\)/);
    expect(existsSync(john.home.autoApprovePath)).toBe(false);
    // Unticked, or declined: a no, not an error, nothing set.
    answer = () => ({ action: 'accept', content: { approve: false, passphrase: OWNER_PASS } });
    expect((await ok(john, 'rdv_auto_approve', { action: 'on', agent_id: omerId })).approved).toBe(false);
    expect(existsSync(john.home.autoApprovePath)).toBe(false);

    // The right one: on, for exactly what the form showed.
    answer = () => ({ action: 'accept', content: { approve: true, passphrase: OWNER_PASS } });
    const on = await ok(john, 'rdv_auto_approve', { action: 'on', agent_id: omerId, until: '7d', passphrase: 'smuggled in an argument' });
    expect(on).toMatchObject({ auto_approve: 'on', action: 'set', agent_id: omerId, fingerprint: fingerprint(omerId), mode: 'all', covers: [MEETINGS_CAPABILITY, REQUEST_URI] });
    const form = f.autoForms().at(-1)!;
    expect(form.message).toContain(fingerprint(omerId));
    expect(form.message).toContain(omerId);
    expect(form.message).toMatch(/Mode: +all/);
    expect(form.message).toContain(REQUEST_URI);
    expect(form.message).toContain(MEETINGS_CAPABILITY);
    // A duration is shown as such (the form is built again when the answer comes, issue #103); the stored expiry counts from the approval.
    expect(form.message).toContain('7d after you approve');
    expect(Date.parse(on.until) - Date.now()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(form.message).toMatch(/prompt injection/);
    expect(form.requestedSchema.required).toEqual(['approve', 'passphrase']);
    expect(form.requestedSchema.properties.passphrase).toMatchObject({ type: 'string' });
    expect(john.home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'set', by: 'human', via: 'mcp', peer: omerId });
    expect((await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve).toMatchObject({ mode: 'all' });
    // The wrong count was reset by the right answer: three more misses lock it (the existing lockout), and then even the right one is refused.
    answer = () => ({ action: 'accept', content: { approve: true, passphrase: 'wrong wrong wrong' } });
    for (let i = 0; i < 3; i++) expect((await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId })).isError).toBe(true);
    const locked = await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId });
    expect(locked.text).toMatch(/too many wrong owner passphrases/);

    // Off: no form at all, audited via mcp.
    const asked = f.asked.length;
    const off = await ok(john, 'rdv_auto_approve', { action: 'off', agent_id: omerId });
    expect(off.turned_off).toEqual([{ agent_id: omerId, fingerprint: fingerprint(omerId) }]);
    expect(f.asked.length).toBe(asked);
    expect(john.home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'owner', via: 'mcp' });
    expect((await ok(john, 'rdv_auto_approve', { action: 'off', all_contacts: true })).turned_off).toEqual([]);
    await waitEvent(john, (e) => e.type === 'auto_approve_off' && e.peer === omerId && e.reason === 'owner', 'auto_approve_off', T);

    // The passphrase never reached the model or any log a reader sees.
    await ok(john, 'rdv_inbox', { since: 0, limit: 200 });
    for (const text of [everythingVisible(john), john.humanLog.join('\n')]) {
      expect(text).not.toContain(OWNER_PASS);
      expect(text).not.toContain('wrong wrong wrong');
      expect(text).not.toContain('not the passphrase at all');
    }
  });

  it('on is refused, with no confirm phrase, when the form is cancelled, times out, or the client has no forms; and it is bound to what the form showed', async () => {
    let answer: () => ElicitResult | Promise<ElicitResult> = () => ({ action: 'cancel' });
    const f = passForms(() => answer());
    const { john, omerId } = await connected(f.handler);
    await setPassphrase(john);
    const refused = (r: { isError: boolean; text: string }) => {
      expect(r.isError).toBe(true);
      expect(r.text).toContain('there is no confirm phrase');
      expect(r.text).toContain(`rdv contact auto-approve ${omerId} all`);
      expect(existsSync(john.home.autoApprovePath)).toBe(false);
    };
    refused(await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId }));
    // Bound to the object shown: the passphrase record changed while the form was open (same words, new record).
    answer = async () => {
      await storeOwnerSecret(john.home, OWNER_PASS, 'changed');
      return { action: 'accept', content: { approve: true, passphrase: OWNER_PASS } };
    };
    const moved = await john.call('rdv_auto_approve', { action: 'on', agent_id: omerId });
    expect([moved.isError, moved.text]).toEqual([true, expect.stringContaining('changed since your user reviewed it')]);
    expect(existsSync(john.home.autoApprovePath)).toBe(false);
    expect(Object.values(john.home.readConsent()).map((c) => c.action)).not.toContain('auto-approve');
    expect(everythingVisible(john)).not.toContain(OWNER_PASS);

    // A form nobody answers in time: withdrawn, refused, and still no phrase.
    root2 = mkdtempSync(join(tmpdir(), 'rdv-auto-mcp-slow-'));
    const slow = await makeSide('slow', join(root2, 'slow'), { elicit: () => new Promise(() => {}), elicitTimeoutMs: 300 });
    sides.push(slow);
    const slowId = await befriend(slow, john, 'slow');
    await setPassphrase(slow);
    const timedOut = await slow.call('rdv_auto_approve', { action: 'on', agent_id: slowId });
    expect([timedOut.isError, timedOut.text]).toEqual([true, expect.stringContaining('no answer within')]);
    expect(timedOut.text).toContain('there is no confirm phrase');
    expect(existsSync(slow.home.autoApprovePath)).toBe(false);

    // A client with no forms at all: refused at once; a passphrase passed as an argument is not one.
    const bare = await makeSide('bare', join(root2, 'bare'));
    sides.push(bare);
    const bareId = await befriend(bare, john, 'bare');
    await setPassphrase(bare);
    const noForms = await bare.call('rdv_auto_approve', { action: 'on', agent_id: bareId, passphrase: OWNER_PASS, confirm_phrase: OWNER_PASS });
    expect([noForms.isError, noForms.text]).toEqual([true, expect.stringContaining('cannot show an approval form')]);
    expect(existsSync(bare.home.autoApprovePath)).toBe(false);
    // Off still works there: it only narrows.
    expect((await ok(bare, 'rdv_auto_approve', { action: 'off', agent_id: bareId })).auto_approve).toBe('off');
    for (const s of [slow, bare]) expect(everythingVisible(s)).not.toContain(OWNER_PASS);
  });
});

describe('auto-approve and meetings (issue #44)', () => {
  it('confirms a dinner the contact proposes without asking (event, audit), never one we propose', async () => {
    const f = passForms(() => ({ action: 'accept', content: { approve: true, passphrase: OWNER_PASS } }));
    root = mkdtempSync(join(tmpdir(), 'rdv-auto-meet-'));
    const omer = await makeSide('omer', join(root, 'omer'), { elicit: f.handler });
    const john = await makeSide('john', join(root, 'john'), { elicit: f.handler });
    sides.push(omer, john);
    const tag = randomBytes(3).toString('hex');
    const cal = { omer: join(root, 'omer-cal.json'), john: join(root, 'john-cal.json') };
    const want = writeCalendars(cal.omer, cal.john);
    const omerId = (await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url], calendar: cal.omer, window: WINDOW, tz: TZ })).agent_id as string;
    const johnId = (await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true, calendar: cal.john, window: WINDOW, tz: TZ })).agent_id as string;
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
    await ok(omer, 'rdv_request_contact', { target: johnId });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === johnId, 'the contact', T);
    // Omer's human grants John meetings too, so each side can put the other on auto-approve.
    await ok(omer, 'rdv_grant', { agent_id: johnId, may_propose_meetings: true });
    await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === omerId, 'the reverse grant', T);
    for (const [side, peer] of [
      [john, omerId],
      [omer, johnId],
    ] as const) {
      await setPassphrase(side);
      expect((await ok(side, 'rdv_auto_approve', { action: 'on', agent_id: peer })).covers).toContain(MEETINGS_CAPABILITY);
    }

    // Omer proposes. John's side: Omer started it, so auto-approve accepts at once, shown and audited.
    const n = await ok(omer, 'rdv_negotiate', { agent_id: johnId, intent: 'dinner' });
    const taskId = n.task_id as string;
    const dinner = (kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'dinner' && e.task_id === taskId && e.kind === kind;
    const accepted = await waitEvent(john, dinner('accepted'), 'auto accept (john)', T);
    expect(accepted).toMatchObject({ auto_approved: true, summary: expect.stringContaining('auto-approve') });
    // Omer's side: Omer started it, so even with John on auto-approve it waits for Omer.
    const held = await waitEvent(omer, dinner('confirm-needed'), 'confirm-needed (omer)', T);
    expect(held.auto_approved).toBeUndefined();
    expect((await ok(john, 'rdv_inbox', { since: 0, limit: 200 })).events.some(dinner('confirm-needed'))).toBe(false);
    expect(omer.home.readAudit().filter((a) => a.gate === 'meeting')).toEqual([]);
    const forms = f.asked.length;
    await ok(omer, 'rdv_negotiate', { action: 'confirm', task_id: taskId });
    expect(f.asked.length).toBe(forms + 1); // Omer's own form
    await waitEvent(omer, dinner('completed'), 'completed (omer)', T);
    const done = await waitEvent(john, dinner('completed'), 'completed (john)', T);
    expect(done.auto_approved).toBeUndefined(); // Omer's confirm finished it, not auto-approve
    const js = (await ok(john, 'rdv_negotiate', { action: 'status' })).negotiations.find((t: { task_id: string }) => t.task_id === taskId);
    expect(js).toMatchObject({ state: 'completed', agreed: { start: want.start } });
    expect(john.home.readAudit().filter((a) => a.gate === 'meeting')).toEqual([
      expect.objectContaining({ peer: omerId, task: taskId, by: 'auto-approve', capability: MEETINGS_CAPABILITY, meeting: 'accept', digest: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect((await ok(john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === omerId).auto_approve.auto_approved_actions).toBe(1);

    // Off, and the next proposal from Omer waits for John again.
    await ok(john, 'rdv_auto_approve', { action: 'off', agent_id: omerId });
    const n2 = await ok(omer, 'rdv_negotiate', { agent_id: johnId, intent: 'dinner' });
    await waitEvent(john, (e) => e.type === 'dinner' && e.task_id === n2.task_id && e.kind === 'confirm-needed', 'confirm-needed again (john)', T);
  }, 60_000);
});

let root2: string | undefined;
afterEach(() => {
  if (root2) rmSync(root2, { recursive: true, force: true });
  root2 = undefined;
});

/**
 * Make `side` a contact of John's: it asks, John's human approves (a form),
 * and `side`'s own human grants John back in their terminal, so auto-approve
 * on `side` would cover something. Returns John's agent ID.
 */
async function befriend(side: Side, john: Side, name: string): Promise<string> {
  const tag = randomBytes(3).toString('hex');
  const sideId = (await ok(side, 'rdv_init', { profile: name, email: `${name}+${tag}@example.com`, relays: [relay.url] })).agent_id as string;
  const johnId = (await ok(john, 'rdv_status')).agent_id as string;
  await ok(side, 'rdv_request_contact', { target: johnId });
  const req = await waitEvent(john, (e) => e.type === 'contact_request' && e.from === sideId, `${name}'s request`, T);
  await ok(john, 'rdv_grant', { request_id: req.request_id });
  await waitEvent(side, (e) => e.type === 'contact' && e.peer === johnId, `${name}'s contact`, T);
  await rdv(['contact', 'grant', johnId], side.home.dir);
  return johnId;
}
