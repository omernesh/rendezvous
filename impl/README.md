# @rendezvous/core

TypeScript reference library for the [Rendezvous](../SPEC.md) agent-to-agent
contact protocol. It is step 1 of the two-agent dinner demo.

| Module | Spec | What it does |
|---|---|---|
| `identity` | §4.1–4.2 | Ed25519 agent keys, `rdv1:` IDs, fingerprints |
| `sign` | — | Signed JSON documents (canonical JSON + Ed25519) |
| `card` | §4.3 | Create and verify address cards |
| `discovery` | §4.4 | `dtopic()`, address canonicalization, binding levels |
| `contact` | §5 | Contact request / grant / revoke, and the contact book (policy, replay, rate limits) |
| `envelope` | §6.4, §7 | Encrypted, signed envelopes; `seq`/`prev` ordering with gap detection |
| `transport/nostr` | §6.2 | Nostr relay transport (kind 30417) |
| `agent` | — | Ties it together: listen, discover, request, grant, send, receive |
| `testing/relay` | — | In-memory Nostr relay for tests and local demos |

## Use

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

## Develop

```bash
npm install
npm test             # unit, two-agent integration (local relay), test vectors
npm run typecheck
npm run build
```

`vectors/v1.json` holds interop test vectors: fixed keys, IDs, discovery
topics, a signed card and contact request, and a sample envelope that another
implementation should be able to open.

See [NOTES.md](NOTES.md) for wire-format decisions and the places where this
library departs from or fills gaps in SPEC.md.
