// The owner passphrase (issue #47): what the owner types to turn auto-approve
// on for a contact (SPEC §5.5.1). It replaced "retype the fingerprint shown
// here", whose answer was printed by the very prompt that asked for it, so an
// assistant running the command in a pseudo-terminal could read it and type
// it back.
//
// - Set by the owner with `rdv owner-secret set`, in their own terminal;
//   changing it asks for the current one. Never an argument, never printed.
// - Stored as scrypt(N 2^15, r 8, p 1) with a random salt in
//   owner-secret.json (mode 600), compared with timingSafeEqual.
// - Read from the controlling terminal itself (/dev/tty, or CONIN$ on
//   Windows) with echo off, not from stdin, so piping an answer in does
//   nothing.
// - LOCKOUT_AFTER wrong answers in a row lock it, for a minute and then twice
//   as long after each further miss (up to a day); a right answer resets it.
//
// - Auto-approve entries are bound to the passphrase record they were set
//   under (ownerSecretBinding): any set, change or reset ends every older one.
// - A passphrase that existed (the audit log, or a marker MACed with the
//   agent key, says so) and whose file is gone counts as reset, not as never
//   set: the cooldown, the banner, and auto-approve off.
//
// Defence in depth, not a boundary: a same-user model with a shell can still
// replace the file or watch the owner type into a terminal it controls
// (NOTES 77).
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { isatty, ReadStream } from 'node:tty';
import { b64decode } from '@rendezvous/core';
import { writeAtomic } from './fsutil.js';
import { type AuditEntry, CliError, type Home } from './home.js';
import { sha, sha256, stable } from './hash.js';

export const OWNER_SECRET_MIN = 8;
export const OWNER_SECRET_MAX = 1024;
/** Wrong answers in a row before the passphrase locks. */
export const LOCKOUT_AFTER = 3;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 24 * 3_600_000;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** After `rdv owner-secret reset`, how long before a new passphrase may be set (a separate `rdv owner-secret set`). */
export const RESET_COOLDOWN_MS = 10 * 60_000;

export interface OwnerSecretRecord {
  v: 1;
  salt: string;
  hash: string;
  set: string;
  /** Wrong answers in a row. */
  failures: number;
  /** No answer is checked before this (RFC 3339). */
  locked_until?: string;
}

/**
 * What `rdv owner-secret reset` leaves: no passphrase, and when it was reset
 * (for the cooldown and the banner). `missing`: nobody reset it; the file of a
 * passphrase that existed was found gone at `reset`, and that counts the same.
 */
export interface OwnerSecretReset {
  v: 1;
  reset: string;
  missing?: true;
}

const derive = (secret: string, salt: Buffer) => scryptSync(`rdv1/owner-secret\0${secret.normalize('NFC')}`, salt, 32, SCRYPT);

function readAny(home: Home, now = new Date()): OwnerSecretRecord | OwnerSecretReset | null {
  if (!existsSync(home.ownerSecretPath)) return missing(home, now);
  let r: OwnerSecretRecord;
  try {
    r = JSON.parse(readFileSync(home.ownerSecretPath, 'utf8')) as OwnerSecretRecord;
  } catch (err) {
    throw unreadable(home, (err as Error).message);
  }
  const x = r as unknown as OwnerSecretReset | null;
  if (x && x.v === 1 && typeof x.reset === 'string' && (Object.keys(x).length === 2 || (Object.keys(x).length === 3 && x.missing === true))) {
    if (Number.isNaN(Date.parse(x.reset))) throw unreadable(home, 'unrecognized');
    return { v: 1, reset: x.reset, ...(x.missing ? { missing: true as const } : {}) };
  }
  const ok =
    r &&
    r.v === 1 &&
    typeof r.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(r.salt) &&
    typeof r.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(r.hash) &&
    Number.isSafeInteger(r.failures) &&
    r.failures >= 0 &&
    (r.locked_until === undefined || !Number.isNaN(Date.parse(r.locked_until)));
  if (!ok) throw unreadable(home, 'unrecognized');
  return r;
}

/**
 * No owner-secret.json. Never set: null. Set once (an `owner-secret` line in
 * the audit log, or a valid marker): the file was deleted instead of reset,
 * which counts as a reset from now, written down so the cooldown runs from
 * the moment it was noticed and the banner shows.
 */
function missing(home: Home, now: Date): OwnerSecretReset | null {
  if (!ownerSecretExisted(home)) return null;
  const t = Number.isFinite(now.getTime()) ? now : new Date();
  const r: OwnerSecretReset = { v: 1, reset: t.toISOString(), missing: true };
  try {
    writeAtomic(home.ownerSecretPath, `${JSON.stringify(r, null, 2)}\n`, 0o600);
  } catch {
    // Still a reset for this read; the next one tries again.
  }
  return r;
}

/** Has a passphrase ever been set in this home? The audit log says so, or (if it was cut or deleted) the marker. */
export function ownerSecretExisted(home: Home): boolean {
  try {
    if (home.readAudit().some((a) => a.gate === 'owner-secret')) return true;
  } catch {
    // an unreadable audit log: the marker decides
  }
  return markerValid(home);
}

const markerMac = (secretKey: Uint8Array, body: { v: 1; first: string }) => createHmac('sha256', secretKey).update(`rdv1/owner-secret-marker\0${stable(body)}`).digest('hex');

function agentKey(home: Home): Uint8Array | null {
  try {
    return b64decode(home.readAgentState().secretKey);
  } catch {
    return null;
  }
}

/** The marker holds only if this agent's key MACed it: one copied from another home, or written by hand, is not ours. */
function markerValid(home: Home): boolean {
  if (!existsSync(home.ownerSecretMarkerPath)) return false;
  const key = agentKey(home);
  if (!key) return false;
  try {
    const m = JSON.parse(readFileSync(home.ownerSecretMarkerPath, 'utf8')) as { v?: unknown; first?: unknown; mac?: unknown };
    if (!m || m.v !== 1 || typeof m.first !== 'string' || typeof m.mac !== 'string' || !/^[0-9a-f]{64}$/.test(m.mac)) return false;
    return timingSafeEqual(Buffer.from(m.mac, 'hex'), Buffer.from(markerMac(key, { v: 1, first: m.first }), 'hex'));
  } catch {
    return false;
  }
}

/** Write the marker once (inside the lock), so a deleted passphrase file is still noticed if the audit log goes too. */
function writeMarker(home: Home, now: Date): void {
  if (markerValid(home)) return;
  const key = agentKey(home);
  if (!key) return;
  const body = { v: 1 as const, first: now.toISOString() };
  writeAtomic(home.ownerSecretMarkerPath, `${JSON.stringify({ ...body, mac: markerMac(key, body) }, null, 2)}\n`, 0o600);
}

/**
 * After a restore that brought a passphrase record back (issue #88): the
 * marker, so a later deleted file still counts as a reset here too (the
 * audit log does not travel). Inside the lock; nothing when one holds.
 */
export function markOwnerSecretRestored(home: Home, now = new Date()): void {
  if (read(home)) writeMarker(home, now);
}

/**
 * What an auto-approve entry is bound to: the passphrase record it was set
 * under, by its `set` time and a digest of its salt (never the hash or the
 * passphrase). Every set, change or reset makes a new one, so every older
 * entry fails. Null when no passphrase is set; throws when the file is
 * unreadable.
 */
export function ownerSecretBinding(home: Home): string | null {
  const r = read(home);
  return r ? sha('rdv1/auto-approve-owner', { set: r.set, salt: sha256(Buffer.from(r.salt, 'hex')) }) : null;
}

/**
 * Was an owner passphrase ever set here? True while one is set, and after a
 * reset or a deleted file (readAny counts a missing file as a reset when the
 * audit log or the marker shows one existed). Only "never" is false. Throws
 * when the file is unreadable.
 */
export function ownerSecretEverSet(home: Home): boolean {
  return readAny(home) !== null;
}

function read(home: Home): OwnerSecretRecord | null {
  const r = readAny(home);
  return r && 'hash' in r ? r : null;
}

/** When a new passphrase may be set after a reset, or null if it may now. */
function cooldownEnd(r: OwnerSecretRecord | OwnerSecretReset | null, now: Date): Date | null {
  if (!r || !('reset' in r)) return null;
  const end = new Date(Date.parse(r.reset) + RESET_COOLDOWN_MS);
  return end.getTime() > now.getTime() ? end : null;
}

const unreadable = (home: Home, why: string) =>
  new CliError(`${home.ownerSecretPath} is unreadable (${why}): nothing that needs the owner passphrase works until you delete that file yourself and run "rdv owner-secret set"`);

const write = (home: Home, r: OwnerSecretRecord) => writeAtomic(home.ownerSecretPath, JSON.stringify(r, null, 2) + '\n', 0o600);

export const hasOwnerSecret = (home: Home): boolean => read(home) !== null;

/** When the lock ends, or null if it isn't locked now. */
export function ownerSecretLock(home: Home, now = new Date()): Date | null {
  const r = read(home);
  if (!r?.locked_until) return null;
  const t = new Date(r.locked_until);
  return t.getTime() > now.getTime() ? t : null;
}

export type OwnerSecretCheck = { ok: true } | { ok: false; reason: 'none' | 'locked' | 'wrong'; lockedUntil?: string; triesLeft?: number };

/** Check a typed passphrase, counting a miss (call outside the home lock: it takes it). */
export async function checkOwnerSecret(home: Home, typed: string, now = new Date()): Promise<OwnerSecretCheck> {
  return home.locked(async () => {
    const r = read(home);
    if (!r) return { ok: false, reason: 'none' };
    if (r.locked_until && Date.parse(r.locked_until) > now.getTime()) return { ok: false, reason: 'locked', lockedUntil: r.locked_until };
    const good = typed.length <= OWNER_SECRET_MAX && timingSafeEqual(derive(typed, Buffer.from(r.salt, 'hex')), Buffer.from(r.hash, 'hex'));
    if (good) {
      if (r.failures || r.locked_until) write(home, { v: 1, salt: r.salt, hash: r.hash, set: r.set, failures: 0 });
      return { ok: true };
    }
    const failures = r.failures + 1;
    const next: OwnerSecretRecord = { ...r, failures };
    delete next.locked_until;
    if (failures >= LOCKOUT_AFTER) next.locked_until = new Date(now.getTime() + Math.min(LOCK_BASE_MS * 2 ** (failures - LOCKOUT_AFTER), LOCK_MAX_MS)).toISOString();
    write(home, next);
    return next.locked_until
      ? { ok: false, reason: 'locked', lockedUntil: next.locked_until }
      : { ok: false, reason: 'wrong', triesLeft: LOCKOUT_AFTER - failures };
  });
}

/** Why `secret` can't be the owner passphrase, or undefined. */
export function weakOwnerSecret(secret: string): string | undefined {
  if ([...secret].length < OWNER_SECRET_MIN) return `at least ${OWNER_SECRET_MIN} characters`;
  if (secret.length > OWNER_SECRET_MAX) return `at most ${OWNER_SECRET_MAX} characters`;
  if (secret.trim() !== secret) return 'no spaces at the start or end';
  return undefined;
}

/**
 * Store a new passphrase (the caller checked the current one, if any) and
 * audit it: the first one is trust on first use, so its time is shown by
 * `rdv whoami` and `rdv_status` for the owner to recognize.
 */
export async function storeOwnerSecret(
  home: Home,
  secret: string,
  action: 'set' | 'changed' | 'reset' = 'set',
  now = new Date(),
  /** `form`: typed by the owner into an approval form (rdv_owner_passphrase, issue #102). Left out: their terminal. */
  via?: 'form',
): Promise<{ autoApproveOff: string[] }> {
  const weak = weakOwnerSecret(secret);
  if (weak) throw new CliError(`the passphrase needs ${weak}`, 2);
  const salt = randomBytes(16);
  return home.locked(async () => {
    const end = cooldownEnd(readAny(home, now), now);
    if (end) throw new CliError(`the owner passphrase was reset: a new one can be set after ${end.toISOString()} (rdv owner-secret set, in your own terminal)`);
    // Every auto-approve entry was bound to the old record (or to none): it ends here, audited; the owner turns each back on.
    const off = endAllAutoApprove(home, now);
    write(home, { v: 1, salt: salt.toString('hex'), hash: derive(secret, salt).toString('hex'), set: now.toISOString(), failures: 0 });
    writeMarker(home, now);
    home.appendAudit([...off.lines, { ts: now.toISOString(), peer: OWNER_PEER, gate: 'owner-secret', by: 'human', action, ...(via ? { via } : {}) }]);
    return { autoApproveOff: off.peers };
  });
}

/** Remove every auto-approve entry (inside the lock): a new passphrase record holds none of them. An unreadable file goes too. */
function endAllAutoApprove(home: Home, now: Date): { peers: string[]; lines: AuditEntry[] } {
  if (!existsSync(home.autoApprovePath)) return { peers: [], lines: [] };
  let peers: string[];
  try {
    peers = Object.keys(home.readAutoApprove());
  } catch {
    peers = [];
  }
  home.writeAutoApprove({});
  return { peers, lines: peers.map((peer): AuditEntry => ({ ts: now.toISOString(), peer, gate: 'auto-approve', by: 'human', action: 'off', reason: 'owner-secret' })) };
}

/** The audit log's `peer` for owner passphrase lines (they concern no contact). */
export const OWNER_PEER = 'owner';

/**
 * Forget the passphrase (`rdv owner-secret reset`, after the caller turned
 * every auto-approve off), audited. Refused while it is locked after wrong
 * answers. It only clears: a new one is a separate `rdv owner-secret set`,
 * after RESET_COOLDOWN_MS, so a reset is no way around the current passphrase
 * or the lockout that does not leave a gap the owner sees.
 */
export async function clearOwnerSecret(home: Home, now = new Date()): Promise<void> {
  await home.locked(async () => {
    const r = read(home);
    if (!r) throw new CliError('no owner passphrase is set: nothing to reset');
    if (r.locked_until && Date.parse(r.locked_until) > now.getTime()) {
      throw new CliError(`too many wrong owner passphrases: reset is refused until ${r.locked_until}`);
    }
    writeAtomic(home.ownerSecretPath, `${JSON.stringify({ v: 1, reset: now.toISOString() } satisfies OwnerSecretReset, null, 2)}\n`, 0o600);
    writeMarker(home, now);
    home.appendAudit([{ ts: now.toISOString(), peer: OWNER_PEER, gate: 'owner-secret', by: 'human', action: 'reset' }]);
  });
}

/** The note for a home that never had an owner passphrase: the plain fresh-install state, nothing to warn about. */
export const NO_OWNER_SECRET_NOTE = 'no owner passphrase is set, so auto-approve can be turned on only from an approval form ("Don\'t ask again for this contact"), not in the terminal or with rdv_auto_approve: the owner sets one with "rdv owner-secret set" in their own terminal';

/** What `rdv whoami` and `rdv_status` show: when it was set, or that it isn't (never the hash). */
export function ownerSecretInfo(home: Home): { set: string | null; reset?: string; missing?: true; locked_until?: string; note: string } {
  let r: OwnerSecretRecord | OwnerSecretReset | null;
  try {
    r = readAny(home);
  } catch (err) {
    return { set: null, note: (err as Error).message };
  }
  if (r && 'reset' in r) {
    const end = cooldownEnd(r, new Date());
    const what = r.missing ? `FILE DELETED (found gone ${r.reset}, counted as a reset)` : `RESET ${r.reset}`;
    return {
      set: null,
      reset: r.reset,
      ...(r.missing ? { missing: true as const } : {}),
      note: `OWNER PASSPHRASE ${what}: none is set, so auto-approve set before is off for everyone (only a "Don't ask again" box on an approval form can turn it on until a new one is set).${end ? `A new one can be set after ${end.toISOString()}` : 'Set a new one'} with "rdv owner-secret set" in your own terminal. If you did not ${r.missing ? 'delete owner-secret.json' : 'reset it'}, someone with access to your account did`,
    };
  }
  if (!r) return { set: null, note: NO_OWNER_SECRET_NOTE };
  return {
    set: r.set,
    ...(r.locked_until && Date.parse(r.locked_until) > Date.now() ? { locked_until: r.locked_until } : {}),
    note: `owner passphrase set ${r.set}; if you did not set it, run "rdv owner-secret reset" in your own terminal`,
  };
}

/** Is there a terminal device to read a secret from (/dev/tty, CONIN$)? */
export function terminalAvailable(): boolean {
  try {
    const fd = openSync(TERMINAL, 'r+');
    try {
      return isatty(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const TERMINAL = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';

/**
 * Read one line from the controlling terminal itself (/dev/tty, or CONIN$ on
 * Windows), not from stdin, with echo off. Enter ends it; Ctrl-C or Ctrl-D
 * cancels (an empty answer). Refused if there is no terminal to read.
 */
export function readTerminalSecret(question: string, prompt: (text: string) => void): Promise<string> {
  let fd: number;
  try {
    // Read-write: Windows sets a console's mode (echo off) only through a handle opened for writing too.
    fd = openSync(TERMINAL, 'r+');
  } catch {
    throw new CliError('no terminal to read the owner passphrase from: only you may do this, in your own terminal');
  }
  if (!isatty(fd)) {
    closeSync(fd);
    throw new CliError('no terminal to read the owner passphrase from: only you may do this, in your own terminal');
  }
  const input = new ReadStream(fd);
  prompt(question);
  return new Promise((resolve) => {
    let buf = '';
    const done = (v: string) => {
      input.removeListener('data', onData);
      try {
        input.setRawMode(false);
      } catch {
        // already closed
      }
      input.destroy();
      prompt('\n');
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u0003' || ch === '\u0004') return done('');
        if (ch === '\u007f' || ch === '\b') buf = [...buf].slice(0, -1).join('');
        else if (ch >= ' ' && buf.length <= OWNER_SECRET_MAX) buf += ch;
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.on('data', onData);
    input.on('error', () => done(''));
    input.resume();
  });
}
