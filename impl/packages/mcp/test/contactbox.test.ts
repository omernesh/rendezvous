// "Don't ask again for this contact" on the forms that make a contact (NOTES
// 112): rdv_grant for a request or a probe answer, and rdv_invite "create". One
// unticked box, for exactly what the grant being approved lets auto-approve
// cover, absent when that is nothing; only the human's form answer sets it, no
// tool argument and no confirm phrase. An invite's takes effect when it is
// redeemed, only for the contact that redeems it, and a revoked or expired
// invite leaves nothing behind.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { REQUEST_URI } from '@rendezvous/a2a';
import { type AgentState, fingerprint, MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearOwnerSecret, storeOwnerSecret } from '../../cli/src/ownersecret.js';
import { ALWAYS_ALLOW_FIELD } from '../src/index.js';
import { type ElicitHandler, makeSide, ok, phraseFromHumanLog, type Side, waitEvent } from './flow.js';

const T = 15_000;
const BOX = ALWAYS_ALLOW_FIELD;

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
  for (const s of sides) await s.close().catch(() => {});
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Asked {
  message: string;
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/** A human who answers each form with the next answer (default: approve as shown), and what they were shown. */
function human(...answers: Array<Record<string, unknown>>): { handler: ElicitHandler; asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    handler: (params: ElicitRequest['params']): ElicitResult => {
      const s = (params as { requestedSchema: { properties: Asked['properties']; required?: string[] } }).requestedSchema;
      asked.push({ message: String(params.message), properties: s.properties, required: s.required });
      return { action: 'accept', content: { approve: true, ...(answers.shift() ?? {}) } };
    },
  };
}

const emails = new Map<Side, string>();

async function side(name: string, elicit?: ElicitHandler) {
  root ??= mkdtempSync(join(tmpdir(), 'rdv-box-'));
  const s = await makeSide(name, join(root, name), { elicit, unsafeInviteRelays: [relay.url] });
  sides.push(s);
  const email = `${name}+${randomBytes(3).toString('hex')}@example.com`;
  emails.set(s, email);
  await ok(s, 'rdv_init', { profile: name, email, relays: [relay.url], public_pointer: true });
  return s;
}

const fresh = () => {
  root = mkdtempSync(join(tmpdir(), 'rdv-box-'));
};

/** Omer asks John for contact; John's request waits for John. */
async function requested(john: Side, omer: Side) {
  const j = await ok(john, 'rdv_status');
  await ok(john, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  await ok(omer, 'rdv_discover', { address: emails.get(john)! });
  const sent = await ok(omer, 'rdv_request_contact', { target: j.agent_id });
  await waitEvent(john, (e) => e.type === 'contact_request' && e.request_id === sent.request_id, 'the request', T);
  return { johnId: j.agent_id as string, omerId: (await ok(omer, 'rdv_status')).agent_id as string, requestId: sent.request_id as string };
}

const autoApproveFile = (s: Side) => {
  try {
    return JSON.parse(readFileSync(join(s.home.dir, 'autoapprove.json'), 'utf8'));
  } catch {
    return {};
  }
};
const statusOf = async (s: Side, peer: string) => (await ok(s, 'rdv_status')).contacts.find((c: { agent_id: string }) => c.agent_id === peer);

describe('the box on the form that approves a contact request', () => {
  it('starts unticked and says what it covers; ticked, it covers the grant at once and later forms do not ask', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const john = await side('john', h.handler);
    const omer = await side('omer');
    const { requestId, omerId, johnId } = await requested(john, omer);

    const r = await ok(john, 'rdv_grant', { request_id: requestId, invoke: [REQUEST_URI] });
    const box = h.asked[0].properties[BOX];
    expect(box).toMatchObject({ type: 'boolean', default: false, title: "Don't ask again for this contact" });
    expect(h.asked[0].required ?? []).not.toContain(BOX);
    const text = box.description as string;
    expect(text).toContain(fingerprint(omerId));
    expect(text).toContain('a dinner they propose is accepted and confirmed for you');
    expect(text).toContain(REQUEST_URI);
    expect(text).toContain('until you turn it off');
    expect(text).toContain('ask your assistant to turn auto-approve off');
    expect(text).toContain(`auto-approve ${omerId} off`);
    expect(text).toContain('Risk:');
    // No passphrase field: the same bar as the box on a task or dinner form (NOTES 96).
    expect(Object.keys(h.asked[0].properties)).not.toContain('passphrase');

    expect(r.auto_approve).toMatchObject({ state: 'on', agent_id: omerId, until: 'until your user turns it off' });
    expect(r.auto_approve.covers.sort()).toEqual([MEETINGS_CAPABILITY, REQUEST_URI].sort());
    expect(r.auto_approve.how_to_turn_off).toContain('rdv_auto_approve');
    const on = await waitEvent(john, (e) => e.type === 'auto_approve_on', 'the event', T);
    expect(on).toMatchObject({ agent_id: omerId, via: 'approval form' });
    expect(john.home.readAudit().find((a) => a.gate === 'auto-approve')).toMatchObject({ peer: omerId, action: 'set', by: 'human', via: 'form' });
    expect((await statusOf(john, omerId)).auto_approve.covers.sort()).toEqual([MEETINGS_CAPABILITY, REQUEST_URI].sort());

    // Omer's next task starts without a form: nothing asked again.
    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === johnId, 'the grant', T);
    const forms = h.asked.length;
    const t = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: 'Please draft the copy.' });
    await waitEvent(john, (e) => e.type === 'task' && e.task_id === t.task_id && e.kind === 'started' && e.auto_approved === true, 'the auto start', T);
    expect(h.asked.length).toBe(forms);

    // The existing off path.
    await ok(john, 'rdv_auto_approve', { action: 'off', agent_id: omerId });
    expect((await statusOf(john, omerId)).auto_approve).toBeNull();
    expect(autoApproveFile(john)).toEqual({});
  }, 60_000);

  it('left unticked it stays off, and the later form still offers its own box', async () => {
    fresh();
    const h = human();
    const john = await side('john', h.handler);
    const omer = await side('omer');
    const { requestId, omerId, johnId } = await requested(john, omer);
    const r = await ok(john, 'rdv_grant', { request_id: requestId, invoke: [REQUEST_URI] });
    expect(h.asked[0].properties[BOX]).toBeDefined();
    expect(r.auto_approve).toBeUndefined();
    expect(autoApproveFile(john)).toEqual({});
    expect((await statusOf(john, omerId)).auto_approve).toBeNull();

    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === johnId, 'the grant', T);
    const t = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: 'Please draft.' });
    await waitEvent(john, (e) => e.type === 'task' && e.task_id === t.task_id && e.kind === 'start-needed', 'the start gate', T);
    await ok(john, 'rdv_task', { action: 'approve-start', task_id: t.task_id });
    expect(h.asked.at(-1)!.properties[BOX]).toMatchObject({ default: false });
  }, 60_000);

  it('only what is offered and still in the grant: nothing with no capability, the rest when the human unticks one', async () => {
    fresh();
    const h = human({ [BOX]: true }, { [BOX]: true, allow_invoke: false });
    const john = await side('john', h.handler);
    const omer = await side('omer');
    const { requestId, omerId } = await requested(john, omer);
    // A stranger with no meetings and nothing to invoke: no box, and a box in the answer is not read.
    const none = await ok(john, 'rdv_grant', { request_id: requestId, tier: 'stranger', may_propose_meetings: false });
    expect(h.asked[0].properties[BOX]).toBeUndefined();
    expect(none.granted).toBe(true);
    expect(none.auto_approve).toBeUndefined();
    expect(autoApproveFile(john)).toEqual({});
    await ok(john, 'rdv_revoke', { agent_id: omerId });

    const dana = await side('dana');
    const again = await requested(john, dana);
    const narrowed = await ok(john, 'rdv_grant', { request_id: again.requestId, invoke: [REQUEST_URI] });
    expect(h.asked[1].properties[BOX].description).toContain('Anything you untick above is not covered');
    expect(narrowed.auto_approve.covers).toEqual([MEETINGS_CAPABILITY]);
    expect((await statusOf(john, again.omerId)).auto_approve.covers).toEqual([MEETINGS_CAPABILITY]);
  }, 90_000);

  it('a tool argument sets nothing, on the form or with a phrase; no tool takes it', async () => {
    fresh();
    const h = human();
    const john = await side('john', h.handler);
    const omer = await side('omer');
    const { requestId } = await requested(john, omer);
    const tools = await john.client.listTools();
    expect(JSON.stringify(tools.tools.map((t) => t.inputSchema))).not.toContain(BOX);
    const r = await ok(john, 'rdv_grant', { request_id: requestId, [BOX]: true, auto_approve: true });
    expect(h.asked[0].properties[BOX]).toMatchObject({ default: false });
    expect(r.auto_approve).toBeUndefined();
    expect(autoApproveFile(john)).toEqual({});
    expect(john.home.readAudit().filter((a) => a.gate === 'auto-approve')).toEqual([]);

    // A client with no forms: the confirm phrase, which never carries it.
    const ann = await side('ann');
    const ben = await side('ben');
    const q = await requested(ann, ben);
    const waits = await ann.call('rdv_grant', { request_id: q.requestId, [BOX]: true });
    expect(waits.isError).toBe(true);
    const granted = await ok(ann, 'rdv_grant', { request_id: q.requestId, confirm_phrase: phraseFromHumanLog(ann, q.requestId), [BOX]: true });
    expect(granted.granted).toBe(true);
    expect(granted.auto_approve).toBeUndefined();
    expect(autoApproveFile(ann)).toEqual({});
  }, 90_000);

  it('matches the existing box on the passphrase: none asked with one set; not offered once one was reset', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const john = await side('john', h.handler);
    const omer = await side('omer');
    const { requestId, omerId } = await requested(john, omer);
    await storeOwnerSecret(john.home, 'JOHN-OWNER-PASS 1234', 'set', new Date(), 'form');
    const r = await ok(john, 'rdv_grant', { request_id: requestId });
    expect(Object.keys(h.asked[0].properties)).not.toContain('passphrase');
    expect(r.auto_approve).toMatchObject({ state: 'on', covers: [MEETINGS_CAPABILITY] });
    expect((await statusOf(john, omerId)).auto_approve).not.toBeNull();

    const dana = await side('dana');
    const q = await requested(john, dana);
    await clearOwnerSecret(john.home);
    const after = await ok(john, 'rdv_grant', { request_id: q.requestId });
    expect(h.asked[1].properties[BOX]).toBeUndefined();
    expect(after.auto_approve).toBeUndefined();
  }, 90_000);
});

describe('the box on the form that confirms a probe answer', () => {
  it('absent for the default rights, which it would cover nothing of; present when the human already granted this agent more', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const john = await side('john', human().handler);
    const omer = await side('omer', h.handler);
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_request_contact', { target: emails.get(john)! });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the probe', T);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    const cand = await waitEvent(omer, (e) => e.type === 'contact_candidate', 'the answer', T);

    // Seed the rare case in Omer's temp home: this agent is already his contact, granted meetings by him.
    const johnId = (await ok(john, 'rdv_status')).agent_id as string;
    await omer.home.locked(async () => {
      const s = omer.home.readAgentState() as AgentState;
      const c = s.book.candidates[cand.grant_id];
      s.book.contacts[johnId] = { peer: johnId, card: c.grant.card, tier: 'friend', inboundScope: { may_propose_meetings: true }, inboundGranted: true, outboundScope: { may_initiate: true }, binding: 'claimed', grantId: 'prior', expires: null, since: new Date().toISOString() };
      omer.home.writeAgentState(s);
    });
    const r = await ok(omer, 'rdv_grant', { grant_id: cand.grant_id });
    expect(h.asked[0].properties[BOX]).toMatchObject({ default: false });
    expect(h.asked[0].properties[BOX].description).toContain('a dinner they propose');
    expect(r.confirmed).toBe(true);
    expect(r.auto_approve).toMatchObject({ state: 'on', covers: [MEETINGS_CAPABILITY] });
  }, 60_000);

  it('a plain probe answer shows no box, and a box in the answer sets nothing', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const john = await side('john', human().handler);
    const omer = await side('omer', h.handler);
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_request_contact', { target: emails.get(john)! });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the probe', T);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    const cand = await waitEvent(omer, (e) => e.type === 'contact_candidate', 'the answer', T);
    const r = await ok(omer, 'rdv_grant', { grant_id: cand.grant_id });
    expect(h.asked[0].properties[BOX]).toBeUndefined();
    expect(r.confirmed).toBe(true);
    expect(r.auto_approve).toBeUndefined();
    expect(autoApproveFile(omer)).toEqual({});
  }, 60_000);
});

describe('the box on rdv_invite "create"', () => {
  const standings = (s: Side) => Object.values((s.home.readAgentState() as AgentState).book.invites ?? {}).map((i) => i.standing).filter(Boolean);

  it('takes effect when redeemed, only for the contact that redeems it', async () => {
    fresh();
    const h = human({ [BOX]: true, label: 'Dana' });
    const omer = await side('omer', h.handler);
    const made = await ok(omer, 'rdv_invite', { action: 'create', invoke: [REQUEST_URI] });
    const box = h.asked[0].properties[BOX];
    expect(box).toMatchObject({ type: 'boolean', default: false });
    expect(box.description).toContain('whoever uses this link, and nobody else');
    expect(box.description).toContain('if someone else gets the link first it applies to them');
    expect(box.description).toContain(REQUEST_URI);
    expect(box.description).toContain('Anything you untick above is not covered');
    expect(made.auto_approve_when_used).toMatchObject({ state: 'chosen' });
    expect(made.auto_approve_when_used.covers.sort()).toEqual([MEETINGS_CAPABILITY, REQUEST_URI].sort());
    // Nothing on yet, and the link's owner record stays out of what the model sees.
    expect(autoApproveFile(omer)).toEqual({});
    const listed = await ok(omer, 'rdv_invite', { action: 'list' });
    expect(listed.invites[0].auto_approve_when_used.sort()).toEqual([MEETINGS_CAPABILITY, REQUEST_URI].sort());
    expect(JSON.stringify(listed)).not.toContain('"owner"');
    expect(JSON.stringify(omer.transcript)).not.toContain(`"owner":"`);

    const dana = await side('dana');
    const a = await ok(dana, 'rdv_accept_invite', { invite: made.url });
    expect(a.request_id).toBeTruthy();
    const danaId = (await ok(dana, 'rdv_status')).agent_id as string;
    const omerId = (await ok(omer, 'rdv_status')).agent_id as string;
    const on = await waitEvent(omer, (e) => e.type === 'auto_approve_on' && e.agent_id === danaId, 'auto_approve_on', T);
    expect(on).toMatchObject({ via: 'invite link', invite_id: made.invite_id, fingerprint: fingerprint(danaId), until: 'until your user turns it off' });
    expect(on.how_to_turn_off).toContain('rdv_auto_approve');
    expect((await statusOf(omer, danaId)).auto_approve.covers.sort()).toEqual([MEETINGS_CAPABILITY, REQUEST_URI].sort());
    expect(omer.home.readAudit().find((x) => x.gate === 'auto-approve')).toMatchObject({ peer: danaId, action: 'set', by: 'human', via: 'form' });
    expect(standings(omer)).toEqual([]);

    // The same link again: an ordinary request, and approving it gives nothing unless the human ticks that form's own box.
    const eve = await side('eve');
    const again = await ok(eve, 'rdv_accept_invite', { invite: made.url });
    await waitEvent(omer, (e) => e.type === 'contact_request' && e.request_id === again.request_id, 'eve waits', T);
    const eveId = (await ok(eve, 'rdv_status')).agent_id as string;
    await ok(omer, 'rdv_grant', { request_id: again.request_id });
    expect(Object.keys(autoApproveFile(omer))).toEqual([danaId]);
    expect((await statusOf(omer, eveId)).auto_approve).toBeNull();

    // The redeemer's next task runs without asking.
    await waitEvent(dana, (e) => e.type === 'contact' && e.peer === omerId, 'the grant', T);
    const forms = h.asked.length;
    const t = await ok(dana, 'rdv_task', { action: 'request', agent_id: omerId, text: 'Please draft.' });
    await waitEvent(omer, (e) => e.type === 'task' && e.task_id === t.task_id && e.kind === 'started' && e.auto_approved === true, 'the auto start', T);
    expect(h.asked.length).toBe(forms);
  }, 90_000);

  it('unticked or with an argument it stores nothing', async () => {
    fresh();
    const h = human();
    const omer = await side('omer', h.handler);
    const made = await ok(omer, 'rdv_invite', { action: 'create', [BOX]: true });
    expect(h.asked[0].properties[BOX]).toMatchObject({ default: false });
    expect(made.auto_approve_when_used).toBeUndefined();
    expect(standings(omer)).toEqual([]);
    // No meetings and nothing to invoke: nothing applies, no box.
    const none = await ok(omer, 'rdv_invite', { action: 'create', may_propose_meetings: false });
    expect(h.asked[1].properties[BOX]).toBeUndefined();
    expect(none.auto_approve_when_used).toBeUndefined();
    expect(standings(omer)).toEqual([]);
  }, 60_000);

  it('the human narrowing the form: never more than what is left; nothing left, nothing stored and said so', async () => {
    fresh();
    const h = human({ [BOX]: true, may_propose_meetings: false, allow_invoke: true }, { [BOX]: true, may_propose_meetings: false });
    const omer = await side('omer', h.handler);
    const a = await ok(omer, 'rdv_invite', { action: 'create', invoke: [REQUEST_URI] });
    expect(a.auto_approve_when_used.covers).toEqual([REQUEST_URI]);
    const b = await ok(omer, 'rdv_invite', { action: 'create' });
    expect(b.auto_approve_when_used).toMatchObject({ state: 'not_turned_on' });
  }, 60_000);

  it('a revoked invite leaves nothing behind: the request waits, and approving it turns nothing on', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const omer = await side('omer', h.handler);
    const made = await ok(omer, 'rdv_invite', { action: 'create' });
    expect(standings(omer)).toHaveLength(1);
    await ok(omer, 'rdv_invite', { action: 'revoke', invite_id: made.invite_id });
    expect(standings(omer)).toEqual([]);
    expect((await ok(omer, 'rdv_invite', { action: 'list' })).invites[0].auto_approve_when_used).toBeUndefined();

    const dana = await side('dana');
    const a = await ok(dana, 'rdv_accept_invite', { invite: made.url });
    await waitEvent(omer, (e) => e.type === 'contact_request' && e.request_id === a.request_id, 'it waits', T);
    await ok(omer, 'rdv_grant', { request_id: a.request_id });
    expect(autoApproveFile(omer)).toEqual({});
    expect(omer.home.readAudit().filter((x) => x.gate === 'auto-approve')).toEqual([]);
  }, 60_000);

  it('an expired invite leaves nothing behind either', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const omer = await side('omer', h.handler);
    const made = await ok(omer, 'rdv_invite', { action: 'create' });
    // The clock passes its expiry (the link itself still reads as open for the person holding it).
    await omer.home.locked(async () => {
      const s = omer.home.readAgentState() as AgentState;
      s.book.invites![made.invite_id].expires = new Date(Date.now() - 1000).toISOString();
      omer.home.writeAgentState(s);
    });
    const dana = await side('dana');
    const a = await ok(dana, 'rdv_accept_invite', { invite: made.url });
    await waitEvent(omer, (e) => e.type === 'contact_request' && e.request_id === a.request_id, 'it waits', T);
    expect(standings(omer)).toEqual([]);
    expect(autoApproveFile(omer)).toEqual({});
    await ok(omer, 'rdv_grant', { request_id: a.request_id });
    expect(autoApproveFile(omer)).toEqual({});
  }, 60_000);

  it('a passphrase set since the invite was made ends the choice: the contact stands, auto-approve does not', async () => {
    fresh();
    const h = human({ [BOX]: true });
    const omer = await side('omer', h.handler);
    const made = await ok(omer, 'rdv_invite', { action: 'create' });
    await storeOwnerSecret(omer.home, 'OMER-OWNER-PASS 1234', 'set', new Date(), 'form');
    const dana = await side('dana');
    await ok(dana, 'rdv_accept_invite', { invite: made.url });
    const danaId = (await ok(dana, 'rdv_status')).agent_id as string;
    const off = await waitEvent(omer, (e) => e.type === 'auto_approve_off' && e.peer === danaId, 'told it is off', T);
    expect(off.reason).toBe('owner-secret');
    await waitEvent(omer, (e) => e.type === 'invite_redeemed', 'redeemed', T);
    expect(autoApproveFile(omer)).toEqual({});
    expect((await statusOf(omer, danaId)).auto_approve).toBeNull();
  }, 60_000);
});
