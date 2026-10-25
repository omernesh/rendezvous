import { describe, expect, it } from 'vitest';
import {
  type A2APayload,
  agreedSnapshot,
  awaitingHuman,
  cancel,
  cancelMeeting,
  cardCapabilities,
  CONFIRM_GRACE_MS,
  EXTENSIONS,
  confirmMeeting,
  type Effect,
  type Ctx,
  emptyState,
  expire,
  FINISHED_REPLIES,
  SEEN_PER_TASK,
  type MeetingScope,
  MAX_TASKS_PER_PEER,
  MeetingChangedError,
  meetingsAllowed,
  meetingSnapshot,
  MemoryCalendar,
  type NegotiationEvent,
  type NegotiationState,
  NegotiationError,
  type Outgoing,
  parsePayload,
  parseWindow,
  peerAdvertises,
  propose,
  receive,
  sameMeeting,
  type Slot,
  type Span,
  sameSpan,
  SUPPORTED_EXTENSIONS,
  toSpan,
  UNSUPPORTED_KEY,
  type Verb,
  VERB_EXTENSION,
} from '../src/index.js';

const OMER = 'rdv1:omer';
const JOHN = 'rdv1:john';
const MALLORY = 'rdv1:mallory';
// Sunday 25 Oct 2026, 12:00 at +02:00; "next week" = Mon 26 Oct – Sun 1 Nov.
const NOW = new Date('2026-10-25T10:00:00Z');
const TZ = 120;
const SCOPE: MeetingScope = { may_initiate: true, may_propose_meetings: true, may_access_calendar: 'free_busy' };
const BUSY_RANGE: Slot = { start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z' };

/** Evening 19:00–23:00 (+02:00) of day `d` of next week (0 = Monday 26 Oct). */
const evening = (d: number, from = 19, to = 23): Slot => {
  const day = String(26 + d > 31 ? 26 + d - 31 : 26 + d).padStart(2, '0');
  const month = 26 + d > 31 ? '11' : '10';
  return { start: `2026-${month}-${day}T${from}:00:00+02:00`, end: `2026-${month}-${day}T${to}:00:00+02:00` };
};

function ids(prefix: number) {
  let n = 0;
  return () => `00000000-0000-4000-8${prefix.toString(16).padStart(3, '0')}-${String(++n).padStart(12, '0')}`;
}

interface Side {
  id: string;
  state: NegotiationState;
  busy: Slot[];
  window: Span[];
  offset: number;
  scope: MeetingScope;
  holds: Slot[];
  events: NegotiationEvent[];
  newId: () => string;
  autoConfirm: boolean;
}

function side(id: string, n: number, opts: Partial<Pick<Side, 'busy' | 'window' | 'offset' | 'scope' | 'autoConfirm'>> = {}): Side {
  const offset = opts.offset ?? TZ;
  return {
    id,
    state: emptyState(),
    busy: opts.busy ?? [],
    window: opts.window ?? parseWindow('next week evenings', { now: NOW, offsetMinutes: offset }),
    offset,
    scope: opts.scope ?? SCOPE,
    holds: [],
    events: [],
    newId: ids(n),
    autoConfirm: opts.autoConfirm ?? true,
  };
}

const ctxOf = (s: Side, now = NOW): Ctx => ({
  now,
  busy: s.busy,
  busyRange: BUSY_RANGE,
  window: s.window,
  offsetMinutes: s.offset,
  scope: s.scope,
  newId: s.newId,
  autoConfirm: s.autoConfirm,
});

/** Apply a step; `holds` mirrors the calendar (a tentative hold and its final form are one entry). */
function apply(s: Side, step: { state: NegotiationState; effects: Effect[]; events: NegotiationEvent[] }) {
  s.state = step.state;
  for (const e of step.effects) {
    const i = s.holds.findIndex((h) => sameSpan(toSpan(h), toSpan(e.slot)));
    if (e.kind === 'release') {
      if (i >= 0) s.holds.splice(i, 1);
    } else if (i < 0) s.holds.push(e.slot);
  }
  s.events.push(...step.events);
}

/** Deliver messages back and forth until both sides go quiet. Returns everything sent. */
function run(a: Side, b: Side, first: Outgoing[], now = NOW): Outgoing[] {
  const sides = { [a.id]: a, [b.id]: b };
  const wire: Outgoing[] = [];
  let queue = [...first].map((o) => ({ from: o.to === a.id ? b.id : a.id, o }));
  while (queue.length) {
    const { from, o } = queue.shift()!;
    wire.push(o);
    const to = sides[o.to];
    const step = receive(to.state, from, o.payload, ctxOf(to, now));
    apply(to, step);
    queue.push(...step.outgoing.map((x) => ({ from: to.id, o: x })));
    if (wire.length > 50) throw new Error('negotiation does not terminate');
  }
  return wire;
}

function start(a: Side, b: Side, opts: Parameters<typeof propose>[3] = {}) {
  const step = propose(a.state, b.id, ctxOf(a), opts);
  apply(a, step);
  return { taskId: step.taskId, wire: run(a, b, step.outgoing) };
}

const task = (s: Side, id: string) => s.state.tasks[id];
const verbs = (wire: Outgoing[]) =>
  wire.map((o) => (o.payload.type === 'a2a/message' ? (o.payload.message.parts.find((p) => p.kind === 'data') as { data: { rdv: string } }).data.rdv : `update:${o.payload.update.status.state}`));

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('negotiation', () => {
  it('accepts the first mutually free slot in round 1, and both sides hold it', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0)] }); // Monday is out for John
    const { taskId, wire } = start(omer, john, { place: { area: 'Tel Aviv' } });
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/accept', 'meeting/confirm', 'update:completed']);
    const sent = (wire[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message;
    const offered = (sent.parts[1] as { data: { slots: Slot[] } }).data.slots;
    // One per day, starting on the first free evening hour.
    expect(offered.map((s) => s.start)).toEqual(['2026-10-26T19:00:00+02:00', '2026-10-27T19:00:00+02:00', '2026-10-28T19:00:00+02:00']);
    for (const s of [omer, john]) {
      expect(task(s, taskId).state).toBe('completed');
      expect(task(s, taskId).agreed).toEqual(evening(1, 19, 21));
      expect(task(s, taskId).place).toEqual({ area: 'Tel Aviv' });
      expect(s.holds).toEqual([evening(1, 19, 21)]);
      expect(task(s, taskId).hold).toBeUndefined();
    }
    expect(task(omer, taskId).peerState).toBe('completed'); // John acknowledged the confirm
  });

  it('agrees on round 2 when none of the first offer fits', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0), evening(1), evening(2)] });
    const { taskId, wire } = start(omer, john);
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/counter', 'meeting/accept', 'meeting/confirm', 'update:completed']);
    expect(task(omer, taskId).agreed).toEqual(evening(3, 19, 21));
    expect(task(john, taskId).agreed).toEqual(evening(3, 19, 21));
    expect(task(omer, taskId).round).toBe(2);
    expect(john.events.find((e) => e.kind === 'countered')?.state).toBe('input-required');
  });

  it('ends rejected after 3 rounds when calendars never overlap', () => {
    const omer = side(OMER, 1, { busy: [3, 4, 5, 6].map((d) => evening(d)) });
    const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
    const { taskId, wire } = start(omer, john);
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/counter', 'meeting/counter', 'meeting/decline']);
    for (const s of [omer, john]) {
      expect(task(s, taskId).state).toBe('rejected');
      expect(task(s, taskId).round).toBe(3);
      expect(task(s, taskId).reason).toMatch(/3 rounds/);
      expect(s.holds).toEqual([]);
    }
    // Round 3 avoids Omer's own earlier slots.
    expect(task(omer, taskId).ourOffers[1].map((s) => s.start)).toEqual([
      '2026-10-26T21:00:00+02:00',
      '2026-10-27T21:00:00+02:00',
      '2026-10-28T21:00:00+02:00',
    ]);
  });

  it('a replayed message changes nothing and sends nothing', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0), evening(1), evening(2)] });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const first = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    apply(john, first);
    expect(first.outgoing).toHaveLength(1);
    const before = structuredClone(john.state);
    const again = receive(deepFreeze(john.state), OMER, p.outgoing[0].payload, ctxOf(john));
    expect(again.outgoing).toEqual([]);
    expect(again.effects).toEqual([]);
    expect(again.state).toEqual(before);
    expect(again.events.map((e) => e.kind)).toEqual(['duplicate']);
    // Same messageId with different content is still a duplicate (dedupe is by ID).
    const tampered = structuredClone(p.outgoing[0].payload) as Extract<A2APayload, { type: 'a2a/message' }>;
    (tampered.message.parts[1] as { data: { slots: Slot[] } }).data.slots = [evening(5, 19, 21)];
    expect(receive(john.state, OMER, tampered, ctxOf(john)).events.map((e) => e.kind)).toEqual(['duplicate']);
  });

  it('cancel while pending ends canceled on both sides', () => {
    const omer = side(OMER, 1, { busy: [3, 4, 5, 6].map((d) => evening(d)) });
    const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)); // John counters
    apply(john, j);
    const c = cancel(omer.state, p.taskId, ctxOf(omer), 'change of plans');
    apply(omer, c);
    // John's counter crosses Omer's cancel on the wire.
    const wire = run(omer, john, [...j.outgoing, ...c.outgoing]);
    expect(verbs(wire)).toEqual(['meeting/counter', 'rdv/cancel', 'update:canceled', 'update:canceled']);
    expect(task(omer, p.taskId).state).toBe('canceled');
    expect(task(john, p.taskId).state).toBe('canceled');
    expect(task(john, p.taskId).reason).toBe('change of plans');
    expect(() => cancel(omer.state, p.taskId, ctxOf(omer))).toThrow(/already canceled/);
  });

  it('a cancel that overtakes its proposal leaves a tombstone, and the proposal is refused', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2);
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const c = cancel(omer.state, p.taskId, ctxOf(omer));
    apply(omer, c);
    const s1 = receive(john.state, OMER, c.outgoing[0].payload, ctxOf(john));
    apply(john, s1);
    expect(task(john, p.taskId).state).toBe('canceled');
    const s2 = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    apply(john, s2);
    expect(task(john, p.taskId).state).toBe('canceled');
    expect(s2.effects).toEqual([]);
    expect(verbs(s2.outgoing)).toEqual(['update:canceled']);
    expect(john.holds).toEqual([]);
  });

  it('cancel after completion is not honored', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2);
    const { taskId } = start(omer, john);
    // Forge a late cancel from Omer's side by rewinding his state.
    const pending = structuredClone(omer.state);
    pending.tasks[taskId].state = 'submitted';
    const c = cancel(pending, taskId, ctxOf(omer));
    const r = receive(john.state, OMER, c.outgoing[0].payload, ctxOf(john));
    expect(r.state.tasks[taskId].state).toBe('completed');
    expect(r.events[0]).toMatchObject({ kind: 'ignored', reason: 'cancel after completed' });
    expect(verbs(r.outgoing)).toEqual(['update:completed']);
  });

  it('rejects verbs that are invalid for the state', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0), evening(1), evening(2)] });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const msg = (p.outgoing[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message;
    const make = (data: object, messageId = john.newId()): A2APayload => ({
      type: 'a2a/message',
      message: { ...msg, messageId, parts: [{ kind: 'data', data: data as never }] },
    });
    const kinds = (r: ReturnType<typeof receive>) => r.events.map((e) => `${e.kind}:${e.reason ?? ''}`);
    const offered = (msg.parts[1] as { data: { slots: Slot[] } }).data.slots;

    // accept of a slot never offered
    let r = receive(omer.state, JOHN, make({ rdv: 'meeting/accept', slot: evening(5, 19, 21) }), ctxOf(omer));
    expect(kinds(r)).toEqual(['invalid:accept of a slot that was never offered']);
    expect(r.state).toEqual(omer.state);
    // a second proposal for the same task
    r = receive(omer.state, JOHN, make({ rdv: 'meeting/propose', slots: [evening(5, 19, 21)] }), ctxOf(omer));
    expect(kinds(r)).toEqual(['invalid:a second proposal for the same task (use meeting/counter)']);
    // counter/accept for a task that doesn't exist
    const unknown = { ...make({ rdv: 'meeting/accept', slot: offered[0] }) } as Extract<A2APayload, { type: 'a2a/message' }>;
    unknown.message = { ...unknown.message, taskId: '00000000-0000-4000-8000-00000000dead' };
    expect(kinds(receive(omer.state, JOHN, unknown, ctxOf(omer)))).toEqual(['invalid:meeting/accept for an unknown task']);
    // someone else's task
    expect(kinds(receive(omer.state, MALLORY, make({ rdv: 'rdv/cancel' }), ctxOf(omer)))).toEqual(['invalid:task belongs to another peer']);
    expect(task(omer, p.taskId).state).toBe('submitted');

    // John counters; Omer accepts it and waits for John's confirm: anything else is refused.
    const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    apply(john, j);
    const o = receive(omer.state, JOHN, j.outgoing[0].payload, ctxOf(omer));
    apply(omer, o);
    expect(task(omer, p.taskId).hold?.stage).toBe('peer-confirm');
    r = receive(omer.state, JOHN, make({ rdv: 'meeting/counter', slots: [evening(5, 19, 21)] }), ctxOf(omer));
    expect(kinds(r)).toEqual(['invalid:meeting/counter while waiting for meeting/confirm']);
    r = receive(omer.state, JOHN, make({ rdv: 'meeting/confirm', slot: evening(5, 19, 21) }), ctxOf(omer));
    expect(kinds(r)).toEqual(['invalid:confirm of a slot we did not accept']);
    // A confirm John never had reason to send: Omer is not waiting for one on a fresh task.
    expect(kinds(receive(emptyState(), JOHN, make({ rdv: 'meeting/confirm', slot: offered[0] }), ctxOf(omer)))).toEqual([
      'invalid:meeting/confirm for an unknown task',
    ]);
    const jc = receive(john.state, OMER, o.outgoing[0].payload, ctxOf(john));
    apply(john, jc);
    apply(omer, receive(omer.state, JOHN, jc.outgoing[0].payload, ctxOf(omer)));
    expect(task(omer, p.taskId).state).toBe('completed');
    r = receive(omer.state, JOHN, make({ rdv: 'meeting/counter', slots: [evening(5, 19, 21)] }), ctxOf(omer));
    expect(kinds(r)).toEqual(['ignored:meeting/counter after completed']);
    expect(r.state.tasks[p.taskId].state).toBe('completed');
    // garbage
    expect(kinds(receive(omer.state, JOHN, { type: 'a2a/message', message: { kind: 'message' } }, ctxOf(omer)))[0]).toMatch(/^invalid:/);
  });

  it('a counter beyond round 3 is refused, and one after the end is ignored', () => {
    const omer = side(OMER, 1, { busy: [3, 4, 5, 6].map((d) => evening(d)) });
    const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    apply(john, j);
    const o = receive(omer.state, JOHN, j.outgoing[0].payload, ctxOf(omer)); // Omer's round-3 offer
    apply(omer, o);
    expect(task(omer, p.taskId)).toMatchObject({ round: 3, turn: 'peer', state: 'working' });
    // A misbehaving John counters a fourth time instead of declining.
    const m = (j.outgoing[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message;
    const fourth: A2APayload = {
      type: 'a2a/message',
      message: { ...m, messageId: john.newId(), parts: [{ kind: 'data', data: { rdv: 'meeting/counter', slots: [evening(6, 21, 23)] } }] },
    };
    const r = receive(omer.state, JOHN, fourth, ctxOf(omer));
    expect(r.events.map((e) => `${e.kind}:${e.reason}`)).toEqual(['invalid:counter beyond 3 rounds']);
    expect(r.outgoing).toEqual([]);
    expect(r.state).toEqual(omer.state);
    // John declines properly; afterwards a counter is just ignored.
    const d = receive(john.state, OMER, o.outgoing[0].payload, ctxOf(john));
    apply(omer, receive(omer.state, JOHN, d.outgoing[0].payload, ctxOf(omer)));
    expect(task(omer, p.taskId).state).toBe('rejected');
    const late: A2APayload = { ...fourth, message: { ...(fourth as Extract<A2APayload, { type: 'a2a/message' }>).message, messageId: john.newId() } };
    expect(receive(omer.state, JOHN, late, ctxOf(omer)).events.map((e) => e.kind)).toEqual(['ignored']);
  });

  it('matches an accept by instant, whatever offset the peer wrote', () => {
    const omer = side(OMER, 1);
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const m = (p.outgoing[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message;
    const accept: A2APayload = {
      type: 'a2a/message',
      message: { ...m, messageId: ids(7)(), parts: [{ kind: 'data', data: { rdv: 'meeting/accept', slot: { start: '2026-10-27T17:00:00Z', end: '2026-10-27T19:00:00Z' } } }] },
    };
    const r = receive(omer.state, JOHN, accept, ctxOf(omer));
    expect(r.state.tasks[p.taskId].state).toBe('completed');
    expect(r.state.tasks[p.taskId].agreed).toEqual(evening(1, 19, 21)); // our own representation
    expect(r.effects).toEqual([expect.objectContaining({ kind: 'hold', tentative: false })]);
  });

  it('negotiates across time zones', () => {
    // John lives at -05:00 and wants 12:00–16:00 his time (19:00–23:00 at +02:00) on Tuesday.
    const omer = side(OMER, 1, { busy: [evening(0)] });
    const john = side(JOHN, 2, {
      offset: -300,
      window: parseWindow('2026-10-27T12:00:00-05:00/2026-10-27T16:00:00-05:00', { now: NOW, offsetMinutes: -300 }),
    });
    const { taskId, wire } = start(omer, john);
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/accept', 'meeting/confirm', 'update:completed']);
    expect(task(john, taskId).agreed).toEqual({ start: '2026-10-27T19:00:00+02:00', end: '2026-10-27T21:00:00+02:00' });
    // And John's own offers are written in his offset.
    const john2 = side(JOHN, 3, { offset: -300, busy: [], window: parseWindow('next week evenings', { now: NOW, offsetMinutes: -300 }) });
    const p = propose(john2.state, OMER, ctxOf(john2));
    const slots = ((p.outgoing[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message.parts[1] as { data: { slots: Slot[] } }).data.slots;
    expect(slots[0]).toEqual({ start: '2026-10-26T19:00:00-05:00', end: '2026-10-26T21:00:00-05:00' });
  });

  it('enforces the grant scope', () => {
    const omer = side(OMER, 1);
    expect(() => propose(omer.state, JOHN, { ...ctxOf(omer), scope: { may_initiate: true } })).toThrow(NegotiationError);
    expect(() => propose(omer.state, JOHN, { ...ctxOf(omer), scope: { may_propose_meetings: true, may_access_calendar: 'none' } })).toThrow(/none/);
    // Absent may_access_calendar counts as free_busy.
    expect(() => propose(omer.state, JOHN, { ...ctxOf(omer), scope: { may_propose_meetings: true } })).not.toThrow();
    const p = propose(omer.state, JOHN, ctxOf(omer));
    const john = side(JOHN, 2, { scope: { may_initiate: true, may_propose_meetings: false } });
    const r = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    expect(r.outgoing).toEqual([]);
    expect(r.state.tasks).toEqual({});
    expect(r.events[0]).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/may_propose_meetings/) });
  });

  it('scope.invoke decides meetings: invoke first, the boolean as fallback, the narrower on disagreement (issue #23)', () => {
    const M = EXTENSIONS.meeting;
    const REVIEW = 'https://rendezvous.nesher.co/ext/review/v1';
    const cases: Array<[MeetingScope | undefined, boolean]> = [
      [undefined, false],
      [{}, false],
      [{ may_propose_meetings: true }, true],
      [{ may_propose_meetings: false }, false],
      [{ invoke: { [M]: {} } }, true],
      [{ invoke: { [REVIEW]: {} } }, false],
      [{ may_propose_meetings: true, invoke: { [M]: {} } }, true],
      [{ may_propose_meetings: true, invoke: { [REVIEW]: {} } }, false],
      [{ may_propose_meetings: false, invoke: { [M]: {} } }, false],
      [{ may_propose_meetings: true, invoke: [M] as never }, false],
      [{ may_propose_meetings: true, invoke: { [M]: true } }, false],
    ];
    for (const [scope, ok] of cases) expect(meetingsAllowed(scope), JSON.stringify(scope)).toBe(ok);
    // A proposal from a peer whose grant lists no meetings in invoke is refused before any state is kept.
    const omer = side(OMER, 1);
    const p = propose(omer.state, JOHN, ctxOf(omer));
    const john = side(JOHN, 2, { scope: { may_initiate: true, may_propose_meetings: true, invoke: { [REVIEW]: {} } } });
    const r = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    expect([r.outgoing, r.state.tasks]).toEqual([[], {}]);
    expect(r.events[0]).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/invoke/) });
    // Listed in invoke: negotiated as before.
    const ok = side(JOHN, 2, { scope: { may_initiate: true, may_propose_meetings: true, invoke: { [M]: {} } } });
    expect(Object.keys(receive(ok.state, OMER, p.outgoing[0].payload, ctxOf(ok)).state.tasks)).toHaveLength(1);
    expect(() => propose(omer.state, JOHN, { ...ctxOf(omer), scope: { may_propose_meetings: true, invoke: {} } })).toThrow(NegotiationError);
  });

  it('free_busy: event titles never leave the calendar', async () => {
    const cal = new MemoryCalendar([{ ...evening(0), title: 'Secret surgery' }, { ...evening(1), title: 'Therapy' }]);
    const busy = await cal.freeBusy(BUSY_RANGE);
    expect(busy).toEqual([evening(0), evening(1)]);
    const omer = side(OMER, 1, { busy });
    const john = side(JOHN, 2, { busy: [evening(2)] });
    const { wire } = start(omer, john);
    const all = JSON.stringify(wire);
    expect(all).not.toMatch(/Secret|surgery|Therapy/);
    await cal.hold(evening(3, 19, 21), 'Dinner');
    await cal.hold(evening(3, 19, 21), 'Dinner');
    expect(cal.entries).toHaveLength(3);
  });

  it('expires: past-due proposals are declined, and the sweep rejects stale tasks', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
    const p = propose(omer.state, JOHN, ctxOf(omer), { expires: '2026-10-25T12:00:00Z' });
    apply(omer, p);
    // Arrives after it expired.
    const late = new Date('2026-10-25T13:00:00Z');
    const r = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john, late));
    expect(r.state.tasks[p.taskId]).toMatchObject({ state: 'rejected', reason: 'expired' });
    expect(verbs(r.outgoing)).toEqual(['meeting/decline']);
    // Omer's own sweep.
    const sweep = expire(omer.state, { now: late, newId: omer.newId });
    expect(sweep.state.tasks[p.taskId]).toMatchObject({ state: 'rejected', reason: 'expired' });
    expect(verbs(sweep.outgoing)).toEqual(['meeting/decline']);
    expect(expire(sweep.state, { now: late }).outgoing).toEqual([]);
    // Nothing due: nothing happens.
    expect(expire(omer.state, { now: NOW }).state).toEqual(omer.state);
    expect(() => propose(omer.state, JOHN, ctxOf(omer), { expires: '2026-10-01T00:00:00Z' })).toThrow(/future/);
  });

  it('never mutates its input state', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0)] });
    const frozen = deepFreeze(emptyState());
    const p = propose(frozen, JOHN, ctxOf(omer));
    expect(frozen.tasks).toEqual({});
    const r = receive(deepFreeze(john.state), OMER, deepFreeze(p.outgoing[0].payload), ctxOf(john));
    expect(Object.keys(r.state.tasks)).toHaveLength(1);
    expect(john.state.tasks).toEqual({});
  });

  describe('peer-created state is bounded', () => {
    const cancelFor = (n: number, id = ids(9)): A2APayload => ({
      type: 'a2a/message',
      message: {
        kind: 'message',
        messageId: id(),
        taskId: `00000000-0000-4000-8a00-${String(n).padStart(12, '0')}`,
        contextId: `00000000-0000-4000-8b00-${String(n).padStart(12, '0')}`,
        role: 'agent',
        parts: [{ kind: 'data', data: { rdv: 'rdv/cancel' } }],
      },
    });

    it('a peer without a meeting grant cannot create tombstones', () => {
      const john = side(JOHN, 2, { scope: { may_initiate: true } });
      const r = receive(john.state, MALLORY, cancelFor(1), ctxOf(john));
      expect(r.state.tasks).toEqual({});
      expect(r.outgoing).toEqual([]);
      expect(r.events[0]).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/may_propose_meetings/) });
    });

    it('a cancel of an existing task is honored even after the grant lost meetings', () => {
      const omer = side(OMER, 1);
      const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
      const p = propose(omer.state, JOHN, ctxOf(omer));
      apply(john, receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)));
      const c = cancel(p.state, p.taskId, ctxOf(omer));
      const r = receive(john.state, OMER, c.outgoing[0].payload, { ...ctxOf(john), scope: {} });
      expect(r.state.tasks[p.taskId].state).toBe('canceled');
    });

    it('caps tasks per peer, evicting tombstones first, and refuses when all are pending', () => {
      const john = side(JOHN, 2);
      const newId = ids(9);
      let state = john.state;
      for (let n = 1; n <= MAX_TASKS_PER_PEER + 40; n++) state = receive(state, MALLORY, cancelFor(n, newId), ctxOf(john)).state;
      const mallory = Object.values(state.tasks).filter((t) => t.peer === MALLORY);
      expect(mallory).toHaveLength(MAX_TASKS_PER_PEER);
      // The newest tombstones survive.
      expect(mallory.some((t) => t.id.endsWith(String(MAX_TASKS_PER_PEER + 40).padStart(12, '0')))).toBe(true);

      // 32 pending proposals from one peer: the 33rd is refused and nothing is evicted.
      const omer = side(OMER, 1);
      let js = emptyState();
      for (let i = 0; i < MAX_TASKS_PER_PEER; i++) {
        const p = propose(emptyState(), JOHN, { ...ctxOf(omer), newId: ids(i + 10) });
        js = receive(js, OMER, p.outgoing[0].payload, { ...ctxOf(john), busy: [0, 1, 2].map((d) => evening(d)) }).state;
      }
      expect(Object.values(js.tasks).filter((t) => t.state === 'input-required')).toHaveLength(MAX_TASKS_PER_PEER);
      const extra = propose(emptyState(), JOHN, { ...ctxOf(omer), newId: ids(99) });
      const r = receive(js, OMER, extra.outgoing[0].payload, ctxOf(john));
      expect(r.state).toEqual(js);
      expect(r.outgoing).toEqual([]);
      expect(r.events[0]).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/too many/) });
      // Another peer is unaffected.
      expect(Object.keys(receive(js, MALLORY, cancelFor(1), ctxOf(john)).state.tasks)).toHaveLength(MAX_TASKS_PER_PEER + 1);
    });

    it('replays against a finished task are bounded: seen is capped and replies stop (security review L3)', () => {
      const omer = side(OMER, 1);
      const john = side(JOHN, 2);
      const { taskId, wire } = start(omer, john);
      expect(task(john, taskId).state).toBe('completed');
      const proposal = wire[0].payload as { type: string; message: { messageId: string } };
      let replies = 0;
      for (let i = 0; i < 200; i++) {
        const replay = { ...proposal, message: { ...proposal.message, messageId: `00000000-0000-4000-9000-${String(i).padStart(12, '0')}` } };
        const step = receive(john.state, OMER, replay, ctxOf(john));
        john.state = step.state;
        replies += step.outgoing.length;
      }
      expect(task(john, taskId).seen.length).toBeLessThanOrEqual(SEEN_PER_TASK);
      expect(replies).toBe(FINISHED_REPLIES);
    });

    it('garbage expires fails closed', () => {
      const omer = side(OMER, 1);
      expect(() => propose(omer.state, JOHN, ctxOf(omer), { expires: 'garbage' })).toThrow(NegotiationError);
      const john = side(JOHN, 2);
      const p = propose(omer.state, JOHN, ctxOf(omer));
      const payload = p.outgoing[0].payload as { message: { parts: Array<{ kind: string; data?: Record<string, unknown> }> } };
      const bad = structuredClone(payload);
      for (const part of bad.message.parts) if (part.kind === 'data') part.data!.expires = 'garbage';
      const step = receive(john.state, OMER, bad, ctxOf(john));
      expect(step.events[0].kind).toBe('invalid');
      // A stored task with an unreadable expires is expired by the next sweep, not kept forever.
      const stored = structuredClone(p.state);
      stored.tasks[p.taskId].expires = 'garbage';
      const swept = expire(stored, { now: NOW });
      expect(swept.state.tasks[p.taskId].state).toBe('rejected');
    });

    it('prunes finished tasks older than 30 days on any receive', () => {
      const john = side(JOHN, 2);
      const old = receive(john.state, MALLORY, cancelFor(1), ctxOf(john)).state;
      const later = new Date(NOW.getTime() + 31 * 86_400_000);
      // Even a garbage payload triggers the prune.
      const r = receive(old, MALLORY, { nonsense: true }, { ...ctxOf(john, later) });
      expect(r.state.tasks).toEqual({});
    });

    it('defaults and clamps peer-supplied expires', () => {
      const omer = side(OMER, 1);
      const john = side(JOHN, 2, { busy: [0, 1, 2].map((d) => evening(d)) });
      const p = propose(omer.state, JOHN, ctxOf(omer), { expires: '2027-06-01T00:00:00Z' });
      const r = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
      expect(r.state.tasks[p.taskId].expires).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
      // Without expires: 48 h.
      const m = structuredClone(p.outgoing[0].payload) as Extract<A2APayload, { type: 'a2a/message' }>;
      delete (m.message.parts[1] as { data: { expires?: string } }).data.expires;
      m.message.taskId = '00000000-0000-4000-8c00-000000000001';
      const r2 = receive(john.state, OMER, m, ctxOf(john));
      expect(r2.state.tasks[m.message.taskId].expires).toBe(new Date(NOW.getTime() + 48 * 3_600_000).toISOString());
    });
  });

  describe('human confirmation and the accept → confirm handshake (issues #5, #8)', () => {
    it('nothing is accepted or confirmed until each human confirms', () => {
      const omer = side(OMER, 1, { autoConfirm: false });
      const john = side(JOHN, 2, { autoConfirm: false, busy: [evening(0)] });
      const p = propose(omer.state, JOHN, ctxOf(omer));
      apply(omer, p);
      // John's agent picks Tuesday but only holds it tentatively: no accept goes out.
      const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
      apply(john, j);
      expect(j.outgoing).toEqual([]);
      expect(j.events.map((e) => e.kind)).toEqual(['offer-received', 'confirm-needed']);
      expect(j.effects).toEqual([expect.objectContaining({ kind: 'hold', tentative: true, slot: evening(1, 19, 21) })]);
      expect(awaitingHuman(task(john, p.taskId))).toBe(true);
      // The peer-confirm stage and finished tasks have nothing for the human to confirm.
      expect(() => confirmMeeting(omer.state, p.taskId, ctxOf(omer))).toThrow(/no meeting waiting/);
      expect(() => confirmMeeting(omer.state, '00000000-0000-4000-8000-00000000beef', ctxOf(omer))).toThrow(/no negotiation/);

      // John's human confirms: now the accept goes out.
      const jc = confirmMeeting(john.state, p.taskId, ctxOf(john));
      apply(john, jc);
      expect(verbs(jc.outgoing)).toEqual(['meeting/accept']);
      expect(task(john, p.taskId).hold?.stage).toBe('peer-confirm');
      expect(() => confirmMeeting(john.state, p.taskId, ctxOf(john))).toThrow(/waiting for the peer/);

      // Omer's agent gets the accept: tentative hold, waits for Omer.
      const o = receive(omer.state, JOHN, jc.outgoing[0].payload, ctxOf(omer));
      apply(omer, o);
      expect(o.outgoing).toEqual([]);
      expect(o.events.map((e) => e.kind)).toEqual(['confirm-needed']);
      expect(task(omer, p.taskId).state).toBe('submitted');
      const oc = confirmMeeting(omer.state, p.taskId, ctxOf(omer));
      apply(omer, oc);
      expect(verbs(oc.outgoing)).toEqual(['meeting/confirm']);
      expect(task(omer, p.taskId).state).toBe('completed');
      apply(john, receive(john.state, OMER, oc.outgoing[0].payload, ctxOf(john)));
      for (const s of [omer, john]) {
        expect(task(s, p.taskId)).toMatchObject({ state: 'completed', agreed: evening(1, 19, 21) });
        expect(s.holds).toEqual([evening(1, 19, 21)]);
      }
      expect(() => confirmMeeting(john.state, p.taskId, ctxOf(john))).toThrow(/already completed/);
    });

    it('consent is bound to the reviewed meeting: a peer re-proposing under the same task ID gets a refusal', () => {
      const omer = side(OMER, 1, { autoConfirm: false });
      const john = side(JOHN, 2, { autoConfirm: false, busy: [evening(0)] });
      const p = propose(omer.state, JOHN, ctxOf(omer));
      apply(john, receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)));
      // John's human is shown Tuesday (an approval form, or a phrase for it).
      const reviewed = meetingSnapshot(task(john, p.taskId))!;
      expect(reviewed).toMatchObject({ taskId: p.taskId, peer: OMER, stage: 'human-accept', start: evening(1, 19, 21).start });

      // Meanwhile the peer cancels, pushes the canceled task out of John's per-peer cap
      // with finished filler tasks, and proposes again under the same task ID: another evening.
      const later = new Date(NOW.getTime() + 60_000);
      apply(john, receive(john.state, OMER, cancel(p.state, p.taskId, ctxOf(omer)).outgoing[0].payload, ctxOf(john)));
      const allBusy = { ...ctxOf(john, later), busy: [{ start: '2026-10-26T00:00:00+02:00', end: '2026-11-02T00:00:00+02:00' }] };
      for (let i = 0; i < MAX_TASKS_PER_PEER; i++) {
        const f = propose(emptyState(), JOHN, { ...ctxOf(omer), newId: ids(i + 10) });
        apply(john, receive(john.state, OMER, f.outgoing[0].payload, allBusy)); // declined: nothing free
      }
      expect(john.state.tasks[p.taskId]).toBeUndefined(); // evicted
      const again = structuredClone(p.outgoing[0].payload) as Extract<A2APayload, { type: 'a2a/message' }>;
      again.message.messageId = '00000000-0000-4000-9999-000000000001';
      (again.message.parts[1] as { data: { slots: Slot[] } }).data.slots = [evening(3, 19, 21)];
      apply(john, receive(john.state, OMER, again, ctxOf(john, later)));
      const now = task(john, p.taskId);
      expect(now.hold).toMatchObject({ stage: 'human-accept', slot: evening(3, 19, 21) });
      expect(sameMeeting(meetingSnapshot(now), reviewed)).toBe(false);

      // The old approval lands on nothing: refused, no accept sent, the new hold stays for review.
      expect(() => confirmMeeting(john.state, p.taskId, ctxOf(john, later), reviewed)).toThrow(MeetingChangedError);
      expect(task(john, p.taskId).hold?.stage).toBe('human-accept');
      // Approving what is held now works.
      const ok = confirmMeeting(john.state, p.taskId, ctxOf(john, later), meetingSnapshot(now));
      expect(verbs(ok.outgoing)).toEqual(['meeting/accept']);
      expect(ok.outgoing[0].payload).toMatchObject({ message: { parts: expect.arrayContaining([{ kind: 'data', data: expect.objectContaining({ slot: evening(3, 19, 21) }) }]) } });
    });

    it('a changed slot, stage, peer or task creation time is a different meeting', () => {
      const base = { taskId: 't', peer: OMER, contextId: 'c', created: NOW.toISOString(), stage: 'human-accept' as const, start: 'a', end: 'b', place: null };
      expect(sameMeeting(base, { ...base })).toBe(true);
      for (const k of ['taskId', 'peer', 'contextId', 'created', 'start', 'end'] as const) expect(sameMeeting(base, { ...base, [k]: 'x' })).toBe(false);
      expect(sameMeeting(base, { ...base, stage: 'human-confirm' })).toBe(false);
      expect(sameMeeting(base, { ...base, place: '{"name":"x"}' })).toBe(false);
      expect(sameMeeting(base, undefined)).toBe(false);
    });

    it('a cancel racing the accept releases the holds on both sides', () => {
      const omer = side(OMER, 1, { autoConfirm: false });
      const john = side(JOHN, 2, { busy: [evening(0)] });
      const p = propose(omer.state, JOHN, ctxOf(omer));
      apply(omer, p);
      const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)); // John accepts, holds Tuesday
      apply(john, j);
      expect(john.holds).toEqual([evening(1, 19, 21)]);
      // Omer cancels before the accept lands; the two cross on the wire.
      const c = cancel(omer.state, p.taskId, ctxOf(omer), 'change of plans');
      apply(omer, c);
      const wire = run(omer, john, [...j.outgoing, ...c.outgoing]);
      expect(verbs(wire)).toEqual(['meeting/accept', 'rdv/cancel', 'update:canceled', 'update:canceled']);
      for (const s of [omer, john]) {
        expect(task(s, p.taskId).state).toBe('canceled');
        expect(task(s, p.taskId).hold).toBeUndefined();
        expect(s.holds).toEqual([]);
      }
      expect(john.events.map((e) => e.kind)).toContain('released');

      // Same race, with Omer's human sitting on the accept: his cancel releases his tentative hold too.
      const omer2 = side(OMER, 3, { autoConfirm: false });
      const john2 = side(JOHN, 4, { busy: [evening(0)] });
      const p2 = propose(omer2.state, JOHN, ctxOf(omer2));
      apply(omer2, p2);
      run(omer2, john2, p2.outgoing);
      expect(omer2.holds).toEqual([evening(1, 19, 21)]);
      expect(john2.holds).toEqual([evening(1, 19, 21)]);
      const c2 = cancel(omer2.state, p2.taskId, ctxOf(omer2));
      apply(omer2, c2);
      run(omer2, john2, c2.outgoing);
      expect([omer2.holds, john2.holds]).toEqual([[], []]);

      // The cancel is lost; the status update answering the late accept still releases John's hold.
      const omer3 = side(OMER, 5);
      const john3 = side(JOHN, 6, { busy: [evening(0)] });
      const p3 = propose(omer3.state, JOHN, ctxOf(omer3));
      apply(omer3, p3);
      const j3 = receive(john3.state, OMER, p3.outgoing[0].payload, ctxOf(john3));
      apply(john3, j3);
      apply(omer3, cancel(omer3.state, p3.taskId, ctxOf(omer3))); // never delivered
      const o3 = receive(omer3.state, JOHN, j3.outgoing[0].payload, ctxOf(omer3));
      expect(verbs(o3.outgoing)).toEqual(['update:canceled']);
      apply(john3, receive(john3.state, OMER, o3.outgoing[0].payload, ctxOf(john3)));
      expect(task(john3, p3.taskId).state).toBe('canceled');
      expect(john3.holds).toEqual([]);
    });

    it('expiry racing the accept: a late accept is declined and the accepter releases', () => {
      const omer = side(OMER, 1);
      const john = side(JOHN, 2, { busy: [evening(0)] });
      const p = propose(omer.state, JOHN, ctxOf(omer), { expires: '2026-10-25T12:00:00Z' });
      apply(omer, p);
      const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)); // in time
      apply(john, j);
      const late = new Date('2026-10-25T13:00:00Z');
      const wire = run(omer, john, j.outgoing, late);
      expect(verbs(wire)).toEqual(['meeting/accept', 'meeting/decline']);
      expect([task(omer, p.taskId).state, task(john, p.taskId).state]).toEqual(['rejected', 'rejected']);
      expect([omer.holds, john.holds]).toEqual([[], []]);
      // An accepter whose confirm never comes gives up CONFIRM_GRACE_MS after expires.
      const john2 = side(JOHN, 3, { busy: [evening(0)] });
      apply(john2, receive(john2.state, OMER, p.outgoing[0].payload, ctxOf(john2)));
      const exp = Date.parse('2026-10-25T12:00:00Z');
      expect(expire(john2.state, { now: new Date(exp + 60_000) }).state).toEqual(john2.state);
      const swept = expire(john2.state, { now: new Date(exp + CONFIRM_GRACE_MS + 60_000), newId: john2.newId });
      apply(john2, swept);
      expect(task(john2, p.taskId)).toMatchObject({ state: 'rejected', reason: 'expired' });
      expect(swept.effects).toEqual([expect.objectContaining({ kind: 'release', slot: evening(1, 19, 21) })]);
      expect(john2.holds).toEqual([]);
    });

    it('two concurrent negotiations cannot book the same slot', () => {
      // Omer proposes to John and to Mallory with the same three evenings.
      const omer = side(OMER, 1);
      const john = side(JOHN, 2, { busy: [evening(0)] });
      const mallory = side(MALLORY, 3, { busy: [evening(0)] });
      const pj = propose(omer.state, JOHN, ctxOf(omer));
      apply(omer, pj);
      const pm = propose(omer.state, MALLORY, ctxOf(omer));
      apply(omer, pm);
      expect(task(omer, pm.taskId).ourOffers[0]).toEqual(task(omer, pj.taskId).ourOffers[0]); // offers are not held
      const aj = receive(john.state, OMER, pj.outgoing[0].payload, ctxOf(john));
      const am = receive(mallory.state, OMER, pm.outgoing[0].payload, ctxOf(mallory));
      apply(john, aj);
      apply(mallory, am);
      // Both accept Tuesday 19:00. John's accept lands first and wins; Mallory's is declined.
      const oj = receive(omer.state, JOHN, aj.outgoing[0].payload, ctxOf(omer));
      apply(omer, oj);
      const om = receive(omer.state, MALLORY, am.outgoing[0].payload, ctxOf(omer));
      apply(omer, om);
      expect(verbs(oj.outgoing)).toEqual(['meeting/confirm']);
      expect(om.events.map((e) => `${e.kind}:${e.reason ?? ''}`)).toEqual(['rejected:that time is no longer free']);
      apply(mallory, receive(mallory.state, OMER, om.outgoing[0].payload, ctxOf(mallory)));
      expect(task(mallory, pm.taskId).state).toBe('rejected');
      expect(mallory.holds).toEqual([]);
      expect(omer.holds).toEqual([evening(1, 19, 21)]);

      // On the accepting side too: a slot held tentatively for one task is busy for the next.
      const pending = side(JOHN, 4, { autoConfirm: false, busy: [evening(0)] });
      const fromOmer = propose(emptyState(), JOHN, { ...ctxOf(side(OMER, 5)), busy: [] });
      const fromMallory = propose(emptyState(), JOHN, { ...ctxOf(side(MALLORY, 6)), busy: [] });
      apply(pending, receive(pending.state, OMER, fromOmer.outgoing[0].payload, ctxOf(pending)));
      apply(pending, receive(pending.state, MALLORY, fromMallory.outgoing[0].payload, ctxOf(pending)));
      const picked = Object.values(pending.state.tasks).map((t) => t.hold?.slot);
      expect(picked).toEqual([evening(1, 19, 21), evening(2, 19, 21)]);
      expect(pending.holds).toHaveLength(2);
    });
  });

  it('refuses to propose with nothing free', () => {

    const omer = side(OMER, 1, { busy: [{ start: '2026-10-26T00:00:00+02:00', end: '2026-11-02T00:00:00+02:00' }] });
    expect(() => propose(omer.state, JOHN, ctxOf(omer))).toThrow(/no free slot/);
  });
});

describe('canceling an agreed meeting (issue #20)', () => {
  type Msg = Extract<A2APayload, { type: 'a2a/message' }>;
  const agreed = () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0)] });
    const { taskId } = start(omer, john);
    expect([task(omer, taskId).state, task(john, taskId).state]).toEqual(['completed', 'completed']);
    return { omer, john, taskId, slot: evening(1, 19, 21) };
  };

  it('either human cancels: both release the final hold, the peer gets a distinct event, both end canceled', () => {
    const { omer, john, taskId, slot } = agreed();
    const c = cancelMeeting(omer.state, taskId, ctxOf(omer), { reason: 'I am sick' });
    expect(verbs(c.outgoing)).toEqual(['meeting/cancel']);
    expect((c.outgoing[0].payload as Msg).message.parts).toContainEqual({ kind: 'data', data: { rdv: 'meeting/cancel', slot, reason: 'I am sick' } });
    expect(c.effects).toEqual([{ kind: 'release', taskId, peer: JOHN, slot, tentative: false }]);
    expect(c.events).toEqual([expect.objectContaining({ kind: 'meeting-canceled', taskId, slot, state: 'canceled' })]);
    apply(omer, c);
    expect(task(omer, taskId)).toMatchObject({ state: 'canceled', agreed: slot, reason: 'I am sick' });
    expect(omer.holds).toEqual([]);

    const wire = run(omer, john, c.outgoing);
    expect(verbs(wire)).toEqual(['meeting/cancel', 'update:canceled']);
    expect(task(john, taskId)).toMatchObject({ state: 'canceled', agreed: slot, reason: 'I am sick' });
    expect(john.holds).toEqual([]);
    expect(john.events.at(-1)).toMatchObject({ kind: 'meeting-canceled', taskId, peer: OMER, slot, reason: 'I am sick' });
    expect(task(omer, taskId).peerState).toBe('canceled');

    // The responder's human can cancel too.
    const b = agreed();
    const jc = cancelMeeting(b.john.state, b.taskId, ctxOf(b.john));
    apply(b.john, jc);
    run(b.john, b.omer, jc.outgoing);
    expect([task(b.omer, b.taskId).state, task(b.john, b.taskId).state]).toEqual(['canceled', 'canceled']);
    expect([b.omer.holds, b.john.holds]).toEqual([[], []]);
    expect(task(b.omer, b.taskId).reason).toBe('canceled by peer');
  });

  it('drops a cancel from a stranger, for another task, context or slot, or for a meeting not agreed', () => {
    const { omer, john, taskId } = agreed();
    const good = cancelMeeting(omer.state, taskId, ctxOf(omer)).outgoing[0].payload as Msg;
    const forge = (f: (m: Msg) => void): Msg => {
      const x = structuredClone(good);
      x.message.messageId = john.newId();
      f(x);
      return x;
    };
    const setSlot = (s: Slot) => (m: Msg) => {
      (m.message.parts[1] as { data: { slot: Slot } }).data.slot = s;
    };
    const cases: Array<[string, unknown, string]> = [
      [MALLORY, good, 'task belongs to another peer'],
      [OMER, forge((m) => (m.message.taskId = '00000000-0000-4000-8fff-000000000001')), 'meeting/cancel for an unknown task'],
      [OMER, forge((m) => (m.message.contextId = '00000000-0000-4000-8fff-000000000002')), 'contextId does not match the task'],
      [OMER, forge(setSlot(evening(2, 19, 21))), 'meeting/cancel of a slot we did not agree'],
      [OMER, forge(setSlot({ start: '2026-10-27T17:00:00Z', end: '2026-10-27T20:00:00Z' })), 'meeting/cancel of a slot we did not agree'],
    ];
    for (const [from, payload, why] of cases) {
      const r = receive(deepFreeze(john.state), from, payload, ctxOf(john));
      expect(r.events).toEqual([expect.objectContaining({ kind: 'invalid', reason: why })]);
      expect([r.outgoing, r.effects]).toEqual([[], []]);
      expect(r.state.tasks[taskId].state).toBe('completed');
    }
    // The same slot in another offset is the same instant: honored.
    const shifted = forge(setSlot({ start: '2026-10-27T17:00:00Z', end: '2026-10-27T19:00:00Z' }));
    expect(receive(john.state, OMER, shifted, ctxOf(john)).state.tasks[taskId].state).toBe('canceled');

    // A pending task is not an agreed meeting: meeting/cancel is refused (rdv/cancel is the verb there).
    const pend = side(OMER, 3);
    const jp = side(JOHN, 4, { autoConfirm: false });
    const p = propose(pend.state, JOHN, ctxOf(pend));
    apply(jp, receive(jp.state, OMER, p.outgoing[0].payload, ctxOf(jp)));
    expect(task(jp, p.taskId).hold?.stage).toBe('human-accept');
    const early = structuredClone(good);
    early.message = { ...early.message, taskId: p.taskId, contextId: (p.outgoing[0].payload as Msg).message.contextId };
    const r = receive(jp.state, OMER, early, ctxOf(jp));
    expect(r.events).toEqual([expect.objectContaining({ kind: 'invalid', reason: 'meeting/cancel for a meeting that is not agreed (use rdv/cancel)' })]);
    expect(r.state.tasks[p.taskId].hold?.stage).toBe('human-accept');
  });

  it('is idempotent and replay-safe: a duplicate is a no-op, and an old cancel never touches a later meeting in the same slot', () => {
    const { omer, john, taskId, slot } = agreed();
    const c = cancelMeeting(omer.state, taskId, ctxOf(omer));
    apply(omer, c);
    run(omer, john, c.outgoing);
    expect(john.holds).toEqual([]);

    // Renegotiated: a new task agrees on the same evening.
    const again = start(omer, john);
    expect(again.taskId).not.toBe(taskId);
    expect(task(john, again.taskId)).toMatchObject({ state: 'completed', agreed: slot });
    expect(john.holds).toEqual([slot]);

    // The old cancel re-sent as is (same messageId): a duplicate.
    const dup = receive(deepFreeze(john.state), OMER, c.outgoing[0].payload, ctxOf(john));
    expect(dup.events.map((e) => e.kind)).toEqual(['duplicate']);
    expect([dup.outgoing, dup.effects]).toEqual([[], []]);
    // ...and with a fresh messageId: the old task is already canceled, so nothing to undo; it says so once.
    const fresh = structuredClone(c.outgoing[0].payload) as Msg;
    fresh.message.messageId = '00000000-0000-4000-9999-000000000003';
    const re = receive(deepFreeze(john.state), OMER, fresh, ctxOf(john));
    expect(re.events).toEqual([expect.objectContaining({ kind: 'ignored', reason: 'meeting/cancel after canceled' })]);
    expect(re.effects).toEqual([]);
    expect(verbs(re.outgoing)).toEqual(['update:canceled']);
    expect(re.state.tasks[again.taskId]).toEqual(john.state.tasks[again.taskId]);
    // Our own second cancel is refused before anything is sent.
    expect(() => cancelMeeting(omer.state, taskId, ctxOf(omer))).toThrow(/already canceled/);
  });

  it('cancel before completion still goes through rdv/cancel; meeting/cancel needs an agreement', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { autoConfirm: false, busy: [evening(0)] });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    apply(john, receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)));
    expect(() => cancelMeeting(omer.state, p.taskId, ctxOf(omer))).toThrow(/no agreed meeting to cancel/);
    expect(() => cancelMeeting(john.state, p.taskId, ctxOf(john))).toThrow(/no agreed meeting to cancel/);
    expect(() => cancelMeeting(omer.state, '00000000-0000-4000-8fff-000000000009', ctxOf(omer))).toThrow(/no negotiation/);
    const c = cancel(john.state, p.taskId, ctxOf(john));
    expect(verbs(c.outgoing)).toEqual(['rdv/cancel']);
    expect(c.effects).toEqual([expect.objectContaining({ kind: 'release', tentative: true })]);
    // And rdv/cancel still does not end an agreed meeting.
    const { omer: o2, taskId } = agreed();
    expect(() => cancel(o2.state, taskId, ctxOf(o2))).toThrow(/already completed/);
  });

  it('is honored after the grant lost meetings (it only frees time), and binds to the agreement the human reviewed', () => {
    const { omer, john, taskId } = agreed();
    const reviewed = agreedSnapshot(task(omer, taskId))!;
    expect(reviewed).toMatchObject({ taskId, peer: JOHN, stage: 'agreed', start: evening(1, 19, 21).start });
    expect(meetingSnapshot(task(omer, taskId))).toBeUndefined(); // nothing to confirm
    expect(() => cancelMeeting(omer.state, taskId, ctxOf(omer), { expected: { ...reviewed, start: evening(2, 19, 21).start } })).toThrow(MeetingChangedError);
    expect(() => cancelMeeting(omer.state, taskId, ctxOf(omer), { expected: { ...reviewed, stage: 'human-confirm' } })).toThrow(MeetingChangedError);
    const c = cancelMeeting(omer.state, taskId, ctxOf(omer), { expected: reviewed });
    apply(omer, c);
    expect(agreedSnapshot(task(omer, taskId))).toBeUndefined();
    const r = receive(john.state, OMER, c.outgoing[0].payload, { ...ctxOf(john), scope: { may_propose_meetings: false } });
    expect(r.state.tasks[taskId].state).toBe('canceled');
  });

  it('a peer reporting canceled for a meeting we completed releases it (the confirm crossed its owner’s cancel)', () => {
    const omer = side(OMER, 1, { autoConfirm: false });
    const john = side(JOHN, 2, { busy: [evening(0)] });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john)); // accept: John holds, waits for the confirm
    apply(john, j);
    apply(omer, receive(omer.state, JOHN, j.outgoing[0].payload, ctxOf(omer)));
    const cm = confirmMeeting(omer.state, p.taskId, ctxOf(omer)); // Omer's human confirms...
    apply(omer, cm);
    const jc = cancel(john.state, p.taskId, ctxOf(john)); // ...while John's cancels
    apply(john, jc);
    const wire = run(omer, john, [...cm.outgoing, ...jc.outgoing]);
    expect(verbs(wire)).toEqual(['meeting/confirm', 'rdv/cancel', 'update:canceled', 'update:completed']);
    expect([task(omer, p.taskId).state, task(john, p.taskId).state]).toEqual(['canceled', 'canceled']);
    expect([omer.holds, john.holds]).toEqual([[], []]);
    expect(omer.events.find((e) => e.kind === 'meeting-canceled')).toMatchObject({ reason: 'peer reports canceled' });
  });
});

describe('extensions (SPEC §7.5, issue #4)', () => {
  type Msg = Extract<A2APayload, { type: 'a2a/message' }>;
  type Upd = Extract<A2APayload, { type: 'a2a/task-update' }>;
  const agreed = () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0)] });
    const { taskId, wire } = start(omer, john);
    expect([task(omer, taskId).state, task(john, taskId).state]).toEqual(['completed', 'completed']);
    return { omer, john, taskId, wire };
  };
  /** A message as a peer running some later version would send it. */
  const future = (data: Record<string, unknown>, ids: { taskId: string; contextId: string; messageId?: string }): Msg => ({
    type: 'a2a/message',
    message: {
      kind: 'message',
      messageId: ids.messageId ?? '00000000-0000-4000-8eee-000000000001',
      taskId: ids.taskId,
      contextId: ids.contextId,
      role: 'agent',
      parts: [
        { kind: 'text', text: 'Can we move it?' },
        { kind: 'data', data: data as never },
      ],
      extensions: ['https://rendezvous.nesher.co/ext/meeting-reschedule/v1'],
    },
  });

  it('every message names the extension of its verb', () => {
    const { wire } = agreed();
    for (const o of wire) {
      if (o.payload.type !== 'a2a/message') continue;
      const verb = (o.payload.message.parts.find((p) => p.kind === 'data') as { data: { rdv: Verb } }).data.rdv;
      expect(o.payload.message.extensions).toEqual([VERB_EXTENSION[verb]]);
    }
    const { omer, taskId } = agreed();
    const c = cancelMeeting(omer.state, taskId, ctxOf(omer));
    expect((c.outgoing[0].payload as Msg).message.extensions).toEqual([EXTENSIONS.meetingCancel]);
  });

  it('an old-style peer gets meeting/cancel, answers unsupported, and the sender learns it (NOTES 61 open item)', () => {
    const { omer, john, taskId } = agreed();
    // John's agent predates meeting/cancel: it supports only the base meeting extension.
    const oldJohn = { ...ctxOf(john), extensions: [EXTENSIONS.meeting] };
    const c = cancelMeeting(omer.state, taskId, ctxOf(omer));
    apply(omer, c);
    const r = receive(john.state, OMER, c.outgoing[0].payload, oldJohn);
    apply(john, r);
    // John keeps the meeting (he cannot honor the verb), but says so instead of dropping it.
    expect(task(john, taskId).state).toBe('completed');
    expect(r.effects).toEqual([]);
    expect(r.events).toEqual([expect.objectContaining({ kind: 'invalid', taskId, reason: expect.stringMatching(/unsupported verb "meeting\/cancel"/) })]);
    expect(r.outgoing).toHaveLength(1);
    const reply = r.outgoing[0].payload as Upd;
    expect(reply.update).toMatchObject({ taskId, contextId: task(john, taskId).contextId, status: { state: 'completed' }, final: true });
    expect(reply.update.metadata).toEqual({ [UNSUPPORTED_KEY]: { messageId: (c.outgoing[0].payload as Msg).message.messageId, verb: 'meeting/cancel' } });
    // A pre-§7.5 parser accepts the reply too: metadata is free-form there.
    expect(parsePayload(reply, { extensions: [EXTENSIONS.meeting] }).ok).toBe(true);

    const back = receive(omer.state, JOHN, reply, ctxOf(omer));
    apply(omer, back);
    expect(back.events).toContainEqual(
      expect.objectContaining({ kind: 'unsupported', taskId, peer: JOHN, reason: "the peer's agent does not support meeting/cancel" }),
    );
    expect(task(omer, taskId)).toMatchObject({ state: 'canceled', peerState: 'completed' });
    expect(back.outgoing).toEqual([]); // updates are never answered: no loop
  });

  it('capability discovery: the peer card says up front whether meeting/cancel will be understood', () => {
    expect(cardCapabilities()).toEqual(['rdv/v1', 'a2a/0.3', EXTENSIONS.meeting, EXTENSIONS.meetingCancel]);
    expect(SUPPORTED_EXTENSIONS).toEqual([EXTENSIONS.meeting, EXTENSIONS.meetingCancel]);
    expect(peerAdvertises(cardCapabilities(), 'meeting/cancel')).toBe(true);
    expect(peerAdvertises(cardCapabilities([EXTENSIONS.meeting]), 'meeting/cancel')).toBe(false);
    expect(peerAdvertises(cardCapabilities([EXTENSIONS.meeting]), 'meeting/propose')).toBe(true);
    expect(peerAdvertises(['rdv/v1', 'a2a/0.3'], 'meeting/propose')).toBe(false); // a card from before §7.5 advertises nothing
    expect(peerAdvertises(undefined, 'meeting/cancel')).toBe(false);

    const { omer, taskId } = agreed();
    const legacy = cancelMeeting(omer.state, taskId, ctxOf(omer), { peerCapabilities: ['rdv/v1', 'a2a/0.3'] });
    expect(legacy.events.map((e) => e.kind)).toEqual(['meeting-canceled', 'unsupported']);
    expect(legacy.events[1]).toMatchObject({ taskId, peer: JOHN, state: 'canceled', reason: expect.stringMatching(/does not advertise meeting\/cancel/) });
    expect(verbs(legacy.outgoing)).toEqual(['meeting/cancel']); // still sent: harmless, and a newer agent honors it
    for (const peerCapabilities of [cardCapabilities(), undefined]) {
      expect(cancelMeeting(omer.state, taskId, ctxOf(omer), { peerCapabilities }).events.map((e) => e.kind)).toEqual(['meeting-canceled']);
    }
  });

  it('a verb from the future is answered unsupported, only to its own peer and bounded', () => {
    const { omer, john, taskId } = agreed();
    const contextId = task(john, taskId).contextId;
    const m = future({ rdv: 'meeting/reschedule', slot: evening(2, 19, 21) }, { taskId, contextId });
    const r = receive(john.state, OMER, m, ctxOf(john));
    expect(r.outgoing).toHaveLength(1);
    expect((r.outgoing[0].payload as Upd).update).toMatchObject({ status: { state: 'completed' }, metadata: { [UNSUPPORTED_KEY]: { verb: 'meeting/reschedule' } } });
    expect(r.state.tasks[taskId].state).toBe('completed');
    // The sender's notice names only verbs it knows; an echo of another verb gets a generic reason.
    const back = receive(omer.state, JOHN, r.outgoing[0].payload, ctxOf(omer));
    expect(back.events).toContainEqual(expect.objectContaining({ kind: 'unsupported', reason: "the peer's agent does not support one of our messages" }));

    // Another peer naming this task, or the right peer with another context: no reply.
    expect(receive(john.state, MALLORY, m, ctxOf(john)).outgoing).toEqual([]);
    expect(receive(john.state, OMER, future({ rdv: 'meeting/reschedule' }, { taskId, contextId: john.newId() }), ctxOf(john)).outgoing).toEqual([]);
    // A task we do not have: `rejected`, but only within a meeting-capable grant.
    const fresh = { taskId: john.newId(), contextId: john.newId() };
    const u = receive(john.state, OMER, future({ rdv: 'meeting/poll', options: [] }, fresh), ctxOf(john));
    expect((u.outgoing[0].payload as Upd).update).toMatchObject({ ...fresh, status: { state: 'rejected' }, final: true });
    expect(u.state.tasks[fresh.taskId]).toBeUndefined(); // no state for a stranger's task
    expect(receive(john.state, OMER, future({ rdv: 'meeting/poll' }, fresh), { ...ctxOf(john), scope: { may_propose_meetings: false } }).outgoing).toEqual([]);
    // Replays are capped per task.
    let s = john.state;
    let sent = 0;
    for (let i = 0; i < FINISHED_REPLIES + 5; i++) {
      const step = receive(s, OMER, future({ rdv: 'meeting/reschedule' }, { taskId, contextId, messageId: john.newId() }), ctxOf(john));
      s = step.state;
      sent += step.outgoing.length;
    }
    expect(sent).toBe(FINISHED_REPLIES);
  });

  it('unknown critical fields reject as unsupported; malformed input is still dropped silently', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2);
    const p = propose(omer.state, JOHN, ctxOf(omer));
    const good = p.outgoing[0].payload as Msg;
    const withData = (f: (d: Record<string, unknown>) => void): Msg => {
      const x = structuredClone(good);
      f((x.message.parts.find((q) => q.kind === 'data') as { data: Record<string, unknown> }).data);
      return x;
    };
    // An unknown key in `data` changes the meaning, so it is critical: refused, and the sender is told.
    for (const m of [
      withData((d) => (d.recurrence = 'weekly')),
      withData((d) => (d.place = { name: 'Cafe', address: 'Main St 1' })),
      withData((d) => ((d.slots as Record<string, unknown>[])[0].tz = 'Asia/Jerusalem')),
    ]) {
      const r = receive(john.state, OMER, m, ctxOf(john));
      expect(r.events).toEqual([expect.objectContaining({ kind: 'invalid', reason: expect.stringMatching(/unknown field/) })]);
      expect(r.state.tasks).toEqual({});
      expect(r.outgoing).toEqual([expect.objectContaining({ payload: expect.objectContaining({ type: 'a2a/task-update' }) })]);
      expect((r.outgoing[0].payload as Upd).update.metadata).toEqual({ [UNSUPPORTED_KEY]: { messageId: good.message.messageId, verb: 'meeting/propose' } });
    }
    // Malformed (a missing field, a bad slot, a bad id): no reply, as before.
    for (const m of [
      withData((d) => delete d.slots),
      withData((d) => (d.expires = 'tomorrow')),
      { ...good, message: { ...good.message, taskId: 'not-a-uuid' } },
    ]) {
      const r = receive(john.state, OMER, m, ctxOf(john));
      expect(r.events.map((e) => e.kind)).toEqual(['invalid']);
      expect(r.outgoing).toEqual([]);
    }
  });

  it('unknown ignorable fields are accepted: metadata anywhere and unknown extension URIs', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0)] });
    const p = propose(omer.state, JOHN, ctxOf(omer));
    apply(omer, p);
    const m = structuredClone(p.outgoing[0].payload as Msg);
    const ext = 'https://rendezvous.nesher.co/ext/dress-code/v1';
    m.message.extensions = [...(m.message.extensions ?? []), ext];
    m.message.metadata = { [ext]: { code: 'smart casual' } };
    for (const part of m.message.parts) part.metadata = { [`${ext}/hint`]: [1, 2, 3] };
    const r = receive(john.state, OMER, m, ctxOf(john));
    apply(john, r);
    expect(r.events.map((e) => e.kind)).toEqual(['offer-received', 'accepted']);
    // The rest of the negotiation runs as usual, and update metadata we do not know is ignored too.
    const back = r.outgoing.map((o) => o.payload);
    const confirm = receive(omer.state, JOHN, back[0], ctxOf(omer));
    apply(omer, confirm);
    const done = receive(john.state, OMER, confirm.outgoing[0].payload, ctxOf(john));
    apply(john, done);
    const ack = structuredClone(done.outgoing[0].payload as Upd);
    ack.update.metadata = { [ext]: { seen: true }, [UNSUPPORTED_KEY]: 'not a notice' };
    const last = receive(omer.state, JOHN, ack, ctxOf(omer));
    expect(last.events.map((e) => e.kind)).toEqual(['status']);
    expect([task(omer, p.taskId).state, task(john, p.taskId).state]).toEqual(['completed', 'completed']);
  });
});

// Property-style: random calendars, both sides end in the same terminal state,
// and an agreement is free for both and inside both windows.
describe('negotiation invariants over random calendars', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const randomBusy = (r: () => number): Slot[] => {
    const out: Slot[] = [];
    for (let d = 0; d < 7; d++) for (const h of [19, 20, 21, 22]) if (r() < 0.55) out.push(evening(d, h, h + 1));
    return out;
  };

  it('holds for 300 random pairs', () => {
    const r = rng(42);
    const outcomes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const omer = side(OMER, 1, { busy: randomBusy(r) });
      const john = side(JOHN, 2, { busy: randomBusy(r) });
      let started;
      try {
        started = start(omer, john);
      } catch (err) {
        expect(err).toBeInstanceOf(NegotiationError);
        continue;
      }
      const { taskId, wire } = started;
      const a = task(omer, taskId);
      const b = task(john, taskId);
      expect(a.state).toBe(b.state);
      expect(['completed', 'rejected']).toContain(a.state);
      expect(a.round).toBeLessThanOrEqual(3);
      outcomes.add(`${a.state}@${a.round}`);
      for (const o of wire) {
        if (o.payload.type !== 'a2a/message') continue;
        const data = (o.payload.message.parts.find((p) => p.kind === 'data') as { data: { slots?: Slot[] } }).data;
        if (data.slots) expect(data.slots.length).toBeLessThanOrEqual(3);
      }
      if (a.state === 'completed') {
        const s = toSpan(a.agreed!);
        expect(toSpan(b.agreed!)).toEqual(s);
        for (const x of [omer, john]) {
          expect(x.busy.some((bz) => toSpan(bz).start < s.end && s.start < toSpan(bz).end)).toBe(false);
          expect(x.window.some((w) => w.start <= s.start && s.end <= w.end)).toBe(true);
          expect(x.holds).toHaveLength(1);
        }
      } else {
        expect(omer.holds).toEqual([]);
        expect(john.holds).toEqual([]);
      }
    }
    // The generator exercises every path.
    expect([...outcomes].some((o) => o.startsWith('completed@1'))).toBe(true);
    expect([...outcomes].some((o) => o.startsWith('completed@2') || o.startsWith('completed@3'))).toBe(true);
  });
});
