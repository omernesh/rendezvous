// Groups v1, slice 1 (SPEC §7.8.1, §7.8.2; issue #77): the signed group
// state and its chain, invites only to contacts, the 16-member cap, joins
// that need an invite (and the joiner's human), the newcomer policy, and three
// agents converging on one state over the in-memory relay.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentEvents,
  type AgentKey,
  createCard,
  createGroupInvite,
  createGroupJoin,
  createGroupState,
  docHash,
  generateKey,
  GROUP_LIMITS,
  GroupBook,
  type GroupChange,
  type GroupContext,
  type GroupMember,
  type GroupState,
  GROUPS_EXTENSION,
  memberOf,
  NostrTransport,
  signDoc,
  successorProblem,
  verifyGroupInvite,
  verifyGroupJoin,
  verifyGroupState,
} from '../src/index.js';
import { startTestRelay, type TestRelay } from '../src/testing/relay.js';

const T0 = new Date('2026-10-26T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const GROUP = '00000000-0000-4000-8000-0000000000a1';
const REQUEST = 'https://rendezvous.nesher.co/ext/request/v1';
const hints = [{ type: 'nostr' as const, relay: 'wss://relay.example', pref: 1 }];
const cardOf = (k: AgentKey) => createCard(k, { rendezvous: hints, capabilities: ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION], now: T0 });
const member = (k: AgentKey, role: 'admin' | 'member' = 'member', name?: string): GroupMember => ({
  id: k.id,
  role,
  card: docHash(cardOf(k)),
  ...(name ? { name } : {}),
});
const policy = { member_rate: '60/hour', members_may_invite: false };

function state(signer: AgentKey, epoch: number, prev: GroupState | null, members: GroupMember[], at = T0): GroupState {
  return createGroupState(signer, { group: GROUP, epoch, prev: prev ? docHash(prev) : null, members, policy, name: 'Microsite launch', ts: at.toISOString() });
}

const ctxFor = (me: AgentKey, contacts: AgentKey[] = [], now = T0): GroupContext => ({ me: me.id, isContact: (p) => contacts.some((c) => c.id === p), now });

/** A book that holds `s` as an active member (as if it joined at that state). */
function bookAt(me: AgentKey, s: GroupState, policyName: 'ask' | 'trust-admin' = 'ask'): GroupBook {
  return new GroupBook({
    groups: {
      [GROUP]: {
        group: GROUP,
        status: 'active',
        state: s,
        history: [{ epoch: s.epoch, hash: docHash(s), from: s.from }],
        joins: {},
        approved: [],
        newcomers: {},
        policy: policyName,
        scope: { invoke: {} },
        joined: T0.toISOString(),
        future: [],
      },
    },
  });
}

describe('rdv/group-state: shape and signature', () => {
  const omer = generateKey();
  const john = generateKey();

  it('accepts epoch 0 signed by its creator, an admin in it', () => {
    const s0 = state(omer, 0, null, [member(omer, 'admin')]);
    expect(verifyGroupState(s0, T0)).toMatchObject({ ok: true });
  });

  it('refuses a creator that is not an admin, no admin at all, a member twice, more than 16, unknown fields, a bad signature', () => {
    const body = (members: GroupMember[], extra: Record<string, unknown> = {}) => ({
      v: 1,
      type: 'rdv/group-state',
      group: GROUP,
      epoch: 0,
      prev: null,
      from: omer.id,
      members,
      policy,
      name: 'x',
      ts: T0.toISOString(),
      ...extra,
    });
    expect(verifyGroupState(signDoc(body([member(omer, 'member'), member(john, 'admin')]), omer), T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/creator/) });
    expect(verifyGroupState(signDoc(body([member(omer, 'member')]), omer), T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/admin/) });
    expect(verifyGroupState(signDoc(body([member(omer, 'admin'), member(omer, 'member')]), omer), T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/twice/) });
    const many = Array.from({ length: GROUP_LIMITS.members + 1 }, () => member(generateKey()));
    expect(verifyGroupState(signDoc(body([member(omer, 'admin'), ...many.slice(2)]), omer), T0)).toMatchObject({ ok: true });
    expect(verifyGroupState(signDoc(body([member(omer, 'admin'), ...many.slice(1)]), omer), T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/1 to 16/) });
    expect(verifyGroupState(signDoc(body([member(omer, 'admin')], { extra: 1 }), omer), T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown field/) });
    expect(verifyGroupState(signDoc(body([member(omer, 'admin')]), john), T0)).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(verifyGroupState({ ...state(omer, 0, null, [member(omer, 'admin')]), name: 'renamed' }, T0)).toMatchObject({ ok: false, reason: 'bad signature' });
  });

  it('chains: epoch one higher, prev the hash of the state before, signed by an admin of it', () => {
    const s0 = state(omer, 0, null, [member(omer, 'admin')]);
    const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john)]);
    expect(successorProblem(s0, s1)).toBeNull();
    // Skipped epoch, wrong prev, another group.
    expect(successorProblem(s0, state(omer, 2, s0, [member(omer, 'admin')]))).toMatch(/does not follow/);
    expect(successorProblem(s1, state(omer, 2, s0, [member(omer, 'admin')]))).toMatch(/prev/);
    // Signed by John, a member of s1 but not an admin of it: refused even though John is an admin in the new state.
    const byJohn = createGroupState(john, { group: GROUP, epoch: 2, prev: docHash(s1), members: [member(omer, 'admin'), member(john, 'admin')], policy, name: 'x', ts: T0.toISOString() });
    expect(successorProblem(s1, byJohn)).toMatch(/admin of the previous/);
  });
});

describe('GroupBook: the state chain at a member', () => {
  const omer = generateKey();
  const john = generateKey();
  const dana = generateKey();
  const s0 = state(omer, 0, null, [member(omer, 'admin')]);
  const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john)]);

  it('applies the next state; a duplicate is quiet; an older or skipped one waits or is ignored', () => {
    const book = bookAt(john, s1);
    const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], later(1000));
    const s3 = state(omer, 3, s2, [member(omer, 'admin'), member(john)], later(2000));
    // s3 first: ahead of us, kept until s2 arrives.
    expect(book.receiveState(s3, omer.id, ctxFor(john, [omer], later(3000)))).toEqual({ kind: 'future' });
    const got = book.receiveState(s2, omer.id, ctxFor(john, [omer], later(3000)));
    expect(got.kind).toBe('applied');
    if (got.kind !== 'applied') return;
    expect(got.change.added).toEqual([dana.id]);
    expect(got.also.map((c) => c.removed)).toEqual([[dana.id]]);
    expect(book.group(GROUP)!.state.epoch).toBe(3);
    expect(book.receiveState(s2, omer.id, ctxFor(john, [omer], later(3000)))).toEqual({ kind: 'duplicate' });
    expect(book.receiveState(s0, omer.id, ctxFor(john, [omer], later(3000)))).toMatchObject({ kind: 'ignored' });
  });

  it('refuses a state from someone other than its signer, from a non-member, or signed by a member that is not an admin', () => {
    const book = bookAt(john, s1);
    const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john)]);
    expect(book.receiveState(s2, john.id, ctxFor(john, [omer]))).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/signer/) });
    const eve = generateKey();
    const byEve = createGroupState(eve, { group: GROUP, epoch: 2, prev: docHash(s1), members: [member(eve, 'admin'), member(john)], policy, name: 'x', ts: T0.toISOString() });
    expect(book.receiveState(byEve, eve.id, ctxFor(john, [omer]))).toMatchObject({ kind: 'ignored', reason: expect.stringMatching(/non-member/) });
    // Dana, a member, issues a state on top: not an admin of s1.
    const s1d = state(omer, 1, s0, [member(omer, 'admin'), member(john), member(dana)]);
    const bookD = bookAt(john, s1d);
    const byDana = createGroupState(dana, { group: GROUP, epoch: 2, prev: docHash(s1d), members: [member(dana, 'admin'), member(john)], policy, name: 'x', ts: T0.toISOString() });
    expect(bookD.receiveState(byDana, dana.id, ctxFor(john, [omer]))).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/admin of the previous/) });
    expect(bookD.group(GROUP)!.state.epoch).toBe(1);
  });

  it('a fork: the same admin signs two states at one epoch, so membership freezes until our human re-syncs', () => {
    const book = bookAt(john, s1);
    const a = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], later(1000));
    const b = state(omer, 2, s1, [member(omer, 'admin'), member(john)], later(2000));
    expect(book.receiveState(a, omer.id, ctxFor(john, [omer], later(3000))).kind).toBe('applied');
    const fork = book.receiveState(b, omer.id, ctxFor(john, [omer], later(3000)));
    expect(fork.kind).toBe('fork');
    const r = book.group(GROUP)!;
    expect(r.frozen).toMatchObject({ epoch: 2, signers: [omer.id], hashes: [docHash(a), docHash(b)] });
    expect(r.state).toEqual(a); // frozen at the last state we hold
    // Nothing applies while frozen, not even a correct successor.
    const c = state(omer, 3, a, [member(omer, 'admin'), member(john)], later(4000));
    expect(book.receiveState(c, omer.id, ctxFor(john, [omer], later(5000)))).toMatchObject({ kind: 'ignored', reason: expect.stringMatching(/frozen/) });
    // The same forked state again is not a new event.
    expect(book.receiveState(b, omer.id, ctxFor(john, [omer], later(5000)))).toEqual({ kind: 'duplicate' });
    book.resync(GROUP);
    expect(book.receiveState(c, omer.id, ctxFor(john, [omer], later(5000))).kind).toBe('applied');
  });

  it('two admins issue the same epoch: frozen, not resolved, in either order and even when a hash would win (review of #80)', () => {
    const both = state(omer, 1, s0, [member(omer, 'admin'), member(dana, 'admin'), member(john)]);
    const fromOmer = state(omer, 2, both, [member(omer, 'admin'), member(dana, 'admin'), member(john)], later(1000));
    // Dana demotes Omer; any number of re-signings to get a lower hash changes nothing.
    const demoting = createGroupState(dana, { group: GROUP, epoch: 2, prev: docHash(both), members: [member(omer), member(dana, 'admin'), member(john)], policy, name: 'x', ts: later(2000).toISOString() });
    for (const order of [
      [fromOmer, demoting],
      [demoting, fromOmer],
    ]) {
      const book = bookAt(john, both);
      const first = book.receiveState(order[0], order[0].from, ctxFor(john, [omer, dana], later(3000)));
      expect(first.kind).toBe('applied');
      const second = book.receiveState(order[1], order[1].from, ctxFor(john, [omer, dana], later(3000)));
      expect(second.kind).toBe('fork');
      const r = book.group(GROUP)!;
      expect(r.state).toEqual(order[0]); // the state we held stays; nothing picked a winner
      expect(r.frozen).toMatchObject({ epoch: 2, hashes: [docHash(order[0]), docHash(order[1])] });
      expect([...r.frozen!.signers].sort()).toEqual([omer.id, dana.id].sort());
      // A successor of either is refused until our human re-syncs.
      const next = state(omer, 3, fromOmer, [member(omer, 'admin'), member(dana, 'admin'), member(john)], later(4000));
      expect(book.receiveState(next, omer.id, ctxFor(john, [omer, dana], later(5000)))).toMatchObject({ kind: 'ignored', reason: expect.stringMatching(/frozen/) });
    }
    // A rival waiting ahead of the chain is a fork too, not dropped when the chain reaches it.
    const book = bookAt(john, both);
    const s3a = state(omer, 3, fromOmer, [member(omer, 'admin'), member(dana, 'admin'), member(john)], later(4000));
    const s3b = createGroupState(dana, { group: GROUP, epoch: 3, prev: docHash(fromOmer), members: [member(dana, 'admin'), member(john)], policy, name: 'x', ts: later(4000).toISOString() });
    expect(book.receiveState(s3a, omer.id, ctxFor(john, [omer, dana], later(5000))).kind).toBe('future');
    expect(book.receiveState(s3b, dana.id, ctxFor(john, [omer, dana], later(5000))).kind).toBe('fork');
    expect(book.group(GROUP)!.state).toEqual(both);
  });
});

describe('only an admin can make a fork (review of #80)', () => {
  const omer = generateKey();
  const john = generateKey();
  const dana = generateKey();
  const s0 = state(omer, 0, null, [member(omer, 'admin')]);
  const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john), member(dana)]);
  const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], later(1000));

  it("a member's state at an epoch we hold does not freeze the group", () => {
    const book = bookAt(john, s1);
    expect(book.receiveState(s2, omer.id, ctxFor(john, [omer], later(2000))).kind).toBe('applied');
    // Dana, a member and never an admin, signs her own epoch 2 on top of s1, and an epoch 1 too.
    const byDana2 = createGroupState(dana, { group: GROUP, epoch: 2, prev: docHash(s1), members: [member(dana, 'admin'), member(john)], policy, name: 'x', ts: later(1500).toISOString() });
    const byDana1 = createGroupState(dana, { group: GROUP, epoch: 1, prev: docHash(s0), members: [member(dana, 'admin'), member(john)], policy, name: 'x', ts: later(1500).toISOString() });
    for (const s of [byDana2, byDana1]) {
      expect(book.receiveState(s, dana.id, ctxFor(john, [omer], later(2000))).kind).toBe('ignored');
      expect(book.group(GROUP)!.frozen).toBeUndefined();
    }
    expect(book.group(GROUP)!.state).toEqual(s2);
  });

  it("a member's state ahead of ours is not queued, and cannot freeze the admin's later one", () => {
    const book = bookAt(john, s1);
    const byDana3 = createGroupState(dana, { group: GROUP, epoch: 3, prev: docHash(s2), members: [member(dana, 'admin'), member(john)], policy, name: 'x', ts: later(1500).toISOString() });
    expect(book.receiveState(byDana3, dana.id, ctxFor(john, [omer], later(2000)))).toMatchObject({ kind: 'ignored', reason: expect.stringMatching(/not signed by an admin/) });
    expect(book.group(GROUP)!.future).toEqual([]);
    // Omer's own epoch 3 ahead of us is queued, then applies once epoch 2 arrives; nothing froze.
    const s3 = state(omer, 3, s2, [member(omer, 'admin'), member(john)], later(3000));
    expect(book.receiveState(s3, omer.id, ctxFor(john, [omer], later(4000))).kind).toBe('future');
    expect(book.receiveState(byDana3, dana.id, ctxFor(john, [omer], later(4000))).kind).toBe('ignored');
    expect(book.receiveState(s2, omer.id, ctxFor(john, [omer], later(4000))).kind).toBe('applied');
    expect(book.group(GROUP)!.state).toEqual(s3);
    expect(book.group(GROUP)!.frozen).toBeUndefined();
  });
});

describe('invites and joins', () => {
  const omer = generateKey();
  const john = generateKey();
  const dana = generateKey();
  const eve = generateKey();

  function admin() {
    const book = new GroupBook();
    const r = book.create(omer, cardOf(omer), { name: 'Microsite launch', now: T0 });
    return { book, group: r.group };
  }

  it('an invite carries the current state; only a contact that is an admin of it, inviting us, is kept', () => {
    const { book, group } = admin();
    const inv = book.invite(omer, group, john.id, { greeting: 'help with the site?', name: 'John', now: T0 });
    expect(verifyGroupInvite(inv, T0)).toMatchObject({ ok: true });
    const johns = new GroupBook();
    // Not from a contact: dropped before anything is kept.
    expect(johns.receiveInvite(inv, omer.id, ctxFor(john, [], T0))).toEqual({ status: 'not-contact' });
    // Relayed by someone else: not its sender.
    expect(johns.receiveInvite(inv, eve.id, ctxFor(john, [eve], T0))).toMatchObject({ status: 'invalid' });
    // For someone else.
    expect(new GroupBook().receiveInvite(inv, omer.id, ctxFor(dana, [omer], T0))).toMatchObject({ status: 'invalid' });
    expect(johns.receiveInvite(inv, omer.id, ctxFor(john, [omer], T0))).toMatchObject({ status: 'pending' });
    expect(johns.receiveInvite(inv, omer.id, ctxFor(john, [omer], T0))).toEqual({ status: 'duplicate' });
    // An invite whose inviter is not an admin of the state it carries.
    const fake = createGroupInvite(eve, { state: inv.state, to: john.id, now: T0 });
    expect(verifyGroupInvite(fake, T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/not an admin/) });
  });

  it('expired invites, too-long invites and invites to members are refused', () => {
    const { book, group } = admin();
    const inv = book.invite(omer, group, john.id, { now: T0 });
    expect(verifyGroupInvite(inv, later(GROUP_LIMITS.inviteTtlMs + 1))).toMatchObject({ ok: false, reason: 'invite expired' });
    const long = createGroupInvite(omer, { state: inv.state, to: dana.id, expires: later(30 * 86_400_000).toISOString(), now: T0 });
    expect(verifyGroupInvite(long, T0)).toMatchObject({ ok: false, reason: expect.stringMatching(/too long/) });
    expect(() => book.invite(omer, group, omer.id, { now: T0 })).toThrow(/ourselves/);
    expect(() => book.invite(omer, group, john.id, { now: T0 })).toThrow(/already open/);
  });

  it('bounds: 2 invites per admin, 16 in all (the oldest goes)', () => {
    const books = Array.from({ length: 20 }, () => generateKey());
    const johns = new GroupBook();
    for (let i = 0; i < books.length; i++) {
      const a = books[i];
      const b = new GroupBook();
      const r = b.create(a, cardOf(a), { name: `g${i}`, now: T0 });
      const out = johns.receiveInvite(b.invite(a, r.group, john.id, { now: T0 }), a.id, ctxFor(john, books, later(i)));
      expect(out.status).toBe('pending');
    }
    expect(johns.invites()).toHaveLength(GROUP_LIMITS.pendingInvites);
    expect(johns.state.invitesEvicted).toBe(4);
    // One admin, three groups: the third is refused (a retry later is welcome).
    const busy = new GroupBook();
    const theirs = new GroupBook();
    const outs = [0, 1, 2].map((i) => {
      const r = theirs.create(omer, cardOf(omer), { name: `g${i}`, now: T0 });
      return busy.receiveInvite(theirs.invite(omer, r.group, john.id, { now: T0 }), omer.id, ctxFor(john, [omer], T0)).status;
    });
    expect(outs).toEqual(['pending', 'pending', 'rate-limited']);
  });

  it('the 16-member cap: open invites count, a full group invites no one, and its invite is refused anyway', () => {
    const { book, group } = admin();
    const others = Array.from({ length: GROUP_LIMITS.members - 1 }, () => generateKey());
    for (const k of others) book.invite(omer, group, k.id, { now: T0 });
    expect(() => book.invite(omer, group, john.id, { now: T0 })).toThrow(/at most 16/);
    const full = state(omer, 0, null, [member(omer, 'admin'), ...others.map((k) => member(k))]);
    expect(full.members).toHaveLength(16);
    const inv = createGroupInvite(omer, { state: full, to: john.id, now: T0 });
    expect(verifyGroupInvite(inv, T0)).toMatchObject({ ok: false, reason: 'the group is full' });
  });

  it('a join needs an open invite of ours, from the invitee, bound to the state the invite carried', () => {
    const { book, group } = admin();
    const inv = book.invite(omer, group, john.id, { name: 'John', now: T0 });
    const johnCard = cardOf(john);
    const goodJoin = createGroupJoin(john, { group, to: omer.id, inviteRef: inv.id, state: inv.state, card: johnCard, scope: { invoke: { [REQUEST]: {} } }, now: T0 });
    expect(verifyGroupJoin(goodJoin, T0)).toMatchObject({ ok: true });
    const ctx = ctxFor(omer, [john, dana], T0);
    // Uninvited: Dana answers John's invite.
    const danaJoin = createGroupJoin(dana, { group, to: omer.id, inviteRef: inv.id, state: inv.state, card: cardOf(dana), scope: {}, now: T0 });
    expect(book.receiveJoin(omer, danaJoin, dana.id, ctx)).toMatchObject({ ok: false, code: 'no-invite' });
    // Relayed: John's join from Dana's channel.
    expect(book.receiveJoin(omer, goodJoin, dana.id, ctx)).toMatchObject({ ok: false, code: 'invalid' });
    // Approves another state than the invite carried.
    const other = state(omer, 0, null, [member(omer, 'admin'), member(eve)]);
    const stale = createGroupJoin(john, { group, to: omer.id, inviteRef: inv.id, state: other, card: johnCard, scope: {}, now: T0 });
    expect(book.receiveJoin(omer, stale, john.id, ctx)).toMatchObject({ ok: false, code: 'stale' });
    // A forged card, or a card that is not the joiner's.
    expect(verifyGroupJoin({ ...goodJoin, card: cardOf(dana) }, T0)).toMatchObject({ ok: false });
    // The good one: the next state, John in it, named as the admin's human named him.
    const ok = book.receiveJoin(omer, goodJoin, john.id, ctx);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.state.epoch).toBe(1);
    expect(ok.state.members).toEqual([member(omer, 'admin'), { id: john.id, role: 'member', card: docHash(johnCard), name: 'John' }]);
    expect(successorProblem(inv.state, ok.state)).toBeNull();
    expect(ok.change.record.approved).toEqual([john.id]); // our contact: approved at once
    // The invite is used up.
    expect(book.receiveJoin(omer, goodJoin, john.id, ctx)).toMatchObject({ ok: false });
  });

  it('joining needs a pending invite (what our human approves), and stays joining until the admin admits us', () => {
    const { book, group } = admin();
    const inv = book.invite(omer, group, john.id, { now: T0 });
    const johns = new GroupBook();
    expect(() => johns.join(john, cardOf(john), inv.id, { now: T0 })).toThrow(/no pending group invite/);
    johns.receiveInvite(inv, omer.id, ctxFor(john, [omer], T0));
    expect(() => johns.join(john, cardOf(john), inv.id, { now: later(GROUP_LIMITS.inviteTtlMs + 1) })).toThrow(/no pending group invite|expired/);
    const again = new GroupBook();
    again.receiveInvite(inv, omer.id, ctxFor(john, [omer], T0));
    const { join, record } = again.join(john, cardOf(john), inv.id, { scope: { invoke: { [REQUEST]: {} } }, policy: 'trust-admin', now: T0 });
    expect(record.status).toBe('joining');
    expect(join.state).toBe(docHash(inv.state));
    expect(join.scope).toEqual({ invoke: { [REQUEST]: {} } });
    expect(again.invites()).toHaveLength(0);
    // A state from anyone but the admin we joined through admits nothing.
    const ok = book.receiveJoin(omer, join, john.id, ctxFor(omer, [john], T0));
    if (!ok.ok) throw new Error(ok.reason);
    expect(again.receiveState(ok.state, eve.id, ctxFor(john, [omer], T0))).toMatchObject({ kind: 'invalid' });
    const admitted = again.receiveState(ok.state, omer.id, ctxFor(john, [omer], T0));
    expect(admitted.kind).toBe('applied');
    if (admitted.kind === 'applied') expect(admitted.change.admitted).toBe(true);
    expect(again.group(group)!.status).toBe('active');
  });

  it('a group scope holds only invoke and max_frequency, and never the groups extension', () => {
    const { book, group } = admin();
    const inv = book.invite(omer, group, john.id, { now: T0 });
    const mk = (scope: object) => () => createGroupJoin(john, { group, to: omer.id, inviteRef: inv.id, state: inv.state, card: cardOf(john), scope: scope as never, now: T0 });
    expect(mk({ invoke: { [GROUPS_EXTENSION]: {} } })).toThrow(/not a capability/);
    expect(mk({ may_propose_meetings: true })).toThrow(/only invoke and max_frequency/);
    expect(mk({ max_frequency: 'often' })).toThrow(/max_frequency/);
    expect(mk({ invoke: { 'http://x.example/cap': {} } })).toThrow(/capability URI/);
  });
});

describe('the newcomer policy', () => {
  const omer = generateKey();
  const john = generateKey();
  const dana = generateKey();
  const s0 = state(omer, 0, null, [member(omer, 'admin')]);
  const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john)]);
  const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], later(1000));

  it('ask (default): a newcomer that is not our contact waits for our human; trust-admin approves at once; a contact always does', () => {
    const ask = bookAt(john, s1, 'ask');
    const got = ask.receiveState(s2, omer.id, ctxFor(john, [omer], later(2000)));
    expect(got.kind === 'applied' && got.change.newcomers).toEqual([dana.id]);
    expect(ask.group(GROUP)!.approved).toEqual([]);
    expect(Object.keys(ask.group(GROUP)!.newcomers)).toEqual([dana.id]);
    expect(() => ask.approveNewcomer(GROUP, omer.id)).toThrow(/not waiting/);
    ask.approveNewcomer(GROUP, dana.id);
    expect(ask.group(GROUP)!.approved).toEqual([dana.id]);
    expect(ask.group(GROUP)!.newcomers).toEqual({});

    const trusting = bookAt(john, s1, 'trust-admin');
    const t = trusting.receiveState(s2, omer.id, ctxFor(john, [omer], later(2000)));
    expect(t.kind === 'applied' && t.change.newcomers).toEqual([]);
    expect(trusting.group(GROUP)!.approved).toEqual([dana.id]);

    const friends = bookAt(john, s1, 'ask');
    friends.receiveState(s2, omer.id, ctxFor(john, [omer, dana], later(2000)));
    expect(friends.group(GROUP)!.approved).toEqual([dana.id]);
  });

  it('a removed newcomer leaves the queue; a state without us removes us', () => {
    const book = bookAt(john, s1, 'ask');
    book.receiveState(s2, omer.id, ctxFor(john, [omer], later(2000)));
    const s3 = state(omer, 3, s2, [member(omer, 'admin'), member(john)], later(3000));
    book.receiveState(s3, omer.id, ctxFor(john, [omer], later(4000)));
    expect(book.group(GROUP)!.newcomers).toEqual({});
    const s4 = state(omer, 4, s3, [member(omer, 'admin')], later(5000));
    const out = book.receiveState(s4, omer.id, ctxFor(john, [omer], later(6000)));
    expect(out.kind === 'applied' && out.change.left).toBe(true);
    expect(book.group(GROUP)!.status).toBe('removed');
    expect(book.admittedPeers(john.id).size).toBe(0);
  });
});

describe('slice 3 (issue #79): handing on the admin role, and changing our own terms', () => {
  const omer = generateKey();
  const john = generateKey();
  const dana = generateKey();
  const s0 = state(omer, 0, null, [member(omer, 'admin')]);
  const s1 = state(omer, 1, s0, [member(omer, 'admin'), member(john)]);
  const s2 = state(omer, 2, s1, [member(omer, 'admin'), member(john), member(dana)], later(1000));

  it('the last admin cannot leave; it promotes a member, which every member applies; then it can', () => {
    const book = bookAt(omer, s2);
    expect(book.leaveProblem(GROUP, omer.id)).toMatch(/rdv group promote/);
    expect(() => book.promote(john, GROUP, dana.id, ctxFor(john))).toThrow(/only an admin/);
    expect(() => book.promote(omer, GROUP, omer.id, ctxFor(omer))).toThrow(/already an admin/);
    const change = book.promote(omer, GROUP, dana.id, ctxFor(omer, [], later(2000)));
    const s3 = change.record.state;
    expect(s3.epoch).toBe(3);
    expect(memberOf(s3, dana.id)?.role).toBe('admin');
    expect(successorProblem(s2, s3)).toBeNull();
    expect(book.leaveProblem(GROUP, omer.id)).toBeNull();
    const at = bookAt(john, s2, 'trust-admin');
    expect(at.receiveState(s3, omer.id, ctxFor(john, [omer], later(3000)))).toMatchObject({ kind: 'applied' });
    expect(memberOf(at.group(GROUP)!.state, dana.id)?.role).toBe('admin');
  });

  it('our new terms: our join signed again with the new scope; members keep it only from us (or an admin), and only if newer', () => {
    const johnBook = bookAt(john, s2);
    const first = createGroupJoin(john, { group: GROUP, to: omer.id, inviteRef: '00000000-0000-4000-8000-0000000000b1', state: s1, card: cardOf(john), scope: { invoke: {} }, now: T0 });
    johnBook.group(GROUP)!.joins[john.id] = first;
    const join = johnBook.updateTerms(john, GROUP, { scope: { invoke: { [REQUEST]: { max_open: 2 } }, max_frequency: '5/day' }, policy: 'trust-admin', now: later(1000) });
    expect(verifyGroupJoin(join, later(1000))).toMatchObject({ ok: true });
    expect(join).toMatchObject({ from: john.id, to: omer.id, invite_ref: first.invite_ref, state: docHash(s2), scope: { invoke: { [REQUEST]: { max_open: 2 } }, max_frequency: '5/day' } });
    expect(docHash(join.card)).toBe(docHash(first.card));
    expect(johnBook.group(GROUP)!).toMatchObject({ scope: join.scope, policy: 'trust-admin' });
    expect(() => johnBook.updateTerms(john, GROUP, { scope: { invoke: { [GROUPS_EXTENSION]: {} } } })).toThrow(/groups extension/);

    const members = (joins: unknown[]) => ({ type: 'rdv/group-members', group: GROUP, joins });
    const danaBook = bookAt(dana, s2);
    danaBook.group(GROUP)!.joins[john.id] = first;
    // From John himself, his own join only: kept. From Dana's view, Omer (an admin) could send it too.
    expect(danaBook.receiveMembers(members([join]), john.id, ctxFor(dana, [], later(2000)))).toEqual({ group: GROUP, stored: [john.id] });
    expect(danaBook.group(GROUP)!.joins[john.id].scope).toEqual(join.scope);
    // An older one does not replace it, whoever sends it.
    expect(danaBook.receiveMembers(members([first]), john.id, ctxFor(dana, [], later(2000)))).toEqual({ group: GROUP, stored: [] });
    // A member may not carry another member's join.
    const omerBook = bookAt(omer, s2);
    expect(omerBook.receiveMembers(members([join]), dana.id, ctxFor(omer, [], later(2000)))).toMatchObject({ rejected: expect.any(String) });
    expect(omerBook.receiveMembers(members([join]), john.id, ctxFor(omer, [], later(2000)))).toEqual({ group: GROUP, stored: [john.id] });
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

describe('Omer, John and Dana form a group (design B.5 steps 1-3)', () => {
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

  const make = (capabilities = ['rdv/v1', 'a2a/0.3', GROUPS_EXTENSION]) => {
    const agent = Agent.create((key: AgentKey) => new NostrTransport({ key, relays: [relay.url], maxEventsPerSecond: 1000, burst: 1000 }), {
      rendezvous: [{ type: 'nostr', relay: relay.url, pref: 1 }],
      capabilities,
    });
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

  it('Omer creates, invites both, both humans join, and all three hold the same state and joins', async () => {
    const omer = make();
    const john = make();
    const dana = make();
    await contacts(omer, john);
    await contacts(omer, dana);

    const g = omer.createGroup('Microsite launch');
    expect(g.state.epoch).toBe(0);

    // John: invited, his human joins with trust-admin and lets members ask for request/v1.
    const johnInvited = once(john, 'group-invite');
    await omer.inviteToGroup(g.group, john.id, { name: 'John', greeting: 'help with the microsite?' });
    const [ji] = await johnInvited;
    expect(ji.invite.state.members.map((m) => m.id)).toEqual([omer.id]);
    const johnIn = once(john, 'group-state', 5000, (c) => c.admitted);
    await john.joinGroup(ji.invite.id, { scope: { invoke: { [REQUEST]: {} } }, policy: 'trust-admin' });
    expect(john.groups.group(g.group)!.status).toBe('joining');
    await johnIn;

    // Dana: the invite shows Omer (her contact) and John (named by the admin). Policy ask.
    const danaInvited = once(dana, 'group-invite');
    await omer.inviteToGroup(g.group, dana.id, { name: 'Dana' });
    const [di] = await danaInvited;
    expect(di.invite.state.members.map((m) => [m.id, m.name])).toEqual([
      [omer.id, undefined],
      [john.id, 'John'],
    ]);
    const danaIn = once(dana, 'group-state', 5000, (c) => c.admitted);
    const johnSeesDana = once(john, 'group-state', 5000, (c) => c.added.includes(dana.id));
    await dana.joinGroup(di.invite.id, { scope: { invoke: { [REQUEST]: {} } } });
    const [admitted] = (await danaIn) as [GroupChange];
    const [seen] = (await johnSeesDana) as [GroupChange];

    // John trusts the admin: Dana is approved at once. Dana asks: John (not her contact) waits for her human.
    expect(seen.newcomers).toEqual([]);
    expect(admitted.newcomers).toEqual([john.id]);
    expect(dana.groups.group(g.group)!.approved).toEqual([omer.id]);
    dana.approveGroupNewcomer(g.group, john.id);

    // Converged: one state at epoch 2, the same bytes everywhere, and every member's join (cards inside) at each.
    await until(() => [omer, john, dana].every((a) => Object.keys(a.groups.group(g.group)!.joins).length === 3));
    const hashes = [omer, john, dana].map((a) => docHash(a.groups.group(g.group)!.state));
    expect(new Set(hashes).size).toBe(1);
    const s = omer.groups.group(g.group)!.state;
    expect(s.epoch).toBe(2);
    expect(s.members.map((m) => m.id)).toEqual([omer.id, john.id, dana.id]);
    for (const a of [omer, john, dana]) {
      const r = a.groups.group(g.group)!;
      expect(r.status).toBe('active');
      expect([...r.approved].sort()).toEqual([omer.id, john.id, dana.id].filter((id) => id !== a.id).sort());
      expect(r.newcomers).toEqual({});
    }
    // The joins are the group-scoped grants: Dana holds what John lets members invoke on him.
    expect(dana.groups.group(g.group)!.joins[john.id].scope).toEqual({ invoke: { [REQUEST]: {} } });
    // John and Dana are not contacts, yet each keeps the other's channel while both are members (§6.4).
    expect(john.book.contact(dana.id)).toBeUndefined();
    expect(john.groups.admittedPeers(john.id).has(dana.id)).toBe(true);
    expect(dana.groups.memberCard(john.id)?.id).toBe(john.id);
    // The state survives a restart.
    const back = Agent.fromJSON(JSON.parse(JSON.stringify(dana.toJSON())), (key) => new NostrTransport({ key, relays: [relay.url] }));
    expect(docHash(back.groups.group(g.group)!.state)).toBe(hashes[0]);
    back.close();
  });

  it('only contacts are invited, and only peers whose card lists groups; a stranger’s invite is dropped', async () => {
    const omer = make();
    const john = make();
    const old = make(['rdv/v1', 'a2a/0.3']);
    const eve = make();
    await contacts(omer, john);
    await contacts(omer, old);
    const g = omer.createGroup('Microsite launch');
    await expect(omer.inviteToGroup(g.group, eve.id)).rejects.toThrow(/only contacts are invited/);
    await expect(omer.inviteToGroup(g.group, old.id)).rejects.toThrow(/does not list groups/);
    // Eve, not John's contact, sends John an invite of her own group by envelope.
    const eg = eve.createGroup('spam');
    const inv = eve.groups.invite(eve.key, eg.group, john.id);
    const dropped = once(john, 'dropped', 5000, (r) => r.startsWith('group invite'));
    await (eve as unknown as { deliver(p: string, x: object, r: string[]): Promise<unknown> }).deliver(john.id, inv, [relay.url]);
    const [reason] = await dropped;
    expect(reason).toBe('group invite from a non-contact');
    expect(john.groupInvites()).toHaveLength(0);
  });
});
