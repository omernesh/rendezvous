import { describe, expect, it } from 'vitest';
import { runAddressScenario } from '../scenarios/addresses.js';
import { relaysFromEnv } from '../scenarios/contact.js';

// Only via `npm run test:live` with RDV_LIVE_RELAYS=wss://a,wss://b; never part of `npm test`.
const relays = relaysFromEnv();

describe.skipIf(relays.length === 0)('live relays', () => {
  it(`address scenario passes on ${relays.join(', ') || '(none)'}`, async () => {
    const r = await runAddressScenario({ relays, stepTimeoutMs: 45_000, quietMs: 5000, log: (l) => console.log(l) });
    expect(r.steps).toHaveLength(5);
  });
});
