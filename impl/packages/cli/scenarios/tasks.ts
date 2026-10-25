// SPEC §7.6 with the two human gates (§5.5), issues #24 and #36: Omer's agent
// asks John's for a general task (request/v1) and gets the result back.
//
//   setup   Omer and John init and listen; Omer requests contact by email;
//           John's human grants it, letting Omer invoke request/v1
//           (`rdv contact grant <id> --invoke …`); Omer confirms the answer.
//   task    Omer runs `rdv task request`. John's agent holds it `submitted`
//           for John (start gate): a wrong code is refused, `rdv task approve
//           --code` starts it. John drafts the result (`rdv task submit`):
//           nothing leaves until `rdv task release --code` (release gate).
//           Omer's listener shows the artifact, then `completed`.
//
//   node packages/cli/dist/scenarios/tasks.js --relay ws://… [--timeout ms] [--keep]
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REQUEST_URI } from '@rendezvous/a2a';
import { relaysFromEnv } from './contact.js';
import { assert, type Line, Listener, rdv } from './harness.js';

export interface TaskScenarioOptions {
  relays: string[];
  stepTimeoutMs?: number;
  tag?: string;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface TaskScenarioResult {
  taskId: string;
  omer: Line;
  john: Line;
  artifact: Line;
  steps: Array<{ step: string; ms: number }>;
}

export const TASK_TEXT = 'Draft the landing-page copy for the microsite.';
export const RESULT_TEXT = 'Launch faster: one page, three sections, a clear call to action.';

export async function runTaskScenario(opts: TaskScenarioOptions): Promise<TaskScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  const root = mkdtempSync(join(tmpdir(), 'rdv-tasks-'));
  const dirs = { omer: join(root, 'omer'), john: join(root, 'john') };
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const listeners: Listener[] = [];
  const steps: TaskScenarioResult['steps'] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`- ${name}`);
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0 });
    return r;
  };
  const listen = async (name: 'omer' | 'john') => {
    const l = new Listener(name, dirs[name]);
    listeners.push(l);
    await l.waitFor((x) => x.event === 'ready', `${name} ready`, timeout);
    return l;
  };
  const task = (id: string, kind: string) => (l: Line) => l.event === 'task' && l.task === id && l.kind === kind;
  const listed = async (who: 'omer' | 'john', id: string) => (await rdv(['task', 'list'], dirs[who])).lines.find((l) => l.id === id);

  try {
    const [omer, john] = await step('init both agents', async () => {
      await rdv(['init', '--profile', 'omer', '--email', `omer+${tag}@example.com`, ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', `john+${tag}@doe.com`, ...relayArgs], dirs.john);
      const card = JSON.parse(readFileSync(join(dirs.john, 'agent.json'), 'utf8')).card;
      assert(card.capabilities.includes(REQUEST_URI), "john's card advertises request/v1");
      return [(await rdv(['whoami'], dirs.omer)).lines[0].id as string, (await rdv(['whoami'], dirs.john)).lines[0].id as string];
    });
    const [johnL, omerL] = await step('start listeners', async () => [await listen('john'), await listen('omer')]);

    await step('omer requests contact; john grants it request/v1; omer confirms', async () => {
      await rdv(['contact', 'request', `john+${tag}@doe.com`, '--greeting', 'Can we work together?'], dirs.omer, { timeoutMs: timeout });
      const req = await johnL.waitFor((l) => l.event === 'request' && l.from === omer, 'john sees the request', timeout);
      await rdv(['contact', 'grant', req.id, '--invoke', REQUEST_URI], dirs.john, { timeoutMs: timeout });
      const cand = await omerL.waitFor((l) => l.event === 'candidate' && l.from === john, 'omer sees the grant candidate', timeout);
      await rdv(['contact', 'confirm', cand.grant_id], dirs.omer, { timeoutMs: timeout });
      const c = (await rdv(['contact', 'list'], dirs.omer)).lines.find((l) => l.peer === john);
      assert(c?.outbound_invoke?.includes(REQUEST_URI), `omer may invoke request/v1 on john (${JSON.stringify(c)})`);
    });

    const taskId = await step('omer asks john for a task', async () => {
      const r = await rdv(['task', 'request', john, '--text', TASK_TEXT], dirs.omer, { timeoutMs: timeout });
      const sent = r.lines.find((l) => l.event === 'task' && l.kind === 'requested');
      assert(sent?.task, 'the task was requested');
      return sent.task as string;
    });

    await step("john's agent holds it for john (start gate)", async () => {
      await johnL.waitFor(task(taskId, 'start-needed'), 'john is asked to approve', timeout);
      const t = await listed('john', taskId);
      assert(t?.state === 'submitted' && t.start_code && t.text?.[0] === TASK_TEXT, `john's task waits for him (${JSON.stringify(t)})`);
      // A code for something else approves nothing.
      const wrong = await rdv(['task', 'approve', taskId, '--code', '000000000000'], dirs.john, { check: false });
      assert(wrong.code === 1 && wrong.stderr.includes('not the task you reviewed'), `a wrong code is refused (${wrong.stderr})`);
      const ok = await rdv(['task', 'approve', taskId, '--code', t.start_code], dirs.john, { timeoutMs: timeout });
      assert(ok.lines.some((l) => l.kind === 'started' && l.task === taskId), 'approving starts it');
    });

    const artifact = await step('john drafts the result; it leaves only once john releases it', async () => {
      await omerL.waitFor((l) => l.event === 'task' && l.task === taskId && l.state === 'working', 'omer sees it working', timeout);
      const d = await rdv(['task', 'submit', taskId, '--text', RESULT_TEXT, '--name', 'copy', '--complete'], dirs.john, { timeoutMs: timeout });
      const draft = d.lines.find((l) => l.event === 'task-draft');
      assert(draft?.release_code, 'the result is held for release');
      assert(!omerL.lines.some(task(taskId, 'artifact')), 'nothing reached omer before the release');
      const wrong = await rdv(['task', 'release', taskId, '--code', 'ffffffffffff'], dirs.john, { check: false });
      assert(wrong.code === 1, 'a wrong code sends nothing');
      const rel = await rdv(['task', 'release', taskId, '--code', draft.release_code], dirs.john, { timeoutMs: timeout });
      assert(rel.lines.some((l) => l.kind === 'artifact' && l.task === taskId) && rel.lines.some((l) => l.kind === 'completed'), 'released and completed');
      return omerL.waitFor(task(taskId, 'artifact'), 'omer receives the result', timeout);
    });

    const [o, j] = await step('both end completed', async () => {
      await omerL.waitFor(task(taskId, 'completed'), 'omer sees it completed', timeout);
      return [await listed('omer', taskId), await listed('john', taskId)];
    });
    assert(o?.state === 'completed' && j?.state === 'completed', `both completed (omer ${o?.state}, john ${j?.state})`);
    return { taskId, omer: o!, john: j!, artifact, steps };
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
    if (!opts.keepDirs) rmSync(root, { recursive: true, force: true });
  }
}

// `node dist/scenarios/tasks.js --relay ws://…`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { relay: { type: 'string', multiple: true }, timeout: { type: 'string' }, keep: { type: 'boolean' } } });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  if (relays.length === 0) {
    console.error('usage: node dist/scenarios/tasks.js --relay ws://… [--timeout ms] [--keep]');
    process.exit(2);
  }
  runTaskScenario({ relays, stepTimeoutMs: values.timeout ? Number(values.timeout) : 30_000, keepDirs: values.keep, log: (l) => console.log(l) }).then(
    (r) => {
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS tasks on ${relays.join(', ')}: ${r.omer.state}`);
      process.exit(0);
    },
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}
