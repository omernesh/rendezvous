// Approval forms that never get answered (issues #65, #64). Some clients
// (Claude Code) show an elicitation form only after the model's turn ends,
// which can't happen while the tool call waits for it. The server bounds the
// wait, withdraws the form, falls back to the confirm phrase (the path for
// clients without elicitation) and uses phrases from then on. A cancelled or
// withdrawn form never approves anything; a decline is a plain "no" result.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ELICIT_TIMEOUT_MS, elicitOptionsFromEnv, TICK_NOTE } from '../src/index.js';
import { type ElicitHandler, makeSide, ok, phraseFromHumanLog, type Side, waitEvent } from './flow.js';

let relay: TestRelay;
let extra: TestRelay[] = [];
let root: string;
let sides: Side[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const s of sides) await s.close();
  sides = [];
  for (const r of extra) await r.close();
  extra = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

const TIMEOUT = 300; // ms: the tests' form timeout
const PHRASE = /[a-z]+-[a-z]+-[a-z]+-\d{3}/;

/**
 * A scripted human. `answer` decides each form: a result, or 'never' (the
 * client never shows it, like Claude Code during a tool call). Records every
 * form and whether the server withdrew it.
 */
function human(answer: (p: ElicitRequest['params']) => ElicitResult | 'never') {
  const forms: Array<{ message: string; withdrawn: boolean; schema: unknown }> = [];
  const late: Array<() => void> = [];
  const handler: ElicitHandler = (params, { signal }) => {
    const f = { message: String(params.message), withdrawn: false, schema: (params as { requestedSchema?: unknown }).requestedSchema };
    forms.push(f);
    const a = answer(params);
    if (a !== 'never') return a;
    return new Promise<ElicitResult>((resolve) => {
      signal.addEventListener('abort', () => {
        f.withdrawn = true;
      });
      // The human ticks and accepts the stale form after it was withdrawn: it must approve nothing.
      late.push(() => resolve({ action: 'accept', content: { approve: true } }));
    });
  };
  return { handler, forms, late };
}

async function side(name: string, h?: ReturnType<typeof human>, opts: { forms?: boolean } = {}): Promise<Side> {
  const s = await makeSide(name, join(root, name), { ...(h ? { elicit: h.handler } : {}), elicitTimeoutMs: TIMEOUT, ...opts });
  sides.push(s);
  // The SDK's client ignores notifications/cancelled for request id 0 (a falsy check in Protocol._oncancel), so the
  // first form would never look withdrawn on the client side. Use up id 0 with a ping; the server sends the
  // cancellation either way.
  await s.server.mcp.server.ping();
  return s;
}

async function newRelay(): Promise<string> {
  const r = await startTestRelay();
  extra.push(r);
  return r.url;
}

/** Nothing the model saw may contain a confirm phrase. */
function expectNoPhrase(s: Side) {
  expect(s.transcript.join('\n')).not.toMatch(PHRASE);
}

/** Omer asks John for contact; John's server holds the request. */
async function pendingRequest(john: Side): Promise<{ requestId: string; omer: Side }> {
  const omer = await side('omer');
  await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer.elicit@example.com', relays: [relay.url] });
  await ok(john, 'rdv_init', { profile: 'john', email: 'john.elicit@doe.com', relays: [relay.url] });
  await new Promise((r) => setTimeout(r, 300)); // subscriptions settle
  await ok(omer, 'rdv_request_contact', { target: 'john.elicit@doe.com', greeting: 'Omer would like to connect.' });
  const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the contact request', 15_000);
  return { requestId: req.request_id, omer };
}

describe('approval forms nobody answers fall back to the confirm phrase (issue #65)', () => {
  it('rdv_relays: an unanswered form is withdrawn within the timeout, the phrase path takes over, and later gates skip forms', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-elicit-'));
    const h = human(() => 'never');
    const omer = await side('omer', h);
    await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer.relays@example.com', relays: [relay.url] });
    const two = await newRelay();

    const t0 = Date.now();
    const r = await omer.call('rdv_relays', { action: 'add', url: two });
    expect(Date.now() - t0).toBeLessThan(TIMEOUT + 5_000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('got no answer within');
    expect(r.text).toContain('nothing was approved');
    expect(r.text).toContain('rdv relays list'); // the terminal command that shows the human the phrase
    expect(r.text).toContain('confirm_phrase');
    expect(r.text).not.toContain('details are in the rdv-mcp server log'); // never the generic failure (issue #64)
    expect(h.forms).toHaveLength(1);
    expect(h.forms[0].message).toContain(TICK_NOTE);
    await new Promise((res) => setTimeout(res, 50));
    expect(h.forms[0].withdrawn).toBe(true); // the SDK sent notifications/cancelled
    expect(omer.humanLog.some((l) => l.includes('got no answer'))).toBe(true);
    expect(phraseFromHumanLog(omer, two)).toMatch(PHRASE); // issued to the human only

    // The human accepts the stale form afterwards: it approves nothing.
    h.late.forEach((f) => f());
    await new Promise((res) => setTimeout(res, 100));
    expect((await ok(omer, 'rdv_relays', { action: 'list' })).relays).toEqual([relay.url]);

    // From now on: no form, straight to the phrase.
    expect((await ok(omer, 'rdv_status')).approval).toContain('went unanswered');
    const three = await newRelay();
    const again = await omer.call('rdv_relays', { action: 'add', url: three });
    expect(again.isError).toBe(true);
    expect(again.text).not.toContain('got no answer');
    expect(again.text).toContain('rdv relays list');
    expect(h.forms).toHaveLength(1);

    // The human's phrase (the latest relay ask replaces the earlier one), typed to the model, approves exactly that change.
    expect((await ok(omer, 'rdv_relays', { action: 'add', url: three, confirm_phrase: phraseFromHumanLog(omer, three) })).relays).toEqual([relay.url, three]);
    expectNoPhrase(omer);
  }, 30_000);

  it('rdv_relays: a dismissed (cancelled) form approves nothing and falls back to the phrase; a decline is a plain no', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-elicit-'));
    let next: ElicitResult = { action: 'cancel' };
    const h = human(() => next);
    const omer = await side('omer', h);
    await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer.cancel@example.com', relays: [relay.url] });
    const two = await newRelay();

    const dismissed = await omer.call('rdv_relays', { action: 'add', url: two });
    expect(dismissed.isError).toBe(true);
    expect(dismissed.text).toContain('closed without an answer');
    expect(dismissed.text).toContain('rdv relays list');
    phraseFromHumanLog(omer, two); // issued to the human
    expect((await ok(omer, 'rdv_relays', { action: 'list' })).relays).toEqual([relay.url]);

    // A dismissal is not "this client can't show forms": the next gate asks with a form again.
    next = { action: 'decline' };
    const no = await omer.call('rdv_relays', { action: 'add', url: two });
    expect(h.forms).toHaveLength(2);
    expect([no.isError, no.json.approved, no.json.answer]).toEqual([false, false, 'declined']);
    expect(no.text).toContain('Nothing changed');
    next = { action: 'accept', content: { approve: false } };
    const unticked = await omer.call('rdv_relays', { action: 'add', url: two });
    expect([unticked.isError, unticked.json.answer]).toEqual([false, 'left unticked']);
    expect(unticked.text).toContain('tick the box before Accept');
    expect((await ok(omer, 'rdv_relays', { action: 'list' })).relays).toEqual([relay.url]);
    expect((await ok(omer, 'rdv_status')).approval).toBe('approval form (elicitation)');
    expectNoPhrase(omer);
  }, 30_000);

  it('rdv_grant: a form nobody answers falls back to the request phrase within the timeout; a late accept grants nothing', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-elicit-'));
    const h = human(() => 'never');
    const john = await side('john', h);
    const { requestId } = await pendingRequest(john);

    const t0 = Date.now();
    const r = await john.call('rdv_grant', { request_id: requestId });
    expect(Date.now() - t0).toBeLessThan(TIMEOUT + 5_000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('got no answer within');
    expect(r.text).toContain('rdv contact pending');
    expect(r.text).toContain('confirm_phrase');
    expect(h.forms).toHaveLength(1);
    expect(h.forms[0].message).toContain(TICK_NOTE);
    expect(h.forms[0].schema).toMatchObject({ properties: { approve: { type: 'boolean', default: false } } });
    await new Promise((res) => setTimeout(res, 50));
    expect(h.forms[0].withdrawn).toBe(true);
    h.late.forEach((f) => f());
    await new Promise((res) => setTimeout(res, 100));
    expect((await ok(john, 'rdv_status')).contacts).toEqual([]);
    expect((await ok(john, 'rdv_pending_requests')).pending.map((p: { request_id: string }) => p.request_id)).toContain(requestId);

    // Next time: straight to the phrase, no form; the phrase approves it.
    const again = await john.call('rdv_grant', { request_id: requestId });
    expect([again.isError, h.forms.length]).toEqual([true, 1]);
    const granted = await ok(john, 'rdv_grant', { request_id: requestId, confirm_phrase: phraseFromHumanLog(john, requestId) });
    expect(granted).toMatchObject({ granted: true });
    expectNoPhrase(john);
  }, 30_000);

  it('rdv_grant: decline and an unticked accept are plain no results; a cancel falls back to the phrase and grants nothing', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-elicit-'));
    let next: ElicitResult = { action: 'decline' };
    const h = human(() => next);
    const john = await side('john', h);
    const { requestId } = await pendingRequest(john);

    const no = await john.call('rdv_grant', { request_id: requestId });
    expect([no.isError, no.json.approved, no.json.answer, no.json.request_id]).toEqual([false, false, 'declined', requestId]);
    expect(no.text).toContain('declined in the approval form');
    expect(no.text).toContain('not granted');

    next = { action: 'accept', content: { approve: false, tier: 'friend' } };
    const unticked = await john.call('rdv_grant', { request_id: requestId });
    expect([unticked.isError, unticked.json.approved, unticked.json.answer]).toEqual([false, false, 'left unticked']);

    next = { action: 'cancel' };
    const dismissed = await john.call('rdv_grant', { request_id: requestId });
    expect(dismissed.isError).toBe(true);
    expect(dismissed.text).toContain('closed without an answer');
    expect(dismissed.text).toContain('rdv contact pending');
    expect(phraseFromHumanLog(john, requestId)).toMatch(PHRASE);

    expect(h.forms).toHaveLength(3);
    expect((await ok(john, 'rdv_status')).contacts).toEqual([]);
    expect((await ok(john, 'rdv_pending_requests')).pending.map((p: { request_id: string }) => p.request_id)).toContain(requestId);
    expectNoPhrase(john);
  }, 30_000);

  it('forms turned off (RDV_ELICIT=off): no form is ever sent, the phrase path is used', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-elicit-'));
    const h = human(() => ({ action: 'accept', content: { approve: true } }));
    const john = await side('john', h, { forms: false });
    const { requestId } = await pendingRequest(john);
    expect((await ok(john, 'rdv_status')).approval).toContain('RDV_ELICIT=off');
    const r = await john.call('rdv_grant', { request_id: requestId });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('got no answer');
    expect(r.text).toContain('rdv contact pending');
    expect(h.forms).toHaveLength(0);
    expect((await ok(john, 'rdv_status')).contacts).toEqual([]);
  }, 30_000);
});

describe('elicitOptionsFromEnv', () => {
  it('reads RDV_ELICIT_TIMEOUT_MS and RDV_ELICIT', () => {
    expect(DEFAULT_ELICIT_TIMEOUT_MS).toBe(60_000);
    expect(elicitOptionsFromEnv({})).toEqual({ elicitTimeoutMs: undefined, forms: true });
    expect(elicitOptionsFromEnv({ RDV_ELICIT_TIMEOUT_MS: '15000' })).toEqual({ elicitTimeoutMs: 15_000, forms: true });
    expect(elicitOptionsFromEnv({ RDV_ELICIT: 'off' }).forms).toBe(false);
    expect(elicitOptionsFromEnv({ RDV_ELICIT: 'OFF ' }).forms).toBe(false);
    expect(elicitOptionsFromEnv({ RDV_ELICIT: 'on' }).forms).toBe(true);
    const warned: string[] = [];
    for (const bad of ['-5', '0', 'soon', '1.5']) expect(elicitOptionsFromEnv({ RDV_ELICIT_TIMEOUT_MS: bad }, (l) => warned.push(l)).elicitTimeoutMs).toBeUndefined();
    expect(warned).toHaveLength(4);
  });
});
