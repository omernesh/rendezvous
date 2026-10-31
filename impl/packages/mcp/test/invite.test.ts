// Invite links from the chat (SPEC §5.2.3, NOTES 101): rdv_invite "create"
// behind an approval form, rdv_init with invite and rdv_accept_invite on the
// other side, and the inviter told with an invite_redeemed event.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newInviteSecret, parseInvite, inviteUrl } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ElicitHandler, makeSide, ok, type Side, waitEvent } from './flow.js';

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
  for (const s of sides) await s.close();
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A human who answers each form with the next answer (default: approve as shown). */
function human(...answers: Array<Record<string, unknown> | 'decline'>): { handler: ElicitHandler; asked: ElicitRequest['params'][] } {
  const asked: ElicitRequest['params'][] = [];
  return {
    asked,
    handler: (params) => {
      asked.push(params);
      const a = answers.shift() ?? {};
      if (a === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { approve: true, ...a } };
    },
  };
}

async function side(name: string, opts: { elicit?: ElicitHandler; formWaitMs?: number; strict?: boolean } = {}, init = true) {
  root ??= mkdtempSync(join(tmpdir(), 'rdv-invite-mcp-'));
  // The test relay is ws://127.0.0.1: allowed only through the test option (review of PR #120); `strict` leaves it out.
  const s = await makeSide(name, join(root, name), { ...opts, ...(opts.strict ? {} : { unsafeInviteRelays: [relay.url] }) });
  sides.push(s);
  if (init) await ok(s, 'rdv_init', { profile: name, email: `${name}+${randomBytes(3).toString('hex')}@example.com`, relays: [relay.url] });
  return s;
}

describe('invite links from the chat', () => {
  it('create (form) -> rdv_init with invite -> contact at once, the inviter told; reuse waits; list and revoke', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-invite-mcp-'));
    const h = human({ tier: 'colleague', label: 'Dana', expires_days: 3 });
    const omer = await side('omer', { elicit: h.handler });
    const made = await ok(omer, 'rdv_invite', { action: 'create', label: 'Dan', name: 'Omer' });
    // The form said what it does, and the human changed the tier, the label and the days.
    const msg = String(h.asked[0].message);
    expect(msg).toContain('Whoever opens this link first becomes your contact at once');
    expect(msg).toContain('send it only to the person you mean');
    expect(msg).toContain('Your name in the link: "Omer"');
    expect((h.asked[0].requestedSchema.properties.tier as { enum: string[] }).enum).toEqual(['friend', 'colleague', 'business', 'stranger']);
    expect(made).toMatchObject({ created: true, tier: 'colleague', local_label: 'Dana', name: 'Omer', may_propose_meetings: true });
    expect(Date.parse(made.expires) - Date.now()).toBeGreaterThan(3 * 86_400_000 - 60_000);
    expect(Date.parse(made.expires) - Date.now()).toBeLessThan(3 * 86_400_000 + 60_000);
    expect(made.share_text).toContain(made.url);
    const link = parseInvite(made.url, { unsafeAllowRelays: [relay.url] });
    expect(readFileSync(join(omer.home.dir, 'agent.json'), 'utf8')).not.toContain(link.secret);
    const omerId = (await ok(omer, 'rdv_status')).agent_id as string;

    // Dana's assistant: one call, with the link Dana pasted.
    const dana = await side('dana', {}, false);
    const init = await ok(dana, 'rdv_init', { profile: 'dana', relays: [relay.url], invite: `Accept this: ${made.url}`.slice('Accept this: '.length) });
    expect(init.created).toBe(true);
    expect(init.invite).toMatchObject({ to: omerId, name_in_link: { untrusted_peer_text: 'Omer' } });

    const red = await waitEvent(omer, (e) => e.type === 'invite_redeemed', 'invite_redeemed', 15_000);
    expect(red).toMatchObject({ invite_id: made.invite_id, peer: init.agent_id, local_label: 'Dana', tier: 'colleague' });
    expect(red.next_step).toContain('rdv_revoke');
    const c = await waitEvent(dana, (e) => e.type === 'contact' && e.peer === omerId, 'dana contact', 15_000);
    expect(c.local_label).toBeNull();
    await ok(dana, 'rdv_send', { agent_id: omerId, payload: { type: 'note', text: 'hi via invite' } });
    await waitEvent(omer, (e) => e.type === 'message' && e.from === init.agent_id, 'message', 10_000);

    // The same link again, by an agent that exists: an ordinary request for Omer's human.
    const eve = await side('eve');
    const again = await ok(eve, 'rdv_accept_invite', { invite: made.url });
    await waitEvent(omer, (e) => e.type === 'contact_request' && e.request_id === again.request_id, 'eve waits', 15_000);

    const list = await ok(omer, 'rdv_invite', { action: 'list' });
    expect(list.invites).toEqual([expect.objectContaining({ invite_id: made.invite_id, status: 'used', redeemed_by: init.agent_id, local_label: 'Dana' })]);
    expect(JSON.stringify(list)).not.toContain(link.secret);
    expect((await ok(omer, 'rdv_invite', { action: 'revoke', invite_id: made.invite_id })).note).toContain('already used');
    // The link is in the result once, never in the human log or later listings.
    expect(omer.humanLog.join('\n')).not.toContain(link.secret);
  }, 90_000);

  it('a decline makes nothing; without a form it is refused and names the terminal command; revoke, bad and own links', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-invite-mcp-'));
    const h = human('decline', {});
    const omer = await side('omer', { elicit: h.handler });
    expect(await ok(omer, 'rdv_invite', { action: 'create' })).toMatchObject({ approved: false, answer: 'declined' });
    expect((await ok(omer, 'rdv_invite', { action: 'list' })).invites).toEqual([]);

    const made = await ok(omer, 'rdv_invite', { action: 'create', may_propose_meetings: false });
    expect(made).toMatchObject({ tier: 'friend', may_propose_meetings: false });
    expect(await ok(omer, 'rdv_invite', { action: 'revoke', invite_id: made.invite_id })).toMatchObject({ status: 'revoked' });
    expect((await omer.call('rdv_invite', { action: 'revoke', invite_id: 'nope' })).text).toContain('no invite');
    const own = await omer.call('rdv_accept_invite', { invite: made.url });
    expect([own.isError, own.text]).toEqual([true, expect.stringContaining('your own')]);

    const plain = await side('plain');
    const refused = await plain.call('rdv_invite', { action: 'create' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('there is no confirm phrase for it');
    expect(refused.text).toContain('rdv invite create --tier friend');
    expect((await plain.call('rdv_invite', { action: 'create', tier: 'family' })).isError).toBe(true);

    // A revoked invite: the request waits for the human.
    const r = await ok(plain, 'rdv_accept_invite', { invite: made.url });
    await waitEvent(omer, (e) => e.type === 'contact_request' && e.request_id === r.request_id, 'request waits', 15_000);

    const bad = await plain.call('rdv_accept_invite', { invite: 'https://rendezvous.nesher.co/i#nope' });
    expect([bad.isError, bad.text]).toEqual([true, expect.stringContaining('not an invite')]);
    const expired = inviteUrl({ ...parseInvite(made.url, { unsafeAllowRelays: [relay.url] }), secret: newInviteSecret(), expires: new Date(Date.now() - 1000).toISOString() });
    expect((await plain.call('rdv_accept_invite', { invite: expired })).text).toContain('expired');
    // rdv_init with a bad link makes nothing.
    const fresh = await side('fresh', {}, false);
    expect((await fresh.call('rdv_init', { profile: 'fresh', relays: [relay.url], invite: 'nope' })).isError).toBe(true);
    expect(fresh.home.initialized()).toBe(false);

    // L4: without the test option, a link naming a ws:// (or local) relay is refused and nothing is made.
    const strict = await side('strict', { strict: true }, false);
    const strictInit = await strict.call('rdv_init', { profile: 'strict', relays: [relay.url], invite: made.url });
    expect([strictInit.isError, strictInit.text]).toEqual([true, expect.stringMatching(/not a usable invite link.*wss:\/\//)]);
    expect(strict.home.initialized()).toBe(false);
  }, 90_000);

  it('M1: approved after the call returned, the link is kept out of events.jsonl and handed to the asking client once', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-invite-mcp-'));
    const h = human({});
    const omer = await side('omer', { elicit: h.handler, formWaitMs: 0 });
    const asked = await ok(omer, 'rdv_invite', { action: 'create', label: 'Dana' });
    expect(asked).toMatchObject({ status: 'awaiting_human', via: 'approval form' });
    const ev = await waitEvent(omer, (e) => e.type === 'approval' && e.tool === 'rdv_invite', 'the approval', 15_000);
    expect(ev.outcome).toBe('decided');
    expect(ev.result).toMatchObject({ created: true, local_label: 'Dana' });
    expect(ev.result.url).toBeUndefined();
    expect(ev.result.share_text).toBeUndefined();
    expect(ev.held_for_you).toContain('rdv_invite action "link"');
    const got = await ok(omer, 'rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect(got.url).toMatch(/^https:\/\/rendezvous\.nesher\.co\/i#/);
    const secret = parseInvite(got.url, { unsafeAllowRelays: [relay.url] }).secret;
    expect(readFileSync(join(omer.home.dir, 'events.jsonl'), 'utf8')).not.toContain(got.url.split('#')[1]);
    expect(readFileSync(join(omer.home.dir, 'events.jsonl'), 'utf8')).not.toContain(secret);
    const again = await omer.call('rdv_invite', { action: 'link', approval_id: ev.approval_id });
    expect([again.isError, again.text]).toEqual([true, expect.stringContaining('nothing is held')]);
  }, 60_000);

  it('L3: the terminal command named without a form carries no text from the model', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-invite-mcp-'));
    const plain = await side('plain');
    const r = await plain.call('rdv_invite', { action: 'create', name: 'Omer $(touch pwned)', label: '`id` Dana', invoke: ['https://example.com/x;rm'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rdv invite create --tier friend');
    expect(r.text).toContain('--name "<your name>" --label "<their name>"');
    expect(r.text).toContain('--invoke <capability-uri>');
    expect(r.text).not.toMatch(/touch pwned|`id`|x;rm/);
    expect(plain.humanLog.join('\n')).not.toMatch(/touch pwned|`id`|x;rm/);
  }, 30_000);
});
