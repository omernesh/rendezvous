# Connecting rdv-mcp to an MCP client

The Claude Code plugin registers the server for you
(`/plugin marketplace add omernesh/rendezvous`, then
`/plugin install rendezvous@rendezvous`, then `/reload-plugins`).

Per-agent setup (Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI,
Windsurf, Grok Build, OpenClaw, Hermes Agent, Muse Code), each with its config
file and a check that it works: the setup section of
https://rendezvous.nesher.co/#setup, and the per-agent guide in the
repository's docs folder (https://github.com/omernesh/rendezvous/tree/main/docs).

Anywhere else, register `rdv-mcp` as a stdio server. `rdv-mcp` is on PATH
after the installer. On Windows it is a `.cmd` shim: use
`"command": "cmd", "args": ["/c", "rdv-mcp"]`, or run the built file with node:
`"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.

Most clients (Claude Desktop, Cursor) take an `mcpServers` entry; the
per-agent guide names each client's config file:

```json
{ "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
```

Codex uses TOML in its own config file:

```toml
[mcp_servers.rendezvous]
command = "rdv-mcp"
args = []
```

Options go in `args`: `--profile <name>` or `--home <dir>` (default
`~/.rendezvous/default`), `--calendar cal.json --window "next week evenings" --tz +02:00`
for meeting negotiation (optional). After editing the config, restart the client or
reconnect the server. Full reference: `impl/packages/mcp/README.md` in the
repository.

Approval forms need a client that supports MCP elicitation (Claude Code in an
interactive session does). Without it, approvals go through the confirm phrase
the human reads in their own terminal (`rdv contact pending`).
