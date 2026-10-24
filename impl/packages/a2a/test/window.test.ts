import { describe, expect, it } from 'vitest';
import {
  candidateSlots,
  describeSlot,
  formatInstant,
  parseInstant,
  parseWindow,
  toSlot,
  WindowError,
} from '../src/index.js';

// Sunday 25 Oct 2026, 12:00 at +02:00.
const SUNDAY = new Date('2026-10-25T10:00:00Z');
const TZ = 120;
const slots = (spans: { start: number; end: number }[], off = TZ) => spans.map((s) => toSlot(s, off));

describe('parseInstant', () => {
  it('needs an explicit offset and real calendar fields', () => {
    expect(parseInstant('2026-11-05T19:00:00+02:00')).toBe(Date.parse('2026-11-05T17:00:00Z'));
    expect(parseInstant('2026-11-05T17:00Z')).toBe(Date.parse('2026-11-05T17:00:00Z'));
    expect(parseInstant('2026-11-05T22:30:00.5+05:30')).toBe(Date.parse('2026-11-05T17:00:00.500Z'));
    for (const bad of ['2026-11-05T19:00:00', '2026-02-31T19:00:00Z', '2026-13-01T00:00:00Z', '2026-11-05 19:00Z', '2026-11-05T24:00:00Z', '2026-11-05T19:00:00+15:00', 42, null]) {
      expect(parseInstant(bad)).toBeNull();
    }
    expect(parseInstant('2028-02-29T00:00:00Z')).not.toBeNull();
    expect(parseInstant('2027-02-29T00:00:00Z')).toBeNull();
  });

  it('formats in a fixed offset and describes slots without a locale', () => {
    const ms = Date.parse('2026-11-05T17:00:00Z');
    expect(formatInstant(ms, 120)).toBe('2026-11-05T19:00:00+02:00');
    expect(formatInstant(ms, -330)).toBe('2026-11-05T11:30:00-05:30');
    expect(describeSlot({ start: '2026-11-05T19:00:00+02:00', end: '2026-11-05T21:00:00+02:00' })).toBe('Thu 5 Nov 19:00–21:00 (+02:00)');
  });
});

describe('parseWindow', () => {
  const at = (text: string, now = SUNDAY, off = TZ) => slots(parseWindow(text, { now, offsetMinutes: off }), off);

  it('"next week evenings" is Monday–Sunday of the next ISO week, 19:00–23:00 local', () => {
    const w = at('next week evenings');
    expect(w).toHaveLength(7);
    expect(w[0]).toEqual({ start: '2026-10-26T19:00:00+02:00', end: '2026-10-26T23:00:00+02:00' });
    expect(w[6]).toEqual({ start: '2026-11-01T19:00:00+02:00', end: '2026-11-01T23:00:00+02:00' });
    // From a Wednesday it is still the following Monday.
    const wed = at('Next  Week Evenings', new Date('2026-10-28T08:00:00Z'));
    expect(wed[0].start).toBe('2026-11-02T19:00:00+02:00');
  });

  it('tonight is clipped to now, tomorrow evening is one span', () => {
    expect(at('tonight', new Date('2026-10-25T18:30:00Z'))).toEqual([
      { start: '2026-10-25T20:30:00+02:00', end: '2026-10-25T23:00:00+02:00' },
    ]);
    expect(at('tonight', new Date('2026-10-25T21:30:00Z'))).toEqual([]);
    expect(at('tomorrow evening')).toEqual([{ start: '2026-10-26T19:00:00+02:00', end: '2026-10-26T23:00:00+02:00' }]);
  });

  it('weekends and this week', () => {
    // On a Sunday, Saturday is past: only Sunday evening is left this weekend.
    expect(at('this weekend').map((s) => s.start)).toEqual(['2026-10-25T19:00:00+02:00']);
    expect(at('next weekend').map((s) => s.start)).toEqual(['2026-10-31T19:00:00+02:00', '2026-11-01T19:00:00+02:00']);
    const thu = new Date('2026-10-22T08:00:00Z');
    expect(at('this week evenings', thu).map((s) => s.start.slice(0, 10))).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(at('this weekend', thu).map((s) => s.start.slice(0, 10))).toEqual(['2026-10-24', '2026-10-25']);
  });

  it('the local day follows the offset', () => {
    // 23:30Z Sunday is already Monday at +02:00, so next week starts a week later.
    const lateSunday = new Date('2026-10-25T23:30:00Z');
    expect(at('next week evenings', lateSunday)[0].start).toBe('2026-11-02T19:00:00+02:00');
    expect(at('next week evenings', lateSunday, -300)[0].start).toBe('2026-10-26T19:00:00-05:00');
  });

  it('explicit RFC 3339 ranges, comma-separated', () => {
    const w = at('2026-11-05T19:00:00+02:00/2026-11-05T23:00:00+02:00, 2026-11-06T17:00:00Z/2026-11-06T21:00:00Z');
    expect(w).toEqual([
      { start: '2026-11-05T19:00:00+02:00', end: '2026-11-05T23:00:00+02:00' },
      { start: '2026-11-06T19:00:00+02:00', end: '2026-11-06T23:00:00+02:00' },
    ]);
  });

  it('rejects anything else with a helpful message', () => {
    const p = (t: string) => () => parseWindow(t, { now: SUNDAY, offsetMinutes: TZ });
    expect(p('sometime soon')).toThrow(WindowError);
    expect(p('sometime soon')).toThrow(/next week evenings/);
    expect(p('2026-11-05T19:00:00/2026-11-05T23:00:00')).toThrow(/offsets/);
    expect(p('2026-11-05T23:00:00Z/2026-11-05T19:00:00Z')).toThrow(/ends before/);
    expect(p('2026-11-01T00:00:00Z/2027-01-05T00:00:00Z')).toThrow(/62 days/);
  });
});

describe('candidateSlots', () => {
  it('starts on whole local hours and fits inside the span', () => {
    const w = parseWindow('2026-11-05T19:10:00+05:30/2026-11-05T23:00:00+05:30', { now: SUNDAY, offsetMinutes: 330 });
    const c = slots(candidateSlots(w, { now: SUNDAY.getTime(), minutes: 120, offsetMinutes: 330 }), 330);
    expect(c).toEqual([
      { start: '2026-11-05T20:00:00+05:30', end: '2026-11-05T22:00:00+05:30' },
      { start: '2026-11-05T21:00:00+05:30', end: '2026-11-05T23:00:00+05:30' },
    ]);
  });
});
