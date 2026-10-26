// The relay link monitor's transitions and the relays.json merge (issue #87, NOTES 90). No network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelayStatus } from '@rendezvous/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../src/home.js';
import { RelayLinkMonitor, relayDownAfterMs } from '../src/relaywatch.js';

const st = (url: string, down_since: string | null | undefined, extra: Partial<RelayStatus> = {}): RelayStatus => ({
  url,
  last_ok: null,
  last_error: null,
  cooldown_until: null,
  ...(down_since === undefined ? {} : { down_since }),
  ...extra,
});

describe('RelayLinkMonitor', () => {
  it('reports a relay down only after the threshold, once; up once; degraded once and re-armed after recovery', () => {
    let now = Date.parse('2026-10-26T12:00:00Z');
    let state = [st('wss://a', null), st('wss://b', null)];
    const m = new RelayLinkMonitor(() => state, 1000, () => now);
    expect(m.check()).toEqual([]);

    state = [st('wss://a', new Date(now).toISOString()), st('wss://b', null)];
    now += 500;
    expect(m.check()).toEqual([]); // not yet over the threshold
    now += 600;
    expect(m.check().map((e) => e.event)).toEqual(['relay-down', 'relays-degraded']);
    now += 5000;
    expect(m.check()).toEqual([]); // no repeats while it stays down

    state = [st('wss://a', null), st('wss://b', null)];
    expect(m.check().map((e) => e.event)).toEqual(['relay-up']);
    expect(m.check()).toEqual([]);

    // A second outage after recovery degrades again.
    state = [st('wss://a', null), st('wss://b', new Date(now).toISOString())];
    now += 1100;
    expect(m.check().map((e) => e.event)).toEqual(['relay-down', 'relays-degraded']);
  });

  it('a relay that returns before the threshold produces no events; relays this process does not listen on are ignored', () => {
    let now = Date.parse('2026-10-26T12:00:00Z');
    let state = [st('wss://a', new Date(now).toISOString()), st('wss://b', undefined)];
    const m = new RelayLinkMonitor(() => state, 1000, () => now);
    now += 400;
    expect(m.check()).toEqual([]);
    state = [st('wss://a', null), st('wss://b', undefined)];
    now += 2000;
    expect(m.check()).toEqual([]);
  });

  it('reads the threshold from RDV_RELAY_DOWN_AFTER_MS, else ten minutes', () => {
    expect(relayDownAfterMs({})).toBe(600_000);
    expect(relayDownAfterMs({ RDV_RELAY_DOWN_AFTER_MS: '250' })).toBe(250);
    expect(relayDownAfterMs({ RDV_RELAY_DOWN_AFTER_MS: 'soon' })).toBe(600_000);
  });
});

describe('relays.json merge keeps the listener\'s down_since', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('a publish from a process that does not listen leaves it alone; the listener\'s own update wins', () => {
    dir = mkdtempSync(join(tmpdir(), 'rdv-relays-'));
    const home = new Home(dir);
    home.ensureDir();
    home.saveRelayStatus([st('wss://a', '2026-10-26T12:00:00.000Z')]);
    // A one-shot `rdv send` published later: newer last_ok, no down_since.
    home.saveRelayStatus([st('wss://a', undefined, { last_ok: '2026-10-26T12:05:00.000Z' })]);
    let [r] = home.readRelayStatus();
    expect(r).toMatchObject({ last_ok: '2026-10-26T12:05:00.000Z', down_since: '2026-10-26T12:00:00.000Z' });
    // The listener reports the relay back, with an older stamp than the send.
    home.saveRelayStatus([st('wss://a', null)]);
    [r] = home.readRelayStatus();
    expect(r.down_since).toBeNull();
    expect(r.last_ok).toBe('2026-10-26T12:05:00.000Z');
  });
});
