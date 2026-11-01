// `rdv send` carries only free messages (issue #133, NOTES 108): every type
// with its own engine and gate is refused and names the command to use.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainSendRefusal } from '../src/commands.js';
import { Listener, rdv } from '../scenarios/harness.js';

const REFUSED: Array<[string, RegExp]> = [
  ['a2a/message', /rdv task, rdv dinner/],
  ['a2a/task-update', /rdv task/],
  ['a2a/artifact-update', /rdv task/],
  ['meeting/accept', /rdv dinner/],
  ['rdv/transfer', /rdv file/],
  ['rdv/group-msg', /rdv group/],
  ['rdv/group-join', /rdv group/],
  ['rdv/contact-grant', /rdv contact grant/],
  ['rdv/revoke', /rdv contact revoke/],
  ['rdv/auto-approve', /your agent sends it itself/],
  ['chat', /only free messages/],
];

describe('rdv send refuses gated payload types', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-plainsend-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('names the command for each family, and only note is sent', () => {
    for (const [type, hint] of REFUSED) expect(plainSendRefusal(type, 'rdv send'), type).toMatch(hint);
    expect(plainSendRefusal('note', 'rdv send')).toBeUndefined();
  });

  it('sends a note, refuses every other family without sending, then sends again at the next seq', async () => {
    const johnHome = join(root, 'john');
    const omerHome = join(root, 'omer');
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url, '--public-pointer'], johnHome);
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    const johnId = (await rdv(['whoami'], johnHome)).lines[0].id as string;
    await rdv(['card', 'publish'], johnHome);
    const johnL = new Listener('john', johnHome, ['--auto-grant', 'stranger']);
    const omerL = new Listener('omer', omerHome);
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', johnId], omerHome);
      await johnL.waitFor((l) => l.event === 'contact', 'john grants', 10_000);
      await omerL.waitFor((l) => l.event === 'contact' && l.peer === johnId, 'omer contact', 10_000);

      const first = await rdv(['send', johnId, '--json', '{"type":"note","text":"one"}'], omerHome);
      expect(first.lines[0]).toMatchObject({ event: 'sent', type: 'note' });
      const seq = first.lines[0].seq as number;
      for (const [type, hint] of REFUSED) {
        const r = await rdv(['send', johnId, '--json', JSON.stringify({ type, text: 'sneaky' })], omerHome, { check: false });
        expect(r.code, type).toBe(2);
        const msg = (JSON.parse(r.stderr.trim()) as { error: string }).error;
        expect(msg, type).toMatch(hint);
        expect(msg, type).toContain('{"type":"note",…}');
      }
      const second = await rdv(['send', johnId, '--json', '{"type":"note","text":"two"}'], omerHome);
      expect(second.lines[0]).toMatchObject({ event: 'sent', seq: seq + 1 }); // nothing went out in between
      await johnL.waitFor((l) => l.event === 'message' && l.payload?.text === 'two', 'john gets the second note', 10_000);
      expect(johnL.lines.some((l) => l.event === 'message' && l.payload?.text === 'sneaky')).toBe(false);
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  }, 60_000);
});
