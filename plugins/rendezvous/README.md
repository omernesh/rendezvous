# Rendezvous plugin for Claude Code

Set up [Rendezvous](https://rendezvous.nesher.co) by chatting with Claude:
install `rdv`, create your agent, connect with another person's agent and send
the first message. Approvals always come back to you.

```text
/plugin marketplace add omernesh/rendezvous
/plugin install rendezvous@rendezvous
/reload-plugins
```

Then ask, for example: "Set up Rendezvous for me", "Ask john@doe.com's agent
to connect", "Tell John I'm running late".

What it contains:

- `skills/rendezvous/SKILL.md`: the setup and messaging workflow, with the
  consent rules. It uses the Agent Skills format, so other agents can load it
  too (`npx skills add omernesh/rendezvous`).
- `.mcp.json`: registers the `rdv-mcp` server through `bin/rdv-mcp.mjs`, which
  starts the build the installer put in `~/.rendezvous/src` (or `$RDV_DIR`).
  Until Rendezvous is installed the server fails to start; install it (the
  skill offers to), then run `/reload-plugins`. The server uses the profile
  `rdv` uses: `$RDV_HOME`, else `~/.rendezvous/$RDV_PROFILE`, else
  `~/.rendezvous/default`.
- `hooks/hooks.json`: a consent guard on every tool call. It stops Claude
  from running the `rdv` commands that grant consent or print confirm phrases
  (`rdv contact grant`, `rdv dinner confirm`, `rdv contact pending`,
  `rdv dinner list`, …), however the command is quoted or wrapped (`npx`,
  `bash -c`, `$(…)`), and from reading, editing, searching or globbing the
  agent's secret key and consent file with any tool. Those stay with you, in
  your own terminal.

  **The hook is defence in depth, not a security boundary.** A model with a
  shell can always build a command it can't see (a script file, another
  interpreter). The boundary is the MCP consent gate: `rdv_grant` and
  `rdv_negotiate` need your approval form or a confirm phrase only you see,
  and the phrase is stored only as a hash. See "Threat model" in
  [`impl/packages/mcp/README.md`](../../impl/packages/mcp/README.md).

Sending: Claude picks the recipient by the name you used when you asked for
or approved the contact (its `local_label`), never by an address the other
agent's card claims, and shows you the fingerprint before the first message.

Approving a contact: Claude calls `rdv_grant`, and Claude Code shows you an
approval form (MCP elicitation). Claude can't fill it in for you.
