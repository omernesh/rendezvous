// The two-MCP-server dinner flow against real relays (PLAN §6.1). Skips unless
// RDV_LIVE_RELAYS lists relays: RDV_LIVE_RELAYS=wss://relay.example npm run test:live
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confirmWithPhrase, dinnerFlow, makeSide, ok, phraseFromHumanLog } from './flow.js';

const relays = (process.env.RDV_LIVE_RELAYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

describe.skipIf(relays.length === 0)('rdv-mcp live', () => {
  it(`two MCP servers book dinner on ${relays.join(', ') || '(none)'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rdv-mcp-live-'));
    const omer = await makeSide('omer', join(root, 'omer'));
    const john = await makeSide('john', join(root, 'john'));
    const t0 = Date.now();
    try {
      const r = await dinnerFlow(omer, john, {
        relays,
        root,
        tag: randomBytes(4).toString('hex'),
        timeoutMs: 45_000,
        approve: async (j, requestId) => {
          expect((await j.call('rdv_grant', { request_id: requestId })).isError).toBe(true);
          await ok(j, 'rdv_grant', { request_id: requestId, confirm_phrase: phraseFromHumanLog(j, requestId) });
        },
        confirm: confirmWithPhrase,
      });
      console.log(`live: agreed ${r.agreed.start} in ${Date.now() - t0} ms`);
    } finally {
      await omer.close();
      await john.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
