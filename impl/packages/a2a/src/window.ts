// `--window` parsing. Deliberately small and deterministic: explicit ISO
// ranges, plus a fixed table of phrases. `now` and the UTC offset are inputs,
// so tests pin them; nothing reads the system clock or time zone here.
//
// Definitions (local time = the given fixed offset; weeks run Monday–Sunday):
//   evening               19:00–23:00 local
//   tonight               today's evening
//   tomorrow evening      tomorrow's evening
//   this week evenings    every evening from today to this Sunday
//   next week evenings    every evening Monday–Sunday of next week
//   this weekend          Saturday and Sunday evenings of this week
//   next weekend          Saturday and Sunday evenings of next week
//   <start>/<end>[,…]     explicit RFC 3339 ranges with offsets, comma-separated
// Every range is clipped to start no earlier than `now`; ranges that end
// before `now` are dropped.
import { dayStart, DAY, localDay, parseInstant, type Span } from './time.js';

export const EVENING = { startHour: 19, endHour: 23 };

export const WINDOW_PHRASES = [
  'tonight',
  'tomorrow evening',
  'this week evenings',
  'next week evenings',
  'this weekend',
  'next weekend',
] as const;

export interface WindowOptions {
  now: Date;
  /** Local time as minutes east of UTC (fixed; no DST). */
  offsetMinutes: number;
}

export class WindowError extends Error {}

const HOUR = 3_600_000;
const MAX_SPAN = 62 * DAY;

/** Parse a window description into time spans (epoch ms), sorted and clipped to `now`. */
export function parseWindow(text: string, opts: WindowOptions): Span[] {
  const now = opts.now.getTime();
  const off = opts.offsetMinutes;
  const phrase = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const today = localDay(now, off);
  // ISO weekday of today: 1 = Monday … 7 = Sunday (day 0 of the epoch was a Thursday).
  const weekday = ((((today + 3) % 7) + 7) % 7) + 1;
  const evenings = (from: number, to: number): Span[] => {
    const out: Span[] = [];
    for (let d = from; d <= to; d++) {
      out.push({ start: dayStart(d, off) + EVENING.startHour * HOUR, end: dayStart(d, off) + EVENING.endHour * HOUR });
    }
    return out;
  };
  const nextMonday = today + (8 - weekday);
  let spans: Span[];
  switch (phrase) {
    case 'tonight':
      spans = evenings(today, today);
      break;
    case 'tomorrow evening':
      spans = evenings(today + 1, today + 1);
      break;
    case 'this week evenings':
      spans = evenings(today, today + (7 - weekday));
      break;
    case 'next week evenings':
      spans = evenings(nextMonday, nextMonday + 6);
      break;
    case 'this weekend':
      spans = evenings(today + (6 - weekday), today + (7 - weekday));
      break;
    case 'next weekend':
      spans = evenings(nextMonday + 5, nextMonday + 6);
      break;
    default:
      spans = parseIsoRanges(text);
  }
  return spans
    .filter((s) => s.end > now)
    .map((s) => ({ start: Math.max(s.start, now), end: s.end }))
    .sort((a, b) => a.start - b.start);
}

function parseIsoRanges(text: string): Span[] {
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => p.includes('/'))) {
    throw new WindowError(
      `cannot read window "${text}": use one of ${WINDOW_PHRASES.map((p) => `"${p}"`).join(', ')}, ` +
        'or RFC 3339 ranges like "2026-11-05T19:00:00+02:00/2026-11-05T23:00:00+02:00" (comma-separated)',
    );
  }
  return parts.map((p) => {
    const [a, b, ...rest] = p.split('/');
    const start = parseInstant(a?.trim());
    const end = parseInstant(b?.trim());
    if (rest.length || start === null || end === null) {
      throw new WindowError(`not an RFC 3339 range with offsets: "${p}"`);
    }
    if (end <= start) throw new WindowError(`range ends before it starts: "${p}"`);
    if (end - start > MAX_SPAN) throw new WindowError(`range longer than 62 days: "${p}"`);
    return { start, end };
  });
}

/**
 * Candidate meeting slots inside the window: start on whole local hours
 * (`stepMinutes` apart), last `minutes`, fit entirely inside one window span,
 * and start no earlier than `now`.
 */
export function candidateSlots(
  window: Span[],
  opts: { now: number; minutes: number; offsetMinutes: number; stepMinutes?: number },
): Span[] {
  const step = (opts.stepMinutes ?? 60) * 60_000;
  const len = opts.minutes * 60_000;
  const shift = opts.offsetMinutes * 60_000;
  const out: Span[] = [];
  for (const w of window) {
    const from = Math.max(w.start, opts.now);
    // Align to the step in local time (offsets like +05:30 shift the grid).
    let t = Math.ceil((from + shift) / step) * step - shift;
    for (; t + len <= w.end; t += step) out.push({ start: t, end: t + len });
  }
  return out;
}
