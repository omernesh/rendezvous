// rdv-gateway (issue #12): the owner's Rendezvous agent behind their own
// HTTPS endpoint, for cloud assistants that can only reach a public URL. It
// runs on the owner's machine, the key never leaves it, and it shares the
// home with rdv / rdv-mcp (same files, same locks; one inbound consumer per
// home: like a second rdv-mcp, it attaches when another process holds
// listener.lock, issue #9).
//
//   /mcp            MCP over Streamable HTTP (bearer token, a session per client)
//   /api/v1/tools/* the same tools over REST (bearer token); /openapi.json describes them
//   /sse            the same MCP over the legacy HTTP+SSE transport (POSTs to /messages)
//   /approve        the owner's PIN-locked approval page: the only place anything is approved
//   /oauth/*, /.well-known/oauth-*   the built-in OAuth 2.1 authorization server (oauth.ts, slice 2)
//
// Consent never passes through the cloud assistant: the tools run in the MCP
// server's remote mode, where every step that needs the human returns
// `awaiting_human` with a link to /approve/<id>. That page shows the exact
// form the step would have shown, and the owner's answer is bound to its
// digest (RdvMcpServer.answer re-checks it from the state, and the step's
// own check under the home lock binds the commit). Auth is one seam
// (`authenticate`): a static token or an OAuth access token, each a principal
// with scopes; neither can approve anything.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Home } from '@rendezvous/cli/lib';
import { RdvMcpServer } from '@rendezvous/mcp';
import { Approvals, FormInputError, type PendingApproval, typeContent } from './approvals.js';
import {
  HttpError,
  hmac,
  isLoopbackHost,
  parseCookies,
  RateLimiter,
  randomToken,
  readForm,
  readJson,
  redirect,
  safeEqual,
  securityHeaders,
  sendHtml,
  sendJson,
} from './http.js';
import { OAuthServer } from './oauth.js';
import { openApi } from './openapi.js';
import { approvalPage, consentCsp, consentPage, CSS, donePage, errorPage, type Flash, listPage, PAGE_CSP, unlockPage } from './pages.js';
import { authorizeCall, SCOPES, type Scope, toolScopes } from './scopes.js';
import { GatewayStore } from './store.js';

export const DEFAULT_PORT = 8787;
export const API_BODY_MAX = 256 * 1024;
export const FORM_BODY_MAX = 64 * 1024;
export const MAX_MCP_SESSIONS = 32;
/** MCP sessions one token may hold: a new one closes that token's least recently used. */
export const MAX_MCP_SESSIONS_PER_TOKEN = 4;
const MCP_IDLE_MS = 30 * 60_000;
/** How often sessions of revoked principals (and idle ones) are closed. */
const SESSION_SWEEP_MS = 30_000;
/** The owner's unlocked page: idle and absolute lifetimes, and how many at once. */
const OWNER_IDLE_MS = 15 * 60_000;
const OWNER_MAX_MS = 60 * 60_000;
const MAX_OWNER_SESSIONS = 16;

export interface GatewayOptions {
  home: Home;
  /** Bind address; loopback by default. Anything else needs `allowRemoteBind`. */
  host?: string;
  port?: number;
  allowRemoteBind?: boolean;
  /** The public base URL the owner's tunnel serves (https; http only for loopback). Approval links use it. */
  publicUrl?: string;
  calendar?: string;
  calendarDirs?: string[];
  window?: string;
  tz?: string;
  humanLog?: (line: string) => void;
  pollMs?: number;
  sweepMs?: number;
  /** Requests per minute per token (API and MCP together). */
  tokenRate?: number;
  /**
   * The header your tunnel puts the client's address in (e.g.
   * cf-connecting-ip, x-forwarded-for: its last entry). Set it only when
   * every request comes through that tunnel: anyone reaching the gateway
   * directly could write it. With it, wrong PINs are also counted per client.
   */
  clientIpHeader?: string;
  now?: () => number;
}

/** Who a request is, once authenticated: the seam slice 2's OAuth plugs into. */
export interface Principal {
  id: string;
  name: string;
  scopes: Scope[];
}

interface McpSession {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  mcp: McpServer;
  principal: string;
  lastSeen: number;
}

interface OwnerSession {
  created: number;
  lastSeen: number;
  /** When the PIN it was unlocked with was set: a new PIN ends the session. */
  pinSetAt?: string;
}

/** Wrong PINs before a client's own backoff starts, and the global free tries when clients are told apart. */
export const CLIENT_FREE_TRIES = 3;
export const GLOBAL_FREE_TRIES_PER_CLIENT_MODE = 20;
const CLIENT_MAX_WAIT_MS = 60 * 60_000;
const CLIENT_FORGET_MS = 24 * 60 * 60_000;

export class Gateway {
  readonly store: GatewayStore;
  readonly approvals: Approvals;
  readonly server: RdvMcpServer;
  readonly oauth: OAuthServer;
  private http?: Server;
  private sweeper?: NodeJS.Timeout;
  private base = '';
  private readonly allowedHosts = new Set<string>();
  /** Origins our own page posts from: the public origin and this machine's. */
  private readonly origins = new Set<string>();
  private readonly sessions = new Map<string, McpSession>();
  private readonly owners = new Map<string, OwnerSession>();
  /** Signs CSRF tokens; per process, like the owner sessions it protects. */
  private readonly key = randomBytes(32);
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly tokenLimiter: RateLimiter;
  private readonly pageLimiter: RateLimiter;
  private readonly unlockLimiter: RateLimiter;
  /** Wrong PINs per client (only told apart with clientIpHeader): a backoff, in memory, bounded. */
  private readonly clientFailures = new Map<string, { failures: number; until?: number; last: number }>();
  private openapi?: string;
  private readonly secure: boolean;

  constructor(private readonly opts: GatewayOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.humanLog ?? ((line) => process.stderr.write(`[rdv-gateway] ${line}\n`));
    this.store = new GatewayStore(opts.home);
    const host = opts.host ?? '127.0.0.1';
    if (!isLoopbackHost(host) && !opts.allowRemoteBind) {
      throw new Error(`refusing to bind ${host}: the gateway listens on this machine only unless you pass --allow-remote-bind (put your tunnel in front of 127.0.0.1 instead)`);
    }
    if (opts.publicUrl) {
      const u = new URL(opts.publicUrl);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new Error('--public-url must be https:// (http only for this machine)');
      if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('--public-url is an origin only, like https://rdv.example.com');
    }
    this.secure = opts.publicUrl?.startsWith('https:') ?? false;
    // Behind a public tunnel every request comes from 127.0.0.1: without the tunnel's client header, any stranger's
    // traffic would spend the same page and unlock budget as the owner's.
    if (this.secure && !opts.clientIpHeader) {
      throw new Error('--public-url https://… needs --client-ip-header (the header your tunnel puts the client address in, e.g. cf-connecting-ip), so strangers cannot use up the owner\'s PIN attempts');
    }
    this.tokenLimiter = new RateLimiter(opts.tokenRate ?? 120, 60_000, this.now);
    this.pageLimiter = new RateLimiter(120, 60_000, this.now);
    // A rate, not a lock: it refills, so flooding it costs the owner at most a minute.
    this.unlockLimiter = new RateLimiter(30, 60_000, this.now);
    this.oauth = new OAuthServer({
      home: opts.home,
      base: () => this.base,
      now: this.now,
      clientKey: (req) => this.client(req),
      log: this.log,
      onGrantEnded: (id) => this.endPrincipal(id),
    });
    // An ask from a token or OAuth grant that was revoked since is dropped: its owner said no more to that client.
    this.approvals = new Approvals(
      (id) => `${this.base}/approve/${id}`,
      this.now,
      (p) => p === undefined || this.store.listTokens().some((t) => t.id === p) || this.oauth.store.hasGrant(p),
    );
    this.server = new RdvMcpServer({
      home: opts.home,
      role: 'rdv-gateway',
      remote: {
        ask: (a) => {
          const url = this.approvals.ask(a, a.principal ? this.principalName(a.principal) : undefined);
          this.log(`waiting for you: ${a.form.message.split('\n')[0]} (${url})`);
          return url;
        },
      },
      calendar: opts.calendar,
      calendarDirs: opts.calendarDirs,
      window: opts.window,
      tz: opts.tz,
      humanLog: this.log,
      pollMs: opts.pollMs,
      sweepMs: opts.sweepMs,
    });
  }

  /** The base URL approval links use. */
  get url(): string {
    return this.base;
  }

  async start(): Promise<string> {
    if (!this.opts.home.initialized()) throw new Error(`no agent at ${this.opts.home.dir} yet: create it first in your own terminal (rdv init)`);
    if (!this.store.hasPin()) throw new Error('set the approval PIN first, in your own terminal: rdv-gateway pin set');
    this.server.startListening();
    const http = createServer((req, res) => void this.handle(req, res));
    http.requestTimeout = 120_000;
    http.headersTimeout = 20_000;
    this.http = http;
    const host = this.opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.opts.port ?? DEFAULT_PORT, host, () => resolve());
    });
    const port = (http.address() as AddressInfo).port;
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
      this.allowedHosts.add(`${h}:${port}`);
      this.origins.add(`http://${h}:${port}`);
    }
    if (!isLoopbackHost(host)) this.allowedHosts.add(`${host}:${port}`);
    const local = `http://127.0.0.1:${port}`;
    if (this.opts.publicUrl) {
      const u = new URL(this.opts.publicUrl);
      this.allowedHosts.add(u.host);
      this.base = u.origin;
    } else this.base = local;
    this.origins.add(this.base);
    this.log(`serving on ${local} (MCP at /mcp, REST at /api/v1, approvals at ${this.base}/approve)`);
    // A token or grant revoked from a terminal is refused at the next request; this also ends its open streams.
    this.sweeper = setInterval(() => this.sweepSessions(), SESSION_SWEEP_MS);
    this.sweeper.unref();
    return this.base;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    if (this.http) {
      this.http.closeAllConnections?.();
      await new Promise<void>((r) => this.http!.close(() => r()));
    }
    await this.server.close().catch(() => {});
  }

  // --- auth: the seam --------------------------------------------------------------

  /** The caller of an API or MCP request: a static token, or an OAuth access token the owner's consent minted. */
  authenticate(req: IncomingMessage, endpoint: 'mcp' | 'sse' = 'mcp'): Principal {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(h);
    if (m?.[1].startsWith('rdvo_')) {
      const who = this.oauth.verifyAccess(m[1]);
      if (who) return who;
    } else if (m) {
      const t = this.store.findToken(m[1]);
      if (t) return { id: t.id, name: t.name, scopes: t.scopes };
    }
    // RFC 9728 §5.1: where an OAuth client finds out how to get a token.
    const challenge = `Bearer realm="rendezvous", resource_metadata="${this.oauth.resourceMetadataUrl(endpoint)}", scope="${SCOPES.join(' ')}"${h ? ', error="invalid_token"' : ''}`;
    throw new HttpError(401, 'a valid bearer token is required (connect with OAuth, or your user makes a token with "rdv-gateway token create")', 'unauthorized', {
      'WWW-Authenticate': challenge,
    });
  }

  /** How the page names a principal: a token's name and id, or an OAuth client's registered name and grant id. */
  private principalName(id: string): string | undefined {
    const t = this.store.listTokens().find((x) => x.id === id);
    if (t) return `${t.name} (${t.id})`;
    const g = this.oauth.store.grant(id);
    const c = g ? this.oauth.store.client(g.clientId) : undefined;
    return c && g ? `${c.name} (OAuth ${g.id})` : undefined;
  }

  /** Whether a principal still exists: a static token, or a live OAuth grant. */
  private principalAlive(id: string): boolean {
    return this.store.listTokens().some((t) => t.id === id) || this.oauth.store.hasGrant(id);
  }

  /** A principal ended (an OAuth grant revoked or reused): close its MCP sessions now. */
  private endPrincipal(id: string): void {
    for (const [sid, s] of this.sessions) {
      if (s.principal !== id) continue;
      this.sessions.delete(sid);
      void s.transport.close().catch(() => {});
    }
  }

  // --- routing ---------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      securityHeaders(res, this.secure);
      const host = String(req.headers.host ?? '').toLowerCase();
      // DNS rebinding: a page elsewhere that resolves its own name to 127.0.0.1 still sends its own Host.
      if (!this.allowedHosts.has(host)) throw new HttpError(421, 'unknown host', 'misdirected');
      const url = new URL(req.url ?? '/', 'http://gateway.invalid');
      const path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') return sendJson(res, 200, { ok: true });
      if (path === '/assets/gateway.css' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': Buffer.byteLength(CSS), 'Cache-Control': 'max-age=3600' });
        return void res.end(CSS);
      }
      if (path === '/openapi.json' && req.method === 'GET') {
        this.openapi ??= JSON.stringify(openApi(this.server.tools, this.base));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(this.openapi) });
        return void res.end(this.openapi);
      }
      if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource/sse') {
        if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
        return sendJson(res, 200, this.oauth.protectedResourceMetadata(path.endsWith('/sse') ? 'sse' : 'mcp'));
      }
      if (path === '/.well-known/oauth-authorization-server') {
        if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
        return sendJson(res, 200, this.oauth.authorizationServerMetadata());
      }
      if (path === '/oauth/register') return await this.oauth.register(req, res);
      if (path === '/oauth/token') return await this.oauth.token(req, res);
      if (path === '/oauth/revoke') return await this.oauth.revoke(req, res);
      if (path === '/oauth/authorize') return await this.page(req, res, path, url);
      if (path === '/mcp') return await this.mcp(req, res);
      if (path === '/sse' || path === '/messages') return await this.sse(req, res, path, url);
      if (path === '/api/v1/tools' || path.startsWith('/api/v1/tools/')) return await this.api(req, res, path);
      if (path === '/approve' || path.startsWith('/approve/')) return await this.page(req, res, path, url);
      throw new HttpError(404, 'not found', 'not_found');
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, code: err.code }, err.headers);
      this.log(`error handling ${req.method} ${String(req.url).slice(0, 80)}: ${(err as Error).message}`);
      sendJson(res, 500, { error: 'internal error; the details are in the gateway log', code: 'internal' });
    }
  }

  // --- REST ------------------------------------------------------------------------

  private async api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const who = this.authenticate(req);
    this.tokenLimiter.check(who.id, 'requests');
    if (path === '/api/v1/tools') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
      return sendJson(res, 200, {
        tools: this.server.tools.filter((t) => toolScopes(t.name).some((s) => who.scopes.includes(s))).map((t) => ({ name: t.name, description: t.description, scopes: toolScopes(t.name) })),
      });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'POST only', 'method_not_allowed');
    const name = path.slice('/api/v1/tools/'.length);
    if (!/^rdv_[a-z_]{1,40}$/.test(name) || !this.server.tools.some((t) => t.name === name)) throw new HttpError(404, 'no such tool', 'not_found');
    const body = await readJson(req, API_BODY_MAX);
    let denied = false;
    const r = await this.server.invoke(name, body, {
      principal: who.id,
      authorize: (tool, args) => {
        const why = authorizeCall(who.scopes, tool, args);
        if (why) denied = true;
        return why;
      },
    });
    if (r.ok) return sendJson(res, 200, { result: r.value });
    if (denied) return sendJson(res, 403, { error: r.error, code: 'insufficient_scope' });
    return sendJson(res, r.error.startsWith('invalid input') ? 400 : 422, { error: r.error, code: r.error.startsWith('invalid input') ? 'invalid_input' : 'refused' });
  }

  // --- MCP over Streamable HTTP --------------------------------------------------------

  private async mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = this.authenticate(req);
    this.tokenLimiter.check(who.id, 'requests');
    const sid = req.headers['mcp-session-id'];
    let body: unknown;
    if (req.method === 'POST') body = await readJson(req, API_BODY_MAX);
    else if (req.method !== 'GET' && req.method !== 'DELETE') throw new HttpError(405, 'POST, GET or DELETE', 'method_not_allowed');
    if (typeof sid === 'string') {
      const s = this.sessions.get(sid);
      // A session belongs to the token that opened it; another token sees no such session.
      if (!s || s.principal !== who.id || !(s.transport instanceof StreamableHTTPServerTransport)) throw new HttpError(404, 'no such session', 'not_found');
      s.lastSeen = this.now();
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) throw new HttpError(400, 'start a session with an initialize request', 'bad_request');
    const mcp = await this.openSession(who);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, mcp, principal: who.id, lastSeen: this.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
      this.server.endSession(mcp);
    };
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** Room for a new session of this principal (its own oldest closes past the cap), and its MCP server. */
  private async openSession(who: Principal): Promise<McpServer> {
    this.sweepSessions();
    // One principal may hold a few sessions: a new one closes its own least recently used, never another's.
    const mine = [...this.sessions].filter(([, s]) => s.principal === who.id).sort((x, y) => x[1].lastSeen - y[1].lastSeen);
    for (const [id, s] of mine.slice(0, Math.max(0, mine.length - MAX_MCP_SESSIONS_PER_TOKEN + 1))) {
      this.sessions.delete(id);
      await s.transport.close().catch(() => {});
    }
    if (this.sessions.size >= MAX_MCP_SESSIONS) throw new HttpError(503, 'too many open sessions; close one or retry later', 'busy', { 'Retry-After': '60' });
    return this.server.newSession({
      allow: (tool) => toolScopes(tool).some((s) => who.scopes.includes(s)),
      caller: { principal: who.id, authorize: (tool, args) => authorizeCall(who.scopes, tool, args) },
    });
  }

  // --- MCP over the legacy HTTP+SSE transport ------------------------------------------

  /** GET /sse opens the event stream; its client POSTs to /messages?sessionId=… with the same bearer. */
  private async sse(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const who = this.authenticate(req, 'sse');
    this.tokenLimiter.check(who.id, 'requests');
    if (path === '/messages') {
      if (req.method !== 'POST') throw new HttpError(405, 'POST only', 'method_not_allowed');
      const s = this.sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!s || s.principal !== who.id || !(s.transport instanceof SSEServerTransport)) throw new HttpError(404, 'no such session', 'not_found');
      const body = await readJson(req, API_BODY_MAX);
      s.lastSeen = this.now();
      return s.transport.handlePostMessage(req, res, body);
    }
    if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
    const mcp = await this.openSession(who);
    const transport = new SSEServerTransport('/messages', res);
    this.sessions.set(transport.sessionId, { transport, mcp, principal: who.id, lastSeen: this.now() });
    transport.onclose = () => {
      this.sessions.delete(transport.sessionId);
      this.server.endSession(mcp);
    };
    await mcp.connect(transport);
  }

  private sweepSessions(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (t - s.lastSeen > MCP_IDLE_MS || !this.principalAlive(s.principal)) {
        this.sessions.delete(id);
        void s.transport.close().catch(() => {});
      }
    }
  }

  // --- the owner's approval page -----------------------------------------------------

  private cookieName(): string {
    return this.secure ? '__Host-rdvg_owner' : 'rdvg_owner';
  }

  private cookie(name: string, value: string, maxAgeS: number): string {
    return `${name}=${value}; ${this.secure ? 'Path=/; Secure' : 'Path=/approve'}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}`;
  }

  private ownerSession(req: IncomingMessage): string | undefined {
    const id = parseCookies(req.headers.cookie).get(this.cookieName());
    if (!id) return undefined;
    const s = this.owners.get(id);
    const t = this.now();
    if (!s || t - s.lastSeen > OWNER_IDLE_MS || t - s.created > OWNER_MAX_MS || s.pinSetAt !== this.store.pinSetAt()) {
      if (s) this.owners.delete(id);
      return undefined;
    }
    s.lastSeen = t;
    return id;
  }

  private csrfFor(scope: string): string {
    return hmac(this.key, `rdv1/gateway-csrf\u0000${scope}`);
  }

  /** A form post must come from our own page: the CSRF token, and no cross-site Origin or fetch metadata. */
  private checkPost(req: IncomingMessage, form: URLSearchParams, scope: string): void {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      if (!this.origins.has(origin)) throw new HttpError(403, 'cross-site request refused', 'csrf');
    }
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'cross-site request refused', 'csrf');
    const sent = form.get('csrf') ?? '';
    if (!safeEqual(sent, this.csrfFor(scope))) throw new HttpError(403, 'the form expired; reload the page', 'csrf');
  }

  private html(res: ServerResponse, status: number, html: string, cookies: string[] = []): void {
    sendHtml(res, status, html, PAGE_CSP, cookies.length ? { 'Set-Cookie': cookies } : {});
  }

  private unlock(res: ServerResponse, next: string, message?: Flash, status = 200): void {
    const pre = randomToken(18);
    this.html(res, status, unlockPage({ csrf: this.csrfFor(`pre:${pre}`), next, message }), [this.cookie('rdvg_pre', pre, 600)]);
  }

  /** The client's address: the trusted tunnel header when configured (its last entry), else the socket's. */
  private client(req: IncomingMessage): string {
    const name = this.opts.clientIpHeader?.toLowerCase();
    const raw = name ? req.headers[name] : undefined;
    const v = (Array.isArray(raw) ? raw.at(-1) : raw)?.split(',').at(-1)?.trim();
    return (v && v.length <= 64 ? v : undefined) ?? req.socket.remoteAddress ?? '?';
  }

  /** A client's own backoff (with clientIpHeader): how long it must wait, if at all. */
  private clientWait(key: string): number {
    const c = this.clientFailures.get(key);
    if (!c) return 0;
    if (this.now() - c.last > CLIENT_FORGET_MS) {
      this.clientFailures.delete(key);
      return 0;
    }
    return c.until && c.until > this.now() ? c.until - this.now() : 0;
  }

  private clientFailed(key: string): void {
    const t = this.now();
    const c = this.clientFailures.get(key) ?? { failures: 0, last: t };
    this.clientFailures.delete(key); // Map order is the LRU order
    c.failures += 1;
    c.last = t;
    const over = c.failures - CLIENT_FREE_TRIES;
    if (over >= 0) c.until = t + Math.min(CLIENT_MAX_WAIT_MS, 30_000 * 2 ** over);
    this.clientFailures.set(key, c);
    while (this.clientFailures.size > 10_000) this.clientFailures.delete(this.clientFailures.keys().next().value!);
  }

  private async page(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const who = this.client(req);
    // Per client when the tunnel says who it is (required behind https); on this machine alone, per socket address.
    this.pageLimiter.check(who, 'requests');
    // Behind https the owner cookie is Secure: it never comes back over http://127.0.0.1, so say where to go.
    if (this.secure && new URL(this.base).host !== String(req.headers.host ?? '').toLowerCase()) {
      return this.html(res, 421, errorPage('Open the public address', `Behind https, approvals open at ${this.base}/approve only.`));
    }
    if (path === '/oauth/authorize') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
      // Checked and parked; the owner decides on the consent page (after the PIN), never automatically.
      const id = this.oauth.authorize(req, res, url);
      if (id === undefined) return;
      // Bound to this browser: a consent link forwarded to the owner (a stranger's own connect) opens nothing.
      return redirect(res, `/approve/oauth/${id}`, { 'Set-Cookie': this.consentCookie(id) });
    }
    const sid = this.ownerSession(req);
    if (path === '/approve/unlock') {
      if (req.method !== 'POST') return redirect(res, '/approve');
      const form = await readForm(req, FORM_BODY_MAX);
      const pre = parseCookies(req.headers.cookie).get('rdvg_pre') ?? '';
      this.checkPost(req, form, `pre:${pre}`);
      // Only a post from our own unlock form spends the unlock budget, per client when clients are told apart.
      this.unlockLimiter.check(this.opts.clientIpHeader ? who : 'unlock', 'PIN attempts');
      const next = /^\/approve(\/apr_[A-Za-z0-9_-]{8,64}|\/oauth\/oar_[A-Za-z0-9_-]{8,64})?$/.test(form.get('next') ?? '') ? form.get('next')! : '/approve';
      const perClient = this.opts.clientIpHeader !== undefined;
      const wait = perClient ? this.clientWait(who) : 0;
      if (wait) return this.unlock(res, next, { text: `Too many wrong PINs from here: try again in ${Math.ceil(wait / 1000)} s.`, bad: true }, 429);
      // Every miss counts globally too (distributed guessing); clients told apart get more global tries before the backoff.
      const check = await this.store.checkPin(form.get('pin') ?? '', this.now(), perClient ? GLOBAL_FREE_TRIES_PER_CLIENT_MODE : undefined);
      if (!check.ok) {
        if (perClient && !check.noPin && !check.lockedFor) this.clientFailed(who);
        const text = check.lockedFor
          ? `Too many wrong PINs: try again in ${Math.ceil(check.lockedFor / 60_000)} minute(s), or clear it in your own terminal (rdv-gateway pin unlock).`
          : check.noPin
            ? 'No PIN is set: set one in your own terminal (rdv-gateway pin set).'
            : 'That is not the PIN.';
        if (!check.lockedFor) this.log('a wrong PIN was entered on the approval page');
        return this.unlock(res, next, { text, bad: true }, 403);
      }
      if (perClient) this.clientFailures.delete(who);
      while (this.owners.size >= MAX_OWNER_SESSIONS) this.owners.delete(this.owners.keys().next().value!);
      const id = randomToken(32);
      this.owners.set(id, { created: this.now(), lastSeen: this.now(), pinSetAt: this.store.pinSetAt() });
      return redirect(res, next, { 'Set-Cookie': [this.cookie(this.cookieName(), id, OWNER_MAX_MS / 1000), this.cookie('rdvg_pre', '', 0)] });
    }
    if (!sid) {
      if (req.method !== 'GET') return this.unlock(res, '/approve', { text: 'Locked: enter your PIN again.', bad: true }, 401);
      return this.unlock(res, path === '/approve' ? '/approve' : path);
    }
    const csrf = this.csrfFor(`owner:${sid}`);
    if (path === '/approve/lock') {
      if (req.method !== 'POST') return redirect(res, '/approve');
      this.checkPost(req, await readForm(req, FORM_BODY_MAX), `owner:${sid}`);
      this.owners.delete(sid);
      return redirect(res, '/approve', { 'Set-Cookie': [this.cookie(this.cookieName(), '', 0)] });
    }
    if (path === '/approve') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET only', 'method_not_allowed');
      return this.html(res, 200, listPage({ items: this.approvals.list(), csrf }));
    }
    if (path.startsWith('/approve/oauth/')) return this.consent(req, res, path.slice('/approve/oauth/'.length), sid, csrf);
    const id = path.slice('/approve/'.length);
    const item = /^apr_[A-Za-z0-9_-]{8,64}$/.test(id) ? this.approvals.get(id) : undefined;
    if (!item) return this.html(res, 404, errorPage('Nothing waits here', 'Nothing waits for you under this link: it was decided already, or it expired. Your assistant can ask again.'));
    if (req.method === 'GET') return this.html(res, 200, approvalPage({ item, csrf }));
    if (req.method !== 'POST') throw new HttpError(405, 'GET or POST', 'method_not_allowed');
    const form = await readForm(req, FORM_BODY_MAX);
    this.checkPost(req, form, `owner:${sid}`);
    return this.decide(res, item, form, csrf);
  }

  /** Connecting an OAuth client: the consent page, and the owner's answer bound to the digest of what it showed. */
  /**
   * The cookie that binds a parked connection request to the browser that started it. SameSite=Lax, since that
   * browser arrives from the assistant's site (a cross-site top-level navigation, where a Strict cookie is not sent).
   */
  private consentCookie(id: string): string {
    const name = this.secure ? '__Host-rdvg_oar' : 'rdvg_oar';
    return `${name}=${hmac(this.key, `rdv1/gateway-oar\u0000${id}`)}; ${this.secure ? 'Path=/; Secure' : 'Path=/approve'}; HttpOnly; SameSite=Lax; Max-Age=600`;
  }

  private startedHere(req: IncomingMessage, id: string): boolean {
    const got = parseCookies(req.headers.cookie).get(this.secure ? '__Host-rdvg_oar' : 'rdvg_oar') ?? '';
    return safeEqual(got, hmac(this.key, `rdv1/gateway-oar\u0000${id}`));
  }

  private async consent(req: IncomingMessage, res: ServerResponse, id: string, sid: string, csrf: string): Promise<void> {
    const item = /^oar_[A-Za-z0-9_-]{8,64}$/.test(id) ? this.oauth.consent(id) : undefined;
    if (!item) return this.html(res, 404, errorPage('Nothing waits here', 'This connection request was decided already, or it expired (after ten minutes). Connect again from your assistant.'));
    if (!this.startedHere(req, id)) {
      this.log(`a connection request (${item.clientId}) was opened in a browser that did not start it; nothing was shown`);
      return this.html(
        res,
        403,
        errorPage(
          'Not started here',
          'This connection request was started in another browser. Connect only an assistant you are setting up yourself, from this device: if someone sent you this link, do not approve it.',
        ),
      );
    }
    const client = this.oauth.store.client(item.clientId);
    const show = (status: number, message?: Flash) =>
      sendHtml(res, status, consentPage({ item, csrf, registered: client?.created, message }), consentCsp(item.redirectUri));
    if (req.method === 'GET') return show(200);
    if (req.method !== 'POST') throw new HttpError(405, 'GET or POST', 'method_not_allowed');
    const form = await readForm(req, FORM_BODY_MAX);
    this.checkPost(req, form, `owner:${sid}`);
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'decline') return show(400, { text: 'Choose connect or no.', bad: true });
    const kept = SCOPES.filter((s) => form.get(`s_${s}`) === '1');
    const out = this.oauth.decide(item, form.get('digest') ?? '', decision, kept);
    if ('error' in out) {
      if (this.oauth.consent(item.id)) return show(409, { text: out.error, bad: true });
      return this.html(res, 409, donePage({ title: 'Not connected', text: out.error, csrf, bad: true }));
    }
    return redirect(res, out.redirect);
  }

  /** The owner's answer to one approval: bound to the digest of the form the page showed. */
  private async decide(res: ServerResponse, item: PendingApproval, form: URLSearchParams, csrf: string): Promise<void> {
    const decision = form.get('decision');
    if (decision !== 'approve' && decision !== 'decline') return this.html(res, 400, approvalPage({ item, csrf, message: { text: 'Choose approve or no.', bad: true } }));
    if (!safeEqual(form.get('digest') ?? '', item.form.digest)) {
      // The page was older than the ask (it was asked again, or changed): nothing was done; show it as it is now.
      return this.html(res, 409, approvalPage({ item, csrf, message: { text: 'This changed since you opened the page. Nothing was done; review it again.', bad: true } }));
    }
    if (item.busy) return this.html(res, 409, donePage({ title: 'Already running', text: 'Your answer to this is already being carried out.', csrf, bad: true }));
    let content: Record<string, unknown> = {};
    if (decision === 'approve') {
      try {
        content = typeContent(item.form.properties, form);
      } catch (err) {
        if (err instanceof FormInputError) return this.html(res, 400, approvalPage({ item, csrf, message: { text: `Nothing was done: ${err.message}.`, bad: true } }));
        throw err;
      }
    }
    item.busy = true;
    let out;
    try {
      out = await this.server.answer(item, { digest: item.form.digest, decision, content }, item.id);
    } finally {
      item.busy = false;
    }
    if (out.kind === 'changed') {
      this.approvals.replaceForm(item.id, out.form);
      return this.html(res, 409, approvalPage({ item: this.approvals.get(item.id) ?? item, csrf }));
    }
    this.approvals.drop(item.id);
    if (out.kind === 'error') {
      this.log(`approval ${item.id} (${item.tool}) failed: ${out.error}`);
      return this.html(res, 422, donePage({ title: 'Not done', text: out.error, csrf, bad: true }));
    }
    if (out.unneeded) {
      this.log(`approval ${item.id} (${item.tool}): it no longer needed you; the call ran as your assistant asked`);
      return this.html(res, 200, donePage({ title: 'No longer needed you', text: 'This changed so that it no longer needed your decision: it ran as your assistant asked, and your answer decided nothing. Your assistant sees the result in its inbox.', csrf }));
    }
    const v = out.value as { approved?: boolean; answer?: string } | undefined;
    const no = decision === 'decline' || v?.approved === false;
    this.log(`approval ${item.id} (${item.tool}): ${no ? 'declined' : 'approved'} on the approval page`);
    return this.html(
      res,
      200,
      donePage({
        title: no ? 'Declined' : 'Approved',
        text: no ? 'You said no; nothing was approved. Your assistant sees this in its inbox.' : 'Done. Your assistant sees the outcome in its inbox.',
        csrf,
      }),
    );
  }
}
