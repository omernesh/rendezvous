// Calendar adapter (PLAN §5.2). The engine only ever sees busy *intervals*:
// `freeBusy` strips titles, so `may_access_calendar: free_busy` holds by
// construction. Google Calendar comes later through MCP on the Claude side;
// the bots use a JSON file.
//
// JSON calendar file:
//   {
//     "timezone": "+02:00",                                  // optional fixed offset for --window phrases
//     "busy": [ { "start": "2026-11-05T19:00:00+02:00",
//                 "end":   "2026-11-05T21:00:00+02:00",
//                 "title": "Dentist" } ]                     // title optional, never leaves this file
//   }
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { overlaps, parseInstant, parseOffset, type Slot, toSpan } from './time.js';

export interface CalendarAdapter {
  /** Busy intervals overlapping `range` (no titles, no details). */
  freeBusy(range: Slot): Promise<Slot[]>;
  /** Block `slot` (idempotent: holding the same slot twice keeps one entry). */
  hold(slot: Slot, note?: string): Promise<void>;
}

export interface CalendarEntry extends Slot {
  title?: string;
}

export interface CalendarFile {
  timezone?: string;
  busy: CalendarEntry[];
}

export class CalendarError extends Error {}

export function validateCalendar(input: unknown, where = 'calendar'): CalendarFile {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CalendarError(`${where}: not a JSON object`);
  const c = input as Record<string, unknown>;
  if (c.timezone !== undefined && (typeof c.timezone !== 'string' || parseOffset(c.timezone) === null)) {
    throw new CalendarError(`${where}: timezone must be a fixed offset like "+02:00"`);
  }
  const busy = c.busy ?? [];
  if (!Array.isArray(busy)) throw new CalendarError(`${where}: busy must be a list`);
  busy.forEach((e, i) => {
    const entry = e as Record<string, unknown>;
    const s = parseInstant(entry?.start);
    const en = parseInstant(entry?.end);
    if (s === null || en === null || en <= s) {
      throw new CalendarError(`${where}: busy[${i}] needs RFC 3339 start/end with offsets, end after start`);
    }
    if (entry.title !== undefined && typeof entry.title !== 'string') throw new CalendarError(`${where}: busy[${i}].title must be a string`);
  });
  return { ...(c as object), busy: busy as CalendarEntry[] } as CalendarFile;
}

function busyIn(entries: CalendarEntry[], range: Slot): Slot[] {
  const r = toSpan(range);
  return entries.filter((e) => overlaps(toSpan(e), r)).map((e) => ({ start: e.start, end: e.end }));
}

function addHold(entries: CalendarEntry[], slot: Slot, note?: string): boolean {
  const s = toSpan(slot);
  if (entries.some((e) => {
    const x = toSpan(e);
    return x.start === s.start && x.end === s.end;
  })) return false;
  entries.push({ start: slot.start, end: slot.end, ...(note ? { title: note } : {}) });
  return true;
}

/** In-memory calendar for tests. */
export class MemoryCalendar implements CalendarAdapter {
  readonly entries: CalendarEntry[];
  constructor(entries: CalendarEntry[] = []) {
    this.entries = entries.map((e) => ({ ...e }));
  }
  async freeBusy(range: Slot): Promise<Slot[]> {
    return busyIn(this.entries, range);
  }
  async hold(slot: Slot, note?: string): Promise<void> {
    addHold(this.entries, slot, note);
  }
}

/** A calendar kept in a JSON file. Reads the file on every call; writes temp-then-rename. */
export class JsonFileCalendar implements CalendarAdapter {
  /** `write` replaces the built-in temp-then-rename (the CLI passes its retrying writeAtomic). */
  constructor(
    readonly path: string,
    private readonly write: (path: string, data: string) => void = writeAtomicSimple,
  ) {}

  read(): CalendarFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new CalendarError(`cannot read calendar ${this.path}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CalendarError(`calendar ${this.path} is not JSON: ${(err as Error).message}`);
    }
    return validateCalendar(parsed, this.path);
  }

  /** The file's `timezone` as minutes east of UTC, if set. */
  offsetMinutes(): number | undefined {
    const tz = this.read().timezone;
    return tz === undefined ? undefined : (parseOffset(tz) ?? undefined);
  }

  async freeBusy(range: Slot): Promise<Slot[]> {
    return busyIn(this.read().busy, range);
  }

  async hold(slot: Slot, note?: string): Promise<void> {
    const cal = this.read();
    if (!addHold(cal.busy, slot, note)) return;
    this.write(this.path, JSON.stringify(cal, null, 2) + '\n');
  }
}

function writeAtomicSimple(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
