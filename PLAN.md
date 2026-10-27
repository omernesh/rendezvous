# Rendezvous: implementation plan (two-agent dinner demo)

**Owner:** Omer Nesher · **Written:** 2026-10-24 · **Status:** steps 1–3 done; step 4 code and demo prep on `impl/step-4-mcp` (MCP server, live runs 2026-10-25); demo recording, deck slide and relay.nesher.co Cloudflare step open

This is the working plan for turning the Rendezvous spec ([SPEC.md](SPEC.md))
into running code. It is meant to be picked up in a local Claude Code session:
each step lists its goal, design, files, tasks, and a "done when" check, so
the steps can be worked in order without needing earlier conversations.

---

## 0. Decisions already made

| Question | Decision | Why |
|---|---|---|
| Goal for the next few months | A **working demo of two agents** | Running code makes feedback, pitching and spec hardening easier |
| Demo scope | **Full story:** keys and address cards → discovery by email → consent → encrypted messaging over Nostr → an A2A task where the two agents **agree on a dinner time** | Shows the whole value proposition end to end |
| Out of scope for the demo | Mailbox probe (§5.2.1), invite (§5.2.2), directories (§4.5), ntfy/MQTT, direct P2P (ICE/WebRTC), key rotation | Heavier and mostly plumbing; they come after the demo |
| Language | **TypeScript** (Node ≥ 20) | Matches SPEC.md §12; largest Nostr and MCP ecosystems |
| Agent shape | **Library first, then scripted CLI bots, then an MCP server** that two Claude sessions use for the showpiece | The CLI doubles as the interop test harness |
| Relays | **Own relay on relay-host** for reliable tests and demos, **plus 2–3 public relays** in the live demo | Repeatable, while still proving the open-network claim |
| CI | **No GitHub Actions** (no minutes). Tests run locally; a git pre-push hook enforces them | Owner decision 2026-10-24 |

Example personas used throughout (from the spec's anonymized examples):
**Omer** (`omer@example.com`) and **John** (`john@doe.com`).

---

## 1. Repository layout (target)

```
SPEC.md                    protocol spec (source of truth)
PLAN.md                    this file
impl/                      npm workspace root
  package.json             workspace root: typecheck/test/build/test:live fan out
  NOTES.md                 spec deltas found while implementing
  packages/
    core/                  @rendezvous/core     (src/ test/ vectors/)
    cli/                   @rendezvous/cli      (step 2)
    a2a/                   @rendezvous/a2a      (step 3)  dinner negotiation
    mcp/                   @rendezvous/mcp      (step 4)  MCP server
  deploy/
    relay/                 docker-compose for the relay-host relay (step 2)
  demo/                    scripts + recordings for the showpiece (step 4)
```

Keep `@rendezvous/core` free of CLI, MCP or LLM dependencies. Everything
above it depends on core, never the reverse.

---

## 2. Working locally (no CI)

```powershell
cd impl
npm install
npm test            # vitest: unit, integration (in-memory relay), vectors
npm run typecheck
npm run build
```

- **Pre-push hook** (step 2, task 1): `.githooks/pre-push` runs
  `npm run typecheck && npm test` in `impl/`. Enable it once per clone with
  `git config core.hooksPath .githooks`. This replaces CI.
- **Integration tests** use the in-memory relay in `src/testing/relay.ts` and
  need no network. Tests that hit real relays live behind an env flag:
  `RDV_LIVE_RELAYS=wss://...,wss://... npm run test:live`, and are never part
  of `npm test`.
- **Vectors:** `vectors/v1.json` is generated once; regenerate only on a
  deliberate wire-format change (`npm run test:vectors:update`, works in
  PowerShell too) and say so in the commit message.
- **Branches:** one branch per step (`impl/step-2-cli`, …), merged to `main`
  when its "done when" passes locally.

---

## 3. Step 1: core library ✅ (PR #1)

Done on branch `claude/project-thread-5z3j88`, draft PR #1. Contents:

| Module | Spec | Notes |
|---|---|---|
| `identity` | §4.1–4.2 | Ed25519 keys, `rdv1:` + lowercase base32 IDs, fingerprints, X25519 conversion |
| `sign` | — | `sig` = Ed25519 over `"rdv1/sig:" ‖ canonical JSON (without sig)` |
| `card` | §4.3 | create / verify / expiry; hints sorted by `pref` |
| `discovery` | §4.4 | `canonAddress`, `dtopic`, binding levels, `topicForHint` |
| `contact` | §5 | request / grant / revoke docs; `ContactBook` (policy, allowlist, blocklist, replay IDs, `max_frequency`) |
| `envelope` | §6.4, §7 | ephemeral X25519 → HKDF → AES-256-GCM; signature covers ciphertext; `Channels` for `seq`/`prev`, gaps, forks |
| `transport/nostr` | §6.2 | kind 30417, `p`/`t`/`d` tags, derived secp256k1 carrier key, uses the `ws` package |
| `agent` | — | `start`, `lookup`, `publishPointers`, `requestContact`, `grant`, `decline`, `revoke`, `send`, events `request`/`contact`/`message`/`revoked`/`dropped`, `toJSON`/`fromJSON` |

19 tests pass locally. **Before merging PR #1:** delete
`.github/workflows/impl.yml` (already removed in the commit that adds this plan)
and merge.

Known gaps carried forward (fix as part of later steps when touched):
- Contact requests that arrive *inside an envelope* advance the per-peer
  `seq`; if a request is declined and re-sent, ordering state is shared with
  the later conversation. Acceptable for the demo; revisit in v0.2.
- ~~The requester records its own side of the contact with binding `claimed`
  even when it reached the peer by card.~~ Fixed in step 2: the binding is
  stored with the outstanding request (`in-person` via `rdv contact request
  <card-file> --in-person`).
- ~~No persistence locking.~~ Fixed in step 2: the CLI holds a lockfile and
  writes state temp-then-rename.

---

## 4. Step 2: CLI bots and our own relay

**Goal:** two independent processes (Omer and John), on different machines if
wanted, run discovery → consent → messaging over a real relay, scripted and
repeatable. The same scenario is the interop test.

### 4.1 Workspace setup (task 1)
1. Turn `impl/` into an npm workspace: move core to `impl/packages/core`
   (or keep it at the root and add `packages/*` as workspaces; pick one and
   update imports).
2. Add `.githooks/pre-push` (see §2) and document it in `impl/README.md`.
3. Add `test:live` script and the `RDV_LIVE_RELAYS` gate.

### 4.2 `rdv` CLI (`@rendezvous/cli`, task 2)
State lives in a directory (`--home`, default `~/.rendezvous/<profile>`):
`agent.json` (from `Agent.toJSON()`, file mode 600), `config.json` (relays,
addresses, policy), `inbox.jsonl` (received payloads), and `lock`.

| Command | Does |
|---|---|
| `rdv init --profile omer --email omer@example.com --relay wss://… [--relay …] [--public-pointer]` | Generate key and card, write state |
| `rdv whoami` | Print agent ID, fingerprint, card JSON |
| `rdv card publish` | Publish public pointers (if enabled) |
| `rdv lookup john@doe.com` | Fetch public-pointer cards for an address |
| `rdv contact request <email|card-file|agent-id> --greeting "…"` | Topic probe by email, or direct by card |
| `rdv contact pending` | List pending inbound requests with binding, fingerprint, greeting |
| `rdv contact grant <request-id> [--tier friend] [--scope-file s.json]` | Approve |
| `rdv contact decline <request-id> [--block]` | Decline |
| `rdv contact list` / `rdv contact revoke <agent-id>` | Manage contacts |
| `rdv send <agent-id> --json '{"type":"a2a/message","text":"hi"}'` | Send any payload |
| `rdv listen [--auto-grant tier] [--exec script]` | Long-running: print events as JSON lines; optionally auto-grant (demo only) or pipe each event to a script |
| `rdv inbox [--follow]` | Show received payloads |

Rules: every command loads state under the lock, runs, saves, exits; only
`listen` stays up. Output is human text by default and JSON lines with
`--json` (the bots use JSON). Never print the secret key.

### 4.3 Relay on relay-host (task 3)
- `impl/deploy/relay/docker-compose.yml` running **strfry** (or
  `nostr-rs-relay`; strfry is lighter and fast). Data volume on
  `<nas>/rendezvous/relay` so it persists across the swarm.
- Relay config: allow kind 30417; no auth for the demo; size limit about
  64 KB per event; rate limit per IP.
- Expose through the existing **Cloudflare Tunnel** as
  `wss://relay.<your-domain>` (tunnel ingress → `http://localhost:7777`).
  Check that the tunnel passes WebSocket upgrades.
- Deploy with Portainer or `docker compose up -d` on relay-host. Health check: NIP-11
  `curl -H 'Accept: application/nostr+json' https://relay.<domain>`.

### 4.4 Public relays (task 4)
Smoke-test which public relays accept and serve kind 30417 with a `d` tag:
`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`,
`wss://relay.nostr.band`, `wss://nostr.wine` (paid; skip). Record results in
`impl/NOTES.md`. Pick 2–3 for the demo. If several drop addressable kinds
from unknown pubkeys, that is the argument for moving to a regular kind
(see §7, spec follow-up 2).

### 4.5 Scripted bots and interop test (task 5)
`impl/packages/cli/scenarios/contact.ts`:
1. Start John with `rdv listen --json` on his home dir.
2. Omer: `rdv contact request john@doe.com --greeting "…"`.
3. John's bot sees `request`, runs `rdv contact grant <id> --tier friend`.
4. Omer sees `contact`; sends a message; John's inbox shows it.
5. Assert on every step, with timeouts; exit non-zero on failure.

Run it three ways: in-memory relay (part of `npm test`), the relay-host relay, and
public relays (`test:live`).

**Done when:** the scenario passes against the relay-host relay from two different
machines (for example relay-host and the second machine, or the Windows PC), and passes
against at least two public relays.

---

## 5. Step 3: dinner negotiation (A2A tasks)

**Goal:** the bots agree on a dinner slot using A2A task semantics inside
envelopes (§7), including counter-offers, cancellation, retries and
deduplication.

### 5.1 Message model (`@rendezvous/a2a`)
Use A2A v0.3 object shapes inside the encrypted payload. Payload `type` is
`a2a/task-update` or `a2a/message`.

```jsonc
// a2a/message: one turn in the negotiation
{
  "type": "a2a/message",
  "message": {
    "kind": "message",
    "messageId": "<uuid>",          // dedupe key (§7 idempotency)
    "taskId": "<uuid>",
    "contextId": "<uuid>",          // one per dinner negotiation
    "role": "agent",
    "parts": [
      { "kind": "text", "text": "How about Thursday?" },        // human-readable
      { "kind": "data", "data": {                                 // machine part
          "rdv": "meeting/propose",
          "slots": [
            { "start": "2026-11-05T19:00:00+02:00", "end": "2026-11-05T21:00:00+02:00" },
            { "start": "2026-11-06T20:00:00+02:00", "end": "2026-11-06T22:00:00+02:00" }
          ],
          "place": { "name": "optional", "area": "Tel Aviv" },
          "expires": "2026-11-01T00:00:00Z"
      } }
    ]
  }
}
```

Machine verbs (`data.rdv`): `meeting/propose`, `meeting/counter` (new slots),
`meeting/accept` (exactly one slot), `meeting/decline` (reason), and
`rdv/cancel` (by `taskId`, honored while pending). The task carries an A2A
`status.state`: `submitted` → `working` / `input-required` → `completed` |
`canceled` | `rejected`.

### 5.2 Negotiation engine
- Pure state machine: `(state, incoming message) → (new state, outgoing
  messages)`, no I/O, fully unit-tested. Rejects a verb that is invalid for the
  current state; checks that `accept` picks a slot that was actually offered.
- **Calendar adapter** interface: `freeBusy(range) → busy[]` and
  `hold(slot)`. Ship a JSON-file calendar for the bots. Google Calendar comes
  later, through MCP on the Claude side, not inside the library.
- **Policy:** proposer offers up to 3 free slots; responder accepts the first
  slot that is free for it, otherwise counters with its own 3; give up after
  3 rounds (`rejected`).
- **Scope check:** only send or accept meeting verbs when the grant has
  `may_propose_meetings: true`; calendar details never exceed
  `may_access_calendar` (`free_busy` means slots only, never event titles).

### 5.3 CLI integration
`rdv dinner propose <agent-id> --calendar cal.json --window "next week evenings"`
and `rdv listen --negotiate --calendar cal.json` so the bots run the whole
flow on their own.

**Done when:** two bots with overlapping JSON calendars agree on a slot over
the relay-host relay; a variant with no overlap ends `rejected` after 3 rounds; a
mid-flight `rdv/cancel` ends `canceled`; duplicate deliveries (replay the same
envelope) change nothing.

---

## 6. Step 4: MCP server and the showpiece demo

**Goal:** two Claude sessions (one per person), each with the Rendezvous MCP
server installed, find each other, get consent from their human, and book
dinner while the humans watch.

### 6.1 MCP server (`@rendezvous/mcp`)
- Stdio MCP server built with `@modelcontextprotocol/sdk`. It runs a
  long-lived `Agent` (listening) in the server process, with state in the same
  home dir format as the CLI (shared lock).
- Tools (from SPEC.md §13; demo subset in bold):

| Tool | Input | Output |
|---|---|---|
| **`rdv_init`** | profile, email, relays | agent ID, fingerprint |
| **`rdv_publish_card`** | — | topics published |
| **`rdv_discover`** | address | cards found (public pointers) |
| **`rdv_request_contact`** | address or agent ID, greeting | request ID |
| **`rdv_pending_requests`** | — | list with binding, fingerprint, greeting |
| **`rdv_grant`** / `rdv_revoke` | request ID, tier, scope / agent ID | contact |
| **`rdv_send`** | agent ID, payload | envelope seq |
| **`rdv_inbox`** | since cursor | new payloads and events |
| **`rdv_negotiate`** | agent ID, intent (`dinner`), window, constraints | task ID and state; progresses via `rdv_inbox` |

- **Consent stays with the human.** `rdv_grant` must not succeed on the
  model's own say-so. Use MCP elicitation (ask the user to confirm, showing the
  fingerprint and channel) where the client supports it, and otherwise require
  a `confirm_phrase` that only the human types. Document this as a
  demo-critical safety property.
- **Prompt-injection gate.** Text from peers (greetings, text parts) is
  returned as clearly marked untrusted data, never as instructions; tool
  descriptions say so. Only `data` parts drive the negotiation engine.
- Expose `rdv_inbox` as a resource subscription as well, if the client
  supports notifications, so Claude sees new events without polling.

### 6.2 The demo
- Two machines or two Claude sessions: "Omer's Claude" and "John's Claude",
  each with its own home dir, calendar (JSON, or Google Calendar through its
  MCP), and the MCP server configured in `claude_desktop_config.json` or the
  Claude Code `.mcp.json`.
- Relays: relay-host relay plus 2 public relays in each card.
- Script (`demo/SCRIPT.md`):
  1. Omer: "Find John's agent (john@doe.com) and set up dinner next week."
  2. John's Claude surfaces the contact request; John approves (consent beat).
  3. The agents negotiate; both humans see proposals and counters in plain
     language.
  4. Agreement; both Claudes add the calendar event.
  5. Show the relay's stored events: ciphertext only (privacy beat).
- Record the screen for both sides; add the clip and a slide to the deck
  (`deck/App.tsx`).

**Done when:** the scripted demo runs end to end three times in a row without
manual fixes, on the relay-host relay plus public relays, and is recorded.

---

## 7. Spec follow-ups (fold into SPEC.md as rev 3)

From `impl/NOTES.md`:
1. **Security:** the envelope signature covers `content` (§6.4); add `epk` to
   the content example; describe the KDF.
2. Move the envelope kind from 30417 (addressable) to a **regular kind**
   (1000–9999), or require a unique `d` tag.
3. The grant carries the grantor's card (§5.3).
4. Define canonical JSON (RFC 8785), base32 alphabet and case, and `sig`
   encoding.
5. Describe the Nostr carrier key (secp256k1, derived from the seed) and the
   `p` tag value.
6. Clarify that the `claimed` tier cap applies to the default tier, not an
   explicit human choice (§4.4).
7. Listen mode: the probe is a contact request posted on the `dtopic` (§4.4).
8. §12: update phases to match this plan (library + CLI = v0.2, MCP = v0.3).
9. §5.5.1, the reference-implementation paragraph: the owner passphrase may
   also be set in an elicitation form (`rdv_owner_passphrase`), and the
   owner's other settings (label, resync, direct transfer, replacing the
   identity) have form-only chat tools with no confirm phrase (NOTES 97).
10. §6.4.2 (new): delivery receipts (`rdv/ack`, the receipts capability on
   the card, resend on a backoff and after a reconnect, "not confirmed"
   after the last retry) and the echo check; a line in §7 on gaps (NOTES 98).

Update the reading page with `python3 render_html.py` after editing SPEC.md.

---

## 8. Risks and open questions

| Risk | Mitigation |
|---|---|
| Public relays drop or rate-limit an unknown kind | Own relay is primary; follow-up 2 (regular kind) |
| The model approving consent by itself | Elicitation or confirm phrase in `rdv_grant` (§6.1) |
| Prompt injection via greetings or text parts | Untrusted-data marking; only `data` parts drive actions |
| No forward secrecy (static recipient key) | Accept for the demo; design handshake-derived conversation keys for v0.2 |
| State file corruption or races | Lockfile and atomic writes (write temp, then rename) in the CLI and MCP |
| Clock skew breaks TTLs | TTL default 48h; allow ±5 min skew in `isExpired` |

---

## 9. Order of work (checklist)

- [x] Step 1: core library (PR #1)
- [x] Merge PR #1 (CI workflow removed)
- [x] Step 2.1: workspace and pre-push hook
- [x] Step 2.2: `rdv` CLI
- [x] Step 2.3: strfry on relay-host via Cloudflare Tunnel (relay deployed on relay-host, `ws://<relay-host>:7777` over Tailscale; public hostname relay.nesher.co pending the owner's Cloudflare dashboard step)
- [x] Step 2.4: public relay survey → NOTES.md (item 11a)
- [x] Step 2.5: scripted contact scenario (in-memory, relay-host, public)
  - [x] in-memory relay, part of `npm test`
  - [x] relay-host relay, two machines (`scenarios/two-machine.ps1`, passed twice 2026-10-25)
  - [x] two public relays via `test:live` (nos.lol, relay.primal.net, nostr.mom pass; NOTES.md item 11a)
- [x] Step 3: `@rendezvous/a2a` engine, calendar adapter, CLI integration (`impl/step-3-a2a`)
  - [x] in-memory relay, part of `npm test`: overlap, no overlap (rejected in round 3), mid-flight cancel, duplicate delivery
  - [x] relay-host relay (`ws://<relay-host>:7777`) via `test:live` (overlap), and all four variants by hand, 2026-10-25
- [ ] Step 4: `@rendezvous/mcp`, demo script, recording, deck slide (`impl/step-4-mcp`)
  - [x] Issue #4: state saved before an envelope leaves (core `Agent.beforeSend`, CLI, MCP)
  - [x] `@rendezvous/mcp` (`rdv-mcp`): §6.1 tools, inbox resource with subscribe, consent via elicitation or confirm phrase, untrusted-data gate
  - [x] two MCP servers end to end in `npm test` (in-memory relay, plus a stdio test); `test:live` on relay-host alone and relay-host + nos.lol + relay.primal.net, 2026-10-25
  - [x] demo prep: `impl/demo/SCRIPT.md`, `make-calendars.mjs`, `relay-dump.mjs`
  - [ ] scripted demo three times in a row with two Claude Code sessions, recorded
  - [ ] clip and slide in the deck
- [x] Spec rev 3 with the follow-ups in §7 (SPEC.md rev 3, 2026-10-25)
