// SPEC §7.8.4: tasks in a group, and the board. A pure projection, like the
// engines (engine.ts, tasks.ts):
//
//   (board, group message, ctx) → { board, events[], effects[] }
//
// No I/O, no clock (`now` comes in `ctx`), no core import. The host feeds it
// the group messages core delivered (signed by their sender, a member, in
// that sender's group-chain order) and our own posts, persists `board`, and
// acts on `effects`.
//
// The board is each member's view of the board-visible task messages: open
// tasks, claims, the assignee, the task's state as the assignee reports it,
// and its artifacts. It is not a shared document: members who received the
// same messages show the same board. A task is (requester, taskId): task IDs
// are the requester's choice, so another member reusing one names another
// task, never this one. Every rule checks who may say what before anything
// changes:
//
//   task/request   any member; `assignee`, when given, a member other than the requester
//   task/claim     a member other than the requester, while the task is open
//   task/assign    the requester; an admin only once the requester left
//   task/release   the assignee (gives it back) or whoever may assign (takes it back)
//   task/input,    the requester only
//   rdv/cancel
//   task-update,   the assignee only (and the update names the requester,
//   artifact-update  GROUP_REQUESTER_KEY); status moves forward only
//
// A message about a task we do not hold yet (its request, or the assign that
// makes its sender the assignee, is still on its way from another member) is
// kept a short while, bounded, and tried again after every change; nothing in
// it counts until the rule above holds.
//
// For our own agent as the assignee the board says what to do (`effects`):
// `execute` the request (the host feeds it to its tasks engine, where the
// start and release gates apply exactly as for a pairwise task, §7.6),
// `forward` the requester's later turns, and `unassign` when the task was
// taken from us. The engine never sees anything the board did not admit.
import { isUuid } from './model.js';
import {
  type FilePart,
  GROUP_REQUESTER_KEY,
  GROUPS_URI,
  type GroupVerbData,
  isAgentIdShape,
  isFinished,
  parseGroupTaskPayload,
  TASK_LIMITS,
  TASKS_URI,
  type TaskLifecycleState,
  type TaskMessage,
  type TaskPart,
  type TaskPayload,
} from './taskmodel.js';
import { type TaskLimitVerdict, parseRate } from './tasks.js';
import { parseInstant } from './time.js';

export const BOARD_BOUNDS = {
  /** Tasks on one group's board (finished ones evicted first). */
  tasks: 64,
  /** Open (not finished) tasks one requester may have on a board. */
  openPerRequester: 16,
  /** Members' claims kept per task. */
  claims: 15,
  /** Artifacts kept per task, and characters of their text kept on the board (the full text is in the event). */
  artifacts: 8,
  artifactChars: 2000,
  /** Characters of the request kept as the task's title once it ends. */
  titleChars: 200,
  /** Message IDs remembered per task (duplicates). */
  seen: 32,
  /** Status updates taken per task. */
  updates: 64,
  /** Messages about a task we do not hold yet: in all, per sender, and for how long. */
  early: 16,
  earlyPerSender: 4,
  earlyMs: 10 * 60_000,
  /** `expires` of a task: default and latest, from now. */
  expiresDefaultMs: 48 * 3_600_000,
  expiresMaxMs: 7 * 86_400_000,
  /** Finished tasks are dropped this long after they ended. */
  keepFinishedMs: 30 * 86_400_000,
} as const;

export interface BoardArtifact {
  artifactId: string;
  name?: string;
  /** Its text parts, cut to artifactChars: peer text (§5.6). */
  text: string;
  /** How many data parts it had. */
  data: number;
  /** Its file parts (never fetched here). */
  files: FilePart[];
  done: boolean;
  ts: string;
}

export interface BoardTask {
  id: string;
  requester: string;
  capability: string;
  /** The request's first text part, cut to titleChars: peer text. */
  title: string;
  assignee?: string;
  /** Members who offered to do it while it was open, in the order we received them. */
  claims: string[];
  /** As the assignee reports it; `submitted` while open, or assigned and not started. */
  state: TaskLifecycleState;
  /** Why it ended, in our words (never peer text). */
  reason?: string;
  /** The requester's task/request (without `assignee`), while the task is not finished: what the assignee's engine gets. */
  request?: TaskPayload;
  referenceTaskIds?: string[];
  artifacts: BoardArtifact[];
  /** Private to these members (the request was not board-visible). */
  private?: string[];
  expires: string;
  created: string;
  updated: string;
  seen: string[];
  updates: number;
}

export interface BoardState {
  v: 1;
  group: string;
  /** By boardKey(requester, taskId). */
  tasks: Record<string, BoardTask>;
  /** Messages about tasks we do not hold yet (or before their assign), tried again after each change. */
  early?: Array<{ from: string; body: unknown; board: boolean; to?: string[]; at: string }>;
}

export const emptyBoard = (group: string): BoardState => ({ v: 1, group, tasks: {} });
export const boardKey = (requester: string, taskId: string): string => `${requester}/${taskId}`;

export interface BoardCtx {
  now: Date;
  /** Our own agent ID. */
  me: string;
  /** Members listed in the group's state we hold that have not left (we included). */
  members: readonly string[];
  /** Admins among them. */
  admins: readonly string[];
}

/** One group message: from a member (core checked its signature and chain), board-visible or private to `to`. */
export interface BoardItem {
  from: string;
  body: unknown;
  board: boolean;
  to?: string[];
}

export type BoardEventKind = 'posted' | 'claimed' | 'assigned' | 'released' | 'reopened' | 'input' | 'status' | 'artifact' | 'canceled' | 'expired' | 'ignored';

export interface BoardEvent {
  kind: BoardEventKind;
  group: string;
  task: string;
  requester: string;
  /** Who sent it (for reopened and expired: nobody, the board did it). */
  from?: string;
  assignee?: string;
  state?: TaskLifecycleState;
  capability?: string;
  reason?: string;
  /** Text a member wrote: untrusted, display only. */
  peerText?: string[];
  data?: Record<string, unknown>[];
  files?: FilePart[];
  artifactId?: string;
  referenceTaskIds?: string[];
}

export type BoardEffect =
  /** The task is now ours to do: feed `request` (from `requester`) to our tasks engine; its gates apply. */
  | { kind: 'execute'; requester: string; taskId: string; request: TaskPayload }
  /** The requester's next turn (task/input, rdv/cancel) on a task assigned to us: feed it to our engine. */
  | { kind: 'forward'; requester: string; taskId: string; payload: TaskPayload }
  /** The task is no longer ours (taken back, reassigned after a release): drop it from our engine; nothing more is sent for it. */
  | { kind: 'unassign'; requester: string; taskId: string; reason: string };

export interface BoardStep {
  board: BoardState;
  events: BoardEvent[];
  effects: BoardEffect[];
}

export class BoardError extends Error {}

// --- receive ----------------------------------------------------------------

class Run {
  readonly board: BoardState;
  readonly events: BoardEvent[] = [];
  readonly effects: BoardEffect[] = [];
  readonly now: number;
  readonly nowIso: string;
  constructor(
    board: BoardState,
    readonly ctx: BoardCtx,
  ) {
    this.board = structuredClone(board);
    this.now = ctx.now.getTime();
    this.nowIso = ctx.now.toISOString();
  }
  result(): BoardStep {
    if (this.board.early && this.board.early.length === 0) delete this.board.early;
    return { board: this.board, events: this.events, effects: this.effects };
  }
  task(requester: string, id: string): BoardTask | undefined {
    const k = boardKey(requester, id);
    return Object.hasOwn(this.board.tasks, k) ? this.board.tasks[k] : undefined;
  }
  member = (id: string): boolean => this.ctx.members.includes(id);
  ignored(t: { requester: string; id: string }, from: string, reason: string): 'ignored' {
    this.events.push({ kind: 'ignored', group: this.board.group, task: t.id, requester: t.requester, from, reason });
    return 'ignored';
  }
  /** Who may assign or take back `t`: its requester while a member, else an admin. */
  mayAssign(t: BoardTask, from: string): boolean {
    return this.member(t.requester) ? from === t.requester : this.ctx.admins.includes(from);
  }
  finish(t: BoardTask, state: TaskLifecycleState, reason?: string): void {
    t.state = state;
    t.updated = this.nowIso;
    if (reason !== undefined) t.reason = reason;
    delete t.request;
    t.claims = [];
  }
}

type Outcome = 'applied' | 'ignored' | 'early' | 'duplicate';

/** Handle one group message (ours too, once posted). Anything not a group task payload changes nothing. */
export function boardReceive(board: BoardState, item: BoardItem, ctx: BoardCtx): BoardStep {
  const run = new Run(board, ctx);
  expireEarly(run);
  const out = handle(run, item);
  if (out === 'early') keepEarly(run, item);
  if (out === 'applied') retryEarly(run);
  return run.result();
}

function handle(run: Run, item: BoardItem): Outcome {
  const parsed = parseGroupTaskPayload(item.body);
  if (!parsed.ok) return 'ignored'; // a note, or not a task payload: the host shows it as a group message
  if (!run.member(item.from)) return 'ignored';
  const v = parsed.value;
  const group = run.board.group;
  if (v.kind === 'message') {
    if (v.message.contextId !== group) return 'ignored';
    return onMessage(run, item, v.message, v.data, v.text, v.files);
  }
  const u: { taskId: string; contextId: string; metadata?: Record<string, unknown> } = v.update;
  if (u.contextId !== group) return 'ignored';
  const requester = (u.metadata as Record<string, unknown> | undefined)?.[GROUP_REQUESTER_KEY];
  if (!isAgentIdShape(requester)) return 'ignored';
  const t = run.task(requester, u.taskId);
  // Not yet ours to judge: the request, or the assign that makes the sender the assignee, may still be on its way.
  if (!t || (t.assignee === undefined && !isFinished(t.state))) return 'early';
  if (t.assignee !== item.from) return run.ignored(t, item.from, 'only the assignee reports on a task');
  if (v.kind === 'update') {
    const to = v.update.status.state;
    if (isFinished(t.state)) return run.ignored(t, item.from, `update after ${t.state}`);
    if (t.updates >= BOARD_BOUNDS.updates) return run.ignored(t, item.from, 'too many status updates');
    if (to === 'submitted' && t.state !== 'submitted') return run.ignored(t, item.from, `${to} after ${t.state}`);
    t.updates += 1;
    const status = v.update.status;
    const text = (status.message?.parts ?? []).filter((p): p is TaskPart & { kind: 'text' } => p.kind === 'text').map((p) => p.text);
    const data = (status.message?.parts ?? []).filter((p): p is TaskPart & { kind: 'data' } => p.kind === 'data').map((p) => p.data);
    if (to === t.state && !text.length && !data.length) return 'duplicate';
    if (isFinished(to)) run.finish(t, to, `the assignee reports ${to}`);
    else {
      t.state = to;
      t.updated = run.nowIso;
    }
    run.events.push({
      kind: 'status',
      group,
      task: t.id,
      requester: t.requester,
      from: item.from,
      assignee: t.assignee,
      state: t.state,
      capability: t.capability,
      ...(text.length ? { peerText: text } : {}),
      ...(data.length ? { data } : {}),
    });
    return 'applied';
  }
  // artifact-update
  const au = v.update;
  const a = au.artifact;
  if (isFinished(t.state)) return run.ignored(t, item.from, `artifact after ${t.state}`);
  const known = t.artifacts.find((x) => x.artifactId === a.artifactId);
  if (!known && t.artifacts.length >= BOARD_BOUNDS.artifacts) return run.ignored(t, item.from, 'too many artifacts');
  const text = a.parts.filter((p): p is TaskPart & { kind: 'text' } => p.kind === 'text').map((p) => p.text);
  const data = a.parts.filter((p): p is TaskPart & { kind: 'data' } => p.kind === 'data').map((p) => p.data);
  const files = a.parts.filter((p): p is FilePart => p.kind === 'file');
  const joined = (au.append && known ? `${known.text}${text.join('\n')}` : text.join('\n')).slice(0, BOARD_BOUNDS.artifactChars);
  const rec: BoardArtifact = known ?? { artifactId: a.artifactId, text: '', data: 0, files: [], done: false, ts: run.nowIso };
  rec.text = joined;
  rec.data = (au.append && known ? known.data : 0) + data.length;
  rec.files = [...(au.append && known ? known.files : []), ...files].slice(0, TASK_LIMITS.parts);
  rec.done = au.lastChunk === true;
  rec.ts = run.nowIso;
  if (a.name !== undefined) rec.name = a.name;
  if (!known) t.artifacts.push(rec);
  t.updated = run.nowIso;
  run.events.push({
    kind: 'artifact',
    group,
    task: t.id,
    requester: t.requester,
    from: item.from,
    assignee: t.assignee,
    state: t.state,
    capability: t.capability,
    artifactId: a.artifactId,
    ...(text.length ? { peerText: text } : {}),
    ...(data.length ? { data } : {}),
    ...(files.length ? { files } : {}),
  });
  return 'applied';
}

function onMessage(run: Run, item: BoardItem, m: TaskMessage, data: GroupVerbData, text: string[], files: FilePart[]): Outcome {
  const group = run.board.group;
  const from = item.from;
  if (data.rdv === 'task/request') {
    const known = run.task(from, m.taskId);
    if (known) return known.seen.includes(m.messageId) ? 'duplicate' : run.ignored(known, from, 'a second request with the same task ID');
    const assignee = data.assignee;
    if (assignee !== undefined && (assignee === from || !run.member(assignee))) return run.ignored({ requester: from, id: m.taskId }, from, 'the assignee is not another member');
    if (!item.board && assignee !== undefined && !(item.to ?? []).includes(assignee)) return run.ignored({ requester: from, id: m.taskId }, from, 'a private task goes to its assignee');
    const mine = Object.values(run.board.tasks).filter((t) => t.requester === from && !isFinished(t.state)).length;
    if (mine >= BOARD_BOUNDS.openPerRequester) return run.ignored({ requester: from, id: m.taskId }, from, `more than ${BOARD_BOUNDS.openPerRequester} open tasks from one member`);
    if (!makeRoom(run)) return run.ignored({ requester: from, id: m.taskId }, from, 'the board is full of open tasks');
    // The engine gets the request as a pairwise one: without `assignee`, everything else as sent.
    const parts = m.parts.map((p) => {
      if (p.kind !== 'data') return p;
      const { assignee: _a, ...rest } = p.data as Record<string, unknown>;
      return { ...p, data: rest };
    });
    const request: TaskPayload = { type: 'a2a/message', message: { ...m, parts } };
    const want = parseInstant(data.expires) ?? run.now + BOARD_BOUNDS.expiresDefaultMs;
    const t: BoardTask = {
      id: m.taskId,
      requester: from,
      capability: data.capability,
      title: (text[0] ?? '').slice(0, BOARD_BOUNDS.titleChars),
      ...(assignee !== undefined ? { assignee } : {}),
      claims: [],
      state: 'submitted',
      request,
      ...(m.referenceTaskIds?.length ? { referenceTaskIds: [...m.referenceTaskIds] } : {}),
      artifacts: [],
      ...(item.board ? {} : { private: [...(item.to ?? [])] }),
      expires: new Date(Math.min(want, run.now + BOARD_BOUNDS.expiresMaxMs)).toISOString(),
      created: run.nowIso,
      updated: run.nowIso,
      seen: [m.messageId],
      updates: 0,
    };
    run.board.tasks[boardKey(from, t.id)] = t;
    run.events.push({
      kind: 'posted',
      group,
      task: t.id,
      requester: from,
      from,
      ...(assignee !== undefined ? { assignee } : {}),
      state: t.state,
      capability: t.capability,
      ...(text.length ? { peerText: text } : {}),
      ...(files.length ? { files } : {}),
      ...(t.referenceTaskIds ? { referenceTaskIds: t.referenceTaskIds } : {}),
    });
    if (assignee === run.ctx.me && from !== run.ctx.me) run.effects.push({ kind: 'execute', requester: from, taskId: t.id, request });
    return 'applied';
  }

  // Every other verb names a task: by the requester it names (claim, assign, release), or the sender's own (input, cancel).
  const requester = data.rdv === 'task/input' || data.rdv === 'rdv/cancel' ? from : data.requester;
  const t = run.task(requester, m.taskId);
  if (!t) return 'early';
  if (t.seen.includes(m.messageId)) return 'duplicate';
  const seen = () => {
    t.seen.push(m.messageId);
    if (t.seen.length > BOARD_BOUNDS.seen) t.seen.splice(0, t.seen.length - BOARD_BOUNDS.seen);
    t.updated = run.nowIso;
  };
  if (isFinished(t.state)) return run.ignored(t, from, `${data.rdv} after ${t.state}`);
  const base = { group, task: t.id, requester: t.requester, from, capability: t.capability };

  switch (data.rdv) {
    case 'task/claim': {
      if (from === t.requester) return run.ignored(t, from, 'the requester does not claim its own task');
      if (t.assignee !== undefined) return run.ignored(t, from, 'the task is already assigned');
      if (t.claims.includes(from)) return 'duplicate';
      if (t.claims.length >= BOARD_BOUNDS.claims) return run.ignored(t, from, 'too many claims');
      seen();
      t.claims.push(from);
      run.events.push({ kind: 'claimed', ...base, state: t.state, ...(text.length ? { peerText: text } : {}) });
      return 'applied';
    }
    case 'task/assign': {
      if (!run.mayAssign(t, from)) return run.ignored(t, from, 'only the requester assigns its task (an admin, once the requester left)');
      if (t.assignee !== undefined) return t.assignee === data.assignee ? 'duplicate' : run.ignored(t, from, 'the task is assigned: release it first');
      if (data.assignee === t.requester || !run.member(data.assignee)) return run.ignored(t, from, 'the assignee is not another member');
      seen();
      t.assignee = data.assignee;
      t.state = 'submitted';
      run.events.push({ kind: 'assigned', ...base, assignee: t.assignee, state: t.state });
      if (t.assignee === run.ctx.me && t.request) run.effects.push({ kind: 'execute', requester: t.requester, taskId: t.id, request: t.request });
      return 'applied';
    }
    case 'task/release': {
      if (t.assignee === undefined) return 'duplicate';
      if (from !== t.assignee && !run.mayAssign(t, from)) return run.ignored(t, from, 'only the assignee, or whoever assigns, releases a task');
      seen();
      const was = t.assignee;
      delete t.assignee;
      t.state = 'submitted';
      run.events.push({ kind: 'released', ...base, assignee: was, state: t.state });
      if (was === run.ctx.me && from !== run.ctx.me) run.effects.push({ kind: 'unassign', requester: t.requester, taskId: t.id, reason: 'taken back' });
      return 'applied';
    }
    case 'task/input': {
      if (t.assignee === undefined) return run.ignored(t, from, 'task/input for an unassigned task');
      seen();
      run.events.push({ kind: 'input', ...base, assignee: t.assignee, state: t.state, ...(text.length ? { peerText: text } : {}) });
      if (t.assignee === run.ctx.me) run.effects.push({ kind: 'forward', requester: t.requester, taskId: t.id, payload: { type: 'a2a/message', message: m } });
      return 'applied';
    }
    case 'rdv/cancel': {
      seen();
      const assignee = t.assignee;
      run.finish(t, 'canceled', 'canceled by the requester');
      run.events.push({ kind: 'canceled', ...base, ...(assignee ? { assignee } : {}), state: t.state, reason: t.reason });
      if (assignee === run.ctx.me) run.effects.push({ kind: 'forward', requester: t.requester, taskId: t.id, payload: { type: 'a2a/message', message: m } });
      return 'applied';
    }
  }
}

/** Room for one more task: drop the oldest finished ones. False if every task is open. */
function makeRoom(run: Run): boolean {
  const all = Object.entries(run.board.tasks);
  if (all.length < BOARD_BOUNDS.tasks) return true;
  const done = all.filter(([, t]) => isFinished(t.state)).sort(([, a], [, b]) => a.updated.localeCompare(b.updated));
  if (!done.length) return false;
  delete run.board.tasks[done[0][0]];
  return true;
}

function keepEarly(run: Run, item: BoardItem): void {
  const early = (run.board.early ??= []);
  if (early.filter((e) => e.from === item.from).length >= BOARD_BOUNDS.earlyPerSender) return;
  if (early.length >= BOARD_BOUNDS.early) early.shift();
  early.push({ from: item.from, body: item.body, board: item.board, ...(item.to ? { to: [...item.to] } : {}), at: run.nowIso });
}

function expireEarly(run: Run): void {
  if (!run.board.early) return;
  run.board.early = run.board.early.filter((e) => {
    const at = parseInstant(e.at);
    return at !== null && at <= run.now && run.now - at < BOARD_BOUNDS.earlyMs && run.member(e.from);
  });
}

/** After a change, the early messages that may now apply; each is tried until nothing more changes. */
function retryEarly(run: Run): void {
  for (let progress = true; progress && run.board.early?.length; ) {
    progress = false;
    for (const e of [...run.board.early]) {
      const out = handle(run, e);
      if (out === 'early') continue;
      run.board.early = run.board.early.filter((x) => x !== e);
      if (out === 'applied') progress = true;
    }
  }
}

// --- departures and time ------------------------------------------------------------

/**
 * A member left or was removed (SPEC §7.8.5): tasks assigned to it go back to
 * open; its requests nobody was assigned are canceled locally (an admin may
 * assign the ones already assigned, once they are released). Nothing is sent.
 */
export function boardDeparted(board: BoardState, member: string, ctx: BoardCtx): BoardStep {
  const run = new Run(board, ctx);
  const group = run.board.group;
  for (const t of Object.values(run.board.tasks)) {
    if (isFinished(t.state)) continue;
    t.claims = t.claims.filter((c) => c !== member);
    if (t.assignee === member) {
      delete t.assignee;
      t.state = 'submitted';
      t.updated = run.nowIso;
      run.events.push({ kind: 'reopened', group, task: t.id, requester: t.requester, assignee: member, state: t.state, capability: t.capability, reason: 'the assignee left the group' });
    } else if (t.requester === member && t.assignee === undefined) {
      run.finish(t, 'canceled', 'the requester left the group');
      run.events.push({ kind: 'canceled', group, task: t.id, requester: t.requester, state: t.state, capability: t.capability, reason: t.reason });
    }
  }
  if (run.board.early) run.board.early = run.board.early.filter((e) => e.from !== member);
  return run.result();
}

/** Open tasks past their `expires` end (locally, as for everyone); finished ones are dropped after 30 days. */
export function boardSweep(board: BoardState, ctx: BoardCtx): BoardStep {
  const run = new Run(board, ctx);
  expireEarly(run);
  for (const [k, t] of Object.entries(run.board.tasks)) {
    if (isFinished(t.state)) {
      const at = parseInstant(t.updated);
      if (at === null || run.now - at > BOARD_BOUNDS.keepFinishedMs) delete run.board.tasks[k];
      continue;
    }
    const exp = parseInstant(t.expires);
    if (exp !== null && !(run.now > exp)) continue;
    const assignee = t.assignee;
    run.finish(t, 'canceled', 'expired');
    run.events.push({ kind: 'expired', group: run.board.group, task: t.id, requester: t.requester, ...(assignee ? { assignee } : {}), state: t.state, capability: t.capability, reason: 'expired' });
    if (assignee === run.ctx.me) run.effects.push({ kind: 'unassign', requester: t.requester, taskId: t.id, reason: 'expired' });
  }
  return run.result();
}

// --- what we post ----------------------------------------------------------------

export interface BoardRequestOptions {
  capability: string;
  /** The request in words (text parts). */
  text?: string[];
  input?: unknown;
  /** A member the task is for; omitted, it is open on the board. */
  assignee?: string;
  referenceTaskIds?: string[];
  expires?: string;
  files?: FilePart[];
}

const extensions = (capability: string | undefined, files: boolean): string[] => [TASKS_URI, GROUPS_URI, ...(capability ? [capability] : []), ...(files ? ['https://rendezvous.nesher.co/ext/files/v1'] : [])];

/**
 * A task/request for the group (SPEC §7.8.4), for the host to post. Checks
 * our own input only (the capability's schema is the host's, with its
 * registry). The host applies it to its own board with boardReceive.
 */
export function boardRequest(group: string, opts: BoardRequestOptions, ctx: { now: Date; me: string; newId?: () => string }): { taskId: string; payload: TaskPayload } {
  const newId = ctx.newId ?? (() => crypto.randomUUID());
  if (!isUuid(group)) throw new BoardError('the group ID must be a UUID');
  if (opts.assignee !== undefined && (!isAgentIdShape(opts.assignee) || opts.assignee === ctx.me)) throw new BoardError('the assignee is another member (an agent ID)');
  const text = opts.text ?? [];
  const files = opts.files ?? [];
  if (text.length + files.length + 1 > TASK_LIMITS.parts) throw new BoardError(`a message has at most ${TASK_LIMITS.parts} parts`);
  if (text.some((t) => t.length === 0 || t.length > TASK_LIMITS.textChars)) throw new BoardError(`a text part is 1 to ${TASK_LIMITS.textChars} characters`);
  if (opts.referenceTaskIds && (opts.referenceTaskIds.length > TASK_LIMITS.listItems || !opts.referenceTaskIds.every(isUuid))) throw new BoardError(`referenceTaskIds: at most ${TASK_LIMITS.listItems} UUIDs`);
  const now = ctx.now.getTime();
  const expires = opts.expires ?? new Date(now + BOARD_BOUNDS.expiresDefaultMs).toISOString();
  const exp = parseInstant(expires);
  if (exp === null || !(exp > now) || exp > now + BOARD_BOUNDS.expiresMaxMs) throw new BoardError('expires is a date-time in the next 7 days');
  const taskId = newId();
  const data: Record<string, unknown> = { rdv: 'task/request', capability: opts.capability, ...(opts.input !== undefined ? { input: opts.input } : {}), expires, ...(opts.assignee ? { assignee: opts.assignee } : {}) };
  const message: TaskMessage = {
    kind: 'message',
    messageId: newId(),
    taskId,
    contextId: group,
    role: 'agent',
    parts: [{ kind: 'data', data }, ...text.map((t) => ({ kind: 'text' as const, text: t })), ...files],
    extensions: extensions(opts.capability, files.length > 0),
    ...(opts.referenceTaskIds?.length ? { referenceTaskIds: [...opts.referenceTaskIds] } : {}),
  };
  const payload: TaskPayload = { type: 'a2a/message', message };
  const check = parseGroupTaskPayload(payload);
  if (!check.ok) throw new BoardError(check.reason);
  return { taskId, payload };
}

/** Our claim, assign, release, input or cancel on a task (SPEC §7.8.4), for the host to post and apply. */
export function boardVerb(
  group: string,
  taskId: string,
  data: GroupVerbData,
  opts: { text?: string; newId?: () => string } = {},
): TaskPayload {
  const newId = opts.newId ?? (() => crypto.randomUUID());
  if (!isUuid(group) || !isUuid(taskId)) throw new BoardError('group and task IDs are UUIDs');
  if (opts.text !== undefined && (opts.text.length === 0 || opts.text.length > TASK_LIMITS.textChars)) throw new BoardError(`a text part is 1 to ${TASK_LIMITS.textChars} characters`);
  const message: TaskMessage = {
    kind: 'message',
    messageId: newId(),
    taskId,
    contextId: group,
    role: 'agent',
    parts: [{ kind: 'data', data: data as unknown as Record<string, unknown> }, ...(opts.text !== undefined ? [{ kind: 'text' as const, text: opts.text }] : [])],
    extensions: extensions(undefined, false),
  };
  const payload: TaskPayload = { type: 'a2a/message', message };
  const check = parseGroupTaskPayload(payload);
  if (!check.ok) throw new BoardError(check.reason);
  return payload;
}

/** An executor payload (status or artifact update) for the board: it names the task's requester (GROUP_REQUESTER_KEY). */
export function forBoard(payload: TaskPayload, requester: string): TaskPayload {
  if (payload.type === 'a2a/message') return payload;
  const update = { ...payload.update, metadata: { ...(payload.update.metadata ?? {}), [GROUP_REQUESTER_KEY]: requester } };
  return { ...payload, update } as TaskPayload;
}

/** The task we hold under (requester, taskId), if any. */
export function boardTask(board: BoardState, requester: string, taskId: string): BoardTask | undefined {
  const k = boardKey(requester, taskId);
  return Object.hasOwn(board.tasks, k) ? board.tasks[k] : undefined;
}

/** Tasks with this ID (any requester): one, unless two members chose the same ID. */
export function boardTasksById(board: BoardState, taskId: string): BoardTask[] {
  return Object.values(board.tasks).filter((t) => t.id === taskId);
}

// --- the join scope's limits on invocations ----------------------------------------------

/** When members invoked us through one group (epoch ms), in all and per capability, within their windows. */
export interface InvokeCounters {
  all?: number[];
  caps?: Record<string, number[]>;
}

const within = (list: unknown, windowMs: number, now: number): number[] =>
  Array.isArray(list) ? list.map((t) => (typeof t === 'number' && Number.isFinite(t) && t <= now ? t : now)).filter((t) => t > now - windowMs) : [];

/**
 * Our join scope as the limiter of our group tasks engine (SPEC §7.8.2,
 * §7.8.4): `max_open` per capability, the capability's `max_frequency`, and
 * the scope's grant-wide `max_frequency`, counted over every member of the
 * group together (the scope is one grant to all of them, so it caps what the
 * group as a whole may ask of us). Pure: returns the verdict and the counters
 * to keep (unchanged on a refusal).
 */
export function admitGroupInvoke(
  counters: InvokeCounters | undefined,
  scope: { invoke?: Readonly<Record<string, unknown>>; max_frequency?: string },
  capability: string,
  open: { open: number; maxOpen: number },
  now: Date,
): { verdict: TaskLimitVerdict; counters: InvokeCounters } {
  const t = now.getTime();
  const c: InvokeCounters = { ...(counters?.all ? { all: [...counters.all] } : {}), ...(counters?.caps ? { caps: { ...counters.caps } } : {}) };
  const limits = scope.invoke && Object.hasOwn(scope.invoke, capability) ? (scope.invoke[capability] as Record<string, unknown>) : undefined;
  if (!limits || typeof limits !== 'object') return { verdict: { ok: false, code: 'scope', reason: 'the group terms do not allow this capability' }, counters: c };
  if (!Number.isFinite(t)) return { verdict: { ok: false, code: 'rate', reason: 'our clock is unreadable' }, counters: c };
  if (open.open >= open.maxOpen) return { verdict: { ok: false, code: 'rate', reason: `too many open ${capability} tasks (max_open ${open.maxOpen})` }, counters: c };
  const capRate = parseRate(limits.max_frequency);
  const allRate = parseRate(scope.max_frequency);
  const capSeen = capRate ? within(c.caps?.[capability], capRate.windowMs, t) : [];
  const allSeen = allRate ? within(c.all, allRate.windowMs, t) : [];
  if (capRate && capSeen.length >= capRate.count) return { verdict: { ok: false, code: 'rate', reason: `the group terms allow ${String(limits.max_frequency)} for ${capability}` }, counters: c };
  if (allRate && allSeen.length >= allRate.count) return { verdict: { ok: false, code: 'rate', reason: `the group terms allow ${scope.max_frequency} in all` }, counters: c };
  if (capRate) c.caps = { ...(c.caps ?? {}), [capability]: [...capSeen, t].slice(-Math.max(capRate.count, 1)) };
  else if (c.caps) delete c.caps[capability];
  if (allRate) c.all = [...allSeen, t].slice(-Math.max(allRate.count, 1));
  else delete c.all;
  if (c.caps && !Object.keys(c.caps).length) delete c.caps;
  return { verdict: { ok: true }, counters: c };
}
