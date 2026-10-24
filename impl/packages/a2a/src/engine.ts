// PLAN.md §5.2: the negotiation engine. A pure state machine:
//
//   (state, incoming, ctx) → { state, outgoing[], effects[], events[] }
//
// No I/O and no clock: the caller passes `now`, its own busy intervals (from a
// CalendarAdapter), its window and the grant scope in `ctx`, then sends
// `outgoing`, applies `effects` (calendar holds) and persists `state`. Input
// state is never mutated.
//
// Policy: an offer (propose or counter) carries up to 3 free slots, spread one
// per local day first. The receiver accepts the first offered slot that is
// free for it and inside its window; otherwise it counters with up to 3 of its
// own. A "round" is one offer; after 3 offers without agreement the receiver
// of the third declines and the task ends `rejected` on both sides.
//
// Task states (A2A v0.3), the same on both sides once messages arrive:
//   submitted       proposal sent, no answer yet
//   input-required  the responder countered (the proposer must answer)
//   working         the proposer countered back (the responder must answer)
//   completed       a slot was accepted        → both sides hold it
//   rejected        declined, rounds used up, or expired
//   canceled        rdv/cancel while pending (or before the proposal arrived)
import {
  type A2AMessage,
  type A2APayload,
  type MeetingData,
  isTerminal,
  LIMITS,
  type Place,
  parsePayload,
  type TaskState,
} from './model.js';
import { describeSlot, localDay, overlaps, sameSpan, type Slot, type Span, toSlot, toSpan, within } from './time.js';
import { candidateSlots } from './window.js';

/** The grant fields that govern meetings (structurally a subset of core's GrantScope). */
export interface MeetingScope {
  may_propose_meetings?: boolean;
  may_access_calendar?: string;
  [extra: string]: unknown;
}

export interface NegotiationTask {
  id: string;
  contextId: string;
  peer: string;
  role: 'proposer' | 'responder';
  state: TaskState;
  /** Offers made so far, by both sides. */
  round: number;
  /** Each offer we made, in order. */
  ourOffers: Slot[][];
  /** The peer's latest offer. */
  peerOffer: Slot[] | null;
  /** Who must move next while pending. */
  turn: 'us' | 'peer' | null;
  /** Slot length, fixed by the first offer. */
  minutes: number;
  place?: Place;
  expires: string | null;
  agreed?: Slot;
  /** Why it ended (for rejected/canceled). Peer-supplied when the peer declined. */
  reason?: string;
  /** Last state the peer reported in an a2a/task-update (informational only). */
  peerState?: TaskState;
  /** messageIds received for this task, for deduplication (§7 idempotency). */
  seen: string[];
  created: string;
  updated: string;
}

export interface NegotiationState {
  v: 1;
  tasks: Record<string, NegotiationTask>;
}

export const emptyState = (): NegotiationState => ({ v: 1, tasks: {} });

export interface Ctx {
  now: Date;
  /** Our busy intervals, covering at least `busyRange`. */
  busy: Slot[];
  /** The range `busy` was fetched for; slots outside it count as not free (unknown). */
  busyRange: Slot;
  /** When we are willing to meet (from `parseWindow`). */
  window: Span[];
  /** Local offset (minutes east of UTC) for the slots we write. */
  offsetMinutes: number;
  /** Grant scope for this peer. */
  scope: MeetingScope;
  /** Slot length for new proposals (default 120). */
  minutes?: number;
  maxRounds?: number;
  newId?: () => string;
}

export type EventKind =
  | 'proposed'
  | 'offer-received'
  | 'countered'
  | 'accepted'
  | 'completed'
  | 'rejected'
  | 'canceled'
  | 'expired'
  | 'status'
  | 'duplicate'
  | 'ignored'
  | 'invalid';

export interface NegotiationEvent {
  kind: EventKind;
  taskId: string | null;
  peer: string;
  state?: TaskState;
  round?: number;
  slots?: Slot[];
  slot?: Slot;
  reason?: string;
  /** Text parts from the peer: untrusted, display only, never drives anything. */
  peerText?: string[];
}

export interface HoldEffect {
  kind: 'hold';
  taskId: string;
  peer: string;
  slot: Slot;
  place?: Place;
}

export interface Outgoing {
  to: string;
  payload: A2APayload;
}

export interface Step {
  state: NegotiationState;
  outgoing: Outgoing[];
  effects: HoldEffect[];
  events: NegotiationEvent[];
}

export class NegotiationError extends Error {}

export const DEFAULT_MINUTES = 120;
export const MAX_ROUNDS = 3;
/** Terminal tasks kept for replay detection before the oldest are pruned. */
const KEEP_TERMINAL = 500;
const KEEP_TERMINAL_MS = 30 * 86_400_000;

/** Does the grant let us exchange meeting verbs at all? */
export function checkScope(scope: MeetingScope | null | undefined): { ok: true } | { ok: false; reason: string } {
  if (!scope || scope.may_propose_meetings !== true) {
    return { ok: false, reason: 'the grant does not allow meetings (may_propose_meetings)' };
  }
  // free_busy and full both work: we only ever share slots. Absent counts as
  // free_busy, since proposing a slot is itself a free/busy disclosure.
  if (scope.may_access_calendar === 'none') {
    return { ok: false, reason: 'the grant allows no calendar access (may_access_calendar: none)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

class Run {
  readonly state: NegotiationState;
  readonly outgoing: Outgoing[] = [];
  readonly effects: HoldEffect[] = [];
  readonly events: NegotiationEvent[] = [];
  readonly now: number;
  readonly nowIso: string;
  readonly newId: () => string;
  readonly maxRounds: number;

  constructor(
    state: NegotiationState,
    readonly ctx: Ctx,
  ) {
    this.state = structuredClone(state);
    this.now = ctx.now.getTime();
    this.nowIso = ctx.now.toISOString();
    this.newId = ctx.newId ?? (() => crypto.randomUUID());
    this.maxRounds = ctx.maxRounds ?? MAX_ROUNDS;
  }

  result(): Step {
    return { state: this.state, outgoing: this.outgoing, effects: this.effects, events: this.events };
  }

  event(e: NegotiationEvent): void {
    this.events.push(e);
  }

  // --- what we send -------------------------------------------------------

  message(task: NegotiationTask, data: MeetingData, text: string): void {
    const message: A2AMessage = {
      kind: 'message',
      messageId: this.newId(),
      taskId: task.id,
      contextId: task.contextId,
      role: 'agent',
      parts: [
        { kind: 'text', text },
        { kind: 'data', data },
      ],
    };
    this.outgoing.push({ to: task.peer, payload: { type: 'a2a/message', message } });
  }

  statusUpdate(task: NegotiationTask): void {
    this.outgoing.push({
      to: task.peer,
      payload: {
        type: 'a2a/task-update',
        update: {
          kind: 'status-update',
          taskId: task.id,
          contextId: task.contextId,
          status: { state: task.state, timestamp: this.nowIso },
          final: isTerminal(task.state),
        },
      },
    });
  }

  setState(task: NegotiationTask, state: TaskState, reason?: string): void {
    task.state = state;
    task.updated = this.nowIso;
    if (isTerminal(state)) task.turn = null;
    if (reason !== undefined) task.reason = reason;
  }

  // --- our calendar -------------------------------------------------------

  isFree(slot: Slot): boolean {
    const s = toSpan(slot);
    if (s.start < this.now || !within(s, toSpan(this.ctx.busyRange))) return false;
    return !this.ctx.busy.some((b) => overlaps(toSpan(b), s));
  }

  inWindow(slot: Slot): boolean {
    const s = toSpan(slot);
    return this.ctx.window.some((w) => within(s, w));
  }

  /** Up to 3 free slots from our window, one per local day first, avoiding our earlier offers. */
  pickSlots(minutes: number, previous: Slot[]): Slot[] {
    const off = this.ctx.offsetMinutes;
    const prev = previous.map(toSpan);
    const free = candidateSlots(this.ctx.window, { now: this.now, minutes, offsetMinutes: off })
      .map((s) => toSlot(s, off))
      .filter((s) => this.isFree(s) && !prev.some((p) => overlaps(p, toSpan(s))));
    const picked: Slot[] = [];
    const days = new Set<number>();
    for (const s of free) {
      if (picked.length >= LIMITS.slots) break;
      const day = localDay(toSpan(s).start, off);
      if (!days.has(day)) {
        days.add(day);
        picked.push(s);
      }
    }
    // Fewer days than slots: fill from the rest, without overlapping what we picked.
    for (const s of free) {
      if (picked.length >= LIMITS.slots) break;
      if (!picked.some((p) => overlaps(toSpan(p), toSpan(s)))) picked.push(s);
    }
    return picked.sort((a, b) => toSpan(a).start - toSpan(b).start);
  }

  // --- the policy ---------------------------------------------------------

  /** The peer just made an offer (task.peerOffer). Accept, counter or decline. */
  respond(task: NegotiationTask): void {
    const offer = task.peerOffer ?? [];
    const pick = offer.find((s) => this.isFree(s) && this.inWindow(s));
    if (pick) {
      this.setState(task, 'completed');
      task.agreed = pick;
      this.message(task, { rdv: 'meeting/accept', slot: pick, ...(task.place ? { place: task.place } : {}) }, `${describeSlot(pick)} works for me. See you then.`);
      this.effects.push({ kind: 'hold', taskId: task.id, peer: task.peer, slot: pick, place: task.place });
      this.event({ kind: 'accepted', taskId: task.id, peer: task.peer, state: task.state, slot: pick, round: task.round });
      return;
    }
    if (task.round >= this.maxRounds) return this.decline(task, `no common time after ${task.round} rounds`);
    const slots = this.pickSlots(task.minutes, task.ourOffers.flat());
    if (slots.length === 0) return this.decline(task, 'no free time left in my window');
    task.round += 1;
    task.ourOffers.push(slots);
    task.turn = 'peer';
    this.setState(task, task.role === 'responder' ? 'input-required' : 'working');
    this.message(task, { rdv: 'meeting/counter', slots }, `Those don't work for me. How about ${slots.map(describeSlot).join(', or ')}?`);
    this.event({ kind: 'countered', taskId: task.id, peer: task.peer, state: task.state, slots, round: task.round });
  }

  decline(task: NegotiationTask, reason: string): void {
    this.setState(task, 'rejected', reason);
    this.message(task, { rdv: 'meeting/decline', reason }, `Sorry, I couldn't find a time: ${reason}.`);
    this.event({ kind: 'rejected', taskId: task.id, peer: task.peer, state: task.state, reason, round: task.round });
  }

  /** Pending task past its `expires`: reject it and tell the peer. */
  expireIfDue(task: NegotiationTask): boolean {
    if (isTerminal(task.state) || task.expires === null) return false;
    const exp = Date.parse(task.expires);
    if (!(this.now > exp)) return false;
    this.setState(task, 'rejected', 'expired');
    this.message(task, { rdv: 'meeting/decline', reason: 'expired' }, 'This dinner proposal expired.');
    this.event({ kind: 'expired', taskId: task.id, peer: task.peer, state: task.state, reason: 'expired' });
    return true;
  }

  prune(): void {
    const terminal = Object.values(this.state.tasks)
      .filter((t) => isTerminal(t.state))
      .sort((a, b) => a.updated.localeCompare(b.updated));
    let excess = terminal.length - KEEP_TERMINAL;
    for (const t of terminal) {
      if (excess > 0 || this.now - Date.parse(t.updated) > KEEP_TERMINAL_MS) {
        delete this.state.tasks[t.id];
        excess--;
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** Start a negotiation: build the proposal. Throws NegotiationError when scope or calendar rule it out. */
export function propose(
  state: NegotiationState,
  peer: string,
  ctx: Ctx,
  opts: { place?: Place; expires?: string; text?: string } = {},
): Step & { taskId: string } {
  const allowed = checkScope(ctx.scope);
  if (!allowed.ok) throw new NegotiationError(allowed.reason);
  const run = new Run(state, ctx);
  const minutes = ctx.minutes ?? DEFAULT_MINUTES;
  if (!(minutes >= 15 && minutes <= LIMITS.slotMinutes)) throw new NegotiationError(`slot length must be 15–${LIMITS.slotMinutes} minutes`);
  const expires = opts.expires ?? new Date(run.now + 48 * 3_600_000).toISOString();
  if (!(Date.parse(expires) > run.now)) throw new NegotiationError('expires must be in the future');
  const slots = run.pickSlots(minutes, []);
  if (slots.length === 0) throw new NegotiationError('no free slot in the window');
  const task: NegotiationTask = {
    id: run.newId(),
    contextId: run.newId(),
    peer,
    role: 'proposer',
    state: 'submitted',
    round: 1,
    ourOffers: [slots],
    peerOffer: null,
    turn: 'peer',
    minutes,
    ...(opts.place ? { place: opts.place } : {}),
    expires,
    seen: [],
    created: run.nowIso,
    updated: run.nowIso,
  };
  run.state.tasks[task.id] = task;
  const data: MeetingData = { rdv: 'meeting/propose', slots, ...(opts.place ? { place: opts.place } : {}), expires };
  run.message(task, data, opts.text ?? `Dinner? How about ${slots.map(describeSlot).join(', or ')}?`);
  run.event({ kind: 'proposed', taskId: task.id, peer, state: task.state, slots, round: 1 });
  return { ...run.result(), taskId: task.id };
}

/** Handle one decrypted payload from `from`. Invalid input changes nothing and sends nothing. */
export function receive(state: NegotiationState, from: string, payload: unknown, ctx: Ctx): Step {
  const run = new Run(state, ctx);
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    run.event({ kind: 'invalid', taskId: null, peer: from, reason: parsed.reason });
    return run.result();
  }

  if (parsed.value.kind === 'update') {
    const u = parsed.value.update;
    const task = run.state.tasks[u.taskId];
    if (!task || task.peer !== from || task.contextId !== u.contextId) {
      run.event({ kind: 'ignored', taskId: u.taskId, peer: from, reason: 'status update for an unknown task' });
      return run.result();
    }
    // Informational: the peer's view never overrides ours.
    if (task.peerState !== u.status.state) {
      task.peerState = u.status.state;
      run.event({ kind: 'status', taskId: task.id, peer: from, state: task.state, reason: `peer reports ${u.status.state}` });
    }
    return run.result();
  }

  const { message: m, data, text } = parsed.value;
  const existing = run.state.tasks[m.taskId];
  const invalid = (reason: string) => {
    run.event({ kind: 'invalid', taskId: m.taskId, peer: from, reason });
    return run.result();
  };
  if (existing && existing.peer !== from) return invalid('task belongs to another peer');
  if (existing && existing.contextId !== m.contextId) return invalid('contextId does not match the task');
  if (existing?.seen.includes(m.messageId)) {
    run.event({ kind: 'duplicate', taskId: m.taskId, peer: from, state: existing.state });
    return run.result();
  }
  // Cancel only ever reduces what happens, so it needs no meeting scope.
  if (data.rdv !== 'rdv/cancel') {
    const allowed = checkScope(ctx.scope);
    if (!allowed.ok) return invalid(allowed.reason);
  }

  if (data.rdv === 'rdv/cancel') {
    if (!existing) {
      // Cancel overtook the proposal: keep a tombstone so the proposal is refused when it lands.
      const task: NegotiationTask = {
        id: m.taskId,
        contextId: m.contextId,
        peer: from,
        role: 'responder',
        state: 'canceled',
        round: 0,
        ourOffers: [],
        peerOffer: null,
        turn: null,
        minutes: DEFAULT_MINUTES,
        expires: null,
        reason: 'canceled by peer before the proposal arrived',
        seen: [m.messageId],
        created: run.nowIso,
        updated: run.nowIso,
      };
      run.state.tasks[task.id] = task;
      run.statusUpdate(task);
      run.event({ kind: 'canceled', taskId: task.id, peer: from, state: task.state, reason: task.reason, peerText: text });
      return run.result();
    }
    existing.seen.push(m.messageId);
    if (isTerminal(existing.state)) {
      // Not pending any more: not honored. Tell the peer how it actually ended.
      run.statusUpdate(existing);
      run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `cancel after ${existing.state}` });
      return run.result();
    }
    run.setState(existing, 'canceled', data.reason ?? 'canceled by peer');
    run.statusUpdate(existing);
    run.event({ kind: 'canceled', taskId: existing.id, peer: from, state: existing.state, reason: existing.reason, peerText: text });
    return run.result();
  }

  if (data.rdv === 'meeting/propose') {
    if (existing) {
      if (isTerminal(existing.state)) {
        existing.seen.push(m.messageId);
        run.statusUpdate(existing);
        run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `proposal for a ${existing.state} task` });
        return run.result();
      }
      return invalid('a second proposal for the same task (use meeting/counter)');
    }
    const first = toSpan(data.slots[0]);
    const task: NegotiationTask = {
      id: m.taskId,
      contextId: m.contextId,
      peer: from,
      role: 'responder',
      state: 'working',
      round: 1,
      ourOffers: [],
      peerOffer: data.slots,
      turn: 'us',
      minutes: Math.round((first.end - first.start) / 60_000),
      ...(data.place ? { place: data.place } : {}),
      expires: data.expires ?? null,
      seen: [m.messageId],
      created: run.nowIso,
      updated: run.nowIso,
    };
    run.state.tasks[task.id] = task;
    run.event({ kind: 'offer-received', taskId: task.id, peer: from, state: task.state, slots: data.slots, round: 1, peerText: text });
    if (!run.expireIfDue(task)) run.respond(task);
    run.prune();
    return run.result();
  }

  // counter / accept / decline need a pending task where the peer has the turn.
  if (!existing) return invalid(`${data.rdv} for an unknown task`);
  if (isTerminal(existing.state)) {
    existing.seen.push(m.messageId);
    run.statusUpdate(existing);
    run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `${data.rdv} after ${existing.state}` });
    return run.result();
  }
  if (data.rdv === 'meeting/decline') {
    existing.seen.push(m.messageId);
    run.setState(existing, 'rejected', data.reason);
    run.event({ kind: 'rejected', taskId: existing.id, peer: from, state: existing.state, reason: data.reason, peerText: text });
    return run.result();
  }
  if (existing.turn !== 'peer') return invalid(`${data.rdv} out of turn`);

  if (data.rdv === 'meeting/counter') {
    if (existing.round >= run.maxRounds) return invalid(`counter beyond ${run.maxRounds} rounds`);
    existing.seen.push(m.messageId);
    existing.round += 1;
    existing.peerOffer = data.slots;
    existing.turn = 'us';
    run.event({ kind: 'offer-received', taskId: existing.id, peer: from, state: existing.state, slots: data.slots, round: existing.round, peerText: text });
    if (!run.expireIfDue(existing)) run.respond(existing);
    return run.result();
  }

  // meeting/accept: the slot must be one of our latest offer (same instants; the offset may differ).
  const lastOffer = existing.ourOffers.at(-1) ?? [];
  const wanted = toSpan(data.slot);
  const ours = lastOffer.find((s) => sameSpan(toSpan(s), wanted));
  if (!ours) return invalid('accept of a slot that was never offered');
  existing.seen.push(m.messageId);
  // Honored even if `expires` passed meanwhile: the peer may have accepted in time and already holds the slot.
  run.setState(existing, 'completed');
  existing.agreed = ours;
  run.effects.push({ kind: 'hold', taskId: existing.id, peer: from, slot: ours, place: existing.place });
  run.statusUpdate(existing);
  run.event({ kind: 'completed', taskId: existing.id, peer: from, state: existing.state, slot: ours, round: existing.round, peerText: text });
  return run.result();
}

/** The owner cancels a pending task (`rdv/cancel`). */
export function cancel(state: NegotiationState, taskId: string, ctx: Pick<Ctx, 'now' | 'newId'>, reason?: string): Step {
  const run = new Run(state, ctx as Ctx);
  const task = run.state.tasks[taskId];
  if (!task) throw new NegotiationError(`no negotiation ${taskId}`);
  if (isTerminal(task.state)) throw new NegotiationError(`negotiation ${taskId} already ${task.state}`);
  run.setState(task, 'canceled', reason ?? 'canceled by us');
  run.message(task, { rdv: 'rdv/cancel', ...(reason ? { reason } : {}) }, 'I need to cancel this dinner proposal.');
  run.event({ kind: 'canceled', taskId, peer: task.peer, state: task.state, reason: task.reason });
  return run.result();
}

/** Reject every pending task past its `expires` (telling the peer), and prune old finished tasks. */
export function expire(state: NegotiationState, ctx: Pick<Ctx, 'now' | 'newId'>): Step {
  const run = new Run(state, ctx as Ctx);
  for (const task of Object.values(run.state.tasks)) run.expireIfDue(task);
  run.prune();
  return run.result();
}
