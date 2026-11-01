// A PIN change racing a PIN check (review LOW on the settings page): the check reads the stored hash, then awaits scrypt;
// a change landing in that window must not leave a session or a token made with the old PIN.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, assert, vi } from 'vitest';
import { Home } from '@rendezvous/cli/lib';
import { GatewayStore } from '../src/store.js';
import type { Gateway } from '../src/index.js';
import { Browser, hidden, PIN, startGateway, type TestGateway } from './helpers.js';

let root: string;
let gws: Gateway[] = [];
afterEach(async () => {
  for (const g of gws) await g.close().catch(() => {});
  gws = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

async function one(): Promise<TestGateway> {
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-race-'));
  const g = await startGateway(join(root, 'omer'));
  gws.push(g.gw);
  return g;
}

/** Make the next PIN check read the stored hash, then have the PIN changed while its scrypt is still running. */
function changeDuringNextCheck(g: TestGateway, next: string): void {
  const store = g.gw.store as unknown as { checkPinNow: (...a: unknown[]) => Promise<unknown> };
  const orig = store.checkPinNow.bind(store);
  let armed = true;
  store.checkPinNow = async (...a: unknown[]) => {
    const run = orig(...a); // reads the old hash synchronously, then awaits scrypt
    if (!armed) return run;
    armed = false;
    await g.gw.store.setPin(next);
    return run;
  };
}

describe('a PIN change racing a PIN check', () => {
  it('an unlock checked against the old PIN yields a session that is dead on arrival', async () => {
    const g = await one();
    const b = new Browser(g.base);
    changeDuringNextCheck(g, 'new-pin-7731');
    const u = await b.unlock('/approve/admin');
    assert.equal(u.status, 303); // the old PIN was right when it was checked
    const page = await b.get('/approve/admin');
    assert.include(page.text, 'Enter your gateway PIN'); // but its session does not outlive the change
  });

  it('a token create checked against the old PIN makes nothing once the PIN changed', async () => {
    const g = await one();
    const b = new Browser(g.base);
    assert.equal((await b.unlock('/approve/admin')).status, 303);
    const csrf = hidden((await b.get('/approve/admin')).text, 'csrf');
    changeDuringNextCheck(g, 'new-pin-7731');
    const r = await b.post('/approve/admin/token/create', { agent: 'omer', name: 'late', s_read: '1', pin: PIN, csrf });
    assert.equal(r.status, 409);
    assert.equal(g.gw.store.listTokens().length, 0);
  });

  it('a terminal PIN change whose current-PIN check was overtaken writes nothing', async () => {
    const g = await one();
    changeDuringNextCheck(g, 'new-pin-7731');
    let err = '';
    await g.gw.store.changePin(PIN, 'third-pin-9902', Date.now()).catch((e: Error) => void (err = e.message));
    assert.match(err, /changed meanwhile/);
    assert.equal((await g.gw.store.checkPin('new-pin-7731', Date.now())).ok, true);
  });
});

describe('PIN set ordering', () => {
  it('created only grows when the clock steps back', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-clock-'));
    const store = new GatewayStore(new Home(join(root, 'h')));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:10Z'));
      await store.setPin('first-pin-4417');
      const a = store.pinSetAt()!;
      vi.setSystemTime(new Date('2030-01-01T00:00:05Z')); // the clock stepped back
      await store.setPin('second-pin-5528');
      const b = store.pinSetAt()!;
      assert.isAbove(Date.parse(b), Date.parse(a));
    } finally {
      vi.useRealTimers();
    }
  });

  it('two first-time PIN sets at once: one wins, the other fails cleanly', async () => {
    root = mkdtempSync(join(tmpdir(), 'rdv-gw-first-'));
    const home = new Home(join(root, 'h'));
    const a = new GatewayStore(home);
    const b = new GatewayStore(new Home(join(root, 'h')));
    const res = await Promise.allSettled([a.changePin(undefined, 'first-pin-4417', Date.now()), b.changePin(undefined, 'other-pin-6639', Date.now())]);
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.match(lost.reason.message, /changed meanwhile/);
  });
});
