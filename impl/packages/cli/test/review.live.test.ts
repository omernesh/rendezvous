import { describe, expect, it } from 'vitest';
import { relaysFromEnv } from '../scenarios/contact.js';
import { REVIEW_TEXT, REVIEW_VARIANTS, runReviewScenario } from '../scenarios/review.js';

// Design A.9 on real relays, every variant. Only via `npm run test:live` with RDV_LIVE_RELAYS set.
const relays = relaysFromEnv();
const want = { ok: 'completed', decline: 'rejected', cancel: 'canceled', rate: 'rejected', auto: 'completed' } as const;

describe.skipIf(relays.length === 0)('live relays: document review', () => {
  for (const variant of REVIEW_VARIANTS) {
    it(`${variant} on ${relays.join(', ') || '(none)'}`, async () => {
      const t0 = Date.now();
      const r = await runReviewScenario({ relays, variant, stepTimeoutMs: 45_000, log: (l) => console.log(l) });
      expect(r.omer).toBe(want[variant]);
      if (variant === 'ok' || variant === 'auto') expect(r.artifact?.peer_text).toEqual([REVIEW_TEXT]);
      console.log(`review ${variant}: ${Date.now() - t0} ms; steps: ${JSON.stringify(r.steps)}`);
    });
  }
});
