# Implementation notes and spec deltas

Building the reference library surfaced places where SPEC.md (v0.1 rev 2) was
silent, ambiguous, or would be unsafe as written. Each item below says what
the library does today. Items marked **spec change** were folded back
into SPEC.md in rev 3 (2026-10-25); each folded item says where. Items without
the marker (CLI behavior, live-run logs, calendar settings) stay here only.

## Security

1. **The envelope signature must cover `content`.** (**spec change**, §6.4)
   The spec signs "everything outside content". Then anyone who sees one
   genuine envelope can keep its signed header and swap in their own
   ciphertext encrypted to the recipient; the recipient would accept the
   payload as coming from the header's sender. The library signs the whole
   envelope (everything except `sig`), and also binds the header as AES-GCM
   associated data. (folded into SPEC rev 3 §6.4)
2. **Domain-separated signatures.** Every signed document is signed over
   `"rdv1/sig:" ‖ canonical-JSON(doc without sig)`, so a signature can't be
   lifted from one context to another. (folded into SPEC rev 3 §4.6)

## Wire format choices the spec leaves open

3. **Canonical JSON** = RFC 8785 (JCS) subset: sorted keys, no whitespace,
   `undefined` dropped, integers only. (folded into SPEC rev 3 §4.6)
4. **Base32** = RFC 4648 alphabet, lowercase, no padding. An agent ID is
   `rdv1:` + 52 characters. (folded into SPEC rev 3 §4.2, §4.6)
5. **`sig`** is base64 (standard alphabet, padded) of the 64-byte Ed25519
   signature. (folded into SPEC rev 3 §4.6)
6. **Envelope encryption** (`alg: "x25519+aes256gcm"`): an ephemeral X25519
   key per envelope × the recipient's X25519 key (converted from its Ed25519
   identity) → HKDF-SHA256 (salt = `epk ‖ recipient_x25519_pub`, info =
   `"rdv1/envelope"`) → AES-256-GCM, 12-byte random nonce. `content` gains an
   `epk` field (**spec change**: add it to the §6.4 example).
   This has no forward secrecy yet; the conversation-scoped keys from the
   handshake that §6.2 mentions are future work. (folded into SPEC rev 3 §6.4)
7. **`prev`** is the hex SHA-256 of the previous envelope's canonical JSON in
   the same direction; the first envelope has `prev: null` and `seq: 1`. (folded into SPEC rev 3 §4.6, §6.4)
8. **`canon(address)`** is the bare value: email trimmed and lowercased,
   phone as `+` and digits (a leading `+` is required). No type prefix. (folded into SPEC rev 3 §4.6)

## Nostr

9. **Kind 30417 is in the addressable range** (30000–39999). Relays keep only
   the latest event per (pubkey, kind, `d`), so two envelopes without
   distinct `d` tags would overwrite each other. The library sets
   `d = envelope hash`. **Spec change (recommended):** move to a regular kind
   (1000–9999) so relays store each envelope as its own event. (folded into SPEC rev 3 §6.2)
10. **Nostr needs secp256k1 keys; agent IDs are Ed25519.** Each agent derives
    a stable Nostr "carrier" key: HKDF-SHA256(seed, info
    `"rdv1/nostr-carrier"`). It signs the Nostr event only; authenticity
    comes from the envelope signature. The `p` tag is the hex Ed25519 public
    key of the recipient. (folded into SPEC rev 3 §6.2)
11. **Discovery on Nostr**: topic documents use the same kind, with a `t` tag
    holding `dtopic` and `d` = hash of the content. (folded into SPEC rev 3 §6.2)
11a. **Public relay survey (2026-10-25, PLAN §4.4 / step 2.4).** Per relay:
    publish two 30417 events (~2 KB, distinct `d`), read back by `#p` and `#t`
    on a new connection; same for regular kind 4417. Two runs, 5 min apart. (folded into SPEC rev 3 §6.2 (summary only; raw results stay here))

    | relay | software | 30417 + `#p`/`#t` + 2 `d` kept | live scenario (2.5) | note |
    |---|---|---|---|---|
    | nos.lol | strfry 1.1.3 | yes | pass | clean |
    | relay.primal.net | strfry 1.1.3 | yes | pass | max 20 subscriptions |
    | nostr.mom | strfry 1.1.3 | yes | pass | clean |
    | offchain.pub | strfry 1.1.0 | yes | not run | clean; spare |
    | relay.damus.io | strfry 1.1.0 | yes | passed once, failed once | intermittent HTTP 503 on connect, readback alternates full/empty |
    | relay.snort.social | memlay (in-memory) | yes | not run | events lost on restart; 10 s idle timeout |
    | relay.nostr.band | n/a | n/a | n/a | unreachable in both runs |

    No relay wanted auth or payment, restricted the kind, or rejected 2 KB
    content (smallest `max_message_length` is 128 KB). **Recommendation:**
    demo on `wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`
    (`offchain.pub` as a fourth); damus only as an extra. **No relay-side
    difference between 30417 and a regular kind** (4417 behaved identically,
    including damus's 503s), so item 9's case for a regular kind is
    semantic (no `d` fragility), not empirical. Not tested: same-`d`
    overwrite, long-term retention.

    **Step 2.5 live results (2026-10-25).** `npm run test:live`, contact
    scenario: `ws://<relay-host>:7777` (own strfry on relay-host) pass;
    `nos.lol` + `relay.primal.net` together pass; `nos.lol`,
    `relay.primal.net`, `nostr.mom` each alone pass (about 5 s each). Two
    machines (John on relay-host, Omer on Windows) via the relay-host relay: pass twice
    (`packages/cli/scenarios/two-machine.md`). Raw survey data and script were
    kept outside the repo.

    **Second survey (2026-10-25, 28 relays, issue #20).** On each relay: the
    contact and dinner scenarios, then a 10-minute retention check (the
    events are still served on a new connection).

    | relay | result | reason |
    |---|---|---|
    | nos.lol | pass | default |
    | relay.primal.net | pass | default |
    | relay.nostr.net | pass | default |
    | nostr.oxtr.dev | pass | default |
    | nostr.mom | pass | spare |
    | nostr.data.haus | pass | spare |
    | nostr-01.yakihonne.com | pass | spare |
    | nostr-pub.wellorder.net | pass | spare (nostr-rs-relay) |
    | relay.damus.io | fail | rate-limited, then banned the pubkey after about 3 runs |
    | offchain.pub | fail | web of trust: takes a few events from an unknown pubkey, then rejects |
    | nostr.bitcoiner.social | fail | web of trust, as offchain.pub |
    | purplepag.es | fail | blocks kind 30417 (profile and relay-list kinds only) |
    | relay.coinos.io | fail | blocks kind 30417 |
    | relay.snort.social | fail | times out |
    | NIP-05-only relays | fail | need a verified NIP-05 name |
    | paid relays | fail | need payment |
    | several others | fail | dead (no connection) |

    Redundancy: one dead relay plus two good ones passed. The smallest
    `max_message_length` on a passing relay is 128 KB. The first survey's
    "no relay-side difference" still holds for the relays that pass: they
    treat 30417 like any other kind. But relay policy does differ: kind
    filtering, web of trust and rate bans exist. A relay set therefore has to
    be checked live, and the transport has to expect rejections (item 69).
    `npm run test:live` once failed on nos.lol and nostr.mom with
    "connection failure" when its three test files ran in parallel, though
    each scenario passed alone: per-IP connection limits. The live runs are
    serial now.

## Contact flow

12. **Listen-mode probe = a contact request posted on the target's `dtopic`**,
    with `to_hint` set to the address. The listener gates it exactly like an
    inbound request with binding `claimed`. No separate probe document is needed. (folded into SPEC rev 3 §4.4)
13. **The grant carries the grantor's card** (**spec change**, §5.3). The
    requester otherwise has no way to reach the grantor after a topic probe. (folded into SPEC rev 3 §5.3)
14. **Tier cap for `claimed` bindings** applies to the *default* tier offered
    at consent time. An owner who explicitly picks a higher tier counts as the
    "explicit human confirmation" in §4.4. (folded into SPEC rev 3 §4.4)
15. **Grant direction.** A grant authorizes the requester to contact the
    grantor. Because the requester initiated, it accepts the grantor contacting
    it back within the same scope. (folded into SPEC rev 3 §5.3) **Revised
    after the security review (H1/H2):** a received grant sets only
    `outboundScope`. The grantor's rights towards us (`inboundScope`) start
    at `DEFAULT_INBOUND_SCOPE` (may write, no meetings, no calendar,
    `50/day`) and our tier for it at `stranger`, until our own human grants:
    `rdv contact grant <agent-id>` (`Agent.allowInbound`). Otherwise a peer
    picked its own rights over us, and a model could be talked into
    requesting contact with a pending requester and so let it drive dinner
    negotiation with no human. Limitation (fixed by item 60, issue #14): the
    grantor's own `outboundScope` was just `may_initiate` (nothing told it
    what we allow), so the grantor side could not start a negotiation. Our
    human's grant now also goes to the peer as a reverse grant. (**spec change**,
    folded into SPEC §5.3, §5.5, §7.4)
16. **`max_frequency`** is `"<n>/<minute|hour|day>"`; exceeding it revokes the
    grant (§10). (folded into SPEC rev 3 §5.3)
17. **Resend**: a gap in `seq` buffers later envelopes and sends
    `{type: "rdv/resend", from_seq, to_seq}`; the sender replays from a
    64-envelope outbox. (folded into SPEC rev 3 §7)

18. **Who may answer a request** (**spec change**, §5.3). A request sent to a
    specific card is only satisfied by a grant signed by that card's agent;
    the library rejects any other grantor before touching state. A topic
    probe can be answered by *anyone* who saw it on the `dtopic`, so its
    grant is always recorded as `claimed`. The spec should say both, and
    should tell the requester to show the grantor's fingerprint (and whether
    its card even claims the probed address) to the human before trusting
    the new contact. (folded into SPEC rev 3 §5.3) **Now enforced** (security
    review H1): a probe answer whose card doesn't claim the probed address is
    dropped; the rest become *candidates* (`book.candidates`, at most 16 per
    probe, one per grantor, and no global cap, so one probe's flood can't
    evict another's) and the probe stays open, so a first answer from an
    eavesdropper can't displace the real target. Grantor keys are free, so a
    flood can still fill a probe; further answers are counted on the probe
    (`outstanding[id].dropped`) and shown to the human (`probe-overflow` in
    `listen` and `rdv contact pending`, `probe_flooded` / `flooded_probes` in
    the MCP server) with the advice to redo that contact by card. The human picks one with
    `rdv contact confirm <grant-id>` (or `reject`), or through the MCP
    server's human gate (`rdv_grant` with `grant_id`); the others are dropped.
    `verifyGrant` also rejects tiers outside the enum.
19. **Requester-side binding.** The requester records how it found the peer
    (`claimed` for a topic probe or a public pointer, `in-person` when the
    owner says the card came from a QR code / face to face). §4.4 says
    bindings attach to the relationship record; it doesn't say the requester
    keeps one too. It should. (folded into SPEC rev 3 §4.4)
20. **Gap buffer bounds.** Out-of-order envelopes are buffered only for
    contacts and agents we asked by card, at most 16 peers × 64 envelopes,
    and persisted with the agent state. The spec's resend text (§7) should
    say receivers may bound and drop. (folded into SPEC rev 3 §7)
21. **Channel state for strangers** (fixed, issue #3; see item 64). `Channels.acceptInbound`
    advanced `seq` for any validly signed envelope, before the contact book
    decided whether to admit it. A stranger can't spoof another sender, so
    this only cost memory per stranger ID. (folded into SPEC rev 3 §11.10)

22. **Document IDs are UUIDs** (**spec change**, §5). Request, grant and
    revoke `id` (and a grant's `request_ref`) must be RFC 4122 UUID strings;
    the library rejects anything else, so peer-chosen IDs can't smuggle
    terminal escapes into a UI. The spec shows UUIDs but doesn't require them. (folded into SPEC rev 3 §5.1)

## CLI (`rdv`)

23. **Single writer per home.** Every command takes `lock` (O_EXCL file with
    pid/host; broken when the owning pid on this host is gone, or after
    10 min) and writes state temp-then-rename. `listen` holds the lock only
    per inbound item and reloads state from disk each time, so other
    commands can run beside it; it is the pattern the MCP server should use.
24. **Relays replay on every subscribe.** Subscriptions ask for a 2-day
    lookback, so `listen` sees old events again after each restart.
    Channels and replay IDs make that harmless; `listen` hides duplicate
    drops in text mode. The transport subscribes to each relay separately:
    when one relay drops, only that one is re-joined, with its own backoff
    (1 s doubling to 30 s), while the others keep running. A re-join asks
    for events since the newest `created_at` that relay delivered minus
    `rejoinMarginSeconds` (default 300, for clock skew), or the full
    lookback if it delivered nothing; the subscription de-duplicates event
    ids across relays and re-joins (last 4096 ids) (issue #6).
25. **Card vs config.** The card is built at `rdv init`. Editing relays in
    `config.json` changes where this agent connects, not the hints its card
    advertises; re-init (new key) to change the card. Card re-issue without
    a new key is follow-up work.
26. **`send --json`.** The command table uses `--json '<payload>'`, which
    collides with the global `--json` flag. For `send`, `--json` carries the
    payload and also switches output to JSON; `--payload` is the same
    without JSON output.
27. **First live runs (2026-10-25, not the PLAN §4.4 survey).** The contact
    scenario passed on `wss://nos.lol` and `wss://relay.damus.io` (together
    and each alone). One damus run failed: first `listen` lost its socket
    and exited (fixed: re-subscribe + keep-alive), then a publish hit
    "connection failure" once and passed on retry. Treat damus as flaky
    until PLAN step 2.4 measures it.

## A2A tasks (`@rendezvous/a2a`, step 3)

28. **A2A mapping** (**spec change**, §7). §7 says "A2A task objects" but not
    which. The library sends two payload types inside the envelope:
    `a2a/message` carrying an A2A v0.3 `Message` (one negotiation turn), and
    `a2a/task-update` carrying a `TaskStatusUpdateEvent` (an acknowledgement).
    A whole `Task` object is never sent: each side keeps its own copy.
    A2A assumes a client and a server agent; here both peers are agents, so
    `role` is always `"agent"`. The spec should say both. (folded into SPEC rev 3 §7.1)
29. **Meeting verbs** live in the message's single `data` part as
    `data.rdv`: `meeting/propose` and `meeting/counter` (1–3 `slots`,
    optional `place`, `expires`), `meeting/accept` (one `slot`),
    `meeting/decline` (`reason`), `rdv/cancel` (optional `reason`, by the
    message's `taskId`). Text parts are for humans and never drive anything.
    The spec defines none of this. Validation is strict (unknown keys,
    unknown verbs, non-UUID ids, more than 3 slots are rejected), which leaves
    **open how to extend it**: a version field or an A2A extension URI. (folded into SPEC rev 3 §7.2, open question §11.11)
30. **Slots** are RFC 3339 date-times with an explicit offset (`Z` or
    `±HH:MM`), compared as instants, so an accept may write the slot in
    another offset. At most 12 h each. Local time in the CLI is a fixed
    offset (`--tz`, the calendar's `timezone`, or the machine's current
    offset); no IANA zones, so no DST inside a window. (folded into SPEC rev 3 §7.2)
31. **Task states.** submitted (proposal out) → input-required (responder
    countered) / working (proposer countered back) → completed | rejected |
    canceled. "Pending" (§7 cancel) = not terminal. A round is one offer;
    the receiver of the third offer declines if nothing fits. An accept must
    pick a slot from the *latest* offer it answers. (folded into SPEC rev 3 §7.3)
32. **Two dedupe layers.** `Channels` drops a re-delivered envelope (same
    `seq`); the engine drops a re-sent message (same `messageId`, new
    envelope) per task. §7's "receiver deduplicates by ID" should name
    `messageId` for A2A. (folded into SPEC rev 3 §7)
33. **Cancel.** Honored while pending. A cancel that arrives before its
    proposal leaves a tombstone so the proposal is refused when it lands. A
    cancel (or any verb) for a finished task is answered with a status
    update giving the real end state. (folded into SPEC rev 3 §7.3)
34. **Scope** (**spec change**, §5.3). Meeting verbs need
    `may_propose_meetings: true` in the grant for that direction (item 15,
    revised): `dinner propose` and replies on a task we proposed use
    `outboundScope`; a task the peer starts uses `inboundScope`
    (`inboundMeetingScope` in `negotiate.ts`). `may_access_calendar` absent counts as
    `free_busy` (proposing a slot is a free/busy disclosure); `none` blocks
    negotiation; `full` still only ever shares slots. The calendar adapter
    strips titles, so `free_busy` holds by construction. The spec should
    define these defaults; core's default grant scope has no
    `may_access_calendar`. (folded into SPEC rev 3 §7.4)
35. **Bounded peer state** (security review). Only a meeting-capable grant
    may create tasks or tombstones; at most 32 tasks per peer (finished ones
    and tombstones evicted first; refused when all are pending); finished
    tasks pruned after 30 days; a peer's `expires` defaults to 48 h and is
    clamped to 7 days. (folded into SPEC rev 3 §7.4)
36. **No commit phase** (fixed, issue #5; was open, SPEC rev 3 §11.8). Now
    accept → confirm, see item 58. Before: the acceptor completed and held the
    slot when it sent `meeting/accept`, kept the hold if the proposer had
    canceled or expired meanwhile, and concurrent negotiations could
    double-book a slot.
37. **Crash window** (fixed, issue #4). `Agent.beforeSend` runs after an
    envelope is committed to the channel state and outbox and before it
    leaves; the CLI and the MCP server save agent state there (and, in
    `listen`, the inbox entries first). Negotiation state is saved before its
    replies go out. A crash right after a send can no longer reuse `seq`; the
    worst case is an inbox entry delivered twice. Regression tests: core
    `agents.test.ts` and CLI `crash.test.ts` (`RDV_TEST_EXIT_AFTER_SEND`). (folded into SPEC rev 3 §7)
38. **Live run (2026-10-25).** `ws://<relay-host>:7777` (relay-host strfry):
    overlap scenario via `npm run test:live` passed in about 5 s (agreed
    Tue 27 Oct 19:00+02:00); all four variants by hand
    (`dist/scenarios/dinner.js`) passed. Public relays not tried for step 3.

## MCP server (`@rendezvous/mcp`, step 4)

39. **Consent must bypass the model** (**spec change**, §5.3, §13). §13's
    `rdv_grant` reads as if the assistant approves. An assistant that can
    grant on its own (or be talked into it by a greeting) defeats consent. The
    server grants only through an MCP elicitation answered by the human, a
    per-request confirm phrase shown only on human channels (stderr,
    `rdv contact pending`), or `rdv contact grant` in a terminal. Phrases
    approve tiers `friend` and below. The spec should require that approval
    come from the human through a channel the model can't answer, and say so
    in §13. (folded into SPEC rev 3 §5.5)
40. **Peer text is untrusted data** (**spec change**, §5.3, §7). Greetings,
    text parts and decline reasons are written by the other side and can carry
    instructions aimed at the reader's assistant. The spec should say they are
    display-only, that only machine (`data`) parts may drive actions, and that
    short structural fields (payload `type`, IDs, tiers, states) are validated
    against strict shapes. The server quarantines everything else as
    `untrusted_peer_text`. (folded into SPEC rev 3 §5.6)
41. **A topic probe's greeting is public** (**spec change**, §4.4). A contact
    request posted on a `dtopic` is cleartext on the relay (greeting and the
    requester's card); only envelopes are encrypted (`demo/relay-dump.mjs`
    shows both). The spec should warn that probe greetings are public and keep
    them short. Requests sent to a known card travel inside an envelope. (folded into SPEC rev 3 §4.4, §5.1, §9)
42. **Auto-negotiation within scope** (fixed, issue #8; was open, SPEC rev 3
    §11.8). The server still counters on its own from the calendar, but a
    slot it would accept, or a peer's accept of our slot, is only held
    tentatively until the human confirms that meeting: `rdv_negotiate`
    action `confirm` through elicitation or a per-dinner confirm phrase
    (same rules as item 39; shown on stderr and in `rdv dinner list` text
    mode, never in a tool result), or `rdv dinner confirm` in a terminal.
    `rdv listen --negotiate` waits the same way unless `--auto-confirm`
    (bots, the scenarios' `duplicate` variant). Each side's human confirms
    once. **spec change**, SPEC §5.5 and §7.3 (rev 3, amended). Phrases
    are scoped by action (`consent.json` keys `request:<id>`,
    `candidate:<id>`, `meeting:<id>`, each entry storing its action):
    request, grant and task IDs are all peer-chosen, so a peer could make
    its dinner's task ID equal its contact request's ID and have the
    "approve contact" phrase confirm the dinner, or the reverse.
43. **Inbox is an event log, not an ack queue** (§13 says "receive/ack").
    `rdv_inbox` returns events after a cursor from the home's `events.jsonl`;
    nothing is acknowledged back to the peer. (folded into SPEC rev 3 §13)
    **One inbound consumer per home** (issue #9): `rdv listen` and `rdv-mcp`
    used to both subscribe, and whichever handled an envelope first took it,
    so the MCP inbox missed what `listen` saw. Now the consumer holds
    `listener.lock` for its lifetime (long-lived variant of item 23's lock:
    one attempt, pid/host/role, mtime heartbeat every 60 s, stale when the pid
    is gone on this host or after 10 min without a heartbeat) and appends
    each handled event to `events.jsonl` (under `events.lock`, after the state
    is saved; cursor `n` only grows; compacted to 1000 lines at 2000; relay
    replays and stranger-caused drops are not written). A second `rdv listen`
    is refused (exit 1, names the holder). A second `rdv-mcp` attaches: no
    subscriptions, sends work, and its inbox is a view of `events.jsonl`, so
    all servers on a home show the same events and cursors. It retries the
    lock every second and takes over when the holder exits; the relays'
    2-day lookback replays the gap and channel state drops what was handled,
    so nothing is lost or doubled. Chosen over "refuse both" because several
    MCP clients on one profile (two Claude sessions) are normal. Limits: the
    consumer's negotiation settings decide whether peers' dinner replies are
    answered; `mcp-events.jsonl` from older versions is no longer read.
44. **Calendar settings** come from the server's arguments; `rdv_init` and
    `rdv_negotiate` may replace them for the server's lifetime (not
    persisted). The responder uses the same window for every peer.
45. **Live run (2026-10-25).** `npm run test:live -w @rendezvous/mcp` (two MCP
    servers, confirm-phrase approval, dinner to `completed` on both sides):
    `ws://<relay-host>:7777` alone pass (about 1.1 s); relay-host + `wss://nos.lol`
    + `wss://relay.primal.net` pass (about 1.6 s); nos.lol + relay.primal.net
    pass (about 2.7 s). Agreed Wed 28 Oct 19:00+02:00 each time.

## Security review fixes (2026-10-25)

Independent review of the implementation; H1/H2 are under items 15 and 18.
46. **Peer-driven state is bounded** (M1). Pending requests: 64 in all and
    4 per sender (more are dropped as `rate-limited`). A full list evicts the
    weakest request, the newcomer included: lowest binding first, then topic
    probes before requests sent to our card (today every inbound binding is
    `claimed`, so this is the split that matters), then the oldest. "Sent to
    our card" (`PendingRequest.direct`) is recorded at receipt: it arrived in
    an envelope to our key *and* its `to_hint` is our own id; a to_hint alone
    is sender-chosen and counts for nothing. The
    evicted id leaves `seenIds` so the requester's retry is accepted, and
    `book.pendingEvicted` counts drops for the human (`pending-evicted` in
    `listen` and `rdv contact pending`; `pending_flooded` in the MCP server,
    on the first drop and every 50th).
    Declined request ids live in their own list (1000), so a flood of fresh
    ids that evicts `seenIds` can't bring a declined request back. `listen`
    and the MCP server drop envelopes that don't open for us and invalid
    topic docs before taking the lock (`isJunk`), and skip the `agent.json`
    rewrite when an item changed nothing (relay replays). The MCP event log
    keeps the last 1000 events in memory, reads by cursor, and hides drop
    reasons a stranger can cause at will; the shared `events.jsonl` behind
    it (item 43) is compacted at 2000 lines and never gets those drops.
47. **Calendar files are strict, and MCP calendar paths are fenced** (M2).
    A calendar is exactly `{ "busy": [...], "timezone"?: … }` with entries of
    `start`/`end`/`title`; any other JSON is refused before it is read for
    slots or rewritten by `hold` (which is what chmods it), so the model can
    no longer turn `package.json` into a calendar. The MCP server takes
    model-supplied calendar paths only inside its home, the `--calendar`
    directory or a `--calendar-dir`, after `realpath`, and the `.json` check
    escapes the dot.
48. **Durable state writes** (M3). `writeAtomic` fsyncs the temp file
    before the rename and the directory after it (POSIX; Windows can't fsync
    a directory and NTFS journals the rename). `writeAgentState` first copies
    the current agent.json, if it parses, to `agent.json.bak` (mode 600);
    `readAgentState` falls back to the backup when agent.json is missing,
    empty or torn, and says so on stderr. The secret key is in both.
49. **Stale-lock breaking** (L1). Breaking a stale `lock` takes a
    short-lived `lock.break` (O_EXCL) and re-reads the lock under it, so two
    waiters that saw the same stale content can no longer have the second
    one delete the first one's fresh lock. A `.break` left by a crash is
    cleared after 5 s.
50. **A probe is bound to its topic** (L2). A topic doc is handled only if
    it arrived on one of our own `dtopic`s and its `to_hint` maps to that
    same topic, so a probe for John re-posted on Carol's topic is dropped
    (Carol never grants a request that was not meant for her).
51. **Replay work is bounded** (L3). `rdv/resend` from a contact is honored
    at most 10 times an hour (`RESEND_LIMIT`, over the limit it is dropped,
    not revoked). For a finished task the engine keeps at most 64
    `messageId`s and answers with a status update at most 8 times
    (`FINISHED_REPLIES`); later replays are ignored silently.
52. **Envelope lifetime is bounded** (L5, **spec change**, §6.4). `openEnvelope`
    rejects `ttl` over 7 days and `created` more than 5 min in the future;
    `sealEnvelope` refuses a ttl over 7 days. The test vector envelope was
    regenerated with `ttl: "7d"` (it had `3650d`); nothing else in the
    vectors changed.
53. **`listen --auto-grant` stops at the binding default** (L7). Every
    inbound binding is `claimed`, so `--auto-grant friend` gave that tier to
    whoever claimed the address first. A tier above `stranger` now needs
    `--auto-grant-any-tier` (the demos pass it); library callers of
    `handleInbound` get the tier capped at `defaultTier(binding)` unless
    `autoGrantAnyTier`.
54. **Timestamps fail closed** (follow-up to L5). `Date.parse("garbage")` is
    NaN, and NaN makes every expiry comparison false: an envelope, card,
    grant or contact with a garbage date never expired. Core now parses every
    peer timestamp with `parseTimestamp` (strict RFC 3339 with an offset;
    impossible dates refused): envelope `created`, card `created`/`expires`,
    request/grant/revoke `ts`, grant `expires` are rejected when unreadable,
    and `isPast`/`isExpired` treat an unreadable stored date as expired. The
    a2a engine already validated peer slots and `expires` with
    `parseInstant`; its own `expires` handling now uses it too (an unreadable
    stored `expires` is expired by the sweep).
55. **A busy lock no longer drops inbound items** (L8). `handleInbound`
    retries a lock timeout (60 s × 12 attempts, past the 10-minute stale
    threshold) instead of failing the item after one 60 s wait; only then
    does the error reach `listen` / the MCP server log. Topic docs were
    otherwise lost until the next reconnect replay.
56. **Lost or reused envelopes are reported** (L4, partly). A buffered
    envelope that no longer opens when its turn comes (its ttl lapsed while
    waiting for the gap) still advances the chain, which would stall
    otherwise, but now emits `dropped: buffered envelope lost (…)`. A
    different envelope carrying the seq we last accepted (a peer that
    restored old state) is a fork, not a duplicate.
    **Rollbacks of any depth** (fixed, issue #13, **spec change**, §6.4, §7).
    Each channel keeps the hashes of the last 8 accepted inbound envelopes
    (`ROLLBACK_WINDOW`, `inRecent`) and the newest accepted `created`
    (`inNewest`); nothing grows with the chain. An envelope with
    `seq <= inSeq` is a `rollback` when its hash differs from the one we hold
    for that seq, or, below the window, when its `created` is newer than
    everything we accepted (a relay replay can't be: it is one of those
    envelopes). Identical bytes stay a silent duplicate. A `prev` mismatch at
    `inSeq + 1` is a `fork`. Either one sets `refused` on the channel and is
    reported as `dropped: envelope chain fork (rollback)` / `envelope chain
    fork` with `{peer, seq, accepted}`; every later envelope from the peer is
    `envelope chain fork (channel refused until resync)` (a replay of the
    forking envelope itself stays silent). Nothing from either chain is
    dispatched, buffered or answered with a resend. **What happens next:**
    the owner checks with the peer's human, then re-syncs locally
    (`Agent.resyncChannel`, `rdv contact resync <agent-id>`); the library and
    the MCP model never do (the MCP event carries a `next_step` that hands it
    to the human). A re-sync adopts the next envelope newer than `inNewest`
    as the chain head, so replays of the old chain can never take over;
    envelopes refused in between are not replayed. The re-sync also sets
    `inFloor` (the old chain's `inNewest`; for state without one, the
    forking envelope's `created` − 1 ms): any envelope not newer than it is
    a duplicate on every path. Without it a relay replaying the old chain
    past a lower new head hit the gap or fork path and refused the channel
    again with no human involved (security hook, MEDIUM). Without a re-sync
    the same replays can't fork: they are the one chain we hold, so they
    either match `prev` or fill a real gap. `refused`/`resync`/`inFloor`
    persist in `agent.json`. A stranger can fork only its own channel, so
    its drops read `envelope chain fork from a non-contact` and stay out of
    the event log (`STRANGER_DROPS`). `openEnvelope` now also rejects a
    `seq` that is not a positive integer. Left open: a reused seq below the
    window whose `created` is also not newer (the peer's clock went back
    further than its last envelope) still reads as a duplicate; detecting
    that needs a hash per seq or a chain-reset message (v0.2).
57. **Confirm phrases are hashed and bound to the terms** (L6, fixed,
    issue #12; **spec change**, §5.5). `consent.json` (mode 600) used to
    hold each phrase in clear text, so a model with file or shell access to
    the home could read it and approve on its own, and the phrase did not
    bind the tier (any from `friend` down) or `may_propose_meetings`, which
    the model picks. Now:
    - **Stored as a hash.** Each entry keeps `salt` (16 random bytes) and
      `hash` = scrypt(N 2^14, r 8, p 1) over `rdv1/consent-phrase`, action,
      ID, digest and the normalized phrase, compared with `timingSafeEqual`.
      scrypt because the phrase has only ~28 bits: a fast hash would be
      reversed in seconds; this costs on the order of 2^28 × tens of ms of
      CPU per entry. `previous` (to report a replaced phrase) is a hash too.
      The code moved to `packages/cli/src/consent.ts` (re-exported by the
      MCP server's `consent.ts`) because the terminal re-issues phrases.
    - **The terminal re-issues.** A stored phrase can't be shown again, so
      `rdv contact pending` and `rdv dinner list` (text mode only; `--json`
      changes nothing) replace each current phrase with a new one for the
      same digest and show that, with the terms it approves. The latest
      phrase shown wins; an older one is refused as replaced (`stale`, not
      a counted guess).
    - **Bound to what the human saw.** A request phrase is bound to
      `subject` (sha256 of request id, sender, binding, `direct`, receipt
      time) and to `terms` (tier and full scope), via `digest` = sha256 of
      both. The server issues it for the default terms and says them on
      stderr. `rdv_grant` with a phrase checks the tier cap first, then the
      digest of the terms the model asked for: other terms are refused
      (`terms`, no try counted) and the human gets a new phrase for exactly
      those terms ("Your assistant asks to approve it as: …"), which
      replaces the old one. A phrase-less `rdv_grant` for other terms does
      the same, once. Another request under the same peer-chosen ID (other
      sender, or evicted and sent again) is another subject, so a new
      phrase. Probe answers are bound to grant id, grantor, probe and
      receipt time (`candidateDigest`); meetings as in item 59.
    - **Checked again where the grant happens.** The phrase (or form) is
      checked before the grant, outside its lock, so a request could take
      the same ID in between. The grant itself (under the home lock)
      re-reads the pending request and refuses unless `requestSubject`
      still matches the one the human reviewed (`candidateDigest` for a
      probe answer); the phrase is dropped only after the grant went
      through. The dinner confirm already does this (`boundStep`, item 59).
    - **Old files fail closed.** An entry with a plaintext `phrase`, no
      hash, a malformed `previous`, or `terms` that don't hash to its
      `digest` approves nothing, the terminal shows nothing for it, and the
      next write (the server syncs at startup) drops it; the server issues
      and announces a hashed phrase for each target still waiting.
    Honest limit: a same-user model can still read a phrase **while it is
    shown** (scrollback, the server's stderr if it can read the client's
    MCP log, or by running `rdv contact pending` itself, which also issues
    one) and, with shell access, can simply run `rdv contact grant`. Hashing
    only stops recovering the phrase from disk later. Where the model has a
    shell, use elicitation, deny it the home and those commands
    (`demo/SCRIPT.md`), or run `rdv-mcp` as another OS user. Elicitation
    is unchanged: the form shows the tier and scope, and the human's tier
    wins.

58. **Accept → confirm, exclusive holds** (**spec change**, §7.2, §7.3,
    issue #5). New verb `meeting/confirm` (`slot`), sent by the offerer in
    answer to `meeting/accept`. The accepter holds the slot tentatively
    from the moment it decides (before its human confirms, so concurrent
    tasks can't take it), sends accept, and completes only on the confirm,
    acknowledging with a `completed` status update. The offerer re-checks
    the slot when the accept arrives (offers are not held): busy (another
    task holds it, or the calendar changed) or past `expires` → decline,
    which releases the accepter's hold. The engine counts every other
    task's tentative hold and every completed agreement as busy, so one
    `receive` batch can't double-book either. Releases: cancel (either
    side, incl. the owner's while the human sits on it), decline, expiry,
    and a peer status update reporting `canceled`/`rejected` while we hold
    (reduce-only exception to "status is informational"). The pending
    sub-state lives in `task.hold.stage` (`human-accept`, `human-confirm`,
    `peer-confirm`); task states on the wire are unchanged, so old peers
    only fail on the new verb. Calendar: `Dinner (tentative, rdv <task>)`
    becomes `Dinner (rdv <task>)`; the CLI remembers which calendar holds
    each tentative hold in `holds.json`. Residual race, open: an accepter
    gives up `CONFIRM_GRACE_MS` (24 h) after `expires`; a confirm sent in
    time but delayed longer, or the accepter's owner canceling while the
    confirm is in flight, ends `completed` on the offerer and `canceled`/
    `rejected` on the accepter. The accepter answers the late confirm with
    its real state, so the offerer sees it as `peerState` (and a `status`
    event) but keeps its hold, because a cancel after completion is not
    honored (§7.3). Cancelling an agreed meeting: item 61.
59. **Meeting consent is bound to the meeting, not the task ID**
    (**spec change**, §5.5; security fix on top of item 42). The human's
    approval used to land on whatever the peer-chosen task ID pointed at
    when the confirm ran: the server read the task, asked the human
    (elicitation, or a phrase issued earlier), then called `confirmMeeting`
    on the task as it was by then. A peer can change it in between: cancel,
    push the canceled task out of the per-peer cap (`MAX_TASKS_PER_PEER`)
    with finished filler tasks, and propose again under the same task ID
    with another slot (engine test "consent is bound to the reviewed
    meeting"); after pruning, another peer could reuse the ID too. A phrase
    stayed valid for the new hold. Now the host snapshots what the human
    reviews (`MeetingSnapshot`: task ID, peer, contextId, our `created`,
    hold stage, slot start/end, place) and `confirmMeeting(..., expected)`
    throws `MeetingChangedError` unless the task still matches it, checked
    under the home lock. `rdv-mcp` refuses with "changed since your user
    reviewed it" and re-issues; nothing is saved or sent. Each meeting
    phrase stores `digest` = sha256 of the snapshot (`meetingDigest`) and
    `checkPhrase` requires it to match; any dinner event re-syncs phrases,
    so a task that ends loses its phrase and a changed hold gets a new one
    (the old one is kept as `previous` only to report it as stale; legacy
    phrases without a digest approve nothing). The elicitation "decline"
    cancel is bound the same way. `rdv dinner confirm` now needs
    `--hold <code>`, the first 12 hex digits of the digest, shown by
    `rdv dinner list` (text and `hold_code` in JSON) and in the server's
    phrase notice; a code that no longer matches is refused.
## Contact flow, continued

60. **Reverse grant** (**spec change**, §5.3, §5.5, §7.4, issue #14; closes
    the limitation in item 15). When a human grants an existing contact
    rights towards us (`rdv contact grant <agent-id>`, `Agent.allowInbound`),
    the agent applies it locally as before and also sends the peer a signed
    reverse grant, so the peer learns what it may do; the grantor of the
    original contact can then propose a dinner. Wire format: the same
    `rdv/contact-grant` document and signing path, with `grant_ref` (the id
    of the grant that founded the contact, which both sides store as
    `Contact.grantId`) **instead of** `request_ref`. A document with both
    fields, or with neither, is invalid; `verifyGrant` refuses anything with
    `grant_ref` and `verifyReverseGrant` anything with `request_ref`, so a
    peer-chosen grant id that happens to equal one of our open probe ids
    (probes are public) can't turn one kind into the other. Older peers drop
    a reverse grant (no `request_ref`), which is the safe failure. A
    separate document type was not needed. Rules, in
    `ContactBook.receiveReverseGrant`:
    - It sets only our `outboundScope` (and `grantedTier`, display only),
      never the sender's `inboundScope` or our tier for it: same invariant as
      item 15. Only the human's `allowInbound` sends one; nothing in the
      library does it on its own (an allowlist auto-grant is a forward grant).
    - Accepted only from a current, unblocked contact, addressed to us,
      with `grant_ref` equal to that contact's `grantId` (so: we granted it,
      or it granted us, in this relationship). Otherwise dropped as
      `unexpected or invalid grant` (detail `reverse grant: not-contact` /
      `invalid`), before any state is touched; that reason is in
      `STRANGER_DROPS`, so strangers can't fill the event log with it.
    - Replay and staleness: its `ts` must be newer than the grant behind our
      current `outboundScope` (`Contact.outboundTs`, set from the forward
      grant on the requester side) and at most 5 minutes ahead of our clock
      (`REVERSE_GRANT_SKEW_MS`; a far-future `ts` would make every later
      update look stale), and its id must be unseen. The `ts` check holds
      even after a flood evicts the id from `seenIds`, so an older, wider
      grant can't undo a narrowing. Expired ones are refused.
    - `expires` can only shorten the contact (it ends when either side's
      grant does), never extend it. The library sends `expires` = the
      contact's own expiry.
    - Per contact, at most 10 an hour are processed (`REVERSE_GRANT_LIMIT`,
      `admitControl`; over the limit dropped, not revoked); the counter is
      kept only for existing contacts.
    - Revocation is unchanged: `rdv/revoke` (either side) deletes the
      contact, and with it whatever a reverse grant set; a later reverse
      grant then finds no contact and is dropped.
    Events: core `reverse-grant`, CLI `listen` `{event: "reverse-grant"}`
    with the contact view (`outbound_meetings` is new in every contact
    view), MCP `reverse_grant` (peer fields through `untrusted.ts`,
    summary built from validated fields). The MCP server grants an
    existing contact through `rdv_grant` with `agent_id` (item 66). Test vectors gained `contact_grant` and `reverse_grant`
    (deterministic ids, no other vector changed; regenerating now keeps the
    saved sample envelope unless `UPDATE_VECTORS=envelope`).

## Meetings, continued

61. **Canceling an agreed meeting** (**spec change**, §7.2, §7.3, §11.8;
    issue #20). New verb `meeting/cancel` (`slot`, optional `reason`).
    `rdv/cancel` stays for pending tasks; one after completion is still not
    honored. Only the owner sends it: `cancelMeeting` in the engine; `rdv
    dinner cancel <task>` sends it for a completed task (and `rdv/cancel`
    otherwise); in `rdv-mcp`, `rdv_negotiate` "cancel" on a completed task
    passes the confirm gate: elicitation, or a cancel phrase (consent action
    `cancel`) bound to the digest of `agreedSnapshot` (a `MeetingSnapshot`
    with stage `agreed`), issued to the human on the first call and shown in
    `rdv dinner list`; like every phrase it is stored only as a hash, so the
    list shows a new one that replaces it (item 57). The model may still cancel a pending negotiation alone,
    as before. **State:** `canceled`, with `agreed` kept as the record; no new
    task state or sub-state on the wire, so old peers fail only on the verb
    (unknown verb, dropped; their side stays `completed`; was open, now
    reported to the canceling human, item 65). **Receiving** needs no approval,
    since it only frees time and a peer still can't create commitments: honored
    only for a `completed` task with that peer, `contextId` and slot (as
    instants), regardless of grant scope like `rdv/cancel`; an unknown task,
    another peer, `contextId` or slot, or a pending task is `invalid` and
    changes nothing. The human is told through a new event `meeting-canceled`
    (CLI line; `rdv_inbox` with a next step to tell the user). **Idempotent:**
    the same `messageId` is a duplicate; a new one after the task ended is
    `ignored` and answered with its status (capped by `FINISHED_REPLIES`). Binding to task
    ID and `contextId` means a renegotiated meeting in the same slot (a new
    task) is never touched; only the peer itself can name a reused task ID
    (envelopes are signed and seq-deduped), and it could cancel anyway. **Race
    of item 58 closed:** a peer status `canceled`/`rejected` for a task we
    completed releases it too (`meeting-canceled`, reason "peer reports …"),
    the same reduce-only rule. **Calendar:** the release effect has
    `tentative`; `holds.json` keeps the calendar of a final hold until it is
    released, so the owner's cancel needs no `--calendar`. Agreements made
    before this change have no entry: pass `--calendar` (or give `listen`/
    `rdv-mcp` one). Open: a completed task evicted by the per-peer cap (item
    35) can no longer be canceled in-protocol. a2a only: no core wire change,
    vectors unchanged.

## Chat onboarding (Claude Code plugin)

62. **Setup by chat, consent still with the human.** `plugins/rendezvous`
    is a Claude Code plugin (the repo root is its marketplace) with an
    Agent Skill that walks install → `rdv_init` → `rdv_publish_card` →
    `rdv_discover` / `rdv_request_contact` → wait in `rdv_inbox` → `rdv_send`,
    and the receiving side through `rdv_pending_requests` and `rdv_grant`.
    No new tool grants anything; approvals still need the form or the phrase
    (items 57, 59). Choices:
    - **Launcher, not a PATH command.** `.mcp.json` runs `node
      bin/rdv-mcp.mjs`, which imports the build in `$RDV_DIR` or
      `~/.rendezvous/src` in-process. A bare `rdv-mcp` is a `.cmd` shim on
      Windows, which a stdio client can't spawn without `cmd /c`. When the
      build is missing it exits 1 with install instructions on stderr
      (stdout stays clean: it is the MCP channel).
    - **Consent guard hook** (PreToolUse, matcher `.*`: every tool). **It is
      defence in depth, not a security boundary**; the boundary is the MCP
      consent gate (items 57, 59) and running the server as another user. It
      makes drifting or injected attempts fail loudly. What it refuses:
      - The commands that approve or print a phrase (the list in the MCP
        README), now including `contact pending` and `dinner list` in any
        mode: the `--json` exemption was matched on raw text and could be
        spoofed (`rdv contact pending # --json`), and the assistant has
        `rdv_pending_requests` and `rdv_negotiate` "status" for them.
      - Naming a contact: `rdv contact label` (in every form the other
        subcommands are refused in), and `rdv contact request` with
        `--label` unless the target is an address (a probe, whose answer the
        human confirms with the label shown). Otherwise the model could
        relabel an impostor as `john@doe.com` and redirect "tell John".
      - Any command naming `agent.json`, `agent.json.bak` or `consent.json`,
        in any directory.
      - Any path-like tool field (`file_path`, `notebook_path`, `path`,
        `paths`, `glob`, Glob's `pattern`, and the same names in MCP tools)
        that is or reaches into a Rendezvous home: `~/.rendezvous` and its
        profiles (not `~/.rendezvous/src`), `$RDV_HOME`, and any folder that
        looks like one on disk (`config.json` beside `agent.json` or
        `consent.json`), which covers `--home` dirs. A search of a folder
        above `~/.rendezvous` or `$RDV_HOME` is refused too. A search with
        no path is checked as a search of the working directory, the same
        rules (it used to be checked as a single file, so a path-less Grep
        run from `~` or from inside a home got through). Shell words get
        the same check, including globs, `$RDV_HOME`, and `cd` earlier in
        the command; `ls`, `cd` and the like may name a home, `--home` may
        take one.
      Matching runs on a shell-style parse, not the raw string: quotes,
      escapes and line continuations removed, `#` comments dropped, brace
      expansion, `$(…)`, backticks and `<(…)` checked as commands of their
      own, `bash -c`, `cmd /c`, `pwsh -Command`/`-EncodedCommand`, `eval`,
      `iex`, and `node -e`/`python -c` code (with its string literals and
      argument arrays) checked recursively, each in both POSIX and
      PowerShell syntax. rdv dispatches on its first two arguments, so the
      guard refuses any two adjacent words that are a consent subcommand
      (`contact grant`, `dinner list`, …) wherever they appear, which
      covers `npx`, `pnpm`, `yarn`, `npm run rdv --`, `bin.js` and
      `Start-Process -ArgumentList`. A subcommand or home path built at run
      time (`rdv contact $X`, `xargs rdv contact`) is refused as uncheckable.
      Honest limit, same as item 57: a script file, an alias defined in an
      earlier call, or an interpreter it does not know still gets through.
      Each bypass form above has a regression test in `plugin.test.ts`.
    - **Skill lint.** `packages/mcp/test/plugin.test.ts` runs every inline
      command and code-block line of the skill and its references through
      the guard; a refused command may appear only in a paragraph that says
      it is the human's ("own terminal", "never run"), and never in a code
      block.
    - **Recipients resolve through a local label, not the card.** The first
      version exposed `claimed_addresses` from the peer's card and the skill
      resolved "tell John" with them, so a contact whose card claimed
      `john@doe.com` could get John's messages. Now `Contact.label` (local
      only, never sent) records what our human called them (how it gets
      there: next item). `rdv_status` shows it as `local_label`, the card's
      addresses as `unverified_claims`, and `label_conflict` when two
      contacts share a label (compared as canonical addresses, else
      case-insensitively). `rdv_send` takes `to` = a label and refuses when
      no contact or more than one has it, naming their fingerprints; the
      card's addresses never resolve. The skill finds people only by label
      and shows the fingerprint before the first message. Contacts made
      before this change have no label until the human names one
      (`rdv contact label <agent-id> <label>`). No wire change.
    - **A label is part of what the human approves** (security review of
      the first version, which took the label from the model or from
      discovery and applied it unseen; the model could approve John's
      request as `omer-bank@example.com`, or confirm an impostor as John).
      A label gets onto a contact only through:
      - the approval form of `rdv_grant` (request or probe answer): it
        shows the label next to the fingerprint as an editable field,
        prefilled with the model's `label` (a probe answer: the probed
        address, `candidateLabel`); what the human leaves there is stored,
        empty for none. A client that returns no `label` field leaves the
        one the form showed.
      - a confirm phrase: the label is hashed into its digest (`label` in
        `termsDigest` for a request, `candidateLabelDigest` for a probe
        answer) and shown with it, on stderr and in `rdv contact pending`
        ("it approves: …, local label …"). A phrase approves that label
        only: the model asking for another, or for none, is refused like
        other terms, and the human is shown a new phrase for exactly what
        it asked. The default request phrase has no label (rev 1 digest).
        A probe-answer phrase stored before this change (no `subject`), or
        any entry whose label no longer hashes to its digest, approves
        nothing and is dropped.
      - the human's CLI: `--label` on `rdv contact grant` / `request`, and
        `rdv contact label`. The consent guard refuses these to the
        assistant (above).
      Discovery never labels anything: anyone can publish a card on any
      address's topic, so `rdv_discover` only caches cards, and with one
      card or many the contact made by agent ID has no label.
      `rdv_request_contact` refuses `label` for a target that is not an
      address, because a request by card becomes a contact the moment the
      peer grants it, with no step where our human sees the label. A probe
      keeps its label (the address, or the model's) only as the proposal the
      confirm form or phrase shows. Same honest limit as consent: the guard
      makes the label commands fail loudly for a drifting or injected
      assistant, but a model with a same-user shell can still reach the
      home some way the guard can't see; the MCP gate is the boundary.
    - **What the plugin can't do:** in `claude -p` there is no elicitation
      (Claude Code cancels it), so headless runs fall back to the phrase.
      The phrase reaches the human through `rdv contact pending` in their
      own terminal or the server's stderr, which Claude Code only keeps in
      its MCP log, so the interactive form is the no-terminal path.

## Several addresses per agent

63. **Addresses change after setup** (**spec change**, §4.3, §4.4, §6.2;
    GitHub issue #9). One agent holds up to 8 emails and phones (`MAX_ADDRESSES`),
    canonicalized and deduplicated as `canonAddress` does (item 8: the whole
    email lowercased, phones as `+` and digits). `rdv init` takes repeated
    `--email` / `--phone`, MCP `rdv_init` takes `emails[]` / `phones[]`
    (singular `email` / `phone` kept as aliases), and
    `rdv address list|add|remove` / `rdv_addresses` change them later.
    Choices:
    - **Public or private, per address** (§4.3: listing is opt-in per
      address). A public address is listed on the card and opens its probe
      topic. A private one is kept in `config.json` (`private: true`) and
      nowhere else: it is not on the card, opens no topic, and is not a
      contact label either. It only records the address for the owner (and
      can be made public later by removing and adding it). The spec has no
      private field on the card, so none was added. Everything given at init
      is public, as before.
    - **Re-signing.** `v` is the card schema version, so a change re-signs
      the card (`reissueCard`) with `created` one second past both the old
      card and now. Lookup keeps, per agent ID, only the valid card with the
      latest `created`, and returns it only if it still claims the address.
      So an old card replayed on a topic loses to the newer one.
    - **Replaceable pointer.** A public-pointer card was a topic event with
      `d` = content hash, so every version stayed on the relays. Now its
      `d` is `rdv1/card:<dtopic>` (kind 30417 is addressable: relays keep the
      newest per pubkey, kind and `d`), and its `created_at` is
      max(now, the card's `created`). The second's margin in `created` makes
      every new version strictly later than any earlier publish, because a
      NIP-01 relay breaks a `created_at` tie by the lower event ID, which
      would keep a random version. A test caught this before the margin
      (about one run in ten). Probes keep the content-hash `d`. After a
      removal the new card is also published on the removed topic, where it
      replaces the old card, and `lookup` finds a card that no longer claims
      the address. The publish happens before the change is saved, so a
      relay failure changes nothing and the command can be retried. With the
      pointer off, nothing is published, and nothing on the relays listed
      the address.
    - **Honest limits.** A removal cannot recall copies of the old card:
      contacts and pending requesters hold it (inside the request or grant
      that carried it), a relay that missed the update keeps the old event,
      and anyone may have saved it. A strict relay may also keep the
      content-hash pointers published before this change. Lookup's
      newest-card rule covers a replay only where the newer card is on the
      same relay. There is no message that tells contacts about a new card;
      it travels with the next request or grant. A request that arrived on an
      address before its removal can still be granted, but the grant carries
      the new card, which no longer claims the probed address, so the
      requester refuses it (item 12).
    - **Live re-subscribe.** `Agent.setAddresses` moves a started agent to
      the new topics at once. `rdv listen` and a consuming `rdv-mcp` do not
      share an `Agent` with the command that made the change, so they follow
      the card on disk (`watchTopics`: a stat of the agent state every
      second, a read only when it changed) and re-subscribe; `rdv listen`
      prints a `topics` event. `rdv_addresses` re-subscribes its own server
      straight away. Until then nothing is lost the wrong way: each inbound
      item is judged against the card loaded under the lock, so a probe on
      a removed address is refused, and one on a new address waits at most
      the poll interval plus the relay's lookback replay.
    - **Owner setup, not consent.** Adding an address decides nothing about
      a peer, so `rdv address` is not on the consent guard's list and
      `rdv_addresses` needs no approval form. It is still strict: the MCP
      tool accepts only an address that is a plain email or E.164 phone
      after canonicalization, and no peer-supplied field reaches it.
      Removing an address never touches contacts.
    - **Test relay.** `startTestRelay` now implements NIP-01 addressable
      events (newest per pubkey, kind and `d`; a tie keeps the lower ID), as
      real relays do. The L2 test re-posted a probe from the same carrier
      key, which on such a relay replaces the original (same content, same
      `d`); it now re-posts from another key, as an attacker would.

## Channel state, continued

64. **Channel state only for admitted senders** (fixed, issue #3, **spec
    change**, §6.4, §11.10; was item 21). An agent keeps a `seq`/`prev`
    channel only for senders it has a reason to know: contacts (expired
    grants too), allowlisted agents, pending requesters, probe candidates,
    agents we asked by card, and any peer we have sent an envelope to. Any
    other sender's channel is created for the one envelope, used to classify
    it, and dropped once it is handled (`Agent.pruneChannels`, also on load,
    and `toJSON` never writes one). Pending requests are capped (64, item 46)
    and candidates are capped per probe (16, item 18, and the probes are our
    own); everything else on the list is our human's doing. So 10k fresh
    keys leave at most 64 channels behind, in memory and in the saved state.
    **Why not a capped LRU for strangers:** it bounds memory but not the
    real problem. A flood still evicts the one stranger that matters (a
    requester we declined, or one evicted from the pending list, who asks
    again later), and that sender's next envelope is then a `gap` from a
    non-contact, which is dropped: it could never reach us by envelope
    again. Deferring needs no cap to tune and keeps nothing for a sender
    we would refuse anyway. **The chain for a sender we hold nothing for**
    starts at its first envelope we see, whatever its `seq` and `prev`
    (`acceptInbound(e, { adopt: true })`): it may have written to us
    before (refused for want of a grant), or been declined, so its chain is
    already under way. Nothing is lost by this: until it is admitted, the
    only thing it can make us do is consider a contact request, and those
    are deduplicated by id (`seenIds`, `declined`). Once kept, its channel
    works as before: a requester's chain goes on from the request
    envelope's `seq`, so after the grant its next envelope is in order and
    a gap is buffered and resent (it is a contact by then); a relay replay
    of the request is a duplicate. Contacts' channels never pass through
    this path, so replay, gap/resend, fork and rollback detection and
    re-sync (items 17, 56) are unchanged, and a flood can't evict them:
    there is no shared table to evict from. **What changed for strangers:**
    one that forks its own chain is no longer told apart (each envelope
    starts a fresh chain and is refused as `no grant for sender`); a
    pending requester still can, and stays quiet (`envelope chain fork from
    a non-contact`). An evicted or declined requester's old request
    envelope, replayed by a relay after its channel is gone, is judged by
    the book again: a declined one stays declined; an evicted one may come
    back as pending (it left `seenIds`, item 46), bounded by the same cap.
    Wire format unchanged; vectors not regenerated.

## Extending the meeting verbs

65. **Verbs are A2A extensions** (**spec change**, §4.3, §7.1–§7.3, new
    §7.5, §11.8, §11.11; issue #4). Compared a version field in our payload
    with A2A v0.3 extension URIs (checked against the v0.3 spec: URIs in
    `AgentCapabilities.extensions`, `Message.extensions`, extension data in
    `metadata` keyed by URI, a new URI per breaking change, no new fields in
    A2A objects or enum values). Chose URIs; the comparison is in §7.5. In
    `@rendezvous/a2a` (`model.ts`):
    - `EXTENSIONS.meeting` = `https://rendezvous.nesher.co/ext/meetings/v1`
      (propose, counter, accept, confirm, decline, `rdv/cancel`, the
      unsupported reply) and `EXTENSIONS.meetingCancel` =
      `…/ext/meeting-cancel/v1`; `VERB_EXTENSION` maps each verb,
      `SUPPORTED_EXTENSIONS` is the default, `cardCapabilities()` the card
      list, `peerAdvertises(capabilities, verb)` the strict check (a card
      from before this lists no URIs and advertises nothing). The base URI
      says `meetings`, not `meeting`, partly so the relay check in the CLI
      dinner test (no `meeting/` in anything the relay sees) stays as strict
      as it was: the card's `capabilities` is cleartext in a topic probe.
    - **Discovery is the card**, not the grant scope: `capabilities` already
      exists, is signed and travels with every request and grant; the scope
      is consent, and a software upgrade should not need a new grant. `rdv
      init` (and so `rdv_init`) puts `cardCapabilities()` on new cards. Not a
      core wire change: `capabilities` was always a free list of strings and
      core's default is unchanged, so the vectors are unchanged. Existing
      agents keep their old card until re-initialized, and contacts hold the
      card they received, so an upgraded peer looks old (warns needlessly;
      §11.8).
    - **Unknowns, decided:** critical (unknown verb, a verb whose extension
      `ParseOptions.extensions` / `Ctx.extensions` leaves out, an unknown key
      anywhere in `data` including slots and `place`, an unknown string part
      kind) fail with `unsupported` = the message's ids and verb, once the
      ids are known valid. Ignorable: `metadata` on message, parts and
      updates, and unknown URIs in `message.extensions` (understanding is
      decided by `data`). Everything else stays malformed and silent:
      unknown keys in the A2A objects, unknown task states, missing fields,
      bad slots. The `reason` strings are unchanged.
    - **Unsupported reply** (`Run.replyUnsupported`): an `a2a/task-update`
      with our real state for the task, or `rejected` when we have none,
      and `metadata[UNSUPPORTED_KEY] = {messageId, verb?}` (verb only if it
      matches `<word>/<word>`). Only to the task's own peer and `contextId`;
      for an unknown task only when `checkScope` passes; capped at
      `FINISHED_REPLIES` per task (`unsupportedReplies`); never for status
      updates, so two agents cannot loop. A rev-3 parser accepts the reply
      (metadata is free-form) and applies its state as usual, which is why it
      carries our real state and never a made-up one. The sender emits a new
      event kind `unsupported`, whose reason it writes itself and names the
      verb only if it is one of `VERBS`.
    - **Sender side:** every message lists its verb's URI in `extensions`.
      `cancelMeeting(..., { peerCapabilities })` still sends the cancel (a
      newer agent honors it) but adds an `unsupported` event when the card
      does not advertise `meeting-cancel`; `rdv dinner cancel` and
      `rdv_negotiate` "cancel" pass the contact's card `capabilities`, and
      the MCP result and `rdv_inbox` event tell the model to have the human
      let the other person know. This is NOTES 61's open item: an old peer
      still drops the verb and keeps the dinner, but the canceling side is
      no longer left believing it was told.
    - Tests: a2a engine and model (old-style peer answers unsupported and
      the sender learns it, card discovery, critical vs ignorable vs
      malformed, reply bounds), CLI init card, MCP event mapping.

## Fixes after the plugin release (0.1.5)

66. **`rdv_grant` with `agent_id`: grant an existing contact more** (issue
    #1). An MCP-only user can now let a contact they requested propose
    meetings: `rdv_grant` takes `agent_id` (exactly one of `request_id`,
    `grant_id`, `agent_id`) with `tier` and `may_propose_meetings`, and calls
    `Agent.allowInbound`, which also sends the reverse grant (item 60). An
    extension of `rdv_grant` rather than a new tool, so the one human-gated
    tool covers every grant and the skill's rules need no new name. `label`
    is refused with it (an existing contact keeps its local label). The gate
    is the one of item 57:
    - **Form:** shows the contact (agent ID, fingerprint, our local label,
      binding, its rights now) and exactly what is granted; the human can
      change the tier and the meetings checkbox, and what they leave is what
      is granted.
    - **Phrase:** consent action `inbound`, keyed by agent ID. Unlike a
      request phrase it is issued only when the model asks (the first call
      without a phrase), for exactly the terms it asked: `subject` =
      `inboundSubject` (sha256 of peer, founding grant id, binding, `since`,
      local label) and `digest` = `termsDigest(subject, terms)`. Other terms
      are refused and the human is shown a phrase for those; the server
      keeps the phrase while the contact exists (`inboundAsks` in the re-sync)
      and drops it when the contact goes. `rdv contact pending` (text mode)
      shows it and re-issues it like the others. An `inbound` entry without
      terms, or with a label, approves nothing. Tier cap `PHRASE_TIERS`.
    - **Checked again where the grant happens:** under the home lock the
      contact must still have the subject the human reviewed (a contact
      revoked and made again under the same agent ID, or renamed, is
      refused, and a new phrase is issued); the phrase is dropped only after
      `allowInbound` went through.
    The CLI `rdv contact grant <agent-id>` is unchanged. No new human-only
    command, so the consent guard is unchanged; the skills offer "let them
    propose meetings too" after a first contact.

67. **The skill installs clean in Hermes** (issue #13). Hermes 0.14 scans a
    community skill (`tools/skills_guard.py`) and blocks it on **any**
    finding, not only critical ones. The skill tripped `curl_pipe_shell`
    (the installer one-liners), `sudo_usage` ("no sudo"),
    `agent_config_mod` (a link ending `docs/agents.md`: the pattern is
    `AGENTS\.md`, case-insensitive), `other_agent_config` (Codex's config
    path) and `remote_fetch` (the NIP-11 check's `fetch('https://…')`). The
    scan is static, so showing the one-liner as text for the human trips
    it as much as running it: the skills now send the human to the Install
    section of https://rendezvous.nesher.co and say never to run the
    installer themselves; the relay check takes its URL as an argument.
    Verified with Hermes's own `scan_skill` (verdict `SAFE` for both skills)
    and `hermes skills install` from the branch. `plugin.test.ts` lints every
    file under `plugins/rendezvous/skills` for pipe-to-shell (POSIX and
    PowerShell forms) and for those Hermes patterns. `docs/agents.md` no
    longer tells Hermes users to add `--force`.

68. **Checking our own published card** (issue #14). `Agent.lookup` skips
    our own card, so `rdv_discover` on the user's own address could never
    confirm a publish, and onboarding step 9 always failed. `lookup` is
    unchanged (our card is never a discovered peer). New
    `Agent.ownCardOn(address)`: true only if the newest valid card of ours
    on that topic is the one we hold now (same `created` and `sig`) and it
    still claims the address. `rdv_publish_card` reads the card back after
    publishing (a few short retries) and returns `on_relays` (`address`,
    `served`) per public address; `rdv_discover` on one of our own
    addresses adds `own_card_on_relays`. Per-relay OK results were not used:
    the transport accepts a publish once any relay does, and reading back
    is what the user actually needs to know.

## Public relays by default (plugin 0.1.6, issue #20)

69. **Default relays, publish retries, pacing and cooldown.**
    - **Defaults.** `DEFAULT_RELAYS` in core (`transport/nostr.ts`):
      `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.nostr.net`,
      `wss://nostr.oxtr.dev` (item 11a). It sits in core, next to the Nostr
      transport, because which relays take kind 30417 is Nostr knowledge
      that every client of the library needs, not CLI policy. Core never
      applies it: a `NostrTransport` still takes explicit relays. `rdv init`
      without `--relay` and `rdv_init` without `relays` use it
      (`initHome`; `RdvMcpOptions.defaultRelays` overrides it, which keeps
      `npm test` off the network). The relays are written to `config.json`
      and the card at init, so existing agents keep what they have; nothing
      migrates them. `wss://relay.nesher.co` stays an option (onboarding
      offers it alone or added).
    - **Retries.** `publish` sends to every relay that is not cooling down,
      in parallel. A relay gets 2 more tries after a transient failure
      (connection refused or dropped, connect or `OK` timeout,
      `rate-limited:`, `error:`), with jittered exponential backoff (400 ms ×
      2^n × 0.5 to 1.5, four times longer after a rate limit). It gets none
      for a permanent rejection (`invalid:`, `pow:`, `auth-required:`). A
      `duplicate:` answer counts as accepted. Success means at least one
      relay answered `OK true`. Otherwise the error lists each relay's kind
      and message.
    - **Cooldown.** `blocked:`, `restricted:` or a message with "banned"
      cools the relay down for 30 minutes after one try. A relay that failed
      every try cools down for 60 s. Publishes skip a cooling relay, unless
      every relay is cooling; then each is tried once, so an agent whose
      network came back is not stuck. An `OK true` clears the cooldown.
    - **Pacing.** A token bucket per relay: a burst of 6 (one card republish
      to several topics), then 3 events per second. Damus banned the test
      pubkey for bursts, and none of our flows needs more.
    - **Connections.** The nostr-tools pool already keeps one connection
      per relay URL, which publishes and subscriptions share. `publish` now
      goes through `pool.ensureRelay` itself, so it can set the connect and
      `OK` timeouts per try. A test checks that 5 publishes, a subscription
      and a fetch use one connection.
    - **Diagnostics.** `NostrTransport.relayStatus()` returns, for our own
      relays only, `{url, last_ok, last_error: {at, kind, message},
      cooldown_until}`. Relays from a peer's card are used and cooled down,
      but never listed, because their URLs are peer text. The message is the
      relay's `OK false` text or the connection error, with control and bidi
      characters replaced, at most 200 chars. The CLI saves it to
      `relays.json` in the home after each publish (merged per relay, newer
      wins, never fails a send) and seeds the next process's cooldowns from
      it. `rdv init --force` drops it, because bans belong to the old key's
      carrier pubkey. `rdv whoami` shows it (`relay_health` in `--json`).
      `rdv_status` shows it with the relay's message as
      `untrusted_peer_text`: a relay is a party we do not trust either.
    - **Crash fix found on the way.** On a connect timeout, nostr-tools
      closes a socket that is still connecting after removing its own
      handlers, and `ws` then throws an unhandled 'error'. Every socket now
      has a no-op error listener (`QuietWebSocket`). A regression test
      covers a relay that never answers the handshake.
    - Tests (`core/test/transport.test.ts`, in-memory relay with failure
      modes `okFalse`, `dropOnEvent`, `ackDelayMs`): retry after a drop, a
      transient `OK false`, giving up and cooling down, no retry for
      `invalid:`, a blocking relay tried once and then skipped, everything
      cooling, slow acks, an unreachable relay next to a good one, saved
      cooldowns, message sanitizing, connection reuse, close() during
      backoff, pacing, the default burst. CLI: init defaults and whoami
      health across processes. MCP: `rdv_init` defaults and `relay_health`.
    - **Live (2026-10-25, serial).** `npm run test:live` on the four
      defaults: CLI 7/7 (contact on all four together and on each alone,
      dinner, addresses) and MCP 2/2 (dinner, onboarding). Then on
      `wss://nos.lol` alone and on `wss://relay.primal.net` alone: CLI 3/3
      and MCP 2/2 each.

70. **Envelope plaintext is capped at 32 KiB** (**spec change**, §6.4;
    design review). Core had no size cap. `sealEnvelope` throws
    `EnvelopeTooLargeError` when the payload's canonical JSON is over
    `MAX_PLAINTEXT_BYTES` (32,768 bytes, UTF-8). It throws before the
    channel moves, so a refused send leaves `seq` alone. `rdv_send` passes
    the message to the model, since it holds no payload text.
    `openEnvelope` drops (`too large`) an envelope whose base64 ciphertext is
    longer than the cap plus the GCM tag, before it verifies the signature
    or decrypts. After decryption it checks the plaintext length again. The
    transport does not even parse event content over 128 KiB. At the cap a
    sealed event is about 45 KB on the wire, under the 128 KB smallest relay
    limit (item 11a). A test checks under 50,000 bytes. Tests: exactly the
    cap opens; one byte over and a multi-byte string over are refused; an
    oversized but validly signed envelope is dropped; oversized event
    content is not parsed; MCP refuses over the cap and the next send is
    `seq` 1.

## Approved, not implemented yet

71. **General tasks and groups** (design approved 2026-10-25, **spec
    change** as each slice lands). `docs/design/general-tasks-and-groups.md`:
    a `tasks/v1` lifecycle with capability URIs, `scope.invoke` replacing
    `may_propose_meetings`, start and release gates (item 59 generalized),
    a human-only `auto_approve: all` per contact with an audit log, bounds
    (item 46 generalized), per-capability rate limits, file references by
    URL plus content hash (Blossom optional, P2P transfer negotiable), and
    groups by pairwise fan-out (v0.4). The envelope size cap it needs is
    item 70.

## File references (v0.3, issue #26, core slice)

72. **File references, file encryption, the fetch helper and `rdv/transfer`**
    (**spec change**, new SPEC §7.7, from design A.8). Core only; nothing
    sends or receives them yet except as plain `rdv_send` payloads.
    - **Names follow the design, not the issue's first draft:** the wire
      form is an A2A `FilePart` with `file.uri`, `file.mimeType`,
      `file.name` and the metadata under `…/ext/files/v1` (`sha256`, `size`,
      `enc {alg: "aes256gcm", key, nonce, plain_sha256}`, `mirrors`, `p2p`,
      `expires`). `FileRef` is the same thing flattened, which is what the
      helpers take; `fileRefPart` and `parseFilePart` convert.
    - **Validation** (`files.ts`): strict and bounded. `https` only (so no
      `file:`, `data:`, `javascript:`, `http:`), no userinfo, no whitespace,
      controls or backslashes, at most 2,048 chars; hex hashes lowercase;
      `size` an integer up to 1 TiB (the receiver's cap applies on fetch);
      key 32 and nonce 12 bytes; at most 8 mirrors and 8 `p2p` names
      (`<name>/<version>`), no duplicates; unknown keys refused in the
      metadata, `enc` and `file` (§7.5: this metadata is not ignorable);
      other extensions' `metadata` keys ignored. Inline parts at most
      16 KiB decoded. File names are sanitized on parse (control, bidi and
      zero-width characters dropped, `/` and `\` replaced by `_`, leading
      dots and spaces stripped, 255 chars); MIME types lowercased.
    - **Crypto:** `encryptFile` draws a fresh 32-byte key and 12-byte nonce
      per call (there is deliberately no API that takes a key), AES-256-GCM
      with AD `"rdv1/blob"`, so a file ciphertext can't be passed off as an
      envelope's (AD `canon(header)`). `verifyAndDecrypt` checks length,
      then `sha256`, then decrypts, then `plain_sha256`, and throws
      `FileRefError` with a stable `code` at the first failure. The test
      vectors gain `file_ref` (fixed key and nonce, plaintext, ciphertext
      and the wire part), a deliberate, additive vector change; nothing
      else in `v1.json` moved.
    - **Fetch** (`filefetch.ts`, `fetchFileRef`): `node:https`, not global
      `fetch`, because Node's fetch can't pin the resolved address without
      the `undici` package. A custom `lookup` resolves the name once,
      refuses if **any** answer is a special address, and hands the socket
      exactly one checked address, so there is no second resolution to
      rebind; the socket's `remoteAddress` is checked again on connect. IP
      literals are checked before connecting. `isBlockedAddress` covers
      IPv4 private, loopback, link-local, CGNAT, documentation,
      benchmarking, multicast and reserved ranges, and IPv6 `::/96`,
      IPv4-mapped (by the embedded address), NAT64 `64:ff9b::/96` (by the
      embedded address) and the local-use prefix, 6to4 (by the embedded
      address), `2001::/23` (Teredo included), documentation, ULA,
      link-local, site-local and multicast, plus anything that doesn't
      parse and zone IDs. At most 3 redirects, each re-validated (scheme,
      userinfo, `allowHosts`, address). A fresh agent per request: no
      pooled sockets, no cookie jar, headers are only `accept`,
      `accept-encoding: identity` and `user-agent`; no client certificate;
      proxy variables are not consulted. A `Content-Encoding` other than
      identity is refused, so the cap counts wire bytes. The cap is
      min(`size`, `maxBytes` [25 MiB]): a bigger `size` is refused unfetched,
      a bigger `Content-Length` before the body, and the stream is cut the
      moment it passes the cap. One deadline covers all hops [30 s].
      `mirrors` are tried in order after `uri`. Options: `allowHosts`
      (restrict to these names), `resolve` (a custom resolver, still
      checked and pinned), `ca` (extra trust anchors), `signal`, and the
      test-only `unsafeAllowAddresses`, which the tests use for
      `127.0.0.1`. Error messages hold no peer text.
    - **`rdv/transfer`** (`transfer.ts`): `parseTransfer` and
      `transferMessage` validate the five steps with per-step fields only;
      `data` is a plain JSON object of at most 16 KiB canonical JSON,
      nested at most 16 deep (checked without recursion); `reason` at most
      200 chars with controls stripped. `stepTransfer` is a pure state
      machine (propose, accept, signal*, done; abort at any open step) that
      aborts on no common protocol, an accept outside the proposal, out of
      order steps and the 17th message, and ignores messages for unknown or
      finished transfers. `task` is optional until tasks/v1 lands.
    - **Not done yet (rest of #26):** carrying file parts in tasks and
      artifacts (#22), fetching only behind the start gate and the release
      gate covering outgoing files (#24), the owner setting for direct
      transfer, MCP/CLI tools, an optional `BlobStore` uploader, and an MCP
      end-to-end test.
    - Tests: `core/test/files.test.ts` (crypto round trip and every tamper,
      AD binding, validation tables, a 3,000-case fuzz, parts, the address
      table, transfer shapes and state machine) and
      `core/test/filefetch.test.ts` (a local HTTPS server with a certificate
      generated per run: default block of 127.0.0.1, names resolving to
      loopback, mixed and rebound resolver answers, redirects to private,
      metadata, other-loopback, IPv4-mapped, `http:` and `file:`, the
      redirect limit, no cookie after `Set-Cookie`, the size cap three ways,
      timeout, hash mismatch, content encoding, untrusted certificate,
      mirrors and `allowHosts`).

## General tasks (v0.3)

73. **`tasks/v1` lifecycle and task model** (**spec change**, §4.3, §7.1,
    §7.4, new §7.6; issue #22, slice 1 of item 71). In `@rendezvous/a2a`:
    `capabilities.ts` (the `CapabilityRegistry`; a capability is a URI, an
    approval class `notify | auto | confirm | free-form`, a strict `input`
    schema, an optional `answer` schema for `task/input`, and the `data`
    shapes of its results, built with the small strict schema `s`),
    `taskmodel.ts` (`parseTaskPayload` for `task/request`, `task/input`,
    `rdv/cancel`, status updates with `failed` and `status.message`, and the
    new `a2a/artifact-update`; `routeA2A`) and `tasks.ts` (the engine:
    `receiveTask`, `requestTask`, `inputTask`, `cancelTask`, `expireTasks`
    for both roles, and `startTask`, `rejectTask`, `askInput`,
    `sendArtifact`, `finishTask` for the executor). Pure like the meeting
    engine, `now` injected, no core import. Meetings are untouched: the
    meeting parser still answers a task verb as unsupported, which is the
    old-peer behaviour the tests check.
    - **Gates are effects only.** By class, a new task completes with a
      `notify` effect, starts at once (`start`, `auto`), or waits
      `submitted` with a `start-gate` effect (`confirm`, `free-form`) until
      `startTask` / `rejectTask`. A `task/input` under a gated class re-opens
      the start gate (step `input`). Under a gated class, or with
      `ownerData`, `askInput`, `sendArtifact` and `finishTask` with a message
      send nothing without `released: true` and return a `release-gate`
      effect holding the exact payload; the released call must pass the same
      `artifactId`. Digests and the human's approval are the gates slice.
    - **Choices the design left open.** (a) Machine reasons for refusals and
      endings go in status metadata under `<tasks URI>/reason` (`scope`,
      `rate`, `input`, `busy`, `human`, `expired`, `unsupported`, `error`),
      ignorable, peer-written, display only. (b) The unsupported reply keeps
      §7.5's `<meetings URI>/unsupported` key, so a rev-3 parser reads it;
      its value may add `capability`. (c) The executor's state is the
      task's state; the requester applies only forward transitions and
      ignores status updates once finished. (d) The requester marks a task
      `canceled` when it sends `rdv/cancel` (as meetings do) and on its own
      expiry (sending `rdv/cancel`, reason `expired`). (e) The executor's
      expiry ends a task `rejected` if it never started, else `failed`.
      (f) `notify` tasks end `completed` at once. (g) Routing between the
      two engines (`routeA2A`): `task/*` verbs and artifact updates go to
      tasks, status updates and `rdv/cancel` to the engine that holds the
      task, and a cancel for an unknown task to tasks only when its
      `extensions` lists the tasks URI and not the meetings one.
    - **Bounds** (A.7, NOTES 46): tasks and tombstones only within a
      task-capable `invoke`; deny by default (a capability not in `invoke`
      is `rejected`, `scope`); no `invoke` at all is dropped silently, like
      a meeting verb without a meeting grant. 32 tasks per peer (finished
      and tombstones evicted first), `max_open` per capability from the
      grant entry, else the capability's, else 4. Waiting for the human: 4
      per peer and 64 in all, the weakest (lowest tier, then the oldest
      gate) rejected `busy`, newcomer included, with an `abort` effect.
      Per task 64 seen ids, 8 `task/input`, 64 status updates, 8 artifacts,
      64 chunks, 8 finished and 8 unsupported replies; text parts 16,000
      characters; inline file bytes 16 KiB; `expires` 48 h by default,
      clamped to 7 days; finished tasks pruned after 30 days (500 kept at
      most). A refusal keeps no state and is counted in `state.dropped` by
      reason, for the human. Request input, text and files are kept only
      while the task is open (the gates need them), and peer text never
      becomes a stored `reason`.
    - **Security review (on commit).** (1) A capability with an `input`
      schema always validates: absent input is refused unless the
      capability sets `inputOptional` (it was skipped before). (2)
      `startTask`, `askInput`, `sendArtifact` and `finishTask` re-check
      that the capability is still registered and still in the current
      grant's `invoke` before acting; if not, the task ends with code
      `scope` (`rejected` before it started, `failed` after, per §7.6.2),
      an `abort` effect and a status update, and nothing else is sent.
    - **Files** are opaque here: inline `bytes` (base64, at most 16 KiB) or
      a `uri`, exactly one, never fetched. The hash and fetch rules (§7.7)
      are item 72 (core); wiring them into the task engine is the files
      slice's a2a part (issue #26).
    - **Core:** `verifyCard` rejects a card with more than 32
      `capabilities` or an entry over 200 characters (`createCard` throws);
      constants `MAX_CARD_CAPABILITIES`, `MAX_CAPABILITY_CHARS`. Payloads
      were already opaque to core, so no wire change and the vectors are
      unchanged.
    - **Not advertised yet.** `cardCapabilities()` still lists only the
      meeting URIs: §4.3 says advertising means the software can do it, and
      neither the CLI nor the MCP server routes tasks to this engine yet,
      nor is any capability registered. The slice that wires them adds
      `TASKS_URI` and the registry's URIs to the card (follow-up issue).

## Capability-scoped grants (v0.3)

74. **`scope.invoke` and the migration from `may_propose_meetings`**
    (**spec change**, §5.3, §5.5, §7.4, §13; issue #23, design A.4). A grant's
    `scope` gains `invoke`: capability URI → limits (`max_frequency`,
    `max_open`). Core, `contact.ts`:
    - **Shape** (`invokeProblem`, `isCapabilityUri`): a plain object of at
      most 32 keys, each an `https` URI of at most 200 printable ASCII
      characters with a host, no userinfo and no `*` (no wildcard), each
      value an object; `max_frequency` parses like the grant-wide one,
      `max_open` is a positive integer. Unknown limit fields are ignored, as
      other open scope fields are. `verifyGrant`/`verifyReverseGrant` refuse
      a grant whose `invoke` is malformed; one without `invoke` (every older
      peer) verifies as before.
    - **Reading rule** (`scopeAllows`, `ContactBook.mayInvoke(peer,
      capability, 'inbound' | 'outbound')`): `invoke` first; without it, only
      the two meeting URIs can be allowed, by `may_propose_meetings: true`.
      With both, a meeting URI also needs the boolean not to be `false`, so
      a disagreement in either direction means no meetings (the narrower). A
      malformed `invoke` allows nothing. Stored contacts are read through the
      same rule: an `agent.json` saved by main loads and saves back byte for
      byte, and nothing it held widens (fixture
      `core/test/fixtures/agent-main-rev3.json`, produced by main's own core
      at c9a76ae).
    - **Writing** (`grantScope`): every grant v0.3 issues (`Agent.grant`, the
      allowlist auto-grant, `allowInbound` and its reverse grant) writes both
      fields, consistent: `invoke` holding the meetings URI ⇔
      `may_propose_meetings: true`, and meeting-cancel goes with meetings. A
      boolean-only scope gets an `invoke` from the boolean; a scope whose two
      fields disagree, or whose `invoke` is malformed, throws before
      anything is recorded or sent. `DEFAULT_GRANT_SCOPE` lists the meeting
      URIs and nothing else; `DEFAULT_INBOUND_SCOPE` an empty `invoke`.
      `createGrant` itself still signs the scope it is given, so the test
      vectors are unchanged.
    - **Direction** unchanged (item 15, item 60): a received grant sets only
      `outboundScope`. The a2a engine, which does not import core, applies
      the same rule in `meetingsAllowed` (`checkScope`), and the CLI's
      `meetingScope` hands it core's answer, so both agree on every shape
      (cli test). A proposal from a peer whose grant does not cover meetings
      is refused before a task or tombstone is kept, as before.
    - **Surfaces.** `rdv contact grant` takes `--invoke <uri>` (repeatable)
      and `--no-meetings` on top of the default scope or `--scope-file`, all
      checked before sending (exit 2). `rdv_grant` takes `invoke` (URIs
      besides meetings, which stay `may_propose_meetings`) with `request_id`
      or `agent_id`; the form names the capabilities and has one checkbox
      for them (unchecked grants none), and a confirm phrase is bound to the
      exact list through the existing terms digest (item 57/66: the digest
      covers the whole scope), so a phrase shown for one list is refused for
      any other and the human is shown a phrase for the list asked.
      `describeTerms` prints `may invoke <uris>`. Contact views gain
      `outbound_invoke` and `inbound_invoke`; the MCP `reverse_grant` event
      gains `invoke`, each URI strict-shaped (`capability` in
      `untrusted.ts`) or quarantined. A phrase issued before this change for
      a pending request carries the old default scope (no `invoke`), so the
      first use after upgrading is refused as other terms and a new phrase
      is shown.
    - **Not here:** enforcing the per-capability limits and the gross-abuse
      threshold (issue #28) and the tasks that ask for capabilities (issue
      #22, item 73, whose engine takes the grant's `invoke` map in its
      context): a host wiring that engine passes `effectiveInvoke(scope)`,
      the map with this item's reading rule applied (a malformed `invoke`
      gives `{}`, a boolean-only grant the meeting URIs), never the raw
      field. `invokeLimits` gives the limits with `max_open` defaulted to 4.
      `may_propose_meetings` is retired in v0.5.

## Not implemented yet


Mailbox probe and invite (§5.2), directories and suggestions (§4.5), DNS TXT
lookup, key rotation, ntfy/MQTT fallbacks, direct (ICE/WebRTC) channels,
and `rdv/forget`.

## Environment

- Node's built-in WebSocket (undici) overflows the stack inside nostr-tools
  when a relay connection fails, so the transport installs the `ws` package
  as the WebSocket implementation.
- On a Windows checkout with `core.autocrlf=true`, a file that starts with a
  shebang and has CRLF breaks: `#!/usr/bin/env node\r` doesn't run, and
  vitest can't import `consent-guard.mjs` at all (SyntaxError, so
  `plugin.test.ts` was not collected). `.gitattributes` keeps `*.mjs`,
  `*.py`, the `bin.ts` entry points and `plugins/**` LF, and `plugin.test.ts`
  checks every shebang file in the working tree.
