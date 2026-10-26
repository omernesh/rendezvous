// rdv-gateway (issue #12): the owner's Rendezvous agent behind their own
// HTTPS endpoint, for cloud assistants that can only reach a public URL. It
// runs on the owner's machine, the key never leaves it, and it shares the
// home with rdv / rdv-mcp (same files, same locks; one inbound consumer per
// home: like a second rdv-mcp, it attaches when another process holds
// listener.lock, issue #9).
//
//   /mcp            MCP over Streamable HTTP (bearer token, a session per client)
//   /api/v1/tools/* the same tools over REST (bearer token); /openapi.json describes them
//   /approve        the owner's PIN-locked approval page: the only place anything is approved
//
// Consent never passes through the cloud assistant: the tools run in the MCP
// server's remote mode, where every step that needs the human returns
// `awaiting_human` with a link to /approve/<id>. That page shows the exact
// form the step would have shown, and the owner's answer is bound to its
// digest (RdvMcpServer.answer re-checks it from the state, and the step's
// own check under the home lock binds the commit). Auth is a seam
// (`authenticate`): static tokens now, OAuth 2.1 next (slice 2).
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { openApi } from './openapi.js';
import { approvalPage, CSS, donePage, errorPage, type Flash, listPage, PAGE_CSP, unlockPage } from './pages.js';
import { authorizeCall, type Scope, toolScopes } from './scopes.js';
import { GatewayStore } from './store.js';

export const DEFAULT_PORT = 8787;
export const API_BODY_MAX = 256 * 1024;
export const FORM_BODY_MAX = 64 * 1024;
export const MAX_MCP_SESSIONS = 32;
const MCP_IDLE_MS = 30 * 60_000;
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
  now?: () => number;
}

/** Who a request is, once authenticated: the seam slice 2's OAuth plugs into. */
export interface Principal {
  id: string;
  name: string;
  scopes: Scope[];
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  principal: string;
  lastSeen: number;
}

interface OwnerSession {
  created: number;
  lastSeen: number;
}

export class Gateway {
  readonly store: GatewayStore;
  readonly approvals: Approvals;
  readonly server: RdvMcpServer;
  private http?: Server;
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
    this.tokenLimiter = new RateLimiter(opts.tokenRate ?? 120, 60_000, this.now);
    this.pageLimiter = new RateLimiter(120, 60_000, this.now);
    this.unlockLimiter = new RateLimiter(10, 60_000, this.now);
    this.approvals = new Approvals((id) => `${this.base}/approve/${id}`, this.now);
    this.server = new RdvMcpServer({
      home: opts.home,
      role: 'rdv-gateway',
      remote: {
        ask: (a) => {
          const url = this.approvals.ask(a);
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
    return this.base;
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    this.sessions.clear();
    if (this.http) {
      this.http.closeAllConnections?.();
      await new Promise<void>((r) => this.http!.close(() => r()));
    }
    await this.server.close().catch(() => {});
  }

  // --- auth: the seam --------------------------------------------------------------

  /** The caller of an API or MCP request: a static token now (OAuth 2.1 access tokens join here in slice 2). */
  authenticate(req: IncomingMessage): Principal {
    const h = String(req.headers.authorization ?? '');
    const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(h);
    const t = m ? this.store.findToken(m[1]) : undefined;
    if (!t) throw new HttpError(401, 'a valid bearer token is required (your user makes one with "rdv-gateway token create")', 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="rendezvous"' });
    return { id: t.id, name: t.name, scopes: t.scopes };
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
      if (path === '/openapi.json' && req.method === 'GET') return sendJson(res, 200, openApi(this.server.tools, this.base));
      if (path === '/mcp') return await this.mcp(req, res);
      if (path === '/api/v1/tools' || path.startsWith('/api/v1/tools/')) return await this.api(req, res, path);
      if (path === '/approve' || path.startsWith('/approve/')) return await this.page(req, res, path);
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
      principal: who.name,
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
      if (!s || s.principal !== who.id) throw new HttpError(404, 'no such session', 'not_found');
      s.lastSeen = this.now();
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) throw new HttpError(400, 'start a session with an initialize request', 'bad_request');
    this.sweepSessions();
    if (this.sessions.size >= MAX_MCP_SESSIONS) throw new HttpError(503, 'too many open sessions; close one or retry later', 'busy', { 'Retry-After': '60' });
    const mcp = this.server.newSession({
      allow: (tool) => toolScopes(tool).some((s) => who.scopes.includes(s)),
      caller: { principal: who.name, authorize: (tool, args) => authorizeCall(who.scopes, tool, args) },
    });
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

  private sweepSessions(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (t - s.lastSeen > MCP_IDLE_MS) {
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
    if (!s || t - s.lastSeen > OWNER_IDLE_MS || t - s.created > OWNER_MAX_MS) {
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

  private async page(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    this.pageLimiter.check(req.socket.remoteAddress ?? '?', 'requests');
    const sid = this.ownerSession(req);
    if (path === '/approve/unlock') {
      if (req.method !== 'POST') return redirect(res, '/approve');
      this.unlockLimiter.check('unlock', 'PIN attempts');
      const form = await readForm(req, FORM_BODY_MAX);
      const pre = parseCookies(req.headers.cookie).get('rdvg_pre') ?? '';
      this.checkPost(req, form, `pre:${pre}`);
      const next = /^\/approve(\/apr_[A-Za-z0-9_-]{8,64})?$/.test(form.get('next') ?? '') ? form.get('next')! : '/approve';
      const check = await this.store.checkPin(form.get('pin') ?? '', this.now());
      if (!check.ok) {
        const text = check.lockedFor
          ? `Too many wrong PINs: locked for ${Math.ceil(check.lockedFor / 60_000)} more minute(s).`
          : check.noPin
            ? 'No PIN is set: set one in your own terminal (rdv-gateway pin set).'
            : 'That is not the PIN.';
        if (!check.lockedFor) this.log('a wrong PIN was entered on the approval page');
        return this.unlock(res, next, { text, bad: true }, 403);
      }
      while (this.owners.size >= MAX_OWNER_SESSIONS) this.owners.delete(this.owners.keys().next().value!);
      const id = randomToken(32);
      this.owners.set(id, { created: this.now(), lastSeen: this.now() });
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
    const id = path.slice('/approve/'.length);
    const item = /^apr_[A-Za-z0-9_-]{8,64}$/.test(id) ? this.approvals.get(id) : undefined;
    if (!item) return this.html(res, 404, errorPage('Nothing waits here', 'Nothing waits for you under this link: it was decided already, or it expired. Your assistant can ask again.'));
    if (req.method === 'GET') return this.html(res, 200, approvalPage({ item, csrf }));
    if (req.method !== 'POST') throw new HttpError(405, 'GET or POST', 'method_not_allowed');
    const form = await readForm(req, FORM_BODY_MAX);
    this.checkPost(req, form, `owner:${sid}`);
    return this.decide(res, item, form, csrf);
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
