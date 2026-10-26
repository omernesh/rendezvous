// `rdv/card-update` on real `rdv` processes and the in-memory relay (issue
// #45, NOTES 82): a relay change reaches the contacts, who then send to the
// new relays; a contact made before card updates gets the current card at
// the next listener start, after which a task its old card refused goes out.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardCapabilities, REQUEST_URI, TASKS_URI } from '@rendezvous/a2a';
import { type AddressCard, type AgentState, relaysOf } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';
import { initHome } from '../src/commands.js';
import { Home } from '../src/home.js';

const T = 15_000;
let root: string;
const relays: TestRelay[] = [];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rdv-cardupd-'));
});
afterAll(async () => {
  for (const r of relays) await r.close();
  rmSync(root, { recursive: true, force: true });
});
const start = async () => {
  const r = await startTestRelay();
  relays.push(r);
  return r;
};
const state = (home: string) => JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8')) as AgentState;
const events = (home: string) =>
  readFileSync(join(home, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).obj as { event: string } & Record<string, unknown>);

/** Omer asks John by card; John's listener grants (demo flag). Both listeners stay up. */
async function contacts(tag: string, relay: string, johnOpts: { capabilities?: string[] } = {}) {
  const omerHome = join(root, `omer-${tag}`);
  const johnHome = join(root, `john-${tag}`);
  await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay], omerHome);
  await initHome(new Home(johnHome), { profile: 'john', relays: [relay], emails: ['john@doe.com'], ...johnOpts });
  const handshakeCard = state(johnHome).card;
  const cardFile = join(root, `john-${tag}-card.json`);
  writeFileSync(cardFile, JSON.stringify(handshakeCard));
  let johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
  let omerL = new Listener('omer', omerHome);
  await johnL.waitFor((l) => l.event === 'ready', 'ready', T);
  await omerL.waitFor((l) => l.event === 'ready', 'ready', T);
  await rdv(['contact', 'request', cardFile, '--greeting', 'hi'], omerHome);
  const c = await omerL.waitFor((l) => l.event === 'contact', 'omer contact', T);
  return {
    omerHome,
    johnHome,
    handshakeCard,
    johnId: c.peer as string,
    omerId: state(omerHome).card.id,
    get johnL() {
      return johnL;
    },
    get omerL() {
      return omerL;
    },
    restart(who: 'john' | 'omer') {
      if (who === 'john') johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
      else omerL = new Listener('omer', omerHome);
      return who === 'john' ? johnL : omerL;
    },
    stop: () => Promise.all([johnL.stop(), omerL.stop()]),
  };
}

describe('rdv/card-update between rdv processes', () => {
  it('a relay change reaches the contact, which then sends to the new relay; consent is untouched', async () => {
    const one = await start();
    const two = await start();
    const s = await contacts('relays', one.url);
    try {
      const before = state(s.johnHome).book.contacts[s.omerId];
      const add = (await rdv(['relays', 'add', two.url], s.omerHome)).lines[0];
      expect(add.card_sent).toEqual({ sent: [s.johnId], failed: [] });
      const up1 = await s.johnL.waitFor((l) => l.event === 'card-update' && l.relays_added?.includes(two.url), 'john: card with relay two', T);
      expect(up1).toMatchObject({ peer: s.omerId, relays_removed: [], capabilities_added: [], addresses_changed: false });
      const rm = (await rdv(['relays', 'remove', one.url], s.omerHome)).lines[0];
      expect(rm.card_sent).toEqual({ sent: [s.johnId], failed: [] });
      expect(rm.warning).toContain('contacts keep the card');
      await s.johnL.waitFor((l) => l.event === 'card-update' && l.relays_removed?.includes(one.url), 'john: card without relay one', T);
      // Omer's listener moved to relay two only.
      await s.omerL.waitFor((l) => l.event === 'relays' && l.relays.length === 1 && l.relays[0] === two.url, 'omer moves to two', T);

      const after = state(s.johnHome).book.contacts[s.omerId];
      expect(relaysOf(after.card)).toEqual([two.url]);
      expect({ ...after, card: before.card }).toEqual(before); // tier, scopes, grant, label, expiry
      expect(events(s.johnHome).filter((e) => e.event === 'card-update')).toHaveLength(2);

      // John's next message goes to relay two (and his own relay one), where Omer now listens.
      const seenOnTwo = two.events.length;
      await rdv(['send', s.omerId, '--json', JSON.stringify({ type: 'note', text: 'found you' })], s.johnHome);
      const m = await s.omerL.waitFor((l) => l.event === 'message' && l.payload?.text === 'found you', 'omer gets the message', T);
      expect(m.from).toBe(s.johnId);
      expect(two.events.length).toBeGreaterThan(seenOnTwo);
    } finally {
      await s.stop();
    }
  });

  it('issue #45: a contact holding the card from before tasks/v1 gets the new one at the next start, and the task goes out', async () => {
    const relay = await start();
    // John's agent as made before #42: a card with the meeting extensions only.
    const s = await contacts('tasks', relay.url, { capabilities: cardCapabilities() });
    try {
      // John's human lets Omer use request/v1 (the reverse grant carries it).
      await rdv(['contact', 'grant', s.omerId, '--tier', 'friend', '--invoke', REQUEST_URI], s.johnHome);
      await s.omerL.waitFor((l) => l.event === 'reverse-grant', 'omer gets the grant', T);
      await s.stop();

      // The state as code before #45 left it: Omer holds John's handshake card (no tasks/v1), and nothing says what was sent.
      const omer = state(s.omerHome);
      omer.book.contacts[s.johnId].card = s.handshakeCard;
      delete omer.cardSent;
      writeFileSync(join(s.omerHome, 'agent.json'), JSON.stringify(omer));
      const john = state(s.johnHome);
      expect(john.card.capabilities).toContain(TASKS_URI); // refreshed at John's first start (#43)
      delete john.cardSent;
      writeFileSync(join(s.johnHome, 'agent.json'), JSON.stringify(john));

      const refused = await rdv(['task', 'request', s.johnId, '--text', 'please review'], s.omerHome, { check: false });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('does not advertise');

      const omerL = s.restart('omer');
      await omerL.waitFor((l) => l.event === 'ready', 'omer ready', T);
      const johnL = s.restart('john');
      const sent = await johnL.waitFor((l) => l.event === 'card-sent', 'john sends his card', T);
      expect(sent.sent).toEqual([s.omerId]);
      const up = await omerL.waitFor((l) => l.event === 'card-update', 'omer gets the card', T);
      expect(up.capabilities_added).toEqual(expect.arrayContaining([TASKS_URI, REQUEST_URI]));
      expect((state(s.omerHome).book.contacts[s.johnId].card as AddressCard).sig).toBe(john.card.sig);
      // Omer, also from before #45, sends his card once too; John already holds it (his grant came from it), so nothing changes there.
      expect((await omerL.waitFor((l) => l.event === 'card-sent', 'omer sends his card', T)).sent).toEqual([s.johnId]);

      const req = await rdv(['task', 'request', s.johnId, '--text', 'please review'], s.omerHome);
      expect(req.lines.find((l) => l.kind === 'requested')).toBeTruthy();
      await johnL.waitFor((l) => l.event === 'task' && l.kind === 'start-needed', 'john: the start gate', T);

      // Restarting John again sends nothing: Omer has the card.
      await johnL.stop();
      const again = s.restart('john');
      await again.waitFor((l) => l.event === 'ready', 'john ready', T);
      expect(again.lines.some((l) => l.event === 'card-sent')).toBe(false);
      expect([...johnL.lines, ...again.lines].some((l) => l.event === 'card-update')).toBe(false);
    } finally {
      await s.stop();
    }
  });
});
