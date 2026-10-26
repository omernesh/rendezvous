// Tasks in a group (SPEC §7.8.4, issue #79): the board projection and who may
// say what, departures, messages that arrive before their task, the join
// scope's limits, and that pairwise parsing never takes the group verbs.
import { describe, expect, it } from 'vitest';
import {
  admitGroupInvoke,
  type BoardCtx,
  type BoardState,
  type BoardStep,
  boardDeparted,
  boardKey,
  boardReceive,
  boardRequest,
  boardSweep,
  boardVerb,
  emptyBoard,
  forBoard,
  GROUP_REQUESTER_KEY,
  parseGroupTaskPayload,
  parseTaskPayload,
  REQUEST_URI,
  type TaskPayload,
} from '../src/index.js';

const id = (c: string) => `rdv1:${c.repeat(52)}`;
const OMER = id('a');
const JOHN = id('b');
const DANA = id('c');
const EVE = id('d');
const GROUP = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-26T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ctx = (me: string, over: Partial<BoardCtx> = {}): BoardCtx => ({ now: NOW, me, members: [OMER, JOHN, DANA], admins: [OMER], ...over });

/** Feed items in order to one member's board. */
function feed(me: string, items: Array<{ from: string; body: unknown }>, board: BoardState = emptyBoard(GROUP), c: Partial<BoardCtx> = {}): BoardStep & { all: BoardStep[] } {
  const all: BoardStep[] = [];
  let b = board;
  for (const it of items) {
    const step = boardReceive(b, { ...it, board: true }, ctx(me, c));
    all.push(step);
    b = step.board;
  }
  return { board: b, events: all.flatMap((s) => s.events), effects: all.flatMap((s) => s.effects), all };
}

const request = (from: string, opts: { assignee?: string; text?: string } = {}) => boardRequest(GROUP, { capability: REQUEST_URI, text: [opts.text ?? 'Draft the landing-page copy'], ...(opts.assignee ? { assignee: opts.assignee } : {}) }, { now: NOW, me: from, newId });
const status = (taskId: string, requester: string, state: string, text?: string): TaskPayload =>
  forBoard(
    {
      type: 'a2a/task-update',
      update: {
        kind: 'status-update',
        taskId,
        contextId: GROUP,
        status: { state: state as 'working', ...(text ? { message: { kind: 'message', messageId: newId(), role: 'agent', parts: [{ kind: 'text', text }] } } : {}) },
        final: ['completed', 'failed', 'rejected', 'canceled'].includes(state),
      },
    },
    requester,
  );
const artifact = (taskId: string, requester: string, text: string): TaskPayload =>
  forBoard({ type: 'a2a/artifact-update', update: { kind: 'artifact-update', taskId, contextId: GROUP, artifact: { artifactId: newId(), name: 'copy', parts: [{ kind: 'text', text }] }, lastChunk: true } }, requester);

describe('parsing', () => {
  it('pairwise parsing never takes the group verbs or an assignee', () => {
    const claim = boardVerb(GROUP, newId(), { rdv: 'task/claim', requester: OMER }, { newId });
    expect(parseTaskPayload(claim)).toMatchObject({ ok: false });
    expect(parseGroupTaskPayload(claim)).toMatchObject({ ok: true });
    const r = request(OMER, { assignee: DANA });
    expect(parseTaskPayload(r.payload)).toMatchObject({ ok: false, reason: expect.stringContaining('assignee') });
    expect(parseGroupTaskPayload(r.payload)).toMatchObject({ ok: true, value: { data: { rdv: 'task/request', assignee: DANA } } });
  });

  it('refuses malformed group verbs', () => {
    const bad = boardVerb(GROUP, newId(), { rdv: 'task/claim', requester: OMER }, { newId }) as { message: { parts: Array<{ data?: Record<string, unknown> }> } };
    bad.message.parts[0].data!.requester = 'rdv1:nope';
    expect(parseGroupTaskPayload(bad).ok).toBe(false);
    bad.message.parts[0].data!.requester = OMER;
    bad.message.parts[0].data!.extra = 1;
    expect(parseGroupTaskPayload(bad).ok).toBe(false);
  });
});

describe('the board (design B.5 steps 4 to 7)', () => {
  it('open task, claim, assign: the assignee executes the request without the assignee field', () => {
    const r = request(OMER);
    const claim = boardVerb(GROUP, r.taskId, { rdv: 'task/claim', requester: OMER }, { text: 'I can do it today', newId });
    const assign = boardVerb(GROUP, r.taskId, { rdv: 'task/assign', requester: OMER, assignee: DANA }, { newId });
    const dana = feed(DANA, [
      { from: OMER, body: r.payload },
      { from: DANA, body: claim },
      { from: OMER, body: assign },
    ]);
    expect(dana.events.map((e) => e.kind)).toEqual(['posted', 'claimed', 'assigned']);
    expect(dana.events[1].peerText).toEqual(['I can do it today']);
    const t = dana.board.tasks[boardKey(OMER, r.taskId)];
    expect(t).toMatchObject({ assignee: DANA, claims: [DANA], state: 'submitted', title: 'Draft the landing-page copy' });
    expect(dana.effects).toHaveLength(1);
    const ex = dana.effects[0];
    expect(ex).toMatchObject({ kind: 'execute', requester: OMER, taskId: r.taskId });
    const parsed = parseTaskPayload((ex as { request: TaskPayload }).request);
    expect(parsed).toMatchObject({ ok: true, value: { data: { rdv: 'task/request', capability: REQUEST_URI } } });
    // John sees the same board, and nothing is his to do.
    const john = feed(JOHN, [
      { from: OMER, body: r.payload },
      { from: DANA, body: claim },
      { from: OMER, body: assign },
    ]);
    expect(john.effects).toEqual([]);
    expect(john.board.tasks).toEqual(dana.board.tasks);
  });

  it('a task for one member executes on arrival', () => {
    const r = request(OMER, { assignee: JOHN });
    const john = feed(JOHN, [{ from: OMER, body: r.payload }]);
    expect(john.effects).toMatchObject([{ kind: 'execute', requester: OMER, taskId: r.taskId }]);
    expect(feed(DANA, [{ from: OMER, body: r.payload }]).effects).toEqual([]);
    // The requester cannot be its own assignee, nor can a non-member.
    for (const who of [OMER, EVE]) {
      const bad = boardRequest(GROUP, { capability: REQUEST_URI, text: ['x'], assignee: who === OMER ? DANA : who }, { now: NOW, me: OMER, newId });
      const step = feed(JOHN, [{ from: who === OMER ? DANA : OMER, body: bad.payload }]);
      expect(step.events.map((e) => e.kind)).toEqual(['ignored']);
    }
  });

  it('only the requester assigns; an admin only once the requester left', () => {
    const r = request(JOHN);
    const byDana = boardVerb(GROUP, r.taskId, { rdv: 'task/assign', requester: JOHN, assignee: DANA }, { newId });
    const byOmer = boardVerb(GROUP, r.taskId, { rdv: 'task/assign', requester: JOHN, assignee: DANA }, { newId });
    const s = feed(DANA, [
      { from: JOHN, body: r.payload },
      { from: DANA, body: byDana },
      { from: OMER, body: byOmer },
    ]);
    expect(s.events.map((e) => e.kind)).toEqual(['posted', 'ignored', 'ignored']);
    expect(s.effects).toEqual([]);
    // John left; his task was not assigned, so it is canceled locally; one already assigned can be reassigned by the admin.
    const assigned = request(JOHN, { assignee: DANA });
    let b = feed(OMER, [
      { from: JOHN, body: r.payload },
      { from: JOHN, body: assigned.payload },
    ]).board;
    const gone = boardDeparted(b, JOHN, ctx(OMER, { members: [OMER, DANA] }));
    expect(gone.events.map((e) => [e.kind, e.task])).toEqual([['canceled', r.taskId]]);
    b = gone.board;
    const release = boardVerb(GROUP, assigned.taskId, { rdv: 'task/release', requester: JOHN }, { newId });
    const reassign = boardVerb(GROUP, assigned.taskId, { rdv: 'task/assign', requester: JOHN, assignee: DANA }, { newId });
    const after = feed(OMER, [
      { from: DANA, body: release },
      { from: OMER, body: reassign },
    ], b, { members: [OMER, DANA] });
    expect(after.events.map((e) => e.kind)).toEqual(['released', 'assigned']);
  });

  it('only the assignee reports, forward only, and it names the requester', () => {
    const r = request(OMER, { assignee: DANA });
    const s = feed(JOHN, [
      { from: OMER, body: r.payload },
      { from: JOHN, body: status(r.taskId, OMER, 'completed') }, // not the assignee
      { from: DANA, body: { ...status(r.taskId, OMER, 'working'), update: { ...(status(r.taskId, OMER, 'working') as { update: object }).update, metadata: {} } } }, // no requester
      { from: DANA, body: status(r.taskId, DANA, 'working') }, // names another requester: another task, which we do not hold
      { from: DANA, body: status(r.taskId, OMER, 'working') },
      { from: DANA, body: artifact(r.taskId, OMER, 'Launch faster with Rendezvous.') },
      { from: DANA, body: status(r.taskId, OMER, 'completed') },
      { from: DANA, body: status(r.taskId, OMER, 'working') }, // after completed
    ]);
    expect(s.events.map((e) => e.kind)).toEqual(['posted', 'ignored', 'status', 'artifact', 'status', 'ignored']);
    const t = s.board.tasks[boardKey(OMER, r.taskId)];
    expect(t).toMatchObject({ state: 'completed', artifacts: [expect.objectContaining({ text: 'Launch faster with Rendezvous.', done: true, name: 'copy' })] });
    expect(t.request).toBeUndefined(); // dropped once finished
  });

  it('release returns the task to open; the requester taking it back unassigns the assignee', () => {
    const r = request(OMER, { assignee: DANA });
    const back = boardVerb(GROUP, r.taskId, { rdv: 'task/release', requester: OMER }, { newId });
    const byJohn = boardVerb(GROUP, r.taskId, { rdv: 'task/release', requester: OMER }, { newId });
    const s = feed(DANA, [
      { from: OMER, body: r.payload },
      { from: JOHN, body: byJohn },
      { from: OMER, body: back },
    ]);
    expect(s.events.map((e) => e.kind)).toEqual(['posted', 'ignored', 'released']);
    expect(s.effects.map((e) => e.kind)).toEqual(['execute', 'unassign']);
    expect(s.board.tasks[boardKey(OMER, r.taskId)].assignee).toBeUndefined();
  });

  it('input and cancel from the requester only, forwarded to the assignee', () => {
    const r = request(OMER, { assignee: DANA });
    const input = boardVerb(GROUP, r.taskId, { rdv: 'task/input' }, { text: 'shorter please', newId });
    const cancel = boardVerb(GROUP, r.taskId, { rdv: 'rdv/cancel' }, { newId });
    const s = feed(DANA, [
      { from: OMER, body: r.payload },
      { from: JOHN, body: cancel }, // John's own task under that ID: we hold none
      { from: OMER, body: input },
      { from: OMER, body: cancel },
    ]);
    expect(s.events.map((e) => e.kind)).toEqual(['posted', 'input', 'canceled']);
    expect(s.effects.map((e) => e.kind)).toEqual(['execute', 'forward', 'forward']);
    expect(s.board.early).toHaveLength(1); // John's cancel waits for a task of his that may never come
  });

  it('a member reusing another requester task ID names its own task, never that one', () => {
    const r = request(OMER);
    const copy = structuredClone(r.payload) as { message: { messageId: string } };
    copy.message.messageId = newId();
    const s = feed(JOHN, [
      { from: OMER, body: r.payload },
      { from: DANA, body: copy },
    ]);
    expect(Object.keys(s.board.tasks).sort()).toEqual([boardKey(OMER, r.taskId), boardKey(DANA, r.taskId)].sort());
    expect(s.board.tasks[boardKey(OMER, r.taskId)].requester).toBe(OMER);
  });

  it('messages that arrive before their task wait, bounded, and apply in order', () => {
    const r = request(OMER);
    const claim = boardVerb(GROUP, r.taskId, { rdv: 'task/claim', requester: OMER }, { newId });
    const assign = boardVerb(GROUP, r.taskId, { rdv: 'task/assign', requester: OMER, assignee: DANA }, { newId });
    const s = feed(JOHN, [
      { from: DANA, body: status(r.taskId, OMER, 'working') },
      { from: DANA, body: claim },
      { from: OMER, body: assign },
      { from: OMER, body: r.payload },
    ]);
    expect(s.events.map((e) => e.kind)).toEqual(['posted', 'claimed', 'assigned', 'status']);
    expect(s.board.early).toBeUndefined();
    // Bounded per sender, and dropped after a while.
    let b = emptyBoard(GROUP);
    for (let i = 0; i < 10; i++) b = boardReceive(b, { from: EVE, board: true, body: status(newId(), OMER, 'working') }, ctx(JOHN, { members: [OMER, JOHN, EVE] })).board;
    expect(b.early).toHaveLength(4);
    expect(boardSweep(b, { ...ctx(JOHN), now: later(11 * 60_000) }).board.early).toBeUndefined();
  });

  it('a non-member, another group, or a note changes nothing', () => {
    const r = request(OMER);
    expect(feed(JOHN, [{ from: EVE, body: r.payload }]).board.tasks).toEqual({});
    const other = boardRequest('22222222-2222-4222-8222-222222222222', { capability: REQUEST_URI, text: ['x'] }, { now: NOW, me: OMER, newId });
    expect(feed(JOHN, [{ from: OMER, body: other.payload }]).board.tasks).toEqual({});
    expect(feed(JOHN, [{ from: OMER, body: { type: 'note', text: 'hello' } }]).events).toEqual([]);
  });

  it('the assignee leaving reopens its task; expiry ends open tasks', () => {
    const r = request(OMER, { assignee: DANA });
    const b = feed(JOHN, [{ from: OMER, body: r.payload }]).board;
    const gone = boardDeparted(b, DANA, ctx(JOHN, { members: [OMER, JOHN] }));
    expect(gone.events).toMatchObject([{ kind: 'reopened', assignee: DANA }]);
    expect(gone.board.tasks[boardKey(OMER, r.taskId)]).toMatchObject({ state: 'submitted' });
    expect(gone.board.tasks[boardKey(OMER, r.taskId)].assignee).toBeUndefined();
    const swept = boardSweep(gone.board, { ...ctx(JOHN), now: later(3 * 86_400_000) });
    expect(swept.events).toMatchObject([{ kind: 'expired' }]);
    expect(swept.board.tasks[boardKey(OMER, r.taskId)].state).toBe('canceled');
  });

  it('one requester has at most 16 open tasks on a board', () => {
    let b = emptyBoard(GROUP);
    const kinds: string[] = [];
    for (let i = 0; i < 17; i++) {
      const step = boardReceive(b, { from: OMER, board: true, body: request(OMER).payload }, ctx(JOHN));
      kinds.push(...step.events.map((e) => e.kind));
      b = step.board;
    }
    expect(kinds.filter((k) => k === 'posted')).toHaveLength(16);
    expect(kinds.at(-1)).toBe('ignored');
  });
});

describe('the join scope as the limiter (max_open, max_frequency)', () => {
  const scope = { invoke: { [REQUEST_URI]: { max_frequency: '3/day' } }, max_frequency: '2/hour' };
  it('counts every member together, per capability and in all', () => {
    let c;
    const verdicts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = admitGroupInvoke(c, scope, REQUEST_URI, { open: 0, maxOpen: 4 }, later(i * 40 * 60_000));
      verdicts.push(r.verdict.ok ? 'ok' : r.verdict.code);
      c = r.counters;
    }
    // 0 and 40 min: ok; 80 min: the 2/hour window is past the first, ok; 120 min: 3/day reached.
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'rate']);
  });
  it('refuses a capability the terms do not list, and past max_open', () => {
    expect(admitGroupInvoke(undefined, { invoke: {} }, REQUEST_URI, { open: 0, maxOpen: 4 }, NOW).verdict).toMatchObject({ ok: false, code: 'scope' });
    expect(admitGroupInvoke(undefined, { invoke: { [REQUEST_URI]: {} } }, REQUEST_URI, { open: 4, maxOpen: 4 }, NOW).verdict).toMatchObject({ ok: false, code: 'rate' });
    expect(admitGroupInvoke(undefined, { invoke: { [REQUEST_URI]: {} } }, REQUEST_URI, { open: 0, maxOpen: 4 }, NOW)).toEqual({ verdict: { ok: true }, counters: {} });
  });
  it('the requester key travels in update metadata', () => {
    const u = status(newId(), OMER, 'working') as { update: { metadata: Record<string, unknown> } };
    expect(u.update.metadata[GROUP_REQUESTER_KEY]).toBe(OMER);
  });
});
