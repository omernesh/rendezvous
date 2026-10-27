// The gateway's pages carry the Rendezvous logo; the favicon is served; the CSP is unchanged.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGE_CSP } from '../src/pages.js';
import { Browser, startGateway, type TestGateway } from './helpers.js';

let relay: TestRelay;
let root: string;
let g: TestGateway;
beforeAll(async () => {
  relay = await startTestRelay();
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-logo-'));
  g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: `omer.logo${process.pid}@example.com` });
});
afterAll(async () => {
  await g.gw.close();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

export const hasLogo = (html: string) => {
  expect(html).toContain('class="brand"');
  expect(html).toContain('<title id="rdv-logo-title">Rendezvous</title>');
  expect(html).toContain('>rendezvous</span>');
  expect(html).toContain('<link rel="icon" href="/favicon.svg"');
};

describe('gateway logo', () => {
  it('is on the unlock page, the CSP is unchanged and HTML is no-transform', async () => {
    const b = new Browser(g.base);
    const r = await b.get('/approve');
    expect(r.text).toContain('name="pin"');
    hasLogo(r.text);
    expect(r.headers.get('content-security-policy')).toBe(PAGE_CSP);
    expect(PAGE_CSP).toBe("default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    expect(r.headers.get('cache-control')).toBe('no-store, no-transform');
  });

  it('is on the list page and a not-found approval page after unlocking', async () => {
    const b = new Browser(g.base);
    expect((await b.unlock('/approve')).status).toBe(303);
    const listHtml = (await b.get('/approve')).text;
    hasLogo(listHtml);
    expect(listHtml).toContain('Lock (sign out)');
    expect(listHtml).toContain("Ends this session on this device. You'll need your PIN again next time.");
    const none = await b.get('/approve/apr_nope');
    expect(none.status).toBe(404);
    hasLogo(none.text);
  });

  it('serves the favicon and the stylesheet that colours the mark', async () => {
    const f = await fetch(`${g.base}/favicon.svg`);
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('image/svg+xml');
    expect(await f.text()).toContain('<svg');
    const css = await (await fetch(`${g.base}/assets/gateway.css`)).text();
    expect(css).toContain('.mark .mk-d');
  });
});
