#!/usr/bin/env node
// Gentle, serial survey of public Nostr relays as discovery mirrors (NOTES 81).
//
// For each candidate relay, one at a time and never in parallel:
//   1. NIP-11 document (auth, payment, restricted writes, PoW, size limit),
//   2. publish ONE address card (kind 30417, replaceable `d` = rdv1/card:<topic>)
//      from a throwaway identity, for a throwaway example.com address,
//   3. read it back on a fresh connection by author and `d`.
// Then wait a couple of seconds before the next relay. No retries.
//
// Needs the built core (npm run build). Run from impl/:
//   node deploy/mirror-survey.mjs [--out results.json] [--gap-ms 2000] [wss://relay ...]
// With no relays given it surveys the built-in candidate list. relay.damus.io
// is never surveyed (it banned an earlier test pubkey for bursts).
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
  canonicalize,
  cardTag,
  createCard,
  dtopic,
  ENVELOPE_KIND,
  generateKey,
  nostrCarrierKey,
} from '@rendezvous/core';

class QuietWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.on('error', () => {});
  }
}
useWebSocketImplementation(QuietWebSocket);

const CANDIDATES = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
  'wss://nostr.data.haus',
  'wss://nostr-01.yakihonne.com',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.wine',
  'wss://relay.nostr.bg',
  'wss://nostr.bitcoiner.social',
  'wss://purplepag.es',
  'wss://relay.coinos.io',
  'wss://relay.nostr.band',
  'wss://nostr.land',
  'wss://relay.nostrplebs.com',
  'wss://nostr.fmt.wiz.biz',
  'wss://relay.mostr.pub',
  'wss://nostr21.com',
  'wss://relay.nostromo.social',
  'wss://nostr.einundzwanzig.space',
  'wss://relay.nostrich.de',
  'wss://nostr.lu.ke',
  'wss://relay.orangepill.dev',
  'wss://nostr.vulpem.com',
  'wss://relay.0xchat.com',
  'wss://nostr.thank.eu',
  'wss://relay.f7z.io',
  'wss://relay.momostr.pink',
  'wss://nostr.azzamo.net',
  'wss://relay.nostr.wirednet.jp',
  'wss://yabu.me',
  'wss://relay.siamstr.com',
  'wss://nostr.rocks',
  'wss://relay.lexingtonbitcoin.org',
  'wss://relay.nos.social',
  'wss://nostrue.com',
  'wss://relay.angor.io',
  'wss://relay.ditto.pub',
  'wss://relay.westernbtc.com',
  'wss://nostr.fbxl.net',
  'wss://relay.nostr.place',
  'wss://nostr.chaima.info',
  'wss://relay.agorist.space',
];
const NEVER = new Set(['wss://relay.damus.io']);

const args = process.argv.slice(2);
let out;
let gapMs = 2000;
const given = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--gap-ms') gapMs = Number(args[++i]);
  else given.push(args[i]);
}
const relays = (given.length ? given : CANDIDATES).filter((r) => !NEVER.has(r.replace(/\/+$/, '')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);
const short = (e) => String(e?.message ?? e).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 160);

async function nip11(url) {
  const http = url.replace(/^ws/, 'http');
  const res = await withTimeout(fetch(http, { headers: { Accept: 'application/nostr+json' } }), 6000, 'NIP-11');
  if (!res.ok) throw new Error(`NIP-11 HTTP ${res.status}`);
  const doc = await withTimeout(res.json(), 6000, 'NIP-11 body');
  const lim = doc.limitation ?? {};
  return {
    software: typeof doc.software === 'string' ? doc.software.replace(/^.*\//, '') : null,
    version: typeof doc.version === 'string' ? doc.version : null,
    auth_required: lim.auth_required === true,
    payment_required: lim.payment_required === true,
    restricted_writes: lim.restricted_writes === true,
    min_pow: typeof lim.min_pow_difficulty === 'number' ? lim.min_pow_difficulty : 0,
    max_message_length: typeof lim.max_message_length === 'number' ? lim.max_message_length : null,
  };
}

// One throwaway identity for the whole run: one card, one event, the same on every relay.
const key = generateKey();
const carrier = nostrCarrierKey(key);
const pubkey = getPublicKey(carrier);
const address = { type: 'email', value: `survey-${randomBytes(6).toString('hex')}@example.com` };
const topic = dtopic(address);
const card = createCard(key, {
  rendezvous: [{ type: 'nostr', relay: 'wss://nos.lol', pref: 1 }],
  discovery: { addresses: [address], public_pointer: true },
  policy: { inbound: 'prompt', public: true },
});
const event = finalizeEvent(
  {
    kind: ENVELOPE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', topic],
      ['d', cardTag(topic)],
    ],
    content: canonicalize(card),
  },
  carrier,
);

async function publish(url) {
  const relay = await withTimeout(Relay.connect(url), 6000, 'connect');
  try {
    relay.publishTimeout = 8000;
    await relay.publish(event);
    return { result: 'accepted' };
  } catch (err) {
    const m = short(err);
    if (/^duplicate/i.test(m)) return { result: 'accepted' };
    return { result: /timed? ?out/i.test(m) ? 'timeout' : 'rejected', message: m };
  } finally {
    relay.close();
  }
}

async function readBack(url) {
  const relay = await withTimeout(Relay.connect(url), 6000, 'connect');
  try {
    return await new Promise((resolve) => {
      let found = false;
      const sub = relay.subscribe([{ kinds: [ENVELOPE_KIND], authors: [pubkey], '#d': [cardTag(topic)] }], {
        onevent: (ev) => {
          if (ev.id === event.id) found = true;
        },
        oneose: () => {
          sub.close();
          resolve(found);
        },
        onclose: () => resolve(found),
      });
      setTimeout(() => resolve(found), 6000);
    });
  } finally {
    relay.close();
  }
}

const results = [];
console.error(`surveying ${relays.length} relays, one at a time, ${gapMs} ms apart (throwaway pubkey ${pubkey.slice(0, 12)}…)`);
for (const url of relays) {
  const row = { url, nip11: null, nip11_error: null, result: null, message: null, served: null };
  try {
    row.nip11 = await nip11(url);
  } catch (err) {
    row.nip11_error = short(err);
  }
  try {
    const p = await publish(url);
    row.result = p.result;
    row.message = p.message ?? null;
  } catch (err) {
    const m = short(err);
    row.result = /timed out/.test(m) ? 'timeout' : 'connection';
    row.message = m;
  }
  if (row.result === 'accepted') {
    await sleep(1500); // give the relay a moment to index it
    try {
      row.served = await readBack(url);
    } catch (err) {
      row.served = false;
      row.message = `read-back: ${short(err)}`;
    }
  }
  results.push(row);
  console.error(`${url}: ${row.result}${row.served === null ? '' : row.served ? ', served' : ', NOT served'}${row.message ? ` (${row.message})` : ''}`);
  await sleep(gapMs);
}

const count = (r) => results.filter((x) => x.result === r).length;
const summary = {
  at: new Date().toISOString(),
  relays: results.length,
  accepted: count('accepted'),
  served: results.filter((x) => x.served).length,
  rejected: count('rejected'),
  timeout: count('timeout'),
  connection: count('connection'),
};
console.error(JSON.stringify(summary));
const json = JSON.stringify({ summary, results }, null, 2) + '\n';
if (out) writeFileSync(out, json);
else process.stdout.write(json);
process.exit(0);
