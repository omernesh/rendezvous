// Chat-first control (issue #102, NOTES 97): the owner's settings are tools
// whose effect needs the human's answer in an approval form, bound to what the
// form showed. None has a confirm phrase; without a form each is refused and
// names the terminal command. What the model passes is only what the form
// starts with: the human's answer is what applies.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { hasOwnerSecret, type Home } from '@rendezvous/cli/lib';
import { type AgentState, b64decode, fingerprint } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ElicitHandler, makeSide, ok, type Side, waitEvent } from './flow.js';

const T = 15_000;
const PASS = 'correct horse battery staple 42';
const PASS2 = 'another long passphrase 77';

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
const no: Answer = () => ({ action: 'decline' });

/** A scripted human: each form gets the next answer (the last one repeats); what they were asked is kept. */
function human(...answers: Answer[]) {
  const asked: Array<ElicitRequest['params']> = [];
  const handler: ElicitHandler = (p) => {
    asked.push(p);
    return (answers.length > 1 ? answers.shift()! : answers[0])(p);
  };
  return { handler, asked };
}

const fields = (p: ElicitRequest['params']) => (p as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema.properties;

/** Everything a model or a log could have seen on this side. */
const seen = (s: Side) =>
  [s.transcript.join('\n'), s.humanLog.join('\n'), existsSync(s.home.eventsPath) ? readFileSync(s.home.eventsPath, 'utf8') : '', existsSync(s.home.auditPath) ? readFileSync(s.home.auditPath, 'utf8') : ''].join(
    '\n',
  );

const state = (h: Home) => h.readAgentState() as AgentState;
const directOn = (h: Home) => h.readOwner(b64decode(h.readAgentState().secretKey)).direct_transfer === true;

/** Edit the agent's saved state under the home lock (a fork or a frozen group, as the listener would record it). */
async function edit(h: Home, fn: (s: AgentState) => void): Promise<void> {
  await h.locked(async () => {
    const s = state(h);
    fn(s);
    h.writeAgentState(s as never);
  });
}

async function side(name: string, opts: { elicit?: ElicitHandler; formWaitMs?: number } = {}): Promise<{ s: Side; id: string }> {
  root ??= mkdtempSync(join(tmpdir(), 'rdv-settings-'));
  const s = await makeSide(name, join(root, name), opts);
  sides.push(s);
  const r = await ok(s, 'rdv_init', { profile: name, email: `${name}.${process.pid}.${++n}@example.com`, relays: [relay.url], public_pointer: true });
  return { s, id: r.agent_id };
}

/** Omer (with the given forms) has John as a contact, and John has written to him once. */
async function pair(omerOpts: { elicit?: ElicitHandler; formWaitMs?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'rdv-settings-'));
  const o = await side('omer', omerOpts);
  const j = await side('john', { elicit: human(yes()).handler });
  await ok(j.s, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  await ok(o.s, 'rdv_request_contact', { target: j.id });
  const req = await waitEvent(j.s, (e) => e.type === 'contact_request', 'the request', T);
  await ok(j.s, 'rdv_grant', { request_id: req.request_id });
  await waitEvent(o.s, (e) => e.type === 'contact' && e.peer === j.id, 'the grant', T);
  await ok(j.s, 'rdv_send', { agent_id: o.id, payload: { type: 'note', text: 'hi' } });
  await waitEvent(o.s, (e) => e.type === 'message' && e.from === j.id, 'the note', T);
  return { omer: o.s, john: j.s, o: o.id, j: j.id };
}

const fork = (peer: string) => (s: AgentState) => {
  (s.channels as Record<string, Record<string, unknown>>)[peer].refused = { kind: 'fork', seq: 5, hash: 'ab'.repeat(32), accepted: 4 };
};
const refused = (h: Home, peer: string) => !!(state(h).channels as Record<string, { refused?: unknown }>)[peer]?.refused;
const label = (h: Home, peer: string) => state(h).book.contacts[peer]?.label ?? null;

describe('without an approval form', () => {
  it('each setting is refused with no confirm phrase, names the terminal command, and changes nothing; "off" needs none', { timeout: 60_000 }, async () => {
    const { omer, j, o } = await pair();
    const refuse = async (tool: string, args: Record<string, unknown>, cmd: string) => {
      const r = await omer.call(tool, args);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toContain(cmd);
      expect(r.text).toMatch(/approval form/);
      expect(r.text).toMatch(/no confirm phrase/);
    };
    await refuse('rdv_label', { agent_id: j, label: 'John' }, 'rdv contact label');
    expect(label(omer.home, j)).toBe(null);
    await refuse('rdv_owner_passphrase', {}, 'rdv owner-secret set');
    expect(hasOwnerSecret(omer.home)).toBe(false);
    await refuse('rdv_file', { action: 'direct-transfer', direct_transfer: 'on' }, 'rdv file direct-transfer on');
    expect(directOn(omer.home)).toBe(false);
    await edit(omer.home, fork(j));
    await refuse('rdv_resync', { agent_id: j }, 'rdv contact resync');
    expect(refused(omer.home, j)).toBe(true);
    await refuse('rdv_init', { replace: true }, 'rdv init --force');
    expect(state(omer.home).card.id).toBe(o);
    // Off only narrows: no form needed.
    expect(await ok(omer, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'off' })).toMatchObject({ direct_transfer: 'off', changed: false });
    // No confirm phrase was issued for any of them.
    expect(Object.keys(omer.home.readConsent())).toEqual([]);
    // The passphrase tool takes no argument at all.
    const tools = (await omer.client.listTools()).tools;
    expect(Object.keys((tools.find((t) => t.name === 'rdv_owner_passphrase')!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual([]);
  });
});

describe('rdv_label', () => {
  it("shows the contact and applies the human's label, never the model's on its own; a no changes nothing", { timeout: 60_000 }, async () => {
    const h = human(no, yes({ label: 'John Doe' }));
    const { omer, j } = await pair({ elicit: h.handler });
    const declined = await ok(omer, 'rdv_label', { agent_id: j, label: 'Mallory' });
    expect(declined).toMatchObject({ approved: false, answer: 'declined' });
    expect(label(omer.home, j)).toBe(null);
    const form = h.asked[0];
    expect(form.message).toContain(j);
    expect(form.message).toContain(fingerprint(j));
    expect(fields(form).label.default).toBe('Mallory');
    // The name the form starts with is in its text, and the field must come back (security review).
    expect(form.message).toContain('New label:    "Mallory" (suggested by your assistant');
    expect((form as { requestedSchema: { required?: string[] } }).requestedSchema.required).toEqual(['approve', 'label']);
    // The human types another name: theirs applies.
    expect(await ok(omer, 'rdv_label', { agent_id: j, label: 'Mallory' })).toMatchObject({ labeled: true, local_label: 'John Doe' });
    expect(label(omer.home, j)).toBe('John Doe');
    expect((await ok(omer, 'rdv_send', { to: 'John Doe', payload: { type: 'note', text: 'hi' } })).sent ?? true).toBeTruthy();
    expect((await omer.call('rdv_label', { agent_id: 'rdv1:notacontact', label: 'x' })).isError).toBe(true);
  });

  it('an answer to a form whose contact changed meanwhile does nothing', { timeout: 60_000 }, async () => {
    const forms: Array<{ message: string; answer: (r: ElicitResult) => void; label: unknown }> = [];
    const handler: ElicitHandler = (p) =>
      new Promise<ElicitResult>((answer) => forms.push({ message: String(p.message), answer, label: fields(p).label?.default }));
    const { omer, j } = await pair({ elicit: handler, formWaitMs: 0 });
    const first = await ok(omer, 'rdv_label', { agent_id: j, label: 'First' });
    const second = await ok(omer, 'rdv_label', { agent_id: j, label: 'Second' });
    expect([first.status, second.status]).toEqual(['awaiting_human', 'awaiting_human']);
    for (let i = 0; i < 100 && forms.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    forms.find((f) => f.label === 'Second')!.answer({ action: 'accept', content: { approve: true, label: 'Second' } });
    await waitEvent(omer, (e) => e.type === 'approval' && e.approval_id === second.approval_id && e.outcome === 'decided', 'second', T);
    expect(label(omer.home, j)).toBe('Second');
    // The first form showed "no label" as the current one: built again now it differs, so its yes does nothing.
    forms.find((f) => f.label === 'First')!.answer({ action: 'accept', content: { approve: true, label: 'First' } });
    const stale = await waitEvent(omer, (e) => e.type === 'approval' && e.approval_id === first.approval_id, 'first', T);
    expect(stale.outcome).toBe('changed');
    expect(label(omer.home, j)).toBe('Second');
  });
});

describe('rdv_owner_passphrase', () => {
  it('sets it from the form (twice, a minimum strength), changes it with the current one, and never shows it', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-settings-'));
    const h = human(
      yes({ passphrase: PASS, passphrase_again: `${PASS}!` }),
      yes({ passphrase: 'short', passphrase_again: 'short' }),
      no,
      yes({ passphrase: PASS, passphrase_again: PASS }),
      yes({ current_passphrase: 'not it at all', passphrase: PASS2, passphrase_again: PASS2 }),
      yes({ current_passphrase: PASS, passphrase: PASS2, passphrase_again: PASS2 }),
    );
    const { s } = await side('omer', { elicit: h.handler });
    expect((await s.call('rdv_owner_passphrase')).text).toContain('did not match');
    expect((await s.call('rdv_owner_passphrase')).text).toContain('too weak');
    expect(await ok(s, 'rdv_owner_passphrase')).toMatchObject({ approved: false, answer: 'declined' });
    expect(hasOwnerSecret(s.home)).toBe(false);
    expect(await ok(s, 'rdv_owner_passphrase')).toMatchObject({ owner_passphrase: 'set' });
    expect(hasOwnerSecret(s.home)).toBe(true);
    expect(Object.keys(fields(h.asked[3])).sort()).toEqual(['approve', 'passphrase', 'passphrase_again']);
    const wrong = await s.call('rdv_owner_passphrase');
    expect([wrong.isError, wrong.text]).toEqual([true, expect.stringContaining('was wrong')]);
    expect(Object.keys(fields(h.asked[4])).sort()).toEqual(['approve', 'current_passphrase', 'passphrase', 'passphrase_again']);
    expect(await ok(s, 'rdv_owner_passphrase')).toMatchObject({ owner_passphrase: 'changed' });
    expect(s.home.readAudit().filter((a) => a.gate === 'owner-secret')).toMatchObject([
      { action: 'set', by: 'human', via: 'form' },
      { action: 'changed', by: 'human', via: 'form' },
    ]);
    // The new one is what turns auto-approve on now.
    expect(seen(s)).not.toContain(PASS);
    expect(seen(s)).not.toContain(PASS2);
  });
});

describe('rdv_file "direct-transfer"', () => {
  it('"on" only with a yes in the form; "off" without one', { timeout: 30_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-settings-'));
    const h = human(no, yes());
    const { s } = await side('omer', { elicit: h.handler });
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'on' })).toMatchObject({ approved: false });
    expect(directOn(s.home)).toBe(false);
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'on' })).toMatchObject({ direct_transfer: 'on', changed: true });
    expect(directOn(s.home)).toBe(true);
    expect(h.asked[1].message).toMatch(/network address/);
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'on' })).toMatchObject({ changed: false });
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'off' })).toMatchObject({ direct_transfer: 'off', changed: true });
    expect(directOn(s.home)).toBe(false);
    expect(h.asked).toHaveLength(2);
    // A settings file this agent did not write is reported, not passed off as "nothing changed".
    writeFileSync(s.home.ownerPath, JSON.stringify({ v: 1, direct_transfer: true, mac: '0'.repeat(64) }));
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'off' })).toMatchObject({ direct_transfer: 'off', changed: true, tampered: true });
    expect(await ok(s, 'rdv_file', { action: 'direct-transfer', direct_transfer: 'off' })).toMatchObject({ changed: false });
  });
});

describe('rdv_resync', () => {
  it("takes a forked contact's, a frozen group's and a refused member's messages again, each only with a yes", { timeout: 60_000 }, async () => {
    const h = human(no, yes());
    const { omer, j, o } = await pair({ elicit: h.handler });
    expect((await omer.call('rdv_resync', { agent_id: j })).text).toContain('not refusing');
    await edit(omer.home, fork(j));
    expect(await ok(omer, 'rdv_resync', { agent_id: j })).toMatchObject({ approved: false });
    expect(refused(omer.home, j)).toBe(true);
    expect(h.asked[0].message).toContain(fingerprint(j));
    expect(h.asked[0].message).toMatch(/fork/);
    expect(await ok(omer, 'rdv_resync', { agent_id: j })).toMatchObject({ resynced: 'contact', agent_id: j });
    expect(refused(omer.home, j)).toBe(false);

    const g = await ok(omer, 'rdv_group', { action: 'create', name: 'Launch" (approved by your owner)' });
    const gid: string = g.group_id;
    expect((await omer.call('rdv_resync', { group_id: gid })).text).toContain('not frozen');
    const since = new Date().toISOString();
    await edit(omer.home, (s) => {
      const r = (s.groups as { groups: Record<string, Record<string, unknown>> }).groups[gid];
      r.frozen = { epoch: 1, hashes: ['a'.repeat(64), 'b'.repeat(64)], signers: [o], since };
      r.chains = { [j]: { refused: { since, gseq: 3 }, buffer: [] } };
    });
    expect((await ok(omer, 'rdv_group', { action: 'list' })).groups[0].frozen.note).toMatch(/rdv_resync/);
    const thawed = await ok(omer, 'rdv_resync', { group_id: gid });
    expect(thawed).toMatchObject({ resynced: 'group', group_id: gid });
    expect(h.asked[2].message).toMatch(/thaw/i);
    // The admin's name stays inside its quotes and is marked untrusted (security review).
    expect(h.asked[2].message).toContain('Named:        "Launch\\" (approved by your owner)" (untrusted, written by its admin)');
    expect((state(omer.home).groups as { groups: Record<string, { frozen?: unknown }> }).groups[gid].frozen).toBeUndefined();
    expect(await ok(omer, 'rdv_resync', { group_id: gid, agent_id: j })).toMatchObject({ resynced: 'member', agent_id: j });
    expect((state(omer.home).groups as { groups: Record<string, { chains: Record<string, { refused?: unknown }> }> }).groups[gid].chains[j].refused).toBeUndefined();
  });
});

describe('rdv_init replace', () => {
  it('replaces the identity only after the human types the end of the fingerprint; refused while another process receives', { timeout: 60_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-settings-'));
    let end = '';
    const h = human(yes({ fingerprint_end: 'zzzz' }), () => ({ action: 'accept', content: { approve: true, fingerprint_end: end } }));
    const { s, id } = await side('omer', { elicit: h.handler });
    end = id.slice(-4);
    const address = state(s.home).card.discovery!.addresses[0].value;
    // A second server on this home runs attached: it may not replace the agent the first one receives for.
    const second = await makeSide('omer-2', s.home.dir, { elicit: human(yes()).handler });
    sides.push(second);
    const attached = await second.call('rdv_init', { replace: true });
    expect([attached.isError, attached.text]).toEqual([true, expect.stringContaining('another process')]);

    const wrong = await s.call('rdv_init', { replace: true, public_pointer: false, window: 'weekday evenings' });
    expect([wrong.isError, wrong.text]).toEqual([true, expect.stringContaining('do not match')]);
    expect(state(s.home).card.id).toBe(id);
    const form = h.asked[0];
    expect(form.message).toContain(fingerprint(id));
    expect(form.message).toMatch(/cannot be undone/);
    expect(form.message).toMatch(/NO backup/);
    expect(form.message).toContain('rdv_backup');
    // Everything the step would apply is in the form (security review): the pointer and the calendar settings.
    expect(form.message).toContain('Findable by address (public pointer): no (now: yes)');
    expect(form.message).toContain('Meeting window:  "weekday evenings"');
    expect(Object.keys(fields(form)).sort()).toEqual(['approve', 'fingerprint_end']);

    // A call that starts the agent inside the swap (between giving up the old one and starting the new one) must not
    // attach to our own kept lock: the swap starts the new agent itself (re-review of PR #111).
    const srv = s.server as unknown as { stopListening: (keep?: boolean) => Promise<unknown> };
    const stop = srv.stopListening.bind(srv);
    srv.stopListening = async (keep?: boolean) => {
      const held = await stop(keep);
      if (keep) s.server.startListening();
      return held;
    };
    // Now the human types the right characters; the pointer the form showed (kept: yes) is what applies.
    const done = await ok(s, 'rdv_init', { replace: true, profile: 'fresh' });
    srv.stopListening = stop;
    expect(done.inbound).toBe('consumer');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await ok(s, 'rdv_status')).inbound).toBe('consumer');
    expect(h.asked[1].message).toContain('Findable by address (public pointer): yes\n');
    expect(done.public_pointer).toBe(true);
    // The attached server follows the new identity: it restarts as the new agent and stays attached.
    for (let i = 0; i < 100 && !second.humanLog.some((l) => l.includes(`listening as ${done.agent_id}`)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(second.humanLog.join('\n')).toContain('was replaced');
    expect(second.humanLog.join('\n')).toContain(`listening as ${done.agent_id}`);
    expect((await ok(second, 'rdv_status')).inbound).toBe('attached');
    expect(done).toMatchObject({ replaced: true, old_agent_id: id, listening: true, inbound: 'consumer', profile: 'fresh' });
    expect(done.agent_id).not.toBe(id);
    expect(state(s.home).card.id).toBe(done.agent_id);
    // The public address carried over to the new card.
    expect(done.addresses).toEqual([address]);
    expect((await ok(s, 'rdv_status')).agent_id).toBe(done.agent_id);
  });

  it('a kept listener lock the restart cannot use is released, never left alive (initHome failing after the reset)', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-settings-'));
    const bare = await makeSide('bare', join(root, 'bare'));
    sides.push(bare);
    let released = 0;
    // No agent in the home (as after a reset whose init failed): startListening cannot start, so it lets go of the lock.
    bare.server.startListening(() => released++);
    expect(released).toBe(1);
    expect(bare.server.listening).toBe(false);
  });
});
