# rdv-gateway threat model (slice 1)

`rdv-gateway` puts the owner's Rendezvous agent behind an HTTPS endpoint so a
cloud assistant (ChatGPT, Grok, Muse, …) can use it. It runs on the owner's
own machine, holds the key there, and is reached through the owner's own
tunnel. Design notes: `impl/NOTES.md` item 89. Slice 1 has static API tokens
only; OAuth 2.1 is slice 2.

## What we protect

1. **Consent.** Granting contact, confirming a probe answer, granting a
   contact more, confirming or calling off a dinner, starting a task,
   releasing a result, and the group decisions (invite, join, approve a
   newcomer, leave, remove, terms) belong to the owner alone.
2. **The agent key and local secrets**: `agent.json`, the confirm phrases,
   the owner passphrase, the gateway PIN and tokens.
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

| A local assistant with a shell on the owner's machine (Claude Code, Codex, …) | run commands as the owner | set or clear the PIN, make tokens, then approve on 127.0.0.1 |

The last row is the one the second review found: `echo 123456 | rdv-gateway
pin set` followed by two posts to the page approved anything. What stops it
now is the PIN itself: `pin set` reads from a terminal only (piped input needs
an explicit `--stdin`, for scripts the owner runs), and once a PIN exists it
asks for the current one first, checked with the same backoff as the page. A
shell that has neither a terminal nor the PIN cannot change it. The plugin's
consent guard also refuses `rdv-gateway pin set|unlock` and
`token create|revoke` in any spelling it recognizes, but a guard is a speed
bump (bypasses are tracked in #51); the PIN check is the boundary.
`pin unlock` only clears the wrong-PIN wait, and `token create` gives no
approval rights.

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

**Suggestions are not defaults.** `rdv_grant`'s tier and label come from the
assistant, so the page preselects the default tier for the binding, never
prefills the assistant's label, and shows both as suggestions, with a warning
when the suggested tier is closer than the default.

**Peer text is inert.** Everything on the page is HTML-escaped; peer text
appears only inside the form message, quoted and labeled untrusted, as it is
in the terminal. The page has no JavaScript; its CSP allows only our
stylesheet and same-origin forms, and forbids framing.

**The PIN.** At least six characters, stored as salted scrypt in
`gateway.json` (mode 600), set only from a terminal, and changed only with
the current PIN (see above). Wrong PINs back off,
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

## Known limits and open risks

- The PIN backoff trades guessing against lock-out. Without
  `--client-ip-header`, every request through a tunnel comes from 127.0.0.1,
  so the backoff is global: a stranger who reaches the page can make the owner
  wait (up to an hour, until `rdv-gateway pin unlock`). Counting per client
  fixes that only if the header is trustworthy: set it only when every request
  goes through the tunnel that writes it, since anyone reaching the gateway
  directly can forge it (the global cap still bounds guessing). Slice 2
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
  lockout.
- A step whose form asks twice in one call, or a field the page cannot show,
  is refused and stays a terminal decision. Contents too long for a form
  (tasks over 2000 characters) are decided in the terminal, as with `rdv-mcp`.
