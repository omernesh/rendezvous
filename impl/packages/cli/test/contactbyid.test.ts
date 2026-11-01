// Contact by a pasted agent ID alone (issue #62, NOTES 83), with real `rdv`
// processes on the in-memory relay.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKey, idtopic } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';

describe('rdv contact request <rdv1:…> with no prior lookup', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-byid-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches the card by ID, the peer grants, and they exchange a message', async () => {
    const johnHome = join(root, 'john');
    const omerHome = join(root, 'omer');
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url, '--public-pointer'], johnHome);
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    const johnId = (await rdv(['whoami'], johnHome)).lines[0].id as string;

    const pub = await rdv(['card', 'publish'], johnHome);
    expect(pub.lines[0].topics).toHaveLength(2);
    expect(pub.lines[0].topics[1]).toBe(idtopic(johnId));

    const johnL = new Listener('john', johnHome, ['--auto-grant', 'stranger']);
    const omerL = new Listener('omer', omerHome);
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      // Nothing cached: Omer only has the ID John pasted him (in any case, with stray space).
      expect(existsSync(join(omerHome, 'cards.json')) && JSON.parse(readFileSync(join(omerHome, 'cards.json'), 'utf8'))[johnId]).toBeFalsy();
      const pasted = ` rdv1:${johnId.slice(5).toUpperCase()} `;
      const req = await rdv(['contact', 'request', pasted, '--greeting', 'hi by ID'], omerHome);
      expect(req.lines[0]).toMatchObject({ event: 'request-sent', to: johnId, via: 'card', binding: 'claimed', fetched: true });
      expect(req.lines[0].label).toBeUndefined(); // a contact made by ID has no local_label
      expect(JSON.parse(readFileSync(join(omerHome, 'cards.json'), 'utf8'))[johnId].id).toBe(johnId);

      await johnL.waitFor((l) => l.event === 'contact', 'john grants', 10_000);
      await omerL.waitFor((l) => l.event === 'contact' && l.peer === johnId, 'omer contact', 10_000);
      await rdv(['send', johnId, '--json', '{"type":"note","text":"found you by ID"}'], omerHome);
      const msg = await johnL.waitFor((l) => l.event === 'message', 'john gets the message', 10_000);
      expect(msg.payload).toMatchObject({ type: 'note', text: 'found you by ID' });
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  }, 60_000);

  it('rdv lookup <rdv1:…> shows the card; malformed and not-found IDs say why', async () => {
    const home = join(root, 'asker');
    await rdv(['init', '--profile', 'asker', '--email', 'asker@example.com', '--relay', relay.url], home);
    const johnId = (await rdv(['whoami'], join(root, 'john'))).lines[0].id as string;
    const found = await rdv(['lookup', johnId], home);
    expect(found.lines[0]).toMatchObject({ event: 'card', id: johnId });

    const bad = await rdv(['contact', 'request', 'rdv1:abc'], home, { check: false });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/malformed agent ID.*52 base32 characters/);
    expect((await rdv(['lookup', 'rdv1:abc'], home, { check: false })).code).toBe(2);

    const nobody = generateKey().id;
    const missing = await rdv(['contact', 'request', nobody], home, { check: false });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/no card for rdv1:.* on your relays or the discovery mirrors/);
    expect(missing.stderr).toMatch(/public pointer/);
    expect(missing.stderr).toMatch(/upgrade and republish/);

    const own = (await rdv(['whoami'], home)).lines[0].id as string;
    expect((await rdv(['contact', 'request', own], home, { check: false })).stderr).toMatch(/your own/);
  }, 30_000);
});
