// request/v1 (SPEC §7.6.3): the general capability, as the hosts register it.
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, emptyTaskState, receiveTask, REQUEST_CAPABILITY, REQUEST_URI, requestTask, sendArtifact, startTask, TASKS_URI, TaskError } from '../src/index.js';

const OMER = 'rdv1:omer';
const JOHN = 'rdv1:john';
const NOW = new Date('2026-10-25T10:00:00Z');
const registry = new CapabilityRegistry([REQUEST_CAPABILITY]);
const ctx = { now: NOW, registry, invoke: { [REQUEST_URI]: {} } };

describe('request/v1', () => {
  it('is free-form: a free-text request, no input, gated at the start', () => {
    expect(REQUEST_CAPABILITY).toMatchObject({ uri: REQUEST_URI, approval: 'free-form' });
    expect(registry.uris()).toEqual([REQUEST_URI]);
    const req = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['Draft the copy'], peerCapabilities: [TASKS_URI, REQUEST_URI] });
    expect(() => requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { input: { any: 1 } })).toThrow(TaskError); // no input
    const got = receiveTask(emptyTaskState(), OMER, req.outgoing[0].payload, ctx);
    expect(got.effects).toEqual([expect.objectContaining({ kind: 'start-gate', approval: 'free-form' })]);
    expect(got.state.tasks[req.taskId]).toMatchObject({ state: 'submitted', text: ['Draft the copy'] });
  });

  it('results are text and files; a data part has no shape to match', () => {
    const req = requestTask(emptyTaskState(), JOHN, REQUEST_URI, ctx, { text: ['x'] });
    const id = req.taskId;
    const started = startTask(receiveTask(emptyTaskState(), OMER, req.outgoing[0].payload, ctx).state, id, ctx);
    const gated = sendArtifact(started.state, id, ctx, { parts: [{ kind: 'text', text: 'done' }] });
    expect(gated.effects.map((e) => e.kind)).toEqual(['release-gate']); // free-form: released by the human only
    expect(gated.outgoing).toEqual([]);
    expect(() => sendArtifact(started.state, id, ctx, { parts: [{ kind: 'data', data: { rdv: 'request/result' } }] })).toThrow(TaskError);
  });
});
