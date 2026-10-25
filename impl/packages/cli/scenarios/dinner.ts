// PLAN.md §5.3: two `rdv` bots negotiate dinner on their own.
//
//   setup  Omer and John init, both listen; Omer requests contact by email,
//          John's listener auto-grants (demo only); Omer confirms the answer.
//   then, by variant:
//     overlap     John is busy Monday evening. Omer offers Mon/Tue/Wed, John
//                 accepts Tuesday 19:00; both end `completed` holding that slot.
//     no-overlap  Omer is busy Thu–Sun evenings, John Mon–Wed: three offers,
//                 then John declines; both end `rejected` in round 3.
//     cancel      John is offline; Omer proposes and cancels. John comes back,
//                 counters the proposal, then honors the cancel: both `canceled`.
//     duplicate   overlap, then every envelope is delivered again (re-wrapped
//                 in new Nostr events, plus a full relay replay on listener
//                 restart) and one negotiation message is re-sent in a new
//                 envelope: nothing changes on either side.
//
//   node packages/cli/dist/scenarios/dinner.js --relay ws://… [--variant overlap] [--timeout ms] [--keep]
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseWindow, type Slot, toSlot, toSpan } from '@rendezvous/a2a';
import { type AgentState, generateKey, NostrTransport } from '@rendezvous/core';
import { relaysFromEnv } from './contact.js';
import { assert, type Line, Listener, rdv } from './harness.js';

export type DinnerVariant = 'overlap' | 'no-overlap' | 'cancel' | 'duplicate';
export const DINNER_VARIANTS: DinnerVariant[] = ['overlap', 'no-overlap', 'cancel', 'duplicate'];

export interface DinnerScenarioOptions {
  relays: string[];
  variant: DinnerVariant;
  stepTimeoutMs?: number;
  /** How long to let replayed envelopes arrive before comparing state. */
  settleMs?: number;
  tag?: string;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface DinnerScenarioResult {
  variant: DinnerVariant;
  taskId: string;
  omer: Line;
  john: Line;
  steps: Array<{ step: string; ms: number }>;
}

const TZ = '+02:00';
const WINDOW = 'next week evenings';

export async function runDinnerScenario(opts: DinnerScenarioOptions): Promise<DinnerScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  const v = opts.variant;
  const root = mkdtempSync(join(tmpdir(), 'rdv-dinner-'));
  const dirs = { omer: join(root, 'omer'), john: join(root, 'john') };
  const cal = { omer: join(root, 'omer-cal.json'), john: join(root, 'john-cal.json') };
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const negotiate = (calendar: string) => ['--negotiate', '--calendar', calendar, '--window', WINDOW, '--tz', TZ];
  const listeners: Listener[] = [];
  const steps: DinnerScenarioResult['steps'] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`- ${name}`);
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0 });
    return r;
  };
  const listen = async (name: 'omer' | 'john', extra: string[]) => {
    const l = new Listener(name, dirs[name], extra);
    listeners.push(l);
    await l.waitFor((x) => x.event === 'ready', `${name} ready`, timeout);
    return l;
  };
  const dinner = (task: string, kind: string) => (l: Line) => l.event === 'dinner' && l.task === task && l.kind === kind;
  const tasks = async (who: 'omer' | 'john') => (await rdv(['dinner', 'list'], dirs[who])).lines;

  // Next week's evenings at +02:00; day 0 is Monday.
  const evenings = parseWindow(WINDOW, { now: new Date(), offsetMinutes: 120 }).map((s) => toSlot(s, 120));
  const evening = (d: number, from = 19, to = 23): Slot => ({
    start: evenings[d].start.replace('T19:', `T${String(from).padStart(2, '0')}:`),
    end: evenings[d].end.replace('T23:', `T${String(to).padStart(2, '0')}:`),
  });
  const writeCal = (path: string, busy: Array<Slot & { title?: string }>) =>
    writeFileSync(path, JSON.stringify({ timezone: TZ, busy }, null, 2));

  try {
    const [omer, john] = await step('init both agents and calendars', async () => {
      await rdv(['init', '--profile', 'omer', '--email', `omer+${tag}@example.com`, ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', `john+${tag}@doe.com`, ...relayArgs], dirs.john);
      const o = (await rdv(['whoami'], dirs.omer)).lines[0].id as string;
      const j = (await rdv(['whoami'], dirs.john)).lines[0].id as string;
      if (v === 'overlap' || v === 'duplicate') {
        writeCal(cal.omer, [{ start: evening(0, 8, 9).start, end: evening(0, 8, 9).end, title: 'Omer private dentist' }]);
        writeCal(cal.john, [{ ...evening(0), title: 'John private thing' }]);
      } else {
        writeCal(cal.omer, [3, 4, 5, 6].map((d) => ({ ...evening(d), title: 'Omer private' })));
        writeCal(cal.john, [0, 1, 2].map((d) => ({ ...evening(d), title: 'John private' })));
      }
      return [o, j];
    });

    let johnL = await step('start listeners', async () => {
      const jl = await listen('john', ['--auto-grant', 'friend', '--auto-grant-any-tier', ...(v === 'cancel' ? [] : negotiate(cal.john))]);
      await listen('omer', negotiate(cal.omer));
      return jl;
    });
    let omerL = listeners[1];

    await step('omer requests contact, john auto-grants, omer confirms', async () => {
      await rdv(['contact', 'request', `john+${tag}@doe.com`, '--greeting', 'Dinner?'], dirs.omer, { timeoutMs: timeout });
      // Omer's human confirms the probe answer (anyone who saw the probe could have answered it).
      const cand = await omerL.waitFor((l) => l.event === 'candidate' && l.from === john, 'omer sees the grant candidate', timeout);
      await rdv(['contact', 'confirm', cand.grant_id], dirs.omer, { timeoutMs: timeout });
    });

    if (v === 'cancel') {
      const taskId = await step('john goes offline; omer proposes, then cancels', async () => {
        await johnL.stop();
        const p = await rdv(['dinner', 'propose', john, '--calendar', cal.omer, '--window', WINDOW, '--tz', TZ], dirs.omer, { timeoutMs: timeout });
        const id = p.lines.find((l) => l.kind === 'proposed')?.task as string;
        assert(id, 'propose prints the task id');
        const c = await rdv(['dinner', 'cancel', id, '--reason', 'change of plans'], dirs.omer, { timeoutMs: timeout });
        assert(c.lines.some((l) => l.kind === 'canceled' && l.task === id), 'cancel prints canceled');
        return id;
      });
      await step('john comes back: counters, then honors the cancel', async () => {
        johnL = await listen('john', negotiate(cal.john));
        await johnL.waitFor(dinner(taskId, 'countered'), 'john counters', timeout);
        await johnL.waitFor(dinner(taskId, 'canceled'), 'john honors the cancel', timeout);
        await omerL.waitFor((l) => dinner(taskId, 'status')(l) && String(l.reason).includes('canceled'), 'omer gets the ack', timeout);
      });
      return await step('both sides end canceled', async () => {
        const o = (await tasks('omer')).find((t) => t.id === taskId)!;
        const j = (await tasks('john')).find((t) => t.id === taskId)!;
        assert(o?.state === 'canceled' && j?.state === 'canceled', `both canceled (omer ${o?.state}, john ${j?.state})`);
        assert(j.reason === 'change of plans', 'john recorded the reason');
        return { variant: v, taskId, omer: o, john: j, steps };
      });
    }

    const taskId = await step('omer proposes dinner', async () => {
      const p = await rdv(['dinner', 'propose', john, '--calendar', cal.omer, '--window', WINDOW, '--tz', TZ, '--area', 'Tel Aviv'], dirs.omer, {
        timeoutMs: timeout,
      });
      const proposed = p.lines.find((l) => l.kind === 'proposed');
      assert(proposed?.task && proposed.slots?.length === 3, 'proposal with 3 slots');
      return proposed.task as string;
    });

    const [o, j] = await step(v === 'no-overlap' ? 'bots go 3 rounds and give up' : 'bots agree on a slot', async () => {
      if (v === 'no-overlap') {
        await omerL.waitFor(dinner(taskId, 'rejected'), 'omer sees the decline', timeout);
      } else {
        await omerL.waitFor(dinner(taskId, 'completed'), 'omer sees the accept', timeout);
        await johnL.waitFor((l) => dinner(taskId, 'status')(l) && String(l.reason).includes('completed'), 'john gets the confirmation', timeout);
      }
      const ot = (await tasks('omer')).find((t) => t.id === taskId)!;
      const jt = (await tasks('john')).find((t) => t.id === taskId)!;
      return [ot, jt];
    });

    await step('check both sides', async () => {
      if (v === 'no-overlap') {
        assert(o.state === 'rejected' && j.state === 'rejected', `both rejected (omer ${o.state}, john ${j.state})`);
        assert(o.round === 3 && j.round === 3, 'after 3 rounds');
        return;
      }
      assert(o.state === 'completed' && j.state === 'completed', `both completed (omer ${o.state}, john ${j.state})`);
      const want = toSpan(evening(1, 19, 21));
      for (const t of [o, j]) {
        const got = toSpan(t.agreed as Slot);
        assert(got.start === want.start && got.end === want.end, `agreed on Tuesday 19:00 (${JSON.stringify(t.agreed)})`);
      }
      for (const path of [cal.omer, cal.john]) {
        const holds = JSON.parse(readFileSync(path, 'utf8')).busy.filter((b: { title?: string }) => b.title?.includes(taskId));
        assert(holds.length === 1, `one hold in ${path}`);
      }
      // free_busy: no calendar titles crossed over.
      assert(!readFileSync(join(dirs.omer, 'inbox.jsonl'), 'utf8').includes('John private'), "John's titles stay private");
      assert(!readFileSync(join(dirs.john, 'inbox.jsonl'), 'utf8').includes('Omer private'), "Omer's titles stay private");
    });

    if (v === 'duplicate') {
      const snapshot = () => {
        const agent = (who: 'omer' | 'john') => JSON.parse(readFileSync(join(dirs[who], 'agent.json'), 'utf8')) as AgentState;
        const files = [
          join(dirs.omer, 'negotiations.json'),
          join(dirs.john, 'negotiations.json'),
          cal.omer,
          cal.john,
        ].map((p) => readFileSync(p, 'utf8'));
        const lines = (who: 'omer' | 'john') => readFileSync(join(dirs[who], 'inbox.jsonl'), 'utf8').split('\n').length;
        const a = agent('omer');
        const b = agent('john');
        return JSON.stringify({ files, chan: [a.channels, b.channels], out: [a.outbox, b.outbox], inbox: [lines('omer'), lines('john')] });
      };
      const settle = () => new Promise((r) => setTimeout(r, opts.settleMs ?? 2_000));

      await step('replay every envelope (new Nostr events) and restart both listeners', async () => {
        await settle();
        const before = snapshot();
        const replayer = new NostrTransport({ key: generateKey(), relays: opts.relays });
        try {
          for (const who of ['omer', 'john'] as const) {
            const state = JSON.parse(readFileSync(join(dirs[who], 'agent.json'), 'utf8')) as AgentState;
            for (const envs of Object.values(state.outbox)) for (const e of envs) await replayer.sendEnvelope(e, opts.relays);
          }
        } finally {
          replayer.close();
        }
        await settle();
        await Promise.all(listeners.splice(0).map((l) => l.stop()));
        johnL = await listen('john', negotiate(cal.john));
        omerL = await listen('omer', negotiate(cal.omer));
        await settle();
        assert(snapshot() === before, 'replayed envelopes changed nothing');
      });

      await step('re-send a negotiation message in a new envelope', async () => {
        const inbox = readFileSync(join(dirs.john, 'inbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const proposal = inbox.find((e) => e.payload?.type === 'a2a/message' && e.payload.message.taskId === taskId)!.payload;
        const negBefore = [readFileSync(join(dirs.john, 'negotiations.json'), 'utf8'), readFileSync(cal.john, 'utf8')];
        const johnOutbox = () => Object.values((JSON.parse(readFileSync(join(dirs.john, 'agent.json'), 'utf8')) as AgentState).outbox).flat().length;
        const sentBefore = johnOutbox();
        await rdv(['send', john, '--json', JSON.stringify(proposal)], dirs.omer, { timeoutMs: timeout });
        await johnL.waitFor(dinner(taskId, 'duplicate'), 'john sees a duplicate', timeout);
        await settle();
        const negAfter = [readFileSync(join(dirs.john, 'negotiations.json'), 'utf8'), readFileSync(cal.john, 'utf8')];
        assert(JSON.stringify(negAfter) === JSON.stringify(negBefore), 'john state unchanged');
        assert(johnOutbox() === sentBefore, 'john sent nothing');
      });
    }

    return { variant: v, taskId, omer: o, john: j, steps };
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
    if (!opts.keepDirs) rmSync(root, { recursive: true, force: true });
  }
}

// `node dist/scenarios/dinner.js --relay ws://… [--variant overlap]`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      relay: { type: 'string', multiple: true },
      variant: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      keep: { type: 'boolean' },
    },
  });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  const variants = (values.variant?.length ? values.variant : ['overlap']) as DinnerVariant[];
  if (relays.length === 0 || variants.some((x) => !DINNER_VARIANTS.includes(x))) {
    console.error(`usage: node dist/scenarios/dinner.js --relay ws://… [--variant ${DINNER_VARIANTS.join('|')}] [--timeout ms] [--keep]`);
    process.exit(2);
  }
  (async () => {
    for (const variant of variants) {
      const r = await runDinnerScenario({
        relays,
        variant,
        stepTimeoutMs: values.timeout ? Number(values.timeout) : 30_000,
        settleMs: 5_000,
        keepDirs: values.keep,
        log: (l) => console.log(l),
      });
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS dinner ${variant} on ${relays.join(', ')}: ${r.omer.state}${r.omer.agreed ? ` ${JSON.stringify(r.omer.agreed)}` : ''}`);
    }
  })().then(
    () => process.exit(0),
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}
