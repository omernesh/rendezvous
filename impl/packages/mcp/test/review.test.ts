// Design A.9 between two MCP servers on the in-memory relay (issue #30); the live run is review.live.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestFileServer, startTestRelay } from '@rendezvous/core/testing';
import { describe, expect, it } from 'vitest';
import { makeSide, reviewFlow } from './flow.js';

describe('document review between two MCP servers (design A.9)', () => {
  it("John's human releases the plan; Omer's human approves start and release by phrase; John gets the review", async () => {
    const relay = await startTestRelay();
    const store = await startTestFileServer();
    const root = mkdtempSync(join(tmpdir(), 'rdv-mcp-review-'));
    const omer = await makeSide('omer', join(root, 'omer'), { fileFetch: { ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] } });
    const john = await makeSide('john', join(root, 'john'));
    try {
      await reviewFlow(omer, john, { relays: [relay.url], root, store, timeoutMs: 15_000 });
      // The relay saw ciphertext only.
      expect(relay.events.map((e) => e.content).join('')).not.toMatch(/review\/result|task\/request|Q4 plan/);
    } finally {
      await omer.close();
      await john.close();
      await store.close();
      await relay.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
