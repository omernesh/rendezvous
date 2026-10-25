// Interop test vectors (spec §12, v0.2). Another implementation should
// reproduce every deterministic value here and open the sample envelope.
// Regenerate with: npm run test:vectors:update (works in PowerShell and POSIX shells)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  agentTag,
  bytesToHex,
  canonicalize,
  createCard,
  dtopic,
  hexToBytes,
  keyFromSecret,
  nostrCarrierKey,
  openEnvelope,
  sealEnvelope,
  signDoc,
} from '../src/index.js';

const FILE = new URL('../vectors/v1.json', import.meta.url);
const now = new Date('2026-10-24T00:00:00Z');
const omer = keyFromSecret(hexToBytes('11'.repeat(32)));
const john = keyFromSecret(hexToBytes('22'.repeat(32)));

function deterministic() {
  const card = createCard(john, {
    now,
    rendezvous: [{ type: 'nostr', relay: 'wss://relay.example', pref: 1 }],
    discovery: { addresses: [{ type: 'email', value: 'john@doe.com' }], public_pointer: false },
  });
  const request = signDoc(
    {
      v: 1,
      type: 'rdv/contact-request',
      id: '00000000-0000-4000-8000-000000000001',
      from: omer.id,
      to_hint: 'john@doe.com',
      card: createCard(omer, { now, rendezvous: [{ type: 'nostr', relay: 'wss://relay.example', pref: 1 }] }),
      greeting: "Omer's agent requests contact on Omer's behalf.",
      capabilities_offered: ['a2a/0.3'],
      ts: now.toISOString(),
    },
    omer,
  );
  return {
    keys: [omer, john].map((k) => ({
      seed_hex: bytesToHex(k.secretKey),
      public_key_hex: bytesToHex(k.publicKey),
      agent_id: k.id,
      nostr_p_tag: agentTag(k.id),
      nostr_carrier_secret_hex: bytesToHex(nostrCarrierKey(k)),
    })),
    dtopic: {
      'email john@doe.com': dtopic({ type: 'email', value: 'john@doe.com' }),
      'email John@Doe.COM': dtopic({ type: 'email', value: 'John@Doe.COM' }),
      'phone +972-54-000-0000': dtopic({ type: 'phone', value: '+972-54-000-0000' }),
    },
    card: { canonical: canonicalize(card), doc: card },
    contact_request: { canonical: canonicalize(request), doc: request },
  };
}

describe('test vectors', () => {
  const current = deterministic();

  if (process.env.UPDATE_VECTORS || !existsSync(FILE)) {
    const envelope = sealEnvelope(omer, john.id, { type: 'a2a/message', text: 'Thursday 20:00?' }, { seq: 1, prev: null, now, ttl: '7d' });
    writeFileSync(FILE, JSON.stringify({ ...current, envelope: { recipient_seed_hex: '22'.repeat(32), doc: envelope } }, null, 2) + '\n');
  }
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));

  it('reproduces keys, topics, card and request byte for byte', () => {
    const { envelope: _e, ...rest } = saved;
    expect(current).toEqual(rest);
  });

  it('opens the sample envelope', () => {
    const opened = openEnvelope(john, saved.envelope.doc, now);
    expect(opened.ok && opened.payload).toEqual({ type: 'a2a/message', text: 'Thursday 20:00?' });
  });
});
