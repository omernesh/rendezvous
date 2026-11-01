// The gateway's built-in OAuth 2.1 authorization server (issue #12, slice
// 2), so ChatGPT connectors and claude.ai custom connectors connect without
// a static token. NOTES 93.
//
//   /.well-known/oauth-protected-resource[/mcp|/sse]  RFC 9728: this gateway's MCP URL and its authorization server
//   /.well-known/oauth-authorization-server           RFC 8414
//   /oauth/register      RFC 7591 dynamic client registration (https redirect URIs only, rate limited, stateless)
//   /oauth/authorize     authorization code + PKCE S256 only; the consent is the owner's PIN-locked page
//   /oauth/token         code exchange, rotating refresh tokens with reuse detection
//   /oauth/revoke        RFC 7009
//
// Nothing here can approve a Rendezvous step: an OAuth grant is a principal
// with scopes, exactly like a static token. The owner approves each client
// on the page (never automatically), may narrow its scopes there, and the
// approval is bound to a digest of exactly what the page showed. Tokens are
// bound to this gateway's resource (RFC 8707): one minted for another
// resource, or before the public URL changed, is refused.
//
// Nothing a stranger can do before the owner acts takes room (security
// review of PR #97): a client id is its own signed registration, and a parked
// authorization request is a signed, expiring link bound to the browser
// that started it. Only the owner's decisions are remembered (single use).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BRAND_HEADER } from './brand.js';
import { escapeHtml, HttpError, mediaType, RateLimiter, randomToken, readBody, redirect, safeEqual, sendJson, sha256 } from './http.js';
import { type ClientAuthMethod, type ClientMeta, type IssuedTokens, newGrantId, OAuthStore, OAuthStoreError } from './oauth-store.js';
import { isScope, SCOPES, type Scope } from './scopes.js';

/** An authorization request waiting for the owner's consent: decoded from its signed link (ten minutes). */
export interface PendingConsent {
  /** The signed link token (the consent page is /approve/oauth/<id>). */
  id: string;
  /** Single use and the browser binding are keyed by it. */
  nonce: string;
  /** The client's ref (`cli_…`). */
  clientId: string;
  /** As registered (untrusted), and as shown. */
  clientName: string;
  redirectUri: string;
  scopes: Scope[];
  resource: string;
  /** The agent the resource names (/a/<name>/mcp): fixed for this consent. Absent: the owner picks one on the page. */
  agent?: string;
  codeChallenge: string;
  state?: string;
  created: number;
  /** sha256 over everything the consent page shows and the code will carry. */
  digest: string;
}

interface Code {
  ref: string;
  redirectUri: string;
  scopes: Scope[];
  resource: string;
  /** The agent the owner connected the client to. */
  agent: string;
  codeChallenge: string;
  expires: number;
  /** When the consent page that made it was issued: a client revoked since gets nothing. */
  consentAt: number;
  used: boolean;
  /** The grant this code's exchange made: a second presentation of the code ends it (RFC 6749 §4.1.2). */
  grantId?: string;
  replayed?: boolean;
}

export const CONSENT_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
/** Codes are made only by the owner's approvals, so this bound is never reached by others. */
const MAX_CODES = 256;
const REG_BODY_MAX = 16 * 1024;
const TOKEN_BODY_MAX = 16 * 1024;
const MAX_REDIRECTS = 5;
const CLIENT_ID_MAX = 6200;
const CONSENT_ID = /^([A-Za-z0-9_-]{16,4000})\.([A-Za-z0-9_-]{43})$/;

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
  /** The agents this gateway serves (NOTES 104): a grant reaches exactly one of them. */
  agents?: () => readonly string[];
  /** What a grant for an agent stores (the root marker for the root agent), and the agent a stored binding names now. */
  binding?: (agent: string) => string;
  nameOf?: (binding: string | undefined) => string | undefined;
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
  private readonly codes = new Map<string, Code>();
  /** Consent links the owner decided (nonce → expiry): single use. Only the owner's own actions add here. */
  private readonly decided = new Map<string, number>();
  /** Signs consent links and their browser cookies; per process, like the consents (ten minutes). */
  private readonly linkKey = randomBytes(32);
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

  /** The protected resource a token is bound to: this gateway's MCP URL, or one agent's (/a/<name>/mcp, NOTES 104). */
  resource(agent?: string): string {
    return `${this.o.base()}${agent === undefined ? '' : `/a/${agent}`}/mcp`;
  }

  /**
   * The agent a `resource` value names (RFC 8707): `{}` for this gateway as a whole (its MCP URL, its legacy SSE
   * URL, its origin), `{ agent }` for one served agent's MCP or SSE URL, undefined for anything else.
   */
  resourceAgent(r: string): { agent?: string } | undefined {
    const base = this.o.base();
    if (r === this.resource() || r === `${base}/sse` || r === base || r === `${base}/`) return {};
    if (!r.startsWith(`${base}/a/`)) return undefined;
    const m = /^([a-z0-9][a-z0-9_-]{0,31})\/(mcp|sse)$/.exec(r.slice(base.length + 3));
    return m && (this.o.agents?.() ?? []).includes(m[1]) ? { agent: m[1] } : undefined;
  }

  /** A grant's stored resource: this gateway's MCP URL, or an agent's MCP URL under it. */
  private ownResource(r: string): boolean {
    const base = this.o.base();
    return r === this.resource() || (r.startsWith(`${base}/a/`) && /^[a-z0-9][a-z0-9_-]{0,31}\/mcp$/.test(r.slice(base.length + 3)));
  }

  /** Where a client finds the metadata for the endpoint it called (the SDK checks that the resource covers its URL). */
  resourceMetadataUrl(endpoint: 'mcp' | 'sse' = 'mcp', agent?: string): string {
    return `${this.o.base()}/.well-known/oauth-protected-resource${agent === undefined ? '' : `/a/${agent}`}/${endpoint}`;
  }

  // --- metadata ----------------------------------------------------------------------

  protectedResourceMetadata(endpoint: 'mcp' | 'sse' = 'mcp', agent?: string): Record<string, unknown> {
    return {
      resource: `${this.o.base()}${agent === undefined ? '' : `/a/${agent}`}/${endpoint}`,
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
      // Nothing is stored: the client id is this registration, signed. A client is stored once the owner approved it.
      const { meta: client, secret } = await this.store.issueClient({ name, redirectUris, authMethod: method, scope }, this.o.now());
      this.o.log(`OAuth client registered: ${JSON.stringify(client.name)} (${client.ref}), returning to ${redirectUris.map((u) => new URL(u).host).join(', ')}`);
      sendJson(res, 201, {
        client_id: client.clientId,
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
   * Validate an authorization request and park it for the owner's consent:
   * a signed, expiring link (nothing is stored). Until the client and its
   * exact redirect URI check out, an error is shown here and never
   * redirected. Errors after that go back to the client only once the owner
   * has approved that client before: anyone can register a client with any
   * https return address, so an unapproved client's errors stay on our page
   * too (no open redirect through registration, RFC 9700 §4.11.2). Returns
   * the consent link's token and nonce (the gateway binds the nonce to this
   * browser), or undefined when answered.
   */
  async authorize(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<{ id: string; nonce: string } | undefined> {
    const q = url.searchParams;
    for (const k of new Set(q.keys())) if (q.getAll(k).length > 1) return this.authError(res, `the parameter ${k} appears twice`);
    const clientId = q.get('client_id') ?? '';
    const client = clientId.length <= CLIENT_ID_MAX ? await this.store.resolveClient(clientId) : undefined;
    if (!client) return this.authError(res, 'This client is not registered here. Connect it again from your assistant.');
    const redirectUri = q.get('redirect_uri') ?? '';
    // Exact string match against what the client registered: no prefix, no added path or query.
    if (!client.redirectUris.includes(redirectUri)) return this.authError(res, 'The return address does not match what this client registered; nothing was sent anywhere.');
    const state = q.get('state') ?? undefined;
    const approved = this.store.client(client.ref) !== undefined;
    const back = (error: string, description: string): undefined => {
      if (!approved) return this.authError(res, `This connection request cannot go on (${error}: ${description}). Nothing was sent anywhere.`);
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
    const target = this.resourceAgent(q.get('resource') ?? this.resource());
    if (!target) return back('invalid_target', 'resource: this gateway, or one of its agents, only');
    const nonce = randomToken(16);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: client.ref,
        nm: client.name,
        r: redirectUri,
        s: scopes,
        res: this.resource(target.agent),
        ...(target.agent !== undefined ? { ag: target.agent } : {}),
        ch: codeChallenge,
        ...(state !== undefined ? { st: state } : {}),
        t: this.o.now(),
        n: nonce,
      }),
    ).toString('base64url');
    return { id: `${payload}.${this.linkMac('consent', payload)}`, nonce };
  }

  private linkMac(label: string, s: string): string {
    return createHmac('sha256', this.linkKey).update(`rdv1/oauth-${label}\u0000${s}`).digest('base64url');
  }

  /** The cookie value that binds a consent link to the browser that started it. */
  browserBinding(nonce: string): string {
    return this.linkMac('browser', nonce);
  }

  /** A consent link, if we signed it, it has not expired and it was not decided. */
  consent(id: string): PendingConsent | undefined {
    const m = CONSENT_ID.exec(id);
    if (!m || !safeEqual(m[2], this.linkMac('consent', m[1]))) return undefined;
    let x: { v: number; k: string; nm: string; r: string; s: Scope[]; res: string; ag?: string; ch: string; st?: string; t: number; n: string };
    try {
      x = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    const now = this.o.now();
    if (x.v !== 1 || now - x.t > CONSENT_TTL_MS || x.t > now + 60_000) return undefined;
    this.sweepDecided();
    if (this.decided.has(x.n)) return undefined;
    const p: PendingConsent = {
      id,
      nonce: x.n,
      clientId: x.k,
      clientName: x.nm,
      redirectUri: x.r,
      scopes: x.s,
      resource: x.res,
      ...(x.ag !== undefined ? { agent: x.ag } : {}),
      codeChallenge: x.ch,
      state: x.st,
      created: x.t,
      digest: '',
    };
    p.digest = consentDigest(p);
    return p;
  }

  /**
   * The owner's answer on the consent page, bound to the digest of what the
   * page showed. Approve: a one-time code for the scopes the owner kept (a
   * subset of those asked) and the one agent the owner picked (the one the
   * resource names, when it names one). Returns the URL to send the browser
   * back to.
   */
  decide(p: PendingConsent, digest: string, decision: 'approve' | 'decline', kept: Scope[], agent?: string): { redirect: string } | { error: string; stale?: boolean } {
    this.sweepDecided();
    if (this.decided.has(p.nonce)) return { error: 'This was answered already.' };
    if (!safeEqual(digest, p.digest)) return { error: 'This changed since you opened the page. Nothing was done; review it again.', stale: true };
    // A client the owner revoked after this page was issued: nothing.
    const revoked = this.store.revokedAt(p.clientId);
    if (revoked !== undefined && revoked >= p.created) {
      this.decided.set(p.nonce, p.created + CONSENT_TTL_MS);
      return { error: 'You removed this client since; nothing was approved.' };
    }
    const scopes = SCOPES.filter((s) => kept.includes(s) && p.scopes.includes(s));
    if (decision === 'approve' && (scopes.length === 0 || kept.some((s) => !p.scopes.includes(s)))) {
      return { error: 'Keep at least one of the permissions it asked for (you cannot add others).' };
    }
    // Exactly one agent: one this gateway serves, and the one the resource names when it names one.
    const served = this.o.agents?.() ?? [];
    if (decision === 'approve' && (agent === undefined || !served.includes(agent) || (p.agent !== undefined && agent !== p.agent))) {
      return { error: p.agent !== undefined && agent !== undefined && agent !== p.agent ? 'This client asked for another agent; nothing was approved.' : 'Choose the agent it connects to.' };
    }
    // Decided: remembered until the link expires, so the same answer can never run again.
    this.decided.set(p.nonce, p.created + CONSENT_TTL_MS);
    const iss = this.o.base();
    if (decision === 'decline') {
      this.o.log(`OAuth: you declined ${JSON.stringify(p.clientName)} (${p.clientId})`);
      return { redirect: withParams(p.redirectUri, { error: 'access_denied', error_description: 'the owner said no', state: p.state, iss }) };
    }
    const code = `rdvc_${randomToken(32)}`;
    this.sweepCodes();
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    this.codes.set(sha256(code), {
      ref: p.clientId,
      consentAt: p.created,
      redirectUri: p.redirectUri,
      scopes,
      resource: p.resource,
      agent: agent!,
      codeChallenge: p.codeChallenge,
      expires: this.o.now() + CODE_TTL_MS,
      used: false,
    });
    this.o.log(`OAuth: you approved ${JSON.stringify(p.clientName)} (${p.clientId}) for ${scopes.join(', ')}, agent ${agent}`);
    return { redirect: withParams(p.redirectUri, { code, state: p.state, iss }) };
  }

  // --- token endpoint ---------------------------------------------------------------

  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') throw new OAuthError(405, 'invalid_request', 'POST only');
      this.limit(this.tokenLimiter, req, 'token requests');
      const form = await this.form(req);
      const client = await this.authenticateClient(req, form);
      const grantType = form.get('grant_type');
      const out =
        grantType === 'authorization_code'
          ? await this.exchangeCode(client, form)
          : grantType === 'refresh_token'
            ? await this.refreshGrant(client.ref, form)
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

  private async exchangeCode(client: ClientMeta, form: URLSearchParams): Promise<IssuedTokens> {
    const key = sha256(form.get('code') ?? '');
    const c = this.codes.get(key);
    if (!c || c.ref !== client.ref) throw new OAuthError(400, 'invalid_grant', 'unknown or expired code');
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
    const target = resource === null ? {} : this.resourceAgent(resource);
    // A resource naming an agent names the one the owner connected, never another.
    if (!target || (target.agent !== undefined && target.agent !== c.agent)) throw new OAuthError(400, 'invalid_target', 'resource: this gateway, or the agent you were connected to, only');
    // The grant's id is known before the write, so a second presentation racing it still ends that grant.
    c.grantId = newGrantId();
    try {
      const issued = await this.store.createGrant(client, c.scopes, c.resource, this.o.now(), c.consentAt, c.grantId, this.o.binding ? this.o.binding(c.agent) : c.agent);
      if (c.replayed) {
        // Presented again while this grant was being written: it ends now.
        await this.store.revokeGrant(issued.grant.id);
        throw new OAuthError(400, 'invalid_grant', 'this code was used twice');
      }
      this.o.log(`OAuth: grant ${issued.grant.id} for client ${client.ref} (${issued.scopes.join(', ')})`);
      return issued;
    } catch (err) {
      if (err instanceof OAuthStoreError) throw new OAuthError(400, 'invalid_grant', err.message);
      throw err;
    }
  }

  private async refreshGrant(ref: string, form: URLSearchParams): Promise<IssuedTokens> {
    const token = form.get('refresh_token') ?? '';
    if (!/^rdvr_[A-Za-z0-9_-]{20,80}$/.test(token)) throw new OAuthError(400, 'invalid_grant', 'unknown refresh token');
    let scopes: Scope[] | undefined;
    const s = form.get('scope');
    if (s !== null) {
      scopes = parseScope(s);
      if (!scopes) throw new OAuthError(400, 'invalid_scope', `scope: some of ${SCOPES.join(' ')}`);
    }
    const resource = form.get('resource');
    const target = resource === null ? {} : this.resourceAgent(resource);
    if (!target) throw new OAuthError(400, 'invalid_target', 'resource: this gateway only');
    // A resource naming an agent must name the grant's own agent (as it is called now); the gateway's own resource fits any.
    const nameOf = this.o.nameOf ?? ((b: string | undefined) => b);
    const ok = target.agent === undefined ? undefined : (g: { agent?: string }) => nameOf(g.agent) === target.agent;
    const r = await this.store.refresh(ref, token, scopes, ok, this.o.now());
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
      const client = await this.authenticateClient(req, form);
      const token = form.get('token') ?? '';
      if (token.length > 0 && token.length <= 200) {
        const ended = await this.store.revokeToken(client.ref, token);
        if (ended) {
          this.o.onGrantEnded?.(ended.id);
          this.o.log(`OAuth: client ${client.ref} revoked grant ${ended.id}`);
        }
      }
      res.writeHead(200, { 'Content-Length': 0 });
      res.end();
    } catch (err) {
      this.fail(res, err);
    }
  }

  /** The principal behind an OAuth access token for this gateway, if it is live, and the agent its grant reaches. */
  verifyAccess(token: string): { id: string; name: string; scopes: Scope[]; agent?: string } | undefined {
    const hit = this.store.findAccess(token, this.o.now());
    // Bound to this gateway's resource or one of its agents' (which agent is the grant's binding, not the URL): one minted
    // for another (or before the public URL changed) is refused.
    const g = hit?.grant;
    if (!hit || !g || !this.ownResource(g.resource)) return undefined;
    return { id: g.id, name: `${hit.client.name} (OAuth ${g.id})`, scopes: hit.scopes, ...(g.agent !== undefined ? { agent: g.agent } : {}) };
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
  private async authenticateClient(req: IncomingMessage, form: URLSearchParams): Promise<ClientMeta> {
    let id = form.get('client_id') ?? undefined;
    let secret = form.get('client_secret') ?? undefined;
    const h = String(req.headers.authorization ?? '');
    const basic = /^Basic ([A-Za-z0-9+/=]{1,9000})$/.exec(h);
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
    const c = id && id.length <= CLIENT_ID_MAX ? await this.store.checkClient(id, secret) : undefined;
    if (!c) throw new OAuthError(401, 'invalid_client', 'client authentication failed', basic ? { 'WWW-Authenticate': 'Basic realm="rendezvous"' } : {});
    return c;
  }

  private authError(res: ServerResponse, text: string, status = 400): undefined {
    // Shown here, never redirected: the return address is not trusted yet.
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cannot connect</title><link rel="stylesheet" href="/assets/gateway.css"></head><body>${BRAND_HEADER}<main><h1>Cannot connect this client</h1><p>${escapeHtml(text)}</p></main></body></html>`;
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

  private sweepDecided(): void {
    const t = this.o.now();
    for (const [n, until] of this.decided) if (until < t) this.decided.delete(n);
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
