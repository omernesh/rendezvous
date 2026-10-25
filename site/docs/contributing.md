# Contributing to Rendezvous

Thanks for helping. Rendezvous is a draft protocol ([`SPEC.md`](https://rendezvous.nesher.co/docs/spec.md)) with a
TypeScript reference implementation in [`impl/`](https://github.com/omernesh/rendezvous/tree/main/impl). Both are open to change,
and a second implementation in another language is the most valuable thing
anyone can build right now.

## Where to start

- **Open issues:** https://github.com/omernesh/rendezvous/issues
- **The spec's open problems:** [SPEC.md §11](https://rendezvous.nesher.co/docs/spec.md#11-open-problems-honest)
  (key recovery, forward secrecy, Sybil, consent UX). Proposals welcome as issues.
- **Ports:** Python, Go, Rust, anything. Reproduce the interop test vectors in
  [`impl/packages/core/vectors/v1.json`](https://github.com/omernesh/rendezvous/blob/main/impl/packages/core/vectors/v1.json)
  (keys, IDs, discovery topics, a signed card and request, an envelope you
  should be able to open) and you interoperate. [`impl/NOTES.md`](https://github.com/omernesh/rendezvous/blob/main/impl/NOTES.md)
  pins every wire-format choice the spec leaves open.
- **Relays:** run a Nostr relay and tell us how it handles kind 30417 events.
- **Integrations:** wire `rdv-mcp` or `@rendezvous/core` into an agent or framework.

## Dev setup

Node.js 20 or newer. Everything runs from `impl/`, the same in bash and PowerShell:

```bash
cd impl
npm install
npm run typecheck        # every workspace
npm test                 # core, a2a, cli, mcp; in-memory relay, no network
npm run build            # tsc -b -> packages/*/dist
```

One package or one test: `npm test -w @rendezvous/core`, or
`cd packages/core && npx vitest run test/unit.test.ts -t envelope`.
Live relay tests are opt-in: `RDV_LIVE_RELAYS=wss://… npm run test:live`.
See [`impl/README.md`](https://rendezvous.nesher.co/docs/cli.md) and [`CLAUDE.md`](https://github.com/omernesh/rendezvous/blob/main/CLAUDE.md) for the architecture.

## Tests are the gate

There is no CI. Before every commit, run:

```bash
npm run typecheck && npm test
```

and enable the pre-push hook once per clone (from the repo root), which runs the same:

```bash
git config core.hooksPath .githooks
```

Please don't add CI workflows. Add a regression test with every bug fix.

## Pull requests

- One PR per change, kept small. PRs are merged with **rebase-merge**, so keep
  commits clean and each one meaningful.
- Keep `@rendezvous/core` free of A2A, CLI, MCP and LLM dependencies.
- Regenerate the test vectors (`npm run test:vectors:update`) only for a
  deliberate wire-format change, and say so in the commit message.

## Spec deltas

If implementing turns up a gap, ambiguity or unsafe spot in the spec, record it
in [`impl/NOTES.md`](https://github.com/omernesh/rendezvous/blob/main/impl/NOTES.md), marked **spec change** if `SPEC.md` must
change. Read NOTES.md before touching any wire format.

## Personas

Examples, tests and docs use anonymized personas only: **Omer**
(`omer@example.com`) and **John** (`john@doe.com`, `doe.com`). Never put real
people, email addresses, phone numbers or other personal data in the spec,
code, tests or docs.

## Security

Please report vulnerabilities privately through a
[GitHub security advisory](https://github.com/omernesh/rendezvous/security/advisories/new),
not a public issue. Consent bypasses, injection through peer text and anything
that lets a relay read or alter content are in scope.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](https://github.com/omernesh/rendezvous/blob/main/LICENSE).
