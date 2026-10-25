# Connecting rdv-mcp to an MCP client

The Claude Code plugin registers the server for you
(`/plugin marketplace add omernesh/rendezvous`, then
`/plugin install rendezvous@rendezvous`, then `/reload-plugins`).

Anywhere else, register `rdv-mcp` as a stdio server. `rdv-mcp` is on PATH
after the installer. On Windows it is a `.cmd` shim: use
`"command": "cmd", "args": ["/c", "rdv-mcp"]`, or run the built file with node:
`"command": "node", "args": ["C:\\Users\\<you>\\.rendezvous\\src\\impl\\packages\\mcp\\dist\\src\\bin.js"]`.

Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "rendezvous": { "command": "rdv-mcp", "args": [] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.rendezvous]
command = "rdv-mcp"
args = []
```

Options go in `args`: `--profile <name>` or `--home <dir>` (default
`~/.rendezvous/default`), `--calendar cal.json --window "next week evenings" --tz +02:00`
for dinner negotiation. After editing the config, restart the client or
reconnect the server. Full reference: `impl/packages/mcp/README.md` in the
repository.

Approval forms need a client that supports MCP elicitation (Claude Code in an
interactive session does). Without it, approvals go through the confirm phrase
the human reads in their own terminal (`rdv contact pending`).
