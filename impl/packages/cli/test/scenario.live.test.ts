import { describe, expect, it } from 'vitest';
import { relaysFromEnv, runContactScenario } from '../scenarios/contact.js';

// PLAN §4.5, runs 2 and 3: real relays. Only via `npm run test:live` with
// RDV_LIVE_RELAYS=wss://a,wss://b; never part of `npm test`.
const relays = relaysFromEnv();

describe.skipIf(relays.length === 0)('live relays', () => {
  it(`contact scenario passes on ${relays.join(', ') || '(none)'}`, async () => {
    const r = await runContactScenario({ relays, stepTimeoutMs: 45_000, log: (l) => console.log(l) });
    expect(r.steps).toHaveLength(5);
  });

  // Each relay on its own, so a single bad relay is visible.
  for (const relay of relays.length > 1 ? relays : []) {
    it(`contact scenario passes on ${relay} alone`, async () => {
      const r = await runContactScenario({ relays: [relay], stepTimeoutMs: 45_000 });
      expect(r.steps).toHaveLength(5);
    });
  }
});
