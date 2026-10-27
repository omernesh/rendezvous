// The owner's receipts opt-out (issue #104, NOTES 98, review of #112 L5):
// config.json "receipts": false takes the receipts capability off the card at
// the next refresh, so contacts stop waiting; turning it back on restores it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NostrTransport, RECEIPTS_EXTENSION, keyFromSecret, b64decode } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHome } from '../src/commands.js';
import { receiptsOff, receiptTiming } from '../src/delivery.js';
import { Home } from '../src/home.js';
import { hostCardCapabilities, refreshHostCard } from '../src/tasks.js';

describe('receipts opt-out (config.json)', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-receipts-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('"receipts": false drops the capability from the card; absent puts it back', async () => {
    const home = new Home(join(root, 'omer'));
    await initHome(home, { profile: 'omer', relays: [relay.url], emails: ['omer@example.com'] });
    expect(home.readAgentState().card.capabilities).toContain(RECEIPTS_EXTENSION);
    const key = keyFromSecret(b64decode(home.readAgentState().secretKey));
    const t = new NostrTransport({ key, relays: [relay.url] });
    try {
      home.writeConfig({ ...home.readConfig(), receipts: false });
      expect(receiptsOff(home)).toBe(true);
      expect((await refreshHostCard(home, hostCardCapabilities(), t)).refreshed).toBe(true);
      expect(home.readAgentState().card.capabilities).not.toContain(RECEIPTS_EXTENSION);
      expect((await refreshHostCard(home, hostCardCapabilities(), t)).refreshed).toBe(false); // nothing more to do
      const { receipts: _r, ...on } = home.readConfig();
      home.writeConfig(on);
      expect(receiptsOff(home)).toBe(false);
      expect((await refreshHostCard(home, hostCardCapabilities(), t)).refreshed).toBe(true);
      expect(home.readAgentState().card.capabilities).toContain(RECEIPTS_EXTENSION);
    } finally {
      t.close();
    }
  });

  it('the test timing turns the ack jitter off; the default keeps it', () => {
    expect(receiptTiming({}).ackJitterMs).toBeGreaterThan(0);
    expect(receiptTiming({ RDV_ACK_DELAY_MS: '50' })).toMatchObject({ ackDelayMs: 50, ackJitterMs: 0 });
  });
});
