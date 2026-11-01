// tasks/v1 in the CLI host (issues #24, #36, #39): the scenario between two
// real `rdv` processes, and the host glue: the engine context, the digests
// both gates are bound to, bounded and persistent state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Capability,
  CapabilityRegistry,
  receiveTask,
  REQUEST_URI,
  TASK_BOUNDS,
  FILES_URI,
  TASKS_URI,
  type TaskEngineState,
  type TaskPayload,
  emptyTaskState,
} from '@rendezvous/a2a';
import { type Agent, type Contact, generateKey, type GrantScope, GROUPS_EXTENSION, MEETINGS_CAPABILITY, RECEIPTS_EXTENSION, scopeAllows } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rdv } from '../scenarios/harness.js';
import { RESULT_TEXT, runTaskScenario, TASK_TEXT } from '../scenarios/tasks.js';
import { AUDIT_KEPT, Home } from '../src/home.js';
import {
  approveRelease,
  approveStart,
  hostCardCapabilities,
  hostRegistry,
  releaseDigest,
  startDigest,
  submitDraft,
  TaskChangedError,
  taskCtx,
  tasksInbound,
} from '../src/tasks.js';

describe('tasks scenario (in-memory relay)', () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  });
  afterAll(() => relay.close());

  it("Omer's agent asks John's for a task; John approves the start and the release; Omer gets the result", async () => {
    const r = await runTaskScenario({ relays: [relay.url] });
    expect(r.artifact.peer_text).toEqual([RESULT_TEXT]);
    expect([r.omer.state, r.john.state]).toEqual(['completed', 'completed']);
    expect(r.omer.artifacts).toEqual([expect.objectContaining({ done: true, name: 'copy' })]);
    // The relay only ever saw ciphertext.
    const wire = relay.events.map((e) => e.content).join('');
    for (const s of ['task/request', TASK_TEXT, RESULT_TEXT]) expect(wire).not.toContain(s);
  });
});

// --- the host glue, without a network -------------------------------------------------

const PEER = generateKey().id;
const OTHER = generateKey().id;
const CAP: Capability = { uri: 'https://example.com/ext/test-cap/v1', approval: 'confirm' };
const uuid = () => crypto.randomUUID();

function contactWith(scope: GrantScope | null, peer = PEER): Contact {
  return { peer, inboundScope: scope, outboundScope: scope, tier: 'friend' } as unknown as Contact;
}

/** Enough of an Agent for the task glue: a contact book and a send that records. */
function fakeAgent(contact: Contact | undefined, sent: unknown[] = []): Agent {
  return {
    book: { contact: (p: string) => (contact && p === contact.peer ? contact : undefined) },
    sendGated: async (_to: string, p: unknown) => (sent.push(p), {}),
    // Core's limiter stands aside here; the engine's own bounds are what these tests check.
    admitTask: () => ({ ok: true }),
  } as unknown as Agent;
}

const taskRequest = (capability: string, text = 'please', taskId = uuid()): TaskPayload => ({
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

describe('the engine context (issue #39)', () => {
  // The scope shapes of the #23 matrix: the tasks engine must agree with core's reading rule on each.
  const scopes: Array<[string, GrantScope | null]> = [
    ['no scope', null],
    ['boolean only, meetings', { may_propose_meetings: true }],
    ['boolean only, no meetings', { may_propose_meetings: false }],
    ['invoke with the capability', { invoke: { [CAP.uri]: {} } }],
    ['invoke without it', { invoke: { 'https://example.com/ext/other/v1': {} } }],
    ['empty invoke', { invoke: {} }],
    ['malformed invoke: an array', { invoke: [CAP.uri] as unknown as Record<string, never> }],
    ['malformed invoke: a bad key beside the capability', { invoke: { [CAP.uri]: {}, 'not a uri': {} } }],
    ['malformed invoke: a wildcard beside it', { invoke: { [CAP.uri]: {}, 'https://example.com/*': {} } }],
    ['malformed invoke: a non-object limit', { invoke: { [CAP.uri]: 'yes' as never } }],
    ['malformed invoke: a bad max_open', { invoke: { [CAP.uri]: { max_open: 0 } } }],
    ['invoke with the meetings URI, boolean false', { invoke: { [MEETINGS_CAPABILITY]: {} }, may_propose_meetings: false }],
    ['invoke with the meetings URI, boolean true', { invoke: { [MEETINGS_CAPABILITY]: {} }, may_propose_meetings: true }],
    ['invoke with the meetings URI, no boolean', { invoke: { [MEETINGS_CAPABILITY]: {} } }],
  ];
  // A registry that implements the test capability and, to compare the meeting rule too, one under the meetings URI.
  const registry = new CapabilityRegistry([CAP, { uri: MEETINGS_CAPABILITY, approval: 'confirm' }]);

  for (const [name, scope] of scopes) {
    it(`agrees with scopeAllows: ${name}`, () => {
      for (const uri of [CAP.uri, MEETINGS_CAPABILITY]) {
        const step = receiveTask(emptyTaskState(), PEER, taskRequest(uri), taskCtx(registry, contactWith(scope), 'inbound'));
        const kept = Object.keys(step.state.tasks).length === 1;
        expect(kept, `${name}, ${uri}`).toBe(scopeAllows(scope, uri));
      }
    });
  }

  it('reads the grant that covers the direction: inbound for a peer’s task, outbound for ours', () => {
    const c = { peer: PEER, inboundScope: { invoke: { [CAP.uri]: {} } }, outboundScope: { invoke: {} }, tier: 'friend' } as unknown as Contact;
    expect(Object.keys(taskCtx(registry, c, 'inbound').invoke ?? {})).toEqual([CAP.uri]);
    expect(taskCtx(registry, c, 'outbound').invoke).toEqual({});
    expect(taskCtx(registry, undefined, 'inbound').invoke).toEqual({});
  });

  it('the card advertises tasks/v1 and what the host routes, nothing it does not', () => {
    expect(hostCardCapabilities()).toEqual(['rdv/v1', 'a2a/0.3', 'https://rendezvous.nesher.co/ext/meetings/v1', 'https://rendezvous.nesher.co/ext/meeting-cancel/v1', TASKS_URI, FILES_URI, GROUPS_EXTENSION, RECEIPTS_EXTENSION, REQUEST_URI]);
    expect(hostCardCapabilities(hostRegistry([CAP]))).toContain(CAP.uri);
  });
});

describe('the gates in the host', () => {
  const registry = hostRegistry([CAP]);
  const contact = contactWith({ invoke: { [CAP.uri]: {}, [REQUEST_URI]: {} } });
  let dir: string;
  const home = () => new Home(dir);
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rdv-taskhost-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a start digest covers what the human sees: another text, step or task gives another digest', async () => {
    const h = new Home(mkdtempSync(join(tmpdir(), 'rdv-taskhost-')));
    try {
      const id = uuid();
      await tasksInbound(h, registry, fakeAgent(contact), [inbox(taskRequest(CAP.uri, 'first', id))], false);
      const t = h.readTasks().engine.tasks[id];
      const d = startDigest(t)!;
      expect(d).toMatch(/^[0-9a-f]{64}$/);
      for (const change of [{ text: ['second'] }, { created: new Date(0).toISOString() }, { peer: OTHER }, { contextId: uuid() }, { input: { a: 1 } }]) {
        expect(startDigest({ ...t, ...change })).not.toBe(d);
      }
      expect(startDigest({ ...t, gate: { ...t.gate!, step: 'input' } })).not.toBe(d);
      expect(startDigest({ ...t, gate: undefined })).toBeUndefined();
      expect(startDigest({ ...t, state: 'canceled' })).toBeUndefined();

      // approveStart re-checks under the caller's lock: a digest for other content starts nothing.
      const sent: unknown[] = [];
      await expect(approveStart(h, fakeAgent(contact, sent), registry, id, startDigest({ ...t, text: ['other'] })!)).rejects.toBeInstanceOf(TaskChangedError);
      expect(sent).toEqual([]);
      expect(h.readTasks().engine.tasks[id].state).toBe('submitted');
      await approveStart(h, fakeAgent(contact, sent), registry, id, d);
      expect(h.readTasks().engine.tasks[id].state).toBe('working');
      expect(sent).toHaveLength(1);
      expect(h.readAudit().map((a) => [a.gate, a.by, a.digest])).toEqual([['start', 'human', d]]);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('a release is bound to the draft: a changed draft is refused, and what leaves is what was shown', async () => {
    const id = uuid();
    const sent: unknown[] = [];
    const agent = fakeAgent(contact, sent);
    await tasksInbound(home(), registry, agent, [inbox(taskRequest(REQUEST_URI, 'write it', id))], false);
    await approveStart(home(), agent, registry, id, startDigest(home().readTasks().engine.tasks[id])!);
    sent.length = 0;
    const a = await submitDraft(home(), agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: 'draft A' }], complete: true });
    expect(sent).toEqual([]); // held, not sent
    const b = await submitDraft(home(), agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: 'draft B' }], complete: true });
    expect(a.digest).not.toBe(b.digest);
    await expect(approveRelease(home(), agent, registry, id, a.digest!)).rejects.toBeInstanceOf(TaskChangedError);
    expect(sent).toEqual([]);
    await approveRelease(home(), agent, registry, id, b.digest!);
    const artifact = sent.find((p) => (p as { type: string }).type === 'a2a/artifact-update') as { update: { artifact: { artifactId: string; parts: unknown[] } } };
    expect(artifact.update.artifact.parts).toEqual([{ kind: 'text', text: 'draft B' }]);
    expect(artifact.update.artifact.artifactId).toBe((b.held!.content as { artifact: { artifactId: string } }).artifact.artifactId);
    const s = home().readTasks();
    expect(s.engine.tasks[id].state).toBe('completed');
    expect(s.releases).toEqual({});
    expect(releaseDigest(s.engine.tasks[id], b.held)).toBeUndefined(); // the task ended: the draft approves nothing
  });

  it('state is bounded: a flood from one peer keeps at most 32 tasks, 4 waiting for the human, and counts the drops', async () => {
    const h = new Home(mkdtempSync(join(tmpdir(), 'rdv-taskflood-')));
    try {
      const sent: unknown[] = [];
      // max_open well above the per-peer bounds, so the waiting bound is what holds.
      const generous = contactWith({ invoke: { [CAP.uri]: { max_open: 100 } } });
      for (let i = 0; i < 40; i++) await tasksInbound(h, registry, fakeAgent(generous, sent), [inbox(taskRequest(CAP.uri, `task ${i}`))], false);
      const s = h.readTasks();
      const mine = Object.values(s.engine.tasks).filter((t) => t.peer === PEER);
      expect(mine.length).toBeLessThanOrEqual(TASK_BOUNDS.tasksPerPeer);
      expect(mine.filter((t) => t.gate).length).toBe(TASK_BOUNDS.waitingPerPeer);
      expect(s.engine.dropped.busy).toBeGreaterThan(0);
      expect(Object.keys(s.releases).length).toBeLessThanOrEqual(mine.length);
      // A stranger (no contact, no grant) creates nothing at all.
      const before = readFileSync(h.tasksPath, 'utf8');
      await tasksInbound(h, registry, fakeAgent(undefined), [inbox(taskRequest(CAP.uri), OTHER)], false);
      expect(readFileSync(h.tasksPath, 'utf8')).toBe(before);
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('audit.jsonl is bounded too', () => {
    const h = new Home(mkdtempSync(join(tmpdir(), 'rdv-audit-')));
    try {
      h.ensureDir();
      const e = { ts: new Date().toISOString(), peer: PEER, capability: CAP.uri, task: uuid(), gate: 'start' as const, by: 'grant' as const };
      for (let i = 0; i < 2 * AUDIT_KEPT + 5; i++) h.appendAudit([{ ...e, task: String(i) }]);
      const lines = h.readAudit();
      expect(lines.length).toBeLessThanOrEqual(2 * AUDIT_KEPT);
      expect(lines.at(-1)?.task).toBe(String(2 * AUDIT_KEPT + 4));
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it('survives a restart: tasks.json is read back as written, and an unreadable one fails closed', async () => {
    const h = new Home(mkdtempSync(join(tmpdir(), 'rdv-taskrestart-')));
    try {
      const id = uuid();
      await tasksInbound(h, registry, fakeAgent(contact), [inbox(taskRequest(CAP.uri, 'later', id))], false);
      const again = new Home(h.dir); // another process
      const t = again.readTasks().engine.tasks[id];
      expect(t.text).toEqual(['later']);
      await approveStart(again, fakeAgent(contact), registry, id, startDigest(t)!);
      expect(new Home(h.dir).readTasks().engine.tasks[id].state).toBe('working');
      writeFileSync(h.tasksPath, JSON.stringify({ v: 2, engine: {} }));
      expect(() => h.readTasks()).toThrow(/unrecognized/);
      const empty: TaskEngineState = new Home(join(h.dir, 'none')).readTasks().engine;
      expect(empty.tasks).toEqual({});
    } finally {
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe('task commands', () => {
  it('need the code the human reviewed, and refuse bad usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rdv-task-cmd-'));
    const home = join(dir, 'h');
    try {
      await rdv(['init', '--email', 'omer@example.com', '--relay', 'ws://127.0.0.1:9'], home);
      const run = (args: string[]) => rdv(args, home, { check: false });
      const id = uuid();
      expect((await run(['task', 'approve', id])).code).toBe(2); // no --code
      expect((await run(['task', 'release', id])).code).toBe(2);
      const none = await run(['task', 'approve', id, '--code', 'abcdef012345']);
      expect([none.code, none.stderr]).toEqual([1, expect.stringContaining(`no task ${id}`)]);
      expect((await run(['task', 'submit', id])).code).toBe(2); // no --text
      for (const bad of ['[1]', '"x"', 'not json']) expect((await run(['task', 'submit', id, '--data', bad])).code, bad).toBe(2); // --data takes a JSON object
      expect((await run(['task', 'submit', id, '--data', '{"rdv":"request/data","data":{}}'])).stderr).toContain(`no task ${id}`);
      const peer = generateKey().id;
      const noContact = await run(['task', 'request', peer, '--text', 'hi']);
      expect([noContact.code, noContact.stderr]).toEqual([1, expect.stringContaining('no active contact')]);
      expect((await run(['task', 'list'])).lines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
