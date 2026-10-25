// The gateway's own state, `gateway.json` in the home (mode 600): the
// owner's PIN hash and lockout, API tokens, OAuth clients and refresh
// tokens. Every secret is stored only as a hash: API tokens, refresh tokens
// and client secrets are 256-bit random values, so SHA-256 is enough; the
// PIN is short, so it gets scrypt (NOTES 64).
//
// `rdv-gateway token create|revoke` runs beside a serving gateway, so every
// change is a read-modify-write under `gateway.lock`, and reads follow the
// file (stat) so a revoke from a terminal applies at once.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type Home, writeAtomic } from '@rendezvous/cli/lib';
import { randomToken, safeEqual, sha256 } from './http.js';

export const SCOPES = ['read', 'send', 'contact:request', 'negotiate'] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

export const MAX_TOKENS = 50;
export const MAX_CLIENTS = 100;
/** Refresh tokens kept per client (each rotation adds one; used ones stay until they expire, for reuse detection). */
export const MAX_REFRESH_PER_CLIENT = 40;
export const PIN_MIN = 6;
export const PIN_MAX = 128;
/** Failures before the PIN locks, and the longest lockout. */
export const PIN_FREE_TRIES = 5;
export const PIN_MAX_LOCK_MS = 60 * 60_000;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface ApiToken {
  id: string;
  name: string;
  /** sha256 of the token. */
  hash: string;
  scopes: Scope[];
  created: string;
}

export interface OAuthClient {
  client_id: string;
  /** sha256 of the secret, for confidential clients. */
  secret_hash?: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  created: string;
  /** Set once the owner approved it on the consent screen. */
  authorized?: string;
}

export interface RefreshRecord {
  client_id: string;
  scopes: Scope[];
  family: string;
  resource: string;
  expires: number;
  /** Rotated away: presenting it again revokes the whole family (reuse detection). */
  used?: boolean;
}

export interface StoreData {
  v: 1;
  owner?: { salt: string; hash: string; created: string };
  lockout: { failures: number; until?: number };
  tokens: Record<string, ApiToken>;
  clients: Record<string, OAuthClient>;
  /** Keyed by sha256 of the refresh token. */
  refresh: Record<string, RefreshRecord>;
}

const empty = (): StoreData => ({ v: 1, lockout: { failures: 0 }, tokens: {}, clients: {}, refresh: {} });

function scrypt(pin: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(Buffer.from(`rdv1/gateway-pin\u0000${pin.normalize('NFC')}`, 'utf8'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export class StoreError extends Error {}

export class GatewayStore {
  readonly path: string;
  private readonly lockPath: string;
  private cache?: { stamp: string; data: StoreData };

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
    const data: StoreData = { ...empty(), ...raw, lockout: raw.lockout ?? { failures: 0 } } as StoreData;
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

  hasOwner(): boolean {
    return this.read().owner !== undefined;
  }

  async setOwnerPin(pin: string): Promise<void> {
    if (pin.length < PIN_MIN || pin.length > PIN_MAX) throw new StoreError(`the PIN must be ${PIN_MIN} to ${PIN_MAX} characters`);
    const salt = randomBytes(16);
    const hash = await scrypt(pin, salt);
    await this.update((d) => {
      d.owner = { salt: salt.toString('base64'), hash: hash.toString('base64'), created: new Date().toISOString() };
      d.lockout = { failures: 0 };
    });
  }

  /**
   * Check the owner's PIN. While locked out (after PIN_FREE_TRIES failures,
   * 1 minute, doubling per further failure up to an hour) even the right PIN
   * is refused, and the lockout survives a restart.
   */
  checkPin(pin: string, now: number): Promise<{ ok: true } | { ok: false; lockedFor?: number }> {
    // One check at a time, so parallel guesses can't all run before the first failure counts.
    const run = this.pinChain.then(() => this.checkPinNow(pin, now));
    this.pinChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private pinChain: Promise<void> = Promise.resolve();

  private async checkPinNow(pin: string, now: number): Promise<{ ok: true } | { ok: false; lockedFor?: number }> {
    this.cache = undefined;
    const d = this.read();
    if (!d.owner) return { ok: false };
    if (d.lockout.until && d.lockout.until > now) return { ok: false, lockedFor: d.lockout.until - now };
    const hash = await scrypt(pin.slice(0, PIN_MAX), Buffer.from(d.owner.salt, 'base64'));
    const want = Buffer.from(d.owner.hash, 'base64');
    if (hash.length === want.length && timingSafeEqual(hash, want)) {
      if (d.lockout.failures || d.lockout.until) await this.update((x) => void (x.lockout = { failures: 0 }));
      return { ok: true };
    }
    const lockout = await this.update((x) => {
      x.lockout.failures += 1;
      const over = x.lockout.failures - PIN_FREE_TRIES;
      if (over >= 0) x.lockout.until = now + Math.min(PIN_MAX_LOCK_MS, 60_000 * 2 ** over);
      return x.lockout;
    });
    return { ok: false, lockedFor: lockout.until && lockout.until > now ? lockout.until - now : undefined };
  }

  // --- API tokens ----------------------------------------------------------------

  /** A new token: returned once, stored only as its hash. */
  async createToken(name: string, scopes: Scope[]): Promise<{ token: string; info: ApiToken }> {
    const n = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(n)) throw new StoreError('a token name is 1 to 48 letters, digits, spaces, dots, dashes or underscores');
    if (scopes.length === 0) throw new StoreError(`give at least one scope (${SCOPES.join(', ')})`);
    const token = `rdvg_${randomToken(32)}`;
    const info: ApiToken = { id: `tok_${randomToken(6)}`, name: n, hash: sha256(token), scopes: [...new Set(scopes)], created: new Date().toISOString() };
    await this.update((d) => {
      if (Object.keys(d.tokens).length >= MAX_TOKENS) throw new StoreError(`at most ${MAX_TOKENS} tokens; revoke one first`);
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

  /** The API token with this value, if any. Every stored hash is compared in constant time. */
  findToken(token: string): ApiToken | undefined {
    const h = sha256(token);
    let hit: ApiToken | undefined;
    for (const t of Object.values(this.read().tokens)) if (safeEqual(t.hash, h)) hit = t;
    return hit;
  }

  // --- OAuth clients and refresh tokens ------------------------------------------------

  client(id: string): OAuthClient | undefined {
    const c = this.read().clients;
    return Object.hasOwn(c, id) ? c[id] : undefined;
  }

  async addClient(c: OAuthClient, now: number): Promise<void> {
    await this.update((d) => {
      if (Object.keys(d.clients).length >= MAX_CLIENTS) {
        // Make room by dropping clients registered more than a day ago that the owner never approved.
        for (const x of Object.values(d.clients)) if (!x.authorized && now - Date.parse(x.created) > 86_400_000) delete d.clients[x.client_id];
      }
      if (Object.keys(d.clients).length >= MAX_CLIENTS) throw new StoreError('too many registered clients; revoke some on the approval page');
      d.clients[c.client_id] = c;
    });
  }

  async markAuthorized(clientId: string): Promise<void> {
    await this.update((d) => {
      if (Object.hasOwn(d.clients, clientId)) d.clients[clientId].authorized ??= new Date().toISOString();
    });
  }

  /** Remove a client and every refresh token it holds. */
  async revokeClient(clientId: string): Promise<boolean> {
    return this.update((d) => {
      if (!Object.hasOwn(d.clients, clientId)) return false;
      delete d.clients[clientId];
      for (const [k, r] of Object.entries(d.refresh)) if (r.client_id === clientId) delete d.refresh[k];
      return true;
    });
  }

  async addRefresh(token: string, r: RefreshRecord, now: number): Promise<void> {
    await this.update((d) => {
      for (const [k, x] of Object.entries(d.refresh)) if (x.expires <= now) delete d.refresh[k];
      const mine = Object.entries(d.refresh).filter(([, x]) => x.client_id === r.client_id);
      // Over the cap: drop the client's oldest (soonest expiring) ones.
      mine.sort((a, b) => a[1].expires - b[1].expires);
      for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_REFRESH_PER_CLIENT + 1))) delete d.refresh[k];
      d.refresh[sha256(token)] = r;
    });
  }

  /**
   * Rotate a refresh token. A used one revokes its whole family (it was
   * stolen, or the client is replaying); an expired, unknown or foreign one
   * is refused.
   */
  async useRefresh(token: string, clientId: string, now: number): Promise<{ ok: true; record: RefreshRecord } | { ok: false; revokedFamily?: string }> {
    const h = sha256(token);
    return this.update((d) => {
      const r = Object.hasOwn(d.refresh, h) ? d.refresh[h] : undefined;
      if (!r || r.client_id !== clientId || r.expires <= now) return { ok: false as const };
      if (r.used) {
        for (const [k, x] of Object.entries(d.refresh)) if (x.family === r.family) delete d.refresh[k];
        return { ok: false as const, revokedFamily: r.family };
      }
      r.used = true;
      return { ok: true as const, record: { ...r } };
    });
  }

  /** RFC 7009: revoke the family a refresh token belongs to. */
  async revokeRefresh(token: string, clientId: string): Promise<string | undefined> {
    const h = sha256(token);
    return this.update((d) => {
      const r = Object.hasOwn(d.refresh, h) ? d.refresh[h] : undefined;
      if (!r || r.client_id !== clientId) return undefined;
      for (const [k, x] of Object.entries(d.refresh)) if (x.family === r.family) delete d.refresh[k];
      return r.family;
    });
  }
}
