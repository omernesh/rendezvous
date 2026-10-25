// Design A.9 between two MCP servers on real relays (issue #30). Skips unless RDV_LIVE_RELAYS is set.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestFileServer } from '@rendezvous/core/testing';
import { describe, it } from 'vitest';
import { makeSide, reviewFlow } from './flow.js';

const relays = (process.env.RDV_LIVE_RELAYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

describe.skipIf(relays.length === 0)('rdv-mcp live: document review', () => {
  it(`two MCP servers run the A.9 review on ${relays.join(', ') || '(none)'}`, async () => {
    const store = await startTestFileServer();
    const root = mkdtempSync(join(tmpdir(), 'rdv-mcp-live-review-'));
    const omer = await makeSide('omer', join(root, 'omer'), { fileFetch: { ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] } });
    const john = await makeSide('john', join(root, 'john'));
    const t0 = Date.now();
    try {
      await reviewFlow(omer, john, { relays, root, store, tag: randomBytes(4).toString('hex'), timeoutMs: 45_000 });
      console.log(`live: mcp review completed in ${Date.now() - t0} ms`);
    } finally {
      await omer.close();
      await john.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
