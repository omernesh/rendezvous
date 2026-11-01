// rdv_service (issue #102 item 6, NOTES 100): the background listener from the
// chat. "install" needs the human's yes in an approval form bound to the
// definition it showed (no confirm phrase); "remove" only narrows, so it needs
// none; "status" is read-only. The OS is faked (its commands are recorded and
// the "service" takes listener.lock like `rdv listen --service` would), so no
// test registers a real service.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { type Home, serviceDefinition, type ServiceEnv, type ServicePlatform, tryLongLock } from '@rendezvous/cli/lib';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ElicitHandler, makeSide, ok, type Side, waitEvent } from './flow.js';
import { quickReason } from '../src/server.js';

const T = 15_000;
const NAME = 'rdv-listen-omer';
const ROLE = `rdv service ${NAME}`;

let relay: TestRelay;
let root: string | undefined;
let sides: Side[] = [];
let drops: Array<() => void> = [];
beforeAll(async () => {
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
});
afterEach(async () => {
  for (const d of drops) d();
  drops = [];
  for (const s of sides) await s.close().catch(() => {});
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

type Answer = (p: ElicitRequest['params']) => ElicitResult;
const yes: Answer = () => ({ action: 'accept', content: { approve: true } });
const no: Answer = () => ({ action: 'decline' });
function human(...answers: Answer[]) {
  const asked: Array<ElicitRequest['params']> = [];
  const handler: ElicitHandler = (p) => {
    asked.push(p);
    return (answers.length > 1 ? answers.shift()! : answers[0])(p);
  };
  return { handler, asked };
}

/**
 * This machine's OS, faked: its service manager's commands are recorded, and
 * starting the service takes listener.lock under the service's role (only if
 * it is free, as `rdv listen` would); stopping it lets go.
 */
function fakeOs(dir: string) {
  const platform = process.platform as ServicePlatform;
  const env: ServiceEnv = { platform, node: process.execPath, bin: join(dir, 'bin.js'), userHome: join(dir, 'user'), uid: 501, systemRoot: 'C:\\Windows', user: 'HOST\\omer' };
  const calls: string[][] = [];
  const tasks = new Map<string, string>();
  const os = { env, calls, tasks, regOverride: undefined as string | undefined, home: undefined as Home | undefined, held: undefined as (() => void) | undefined, took: false, noTake: false };
  const registered = () => os.regOverride ?? serviceDefinition(os.home!.dir, 'omer', env).registered;
  const take = () => {
    os.regOverride = undefined; // (re)installing registers the real definition again
    if (os.noTake) return;
    const l = tryLongLock(os.home!.listenerLockPath, ROLE);
    os.took = !!l.release;
    if (l.release) {
      os.held = l.release;
      drops.push(l.release);
    }
  };
  const drop = () => {
    os.held?.();
    os.held = undefined;
  };
  const okr = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const run = (argv: string[]) => {
    calls.push(argv);
    const [cmd, sub] = argv;
    if (cmd === 'schtasks') {
      const name = argv[argv.indexOf('/TN') + 1];
      if (sub === '/Create') tasks.set(name, readFileSync(argv[argv.indexOf('/XML') + 1]).toString('utf16le'));
      if (!tasks.has(name)) return { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      if (sub === '/Delete') tasks.delete(name);
      if (sub === '/Run') take();
      if (sub === '/End') drop();
      if (sub === '/Query') return okr(argv.includes('/XML') ? tasks.get(name) : `"\\${name}","N/A","${os.held ? 'Running' : 'Ready'}"`);
      return okr();
    }
    if (cmd === 'launchctl') {
      if (sub === 'bootstrap') take();
      if (sub === 'bootout') drop();
      if (sub === 'print') return os.held ? okr(`state = running\n\targuments = {\n${registered().split('\n').map((a) => `\t\t${a}`).join('\n')}\n\t}\n`) : { code: 113, stdout: '', stderr: 'Could not find service' };
      return okr();
    }
    if (argv.includes('show')) return okr(`ExecStart={ path=/usr/bin/env ; argv[]=${registered()} ; ignore_errors=no ; }\nDropInPaths=\nFragmentPath=\n`);
    if (argv.includes('enable')) take();
    if (argv.includes('disable')) drop();
    if (argv.includes('is-active')) return okr(os.held ? 'active' : 'inactive');
    return okr();
  };
  return Object.assign(os, { run });
}

/** The OS commands that change something (status only asks). */
const mutating = (calls: string[][]) => calls.filter((c) => !/^(\/Query|print|is-active)$/.test(c[0] === 'systemctl' ? c[2] : c[1]));

async function omer(opts: { elicit?: ElicitHandler; formWaitMs?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'rdv-service-'));
  const os = fakeOs(root);
  const s = await makeSide('omer', join(root, 'omer home'), { ...opts, service: { env: os.env, run: os.run, waitMs: 2_000 } });
  sides.push(s);
  os.home = s.home;
  await ok(s, 'rdv_init', { profile: 'omer', email: `omer.${process.pid}.${Date.now()}@example.com`, relays: [relay.url] });
  return { s, os, def: serviceDefinition(s.home.dir, 'omer', os.env) };
}

const inbound = async (s: Side) => (await ok(s, 'rdv_status')).inbound;
async function until(fn: () => Promise<boolean> | boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('rdv_service', () => {
  it('without an approval form, install is refused with no confirm phrase and names the terminal command; status and remove work', { timeout: 60_000 }, async () => {
    const { s, os, def } = await omer();
    const r = await s.call('rdv_service', { action: 'install' });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('rdv service install');
    expect(r.text).toMatch(/approval form/);
    expect(r.text).toMatch(/no confirm phrase/);
    expect(mutating(os.calls)).toEqual([]);
    for (const f of def.files) expect(existsSync(f.path)).toBe(false);
    expect(Object.keys(s.home.readConsent())).toEqual([]);
    expect(await inbound(s)).toBe('consumer');
    const st = await ok(s, 'rdv_service', { action: 'status' });
    expect(st).toMatchObject({ name: NAME, installed: false, running: false, profile: 'omer', home: s.home.dir, service_holds_listener_lock: false, this_server: 'consumer' });
    expect(st.listener_lock).toMatchObject({ held_by: 'rdv-mcp' });
    expect(await ok(s, 'rdv_service', { action: 'remove' })).toMatchObject({ removed: false });
    expect(mutating(os.calls)).toEqual([]);
    // The tool takes nothing but the action.
    const tool = (await s.client.listTools()).tools.find((t) => t.name === 'rdv_service')!;
    expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(['action']);
  });

  it('install shows exactly what is installed, applies only with a yes, and hands listener.lock to the service', { timeout: 60_000 }, async () => {
    const h = human(no, yes);
    const { s, os, def } = await omer({ elicit: h.handler });
    expect(await inbound(s)).toBe('consumer');

    expect(await ok(s, 'rdv_service', { action: 'install' })).toMatchObject({ approved: false, answer: 'declined' });
    expect(mutating(os.calls)).toEqual([]);
    for (const f of def.files) expect(existsSync(f.path)).toBe(false);
    expect(await inbound(s)).toBe('consumer');

    const done = await ok(s, 'rdv_service', { action: 'install' });
    const form = h.asked[1];
    const msg = String(form.message);
    // What, the exact command line, the profile and home, when and as whom, how to remove it.
    expect(msg).toContain(def.kind);
    expect(msg).toContain(def.platform === 'win32' ? def.commandLine : def.launcherLine);
    expect(msg).toContain(`Profile:   omer`);
    expect(msg).toContain(`Home:      ${s.home.dir}`);
    expect(msg).toMatch(/at every login of this user, as you, with your user's privileges only \(no administrator rights\)/);
    expect(msg).toContain(`rdv service remove --home "${s.home.dir}"`);
    expect(msg).toContain('rdv_service "remove"');
    expect(msg).toMatch(/never approves anything on its own \(no auto-grant, no auto-confirm\)/);
    expect((form as { requestedSchema: { required?: string[] } }).requestedSchema.required).toEqual(['approve']);

    for (const c of def.install) expect(os.calls).toContainEqual(c);
    for (const f of def.files) expect(existsSync(f.path)).toBe(true);
    // The service could take the lock only because this server let go of it first.
    expect(os.took).toBe(true);
    expect(done).toMatchObject({ installed: true, changed: true, service: { installed: true, current: true, service_holds_listener_lock: true, this_server: 'attached' } });
    expect(done.handed_over).toMatch(/gave listener.lock to the service/);
    expect(done.service.listener_lock).toMatchObject({ held_by: ROLE });
    expect(s.humanLog.join('\n')).toContain(`background listener ${NAME} installed through the approval form`);
    // Still attached after the hand-over window's ticks: it follows the service.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await inbound(s)).toBe('attached');
    expect(await ok(s, 'rdv_service', { action: 'status' })).toMatchObject({ installed: true, running: true, service_holds_listener_lock: true, this_server: 'attached' });

    // Installed already, as it would be now: no second form.
    expect(await ok(s, 'rdv_service', { action: 'install' })).toMatchObject({ installed: true, changed: false });
    expect(h.asked).toHaveLength(2);

    // Remove needs no form: it only narrows. This server receives again once the service has stopped.
    const removed = await ok(s, 'rdv_service', { action: 'remove' });
    expect(removed).toMatchObject({ removed: true, name: NAME });
    for (const c of def.remove) expect(os.calls).toContainEqual(c);
    for (const f of def.files) expect(existsSync(f.path)).toBe(false);
    expect(h.asked).toHaveLength(2);
    await until(async () => (await inbound(s)) === 'consumer', 'this server to take over');
    expect(await ok(s, 'rdv_service', { action: 'status' })).toMatchObject({ installed: false, this_server: 'consumer', listener_lock: { held_by: 'rdv-mcp' } });
  });

  it('a yes to a form whose service changed meanwhile installs nothing', { timeout: 60_000 }, async () => {
    const forms: Array<(r: ElicitResult) => void> = [];
    const handler: ElicitHandler = () => new Promise<ElicitResult>((answer) => forms.push(answer));
    const { s, os, def } = await omer({ elicit: handler, formWaitMs: 0 });
    const installs = () => os.calls.filter((c) => def.install.some((i) => i.join(' ') === c.join(' ')));

    // The definition changes after the form was shown (node upgraded to another path): the yes does nothing.
    const first = await ok(s, 'rdv_service', { action: 'install' });
    expect(first.status).toBe('awaiting_human');
    await until(() => forms.length === 1, 'the first form');
    const node = os.env.node;
    os.env.node = `${node}-upgraded`;
    forms[0]({ action: 'accept', content: { approve: true } });
    const stale = await waitEvent(s, (e) => e.type === 'approval' && e.approval_id === first.approval_id, 'the first answer', T);
    expect(stale.outcome).toBe('changed');
    expect(installs()).toEqual([]);
    for (const f of def.files) expect(existsSync(f.path)).toBe(false);
    os.env.node = node;

    // Meanwhile a service of the same name is installed for another home (another agent with this profile name): refused.
    const second = await ok(s, 'rdv_service', { action: 'install' });
    await until(() => forms.length === 2, 'the second form');
    const other = serviceDefinition(`${s.home.dir}-other`, 'omer', os.env);
    for (const f of other.files) {
      mkdirSync(join(f.path, '..'), { recursive: true });
      writeFileSync(f.path, f.encoding === 'utf16le' ? Buffer.from(`\uFEFF${f.content}`, 'utf16le') : f.content);
    }
    if (def.platform === 'win32') os.tasks.set(NAME, other.files[1].content);
    forms[1]({ action: 'accept', content: { approve: true } });
    const refused = await waitEvent(s, (e) => e.type === 'approval' && e.approval_id === second.approval_id, 'the second answer', T);
    expect(refused.outcome).toBe('failed');
    expect(refused.error).toMatch(/another home/);
    expect(installs()).toEqual([]);
    expect(await ok(s, 'rdv_service', { action: 'status' })).toMatchObject({ installed: true, installed_for_another_home: `${s.home.dir}-other`, this_server: 'consumer' });
    // Nor can this agent remove the other home's service.
    const r = await s.call('rdv_service', { action: 'remove' });
    expect([r.isError, r.text]).toEqual([true, expect.stringContaining('another home')]);
  });

  it('a service changed outside Rendezvous is reported (status, the human log, an event) and the install form says so', { timeout: 60_000 }, async () => {
    const h = human(yes);
    const { s: side, def } = await omer({ elicit: h.handler });
    await ok(side, 'rdv_service', { action: 'install' });
    const f = def.files[0];
    const now = readFileSync(f.path);
    writeFileSync(f.path, Buffer.concat([now, Buffer.from(f.encoding === 'utf16le' ? '\r\n\u0000' : '\n# --auto-grant friend\n')]));
    const st = await ok(side, 'rdv_service', { action: 'status' });
    expect(st).toMatchObject({ installed: true, state: 'tampered', tampered: true, current: false });
    expect(st.tamper_reasons.join('\n')).toContain(`${f.path} was changed`);
    expect(st.tamper_note).toMatch(/changed outside Rendezvous/);
    expect(side.humanLog.join('\n')).toMatch(/WARNING: the background listener rdv-listen-omer was changed outside Rendezvous/);
    const ev = await waitEvent(side, (e) => e.type === 'service_tampered', 'the warning event', T);
    expect(ev.name).toBe(NAME);
    // Reported once per change, not on every status.
    await ok(side, 'rdv_service', { action: 'status' });
    expect(side.humanLog.filter((l) => l.includes('WARNING: the background listener')).length).toBe(1);
    // Install again: the form says it was modified, and puts it back.
    const again = await ok(side, 'rdv_service', { action: 'install' });
    expect(String(h.asked[1].message)).toContain('The installed service was modified outside Rendezvous');
    expect(again).toMatchObject({ installed: true, changed: true, service: { state: 'current' } });
  });

  it('a registration-only change is warned once across quick and full checks; restored, then changed again, it warns again (issue #118)', { timeout: 60_000 }, async () => {
    const { s: side, os } = await omer({ elicit: human(yes).handler });
    await ok(side, 'rdv_service', { action: 'install' });
    let clock = 1_000_000_000_000;
    const timed = await makeSide('omer-clock', side.home.dir, { service: { env: os.env, run: os.run, waitMs: 500, now: () => clock } });
    sides.push(timed);
    const check = (timed.server as unknown as { checkService(force: boolean): Promise<void> }).checkService.bind(timed.server);
    const warnings = () => timed.humanLog.filter((l) => l.includes('WARNING: the background listener')).length;
    // 30 s ticks: every tick is a quick pass, every 5th minute also a full check.
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 30_000) {
        clock += 30_000;
        await check(false);
      }
    };
    const orig = os.tasks.get(NAME);
    const tamper = (on: boolean) => {
      if (os.env.platform === 'win32') os.tasks.set(NAME, on ? orig!.replace('</Arguments>', ' --auto-grant friend</Arguments>') : orig!);
      else os.regOverride = on ? 'something-else' : undefined;
    };
    await run(5 * 60_000);
    expect(warnings()).toBe(0);
    tamper(true); // the files are intact; only what the OS runs changed
    await run(16 * 60_000); // many quick passes and three full checks
    expect(warnings()).toBe(1);
    tamper(false);
    await run(6 * 60_000); // the next full check finds it clean and forgets it
    expect(warnings()).toBe(1);
    tamper(true);
    await run(6 * 60_000);
    expect(warnings()).toBe(2);
  });

  it('a reinstall or a remove forgets reported tampering: the same change afterwards warns again (issue #118)', { timeout: 60_000 }, async () => {
    const { s: side, os } = await omer({ elicit: human(yes).handler });
    await ok(side, 'rdv_service', { action: 'install' });
    const timed = await makeSide('omer-clock2', side.home.dir, { elicit: human(yes).handler, service: { env: os.env, run: os.run, waitMs: 500 } });
    sides.push(timed);
    const warnings = () => timed.humanLog.filter((l) => l.includes('WARNING: the background listener')).length;
    const orig = os.tasks.get(NAME);
    const tamper = () => {
      if (os.env.platform === 'win32') os.tasks.set(NAME, orig!.replace('</Arguments>', ' --auto-grant friend</Arguments>'));
      else os.regOverride = 'something-else';
    };
    tamper();
    await ok(timed, 'rdv_service', { action: 'status' });
    expect(warnings()).toBe(1);
    await ok(timed, 'rdv_service', { action: 'install' }); // puts it back
    tamper();
    await ok(timed, 'rdv_service', { action: 'status' });
    expect(warnings()).toBe(2);
    await ok(timed, 'rdv_service', { action: 'remove' });
    await ok(timed, 'rdv_service', { action: 'install' });
    tamper();
    await ok(timed, 'rdv_service', { action: 'status' });
    expect(warnings()).toBe(3);
  });

  it('a registration reason is full-only whatever OS text ends it (issue #118)', () => {
    expect(quickReason('what the OS runs is not what was installed: x is gone')).toBe(false);
    expect(quickReason('what the OS runs is not what was installed: x was changed')).toBe(false);
    expect(quickReason('it runs with --auto-grant')).toBe(false);
    expect(quickReason('/path/unit.service is gone')).toBe(true);
    expect(quickReason('there is no record of what was installed')).toBe(true);
  });

  it('a profile that cannot name a service is refused at rdv_init, and an existing one at install', { timeout: 60_000 }, async () => {
    const { s: side } = await omer({ elicit: human(yes).handler });
    const bad = await side.call('rdv_init', { replace: true, profile: "x)\nExecStartPre=/bin/sh -c 'id'\n#" });
    expect(bad.isError).toBe(true);
    side.home.writeConfig({ ...side.home.readConfig(), profile: 'bad profile/name' });
    const r = await side.call('rdv_service', { action: 'install' });
    expect([r.isError, r.text]).toEqual([true, expect.stringContaining('cannot name a background service')]);
  });

  it('every rdv-mcp on the home leaves listener.lock to the starting service (listener.yield)', { timeout: 60_000 }, async () => {
    const { s: first, os } = await omer({ elicit: human(yes).handler });
    const second = await makeSide('omer-2', first.home.dir, { service: { env: os.env, run: os.run, waitMs: 500 } });
    sides.push(second);
    expect(await inbound(second)).toBe('attached');
    os.noTake = true; // the service is slow to start: nobody holds the lock for a while
    await ok(first, 'rdv_service', { action: 'install' });
    expect(await inbound(first)).toBe('attached');
    // Neither server takes the lock while it is left to the service.
    await new Promise((r) => setTimeout(r, 1500));
    expect([await inbound(first), await inbound(second)]).toEqual(['attached', 'attached']);
    // Removed: one of them receives again.
    await ok(first, 'rdv_service', { action: 'remove' });
    await until(async () => (await inbound(first)) === 'consumer' || (await inbound(second)) === 'consumer', 'a server to take over');
  });

  it('a changed service is flagged without anyone asking: at start, and on the tick', { timeout: 60_000 }, async () => {
    const { s: side, os, def } = await omer({ elicit: human(yes).handler });
    await ok(side, 'rdv_service', { action: 'install' });
    const f = def.files[0];
    writeFileSync(f.path, Buffer.concat([readFileSync(f.path), Buffer.from('\n')]));
    // A server started on this home now says so at once.
    const later = await makeSide('omer-later', side.home.dir, { service: { env: os.env, run: os.run, waitMs: 500 } });
    sides.push(later);
    await until(() => later.humanLog.some((l) => l.includes('WARNING: the background listener rdv-listen-omer was changed outside Rendezvous')), 'the warning at start');
    // A running one notices on its tick (checkMs shortened for the test).
    const ticking = await makeSide('omer-tick', side.home.dir, { service: { env: os.env, run: os.run, waitMs: 500, checkMs: 100 } });
    sides.push(ticking);
    await until(() => ticking.humanLog.some((l) => l.includes('WARNING')), 'its first warning');
    await ok(side, 'rdv_service', { action: 'install' }); // put back
    await new Promise((r) => setTimeout(r, 1500)); // a tick sees it as installed again
    const n = ticking.humanLog.length;
    writeFileSync(f.path, Buffer.concat([readFileSync(f.path), Buffer.from('\n\n')]));
    await until(() => ticking.humanLog.slice(n).some((l) => l.includes('WARNING')), 'the warning on the tick');
    expect((await waitEvent(ticking, (e) => e.type === 'service_tampered', 'the event', T)).name).toBe(NAME);
  });
});
