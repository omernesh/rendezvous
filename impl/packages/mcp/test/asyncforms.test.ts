// Approval forms that never block the tool call, and "Don't ask again" on them
// (issue #103, NOTES 96). Claude Code shows an elicitation form only after
// the model's turn ends, so the server sends the form, returns
// `awaiting_human` at once (formWaitMs 0, the real default), and completes the
// step when the human answers, bound to the form's digest; an `approval` event
// says what they decided. The task start, task release and contact-started
// dinner forms carry a "Don't ask again for this contact" box that only the
// human can tick: it turns auto-approve on for that capability, with no
// passphrase, and is never offered with a confirm phrase.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { REQUEST_URI } from '@rendezvous/a2a';
import { MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ALWAYS_ALLOW_FIELD, TICK_NOTE } from '../src/index.js';
import { type ElicitHandler, makeSide, ok, phraseFromHumanLog, type Side, TZ, WINDOW, waitEvent, writeCalendars } from './flow.js';

const T = 15_000;
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

interface OpenForm {
  message: string;
  schema: { properties: Record<string, Record<string, unknown>>; required?: string[] };
  answer: (r: ElicitResult) => void;
}

/** A human who answers each form when the test says so, like Claude Code showing it after the turn. */
function human() {
  const open: OpenForm[] = [];
  const handler: ElicitHandler = (params: ElicitRequest['params']) =>
    new Promise<ElicitResult>((resolve) => {
      open.push({ message: String(params.message), schema: (params as { requestedSchema: OpenForm['schema'] }).requestedSchema, answer: resolve });
    });
  /** The next form whose message matches, once it is shown. */
  const next = async (match = ''): Promise<OpenForm> => {
    const deadline = Date.now() + T;
    for (;;) {
      const i = open.findIndex((f) => f.message.includes(match));
      if (i >= 0) return open.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no form matching ${JSON.stringify(match)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { handler, open, next };
}

const approval = (id: string, outcome?: string) => (e: { type: string; approval_id?: string; outcome?: string }) =>
  e.type === 'approval' && e.approval_id === id && (outcome === undefined || e.outcome === outcome);
const taskEvent = (id: string, kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'task' && e.task_id === id && e.kind === kind;

/**
 * Omer (no forms) and John (a client with forms that it shows after the turn:
 * formWaitMs 0). John's grant to Omer, with request/v1, goes through John's
 * first async form: the step completes when he answers.
 */
async function connected(opts: { johnForms?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), 'rdv-async-'));
  const h = human();
  const omer = await makeSide('omer', join(root, 'omer'));
  const john = await makeSide('john', join(root, 'john'), { elicit: h.handler, formWaitMs: 0, forms: opts.johnForms });
  sides.push(omer, john);
  const tag = randomBytes(3).toString('hex');
  const o = await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
  const j = await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true });
  await ok(john, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
  await ok(omer, 'rdv_request_contact', { target: j.agent_id });
  const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
  return { h, omer, john, omerId: o.agent_id as string, johnId: j.agent_id as string, requestId: req.request_id as string };
}

/** John grants Omer request/v1 through his (async) form, and Omer sees the grant. */
async function grantThroughForm(c: Awaited<ReturnType<typeof connected>>) {
  const r = await ok(c.john, 'rdv_grant', { request_id: c.requestId, invoke: [REQUEST_URI] });
  expect(r.status).toBe('awaiting_human');
  ;(await c.h.next('')).answer({ action: 'accept', content: { approve: true, allow_invoke: true } });
  await waitEvent(c.john, approval(r.approval_id, 'decided'), 'the grant decided', T);
  await waitEvent(c.omer, (e) => e.type === 'contact' && e.peer === c.johnId, 'the grant (omer)', T);
}

/** Omer asks John's agent for a task; John's agent holds it at the start gate. */
async function taskWaiting(c: Awaited<ReturnType<typeof connected>>, text: string): Promise<string> {
  const r = await ok(c.omer, 'rdv_task', { action: 'request', agent_id: c.johnId, text });
  await waitEvent(c.john, taskEvent(r.task_id, 'start-needed'), 'the start gate', T);
  return r.task_id as string;
}

describe('approval forms that do not block the tool call (issue #103)', () => {
  it('returns awaiting_human at once, completes the step when the human answers, and reuses the open form for the same ask', async () => {
    const c = await connected();
    const t0 = Date.now();
    const r = await ok(c.john, 'rdv_grant', { request_id: c.requestId, invoke: [REQUEST_URI] });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r).toMatchObject({ status: 'awaiting_human', via: 'approval form', approval_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(r.note).toContain('end your turn');
    expect((await ok(c.john, 'rdv_status')).contacts).toEqual([]); // nothing done yet

    // The same ask again: the open form, not a second one.
    const again = await ok(c.john, 'rdv_grant', { request_id: c.requestId, invoke: [REQUEST_URI] });
    expect(again.approval_id).toBe(r.approval_id);
    const form = await c.h.next('');
    expect(form.message).toContain(TICK_NOTE);
    await new Promise((res) => setTimeout(res, 100));
    expect(c.h.open).toHaveLength(0);
    expect(c.john.humanLog.some((l) => l.includes('an approval form is waiting for you'))).toBe(true);

    form.answer({ action: 'accept', content: { approve: true, allow_invoke: true } });
    const done = await waitEvent(c.john, approval(r.approval_id), 'the approval event', T);
    expect(done).toMatchObject({ outcome: 'decided', tool: 'rdv_grant', result: { granted: true } });
    await waitEvent(c.omer, (e) => e.type === 'contact' && e.peer === c.johnId, 'the grant (omer)', T);
    expect((await ok(c.john, 'rdv_status')).approval).toContain('approval form (elicitation)');
  }, 60_000);

  it('several forms at once, answered out of order: a yes starts its task, a no refuses its own, a dismissal and a stale answer do nothing', async () => {
    const c = await connected();
    await grantThroughForm(c);
    const a = await taskWaiting(c, 'Task A');
    const b = await taskWaiting(c, 'Task B');
    const d = await taskWaiting(c, 'Task D');
    const ra = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: a });
    const rb = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: b });
    const rd = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: d });
    expect(new Set([ra.approval_id, rb.approval_id, rd.approval_id]).size).toBe(3);
    const fa = await c.h.next('Task A');
    const fb = await c.h.next('Task B');
    const fd = await c.h.next('Task D');

    // D first: a no refuses it (the "no" runs, bound to what John saw).
    fd.answer({ action: 'decline' });
    const nd = await waitEvent(c.john, approval(rd.approval_id), 'D declined', T);
    expect(nd).toMatchObject({ outcome: 'decided', result: { state: 'rejected', answer: 'declined' } });
    await waitEvent(c.omer, taskEvent(d, 'rejected'), 'D rejected (omer)', T);

    // B: yes.
    fb.answer({ action: 'accept', content: { approve: true } });
    const yb = await waitEvent(c.john, approval(rb.approval_id), 'B started', T);
    expect(yb).toMatchObject({ outcome: 'decided', result: { state: 'working' } });
    expect(yb.result.next).toMatch(/^Approved/);

    // A: dismissed. Nothing happens; it still waits.
    fa.answer({ action: 'cancel' });
    const xa = await waitEvent(c.john, approval(ra.approval_id), 'A dismissed', T);
    expect(xa.outcome).toBe('dismissed');
    expect((await ok(c.john, 'rdv_task', { action: 'status', task_id: a })).state).toBe('submitted');

    // A again, then Omer cancels A before John answers: the answer is stale and starts nothing.
    const ra2 = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: a });
    expect(ra2.approval_id).not.toBe(ra.approval_id);
    const fa2 = await c.h.next('Task A');
    await ok(c.omer, 'rdv_task', { action: 'cancel', task_id: a });
    await waitEvent(c.john, taskEvent(a, 'canceled'), 'A canceled (john)', T);
    fa2.answer({ action: 'accept', content: { approve: true } });
    const sa = await waitEvent(c.john, approval(ra2.approval_id), 'A stale', T);
    expect(['failed', 'changed']).toContain(sa.outcome);
    expect((await ok(c.john, 'rdv_task', { action: 'status', task_id: a })).state).toBe('canceled');
    expect(c.john.home.readAudit().filter((x) => x.task === a && x.gate === 'start')).toEqual([]);
  }, 90_000);

  it('a stale answer to a form whose item changed does nothing (changed); a form left open expires', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-async-'));
    const h = human();
    const omer = await makeSide('omer', join(root, 'omer'), { elicit: h.handler, formWaitMs: 0 });
    sides.push(omer);
    await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer.stale@example.com', relays: [relay.url] });
    const two = await startTestRelay();
    const three = await startTestRelay();
    try {
      const r2 = await ok(omer, 'rdv_relays', { action: 'add', url: two.url });
      const r3 = await ok(omer, 'rdv_relays', { action: 'add', url: three.url });
      const f2 = await h.next(two.url);
      const f3 = await h.next(three.url);
      f3.answer({ action: 'accept', content: { approve: true } });
      await waitEvent(omer, approval(r3.approval_id, 'decided'), 'three added', T);
      // The form for two showed the relays before three was added: built again now it differs, so the yes does nothing.
      f2.answer({ action: 'accept', content: { approve: true } });
      const stale = await waitEvent(omer, approval(r2.approval_id), 'two stale', T);
      expect(stale.outcome).toBe('changed');
      expect(stale.note).toContain('did nothing');
      expect((await ok(omer, 'rdv_relays', { action: 'list' })).relays).toEqual([relay.url, three.url]);
    } finally {
      await two.close();
      await three.close();
    }

    // A form nobody answers is withdrawn after RDV_ELICIT_TIMEOUT_MS: an "expired" event, nothing approved.
    const late = human();
    const john = await makeSide('john', join(root, 'john'), { elicit: late.handler, formWaitMs: 0, elicitTimeoutMs: 300 });
    sides.push(john);
    await ok(john, 'rdv_init', { profile: 'john', email: 'john.stale@doe.com', relays: [relay.url] });
    const four = await startTestRelay();
    try {
      const r4 = await ok(john, 'rdv_relays', { action: 'add', url: four.url });
      const expired = await waitEvent(john, approval(r4.approval_id), 'expired', T);
      expect(expired.outcome).toBe('expired');
      ;(await late.next(four.url)).answer({ action: 'accept', content: { approve: true } }); // too late: ignored
      await new Promise((res) => setTimeout(res, 200));
      expect((await ok(john, 'rdv_relays', { action: 'list' })).relays).toEqual([relay.url]);
    } finally {
      await four.close();
    }
  }, 60_000);
});

describe('"Don\'t ask again for this contact" (issue #103)', () => {
  it('ticked on the start form: the task starts, its result and the next task go without asking, audited via form; off brings the gate back', async () => {
    const c = await connected();
    await grantThroughForm(c);
    const id = await taskWaiting(c, 'Please draft the copy.');
    const r = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: id });
    const form = await c.h.next('let your agent do this task?');
    const box = form.schema.properties[ALWAYS_ALLOW_FIELD];
    expect(box).toMatchObject({ type: 'boolean', default: false, title: "Don't ask again for this contact" });
    expect((box.title as string).length).toBeLessThanOrEqual(40);
    expect(box.description).toContain(REQUEST_URI);
    expect(box.description).toContain('until you turn it off');
    expect(box.description).toContain('Risk:');
    expect(form.schema.required ?? []).not.toContain(ALWAYS_ALLOW_FIELD);

    form.answer({ action: 'accept', content: { approve: true, [ALWAYS_ALLOW_FIELD]: true } });
    const done = await waitEvent(c.john, approval(r.approval_id), 'started', T);
    expect(done.result).toMatchObject({ state: 'working', auto_approve: { state: 'on', covers: [REQUEST_URI], until: 'until your user turns it off' } });
    expect(done.result.auto_approve.how_to_turn_off).toContain('rdv_auto_approve');
    const on = await waitEvent(c.john, (e) => e.type === 'auto_approve_on' && e.agent_id === c.omerId, 'auto_approve_on', T);
    expect(on.covers).toEqual([REQUEST_URI]);
    const set = c.john.home.readAudit().filter((x) => x.gate === 'auto-approve');
    expect(set).toEqual([expect.objectContaining({ peer: c.omerId, by: 'human', action: 'set', via: 'form', capabilities: [REQUEST_URI], until: null })]);
    const status = (await ok(c.john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === c.omerId);
    expect(status.auto_approve).toMatchObject({ covers: [REQUEST_URI] });

    // Its result leaves without asking, and the next task starts without asking: no form.
    const sent = await ok(c.john, 'rdv_task', { action: 'submit', task_id: id, text: 'Here it is.' });
    expect(sent).toMatchObject({ sent: true, auto_approved: true });
    const next = await ok(c.omer, 'rdv_task', { action: 'request', agent_id: c.johnId, text: 'And another.' });
    await waitEvent(c.john, (e) => taskEvent(next.task_id, 'started')(e) && e.auto_approved === true, 'auto start', T);
    await new Promise((res) => setTimeout(res, 100));
    expect(c.h.open).toHaveLength(0);

    // Off (the user asks the model): reduce-only, the gate is back, and the box is offered again.
    await ok(c.john, 'rdv_auto_approve', { action: 'off', agent_id: c.omerId });
    const third = await taskWaiting(c, 'A third.');
    await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: third });
    const again = await c.h.next('A third.');
    expect(again.schema.properties[ALWAYS_ALLOW_FIELD]).toBeDefined();
    again.answer({ action: 'accept', content: { approve: true } }); // not ticked: approves this task only
    await waitEvent(c.john, taskEvent(third, 'started'), 'third started', T);
    expect((await ok(c.john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === c.omerId).auto_approve).toBeNull();
  }, 90_000);

  it('ticked on the release form: the result goes out, and later results leave without asking', async () => {
    const c = await connected();
    await grantThroughForm(c);
    const id = await taskWaiting(c, 'Draft please.');
    const r = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: id });
    ;(await c.h.next('Draft please.')).answer({ action: 'accept', content: { approve: true } });
    await waitEvent(c.john, approval(r.approval_id, 'decided'), 'started', T);
    const held = await ok(c.john, 'rdv_task', { action: 'submit', task_id: id, text: 'The draft.' });
    expect(held.sent).not.toBe(true);
    const rr = await ok(c.john, 'rdv_task', { action: 'approve-release', task_id: id });
    const form = await c.h.next('send this to the other agent?');
    expect(form.schema.properties[ALWAYS_ALLOW_FIELD]).toMatchObject({ type: 'boolean', default: false });
    form.answer({ action: 'accept', content: { approve: true, [ALWAYS_ALLOW_FIELD]: true } });
    const done = await waitEvent(c.john, approval(rr.approval_id), 'released', T);
    expect(done.result.auto_approve).toMatchObject({ state: 'on', covers: [REQUEST_URI] });
    await waitEvent(c.omer, taskEvent(id, 'completed'), 'completed (omer)', T);
    const next = await ok(c.omer, 'rdv_task', { action: 'request', agent_id: c.johnId, text: 'Next one.' });
    await waitEvent(c.john, (e) => taskEvent(next.task_id, 'started')(e) && e.auto_approved === true, 'auto start', T);
  }, 90_000);

  it('the model cannot set it: no tool takes it, an argument is dropped, and an unticked box or a decline turns nothing on', async () => {
    const c = await connected();
    await grantThroughForm(c);
    const tools = await c.john.client.listTools();
    expect(JSON.stringify(tools.tools.map((t) => t.inputSchema))).not.toContain(ALWAYS_ALLOW_FIELD);
    const id = await taskWaiting(c, 'Do it.');
    // The model passes the box as an argument: the schema drops it, and the form still starts unticked.
    const r = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: id, [ALWAYS_ALLOW_FIELD]: true });
    const form = await c.h.next('Do it.');
    expect(form.schema.properties[ALWAYS_ALLOW_FIELD].default).toBe(false);
    // Ticked but declined: a no, and nothing is turned on.
    form.answer({ action: 'decline', content: { [ALWAYS_ALLOW_FIELD]: true } } as ElicitResult);
    await waitEvent(c.john, approval(r.approval_id), 'declined', T);
    // Ticked with approve unticked: nothing at all.
    const id2 = await taskWaiting(c, 'Do it again.');
    const r2 = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: id2 });
    ;(await c.h.next('Do it again.')).answer({ action: 'accept', content: { approve: false, [ALWAYS_ALLOW_FIELD]: true } });
    const unticked = await waitEvent(c.john, approval(r2.approval_id), 'left unticked', T);
    expect(unticked).toMatchObject({ outcome: 'declined', result: { answer: 'left unticked' } });
    expect(c.john.home.readAudit().filter((x) => x.gate === 'auto-approve')).toEqual([]);
    expect((await ok(c.john, 'rdv_status')).contacts.find((x: { agent_id: string }) => x.agent_id === c.omerId).auto_approve).toBeNull();
  }, 90_000);

  it('on the confirm form of a dinner the contact proposed (never one we proposed): the next dinner it proposes is accepted without asking', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-async-meet-'));
    const asked: Array<{ message: string; fields: string[] }> = [];
    const handler: ElicitHandler = (p) => {
      const props = (p as { requestedSchema: OpenForm['schema'] }).requestedSchema.properties;
      asked.push({ message: String(p.message), fields: Object.keys(props) });
      const tick = String(p.message).includes('confirm this dinner') && Object.hasOwn(props, ALWAYS_ALLOW_FIELD);
      return { action: 'accept', content: { approve: true, ...(tick ? { [ALWAYS_ALLOW_FIELD]: true } : {}) } };
    };
    const omer = await makeSide('omer', join(root, 'omer'), { elicit: handler });
    const john = await makeSide('john', join(root, 'john'), { elicit: handler });
    sides.push(omer, john);
    const tag = randomBytes(3).toString('hex');
    const cal = { omer: join(root, 'omer-cal.json'), john: join(root, 'john-cal.json') };
    writeCalendars(cal.omer, cal.john);
    const omerId = (await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url], calendar: cal.omer, window: WINDOW, tz: TZ })).agent_id as string;
    const johnId = (await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true, calendar: cal.john, window: WINDOW, tz: TZ })).agent_id as string;
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
    await ok(omer, 'rdv_request_contact', { target: johnId });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === johnId, 'the contact', T);

    // Omer proposes; John's agent holds it for John (no auto-approve yet).
    const n = await ok(omer, 'rdv_negotiate', { agent_id: johnId, intent: 'dinner' });
    const dinner = (id: string, kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'dinner' && e.task_id === id && e.kind === kind;
    await waitEvent(john, dinner(n.task_id, 'confirm-needed'), 'confirm-needed (john)', T);
    const confirmed = await ok(john, 'rdv_negotiate', { action: 'confirm', task_id: n.task_id });
    const johnForm = asked.filter((a) => a.message.includes('confirm this dinner')).at(-1)!;
    expect(johnForm.fields).toContain(ALWAYS_ALLOW_FIELD);
    expect(confirmed.auto_approve).toMatchObject({ state: 'on', covers: [MEETINGS_CAPABILITY] });
    expect(john.home.readAudit().find((a) => a.gate === 'auto-approve')).toMatchObject({ peer: omerId, via: 'form', capabilities: [MEETINGS_CAPABILITY] });

    // Omer started it: his own confirm form never offers the box.
    await waitEvent(omer, dinner(n.task_id, 'confirm-needed'), 'confirm-needed (omer)', T);
    await ok(omer, 'rdv_negotiate', { action: 'confirm', task_id: n.task_id });
    const omerForm = asked.filter((a) => a.message.includes('confirm this dinner')).at(-1)!;
    expect(omerForm.fields).not.toContain(ALWAYS_ALLOW_FIELD);
    await waitEvent(john, dinner(n.task_id, 'completed'), 'completed (john)', T);

    // The next dinner Omer proposes is accepted for John without asking.
    const n2 = await ok(omer, 'rdv_negotiate', { agent_id: johnId, intent: 'dinner' });
    const accepted = await waitEvent(john, dinner(n2.task_id, 'accepted'), 'auto accept (john)', T);
    expect(accepted.auto_approved).toBe(true);
  }, 90_000);

  it('never with a confirm phrase: without forms the phrase approves the task only, whatever the model passes', async () => {
    const c = await connected({ johnForms: false });
    const g = await c.john.call('rdv_grant', { request_id: c.requestId, invoke: [REQUEST_URI] });
    expect(g.isError).toBe(true);
    await ok(c.john, 'rdv_grant', { request_id: c.requestId, invoke: [REQUEST_URI], confirm_phrase: phraseFromHumanLog(c.john, c.requestId) });
    await waitEvent(c.omer, (e) => e.type === 'contact' && e.peer === c.johnId, 'the grant (omer)', T);
    const id = await taskWaiting(c, 'Phrase task.');
    const asked = await c.john.call('rdv_task', { action: 'approve-start', task_id: id });
    expect(asked.isError).toBe(true);
    expect(c.john.humanLog.join('\n')).not.toContain("Don't ask again");
    const done = await ok(c.john, 'rdv_task', { action: 'approve-start', task_id: id, confirm_phrase: phraseFromHumanLog(c.john, id), [ALWAYS_ALLOW_FIELD]: true });
    expect(done.state).toBe('working');
    expect(done.auto_approve).toBeUndefined();
    expect(c.john.home.readAudit().filter((x) => x.gate === 'auto-approve')).toEqual([]);
    expect(c.h.open).toHaveLength(0);
  }, 90_000);
});
