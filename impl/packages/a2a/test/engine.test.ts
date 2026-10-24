import { describe, expect, it } from 'vitest';
import {
  type A2APayload,
  cancel,
  type Ctx,
  emptyState,
  expire,
  type MeetingScope,
  MemoryCalendar,
  type NegotiationEvent,
  type NegotiationState,
  NegotiationError,
  type Outgoing,
  parseWindow,
  propose,
  receive,
  type Slot,
  type Span,
  toSpan,
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
  return () => `00000000-0000-4000-8${prefix}00-${String(++n).padStart(12, '0')}`;
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
}

function side(id: string, n: number, opts: Partial<Pick<Side, 'busy' | 'window' | 'offset' | 'scope'>> = {}): Side {
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
});

function apply(s: Side, step: { state: NegotiationState; effects: { slot: Slot }[]; events: NegotiationEvent[] }) {
  s.state = step.state;
  for (const e of step.effects) s.holds.push(e.slot);
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
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/accept', 'update:completed']);
    const sent = (wire[0].payload as Extract<A2APayload, { type: 'a2a/message' }>).message;
    const offered = (sent.parts[1] as { data: { slots: Slot[] } }).data.slots;
    // One per day, starting on the first free evening hour.
    expect(offered.map((s) => s.start)).toEqual(['2026-10-26T19:00:00+02:00', '2026-10-27T19:00:00+02:00', '2026-10-28T19:00:00+02:00']);
    for (const s of [omer, john]) {
      expect(task(s, taskId).state).toBe('completed');
      expect(task(s, taskId).agreed).toEqual(evening(1, 19, 21));
      expect(task(s, taskId).place).toEqual({ area: 'Tel Aviv' });
      expect(s.holds).toEqual([evening(1, 19, 21)]);
    }
    expect(task(john, taskId).peerState).toBe('completed');
  });

  it('agrees on round 2 when none of the first offer fits', () => {
    const omer = side(OMER, 1);
    const john = side(JOHN, 2, { busy: [evening(0), evening(1), evening(2)] });
    const { taskId, wire } = start(omer, john);
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/counter', 'meeting/accept', 'update:completed']);
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

    // John counters; then a second counter from John is out of turn once Omer has answered.
    const j = receive(john.state, OMER, p.outgoing[0].payload, ctxOf(john));
    apply(john, j);
    const o = receive(omer.state, JOHN, j.outgoing[0].payload, ctxOf(omer));
    apply(omer, o);
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
    expect(r.effects).toHaveLength(1);
  });

  it('negotiates across time zones', () => {
    // John lives at -05:00 and wants 12:00–16:00 his time (19:00–23:00 at +02:00) on Tuesday.
    const omer = side(OMER, 1, { busy: [evening(0)] });
    const john = side(JOHN, 2, {
      offset: -300,
      window: parseWindow('2026-10-27T12:00:00-05:00/2026-10-27T16:00:00-05:00', { now: NOW, offsetMinutes: -300 }),
    });
    const { taskId, wire } = start(omer, john);
    expect(verbs(wire)).toEqual(['meeting/propose', 'meeting/accept', 'update:completed']);
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

  it('refuses to propose with nothing free', () => {
    const omer = side(OMER, 1, { busy: [{ start: '2026-10-26T00:00:00+02:00', end: '2026-11-02T00:00:00+02:00' }] });
    expect(() => propose(omer.state, JOHN, ctxOf(omer))).toThrow(/no free slot/);
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
