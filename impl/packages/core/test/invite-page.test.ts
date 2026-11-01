// The invite landing page's decoder (site/invite.js, NOTES 105) against the
// same vectors as the library: it reads v2 and v1, shows the fingerprint the
// agent would, and refuses a cut or changed link.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { encodeInviteV1, fingerprint, generateKey, type Invite, inviteUrl, newInviteSecret } from '../src/index.js';

type Decoded = { agent: string; expires: Date; name: string } | null;
const g = globalThis as unknown as { rdvInviteDecode?: (p: string) => Decoded; rdvInviteCheck?: (p: string) => Promise<boolean> };
new Script(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'site', 'invite.js'), 'utf8')).runInThisContext();
const decode = g.rdvInviteDecode!;
const check = g.rdvInviteCheck!;
const VECTORS = JSON.parse(readFileSync(new URL('../vectors/invite-v2.json', import.meta.url), 'utf8')) as { valid: Array<{ name: string; url: string; invite: Invite }> };
const payloadOf = (url: string) => url.slice(url.indexOf('#') + 1);
const shown = (agent: string) => `rdv1:${agent.slice(5, 9)}…${agent.slice(-4)}`;

describe('invite landing page decoder', () => {
  it('reads the v2 vectors: agent ID, expiry, name; the check bytes match', async () => {
    for (const v of VECTORS.valid) {
      const d = decode(payloadOf(v.url));
      expect(d, v.name).not.toBeNull();
      expect(d!.agent).toBe(v.invite.agentId);
      expect(shown(d!.agent)).toBe(fingerprint(v.invite.agentId));
      expect(d!.expires.toISOString()).toBe(v.invite.expires);
      expect(d!.name).toBe(v.invite.name ?? '');
      expect(await check(payloadOf(v.url))).toBe(true);
    }
  });

  it('reads a fresh v2 link and a v1 link', async () => {
    const i = { agentId: generateKey().id, relays: ['wss://relay.nesher.co', 'wss://relay.example.com'], secret: newInviteSecret(), expires: '2026-11-08T12:00:00.000Z', name: 'Omer' };
    expect(decode(payloadOf(inviteUrl(i)))).toEqual({ agent: i.agentId, expires: new Date(i.expires), name: 'Omer' });
    expect(decode(encodeInviteV1(i))).toEqual({ agent: i.agentId, expires: new Date(i.expires), name: 'Omer' });
    expect(await check(encodeInviteV1(i))).toBe(true);
  });

  it('refuses a cut link, and the check catches a changed character', async () => {
    const p = payloadOf(VECTORS.valid[0].url);
    for (let n = 1; n < p.length; n += 5) expect(decode(p.slice(0, p.length - n)), `cut ${n}`).toBeNull();
    expect(decode(`${p.slice(0, 30)}…${p.slice(-10)}`)).toBeNull();
    expect(decode('')).toBeNull();
    expect(decode('nope')).toBeNull();
    // The secret's bytes changed: the structure still reads, the check bytes do not match.
    const changed = `${p.slice(0, 50)}${p[50] === 'A' ? 'B' : 'A'}${p.slice(51)}`;
    expect(decode(changed)).not.toBeNull();
    expect(await check(changed)).toBe(false);
  });
});
