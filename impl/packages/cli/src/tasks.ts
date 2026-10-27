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
  artifactExtensions,
  type BoardCtx,
  type BoardEvent,
  type BoardState,
  boardReceive,
  boardTask,
  boardTasksById,
  emptyBoard,
  emptyTaskState,
  forBoard,
  askInput,
  type Capability,
  type FilePart,
  CapabilityRegistry,
  cancelTask,
  cardCapabilities,
  expireTasks,
  FILES_URI,
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
  type TaskPayload,
  type TaskRecord,
  type TaskStep,
} from '@rendezvous/a2a';
import { Agent, type Contact, effectiveInvoke, fingerprint, type GroupBody, type GroupRecord, groupRecipients, GROUPS_EXTENSION, memberIds, memberOf, type Payload, RECEIPTS_EXTENSION, type Transport } from '@rendezvous/core';
import { receiptsOff } from './delivery.js';
import type { PhraseTarget } from './consent.js';
import { changedAttachment, describeFile, describeNote, fileSummaries, fileSummary, normalizeTaskFiles, pruneReceived, redactFilePart, rememberReceived } from './files.js';
import { type AuditEntry, CliError, type FileNote, type GroupTaskHost, type HeldRequest, type Home, type InboxEntry, type PendingRelease, type ReleaseContent, type TaskHostState } from './home.js';
import { clean } from './output.js';
import { sha, sha256, stable } from './hash.js';
import { autoApprovedFor, subjectOf } from './autoapprove.js';

/** What this host implements (and so advertises): the general capability. */
export const HOST_CAPABILITIES: readonly Capability[] = [REQUEST_CAPABILITY];

/** The capability registry of a host: HOST_CAPABILITIES plus `extra` (tests, later slices). */
export function hostRegistry(extra: readonly Capability[] = []): CapabilityRegistry {
  return new CapabilityRegistry([...HOST_CAPABILITIES, ...extra]);
}

/** The card's `capabilities` for a host that routes tasks/v1 to `registry` (SPEC §4.3: advertise what we do). */
export function hostCardCapabilities(registry: CapabilityRegistry = hostRegistry()): string[] {
  return cardCapabilities([...SUPPORTED_EXTENSIONS, TASKS_URI, FILES_URI, GROUPS_EXTENSION, RECEIPTS_EXTENSION, ...registry.uris()]);
}

export interface CardRefresh {
  /** The card was re-signed (it lacked a capability this host routes). */
  refreshed: boolean;
  /** Its capabilities now, when refreshed. */
  capabilities?: string[];
  /** The public address topics the new card was published on (empty without a public pointer). */
  published: string[];
  /** Publishing failed; the re-signed card is saved and goes out on the next `rdv publish-card`. */
  error?: string;
}

/**
 * Issue #43: a card signed by older code lacks capabilities this host now
 * routes (tasks/v1, request/v1), so peers send it no tasks (SPEC §4.3). At a
 * listener's start: re-sign the card with them (same key, contacts, addresses
 * and hints; `created` a second past the old one) and republish it, as the
 * replaceable event, on each public address topic. Only when the card lacks
 * one: a restart on the same code changes nothing, on disk or on the relays.
 * `transport` is the listener's own connection (left open).
 */
export async function refreshHostCard(home: Home, capabilities: readonly string[], transport: Transport, now = new Date()): Promise<CardRefresh> {
  const agent = await home.locked(async () => {
    const a = Agent.fromJSON(home.readAgentState(), () => transport);
    // The owner turned receipts off (config.json "receipts": false, NOTES 98): the card stops saying we send them.
    const off = receiptsOff(home);
    if (!a.refreshCapabilities(off ? capabilities.filter((c) => c !== RECEIPTS_EXTENSION) : capabilities, { now, drop: off ? [RECEIPTS_EXTENSION] : [] })) return null;
    home.writeAgentState(a.toJSON());
    return a;
  });
  if (!agent) return { refreshed: false, published: [] };
  const capabilitiesNow = [...agent.card.capabilities];
  try {
    return { refreshed: true, capabilities: capabilitiesNow, published: await agent.publishPointers() };
  } catch (err) {
    return { refreshed: true, capabilities: capabilitiesNow, published: [], error: (err as Error).message };
  }
}

/** A card refresh in words, for the human (null when nothing changed). */
export function cardRefreshText(r: CardRefresh): string | null {
  if (!r.refreshed) return null;
  return (
    `your card was re-signed to advertise what this version supports (${(r.capabilities ?? []).filter((c) => c.startsWith('https://')).map((c) => clean(c)).join(', ')})` +
    (r.error ? `; publishing it failed (${clean(r.error)}): run "rdv publish-card"` : r.published.length ? `; republished on ${r.published.length} public address topic(s)` : '') +
    '. Contacts that already hold your older card keep it for now (sending it to them is not supported yet).'
  );
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

// --- tasks in a group (SPEC §7.8.4, issue #79) --------------------------------------
//
// A task assigned to us in a group runs on the same engine and the same gates
// as a pairwise one, in its own lane: tasks.json `groups[<group>]` holds its
// engine state (the requester is the engine's peer) and its drafts. What the
// requester may invoke is our group terms (our join's scope, read from the
// group record at each step, so narrowing them takes effect at once), and
// everything our engine sends goes to the board (or, for a private task, to
// its members) instead of the pairwise channel. A gate there is also bound to
// what the human is shown about the group: who asks (our contact or not, the
// admin's name for them), what the task refers to on the board, and, for a
// release, every member it goes to.

/** Consent key ID of a group task's gates: the group and the task (both UUIDs, so the key is unambiguous). */
export const groupTaskKey = (group: string, taskId: string): string => `${group}/${taskId}`;

export const emptyGroupHost = (group: string): GroupTaskHost => ({ board: emptyBoard(group), engine: emptyTaskState(), releases: {} });

/** One group's tasks in tasks.json (created when `create`). */
export function groupHost(s: TaskHostState, group: string, create = false): GroupTaskHost | undefined {
  if (s.groups && Object.hasOwn(s.groups, group)) return s.groups[group];
  if (!create) return undefined;
  s.groups = { ...(s.groups ?? {}), [group]: emptyGroupHost(group) };
  return s.groups[group];
}

/** Where a task's engine state and drafts live: the pairwise lane, or one group's. */
interface Lane {
  group?: string;
  engine: TaskEngineState;
  readonly releases: Record<string, PendingRelease>;
}

function lane(s: TaskHostState, group?: string): Lane {
  if (group === undefined) {
    return {
      get engine() {
        return s.engine;
      },
      set engine(v) {
        s.engine = v;
      },
      get releases() {
        return s.releases;
      },
    };
  }
  const g = groupHost(s, group);
  if (!g) throw new CliError(`no tasks in group ${group}`);
  return {
    group,
    get engine() {
      return g.engine;
    },
    set engine(v) {
      g.engine = v;
    },
    get releases() {
      return g.releases;
    },
  };
}

/** What the host knows of a group when it shows one of its tasks: the record, our board, and who our contacts are. */
export interface GroupView {
  group: string;
  me: string;
  record?: GroupRecord;
  board: BoardState;
  isContact: (peer: string) => boolean;
  label?: (peer: string) => string | undefined;
  isBlocked?: (peer: string) => boolean;
}

export function groupViewOf(agent: Agent, s: TaskHostState, group: string): GroupView {
  return {
    group,
    me: agent.id,
    record: agent.groups.group(group),
    board: groupHost(s, group)?.board ?? emptyBoard(group),
    isContact: (p) => !!agent.book.contact(p) && !agent.book.isBlocked(p),
    label: (p) => agent.book.contact(p)?.label,
    isBlocked: (p) => agent.book.isBlocked(p),
  };
}

/** The board's context: the members of the state we hold who have not left, and its admins. */
export function boardCtxOf(agent: Agent, group: string, now = new Date()): BoardCtx {
  const r = agent.groups.group(group);
  const here = (id: string) => !(r?.departed && Object.hasOwn(r.departed, id));
  const members = r && r.status === 'active' ? memberIds(r.state).filter(here) : [];
  const admins = r && r.status === 'active' ? r.state.members.filter((m) => m.role === 'admin' && here(m.id)).map((m) => m.id) : [];
  return { now, me: agent.id, members, admins };
}

/**
 * Who a post about this task reaches: for a private task, its members and its
 * requester (those we send to); otherwise every member we send to (§7.8.3).
 * `to` is set for a private post.
 */
export function postRecipients(v: GroupView, requester: string, taskId: string): { to?: string[]; recipients: string[] } {
  const all = v.record && v.record.status === 'active' ? groupRecipients(v.record, v.me).filter((p) => !v.isBlocked?.(p)) : [];
  const bt = boardTask(v.board, requester, taskId);
  if (bt?.private) {
    const to = [...new Set([...bt.private, bt.requester])].filter((id) => id !== v.me && all.includes(id)).sort();
    return { to, recipients: to };
  }
  return { recipients: [...all].sort() };
}

/** A member as the human is shown it: its ID, the card the state pins, the admin's name, and whether it is our contact (with our label). */
function memberShown(v: GroupView, id: string) {
  const m = v.record ? memberOf(v.record.state, id) : undefined;
  const contact = v.isContact(id);
  return { id, card: m?.card ?? null, name: m?.name ?? null, contact, label: contact ? (v.label?.(id) ?? null) : null };
}
type MemberShown = ReturnType<typeof memberShown>;

/** The tasks a group task refers to, as our board holds them (design B.5 step 7: "the input is Dana's artifact"). */
function refsShown(v: GroupView, t: TaskRecord) {
  return (t.referenceTaskIds ?? [])
    .flatMap((id) => boardTasksById(v.board, id))
    .map((bt) => ({
      task: bt.id,
      requester: memberShown(v, bt.requester),
      assignee: bt.assignee ? memberShown(v, bt.assignee) : null,
      state: bt.state,
      title: bt.title,
      artifacts: bt.artifacts.map((a) => ({ id: a.artifactId, name: a.name ?? null, text: a.text, files: a.files.map((f) => sha('rdv1/task-file', f)) })),
    }));
}

/** What a group task's start gate shows beyond the task (and is bound to): the group, who asks, what it refers to. */
export const groupStartShown = (v: GroupView, t: TaskRecord) => ({ group: v.group, name: v.record?.state.name ?? null, requester: memberShown(v, t.peer), refs: refsShown(v, t) });

/** What a group task's release gate shows beyond the draft (and is bound to): every member it goes to. */
export const groupReleaseShown = (v: GroupView, t: TaskRecord) => ({
  group: v.group,
  name: v.record?.state.name ?? null,
  to: postRecipients(v, t.peer, t.id).recipients.map((id) => memberShown(v, id)),
});

const memberWords = (m: MemberShown): string =>
  `${fingerprint(m.id)}, ${m.contact ? `your contact${m.label !== null ? ` ${JSON.stringify(clean(m.label))}` : ''}` : `not your contact${m.name !== null ? `, named by the admin as ${JSON.stringify(clean(m.name))}` : ''}`}`;

/** The group part of a start gate, in words (peer text quoted and cleaned). */
export function describeGroupStart(v: GroupView, t: TaskRecord): string[] {
  const s = groupStartShown(v, t);
  const lines = [`in group ${JSON.stringify(clean(s.name ?? v.group))} (${v.group}), asked by ${memberWords(s.requester)}`];
  for (const r of s.refs) {
    lines.push(`it refers to task ${r.task} (${r.state}${r.assignee ? `, done by ${memberWords(r.assignee)}` : ''}): ${JSON.stringify(clean(r.title))} (untrusted)`);
    for (const a of r.artifacts) lines.push(`  its result${a.name !== null ? ` ${JSON.stringify(clean(a.name))}` : ''} (untrusted): ${JSON.stringify(clean(a.text))}${a.files.length ? ` and ${a.files.length} file(s)` : ''}`);
  }
  return lines;
}

/** The group part of a release gate, in words: who receives it. */
export function describeGroupRelease(v: GroupView, t: TaskRecord): string {
  const s = groupReleaseShown(v, t);
  return `it goes to ${s.to.length} member(s) of group ${JSON.stringify(clean(s.name ?? v.group))}: ${s.to.map(memberWords).join('; ') || 'nobody (no member you send to)'}`;
}

/** The engine context for our steps on a group task: what members may invoke is our group terms, read now. */
export function groupTaskCtx(registry: CapabilityRegistry, agent: Agent, group: string, now = new Date()): TaskCtx {
  const r = agent.groups.group(group);
  return { now, registry, invoke: r && r.status === 'active' ? (r.scope.invoke ?? {}) : null };
}

/** A post our engine (or our human) makes about a group task, applied to our own board before it is sent. */
export interface BoardPost {
  group: string;
  payload: TaskPayload;
  to?: string[];
}

/**
 * Turn engine steps of a group lane into board posts: each status and
 * artifact names its requester (GROUP_REQUESTER_KEY), goes to the board (or
 * the task's private members), and is applied to our own board first, so
 * what we show is what we sent. Call before the state is written.
 */
export function boardPosts(agent: Agent, s: TaskHostState, group: string, steps: TaskStep[], now = new Date()): { posts: BoardPost[]; events: BoardEvent[] } {
  const g = groupHost(s, group, true)!;
  const posts: BoardPost[] = [];
  const events: BoardEvent[] = [];
  for (const step of steps) {
    for (const o of step.outgoing) {
      const payload = forBoard(o.payload, o.to);
      const id = payload.type === 'a2a/message' ? payload.message.taskId : payload.update.taskId;
      const { to } = postRecipients(groupViewOf(agent, s, group), o.to, id);
      if (to && to.length === 0) continue; // a private task none of whose members we send to
      const applied = boardReceive(g.board, { from: agent.id, body: payload, board: !to, ...(to ? { to } : {}) }, boardCtxOf(agent, group, now));
      g.board = applied.board;
      events.push(...applied.events);
      posts.push({ group, payload, ...(to ? { to } : {}) });
    }
  }
  return { posts, events };
}

/** Send board posts (after the state is saved). Returns errors; the rest still go. */
export async function sendPosts(agent: Agent, posts: BoardPost[]): Promise<string[]> {
  const errors: string[] = [];
  for (const p of posts) {
    try {
      const r = await agent.sendGroup(p.group, p.payload as unknown as GroupBody, p.to ? { to: p.to } : {});
      for (const f of r.failed) errors.push(`posting to ${f.peer} in group ${p.group} failed: ${f.error}`);
    } catch (err) {
      errors.push(`posting to group ${p.group} failed: ${(err as Error).message}`);
    }
  }
  return errors;
}

// --- digests: what the human approves --------------------------------------------

/**
 * The digest a start approval is bound to (SPEC §5.5): the peer and its
 * fingerprint, contextId, taskId, the capability and class, the task's
 * `created`, the gate's step and when it opened, `input` (and the answer, for
 * a step `input`), each text part's SHA-256 and each file part's hash.
 * Undefined unless the task waits at the start gate.
 */
export function startDigest(t: TaskRecord, group?: unknown): string | undefined {
  if (t.role !== 'executor' || !t.gate || isFinished(t.state) || t.tombstone) return undefined;
  return sha('rdv1/task-start', {
    ...(group !== undefined ? { group } : {}),
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
export function releaseDigest(t: TaskRecord | undefined, r: PendingRelease | undefined, group?: unknown): string | undefined {
  if (!t || !r || t.role !== 'executor' || isFinished(t.state) || t.gate || r.taskId !== t.id || r.peer !== t.peer) return undefined;
  return sha('rdv1/task-release', { ...(group !== undefined ? { group } : {}), peer: t.peer, fingerprint: fingerprint(t.peer), taskId: t.id, contextId: t.contextId, capability: t.capability, created: t.created, content: r.content });
}

/** The short form `rdv task list` shows and `rdv task approve|release --code` takes (48 bits). */
export const gateCode = (digest: string): string => digest.slice(0, 12);

/**
 * The confirm-phrase targets: every task waiting at the start gate, and every
 * draft waiting for release; with `views`, those of the group lanes too
 * (keyed by groupTaskKey, bound to what the human is shown about the group).
 */
export function taskPhraseTargets(s: TaskHostState, views?: (group: string) => GroupView | undefined): PhraseTarget[] {
  const out: PhraseTarget[] = [];
  for (const t of Object.values(s.engine.tasks)) {
    const d = startDigest(t);
    if (d) out.push({ action: 'task-start', id: t.id, digest: d });
    const r = releaseDigest(t, Object.hasOwn(s.releases, t.id) ? s.releases[t.id] : undefined);
    if (r) out.push({ action: 'task-release', id: t.id, digest: r });
  }
  // Our requests that carry the owner's files (issue #53): released like a draft. Hold IDs are ours (UUIDs).
  for (const h of Object.values(s.requests ?? {})) out.push({ action: 'task-release', id: h.id, digest: heldRequestDigest(h) });
  for (const [group, g] of Object.entries(s.groups ?? {})) {
    const v = views?.(group);
    if (!v) continue;
    for (const t of Object.values(g.engine.tasks)) {
      const d = t.gate ? startDigest(t, groupStartShown(v, t)) : undefined;
      if (d) out.push({ action: 'task-start', id: groupTaskKey(group, t.id), digest: d });
      const rel = Object.hasOwn(g.releases, t.id) ? g.releases[t.id] : undefined;
      const r = rel ? releaseDigest(t, rel, groupReleaseShown(v, t)) : undefined;
      if (r) out.push({ action: 'task-release', id: groupTaskKey(group, t.id), digest: r });
    }
  }
  return out;
}

/** The digest a held request's release is bound to: the recipient and exactly what would leave, files as shown. */
export const heldRequestDigest = (h: HeldRequest): string =>
  sha('rdv1/task-request-release', {
    id: h.id,
    peer: h.peer,
    fingerprint: fingerprint(h.peer),
    capability: h.capability,
    text: h.text ?? null,
    input: h.input ?? null,
    expires: h.expires ?? null,
    files: h.files,
    notes: h.notes,
    created: h.created,
  });

/** A held request in words: to whom, what, and each file (name, size, hash, encryption, URL, source). */
export function describeHeldRequest(h: HeldRequest): string {
  const parts = [
    ...(h.text ?? []).map((t) => `text: ${JSON.stringify(t)}`),
    ...(h.input !== undefined ? [`input: ${JSON.stringify(h.input)}`] : []),
    ...h.notes.map((n) => `file: ${describeNote(n)}`),
  ];
  return `request to ${h.peer} (${fingerprint(h.peer)}) for ${h.capability}: ${parts.join('; ')}`;
}

/** At most this many held requests are kept, and none past its deadline or a week old. */
export const MAX_HELD_REQUESTS = 32;
const HELD_REQUEST_MAX_MS = 7 * 86_400_000;

/** The task changed between the human's review and the step (same ID, other content): nothing was done. */
export class TaskChangedError extends CliError {}

// --- state -----------------------------------------------------------------------

/** Drop drafts whose task ended, vanished or went back to a start gate: they approve nothing now (and received files whose task is gone). */
export function pruneReleases(s: TaskHostState, now = new Date()): void {
  pruneReceived(s);
  if (s.requests) {
    const t = now.getTime();
    const held = Object.values(s.requests).sort((a, b) => a.created.localeCompare(b.created));
    for (const [i, h] of held.entries()) {
      const created = Date.parse(h.created);
      const expires = h.expires === undefined ? NaN : Date.parse(h.expires);
      if (!(created <= t && t - created < HELD_REQUEST_MAX_MS) || expires <= t || i < held.length - MAX_HELD_REQUESTS) delete s.requests[h.id];
    }
    if (Object.keys(s.requests).length === 0) delete s.requests;
  }
  const prune = (engine: TaskEngineState, releases: Record<string, PendingRelease>) => {
    for (const [id, r] of Object.entries(releases)) {
      const t = Object.hasOwn(engine.tasks, id) ? engine.tasks[id] : undefined;
      if (!t || t.role !== 'executor' || isFinished(t.state) || t.gate || r.taskId !== id || r.peer !== t.peer) delete releases[id];
    }
  };
  prune(s.engine, s.releases);
  for (const g of Object.values(s.groups ?? {})) prune(g.engine, g.releases);
}

function audit(now: Date, t: { peer: string; capability: string; id: string; approval?: string; group?: string }, gate: AuditEntry['gate'], by: AuditEntry['by'], digest?: string): AuditEntry {
  return { ts: now.toISOString(), peer: t.peer, capability: t.capability, task: t.id, ...(t.group ? { group: t.group } : {}), gate, by, ...(t.approval ? { approval: t.approval } : {}), ...(digest ? { digest } : {}) };
}

/** The host side of a step's effects, before the state is saved: drafts of aborted tasks go, and gates passed without a prompt are audited. */
export function applyEffects(l: { readonly releases: Record<string, PendingRelease>; group?: string }, step: TaskStep, now: Date, by: AuditEntry['by'], audits: AuditEntry[], digest?: string): void {
  for (const e of step.effects) {
    const t = step.state.tasks[e.taskId];
    const rec = { peer: e.peer, capability: e.capability, id: e.taskId, approval: t?.approval, group: l.group };
    if (e.kind === 'abort') delete l.releases[e.taskId];
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
  /** A group lane's run (SPEC §7.8.4): its events are about a task in this group. */
  group?: string;
  /** What our own posts did to our board (group lanes). */
  board?: BoardEvent[];
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
    // Files (SPEC §7.7): every file part is validated with core's parseFilePart and kept in its sanitized form. Never fetched here.
    const files = normalizeTaskFiles(e.payload);
    if (!files.ok) {
      run.events.push({ kind: 'invalid', taskId: files.taskId, peer: e.from, reason: files.reason });
      continue;
    }
    const ctx = inboundTaskCtx(registry, agent.book.contact(e.from), s.engine, files.payload, now);
    // Core's per-capability limiter (issue #28): max_open and max_frequency from our grant; gross abuse revokes.
    const step = receiveTask(s.engine, e.from, files.payload, { ...ctx, limit: (cap, o) => agent.admitTask(e.from, cap, o, now) });
    applyEffects(lane(s), step, now, 'grant', audits);
    s.engine = step.state;
    // A result's files, for a task we requested: kept so our agent can fetch them later, if it chooses.
    for (const ev of step.events) if (ev.kind === 'artifact' && ev.files?.length && ev.taskId) rememberReceived(s, ev.taskId, e.from, ev.files);
    run.steps.push(step);
    // auto_approve: all (SPEC §5.5.1, issue #25): our human's standing approval for this contact passes its start gates.
    // Checked here, under the lock, for each gate: off, expired or no longer bound to the grant, and the gate stays shut.
    for (const fx of step.effects) {
      if (fx.kind !== 'start-gate' || fx.peer !== e.from) continue;
      const t = Object.hasOwn(s.engine.tasks, fx.taskId) ? s.engine.tasks[fx.taskId] : undefined;
      const digest = t ? startDigest(t) : undefined;
      // Only for a capability the entry covers (what the owner was shown, within the grant now).
      if (!digest || !autoApprovedFor(home, subjectOf(agent), fx.peer, fx.capability, now)) continue;
      let started: TaskStep;
      try {
        started = startTask(s.engine, fx.taskId, taskCtx(registry, agent.book.contact(fx.peer), 'inbound', now));
      } catch (err) {
        if (err instanceof TaskError) continue; // the gate stays for the human
        throw err;
      }
      applyEffects(lane(s), started, now, 'auto-approve', audits, digest);
      s.engine = started.state;
      run.steps.push(started);
      autoSteps.add(started);
      autoStarted.add(fx.taskId);
    }
  }
  if (sweep) {
    const step = expireTasks(s.engine, { now });
    applyEffects(lane(s), step, now, 'grant', audits);
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
    const s = home.readTasks();
    const open = (tasks: Record<string, TaskRecord>) => Object.values(tasks).some((t) => !isFinished(t.state) && t.expires !== null);
    // Group lanes too (issue #79): their engines, and their boards' open tasks and early messages.
    return open(s.engine.tasks) || Object.values(s.groups ?? {}).some((g) => open(g.engine.tasks) || Object.values(g.board.tasks).some((t) => !isFinished(t.state)) || !!g.board.early?.length);
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

/**
 * Save the state, then send: a crash mid-send leaves a task that expires, not
 * a reply to an unknown task (issue #4). A group lane's messages go to the
 * board (applied to our own board before the save).
 */
async function commit(home: Home, agent: Agent, s: TaskHostState, steps: TaskStep[], audits: AuditEntry[], group?: string): Promise<TaskRun> {
  pruneReleases(s);
  const board = group !== undefined ? boardPosts(agent, s, group, steps) : undefined;
  home.writeTasks(s);
  home.appendAudit(audits);
  const run: TaskRun = { steps, events: [], notices: [], errors: [], ...(group !== undefined ? { group, board: board!.events } : {}) };
  for (const step of steps) {
    if (group === undefined) run.errors.push(...(await sendAll(agent, step)));
    run.events.push(...step.events);
  }
  if (board) run.errors.push(...(await sendPosts(agent, board.posts)));
  return run;
}

function executorTask(engine: TaskEngineState, taskId: string, group?: string): TaskRecord {
  const t = Object.hasOwn(engine.tasks, taskId) ? engine.tasks[taskId] : undefined;
  if (!t || t.role !== 'executor' || t.tombstone) throw new CliError(group ? `no task ${taskId} of yours in group ${group}` : `no task ${taskId} from a peer`);
  return t;
}

/** A group lane: which group, and the agent that knows it (for what the human is shown about it). */
export interface InGroup {
  group: string;
  agent: Agent;
}

/** A peer's task waiting at the start gate, as it is now, with the digest and code the human approves. */
export function startView(home: Home, taskId: string, g?: InGroup): { task: TaskRecord; digest: string } {
  const s = home.readTasks();
  const t = executorTask(lane(s, g?.group).engine, taskId, g?.group);
  const digest = startDigest(t, g && t.gate ? groupStartShown(groupViewOf(g.agent, s, g.group), t) : undefined);
  if (!digest) throw new CliError(`task ${taskId} is not waiting for your approval (state ${t.state})`);
  return { task: t, digest };
}

/** A draft waiting for release, as it is now, with its digest. */
export function releaseView(home: Home, taskId: string, g?: InGroup): { task: TaskRecord; release: PendingRelease; digest: string } {
  const s = home.readTasks();
  const l = lane(s, g?.group);
  const t = executorTask(l.engine, taskId, g?.group);
  const r = Object.hasOwn(l.releases, taskId) ? l.releases[taskId] : undefined;
  const digest = releaseDigest(t, r, g ? groupReleaseShown(groupViewOf(g.agent, s, g.group), t) : undefined);
  if (!r || !digest) throw new CliError(`task ${taskId} has no result waiting for your release`);
  return { task: t, release: r, digest };
}

/** The engine context for our own step on a task in lane `l` (the grant we gave the peer, or our group terms). */
function stepCtx(registry: CapabilityRegistry, agent: Agent, l: Lane, t: TaskRecord, now: Date): TaskCtx {
  return l.group !== undefined ? groupTaskCtx(registry, agent, l.group, now) : taskCtx(registry, agent.book.contact(t.peer), 'inbound', now);
}

/**
 * The start gate passed (the human approved exactly `digest`): act on the
 * task. Refused with TaskChangedError, nothing saved or sent, unless the task
 * is still the one the human reviewed.
 */
export async function approveStart(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest: string, group?: string): Promise<TaskRun> {
  const s = home.readTasks();
  const l = lane(s, group);
  const t = executorTask(l.engine, taskId, group);
  const shown = group !== undefined && t.gate ? groupStartShown(groupViewOf(agent, s, group), t) : undefined;
  if (startDigest(t, shown) !== digest) throw new TaskChangedError(`task ${taskId} changed since it was reviewed (or no longer waits for approval). Nothing was started.`);
  const now = new Date();
  const step = engine(() => startTask(l.engine, taskId, stepCtx(registry, agent, l, t, now)));
  const audits: AuditEntry[] = [];
  applyEffects(l, step, now, 'human', audits, digest);
  l.engine = step.state;
  return commit(home, agent, s, [step], audits, group);
}

/** Our human says no at the start gate (or refuses a task before it starts): `rejected`. Reduce-only; bound to `digest` when given. */
export async function declineStart(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest?: string, group?: string): Promise<TaskRun> {
  const s = home.readTasks();
  const l = lane(s, group);
  const t = executorTask(l.engine, taskId, group);
  const shown = group !== undefined && t.gate ? groupStartShown(groupViewOf(agent, s, group), t) : undefined;
  if (digest !== undefined && startDigest(t, shown) !== digest) throw new TaskChangedError(`task ${taskId} changed since it was reviewed. Nothing was declined.`);
  const now = new Date();
  const step = engine(() => rejectTask(l.engine, taskId, stepCtx(registry, agent, l, t, now)));
  const audits: AuditEntry[] = [];
  applyEffects(l, step, now, 'human', audits);
  l.engine = step.state;
  return commit(home, agent, s, [step], audits, group);
}

export type DraftInput =
  | { kind: 'artifact'; parts: TaskPart[]; name?: string; description?: string; complete?: boolean; files?: FileNote[] }
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
  group?: string,
): Promise<{ run: TaskRun; held?: PendingRelease; digest?: string; autoReleased?: boolean }> {
  const s = home.readTasks();
  const l = lane(s, group);
  const t = executorTask(l.engine, taskId, group);
  const now = new Date();
  const ctx = stepCtx(registry, agent, l, t, now);
  let content: ReleaseContent;
  let step: TaskStep;
  if (draft.kind === 'artifact') {
    if (draft.parts.some((p) => p.kind === 'file')) {
      if (group === undefined) needsFilesExtension(agent, t.peer);
      // A result in a group goes to every member we send to: each one's card must list the files extension.
      else for (const p of postRecipients(groupViewOf(agent, s, group), t.peer, t.id).recipients) needsFilesExtension(agent, p);
    }
    const artifact = { artifactId: randomUUID(), parts: draft.parts, ...(draft.name !== undefined ? { name: draft.name } : {}), ...(draft.description !== undefined ? { description: draft.description } : {}), lastChunk: true };
    content = { kind: 'artifact', artifact, ...(draft.complete ? { complete: true } : {}), ...(draft.files?.length ? { files: draft.files } : {}) };
    step = engine(() => sendArtifact(l.engine, taskId, ctx, artifact, { ownerData: true }));
  } else if (draft.kind === 'question') {
    content = { kind: 'question', ...(draft.text !== undefined ? { text: draft.text } : {}), ...(draft.data !== undefined ? { data: draft.data } : {}) };
    step = engine(() => askInput(l.engine, taskId, ctx, { text: draft.text, data: draft.data }, { ownerData: true }));
  } else {
    content = { kind: 'finish', outcome: draft.outcome, ...(draft.text !== undefined ? { text: draft.text } : {}), ...(draft.data !== undefined ? { data: draft.data } : {}) };
    step = engine(() => finishTask(l.engine, taskId, ctx, draft.outcome, { text: draft.text, data: draft.data }, { ownerData: true }));
  }
  const audits: AuditEntry[] = [];
  applyEffects(l, step, now, 'human', audits);
  l.engine = step.state;
  if (step.effects.some((e) => e.kind === 'release-gate')) {
    const held: PendingRelease = { taskId, peer: t.peer, content, created: now.toISOString() };
    l.releases[taskId] = held;
    const nowTask = l.engine.tasks[taskId];
    const digest = releaseDigest(nowTask, held, group !== undefined ? groupReleaseShown(groupViewOf(agent, s, group), nowTask) : undefined);
    // auto_approve: all (SPEC §5.5.1, issue #25): our human's standing approval for this contact releases it now,
    // checked here under the lock; off, expired or no longer bound to the grant, and it is held as always.
    // Never for a task in a group: a pairwise entry covers what the contact's grant allows, not what our group terms do.
    if (group === undefined && digest && typeof t.capability === 'string' && autoApprovedFor(home, subjectOf(agent), t.peer, t.capability, now)) {
      return { run: await releaseHeld(home, agent, registry, s, taskId, held, digest, 'auto-approve', audits, now), autoReleased: true };
    }
    const run = await commit(home, agent, s, [], audits, group);
    return { run, held, digest };
  }
  // Nothing to gate (a bare finish), or the grant no longer allows the task (the engine ended it, `scope`).
  delete l.releases[taskId];
  return { run: await commit(home, agent, s, [step], audits, group) };
}

/**
 * The release gate passed (the human approved exactly `digest`): send the
 * draft as it was shown. Refused with TaskChangedError, nothing sent, unless
 * the draft and the task are still the ones the human reviewed.
 */
export async function approveRelease(home: Home, agent: Agent, registry: CapabilityRegistry, taskId: string, digest: string, group?: string): Promise<TaskRun> {
  const s = home.readTasks();
  const l = lane(s, group);
  const t = executorTask(l.engine, taskId, group);
  const r = Object.hasOwn(l.releases, taskId) ? l.releases[taskId] : undefined;
  const shown = group !== undefined ? groupReleaseShown(groupViewOf(agent, s, group), t) : undefined;
  if (!r || releaseDigest(t, r, shown) !== digest) throw new TaskChangedError(`the result for task ${taskId} changed since it was reviewed (or the task ended). Nothing was sent.`);
  return releaseHeld(home, agent, registry, s, taskId, r, digest, 'human', [], new Date(), group);
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
  group?: string,
): Promise<TaskRun> {
  const l = lane(s, group);
  const t = executorTask(l.engine, taskId, group);
  const ctx = () => stepCtx(registry, agent, l, t, now);
  const steps: TaskStep[] = [];
  const c = r.content;
  const released = { released: true, ownerData: true };
  let step: TaskStep;
  if (c.kind === 'artifact') {
    step = engine(() => sendArtifact(l.engine, taskId, ctx(), c.artifact, released));
    // The payload that leaves is the one the human saw.
    const sent = step.outgoing.find((o) => o.payload.type === 'a2a/artifact-update');
    if (sent && stable((sent.payload as { update: { artifact: unknown } }).update.artifact) !== stable({ ...c.artifact, extensions: artifactExtensions(t.capability, c.artifact.parts), append: undefined, lastChunk: undefined }))
      throw new CliError(`internal: the artifact for task ${taskId} is not the draft that was shown. Nothing was sent.`);
    steps.push(step);
    if (c.complete && step.outgoing.length && !isFinished(step.state.tasks[taskId]?.state ?? 'completed')) {
      steps.push(engine(() => finishTask(step.state, taskId, ctx(), 'completed')));
    }
  } else if (c.kind === 'question') {
    steps.push(engine(() => askInput(l.engine, taskId, ctx(), { text: c.text, data: c.data }, released)));
  } else {
    steps.push(engine(() => finishTask(l.engine, taskId, ctx(), c.outcome, { text: c.text, data: c.data }, released)));
  }
  for (const st of steps) applyEffects(l, st, now, by, audits);
  l.engine = steps[steps.length - 1].state;
  delete l.releases[taskId];
  const left = steps[0].events.some((e) => e.kind === 'artifact' || e.kind === 'input-required' || ((e.kind === 'completed' || e.kind === 'failed') && e.code !== 'scope'));
  if (left) {
    // What left: a hash and size of each payload (ours), never its text.
    const sent = steps.flatMap((st) => st.outgoing.filter((o) => o.to === t.peer).map((o) => ({ sha256: sha256(stable(o.payload)), bytes: Buffer.byteLength(stable(o.payload)) })));
    audits.push({ ...audit(now, { peer: t.peer, capability: t.capability, id: taskId, approval: t.approval, group }, 'release', by, digest), sent });
  }
  return commit(home, agent, s, steps, audits, group);
}

/** Throw away a draft (the human said no, or the model wants to redo it). Reduce-only. */
export function discardDraft(home: Home, taskId: string, group?: string): boolean {
  const s = home.readTasks();
  const releases = group === undefined ? s.releases : groupHost(s, group)?.releases;
  if (!releases || !Object.hasOwn(releases, taskId)) return false;
  delete releases[taskId];
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
  opts: { text?: string[]; input?: unknown; expires?: string; files?: TaskPart[] },
): Promise<TaskRun & { taskId: string }> {
  const contact = agent.book.contact(peer);
  if (!contact) throw new CliError(`no active contact ${peer}`);
  if (opts.files?.length) needsFilesExtension(agent, peer);
  const s = home.readTasks();
  const step = engine(() =>
    requestTask(s.engine, peer, capability, taskCtx(registry, contact, 'outbound'), {
      ...(opts.text?.length ? { text: opts.text } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
      ...(opts.files?.length ? { files: opts.files.filter((p) => p.kind === 'file') } : {}),
      peerCapabilities: contact.card?.capabilities ?? [],
    }),
  );
  s.engine = step.state;
  return { ...(await commit(home, agent, s, [step], [])), taskId: step.taskId };
}

/**
 * A request that carries the owner's files (issue #53): checked as it would be
 * sent (contact, card, capability, limits, files extension), then held for the
 * release gate, like a draft for a peer's task. Nothing is sent. The human
 * releases exactly what they were shown (`rdv task release <hold-id> --code`,
 * or rdv_task "approve-release" with a form or a confirm phrase).
 */
export async function holdRequest(
  home: Home,
  agent: Agent,
  registry: CapabilityRegistry,
  peer: string,
  capability: string,
  opts: { text?: string[]; input?: unknown; expires?: string; files: TaskPart[]; notes: FileNote[] },
): Promise<{ held: HeldRequest; digest: string }> {
  const contact = agent.book.contact(peer);
  if (!contact) throw new CliError(`no active contact ${peer}`);
  needsFilesExtension(agent, peer);
  const s = home.readTasks();
  const now = new Date();
  const held: HeldRequest = {
    id: randomUUID(),
    peer,
    capability,
    ...(opts.text?.length ? { text: opts.text } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.expires !== undefined ? { expires: opts.expires } : {}),
    files: opts.files.filter((p): p is FilePart => p.kind === 'file'),
    notes: opts.notes,
    created: now.toISOString(),
  };
  // Refused now, not at release, if it could not be sent as it stands (a dry run on a copy; nothing is kept of it).
  engine(() => requestTask(structuredClone(s.engine), peer, capability, taskCtx(registry, contact, 'outbound', now), requestOptions(held, contact)));
  s.requests = { ...(s.requests ?? {}), [held.id]: held };
  pruneReleases(s, now);
  if (!s.requests || !Object.hasOwn(s.requests, held.id)) throw new CliError('that request could not be held (its deadline has passed)');
  home.writeTasks(s);
  return { held, digest: heldRequestDigest(held) };
}

const requestOptions = (h: HeldRequest, contact: Contact) => ({
  ...(h.text?.length ? { text: h.text } : {}),
  ...(h.input !== undefined ? { input: h.input } : {}),
  ...(h.expires !== undefined ? { expires: h.expires } : {}),
  files: h.files,
  peerCapabilities: contact.card?.capabilities ?? [],
});

/** A held request, as it is now, with the digest the human releases. */
export function heldRequestView(home: Home, id: string): { held: HeldRequest; digest: string } {
  const h = heldRequest(home.readTasks(), id);
  if (!h) throw new CliError(`no request ${id} waiting for your release`);
  return { held: h, digest: heldRequestDigest(h) };
}

/** The held request `id` in `s`, if any. */
export function heldRequest(s: TaskHostState, id: string): HeldRequest | undefined {
  const h = s.requests && Object.hasOwn(s.requests, id) ? s.requests[id] : undefined;
  return h && h.id === id ? h : undefined;
}

/**
 * The release gate passed for a held request (the human approved exactly
 * `digest`): send it. Refused with TaskChangedError, nothing sent, if the
 * request changed since it was shown, or if any of its files changed on disk
 * (or is no longer prepared). Audited like a release, with the new task's ID.
 */
export async function approveHeldRequest(home: Home, agent: Agent, registry: CapabilityRegistry, id: string, digest: string): Promise<TaskRun & { taskId: string }> {
  const s = home.readTasks();
  const h = heldRequest(s, id);
  if (!h || heldRequestDigest(h) !== digest) throw new TaskChangedError(`request ${id} changed since it was reviewed (or it is gone). Nothing was sent.`);
  const changed = changedAttachment(home, h.notes);
  if (changed) {
    throw new TaskChangedError(`${changed.source} changed since you reviewed it (or can no longer be read). Nothing was sent: discard it (rdv task cancel ${id}) and request again.`);
  }
  const contact = agent.book.contact(h.peer);
  if (!contact) throw new CliError(`no active contact ${h.peer}`);
  needsFilesExtension(agent, h.peer);
  const now = new Date();
  const step = engine(() => requestTask(s.engine, h.peer, h.capability, taskCtx(registry, contact, 'outbound', now), requestOptions(h, contact)));
  s.engine = step.state;
  delete s.requests![id];
  const sent = step.outgoing.filter((o) => o.to === h.peer).map((o) => ({ sha256: sha256(stable(o.payload)), bytes: Buffer.byteLength(stable(o.payload)) }));
  const audits: AuditEntry[] = [{ ...audit(now, { peer: h.peer, capability: h.capability, id: step.taskId }, 'release', 'human', digest), sent }];
  return { ...(await commit(home, agent, s, [step], audits)), taskId: step.taskId };
}

/** Throw away a held request (the human said no). Reduce-only. */
export function discardHeldRequest(home: Home, id: string): boolean {
  const s = home.readTasks();
  if (!heldRequest(s, id)) return false;
  delete s.requests![id];
  if (Object.keys(s.requests!).length === 0) delete s.requests;
  home.writeTasks(s);
  return true;
}

/** File parts go only to a peer whose card lists the files extension (SPEC §7.7: one that does not answers unsupported). */
function needsFilesExtension(agent: Agent, peer: string): void {
  const caps = agent.book.contact(peer)?.card?.capabilities;
  if (!Array.isArray(caps) || !caps.includes(FILES_URI)) throw new CliError(`the peer's card does not list ${FILES_URI}, so it cannot take files; nothing was sent`);
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
    // What the files are, never their keys: the event log is read by every host on the home.
    files: fileSummaries(e.files),
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
  for (const f of fileSummaries(e.files) ?? []) lines.push(`  peer file (untrusted, not fetched): ${safe(describeFile(f))}`);
  if (e.kind === 'start-needed') lines.push(`  waiting for YOUR approval: rdv task list, then rdv task approve ${safe(e.taskId)} --code <code> (or rdv task decline ${safe(e.taskId)})`);
  return lines.join('\n');
}

/** A draft in words: exactly what would leave. */
export function describeDraft(c: ReleaseContent): string {
  if (c.kind === 'artifact') {
    // A file shows its name, size, full hash, encryption, URL and the local file it was read from.
    const file = (p: TaskPart & { kind: 'file' }) => {
      const sum = fileSummary(p, 0);
      const note = c.files?.find((n) => n.sha256 === sum.sha256);
      return `file: ${note ? describeNote(note) : describeFile({ ...sum, index: undefined })}`;
    };
    const parts = c.artifact.parts.map((p) => (p.kind === 'text' ? `text: ${JSON.stringify(p.text)}` : p.kind === 'data' ? `data: ${JSON.stringify(p.data)}` : file(p)));
    return `result${c.artifact.name ? ` ${JSON.stringify(c.artifact.name)}` : ''}: ${parts.join('; ')}${c.complete ? ' (then the task ends completed)' : ''}`;
  }
  const body = [...(c.text !== undefined ? [`text: ${JSON.stringify(c.text)}`] : []), ...(c.data !== undefined ? [`data: ${JSON.stringify(c.data)}`] : [])].join('; ');
  return c.kind === 'question' ? `question for the requester: ${body}` : `end the task ${c.outcome}: ${body}`;
}

/** One task for `rdv task list` (JSON), with the codes `approve` and `release` take. With `g`, a task in that group's lane. */
export function taskListView(t: TaskRecord, s: TaskHostState, g?: GroupView) {
  const releases = g ? (groupHost(s, g.group)?.releases ?? {}) : s.releases;
  const start = startDigest(t, g && t.gate ? groupStartShown(g, t) : undefined);
  const r = Object.hasOwn(releases, t.id) ? releases[t.id] : undefined;
  const rel = releaseDigest(t, r, g && r ? groupReleaseShown(g, t) : undefined);
  const { seen: _seen, files, ...rest } = t;
  const got = s.received && Object.hasOwn(s.received, t.id) ? s.received[t.id].files : undefined;
  // Files as summaries and drafts with their file keys redacted: never a key in a listing.
  const draft = r && r.content.kind === 'artifact' ? { ...r.content, artifact: { ...r.content.artifact, parts: r.content.artifact.parts.map((p) => (p.kind === 'file' ? redactFilePart(p) : p)) } } : r?.content;
  return {
    event: 'task',
    ...rest,
    // In a group: who asks and what it refers to on the board (start), who it goes to (release), as the gates show them.
    ...(g ? { group: g.group, in_group: { ...groupStartShown(g, t), ...(r ? { release_to: groupReleaseShown(g, t).to } : {}) } } : {}),
    ...(files?.length ? { files: fileSummaries(files) } : {}),
    ...(got?.length ? { received_files: fileSummaries(got) } : {}),
    fingerprint: fingerprint(t.peer),
    ...(start ? { start_code: gateCode(start) } : {}),
    ...(rel && r ? { draft, release_code: gateCode(rel) } : {}),
  };
}

export function taskListText(t: TaskRecord, s: TaskHostState, g?: GroupView): string {
  const v = taskListView(t, s, g);
  const releases = g ? (groupHost(s, g.group)?.releases ?? {}) : s.releases;
  const flag = g ? ` --group ${safe(g.group)}` : '';
  const lines = [`${safe(t.id)}  ${t.role} with ${safe(t.peer)} (${safe(v.fingerprint)})  ${safe(t.capability || '-')}  ${safe(t.state)}${t.approval ? `  class ${safe(t.approval)}` : ''}`];
  if (g) lines.push(...describeGroupStart(g, t).map((l) => `  ${l}`));
  for (const x of t.text ?? []) lines.push(`  request (untrusted, written by the peer): ${safe(JSON.stringify(x))}`);
  if (t.input !== undefined) lines.push(`  input (untrusted): ${safe(JSON.stringify(t.input))}`);
  if (t.answer !== undefined) lines.push(`  answer (untrusted): ${safe(JSON.stringify(t.answer))}`);
  for (const f of fileSummaries(t.files) ?? []) lines.push(`  file (untrusted, fetched only after you approve the start): ${safe(describeFile(f))}`);
  const got = s.received && Object.hasOwn(s.received, t.id) ? s.received[t.id].files : undefined;
  for (const f of fileSummaries(got) ?? []) lines.push(`  result file (untrusted, not fetched; rdv file fetch ${safe(t.id)} --file ${f.index}): ${safe(describeFile(f))}`);
  if (t.reason) lines.push(`  reason: ${safe(JSON.stringify(t.reason))}${t.code ? ` (${safe(t.code)})` : ''}`);
  if (v.start_code) lines.push(`  waiting for YOUR approval to start: rdv task approve ${safe(t.id)}${flag} --code ${v.start_code}  (or rdv task decline ${safe(t.id)}${flag})`);
  if (v.release_code && v.draft) {
    lines.push(`  waiting for YOUR release: ${safe(describeDraft(releases[t.id].content))}`);
    if (g) lines.push(`  ${describeGroupRelease(g, t)}`);
    lines.push(`  to send it: rdv task release ${safe(t.id)}${flag} --code ${v.release_code}`);
  }
  return lines.join('\n');
}
