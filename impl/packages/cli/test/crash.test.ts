// Issue #4: state must be on disk before an envelope leaves the process. Each
// crash here is a real process exit right after the relay accepted the
// envelope (RDV_TEST_EXIT_AFTER_SEND), before the command could save.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Line, Listener, rdv } from '../scenarios/harness.js';

let relay: TestRelay;
let root: string;
beforeAll(async () => {
  relay = await startTestRelay();
  root = mkdtempSync(join(tmpdir(), 'rdv-crash-'));
});
afterAll(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const CRASH = { RDV_TEST_EXIT_AFTER_SEND: '1' };

it('a crash right after a send never reuses seq (listen grant path and rdv send)', async () => {
  const omerHome = join(root, 'omer');
  const johnHome = join(root, 'john');
  await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
  const john = await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url], johnHome);
  const johnId: string = john.lines[0].id;
  const outSeq = () => JSON.parse(readFileSync(join(johnHome, 'agent.json'), 'utf8')).channels[omerId()]?.outSeq;
  let omerIdValue = '';
  const omerId = () => omerIdValue;

  const omerL = new Listener('omer', omerHome);
  const listeners = [omerL];
  try {
    omerIdValue = (await omerL.waitFor((l) => l.event === 'ready', 'omer ready', 10_000)).id;

    // 1. John's listener auto-grants and dies right after the grant goes out.
    const johnCrash = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier'], CRASH);
    listeners.push(johnCrash);
    await johnCrash.waitFor((l) => l.event === 'ready', 'john ready', 10_000);
    await rdv(['contact', 'request', 'john@doe.com', '--greeting', 'dinner?'], omerHome);
    expect(await johnCrash.exited(15_000)).toBe(99);
    const cand = await omerL.waitFor((l) => l.event === 'candidate' && l.from === johnId, 'omer gets the grant', 10_000);
    await rdv(['contact', 'confirm', cand.grant_id], omerHome);
    expect(outSeq()).toBe(1);

    // Restart: the relay replays the request, which must not be granted again with seq 1.
    const johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    listeners.push(johnL);
    await johnL.waitFor((l) => l.event === 'ready', 'john ready again', 10_000);
    await new Promise((r) => setTimeout(r, 1000)); // let the replay land
    expect(johnL.lines.filter((l) => l.event === 'contact')).toEqual([]);
    expect(outSeq()).toBe(1);

    // 2. `rdv send` dies right after sending; the next send must use the next seq.
    const crashed = await rdv(['send', omerId(), '--json', '{"type":"note","text":"first"}'], johnHome, { check: false, env: CRASH });
    expect(crashed.code).toBe(99);
    expect(outSeq()).toBe(2);
    const sent = await rdv(['send', omerId(), '--json', '{"type":"note","text":"second"}'], johnHome);
    expect(sent.lines[0].seq).toBe(3);

    const fromJohn = (l: Line) => l.event === 'message' && l.from === johnId;
    await omerL.waitFor((l) => fromJohn(l) && l.payload.text === 'second', 'omer gets the second note', 10_000);
    expect(omerL.lines.filter(fromJohn).map((l) => [l.seq, l.payload.text])).toEqual([
      [2, 'first'],
      [3, 'second'],
    ]);
    expect(omerL.lines.filter((l) => l.event === 'dropped' && String(l.reason).includes('fork'))).toEqual([]);
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
  }
});
