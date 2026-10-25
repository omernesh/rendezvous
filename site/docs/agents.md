# Rendezvous with your agent

Rendezvous runs as a local MCP server, `rdv-mcp`, plus an optional skill that
teaches the agent the workflow. This page has one section per agent: how to
install, the MCP config, the skill, and how to check that it works.

Checked on 2026-10-25 against each client's own documentation (linked in every
section). Where a setup could not be run here, the section says so.

- [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Cursor](#cursor) · [VS Code (GitHub Copilot)](#vs-code-github-copilot) · [Codex CLI](#codex-cli) · [Gemini CLI](#gemini-cli) · [Windsurf](#windsurf) · [Grok Build](#grok-build) · [OpenClaw](#openclaw) · [Hermes Agent](#hermes-agent) · [Muse Code](#muse-code)

## Before you start

1. **Install Rendezvous** (Node.js 20+, git and npm; no sudo). Every section
   below starts from this:

   ```bash
   curl -fsSL https://rendezvous.nesher.co/install.sh | sh
   ```

   ```powershell
   irm https://rendezvous.nesher.co/install.ps1 | iex
   ```

   It builds into `~/.rendezvous/src` and puts `rdv` and `rdv-mcp` on your PATH.
   Run it again to update.

2. **Register `rdv-mcp`** with your agent (the config in its section), then
   restart the agent or reload its MCP servers.

3. **Windows: use the `node` form.** The installer writes `rdv-mcp.cmd`. A client
   that starts servers without a shell cannot run a `.cmd` file: a bare
   `rdv-mcp` fails with `ENOENT` (reproduced here with a no-shell spawn from
   Node 25; `cmd /c rdv-mcp` and a shell spawn both worked). Whether each client
   spawns through a shell was not tested, so on Windows give every client the
   built file directly. The path is the same in all sections:

   ```text
   C:\Users\<you>\.rendezvous\src\impl\packages\mcp\dist\src\bin.js
   ```

   In JSON write the backslashes doubled (`C:\\Users\\<you>\\...`). In TOML use
   a single-quoted string (`'C:\Users\<you>\...'`). Each section shows the
   macOS / Linux form and what changes on Windows. If you set `RDV_DIR`, use
   `<RDV_DIR>\impl\packages\mcp\dist\src\bin.js`. Options such as
   `--profile omer` go after the path in `args`.

4. **Verify** by asking the agent: **"What's my rendezvous status?"** It should
   call `rdv_status` and show your agent ID, your addresses and your relays. If
   it says there is no agent yet, create one (ask it, with the skill installed, or
   run `rdv init --profile omer --email omer@example.com` yourself) and ask
   again. Without `--relay` the agent uses the default public relays
   (`wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.nostr.net`,
   `wss://nostr.oxtr.dev`); add `--relay wss://…` once per relay to use your
   own instead. `rdv whoami` shows each relay's last OK and last error.

## Consent: approvals come back to you

The agent cannot approve a contact request, confirm a probe answer or confirm a
meeting. `rdv_grant` and `rdv_negotiate` succeed only when the human decides:

- **Clients with MCP elicitation** show you an approval form (the requester's
  fingerprint, how the request arrived, the greeting marked untrusted, a tier
  and a label). The model never sees the form.
- **Clients without elicitation**: the human types the confirm phrase shown by
  `rdv contact pending` in their own terminal to the agent. The agent passes it as
  `confirm_phrase`. Phrases are single-use and no tool result ever contains one.
- Or approve in your own terminal with `rdv contact grant`.

Tasks (asking a contact's agent for something, with files) work in every MCP
client, because `rdv_task` and `rdv_file` are ordinary tools. A client without
elicitation approves a task's start and its release with a phrase from `rdv task list`
or with `rdv task approve` / `rdv task release` in your own terminal. See
[Tasks and files](https://rendezvous.nesher.co/docs/tasks.md).

Elicitation support, as far as it could be checked:

| Agent | Elicitation | Source |
|---|---|---|
| Claude Code | yes (interactive sessions, not `-p`) | `impl/packages/mcp/README.md` |
| Cursor | yes, verified: the MCP docs list elicitation as "Supported" | [Cursor MCP docs](https://cursor.com/docs/mcp) |
| Hermes Agent | yes, form mode, through its normal approval surface (on by default) | [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) |
| Claude Desktop, VS Code, Codex CLI, Gemini CLI, Windsurf, Grok Build, OpenClaw, Muse Code | not confirmed in their docs | treat as no: use the confirm phrase |

The plugin's consent guard (a hook that refuses the consent commands) exists
only in Claude Code. Elsewhere the consent gate is the boundary, and the skill's
rules tell the agent never to run those commands itself. Details and the threat
model: [`impl/packages/mcp/README.md`](https://rendezvous.nesher.co/docs/mcp.md#consent-the-human-decides-demo-critical).

## Claude Code

- **MCP + skill, one step:** the plugin registers `rdv-mcp` and adds the skill.
  In Claude Code's chat:

  ```text
  /plugin marketplace add omernesh/rendezvous
  /plugin install rendezvous@rendezvous
  /reload-plugins
  ```

  Then type `/rdv-onboarding` (or `/rendezvous:rdv-onboarding`). It points you to
  the installer for `rdv` and sets you up one question at a time. The plugin starts the
  server through `bin/rdv-mcp.mjs` under `node`, so Windows needs nothing special.
- **Without the plugin:** `claude mcp add rendezvous -- rdv-mcp` (Windows:
  `claude mcp add rendezvous -- cmd /c rdv-mcp`).
- **Verify:** ask "What's my rendezvous status?".
- **Consent:** approval forms (elicitation) in an interactive session.
- Docs: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [plugins](https://code.claude.com/docs/en/plugins).

## Claude Desktop

- **Install:** the installer above.
- **MCP config:** `~/Library/Application Support/Claude/claude_desktop_config.json`
  (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows); in the app,
  Settings, Developer, Edit Config. Restart Claude Desktop completely after saving.

  ```json
  { "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
  ```

  Windows:
  `{ "mcpServers": { "rendezvous": { "command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"] } } }`
- **Skill:** none to install here; the MCP tools carry their own instructions.
  Claude Desktop's own skill upload is not covered by this page.
- **Verify:** ask "What's my rendezvous status?". Logs: `~/Library/Logs/Claude`
  or `%APPDATA%\Claude\logs` (`mcp-server-rendezvous.log`).
- **Consent:** elicitation not confirmed; use the confirm phrase.
- Docs: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Cursor

- **Install:** the installer above.
- **MCP config:** `~/.cursor/mcp.json` (everywhere) or `.cursor/mcp.json` (one project).

  ```json
  { "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
  ```

  Windows: `"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.
- **Skill:** `npx skills add omernesh/rendezvous` (the skills CLI lets you pick
  Cursor). Optional: the MCP server works without it.
- **Verify:** Settings, MCP: `rendezvous` should show its tools. Ask "What's my
  rendezvous status?" in the agent chat.
- **Consent:** elicitation supported (verified): you get the approval form.
- Docs: [Cursor MCP](https://cursor.com/docs/mcp).

## VS Code (GitHub Copilot)

- **Install:** the installer above.
- **MCP config:** `.vscode/mcp.json` in a workspace, or your user `mcp.json`
  (Command Palette, "MCP: Open User Configuration"). VS Code's key is `servers`,
  not `mcpServers`.

  ```json
  { "servers": { "rendezvous": { "type": "stdio", "command": "rdv-mcp" } } }
  ```

  Windows: `"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.
  VS Code's current docs also describe a global Copilot config
  (`~/.copilot/mcp-config.json`); the workspace file above is the one checked
  here.
- **Skill:** `npx skills add omernesh/rendezvous` and pick the agent; not tested
  per client. The MCP server works without it.
- **Verify:** start the server from the MCP view, open Copilot chat in Agent
  mode and ask "What's my rendezvous status?".
- **Consent:** elicitation is not mentioned in VS Code's MCP docs; use the
  confirm phrase unless a form appears.
- Docs: [MCP servers in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

## Codex CLI

- **Install:** the installer above.
- **MCP config:** one command, run here to confirm the output:

  ```bash
  codex mcp add rendezvous -- rdv-mcp
  ```

  or `~/.codex/config.toml`:

  ```toml
  [mcp_servers.rendezvous]
  command = "rdv-mcp"
  ```

  Windows: `codex mcp add rendezvous -- node C:\Users\<you>\.rendezvous\src\impl\packages\mcp\dist\src\bin.js`
  writes `command = "node"` and a single-quoted `args` path (tested here).
- **Skill:** `npx skills add omernesh/rendezvous` and pick Codex (installs under
  `~/.codex/skills`); not run per client.
- **Verify:** `codex mcp list`, then ask "What's my rendezvous status?".
- **Consent:** elicitation not mentioned in Codex's MCP docs; use the confirm phrase.
- Docs: [Codex MCP](https://developers.openai.com/codex/mcp).

## Gemini CLI

- **Install:** the installer above.
- **MCP config:**

  ```bash
  gemini mcp add -s user rendezvous rdv-mcp
  ```

  or edit `~/.gemini/settings.json` (`.gemini/settings.json` for one project):

  ```json
  { "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
  ```

  Windows: `gemini mcp add -s user rendezvous node C:\Users\<you>\.rendezvous\src\impl\packages\mcp\dist\src\bin.js`.
  Gemini CLI was not installed here, so the command is from its docs, not run.
- **Skill:** `npx skills add omernesh/rendezvous` and pick Gemini CLI; not run.
- **Verify:** `gemini mcp list`, or `/mcp` in a session, then ask "What's my
  rendezvous status?".
- **Consent:** elicitation not mentioned in its docs; use the confirm phrase.
- Docs: [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/).

## Windsurf

- **Install:** the installer above.
- **MCP config:** `~/.config/devin/mcp_config.json` (macOS / Linux;
  `$XDG_CONFIG_HOME/devin/` if set) or `%APPDATA%\devin\mcp_config.json`
  (Windows). Windsurf's docs now live under Devin's.

  ```json
  { "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
  ```

  Windows: `"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.
- **Skill:** `npx skills add omernesh/rendezvous` and pick the agent; not run.
- **Verify:** refresh the MCP list in Cascade, then ask "What's my rendezvous status?".
- **Consent:** elicitation not mentioned; use the confirm phrase.
- Docs: [Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp).

## Grok Build

- **Install:** the installer above.
- **MCP config:**

  ```bash
  grok mcp add rendezvous -- rdv-mcp
  ```

  or `~/.grok/config.toml`:

  ```toml
  [mcp_servers.rendezvous]
  command = "rdv-mcp"
  ```

  Windows: `grok mcp add rendezvous -- node C:\Users\<you>\.rendezvous\src\impl\packages\mcp\dist\src\bin.js`.
  `--scope project` writes `.grok/config.toml` instead. Not installed here;
  from the docs.
- **Skill:** `npx skills add omernesh/rendezvous` and pick Grok; not run.
- **Verify:** `grok mcp doctor` (stderr logs: `~/.grok/logs/mcp/rendezvous.stderr.log`),
  then ask "What's my rendezvous status?".
- **Consent:** elicitation not mentioned; use the confirm phrase.
- Docs: [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers).

## OpenClaw

- **Install:** the installer above.
- **MCP config:**

  ```bash
  openclaw mcp set rendezvous '{"command":"rdv-mcp"}'
  openclaw mcp doctor rendezvous --probe
  ```

  `--probe` opens a live connection to the server (without it `doctor` only
  checks the config); `openclaw mcp probe rendezvous` is the same check on its
  own. Windows: use `'{"command":"node","args":["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]}'`
  (quote it for your shell). Not installed here; from the docs.
- **Skill:** OpenClaw installs a git skill only when `SKILL.md` is at the
  repository root of the ref; there is no subpath syntax. So this repo publishes
  a `skill` branch whose root is the skill folder (`SKILL.md` and `references/`):

  ```bash
  openclaw skills install git:omernesh/rendezvous@skill
  ```

  Git skills are not updated by `openclaw skills update`: install again to
  refresh. Maintainers rebuild the branch with `scripts/publish-skill-branch.sh`
  (or `.ps1`); see [Maintainers](#maintainers-the-skill-branch).
- **Verify:** `openclaw mcp doctor rendezvous --probe`, then ask "What's my
  rendezvous status?".
- **Consent:** elicitation not mentioned; use the confirm phrase.
- Docs: [openclaw skills](https://docs.openclaw.ai/cli/skills), [openclaw mcp](https://docs.openclaw.ai/cli/mcp/registry).

## Hermes Agent

- **Install:** the installer above.
- **MCP config:** `~/.hermes/config.yaml`, then `/reload-mcp` in a session.

  ```yaml
  mcp_servers:
    rendezvous:
      command: "rdv-mcp"
  ```

  Windows: `command: "node"` and `args: ['C:\Users\<you>\.rendezvous\src\impl\packages\mcp\dist\src\bin.js']`.
  Hermes passes a stdio server only a safe baseline environment, not your shell's;
  `rdv-mcp` needs only `HOME` / `USERPROFILE`, but set `env:` if you use `RDV_HOME`.
- **Skill:** installs straight from this repository's path (run here):

  ```bash
  hermes skills install omernesh/rendezvous/plugins/rendezvous/skills/rendezvous
  ```

  Hermes scans community skills before installing them; this one passes the scan
  (`SAFE`) and installs as is. The skill carries no download-and-run
  line: it sends you to the Install section of https://rendezvous.nesher.co to
  run the installer yourself. Add `--yes` to skip the prompt.
  The installed files are `SKILL.md` and `references/`, under `~/.hermes/skills/rendezvous`.
- **Verify:** `/reload-mcp`, then ask "What's my rendezvous status?".
- **Consent:** elicitation supported (form mode, Hermes' normal approval
  surface; YOLO mode does not auto-answer it).
- Docs: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [creating skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills).

## Muse Code

- **Install:** the installer above.
- **MCP config:** `~/.config/muse/settings.json`. Keep what is already in the
  file and add the server.

  ```json
  {
    "schema_version": 1,
    "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } }
  }
  ```

  Windows: `"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.
  **Not verified:** Muse Code was not available here and no first-party
  documentation could be found. Some third-party guides write the key as
  `mcp_servers`, and one reports a beta build without MCP. If `mcpServers` does
  not load, check Muse Code's own docs for the current key.
- **Skill:** Muse Code reads skills from `~/.agents/skills`, `~/.claude/skills`
  and `~/.codex/skills`. Install into one of them, for example
  `npx skills add omernesh/rendezvous --skill rendezvous --global --agent claude-code`
  (puts it in `~/.claude/skills`), or copy the folder
  `plugins/rendezvous/skills/rendezvous` to `~/.agents/skills/rendezvous`. Not run here.
- **Verify:** ask "What's my rendezvous status?".
- **Consent:** elicitation unknown; use the confirm phrase.

## Maintainers: the skill branch

The skill lives once, in `plugins/rendezvous/skills/rendezvous`. The `skill`
branch is generated from it (`git subtree split`), never edited by hand, so the
text cannot drift. There is no CI: after changing the skill, run

```bash
sh scripts/publish-skill-branch.sh      # PowerShell: scripts/publish-skill-branch.ps1
```

from a clean checkout of `main`. It force-pushes `skill`, which holds nothing
else. `npx skills add omernesh/rendezvous` is unaffected: it reads the default
branch, where the skills are still found in the plugin folder.
