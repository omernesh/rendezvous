// The one place the CLI (and the MCP server) builds its relay transport.
import { type AgentKey, NostrTransport, type Transport } from '@rendezvous/core';

/**
 * Test-only fault injection: with `RDV_TEST_EXIT_AFTER_SEND=<n>` the process
 * exits (code 99) right after its n-th envelope reaches the relays, before the
 * command gets to save anything afterwards. Used by the crash-window
 * regression tests (issue #4); never set it otherwise.
 */
export function relayTransport(key: AgentKey, relays: string[]): Transport {
  const t = new NostrTransport({ key, relays });
  const n = Number(process.env.RDV_TEST_EXIT_AFTER_SEND ?? 0);
  if (!(n > 0)) return t;
  let sent = 0;
  const send = t.sendEnvelope.bind(t);
  t.sendEnvelope = async (e, r) => {
    await send(e, r);
    if (++sent >= n) process.exit(99);
  };
  return t;
}
