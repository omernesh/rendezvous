// Tasks in a group between `rdv` processes (SPEC §7.8.4, issue #79): what a
// member may be asked is its group terms. An unapproved newcomer invokes
// nothing; the terms' max-frequency counts every member; narrowing them takes
// effect at once, on a task already waiting; taking a task back unassigns it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_URI } from '@rendezvous/a2a';
import type { AgentState } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Line, Listener, rdv, until } from '../scenarios/harness.js';

const T = 20_000;
let root: string;
let relay: TestRelay;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rdv-grouptasks-'));
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

it('group terms decide what members may ask; an unapproved newcomer asks nothing; unassign takes a task back', async () => {
  const who = ['omer', 'john', 'dana'] as const;
  type Who = (typeof who)[number];
  const homes = Object.fromEntries(who.map((w) => [w, join(root, w)])) as Record<Who, string>;
  const state = (w: Who) => JSON.parse(readFileSync(join(homes[w], 'agent.json'), 'utf8')) as AgentState;
  for (const w of who) await rdv(['init', '--profile', w, '--email', `${w}@example.com`, '--relay', relay.url], homes[w]);
  const ids = Object.fromEntries(who.map((w) => [w, state(w).card.id])) as Record<Who, string>;
  const L = Object.fromEntries(who.map((w) => [w, new Listener(w, homes[w])])) as Record<Who, Listener>;
  const posted = async (args: string[], home: string) => (await rdv(['group', 'request', ...args], home)).lines.find((l) => l.event === 'group-task-posted')!.task as string;
  const board = async (w: Who, g: string, task: string) => ((await rdv(['group', 'board', g], homes[w])).lines[0].tasks as Line[]).find((t) => t.task === task);
  try {
    for (const w of who) await L[w].waitFor((x) => x.event === 'ready', `${w} ready`, T);
    for (const w of ['john', 'dana'] as const) {
      const card = join(root, `${w}-card.json`);
      writeFileSync(card, JSON.stringify(state(w).card));
      await rdv(['contact', 'request', card], homes.omer);
      const req = await L[w].waitFor((x) => x.event === 'request', `${w}: request`, T);
      await rdv(['contact', 'grant', req.id], homes[w]);
      await L.omer.waitFor((x) => x.event === 'contact' && x.peer === ids[w], `omer: ${w}`, T);
    }
    const g = (await rdv(['group', 'create', 'Terms'], homes.omer)).lines[0].group as string;
    const join_ = async (w: Who, terms: string[]) => {
      await rdv(['group', 'invite', g, ids[w]], homes.omer);
      const inv = await L[w].waitFor((x) => x.event === 'group-invite', `${w}: invite`, T);
      const code = (await rdv(['group', 'pending'], homes[w])).lines.find((l) => l.event === 'group-invite')!.code;
      await rdv(['group', 'join', inv.invite, '--code', code, ...terms], homes[w]);
      await L[w].waitFor((x) => x.event === 'group-state' && x.admitted === true, `${w}: admitted`, T);
    };
    await join_('john', ['--invoke', REQUEST_URI, '--max-frequency', '1/day', '--newcomers', 'trust-admin']);
    await join_('dana', ['--invoke', REQUEST_URI]); // ask: John waits for her human, who never approves him here
    await until(async () => (who.every((w) => Object.keys(state(w).groups?.groups[g]?.joins ?? {}).length === 3) ? true : undefined), 'all joins', T);

    // John (trust-admin sends to Dana) asks Dana for something: her agent refuses it (scope), never asking her human.
    const fromJohn = await posted([g, '--text', 'Pick a font', '--assignee', ids.dana], homes.john);
    const refused = await L.dana.waitFor((l) => l.event === 'task' && l.group === g && l.task === fromJohn && l.kind === 'refused', 'dana: refused', T);
    expect(refused.code).toBe('scope');
    expect(L.dana.lines.some((l) => l.event === 'task' && l.task === fromJohn && l.kind === 'start-needed')).toBe(false);
    await until(async () => ((await board('omer', g, fromJohn))?.state === 'rejected' ? true : undefined), "omer's board: rejected", T);

    // John's terms: 1 a day, all members together. Omer's first waits for John's human; the second is refused (rate).
    const first = await posted([g, '--text', 'Write the FAQ', '--assignee', ids.john], homes.omer);
    await L.john.waitFor((l) => l.event === 'task' && l.task === first && l.kind === 'start-needed', 'john: first waits', T);
    const second = await posted([g, '--text', 'And the footer', '--assignee', ids.john], homes.omer);
    const rate = await L.john.waitFor((l) => l.event === 'task' && l.task === second && l.kind === 'refused', 'john: second refused', T);
    expect(rate.code).toBe('rate');
    await until(async () => ((await board('omer', g, second))?.state === 'rejected' ? true : undefined), "omer's board: the second rejected", T);

    // John's human narrows his terms: the task already waiting can no longer start, and Omer's agent sees the new terms.
    await rdv(['group', 'terms', g], homes.john);
    const listed = (await rdv(['task', 'list'], homes.john)).lines.find((l) => l.event === 'task' && l.id === first)!;
    await rdv(['task', 'approve', first, '--group', g, '--code', listed.start_code], homes.john);
    await until(async () => ((await board('omer', g, first))?.state === 'rejected' ? true : undefined), "omer's board: the first ends (scope)", T);
    await until(async () => (Object.keys(state('omer').groups!.groups[g].joins[ids.john].scope.invoke ?? {}).length === 0 ? true : undefined), "omer holds john's new terms", T);
    const refusedLocally = await rdv(['group', 'request', g, '--text', 'x', '--assignee', ids.john], homes.omer, { check: false });
    expect(refusedLocally.code).not.toBe(0);
    expect(refusedLocally.stderr).toContain('do not let members ask them');

    // Omer puts an open task up, Dana claims it, Omer assigns it to her, then takes it back: Dana's agent forgets it.
    const open = await posted([g, '--text', 'Pick the colors'], homes.omer);
    await L.dana.waitFor((l) => l.event === 'group-task' && l.task === open && l.kind === 'posted', 'dana: open task', T);
    await rdv(['group', 'claim', g, open], homes.dana);
    await L.omer.waitFor((l) => l.event === 'group-task' && l.task === open && l.kind === 'claimed', 'omer: claimed', T);
    await rdv(['group', 'assign', g, open, ids.dana], homes.omer);
    await L.dana.waitFor((l) => l.event === 'task' && l.task === open && l.kind === 'start-needed', 'dana: start gate', T);
    await rdv(['group', 'unassign', g, open], homes.omer);
    const gone = await L.dana.waitFor((l) => l.event === 'task' && l.task === open && l.kind === 'canceled', 'dana: no longer hers', T);
    expect(gone.reason).toContain('no longer yours');
    expect((await rdv(['task', 'list'], homes.dana)).lines.some((l) => l.id === open)).toBe(false);
    expect((await board('dana', g, open))?.assignee).toBeUndefined();
    // Only the requester cancels; Omer does.
    expect((await rdv(['group', 'cancel', g, open], homes.dana, { check: false })).code).not.toBe(0);
    await rdv(['group', 'cancel', g, open], homes.omer);
    await until(async () => ((await board('dana', g, open))?.state === 'canceled' ? true : undefined), "dana's board: canceled", T);
  } finally {
    await Promise.all(who.map((w) => L[w].stop()));
  }
}, 180_000);
