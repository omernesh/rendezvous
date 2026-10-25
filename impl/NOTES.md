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
    negotiation with no human. Limitation: the grantor's own
    `outboundScope` is just `may_initiate` (nothing tells it what we
    allow), so the grantor side cannot start a negotiation; the requester
    proposes. A reverse grant message would fix that (v0.2). (**spec change**,
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
21. **Channel state for strangers** (open). `Channels.acceptInbound`
    advances `seq` for any validly signed envelope, before the contact book
    decides whether to admit it. A stranger can't spoof another sender, so
    this only costs memory per stranger ID; worth bounding in v0.2. (folded into SPEC rev 3 §11.10)

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
    once. **spec change**, SPEC §5.5 and §7.3 (rev 3, amended).
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
    restored old state) is a `fork`, not a duplicate. Open: a peer that
    rolled back further than one envelope reuses seqs below ours, which
    still read as duplicates; telling them apart needs a hash per seq or a
    chain reset message (v0.2).
57. **Confirm-phrase limits** (L6, open, documented only). `consent.json`
    (mode 600) holds each phrase in clear text, because `rdv contact
    pending` must show it to the human again. A client that gives the model
    file or shell access to the home (Claude Code, for one) can read it and
    so approve on its own; there, use elicitation or `rdv contact grant` in
    a terminal, or keep the home outside the files the model can reach.
    The phrase also does not bind the tier (any tier from `friend` down) or
    `may_propose_meetings`, which the model picks. Fix options: store only a
    hash and show the phrase once (stderr at creation), and fold the tier
    and scope shown to the human into the phrase (HMAC). Not done here.

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
    honored (§7.3). Cancelling an agreed meeting is a v0.2 verb.

## Not implemented yet


Mailbox probe and invite (§5.2), directories and suggestions (§4.5), DNS TXT
lookup, key rotation, ntfy/MQTT fallbacks, direct (ICE/WebRTC) channels,
and `rdv/forget`.

## Environment

- Node's built-in WebSocket (undici) overflows the stack inside nostr-tools
  when a relay connection fails, so the transport installs the `ws` package
  as the WebSocket implementation.
