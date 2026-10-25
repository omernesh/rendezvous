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
- `hooks/hooks.json`: a consent guard. It stops Claude from running the `rdv`
  commands that grant consent or print confirm phrases (`rdv contact grant`,
  `rdv dinner confirm`, text-mode `rdv contact pending`, …) and from reading
  the agent's secret key. Those stay with you, in your own terminal. It is a
  tripwire, not a sandbox: see "Threat model" in
  [`impl/packages/mcp/README.md`](../../impl/packages/mcp/README.md).

Approving a contact: Claude calls `rdv_grant`, and Claude Code shows you an
approval form (MCP elicitation). Claude can't fill it in for you.
