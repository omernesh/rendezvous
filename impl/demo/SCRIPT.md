# Demo script: two Claudes book dinner (PLAN §6.2)

Two Claude Code sessions, "Omer's Claude" and "John's Claude", each with the
Rendezvous MCP server (`rdv-mcp`) and its own home dir and calendar. They find
each other by email, John approves the contact, the agents negotiate a dinner
slot on their own, and the relay never sees anything but ciphertext.

Relays in both cards: `ws://<relay-host>:7777` (own strfry on relay-host, over
Tailscale), `wss://nos.lol`, `wss://relay.primal.net`.

## Setup (once, before recording)

Everything runs from `impl/`. Paths below use `D:/docker/rendezvous` on
Windows and `~/rendezvous` on Linux; adjust to your clone.

```bash
npm install && npm run build
node demo/make-calendars.mjs          # demo/calendars/omer.json + john.json for next week
```

`make-calendars.mjs` writes calendars relative to today: Omer is busy Monday
evening, John Monday and Tuesday. Expected result: **Wednesday 19:00–21:00
(+02:00)**. The event titles ("Choir rehearsal", "Board meeting dinner") are
private and must never appear on the other side. Re-run it before each take
(it also clears the holds from the previous run).

Create both agents from a terminal, so the demo starts at the interesting part
and nobody watches key generation (the `rdv_init` tool does the same if you
want it on camera). John publishes his card so Omer can discover it:

```bash
R="--relay ws://<relay-host>:7777 --relay wss://nos.lol --relay wss://relay.primal.net"
npm run rdv -- init --home ~/.rendezvous/demo-omer --profile omer --email omer@example.com $R
npm run rdv -- init --home ~/.rendezvous/demo-john --profile john --email john@doe.com --public-pointer $R
npm run rdv -- card publish --home ~/.rendezvous/demo-john
```

PowerShell: set `$R = @('--relay','ws://<relay-host>:7777','--relay','wss://nos.lol','--relay','wss://relay.primal.net')`
and pass `@R`; use `$HOME\.rendezvous\demo-omer`. Between takes, re-init with
`--force` (new keys) or contacts from the previous take carry over.

### Two Claude Code sessions

Use two project folders (or two machines), one per person, each with its own
`.mcp.json`. Omer's, Windows:

```json
{
  "mcpServers": {
    "rendezvous": {
      "command": "node",
      "args": [
        "D:/docker/rendezvous/impl/packages/mcp/dist/src/bin.js",
        "--home", "C:/Users/omer/.rendezvous/demo-omer",
        "--calendar", "D:/docker/rendezvous/impl/demo/calendars/omer.json",
        "--window", "next week evenings",
        "--tz", "+02:00"
      ]
    }
  }
}
```

John's, Linux:

```json
{
  "mcpServers": {
    "rendezvous": {
      "command": "node",
      "args": [
        "/home/john/rendezvous/impl/packages/mcp/dist/src/bin.js",
        "--home", "/home/john/.rendezvous/demo-john",
        "--calendar", "/home/john/rendezvous/impl/demo/calendars/john.json",
        "--window", "next week evenings",
        "--tz", "+02:00"
      ]
    }
  }
}
```

(On one machine, John's file is the same as Omer's with `john` paths.) Use
absolute paths: Claude Code may start the server in another directory.

**Keep the confirm phrase away from the model.** In each project, deny Claude
read access to the Rendezvous home and to the command that prints phrases, in
`.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(~/.rendezvous/**)", "Bash(rdv contact pending:*)", "Bash(npm run rdv:*)"]
  }
}
```

Don't record in a bypass-permissions mode: then Claude could run shell commands
against the home without asking (see `packages/mcp/README.md`, threat model).

Start each session (`claude` in its folder), run `/mcp` and check that
`rendezvous` is connected. Ask "What's my Rendezvous status?" once: the answer
(`rdv_status`) shows the agent ID, relays, calendar, and the approval mode
(`approval form` if this Claude Code supports MCP elicitation, else
`confirm phrase`).

John also needs a plain terminal next to his Claude window, for the consent beat:

```bash
npm run rdv -- contact pending --home ~/.rendezvous/demo-john
```

## The five beats

**1. Omer asks.** In Omer's session:

> Find John's agent (john@doe.com) and set up dinner with him next week.

Expected: `rdv_discover` finds John's card (agent ID, fingerprint), then
`rdv_request_contact`. Claude says the request is out and that John must
approve. (It may also wait with `rdv_inbox`.)

**2. John approves (consent beat).** In John's session:

> Anything new on Rendezvous?

Expected: `rdv_inbox` / `rdv_pending_requests` shows a contact request from
Omer's agent with its fingerprint and binding `claimed`; the greeting is marked
as untrusted text. John says "Yes, approve it." Then one of:

- *Approval form* (elicitation): Claude Code shows a form with the fingerprint,
  binding, how the request arrived and the greeting; John ticks "Approve".
- *Confirm phrase*: Claude replies that it can't approve by itself. John runs
  `rdv contact pending` in his terminal, reads the phrase (e.g.
  `heron-maple-quartz-417`), and types it to Claude. Claude calls `rdv_grant`
  with it.

Point to make on camera: the model could not have approved on its own; the
phrase never appeared in any tool output.

**3. The agents negotiate.** Back in Omer's session:

> John approved. Go ahead with the dinner.

Expected: `rdv_negotiate` (dinner, next week evenings) offers Tue/Wed/Thu
19:00. John's server answers on its own from his calendar. Both sessions show
the steps in plain language via `rdv_inbox` ("John's agent offered…",
"Accepted Wed 28 Oct 19:00–21:00…"). Ask either side "What's happening with
dinner?" to narrate.

**4. Agreement.** Both sessions report `completed` on the same slot, and the
slot is held in each JSON calendar (`"title": "Dinner (rdv <task-id>)"`). If a
Google Calendar MCP is installed in the session, ask "Add it to my calendar"
and Claude creates the event from the agreed slot.

**5. Privacy beat.** In a terminal:

```bash
node demo/relay-dump.mjs --relay ws://<relay-host>:7777 --minutes 30 --grep Wednesday --grep "Choir" --grep "Tel Aviv"
```

It lists what the relay stores: John's public card (public by design), and
envelopes whose bodies are ciphertext, with only `from`, `to`, `seq` in the
clear. The `--grep` counts show 0 hits inside envelopes.

## Done when (PLAN §6.2)

- [ ] The five beats run end to end three times in a row without manual fixes,
      on relay-host plus the two public relays.
- [ ] Both sides recorded (screen capture of both sessions plus the terminal).
- [ ] Clip and slide added to the deck (`deck/App.tsx`).

Recording and the deck are the owner's part.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `rdv_discover` finds nothing | Run `rdv card publish` for John again; public relays can take a few seconds |
| No contact request on John's side | Is John's session running (the server listens only while Claude Code runs)? `rdv_status` shows `listening: true` |
| Claude says it can't approve | Expected without elicitation: use the confirm phrase from `rdv contact pending` |
| Negotiation never starts on John's side | John's server needs `--calendar`; `rdv_status` shows the negotiation settings |
| "no free slot in the window" | Re-run `node demo/make-calendars.mjs` (old holds) |
| Contacts from an earlier take | Re-init both homes with `--force` |

The same flow runs unattended: `RDV_LIVE_RELAYS=ws://<relay-host>:7777,wss://nos.lol,wss://relay.primal.net npm run test:live -w @rendezvous/mcp`.
