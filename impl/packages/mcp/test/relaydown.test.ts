// A listening relay that stays down reaches the user (issue #87, NOTES 90):
// rdv_status relay_health shows down_since, and rdv_inbox gets relay_down,
// relays_degraded and relay_up, one each per outage. In-memory relays only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeSide, ok, type Side, waitEvent } from './flow.js';

let root: string;
const sides: Side[] = [];
const relays: TestRelay[] = [];
const saved = process.env.RDV_RELAY_DOWN_AFTER_MS;
beforeEach(() => {
  process.env.RDV_RELAY_DOWN_AFTER_MS = '300';
});
afterEach(async () => {
  if (saved === undefined) delete process.env.RDV_RELAY_DOWN_AFTER_MS;
  else process.env.RDV_RELAY_DOWN_AFTER_MS = saved;
  for (const s of sides.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('rdv-mcp: a listening relay goes down and comes back', () => {
  it('tells the model once per transition and shows down_since in rdv_status', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-mcp-down-'));
    const a = await startTestRelay();
    const b = await startTestRelay();
    relays.push(a, b);
    const omer = await makeSide('omer', join(root, 'omer'));
    sides.push(omer);
    await ok(omer, 'rdv_init', { profile: 'omer', email: 'omer@example.com', relays: [a.url, b.url] });
    const port = Number(new URL(a.url).port);

    await a.close();
    const down = await waitEvent(omer, (e) => e.type === 'relay_down', 'relay_down', 15_000);
    expect(down).toMatchObject({ relay: a.url, healthy_relays: 1, total_relays: 2 });
    expect(down.next_step).toContain('approval');
    const degraded = await waitEvent(omer, (e) => e.type === 'relays_degraded', 'relays_degraded', 5_000);
    expect(degraded).toMatchObject({ healthy_relays: 1, total_relays: 2 });

    const st = await ok(omer, 'rdv_status');
    const [sa, sb] = st.relay_health;
    expect(typeof sa.down_since).toBe('string');
    expect(sb.down_since).toBeNull();

    relays.push(await startTestRelay(port));
    const up = await waitEvent(omer, (e) => e.type === 'relay_up', 'relay_up', 20_000);
    expect(up).toMatchObject({ relay: a.url, healthy_relays: 2, total_relays: 2 });
    expect((await ok(omer, 'rdv_status')).relay_health[0].down_since).toBeNull();

    // Once each, however long the outage lasted.
    await new Promise((r) => setTimeout(r, 800));
    const all = (await ok(omer, 'rdv_inbox', { since: 0 })).events as Array<{ type: string }>;
    for (const type of ['relay_down', 'relays_degraded', 'relay_up']) expect(all.filter((e) => e.type === type)).toHaveLength(1);
  }, 60_000);
});
