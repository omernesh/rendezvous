// request/v1 (SPEC §7.6.3, issue #27): the general capability, as the hosts register it.
import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  checkData,
  checkInput,
  emptyTaskState,
  inputTask,
  askInput,
  needsReleaseGate,
  needsStartGate,
  receiveTask,
  REQUEST_CAPABILITY,
  REQUEST_DATA_BOUNDS,
  REQUEST_DATA_SHAPE,
  REQUEST_URI,
  requestTask,
  SchemaError,
  sendArtifact,
  startTask,
  TASKS_URI,
  TaskError,
} from '../src/index.js';

const OMER = 'rdv1:omer';
const JOHN = 'rdv1:john';
const NOW = new Date('2026-10-25T10:00:00Z');
const registry = new CapabilityRegistry([REQUEST_CAPABILITY]);
const ctx = { now: NOW, registry, invoke: { [REQUEST_URI]: {} } };

/** A request John received from Omer, started by John's human. */
function started(opts: Parameters<typeof requestTask>[4] = { text: ['x'] }) {
  const req = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, opts);
  const got = receiveTask(emptyTaskState(), OMER, req.outgoing[0].payload, ctx);
  return { req, got, s: startTask(got.state, req.taskId, ctx), id: req.taskId };
}

describe('request/v1', () => {
  it('is free-form: a free-text request, gated at the start and the release', () => {
    expect(REQUEST_CAPABILITY).toMatchObject({ uri: REQUEST_URI, approval: 'free-form', inputOptional: true });
    expect(needsStartGate(REQUEST_CAPABILITY.approval) && needsReleaseGate(REQUEST_CAPABILITY.approval)).toBe(true);
    expect(registry.uris()).toEqual([REQUEST_URI]);
    const req = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['Draft the copy'], peerCapabilities: [TASKS_URI, REQUEST_URI] });
    const got = receiveTask(emptyTaskState(), OMER, req.outgoing[0].payload, ctx);
    expect(got.effects).toEqual([expect.objectContaining({ kind: 'start-gate', approval: 'free-form' })]);
    expect(got.state.tasks[req.taskId]).toMatchObject({ state: 'submitted', text: ['Draft the copy'] });
  });

  it('no host can register it under a class that skips the start gate (no auto-start)', () => {
    for (const approval of ['notify', 'auto', 'confirm'] as const) {
      expect(() => new CapabilityRegistry([{ ...REQUEST_CAPABILITY, approval }])).toThrow(/free-form/);
    }
  });

  it('input: optional structured data beside the text, `{ data }`, strict and bounded', () => {
    const data = { items: ['intro', 'pricing'], due: '2026-10-28', pages: 3, draft: true, owner: null, nested: { a: [1, 2, { b: 'c' }] } };
    const { got, id } = started({ text: ['Fill in this form'], input: { data } });
    expect(got.state.tasks[id].input).toEqual({ data });
    expect(checkInput(REQUEST_CAPABILITY, undefined)).toBeUndefined(); // text alone is a request
    const refused: unknown[] = [
      { any: 1 }, // unknown field
      { data: 'a string' }, // data is an object
      { data: [1, 2] },
      { data: {}, extra: 1 },
      { data: { a: { b: { c: { d: { e: 1 } } } } } }, // deeper than maxDepth
      { data: { s: 'x'.repeat(REQUEST_DATA_BOUNDS.maxString + 1) } },
      { data: { list: Array.from({ length: REQUEST_DATA_BOUNDS.maxNodes }, (_, i) => i) } },
      { data: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'y'.repeat(1000)])) }, // over maxChars as JSON
      { data: { n: Infinity } },
      { data: { ['k'.repeat(65)]: 1 } },
      { data: { '': 1 } },
      { data: { when: new Date(0) } }, // not JSON
    ];
    for (const input of refused) {
      expect(() => checkInput(REQUEST_CAPABILITY, input), JSON.stringify(input) ?? String(input)).toThrow(SchemaError);
      expect(() => requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['x'], input })).toThrow(TaskError);
    }
    // A peer that sends a bad shape anyway gets a rejection, and no task waits for the human.
    const raw = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['x'] }).outgoing[0].payload as { message: { parts: Array<{ kind: string; data?: Record<string, unknown> }> } };
    const hostile = structuredClone(raw);
    hostile.message.parts.find((p) => p.kind === 'data')!.data!.input = { data: { a: { b: { c: { d: { e: 'deep' } } } } } };
    const r = receiveTask(emptyTaskState(), OMER, hostile, ctx);
    expect(r.effects.some((e) => e.kind === 'start-gate')).toBe(false);
  });

  it('results: text, files and `request/data` parts; every one waits for the release', () => {
    const { s, id } = started();
    const text = sendArtifact(s.state, id, ctx, { parts: [{ kind: 'text', text: 'done' }] });
    expect(text.effects.map((e) => e.kind)).toEqual(['release-gate']);
    expect(text.outgoing).toEqual([]);
    const data = sendArtifact(s.state, id, ctx, { parts: [{ kind: 'data', data: { rdv: REQUEST_DATA_SHAPE, data: { rows: [{ name: 'intro', words: 120 }] } } }] });
    expect(data.effects.map((e) => e.kind)).toEqual(['release-gate']);
    expect(data.outgoing).toEqual([]);
    for (const bad of [{ rdv: 'request/result' }, { rdv: REQUEST_DATA_SHAPE }, { rdv: REQUEST_DATA_SHAPE, data: {}, extra: 1 }, { rdv: REQUEST_DATA_SHAPE, data: 'x' }]) {
      expect(() => sendArtifact(s.state, id, ctx, { parts: [{ kind: 'data', data: bad }] })).toThrow(TaskError);
      expect(() => checkData(REQUEST_CAPABILITY, bad)).toThrow(SchemaError);
    }
  });

  it('a question and its answer carry the same data shape; the question is released by the human too', () => {
    const { s, id } = started();
    const q = askInput(s.state, id, ctx, { text: 'Which sections?', data: { rdv: REQUEST_DATA_SHAPE, data: { options: ['a', 'b'] } } });
    expect(q.effects.map((e) => e.kind)).toEqual(['release-gate']);
    const asked = askInput(s.state, id, ctx, { text: 'Which sections?' }, { released: true, ownerData: true });
    // Omer's side: the requester's copy of the task, moved to input-required by John's status.
    const omer = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['x'] });
    expect(asked.outgoing).toHaveLength(1);
    expect(() => inputTask(omer.state, omer.taskId, ctx, { input: { data: { pick: 'a' } } })).toThrow(TaskError); // not input-required yet
    expect(checkInput(REQUEST_CAPABILITY, { data: { pick: 'a' } }, true)).toEqual({ data: { pick: 'a' } });
    expect(() => checkInput(REQUEST_CAPABILITY, { pick: 'a' }, true)).toThrow(SchemaError);
  });
});
