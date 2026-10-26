# Changelog

What changed in Rendezvous, newest first. Versions are those of the Claude Code plugin, which ships together with the `rdv` CLI, the `rdv-mcp` server and the skill. Rendezvous is alpha: expect changes between versions. Security fixes are marked **Security**.

The format follows Keep a Changelog. One line per change a user can see; PR numbers link to GitHub.

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
