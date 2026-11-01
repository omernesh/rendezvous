// rdv-gateway's arguments, and which of its commands are the owner's alone (issue #126).
import { parseArgs } from 'node:util';

const OPTIONS = {
  home: { type: 'string' },
  profile: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'public-url': { type: 'string' },
  'allow-remote-bind': { type: 'boolean' },
  'client-ip-header': { type: 'string' },
  calendar: { type: 'string', multiple: true },
  'calendar-dir': { type: 'string', multiple: true },
  window: { type: 'string' },
  tz: { type: 'string' },
  name: { type: 'string' },
  scope: { type: 'string' },
  stdin: { type: 'boolean' },
  agent: { type: 'string' },
  email: { type: 'string', multiple: true },
  phone: { type: 'string', multiple: true },
  relay: { type: 'string', multiple: true },
  'public-pointer': { type: 'boolean' },
  restore: { type: 'string' },
  force: { type: 'boolean' },
  url: { type: 'string' },
  events: { type: 'string' },
  'secret-file': { type: 'string' },
  'allow-insecure-host': { type: 'string', multiple: true },
  retry: { type: 'boolean' },
  resume: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** rdv-gateway's arguments (strict: an unknown option throws). */
export const parseGatewayArgs = (argv: string[]) => parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
export type GatewayValues = ReturnType<typeof parseGatewayArgs>['values'];

/**
 * The owner commands that refuse without an interactive terminal, as the plugin's consent guard lists them: each
 * changes who or what reaches the agent. Read-only ones (serve, token list, oauth list, agent list, notify show) stay open.
 */
const GATEWAY_HUMAN: Record<string, ReadonlySet<string>> = {
  pin: new Set(['set', 'unlock']),
  token: new Set(['create', 'revoke']),
  oauth: new Set(['revoke']),
  agent: new Set(['add', 'remove', 'migrate']),
  notify: new Set(['set', 'clear', 'dead-letter']),
};

/** Would `rdv-gateway <cmd> <sub>` need the owner's terminal? */
export const gatewayHumanOnly = (cmd: string | undefined, sub: string | undefined): boolean =>
  cmd !== undefined && sub !== undefined && Object.hasOwn(GATEWAY_HUMAN, cmd) && GATEWAY_HUMAN[cmd].has(sub);

/** The same for a whole argument list (false when it does not parse, or asks for help: bin.js says why). */
export function gatewayHumanOnlyArgv(argv: string[]): boolean {
  try {
    const { values, positionals } = parseGatewayArgs(argv);
    return !values.help && gatewayHumanOnly(positionals[0], positionals[1]);
  } catch {
    return false;
  }
}
