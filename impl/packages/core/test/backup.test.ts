// Encrypted identity backup and the clean restore (issue #88, NOTES 91).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  type AgentKey,
  type AgentState,
  BACKUP_SCRYPT,
  backupAgentState,
  BackupError,
  backupPassphraseProblem,
  BACKUP_PASSPHRASE_RULES,
  BACKUP_PASSPHRASE_MIN,
  NostrTransport,
  openBackup,
  parseBackup,
  type Payload,
  RESTORED_TYPE,
  restoredAgentState,
  sealBackup,
  sealEnvelope,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const PASS = 'correct horse battery staple 42';

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('backup bundle format', () => {
  const agent = Agent.create(
    () => ({ async sendEnvelope() {}, onEnvelopes: () => () => {}, async publishTopic() {}, onTopics: () => () => {}, fetchTopic: async () => [], close() {} }),
    { rendezvous: [{ type: 'nostr', relay: 'ws://unused', pref: 1 }] },
  );
  const contents = () => ({ agent: backupAgentState(agent.toJSON()), extra: { note: 'kept' } });

  it('round-trips the agent state under the passphrase, with the agent ID in the clear header', async () => {
    const b = await sealBackup(agent.id, PASS, contents());
    expect(b.format).toBe('rdv-backup');
    expect(b.agent).toBe(agent.id);
    expect(b.kdf).toMatchObject({ name: 'scrypt', ...BACKUP_SCRYPT });
    // No secret in the clear: neither the key nor anything of the state.
    const text = JSON.stringify(b);
    expect(text).not.toContain(agent.toJSON().secretKey);
    expect(text).not.toContain('kept');
    const opened = await openBackup(JSON.stringify(b), PASS);
    expect(opened.header.agent).toBe(agent.id);
    expect(opened.contents.agent.secretKey).toBe(agent.toJSON().secretKey);
    expect(opened.contents.extra).toEqual({ note: 'kept' });
  });

  it('refuses a wrong passphrase, a changed header and a changed ciphertext with the same error', async () => {
    const b = await sealBackup(agent.id, PASS, contents());
    await expect(openBackup(b, 'correct horse battery staple 43')).rejects.toMatchObject({ code: 'decrypt' });
    const other = Agent.create(() => agent.transport, { rendezvous: [{ type: 'nostr', relay: 'ws://unused', pref: 1 }] });
    for (const tampered of [
      { ...b, agent: other.id }, // the AD binds the agent ID
      { ...b, created: '2020-01-01T00:00:00.000Z' },
      { ...b, kdf: { ...b.kdf, N: 2 ** 18 } },
      { ...b, ciphertext: b.ciphertext.slice(0, 8) + (b.ciphertext[8] === 'A' ? 'B' : 'A') + b.ciphertext.slice(9) },
    ]) {
      await expect(openBackup(tampered, PASS)).rejects.toMatchObject({ code: 'decrypt' });
    }
  });

  it('parses strictly: extra fields, another version, weak or huge KDF costs, bad encodings', async () => {
    const b = await sealBackup(agent.id, PASS, contents());
    const bad: unknown[] = [
      { ...b, extra: 1 },
      { ...b, v: 2 },
      { ...b, format: 'other' },
      { ...b, kdf: { ...b.kdf, N: 2 ** 14 } },
      { ...b, kdf: { ...b.kdf, N: 2 ** 30 } },
      { ...b, kdf: { ...b.kdf, N: 2 ** 17 + 1 } },
      { ...b, kdf: { ...b.kdf, r: 1 } },
      { ...b, kdf: { ...b.kdf, salt: 'AAAA' } },
      { ...b, cipher: { ...b.cipher, name: 'aes-128-gcm' } },
      { ...b, agent: 'rdv1:nope' },
      { ...b, created: 'yesterday' },
      { ...b, ciphertext: '***' },
      '{not json',
      [],
      null,
    ];
    for (const x of bad) expect(() => parseBackup(x)).toThrow(BackupError);
    expect(parseBackup(JSON.stringify(b)).agent).toBe(agent.id);
  });

  it('refuses contents whose key is not the header agent', async () => {
    const other = Agent.create(() => agent.transport, { rendezvous: [{ type: 'nostr', relay: 'ws://unused', pref: 1 }] });
    await expect(sealBackup(other.id, PASS, contents())).rejects.toMatchObject({ code: 'mismatch' });
  });

  it('asks for a strong passphrase', () => {
    expect(backupPassphraseProblem('short')).toMatch(/12 characters/);
    expect(backupPassphraseProblem('aaaaaaaaaaaaaaaa')).toMatch(/variety/);
    expect(backupPassphraseProblem('abcdefabcdef')).toMatch(/offline guessing/);
    expect(backupPassphraseProblem(' padded passphrase 1 ')).toMatch(/spaces/);
    expect(backupPassphraseProblem('Password123!')).toMatch(/common words/);
    expect(backupPassphraseProblem('Qwerty-Zebra-9')).toMatch(/common words/);
    expect(backupPassphraseProblem(PASS)).toBeUndefined();
    expect(BACKUP_PASSPHRASE_RULES).toContain(`${BACKUP_PASSPHRASE_MIN} characters`);
    expect(backupPassphraseProblem('lamp-orbit-cedar-whisk')).toBeUndefined(); // the example in the rules
  });

  it('keeps no open approvals, outbox or buffer in the bundle, and a restore owes every channel a notice at a new epoch', () => {
    const s: AgentState = agent.toJSON();
    s.book.pending = { r: { request: {} } as never };
    s.book.candidates = { g: {} as never };
    s.outbox = { x: [] };
    s.channels = { [agent.id]: { outSeq: 5, outPrev: 'ab', inSeq: 3, inPrev: 'cd' } };
    const b = backupAgentState(s);
    expect(b.book.pending).toEqual({});
    expect(b.book.candidates).toEqual({});
    expect(b.outbox).toEqual({});
    const now = new Date();
    const r = restoredAgentState(b, { backupCreated: now.toISOString(), now });
    expect(r.channels[agent.id]).toMatchObject({ outSeq: now.getTime(), inSeq: 3, restoreNotice: 'due' });
    expect(r.restored).toEqual({ at: now.toISOString(), backup_created: now.toISOString() });
  });
});

describe('restore without a fork (rdv/restored)', () => {
  let relay: TestRelay;
  let agents: Agent[] = [];
  beforeEach(async () => {
    relay = await startTestRelay();
  });
  afterEach(async () => {
    for (const a of agents) a.close();
    agents = [];
    await relay.close();
  });

  const transport = (key: AgentKey) => new NostrTransport({ key, relays: [relay.url] });
  const card = () => ({ rendezvous: [{ type: 'nostr' as const, relay: relay.url, pref: 1 }] });
  const watch = (a: Agent) => {
    const log = { texts: [] as unknown[], drops: [] as string[], restored: [] as unknown[], confirmed: [] as unknown[] };
    a.on('message', (_p, payload: Payload) => log.texts.push(payload.text));
    a.on('dropped', (r) => {
      if (!r.includes('duplicate')) log.drops.push(r);
    });
    a.on('contact-restored', (x) => log.restored.push(x));
    a.on('restore-confirmed', (x) => log.confirmed.push(x));
    a.on('error', (e) => log.drops.push(`error: ${e.message}`));
    return log;
  };
  const start = (a: Agent) => {
    agents.push(a);
    a.start();
    return a;
  };

  /** Omer and John, contacts, after a first exchange. */
  async function pair() {
    const omer = start(Agent.create(transport, card()));
    const john = start(Agent.create(transport, card()));
    const om = watch(omer);
    const jo = watch(john);
    await new Promise((r) => setTimeout(r, 150));
    const pending = new Promise<{ request: { id: string } }>((res) => john.once('request', res));
    await omer.requestContact(john.card, 'hi');
    const gotContact = new Promise((res) => omer.once('contact', res));
    await john.grant((await pending).request.id);
    await gotContact;
    await omer.send(john.id, { type: 'a2a/message', text: 'o1' });
    await john.send(omer.id, { type: 'a2a/message', text: 'j1' });
    await until(() => jo.texts.includes('o1') && om.texts.includes('j1'));
    return { omer, john, om, jo };
  }

  async function restoreFrom(saved: AgentState, backupCreated: string): Promise<Agent> {
    const bundle = await sealBackup(saved.card.id, PASS, { agent: backupAgentState(saved) });
    const { contents } = await openBackup(JSON.stringify(bundle), PASS);
    return Agent.fromJSON(restoredAgentState(contents.agent, { backupCreated }), transport);
  }

  it('peers re-base the restored chain: both directions go on without a resync, and missed messages come again', { timeout: 30_000 }, async () => {
    const { omer, john, om, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    const backupCreated = new Date().toISOString();
    // The old copy goes on after the backup, then its disk dies.
    await omer.send(john.id, { type: 'a2a/message', text: 'o2' });
    await omer.send(john.id, { type: 'a2a/message', text: 'o3' });
    await john.send(omer.id, { type: 'a2a/message', text: 'j2' });
    await until(() => jo.texts.includes('o3') && om.texts.includes('j2'));
    omer.close();
    agents = agents.filter((a) => a !== omer);

    const omer2 = await restoreFrom(saved, backupCreated);
    const o2 = watch(omer2);
    start(omer2);
    expect(omer2.restoreStatus()?.notice_due).toEqual([john.id]);
    const report = await omer2.sendRestoredNotices();
    expect(report.sent).toEqual([john.id]);
    await until(() => jo.restored.length === 1 && o2.confirmed.length === 1);
    expect(jo.restored[0]).toMatchObject({ peer: omer.id, backup_created: backupCreated });
    expect(omer2.restoreStatus()).toMatchObject({ notice_due: [], awaiting_ack: [] });

    // John's reply the lost copy had received comes again from his outbox.
    await until(() => o2.texts.includes('j2'));
    await omer2.send(john.id, { type: 'a2a/message', text: 'o4' });
    await john.send(omer2.id, { type: 'a2a/message', text: 'j3' });
    await until(() => jo.texts.includes('o4') && o2.texts.includes('j3'));
    expect(o2.texts).toEqual(['j2', 'j3']);
    expect(jo.texts).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(jo.drops).toEqual([]);
    expect(o2.drops).toEqual([]);
    expect(john.refusedChannels()).toEqual([]);
    expect(omer2.refusedChannels()).toEqual([]);

    // A restart replays everything on the relay, the notice included: nothing is re-based twice, nothing forks.
    const johnState = JSON.parse(JSON.stringify(john.toJSON()));
    john.close();
    agents = agents.filter((a) => a !== john);
    const john2 = start(Agent.fromJSON(johnState, transport));
    const j2 = watch(john2);
    await new Promise((r) => setTimeout(r, 600));
    await omer2.send(john2.id, { type: 'a2a/message', text: 'o5' });
    await until(() => j2.texts.includes('o5'));
    expect(j2.restored).toEqual([]);
    expect(j2.drops).toEqual([]);
    expect(j2.texts).toEqual(['o5']);
  });

  it('sends the notice before anything else, even without sendRestoredNotices', async () => {
    const { omer, john, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    await omer.send(john.id, { type: 'a2a/message', text: 'o2' });
    await until(() => jo.texts.includes('o2'));
    omer.close();
    agents = agents.filter((a) => a !== omer);
    const omer2 = start(await restoreFrom(saved, new Date().toISOString()));
    watch(omer2);
    await omer2.send(john.id, { type: 'a2a/message', text: 'o3' });
    await until(() => jo.texts.includes('o3'));
    expect(jo.restored).toHaveLength(1);
    expect(jo.drops).toEqual([]);
  });

  it("skips the peer's envelopes nobody holds any more (the ack), instead of waiting for a gap forever", { timeout: 30_000 }, async () => {
    const { omer, john, om, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    await john.send(omer.id, { type: 'a2a/message', text: 'j2' });
    await john.send(omer.id, { type: 'a2a/message', text: 'j3' });
    await until(() => om.texts.includes('j3'));
    omer.close();
    agents = agents.filter((a) => a !== omer);
    // The relay kept nothing, and John's outbox no longer holds j2 (it keeps the last 64).
    relay.events.length = 0;
    const box = (john as unknown as { outbox: Record<string, Array<{ seq: number }>> }).outbox[omer.id];
    box.splice(0, box.length - 1);
    const omer2 = start(await restoreFrom(saved, new Date().toISOString()));
    const o2 = watch(omer2);
    await omer2.sendRestoredNotices();
    await until(() => o2.confirmed.length === 1 && o2.texts.includes('j3'));
    expect(o2.confirmed[0]).toEqual({ peer: john.id, skipped: 1 });
    await john.send(omer2.id, { type: 'a2a/message', text: 'j4' });
    await until(() => o2.texts.includes('j4'));
    expect(o2.texts).toEqual(['j3', 'j4']);
    expect(o2.drops).toEqual([]);
    expect(jo.drops).toEqual([]);
  });

  /** Run `fn` with our clock `ms` in the past (only Date is faked: timers and sockets run as usual). */
  async function inThePast<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - ms);
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }
  const DAYS3 = 3 * 86_400_000;

  it('never resends an expired envelope in the ack: the restored side skips to the oldest live one (review of #92)', { timeout: 30_000 }, async () => {
    const { omer, john, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    omer.close();
    agents = agents.filter((a) => a !== omer);
    // While Omer is down: j2 was sealed three days ago (its 48h ttl is gone), j3 now.
    const { seq, prev } = john.channels.nextOutbound(omer.id);
    const j2 = sealEnvelope(john.key, omer.id, { type: 'a2a/message', text: 'j2' }, { seq, prev, now: new Date(Date.now() - DAYS3) });
    john.channels.commitOutbound(omer.id, j2);
    (john as unknown as { outbox: Record<string, unknown[]> }).outbox[omer.id].push(j2);
    await john.transport.sendEnvelope(j2, [relay.url]);
    await john.send(omer.id, { type: 'a2a/message', text: 'j3' });
    const omer2 = start(await restoreFrom(saved, new Date().toISOString()));
    const o2 = watch(omer2);
    await omer2.sendRestoredNotices();
    await until(() => o2.confirmed.length === 1 && o2.texts.includes('j3'));
    await john.send(omer2.id, { type: 'a2a/message', text: 'j4' });
    await until(() => o2.texts.includes('j4'));
    expect(o2.texts).toEqual(['j3', 'j4']);
    expect(jo.drops).toEqual([]);
  });

  it('a notice that expired unanswered is sent afresh: before the next envelope, and when the peer asks for it again (review of #92)', { timeout: 30_000 }, async () => {
    const { omer, john, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    omer.close();
    agents = agents.filter((a) => a !== omer);
    // The notice goes out while John is away long enough for it to expire (here: sealed three days ago).
    const omer2 = start(await restoreFrom(saved, new Date().toISOString()));
    watch(omer2);
    await inThePast(DAYS3, () => omer2.sendRestoredNotices());
    await new Promise((r) => setTimeout(r, 300));
    expect(jo.restored).toEqual([]);
    expect(omer2.restoreStatus()?.notice_due).toEqual([john.id]);
    await omer2.send(john.id, { type: 'a2a/message', text: 'o2' });
    await until(() => jo.texts.includes('o2'));
    expect(jo.restored).toHaveLength(1);
    expect(jo.drops).toEqual([]);

    // The resend path: another restore whose notice expired; John asks for the range again (a gap), and gets a fresh one.
    const again = start(Agent.fromJSON(restoredAgentState(backupAgentState(saved), { backupCreated: new Date().toISOString() }), transport));
    watch(again);
    omer2.close();
    agents = agents.filter((a) => a !== omer2);
    await inThePast(DAYS3, () => again.sendRestoredNotices());
    const notice = again.channels.state[john.id];
    const { seq, prev } = john.channels.nextOutbound(again.id);
    const resend = sealEnvelope(john.key, again.id, { type: 'rdv/resend', from_seq: 1, to_seq: notice.outSeq }, { seq, prev });
    john.channels.commitOutbound(again.id, resend);
    await john.transport.sendEnvelope(resend, [relay.url]);
    await until(() => jo.restored.length === 2);
  });

  it('a copy that still runs after the restore forks the chain again: refused, as any fork', async () => {
    const { omer, john, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    const omer2 = start(await restoreFrom(saved, new Date().toISOString()));
    watch(omer2);
    await omer2.sendRestoredNotices();
    await until(() => jo.restored.length === 1);
    await omer.send(john.id, { type: 'a2a/message', text: 'from the old copy' });
    await until(() => jo.drops.length > 0);
    expect(jo.drops[0]).toMatch(/envelope chain fork/);
    expect(jo.texts).not.toContain('from the old copy');
    expect(john.refusedChannels().map((c) => c.peer)).toEqual([omer.id]);
    // Another notice from the key does not lift the refusal: that is the human's resync. They are told.
    const omer3 = start(Agent.fromJSON(restoredAgentState(backupAgentState(saved), { backupCreated: new Date().toISOString() }), transport));
    watch(omer3);
    await omer3.sendRestoredNotices();
    await until(() => jo.restored.length === 2);
    expect(jo.restored[1]).toMatchObject({ peer: omer.id, pending_resync: true, was_refused: expect.any(String) });
    expect(john.refusedChannels().map((c) => c.peer)).toEqual([omer.id]);
  });

  it('rate-limits notices per peer, and ignores one from a stranger', async () => {
    const { omer, john, jo } = await pair();
    const saved = JSON.parse(JSON.stringify(omer.toJSON())) as AgentState;
    omer.close();
    agents = agents.filter((a) => a !== omer);
    for (let i = 0; i < 4; i++) {
      const again = start(Agent.fromJSON(restoredAgentState(backupAgentState(saved), { backupCreated: new Date().toISOString() }), transport));
      watch(again);
      await again.sendRestoredNotices();
      await until(() => jo.restored.length === Math.min(i + 1, 3) && (i < 3 || jo.drops.length > 0));
      again.close();
      agents = agents.filter((a) => a !== again);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(jo.restored).toHaveLength(3);
    expect(jo.drops).toContain('restored notice rate-limited');

    // A stranger's notice re-bases nothing and tells nobody.
    const stranger = start(Agent.create(transport, card()));
    const env = sealEnvelope(stranger.key, john.id, { type: RESTORED_TYPE, v: 1, in_seq: 0, backup_created: null }, { seq: 1, prev: null });
    await stranger.transport.sendEnvelope(env, [relay.url]);
    await new Promise((r) => setTimeout(r, 400));
    expect(jo.restored).toHaveLength(3);
  }, 30_000);
});
