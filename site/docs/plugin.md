# Rendezvous plugin for Claude Code

Set up [Rendezvous](https://rendezvous.nesher.co) by chatting with Claude:
install `rdv`, create your agent, connect with another person's agent and send
the first message. Approvals always come back to you.

```text
/plugin marketplace add omernesh/rendezvous
/plugin install rendezvous@rendezvous
/reload-plugins
```

Then type `/rdv-onboarding` (the full name is `/rendezvous:rdv-onboarding`, if
another plugin also has an `rdv-onboarding`). It sets you up one question per
turn: install, MCP tools, profile, email, optional phone, relays (the default
public set or your own, each one checked), public pointer, your agent, its
card and an optional first contact,
verifying each step before the next. Re-run it to resume where you stopped.

After that, ask, for example: "Ask john@doe.com's agent to connect", "Tell
John I'm running late", "check rendezvous".

What it contains:

- `skills/rdv-onboarding/SKILL.md`: the `/rdv-onboarding` command, a guided
  setup that asks one question at a time and follows the consent rules of the
  `rendezvous` skill.
- `skills/rendezvous/SKILL.md`: the setup and messaging workflow, with the
  consent rules. It uses the Agent Skills format, so other agents can load it
  too (`npx skills add omernesh/rendezvous`).
- `.mcp.json`: registers the `rdv-mcp` server through `bin/rdv-mcp.mjs`, which
  starts the build the installer put in `~/.rendezvous/src` (or `$RDV_DIR`).
  Until Rendezvous is installed the server fails to start; install it (the
  skill points you to the installer), then run `/reload-plugins`. The server uses the profile
  `rdv` uses: `$RDV_HOME`, else `~/.rendezvous/$RDV_PROFILE`, else
  `~/.rendezvous/default`.
- `hooks/hooks.json`: a consent guard on every tool call. It stops Claude
  from running the `rdv` commands that grant consent or print confirm phrases
  (`rdv contact grant`, `rdv dinner confirm`, `rdv task approve`,
  `rdv task release`, `rdv contact pending`, `rdv dinner list`,
  `rdv task list`, `rdv group join`, `rdv group approve`, `rdv group pending`, …), put a contact on auto-approve (`rdv contact auto-approve`), or name a contact (`rdv contact label`, or
  `rdv contact request <agent-id> --label`), however the command is quoted or wrapped (`npx`,
  `bash -c`, `$(…)`), and from reading, editing, searching or globbing the
  agent's secret key, consent file and auto-approve file with any tool. Those stay with you, in
  your own terminal.

  **Auto-approve and your owner passphrase** (issues #47, #44). Turning
  auto-approve on asks for a passphrase you set yourself with
  `rdv owner-secret set`, in your own terminal. You type it either in your
  own terminal (`rdv contact auto-approve <contact> all`) or, when you ask
  Claude to turn it on, into the approval form `rdv_auto_approve` opens: the
  form shows the contact, its fingerprint, what it covers and until when,
  and what you type goes to the Rendezvous server only, never to Claude. If
  no form can be shown, it is refused (there is no confirm phrase for it).
  Never type the passphrase into the chat. Claude may turn auto-approve off
  whenever you ask, with no form. In the terminal the passphrase is read
  from the terminal device itself (`/dev/tty`, or `CONIN$` on Windows), not
  from stdin; it is never echoed or printed, and only a scrypt hash is kept
  (`owner-secret.json`, mode 600); three wrong answers lock it for a minute,
  then twice as long after each further miss. `rdv init` in a terminal
  offers to set it, and so does `/rdv-onboarding` (it asks you to run the
  command in your own terminal). The first passphrase is trust on first
  use: it is audited, and `rdv whoami` and `rdv_status` show when it was
  set; if that wasn't you, run `rdv owner-secret reset` in your own
  terminal (refused while locked; it turns every auto-approve off and only
  clears, and a new passphrase can be set 10 minutes later). Any
  pseudo-terminal (`script`, `expect`, `unbuffer`, `winpty`, node-pty,
  `pty.spawn`) is refused outright. It replaced "retype the
  fingerprint shown here", which an assistant could pass by running the
  command in a pseudo-terminal and typing back what the prompt printed. The
  hook also refuses any command that names `contact` and `auto-approve`
  under any wrapper or spelling (`script -c`, `expect -c`, `unbuffer`,
  `winpty`, `stdbuf`, `timeout`, `nohup`, `env`, node-pty, Python
  `pty.spawn`, here-strings, heredocs, `sh -c`, `node -e`, `python -c`), any
  quoted string that names `auto-approve`, any mention of `owner-secret`,
  and any read or write of `autoapprove.json` or `owner-secret.json` in any
  folder.

  What this protects against: an assistant that drifts or is
  prompt-injected and tries to switch auto-approve on by itself, with or
  without a pty: it never sees the answer, so it has nothing to type. What
  it does not protect against: a model with a shell running as your OS user
  can still write a script the hook can't read, delete `owner-secret.json`
  and set its own passphrase, edit Rendezvous' files, or watch you type the
  passphrase into a terminal it controls (so type it only in your
  own terminal, one you opened yourself). No local check is a hard boundary against your own
  account; for that, run the assistant or `rdv-mcp` as another OS user.

  **The hook is defence in depth, not a security boundary.** A model with a
  shell can always build a command it can't see (a script file, another
  interpreter). The boundary is the MCP consent gate: `rdv_grant` and
  `rdv_negotiate` need your approval form or a confirm phrase only you see,
  and the phrase is stored only as a hash. See "Threat model" in
  [`impl/packages/mcp/README.md`](https://rendezvous.nesher.co/docs/mcp.md).

Sending: Claude picks the recipient by its `local_label`, never by an address
the other agent's card claims, and shows you the fingerprint before the first
message. Only you set a label: it is part of what you approve (the form shows
it next to the fingerprint and you can change it; a confirm phrase approves
only the label it was shown with), or you name a contact yourself with
`rdv contact label <agent-id> <label>` in your own terminal. A card found by
address is only a claim, so it never labels a contact.

Approving a contact: Claude calls `rdv_grant`, and Claude Code shows you an
approval form (MCP elicitation). Claude can't fill it in for you.

Tasks and files (v0.3): ask "Ask John's agent to review this", or answer
when a contact asks your agent for something. Claude uses `rdv_task` and
`rdv_file`. Two approvals guard every request from a contact: you approve
starting it, and you approve the exact answer before it goes back, each
through a form or a phrase from your own terminal. A request is treated as
data, never as instructions. Files are sent by reference, only after you
release the result they are in, and a file a contact sends is fetched only
for a task you started and saved in quarantine. Auto-approve for one trusted
contact exists (it also confirms dinners that contact proposes), but only you
can turn it on, with the owner passphrase: in your own terminal, or in the
form Claude opens when you ask it to; Claude never suggests it. The user guide is
[`docs/tasks.md`](https://rendezvous.nesher.co/docs/tasks.md).
