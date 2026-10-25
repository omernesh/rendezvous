// SPEC §7.7: `rdv/transfer`, negotiating a direct transfer of a referenced
// file over the pairwise channel. The protocol carries only these messages;
// how the bytes move is the named transfer protocol's business, and they are
// verified against the reference's `sha256` like bytes from a URL
// (`verifyAndDecrypt`). No transport is implemented here.
//
// propose (receiver names the protocols it accepts) → accept (sender picks one)
// → signal* (protocol-specific setup in `data`) → done; abort at any step.
import { randomUUID } from 'node:crypto';
import { canonicalBytes, parseTimestamp } from './encoding.js';
import { isTransferProtocol } from './files.js';

export const TRANSFER_TYPE = 'rdv/transfer';
export const TRANSFER_STEPS = ['propose', 'accept', 'signal', 'done', 'abort'] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];
/** Messages per transfer, both directions together (§7.4). */
export const MAX_TRANSFER_MESSAGES = 16;
/** `data`, as canonical JSON (§7.4). */
export const MAX_TRANSFER_DATA_BYTES = 16 * 1024;
export const MAX_TRANSFER_DATA_DEPTH = 16;
export const MAX_TRANSFER_PROTOCOLS = 8;
export const MAX_TRANSFER_REASON = 200;

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

export interface TransferMessage {
  type: typeof TRANSFER_TYPE;
  /** The referenced file's `sha256`. */
  file: string;
  /** The task the file belongs to (§7.6), when there is one. */
  task?: string;
  /** UUID naming this transfer. */
  transfer: string;
  step: TransferStep;
  /** propose: the protocols the receiver accepts, in its order of preference. */
  protocols?: string[];
  /** accept: the one the sender picked. */
  protocol?: string;
  /** Opaque, protocol-specific (WebRTC: SDP offer/answer, ICE candidates). Required on signal. */
  data?: Record<string, unknown>;
  /** abort: why, display only (peer text). */
  reason?: string;
  expires?: string;
}

export type TransferParse = { ok: true; message: TransferMessage } | { ok: false; reason: string };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}

/** Plain JSON only, at most MAX_TRANSFER_DATA_DEPTH deep (checked iteratively, so hostile nesting cannot overflow the stack). */
function plainJson(root: unknown): boolean {
  const stack: Array<[unknown, number]> = [[root, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
      continue;
    }
    if (depth > MAX_TRANSFER_DATA_DEPTH) return false;
    if (Array.isArray(v)) v.forEach((x) => stack.push([x, depth + 1]));
    else if (isPlainObject(v)) Object.values(v).forEach((x) => stack.push([x, depth + 1]));
    else return false;
  }
  return true;
}

const ALLOWED: Record<TransferStep, readonly string[]> = {
  propose: ['protocols', 'data'],
  accept: ['protocol', 'data'],
  signal: ['data'],
  done: [],
  abort: ['reason'],
};
const COMMON = ['type', 'file', 'task', 'transfer', 'step', 'expires'];

/** Strict validation of an `rdv/transfer` payload: unknown keys, wrong-step fields and oversize `data` are refused. */
export function parseTransfer(x: unknown): TransferParse {
  const no = (reason: string): TransferParse => ({ ok: false, reason });
  if (!isPlainObject(x) || x.type !== TRANSFER_TYPE) return no('not an rdv/transfer');
  const step = x.step;
  if (typeof step !== 'string' || !(TRANSFER_STEPS as readonly string[]).includes(step)) return no('step unknown');
  const s = step as TransferStep;
  if (!Object.keys(x).every((k) => COMMON.includes(k) || ALLOWED[s].includes(k))) return no(`field not allowed on ${s}`);
  if (typeof x.file !== 'string' || !HEX64.test(x.file)) return no('file not a sha256');
  if (typeof x.transfer !== 'string' || !UUID.test(x.transfer)) return no('transfer not a UUID');
  if (x.task !== undefined && (typeof x.task !== 'string' || !TASK_ID.test(x.task))) return no('task malformed');
  if (x.expires !== undefined && parseTimestamp(x.expires) === null) return no('expires malformed');
  const msg: TransferMessage = { type: TRANSFER_TYPE, file: x.file, transfer: x.transfer, step: s };
  if (x.task !== undefined) msg.task = x.task as string;
  if (x.expires !== undefined) msg.expires = x.expires as string;
  if (s === 'propose') {
    const p = x.protocols;
    if (!Array.isArray(p) || p.length === 0 || p.length > MAX_TRANSFER_PROTOCOLS) return no('protocols not a list of 1..8');
    if (!p.every((v) => isTransferProtocol(v)) || new Set(p).size !== p.length) return no('protocols malformed');
    msg.protocols = [...(p as string[])];
  }
  if (s === 'accept') {
    if (!isTransferProtocol(x.protocol)) return no('protocol malformed');
    msg.protocol = x.protocol;
  }
  if (x.data !== undefined || s === 'signal') {
    if (!isPlainObject(x.data) || !plainJson(x.data)) return no('data not a plain JSON object');
    if (canonicalBytes(x.data).length > MAX_TRANSFER_DATA_BYTES) return no('data too large');
    msg.data = x.data;
  }
  if (x.reason !== undefined) {
    if (typeof x.reason !== 'string' || x.reason.length > MAX_TRANSFER_REASON) return no('reason malformed');
    msg.reason = x.reason.replace(CONTROL, '');
  }
  return { ok: true, message: msg };
}

/** Builds and validates an outgoing `rdv/transfer`; throws on a bad one. */
export function transferMessage(fields: Omit<TransferMessage, 'type'>): TransferMessage {
  const r = parseTransfer({ type: TRANSFER_TYPE, ...fields });
  if (!r.ok) throw new Error(`bad rdv/transfer: ${r.reason}`);
  return r.message;
}

export function newTransferId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// State machine: pure, applied by each side to every message of a transfer,
// sent or received, in order.

export interface TransferState {
  transfer: string;
  file: string;
  task?: string;
  phase: 'proposed' | 'accepted' | 'done' | 'aborted';
  /** What propose offered. */
  protocols: string[];
  /** What accept picked. */
  protocol?: string;
  /** Messages applied so far. */
  messages: number;
  reason?: string;
}

export type TransferStepResult =
  | { ok: true; state: TransferState }
  /** Refused. `abort` is the message to send back, when the transfer is known and still open; `state` is then aborted. */
  | { ok: false; reason: string; state?: TransferState; abort?: TransferMessage };

/**
 * Applies one message to a transfer. `supported` lists the protocols this
 * side implements: a propose with none of them, or an accept naming one that
 * was not proposed or is not supported, aborts. Out-of-order steps and the
 * 17th message abort too. A message for an unknown transfer (other than
 * propose) or one already finished is refused without a reply.
 */
export function stepTransfer(state: TransferState | undefined, msg: TransferMessage, supported: readonly string[]): TransferStepResult {
  const parsed = parseTransfer(msg);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const m = parsed.message;
  const abortWith = (s: TransferState, reason: string): TransferStepResult => {
    const abort = transferMessage({ file: s.file, transfer: s.transfer, step: 'abort', reason, ...(s.task ? { task: s.task } : {}) });
    return { ok: false, reason, state: { ...s, phase: 'aborted', messages: s.messages + 1, reason }, abort };
  };
  if (!state) {
    if (m.step !== 'propose') return { ok: false, reason: 'unknown transfer' };
    const fresh: TransferState = { transfer: m.transfer, file: m.file, phase: 'proposed', protocols: m.protocols!, messages: 1 };
    if (m.task) fresh.task = m.task;
    if (!m.protocols!.some((p) => supported.includes(p))) return abortWith(fresh, 'unsupported protocol');
    return { ok: true, state: fresh };
  }
  if (m.transfer !== state.transfer || m.file !== state.file || m.task !== state.task) return { ok: false, reason: 'not this transfer' };
  if (state.phase === 'done' || state.phase === 'aborted') return { ok: false, reason: 'transfer finished' };
  const next: TransferState = { ...state, messages: state.messages + 1 };
  if (next.messages > MAX_TRANSFER_MESSAGES) return abortWith(state, 'too many messages');
  switch (m.step) {
    case 'propose':
      return abortWith(state, 'out of order');
    case 'accept':
      if (state.phase !== 'proposed') return abortWith(state, 'out of order');
      if (!state.protocols.includes(m.protocol!) || !supported.includes(m.protocol!)) return abortWith(state, 'unsupported protocol');
      return { ok: true, state: { ...next, phase: 'accepted', protocol: m.protocol } };
    case 'signal':
    case 'done':
      if (state.phase !== 'accepted') return abortWith(state, 'out of order');
      return { ok: true, state: m.step === 'done' ? { ...next, phase: 'done' } : next };
    case 'abort':
      return { ok: true, state: { ...next, phase: 'aborted', ...(m.reason ? { reason: m.reason } : {}) } };
  }
}
