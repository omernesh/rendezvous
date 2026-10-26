// Design B.5 (issue #79, closes #31): Omer, John and Dana build a microsite,
// three real `rdv` processes on the in-memory relay.
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLAIM_TEXT, COPY_TASK, COPY_TEXT, REVIEW_TEXT, runMicrositeScenario } from '../scenarios/microsite.js';

let relay: TestRelay;
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(() => relay.close());

it('the microsite scenario passes on the in-memory relay', async () => {
  const r = await runMicrositeScenario({ relays: [relay.url] });
  expect(r.steps).toHaveLength(13);
  expect(r.copy.john.peer_text).toEqual([COPY_TEXT]);
  expect(r.review.dana.peer_text).toEqual([REVIEW_TEXT]);
  // Both boards agree on the two tasks' outcome.
  for (const b of [r.boards.omer, r.boards.dana]) {
    const byId = Object.fromEntries((b.tasks as Array<{ task: string; state: string }>).map((t) => [t.task, t.state]));
    expect(byId[r.copyTask]).toBe('completed');
    expect(byId[r.reviewTask]).toBe('completed');
  }
  // The relay only ever saw ciphertext: no task, offer, copy or review.
  const wire = relay.events.map((e) => e.content).join('');
  for (const s of ['task/request', 'task/claim', COPY_TASK, CLAIM_TEXT, COPY_TEXT, REVIEW_TEXT]) expect(wire).not.toContain(s);
}, 240_000);
