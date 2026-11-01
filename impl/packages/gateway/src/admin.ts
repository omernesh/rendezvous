// The owner's gateway settings page (issue #102 item 7, NOTES 110): access
// tokens, connected OAuth apps, the PIN and the webhooks, per agent, behind
// the same PIN unlock, session, CSRF token and CSP as the approval page. No
// JavaScript. Never shows a token's value (except once, on the page that made
// it), a hash, the PIN or a webhook secret. Adding, removing and migrating
// agents, setting a webhook and the first PIN stay in the terminal.
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

export interface AdminAgent extends AgentLabel {
  tokens: AdminToken[];
  grants: AdminGrant[];
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
