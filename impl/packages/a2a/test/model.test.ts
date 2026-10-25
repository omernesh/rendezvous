import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSIONS, JsonFileCalendar, parsePayload, SUPPORTED_EXTENSIONS, UNSUPPORTED_KEY, validateCalendar } from '../src/index.js';

describe('calendar files are strict (security review M2)', () => {
  it('rejects JSON that is not a calendar, and hold never rewrites it', async () => {
    expect(() => validateCalendar({ name: 'pkg', scripts: { a: 'b' } })).toThrow(/not a calendar/);
    expect(() => validateCalendar({})).toThrow(/busy/);
    expect(() => validateCalendar({ busy: [{ start: '2026-11-05T19:00:00+02:00', end: '2026-11-05T21:00:00+02:00', x: 1 }] })).toThrow(/unknown keys/);
    expect(validateCalendar({ timezone: '+02:00', busy: [] })).toEqual({ timezone: '+02:00', busy: [] });
    const dir = mkdtempSync(join(tmpdir(), 'rdv-cal-'));
    try {
      const victim = join(dir, 'package.json');
      const original = JSON.stringify({ name: 'pkg', scripts: { a: 'b' } });
      writeFileSync(victim, original);
      await expect(new JsonFileCalendar(victim).hold({ start: '2026-11-01T19:00:00+02:00', end: '2026-11-01T21:00:00+02:00' }, 'Dinner')).rejects.toThrow();
      expect(readFileSync(victim, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const slot = { start: '2026-11-05T19:00:00+02:00', end: '2026-11-05T21:00:00+02:00' };

function msg(data: unknown, over: Record<string, unknown> = {}, parts?: unknown[]) {
  return {
    type: 'a2a/message',
    message: {
      kind: 'message',
      messageId: U(1),
      taskId: U(2),
      contextId: U(3),
      role: 'agent',
      parts: parts ?? [
        { kind: 'text', text: 'How about Thursday?' },
        { kind: 'data', data },
      ],
      ...over,
    },
  };
}

const reason = (p: unknown) => {
  const r = parsePayload(p);
  return r.ok ? 'ok' : r.reason;
};

describe('parsePayload', () => {
  it('accepts the PLAN §5.1 shape', () => {
    const r = parsePayload(
      msg({ rdv: 'meeting/propose', slots: [slot], place: { name: 'optional', area: 'Tel Aviv' }, expires: '2026-11-01T00:00:00Z' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'message') {
      expect(r.value.data).toEqual({ rdv: 'meeting/propose', slots: [slot], place: { name: 'optional', area: 'Tel Aviv' }, expires: '2026-11-01T00:00:00Z' });
      expect(r.value.text).toEqual(['How about Thursday?']);
    }
    expect(reason(msg({ rdv: 'meeting/accept', slot }))).toBe('ok');
    expect(reason(msg({ rdv: 'meeting/confirm', slot }))).toBe('ok');
    expect(reason(msg({ rdv: 'meeting/decline', reason: 'busy' }))).toBe('ok');
    expect(reason(msg({ rdv: 'rdv/cancel' }))).toBe('ok');
    expect(reason(msg({ rdv: 'meeting/cancel', slot }))).toBe('ok');
    expect(reason(msg({ rdv: 'meeting/cancel', slot, reason: 'sick' }))).toBe('ok');
    expect(reason(msg({ rdv: 'meeting/counter', slots: [slot] }, { metadata: { x: 1 }, referenceTaskIds: [U(9)] }))).toBe('ok');
    expect(
      reason({
        type: 'a2a/task-update',
        update: { kind: 'status-update', taskId: U(2), contextId: U(3), status: { state: 'completed', timestamp: '2026-11-01T00:00:00Z' }, final: true },
      }),
    ).toBe('ok');
  });

  it('rejects unknown verbs and malformed slots', () => {
    expect(reason(msg({ rdv: 'meeting/delete' }))).toMatch(/unknown verb/);
    expect(reason(msg({ slots: [slot] }))).toMatch(/unknown verb/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [] }))).toMatch(/1–3 slots/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [slot, slot, slot, slot] }))).toMatch(/1–3 slots/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [slot, { start: '2026-11-05T17:00:00Z', end: '2026-11-05T19:00:00Z' }] }))).toMatch(/twice/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [{ start: '2026-11-05T19:00:00', end: '2026-11-05T21:00:00' }] }))).toMatch(/offset/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [{ start: slot.end, end: slot.start }] }))).toMatch(/after start/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [{ start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z' }] }))).toMatch(/12 hours/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [{ ...slot, title: 'Dentist' }] }))).toMatch(/unknown field "title"/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [slot], expires: 'tomorrow' }))).toMatch(/expires/);
    expect(reason(msg({ rdv: 'meeting/accept', slots: [slot] }))).toMatch(/missing "slot"/);
    expect(reason(msg({ rdv: 'meeting/confirm', slot, place: { area: 'x' } }))).toMatch(/unknown field "place"/);
    expect(reason(msg({ rdv: 'meeting/decline' }))).toMatch(/missing "reason"/);
    expect(reason(msg({ rdv: 'meeting/cancel' }))).toMatch(/missing "slot"/);
    expect(reason(msg({ rdv: 'meeting/cancel', slot, slots: [slot] }))).toMatch(/unknown field "slots"/);
    expect(reason(msg({ rdv: 'meeting/cancel', slot, reason: '' }))).toMatch(/1–200/);
    expect(reason(msg({ rdv: 'meeting/decline', reason: 'x'.repeat(201) }))).toMatch(/1–200/);
    expect(reason(msg({ rdv: 'meeting/propose', slots: [slot], place: { name: 'x', url: 'http://evil' } }))).toMatch(/unknown field/);
  });

  it('rejects malformed messages', () => {
    const data = { rdv: 'rdv/cancel' };
    expect(reason(msg(data, { messageId: 'not-a-uuid\u001b[2J' }))).toMatch(/UUID/);
    expect(reason(msg(data, { role: 'user' }))).toMatch(/role/);
    expect(reason(msg(data, { kind: 'task' }))).toMatch(/kind/);
    expect(reason(msg(data, { extra: 1 }))).toMatch(/unknown field/);
    expect(reason(msg(data, {}, [{ kind: 'text', text: 'hi' }]))).toMatch(/no data part/);
    expect(reason(msg(data, {}, [{ kind: 'data', data }, { kind: 'data', data }]))).toMatch(/more than one/);
    expect(reason(msg(data, {}, [{ kind: 'file', file: { uri: 'x' } }, { kind: 'data', data }]))).toMatch(/unsupported part/);
    expect(reason(msg(data, {}, [{ kind: 'text', text: 'x'.repeat(2001) }, { kind: 'data', data }]))).toMatch(/2000/);
    expect(reason(msg(data, {}, Array(9).fill({ kind: 'data', data })))).toMatch(/1–8 parts/);
    expect(reason({ type: 'a2a/message' })).toMatch(/missing "message"/);
    expect(reason({ type: 'a2a/message', message: msg(data).message, extra: true })).toMatch(/unknown field/);
    expect(reason({ type: 'a2a/other' })).toMatch(/not an a2a payload/);
    expect(reason(null)).toMatch(/object/);
    expect(reason([])).toMatch(/object/);
    expect(
      reason({ type: 'a2a/task-update', update: { kind: 'status-update', taskId: U(2), contextId: U(3), status: { state: 'done' }, final: true } }),
    ).toMatch(/task state/);
  });
});

describe('parsePayload: extensions (SPEC §7.5, issue #4)', () => {
  const head = { messageId: U(1), taskId: U(2), contextId: U(3) };
  const unsupportedOf = (p: unknown, opts?: Parameters<typeof parsePayload>[1]) => {
    const r = parsePayload(p, opts);
    return r.ok ? 'ok' : r.unsupported;
  };

  it('critical: unknown verbs, unknown data fields, unknown part kinds and disabled extensions are unsupported', () => {
    expect(unsupportedOf(msg({ rdv: 'meeting/reschedule', slot }))).toEqual({ ...head, verb: 'meeting/reschedule' });
    expect(unsupportedOf(msg({ rdv: 'meeting/propose', slots: [slot], recurrence: 'weekly' }))).toEqual({ ...head, verb: 'meeting/propose' });
    expect(unsupportedOf(msg({ rdv: 'meeting/propose', slots: [{ ...slot, tz: 'UTC' }] }))).toEqual({ ...head, verb: 'meeting/propose' });
    expect(unsupportedOf(msg({ rdv: 'meeting/accept', slot, place: { url: 'x' } }))).toEqual({ ...head, verb: 'meeting/accept' });
    expect(unsupportedOf(msg({ rdv: 'rdv/cancel' }, {}, [{ kind: 'file', file: { uri: 'x' } }, { kind: 'data', data: { rdv: 'rdv/cancel' } }]))).toEqual(head);
    // An agent that has not enabled meeting/cancel's extension treats it like any unknown verb.
    expect(unsupportedOf(msg({ rdv: 'meeting/cancel', slot }), { extensions: [EXTENSIONS.meeting] })).toEqual({ ...head, verb: 'meeting/cancel' });
    expect(unsupportedOf(msg({ rdv: 'meeting/cancel', slot }), { extensions: SUPPORTED_EXTENSIONS })).toBe('ok');
    expect(unsupportedOf(msg({ rdv: 'meeting/propose', slots: [slot] }), { extensions: [] })).toEqual({ ...head, verb: 'meeting/propose' });
    // A verb echoed back must look like one; anything else is left out.
    expect(unsupportedOf(msg({ rdv: 'Meeting/\u001b[2J' }))).toEqual(head);
  });

  it('malformed input is not "unsupported": no ids to answer, or nothing an extension could explain', () => {
    expect(unsupportedOf(msg({ slots: [slot] }))).toBeUndefined(); // no verb at all
    expect(unsupportedOf(msg({ rdv: 'meeting/accept' }))).toBeUndefined(); // missing field
    expect(unsupportedOf(msg({ rdv: 'meeting/propose', slots: [{ start: slot.end, end: slot.start }] }))).toBeUndefined();
    expect(unsupportedOf(msg({ rdv: 'meeting/reschedule' }, { messageId: 'nope' }))).toBeUndefined(); // ids are checked first
    expect(unsupportedOf(msg({ rdv: 'rdv/cancel' }, { extra: 1 }))).toBeUndefined(); // A2A's own objects stay strict
    expect(unsupportedOf(msg({ rdv: 'rdv/cancel' }, {}, [{ kind: 7 }, { kind: 'data', data: { rdv: 'rdv/cancel' } }]))).toBeUndefined();
  });

  it('ignorable: metadata on the message, its parts and updates, and unknown extension URIs', () => {
    const ext = 'https://rendezvous.nesher.co/ext/dress-code/v1';
    expect(
      reason(
        msg({ rdv: 'meeting/propose', slots: [slot] }, { extensions: [EXTENSIONS.meeting, ext], metadata: { [ext]: { code: 'smart casual' } } }, [
          { kind: 'text', text: 'Dinner?', metadata: { [ext]: 1 } },
          { kind: 'data', data: { rdv: 'meeting/propose', slots: [slot] }, metadata: { [`${ext}/hint`]: { any: ['thing'] } } },
        ]),
      ),
    ).toBe('ok');
    const update = (metadata: unknown) => ({
      type: 'a2a/task-update',
      update: { kind: 'status-update', taskId: U(2), contextId: U(3), status: { state: 'completed' }, final: true, metadata },
    });
    expect(reason(update({ [ext]: { x: 1 } }))).toBe('ok');
    // Our own key: a well-formed notice is surfaced, a malformed one ignored (it is still metadata).
    const notice = (v: unknown) => {
      const r = parsePayload(update({ [UNSUPPORTED_KEY]: v }));
      return r.ok && r.value.kind === 'update' ? (r.value.unsupported ?? null) : 'invalid';
    };
    expect(notice({ messageId: U(9), verb: 'meeting/cancel' })).toEqual({ messageId: U(9), verb: 'meeting/cancel' });
    expect(notice({ messageId: U(9), verb: '<script>' })).toEqual({ messageId: U(9) });
    expect(notice({ messageId: 'x' })).toBeNull();
    expect(notice('meeting/cancel')).toBeNull();
    expect(reason(msg({ rdv: 'rdv/cancel' }, { extensions: ['x'.repeat(201)] }))).toMatch(/short list/); // still bounded
  });
});
