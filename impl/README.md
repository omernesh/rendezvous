# Rendezvous reference implementation

TypeScript packages for the [Rendezvous](../SPEC.md) agent-to-agent contact
protocol, built toward the two-agent dinner demo in [PLAN.md](../PLAN.md).
`impl/` is an npm workspace:

| Package | Path | What it is |
|---|---|---|
| `@rendezvous/core` | `packages/core` | The protocol library (keys, cards, discovery, consent, envelopes, Nostr transport) |
| `@rendezvous/a2a` | `packages/a2a` | A2A task semantics: the dinner-negotiation message model, engine, calendar adapter |
| `@rendezvous/cli` | `packages/cli` | `rdv`, a command-line agent; also the scripted bots and interop scenarios |
| `@rendezvous/mcp` | `packages/mcp` | `rdv-mcp`, a stdio MCP server so Claude (or any MCP client) can find, contact and book dinner with other agents |

`demo/` holds the showpiece script ([demo/SCRIPT.md](demo/SCRIPT.md)), a
calendar generator and `relay-dump.mjs` (what the relay stores: ciphertext).

Core never depends on the CLI, the A2A layer, MCP or LLM code. `a2a` has no
runtime dependencies at all; the CLI glues the two together. The MCP server
builds on the CLI's library entry (`@rendezvous/cli/lib`: home dir, lock,
inbound loop), so `rdv` and `rdv-mcp` share profiles.

## @rendezvous/core

| Module | Spec | What it does |
|---|---|---|
| `identity` | §4.1–4.2 | Ed25519 agent keys, `rdv1:` IDs, fingerprints |
| `sign` | — | Signed JSON documents (canonical JSON + Ed25519) |
| `card` | §4.3 | Create and verify address cards |
| `discovery` | §4.4 | `dtopic()`, address canonicalization, binding levels |
| `contact` | §5 | Contact request / grant / revoke, and the contact book (policy, replay, rate limits) |
| `envelope` | §6.4, §7 | Encrypted, signed envelopes; `seq`/`prev` ordering with gap detection |
| `transport/nostr` | §6.2 | Nostr relay transport (kind 30417), re-subscribes when a relay drops |
| `agent` | — | Ties it together: listen, discover, request, grant, send, receive |
| `testing/relay` | — | In-memory Nostr relay on a localhost WebSocket, for tests and local demos |

```ts
import { Agent, NostrTransport } from '@rendezvous/core';

const relays = ['wss://relay.example'];
const john = Agent.create((key) => new NostrTransport({ key, relays }), {
  rendezvous: [{ type: 'nostr', relay: relays[0], pref: 1 }],
  discovery: { addresses: [{ type: 'email', value: 'john@doe.com' }], public_pointer: false },
});
john.on('request', (p) => john.grant(p.request.id, { tier: 'friend' })); // the human decides here
john.on('message', (from, payload) => console.log(from, payload));
john.start();

// On another machine:
await omer.requestContact('john@doe.com', "Omer's agent would like to plan dinner.");
omer.once('contact', () => omer.send(john.id, { type: 'a2a/message', text: 'Thursday 20:00?' }));
```

Agent state serializes with `agent.toJSON()` and loads with `Agent.fromJSON()`.
`packages/core/vectors/v1.json` holds interop test vectors: fixed keys, IDs,
discovery topics, a signed card and contact request, and a sample envelope
that another implementation should be able to open.

## @rendezvous/a2a

PLAN.md §5.1–5.2, SPEC.md §7. Payloads `a2a/message` (an A2A v0.3 `Message`)
and `a2a/task-update` (a `TaskStatusUpdateEvent`) travel inside envelopes.
The verb sits in the message's `data` part (`data.rdv`): `meeting/propose`,
`meeting/counter`, `meeting/accept`, `meeting/confirm`, `meeting/decline`, `meeting/cancel`, `rdv/cancel`.

| Module | What it does |
|---|---|
| `model` | Types and `parsePayload`: strict validation of peer input (known keys only, UUIDs, 1–3 RFC 3339 slots with offsets, bounded text) |
| `engine` | Pure state machine: `propose`, `receive`, `confirmMeeting`, `cancel`, `cancelMeeting`, `expire` return `{ state, outgoing, effects, events }`; no I/O, no clock |
| `calendar` | `CalendarAdapter` (`freeBusy(range)`, `hold(slot)`, `release(slot, note)`), `MemoryCalendar`, `JsonFileCalendar` (titles never leave the file) |
| `window` | `parseWindow`: RFC 3339 ranges and a few phrases, with `now` and the UTC offset passed in |
| `time` | Instants, fixed offsets, slot formatting |

Policy: an offer carries up to 3 free slots (one per day first); the receiver
accepts the first offered slot that is free and inside its window, else
counters with 3 of its own; after 3 offers the task ends `rejected`. Task
states: submitted → input-required / working → completed | rejected |
canceled. Agreement is a handshake: the accepter holds the slot tentatively
and sends `meeting/accept`; the offerer checks it is still free, sends
`meeting/confirm` and completes; the accepter completes on the confirm. A
tentative hold is released when the task is canceled, declined or expires,
and every hold is busy for all other tasks. Unless `ctx.autoConfirm`, the
engine waits for its human before each of those two steps (`confirmMeeting`).
Messages are deduplicated by `messageId`; `rdv/cancel` is honored
while pending; an agreed meeting is called off with `meeting/cancel`
(`cancelMeeting`, our human only), which the peer honors only for that
completed task and slot, freeing it in both calendars; meeting verbs need `may_propose_meetings` in the grant, and
`may_access_calendar: none` blocks them. A peer can hold at most 32 tasks
with us. Details and open questions: [NOTES.md](NOTES.md) items 28–37, 58, 61.

**`--window`** (local time = a fixed offset; weeks run Monday–Sunday; an
evening is 19:00–23:00; everything is clipped to start no earlier than now):

| Window | Means |
|---|---|
| `tonight` / `tomorrow evening` | that one evening |
| `this week evenings` | every evening from today to Sunday |
| `next week evenings` | every evening Monday–Sunday of next week |
| `this weekend` / `next weekend` | Saturday and Sunday evenings |
| `2026-11-05T19:00:00+02:00/2026-11-05T23:00:00+02:00[,…]` | explicit ranges |

Calendar file: `{ "timezone": "+02:00", "busy": [ { "start": "…", "end": "…", "title": "optional" } ] }`.
Held slots are added to `busy`: `Dinner (tentative, rdv <task>)` while the
handshake runs, then `Dinner (rdv <task>)`; a tentative hold that falls
through is removed.

## rdv (the CLI)

```bash
npm install && npm run build              # from impl/
npm run rdv -- --help                     # or: node packages/cli/dist/src/bin.js --help
```

`npx rdv …` also works once `npm install` has run after the first build
(npm links the binary only when `dist/` exists).

State lives in a directory: `--home <dir>`, else `$RDV_HOME`, else
`~/.rendezvous/<profile>` (`--profile`, default `default`).

| File | Holds |
|---|---|
| `agent.json` | `Agent.toJSON()`, including the secret key (mode 600 where the OS supports it) |
| `config.json` | profile, relays, addresses (public ones are on the card; `private: true` ones are kept here only), policy |
| `inbox.jsonl` | received payloads, one JSON object per line |
| `cards.json` | cards found by `rdv lookup`, so `contact request <agent-id>` can use them |
| `negotiations.json` | dinner negotiations (the a2a engine state) |
| `consent.json` | salted scrypt hashes of the confirm phrases for pending requests, probe answers and held dinners, each bound to what the human was shown (written by `rdv-mcp`; `contact pending` and `dinner list` issue and show a fresh phrase in text mode) |
| `holds.json` | which calendar file holds each tentative dinner hold, so `dinner confirm`/`cancel` can finalize or release it |
| `events.jsonl` | shared event log: what the home's listener handled, plus `rdv-mcp`'s own events; `rdv_inbox` is a view of it |
| `events.lock` | held while appending to `events.jsonl` |

| `lock` | held while a command reads and writes state |
| `listener.lock` | held for its lifetime by the home's one inbound consumer (`rdv listen` or `rdv-mcp`) |

| Command | Does |
|---|---|
| `rdv init --profile omer --email omer@example.com [--email …] --relay wss://… [--relay …] [--phone +…] [--phone …] [--public-pointer] [--force]` | Generate key and card, write state. Repeat `--email` / `--phone` for more addresses (canonicalized, repeats dropped, at most 8) |
| `rdv whoami` | Print agent ID, fingerprint, addresses, card JSON (never the secret key) |
| `rdv address list` | Our addresses, each public (on the card, answers probes; with its topic) or private (kept in `config.json` only) |
| `rdv address add <email\|+phone> [--public\|--private]` | Add one (default public). A public one re-signs the card with a later `created`, republishes it if the public pointer is on, and a running `listen` / `rdv-mcp` starts answering probes on it within a second. Duplicates (in any spelling) and a ninth address are refused |
| `rdv address remove <email\|+phone>` | Remove one: probes on it are refused at once and its topic is dropped; with the public pointer on, the new card is also published on the removed topic, replacing the old one there. Contacts are kept (NOTES 63) |
| `rdv card publish` | Publish public pointers (if enabled at init) |
| `rdv lookup john@doe.com` | Fetch public-pointer cards for an address |
| `rdv contact request <email\|card-file\|agent-id> [--greeting "…"] [--in-person] [--label john@doe.com]` | Topic probe by email, or direct by card. `--in-person` records the `in-person` binding for a card you got face to face. `--label` is your local name for them (a probe is labeled with the address) |
| `rdv contact pending` | Pending inbound requests with binding, fingerprint, greeting; answers to your topic probes awaiting confirmation |
| `rdv contact grant <request-id> [--tier friend] [--scope-file s.json] [--label john@doe.com]` | Approve (`--label`: your local name for them) |
| `rdv contact label <agent-id> <label>` | Name a contact locally; sending by name (`rdv_send` `to`) resolves through this, never through the addresses its card claims. Yours to run: an assistant may only suggest a label, which you approve with the contact (NOTES 62) |
| `rdv contact grant <agent-id> [--tier …] [--scope-file …]` | Give a contact you requested rights towards you (by default it may write, not propose meetings); the contact gets a reverse grant, so it can then propose (NOTES 60) |
| `rdv contact confirm <grant-id>` / `rdv contact reject <grant-id> [--block]` | Accept or turn down an answer to your topic probe (anyone who saw the probe can answer; check the fingerprint) |
| `rdv contact decline <request-id> [--block]` | Decline |
| `rdv contact list` / `rdv contact revoke <agent-id>` | Manage contacts |
| `rdv contact resync <agent-id>` | After `listen` reports an `envelope chain fork` (the contact restored an old backup), accept its current chain once you have checked with them; until then its messages are refused |
| `rdv send <agent-id> --json '{"type":"a2a/message","text":"hi"}'` | Send any payload (`--payload '…'` is the same without JSON output) |
| `rdv listen [--auto-grant <tier> [--auto-grant-any-tier]] [--exec <script>] [--negotiate --calendar cal.json [--window "…"] [--tz +02:00]]` | Long-running: print events; auto-grant is for demos only and stops at `stranger` unless `--auto-grant-any-tier`; `--exec` gets each event as a JSON line on stdin (`RDV_EVENT`, `RDV_HOME` set); `--negotiate` answers dinner proposals from the calendar (window default `next week evenings`) and holds a slot for you to confirm; `--auto-confirm` skips the human (bots, demos) |
| `rdv dinner propose <agent-id> --calendar cal.json --window "next week evenings" [--tz +02:00] [--minutes 120] [--place …] [--area …] [--expires <rfc3339>]` | Offer up to 3 free slots; run `listen --negotiate` to handle the replies |
| `rdv dinner confirm <task-id> --hold <code>` | Confirm the dinner a negotiation holds for you: sends `meeting/accept` (their offer) or `meeting/confirm` (they accepted yours). `--hold` is the code `rdv dinner list` shows; it is refused if the meeting changed since |
| `rdv dinner cancel <task-id> [--reason …]` | Send `rdv/cancel` for a pending negotiation and release its hold; for an agreed (completed) dinner, send `meeting/cancel`: it leaves your calendar and the peer's agent removes it from theirs |
| `rdv dinner list` | Negotiations with state, round, agreed or held slot (and what it waits for) |
| `rdv inbox [--follow]` | Show received payloads |

Output is human text by default and one JSON object per line with `--json`.
Exit codes: 0 ok, 1 error, 2 usage error. Every command except `listen` and
`inbox --follow` loads state under the lock, runs, saves, and exits. `listen`
takes the lock only while it handles one inbound item, so a bot can run
`rdv contact grant` against the same home while `listen` is running; it prints
an event only after the state behind it is saved.

**One inbound consumer per home.** Two processes subscribed for the same home
would split inbound events between them (whichever handles an envelope first
wins; the other never sees it). So whoever consumes holds `listener.lock`
(O_EXCL file with pid, host and role, mtime touched every minute; broken when
its pid is gone on this host, or after 10 minutes without a touch from another
host) and appends every event it handles to `events.jsonl`, after the state
behind it is saved. A second `rdv listen` exits 1 naming the holder. A second
`rdv-mcp` runs **attached**: it opens no subscriptions, still sends (grant,
send, negotiate), and its `rdv_inbox` follows `events.jsonl` by cursor, so every
server on the home sees each event once with the same cursor. When the holder
exits, an attached server takes the lock within a second and starts
consuming; the relays' lookback replays what arrived meanwhile, and the
channels drop what was already handled. Negotiation follows the consumer:
run `rdv listen --negotiate` (or give the consuming `rdv-mcp` a calendar) if
an attached server should get answers to its dinner proposals.

With `--json`, negotiation steps print as `{"event":"dinner","kind":…,"task":…,"peer":…,"state":…}`
(kinds: proposed, offer-received, countered, confirm-needed, accepted,
completed, meeting-canceled, released, rejected, canceled, expired, status,
duplicate, ignored, invalid). In text mode the
peer's text parts and decline reasons are shown as untrusted and cleaned.

PowerShell quoting for `send`: `rdv send <id> --json '{\"type\":\"a2a/message\",\"text\":\"hi\"}'`
(Windows PowerShell 5 strips bare inner quotes; PowerShell 7.3+ accepts the bash form).

### The dinner scenarios (PLAN §5.3)

`packages/cli/scenarios/dinner.ts`: Omer and John each run
`rdv listen --negotiate` with their own JSON calendar; Omer runs
`rdv dinner propose`. Variants: `overlap` (John, then Omer, confirms with
`rdv dinner confirm`; both `completed` on the same slot, one hold each),
`no-overlap` (`rejected` after 3 rounds), `cancel` (John offline while Omer
proposes and cancels; both `canceled`), `cancel-hold` (Omer cancels while
John's agent holds a slot for John; the hold is released), `duplicate`
(`--auto-confirm` bots, then every envelope replayed and a message re-sent;
nothing changes), `reverse` (John, who granted the contact, proposes: refused
until Omer runs `rdv contact grant <john-id>`, which sends John a reverse
grant; then both confirm and complete), `cancel-agreed` (`--auto-confirm`
bots agree, then John runs `rdv dinner cancel`; both calendars free the
evening and both end `canceled`). All seven run in `npm test`; `overlap` runs in
`npm run test:live`; by hand:

`node packages/cli/dist/scenarios/dinner.js --relay ws://… [--variant overlap] [--variant …]`.

### The contact scenario (PLAN §4.5)

`packages/cli/scenarios/contact.ts` drives real `rdv` processes with separate
homes: John listens, Omer requests by email, John grants, Omer sends, John's
inbox shows it, each step asserted with a timeout. It runs:

- against the in-memory relay as part of `npm test`;
- against real relays with `npm run test:live` (below);
- by hand against any relays, e.g. from two machines' worth of setup:
  `node packages/cli/dist/scenarios/contact.js --relay wss://relay.example [--relay …] [--timeout 30000] [--keep]`.

Crash safety: state is saved right before each envelope leaves (`Agent.beforeSend`),
so a crash after a send never reuses a `seq` (issue #4).

## rdv-mcp (the MCP server)

PLAN §6.1. Tools `rdv_init`, `rdv_status`, `rdv_publish_card`, `rdv_discover`,
`rdv_request_contact`, `rdv_pending_requests`, `rdv_grant`, `rdv_revoke`,
`rdv_send`, `rdv_inbox`, `rdv_negotiate`, and the `rdv://inbox` resource
(subscribable). `rdv_grant` needs the human: an MCP elicitation form, or a
confirm phrase shown only in their terminal. Peer text comes back only as
`untrusted_peer_text`. Details, consent threat model and client config:
[packages/mcp/README.md](packages/mcp/README.md), [demo/SCRIPT.md](demo/SCRIPT.md).

```bash
node packages/mcp/dist/src/bin.js --home ~/.rendezvous/omer --calendar cal.json --tz +02:00
```

## Develop

Run from `impl/` (works the same in PowerShell and bash):

```bash
npm install
npm run typecheck        # every workspace
npm test                 # core, a2a, cli (commands + scenarios), mcp (two servers end to end); local relay, no network
npm run build            # tsc -b -> packages/*/dist
npm run test:vectors:update   # regenerate vectors (deliberate wire-format changes only)
```

One package or one file: `npm test -w @rendezvous/core`, or
`cd packages/core && npx vitest run test/unit.test.ts -t envelope`.
CLI tests spawn the built `rdv`, so the CLI's `test` script builds first.

**Live relays.** `npm run test:live` runs only `*.live.test.ts`, and those skip
unless `RDV_LIVE_RELAYS` lists relays. They are never part of `npm test`.

```bash
RDV_LIVE_RELAYS=wss://nos.lol,wss://relay.damus.io npm run test:live
```
```powershell
$env:RDV_LIVE_RELAYS='wss://nos.lol,wss://relay.damus.io'; npm run test:live; Remove-Item Env:RDV_LIVE_RELAYS
```

**Pre-push hook (replaces CI).** Enable it once per clone, from the repo root:

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-push` runs `npm run typecheck && npm test` in `impl/` and blocks
the push if either fails.

See [NOTES.md](NOTES.md) for wire-format decisions and the places where this
implementation departs from or fills gaps in SPEC.md.
