// Tasks in a group, in the hosts (SPEC §7.8.4, issue #79). The board is
// @rendezvous/a2a's (board.ts: pure, it judges who may say what); this module
// feeds it the group messages core delivered and our own posts, keeps it in
// tasks.json beside the group lanes of tasks.ts, and runs the tasks assigned
// to us on the tasks engine, where the start and release gates apply exactly
// as for a pairwise task.
//
// - Inbound (the listener, inside the home lock): each group message whose
//   body is a task payload goes to the board; a task assigned to us is fed to
//   our group lane's engine with the requester as its peer, what it may invoke
//   being our group terms (our join's scope), limited by the terms'
//   `max_open` and `max_frequency` over all members together. A member our
//   human has not approved (newcomer policy `ask`) invokes nothing: its task
//   is refused (`scope`). The engine's replies go to the board.
// - Departures (a leave, a state that removes a member): the board reopens
//   what the member was assigned and cancels its open requests, locally.
// - Our own posts (a task, claim, assign, unassign, cancel, input) are
//   applied to our board first: the board refusing one (we may not assign
//   that task, say) means nothing is sent.
//
// No group decision is ever covered by auto-approve (SPEC §5.5.1): a group
// task's gates are never passed by a pairwise auto-approve entry, whose
// `covers` names what the contact's grant allows, never our group terms.
import {
  admitGroupInvoke,
  BoardError,
  type BoardEvent,
  type BoardStep,
  type BoardTask,
  boardDeparted,
  boardReceive,
  boardRequest,
  boardSweep,
  boardTasksById,
  boardVerb,
  type CapabilityRegistry,
  checkInput,
  expireTasks,
  type GroupVerbData,
  isFinished,
  receiveTask,
  SchemaError,
  TASK_PAYLOAD_TYPES,
  type TaskEvent,
  type TaskPayload,
  type TaskStep,
} from '@rendezvous/a2a';
import { type Agent, fingerprint, type GroupDelivery, groupRecipients, isAgentId, memberOf } from '@rendezvous/core';
import { describeFile, fileSummaries, normalizeTaskFiles } from './files.js';
import { type AuditEntry, CliError, type Home, type TaskHostState } from './home.js';
import { clean } from './output.js';
import { applyEffects, boardCtxOf, type BoardPost, boardPosts, groupHost, groupTaskCtx, groupViewOf, postRecipients, pruneReleases, sendPosts, taskEventText, taskEventView } from './tasks.js';

/** What the listener collected for the group lanes: group messages, and members who left or were removed. */
export interface GroupInbound {
  deliveries: GroupDelivery[];
  departures: Array<{ group: string; member: string }>;
}

/** What handling group task traffic did: the boards' events, our engines' events (with their group), errors. */
export interface GroupTaskRun {
  board: BoardEvent[];
  tasks: Array<TaskEvent & { group: string }>;
  errors: string[];
}

const empty = (): GroupTaskRun => ({ board: [], tasks: [], errors: [] });

/** A group message whose body is a tasks/v1 payload (the board's), not a note. */
export const isGroupTaskBody = (body: unknown): boolean => !!body && typeof body === 'object' && TASK_PAYLOAD_TYPES.has((body as { type?: unknown }).type as string);

/** Any group lane with an open task or board entry that can expire (for the listener's sweep). */
export function groupTasksExpiring(s: TaskHostState): boolean {
  return Object.values(s.groups ?? {}).some(
    (g) => Object.values(g.board.tasks).some((t) => !isFinished(t.state)) || Object.values(g.engine.tasks).some((t) => !isFinished(t.state) && t.expires !== null) || !!g.board.early?.length,
  );
}

/**
 * Feed group task traffic to the boards and the group lanes' engines (and,
 * with `sweep`, expire). Call inside the home lock, with the Agent loaded
 * from it: the state is saved before any post leaves (issue #4).
 */
export async function groupTasksInbound(home: Home, registry: CapabilityRegistry, agent: Agent, inbound: GroupInbound, sweep: boolean): Promise<GroupTaskRun> {
  const out = empty();
  const deliveries = inbound.deliveries.filter((d) => isGroupTaskBody(d.body));
  if (!deliveries.length && !inbound.departures.length && !sweep) return out;
  const s = home.readTasks();
  if (!deliveries.length && !inbound.departures.length && !groupTasksExpiring(s)) return out;
  const before = JSON.stringify(s);
  const now = new Date();
  const audits: AuditEntry[] = [];
  const steps = new Map<string, TaskStep[]>();
  const stepsOf = (group: string) => steps.get(group) ?? (steps.set(group, []), steps.get(group)!);

  // A task assigned to us, or the requester's next turn on one: our group lane's engine, gated as any task.
  const feed = (group: string, requester: string, payload: TaskPayload) => {
    const g = groupHost(s, group, true)!;
    const r = agent.groups.group(group);
    const taskId = payload.type === 'a2a/message' ? payload.message.taskId : payload.update.taskId;
    const have = Object.hasOwn(g.engine.tasks, taskId) ? g.engine.tasks[taskId] : undefined;
    if (have && have.peer !== requester) {
      // Two members chose the same task ID and both gave it to us: we keep working on the first.
      out.tasks.push({ kind: 'invalid', taskId, peer: requester, reason: 'another member already gave you a task with this ID', group });
      return;
    }
    const scope = r && r.status === 'active' ? r.scope : {};
    const approved = !!r && r.approved.includes(requester);
    const step = receiveTask(g.engine, requester, payload, {
      ...groupTaskCtx(registry, agent, group, now),
      // Our group terms as the limiter (max_open, max_frequency, all members together); an unapproved newcomer invokes nothing.
      limit: (cap, o) => {
        if (!approved) return { ok: false, code: 'scope', reason: 'your user has not approved this member in the group' };
        const a = admitGroupInvoke(g.invoked, scope, cap, o, now);
        if (Object.keys(a.counters).length) g.invoked = a.counters;
        else delete g.invoked;
        return a.verdict;
      },
    });
    applyEffects({ releases: g.releases, group }, step, now, 'grant', audits);
    g.engine = step.state;
    stepsOf(group).push(step);
  };

  const effects = (group: string, step: BoardStep) => {
    out.board.push(...step.events);
    for (const fx of step.effects) {
      if (fx.kind === 'execute') feed(group, fx.requester, fx.request);
      else if (fx.kind === 'forward') feed(group, fx.requester, fx.payload);
      else {
        // Taken from us (taken back, or expired): our engine forgets it and its draft; nothing more is sent for it.
        const g = groupHost(s, group)!;
        const t = Object.hasOwn(g.engine.tasks, fx.taskId) ? g.engine.tasks[fx.taskId] : undefined;
        if (t && t.role === 'executor' && t.peer === fx.requester) {
          delete g.engine.tasks[fx.taskId];
          delete g.releases[fx.taskId];
          out.tasks.push({ kind: 'canceled', taskId: fx.taskId, peer: fx.requester, state: 'canceled', capability: t.capability, reason: `no longer yours: ${fx.reason}`, group });
        }
      }
    }
  };

  for (const d of deliveries) {
    const r = agent.groups.group(d.group);
    if (!r || r.status !== 'active') continue;
    // File parts are checked (core's parseFilePart) before the board keeps any (never fetched here).
    const files = normalizeTaskFiles(d.body);
    if (!files.ok) {
      out.board.push({ kind: 'ignored', group: d.group, task: files.taskId ?? '', requester: d.from, from: d.from, reason: files.reason });
      continue;
    }
    const g = groupHost(s, d.group, true)!;
    const step = boardReceive(g.board, { from: d.from, body: files.payload, board: d.board, ...(d.board ? {} : { to: d.msg.to as string[] }) }, boardCtxOf(agent, d.group, now));
    g.board = step.board;
    effects(d.group, step);
  }
  for (const dep of inbound.departures) {
    const g = groupHost(s, dep.group);
    if (!g) continue;
    const step = boardDeparted(g.board, dep.member, boardCtxOf(agent, dep.group, now));
    g.board = step.board;
    effects(dep.group, step);
  }
  if (sweep) {
    for (const [group, g] of Object.entries(s.groups ?? {})) {
      const step = boardSweep(g.board, boardCtxOf(agent, group, now));
      g.board = step.board;
      effects(group, step);
      const ex = expireTasks(g.engine, { now });
      applyEffects({ releases: g.releases, group }, ex, now, 'grant', audits);
      g.engine = ex.state;
      stepsOf(group).push(ex);
    }
  }
  const posts: BoardPost[] = [];
  for (const [group, st] of steps) {
    const p = boardPosts(agent, s, group, st, now);
    out.board.push(...p.events);
    posts.push(...p.posts);
    for (const step of st) out.tasks.push(...step.events.map((e) => ({ ...e, group })));
  }
  pruneReleases(s, now);
  if (JSON.stringify(s) !== before) home.writeTasks(s);
  home.appendAudit(audits);
  out.errors.push(...(await sendPosts(agent, posts)));
  return out;
}

// --- our own posts ---------------------------------------------------------------------

/**
 * Post one of our task messages to the group: applied to our board first (the
 * board judges it as it judges anyone's; if it refuses, nothing is sent), the
 * state saved, then sent. `mutate` runs on the state before it is saved.
 */
async function postOwn(home: Home, agent: Agent, group: string, payload: TaskPayload, to: string[] | undefined, mutate?: (s: TaskHostState) => void): Promise<GroupTaskRun> {
  const r = agent.groups.group(group);
  if (!r || r.status !== 'active') throw new CliError(`not a member of group ${group}`);
  if (to && to.length === 0) throw new CliError('nobody to send it to: none of its members is one your agent sends to in this group');
  const s = home.readTasks();
  const g = groupHost(s, group, true)!;
  const step = boardReceive(g.board, { from: agent.id, body: payload, board: !to, ...(to ? { to } : {}) }, boardCtxOf(agent, group));
  const refused = step.events.find((e) => e.kind === 'ignored');
  if (refused || step.events.length === 0) throw new CliError(`not sent: ${refused?.reason ?? 'your board has no such task (or it changes nothing)'}`);
  g.board = step.board;
  mutate?.(s);
  pruneReleases(s);
  home.writeTasks(s);
  const errors = await sendPosts(agent, [{ group, payload, ...(to ? { to } : {}) }]);
  return { board: step.events, tasks: [], errors };
}

export interface GroupRequestOptions {
  capability: string;
  text: string[];
  input?: unknown;
  /** A member the task is for; omitted, it is open on the board. */
  assignee?: string;
  /** Only to the assignee (not board-visible). */
  private?: boolean;
  referenceTaskIds?: string[];
  expires?: string;
}

/** Whether `peer` may be given `capability` in this group: a member we send to whose group terms let members invoke it. */
function assigneeProblem(agent: Agent, group: string, peer: string, capability: string): string | null {
  const r = agent.groups.group(group);
  if (!r || r.status !== 'active') return `not a member of group ${group}`;
  if (!groupRecipients(r, agent.id).includes(peer)) return `${peer} is not a member your agent sends to in this group (not listed, left, or not approved by your user)`;
  const j = Object.hasOwn(r.joins, peer) ? r.joins[peer] : undefined;
  if (!j || !Object.hasOwn(j.scope.invoke ?? {}, capability)) return `${fingerprint(peer)}'s terms in this group do not let members ask them for ${capability}`;
  return null;
}

/** Put a task on the group's board (SPEC §7.8.4): open, or for one member (`assignee`), board-visible unless `private`. */
export async function postGroupTask(home: Home, agent: Agent, registry: CapabilityRegistry, group: string, opts: GroupRequestOptions): Promise<{ taskId: string; run: GroupTaskRun }> {
  const cap = registry.get(opts.capability);
  if (!cap) throw new CliError(`unknown capability ${opts.capability}`);
  try {
    checkInput(cap, opts.input);
  } catch (err) {
    if (err instanceof SchemaError) throw new CliError(err.message, 2);
    throw err;
  }
  if (opts.private && !opts.assignee) throw new CliError('a private task names its assignee', 2);
  if (opts.assignee !== undefined) {
    const p = assigneeProblem(agent, group, opts.assignee, opts.capability);
    if (p) throw new CliError(p);
  }
  let made: { taskId: string; payload: TaskPayload };
  try {
    made = boardRequest(group, { capability: opts.capability, text: opts.text, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.assignee ? { assignee: opts.assignee } : {}), ...(opts.referenceTaskIds?.length ? { referenceTaskIds: opts.referenceTaskIds } : {}), ...(opts.expires ? { expires: opts.expires } : {}) }, { now: new Date(), me: agent.id });
  } catch (err) {
    if (err instanceof BoardError) throw new CliError(err.message, 2);
    throw err;
  }
  const run = await postOwn(home, agent, group, made.payload, opts.private ? [opts.assignee!] : undefined);
  return { taskId: made.taskId, run };
}

export type GroupVerb = 'claim' | 'assign' | 'unassign' | 'cancel' | 'input';

/** The one task on our board with this ID (by `requester` when two members chose the same ID). */
function boardTaskFor(s: TaskHostState, group: string, taskId: string, requester?: string): BoardTask {
  const g = groupHost(s, group);
  const all = g ? boardTasksById(g.board, taskId).filter((t) => requester === undefined || t.requester === requester) : [];
  if (all.length === 0) throw new CliError(`no task ${taskId} on your board for group ${group} (see "rdv group board")`);
  if (all.length > 1) throw new CliError(`two members put a task ${taskId} on the board: say whose with --requester <agent-id>`);
  return all[0];
}

/**
 * Our claim, assign, unassign (task/release), cancel or input on a task of
 * the board. Who may do which is the board's rule (board.ts); a claim and an
 * input may carry text (an offer, an answer).
 */
export async function groupTaskVerb(home: Home, agent: Agent, group: string, taskId: string, verb: GroupVerb, opts: { assignee?: string; text?: string; requester?: string } = {}): Promise<GroupTaskRun> {
  const s = home.readTasks();
  const bt = boardTaskFor(s, group, taskId, opts.requester);
  let data: GroupVerbData;
  switch (verb) {
    case 'claim':
      data = { rdv: 'task/claim', requester: bt.requester };
      break;
    case 'assign': {
      if (!opts.assignee || !isAgentId(opts.assignee)) throw new CliError('assign names the member (an agent ID)', 2);
      // The board's rule, said first: only the requester assigns (an admin, once the requester left).
      const ctx = boardCtxOf(agent, group);
      if (ctx.members.includes(bt.requester) ? bt.requester !== agent.id : !ctx.admins.includes(agent.id)) {
        throw new CliError('not sent: only the requester assigns its task (an admin, once the requester left)');
      }
      if (opts.assignee === agent.id) throw new CliError('assign it to another member (to do it yourself, ask its requester)');
      const p = assigneeProblem(agent, group, opts.assignee, bt.capability);
      if (p) throw new CliError(p);
      data = { rdv: 'task/assign', requester: bt.requester, assignee: opts.assignee };
      break;
    }
    case 'unassign':
      data = { rdv: 'task/release', requester: bt.requester };
      break;
    case 'cancel':
      data = { rdv: 'rdv/cancel' };
      break;
    case 'input':
      if (opts.text === undefined) throw new CliError('an answer needs text', 2);
      data = { rdv: 'task/input' };
      break;
  }
  if ((verb === 'cancel' || verb === 'input') && bt.requester !== agent.id) throw new CliError(`only its requester ${verb === 'cancel' ? 'cancels' : 'answers for'} a task`);
  let payload: TaskPayload;
  try {
    payload = boardVerb(group, taskId, data, opts.text !== undefined && (verb === 'claim' || verb === 'input') ? { text: opts.text } : {});
  } catch (err) {
    if (err instanceof BoardError) throw new CliError(err.message, 2);
    throw err;
  }
  const to = bt.private ? postRecipients(groupViewOf(agent, s, group), bt.requester, bt.id).to : undefined;
  return postOwn(home, agent, group, payload, to, (state) => {
    // Giving back a task we were doing: our engine forgets it, and any draft with it.
    if (verb === 'unassign' && bt.assignee === agent.id) {
      const g = groupHost(state, group);
      const t = g && Object.hasOwn(g.engine.tasks, taskId) ? g.engine.tasks[taskId] : undefined;
      if (g && t && t.peer === bt.requester) {
        delete g.engine.tasks[taskId];
        delete g.releases[taskId];
      }
    }
  });
}

// --- views ---------------------------------------------------------------------------

/** One board task for display: peer-written fields (title, artifacts' text) stay peer text for the caller to mark. */
export function boardTaskView(agent: Agent, t: BoardTask) {
  return {
    task: t.id,
    requester: t.requester,
    requester_fingerprint: fingerprint(t.requester),
    capability: t.capability,
    title: t.title,
    ...(t.assignee ? { assignee: t.assignee, assignee_fingerprint: fingerprint(t.assignee) } : {}),
    claims: t.claims,
    state: t.state,
    open: t.assignee === undefined && !isFinished(t.state),
    yours: t.requester === agent.id ? 'requested' : t.assignee === agent.id ? 'assigned' : null,
    ...(t.reason ? { reason: t.reason } : {}),
    ...(t.referenceTaskIds ? { references: t.referenceTaskIds } : {}),
    ...(t.private ? { private: t.private } : {}),
    artifacts: t.artifacts.map((a) => ({ artifact: a.artifactId, ...(a.name !== undefined ? { name: a.name } : {}), text: a.text, data_parts: a.data, files: fileSummaries(a.files) ?? [], done: a.done })),
    expires: t.expires,
    created: t.created,
    updated: t.updated,
  };
}

export function boardView(agent: Agent, s: TaskHostState, group: string) {
  const r = agent.groups.group(group);
  const g = groupHost(s, group);
  const tasks = Object.values(g?.board.tasks ?? {}).sort((a, b) => a.created.localeCompare(b.created));
  return { event: 'group-board', group, name: r?.state.name ?? null, tasks: tasks.map((t) => boardTaskView(agent, t)) };
}

/** A member in a line: our label if a contact, else its fingerprint and "named by the admin as …". */
function whoText(agent: Agent, group: string, id: string): string {
  if (id === agent.id) return 'you';
  const c = agent.book.contact(id);
  if (c && !agent.book.isBlocked(id)) return `${clean(fingerprint(id))}${c.label !== undefined ? ` (${JSON.stringify(clean(c.label))})` : ''}`;
  const m = agent.groups.group(group) ? memberOf(agent.groups.group(group)!.state, id) : undefined;
  return `${clean(fingerprint(id))}${m?.name !== undefined ? ` (named by the admin as ${JSON.stringify(clean(m.name))})` : ''}`;
}

export function boardText(agent: Agent, s: TaskHostState, group: string): string {
  const v = boardView(agent, s, group);
  if (!v.tasks.length) return `group ${clean(group)}${v.name !== null ? ` ${JSON.stringify(clean(v.name))}` : ''}: nothing on the board`;
  const lines = [`group ${clean(group)}${v.name !== null ? ` ${JSON.stringify(clean(v.name))}` : ''}: ${v.tasks.length} task(s) on the board`];
  for (const t of v.tasks) {
    const who = t.assignee ? `assigned to ${whoText(agent, group, t.assignee)}` : t.open ? 'OPEN' : 'not assigned';
    lines.push(`- ${clean(t.task)}  ${clean(t.state)}  ${who}  asked by ${whoText(agent, group, t.requester)}  ${clean(t.capability)}`);
    lines.push(`    request (untrusted, written by the requester): ${JSON.stringify(clean(t.title))}`);
    if (t.claims.length) lines.push(`    claimed by: ${t.claims.map((c) => whoText(agent, group, c)).join(', ')}`);
    if (t.reason) lines.push(`    ${clean(t.reason)}`);
    if (t.references) lines.push(`    refers to: ${t.references.map((x) => clean(x)).join(', ')}`);
    for (const a of t.artifacts) {
      lines.push(`    result${a.name !== undefined ? ` ${JSON.stringify(clean(a.name))}` : ''} (untrusted): ${JSON.stringify(clean(a.text))}`);
      for (const f of a.files) lines.push(`      file (untrusted, not fetched): ${clean(describeFile(f))}`);
    }
  }
  return lines.join('\n');
}

/** A board event for the listener and the event log (peer text under peer_text, file summaries never with keys). */
export function boardEventView(e: BoardEvent) {
  return {
    event: 'group-task',
    kind: e.kind,
    group: e.group,
    task: e.task,
    requester: e.requester,
    ...(e.from ? { from: e.from } : {}),
    ...(e.assignee ? { assignee: e.assignee } : {}),
    ...(e.state ? { state: e.state } : {}),
    ...(e.capability ? { capability: e.capability } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.peerText?.length ? { peer_text: e.peerText } : {}),
    ...(e.data?.length ? { data: e.data } : {}),
    ...(e.files?.length ? { files: fileSummaries(e.files) } : {}),
    ...(e.artifactId ? { artifact: e.artifactId } : {}),
    ...(e.referenceTaskIds ? { references: e.referenceTaskIds } : {}),
  };
}

const KIND_WORDS: Record<BoardEvent['kind'], string> = {
  posted: 'put a task on the board',
  claimed: 'offers to do',
  assigned: 'assigned',
  released: 'gave back (open again)',
  reopened: 'is open again (its assignee left)',
  input: 'answered',
  status: 'reports',
  artifact: 'sent a result for',
  canceled: 'canceled',
  expired: 'expired',
  ignored: 'ignored',
};

export function boardEventText(agent: Agent, e: BoardEvent): string | undefined {
  if (e.kind === 'ignored' && e.from === agent.id) return undefined;
  const g = clean(e.group);
  const by = e.from ? `${whoText(agent, e.group, e.from)} ` : '';
  const task = `${clean(e.task)}${e.requester !== e.from ? ` (asked by ${whoText(agent, e.group, e.requester)})` : ''}`;
  const head =
    e.kind === 'assigned'
      ? `group ${g}: ${by}assigned task ${task} to ${e.assignee ? whoText(agent, e.group, e.assignee) : '?'}`
      : e.kind === 'status'
        ? `group ${g}: ${by}reports task ${task} ${clean(e.state ?? '')}`
        : e.kind === 'ignored'
          ? `group ${g}: ignored a message from ${by.trim() || 'a member'} about task ${task}: ${clean(e.reason ?? '')}`
          : `group ${g}: ${by}${KIND_WORDS[e.kind]} task ${task}${e.kind === 'posted' && e.assignee ? ` for ${whoText(agent, e.group, e.assignee)}` : ''}${e.reason && e.kind !== 'posted' ? ` (${clean(e.reason)})` : ''}`;
  const lines = [head];
  for (const t of e.peerText ?? []) lines.push(`  ${e.from ? 'they say' : 'text'} (untrusted): ${JSON.stringify(clean(t))}`);
  for (const d of e.data ?? []) lines.push(`  data (untrusted): ${clean(JSON.stringify(d))}`);
  for (const f of fileSummaries(e.files) ?? []) lines.push(`  file (untrusted, not fetched): ${clean(describeFile(f))}`);
  if (e.kind === 'posted' && !e.assignee && e.from !== agent.id) lines.push(`  open: to offer, rdv group claim ${g} ${clean(e.task)}`);
  if (e.kind === 'claimed' && e.requester === agent.id) lines.push(`  to give it to them: rdv group assign ${g} ${clean(e.task)} ${clean(e.from ?? '')}`);
  return lines.join('\n');
}

/** An event of a group lane's engine: a task event with its group (the commands that act on it take --group). */
export const groupTaskEventView = (e: TaskEvent & { group: string }) => ({ ...taskEventView(e), group: e.group });

export function groupTaskEventText(e: TaskEvent & { group: string }): string | undefined {
  const base = taskEventText(e);
  if (base === undefined) return undefined;
  const flag = ` --group ${clean(e.group)}`;
  return base.replace(/rdv task (approve|decline) (\S+)( --code <code>)?/g, (_m, verb: string, id: string, code: string | undefined) => `rdv task ${verb} ${id}${flag}${code ?? ''}`).replace(/^task /, `group ${clean(e.group)} task `);
}
