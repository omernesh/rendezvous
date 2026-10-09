# Rendezvous
## An Open Protocol for Agent-to-Agent Contact

**Status:** Draft v0.1 (for discussion)
**Author:** Omer Nesher
**Date:** 2026-10-08

> Codename "Rendezvous" is provisional. The protocol describes how a personal AI
> agent belonging to one human makes contact with, and safely communicates with, a
> personal AI agent belonging to another human — across different vendors,
> networks, and platforms.

---

## 1. Abstract

Every major AI lab now ships a personal agent (Meta Muse, xAI Grok Bot, OpenAI
Dots, Google Gemini Spark, Apple Siri AI, Instinct, Manus Cue, and more). Every
one of them is an island. Instinct's agents can talk to other Instincts over its
closed I2I network; Grok Bots coordinate only with other Grok Bots; Dots talk to
dots. There is no open way for a Muse agent to contact an Instinct agent — the
agent world today is the messaging world of 2008, before interoperability was
demanded by users and eventually forced open by protocol adoption (MCP).

Rendezvous defines that missing layer: a vendor-neutral, open protocol for
**agent identity, first contact, consent, and communication**, designed so that
nobody has to run infrastructure to participate. It reuses proven building
blocks — cryptographic keys for identity, Nostr relays as the primary
rendezvous, A2A for task semantics — and treats every transport as an
untrusted dumb pipe carrying end-to-end-encrypted envelopes.

**Goals:**
- Any agent can contact any other agent, regardless of vendor or network.
- Consent is a first-class protocol object: the human always decides who may
  reach their agent and what the relationship may do.
- Zero mandatory infrastructure: no central registry, no company server, no
  required relay operator.
- Self-healing: multiple rendezvous hints per agent; losing any one transport
  degrades gracefully, never breaks.
- Boring technology: everything is a key, a signed JSON envelope, and an
  existing public transport.

**Non-goals:**
- Not a message transport for humans.
- Not a blockchain, token, or incentive system.
- Not a payment or commerce layer (though agents may negotiate tasks that
  include payments via their own means).
- Not a registry of identity for legal/KYC purposes.

---

## 2. Motivation

In eight weeks (Aug–Oct 2026) the personal-agent market went from niche to
crowded. Instinct raised $1B at a $10B valuation; Muse became the #1 US app;
Dots launched with 4,000+ app connectors. Each vendor built a closed network:

| Vendor | Agent | Inter-agent story |
|---|---|---|
| Meta | Muse | Personal Agent Protocol working group (announced, no open impl) |
| xAI | Grok Bot | Bots delegate to Bots on the same account only |
| OpenAI | Dots | Dots coordinate within a user's own fleet |
| Instinct | Instinct | I2I "Trusted Person network" — closed, Instinct-to-Instinct only |
| Google | Gemini Spark | Google-ecosystem only |
| Decagon + Instinct | PACT | Open spec for person-agent ↔ *business*-agent consent (A2A-based) |
| Google | A2A | Open task-exchange protocol (server semantics, not consumer contact) |

The vacuum: **person-agent ↔ person-agent contact with per-relationship
consent, across vendors.** Instinct proved the demand (and built the walled
garden). PACT proved business consent. Nobody has shipped the open
person-to-person layer. The MCP precedent — an open protocol that won by
solving fragmentation at the moment of peak pain, with zero ideology — is the
template this spec follows.

---

## 3. Design principles

1. **The human channel is the bootstrap.** Every human already has always-on,
   store-and-forward endpoints (email, SMS, WhatsApp, Telegram). First contact
   travels over a channel the two humans already share. No new app, no new
   account, no always-on device.
2. **Keys are identity.** An agent's identity is its Ed25519 public key,
   self-generated at install — globally unique, registry-free, unspoofable.
   It is the "MAC address" of the agent.
3. **Consent is the handshake.** An agent may only communicate with another
   after the receiving human approves. Approval is a signed grant scoped to a
   relationship (trust tier, capabilities, expiry).
4. **Relays are dumb pipes.** Every transport (Nostr relay, ntfy topic, MQTT
   broker, email server) sees only ciphertext and routing hints. Trust lives
   in keys, never in infrastructure.
5. **Rent, don't build.** All transports are existing public services the
   users already pay for. The protocol ships a spec and a reference library;
   it runs no servers.
6. **Self-healing by redundancy.** An address card lists several rendezvous
   hints (Nostr relay, ntfy topic, email, phone, DNS TXT). Failure of any one
   is routine, not fatal.
7. **Boring wins.** Everything that can be a signed JSON document is a signed
   JSON document. Nothing needs consensus, a ledger, or a chain.

---

## 4. Identity layer

### 4.1 Agent key

- Ed25519 keypair, generated at agent install.
- The private key never leaves the agent's secure storage; it can be held by
  the user's passkey/HSM where available.
- Key rotation: a new key is published with a `rotate` document signed by the
  old key, carrying the new key and a grace period. Peers accept either during
  the grace window. (See §11 open problems on recovery.)

### 4.2 Agent ID

```
rdv1:<base32(ed25519-pubkey)>
```

- `rdv1` prefix disambiguates from other ID schemes.
- Human-facing form: a short fingerprint, e.g. `rdv1:7f3a…9c2d`, always shown
  with a copy button; never ask humans to type full keys.

### 4.3 Address Card ("calling card")

The signed, self-describing document an agent publishes about itself. Schema
(v1):

```json
{
  "v": 1,
  "id": "rdv1:7f3a…9c2d",
  "created": "2026-10-08T00:00:00Z",
  "expires": null,
  "capabilities": ["rdv/v1", "a2a/0.3"],
  "owner": {                // OPTIONAL and minimized by default
    "name": "John Doe", // only if the owner opts in
    "contact": ["mailto:john@doe.com"]  // one hint is enough
  },
  "rendezvous": [           // ordered fallback list
    {"type": "nostr", "relay": "wss://relay.damus.io", "topic": "<kind-30417>", "pref": 1},
    {"type": "ntfy", "topic": "rdv-7f3a9c2d", "pref": 2},
    {"type": "email", "to": "rdv+7f3a9c2d@agent.example", "pref": 3},
    {"type": "dns", "domain": "doe.com", "pref": 0}
  ],
  "policy": {
    "inbound": "prompt",     // allow | block | prompt
    "public": false          // publish to public relays?
  },
  "sig": "…ed25519 signature over the canonical JSON above…"
}
```

Rules:
- `owner` fields are **opt-in and minimized**. A public card need not name
  its owner at all.
- `rendezvous` is ordered by preference; `pref: 0` entries (like DNS TXT) are
  lookup hints rather than delivery addresses.
- The card is versioned (`v`), signed, and revocable via expiry.

### 4.4 Discovery of a card

In order of availability:
1. **Direct knowledge** — the requester already has the peer's email/phone
   (from the human's contacts) and asks the card *through* that channel
   (§5.2).
2. **DNS TXT** — `_agent.<domain> TXT "rdv=rdv1:…"` for owners with domains.
3. **Platform profile fields** — a `rdv1:…` line in an X bio / LinkedIn
   about / GitHub profile. The platform account vouchsafes the binding.
4. **Public relays** — cards with `policy.public: true` are fetchable by ID
   from public Nostr relays.
5. **In person** — QR code / NFC containing the card.

---

## 5. Contact layer (consent & handshake)

### 5.1 Contact Request

The envelope that asks "may my agent talk to your agent?":

```json
{
  "v": 1,
  "type": "rdv/contact-request",
  "id": "<uuid>",
  "from": "rdv1:<requester key>",
  "to_hint": "john@doe.com",
  "card": "<requester's address card>",
  "greeting": "Alice's agent requests contact on Alice's behalf.",
  "capabilities_offered": ["a2a/0.3"],
  "ts": "2026-10-08T00:00:00Z",
  "sig": "…"
}
```

Delivery (§6): the request is posted to any rendezvous hint the requester can
resolve for the target, or delivered through the human channel (email/SMS/
WhatsApp) addressed to the human.

### 5.2 Human-channel bootstrap (no lookup available)

When the requester knows only a human address (e.g. `john@doe.com`):

1. Requester's agent sends the contact request through the human channel —
   an email, SMS, or messaging message. The human-readable part renders a
   consent prompt; the machine part is the signed envelope (email:
   `multipart/alternative` with a machine part; messaging: appended JSON
   block).
2. The receiving human sees: *"John's agent (rdv1:7f3a…9c2d, first seen here,
   requested via john@doe.com) requests contact. [Approve] [Block]"*.
3. On approval, the recipient's agent signs a **Contact Grant** (§5.3) and
   returns it through the same channel (or any rendezvous hint from the
   requester's card).
4. Both sides now hold each other's cards, keys, and grants. Direct or
   relayed communication proceeds per §6.

The human channel is also the **anti-spoofing anchor**: the request is bound
to the address it arrived through, and the human verifies against the social
context they already have ("I do know john@doe.com"). Key fingerprints
are additionally comparable out-of-band (Signal safety-number model).

### 5.3 Contact Grant (consent)

```json
{
  "v": 1,
  "type": "rdv/contact-grant",
  "id": "<uuid>",
  "from": "rdv1:<grantor key>",
  "to": "rdv1:<requester key>",
  "request_ref": "<contact-request id>",
  "tier": "colleague",        // spouse | family | friend | colleague | business | stranger
  "scope": {
    "may_initiate": true,
    "may_propose_meetings": true,
    "may_access_calendar": "free_busy",
    "max_frequency": "20/day"
  },
  "expires": "2027-10-08T00:00:00Z",
  "ts": "…",
  "sig": "…"
}
```

Trust tiers are a suggested default set, not a schema limit; grants are
explicit capability lists and vendors may add scopes.

### 5.4 Policy and revocation

- The receiving agent's inbound policy is `allow` (only grants from the
  allowlist), `block` (key-based, permanent for that key), or `prompt` (the
  default — surface to the human).
- Revocation: a `rdv/revoke` document, or simply dropping the grant entry.
  Blocked keys never receive responses (silent drop is a privacy feature).
- Replay protection: request/grant IDs are stored; duplicates ignored.

---

## 6. Transport layer

### 6.1 Rendezvous hints

Each address card lists ordered transports. The envelope (encrypted, signed)
is delivered over the first available hint; acks travel the same way. Ordering
is per-card, so both parties control their own preferences.

### 6.2 Primary: Nostr

- The agent posts to one or more public Nostr relays.
- Envelope events use a dedicated kind (proposal: `30417`, "agent envelope"),
  with `p` tags pointing at the recipient's agent ID.
- Encrypted content per NIP-44 (conversation-scoped keys derived from the
  contact handshake).
- Why Nostr: key-first identity matches §4, relays are dumb pipes by design,
  hundreds of free public relays exist, and the ecosystem is explicitly open
  to new event kinds. (§14)

### 6.3 Fallbacks (all optional, all dumb pipes)

- **ntfy.sh** — topic-per-agent pub/sub; open source; public instance free.
- **MQTT** — public brokers (test.mosquitto.org, broker.emqx.io, HiveMQ
  public); topic = agent ID.
- **Human channels** — email / SMS / WhatsApp / Telegram, store-and-forward;
  the always-available slow path. Envelope rides `multipart/alternative` or a
  JSON block; agent-side parsing is the receiver's job.
- **DNS TXT** — lookup hint only (`_agent.<domain>`), not a delivery path.
- **Direct** — when either side has a routable endpoint: WebRTC-style
  hole-punching via public STUN (e.g. stun.l.google.com:19302) or TURN
  (open public relays), negotiated in-band. IPv6 endpoints are preferred when
  present.

### 6.4 Envelope

```json
{
  "v": 1,
  "from": "rdv1:…",
  "to": "rdv1:…",
  "seq": 42,
  "prev": "<hash of previous envelope>",
  "created": "…",
  "ttl": "48h",
  "content": {
    "alg": "x25519+aes256gcm",   // or NIP-44 framing on Nostr
    "ciphertext": "…",
    "nonce": "…"
  },
  "sig": "…"                     // over everything outside content
}
```

- Relays see `from`, `to`, `seq`, `ttl`, `sig` — nothing else.
- `seq`/`prev` give ordering and gap detection (§7).
- `ttl` lets relays garbage-collect and bounds replay windows.

---

## 7. Session & task layer (A2A semantics)

- Once contact is granted, agents exchange tasks using **A2A task objects**
  (`Task`, `Message`, `Part`, artifact updates) inside the envelope's
  encrypted content.
- The protocol is **asynchronous by default**: tasks, proposals, and
  confirmations are documents; no live channel is assumed. (Calendar
  negotiation = propose/accept cycles over store-and-forward.)
- Idempotency: task IDs are UUIDs; retries re-send the same envelope; the
  receiver deduplicates by ID.
- Ordering: `seq` is per-direction monotonic; gaps trigger a resend request.
- Cancellation: a `rdv/cancel` referencing a task ID, honored when the task
  is still pending.
- Late-bound sync: when both sides have routable endpoints, an in-band
  negotiation may upgrade to a direct channel (WebRTC data channel) for
  chatty phases; the envelope format is unchanged.

---

## 8. Threat model

| Threat | Mitigation |
|---|---|
| Spoofed contact request (fake email/from) | Request bound to arrival channel + key; grant binds to key; human sees channel context; fingerprint comparison |
| MITM on human channel | E2E envelope; Diffie-Hellman keys pinned at handshake; TOFU + change alert |
| Malicious relay reads content | Ciphertext-only at relay (§6.4); relay trust = zero |
| Relay logs metadata (who talks to whom) | Envelope minimizes metadata; fallback to human channels if metadata exposure is unacceptable |
| Spam agents (Sybil) | Consent-first inbound; key-based block; tier-based rate caps; §10 reputation |
| Replay | Envelope `seq`/`prev` + request/grant IDs; TTL bounds window |
| Key compromise | Rotation doc signed by old key; revocation; grants are revocable |
| Key loss (no recovery path) | §11 — open problem, mitigated by passkey custody |
| Government/relay takedown | No single relay matters; card lists several; human channels are last-resort always-on |

---

## 9. Privacy

- Owner identity is opt-in on public cards; private cards never leave the
  human channel.
- All content is E2E encrypted; relays see envelope metadata only.
- Human-channel delivery renders a **human-readable summary** plus the
  machine envelope; the human can always read what their agent receives on
  their behalf.
- Contact relationships are stored locally by each agent; no global social
  graph exists anywhere by construction.
- Deletion: agents honor `rdv/forget` requests; relays hold ciphertext with
  TTLs and can garbage-collect without harm.

---

## 10. Anti-spam & reputation

- **Consent-first:** unsolicited agents can't reach a human without a
  contact request the human approves. Default policy = `prompt`.
- **Key-based blocks** are permanent and portable; re-registering under a new
  key resets reputation to zero (Sybil remains an open problem, §11).
- **Rate limits** are grant-scoped (`max_frequency`); violations revoke the
  grant automatically.
- **Optional reputation:** a contact may attach verifiable vouches ("this key
  is also trusted by N of your existing contacts") — web-of-trust signals,
  never a global score.

---

## 11. Open problems (honest)

1. **Key recovery.** The key is the identity; losing it loses the agent's
   relationships. Passkey custody helps; a social-recovery design
   (m-of-n guardians) is deferred to v2.
2. **The fingerprint cliff.** Humans won't compare hex strings. Consent UX
   must lean on channel context ("request came from the email you've
   exchanged 47 messages with") rather than manual verification.
3. **Sybil attacks.** Key minting is free. Web-of-trust vouches mitigate;
   a clean general solution doesn't exist (email has the same disease).
4. **UI fragmentation.** The consent tap must render on every platform —
   email deeplink, messaging button, agent app. This is product surface, not
   protocol, and it's the bulk of the real work.
5. **Absorption risk.** A big lab can reimplement the idea. Accepted: the
   goal is interoperability, not ownership (MCP precedent).

---

## 12. Scope & phases

**v0.1 (this document):** identity, cards, contact request/grant, envelope,
Nostr primary, human-channel bootstrap.

**v0.2:** reference library (Rust or TypeScript), test vectors, interop tests.

**v0.3:** MCP server exposing the tool API (§13); dogfood on a live agent
fleet.

**v0.4:** fallback transports (ntfy/MQTT), direct-channel negotiation,
rotation doc, revoke semantics.

**v1.0:** multi-vendor interop event ("two vendors' agents coordinate a
dinner"), vouches, platform-profile discovery.

---

## 13. Reference implementation & distribution

Distribution model follows MCP: **install one MCP server; your agent gains a
calling card.**

Proposed MCP tool API (v0.3):

| Tool | Purpose |
|---|---|
| `rdv_init` | generate key + address card (or import existing) |
| `rdv_publish_card` | publish/refresh card on chosen rendezvous |
| `rdv_request_contact` | send a contact request (via hint or human channel) |
| `rdv_pending_requests` | list inbound contact requests (for consent UX) |
| `rdv_grant` / `rdv_revoke` | approve/reject/revoke contacts with tier+scope |
| `rdv_send` | send an envelope (task, message, proposal) |
| `rdv_inbox` | receive/ack envelopes (dedupe, ordering) |
| `rdv_negotiate` | A2A task exchange lifecycle |

---

## 14. Appendix

**Why Nostr?** Key-first identity is identical to the agent-ID model; relays
are dumb pipes by design; hundreds of free public relays exist; new event
kinds are a supported extension point; no account system required.

**Why not blockchain?** A chain adds consensus, latency, cost, and a
public-by-default ledger to a problem that needs pairwise secure messaging.
Identity needs keys, not blocks; consent needs signatures, not a chain;
discovery needs hints, not a ledger. The one blockchain-flavored idea that
survives — a tamper-evident consent audit log — is served by signed
append-only documents, no consensus required.

**Why not only email?** Email is the universal fallback but is slow,
metadata-leaky, and awkward for agents; Nostr gives low-latency relayed
delivery with the same trust model. The card lists both; the network heals
across them.

**Naming.** "Rendezvous" is a working title. The protocol's substance is
vendor-neutral and unowned.
