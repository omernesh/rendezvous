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
turn: install, MCP tools, profile, email, optional phone, relays (each one
checked), public pointer, your agent, its card and an optional first contact,
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
  (`rdv contact grant`, `rdv dinner confirm`, `rdv contact pending`,
  `rdv dinner list`, …) or name a contact (`rdv contact label`, or
  `rdv contact request <agent-id> --label`), however the command is quoted or wrapped (`npx`,
  `bash -c`, `$(…)`), and from reading, editing, searching or globbing the
  agent's secret key and consent file with any tool. Those stay with you, in
  your own terminal.

  **The hook is defence in depth, not a security boundary.** A model with a
  shell can always build a command it can't see (a script file, another
  interpreter). The boundary is the MCP consent gate: `rdv_grant` and
  `rdv_negotiate` need your approval form or a confirm phrase only you see,
  and the phrase is stored only as a hash. See "Threat model" in
  [`impl/packages/mcp/README.md`](../../impl/packages/mcp/README.md).

Sending: Claude picks the recipient by its `local_label`, never by an address
the other agent's card claims, and shows you the fingerprint before the first
message. Only you set a label: it is part of what you approve (the form shows
it next to the fingerprint and you can change it; a confirm phrase approves
only the label it was shown with), or you name a contact yourself with
`rdv contact label <agent-id> <label>` in your own terminal. A card found by
address is only a claim, so it never labels a contact.

Approving a contact: Claude calls `rdv_grant`, and Claude Code shows you an
approval form (MCP elicitation). Claude can't fill it in for you.
