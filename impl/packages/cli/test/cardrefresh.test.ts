// Issue #43: an agent made before tasks/v1 re-signs its card on the first
// listener start of newer code; issue #27 and the security review: request/v1
// is never granted by default, and terminal output can't be repainted.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardCapabilities, REQUEST_URI, TASKS_URI } from '@rendezvous/a2a';
import { type AddressCard, DEFAULT_GRANT_SCOPE, DEFAULT_INBOUND_SCOPE, grantScope, scopeAllows, verifyCard } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Listener } from '../scenarios/harness.js';
import { initHome } from '../src/commands.js';
import { Home } from '../src/home.js';
import { clean, jsonLine } from '../src/output.js';
import { hostCardCapabilities } from '../src/tasks.js';

const T = 20_000;

describe('card refresh on a listener start (issue #43)', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-card-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  const cardEvents = () => relay.events.filter((e) => e.tags.some((t) => t[0] === 'd' && t[1].startsWith('rdv1/card:')));

  it('an old card gains tasks/v1 and request/v1, keeps its identity and addresses, and is republished once; a restart changes nothing', async () => {
    const home = new Home(join(root, 'omer'));
    // An agent as code before #42 made it: its card lists only the meeting extensions.
    const OLD = cardCapabilities();
    const { id } = await initHome(home, { profile: 'omer', relays: [relay.url], emails: ['omer@example.com'], publicPointer: true, capabilities: OLD });
    const before = home.readAgentState() as { secretKey: string; card: AddressCard; book: unknown };
    expect(before.card.capabilities).not.toContain(TASKS_URI);

    const first = new Listener('omer', home.dir);
    try {
      const refreshed = await first.waitFor((l) => l.event === 'card-refreshed', 'the card refresh', T);
      await first.waitFor((l) => l.event === 'ready', 'ready', T);
      expect(refreshed.capabilities).toEqual(expect.arrayContaining([TASKS_URI, REQUEST_URI]));
      expect(refreshed.published).toHaveLength(1);
    } finally {
      await first.stop();
    }
    const after = home.readAgentState() as typeof before;
    expect(after.card.id).toBe(id);
    expect(after.secretKey).toBe(before.secretKey);
    expect(JSON.stringify(after.book)).toBe(JSON.stringify(before.book));
    expect(after.card.discovery).toEqual(before.card.discovery);
    expect(after.card.capabilities).toEqual(hostCardCapabilities());
    expect(verifyCard(after.card).ok).toBe(true);
    expect(Date.parse(after.card.created) - Date.parse(before.card.created)).toBeGreaterThanOrEqual(1000);
    // The replaceable event on the address topic carries the new capabilities.
    const events = cardEvents();
    expect(events).toHaveLength(1);
    expect((JSON.parse(events[0].content) as AddressCard).capabilities).toEqual(after.card.capabilities);
    const eventId = events[0].id;

    // Same code again: no re-sign, no publish.
    const second = new Listener('omer', home.dir);
    try {
      await second.waitFor((l) => l.event === 'ready', 'ready', T);
      expect(second.lines.some((l) => l.event === 'card-refreshed')).toBe(false);
    } finally {
      await second.stop();
    }
    expect((home.readAgentState() as typeof before).card.sig).toBe(after.card.sig);
    expect(cardEvents().map((e) => e.id)).toEqual([eventId]);
  });

  it('a current card is left alone', async () => {
    const home = new Home(join(root, 'john'));
    await initHome(home, { profile: 'john', relays: [relay.url], emails: ['john@doe.com'] });
    const sig = (home.readAgentState() as { card: AddressCard }).card.sig;
    const l = new Listener('john', home.dir);
    try {
      await l.waitFor((x) => x.event === 'ready', 'ready', T);
      expect(l.lines.some((x) => x.event === 'card-refreshed')).toBe(false);
    } finally {
      await l.stop();
    }
    expect((home.readAgentState() as { card: AddressCard }).card.sig).toBe(sig);
  });
});

describe('request/v1 is never in a default scope (issue #27)', () => {
  it('no default grant, inbound default or empty scope lets a peer invoke it', () => {
    for (const scope of [DEFAULT_GRANT_SCOPE, DEFAULT_INBOUND_SCOPE, grantScope({}), grantScope({ may_propose_meetings: true })]) {
      expect(scopeAllows(scope, REQUEST_URI)).toBe(false);
    }
  });
});

describe('terminal output (security review)', () => {
  const hostile = 'a\u001b[2Jb\u009b31mc\u202ed\u2066e\u200ff\u061cg\u2028h\u2029i\u007fj';

  it('clean() replaces escapes, C1 controls, bidi controls and marks, and line separators', () => {
    expect(clean(hostile)).toBe('a�[2Jb�31mc�d�e�f�g�h�i�j');
    expect(clean('x\ny', true)).toBe('x\ny');
    expect(clean('Omer \u{1F37D} café שלום')).toBe('Omer \u{1F37D} café שלום'); // text, emoji and Hebrew stay
  });

  it('--json lines carry the same value with nothing raw a terminal acts on', () => {
    const line = jsonLine({ text: hostile, n: 1 });
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
    expect(JSON.parse(line)).toEqual({ text: hostile, n: 1 });
  });
});
