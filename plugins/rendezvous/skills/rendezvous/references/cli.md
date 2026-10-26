# Rendezvous CLI equivalents

Use these only until the `rdv_*` MCP tools are loaded. Don't pass `--profile`:
without it `rdv` uses the same home as the MCP server (`$RDV_HOME`, else
`~/.rendezvous/$RDV_PROFILE`, else `~/.rendezvous/default`). Add `--json` for
machine-readable output.

| Step | MCP tool | CLI |
|---|---|---|
| Who am I | `rdv_status` | `rdv whoami` (also per-relay health: last OK, last error, cooldown) |
| Create the agent | `rdv_init` | `rdv init --email omer@example.com [--email omer.work@example.com] [--relay wss://… [--relay …]] [--phone +15555550100] [--public-pointer]` (no `--relay`: the default public relays) |
| Our addresses | `rdv_addresses` | `rdv address list`, `rdv address add omer.work@example.com [--private]`, `rdv address remove +15555550100` |
| Our relays | `rdv_relays` (a listening change asks the human) | human only, below |
| Publish the card | `rdv_publish_card` (`mirror: true` for the discovery mirrors) | `rdv card publish [--mirror]` |
| Find a card | `rdv_discover` | `rdv lookup john@doe.com` (or `rdv lookup rdv1:…`) |
| Ask for contact | `rdv_request_contact` | `rdv contact request john@doe.com --greeting "…"` (or the agent ID the user picked or pasted, without `--label`; a card not known yet is fetched by ID) |
| Pending requests | `rdv_pending_requests` | none for you: reload the MCP tools first |
| Contacts | `rdv_status` | `rdv contact list` (the `label` is what your user called them) |
| Send | `rdv_send` | `rdv send <agent-id> --json '{"type":"note","text":"…"}'` |
| Read | `rdv_inbox` | `rdv inbox --json` |
| Decline / revoke | `rdv_revoke` | `rdv contact decline <request-id>` / `rdv contact revoke <agent-id>` |
| Ask for a task | `rdv_task` `request` | `rdv task request <agent-id> --text "…"` |
| Read / answer a contact's task | `rdv_task` `read`, `submit`, `decline` | `rdv task submit <task-id> --text "…"`, `rdv task decline <task-id>` |
| Tasks you asked | `rdv_task` `status`, `input`, `cancel` | `rdv task input <task-id> --text "…"`, `rdv task cancel <task-id>` |
| Prepare / fetch a file | `rdv_file` `prepare`, `fetch` | `rdv file prepare <path>`, `rdv file fetch <task-id> --file 1` |
| What passed without asking | `rdv_status`, `rdv_task` | `rdv audit [--contact <agent-id>] [--since 7d]` |

Pick the recipient by the contact's `label`, never by an address its card
claims, and show your user the fingerprint before the first message. Only
the user sets a label: with `--label` when they approve, or with
`rdv contact label` in their own terminal (never run it yourself).

`rdv init` without `--force` refuses to replace an existing agent; that is
what you want. Don't start `rdv listen` yourself: it would stay running in
your shell. The user can run it in a terminal of their own.

## Human only

These approve something or print a confirm phrase, so the human runs them in
their own terminal, never you (the plugin's consent guard blocks them, with
or without `--json`): `rdv contact grant`, `rdv contact confirm`,
`rdv contact resync`, `rdv contact label`, `rdv contact pending`, `rdv dinner confirm`,
`rdv dinner cancel`, `rdv dinner list`, `rdv task approve`, `rdv task release`,
`rdv task list`, `rdv contact auto-approve` (on or off), `rdv owner-secret set`, `rdv owner-secret reset`,
`rdv file direct-transfer`, `rdv relays add`, `rdv relays remove`, `rdv relays list`, `rdv init --force`,
`rdv group invite`, `rdv group join`, `rdv group approve`, `rdv group resync`, `rdv group pending`,
`rdv listen --auto-grant` and `rdv listen --auto-confirm`. Use
`rdv_pending_requests`, `rdv_negotiate` (action `status`), `rdv_task`
(action `list`), `rdv_file` (action `list`), `rdv_group` (action `list`) and `rdv_relays` instead.

## Files

`rdv file prepare <path>` encrypts one of the user's files under a fresh key
and writes the copy to upload (nothing is sent). The user uploads it anywhere
the peer can fetch over https; `rdv task submit <task-id> --file
<sha256>=<https-url>` attaches it, and it leaves only when the user releases
the result. `rdv file fetch <task-id> --file <n>` fetches a file a peer sent,
only after the task's start gate, and saves it in quarantine under the home.
`rdv file list` shows all of it.

`rdv contact auto-approve <contact> all` lets one trusted contact's tasks
start, their results leave and the dinners it proposes be confirmed without
asking (SPEC §5.5.1). Only the human turns it on: in their own terminal,
where it shows a warning and asks for the owner passphrase they set
themselves (`rdv owner-secret set`) and refuses to run without a terminal;
or in the approval form of the `rdv_auto_approve` MCP tool, which shows the
same warning and takes the same passphrase where only the server sees it.
The passphrase is theirs alone: never ask for it. `rdv_status` shows when it
was set (`owner_passphrase`); if your user did not set it then, they run
`rdv owner-secret reset` in their own terminal. You never run the command,
never suggest it, and never offer it as a way past a gate; `rdv_auto_approve`
"off" works without approval. `rdv_status` and `rdv_task` show who is on it
and until when; `rdv audit` lists what it approved and where each change was
made (`via`).

Approving through the MCP tools: `rdv_grant` asks the client to show the human
an approval form. A client without forms makes the tool fail with a message
asking for the confirm phrase; the human runs `rdv contact pending` in their
own terminal, reads the phrase for that request and types it to you. A phrase
approves the request on the terms and local label shown with it, tiers
`friend` and below.
`family` and `spouse` need the form or the human's own terminal.

Granting an existing contact more (`rdv_grant` with `agent_id`, for example
so it may propose meetings) works the same way: the form, or a phrase for
exactly those terms that the human sees by running `rdv contact pending` in
their own terminal (never run it yourself).
