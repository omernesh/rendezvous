// Glue between the pure tasks/v1 engine (@rendezvous/a2a tasks.ts) and the
// hosts (`rdv`, `rdv-mcp`), like negotiate.ts for meetings (issues #24, #36,
// #39). It owns:
//
// - the capabilities this host implements (`request/v1`) and what the card
//   advertises for them (SPEC §4.3: only what we route);
// - the engine context: the grant that covers the direction, read through
//   core's rule (`effectiveInvoke`, never the raw `scope.invoke`, issue #39);
// - tasks.json (engine state, plus at most one draft per task waiting for
//   the release gate) and audit.jsonl;
// - the two human gates (SPEC §5.5). The engine says when a gate applies; the
//   approval is bound here to a digest of what the human was shown, checked
//   again under the home lock where the step runs, so a peer that re-requests
//   under the same task ID, or a draft that changed, gets nothing (the NOTES
//   59 pattern, generalized from meetingDigest).
//
// By approval class (SPEC §7.6.3):
//   notify     the task completes at once; the human is told; audited.
//   auto       the start gate passes on the grant alone; audited.
//   confirm,   the start gate needs the human (form, confirm phrase, or
//   free-form  `rdv task approve <id> --code`).
// Release: everything a host sends for a peer's task was written by its model
// or its human (owner data or a model's output, SPEC §5.5), so every draft
// passes the release gate, whatever the class (`rdv task release`).
import { randomUUID } from 'node:crypto';
import {
  askInput,
  type Capability,
  CapabilityRegistry,
  cancelTask,
  cardCapabilities,
  expireTasks,
  finishTask,
  inputTask,
  isFinished,
  receiveTask,
  rejectTask,
  REQUEST_CAPABILITY,
  requestTask,
  routeA2A,
  sendArtifact,
  startTask,
  SUPPORTED_EXTENSIONS,
  TaskError,
  TASKS_URI,
  type TaskCtx,
  type TaskEngineState,
  type TaskEvent,
  type TaskPart,
  type TaskRecord,
  type TaskStep,
} from '@rendezvous/a2a';
import { type Agent, type Contact, effectiveInvoke, fingerprint, type Payload } from '@rendezvous/core';
import type { PhraseTarget } from './consent.js';
import { type AuditEntry, CliError, type Home, type InboxEntry, type PendingRelease, type ReleaseContent, type TaskHostState } from './home.js';
import { clean } from './output.js';
import { sha, sha256, stable } from './hash.js';
import { autoApproved, subjectOf } from './autoapprove.js';

/** What this host implements (and so advertises): the general capability. */
export const HOST_CAPABILITIES: readonly Capability[] = [REQUEST_CAPABILITY];

/** The capability registry of a host: HOST_CAPABILITIES plus `extra` (tests, later slices). */
export function hostRegistry(extra: readonly Capability[] = []): CapabilityRegistry {
  return new CapabilityRegistry([...HOST_CAPABILITIES, ...extra]);
}

/** The card's `capabilities` for a host that routes tasks/v1 to `registry` (SPEC §4.3: advertise what we do). */
export function hostCardCapabilities(registry: CapabilityRegistry = hostRegistry()): string[] {
  return cardCapabilities([...SUPPORTED_EXTENSIONS, TASKS_URI, ...registry.uris()]);
}

// --- the engine context (issue #39) -------------------------------------------

/**
 * The context for one engine call. `inbound` (a peer's task to us, and our
 * executor steps): the grant our owner gave the peer; `outbound` (our task to
 * the peer): the peer's grant to us. Always through `effectiveInvoke`, so the
 * engine and `scopeAllows` agree on every scope shape (a malformed `invoke`
 * allows nothing; with `may_propose_meetings` the narrower wins).
 */
export function taskCtx(registry: CapabilityRegistry, contact: Contact | null | undefined, direction: 'inbound' | 'outbound', now = new Date()): TaskCtx {
  const scope = direction === 'inbound' ? contact?.inboundScope : contact?.outboundScope;
  return { now, registry, invoke: effectiveInvoke(scope ?? null), ...(contact?.tier ? { tier: contact.tier } : {}) };
}

/** An inbound payload: updates on a task we requested ride the peer's grant to us; anything else our grant to the peer. */
export function inboundTaskCtx(registry: CapabilityRegistry, contact: Contact | null | undefined, engine: TaskEngineState, payload: unknown, now = new Date()): TaskCtx {
  const p = payload as { message?: { taskId?: unknown }; update?: { taskId?: unknown } } | null;
  const id = p?.message?.taskId ?? p?.update?.taskId;
  const t = typeof id === 'string' && Object.hasOwn(engine.tasks, id) ? engine.tasks[id] : undefined;
  return taskCtx(registry, contact, t?.role === 'requester' && t.peer === contact?.peer ? 'outbound' : 'inbound', now);
}

// --- digests: what the human approves --------------------------------------------

/**
 * The digest a start approval is bound to (SPEC §5.5): the peer and its
 * fingerprint, contextId, taskId, the capability and class, the task's
 * `created`, the gate's step and when it opened, `input` (and the answer, for
 * a step `input`), each text part's SHA-256 and each file part's hash.
 * Undefined unless the task waits at the start gate.
 */
export function startDigest(t: TaskRecord): string | undefined {
  if (t.role !== 'executor' || !t.gate || isFinished(t.state) || t.tombstone) return undefined;
  return sha('rdv1/task-start', {
    peer: t.peer,
    fingerprint: fingerprint(t.peer),
    contextId: t.contextId,
    taskId: t.id,
    capability: t.capability,
    approval: t.approval ?? null,
    created: t.created,
    step: t.gate.step,
    since: t.gate.since,
    input: t.input ?? null,
    answer: t.gate.step === 'input' ? (t.answer ?? null) : null,
    text: (t.text ?? []).map(sha256),
    files: (t.files ?? []).map((f) => sha('rdv1/task-file', f)),
  });
}

/** The digest a release approval is bound to: the peer, the task, and exactly what would leave (SPEC §5.5). */
export function releaseDigest(t: TaskRecord | undefined, r: PendingRelease | undefined): string | undefined {
  if (!t || !r || t.role !== 'executor' || isFinished(t.state) || t.gate || r.taskId !== t.id || r.peer !== t.peer) return undefined;
  return sha('rdv1/task-release', { peer: t.peer, fingerprint: fingerprint(t.peer), taskId: t.id, contextId: t.contextId, capability: t.capability, created: t.created, content: r.content });
}

/** The short form `rdv task list` shows and `rdv task approve|release --code` takes (48 bits). */
export const gateCode = (digest: string): string => digest.slice(0, 12);

/** The confirm-phrase targets: every task waiting at the start gate, and every draft waiting for release. */
export function taskPhraseTargets(s: TaskHostState): PhraseTarget[] {
  const out: PhraseTarget[] = [];
  for (const t of Object.values(s.engine.tasks)) {
    const d = startDigest(t);
    if (d) out.push({ action: 'task-start', id: t.id, digest: d });
    const r = releaseDigest(t, Object.hasOwn(s.releases, t.id) ? s.releases[t.id] : undefined);
    if (r) out.push({ action: 'task-release', id: t.id, digest: r });
  }
  return out;
}

/** The task changed between the human's review and the step (same ID, other content): nothing was done. */
export class TaskChangedError extends CliError {}

// --- state -----------------------------------------------------------------------

/** Drop drafts whose task ended, vanished or went back to a start gate: they approve nothing now. */
export function pruneReleases(s: TaskHostState): void {
  for (const [id, r] of Object.entries(s.releases)) {
    const t = Object.hasOwn(s.engine.tasks, id) ? s.engine.tasks[id] : undefined;
    if (!t || t.role !== 'executor' || isFinished(t.state) || t.gate || r.taskId !== id || r.peer !== t.peer) delete s.releases[id];
  }
}

function audit(now: Date, t: { peer: string; capability: string; id: string; approval?: string }, gate: AuditEntry['gate'], by: AuditEntry['by'], digest?: string): AuditEntry {
  return { ts: now.toISOString(), peer: t.peer, capability: t.capability, task: t.id, gate, by, ...(t.approval ? { approval: t.approval } : {}), ...(digest ? { digest } : {}) };
}

/** The host side of a step's effects, before the state is saved: drafts of aborted tasks go, and gates passed without a prompt are audited. */
function applyEffects(s: TaskHostState, step: TaskStep, now: Date, by: AuditEntry['by'], audits: AuditEntry[], digest?: string): void {
  for (const e of step.effects) {
    const t = step.state.tasks[e.taskId];
    const rec = { peer: e.peer, capability: e.capability, id: e.taskId, approval: t?.approval };
    if (e.kind === 'abort') delete s.releases[e.taskId];
    else if (e.kind === 'start') audits.push(audit(now, rec, 'start', by, digest));
    else if (e.kind === 'notify') audits.push(audit(now, rec, 'notify', 'grant'));
  }
}

/** Send a step's messages. Returns errors; the step is applied either way. */
async function sendAll(agent: Agent, step: TaskStep): Promise<string[]> {
  const errors: string[] = [];
  for (const o of step.outgoing) {
    // No reply to a peer that is no longer a contact (the limiter just revoked it for abuse).
    if (!agent.book.contact(o.to)) continue;
    try {
      await agent.send(o.to, o.payload as unknown as Payload);
    } catch (err) {
      errors.push(`sending to ${o.to} failed: ${(err as Error).message}`);
    }
  }
  return errors;
}

export interface TaskRun {
  steps: TaskStep[];
  events: TaskEvent[];
  /**
   * Effects the host turns into events of its own: a notify task is shown to
   * the human; an auto task started on the grant alone; a task started on the
   * human's auto-approve for the contact (issue #25).
   */
  notices: Array<{ kind: 'notify' | 'started' | 'auto-started'; taskId: string; peer: string; capability: string }>;
  errors: string[];
}

/**
 * Feed inbound tasks/v1 payloads (and, with `sweep`, the expiry) to the
 * engine. Call inside the home lock, with an Agent loaded from it: state is
 * saved before any reply leaves (issue #4).
 */
export async function tasksInbound(home: Home, registry: CapabilityRegistry, agent: Agent, entries: InboxEntry[], sweep: boolean): Promise<TaskRun> {
  const run: TaskRun = { steps: [], events: [], notices: [], errors: [] };
  if (entries.length === 0 && !sweep) return run;
  const s = home.readTasks();
  const before = JSON.stringify(s);
  const now = new Date();
  const audits: AuditEntry[] = [];
  const autoSteps = new Set<TaskStep>();
  const autoStarted = new Set<string>();
  for (const e of entries) {
    const ctx = inboundTaskCtx(registry, agent.book.contact(e.from), s.engine, e.payload, now);
    // Core's per-capability limiter (issue #28): max_open and max_frequency from our grant; gross abuse revokes.
    const step = receiveTask(s.engine, e.from, e.payload, { ...ctx, limit: (cap, o) => agent.admitTask(e.from, cap, o, now) });
    applyEffects(s, step, now, 'grant', audits);
    s.engine = step.state;
    run.steps.push(step);
    // auto_approve: all (SPEC §5.5.1, issue #25): our human's standing approval for this contact passes its start gates.
    // Checked here, under the lock, for each gate: off, expired or no longer bound to the grant, and the gate stays shut.
    for (const fx of step.effects) {
      if (fx.kind !== 'start-gate' || fx.peer !== e.from) continue;
      const t = Object.hasOwn(s.engine.tasks, fx.taskId) ? s.engine.tasks[fx.taskId] : undefined;
      const digest = t ? startDigest(t) : undefined;
      if (!digest || !autoApproved(home, subjectOf(agent), fx.peer, now)) continue;
      let started: TaskStep;
      try {
        started = startTask(s.engine, fx.taskId, taskCtx(registry, agent.book.contact(fx.peer), 'inbound', now));
      } catch (err) {
        if (err instanceof TaskError) continue; // the gate stays for the human
        throw err;
      }
      applyEffects(s, started, now, 'auto-approve', audits, digest);
      s.engine = started.state;
      run.steps.push(started);
      autoSteps.add(started);
      autoStarted.add(fx.taskId);
    }
  }
  if (sweep) {
    const step = expireTasks(s.engine, { now });
    applyEffects(s, step, now, 'grant', audits);
    s.engine = step.state;
    run.steps.push(step);
  }
  pruneReleases(s);
  if (JSON.stringify(s) !== before) home.writeTasks(s);
  home.appendAudit(audits);
  for (const step of run.steps) {
    run.errors.push(...(await sendAll(agent, step)));
    // A gate auto-approve passed is not shown as waiting for the human.
    run.events.push(...step.events.filter((ev) => !(ev.kind === 'start-needed' && autoStarted.has(ev.taskId ?? ''))));
    for (const e of step.effects) {
      if (e.kind === 'notify' || e.kind === 'start') {
        const kind = e.kind === 'notify' ? 'notify' : autoSteps.has(step) ? 'auto-started' : 'started';
        run.notices.push({ kind, taskId: e.taskId, peer: e.peer, capability: e.capability });
      }
    }
  }
  return run;
}

/** Inbox entries the tasks engine takes (routeA2A), by the state on disk. Unreadable state routes nothing (reported by the caller). */
export function tasksRoute(home: Home, entries: InboxEntry[]): { tasks: InboxEntry[]; rest: InboxEntry[] } {
  const engine = home.readTasks().engine;
  const tasks: InboxEntry[] = [];
  const rest: InboxEntry[] = [];
  for (const e of entries) (routeA2A(e.payload, engine) === 'tasks' ? tasks : rest).push(e);
  return { tasks, rest };
}

/** Any open task that can expire? Unreadable state counts, so the sweep reports it. */
export function tasksExpiring(home: Home): boolean {
  try {
    return Object.values(home.readTasks().engine.tasks).some((t) => !isFinished(t.state) && t.expires !== null);
  } catch {
    return true;
  }
}

// --- owner steps (inside the caller's lock, with an Agent from it) -----------------

/** Engine errors are the caller's input (TaskError): usage errors, safe to show. */
function engine<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TaskError) throw new CliError(err.message);
    throw err;
  }
}

/** Save the state, then send: a crash mid-send leaves a task that expires, not a reply to an unknown task (issue #4). */
async function commit(home: Home, agent: Agent, s: TaskHostState, steps: TaskStep[], audits: AuditEntry[]): Promise<TaskRun> {
  pruneReleases(s);
  home.writeTasks(s);
  home.appendAudit(audits);
  const run: TaskRun = { steps, events: [], notices: [], errors: [] };
  for (const step of steps) {
    run.errors.push(...(await sendAll(agent, step)));
    run.events.push(...step.events);
  }
  return run;
}

function executorTask(s: TaskHostState, taskId: string): TaskRecord {
  const t = Object.hasOwn(s.engine.tasks, taskId) ? s.engine.tasks[taskId] : undefined;
  if (!t || t.role !== 'executor' || t.tombstone) throw new CliError(`no task ${taskId} from a peer`);
  return t;
}

/** A peer's task waiting at the start gate, as it is now, with the digest and code the human approves. */
export function startView(home: Home, taskId: string): { task: TaskRecord; digest: string } {
  const t = executorTask(home.readTasks(), taskId);
  const digest = startDigest(t);
  if (!digest) throw new CliError(`task ${taskId} is not waiting for your approval (state ${t.state})`);
  return { task: t, digest };
}

/** A draft waiting for release, as it is now, with its digest. */
export function releaseView(home: Home, taskId: string): { task: TaskRecord; release: PendingRelease; digest: string } {
  const s = home.readTasks();
  const t = executorTask(s, taskId);
  const r = Object.hasOwn(s.releases, taskId) ? s.releases[taskId] : undefined;
  const digest = releaseDigest(t, r);
  if (!r || !digest) throw new CliError(`task ${taskId} has no result waiting for your release`);
  return { task: t, release: r, digest };
}

/**
 * The start gate passed (the human approved exactly `digest`): act on the
 * task. Refused with TaskChangedError, nothing saved or sent, unless the task
 * is still the one the human reviewed.
 */
export async function approveStart(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest: string): Promise<TaskRun> {
  const s = home.readTasks();
  const t = executorTask(s, taskId);
  if (startDigest(t) !== digest) throw new TaskChangedError(`task ${taskId} changed since it was reviewed (or no longer waits for approval). Nothing was started.`);
  const now = new Date();
  const step = engine(() => startTask(s.engine, taskId, taskCtx(registry, agent.book.contact(t.peer), 'inbound', now)));
  const audits: AuditEntry[] = [];
  applyEffects(s, step, now, 'human', audits, digest);
  s.engine = step.state;
  return commit(home, agent, s, [step], audits);
}

/** Our human says no at the start gate (or refuses a task before it starts): `rejected`. Reduce-only; bound to `digest` when given. */
export async function declineStart(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest?: string): Promise<TaskRun> {
  const s = home.readTasks();
  const t = executorTask(s, taskId);
  if (digest !== undefined && startDigest(t) !== digest) throw new TaskChangedError(`task ${taskId} changed since it was reviewed. Nothing was declined.`);
  const now = new Date();
  const step = engine(() => rejectTask(s.engine, taskId, taskCtx(registry, agent.book.contact(t.peer), 'inbound', now)));
  const audits: AuditEntry[] = [];
  applyEffects(s, step, now, 'human', audits);
  s.engine = step.state;
  return commit(home, agent, s, [step], audits);
}

export type DraftInput =
  | { kind: 'artifact'; parts: TaskPart[]; name?: string; description?: string; complete?: boolean }
  | { kind: 'question'; text?: string; data?: Record<string, unknown> }
  | { kind: 'finish'; outcome: 'completed' | 'failed'; text?: string; data?: Record<string, unknown> };

/**
 * Offer something to send for a peer's task. The engine checks it (the task is
 * being worked on, the parts fit the capability, the grant still allows it),
 * and it is held as the task's draft for the release gate; it replaces any
 * earlier draft, whose approval then no longer matches. A `finish` without
 * text or data carries nothing of ours and is sent at once.
 */
export async function submitDraft(
  home: Home,
  agent: Agent,
  registry: CapabilityRegistry,
  taskId: string,
  draft: DraftInput,
): Promise<{ run: TaskRun; held?: PendingRelease; digest?: string; autoReleased?: boolean }> {
  const s = home.readTasks();
  const t = executorTask(s, taskId);
  const now = new Date();
  const ctx = taskCtx(registry, agent.book.contact(t.peer), 'inbound', now);
  let content: ReleaseContent;
  let step: TaskStep;
  if (draft.kind === 'artifact') {
    const artifact = { artifactId: randomUUID(), parts: draft.parts, ...(draft.name !== undefined ? { name: draft.name } : {}), ...(draft.description !== undefined ? { description: draft.description } : {}), lastChunk: true };
    content = { kind: 'artifact', artifact, ...(draft.complete ? { complete: true } : {}) };
    step = engine(() => sendArtifact(s.engine, taskId, ctx, artifact, { ownerData: true }));
  } else if (draft.kind === 'question') {
    content = { kind: 'question', ...(draft.text !== undefined ? { text: draft.text } : {}), ...(draft.data !== undefined ? { data: draft.data } : {}) };
    step = engine(() => askInput(s.engine, taskId, ctx, { text: draft.text, data: draft.data }, { ownerData: true }));
  } else {
    content = { kind: 'finish', outcome: draft.outcome, ...(draft.text !== undefined ? { text: draft.text } : {}), ...(draft.data !== undefined ? { data: draft.data } : {}) };
    step = engine(() => finishTask(s.engine, taskId, ctx, draft.outcome, { text: draft.text, data: draft.data }, { ownerData: true }));
  }
  const audits: AuditEntry[] = [];
  applyEffects(s, step, now, 'human', audits);
  s.engine = step.state;
  if (step.effects.some((e) => e.kind === 'release-gate')) {
    const held: PendingRelease = { taskId, peer: t.peer, content, created: now.toISOString() };
    s.releases[taskId] = held;
    const digest = releaseDigest(s.engine.tasks[taskId], held);
    // auto_approve: all (SPEC §5.5.1, issue #25): our human's standing approval for this contact releases it now,
    // checked here under the lock; off, expired or no longer bound to the grant, and it is held as always.
    if (digest && autoApproved(home, subjectOf(agent), t.peer, now)) {
      return { run: await releaseHeld(home, agent, registry, s, taskId, held, digest, 'auto-approve', audits, now), autoReleased: true };
    }
    const run = await commit(home, agent, s, [], audits);
    return { run, held, digest };
  }
  // Nothing to gate (a bare finish), or the grant no longer allows the task (the engine ended it, `scope`).
  delete s.releases[taskId];
  return { run: await commit(home, agent, s, [step], audits) };
}

/**
 * The release gate passed (the human approved exactly `digest`): send the
 * draft as it was shown. Refused with TaskChangedError, nothing sent, unless
 * the draft and the task are still the ones the human reviewed.
 */
export async function approveRelease(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest: string): Promise<TaskRun> {
  const s = home.readTasks();
  const t = executorTask(s, taskId);
  const r = Object.hasOwn(s.releases, taskId) ? s.releases[taskId] : undefined;
  if (!r || releaseDigest(t, r) !== digest) throw new TaskChangedError(`the result for task ${taskId} changed since it was reviewed (or the task ended). Nothing was sent.`);
  return releaseHeld(home, agent, registry, s, taskId, r, digest, 'human', [], new Date());
}

/** Send the held draft `r` (its digest checked by the caller) as it was shown, audit the release `by` whom, and commit. */
async function releaseHeld(
  home: Home,
  agent: Agent,
  registry: CapabilityRegistry,
  s: TaskHostState,
  taskId: string,
  r: PendingRelease,
  digest: string,
  by: AuditEntry['by'],
  audits: AuditEntry[],
  now: Date,
): Promise<TaskRun> {
  const t = executorTask(s, taskId);
  const ctx = () => taskCtx(registry, agent.book.contact(t.peer), 'inbound', now);
  const steps: TaskStep[] = [];
  const c = r.content;
  const released = { released: true, ownerData: true };
  let step: TaskStep;
  if (c.kind === 'artifact') {
    step = engine(() => sendArtifact(s.engine, taskId, ctx(), c.artifact, released));
    // The payload that leaves is the one the human saw.
    const sent = step.outgoing.find((o) => o.payload.type === 'a2a/artifact-update');
    if (sent && stable((sent.payload as { update: { artifact: unknown } }).update.artifact) !== stable({ ...c.artifact, extensions: [t.capability], append: undefined, lastChunk: undefined }))
      throw new CliError(`internal: the artifact for task ${taskId} is not the draft that was shown. Nothing was sent.`);
    steps.push(step);
    if (c.complete && step.outgoing.length && !isFinished(step.state.tasks[taskId]?.state ?? 'completed')) {
      steps.push(engine(() => finishTask(step.state, taskId, ctx(), 'completed')));
    }
  } else if (c.kind === 'question') {
    steps.push(engine(() => askInput(s.engine, taskId, ctx(), { text: c.text, data: c.data }, released)));
  } else {
    steps.push(engine(() => finishTask(s.engine, taskId, ctx(), c.outcome, { text: c.text, data: c.data }, released)));
  }
  for (const st of steps) applyEffects(s, st, now, by, audits);
  s.engine = steps[steps.length - 1].state;
  delete s.releases[taskId];
  const left = steps[0].events.some((e) => e.kind === 'artifact' || e.kind === 'input-required' || ((e.kind === 'completed' || e.kind === 'failed') && e.code !== 'scope'));
  if (left) {
    // What left: a hash and size of each payload (ours), never its text.
    const sent = steps.flatMap((st) => st.outgoing.filter((o) => o.to === t.peer).map((o) => ({ sha256: sha256(stable(o.payload)), bytes: Buffer.byteLength(stable(o.payload)) })));
    audits.push({ ...audit(now, { peer: t.peer, capability: t.capability, id: taskId, approval: t.approval }, 'release', by, digest), sent });
  }
  return commit(home, agent, s, steps, audits);
}

/** Throw away a draft (the human said no, or the model wants to redo it). Reduce-only. */
export function discardDraft(home: Home, taskId: string): boolean {
  const s = home.readTasks();
  if (!Object.hasOwn(s.releases, taskId)) return false;
  delete s.releases[taskId];
  home.writeTasks(s);
  return true;
}

/**
 * Ask a contact for a task. Checked against what the peer's grant lets us
 * invoke (effectiveInvoke of its grant to us) and against its card: a peer
 * whose card does not list tasks/v1 and the capability gets nothing (SPEC
 * §4.3); a card from before §7.5, with no capabilities, lists nothing.
 */
export async function requestPeer(
  home: Home,
  agent: Agent,
  registry: CapabilityRegistry,
  peer: string,
  capability: string,
  opts: { text?: string[]; input?: unknown; expires?: string },
): Promise<TaskRun & { taskId: string }> {
  const contact = agent.book.contact(peer);
  if (!contact) throw new CliError(`no active contact ${peer}`);
  const s = home.readTasks();
  const step = engine(() =>
    requestTask(s.engine, peer, capability, taskCtx(registry, contact, 'outbound'), {
      ...(opts.text?.length ? { text: opts.text } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
      peerCapabilities: contact.card?.capabilities ?? [],
    }),
  );
  s.engine = step.state;
  return { ...(await commit(home, agent, s, [step], [])), taskId: step.taskId };
}

/** Answer an executor's `input-required` on a task we requested. */
export async function answerPeer(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, opts: { text?: string[]; input?: unknown }): Promise<TaskRun> {
  const s = home.readTasks();
  const t = Object.hasOwn(s.engine.tasks, taskId) ? s.engine.tasks[taskId] : undefined;
  const step = engine(() => inputTask(s.engine, taskId, taskCtx(registry, t ? agent.book.contact(t.peer) : undefined, 'outbound'), opts));
  s.engine = step.state;
  return commit(home, agent, s, [step], []);
}

/** Withdraw a task we requested. Reduce-only. */
export async function cancelPeer(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, reason?: string): Promise<TaskRun> {
  const s = home.readTasks();
  const step = engine(() => cancelTask(s.engine, taskId, { now: new Date(), registry }, reason));
  s.engine = step.state;
  return commit(home, agent, s, [step], []);
}

// --- views ---------------------------------------------------------------------------

export function taskEventView(e: TaskEvent) {
  return {
    event: 'task',
    kind: e.kind,
    task: e.taskId,
    peer: e.peer,
    state: e.state,
    capability: e.capability,
    code: e.code,
    reason: e.reason,
    peer_text: e.peerText,
    data: e.data,
    files: e.files,
    artifact: e.artifactId,
    last_chunk: e.lastChunk,
  };
}

const safe = (v: unknown) => clean(v);

/** Text form for the terminal. Peer-written fields are marked untrusted and cleaned. */
export function taskEventText(e: TaskEvent): string | undefined {
  if (e.kind === 'duplicate') return undefined; // relays replay on every restart
  const lines = [`task ${safe(e.kind)} ${safe(e.taskId ?? '-')} with ${safe(e.peer)}${e.state ? `  state ${safe(e.state)}` : ''}${e.capability ? `  ${safe(e.capability)}` : ''}`];
  if (e.code) lines.push(`  reason code: ${safe(e.code)}`);
  if (e.reason) lines.push(`  reason (untrusted if from peer): ${safe(JSON.stringify(e.reason))}`);
  for (const t of e.peerText ?? []) lines.push(`  peer says (untrusted): ${safe(JSON.stringify(t))}`);
  for (const d of e.data ?? []) lines.push(`  peer data (untrusted): ${safe(JSON.stringify(d))}`);
  for (const f of e.files ?? []) lines.push(`  peer file (untrusted, not fetched): ${safe(JSON.stringify(f.file.name ?? f.file.uri ?? 'inline'))}`);
  if (e.kind === 'start-needed') lines.push(`  waiting for YOUR approval: rdv task list, then rdv task approve ${safe(e.taskId)} --code <code> (or rdv task decline ${safe(e.taskId)})`);
  return lines.join('\n');
}

/** A draft in words: exactly what would leave. */
export function describeDraft(c: ReleaseContent): string {
  if (c.kind === 'artifact') {
    const parts = c.artifact.parts.map((p) => (p.kind === 'text' ? `text: ${JSON.stringify(p.text)}` : p.kind === 'data' ? `data: ${JSON.stringify(p.data)}` : `file: ${JSON.stringify(p.file.name ?? 'unnamed')}`));
    return `result${c.artifact.name ? ` "${c.artifact.name}"` : ''}: ${parts.join('; ')}${c.complete ? ' (then the task ends completed)' : ''}`;
  }
  const body = [...(c.text !== undefined ? [`text: ${JSON.stringify(c.text)}`] : []), ...(c.data !== undefined ? [`data: ${JSON.stringify(c.data)}`] : [])].join('; ');
  return c.kind === 'question' ? `question for the requester: ${body}` : `end the task ${c.outcome}: ${body}`;
}

/** One task for `rdv task list` (JSON), with the codes `approve` and `release` take. */
export function taskListView(t: TaskRecord, s: TaskHostState) {
  const start = startDigest(t);
  const r = Object.hasOwn(s.releases, t.id) ? s.releases[t.id] : undefined;
  const rel = releaseDigest(t, r);
  const { seen: _seen, ...rest } = t;
  return {
    event: 'task',
    ...rest,
    fingerprint: fingerprint(t.peer),
    ...(start ? { start_code: gateCode(start) } : {}),
    ...(rel && r ? { draft: r.content, release_code: gateCode(rel) } : {}),
  };
}

export function taskListText(t: TaskRecord, s: TaskHostState): string {
  const v = taskListView(t, s);
  const lines = [`${safe(t.id)}  ${t.role} with ${safe(t.peer)} (${safe(v.fingerprint)})  ${safe(t.capability || '-')}  ${safe(t.state)}${t.approval ? `  class ${safe(t.approval)}` : ''}`];
  for (const x of t.text ?? []) lines.push(`  request (untrusted, written by the peer): ${safe(JSON.stringify(x))}`);
  if (t.input !== undefined) lines.push(`  input (untrusted): ${safe(JSON.stringify(t.input))}`);
  if (t.answer !== undefined) lines.push(`  answer (untrusted): ${safe(JSON.stringify(t.answer))}`);
  for (const f of t.files ?? []) lines.push(`  file (untrusted, not fetched; all of it, as approved): ${safe(JSON.stringify(f))}`);
  if (t.reason) lines.push(`  reason: ${safe(JSON.stringify(t.reason))}${t.code ? ` (${safe(t.code)})` : ''}`);
  if (v.start_code) lines.push(`  waiting for YOUR approval to start: rdv task approve ${safe(t.id)} --code ${v.start_code}  (or rdv task decline ${safe(t.id)})`);
  if (v.release_code && v.draft) {
    lines.push(`  waiting for YOUR release: ${safe(describeDraft(v.draft))}`);
    lines.push(`  to send it: rdv task release ${safe(t.id)} --code ${v.release_code}`);
  }
  return lines.join('\n');
}
