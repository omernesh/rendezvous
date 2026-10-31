// Keep stdout for the protocol (review of PR #120, round 4). In rdv-mcp stdout
// is the JSON-RPC channel, and in `rdv … --json` it is the JSON output; a
// dependency that prints there (nostr-tools' default NOTICE handler calls
// console.debug with the relay's own text) lets a hostile relay forge
// protocol messages. Importing '@rendezvous/core/safe-console' first in an entry point sends
// every console method to stderr, each call as one line: control and
// format characters (ANSI escapes, newlines, bidi) replaced, at most 500
// characters.
import { format } from 'node:util';

/** Longest console line written. */
export const SAFE_CONSOLE_MAX = 500;

// C0, DEL and C1 controls, bidi overrides and isolates, line and paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** One console call as a single safe line. */
export function safeConsoleLine(args: unknown[]): string {
  const text = format(...args).replace(UNSAFE, ' ');
  return text.length > SAFE_CONSOLE_MAX ? `${text.slice(0, SAFE_CONSOLE_MAX - 1)}…` : text;
}

/** Route console.log/info/debug/warn/error/trace/dir to `write` (default: stderr), one safe line per call. */
export function installSafeConsole(write: (line: string) => void = (l) => void process.stderr.write(l)): void {
  // A closed stderr (EPIPE) must not crash the process: the global console swallowed stream errors, so do we.
  process.stderr.on('error', () => {});
  const out = (...args: unknown[]) => {
    try {
      write(`${safeConsoleLine(args)}\n`);
    } catch {
      // stderr gone: drop the line
    }
  };
  for (const m of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'] as const) {
    (console as unknown as Record<string, unknown>)[m] = out;
  }
}

