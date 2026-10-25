// SPEC §7.6: the general task engine (tasks/v1). A pure state machine, like the
// meeting engine (engine.ts):
//
//   (state, incoming, ctx) → { state, outgoing[], effects[], events[] }
//
// No I/O and no clock: the caller passes `now`, the capability registry and
// the grant's `invoke` map in `ctx`, then sends `outgoing`, acts on `effects`
// and persists `state`. Input state is never mutated. It does not import core.
//
// Two roles share one state:
//   requester  request() sends task/request; input() answers input-required;
//              cancel() withdraws. It receives the executor's status and
//              artifact updates.
//   executor   receive() takes task/request, task/input and rdv/cancel. By the
//              capability's approval class (SPEC §7.6.3) a new task is
//                notify     shown to the human and completed (`notify` effect)
//                auto       started at once (`start` effect; the grant is the approval)
//                confirm,   held `submitted` with the start gate open
//                free-form  (`start-gate` effect) until startTask() / rejectTask()
//              Then askInput(), sendArtifact() and finish(). Under confirm and
//              free-form, an artifact or a status message with text needs the
//              release gate: without `released: true` the call sends nothing
//              and returns a `release-gate` effect holding the draft payload.
//              The gates themselves (digests, the human's approval) are the
//              caller's (a later slice); this engine only says when they apply.
//
// States: submitted → working → input-required ⇄ working → completed | failed
// | rejected | canceled. The executor's state is the task's state: the
// requester follows its status updates (only forward transitions).
//
// Bounds (SPEC §7.4, A.7; NOTES 46): only a grant whose `invoke` covers the
// capability creates a task, and any task-capable grant a tombstone; per peer
// 32 tasks (finished ones and tombstones evicted first) and `max_open` open
// tasks per capability (default 4); waiting for the human 4 per peer and 64 in
// all, the weakest (lowest tier, then oldest) rejected `busy`, the newcomer
// included; per task 64 seen messageIds, 8 task/input, 64 status updates, 8
// artifacts, 64 artifact chunks, 8 finished and 8 unsupported replies;
// `expires` defaults to 48 h and is clamped to 7 days; finished tasks pruned
// after 30 days. A refusal (scope, rate, input, unsupported) keeps no state,
// answers `rejected` with the reason under REASON_KEY, and is counted in
// `state.dropped` for the human. Peer text and files are carried for display
// only (events), and dropped from state when the task ends.
import { type ApprovalClass, type Capability, type CapabilityRegistry, checkData, checkInput, MAX_OPEN_DEFAULT, needsReleaseGate, needsStartGate, SchemaError } from './capabilities.js';
import { isUuid, UNSUPPORTED_KEY, type UnsupportedMessage } from './model.js';
import {
  type Artifact,
  AWAITING_KEY,
  type TaskDataPart,
  type FilePart,
  FILES_URI,
  isFinished,
  parseTaskPayload,
  REASON_KEY,
  type ReasonCode,
  type StatusMessage,
  TASK_LIMITS,
  TASKS_URI,
  type TaskLifecycleState,
  type TaskMessage,
  type TaskPart,
  type TaskPayload,
  type TaskStatusUpdate,
  type TaskVerbData,
  type TaskTextPart,
} from './taskmodel.js';
import { parseInstant } from './time.js';

// --- bounds -----------------------------------------------------------------

export const TASK_BOUNDS = {
  /** Tasks (open and finished, tombstones included) kept per peer. */
  tasksPerPeer: 32,
  /** Tasks waiting for our human, per peer and in all. */
  waitingPerPeer: 4,
  waitingTotal: 64,
  /** Per task. */
  seenPerTask: 64,
  inputsPerTask: 8,
  updatesPerTask: 64,
  artifactsPerTask: 8,
  chunksPerTask: 64,
  finishedReplies: 8,
  unsupportedReplies: 8,
  /** `expires`: default and latest accepted, from now. */
  expiresDefaultMs: 48 * 3_600_000,
  expiresMaxMs: 7 * 86_400_000,
  /** Finished tasks: kept this long, and at most this many in all. */
  keepFinishedMs: 30 * 86_400_000,
  keepFinished: 500,
} as const;

/** Tiers from weakest to strongest (SPEC §5.3); an unknown tier is weaker than all. */
const TIER_RANK = ['stranger', 'business', 'colleague', 'friend', 'family', 'spouse'];
const tierRank = (t: string | undefined) => (t === undefined ? -1 : TIER_RANK.indexOf(t));

// --- state ------------------------------------------------------------------

export interface ArtifactRecord {
  artifactId: string;
  name?: string;
  chunks: number;
  /** The executor sent `lastChunk: true`. */
  done: boolean;
}

export interface TaskRecord {
  id: string;
  contextId: string;
  peer: string;
  role: 'requester' | 'executor';
  /** The capability URI; empty for a tombstone. */
  capability: string;
  approval?: ApprovalClass;
  state: TaskLifecycleState;
  /** Executor: our human must approve before we act (start gate, SPEC §5.5). */
  gate?: { kind: 'start'; step: 'request' | 'input'; since: string };
  /** Executor: the peer's tier when the task arrived (which waiting task is dropped first). */
  tier?: string;
  /** The validated `input` of the request, while the task is open. */
  input?: unknown;
  /** The latest validated `task/input` answer, while the task is open. */
  answer?: unknown;
  /** The request's text parts (untrusted peer text on the executor side), while open. */
  text?: string[];
  /** The request's file parts (opaque, never fetched here), while open. */
  files?: FilePart[];
  referenceTaskIds?: string[];
  expires: string | null;
  /** Why it ended, for the human. Peer-supplied text is never stored here. */
  reason?: string;
  code?: ReasonCode;
  /** A cancel that arrived before its request. */
  tombstone?: true;
  /** messageIds received (executor), for deduplication. */
  seen: string[];
  /** task/input sent (requester) or received (executor). */
  inputs: number;
  /** Status updates processed (requester). */
  updates: number;
  artifacts: ArtifactRecord[];
  /** Artifact chunks received (requester) or sent (executor). */
  chunks: number;
  finishedReplies?: number;
  unsupportedReplies?: number;
  created: string;
  updated: string;
}

export interface TaskEngineState {
  v: 1;
  tasks: Record<string, TaskRecord>;
  /** Peer tasks refused or dropped without asking our human, by reason (shown to the human). */
  dropped: Partial<Record<ReasonCode, number>>;
  /**
   * Requester: when we sent task/requests, by peer and capability (epoch ms,
   * within the capability's `max_frequency` window in the peer's grant), so
   * we never send what the peer's limiter would refuse (outboundLimit).
   */
  sent?: Record<string, Record<string, number[]>>;
}

export const emptyTaskState = (): TaskEngineState => ({ v: 1, tasks: {}, dropped: {} });

export interface TaskCtx {
  now: Date;
  newId?: () => string;
  /** The capabilities we implement. */
  registry: CapabilityRegistry;
  /**
   * The `scope.invoke` of the grant that covers this direction: for receive(),
   * the grant our owner gave the peer (what it may invoke on us); for
   * request(), the peer's grant to us. Keys are capability URIs, values their
   * limits (`max_open`). Absent or empty: no tasks.
   */
  invoke?: Readonly<Record<string, unknown>> | null;
  /** The peer's tier in our contact book (receive). */
  tier?: string;
  /**
   * The per-capability limiter (receive; SPEC §5.3, issue #28), e.g.
   * `(cap, o) => agent.admitTask(peer, cap, o, now)` from core. Called once
   * for a new task that passed every other check (capability known, grant,
   * input, room), with the peer's open tasks for the capability and the
   * engine's `max_open` for it; it counts what it admits and refuses. Any
   * refusal rejects that task only (`rejected`, its `code`), keeps no state
   * and is counted in `dropped`. Absent: the engine checks `max_open` alone.
   */
  limit?: (capability: string, open: { open: number; maxOpen: number }) => TaskLimitVerdict;
}

/** A limiter's answer (core's `TaskAdmission` is one). */
export type TaskLimitVerdict = { ok: true } | { ok: false; code: 'rate' | 'scope'; reason: string };

// --- results ----------------------------------------------------------------

export type TaskEventKind =
  | 'requested'
  | 'received'
  | 'start-needed'
  | 'started'
  | 'input-required'
  | 'input'
  | 'artifact'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'canceled'
  | 'expired'
  /** A peer's task was refused without keeping state (`code` says why). */
  | 'refused'
  /** A task waiting for our human was rejected to make room (`busy`). */
  | 'evicted'
  | 'status'
  | 'duplicate'
  | 'ignored'
  | 'invalid'
  | 'unsupported';

export interface TaskEvent {
  kind: TaskEventKind;
  taskId: string | null;
  peer: string;
  state?: TaskLifecycleState;
  capability?: string;
  code?: ReasonCode;
  reason?: string;
  /** Text from the peer: untrusted, display only, never drives anything. */
  peerText?: string[];
  /** Validated data parts from the peer (shape checked against the capability). */
  data?: Record<string, unknown>[];
  /** File parts from the peer: opaque, never fetched by the engine. */
  files?: FilePart[];
  artifactId?: string;
  lastChunk?: boolean;
}

export type TaskEffect =
  /** Ask our human whether to act on this task (confirm, free-form). */
  | { kind: 'start-gate'; taskId: string; peer: string; capability: string; approval: ApprovalClass; step: 'request' | 'input' }
  /** Do the work (auto, or after the start gate): `input` is the request's input, or the latest answer. */
  | { kind: 'start'; taskId: string; peer: string; capability: string; step: 'request' | 'input'; input?: unknown }
  /** Show the task to our human; nothing else is done (notify). */
  | { kind: 'notify'; taskId: string; peer: string; capability: string }
  /** Stop working on it and close any open gate (canceled, expired, evicted). */
  | { kind: 'abort'; taskId: string; peer: string; capability: string; code?: ReasonCode }
  /** This payload may leave only once our human approves it; call again with `released: true`. */
  | { kind: 'release-gate'; taskId: string; peer: string; capability: string; payload: TaskPayload };

export interface TaskOutgoing {
  to: string;
  payload: TaskPayload;
}

export interface TaskStep {
  state: TaskEngineState;
  outgoing: TaskOutgoing[];
  effects: TaskEffect[];
  events: TaskEvent[];
}

export class TaskError extends Error {}

/** The grant lets the peer invoke this capability (deny by default, no wildcard). */
function invokeLimits(invoke: TaskCtx['invoke'], uri: string): Record<string, unknown> | undefined {
  if (!invoke || typeof invoke !== 'object' || !Object.hasOwn(invoke, uri)) return undefined;
  const v = invoke[uri];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const taskCapable = (invoke: TaskCtx['invoke']) => !!invoke && typeof invoke === 'object' && Object.keys(invoke).some((k) => invokeLimits(invoke, k));

function maxOpen(cap: Capability | undefined, limits: Record<string, unknown>): number {
  const m = limits.max_open;
  if (Number.isSafeInteger(m) && (m as number) >= 1) return m as number;
  return cap?.maxOpen ?? MAX_OPEN_DEFAULT;
}

const RATE_UNITS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
/** A `max_frequency` ("<n>/<minute|hour|day>", SPEC §5.3), or null when absent or unreadable. */
export function parseRate(spec: unknown): { count: number; windowMs: number } | null {
  const m = typeof spec === 'string' ? /^(\d+)\/(minute|hour|day)$/.exec(spec) : null;
  return m ? { count: Number(m[1]), windowMs: RATE_UNITS[m[2]] } : null;
}

/** Stored send times within `windowMs` of `now`; an unreadable or future entry counts as `now` (fail closed). */
function recent(list: unknown, windowMs: number, now: number): number[] {
  if (!Array.isArray(list)) return [];
  return list.map((t) => (typeof t === 'number' && Number.isFinite(t) && t <= now ? t : now)).filter((t) => t > now - windowMs);
}

/** Forward transitions a requester accepts from the executor. */
function canMove(from: TaskLifecycleState, to: TaskLifecycleState): boolean {
  if (isFinished(from)) return false;
  if (isFinished(to)) return true;
  if (to === 'submitted') return from === 'submitted';
  return true; // working and input-required, from any open state
}

// ---------------------------------------------------------------------------

class Run {
  readonly state: TaskEngineState;
  readonly outgoing: TaskOutgoing[] = [];
  readonly effects: TaskEffect[] = [];
  readonly events: TaskEvent[] = [];
  readonly now: number;
  readonly nowIso: string;
  readonly newId: () => string;

  constructor(
    state: TaskEngineState,
    readonly ctx: TaskCtx,
  ) {
    this.state = structuredClone(state);
    this.state.dropped ??= {};
    this.now = ctx.now.getTime();
    this.nowIso = ctx.now.toISOString();
    this.newId = ctx.newId ?? (() => crypto.randomUUID());
  }

  result(): TaskStep {
    return { state: this.state, outgoing: this.outgoing, effects: this.effects, events: this.events };
  }

  event(e: TaskEvent): void {
    this.events.push(e);
  }

  task(id: string): TaskRecord | undefined {
    return Object.hasOwn(this.state.tasks, id) ? this.state.tasks[id] : undefined;
  }

  count(code: ReasonCode): void {
    this.state.dropped[code] = (this.state.dropped[code] ?? 0) + 1;
  }

  remember(task: TaskRecord, messageId: string): void {
    task.seen.push(messageId);
    if (task.seen.length > TASK_BOUNDS.seenPerTask) task.seen.splice(0, task.seen.length - TASK_BOUNDS.seenPerTask);
  }

  setState(task: TaskRecord, state: TaskLifecycleState, opts: { reason?: string; code?: ReasonCode } = {}): void {
    task.state = state;
    task.updated = this.nowIso;
    if (opts.reason !== undefined) task.reason = opts.reason;
    if (opts.code !== undefined) task.code = opts.code;
    if (isFinished(state)) {
      delete task.gate;
      delete task.input;
      delete task.answer;
      delete task.text;
      delete task.files;
    }
  }

  // --- what we send -------------------------------------------------------

  send(to: string, payload: TaskPayload): void {
    this.outgoing.push({ to, payload });
  }

  message(task: TaskRecord, data: TaskVerbData, extra: TaskPart[] = []): void {
    const message: TaskMessage = {
      kind: 'message',
      messageId: this.newId(),
      taskId: task.id,
      contextId: task.contextId,
      role: 'agent',
      parts: [{ kind: 'data', data: data as unknown as Record<string, unknown> }, ...extra],
      extensions: [TASKS_URI, ...(task.capability ? [task.capability] : []), ...(extra.some((x) => x.kind === 'file') ? [FILES_URI] : [])],
      ...(data.rdv === 'task/request' && task.referenceTaskIds?.length ? { referenceTaskIds: task.referenceTaskIds } : {}),
    };
    this.send(task.peer, { type: 'a2a/message', message });
  }

  statusPayload(
    to: { taskId: string; contextId: string },
    state: TaskLifecycleState,
    opts: { code?: ReasonCode; awaiting?: boolean; message?: StatusMessage; metadata?: Record<string, unknown> } = {},
  ): TaskPayload {
    const metadata: Record<string, unknown> = { ...opts.metadata };
    if (opts.code) metadata[REASON_KEY] = opts.code;
    if (opts.awaiting) metadata[AWAITING_KEY] = 'human';
    const update: TaskStatusUpdate = {
      kind: 'status-update',
      taskId: to.taskId,
      contextId: to.contextId,
      status: { state, timestamp: this.nowIso, ...(opts.message ? { message: opts.message } : {}) },
      final: isFinished(state),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    return { type: 'a2a/task-update', update };
  }

  status(task: TaskRecord, opts: { awaiting?: boolean; message?: StatusMessage } = {}): void {
    this.send(task.peer, this.statusPayload({ taskId: task.id, contextId: task.contextId }, task.state, { code: task.code, ...opts }));
  }

  /** A message for a finished task: tell the peer how it ended, at most `finishedReplies` times. */
  replyFinished(task: TaskRecord, messageId: string): void {
    this.remember(task, messageId);
    if ((task.finishedReplies ?? 0) >= TASK_BOUNDS.finishedReplies) return;
    task.finishedReplies = (task.finishedReplies ?? 0) + 1;
    this.status(task);
  }

  /**
   * Refuse a peer's task without keeping state: `rejected`, with the reason
   * code, counted for our human. Bounded by the envelope layer (one reply per
   * accepted envelope) and the grant's max_frequency.
   */
  refuse(from: string, m: TaskMessage, code: ReasonCode, reason: string, capability?: string): void {
    this.count(code);
    this.send(from, this.statusPayload({ taskId: m.taskId, contextId: m.contextId }, 'rejected', { code }));
    this.event({ kind: 'refused', taskId: m.taskId, peer: from, state: 'rejected', code, reason, ...(capability ? { capability } : {}) });
  }

  /** SPEC §7.5 unsupported reply, as in the meeting engine, plus the capability when that is what we lack. */
  replyUnsupported(from: string, m: UnsupportedMessage, capability?: string): void {
    const task = this.task(m.taskId);
    if (task && (task.peer !== from || task.contextId !== m.contextId)) return;
    if (!task && !taskCapable(this.ctx.invoke)) return;
    if (task) {
      if ((task.unsupportedReplies ?? 0) >= TASK_BOUNDS.unsupportedReplies) return;
      task.unsupportedReplies = (task.unsupportedReplies ?? 0) + 1;
    } else this.count('unsupported');
    const notice: Record<string, unknown> = { messageId: m.messageId };
    if (m.verb) notice.verb = m.verb;
    if (capability) notice.capability = capability;
    this.send(
      from,
      this.statusPayload({ taskId: m.taskId, contextId: m.contextId }, task?.state ?? 'rejected', {
        code: task ? task.code : 'unsupported',
        metadata: { [UNSUPPORTED_KEY]: notice },
      }),
    );
  }

  // --- bounds -------------------------------------------------------------

  get limiter(): TaskCtx['limit'] {
    return typeof this.ctx.limit === 'function' ? this.ctx.limit : undefined;
  }

  /** Could makeRoom(peer) succeed? Changes nothing. */
  hasRoom(peer: string): boolean {
    const mine = Object.values(this.state.tasks).filter((t) => t.peer === peer);
    return mine.length < TASK_BOUNDS.tasksPerPeer || mine.filter((t) => isFinished(t.state)).length >= mine.length - TASK_BOUNDS.tasksPerPeer + 1;
  }

  /** Make room for one more task with `peer`: evict its oldest finished tasks, tombstones first. False if all are open. */
  makeRoom(peer: string): boolean {
    const mine = Object.values(this.state.tasks).filter((t) => t.peer === peer);
    if (mine.length < TASK_BOUNDS.tasksPerPeer) return true;
    const finished = mine.filter((t) => isFinished(t.state)).sort((a, b) => Number(!!b.tombstone) - Number(!!a.tombstone) || a.updated.localeCompare(b.updated));
    const excess = mine.length - TASK_BOUNDS.tasksPerPeer + 1;
    if (finished.length < excess) return false;
    for (const t of finished.slice(0, excess)) delete this.state.tasks[t.id];
    return true;
  }

  /** Open tasks this peer has with us for `capability`. */
  openFor(peer: string, capability: string): number {
    return Object.values(this.state.tasks).filter((t) => t.role === 'executor' && t.peer === peer && t.capability === capability && !isFinished(t.state)).length;
  }

  /**
   * Keep the tasks waiting for our human within bounds (per peer, then in
   * all): reject the weakest, lowest tier first, then the oldest, the newcomer
   * included (NOTES 46).
   */
  boundWaiting(peer: string): void {
    const waiting = (only?: string) => Object.values(this.state.tasks).filter((t) => t.role === 'executor' && t.gate && !isFinished(t.state) && (only === undefined || t.peer === only));
    const weakest = (list: TaskRecord[]) =>
      list.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.gate!.since.localeCompare(b.gate!.since) || a.created.localeCompare(b.created) || a.id.localeCompare(b.id))[0];
    for (let list = waiting(peer); list.length > TASK_BOUNDS.waitingPerPeer; list = waiting(peer)) this.evict(weakest(list));
    for (let list = waiting(); list.length > TASK_BOUNDS.waitingTotal; list = waiting()) this.evict(weakest(list));
  }

  evict(task: TaskRecord): void {
    this.setState(task, 'rejected', { reason: 'too many tasks waiting for your approval', code: 'busy' });
    this.count('busy');
    this.effects.push({ kind: 'abort', taskId: task.id, peer: task.peer, capability: task.capability, code: 'busy' });
    this.status(task);
    this.event({ kind: 'evicted', taskId: task.id, peer: task.peer, state: task.state, capability: task.capability, code: 'busy', reason: task.reason });
  }

  /** Default and clamp a peer-supplied `expires`. */
  peerExpires(expires: string | undefined): string {
    const max = this.now + TASK_BOUNDS.expiresMaxMs;
    const want = parseInstant(expires) ?? this.now + TASK_BOUNDS.expiresDefaultMs;
    return new Date(Math.min(want, max)).toISOString();
  }

  /** An open task past its `expires` ends: the executor tells the requester, the requester withdraws. */
  expireIfDue(task: TaskRecord): boolean {
    if (isFinished(task.state) || task.expires === null) return false;
    const exp = parseInstant(task.expires);
    if (exp !== null && !(this.now > exp)) return false; // unreadable counts as expired (fail closed)
    if (task.role === 'executor') {
      this.setState(task, task.state === 'submitted' ? 'rejected' : 'failed', { reason: 'expired', code: 'expired' });
      this.effects.push({ kind: 'abort', taskId: task.id, peer: task.peer, capability: task.capability, code: 'expired' });
      this.status(task);
    } else {
      this.setState(task, 'canceled', { reason: 'expired', code: 'expired' });
      this.message(task, { rdv: 'rdv/cancel', reason: 'expired' });
    }
    this.event({ kind: 'expired', taskId: task.id, peer: task.peer, state: task.state, capability: task.capability, code: 'expired', reason: 'expired' });
    return true;
  }

  prune(): void {
    const finished = Object.values(this.state.tasks)
      .filter((t) => isFinished(t.state))
      .sort((a, b) => a.updated.localeCompare(b.updated));
    let excess = finished.length - TASK_BOUNDS.keepFinished;
    for (const t of finished) {
      if (excess > 0 || this.now - Date.parse(t.updated) > TASK_BOUNDS.keepFinishedMs) {
        delete this.state.tasks[t.id];
        excess--;
      }
    }
  }

  // --- our own content ----------------------------------------------------

  /** Check parts we are about to send; throws TaskError (our own bug or the caller's input, never peer input). */
  ownParts(cap: Capability, parts: TaskPart[], kinds: readonly TaskPart['kind'][], what: string): void {
    if (parts.length === 0 || parts.length > TASK_LIMITS.parts) throw new TaskError(`${what}: 1–${TASK_LIMITS.parts} parts`);
    for (const p of parts) {
      if (!kinds.includes(p.kind)) throw new TaskError(`${what}: ${p.kind} parts are not allowed here`);
      if (p.kind === 'text' && (typeof p.text !== 'string' || p.text.length > TASK_LIMITS.textChars)) throw new TaskError(`${what}: a text part is at most ${TASK_LIMITS.textChars} characters`);
      if (p.kind === 'data') {
        try {
          checkData(cap, p.data);
        } catch (err) {
          if (err instanceof SchemaError) throw new TaskError(`${what}: ${err.message}`);
          throw err;
        }
      }
    }
  }

  /** Under a release-gated class, a payload with content leaves only once released. */
  gated(task: TaskRecord, payload: TaskPayload, opts: { released?: boolean; ownerData?: boolean }): boolean {
    const gate = needsReleaseGate(task.approval ?? 'free-form') || opts.ownerData === true;
    if (!gate || opts.released === true) return false;
    this.effects.push({ kind: 'release-gate', taskId: task.id, peer: task.peer, capability: task.capability, payload });
    return true;
  }
}

/** Data parts in peer content, checked against the task's capability. Throws SchemaError. */
function peerParts(cap: Capability | undefined, parts: readonly TaskPart[]): { text: string[]; data: Record<string, unknown>[]; files: FilePart[] } {
  const text: string[] = [];
  const data: Record<string, unknown>[] = [];
  const files: FilePart[] = [];
  for (const p of parts) {
    if (p.kind === 'text') text.push(p.text);
    else if (p.kind === 'file') files.push(p);
    else {
      if (!cap) throw new SchemaError('data: the capability is not one we know');
      data.push(checkData(cap, p.data));
    }
  }
  return { text, data, files };
}

// --- receive ----------------------------------------------------------------

/** Handle one decrypted tasks/v1 payload from `from`. Invalid input changes nothing and sends nothing. */
export function receiveTask(state: TaskEngineState, from: string, payload: unknown, ctx: TaskCtx): TaskStep {
  const run = new Run(state, ctx);
  handle(run, from, payload);
  run.prune();
  return run.result();
}

function handle(run: Run, from: string, payload: unknown): void {
  const parsed = parseTaskPayload(payload);
  if (!parsed.ok) {
    run.event({ kind: 'invalid', taskId: parsed.unsupported?.taskId ?? null, peer: from, reason: parsed.reason });
    if (parsed.unsupported) run.replyUnsupported(from, parsed.unsupported);
    return;
  }
  const v = parsed.value;
  if (v.kind === 'update') return onStatus(run, from, v.update, v);
  if (v.kind === 'artifact') return onArtifact(run, from, v.update.taskId, v.update.contextId, v.update.artifact, v.update);
  return onMessage(run, from, v.message, v.data, v.text, v.files);
}

/** Requester: the executor's state change. */
function onStatus(run: Run, from: string, u: TaskStatusUpdate, meta: { unsupported?: { messageId: string; verb?: string; capability?: string }; reason?: ReasonCode; awaitingHuman?: boolean }): void {
  const task = run.task(u.taskId);
  if (!task || task.peer !== from || task.contextId !== u.contextId || task.role !== 'requester') {
    run.event({ kind: 'ignored', taskId: u.taskId, peer: from, reason: 'status update for a task we did not request' });
    return;
  }
  if (task.updates >= TASK_BOUNDS.updatesPerTask) {
    run.event({ kind: 'ignored', taskId: task.id, peer: from, state: task.state, reason: `more than ${TASK_BOUNDS.updatesPerTask} status updates` });
    return;
  }
  task.updates += 1;
  if (meta.unsupported) {
    const what = meta.unsupported.capability === task.capability ? 'this capability' : meta.unsupported.verb === 'task/request' || meta.unsupported.verb === 'task/input' || meta.unsupported.verb === 'rdv/cancel' ? meta.unsupported.verb : 'one of our messages';
    run.event({ kind: 'unsupported', taskId: task.id, peer: from, state: task.state, capability: task.capability, reason: `the peer's agent does not support ${what}` });
  }
  const to = u.status.state;
  if (to === task.state && !u.status.message) return; // a repeat (e.g. awaiting human): nothing new
  if (!canMove(task.state, to)) {
    run.event({ kind: 'ignored', taskId: task.id, peer: from, state: task.state, reason: `peer reports ${to} after ${task.state}` });
    return;
  }
  let shown: ReturnType<typeof peerParts> = { text: [], data: [], files: [] };
  if (u.status.message) {
    try {
      shown = peerParts(run.ctx.registry.get(task.capability), u.status.message.parts);
    } catch (err) {
      if (!(err instanceof SchemaError)) throw err;
      run.event({ kind: 'invalid', taskId: task.id, peer: from, state: task.state, reason: err.message });
      return;
    }
  }
  run.setState(task, to, isFinished(to) ? { reason: `peer reports ${to}`, ...(meta.reason ? { code: meta.reason } : {}) } : {});
  const kind: TaskEventKind = isFinished(to) ? (to as TaskEventKind) : to === 'input-required' ? 'input-required' : 'status';
  run.event({
    kind,
    taskId: task.id,
    peer: from,
    state: task.state,
    capability: task.capability,
    ...(meta.reason ? { code: meta.reason } : {}),
    ...(meta.awaitingHuman ? { reason: "waiting for the peer's human" } : {}),
    ...(shown.text.length ? { peerText: shown.text } : {}),
    ...(shown.data.length ? { data: shown.data } : {}),
  });
}

/** Requester: a result, or a chunk of one. */
function onArtifact(run: Run, from: string, taskId: string, contextId: string, artifact: Artifact, u: { append?: boolean; lastChunk?: boolean }): void {
  const task = run.task(taskId);
  if (!task || task.peer !== from || task.contextId !== contextId || task.role !== 'requester') {
    run.event({ kind: 'ignored', taskId, peer: from, reason: 'artifact for a task we did not request' });
    return;
  }
  const ignored = (reason: string) => run.event({ kind: 'ignored', taskId, peer: from, state: task.state, reason });
  if (isFinished(task.state)) return ignored(`artifact after ${task.state}`);
  if (task.chunks >= TASK_BOUNDS.chunksPerTask) return ignored(`more than ${TASK_BOUNDS.chunksPerTask} artifact chunks`);
  const known = task.artifacts.find((a) => a.artifactId === artifact.artifactId);
  if (!known && task.artifacts.length >= TASK_BOUNDS.artifactsPerTask) return ignored(`more than ${TASK_BOUNDS.artifactsPerTask} artifacts`);
  if (known?.done && u.append) return ignored('chunk after the last chunk');
  let shown: ReturnType<typeof peerParts>;
  try {
    shown = peerParts(run.ctx.registry.get(task.capability), artifact.parts);
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    run.event({ kind: 'invalid', taskId, peer: from, state: task.state, reason: err.message });
    return;
  }
  task.chunks += 1;
  const rec: ArtifactRecord = known ?? { artifactId: artifact.artifactId, chunks: 0, done: false };
  if (!known) task.artifacts.push(rec);
  rec.chunks = u.append ? rec.chunks + 1 : 1; // append: false replaces the artifact (A2A)
  rec.done = u.lastChunk === true;
  if (artifact.name !== undefined) rec.name = artifact.name;
  task.updated = run.nowIso;
  run.event({
    kind: 'artifact',
    taskId,
    peer: from,
    state: task.state,
    capability: task.capability,
    artifactId: artifact.artifactId,
    lastChunk: rec.done,
    ...(shown.text.length ? { peerText: shown.text } : {}),
    ...(shown.data.length ? { data: shown.data } : {}),
    ...(shown.files.length ? { files: shown.files } : {}),
  });
}

/** Executor: the requester's turn. */
function onMessage(run: Run, from: string, m: TaskMessage, data: TaskVerbData, text: string[], files: FilePart[]): void {
  const existing = run.task(m.taskId);
  const invalid = (reason: string) => run.event({ kind: 'invalid', taskId: m.taskId, peer: from, reason });
  if (existing && existing.peer !== from) return invalid('task belongs to another peer');
  if (existing && existing.contextId !== m.contextId) return invalid('contextId does not match the task');
  if (existing?.seen.includes(m.messageId)) {
    run.event({ kind: 'duplicate', taskId: m.taskId, peer: from, state: existing.state });
    return;
  }
  if (existing && existing.role !== 'executor') return invalid(`${data.rdv} for a task we requested`);
  const ctx = run.ctx;

  if (data.rdv === 'rdv/cancel') {
    if (!existing) {
      // Cancel overtook the request: a tombstone refuses the request when it lands.
      if (!taskCapable(ctx.invoke)) return invalid('the grant allows no tasks (invoke)');
      if (!run.makeRoom(from)) return invalid(`too many tasks with this peer (max ${TASK_BOUNDS.tasksPerPeer})`);
      const task = newTask(run, m, from, '', null);
      task.state = 'canceled';
      task.tombstone = true;
      task.reason = 'canceled by peer before the request arrived';
      run.state.tasks[task.id] = task;
      run.status(task);
      run.event({ kind: 'canceled', taskId: task.id, peer: from, state: task.state, reason: task.reason, peerText: text });
      return;
    }
    if (isFinished(existing.state)) {
      run.replyFinished(existing, m.messageId);
      run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `cancel after ${existing.state}` });
      return;
    }
    run.remember(existing, m.messageId);
    run.setState(existing, 'canceled', { reason: 'canceled by peer' });
    run.effects.push({ kind: 'abort', taskId: existing.id, peer: from, capability: existing.capability });
    run.status(existing);
    run.event({ kind: 'canceled', taskId: existing.id, peer: from, state: existing.state, capability: existing.capability, reason: existing.reason, peerText: text });
    return;
  }

  if (data.rdv === 'task/input') {
    if (!existing) return invalid('task/input for an unknown task');
    if (isFinished(existing.state)) {
      run.replyFinished(existing, m.messageId);
      run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `task/input after ${existing.state}` });
      return;
    }
    const cap = ctx.registry.get(existing.capability);
    if (!cap || !invokeLimits(ctx.invoke, existing.capability)) return invalid('the grant no longer allows this capability (invoke)');
    if (existing.state !== 'input-required') return invalid(`task/input while ${existing.state}`);
    if (existing.inputs >= TASK_BOUNDS.inputsPerTask) return invalid(`more than ${TASK_BOUNDS.inputsPerTask} task/input`);
    let answer: unknown;
    try {
      answer = checkInput(cap, data.input, true);
    } catch (err) {
      if (!(err instanceof SchemaError)) throw err;
      return invalid(err.message);
    }
    run.remember(existing, m.messageId);
    existing.inputs += 1;
    if (answer === undefined) delete existing.answer;
    else existing.answer = answer;
    run.setState(existing, 'working');
    run.event({ kind: 'input', taskId: existing.id, peer: from, state: existing.state, capability: cap.uri, peerText: text, ...(files.length ? { files } : {}) });
    if (needsStartGate(cap.approval)) {
      existing.gate = { kind: 'start', step: 'input', since: run.nowIso };
      run.effects.push({ kind: 'start-gate', taskId: existing.id, peer: from, capability: cap.uri, approval: cap.approval, step: 'input' });
      run.event({ kind: 'start-needed', taskId: existing.id, peer: from, state: existing.state, capability: cap.uri });
      run.status(existing, { awaiting: true });
      run.boundWaiting(from);
    } else {
      run.effects.push({ kind: 'start', taskId: existing.id, peer: from, capability: cap.uri, step: 'input', ...(answer !== undefined ? { input: answer } : {}) });
      run.status(existing);
    }
    return;
  }

  // task/request
  if (existing) {
    if (isFinished(existing.state)) {
      run.replyFinished(existing, m.messageId);
      run.event({ kind: 'ignored', taskId: existing.id, peer: from, state: existing.state, reason: `request for a ${existing.state} task` });
      return;
    }
    return invalid('a second request for the same task');
  }
  if (!taskCapable(ctx.invoke)) return invalid('the grant allows no tasks (invoke)');
  const cap = ctx.registry.get(data.capability);
  if (!cap) {
    run.event({ kind: 'refused', taskId: m.taskId, peer: from, state: 'rejected', code: 'unsupported', reason: 'unsupported capability' });
    run.replyUnsupported(from, { messageId: m.messageId, taskId: m.taskId, contextId: m.contextId, verb: 'task/request' }, data.capability);
    return;
  }
  const limits = invokeLimits(ctx.invoke, cap.uri);
  if (!limits) return run.refuse(from, m, 'scope', 'the grant does not allow this capability (invoke)', cap.uri);
  let input: unknown;
  try {
    input = checkInput(cap, data.input);
  } catch (err) {
    if (!(err instanceof SchemaError)) throw err;
    return run.refuse(from, m, 'input', err.message, cap.uri);
  }
  const open = run.openFor(from, cap.uri);
  const most = maxOpen(cap, limits);
  if (!run.limiter && open >= most) return run.refuse(from, m, 'rate', `too many open ${cap.uri} tasks (max_open ${most})`, cap.uri);
  // Not a per-capability limit: checked before the limiter, so it is not counted towards gross abuse.
  if (!run.hasRoom(from)) return run.refuse(from, m, 'rate', `too many open tasks with this peer (max ${TASK_BOUNDS.tasksPerPeer})`, cap.uri);
  if (run.limiter) {
    const verdict = run.limiter(cap.uri, { open, maxOpen: most });
    if (!verdict.ok) return run.refuse(from, m, verdict.code === 'scope' ? 'scope' : 'rate', verdict.reason, cap.uri);
  }
  run.makeRoom(from);

  const task = newTask(run, m, from, cap.uri, run.peerExpires(data.expires));
  task.approval = cap.approval;
  if (ctx.tier !== undefined) task.tier = ctx.tier;
  if (input !== undefined) task.input = input;
  if (text.length) task.text = text;
  if (files.length) task.files = files;
  if (m.referenceTaskIds?.length) task.referenceTaskIds = [...m.referenceTaskIds];
  run.state.tasks[task.id] = task;
  run.event({ kind: 'received', taskId: task.id, peer: from, state: task.state, capability: cap.uri, peerText: text, ...(files.length ? { files } : {}) });
  if (run.expireIfDue(task)) return;
  switch (cap.approval) {
    case 'notify':
      run.setState(task, 'completed');
      run.effects.push({ kind: 'notify', taskId: task.id, peer: from, capability: cap.uri });
      run.status(task);
      return;
    case 'auto':
      run.setState(task, 'working');
      run.effects.push({ kind: 'start', taskId: task.id, peer: from, capability: cap.uri, step: 'request', ...(input !== undefined ? { input } : {}) });
      run.status(task);
      return;
    default:
      task.gate = { kind: 'start', step: 'request', since: run.nowIso };
      run.effects.push({ kind: 'start-gate', taskId: task.id, peer: from, capability: cap.uri, approval: cap.approval, step: 'request' });
      run.event({ kind: 'start-needed', taskId: task.id, peer: from, state: task.state, capability: cap.uri });
      run.status(task, { awaiting: true });
      run.boundWaiting(from);
  }
}

function newTask(run: Run, m: { taskId: string; contextId: string; messageId?: string }, peer: string, capability: string, expires: string | null): TaskRecord {
  return {
    id: m.taskId,
    contextId: m.contextId,
    peer,
    role: 'executor',
    capability,
    state: 'submitted',
    expires,
    seen: m.messageId ? [m.messageId] : [],
    inputs: 0,
    updates: 0,
    artifacts: [],
    chunks: 0,
    created: run.nowIso,
    updated: run.nowIso,
  };
}

// --- the requester's steps --------------------------------------------------

export interface RequestOptions {
  input?: unknown;
  /** Human-readable request (text parts). */
  text?: string[];
  /** File parts, sent as given (the host validates them, SPEC §7.7); the message then lists the files extension. */
  files?: FilePart[];
  expires?: string;
  contextId?: string;
  referenceTaskIds?: string[];
  /** The `capabilities` of the peer's card, when known: refuse to send what it does not advertise (SPEC §4.3). */
  peerCapabilities?: readonly string[];
}

/**
 * Would one more task for `capability` on `peer` go over the peer's grant to
 * us (`ctx.invoke`: `max_open`, default the capability's or 4, and
 * `max_frequency`)? The reason, or null when it may be sent. The peer's
 * limiter would refuse it (`rate`), and enough refusals revoke the grant
 * (SPEC §5.3), so our agent checks before sending; requestTask does.
 */
export function outboundLimit(state: TaskEngineState, peer: string, capability: string, ctx: Pick<TaskCtx, 'now' | 'invoke' | 'registry'>): string | null {
  const limits = invokeLimits(ctx.invoke, capability);
  if (!limits) return `the peer's grant does not let us invoke ${capability}`;
  const now = ctx.now.getTime();
  if (!Number.isFinite(now)) return 'our clock is unreadable';
  const most = maxOpen(ctx.registry.get(capability), limits);
  const open = Object.values(state.tasks).filter((t) => t.role === 'requester' && t.peer === peer && t.capability === capability && !isFinished(t.state)).length;
  if (open >= most) return `${open} ${capability} tasks are open with this peer (its grant allows max_open ${most})`;
  const rate = parseRate(limits.max_frequency);
  const sent = state.sent && Object.hasOwn(state.sent, peer) && Object.hasOwn(state.sent[peer], capability) ? state.sent[peer][capability] : [];
  if (rate && recent(sent, rate.windowMs, now).length >= rate.count) return `the peer's grant allows ${String(limits.max_frequency)} for ${capability}; wait before sending another`;
  return null;
}

/** Record a task/request we send, for outboundLimit (only what the peer's grant limits; pruned to its window). */
function recordSent(run: Run, peer: string, capability: string): void {
  const rate = parseRate(invokeLimits(run.ctx.invoke, capability)?.max_frequency);
  const all = (run.state.sent ??= {});
  const mine = Object.hasOwn(all, peer) ? all[peer] : (all[peer] = {});
  if (rate) mine[capability] = [...recent(mine[capability], rate.windowMs, run.now), run.now].slice(-Math.max(rate.count, 1));
  else delete mine[capability];
  for (const [p, caps] of Object.entries(all)) {
    for (const k of Object.keys(caps)) if (!caps[k].length) delete caps[k];
    if (!Object.keys(caps).length) delete all[p];
  }
  if (!Object.keys(all).length) delete run.state.sent;
}

/** Open a task on `peer`. Throws TaskError when the capability, grant, its limits (outboundLimit), card or bounds rule it out. */
export function requestTask(state: TaskEngineState, peer: string, capability: string, ctx: TaskCtx, opts: RequestOptions = {}): TaskStep & { taskId: string } {
  const cap = ctx.registry.get(capability);
  if (!cap) throw new TaskError(`unknown capability ${capability}`);
  const over = outboundLimit(state, peer, capability, ctx);
  if (over) throw new TaskError(over);
  const run = new Run(state, ctx);
  if (opts.peerCapabilities && !(opts.peerCapabilities.includes(TASKS_URI) && opts.peerCapabilities.includes(capability))) {
    throw new TaskError(`the peer's card does not advertise ${opts.peerCapabilities.includes(TASKS_URI) ? capability : TASKS_URI}`);
  }
  let input: unknown;
  try {
    input = checkInput(cap, opts.input);
  } catch (err) {
    if (err instanceof SchemaError) throw new TaskError(err.message);
    throw err;
  }
  const expires = opts.expires ?? new Date(run.now + TASK_BOUNDS.expiresDefaultMs).toISOString();
  const exp = parseInstant(expires);
  if (exp === null || !(exp > run.now)) throw new TaskError('expires must be an RFC 3339 date-time in the future');
  if (exp > run.now + TASK_BOUNDS.expiresMaxMs) throw new TaskError('expires may be at most 7 days ahead');
  const extra: TaskPart[] = [...(opts.text ?? []).map((t): TaskTextPart => ({ kind: 'text', text: t })), ...(opts.files ?? [])];
  if (extra.length + 1 > TASK_LIMITS.parts) throw new TaskError(`a message has at most ${TASK_LIMITS.parts} parts`);
  if (extra.some((p) => p.kind === 'text' && p.text.length > TASK_LIMITS.textChars)) throw new TaskError(`a text part is at most ${TASK_LIMITS.textChars} characters`);
  if (opts.contextId !== undefined && !isUuid(opts.contextId)) throw new TaskError('contextId must be a UUID');
  if (opts.referenceTaskIds && (opts.referenceTaskIds.length > TASK_LIMITS.listItems || !opts.referenceTaskIds.every(isUuid))) {
    throw new TaskError(`referenceTaskIds: at most ${TASK_LIMITS.listItems} UUIDs`);
  }
  if (!run.makeRoom(peer)) throw new TaskError(`too many open tasks with ${peer} (max ${TASK_BOUNDS.tasksPerPeer})`);
  const task: TaskRecord = {
    ...newTask(run, { taskId: run.newId(), contextId: opts.contextId ?? run.newId() }, peer, cap.uri, expires),
    role: 'requester',
    approval: cap.approval,
    ...(opts.referenceTaskIds?.length ? { referenceTaskIds: [...opts.referenceTaskIds] } : {}),
  };
  run.state.tasks[task.id] = task;
  recordSent(run, peer, cap.uri);
  run.message(task, { rdv: 'task/request', capability: cap.uri, ...(input !== undefined ? { input } : {}), expires }, extra);
  run.event({ kind: 'requested', taskId: task.id, peer, state: task.state, capability: cap.uri });
  return { ...run.result(), taskId: task.id };
}

/** Answer an `input-required` status. Throws TaskError otherwise. */
export function inputTask(state: TaskEngineState, taskId: string, ctx: TaskCtx, opts: { input?: unknown; text?: string[] } = {}): TaskStep {
  const run = new Run(state, ctx);
  const task = run.task(taskId);
  if (!task || task.role !== 'requester') throw new TaskError(`no task ${taskId} that we requested`);
  if (task.state !== 'input-required') throw new TaskError(`task ${taskId} is ${task.state}, not input-required`);
  if (task.inputs >= TASK_BOUNDS.inputsPerTask) throw new TaskError(`at most ${TASK_BOUNDS.inputsPerTask} task/input per task`);
  const cap = ctx.registry.get(task.capability);
  if (!cap) throw new TaskError(`unknown capability ${task.capability}`);
  let answer: unknown;
  try {
    answer = checkInput(cap, opts.input, true);
  } catch (err) {
    if (err instanceof SchemaError) throw new TaskError(err.message);
    throw err;
  }
  const text = (opts.text ?? []).map((t): TaskTextPart => ({ kind: 'text', text: t }));
  if (text.length + 1 > TASK_LIMITS.parts || text.some((p) => p.text.length > TASK_LIMITS.textChars)) throw new TaskError('too many or too long text parts');
  task.inputs += 1;
  run.setState(task, 'working');
  run.message(task, answer !== undefined ? { rdv: 'task/input', input: answer } : { rdv: 'task/input' }, text);
  run.event({ kind: 'input', taskId, peer: task.peer, state: task.state, capability: task.capability });
  return run.result();
}

/** Withdraw a task we requested (`rdv/cancel`). Throws TaskError when it is not ours or already finished. */
export function cancelTask(state: TaskEngineState, taskId: string, ctx: TaskCtx, reason?: string): TaskStep {
  const run = new Run(state, ctx);
  const task = run.task(taskId);
  if (!task || task.role !== 'requester') throw new TaskError(`no task ${taskId} that we requested`);
  if (isFinished(task.state)) throw new TaskError(`task ${taskId} already ${task.state}`);
  if (reason !== undefined && (reason.length === 0 || reason.length > TASK_LIMITS.shortText)) throw new TaskError(`reason must be 1–${TASK_LIMITS.shortText} characters`);
  run.setState(task, 'canceled', { reason: reason ?? 'canceled by us' });
  run.message(task, reason ? { rdv: 'rdv/cancel', reason } : { rdv: 'rdv/cancel' });
  run.event({ kind: 'canceled', taskId, peer: task.peer, state: task.state, capability: task.capability, reason: task.reason });
  return run.result();
}

// --- the executor's steps ---------------------------------------------------

function executorTask(run: Run, taskId: string): TaskRecord & { approval: ApprovalClass } {
  const task = run.task(taskId);
  if (!task || task.role !== 'executor' || task.tombstone) throw new TaskError(`no task ${taskId} from a peer`);
  if (isFinished(task.state)) throw new TaskError(`task ${taskId} already ${task.state}`);
  return task as TaskRecord & { approval: ApprovalClass };
}

/**
 * Before acting on or sending anything for a peer's task, re-check that we
 * still implement its capability and that the current grant still allows it
 * (`invoke` may have been narrowed or revoked since the task arrived). If not,
 * the task ends with code `scope` (`rejected` if it never started, else
 * `failed`), the work is aborted and the peer told; nothing else is sent.
 */
function scopeLost(run: Run, task: TaskRecord): boolean {
  if (run.ctx.registry.get(task.capability) && invokeLimits(run.ctx.invoke, task.capability)) return false;
  const started = task.state !== 'submitted';
  run.setState(task, started ? 'failed' : 'rejected', { reason: 'the grant no longer allows this capability', code: 'scope' });
  run.effects.push({ kind: 'abort', taskId: task.id, peer: task.peer, capability: task.capability, code: 'scope' });
  run.status(task);
  run.event({ kind: started ? 'failed' : 'rejected', taskId: task.id, peer: task.peer, state: task.state, capability: task.capability, code: 'scope', reason: task.reason });
  return true;
}

/** The start gate passed (our human approved, or a policy did): act on the task. */
export function startTask(state: TaskEngineState, taskId: string, ctx: TaskCtx): TaskStep {
  const run = new Run(state, ctx);
  const task = executorTask(run, taskId);
  if (scopeLost(run, task)) return run.result();
  if (!task.gate) throw new TaskError(`task ${taskId} is not waiting for approval`);
  if (run.expireIfDue(task)) return run.result();
  const step = task.gate.step;
  delete task.gate;
  run.setState(task, 'working');
  const input = step === 'input' ? task.answer : task.input;
  run.effects.push({ kind: 'start', taskId, peer: task.peer, capability: task.capability, step, ...(input !== undefined ? { input } : {}) });
  run.status(task);
  run.event({ kind: 'started', taskId, peer: task.peer, state: task.state, capability: task.capability });
  return run.result();
}

/** Our human said no at the start gate, or we refuse the task before starting it: `rejected`. */
export function rejectTask(state: TaskEngineState, taskId: string, ctx: TaskCtx): TaskStep {
  const run = new Run(state, ctx);
  const task = executorTask(run, taskId);
  if (task.state !== 'submitted' && !task.gate) throw new TaskError(`task ${taskId} has started; use finish(..., 'failed')`);
  run.setState(task, 'rejected', { reason: 'declined by us', code: 'human' });
  run.effects.push({ kind: 'abort', taskId, peer: task.peer, capability: task.capability, code: 'human' });
  run.status(task);
  run.event({ kind: 'rejected', taskId, peer: task.peer, state: task.state, capability: task.capability, code: 'human', reason: task.reason });
  return run.result();
}

export interface ReleaseOptions {
  /** The release gate passed for exactly this content. */
  released?: boolean;
  /** The content carries owner data or a model's output: gate it whatever the class (SPEC §5.5). */
  ownerData?: boolean;
}

function statusMessage(run: Run, task: TaskRecord, cap: Capability, content: { text?: string; data?: Record<string, unknown> }): StatusMessage | undefined {
  const parts: (TaskTextPart | TaskDataPart)[] = [];
  if (content.text !== undefined) parts.push({ kind: 'text', text: content.text });
  if (content.data !== undefined) parts.push({ kind: 'data', data: content.data });
  if (parts.length === 0) return undefined;
  run.ownParts(cap, parts, ['text', 'data'], 'status message');
  return { kind: 'message', messageId: run.newId(), taskId: task.id, contextId: task.contextId, role: 'agent', parts };
}

/** Ask the requester for more: `input-required`, with the question as text and/or a data part of the capability. */
export function askInput(state: TaskEngineState, taskId: string, ctx: TaskCtx, content: { text?: string; data?: Record<string, unknown> }, opts: ReleaseOptions = {}): TaskStep {
  const run = new Run(state, ctx);
  const task = executorTask(run, taskId);
  if (scopeLost(run, task)) return run.result();
  if (task.state !== 'working' || task.gate) throw new TaskError(`task ${taskId} is not being worked on`);
  if (task.inputs >= TASK_BOUNDS.inputsPerTask) throw new TaskError(`the requester may answer at most ${TASK_BOUNDS.inputsPerTask} times`);
  const cap = ctx.registry.get(task.capability);
  if (!cap) throw new TaskError(`unknown capability ${task.capability}`);
  const message = statusMessage(run, task, cap, content);
  if (!message) throw new TaskError('input-required needs a question (text or data)');
  const payload = run.statusPayload({ taskId, contextId: task.contextId }, 'input-required', { message });
  if (run.gated(task, payload, opts)) return run.result();
  run.setState(task, 'input-required');
  run.send(task.peer, payload);
  run.event({ kind: 'input-required', taskId, peer: task.peer, state: task.state, capability: task.capability });
  return run.result();
}

/**
 * Send a result, or a chunk of one. Release-gated under confirm and free-form
 * (or with `ownerData`): the gated call returns the `artifactId` it chose, and
 * the call with `released: true` must pass it back so the payload that leaves
 * is the one the human saw.
 */
export function sendArtifact(
  state: TaskEngineState,
  taskId: string,
  ctx: TaskCtx,
  artifact: { artifactId?: string; name?: string; description?: string; parts: TaskPart[]; append?: boolean; lastChunk?: boolean },
  opts: ReleaseOptions = {},
): TaskStep & { artifactId: string } {
  const run = new Run(state, ctx);
  const task = executorTask(run, taskId);
  if (scopeLost(run, task)) return { ...run.result(), artifactId: artifact.artifactId ?? '' };
  if (task.state !== 'working' || task.gate) throw new TaskError(`task ${taskId} is not being worked on`);
  const cap = ctx.registry.get(task.capability);
  if (!cap) throw new TaskError(`unknown capability ${task.capability}`);
  run.ownParts(cap, artifact.parts, ['text', 'data', 'file'], 'artifact');
  if (artifact.name !== undefined && (artifact.name.length === 0 || artifact.name.length > TASK_LIMITS.shortText)) throw new TaskError('artifact name: 1–200 characters');
  if (artifact.description !== undefined && (artifact.description.length === 0 || artifact.description.length > TASK_LIMITS.description)) throw new TaskError('artifact description too long');
  const artifactId = artifact.artifactId ?? run.newId();
  const known = task.artifacts.find((a) => a.artifactId === artifactId);
  if (!known && task.artifacts.length >= TASK_BOUNDS.artifactsPerTask) throw new TaskError(`at most ${TASK_BOUNDS.artifactsPerTask} artifacts per task`);
  if (task.chunks >= TASK_BOUNDS.chunksPerTask) throw new TaskError(`at most ${TASK_BOUNDS.chunksPerTask} artifact chunks per task`);
  if (known?.done && artifact.append) throw new TaskError('the artifact is already complete');
  const body: Artifact = {
    artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    parts: artifact.parts,
    extensions: artifactExtensions(cap.uri, artifact.parts),
  };
  const payload: TaskPayload = {
    type: 'a2a/artifact-update',
    update: {
      kind: 'artifact-update',
      taskId,
      contextId: task.contextId,
      artifact: body,
      ...(artifact.append !== undefined ? { append: artifact.append } : {}),
      ...(artifact.lastChunk !== undefined ? { lastChunk: artifact.lastChunk } : {}),
    },
  };
  if (run.gated(task, payload, opts)) return { ...run.result(), artifactId };
  const rec = known ?? { artifactId, chunks: 0, done: false };
  if (!known) task.artifacts.push(rec);
  rec.chunks = artifact.append ? rec.chunks + 1 : 1;
  rec.done = artifact.lastChunk === true;
  if (artifact.name !== undefined) rec.name = artifact.name;
  task.chunks += 1;
  task.updated = run.nowIso;
  run.send(task.peer, payload);
  run.event({ kind: 'artifact', taskId, peer: task.peer, state: task.state, capability: task.capability, artifactId, lastChunk: rec.done });
  return { ...run.result(), artifactId };
}

/** An artifact's `extensions`: its capability, and the files extension when it carries file parts (SPEC §7.6.1). */
export function artifactExtensions(capability: string, parts: readonly TaskPart[]): string[] {
  return parts.some((p) => p.kind === 'file') ? [capability, FILES_URI] : [capability];
}

/** End a started task: `completed` or `failed`, optionally with a message (release-gated when it has content). */
export function finishTask(
  state: TaskEngineState,
  taskId: string,
  ctx: TaskCtx,
  outcome: 'completed' | 'failed',
  content: { text?: string; data?: Record<string, unknown> } = {},
  opts: ReleaseOptions = {},
): TaskStep {
  const run = new Run(state, ctx);
  const task = executorTask(run, taskId);
  if (scopeLost(run, task)) return run.result();
  if (task.state === 'submitted' || task.gate) throw new TaskError(`task ${taskId} has not started; use rejectTask`);
  const cap = ctx.registry.get(task.capability);
  if (!cap) throw new TaskError(`unknown capability ${task.capability}`);
  const message = statusMessage(run, task, cap, content);
  const code: ReasonCode | undefined = outcome === 'failed' ? 'error' : undefined;
  const payload = run.statusPayload({ taskId, contextId: task.contextId }, outcome, { code, ...(message ? { message } : {}) });
  if (message && run.gated(task, payload, opts)) return run.result();
  run.setState(task, outcome, outcome === 'failed' ? { reason: 'failed', code: 'error' } : {});
  run.send(task.peer, payload);
  run.event({ kind: outcome, taskId, peer: task.peer, state: task.state, capability: task.capability });
  return run.result();
}

/** End every open task past its `expires` (telling the peer), and prune old finished tasks. */
export function expireTasks(state: TaskEngineState, ctx: Pick<TaskCtx, 'now' | 'newId'>): TaskStep {
  const run = new Run(state, ctx as TaskCtx);
  for (const task of Object.values(run.state.tasks)) run.expireIfDue(task);
  run.prune();
  return run.result();
}

/** Tasks from peers that wait for our human (the start gate), oldest first. */
export function waitingForHuman(state: TaskEngineState): TaskRecord[] {
  return Object.values(state.tasks)
    .filter((t) => t.role === 'executor' && t.gate && !isFinished(t.state))
    .sort((a, b) => a.gate!.since.localeCompare(b.gate!.since));
}
