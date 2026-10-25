// Glue between the pure negotiation engine (@rendezvous/a2a) and the CLI:
// build the engine context from a calendar file, a window and the grant,
// then carry out a step (send messages, hold slots) and render its events.
import {
  type Ctx,
  describeSlot,
  JsonFileCalendar,
  type MeetingScope,
  type NegotiationEvent,
  type NegotiationTask,
  parseOffset,
  parseWindow,
  type Step,
  WindowError,
} from '@rendezvous/a2a';
import type { Agent, Contact, Payload } from '@rendezvous/core';
import { writeAtomic } from './fsutil.js';
import { CliError } from './home.js';
import { clean } from './output.js';

export const DEFAULT_LISTEN_WINDOW = 'next week evenings';

export interface NegotiateOptions {
  calendar: string;
  window: string;
  /** Fixed UTC offset like "+02:00"; else the calendar's "timezone"; else this machine's current offset. */
  tz?: string;
  minutes?: number;
}

export function openCalendar(path: string): JsonFileCalendar {
  return new JsonFileCalendar(path, (p, data) => writeAtomic(p, data, 0o600));
}

/**
 * Meeting scope for a contact. `inboundScope` is the grant's scope on both
 * sides: the grantor recorded the grant it issued, and the requester recorded
 * the received grant (plus may_initiate). Per NOTES.md item 15 the same scope
 * covers both directions, so it governs what we send as well as what we accept.
 */
export function meetingScope(contact: Contact | null | undefined): MeetingScope {
  return (contact?.inboundScope ?? {}) as MeetingScope;
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

/** Carry out a step: hold agreed slots, then send messages. Returns send errors (the step is still applied). */
export async function carryOut(agent: Agent, calendarPath: string | undefined, step: Step): Promise<string[]> {
  const errors: string[] = [];
  if (step.effects.length) {
    if (!calendarPath) errors.push('no calendar to hold the agreed slot in');
    else {
      const cal = openCalendar(calendarPath);
      for (const e of step.effects) await cal.hold(e.slot, `Dinner (rdv ${e.taskId})`);
    }
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

export function taskView(t: NegotiationTask) {
  const { seen: _seen, ...rest } = t;
  return { event: 'task', ...rest };
}

export function taskText(t: NegotiationTask): string {
  const agreed = t.agreed ? `  agreed ${safe(describeSlot(t.agreed))}` : '';
  const reason = t.reason ? `  reason (untrusted if from peer) ${safe(JSON.stringify(t.reason))}` : '';
  return `${safe(t.id)}  ${t.role} with ${safe(t.peer)}  ${safe(t.state)}  round ${t.round}${agreed}${reason}`;
}
