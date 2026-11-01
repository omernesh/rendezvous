// Contact nicknames (`rdv contact alias`) and the agent's own name
// (`rdv agent-name`, `rdv init --agent-name`), NOTES 103, with real `rdv`
// processes on the in-memory relay.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';

describe('rdv contact alias and rdv agent-name', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-nick-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('names a contact, resolves the name (also as "X\'s agent"), refuses a taken one, and names our own agent on its card', async () => {
    const johnHome = join(root, 'john');
    const danaHome = join(root, 'dana');
    const omerHome = join(root, 'omer');
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url, '--public-pointer', '--agent-name', ' Sammie '], johnHome);
    await rdv(['card', 'publish'], johnHome);
    await rdv(['init', '--profile', 'dana', '--email', 'dana@example.com', '--relay', relay.url, '--public-pointer'], danaHome);
    await rdv(['card', 'publish'], danaHome);
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    const who = (await rdv(['whoami'], johnHome)).lines[0];
    expect(who.agent_name).toBe('Sammie');
    expect(who.card.agent_name).toBe('Sammie');
    const johnId = who.id as string;
    const danaId = (await rdv(['whoami'], danaHome)).lines[0].id as string;
    expect((await rdv(['init', '--profile', 'x', '--agent-name', 'a\u0007b'], join(root, 'bad'), { check: false })).code).toBe(2);

    const johnL = new Listener('john', johnHome, ['--auto-grant', 'stranger']);
    const danaL = new Listener('dana', danaHome, ['--auto-grant', 'stranger']);
    const omerL = new Listener('omer', omerHome);
    try {
      for (const l of [johnL, danaL, omerL]) await l.waitFor((x) => x.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', johnId], omerHome);
      await omerL.waitFor((l) => l.event === 'contact' && l.peer === johnId, 'john', 10_000);
      await rdv(['contact', 'request', danaId], omerHome);
      await omerL.waitFor((l) => l.event === 'contact' && l.peer === danaId, 'dana', 10_000);

      // A card looked up shows what its agent calls itself only as peer text, beside the card as signed (re-review L3).
      const looked = (await rdv(['lookup', johnId], omerHome)).lines[0];
      expect(looked.calls_itself).toEqual({ untrusted_peer_text: 'Sammie' });
      expect((await rdv(['lookup', 'john@doe.com'], omerHome)).lines[0].calls_itself).toEqual({ untrusted_peer_text: 'Sammie' });

      const added = await rdv(['contact', 'alias', 'add', johnId, 'Ran'], omerHome);
      expect(added.lines[0]).toMatchObject({ event: 'alias-added', peer: johnId, aliases: ['Ran'], calls_itself: { untrusted_peer_text: 'Sammie' } });
      // Unique across contacts, valid like a label, at most 64 characters.
      const taken = await rdv(['contact', 'alias', 'add', danaId, 'ran'], omerHome, { check: false });
      expect(taken.code).toBe(2);
      expect(taken.stderr).toMatch(/already the name of another contact/);
      expect((await rdv(['contact', 'alias', 'add', danaId, 'x'.repeat(65)], omerHome, { check: false })).code).toBe(2);
      expect((await rdv(['contact', 'alias', 'remove', danaId, 'nope'], omerHome, { check: false })).stderr).toMatch(/no nickname/);

      const list = await rdv(['contact', 'alias', 'list'], omerHome);
      expect(list.lines.find((l) => l.peer === johnId)).toMatchObject({ aliases: ['Ran'] });
      const contacts = (await rdv(['contact', 'list'], omerHome)).lines;
      expect(contacts.find((l) => l.peer === johnId)).toMatchObject({ aliases: ['Ran'], calls_itself: { untrusted_peer_text: 'Sammie' } });
      expect(contacts.find((l) => l.peer === danaId)?.aliases).toBeUndefined();

      // The name resolves wherever a contact is named; what the agent calls itself does not.
      expect((await rdv(['audit', '--contact', "Ran's agent"], omerHome)).code).toBe(0);
      expect((await rdv(['audit', '--contact', 'agent of ran'], omerHome)).code).toBe(0);
      const claimed = await rdv(['audit', '--contact', 'Sammie'], omerHome, { check: false });
      expect(claimed.code).not.toBe(0);
      expect(claimed.stderr).toMatch(/no contact Sammie/);

      expect((await rdv(['contact', 'alias', 'remove', johnId, 'RAN'], omerHome)).lines[0].aliases).toBeUndefined();
      expect((await rdv(['audit', '--contact', 'Ran'], omerHome, { check: false })).code).not.toBe(0);

      // Our own agent's name: re-signed, sent to contacts.
      const set = await rdv(['agent-name', 'set', 'Sam'], johnHome);
      expect(set.lines[0]).toMatchObject({ event: 'agent-name', agent_name: 'Sam', changed: true });
      expect(set.lines[0].published.length).toBeGreaterThan(0);
      // Omer gets the new card (rdv/card-update), and still never resolves the name it claims.
      await omerL.waitFor((l) => l.event === 'card-update' && l.peer === johnId, 'the card update', 10_000);
      expect((await rdv(['agent-name', 'set', 'Sam'], johnHome)).lines[0].changed).toBe(false);
      expect((await rdv(['agent-name', 'clear'], johnHome)).lines[0].changed).toBe(true);
      expect((await rdv(['whoami'], johnHome)).lines[0].card.agent_name).toBeUndefined();

      // A command word holding a space never joins into a command name (security review H1), for any command.
      for (const args of [
        ['contact', 'alias add', johnId, 'Ran'],
        ['contact alias', 'add', johnId, 'Ran'],
        ['contact alias add', johnId, 'Ran'],
        ['contact', 'alias', 'add x', johnId],
        ['agent-name set', 'Sammie'],
        ['contact label', johnId, 'Ran'],
        ['contact', 'label ', johnId, 'Ran'],
        ['contact grant', johnId],
        ['contact confirm', 'g1'],
        ['contact pending'],
        ['contact auto-approve', johnId, 'off'],
        ['Contact', 'list'],
        [' whoami'],
      ]) {
        const r = await rdv(args, omerHome, { check: false });
        expect(r.code, args.join('|')).toBe(2);
      }
      expect((await rdv(['contact', 'alias', 'list'], omerHome)).lines.find((l) => l.peer === johnId)?.aliases).toBeUndefined();

      // Object's own properties are no commands (re-review L5).
      for (const w of ['constructor', 'toString', 'hasOwnProperty']) expect((await rdv([w], omerHome, { check: false })).stderr, w).toMatch(/unknown command/);

      const sub = await rdv(['contact', 'alias'], omerHome, { check: false });
      expect(sub.code).toBe(2);
      expect(sub.stderr).toMatch(/contact alias add/);
    } finally {
      await Promise.all([johnL.stop(), danaL.stop(), omerL.stop()]);
    }
  }, 90_000);
});
