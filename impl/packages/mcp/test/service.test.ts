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
  const os = { env, calls, tasks, home: undefined as Home | undefined, held: undefined as (() => void) | undefined, took: false };
  const take = () => {
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
      if (sub === 'print') return os.held ? okr('state = running') : { code: 113, stdout: '', stderr: 'Could not find service' };
      return okr();
    }
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
});
