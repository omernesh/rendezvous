# rdv-gateway threat model (slices 1 and 2, multi-agent)

`rdv-gateway` puts the owner's Rendezvous agent behind an HTTPS endpoint so a
cloud assistant (ChatGPT, Grok, Muse, …) can use it. It runs on the owner's
own machine, holds the key there, and is reached through the owner's own
tunnel. Design notes: `impl/NOTES.md` items 89 (slice 1: the page, static
tokens) and 93 (slice 2: the built-in OAuth 2.1 authorization server).

## What we protect

1. **Consent.** Granting contact, confirming a probe answer, granting a
   contact more, confirming or calling off a dinner, starting a task,
   releasing a result, and the group decisions (invite, join, approve a
   newcomer, leave, remove, terms) belong to the owner alone.
2. **The agent key and local secrets**: `agent.json`, the confirm phrases,
   the owner passphrase, the gateway PIN, API tokens, and OAuth codes, access
   and refresh tokens and client secrets.
3. **The owner's files and paths**: nothing local leaves except what the owner
   releases at a gate.
4. **Availability** of the agent for the owner's own tools (`rdv`, `rdv-mcp`).

## Who we defend against

| Adversary | Can | Must not be able to |
|---|---|---|
| A peer (any Nostr participant) | send requests, greetings, task text, group names | make the cloud assistant approve anything; inject markup into the approval page |
| The cloud assistant, or its vendor, or a prompt injection steering it | call every tool its token's scopes allow | approve anything; read a phrase, the PIN, a key, file contents or local paths; choose a local file |
| Someone holding a leaked API token | the same as the assistant | more than the token's scopes; outlive a revoke |
| The internet, through the owner's tunnel | reach `/approve`, `/openapi.json` | see what waits without the PIN; brute-force the PIN; forge the owner's form posts |
| A web page in the owner's browser | cross-site requests, DNS rebinding to 127.0.0.1 | post the owner's approval forms; read the API |
| Anyone on the internet, through OAuth | register a client with any name and an https return address, send the owner an authorize link | get a token without the owner's PIN and consent; be approved under a name or return address other than the one the page showed; get a code sent to an address it did not register; widen the scopes the owner kept |
| Someone who stole an authorization code or a refresh token | present it at the token endpoint | use a code without the PKCE verifier; use a rotated refresh token without ending the whole grant; use a token at another resource |

| A local assistant with a shell on the owner's machine (Claude Code, Codex, …) | run commands as the owner | set or clear the PIN, make tokens, then approve on 127.0.0.1 |
| Any bearer token (static or OAuth), whatever its scopes, or the assistant holding it (NOTES 110) | call its tools | open the settings page; list, make or revoke tokens or apps; change the PIN; see or clear a webhook |
| Someone who learned the PIN, from the network (NOTES 110) | unlock the page, so also the settings page | read a token's value or hash, a webhook secret or its path; set a webhook; add, remove or move an agent; clear the PIN wait |
| A token or OAuth grant of one agent on a multi-agent gateway (NOTES 104), or whoever steers its assistant | everything its scopes allow on its own agent | call tools on, read the inbox of, see or answer approvals of, or take held results (invite links) of any other agent; open or reuse a session under another agent |
| The owner's webhook receiver, the network to it, or a name it resolves through (NOTES 106) | receive, delay or refuse the agent's signed event notices | approve, grant or revoke anything; get an invite link, a key or message text; redirect the gateway to a private address; get another agent's events |

The last row is the one the second review found: `echo 123456 | rdv-gateway
pin set` followed by two posts to the page approved anything. What stops it
now is the PIN itself: `pin set` reads from a terminal only, and once a PIN
exists it asks for the current one first, checked with the same backoff as the
page. A shell that has neither a terminal nor the PIN cannot change it. Since
issue #126 every owner command (`pin set|unlock`, `token create|revoke`,
`oauth revoke`, `agent add|remove|migrate`, `notify set|clear|dead-letter`)
refuses to run unless stdin and stdout are both a terminal, `--stdin`
included, before it reads or writes anything; no flag, environment variable
or file turns that off. This raises the bar; it is not a proof. A shell tool
without a terminal (Claude Code's Bash and PowerShell tools, MCP clients) is
refused when it runs the `rdv-gateway` or `rdv` commands, but another interpreter
calling the library directly (e.g. `node -e` importing `dist/src/main.js`) or a launcher
that opens a new console (Windows
`Start-Process -WindowStyle Hidden`, `cmd /c start`) or a pseudo-terminal
(tmux, screen, python `pty`) passes `isTTY`; that stays an accepted limit
under #51, and the consent guard is the layer that names those launchers. An
assistant that runs its shell in a real terminal (some IDE agent modes) is
not stopped by the check and must use the approval-form tools. The plugin's
consent guard also refuses these commands in any spelling it recognizes, but
a guard is a speed bump; for `pin set` the PIN itself still holds.
`pin unlock` only clears the wrong-PIN wait, and `token create` gives no
approval rights.

The one-command installer (`site/install-gateway.sh`) keeps a Cloudflare
tunnel token in `cloudflared.token` (mode 600, handed to `cloudflared
--token-file`, never in an environment variable). The guard treats the
install folder (`install.conf`, `cloudflared.token` or its `./gw` helper)
like a home: wildcards in it, tree walks that descend into it (recursive
grep, find, tar, zip, cp -r, rsync, the Grep and Glob tools, also with no
folder named from inside or above it), docker commands there other than
`ps`, `logs`, `up` and `restart` or with another compose file, bind mounts
of the folder into any container, and `exec`, `cp`, `run` or `attach` on
the gateway's containers by name are refused, as are the installer and
`./gw update`. The installer itself is a real boundary in two parts. It
refuses an install folder under any folder, up to `/`, that someone other
than the owner or root could rename entries in (group or other write without
the sticky bit, or an ACL letting anyone else write or delete; on DSM it
reads `synoacltool`, which is how it refuses a share such as
`/volume1/docker`): a rename there could swap the whole install between
runs, because Docker resolves the bind paths again at every container start
and `sudo ./gw update` runs the folder's `./gw`. And during a run it works
from inside its folder by relative paths and re-checks it (owner, mode, ACL,
real path) before every write and command. ACLs it cannot read (a tool that
fails, a format it does not know, NFSv4) count as unsafe.

Residual risks it does not cover: the ancestor check runs at install and at
update only, not when Docker starts the containers or the machine reboots,
so a folder above the install whose permissions are loosened later is not
noticed until the next update. NFS and bind mounts can misreport owners and
modes. And `sudo /full/path/gw update` resolves that path before any check
runs, so run `./gw` from inside the folder (or by a path you trust).

**Accepted limits.** With Docker access on the gateway host, or a shell
running inside the install folder, an assistant can reach the tunnel token
and the gateway's data (the agent's key, the PIN hash, the OAuth signing
key). The consent guard only catches the obvious spellings; it is defence in
depth (#51), and no more rules are being added for Docker or tree walks. The
real boundary is file permissions plus #126: keep the install folder owned
by root or the owner with mode 700, and, if you want a boundary, do not give
the assistant's user the docker group (or sudo) on the gateway host. This is best effort too: anyone who can
run Docker is root-equivalent on that host and can read the token or the
agent's key, and a shell has spellings the guard does not follow (#51). The
real boundary for an assistant with a shell on the gateway host is tracked
in #126; the safe setup is an assistant that reaches the gateway only over
its https address.

Out of scope: malware on the owner's machine (it can read the home anyway), a
compromised tunnel provider terminating TLS (it sees the PIN as typed: use a
tunnel you trust, passkeys come later), and the cloud vendor reading the
conversation (everything the assistant sees is by design model-safe).

## Controls

**No approval path through the assistant.** The tools run in the MCP server's
remote mode: no tool takes a confirm phrase, no elicitation is sent, and the
gateway issues no phrases. A step that needs the owner records the exact
approval form it would have shown and returns `awaiting_human` with a link.
No token scope can approve: scopes only decide which calls may *ask*.

**The page shows exactly what is approved, and the answer is bound to it.**
The form's digest covers the tool, its arguments, the message and every
field. The page posts it back; the gateway refuses a stale digest, then runs
the step again with the answer, and the step's form, rebuilt from the state
at that moment, must have the same digest, or nothing happens and the page
shows the current version. The step's own check under the home lock then
binds the commit to that state (the NOTES 59 pattern the elicitation and the
phrases use). A decided approval is removed, so a replayed post finds
nothing; a second submit while one runs is refused.

**Standing approval is the owner's choice on the page** (NOTES 112). The pages
that approve a contact request or a probe answer and that make an invite link
may carry "Don't ask again for this contact", for exactly what that grant lets
auto-approve cover (its text lists it, nothing else), absent when that is
nothing. It widens what a contact can do with no human, so: it starts
unticked, an assistant can neither tick nor suggest it (no tool takes it; REST
refuses the argument, MCP's schema drops it; a form without the box ignores a
posted one), its text is in the form's digest, it holds no peer text (the
contact by fingerprint, or "whoever uses this link"), and it covers only what
the owner left granted on that form. On an invite it is stored with the
invite, inert until redeemed, then applies to the redeemer alone under the
passphrase record it was chosen under; a revoke, an exposure, an expiry or a
restore drops it. *Limit:* an invite is a bearer link, so whoever gets it
first gets the standing approval too, with nobody checking until the owner
learns of it: the `invite_redeemed` and `auto_approve_on` events reach the
owner through the assistant (`rdv_inbox`), or straight to the owner by webhook
when one is set (`auto_approve_on` is in the default set). So that an injected
assistant cannot hand the link on, an armed link is never given to the asking
assistant: it is shown only on the owner's page, and `rdv_invite` "link"
refuses it. The box's text says so: send such a link only to the person you
mean. "Turn everything off" and the settings page's Disarm take the choice off
open invites (reduce-only, `admin:` and audit lines). The settings page lists each agent's auto-approved contacts (fingerprint,
the owner's label, escaped, and coverage) with a Turn off that takes the
session's CSRF token, logs an `admin:` line, and is audited (`via: settings`);
no bearer reaches it, and nothing there turns it on.

**Suggestions are not defaults.** `rdv_grant`'s tier and label come from the
assistant, so the page preselects the default tier for the binding, never
prefills the assistant's label, and shows both as suggestions, with a warning
when the suggested tier is closer than the default.

**Peer text is inert.** Everything on the page is HTML-escaped; peer text
appears only inside the form message, quoted and labeled untrusted, as it is
in the terminal. The pages have no JavaScript, with one exception: the page
that shows a held invite link after an approval carries one small static
inline script for its Copy buttons. Its CSP allows that script only by the
`sha256` hash of its exact text (no `unsafe-inline`, no nonce); the script
does no network and reads only the text of the box beside its button, and
every other page's CSP has no `script-src` (so `default-src 'none'`). Apart
from that, the CSP allows only our stylesheet and same-origin forms, and
forbids framing.

**The PIN.** At least six characters, stored as salted scrypt in
`gateway.json` (mode 600), first set only from a terminal, and changed only
with the current PIN (see above), in the terminal or on the settings page. Wrong PINs back off,
they never lock for good: after five misses (globally) each further miss
waits one minute, doubling up to an hour, persisted across restarts; misses
are forgotten after a day without one, and the owner clears the wait at once
with `rdv-gateway pin unlock` in their terminal. Checks run one at a time,
and unlock posts are rate limited (30 a minute, a rate that refills, not a
lock), counted only once a post passed the CSRF and pre-session check, so a
flood of forged posts spends nothing. Behind https the gateway refuses to
start without `--client-ip-header`, because every tunneled request comes from
127.0.0.1. With `--client-ip-header` (the header your tunnel sets, e.g.
`cf-connecting-ip`) misses are also counted per client: a client backs off
after three (30 s, doubling to an hour) while the global backoff starts only
after twenty, so one guesser no longer locks the owner out, and spread-out
guessing still meets the global cap. An unlocked session is a random 256-bit
cookie (HttpOnly, SameSite=Strict, `__Host-` and Secure behind https), 15
minutes idle, one hour at most, held only in memory, and ended by a new PIN.
Behind https the page answers only on the public address.

**CSRF and rebinding.** Every form carries an HMAC token bound to the session
(or, before unlock, to a pre-session cookie). A post with a foreign `Origin`
or a cross-site `Sec-Fetch-Site` is refused. Every request must carry a
`Host` the gateway serves (its loopback names and the public URL's host), so
a rebinding page is refused. No CORS headers are sent.

**Tokens.** 256-bit random, shown once, stored as SHA-256, compared in
constant time, re-read from the file on change so a terminal revoke applies
to the next request. Names are unique, and the page names the token that
asked by name and id. An MCP session belongs to the token that opened it, and
one token holds at most four (a fifth closes its own oldest). Pending
approvals belong to the token id that asked; revoking it drops them.
Scopes: `read`, `send`, `contact:request`, `negotiate`; a call outside the
table is refused for every token (deny by default).

**What never leaves.** No tool result, error or event carries a phrase, the
PIN, a key or `consent.json`; the home path is replaced in remote results and
errors (any case, either separator), as are the calendar locations and any
other absolute or `~/` path, up to the end of its field, quote or line (paths
hold spaces); `rdv_file` never returns a file's content or where it is
saved. The
assistant names no local path: no calendar argument, no `rdv_file "prepare"`,
no `inline_files`. The owner's setup (`rdv_init`, addresses, relays, turning
auto-approve on) stays in the terminal.

**Exposure and limits.** Binds 127.0.0.1 by default; any other address needs
`--allow-remote-bind`. `--public-url` must be https (http only for loopback).
Bodies: 256 KiB for the API and MCP, 64 KiB for page forms. Rate limits per
token (120 per minute), per client address on the page, and on unlocks. At
most 32 MCP sessions (4 per token, 30 minutes idle) and 64 pending approvals
(16 per token, 24 hours).

**OAuth 2.1 (slice 2).** The gateway is its own authorization server (RFC
8414 metadata, RFC 9728 protected-resource metadata and the
`resource_metadata` challenge on 401, RFC 7591 registration, RFC 7009
revocation). Only the authorization code with PKCE S256: no implicit grant,
no password or client-credentials grant, no `plain` PKCE; a request without
`code_challenge_method=S256` is refused.

*Nothing a stranger does before the owner acts takes room.* Registration is
stateless: it takes https redirect URIs only (no fragment, no credentials, at
most five), cleans the name (no control or format characters, at most 64),
and stores nothing. The client id it returns *is* the registration (name,
return addresses, auth method, scope, time), HMAC-signed with a key kept in
`gateway-oauth.json`; a client secret is derived from the id with the same
key. A client is stored only when the owner approved it and it exchanged its
first code. Registration is rate limited per client address (30 per 10
minutes, a rate that refills, IPv6 counted per /64), but a flood fills
nothing and so cannot block or remove the owner's client. A parked
authorization request is stateless too: a signed link (ten minutes) to
`/approve/oauth/<link>`, so there is no cap for a flood to fill.

The authorization endpoint shows an error on its own page, never a redirect,
until the client id verifies and the `redirect_uri` equals one it registered,
character for character; duplicated parameters are refused. After that,
errors go back to the client **only if the owner approved that client
before**. Anyone can register any https return address, so an unapproved
client's errors would otherwise bounce browsers from the gateway's address to
any site (RFC 9700 §4.11.2). The owner's own "no" on the consent page does go
back to the client.

**Consent is the PIN-locked page.** The browser that started the request gets
a cookie binding the link to it (an HMAC of the link's nonce, HttpOnly,
SameSite=Lax because the browser arrives from the assistant's site). The page
needs that cookie as well as the unlocked owner session. So a stranger who
connects *their own* ChatGPT account to the owner's gateway and forwards the
consent link gets a refusal page in the owner's browser, not a page that looks
like the owner's own connect.

The page shows the registered name as untrusted text, the return host, the
full return address, the client id and the scopes asked for (never more than
the client registered), each one a checkbox. The owner can only untick. The
post carries the session CSRF token and a digest of everything shown (client,
name, return address, scopes, resource, PKCE challenge, state). The gateway
refuses a stale digest, and refuses a client the owner revoked after the page
was issued. A decided link is remembered until it expires, so an answer runs
once; only the owner's decisions are remembered. Never auto-approved, even
for a client approved before. The page's CSP adds only the return origin to
`form-action`, since the decision answers with a redirect there.

Codes are 256-bit, single use, live 60 seconds, and are bound to the client,
the return address, the challenge, the scopes kept, the resource and the
consent's time. A code presented twice ends the grant it made (RFC 6749
§4.1.2). A code for a client revoked since gets nothing. Access tokens live an
hour. Refresh tokens rotate on every use, and a rotated one presented again
ends the whole grant: its tokens, its MCP sessions and its pending approvals.
Refresh may narrow scopes, never widen them.

Every token is bound to the resource `<public URL>/mcp` (RFC 8707). `/sse`
and the origin are accepted as the same resource, and `/sse` has its own
protected-resource metadata. A request for another resource is refused, and a
token minted before the public URL changed no longer works. Clients
authenticate with `none` (PKCE only), `client_secret_post` or
`client_secret_basic`; secrets and client ids are checked in constant time.
`gateway-oauth.json` (mode 600) holds the signing key, approved clients and
grants, with tokens as SHA-256 only. It is restart-safe; codes and decided
links are in memory.

An OAuth grant is a principal exactly like a static token: the same scope
table, the same session cap (4 per principal), and approvals keyed by grant
id. `rdv-gateway oauth revoke <client|grant>` (the consent guard refuses it to
an assistant) ends it at the next request, and open streams of a revoked
token or grant are closed within 30 seconds. The consent guard also refuses
an assistant's reads and writes of `gateway.json` and `gateway-oauth.json` in
a home: the OAuth file holds the signing key, and a hash written to either
would mint a principal. Token and revocation endpoints are rate limited per
client (60 a minute). The legacy SSE transport (`/sse`, posts to `/messages`)
uses the same bearer check, and a session belongs to the principal that
opened it.

**What an approved step makes for its asker stays with its asker** (NOTES
101, review of PR #120). Every token reads the same `rdv_inbox`, because the
`approval` events live in the home's shared `events.jsonl`. An approved
`rdv_invite` "create" makes a bearer link (whoever redeems it first becomes
a contact), so its `url` and `share_text` are never in that event: the event
carries the rest and says the link is held. The link is shown once to the
owner, escaped, on the page that approved it, and held in memory for 24 hours
for the principal that asked, which takes it once with `rdv_invite` "link"
and the `approval_id` (scope `contact:request`, and the principal must be the
one that asked; another token, or a second try, gets nothing). A restart
drops what is held; the owner still has the page. Pending approvals are
keyed by the asking principal as well as the call, so another token asking
the same call gets its own entry and can never take over one (its "Asked
by", or what is held for its asker). The model's tier, name,
label and capabilities for an invite are suggestions beside the fields; the
page starts at `friend`, the profile name, no label and the capabilities
unticked.

**Several agents on one gateway** (NOTES 104). *Blast radius:* one process
holds several keys, and so does one disk. Whatever reaches the process or
the root folder (code execution in the gateway, the container's volume, a
backup of `data/`) has every agent served there; so does the owner's PIN,
which unlocks approvals for all of them. Put agents on one gateway only when
one person (or household) would trust one machine with all of them.
*Controls:* every token and grant stores the one agent it reaches (its name,
or the root marker for the root agent, whose name follows its profile); one
made before multi-agent gateways reaches the root agent only, and nothing once
the root holds none, so no principal ever falls through to "a default". A
binding left on a name (its agent deleted by hand) reaches no agent that later
takes that name: `agent add` and `agent migrate --name` refuse such a name
without `--force` (which revokes those bindings first), and a binding equal to
the root's current name (a restore renamed the root to it) is treated as
stale and reaches nothing, since root bindings store the marker. The gateway
warns at start about every binding that reaches no agent here. An agent whose
state cannot be read is skipped with an error in the log; any others are
served. Caps hold per agent
(32 MCP sessions, 64 approvals) and across all agents (128 sessions, 256
approvals), so one agent's clients cannot exhaust the process for the others
beyond that. Each agent
has its own `RdvMcpServer` (home, listener, event log, held results) and its
own pending approvals; a request reaches a server only through the
principal's binding, and `/a/<name>/…` refuses any other agent's principal
(403). MCP sessions are bound to principal and agent; session caps are per
agent. OAuth: each agent is its own RFC 8707 resource; a consent for an
agent's resource is fixed to it, a consent for the gateway's makes the owner
pick (nothing preselected), the pick is checked server side and carried by the
code, and the token endpoint refuses a resource naming another agent. The page
names the agent (name and fingerprint) on the list, on every approval and on
the done page that shows an invite link. Two folders with one identity refuse
to start. `agent add|remove|migrate` are terminal-only (the consent guard
refuses them); remove and migrate are refused while the agent listens, and
both keep the key (`agents/.removed/`, `.premigrate-<time>/`). Tests:
`multiagent.test.ts`.

**Outbound webhooks** (NOTES 106). *What could go wrong:* the gateway becomes
a request-forgery tool (a URL pointing at loopback, the LAN or a cloud
metadata endpoint), leaks what it should not (an invite link, message text,
the secret), sends one agent's events to another's receiver, or lets a
receiver steer the agent. *Controls:* the settings are the owner's
(`rdv-gateway notify set|clear|dead-letter`, terminal only; the consent guard
refuses them, and any tool access to `gateway-notify.json` and to the secret
files, also in a multi-agent root that holds no agent of its own), kept in the
gateway's root, keyed by the agent's binding like tokens (`agent remove` and
`agent add` clear a name's settings and dead letters, `migrate` moves them).
The whole file is schema-checked on every read and the gateway refuses to
start on a bad one. Every queued item and dead letter carries the identity it
was made for, so an agent that later takes a name never gets another's
events, by send or by `--retry`. The URL is https, or http only to a host the
owner allows (`--allow-insecure-host`: a name, an IP or a CIDR range); every
connection resolves through the SSRF-pinned lookup (`guardedLookup`), which
refuses private, CGNAT, loopback, link-local and metadata answers (and IP
literals in those ranges), and pins the socket to the checked address. An
allowed name or range opens only private ranges; loopback, link-local and
169.254.169.254 open only for that exact IP. No redirect is followed (a 3xx is a dead
letter), a request lasts 10 s, at most 4 are in flight, and the response body
is ignored (read to 4 KiB). The body is built only from fields checked
against their shape (ids, tiers, fingerprints computed here, the owner's own
labels with control characters replaced); a greeting, the only peer text, is
wrapped as `untrusted_peer_text`; no invite link or secret, key or message
text is ever in it. Each body is signed (HMAC-SHA256 over `t.body`) with a
printable-ASCII secret that `notify set` copies from the owner's file (refused
if group- or world-readable) into `notify-<agent>.secret` (mode 600) in the
root; a replaced secret signs alongside the new one for 24 h. The secret is
never logged or put in the state, and `notify show` and the log name only the
receiver's scheme and host (a path may hold the receiver's token). Caps per
agent (250 waiting, 125 dead letters) keep one agent's flood from evicting
another's events, and a burst of requests or messages from one peer is one
event with a count. Each agent's events come from its own event log, are queued
under its binding and are sent only with that binding's settings at send time
(cleared settings drop its queue). The notifier only reads the agent's files,
never takes its locks, and nothing a receiver answers is read beyond the
status. *Limits:* delivery is at least once (a receiver dedupes by `id`); the
outbox (1000) and dead letters (500) are bounded, oldest first; an owner who
allows a host or range has allowed it private addresses, and over http its
events and signatures cross the network in the clear (use it for a Tailscale
or LAN address only). The guard is a speed bump, as everywhere: an
assistant with a shell that writes the files under another name or path it
cannot see still gets past it. The signature authenticates the gateway
to the receiver, not the reverse. Tests: `notify.test.ts`.

**The settings page** (NOTES 110, issue #102 item 7). *New surface:* before
it, making tokens, ending OAuth connections, changing the PIN and clearing a
webhook needed a terminal on the gateway host; the PIN only approved what an
assistant had asked for. Now whoever holds the PIN and reaches the page can
also, from the network, make a token with any scopes for any agent served
(lasting access until revoked, still unable to approve anything), revoke
tokens and connections, turn a webhook off, turn a contact's auto-approve off
(it only narrows), and change the PIN (locking the
owner out until they set a new one in their terminal: `pin set` asks for
the current PIN, so a lost PIN means editing `gateway.json` on the host).
*Controls:* the page lives under `/approve/admin` and goes through the same
code as the approval page: the PIN unlock with its rate, per-client and
global backoff, the in-memory owner session (15 minutes idle, an hour at
most, Path `/approve` or `__Host-` behind https), the session's HMAC CSRF
token and the Origin and `Sec-Fetch-Site` checks on every post, the Host
allow-list, no JavaScript (the settings page has none; the Copy script is
only on the approval result page), the page CSP and `no-store`. Any request to it
that carries an `Authorization` header is refused (403) before the session
is looked at, so a bearer never reaches it, even riding on the owner's
cookie; there is no admin tool, no REST route and nothing under `/a/<name>/`
(tests try every scope, REST, MCP and the agent URLs). Making a token asks
for the PIN again (the same check and backoff), so a session left open is
not enough for lasting access; changing the PIN asks for the current one and
ends every unlocked session. Every action names the agent it is for, and the
gateway checks the token or grant is bound to that agent (or to none served
here, for the "reaching no agent" list) before it acts. A token's value is
shown once, in the answer to the post that made it, never logged; the page
never shows a hash, a webhook secret or the webhook URL's path. Writes go
through the same stores and lock files as the terminal commands, which the
serving gateway follows at once; a revoke also closes the principal's open
sessions at once. Each action is logged to stderr (what, which agent, the
token or grant id, never a value). *Not on the page, by design:* the first
PIN, `pin unlock`, setting a webhook (it needs a secret file and an allowed
host), dead-letter retry, and adding, removing or migrating agents.

## Known limits and open risks

- Multi-agent: one PIN for all agents (per-agent PINs are not built), and
  agent names can be enumerated by anyone who reaches the gateway: an unknown
  name under `/a/<name>/` and its protected-resource metadata answer 404, a
  known one 401 or metadata. Pick names that say nothing you would keep
  private. Agents are read at start: one added or removed
  takes effect on the next restart, and until then a token for an agent added
  since is refused.

- The PIN now also guards lasting access (tokens made on the settings page,
  NOTES 110), not only approvals. A phished or shoulder-surfed PIN is worth
  more than before; passkeys (a later slice) are the fix. Revoke what you do
  not recognise on the settings page, and change the PIN there.
- The PIN backoff trades guessing against lock-out. Without
  `--client-ip-header`, every request through a tunnel comes from 127.0.0.1,
  so the backoff is global: a stranger who reaches the page can make the owner
  wait (up to an hour, until `rdv-gateway pin unlock`). Counting per client
  fixes that only if the header is trustworthy: set it only when every request
  goes through the tunnel that writes it, since anyone reaching the gateway
  directly can forge it (the global cap still bounds guessing). A later slice
  (passkeys) removes the PIN as the only factor.
- Pending approvals live in memory: a restart drops them, and the assistant
  asks again. A full page (64, or 16 per token) refuses new asks with an
  error to the assistant; nothing waiting is ever dropped except after its
  day expires or once decided.
- A "No" runs nothing: the step is not re-run, the approval is dropped and an
  `approval` event says `declined`. So a no on a held dinner or a waiting task
  does not release or refuse it; the assistant (reduce-only calls) or the owner
  does that.
- An approve for a step that, by the time it runs, no longer needs the owner
  (the state moved) runs as the assistant asked; the page and the `approval`
  event say "not needed" instead of reporting a decision. The assistant could
  have made that call itself.
- Capabilities an assistant lists in `rdv_grant invoke` start ticked on the
  page, as in the elicitation form; the message names each one.
- The approval page trusts the machine's clock for session lifetimes and the
  lockout, and the OAuth server for token lifetimes.
- A client's registered name is whatever it sent. The consent page labels it
  untrusted and puts the return host first; an owner who approves a look-alike
  name returning to an unknown host has connected that host. Revoke it with
  `rdv-gateway oauth revoke`.
- A stranger can still send the owner the *authorize* URL itself (not the
  consent link). Opened in the owner's browser it binds there, and the owner
  sees a genuine-looking "ChatGPT, returns to chatgpt.com". The code then goes
  to the stranger's client with the stranger's `state`; well-built clients
  (ChatGPT, claude.ai) refuse a callback whose `state` their own user did not
  start, but the gateway cannot check that. The page tells the owner to
  connect only what they are setting up themselves.
- Strict refresh rotation: a client that retries a refresh after a network
  failure, with the old token, ends its own grant and must connect again.
  That is the price of reuse detection.
- Behind a tunnel without `--client-ip-header` the registration and token
  rates are shared by everyone (all requests come from 127.0.0.1); behind
  https the header is required anyway.
- A step whose form asks twice in one call, or a field the page cannot show,
  is refused and stays a terminal decision. Contents too long for a form
  (tasks over 2000 characters) are decided in the terminal, as with `rdv-mcp`.
