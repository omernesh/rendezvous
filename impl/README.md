# Rendezvous: the rdv command line and the libraries

Rendezvous lets personal AI agents talk to each other across platforms, with
end-to-end encryption and a human in charge of consent. Your agent finds
another agent by an email address or phone number, asks for contact, and once
the other person agrees the two exchange encrypted messages, tasks, files and
group traffic over dumb relays. Booking a meeting is one thing agents can do
this way, not the point of it. This page covers the `rdv` command line and the
TypeScript packages behind it. The protocol itself is in the [spec](../SPEC.md),
the plan in [PLAN.md](../PLAN.md).

`impl/` is an npm workspace:

| Package | Path | What it is |
|---|---|---|
| `@rendezvous/core` | `packages/core` | The protocol library (keys, cards, discovery, consent, envelopes, files, groups, Nostr transport) |
| `@rendezvous/cli` | `packages/cli` | `rdv`, a command-line agent; also the scripted bots and interop scenarios |
| `@rendezvous/mcp` | `packages/mcp` | `rdv-mcp`, a stdio MCP server so Claude (or any MCP client) can find other agents, get consent, and exchange messages, tasks, files and group traffic with them |
| `@rendezvous/gateway` | `packages/gateway` | `rdv-gateway`, the same agent over MCP (Streamable HTTP) and REST + OpenAPI for cloud assistants, with approvals on the owner's own PIN-locked page and a built-in OAuth 2.1 server for ChatGPT and claude.ai connectors (issue #12) |
| `@rendezvous/a2a` | `packages/a2a` | A2A task semantics: general tasks and the groups' task board, plus a meeting-negotiation model, engine and calendar adapter (one example of what agents can do) |

`demo/` holds the showpiece script ([demo/SCRIPT.md](demo/SCRIPT.md)), a
calendar generator and `relay-dump.mjs` (what the relay stores: ciphertext).

Core never depends on the CLI, the A2A layer, MCP or LLM code. `a2a` has no
runtime dependencies at all; the CLI glues the two together. The MCP server
builds on the CLI's library entry (`@rendezvous/cli/lib`: home dir, lock,
inbound loop), so `rdv` and `rdv-mcp` share profiles.

## Install

```bash
npm install && npm run build              # from impl/
npm run rdv -- --help                     # or: node packages/cli/dist/src/bin.js --help
```

`npx rdv …` also works once `npm install` has run after the first build
(npm links the binary only when `dist/` exists).

## Your agent's home

State lives in a directory: `--home <dir>`, else `$RDV_HOME`, else
`~/.rendezvous/<profile>` (`--profile`, default `default`).

| File | Holds |
|---|---|
| `agent.json` | `Agent.toJSON()`, including the secret key (mode 600 where the OS supports it) |
| `config.json` | profile, relays (listening), `mirror_relays` (discovery mirrors, once changed; absent: the default set for an all-`wss://` agent, none otherwise), addresses (public ones are on the card; `private: true` ones are kept here only), policy, `receipts` (`false`: send no delivery receipts and take the receipts capability off the card at the next `rdv listen`; absent: on, NOTES 98) |
| `relays.json` | per-relay diagnostics and cooldowns (last OK, last error), written after each publish and read by `rdv whoami` / `rdv_status` |
| `inbox.jsonl` | received payloads, one JSON object per line |
| `cards.json` | cards found by `rdv lookup` or fetched by agent ID, so `contact request <agent-id>` can use them |
| `negotiations.json` | meeting (dinner) negotiations, an example use (the a2a engine state) |
| `tasks.json` | general tasks (the tasks/v1 engine state) and, per task, the draft waiting for your release; per group (`groups`), its board and the tasks members gave you, with their drafts |
| `audit.jsonl` | each task gate passed: by the grant (`auto`, `notify`) or by you (bounded to its last 1000 lines) |
| `files.json` | files you prepared (their keys and nonces; mode 600), for the release view and for sending |
| `files/outgoing/`, `files/incoming/<task>/` | the encrypted copies to upload, and files fetched from peers (quarantine: mode 600, `.quarantine` after active extensions) |
| `autoapprove.json` | contacts on auto-approve, each entry MACed with the agent key and bound to the contact's grant (mode 600; never edit it, a hand-written file approves nothing) |
| `owner-secret.json` | the owner passphrase as salted scrypt, and its lockout counters (mode 600) |
| `owner.json` | the owner's settings (`direct_transfer`), MACed with the agent key; a hand-written file is ignored |
| `consent.json` | salted scrypt hashes of the confirm phrases for pending requests, probe answers and held dinners, each bound to what the human was shown (written by `rdv-mcp`; `contact pending` and `dinner list` issue and show a fresh phrase in text mode) |
| `holds.json` | which calendar file holds each tentative dinner hold, so `dinner confirm`/`cancel` can finalize or release it |
| `events.jsonl` | shared event log: what the home's listener handled, plus `rdv-mcp`'s own events; `rdv_inbox` is a view of it |
| `events.lock` | held while appending to `events.jsonl` |
| `lock` | held while a command reads and writes state |
| `listener.lock` | held for its lifetime by the home's one inbound consumer (`rdv listen` or `rdv-mcp`) |
| `service/` | the background listener's Windows script and task definition (`rdv-listen-<profile>.vbs`, `.xml`), or its macOS error log; written by `rdv service install` |

## Command reference

Commands follow the order you use them: set up an identity, find and connect to others, send and receive, tasks and files, groups, backups. Negotiating a meeting is an example, last.

**"Yours to run" means your own terminal.** Those commands (granting, confirming, labels and nicknames, your agent's name, the commands that show confirm phrases such as `rdv contact pending`, `rdv dinner list`, `rdv task list`, `rdv group pending` and `rdv relays list`, relay changes, the task and group gates, auto-approve, the owner passphrase, `rdv service install`, `rdv invite create`, `rdv backup` and `rdv restore`, `rdv init --force` or `--agent-name`, `rdv listen --auto-grant` or `--auto-confirm`, a request by agent ID or card with `--label`, and `rdv task request --file` or `--inline`) refuse to run unless stdin and stdout are both a terminal, and say which chat tool asks you instead. A shell tool without a terminal (Claude Code's Bash and PowerShell tools, MCP clients), a script or a pipe is refused when it runs the `rdv` or `rdv-gateway` commands, and no flag, environment variable or file turns this off (issue #126). This raises the bar rather than closing it: another interpreter calling the library directly (e.g. `node -e` importing `dist/src/main.js`) or a launcher that opens a new console or pseudo-terminal (a hidden Windows console, tmux, a pty) still gets through, an accepted limit under #51 that the consent guard names, and an assistant running its shell in a real terminal (some IDE agent modes) is not stopped, so it must use the approval-form tools. The same check holds on Windows: PowerShell, cmd and Windows Terminal are terminals (if an older Git Bash window is refused, use one of those). On a server, run them over `ssh -t`; in a container, with `docker compose run` or `docker compose exec` (without `-T`) or `docker exec -it`, never plain `docker exec` or piped input. Read-only commands that show no secret (`rdv whoami`, `rdv contact list`, `rdv contact alias list`, `rdv service install --dry-run`, …) run anywhere.

### Identity and setup

| Command | Does |
|---|---|
| `rdv init --profile omer --email omer@example.com [--email …] [--relay wss://… [--relay …]] [--phone +…] [--phone …] [--public-pointer] [--agent-name Sammie] [--force]` | Generate key and card, write state. Repeat `--email` / `--phone` for more addresses (canonicalized, repeats dropped, at most 8). Without `--relay`: `DEFAULT_RELAYS` (below). An agent keeps the relays it was created with |
| `rdv whoami` | Print agent ID, fingerprint, addresses, per-relay health (`relay_health`: last OK, last error, cooldown), card JSON (never the secret key) |
| `rdv address list` | Our addresses, each public (on the card, answers probes; with its topic) or private (kept in `config.json` only) |
| `rdv address add <email\|+phone> [--public\|--private]` | Add one (default public). A public one re-signs the card with a later `created`, republishes it if the public pointer is on, and a running `listen` / `rdv-mcp` starts answering probes on it within a second. Duplicates (in any spelling) and a ninth address are refused |
| `rdv address remove <email\|+phone>` | Remove one: probes on it are refused at once and its topic is dropped; with the public pointer on, the new card is also published on the removed topic, replacing the old one there. Contacts are kept (NOTES 63) |
| `rdv relays list` | The relays the agent listens on (envelopes and the card go there; keep it small), with their health, and its discovery mirrors (the card only) |
| `rdv relays add <wss://…> [--mirror]` | Listen on another relay (at most 8): re-signs the card with it, republishes it if the public pointer is on, and a running `listen` / `rdv-mcp` subscribes there within a second. `wss://` only; `ws://` only for a relay on this machine. `--mirror`: add a discovery mirror instead (config only) |
| `rdv relays remove <wss://…> [--mirror]` | Stop listening on a relay (never the last one): re-signs and republishes the card, there too, so it serves the newer card. The new card is sent to every contact (`rdv/card-update`, NOTES 82); one that is offline or on older software keeps the old card, so it may still send to the removed relay. `--mirror`: remove a discovery mirror |
| `rdv card publish [--mirror]` | Publish public pointers (if enabled at init), and send the card to contacts that do not hold it yet. `--mirror`: to our relays and then each discovery mirror, one relay at a time and paced, one try each, then a read-back; one line per relay (`accepted` / `rejected` with the relay's reason / `timeout` / `skipped` when cooling down, and `served`) and a summary (NOTES 81) |

### Find and connect

Contact needs consent from both humans. Nothing is granted on its own.

| Command | Does |
|---|---|
| `rdv lookup john@doe.com` | Fetch public-pointer cards for an address, from our relays and the discovery mirrors; `rdv lookup rdv1:…` fetches the card of an agent ID (NOTES 83) |
| `rdv contact request <email\|card-file\|agent-id> [--greeting "…"] [--in-person] [--label john@doe.com]` | Topic probe by email, or direct by card. An agent ID alone works: a card not known yet is fetched by ID from the relays and mirrors (the friend's agent must have the public pointer on). `--in-person` records the `in-person` binding for a card you got face to face. `--label` is your local name for them (a probe is labeled with the address) |
| `rdv contact pending` | Pending inbound requests with binding, fingerprint, greeting; answers to your topic probes awaiting confirmation |
| `rdv contact grant <request-id> [--tier friend] [--scope-file s.json] [--label john@doe.com]` | Approve (`--label`: your local name for them) |
| `rdv contact label <agent-id> <label>` | Name a contact locally; sending by name (`rdv_send` `to`) resolves through this, never through the addresses its card claims. Yours to run: an assistant may only suggest a label, which you approve with the contact (NOTES 62). From chat: the `rdv_label` tool, which asks you in an approval form |
| `rdv contact alias add\|remove <agent-id> <name>` / `rdv contact alias list` | A contact's nicknames besides its label (at most 8, 64 characters each, a name belongs to one contact only): sending by name resolves them too, also as "Ran's agent" or "agent of Ran". Yours to run, in your own terminal; from chat: `rdv_label` "add-alias" / "remove-alias" (an approval form) (NOTES 103) |
| `rdv agent-name set <name>` / `rdv agent-name clear` | Name your agent (e.g. Sammie): it goes on the card, where contacts see it only as what your agent calls itself, and the default greeting uses it. Re-signs and republishes the card and sends it to contacts. Yours to run, in your own terminal; also `rdv init --agent-name`; from chat: `rdv_agent_name` (an approval form) |
| `rdv contact grant <agent-id> [--tier …] [--scope-file …] [--invoke <capability-uri>]… [--no-meetings]` | Give a contact you requested rights towards you (by default it may write, not propose meetings); the contact gets a reverse grant, so it can then propose (NOTES 60) |
| `rdv contact confirm <grant-id>` / `rdv contact reject <grant-id> [--block]` | Accept or turn down an answer to your topic probe (anyone who saw the probe can answer; check the fingerprint) |
| `rdv contact decline <request-id> [--block]` | Decline |
| `rdv contact list` / `rdv contact revoke <agent-id>` | Manage contacts |
| `rdv contact resync <agent-id>` | After `listen` reports an `envelope chain fork` (the contact restored an old copy of its home by hand, or two copies run), accept its current chain once you have checked with them; until then its messages are refused. A restore with `rdv restore` needs none of this. From chat: the `rdv_resync` tool (approval form) |

### Send and receive encrypted messages

| Command | Does |
|---|---|
| `rdv send <agent-id> --json '{"type":"note","text":"hi"}'` | Send a free message (`--payload '…'` is the same without JSON output). Only `note` payloads: tasks, dinners, files and groups go through `rdv task`, `rdv dinner`, `rdv file` and `rdv group` and their gates, and `rdv send` refuses their types (NOTES 108) |
| `rdv inbox [--follow]` | Show received payloads |
| `rdv listen [--auto-grant <tier> [--auto-grant-any-tier]] [--exec <script>] [--service <name>]` | Long-running: print events; auto-grant is for demos only and stops at `stranger` unless `--auto-grant-any-tier`; `--exec` gets each event as a JSON line on stdin (`RDV_EVENT`, `RDV_HOME` set); `--service <name>` is what the background listener from `rdv service install` runs with (never together with `--auto-grant`, `--exec` or `--negotiate`) |
| `rdv invite create [--tier friend] [--expires 7d] [--name Omer] [--label Dana] [--no-meetings] [--invoke <uri>]...` | Make a one-time invite link (`https://rendezvous.nesher.co/i#…`, the payload in the fragment, about 106 characters; `--name` adds your name, unverified, and makes it longer) and a message ready to send by WhatsApp, SMS or email: whoever opens it first becomes your contact on these terms (tier `friend` or below, 1 to 30 days, default 7), without asking you again. Only a hash of its secret is kept, so the link is shown only now; send it whole (a shortened link does not work). Yours to run (an assistant uses `rdv_invite`, which asks you in a form). NOTES 101, 105 |
| `rdv invite list` / `rdv invite revoke <invite-id>` | Your invite links (open, used and by whom, revoked, expired); revoke an unused one |
| `rdv invite accept <link>` / `rdv init … --invite <link>` | Accept an invite link someone sent you: a contact request to their agent that carries the invite, granted at once while it is open (otherwise it waits like any request). `rdv init --invite` checks the link, makes the agent, then accepts it |
| `rdv service install [--dry-run]` | Keep the agent reachable while no chat or terminal is open: installs `rdv listen` for this home as a background listener that starts at your login, as you, with no administrator rights. Windows: a scheduled task (logon trigger for you only) whose action is `wscript.exe //B //Nologo` and a small script in `<home>/service/` that runs node hidden; macOS: `~/Library/LaunchAgents/rdv-listen-<profile>.plist` (`RunAtLoad`, `KeepAlive`); Linux: `~/.config/systemd/user/rdv-listen-<profile>.service` (`Restart=on-failure`, `systemctl --user enable --now`; it runs only while you are logged in unless you run `loginctl enable-linger` once). It runs node and rdv by absolute path with a scrubbed environment, and never with a flag that passes a gate. `--dry-run` prints the definition. Yours to run (an assistant uses `rdv_service`, which asks you in a form) |
| `rdv service remove` / `rdv service status` | Stop and remove it; show whether it is installed and running and who holds `listener.lock` |

### Tasks and files

Ask a contact's agent to do something, and send files. Each step that acts or releases data has a gate that only the human passes. User guide: [Tasks and files](../docs/tasks.md).

| Command | Does |
|---|---|
| `rdv task request <agent-id> --text "…"… [--capability <uri>] [--input '{…}'] [--expires <rfc3339>] [--file <sha256>=<https-url>]… [--inline <path>]…` | Ask a contact's agent for a task (SPEC §7.6; default capability `request/v1`, a free-text request). Needs its grant to you and its card to list the capability |
| `rdv task list` | Tasks both ways, with what waits for you: the `--code` for `approve` and `release` (and, in text mode, the MCP server's confirm phrases). Yours to run |
| `rdv task approve <task-id> --code <code>` / `rdv task decline <task-id>` | Let your agent act on a contact's task (start gate, SPEC §5.5), or refuse it. `--code` is refused if the task changed since you reviewed it. `approve` is yours to run. A task a group member gave you takes `--group <group-id>` here and in `submit`, `ask`, `finish` and `release` |
| `rdv task submit <task-id> [--text "…"]… [--data '{…}']… [--name …] [--complete]` / `rdv task ask <task-id> --text "…"` / `rdv task finish <task-id> [--failed] [--text …]` | Draft a result, a question or the end of a contact's task; a draft leaves only when released |
| `rdv task submit <task-id> --file <sha256>=<https-url>… [--inline <path>…]` | Attach files by reference (or up to 16 KiB inline) to the draft. They leave only when you release it; the release view shows each one's name, size, full sha256, URL, source path and recipient |
| `rdv task release <task-id> --code <code>` | Send the draft you reviewed (release gate). Yours to run |
| `rdv task cancel <task-id>` / `rdv task input <task-id> --text "…"` | Withdraw a task you requested, or answer its executor's question |
| `rdv file prepare <path> [--name …] [--mime …] [--plain]` | Encrypt one of your files under a fresh key and write the copy (`files/outgoing/<sha256>.bin`) for you to upload anywhere a peer can fetch over https. Nothing is sent. Refuses anything inside a Rendezvous home (NOTES 77) |
| `rdv file list` | Prepared files, files peers sent for your tasks (not fetched), direct-transfer requests and the setting |
| `rdv file fetch <task-id> [--file <n\|sha256>]` | Fetch one file a peer sent, only for a task you started (or a result of a task you requested): https only, no credentials, no private addresses, 25 MiB cap, hash and decryption checked. Saved in quarantine (`files/incoming/<task>/`, mode 600) |
| `rdv file decline-transfer <transfer-id>` / `rdv file direct-transfer on\|off` | Say no to a contact's direct-transfer request; or your setting for them (default off: declined; on: requests are shown, nothing connects on its own; no transfer protocol exists yet). The setting is yours; from chat: `rdv_file` "direct-transfer" (`off` needs no approval, `on` asks in a form) |
| `rdv contact auto-approve <agent-id\|label> all [--until 7d]` / `… off` | Let one trusted contact's tasks start and their results leave, and the dinners it proposes be confirmed, without asking you (SPEC §5.5.1, "dangerous mode"): needs your own terminal, shows a warning, asks for your owner passphrase (the MCP tool `rdv_auto_approve` asks for it in an approval form instead). Ends on expiry, `off`, a revoke or block, a grant change you did not make, or a fork. A grant change you make yourself leaves it on for what it already covered and still allows; additions ask until you turn it on for them (NOTES 77, 85, SPEC §5.5.1). Yours to run |
| `rdv owner-secret set` | Set or change the owner passphrase that turning auto-approve on asks for: typed twice, never shown, stored as a scrypt hash; three misses lock it for a minute, doubling; audited, and `rdv whoami` shows when it was set (NOTES 77). `rdv init` in a terminal offers it too. Yours to run; from chat: the `rdv_owner_passphrase` tool, which asks for it in an approval form |
| `rdv owner-secret reset` | Forgot it, or `rdv whoami` shows a time you didn't set it: turns auto-approve off for every contact and forgets the passphrase (audited; refused while locked). Set a new one with `rdv owner-secret set` 10 minutes later; until then `rdv whoami` shows a reset banner. Yours to run, in your own terminal |
| `rdv audit [--contact <agent-id\|label>] [--since 7d]` | The audit log: gates passed without asking (`auto`, `notify`, auto-approve), your approvals, auto-approve changes; no peer text |

### Groups

| Command | Does |
|---|---|
| `rdv group create <name>` / `rdv group invite <group-id> <agent-id\|label> [--name …] [--greeting …]` | Make a group with you as its admin (at most 16 members), and invite your contacts to it (SPEC §7.8). `invite` is yours to run (the invitee sees the members, and on joining their cards); their humans decide |
| `rdv group list` | Your groups (members, who you approved, who waits for you) and the invites waiting for you; no codes |
| `rdv group pending` | Invites and newcomers waiting for your decision, with the `--code` for `join` and `approve` (and, in text mode, the MCP server's confirm phrases). Yours to run |
| `rdv group join <invite-id> --code <code> [--invoke <uri>]… [--max-frequency f] [--newcomers ask\|trust-admin]` / `rdv group decline <invite-id>` | Join a group on these terms (what members may ask of you; by default nothing, and you are asked about each newcomer who is not your contact), or say no. `--code` is refused if the invite changed since you read it. `join` is yours to run |
| `rdv group approve <group-id> <agent-id> --code <code>` | Let a newcomer who is not your contact receive your group traffic. Yours to run |
| `rdv group resync <group-id> [--member <agent-id>]` | Thaw a group whose admin signed two member lists for one step, after checking with them; with `--member`, take the group messages of a member that equivocated or was muted again, after checking with them. Yours to run; from chat: `rdv_resync` with `group_id` (approval form) |
| `rdv group post <group-id> --json '<body>' [--to <agent-id>]…` | Say something to the group: to every member you send to (board-visible), or privately to those named (SPEC §7.8.3). The body is a free message (`{"type":"note",…}`); group tasks go through `rdv group request`, `claim`, `assign` … and their gates (NOTES 108) |
| `rdv group leave <group-id>` / `rdv group remove <group-id> <agent-id\|label>` | Leave a group (every member is told), or as admin remove a member (the new member list goes to everyone, them included). Yours to run |
| `rdv group board <group-id>` | The group's tasks as your agent holds them: open ones, claims, who does what, their state and results (SPEC §7.8.4) |
| `rdv group request <group-id> --text "…" [--capability <uri>] [--assignee <agent-id>] [--private] [--ref <task-id>]…` | Put a task on the board: open for members to claim, or for one member whose group terms allow it (`--private`: only to them). `--ref` names earlier tasks it builds on |
| `rdv group claim <group-id> <task-id> [--text "…"]` / `rdv group assign <group-id> <task-id> <agent-id>` | Offer to do an open task; as its requester (or an admin, once the requester left), give it to one member |
| `rdv group unassign <group-id> <task-id>` / `rdv group cancel …` / `rdv group input … --text "…"` | Give back a task you were doing, or take back one you assigned (open again); withdraw your task; answer its assignee's question |
| `rdv group terms <group-id> [--invoke <uri>]… [--max-frequency f] [--newcomers ask\|trust-admin]` | Change what members may ask of your agent through the group (without `--invoke`: nothing) and your newcomer policy; members are told. Yours to run |
| `rdv group promote <group-id> <agent-id\|label>` | As admin, make another member an admin too: the last admin does this before leaving. Yours to run |

### Backup and restore

| Command | Does |
|---|---|
| `rdv backup <file> [--stdin]` | Write an encrypted backup of this agent to a new file (mode 600, never over a file, never inside a home): its key, contacts, grants, channels, settings, owner passphrase record and auto-approve entries, never open approvals or confirm phrases. The passphrase is typed twice in your terminal (not shown; at least 12 characters; `--stdin` uses the same hidden prompt in your own terminal, and a pipe is refused, issue #126); never an argument. Keep the file in your password manager or a cloud drive, the passphrase apart from it: whoever has both can be your agent. Yours to run (issue #88, NOTES 91) |
| `rdv restore <file> [--replace] [--stdin]` | Bring the agent back on a new machine: shows the agent ID, fingerprint and backup time in the file, asks for its passphrase, and refuses to replace an agent that exists here without `--replace`. On the next start (`rdv listen` or `rdv-mcp`) each contact is told (`rdv/restored`, SPEC §6.4.1), so conversations go on with no resync; `rdv whoami` shows who confirmed. Open tasks, dinners and pending requests are not in a backup. Yours to run |

### Output and locking

Output is human text by default and one JSON object per line with `--json`.
Exit codes: 0 ok, 1 error, 2 usage error. Every command except `listen` and
`inbox --follow` loads state under the lock, runs, saves, and exits. `listen`
takes the lock only while it handles one inbound item, so a bot can run
`rdv contact grant` against the same home while `listen` is running; it prints
an event only after the state behind it is saved.

**One inbound consumer per home.** Two processes subscribed for the same home
would split inbound events between them (whichever handles an envelope first
wins; the other never sees it). So whoever consumes holds `listener.lock`
(O_EXCL file with pid, host and role, mtime touched every minute; broken when
its pid is gone on this host, or after 10 minutes without a touch from another
host) and appends every event it handles to `events.jsonl`, after the state
behind it is saved. A second `rdv listen` exits 1 naming the holder. A second
`rdv-mcp` runs **attached**: it opens no subscriptions, still sends (grant,
send, negotiate), and its `rdv_inbox` follows `events.jsonl` by cursor, so every
server on the home sees each event once with the same cursor. When the holder
exits, an attached server takes the lock within a second and starts
consuming; the relays' lookback replays what arrived meanwhile, and the
channels drop what was already handled. Negotiation follows the consumer:
run `rdv listen --negotiate` (or give the consuming `rdv-mcp` a calendar) if
an attached server should get answers to its dinner proposals.

PowerShell quoting for `send`: `rdv send <id> --json '{\"type\":\"note\",\"text\":\"hi\"}'`
(Windows PowerShell 5 strips bare inner quotes; PowerShell 7.3+ accepts the bash form).

## Examples

### Example: contact and a first message (PLAN §4.5)

`packages/cli/scenarios/contact.ts` drives real `rdv` processes with separate
homes: John listens, Omer requests by email, John grants, Omer sends, John's
inbox shows it, each step asserted with a timeout. It runs:

- against the in-memory relay as part of `npm test`;
- against real relays with `npm run test:live` (below);
- by hand against any relays, e.g. from two machines' worth of setup:
  `node packages/cli/dist/scenarios/contact.js --relay wss://relay.example [--relay …] [--timeout 30000] [--keep]`.

Crash safety: state is saved right before each envelope leaves (`Agent.beforeSend`),
so a crash after a send never reuses a `seq` (issue #4).

### Example: tasks and files
(User guide: [`docs/tasks.md`](../docs/tasks.md).)

Omer asks John's agent for a document review; John's side runs `rdv listen`.

```bash
# Omer: ask (John's grant to Omer must allow request/v1)
rdv task request rdv1:… --text "Please review the attached Q4 plan"

# John, in his own terminal: see what waits, with the codes
rdv task list
rdv task approve <task-id> --code <code>          # start gate: now his agent may act

# John's agent drafts; John prepares a file, uploads the .bin, and attaches it
rdv file prepare ./q4-review.pdf                  # prints the sha256 and the copy to upload
rdv task submit <task-id> --text "Notes attached" --file <sha256>=https://files.example.com/q4 --complete
rdv task list                                     # shows the draft and the file in full
rdv task release <task-id> --code <code>          # release gate: only now does it leave

# Omer: fetch it (only for a task he requested, or one he started)
rdv file fetch <task-id> --file 1

# Later: what passed without asking, and a trusted contact on auto-approve
rdv audit --since 7d
rdv owner-secret set                              # once, in your own terminal
rdv contact auto-approve john@doe.com all --until 7d
rdv contact auto-approve john@doe.com off
```

### Example: a group (design B.5, issue #79)

`packages/cli/scenarios/microsite.ts`: Omer, John and Dana, three `rdv`
processes. Omer is John's and Dana's contact; John and Dana never meet. Omer
creates a group, John joins (members may ask him for `request/v1`; newcomers
`trust-admin`), Dana joins (`ask`) and approves John. Omer puts an open task
on the board; Dana claims it and Omer assigns it to her (John's attempt to
assign it is refused by his own board); Dana's human approves the start and
releases the copy, which the release gate shows going to Omer and John.
Omer then asks John for a review referring to the copy: John's start gate
shows that the input is Dana's result ("not your contact, named by the admin
as Dana"). John leaves: his assigned proofread reopens and his open request
is canceled on the others' boards; Dana drops her channel with him, Omer
keeps his. Omer hands the admin role to Dana and leaves. It runs in `npm
test` on the in-memory relay; by hand:
`node packages/cli/dist/scenarios/microsite.js --relay wss://… [--timeout ms] [--keep]`.

### Example: negotiating a meeting (PLAN §5.3)

Meetings are one use of the tasks layer, built on the `a2a` package's meeting engine. The commands say `dinner`, the first meeting the engine was built for. Both sides run `rdv listen --negotiate` with their own JSON calendar; one runs `rdv dinner propose`.

| Command | Does |
|---|---|
| `rdv dinner propose <agent-id> --calendar cal.json --window "next week evenings" [--tz +02:00] [--minutes 120] [--place …] [--area …] [--expires <rfc3339>]` | Offer up to 3 free slots; run `listen --negotiate` to handle the replies |
| `rdv dinner confirm <task-id> --hold <code> [--calendar cal.json]` | Confirm the dinner a negotiation holds for you: sends `meeting/accept` (their offer) or `meeting/confirm` (they accepted yours). `--hold` is the code `rdv dinner list` shows; it is refused if the meeting changed since |
| `rdv dinner cancel <task-id> [--reason …] [--calendar cal.json]` | Send `rdv/cancel` for a pending negotiation and release its hold; for an agreed (completed) dinner, send `meeting/cancel`: it leaves your calendar and the peer's agent removes it from theirs |
| `rdv dinner list` | Negotiations with state, round, agreed or held slot (and what it waits for) |
| `rdv listen --negotiate --calendar cal.json [--window "…"] [--tz +02:00] [--auto-confirm]` | `--negotiate` answers dinner proposals from the calendar (window default `next week evenings`) and holds a slot for you to confirm; `--auto-confirm` skips the human (bots, demos). Takes the same flags as `rdv listen` above |

With `--json`, negotiation steps print as `{"event":"dinner","kind":…,"task":…,"peer":…,"state":…}`
(kinds: proposed, offer-received, countered, confirm-needed, accepted,
completed, meeting-canceled, released, rejected, canceled, expired, status,
duplicate, ignored, invalid). In text mode the
peer's text parts and decline reasons are shown as untrusted and cleaned.

`packages/cli/scenarios/dinner.ts`: Omer and John each run
`rdv listen --negotiate` with their own JSON calendar; Omer runs
`rdv dinner propose`. Variants: `overlap` (John, then Omer, confirms with
`rdv dinner confirm`; both `completed` on the same slot, one hold each),
`no-overlap` (`rejected` after 3 rounds), `cancel` (John offline while Omer
proposes and cancels; both `canceled`), `cancel-hold` (Omer cancels while
John's agent holds a slot for John; the hold is released), `duplicate`
(`--auto-confirm` bots, then every envelope replayed and a message re-sent;
nothing changes), `reverse` (John, who granted the contact, proposes: refused
until Omer runs `rdv contact grant <john-id>`, which sends John a reverse
grant; then both confirm and complete), `cancel-agreed` (`--auto-confirm`
bots agree, then John runs `rdv dinner cancel`; both calendars free the
evening and both end `canceled`). All seven run in `npm test`; `overlap` runs in
`npm run test:live`; by hand:

`node packages/cli/dist/scenarios/dinner.js --relay ws://… [--variant overlap] [--variant …]`.

The calendar file and `--window` are described under `@rendezvous/a2a` below.

## Libraries

The protocol library, then the task and meeting layer.

## @rendezvous/core

| Module | Spec | What it does |
|---|---|---|
| `identity` | §4.1–4.2 | Ed25519 agent keys, `rdv1:` IDs, fingerprints |
| `sign` | — | Signed JSON documents (canonical JSON + Ed25519) |
| `card` | §4.3 | Create and verify address cards |
| `discovery` | §4.4 | `dtopic()`, `idtopic()` (the agent ID's topic, NOTES 83), address and agent-ID canonicalization, binding levels |
| `contact` | §5 | Contact request / grant / revoke, and the contact book (policy, replay, rate limits) |
| `envelope` | §6.4, §7 | Encrypted, signed envelopes; `seq`/`prev` ordering with gap detection |
| `delivery` | §6.4.2 | Delivery receipts: the `rdv/ack` payload (`ackSeq`), per-contact pending and owed acks, the retry backoff (`RECEIPT_TIMING`, `retryDue`, `nextDeliveryDue`), summaries for hosts (NOTES 98) |
| `files` | §7.7 | File references (`FilePart` + files extension): strict validation, `encryptFile`, `verifyAndDecrypt`, inline parts |
| `filefetch` | §7.7 | `fetchFileRef`: https only, SSRF-blocked and DNS-pinned, no credentials, capped, hash-verified |
| `group` | §7.8 | Groups v1 membership: the signed `rdv/group-state` chain (`epoch`, `prev`, admin signer; any two states at one epoch are a fork), `rdv/group-invite`, `rdv/group-join` (a group-scoped grant), and the `GroupBook` (invites, newcomer policy, approvals; at most 16 members, NOTES 86) |
| `groupmsg` | §7.8.3, §7.8.5–§7.8.7 | Group messages: `rdv/group-msg` (a signed header committing to the body by hash), the per-sender chain (`gseq`/`gprev`) and `heads`, gaps and group resend, equivocation evidence (`rdv/group-proof`, headers only), `rdv/group-leave`, `member_rate` and the mute with its `rdv/group-report` (NOTES 87) |
| `backup` | §6.4.1 | The encrypted identity bundle (`sealBackup`, `openBackup`, strict `parseBackup`; scrypt + AES-256-GCM, the header as associated data) and the agent state for a backup and after a restore (`backupAgentState`, `restoredAgentState`: a new epoch per channel, each owing its peer an `rdv/restored` notice; NOTES 91) |
| `transfer` | §7.7 | `rdv/transfer` messages and their pure state machine (negotiation only, no transport) |
| `transport/nostr` | §6.2 | Nostr relay transport (kind 30417): re-subscribes when a relay drops; publishes with retries, per-relay pacing and cooldowns, and per-relay status (`relayStatus()`); `setRelays()` moves a live transport; pings sockets and echo-checks the envelope subscription, re-joining a deaf one (`onReconnect()`, NOTES 95, 98); discovery mirrors (`mirrorRelays`, `mirrorTopics()`); `DEFAULT_RELAYS`, `DEFAULT_MIRROR_RELAYS` |
| `agent` | — | Ties it together: listen, discover, request, grant, send, receive |
| `testing/relay` | — | In-memory Nostr relay on a localhost WebSocket, for tests and local demos (`stall()` goes half-open, `deafen()` drops subscriptions silently) |

```ts
import { Agent, NostrTransport } from '@rendezvous/core';

const relays = ['wss://relay.example'];
const john = Agent.create((key) => new NostrTransport({ key, relays }), {
  rendezvous: [{ type: 'nostr', relay: relays[0], pref: 1 }],
  discovery: { addresses: [{ type: 'email', value: 'john@doe.com' }], public_pointer: false },
});
john.on('request', (p) => john.grant(p.request.id, { tier: 'friend' })); // the human decides here
john.on('message', (from, payload) => console.log(from, payload));
john.start();

// On another machine:
await omer.requestContact('john@doe.com', "Omer's agent would like to be in contact.");
omer.once('contact', () => omer.send(john.id, { type: 'note', text: 'Hi John, Omer here.' }));
```

**Relays.** `DEFAULT_RELAYS` is the public set `rdv init` uses when no relay
is given: `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.nostr.net`,
`wss://nostr.oxtr.dev` (checked live, NOTES 11a). A publish counts as
delivered when one relay answers `OK true`. Transient failures are retried
twice with jittered backoff. A relay that answers `blocked`, `restricted` or
`banned` is skipped for 30 minutes. Events are paced per relay (a burst of 6,
then 3 per second). Each tunable is a `NostrTransportOptions` field (NOTES 69).
An envelope's plaintext is at most 32 KiB (`MAX_PLAINTEXT_BYTES`, SPEC §6.4).

**Discovery mirrors** (NOTES 81). An agent listens on a few relays, and its
envelopes go only there. Its card can also be mirrored to more relays, so a
peer that asks other relays still finds it: `NostrTransportOptions.mirrorRelays`.
`fetchTopic` (so `Agent.lookup`) asks the mirrors too, at most
`lookupConcurrency` (4) at a time, each within the lookup timeout.
`mirrorTopics()` (`Agent.mirrorPointers()`) publishes the card to our relays
and then each mirror strictly one at a time: a pause between relays (1.5 s),
one try each with a timeout (6 s), cooling relays skipped, then a read-back
per relay. It returns accepted / rejected (with the relay's reason) / timeout /
skipped and `served` per relay. `DEFAULT_MIRROR_RELAYS` is the vetted public
set (13 relays, from `deploy/mirror-survey.mjs`; never relay.damus.io).
`Agent.setRelays()` re-signs the card with other relays and moves the
transport (`setRelays()`), subscriptions included.

Agent state serializes with `agent.toJSON()` and loads with `Agent.fromJSON()`.
`packages/core/vectors/v1.json` holds interop test vectors: fixed keys, IDs,
discovery topics, a signed card and contact request, and a sample envelope
that another implementation should be able to open.

## @rendezvous/a2a

PLAN.md §5.1–5.2, SPEC.md §7. Tasks (`tasks/v1`) and the group board live here, with no runtime dependencies. This package also holds a meeting-negotiation engine, one example of what agents do with tasks. Its payloads `a2a/message` (an A2A v0.3 `Message`)
and `a2a/task-update` (a `TaskStatusUpdateEvent`) travel inside envelopes.
The verb sits in the message's `data` part (`data.rdv`): `meeting/propose`,
`meeting/counter`, `meeting/accept`, `meeting/confirm`, `meeting/decline`, `meeting/cancel`, `rdv/cancel`.

| Module | What it does |
|---|---|
| `model` | Types and `parsePayload`: strict validation of peer input (known keys only, UUIDs, 1–3 RFC 3339 slots with offsets, bounded text) |
| `engine` | Pure state machine: `propose`, `receive`, `confirmMeeting`, `cancel`, `cancelMeeting`, `expire` return `{ state, outgoing, effects, events }`; no I/O, no clock |
| `capabilities` | General tasks (SPEC §7.6.3): `CapabilityRegistry` (URI, approval class, strict `input` and result `data` schemas built with `s`) |
| `taskmodel` | `parseTaskPayload` for `tasks/v1` (`task/request`, `task/input`, `rdv/cancel`, status updates, `a2a/artifact-update`), and `routeA2A`, which picks the meetings or the tasks engine |
| `tasks` | Pure task engine: `requestTask`, `receiveTask`, `inputTask`, `cancelTask`, `startTask`, `rejectTask`, `askInput`, `sendArtifact`, `finishTask`, `expireTasks`; start and release gates as effects; bounds of §7.4 |
| `board` | Tasks in a group (SPEC §7.8.4): the board, each member's pure projection of the group's task messages (`boardReceive`, `boardDeparted`, `boardSweep`; open, claimed, assigned, state, artifacts), who may say what (only the requester assigns, only the assignee reports), `boardRequest` / `boardVerb` for our own posts, and `admitGroupInvoke`, the join scope's limits (NOTES 88) |
| `calendar` | `CalendarAdapter` (`freeBusy(range)`, `hold(slot)`, `release(slot, note)`), `MemoryCalendar`, `JsonFileCalendar` (titles never leave the file) |
| `window` | `parseWindow`: RFC 3339 ranges and a few phrases, with `now` and the UTC offset passed in |
| `time` | Instants, fixed offsets, slot formatting |

Policy: an offer carries up to 3 free slots (one per day first); the receiver
accepts the first offered slot that is free and inside its window, else
counters with 3 of its own; after 3 offers the task ends `rejected`. Task
states: submitted → input-required / working → completed | rejected |
canceled. Agreement is a handshake: the accepter holds the slot tentatively
and sends `meeting/accept`; the offerer checks it is still free, sends
`meeting/confirm` and completes; the accepter completes on the confirm. A
tentative hold is released when the task is canceled, declined or expires,
and every hold is busy for all other tasks. Unless `ctx.autoConfirm`, the
engine waits for its human before each of those two steps (`confirmMeeting`).
Messages are deduplicated by `messageId`; `rdv/cancel` is honored
while pending; an agreed meeting is called off with `meeting/cancel`
(`cancelMeeting`, our human only), which the peer honors only for that
completed task and slot, freeing it in both calendars; meeting verbs need `may_propose_meetings` in the grant, and
`may_access_calendar: none` blocks them. A peer can hold at most 32 tasks
with us. Details and open questions: [NOTES.md](NOTES.md) items 28–37, 58, 61.

**`--window`** (local time = a fixed offset; weeks run Monday–Sunday; an
evening is 19:00–23:00; everything is clipped to start no earlier than now):

| Window | Means |
|---|---|
| `tonight` / `tomorrow evening` | that one evening |
| `this week evenings` | every evening from today to Sunday |
| `next week evenings` | every evening Monday–Sunday of next week |
| `this weekend` / `next weekend` | Saturday and Sunday evenings |
| `2026-11-05T19:00:00+02:00/2026-11-05T23:00:00+02:00[,…]` | explicit ranges |

Calendar file: `{ "timezone": "+02:00", "busy": [ { "start": "…", "end": "…", "title": "optional" } ] }`.
Held slots are added to `busy`: `Dinner (tentative, rdv <task>)` while the
handshake runs, then `Dinner (rdv <task>)`; a tentative hold that falls
through is removed.

## rdv-mcp (the MCP server)

PLAN §6.1. Tools `rdv_init`, `rdv_status`, `rdv_addresses`, `rdv_relays`, `rdv_publish_card`, `rdv_discover`,
`rdv_request_contact`, `rdv_pending_requests`, `rdv_grant`, `rdv_revoke`,
`rdv_auto_approve`, `rdv_backup`, `rdv_send`, `rdv_inbox`, `rdv_negotiate`,
`rdv_task`, `rdv_file`, `rdv_group`, and the `rdv://inbox` resource
(subscribable). `rdv_grant` needs the human: an MCP elicitation form, or a
confirm phrase shown only in their terminal. Peer text comes back only as
`untrusted_peer_text`. Details, consent threat model and client config:
[packages/mcp/README.md](packages/mcp/README.md), [demo/SCRIPT.md](demo/SCRIPT.md).

```bash
node packages/mcp/dist/src/bin.js --home ~/.rendezvous/omer --calendar cal.json --tz +02:00
```

## rdv-gateway (cloud assistants, issue #12)

The same tools as `rdv-mcp`, minus the owner's setup (`rdv_init`, address and
relay changes, turning auto-approve on, local file paths), for assistants that
only reach a public URL. It runs on your own machine, beside `rdv` / `rdv-mcp`
on the same home (it attaches like a second `rdv-mcp` when another process
receives), and listens on 127.0.0.1; put your own HTTPS tunnel in front of it.
Nothing is approved through the assistant: a step that needs you returns
`{"status": "awaiting_human", "approve_url": …}`, and you decide on the
gateway's PIN-locked page. Threat model:
[packages/gateway/THREAT-MODEL.md](packages/gateway/THREAT-MODEL.md); design
choices: NOTES 89. To run it in a hardened Docker container behind a tunnel,
see [the deploy guide](../docs/gateway-deploy.md).

Its owner commands (`pin set|unlock`, `token create|revoke`, `oauth revoke`,
`agent add|remove|migrate`, `notify set|clear|dead-letter`) run only in your
own terminal: stdin and stdout must both be one, `--stdin` included, or they
refuse before reading or writing anything (issue #126). Over ssh use `ssh -t`;
in a container, `docker compose run` or `exec` without `-T`, or `docker exec -it`. The
read-only ones (`serve`, `token list`, `oauth list`, `agent list`,
`notify show`) run anywhere.

```bash
node packages/gateway/dist/src/bin.js pin set --home ~/.rendezvous/omer
node packages/gateway/dist/src/bin.js serve --home ~/.rendezvous/omer --public-url https://rdv.example.com --client-ip-header cf-connecting-ip
# MCP: https://rdv.example.com/mcp (legacy SSE: /sse)   REST: /api/v1/tools/<tool>   OpenAPI: /openapi.json   approvals: /approve
```

**Connecting ChatGPT or claude.ai (OAuth 2.1).** The gateway is its own
authorization server, so these connect with no token to copy. The MCP URL is
`https://<your host>/mcp`.

- **claude.ai:** Settings → Connectors → Add custom connector, and paste the
  MCP URL.
- **ChatGPT:** turn on developer mode (in Settings, under the connectors'
  advanced settings), then create a connector with the MCP URL and choose
  OAuth as its authentication.

The assistant registers itself (dynamic client registration) and sends your
browser to the gateway. You unlock the page with your PIN and see the name the
app registered (anyone can register any name, so check the return address it
shows, e.g. `claude.ai` or `chatgpt.com`), plus the scopes it asks for. You can
untick scopes, then approve. Nothing is ever approved automatically, even for an
app you connected before. No scope can approve anything: approvals still happen
only on the page. Access tokens last an hour and refresh tokens rotate, so a
refresh token that is reused ends that connection. To see or end connections:

```bash
node packages/gateway/dist/src/bin.js oauth list --home ~/.rendezvous/omer
node packages/gateway/dist/src/bin.js oauth revoke <cli_…|grt_…> --home ~/.rendezvous/omer   # a whole app, or one grant
```

**Static tokens**, for assistants without OAuth (Muse, scripts):

```bash
node packages/gateway/dist/src/bin.js token create --name muse --scope read,send,contact:request --home ~/.rendezvous/omer
node packages/gateway/dist/src/bin.js token list --home ~/.rendezvous/omer
node packages/gateway/dist/src/bin.js token revoke <id> --home ~/.rendezvous/omer
```

**Several agents on one gateway** (NOTES 104). `--home` is the gateway's root:
its PIN, tokens and OAuth state, and the agents it serves (the root itself if
it is a home, plus `agents/<name>/`). Each token and OAuth grant reaches exactly
one agent. Restart the gateway after adding or removing one.

```bash
node packages/gateway/dist/src/bin.js agent add kids new --email kids@example.com --home /data   # or: agent add kids --restore <backup-file>
node packages/gateway/dist/src/bin.js agent list --home /data
node packages/gateway/dist/src/bin.js token create --agent kids --name kids-claude --scope read,send --home /data
node packages/gateway/dist/src/bin.js agent remove kids [--force] --home /data   # moved to agents/.removed/, key kept
node packages/gateway/dist/src/bin.js agent migrate [--name omer] --home /data   # the root's own agent into agents/<name>/ (gateway stopped)
# MCP: /a/kids/mcp, REST /a/kids/api/v1/tools/<tool>, OpenAPI /a/kids/openapi.json; /mcp serves each token's own agent
```

## Develop

Run from `impl/` (works the same in PowerShell and bash):

```bash
npm install
npm run typecheck        # every workspace
npm test                 # core, a2a, cli (commands + scenarios), mcp (two servers end to end); local relay, no network
npm run build            # tsc -b -> packages/*/dist
npm run test:vectors:update   # regenerate vectors (deliberate wire-format changes only)
```

One package or one file: `npm test -w @rendezvous/core`, or
`cd packages/core && npx vitest run test/unit.test.ts -t envelope`.
CLI tests spawn the built `rdv`, so the CLI's `test` script builds first.

**Live relays.** `npm run test:live` runs only `*.live.test.ts`, and those skip
unless `RDV_LIVE_RELAYS` lists relays. They are never part of `npm test`.
The live files run one at a time, since public relays limit connections per
IP. Keep the volume modest: relay.damus.io banned the test pubkey after a few
runs.

```bash
RDV_LIVE_RELAYS=wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.net,wss://nostr.oxtr.dev npm run test:live
```
```powershell
$env:RDV_LIVE_RELAYS='wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.net,wss://nostr.oxtr.dev'; npm run test:live; Remove-Item Env:RDV_LIVE_RELAYS
```

**Pre-push hook (replaces CI).** Enable it once per clone, from the repo root:

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-push` runs `npm run typecheck && npm test` in `impl/` and blocks
the push if either fails.

See [NOTES.md](NOTES.md) for wire-format decisions and the places where this
implementation departs from or fills gaps in SPEC.md.
