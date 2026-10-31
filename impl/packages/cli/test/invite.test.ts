// Invite links (SPEC §5.2.3, NOTES 101) with real `rdv` processes on the
// in-memory relay: the inviter makes a link, a new person runs one command
// with it, and they are contacts.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInvite } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';

describe('rdv invite', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-invite-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('create -> init --invite -> contacts at once; reuse waits for the human; list and revoke', async () => {
    const omerHome = join(root, 'omer');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    const omerId = (await rdv(['whoami'], omerHome)).lines[0].id as string;

    const made = (await rdv(['invite', 'create', '--tier', 'colleague', '--label', 'John', '--expires', '3d'], omerHome)).lines[0];
    expect(made).toMatchObject({ event: 'invite', tier: 'colleague', name: 'omer', label: 'John' });
    expect(made.url).toMatch(/^https:\/\/rendezvous\.nesher\.co\/i#[A-Za-z0-9_-]+$/);
    expect(made.share_text).toContain(made.url);
    const link = parseInvite(made.url);
    expect(link).toMatchObject({ agentId: omerId, relays: [relay.url], name: 'omer' });
    // Only a hash is kept: the secret is nowhere in the home.
    expect(readFileSync(join(omerHome, 'agent.json'), 'utf8')).not.toContain(link.secret);

    const omerL = new Listener('omer', omerHome);
    const johnHome = join(root, 'john');
    let johnL: Listener | undefined;
    try {
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      // The new person: one command, no address, no publishing.
      const init = await rdv(['init', '--profile', 'john', '--relay', relay.url, '--invite', made.url], johnHome);
      expect(init.lines[0]).toMatchObject({ event: 'init' });
      expect(init.lines[1]).toMatchObject({ event: 'request-sent', via: 'invite', to: omerId, name_in_link: 'omer' });
      const johnId = init.lines[0].id as string;

      const red = await omerL.waitFor((l) => l.event === 'invite-redeemed', 'invite redeemed', 15_000);
      expect(red).toMatchObject({ invite_id: made.invite_id, invite_label: 'John', peer: johnId, tier: 'colleague', label: 'John' });
      johnL = new Listener('john', johnHome);
      await johnL.waitFor((l) => l.event === 'contact' && l.peer === omerId, 'john gets the grant', 15_000);
      await rdv(['send', omerId, '--json', '{"type":"a2a/message","text":"hi from the invite"}'], johnHome);
      const msg = await omerL.waitFor((l) => l.event === 'message', 'omer gets the message', 10_000);
      expect(msg.payload).toMatchObject({ text: 'hi from the invite' });

      // Someone else with the same link: used up, an ordinary pending request.
      const daveHome = join(root, 'dave');
      await rdv(['init', '--profile', 'dave', '--relay', relay.url], daveHome);
      const sent = await rdv(['invite', 'accept', made.url], daveHome);
      expect(sent.lines[0]).toMatchObject({ event: 'request-sent', via: 'invite', to: omerId });
      await omerL.waitFor((l) => l.event === 'request' && l.id === sent.lines[0].request_id, 'dave waits', 15_000);
      expect(omerL.lines.filter((l) => l.event === 'invite-redeemed')).toHaveLength(1);

      const list = (await rdv(['invite', 'list'], omerHome)).lines;
      expect(list).toEqual([expect.objectContaining({ invite_id: made.invite_id, status: 'used', redeemed_by: johnId })]);
      expect(JSON.stringify(list)).not.toMatch(/hash|secret/);
      const revoked = (await rdv(['invite', 'revoke', made.invite_id], omerHome)).lines[0];
      expect(revoked).toMatchObject({ status: 'used' }); // already used: revoke the contact instead
    } finally {
      await Promise.all([omerL.stop(), johnL?.stop()]);
    }
  }, 90_000);

  it('a revoked invite, a family tier, and a bad link are refused clearly', async () => {
    const home = join(root, 'inviter2');
    await rdv(['init', '--profile', 'ann', '--relay', relay.url], home);
    const made = (await rdv(['invite', 'create', '--name', 'Ann', '--no-meetings'], home)).lines[0];
    expect(made.tier).toBe('friend');
    expect(made.scope.may_propose_meetings).toBe(false);
    expect((await rdv(['invite', 'revoke', made.invite_id], home)).lines[0]).toMatchObject({ status: 'revoked' });
    expect((await rdv(['invite', 'list'], home)).lines[0]).toMatchObject({ status: 'revoked' });
    expect((await rdv(['invite', 'revoke', 'nope'], home, { check: false })).stderr).toMatch(/no invite nope/);

    const family = await rdv(['invite', 'create', '--tier', 'family'], home, { check: false });
    expect([family.code, family.stderr]).toEqual([2, expect.stringMatching(/tiers friend, colleague, business, stranger/)]);
    expect((await rdv(['invite', 'create', '--expires', '45d'], home, { check: false })).stderr).toMatch(/at most 30 days/);

    const fresh = join(root, 'fresh');
    const bad = await rdv(['init', '--profile', 'x', '--relay', relay.url, '--invite', 'https://rendezvous.nesher.co/i#nope'], fresh, { check: false });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/not an invite/);
    // Nothing was made for a bad link.
    expect((await rdv(['whoami'], fresh, { check: false })).code).not.toBe(0);

    const own = await rdv(['invite', 'accept', made.url], home, { check: false });
    expect(own.stderr).toMatch(/your own/);
  }, 60_000);
});
