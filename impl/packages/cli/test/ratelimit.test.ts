// Per-capability task limits end to end (issue #28): two core agents over the
// in-memory relay, the a2a task engine on Omer's side with core's limiter
// (`Agent.admitTask`) as its `limit`. A hostile John sends raw task/requests
// (our own requestTask would stop him first, which is checked too). Meetings
// (issue #41) go through the same limiter, from the meeting engine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  type Ctx as MeetingCtx,
  emptyState,
  emptyTaskState,
  type MeetingScope,
  type NegotiationState,
  parseWindow,
  propose,
  receive,
  outboundLimit,
  REASON_KEY,
  receiveTask,
  requestTask,
  s,
  type TaskEngineState,
  TASKS_URI,
} from '@rendezvous/a2a';
import { Agent, type AgentKey, effectiveInvoke, MEETINGS_CAPABILITY, NostrTransport, type Payload, type TaskAbuse } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';

const LOOKUP = 'https://rendezvous.nesher.co/ext/test-lookup/v1';
const registry = () => new CapabilityRegistry([{ uri: LOOKUP, approval: 'auto', input: s.object({ q: s.string(40) }) }]);
const uuid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const request = (n: number): Payload =>
  ({
    type: 'a2a/message',
    message: {
      kind: 'message',
      messageId: uuid(1000 + n),
      taskId: uuid(n),
      contextId: uuid(999),
      role: 'agent',
      parts: [{ kind: 'data', data: { rdv: 'task/request', capability: LOOKUP, input: { q: `item ${n}` } } }],
      extensions: [TASKS_URI, LOOKUP],
    },
  }) as unknown as Payload;

function until(cond: () => boolean, ms = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => (cond() ? resolve() : Date.now() - start > ms ? reject(new Error('timeout')) : setTimeout(tick, 20));
    tick();
  });
}

describe('per-capability limits end to end (issue #28)', () => {
  let relay: TestRelay;
  const agents: Agent[] = [];
  beforeEach(async () => {
    relay = await startTestRelay();
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) a.close();
    await relay.close();
  });
  const make = (email: string) => {
    const a = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [relay.url] }), {
      rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }],
      discovery: { addresses: [{ type: 'email', value: email }], public_pointer: false },
      policy: { public: false },
    });
    a.on('error', (e) => {
      throw e;
    });
    a.start();
    agents.push(a);
    return a;
  };

  it('the sixth task on a 5/day capability is rejected (rate) and counted, the grant stays; past 3x the limit the grant is revoked', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200));
    const asked = new Promise<{ request: { id: string } }>((r) => omer.once('request', r));
    await john.requestContact(omer.card, 'hi');
    const contact = new Promise((r) => john.once('contact', r));
    await omer.grant((await asked).request.id, {
      tier: 'friend',
      scope: { may_initiate: true, max_frequency: '100/day', invoke: { [LOOKUP]: { max_frequency: '5/day', max_open: 100 } } },
    });
    await contact;

    // Omer's host: every task payload goes through the engine with core's limiter.
    let tasks: TaskEngineState = emptyTaskState();
    const abuses: TaskAbuse[] = [];
    omer.on('task-abuse', (a) => abuses.push(a));
    omer.on('message', (from, payload) => {
      const c = omer.book.contact(from);
      if (!c) return;
      const now = new Date();
      const step = receiveTask(tasks, from, payload, {
        now,
        registry: registry(),
        invoke: effectiveInvoke(c.inboundScope),
        tier: c.tier,
        limit: (cap, o) => omer.admitTask(from, cap, o, now),
      });
      tasks = step.state;
      // A grant revoked for abuse gets no answer: the rdv/revoke says it all.
      for (const o of step.outgoing) if (omer.book.contact(o.to)) void omer.send(o.to, o.payload as unknown as Payload);
    });
    const states: Array<{ state: string; reason?: unknown }> = [];
    john.on('message', (_from, payload) => {
      const u = (payload as unknown as { update?: { status: { state: string }; metadata?: Record<string, unknown> } }).update;
      if (u) states.push({ state: u.status.state, reason: u.metadata?.[REASON_KEY] });
    });
    let revoked = false;
    john.on('revoked', () => (revoked = true));

    // Our own outbound helper would stop John at five.
    let mine = emptyTaskState();
    const jctx = () => ({ now: new Date(), registry: registry(), invoke: effectiveInvoke(john.book.contact(omer.id)!.outboundScope) });
    for (let i = 0; i < 5; i++) mine = requestTask(mine, omer.id, LOOKUP, jctx(), { input: { q: 'x' } }).state;
    expect(outboundLimit(mine, omer.id, LOOKUP, jctx())).toMatch(/5\/day/);

    // A hostile John sends anyway.
    for (let n = 1; n <= 6; n++) await john.send(omer.id, request(n));
    await until(() => states.length === 6);
    expect(states.slice(0, 5).every((s) => s.state === 'working')).toBe(true);
    expect(states[5]).toEqual({ state: 'rejected', reason: 'rate' });
    expect(omer.book.contact(john.id)).toBeDefined(); // the grant stays
    expect(omer.book.taskRejections(john.id)).toBe(1);
    expect(tasks.dropped.rate).toBe(1);
    expect(Object.keys(tasks.tasks)).toHaveLength(5); // nothing kept for the rejected one

    // 15 rejections in the window (3 x 5) are tolerated; the 16th revokes.
    for (let n = 7; n <= 20; n++) await john.send(omer.id, request(n));
    await until(() => states.length === 20);
    expect(omer.book.contact(john.id)).toBeDefined();
    expect(abuses).toEqual([]);
    await john.send(omer.id, request(21));
    await until(() => revoked);
    expect(abuses).toEqual([expect.objectContaining({ peer: john.id, capability: LOOKUP, trigger: 'capability', rejected: 16, threshold: 15 })]);
    expect(omer.book.contact(john.id)).toBeUndefined();
    expect(john.book.contact(omer.id)).toBeUndefined();
    expect(states).toHaveLength(20); // no answer after the revoke
  });

  it('meetings (issue #41): a proposal over the meetings URI limit is declined (rate) and counted; past 3x the limit the grant is revoked', async () => {
    const omer = make('omer@example.com');
    const john = make('john@doe.com');
    await new Promise((r) => setTimeout(r, 200));
    const asked = new Promise<{ request: { id: string } }>((r) => omer.once('request', r));
    await john.requestContact(omer.card, 'hi');
    const contact = new Promise((r) => john.once('contact', r));
    await omer.grant((await asked).request.id, {
      tier: 'friend',
      scope: { may_initiate: true, may_propose_meetings: true, max_frequency: '100/day', invoke: { [MEETINGS_CAPABILITY]: { max_frequency: '2/day', max_open: 100 } } },
    });
    await contact;

    // Omer's host, as `rdv listen --negotiate` runs it: the meeting engine with core's limiter.
    const now = () => new Date();
    const window = (at: Date) => parseWindow('next week evenings', { now: at, offsetMinutes: 0 });
    const ctx = (at: Date, scope: MeetingScope): MeetingCtx => ({
      now: at,
      busy: [],
      busyRange: { start: new Date(at.getTime() - 86_400_000).toISOString(), end: new Date(at.getTime() + 180 * 86_400_000).toISOString() },
      window: window(at),
      offsetMinutes: 0,
      scope,
    });
    let meetings: NegotiationState = emptyState();
    const abuses: TaskAbuse[] = [];
    omer.on('task-abuse', (a) => abuses.push(a));
    omer.on('message', (from, payload) => {
      const c = omer.book.contact(from);
      if (!c) return;
      const at = now();
      const step = receive(meetings, from, payload, { ...ctx(at, c.inboundScope as MeetingScope), limit: (cap, o) => omer.admitTask(from, cap, o, at) });
      meetings = step.state;
      for (const o of step.outgoing) if (omer.book.contact(o.to)) void omer.send(o.to, o.payload as unknown as Payload);
    });
    const declines: string[] = [];
    john.on('message', (_from, payload) => {
      const m = (payload as unknown as { message?: { parts: Array<{ kind: string; data?: { rdv?: string; reason?: string } }> } }).message;
      const data = m?.parts.find((p) => p.kind === 'data')?.data;
      if (data?.rdv === 'meeting/decline') declines.push(String(data.reason));
    });
    let revoked = false;
    john.on('revoked', () => (revoked = true));
    const proposeOne = async () => {
      const step = propose(emptyState(), omer.id, ctx(now(), john.book.contact(omer.id)!.outboundScope as MeetingScope));
      await john.send(omer.id, step.outgoing[0].payload as unknown as Payload);
    };

    // Two proposals in the day are taken (held for Omer's human); the third is declined for the limit, nothing kept.
    for (let n = 0; n < 3; n++) await proposeOne();
    await until(() => declines.length === 1);
    expect(declines[0]).toMatch(/^rate: over this capability's max_frequency \(2\/day\)/);
    expect(Object.keys(meetings.tasks)).toHaveLength(2);
    expect(omer.book.contact(john.id)).toBeDefined(); // the grant stays
    expect(omer.book.taskRejections(john.id)).toBe(1);

    // 6 rejections in the window (3 x 2) are tolerated; the 7th revokes.
    for (let n = 0; n < 5; n++) await proposeOne();
    await until(() => declines.length === 6);
    expect(omer.book.contact(john.id)).toBeDefined();
    expect(abuses).toEqual([]);
    await proposeOne();
    await until(() => revoked);
    expect(abuses).toEqual([expect.objectContaining({ peer: john.id, capability: MEETINGS_CAPABILITY, trigger: 'capability', rejected: 7, threshold: 6 })]);
    expect(omer.book.contact(john.id)).toBeUndefined();
    expect(john.book.contact(omer.id)).toBeUndefined();
    expect(declines).toHaveLength(6); // no answer after the revoke
    expect(Object.keys(meetings.tasks)).toHaveLength(2);
  });
});
