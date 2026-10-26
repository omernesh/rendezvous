// Listening-link state of the Nostr transport (NOTES 90): a dropped relay is
// recorded as down_since and cleared when it returns; no network.
import { afterEach, describe, expect, it } from 'vitest';
import { generateKey, NostrTransport, type NostrTransportOptions, type RelayLink, type RelayStatus } from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close();
});

async function relay(port = 0): Promise<TestRelay> {
  const r = await startTestRelay(port);
  open.push(r);
  return r;
}

function transport(relays: string[], opts: Partial<NostrTransportOptions> = {}): NostrTransport {
  const t = new NostrTransport({ key: generateKey(), relays, retryBaseMs: 20, reconnectBaseMs: 30, ...opts });
  open.push(t);
  return t;
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('listening link state (NOTES 90)', () => {
  it('records a dropped relay as down_since with a bounded error, and clears it when the relay returns', async () => {
    const a = await relay();
    const b = await relay();
    const links: RelayLink[] = [];
    const saved: RelayStatus[][] = [];
    const t = transport([a.url, b.url], { onRelayLink: (l) => links.push(l), onRelayStatus: (s) => saved.push(s) });
    t.onEnvelopes(generateKey().id, () => {});
    await until(() => links.filter((l) => l.up).length === 2);
    expect(t.relayStatus().map((r) => r.down_since)).toEqual([null, null]);

    const port = Number(new URL(a.url).port);
    await a.close();
    await until(() => links.some((l) => !l.up));
    await new Promise((r) => setTimeout(r, 400)); // several failed reconnects later
    const down = links.filter((l) => !l.up);
    expect(down).toHaveLength(1); // one transition, however many retries follow
    expect(down[0].url).toBe(a.url);
    const [sa, sb] = t.relayStatus();
    expect(sa.down_since).toBe(down[0].down_since);
    expect(sa.last_error?.message.length ?? 0).toBeLessThanOrEqual(203);
    expect(sa.last_error?.at).toBeTruthy();
    expect(sb.down_since).toBeNull();
    expect(saved.at(-1)?.find((r) => r.url === a.url)?.down_since).toBe(down[0].down_since);

    await relay(port);
    await until(() => links.filter((l) => l.url === a.url && l.up).length === 2);
    expect(t.relayStatus()[0].down_since).toBeNull();
    expect(saved.at(-1)?.find((r) => r.url === a.url)?.down_since).toBeNull();
  });

  it('a transport that never listens carries no down_since (a merge keeps the listener\'s)', async () => {
    const r = await relay();
    const t = transport([r.url]);
    expect('down_since' in t.relayStatus()[0]).toBe(false);
  });
});
