// Design B.5 as a scenario (issue #79, closes #31): Omer, John and Dana build
// a microsite. Three real `rdv` processes, one home each; every human step
// goes through the human's own path (the codes `rdv group pending` and `rdv
// task list` show).
//
//   1. Omer's and John's, and Omer's and Dana's, humans become contacts (John
//      and Dana never meet). Omer creates "Microsite launch".
//   2. John joins (members may ask him for request/v1; newcomers: trust-admin).
//   3. Dana joins (request/v1; newcomers: ask), and approves John, who is not
//      her contact; John's policy approves her at once.
//   4. Omer puts an open task on the board: "Draft the landing-page copy".
//   5. Dana claims it with an offer; Omer assigns it to her. Dana's start gate
//      shows the request; her human approves with the code.
//   6. Dana's draft waits at the release gate, which lists the two members it
//      goes to; she releases it: the copy reaches Omer and John (whom she only
//      knows through the group), then `completed`.
//   7. Omer puts a review for John on the board, referring to the copy. John's
//      start gate shows that its input is Dana's result ("not your contact,
//      named by the admin as Dana"); he approves, and his review reaches Omer
//      and Dana.
//   8. (The restored backup of B.5 step 8 is core's: groupmsg.test.ts, on the
//      in-memory relay.) Before he leaves, John has a task assigned (a proofread
//      he never starts) and one open request of his own (a hero image).
//   9. John leaves: Omer and Dana see his proofread reopened and his open
//      request canceled; Dana drops her channel with him (not contacts), Omer
//      keeps his; Omer issues the state without him.
//  10. Omer hands the admin role to Dana (`rdv group promote`) and leaves; Dana
//      is the group's admin.
//
//   node packages/cli/dist/scenarios/microsite.js --relay wss://… [--timeout ms] [--keep]
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REQUEST_URI } from '@rendezvous/a2a';
import type { AgentState } from '@rendezvous/core';
import { relaysFromEnv } from './contact.js';
import { assert, type Line, Listener, rdv, until } from './harness.js';

export interface MicrositeScenarioOptions {
  relays: string[];
  stepTimeoutMs?: number;
  tag?: string;
  keepDirs?: boolean;
  log?: (line: string) => void;
}

export interface MicrositeScenarioResult {
  group: string;
  copyTask: string;
  reviewTask: string;
  /** What Omer's and John's listeners received of Dana's copy, and what Omer and Dana received of John's review. */
  copy: { omer: Line; john: Line };
  review: { omer: Line; dana: Line };
  /** Each member's board at the end (as `rdv group board` shows it). */
  boards: Record<'omer' | 'dana', Line>;
  steps: Array<{ step: string; ms: number }>;
}

export const COPY_TASK = 'Draft the landing-page copy';
export const CLAIM_TEXT = 'I can do it today.';
export const COPY_TEXT = 'Rendezvous: your agent meets theirs. Find people by email, ask first, talk end to end encrypted.';
export const REVIEW_TASK = 'Review the landing-page copy';
export const REVIEW_TEXT = 'Reads well. Say "end-to-end" with hyphens, and lead with the consent step.';

export async function runMicrositeScenario(opts: MicrositeScenarioOptions): Promise<MicrositeScenarioResult> {
  if (opts.relays.length === 0) throw new Error('no relays given');
  const timeout = opts.stepTimeoutMs ?? 20_000;
  const log = opts.log ?? (() => {});
  const tag = opts.tag ?? randomBytes(4).toString('hex');
  const root = mkdtempSync(join(tmpdir(), 'rdv-microsite-'));
  const who = ['omer', 'john', 'dana'] as const;
  type Who = (typeof who)[number];
  const dirs = Object.fromEntries(who.map((w) => [w, join(root, w)])) as Record<Who, string>;
  const relayArgs = opts.relays.flatMap((r) => ['--relay', r]);
  const listeners: Listener[] = [];
  const steps: MicrositeScenarioResult['steps'] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    log(`- ${name}`);
    const r = await fn();
    steps.push({ step: name, ms: Date.now() - t0 });
    return r;
  };
  const state = (w: Who) => JSON.parse(readFileSync(join(dirs[w], 'agent.json'), 'utf8')) as AgentState;
  const record = (w: Who, g: string) => state(w).groups?.groups[g];
  const boardEvent = (task: string, kind: string, extra: (l: Line) => boolean = () => true) => (l: Line) => l.event === 'group-task' && l.task === task && l.kind === kind && extra(l);
  const listedTask = async (w: Who, id: string) => (await rdv(['task', 'list'], dirs[w])).lines.find((l) => l.event === 'task' && l.id === id && l.group);

  try {
    const ids = await step('init three agents', async () => {
      await rdv(['init', '--profile', 'omer', '--email', `omer+${tag}@example.com`, ...relayArgs], dirs.omer);
      await rdv(['init', '--profile', 'john', '--email', `john+${tag}@doe.com`, ...relayArgs], dirs.john);
      await rdv(['init', '--profile', 'dana', '--email', `dana+${tag}@example.com`, ...relayArgs], dirs.dana);
      return Object.fromEntries(who.map((w) => [w, state(w).card.id])) as Record<Who, string>;
    });
    const L = await step('start listeners', async () => {
      const out = {} as Record<Who, Listener>;
      for (const w of who) {
        const l = new Listener(w, dirs[w]);
        listeners.push(l);
        out[w] = l;
      }
      for (const w of who) await out[w].waitFor((x) => x.event === 'ready', `${w} ready`, timeout);
      return out;
    });

    await step("omer becomes john's and dana's contact (each human grants); john and dana never meet", async () => {
      for (const w of ['john', 'dana'] as const) {
        const card = join(root, `${w}-card.json`);
        writeFileSync(card, JSON.stringify(state(w).card));
        await rdv(['contact', 'request', card, '--greeting', `Omer here, about the microsite (${tag}).`], dirs.omer, { timeoutMs: timeout });
        const req = await L[w].waitFor((x) => x.event === 'request' && x.from === ids.omer, `${w} sees omer's request`, timeout);
        await rdv(['contact', 'grant', req.id, '--label', 'Omer'], dirs[w], { timeoutMs: timeout });
        await L.omer.waitFor((x) => x.event === 'contact' && x.peer === ids[w], `omer: ${w} is a contact`, timeout);
      }
    });

    const group = await step('1. omer creates the group', async () => {
      const created = (await rdv(['group', 'create', 'Microsite launch'], dirs.omer)).lines[0];
      assert(created?.event === 'group-created' && created.epoch === 0, `created (${JSON.stringify(created)})`);
      return created.group as string;
    });

    await step('2. john joins: members may ask him for request/v1; newcomers trust-admin', async () => {
      await rdv(['group', 'invite', group, ids.john, '--name', 'John', '--greeting', 'Help with the microsite?'], dirs.omer, { timeoutMs: timeout });
      const inv = await L.john.waitFor((x) => x.event === 'group-invite' && x.group === group, 'john: the invite', timeout);
      const code = (await rdv(['group', 'pending'], dirs.john)).lines.find((l) => l.event === 'group-invite' && l.invite === inv.invite)?.code;
      assert(code, 'john: pending shows the code');
      await rdv(['group', 'join', inv.invite, '--code', code, '--invoke', REQUEST_URI, '--newcomers', 'trust-admin'], dirs.john, { timeoutMs: timeout });
      await L.john.waitFor((x) => x.event === 'group-state' && x.group === group && x.admitted === true, 'john: admitted', timeout);
    });

    await step("3. dana joins (request/v1, newcomers ask) and approves john, who is not her contact", async () => {
      await rdv(['group', 'invite', group, ids.dana, '--name', 'Dana'], dirs.omer, { timeoutMs: timeout });
      const inv = await L.dana.waitFor((x) => x.event === 'group-invite' && x.group === group, 'dana: the invite', timeout);
      const john = (inv.members as Line[]).find((m) => m.id === ids.john);
      assert(john && john.contact === false && john.name === 'John', `the invite shows john as not her contact, named by the admin (${JSON.stringify(john)})`);
      const code = (await rdv(['group', 'pending'], dirs.dana)).lines.find((l) => l.event === 'group-invite' && l.invite === inv.invite)?.code;
      await rdv(['group', 'join', inv.invite, '--code', code, '--invoke', REQUEST_URI], dirs.dana, { timeoutMs: timeout });
      const admitted = await L.dana.waitFor((x) => x.event === 'group-state' && x.group === group && x.admitted === true, 'dana: admitted', timeout);
      assert(JSON.stringify(admitted.newcomers) === JSON.stringify([ids.john]), `john waits for dana's human (${JSON.stringify(admitted.newcomers)})`);
      const nc = (await rdv(['group', 'pending'], dirs.dana)).lines.find((l) => l.event === 'group-newcomer' && l.member?.id === ids.john);
      await rdv(['group', 'approve', group, ids.john, '--code', nc!.code], dirs.dana);
      await L.john.waitFor((x) => x.event === 'group-state' && x.group === group && x.added?.includes(ids.dana), 'john: dana added (trust-admin)', timeout);
      await until(async () => (who.every((w) => Object.keys(record(w, group)?.joins ?? {}).length === 3) ? true : undefined), 'every member holds every join', timeout);
    });

    const copyTask = await step('4. omer puts an open task on the board', async () => {
      const posted = (await rdv(['group', 'request', group, '--text', COPY_TASK], dirs.omer, { timeoutMs: timeout })).lines.find((l) => l.event === 'group-task-posted');
      assert(posted?.task, `posted (${JSON.stringify(posted)})`);
      for (const w of ['john', 'dana'] as const) {
        const seen = await L[w].waitFor(boardEvent(posted.task, 'posted'), `${w}: the open task`, timeout);
        assert(seen.requester === ids.omer && seen.peer_text?.[0] === COPY_TASK && !seen.assignee, `${w} sees it open (${JSON.stringify(seen)})`);
      }
      return posted.task as string;
    });

    await step("5. dana claims it; omer assigns it to her; dana's human approves the start", async () => {
      await rdv(['group', 'claim', group, copyTask, '--text', CLAIM_TEXT], dirs.dana, { timeoutMs: timeout });
      const claim = await L.omer.waitFor(boardEvent(copyTask, 'claimed'), 'omer: dana claims it', timeout);
      assert(claim.from === ids.dana && claim.peer_text?.[0] === CLAIM_TEXT, `the offer (${JSON.stringify(claim)})`);
      // John cannot assign Omer's task: his own board refuses it, so nothing is sent.
      const john = await rdv(['group', 'assign', group, copyTask, ids.dana], dirs.john, { check: false });
      assert(john.code !== 0 && /only the requester assigns/.test(john.stderr), `john may not assign omer's task (${john.stderr})`);
      await rdv(['group', 'assign', group, copyTask, ids.dana], dirs.omer, { timeoutMs: timeout });
      await L.dana.waitFor((l) => l.event === 'task' && l.group === group && l.task === copyTask && l.kind === 'start-needed', "dana: the start gate", timeout);
      await L.john.waitFor(boardEvent(copyTask, 'assigned', (l) => l.assignee === ids.dana), 'john: assigned to dana', timeout);
      const listed = await listedTask('dana', copyTask);
      assert(listed?.start_code && listed.in_group?.requester?.id === ids.omer && listed.in_group.requester.contact === true, `dana's list shows the gate and who asks (${JSON.stringify(listed)})`);
      const wrong = await rdv(['task', 'approve', copyTask, '--group', group, '--code', '000000000000'], dirs.dana, { check: false });
      assert(wrong.code !== 0, 'a wrong code starts nothing');
      await rdv(['task', 'approve', copyTask, '--group', group, '--code', listed.start_code], dirs.dana, { timeoutMs: timeout });
      await L.omer.waitFor(boardEvent(copyTask, 'status', (l) => l.state === 'working' && l.from === ids.dana), 'omer: dana is working', timeout);
    });

    const copy = await step("6. dana's draft waits at the release gate; she releases it to omer and john", async () => {
      const draft = (await rdv(['task', 'submit', copyTask, '--group', group, '--text', COPY_TEXT, '--name', 'landing copy', '--complete'], dirs.dana)).lines.find((l) => l.event === 'task-draft');
      assert(draft?.release_code, `held (${JSON.stringify(draft)})`);
      const listed = await listedTask('dana', copyTask);
      const to = (listed?.in_group?.release_to ?? []) as Line[];
      assert(to.map((m) => m.id).sort().join() === [ids.omer, ids.john].sort().join(), `the gate lists who it goes to (${JSON.stringify(to)})`);
      assert(to.find((m) => m.id === ids.john)?.contact === false, 'john is shown as not her contact');
      assert(!L.omer.lines.some(boardEvent(copyTask, 'artifact')), 'nothing left before the release');
      await rdv(['task', 'release', copyTask, '--group', group, '--code', draft.release_code], dirs.dana, { timeoutMs: timeout });
      const got = {} as { omer: Line; john: Line };
      for (const w of ['omer', 'john'] as const) {
        got[w] = await L[w].waitFor(boardEvent(copyTask, 'artifact'), `${w}: dana's copy`, timeout);
        assert(got[w].from === ids.dana && got[w].peer_text?.[0] === COPY_TEXT, `${w} gets the copy as peer text (${JSON.stringify(got[w])})`);
        await L[w].waitFor(boardEvent(copyTask, 'status', (l) => l.state === 'completed'), `${w}: completed`, timeout);
      }
      return got;
    });

    const reviewTask = await step("7. omer puts a review for john on the board; john's gate shows dana's result as its input", async () => {
      const posted = (await rdv(['group', 'request', group, '--text', REVIEW_TASK, '--assignee', ids.john, '--ref', copyTask], dirs.omer, { timeoutMs: timeout })).lines.find((l) => l.event === 'group-task-posted');
      const id = posted!.task as string;
      await L.john.waitFor((l) => l.event === 'task' && l.group === group && l.task === id && l.kind === 'start-needed', 'john: the start gate', timeout);
      const listed = await listedTask('john', id);
      const ref = listed?.in_group?.refs?.[0];
      assert(ref?.task === copyTask && ref.assignee?.id === ids.dana && ref.assignee.contact === false && ref.assignee.name === 'Dana', `the gate shows the input is dana's (${JSON.stringify(ref)})`);
      assert(ref.artifacts?.[0]?.text === COPY_TEXT, 'and her result');
      await rdv(['task', 'approve', id, '--group', group, '--code', listed!.start_code], dirs.john, { timeoutMs: timeout });
      const draft = (await rdv(['task', 'submit', id, '--group', group, '--text', REVIEW_TEXT, '--complete'], dirs.john)).lines.find((l) => l.event === 'task-draft');
      await rdv(['task', 'release', id, '--group', group, '--code', draft!.release_code], dirs.john, { timeoutMs: timeout });
      return id;
    });
    const review = {} as { omer: Line; dana: Line };
    for (const w of ['omer', 'dana'] as const) {
      review[w] = await L[w].waitFor(boardEvent(reviewTask, 'artifact'), `${w}: john's review`, timeout);
      assert(review[w].peer_text?.[0] === REVIEW_TEXT, `${w} gets the review (${JSON.stringify(review[w])})`);
    }

    const [proofread, hero] = await step('8. john has a proofread assigned and an open request of his own', async () => {
      const p = (await rdv(['group', 'request', group, '--text', 'Proofread the FAQ', '--assignee', ids.john], dirs.omer, { timeoutMs: timeout })).lines.find((l) => l.event === 'group-task-posted')!.task as string;
      await L.john.waitFor((l) => l.event === 'task' && l.group === group && l.task === p && l.kind === 'start-needed', 'john: the proofread waits for him', timeout);
      const h = (await rdv(['group', 'request', group, '--text', 'Pick a hero image'], dirs.john, { timeoutMs: timeout })).lines.find((l) => l.event === 'group-task-posted')!.task as string;
      for (const w of ['omer', 'dana'] as const) await L[w].waitFor(boardEvent(h, 'posted'), `${w}: john's open request`, timeout);
      return [p, h];
    });

    await step("9. john leaves: his proofread reopens, his open request is canceled; dana drops their channel, omer keeps his", async () => {
      await rdv(['group', 'leave', group], dirs.john, { timeoutMs: timeout });
      for (const w of ['omer', 'dana'] as const) {
        await L[w].waitFor(boardEvent(proofread, 'reopened'), `${w}: the proofread is open again`, timeout);
        await L[w].waitFor(boardEvent(hero, 'canceled'), `${w}: john's open request is canceled`, timeout);
      }
      await L.dana.waitFor((x) => x.event === 'group-state' && x.group === group && x.removed?.includes(ids.john), 'dana: john removed', timeout);
      assert(state('dana').channels[ids.john] === undefined, 'dana dropped her channel with john');
      assert(state('omer').channels[ids.john] !== undefined, 'omer keeps his (a contact)');
      assert(record('omer', group)!.state.members.every((m) => m.id !== ids.john), "omer's state no longer lists john");
    });

    await step('10. omer hands the admin role to dana and leaves; dana is admin', async () => {
      const early = await rdv(['group', 'leave', group], dirs.omer, { check: false });
      assert(early.code !== 0 && /last admin/.test(early.stderr), `the last admin cannot leave first (${early.stderr})`);
      await rdv(['group', 'promote', group, ids.dana], dirs.omer, { timeoutMs: timeout });
      await until(async () => (record('dana', group)?.state.members.find((m) => m.id === ids.dana)?.role === 'admin' ? true : undefined), 'dana: she is an admin', timeout);
      await rdv(['group', 'leave', group], dirs.omer, { timeoutMs: timeout });
      await until(async () => (record('dana', group)?.state.members.map((m) => m.id).join() === ids.dana ? true : undefined), "dana: the state without omer, which she issued", timeout);
    });

    const boards = {} as Record<'omer' | 'dana', Line>;
    for (const w of ['omer', 'dana'] as const) boards[w] = (await rdv(['group', 'board', group], dirs[w])).lines[0];
    return { group, copyTask, reviewTask, copy, review, boards, steps };
  } finally {
    await Promise.all(listeners.map((l) => l.stop()));
    if (!opts.keepDirs) rmSync(root, { recursive: true, force: true });
  }
}

// `node dist/scenarios/microsite.js --relay wss://…`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { relay: { type: 'string', multiple: true }, timeout: { type: 'string' }, keep: { type: 'boolean' } } });
  const relays = values.relay?.length ? values.relay : relaysFromEnv();
  if (relays.length === 0) {
    console.error('usage: node dist/scenarios/microsite.js --relay wss://… [--relay …] [--timeout ms] [--keep]');
    process.exit(2);
  }
  const t0 = Date.now();
  runMicrositeScenario({ relays, stepTimeoutMs: values.timeout ? Number(values.timeout) : 45_000, keepDirs: values.keep, log: (l) => console.log(l) }).then(
    (r) => {
      for (const s of r.steps) console.log(`  ok  ${s.step} (${s.ms} ms)`);
      console.log(`PASS microsite on ${relays.join(', ')} in ${Date.now() - t0} ms: group ${r.group}, copy ${r.copyTask}, review ${r.reviewTask}`);
      process.exit(0);
    },
    (err: Error) => {
      console.error(`FAIL ${err.message}`);
      process.exit(1);
    },
  );
}
