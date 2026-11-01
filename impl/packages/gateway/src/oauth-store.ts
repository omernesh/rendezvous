// The OAuth 2.1 state of the gateway's built-in authorization server (slice
// 2): the signing key, the clients the owner approved, and their grants with
// refresh and access tokens. `gateway-oauth.json` in the home, mode 600,
// every token only as its SHA-256 (they are 256-bit random values).
// Restart-safe; `rdv-gateway oauth list|revoke` change it from a terminal
// beside a serving gateway, so every change is a read-modify-write under
// `gateway-oauth.lock`, and reads follow the file (stat).
//
// Registration is stateless (NOTES 93): a client id carries its registered
// metadata, signed with the key here, so registering writes nothing and a
// flood of registrations fills nothing. A client is stored only once the
// owner approved it and it exchanged its first code.
//
// A grant is a principal, exactly like a static token: its id keys MCP
// sessions and pending approvals, and revoking it drops both.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type Home, writeAtomic } from '@rendezvous/cli/lib';
import { randomToken, safeEqual, sha256 } from './http.js';
import { isRootBinding, ROOT_BINDING } from './agents.js';
import { isScope, type Scope } from './scopes.js';

/** Approved clients and grants: a cap, never an eviction (the owner revokes). */
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
/** Clients the owner revoked, remembered so a consent page opened before the revoke approves nothing. */
const MAX_REVOKED = 200;

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

/** What a client registered, as its signed client id carries it. */
export interface ClientMeta {
  /** The client id as issued (`rdvcl_<payload>.<mac>`). */
  clientId: string;
  /** Its short, stable name for grants, `oauth list` and `oauth revoke`: `cli_` + a hash of the client id. */
  ref: string;
  /** What the client called itself at registration: untrusted, shown as such. */
  name: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  /** The scopes it registered for, if it said. */
  scope?: Scope[];
  created: string;
}

/** A client the owner approved: stored. */
export interface OAuthClient extends ClientMeta {
  id: string;
  approved: true;
}

export interface AccessToken {
  hash: string;
  expires: number;
  scopes: Scope[];
}

export interface OAuthGrant {
  id: string;
  /** The client's ref (`cli_…`). */
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
  /** The one agent the owner connected it to on the consent page (NOTES 104): its name, or the root marker. Absent before that: the root agent. */
  agent?: string;
  /** The identity (rdv1:…) of that agent at consent: a migrate or resume never moves the grant to another. */
  agentId?: string;
}

export interface OAuthData {
  v: 1;
  /** The key that signs client ids and derives client secrets (base64). */
  key?: string;
  clients: Record<string, OAuthClient>;
  grants: Record<string, OAuthGrant>;
  /** Client ref → when the owner revoked it. */
  revoked: Record<string, number>;
}

const empty = (): OAuthData => ({ v: 1, clients: {}, grants: {}, revoked: {} });

export class OAuthStoreError extends Error {}

export const newGrantId = (): string => `grt_${randomToken(9)}`;
export const clientRef = (clientId: string): string => `cli_${sha256(clientId).slice(0, 24)}`;
const CLIENT_ID = /^rdvcl_([A-Za-z0-9_-]{8,6000})\.([A-Za-z0-9_-]{43})$/;

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
  private keyBytes?: Buffer;

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
    const data: OAuthData = { v: 1, key: raw.key, clients: raw.clients ?? {}, grants: raw.grants ?? {}, revoked: raw.revoked ?? {} };
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

  // --- stateless clients -----------------------------------------------------------

  /** The signing key, made once (it survives restarts, so issued client ids stay valid). */
  async key(): Promise<Buffer> {
    if (this.keyBytes) return this.keyBytes;
    let k = this.read().key;
    if (!k) k = await this.update((d) => (d.key ??= randomBytes(32).toString('base64')));
    this.keyBytes = Buffer.from(k, 'base64');
    return this.keyBytes;
  }

  private mac(key: Buffer, label: string, s: string): string {
    return createHmac('sha256', key).update(`rdv1/oauth-${label}\u0000${s}`).digest('base64url');
  }

  /** A new client (RFC 7591), already validated by the caller: nothing is stored; the id carries it, signed. */
  async issueClient(c: { name: string; redirectUris: string[]; authMethod: ClientAuthMethod; scope?: Scope[] }, now: number): Promise<{ meta: ClientMeta; secret?: string }> {
    const key = await this.key();
    const payload = Buffer.from(JSON.stringify({ v: 1, n: c.name, r: c.redirectUris, m: c.authMethod, ...(c.scope ? { s: c.scope } : {}), t: now, x: randomToken(6) })).toString('base64url');
    const clientId = `rdvcl_${payload}.${this.mac(key, 'client', payload)}`;
    const meta = this.decodeClient(clientId, key)!;
    return { meta, secret: c.authMethod === 'none' ? undefined : this.secretFor(key, clientId) };
  }

  private secretFor(key: Buffer, clientId: string): string {
    return `rdvs_${this.mac(key, 'secret', clientId)}`;
  }

  private decodeClient(clientId: string, key: Buffer): ClientMeta | undefined {
    const m = CLIENT_ID.exec(clientId);
    if (!m || !safeEqual(m[2], this.mac(key, 'client', m[1]))) return undefined;
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { v: number; n: string; r: string[]; m: ClientAuthMethod; s?: string[]; t: number };
      if (p.v !== 1 || typeof p.n !== 'string' || !Array.isArray(p.r) || typeof p.t !== 'number') return undefined;
      const scope = p.s?.filter(isScope);
      return { clientId, ref: clientRef(clientId), name: p.n, redirectUris: p.r, authMethod: p.m, ...(scope ? { scope } : {}), created: new Date(p.t).toISOString() };
    } catch {
      return undefined;
    }
  }

  /** The registered metadata a client id carries, if we signed it. */
  async resolveClient(clientId: string): Promise<ClientMeta | undefined> {
    return this.decodeClient(clientId, await this.key());
  }

  /** An approved (stored) client, by ref. */
  client(ref: string): OAuthClient | undefined {
    const d = this.read();
    return Object.hasOwn(d.clients, ref) ? d.clients[ref] : undefined;
  }

  /** When the owner last revoked this client, if ever. */
  revokedAt(ref: string): number | undefined {
    const d = this.read();
    return Object.hasOwn(d.revoked, ref) ? d.revoked[ref] : undefined;
  }

  /** Check a client's credentials at the token or revocation endpoint (secrets in constant time). */
  async checkClient(clientId: string, secret: string | undefined): Promise<ClientMeta | undefined> {
    const key = await this.key();
    const c = this.decodeClient(clientId, key);
    if (!c) return undefined;
    if (c.authMethod === 'none') return secret === undefined || secret === '' ? c : undefined;
    if (secret === undefined) return undefined;
    return safeEqual(secret, this.secretFor(key, clientId)) ? c : undefined;
  }

  // --- grants and tokens -----------------------------------------------------------

  /**
   * The owner approved (on a consent page issued at `consentAt`) and the client exchanged its code: the client is
   * stored if it was not yet, and a grant with its first tokens is made. A client the owner revoked after that page
   * was issued gets nothing.
   */
  async createGrant(client: ClientMeta, scopes: Scope[], resource: string, now: number, consentAt: number, id = newGrantId(), agent?: string, agentId?: string): Promise<IssuedTokens> {
    const accessToken = `rdvo_${randomToken(32)}`;
    const refreshToken = `rdvr_${randomToken(32)}`;
    const grant: OAuthGrant = {
      id,
      clientId: client.ref,
      scopes,
      resource,
      created: new Date(now).toISOString(),
      lastUsed: now,
      refresh: { hash: sha256(refreshToken), expires: now + REFRESH_TTL_MS },
      retired: [],
      access: [{ hash: sha256(accessToken), expires: now + ACCESS_TTL_MS, scopes }],
      ...(agent !== undefined ? { agent } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
    await this.update((d) => {
      if (Object.hasOwn(d.revoked, client.ref) && d.revoked[client.ref] >= consentAt) throw new OAuthStoreError('the owner removed that client since');
      this.prune(d, now);
      if (!Object.hasOwn(d.clients, client.ref)) {
        if (Object.keys(d.clients).length >= MAX_CLIENTS) throw new OAuthStoreError(`at most ${MAX_CLIENTS} connected clients; revoke one first (rdv-gateway oauth list)`);
        d.clients[client.ref] = { ...client, id: client.ref, approved: true };
      }
      const mine = Object.values(d.grants)
        .filter((g) => g.clientId === client.ref)
        .sort((a, b) => a.created.localeCompare(b.created));
      for (const g of mine.slice(0, Math.max(0, mine.length - MAX_GRANTS_PER_CLIENT + 1))) delete d.grants[g.id];
      if (Object.keys(d.grants).length >= MAX_GRANTS) throw new OAuthStoreError(`at most ${MAX_GRANTS} OAuth grants; revoke one first (rdv-gateway oauth list)`);
      d.grants[grant.id] = grant;
    });
    return { grant, accessToken, refreshToken, scopes };
  }

  /**
   * Rotate a refresh token: a new refresh token and a new access token. A
   * refresh token rotated out before, presented again, means two parties hold
   * it: the whole grant ends (its tokens and its pending approvals).
   */
  async refresh(ref: string, token: string, scopes: Scope[] | undefined, resourceOk: ((g: OAuthGrant) => boolean) | undefined, now: number): Promise<RefreshResult> {
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
      if (!current || current.clientId !== ref || current.refresh.expires <= now) return { error: 'invalid_grant' };
      if (resourceOk && !resourceOk(current)) return { error: 'invalid_target' };
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
  async revokeToken(ref: string, token: string): Promise<OAuthGrant | undefined> {
    const h = sha256(token);
    return this.update((d) => {
      for (const g of Object.values(d.grants)) {
        if (g.clientId !== ref) continue;
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

  /**
   * The owner's revoke, by client ref (the client and all its grants; a consent page for it issued before now
   * approves nothing) or grant id.
   */
  async revoke(id: string, now = Date.now()): Promise<{ client?: OAuthClient; grants: OAuthGrant[] } | undefined> {
    return this.update((d) => {
      // A client ref is remembered as revoked even when nothing is stored for it yet (approved on a page, its code
      // not exchanged): no consent or code from before now gets anything.
      if (Object.hasOwn(d.clients, id) || /^cli_[0-9a-f]{24}$/.test(id)) {
        const client = Object.hasOwn(d.clients, id) ? d.clients[id] : undefined;
        const grants = Object.values(d.grants).filter((g) => g.clientId === id);
        for (const g of grants) delete d.grants[g.id];
        delete d.clients[id];
        d.revoked[id] = now;
        const old = Object.entries(d.revoked).sort((a, b) => a[1] - b[1]);
        for (const [ref] of old.slice(0, Math.max(0, old.length - MAX_REVOKED))) delete d.revoked[ref];
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

  /**
   * `agent migrate`: grants of the root agent (the root marker, or none) now reach `to`, and a resource naming the
   * old agent's URL names the new one (the gateway's own resource stays). A grant naming the root's name itself is
   * stale, so it is not moved.
   */
  async rebindAgent(from: string, to: string): Promise<number> {
    return this.update((d) => {
      let n = 0;
      for (const g of Object.values(d.grants)) {
        if (isRootBinding(g.agent)) {
          g.agent = to;
          if (g.resource.endsWith(`/a/${from}/mcp`)) g.resource = `${g.resource.slice(0, -`/a/${from}/mcp`.length)}/a/${to}/mcp`;
          n += 1;
        }
      }
      return n;
    });
  }

  /** Grants made before identities were recorded get the identity they reach now (`identityOf` their binding). */
  async stampIdentities(identityOf: (binding: string | undefined) => string | undefined): Promise<number> {
    if (!Object.values(this.read().grants).some((g) => g.agentId === undefined && identityOf(g.agent))) return 0;
    return this.update((d) => {
      let n = 0;
      for (const g of Object.values(d.grants)) {
        const id = g.agentId === undefined ? identityOf(g.agent) : undefined;
        if (id) {
          g.agentId = id;
          n += 1;
        }
      }
      return n;
    });
  }

  /** Undoes rebindAgent when `agent migrate` fails after it: grants bound to `to` are the root agent's (`from`) again. */
  async unbindAgent(from: string, to: string): Promise<number> {
    return this.update((d) => {
      let n = 0;
      for (const g of Object.values(d.grants)) {
        if (g.agent === to) {
          g.agent = ROOT_BINDING;
          if (g.resource.endsWith(`/a/${to}/mcp`)) g.resource = `${g.resource.slice(0, -`/a/${to}/mcp`.length)}/a/${from}/mcp`;
          n += 1;
        }
      }
      return n;
    });
  }

  /** `agent remove --force`: every grant of that agent ends. */
  async revokeAgent(agent: string): Promise<string[]> {
    return this.update((d) => {
      const gone = Object.values(d.grants).filter((g) => g.agent === agent).map((g) => g.id);
      for (const id of gone) delete d.grants[id];
      return gone;
    });
  }

  async revokeGrant(id: string): Promise<void> {
    await this.update((d) => void delete d.grants[id]);
  }

  list(): { clients: Array<Omit<OAuthClient, 'clientId'>>; grants: Array<Pick<OAuthGrant, 'id' | 'clientId' | 'scopes' | 'created' | 'lastUsed' | 'agent' | 'agentId'>> } {
    const d = this.read();
    return {
      clients: Object.values(d.clients).map(({ clientId: _c, ...rest }) => rest),
      grants: Object.values(d.grants).map(({ id, clientId, scopes, created, lastUsed, agent, agentId }) => ({ id, clientId, scopes, created, lastUsed, ...(agent !== undefined ? { agent } : {}), ...(agentId !== undefined ? { agentId } : {}) })),
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
