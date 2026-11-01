---
name: rdv-gateway-setup
description: Guided setup of the Rendezvous gateway, one question at a time, so cloud assistants (claude.ai, ChatGPT, Claude Code elsewhere) can use the user's agent. Gathers the non-secret answers in chat (which machine, Docker or Node.js, the folder, a new agent or a restore, the public address), hands the user one installer command to run in their own terminal, where they type the PIN and any secret, then checks it answers and gives the connector address for each assistant. Use when the user says "set up my gateway", "deploy the rendezvous gateway", "connect claude.ai to my agent", "connect chatgpt to my agent", or "use rendezvous from claude.ai".
license: Apache-2.0
---

# Set up the Rendezvous gateway

The gateway puts the user's agent behind an https address, so assistants
in the cloud can use it. It runs on a machine that stays on (a home server,
a NAS, a small VPS, or this computer), and listens only on `127.0.0.1`
there: a tunnel or the user's own proxy gives it the public address. The
installer does the work; your part is to ask the questions, build the one
command, and check the result.

## Rules for this flow

**The consent rules come first.** Before step 1, read the "Consent rules"
section of `${CLAUDE_PLUGIN_ROOT}/skills/rendezvous/SKILL.md`. They apply
here word for word.

**Secrets never pass through the chat.** The approval PIN, a backup's
passphrase and a Cloudflare tunnel token are typed by the user into the
installer, in their own terminal, with nothing shown. Never ask for them,
never accept them (if the user pastes one, tell them to replace it: a new
PIN, a new tunnel token from the dashboard), never put them in a command,
a file or a note. The installer has no flag for them on purpose.

**The owner commands are the human's.** Setting the PIN (`rdv-gateway pin
set`, or `./gw pin set`), restoring a backup (`rdv restore`), and making or
revoking tokens (`rdv-gateway token create`, `./gw token create`) happen
only in the user's own terminal: never run them yourself. The installer
runs the first two for the user, in their terminal, where they type the
answers. Never download or run the installer yourself: the user runs it.

**Ask ONE question per turn.** Never put two questions in one message. Use
the `AskUserQuestion` tool when it is available, with one question, a few
sensible options, and the recommended option first (marked
"(Recommended)"). Without it, ask a single plain question and end your
message there.

**Every step has the same shape**, in this order:

1. One line: what this step does and why.
2. At most one question, if the step needs an answer.
3. The action.
4. A verification, with its visible result.
5. "Step N of 8 done." Then start the next step.

If a check fails, say what failed, fix it or ask one question about it, and
check again before moving on. Never mark a step done on a failed check.

**Resume.** If the user already ran the installer, the folder has
`install.conf` and a `./gw` helper. On that machine, `./gw status` shows
whether it runs; skip to step 7. Running the installer again updates it and
keeps its answers.

## Step 1 of 8: which machine

Why: the gateway must stay on, or assistants cannot reach the agent.

Ask one question: run it on this computer, or on another machine they
reach over ssh (recommended when they have an always-on one)? On Windows,
it runs inside WSL 2 (the installer is for Linux and macOS). For another
machine, ask for the ssh login (`user@host`) in a turn of its own. Verify:
`uname -s` on that machine (over `ssh user@host uname -s` for the other
one) prints Linux or Darwin.

## Step 2 of 8: Docker or Node.js

Why: Docker runs the gateway in a locked-down container; Node.js runs it as
a service of the user's account.

Check what is there, read-only, on that machine: `docker compose version`,
`docker info --format '{{.ServerVersion}}'`, `node --version`, `git
--version`, `command -v tailscale`, `command -v cloudflared`. Show what is
ready and what is missing (git is needed either way; Node.js must be 20 or
newer; on macOS only Node.js works). Ask one question: Docker (recommended
on Linux) or Node.js? If neither is ready, say what to install, and wait.
Verify: the chosen runtime's check passes.

## Step 3 of 8: the folder

Why: the code, the agent's key and the settings live in one folder.

Ask one question: where should it go (default `~/rendezvous-gateway`; on a
Synology NAS `/volume1/rendezvous-gateway`, beside the shares, never inside
a share such as `/volume1/docker` or the DSM home, which the installer
refuses; only root can create it, so the user runs the installer with their
administrator rights there)? No spaces in the path. Verify: say the folder back; `repo/` will hold the
code, `data/` the agent.

## Step 4 of 8: the public address

Why: assistants in the cloud need an https address that reaches the
gateway.

Ask one question, with these options:

- **Cloudflare Tunnel on their own domain** (recommended; a free Cloudflare
  account and a domain on it). `--tunnel cloudflare-token`.
- **A quick try-out address** from Cloudflare: random, and it changes on
  every restart, so connected assistants break then.
  `--tunnel cloudflare-quick`.
- **Their own reverse proxy or domain**, already on that machine.
  `--tunnel own-url`.
- **Tailscale Funnel**, only if `tailscale` was found in step 2.
  `--tunnel tailscale`.

Then, one question per turn, only what the choice needs:

- Cloudflare Tunnel: explain that in the Cloudflare dashboard (Zero Trust,
  Networks, Tunnels, Create a tunnel, type Cloudflared) they create the
  tunnel and give it a public hostname whose service is HTTP,
  `127.0.0.1:8787`. They copy the token there, but paste it only into the
  installer when it asks, never here. Ask for the hostname, as an https
  address such as `https://gw.example.com` (`--public-url`). Mention
  turning Email Obfuscation off for that hostname.
- Own proxy: ask for its https address (`--public-url`), then, in a turn
  of its own, which header it sets to the real client address
  (`--client-ip-header`, nginx's `X-Real-IP` is the usual one). The proxy
  must forward to `http://127.0.0.1:8787` with buffering off.

Verify: the address starts with `https://` and has no path.

## Step 5 of 8: the agent

Why: the gateway serves one agent: a new one, or the user's own from a
backup.

Ask one question: a new agent (recommended for a first try, with a test
address) or restore one from its `.rdvbackup` file? Then, one per turn:

- New: the email (`--email`); "Add another email?" as a question of its
  own, repeated until the answer is no; whether to keep the default relays
  (`wss://relay.nesher.co` and four public ones) or name others
  (`--relay`, repeated); and whether it should be findable by email
  (`--public-pointer`, off by default: anyone who knows the address can then
  find the agent and ask for contact, and the user still approves each).
- Restore: where the backup file is on that machine (`--backup`). The
  installer shows the agent ID and fingerprint in the file and asks for the
  passphrase there. If the agent still runs on another computer, they stop
  it there first: one machine receives for an agent.

Verify: say back the answers (never a secret: there is none here).

## Step 6 of 8: run the installer

Why: the installer builds and starts everything, and asks the user for the
secrets in their own terminal.

Build the command from the answers, every one as a flag, and show it as
two lines, for the user to run in their own terminal on that machine (never
run them yourself; the consent guard refuses it): the first downloads the
installer, `curl -fsSLo install-gateway.sh https://rendezvous.nesher.co/install-gateway.sh`,
and the second runs it with the answers, for example
`sh install-gateway.sh --dir ~/rendezvous-gateway --runtime docker --tunnel cloudflare-token --public-url https://gw.example.com --agent new --email omer@example.com`.

For another machine, they run them inside `ssh -t user@host`. Not with Claude Code's `!`
prefix: it gives the installer no terminal to ask the PIN in. Say what it
will ask them, in order: the tunnel token (Cloudflare Tunnel only), the
backup passphrase (restore only), and the approval PIN twice: 6 or more
characters they use nowhere else, typed with nothing shown, and nothing else
pasted at that prompt. Ask one question: tell me when it has finished
(options "Done" and "It failed"). If it failed, ask them to paste only the
error line (it never contains a secret) and fix the flag it names.

Verify: the installer's last lines say "The Rendezvous gateway is running"
and print the MCP address.

## Step 7 of 8: check it

Why: an address that does not answer would fail in every assistant later.

Run, read-only: `curl -s https://gw.example.com/healthz` (with their
address) must print `{"ok":true}`, and `curl -s -o /dev/null -w '%{http_code}'
https://gw.example.com/mcp` must print `401` (the gateway wants a sign-in,
as it should). On that machine, `./gw status` in the folder shows it
running. If the address does not answer, look at `./gw logs tunnel` (or
their proxy) with them.

## Step 8 of 8: connect the assistants

Why: each assistant signs in once; the user approves it on the gateway's
own page with their PIN.

Give the MCP address (`<public address>/mcp`) and the steps for the
assistants they use:

- **claude.ai**: Settings, Connectors, Add custom connector; paste the
  address; leave the client ID and secret empty.
- **ChatGPT**: Settings, Connectors, Advanced: developer mode on; create a
  connector with the address, authentication OAuth.
- **Claude Code** on another computer: `claude mcp add --transport http
  rendezvous <address>/mcp`, then `/mcp` to sign in.
- **Others with a token** (Hermes, a Custom GPT, a script): the user makes
  one in their own terminal with `./gw token create --name <name> --scope
  read,send` in the folder (human only: never run it, and never ask for the
  token it prints); it is shown once.

Each sign-in opens the gateway's page: they unlock it with the PIN and
check the return address is `claude.ai` or `chatgpt.com` before they
approve, since anyone can register an app under any name. Then tell them:
`./gw update` updates it, `./gw logs` shows the log, `./gw stop` stops it,
`./gw uninstall` removes the service and keeps the agent in `data/`, and
`./gw backup <file>`, in their own terminal (never run it yourself), makes an
encrypted backup of the agent with a new passphrase they type there. The
full guide is
https://rendezvous.nesher.co/docs/gateway-deploy.html.
