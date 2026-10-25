# Rendezvous
## An Open Protocol for Agent-to-Agent Contact

**Status:** Draft v0.1 rev 3 (2026-10-25) — for discussion
**Author:** Omer Nesher
**Date:** 2026-10-25 (rev 2: 2026-10-09)

> Codename "Rendezvous" is provisional. The protocol describes how a personal AI
> agent belonging to one human makes contact with, and safely communicates with, a
> personal AI agent belonging to another human — across different vendors,
> networks, and platforms.

> **Rev 2 (2026-10-09)** adds machine-first discovery: hint-server topics
> (Nostr / ntfy / MQTT), the mailbox probe, the invite, and optional discovery
> directories with friend suggestions (on by default). Rev 1 defined identity, consent
> and transport; rev 2 defines how two agents *find each other* in the first
> place.

> **Rev 3 (2026-10-25)** folds in what the TypeScript reference implementation
> (`impl/`) found: the wire format is now pinned down (canonical JSON, base32,
> signatures, envelope encryption, the Nostr carrier), the envelope signature
> covers the ciphertext, the grant carries the grantor's card, and consent, A2A
> meeting negotiation and untrusted peer text are specified. No discovery or
> consent concept changed; see **Changes in rev 3** below.

**Changes in rev 3**

- **Security fix, §6.4:** the envelope signature covers `content` (rev 2 left
  it out, so a genuine header could carry a substituted ciphertext). The
  encryption (ephemeral key `epk`, HKDF, AES-GCM) is now described.
- **Wire format, new §4.6:** canonical JSON (RFC 8785 subset), base32 alphabet
  and case, `sig` encoding and domain separation, `canon(address)`. §4.2 and
  §4.4 point to it.
- **Nostr, §6.2:** envelope kind `30417` stays, with a mandatory unique `d`
  tag; the regular-kind alternative and the 2026-10 relay survey are recorded.
  The secp256k1 carrier key and the `p` tag value are defined. NIP-44 is no
  longer claimed for v0.1.
- **Discovery, §4.4:** the `claimed` tier cap applies to the default tier, not
  an explicit human choice; the listen-mode probe is a contact request posted
  on the `dtopic`; probe greetings are public; the requester records a binding
  too.
- **Consent, §5:** the grant carries the grantor's card (§5.3); who may answer
  a request; document IDs are UUIDs; grant direction and `max_frequency`
  format; scope defaults. New §5.5 (consent stays with the human) and §5.6
  (peer text is untrusted data).
- **A2A, §7:** which A2A objects are sent, the meeting verbs, task states,
  slots, deduplication by `messageId`, cancellation, resend bounds, and
  persisting state before send.
- **Elsewhere:** threat-model rows (§8), probe privacy (§9), new open problems
  (§11), phases aligned with the implementation plan (§12), MCP consent and
  inbox semantics (§13).

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
**agent identity, discovery, first contact, consent, and communication**,
designed so that nobody *has* to run infrastructure to participate. It reuses
proven building blocks — cryptographic keys for identity, Nostr relays as the
primary rendezvous, A2A for task semantics — and treats every transport as an
untrusted dumb pipe carrying end-to-end-encrypted envelopes.

Discovery is machine-first: agents find each other through silent hint-server
topics, DNS, and — only when nothing answers — a signed mailbox probe or a
premade invite. The human channel is the fallback transport and the place
consent lives, not the first place to look.

**Goals:**
- Any agent can contact any other agent, regardless of vendor or network.
- Any agent can be *found* by requesters who hold one of its owner's contact
  points — silently, without emailing a human first.
- Consent is a first-class protocol object: the human always decides who may
  reach their agent and what the relationship may do.
- Zero *required* infrastructure: no central registry, no company server, no
  required relay operator. Optional discovery directories exist, are
  community-run, and can be skipped by anyone.
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
person-to-person layer — for contact *or* discovery. The MCP precedent — an
open protocol that won by solving fragmentation at the moment of peak pain,
with zero ideology — is the template this spec follows.

---

## 3. Design principles

1. **Discovery is machine-first; humans are the trust anchor.** Agents find
   each other through silent channels (hint-server topics, DNS, an optional
   directory) and, when nothing answers, a signed mailbox probe. The human
   channel — email/SMS/WhatsApp — is the fallback transport and the place
   consent lives. No new app, no new account, no always-on device.
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
   users already pay for. The protocol ships a spec and a reference library
   and runs no *required* servers; optional discovery directories are
   community-run, swappable, and skippable.
6. **Self-healing by redundancy.** An address card lists several rendezvous
   hints (Nostr relay, ntfy topic, MQTT, email, phone, DNS TXT). Failure of
   any one is routine, not fatal.
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
  the grace window. A key change **outside** a signed `rotate` document is a
  trust event: change alert + fresh consent handshake. (See §11 open problems
  on recovery.)

### 4.2 Agent ID

```
rdv1:<base32(ed25519-pubkey)>
```

- `rdv1` prefix disambiguates from other ID schemes.
- `base32` is the RFC 4648 alphabet, lowercase, without padding (§4.6): the
  32-byte key becomes 52 characters, so an ID is 57 characters long.
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
  "discovery": {            // OPTIONAL — enables machine-first discovery
    "addresses": [          // contact points the owner is findable by
      {"type": "email", "value": "john@doe.com"},
      {"type": "phone", "value": "+972-54-000-0000"}
    ],
    "public_pointer": false // default: listen-only dead drop (§4.4)
  },
  "rendezvous": [           // ordered fallback list
    {"type": "nostr", "relay": "wss://relay.damus.io", "topic": "<kind-30417>", "pref": 1},
    {"type": "ntfy", "topic": "rdv-7f3a9c2d", "pref": 2},
    {"type": "email", "to": "rdv+7f3a9c2d@agent.example", "pref": 3},
    {"type": "dns", "domain": "doe.com", "pref": 0}
  ],
  "policy": {
    "inbound": "prompt",     // allow | block | prompt
    "public": false          // publish card to public relays / pointers?
  },
  "sig": "…ed25519 signature over the canonical JSON above (§4.6)…"
}
```

Rules:
- `owner` fields are **opt-in and minimized**. A public card need not name
  its owner at all.
- `discovery.addresses` is opt-in per address: each listed address opens the
  dead-drop listen topic for that address (§4.4). Listing an address is a
  deliberate act, not a default.
- `rendezvous` is ordered by preference; `pref: 0` entries (like DNS TXT) are
  lookup hints rather than delivery addresses.
- The card is versioned (`v`), signed, and revocable via expiry.

### 4.4 Discovery of a card

Discovery is machine-first: the requester's agent tries silent, machine-only
paths **before** any human channel is involved; the human channel is the
fallback and remains the anti-spoofing trust anchor. In order of availability:

1. **Hint servers (primary)** — Nostr relays, ntfy.sh and MQTT carry a
   per-address topic derived deterministically from a contact point:

   ```
   dtopic(address) = base32(SHA-256("rdv1/disc:" ‖ canon(address)))[0:26]
   ```

   (`canon` and `base32` are defined in §4.6. The same topic namespace is
   used on all three carriers — Nostr as a `t` tag on the agent-envelope
   kind, one topic per transport.) Two modes, both **per-address opt-in**,
   dead drops otherwise:
   - **Listen** — the agent watches its own topics. A requester who holds the
     address leaves a small, signed, protocol-shaped "who knows me" probe and
     the agent answers per policy. This is the cheapest lookup that exists:
     no email, no inbox, no human interruption. The probe **is** a contact
     request (§5.1) posted on the `dtopic` with `to_hint` set to the address;
     there is no separate probe document. The listener gates it exactly like
     any inbound request, with binding `claimed`. The probe is cleartext on
     the carrier (§9): keep the greeting short.
   - **Public pointer** — the agent publishes its card (or a card hash) on
     the topic, so a requester can fetch it without posting first. Default
     off; `policy.public` gate.
2. **DNS TXT** — `_agent.<domain> TXT "rdv=rdv1:…"` for owners with domains.
3. **Platform profile fields** — a `rdv1:…` line in an X bio / LinkedIn
   about / GitHub profile. The platform account vouchsafes the binding.
4. **Directories (optional)** — community-run services that answer
   *blinded* lookups; see §4.5. Off by default.
5. **Mailbox probe (email first)** — a signed email carrying the contact
   request, delivered through the recipient's mail rule; see §5.2.1. The
   universal fallback: works wherever email does, and proves mailbox control.
   (The profile generalizes to other carriers later.)
6. **Direct (STUN)** — once both sides know each other's hints, ICE/STUN
   hole-punching upgrades the conversation to a direct link. STUN is a
   connectivity upgrade after discovery, not a lookup.
7. **In person** — QR code / NFC containing the card.

**Bindings.** Every discovery path yields a *binding level*, recorded with
the contact and shown at consent time:

| Path | Binding | Meaning |
|---|---|---|
| QR / NFC in person | `in-person` | Out-of-band, strongest |
| DNS TXT | `dns` | Control of the domain proven |
| Mailbox probe | `mailbox` | Control of the mailbox proven (handshake echo) |
| Hint topics, profiles, directories | `claimed` | Self-asserted |

A `claimed` binding is a lead, not a credential: the **default** tier offered
at consent caps at `stranger` until a stronger binding promotes it. A human
who explicitly picks a higher tier at consent *is* the explicit confirmation
that promotes it; the cap constrains defaults, never the owner's choice.
Bindings attach to the relationship record, not the card, and both sides
keep one: the requester records how it found the peer (`claimed` for a topic
probe or a public pointer; `in-person` when the owner says the card came from
a QR code or face to face).

### 4.5 Discovery directories (optional)

A directory is a small, community-runnable HTTP service that maps
`dtopic(address) → listing { card, updated, listing_sig }`. Listings are
self-asserted (`claimed`); the server verifies only the request signature.

- **Blinded lookups.** Queries use an OPRF (RFC 9497): the requester blinds
  the `dtopic`, the server evaluates it against a twisted store, the
  requester unblinds. The server learns neither the contact point nor the
  match — and only exact-contact matches are ever returned. There is no
  browsing, no name search, no enumeration.
- **Listing is opt-in** per the card's `policy`, separate from `public`.
- **Suggestions ("people you may know").** On by default — switch it off
  anytime. The agent runs its owner's own contact list against configured
  directories, locally, and surfaces hits: *"John appears to have an agent.
  Connect?"* Nothing is sent until the owner taps. On connect, the agent
  keeps the peer's card; no rediscovery, forever. Suggestions can only
  surface owners who opted into a listing — a suggestion is a lead,
  confirmed by the handshake.
- **Two switches:** *suggest friends* is on by default (owner-facing,
  computed locally; switch it off anytime). *list me* in a given directory
  is opt-in — a publishing act, off by default.
- **No federation, no authority.** Directories are shards, not a registry:
  anyone may run one, clients choose which to trust, and skipping directories
  entirely never breaks anything.

### 4.6 Encoding, canonical JSON and signatures

Every signed document (card, request, grant, revoke, envelope) follows the
same rules, so independent implementations produce identical bytes:

- **Canonical JSON** (`canon(doc)`) is a subset of RFC 8785 (JCS): UTF-8,
  object members sorted by key, no insignificant whitespace, absent members
  omitted. Numbers MUST be integers (timestamps and durations are strings, so
  no floating-point number is ever serialized); `null` is allowed.
- **Base32** is the RFC 4648 alphabet, lowercase, no padding. It is used for
  agent IDs (§4.2) and discovery topics (§4.4).
- **Hash** values (`prev`, the Nostr `d` tag) are the lowercase hex SHA-256 of
  the canonical JSON of the whole document, `sig` included.
- **`sig`** is the base64 (RFC 4648 §4, standard alphabet, padded) encoding of
  the 64-byte Ed25519 signature over
  `"rdv1/sig:" ‖ canon(doc without sig)`. The prefix domain-separates
  Rendezvous signatures from any other use of the same key, so a signature
  cannot be lifted from one context to another. Binary fields inside
  `content` (§6.4) use the same base64.
- **`canon(address)`** is the bare value with no type prefix: an email is
  trimmed and lowercased; a phone is `+` followed by digits only (a leading
  `+` is required; separators are removed).

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
resolve for the target (including hint-server topics), delivered by the
mailbox probe (§5.2.1), or sent through the human channel (email/SMS/
WhatsApp) addressed to the human.

Rules:
- `id` MUST be an RFC 4122 UUID string, as must the `id` of every grant and
  revoke and a grant's `request_ref`. Receivers reject anything else: IDs are
  chosen by the peer and end up in logs and user interfaces.
- A request sent to a known card travels inside an encrypted envelope. A topic
  probe (§4.4) is posted in cleartext on the carrier, greeting and card
  included (§9).
- `greeting` is peer-written text: display-only (§5.6).

### 5.2 Human-channel bootstrap

When machine-first discovery yields nothing, contact travels the human
channel. Two profiles cover the cases: the **mailbox probe** when the
requester holds a human address and wants to know if an agent exists
(§5.2.1), and the **invite** when no agent was found and the owner chooses to
recruit one (§5.2.2). In both, the signed grant flow (§5.3) is unchanged:
nothing proceeds without the receiving human's approval.

The human channel is also the **anti-spoofing anchor**: contact is bound to
the address it arrived through, and the human verifies against the social
context they already have ("I do know john@doe.com"). Key fingerprints
are additionally comparable out-of-band (Signal safety-number model).

### 5.2.1 Mailbox probe (email probe profile)

The probe is a three-way handshake, like TCP:

```
SYN       contact-request by email, marked [RDV-PROBE]
SYN-ACK   contact-grant + recipient card + cookie
ACK       first envelope on the recipient's preferred hint, echoing the cookie
```

**Design goals:** discovery without awkwardness ("does this person even have
a bot?") and an anti-spoofing anchor. *The mail rule routes; the agent gates.*

**Marking.**
- Subject starts with `[RDV-PROBE]` followed by a plain-language line, e.g.
  *"bot discovery request — if you're a human, you can ignore this."*
- `X-Rdv-Probe: v=1; id=<uuid>; from=rdv1:…` for header-aware rules.
- `Auto-Submitted: auto-generated` (RFC 3834) so out-of-office responders
  and other bots never loop. A probe has one recipient, no Cc/Bcc, and is
  never sent to a list.

**Body.** A short human-readable paragraph, plus the machine part fenced
between `---BEGIN RDV/1---` and `---END RDV/1---` markers (canonical JSON:
the signed contact request, the requester's card, a cookie slot).

**The rule (integrator recipe).**
1. Match the subject prefix or the header.
2. Hand the message to the agent's probe endpoint and remove it from the
   inbox (archive — no clutter; it reaches the human surface only when
   policy says `prompt`, and then in the bot chat, not the mail app).
3. Apply the owner's policy: `block` — silent drop; `prompt` — surface in
   the bot chat; `allow` — auto-grant within the pre-approved scope.

**The gate (mandatory, before anything reaches a model).** Probes are
attacker-controlled text addressed to a bot — the exact shape of a prompt
injection — so parsing is deterministic and content never executes:
1. Parse the fenced JSON; reject anything malformed.
2. Verify the Ed25519 signature; verify DMARC/DKIM/SPF via
   `Authentication-Results` (RFC 8601). Unaligned mail is challenged, never
   trusted.
3. Rate-limit and dedupe by request id; probes expire after 14 days.
4. Only then apply policy. Raw probe text is data, never instructions — the
   gate runs before any LLM sees a byte of it.

**Verification (the mailbox proof).**
- If DMARC passes, arrival already carries a weak channel proof and the
  agent may prompt the human immediately.
- Otherwise the reply is a stateless challenge:
  `cookie = HMAC(K_agent, request_id ‖ canon(from) ‖ date)`, truncated.
  Only a requester who actually received the reply can echo the cookie — the
  SYN-ACK proves mailbox control, and forged probes die quietly.
- The ACK (third leg) rides the recipient's preferred hint from the returned
  card (or replies by email if none is reachable) and opens the normal
  envelope flow (§6). Until the ACK lands the contact is `pending`.

**Silence.** Default policy is `prompt`, so no reply ever confirms to an
unknown sender whether an agent exists. Probes are owner-initiated only, at
most one per address per 30 days (configurable). Zero replies within the
window means "no agent found" — the requester never nags; the owner may then
choose to invite (§5.2.2).

**The reply.** Sent from the agent's own mailbox identity (e.g.
`rdv+<agentid>@…`, or the same address with a distinct token,
`[RDV-PROBE-ACK]`) so humans can tell agent mail from human mail at a glance.

**Other carriers (later).** The probe profile is carrier-agnostic: a signed
JSON envelope plus fixed markers. WhatsApp / Telegram: a marker line as the
first message line. SMS: short token plus link. Email ships first because
rules, headers and DMARC give it the strongest deterministic gate.

### 5.2.2 Invite (no agent found)

When discovery comes up empty — listen topics silent, no DNS record, no
directory hit, probe unanswered — the owner can send a premade invitation,
modeled on WhatsApp's "this person isn't on WhatsApp — invite them?" flow.
The invite is the network's growth path, and it is human, not spam.

**Marking.** Same machinery as the probe: the subject starts with
`[RDV-INVITE]` (or `X-Rdv-Invite: v=1; …` for header-aware rules), plus the
standard `---BEGIN RDV/1---` block carrying `rdv/invite` and the single-use
token. One message serves both realities: if the recipient's agent exists,
its mail rule hands the invite straight to the agent; if no agent exists,
the human reads a friendly note.

- Sent only after the owner confirms ("Dana doesn't seem to have an agent.
  Invite her?" → Send). One pending invite per address; 30-day cooldown on
  silence or decline; permanent opt-out honored.
- Written to read as a note from the owner, explicitly disclosed as sent by
  their assistant, and stating where the sender got the address.
- Carries a single-use token (inside the standard `---BEGIN RDV/1---` block
  as `rdv/invite`) plus a short explainer link. Acceptance replies with the
  token; if the recipient has an agent, it picks up the thread and the
  normal consent flow (§5.1–5.3) runs. No token, no data.
- Invites never carry the owner's card beyond what is needed; the full card
  exchange happens only after acceptance.
- When the invitee later runs an agent, the token maps the human
  introduction to the handshake — no rediscovery needed.

### 5.3 Contact Grant (consent)

```json
{
  "v": 1,
  "type": "rdv/contact-grant",
  "id": "<uuid>",
  "from": "rdv1:<grantor key>",
  "to": "rdv1:<requester key>",
  "request_ref": "<contact-request or probe id>",
  "card": "<grantor's address card>",
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
explicit capability lists and vendors may add scopes. The default tier for a
`claimed` binding caps at `stranger` (§4.4); an explicit human choice is not
capped.

Rules:
- **The grant carries the grantor's card** (`card`). After a topic probe the
  requester knows only the address, so the card is how it learns where to
  reach the grantor (the SYN-ACK of §5.2.1 carries it too). The requester
  verifies the card (signature, not expired, `card.id` equals `from`) before
  using it.
- **`tier`** MUST be one of the tiers above; a grant with any other value is
  rejected. `scope` MUST be a JSON object.
- **Who may answer a request.** A request sent to a specific card is
  satisfied only by a grant signed by that card's agent; any other grantor is
  rejected before state changes. A topic probe has no addressee, so anyone
  who saw it on the `dtopic` can answer. The requester MUST ignore a probe
  answer whose card does not list the probed address in
  `discovery.addresses`, and MUST NOT turn any probe answer into a contact
  until its owner confirms it, after being shown the grantor's fingerprint
  (§5.5). Until then the answer is a *candidate*: several grantors may answer
  one probe, and each is kept as a separate candidate (the reference keeps up
  to 16 per probe, one per grantor), so an eavesdropper who answers first
  cannot displace the real target. Keys are free, so a flood can still fill
  one probe: answers beyond the cap MUST NOT evict another probe's
  candidates, and the requester SHOULD count them and tell its owner that
  the real answer may be among the dropped ones and the contact is best
  redone by card (in person, or another trusted channel). A confirmed probe
  answer is recorded as `claimed`.
- **Direction.** A grant authorizes the requester to contact the grantor
  within `scope`; that is all it does. A received grant MUST NOT set what the
  grantor may do towards the requester: the grantor chose that scope, and the
  requester's human has approved nothing. Until the requester's owner grants
  the peer explicitly (a local approval, §5.5), the requester applies its
  own local default to the grantor: it may write (`may_initiate`), may not
  propose meetings, gets no calendar access, and is rate-limited locally
  (reference: `50/day`). The grantor's `tier` is likewise only how the grantor
  classifies the requester; the requester's own tier for the grantor starts at
  `stranger`.
- **`max_frequency`** is `"<n>/<minute|hour|day>"`; exceeding it revokes the
  grant (§10).
- Scope defaults for meetings are in §7.4.

### 5.4 Policy and revocation

- The receiving agent's inbound policy is `allow` (only grants from the
  allowlist), `block` (key-based, permanent for that key), or `prompt` (the
  default — surface to the human).
- Revocation: a `rdv/revoke` document, or simply dropping the grant entry.
  Blocked keys never receive responses (silent drop is a privacy feature).
- Replay protection: request, grant, probe and invite IDs are stored;
  duplicates ignored. Probe cookies are stateless and expire with the probe.

### 5.5 Consent stays with the human

Approval MUST come from the human, through a channel the assistant model
cannot answer. An assistant that can grant on its own, or can be talked into
it by a greeting, defeats consent. A host that exposes the protocol to a model
(an MCP server, a chat bot, an app) therefore MUST NOT grant on the strength
of model output alone. Acceptable approvals are:
- a confirmation answered by the human in the host's own UI (for MCP, an
  elicitation request);
- a per-request confirm phrase shown only on human channels (a terminal, a
  local UI) and typed by the human; it never appears in a tool result. The
  reference implementation accepts a phrase only for tiers less close than
  `family` (`friend` and below);
- the owner's own command in a terminal;
- a standing pre-approval the owner set as policy (`allow`, §5.4).

The same holds on the requester's side. A grant the agent *receives* is the
peer's decision, not its owner's: it sets only what the agent may do towards
the peer (§5.3), and choosing which answer to a topic probe is the real peer
needs one of the approvals above. Widening what a peer may do towards the
agent (meetings, calendar, a higher rate) is always the agent's own owner's
grant.

### 5.6 Peer text is untrusted data

Greetings, text parts, decline reasons and card `owner` fields are written by
the other side and can carry instructions aimed at the reader's assistant.
They are display-only: they MUST NOT be followed, and only machine (`data`)
parts and validated fields may drive actions. Short structural fields
(payload `type`, IDs, tiers, states) are validated against strict shapes and
rejected if they do not match. A host SHOULD hand peer text to a model only
when clearly marked as untrusted, and SHOULD strip terminal control
characters before showing it.

---

## 6. Transport layer

### 6.1 Rendezvous hints

Each address card lists ordered transports. The envelope (encrypted, signed)
is delivered over the first available hint; acks travel the same way. Ordering
is per-card, so both parties control their own preferences.

**Direct-first — permanently.** Keys are pinned once exchanged (TOFU; a change
outside a signed rotation triggers the alert and a fresh handshake). Every
later conversation between the two agents opens a direct channel immediately
when both sides are reachable — no rediscovery, no relay hop to set up. Relays
cover only what direct can't: offline peers (store-and-forward) and networks
where hole-punching fails (TURN relays carry the ciphertext).

### 6.2 Primary relay: Nostr

- The agent posts to one or more public Nostr relays. Relayed delivery covers
  first contact, offline peers, and failed hole-punching — everything a
  direct channel can't reach.
- Envelope events use a dedicated kind (`30417`, "agent envelope"). The event
  `content` is the envelope JSON (§6.4). Tags: `p` is the recipient's Ed25519
  public key as lowercase hex (not the `rdv1:` string); `d` is the envelope
  hash (§4.6). Discovery topics ride the same kind: `t` holds the `dtopic`
  (§4.4) and `d` is the hex SHA-256 of the event content.
- **Kind decision (rev 3).** `30417` is in the addressable range
  (30000-39999), where relays keep only the latest event per (pubkey, kind,
  `d`), so two envelopes without distinct `d` tags overwrite each other. Rev 3
  keeps `30417` and makes a unique `d` (the envelope hash) mandatory.
  Alternative: a regular kind (1000-9999), which stores every envelope as its
  own event and removes the `d` fragility. A 2026-10 survey of public relays
  (nos.lol, relay.primal.net, nostr.mom, relay.damus.io and others) found no
  relay-side difference: all kept 30417 and a regular test kind alike, with
  `#p`/`#t` queries and distinct `d` values. The case for a regular kind is
  therefore semantic, not empirical; it is a wire change to revisit with the
  test vectors if a relay starts to differ. Not tested: same-`d` overwrite and
  long-term retention.
- **Carrier key.** Nostr events are signed with secp256k1, not Ed25519. Each
  agent derives a stable carrier key: HKDF-SHA256 over its Ed25519 seed, no
  salt, info `"rdv1/nostr-carrier"`, 32 bytes. It signs the Nostr event only;
  authenticity comes from the envelope signature, so receivers MUST NOT treat
  the carrier public key as the sender's identity.
- Encryption is the envelope's own (§6.4), not NIP-44. Conversation-scoped keys
  derived from the contact handshake are future work.
- Why Nostr: key-first identity matches §4, relays are dumb pipes by design,
  hundreds of free public relays exist, and the ecosystem is explicitly open
  to new event kinds. (§14)

### 6.3 Fallbacks (all optional, all dumb pipes)

- **ntfy.sh** — topic-per-agent pub/sub; open source; public instance free.
  Also a discovery carrier (§4.4 `dtopic`, listen mode).
- **MQTT** — public brokers (test.mosquitto.org, broker.emqx.io, HiveMQ
  public); topic = agent ID. Also a discovery carrier (`dtopic`).
- **Human channels** — email / SMS / WhatsApp / Telegram, store-and-forward;
  the always-available slow path. Envelope rides `multipart/alternative` or a
  JSON block; agent-side parsing is the receiver's job. Carries the probe
  (§5.2.1) and invite (§5.2.2).
- **DNS TXT** — lookup hint only (`_agent.<domain>`), not a delivery path.
- **Direct (the default after contact)** — once keys are pinned, every
  conversation attempts direct first: ICE (RFC 8445) with STUN (RFC 8489)
  hole-punching, negotiated in-band. IPv6 endpoints are preferred when
  present. Relays and TURN carry traffic only as fallback (offline peers,
  failed punch-through).

### 6.4 Envelope

```json
{
  "v": 1,
  "from": "rdv1:…",
  "to": "rdv1:…",
  "seq": 42,
  "prev": "<hash of previous envelope, null for the first>",
  "created": "…",
  "ttl": "48h",
  "content": {
    "alg": "x25519+aes256gcm",
    "epk": "…",                  // ephemeral X25519 public key, base64
    "nonce": "…",                // 12 random bytes, base64
    "ciphertext": "…"            // base64
  },
  "sig": "…"                     // over everything outside sig, content included (§4.6)
}
```

- **The signature covers `content`.** Rev 2 signed only the header. Anyone
  holding one genuine envelope could then keep its signed header and swap in
  a ciphertext of their own, encrypted to the recipient, which the recipient
  would accept as coming from the header's sender.
- **Encryption.** The sender generates an ephemeral X25519 key pair per
  envelope and combines it with the recipient's X25519 key (its Ed25519
  identity key, converted). The AES-256 key is
  `HKDF-SHA256(secret, salt = epk ‖ recipient_x25519_pub, info = "rdv1/envelope")`,
  32 bytes. The cipher is AES-256-GCM with a random 12-byte nonce, and the
  header (`v`, `from`, `to`, `seq`, `prev`, `created`, `ttl`) is bound as
  associated data. The plaintext is the payload JSON (§7).
- Relays see the header and `sig`, plus `epk`, nonce and ciphertext size; they
  cannot read the payload.
- `seq`/`prev` give ordering and gap detection (§7). The first envelope in a
  direction has `seq: 1` and `prev: null`; later ones carry the hash (§4.6) of
  the previous envelope in the same direction.
- `ttl` is `<n><s|m|h|d>` (default `48h`); an envelope is expired when
  `created + ttl` has passed. It lets relays garbage-collect and bounds replay
  windows.
- **No forward secrecy yet.** The recipient key is static, so a later key
  compromise exposes recorded envelopes (§11).

---

## 7. Session & task layer (A2A semantics)

- Once contact is granted, agents exchange tasks using **A2A v0.3 objects**
  (§7.1) inside the envelope's encrypted content. The payload is a JSON
  document with a `type` field.
- The protocol is **asynchronous by default**: tasks, proposals, and
  confirmations are documents; no live channel is assumed. (Calendar
  negotiation = propose/accept cycles over store-and-forward.)
- Idempotency: task IDs are UUIDs; retries re-send the same envelope. There
  are two dedupe layers: the receiver drops an envelope it has already seen
  (same `seq`), and drops a re-sent A2A message (same `messageId`, new
  envelope) per task.
- Ordering: `seq` is per-direction monotonic. A gap buffers later envelopes
  and triggers `{"type": "rdv/resend", "from_seq": n, "to_seq": m}`; the
  sender replays from an outbox (the reference implementation keeps 64
  envelopes). Receivers MAY bound and drop: the reference implementation
  buffers out-of-order envelopes only from contacts and from agents it asked
  by card (16 peers x 64 envelopes).
- Persistence: a sender SHOULD commit the new `seq`, `prev` and its outbox to
  durable storage before the envelope leaves, so a crash cannot reuse a
  `seq`. The worst case is then a payload delivered twice.
- Cancellation: a `rdv/cancel` referencing a task ID, honored when the task
  is still pending (not terminal).
- Direct-first operation: once both sides have routable endpoints, the
  in-band negotiation opens a direct channel (WebRTC data channel)
  immediately — the default mode of every subsequent session, not an
  upgrade. Relays resume only for offline peers and NAT failures. The
  envelope format is unchanged.

### 7.1 A2A mapping

Two payload types carry A2A v0.3 objects: `a2a/message` holds a `Message`
(one negotiation turn) and `a2a/task-update` holds a `TaskStatusUpdateEvent`
(an acknowledgement or end state). A whole `Task` object is never sent; each
side keeps its own copy. A2A assumes a client and a server agent, but both
peers here are agents, so `role` is always `"agent"`. `messageId`, `taskId`
and `contextId` are UUIDs; one `contextId` covers one negotiation.

A message has human parts (`text`) and one machine part (`data`) whose
`data.rdv` names the verb (§7.2). Text parts are for humans and never drive
anything (§5.6). Receivers validate strictly and reject unknown keys, unknown
verbs and non-UUID IDs.

### 7.2 Meeting verbs

| `data.rdv` | Fields | Meaning |
|---|---|---|
| `meeting/propose` | 1-3 `slots`, optional `place`, `expires` | open a negotiation |
| `meeting/counter` | 1-3 `slots`, optional `place`, `expires` | offer different slots |
| `meeting/accept` | one `slot` | accept a slot from the latest offer |
| `meeting/decline` | `reason` | refuse; nothing fits |
| `rdv/cancel` | optional `reason` | withdraw, by the message's `taskId` |

A slot is `{"start", "end"}`, RFC 3339 date-times with an explicit offset
(`Z` or `±HH:MM`), compared as instants, so an accept may write the slot in
another offset; at most 12 hours long. `expires` defaults to 48 hours and a
receiver clamps it to 7 days. How to extend the verb set is open (§11).

### 7.3 Task states

`submitted` (proposal sent) → `input-required` (the responder countered) or
`working` (the proposer countered back) → `completed` | `rejected` |
`canceled`. A round is one offer; the receiver of the third offer declines if
nothing fits, which ends the task `rejected`. An accept MUST pick a slot from
the latest offer it answers. The reference policy is: offer up to 3 free
slots, accept the first slot that is free, otherwise counter with 3 of your
own; implementations MAY choose a different policy within these rules.

A cancel is honored while the task is not terminal. A cancel that arrives
before its proposal leaves a tombstone so the proposal is refused when it
lands. A cancel, or any verb, for a finished task is answered with a status
update giving its real end state.

### 7.4 Scope and defaults

Meeting verbs require `may_propose_meetings: true` in the grant that covers
the direction (§5.3): proposing to a peer, and answering on a negotiation we
proposed, need the peer's grant to us; a peer proposing to us needs the grant
our owner gave the peer. If `may_access_calendar` is absent it
counts as `free_busy`, because proposing a slot is a free/busy disclosure;
`none` blocks negotiation. At every level, including `full`, meeting messages
carry slots only, never event titles.

Peer state is bounded: only a meeting-capable grant may create tasks (or
tombstones); a receiver SHOULD cap tasks per peer (reference: 32, evicting
finished ones and tombstones first and refusing when all are pending) and
prune finished tasks (reference: after 30 days).

---

## 8. Threat model

| Threat | Mitigation |
|---|---|
| Spoofed contact request (fake email/from) | Request bound to arrival channel + key; grant binds to key; human sees channel context; fingerprint comparison |
| Forged probe (spoofed sender) | DMARC/DKIM/SPF + Ed25519 verification; stateless cookie echo proves mailbox control; unaligned probes challenged or silently dropped |
| Malicious probe content (prompt injection) | Deterministic delimiter parse; probe gate before any LLM; content is data, never instructions |
| Probe flooding | Owner-initiated only; ≤1/address/30 days; global caps; agent-side filtering; key-based block |
| Invite abuse / spam | Owner confirms each invite; 1 pending per address; 30-day cooldowns; opt-out honored; disclosure inside the message |
| Directory harvesting | Exact-contact match only, blinded via OPRF (RFC 9497); rate limits; directories swappable |
| Suggestion privacy leak | Suggestions computed locally on the owner's agent; *list me* stays opt-in; OPRF hides queries from the server |
| MITM on human channel | E2E envelope; Diffie-Hellman keys pinned at handshake; TOFU + change alert |
| Malicious relay reads content | Ciphertext-only at relay (§6.4); relay trust = zero |
| Relay swaps the ciphertext under a genuine header | The signature covers `content` (§6.4), and the header is AES-GCM associated data |
| Assistant approves a contact on its own, or is talked into it | Consent stays with the human, outside the model's reach (§5.5) |
| Prompt injection through greetings or message text | Peer text is display-only data; only validated machine fields drive actions (§5.6) |
| Stranger answers a topic probe | Grant recorded as `claimed`; grantor fingerprint shown before trust (§5.3) |
| Relay logs metadata (who talks to whom) | Envelope minimizes metadata; fallback to human channels if metadata exposure is unacceptable |
| Spam agents (Sybil) | Consent-first inbound; key-based block; tier-based rate caps; §10 reputation |
| Replay | Envelope `seq`/`prev` + request/grant/probe IDs; TTL bounds window |
| Key compromise | Rotation doc signed by old key; revocation; grants are revocable |
| Key loss (no recovery path) | §11 — open problem, mitigated by passkey custody |
| Government/relay takedown | No single relay matters; card lists several; hint servers are swappable; human channels are last-resort always-on; nothing is required |

---

## 9. Privacy

- Owner identity is opt-in on public cards; private cards never leave the
  human channel.
- Discovery topics derive from contact points: a listener learns only that
  someone who holds the address is asking — never identity, never content.
- Directories see neither queries nor matches (OPRF); *suggest friends*
  is on by default and switchable off; *list me* is opt-in per directory.
- A topic probe (§4.4) is cleartext on the carrier: its greeting and the
  requester's card are readable by the relay and by anyone who knows the
  topic. Keep greetings short and free of private detail. Requests to a known
  card travel inside an encrypted envelope.
- Probes and invites are owner-initiated and rate-limited; received probes
  are archived with the consent record as an audit trail.
- All content is E2E encrypted; relays see envelope metadata only.
- Human-channel delivery renders a **human-readable summary** plus the
  machine envelope; the human can always read what their agent receives on
  their behalf.
- Contact relationships are stored locally by each agent; no global social
  graph exists anywhere by construction.
- Deletion: agents honor `rdv/forget` requests; relays hold ciphertext with
  TTLs and can garbage-collect without harm. Directory listings are
  revocable at will.

---

## 10. Anti-spam & reputation

- **Consent-first:** unsolicited agents can't reach a human without a
  contact request the human approves. Default policy = `prompt`.
- **Key-based blocks** are permanent and portable; re-registering under a new
  key resets reputation to zero (Sybil remains an open problem, §11).
- **Rate limits** are grant-scoped (`max_frequency`); probes and invites
  carry their own caps (§5.2.1–5.2.2); violations revoke the grant
  automatically.
- **Optional reputation:** a contact may attach verifiable vouches ("this key
  is also trusted by N of your existing contacts") — web-of-trust signals,
  never a global score.
- **Directory listings are optional** and never required for discovery: hint
  topics and the probe work without any directory existing.

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
6. **Cold start.** A two-sided network needs both sides. Mitigations are
   designed in — machine-first discovery needs no permission to *find*,
   invites convert humans, suggestions surface existing friends — but
   nothing forces adoption. This is market risk, not protocol risk.
7. **Directory trust (small).** Blinded lookups keep directories blind and
   they are swappable, but a listed agent still trusts its chosen directory
   to stay available and honest about exact matches. Running one is trivial;
   none is required.
8. **No commit phase for meetings.** The acceptor completes the task and
   holds the slot when it sends `meeting/accept`; the proposer confirms with
   a `completed` status update. If the proposer canceled or expired the task
   meanwhile, the acceptor learns it only from that update, and concurrent
   negotiations can double-book a slot (offers are not held). Whether
   accepting a meeting needs a per-meeting human confirmation is also
   unspecified. A hold-then-confirm step is future work.
9. **No forward secrecy.** Envelopes are encrypted to a static recipient key
   (§6.4). Conversation-scoped keys from the handshake are future work.
10. **Channel state for strangers.** A receiver advances `seq` state for any
    validly signed envelope before deciding whether to admit the sender. A
    stranger cannot spoof another sender, so the cost is memory per stranger
    ID, to be bounded.
11. **Extending the meeting verbs.** Validation is strict (§7.2); whether
    extensions use a version field or an A2A extension URI is undecided.

---

## 12. Scope & phases

**v0.1 (this document, rev 3):** identity, cards, discovery (hint-server
topics, mailbox probe, invite, optional directories), contact request/grant,
envelope, Nostr primary, human-channel bootstrap, A2A meeting negotiation.

**v0.2:** reference library (TypeScript) and `rdv` CLI, test vectors, interop
tests, A2A dinner negotiation over a real relay.

**v0.3:** MCP server exposing the tool API (§13); dogfood on a live agent
fleet — including discovery, probe and invite tools.

**v0.4:** fallback transports (ntfy/MQTT message transport), direct-channel
negotiation, directory service + suggestions, rotation doc, revoke semantics.

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
| `rdv_discover` | locate a peer from a contact point (hints → probe) |
| `rdv_invite` | send a premade invite when no agent is found |
| `rdv_suggestions` | list suggestion hits; flip the two opt-in switches |
| `rdv_request_contact` | send a contact request (via hint or human channel) |
| `rdv_pending_requests` | list inbound contact requests (for consent UX) |
| `rdv_grant` / `rdv_revoke` | approve/reject/revoke contacts with tier+scope; a grant needs the human's own approval (§5.5) |
| `rdv_send` | send an envelope (task, message, proposal) |
| `rdv_inbox` | read events after a cursor (an event log; nothing is acknowledged to the peer) |
| `rdv_negotiate` | A2A task exchange lifecycle |

`rdv_grant` MUST NOT succeed on the model's say-so (§5.5), and peer text in
any result is returned marked as untrusted (§5.6). One server runs per home
state directory.

A separate, optional **directory service** ships alongside for anyone who
wants to run one (§4.5); it is not part of the required install.

---

## 14. Appendix

**Why hint servers first?** They are silent, machine-only, and instant: no
email leaves a mailbox, no human is interrupted, and nothing lands in an
inbox. Work is gated on the contact point the requester already holds, which
is the same trust object as the rest of the protocol. Email is what people
check; hint topics are what agents check. Until an inline protocol element is
commonplace, the follow-up probe and invite cover the rest of the world.

**Why Nostr?** Key-first identity is identical to the agent-ID model; relays
are dumb pipes by design; hundreds of free public relays exist; new event
kinds are a supported extension point; no account system required.

**Why not blockchain?** A chain adds consensus, latency, cost, and a
public-by-default ledger to a problem that needs pairwise secure messaging.
Identity needs keys, not blocks; consent needs signatures, not a chain;
discovery needs topics and hints, not a ledger. The one blockchain-flavored
idea that survives — a tamper-evident consent audit log — is served by signed
append-only documents, no consensus required.

**Why not only email?** Email is the universal fallback but is slow,
metadata-leaky, and awkward for agents; Nostr gives low-latency relayed
delivery with the same trust model. The card lists both; the network heals
across them.

**Why aren't directories a registry?** A registry is an authority you must
join. Directories are shards you may query: invented by anyone, stored
blinded, swappable at will, skippable entirely. Discovery works with zero
directories in existence.

**Why does discovery not need consent?** Finding is not contacting. A probe
or topic query is answered per policy — often with silence — and no agent
messages another without a signed grant. Consent governs communication, not
lookups.

**Naming.** "Rendezvous" is a working title. The protocol's substance is
vendor-neutral and unowned.
