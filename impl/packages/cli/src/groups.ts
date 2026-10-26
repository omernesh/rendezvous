// Groups in the hosts (SPEC §7.8, issue #77, slice 1: membership). Views and
// terminal text for invites, groups and state changes, and the `rdv group`
// commands. Peer text (the group's name, a member's admin-written name, an
// invite's greeting) goes through clean() before any terminal sees it.
//
// Joining a group and approving a newcomer are the human's (§5.5), every time
// (§5.5.1: auto-approve never covers either): `rdv group join` and `rdv group
// approve` take the code `rdv group pending` shows for exactly what the human
// read, and the consent guard keeps them, and `rdv group pending` with its
// confirm phrases, away from the model. Creating a group, inviting a contact
// and declining an invite are not consent decisions about the human's own
// audience: the first two disclose only what the admin's human chose, the
// third only narrows.
import {
  type Agent,
  docHash,
  fingerprint,
  type GroupChange,
  type GroupRecord,
  type GroupScope,
  groupScope,
  isCapabilityUri,
  memberOf,
  type NewcomerPolicy,
  NEWCOMER_POLICIES,
  parseFrequency,
  type ReceivedInvite,
} from '@rendezvous/core';
import { contactFor, type Ctx, withAgent } from './commands.js';
import { describeGroupTerms, describeInviteAsk, dropPhrase, inviteAskOf, inviteAsks, inviteSubject, joinTarget, newcomerDigest, newcomerKey, newcomerTarget, reissueForDisplay, type ShownPhrase } from './consent.js';
import { CliError, consentKey, type GroupTerms } from './home.js';
import { clean } from './output.js';
import { gateCode } from './tasks.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

/** Our human's view of who a member is: our contact (with our label), or not, named by the admin as …. */
export interface MemberView {
  id: string;
  fingerprint: string;
  role: 'admin' | 'member';
  /** Admin-written display text; never verified, never a label. */
  name?: string;
  contact: boolean;
  /** Our own label for a member who is our contact. */
  label?: string;
}

export function memberViews(agent: Agent, members: Array<{ id: string; role: 'admin' | 'member'; name?: string }>): MemberView[] {
  return members.map((m) => {
    const c = m.id === agent.id ? undefined : agent.book.contact(m.id);
    return {
      id: m.id,
      fingerprint: fingerprint(m.id),
      role: m.role,
      ...(m.name !== undefined ? { name: m.name } : {}),
      contact: !!c && !agent.book.isBlocked(m.id),
      ...(c?.label !== undefined ? { label: c.label } : {}),
    };
  });
}

/** One member in words: "rdv1:ab12…cd34 (admin), your contact "Omer"" or "…, not your contact, named by the admin as "John"". */
export function memberText(m: MemberView, me: string): string {
  const who =
    m.id === me
      ? 'you'
      : m.contact
        ? `your contact${m.label !== undefined ? ` ${JSON.stringify(clean(m.label))}` : ''}`
        : `not your contact${m.name !== undefined ? `, named by the admin as ${JSON.stringify(clean(m.name))}` : ', unnamed'}`;
  return `${clean(m.fingerprint)} (${m.role}), ${who}`;
}

const isContactOf = (agent: Agent) => (peer: string) => !!agent.book.contact(peer) && !agent.book.isBlocked(peer);

export function inviteView(agent: Agent, i: ReceivedInvite) {
  const inv = i.invite;
  return {
    event: 'group-invite',
    invite: inv.id,
    group: inv.group,
    from: inv.from,
    fingerprint: fingerprint(inv.from),
    /** The group's name and the greeting: written by the admin (peer text). */
    name: inv.state.name,
    greeting: inv.greeting,
    epoch: inv.state.epoch,
    members: memberViews(agent, inv.state.members),
    received: i.received,
    expires: inv.expires,
  };
}

/** The invite in words, for the human (and for an approval form): who asks, who is in it, what they say. */
export function describeInvite(agent: Agent, i: ReceivedInvite): string {
  const v = inviteView(agent, i);
  const admin = v.members.find((m) => m.id === v.from);
  return [
    `group ${JSON.stringify(clean(v.name))} (${clean(v.group)}), invite ${clean(v.invite)} from ${admin ? memberText(admin, agent.id) : clean(v.fingerprint)}`,
    `members now (${v.members.length}):`,
    ...v.members.map((m) => `  - ${memberText(m, agent.id)}`),
    ...(v.greeting ? [`greeting (written by the admin, not verified): ${JSON.stringify(clean(v.greeting))}`] : []),
    `expires ${clean(v.expires)}`,
  ].join('\n');
}

export function groupView(agent: Agent, r: GroupRecord) {
  return {
    event: 'group',
    group: r.group,
    name: r.state.name,
    status: r.status,
    epoch: r.state.epoch,
    state: docHash(r.state).slice(0, 16),
    members: memberViews(agent, r.state.members).map((m) => ({
      ...m,
      approved: r.approved.includes(m.id),
      waiting_for_you: Object.hasOwn(r.newcomers, m.id),
      has_card: m.id === agent.id || Object.hasOwn(r.joins, m.id),
    })),
    newcomers: r.policy,
    /** What members may invoke on us through this group (our join). */
    invoke: Object.keys(r.scope.invoke ?? {}).sort(),
    ...(r.scope.max_frequency ? { max_frequency: r.scope.max_frequency } : {}),
    ...(r.frozen ? { frozen: { epoch: r.frozen.epoch, signers: r.frozen.signers, since: r.frozen.since } } : {}),
  };
}

export function groupText(agent: Agent, r: GroupRecord): string {
  const v = groupView(agent, r);
  const status = r.status === 'joining' ? 'JOINING (waiting for the admin to add you)' : r.status === 'removed' ? 'REMOVED' : 'member';
  const lines = [
    `${clean(r.group)}  ${JSON.stringify(clean(v.name))}  ${status}, epoch ${v.epoch}, newcomers ${v.newcomers}`,
    ...v.members.map((m) => {
      const mark = m.id === agent.id ? '' : m.waiting_for_you ? '  WAITING FOR YOUR APPROVAL (gets nothing from you yet)' : m.approved ? '' : '  not approved';
      return `  - ${memberText(m, agent.id)}${mark}`;
    }),
    `  members may invoke on you: ${v.invoke.length ? v.invoke.map((u) => clean(u)).join(', ') : 'nothing'}${v.max_frequency ? ` (at most ${v.max_frequency})` : ''}`,
  ];
  if (r.frozen) {
    lines.push(
      `  MEMBERSHIP FROZEN since ${clean(r.frozen.since)}: two different member lists at epoch ${r.frozen.epoch}, signed by ${signersText(r)}. ` +
        `Check with the admins, then run: rdv group resync ${clean(r.group)}`,
    );
  }
  return lines.join('\n');
}

export function changeView(c: GroupChange) {
  return {
    event: 'group-state',
    group: c.record.group,
    name: c.record.state.name,
    epoch: c.record.state.epoch,
    added: c.added,
    removed: c.removed,
    newcomers: c.newcomers,
    admitted: c.admitted,
    left: c.left,
  };
}

export function changeText(c: GroupChange): string {
  const name = JSON.stringify(clean(c.record.state.name));
  const fp = (ids: string[]) => ids.map((id) => clean(fingerprint(id))).join(', ');
  if (c.left) return `group ${name} (${clean(c.record.group)}): you are no longer a member (epoch ${c.record.state.epoch})`;
  const parts = [
    ...(c.admitted ? ['you are in'] : []),
    ...(c.added.length && !c.admitted ? [`added ${fp(c.added)}`] : []),
    ...(c.removed.length ? [`removed ${fp(c.removed)}`] : []),
  ];
  const ask = c.newcomers.length
    ? `. Not your contacts, so they get nothing from you until you approve them: ${fp(c.newcomers)} (see: rdv group pending)`
    : '';
  return `group ${name} (${clean(c.record.group)}) epoch ${c.record.state.epoch}: ${parts.join(', ') || 'updated'}${ask}`;
}

const signersText = (r: GroupRecord): string => (r.frozen?.signers ?? []).map((id) => clean(fingerprint(id))).join(' and ') || 'an admin';

export function forkText(r: GroupRecord): string {
  return (
    `group ${JSON.stringify(clean(r.state.name))} (${clean(r.group)}): two different member lists at epoch ${r.frozen?.epoch}, signed by ${signersText(r)}. ` +
    `Membership is frozen at the state you hold; check with the admins, then run: rdv group resync ${clean(r.group)}`
  );
}

/** The code `rdv group pending` shows for an invite: you join exactly the invite you read. */
export const inviteCode = (agent: Agent, i: ReceivedInvite): string => gateCode(inviteSubject(i, isContactOf(agent)));
export const newcomerCode = (r: GroupRecord, member: string): string => gateCode(newcomerDigest(r, member));

/** The join's terms from `--invoke <uri>`, `--max-frequency` and `--newcomers`: checked before anything is sent. */
export function groupTermsArgs(values: Ctx['values']): GroupTerms {
  const invoke: Record<string, Record<string, never>> = {};
  for (const u of list(values.invoke)) {
    if (!isCapabilityUri(u)) throw new CliError(`--invoke takes a capability URI (https, at most 200 characters, no wildcard): ${clean(u)}`, 2);
    invoke[u] = {};
  }
  const max = str(values['max-frequency']);
  if (max !== undefined && !parseFrequency(max)) throw new CliError('--max-frequency is "<n>/<minute|hour|day>"', 2);
  const newcomers = (str(values.newcomers) ?? 'ask') as NewcomerPolicy;
  if (!NEWCOMER_POLICIES.includes(newcomers)) throw new CliError('--newcomers is ask or trust-admin', 2);
  let scope: GroupScope;
  try {
    scope = groupScope({ invoke, ...(max !== undefined ? { max_frequency: max } : {}) });
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  return { scope, newcomers };
}

function codeArg(v: unknown, what: string): string {
  const code = (str(v) ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!code) throw new CliError(`--code <code> is required: the code "rdv group pending" shows, so you ${what} exactly what you read`, 2);
  return code;
}

// --- commands -----------------------------------------------------------------------------

/** `rdv group create <name>`: a group with you as its only member and admin. Members may invoke nothing on you through it. */
export async function groupCreate({ home, out, positionals }: Ctx): Promise<void> {
  const r = await withAgent(home, async (agent) => {
    try {
      return { view: groupView(agent, agent.createGroup(positionals[0])), id: agent.id };
    } catch (err) {
      throw new CliError((err as Error).message, 2);
    }
  });
  out.emit({ ...r.view, event: 'group-created' }, `created group ${clean(r.view.group)} ${JSON.stringify(clean(r.view.name))}; invite contacts with: rdv group invite ${clean(r.view.group)} <agent-id|label>`);
}

/**
 * `rdv group invite <group-id> <agent-id|label> [--name <shown to members>] [--greeting <text>]`:
 * only your contacts. The human's command (review of #80): the invitee sees the
 * members and, once it joins, their cards and terms.
 */
export async function groupInvite({ home, out, values, positionals }: Ctx): Promise<void> {
  const [group, target] = positionals;
  const inv = await withAgent(home, async (agent) => {
    const peer = contactFor(agent, target);
    try {
      return await agent.inviteToGroup(group, peer, { greeting: str(values.greeting), name: str(values.name) });
    } catch (err) {
      throw new CliError((err as Error).message);
    }
  });
  const name = str(values.name);
  const greeting = str(values.greeting);
  out.emit(
    { event: 'group-invited', group, invite: inv.id, to: inv.to, fingerprint: fingerprint(inv.to), expires: inv.expires, ...(name !== undefined ? { name } : {}), ...(greeting !== undefined ? { greeting } : {}) },
    `invited ${clean(fingerprint(inv.to))} to group ${clean(group)} (invite ${clean(inv.id)}, expires ${clean(inv.expires)})` +
      `${name !== undefined ? `, shown to the members as ${clean(JSON.stringify(name))}` : ''}${greeting !== undefined ? `, greeting ${clean(JSON.stringify(greeting))}` : ''}; their human decides whether to join`,
  );
}

/** `rdv group list`: your groups and the invites waiting for you (no codes, no confirm phrases: see rdv group pending). */
export async function groupList({ home, out }: Ctx): Promise<void> {
  const { groups, invites } = await withAgent(
    home,
    async (agent) => ({
      groups: agent.groupList().map((r) => ({ view: groupView(agent, r), text: groupText(agent, r) })),
      invites: agent.groupInvites().map((i) => ({ view: inviteView(agent, i), text: describeInvite(agent, i) })),
    }),
    { save: false },
  );
  if (groups.length === 0 && invites.length === 0 && !out.json) out.emit({}, 'no groups and no invites');
  for (const g of groups) out.emit(g.view, g.text);
  for (const i of invites) out.emit(i.view, `INVITE ${i.text}\n  your human decides: rdv group pending shows how to join or decline`);
}

/**
 * `rdv group pending`: what waits for YOU, the human: invites (with the code
 * that joins exactly that invite) and newcomers (with the code that approves
 * exactly that member). Like `rdv contact pending`, text mode re-issues and
 * shows the MCP server's confirm phrases (only hashes are stored), so it is
 * the human's command; `--json` shows the codes only.
 */
export async function groupPending({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const rows = await withAgent(
    home,
    async (agent) => {
      const contact = isContactOf(agent);
      const invites = agent.groupInvites().sort((a, b) => a.received.localeCompare(b.received));
      const newcomers = agent
        .groupList()
        .filter((r) => r.status === 'active')
        .flatMap((r) => Object.keys(r.newcomers).map((m) => ({ r, m })));
      const asks = inviteAsks(home);
      const shown =
        out.json || (invites.length === 0 && newcomers.length === 0 && asks.length === 0)
          ? new Map<string, ShownPhrase>()
          : reissueForDisplay(home, [...invites.map((i) => joinTarget(i, contact)), ...newcomers.map(({ r, m }) => newcomerTarget(r, m)), ...asks]);
      return {
        invites: invites.map((i) => ({ view: inviteView(agent, i), text: describeInvite(agent, i), code: inviteCode(agent, i), phrase: shown.get(consentKey('group-join', i.invite.id)) })),
        newcomers: newcomers.map(({ r, m }) => {
          const v = memberViews(agent, [memberOf(r.state, m)!])[0];
          return { group: r, member: v, code: newcomerCode(r, m), phrase: shown.get(consentKey('group-newcomer', newcomerKey(r.group, m))) };
        }),
        asks: asks.flatMap((t) => {
          const a = inviteAskOf(t);
          const phrase = shown.get(consentKey('group-invite', t.id));
          return a && phrase ? [{ ask: a, phrase }] : [];
        }),
      };
    },
    { save: false },
  );
  if (rows.invites.length === 0 && rows.newcomers.length === 0 && rows.asks.length === 0 && !out.json) out.emit({}, 'nothing waits for you in groups');
  // Text mode only (asks is empty with --json): the assistant asked to send an invite.
  for (const a of rows.asks) {
    out.emit(
      { event: 'group-invite-ask', group: a.ask.group, peer: a.ask.peer },
      `your assistant asks to ${clean(describeInviteAsk(a.ask, fingerprint))}` +
        `\n  confirm phrase (tell it to your MCP client to send it): ${clean(a.phrase.phrase)}  (replaces any phrase shown before)` +
        `\n  or send it yourself: rdv group invite ${clean(a.ask.group)} ${clean(a.ask.peer)}`,
    );
  }
  for (const i of rows.invites) {
    const phrase = i.phrase
      ? `\n  confirm phrase (tell it to your MCP client to join): ${clean(i.phrase.phrase)}  (replaces any phrase shown before)\n  it approves: ${clean(describeGroupTerms(i.phrase.group!))}`
      : '';
    out.emit(
      { ...i.view, code: i.code },
      `INVITE ${i.text}\n  to join: rdv group join ${clean(i.view.invite)} --code ${i.code} [--invoke <capability-uri>]... [--newcomers ask|trust-admin]` +
        `\n  (by default members may invoke nothing on you, and you are asked about each newcomer who is not your contact)` +
        `\n  to say no: rdv group decline ${clean(i.view.invite)}${phrase}`,
    );
  }
  for (const n of rows.newcomers) {
    const phrase = n.phrase ? `\n  confirm phrase (tell it to your MCP client to approve them): ${clean(n.phrase.phrase)}  (replaces any phrase shown before)` : '';
    out.emit(
      { event: 'group-newcomer', group: n.group.group, name: n.group.state.name, member: n.member, code: n.code },
      `NEWCOMER in group ${JSON.stringify(clean(n.group.state.name))} (${clean(n.group.group)}): ${memberText(n.member, '')}. ` +
        `They get nothing from you (your group messages, later) until you approve.\n  to approve: rdv group approve ${clean(n.group.group)} ${clean(n.member.id)} --code ${n.code}${phrase}`,
    );
  }
}

/** `rdv group join <invite-id> --code <code> [--invoke <uri>]... [--max-frequency f] [--newcomers ask|trust-admin]`: the human joins. */
export async function groupJoin({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const code = codeArg(values.code, 'join');
  const terms = groupTermsArgs(values);
  const r = await withAgent(home, async (agent) => {
    const i = agent.groupInvites().find((x) => x.invite.id === id);
    if (!i) throw new CliError(`no pending group invite ${clean(id)} (see "rdv group pending")`);
    if (inviteCode(agent, i) !== code) {
      throw new CliError(`invite ${clean(id)} is not the invite you read (it changed, or the code is wrong). You did not join: run "rdv group pending" and check it again.`);
    }
    let rec: GroupRecord;
    try {
      rec = await agent.joinGroup(id, { scope: terms.scope, policy: terms.newcomers });
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    dropPhrase(home, { action: 'group-join', id });
    return groupView(agent, rec);
  });
  out.emit(
    { ...r, event: 'group-joining' },
    `asked to join group ${JSON.stringify(clean(r.name))} (${clean(r.group)}): ${clean(describeGroupTerms(terms))}. The admin adds you next; "rdv group list" shows it`,
  );
}

/** `rdv group decline <invite-id>`: say no to an invite (reduce-only; nothing is sent). */
export async function groupDecline({ home, out, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  await withAgent(home, async (agent) => {
    if (!agent.declineGroupInvite(id)) throw new CliError(`no pending group invite ${clean(id)}`);
    dropPhrase(home, { action: 'group-join', id });
  });
  out.emit({ event: 'group-declined', invite: id }, `declined group invite ${clean(id)}`);
}

/** `rdv group approve <group-id> <agent-id> --code <code>`: the human lets a newcomer receive their group traffic. */
export async function groupApprove({ home, out, values, positionals }: Ctx): Promise<void> {
  const [group, member] = positionals;
  const code = codeArg(values.code, 'approve');
  const v = await withAgent(home, async (agent) => {
    const r = agent.groups.group(group);
    if (!r || r.status !== 'active' || !Object.hasOwn(r.newcomers, member)) throw new CliError(`${clean(member)} is not waiting for your approval in group ${clean(group)} (see "rdv group pending")`);
    if (newcomerCode(r, member) !== code) throw new CliError('that is not the member you reviewed (it changed, or the code is wrong). Nothing was approved: run "rdv group pending" and check again.');
    agent.approveGroupNewcomer(group, member);
    dropPhrase(home, { action: 'group-newcomer', id: newcomerKey(group, member) });
    return groupView(agent, r);
  });
  out.emit({ ...v, event: 'group-approved', member }, `approved ${clean(fingerprint(member))} in group ${JSON.stringify(clean(v.name))}`);
}

/** `rdv group resync <group-id>`: after a membership fork, once you checked with the admin: the group thaws at the state you hold. */
export async function groupResync({ home, out, positionals }: Ctx): Promise<void> {
  const v = await withAgent(home, async (agent) => {
    try {
      return groupView(agent, agent.resyncGroup(positionals[0]));
    } catch (err) {
      throw new CliError((err as Error).message);
    }
  });
  out.emit({ ...v, event: 'group-resynced' }, `group ${clean(v.group)} re-synced at epoch ${v.epoch}`);
}
