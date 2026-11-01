// rdv_grant with agent_id (issue #1): the human grants an existing contact
// more rights towards them (Agent.allowInbound, which also sends a reverse
// grant), through the same gate as any grant. And rdv_publish_card /
// rdv_discover reading our own card back from the relays (issue #14).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentState } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { Home } from '@rendezvous/cli/lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rdvArgv } from '../../cli/scenarios/harness.js';
import { checkPhrase, inboundTarget, syncPhrases } from '../src/index.js';
import { type ElicitHandler, makeSide, ok, phraseFromHumanLog, phraseFromTerminal, type Side, TZ, waitEvent, WINDOW, writeCalendars } from './flow.js';

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

const SCOPE = { may_initiate: true, may_propose_meetings: true, may_access_calendar: 'free_busy', max_frequency: '100/day' } as const;
const PHRASE = /[a-z]+-[a-z]+-[a-z]+-\d{3}/;
const MEETINGS = 'https://rendezvous.nesher.co/ext/meetings/v1';
const REVIEW = 'https://rendezvous.nesher.co/ext/review/v1';
const OTHER = 'https://rendezvous.nesher.co/ext/request/v1';

/** What the human answers in each kind of form; `inbound` handles the new one. */
interface Human {
  inbound?: (params: { message: string; requestedSchema?: unknown }) => ElicitResult | Promise<ElicitResult>;
  forms: string[];
}

function human(h: Human): ElicitHandler {
  return async (params) => {
    if (params.message.includes('let this contact do more')) {
      h.forms.push(params.message);
      return h.inbound ? h.inbound(params as { message: string }) : { action: 'decline' };
    }
    return { action: 'accept', content: { approve: true } }; // contact approvals and dinner confirms
  };
}

/**
 * Omer requests John by address, John's human approves, Omer's human confirms
 * the answer: Omer holds John as a contact he requested, so John may write to
 * Omer but not propose meetings. Calendars are set so either side can negotiate.
 */
async function connected(forms: { omer?: Human; john?: Human } = {}) {
  root = mkdtempSync(join(tmpdir(), 'rdv-inbound-'));
  const omer = await makeSide('omer', join(root, 'omer'), forms.omer ? { elicit: human(forms.omer) } : {});
  const john = await makeSide('john', join(root, 'john'), forms.john ? { elicit: human(forms.john) } : {});
  sides.push(omer, john);
  const tag = randomBytes(3).toString('hex');
  const omerAt = `omer+${tag}@example.com`;
  const johnAt = `john+${tag}@doe.com`;
  const cal = { omer: join(root, 'omer-cal.json'), john: join(root, 'john-cal.json') };
  writeCalendars(cal.omer, cal.john);
  const o = await ok(omer, 'rdv_init', { profile: 'omer', email: omerAt, relays: [relay.url], calendar: cal.omer, window: WINDOW, tz: TZ });
  const j = await ok(john, 'rdv_init', { profile: 'john', email: johnAt, relays: [relay.url], calendar: cal.john, window: WINDOW, tz: TZ });
  await new Promise((r) => setTimeout(r, 300));
  await ok(omer, 'rdv_request_contact', { target: johnAt });
  const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', 10_000);
  await ok(john, 'rdv_grant', forms.john ? { request_id: req.request_id } : { request_id: req.request_id, confirm_phrase: phraseFromHumanLog(john, req.request_id) });
  const cand = await waitEvent(omer, (e) => e.type === 'contact_candidate', 'the probe answer', 10_000);
  await ok(omer, 'rdv_grant', forms.omer ? { grant_id: cand.grant_id } : { grant_id: cand.grant_id, confirm_phrase: phraseFromHumanLog(omer, cand.grant_id) });
  const theirs = (await ok(omer, 'rdv_status')).contacts.find((c: { agent_id: string }) => c.agent_id === j.agent_id);
  expect(theirs.their_rights).toContain('may not propose meetings');
  expect(theirs.their_rights).toContain('rdv_grant with agent_id');
  return { omer, john, o, j, omerAt, johnAt };
}

const rightsOf = async (side: Side, peer: string) =>
  (await ok(side, 'rdv_status')).contacts.find((c: { agent_id: string }) => c.agent_id === peer).their_rights as string;

/** Stand-in for the contact being replaced under the same agent ID after the human reviewed it (revoked and made again). */
async function remake(home: Home, peer: string): Promise<() => Promise<void>> {
  let since = '';
  await home.locked(async () => {
    const state = home.readAgentState() as AgentState;
    since = state.book.contacts[peer].since;
    state.book.contacts[peer].since = new Date(Date.parse(since) + 1000).toISOString();
    home.writeAgentState(state);
  });
  return () =>
    home.locked(async () => {
      const state = home.readAgentState() as AgentState;
      state.book.contacts[peer].since = since;
      home.writeAgentState(state);
    });
}

describe('rdv_grant agent_id: grant an existing contact more (issue #1)', () => {
  it('by form: shows the contact and the terms, the human decides, a swapped contact is refused, and the grantor then books dinner over MCP', async () => {
    const h: Human = { forms: [] };
    let whileOpen: (() => Promise<void>) | undefined;
    const { omer, john, o, j, johnAt } = await connected({ omer: h, john: { forms: [] } });

    // John (who granted Omer's request) may not propose to Omer yet.
    const early = await john.call('rdv_negotiate', { agent_id: o.agent_id });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('may_propose_meetings');

    // Declined or left unchecked: nothing changes, nothing is sent.
    // A no is a plain result, not an error (issue #64).
    const no = await omer.call('rdv_grant', { agent_id: j.agent_id });
    expect([no.isError, no.json.approved, no.json.answer]).toEqual([false, false, 'declined']);
    expect(no.text).toContain('declined in the approval form');
    h.inbound = () => ({ action: 'accept', content: { approve: false } });
    const unticked = await omer.call('rdv_grant', { agent_id: j.agent_id });
    expect([unticked.isError, unticked.json.approved, unticked.json.answer]).toEqual([false, false, 'left unticked']);
    expect(await rightsOf(omer, j.agent_id)).toContain('default');
    expect(h.forms[0]).toContain(`Fingerprint: ${j.fingerprint}`);
    expect(h.forms[0]).toContain(`Your local label: "${johnAt}"`);
    expect(h.forms[0]).toContain('Now: default rights');
    expect(h.forms[0]).toContain('MAY propose meetings to you');
    expect(h.forms[0]).toContain('tier "stranger"');

    // The human approves what they saw, but the contact is replaced under the same ID before the grant runs: refused.
    h.inbound = async () => {
      await whileOpen?.();
      return { action: 'accept', content: { approve: true, tier: 'friend' } };
    };
    let undo: (() => Promise<void>) | undefined;
    whileOpen = async () => {
      undo = await remake(omer.home, j.agent_id);
    };
    const swapped = await omer.call('rdv_grant', { agent_id: j.agent_id });
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toContain('changed since your user reviewed it');
    expect(await rightsOf(omer, j.agent_id)).toContain('default');
    whileOpen = undefined;
    await undo!();

    // Approved: the human's tier wins over the model's.
    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, tier: 'business' });
    expect(granted).toMatchObject({ granted: true, agent_id: j.agent_id, tier: 'friend', local_label: johnAt, scope: { may_propose_meetings: true } });
    expect(await rightsOf(omer, j.agent_id)).toBe('granted by your user');
    const rev = await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id, 'the reverse grant', 10_000);
    expect(rev).toMatchObject({ may_propose_meetings: true, their_tier_for_you: 'friend' });

    // The grantor now proposes a dinner over MCP; each human confirms in a form; it completes on both sides.
    const n = await ok(john, 'rdv_negotiate', { agent_id: o.agent_id, area: 'Tel Aviv' });
    const dinner = (kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'dinner' && e.task_id === n.task_id && e.kind === kind;
    await waitEvent(omer, dinner('confirm-needed'), 'confirm-needed (omer)', 15_000);
    await ok(omer, 'rdv_negotiate', { action: 'confirm', task_id: n.task_id });
    await waitEvent(john, dinner('confirm-needed'), 'confirm-needed (john)', 15_000);
    await ok(john, 'rdv_negotiate', { action: 'confirm', task_id: n.task_id });
    await waitEvent(john, dinner('completed'), 'completed (john)', 15_000);
    await waitEvent(omer, dinner('completed'), 'completed (omer)', 15_000);
  });

  it('by phrase: the model alone is refused; wrong, replaced or other-terms phrases are refused; the phrase the human typed works once', async () => {
    const { omer, john, o, j } = await connected();
    const asks = () => omer.humanLog.filter((l) => l.includes('asks to grant your contact') && l.includes(j.agent_id));

    const solo = await omer.call('rdv_grant', { agent_id: j.agent_id });
    expect(solo.isError).toBe(true);
    expect(solo.text).toContain('rdv contact pending');
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).toContain('tier stranger, may propose meetings');
    const first = phraseFromHumanLog(omer, j.agent_id);
    // Asking again for the same terms issues no new phrase.
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id })).isError).toBe(true);
    expect(asks()).toHaveLength(1);

    // A guess: refused, a try counted.
    const guess = await omer.call('rdv_grant', { agent_id: j.agent_id, confirm_phrase: 'amber-anchor-apple-123' });
    expect(guess.text).toContain('tries left');
    // The human's phrase with other terms than they were shown: refused, and the human is shown a phrase for those.
    const other = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: first });
    expect(other.text).toContain('does not approve these terms (tier friend');
    expect(asks().at(-1)).toContain('tier friend, may propose meetings');
    const forFriend = phraseFromHumanLog(omer, j.agent_id);
    expect(forFriend).not.toBe(first);
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: first })).isError).toBe(true);
    expect(await rightsOf(omer, j.agent_id)).toContain('default');

    // The terminal shows the human the current phrase and what it approves; the one shown before is replaced.
    const text = execFileSync(process.execPath, rdvArgv(['contact', 'pending', '--home', omer.home.dir]), { encoding: 'utf8' });
    expect(text).toContain(`your assistant asks to grant contact ${j.agent_id}`);
    expect(text).toContain('it approves: tier friend, may propose meetings');
    const shown = phraseFromTerminal(text, j.agent_id);
    const stale = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: forFriend });
    expect(stale.text).toContain('replaced by a newer one');
    expect(readFileSync(omer.home.consentPath, 'utf8')).not.toMatch(PHRASE);

    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: shown });
    expect(granted).toMatchObject({ granted: true, tier: 'friend', scope: { may_propose_meetings: true } });
    await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id && e.may_propose_meetings === true, 'the reverse grant', 10_000);
    // Used up: the same phrase approves nothing again.
    expect(Object.keys(omer.home.readConsent()).some((k) => k.startsWith('inbound:'))).toBe(false);
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: shown })).isError).toBe(true);
    // Nothing the model saw holds a phrase.
    for (const p of [first, forFriend, shown]) expect(omer.transcript.join('\n')).not.toContain(p);
    expect(omer.transcript.join('\n')).not.toMatch(PHRASE);
  });

  it('invoke (issue #23): the phrase is bound to the exact capability list, an altered list is refused, and the reverse grant carries it', async () => {
    const { omer, john, o, j } = await connected();
    const asks = () => omer.humanLog.filter((l) => l.includes('asks to grant your contact') && l.includes(j.agent_id));
    // Not a capability URI, a wildcard, meetings through invoke, invoke on a probe answer: refused, no phrase issued.
    for (const invoke of [['review'], ['https://rendezvous.nesher.co/ext/*'], ['http://example.com/ext/x/v1'], [MEETINGS]]) {
      const r = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke });
      expect(r.isError, invoke[0]).toBe(true);
      expect(r.text).toMatch(/capability URI|may_propose_meetings/);
    }
    expect((await omer.call('rdv_grant', { grant_id: crypto.randomUUID(), invoke: [REVIEW] })).text).toContain('invoke goes with');
    expect(asks()).toHaveLength(0);

    // Asked for review/v1: the human is shown exactly that list, with the phrase for it.
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW] })).isError).toBe(true);
    expect(asks().at(-1)).toContain(`tier friend, may propose meetings, may invoke ${REVIEW}`);
    const forReview = phraseFromHumanLog(omer, j.agent_id);
    // The same phrase with one more capability, or with none: refused, and a phrase for exactly that list goes to the human.
    const wider = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW, OTHER], confirm_phrase: forReview });
    expect(wider.isError).toBe(true);
    expect(wider.text).toContain('does not approve these terms');
    expect(asks().at(-1)).toContain(`may invoke ${OTHER} ${REVIEW}`);
    expect(await rightsOf(omer, j.agent_id)).toContain('default');
    const forWider = phraseFromHumanLog(omer, j.agent_id);
    const narrower = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', confirm_phrase: forWider });
    expect(narrower.text).toContain('does not approve these terms');
    const forNone = phraseFromHumanLog(omer, j.agent_id);
    // Ask for review/v1 again: the phrase for exactly that list is the one that works.
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], confirm_phrase: forNone })).isError).toBe(true);
    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], confirm_phrase: phraseFromHumanLog(omer, j.agent_id) });
    expect(granted.scope).toMatchObject({ may_propose_meetings: true, invoke: { [REVIEW]: {}, [MEETINGS]: {} } });
    expect(Object.keys(granted.scope.invoke)).not.toContain(OTHER);
    expect(granted.next).toContain(REVIEW);
    const rev = await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id, 'the reverse grant', 10_000);
    expect(rev.may_propose_meetings).toBe(true);
    expect(rev.invoke).toContain(REVIEW);
    expect(rev.invoke).not.toContain(OTHER);
    // Omer's rights towards John are John's own grant still: John's form-less status shows the default grant.
    const status = (await ok(omer, 'rdv_status')).contacts.find((c: { agent_id: string }) => c.agent_id === j.agent_id);
    expect(status.their_rights).toBe('granted by your user');
  });

  it('invoke by form: the form names the capabilities, and unchecking them grants none', async () => {
    const h: Human = { forms: [] };
    const { omer, john, o, j } = await connected({ omer: h, john: { forms: [] } });
    let schema: { properties?: Record<string, { title?: string; description?: string }> } | undefined;
    h.inbound = (params) => {
      schema = params.requestedSchema as typeof schema;
      return { action: 'accept', content: { approve: true, tier: 'friend', allow_invoke: false } };
    };
    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, invoke: [REVIEW] });
    expect(h.forms[0]).toContain(`may also invoke: ${REVIEW}`);
    expect(schema?.properties?.allow_invoke?.description).toContain(REVIEW);
    expect(Object.keys(granted.scope.invoke)).not.toContain(REVIEW);
    const rev = await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id, 'the reverse grant', 10_000);
    expect(rev.invoke).not.toContain(REVIEW);
  });

  it('by phrase: a contact replaced after the phrase was shown is refused, and the human gets a new phrase', async () => {
    const { omer, j } = await connected();
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id })).isError).toBe(true);
    const shown = phraseFromHumanLog(omer, j.agent_id);
    await remake(omer.home, j.agent_id);
    const r = await omer.call('rdv_grant', { agent_id: j.agent_id, confirm_phrase: shown });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('changed');
    expect(omer.humanLog.at(-1)).toContain('the contact CHANGED since its last confirm phrase');
    expect(await rightsOf(omer, j.agent_id)).toContain('default');
    expect(await ok(omer, 'rdv_grant', { agent_id: j.agent_id, confirm_phrase: phraseFromHumanLog(omer, j.agent_id) })).toMatchObject({ granted: true });
  });

  it('refuses a non-contact, a label, and two targets; issues no phrase for them', async () => {
    const { omer, o } = await connected();
    const before = omer.humanLog.length;
    for (const agent_id of [o.agent_id, `rdv1:${'a'.repeat(52)}`, '__proto__', 'constructor', 'not-an-id']) {
      const r = await omer.call('rdv_grant', { agent_id });
      expect(r.isError, agent_id).toBe(true);
      expect(r.text).toContain('no active contact');
    }
    expect((await omer.call('rdv_grant', { agent_id: o.agent_id, label: 'john@doe.com' })).text).toContain('label goes with');
    expect((await omer.call('rdv_grant', { agent_id: o.agent_id, request_id: 'x' })).text).toContain('exactly one of');
    expect(omer.humanLog.slice(before).filter((l) => PHRASE.test(l))).toEqual([]);
  });

  it('the phrase functions bind the contact and the terms; a tampered entry approves nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-inbound-phrase-'));
    const home = new Home(root);
    home.ensureDir();
    const c = { peer: 'rdv1:john', grantId: 'g1', binding: 'claimed', since: '2026-10-25T10:00:00Z', label: 'john@doe.com' } as never;
    const [issued] = syncPhrases(home, [inboundTarget(c, 'stranger', SCOPE)]);
    expect(checkPhrase(home, inboundTarget(c, 'friend', SCOPE), issued.phrase)).toMatchObject({ ok: false, reason: 'terms' });
    expect(checkPhrase(home, inboundTarget(c, 'stranger', { ...SCOPE, may_propose_meetings: false }), issued.phrase)).toMatchObject({ ok: false, reason: 'terms' });
    // Bound to the capability list too (issue #23): adding one is other terms.
    expect(checkPhrase(home, inboundTarget(c, 'stranger', { ...SCOPE, invoke: { [REVIEW]: {} } }), issued.phrase)).toMatchObject({ ok: false, reason: 'terms' });
    for (const other of [{ grantId: 'g2' }, { since: '2026-10-25T11:00:00Z' }, { label: 'mallory@example.com' }]) {
      expect(checkPhrase(home, inboundTarget({ ...(c as object), ...other } as never, 'stranger', SCOPE), issued.phrase)).toMatchObject({ ok: false, reason: 'changed' });
    }
    // Another action under the same ID is never approved by it.
    expect(checkPhrase(home, { action: 'request', id: 'rdv1:john', digest: issued.digest }, issued.phrase)).toMatchObject({ ok: false, reason: 'no-phrase' });
    expect(checkPhrase(home, inboundTarget(c, 'stranger', SCOPE), issued.phrase).ok).toBe(true);
    // Terms edited on disk (to friend) no longer hash to the digest; a label on an inbound entry is never valid.
    for (const edit of [{ terms: { tier: 'friend', scope: SCOPE } }, { label: 'x' }, { terms: undefined }]) {
      const consent = home.readConsent();
      home.writeConsent({ 'inbound:rdv1:john': { ...consent['inbound:rdv1:john'], ...edit } as never });
      expect(checkPhrase(home, inboundTarget(c, 'stranger', SCOPE), issued.phrase)).toMatchObject({ ok: false, reason: 'no-phrase' });
      syncPhrases(home, [inboundTarget(c, 'stranger', SCOPE)]);
    }
  });
});

describe('our own published card (issue #14)', () => {
  it('rdv_publish_card and rdv_discover on our own address read our card back; it is never a discovered peer', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-own-card-'));
    const omer = await makeSide('omer', join(root, 'omer'));
    const john = await makeSide('john', join(root, 'john'));
    sides.push(omer, john);
    const tag = randomBytes(3).toString('hex');
    const omerAt = `omer+${tag}@example.com`;
    const johnAt = `john+${tag}@doe.com`;
    const o = await ok(omer, 'rdv_init', { profile: 'omer', email: omerAt, relays: [relay.url], public_pointer: true });
    await ok(john, 'rdv_init', { profile: 'john', email: johnAt, relays: [relay.url], public_pointer: true });

    // Before publishing, nothing is on the relay.
    expect(await ok(omer, 'rdv_discover', { address: omerAt })).toMatchObject({ own_card_on_relays: false, found: 0 });
    const pub = await ok(omer, 'rdv_publish_card');
    expect(pub.on_relays).toEqual([{ address: omerAt, served: true }]);
    const own = await ok(omer, 'rdv_discover', { address: omerAt });
    expect(own).toMatchObject({ own_card_on_relays: true, found: 0, cards: [] });
    // Someone else's address: no own_card field, and other cards are found as before.
    await ok(john, 'rdv_publish_card');
    const other = await ok(omer, 'rdv_discover', { address: johnAt });
    expect(other).not.toHaveProperty('own_card_on_relays');
    expect(other.found).toBe(1);
    // John sees Omer's card as a peer card.
    expect((await ok(john, 'rdv_discover', { address: omerAt })).cards[0].agent_id).toBe(o.agent_id);

    // A newer card that no longer claims an address is not "our card" on that address's topic any more.
    const added = `omer-work+${tag}@example.com`;
    await ok(omer, 'rdv_addresses', { action: 'add', address: added, public: true });
    const pub2 = await ok(omer, 'rdv_publish_card');
    expect(pub2.on_relays).toEqual(expect.arrayContaining([{ address: omerAt, served: true }, { address: added, served: true }]));
  });
});

describe('rdv_grant limits: per-capability limits from MCP (issue #63), enforced on meetings (issue #41)', () => {
  const LIMITS = { [MEETINGS]: { max_frequency: '1/day' }, [REVIEW]: { max_frequency: '5/day', max_open: 2 } };

  it('by phrase: limits are checked, shown to the human and bound to the phrase; a meeting proposal over the limit is declined (rate)', async () => {
    const { omer, john, o, j } = await connected();
    const asks = () => omer.humanLog.filter((l) => l.includes('asks to grant your contact') && l.includes(j.agent_id));
    // Malformed, or for a capability the grant does not allow: refused, no phrase issued.
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ invoke: [REVIEW], limits: { [OTHER]: { max_frequency: '1/day' } } }, /only for capabilities this grant allows/],
      [{ limits: { [MEETINGS]: { max_frequency: 'lots' } } }, /max_frequency must be/],
      [{ limits: { [MEETINGS]: { max_frequency: '3/week' } } }, /max_frequency must be/],
      [{ limits: { [MEETINGS]: { max_open: 0 } } }, /max_open must be/],
      [{ limits: { [MEETINGS]: { max_open: 33 } } }, /max_open must be/],
      [{ may_propose_meetings: false, limits: { [MEETINGS]: { max_frequency: '1/day' } } }, /may_propose_meetings: true/],
      [{ limits: { [MEETINGS]: { max_frequency: '1/day', auto_approve: true } } }, /./],
    ];
    for (const [args, why] of bad) {
      const r = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(why);
    }
    expect((await omer.call('rdv_grant', { grant_id: crypto.randomUUID(), limits: LIMITS })).text).toContain('limits go with');
    expect(asks()).toHaveLength(0);

    // Asked with limits: the human is shown each one with its capability, and the phrase is for exactly those.
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], limits: LIMITS })).isError).toBe(true);
    expect(asks().at(-1)).toContain(`tier friend, may propose meetings (at most 1/day), may invoke ${REVIEW} (at most 5/day, 2 open at once)`);
    const forLimits = phraseFromHumanLog(omer, j.agent_id);
    // The same phrase with a looser limit, or none: refused, and the human gets a phrase for what was asked.
    const looser = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], limits: { ...LIMITS, [MEETINGS]: { max_frequency: '10/day' } }, confirm_phrase: forLimits });
    expect(looser.text).toContain('does not approve these terms');
    expect(asks().at(-1)).toContain('may propose meetings (at most 10/day)');
    const none = await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], confirm_phrase: phraseFromHumanLog(omer, j.agent_id) });
    expect(none.text).toContain('does not approve these terms');
    expect(await rightsOf(omer, j.agent_id)).toContain('default');
    expect((await omer.call('rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], limits: LIMITS, confirm_phrase: phraseFromHumanLog(omer, j.agent_id) })).isError).toBe(true);
    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, tier: 'friend', invoke: [REVIEW], limits: LIMITS, confirm_phrase: phraseFromHumanLog(omer, j.agent_id) });
    expect(granted.scope.invoke).toMatchObject({ [MEETINGS]: { max_frequency: '1/day' }, [REVIEW]: { max_frequency: '5/day', max_open: 2 } });
    await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id && e.may_propose_meetings === true, 'the reverse grant', 10_000);

    // Issue #41: the first proposal in the day is taken; the second is declined at once, and nothing is held for it.
    const first = await ok(john, 'rdv_negotiate', { agent_id: o.agent_id });
    await waitEvent(omer, (e) => e.type === 'dinner' && e.task_id === first.task_id && e.kind === 'confirm-needed', 'confirm-needed (omer)', 15_000);
    const second = await ok(john, 'rdv_negotiate', { agent_id: o.agent_id });
    const refused = await waitEvent(omer, (e) => e.type === 'dinner' && e.task_id === second.task_id && e.kind === 'refused', 'refused (omer)', 15_000);
    expect(refused.summary).toContain('limits your user set');
    const declined = await waitEvent(john, (e) => e.type === 'dinner' && e.task_id === second.task_id && e.kind === 'rejected', 'rejected (john)', 15_000);
    expect(declined.reason).toEqual({ untrusted_peer_text: expect.stringMatching(/^rate: over this capability's max_frequency \(1\/day\)/) });
    expect(Object.keys(omer.home.readNegotiations().tasks)).toEqual([first.task_id]);
    expect(await rightsOf(omer, j.agent_id)).toBe('granted by your user'); // one refusal does not revoke
  });

  it('by form: every limit is a field the human can change or clear, and what they leave is what is granted', async () => {
    const h: Human = { forms: [] };
    const { omer, j } = await connected({ omer: h, john: { forms: [] } });
    let schema: { properties?: Record<string, { title?: string; description?: string; default?: unknown; type?: string }> } | undefined;
    h.inbound = (params) => {
      schema = params.requestedSchema as typeof schema;
      return { action: 'accept', content: { approve: true, tier: 'friend', limit_frequency_0: '2/hour', limit_open_0: 3, limit_frequency_1: '' } };
    };
    const granted = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, invoke: [REVIEW], limits: { [REVIEW]: { max_frequency: '5/day' } } });
    expect(h.forms[0]).toContain(`may also invoke: ${REVIEW} (at most 5/day)`);
    expect(schema?.properties?.limit_frequency_0).toMatchObject({ type: 'string', default: '' });
    expect(schema?.properties?.limit_frequency_0?.title).toContain('Dinner proposals');
    expect(schema?.properties?.limit_open_0).toMatchObject({ type: 'integer' });
    expect(schema?.properties?.limit_frequency_1).toMatchObject({ default: '5/day' });
    expect(schema?.properties?.limit_frequency_1?.description).toContain(REVIEW);
    // The human's answer, not the model's proposal: meetings limited, review's frequency cleared.
    expect(granted.scope.invoke[MEETINGS]).toEqual({ max_frequency: '2/hour', max_open: 3 });
    expect(granted.scope.invoke[REVIEW]).toEqual({});

    // A limit the human typed that does not parse approves nothing.
    h.inbound = () => ({ action: 'accept', content: { approve: true, limit_frequency_0: 'lots' } });
    const bad = await omer.call('rdv_grant', { agent_id: j.agent_id, invoke: [REVIEW] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('rate limit: write it like 3/day (per minute, hour or day), or leave it blank for no limit. Nothing was done yet');
    // Unticking meetings drops their limits with them; a field the client does not send keeps what was shown.
    h.inbound = () => ({ action: 'accept', content: { approve: true, tier: 'friend', may_propose_meetings: false, limit_frequency_0: '1/day' } });
    const noMeet = await ok(omer, 'rdv_grant', { agent_id: j.agent_id, invoke: [REVIEW], limits: { [REVIEW]: { max_open: 1 } } });
    expect(Object.keys(noMeet.scope.invoke)).toEqual([REVIEW]);
    expect(noMeet.scope.invoke[REVIEW]).toEqual({ max_open: 1 });
  });

  it('request_id: the phrase approves the request with exactly the limits it was shown with', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-limits-'));
    const omer = await makeSide('omer', join(root, 'omer'));
    const john = await makeSide('john', join(root, 'john'));
    sides.push(omer, john);
    const tag = randomBytes(3).toString('hex');
    const johnAt = `john+${tag}@doe.com`;
    await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
    await ok(john, 'rdv_init', { profile: 'john', email: johnAt, relays: [relay.url] });
    await new Promise((r) => setTimeout(r, 300));
    await ok(omer, 'rdv_request_contact', { target: johnAt });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', 10_000);
    const byDefault = phraseFromHumanLog(john, req.request_id);
    const asked = await john.call('rdv_grant', { request_id: req.request_id, tier: 'friend', limits: { [MEETINGS]: { max_frequency: '2/day', max_open: 1 } }, confirm_phrase: byDefault });
    expect(asked.text).toContain('does not approve these terms');
    expect(john.humanLog.filter((l) => l.includes(req.request_id)).at(-1)).toContain('may propose meetings (at most 2/day, 1 open at once)');
    const granted = await ok(john, 'rdv_grant', {
      request_id: req.request_id,
      tier: 'friend',
      limits: { [MEETINGS]: { max_frequency: '2/day', max_open: 1 } },
      confirm_phrase: phraseFromHumanLog(john, req.request_id),
    });
    expect(granted.scope.invoke[MEETINGS]).toEqual({ max_frequency: '2/day', max_open: 1 });
  });
});
