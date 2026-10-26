// Test helpers: a gateway on 127.0.0.1 over an initialized home, its owner's
// browser (a cookie jar over fetch), and a cloud assistant (REST or MCP over
// Streamable HTTP with a bearer token).
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Home, initHome } from '@rendezvous/cli/lib';
import { Gateway, type GatewayOptions } from '../src/index.js';

export const PIN = '482916-blue';
let tokens = 0;

export interface TestGateway {
  gw: Gateway;
  home: Home;
  base: string;
  log: string[];
  token(scopes: string[], name?: string): Promise<string>;
}

export async function startGateway(dir: string, opts: { relays?: string[]; email?: string; init?: boolean; pin?: boolean } & Partial<GatewayOptions> = {}): Promise<TestGateway> {
  const home = new Home(dir);
  if (opts.init !== false) await initHome(home, { profile: 'omer', relays: opts.relays, emails: [opts.email ?? 'omer@example.com'] });
  const log: string[] = [];
  const gw = new Gateway({ home, port: 0, humanLog: (l) => log.push(l), pollMs: 150, sweepMs: 3_600_000, ...opts });
  if (opts.pin !== false) await gw.store.setPin(PIN);
  const base = await gw.start();
  return {
    gw,
    home,
    base,
    log,
    async token(scopes, name = `cloud-${++tokens}`) {
      return (await gw.store.createToken(name, scopes)).token;
    },
  };
}

export interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  text: string;
  headers: Headers;
}

export async function api(base: string, token: string | undefined, tool: string, args: unknown = {}): Promise<Res> {
  const r = await fetch(`${base}/api/v1/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: r.status, body, text, headers: r.headers };
}

/** A raw request with a chosen Host header (fetch does not let a test set it). */
export function rawRequest(base: string, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** The owner's browser: cookies kept, redirects not followed, hidden fields read from the page. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private keep(h: Headers): void {
    for (const c of h.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (v === '' || /Max-Age=0/.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  async get(path: string): Promise<Res> {
    const r = await fetch(new URL(path, this.base), { redirect: 'manual', headers: { cookie: this.cookieHeader() } });
    this.keep(r.headers);
    const text = await r.text();
    return { status: r.status, body: undefined, text, headers: r.headers };
  }

  async post(path: string, form: Record<string, string>, extra: Record<string, string> = {}): Promise<Res> {
    const r = await fetch(new URL(path, this.base), {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body: new URLSearchParams(form).toString(),
    });
    this.keep(r.headers);
    const text = await r.text();
    return { status: r.status, body: undefined, text, headers: r.headers };
  }

  /** Unlock with the PIN from the unlock page at `path` (its CSRF token). */
  async unlock(path = '/approve', pin = PIN): Promise<Res> {
    const page = await this.get(path);
    return this.post('/approve/unlock', { csrf: hidden(page.text, 'csrf'), next: hidden(page.text, 'next'), pin });
  }
}

export function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name} in the page`);
  return m[1].replace(/&amp;/g, '&');
}

export async function mcpClient(base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'cloud-assistant', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

export async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  const i = text.indexOf('{');
  let json: unknown;
  try {
    json = i < 0 ? undefined : JSON.parse(text.slice(i));
  } catch {
    json = undefined;
  }
  return { isError: r.isError === true, text, json };
}

/** Poll an inbox (REST) until an event matches. */
export async function waitApi(base: string, token: string, pred: (e: any) => boolean, what: string, timeoutMs = 20_000): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  for (;;) {
    const r = await api(base, token, 'rdv_inbox', { since, wait_seconds: 1 });
    if (r.status !== 200) throw new Error(`rdv_inbox: ${r.status} ${r.text}`);
    const hit = r.body.result.events.find(pred);
    if (hit) return hit;
    since = r.body.result.next_cursor;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}
