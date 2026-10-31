#!/usr/bin/env node
// First: stdout is our output (`--json` lines), so every console call goes to stderr, one safe line each (review of PR #120).
import '@rendezvous/core/safe-console';
import { main } from './main.js';

const code = await main(process.argv.slice(2));
// Let piped stdout/stderr drain before exiting; open relay sockets would otherwise keep us alive.
await new Promise<void>((r) => process.stdout.write('', () => r()));
await new Promise<void>((r) => process.stderr.write('', () => r()));
process.exit(code);
