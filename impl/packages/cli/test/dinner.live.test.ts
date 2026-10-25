import { describe, expect, it } from 'vitest';
import { relaysFromEnv } from '../scenarios/contact.js';
import { runDinnerScenario } from '../scenarios/dinner.js';

// PLAN §5.3 on real relays. Only via `npm run test:live` with RDV_LIVE_RELAYS set.
const relays = relaysFromEnv();

describe.skipIf(relays.length === 0)('live relays: dinner', () => {
  it(`overlap scenario completes on ${relays.join(', ') || '(none)'}`, async () => {
    const r = await runDinnerScenario({ relays, variant: 'overlap', stepTimeoutMs: 45_000, log: (l) => console.log(l) });
    expect(r.omer.state).toBe('completed');
    expect(r.john.agreed).toEqual(r.omer.agreed);
    console.log(`agreed: ${JSON.stringify(r.omer.agreed)}; steps: ${JSON.stringify(r.steps)}`);
  });
});
