import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXTENSIONS, JsonFileCalendar, parsePayload, parseTaskPayload, SUPPORTED_EXTENSIONS, TASKS_URI, UNSUPPORTED_KEY, validateCalendar } from '../src/index.js';

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

describe('parseTaskPayload: tasks/v1 is strict (issue #22)', () => {
  const REVIEW = 'https://rendezvous.nesher.co/ext/review/v1';
  const tmsg = (data: unknown, over: Record<string, unknown> = {}, parts?: unknown[]) => ({
    type: 'a2a/message',
    message: {
      kind: 'message',
      messageId: U(1),
      taskId: U(2),
      contextId: U(3),
      role: 'agent',
      parts: parts ?? [{ kind: 'data', data }, { kind: 'text', text: 'Could Omer look over the Q4 plan?' }],
      extensions: [TASKS_URI, REVIEW],
      ...over,
    },
  });
  const req = { rdv: 'task/request', capability: REVIEW, input: { focus: ['clarity'] }, expires: '2026-10-28T17:00:00Z' };
  const treason = (p: unknown) => {
    const r = parseTaskPayload(p);
    return r.ok ? 'ok' : r.reason;
  };
  const status = (status: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    type: 'a2a/task-update',
    update: { kind: 'status-update', taskId: U(2), contextId: U(3), status, final: false, ...over },
  });
  const artifact = (art: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    type: 'a2a/artifact-update',
    update: { kind: 'artifact-update', taskId: U(2), contextId: U(3), artifact: { artifactId: U(4), parts: [{ kind: 'text', text: 'ok' }], ...art }, ...over },
  });

  it('accepts the A.9 shapes', () => {
    const r = parseTaskPayload(
      tmsg(req, {}, [
        { kind: 'data', data: req },
        { kind: 'text', text: 'Could Omer look over the Q4 plan before Wednesday?' },
        { kind: 'file', file: { uri: 'https://files.example.com/q4/3f9a', mimeType: 'application/pdf', name: 'q4-plan.pdf' }, metadata: { x: 1 } },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'message') {
      expect(r.value.data).toEqual(req);
      expect(r.value.files).toHaveLength(1);
    }
    expect(treason(tmsg({ rdv: 'task/input', input: { a: 1 } }))).toBe('ok');
    expect(treason(tmsg({ rdv: 'rdv/cancel', reason: 'plans changed' }))).toBe('ok');
    expect(treason(status({ state: 'failed', timestamp: '2026-10-25T10:00:00Z' }, { final: true }))).toBe('ok');
    expect(
      treason(status({ state: 'input-required', message: { kind: 'message', messageId: U(5), role: 'agent', parts: [{ kind: 'text', text: 'Which?' }, { kind: 'data', data: { rdv: 'x/y' } }] } })),
    ).toBe('ok');
    expect(treason(artifact({ name: 'review', extensions: [REVIEW], parts: [{ kind: 'data', data: { rdv: 'review/result' } }] }, { lastChunk: true, append: false }))).toBe('ok');
  });

  it('critical unknowns are unsupported, with the ids and verb', () => {
    const unknownVerb = parseTaskPayload(tmsg({ rdv: 'task/claim' }));
    expect(unknownVerb).toMatchObject({ ok: false, unsupported: { messageId: U(1), taskId: U(2), contextId: U(3), verb: 'task/claim' } });
    const extraKey = parseTaskPayload(tmsg({ ...req, priority: 'high' }));
    expect(extraKey).toMatchObject({ ok: false, unsupported: { verb: 'task/request' } });
    const part = parseTaskPayload(tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'video', url: 'x' }]));
    expect(part).toMatchObject({ ok: false, unsupported: { messageId: U(1) } });
  });

  it('hostile input is malformed and dropped', () => {
    const cases: [string, unknown][] = [
      ['extra field in the message', tmsg(req, { sneaky: true })],
      ['non-UUID taskId', tmsg(req, { taskId: 'task-1' })],
      ['role user', tmsg(req, { role: 'user' })],
      ['no data part', tmsg(req, {}, [{ kind: 'text', text: 'hi' }])],
      ['two data parts', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'data', data: req }])],
      ['nine parts', tmsg(req, {}, [{ kind: 'data', data: req }, ...Array.from({ length: 8 }, () => ({ kind: 'text', text: 'x' }))])],
      ['text over 16,000', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'text', text: 'x'.repeat(16_001) }])],
      ['capability not a string', tmsg({ ...req, capability: 7 })],
      ['capability over 200', tmsg({ ...req, capability: 'https://e.example/' + 'a'.repeat(200) })],
      ['expires garbage', tmsg({ ...req, expires: 'tomorrow' })],
      ['reason over 200', tmsg({ rdv: 'rdv/cancel', reason: 'x'.repeat(201) })],
      ['data not an object', tmsg('task/request')],
      ['file with both bytes and uri', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'file', file: { bytes: 'AAAA', uri: 'https://x.example/' } }])],
      ['file bytes over 16 KiB', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'file', file: { bytes: 'A'.repeat(Math.ceil(16_384 / 3) * 4 + 4) } }])],
      ['file bytes not base64', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'file', file: { bytes: '<script>' } }])],
      ['file unknown key', tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'file', file: { uri: 'https://x.example/', path: '/etc/passwd' } }])],
      ['__proto__ key in the message', { type: 'a2a/message', message: JSON.parse(JSON.stringify(tmsg(req).message).replace('{', '{"__proto__":{"x":1},')) }],
      ['status: unknown state', status({ state: 'paused' })],
      ['status: final does not match', status({ state: 'completed' })],
      ['status: file part in the message', status({ state: 'working', message: { kind: 'message', messageId: U(5), role: 'agent', parts: [{ kind: 'file', file: { uri: 'https://x.example/' } }] } })],
      ['status: extra field', status({ state: 'working', note: 'x' })],
      ['artifact: non-UUID id', artifact({ artifactId: 'a1' })],
      ['artifact: no parts', artifact({ parts: [] })],
      ['artifact: unknown key', artifact({ owner: 'x' })],
      ['artifact: name over 200', artifact({ name: 'x'.repeat(201) })],
      ['artifact: append not a boolean', artifact({}, { append: 'yes' })],
      ['not an a2a payload', { type: 'a2a/task', task: {} }],
    ];
    for (const [what, p] of cases) {
      const r = parseTaskPayload(p);
      expect(r.ok, what).toBe(false);
      if (!r.ok) expect(r.unsupported, what).toBeUndefined();
    }
    // At the limits: accepted.
    expect(treason(tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'text', text: 'x'.repeat(16_000) }]))).toBe('ok');
    expect(treason(tmsg(req, {}, [{ kind: 'data', data: req }, { kind: 'file', file: { bytes: 'A'.repeat(Math.ceil(16_384 / 3) * 4) } }]))).toBe('ok');
    expect(treason(tmsg(req, {}, [{ kind: 'data', data: req }, ...Array.from({ length: 7 }, () => ({ kind: 'text', text: 'x' }))]))).toBe('ok');
  });

  it('metadata stays ignorable: our own keys are read only when well formed', () => {
    const r = parseTaskPayload(status({ state: 'rejected' }, { final: true, metadata: { [UNSUPPORTED_KEY]: { messageId: 'nope' }, [`${TASKS_URI}/reason`]: 'whatever', other: { deep: [1] } } }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'update') {
      expect(r.value.unsupported).toBeUndefined();
      expect(r.value.reason).toBeUndefined();
    }
  });

  it('the meeting parser still refuses task verbs as unsupported, and status updates with a message as malformed', () => {
    expect(parsePayload(tmsg(req))).toMatchObject({ ok: false, unsupported: { verb: 'task/request' } });
    const r = parsePayload(status({ state: 'working', message: { kind: 'message', messageId: U(5), role: 'agent', parts: [{ kind: 'text', text: 'x' }] } }));
    expect(r.ok).toBe(false);
    expect(parsePayload(status({ state: 'failed' }, { final: true })).ok).toBe(false);
  });
});
