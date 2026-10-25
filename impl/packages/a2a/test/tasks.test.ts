// tasks/v1 (SPEC §7.6, issue #22): lifecycle, approval classes, bounds, dedup,
// tombstones, expiry with an injected `now`, unsupported capabilities, and
// compatibility with the meeting engine and older peers.
import { describe, expect, it } from 'vitest';
import {
  artifactExtensions,
  AWAITING_KEY,
  askInput,
  type Capability,
  CapabilityRegistry,
  cancelTask,
  emptyState,
  emptyTaskState,
  EXTENSIONS,
  expireTasks,
  FILES_URI,
  finishTask,
  inputTask,
  type MeetingScope,
  MAX_OPEN_DEFAULT,
  outboundLimit,
  parseRate,
  REASON_KEY,
  receive,
  receiveTask,
  rejectTask,
  requestTask,
  routeA2A,
  s,
  sendArtifact,
  startTask,
  TASK_BOUNDS,
  TASK_LIMITS,
  type TaskCtx,
  type TaskEngineState,
  type TaskPayload,
  type TaskStep,
  TASKS_URI,
  TaskError,
  UNSUPPORTED_KEY,
  waitingForHuman,
} from '../src/index.js';

const OMER = 'rdv1:omer';
const JOHN = 'rdv1:john';
const DANA = 'rdv1:dana';
const NOW = new Date('2026-10-25T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const BASE = 'https://rendezvous.nesher.co/ext/';
const REVIEW = `${BASE}review/v1`; // free-form (A.9's example, not normative)
const FREEBUSY = `${BASE}test-freebusy/v1`; // auto
const PING = `${BASE}test-ping/v1`; // notify
const BOOK = `${BASE}test-book/v1`; // confirm
const UNKNOWN = `${BASE}test-unknown/v1`;

const review: Capability = {
  uri: REVIEW,
  approval: 'free-form',
  input: s.object({ focus: s.list(s.string(40), 8, 1) }, { due: s.instant() }),
  answer: s.object({ section: s.int(1, 99) }),
  data: {
    'review/result': s.object({ rdv: s.oneOf(['review/result']), verdict: s.oneOf(['ok', 'changes-requested']), comments: s.int(0, 1000) }),
    'review/question': s.object({ rdv: s.oneOf(['review/question']), sections: s.list(s.int(1, 99), 8) }),
  },
};
const registry = () =>
  new CapabilityRegistry([
    review,
    { uri: FREEBUSY, approval: 'auto', input: s.object({ day: s.instant() }), data: { 'freebusy/result': s.object({ rdv: s.oneOf(['freebusy/result']), busy: s.bool() }) } },
    { uri: PING, approval: 'notify' },
    { uri: BOOK, approval: 'confirm', input: s.object({ what: s.string(80) }) },
  ]);

const INVOKE = { [REVIEW]: {}, [FREEBUSY]: {}, [PING]: {}, [BOOK]: {} };

function ids(prefix: number) {
  let n = 0;
  return () => `00000000-0000-4000-8${prefix.toString(16).padStart(3, '0')}-${String(++n).padStart(12, '0')}`;
}
const U = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

/** One agent's task state and context. */
class Agent {
  state: TaskEngineState = emptyTaskState();
  readonly newId: () => string;
  now = NOW;
  constructor(
    readonly id: string,
    n: number,
    public invoke: Record<string, unknown> = INVOKE,
    public tier = 'friend',
    readonly reg = registry(),
  ) {
    this.newId = ids(n);
  }
  ctx(over: Partial<TaskCtx> = {}): TaskCtx {
    return { now: this.now, newId: this.newId, registry: this.reg, invoke: this.invoke, tier: this.tier, ...over };
  }
  apply<T extends TaskStep>(step: T): T {
    this.state = step.state;
    return step;
  }
  recv(from: string, payload: unknown, over: Partial<TaskCtx> = {}): TaskStep {
    return this.apply(receiveTask(this.state, from, payload, this.ctx(over)));
  }
}

/** John (requester) asks Omer (executor). */
function pair() {
  return { john: new Agent(JOHN, 1), omer: new Agent(OMER, 2) };
}

const only = (step: TaskStep): TaskPayload => {
  expect(step.outgoing).toHaveLength(1);
  return step.outgoing[0].payload;
};
const kinds = (step: TaskStep) => step.events.map((e) => e.kind);
const statusOf = (p: TaskPayload) => (p.type === 'a2a/task-update' ? p.update : undefined);

/** A raw task/request message from `taskId`, for hostile and boundary input. */
function rawRequest(taskId: string, data: Record<string, unknown>, opts: { messageId?: string; contextId?: string; parts?: unknown[] } = {}) {
  return {
    type: 'a2a/message',
    message: {
      kind: 'message',
      messageId: opts.messageId ?? U(Number.parseInt(taskId.slice(-6), 10) + 500_000),
      taskId,
      contextId: opts.contextId ?? U(999_999),
      role: 'agent',
      parts: opts.parts ?? [{ kind: 'data', data }],
      extensions: [TASKS_URI],
    },
  };
}
const freebusy = (taskId: string, extra: Record<string, unknown> = {}) =>
  rawRequest(taskId, { rdv: 'task/request', capability: FREEBUSY, input: { day: '2026-10-26T00:00:00Z' }, ...extra });
const reviewReq = (taskId: string, extra: Record<string, unknown> = {}) => rawRequest(taskId, { rdv: 'task/request', capability: REVIEW, input: { focus: ['clarity'] }, ...extra });

describe('tasks/v1 lifecycle (free-form, both gates)', () => {
  it('request → start gate → working → input-required ⇄ working → artifact → completed', () => {
    const { john, omer } = pair();
    const req = john.apply(
      requestTask(john.state, OMER, REVIEW, john.ctx(), {
        input: { focus: ['clarity', 'numbers'], due: '2026-10-28T17:00:00Z' },
        text: ['Could Omer look over the Q4 plan before Wednesday?'],
        peerCapabilities: ['rdv/v1', 'a2a/0.3', TASKS_URI, REVIEW],
      }),
    );
    expect(kinds(req)).toEqual(['requested']);
    const sent = only(req);
    expect(sent.type).toBe('a2a/message');
    if (sent.type === 'a2a/message') expect(sent.message.extensions).toEqual([TASKS_URI, REVIEW]);
    expect(john.state.tasks[req.taskId]).toMatchObject({ role: 'requester', state: 'submitted', capability: REVIEW });

    // Omer's agent: stored `submitted`, the start gate is open, nothing is acted on.
    const got = omer.recv(JOHN, sent);
    expect(kinds(got)).toEqual(['received', 'start-needed']);
    expect(got.events[0].peerText).toEqual(['Could Omer look over the Q4 plan before Wednesday?']);
    expect(got.effects).toEqual([{ kind: 'start-gate', taskId: req.taskId, peer: JOHN, capability: REVIEW, approval: 'free-form', step: 'request' }]);
    const ack = statusOf(only(got))!;
    expect(ack.status.state).toBe('submitted');
    expect(ack.metadata?.[AWAITING_KEY]).toBe('human');
    expect(waitingForHuman(omer.state).map((t) => t.id)).toEqual([req.taskId]);

    // John sees the same state (a repeat: nothing new).
    expect(john.recv(OMER, only(got)).events).toEqual([]);

    // Omer approves: working, and the work starts with the validated input.
    const started = omer.apply(startTask(omer.state, req.taskId, omer.ctx()));
    expect(started.effects).toEqual([{ kind: 'start', taskId: req.taskId, peer: JOHN, capability: REVIEW, step: 'request', input: { focus: ['clarity', 'numbers'], due: '2026-10-28T17:00:00Z' } }]);
    expect(kinds(john.recv(OMER, only(started)))).toEqual(['status']);
    expect(john.state.tasks[req.taskId].state).toBe('working');

    // A question with text is release-gated: without `released` nothing leaves.
    const draft = omer.apply(askInput(omer.state, req.taskId, omer.ctx(), { text: 'Which section first?', data: { rdv: 'review/question', sections: [2, 3] } }));
    expect(draft.outgoing).toEqual([]);
    expect(draft.effects.map((e) => e.kind)).toEqual(['release-gate']);
    expect(omer.state.tasks[req.taskId].state).toBe('working');
    const asked = omer.apply(askInput(omer.state, req.taskId, omer.ctx(), { text: 'Which section first?', data: { rdv: 'review/question', sections: [2, 3] } }, { released: true }));
    const q = john.recv(OMER, only(asked));
    expect(q.events[0]).toMatchObject({ kind: 'input-required', peerText: ['Which section first?'], data: [{ rdv: 'review/question', sections: [2, 3] }] });

    // John answers; under free-form the answer re-opens the start gate (step input).
    const ans = john.apply(inputTask(john.state, req.taskId, john.ctx(), { input: { section: 3 } }));
    const got2 = omer.recv(JOHN, only(ans));
    expect(kinds(got2)).toEqual(['input', 'start-needed']);
    expect(got2.effects[0]).toMatchObject({ kind: 'start-gate', step: 'input' });
    expect(statusOf(only(got2))!.metadata?.[AWAITING_KEY]).toBe('human');
    const resumed = omer.apply(startTask(omer.state, req.taskId, omer.ctx()));
    expect(resumed.effects[0]).toMatchObject({ kind: 'start', step: 'input', input: { section: 3 } });
    john.recv(OMER, only(resumed));

    // The artifact is release-gated too, then validated by John against the capability.
    const parts = [
      { kind: 'text' as const, text: "Section 3's totals don't add up." },
      { kind: 'data' as const, data: { rdv: 'review/result', verdict: 'changes-requested', comments: 3 } },
    ];
    const gated = omer.apply(sendArtifact(omer.state, req.taskId, omer.ctx(), { name: 'review', parts, lastChunk: true }));
    expect(gated.outgoing).toEqual([]);
    expect(omer.state.tasks[req.taskId].chunks).toBe(0);
    const art = omer.apply(sendArtifact(omer.state, req.taskId, omer.ctx(), { artifactId: gated.artifactId, name: 'review', parts, lastChunk: true }, { released: true }));
    // What leaves is exactly the draft the release gate showed.
    expect(gated.effects).toEqual([{ kind: 'release-gate', taskId: req.taskId, peer: JOHN, capability: REVIEW, payload: only(art) }]);
    const seen = john.recv(OMER, only(art));
    expect(seen.events[0]).toMatchObject({ kind: 'artifact', lastChunk: true, peerText: ["Section 3's totals don't add up."], data: [{ verdict: 'changes-requested', comments: 3 }] });

    // Completed without a message: no gate needed.
    const done = omer.apply(finishTask(omer.state, req.taskId, omer.ctx(), 'completed'));
    expect(kinds(john.recv(OMER, only(done)))).toEqual(['completed']);
    expect(john.state.tasks[req.taskId].state).toBe('completed');
    // Peer text and input are gone from state once the task ends.
    const t = omer.state.tasks[req.taskId];
    expect(t.state).toBe('completed');
    expect(t.text).toBeUndefined();
    expect(t.input).toBeUndefined();
    expect(t.answer).toBeUndefined();
  });

  it('confirm: the human declines at the start gate → rejected (human)', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, BOOK, john.ctx(), { input: { what: 'a table for two' } }));
    const got = omer.recv(JOHN, only(req));
    expect(got.effects[0]).toMatchObject({ kind: 'start-gate', approval: 'confirm' });
    const no = omer.apply(rejectTask(omer.state, req.taskId, omer.ctx()));
    expect(no.effects).toEqual([{ kind: 'abort', taskId: req.taskId, peer: JOHN, capability: BOOK, code: 'human' }]);
    expect(statusOf(only(no))!.metadata?.[REASON_KEY]).toBe('human');
    const back = john.recv(OMER, only(no));
    expect(back.events[0]).toMatchObject({ kind: 'rejected', code: 'human' });
    expect(() => startTask(omer.state, req.taskId, omer.ctx())).toThrow(TaskError);
  });

  it('auto: the grant is the approval, the work starts at once', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const got = omer.recv(JOHN, only(req));
    expect(got.effects).toEqual([{ kind: 'start', taskId: req.taskId, peer: JOHN, capability: FREEBUSY, step: 'request', input: { day: '2026-10-26T00:00:00Z' } }]);
    expect(statusOf(only(got))!.status.state).toBe('working');
    expect(waitingForHuman(omer.state)).toEqual([]);
    // Artifacts of an auto capability need no release gate, unless they carry owner data.
    const parts = [{ kind: 'data' as const, data: { rdv: 'freebusy/result', busy: false } }];
    expect(omer.apply(sendArtifact(omer.state, req.taskId, omer.ctx(), { parts }, { ownerData: true })).effects[0].kind).toBe('release-gate');
    const art = omer.apply(sendArtifact(omer.state, req.taskId, omer.ctx(), { parts, lastChunk: true }));
    john.recv(OMER, only(got));
    expect(kinds(john.recv(OMER, only(art)))).toEqual(['artifact']);
  });

  it('notify: shown to the human, completed, nothing else', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, PING, john.ctx(), { text: ['Landed.'] }));
    const got = omer.recv(JOHN, only(req));
    expect(got.effects).toEqual([{ kind: 'notify', taskId: req.taskId, peer: JOHN, capability: PING }]);
    expect(statusOf(only(got))).toMatchObject({ status: { state: 'completed' }, final: true });
    expect(kinds(john.recv(OMER, only(got)))).toEqual(['completed']);
  });

  it('failed: a started task that cannot finish; its reason text is release-gated', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    john.recv(OMER, only(omer.recv(JOHN, only(req))));
    expect(() => rejectTask(omer.state, req.taskId, omer.ctx())).toThrow(/has started/);
    const f = omer.apply(finishTask(omer.state, req.taskId, omer.ctx(), 'failed', { text: 'calendar unavailable' }));
    expect(statusOf(only(f))!.metadata?.[REASON_KEY]).toBe('error');
    expect(john.recv(OMER, only(f)).events[0]).toMatchObject({ kind: 'failed', code: 'error', peerText: ['calendar unavailable'] });
    // Under free-form the same message would wait for the release gate.
    const { john: j2, omer: o2 } = pair();
    const r2 = j2.apply(requestTask(j2.state, OMER, REVIEW, j2.ctx(), { input: { focus: ['x'] } }));
    o2.recv(JOHN, only(r2));
    o2.apply(startTask(o2.state, r2.taskId, o2.ctx()));
    expect(o2.apply(finishTask(o2.state, r2.taskId, o2.ctx(), 'failed', { text: 'no' })).outgoing).toEqual([]);
    expect(o2.state.tasks[r2.taskId].state).toBe('working');
  });

  it('requester follows only forward transitions; anything after the end is ignored', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const working = omer.recv(JOHN, only(req));
    john.recv(OMER, only(working));
    const update = (state: string, final: boolean) => ({
      type: 'a2a/task-update',
      update: { kind: 'status-update', taskId: req.taskId, contextId: (only(req) as { message: { contextId: string } }).message.contextId, status: { state }, final },
    });
    expect(john.recv(OMER, update('submitted', false)).events[0]).toMatchObject({ kind: 'ignored', reason: 'peer reports submitted after working' });
    expect(kinds(john.recv(OMER, update('input-required', false)))).toEqual(['input-required']);
    expect(kinds(john.recv(OMER, update('working', false)))).toEqual(['status']);
    expect(kinds(john.recv(OMER, update('canceled', true)))).toEqual(['canceled']);
    expect(john.recv(OMER, update('completed', true)).events[0]).toMatchObject({ kind: 'ignored' });
    expect(john.state.tasks[req.taskId].state).toBe('canceled');
    // `final` must agree with the state.
    expect(john.recv(OMER, update('working', true)).events[0]).toMatchObject({ kind: 'invalid' });
    // Another peer's update for John's task is ignored.
    expect(john.recv(DANA, update('completed', true)).events[0]).toMatchObject({ kind: 'ignored' });
  });
});

describe('cancel, tombstones, dedup and finished tasks (SPEC §7.3 rules)', () => {
  it('a cancel while working ends the task on both sides and aborts the work', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    omer.recv(JOHN, only(req));
    const c = john.apply(cancelTask(john.state, req.taskId, john.ctx(), 'plans changed'));
    expect(john.state.tasks[req.taskId].state).toBe('canceled');
    const got = omer.recv(JOHN, only(c));
    expect(got.effects).toEqual([{ kind: 'abort', taskId: req.taskId, peer: JOHN, capability: FREEBUSY }]);
    expect(omer.state.tasks[req.taskId]).toMatchObject({ state: 'canceled', reason: 'canceled by peer' }); // peer text is not stored as our reason
    expect(statusOf(only(got))!.status.state).toBe('canceled');
    expect(() => cancelTask(john.state, req.taskId, john.ctx())).toThrow(/already canceled/);
  });

  it('a cancel that overtakes its request leaves a tombstone, and the request is refused when it lands', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } }));
    const c = john.apply(cancelTask(john.state, req.taskId, john.ctx()));
    const first = omer.recv(JOHN, only(c));
    expect(kinds(first)).toEqual(['canceled']);
    expect(omer.state.tasks[req.taskId]).toMatchObject({ state: 'canceled', tombstone: true, capability: '' });
    const late = omer.recv(JOHN, only(req));
    expect(kinds(late)).toEqual(['ignored']);
    expect(statusOf(only(late))!.status.state).toBe('canceled');
    expect(late.effects).toEqual([]);
    expect(waitingForHuman(omer.state)).toEqual([]);
  });

  it('a tombstone needs a task-capable grant', () => {
    const { john } = pair();
    const omer = new Agent(OMER, 2, {});
    const req = john.apply(requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } }));
    const c = john.apply(cancelTask(john.state, req.taskId, john.ctx()));
    const got = omer.recv(JOHN, only(c));
    expect(got.events[0]).toMatchObject({ kind: 'invalid', reason: 'the grant allows no tasks (invoke)' });
    expect(got.outgoing).toEqual([]);
    expect(omer.state.tasks).toEqual({});
  });

  it('a duplicate messageId is ignored; a verb for a finished task gets its real state, at most 8 times', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    omer.recv(JOHN, only(req));
    const dup = omer.recv(JOHN, only(req));
    expect(kinds(dup)).toEqual(['duplicate']);
    expect(dup.outgoing).toEqual([]);
    omer.apply(finishTask(omer.state, req.taskId, omer.ctx(), 'completed'));
    const msg = only(req) as { message: Record<string, unknown> };
    let replies = 0;
    for (let i = 0; i < 20; i++) {
      const again = { type: 'a2a/message', message: { ...msg.message, messageId: U(7000 + i) } };
      const step = omer.recv(JOHN, again);
      expect(step.events[0]).toMatchObject({ kind: 'ignored', state: 'completed' });
      replies += step.outgoing.length;
      if (step.outgoing.length) expect(statusOf(step.outgoing[0].payload)!.status.state).toBe('completed');
    }
    expect(replies).toBe(TASK_BOUNDS.finishedReplies);
    expect(omer.state.tasks[req.taskId].seen.length).toBeLessThanOrEqual(TASK_BOUNDS.seenPerTask);
    // task/input and rdv/cancel for the finished task are answered the same way (already at the cap: silent).
    const cancel = { type: 'a2a/message', message: { ...msg.message, messageId: U(8000), parts: [{ kind: 'data', data: { rdv: 'rdv/cancel' } }] } };
    expect(omer.recv(JOHN, cancel).events[0]).toMatchObject({ kind: 'ignored', reason: 'cancel after completed' });
  });

  it('seen messageIds stay at 64 per task under replays', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, PING, john.ctx()));
    omer.recv(JOHN, only(req)); // notify: completed at once
    const msg = only(req) as { message: Record<string, unknown> };
    for (let i = 0; i < 100; i++) omer.recv(JOHN, { type: 'a2a/message', message: { ...msg.message, messageId: U(10_000 + i) } });
    expect(omer.state.tasks[req.taskId].seen).toHaveLength(TASK_BOUNDS.seenPerTask);
  });

  it('roles and owners are kept apart', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    // Omer sends a task/request reusing John's own task ID back to John: not an executor task of John's.
    expect(john.recv(OMER, freebusy(sent.message.taskId, {}), { invoke: INVOKE }).events[0]).toMatchObject({ kind: 'invalid' });
    omer.recv(JOHN, only(req));
    // Dana cannot touch John's task on Omer's side.
    const danaCancel = rawRequest(sent.message.taskId, { rdv: 'rdv/cancel' }, { contextId: sent.message.contextId, messageId: U(1) });
    expect(omer.recv(DANA, danaCancel).events[0]).toMatchObject({ kind: 'invalid', reason: 'task belongs to another peer' });
    // A status update from the requester for a task Omer executes is ignored.
    const upd = { type: 'a2a/task-update', update: { kind: 'status-update', taskId: sent.message.taskId, contextId: sent.message.contextId, status: { state: 'completed' }, final: true } };
    expect(omer.recv(JOHN, upd).events[0]).toMatchObject({ kind: 'ignored' });
    expect(omer.state.tasks[sent.message.taskId].state).toBe('working');
    // And a contextId mismatch is refused.
    expect(omer.recv(JOHN, rawRequest(sent.message.taskId, { rdv: 'rdv/cancel' }, { contextId: U(5), messageId: U(2) })).events[0]).toMatchObject({ reason: 'contextId does not match the task' });
  });
});

describe('scope, unsupported capabilities and malformed input', () => {
  it('an unknown capability is answered unsupported and keeps no state; the requester learns it', () => {
    const john = new Agent(JOHN, 1, { ...INVOKE, [UNKNOWN]: {} }, 'friend', new CapabilityRegistry([...[review], { uri: UNKNOWN, approval: 'auto' }]));
    const omer = new Agent(OMER, 2, { ...INVOKE, [UNKNOWN]: {} });
    const req = john.apply(requestTask(john.state, OMER, UNKNOWN, john.ctx()));
    const got = omer.recv(JOHN, only(req));
    expect(got.events[0]).toMatchObject({ kind: 'refused', code: 'unsupported' });
    expect(omer.state.tasks).toEqual({});
    expect(omer.state.dropped.unsupported).toBe(1);
    const reply = statusOf(only(got))!;
    expect(reply.status.state).toBe('rejected');
    expect(reply.metadata?.[UNSUPPORTED_KEY]).toEqual({ messageId: (only(req) as { message: { messageId: string } }).message.messageId, verb: 'task/request', capability: UNKNOWN });
    const back = john.recv(OMER, only(got));
    expect(kinds(back)).toEqual(['unsupported', 'rejected']);
    expect(back.events[0].reason).toBe("the peer's agent does not support this capability");
    expect(john.state.tasks[req.taskId]).toMatchObject({ state: 'rejected', code: 'unsupported' });
  });

  it('deny by default: a capability missing from invoke is rejected (scope); no invoke at all is dropped silently', () => {
    const omer = new Agent(OMER, 2, { [FREEBUSY]: {} });
    const got = omer.recv(JOHN, reviewReq(U(1)));
    expect(got.events[0]).toMatchObject({ kind: 'refused', code: 'scope' });
    expect(statusOf(only(got))!.metadata?.[REASON_KEY]).toBe('scope');
    expect(omer.state.tasks).toEqual({});
    for (const invoke of [null, undefined, {}, { [REVIEW]: true }, { [REVIEW]: [1] }]) {
      const none = new Agent(OMER, 3);
      none.invoke = invoke as Record<string, unknown>;
      const step = none.recv(JOHN, reviewReq(U(2)));
      expect(step.events[0]).toMatchObject({ kind: 'invalid', reason: 'the grant allows no tasks (invoke)' });
      expect(step.outgoing).toEqual([]);
      expect(none.state.tasks).toEqual({});
    }
    // The requester refuses to send what the peer's grant or card does not allow.
    const john = new Agent(JOHN, 1, { [FREEBUSY]: {} });
    expect(() => requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } })).toThrow(/grant does not let us invoke/);
    const j2 = new Agent(JOHN, 1);
    expect(() => requestTask(j2.state, OMER, REVIEW, j2.ctx(), { input: { focus: ['x'] }, peerCapabilities: ['rdv/v1', 'a2a/0.3', EXTENSIONS.meeting] })).toThrow(/does not advertise .*tasks\/v1/);
    expect(() => requestTask(j2.state, OMER, REVIEW, j2.ctx(), { input: { focus: ['x'] }, peerCapabilities: ['rdv/v1', TASKS_URI] })).toThrow(/does not advertise .*review/);
  });

  it('malformed input is rejected (input) with no state kept', () => {
    const omer = new Agent(OMER, 2);
    const hostile: unknown[] = [
      'not an object',
      [1, 2],
      { focus: 'clarity' },
      { focus: [] },
      { focus: ['x'.repeat(41)] },
      { focus: Array.from({ length: 9 }, () => 'x') },
      { focus: ['x'], extra: true },
      { focus: ['x'], due: 'tomorrow' },
      { focus: [7] },
      JSON.parse('{"focus":["x"],"__proto__":{"polluted":true}}'),
      null,
    ];
    hostile.forEach((input, i) => {
      const step = omer.recv(JOHN, reviewReq(U(100 + i), { input }));
      expect(step.events[0], JSON.stringify(input)).toMatchObject({ kind: 'refused', code: 'input' });
      expect(statusOf(only(step))!.status.state).toBe('rejected');
    });
    expect(omer.state.tasks).toEqual({});
    expect(omer.state.dropped.input).toBe(hostile.length);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Input for a capability that takes none.
    expect(omer.recv(JOHN, rawRequest(U(200), { rdv: 'task/request', capability: PING, input: { a: 1 } })).events[0]).toMatchObject({ kind: 'refused', code: 'input' });
    // Our own input is checked before anything is sent.
    const john = new Agent(JOHN, 1);
    expect(() => requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: 'x' } })).toThrow(TaskError);
  });

  it('a malformed task/input changes nothing; out of turn too', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    omer.recv(JOHN, only(req));
    const input = (n: number, data: Record<string, unknown>) => rawRequest(sent.message.taskId, { rdv: 'task/input', ...data }, { contextId: sent.message.contextId, messageId: U(n) });
    expect(omer.recv(JOHN, input(1, { input: { day: '2026-10-27T00:00:00Z' } })).events[0]).toMatchObject({ kind: 'invalid', reason: 'task/input while working' });
    omer.apply(askInput(omer.state, sent.message.taskId, omer.ctx(), { text: 'Which day?' }));
    expect(omer.recv(JOHN, input(2, { input: { day: 'soon' } })).events[0]).toMatchObject({ kind: 'invalid' });
    expect(omer.state.tasks[sent.message.taskId]).toMatchObject({ state: 'input-required', inputs: 0 });
    expect(kinds(omer.recv(JOHN, input(3, { input: { day: '2026-10-27T00:00:00Z' } })))).toEqual(['input']);
  });
});

describe('bounds (SPEC §7.4, A.7): at the limit and one past it', () => {
  it(`max_open per capability: ${MAX_OPEN_DEFAULT} by default, or the grant's`, () => {
    const omer = new Agent(OMER, 2);
    for (let i = 0; i < MAX_OPEN_DEFAULT; i++) expect(kinds(omer.recv(JOHN, freebusy(U(i))))).toEqual(['received']);
    const over = omer.recv(JOHN, freebusy(U(50)));
    expect(over.events[0]).toMatchObject({ kind: 'refused', code: 'rate' });
    expect(statusOf(only(over))!.metadata?.[REASON_KEY]).toBe('rate');
    expect(Object.keys(omer.state.tasks)).toHaveLength(MAX_OPEN_DEFAULT);
    expect(omer.state.dropped.rate).toBe(1);
    // Other capabilities and other peers are not affected.
    expect(kinds(omer.recv(JOHN, reviewReq(U(51))))).toEqual(['received', 'start-needed']);
    expect(kinds(omer.recv(DANA, freebusy(U(52))))).toEqual(['received']);
    // A finished task frees its place.
    omer.apply(finishTask(omer.state, U(0), omer.ctx(), 'completed'));
    expect(kinds(omer.recv(JOHN, freebusy(U(53))))).toEqual(['received']);

    const strict = new Agent(OMER, 3, { [FREEBUSY]: { max_open: 2 } });
    strict.recv(JOHN, freebusy(U(60)));
    strict.recv(JOHN, freebusy(U(61)));
    expect(strict.recv(JOHN, freebusy(U(62))).events[0]).toMatchObject({ code: 'rate' });
  });

  it(`${TASK_BOUNDS.tasksPerPeer} tasks per peer, finished ones and tombstones evicted first`, () => {
    const omer = new Agent(OMER, 2, { [FREEBUSY]: { max_open: 1000 } });
    for (let i = 0; i < TASK_BOUNDS.tasksPerPeer; i++) expect(kinds(omer.recv(JOHN, freebusy(U(i))))).toEqual(['received']);
    expect(omer.recv(JOHN, freebusy(U(100))).events[0]).toMatchObject({ kind: 'refused', code: 'rate' });
    expect(Object.keys(omer.state.tasks)).toHaveLength(TASK_BOUNDS.tasksPerPeer);
    // A tombstone also needs room.
    expect(omer.recv(JOHN, rawRequest(U(101), { rdv: 'rdv/cancel' })).events[0]).toMatchObject({ kind: 'invalid' });
    // Finish two: the next request evicts the oldest finished one.
    omer.now = later(1000);
    omer.apply(finishTask(omer.state, U(5), omer.ctx(), 'completed'));
    omer.now = later(2000);
    omer.apply(finishTask(omer.state, U(3), omer.ctx(), 'completed'));
    omer.now = later(3000);
    expect(kinds(omer.recv(JOHN, freebusy(U(102))))).toEqual(['received']);
    expect(omer.state.tasks[U(5)]).toBeUndefined();
    expect(omer.state.tasks[U(3)]).toBeDefined();
    // Dana still has her own 32.
    expect(kinds(omer.recv(DANA, freebusy(U(103))))).toEqual(['received']);
  });

  it(`waiting for the human: ${TASK_BOUNDS.waitingPerPeer} per peer, the oldest dropped (busy), the newcomer kept`, () => {
    const omer = new Agent(OMER, 2, { [REVIEW]: { max_open: 100 } });
    for (let i = 0; i < TASK_BOUNDS.waitingPerPeer; i++) {
      omer.now = later(i * 1000);
      expect(kinds(omer.recv(JOHN, reviewReq(U(i))))).toEqual(['received', 'start-needed']);
    }
    expect(waitingForHuman(omer.state)).toHaveLength(TASK_BOUNDS.waitingPerPeer);
    omer.now = later(10_000);
    const over = omer.recv(JOHN, reviewReq(U(50)));
    expect(kinds(over)).toEqual(['received', 'start-needed', 'evicted']);
    expect(over.events[2]).toMatchObject({ taskId: U(0), code: 'busy' });
    expect(over.effects.at(-1)).toEqual({ kind: 'abort', taskId: U(0), peer: JOHN, capability: REVIEW, code: 'busy' });
    expect(over.outgoing.map((o) => statusOf(o.payload)!.status.state)).toEqual(['submitted', 'rejected']);
    expect(omer.state.tasks[U(0)]).toMatchObject({ state: 'rejected', code: 'busy' });
    expect(waitingForHuman(omer.state).map((t) => t.id)).toEqual([U(1), U(2), U(3), U(50)]);
    expect(omer.state.dropped.busy).toBe(1);
    // A task the human approved no longer waits, and makes room.
    omer.apply(startTask(omer.state, U(1), omer.ctx()));
    expect(kinds(omer.recv(JOHN, reviewReq(U(51))))).toEqual(['received', 'start-needed']);
  });

  it(`waiting for the human: ${TASK_BOUNDS.waitingTotal} in all, lowest tier first, then the oldest, the newcomer included`, () => {
    const omer = new Agent(OMER, 2, { [REVIEW]: { max_open: 100 } });
    const peers = Array.from({ length: TASK_BOUNDS.waitingTotal / TASK_BOUNDS.waitingPerPeer }, (_, i) => `rdv1:peer${i}`);
    let n = 0;
    for (const [p, peer] of peers.entries()) {
      for (let i = 0; i < TASK_BOUNDS.waitingPerPeer; i++) {
        omer.now = later(++n * 1000);
        omer.recv(peer, reviewReq(U(n)), { tier: p === 3 ? 'stranger' : 'friend' });
      }
    }
    expect(waitingForHuman(omer.state)).toHaveLength(TASK_BOUNDS.waitingTotal);
    // A stranger newcomer: the oldest of the strangers goes first.
    omer.now = later(++n * 1000);
    const a = omer.recv('rdv1:late', reviewReq(U(n)), { tier: 'stranger' });
    expect(a.events.find((e) => e.kind === 'evicted')).toMatchObject({ peer: peers[3], taskId: U(13) });
    // An unknown-tier newcomer is weaker than everyone: it is the one rejected.
    omer.now = later(++n * 1000);
    const b = omer.recv('rdv1:later', reviewReq(U(n)), { tier: undefined });
    expect(b.events.find((e) => e.kind === 'evicted')).toMatchObject({ taskId: U(n) });
    expect(omer.state.tasks[U(n)].state).toBe('rejected');
    // A family newcomer pushes out the remaining strangers first, then the oldest friend.
    for (let i = 0; i < 4; i++) {
      omer.now = later(++n * 1000);
      omer.recv('rdv1:family', reviewReq(U(n)), { tier: 'family' });
    }
    const evictedStrangers = Object.values(omer.state.tasks).filter((t) => t.code === 'busy' && t.tier === 'stranger');
    expect(evictedStrangers).toHaveLength(5); // peer3's four and the first late stranger
    expect(omer.state.tasks[U(1)].state).toBe('submitted');
    omer.now = later(++n * 1000);
    omer.recv('rdv1:family2', reviewReq(U(n)), { tier: 'family' });
    expect(omer.state.tasks[U(1)]).toMatchObject({ state: 'rejected', code: 'busy', tier: 'friend' });
    expect(waitingForHuman(omer.state)).toHaveLength(TASK_BOUNDS.waitingTotal);
  });

  it(`task/input: at most ${TASK_BOUNDS.inputsPerTask} per task`, () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    john.recv(OMER, only(omer.recv(JOHN, only(req))));
    for (let i = 0; i < TASK_BOUNDS.inputsPerTask; i++) {
      john.recv(OMER, only(omer.apply(askInput(omer.state, req.taskId, omer.ctx(), { text: `question ${i}` }))));
      const ans = john.apply(inputTask(john.state, req.taskId, john.ctx(), { input: { day: '2026-10-27T00:00:00Z' } }));
      expect(kinds(omer.recv(JOHN, only(ans)))).toEqual(['input']);
    }
    expect(omer.state.tasks[req.taskId].inputs).toBe(TASK_BOUNDS.inputsPerTask);
    expect(() => askInput(omer.state, req.taskId, omer.ctx(), { text: 'one more?' })).toThrow(/at most 8/);
    // A peer that answers a 9th time anyway (state forced to input-required) is refused.
    const forced = structuredClone(omer.state);
    forced.tasks[req.taskId].state = 'input-required';
    omer.state = forced;
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    const ninth = rawRequest(sent.message.taskId, { rdv: 'task/input', input: { day: '2026-10-27T00:00:00Z' } }, { contextId: sent.message.contextId, messageId: U(9) });
    expect(omer.recv(JOHN, ninth).events[0]).toMatchObject({ kind: 'invalid', reason: 'more than 8 task/input' });
    const jForced = structuredClone(john.state);
    jForced.tasks[req.taskId].state = 'input-required';
    expect(() => inputTask(jForced, req.taskId, john.ctx(), { input: { day: '2026-10-27T00:00:00Z' } })).toThrow(/at most 8/);
  });

  it(`status updates: ${TASK_BOUNDS.updatesPerTask} processed per task`, () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    omer.recv(JOHN, only(req));
    const upd = (state: string) => ({ type: 'a2a/task-update', update: { kind: 'status-update', taskId: sent.message.taskId, contextId: sent.message.contextId, status: { state }, final: false } });
    for (let i = 0; i < TASK_BOUNDS.updatesPerTask; i++) john.recv(OMER, upd(i % 2 ? 'working' : 'input-required'));
    expect(john.state.tasks[sent.message.taskId].updates).toBe(TASK_BOUNDS.updatesPerTask);
    const over = john.recv(OMER, upd('working'));
    expect(over.events[0]).toMatchObject({ kind: 'ignored', reason: 'more than 64 status updates' });
    expect(john.state.tasks[sent.message.taskId].state).toBe('working');
  });

  it(`artifacts: ${TASK_BOUNDS.artifactsPerTask} per task and ${TASK_BOUNDS.chunksPerTask} chunks`, () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    omer.recv(JOHN, only(req));
    const art = (artifactId: string, append = false, lastChunk = false) => ({
      type: 'a2a/artifact-update',
      update: { kind: 'artifact-update', taskId: sent.message.taskId, contextId: sent.message.contextId, append, lastChunk, artifact: { artifactId, parts: [{ kind: 'text', text: 'chunk' }] } },
    });
    for (let i = 0; i < TASK_BOUNDS.artifactsPerTask; i++) expect(kinds(john.recv(OMER, art(U(i))))).toEqual(['artifact']);
    expect(john.recv(OMER, art(U(100))).events[0]).toMatchObject({ kind: 'ignored', reason: 'more than 8 artifacts' });
    for (let i = TASK_BOUNDS.artifactsPerTask; i < TASK_BOUNDS.chunksPerTask; i++) expect(kinds(john.recv(OMER, art(U(0), true)))).toEqual(['artifact']);
    expect(john.state.tasks[sent.message.taskId].chunks).toBe(TASK_BOUNDS.chunksPerTask);
    expect(john.recv(OMER, art(U(1), true)).events[0]).toMatchObject({ kind: 'ignored', reason: 'more than 64 artifact chunks' });
    // The executor side refuses to send past the same limits.
    for (let i = 0; i < TASK_BOUNDS.artifactsPerTask; i++) omer.apply(sendArtifact(omer.state, sent.message.taskId, omer.ctx(), { parts: [{ kind: 'text', text: 'x' }] }));
    expect(() => sendArtifact(omer.state, sent.message.taskId, omer.ctx(), { parts: [{ kind: 'text', text: 'x' }] })).toThrow(/at most 8 artifacts/);
  });

  it('a chunk after the last chunk is ignored; a new artifact after the task ended too', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    john.recv(OMER, only(omer.recv(JOHN, only(req))));
    const a = omer.apply(sendArtifact(omer.state, req.taskId, omer.ctx(), { parts: [{ kind: 'text', text: 'all' }], lastChunk: true }));
    john.recv(OMER, only(a));
    expect(() => sendArtifact(omer.state, req.taskId, omer.ctx(), { artifactId: a.artifactId, parts: [{ kind: 'text', text: 'more' }], append: true })).toThrow(/already complete/);
    const p = only(a) as { update: Record<string, unknown> };
    expect(john.recv(OMER, { type: 'a2a/artifact-update', update: { ...p.update, append: true } }).events[0]).toMatchObject({ reason: 'chunk after the last chunk' });
    john.recv(OMER, only(omer.apply(finishTask(omer.state, req.taskId, omer.ctx(), 'completed'))));
    expect(john.recv(OMER, only(a)).events[0]).toMatchObject({ kind: 'ignored', reason: 'artifact after completed' });
  });

  it(`unsupported replies: at most ${TASK_BOUNDS.unsupportedReplies} per task`, () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    omer.recv(JOHN, only(req));
    let replies = 0;
    for (let i = 0; i < 20; i++) {
      const step = omer.recv(JOHN, rawRequest(sent.message.taskId, { rdv: 'task/claim' }, { contextId: sent.message.contextId, messageId: U(300 + i) }));
      replies += step.outgoing.length;
      if (step.outgoing.length) expect(statusOf(step.outgoing[0].payload)).toMatchObject({ status: { state: 'working' }, metadata: { [UNSUPPORTED_KEY]: { verb: 'task/claim' } } });
    }
    expect(replies).toBe(TASK_BOUNDS.unsupportedReplies);
  });

  it('expires: defaults to 48 h, is clamped to 7 days, and expiry ends open tasks on both sides', () => {
    const omer = new Agent(OMER, 2, { [REVIEW]: { max_open: 10 }, [FREEBUSY]: {} });
    omer.recv(JOHN, reviewReq(U(1)));
    omer.recv(JOHN, reviewReq(U(2), { expires: '2027-06-01T00:00:00Z' }));
    omer.recv(JOHN, freebusy(U(3), { expires: later(HOUR).toISOString() }));
    expect(omer.state.tasks[U(1)].expires).toBe(later(TASK_BOUNDS.expiresDefaultMs).toISOString());
    expect(omer.state.tasks[U(2)].expires).toBe(later(TASK_BOUNDS.expiresMaxMs).toISOString());
    // A request already past its expiry is rejected at once.
    const stale = omer.recv(JOHN, freebusy(U(4), { expires: '2026-10-01T00:00:00Z' }));
    expect(kinds(stale)).toEqual(['received', 'expired']);
    expect(omer.state.tasks[U(4)]).toMatchObject({ state: 'rejected', code: 'expired' });

    // Exactly at `expires` nothing happens; one millisecond past, the working task fails.
    expect(expireTasks(omer.state, { now: later(HOUR) }).events).toEqual([]);
    const e1 = omer.apply(expireTasks(omer.state, { now: later(HOUR + 1) }));
    expect(e1.events).toMatchObject([{ kind: 'expired', taskId: U(3), state: 'failed' }]);
    expect(statusOf(only(e1))!.metadata?.[REASON_KEY]).toBe('expired');
    // The task still waiting for the human is rejected (it never started).
    const e2 = omer.apply(expireTasks(omer.state, { now: later(TASK_BOUNDS.expiresDefaultMs + 1) }));
    expect(e2.events).toMatchObject([{ kind: 'expired', taskId: U(1), state: 'rejected' }]);
    expect(e2.effects).toEqual([{ kind: 'abort', taskId: U(1), peer: JOHN, capability: REVIEW, code: 'expired' }]);
    expect(() => startTask(omer.state, U(1), omer.ctx())).toThrow(TaskError);

    // Requester: our own expiry withdraws the task with rdv/cancel.
    const john = new Agent(JOHN, 1);
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' }, expires: later(HOUR).toISOString() }));
    const ex = john.apply(expireTasks(john.state, { now: later(HOUR + 1), newId: john.newId }));
    expect(john.state.tasks[req.taskId]).toMatchObject({ state: 'canceled', code: 'expired' });
    const out = only(ex);
    expect(out.type === 'a2a/message' && out.message.parts[0]).toMatchObject({ kind: 'data', data: { rdv: 'rdv/cancel', reason: 'expired' } });
    expect(() => requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' }, expires: later(8 * DAY).toISOString() })).toThrow(/at most 7 days/);
    expect(() => requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' }, expires: '2026-10-01T00:00:00Z' })).toThrow(/future/);
  });

  it(`finished tasks are pruned after ${TASK_BOUNDS.keepFinishedMs / DAY} days`, () => {
    const omer = new Agent(OMER, 2);
    omer.recv(JOHN, rawRequest(U(1), { rdv: 'task/request', capability: PING }));
    expect(omer.state.tasks[U(1)].state).toBe('completed');
    omer.apply(expireTasks(omer.state, { now: later(TASK_BOUNDS.keepFinishedMs) }));
    expect(omer.state.tasks[U(1)]).toBeDefined();
    omer.apply(expireTasks(omer.state, { now: later(TASK_BOUNDS.keepFinishedMs + 1) }));
    expect(omer.state.tasks[U(1)]).toBeUndefined();
  });

  it(`text parts: ${TASK_LIMITS.textChars} characters, and at most ${TASK_LIMITS.parts} parts`, () => {
    const omer = new Agent(OMER, 2);
    const parts = (text: string) => [{ kind: 'data', data: { rdv: 'task/request', capability: PING } }, { kind: 'text', text }];
    expect(kinds(omer.recv(JOHN, rawRequest(U(1), {}, { parts: parts('x'.repeat(TASK_LIMITS.textChars)) })))).toEqual(['received']);
    const over = omer.recv(JOHN, rawRequest(U(2), {}, { parts: parts('x'.repeat(TASK_LIMITS.textChars + 1)) }));
    expect(over.events[0]).toMatchObject({ kind: 'invalid' });
    expect(over.outgoing).toEqual([]);
    const john = new Agent(JOHN, 1);
    expect(() => requestTask(john.state, OMER, PING, john.ctx(), { text: ['x'.repeat(TASK_LIMITS.textChars + 1)] })).toThrow(TaskError);
    expect(() => requestTask(john.state, OMER, PING, john.ctx(), { text: Array.from({ length: TASK_LIMITS.parts }, () => 'x') })).toThrow(/at most 8 parts/);
    expect(requestTask(john.state, OMER, PING, john.ctx(), { text: Array.from({ length: TASK_LIMITS.parts - 1 }, () => 'x') }).outgoing).toHaveLength(1);
  });

  it('input state is never mutated', () => {
    const { john, omer } = pair();
    const before = structuredClone(omer.state);
    const req = john.apply(requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } }));
    receiveTask(omer.state, JOHN, only(req), omer.ctx());
    expect(omer.state).toEqual(before);
  });
});

describe('artifact-update validation', () => {
  function working() {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    john.recv(OMER, only(omer.recv(JOHN, only(req))));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    const art = (parts: unknown[], over: Record<string, unknown> = {}) => ({
      type: 'a2a/artifact-update',
      update: { kind: 'artifact-update', taskId: sent.message.taskId, contextId: sent.message.contextId, artifact: { artifactId: U(1), parts }, ...over },
    });
    return { john, omer, art, taskId: sent.message.taskId };
  }

  it('data parts are checked against the capability; file parts are opaque and never fetched', () => {
    const { john, art } = working();
    expect(kinds(john.recv(OMER, art([{ kind: 'data', data: { rdv: 'freebusy/result', busy: true } }])))).toEqual(['artifact']);
    for (const data of [{ rdv: 'review/result', verdict: 'ok', comments: 1 }, { rdv: 'freebusy/result', busy: 'yes' }, { rdv: 'freebusy/result', busy: true, owner: 'x' }, { busy: true }]) {
      const step = john.recv(OMER, art([{ kind: 'data', data }]));
      expect(step.events[0], JSON.stringify(data)).toMatchObject({ kind: 'invalid' });
      expect(step.outgoing).toEqual([]);
    }
    const file = { kind: 'file', file: { uri: 'https://files.example.com/q4/3f9a', mimeType: 'application/pdf', name: 'q4-plan.pdf' }, metadata: { [`${BASE}files/v1`]: { sha256: 'ab', size: 2 } } };
    const step = john.recv(OMER, art([{ kind: 'text', text: 'see file' }, file]));
    expect(step.events[0]).toMatchObject({ kind: 'artifact', files: [file] });
    expect(step.effects).toEqual([]);
    expect(john.recv(OMER, art([{ kind: 'file', file: { bytes: 'AAAA', uri: 'https://x.example/' } }])).events[0]).toMatchObject({ kind: 'invalid' });
    expect(john.recv(OMER, art([{ kind: 'video', video: {} }])).events[0]).toMatchObject({ kind: 'invalid' });
    expect(john.recv(OMER, art([{ kind: 'text', text: 'x' }], { extra: 1 })).events[0]).toMatchObject({ kind: 'invalid' });
  });

  it('a file offered only by direct transfer (no uri, files metadata) is carried; a bare file part is not (SPEC §7.7)', () => {
    const { john, omer, art, taskId } = working();
    const p2p = { kind: 'file', file: { name: 'big.iso' }, metadata: { [FILES_URI]: { sha256: 'ab', size: 2, p2p: ['webrtc-datachannel/1'] } } };
    expect(john.recv(OMER, art([p2p])).events[0]).toMatchObject({ kind: 'artifact', files: [p2p] });
    for (const bad of [{ kind: 'file', file: { name: 'x' } }, { kind: 'file', file: { name: 'x' }, metadata: { other: {} } }, { kind: 'file', file: {}, metadata: { [FILES_URI]: 'x' } }]) {
      expect(john.recv(OMER, art([bad])).events[0], JSON.stringify(bad)).toMatchObject({ kind: 'invalid' });
    }
    // Our own: an artifact with a file part lists the files extension, one without does not.
    const withFile = sendArtifact(omer.state, taskId, omer.ctx(), { parts: [p2p as never] }, { released: true });
    expect((withFile.outgoing[0].payload as { update: { artifact: { extensions: string[] } } }).update.artifact.extensions).toEqual([FREEBUSY, FILES_URI]);
    expect(artifactExtensions(REVIEW, [{ kind: 'text', text: 'x' }])).toEqual([REVIEW]);
  });

  it('a task/request with file parts lists the files extension in `extensions`', () => {
    const file = { kind: 'file' as const, file: { uri: 'https://files.example.com/a', name: 'a.txt' }, metadata: { [FILES_URI]: { sha256: 'ab', size: 2 } } };
    const r = requestTask(emptyTaskState(), JOHN, REVIEW, { now: NOW, registry: registry(), invoke: INVOKE, newId: ids(9) }, { input: { focus: ['x'] }, files: [file] });
    expect((r.outgoing[0].payload as { message: { extensions: string[] } }).message.extensions).toEqual([TASKS_URI, REVIEW, FILES_URI]);
    const plain = requestTask(emptyTaskState(), JOHN, REVIEW, { now: NOW, registry: registry(), invoke: INVOKE, newId: ids(10) }, { input: { focus: ['x'] } });
    expect((plain.outgoing[0].payload as { message: { extensions: string[] } }).message.extensions).toEqual([TASKS_URI, REVIEW]);
  });

  it('only the executor sends artifacts: from anyone else, or to the executor, they are ignored', () => {
    const { john, omer, art, taskId } = working();
    expect(john.recv(DANA, art([{ kind: 'text', text: 'x' }])).events[0]).toMatchObject({ kind: 'ignored' });
    expect(omer.recv(JOHN, art([{ kind: 'text', text: 'x' }])).events[0]).toMatchObject({ kind: 'ignored' });
    expect(omer.state.tasks[taskId].chunks).toBe(0);
    // Our own artifacts are checked too.
    expect(() => sendArtifact(omer.state, taskId, omer.ctx(), { parts: [{ kind: 'data', data: { rdv: 'nope' } }] })).toThrow(TaskError);
  });
});

describe('compatibility with meetings and older peers (C.3)', () => {
  const scope: MeetingScope = { may_initiate: true, may_propose_meetings: true };
  const mctx = { now: NOW, busy: [], busyRange: { start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z' }, window: [], offsetMinutes: 120, scope, newId: ids(7) };

  it('a rev-3 peer (meetings only) answers a task as unsupported; our requester learns it', () => {
    const john = new Agent(JOHN, 1);
    const req = john.apply(requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } }));
    // Omer runs only the meeting engine.
    const old = receive(emptyState(), JOHN, only(req), mctx);
    expect(old.events[0]).toMatchObject({ kind: 'invalid', reason: 'unknown verb "task/request"' });
    expect(old.state.tasks).toEqual({});
    expect(old.outgoing).toHaveLength(1);
    expect(routeA2A(old.outgoing[0].payload, john.state)).toBe('tasks');
    const back = john.recv(OMER, old.outgoing[0].payload);
    expect(kinds(back)).toEqual(['unsupported', 'rejected']);
    expect(back.events[0].reason).toBe("the peer's agent does not support task/request");
    expect(john.state.tasks[req.taskId].state).toBe('rejected');
  });

  it('the meeting engine ignores an artifact update and a status update with a message', () => {
    const art = { type: 'a2a/artifact-update', update: { kind: 'artifact-update', taskId: U(1), contextId: U(2), artifact: { artifactId: U(3), parts: [{ kind: 'text', text: 'x' }] } } };
    const step = receive(emptyState(), JOHN, art, mctx);
    expect(step.events[0]).toMatchObject({ kind: 'invalid' });
    expect(step.outgoing).toEqual([]);
  });

  it('routeA2A sends each payload to its engine', () => {
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const msg = only(req) as { message: { taskId: string; contextId: string } };
    expect(routeA2A(only(req), omer.state)).toBe('tasks');
    const working = omer.recv(JOHN, only(req));
    expect(routeA2A(only(working), john.state)).toBe('tasks');
    expect(routeA2A(only(working), emptyTaskState())).toBe('meetings');
    const propose = { type: 'a2a/message', message: { kind: 'message', messageId: U(1), taskId: U(2), contextId: U(3), role: 'agent', parts: [{ kind: 'data', data: { rdv: 'meeting/propose', slots: [] } }], extensions: [EXTENSIONS.meeting] } };
    expect(routeA2A(propose, omer.state)).toBe('meetings');
    const cancelOf = (taskId: string, extensions: string[]) => ({ type: 'a2a/message', message: { ...propose.message, taskId, parts: [{ kind: 'data', data: { rdv: 'rdv/cancel' } }], extensions } });
    expect(routeA2A(cancelOf(msg.message.taskId, [EXTENSIONS.meeting]), omer.state)).toBe('tasks'); // the task decides
    expect(routeA2A(cancelOf(U(9), [TASKS_URI, FREEBUSY]), omer.state)).toBe('tasks');
    expect(routeA2A(cancelOf(U(9), [EXTENSIONS.meeting]), omer.state)).toBe('meetings');
    expect(routeA2A(cancelOf(U(9), []), omer.state)).toBe('meetings');
    expect(routeA2A({ type: 'a2a/artifact-update', update: {} }, omer.state)).toBe('tasks');
    expect(routeA2A({ type: 'note', text: 'hi' }, omer.state)).toBeNull();
    expect(routeA2A('junk', omer.state)).toBeNull();
    expect(routeA2A({ type: 'a2a/message', message: 'junk' }, omer.state)).toBe('meetings');
  });

  it('the tasks engine answers meeting verbs as unsupported, within a task-capable grant only', () => {
    const omer = new Agent(OMER, 2);
    const propose = rawRequest(U(1), { rdv: 'meeting/propose', slots: [] });
    const step = omer.recv(JOHN, propose);
    expect(step.events[0]).toMatchObject({ kind: 'invalid' });
    expect(statusOf(only(step))!.metadata?.[UNSUPPORTED_KEY]).toEqual({ messageId: (propose.message as { messageId: string }).messageId, verb: 'meeting/propose' });
    expect(new Agent(OMER, 3, {}).recv(JOHN, propose).outgoing).toEqual([]);
  });
});

describe('security review fixes (issue #22)', () => {
  it('absent input is validated when a capability has a schema (no bypass by leaving it out)', () => {
    const omer = new Agent(OMER, 2);
    // REVIEW requires `focus`: a request with no input at all is refused, not stored.
    const step = omer.recv(JOHN, rawRequest(U(1), { rdv: 'task/request', capability: REVIEW }));
    expect(step.events[0]).toMatchObject({ kind: 'refused', code: 'input', reason: `input: ${REVIEW} requires input` });
    expect(omer.state.tasks).toEqual({});
    // The same for a task/input answer with no input.
    const { john, omer: o2 } = pair();
    const req = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    const sent = only(req) as { message: { taskId: string; contextId: string } };
    o2.recv(JOHN, only(req));
    o2.apply(askInput(o2.state, req.taskId, o2.ctx(), { text: 'Which day?' }));
    const bare = rawRequest(sent.message.taskId, { rdv: 'task/input' }, { contextId: sent.message.contextId, messageId: U(2) });
    expect(o2.recv(JOHN, bare).events[0]).toMatchObject({ kind: 'invalid' });
    expect(o2.state.tasks[req.taskId].state).toBe('input-required');
    expect(() => requestTask(john.state, OMER, REVIEW, john.ctx())).toThrow(/requires input/);
    // A capability that declares its input optional accepts a request without one, and still checks one that is there.
    const opt = `${BASE}test-optional/v1`;
    const reg = new CapabilityRegistry([{ uri: opt, approval: 'auto', inputOptional: true, input: s.object({ n: s.int(1, 9) }) }]);
    const o3 = new Agent(OMER, 3, { [opt]: {} }, 'friend', reg);
    expect(kinds(o3.recv(JOHN, rawRequest(U(3), { rdv: 'task/request', capability: opt })))).toEqual(['received']);
    expect(o3.recv(JOHN, rawRequest(U(4), { rdv: 'task/request', capability: opt, input: { n: 99 } })).events[0]).toMatchObject({ code: 'input' });
    expect(() => new CapabilityRegistry([{ uri: opt, approval: 'auto', inputOptional: 'yes' as unknown as boolean }])).toThrow(/inputOptional/);
  });

  it('a grant narrowed after receipt stops the task: nothing is started or sent, the task ends with scope', () => {
    // Waiting at the start gate, then the owner removes REVIEW from the grant.
    const { john, omer } = pair();
    const req = john.apply(requestTask(john.state, OMER, REVIEW, john.ctx(), { input: { focus: ['x'] } }));
    omer.recv(JOHN, only(req));
    omer.invoke = { [FREEBUSY]: {} };
    const s1 = omer.apply(startTask(omer.state, req.taskId, omer.ctx()));
    expect(s1.effects).toEqual([{ kind: 'abort', taskId: req.taskId, peer: JOHN, capability: REVIEW, code: 'scope' }]);
    expect(omer.state.tasks[req.taskId]).toMatchObject({ state: 'rejected', code: 'scope' });
    const st = statusOf(only(s1))!;
    expect(st.status.state).toBe('rejected');
    expect(st.metadata?.[REASON_KEY]).toBe('scope');
    expect(john.recv(OMER, only(s1)).events[0]).toMatchObject({ kind: 'rejected', code: 'scope' });

    // Already working (auto), then the grant is revoked: askInput, sendArtifact and finishTask send nothing of their own.
    const mk = () => {
      const p = pair();
      const r = p.john.apply(requestTask(p.john.state, OMER, FREEBUSY, p.john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
      p.omer.recv(JOHN, only(r));
      p.omer.invoke = {};
      return { ...p, taskId: r.taskId };
    };
    const calls: [string, (o: Agent, id: string) => TaskStep][] = [
      ['askInput', (o, id) => askInput(o.state, id, o.ctx(), { text: 'Which day?' }, { released: true })],
      ['sendArtifact', (o, id) => sendArtifact(o.state, id, o.ctx(), { parts: [{ kind: 'data', data: { rdv: 'freebusy/result', busy: true } }] }, { released: true })],
      ['finishTask', (o, id) => finishTask(o.state, id, o.ctx(), 'completed')],
    ];
    for (const [what, call] of calls) {
      const { omer: o, taskId } = mk();
      const step = o.apply(call(o, taskId));
      expect(step.outgoing.map((x) => x.payload.type), what).toEqual(['a2a/task-update']);
      expect(statusOf(step.outgoing[0].payload), what).toMatchObject({ status: { state: 'failed' }, metadata: { [REASON_KEY]: 'scope' } });
      expect(step.effects, what).toEqual([{ kind: 'abort', taskId, peer: JOHN, capability: FREEBUSY, code: 'scope' }]);
      expect(o.state.tasks[taskId], what).toMatchObject({ state: 'failed', code: 'scope' });
    }
    // A capability no longer registered is treated the same.
    const { omer: o4, taskId } = mk();
    o4.invoke = INVOKE;
    const narrowed = startOrFinish(o4, taskId);
    expect(narrowed.effects[0]).toMatchObject({ kind: 'abort', code: 'scope' });
  });
});

/** finishTask with a registry that no longer knows FREEBUSY. */
function startOrFinish(o: Agent, taskId: string): TaskStep {
  return finishTask(o.state, taskId, o.ctx({ registry: new CapabilityRegistry([review]) }), 'completed');
}

describe('capability registry', () => {
  it('rejects bad definitions', () => {
    expect(() => new CapabilityRegistry([{ uri: 'http://insecure.example/x', approval: 'auto' }])).toThrow(/https/);
    expect(() => new CapabilityRegistry([{ uri: `https://e.example/${'a'.repeat(200)}`, approval: 'auto' }])).toThrow(/200/);
    expect(() => new CapabilityRegistry([{ uri: REVIEW, approval: 'whatever' as 'auto' }])).toThrow(/approval class/);
    expect(() => new CapabilityRegistry([review, review])).toThrow(/already registered/);
    expect(() => new CapabilityRegistry([{ uri: PING, approval: 'notify', maxOpen: 0 }])).toThrow(/maxOpen/);
    expect(registry().uris()).toEqual([REVIEW, FREEBUSY, PING, BOOK]);
  });
});

describe('per-capability limits (issue #28): the limiter hook and the outbound check', () => {
  /** A limiter that records its calls and refuses from the `refuseFrom`-th call on. */
  function limiter(refuseFrom = Infinity, code: 'rate' | 'scope' = 'rate') {
    const calls: Array<{ capability: string; open: number; maxOpen: number }> = [];
    const limit: TaskCtx['limit'] = (capability, o) => {
      calls.push({ capability, ...o });
      return calls.length >= refuseFrom ? { ok: false, code, reason: 'over the limit' } : { ok: true };
    };
    return { calls, limit };
  }

  it('is asked once per new task that passed every other check, with open and max_open; a refusal keeps no state', () => {
    const omer = new Agent(OMER, 2, { [FREEBUSY]: { max_open: 3 }, [REVIEW]: {} });
    const { calls, limit } = limiter(3);
    expect(kinds(omer.recv(JOHN, freebusy(U(1)), { limit }))).toEqual(['received']);
    expect(kinds(omer.recv(JOHN, freebusy(U(2)), { limit }))).toEqual(['received']);
    expect(calls).toEqual([
      { capability: FREEBUSY, open: 0, maxOpen: 3 },
      { capability: FREEBUSY, open: 1, maxOpen: 3 },
    ]);
    const before = structuredClone(omer.state);
    const over = omer.recv(JOHN, freebusy(U(3)), { limit });
    expect(over.events).toEqual([expect.objectContaining({ kind: 'refused', taskId: U(3), code: 'rate', capability: FREEBUSY, reason: 'over the limit' })]);
    expect(statusOf(only(over))).toMatchObject({ taskId: U(3), status: { state: 'rejected' }, metadata: { [REASON_KEY]: 'rate' } });
    expect(over.effects).toEqual([]); // nobody is prompted
    expect(omer.state.tasks).toEqual(before.tasks);
    expect(omer.state.dropped).toEqual({ ...before.dropped, rate: 1 });
  });

  it('is never asked for an unsupported capability, a grant that does not allow it, bad input, a full peer or a duplicate', () => {
    const omer = new Agent(OMER, 2, { [FREEBUSY]: { max_open: 1000 } });
    const { calls, limit } = limiter();
    omer.recv(JOHN, rawRequest(U(1), { rdv: 'task/request', capability: UNKNOWN }), { limit });
    omer.recv(JOHN, reviewReq(U(2)), { limit }); // not in this grant's invoke
    omer.recv(JOHN, rawRequest(U(3), { rdv: 'task/request', capability: FREEBUSY, input: { day: 'soon' } }), { limit });
    expect(calls).toEqual([]);
    for (let i = 0; i < TASK_BOUNDS.tasksPerPeer; i++) omer.recv(JOHN, freebusy(U(100 + i)), { limit });
    expect(calls).toHaveLength(TASK_BOUNDS.tasksPerPeer);
    expect(omer.recv(JOHN, freebusy(U(200)), { limit }).events[0]).toMatchObject({ kind: 'refused', code: 'rate' }); // per-peer bound
    expect(kinds(omer.recv(JOHN, freebusy(U(100)), { limit }))).toEqual(['duplicate']); // a relay replay
    const again = rawRequest(U(100), { rdv: 'task/request', capability: FREEBUSY, input: { day: '2026-10-26T00:00:00Z' } }, { messageId: U(777) });
    expect(kinds(omer.recv(JOHN, again, { limit }))).toEqual(['invalid']); // a second request for an open task
    expect(calls).toHaveLength(TASK_BOUNDS.tasksPerPeer);
  });

  it('owns max_open when present (the engine passes its figure), and a scope answer refuses with scope', () => {
    const omer = new Agent(OMER, 2, { [FREEBUSY]: {} });
    const lenient: TaskCtx['limit'] = () => ({ ok: true });
    for (let i = 0; i < MAX_OPEN_DEFAULT + 2; i++) expect(kinds(omer.recv(JOHN, freebusy(U(i)), { limit: lenient }))).toEqual(['received']);
    const { limit } = limiter(1, 'scope');
    expect(omer.recv(JOHN, freebusy(U(50)), { limit }).events[0]).toMatchObject({ kind: 'refused', code: 'scope' });
  });

  it('meetings never reach the task limiter', () => {
    const omer = new Agent(OMER, 2);
    const { calls, limit } = limiter();
    const meeting = { type: 'a2a/message', message: { kind: 'message', messageId: U(7), taskId: U(8), contextId: U(9), role: 'agent', parts: [{ kind: 'data', data: { rdv: 'meeting/propose' } }], extensions: [EXTENSIONS.meetings] } };
    omer.recv(JOHN, meeting, { limit });
    expect(calls).toEqual([]);
  });

  it("outboundLimit / requestTask: max_frequency in the peer's grant, at the limit, one past it, at the window boundary", () => {
    const john = new Agent(JOHN, 1, { [PING]: { max_frequency: '2/day' } });
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).toBeNull();
    john.apply(requestTask(john.state, OMER, PING, john.ctx()));
    john.now = later(HOUR);
    john.apply(requestTask(john.state, OMER, PING, john.ctx()));
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).toMatch(/2\/day/);
    expect(() => requestTask(john.state, OMER, PING, john.ctx())).toThrow(TaskError);
    // Another peer's grant is its own.
    expect(outboundLimit(john.state, DANA, PING, john.ctx())).toBeNull();
    // It survives a restart (the engine state is what the host saves).
    john.state = JSON.parse(JSON.stringify(john.state));
    john.now = later(DAY - 1);
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).not.toBeNull();
    john.now = later(DAY);
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).toBeNull();
    john.apply(requestTask(john.state, OMER, PING, john.ctx()));
    expect(john.state.sent![OMER][PING]).toHaveLength(2); // bounded by the count
  });

  it("outboundLimit: max_open in the peer's grant, and no grant means no", () => {
    const john = new Agent(JOHN, 1, { [FREEBUSY]: { max_open: 1 } });
    expect(outboundLimit(john.state, OMER, REVIEW, john.ctx())).toMatch(/does not let us invoke/);
    const step = john.apply(requestTask(john.state, OMER, FREEBUSY, john.ctx(), { input: { day: '2026-10-26T00:00:00Z' } }));
    expect(outboundLimit(john.state, OMER, FREEBUSY, john.ctx())).toMatch(/max_open 1/);
    john.apply(cancelTask(john.state, step.taskId, john.ctx()));
    expect(outboundLimit(john.state, OMER, FREEBUSY, john.ctx())).toBeNull();
    expect(john.state.sent).toBeUndefined(); // nothing to remember without a max_frequency
  });

  it('outboundLimit: an unreadable clock refuses; future or mangled send times count, for one window', () => {
    const john = new Agent(JOHN, 1, { [PING]: { max_frequency: '1/day' } });
    expect(outboundLimit(john.state, OMER, PING, john.ctx({ now: new Date(NaN) }))).toMatch(/clock/);
    john.state = { ...john.state, sent: { [OMER]: { [PING]: [NOW.getTime() + 365 * DAY] } } };
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).not.toBeNull();
    john.state = { ...john.state, sent: { [OMER]: { [PING]: [null as unknown as number] } } };
    expect(outboundLimit(john.state, OMER, PING, john.ctx())).not.toBeNull();
  });

  it('parseRate reads max_frequency like core', () => {
    expect(parseRate('5/day')).toEqual({ count: 5, windowMs: DAY });
    expect(parseRate('2/minute')).toEqual({ count: 2, windowMs: 60_000 });
    for (const bad of ['5/week', '5 / day', '-1/day', 5, undefined, '']) expect(parseRate(bad)).toBeNull();
  });
});
