// Server-rendered HTML for the owner: the unlock form, the list of what
// waits, one approval. No JavaScript, with one exception: the page that shows
// a held invite link carries one small static inline snippet (COPY_SCRIPT) for
// its Copy buttons, allowed by a CSP hash of exactly that text. One same-origin stylesheet.
// Every dynamic value goes through escapeHtml, and text another party wrote
// is only ever shown inside the escaped form message, labeled untrusted.
import { createHash } from 'node:crypto';
import { TIERS } from '@rendezvous/cli/lib';
import type { PendingApproval } from './approvals.js';
import type { PendingConsent } from './oauth.js';
import { SCOPE_TEXT } from './scopes.js';
import { escapeHtml as e } from './http.js';
import { BRAND_HEADER } from './brand.js';

/** The page CSP: nothing but our stylesheet and same-origin forms, and never framed. */
export const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * The one inline script any page carries (NOTES 111): Copy buttons on the held values of the done page. It does no
 * network and reads only the text of the box just before its button, by DOM position. The buttons are `hidden`
 * until it runs.
 */
export const COPY_SCRIPT =
  "for(const b of document.querySelectorAll('button.copy')){const box=b.previousElementSibling,st=b.nextElementSibling;b.hidden=false;" +
  "b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(box.textContent);st.textContent='Copied';b.textContent='Copied';" +
  "setTimeout(()=>{b.textContent='Copy';st.textContent=''},2000)}catch(x){const r=document.createRange();r.selectNodeContents(box);" +
  "const g=getSelection();g.removeAllRanges();g.addRange(r);st.textContent='Press Ctrl+C'}})}";

/** The CSP of the done page that shows held values: PAGE_CSP plus a script allowed only by the hash of COPY_SCRIPT. */
export const COPY_PAGE_CSP = PAGE_CSP.replace("img-src 'self';", `img-src 'self'; script-src 'sha256-${createHash('sha256').update(COPY_SCRIPT, 'utf8').digest('base64')}';`);

export const CSS = `:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--card:#fff;--line:#e7e5e4;--accent:#0f766e;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--accent:#2dd4bf;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}
pre.msg{margin:8px 0 12px;padding:12px;border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 6%,transparent);white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 ui-monospace,Consolas,monospace}
.qlabel{font-size:.85rem;color:var(--warn)}label{display:block;margin:10px 0 4px}input[type=text],input[type=password],input[type=number],select{width:100%;max-width:420px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.flash{padding:10px 12px;border-radius:6px;border:1px solid var(--accent);margin:12px 0}.flash.bad{border-color:var(--bad);color:var(--bad)}
.suggest{font-size:.9rem;margin:4px 0}.suggest.warn{color:var(--warn)}.check{display:flex;gap:8px;align-items:center}.check input{width:auto}
a{color:var(--accent)}ul.list{padding-left:18px}footer{margin-top:40px;font-size:.85rem;color:var(--muted)}
.agent{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:999px;font-size:.9rem;overflow-wrap:anywhere}p.for{margin:8px 0}
h3{font-size:1rem;margin:20px 0 6px}form.inline{display:inline;margin:0}code{font:13px/1.4 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}details{margin:10px 0}summary{cursor:pointer;color:var(--accent)}
table.admin{width:100%;border-collapse:collapse;font-size:.92rem;display:block;overflow-x:auto}table.admin th,table.admin td{text-align:left;vertical-align:top;padding:6px 8px;border-top:1px solid var(--line);overflow-wrap:anywhere}table.admin th{font-weight:600;color:var(--muted)}
.held{margin-bottom:12px}.held pre.msg{user-select:all;margin-bottom:6px}.held button[hidden]{display:none}.held .copystatus{margin-left:8px;font-size:.9rem;color:var(--muted)}button.copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

export interface Flash {
  text: string;
  bad?: boolean;
}

/** Which agent something is for (NOTES 104): its name on this gateway and its fingerprint. */
export interface AgentLabel {
  name: string;
  fingerprint: string;
}

export const agentTag = (a: AgentLabel) => `<span class="agent"><b>${e(a.name)}</b> <span class="muted">${e(a.fingerprint)}</span></span>`;

export function layout(title: string, body: string, csrf?: string, copyScript = false): string {
  const lock = csrf
    ? `<form method="post" action="/approve/lock" class="row"><input type="hidden" name="csrf" value="${e(csrf)}"><button type="submit">Lock (sign out)</button><span class="muted">Ends this session on this device. You'll need your PIN again next time.</span></form>`
    : '';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<title>${e(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/gateway.css"></head><body>${BRAND_HEADER}<main>${body}${lock}` +
    '<footer>Rendezvous gateway. Only you approve here; your assistants can only ask. Open this page from your own bookmark or from the link your assistant gave you, and check the address: a look-alike page could ask for your PIN.</footer></main>' + (copyScript ? `<script>${COPY_SCRIPT}</script>` : '') + '</body></html>'
  );
}

export const flash = (f?: Flash) => (f ? `<p class="flash${f.bad ? ' bad' : ''}" role="status">${e(f.text)}</p>` : '');

export function unlockPage(opts: { csrf: string; next: string; message?: Flash }): string {
  return layout(
    'Unlock approvals',
    `<h1>Rendezvous approvals</h1><p class="muted">Enter your gateway PIN to see what waits for you.</p>${flash(opts.message)}
<form method="post" action="/approve/unlock" class="card"><input type="hidden" name="csrf" value="${e(opts.csrf)}"><input type="hidden" name="next" value="${e(opts.next)}">
<label for="pin">PIN</label><input id="pin" name="pin" type="password" autocomplete="current-password" required maxlength="128" autofocus>
<div class="row"><button class="primary" type="submit">Unlock</button></div></form>`,
  );
}

/** Everything that waits, per agent: each agent this gateway serves, by name and fingerprint, with its own approvals. */
export function listPage(opts: { agents: Array<AgentLabel & { items: PendingApproval[] }>; csrf: string; message?: Flash; restartedOn?: string }): string {
  const one = (items: PendingApproval[]) =>
    items.length
      ? `<ul class="list">${items
          .map((p) => `<li><a href="/approve/${e(p.id)}">${e(firstLine(p.form.message))}</a> <span class="muted">(${e(p.tool)}, asked by ${e(p.askedBy ?? 'an assistant')})</span></li>`)
          .join('')}</ul>`
      : '<p class="muted">Nothing waits for you.</p>';
  const body =
    opts.agents.length === 1
      ? `<p class="for muted">Agent ${agentTag(opts.agents[0])}</p><h2>Waiting for you</h2>${one(opts.agents[0].items)}`
      : `<p class="muted">This gateway serves ${opts.agents.length} agents. Each approval below is for the agent it is listed under.</p>${opts.agents
          .map((a) => `<section class="card"><h2>${agentTag(a)}</h2>${one(a.items)}</section>`)
          .join('')}`;
  // Nothing waits: an approval left open across a restart is gone (issue #140), so say when it was, and that nothing ran.
  const restart =
    opts.restartedOn && opts.agents.every((a) => a.items.length === 0)
      ? `<p class="muted">This gateway started on ${e(opts.restartedOn)}. An approval that was open across a restart may not have been carried out; your assistant can ask again.</p>`
      : '';
  return layout(
    'Rendezvous approvals',
    `<h1>Rendezvous approvals</h1>${flash(opts.message)}${body}${restart}<p><a href="/approve/admin">Gateway settings</a> <span class="muted">(access tokens, connected apps, auto-approved contacts, your PIN, webhooks)</span></p>`,
    opts.csrf,
  );
}

const firstLine = (s: string) => s.split('\n')[0].replace(/^Rendezvous:\s*/, '').slice(0, 160);

/** Text for the owner about a suggestion the assistant made (never prefilled). */
function suggestionText(p: PendingApproval, field: string, value: string): { text: string; warn: boolean } {
  if (field === 'tier') {
    const def = p.form.properties.tier?.default;
    const closer = typeof def === 'string' && TIERS.indexOf(value as never) >= 0 && TIERS.indexOf(value as never) < TIERS.indexOf(def as never);
    return {
      text: `Your assistant suggests the tier "${value}".${closer ? ` That is closer than the default for this request ("${def}"): choose it only if you mean it.` : ''}`,
      warn: closer,
    };
  }
  if (field === 'label') return { text: `Your assistant suggests the label "${value}". Type it yourself if you want it.`, warn: false };
  if (field === 'name') return { text: `Your assistant suggests the agent name "${value}". Type it yourself if you want it.`, warn: false };
  if (field === 'alias') return { text: `Your assistant suggests the nickname "${value}". Type it yourself if you want it.`, warn: false };
  return { text: `Your assistant suggests ${field}: "${value}".`, warn: false };
}

function field(p: PendingApproval, name: string, f: Record<string, unknown>): string {
  const id = `f_${name}`;
  const title = e(f.title ?? name);
  const sugg = p.suggestions
    .filter((s) => s.field === name)
    .map((s) => {
      const t = suggestionText(p, s.field, s.value);
      return `<p class="suggest${t.warn ? ' warn' : ''}">${e(t.text)}</p>`;
    })
    .join('');
  if (f.type === 'boolean') {
    return `<label class="check"><input type="checkbox" id="${id}" name="${id}" value="1"${f.default === true ? ' checked' : ''}> ${title}</label>${sugg}`;
  }
  if (f.type === 'string' && Array.isArray(f.enum)) {
    const opts = (f.enum as unknown[]).map((v) => `<option value="${e(v)}"${v === f.default ? ' selected' : ''}>${e(v)}</option>`).join('');
    return `<label for="${id}">${title}</label><select id="${id}" name="${id}">${opts}</select>${sugg}`;
  }
  if (f.type === 'string') {
    // A label the assistant suggested is never prefilled (the form's own default, e.g. the probed address, is).
    return `<label for="${id}">${title}</label><input type="text" id="${id}" name="${id}"${typeof f.maxLength === 'number' ? ` maxlength="${f.maxLength}"` : ''} value="${e(f.default ?? '')}" autocomplete="off">${sugg}`;
  }
  if (f.type === 'integer' || f.type === 'number') {
    const attr = (k: string) => (typeof f[k] === 'number' ? ` ${k === 'minimum' ? 'min' : 'max'}="${f[k]}"` : '');
    return `<label for="${id}">${title}</label><input type="number" id="${id}" name="${id}"${attr('minimum')}${attr('maximum')} value="${e(typeof f.default === 'number' ? f.default : '')}">`;
  }
  return `<p class="flash bad">A field this page cannot show (${title}): decide this one in your own terminal.</p>`;
}

export function approvalPage(opts: { item: PendingApproval; agent: AgentLabel; csrf: string; message?: Flash }): string {
  const p = opts.item;
  const approveTitle = typeof p.form.properties.approve?.title === 'string' ? p.form.properties.approve.title : 'Approve';
  const fields = Object.entries(p.form.properties)
    .filter(([k]) => k !== 'approve')
    .map(([k, f]) => field(p, k, f) + (typeof f.description === 'string' && f.description ? `<p class="muted hint">${e(f.description)}</p>` : ''))
    .join('');
  return layout(
    'Approve?',
    `<h1>${e(firstLine(p.form.message))}</h1><p class="for">For your agent ${agentTag(opts.agent)}</p><p class="muted">Asked by ${e(p.askedBy ?? 'an assistant')} through ${e(p.tool)}. Nothing happens until you decide here.</p>
${flash(opts.message)}${p.changed ? flash({ text: 'This changed since your assistant asked. Nothing was done; this is how it is now.', bad: true }) : ''}${p.note ? `<p class="suggest warn">${e(p.note)} <a href="/approve/admin">Gateway settings</a></p>` : ''}
<section class="card"><div class="qlabel">What you are deciding. Quoted text in it (greetings, names, places, requests) was written by someone else: it is untrusted and decides nothing.</div>
<pre class="msg">${e(p.form.message)}</pre>
<form method="post" action="/approve/${e(p.id)}"><input type="hidden" name="csrf" value="${e(opts.csrf)}"><input type="hidden" name="digest" value="${e(p.form.digest)}">${fields}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">${e(approveTitle)}</button><button type="submit" name="decision" value="decline">No</button></div></form></section>
<p><a href="/approve">Everything that waits for you</a></p>`,
    opts.csrf,
  );
}

/** Labels for what a step made for its asker alone (PrivateResult), shown to the owner once on the page that approved it. */
const HELD_LABELS: Record<string, string> = { url: 'Invite link', share_text: 'Message ready to send' };

export function donePage(opts: { title: string; text: string; csrf: string; bad?: boolean; held?: Record<string, string>; agent?: AgentLabel }): string {
  const held = opts.held
    ? `<section><p>Shown only now. Send it yourself, only to the person you mean; whoever opens it first becomes your contact.</p>${Object.entries(opts.held)
        .map(([k, v]) => `<h2>${e(HELD_LABELS[k] ?? k)}</h2><div class="held"><pre class="msg">${e(v)}</pre><button type="button" class="copy" hidden>Copy</button><span class="copystatus" role="status" aria-live="polite"></span></div>`)
        .join('')}</section>`
    : '';
  const who = opts.agent ? `<p class="for">Agent ${agentTag(opts.agent)}</p>` : '';
  return layout(opts.title, `<h1>${e(opts.title)}</h1>${who}${flash({ text: opts.text, bad: opts.bad })}${held}<p><a href="/approve">Everything that waits for you</a></p>`, opts.csrf, Boolean(opts.held));
}

export function errorPage(title: string, text: string): string {
  return layout(title, `<h1>${e(title)}</h1><p>${e(text)}</p><p><a href="/approve">Approvals</a></p>`);
}

/**
 * The consent page's CSP: the page's own, plus the client's return origin as a
 * form target, since the decision answers with a redirect there (browsers
 * apply form-action to a form's redirects). The origin is from a validated
 * https URL.
 */
export function consentCsp(redirectUri: string): string {
  const origin = new URL(redirectUri).origin;
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin)) return PAGE_CSP;
  return PAGE_CSP.replace("form-action 'self'", `form-action 'self' ${origin}`);
}

/**
 * Connect an OAuth client: what it called itself (untrusted), where it returns, the scopes the owner may narrow,
 * and the one agent it reaches (NOTES 104): fixed when the client asked for one agent's URL, otherwise the owner
 * picks it (nothing is preselected when there are several).
 */
export function consentPage(opts: { item: PendingConsent; csrf: string; registered?: string; message?: Flash; agents: AgentLabel[] }): string {
  const p = opts.item;
  const fixed = p.agent !== undefined ? opts.agents.find((a) => a.name === p.agent) : opts.agents.length === 1 ? opts.agents[0] : undefined;
  const agent = fixed
    ? `<h2>Agent</h2><p class="for">It reaches only your agent ${agentTag(fixed)}</p><input type="hidden" name="agent" value="${e(fixed.name)}">`
    : `<h2>Agent</h2><p class="muted">It reaches only the one agent you choose, never the others.</p><label for="agent">Agent</label><select id="agent" name="agent" required><option value="" selected>Choose an agent</option>${opts.agents
        .map((a) => `<option value="${e(a.name)}">${e(a.name)} (${e(a.fingerprint)})</option>`)
        .join('')}</select>`;
  const host = new URL(p.redirectUri).host;
  const scopes = p.scopes
    .map(
      (s) =>
        `<label class="check"><input type="checkbox" name="s_${e(s)}" value="1" checked> <span><b>${e(s)}</b>: ${e(SCOPE_TEXT[s])}</span></label>`,
    )
    .join('');
  return layout(
    'Connect a client?',
    `<h1>Connect a client to your agent?</h1><p class="muted">An app asks to use your Rendezvous agent through this gateway. Nothing is connected until you decide here.</p>
${flash(opts.message)}
<section class="card"><div class="qlabel">The name is what the app called itself when it registered: anyone can register any name. Check where it returns.</div>
<pre class="msg">${e(p.clientName)}</pre>
<p>Returns to <b>${e(host)}</b><br><span class="muted">${e(p.redirectUri)}</span></p>
<p class="muted">Client ${e(p.clientId)}${opts.registered ? `, registered ${e(opts.registered)}` : ''}. Only connect it if you just started connecting ${e(host)} yourself.</p>
<form method="post" action="/approve/oauth/${e(p.id)}"><input type="hidden" name="csrf" value="${e(opts.csrf)}"><input type="hidden" name="digest" value="${e(p.digest)}">
${agent}<h2>What it may do</h2><p class="muted">Untick what it should not have. None of these can approve anything: approvals stay on this page.</p>${scopes}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Connect</button><button type="submit" name="decision" value="decline">No</button></div></form></section>`,
    opts.csrf,
  );
}
