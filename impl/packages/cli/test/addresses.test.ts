import { startTestRelay } from '@rendezvous/core/testing';
import { expect, it } from 'vitest';
import { runAddressScenario } from '../scenarios/addresses.js';

// Real `rdv` processes on the in-memory relay: several addresses, one added,
// one private and one removed while `rdv listen` runs.
it('address scenario passes against the in-memory relay', async () => {
  const relay = await startTestRelay();
  try {
    const r = await runAddressScenario({ relays: [relay.url], stepTimeoutMs: 20_000 });
    expect(r.steps).toHaveLength(5);
    // The private address is on no published card (only John's probe for it names it).
    const cards = relay.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1].startsWith('rdv1/card:')));
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.map((e) => e.content).join('')).not.toContain('-private@example.com');
  } finally {
    await relay.close();
  }
});
