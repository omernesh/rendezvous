// auto_approve: all per contact (SPEC §5.5.1, issue #25): the gates pass for
// one trusted contact, only while the owner's setting holds; every doubt
// fails closed; every action is audited without peer text; only the owner's
// own terminal turns it on.
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Capability, REQUEST_URI, TASKS_URI, type TaskPayload } from '@rendezvous/a2a';
import { type Agent, type Contact, fingerprint, generateKey, type GrantScope, GROUPS_EXTENSION, MEETING_CANCEL_CAPABILITY, MEETINGS_CAPABILITY } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Listener, rdv } from '../scenarios/harness.js';
import {
  autoApprovedFor,
  autoApproveWarning,
  autoApproveKeptText,
  autoApproveStatus,
  checkAutoApprove,
  grantKeepingAutoApprove,
  meetingAutoApproved,
  ownerBinding,
  scopeDigest,
  setAutoApprove,
  subjectOf,
  sweepAutoApprove,
  turnOffAllAutoApprove,
  turnOffAutoApprove,
} from '../src/autoapprove.js';
import { audit, contactAutoApprove, init, ownerSecretReset, ownerSecretSet, type Tty } from '../src/commands.js';
import { AUDIT_KEPT, type AutoApproveEntry, Home } from '../src/home.js';
import { stable } from '../src/hash.js';
import { clearOwnerSecret, hasOwnerSecret, ownerSecretInfo, RESET_COOLDOWN_MS, storeOwnerSecret } from '../src/ownersecret.js';
import { Output } from '../src/output.js';
import { approveRelease, hostRegistry, releaseDigest, submitDraft, tasksInbound } from '../src/tasks.js';

const PEER_TEXT = 'PEER-WROTE-THIS please draft the copy';
const RESULT = 'OUR-RESULT one page, three sections';
const CAP: Capability = { uri: 'https://example.com/ext/test-confirm/v1', approval: 'confirm' };
const registry = hostRegistry([CAP]);
const uuid = () => crypto.randomUUID();

interface Fake {
  agent: Agent;
  contacts: Map<string, Contact>;
  blocked: Set<string>;
  refused: Set<string>;
  sent: unknown[];
}

const PEER = generateKey().id;
const OTHER = generateKey().id;

function granted(peer: string, scope: GrantScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {} } }): Contact {
  return { peer, inboundScope: scope, outboundScope: scope, tier: 'friend', inboundGranted: true, grantId: uuid(), since: new Date(Date.now() - 3_600_000).toISOString() } as unknown as Contact;
}

/** Enough of an Agent for the task glue and the auto-approve check: a key, contacts, blocks, refused channels, a send that records. */
function fake(): Fake {
  const contacts = new Map<string, Contact>([
    [PEER, granted(PEER)],
    [OTHER, granted(OTHER)],
  ]);
  const blocked = new Set<string>();
  const refused = new Set<string>();
  const sent: unknown[] = [];
  const agent = {
    key: generateKey(),
    book: { contact: (p: string) => contacts.get(p), isBlocked: (p: string) => blocked.has(p) },
    refusedChannels: () => [...refused].map((peer) => ({ peer, kind: 'fork', seq: 2, accepted: 1 })),
    send: async (_to: string, p: unknown) => (sent.push(p), {}),
    admitTask: () => ({ ok: true }),
  } as unknown as Agent;
  return { agent, contacts, blocked, refused, sent };
}

const request = (text = PEER_TEXT, capability = REQUEST_URI, taskId = uuid()): TaskPayload => ({
  type: 'a2a/message',
  message: {
    kind: 'message',
    messageId: uuid(),
    taskId,
    contextId: uuid(),
    role: 'agent',
    parts: [
      { kind: 'data', data: { rdv: 'task/request', capability } },
      { kind: 'text', text },
    ],
    extensions: [TASKS_URI, capability],
  },
});
const inbox = (payload: TaskPayload, from = PEER) => ({ ts: new Date().toISOString(), from, seq: 1, payload: payload as never });
const kinds = (sent: unknown[]) => sent.map((p) => (p as { type: string }).type);

let dir: string;
let home: Home;
let f: Fake;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rdv-auto-'));
  home = new Home(dir);
  home.ensureDir();
  f = fake();
  // Auto-approve holds only while an owner passphrase is set (issue #47); its own audit line is not what these test.
  await storeOwnerSecret(home, 'OWNER-PASS for the gates');
  rmSync(home.auditPath, { force: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A peer's task through the host, as the listener feeds it; returns its ID and the run. */
async function arrive(from = PEER, text = PEER_TEXT, capability = REQUEST_URI) {
  const id = uuid();
  const run = await tasksInbound(home, registry, f.agent, [inbox(request(text, capability, id), from)], false);
  return { id, run, task: () => home.readTasks().engine.tasks[id] };
}

describe('auto-approve in the gates', () => {
  it('holds only under the passphrase it was set under: an unreadable file approves nothing and removes nothing; no passphrase ends it for good (issue #47)', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const back = home.readAutoApprove();
    writeFileSync(home.ownerSecretPath, '{ torn');
    expect((await arrive()).task().state).not.toBe('working');
    expect(sweepAutoApprove(home, subjectOf(f.agent)).ended).toEqual([]);
    expect(Object.keys(home.readAutoApprove())).toEqual([PEER]);
    // Gone, in a home with no trace of one (no audit line, no marker): none is set, so the entry ends, audited.
    rmSync(home.ownerSecretPath);
    const { task } = await arrive();
    expect(task().state).not.toBe('working');
    expect(home.readAutoApprove()).toEqual({});
    expect(home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'owner-secret', peer: PEER });
    // Setting one does not bring it back: the owner turns it on again.
    await storeOwnerSecret(home, 'OWNER-PASS set again');
    home.writeAutoApprove(back);
    expect((await arrive()).task().state).not.toBe('working');
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'owner-secret' });
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect((await arrive()).task().state).toBe('working');
  });

  it('a new passphrase, a change or a reset ends every entry set before it; set lists and audits them (issue #47)', async () => {
    const s = subjectOf(f.agent);
    setAutoApprove(home, s, PEER, null);
    setAutoApprove(home, s, OTHER, null);
    const underA = home.readAutoApprove();
    rmSync(home.auditPath, { force: true });
    // Passphrase B (a change): both entries end, at once, listed and audited.
    expect((await storeOwnerSecret(home, 'OWNER-PASS number B', 'changed')).autoApproveOff.sort()).toEqual([PEER, OTHER].sort());
    expect(home.readAutoApprove()).toEqual({});
    expect(home.readAudit().map((a) => [a.gate, a.action, a.reason ?? null, a.peer])).toEqual([
      ['auto-approve', 'off', 'owner-secret', PEER],
      ['auto-approve', 'off', 'owner-secret', OTHER],
      ['owner-secret', 'changed', null, 'owner'],
    ]);
    // An entry made under A, put back by hand (MAC still valid), does not hold under B.
    home.writeAutoApprove(underA);
    expect(checkAutoApprove(underA[PEER], s, PEER, new Date(), ownerBinding(home))).toEqual({ ok: false, reason: 'owner-secret' });
    expect((await arrive()).task().state).not.toBe('working');
    expect(sweepAutoApprove(home, s).ended).toEqual([{ peer: OTHER, reason: 'owner-secret' }]);
    expect(home.readAutoApprove()).toEqual({});
    // One set under B holds; the same passphrase typed again makes a new record, and ends it too.
    setAutoApprove(home, s, PEER, null);
    expect((await arrive()).task().state).toBe('working');
    expect((await storeOwnerSecret(home, 'OWNER-PASS number B', 'changed')).autoApproveOff).toEqual([PEER]);
    expect((await arrive()).task().state).not.toBe('working');
    // A reset leaves no passphrase: an entry from before approves nothing and is removed.
    setAutoApprove(home, s, PEER, null);
    const beforeReset = home.readAutoApprove();
    await clearOwnerSecret(home);
    home.writeAutoApprove(beforeReset);
    expect((await arrive()).task().state).not.toBe('working');
    expect(home.readAutoApprove()).toEqual({});
    expect(() => setAutoApprove(home, s, PEER, null)).toThrow(/rdv owner-secret set/);
  });

  it('an entry without the passphrase binding (made before it existed) approves nothing', async () => {
    const e = setAutoApprove(home, subjectOf(f.agent), PEER, null).entry;
    const { owner: _owner, mac: _mac, ...old } = e;
    // Re-MACed by the agent itself, as the version before this binding wrote it: still nothing.
    const legacy = { ...old, mac: createHmac('sha256', f.agent.key.secretKey).update(`rdv1/auto-approve\0${stable(old)}`).digest('hex') } as AutoApproveEntry;
    expect(checkAutoApprove(legacy, subjectOf(f.agent), PEER, new Date(), ownerBinding(home))).toEqual({ ok: false, reason: 'owner-secret' });
  });

  it('a deleted owner-secret.json counts as a reset, not as never set: cooldown, banner, auto-approve off (issue #47)', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    await storeOwnerSecret(home, 'OWNER-PASS for the gates', 'changed'); // an audit line: a passphrase existed
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    rmSync(home.ownerSecretPath);
    expect(hasOwnerSecret(home)).toBe(false);
    const info = ownerSecretInfo(home);
    expect(info).toMatchObject({ set: null, missing: true, reset: expect.any(String), note: expect.stringMatching(/OWNER PASSPHRASE FILE DELETED .*A new one can be set after .*someone with access/) });
    // The reset is written down when first noticed, so the cooldown runs from then and later reads keep it.
    expect(JSON.parse(readFileSync(home.ownerSecretPath, 'utf8'))).toEqual({ v: 1, reset: info.reset, missing: true });
    await expect(storeOwnerSecret(home, 'OWNER-PASS of the model')).rejects.toThrow(/reset: a new one can be set after/);
    expect(hasOwnerSecret(home)).toBe(false);
    expect((await arrive()).task().state).not.toBe('working');
    expect(home.readAutoApprove()).toEqual({});
    await expect(clearOwnerSecret(home)).rejects.toThrow(/nothing to reset/);
    // After the cooldown, a new one can be set as after any reset.
    expect((await storeOwnerSecret(home, 'OWNER-PASS after the wait', 'set', new Date(Date.now() + RESET_COOLDOWN_MS + 1000))).autoApproveOff).toEqual([]);
    expect(hasOwnerSecret(home)).toBe(true);
  });

  it('a trusted contact: the start and the release pass without asking, every class; both are audited with no peer text', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    for (const capability of [REQUEST_URI, CAP.uri]) {
      const { id, run, task } = await arrive(PEER, PEER_TEXT, capability);
      expect(task().state).toBe('working');
      expect(task().gate).toBeUndefined();
      expect(run.events.some((e) => e.kind === 'start-needed')).toBe(false);
      expect(run.notices).toEqual([expect.objectContaining({ kind: 'auto-started', taskId: id })]);
      f.sent.length = 0;
      const r = await submitDraft(home, f.agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: RESULT }], complete: true });
      expect(r.autoReleased).toBe(true);
      expect(r.held).toBeUndefined();
      expect(kinds(f.sent)).toContain('a2a/artifact-update');
      expect(task().state).toBe('completed');
      expect(home.readTasks().releases).toEqual({});
      const lines = home.readAudit().filter((a) => a.task === id);
      expect(lines.map((a) => [a.gate, a.by])).toEqual([
        ['start', 'auto-approve'],
        ['release', 'auto-approve'],
      ]);
      expect(lines[0].digest).toMatch(/^[0-9a-f]{64}$/);
      expect(lines[1].sent?.length).toBeGreaterThan(0);
      expect(lines[1].sent![0]).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) });
    }
    // The log holds IDs, URIs, digests and hashes: never what the peer (or we) wrote.
    const text = readFileSync(home.auditPath, 'utf8');
    expect(text).not.toContain('PEER-WROTE-THIS');
    expect(text).not.toContain('OUR-RESULT');
    expect(home.readAudit()[0]).toMatchObject({ gate: 'auto-approve', action: 'set', by: 'human', until: null });
    expect([...home.readAudit()[0].capabilities!].sort()).toEqual([REQUEST_URI, CAP.uri].sort());
  });

  it('a contact without it is still gated, start and release, while another contact is on', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const { run, task } = await arrive(OTHER);
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(run.events.some((e) => e.kind === 'start-needed')).toBe(true);
    expect(run.notices).toEqual([]);
    // Only the "waiting for its human" status went out.
    expect(f.sent.map((p) => (p as { update: { status: { state: string } } }).update.status.state)).toEqual(['submitted']);
    expect(home.readAudit().filter((a) => a.gate !== 'auto-approve')).toEqual([]);
  });

  it('expires: at its time the gates close again, and the end is audited', async () => {
    const past = new Date(Date.now() - 2 * 3_600_000);
    setAutoApprove(home, subjectOf(f.agent), PEER, new Date(Date.now() - 3_600_000).toISOString(), past);
    const { task } = await arrive();
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAutoApprove()).toEqual({});
    expect(home.readAudit().at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'expired', peer: PEER });
    // One that is still running holds until then, and not a moment past it.
    const until = new Date(Date.now() + 60_000);
    const e = setAutoApprove(home, subjectOf(f.agent), PEER, until.toISOString()).entry;
    expect(checkAutoApprove(e, subjectOf(f.agent), PEER, new Date(until.getTime() - 1), ownerBinding(home)).ok).toBe(true);
    expect(checkAutoApprove(e, subjectOf(f.agent), PEER, until, ownerBinding(home))).toEqual({ ok: false, reason: 'expired' });
  });

  it('fails closed on a future-dated, NaN, malformed or forged entry, and on an unreadable clock', async () => {
    const s = subjectOf(f.agent);
    const good = setAutoApprove(home, s, PEER, null).entry;
    const now = new Date();
    expect(checkAutoApprove(good, s, PEER, new Date(NaN), ownerBinding(home))).toEqual({ ok: false, reason: 'clock' });
    // Set in the future (a clock that went back): nothing, even with a valid MAC.
    const future = setAutoApprove(home, s, PEER, null, new Date(Date.now() + 3_600_000)).entry;
    expect(checkAutoApprove(future, s, PEER, now, ownerBinding(home))).toEqual({ ok: false, reason: 'invalid' });
    // Edited by hand (a later expiry, NaN, another peer): the MAC no longer matches.
    for (const bad of [{ until: '2999-01-01T00:00:00Z' }, { set: 'NaN' }, { until: 'not a time' }, { peer: OTHER }, { mode: 'some' }, { v: 2 }, { mac: '00'.repeat(32) }]) {
      expect(checkAutoApprove({ ...good, ...bad } as AutoApproveEntry, s, PEER, now, ownerBinding(home)).ok, JSON.stringify(bad)).toBe(false);
    }
    // Under another agent's key (copied from another home): nothing.
    expect(checkAutoApprove(good, subjectOf(fake().agent), PEER, now, ownerBinding(home))).toEqual({ ok: false, reason: 'invalid' });
    // A forged file in the home approves nothing, and is removed and audited at the gate.
    home.writeAutoApprove({ [PEER]: { ...good, until: '2999-01-01T00:00:00Z' } });
    const { task } = await arrive();
    expect(task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'invalid' });
    // An unreadable file approves nobody.
    writeFileSync(home.autoApprovePath, '{ torn');
    expect((await arrive()).task().gate).toMatchObject({ kind: 'start' });
    expect(sweepAutoApprove(home, s).error).toContain('no contact is on auto-approve');
  });

  it('turning it off takes effect at once: a task it already started has its result held for the human', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const { id, task } = await arrive();
    expect(task().state).toBe('working');
    // A task that waited at the gate before it was set is not approved after the fact either.
    turnOffAutoApprove(home, PEER);
    const waiting = await arrive();
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect(waiting.task().gate).toMatchObject({ kind: 'start' });
    expect(turnOffAutoApprove(home, PEER)).toBe(true);
    expect(turnOffAutoApprove(home, PEER)).toBe(false);
    f.sent.length = 0;
    const r = await submitDraft(home, f.agent, registry, id, { kind: 'artifact', parts: [{ kind: 'text', text: RESULT }], complete: true });
    expect(r.autoReleased).toBeUndefined();
    expect(r.held).toBeDefined();
    expect(f.sent).toEqual([]);
    expect(home.readAudit().filter((a) => a.action === 'off').map((a) => [a.reason, a.by])).toEqual([
      ['owner', 'human'],
      ['owner', 'human'],
    ]);
    // The human still releases it by hand, audited as theirs.
    await approveRelease(home, f.agent, registry, id, releaseDigest(task(), r.held)!);
    expect(home.readAudit().at(-1)).toMatchObject({ gate: 'release', by: 'human', task: id });
  });

  it('ends with the grant it was set on: revoked, blocked, widened or re-granted, or a fork', async () => {
    const cases: Array<[string, () => void, string]> = [
      ['revoked (or revoked for abuse)', () => f.contacts.delete(PEER), 'revoked'],
      ['blocked', () => f.blocked.add(PEER), 'blocked'],
      ['widened', () => (f.contacts.get(PEER)!.inboundScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {}, 'https://example.com/ext/more/v1': {} } }), 'grant-changed'],
      ['re-granted', () => (f.contacts.get(PEER)!.grantId = uuid()), 'grant-changed'],
      ['a fork or rollback', () => f.refused.add(PEER), 'fork'],
    ];
    for (const [name, change, reason] of cases) {
      f = fake();
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      change();
      const ended = sweepAutoApprove(home, subjectOf(f.agent));
      expect(ended.ended, name).toEqual([{ peer: PEER, reason }]);
      expect(home.readAutoApprove(), name).toEqual({});
      expect(home.readAudit().at(-1), name).toMatchObject({ gate: 'auto-approve', action: 'off', reason });
    }
    // Checked at the gate too, without a sweep in between.
    f = fake();
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    f.contacts.get(PEER)!.inboundScope = { invoke: { [REQUEST_URI]: {}, [CAP.uri]: {}, 'https://example.com/ext/more/v1': {} } };
    expect((await arrive()).task().gate).toMatchObject({ kind: 'start' });
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'grant-changed' });
  });

  describe('a grant our human changes keeps it for what it still covers (issue #93)', () => {
    const MORE = 'https://example.com/ext/more/v1';
    const BOTH = [CAP.uri, REQUEST_URI]; // as covered() lists them (sorted)
    /** Our human's grant, as commands.ts and rdv-mcp apply it: the new scope (and a new grant ID for a re-grant) under the keep path. */
    const regrant = (scope: GrantScope, newGrant = false, via: 'cli' | 'mcp' = 'cli') =>
      grantKeepingAutoApprove(
        home,
        subjectOf(f.agent),
        PEER,
        async () => {
          const c = f.contacts.get(PEER)!;
          c.inboundScope = scope;
          if (newGrant) {
            c.grantId = uuid();
            c.since = new Date().toISOString();
          }
          return c;
        },
        via,
      );
    const lastKeep = () => home.readAudit().filter((a) => a.action === 'keep').at(-1);

    it('widened: what it covered stays auto-approved, the new capability asks; audited, shown, and the sweep keeps it', async () => {
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      const r = await regrant({ invoke: { [REQUEST_URI]: {}, [CAP.uri]: {}, [MORE]: {} } }, false, 'mcp');
      expect(r.autoApprove).toEqual({ capabilities: BOTH, uncovered: [MORE], dropped: [], ended: false });
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, REQUEST_URI)).toBe(true);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(true);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, MORE)).toBe(false);
      expect(sweepAutoApprove(home, subjectOf(f.agent)).ended).toEqual([]);
      expect(lastKeep()).toMatchObject({ gate: 'auto-approve', by: 'human', peer: PEER, capabilities: BOTH, uncovered: [MORE], via: 'mcp', until: null });
      expect(home.readAutoApprove()[PEER].covers).toEqual(BOTH);
      expect(autoApproveStatus(home, subjectOf(f.agent)).get(PEER)).toMatchObject({ capabilities: BOTH, uncovered: [MORE] });
      expect(autoApproveKeptText(PEER, r.autoApprove!)).toMatch(/still covers .*; not covered \(asks you as before\): https:\/\/example.com\/ext\/more\/v1$/);
      expect(autoApproveKeptText(PEER, r.autoApprove!)).not.toMatch(/turn it on|rdv contact auto-approve/);
      // A task under the new capability still waits for the human; one it covered still passes.
      expect((await arrive(PEER, PEER_TEXT, REQUEST_URI)).task().gate).toBeUndefined();
    });

    it('narrowed: coverage narrows for good; granting it back does not cover it again', async () => {
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      const narrow = await regrant({ invoke: { [REQUEST_URI]: {} } });
      expect(narrow.autoApprove).toEqual({ capabilities: [REQUEST_URI], uncovered: [], dropped: [CAP.uri], ended: false });
      expect(lastKeep()).toMatchObject({ capabilities: [REQUEST_URI], dropped: [CAP.uri] });
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(false);
      const back = await regrant({ invoke: { [REQUEST_URI]: {}, [CAP.uri]: {} } });
      expect(back.autoApprove).toMatchObject({ capabilities: [REQUEST_URI], uncovered: [CAP.uri] });
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(false);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, REQUEST_URI)).toBe(true);
    });

    it('re-granted on the same terms (a new grant ID): still on, same coverage, same expiry; the same grant again writes nothing', async () => {
      const until = new Date(Date.now() + 3_600_000).toISOString();
      const set = setAutoApprove(home, subjectOf(f.agent), PEER, until);
      const same = f.contacts.get(PEER)!.inboundScope!;
      const r = await regrant(same, true);
      expect(r.autoApprove).toEqual({ capabilities: BOTH, uncovered: [], dropped: [], ended: false });
      const e = home.readAutoApprove()[PEER];
      expect(e).toMatchObject({ grantId: f.contacts.get(PEER)!.grantId, until, set: set.entry.set });
      expect(e.mac).not.toBe(set.entry.mac);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(true);
      expect(lastKeep()).toMatchObject({ until });
      const lines = home.readAudit().length;
      await regrant(same);
      expect(home.readAudit().length).toBe(lines);
      // The expiry still ends it.
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri, new Date(Date.now() + 7_200_000))).toBe(false);
      expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'expired' });
    });

    it('a grant that leaves nothing it covered: off, ended by the sweep and audited', async () => {
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      const r = await regrant({ invoke: { [MORE]: {} } });
      expect(r.autoApprove).toEqual({ capabilities: [], uncovered: [MORE], dropped: BOTH, ended: true });
      expect(autoApproveKeptText(PEER, r.autoApprove!)).toMatch(/is off/);
      expect(sweepAutoApprove(home, subjectOf(f.agent)).ended).toEqual([{ peer: PEER, reason: 'grant-changed' }]);
      expect(home.readAutoApprove()).toEqual({});
    });

    it('fails closed: an entry that did not hold before the grant is not rebound; nor one changed meanwhile, nor after a fork, block or new passphrase', async () => {
      const set = setAutoApprove(home, subjectOf(f.agent), PEER, null);
      home.writeAutoApprove({ [PEER]: { ...set.entry, mac: 'ab'.repeat(32) } });
      expect((await regrant({ invoke: { [REQUEST_URI]: {} } }, true)).autoApprove).toBeNull();
      expect(home.readAutoApprove()).toEqual({});
      expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'invalid' });
      // Bound to a grant that changed some other way (not through this path): off before the grant, never rebound.
      f = fake();
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      f.contacts.get(PEER)!.grantId = uuid();
      expect((await regrant({ invoke: { [REQUEST_URI]: {} } }, true)).autoApprove).toBeNull();
      expect(home.readAutoApprove()).toEqual({});
      // The grant step itself blocks or forks: nothing is rebound, the sweep ends it.
      for (const [hit, reason] of [
        [() => f.blocked.add(PEER), 'blocked'],
        [() => f.refused.add(PEER), 'fork'],
      ] as const) {
        f = fake();
        setAutoApprove(home, subjectOf(f.agent), PEER, null);
        const r = await grantKeepingAutoApprove(home, subjectOf(f.agent), PEER, async () => {
          hit();
        });
        expect(r.autoApprove).toBeNull();
        expect(sweepAutoApprove(home, subjectOf(f.agent)).ended).toEqual([{ peer: PEER, reason }]);
      }
      // The passphrase changes while the grant is applied: not rebound under it.
      f = fake();
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      const r = await grantKeepingAutoApprove(home, subjectOf(f.agent), PEER, async () => {
        f.contacts.get(PEER)!.grantId = uuid();
        await storeOwnerSecret(home, 'ANOTHER-OWNER-PASS 99');
      });
      expect(r.autoApprove).toBeNull();
      sweepAutoApprove(home, subjectOf(f.agent));
      expect(home.readAutoApprove()).toEqual({});
      expect(home.readAudit().filter((a) => a.action === 'keep')).toEqual([]);
    });

    it('a grant from the peer changes nothing: a reverse grant moves only what we may do towards it', () => {
      setAutoApprove(home, subjectOf(f.agent), PEER, null);
      const before = home.readAutoApprove()[PEER];
      const c = f.contacts.get(PEER)!;
      c.outboundScope = { may_initiate: true, may_propose_meetings: true, invoke: { [MORE]: {} } };
      c.reverseGrantId = uuid();
      expect(sweepAutoApprove(home, subjectOf(f.agent)).ended).toEqual([]);
      expect(home.readAutoApprove()[PEER]).toEqual(before);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, MORE)).toBe(false);
      expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(true);
    });

    it('a contact not on auto-approve: the grant goes through and nothing is written', async () => {
      const r = await regrant({ invoke: { [REQUEST_URI]: {} } }, true);
      expect(r.autoApprove).toBeNull();
      expect(home.readAutoApprove()).toEqual({});
      expect(home.readAudit()).toEqual([]);
    });
  });

  it('is only for a contact our human granted something: nothing to cover is refused', () => {
    f.contacts.set(PEER, { ...granted(PEER), inboundGranted: false } as Contact);
    expect(() => setAutoApprove(home, subjectOf(f.agent), PEER, null)).toThrow(/not granted/);
    f.contacts.set(PEER, granted(PEER, { invoke: {} }));
    expect(() => setAutoApprove(home, subjectOf(f.agent), PEER, null)).toThrow(/allows no task capability/);
    expect(() => setAutoApprove(home, subjectOf(f.agent), generateKey().id, null)).toThrow(/no active contact/);
    expect(home.readAutoApprove()).toEqual({});
  });

  it('never covers groups: a scope that lists the groups extension gets nothing for it, and only it is nothing to cover (issue #77, §5.5.1)', () => {
    f.contacts.set(PEER, granted(PEER, { invoke: { [GROUPS_EXTENSION]: {} } }));
    expect(() => setAutoApprove(home, subjectOf(f.agent), PEER, null)).toThrow(/allows no task capability/);
    f.contacts.set(PEER, granted(PEER, { invoke: { [GROUPS_EXTENSION]: {}, [REQUEST_URI]: {} } }));
    const r = setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect(r.capabilities).toEqual([REQUEST_URI]);
    expect(r.entry.covers).not.toContain(GROUPS_EXTENSION);
    expect(autoApproveWarning(f.contacts.get(PEER)!, r.capabilities, null)).not.toContain(GROUPS_EXTENSION);
  });

  it('covers the meeting confirm only while the grant allows meetings and the entry holds (issue #44)', () => {
    // A grant without meetings: tasks are covered, meetings are not.
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(false);
    turnOffAutoApprove(home, PEER);
    // Meetings allowed (and nothing else): that alone is something to cover, listed in the warning.
    f.contacts.set(PEER, granted(PEER, { invoke: { [MEETINGS_CAPABILITY]: {}, [MEETING_CANCEL_CAPABILITY]: {} }, may_propose_meetings: true }));
    const r = setAutoApprove(home, subjectOf(f.agent), PEER, new Date(Date.now() + 60_000).toISOString(), new Date(), 'mcp');
    expect(r.capabilities).toEqual([MEETINGS_CAPABILITY]); // never meeting-cancel
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'set', via: 'mcp' });
    expect(autoApproveWarning(f.contacts.get(PEER)!, r.capabilities, null)).toMatch(/a dinner this contact proposes is accepted and confirmed/);
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(true);
    // Expired: off, removed and audited, like at a task gate.
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER, new Date(Date.now() + 120_000))).toBe(false);
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'expired' });
    // Off for everyone at once (MCP's all_contacts), audited per contact.
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    f.contacts.set(OTHER, granted(OTHER));
    setAutoApprove(home, subjectOf(f.agent), OTHER, null);
    expect(turnOffAllAutoApprove(home, new Date(), 'mcp').sort()).toEqual([PEER, OTHER].sort());
    expect(home.readAutoApprove()).toEqual({});
    expect(home.readAudit().slice(-2).map((a) => [a.action, a.reason, a.via])).toEqual([
      ['off', 'owner', 'mcp'],
      ['off', 'owner', 'mcp'],
    ]);
  });

  it('covers at most what the owner was shown (stored, MACed), intersected with the grant now (issue #44 review)', () => {
    const resign = (e: AutoApproveEntry, change: (b: Omit<AutoApproveEntry, 'mac'>) => void) => {
      const { mac: _mac, ...body } = structuredClone(e);
      change(body);
      const mac = createHmac('sha256', f.agent.key.secretKey).update(`rdv1/auto-approve\0${stable(body)}`).digest('hex');
      home.writeAutoApprove({ [PEER]: { ...body, mac } as AutoApproveEntry });
    };
    const wide: GrantScope = { invoke: { [MEETINGS_CAPABILITY]: {}, [REQUEST_URI]: {}, [CAP.uri]: {} }, may_propose_meetings: true };
    f.contacts.set(PEER, granted(PEER, wide));
    const set = setAutoApprove(home, subjectOf(f.agent), PEER, null);
    expect(set.entry.covers).toEqual(set.capabilities);
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(true);

    // An entry from before issue #44 (no `covers`): tasks as before, never the meeting confirm it was not set for.
    resign(set.entry, (b) => delete b.covers);
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(false);
    expect(autoApprovedFor(home, subjectOf(f.agent), PEER, REQUEST_URI)).toBe(true);

    // Stored without meetings, though the grant now allows them: no meeting confirm.
    resign(set.entry, (b) => (b.covers = [REQUEST_URI, CAP.uri]));
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(false);
    expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(true);
    // A stored list that is not a list of strings approves nothing.
    resign(set.entry, (b) => (b.covers = [42] as unknown as string[]));
    expect(autoApprovedFor(home, subjectOf(f.agent), PEER, REQUEST_URI)).toBe(false);

    // A narrower grant: coverage is the intersection, never more than the grant (an entry bound to the narrower scope).
    const narrow: GrantScope = { invoke: { [REQUEST_URI]: {} } };
    f.contacts.get(PEER)!.inboundScope = narrow;
    resign(set.entry, (b) => (b.scope = scopeDigest(narrow)));
    const r = checkAutoApprove(home.readAutoApprove()[PEER], subjectOf(f.agent), PEER, new Date(), ownerBinding(home));
    expect(r.ok && r.capabilities).toEqual([REQUEST_URI]);
    expect(autoApprovedFor(home, subjectOf(f.agent), PEER, CAP.uri)).toBe(false);
    expect(meetingAutoApproved(home, subjectOf(f.agent), PEER)).toBe(false);
    // And a real narrowing of the grant the entry was set on ends it outright (the scope binding).
    f.contacts.set(PEER, granted(PEER, wide));
    const again = setAutoApprove(home, subjectOf(f.agent), PEER, null);
    f.contacts.get(PEER)!.inboundScope = narrow;
    f.contacts.get(PEER)!.grantId = again.entry.grantId;
    expect(autoApprovedFor(home, subjectOf(f.agent), PEER, REQUEST_URI)).toBe(false);
    expect(home.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'grant-changed' });
  });

  it('the scope binding is the grant as shown: same scope, same digest', () => {
    expect(scopeDigest({ invoke: { a: {} } })).toBe(scopeDigest({ invoke: { a: {} } }));
    expect(scopeDigest({ invoke: { a: {} } })).not.toBe(scopeDigest({ invoke: { a: {}, b: {} } }));
  });

  it('audit.jsonl rotation keeps the newest auto-approve lines', async () => {
    setAutoApprove(home, subjectOf(f.agent), PEER, null);
    const e = { ts: new Date().toISOString(), peer: PEER, capability: REQUEST_URI, gate: 'start' as const, by: 'auto-approve' as const };
    for (let i = 0; i < 2 * AUDIT_KEPT + 3; i++) home.appendAudit([{ ...e, task: String(i) }]);
    const lines = home.readAudit();
    expect(lines.length).toBeLessThanOrEqual(2 * AUDIT_KEPT);
    expect(lines.length).toBeGreaterThanOrEqual(AUDIT_KEPT);
    expect(lines.at(-1)?.task).toBe(String(2 * AUDIT_KEPT + 2));
    expect(lines.some((l) => l.action === 'set')).toBe(false); // rotated out with the oldest
  });
});

// --- the owner's command, between two real `rdv` processes ------------------------------

/** A terminal that answers `answer` and records what it was shown. */
function tty(answer: string | string[], interactive = true): Tty & { shown: string[]; secrets: number } {
  const shown: string[] = [];
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const next = () => (answers.length > 1 ? answers.shift()! : answers[0]);
  const t = {
    interactive,
    shown,
    secrets: 0,
    say: (x: string) => void shown.push(x),
    ask: async (q: string) => (shown.push(q), next()),
    secret: async (q: string) => (t.secrets++, shown.push(q), next()),
  };
  return t;
}

const PASS = 'OWNER-PASS correct horse';

describe('rdv contact auto-approve and rdv audit', () => {
  let relay: TestRelay;
  let root: string;
  beforeAll(async () => {
    relay = await startTestRelay();
    root = mkdtempSync(join(tmpdir(), 'rdv-auto-cmd-'));
  });
  afterAll(async () => {
    await relay.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('rdv init offers the owner passphrase in a real terminal only; Enter skips; a weak one is not set and init still succeeds', async () => {
    const run = async (name: string, t: ReturnType<typeof tty>) => {
      const h = new Home(join(root, name));
      await init({ home: h, out: new Output(true), values: { email: [`${name}@example.com`], relay: [relay.url] }, positionals: [], tty: t });
      return h;
    };
    const piped = tty(PASS, false);
    expect(hasOwnerSecret(await run('init-piped', piped))).toBe(false);
    expect(piped.secrets).toBe(0);
    const skipped = tty('');
    expect(hasOwnerSecret(await run('init-skip', skipped))).toBe(false);
    expect(skipped.secrets).toBe(1);
    expect(hasOwnerSecret(await run('init-weak', tty('short')))).toBe(false);
    const set = tty(PASS);
    const h = await run('init-set', set);
    expect(hasOwnerSecret(h)).toBe(true);
    expect(set.shown.join('\n')).not.toContain(PASS);
    expect(h.readAudit().map((a) => [a.gate, a.action])).toEqual([['owner-secret', 'set']]);
    // Spawned (no terminal): init works and never asks.
    const spawned = await rdv(['init', '--profile', 'x', '--email', 'x@example.com', '--relay', relay.url], join(root, 'init-spawned'));
    expect(spawned.code).toBe(0);
    expect(existsSync(new Home(join(root, 'init-spawned')).ownerSecretPath)).toBe(false);
  });

  it('needs the owner’s terminal and passphrase; then John’s agent works and answers Omer’s task without asking, and off restores the gates', async () => {
    const omerHome = join(root, 'omer');
    const johnHome = join(root, 'john');
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], omerHome);
    await rdv(['init', '--profile', 'john', '--email', 'john@doe.com', '--relay', relay.url], johnHome);
    const cardFile = join(root, 'john-card.json');
    writeFileSync(cardFile, JSON.stringify((await rdv(['whoami'], johnHome)).lines[0].card));
    const johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    const omerL = new Listener('omer', omerHome);
    const john = new Home(johnHome);
    const ctx = (positionals: string[], t?: Tty, values: Record<string, string> = {}) => ({ home: john, out: new Output(true), values, positionals, ...(t ? { tty: t } : {}) });
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', cardFile], omerHome);
      const johnId = (await omerL.waitFor((l) => l.event === 'contact', 'omer contact', 10_000)).peer as string;
      const omerId = (await rdv(['whoami'], omerHome)).lines[0].id as string;
      await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome);
      await omerL.waitFor((l) => l.event === 'reverse-grant', 'omer gets the reverse grant', 10_000);

      // Not a terminal (an assistant's shell, a script, a pipe): refused, nothing set.
      const piped = await rdv(['contact', 'auto-approve', omerId, 'all'], johnHome, { check: false });
      expect([piped.code, piped.stderr]).toEqual([1, expect.stringContaining('interactive terminal')]);
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(PASS, false)))).rejects.toThrow(/interactive terminal/);
      // No owner passphrase yet: refused before anything is asked (issue #47).
      const unset = tty(fingerprint(omerId));
      await expect(contactAutoApprove(ctx([omerId, 'all'], unset))).rejects.toThrow(/rdv owner-secret set/);
      expect(unset.secrets).toBe(0);
      // Setting it: an interactive terminal only (spawned rdv has none), typed twice, not too short.
      const pipedSet = await rdv(['owner-secret', 'set'], johnHome, { check: false });
      expect([pipedSet.code, pipedSet.stderr]).toEqual([1, expect.stringContaining('interactive terminal')]);
      await expect(ownerSecretSet(ctx([], tty(PASS, false)))).rejects.toThrow(/interactive terminal/);
      await expect(ownerSecretSet(ctx([], tty('short')))).rejects.toThrow(/at least 8/);
      await expect(ownerSecretSet(ctx([], tty([PASS, `${PASS}!`])))).rejects.toThrow(/did not match/);
      expect(existsSync(john.ownerSecretPath)).toBe(false);
      const setTty = tty(PASS);
      await ownerSecretSet(ctx([], setTty));
      expect(setTty.shown.join('\n')).not.toContain(PASS);
      if (process.platform !== 'win32') expect(statSync(john.ownerSecretPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(john.ownerSecretPath, 'utf8')).not.toContain(PASS);
      // Changing it needs the current one.
      await expect(ownerSecretSet(ctx([], tty(['not the current one', 'NEW-PASS 12345', 'NEW-PASS 12345'])))).rejects.toThrow(/wrong owner passphrase/);
      // The warning comes first; the prompt holds no answer; the old answer (the fingerprint it used to print) and a wrong passphrase set nothing.
      const wrong = tty(fingerprint(omerId));
      await expect(contactAutoApprove(ctx([omerId, 'all'], wrong))).rejects.toThrow(/wrong owner passphrase/);
      expect(wrong.shown[0]).toMatch(/WARNING: auto-approve-all/);
      expect(wrong.shown[0]).toMatch(/prompt injection/);
      expect(wrong.shown[0]).toContain(REQUEST_URI);
      expect(wrong.shown[0]).toContain(`rdv contact auto-approve ${omerId} off`);
      expect(wrong.shown.join('\n')).not.toContain(PASS);
      expect(wrong.shown.at(-1)).not.toContain(fingerprint(omerId));
      expect(wrong.secrets).toBe(1);
      expect(john.readAutoApprove()).toEqual({});
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty('')))).rejects.toThrow(/canceled/);
      await expect(contactAutoApprove(ctx([omerId, 'sometimes'], tty('x')))).rejects.toThrow(/"all"/);
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(PASS), { until: 'yesterday' }))).rejects.toThrow(/--until/);

      const right = tty(PASS);
      await contactAutoApprove(ctx([omerId, 'all'], right, { until: '7d' }));
      expect(right.shown.join('\n')).not.toContain(PASS);
      const listed = (await rdv(['contact', 'list'], johnHome)).lines[0];
      expect(listed.auto_approve).toMatchObject({ mode: 'all', until: expect.any(String) });

      // Omer asks; John's agent starts it without asking, and its result leaves without asking.
      const req = await rdv(['task', 'request', johnId, '--text', PEER_TEXT], omerHome);
      const taskId = req.lines.find((l) => l.kind === 'requested')!.task as string;
      const started = await johnL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'started' && l.auto_approved === true, 'auto start (john)', 10_000);
      expect(started.auto_approved).toBe(true);
      expect(johnL.lines.some((l) => l.task === taskId && l.kind === 'start-needed')).toBe(false);
      const sub = await rdv(['task', 'submit', taskId, '--text', RESULT, '--complete'], johnHome);
      expect(sub.lines.some((l) => l.event === 'task-auto-released')).toBe(true);
      const got = await omerL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'artifact', 'the result (omer)', 10_000);
      expect(got.peer_text).toEqual([RESULT]);

      const log = (await rdv(['audit', '--contact', omerId], johnHome)).lines;
      expect(log.map((a) => [a.gate, a.action ?? a.by])).toEqual([
        ['auto-approve', 'set'],
        ['start', 'auto-approve'],
        ['release', 'auto-approve'],
      ]);
      expect(JSON.stringify(log)).not.toContain('PEER-WROTE-THIS');
      expect((await rdv(['audit', '--since', '1h'], johnHome)).lines.length).toBeGreaterThanOrEqual(3);
      expect((await rdv(['audit', '--since', 'soon'], johnHome, { check: false })).code).toBe(2);

      // Off, from any terminal (reduce-only): the next task waits for John again.
      const off = await rdv(['contact', 'auto-approve', omerId, 'off'], johnHome);
      expect(off.lines[0]).toMatchObject({ auto_approve: 'off', was_on: true });
      const req2 = await rdv(['task', 'request', johnId, '--text', 'another'], omerHome);
      const t2 = req2.lines.find((l) => l.kind === 'requested')!.task as string;
      await johnL.waitFor((l) => l.event === 'task' && l.task === t2 && l.kind === 'start-needed', 'gated again (john)', 10_000);
      expect((await rdv(['audit'], johnHome)).lines.at(-1)).toMatchObject({ gate: 'auto-approve', action: 'off', reason: 'owner' });

      // The first passphrase is trust on first use: audited, and whoami shows when it was set and how to reset it.
      expect(john.readAudit().filter((a) => a.gate === 'owner-secret').map((a) => [a.action, a.by, a.peer])).toEqual([['set', 'human', 'owner']]);
      const who = (await rdv(['whoami'], johnHome)).lines[0];
      expect(who.owner_passphrase).toMatchObject({ set: expect.any(String), note: expect.stringContaining('rdv owner-secret reset') });
      expect(JSON.stringify(who)).not.toContain(PASS);
      // Reset: your own terminal only; turns every contact's auto-approve off first, forgets it, offers a new one.
      const pipedReset = await rdv(['owner-secret', 'reset'], johnHome, { check: false });
      expect([pipedReset.code, pipedReset.stderr]).toEqual([1, expect.stringContaining('interactive terminal')]);
      await contactAutoApprove(ctx([omerId, 'all'], tty(PASS)));
      await expect(ownerSecretReset(ctx([], tty('no')))).rejects.toThrow(/canceled/);
      expect(Object.keys(john.readAutoApprove())).toEqual([omerId]);
      // Reset only clears: it never asks for a new one (a reset is no way around the current passphrase).
      const resetTty = tty(['RESET', PASS, PASS]);
      await ownerSecretReset(ctx([], resetTty));
      expect(resetTty.secrets).toBe(0);
      expect(john.readAutoApprove()).toEqual({});
      expect(hasOwnerSecret(john)).toBe(false);
      expect(john.readAudit().slice(-2).map((a) => [a.gate, a.action])).toEqual([
        ['auto-approve', 'off'],
        ['owner-secret', 'reset'],
      ]);
      // A banner in whoami (first line) and its JSON, until a new one is set.
      expect((await rdv(['whoami'], johnHome)).lines[0].owner_passphrase).toMatchObject({ set: null, reset: expect.any(String), note: expect.stringMatching(/OWNER PASSPHRASE RESET .*someone with access/) });
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(PASS)))).rejects.toThrow(/rdv owner-secret set/);
      await expect(ownerSecretReset(ctx([], tty('RESET')))).rejects.toThrow(/nothing to reset/);
      // A new passphrase only after the cooldown, in a separate run of set.
      await expect(ownerSecretSet(ctx([], tty(PASS)))).rejects.toThrow(/reset: a new one can be set after/);
      expect(hasOwnerSecret(john)).toBe(false);
      writeFileSync(john.ownerSecretPath, JSON.stringify({ v: 1, reset: new Date(Date.now() - 11 * 60_000).toISOString() }));
      await ownerSecretSet(ctx([], tty(PASS)));
      expect(john.readAudit().slice(-2).map((a) => [a.gate, a.action])).toEqual([
        ['owner-secret', 'reset'],
        ['owner-secret', 'set'],
      ]);
      // Reset is refused while the passphrase is locked after wrong answers.
      for (let i = 0; i < 3; i++) await expect(contactAutoApprove(ctx([omerId, 'all'], tty('wrong wrong')))).rejects.toThrow(/wrong owner passphrase/);
      await expect(ownerSecretReset(ctx([], tty('RESET')))).rejects.toThrow(/too many wrong/);
      expect(hasOwnerSecret(john)).toBe(true);
      const unlocked = JSON.parse(readFileSync(john.ownerSecretPath, 'utf8'));
      writeFileSync(john.ownerSecretPath, JSON.stringify({ ...unlocked, failures: 0, locked_until: undefined }));

      // Changing the passphrase ends auto-approve set under the old one; set says which, and it stays off.
      await contactAutoApprove(ctx([omerId, 'all'], tty(PASS)));
      await ownerSecretSet(ctx([], tty([PASS, 'NEW-PASS 12345', 'NEW-PASS 12345'])));
      expect(john.readAutoApprove()).toEqual({});
      expect(john.readAudit().slice(-2).map((a) => [a.gate, a.action, a.reason ?? null])).toEqual([
        ['auto-approve', 'off', 'owner-secret'],
        ['owner-secret', 'changed', null],
      ]);

      // Revoking the contact also ends it, audited when the command saves.
      await contactAutoApprove(ctx([omerId, 'all'], tty('NEW-PASS 12345')));
      await rdv(['contact', 'revoke', omerId], johnHome);
      expect(john.readAutoApprove()).toEqual({});
      expect(john.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'revoked' });
      // A logged line is not output of `audit`'s own terminal: text mode works too.
      await audit(ctx([], undefined, {}));

      // owner-secret.json and audit.jsonl both deleted: the marker (MACed with the agent key) still says one existed,
      // so it counts as a reset: the banner, the cooldown, and auto-approve refused.
      expect(existsSync(john.ownerSecretMarkerPath)).toBe(true);
      expect(readFileSync(john.ownerSecretMarkerPath, 'utf8')).not.toContain('NEW-PASS');
      rmSync(john.ownerSecretPath);
      rmSync(john.auditPath);
      const banner = (await rdv(['whoami'], johnHome)).lines[0].owner_passphrase;
      expect(banner).toMatchObject({ set: null, missing: true, note: expect.stringMatching(/OWNER PASSPHRASE FILE DELETED/) });
      await expect(ownerSecretSet(ctx([], tty(PASS)))).rejects.toThrow(/reset: a new one can be set after/);
      await expect(contactAutoApprove(ctx([omerId, 'all'], tty(PASS)))).rejects.toThrow(/rdv owner-secret set/);
      // A marker not MACed by this agent (written by hand, or copied from another home) says nothing.
      rmSync(john.ownerSecretPath);
      writeFileSync(john.ownerSecretMarkerPath, JSON.stringify({ v: 1, first: new Date().toISOString(), mac: 'ab'.repeat(32) }));
      expect(hasOwnerSecret(john)).toBe(false);
      expect(existsSync(john.ownerSecretPath)).toBe(false);
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  });

  it('rdv contact grant keeps it for what it still covers (issue #93): widened, narrowed, re-granted; the peer’s own grant changes nothing', async () => {
    const MORE = 'https://example.com/ext/more/v1';
    const omerHome = join(root, 'omer-keep');
    const johnHome = join(root, 'john-keep');
    await rdv(['init', '--profile', 'omer', '--email', 'omer-keep@example.com', '--relay', relay.url], omerHome);
    await rdv(['init', '--profile', 'john', '--email', 'john-keep@doe.com', '--relay', relay.url], johnHome);
    const cardFile = join(root, 'john-keep-card.json');
    writeFileSync(cardFile, JSON.stringify((await rdv(['whoami'], johnHome)).lines[0].card));
    const johnL = new Listener('john', johnHome, ['--auto-grant', 'friend', '--auto-grant-any-tier']);
    const omerL = new Listener('omer', omerHome);
    const john = new Home(johnHome);
    const ctx = (positionals: string[], t?: Tty) => ({ home: john, out: new Output(true), values: {}, positionals, ...(t ? { tty: t } : {}) });
    try {
      await johnL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await omerL.waitFor((l) => l.event === 'ready', 'ready', 10_000);
      await rdv(['contact', 'request', cardFile], omerHome);
      const johnId = (await omerL.waitFor((l) => l.event === 'contact', 'omer contact', 10_000)).peer as string;
      const omerId = (await rdv(['whoami'], omerHome)).lines[0].id as string;
      await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome);
      await ownerSecretSet(ctx([], tty(PASS)));
      await contactAutoApprove(ctx([omerId, 'all'], tty(PASS)));
      const covers = (j: Record<string, unknown>) => (j.auto_approve as { covers: string[] }).covers;

      // Widened: meetings and the request capability stay covered; the new one is not, and the output says so in one line.
      const wide = await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI, '--invoke', MORE], johnHome);
      expect(wide.lines[0].auto_approve).toEqual({ covers: [MEETINGS_CAPABILITY, REQUEST_URI], not_covered: [MORE] });
      const listed = (await rdv(['contact', 'list'], johnHome)).lines[0];
      expect(listed.auto_approve).toMatchObject({ mode: 'all', covers: [MEETINGS_CAPABILITY, REQUEST_URI], not_covered: [MORE] });
      expect((await rdv(['audit', '--contact', omerId], johnHome)).lines.filter((a) => a.action === 'keep').at(-1)).toMatchObject({ by: 'human', via: 'cli', uncovered: [MORE] });

      // A task under a covered capability still starts without asking.
      const req = await rdv(['task', 'request', johnId, '--text', PEER_TEXT], omerHome);
      const taskId = req.lines.find((l) => l.kind === 'requested')!.task as string;
      await johnL.waitFor((l) => l.event === 'task' && l.task === taskId && l.kind === 'started' && l.auto_approved === true, 'auto start (john)', 10_000);

      // Omer's own grant to John (a reverse grant): what John may do towards Omer; John's auto-approve is untouched.
      const entry = john.readAutoApprove()[omerId];
      await rdv(['contact', 'grant', johnId, '--invoke', MORE], omerHome);
      await johnL.waitFor((l) => l.event === 'reverse-grant', 'john gets the reverse grant', 10_000);
      expect(john.readAutoApprove()[omerId]).toEqual(entry);

      // Narrowed (no meetings): just the request capability.
      const narrow = await rdv(['contact', 'grant', omerId, '--no-meetings', '--invoke', REQUEST_URI], johnHome);
      expect(covers(narrow.lines[0])).toEqual([REQUEST_URI]);
      // Meetings granted back: not covered again until the owner turns it on for them.
      const back = await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome);
      expect(back.lines[0].auto_approve).toEqual({ covers: [REQUEST_URI], not_covered: [MEETINGS_CAPABILITY] });
      // The same grant again: still on, nothing new in the audit log.
      const lines = john.readAudit().length;
      expect(covers((await rdv(['contact', 'grant', omerId, '--invoke', REQUEST_URI], johnHome)).lines[0])).toEqual([REQUEST_URI]);
      expect(john.readAudit().length).toBe(lines);
      // Narrowed to nothing it covered: off, audited.
      const none = await rdv(['contact', 'grant', omerId, '--no-meetings', '--invoke', MORE], johnHome);
      expect(none.lines[0].auto_approve).toBe('off');
      expect(john.readAutoApprove()).toEqual({});
      expect(john.readAudit().at(-1)).toMatchObject({ action: 'off', reason: 'grant-changed' });
    } finally {
      await Promise.all([johnL.stop(), omerL.stop()]);
    }
  });
});
