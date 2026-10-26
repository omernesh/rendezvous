// Small HTTP helpers on node:http: bounded bodies, security headers, JSON and
// HTML responses, constant-time comparison, a bounded rate limiter.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const hmac = (key: Buffer, s: string): string => createHmac('sha256', key).update(s).digest('base64url');

/** Constant-time string equality (length still leaks, which is fine for fixed-length secrets and hashes). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** Read a request body, refusing (413) more than `limit` bytes before reading them all. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new HttpError(413, `request body over ${limit} bytes`, 'body_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, `request body over ${limit} bytes`, 'body_too_large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The media type of a request, lowercased, without parameters. */
export function mediaType(req: IncomingMessage): string {
  return String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (mediaType(req) !== 'application/json') throw new HttpError(415, 'send application/json', 'unsupported_media_type');
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'the body is not valid JSON', 'invalid_json');
  }
}

export async function readForm(req: IncomingMessage, limit: number): Promise<URLSearchParams> {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'send application/x-www-form-urlencoded', 'unsupported_media_type');
  return new URLSearchParams((await readBody(req, limit)).toString('utf8'));
}

/** API responses: nothing may render or embed them. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers every response carries (before anything is written). */
export function securityHeaders(res: ServerResponse, hsts: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', API_CSP);
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function sendHtml(res: ServerResponse, status: number, html: string, csp: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': csp,
  });
  res.end(html);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}, status = 303): void {
  res.writeHead(status, { ...headers, Location: location, 'Content-Length': 0 });
  res.end();
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

/**
 * A token bucket per key, bounded: at most `maxKeys` keys are tracked (the
 * least recently used is dropped), so a flood of distinct keys can't grow it.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Take one token; returns 0 if allowed, else the seconds until one is free. */
  take(key: string): number {
    const t = this.now();
    const rate = this.limit / this.windowMs;
    const b = this.buckets.get(key) ?? { tokens: this.limit, at: t };
    this.buckets.delete(key); // re-insert: Map order is the LRU order
    b.tokens = Math.min(this.limit, b.tokens + (t - b.at) * rate);
    b.at = t;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else wait = Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    return wait;
  }

  check(key: string, what: string): void {
    const wait = this.take(key);
    if (wait) throw new HttpError(429, `too many ${what}; retry in ${wait}s`, 'rate_limited', { 'Retry-After': String(wait) });
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
