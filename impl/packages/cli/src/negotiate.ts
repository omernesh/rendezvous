// Glue between the pure negotiation engine (@rendezvous/a2a) and the CLI:
// build the engine context from a calendar file, a window and the grant,
// then carry out a step (send messages, hold slots) and render its events.
import {
  agreedSnapshot,
  type Ctx,
  describeSlot,
  isTerminal,
  JsonFileCalendar,
  meetingSnapshot,
  type MeetingScope,
  type MeetingSnapshot,
  type NegotiationEvent,
  type NegotiationState,
  type NegotiationTask,
  parseOffset,
  parseWindow,
  type Step,
  WindowError,
} from '@rendezvous/a2a';
import { createHash } from 'node:crypto';
import { type Agent, type Contact, type GrantScope, MEETINGS_CAPABILITY, type Payload, scopeAllows } from '@rendezvous/core';
import { writeAtomic } from './fsutil.js';
import { CliError, type Home } from './home.js';
import { clean } from './output.js';

export const DEFAULT_LISTEN_WINDOW = 'next week evenings';

export interface NegotiateOptions {
  calendar: string;
  window: string;
  /** Fixed UTC offset like "+02:00"; else the calendar's "timezone"; else this machine's current offset. */
  tz?: string;
  minutes?: number;
  /** Accept and confirm meetings without the human (`listen --auto-confirm`: bots, demos, tests). */
  autoConfirm?: boolean;
}

export function openCalendar(path: string): JsonFileCalendar {
  return new JsonFileCalendar(path, (p, data) => writeAtomic(p, data, 0o600));
}

/**
 * Meeting scope for a contact, by direction (NOTES item 15, revised after the
 * security review): `outbound` is what the peer's grant lets us do (proposing
 * to it), `inbound` is what our own human let the peer do (the peer proposing
 * to us). A grant we received never widens `inbound`.
 */
export function meetingScope(contact: Contact | null | undefined, direction: 'outbound' | 'inbound'): MeetingScope {
  const scope = ((direction === 'outbound' ? contact?.outboundScope : contact?.inboundScope) ?? {}) as MeetingScope;
  // Core's reading rule decides (invoke first, then the boolean; the narrower on disagreement), so the engine's agrees.
  return { ...scope, may_propose_meetings: scopeAllows(scope as GrantScope, MEETINGS_CAPABILITY) };
}

/**
 * Scope for an inbound a2a payload: replies on a task we proposed to this
 * peer ride our outbound grant; anything else (a new proposal, or moves on a
 * task the peer started) needs the inbound rights our human gave the peer.
 */
export function inboundMeetingScope(contact: Contact | null | undefined, state: NegotiationState, payload: unknown): MeetingScope {
  const p = payload as { message?: { taskId?: unknown }; update?: { taskId?: unknown } } | null;
  const taskId = p?.message?.taskId ?? p?.update?.taskId;
  const task = typeof taskId === 'string' && Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
  const ours = task !== undefined && task.role === 'proposer' && task.peer === contact?.peer;
  return meetingScope(contact, ours ? 'outbound' : 'inbound');
}

function offsetFor(cal: JsonFileCalendar, tz: string | undefined, now: Date): number {
  if (tz !== undefined) {
    const off = parseOffset(tz);
    if (off === null) throw new CliError(`--tz must be a fixed offset like +02:00 or Z, not "${tz}"`, 2);
    return off;
  }
  return cal.offsetMinutes() ?? -now.getTimezoneOffset();
}

const DAY = 86_400_000;

/** Read the calendar and window into an engine context (the only I/O around the engine). */
export async function buildCtx(opts: NegotiateOptions, scope: MeetingScope, now = new Date()): Promise<Ctx> {
  const cal = openCalendar(opts.calendar);
  const offsetMinutes = offsetFor(cal, opts.tz, now);
  let window;
  try {
    window = parseWindow(opts.window, { now, offsetMinutes });
  } catch (err) {
    if (err instanceof WindowError) throw new CliError(err.message, 2);
    throw err;
  }
  const busyRange = { start: new Date(now.getTime() - DAY).toISOString(), end: new Date(now.getTime() + 180 * DAY).toISOString() };
  return {
    now,
    busy: await cal.freeBusy(busyRange),
    busyRange,
    window,
    offsetMinutes,
    scope,
    minutes: opts.minutes,
    autoConfirm: opts.autoConfirm === true,
  };
}

/** Check the calendar and window once, so `listen --negotiate` fails fast on a typo. */
export async function validateNegotiateOptions(opts: NegotiateOptions): Promise<void> {
  try {
    await buildCtx(opts, {});
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError((err as Error).message, 2);
  }
}

/** Calendar titles of our holds: tentative while the handshake runs, then final. */
export const holdNote = (taskId: string, tentative: boolean) => (tentative ? `Dinner (tentative, rdv ${taskId})` : `Dinner (rdv ${taskId})`);

/**
 * Carry out a step: calendar holds and releases, then send messages. Returns
 * errors (the step is still applied). A hold is released or finalized in the
 * calendar it was placed in (`holds.json`, kept while the meeting stands so
 * an agreed one can be canceled, issue #20), so `dinner confirm` and `dinner
 * cancel` need no --calendar.
 */
export async function carryOut(agent: Agent, home: Home, calendarPath: string | undefined, step: Step): Promise<string[]> {
  const errors: string[] = [];
  if (step.effects.length) {
    const holds = home.readHolds();
    for (const e of step.effects) {
      const path = (Object.hasOwn(holds, e.taskId) ? holds[e.taskId] : undefined) ?? calendarPath;
      if (!path) {
        errors.push(`no calendar to ${e.kind === 'release' ? 'release' : 'hold'} the slot in`);
        continue;
      }
      const cal = openCalendar(path);
      if (e.kind === 'hold' && e.tentative) {
        await cal.hold(e.slot, holdNote(e.taskId, true));
        holds[e.taskId] = path;
      } else if (e.kind === 'hold') {
        await cal.release(e.slot, holdNote(e.taskId, true));
        await cal.hold(e.slot, holdNote(e.taskId, false));
        holds[e.taskId] = path;
      } else {
        await cal.release(e.slot, holdNote(e.taskId, e.tentative));
        delete holds[e.taskId];
      }
    }
    home.writeHolds(holds);
  }
  for (const o of step.outgoing) {
    try {
      await agent.send(o.to, o.payload as unknown as Payload);
    } catch (err) {
      errors.push(`sending to ${o.to} failed: ${(err as Error).message}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------

const safe = (v: unknown) => clean(v);

export function dinnerView(e: NegotiationEvent) {
  return {
    event: 'dinner',
    kind: e.kind,
    task: e.taskId,
    peer: e.peer,
    state: e.state,
    round: e.round,
    slots: e.slots,
    slot: e.slot,
    reason: e.reason,
    peer_text: e.peerText,
  };
}

/** Text form. Peer-supplied fields (text parts, decline reasons) are marked untrusted and cleaned. */
export function dinnerText(e: NegotiationEvent): string | undefined {
  if (e.kind === 'duplicate') return undefined; // relays replay on every restart
  const lines = [`dinner ${safe(e.kind)} ${safe(e.taskId ?? '-')} with ${safe(e.peer)}${e.state ? `  state ${safe(e.state)}` : ''}${e.round ? `  round ${e.round}` : ''}`];
  if (e.slots?.length) lines.push(`  slots: ${e.slots.map((s) => safe(describeSlot(s))).join('; ')}`);
  if (e.slot) lines.push(`  slot: ${safe(describeSlot(e.slot))}`);
  if (e.reason) lines.push(`  reason (untrusted if from peer): ${safe(JSON.stringify(e.reason))}`);
  for (const t of e.peerText ?? []) lines.push(`  peer says (untrusted): ${safe(JSON.stringify(t))}`);
  return lines.join('\n');
}

/**
 * Digest of what the human reviews before confirming a held meeting
 * (MeetingSnapshot). A confirm phrase is bound to it, and so is
 * `rdv dinner confirm --hold`: consent is for this meeting, not for whatever
 * the peer-chosen task ID points at later.
 */
export function meetingDigest(s: MeetingSnapshot): string {
  const fields = [s.taskId, s.peer, s.contextId, s.created, s.stage, s.start, s.end, s.place];
  return createHash('sha256').update(`rdv1/meeting-consent\0${JSON.stringify(fields)}`).digest('hex');
}

/** The short form `rdv dinner list` shows and `rdv dinner confirm --hold` takes (48 bits). */
export const meetingCode = (s: MeetingSnapshot): string => meetingDigest(s).slice(0, 12);

/** The digest of an agreed meeting, which a cancel phrase is bound to (issue #20). */
export function agreedDigest(t: NegotiationTask): string | undefined {
  const s = agreedSnapshot(t);
  return s ? meetingDigest(s) : undefined;
}

/** The hold code of a task waiting for its human, if it is. */
export function holdCode(t: NegotiationTask): string | undefined {
  const s = meetingSnapshot(t);
  return s ? meetingCode(s) : undefined;
}

export function taskView(t: NegotiationTask) {
  const { seen: _seen, ...rest } = t;
  const code = holdCode(t);
  return { event: 'task', ...rest, ...(code ? { hold_code: code } : {}) };
}

/** What a pending task with a held slot waits for, in words. */
export function holdText(t: NegotiationTask): string | undefined {
  if (!t.hold || isTerminal(t.state)) return undefined;
  const slot = safe(describeSlot(t.hold.slot));
  return t.hold.stage === 'peer-confirm'
    ? `held ${slot} (tentative): waiting for the peer to confirm`
    : `held ${slot} (tentative): waiting for YOUR confirmation (rdv dinner confirm ${safe(t.id)} --hold ${holdCode(t) ?? '-'}, or rdv dinner cancel)`;
}

export function taskText(t: NegotiationTask): string {
  const agreed = t.agreed ? `  agreed ${safe(describeSlot(t.agreed))}` : '';
  const held = holdText(t);
  const reason = t.reason ? `  reason (untrusted if from peer) ${safe(JSON.stringify(t.reason))}` : '';
  return `${safe(t.id)}  ${t.role} with ${safe(t.peer)}  ${safe(t.state)}  round ${t.round}${agreed}${held ? `  ${held}` : ''}${reason}`;
}
