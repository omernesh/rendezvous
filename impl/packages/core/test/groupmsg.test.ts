// Groups v1, slice 2 (SPEC §7.8.3, §7.8.5–§7.8.7; issue #78): group messages,
// the per-sender chain, heads and equivocation, group resend, removal and
// leaving, the rate rules, and what a non-member or a forged proof can
// trigger (nothing). The integration part runs three agents on the in-memory
// relay, including design B.5 step 8: a member restored from a backup re-sends
// a gseq with other content, and the others catch it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentEvents,
  type AgentKey,
  createCard,
  createGroupLeave,
  createGroupMsg,
  createGroupState,
  docHash,
  equivocationProof,
  generateKey,
  GROUP_LEAVE_TYPE,
  GROUP_MSG_LIMITS,
  GROUP_MSG_TYPE,
  GROUP_PROOF_TYPE,
  GROUP_REPORT_TYPE,
  GroupBook,
  type GroupContext,
  type GroupMember,
  type GroupMsg,
  type GroupMsgPayload,
  type GroupState,
  GROUPS_EXTENSION,
  groupResend,
  headsOf,
  NostrTransport,
  prepareGroupMessage,
  receiveGroupLeave,
  receiveGroupMessage,
  receiveGroupProof,
  receiveGroupReport,
  resyncMember,
  takeWaiting,
  type Transport,
  verifyGroupLeave,
  verifyGroupMsg,
  verifyGroupMsgPayload,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const T0 = new Date('2026-10-26T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const GROUP = '00000000-0000-4000-8000-0000000000b1';
const hints = [{ type: 'nostr' as const, relay: 'wss://relay.example', pref: 1 }];
const cardOf = (k: AgentKey) => createCard(k, { rendezvous: hints, capabilities: ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION], now: T0 });
const member = (k: AgentKey, role: 'admin' | 'member' = 'member'): GroupMember => ({ id: k.id, role, card: docHash(cardOf(k)) });

function state(signer: AgentKey, epoch: number, prev: GroupState | null, members: GroupMember[], memberRate = '60/hour', at = T0): GroupState {
  return createGroupState(signer, {
    group: GROUP,
    epoch,
    prev: prev ? docHash(prev) : null,
    members,
    policy: { member_rate: memberRate, members_may_invite: false },
    name: 'Microsite launch',
    ts: at.toISOString(),
  });
}

const omer = generateKey();
const john = generateKey();
const dana = generateKey();
const eve = generateKey();
const s0 = state(omer, 0, null, [member(omer, 'admin')]);
const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john), member(dana)]);

const ctx = (me: AgentKey, now = T0): GroupContext => ({ me: me.id, isContact: () => false, now });

/** `me`'s book at state `s`, every other member approved (unless `approved` says otherwise). */
function bookAt(me: AgentKey, s: GroupState = s1, approved?: string[]): GroupBook {
  return new GroupBook({
    groups: {
      [GROUP]: {
        group: GROUP,
        status: 'active',
        state: s,
        history: [{ epoch: s.epoch, hash: docHash(s), from: s.from }],
        joins: {},
        approved: approved ?? s.members.map((m) => m.id).filter((id) => id !== me.id),
        newcomers: {},
        policy: 'ask',
        scope: { invoke: {} },
        joined: T0.toISOString(),
        future: [],
      },
    },
  });
}

/** A board message from `k` at `gseq`, chained to `prev`. */
function board(k: AgentKey, gseq: number, prev: GroupMsg | string | null, text = `#${gseq}`, opts: { at?: Date; s?: GroupState; heads?: Record<string, [number, string]> } = {}): GroupMsgPayload {
  const s = opts.s ?? s1;
  const body = { type: 'note', text };
  const msg = createGroupMsg(k, { group: GROUP, epoch: s.epoch, state: docHash(s), to: '*', gseq, gprev: typeof prev === 'string' ? prev : prev ? docHash(prev) : gseq > 1 ? SOME_PREV : null, heads: opts.heads, body, ts: (opts.at ?? later(gseq * 1000)).toISOString() });
  return { type: GROUP_MSG_TYPE, msg, body };
}

function chainOf(k: AgentKey, n: number, text = (g: number) => `#${g}`): GroupMsgPayload[] {
  const out: GroupMsgPayload[] = [];
  for (let g = 1; g <= n; g++) out.push(board(k, g, out[g - 2]?.msg ?? null, text(g)));
  return out;
}

const NOW = later(60_000);
/** A gprev for a message whose predecessor the test does not need. */
const SOME_PREV = 'a'.repeat(64);

describe('rdv/group-msg: shape, signature, body hash', () => {
  it('a board message carries gseq and gprev; a private one neither; the body is bound by hash', () => {
    const [m1, m2] = chainOf(dana, 2);
    expect(verifyGroupMsgPayload(m1, NOW)).toMatchObject({ ok: true });
    expect(m1.msg.gprev).toBeNull();
    expect(m2.msg.gprev).toBe(docHash(m1.msg));
    // Another body under the same header.
    expect(verifyGroupMsgPayload({ ...m1, body: { type: 'note', text: 'swapped' } }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/not the one the header signs/) });
    const priv = createGroupMsg(dana, { group: GROUP, epoch: 1, state: docHash(s1), to: [john.id], body: { type: 'note', text: 'just you' }, ts: T0.toISOString() });
    expect(priv.gseq).toBeUndefined();
    expect(verifyGroupMsg(priv, NOW)).toMatchObject({ ok: true });
    expect(verifyGroupMsg({ ...priv, gseq: 3 }, NOW)).toMatchObject({ ok: false });
    expect(verifyGroupMsg({ ...m1.msg, extra: 1 }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field/) });
    expect(verifyGroupMsg({ ...m1.msg, gseq: 2 }, NOW)).toMatchObject({ ok: false });
    expect(verifyGroupMsg({ ...m2.msg, from: john.id }, NOW)).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(() => createGroupMsg(dana, { group: GROUP, epoch: 1, state: docHash(s1), to: [dana.id], body: { type: 'note' } })).toThrow(/bad to/);
    expect(() => createGroupMsg(dana, { group: GROUP, epoch: 1, state: docHash(s1), to: '*', gseq: 1, gprev: null, heads: { [john.id]: [0, 'x'] }, body: { type: 'note' } })).toThrow(/heads/);
    expect(() => createGroupMsg(dana, { group: GROUP, epoch: 1, state: docHash(s1), to: '*', gseq: 1, gprev: null, body: { type: 'note', x: 1.5 } })).toThrow(/canonical|integers/);
  });

  it('equivocationProof: the same gseq with other content, or a gprev that is not the other', () => {
    const a = board(dana, 3, null, 'done').msg;
    const b = board(dana, 3, null, 'not started').msg;
    expect(equivocationProof(a, b)).toBe(true);
    expect(equivocationProof(a, a)).toBe(false);
    const [m1, m2] = chainOf(dana, 2);
    expect(equivocationProof(m1.msg, m2.msg)).toBe(false);
    expect(equivocationProof(b, board(dana, 4, a).msg)).toBe(true);
    expect(equivocationProof(a, board(john, 3, null).msg)).toBe(false);
  });
});

describe('the per-sender group chain', () => {
  it('delivers in order, from the first gseq seen; a duplicate is quiet', () => {
    const book = bookAt(john);
    const ms = chainOf(dana, 3);
    // John joined late: the chain starts at the first message he sees.
    const first = receiveGroupMessage(book, ms[1], dana.id, ctx(john, NOW));
    expect(first.delivered.map((d) => d.body.text)).toEqual(['#2']);
    expect(receiveGroupMessage(book, ms[2], dana.id, ctx(john, NOW)).delivered.map((d) => d.body.text)).toEqual(['#3']);
    expect(receiveGroupMessage(book, ms[2], dana.id, ctx(john, NOW))).toMatchObject({ delivered: [], drop: 'group message duplicate' });
    expect(headsOf(book.group(GROUP)!, john.id)).toEqual({ [dana.id]: [3, docHash(ms[2].msg).slice(0, 16)] });
  });

  it('a gap asks the sender for a group resend, keeps what came, and the resend fills it in order', () => {
    const book = bookAt(john);
    const ms = chainOf(dana, 5);
    receiveGroupMessage(book, ms[0], dana.id, ctx(john, NOW));
    const gap = receiveGroupMessage(book, ms[3], dana.id, ctx(john, NOW));
    expect(gap.delivered).toEqual([]);
    expect(gap.send).toEqual([{ to: dana.id, payload: { type: 'rdv/resend', group: GROUP, from_gseq: 2, to_gseq: 3 } }]);
    // Another message beyond the gap does not ask again for what is already asked.
    expect(receiveGroupMessage(book, ms[4], dana.id, ctx(john, NOW)).send).toEqual([]);
    expect(receiveGroupMessage(book, ms[1], dana.id, ctx(john, NOW)).delivered.map((d) => d.body.text)).toEqual(['#2']);
    expect(receiveGroupMessage(book, ms[2], dana.id, ctx(john, NOW)).delivered.map((d) => d.body.text)).toEqual(['#3', '#4', '#5']);
    expect(book.group(GROUP)!.chains![dana.id].gap).toBeUndefined();
  });

  it('a gap that never fills is reported to the human after a while, and the chain moves on', () => {
    const book = bookAt(john);
    const ms = chainOf(dana, 5);
    receiveGroupMessage(book, ms[0], dana.id, ctx(john, NOW));
    receiveGroupMessage(book, ms[3], dana.id, ctx(john, NOW));
    const after = receiveGroupMessage(book, ms[4], dana.id, ctx(john, new Date(NOW.getTime() + GROUP_MSG_LIMITS.gapWaitMs + 1)));
    expect(after.gaps).toEqual([{ group: GROUP, member: dana.id, from: 2, to: 3 }]);
    expect(after.delivered.map((d) => d.body.text)).toEqual(['#4', '#5']);
  });

  it('a group resend answers only a member we send to, with our board messages in the range', () => {
    const book = bookAt(dana, s1, [omer.id]); // Dana has not approved John (ask)
    for (let i = 0; i < 3; i++) prepareGroupMessage(book, dana, GROUP, { type: 'note', text: `${i}` }, { now: later(i) });
    const got = groupResend(book, GROUP, omer.id, 2, 3, dana.id);
    expect(Array.isArray(got) && got.map((p) => p.msg.gseq)).toEqual([2, 3]);
    expect(groupResend(book, GROUP, john.id, 1, 3, dana.id)).toEqual({ rejected: 'not a member we send to' });
    expect(groupResend(book, GROUP, eve.id, 1, 3, dana.id)).toEqual({ rejected: 'not a member we send to' });
    expect(groupResend(book, GROUP, omer.id, 3, 1, dana.id)).toEqual({ rejected: 'bad range' });
  });

  it('private messages: to members we send to only, no gseq; the receiver must be named', () => {
    const book = bookAt(dana, s1, [omer.id]);
    expect(() => prepareGroupMessage(book, dana, GROUP, { type: 'note' }, { to: [john.id] })).toThrow(/not approved/);
    const { payload, recipients } = prepareGroupMessage(book, dana, GROUP, { type: 'note', text: 'only omer' }, { to: [omer.id], now: T0 });
    expect(recipients).toEqual([omer.id]);
    expect(payload.msg.gseq).toBeUndefined();
    expect(book.group(GROUP)!.out).toBeUndefined(); // the board chain is untouched
    const omers = bookAt(omer);
    expect(receiveGroupMessage(omers, payload, dana.id, ctx(omer, NOW)).delivered).toMatchObject([{ board: false, body: { text: 'only omer' } }]);
    expect(receiveGroupMessage(bookAt(john), payload, dana.id, ctx(john, NOW))).toMatchObject({ drop: 'group message not addressed to us' });
  });

  it('board messages go to approved members only (ask), and consume the gseq', () => {
    const book = bookAt(dana, s1, [omer.id]);
    const a = prepareGroupMessage(book, dana, GROUP, { type: 'note' }, { now: T0 });
    const b = prepareGroupMessage(book, dana, GROUP, { type: 'note' }, { now: T0 });
    expect(a.recipients).toEqual([omer.id]);
    expect([a.payload.msg.gseq, b.payload.msg.gseq]).toEqual([1, 2]);
    expect(b.payload.msg.gprev).toBe(docHash(a.payload.msg));
  });
});

describe('epochs', () => {
  const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], '60/hour', later(500));

  it('a newer epoch waits for its state; a state we do not hold is dropped; the previous one is still taken', () => {
    const book = bookAt(john);
    const ahead = board(dana, 1, null, 'ahead', { s: s2 });
    expect(receiveGroupMessage(book, ahead, dana.id, ctx(john, NOW))).toMatchObject({ waiting: true, delivered: [] });
    expect(takeWaiting(book, GROUP)).toEqual([]); // still ahead
    expect(book.receiveState(s2, omer.id, ctx(john, NOW)).kind).toBe('applied');
    const ready = takeWaiting(book, GROUP);
    expect(ready).toHaveLength(1);
    expect(receiveGroupMessage(book, ready[0].payload, ready[0].from, ctx(john, NOW)).delivered.map((d) => d.body.text)).toEqual(['ahead']);
    // Written under s1 (the state before): still taken during the change.
    expect(receiveGroupMessage(book, board(omer, 1, null, 'old epoch'), omer.id, ctx(john, NOW)).delivered).toHaveLength(1);
    // Another state at our epoch, claimed by a member: dropped, nothing frozen (a member cannot freeze the group).
    const other = state(omer, 2, s1, [member(omer, 'admin'), member(john)], '60/hour', later(700));
    const forked = board(dana, 2, null, 'x', { s: other });
    expect(receiveGroupMessage(book, forked, dana.id, ctx(john, NOW))).toMatchObject({ drop: 'group message for a state we do not hold' });
    expect(book.group(GROUP)!.frozen).toBeUndefined();
  });
});

describe('equivocation (§7.8.6)', () => {
  it('the same sender and gseq with other content refuses it, with both signed headers, until our human re-syncs', () => {
    const book = bookAt(john);
    const [m1, m2] = chainOf(omer, 2);
    receiveGroupMessage(book, m1, omer.id, ctx(john, NOW));
    receiveGroupMessage(book, m2, omer.id, ctx(john, NOW));
    const restored = board(omer, 2, m1.msg, 'other text', { at: later(30_000) });
    const out = receiveGroupMessage(book, restored, omer.id, ctx(john, NOW));
    expect(out.equivocations).toEqual([{ group: GROUP, member: omer.id, gseq: 2, hashes: [docHash(m2.msg), docHash(restored.msg)], headers: [m2.msg, restored.msg] }]);
    expect(out.delivered).toEqual([]);
    // Everything from Omer is refused now, private messages too.
    const m3 = board(omer, 3, m2.msg);
    expect(receiveGroupMessage(book, m3, omer.id, ctx(john, NOW))).toMatchObject({ delivered: [], drop: expect.stringMatching(/refused/) });
    // Re-sync: replays of the old chain stay duplicates; the next newer message starts it again.
    resyncMember(book, GROUP, omer.id);
    expect(receiveGroupMessage(book, m2, omer.id, ctx(john, NOW))).toMatchObject({ delivered: [], drop: 'group message duplicate' });
    const fresh = board(omer, 2, m1.msg, 'after resync', { at: later(40_000) });
    expect(receiveGroupMessage(book, fresh, omer.id, ctx(john, NOW)).delivered.map((d) => d.body.text)).toEqual(['after resync']);
    // The old chain's headers, sent back as evidence by a member, cannot refuse it again.
    for (const old of [m2.msg, restored.msg]) {
      const replay = receiveGroupProof(book, { type: GROUP_PROOF_TYPE, group: GROUP, msgs: [old] }, dana.id, ctx(john, NOW));
      expect(replay.equivocations).toEqual([]);
    }
    expect(book.group(GROUP)!.chains![omer.id].refused).toBeUndefined();
  });

  it('a gprev that skips the header we hold is equivocation too', () => {
    const book = bookAt(john);
    const [m1, m2] = chainOf(dana, 2);
    receiveGroupMessage(book, m1, dana.id, ctx(john, NOW));
    receiveGroupMessage(book, m2, dana.id, ctx(john, NOW));
    const otherPrev = board(dana, 2, m1.msg, 'the other #2');
    const m3 = board(dana, 3, otherPrev.msg);
    expect(receiveGroupMessage(book, m3, dana.id, ctx(john, NOW)).equivocations).toHaveLength(1);
  });

  it("heads that differ from ours are a claim, not proof: we send that member our signed copy, and refuse no one", () => {
    const johns = bookAt(john);
    const [a] = chainOf(omer, 1, () => 'done');
    receiveGroupMessage(johns, a, omer.id, ctx(john, NOW));
    const b = board(omer, 1, null, 'not started', { at: later(5000) });
    // Dana's message says she holds Omer's #1 with another hash.
    const fromDana = board(dana, 1, null, 'hi', { heads: { [omer.id]: [1, docHash(b.msg).slice(0, 16)] } });
    const out = receiveGroupMessage(johns, fromDana, dana.id, ctx(john, NOW));
    expect(out.equivocations).toEqual([]);
    expect(out.send).toEqual([{ to: dana.id, payload: { type: GROUP_PROOF_TYPE, group: GROUP, msgs: [a.msg] } }]);
    expect(johns.group(GROUP)!.chains![omer.id].refused).toBeUndefined();
    // Once per (member, gseq, peer): her next message with the same claim sends nothing more.
    const again = board(dana, 2, fromDana.msg, 'hi', { heads: { [omer.id]: [1, docHash(b.msg).slice(0, 16)] } });
    expect(receiveGroupMessage(johns, again, dana.id, ctx(john, NOW)).send).toEqual([]);
    // To a member we have not approved, nothing (under ask it gets nothing from us).
    const shy = bookAt(john, s1, [omer.id]);
    receiveGroupMessage(shy, a, omer.id, ctx(john, NOW));
    expect(receiveGroupMessage(shy, fromDana, dana.id, ctx(john, NOW)).send).toEqual([]);
  });

  it('heads that show a gseq beyond ours ask the sender for it', () => {
    const johns = bookAt(john);
    const ms = chainOf(omer, 3);
    receiveGroupMessage(johns, ms[0], omer.id, ctx(john, NOW));
    const fromDana = board(dana, 1, null, 'hi', { heads: { [omer.id]: [3, docHash(ms[2].msg).slice(0, 16)] } });
    expect(receiveGroupMessage(johns, fromDana, dana.id, ctx(john, NOW)).send).toEqual([{ to: omer.id, payload: { type: 'rdv/resend', group: GROUP, from_gseq: 2, to_gseq: 3 } }]);
  });

  it('a proof with two conflicting headers refuses the sender and returns our copy; a forged or harmless one triggers nothing', () => {
    const [a] = chainOf(omer, 1, () => 'done');
    const b = board(omer, 1, null, 'not started', { at: later(5000) });
    // Dana holds a; John's proof carries b: she now has two of Omer's signatures at #1.
    const danas = bookAt(dana);
    receiveGroupMessage(danas, a, omer.id, ctx(dana, NOW));
    const out = receiveGroupProof(danas, { type: GROUP_PROOF_TYPE, group: GROUP, msgs: [b.msg] }, john.id, ctx(dana, NOW));
    expect(out.equivocations).toMatchObject([{ member: omer.id, gseq: 1, via: john.id }]);
    expect(out.send).toEqual([{ to: john.id, payload: { type: GROUP_PROOF_TYPE, group: GROUP, msgs: [a.msg] } }]);

    // DoS checks: each of these changes nothing.
    const fresh = () => {
      const book = bookAt(dana);
      receiveGroupMessage(book, a, omer.id, ctx(dana, NOW));
      return book;
    };
    const forged = { ...b.msg, sig: a.msg.sig };
    for (const [input, by] of [
      [{ type: GROUP_PROOF_TYPE, group: GROUP, msgs: [forged] }, john.id], // a signature that does not verify
      [{ type: GROUP_PROOF_TYPE, group: GROUP, msgs: [b.msg] }, eve.id], // from a non-member
      [{ type: GROUP_PROOF_TYPE, group: GROUP, msgs: [a.msg] }, john.id], // the same message we hold
      [{ type: GROUP_PROOF_TYPE, group: GROUP, msgs: [board(eve, 1, null).msg, board(eve, 1, null, 'x').msg] }, john.id], // about a non-member
      [{ type: GROUP_PROOF_TYPE, group: GROUP, msgs: [board(john, 1, null).msg, board(dana, 1, null).msg] }, john.id], // two senders
    ] as const) {
      const book = fresh();
      const got = receiveGroupProof(book, input, by, ctx(dana, NOW));
      expect(got.equivocations).toEqual([]);
      expect(got.send).toEqual([]);
      expect(book.group(GROUP)!.chains![omer.id].refused).toBeUndefined();
      expect(book.group(GROUP)!.chains![eve.id]).toBeUndefined();
    }
  });
});

describe('what a non-member can trigger: nothing', () => {
  it("a stranger's validly signed message, proof, leave or report changes no state", () => {
    const book = bookAt(john);
    const before = JSON.stringify(book.toJSON());
    const fake = createGroupMsg(eve, { group: GROUP, epoch: 1, state: docHash(s1), to: '*', gseq: 1, gprev: null, body: { type: 'note' }, ts: T0.toISOString() });
    expect(receiveGroupMessage(book, { type: GROUP_MSG_TYPE, msg: fake, body: { type: 'note' } }, eve.id, ctx(john, NOW))).toMatchObject({ drop: 'group message from a non-member' });
    // Dana's message relayed by Eve is not from its signer.
    expect(receiveGroupMessage(book, board(dana, 1, null), eve.id, ctx(john, NOW))).toMatchObject({ drop: 'group message not from its signer' });
    expect(receiveGroupProof(book, { type: GROUP_PROOF_TYPE, group: GROUP, msgs: [board(dana, 1, null).msg, board(dana, 1, null, 'x').msg] }, eve.id, ctx(john, NOW)).drop).toBe('group proof from a non-member');
    const leave = createGroupLeave(eve, { group: GROUP, state: s1 }, NOW);
    expect(receiveGroupLeave(book, john, leave, eve.id, ctx(john, NOW))).toMatchObject({ ok: false });
    expect(receiveGroupReport(book, { type: GROUP_REPORT_TYPE, group: GROUP, member: dana.id, count: 99, limit: '60/hour' }, eve.id, ctx(john, NOW))).toMatchObject({ ok: false });
    // Nor can a member flood the epoch queue past its share.
    const s9 = state(omer, 9, s1, [member(omer, 'admin'), member(john), member(dana)]);
    const flood: GroupMsgPayload[] = [];
    for (let i = 1; i <= 6; i++) flood.push(board(dana, i, flood[i - 2]?.msg ?? null, `${i}`, { s: s9 }));
    const outs = flood.map((m) => receiveGroupMessage(book, m, dana.id, ctx(john, NOW)));
    expect(outs.filter((o) => o.waiting).length).toBe(GROUP_MSG_LIMITS.waitingPerSender);
    expect(JSON.parse(before).groups[GROUP].chains).toBeUndefined();
    expect(book.group(GROUP)!.chains).toBeUndefined();
  });
});

describe('rate (§7.8.7)', () => {
  const tight = state(omer, 1, s0, [member(omer, 'admin'), member(john), member(dana)], '3/hour');

  it('over member_rate the member is muted, our human told, and the admin gets a report; a re-sync lifts it', () => {
    const book = bookAt(john, tight);
    const ms = Array.from({ length: 5 }, (_, i) => i).reduce<GroupMsgPayload[]>((acc, i) => [...acc, board(dana, i + 1, acc[i - 1]?.msg ?? null, `${i}`, { s: tight })], []);
    for (const m of ms.slice(0, 3)) expect(receiveGroupMessage(book, m, dana.id, ctx(john, NOW)).delivered).toHaveLength(1);
    const over = receiveGroupMessage(book, ms[3], dana.id, ctx(john, NOW));
    expect(over.mutes).toEqual([{ group: GROUP, member: dana.id, count: 4, limit: '3/hour' }]);
    expect(over.send).toEqual([{ to: omer.id, payload: { type: GROUP_REPORT_TYPE, group: GROUP, member: dana.id, count: 4, limit: '3/hour' } }]);
    expect(receiveGroupMessage(book, ms[4], dana.id, ctx(john, NOW))).toMatchObject({ delivered: [], mutes: [], drop: expect.stringMatching(/muted/) });
    resyncMember(book, GROUP, dana.id);
    expect(receiveGroupMessage(book, ms[3], dana.id, ctx(john, NOW)).delivered).toHaveLength(1);
  });

  it("our own ceiling applies whatever member_rate the admin wrote", () => {
    const loose = state(omer, 1, s0, [member(omer, 'admin'), member(john), member(dana)], '100000/hour');
    const book = bookAt(john, loose);
    let last: GroupMsg | null = null;
    let muted = 0;
    for (let i = 1; i <= 601; i++) {
      const m = board(dana, i, last, 'x', { s: loose, at: T0 });
      last = m.msg;
      muted += receiveGroupMessage(book, m, dana.id, ctx(john, NOW)).mutes.length;
    }
    expect(muted).toBe(1);
    expect(book.group(GROUP)!.chains![dana.id].muted).toMatchObject({ limit: GROUP_MSG_LIMITS.memberCeiling });
  });

  it('a report reaches only an admin, about a member, from a member', () => {
    const admin = bookAt(omer);
    const report = { type: GROUP_REPORT_TYPE, group: GROUP, member: dana.id, count: 4, limit: '3/hour' };
    expect(receiveGroupReport(admin, report, john.id, ctx(omer, NOW))).toEqual({ ok: true, report: { group: GROUP, from: john.id, member: dana.id, count: 4, limit: '3/hour' } });
    expect(receiveGroupReport(bookAt(dana), report, john.id, ctx(dana, NOW))).toMatchObject({ ok: false, reason: expect.stringMatching(/not an admin/) });
    expect(receiveGroupReport(admin, { ...report, member: eve.id }, john.id, ctx(omer, NOW))).toMatchObject({ ok: false });
    expect(receiveGroupReport(admin, { ...report, extra: 1 }, john.id, ctx(omer, NOW))).toMatchObject({ ok: false });
  });
});

describe('removal and leaving (§7.8.5)', () => {
  it('a leave from the member itself: nothing more goes to it; the admin issues the state without it', () => {
    const admin = bookAt(omer);
    receiveGroupMessage(admin, board(john, 1, null), john.id, ctx(omer, NOW));
    const leave = createGroupLeave(john, { group: GROUP, state: s1 }, NOW);
    expect(verifyGroupLeave(leave, NOW)).toMatchObject({ ok: true });
    // Relayed by Dana: not its signer.
    expect(receiveGroupLeave(admin, omer, leave, dana.id, ctx(omer, NOW))).toMatchObject({ ok: false, reason: expect.stringMatching(/signer/) });
    const out = receiveGroupLeave(admin, omer, leave, john.id, ctx(omer, NOW));
    expect(out).toMatchObject({ ok: true, member: john.id });
    if (!out.ok || !out.change) throw new Error('no removal');
    expect(out.change.removed).toEqual([john.id]);
    const r = admin.group(GROUP)!;
    expect(r.state.members.map((m) => m.id)).toEqual([omer.id, dana.id]);
    expect(r.chains?.[john.id]).toBeUndefined();
    expect(admin.admittedPeers(omer.id).has(john.id)).toBe(false);

    // A member (not an admin) marks it departed and stops sending to it, before the admin's state.
    const danas = bookAt(dana);
    expect(receiveGroupLeave(danas, dana, leave, john.id, ctx(dana, NOW))).toMatchObject({ ok: true });
    expect(danas.group(GROUP)!.state.epoch).toBe(1);
    expect(danas.admittedPeers(dana.id).has(john.id)).toBe(false);
    expect(prepareGroupMessage(danas, dana, GROUP, { type: 'note' }, { now: T0 }).recipients).toEqual([omer.id]);
    expect(receiveGroupMessage(danas, board(john, 2, null), john.id, ctx(dana, NOW))).toMatchObject({ drop: 'group message from a non-member' });
    // The admin's state then removes it for good.
    const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(dana)], '60/hour', later(2000));
    expect(danas.receiveState(s2, omer.id, ctx(dana, NOW)).kind).toBe('applied');
    expect(danas.group(GROUP)!.departed).toEqual({});
  });

  it('an old leave replayed after the member was added again is refused', () => {
    const book = bookAt(dana);
    const leave = createGroupLeave(john, { group: GROUP, state: s1 }, NOW);
    const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(dana)], '60/hour', later(1000));
    const s3 = state(omer, 3, s2, [member(omer, 'admin'), member(dana), member(john)], '60/hour', later(2000));
    book.receiveState(s2, omer.id, ctx(dana, NOW));
    book.receiveState(s3, omer.id, ctx(dana, NOW));
    expect(receiveGroupLeave(book, dana, leave, john.id, ctx(dana, NOW))).toMatchObject({ ok: false, reason: expect.stringMatching(/replay/) });
    expect(book.admittedPeers(dana.id).has(john.id)).toBe(true);
  });

  it('removal by an admin: a state without the member; the last admin cannot leave', () => {
    const admin = bookAt(omer);
    expect(() => admin.remove(john, GROUP, dana.id, ctx(john, NOW))).toThrow(/only an admin/);
    expect(() => admin.remove(omer, GROUP, omer.id, ctx(omer, NOW))).toThrow(/leave/);
    const change = admin.remove(omer, GROUP, dana.id, ctx(omer, NOW));
    expect(change.removed).toEqual([dana.id]);
    expect(change.record.state.epoch).toBe(2);
    expect(admin.leaveProblem(GROUP, omer.id)).toMatch(/last admin/);
    expect(bookAt(john).leaveProblem(GROUP, john.id)).toBeNull();
    // The removed member applies the state that removes it.
    const danas = bookAt(dana);
    const out = danas.receiveState(change.record.state, omer.id, ctx(dana, NOW));
    expect(out.kind === 'applied' && out.change.left).toBe(true);
    expect(danas.group(GROUP)!.chains).toBeUndefined();
  });

  it('a leaver marks the group left and forgets its message records', () => {
    const book = bookAt(john);
    prepareGroupMessage(book, john, GROUP, { type: 'note' });
    const r = book.markLeft(GROUP, NOW);
    expect(r).toMatchObject({ status: 'removed', left: NOW.toISOString(), approved: [] });
    expect(r.out).toBeUndefined();
    expect(book.admittedPeers(john.id).size).toBe(0);
    expect(() => prepareGroupMessage(book, john, GROUP, { type: 'note' })).toThrow(/not a member/);
  });
});

// --- three agents over the in-memory relay ---------------------------------------------

function once<K extends keyof AgentEvents>(agent: Agent, event: K, ms = 5000, match: (...a: AgentEvents[K]) => boolean = () => true): Promise<AgentEvents[K]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), ms);
    const on = (...args: unknown[]) => {
      if (!match(...(args as AgentEvents[K]))) return;
      clearTimeout(t);
      (agent as unknown as { off(e: string, f: (...a: unknown[]) => void): void }).off(event as string, on);
      resolve(args as AgentEvents[K]);
    };
    (agent as unknown as { on(e: string, f: (...a: unknown[]) => void): void }).on(event as string, on);
  });
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A transport that can be told to lose envelopes to some recipients (a relay that lost them). */
class LossyTransport {
  lose = new Set<string>();
  constructor(readonly inner: Transport) {
    return new Proxy(this, {
      get: (t, k) => {
        if (k === 'sendEnvelope') return (env: { to: string }, relays?: string[]) => (t.lose.has(env.to) ? Promise.resolve() : t.inner.sendEnvelope(env as never, relays));
        if (k === 'lose' || k === 'inner') return t[k];
        const v = (t.inner as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t.inner) : v;
      },
    });
  }
}

describe('three agents talk in a group (design B.5 steps 4, 8, 9)', () => {
  let relay: TestRelay;
  let agents: Agent[] = [];
  beforeEach(async () => {
    relay = await startTestRelay();
  });
  afterEach(async () => {
    for (const x of agents) x.close();
    agents = [];
    await relay.close();
  });

  const transportFor = (key: AgentKey) => new LossyTransport(new NostrTransport({ key, relays: [relay.url], maxEventsPerSecond: 1000, burst: 1000 })) as unknown as Transport & LossyTransport;

  const make = (key?: AgentKey) => {
    const k = key ?? generateKey();
    const agent = new Agent(k, createCard(k, { rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }], capabilities: ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION] }), transportFor(k));
    agent.on('error', (e) => {
      throw e;
    });
    agent.start();
    agents.push(agent);
    return agent;
  };

  async function contacts(a: Agent, b: Agent) {
    await new Promise((r) => setTimeout(r, 100));
    const asked = once(b, 'request');
    await a.requestContact(b.card, 'hi');
    const [p] = await asked;
    const got = once(a, 'contact');
    await b.grant(p.request.id, { tier: 'friend' });
    await got;
  }

  /** Omer (admin) with contacts John and Dana; John and Dana are not contacts. Everyone approves everyone. */
  async function formGroup() {
    const o = make();
    const j = make();
    const d = make();
    await contacts(o, j);
    await contacts(o, d);
    const g = o.createGroup('Microsite launch');
    const ji = once(j, 'group-invite');
    await o.inviteToGroup(g.group, j.id, { name: 'John' });
    const [jInv] = await ji;
    const jIn = once(j, 'group-state', 5000, (c) => c.admitted);
    await j.joinGroup(jInv.invite.id, { policy: 'trust-admin' });
    await jIn;
    const di = once(d, 'group-invite');
    await o.inviteToGroup(g.group, d.id, { name: 'Dana' });
    const [dInv] = await di;
    const dIn = once(d, 'group-state', 5000, (c) => c.admitted);
    await d.joinGroup(dInv.invite.id);
    await dIn;
    d.approveGroupNewcomer(g.group, j.id);
    await until(() => [o, j, d].every((a) => Object.keys(a.groups.group(g.group)!.joins).length === 3 && a.groups.group(g.group)!.state.epoch === 2));
    return { o, j, d, group: g.group };
  }

  const note = (text: string) => ({ type: 'note', text });
  const texts = (a: Agent, from: Agent) => {
    const out: string[] = [];
    a.on('group-message', (d) => {
      if (d.from === from.id) out.push(d.body.text as string);
    });
    return out;
  };

  it('a board message reaches every member, a private one only its addressee; heads follow', async () => {
    const { o, j, d, group } = await formGroup();
    const atJohn = texts(j, o);
    const atDana = texts(d, o);
    // A plain post carries only free messages: a group task goes through its engine (issue #133).
    await expect(o.sendGroup(group, { type: 'a2a/message', message: {} })).rejects.toThrow(/not a free message/);
    await expect(o.sendGroup(group, { type: 'rdv/transfer' })).rejects.toThrow(/not a free message/);
    const report = await o.sendGroup(group, note('Draft the landing-page copy'));
    expect(report.sent.sort()).toEqual([j.id, d.id].sort());
    expect(report.msg.gseq).toBe(1);
    await until(() => atJohn.length === 1 && atDana.length === 1);
    // John and Dana are not contacts, yet each reaches the other through the group.
    const atDanaFromJohn = texts(d, j);
    await j.sendGroup(group, note('I can review'));
    await until(() => atDanaFromJohn.length === 1);
    await o.sendGroup(group, note('just for you'), { to: [d.id] });
    await until(() => atDana.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(atJohn).toEqual(['Draft the landing-page copy']);
    // Dana's next board message carries heads for Omer (#1) and John (#1).
    const sent = await d.sendGroup(group, note('ok'));
    expect(sent.msg.heads).toEqual({
      [o.id]: [1, docHash(report.msg).slice(0, 16)],
      [j.id]: [1, expect.stringMatching(/^[0-9a-f]{16}$/)],
    });
    // A member that is not a contact may send nothing but group traffic.
    const dropped = once(d, 'dropped', 5000, (r) => r === 'no grant for sender');
    await (j as unknown as { deliverTo(p: string, x: object): Promise<unknown> }).deliverTo(d.id, { type: 'a2a/message', text: 'pairwise?' });
    await dropped;
  });

  it('B.5 step 8: a member restored from a backup re-sends a gseq with other content, and the others catch it', async () => {
    const { o, j, d, group } = await formGroup();
    await o.sendGroup(group, note('#1 kickoff'));
    await until(() => j.groups.group(group)!.chains?.[o.id]?.gseq === 1 && d.groups.group(group)!.chains?.[o.id]?.gseq === 1);
    // Omer's backup, taken now.
    const backup = JSON.parse(JSON.stringify(o.toJSON()));
    // #2 goes out; the relay loses the copy for John.
    (o.transport as unknown as LossyTransport).lose.add(j.id);
    await o.sendGroup(group, note('#2 copy is done'));
    await until(() => d.groups.group(group)!.chains?.[o.id]?.gseq === 2);
    (o.transport as unknown as LossyTransport).lose.clear();
    // Omer's laptop restores the backup and re-sends #2 with other text, to John only (the copy for Dana is lost).
    o.close();
    agents = agents.filter((a) => a !== o);
    const restored = Agent.fromJSON(backup, (key) => transportFor(key));
    restored.on('error', (e) => {
      throw e;
    });
    agents.push(restored);
    restored.start();
    (restored.transport as unknown as LossyTransport).lose.add(d.id);
    const johnTook = once(j, 'group-message', 5000, (m) => m.from === o.id);
    await restored.sendGroup(group, note('#2 copy not started'));
    await johnTook;
    expect(j.groups.group(group)!.chains![o.id].gseq).toBe(2);

    // Dana's next message carries heads[Omer] = [2, <her hash>]: John holds another, sends her his signed copy,
    // she now has both of Omer's signatures at #2 and sends hers back. Both refuse Omer and tell their humans.
    const atJohn = once(j, 'group-equivocation', 8000);
    const atDana = once(d, 'group-equivocation', 8000);
    await d.sendGroup(group, note('looks good'));
    const [[ej], [ed]] = await Promise.all([atJohn, atDana]);
    expect(ej).toMatchObject({ group, member: o.id, gseq: 2, via: d.id });
    expect(ed).toMatchObject({ group, member: o.id, gseq: 2, via: j.id });
    expect(ej.hashes).toHaveLength(2);
    expect(new Set(ej.hashes)).toEqual(new Set(ed.hashes));
    // Both now hold both signed versions, and refuse Omer's group messages until their humans re-sync.
    for (const e of [ej, ed]) expect(e.headers.every((h) => h.from === o.id && h.gseq === 2)).toBe(true);
    // (Dana's pairwise channel from the restored Omer is a fork too, §6.4; John's is not, so his group layer refuses it.)
    const refusedAtJohn = once(j, 'dropped', 5000, (r) => r.includes('equivocated'));
    (restored.transport as unknown as LossyTransport).lose.clear();
    await restored.sendGroup(group, note('#3'));
    await refusedAtJohn;
    expect(j.groups.group(group)!.chains![o.id].refused).toBeTruthy();
    // John's human checks with Omer and re-syncs: Omer's next message is taken again.
    j.resyncGroupMember(group, o.id);
    const back = once(j, 'group-message', 5000, (m) => m.from === o.id);
    await restored.sendGroup(group, note('#4 after the re-sync'));
    const [m] = await back;
    expect(m.msg.gseq).toBe(4);
  });

  it('B.5 step 9: John leaves; Dana drops their channel, Omer keeps it (contacts) and issues the state without John', async () => {
    const { o, j, d, group } = await formGroup();
    await j.sendGroup(group, note('hello'));
    await d.sendGroup(group, note('hi'));
    await until(() => !!j.channels.state[d.id] && !!d.channels.state[j.id] && (d.channels.state[j.id].outSeq ?? 0) > 0);
    const danaSees = once(d, 'group-state', 5000, (c) => c.removed.includes(j.id));
    await j.leaveGroup(group);
    expect(j.groups.group(group)).toMatchObject({ status: 'removed' });
    expect(j.channels.state[d.id]).toBeUndefined(); // John forgot Dana's channel (not contacts)
    expect(j.channels.state[o.id]).toBeDefined(); // ...but kept Omer's (contacts)
    const [change] = await danaSees;
    expect(change.record.state.members.map((x) => x.id)).toEqual([o.id, d.id]);
    expect(d.channels.state[j.id]).toBeUndefined();
    expect(o.channels.state[j.id]).toBeDefined();
    expect(o.groups.group(group)!.state.epoch).toBe(3);
    // Nothing more goes to John.
    const r = await d.sendGroup(group, note('after'));
    expect(r.sent).toEqual([o.id]);
  });

  it('removal: the admin issues a state without Dana and sends it to her too', async () => {
    const { o, j, d, group } = await formGroup();
    const danaOut = once(d, 'group-state', 5000, (c) => c.left);
    const johnSees = once(j, 'group-state', 5000, (c) => c.removed.includes(d.id));
    await o.removeGroupMember(group, d.id);
    await Promise.all([danaOut, johnSees]);
    expect(d.groups.group(group)!.status).toBe('removed');
    expect(j.channels.state[d.id]).toBeUndefined();
    expect(d.channels.state[j.id]).toBeUndefined();
    const sent = await j.sendGroup(group, note('just us'));
    expect(sent.sent).toEqual([o.id]);
  });

  it("DoS: a non-member's group message or forged proof triggers nothing at a member", async () => {
    const { o, j, d, group } = await formGroup();
    const e = make();
    await contacts(e, j); // Eve is John's contact, but not in the group
    await o.sendGroup(group, note('#1'));
    await until(() => j.groups.group(group)!.chains?.[o.id]?.gseq === 1);
    const before = JSON.stringify(j.groups.group(group));
    const fake = createGroupMsg(e.key, { group, epoch: 2, state: docHash(j.groups.group(group)!.state), to: '*', gseq: 1, gprev: null, body: { type: 'note' } });
    const ours = j.groups.group(group)!.chains![o.id].headers[0];
    const forged = { ...ours, body_hash: '0'.repeat(64) }; // Omer's header with another body: its signature fails
    const send = (x: object) => (e as unknown as { deliverTo(p: string, x: object): Promise<unknown> }).deliverTo(j.id, x);
    const drops: string[] = [];
    j.on('dropped', (r) => drops.push(r));
    await send({ type: GROUP_MSG_TYPE, msg: fake, body: { type: 'note' } });
    await send({ type: GROUP_PROOF_TYPE, group, msgs: [forged] });
    await send({ type: GROUP_LEAVE_TYPE, ...createGroupLeave(e.key, j.groups.group(group)!) });
    await send({ type: GROUP_REPORT_TYPE, group, member: o.id, count: 1000, limit: '60/hour' });
    await until(() => drops.length >= 4);
    expect(drops).toEqual(['group message from a non-member', 'group proof from a non-member', 'group leave from a non-member', 'group report from a non-member']);
    expect(JSON.stringify(j.groups.group(group))).toBe(before);
    // A forged proof from a real member (Dana) does nothing either.
    const dDrops: string[] = [];
    j.on('dropped', (r) => dDrops.push(r));
    await (d as unknown as { deliverTo(p: string, x: object): Promise<unknown> }).deliverTo(j.id, { type: GROUP_PROOF_TYPE, group, msgs: [forged] });
    await until(() => dDrops.length >= 1);
    expect(dDrops[0]).toMatch(/group proof invalid: bad signature/);
    expect(j.groups.group(group)!.chains![o.id].refused).toBeUndefined();
  });
});
