// The gateway's own state, `gateway.json` in the home (mode 600): the
// owner's PIN hash and its lockout, and the API tokens. Every secret is
// stored only as a hash: API tokens are 256-bit random values, so SHA-256 is
// enough; the PIN is short, so it gets salted scrypt and a lockout that
// survives a restart.
//
// `rdv-gateway token create|revoke` and `pin set` run beside a serving
// gateway, so every change is a read-modify-write under `gateway.lock`, and
// reads follow the file (stat), so a revoke from a terminal applies at once.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type Home, writeAtomic } from '@rendezvous/cli/lib';
import { randomToken, safeEqual, sha256 } from './http.js';
import { isRootBinding, ROOT_BINDING } from './agents.js';
import { isScope, SCOPES, type Scope } from './scopes.js';

export const MAX_TOKENS = 50;
export const PIN_MIN = 6;
export const PIN_MAX = 128;
/** Failures before the backoff starts, and the longest wait. */
export const PIN_FREE_TRIES = 5;
export const PIN_MAX_LOCK_MS = 60 * 60_000;
/** Failed attempts are forgotten after this long without one. */
export const PIN_FORGET_MS = 24 * 60 * 60_000;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface ApiToken {
  id: string;
  name: string;
  /** sha256 of the token. */
  hash: string;
  scopes: Scope[];
  created: string;
  /**
   * The one agent this token reaches (NOTES 104): an agent's name, or the
   * root marker (ROOT_BINDING) for the root agent. Absent on a token made
   * before multi-agent gateways, which means the root agent too.
   */
  agent?: string;
  /** The identity (rdv1:…) of that agent when the token was made: a migrate or resume never moves it to another. */
  agentId?: string;
}

export interface StoreData {
  v: 1;
  owner?: { salt: string; hash: string; created: string };
  lockout: { failures: number; until?: number; last?: number };
  tokens: Record<string, ApiToken>;
}

const empty = (): StoreData => ({ v: 1, lockout: { failures: 0 }, tokens: {} });

function scrypt(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(Buffer.from(`rdv1/gateway-pin\u0000${pin.normalize('NFC')}`, 'utf8'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export class StoreError extends Error {}

/** Why a new PIN is refused (too short or long, one repeated character, a run of digits), if it is. */
export function pinRuleError(pin: string): string | undefined {
  if (pin.length < PIN_MIN || pin.length > PIN_MAX) return `the PIN must be ${PIN_MIN} to ${PIN_MAX} characters`;
  if (/^(.)\1*$/.test(pin) || '0123456789012345678901234567890'.includes(pin) || '9876543210987654321098765432109'.includes(pin)) {
    return 'pick a PIN that is not one repeated character or a run of digits';
  }
  return undefined;
}

/** `pinSetAt` is the PIN's `created` the check actually ran against: an effect it authorizes must still find that PIN in place. */
export type PinCheck = { ok: true; pinSetAt: string } | { ok: false; lockedFor?: number; noPin?: boolean };

export class GatewayStore {
  readonly path: string;
  private readonly lockPath: string;
  private cache?: { stamp: string; data: StoreData };
  /** One PIN check at a time, so parallel guesses can't all run before the first failure counts. */
  private pinChain: Promise<unknown> = Promise.resolve();

  constructor(readonly home: Home) {
    this.path = join(home.dir, 'gateway.json');
    this.lockPath = join(home.dir, 'gateway.lock');
  }

  /** The current state (re-read when the file changed). */
  read(): StoreData {
    if (!existsSync(this.path)) return empty();
    const st = statSync(this.path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (this.cache?.stamp === stamp) return this.cache.data;
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreData>;
    if (raw.v !== 1) throw new StoreError(`${this.path}: unknown version`);
    const data: StoreData = { ...empty(), ...raw, lockout: raw.lockout ?? { failures: 0 }, tokens: raw.tokens ?? {} } as StoreData;
    this.cache = { stamp, data };
    return data;
  }

  /** Read, change, write: under gateway.lock, so a terminal and the server can both write. */
  async update<T>(fn: (d: StoreData) => T): Promise<T> {
    this.home.ensureDir();
    const release = await acquireLock(this.lockPath);
    try {
      this.cache = undefined;
      const d = structuredClone(this.read());
      const r = fn(d);
      writeAtomic(this.path, `${JSON.stringify(d, null, 2)}\n`, 0o600);
      this.cache = undefined;
      return r;
    } finally {
      release();
    }
  }

  // --- the owner's PIN ---------------------------------------------------------

  hasPin(): boolean {
    return this.read().owner !== undefined;
  }

  /**
   * `rdv-gateway pin set`: the first PIN freely, a new one only with the
   * current one (checked like the page does, so a wrong one counts toward the
   * backoff). Otherwise anyone with a shell on this machine could replace
   * the PIN and approve on the page.
   */
  async changePin(current: string | undefined, next: string, now: number): Promise<void> {
    let checked: string | undefined;
    if (this.hasPin()) {
      if (current === undefined) throw new StoreError('a PIN is set: give the current one to change it');
      const check = await this.checkPin(current, now);
      if (!check.ok) {
        throw new StoreError(
          check.lockedFor ? `too many wrong PINs: try again in ${Math.ceil(check.lockedFor / 60_000)} minute(s); nothing changed` : 'that is not the current PIN; nothing changed',
        );
      }
      checked = check.pinSetAt;
    }
    await this.setPin(next, checked);
  }

  /** `onlyIfSetAt`: replace the PIN only while it is still the one that was checked (else StoreError, nothing written). */
  async setPin(pin: string, onlyIfSetAt?: string): Promise<void> {
    const why = pinRuleError(pin);
    if (why) throw new StoreError(why);
    const salt = randomBytes(16);
    const hash = await scrypt(pin, salt);
    await this.update((d) => {
      if (onlyIfSetAt !== undefined && d.owner?.created !== onlyIfSetAt) throw new StoreError('the PIN changed meanwhile; nothing changed');
      let created = new Date().toISOString();
      if (created === d.owner?.created) created = new Date(Date.parse(created) + 1).toISOString();
      d.owner = { salt: salt.toString('base64'), hash: hash.toString('base64'), created };
      d.lockout = { failures: 0 };
    });
  }

  /**
   * Check the owner's PIN: an exponential backoff, never a permanent lock.
   * After `freeTries` failures (default PIN_FREE_TRIES; more when the gateway
   * also counts per client) each further miss waits one minute, doubling up
   * to an hour; during a wait even the right PIN is refused, and the wait
   * survives a restart. Failures are forgotten after PIN_FORGET_MS without
   * one, and the owner clears them in their terminal (`rdv-gateway pin
   * unlock`, clearLockout).
   */
  checkPin(pin: string, now: number, freeTries = PIN_FREE_TRIES): Promise<PinCheck> {
    const run = this.pinChain.then(() => this.checkPinNow(pin, now, freeTries));
    this.pinChain = run.catch(() => {});
    return run;
  }

  /** The owner, in their terminal: forget every failed PIN attempt and any wait. */
  async clearLockout(): Promise<void> {
    await this.update((d) => void (d.lockout = { failures: 0 }));
  }

  /** When the PIN was set (an unlocked page session ends when it changes). */
  pinSetAt(): string | undefined {
    return this.read().owner?.created;
  }

  private async checkPinNow(pin: string, now: number, freeTries: number): Promise<PinCheck> {
    this.cache = undefined;
    const d = this.read();
    const owner = d.owner;
    if (!owner) return { ok: false, noPin: true };
    if (d.lockout.until && d.lockout.until > now) return { ok: false, lockedFor: d.lockout.until - now };
    const hash = await scrypt(pin.slice(0, PIN_MAX), Buffer.from(owner.salt, 'base64'));
    const want = Buffer.from(owner.hash, 'base64');
    if (hash.length === want.length && timingSafeEqual(hash, want)) {
      if (d.lockout.failures || d.lockout.until) await this.update((x) => void (x.lockout = { failures: 0 }));
      return { ok: true, pinSetAt: owner.created };
    }
    const lockout = await this.update((x) => {
      if (x.lockout.last !== undefined && now - x.lockout.last > PIN_FORGET_MS) x.lockout = { failures: 0 };
      x.lockout.failures += 1;
      x.lockout.last = now;
      const over = x.lockout.failures - freeTries;
      if (over >= 0) x.lockout.until = now + Math.min(PIN_MAX_LOCK_MS, 60_000 * 2 ** over);
      return x.lockout;
    });
    return { ok: false, lockedFor: lockout.until && lockout.until > now ? lockout.until - now : undefined };
  }

  // --- API tokens ----------------------------------------------------------------

  /** A new token for one agent: returned once, stored only as its hash. */
  async createToken(name: string, scopes: string[], agent?: string, agentId?: string): Promise<{ token: string; info: ApiToken }> {
    const n = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(n)) throw new StoreError('a token name is 1 to 48 letters, digits, spaces, dots, dashes or underscores');
    const bad = scopes.filter((s) => !isScope(s));
    if (bad.length) throw new StoreError(`unknown scope ${JSON.stringify(bad[0])}: the scopes are ${SCOPES.join(', ')} (none of them can approve anything)`);
    if (scopes.length === 0) throw new StoreError(`give at least one scope (${SCOPES.join(', ')})`);
    const token = `rdvg_${randomToken(32)}`;
    const info: ApiToken = {
      id: `tok_${randomToken(6)}`,
      name: n,
      hash: sha256(token),
      scopes: [...new Set(scopes as Scope[])],
      created: new Date().toISOString(),
      ...(agent !== undefined ? { agent } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
    await this.update((d) => {
      if (Object.keys(d.tokens).length >= MAX_TOKENS) throw new StoreError(`at most ${MAX_TOKENS} tokens; revoke one first`);
      // Names tell tokens apart on the approval page: one name, one token.
      if (Object.values(d.tokens).some((t) => t.name.toLowerCase() === n.toLowerCase())) throw new StoreError(`a token named "${n}" exists already; pick another name or revoke it first`);
      d.tokens[info.id] = info;
    });
    return { token, info };
  }

  listTokens(): Array<Omit<ApiToken, 'hash'>> {
    return Object.values(this.read().tokens).map(({ hash: _hash, ...rest }) => rest);
  }

  async revokeToken(id: string): Promise<boolean> {
    return this.update((d) => {
      if (!Object.hasOwn(d.tokens, id)) return false;
      delete d.tokens[id];
      return true;
    });
  }

  /**
   * `agent migrate`: tokens of the root agent (the root marker, or none) now reach `to`. A token naming the root's
   * name itself is stale (root tokens store the marker), so it is not moved.
   */
  async rebindAgent(_from: string, to: string): Promise<number> {
    return this.update((d) => {
      let n = 0;
      for (const t of Object.values(d.tokens)) {
        if (isRootBinding(t.agent)) {
          t.agent = to;
          n += 1;
        }
      }
      return n;
    });
  }

  /** Tokens made before identities were recorded get the identity they reach now (`identityOf` their binding). */
  async stampIdentities(identityOf: (binding: string | undefined, created: string) => string | undefined): Promise<number> {
    if (!Object.values(this.read().tokens).some((t) => t.agentId === undefined && identityOf(t.agent, t.created))) return 0;
    return this.update((d) => {
      let n = 0;
      for (const t of Object.values(d.tokens)) {
        const id = t.agentId === undefined ? identityOf(t.agent, t.created) : undefined;
        if (id) {
          t.agentId = id;
          n += 1;
        }
      }
      return n;
    });
  }

  /** Undoes rebindAgent when `agent migrate` fails after it: tokens bound to `to` are the root agent's again. */
  async unbindAgent(to: string): Promise<number> {
    return this.update((d) => {
      let n = 0;
      for (const t of Object.values(d.tokens)) {
        if (t.agent === to) {
          t.agent = ROOT_BINDING;
          n += 1;
        }
      }
      return n;
    });
  }

  /** `agent remove --force`: every token of that agent is revoked. */
  async revokeAgent(agent: string): Promise<string[]> {
    return this.update((d) => {
      const gone = Object.values(d.tokens).filter((t) => t.agent === agent).map((t) => t.id);
      for (const id of gone) delete d.tokens[id];
      return gone;
    });
  }

  /** The API token with this value, if any. Every stored hash is compared in constant time. */
  findToken(token: string): ApiToken | undefined {
    const h = sha256(token);
    let hit: ApiToken | undefined;
    for (const t of Object.values(this.read().tokens)) if (safeEqual(t.hash, h)) hit = t;
    return hit;
  }
}
