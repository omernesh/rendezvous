// Contact nicknames and the agent's own name (NOTES 103): set only in an
// approval form, resolved by "to" (also as "Ran's agent"), never ambiguous,
// and never taken from what a peer's agent calls itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AgentNameChanged, changeAgentName, type Home } from '@rendezvous/cli/lib';
import { type AgentState, fingerprint } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ElicitHandler, makeSide, ok, type Side, waitEvent } from './flow.js';

const T = 15_000;
let relay: TestRelay;
let root: string;
let sides: Side[] = [];
let n = 0;
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

type Answer = (p: ElicitRequest['params']) => ElicitResult;
const yes =
  (content: Record<string, unknown> = {}): Answer =>
  () => ({ action: 'accept', content: { approve: true, ...content } as never });

function human(...answers: Answer[]) {
  const asked: Array<ElicitRequest['params']> = [];
  const handler: ElicitHandler = (p) => {
    asked.push(p);
    return (answers.length > 1 ? answers.shift()! : answers[0])(p);
  };
  return { handler, asked };
}
const fields = (p: ElicitRequest['params']) => (p as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema.properties;
const state = (h: Home) => h.readAgentState() as AgentState;
const aliases = (h: Home, peer: string) => state(h).book.contacts[peer]?.aliases ?? [];

async function side(name: string, opts: { elicit?: ElicitHandler } = {}, init: Record<string, unknown> = {}): Promise<{ s: Side; id: string }> {
  root ??= mkdtempSync(join(tmpdir(), 'rdv-nick-'));
  const s = await makeSide(name, join(root, name), opts);
  sides.push(s);
  const r = await ok(s, 'rdv_init', { profile: name, email: `${name}.${process.pid}.${++n}@example.com`, relays: [relay.url], public_pointer: true, ...init });
  return { s, id: r.agent_id };
}

/** `peer` becomes a contact of `me` (me asks by agent ID; peer's human grants in a form). */
async function connect(me: { s: Side; id: string }, peer: { s: Side; id: string }) {
  await ok(peer.s, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  await ok(me.s, 'rdv_request_contact', { target: peer.id });
  const req = await waitEvent(peer.s, (e) => e.type === 'contact_request' && e.from === me.id, 'the request', T);
  await ok(peer.s, 'rdv_grant', { request_id: req.request_id });
  await waitEvent(me.s, (e) => e.type === 'contact' && e.peer === peer.id, 'the grant', T);
}

describe('contact nicknames through rdv_label', () => {
  it("the human's nickname applies (the model's is only a suggestion); send by it and by \"Ran's agent\"; a name is one contact's only", { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-nick-'));
    const h = human(yes({ alias: 'Ran' }));
    const omer = await side('omer', { elicit: h.handler });
    const ran = await side('ran', { elicit: human(yes()).handler });
    const dana = await side('dana', { elicit: human(yes()).handler });
    await connect(omer, ran);
    await connect(omer, dana);

    // No name yet: refused, with the contacts' fingerprints and the offer to add the name.
    const none = await omer.s.call('rdv_send', { to: "Ran's agent", payload: { type: 'note', text: 'hi' } });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('no contact is labeled or nicknamed');
    expect(none.text).toContain(fingerprint(ran.id));
    expect(none.text).toContain('add-alias');

    // The model suggests "Mallory"; the human types "Ran".
    const added = await ok(omer.s, 'rdv_label', { agent_id: ran.id, action: 'add-alias', alias: 'Mallory' });
    expect(added).toMatchObject({ alias_added: true, aliases: ['Ran'] });
    const form = h.asked[0];
    expect(form.message).toContain(fingerprint(ran.id));
    expect(form.message).toContain('"Mallory" (suggested by your assistant');
    expect(fields(form).alias.default).toBe('Mallory');
    expect((form as { requestedSchema: { required?: string[] } }).requestedSchema.required).toEqual(['approve', 'alias']);
    expect(aliases(omer.s.home, ran.id)).toEqual(['Ran']);

    for (const to of ['Ran', 'ran', "Ran's agent", 'Ran’s agent', 'agent of Ran']) {
      await ok(omer.s, 'rdv_send', { to, payload: { type: 'note', text: `to ${to}` } });
      await waitEvent(ran.s, (e) => e.type === 'message' && e.from === omer.id && JSON.stringify(e).includes(`to ${to}`), `the note to ${to}`, T);
    }
    // rdv_status shows it.
    const st = await ok(omer.s, 'rdv_status');
    expect(st.contacts.find((c: { agent_id: string }) => c.agent_id === ran.id).aliases).toEqual(['Ran']);

    // Dana can't have "Ran" too: refused before any form.
    const asked = h.asked.length;
    const dup = await omer.s.call('rdv_label', { agent_id: dana.id, action: 'add-alias', alias: 'RAN' });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/already the name of another contact/);
    expect(h.asked.length).toBe(asked);
    expect(aliases(omer.s.home, dana.id)).toEqual([]);
    // Nor when the human types it in the form.
    const typed = await omer.s.call('rdv_label', { agent_id: dana.id, action: 'add-alias', alias: 'Dana' });
    expect(typed.isError).toBe(true);
    expect(typed.text).toMatch(/already the name of another contact/);
    expect(aliases(omer.s.home, dana.id)).toEqual([]);

    // A name two contacts share (a label may collide) is refused, never guessed.
    await omer.s.home.locked(async () => {
      const s = state(omer.s.home);
      s.book.contacts[dana.id].label = 'ran';
      omer.s.home.writeAgentState(s as never);
    });
    const amb = await omer.s.call('rdv_send', { to: "Ran's agent", payload: { type: 'note', text: 'which?' } });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain('2 contacts are labeled or nicknamed');
    expect((await ok(omer.s, 'rdv_status')).contacts.filter((c: Record<string, unknown>) => 'label_conflict' in c)).toHaveLength(2);

    // Removing it, in the form too.
    const removed = await ok(omer.s, 'rdv_label', { agent_id: ran.id, action: 'remove-alias', alias: 'Ran' });
    expect(removed).toMatchObject({ alias_removed: true, aliases: [] });
    expect(aliases(omer.s.home, ran.id)).toEqual([]);
  });

  it('without a form it is refused and names the terminal command', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-nick-'));
    const omer = await side('omer');
    const ran = await side('ran', { elicit: human(yes()).handler });
    await connect(omer, ran);
    const r = await omer.s.call('rdv_label', { agent_id: ran.id, action: 'add-alias', alias: 'Ran' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rdv contact alias add');
    expect(r.text).toMatch(/no confirm phrase/);
    expect(aliases(omer.s.home, ran.id)).toEqual([]);
    const n = await omer.s.call('rdv_agent_name', { name: 'Sammie' });
    expect(n.isError).toBe(true);
    expect(n.text).toContain('rdv agent-name set');
    expect(state(omer.s.home).card.agent_name).toBeUndefined();
  });
});

describe("the agent's own name", () => {
  it('set only in a form (rdv_init takes none); peers see it only as untrusted text and can never send to it', { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-nick-'));
    const h = human(yes({ name: 'Sammie' }));
    // The model's text never goes on the card unseen (security review L1): rdv_init has no agent_name.
    const omer = await side('omer', { elicit: h.handler }, { agent_name: 'Sam' });
    expect(state(omer.s.home).card.agent_name).toBeUndefined();
    const initSchema = (await omer.s.client.listTools()).tools.find((t) => t.name === 'rdv_init')!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(initSchema.properties)).not.toContain('agent_name');
    // John's human: the grant, then (later) a nickname of his own choosing.
    const jh = human(yes(), yes({ alias: 'Sammie' }));
    const john = await side('john', { elicit: jh.handler });
    await connect(omer, john);
    // The human renames it in the form.
    const r = await ok(omer.s, 'rdv_agent_name', { name: 'Samantha' });
    expect(r).toMatchObject({ agent_name: 'Sammie', changed: true });
    expect(fields(h.asked[0]).name.default).toBe('Samantha');
    expect(state(omer.s.home).card.agent_name).toBe('Sammie');
    expect((await ok(omer.s, 'rdv_status')).agent_name).toBe('Sammie');
    // The check that the name is what the form showed runs under the same lock as the change (security review L4).
    await expect(changeAgentName(omer.s.home, 'Mallory', { expect: 'Samantha' })).rejects.toBeInstanceOf(AgentNameChanged);
    expect(state(omer.s.home).card.agent_name).toBe('Sammie');

    // John holds Omer's card (from the grant, then the card update): the name is Omer's claim, quarantined.
    const view = async () => (await ok(john.s, 'rdv_status')).contacts.find((c: { agent_id: string }) => c.agent_id === omer.id);
    let c = await view();
    for (let i = 0; i < 100 && JSON.stringify(c.calls_itself ?? null) !== JSON.stringify({ untrusted_peer_text: 'calls itself Sammie' }); i++) {
      await new Promise((res) => setTimeout(res, 100));
      c = await view();
    }
    expect(c.calls_itself).toEqual({ untrusted_peer_text: 'calls itself Sammie' });
    const to = await john.s.call('rdv_send', { to: 'Sammie', payload: { type: 'note', text: 'hi' } });
    expect(to.isError).toBe(true);
    expect((await john.s.call('rdv_send', { to: "Sammie's agent", payload: { type: 'note', text: 'hi' } })).isError).toBe(true);
    // Only John's human can make it a name of his: then it resolves.
    await ok(john.s, 'rdv_label', { agent_id: omer.id, action: 'add-alias' });
    expect(fields(jh.asked[1]).alias.default).toBe('');
    await ok(john.s, 'rdv_send', { to: "Sammie's agent", payload: { type: 'note', text: 'hi from john' } });
    await waitEvent(omer.s, (e) => e.type === 'message' && e.from === john.id, 'the note', T);
  });

  it('the default greeting of a contact request uses the name', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-nick-'));
    const omer = await side('omer', { elicit: human(yes({ name: 'Sammie' })).handler });
    await ok(omer.s, 'rdv_agent_name', { name: 'Sammie' });
    const john = await side('john', { elicit: human(yes()).handler });
    await ok(john.s, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer.s, 'rdv_request_contact', { target: john.id });
    const req = await waitEvent(john.s, (e) => e.type === 'contact_request' && e.from === omer.id, 'the request', T);
    expect(JSON.stringify(req.greeting)).toContain("Sammie, omer's agent, would like to get in touch.");
    const pending = await ok(john.s, 'rdv_pending_requests');
    expect(JSON.stringify(pending)).toContain('calls itself Sammie');
  });
});
