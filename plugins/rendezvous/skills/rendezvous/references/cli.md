# Rendezvous CLI equivalents

Use these only until the `rdv_*` MCP tools are loaded. Don't pass `--profile`:
without it `rdv` uses the same home as the MCP server (`$RDV_HOME`, else
`~/.rendezvous/$RDV_PROFILE`, else `~/.rendezvous/default`). Add `--json` for
machine-readable output.

| Step | MCP tool | CLI |
|---|---|---|
| Who am I | `rdv_status` | `rdv whoami` |
| Create the agent | `rdv_init` | `rdv init --email omer@example.com --relay wss://relay.nesher.co [--phone +15555550100] [--public-pointer]` |
| Publish the card | `rdv_publish_card` | `rdv card publish` |
| Find a card | `rdv_discover` | `rdv lookup john@doe.com` |
| Ask for contact | `rdv_request_contact` | `rdv contact request john@doe.com --greeting "…"` (or the agent ID) |
| Pending requests | `rdv_pending_requests` | `rdv contact pending --json` (JSON mode shows no confirm phrases) |
| Contacts | `rdv_status` | `rdv contact list` |
| Send | `rdv_send` | `rdv send <agent-id> --json '{"type":"note","text":"…"}'` |
| Read | `rdv_inbox` | `rdv inbox --json` |
| Decline / revoke | `rdv_revoke` | `rdv contact decline <request-id>` / `rdv contact revoke <agent-id>` |

`rdv init` without `--force` refuses to replace an existing agent; that is
what you want. Don't start `rdv listen` yourself: it would stay running in
your shell. The user can run it in a terminal of their own.

## Human only

These approve something or print a confirm phrase, so the human runs them in
their own terminal, never you (the plugin's consent guard blocks them):
`rdv contact grant`, `rdv contact confirm`, `rdv contact resync`,
`rdv dinner confirm`, `rdv dinner cancel`, `rdv init --force`,
`rdv listen --auto-grant`, `rdv listen --auto-confirm`, and the text-mode
`rdv contact pending` and `rdv dinner list`.

Approving through the MCP tools: `rdv_grant` asks the client to show the human
an approval form. A client without forms makes the tool fail with a message
asking for the confirm phrase; the human runs `rdv contact pending` in their
own terminal, reads the phrase for that request and types it to you. A phrase
approves the request on the terms shown with it, tiers `friend` and below.
`family` and `spouse` need the form or the human's own terminal.
