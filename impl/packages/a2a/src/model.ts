// PLAN.md §5.1: A2A v0.3 object shapes carried inside the encrypted envelope
// payload. Two payload types:
//   a2a/message      { type, message: Message }               one negotiation turn
//   a2a/task-update  { type, update: TaskStatusUpdateEvent }  acknowledgement of a state change
//
// Everything here arrives from a peer, so `parsePayload` validates strictly:
// known keys only, UUID ids, bounded sizes, RFC 3339 slots with offsets.
//
// Extensions (SPEC §7.5, issue #4): each verb belongs to an A2A extension URI
// (EXTENSIONS). An agent lists the URIs it supports on its card's
// `capabilities` and in each message's `extensions`. What a receiver does with
// what it does not know:
//   critical   an unknown verb, an unknown key anywhere in `data`, a verb whose
//              extension we do not support, an unknown part kind: rejected as
//              *unsupported*. The result carries the message's ids so the
//              engine can tell the sender (UNSUPPORTED_KEY).
//   ignorable  `metadata` on the message, a part or a status update (A2A puts
//              extension data there, keyed by extension URI), and URIs in
//              `message.extensions` that we do not know: accepted, never read
//              (except our own UNSUPPORTED_KEY).
//   malformed  anything else (bad ids, slots or sizes, a missing field, an
//              unknown key in the A2A objects themselves): invalid, silently
//              dropped as before.
import { parseInstant, type Slot } from './time.js';

/** A2A v0.3 `TaskState` values this profile uses. */
export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'rejected';
export const TASK_STATES: readonly TaskState[] = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'rejected'];
const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'canceled', 'rejected']);
export const isTerminal = (s: TaskState) => TERMINAL.has(s);

export interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}
export interface DataPart {
  kind: 'data';
  data: MeetingData;
  metadata?: Record<string, unknown>;
}
export type Part = TextPart | DataPart;

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  taskId: string;
  contextId: string;
  role: 'agent';
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string };
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface MessagePayload {
  type: 'a2a/message';
  message: A2AMessage;
}
export interface TaskUpdatePayload {
  type: 'a2a/task-update';
  update: TaskStatusUpdateEvent;
}
export type A2APayload = MessagePayload | TaskUpdatePayload;

export interface Place {
  name?: string;
  area?: string;
}

export type Verb = 'meeting/propose' | 'meeting/counter' | 'meeting/accept' | 'meeting/confirm' | 'meeting/decline' | 'meeting/cancel' | 'rdv/cancel';
export const VERBS: readonly Verb[] = [
  'meeting/propose',
  'meeting/counter',
  'meeting/accept',
  'meeting/confirm',
  'meeting/decline',
  'meeting/cancel',
  'rdv/cancel',
];

export type ProposeData = { rdv: 'meeting/propose'; slots: Slot[]; place?: Place; expires?: string };
export type CounterData = { rdv: 'meeting/counter'; slots: Slot[]; place?: Place; expires?: string };
export type OfferData = ProposeData | CounterData;
export type AcceptData = { rdv: 'meeting/accept'; slot: Slot; place?: Place };
/** The offerer's answer to an accept: the meeting is final (issue #5). */
export type ConfirmData = { rdv: 'meeting/confirm'; slot: Slot };
export type DeclineData = { rdv: 'meeting/decline'; reason: string };
export type CancelData = { rdv: 'rdv/cancel'; reason?: string };
/** Call off an agreed (completed) meeting: names its slot (issue #20). `rdv/cancel` is for pending tasks only. */
export type MeetingCancelData = { rdv: 'meeting/cancel'; slot: Slot; reason?: string };
export type MeetingData = ProposeData | CounterData | AcceptData | ConfirmData | DeclineData | MeetingCancelData | CancelData;

// --- extensions (SPEC §7.5) -------------------------------------------------

/**
 * A2A extension URIs for the meeting verbs. A URI names one immutable version:
 * a breaking change gets a new URI (A2A v0.3 "Extensions"), and a new verb is
 * a new extension, not a new version of the payload.
 */
export const EXTENSIONS = {
  /** propose, counter, accept, confirm, decline, rdv/cancel, and the unsupported reply. */
  meeting: 'https://rendezvous.nesher.co/ext/meetings/v1',
  /** meeting/cancel: call off an agreed meeting (issue #20). */
  meetingCancel: 'https://rendezvous.nesher.co/ext/meeting-cancel/v1',
} as const;
export type ExtensionUri = (typeof EXTENSIONS)[keyof typeof EXTENSIONS];

/** Every extension this implementation supports (the default everywhere). */
export const SUPPORTED_EXTENSIONS: readonly ExtensionUri[] = [EXTENSIONS.meeting, EXTENSIONS.meetingCancel];

/** The extension each verb belongs to. */
export const VERB_EXTENSION: Readonly<Record<Verb, ExtensionUri>> = {
  'meeting/propose': EXTENSIONS.meeting,
  'meeting/counter': EXTENSIONS.meeting,
  'meeting/accept': EXTENSIONS.meeting,
  'meeting/confirm': EXTENSIONS.meeting,
  'meeting/decline': EXTENSIONS.meeting,
  'rdv/cancel': EXTENSIONS.meeting,
  'meeting/cancel': EXTENSIONS.meetingCancel,
};

/** Status-update metadata key of the "unsupported" reply, whose value is `{ messageId, verb? }`. */
export const UNSUPPORTED_KEY = `${EXTENSIONS.meeting}/unsupported`;

/** The card `capabilities` for an agent that supports `extensions`: core's default plus the URIs. */
export function cardCapabilities(extensions: readonly string[] = SUPPORTED_EXTENSIONS): string[] {
  return ['rdv/v1', 'a2a/0.3', ...extensions];
}

/**
 * Does a peer's card advertise the extension `verb` belongs to? Strict: a card
 * from before §7.5 lists no URIs, so it advertises nothing (it may understand
 * the older verbs, but we cannot know).
 */
export function peerAdvertises(capabilities: unknown, verb: Verb): boolean {
  return Array.isArray(capabilities) && capabilities.includes(VERB_EXTENSION[verb]);
}

export type ParsedPayload =
  | { kind: 'message'; message: A2AMessage; data: MeetingData; text: string[] }
  | { kind: 'update'; update: TaskStatusUpdateEvent; unsupported?: UnsupportedNotice };

/** The peer could not process one of our messages (SPEC §7.5). */
export interface UnsupportedNotice {
  /** The messageId of our message. */
  messageId: string;
  /** The verb it names, if that is a well-formed verb name (still peer-chosen: display only). */
  verb?: string;
}

/** A message we cannot process but can identify: the engine answers it with an unsupported reply. */
export interface UnsupportedMessage {
  messageId: string;
  taskId: string;
  contextId: string;
  /** The verb, if it is a well-formed verb name. */
  verb?: string;
}

export type ParseResult = { ok: true; value: ParsedPayload } | { ok: false; reason: string; unsupported?: UnsupportedMessage };

export interface ParseOptions {
  /** Extensions we support (default SUPPORTED_EXTENSIONS); a verb of any other one is unsupported. */
  extensions?: readonly string[];
}

/** Limits on peer input. */
export const LIMITS = {
  /** Slots in one propose/counter (PLAN §5.2 policy). */
  slots: 3,
  /** Longest acceptable slot. */
  slotMinutes: 12 * 60,
  parts: 8,
  textChars: 2000,
  shortText: 200,
  listItems: 16,
} as const;

export const A2A_TYPES = new Set(['a2a/message', 'a2a/task-update']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

class Invalid extends Error {}
/** Well formed, but needs something we do not support (critical, SPEC §7.5). */
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
/** A verb name we may echo back or show: `<word>/<word>`, short. Anything else is left out. */
const VERB_NAME_RE = /^[a-z][a-z0-9-]{0,30}\/[a-z][a-z0-9-]{0,30}$/;
export const verbName = (v: unknown): string | undefined => (typeof v === 'string' && VERB_NAME_RE.test(v) ? v : undefined);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Known keys only. Inside `data` (`critical`) an unknown key is unsupported rather than malformed (SPEC §7.5). */
function keys(obj: Record<string, unknown>, required: string[], optional: string[], what: string, critical = false): void {
  for (const k of required) if (!(k in obj)) fail(`${what}: missing "${k}"`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) (critical ? unsupported : fail)(`${what}: unknown field "${k.slice(0, 40)}"`);
  }
}
const dataKeys = (obj: Record<string, unknown>, required: string[], optional: string[], what: string) => keys(obj, required, optional, what, true);

function shortString(v: unknown, what: string, max: number = LIMITS.shortText): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) fail(`${what} must be a string of 1–${max} characters`);
  return v as string;
}

function metadata(v: unknown, what: string): void {
  if (v !== undefined && !isObject(v)) fail(`${what}.metadata must be an object`);
}

function stringList(v: unknown, what: string, check: (s: unknown) => boolean): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > LIMITS.listItems || !v.every(check)) fail(`${what} must be a short list`);
}

/** A slot: exactly `{start, end}`, RFC 3339 with offsets, end after start, at most 12 h. */
export function parseSlot(v: unknown, what = 'slot'): Slot {
  if (!isObject(v)) return fail(`${what} must be an object`);
  dataKeys(v, ['start', 'end'], [], what);
  const start = parseInstant(v.start);
  const end = parseInstant(v.end);
  if (start === null || end === null) fail(`${what}: start and end must be RFC 3339 date-times with an offset`);
  if (end! <= start!) fail(`${what}: end must be after start`);
  if (end! - start! > LIMITS.slotMinutes * 60_000) fail(`${what}: longer than ${LIMITS.slotMinutes / 60} hours`);
  return { start: v.start as string, end: v.end as string };
}

function parsePlace(v: unknown): Place {
  if (!isObject(v)) return fail('place must be an object');
  dataKeys(v, [], ['name', 'area'], 'place');
  const place: Place = {};
  if (v.name !== undefined) place.name = shortString(v.name, 'place.name');
  if (v.area !== undefined) place.area = shortString(v.area, 'place.area');
  return place;
}

function parseData(v: unknown, extensions: readonly string[]): MeetingData {
  if (!isObject(v)) return fail('data part must hold an object');
  const verb = v.rdv;
  const shown = JSON.stringify(typeof verb === 'string' ? verb.slice(0, 40) : verb);
  if (typeof verb !== 'string') return fail(`unknown verb ${shown}`);
  if (!VERBS.includes(verb as Verb)) return unsupported(`unknown verb ${shown}`, verbName(verb));
  if (!extensions.includes(VERB_EXTENSION[verb as Verb])) return unsupported(`unsupported verb ${shown} (its extension is not enabled)`, verb);
  try {
    return parseVerb(v, verb as Verb);
  } catch (err) {
    // An unknown field of a verb we know: the reply names the verb.
    if (err instanceof Unsupported && err.verb === undefined) err.verb = verb;
    throw err;
  }
}

function parseVerb(v: Record<string, unknown>, verb: Verb): MeetingData {
  const keys = dataKeys;
  switch (verb) {
    case 'meeting/propose':
    case 'meeting/counter': {
      keys(v, ['rdv', 'slots'], ['place', 'expires'], verb);
      if (!Array.isArray(v.slots) || v.slots.length === 0 || v.slots.length > LIMITS.slots) {
        fail(`${verb}: slots must be a list of 1–${LIMITS.slots} slots`);
      }
      const slots = (v.slots as unknown[]).map((s, i) => parseSlot(s, `slots[${i}]`));
      const seen = new Set<string>();
      for (const s of slots) {
        const key = `${parseInstant(s.start)}/${parseInstant(s.end)}`;
        if (seen.has(key)) fail(`${verb}: the same slot is offered twice`);
        seen.add(key);
      }
      const out = { rdv: verb, slots } as OfferData;
      if (v.place !== undefined) out.place = parsePlace(v.place);
      if (v.expires !== undefined) {
        if (parseInstant(v.expires) === null) fail(`${verb}: expires must be an RFC 3339 date-time with an offset`);
        out.expires = v.expires as string;
      }
      return out;
    }
    case 'meeting/accept': {
      keys(v, ['rdv', 'slot'], ['place'], verb);
      const out: AcceptData = { rdv: 'meeting/accept', slot: parseSlot(v.slot) };
      if (v.place !== undefined) out.place = parsePlace(v.place);
      return out;
    }
    case 'meeting/confirm':
      keys(v, ['rdv', 'slot'], [], verb);
      return { rdv: 'meeting/confirm', slot: parseSlot(v.slot) };
    case 'meeting/decline':
      keys(v, ['rdv', 'reason'], [], verb);
      return { rdv: 'meeting/decline', reason: shortString(v.reason, 'reason') };
    case 'meeting/cancel': {
      keys(v, ['rdv', 'slot'], ['reason'], verb);
      const out: MeetingCancelData = { rdv: 'meeting/cancel', slot: parseSlot(v.slot) };
      if (v.reason !== undefined) out.reason = shortString(v.reason, 'reason');
      return out;
    }
    case 'rdv/cancel': {
      keys(v, ['rdv'], ['reason'], verb);
      const out: CancelData = { rdv: 'rdv/cancel' };
      if (v.reason !== undefined) out.reason = shortString(v.reason, 'reason');
      return out;
    }
  }
}

function parseMessage(v: unknown, extensions: readonly string[]): ParsedPayload {
  if (!isObject(v)) return fail('message must be an object');
  keys(v, ['kind', 'messageId', 'taskId', 'contextId', 'role', 'parts'], ['metadata', 'extensions', 'referenceTaskIds'], 'message');
  if (v.kind !== 'message') fail('message.kind must be "message"');
  if (v.role !== 'agent') fail('message.role must be "agent"');
  for (const k of ['messageId', 'taskId', 'contextId'] as const) if (!isUuid(v[k])) fail(`message.${k} must be a UUID`);
  metadata(v.metadata, 'message');
  stringList(v.extensions, 'message.extensions', (s) => typeof s === 'string' && s.length <= LIMITS.shortText);
  stringList(v.referenceTaskIds, 'message.referenceTaskIds', isUuid);
  if (!Array.isArray(v.parts) || v.parts.length === 0 || v.parts.length > LIMITS.parts) {
    fail(`message.parts must hold 1–${LIMITS.parts} parts`);
  }
  try {
    return parseParts(v, v.parts as unknown[], extensions);
  } catch (err) {
    // The ids are valid by now, so the sender can be told what we could not do.
    if (err instanceof Unsupported) err.head = { messageId: v.messageId as string, taskId: v.taskId as string, contextId: v.contextId as string };
    throw err;
  }
}

function parseParts(v: Record<string, unknown>, parts: unknown[], extensions: readonly string[]): ParsedPayload {
  const text: string[] = [];
  let data: MeetingData | undefined;
  for (const p of parts) {
    if (!isObject(p)) return fail('part must be an object');
    if (p.kind === 'text') {
      keys(p, ['kind', 'text'], ['metadata'], 'text part');
      if (typeof p.text !== 'string' || p.text.length > LIMITS.textChars) fail(`text part must be a string of at most ${LIMITS.textChars} characters`);
      metadata(p.metadata, 'text part');
      text.push(p.text as string);
    } else if (p.kind === 'data') {
      keys(p, ['kind', 'data'], ['metadata'], 'data part');
      metadata(p.metadata, 'data part');
      if (data) fail('more than one data part');
      data = parseData(p.data, extensions);
    } else if (typeof p.kind === 'string') {
      unsupported(`unsupported part kind ${JSON.stringify(p.kind.slice(0, 20))}`);
    } else {
      fail(`unsupported part kind ${JSON.stringify(p.kind)}`);
    }
  }
  if (!data) return fail('no data part with a verb');
  return { kind: 'message', message: v as unknown as A2AMessage, data, text };
}

function parseUpdate(v: unknown): ParsedPayload {
  if (!isObject(v)) return fail('update must be an object');
  keys(v, ['kind', 'taskId', 'contextId', 'status', 'final'], ['metadata'], 'update');
  if (v.kind !== 'status-update') fail('update.kind must be "status-update"');
  if (!isUuid(v.taskId) || !isUuid(v.contextId)) fail('update ids must be UUIDs');
  if (typeof v.final !== 'boolean') fail('update.final must be a boolean');
  metadata(v.metadata, 'update');
  const st = v.status;
  if (!isObject(st)) return fail('update.status must be an object');
  keys(st, ['state'], ['timestamp'], 'update.status');
  if (typeof st.state !== 'string' || !TASK_STATES.includes(st.state as TaskState)) fail('update.status.state is not a task state');
  if (st.timestamp !== undefined && parseInstant(st.timestamp) === null) fail('update.status.timestamp must be RFC 3339');
  const update = v as unknown as TaskStatusUpdateEvent;
  const notice = unsupportedNotice(isObject(v.metadata) && Object.hasOwn(v.metadata, UNSUPPORTED_KEY) ? v.metadata[UNSUPPORTED_KEY] : undefined);
  return notice ? { kind: 'update', update, unsupported: notice } : { kind: 'update', update };
}

/** Our own key in update metadata. Metadata is ignorable, so a malformed notice is ignored, not an error. */
function unsupportedNotice(v: unknown): UnsupportedNotice | undefined {
  if (!isObject(v) || !isUuid(v.messageId)) return undefined;
  const verb = verbName(v.verb);
  return verb ? { messageId: v.messageId, verb } : { messageId: v.messageId };
}

/**
 * Validate a decrypted envelope payload as an A2A message or task update.
 * Never throws. A message that is well formed but needs a verb, field or part
 * we do not support fails with `unsupported` set (SPEC §7.5).
 */
export function parsePayload(input: unknown, opts: ParseOptions = {}): ParseResult {
  const extensions = opts.extensions ?? SUPPORTED_EXTENSIONS;
  try {
    if (!isObject(input)) fail('payload must be an object');
    const p = input as Record<string, unknown>;
    if (p.type === 'a2a/message') {
      keys(p, ['type', 'message'], [], 'a2a/message');
      return { ok: true, value: parseMessage(p.message, extensions) };
    }
    if (p.type === 'a2a/task-update') {
      keys(p, ['type', 'update'], [], 'a2a/task-update');
      return { ok: true, value: parseUpdate(p.update) };
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

export function isA2APayload(p: { type?: unknown }): boolean {
  return typeof p.type === 'string' && A2A_TYPES.has(p.type);
}
