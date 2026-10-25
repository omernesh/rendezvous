import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDinnerScenario } from '../scenarios/dinner.js';

// PLAN §5.3 "done when", against the in-memory relay: real `rdv` processes
// negotiating on their own.
describe('dinner scenarios (in-memory relay)', () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  });
  afterAll(() => relay.close());

  it('overlap: each human confirms, then both sides complete with the same slot', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'overlap' });
    expect(r.omer.state).toBe('completed');
    expect(r.john.agreed).toEqual(r.omer.agreed);
    // The relay only ever saw ciphertext.
    expect(relay.events.map((e) => e.content).join('')).not.toContain('meeting/');
  });

  it('no overlap: rejected after 3 rounds', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'no-overlap' });
    expect([r.omer.state, r.john.state, r.omer.round]).toEqual(['rejected', 'rejected', 3]);
  });

  it('mid-flight rdv/cancel: canceled on both sides', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'cancel' });
    expect([r.omer.state, r.john.state]).toEqual(['canceled', 'canceled']);
  });

  it('cancel while the accepter holds a slot for its human: the hold is released', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'cancel-hold' });
    expect([r.omer.state, r.john.state]).toEqual(['canceled', 'canceled']);
    expect(r.john.hold).toBeUndefined();
  });

  it('reverse grant: the grantor proposes once the requester’s human grants it back (issue #14)', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'reverse' });
    expect([r.omer.state, r.john.state]).toEqual(['completed', 'completed']);
    expect(r.omer.agreed).toEqual(r.john.agreed);
    expect(r.john.role).toBe('proposer');
    expect(r.steps.map((s) => s.step)).toContain('john cannot propose yet: omer has not granted him meetings');
  });

  it('duplicate deliveries change nothing', async () => {
    const r = await runDinnerScenario({ relays: [relay.url], variant: 'duplicate', settleMs: 1_500 });
    expect(r.steps.map((s) => s.step)).toContain('re-send a negotiation message in a new envelope');
  });
});

describe('dinner commands', () => {
  it('reject bad usage and keep peer text off the terminal', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rdv } = await import('../scenarios/harness.js');
    const { dinnerText } = await import('../src/negotiate.js');
    const dir = mkdtempSync(join(tmpdir(), 'rdv-dinner-cmd-'));
    const home = join(dir, 'h');
    try {
      await rdv(['init', '--email', 'omer@example.com', '--relay', 'ws://127.0.0.1:9'], home);
      const peer = (await rdv(['whoami'], home)).lines[0].id as string;
      const cal = join(dir, 'cal.json');
      writeFileSync(cal, JSON.stringify({ busy: [] }));
      const run = (args: string[]) => rdv(args, home, { check: false });
      expect((await run(['dinner', 'propose', peer, '--window', 'tonight'])).code).toBe(2); // no --calendar
      const noContact = await run(['dinner', 'propose', peer, '--calendar', cal, '--window', 'tonight']);
      expect([noContact.code, noContact.stderr]).toEqual([1, expect.stringContaining('no active contact')]);
      expect((await run(['listen', '--window', 'tonight'])).code).toBe(2); // --window without --negotiate
      expect((await run(['listen', '--negotiate', '--calendar', join(dir, 'missing.json')])).code).toBe(2);
      expect((await run(['listen', '--negotiate', '--calendar', cal, '--window', 'someday'])).code).toBe(2);
      expect((await run(['listen', '--negotiate', '--calendar', cal, '--tz', 'CET'])).code).toBe(2);
      expect((await run(['dinner', 'list'])).lines).toEqual([]);
      expect((await run(['dinner', 'cancel', '00000000-0000-4000-8000-000000000001'])).code).toBe(1);
      expect((await run(['dinner', 'confirm', '00000000-0000-4000-8000-000000000001'])).code).toBe(2); // no --hold
      expect((await run(['dinner', 'confirm', '00000000-0000-4000-8000-000000000001', '--hold', 'abcdef012345'])).code).toBe(1);
      expect((await run(['listen', '--auto-confirm'])).code).toBe(2); // --auto-confirm without --negotiate

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const text = dinnerText({ kind: 'rejected', taskId: 't', peer: 'p', reason: 'no\u001b[2J', peerText: ['hi‮there\nfake line'] })!;
    expect(text).not.toMatch(/[\u001b‮]/);
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('peer says (untrusted)');
  });
});
