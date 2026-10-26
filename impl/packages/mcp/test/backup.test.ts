// rdv_backup (issue #88): the passphrase only in the approval form, never
// through the model, no phrase path; the restore form shows the identity
// before decrypting; after a restore, contacts are told and the conversation
// goes on.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { fingerprint } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side, waitEvent } from './flow.js';

const T = 15_000;
const PASS = 'correct horse battery staple 42';

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

/** The human's forms: what they were asked, and what they type (approve ticked unless `approve` is false). */
function human(answers: Array<Record<string, unknown>>) {
  const asked: Array<ElicitRequest['params']> = [];
  const handler = async (p: ElicitRequest['params']): Promise<ElicitResult> => {
    asked.push(p);
    const a = answers.length > 1 ? answers.shift()! : answers[0];
    return { action: 'accept', content: { approve: true, ...a } as never };
  };
  return { handler, asked };
}

/** Everything a model or a log could have seen on this side. */
const seen = (s: Side) => [s.transcript.join('\n'), s.humanLog.join('\n'), existsSync(s.home.eventsPath) ? readFileSync(s.home.eventsPath, 'utf8') : '', existsSync(s.home.auditPath) ? readFileSync(s.home.auditPath, 'utf8') : ''].join('\n');

describe('rdv_backup', () => {
  it('without an approval form it refuses and points to the terminal; a passphrase argument is ignored', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-backup-mcp-'));
    const plain = await makeSide('plain', join(root, 'plain'));
    sides.push(plain);
    await ok(plain, 'rdv_init', { profile: 'p', email: 'p@example.com', relays: [relay.url] });
    const file = join(root, 'p.rdvbackup');
    const r = await plain.call('rdv_backup', { action: 'create', path: file, passphrase: PASS });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rdv backup');
    expect(r.text).toMatch(/approval form/);
    expect(existsSync(file)).toBe(false);
    const rel = await plain.call('rdv_backup', { action: 'create', path: 'relative.rdvbackup' });
    expect([rel.isError, rel.text]).toEqual([true, expect.stringContaining('absolute path')]);
    const tools = (await plain.client.listTools()).tools;
    const props = Object.keys((tools.find((t) => t.name === 'rdv_backup')!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(['action', 'path']);
    expect(seen(plain)).not.toContain(PASS);
  });

  it('create asks twice in the form with a minimum strength; restore shows the identity, takes the passphrase once, and the contact follows the new chain', { timeout: 90_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-backup-mcp-'));
    const f = human([{ passphrase: PASS, passphrase_again: `${PASS}!` }, { passphrase: 'too short', passphrase_again: 'too short' }, { passphrase: PASS, passphrase_again: PASS }]);
    const omer = await makeSide('omer', join(root, 'omer'), { elicit: f.handler });
    const johnForms = human([{}]);
    const john = await makeSide('john', join(root, 'john'), { elicit: johnForms.handler });
    sides.push(omer, john);
    const o = await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer.bk@example.com', relays: [relay.url] });
    const j = await ok(john, 'rdv_init', { profile: 'john', email: 'john.bk@doe.com', relays: [relay.url], public_pointer: true });
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_discover', { address: 'john.bk@doe.com' });
    await ok(omer, 'rdv_request_contact', { target: j.agent_id });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
    await ok(john, 'rdv_grant', { request_id: req.request_id });
    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === j.agent_id, 'the grant', T);
    await ok(omer, 'rdv_send', { agent_id: j.agent_id, payload: { type: 'note', text: 'before' } });
    await waitEvent(john, (e) => e.type === 'message' && e.from === o.agent_id, 'before', T);

    const file = join(root, 'omer.rdvbackup');
    const mismatch = await omer.call('rdv_backup', { action: 'create', path: file });
    expect([mismatch.isError, mismatch.text]).toEqual([true, expect.stringContaining('did not match')]);
    const weak = await omer.call('rdv_backup', { action: 'create', path: file });
    expect([weak.isError, weak.text]).toEqual([true, expect.stringContaining('too weak')]);
    expect(existsSync(file)).toBe(false);
    const made = await ok(omer, 'rdv_backup', { action: 'create', path: file });
    expect(made).toMatchObject({ backup: 'written', file, agent_id: o.agent_id, fingerprint: fingerprint(o.agent_id), verified_agent_id_matches: true });
    const form = f.asked.at(-1)!;
    expect(form.message).toContain(o.agent_id);
    expect(form.message).toContain(fingerprint(o.agent_id));
    expect(form.message).toContain(file);
    expect(Object.keys((form.requestedSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['approve', 'passphrase', 'passphrase_again']);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(omer.home.readAgentState().secretKey);
    expect(omer.home.readAudit().filter((a) => a.gate === 'backup')).toMatchObject([{ action: 'create', via: 'mcp' }]);
    // Never over the file, and never a restore over this agent.
    expect((await omer.call('rdv_backup', { action: 'create', path: file })).text).toContain('already exists');
    const over = await omer.call('rdv_backup', { action: 'restore', path: file });
    expect([over.isError, over.text]).toEqual([true, expect.stringContaining('--replace')]);

    expect(seen(omer)).not.toContain(PASS);
    // Omer's disk dies. On a new machine his assistant restores, with his passphrase in the form.
    await omer.close();
    sides = sides.filter((s) => s !== omer);
    const nf = human([{ passphrase: 'correct horse battery staple 43' }, { passphrase: PASS }]);
    const fresh = await makeSide('omer-new', join(root, 'omer-new'), { elicit: nf.handler });
    sides.push(fresh);
    const wrong = await fresh.call('rdv_backup', { action: 'restore', path: file });
    expect([wrong.isError, wrong.text]).toEqual([true, expect.stringContaining('did not open')]);
    expect(fresh.home.initialized()).toBe(false);
    // The form showed who is in the file before anything was decrypted.
    expect(nf.asked[0].message).toContain(o.agent_id);
    expect(nf.asked[0].message).toContain(fingerprint(o.agent_id));
    expect(Object.keys((nf.asked[0].requestedSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['approve', 'passphrase']);
    const back = await ok(fresh, 'rdv_backup', { action: 'restore', path: file });
    expect(back).toMatchObject({ restored: true, agent_id: o.agent_id, contacts: 1 });

    const told = await waitEvent(john, (e) => e.type === 'contact_restored' && e.peer === o.agent_id, 'john is told', T);
    expect(told.fingerprint).toBe(fingerprint(o.agent_id));
    await waitEvent(fresh, (e) => e.type === 'restore_confirmed' && e.peer === j.agent_id, 'confirmed', T);
    expect((await ok(fresh, 'rdv_status')).restore).toMatchObject({ not_told_yet: [], not_confirmed_yet: [] });
    await ok(fresh, 'rdv_send', { agent_id: j.agent_id, payload: { type: 'note', text: 'after' } });
    const after = await waitEvent(john, (e) => e.type === 'message' && e.from === o.agent_id && JSON.stringify(e.payload).includes('after'), 'after', T);
    expect(after).toBeDefined();
    await ok(john, 'rdv_send', { agent_id: o.agent_id, payload: { type: 'note', text: 'reply' } });
    await waitEvent(fresh, (e) => e.type === 'message' && e.from === j.agent_id, 'reply', T);
    const inbox = (await ok(john, 'rdv_inbox', { since: 0, limit: 200 })).events as Array<{ type: string; reason?: string }>;
    expect(inbox.filter((e) => /fork/.test(JSON.stringify(e)))).toEqual([]);
    // The passphrase never reached a result, an event, a log or the audit, on either machine.
    for (const s of [fresh, john]) expect(seen(s)).not.toContain(PASS);
    expect(f.asked.length).toBe(3);
  });
});
