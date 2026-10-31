// Invite links (SPEC §5.2.3, NOTES 101): `rdv invite create|list|revoke`
// for the inviter's human, `rdv invite accept <link>` (and `rdv init
// --invite`) for the invitee. Shared with the MCP server.
import {
  type Agent,
  type CreatedInvite,
  fingerprint,
  type GrantScope,
  type Invite,
  INVITE_TIERS,
  inviteExpired,
  inviteShareText,
  type InviteView,
  parseInvite,
  type Tier,
} from '@rendezvous/core';
import { type Ctx, invokeScope, tierOf, withAgent } from './commands.js';
import { CliError, type Home } from './home.js';
import { clean } from './output.js';

/**
 * TEST ONLY: relays an invite link may name although they are not public
 * `wss://` hosts (the in-memory test relay is `ws://127.0.0.1:…`), from
 * `RDV_TEST_UNSAFE_INVITE_RELAYS` (comma-separated exact URLs). Never set it
 * otherwise: an invite's relays are someone else's text (review of PR #120).
 * Honoured only when `NODE_ENV` is `test` (vitest sets it, and the `rdv`
 * processes the tests spawn inherit it), so a stray variable in a real
 * environment opens nothing (re-review of PR #120).
 */
export function unsafeInviteRelays(extra: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = env.NODE_ENV === 'test' ? (env.RDV_TEST_UNSAFE_INVITE_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return [...listed, ...extra];
}

/** How long an invite lasts: a duration (12h, 7d, 2w) or an RFC 3339 time, at most 30 days. Default 7 days. */
export function parseInviteExpiry(v: string | undefined, now = new Date()): string {
  const t = now.getTime();
  if (v === undefined) return new Date(t + 7 * 86_400_000).toISOString();
  const m = /^\s*(\d{1,4})\s*([hdw])\s*$/i.exec(v);
  const unit: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
  const at = m ? t + Number(m[1]) * unit[m[2].toLowerCase()] : Date.parse(v.trim());
  if (!Number.isFinite(at) || (!m && !/^\d{4}-\d{2}-\d{2}T/.test(v.trim()))) throw new CliError('--expires takes a duration (12h, 7d, 2w) or an RFC 3339 time', 2);
  if (at <= t) throw new CliError('--expires must be in the future', 2);
  if (at - t > 30 * 86_400_000) throw new CliError('an invite may last at most 30 days', 2);
  return new Date(at).toISOString();
}

/** The tier an invite gives: friend and below (a link can be forwarded). */
export function inviteTier(t: Tier | undefined): Tier {
  const tier = t ?? 'friend';
  if (!(INVITE_TIERS as readonly string[]).includes(tier)) {
    throw new CliError(`an invite can give tiers ${INVITE_TIERS.join(', ')}; grant "${tier}" to the contact once they are one`, 2);
  }
  return tier;
}

/** What `rdv invite create` and `rdv_invite` "create" return: the link, shown once, and a message ready to send. */
export interface InviteResult {
  invite_id: string;
  url: string;
  share_text: string;
  expires: string;
  tier: Tier;
  scope: GrantScope;
  name?: string;
  label?: string;
}

/** Make an invite (the owner's decision, already taken). Call inside `withAgent`. */
export function createInviteIn(agent: Agent, opts: { tier: Tier; scope?: GrantScope; expires: string; name?: string; label?: string }): InviteResult {
  let made: CreatedInvite;
  try {
    made = agent.createInvite({ tier: opts.tier, scope: opts.scope, expires: opts.expires, name: opts.name, label: opts.label });
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  return {
    invite_id: made.invite.id,
    url: made.url,
    share_text: inviteShareText(made.url, { name: made.invite.name, expires: made.invite.expires }),
    expires: made.invite.expires,
    tier: made.invite.tier,
    scope: made.invite.scope,
    ...(made.invite.name !== undefined ? { name: made.invite.name } : {}),
    ...(made.invite.label !== undefined ? { label: made.invite.label } : {}),
  };
}

/** An invite in a list: no secret (there is none to show) and who redeemed it. */
export function inviteListView(v: InviteView) {
  return {
    invite_id: v.id,
    status: v.status,
    created: v.created,
    expires: v.expires,
    tier: v.tier,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.used ? { redeemed_at: v.used.at, redeemed_by: v.used.by, redeemed_by_fingerprint: fingerprint(v.used.by) } : {}),
    ...(v.revoked ? { revoked_at: v.revoked, revoked_by: v.revokedBy ?? 'owner' } : {}),
  };
}

/** A link our human was given, read and checked (expiry, not our own): CliError with the reason otherwise. */
export function readInvite(text: string, agent?: Agent, opts: { unsafeAllowRelays?: readonly string[] } = {}): Invite {
  let inv: Invite;
  try {
    inv = parseInvite(text, { unsafeAllowRelays: unsafeInviteRelays(opts.unsafeAllowRelays) });
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  if (inviteExpired(inv)) throw new CliError(`that invite expired on ${inv.expires}: ask ${inv.name ? `${clean(inv.name)} (as the link calls them)` : 'the person who sent it'} for a new one`);
  if (agent && inv.agentId === agent.id) throw new CliError('that invite is your own: send it to the person you invite');
  return inv;
}

export interface AcceptResult {
  request_id: string;
  to: string;
  fingerprint: string;
  /** The name the link carries: the inviter's own words, not verified. */
  name_in_link?: string;
  expires: string;
}

/** Send the contact request an invite asks for. Call inside `withAgent`. */
export async function acceptInviteIn(agent: Agent, inv: Invite, greeting: string, opts: { unsafeAllowRelays?: readonly string[] } = {}): Promise<AcceptResult> {
  let req;
  try {
    req = await agent.acceptInvite(inv, greeting, new Date(), { unsafeAllowRelays: unsafeInviteRelays(opts.unsafeAllowRelays) });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const msg = (err as Error).message;
    throw /already a contact|your own|expired|not a usable invite/.test(msg) ? new CliError(msg) : err;
  }
  return {
    request_id: req.id,
    to: inv.agentId,
    fingerprint: fingerprint(inv.agentId),
    ...(inv.name !== undefined ? { name_in_link: inv.name } : {}),
    expires: inv.expires,
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export async function inviteCreate({ home, out, values }: Ctx): Promise<void> {
  const tier = inviteTier(tierOf(values.tier));
  const scope = invokeScope(undefined, values.invoke, values['no-meetings'] === true);
  const expires = parseInviteExpiry(str(values.expires));
  const r = await withAgent(home, async (agent, config) =>
    createInviteIn(agent, { tier, scope, expires, name: str(values.name) ?? (config.profile === 'default' ? undefined : config.profile), label: str(values.label) }),
  );
  out.emit(
    { event: 'invite', ...r },
    [
      `invite ${r.invite_id}: whoever opens this link first becomes your contact (tier ${r.tier}), until ${r.expires}.`,
      'It is shown only now; anyone you forward it to can use it. Revoke it with "rdv invite revoke ' + r.invite_id + '".',
      '',
      r.url,
      '',
      'Ready to send (WhatsApp, SMS, email):',
      '',
      r.share_text,
    ].join('\n'),
  );
}

export async function inviteList({ home, out }: Ctx): Promise<void> {
  const list = await withAgent(home, async (agent) => agent.book.listInvites());
  if (list.length === 0 && !out.json) out.emit({}, 'no invites');
  for (const v of list) {
    const x = inviteListView(v);
    out.emit(
      { event: 'invite', ...x },
      `${x.invite_id}  ${x.status}  tier ${x.tier}  expires ${x.expires}` +
        (x.label ? `  for ${clean(x.label)}` : '') +
        (x.redeemed_by ? `  redeemed by ${x.redeemed_by} (${x.redeemed_by_fingerprint}) at ${x.redeemed_at}` : ''),
    );
  }
}

export async function inviteRevoke({ home, out, positionals }: Ctx): Promise<void> {
  const v = await withAgent(home, async (agent) => agent.book.revokeInvite(positionals[0]));
  if (!v) throw new CliError(`no invite ${positionals[0]} (see "rdv invite list")`);
  out.emit({ event: 'invite-revoked', ...inviteListView(v) }, v.status === 'used' ? `invite ${v.id} was already used; revoke the contact instead (rdv contact revoke)` : `invite ${v.id} revoked`);
}

export const profileArg = (profile: string): string => (profile === 'default' ? '' : ` --profile ${profile}`);

/** The text `rdv invite accept` and `rdv init --invite` print after sending. */
export function acceptText(r: AcceptResult, profileArg: string): string {
  return (
    `request ${r.request_id} sent to ${r.to} (fingerprint ${r.fingerprint})` +
    (r.name_in_link ? `, who the link says is "${clean(r.name_in_link)}" (unverified)` : '') +
    `.\nTheir agent connects you as soon as it is online. Run "rdv listen${profileArg}" to receive the answer and their messages.`
  );
}

export async function inviteAccept({ home, out, values, positionals }: Ctx): Promise<void> {
  const { r, profile } = await withAgent(home, async (agent, config) => {
    const inv = readInvite(positionals[0], agent);
    return { r: await acceptInviteIn(agent, inv, str(values.greeting) ?? `${config.profile}'s agent accepts your invite.`), profile: config.profile };
  });
  out.emit({ event: 'request-sent', via: 'invite', ...r }, acceptText(r, profileArg(profile)));
}

/** `rdv init --invite <link>`: the link is checked before the agent is made, and redeemed right after. */
export async function acceptAfterInit(home: Home, link: Invite, profile: string): Promise<AcceptResult> {
  return withAgent(home, async (agent) => acceptInviteIn(agent, link, `${profile}'s agent accepts your invite.`));
}
