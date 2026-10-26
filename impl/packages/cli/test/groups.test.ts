// `rdv group …` on real `rdv` processes and the in-memory relay (SPEC §7.8,
// issue #77): Omer creates a group, invites John and Dana, both humans join
// with the code `rdv group pending` shows, Dana approves John (not her
// contact), and the three homes hold the same state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUEST_URI } from '@rendezvous/a2a';
import { type AgentState, docHash } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv, until } from '../scenarios/harness.js';

const T = 20_000;
let root: string;
let relay: TestRelay;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rdv-groups-'));
  relay = await startTestRelay();
});
afterAll(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});
const state = (home: string) => JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8')) as AgentState;
const group = (home: string, id: string) => state(home).groups?.groups[id];

describe('rdv group between rdv processes', () => {
  it('Omer creates a group, invites John and Dana, both humans join, and the state converges', async () => {
    const homes = { omer: join(root, 'omer'), john: join(root, 'john'), dana: join(root, 'dana') };
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], homes.omer);
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url], homes.john);
    await rdv(['init', '--profile', 'dana', '--email', 'dana@example.com', '--relay', relay.url], homes.dana);
    const ids = { omer: state(homes.omer).card.id, john: state(homes.john).card.id, dana: state(homes.dana).card.id };
    // John and Dana grant Omer's requests (the demo flag); John and Dana never meet.
    const omerL = new Listener('omer', homes.omer);
    const johnL = new Listener('john', homes.john, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    const danaL = new Listener('dana', homes.dana, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    try {
      for (const l of [omerL, johnL, danaL]) await l.waitFor((x) => x.event === 'ready', `${l.name} ready`, T);
      for (const who of ['john', 'dana'] as const) {
        const card = join(root, `${who}-card.json`);
        writeFileSync(card, JSON.stringify(state(homes[who]).card));
        await rdv(['contact', 'request', card, '--greeting', 'hi'], homes.omer);
        await omerL.waitFor((x) => x.event === 'contact' && x.peer === ids[who], `omer: ${who} is a contact`, T);
      }

      const created = (await rdv(['group', 'create', 'Microsite launch'], homes.omer)).lines[0];
      expect(created).toMatchObject({ event: 'group-created', name: 'Microsite launch', epoch: 0 });
      const g = created.group as string;

      // Inviting someone who is not a contact is refused.
      const eve = (await rdv(['group', 'invite', g, 'rdv1:' + 'a'.repeat(52)], homes.omer, { check: false }));
      expect(eve.code).not.toBe(0);

      // John: the invite waits for his human; a wrong code joins nothing; the code from "pending" does.
      await rdv(['group', 'invite', g, ids.john, '--name', 'John', '--greeting', 'help with the microsite?'], homes.omer);
      const inv = await johnL.waitFor((x) => x.event === 'group-invite', 'john: the invite', T);
      expect(inv).toMatchObject({ group: g, from: ids.omer, name: 'Microsite launch', greeting: 'help with the microsite?' });
      expect(inv.members).toEqual([expect.objectContaining({ id: ids.omer, role: 'admin', contact: true })]);
      const wrong = await rdv(['group', 'join', inv.invite, '--code', '000000000000'], homes.john, { check: false });
      expect(wrong.code).not.toBe(0);
      expect(wrong.stderr).toContain('not the invite you read');
      expect(group(homes.john, g)).toBeUndefined();
      const listed = (await rdv(['group', 'list'], homes.john)).lines;
      expect(listed.find((l) => l.event === 'group-invite')?.code).toBeUndefined(); // list shows no codes
      const pending = (await rdv(['group', 'pending'], homes.john)).lines.find((l) => l.event === 'group-invite')!;
      await rdv(['group', 'join', inv.invite, '--code', pending.code, '--invoke', REQUEST_URI, '--newcomers', 'trust-admin'], homes.john);
      await johnL.waitFor((x) => x.event === 'group-state' && x.admitted === true, 'john: admitted', T);
      await omerL.waitFor((x) => x.event === 'group-state' && x.added?.includes(ids.john), 'omer: john added', T);

      // Dana: Omer is her contact, John is only named by the admin.
      await rdv(['group', 'invite', g, ids.dana, '--name', 'Dana'], homes.omer);
      const dinv = await danaL.waitFor((x) => x.event === 'group-invite', 'dana: the invite', T);
      expect(dinv.members).toEqual([
        expect.objectContaining({ id: ids.omer, contact: true }),
        expect.objectContaining({ id: ids.john, contact: false, name: 'John' }),
      ]);
      const dcode = (await rdv(['group', 'pending'], homes.dana)).lines.find((l) => l.event === 'group-invite')!.code;
      await rdv(['group', 'join', dinv.invite, '--code', dcode], homes.dana);
      const admitted = await danaL.waitFor((x) => x.event === 'group-state' && x.admitted === true, 'dana: admitted', T);
      expect(admitted.newcomers).toEqual([ids.john]); // policy ask: John is not her contact
      const johnSees = await johnL.waitFor((x) => x.event === 'group-state' && x.added?.includes(ids.dana), 'john: dana added', T);
      expect(johnSees.newcomers).toEqual([]); // trust-admin

      // Dana's human approves John, with the code for exactly him.
      const nc = (await rdv(['group', 'pending'], homes.dana)).lines.find((l) => l.event === 'group-newcomer')!;
      expect(nc).toMatchObject({ group: g, member: expect.objectContaining({ id: ids.john, contact: false, name: 'John' }) });
      expect((await rdv(['group', 'approve', g, ids.john, '--code', 'ffffffffffff'], homes.dana, { check: false })).code).not.toBe(0);
      await rdv(['group', 'approve', g, ids.john, '--code', nc.code], homes.dana);

      // Converged: every home holds the same epoch-2 state, every member's join, and has approved the others.
      await until(
        async () => (['omer', 'john', 'dana'] as const).every((w) => Object.keys(group(homes[w], g)?.joins ?? {}).length === 3) || undefined,
        'all joins everywhere',
        T,
      );
      const hashes = (['omer', 'john', 'dana'] as const).map((w) => docHash(group(homes[w], g)!.state));
      expect(new Set(hashes).size).toBe(1);
      expect(group(homes.omer, g)!.state.epoch).toBe(2);
      for (const w of ['omer', 'john', 'dana'] as const) {
        const r = group(homes[w], g)!;
        expect([...r.approved].sort()).toEqual(Object.values(ids).filter((id) => id !== ids[w]).sort());
        expect(r.newcomers).toEqual({});
      }
      expect(group(homes.dana, g)!.joins[ids.john].scope).toEqual({ invoke: { [REQUEST_URI]: {} } });
      // The shared event log has the decisions' inputs, never a code or a phrase.
      const log = readFileSync(join(homes.dana, 'events.jsonl'), 'utf8');
      expect(log).toContain('"group-invite"');
      expect(log).not.toContain(dcode);
    } finally {
      await Promise.all([omerL.stop(), johnL.stop(), danaL.stop()]);
    }
  });
});
