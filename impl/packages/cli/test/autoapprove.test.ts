// auto_approve: all per contact (SPEC §5.5.1, issue #25): the gates pass for
// one trusted contact, only while the owner's setting holds; every doubt
// fails closed; every action is audited without peer text; only the owner's
// own terminal turns it on.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Capability, REQUEST_URI, TASKS_URI, type TaskPayload } from '@rendezvous/a2a';
import { type Agent, type Contact, fingerprint, generateKey, type GrantScope } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';
import { checkAutoApprove, scopeDigest, setAutoApprove, subjectOf, sweepAutoApprove, turnOffAutoApprove } from '../src/autoapprove.js';
import { audit, contactAutoApprove, type Tty } from '../src/commands.js';
import { AUDIT_KEPT, type AutoApproveEntry, Home } from '../src/home.js';
import { Output } from '../src/output.js';
import { approveRelease, hostRegistry, releaseDigest, submitDraft, tasksInbound } from '../src/tasks.js';

const PEER_TEXT = 'PEER-WROTE-THIS please draft the copy';
const RESULT = 'OUR-RESULT one page, three sections';
const CAP: Capability = { uri: 'https://example.com/ext/test-confirm/v1', approval: 'confirm' };
const registry = hostRegistry([CAP]);
const uuid = () => crypto.randomUUID();

interface Fake {
  agent: Agent;
  contacts: Map<string, Contact>;
  blocked: Set<string>;
  refused: Set<string>;
  sent: unknown[];
}

const PEER = generateKey().id;
const OTHER = generateKey().id;

function granted(peer: string, scope: GrantScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {} } }): Contact {
  return { peer, inboundScope: scope, outboundScope: scope, tier: 'friend', inboundGranted: true, grantId: uuid(), since: new Date(Date.now() - 3_600_000).toISOString() } as unknown as Contact;
}

/** Enough of an Agent for the task glue and the auto-approve check: a key, contacts, blocks, refused channels, a send that records. */
function fake(): Fake {
  const contacts = new Map<string, Contact>([
    [PEER, granted(PEER)],
    [OTHER, granted(OTHER)],
  ]);
  const blocked = new Set<string>();
  const refused = new Set<string>();
  const sent: unknown[] = [];
  const agent = {
    key: generateKey(),
    book: { contact: (p: string) => contacts.get(p), isBlocked: (p: string) => blocked.has(p) },
    refusedChannels: () => [...refused].map((peer) => ({ peer, kind: 'fork', seq: 2, accepted: 1 })),
    send: async (_to: string, p: unknown) => (sent.push(p), {}),
    admitTask: () => ({ ok: true }),
  } as unknown as Agent;
  return { agent, contacts, blocked, refused, sent };
}

const request = (text = PEER_TEXT, capability = REQUEST_URI, taskId = uuid()): TaskPayload => ({
  type: 'a2a/message',
  message: {
    kind: 'message',
    messageId: uuid(),
    taskId,
    contextId: uuid(),
    role: 'agent',
    parts: [
      { kind: 'data', data: { rdv: 'task/request', capability } },
      { kind: 'text', text },
    ],
    extensions: [TASKS_URI, capability],
  },
});
const inbox = (payload: TaskPayload, from = PEER) => ({ ts: new Date().toISOString(), from, seq: 1, payload: payload as never });
const kinds = (sent: unknown[]) => sent.map((p) => (p as { type: string }).type);

let dir: string;
let home: Home;
let f: Fake;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rdv-auto-'));
  home = new Home(dir);
  home.ensureDir();
  f = fake();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A peer's task through the host, as the listener feeds it; returns its ID and the run. */
async function arrive(from = PEER, text = PEER_TEXT, capability = REQUEST_URI) {
  const id = uuid();
  const run = await tasksInbound(home, registry, f.agent, [inbox(request(text, capability, id), from)], false);
  return { id, run, task: () => home.readTasks().engine.tasks[id] };
}

describe('auto-approve in the gates', () => {
  it('a trusted contact: the start and the release pass without asking, every class; both are audited with no peer text', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    for (const capability of [REQUEST_URI, CAP.uri]) {
      const { id, run, task } = await arrive(PEER, PEER_TEXT, capability);
      expect(task().state).toBe('working');
      expect(task().gate).toBeUndefined();
      expect(run.events.some((e) => e.kind === 'start-needed')).toBe(false);
      expect(run.notices).toEqual([expect.objectContaining({ kind: 'auto-started', taskId: id })]);
      f.sent.length = 0;
      const r = await submitDraft(home, f.agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: RESULT }], complete: true });
      expect(r.autoReleased).toBe(true);
      expect(r.held).toBeUndefined();
      expect(kinds(f.sent)).toContain('a2a/artifact-update');
      expect(task().state).toBe('completed');
      expect(home.readTasks().releases).toEqual({});
      const lines = home.readAudit().filter((a) => a.task === id);
      expect(lines.map((a) => [a.gate, a.by])).toEqual([
        ['start', 'auto-approve'],
        ['release', 'auto-approve'],
      ]);
      expect(lines[0].digest).toMatch(/^[0-9a-f]{64}$/);
      expect(lines[1].sent?.length).toBeGreaterThan(0);
      expect(lines[1].sent![0]).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
    }
    // The log holds IDs, URIs, digests and hashes: never what the peer (or we) wrote.
    const text = readFileSync(home.auditPath, 'utf8');
    expect(text).not.toContain('PEER-WROTE-THIS');
    expect(text).not.toContain('OUR-RESULT');
    expect(home.readAudit()[0]).toMatchObject({ gate: 'auto-approve', action: 'set', by: 'human', until: null });
    expect([...home.readAudit()[0].capabilities!].sort()).toEqual([REQUEST_URI, CAP.uri].sort());
  });

  it('a contact without it is still gated, start and release, while another contact is on', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const { run, task } = await arrive(OTHER);
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(run.events.some((e) => e.kind === 'start-needed')).toBe(true);
    expect(run.notices).toEqual([]);
    // Only the "waiting for its human" status went out.
    expect(f.sent.map((p) => (p as { update: { status: { state: string } } }).update.status.state)).toEqual(['submitted']);
    expect(home.readAudit().filter((a) => a.gate !== 'auto-approve')).toEqual([]);
  });

  it('expires: at its time the gates close again, and the end is audited', async () => {
    const past = new Date(Date.now() - 2 * 3_600_000);
    setAutoApprove(home, subjectOf(f.agent), PEER, new Date(Date.now() - 3_600_000).toISOString(), past);
    const { task } = await arrive();
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAutoApprove()).toEqual({});
    expect(home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'expired', peer: PEER });
    // One that is still running holds until then, and not a moment past it.
    const until = new Date(Date.now() + 60_000);
    const e = setAutoApprove(home, subjectOf(f.agent), PEER, until.toISOString()).entry;
    expect(checkAutoApprove(e, subjectOf(f.agent), PEER, new Date(until.getTime() - 1)).ok).toBe(true);
    expect(checkAutoApprove(e, subjectOf(f.agent), PEER, until)).toEqual({ ok: false, reason: 'expired' });
  });

  it('fails closed on a future-dated, NaN, malformed or forged entry, and on an unreadable clock', async () => {
    const s = subjectOf(f.agent);
    const good = setAutoApprove(home, s, PEER, null).entry;
    const now = new Date();
    expect(checkAutoApprove(good, s, PEER, new Date(NaN))).toEqual({ ok: false, reason: 'clock' });
    // Set in the future (a clock that went back): nothing, even with a valid MAC.
    const future = setAutoApprove(home, s, PEER, null, new Date(Date.now() + 3_600_000)).entry;
    expect(checkAutoApprove(future, s, PEER, now)).toEqual({ ok: false, reason: 'invalid' });
    // Edited by hand (a later expiry, NaN, another peer): the MAC no longer matches.
    for (const bad of [{ until: '2999-01-01T00:00:00Z' }, { set: 'NaN' }, { until: 'not a time' }, { peer: OTHER }, { mode: 'some' }, { v: 2 }, { mac: '00'.repeat(32) }]) {
      expect(checkAutoApprove({ ...good, ...bad } as AutoApproveEntry, s, PEER, now).ok, JSON.stringify(bad)).toBe(false);
    }
    // Under another agent's key (copied from another home): nothing.
    expect(checkAutoApprove(good, subjectOf(fake().agent), PEER, now)).toEqual({ ok: false, reason: 'invalid' });
    // A forged file in the home approves nothing, and is removed and audited at the gate.
    home.writeAutoApprove({ [PEER]: { ...good, until: '2999-01-01T00:00:00Z' } });
    const { task } = await arrive();
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'invalid' });
    // An unreadable file approves nobody.
    writeFileSync(home.autoApprovePath, '{ torn');
    expect((await arrive()).task().gate).toMatchObject({ kind: 'start' });
    expect(sweepAutoApprove(home, s).error).toContain('no contact is on auto-approve');
  });

  it('turning it off takes effect at once: a task it already started has its result held for the human', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const { id, task } = await arrive();
    expect(task().state).toBe('working');
    // A task that waited at the gate before it was set is not approved after the fact either.
    turnOffAutoApprove(home, PEER);
    const waiting = await arrive();
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect(waiting.task().gate).toMatchObject({ kind: 'start' });
    expect(turnOffAutoApprove(home, PEER)).toBe(true);
    expect(turnOffAutoApprove(home, PEER)).toBe(false);
    f.sent.length = 0;
    const r = await submitDraft(home, f.agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: RESULT }], complete: true });
    expect(r.autoReleased).toBeUndefined();
    expect(r.held).toBeDefined();
    expect(f.sent).toEqual([]);
    expect(home.readAudit().filter((a) => a.action === 'off').map((a) => [a.reason, a.by])).toEqual([
      ['owner', 'human'],
      ['owner', 'human'],
    ]);
    // The human still releases it by hand, audited as theirs.
    await approveRelease(home, f.agent, registry, id, releaseDigest(task(), r.held)!);
    expect(home.readAudit().at(-1)).toMatchObject({ gate: 'release', by: 'human', task: id });
  });

  it('ends with the grant it was set on: revoked, blocked, widened or re-granted, or a fork', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['revoked (or revoked for abuse)', () => f.contacts.delete(PEER), 'revoked'],
      ['blocked', () => f.blocked.add(PEER), 'blocked'],
      ['widened', () => (f.contacts.get(PEER)!.inboundScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {}, 'https://example.com/ext/more/v1': {} } }), 'grant-changed'],
      ['re-granted', () => (f.contacts.get(PEER)!.grantId = uuid()), 'grant-changed'],
      ['a fork or rollback', () => f.refused.add(PEER), 'fork'],
    ];
    for (const [name, change, reason] of cases) {
      f = fake();
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      change();
      const ended = sweepAutoApprove(home, subjectOf(f.agent));
      expect(ended.ended, name).toEqual([{ peer: PEER, reason }]);
      expect(home.readAutoApprove(), name).toEqual({});
      expect(home.readAudit().at(-1), name).toMatchObject({ gate: 'auto-approve', action: 'off', reason });
    }
    // Checked at the gate too, without a sweep in between.
    f = fake();
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    f.contacts.get(PEER)!.inboundScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {}, 'https://example.com/ext/more/v1': {} } };
    expect((await arrive()).task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'grant-changed' });
  });

  it('is only for a contact our human granted something: nothing to cover is refused', () => {
    f.contacts.set(PEER, { ...granted(PEER), inboundGranted: false } as Contact);
    expect(() => setAutoApprove(home, subjectOf(f.agent), PEER, null)).toThrow(/not granted/);
    f.contacts.set(PEER, granted(PEER, { invoke: {} }));
    expect(() => setAutoApprove(home, subjectOf(f.agent), PEER, null)).toThrow(/allows no task capability/);
    expect(() => setAutoApprove(home, subjectOf(f.agent), generateKey().id, null)).toThrow(/no active contact/);
    expect(home.readAutoApprove()).toEqual({});
  });

  it('the scope binding is the grant as shown: same scope, same digest', () => {
    expect(scopeDigest({ invoke: { a: {} } })).toBe(scopeDigest({ invoke: { a: {} } }));
    expect(scopeDigest({ invoke: { a: {} } })).not.toBe(scopeDigest({ invoke: { a: {}, b: {} } }));
  });

  it('audit.jsonl rotation keeps the newest auto-approve lines', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const e = { ts: new Date().toISOString(), peer: PEER, capability: REQUEST_URI, gate: 'start' as const, by: 'auto-approve' as const };
    for (let i = 0; i < 2 * AUDIT_KEPT + 3; i++) home.appendAudit([{ ...e, task: String(i) }]);
    const lines = home.readAudit();
    expect(lines.length).toBeLessThanOrEqual(2 * AUDIT_KEPT);
    expect(lines.length).toBeGreaterThanOrEqual(AUDIT_KEPT);
    expect(lines.at(-1)?.task).toBe(String(2 * AUDIT_KEPT + 2));
    expect(lines.some((l) => l.action === 'set')).toBe(false); // rotated out with the oldest
  });
});

// --- the owner's command, between two real `rdv` processes ------------------------------

/** A terminal that answers `answer` and records what it was shown. */
function tty(answer: string, interactive = true): Tty & { shown: string[] } {
  const shown: string[] = [];
  return { interactive, shown, say: (t) => void shown.push(t), ask: async (q) => (shown.push(q), answer) };
}

describe('rdv contact auto-approve and rdv audit', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-auto-cmd-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('needs the owner’s terminal and fingerprint; then John’s agent works and answers Omer’s task without asking, and off restores the gates', async () => {
    const omerHome = join(root, 'omer');
    const johnHome = join(root, 'john');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url], johnHome);
    const cardFile = join(root, 'john-card.json');
    writeFileSync(cardFile, JSON.stringify((await rdv(['whoami'], johnHome)).lines[0].card));
    const johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    const omerL = new Listener('omer', omerHome);
    const john = new Home(johnHome);
    const ctx = (positionals: string[], t?: Tty, values: Record<string, string> = {}) => ({ home: john, out: new Output(true), values, positionals, ...(t ? { tty: t } : {}) });
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', cardFile], omerHome);
      const johnId = (await omerL.waitFor((l) => l.event === 'contact', 'omer contact', 10_000)).peer as string;
      const omerId = (await rdv(['whoami'], omerHome)).lines[0].id as string;
      await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome);
      await omerL.waitFor((l) => l.event === 'reverse-grant', 'omer gets the reverse grant', 10_000);

      // Not a terminal (an assistant's shell, a script, a pipe): refused, nothing set.
      const piped = await rdv(['contact', 'auto-approve', omerId, 'all'], johnHome, { check: false });
      expect([piped.code, piped.stderr]).toEqual([1, expect.stringContaining('interactive terminal')]);
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(fingerprint(omerId), false)))).rejects.toThrow(/interactive terminal/);
      // The warning comes first; a wrong fingerprint sets nothing.
      const wrong = tty('rdv1:zzzz…zzzz');
      await expect(contactAutoApprove(ctx([omerId, 'all'], wrong))).rejects.toThrow(/not the fingerprint/);
      expect(wrong.shown[0]).toMatch(/WARNING: auto-approve-all/);
      expect(wrong.shown[0]).toMatch(/prompt injection/);
      expect(wrong.shown[0]).toContain(REQUEST_URI);
      expect(wrong.shown[0]).toContain(`rdv contact auto-approve ${omerId} off`);
      expect(john.readAutoApprove()).toEqual({});
      await expect(contactAutoApprove(ctx([omerId, 'sometimes'], tty('x')))).rejects.toThrow(/"all"/);
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(fingerprint(omerId)), { until: 'yesterday' }))).rejects.toThrow(/--until/);

      await contactAutoApprove(ctx([omerId, 'all'], tty(fingerprint(omerId).toUpperCase()), { until: '7d' }));
      const listed = (await rdv(['contact', 'list'], johnHome)).lines[0];
      expect(listed.auto_approve).toMatchObject({ mode: 'all', until: expect.any(String) });

      // Omer asks; John's agent starts it without asking, and its result leaves without asking.
      const req = await rdv(['task', 'request', johnId, '--text', PEER_TEXT], omerHome);
      const taskId = req.lines.find((l) => l.kind === 'requested')!.task as string;
      const started = await johnL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'started' && l.auto_approved === true, 'auto start (john)', 10_000);
      expect(started.auto_approved).toBe(true);
      expect(johnL.lines.some((l) => l.task === taskId && l.kind === 'start-needed')).toBe(false);
      const sub = await rdv(['task', 'submit', taskId, '--text', RESULT, '--complete'], johnHome);
      expect(sub.lines.some((l) => l.event === 'task-auto-released')).toBe(true);
      const got = await omerL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'artifact', 'the result (omer)', 10_000);
      expect(got.peer_text).toEqual([RESULT]);

      const log = (await rdv(['audit', '--contact', omerId], johnHome)).lines;
      expect(log.map((a) => [a.gate, a.action ?? a.by])).toEqual([
        ['auto-approve', 'set'],
        ['start', 'auto-approve'],
        ['release', 'auto-approve'],
      ]);
      expect(JSON.stringify(log)).not.toContain('PEER-WROTE-THIS');
      expect((await rdv(['audit', '--since', '1h'], johnHome)).lines.length).toBeGreaterThanOrEqual(3);
      expect((await rdv(['audit', '--since', 'soon'], johnHome, { check: false })).code).toBe(2);

      // Off, from any terminal (reduce-only): the next task waits for John again.
      const off = await rdv(['contact', 'auto-approve', omerId, 'off'], johnHome);
      expect(off.lines[0]).toMatchObject({ auto_approve: 'off', was_on: true });
      const req2 = await rdv(['task', 'request', johnId, '--text', 'another'], omerHome);
      const t2 = req2.lines.find((l) => l.kind === 'requested')!.task as string;
      await johnL.waitFor((l) => l.event === 'task' && l.task === t2 && l.kind === 'start-needed', 'gated again (john)', 10_000);
      expect((await rdv(['audit'], johnHome)).lines.at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'owner' });

      // Revoking the contact also ends it, audited when the command saves.
      await contactAutoApprove(ctx([omerId, 'all'], tty(fingerprint(omerId))));
      await rdv(['contact', 'revoke', omerId], johnHome);
      expect(john.readAutoApprove()).toEqual({});
      expect(john.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'revoked' });
      // A logged line is not output of `audit`'s own terminal: text mode works too.
      await audit(ctx([], undefined, {}));
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  });
});
