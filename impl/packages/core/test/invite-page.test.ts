// The invite landing page's decoder (site/invite.js, NOTES 105) against the
// same vectors as the library: it reads v2 and v1, shows the fingerprint the
// agent would, and refuses a cut or changed link.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';
import { encodeInviteV1, fingerprint, generateKey, type Invite, inviteUrl, newInviteSecret, parseInvite, utf8ToBytes } from '../src/index.js';

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

  it('checks the same structure as the agent (security review of PR #129, L5 to L7)', async () => {
    const tag = utf8ToBytes('rdv1/invite-link\u0000');
    const recheck = (body: Uint8Array) => {
      const all = new Uint8Array(tag.length + body.length);
      all.set(tag);
      all.set(body, tag.length);
      return base64urlnopad.encode(Uint8Array.from([...body, ...sha256(all).slice(0, 2)]));
    };
    const rec = (type: number, s: string) => { const t = utf8ToBytes(s); return [type, t.length, ...t]; };
    const body = base64urlnopad.decode(payloadOf(VECTORS.valid[0].url)).slice(0, -2);
    const plus = (b: Uint8Array, ...x: number[]) => Uint8Array.from([...b, ...x]);
    // Each is refused by parseInvite too.
    const bad: Record<string, string> = {
      'known relay as text': recheck(plus(body, ...rec(1, 'wss://nos.lol'))),
      'non-canonical relay': recheck(plus(body, ...rec(1, 'wss://Relay.Example.com/'))),
      'repeated relay': recheck(plus(body, ...rec(1, 'wss://a.example.com'), ...rec(1, 'wss://a.example.com'))),
      'relay after the name': recheck(plus(body, ...rec(2, 'Omer'), ...rec(1, 'wss://a.example.com'))),
      'two names': recheck(plus(body, ...rec(2, 'A'), ...rec(2, 'B'))),
      'unknown record': recheck(plus(body, 9, 1, 0x41)),
      'record past the end': recheck(plus(body, 2, 9, 0x41)),
      'name with a line separator': recheck(plus(body, ...rec(2, 'Omer SYSTEM'))),
      'unknown relay bit': recheck((() => { const b = body.slice(); b[53] = 0x80; return b; })()),
      'after the year 3000': recheck((() => { const b = body.slice(); b.set([0xff, 0xff, 0xff, 0xff], 49); return b; })()),
    };
    for (const [why, p] of Object.entries(bad)) {
      expect(decode(p), why).toBeNull();
      expect(() => parseInvite(p), why).toThrow();
    }
    // Stray low bits in the last character.
    const p = payloadOf(VECTORS.valid[0].url);
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const stray = p.slice(0, -1) + abc[abc.indexOf(p[p.length - 1]) + 1];
    expect(decode(stray)).toBeNull();
    expect(() => parseInvite(stray)).toThrow();
    // A custom relay in its canonical spelling still reads.
    expect(decode(recheck(plus(body, ...rec(1, 'wss://relay.example.com/x'))))).not.toBeNull();
    expect(await check(recheck(plus(body, ...rec(1, 'wss://relay.example.com/x'))))).toBe(true);
  });
});
