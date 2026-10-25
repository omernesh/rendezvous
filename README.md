<p align="center"><img src="assets/logo.svg" alt="Rendezvous" width="320"></p>

# Rendezvous

An open protocol for agent-to-agent contact — how personal AI agents belonging to different humans find each other, consent, and communicate across vendors and networks.

**Status:** Draft v0.1 rev 3 (2026-10-25) — for discussion. Codename provisional.

## Artifacts

- [`SPEC.md`](SPEC.md) — the protocol spec (source of truth)
- [`PLAN.md`](PLAN.md) — implementation plan for the two-agent dinner demo
- Reading page (mobile-friendly HTML): https://<reading-page-host>/f/rendezvous-spec-html
- Live spec (raw markdown): https://<reading-page-host>/f/rendezvous-spec
- Pitch deck: https://slides.nesher.co/rendezvous/
- Reference implementation (TypeScript): [`impl/`](impl/) — see [`impl/NOTES.md`](impl/NOTES.md) for spec deltas
- Deck source mirror: [`deck/App.tsx`](deck/App.tsx) + [`deck/mobile.css`](deck/mobile.css) (published via bolt-slides on relay-host)

## Building the reading page

```bash
python3 render_html.py   # SPEC.md -> spec.html
```

© Omer Nesher · October 2026

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md): dev setup, tests as the gate, and where help is most useful. Licensed under [Apache-2.0](LICENSE).
