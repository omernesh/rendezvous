# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Rendezvous is an open protocol for agent-to-agent contact. Personal AI agents find each other by a human address (email or phone), get consent, then exchange encrypted messages over dumb relays (Nostr first).

- `SPEC.md` is the source of truth. `PLAN.md` holds the implementation plan and current status. Work the plan in order (§9 checklist); each step has its own "done when" check.
- `impl/` is an npm workspace (Node ≥ 20, ESM, `NodeNext`, so relative imports need a `.js` suffix): the protocol library `@rendezvous/core` in `impl/packages/core` and the `rdv` CLI `@rendezvous/cli` in `impl/packages/cli`. `impl/deploy/` holds the relay deployment.
- `spec.html` is generated from `SPEC.md` by `render_html.py`. Don't edit it by hand. `deck/` mirrors a pitch deck published elsewhere and isn't built here.

## Commands

Run everything from `impl/` (same commands in PowerShell and bash):

```bash
npm install
npm run typecheck                       # every workspace
npm test                                # core: unit, integration, vectors; cli: commands + contact scenario (~15s, no network)
npm test -w @rendezvous/core            # one package
cd packages/core && npx vitest run test/unit.test.ts -t envelope   # one file / test by name
npm run build                           # tsc -b -> packages/*/dist
npm run rdv -- whoami --home ./tmp/omer # run the built CLI
```

Run `npm run typecheck` and `npm test` before every commit. **There is no CI** (no GitHub Actions minutes). Local tests are the gate, so don't add workflows. `.githooks/pre-push` enforces them once enabled with `git config core.hooksPath .githooks`.

CLI tests spawn the built `rdv` (`packages/cli/dist/src/bin.js`); the CLI's `test` script runs `tsc -b` first, which also builds core.

**Live relays:** `RDV_LIVE_RELAYS=wss://a,wss://b npm run test:live` (PowerShell: `$env:RDV_LIVE_RELAYS='wss://a,wss://b'; npm run test:live`). Only `*.live.test.ts` run there, they skip when the variable is unset, and they are never part of `npm test`. The scenario also runs by hand: `node packages/cli/dist/scenarios/contact.js --relay wss://…`.

From the repo root, after editing `SPEC.md`: `python render_html.py` (needs the `markdown` package).

**Test vectors** (`impl/packages/core/vectors/v1.json`) are interop fixtures. Regenerate them only on a deliberate wire-format change (`npm run test:vectors:update`, works in PowerShell too), and say so in the commit message.

## Architecture (`impl/packages/core/src`)

The modules are layered, and each one maps to a spec section (table in `impl/README.md`):

- `encoding` → `sign`: canonical JSON (sorted keys, no whitespace, integers only) plus Ed25519 signatures over `"rdv1/sig:" ‖ canon(doc without sig)`. Every signed document (card, request, grant, revoke, envelope) goes through this, and any change here breaks the vectors.
- `identity`: Ed25519 seed → `rdv1:` + lowercase base32 ID. It also converts the key to X25519 for encryption.
- `card`, `discovery`, `contact`: address cards, `dtopic(address)` discovery topics, and the `ContactBook` that enforces consent: policy, allow/block lists, replay IDs, `max_frequency` (exceeding it revokes the grant).
- `envelope`: ephemeral X25519 → HKDF → AES-256-GCM. The signature covers the **whole** envelope, including ciphertext; this is a deliberate departure from the spec. `Channels` tracks per-direction `seq`/`prev` hash chains, buffers gaps, and requests resends (`rdv/resend`) from a 64-envelope outbox.
- `transport/transport.ts`: the `Transport` interface, a dumb pipe that never gets trusted. `transport/nostr.ts` implements it with kind 30417, `p`/`t`/`d` tags and a secp256k1 "carrier" key derived from the agent seed (Nostr can't sign with Ed25519). It forces the `ws` package because Node's built-in WebSocket overflows the stack inside nostr-tools.
- `agent`: an event-emitting façade over all of the above (`start`, `lookup`, `requestContact`, `grant`, `send`, plus events `request`/`contact`/`message`/`revoked`/`dropped`). It serializes with `toJSON`/`fromJSON`. The human decides consent in the `request` handler, and the library must never auto-grant.
- `testing/relay.ts`: an in-memory Nostr relay on a localhost WebSocket, exported as `@rendezvous/core/testing`. Integration tests (and the CLI scenario's child processes) use it so `npm test` never touches the network.

`impl/packages/cli` (`rdv`): `main.ts` parses args (`node:util` parseArgs) and dispatches to `commands.ts`; `home.ts` owns the state dir (`agent.json` mode 600, `config.json`, `inbox.jsonl`, `cards.json`, `lock`); `fsutil.ts` has the lockfile and atomic writes; `listen.ts` keeps relay subscriptions open but takes the lock only per inbound item (reload state, handle, save, then print), so other `rdv` commands can run beside it; `output.ts` renders text/JSON lines and `clean()`s every peer-supplied field. `scenarios/` drives real `rdv` processes (PLAN §4.5).

Planned packages `a2a` and `mcp` go under `impl/packages/` too (PLAN.md §1). They depend on core. Keep core free of CLI, MCP and LLM dependencies.

## Spec deltas

When implementing turns up a gap, ambiguity or unsafe spot in the spec, record it in `impl/NOTES.md` (mark it **spec change** if SPEC.md must change). PLAN.md §7 lists what goes into spec rev 3. Read NOTES.md before touching any wire format: it pins the choices the spec leaves open (base32 alphabet, `sig` encoding, KDF salt and info, `prev` hash, address canonicalization).

## Conventions

- The owner writes Python day to day and works on Windows (PowerShell). Keep command examples cross-platform.
- Example personas are anonymized: **Omer** (`omer@example.com`) and **John** (`john@doe.com`, `doe.com`). Don't put real people or addresses into the spec, tests or deck.
