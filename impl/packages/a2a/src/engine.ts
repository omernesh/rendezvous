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
// Agreement is a two-step handshake (issue #5), with our human in the loop
// (issue #8) unless `ctx.autoConfirm`:
//   accepter  picks a slot and holds it tentatively ('human-accept': waits for
//             its human, confirmMeeting), then sends meeting/accept
//             ('peer-confirm': waits for the offerer)
//   offerer   checks the slot is still free, holds it tentatively
//             ('human-confirm'), then sends meeting/confirm → completed
//   accepter  on meeting/confirm → completed, acknowledged by a status update
// A tentative hold is released (a `release` effect) when the task is canceled,
// declined or expires instead. Every hold, tentative or final, makes the slot
// busy for all our other tasks.
//
// Task states (A2A v0.3), the same on both sides once messages arrive:
//   submitted       proposal sent, no answer yet
//   input-required  the responder countered (the proposer must answer)
//   working         the proposer countered back (the responder must answer)
//   completed       a slot was accepted and confirmed → both sides hold it
//   rejected        declined, rounds used up, or expired
//   canceled        rdv/cancel while pending (or before the proposal arrived)
// `task.hold` and its stage refine a pending state while a slot is held.
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
import { describeSlot, localDay, overlaps, parseInstant, sameSpan, type Slot, type Span, toSlot, toSpan, within } from './time.js';
import { candidateSlots } from './window.js';

/** The grant fields that govern meetings (structurally a subset of core's GrantScope). */
export interface MeetingScope {
  may_propose_meetings?: boolean;
  may_access_calendar?: string;
  [extra: string]: unknown;
}

/** A slot held for a task before it is final, and what the task waits for. */
export interface Hold {
  slot: Slot;
  /**
   * human-accept   we want to accept the peer's slot; our human must confirm (confirmMeeting)
   * human-confirm  the peer accepted our slot; our human must confirm (confirmMeeting)
   * peer-confirm   we sent meeting/accept; the peer must send meeting/confirm
   */
  stage: 'human-accept' | 'human-confirm' | 'peer-confirm';
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
  /** Tentatively held slot while pending (issue #5). */
  hold?: Hold;
  /** Why it ended (for rejected/canceled). Peer-supplied when the peer declined. */
  reason?: string;
  /** Last state the peer reported in an a2a/task-update (informational only). */
  peerState?: TaskState;
  /** messageIds received for this task, for deduplication (§7 idempotency). */
  seen: string[];
  /** Status updates sent in answer to messages after the task finished (capped). */
  finishedReplies?: number;
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
  /**
   * Skip the human: accept and confirm on the policy alone (scripted bots,
   * demos, tests). Default false: the task waits in a `human-*` hold stage
   * until `confirmMeeting` (issue #8).
   */
  autoConfirm?: boolean;
}

export type EventKind =
  | 'proposed'
  | 'offer-received'
  | 'countered'
  | 'accepted'
  | 'confirm-needed'
  | 'completed'
  | 'released'
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

/** Block `slot` in the calendar: tentatively (pending) or for good (completed). */
export interface HoldEffect {
  kind: 'hold';
  taskId: string;
  peer: string;
  slot: Slot;
  place?: Place;
  tentative: boolean;
}

/** Remove this task's tentative hold of `slot` from the calendar. */
export interface ReleaseEffect {
  kind: 'release';
  taskId: string;
  peer: string;
  slot: Slot;
}

export type Effect = HoldEffect | ReleaseEffect;

export interface Outgoing {
  to: string;
  payload: A2APayload;
}

export interface Step {
  state: NegotiationState;
  outgoing: Outgoing[];
  effects: Effect[];
  events: NegotiationEvent[];
}

export class NegotiationError extends Error {}

export const DEFAULT_MINUTES = 120;
export const MAX_ROUNDS = 3;
/** Terminal tasks kept for replay detection before the oldest are pruned. */
const KEEP_TERMINAL = 500;
const KEEP_TERMINAL_MS = 30 * 86_400_000;
/** messageIds kept per task, and status replies sent per finished task. */
export const SEEN_PER_TASK = 64;
export const FINISHED_REPLIES = 8;
/** Tasks (pending and finished, tombstones included) kept per peer. */
export const MAX_TASKS_PER_PEER = 32;
/** `expires` for tasks a peer creates: default when absent, and the latest we accept. */
export const PEER_EXPIRES_DEFAULT_MS = 48 * 3_600_000;
export const PEER_EXPIRES_MAX_MS = 7 * 86_400_000;
/**
 * How long past `expires` an accepter keeps its tentative hold while waiting
 * for meeting/confirm. The offerer never confirms after `expires`, so a
 * confirm sent in time has this long to arrive (relays store for days).
 */
export const CONFIRM_GRACE_MS = 24 * 3_600_000;

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
  readonly effects: Effect[] = [];
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

  /**
   * A message for a finished task: remember its id (bounded) and tell the
   * peer how the task ended, at most FINISHED_REPLIES times per task, so
   * replays can't grow `seen` or make us send forever (security review L3).
   */
  replyFinished(task: NegotiationTask, messageId: string): void {
    task.seen.push(messageId);
    if (task.seen.length > SEEN_PER_TASK) task.seen.splice(0, task.seen.length - SEEN_PER_TASK);
    if ((task.finishedReplies ?? 0) >= FINISHED_REPLIES) return;
    task.finishedReplies = (task.finishedReplies ?? 0) + 1;
    this.statusUpdate(task);
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

  /**
   * Free in our calendar and not held by another of our tasks (tentatively or
   * agreed): holds are exclusive across tasks, even before the calendar file
   * shows them (issue #5).
   */
  isFree(slot: Slot, taskId?: string): boolean {
    const s = toSpan(slot);
    if (s.start < this.now || !within(s, toSpan(this.ctx.busyRange))) return false;
    if (this.ctx.busy.some((b) => overlaps(toSpan(b), s))) return false;
    return !Object.values(this.state.tasks).some((t) => {
      if (t.id === taskId) return false;
      const held = t.hold && !isTerminal(t.state) ? t.hold.slot : t.state === 'completed' ? t.agreed : undefined;
      return held !== undefined && overlaps(toSpan(held), s);
    });
  }

  inWindow(slot: Slot): boolean {
    const s = toSpan(slot);
    return this.ctx.window.some((w) => within(s, w));
  }

  /** Up to 3 free slots from our window, one per local day first, avoiding our earlier offers. */
  pickSlots(minutes: number, previous: Slot[], taskId?: string): Slot[] {
    const off = this.ctx.offsetMinutes;
    const prev = previous.map(toSpan);
    const free = candidateSlots(this.ctx.window, { now: this.now, minutes, offsetMinutes: off })
      .map((s) => toSlot(s, off))
      .filter((s) => this.isFree(s, taskId) && !prev.some((p) => overlaps(p, toSpan(s))));
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
    const pick = offer.find((s) => this.isFree(s, task.id) && this.inWindow(s));
    if (pick) {
      if (this.ctx.autoConfirm) return this.sendAccept(task, pick);
      this.placeHold(task, pick, 'human-accept');
      this.event({ kind: 'confirm-needed', taskId: task.id, peer: task.peer, state: task.state, slot: pick, round: task.round });
      return;
    }
    if (task.round >= this.maxRounds) return this.decline(task, `no common time after ${task.round} rounds`);
    const slots = this.pickSlots(task.minutes, task.ourOffers.flat(), task.id);
    if (slots.length === 0) return this.decline(task, 'no free time left in my window');
    task.round += 1;
    task.ourOffers.push(slots);
    task.turn = 'peer';
    this.setState(task, task.role === 'responder' ? 'input-required' : 'working');
    this.message(task, { rdv: 'meeting/counter', slots }, `Those don't work for me. How about ${slots.map(describeSlot).join(', or ')}?`);
    this.event({ kind: 'countered', taskId: task.id, peer: task.peer, state: task.state, slots, round: task.round });
  }

  // --- holds and the accept → confirm handshake ---------------------------

  /** Hold `slot` for `task` (tentatively) at `stage`; the calendar effect only once. */
  placeHold(task: NegotiationTask, slot: Slot, stage: Hold['stage']): void {
    if (!task.hold) this.effects.push({ kind: 'hold', taskId: task.id, peer: task.peer, slot, place: task.place, tentative: true });
    task.hold = { slot, stage };
    task.turn = stage === 'peer-confirm' ? 'peer' : 'us';
    task.updated = this.nowIso;
  }

  /** Drop the task's tentative hold, if any (cancel, decline, expiry). */
  release(task: NegotiationTask): void {
    if (!task.hold) return;
    const { slot } = task.hold;
    delete task.hold;
    this.effects.push({ kind: 'release', taskId: task.id, peer: task.peer, slot });
    this.event({ kind: 'released', taskId: task.id, peer: task.peer, slot });
  }

  /** The meeting is final on our side: the hold stays, for good. */
  complete(task: NegotiationTask, slot: Slot): void {
    this.setState(task, 'completed');
    task.agreed = slot;
    delete task.hold;
    this.effects.push({ kind: 'hold', taskId: task.id, peer: task.peer, slot, place: task.place, tentative: false });
  }

  /** Accepter: send meeting/accept and wait for the offerer's confirm. */
  sendAccept(task: NegotiationTask, slot: Slot): void {
    this.placeHold(task, slot, 'peer-confirm');
    this.message(task, { rdv: 'meeting/accept', slot, ...(task.place ? { place: task.place } : {}) }, `${describeSlot(slot)} works for me. Please confirm.`);
    this.event({ kind: 'accepted', taskId: task.id, peer: task.peer, state: task.state, slot, round: task.round });
  }

  /** Offerer: the peer accepted `slot`; make it final and tell them. */
  sendConfirm(task: NegotiationTask, slot: Slot, peerText?: string[]): void {
    this.complete(task, slot);
    this.message(task, { rdv: 'meeting/confirm', slot }, `Confirmed: ${describeSlot(slot)}. See you then.`);
    this.event({ kind: 'completed', taskId: task.id, peer: task.peer, state: task.state, slot, round: task.round, peerText });
  }

  decline(task: NegotiationTask, reason: string): void {
    this.release(task);
    this.setState(task, 'rejected', reason);
    this.message(task, { rdv: 'meeting/decline', reason }, `Sorry, I couldn't find a time: ${reason}.`);
    this.event({ kind: 'rejected', taskId: task.id, peer: task.peer, state: task.state, reason, round: task.round });
  }

  /**
   * Pending task past its `expires`: reject it, release its hold and tell the
   * peer. An accepter waiting for meeting/confirm waits CONFIRM_GRACE_MS longer.
   */
  expireIfDue(task: NegotiationTask): boolean {
    if (isTerminal(task.state) || task.expires === null) return false;
    const exp = parseInstant(task.expires);
    const grace = task.hold?.stage === 'peer-confirm' ? CONFIRM_GRACE_MS : 0;
    if (exp !== null && !(this.now > exp + grace)) return false; // an unreadable expires counts as expired (fail closed)
    this.release(task);
    this.setState(task, 'rejected', 'expired');
    this.message(task, { rdv: 'meeting/decline', reason: 'expired' }, 'This dinner proposal expired.');
    this.event({ kind: 'expired', taskId: task.id, peer: task.peer, state: task.state, reason: 'expired' });
    return true;
  }

  /**
   * Make room for one more task with `peer`: evict its oldest finished tasks
   * (tombstones first) down to the per-peer cap. False if all are pending.
   */
  makeRoom(peer: string): boolean {
    const mine = Object.values(this.state.tasks).filter((t) => t.peer === peer);
    if (mine.length < MAX_TASKS_PER_PEER) return true;
    const finished = mine
      .filter((t) => isTerminal(t.state))
      .sort((a, b) => Number(b.round === 0) - Number(a.round === 0) || a.updated.localeCompare(b.updated));
    const excess = mine.length - MAX_TASKS_PER_PEER + 1;
    if (finished.length < excess) return false; // all pending: refuse, change nothing
    for (const t of finished.slice(0, excess)) delete this.state.tasks[t.id];
    return true;
  }

  /** Default and clamp a peer-supplied `expires`. */
  peerExpires(expires: string | undefined): string {
    const max = this.now + PEER_EXPIRES_MAX_MS;
    const want = parseInstant(expires) ?? this.now + PEER_EXPIRES_DEFAULT_MS;
    return new Date(Math.min(want, max)).toISOString();
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
  const exp = parseInstant(expires);
  if (exp === null || !(exp > run.now)) throw new NegotiationError('expires must be an RFC 3339 date-time in the future');
  const slots = run.pickSlots(minutes, []);
  if (slots.length === 0) throw new NegotiationError('no free slot in the window');
  if (!run.makeRoom(peer)) throw new NegotiationError(`too many open negotiations with ${peer} (max ${MAX_TASKS_PER_PEER})`);
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
  handle(run, from, payload, ctx);
  run.prune();
  return run.result();
}

function handle(run: Run, from: string, payload: unknown, ctx: Ctx): void {
  const parsed = parsePayload(payload);
  if (!parsed.ok) {
    run.event({ kind: 'invalid', taskId: null, peer: from, reason: parsed.reason });
    return;
  }

  if (parsed.value.kind === 'update') {
    const u = parsed.value.update;
    const task = run.state.tasks[u.taskId];
    if (!task || task.peer !== from || task.contextId !== u.contextId) {
      run.event({ kind: 'ignored', taskId: u.taskId, peer: from, reason: 'status update for an unknown task' });
      return;
    }
    // Informational: the peer's view never overrides ours, with one exception
    // that only reduces: a peer that reports the task ended (canceled or
    // rejected) while we hold a slot for it will never confirm (issue #5).
    if (task.peerState !== u.status.state) {
      task.peerState = u.status.state;
      run.event({ kind: 'status', taskId: task.id, peer: from, state: task.state, reason: `peer reports ${u.status.state}` });
    }
    const ended = u.status.state;
    if ((ended === 'canceled' || ended === 'rejected') && task.hold && !isTerminal(task.state)) {
      run.release(task);
      run.setState(task, ended, `peer reports ${ended}`);
      run.event({ kind: ended, taskId: task.id, peer: from, state: task.state, reason: task.reason });
    }
    return;
  }

  const { message: m, data, text } = parsed.value;
  const existing = run.state.tasks[m.taskId];
  const invalid = (reason: string): void => {
    run.event({ kind: 'invalid', taskId: m.taskId, peer: from, reason });
  };
  if (existing && existing.peer !== from) return invalid('task belongs to another peer');
  if (existing && existing.contextId !== m.contextId) return invalid('contextId does not match the task');
  if (existing?.seen.includes(m.messageId)) {
    run.event({ kind: 'duplicate', taskId: m.taskId, peer: from, state: existing.state });
    return;
  }
  // Only a meeting-capable grant may create or advance tasks. A cancel of an
  // existing task only reduces what happens, so it is honored regardless.
  if (!(data.rdv === 'rdv/cancel' && existing)) {
    const allowed = checkScope(ctx.scope);
    if (!allowed.ok) return invalid(allowed.reason);
  }

  if (data.rdv === 'rdv/cancel') {
    if (!existing) {
      // Cancel overtook the proposal: keep a tombstone so the proposal is refused when it lands.
      if (!run.makeRoom(from)) return invalid(`too many open negotiations with this peer (max ${MAX_TASKS_PER_PEER})`);
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
      return;
    }
    if (isTerminal(existing.state)) {
      // Not pending any more: not honored. Tell the peer how it actually ended.
      run.replyFinished(existing, m.messageId);
      run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `cancel after ${existing.state}` });
      return;
    }
    existing.seen.push(m.messageId);
    run.release(existing);
    run.setState(existing, 'canceled', data.reason ?? 'canceled by peer');
    run.statusUpdate(existing);
    run.event({ kind: 'canceled', taskId: existing.id, peer: from, state: existing.state, reason: existing.reason, peerText: text });
    return;
  }

  if (data.rdv === 'meeting/propose') {
    if (existing) {
      if (isTerminal(existing.state)) {
        run.replyFinished(existing, m.messageId);
        run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `proposal for a ${existing.state} task` });
        return;
      }
      return invalid('a second proposal for the same task (use meeting/counter)');
    }
    if (!run.makeRoom(from)) return invalid(`too many open negotiations with this peer (max ${MAX_TASKS_PER_PEER})`);
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
      expires: run.peerExpires(data.expires),
      seen: [m.messageId],
      created: run.nowIso,
      updated: run.nowIso,
    };
    run.state.tasks[task.id] = task;
    run.event({ kind: 'offer-received', taskId: task.id, peer: from, state: task.state, slots: data.slots, round: 1, peerText: text });
    if (!run.expireIfDue(task)) run.respond(task);
    return;
  }

  // counter / accept / decline need a pending task where the peer has the turn.
  if (!existing) return invalid(`${data.rdv} for an unknown task`);
  if (isTerminal(existing.state)) {
    run.replyFinished(existing, m.messageId);
    run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `${data.rdv} after ${existing.state}` });
    return;
  }
  if (data.rdv === 'meeting/decline') {
    existing.seen.push(m.messageId);
    run.release(existing);
    run.setState(existing, 'rejected', data.reason);
    run.event({ kind: 'rejected', taskId: existing.id, peer: from, state: existing.state, reason: data.reason, peerText: text });
    return;
  }
  const awaitingConfirm = existing.hold?.stage === 'peer-confirm' ? existing.hold : undefined;
  if (data.rdv === 'meeting/confirm') {
    if (!awaitingConfirm) return invalid('meeting/confirm without an accept from us');
    if (!sameSpan(toSpan(data.slot), toSpan(awaitingConfirm.slot))) return invalid('confirm of a slot we did not accept');
    existing.seen.push(m.messageId);
    // Honored even past `expires`: within the grace, the offerer confirmed in time.
    run.complete(existing, awaitingConfirm.slot);
    run.statusUpdate(existing);
    run.event({ kind: 'completed', taskId: existing.id, peer: from, state: existing.state, slot: existing.agreed, round: existing.round, peerText: text });
    return;
  }
  if (awaitingConfirm) return invalid(`${data.rdv} while waiting for meeting/confirm`);
  if (existing.turn !== 'peer') return invalid(`${data.rdv} out of turn`);

  if (data.rdv === 'meeting/counter') {
    if (existing.round >= run.maxRounds) return invalid(`counter beyond ${run.maxRounds} rounds`);
    existing.seen.push(m.messageId);
    existing.round += 1;
    existing.peerOffer = data.slots;
    existing.turn = 'us';
    run.event({ kind: 'offer-received', taskId: existing.id, peer: from, state: existing.state, slots: data.slots, round: existing.round, peerText: text });
    if (!run.expireIfDue(existing)) run.respond(existing);
    return;
  }

  // meeting/accept: the slot must be one of our latest offer (same instants; the offset may differ).
  const lastOffer = existing.ourOffers.at(-1) ?? [];
  const wanted = toSpan(data.slot);
  const ours = lastOffer.find((s) => sameSpan(toSpan(s), wanted));
  if (!ours) return invalid('accept of a slot that was never offered');
  existing.seen.push(m.messageId);
  // The accepter holds only tentatively until we confirm, so a late accept is declined (and released there).
  if (run.expireIfDue(existing)) return;
  // Offers are not held: another task may have taken the slot since (holds are exclusive).
  if (!run.isFree(ours, existing.id)) return run.decline(existing, 'that time is no longer free');
  if (ctx.autoConfirm) return run.sendConfirm(existing, ours, text);
  run.placeHold(existing, ours, 'human-confirm');
  run.event({ kind: 'confirm-needed', taskId: existing.id, peer: from, state: existing.state, slot: ours, round: existing.round, peerText: text });
}

/** The owner cancels a pending task (`rdv/cancel`). */
export function cancel(state: NegotiationState, taskId: string, ctx: Pick<Ctx, 'now' | 'newId'>, reason?: string): Step {
  const run = new Run(state, ctx as Ctx);
  const task = run.state.tasks[taskId];
  if (!task) throw new NegotiationError(`no negotiation ${taskId}`);
  if (isTerminal(task.state)) throw new NegotiationError(`negotiation ${taskId} already ${task.state}`);
  run.release(task);
  run.setState(task, 'canceled', reason ?? 'canceled by us');
  run.message(task, { rdv: 'rdv/cancel', ...(reason ? { reason } : {}) }, 'I need to cancel this dinner proposal.');
  run.event({ kind: 'canceled', taskId, peer: task.peer, state: task.state, reason: task.reason });
  return run.result();
}

/**
 * Our human confirms the meeting a task is waiting on (issue #8): in
 * `human-accept` this sends meeting/accept, in `human-confirm` it sends
 * meeting/confirm and completes the task. A task past `expires` expires
 * instead. Throws NegotiationError when there is nothing to confirm.
 */
export function confirmMeeting(state: NegotiationState, taskId: string, ctx: Pick<Ctx, 'now' | 'newId'>): Step {
  const run = new Run(state, ctx as Ctx);
  const task = Object.hasOwn(run.state.tasks, taskId) ? run.state.tasks[taskId] : undefined;
  if (!task) throw new NegotiationError(`no negotiation ${taskId}`);
  if (isTerminal(task.state)) throw new NegotiationError(`negotiation ${taskId} already ${task.state}`);
  const hold = task.hold;
  if (hold?.stage === 'peer-confirm') throw new NegotiationError(`negotiation ${taskId} is waiting for the peer to confirm, not for you`);
  if (!hold) throw new NegotiationError(`negotiation ${taskId} has no meeting waiting for your confirmation`);
  if (run.expireIfDue(task)) return run.result();
  if (hold.stage === 'human-accept') run.sendAccept(task, hold.slot);
  else run.sendConfirm(task, hold.slot);
  return run.result();
}

/** Does this task wait for our human to confirm a meeting? */
export const awaitingHuman = (t: NegotiationTask): boolean =>
  !isTerminal(t.state) && (t.hold?.stage === 'human-accept' || t.hold?.stage === 'human-confirm');

/** Reject every pending task past its `expires`
 (telling the peer), and prune old finished tasks. */
export function expire(state: NegotiationState, ctx: Pick<Ctx, 'now' | 'newId'>): Step {
  const run = new Run(state, ctx as Ctx);
  for (const task of Object.values(run.state.tasks)) run.expireIfDue(task);
  run.prune();
  return run.result();
}
