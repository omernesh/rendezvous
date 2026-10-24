// Instants, intervals and fixed UTC offsets. Slots on the wire are RFC 3339
// date-times with an explicit offset; inside the engine they are compared as
// epoch milliseconds, so "19:00+02:00" and "17:00Z" are the same slot.

/** A time range on the wire: RFC 3339 strings with an explicit offset (`Z` or `±HH:MM`). */
export interface Slot {
  start: string;
  end: string;
}

/** The same range as epoch milliseconds. */
export interface Span {
  start: number;
  end: number;
}

const MINUTE = 60_000;
export const DAY = 86_400_000;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parse an RFC 3339 date-time that carries an explicit offset. Returns epoch
 * ms, or null for anything else: no offset, out-of-range fields, 31 February.
 * (`Date.parse` alone is too forgiving: it rolls invalid days over.)
 */
export function parseInstant(s: unknown): number | null {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m = RFC3339.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  let offset = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 14 || om > 59) return null;
    offset = (oh * 60 + om) * (m[9] === '-' ? -1 : 1);
  }
  return Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offset * MINUTE;
}

/** `"+02:00"`, `"-05:30"` or `"Z"` → minutes east of UTC; null if malformed. */
export function parseOffset(s: string): number | null {
  if (s === 'Z' || s === 'z') return 0;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const oh = Number(m[2]);
  const om = Number(m[3]);
  if (oh > 14 || om > 59) return null;
  return (oh * 60 + om) * (m[1] === '-' ? -1 : 1);
}

/** The offset written in an RFC 3339 string (minutes east of UTC), or 0. */
export function offsetOf(s: string): number {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(s);
  return (m && parseOffset(m[1])) || 0;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch ms → `YYYY-MM-DDTHH:MM:SS±HH:MM` in the given fixed offset. */
export function formatInstant(ms: number, offsetMinutes: number): string {
  const d = new Date(ms + offsetMinutes * MINUTE);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${formatOffset(offsetMinutes)}`
  );
}

export function toSlot(span: Span, offsetMinutes: number): Slot {
  return { start: formatInstant(span.start, offsetMinutes), end: formatInstant(span.end, offsetMinutes) };
}

/** Only call on slots that already passed validation. */
export function toSpan(slot: Slot): Span {
  const start = parseInstant(slot.start);
  const end = parseInstant(slot.end);
  if (start === null || end === null) throw new Error(`invalid slot ${JSON.stringify(slot)}`);
  return { start, end };
}

export const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
export const sameSpan = (a: Span, b: Span) => a.start === b.start && a.end === b.end;
export const within = (inner: Span, outer: Span) => outer.start <= inner.start && inner.end <= outer.end;

/** Local calendar day number (days since epoch) of an instant in a fixed offset. */
export const localDay = (ms: number, offsetMinutes: number) => Math.floor((ms + offsetMinutes * MINUTE) / DAY);

/** Epoch ms of local midnight for a local day number. */
export const dayStart = (day: number, offsetMinutes: number) => day * DAY - offsetMinutes * MINUTE;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 5 Nov 19:00–21:00 (+02:00)", in the slot's own offset. Deterministic (no locale). */
export function describeSlot(slot: Slot): string {
  const off = offsetOf(slot.start);
  const { start, end } = toSpan(slot);
  const s = new Date(start + off * MINUTE);
  const e = new Date(end + off * MINUTE);
  const hm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const sameDay = s.getUTCDate() === e.getUTCDate() && end - start < DAY;
  const day = (d: Date) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${day(s)} ${hm(s)}–${sameDay ? '' : `${day(e)} `}${hm(e)} (${formatOffset(off)})`;
}
