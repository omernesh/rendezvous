// Server-rendered HTML for the owner: the unlock form, the approval list,
// the OAuth consent screen. No JavaScript at all; one same-origin
// stylesheet. Every dynamic value goes through escapeHtml.
import { TIERS } from '@rendezvous/cli/lib';
import { LABEL_MAX } from '@rendezvous/core';
import type { ApprovalItem } from './approvals.js';
import { escapeHtml as e } from './http.js';
import type { Scope } from './store.js';

/** The page CSP: nothing but our stylesheet and same-origin forms, and never framed. */
export function pageCsp(formTargets: string[] = []): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    `form-action 'self'${formTargets.map((t) => ` ${t}`).join('')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export const CSS = `:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#0f766e;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--accent:#2dd4bf;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:32px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
.card h3{margin:0 0 8px;font-size:1.05rem}.asked{font-size:.8rem;color:var(--accent);margin-left:8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0 0 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
blockquote{margin:8px 0 12px;padding:8px 12px;border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent);white-space:pre-wrap;overflow-wrap:anywhere}
.qlabel{font-size:.85rem;color:var(--warn)}label{display:block;margin:8px 0 4px}input[type=text],input[type=password],select{width:100%;max-width:420px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad);border-color:var(--bad)}
.flash{padding:10px 12px;border-radius:6px;border:1px solid var(--accent);margin:12px 0}.flash.bad{border-color:var(--bad);color:var(--bad)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.check{display:flex;gap:8px;align-items:center}.check input{width:auto}footer{margin-top:40px;font-size:.85rem;color:var(--muted)}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${e(title)}</title><link rel="stylesheet" href="/assets/gateway.css"></head><body><main>${body}<footer>Rendezvous gateway. Bookmark this page and only unlock it from your bookmark: a link someone sends you could be a look-alike.</footer></main></body></html>`;
}

const flash = (msg?: { text: string; bad?: boolean }) => (msg ? `<p class="flash${msg.bad ? ' bad' : ''}" role="status">${e(msg.text)}</p>` : '');

export function unlockPage(opts: { csrf: string; next?: string; message?: { text: string; bad?: boolean }; why?: string }): string {
  return layout(
    'Unlock approvals',
    `<h1>Rendezvous approvals</h1><p class="muted">${e(opts.why ?? 'Enter your owner PIN to see what is waiting for you.')}</p>${flash(opts.message)}
<form method="post" action="/approve/unlock" class="card"><input type="hidden" name="csrf" value="${e(opts.csrf)}">${opts.next ? `<input type="hidden" name="next" value="${e(opts.next)}">` : ''}
<label for="pin">Owner PIN</label><input id="pin" name="pin" type="password" autocomplete="current-password" required maxlength="128" autofocus>
<div class="row"><button class="primary" type="submit">Unlock</button></div></form>`,
  );
}

function itemForm(it: ApprovalItem, csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="kind" value="${e(it.kind)}"><input type="hidden" name="id" value="${e(it.id)}"><input type="hidden" name="digest" value="${e(it.digest)}">`;
  const fid = `${it.kind}-${it.digest.slice(0, 12)}`;
  const rows = `<dl>${it.rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>`;
  const quote = it.quoted ? `<div class="qlabel">${e(it.quoted.what)}</div><blockquote>${e(it.quoted.text || '(empty)')}</blockquote>` : '';
  const fields: string[] = [];
  if (it.kind === 'request') {
    fields.push(
      `<label for="${fid}-tier">Tier</label><select id="${fid}-tier" name="tier">${TIERS.map((t) => `<option value="${e(t)}"${t === it.tier ? ' selected' : ''}>${e(t)}</option>`).join('')}</select>`,
      `<label class="check"><input type="checkbox" name="may_propose_meetings" value="1"${it.mayMeet ? ' checked' : ''}> May propose meetings (free/busy slots only, never calendar details)</label>`,
    );
  }
  if (it.hasLabel) {
    fields.push(
      `<label for="${fid}-label">Local label: how your assistant finds them ("tell …"); empty for none</label><input id="${fid}-label" type="text" name="label" maxlength="${LABEL_MAX}" value="${e(it.label ?? '')}">`,
    );
  }
  const verbs: Record<ApprovalItem['kind'], [string, string]> = {
    request: ['Approve contact', 'Decline'],
    candidate: ['Yes, this is them', 'Reject'],
    meeting: ['Confirm this dinner', 'Decline'],
    cancel: ['Yes, cancel this dinner', ''],
  };
  const [yes, no] = verbs[it.kind];
  const block = it.kind === 'request' || it.kind === 'candidate' ? `<button type="submit" name="decision" value="block" class="danger">${e(no)} and block</button>` : '';
  return `<section class="card" id="${e(fid)}"><h3>${e(it.title)}${it.asked ? '<span class="asked">your assistant asked</span>' : ''}</h3>${rows}${quote}
<form method="post" action="/approve/act">${hidden}${fields.join('')}<div class="row"><button class="primary" type="submit" name="decision" value="approve">${e(yes)}</button>${no ? `<button type="submit" name="decision" value="refuse">${e(no)}</button>` : ''}${block}</div></form></section>`;
}

export interface ClientRow {
  client_id: string;
  name: string;
  redirect: string;
  created: string;
  authorized: boolean;
}
export interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  created: string;
}

export function approvalsPage(opts: { items: ApprovalItem[]; csrf: string; clients: ClientRow[]; tokens: TokenRow[]; message?: { text: string; bad?: boolean } }): string {
  const { items, csrf } = opts;
  const list = items.length ? items.map((it) => itemForm(it, csrf)).join('') : '<p class="muted">Nothing is waiting for you.</p>';
  const csrfField = `<input type="hidden" name="csrf" value="${e(csrf)}">`;
  const clients = opts.clients.length
    ? `<table><tr><th>Name (self-declared)</th><th>Redirects to</th><th>Approved</th><th></th></tr>${opts.clients
        .map(
          (c) =>
            `<tr><td>${e(c.name)}<br><span class="muted">${e(c.client_id)}</span></td><td>${e(c.redirect)}</td><td>${c.authorized ? 'yes' : 'no'}</td><td><form method="post" action="/approve/revoke-client">${csrfField}<input type="hidden" name="client_id" value="${e(c.client_id)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No OAuth clients.</p>';
  const tokens = opts.tokens.length
    ? `<table><tr><th>Name</th><th>Scopes</th><th>Created</th><th></th></tr>${opts.tokens
        .map(
          (t) =>
            `<tr><td>${e(t.name)}<br><span class="muted">${e(t.id)}</span></td><td>${e(t.scopes.join(', '))}</td><td>${e(t.created)}</td><td><form method="post" action="/approve/revoke-token">${csrfField}<input type="hidden" name="token_id" value="${e(t.id)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No API tokens (create one in a terminal: <code>rdv-gateway token create --name … --scopes read,send</code>).</p>';
  return layout(
    'Rendezvous approvals',
    `<h1>Rendezvous approvals</h1><p class="muted">Only you can approve here. Your assistants can ask, never approve.</p>${flash(opts.message)}
<h2>Waiting for you</h2>${list}
<h2>Connected assistants (OAuth)</h2>${clients}
<h2>API tokens</h2>${tokens}
<form method="post" action="/approve/logout" class="row">${csrfField}<button type="submit">Lock</button></form>`,
  );
}

const SCOPE_TEXT: Record<Scope, string> = {
  read: 'read: your status, contacts, pending requests (to view) and inbox',
  send: 'send: send messages to your contacts as you',
  'contact:request': 'contact:request: ask people for contact, and ask you to approve (only you approve, here)',
  negotiate: 'negotiate: propose dinner times to your contacts (only you confirm a meeting, here)',
};

export function consentPage(opts: {
  csrf: string;
  clientName: string;
  clientId: string;
  redirectHost: string;
  scopes: Scope[];
  hidden: Record<string, string>;
}): string {
  const hidden = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
    .join('');
  return layout(
    'Connect an assistant',
    `<h1>Connect an assistant?</h1>
<section class="card"><dl><dt>Name (self-declared)</dt><dd>${e(opts.clientName)}</dd><dt>Client ID</dt><dd>${e(opts.clientId)}</dd><dt>Sends you back to</dt><dd>${e(opts.redirectHost)}</dd></dl>
<p>It asks for these scopes. Untick what you don't want to give. No scope can approve a contact or a meeting: those stay on this page.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="csrf" value="${e(opts.csrf)}">${hidden}
${opts.scopes.map((s) => `<label class="check"><input type="checkbox" name="grant_scope" value="${e(s)}" checked> ${e(SCOPE_TEXT[s])}</label>`).join('')}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div></form></section>`,
  );
}

export function errorPage(title: string, text: string): string {
  return layout(title, `<h1>${e(title)}</h1><p>${e(text)}</p><p><a href="/approve">Back to approvals</a></p>`);
}
