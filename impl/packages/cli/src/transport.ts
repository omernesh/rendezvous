// The one place the CLI (and the MCP server) builds its relay transport.
import { type AgentKey, NostrTransport } from '@rendezvous/core';
import type { Home } from './home.js';

/**
 * A Nostr transport on `relays`. With `home`, it starts from the relay
 * cooldowns saved there (relays.json) and saves each publish's per-relay
 * result back, for `rdv whoami` and `rdv_status` (NOTES 69).
 *
 * Test-only fault injection: with `RDV_TEST_EXIT_AFTER_SEND=<n>` the process
 * exits (code 99) right after its n-th envelope reaches the relays, before the
 * command gets to save anything afterwards. Used by the crash-window
 * regression tests (issue #4); never set it otherwise.
 */
export function relayTransport(key: AgentKey, relays: string[], home?: Home): NostrTransport {
  const t = new NostrTransport({
    key,
    relays,
    ...(home ? { relayState: home.readRelayStatus(), onRelayStatus: (s) => home.saveRelayStatus(s) } : {}),
  });
  const n = Number(process.env.RDV_TEST_EXIT_AFTER_SEND ?? 0);
  if (!(n > 0)) return t;
  let sent = 0;
  const send = t.sendEnvelope.bind(t);
  t.sendEnvelope = async (e, r) => {
    const report = await send(e, r);
    if (++sent >= n) process.exit(99);
    return report;
  };
  return t;
}
