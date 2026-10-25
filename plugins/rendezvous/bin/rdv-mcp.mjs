#!/usr/bin/env node
// Starts the rdv-mcp server that the Rendezvous installer built.
//
// The installer clones and builds into ~/.rendezvous/src (or $RDV_DIR) and
// writes `rdv-mcp` shims onto PATH. A bare `rdv-mcp` command in .mcp.json is
// not portable (on Windows it is a .cmd shim, which needs `cmd /c`), so this
// launcher runs under `node` and loads the built server in-process. Arguments
// and the environment pass through unchanged: the server resolves its home
// the same way `rdv` does (--home, $RDV_HOME, ~/.rendezvous/$RDV_PROFILE or
// ~/.rendezvous/default).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.env.RDV_DIR ? resolve(process.env.RDV_DIR) : join(homedir(), '.rendezvous', 'src');
const server = join(dir, 'impl', 'packages', 'mcp', 'dist', 'src', 'bin.js');

if (!existsSync(server)) {
  process.stderr.write(
    `[rdv-mcp] Rendezvous is not installed (no ${server}).\n` +
      '[rdv-mcp] Install it, then run /reload-plugins (or restart Claude Code):\n' +
      '[rdv-mcp]   macOS / Linux: curl -fsSL https://rendezvous.nesher.co/install.sh | sh\n' +
      '[rdv-mcp]   Windows:       irm https://rendezvous.nesher.co/install.ps1 | iex\n' +
      '[rdv-mcp] If you installed with RDV_DIR set, start Claude Code with the same RDV_DIR.\n',
  );
  process.exit(1);
}

await import(pathToFileURL(server).href);
