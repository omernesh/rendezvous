# @rendezvous/mcp

`rdv-mcp`: a stdio MCP server that gives an MCP client (Claude Code, Claude
Desktop, the MCP Inspector) a Rendezvous agent. PLAN.md §6.1, SPEC.md §13.

The server runs one long-lived listening agent in-process. Its state is the
same home dir as the `rdv` CLI (`agent.json`, `config.json`, `inbox.jsonl`,
`negotiations.json`, `lock`, plus `consent.json`, `events.jsonl` and
`listener.lock`), and it takes the lock only per operation, like `rdv listen`.
So `rdv contact pending` or `rdv contact grant` can run in a terminal against
the same profile while the server is up. Only one process per home consumes
inbound events (whoever holds `listener.lock`); if `rdv listen` or another
`rdv-mcp` already does, this server runs attached: its tools work, and
`rdv_inbox` reads the events the consumer writes to `events.jsonl`. It takes
over when the consumer exits. `rdv_status` says which (`inbound`: `consumer`
or `attached`). See impl/README.md.

```bash
npm run build                              # from impl/
node packages/mcp/dist/src/bin.js --home ~/.rendezvous/omer --calendar cal.json --tz +02:00
```

Options: `--home <dir>` or `--profile <name>` (same resolution as `rdv`:
`--home`, `$RDV_HOME`, `~/.rendezvous/<profile>`), `--calendar <file.json>`,
`--calendar-dir <dir>` (repeatable, env `RDV_CALENDAR_DIR`: where the assistant
may pick other calendar files from),
`--window "next week evenings"`, `--tz +02:00` (env `RDV_CALENDAR`,
`RDV_WINDOW`, `RDV_TZ`). Without a calendar, incoming dinner proposals are
listed but not answered. stdout carries MCP; human-facing notices go to stderr.
Client config examples: [`impl/demo/SCRIPT.md`](../../demo/SCRIPT.md).

## Tools

| Tool | Input | Output |
|---|---|---|
| `rdv_init` | profile, email, phone, relays, public_pointer, calendar, window, tz | agent ID, fingerprint; keeps an existing agent (re-key only with `rdv init --force`) |
| `rdv_status` | — | ID, relays, contacts, pending count, negotiation settings, approval mode |
| `rdv_publish_card` | — | topics published |
| `rdv_discover` | address | cards found (agent ID, fingerprint, claimed addresses, relays) |
| `rdv_request_contact` | target (email, +phone, or agent ID), greeting | request ID |
| `rdv_pending_requests` | — | requests with fingerprint, binding, how they arrived, untrusted greeting |
| `rdv_grant` | request_id, tier, may_propose_meetings, confirm_phrase; or grant_id (+ confirm_phrase) to confirm a probe answer | contact (needs the human, below) |
| `rdv_revoke` | agent_id, or request_id / grant_id (+ block) to decline | revoked / declined / rejected |
| `rdv_send` | agent_id, payload `{type, …}` (not `a2a/*`, `rdv/*`) | envelope seq |
| `rdv_inbox` | since cursor, limit, wait_seconds (≤ 60) | events + next_cursor |
| `rdv_negotiate` | action propose / confirm / cancel / status; agent_id, intent `dinner`, window, calendar, tz, minutes, place, area, expires, task_id, reason, confirm_phrase | task ID and state; progress via `rdv_inbox`; `confirm` needs the human (below) |

Resource `rdv://inbox` holds the latest 50 events; the server supports
`resources/subscribe` and sends `notifications/resources/updated` when events
arrive, so a client that subscribes needn't poll.

Events: `contact_request`, `contact_candidate` (an answer to our discovery
probe, confirmed through the same human gate as a grant), `contact`, `message`, `revoked`, `dropped`, `error`,
and `dinner` (kind proposed / offer-received / countered / confirm-needed /
accepted / completed / released / rejected / canceled / expired / status, with
a plain-language `summary` we write from validated fields; `confirm-needed`
also carries a `next_step`).

Grants issued here always carry `may_initiate: true`,
`may_access_calendar: "free_busy"`, `max_frequency: "100/day"`, and
`may_propose_meetings` (default true). The calendar adapter only ever shares
free slots, never titles.

## Consent: the human decides (demo-critical)

`rdv_grant` must not succeed on the model's say-so. It succeeds only through
one of these:

1. **Elicitation.** If the client advertises the `elicitation` capability, the
   server asks the client to show the human a form: requester agent ID,
   fingerprint, binding (with a warning that `claimed` proves nothing), how the
   request arrived, the greeting marked untrusted, and a tier picker. Only
   `accept` with `approve: true` grants; the human's tier wins over the model's.
   The model never sees or answers this form.
2. **Confirm phrase.** Otherwise each pending request gets a random phrase
   (three words and three digits, about 28 bits), shown only on human
   channels: this server's stderr and `rdv contact pending` in text mode (not
   `--json`). `consent.json` (mode 600) keeps only a salted scrypt hash, so
   the terminal issues a new phrase each time it shows one (the latest shown
   wins). The human reads it and types it to the model, which passes it as
   `confirm_phrase`. A phrase approves the request on the terms shown with it
   (tier and scope, default first): if the model asks for another tier or
   `may_propose_meetings`, it is refused and the human is shown a new phrase
   for exactly those terms (issue #12). Phrases are per request and single
   use; 5 wrong tries replace the phrase. A phrase can approve tiers `friend`
   and below; `family`/`spouse` need the form or `rdv contact grant --tier …`
   in a terminal.
3. **The terminal.** The human runs `rdv contact grant <id>` themselves.

**Each meeting too (issue #8).** The server answers dinner proposals from the
calendar, but the slot it picks is only held tentatively ("confirm-needed")
until the human confirms it: `rdv_negotiate` with action `confirm` passes the
same gate. With elicitation the human gets a form (peer fingerprint, time,
place marked untrusted); `decline` there cancels the negotiation and
releases the hold, dismissing it leaves the dinner held. Otherwise the server
issues a confirm phrase per held dinner (same rules, shown on stderr and in
`rdv dinner list` text mode), or the human runs `rdv dinner confirm <task-id> --hold <code>`
(or `rdv dinner cancel`) in a terminal. That happens once per side: the
accepter's human before the accept goes out, the offerer's before the
`meeting/confirm`. Holds are released on cancel, decline or expiry.
Approval is bound to the meeting the human saw, not the peer-chosen task ID:
if the held meeting changes before the confirm runs (another slot, peer or
stage, or a new negotiation under the same ID), nothing is confirmed, the tool
says it changed, and a new phrase is issued (NOTES 59).

**Canceling an agreed dinner (issue #20).** `rdv_negotiate` action `cancel`
on a completed dinner passes the same gate, bound to the agreement shown
(NOTES 61): a form if the client can elicit (only an explicit yes cancels),
otherwise the first call issues a cancel phrase to the human (stderr and
`rdv dinner list`) and fails; the human can also run `rdv dinner cancel`.
The peer's agent frees the evening without asking (it only frees time) and
reports a `meeting-canceled` event.

No tool result ever contains a phrase (tests scan every result and the inbox
resource). Limits (NOTES 57): phrases are not on disk, but a model that can
read files or run commands as the same user can still catch one while it is
shown (or run `rdv contact pending` itself); there, prefer elicitation or the
terminal. Without a phrase or elicitation, `rdv_grant` fails and tells the
model to ask its human.

**Threat model.** This stops a model from granting on its own initiative, and
stops instructions injected through peer text from making it grant. It does
**not** stop a model that can run arbitrary shell commands or read arbitrary
files as the same OS user: such a model can catch a phrase while it is shown,
run `rdv contact grant` itself, or read `agent.json`, which holds the secret
key, a worse problem. In Claude Code,
keep the default permission mode (shell commands and reads outside the project
need approval) and add deny rules for the home dir and `rdv contact pending`
(example in `demo/SCRIPT.md`). The strongest setup runs `rdv-mcp` as a
different OS user, or on another machine, from the one the assistant's tools
run as. Revoking and declining need no confirmation: they only reduce access.

## Prompt injection gate

- Peer-written text (greetings, text parts, decline reasons, free-form message
  payloads, error and drop details) reaches the model only as
  `{"untrusted_peer_text": "…"}`, with control and bidi characters replaced and
  a 2000-character cap. Results that contain such fields start with a note
  telling the model to treat them as data. The server instructions and the
  tool descriptions say the same.
- Short peer-chosen fields are strict tokens or get quarantined the same way:
  agent IDs, UUIDs, addresses (email / +phone), relay URLs, tiers, bindings,
  task states, payload `type` (`[a-z0-9][a-z0-9._/-]{0,63}`), integer `seq`.
- Only `data` parts drive the negotiation engine (`@rendezvous/a2a`, strict
  validation); text parts are display only.
- The model can't make the server read local files: `rdv_request_contact`
  takes addresses and agent IDs (no card files), calendar paths must end in
  `.json` and resolve (symlinks included) inside the home, the `--calendar`
  directory or a `--calendar-dir`, the file must be a strict calendar
  (`busy` list, optional `timezone`, nothing else) before it is read or
  rewritten, and calendar errors never echo file contents.
- Errors that could quote peer or file content (inbound handling, fs and
  JSON parse failures) go to the server log for the human; the model gets a
  generic line. Only our own messages (bad input, negotiation rules) reach it.

## Tests

`npm test -w @rendezvous/mcp`: two servers (Omer, John) driven by the SDK's
`Client` over an in-memory MCP transport against the in-memory relay, covering
init → discover → request → refused grant → human approval (confirm phrase,
and elicitation accept / decline) → negotiate → refused model-only dinner
confirmation → each human confirms (phrase, form) → completed on both sides, plus

a stdio smoke test, phrase rules and hardening. Live:
`RDV_LIVE_RELAYS=ws://<relay-host>:7777 npm run test:live -w @rendezvous/mcp`.
