#!/usr/bin/env node
// rdv-mcp: the Rendezvous MCP server on stdio.
//
//   rdv-mcp [--home <dir> | --profile <name>] [--calendar cal.json] [--window "next week evenings"] [--tz +02:00]
//
// Home resolution is the same as `rdv` (--home, else $RDV_HOME, else
// ~/.rendezvous/<profile>), so both can share a profile. stdout carries the
// MCP protocol; human-facing notices (including confirm phrases) go to stderr.
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Home } from '@rendezvous/cli/lib';
import { RdvMcpServer } from './server.js';

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    profile: { type: 'string' },
    calendar: { type: 'string' },
    window: { type: 'string' },
    tz: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (values.help) {
  process.stderr.write(
    'usage: rdv-mcp [--home <dir> | --profile <name>] [--calendar cal.json] [--window "next week evenings"] [--tz +02:00]\n' +
      'Env: RDV_HOME, RDV_PROFILE, RDV_CALENDAR, RDV_WINDOW, RDV_TZ.\n',
  );
  process.exit(0);
}

const server = new RdvMcpServer({
  home: Home.resolve({ home: values.home, profile: values.profile }),
  calendar: values.calendar ?? process.env.RDV_CALENDAR,
  window: values.window ?? process.env.RDV_WINDOW,
  tz: values.tz ?? process.env.RDV_TZ,
});

const shutdown = async () => {
  await server.close().catch(() => {});
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.stdin.once('end', shutdown);

await server.connect(new StdioServerTransport());
