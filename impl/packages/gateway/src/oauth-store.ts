// The OAuth 2.1 state of the gateway's built-in authorization server (slice
// 2): registered clients, and the grants the owner approved on the page with
// their refresh and access tokens. `gateway-oauth.json` in the home, mode
// 600, every secret only as its SHA-256 (they are 256-bit random values).
// Restart-safe; `rdv-gateway oauth list|revoke` change it from a terminal
// beside a serving gateway, so every change is a read-modify-write under
// `gateway-oauth.lock`, and reads follow the file (stat).
//
// A grant is a principal, exactly like a static token: its id keys MCP
// sessions and pending approvals, and revoking it drops both.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type Home, writeAtomic } from '@rendezvous/cli/lib';
import { randomToken, safeEqual, sha256 } from './http.js';
import type { Scope } from './scopes.js';

/**
 * Clients the owner never approved: kept at most this many, since anyone can register one. The oldest goes, but
 * never one younger than CLIENT_GRACE_MS (it may be the owner's, mid-connect): then new registrations wait.
 */
export const MAX_UNAPPROVED_CLIENTS = 200;
export const CLIENT_GRACE_MS = 15 * 60_000;
/** Clients with a grant at some point, and grants: a cap, never an eviction (the owner revokes). */
export const MAX_CLIENTS = 50;
export const MAX_GRANTS = 50;
/** One client may hold a few grants (connected again from another account): a new one ends its oldest. */
export const MAX_GRANTS_PER_CLIENT = 4;
export const ACCESS_TTL_MS = 60 * 60_000;
/** A refresh token unused this long is dead (the owner connects again). */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Live access tokens per grant (each refresh adds one; the oldest goes). */
const MAX_ACCESS_PER_GRANT = 4;
/** Retired refresh tokens remembered per grant, so their reuse is recognized and ends the grant. */
const MAX_RETIRED = 64;

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClient {
  id: string;
  /** What the client called itself at registration: untrusted, shown as such. */
  name: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  /** sha256 of the client secret (secret methods only). */
  secretHash?: string;
  /** The scopes it registered for, if it said. */
  scope?: Scope[];
  created: string;
  /** The owner approved it at least once (unapproved clients may be evicted). */
  approved?: boolean;
}

export interface AccessToken {
  hash: string;
  expires: number;
  scopes: Scope[];
}

export interface OAuthGrant {
  id: string;
  clientId: string;
  scopes: Scope[];
  /** The resource (RFC 8707) the tokens are for: this gateway's MCP URL. */
  resource: string;
  created: string;
  lastUsed: number;
  refresh: { hash: string; expires: number };
  /** Hashes of refresh tokens rotated out: presenting one again ends the grant (reuse detection). */
  retired: string[];
  access: AccessToken[];
}

export interface OAuthData {
  v: 1;
  clients: Record<string, OAuthClient>;
  grants: Record<string, OAuthGrant>;
}

const empty = (): OAuthData => ({ v: 1, clients: {}, grants: {} });

export class OAuthStoreError extends Error {
  /** Full for now: retry later (429), not a bad request. */
  busy?: boolean;
}

export const newGrantId = (): string => `grt_${randomToken(9)}`;

export interface IssuedTokens {
  grant: OAuthGrant;
  accessToken: string;
  refreshToken: string;
  scopes: Scope[];
}

export type RefreshResult = IssuedTokens | { error: 'invalid_grant' | 'invalid_scope' | 'invalid_target'; reused?: OAuthGrant };

export class OAuthStore {
  readonly path: string;
  private readonly lockPath: string;
  private cache?: { stamp: string; data: OAuthData };

  constructor(readonly home: Home) {
    this.path = join(home.dir, 'gateway-oauth.json');
    this.lockPath = join(home.dir, 'gateway-oauth.lock');
  }

  read(): OAuthData {
    if (!existsSync(this.path)) return empty();
    const st = statSync(this.path);
    const stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (this.cache?.stamp === stamp) return this.cache.data;
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<OAuthData>;
    if (raw.v !== 1) throw new OAuthStoreError(`${this.path}: unknown version`);
    const data: OAuthData = { v: 1, clients: raw.clients ?? {}, grants: raw.grants ?? {} };
    this.cache = { stamp, data };
    return data;
  }

  async update<T>(fn: (d: OAuthData) => T): Promise<T> {
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

  // --- clients -------------------------------------------------------------------

  /** A new client (RFC 7591), already validated by the caller; returns its secret once, for a secret method. */
  async registerClient(c: { name: string; redirectUris: string[]; authMethod: ClientAuthMethod; scope?: Scope[] }, now: number): Promise<{ client: OAuthClient; secret?: string }> {
    const secret = c.authMethod === 'none' ? undefined : `rdvs_${randomToken(32)}`;
    const client: OAuthClient = {
      id: `cli_${randomToken(12)}`,
      name: c.name,
      redirectUris: c.redirectUris,
      authMethod: c.authMethod,
      ...(secret ? { secretHash: sha256(secret) } : {}),
      ...(c.scope ? { scope: c.scope } : {}),
      created: new Date(now).toISOString(),
    };
    await this.update((d) => {
      const all = Object.values(d.clients);
      // Anyone can register, so unapproved clients are bounded by evicting the oldest: they hold nothing. A young one
      // may be in the middle of its owner's consent, so it is never evicted; then registration waits instead.
      const unapproved = all.filter((x) => !x.approved).sort((a, b) => a.created.localeCompare(b.created));
      const evictable = unapproved.filter((x) => now - Date.parse(x.created) > CLIENT_GRACE_MS);
      const over = unapproved.length - MAX_UNAPPROVED_CLIENTS + 1;
      for (const x of evictable.slice(0, Math.max(0, over))) delete d.clients[x.id];
      if (over > evictable.length) {
        const e = new OAuthStoreError('too many new clients registered in the last minutes; retry in a few minutes');
        e.busy = true;
        throw e;
      }
      if (all.filter((x) => x.approved).length >= MAX_CLIENTS) throw new OAuthStoreError(`at most ${MAX_CLIENTS} connected clients; the owner revokes one first`);
      d.clients[client.id] = client;
    });
    return { client, secret };
  }

  client(id: string): OAuthClient | undefined {
    const d = this.read();
    return Object.hasOwn(d.clients, id) ? d.clients[id] : undefined;
  }

  /** Check a client's credentials at the token or revocation endpoint (secrets in constant time). */
  checkClient(id: string, secret: string | undefined): OAuthClient | undefined {
    const c = this.client(id);
    if (!c) return undefined;
    if (c.authMethod === 'none') return secret === undefined || secret === '' ? c : undefined;
    if (secret === undefined || !c.secretHash) return undefined;
    return safeEqual(sha256(secret), c.secretHash) ? c : undefined;
  }

  // --- grants and tokens -----------------------------------------------------------

  /** The owner approved and the client exchanged its code: a grant with its first tokens. */
  async createGrant(clientId: string, scopes: Scope[], resource: string, now: number, id = newGrantId()): Promise<IssuedTokens> {
    const accessToken = `rdvo_${randomToken(32)}`;
    const refreshToken = `rdvr_${randomToken(32)}`;
    const grant: OAuthGrant = {
      id,
      clientId,
      scopes,
      resource,
      created: new Date(now).toISOString(),
      lastUsed: now,
      refresh: { hash: sha256(refreshToken), expires: now + REFRESH_TTL_MS },
      retired: [],
      access: [{ hash: sha256(accessToken), expires: now + ACCESS_TTL_MS, scopes }],
    };
    await this.update((d) => {
      if (!Object.hasOwn(d.clients, clientId)) throw new OAuthStoreError('that client was removed');
      this.prune(d, now);
      const mine = Object.values(d.grants)
        .filter((g) => g.clientId === clientId)
        .sort((a, b) => a.created.localeCompare(b.created));
      for (const g of mine.slice(0, Math.max(0, mine.length - MAX_GRANTS_PER_CLIENT + 1))) delete d.grants[g.id];
      if (Object.keys(d.grants).length >= MAX_GRANTS) throw new OAuthStoreError(`at most ${MAX_GRANTS} OAuth grants; revoke one first (rdv-gateway oauth list)`);
      d.clients[clientId].approved = true;
      d.grants[grant.id] = grant;
    });
    return { grant, accessToken, refreshToken, scopes };
  }

  /**
   * Rotate a refresh token: a new refresh token and a new access token. A
   * refresh token rotated out before, presented again, means two parties hold
   * it: the whole grant ends (its tokens and its pending approvals).
   */
  async refresh(clientId: string, token: string, scopes: Scope[] | undefined, resource: string | undefined, now: number): Promise<RefreshResult> {
    const h = sha256(token);
    const accessToken = `rdvo_${randomToken(32)}`;
    const refreshToken = `rdvr_${randomToken(32)}`;
    return this.update((d): RefreshResult => {
      this.prune(d, now);
      let current: OAuthGrant | undefined;
      let reused: OAuthGrant | undefined;
      for (const g of Object.values(d.grants)) {
        if (safeEqual(g.refresh.hash, h)) current = g;
        for (const r of g.retired) if (safeEqual(r, h)) reused = g;
      }
      if (reused) {
        delete d.grants[reused.id];
        return { error: 'invalid_grant', reused };
      }
      if (!current || current.clientId !== clientId || current.refresh.expires <= now) return { error: 'invalid_grant' };
      if (resource !== undefined && resource !== current.resource) return { error: 'invalid_target' };
      const granted = scopes ?? current.scopes;
      if (granted.length === 0 || granted.some((s) => !current!.scopes.includes(s))) return { error: 'invalid_scope' };
      current.retired = [...current.retired, current.refresh.hash].slice(-MAX_RETIRED);
      current.refresh = { hash: sha256(refreshToken), expires: now + REFRESH_TTL_MS };
      current.access = [...current.access, { hash: sha256(accessToken), expires: now + ACCESS_TTL_MS, scopes: granted }].slice(-MAX_ACCESS_PER_GRANT);
      current.lastUsed = now;
      return { grant: current, accessToken, refreshToken, scopes: granted };
    });
  }

  /** The grant and scopes of a live access token (every stored hash compared in constant time). */
  findAccess(token: string, now: number): { grant: OAuthGrant; client: OAuthClient; scopes: Scope[] } | undefined {
    const h = sha256(token);
    const d = this.read();
    let hit: { grant: OAuthGrant; at: AccessToken } | undefined;
    for (const g of Object.values(d.grants)) for (const a of g.access) if (safeEqual(a.hash, h)) hit = { grant: g, at: a };
    if (!hit || hit.at.expires <= now) return undefined;
    const client = Object.hasOwn(d.clients, hit.grant.clientId) ? d.clients[hit.grant.clientId] : undefined;
    if (!client) return undefined;
    return { grant: hit.grant, client, scopes: hit.at.scopes.filter((s) => hit!.grant.scopes.includes(s)) };
  }

  grant(id: string): OAuthGrant | undefined {
    const d = this.read();
    return Object.hasOwn(d.grants, id) ? d.grants[id] : undefined;
  }

  /**
   * RFC 7009 for one client's token: a refresh token ends its grant, an
   * access token only itself. A token of another client, or none, changes
   * nothing (the endpoint answers 200 either way). Returns the ended grant.
   */
  async revokeToken(clientId: string, token: string): Promise<OAuthGrant | undefined> {
    const h = sha256(token);
    return this.update((d) => {
      for (const g of Object.values(d.grants)) {
        if (g.clientId !== clientId) continue;
        if (safeEqual(g.refresh.hash, h) || g.retired.some((r) => safeEqual(r, h))) {
          delete d.grants[g.id];
          return g;
        }
        const left = g.access.filter((a) => !safeEqual(a.hash, h));
        if (left.length !== g.access.length) g.access = left;
      }
      return undefined;
    });
  }

  /** The owner's revoke, by client id (the client and all its grants) or grant id. */
  async revoke(id: string): Promise<{ client?: OAuthClient; grants: OAuthGrant[] } | undefined> {
    return this.update((d) => {
      if (Object.hasOwn(d.clients, id)) {
        const client = d.clients[id];
        const grants = Object.values(d.grants).filter((g) => g.clientId === id);
        for (const g of grants) delete d.grants[g.id];
        delete d.clients[id];
        return { client, grants };
      }
      if (Object.hasOwn(d.grants, id)) {
        const g = d.grants[id];
        delete d.grants[id];
        return { grants: [g] };
      }
      return undefined;
    });
  }

  async revokeGrant(id: string): Promise<void> {
    await this.update((d) => void delete d.grants[id]);
  }

  list(): { clients: Array<Omit<OAuthClient, 'secretHash'>>; grants: Array<Pick<OAuthGrant, 'id' | 'clientId' | 'scopes' | 'created' | 'lastUsed'>> } {
    const d = this.read();
    return {
      clients: Object.values(d.clients).map(({ secretHash: _s, ...rest }) => rest),
      grants: Object.values(d.grants).map(({ id, clientId, scopes, created, lastUsed }) => ({ id, clientId, scopes, created, lastUsed })),
    };
  }

  /** Whether this principal id is a live grant. */
  hasGrant(id: string): boolean {
    return Object.hasOwn(this.read().grants, id);
  }

  /** Drop what has expired: dead refresh tokens end their grant; expired access tokens go. */
  private prune(d: OAuthData, now: number): void {
    for (const [id, g] of Object.entries(d.grants)) {
      if (g.refresh.expires <= now || !Object.hasOwn(d.clients, g.clientId)) {
        delete d.grants[id];
        continue;
      }
      g.access = g.access.filter((a) => a.expires > now);
    }
  }
}
