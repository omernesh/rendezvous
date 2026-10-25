// Design A.9 as a scenario (issue #30): John's agent asks Omer's agent to
// review a document. Real `rdv` processes, one home each; every human step
// goes through the human's own path (the codes `rdv task list` shows).
//
//   setup   Omer and John init and listen; John requests contact by email;
//           Omer's human grants it request/v1 at 5 a day (a scope file);
//           John confirms the answer. A local HTTPS store holds the file.
//   ok      John's human releases his Q4 plan from his own terminal: `rdv
//           file prepare` encrypts it, he uploads the ciphertext, `rdv task
//           request --file` sends the reference (requester-side release).
//           Omer's agent holds the task `submitted` (start gate): nothing is
//           fetched, a fetch is refused. Omer approves with the code; the
//           agent fetches, verifies and decrypts into quarantine. The draft
//           review waits at the release gate; Omer edits one line (a new
//           draft, a new code: the old code sends nothing) and releases it.
//           John receives the artifact (text + review/result data), then
//           `completed`.
//   decline Omer declines at the start gate: `rejected`, nothing fetched.
//   cancel  John cancels while Omer reads: Omer's code no longer approves
//           anything, nothing starts, nothing is fetched.
//   rate    Five reviews in a day, each declined; the sixth is refused by
//           John's own agent (rate), and a sixth sent raw past it is
//           rejected by Omer's for rate, with no prompt for Omer.
//   auto    Omer turns on auto-approve for John (his terminal, the
//           fingerprint retyped): both gates pass without asking, each
//           written to Omer's audit log; the fetch is still the agent's.
//
// Fetching from the local store goes through the fetch helper's test-only
// options (`fetchIncoming(..., { ca, unsafeAllowAddresses })`, NOTES 77):
// production `rdv file fetch` refuses loopback, which the ok variant checks.
// Turning auto-approve on uses the command's terminal seam (`Tty`): spawned
// `rdv` has no TTY and is refused, which the auto variant checks.
//
//   node packages/cli/dist/scenarios/review.js --relay ws://… [--variant ok|decline|cancel|rate|auto|all] [--timeout ms] [--keep]
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REQUEST_URI, TASKS_URI } from '@rendezvous/a2a';
import { fingerprint } from '@rendezvous/core';
import { startTestFileServer, type TestFileServer } from '@rendezvous/core/testing';
import { contactAutoApprove, type Tty } from '../src/commands.js';
import { fetchIncoming } from '../src/files.js';
import { Home } from '../src/home.js';
import { Output } from '../src/output.js';
import { relaysFromEnv } from './contact.js';
import { assert, type Line, Listener, rdv } from './harness.js';

export const REVIEW_VARIANTS = ['ok', 'decline', 'cancel', 'rate', 'auto'] as const;
export type ReviewVariant = (typeof REVIEW_VARIANTS)[number];

export interface ReviewScenarioOptions {
  relays: string[];
  variant: ReviewVariant;
  stepTimeoutMs?: number;
  tag?: string;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface ReviewScenarioResult {
  variant: ReviewVariant;
  taskId: string;
  /** Final task state on each side. */
  omer: string;
  john: string;
  /** John's view of the review (ok, auto). */
  artifact?: Line;
  /** Omer's audit log for John (gate lines). */
  audit: Line[];
  /** Requests the file store served. */
  fetched: number;
  steps: Array<{ step: string; ms: number }>;
}

export const DOC_TEXT = '# Q4 plan\n\n1. Hire two engineers.\n2. Ship v0.3.\n3. Totals: 40 + 25 = 70.\n';
export const ASK_TEXT = 'Could Omer look over the Q4 plan before Wednesday?';
export const REVIEW_DRAFT = "Section 3's totals don't add up: 40 + 25 is 65.";
export const REVIEW_TEXT = "Section 3's totals don't add up: 40 + 25 is 65, not 70. Two more comments inline.";
export const REVIEW_DATA = { rdv: 'request/data', data: { rdv: 'review/result', verdict: 'changes-requested', comments: 3 } };
const RATE = '5/day';

export async function runReviewScenario(opts: ReviewScenarioOptions): Promise<ReviewScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  if (!REVIEW_VARIANTS.includes(opts.variant)) throw new Error(`unknown variant ${opts.variant}`);
  const variant = opts.variant;
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  const root = mkdtempSync(join(tmpdir(), 'rdv-review-'));
  const dirs = { omer: join(root, 'omer'), john: join(root, 'john') };
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const listeners: Listener[] = [];
  const steps: ReviewScenarioResult['steps'] = [];
  let store: TestFileServer | undefined;
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
  const listed = async (who: 'omer' | 'john', id: string) => (await rdv(['task', 'list'], dirs[who])).lines.find((l) => l.event === 'task' && l.id === id);
  // The fetch helper's test-only hook: the local store's certificate and loopback address (NOTES 77).
  const fetchTest = () => ({ ca: store!.ca, unsafeAllowAddresses: ['127.0.0.1'] });
  const fetchedFrom = (sha: string) => store!.seen.filter((s) => s.path.includes(sha)).length;

  try {
    store = await startTestFileServer();
    const [omer, john] = await step('init both agents', async () => {
      await rdv(['init', '--profile', 'omer', '--email', `omer+${tag}@example.com`, ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', `john+${tag}@doe.com`, ...relayArgs], dirs.john);
      return [(await rdv(['whoami'], dirs.omer)).lines[0].id as string, (await rdv(['whoami'], dirs.john)).lines[0].id as string];
    });
    const [omerL, johnL] = await step('start listeners', async () => [await listen('omer'), await listen('john')]);

    await step(`john requests contact; omer's human grants request/v1 at ${RATE}; john confirms`, async () => {
      await rdv(['contact', 'request', `omer+${tag}@example.com`, '--greeting', 'John here, from the Q4 planning group.'], dirs.john, { timeoutMs: timeout });
      const req = await omerL.waitFor((l) => l.event === 'request' && l.from === john, 'omer sees the request', timeout);
      const scopeFile = join(root, 'scope.json');
      writeFileSync(scopeFile, JSON.stringify({ invoke: { [REQUEST_URI]: { max_frequency: RATE } } }));
      await rdv(['contact', 'grant', req.id, '--scope-file', scopeFile, '--label', `john+${tag}@doe.com`], dirs.omer, { timeoutMs: timeout });
      const cand = await johnL.waitFor((l) => l.event === 'candidate' && l.from === omer, 'john sees the grant candidate', timeout);
      await rdv(['contact', 'confirm', cand.grant_id], dirs.john, { timeoutMs: timeout });
      const c = (await rdv(['contact', 'list'], dirs.john)).lines.find((l) => l.peer === omer);
      assert(c?.outbound_invoke?.includes(REQUEST_URI), `john may invoke request/v1 on omer (${JSON.stringify(c)})`);
    });

    if (variant === 'auto') {
      await step("omer's human turns on auto-approve for john (his terminal, fingerprint retyped)", async () => {
        // Spawned `rdv` has no terminal: refused, so no assistant or script can do this.
        const piped = await rdv(['contact', 'auto-approve', john, 'all'], dirs.omer, { check: false });
        assert(piped.code === 1 && piped.stderr.includes('interactive terminal'), `a spawned rdv is refused (${piped.stderr})`);
        // The owner's terminal (the command's Tty seam): he reads the warning and retypes John's fingerprint.
        const shown: string[] = [];
        const tty: Tty = { interactive: true, say: (t) => void shown.push(t), ask: async (q) => (shown.push(q), fingerprint(john)) };
        await contactAutoApprove({ home: new Home(dirs.omer), out: Object.assign(new Output(true), { emit() {} }), values: { until: '1d' }, positionals: [john, 'all'], tty });
        assert(/WARNING: auto-approve-all/.test(shown[0] ?? ''), 'the warning was shown first');
        const c = (await rdv(['contact', 'list'], dirs.omer)).lines.find((l) => l.peer === john);
        assert(c?.auto_approve?.mode === 'all', `auto-approve is on (${JSON.stringify(c)})`);
      });
    }

    // --- rate: five reviews in a day, then the sixth -------------------------------------------
    if (variant === 'rate') {
      const ids = await step('five reviews today, each declined by omer', async () => {
        const ids: string[] = [];
        for (let i = 1; i <= 5; i++) {
          const r = await rdv(['task', 'request', omer, '--text', `Review ${i} of the Q4 plan, please.`], dirs.john, { timeoutMs: timeout });
          const id = r.lines.find((l) => l.event === 'task' && l.kind === 'requested')?.task as string;
          assert(id, `review ${i} was requested`);
          await omerL.waitFor(task(id, 'start-needed'), `omer is asked about review ${i}`, timeout);
          await rdv(['task', 'decline', id], dirs.omer, { timeoutMs: timeout });
          await johnL.waitFor((l) => l.event === 'task' && l.task === id && l.state === 'rejected', `john sees review ${i} rejected`, timeout);
          ids.push(id);
        }
        return ids;
      });
      const sixth = await step("the sixth: refused by john's own agent, and by omer's when sent raw; no prompt", async () => {
        const mine = await rdv(['task', 'request', omer, '--text', 'Review 6 of the Q4 plan, please.'], dirs.john, { check: false, timeoutMs: timeout });
        assert(mine.code !== 0 && /rate|max_frequency|5\/day/i.test(mine.stderr), `john's agent keeps within omer's grant (${mine.code} ${mine.stderr})`);
        // A peer that skips its own check: a raw task/request reaches Omer's gates, which count admissions.
        const id = randomUUID();
        const payload = {
          type: 'a2a/message',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: randomUUID(),
            taskId: id,
            contextId: randomUUID(),
            extensions: [TASKS_URI, REQUEST_URI],
            parts: [
              { kind: 'data', data: { rdv: 'task/request', capability: REQUEST_URI } },
              { kind: 'text', text: 'Review 6 of the Q4 plan, please.' },
            ],
          },
        };
        const before = omerL.lines.length;
        await rdv(['send', omer, '--json', JSON.stringify(payload)], dirs.john, { timeoutMs: timeout });
        // Omer's listener reports the refusal (a task event) and never asks him.
        const refused = await omerL.waitFor((l) => l.event === 'task' && l.task === id && l.state === 'rejected', "omer's agent rejects it", timeout);
        assert(refused.code === 'rate', `rejected for rate (${JSON.stringify(refused)})`);
        assert(!omerL.lines.slice(before).some(task(id, 'start-needed')), 'omer was not prompted');
        const dropped = (await rdv(['task', 'list'], dirs.omer)).lines.find((l) => l.event === 'tasks-dropped');
        assert(dropped?.dropped?.rate === 1, `counted for omer as dropped for rate (${JSON.stringify(dropped)})`);
        assert((await listed('omer', id)) === undefined, 'no state kept for it');
        return id;
      });
      const states = await Promise.all(ids.map((id) => listed('omer', id)));
      assert(states.every((t) => t?.state === 'rejected'), 'the five ended rejected');
      return { variant, taskId: sixth, omer: 'rejected', john: 'rejected', audit: await auditOf(dirs.omer, john), fetched: 0, steps };
    }

    // --- the document review ---------------------------------------------------------------------
    const { sha, url } = await step("john's human releases the Q4 plan: encrypted, uploaded", async () => {
      const src = join(root, 'q4-plan.md');
      writeFileSync(src, DOC_TEXT);
      const p = (await rdv(['file', 'prepare', src, '--mime', 'text/markdown'], dirs.john)).lines[0];
      assert(p.encrypted === true && /^[0-9a-f]{64}$/.test(p.sha256), `prepared, encrypted (${JSON.stringify(p)})`);
      assert(!JSON.stringify(p).includes('"key"'), 'no key in the result');
      const url = store!.put(`/q4/${p.sha256}`, new Uint8Array(readFileSync(p.upload)));
      return { sha: p.sha256 as string, url };
    });

    const taskId = await step('john asks omer for a review, with the file', async () => {
      const due = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const input = JSON.stringify({ data: { focus: ['clarity', 'numbers'], due } });
      const r = await rdv(['task', 'request', omer, '--text', ASK_TEXT, '--input', input, '--expires', due, '--file', `${sha}=${url}`], dirs.john, { timeoutMs: timeout });
      const sent = r.lines.find((l) => l.event === 'task' && l.kind === 'requested');
      assert(sent?.task, 'the review was requested');
      return sent.task as string;
    });

    if (variant !== 'auto') {
      await step("omer's agent holds it for omer (start gate); nothing fetched", async () => {
        await omerL.waitFor(task(taskId, 'start-needed'), 'omer is asked to approve', timeout);
        const t = await listed('omer', taskId);
        assert(t?.state === 'submitted' && t.start_code && t.text?.[0] === ASK_TEXT, `omer's task waits for him (${JSON.stringify(t)})`);
        // What Omer reviews: John's text, the input, and the file's name, size and hash (never its key).
        assert(t.files?.[0]?.name === 'q4-plan.md' && t.files[0].sha256 === sha && t.files[0].encrypted === true, `the listing names the file and its hash (${JSON.stringify(t.files)})`);
        assert(JSON.stringify(t.input?.data?.focus) === '["clarity","numbers"]', `the listing shows the focus (${JSON.stringify(t.input)})`);
        const early = await fetchIncoming(new Home(dirs.omer), taskId, { index: 1 }, fetchTest()).then(
          () => 'fetched',
          (e: Error) => e.message,
        );
        assert(early !== 'fetched' && fetchedFrom(sha) === 0, `no fetch before the start gate (${early})`);
      });
    }

    if (variant === 'decline') {
      await step('omer declines: rejected, nothing fetched', async () => {
        await rdv(['task', 'decline', taskId], dirs.omer, { timeoutMs: timeout });
        await johnL.waitFor((l) => l.event === 'task' && l.task === taskId && l.state === 'rejected', 'john sees it rejected', timeout);
        const late = await fetchIncoming(new Home(dirs.omer), taskId, {}, fetchTest()).then(
          () => 'fetched',
          (e: Error) => e.message,
        );
        assert(late !== 'fetched', `no fetch after a decline (${late})`);
      });
      return await finish('rejected', 'rejected');
    }

    if (variant === 'cancel') {
      await step("john cancels while omer reads; omer's code approves nothing", async () => {
        const code = (await listed('omer', taskId))?.start_code as string;
        assert(code, 'omer has the code he is reading');
        await rdv(['task', 'cancel', taskId, '--reason', 'Found the mistake myself.'], dirs.john, { timeoutMs: timeout });
        await omerL.waitFor((l) => l.event === 'task' && l.task === taskId && l.state === 'canceled', 'omer sees it canceled', timeout);
        const late = await rdv(['task', 'approve', taskId, '--code', code], dirs.omer, { check: false });
        assert(late.code === 1 && /not waiting for your approval|not the task you reviewed/.test(late.stderr), `the old code is refused (${late.stderr})`);
        assert(!omerL.lines.some((l) => l.event === 'task' && l.task === taskId && l.kind === 'started'), 'nothing started');
        assert(!existsSync(join(dirs.omer, 'files', 'incoming', taskId)), 'nothing saved');
      });
      return await finish('canceled', 'canceled');
    }

    if (variant === 'ok') {
      await step('omer approves with the code (a wrong code is refused)', async () => {
        const wrong = await rdv(['task', 'approve', taskId, '--code', '000000000000'], dirs.omer, { check: false });
        assert(wrong.code === 1 && wrong.stderr.includes('not the task you reviewed'), `a wrong code is refused (${wrong.stderr})`);
        const code = (await listed('omer', taskId))?.start_code as string;
        const ok = await rdv(['task', 'approve', taskId, '--code', code], dirs.omer, { timeoutMs: timeout });
        assert(ok.lines.some((l) => l.kind === 'started' && l.task === taskId), 'approving starts it');
      });
    } else {
      await step("omer's agent starts it without asking (auto-approve)", async () => {
        const started = await omerL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'started' && l.auto_approved === true, 'auto start', timeout);
        assert(started, 'started by auto-approve');
        assert(!omerL.lines.some(task(taskId, 'start-needed')), 'omer was not asked');
      });
    }

    await step('omer\'s agent fetches, verifies and decrypts the plan into quarantine', async () => {
      await johnL.waitFor((l) => l.event === 'task' && l.task === taskId && l.state === 'working', 'john sees it working', timeout);
      if (variant === 'ok') {
        // Production `rdv file fetch` refuses the loopback store: only the test hook reaches it.
        const prod = await rdv(['file', 'fetch', taskId], dirs.omer, { check: false, timeoutMs: timeout });
        assert(prod.code === 1 && prod.stderr.includes('blocked-address'), `rdv file fetch refuses loopback (${prod.stderr})`);
      }
      const got = await fetchIncoming(new Home(dirs.omer), taskId, { index: 1 }, fetchTest());
      assert(got.encrypted && got.fetched_sha256 === sha, `verified and decrypted (${JSON.stringify(got)})`);
      assert(readFileSync(got.path, 'utf8') === DOC_TEXT, 'the plaintext is the plan');
      assert(got.path.startsWith(join(dirs.omer, 'files', 'incoming', taskId)), `saved in quarantine (${got.path})`);
      const hits = store!.seen.filter((s) => s.path === `/q4/${sha}`);
      assert(hits.length === 1 && !hits[0].headers.cookie && !hits[0].headers.authorization, 'fetched once, no credentials');
    });

    const artifact = await step(variant === 'ok' ? 'the review waits for release; omer edits one line, then releases it' : 'the review leaves without asking (auto-approve)', async () => {
      const submit = (text: string) =>
        rdv(['task', 'submit', taskId, '--text', text, '--data', JSON.stringify(REVIEW_DATA), '--name', 'review', '--complete'], dirs.omer, { timeoutMs: timeout });
      if (variant === 'auto') {
        const s = await submit(REVIEW_TEXT);
        assert(s.lines.some((l) => l.event === 'task-auto-released'), 'sent at once, audited');
      } else {
        const first = (await submit(REVIEW_DRAFT)).lines.find((l) => l.event === 'task-draft');
        assert(first?.release_code, 'the draft is held for release');
        const edited = (await submit(REVIEW_TEXT)).lines.find((l) => l.event === 'task-draft');
        assert(edited?.release_code && edited.release_code !== first.release_code, 'the edit is a new draft with a new code');
        assert(!johnL.lines.some(task(taskId, 'artifact')), 'nothing reached john before the release');
        const stale = await rdv(['task', 'release', taskId, '--code', first.release_code], dirs.omer, { check: false });
        assert(stale.code === 1 && stale.stderr.includes('not the one you reviewed'), `the first draft's code sends nothing (${stale.stderr})`);
        const rel = await rdv(['task', 'release', taskId, '--code', edited.release_code], dirs.omer, { timeoutMs: timeout });
        assert(rel.lines.some((l) => l.kind === 'artifact' && l.task === taskId) && rel.lines.some((l) => l.kind === 'completed'), 'released and completed');
      }
      const a = await johnL.waitFor(task(taskId, 'artifact'), 'john receives the review', timeout);
      assert(a.peer_text?.[0] === REVIEW_TEXT, `john sees the edited review as peer text (${JSON.stringify(a.peer_text)})`);
      assert(a.data?.[0]?.rdv === 'request/data' && a.data[0].data?.verdict === 'changes-requested' && a.data[0].data?.comments === 3, `the review/result data arrives (${JSON.stringify(a.data)})`);
      await johnL.waitFor(task(taskId, 'completed'), 'john sees it completed', timeout);
      return a;
    });
    return { ...(await finish('completed', 'completed')), artifact };

    async function finish(omerState: string, johnState: string): Promise<ReviewScenarioResult> {
      const [o, j] = await step(`both end ${omerState}`, async () => {
        const deadline = Date.now() + timeout;
        for (;;) {
          const o = await listed('omer', taskId);
          const j = await listed('john', taskId);
          if ((o?.state === omerState && j?.state === johnState) || Date.now() > deadline) return [o, j];
          await new Promise((r) => setTimeout(r, 250));
        }
      });
      assert(o?.state === omerState && j?.state === johnState, `omer ${o?.state} (want ${omerState}), john ${j?.state} (want ${johnState})`);
      const audit = await auditOf(dirs.omer, john);
      if (variant !== 'ok' && variant !== 'auto') assert(fetchedFrom(sha) === 0, 'the store served nothing');
      return { variant, taskId, omer: o.state, john: j.state, audit, fetched: fetchedFrom(sha), steps };
    }
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
    await store?.close();
    if (!opts.keepDirs) rmSync(root, { recursive: true, force: true });
  }
}

/** Omer's audit lines for John (`rdv audit --contact`). */
async function auditOf(home: string, peer: string): Promise<Line[]> {
  return (await rdv(['audit', '--contact', peer], home)).lines.filter((l) => l.gate !== undefined);
}

// `node dist/scenarios/review.js --relay ws://… --variant ok`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { relay: { type: 'string', multiple: true }, variant: { type: 'string' }, timeout: { type: 'string' }, keep: { type: 'boolean' } },
  });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  const v = values.variant ?? 'ok';
  const variants = v === 'all' ? [...REVIEW_VARIANTS] : [v];
  if (relays.length === 0 || variants.some((x) => !REVIEW_VARIANTS.includes(x as ReviewVariant))) {
    console.error(`usage: node dist/scenarios/review.js --relay ws://… [--variant ${REVIEW_VARIANTS.join('|')}|all] [--timeout ms] [--keep]`);
    process.exit(2);
  }
  (async () => {
    for (const variant of variants as ReviewVariant[]) {
      const t0 = Date.now();
      const r = await runReviewScenario({ relays, variant, stepTimeoutMs: values.timeout ? Number(values.timeout) : 30_000, keepDirs: values.keep, log: (l) => console.log(l) });
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS review ${variant} on ${relays.join(', ')} in ${Date.now() - t0} ms: omer ${r.omer}, john ${r.john}`);
    }
  })().then(
    () => process.exit(0),
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}
