// SPEC §7.6.1: the payloads of the tasks extension (`…/ext/tasks/v1`).
//   a2a/message          the requester's turns: task/request, task/input, rdv/cancel
//   a2a/task-update      the executor's state changes; `status.message` may carry text and data parts
//   a2a/artifact-update  the executor's results (A2A TaskArtifactUpdateEvent)
//
// Everything here is peer input, validated strictly in the style of model.ts
// (SPEC §7.5): an unknown verb, an unknown key in the verb's `data` or an
// unknown part kind in a message is *unsupported* (answered, the message's ids
// are known); `metadata` and unknown `extensions` URIs are ignorable; anything
// else is malformed and dropped silently. What the capability defines (the
// shape of `input` and of result `data` parts) is checked by the engine, which
// knows the task's capability (capabilities.ts).
//
// File parts are bounded but opaque here (inline bytes up to 16 KiB, a URI, or
// a reference offered only by direct transfer), and never fetched. The files
// extension's rules (SPEC §7.7: hash, size, encryption, URL checks) are core's
// (`parseFilePart`), applied by the host before a payload reaches the engine.
import { isCapabilityUri, MAX_URI_CHARS } from './capabilities.js';
import { EXTENSIONS, isUuid, UNSUPPORTED_KEY, type UnsupportedMessage, type UnsupportedNotice, verbName } from './model.js';
import { parseInstant } from './time.js';

/** The files extension (SPEC §7.7): its metadata key on a file part, and listed in `extensions` with file parts. */
export const FILES_URI = 'https://rendezvous.nesher.co/ext/files/v1';
/** The tasks lifecycle extension (SPEC §7.6). */
export const TASKS_URI = 'https://rendezvous.nesher.co/ext/tasks/v1';
/** Status-update metadata: `"human"` while a gate waits for the executor's human (ignorable). */
export const AWAITING_KEY = `${TASKS_URI}/awaiting`;
/** Status-update metadata: why a task was refused or ended (a REASON_CODES entry; ignorable). */
export const REASON_KEY = `${TASKS_URI}/reason`;

/**
 * Machine reasons for `rejected` / `failed` / `canceled`, in REASON_KEY:
 *   scope        the grant does not let this peer invoke the capability
 *   rate         a per-peer or per-capability limit (max_open, open tasks)
 *   input        `input` does not match the capability's schema
 *   busy         too many tasks wait for the human; this one was dropped
 *   human        the executor's human said no
 *   expired      `expires` passed
 *   unsupported  the capability (or verb) is not implemented
 *   error        the executor started and could not finish
 */
export const REASON_CODES = ['scope', 'rate', 'input', 'busy', 'human', 'expired', 'unsupported', 'error'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** A2A v0.3 task states used by tasks/v1. `failed` is new relative to meetings. */
export type TaskLifecycleState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'rejected' | 'canceled';
export const TASK_LIFECYCLE_STATES: readonly TaskLifecycleState[] = ['submitted', 'working', 'input-required', 'completed', 'failed', 'rejected', 'canceled'];
const FINISHED: ReadonlySet<TaskLifecycleState> = new Set(['completed', 'failed', 'rejected', 'canceled']);
export const isFinished = (s: TaskLifecycleState): boolean => FINISHED.has(s);

/** Bounds on peer input (SPEC §7.4, A.7). */
export const TASK_LIMITS = {
  /** Parts in a message, a status message or an artifact. */
  parts: 8,
  /** Characters in one text part. */
  textChars: 16_000,
  /** Reasons, names, MIME types. */
  shortText: 200,
  /** An artifact's description. */
  description: 2000,
  /** Inline file bytes (decoded). */
  inlineFileBytes: 16 * 1024,
  /** A file URI. */
  uriChars: 2048,
  /** Entries in `extensions` and `referenceTaskIds`. */
  listItems: 16,
} as const;

/** base64 characters for TASK_LIMITS.inlineFileBytes. */
const INLINE_B64_CHARS = Math.ceil(TASK_LIMITS.inlineFileBytes / 3) * 4;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export type TaskVerb = 'task/request' | 'task/input' | 'rdv/cancel';
export const TASK_VERBS: readonly TaskVerb[] = ['task/request', 'task/input', 'rdv/cancel'];

export type TaskRequestData = { rdv: 'task/request'; capability: string; input?: unknown; expires?: string };
export type TaskInputData = { rdv: 'task/input'; input?: unknown };
export type TaskCancelData = { rdv: 'rdv/cancel'; reason?: string };
export type TaskVerbData = TaskRequestData | TaskInputData | TaskCancelData;

export interface TaskTextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}
export interface TaskDataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
/** A2A FilePart. Opaque in this slice: carried and shown, never fetched (SPEC §7.7 adds the rules). */
export interface FilePart {
  kind: 'file';
  file: { name?: string; mimeType?: string; bytes?: string; uri?: string };
  metadata?: Record<string, unknown>;
}
export type TaskPart = TaskTextPart | TaskDataPart | FilePart;

export interface TaskMessage {
  kind: 'message';
  messageId: string;
  taskId: string;
  contextId: string;
  role: 'agent';
  parts: TaskPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** The A2A message inside a status update: text and data parts only. */
export interface StatusMessage {
  kind: 'message';
  messageId: string;
  taskId?: string;
  contextId?: string;
  role: 'agent';
  parts: (TaskTextPart | TaskDataPart)[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface TaskStatusUpdate {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: { state: TaskLifecycleState; timestamp?: string; message?: StatusMessage };
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: TaskPart[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface ArtifactUpdate {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export type TaskPayload =
  | { type: 'a2a/message'; message: TaskMessage }
  | { type: 'a2a/task-update'; update: TaskStatusUpdate }
  | { type: 'a2a/artifact-update'; update: ArtifactUpdate };

export type ParsedTaskPayload =
  | { kind: 'message'; message: TaskMessage; data: TaskVerbData; text: string[]; files: FilePart[] }
  | {
      kind: 'update';
      update: TaskStatusUpdate;
      /** The peer could not process one of our messages (SPEC §7.5). */
      unsupported?: UnsupportedNotice & { capability?: string };
      /** REASON_KEY, when it is a known code. */
      reason?: ReasonCode;
      /** AWAITING_KEY was `"human"`. */
      awaitingHuman?: boolean;
    }
  | { kind: 'artifact'; update: ArtifactUpdate };

export type TaskParseResult = { ok: true; value: ParsedTaskPayload } | { ok: false; reason: string; unsupported?: UnsupportedMessage };

export const TASK_PAYLOAD_TYPES: ReadonlySet<string> = new Set(['a2a/message', 'a2a/task-update', 'a2a/artifact-update']);

// --- validation helpers (the same three classes as model.ts) -------------

class Invalid extends Error {}
class Unsupported extends Invalid {
  head?: Omit<UnsupportedMessage, 'verb'>;
  constructor(
    reason: string,
    public verb?: string,
  ) {
    super(reason);
  }
}
const fail = (reason: string): never => {
  throw new Invalid(reason);
};
const unsupported = (reason: string, verb?: string): never => {
  throw new Unsupported(reason, verb);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function keys(obj: Record<string, unknown>, required: string[], optional: string[], what: string, critical = false): void {
  for (const k of required) if (!Object.hasOwn(obj, k)) fail(`${what}: missing "${k}"`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) (critical ? unsupported : fail)(`${what}: unknown field "${k.slice(0, 40)}"`);
  }
}

function shortString(v: unknown, what: string, max: number = TASK_LIMITS.shortText): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) fail(`${what} must be a string of 1–${max} characters`);
  return v as string;
}

function metadata(v: unknown, what: string): void {
  if (v !== undefined && !isObject(v)) fail(`${what}.metadata must be an object`);
}

function stringList(v: unknown, what: string, check: (s: unknown) => boolean): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > TASK_LIMITS.listItems || !v.every(check)) fail(`${what} must be a short list`);
}

const extensionList = (v: unknown, what: string) => stringList(v, what, (s) => typeof s === 'string' && s.length <= MAX_URI_CHARS);

function instant(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > 64 || parseInstant(v) === null) fail(`${what} must be an RFC 3339 date-time with an offset`);
  return v as string;
}

function textPart(p: Record<string, unknown>, what: string): TaskTextPart {
  keys(p, ['kind', 'text'], ['metadata'], what);
  if (typeof p.text !== 'string' || p.text.length > TASK_LIMITS.textChars) fail(`${what} must be a string of at most ${TASK_LIMITS.textChars} characters`);
  metadata(p.metadata, what);
  return p as unknown as TaskTextPart;
}

function dataPart(p: Record<string, unknown>, what: string): TaskDataPart {
  keys(p, ['kind', 'data'], ['metadata'], what);
  metadata(p.metadata, what);
  if (!isObject(p.data)) fail(`${what} must hold an object`);
  return p as unknown as TaskDataPart;
}

/**
 * Opaque but bounded: exactly one of inline `bytes` (base64, at most 16 KiB
 * decoded) or `uri`, or neither when the files metadata offers the file by
 * direct transfer only (SPEC §7.7: `uri` omitted, `p2p` present).
 */
function filePart(p: Record<string, unknown>, what: string): FilePart {
  keys(p, ['kind', 'file'], ['metadata'], what);
  metadata(p.metadata, what);
  const f = p.file;
  if (!isObject(f)) return fail(`${what}.file must be an object`);
  keys(f, [], ['name', 'mimeType', 'bytes', 'uri'], `${what}.file`);
  if (f.name !== undefined) shortString(f.name, `${what}.file.name`);
  if (f.mimeType !== undefined) shortString(f.mimeType, `${what}.file.mimeType`);
  const hasBytes = f.bytes !== undefined;
  const hasUri = f.uri !== undefined;
  const md = p.metadata as Record<string, unknown> | undefined;
  const refOnly = !hasBytes && !hasUri && isObject(md) && Object.hasOwn(md, FILES_URI) && isObject(md[FILES_URI]);
  if (hasBytes === hasUri && !refOnly) fail(`${what}.file needs exactly one of bytes or uri`);
  if (hasBytes && (typeof f.bytes !== 'string' || f.bytes.length > INLINE_B64_CHARS || f.bytes.length % 4 !== 0 || !B64_RE.test(f.bytes))) {
    fail(`${what}.file.bytes must be base64 of at most ${TASK_LIMITS.inlineFileBytes} bytes`);
  }
  if (hasUri) shortString(f.uri, `${what}.file.uri`, TASK_LIMITS.uriChars);
  return p as unknown as FilePart;
}

function partList(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > TASK_LIMITS.parts) fail(`${what} must hold 1–${TASK_LIMITS.parts} parts`);
  return v as unknown[];
}

// --- message ----------------------------------------------------------------

function parseVerb(v: unknown): TaskVerbData {
  if (!isObject(v)) return fail('data part must hold an object');
  const verb = v.rdv;
  const shown = JSON.stringify(typeof verb === 'string' ? verb.slice(0, 40) : verb);
  if (typeof verb !== 'string') return fail(`unknown verb ${shown}`);
  if (!TASK_VERBS.includes(verb as TaskVerb)) return unsupported(`unknown verb ${shown}`, verbName(verb));
  const dataKeys = (required: string[], optional: string[]) => {
    try {
      keys(v, required, optional, verb, true);
    } catch (err) {
      if (err instanceof Unsupported) err.verb = verb;
      throw err;
    }
  };
  switch (verb as TaskVerb) {
    case 'task/request': {
      dataKeys(['rdv', 'capability'], ['input', 'expires']);
      const out: TaskRequestData = { rdv: 'task/request', capability: shortString(v.capability, 'task/request.capability', MAX_URI_CHARS) };
      if (v.input !== undefined) out.input = v.input; // checked against the capability by the engine
      if (v.expires !== undefined) out.expires = instant(v.expires, 'task/request.expires');
      return out;
    }
    case 'task/input': {
      dataKeys(['rdv'], ['input']);
      return v.input !== undefined ? { rdv: 'task/input', input: v.input } : { rdv: 'task/input' };
    }
    case 'rdv/cancel': {
      dataKeys(['rdv'], ['reason']);
      return v.reason !== undefined ? { rdv: 'rdv/cancel', reason: shortString(v.reason, 'reason') } : { rdv: 'rdv/cancel' };
    }
  }
}

function parseMessage(v: unknown): ParsedTaskPayload {
  if (!isObject(v)) return fail('message must be an object');
  keys(v, ['kind', 'messageId', 'taskId', 'contextId', 'role', 'parts'], ['metadata', 'extensions', 'referenceTaskIds'], 'message');
  if (v.kind !== 'message') fail('message.kind must be "message"');
  if (v.role !== 'agent') fail('message.role must be "agent"');
  for (const k of ['messageId', 'taskId', 'contextId'] as const) if (!isUuid(v[k])) fail(`message.${k} must be a UUID`);
  metadata(v.metadata, 'message');
  extensionList(v.extensions, 'message.extensions');
  stringList(v.referenceTaskIds, 'message.referenceTaskIds', isUuid);
  const parts = partList(v.parts, 'message.parts');
  try {
    const text: string[] = [];
    const files: FilePart[] = [];
    let data: TaskVerbData | undefined;
    for (const p of parts) {
      if (!isObject(p)) return fail('part must be an object');
      if (p.kind === 'text') text.push(textPart(p, 'text part').text);
      else if (p.kind === 'data') {
        dataPart(p, 'data part');
        if (data) fail('more than one data part');
        data = parseVerb(p.data);
      } else if (p.kind === 'file') files.push(filePart(p, 'file part'));
      else if (typeof p.kind === 'string') unsupported(`unsupported part kind ${JSON.stringify(p.kind.slice(0, 20))}`);
      else fail(`unsupported part kind ${JSON.stringify(p.kind)}`);
    }
    if (!data) return fail('no data part with a verb');
    return { kind: 'message', message: v as unknown as TaskMessage, data, text, files };
  } catch (err) {
    if (err instanceof Unsupported) err.head = { messageId: v.messageId as string, taskId: v.taskId as string, contextId: v.contextId as string };
    throw err;
  }
}

// --- status update ----------------------------------------------------------

function parseStatusMessage(v: unknown): StatusMessage {
  if (!isObject(v)) return fail('status.message must be an object');
  keys(v, ['kind', 'messageId', 'role', 'parts'], ['taskId', 'contextId', 'metadata', 'extensions'], 'status.message');
  if (v.kind !== 'message') fail('status.message.kind must be "message"');
  if (v.role !== 'agent') fail('status.message.role must be "agent"');
  if (!isUuid(v.messageId)) fail('status.message.messageId must be a UUID');
  for (const k of ['taskId', 'contextId'] as const) if (v[k] !== undefined && !isUuid(v[k])) fail(`status.message.${k} must be a UUID`);
  metadata(v.metadata, 'status.message');
  extensionList(v.extensions, 'status.message.extensions');
  for (const p of partList(v.parts, 'status.message.parts')) {
    if (!isObject(p)) fail('part must be an object');
    const part = p as Record<string, unknown>;
    if (part.kind === 'text') textPart(part, 'status text part');
    else if (part.kind === 'data') dataPart(part, 'status data part');
    else fail('status.message parts are text and data only');
  }
  return v as unknown as StatusMessage;
}

function parseUpdate(v: unknown): ParsedTaskPayload {
  if (!isObject(v)) return fail('update must be an object');
  keys(v, ['kind', 'taskId', 'contextId', 'status', 'final'], ['metadata'], 'update');
  if (v.kind !== 'status-update') fail('update.kind must be "status-update"');
  if (!isUuid(v.taskId) || !isUuid(v.contextId)) fail('update ids must be UUIDs');
  if (typeof v.final !== 'boolean') fail('update.final must be a boolean');
  metadata(v.metadata, 'update');
  const st = v.status;
  if (!isObject(st)) return fail('update.status must be an object');
  keys(st, ['state'], ['timestamp', 'message'], 'update.status');
  if (typeof st.state !== 'string' || !TASK_LIFECYCLE_STATES.includes(st.state as TaskLifecycleState)) fail('update.status.state is not a task state');
  if (st.timestamp !== undefined) instant(st.timestamp, 'update.status.timestamp');
  if (st.message !== undefined) parseStatusMessage(st.message);
  if (v.final !== isFinished(st.state as TaskLifecycleState)) fail('update.final does not match the state');
  const out: Extract<ParsedTaskPayload, { kind: 'update' }> = { kind: 'update', update: v as unknown as TaskStatusUpdate };
  // Metadata is ignorable: a malformed entry is left out, never an error.
  const md = isObject(v.metadata) ? v.metadata : {};
  const notice = Object.hasOwn(md, UNSUPPORTED_KEY) ? md[UNSUPPORTED_KEY] : undefined;
  if (isObject(notice) && isUuid(notice.messageId)) {
    const verb = verbName(notice.verb);
    out.unsupported = { messageId: notice.messageId, ...(verb ? { verb } : {}), ...(isCapabilityUri(notice.capability) ? { capability: notice.capability } : {}) };
  }
  const reason = Object.hasOwn(md, REASON_KEY) ? md[REASON_KEY] : undefined;
  if (typeof reason === 'string' && (REASON_CODES as readonly string[]).includes(reason)) out.reason = reason as ReasonCode;
  if (Object.hasOwn(md, AWAITING_KEY) && md[AWAITING_KEY] === 'human') out.awaitingHuman = true;
  return out;
}

// --- artifact update --------------------------------------------------------

function parseArtifactUpdate(v: unknown): ParsedTaskPayload {
  if (!isObject(v)) return fail('update must be an object');
  keys(v, ['kind', 'taskId', 'contextId', 'artifact'], ['append', 'lastChunk', 'metadata'], 'artifact-update');
  if (v.kind !== 'artifact-update') fail('update.kind must be "artifact-update"');
  if (!isUuid(v.taskId) || !isUuid(v.contextId)) fail('update ids must be UUIDs');
  for (const k of ['append', 'lastChunk'] as const) if (v[k] !== undefined && typeof v[k] !== 'boolean') fail(`update.${k} must be a boolean`);
  metadata(v.metadata, 'artifact-update');
  const a = v.artifact;
  if (!isObject(a)) return fail('artifact must be an object');
  keys(a, ['artifactId', 'parts'], ['name', 'description', 'extensions', 'metadata'], 'artifact');
  if (!isUuid(a.artifactId)) fail('artifact.artifactId must be a UUID');
  if (a.name !== undefined) shortString(a.name, 'artifact.name');
  if (a.description !== undefined) shortString(a.description, 'artifact.description', TASK_LIMITS.description);
  extensionList(a.extensions, 'artifact.extensions');
  metadata(a.metadata, 'artifact');
  for (const p of partList(a.parts, 'artifact.parts')) {
    if (!isObject(p)) fail('part must be an object');
    const part = p as Record<string, unknown>;
    if (part.kind === 'text') textPart(part, 'artifact text part');
    else if (part.kind === 'data') dataPart(part, 'artifact data part');
    else if (part.kind === 'file') filePart(part, 'artifact file part');
    else fail('unknown artifact part kind');
  }
  return { kind: 'artifact', update: v as unknown as ArtifactUpdate };
}

/**
 * Validate a decrypted payload as a tasks/v1 message, status update or
 * artifact update. Never throws. A message that is well formed but needs a
 * verb, field or part kind we do not support fails with `unsupported` set.
 */
export function parseTaskPayload(input: unknown): TaskParseResult {
  try {
    if (!isObject(input)) fail('payload must be an object');
    const p = input as Record<string, unknown>;
    if (p.type === 'a2a/message') {
      keys(p, ['type', 'message'], [], 'a2a/message');
      return { ok: true, value: parseMessage(p.message) };
    }
    if (p.type === 'a2a/task-update') {
      keys(p, ['type', 'update'], [], 'a2a/task-update');
      return { ok: true, value: parseUpdate(p.update) };
    }
    if (p.type === 'a2a/artifact-update') {
      keys(p, ['type', 'update'], [], 'a2a/artifact-update');
      return { ok: true, value: parseArtifactUpdate(p.update) };
    }
    return fail('not an a2a payload');
  } catch (err) {
    if (err instanceof Unsupported && err.head) {
      return { ok: false, reason: err.message, unsupported: err.verb ? { ...err.head, verb: err.verb } : { ...err.head } };
    }
    if (err instanceof Invalid) return { ok: false, reason: err.message };
    throw err;
  }
}

// --- routing between the meetings and the tasks engines ---------------------

/** The task IDs one engine holds; both engines' states fit (`tasks` keyed by task ID). */
export interface HoldsTasks {
  tasks: Record<string, unknown>;
}

/**
 * Which engine handles a payload: `tasks` (tasks.ts) or `meetings`
 * (engine.ts), or null for a payload that is not A2A. A quick look only; the
 * engine validates. `rdv/cancel` and status updates belong to both
 * extensions, so they go to whichever engine holds the task (SPEC §7.6.2: the
 * task's capability says which applies). A cancel for a task neither holds
 * (it overtook its request) goes to the tasks engine only when the message
 * lists the tasks URI and not the meetings one; otherwise to meetings, as
 * before this extension.
 */
export function routeA2A(payload: unknown, tasks: HoldsTasks): 'tasks' | 'meetings' | null {
  if (!isObject(payload) || typeof payload.type !== 'string' || !TASK_PAYLOAD_TYPES.has(payload.type)) return null;
  if (payload.type === 'a2a/artifact-update') return 'tasks';
  const body = payload.type === 'a2a/message' ? payload.message : payload.update;
  if (!isObject(body)) return 'meetings';
  const taskId = typeof body.taskId === 'string' ? body.taskId : undefined;
  const ours = taskId !== undefined && Object.hasOwn(tasks.tasks, taskId);
  if (payload.type === 'a2a/task-update') return ours ? 'tasks' : 'meetings';
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const data = parts.find((p): p is { kind: 'data'; data: Record<string, unknown> } => isObject(p) && p.kind === 'data' && isObject(p.data));
  const verb = data?.data.rdv;
  if (typeof verb === 'string' && verb.startsWith('task/')) return 'tasks';
  if (ours) return 'tasks';
  if (verb === 'rdv/cancel' && Array.isArray(body.extensions) && body.extensions.includes(TASKS_URI) && !body.extensions.includes(EXTENSIONS.meeting)) return 'tasks';
  return 'meetings';
}
