#!/usr/bin/env node
// rdv-mcp: the Rendezvous MCP server on stdio.
//
//   rdv-mcp [--home <dir> | --profile <name>] [--calendar cal.json] [--calendar-dir <dir>]… [--window "next week evenings"] [--tz +02:00]
//
// Home resolution is the same as `rdv` (--home, else $RDV_HOME, else
// ~/.rendezvous/<profile>), so both can share a profile. stdout carries the
// MCP protocol; human-facing notices (including confirm phrases) go to stderr.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Home } from '@rendezvous/cli/lib';
import { elicitOptionsFromEnv, RdvMcpServer } from './server.js';

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    profile: { type: 'string' },
    calendar: { type: 'string' },
    'calendar-dir': { type: 'string', multiple: true },
    window: { type: 'string' },
    tz: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  process.stderr.write(
    'usage: rdv-mcp [--home <dir> | --profile <name>] [--calendar cal.json] [--calendar-dir <dir>]… [--window "next week evenings"] [--tz +02:00]\n' +
      '  --calendar-dir: a directory the assistant may pick calendar files from (besides the home and the --calendar directory)\n' +
      'Env: RDV_HOME, RDV_PROFILE, RDV_CALENDAR, RDV_CALENDAR_DIR, RDV_WINDOW, RDV_TZ.\n' +
      '  RDV_ELICIT_TIMEOUT_MS: how long an approval form waits for an answer (default 60000); unanswered, it is withdrawn and confirm phrases are used from then on\n' +
      '  RDV_ELICIT=off: never send approval forms; always use confirm phrases\n',
  );
  process.exit(0);
}

const server = new RdvMcpServer({
  home: Home.resolve({ home: values.home, profile: values.profile }),
  calendar: values.calendar ?? process.env.RDV_CALENDAR,
  calendarDirs: [...(values['calendar-dir'] ?? []), ...(process.env.RDV_CALENDAR_DIR ? [process.env.RDV_CALENDAR_DIR] : [])],
  window: values.window ?? process.env.RDV_WINDOW,
  tz: values.tz ?? process.env.RDV_TZ,
  ...elicitOptionsFromEnv(process.env, (line) => process.stderr.write(`[rdv-mcp] ${line}\n`)),
});

const shutdown = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.stdin.once('end', shutdown);

await server.connect(new StdioServerTransport());
