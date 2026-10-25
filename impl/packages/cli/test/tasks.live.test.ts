import { describe, expect, it } from 'vitest';
import { relaysFromEnv } from '../scenarios/contact.js';
import { RESULT_TEXT, runTaskScenario } from '../scenarios/tasks.js';

// tasks/v1 with both human gates on real relays. Only via `npm run test:live` with RDV_LIVE_RELAYS set.
const relays = relaysFromEnv();

describe.skipIf(relays.length === 0)('live relays: tasks', () => {
  it(`a request/v1 task completes on ${relays.join(', ') || '(none)'}`, async () => {
    const r = await runTaskScenario({ relays, stepTimeoutMs: 45_000, log: (l) => console.log(l) });
    expect(r.artifact.peer_text).toEqual([RESULT_TEXT]);
    expect([r.omer.state, r.john.state]).toEqual(['completed', 'completed']);
    console.log(`steps: ${JSON.stringify(r.steps)}`);
  });
});
