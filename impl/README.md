# Rendezvous reference implementation

TypeScript packages for the [Rendezvous](../SPEC.md) agent-to-agent contact
protocol, built toward the two-agent dinner demo in [PLAN.md](../PLAN.md).
`impl/` is an npm workspace:

| Package | Path | What it is |
|---|---|---|
| `@rendezvous/core` | `packages/core` | The protocol library (keys, cards, discovery, consent, envelopes, Nostr transport) |
| `@rendezvous/cli` | `packages/cli` | `rdv`, a command-line agent; also the scripted bots and interop scenario |

Core never depends on the CLI (or on MCP or LLM code).

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
| `config.json` | profile, relays, addresses, policy |
| `inbox.jsonl` | received payloads, one JSON object per line |
| `cards.json` | cards found by `rdv lookup`, so `contact request <agent-id>` can use them |
| `lock` | held while a command reads and writes state |

| Command | Does |
|---|---|
| `rdv init --profile omer --email omer@example.com --relay wss://… [--relay …] [--phone +…] [--public-pointer] [--force]` | Generate key and card, write state |
| `rdv whoami` | Print agent ID, fingerprint, card JSON (never the secret key) |
| `rdv card publish` | Publish public pointers (if enabled at init) |
| `rdv lookup john@doe.com` | Fetch public-pointer cards for an address |
| `rdv contact request <email\|card-file\|agent-id> [--greeting "…"] [--in-person]` | Topic probe by email, or direct by card. `--in-person` records the `in-person` binding for a card you got face to face |
| `rdv contact pending` | Pending inbound requests with binding, fingerprint, greeting |
| `rdv contact grant <request-id> [--tier friend] [--scope-file s.json]` | Approve |
| `rdv contact decline <request-id> [--block]` | Decline |
| `rdv contact list` / `rdv contact revoke <agent-id>` | Manage contacts |
| `rdv send <agent-id> --json '{"type":"a2a/message","text":"hi"}'` | Send any payload (`--payload '…'` is the same without JSON output) |
| `rdv listen [--auto-grant <tier>] [--exec <script>]` | Long-running: print events; auto-grant is for demos only; `--exec` gets each event as a JSON line on stdin (`RDV_EVENT`, `RDV_HOME` set) |
| `rdv inbox [--follow]` | Show received payloads |

Output is human text by default and one JSON object per line with `--json`.
Exit codes: 0 ok, 1 error, 2 usage error. Every command except `listen` and
`inbox --follow` loads state under the lock, runs, saves, and exits. `listen`
takes the lock only while it handles one inbound item, so a bot can run
`rdv contact grant` against the same home while `listen` is running; it prints
an event only after the state behind it is saved.

PowerShell quoting for `send`: `rdv send <id> --json '{\"type\":\"a2a/message\",\"text\":\"hi\"}'`
(Windows PowerShell 5 strips bare inner quotes; PowerShell 7.3+ accepts the bash form).

### The contact scenario (PLAN §4.5)

`packages/cli/scenarios/contact.ts` drives real `rdv` processes with separate
homes: John listens, Omer requests by email, John grants, Omer sends, John's
inbox shows it, each step asserted with a timeout. It runs:

- against the in-memory relay as part of `npm test`;
- against real relays with `npm run test:live` (below);
- by hand against any relays, e.g. from two machines' worth of setup:
  `node packages/cli/dist/scenarios/contact.js --relay wss://relay.example [--relay …] [--timeout 30000] [--keep]`.

## Develop

Run from `impl/` (works the same in PowerShell and bash):

```bash
npm install
npm run typecheck        # every workspace
npm test                 # core: unit, integration, vectors; cli: commands + scenario (local relay, no network)
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
