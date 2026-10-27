// Delivery receipts through rdv-mcp (issue #104, NOTES 98): rdv_send says a
// message is pending, rdv_status shows it delivered once the contact's
// listener confirms it, and a contact that stays away is reported as "not
// confirmed" in rdv_inbox, then "delivered after all" when it comes back.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, phraseFromHumanLog, type Side, waitEvent } from './flow.js';

let relay: TestRelay;
let root: string;
let sides: Side[] = [];
const saved = { delay: process.env.RDV_ACK_DELAY_MS, retry: process.env.RDV_RECEIPT_RETRY_MS };
beforeAll(async () => {
  relay = await startTestRelay();
  process.env.RDV_ACK_DELAY_MS = '50';
  process.env.RDV_RECEIPT_RETRY_MS = '150';
});
afterAll(async () => {
  await relay.close();
  for (const [k, v] of [['RDV_ACK_DELAY_MS', saved.delay], ['RDV_RECEIPT_RETRY_MS', saved.retry]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(async () => {
  for (const s of sides) await s.close();
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Omer and John, contacts (Omer asked by agent ID, John's human approved). */
async function contacts() {
  root = mkdtempSync(join(tmpdir(), 'rdv-receipts-'));
  const omer = await makeSide('omer', join(root, 'omer'));
  const john = await makeSide('john', join(root, 'john'));
  sides.push(omer, john);
  const tag = randomBytes(3).toString('hex');
  const o = await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
  const j = await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true });
  const omerId = o.agent_id as string;
  const johnId = j.agent_id as string;
  await ok(john, 'rdv_publish_card');
  await ok(omer, 'rdv_request_contact', { target: johnId });
  const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', 10_000);
  await ok(john, 'rdv_grant', { request_id: req.request_id, confirm_phrase: phraseFromHumanLog(john, req.request_id) });
  await waitEvent(omer, (e) => e.type === 'contact' && e.peer === johnId, 'the grant', 10_000);
  return { omer, john, omerId, johnId };
}

const deliveryOf = async (side: Side, peer: string) => ((await ok(side, 'rdv_status')).contacts as Array<{ agent_id: string; delivery: { state: string; summary: string } }>).find((c) => c.agent_id === peer)!.delivery;

async function until(cond: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('rdv-mcp delivery receipts (issue #104)', () => {
  it('rdv_send is pending until the contact confirms; rdv_status then says delivered', async () => {
    const { omer, john, omerId, johnId } = await contacts();
    const sent = await ok(omer, 'rdv_send', { agent_id: johnId, payload: { type: 'note', text: 'hello' } });
    expect(sent).toMatchObject({ sent: true, delivery: 'pending' });
    expect(sent.note).toContain('receipt');
    await waitEvent(john, (e) => e.type === 'message' && e.from === omerId, 'the message', 10_000);
    await until(async () => (await deliveryOf(omer, johnId)).state === 'delivered', 15_000, 'the receipt');
    expect((await deliveryOf(omer, johnId)).summary).toContain('confirmed delivered');
    // Receipts never reach the inbox as messages.
    const all = (await ok(omer, 'rdv_inbox', { since: 0 })).events as Array<{ type: string; payload?: { type?: string } }>;
    expect(all.some((e) => e.type === 'message')).toBe(false);
  }, 60_000);

  it('a contact that stays away is reported as not confirmed; when it is back, delivered after all', async () => {
    const { omer, john, johnId } = await contacts();
    await until(async () => (await deliveryOf(john, (await ok(omer, 'rdv_status')).agent_id)).state === 'delivered', 15_000, "the grant's receipt");
    await john.close(); // John's agent is offline: nothing confirms
    sides.splice(sides.indexOf(john), 1);
    await ok(omer, 'rdv_send', { agent_id: johnId, payload: { type: 'note', text: 'are you there?' } });
    const un = await waitEvent(omer, (e) => e.type === 'delivery_unconfirmed', 'delivery_unconfirmed', 30_000);
    expect(un).toMatchObject({ peer: johnId, messages: 1 });
    expect(un.next_step).toContain('not confirmed delivered');
    expect((await deliveryOf(omer, johnId)).state).toBe('not_confirmed');
    // John's agent comes back: it catches up from the relay and confirms.
    const back = await makeSide('john', join(root, 'john'));
    sides.push(back);
    const late = await waitEvent(omer, (e) => e.type === 'delivery_confirmed', 'delivery_confirmed', 30_000);
    expect(late).toMatchObject({ peer: johnId, messages: 1 });
    expect((await deliveryOf(omer, johnId)).state).toBe('delivered');
  }, 90_000);
});
