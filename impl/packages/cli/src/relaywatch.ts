// Tells the user when a listening relay is down (issue #87, NOTES 90).
//
// The transport records each listening relay's `down_since` (core nostr.ts).
// This monitor, run by the home's inbound consumer on a timer, turns that into
// three events, each one per transition:
//   relay-down       a relay has been unreachable for more than the threshold
//   relay-up         a relay we reported as down is back
//   relays-degraded  fewer than 2 listening relays are healthy; re-armed only
//                    after recovery
// The events carry our own relay URLs and timestamps only: never relay text.
import type { RelayStatus } from '@rendezvous/core';

/** How long a relay must stay unreachable before the user is told. Default 10 minutes. */
export const RELAY_DOWN_AFTER_MS = 10 * 60_000;

/** `RDV_RELAY_DOWN_AFTER_MS` overrides the threshold (tests); anything that is not a positive number is ignored. */
export function relayDownAfterMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RDV_RELAY_DOWN_AFTER_MS);
  return Number.isFinite(n) && n > 0 ? n : RELAY_DOWN_AFTER_MS;
}

export type RelayWatchEvent =
  | { event: 'relay-down'; relay: string; down_since: string; threshold_ms: number; healthy: number; total: number }
  | { event: 'relay-up'; relay: string; down_since: string | null; healthy: number; total: number }
  | { event: 'relays-degraded'; healthy: number; total: number };

export class RelayLinkMonitor {
  /** Relays reported as down: the `down_since` we told the user about. */
  private readonly told = new Map<string, string>();
  private degraded = false;

  constructor(
    private readonly status: () => RelayStatus[],
    readonly thresholdMs: number = relayDownAfterMs(),
    private readonly now: () => number = Date.now,
  ) {}

  /** Poll interval that notices a threshold crossing promptly without spinning. */
  get pollMs(): number {
    return Math.min(5000, Math.max(25, Math.floor(this.thresholdMs / 4)));
  }

  /** Compare the transport's listening state with what was reported; returns the new events, in order. */
  check(): RelayWatchEvent[] {
    // Relays this process does not listen on (down_since absent) are not ours to judge.
    const links = this.status().filter((r) => r.down_since !== undefined);
    const total = links.length;
    const out: RelayWatchEvent[] = [];
    const urls = new Set(links.map((r) => r.url));
    for (const u of [...this.told.keys()]) if (!urls.has(u)) this.told.delete(u); // removed from the config
    const healthy = () => total - this.told.size;
    let newlyDown = false;
    for (const r of links) {
      const since = r.down_since;
      if (typeof since === 'string') {
        const age = this.now() - (Date.parse(since) || this.now());
        if (!this.told.has(r.url) && age >= this.thresholdMs) {
          this.told.set(r.url, since);
          newlyDown = true;
          out.push({ event: 'relay-down', relay: r.url, down_since: since, threshold_ms: this.thresholdMs, healthy: healthy(), total });
        }
      } else if (this.told.has(r.url)) {
        const was = this.told.get(r.url) ?? null;
        this.told.delete(r.url);
        out.push({ event: 'relay-up', relay: r.url, down_since: was, healthy: healthy(), total });
      }
    }
    if (this.told.size === 0 || healthy() >= 2) this.degraded = false;
    if (newlyDown && !this.degraded && healthy() < 2) {
      this.degraded = true;
      out.push({ event: 'relays-degraded', healthy: healthy(), total });
    }
    return out;
  }
}

/** The line for a terminal (`rdv listen`) and the MCP server's log. Ours only. */
export function relayWatchText(e: RelayWatchEvent): string {
  switch (e.event) {
    case 'relay-down':
      return `relay ${e.relay} has been unreachable since ${e.down_since} (${e.healthy} of ${e.total} listening relays healthy)`;
    case 'relay-up':
      return `relay ${e.relay} is reachable again (${e.healthy} of ${e.total} listening relays healthy)`;
    case 'relays-degraded':
      return `only ${e.healthy} of ${e.total} listening relays are healthy; add another with "rdv relays add <wss://...>"`;
  }
}
