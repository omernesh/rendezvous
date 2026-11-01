// The owner's gateway settings page (issue #102 item 7, NOTES 110): access
// tokens, connected OAuth apps, auto-approved contacts (NOTES 112), invites by the assistant (NOTES 113), the PIN and the webhooks, per agent, behind
// the same PIN unlock, session, CSRF token and CSP as the approval page. No
// JavaScript. Never shows a token's value (except once, on the page that made
// it), a hash, the PIN or a webhook secret. Adding, removing and migrating
// agents, setting a webhook and the first PIN stay in the terminal.
import { MEETINGS_CAPABILITY } from '@rendezvous/core';
import { agentTag, type AgentLabel, flash, type Flash, layout } from './pages.js';
import { escapeHtml as e } from './http.js';
import { SCOPE_TEXT, SCOPES, type Scope } from './scopes.js';

export interface AdminToken {
  id: string;
  name: string;
  scopes: Scope[];
  created: string;
  /** Made for another identity than the agent served under its name now: it reaches nothing. */
  stale?: boolean;
}

export interface AdminGrant {
  id: string;
  /** What the client called itself: untrusted. */
  client: string;
  clientId: string;
  host: string;
  scopes: Scope[];
  created: string;
  lastUsed: number;
  stale?: boolean;
}

export interface AdminWebhook {
  /** Scheme and host only: a path or query may hold the receiver's own token. */
  receiver: string;
  events: string[];
  insecureHosts: string[];
  since: string;
  previousUntil?: string;
  waiting: number;
}

/** A contact on auto-approve now (NOTES 112). `label` is the owner's own name for it. */
export interface AdminAutoApproved {
  peer: string;
  fingerprint: string;
  label?: string;
  capabilities: string[];
  until: string | null;
}

/** An open invite link that would put whoever uses it on auto-approve (NOTES 112). Never the link or its secret. */
export interface AdminArmedInvite {
  id: string;
  label?: string;
  expires: string;
  covers: string[];
}

/** An open invite link the assistant made without asking (NOTES 113). `note` is the assistant's own word for the person: untrusted. Never the link or its secret. */
export interface AdminAssistantInvite {
  id: string;
  note?: string;
  created: string;
  expires: string;
}

export interface AdminAgent extends AgentLabel {
  tokens: AdminToken[];
  grants: AdminGrant[];
  autoApproved: AdminAutoApproved[];
  armedInvites: AdminArmedInvite[];
  /** When the owner let the assistant make invites without asking; absent: it asks. */
  assistantInvitesSince?: string;
  /** The command that adds `invite_created_by_assistant` to this agent's webhook, set when it has one that omits the event. */
  inviteEventCommand?: string;
  assistantInvites: AdminAssistantInvite[];
  webhook?: AdminWebhook;
  dead: number;
}

export interface AdminClient {
  id: string;
  name: string;
  hosts: string[];
  created: string;
  /** The agents its grants reach (names here). */
  agents: string[];
}

export interface AdminView {
  agents: AdminAgent[];
  /** Tokens and grants bound to no agent served here now: they reach nothing, and only a revoke is offered. */
  orphans: { tokens: AdminToken[]; grants: AdminGrant[] };
  clients: AdminClient[];
  csrf: string;
  message?: Flash;
}

const hidden = (name: string, value: string) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;

/** A one-button post: the session's CSRF token, the agent it is for, and what it acts on. */
function button(action: string, csrf: string, fields: Record<string, string>, label: string): string {
  return `<form method="post" action="${e(action)}" class="inline">${hidden('csrf', csrf)}${Object.entries(fields)
    .map(([k, v]) => hidden(k, v))
    .join('')}<button type="submit">${e(label)}</button></form>`;
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function tokenRows(tokens: AdminToken[], agent: string, csrf: string): string {
  if (!tokens.length) return '<p class="muted">No access tokens.</p>';
  return `<table class="admin"><thead><tr><th>Name</th><th>Scopes</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody>${tokens
    .map(
      (t) =>
        `<tr><td><b>${e(t.name)}</b><br><span class="muted">${e(t.id)}</span>${t.stale ? '<br><span class="suggest warn">Made for another identity: it reaches nothing. Revoke it.</span>' : ''}</td><td>${e(t.scopes.join(', '))}</td><td>${e(when(t.created))}</td><td class="muted">not recorded</td><td>${button('/approve/admin/token/revoke', csrf, { agent, id: t.id }, 'Revoke')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function grantRows(grants: AdminGrant[], agent: string, csrf: string): string {
  if (!grants.length) return '<p class="muted">No connected apps.</p>';
  return `<table class="admin"><thead><tr><th>App (its own name, untrusted)</th><th>Returns to</th><th>Scopes</th><th>Connected</th><th>Last refresh</th><th></th></tr></thead><tbody>${grants
    .map(
      (g) =>
        `<tr><td><b>${e(g.client)}</b><br><span class="muted">${e(g.id)}</span>${g.stale ? '<br><span class="suggest warn">Made for another identity: it reaches nothing. Revoke it.</span>' : ''}</td><td>${e(g.host)}</td><td>${e(g.scopes.join(', '))}</td><td>${e(when(g.created))}</td><td>${e(when(new Date(g.lastUsed).toISOString()))}</td><td>${button('/approve/admin/oauth/revoke', csrf, { agent, id: g.id }, 'Disconnect')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** Only turning off is here: turning on stays on approval forms, in front of what it approves. */
function autoRows(list: AdminAutoApproved[], agent: string, csrf: string): string {
  if (!list.length) return '<p class="muted">No contact is on auto-approve: everything asks you.</p>';
  const covers = (u: string) => (u === MEETINGS_CAPABILITY ? 'dinners they propose' : `tasks that ask ${u}`);
  return `<table class="admin"><thead><tr><th>Contact</th><th>Happens without asking you</th><th>Until</th><th></th></tr></thead><tbody>${list
    .map(
      (c) =>
        `<tr><td>${c.label ? `<b>${e(c.label)}</b><br>` : ''}<span class="muted">${e(c.fingerprint)}</span></td><td>${c.capabilities.map((u) => e(covers(u))).join('<br>')}</td><td>${c.until ? e(when(c.until)) : 'you turn it off'}</td><td>${button('/approve/admin/auto-approve/off', csrf, { agent, peer: c.peer }, 'Turn off')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** Open invite links armed with "Don't ask again": Disarm leaves the link working as an ordinary invite. Never the link itself. */
function armedRows(list: AdminArmedInvite[], agent: string, csrf: string): string {
  if (!list.length) return '';
  const covers = (u: string) => (u === MEETINGS_CAPABILITY ? 'dinners they propose' : `tasks that ask ${u}`);
  return `<p class="muted">Open invite links that put whoever uses them on auto-approve. Disarm takes that off; the link keeps working as an ordinary invite.</p><table class="admin"><thead><tr><th>Invite</th><th>Would happen without asking you</th><th>Link works until</th><th></th></tr></thead><tbody>${list
    .map(
      (i) =>
        `<tr><td>${i.label ? `<b>${e(i.label)}</b><br>` : ''}<span class="muted">${e(i.id)}</span></td><td>${i.covers.map((u) => e(covers(u))).join('<br>')}</td><td>${e(when(i.expires))}</td><td>${button('/approve/admin/invite/disarm', csrf, { agent, id: i.id }, 'Disarm')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** The terminal command that adds the event to a webhook set before it existed (NOTES 113). `events` are the webhook's own. */
export function inviteEventCommand(agent: string, events: string[]): string {
  return `rdv-gateway notify set ${agent} --url https://… --secret-file <path> --events ${[...events, 'invite_created_by_assistant'].join(',')}`;
}

/** "My assistant may create invites without asking" (NOTES 113): on needs the PIN again, off only the session. */
function assistantInvitesPart(a: AdminAgent, csrf: string): string {
  const open = a.assistantInvites.length
    ? `<p class="muted">Links it made that nobody has used yet. Revoke one and it stops working. Who it says a link is for is only your assistant's note: whoever opens a link first gets it.</p><table class="admin"><thead><tr><th>Invite</th><th>Its note</th><th>Made</th><th>Works until</th><th></th></tr></thead><tbody>${a.assistantInvites
        .map(
          (i) =>
            `<tr><td class="muted">${e(i.id)}</td><td>${i.note ? e(i.note) : '<span class="muted">none</span>'}</td><td>${e(when(i.created))}</td><td>${e(when(i.expires))}</td><td>${button('/approve/admin/invite/revoke', csrf, { agent: a.name, id: i.id }, 'Revoke')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No open link made this way.</p>';
  const what =
    '<p class="muted">With this on, when you say "invite Ran" your assistant gets the link right away, with no page and no PIN, and can give it to you in chat or email it. Every such link makes a <b>stranger</b>: they can message your agent, but cannot propose meetings, cannot invoke anything and get no standing approval, and the link lasts at most 7 days. Your assistant cannot pick more: asking for more comes here for your approval, as does a sixth open link, a 21st link in 24 hours (revoked ones count), or any link while your agent accepts only its allowlist.</p>' +
    '<p class="muted"><b>The risk:</b> an assistant steered by a prompt injection could make these links too and hand them to someone. Whoever opens one becomes a stranger contact who can message your agent, and your assistant, if it can send, can message that contact back by its agent id: it is an outbound channel as well as an inbound one (your assistant can already make a contact this way by accepting a link, with no one asking you). You hear about each link by webhook if your webhook includes the <code>invite_created_by_assistant</code> event, and you can revoke each below. The contact stays unnamed until you name it.</p>';
  const id = `aip_${a.name}`;
  const toggle = a.assistantInvitesSince
    ? `<p>On since ${e(when(a.assistantInvitesSince))}.</p>${button('/approve/admin/assistant-invites/off', csrf, { agent: a.name }, 'Turn this off')}<p class="muted">Off: every new invite asks you again. Links already made keep working until you revoke them.</p>`
    : `<p>Off: every invite asks you on an approval page.</p><form method="post" action="/approve/admin/assistant-invites/on">${hidden('csrf', csrf)}${hidden('agent', a.name)}
<label for="${e(id)}">Your PIN, again (this lasts until you turn it off)</label><input type="password" id="${e(id)}" name="pin" maxlength="128" required autocomplete="current-password">
<div class="row"><button class="primary" type="submit">Let my assistant create invites</button></div></form>`;
  const hook = a.assistantInvitesSince && a.inviteEventCommand
    ? `<p class="warn">Your webhook for this agent was set before this version and does not send <code>invite_created_by_assistant</code>, so you will not hear about each link. In your terminal: <code>${e(a.inviteEventCommand)}</code></p>`
    : '';
  return `<h3>My assistant may create invites without asking</h3>${what}${hook}${toggle}${open}`;
}

function createForm(agent: string, csrf: string): string {
  const scopes = SCOPES.map((s) => `<label class="check"><input type="checkbox" name="s_${e(s)}" value="1"> <span><b>${e(s)}</b>: ${e(SCOPE_TEXT[s])}</span></label>`).join('');
  return `<details><summary>Make an access token</summary><form method="post" action="/approve/admin/token/create">${hidden('csrf', csrf)}${hidden('agent', agent)}
<label for="n_${e(agent)}">Name (which assistant it is for)</label><input type="text" id="n_${e(agent)}" name="name" maxlength="48" required autocomplete="off">
<p class="muted">What it may do. Nothing is ticked: tick only what that assistant needs. None of these can approve anything; approvals stay on this page.</p>${scopes}
<label for="p_${e(agent)}">Your PIN, again</label><input type="password" id="p_${e(agent)}" name="pin" maxlength="128" required autocomplete="current-password">
<div class="row"><button class="primary" type="submit">Make the token</button></div></form></details>`;
}

function webhookPart(a: AdminAgent, csrf: string): string {
  const cli = `<p class="muted">Setting a webhook needs a secret file and, for a private address, an allowed host, so it stays in your own terminal: <code>rdv-gateway notify set ${e(a.name)} --url https://… --secret-file &lt;path&gt;</code>.</p>`;
  const dead = a.dead ? `<p>${a.dead} dead letter(s) (events given up on). Read or retry them in your terminal: <code>rdv-gateway notify dead-letter ${e(a.name)}</code>.</p>` : '';
  if (!a.webhook) return `<p class="muted">No webhook.</p>${dead}${cli}`;
  const w = a.webhook;
  return `<p>On: posts <b>${e(w.events.join(', '))}</b> to <b>${e(w.receiver)}</b> <span class="muted">(scheme and host only; the rest of the address is not shown)</span>, since ${e(when(w.since))}.</p>
<p>${w.waiting} event(s) waiting to be sent.${w.insecureHosts.length ? ` Allowed over http or to private addresses: ${e(w.insecureHosts.join(', '))}.` : ''}${w.previousUntil ? ` The previous secret also signs until ${e(when(w.previousUntil))}.` : ''}</p>${dead}
${button('/approve/admin/notify/clear', csrf, { agent: a.name }, 'Turn the webhook off')}<p class="muted">Off: its settings, its secret and its waiting events go; dead letters stay.</p>${cli}`;
}

function agentPart(a: AdminAgent, csrf: string, multi: boolean): string {
  return `<section class="card">${multi ? `<h2>${agentTag(a)}</h2>` : `<p class="for">Agent ${agentTag(a)}</p>`}
<h3>Access tokens</h3><p class="muted">For assistants that connect with a token. Each reaches only this agent.</p>${tokenRows(a.tokens, a.name, csrf)}${createForm(a.name, csrf)}
<h3>Connected apps (OAuth)</h3>${grantRows(a.grants, a.name, csrf)}
<h3>Auto-approved contacts</h3><p class="muted">These contacts no longer need your approval for what is listed. You turn this on only when you tick "Don't ask again" on an approval form; Turn off takes effect at once.</p>${autoRows(a.autoApproved, a.name, csrf)}${armedRows(a.armedInvites, a.name, csrf)}
${assistantInvitesPart(a, csrf)}
<h3>Webhook</h3>${webhookPart(a, csrf)}</section>`;
}

export function adminPage(v: AdminView): string {
  const multi = v.agents.length > 1;
  const orphans =
    v.orphans.tokens.length || v.orphans.grants.length
      ? `<section class="card"><h2>Reaching no agent here</h2><p class="muted">These are bound to an agent this gateway does not serve now: they reach nothing. Revoke them.</p>${tokenRows(v.orphans.tokens, '-', v.csrf)}${v.orphans.grants.length ? grantRows(v.orphans.grants, '-', v.csrf) : ''}</section>`
      : '';
  const clients = v.clients.length
    ? `<section class="card"><h2>Apps that registered and were connected</h2><p class="muted">Removing an app ends every connection it has, on every agent, and refuses its old connect links.</p><table class="admin"><thead><tr><th>App (its own name, untrusted)</th><th>Returns to</th><th>Reaches</th><th></th></tr></thead><tbody>${v.clients
        .map(
          (c) =>
            `<tr><td><b>${e(c.name)}</b><br><span class="muted">${e(c.id)}, registered ${e(when(c.created))}</span></td><td>${e(c.hosts.join(', '))}</td><td>${e(c.agents.join(', ') || 'nothing now')}</td><td>${button('/approve/admin/oauth/revoke', v.csrf, { agent: '*', id: c.id }, 'Remove')}</td></tr>`,
        )
        .join('')}</tbody></table></section>`
    : '';
  const pin = `<section class="card"><h2>Your PIN</h2><p class="muted">A new PIN signs out every unlocked page, this one too.</p>
<form method="post" action="/approve/admin/pin">${hidden('csrf', v.csrf)}
<label for="pin_now">Current PIN</label><input type="password" id="pin_now" name="current" maxlength="128" required autocomplete="current-password">
<label for="pin_new">New PIN (6 or more characters)</label><input type="password" id="pin_new" name="next" maxlength="128" minlength="6" required autocomplete="new-password">
<label for="pin_again">New PIN again</label><input type="password" id="pin_again" name="again" maxlength="128" minlength="6" required autocomplete="new-password">
<div class="row"><button class="primary" type="submit">Change the PIN</button></div></form></section>`;
  return layout(
    'Gateway settings',
    `<h1>Gateway settings</h1><p class="muted">Who reaches your agent${multi ? 's' : ''} through this gateway. Your assistants cannot open this page: only you, with your PIN. Adding, removing or moving an agent and setting a webhook stay in your own terminal (<code>rdv-gateway agent …</code>, <code>rdv-gateway notify set</code>).</p>
${flash(v.message)}${v.agents.map((a) => agentPart(a, v.csrf, multi)).join('')}${orphans}${clients}${pin}<p><a href="/approve">Everything that waits for you</a></p>`,
    v.csrf,
  );
}

/** The one time a token's value is shown: in the answer to the post that made it, never again. */
export function tokenMadePage(opts: { token: string; info: AdminToken; agent: AgentLabel; csrf: string }): string {
  return layout(
    'Token made',
    `<h1>Access token made</h1><p class="for">For your agent ${agentTag(opts.agent)}</p>
<p class="flash" role="status">"${e(opts.info.name)}" (${e(opts.info.id)}) may use: ${e(opts.info.scopes.join(', '))}.</p>
<section class="card"><p><b>Shown only now.</b> Copy it into the one assistant you mean. This page never shows it again, and it is not kept anywhere you can read it back. Anyone holding it can do the above on this agent until you revoke it.</p>
<pre class="msg">${e(opts.token)}</pre></section><p><a href="/approve/admin">Gateway settings</a></p>`,
    opts.csrf,
  );
}
