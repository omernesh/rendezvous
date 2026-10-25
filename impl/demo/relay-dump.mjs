#!/usr/bin/env node
// Privacy beat (PLAN §6.2, step 5): print what the relays actually store for
// Rendezvous (kind 30417) and show that envelopes are ciphertext only.
//
//   node demo/relay-dump.mjs --relay ws://<relay-host>:7777 [--relay wss://nos.lol …]
//        [--minutes 60] [--agent rdv1:…] [--grep dinner --grep Tuesday] [--json]
//
// Run from impl/ after `npm run build`. Every event is classified:
//   envelope       encrypted message (header in clear: from, to, seq; body = ciphertext)
//   card           a public address card (public by design: the owner opted in)
//   topic-request  a contact request posted on a discovery topic (cleartext:
//                  the greeting and the requester's card are readable)
// --grep words are searched in every stored event's raw content; the dump ends
// with how many hits each word had (expect 0 inside envelopes).
import { parseArgs } from 'node:util';
import { agentTag, ENVELOPE_KIND } from '@rendezvous/core';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

useWebSocketImplementation(WebSocket);

const { values } = parseArgs({
  options: {
    relay: { type: 'string', multiple: true },
    minutes: { type: 'string', default: '60' },
    agent: { type: 'string', multiple: true },
    grep: { type: 'string', multiple: true },
    json: { type: 'boolean' },
  },
});
const relays = values.relay ?? (process.env.RDV_DEMO_RELAYS ?? '').split(',').filter(Boolean);
if (relays.length === 0) {
  console.error('usage: node demo/relay-dump.mjs --relay ws://… [--relay …] [--minutes 60] [--agent rdv1:…] [--grep word]');
  process.exit(2);
}
const since = Math.floor(Date.now() / 1000) - Number(values.minutes) * 60;
const filter = { kinds: [ENVELOPE_KIND], since };
if (values.agent?.length) filter['#p'] = values.agent.map(agentTag);

const pool = new SimplePool();
const events = await pool.querySync(relays, filter, { maxWait: 5000 });
events.sort((a, b) => a.created_at - b.created_at);

const short = (s, n = 16) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const words = values.grep ?? [];
const hits = Object.fromEntries(words.map((w) => [w, { envelope: 0, other: 0 }]));
const counts = { envelope: 0, card: 0, 'topic-request': 0, other: 0 };

for (const ev of events) {
  let doc;
  try {
    doc = JSON.parse(ev.content);
  } catch {
    doc = undefined;
  }
  const kind =
    doc && typeof doc.content === 'object' && doc.content?.ciphertext !== undefined
      ? 'envelope'
      : doc?.type === 'rdv/contact-request'
        ? 'topic-request'
        : doc?.rendezvous
          ? 'card'
          : 'other';
  counts[kind]++;
  for (const w of words) if (ev.content.toLowerCase().includes(w.toLowerCase())) hits[w][kind === 'envelope' ? 'envelope' : 'other']++;
  const when = new Date(ev.created_at * 1000).toISOString();
  const tags = ev.tags.filter((t) => ['p', 't'].includes(t[0])).map((t) => `${t[0]}=${short(t[1], 12)}`).join(' ');
  if (values.json) {
    console.log(JSON.stringify({ when, kind, id: ev.id, tags: ev.tags, bytes: ev.content.length, content: kind === 'envelope' ? doc : undefined }));
    continue;
  }
  if (kind === 'envelope') {
    console.log(`${when}  envelope  ${tags}  from ${short(doc.from, 14)} to ${short(doc.to, 14)} seq ${doc.seq}  alg ${doc.content.alg}`);
    console.log(`    ciphertext (${doc.content.ciphertext.length} chars): ${doc.content.ciphertext.slice(0, 64)}…`);
  } else if (kind === 'topic-request') {
    console.log(`${when}  topic-request (cleartext by design)  ${tags}  from ${short(doc.from, 14)}  greeting ${JSON.stringify(doc.greeting)}`);
  } else if (kind === 'card') {
    console.log(`${when}  card (public by design)  ${tags}  ${short(doc.id, 14)} claims ${(doc.discovery?.addresses ?? []).map((a) => a.value).join(', ')}`);
  } else {
    console.log(`${when}  other  ${tags}  ${ev.content.length} bytes`);
  }
}

console.log(
  `\n${events.length} events on ${relays.join(', ')} in the last ${values.minutes} min: ` +
    `${counts.envelope} envelopes (ciphertext), ${counts.card} cards, ${counts['topic-request']} topic requests, ${counts.other} other`,
);
for (const w of words) console.log(`  "${w}": ${hits[w].envelope} hits inside envelopes, ${hits[w].other} elsewhere`);
pool.destroy();
process.exit(0);
