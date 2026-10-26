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
  encryption (ephemeral key `epk`, HKDF, AES-GCM) is now described. A peer
  that forks or rolls back its chain is refused until the receiving human
  re-syncs it. Amended: channel state is kept only for admitted senders, so
  fresh keys cannot fill a receiver's memory (was §11.10). Amended: the
  envelope plaintext is capped at 32 KiB, and receivers drop a bigger one
  before decrypting it.
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
  too. Amended: an agent's addresses change after setup; a changed card is
  re-signed with a later `created`, a requester keeps only an agent's newest
  card, and a public-pointer card is a replaceable event, so a removed address
  stops finding the agent (§4.3, §4.4, §6.2).
- **Consent, §5:** the grant carries the grantor's card (§5.3); who may answer
  a request; document IDs are UUIDs; grant direction and `max_frequency`
  format; scope defaults. New §5.5 (consent stays with the human) and §5.6
  (peer text is untrusted data). Amended: the reverse grant (§5.3, a grant
  with `grant_ref`) tells a contact what its peer's owner allows it, so the
  grantor side can propose meetings too (§7.4). A confirm phrase approves
  only the tier and scope shown with it, and is stored hashed (§5.5).
- **A2A, §7:** which A2A objects are sent, the meeting verbs, task states,
  slots, deduplication by `messageId`, cancellation, resend bounds, and
  persisting state before send. Amended: agreement is an accept → confirm
  handshake (`meeting/confirm`) with tentative, exclusive holds, and each
  human confirms the specific meeting (§5.5, §7.3; was §11.8). Amended: new
  verbs are A2A extensions, advertised on the card; a receiver answers what
  it does not support instead of dropping it, and ignores `metadata`
  (§4.3, §7.5; was §11.11).
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
- `capabilities` lists `rdv/v1`, `a2a/0.3`, then the extension URIs the
  agent supports: lifecycle extensions (`…/ext/meetings/v1`,
  `…/ext/tasks/v1`), profile extensions (`…/ext/files/v1`,
  `…/ext/groups/v1`) and capability URIs (`…/ext/request/v1`, …).
  Advertising a capability says the software can do it; whether a given peer
  *may* invoke it is the grant (§5.3). A requester SHOULD NOT send a task
  whose capability the executor's card does not list (§7.5, §7.6). At most
  32 URIs, each at most 200 characters; a receiver rejects a card over these
  limits. (**Spec change**, issue #22.)
- **Changing a card.** An agent may list several addresses, and its owner
  may add or remove them at any time. Each change re-signs the card with a
  `created` later than the previous card's (`v` is the schema version and
  stays `1`). Of several valid cards with the same `id`, a requester uses
  only the one with the latest `created`; an address counts as claimed only
  if that card lists it. An address the owner keeps off the card ("private")
  opens no topic and finds nothing. Removing an address cannot recall the
  copies of the old card that peers or relays already hold; see §4.4 for the
  public pointer.
- **Refreshing capabilities** (**spec change**, issue #43). When an agent
  starts on software that supports capabilities its card does not list, it
  re-signs the card with them, by the same rules (a later `created`, at
  least a second past the previous card and the current time; same key,
  hints and addresses), and republishes it on each public address topic as
  the replaceable event. It does so only when the card lacks one of them,
  so restarting on the same software changes nothing. A capability the card
  lists and the software no longer supports may stay listed; a task for it
  is answered as unsupported (§7.5). Contacts get the new card as below.
- **Sending a changed card to contacts** (**spec change**, issue #45). A
  contact holds the card it got in the handshake (the request or the grant),
  so after a change it would still send to the old relays and see the old
  capabilities. Whenever an agent re-signs its card, it sends the new card
  to each current contact over the pairwise channel (§6.4), once per card:

  ```json
  {"type": "rdv/card-update", "card": { …the new signed card… }}
  ```

  The envelope authenticates the sender and the card is signed by its own
  key, so the payload carries no signature of its own. The sender publishes
  the envelope on its relays from before and after the change as well as on
  the contact's relays, so a contact still on the old set gets it. The
  receiver accepts it only from a current contact, and only when the card
  verifies, its `id` is the envelope's `from`, its `created` is later than
  the card it holds and at most 10 minutes ahead of its clock, its canonical
  JSON is at most 16 KiB, and it lists 1 to 16 `nostr` relays (`wss://`
  URLs; a `ws://` relay only if the held card listed it, or in a test or
  dev setup). It then replaces the card it holds and nothing else:
  tier, scopes, grants, the local label and the expiry stay as the humans
  set them, so no human approval is needed, and a newly listed capability
  is usable only as far as the grant allows (§5.3). From then on the
  receiver sends to the new card's relays. The same card again is ignored;
  an older one, or one that fails these checks, is dropped and the human
  told. A receiver rate-limits updates per contact (20 an hour in the
  reference implementation). An agent that has not sent a contact its
  current card (the contact predates card updates, or the send failed)
  sends it at its next start. A contact that is offline past the relays'
  retention, or runs software without card updates, keeps the old card.

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
     off; `policy.public` gate. The pointer is replaceable (§6.2): after a
     change the agent publishes its new card on each listed address's topic
     and on the topic of each address it removed, so the newest card
     supersedes the old one there and a lookup for a removed address finds a
     card that no longer claims it (§4.3).
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
    "max_frequency": "20/day",
    "invoke": {
      "https://rendezvous.nesher.co/ext/meetings/v1": {},
      "https://rendezvous.nesher.co/ext/meeting-cancel/v1": {}
    }
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
- **Reverse grant.** When an owner grants an existing contact rights towards
  it (§5.5), typically the requester granting the grantor back, its agent
  sends the peer a reverse grant: the same `rdv/contact-grant` document with
  `grant_ref` instead of `request_ref`. `grant_ref` is the `id` of the grant
  that founded the contact, which both sides keep. A grant with both fields,
  or neither, is invalid, so the two kinds can never be confused:

  ```json
  { "v": 1, "type": "rdv/contact-grant", "id": "<uuid>",
    "from": "rdv1:<requester key>", "to": "rdv1:<grantor key>",
    "grant_ref": "<id of the grant that founded the contact>",
    "card": "<sender's card>", "tier": "friend",
    "scope": { "may_initiate": true, "may_propose_meetings": true, "max_frequency": "100/day" },
    "expires": null, "ts": "…", "sig": "…" }
  ```

  The receiver applies it exactly like any received grant: it sets only what
  the receiver may do towards the sender, never the sender's rights over the
  receiver. It MUST be accepted only from a current contact whose founding
  grant is `grant_ref`, addressed to the receiver, verified like a grant
  (signature, card, tier, timestamps), not expired, with a `ts` newer than
  the grant it replaces (and not far ahead of the receiver's clock;
  reference: 5 minutes) and an unseen `id`. Anything else is dropped without
  changing state. Its `expires` may shorten the contact, never extend it. A
  receiver MAY rate-limit them per contact (reference: 10 an hour).
  Revocation (§5.4) removes whatever a reverse grant set. Only the owner's
  own grant triggers one; an agent never sends one on its own.
- **`max_frequency`** is `"<n>/<minute|hour|day>"`; exceeding it revokes the
  grant (§10).
- **`scope.invoke`** is an object whose keys are capability URIs the grantee
  may invoke on the grantor, each mapping to its limits:

  ```json
  "scope": {
    "may_initiate": true,
    "max_frequency": "100/day",
    "invoke": {
      "https://rendezvous.nesher.co/ext/meetings/v1": {},
      "https://rendezvous.nesher.co/ext/meeting-cancel/v1": {},
      "https://rendezvous.nesher.co/ext/review/v1": { "max_frequency": "5/day", "max_open": 2 }
    },
    "may_propose_meetings": true,
    "may_access_calendar": "free_busy"
  }
  ```

  - **Deny by default.** A task whose capability is not a key of `invoke` is
    refused with a `rejected` status and creates no state. There is no
    wildcard: each capability is a separate human decision.
  - **Shape.** Keys are `https` URIs of at most 200 characters, at most 32 of
    them; each value is an object. A grant whose `invoke` is not of this
    shape is invalid (§5.3 rules above). Limit fields a receiver does not
    know are ignored.
  - **Limits.** `max_frequency` per capability (same format as above) and
    `max_open` (tasks not yet terminal, a positive integer; default 4).
    Going over a capability's limit rejects that task only (`rejected`,
    reason `rate`), creates no state, and is counted for the human. It does
    not revoke the grant.
  - **Gross abuse revokes.** The grant is revoked (§10, with a `rdv/revoke`
    and the human told) only when the peer (a) goes over the grant-wide
    `max_frequency`, as today; or (b) has more tasks rejected for one
    capability's limit in that capability's window than three times the
    limit itself (more than 15 rejected on a `5/day` capability), or more
    than 50 tasks rejected for any per-capability limit in 24 hours.
    Rejections for a closed gate, a human's "no" or an unsupported capability
    never count towards (b).
  - **Counting** (**spec change**, issue #28). A receiver counts per contact
    and per capability, and only for a current contact whose grant allows
    the capability: a task from anyone else is refused before any counter
    changes. A task counts towards its capability's `max_frequency` once it
    is admitted, after every other check (capability supported, input
    valid, room for the peer); the window slides, so a task admitted at *t*
    stops counting at *t* plus the window. A refusal for `max_open` or
    `max_frequency` is a per-capability rejection, and the peer is told
    (`rejected`, reason `rate`). It counts towards (b) twice: for its
    capability, within that capability's `max_frequency` window (a
    capability with only `max_open` has no such window and counts towards
    the 24-hour figure alone), and for all capabilities, within a sliding
    24 hours. Refusals for the per-peer task bound (§7.4), invalid input or
    a capability the grant does not allow never count either. A
    `"0/<unit>"` capability refuses every task, and for (b) its limit is
    read as 1. The counters are kept with the contact book, so they survive
    a restart, are saved before the `rdv/revoke` leaves, and go with the
    contact (revoked, blocked); a new grant from the owner starts them
    afresh. A receiver whose own clock is unreadable refuses the task and
    counts nothing; a stored time that is unreadable or ahead of the clock
    counts as now, for one window. The human is told of a revoke under (b)
    apart from one under (a).
  - **Senders check first.** A requester SHOULD NOT send a task the peer's
    grant would refuse: it counts its own open tasks per capability and
    the `task/request`s it sent in the window of the peer's `max_frequency`,
    and holds the task instead of sending it.
  - **Free messages** (`rdv_send` notes, any payload that is not a task) need
    only `may_initiate`, as today.
  - **Meetings.** `may_propose_meetings: true` is read as `invoke` holding the
    meetings and meeting-cancel URIs. A grant that has `invoke` MUST also
    write `may_propose_meetings`, consistent with it, until the field is
    retired; a receiver that finds the two inconsistent applies the narrower
    (no meetings). `may_access_calendar` is unchanged.
  - **Direction** is unchanged: a received grant sets what we may invoke on
    the peer; the reverse grant is how our owner's grant reaches it.
  - **Migration.** `invoke` is a backward-compatible addition, since `scope`
    is an open object: an older peer stores it, ignores it, and still reads
    `may_propose_meetings`. A receiver reads `invoke` first and falls back to
    the boolean when it is absent; stored grants are read through the same
    rule and need no rewriting. `may_propose_meetings` is retired in v0.5.
- Scope defaults for meetings are in §7.4. Default scopes put nothing in
  `invoke` except the meeting URIs where they already allow meetings: no
  capability is ever granted by default.

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
  phrase approves the request on the terms shown with it (tier and scope),
  and nothing else: the host MUST refuse it for any other tier or scope the
  model asks for (another list of capabilities in `scope.invoke` included),
  and show the human a new phrase for those terms instead.
  A host SHOULD store only a salted, slow hash of the phrase, so that it
  cannot be read back from disk. The reference implementation accepts a
  phrase only for tiers less close than `family` (`friend` and below);
- the owner's own command in a terminal;
- a standing pre-approval the owner set as policy (`allow`, §5.4).

The same holds on the requester's side. A grant the agent *receives* is the
peer's decision, not its owner's: it sets only what the agent may do towards
the peer (§5.3), and choosing which answer to a topic probe is the real peer
needs one of the approvals above. Widening what a peer may do towards the
agent (meetings, calendar, a higher rate) is always the agent's own owner's
grant. That grant, approved the same way, is what the agent then sends the
peer as a reverse grant (§5.3); receiving one widens only what the agent may
do towards the peer, and needs no approval of its own.

A grant that allows meetings lets the agents negotiate, not book. Before an
agent accepts a specific meeting, or confirms a peer's accept, the host
SHOULD get its human's confirmation of that meeting through one of the same
approvals (a standing `auto-confirm` policy the owner set counts; the
reference CLI calls it `--auto-confirm`). The slot is held tentatively while
the human decides (§7.3).

That confirmation is for the meeting the human was shown, not for a task ID:
task IDs are chosen by the peer, and the task behind one can change while the
human decides (a cancel and a new proposal under the same ID, another slot).
The host MUST bind the approval to what it showed (at least the peer,
`contextId`, task ID, the held slot's start and end, and which step is being
confirmed) and MUST NOT act on it if the held meeting differs when it acts;
it asks again instead. A confirm phrase for a meeting is bound the same way
and stops working once the hold changes or the task ends.

**Start and release gates** (**spec change**, issue #24). A grant that
allows a capability lets the agents exchange that kind of task; it does not
let the executor act on every task. Two gates apply, by the capability's
class (§7.6.3):

- **Start gate** (`confirm`, `free-form`): before the executor acts on a
  task (fetches its files, runs a model on it, touches owner data or the
  outside world) its human approves that task.
- **Release gate** (`confirm`, `free-form`, and any artifact that carries
  owner data or a model's output): before an artifact, a file, or a status
  message with free text leaves the agent, its human approves it. The same
  holds on the requester side for files it attaches: a file from the
  owner's storage leaves only with the owner's approval.

`notify` tasks are only shown to the human; `auto` tasks start on the grant
alone. A host SHOULD record each gate it passes without asking (an audit
log the owner can read).

Approvals are those listed above (a host's own UI, a confirm phrase, the
owner's command, a standing policy). A standing policy (`auto-start`,
`auto-release`) is set by the owner per contact and per capability, never
implied by a grant and never set by a model; for `free-form` it may cover
release, never start. The one policy that covers everything a contact
asks, `auto_approve: all`, is §5.5.1.

Each approval is bound to a digest of what the human was shown, and the
host MUST NOT act on it if that has changed; it asks again. For a start
gate the digest covers the peer, `contextId`, `taskId`, the capability,
the task's `created`, `canon(input)`, the SHA-256 of each text part and
each file's `sha256` (§7.7), and the step. For a release gate it covers
the peer, the task, and `canon(artifact)`. A confirm phrase is bound to
that digest and stops working when the task changes or ends. A peer can
cancel and re-request under the same `taskId`, or send `task/input` while
the human reads; the approval must not land on the new content.

The reference implementation treats everything its host sends for a peer's
task as owner data or a model's output (the model, or the human at a
terminal, wrote it), so every artifact and every status message with text
passes the release gate, whatever the class. Its CLI gates are `rdv task
approve <task-id> --code <code>` and `rdv task release <task-id> --code
<code>`, where the code is the first 12 hex digits of the digest shown by
`rdv task list`; its MCP server asks through elicitation or a confirm phrase
(`rdv_task` "approve-start", "approve-release"). A file of the owner's
reaches a peer through the same release gate (`rdv task submit --file`,
`rdv_task` "submit" with `files`), or in a request the owner sends from their
own terminal (`rdv task request --file`), which is held for the same release
gate before it leaves; the MCP server attaches none to a request (§7.7,
NOTES 77).

### 5.5.1 Auto-approve-all per contact

(**spec change**, issue #25.) Approving every task by hand is safe and
tiring. For a contact the owner trusts as much as their own agent, the owner
MAY set `auto_approve: "all"` on that contact, optionally with an expiry
(`auto_approve_until`). Its effect, limits and risks:

- **What it approves.** For tasks *from that contact*, under capabilities
  that contact's grant already allows (`scope.invoke`), the start gate and
  the release gate pass without asking, for every approval class,
  `free-form` included; so does the release of results back to that
  contact. A host MAY also let it cover the meeting confirm of a
  negotiation that contact started (the reference does not). It widens
  nothing else: the grant, `invoke`, per-capability limits, bounds (§7.4),
  sizes, the untrusted-content rules (§5.6) and the file-fetch rules
  (§7.7) all still apply, and gross abuse still revokes (§5.3).
- **What it never covers.** Creating a contact (approving a request or a
  discovery candidate); joining a group, or approving a group newcomer;
  granting anyone, or widening any grant, this contact's included;
  attaching the owner's files to a task *we* send; cancelling an agreed
  meeting; and setting, extending or changing auto-approve itself. Each of
  these still needs the human every time.
- **Only the human sets it.** It is set in the owner's own terminal or
  through a consent form the host shows the owner, never by a model, a
  tool call, a confirm phrase relayed by a model, or a peer: it is local
  state that never goes on the wire, so a peer cannot see, request or set
  it. A host MUST NOT offer a model any tool that sets or extends it; a
  tool MAY show it. Hosts list the setting command as human-only wherever
  they list the contact grant command.
- **Warning at set time.** Before it is set the owner is shown, in plain
  words: that the contact's agent can now make this agent act and answer
  without asking; which capabilities that covers today; that text and
  files from that contact reach this agent's model with its tools, so
  prompt injection from that contact gets the power of those tools; the
  expiry; and how to turn it off.
- **Bound to the grant.** The setting is bound to the grant it was set
  on. It is off at once when the owner turns it off (narrowing needs no
  confirmation), when it expires, and when the contact is revoked or
  blocked, its grant is revoked for abuse, changed or widened, or its
  channel shows a fork or rollback (§6.4). Re-enabling is a new human
  decision. A setting whose times cannot be read, that was set in the
  future, or whose integrity cannot be checked approves nothing.
- **Audit log.** Every action approved this way appends one line to an
  audit log the owner can read: time, contact, capability, `taskId`,
  which gate, the approval digest, and what left (hashes and sizes).
  Setting, extending, expiring and turning off are logged too. Peer text
  is not stored. The log is bounded.

**Risk.** Auto-approve-all trusts the contact's *agent*, not only its
human. Anything that can write into that agent's messages (its own model
following an injected document, a compromised device, a stolen seed) can
then make this agent run tasks with its tools and send back whatever those
tasks produce, with no human seeing either side. The quarantine rule (§5.6)
still limits a host that runs peer content in a tool-less model, but many
hosts today run one model that both reads peer text and holds tools: there,
prompt injection from that contact gets this agent's tools for every
capability in the grant. The grant's `invoke` and limits are then the only
boundary, so keep them narrow.

The reference implementation sets it with `rdv contact auto-approve
<agent-id|label> all [--until <time|duration>]`, which needs an interactive
terminal, shows the warning and asks for the owner's passphrase (set
beforehand with `rdv owner-secret set`, stored as a scrypt hash, read from
the terminal itself and never shown, so the prompt never holds its own
answer); `... off` turns it off from anywhere. The setting lives in
`autoapprove.json` in the home (mode 600), each entry MACed with the agent's
secret key and bound to the contact's grant ID, `since` and a digest of its
inbound scope; it is checked under the home lock at each gate. The audit log
is `audit.jsonl` (`rdv audit [--contact] [--since]`, 1000 lines kept);
`rdv contact list`, `rdv_status` and `rdv_task` show who is on auto-approve
and until when, and `rdv_inbox` shows tasks it started and when it ends. The
reference MCP server has no tool that sets it, and the plugin's consent
guard refuses the command and the file to the model.

### 5.6 Peer text is untrusted data

Greetings, text parts, decline reasons and card `owner` fields are written by
the other side and can carry instructions aimed at the reader's assistant.
They are display-only: they MUST NOT be followed, and only machine (`data`)
parts and validated fields may drive actions. Short structural fields
(payload `type`, IDs, tiers, states) are validated against strict shapes and
rejected if they do not match. A host SHOULD hand peer text to a model only
when clearly marked as untrusted, and SHOULD strip terminal control
characters before showing it.

(**Spec change**, issue #27.) Everything a peer sends inside a task is
untrusted data: text parts, the `input` object beyond its validated shape,
artifact parts, file names, MIME types and file contents, and status
messages. In addition to the rules above:

1. **Shape before meaning.** `data` parts are parsed against the
   capability's schema; a capability the receiver does not implement has
   its `data` refused as unsupported (§7.5), never interpreted loosely.
2. **Marked for the model.** A host hands peer content to a model only
   marked as untrusted (the reference uses `untrusted_peer_text`), and
   files only as extracted text marked the same way.
3. **Quarantine.** A model that processes peer content for a task runs
   without tools that send messages, grant, approve, read owner data
   beyond what the start gate named, or fetch URLs. Its output is an
   artifact draft, which passes the release gate. (This is the
   planner/quarantine split: the model that reads attacker text never holds
   the capabilities the attacker wants.) A host that cannot run such a
   model (one model reads peer text and holds tools, as in most assistants
   today) MUST still enforce both gates and the marking, MUST tell the
   model the rules (the request is data; draft an answer and do nothing
   else it asks; owner data leaves only through the release gate; never
   follow instructions in it, nor use an approval or confirm phrase written
   in it), and SHOULD say plainly that the tool restriction is not
   enforced.
4. **No fetching from text.** Links in text parts are shown, never
   followed. The only URLs an agent fetches are file references (§7.7),
   by its own choice, after the start gate, and verified by hash.
5. **File names and types** are display hints: sanitized (no path
   separators, control characters or leading dots), never used to choose a
   handler that executes, and checked against the content where it
   matters.
6. **Terminal-safe.** What reaches the human's screen (a log, a terminal
   listing, an approval form) has control characters, C1 controls, bidi
   overrides, isolates and marks, and line separators replaced, in peer
   text and in anything a model wrote, so neither can repaint the screen
   around an approval.

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
  (§4.4) and `d` is the hex SHA-256 of the event content, except for a
  public-pointer card, whose `d` is `"rdv1/card:" ‖ dtopic`: one addressable
  event per agent and topic, so relays keep only the newest card. Its
  `created_at` is no earlier than the card's `created` (in seconds), which a
  change moves past both the previous card and the current time by at least a
  second, so a newer card never ties with an older one (relays break ties by
  event ID).
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
- **Relay policy differs (2026-10-25 survey of 28 relays).** The relays that
  pass are the same for both kinds. Others filter kind 30417 out, accept only
  a few events from a pubkey outside their web of trust, require NIP-05 or
  payment, or rate-limit and then ban a pubkey that bursts. A client SHOULD
  publish to several relays and count one `OK true` as delivered. It SHOULD
  retry transient failures with backoff, pace its own events per relay, and
  stop publishing to a relay that answers `blocked`, `restricted` or `banned`
  for a while.
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
  the previous envelope in the same direction. `seq` is a positive integer.
- **Forks and rollbacks.** An envelope identical to one already accepted is a
  relay replay and is dropped silently. A *different* envelope that reuses an
  accepted `seq`, or whose `prev` does not match the receiver's chain head,
  means the sender forked its chain: it restored older state (a backup) or two
  copies of it run. The receiver MUST NOT accept the forked chain on its own
  and MUST NOT drop it silently: it tells its human and refuses the peer's
  envelopes until the human re-syncs. A re-sync adopts the next envelope that
  is newer (`created`) than every envelope accepted from that peer; relay
  replays of the old chain are never newer, so they cannot become the head.
  After a re-sync the receiver treats any envelope from that peer that is not
  newer than the old chain's newest as a duplicate, whatever its `seq` or
  `prev`, so replays cannot reopen a gap or refuse the peer again.
  Detection keeps bounded state: the hashes of the last few accepted envelopes
  (8 in the reference implementation) plus the newest accepted `created`. A
  reused `seq` below that window is detected by its `created` being newer than
  everything accepted; one that is also older is indistinguishable from a
  replay and is dropped as one.
- **Channel state is kept only for admitted senders.** A receiver keeps
  `seq`/`prev` state for contacts, pending requesters it keeps, agents it
  asked for contact, and peers it has written to. For any other sender it
  keeps none: such a sender's chain starts at the first envelope the
  receiver sees from it, whatever its `seq`, because it may have written
  before and been refused. Minting keys is free, so state per unknown sender
  would let anyone fill the receiver's memory (was §11.10).
- `ttl` is `<n><s|m|h|d>` (default `48h`); an envelope is expired when
  `created + ttl` has passed. It lets relays garbage-collect and bounds replay
  windows, so receivers MUST reject a `ttl` over 7 days and a `created` more
  than 5 minutes ahead of their clock; otherwise a sender could make an
  envelope replayable for years.
- **Size.** The plaintext (the payload's canonical JSON, UTF-8) MUST NOT
  exceed 32 KiB (32,768 bytes). A sender refuses a bigger payload. A receiver
  MUST drop an envelope whose ciphertext is longer than the plaintext limit
  plus the 16-byte GCM tag, and SHOULD check that from the base64 length,
  before it verifies the signature or decrypts. Sealed, the largest envelope
  is about 45 KB as a Nostr event, under the 128 KB message limit of the
  smallest relay surveyed (§6.2). Bulk data (files, attachments) belongs out
  of band.
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
  (the same bytes; a different envelope at that `seq` is a fork, §6.4), and drops a re-sent A2A message (same `messageId`, new
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
(an acknowledgement or end state). General tasks (§7.6) add a third,
`a2a/artifact-update`, holding a `TaskArtifactUpdateEvent` (a result). A whole `Task` object is never sent; each
side keeps its own copy. A2A assumes a client and a server agent, but both
peers here are agents, so `role` is always `"agent"`. `messageId`, `taskId`
and `contextId` are UUIDs; one `contextId` covers one negotiation.

A message has human parts (`text`) and one machine part (`data`) whose
`data.rdv` names the verb (§7.2). Text parts are for humans and never drive
anything (§5.6). Receivers validate strictly and reject unknown keys, unknown
verbs and non-UUID IDs; §7.5 says which unknowns are answered as unsupported
and which are ignored. Each message lists the extension URI of its verb in
`extensions` (§7.5).

### 7.2 Meeting verbs

| `data.rdv` | Fields | Meaning |
|---|---|---|
| `meeting/propose` | 1-3 `slots`, optional `place`, `expires` | open a negotiation |
| `meeting/counter` | 1-3 `slots`, optional `place`, `expires` | offer different slots |
| `meeting/accept` | one `slot` | accept a slot from the latest offer |
| `meeting/confirm` | one `slot` | the offerer makes an accepted slot final |
| `meeting/decline` | `reason` | refuse; nothing fits |
| `meeting/cancel` | one `slot`, optional `reason` | call off an agreed (`completed`) meeting |
| `rdv/cancel` | optional `reason` | withdraw a pending task, by the message's `taskId` |

A slot is `{"start", "end"}`, RFC 3339 date-times with an explicit offset
(`Z` or `±HH:MM`), compared as instants, so an accept may write the slot in
another offset; at most 12 hours long. `expires` defaults to 48 hours and a
receiver clamps it to 7 days. New verbs are added as A2A extensions (§7.5);
`meeting/cancel` is the first.

### 7.3 Task states

`submitted` (proposal sent) → `input-required` (the responder countered) or
`working` (the proposer countered back) → `completed` | `rejected` |
`canceled`. A round is one offer; the receiver of the third offer declines if
nothing fits, which ends the task `rejected`. An accept MUST pick a slot from
the latest offer it answers. The reference policy is: offer up to 3 free
slots, accept the first slot that is free, otherwise counter with 3 of your
own; implementations MAY choose a different policy within these rules.

Agreement takes two messages. The accepter holds the slot tentatively and
sends `meeting/accept`; the task stays pending. The offerer checks the slot
is still free (offers are not held) and that the task has not expired, then
sends `meeting/confirm` with the same slot and completes; otherwise it
declines. The accepter completes on the confirm and acknowledges with a
`completed` status update. A tentative hold MUST be released when the task
is canceled, declined or expires, or when the peer reports it `canceled` or
`rejected`, and a slot held for one task (tentatively or agreed) is busy for
every other task. An accepter waiting for the confirm SHOULD keep its hold
for a grace period past `expires` (reference: 24 hours), since the offerer
may have confirmed in time. Either side MAY wait for its human before its
step (§5.5).

A `rdv/cancel` is honored while the task is not terminal. A cancel that
arrives before its proposal leaves a tombstone so the proposal is refused
when it lands. A cancel, or any verb, for a finished task is answered with a
status update giving its real end state.

An agreed meeting is called off with `meeting/cancel`, which names the agreed
slot. Only a human may send it (§5.5), and the host binds that approval to
the agreement it showed (peer, `contextId`, task ID, slot). The sender
releases its hold and ends the task `canceled`, keeping the agreed slot as a
record. The receiver honors it only for a `completed` task with that sender,
`contextId` and slot (compared as instants) and drops anything else; it
releases its hold, ends `canceled`, acknowledges with a `canceled` status
update and tells its human. It needs no approval from the receiving human: a
peer can only free time this way, never commit it. A `meeting/cancel` for a
task that already ended is answered with its status and changes nothing, and
a later negotiation of the same slot is a new task that it never touches.
Likewise, a peer reporting `canceled` or `rejected` for a task the receiver
completed releases it (the confirm crossed a cancel or arrived too late).
`meeting/cancel` is an extension (§7.5): an agent that does not support it
answers it as unsupported and keeps the meeting, and an agent that predates
§7.5 drops it silently, so before sending it the sender checks the peer's
card and, when the card does not advertise it, tells its human to let the
other person know directly.

### 7.4 Scope and defaults

Meeting verbs require the meetings capability in the grant that covers the
direction (§5.3): `scope.invoke` holding
`https://rendezvous.nesher.co/ext/meetings/v1`, or, in a grant without
`invoke`, `may_propose_meetings: true`; when both are present and disagree,
there are no meetings. Proposing to a peer, and answering on a negotiation we
proposed, need the peer's grant to us; a peer proposing to us needs the grant
our owner gave the peer. For the agent that granted the contact, "the peer's
grant to us" is the peer's reverse grant (§5.3): until the requester's owner
grants back, the grantor cannot propose. If `may_access_calendar` is absent it
counts as `free_busy`, because proposing a slot is a free/busy disclosure;
`none` blocks negotiation. At every level, including `full`, meeting messages
carry slots only, never event titles.

Peer state is bounded: only a grant whose `invoke` covers the capability
(for meetings, the rule above) may create a task or a tombstone; anything else
is refused before state is kept; a receiver SHOULD cap tasks per peer (reference: 32, evicting
finished ones and tombstones first and refusing when all are pending) and
prune finished tasks (reference: after 30 days).

**General tasks** (**spec change**, issue #22). Every task a peer can create
under §7.6 costs the receiver memory and its human attention, and keys are
free. A receiver bounds both (reference values in brackets):

- Only a grant whose `invoke` covers the capability may create a task or a
  tombstone; anything else is refused before state is kept.
- Per peer: open tasks across all capabilities [32] and `max_open` per
  capability [4]; finished tasks and tombstones are evicted first, and a
  new task is refused when all are open.
- **Waiting for the human:** per peer [4], in all [64]. When full, the
  weakest waiting task is rejected with `rejected` (lowest tier first, then
  the oldest), the newcomer included, and the drop is counted for the
  human, as pending requests are.
- Per task: seen `messageId`s [64]; `task/input` [8]; status updates
  processed [64]; artifacts [8]; artifact chunks [64]; unsupported and
  finished replies [8 each].
- Sizes: an envelope's plaintext [32 KiB, §6.4]; a text part [16,000
  characters]; inline file bytes [16 KiB]; a referenced file [25 MiB,
  receiver policy], fetched only after the start gate; transfer negotiation
  messages [16 per transfer, 16 KiB of `data` each].
- Finished tasks are pruned [after 30 days]; a peer's `expires` defaults
  to 48 hours and is clamped to 7 days, as for meetings.

### 7.5 Extending the meeting verbs

**Spec change** (issue #4; resolves §11.11). The verb set grows:
`meeting/confirm` and `meeting/cancel` both came after the first draft, and
validation is strict (§7.1), so an agent rejects whatever it does not know.
Two ways to extend it were compared.

- **(a) A version field in our payload**, such as `data.v: 2` or a protocol
  version in `metadata`, with a version on the card (`rdv/v2`).
- **(b) A2A extension URIs.** A2A v0.3 names each extension by a URI
  (`AgentCard.capabilities.extensions`, entries `{uri, description,
  required, params}`), lists the URIs relevant to a message in
  `Message.extensions`, puts extension data in `metadata` keyed by the URI,
  and requires a new URI for a breaking change. Extensions may constrain
  `DataPart`s but may not add fields to A2A's own objects or new enum values
  such as task states. Rendezvous has no A2A agent card; its address card
  (§4.3) plays that role.

| | (a) version field | (b) extension URIs |
|---|---|---|
| Old peer receives it | A strict parser rejects the unknown `v` key, so *every* message of the new version fails, not only the new verb; in `metadata` the version is ignored and the old peer fails on the verb anyway | Only a message with the new verb fails; every other message is unchanged, and rev-3 parsers already accept `extensions` |
| `meeting/cancel` | Version 2 = rev 3 + cancel. A sender must downgrade each peer to version 1 to keep negotiating with it, which needs discovery anyway | Its own URI, `…/ext/meeting-cancel/v1`, independent of every other verb |
| Granularity | Linear: version 3 implies all of version 2, so a peer cannot support one later feature without the ones before it | Per feature; each URI is immutable |
| Discovery | One number on the card | The URIs on the card (`capabilities`) |
| A2A | Ours alone | Native: an A2A gateway maps the URIs to `AgentExtension` entries |
| Cost | One integer | About 50 bytes per message |

Neither option changes how an agent already deployed behaves: an agent from
before this section drops an unknown verb silently. What helps there is
knowing in advance, which is discovery. The two candidates are the card and
the grant scope. The scope is a permission one human gives one peer (§5.3);
putting what software can do next to what a person may do would put feature
upgrades under consent and need a new grant per contact for each one. The
card describes the agent, is signed, travels with every request and grant,
and already has `capabilities`. The limit is staleness: a contact holds the
card it received with the request or grant, and no message announces a newer
one (§4.3), so a peer that upgrades still looks old. That errs on the safe
side: we warn when we did not need to.

**Recommendation: (b), with the card as the discovery channel.** The rules:

1. **Extension URIs.** `https://rendezvous.nesher.co/ext/meetings/v1` covers
   `meeting/propose`, `meeting/counter`, `meeting/accept`, `meeting/confirm`,
   `meeting/decline`, `rdv/cancel` and the unsupported reply (rule 5).
   `https://rendezvous.nesher.co/ext/meeting-cancel/v1` covers
   `meeting/cancel`. A URI never changes meaning: a breaking change gets a
   new URI, and a new verb is a new extension.
2. **Advertising.** An agent lists the URIs it supports in its card's
   `capabilities`, after `rdv/v1` and `a2a/0.3`. A card that lists none
   predates this section: assume nothing optional about it.
3. **Sending.** Each message lists the URI of its verb in
   `message.extensions`. A sender SHOULD NOT send a verb whose extension the
   peer's card does not advertise. When a human's decision has to go out
   anyway (a `meeting/cancel`), the sender sends it and tells its human that
   the peer may not act on it, so the humans can settle it directly.
4. **Receiving.** Unknowns fall into three classes:
   - *Critical, answered as unsupported*: an unknown verb; a verb of an
     extension the receiver does not support; an unknown key anywhere
     inside `data` (slots and `place` included); an unknown part kind.
   - *Ignorable, accepted*: `metadata` on a message, a part or a status
     update, whatever it holds, and URIs in `message.extensions` that the
     receiver does not know. Whether a message is understood is decided by
     its `data`, never by that list.
   - *Malformed, dropped silently as before*: everything else, including
     unknown keys in A2A's own objects (A2A forbids extensions to add them)
     and unknown task states (nor new enum values).

   So an extension puts data a receiver may ignore in `metadata`, keyed by
   its URI, and anything that changes the meaning of a message in `data`,
   which only peers that advertise the extension receive.
5. **The unsupported reply.** A receiver that refuses a message as
   unsupported answers with a status update that carries its real state for
   the task (or `rejected` if it has none) and, under the key
   `<meetings URI>/unsupported`, the refused `messageId` and its verb:

   ```json
   { "type": "a2a/task-update", "update": {
       "kind": "status-update", "taskId": "<taskId>", "contextId": "<contextId>",
       "status": { "state": "completed", "timestamp": "…" }, "final": true,
       "metadata": { "https://rendezvous.nesher.co/ext/meetings/v1/unsupported":
         { "messageId": "<the refused messageId>", "verb": "meeting/cancel" } } } }
   ```

   It changes no state on either side beyond what the status already means
   (§7.3). It goes only to the peer the task belongs to, with the same
   `contextId`; for a task the receiver does not have, only within a
   meeting-capable grant; never in answer to a status update; and a receiver
   bounds it per task (reference: 8). The sender tells its human. The verb
   is echoed by the peer, so the sender names it only if it is a verb the
   sender knows. A rev-3 parser accepts this update, since `metadata` is
   free-form.

**`meeting/cancel` under each.** Under (a) it would have been version 2: a
rev-3 agent receiving any version-2 message rejects it, so the canceling
agent must remember which peers speak version 1 and talk version 1 to them,
and the cancel itself still fails there, silently. Under (b) it is
`…/ext/meeting-cancel/v1`: the canceling agent reads the peer's card, sends
the cancel, and, when the card does not list the URI, tells its human that
the other agent may keep the dinner. An agent that knows §7.5 but not this
extension answers unsupported, and the sender learns it in-band. Both close
the gap left open in §11.8 as far as a protocol can: the canceling side now
knows.

### 7.6 General tasks

**Spec change** (issue #22; design `docs/design/general-tasks-and-groups.md`
Part A). Meetings are one kind of task. Any other work between two agents
uses the **tasks extension**, `https://rendezvous.nesher.co/ext/tasks/v1`,
which defines a lifecycle and leaves the meaning of the work to a
**capability**: an extension URI that names what is asked for (for example
`…/ext/review/v1`) and defines its input, its results and its approval
class (§7.6.3). The *requester* sends the task; the *executor* does it.

#### 7.6.1 Payloads

- `a2a/message` (§7.1) carries the requester's turns. Its `data` part names
  one of three verbs:

  | `data.rdv` | Fields | Meaning |
  |---|---|---|
  | `task/request` | `capability` (URI), optional `input` (object), optional `expires` | open a task |
  | `task/input` | optional `input` | answer an `input-required` status |
  | `rdv/cancel` | optional `reason` | withdraw a task that is not terminal |

  `input` is validated against the capability's schema. Text parts are the
  human-readable request; file parts follow §7.7. A message carries at most
  one `data` part, 8 parts in all, and lists in `extensions` the tasks URI,
  the capability URI and, when it has file parts, the files URI.
- `a2a/task-update` (§7.1) carries the executor's state changes. Under this
  extension its `status` MAY carry an A2A `message` (text and data parts
  only): the question of an `input-required`, or the reason of a `rejected`
  or `failed`.
- `a2a/artifact-update` (new) carries an A2A `TaskArtifactUpdateEvent`:
  `{taskId, contextId, artifact: {artifactId, name?, description?, parts,
  extensions?, metadata?}, append?, lastChunk?}`. Parts are text, data
  (shaped by the capability) and files (§7.7). Only the executor sends it.

`taskId`, `contextId`, `messageId` and `artifactId` are UUIDs. The
requester chooses `taskId` and `contextId` (one `contextId` may span
related tasks; `referenceTaskIds` points at earlier ones, for instance a
task whose artifact is the input of this one).

#### 7.6.2 States

`submitted` (received; waiting for the executor's start gate, §5.5) →
`working` → `input-required` ⇄ `working` → `completed` | `failed` |
`rejected` | `canceled`. `rejected` means the executor (or its human)
refused before starting; `failed` means it started and could not finish.
These are A2A v0.3 states. A status update MAY say in `metadata`, under
`<tasks URI>/awaiting`, `"human"` while a gate is open; it is ignorable. A
requester sends `task/input` only while the task is `input-required`, and
at most 8 times per task. Expiry, deduplication by `messageId`, tombstones
for a cancel that overtakes its request, and the answer to a verb for a
finished task work as in §7.3. `rdv/cancel` belongs to both the meetings
and the tasks extension; the task's capability says which applies.

The executor's state is the task's state: the requester follows its status
updates forward only (nothing returns to `submitted`, nothing leaves a
terminal state) and ignores the rest. A status update that ends or refuses
a task MAY give a machine reason in `metadata` under `<tasks URI>/reason`:
`scope` (the grant does not allow the capability), `rate` (a per-peer or
per-capability limit), `input` (`input` does not match the capability's
schema), `busy` (too many tasks wait for the human, §7.4), `human` (the
executor's human said no), `expired`, `unsupported` or `error` (it started
and could not finish). It is ignorable and written by the peer: the
requester shows it and acts on nothing else.

A task refused before the executor keeps any state (scope, rate, input) is
answered with a `rejected` status and its reason. A task whose capability
the executor does not implement is answered as unsupported (§7.5 rule 5,
with the same `<meetings URI>/unsupported` key, whose value may also name
the `capability`), and only within a grant that allows some capability.
Neither creates state, and both are counted for the human.

#### 7.6.3 Capabilities

A capability is an extension URI whose definition states:

1. the JSON shape of `input` and of the `data` parts of its artifacts
   (`data.rdv` names the shape, e.g. `review/result`), validated strictly
   as in §7.5;
2. its **approval class**, one of:
   - `notify`: the executor only shows the task to its human; nothing is
     done or returned beyond a status.
   - `auto`: bounded, deterministic work that discloses nothing the grant
     does not already allow (a free/busy query, the meeting negotiation).
     The grant alone is the approval.
   - `confirm`: work that commits the human (books, pays, sends, signs) or
     discloses data beyond the grant. Each task needs its human's approval
     to start, and each artifact needs it to be released.
   - `free-form`: the task is defined by peer text and done by a model.
     It is gated like `confirm`: each task needs approval to start, and
     each artifact needs it to be released. No per-capability standing
     policy may waive the start gate; only the owner's `auto_approve: all`
     for that contact does (§5.5.1).
3. any extra rules (limits, how results are shaped).

An executor applies the stricter of the capability's class and its own
owner's policy; a peer can never lower it. `https://rendezvous.nesher.co/ext/request/v1`
is the general capability: a free-text request with optional structured
data, results in any part kind, class `free-form` (§7.6.4). It is how one
agent asks another for anything no specific capability covers.

**Why a capability URI inside one lifecycle, not one extension per task
type.** A full verb set per kind of task (how meetings were built) is right
for meetings, whose counters and holds are a real protocol, and wrong as
the general path: each kind would redo cancel, expiry, dedup, bounds and
approval. With one lifecycle a capability is a schema plus a class, and a
generic engine can gate, bound and show any task (answering an unknown
capability as unsupported, §7.5). Meetings are not remapped onto
`tasks/v1`: their verbs are deployed. They count as class `auto` for
negotiation and `confirm` for accept and confirm, which is §5.5 today.

**Compatibility.** A rev-3 peer that knows §7.5 but not this extension
answers a task as unsupported (an unknown verb); an older one drops it. A
requester that checks the card first (§4.3) sends neither of them a task.
`a2a/artifact-update` is an unknown payload type to both, and is never sent
to them. Core carries the new payloads unchanged inside the envelope, so
the wire format and test vectors do not change.

#### 7.6.4 The general capability (`request/v1`)

(**Spec change**, issue #27.) `https://rendezvous.nesher.co/ext/request/v1`
lets one agent ask another for anything, in words. Its definition:

- **Request.** The text parts of the `task/request` message are the
  request. `input` is optional; when present it is `{"data": {…}}`, a JSON
  object of structured data that goes with the text (a list of items, a
  form to fill). File parts follow §7.7.
- **Answer.** A `task/input` carries text parts and, optionally, the same
  `{"data": {…}}` input.
- **Results and questions.** Artifacts carry text parts, file parts and
  data parts of shape `request/data`:
  `{"rdv": "request/data", "data": {…}}`. An `input-required` status message
  may carry the same data part. Any other `data.rdv` is refused (§7.5).
- **Bounds.** Every `data` object is JSON with at most 4 levels of nesting,
  256 values in all, strings of at most 2,000 characters, keys of 1–64
  characters, finite numbers, and at most 8,192 characters as JSON. A
  request outside these bounds is refused before any state is kept.
- **Class `free-form`,** fixed: a host MUST NOT register `request/v1` under
  another class. Each task waits for its human's approval to start and
  each result, question or closing message for its release (§5.5). No
  per-capability policy waives the start gate; only the owner's
  `auto_approve: all` for that contact does (§5.5.1).
- **Meaning.** The data is free-form: it is checked for shape and size,
  never interpreted. Text, data and files are all untrusted peer content
  (§5.6): the executor's model treats them as a description of the work,
  drafts an answer, and does nothing else the request asks.
- **Never granted by default.** No default scope lists it in `invoke`
  (§5.3); each contact that may send requests is a separate human decision.

This replaces "no `input`" in design A.2: structured data beside the text
(a list to check, fields to fill) would otherwise have to be smuggled into
free text, where the executor's model reads it as prose.

---

### 7.7 Files

> **Spec change (v0.3, issue #26).** New section, from the approved design
> (`docs/design/general-tasks-and-groups.md` A.8). The reference implements
> the reference format, its encryption, the fetch rules and the
> `rdv/transfer` messages (`@rendezvous/core`, NOTES 72). **Spec change
> (issue #26, hosts):** file parts in tasks and artifacts, fetching only
> after a task's start gate, the release gate on outgoing files, the
> quarantine and the owner's direct-transfer setting ("In tasks" and "Direct
> transfer, the owner's setting" below; NOTES 77).

Files are A2A `FilePart`s. Up to 16 KiB a file MAY travel inline
(`file.bytes`, base64), inside the encrypted envelope. Anything larger is a
**file reference** under the **files extension**,
`https://rendezvous.nesher.co/ext/files/v1`, a profile extension in A2A's
sense: it adds required structure to `FilePart`.

```json
{ "kind": "file",
  "file": { "uri": "https://files.example.com/q4/3f9a…", "mimeType": "application/pdf", "name": "q4-plan.pdf" },
  "metadata": { "https://rendezvous.nesher.co/ext/files/v1": {
    "sha256": "<hex SHA-256 of the bytes the receiver fetches and verifies>",
    "size": 412817,
    "enc": { "alg": "aes256gcm", "key": "<base64, 32 bytes>", "nonce": "<base64, 12 bytes>",
             "plain_sha256": "<hex SHA-256 of the plaintext>" },
    "mirrors": ["https://mirror.example.org/3f9a…"],
    "p2p": ["webrtc-datachannel/1"],
    "expires": "2026-11-01T00:00:00Z" } } }
```

- **Where the bytes are is the sender's choice.** `uri` is any `https` URL
  where the file is stored: a web server, a cloud share link, an object
  store, a Blossom server (BUD-01, `GET /<sha256>`), or none at all when the
  file is offered only by direct transfer (`uri` omitted, `p2p` present).
  `mirrors` lists up to 8 other URLs for the same bytes. The protocol
  requires no store, and the project runs none.
- **Shape.** `sha256` and `plain_sha256` are 64 lowercase hex characters;
  `size` a non-negative integer; `enc.alg` is `aes256gcm` with a 32-byte key
  and a 12-byte nonce; `p2p` names are `<name>/<version>` (at most 8);
  `expires` is RFC 3339. A URL is at most 2,048 characters, `https`, with a
  host and no userinfo. `mimeType` is a bare `type/subtype`; `name` and
  `mimeType` are display hints, sanitized (§5.6). Unknown keys in this
  metadata, in `enc` or in `file` are refused.
- **Integrity whatever the transport.** `sha256` is the hash of exactly the
  bytes the receiver will get (the ciphertext when `enc` is present) and
  `size` their length. The receiver verifies `sha256` before using the
  bytes, from any URL, mirror or direct transfer; any mismatch fails the
  file. With `enc`, it then decrypts (AES-256-GCM, associated data
  `"rdv1/blob"`, so the ciphertext is the GCM output with its 16-byte tag
  appended) and checks `plain_sha256`.
- **Encryption.** A sender SHOULD encrypt any file it puts on a store it does
  not control, with a fresh random key and nonce per file, never reused. The
  key travels only inside the envelope, so the store sees ciphertext. A
  sender MAY send a plaintext reference (no `enc`), for instance to a file
  that is already public; `sha256` is still required.
- **A URL is untrusted peer data.** Fetching is the receiving agent's choice,
  never automatic: nothing is fetched because a file part arrived, only by an
  agent acting on a task that passed its start gate. Rules: only `https` (or
  a direct transfer); never to private, loopback, link-local or otherwise
  special-purpose addresses (IPv4-mapped, NAT64 and 6to4 forms included),
  checked after resolving and after each redirect, with the connection made
  to the address that was checked, so a DNS answer that changes between check
  and connect cannot move it; at most 3 redirects; at most `size` bytes and
  the receiver's own cap, enforced while reading; no content encodings.
  **Never with credentials:** no cookies, `Authorization` headers, client
  certificates, signed-in browser sessions or other ambient authority of the
  owner, so a peer cannot make the agent read something only the owner can
  open. The content is untrusted (§5.6), whatever its hash.
- **Direct transfer.** `p2p` lists transfer protocols the sender offers, in
  its order of preference. The receiver MAY ask for one instead of the URL
  with `rdv/transfer` messages over the pairwise channel (payloads of the
  envelope, §6.4):

  ```json
  { "type": "rdv/transfer", "file": "<sha256>", "task": "<taskId>",
    "transfer": "<uuid>", "step": "propose",
    "protocols": ["webrtc-datachannel/1"], "data": { }, "expires": "…" }
  ```

  `step` is `propose` (the receiver names the protocols it accepts, 1 to 8),
  `accept` (the sender picks one, `protocol`), `signal` (protocol-specific
  setup in `data`, for WebRTC the SDP offer, answer and ICE candidates),
  `done` or `abort` (optional `reason`, at most 200 characters, display
  only). `task` is present when the file belongs to a task. Each step allows
  only its own fields (`data` on propose, accept and signal, required on
  signal); anything else is refused. A propose with no protocol the other
  side supports, an accept of a protocol that was not proposed, a step out of
  order, and the 17th message abort the transfer; a message for an unknown
  or finished transfer is ignored. The protocol carries only these messages
  and mandates no transport; how the bytes move is the named protocol's
  business, and they are verified against `sha256` as from a URL. Either side
  may refuse or abort at any step. A direct connection shows each agent's
  network address to the other (and to any TURN server used), so a host
  offers or accepts it only for contacts and under its owner's setting, off
  by default for group members who are not contacts. Bounds: 16 messages per
  transfer, 16 KiB of `data` each (canonical JSON), nested at most 16 deep.
- **Lifetime.** A sender that uploaded a copy SHOULD remove it when the task
  ends or `expires` passes; receivers MUST NOT rely on it later.
- **In tasks** (**spec change**, issue #26). A tasks/v1 message or artifact
  (§7.6.1) MAY carry file parts, and then lists the files URI in its
  `extensions`; an agent sends them only to a peer whose card lists it. A
  receiver validates every file part by the rules above before its task
  engine sees the payload, and refuses the whole payload when one fails; it
  keeps the part in its validated form (display name and type sanitized,
  other extensions' metadata dropped). Fetching follows the start gate
  (§5.5): an executor fetches a request's files only once its human
  approved the start, and the start gate shows each file's name, type, size,
  `sha256`, encryption and URL; a requester fetches the files of its
  results when it chooses (its side started the task). A file of the
  owner's in an artifact is owner data, so it leaves only through the
  release gate, which shows the human each file's name, size, `sha256`, the
  URL it is stored at, the local file it was read from and the recipient;
  the sender encrypts it before the gate, so the key exists only in the
  held draft and then inside the envelope. A receiver saves what it fetched
  under a name it derives (never the peer's path), without execute
  permission, apart from its other files, and hands its model the saved
  path and metadata rather than the content (short text MAY be returned,
  marked as peer text, §5.6). The content stays untrusted whatever its hash.
- **Direct transfer, the owner's setting** (**spec change**, issue #26). A
  host offers or accepts a direct transfer only under an owner setting, off
  by default and never changed by a model or a peer. With it off, a host
  answers a `propose` with `abort`; with it on, the `propose` is shown to the
  owner, who decides. No step of a transfer is answered with `accept`
  automatically, and a `p2p` list in a reference is only shown: nothing
  connects because an offer arrived.
- A `FilePart` with neither inline `bytes` nor this metadata (at least
  `sha256` and `size`) is refused: an agent never fetches a URL without a
  hash to check. Under §7.5 this metadata is the one case that is not
  ignorable, because the files extension makes it part of the part's
  meaning; a receiver that does not support the extension answers
  unsupported. Other keys in the part's `metadata` stay ignorable.

**Privacy cost.** A fetch shows the store the receiver's IP address and the
time; a direct transfer shows it to the peer. Agents that care fetch through
a proxy or decline the transfer. The relay sees nothing new.

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
| A peer's file URL aims the agent at its owner's network (SSRF), or at a page only the owner can open | Fetching is the agent's choice, never on arrival; `https` only; private, loopback and link-local addresses refused after resolving and after each redirect, the connection pinned to the checked address; at most 3 redirects; never with credentials (§7.7) |
| A store or mirror swaps or truncates a file | `sha256` and `size` in the encrypted reference; the bytes are verified before use, then decrypted and checked against `plain_sha256` (§7.7) |
| Assistant approves a contact on its own, or is talked into it | Consent stays with the human, outside the model's reach (§5.5) |
| A contact on auto-approve is compromised or prompt-injected | Owner-only switch with a warning, per contact; grant `invoke` and limits still bound it; off on revoke, block, abuse, a changed grant or a fork; every action audited (§5.5.1) |
| Prompt injection through greetings or message text | Peer text is display-only data; only validated machine fields drive actions (§5.6) |
| A task request (`request/v1`) tells the executor's model to send owner data, grant, or approve itself | Start gate before any work; release gate on everything that leaves; approvals and confirm phrases come only from the human and are bound to what they saw, so one written in the request is never valid; peer content marked untrusted and terminal-safe; the model drafts, never acts (§5.6, §7.6.4) |
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
- A file reference (§7.7) is fetched from a store the sender chose: the
  store sees the receiver's IP address and the time, and a direct transfer
  shows it to the peer. Files on a store the sender does not control are
  encrypted with a per-file key that travels only in the envelope.
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
  automatically. Per-capability limits (`scope.invoke`, §5.3) reject only
  the task that goes over them, and revoke the grant only for gross abuse
  (**spec change**, issue #28).
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
8. **Ending an agreed meeting.** `meeting/cancel` (§7.3) lets either human
   call off an agreed meeting, and a peer's `canceled` or `rejected` status
   now releases a meeting the receiver completed, which closes the race where
   a confirm is delayed past the accepter's grace period or crosses the
   accepter's owner's cancel. An agent that predates the verb still ignores
   it and keeps the meeting, but the canceling side now knows: the peer's
   card does not advertise the verb, or its agent answers unsupported (§7.5),
   and the canceling agent tells its human to settle it directly. Still open:
   a peer that upgraded keeps looking old until a newer card reaches us.

9. **No forward secrecy.** Envelopes are encrypted to a static recipient key
   (§6.4). Conversation-scoped keys from the handshake are future work.
10. **Channel state for strangers** (resolved). A receiver used to advance
    `seq` state for any validly signed envelope before deciding whether to
    admit the sender, so every fresh key cost it memory. It now keeps channel
    state only for senders it admits or asked (§6.4).
11. **Extending the meeting verbs** (resolved). New verbs are A2A extension
    URIs advertised in the card's `capabilities`; unknown verbs and `data`
    fields are answered as unsupported, `metadata` is ignorable (§7.5).
12. **Contacts hold a stale card** (resolved). A contact used to keep the
    card from the handshake, so it missed new capabilities and relays. An
    agent now sends each contact its new card (`rdv/card-update`, §4.3).
    Still open: a contact that is offline past the relays' retention, or
    runs older software, keeps the old card until the next change.
13. **The quarantine is not enforced by today's hosts.** §5.6 rule 3 asks
    for a tool-less model to read peer tasks; the reference MCP server
    cannot take tools away from the client's model, so it enforces the
    gates and the marking and tells the model the rules. A model that
    follows an injected request can still misuse its other tools; only
    what leaves through the task is caught by the release gate.

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
| `rdv_grant` / `rdv_revoke` | approve/reject/revoke contacts with tier+scope (meetings and the capabilities in `scope.invoke`); a grant needs the human's own approval (§5.5) |
| `rdv_send` | send an envelope (task, message, proposal) |
| `rdv_inbox` | read events after a cursor (an event log; nothing is acknowledged to the peer) |
| `rdv_negotiate` | A2A task exchange lifecycle |
| `rdv_task` | general tasks (§7.6): request one from a contact, list and show them, answer `input-required`, cancel; for a contact's task, approve its start and release each result, both only with the human's own approval (§5.5) |

`rdv_grant` MUST NOT succeed on the model's say-so (§5.5), nor may
`rdv_task` pass a start or release gate on it, and peer text in any result
is returned marked as untrusted (§5.6). One server runs per home
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
