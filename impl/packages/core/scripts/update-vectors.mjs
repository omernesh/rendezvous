// Regenerates vectors/v1.json. Sets UPDATE_VECTORS in-process so the same
// command works in PowerShell, cmd and POSIX shells (no cross-env needed).
// Only run this for a deliberate wire-format change, and say so in the commit.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx vitest run test/vectors.test.ts', {
  stdio: 'inherit',
  shell: true,
  // UPDATE_VECTORS=envelope also re-seals the sample envelope (sealing is randomized, so it is kept otherwise).
  env: { ...process.env, UPDATE_VECTORS: process.env.UPDATE_VECTORS || '1' },
});
process.exit(r.status ?? 1);
