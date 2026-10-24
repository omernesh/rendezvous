#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv.slice(2));
// Let piped stdout/stderr drain before exiting; open relay sockets would otherwise keep us alive.
await new Promise<void>((r) => process.stdout.write('', () => r()));
await new Promise<void>((r) => process.stderr.write('', () => r()));
process.exit(code);
