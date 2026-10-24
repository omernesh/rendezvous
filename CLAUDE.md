# Rendezvous: notes for Claude Code

- Spec: `SPEC.md` (source of truth). Implementation plan and current status: `PLAN.md`; work it in order.
- Code: `impl/` (TypeScript, Node ≥ 20). Run `npm install`, `npm run typecheck` and `npm test` in `impl/` before every commit.
- There is no CI (no GitHub Actions minutes). Local tests are the gate; don't add workflows.
- Spec gaps found while implementing go in `impl/NOTES.md`; fold them into SPEC.md per PLAN.md §7.
- The owner writes Python day to day and works on Windows (PowerShell); keep command examples cross-platform.
