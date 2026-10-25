// The owner passphrase (issue #47): hashed at rest, a miss counted, a lockout
// that doubles, a right answer that resets it, and fail closed on a bad file.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Home } from '../src/home.js';
import {
  checkOwnerSecret,
  clearOwnerSecret,
  hasOwnerSecret,
  LOCKOUT_AFTER,
  ownerSecretInfo,
  ownerSecretLock,
  RESET_COOLDOWN_MS,
  storeOwnerSecret,
  weakOwnerSecret,
} from '../src/ownersecret.js';

const PASS = 'OWNER-PASS correct horse';

describe('owner passphrase', () => {
  let dir: string;
  let home: Home;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rdv-owner-'));
    mkdirSync(join(dir, 'h'));
    home = new Home(join(dir, 'h'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is stored as a salted scrypt hash, never in clear', async () => {
    expect(hasOwnerSecret(home)).toBe(false);
    expect(await checkOwnerSecret(home, PASS)).toEqual({ ok: false, reason: 'none' });
    await storeOwnerSecret(home, PASS);
    const raw = readFileSync(home.ownerSecretPath, 'utf8');
    expect(raw).not.toContain(PASS);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, salt: expect.stringMatching(/^[0-9a-f]{32}$/), hash: expect.stringMatching(/^[0-9a-f]{64}$/), failures: 0 });
    expect(await checkOwnerSecret(home, PASS)).toEqual({ ok: true });
    expect(await checkOwnerSecret(home, PASS.toLowerCase())).toMatchObject({ ok: false, reason: 'wrong' });
  });

  it('refuses weak passphrases', async () => {
    expect(weakOwnerSecret('short')).toMatch(/at least/);
    expect(weakOwnerSecret(' leading space ok?')).toMatch(/spaces/);
    expect(weakOwnerSecret(PASS)).toBeUndefined();
    await expect(storeOwnerSecret(home, '1234567')).rejects.toThrow(/at least 8/);
  });

  it('locks after repeated misses, longer each time; a right answer resets it', async () => {
    await storeOwnerSecret(home, PASS);
    const t0 = new Date('2026-10-25T12:00:00Z');
    for (let i = 1; i < LOCKOUT_AFTER; i++) {
      expect(await checkOwnerSecret(home, 'nope nope', t0)).toEqual({ ok: false, reason: 'wrong', triesLeft: LOCKOUT_AFTER - i });
    }
    const locked = await checkOwnerSecret(home, 'nope nope', t0);
    expect(locked).toEqual({ ok: false, reason: 'locked', lockedUntil: '2026-10-25T12:01:00.000Z' });
    // While locked even the right one is refused, and nothing more is counted.
    expect(await checkOwnerSecret(home, PASS, new Date('2026-10-25T12:00:30Z'))).toMatchObject({ ok: false, reason: 'locked' });
    expect(ownerSecretLock(home, new Date('2026-10-25T12:00:30Z'))?.toISOString()).toBe('2026-10-25T12:01:00.000Z');
    expect(JSON.parse(readFileSync(home.ownerSecretPath, 'utf8')).failures).toBe(LOCKOUT_AFTER);
    // Another miss after the lock: twice as long.
    expect(await checkOwnerSecret(home, 'nope nope', new Date('2026-10-25T12:02:00Z'))).toEqual({ ok: false, reason: 'locked', lockedUntil: '2026-10-25T12:04:00.000Z' });
    expect(ownerSecretLock(home, new Date('2026-10-25T12:05:00Z'))).toBeNull();
    expect(await checkOwnerSecret(home, PASS, new Date('2026-10-25T12:05:00Z'))).toEqual({ ok: true });
    const after = JSON.parse(readFileSync(home.ownerSecretPath, 'utf8'));
    expect([after.failures, after.locked_until]).toEqual([0, undefined]);
  });

  it('reset only clears, never while locked; a new one waits out the cooldown; info shows the reset', async () => {
    const t0 = new Date('2026-10-25T12:00:00Z');
    await expect(clearOwnerSecret(home, t0)).rejects.toThrow(/nothing to reset/);
    await storeOwnerSecret(home, PASS, 'set', t0);
    for (let i = 0; i < LOCKOUT_AFTER; i++) await checkOwnerSecret(home, 'nope nope', t0);
    await expect(clearOwnerSecret(home, new Date('2026-10-25T12:00:30Z'))).rejects.toThrow(/refused until/);
    expect(hasOwnerSecret(home)).toBe(true);
    const t1 = new Date('2026-10-25T12:02:00Z');
    await clearOwnerSecret(home, t1);
    expect(hasOwnerSecret(home)).toBe(false);
    expect(await checkOwnerSecret(home, PASS, t1)).toEqual({ ok: false, reason: 'none' });
    expect(ownerSecretInfo(home)).toMatchObject({ set: null, reset: t1.toISOString(), note: expect.stringContaining('OWNER PASSPHRASE RESET') });
    await expect(storeOwnerSecret(home, PASS, 'set', new Date(t1.getTime() + RESET_COOLDOWN_MS - 1000))).rejects.toThrow(/can be set after/);
    await storeOwnerSecret(home, PASS, 'set', new Date(t1.getTime() + RESET_COOLDOWN_MS + 1000));
    expect(hasOwnerSecret(home)).toBe(true);
    expect(home.readAudit().map((a) => a.action)).toEqual(['set', 'reset', 'set']);
  });

  it('fails closed on a file it cannot read', async () => {
    writeFileSync(home.ownerSecretPath, '{ torn');
    await expect(checkOwnerSecret(home, PASS)).rejects.toThrow(/unreadable/);
    writeFileSync(home.ownerSecretPath, JSON.stringify({ v: 1, salt: 'x', hash: 'y', failures: 0 }));
    expect(() => hasOwnerSecret(home)).toThrow(/unreadable/);
  });
});
