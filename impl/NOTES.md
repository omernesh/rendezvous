# Implementation notes and spec deltas

Building the reference library surfaced places where SPEC.md (v0.1 rev 2) is
silent, ambiguous, or would be unsafe as written. Each item below says what
the library does today. Items marked **spec change** should be folded back
into SPEC.md before v0.2.

## Security

1. **The envelope signature must cover `content`.** (**spec change**, §6.4)
   The spec signs "everything outside content". Then anyone who sees one
   genuine envelope can keep its signed header and swap in their own
   ciphertext encrypted to the recipient; the recipient would accept the
   payload as coming from the header's sender. The library signs the whole
   envelope (everything except `sig`), and also binds the header as AES-GCM
   associated data.
2. **Domain-separated signatures.** Every signed document is signed over
   `"rdv1/sig:" ‖ canonical-JSON(doc without sig)`, so a signature can't be
   lifted from one context to another.

## Wire format choices the spec leaves open

3. **Canonical JSON** = RFC 8785 (JCS) subset: sorted keys, no whitespace,
   `undefined` dropped, integers only.
4. **Base32** = RFC 4648 alphabet, lowercase, no padding. An agent ID is
   `rdv1:` + 52 characters.
5. **`sig`** is base64 (standard alphabet, padded) of the 64-byte Ed25519
   signature.
6. **Envelope encryption** (`alg: "x25519+aes256gcm"`): an ephemeral X25519
   key per envelope × the recipient's X25519 key (converted from its Ed25519
   identity) → HKDF-SHA256 (salt = `epk ‖ recipient_x25519_pub`, info =
   `"rdv1/envelope"`) → AES-256-GCM, 12-byte random nonce. `content` gains an
   `epk` field (**spec change**: add it to the §6.4 example).
   This has no forward secrecy yet; the conversation-scoped keys from the
   handshake that §6.2 mentions are future work.
7. **`prev`** is the hex SHA-256 of the previous envelope's canonical JSON in
   the same direction; the first envelope has `prev: null` and `seq: 1`.
8. **`canon(address)`** is the bare value: email trimmed and lowercased,
   phone as `+` and digits (a leading `+` is required). No type prefix.

## Nostr

9. **Kind 30417 is in the addressable range** (30000–39999). Relays keep only
   the latest event per (pubkey, kind, `d`), so two envelopes without
   distinct `d` tags would overwrite each other. The library sets
   `d = envelope hash`. **Spec change (recommended):** move to a regular kind
   (1000–9999) so relays store each envelope as its own event.
10. **Nostr needs secp256k1 keys; agent IDs are Ed25519.** Each agent derives
    a stable Nostr "carrier" key: HKDF-SHA256(seed, info
    `"rdv1/nostr-carrier"`). It signs the Nostr event only; authenticity
    comes from the envelope signature. The `p` tag is the hex Ed25519 public
    key of the recipient.
11. **Discovery on Nostr**: topic documents use the same kind, with a `t` tag
    holding `dtopic` and `d` = hash of the content.

## Contact flow

12. **Listen-mode probe = a contact request posted on the target's `dtopic`**,
    with `to_hint` set to the address. The listener gates it exactly like an
    inbound request with binding `claimed`. No separate probe document is needed.
13. **The grant carries the grantor's card** (**spec change**, §5.3). The
    requester otherwise has no way to reach the grantor after a topic probe.
14. **Tier cap for `claimed` bindings** applies to the *default* tier offered
    at consent time. An owner who explicitly picks a higher tier counts as the
    "explicit human confirmation" in §4.4.
15. **Grant direction.** A grant authorizes the requester to contact the
    grantor. Because the requester initiated, it accepts the grantor contacting
    it back within the same scope.
16. **`max_frequency`** is `"<n>/<minute|hour|day>"`; exceeding it revokes the
    grant (§10).
17. **Resend**: a gap in `seq` buffers later envelopes and sends
    `{type: "rdv/resend", from_seq, to_seq}`; the sender replays from a
    64-envelope outbox.

18. **Who may answer a request** (**spec change**, §5.3). A request sent to a
    specific card is only satisfied by a grant signed by that card's agent;
    the library rejects any other grantor before touching state. A topic
    probe can be answered by *anyone* who saw it on the `dtopic`, so its
    grant is always recorded as `claimed`. The spec should say both, and
    should tell the requester to show the grantor's fingerprint (and whether
    its card even claims the probed address) to the human before trusting
    the new contact.
19. **Requester-side binding.** The requester records how it found the peer
    (`claimed` for a topic probe or a public pointer, `in-person` when the
    owner says the card came from a QR code / face to face). §4.4 says
    bindings attach to the relationship record; it doesn't say the requester
    keeps one too. It should.
20. **Gap buffer bounds.** Out-of-order envelopes are buffered only for
    contacts and agents we asked by card, at most 16 peers ª 64 envelopes,
    and persisted with the agent state. The spec's resend text (§7) should
    say receivers may bound and drop.
21. **Channel state for strangers** (open). `Channels.acceptInbound`
    advances `seq` for any validly signed envelope, before the contact book
    decides whether to admit it. A stranger can't spoof another sender, so
    this only costs memory per stranger ID; worth bounding in v0.2.

22. **Document IDs are UUIDs** (**spec change**, §5). Request, grant and
    revoke `id` (and a grant's `request_ref`) must be RFC 4122 UUID strings;
    the library rejects anything else, so peer-chosen IDs can't smuggle
    terminal escapes into a UI. The spec shows UUIDs but doesn't require them.

## CLI (`rdv`)

23. **Single writer per home.** Every command takes `lock` (O_EXCL file with
    pid/host; broken when the owning pid on this host is gone, or after
    10 min) and writes state temp-then-rename. `listen` holds the lock only
    per inbound item and reloads state from disk each time, so other
    commands can run beside it; it is the pattern the MCP server should use.
24. **Relays replay on every subscribe.** Subscriptions ask for a 2-day
    lookback, and the transport re-subscribes when a relay drops the socket,
    so `listen` sees old events again after each restart or reconnect.
    Channels and replay IDs make that harmless; `listen` hides duplicate
    drops in text mode. Re-subscribe fires only when *every* relay of a
    subscription has closed; a single relay dropping out of a multi-relay
    subscription is not yet re-joined.
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

## Not implemented yet

Mailbox probe and invite (§5.2), directories and suggestions (§4.5), DNS TXT
lookup, key rotation, ntfy/MQTT fallbacks, direct (ICE/WebRTC) channels,
`rdv/forget`, and A2A task semantics (step 3 of the demo plan).

## Environment

- Node's built-in WebSocket (undici) overflows the stack inside nostr-tools
  when a relay connection fails, so the transport installs the `ws` package
  as the WebSocket implementation.
