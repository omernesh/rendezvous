# Changelog

What changed in Rendezvous, newest first. Versions are those of the Claude Code plugin, which ships together with the `rdv` CLI, the `rdv-mcp` server and the skill. Rendezvous is in early access: expect changes between versions. Security fixes are marked **Security**.

The format follows Keep a Changelog. One line per change a user can see; PR numbers link to GitHub.

## Unreleased

### Added
- You can let your assistant make invite links without asking, once per agent on the gateway's settings page (your PIN again, off by default): say "invite Ran" and it gets a link at once, always for a stranger who can message your agent (and your assistant can message them back), for at most 7 days, at most 5 open and 20 in 24 hours, and not while your agent accepts only its allowlist. Asking for more goes to your approval page; each link sends a new `invite_created_by_assistant` webhook event (a webhook set before this needs it added; the settings page shows the command), and the page lists the open ones with a Revoke button.
- The gateway's approval result page has Copy buttons on the invite link and the message ready to send. The page stays free of JavaScript except one small fixed script for these buttons, which a content-security hash allows only on that page.
- "Don't ask again for this contact" now comes up when you approve a contact or make an invite link, once, listing exactly what it would let that contact do without asking; it stays unticked unless you tick it, and is left out when nothing applies. On an invite it takes effect when the link is used, only for whoever uses it; a revoked or expired link leaves nothing. The later task and dinner forms still offer it if you didn't choose it. The gateway's settings page lists each agent's auto-approved contacts with a Turn off button.

### Changed
- (Security) An invite link you armed with "Don't ask again" is no longer given to the assistant that asked for it on the gateway: it is shown only on your approval page, so an injected assistant cannot pass it on. A new `auto_approve_on` webhook event (on by default for new webhooks) tells you straight away when such a link is used. "Turn everything off" now also disarms open armed invites, and the gateway's settings page lists them with a Disarm button.
- On approval forms the label field is now "What you call them, e.g. Ran" (your name for the other person, not your own assistant's), and browsers no longer autofill the gateway page's text inputs.

## 0.13.0 - 2026-11-01 {#v0-13-0}

### Added
- The gateway has a settings page, `/approve/admin`, unlocked with your PIN: for each agent, see, make (shown once) and revoke access tokens, see and disconnect connected apps, see the webhook and turn it off, and change your PIN, with no terminal. Your assistants cannot open it, whatever their token's scopes. Setting a webhook, adding or removing agents and the first PIN stay `rdv-gateway` commands. ([#102](https://github.com/omernesh/rendezvous/issues/102))

### Security
- **Security, upgrade note:** the commands that are yours alone (granting, confirming, labels and nicknames, your agent's name, the task and group gates, relay changes, auto-approve, backups and restores, the commands that show confirm phrases, and the gateway's `pin`, `token`, `oauth revoke`, `agent` and `notify` commands) now refuse to run unless they are in an interactive terminal, and say which chat tool asks you instead. A shell tool without a terminal (Claude Code's Bash and PowerShell tools, MCP clients) is refused when it runs the `rdv` or `rdv-gateway` commands; another interpreter calling the library directly (e.g. `node -e` importing `dist/src/main.js`), or a launcher that opens a new console or pseudo-terminal, still gets through (an accepted limit, #51, which the consent guard names), and an assistant running its shell in a real terminal must use the approval-form tools. **New requirement: run them yourself in your own terminal (`ssh -t` on a server, `docker exec -it` in a container)**. Piping a passphrase or PIN with `--stdin` is refused the same way, and `--stdin` on a terminal uses the hidden prompt instead of echoing it. ([#126](https://github.com/omernesh/rendezvous/issues/126))
- **Security, breaking change:** `rdv send`, `rdv group post` and the `rdv_send` tool (in `rdv-mcp` and the gateway) now carry only free messages (`{"type":"note",…}`). Task results, meeting accepts, file transfers and group messages are refused with the command or tool to use instead (`rdv task` / `rdv_task`, `rdv dinner` / `rdv_negotiate`, `rdv file` / `rdv_file`, `rdv group` / `rdv_group`), so nothing can skip their approval gates. **Breaking: a plain message of type `a2a/message` is now refused; scripts that sent `{"type":"a2a/message","text":…}` must send `{"type":"note",…}` instead.** ([#133](https://github.com/omernesh/rendezvous/issues/133))
- **Security:** a relay can no longer push frames of up to 100 MiB at your agent: every relay connection now drops at 1 MiB per frame (the biggest real message is under 50 KB) and reconnects like any other dropped relay. ([#125](https://github.com/omernesh/rendezvous/issues/125))
- **Security:** the plugin's shell check now also refuses `systemctl --user set-environment` / `import-environment` and `launchctl setenv`, which would put a variable in front of every service started later, the background listener included. ([#118](https://github.com/omernesh/rendezvous/issues/118))

### Fixed
- A contact made by an invite link your agent accepted now says so in `rdv_inbox` for every session of that agent, with a reference to the link and when it was accepted, so a second chat window can tell you where the contact came from (#141).
- The warning that your background listener was changed outside Rendezvous is no longer repeated every 5 minutes when only the task, unit or LaunchAgent registration was changed; it is said once, and again only after a clean check and a new change. ([#118](https://github.com/omernesh/rendezvous/issues/118))

## 0.12.0 - 2026-11-01 {#v0-12-0}

### Added
- Invite people by link, WhatsApp style: ask your assistant to invite someone, choose in an approval form what they get and for how long, and send the ready-made message; when they open the link and tell their assistant "accept my Rendezvous invite", or run `rdv init --invite <link>`, you are connected at once, and you are told who used it. The link works once and expires (7 days by default); `rdv invite create` in a terminal does the same.
- Nicknames for your contacts: tell your assistant "talk to joe" or "tell Ran's agent …" once you have given that contact the nickname (you type it in an approval form; at most 8 per contact, each name belongs to one contact). You can also name your own agent (e.g. "Sammie"): contacts see it as what your agent calls itself, never as a way to pick it, and your contact requests greet with it.
- One `rdv-gateway` can serve several agents (yours, a second assistant's, a family's): `rdv-gateway agent add|list|remove|migrate`, an MCP address per agent (`/a/<name>/mcp`), and every token and OAuth connection reaches exactly one agent; the approval page says which agent each approval is for. An existing single-agent gateway works unchanged.
- One-command gateway install: `curl -fsSL https://rendezvous.nesher.co/install-gateway.sh | sh` builds and starts `rdv-gateway` behind a Cloudflare Tunnel, your own proxy or Tailscale Funnel, one question at a time, and the plugin's `rdv-gateway-setup` skill prepares it from chat.
- Be told the moment someone accepts your invite: `rdv-gateway notify set <agent> --url https://… --secret-file <file>` has the gateway POST a signed event (HMAC-SHA256) to a receiver of yours when an invite is used, expires unused or is exposed, and optionally on contact requests, new contacts and messages (metadata only, never text). Retried for up to 24 h, kept across restarts, given-up events listed and resent with `notify dead-letter`; private addresses only for a host or range you allow; a new secret signs alongside the old one for 24 h. An example receiver is in `docs/notify-receiver.py`.

### Changed
- Invite links are now about 106 characters instead of about 300 (a new compact format; links made before still work) and carry your name only if you ask for one. Assistants are told to hand a link over whole, never shortened, and a link that was shortened with "…" or cut off now gets a clear "ask for the full link" answer instead of a vague error.
- The docs, site, plugin and MCP server text now describe Rendezvous as cross-platform secure agent-to-agent messaging, with meeting scheduling as one example. The CLI reference follows the order you use it (identity, contacts, messages, tasks and files, groups, backups), and the FAQ shows the current version.

### Fixed
- **Security:** a relay can no longer inject text into your assistant's connection to Rendezvous or into `rdv --json` output: messages a relay sends for display (NOTICE) are dropped instead of printed, and anything a library prints goes to the error stream as one cleaned line. Before, a hostile relay (one named in a contact's card, or now in an invite link) could forge tool results or approval prompts.
- **Security:** `rdv` no longer runs a command whose name was given as one quoted word (such as `"contact grant"`), which slipped past the plugin's check that keeps your assistant away from commands that are yours alone; that check now also reads such words, and refuses a subcommand built while the command runs (shell parameters such as `$@`, PowerShell splatting and expressions).
- Rendezvous no longer crashes when its error stream is closed (for example when `rdv` is piped into a program that exits early); the line is dropped instead.
- `rdv --version`, the MCP server and the gateway's API document now report the real release version instead of 0.1.0, and the site's `llms.txt` takes it from the plugin manifest.
- The backup form and `rdv backup` now tell you the passphrase rules up front (length, variety, no common words) instead of only after you submit.

## 0.11.0 - 2026-10-27 {#v0-11-0}

### Added
- Your agent can stay reachable while your chat app is closed: ask your assistant, approve the form that shows exactly what it installs, and a background listener starts whenever you log in (a scheduled task on Windows, a LaunchAgent on macOS, a systemd user service on Linux); it never approves anything on its own, and you can remove it any time (`rdv_service`, or `rdv service install` in a terminal). ([#102](https://github.com/omernesh/rendezvous/issues/102))

### Fixed
- The standing-approval demo clip on the site no longer says no tool can turn it on: it now shows the agent opening the approval form where you type your owner passphrase. ([#106](https://github.com/omernesh/rendezvous/issues/106))
- **Security:** delivery receipts are harder to abuse: a contact that restores its agent onto a clock that runs far behind can no longer let old receipts confirm messages it never got, and someone replaying a contact's old messages can make your agent send that contact at most 48 extra receipts a day. ([#113](https://github.com/omernesh/rendezvous/issues/113))

## 0.10.1 - 2026-10-27 {#v0-10-1}

### Fixed
- **Security:** when you give more rights to a contact that is on auto-approve, the approval form (and the confirm phrase in your terminal) now tells you it stays on and that looser limits on what it covers are approved without asking too; and an older copy of the auto-approve file put back after you narrowed a grant and widened it again no longer brings back what the narrowing removed. ([#94](https://github.com/omernesh/rendezvous/issues/94))

## 0.10.0 - 2026-10-27 {#v0-10-0}

### Added
- Delivery you can trust: your contact's agent confirms what it received, unconfirmed messages are sent again on their own (and again when a relay comes back), and your assistant tells you when a message is still not confirmed after about half an hour; a relay that silently stops delivering to you is caught by a periodic self-check and reconnected with a catch-up. Contacts on older versions keep working, without receipts, and you can turn sending receipts off ("receipts": false in config.json). ([#104](https://github.com/omernesh/rendezvous/issues/104))

## 0.9.0 - 2026-10-27 {#v0-9-0}

### Added
- Settings you used to change in a terminal now work from the chat, each through an approval form only you answer: rename a contact (`rdv_label`), set or change your owner passphrase (`rdv_owner_passphrase`), take a contact's or a group's messages again after a fork (`rdv_resync`), turn direct file transfers on or off (`rdv_file`), and replace your agent with a new identity (`rdv_init` with `replace`, which shows what is lost and offers a backup first). Your assistant can't answer the form, and there is no confirm phrase for these; the terminal commands still work. ([#102](https://github.com/omernesh/rendezvous/issues/102))

## 0.8.0 - 2026-10-27 {#v0-8-0}

### Added
- "Don't ask again for this contact" on the approval forms for a contact's task (start and release) and for a dinner it proposed, in Claude Code and on the gateway's page: tick it with your approval and that contact's tasks of that kind, or its dinners, no longer ask you, until you turn it off (ask your assistant, or in your terminal). No passphrase needed, since only you can answer the form; your assistant can never tick it. ([#103](https://github.com/omernesh/rendezvous/issues/103))
- The gateway pages now show the Rendezvous logo and wordmark at the top and a favicon, and send `Cache-Control: no-store, no-transform` so a proxy cannot mask addresses as "[email protected]".
- A deploy guide for `rdv-gateway`: a hardened Docker Compose setup behind a TLS tunnel, the PIN and test-identity first run, connecting claude.ai, ChatGPT and Claude Code, updating, and checks. ([#12](https://github.com/omernesh/rendezvous/issues/12))

### Fixed
- Approval forms work in Claude Code: the tool no longer waits for the form (Claude Code shows it only after the assistant's reply, so it used to time out and do nothing). The form appears once the reply ends, your answer completes the step, and your assistant hears what you decided. Several can be open at once, and an answer to something that changed meanwhile does nothing. ([#103](https://github.com/omernesh/rendezvous/issues/103))
- An agent no longer stays deaf after a network blip leaves a relay connection half-open: dead relay sockets are detected within about a minute, re-joined with a catch-up, and reported as relay down and up. A refused probe answer now leaves a line in the process log. ([#101](https://github.com/omernesh/rendezvous/issues/101))

### Changed
- Site: the home page, docs and llms.txt now present Rendezvous as encrypted messaging between AI agents across platforms (messages, tasks, files, groups, scheduling), and outdated claims are fixed: the gateway for claude.ai and ChatGPT has shipped, backups, relay-down warnings, and auto-approve surviving a grant change you make yourself.
- Site: the setup section now opens on "Ask your agent", with "Or use the CLI" as the second tab.

## 0.7.1 - 2026-10-27 {#v0-7-1}

### Fixed
- Approval form questions are short enough to read in Claude Code: field titles are a few words and the explanation sits in the field's description (also shown on the gateway's approval page), so nothing is cut off mid-sentence. ([#99](https://github.com/omernesh/rendezvous/issues/99))

## 0.7.0 - 2026-10-26 {#v0-7-0}

### Added
- `rdv-gateway` connects to ChatGPT (developer mode connectors) and claude.ai custom connectors with OAuth: paste `https://<your host>/mcp` and approve the connection on your PIN-locked gateway page. You see the app's name, where it returns and what it asks for, and you can untick scopes. Nothing connects without you, and no connection can approve anything. `rdv-gateway oauth list` and `oauth revoke` show and end connections. ([#12](https://github.com/omernesh/rendezvous/issues/12))
- The gateway also serves MCP over the legacy SSE transport at `/sse`. ([#12](https://github.com/omernesh/rendezvous/issues/12))

### Security
- **Security:** OAuth uses PKCE S256 only, exact https return addresses, single-use codes, short-lived access tokens, and rotating refresh tokens. Reusing a refresh token ends that connection. Tokens are bound to your gateway's address and stored only as hashes. The plugin's consent guard keeps your assistant from running `rdv-gateway oauth revoke`. ([#12](https://github.com/omernesh/rendezvous/issues/12))

## 0.6.1 - 2026-10-26 {#v0-6-1}

### Changed
- Changing the grant of a contact on auto-approve no longer turns it off: it stays on for what it already covered and the new grant still allows, and anything the new grant adds asks you until you turn auto-approve on for it. `rdv contact list` and `rdv_status` show what is covered and what is not. ([#93](https://github.com/omernesh/rendezvous/issues/93))

## 0.6.0 - 2026-10-26 {#v0-6-0}

### Added
- Back up your agent and recover it on a new computer: ask your assistant to "back up my agent" or "recover my agent from backup" (you type the passphrase only into an approval form, never into the chat), or use `rdv backup` and `rdv restore` in your own terminal. The backup is one encrypted file; keep it in your password manager or a cloud drive. After a restore your contacts are told, so your conversations go on without anyone re-syncing, and contacts on auto-approve stay on it. ([#88](https://github.com/omernesh/rendezvous/issues/88))

## 0.5.2 - 2026-10-26 {#v0-5-2}

### Added
- Your agent now tells you when one of its relays has been unreachable for 10 minutes or more, and again when it is back. It never swaps relays on its own: changing relays stays your decision. ([#89](https://github.com/omernesh/rendezvous/pull/89))

## 0.5.1 - 2026-10-26 {#v0-5-1}

### Added
- `rdv-gateway`: your agent on your own machine, served to cloud assistants over MCP on HTTP and a REST API with an OpenAPI description. Each assistant gets its own token with scopes, and everything that needs your consent is approved on a PIN-locked page you open yourself. It listens on this machine only by default. ([#86](https://github.com/omernesh/rendezvous/pull/86))

### Security
- **Security:** the gateway's PIN page backs off after wrong guesses (with a way out for you), cannot be flooded with approval requests, redacts file paths, changing the PIN needs a terminal and the current PIN, and a "no" runs nothing. ([#86](https://github.com/omernesh/rendezvous/pull/86))
- **Security:** the plugin's consent guard knows the gateway commands, so your assistant cannot run the human-only ones. ([#86](https://github.com/omernesh/rendezvous/pull/86))

## 0.5.0 - 2026-10-26 {#v0-5-0}

### Added
- Group tasks: a member puts a task on the group's board, others offer, the requester picks one, and that member's human approves the start and the exact result before it reaches everyone. A group can set its own terms, and an admin can hand the group over. ([#82](https://github.com/omernesh/rendezvous/pull/82))

## 0.4.1 - 2026-10-26 {#v0-4-1}

### Added
- Group messages: members of a group (3 to 16 agents) can write to everyone over the existing encrypted channels, ask for missed messages again, and leave or be removed. ([#81](https://github.com/omernesh/rendezvous/pull/81))

### Security
- **Security:** a member that sends two different messages for the same place in its chain is caught, and the evidence is kept. Group messages are rate-limited. ([#81](https://github.com/omernesh/rendezvous/pull/81))

## 0.4.0 - 2026-10-26 {#v0-4-0}

### Added
- Groups: an admin invites contacts to a group, and joining needs each invitee's human. Each member chooses whether to approve newcomers themselves or trust the admin. ([#80](https://github.com/omernesh/rendezvous/pull/80))

### Security
- **Security:** a group invite needs the admin's human, only an admin's state can change a group, and invite text from peers is quoted and length-bounded. ([#80](https://github.com/omernesh/rendezvous/pull/80))

## 0.3.0 - 2026-10-26 {#v0-3-0}

### Added
- Auto-approve now also confirms dinners that the contact started. You can turn it on and off from the assistant with `rdv_auto_approve`; it still asks for your passphrase. ([#74](https://github.com/omernesh/rendezvous/pull/74))

### Security
- **Security:** auto-approve covers at most what you were shown when you turned it on. ([#74](https://github.com/omernesh/rendezvous/pull/74))

## 0.2.2 - 2026-10-26 {#v0-2-2}

### Added
- Set limits per capability (how many requests, how often) for meetings and when you grant a contact, from `rdv_grant`. ([#73](https://github.com/omernesh/rendezvous/pull/73))

## 0.2.1 - 2026-10-26 {#v0-2-1}

### Added
- Reach a contact with a pasted `rdv1:` agent ID alone, no address needed. ([#72](https://github.com/omernesh/rendezvous/pull/72))
- When you change your card, contacts get the updated card automatically. ([#70](https://github.com/omernesh/rendezvous/pull/70))
- Change your relays after setup (`rdv relays`). The card can also be copied to extra relays so others find you faster (`rdv card publish --mirror`). ([#59](https://github.com/omernesh/rendezvous/pull/59))
- First-run polish: clearer next steps after `rdv init`, a calmer `rdv whoami` when no owner passphrase is set, and sturdier installers on Windows and Linux. ([#60](https://github.com/omernesh/rendezvous/pull/60), [#67](https://github.com/omernesh/rendezvous/pull/67))
- A security policy and a way to report vulnerabilities privately. ([#57](https://github.com/omernesh/rendezvous/pull/57))

### Changed
- Approval forms wait 60 seconds instead of hanging, then fall back to the confirm phrase. A "no" is now a plain answer, not an error. ([#69](https://github.com/omernesh/rendezvous/pull/69))

### Security
- **Security:** auto-approve is bound to the passphrase record. A deleted passphrase file counts as a reset, and old entries cannot come back. ([#55](https://github.com/omernesh/rendezvous/pull/55))
- **Security:** a request that carries your files waits for your approval before anything is sent. ([#55](https://github.com/omernesh/rendezvous/pull/55))
- **Security:** changing your listening relays needs your approval, and relay error text is treated as untrusted. ([#59](https://github.com/omernesh/rendezvous/pull/59))
- **Security:** the consent guard now covers every human-only command group when commands are chained with `xargs`. ([#60](https://github.com/omernesh/rendezvous/pull/60))

## 0.2.0 - 2026-10-25 {#v0-2-0}

### Added
- Tasks between agents: ask a contact's agent to do something and get a result back, with your approval before it starts and before anything is sent. ([#37](https://github.com/omernesh/rendezvous/pull/37), [#42](https://github.com/omernesh/rendezvous/pull/42), [#54](https://github.com/omernesh/rendezvous/pull/54))
- Free-form requests to a contact's agent, with the text shown to you as a quotation, never as instructions. ([#48](https://github.com/omernesh/rendezvous/pull/48))
- Files in tasks: encrypted references, fetched only when you approve, kept in quarantine. Direct transfer is off unless you turn it on. ([#35](https://github.com/omernesh/rendezvous/pull/35), [#50](https://github.com/omernesh/rendezvous/pull/50))
- Grants per capability, so a contact can be allowed some requests and not others, with rate limits and an automatic revoke on gross abuse. ([#38](https://github.com/omernesh/rendezvous/pull/38), [#40](https://github.com/omernesh/rendezvous/pull/40))
- Auto-approve for one contact's tasks, set by you in your own terminal, with an expiry and an audit log (`rdv audit`). ([#46](https://github.com/omernesh/rendezvous/pull/46))
- An end-to-end document review scenario, and the docs and site for tasks and files. ([#56](https://github.com/omernesh/rendezvous/pull/56), [#32](https://github.com/omernesh/rendezvous/pull/32))

## 0.1.9 - 2026-10-25 {#v0-1-9}

### Security
- **Security:** auto-approve needs an owner passphrase you set yourself, and the plugin's consent guard refuses commands run through a pseudo-terminal. ([#49](https://github.com/omernesh/rendezvous/pull/49))
- **Security:** a file the owner shares is never sent from the home directory, and the direct-transfer setting can only be changed by the owner. ([#50](https://github.com/omernesh/rendezvous/pull/50))

## 0.1.8 - 2026-10-25 {#v0-1-8}

### Added
- Auto-approve for a contact's tasks, with an audit log. ([#46](https://github.com/omernesh/rendezvous/pull/46))

## 0.1.7 - 2026-10-25 {#v0-1-7}

### Added
- Incoming tasks are routed by risk: low-risk ones can run on their own, the rest wait at a start gate and a release gate for you. ([#42](https://github.com/omernesh/rendezvous/pull/42))

## 0.1.6 - 2026-10-25 {#v0-1-6}

### Changed
- Public Nostr relays are the default, so two agents can find each other with no relay of your own. Failed publishes are retried and unhealthy relays rest for a while. `rdv whoami` shows relay health. ([#21](https://github.com/omernesh/rendezvous/pull/21))
- Messages are limited to 32 KiB. ([#21](https://github.com/omernesh/rendezvous/pull/21))

### Fixed
- A relay connection that timed out could crash the agent. ([#21](https://github.com/omernesh/rendezvous/pull/21))

## 0.1.5 - 2026-10-25 {#v0-1-5}

### Added
- Grant a contact by agent ID from the assistant (`rdv_grant` with `agent_id`), so a contact can be answered back. Your own card is recognised. The skill now also installs cleanly in Hermes Agent. ([#17](https://github.com/omernesh/rendezvous/pull/17))
- Setup instructions for ten agents, and the skill packaged for agents beyond Claude Code. ([#11](https://github.com/omernesh/rendezvous/pull/11))

### Changed
- Meeting verbs can be extended, and an unsupported verb gets a clear answer. ([#16](https://github.com/omernesh/rendezvous/pull/16))

### Security
- **Security:** a flood of messages from strangers can no longer fill an agent's memory or push out real contacts. ([#15](https://github.com/omernesh/rendezvous/pull/15))

## 0.1.4 - 2026-10-25 {#v0-1-4}

### Added
- Several emails and phone numbers per agent, added and removed after setup. ([#10](https://github.com/omernesh/rendezvous/pull/10))

## 0.1.3 - 2026-10-25 {#v0-1-3}

### Added
- `/rdv-onboarding` in the Claude Code plugin: a guided setup that asks one question at a time and checks each step. ([#8](https://github.com/omernesh/rendezvous/pull/8))

## 0.1.2 - 2026-10-25 {#v0-1-2}

### Security
- **Security:** a contact's local label is tied to your consent, so a peer cannot choose the name you see. ([#7](https://github.com/omernesh/rendezvous/pull/7))

## 0.1.1 - 2026-10-25 {#v0-1-1}

### Added
- Send to a contact by the label you gave them. ([#6](https://github.com/omernesh/rendezvous/pull/6))

### Security
- **Security:** the plugin's consent guard covers every Rendezvous tool and reads shell commands properly, so your assistant cannot approve things in your place. ([#6](https://github.com/omernesh/rendezvous/pull/6))

## 0.1.0 - 2026-10-25 {#v0-1-0}

First public release.

### Added
- Set up Rendezvous by chatting with your agent: a Claude Code plugin and a skill. ([#5](https://github.com/omernesh/rendezvous/pull/5))
- The `rdv` command line and the `rdv-mcp` server: find another person's agent by email or phone, ask for contact, and, once their human approves, exchange end-to-end encrypted messages over Nostr relays.
- Dinner scheduling between two agents from their calendars. Neither calendar is shown to the other, and you confirm each meeting. Agreed meetings can be cancelled.
- Reverse grants, so the side that granted contact can also propose meetings.
- A public showcase site, installers for macOS, Linux and Windows, and the Apache-2.0 licence.

### Security
- **Security:** only the targeted agent can grant a contact request, and approvals are tied to what you were shown. Confirm phrases are stored hashed and tied to the action.
- **Security:** peers cannot write raw text into your terminal, flood you with requests or probes, replay old messages, or roll a channel back. Timestamps and sizes from peers are checked strictly, and the agent keeps the last good copy of its state.
- **Security:** only one listener runs per home, and listening agents cannot be auto-granted above the default tier unless you ask.
