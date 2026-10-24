import { startTestRelay } from '@rendezvous/core/testing';
import { expect, it } from 'vitest';
import { runContactScenario } from '../scenarios/contact.js';

// PLAN §4.5, run 1 of 3: real `rdv` processes against the in-memory relay
// (a localhost WebSocket, no network beyond 127.0.0.1).
it('contact scenario passes against the in-memory relay', async () => {
  const relay = await startTestRelay();
  try {
    const r = await runContactScenario({ relays: [relay.url], stepTimeoutMs: 20_000 });
    expect(r.steps.map((s) => s.step)).toHaveLength(5);
    // The relay only ever saw ciphertext.
    expect(relay.events.map((e) => e.content).join('')).not.toContain('Thursday');
  } finally {
    await relay.close();
  }
});
