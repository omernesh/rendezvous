// PLAN.md §4.5: the scripted contact scenario, also the interop test.
//
//   1. John runs `rdv listen --json` on his home dir (Omer listens too, to see the grant).
//   2. Omer: `rdv contact request john@doe.com --greeting "…"` (topic probe).
//   3. John's bot sees `request` and runs `rdv contact grant <id> --tier friend`.
//   4. Omer sees `contact`, sends a message; John's inbox shows it.
//   5. Every step is asserted with a timeout; any failure throws (exit 1 from the CLI).
//
// Run directly against real relays:
//   node packages/cli/dist/scenarios/contact.js --relay wss://a --relay wss://b
//   (or set RDV_LIVE_RELAYS=wss://a,wss://b)
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assert, Listener, rdv, until } from './harness.js';

export interface ContactScenarioOptions {
  relays: string[];
  /** Per-step timeout. */
  stepTimeoutMs?: number;
  /** Suffix for the plus-addresses, so runs on shared public relays don't see each other. */
  tag?: string;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface ContactScenarioResult {
  omer: string;
  john: string;
  requestId: string;
  message: string;
  steps: Array<{ step: string; ms: number }>;
  dirs: { omer: string; john: string };
}

export async function runContactScenario(opts: ContactScenarioOptions): Promise<ContactScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  const omerEmail = `omer+${tag}@example.com`;
  const johnEmail = `john+${tag}@doe.com`;
  const root = mkdtempSync(join(tmpdir(), 'rdv-scenario-'));
  const dirs = { omer: join(root, 'omer'), john: join(root, 'john') };
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const listeners: Listener[] = [];
  const steps: ContactScenarioResult['steps'] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`- ${name}`);
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0 });
    return r;
  };
  const text = `Thursday 20:00? (${tag})`;

  try {
    const [omer, john] = await step('init both agents', async () => {
      await rdv(['init', '--profile', 'omer', '--email', omerEmail, ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', johnEmail, ...relayArgs], dirs.john);
      const o = (await rdv(['whoami'], dirs.omer)).lines[0].id as string;
      const j = (await rdv(['whoami'], dirs.john)).lines[0].id as string;
      assert(o && j && o !== j, 'two distinct agent IDs');
      return [o, j];
    });

    const [johnL, omerL] = await step('1. start listeners', async () => {
      const jl = new Listener('john', dirs.john);
      const ol = new Listener('omer', dirs.omer);
      listeners.push(jl, ol);
      await jl.waitFor((l) => l.event === 'ready', 'john ready', timeout);
      await ol.waitFor((l) => l.event === 'ready', 'omer ready', timeout);
      return [jl, ol];
    });

    const requestId = await step('2. omer requests contact by email', async () => {
      const r = await rdv(
        ['contact', 'request', johnEmail, '--greeting', "Omer's agent would like to plan dinner."],
        dirs.omer,
        { timeoutMs: timeout },
      );
      const sent = r.lines.find((l) => l.event === 'request-sent');
      assert(sent?.id, 'request-sent with an id');
      assert(sent.via === 'topic', 'sent as a topic probe');
      return sent.id as string;
    });

    await step('3. john sees the request and grants it', async () => {
      const req = await johnL.waitFor((l) => l.event === 'request' && l.id === requestId, 'request event', timeout);
      assert(req.from === omer, 'request comes from omer');
      assert(req.binding === 'claimed', 'topic probe binding is claimed');
      assert(String(req.greeting).includes('dinner'), 'greeting delivered');
      const g = await rdv(['contact', 'grant', requestId, '--tier', 'friend'], dirs.john, { timeoutMs: timeout });
      const granted = g.lines.find((l) => l.event === 'granted');
      assert(granted?.peer === omer && granted.tier === 'friend', 'john granted omer as friend');
    });

    await step('4. omer sees the contact, sends a message, john receives it', async () => {
      const c = await omerL.waitFor((l) => l.event === 'contact' && l.peer === john, 'contact event', timeout);
      assert(c.tier === 'friend', 'omer sees tier friend');
      const list = await rdv(['contact', 'list'], dirs.omer);
      assert(list.lines.some((l) => l.peer === john), 'john is in omer\'s contact list');
      const s = await rdv(['send', john, '--json', JSON.stringify({ type: 'a2a/message', text })], dirs.omer, {
        timeoutMs: timeout,
      });
      assert(s.lines[0]?.event === 'sent', 'send reports sent');
      await johnL.waitFor((l) => l.event === 'message' && l.from === omer, 'message event', timeout);
      await until(
        async () => {
          const inbox = await rdv(['inbox'], dirs.john);
          return inbox.lines.find((l) => l.from === omer && l.payload?.text === text);
        },
        "the message in john's inbox",
        timeout,
      );
    });

    return { omer, john, requestId, message: text, steps, dirs };
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
    if (!opts.keepDirs) rmSync(root, { recursive: true, force: true });
  }
}

export function relaysFromEnv(): string[] {
  return (process.env.RDV_LIVE_RELAYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// `node dist/scenarios/contact.js --relay wss://…`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { relay: { type: 'string', multiple: true }, timeout: { type: 'string' }, keep: { type: 'boolean' } },
  });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  if (relays.length === 0) {
    console.error('usage: node dist/scenarios/contact.js --relay wss://… [--relay …] [--timeout ms] [--keep]');
    process.exit(2);
  }
  runContactScenario({
    relays,
    stepTimeoutMs: values.timeout ? Number(values.timeout) : 30_000,
    keepDirs: values.keep,
    log: (l) => console.log(l),
  }).then(
    (r) => {
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS contact scenario on ${relays.join(', ')}`);
      process.exit(0);
    },
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}
