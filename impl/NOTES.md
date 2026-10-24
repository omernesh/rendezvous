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

## Not implemented yet

Mailbox probe and invite (§5.2), directories and suggestions (§4.5), DNS TXT
lookup, key rotation, ntfy/MQTT fallbacks, direct (ICE/WebRTC) channels,
`rdv/forget`, and A2A task semantics (step 3 of the demo plan).

## Environment

- Node's built-in WebSocket (undici) overflows the stack inside nostr-tools
  when a relay connection fails, so the transport installs the `ws` package
  as the WebSocket implementation.
