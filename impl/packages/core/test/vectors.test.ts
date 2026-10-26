// Interop test vectors (spec §12, v0.2). Another implementation should
// reproduce every deterministic value here and open the sample envelope.
// Regenerate with: npm run test:vectors:update (works in PowerShell and POSIX shells)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gcm } from '@noble/ciphers/aes';
import { describe, expect, it } from 'vitest';
import {
  agentTag,
  bytesToHex,
  canonicalize,
  createCard,
  createGroupState,
  docHash,
  dtopic,
  idtopic,
  b64encode,
  FILE_AD,
  fileRefPart,
  hexToBytes,
  parseFilePart,
  sha256Hex,
  utf8ToBytes,
  verifyAndDecrypt,
  keyFromSecret,
  nostrCarrierKey,
  openEnvelope,
  sealEnvelope,
  signDoc,
  verifyGrant,
  verifyGroupInvite,
  verifyGroupJoin,
  verifyGroupState,
  verifyReverseGrant,
  successorProblem,
  GROUPS_EXTENSION,
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
  // John grants Omer's request (forward grant), then Omer's human grants John back (reverse grant, NOTES 60).
  const grant = signDoc(
    {
      v: 1,
      type: 'rdv/contact-grant',
      id: '00000000-0000-4000-8000-000000000002',
      from: john.id,
      to: omer.id,
      request_ref: request.id,
      tier: 'friend',
      scope: { may_initiate: true, may_propose_meetings: true, max_frequency: '100/day' },
      expires: null,
      ts: now.toISOString(),
      card,
    },
    john,
  );
  const reverseGrant = signDoc(
    {
      v: 1,
      type: 'rdv/contact-grant',
      id: '00000000-0000-4000-8000-000000000003',
      from: omer.id,
      to: john.id,
      grant_ref: grant.id,
      tier: 'friend',
      scope: { may_initiate: true, may_propose_meetings: true, max_frequency: '100/day' },
      expires: null,
      ts: now.toISOString(),
      card: request.card,
    },
    omer,
  );
  // A file reference (SPEC §7.7): AES-256-GCM with associated data "rdv1/blob". Real
  // senders draw a fresh random key and nonce per file (encryptFile); fixed here.
  const filePlain = utf8ToBytes('Q4 plan, draft 3: John reviews the budget, Omer the copy.');
  const fileKey = hexToBytes('33'.repeat(32));
  const fileNonce = hexToBytes('44'.repeat(12));
  const fileCipher = gcm(fileKey, fileNonce, utf8ToBytes(FILE_AD)).encrypt(filePlain);
  const filePart = fileRefPart({
    uri: 'https://files.example.com/q4/' + sha256Hex(fileCipher),
    mimeType: 'text/plain',
    name: 'q4-plan.txt',
    sha256: sha256Hex(fileCipher),
    size: fileCipher.length,
    enc: { alg: 'aes256gcm', key: b64encode(fileKey), nonce: b64encode(fileNonce), plain_sha256: sha256Hex(filePlain) },
  });
  // Groups (SPEC §7.8, issue #77): Omer creates a group (epoch 0), invites John, John's human joins with a
  // group-scoped grant, and Omer adds him (epoch 1). Each document is signed like any other (§4.6).
  const groupId = '00000000-0000-4000-8000-000000000010';
  const policy = { member_rate: '60/hour', members_may_invite: false };
  const omerGroupCard = createCard(omer, { now, rendezvous: [{ type: 'nostr', relay: 'wss://relay.example', pref: 1 }], capabilities: ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION] });
  const johnGroupCard = createCard(john, { now, rendezvous: [{ type: 'nostr', relay: 'wss://relay.example', pref: 1 }], capabilities: ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION] });
  const state0 = createGroupState(omer, { group: groupId, epoch: 0, prev: null, members: [{ id: omer.id, role: 'admin', card: docHash(omerGroupCard) }], policy, name: 'Microsite launch', ts: now.toISOString() });
  const invite = signDoc(
    {
      v: 1,
      type: 'rdv/group-invite',
      id: '00000000-0000-4000-8000-000000000011',
      group: groupId,
      from: omer.id,
      to: john.id,
      state: state0,
      greeting: 'Help with the microsite?',
      expires: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      ts: now.toISOString(),
    },
    omer,
  );
  const join = signDoc(
    {
      v: 1,
      type: 'rdv/group-join',
      id: '00000000-0000-4000-8000-000000000012',
      group: groupId,
      from: john.id,
      to: omer.id,
      invite_ref: invite.id,
      state: docHash(state0),
      card: johnGroupCard,
      scope: { invoke: { 'https://rendezvous.nesher.co/ext/request/v1': {} }, max_frequency: '20/day' },
      ts: now.toISOString(),
    },
    john,
  );
  const state1 = createGroupState(omer, {
    group: groupId,
    epoch: 1,
    prev: docHash(state0),
    members: [
      { id: omer.id, role: 'admin', card: docHash(omerGroupCard) },
      { id: john.id, role: 'member', card: docHash(johnGroupCard), name: 'John' },
    ],
    policy,
    name: 'Microsite launch',
    ts: now.toISOString(),
  });
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
    // NOTES 83: the topic a public card is also published on, found by agent ID alone.
    idtopic: Object.fromEntries([omer, john].map((k) => [k.id, idtopic(k.id)])),
    card: { canonical: canonicalize(card), doc: card },
    contact_request: { canonical: canonicalize(request), doc: request },
    contact_grant: { canonical: canonicalize(grant), doc: grant },
    reverse_grant: { canonical: canonicalize(reverseGrant), doc: reverseGrant },
    file_ref: { plaintext_hex: bytesToHex(filePlain), ciphertext_hex: bytesToHex(fileCipher), part: filePart },
    group_state_0: { canonical: canonicalize(state0), hash: docHash(state0), doc: state0 },
    group_invite: { canonical: canonicalize(invite), doc: invite },
    group_join: { canonical: canonicalize(join), doc: join },
    group_state_1: { canonical: canonicalize(state1), hash: docHash(state1), doc: state1 },
  };
}

describe('test vectors', () => {
  const current = deterministic();

  if (process.env.UPDATE_VECTORS || !existsSync(FILE)) {
    // Sealing is randomized: keep the saved sample envelope unless UPDATE_VECTORS=envelope asks for a new one.
    const old = existsSync(FILE) && process.env.UPDATE_VECTORS !== 'envelope' ? JSON.parse(readFileSync(FILE, 'utf8')).envelope : undefined;
    const envelope = old ?? {
      recipient_seed_hex: '22'.repeat(32),
      doc: sealEnvelope(omer, john.id, { type: 'a2a/message', text: 'Thursday 20:00?' }, { seq: 1, prev: null, now, ttl: '7d' }),
    };
    writeFileSync(FILE, JSON.stringify({ ...current, envelope }, null, 2) + '\n');
  }
  const saved = JSON.parse(readFileSync(FILE, 'utf8'));

  it('reproduces keys, topics, card and request byte for byte', () => {
    const { envelope: _e, ...rest } = saved;
    expect(current).toEqual(rest);
  });

  it('verifies the grants: each one only as its own kind', () => {
    const { contact_grant: g, reverse_grant: r } = saved;
    expect([verifyGrant(g.doc, now), verifyReverseGrant(g.doc, now)]).toEqual([true, false]);
    expect([verifyGrant(r.doc, now), verifyReverseGrant(r.doc, now)]).toEqual([false, true]);
  });

  it('verifies and decrypts the file reference', () => {
    const { file_ref: f } = saved;
    const parsed = parseFilePart(f.part);
    if (!parsed.ok || parsed.value.kind !== 'ref') throw new Error('file_ref vector does not parse');
    expect(bytesToHex(verifyAndDecrypt(parsed.value.ref, hexToBytes(f.ciphertext_hex)))).toBe(f.plaintext_hex);
  });

  it('verifies the group documents and the state chain (issue #77)', () => {
    const { group_state_0: s0, group_invite: i, group_join: j, group_state_1: s1 } = saved;
    expect([verifyGroupState(s0.doc, now).ok, verifyGroupInvite(i.doc, now).ok, verifyGroupJoin(j.doc, now).ok, verifyGroupState(s1.doc, now).ok]).toEqual([true, true, true, true]);
    expect(successorProblem(s0.doc, s1.doc)).toBeNull();
    expect(j.doc.state).toBe(s0.hash);
    expect(s1.doc.prev).toBe(s0.hash);
    expect(s1.doc.members[1].card).toBe(docHash(j.doc.card));
  });

  it('opens the sample envelope', () => {
    const opened = openEnvelope(john, saved.envelope.doc, now);
    expect(opened.ok && opened.payload).toEqual({ type: 'a2a/message', text: 'Thursday 20:00?' });
  });
});
