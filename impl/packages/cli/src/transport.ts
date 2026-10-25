// The one place the CLI (and the MCP server) builds its relay transport.
import { type AgentKey, DEFAULT_MIRROR_RELAYS, NostrTransport } from '@rendezvous/core';
import type { Config, Home } from './home.js';

/** Most listening relays an agent keeps (envelopes go to every one of them, so keep it small). */
export const MAX_RELAYS = 8;
/** Most discovery mirrors (cards only). */
export const MAX_MIRROR_RELAYS = 64;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A relay URL we accept from `rdv relays add` / `rdv_relays`: `wss://` with a
 * host, or `ws://` only on this machine (a local test or dev relay). No
 * credentials, no fragment. Returns it normalized (lowercase scheme and host,
 * no trailing slash on an empty path), or the problem, for the human.
 */
export function checkRelayUrl(raw: string): { url: string } | { problem: string } {
  const text = raw.trim();
  if (text.length === 0 || text.length > 512) return { problem: 'a relay URL is 1 to 512 characters' };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { problem: `not a URL: ${text}` };
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return { problem: `not a wss:// relay URL: ${text}` };
  if (!u.hostname) return { problem: `no host in ${text}` };
  if (u.username || u.password) return { problem: 'a relay URL carries no user name or password' };
  if (u.hash) return { problem: 'a relay URL has no #fragment' };
  if (u.protocol === 'ws:' && !LOCAL_HOSTS.has(u.hostname)) {
    return { problem: `ws:// (unencrypted) is only for a relay on this machine (localhost); use wss:// for ${u.hostname}` };
  }
  const path = u.pathname === '/' ? '' : u.pathname;
  return { url: `${u.protocol}//${u.host}${path}${u.search}` };
}

/**
 * The discovery mirrors (NOTES 81): config.json's `mirror_relays` once the
 * owner has changed them (`rdv relays add|remove --mirror`), else
 * DEFAULT_MIRROR_RELAYS, but only for an agent whose relays are all wss://.
 * An agent on a ws:// relay is a local test or dev setup: nothing of it goes
 * to, or is looked up on, public mirrors unless its owner adds one. Our
 * listening relays are never listed twice.
 */
export function mirrorRelaysOf(config: Pick<Config, 'relays' | 'mirror_relays'>): string[] {
  const list = Array.isArray(config.mirror_relays)
    ? config.mirror_relays.filter((r): r is string => typeof r === 'string')
    : config.relays.every((r) => r.startsWith('wss://'))
      ? [...DEFAULT_MIRROR_RELAYS]
      : [];
  return [...new Set(list)].filter((r) => !config.relays.includes(r));
}

/** Both relay sets of a home's config. */
export function relaySets(config: Pick<Config, 'relays' | 'mirror_relays'>): { relays: string[]; mirror: string[] } {
  return { relays: [...config.relays], mirror: mirrorRelaysOf(config) };
}

/**
 * A Nostr transport on `relays` (and, for lookups and `--mirror`, `mirror`).
 * With `home`, it starts from the relay cooldowns saved there (relays.json)
 * and saves each publish's per-relay result back, for `rdv whoami` and
 * `rdv_status` (NOTES 69).
 *
 * Test-only fault injection: with `RDV_TEST_EXIT_AFTER_SEND=<n>` the process
 * exits (code 99) right after its n-th envelope reaches the relays, before the
 * command gets to save anything afterwards. Used by the crash-window
 * regression tests (issue #4); never set it otherwise.
 */
export function relayTransport(key: AgentKey, relays: string[], home?: Home, mirror: string[] = []): NostrTransport {
  const t = new NostrTransport({
    key,
    relays,
    mirrorRelays: mirror,
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
