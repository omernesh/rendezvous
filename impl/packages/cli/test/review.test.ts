// Design A.9 (issue #30): the document review between two real `rdv`
// processes on the in-memory relay, all five variants.
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_TEXT, DOC_TEXT, REVIEW_DATA, REVIEW_TEXT, runReviewScenario } from '../scenarios/review.js';

describe('review scenario (in-memory relay)', () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  });
  afterAll(() => relay.close());

  const wireHolds = (...s: string[]) => {
    const wire = relay.events.map((e) => e.content).join('');
    return s.filter((x) => wire.includes(x));
  };

  it('ok: start gate, fetch and verify, release gate (an edit is a new draft), artifact, completed', async () => {
    const r = await runReviewScenario({ relays: [relay.url], variant: 'ok' });
    expect([r.omer, r.john]).toEqual(['completed', 'completed']);
    expect(r.artifact?.peer_text).toEqual([REVIEW_TEXT]);
    expect(r.artifact?.data).toEqual([REVIEW_DATA]);
    expect(r.fetched).toBe(1);
    expect(r.audit.map((a) => [a.gate, a.by])).toEqual([
      ['start', 'human'],
      ['release', 'human'],
    ]);
    // The relay only ever saw ciphertext: no request, document, review or verdict.
    expect(wireHolds('task/request', ASK_TEXT, DOC_TEXT, REVIEW_TEXT, 'changes-requested')).toEqual([]);
  });

  it('decline: rejected, nothing fetched', async () => {
    const r = await runReviewScenario({ relays: [relay.url], variant: 'decline' });
    expect([r.omer, r.john, r.fetched]).toEqual(['rejected', 'rejected', 0]);
    expect(r.audit.filter((a) => a.gate === 'start' && a.by !== 'human')).toEqual([]);
  });

  it("cancel: John cancels while Omer reads; Omer's code approves nothing", async () => {
    const r = await runReviewScenario({ relays: [relay.url], variant: 'cancel' });
    expect([r.omer, r.john, r.fetched]).toEqual(['canceled', 'canceled', 0]);
    expect(r.audit).toEqual([]);
  });

  it('rate: the sixth review in a day is rejected for rate, with no prompt', async () => {
    const r = await runReviewScenario({ relays: [relay.url], variant: 'rate' });
    expect(r.omer).toBe('rejected');
    expect(r.audit.filter((a) => a.gate === 'start')).toEqual([]); // five declines, nothing started
  });

  it('auto: auto-approve all passes both gates without asking, two audit lines', async () => {
    const r = await runReviewScenario({ relays: [relay.url], variant: 'auto' });
    expect([r.omer, r.john, r.fetched]).toEqual(['completed', 'completed', 1]);
    expect(r.artifact?.peer_text).toEqual([REVIEW_TEXT]);
    expect(r.audit.map((a) => [a.gate, a.action ?? a.by])).toEqual([
      ['auto-approve', 'set'],
      ['start', 'auto-approve'],
      ['release', 'auto-approve'],
    ]);
  });
});
