// The gateway's built-in OAuth 2.1 authorization server (issue #12, slice
// 2), so ChatGPT connectors and claude.ai custom connectors connect without
// a static token. NOTES 93.
//
//   /.well-known/oauth-protected-resource[/mcp]  RFC 9728: this gateway's MCP URL and its authorization server
//   /.well-known/oauth-authorization-server      RFC 8414
//   /oauth/register                              RFC 7591 dynamic client registration (https redirect URIs only, rate limited)
//   /oauth/authorize                             authorization code + PKCE S256 only; the consent is the owner's PIN-locked page
//   /oauth/token                                 code exchange, rotating refresh tokens with reuse detection
//   /oauth/revoke                                RFC 7009
//
// Nothing here can approve a Rendezvous step: an OAuth grant is a principal
// with scopes, exactly like a static token. The owner approves each client
// on the page (never automatically), may narrow its scopes there, and the
// approval is bound to a digest of exactly what the page showed. Tokens are
// bound to this gateway's resource (RFC 8707): one minted for another
// resource, or before the public URL changed, is refused.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { escapeHtml, HttpError, mediaType, RateLimiter, randomToken, readBody, redirect, safeEqual, sendJson, sha256 } from './http.js';
import { type ClientAuthMethod, type IssuedTokens, newGrantId, OAuthStore, OAuthStoreError } from './oauth-store.js';
import { isScope, SCOPES, type Scope } from './scopes.js';

/** An authorization request waiting for the owner's consent (memory; ten minutes). */
export interface PendingConsent {
  id: string;
  clientId: string;
  /** As registered (untrusted), and as shown. */
  clientName: string;
  redirectUri: string;
  scopes: Scope[];
  resource: string;
  codeChallenge: string;
  state?: string;
  created: number;
  /** Who asked (the client address key): each asker holds a few, so nobody can push out another's. */
  asker: string;
  /** sha256 over everything the consent page shows and the code will carry. */
  digest: string;
  busy?: boolean;
}

interface Code {
  clientId: string;
  redirectUri: string;
  scopes: Scope[];
  resource: string;
  codeChallenge: string;
  expires: number;
  used: boolean;
  /** The grant this code's exchange made: a second presentation of the code ends it (RFC 6749 §4.1.2). */
  grantId?: string;
  replayed?: boolean;
}

export const CONSENT_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
/** Parked consents per asker (its own oldest goes) and in all (then new ones wait): one stranger can't evict the owner's. */
const MAX_PENDING_PER_ASKER = 8;
const MAX_PENDING = 256;
const MAX_CODES = 256;
const REG_BODY_MAX = 16 * 1024;
const TOKEN_BODY_MAX = 16 * 1024;
const MAX_REDIRECTS = 5;

export interface OAuthServerOptions {
  home: OAuthStore['home'];
  /** The gateway's public base URL (its origin) at the time of the call. */
  base: () => string;
  now: () => number;
  /** The client address key (the tunnel header when configured). */
  clientKey: (req: IncomingMessage) => string;
  log: (line: string) => void;
  /** A grant ended (revoked, or its refresh token reused): the gateway drops its sessions. */
  onGrantEnded?: (grantId: string) => void;
}

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export class OAuthServer {
  readonly store: OAuthStore;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, Code>();
  /**
   * Registrations per client address: a rate that refills, never a lock. Generous, since a cloud assistant
   * registers from its vendor's servers, shared with everyone else on that vendor.
   */
  private readonly regLimiter: RateLimiter;
  private readonly tokenLimiter: RateLimiter;

  constructor(private readonly o: OAuthServerOptions) {
    this.store = new OAuthStore(o.home);
    this.regLimiter = new RateLimiter(30, 10 * 60_000, o.now);
    this.tokenLimiter = new RateLimiter(60, 60_000, o.now);
  }

  /** The protected resource every token is bound to: this gateway's MCP URL. */
  resource(): string {
    return `${this.o.base()}/mcp`;
  }

  /** `resource` values that name this gateway (RFC 8707): its MCP URL, its legacy SSE URL, or its origin. */
  private isOurResource(r: string): boolean {
    const base = this.o.base();
    return r === this.resource() || r === `${base}/sse` || r === base || r === `${base}/`;
  }

  /** Where a client finds the metadata for the endpoint it called (the SDK checks that the resource covers its URL). */
  resourceMetadataUrl(endpoint: 'mcp' | 'sse' = 'mcp'): string {
    return `${this.o.base()}/.well-known/oauth-protected-resource/${endpoint}`;
  }

  // --- metadata ----------------------------------------------------------------------

  protectedResourceMetadata(endpoint: 'mcp' | 'sse' = 'mcp'): Record<string, unknown> {
    return {
      resource: `${this.o.base()}/${endpoint}`,
      authorization_servers: [this.o.base()],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Rendezvous gateway',
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.o.base();
    const methods: ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: [...SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: methods,
      revocation_endpoint_auth_methods_supported: methods,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // --- RFC 7591 registration ------------------------------------------------------------

  async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      this.limit(this.regLimiter, req, 'registrations');
      if (mediaType(req) !== 'application/json') throw new OAuthError(415, 'invalid_client_metadata', 'send application/json');
      let m: Record<string, unknown>;
      try {
        m = JSON.parse((await readBody(req, REG_BODY_MAX)).toString('utf8')) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new OAuthError(400, 'invalid_client_metadata', 'the body is not valid JSON');
      }
      if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new OAuthError(400, 'invalid_client_metadata', 'a JSON object');
      const uris = m.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS) {
        throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uris: 1 to ${MAX_REDIRECTS} https URLs`);
      }
      const redirectUris = uris.map((u) => {
        const why = redirectProblem(u);
        if (why) throw new OAuthError(400, 'invalid_redirect_uri', why);
        return u as string;
      });
      const grantTypes = m.grant_types ?? ['authorization_code'];
      if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code') || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
        throw new OAuthError(400, 'invalid_client_metadata', 'grant_types: authorization_code (and refresh_token) only');
      }
      const responseTypes = m.response_types ?? ['code'];
      if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
        throw new OAuthError(400, 'invalid_client_metadata', 'response_types: code only');
      }
      const method = m.token_endpoint_auth_method ?? 'client_secret_basic';
      if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
        throw new OAuthError(400, 'invalid_client_metadata', 'token_endpoint_auth_method: none, client_secret_post or client_secret_basic');
      }
      let scope: Scope[] | undefined;
      if (m.scope !== undefined) {
        scope = parseScope(m.scope);
        if (!scope) throw new OAuthError(400, 'invalid_client_metadata', `scope: some of ${SCOPES.join(' ')}`);
      }
      const name = cleanName(m.client_name);
      const { client, secret } = await this.store.registerClient({ name, redirectUris, authMethod: method, scope }, this.o.now()).catch((err) => {
        if (err instanceof OAuthStoreError) throw new OAuthError(err.busy ? 429 : 400, err.busy ? 'slow_down' : 'invalid_client_metadata', err.message, err.busy ? { 'Retry-After': '300' } : {});
        throw err;
      });
      this.o.log(`OAuth client registered: ${JSON.stringify(client.name)} (${client.id}), returning to ${redirectUris.map((u) => new URL(u).host).join(', ')}`);
      sendJson(res, 201, {
        client_id: client.id,
        client_id_issued_at: Math.floor(Date.parse(client.created) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: client.authMethod,
        ...(client.scope ? { scope: client.scope.join(' ') } : {}),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      });
    } catch (err) {
      this.fail(res, err);
    }
  }

  // --- authorization endpoint ---------------------------------------------------------

  /**
   * Validate an authorization request and park it for the owner's consent.
   * Until the client and its exact redirect URI check out, an error is shown
   * here and never redirected (no open redirect); after that, errors go back
   * to the client. Returns the parked request's id (the gateway binds it to
   * this browser), or undefined when answered.
   */
  authorize(req: IncomingMessage, res: ServerResponse, url: URL): string | undefined {
    const q = url.searchParams;
    for (const k of new Set(q.keys())) if (q.getAll(k).length > 1) return this.authError(res, `the parameter ${k} appears twice`);
    const clientId = q.get('client_id') ?? '';
    const client = /^cli_[A-Za-z0-9_-]{8,40}$/.test(clientId) ? this.store.client(clientId) : undefined;
    if (!client) return this.authError(res, 'This client is not registered here (or was removed). Connect it again from your assistant.');
    const redirectUri = q.get('redirect_uri') ?? '';
    // Exact string match against what the client registered: no prefix, no added path or query.
    if (!client.redirectUris.includes(redirectUri)) return this.authError(res, 'The return address does not match what this client registered; nothing was sent anywhere.');
    const state = q.get('state') ?? undefined;
    const back = (error: string, description: string): undefined => {
      redirect(res, withParams(redirectUri, { error, error_description: description, state, iss: this.o.base() }), {}, 303);
      return undefined;
    };
    if (state !== undefined && (state.length > 512 || /[\p{Cc}]/u.test(state))) return back('invalid_request', 'state: at most 512 characters');
    if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (q.get('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
    const codeChallenge = q.get('code_challenge') ?? '';
    if (!CHALLENGE.test(codeChallenge)) return back('invalid_request', 'code_challenge: the base64url SHA-256 of the verifier');
    if (q.has('request') || q.has('request_uri')) return back('request_not_supported', 'request objects are not supported');
    const requested = q.get('scope');
    const asked = requested === null || requested.trim() === '' ? (client.scope ?? [...SCOPES]) : parseScope(requested);
    // Never more than the client registered for, when it said.
    const scopes = asked?.filter((s) => !client.scope || client.scope.includes(s));
    if (!scopes || scopes.length === 0) return back('invalid_scope', `scope: some of ${(client.scope ?? SCOPES).join(' ')}`);
    const resource = q.get('resource') ?? this.resource();
    if (!this.isOurResource(resource)) return back('invalid_target', 'resource: this gateway only');
    this.sweep();
    const asker = this.o.clientKey(req);
    const mine = [...this.pending.values()].filter((x) => x.asker === asker);
    for (const x of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_ASKER + 1))) this.pending.delete(x.id);
    if (this.pending.size >= MAX_PENDING) return this.authError(res, 'Too many connection requests wait right now; try again in a few minutes.', 429);
    const id = `oar_${randomToken(18)}`;
    const p: PendingConsent = { id, clientId, clientName: client.name, redirectUri, scopes, resource: this.resource(), codeChallenge, state, created: this.o.now(), asker, digest: '' };
    p.digest = consentDigest(p);
    this.pending.set(id, p);
    return id;
  }

  consent(id: string): PendingConsent | undefined {
    this.sweep();
    return this.pending.get(id);
  }

  /**
   * The owner's answer on the consent page, bound to the digest of what the
   * page showed. Approve: a one-time code for the scopes the owner kept (a
   * subset of those asked). Returns the URL to send the browser back to.
   */
  decide(p: PendingConsent, digest: string, decision: 'approve' | 'decline', kept: Scope[]): { redirect: string } | { error: string; stale?: boolean } {
    if (p.busy) return { error: 'This is already being answered.' };
    if (!safeEqual(digest, p.digest)) return { error: 'This changed since you opened the page. Nothing was done; review it again.', stale: true };
    // The client as it is now must still be the one shown: same name and return address.
    const client = this.store.client(p.clientId);
    if (!client || client.name !== p.clientName || !client.redirectUris.includes(p.redirectUri) || consentDigest(p) !== p.digest) {
      this.pending.delete(p.id);
      return { error: 'This client was removed or changed since; nothing was approved.' };
    }
    const scopes = SCOPES.filter((s) => kept.includes(s) && p.scopes.includes(s));
    if (decision === 'approve' && (scopes.length === 0 || kept.some((s) => !p.scopes.includes(s)))) {
      return { error: 'Keep at least one of the permissions it asked for (you cannot add others).' };
    }
    // Decided: gone, so the same answer can never run again.
    p.busy = true;
    this.pending.delete(p.id);
    const iss = this.o.base();
    if (decision === 'decline') {
      this.o.log(`OAuth: you declined ${JSON.stringify(p.clientName)} (${p.clientId})`);
      return { redirect: withParams(p.redirectUri, { error: 'access_denied', error_description: 'the owner said no', state: p.state, iss }) };
    }
    const code = `rdvc_${randomToken(32)}`;
    this.sweepCodes();
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    this.codes.set(sha256(code), {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      scopes,
      resource: p.resource,
      codeChallenge: p.codeChallenge,
      expires: this.o.now() + CODE_TTL_MS,
      used: false,
    });
    this.o.log(`OAuth: you approved ${JSON.stringify(p.clientName)} (${p.clientId}) for ${scopes.join(', ')}`);
    return { redirect: withParams(p.redirectUri, { code, state: p.state, iss }) };
  }

  // --- token endpoint ---------------------------------------------------------------

  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      this.limit(this.tokenLimiter, req, 'token requests');
      const form = await this.form(req);
      const client = this.authenticateClient(req, form);
      const grantType = form.get('grant_type');
      const out =
        grantType === 'authorization_code'
          ? await this.exchangeCode(client.id, form)
          : grantType === 'refresh_token'
            ? await this.refreshGrant(client.id, form)
            : (() => {
                throw new OAuthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
              })();
      sendJson(
        res,
        200,
        {
          access_token: out.accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor((out.grant.access.at(-1)!.expires - this.o.now()) / 1000),
          refresh_token: out.refreshToken,
          scope: out.scopes.join(' '),
        },
        { Pragma: 'no-cache' },
      );
    } catch (err) {
      this.fail(res, err);
    }
  }

  private async exchangeCode(clientId: string, form: URLSearchParams): Promise<IssuedTokens> {
    const key = sha256(form.get('code') ?? '');
    const c = this.codes.get(key);
    if (!c || c.clientId !== clientId) throw new OAuthError(400, 'invalid_grant', 'unknown or expired code');
    if (c.used) {
      // A code presented twice: whoever has it besides the client, the grant it made ends.
      if (c.grantId) {
        c.replayed = true;
        await this.store.revokeGrant(c.grantId);
        this.o.onGrantEnded?.(c.grantId);
        this.o.log(`OAuth: an authorization code was used twice; grant ${c.grantId} ended`);
      }
      throw new OAuthError(400, 'invalid_grant', 'this code was used already');
    }
    // One presentation per code, whatever the outcome.
    c.used = true;
    if (c.expires <= this.o.now()) throw new OAuthError(400, 'invalid_grant', 'the code expired');
    if (form.get('redirect_uri') !== c.redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri differs from the authorization request');
    const verifier = form.get('code_verifier') ?? '';
    if (!VERIFIER.test(verifier) || !safeEqual(b64url(createHash('sha256').update(verifier).digest()), c.codeChallenge)) {
      throw new OAuthError(400, 'invalid_grant', 'the PKCE code_verifier does not match');
    }
    const resource = form.get('resource');
    if (resource !== null && !this.isOurResource(resource)) throw new OAuthError(400, 'invalid_target', 'resource: this gateway only');
    // The grant's id is known before the write, so a second presentation racing it still ends that grant.
    c.grantId = newGrantId();
    try {
      const issued = await this.store.createGrant(clientId, c.scopes, c.resource, this.o.now(), c.grantId);
      if (c.replayed) {
        // Presented again while this grant was being written: it ends now.
        await this.store.revokeGrant(issued.grant.id);
        throw new OAuthError(400, 'invalid_grant', 'this code was used twice');
      }
      this.o.log(`OAuth: grant ${issued.grant.id} for client ${clientId} (${issued.scopes.join(', ')})`);
      return issued;
    } catch (err) {
      if (err instanceof OAuthStoreError) throw new OAuthError(400, 'invalid_grant', err.message);
      throw err;
    }
  }

  private async refreshGrant(clientId: string, form: URLSearchParams): Promise<IssuedTokens> {
    const token = form.get('refresh_token') ?? '';
    if (!/^rdvr_[A-Za-z0-9_-]{20,80}$/.test(token)) throw new OAuthError(400, 'invalid_grant', 'unknown refresh token');
    let scopes: Scope[] | undefined;
    const s = form.get('scope');
    if (s !== null) {
      scopes = parseScope(s);
      if (!scopes) throw new OAuthError(400, 'invalid_scope', `scope: some of ${SCOPES.join(' ')}`);
    }
    const resource = form.get('resource');
    if (resource !== null && !this.isOurResource(resource)) throw new OAuthError(400, 'invalid_target', 'resource: this gateway only');
    const r = await this.store.refresh(clientId, token, scopes, resource === null ? undefined : this.resource(), this.o.now());
    if ('error' in r) {
      if (r.reused) {
        this.o.onGrantEnded?.(r.reused.id);
        this.o.log(`OAuth: a rotated refresh token of grant ${r.reused.id} was used again; the grant ended (connect the client again)`);
      }
      throw new OAuthError(400, r.error, r.error === 'invalid_scope' ? 'more than the grant allows' : r.error === 'invalid_target' ? 'resource: this grant\'s only' : 'unknown, expired or reused refresh token');
    }
    return r;
  }

  // --- RFC 7009 revocation ----------------------------------------------------------------

  async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      this.limit(this.tokenLimiter, req, 'token requests');
      const form = await this.form(req);
      const client = this.authenticateClient(req, form);
      const token = form.get('token') ?? '';
      if (token.length > 0 && token.length <= 200) {
        const ended = await this.store.revokeToken(client.id, token);
        if (ended) {
          this.o.onGrantEnded?.(ended.id);
          this.o.log(`OAuth: client ${client.id} revoked grant ${ended.id}`);
        }
      }
      res.writeHead(200, { 'Content-Length': 0 });
      res.end();
    } catch (err) {
      this.fail(res, err);
    }
  }

  /** The principal behind an OAuth access token for this gateway, if it is live. */
  verifyAccess(token: string): { id: string; name: string; scopes: Scope[] } | undefined {
    const hit = this.store.findAccess(token, this.o.now());
    // Bound to this gateway's resource: a token minted for another (or before the public URL changed) is refused.
    if (!hit || hit.grant.resource !== this.resource()) return undefined;
    return { id: hit.grant.id, name: `${hit.client.name} (OAuth ${hit.grant.id})`, scopes: hit.scopes };
  }

  // --- helpers -----------------------------------------------------------------------

  private limit(l: RateLimiter, req: IncomingMessage, what: string): void {
    const wait = l.take(this.o.clientKey(req));
    if (wait) throw new OAuthError(429, 'slow_down', `too many ${what}; retry in ${wait}s`, { 'Retry-After': String(wait) });
  }

  private async form(req: IncomingMessage): Promise<URLSearchParams> {
    if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new OAuthError(400, 'invalid_request', 'send application/x-www-form-urlencoded');
    const form = new URLSearchParams((await readBody(req, TOKEN_BODY_MAX)).toString('utf8'));
    for (const k of new Set(form.keys())) if (form.getAll(k).length > 1) throw new OAuthError(400, 'invalid_request', `the parameter ${k} appears twice`);
    return form;
  }

  /** Client authentication: client_secret_basic, client_secret_post, or none (a public client: its client_id). */
  private authenticateClient(req: IncomingMessage, form: URLSearchParams) {
    let id = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const h = String(req.headers.authorization ?? '');
    const basic = /^Basic ([A-Za-z0-9+/=]{1,400})$/.exec(h);
    if (basic) {
      const raw = Buffer.from(basic[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i < 0) throw new OAuthError(401, 'invalid_client', 'client authentication failed', { 'WWW-Authenticate': 'Basic realm="rendezvous"' });
      let bid: string;
      let bsecret: string;
      try {
        bid = decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' '));
        bsecret = decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' '));
      } catch {
        throw new OAuthError(401, 'invalid_client', 'client authentication failed', { 'WWW-Authenticate': 'Basic realm="rendezvous"' });
      }
      if ((id !== undefined && id !== bid) || secret !== undefined) throw new OAuthError(400, 'invalid_request', 'use one client authentication method');
      id = bid;
      secret = bsecret;
    }
    const c = id && /^cli_[A-Za-z0-9_-]{8,40}$/.test(id) ? this.store.checkClient(id, secret) : undefined;
    if (!c) throw new OAuthError(401, 'invalid_client', 'client authentication failed', basic ? { 'WWW-Authenticate': 'Basic realm="rendezvous"' } : {});
    return c;
  }

  private authError(res: ServerResponse, text: string, status = 400): undefined {
    // Shown here, never redirected: the return address is not trusted yet.
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect</title><link rel="stylesheet" href="/assets/gateway.css"></head><body><main><h1>Cannot connect this client</h1><p>${escapeHtml(text)}</p></main></body></html>`;
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
    return undefined;
  }

  private fail(res: ServerResponse, err: unknown): void {
    if (err instanceof OAuthError) return sendJson(res, err.status, { error: err.error, error_description: err.message }, err.headers);
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.status === 413 ? 'invalid_request' : err.code, error_description: err.message }, err.headers);
    this.o.log(`OAuth endpoint error: ${(err as Error).message}`);
    sendJson(res, 500, { error: 'server_error', error_description: 'internal error; the details are in the gateway log' });
  }

  private sweep(): void {
    const t = this.o.now();
    for (const [id, p] of this.pending) if (t - p.created > CONSENT_TTL_MS) this.pending.delete(id);
  }

  private sweepCodes(): void {
    const t = this.o.now();
    // Used codes are kept until they expire, so a second presentation is recognized.
    for (const [k, c] of this.codes) if (c.expires + CODE_TTL_MS <= t) this.codes.delete(k);
  }
}

/** Why a redirect URI is refused (undefined: fine). https only, no fragment, no credentials. */
export function redirectProblem(u: unknown): string | undefined {
  if (typeof u !== 'string' || u.length > 512) return 'a redirect URI is a string of at most 512 characters';
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return 'a redirect URI is an absolute URL';
  }
  if (url.protocol !== 'https:') return 'redirect URIs must be https';
  if (url.hash || u.includes('#')) return 'a redirect URI has no fragment';
  if (url.username || url.password) return 'a redirect URI has no user or password';
  if (!url.hostname) return 'a redirect URI names a host';
  if (/[\s\p{Cc}]/u.test(u)) return 'a redirect URI has no spaces or control characters';
  return undefined;
}

function parseScope(s: unknown): Scope[] | undefined {
  if (typeof s !== 'string' || s.length > 200) return undefined;
  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !isScope(p))) return undefined;
  return SCOPES.filter((x) => parts.includes(x));
}

/** A client name as the page shows it: no control or format characters, at most 64 characters. */
function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 64) : '';
  return s || 'unnamed client';
}

export function consentDigest(p: Pick<PendingConsent, 'clientId' | 'clientName' | 'redirectUri' | 'scopes' | 'resource' | 'codeChallenge' | 'state'>): string {
  return sha256(JSON.stringify(['rdv1/oauth-consent', p.clientId, p.clientName, p.redirectUri, p.scopes, p.resource, p.codeChallenge, p.state ?? null]));
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
