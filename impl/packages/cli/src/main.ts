import { type ParseArgsConfig, parseArgs } from 'node:util';
import * as cmd from './commands.js';
import { CliError, Home } from './home.js';
import { Output } from './output.js';

type Options = NonNullable<ParseArgsConfig['options']>;

interface Command {
  usage: string;
  summary: string;
  /** Exact number of positional arguments. */
  args: number;
  options?: Options;
  run(ctx: cmd.Ctx): Promise<void>;
}

const COMMON: Options = {
  home: { type: 'string' },
  profile: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const COMMANDS: Record<string, Command> = {
  init: {
    usage: 'rdv init --profile omer --email omer@example.com --relay wss://… [--relay …] [--phone +…] [--public-pointer] [--force]',
    summary: 'Generate a key and card, write state',
    args: 0,
    options: {
      email: { type: 'string', multiple: true },
      phone: { type: 'string', multiple: true },
      relay: { type: 'string', multiple: true },
      'public-pointer': { type: 'boolean' },
      force: { type: 'boolean' },
    },
    run: cmd.init,
  },
  whoami: { usage: 'rdv whoami', summary: 'Print agent ID, fingerprint, card JSON', args: 0, run: cmd.whoami },
  'card publish': {
    usage: 'rdv card publish',
    summary: 'Publish public pointers (if enabled)',
    args: 0,
    run: cmd.cardPublish,
  },
  lookup: {
    usage: 'rdv lookup <address>',
    summary: 'Fetch public-pointer cards for an address',
    args: 1,
    run: cmd.lookup,
  },
  'contact request': {
    usage: 'rdv contact request <email|card-file|agent-id> [--greeting "…"] [--in-person]',
    summary: 'Topic probe by email, or direct by card (--in-person: the card came from a QR/in person)',
    args: 1,
    options: { greeting: { type: 'string' }, 'in-person': { type: 'boolean' } },
    run: cmd.contactRequest,
  },
  'contact pending': {
    usage: 'rdv contact pending',
    summary: 'List pending inbound requests, and answers to your topic probes awaiting confirmation',
    args: 0,
    run: cmd.contactPending,
  },
  'contact grant': {
    usage: 'rdv contact grant <request-id|agent-id> [--tier friend] [--scope-file s.json]',
    summary: 'Approve a pending request, or give a contact you requested rights towards you (meetings etc.)',
    args: 1,
    options: { tier: { type: 'string' }, 'scope-file': { type: 'string' } },
    run: cmd.contactGrant,
  },
  'contact confirm': {
    usage: 'rdv contact confirm <grant-id>',
    summary: 'Accept an answer to your topic probe as the contact (check the fingerprint first)',
    args: 1,
    run: cmd.contactConfirm,
  },
  'contact reject': {
    usage: 'rdv contact reject <grant-id> [--block]',
    summary: 'Turn down an answer to your topic probe',
    args: 1,
    options: { block: { type: 'boolean' } },
    run: cmd.contactReject,
  },
  'contact decline': {
    usage: 'rdv contact decline <request-id> [--block]',
    summary: 'Decline a pending request',
    args: 1,
    options: { block: { type: 'boolean' } },
    run: cmd.contactDecline,
  },
  'contact list': { usage: 'rdv contact list', summary: 'List contacts', args: 0, run: cmd.contactList },
  'contact revoke': {
    usage: 'rdv contact revoke <agent-id>',
    summary: 'Revoke a contact',
    args: 1,
    run: cmd.contactRevoke,
  },
  send: {
    usage: 'rdv send <agent-id> --json \'{"type":"a2a/message","text":"hi"}\'   (or --payload \'…\')',
    summary: 'Send any payload to a contact (--json carries the payload here and also selects JSON output)',
    args: 1,
    options: { json: { type: 'string' }, payload: { type: 'string' } },
    run: cmd.send,
  },
  'dinner propose': {
    usage:
      'rdv dinner propose <agent-id> --calendar cal.json --window "next week evenings" [--tz +02:00] [--minutes 120] [--place "…"] [--area "…"] [--expires <rfc3339>]',
    summary: 'Propose dinner: offer up to 3 free slots from the window (A2A task)',
    args: 1,
    options: {
      calendar: { type: 'string' },
      window: { type: 'string' },
      tz: { type: 'string' },
      minutes: { type: 'string' },
      place: { type: 'string' },
      area: { type: 'string' },
      expires: { type: 'string' },
    },
    run: cmd.dinnerPropose,
  },
  'dinner cancel': {
    usage: 'rdv dinner cancel <task-id> [--reason "…"]',
    summary: 'Cancel a pending dinner negotiation (rdv/cancel)',
    args: 1,
    options: { reason: { type: 'string' } },
    run: cmd.dinnerCancel,
  },
  'dinner list': { usage: 'rdv dinner list', summary: 'List dinner negotiations and their state', args: 0, run: cmd.dinnerList },
  listen: {
    usage:
      'rdv listen [--auto-grant <tier>] [--exec <script>] [--negotiate --calendar cal.json [--window "next week evenings"] [--tz +02:00]]',
    summary: 'Long-running: print events; optionally auto-grant (demo only), pipe events to a script, or negotiate dinner',
    args: 0,
    options: {
      'auto-grant': { type: 'string' },
      exec: { type: 'string' },
      negotiate: { type: 'boolean' },
      calendar: { type: 'string' },
      window: { type: 'string' },
      tz: { type: 'string' },
    },
    run: cmd.listenCmd,
  },
  inbox: {
    usage: 'rdv inbox [--follow]',
    summary: 'Show received payloads',
    args: 0,
    options: { follow: { type: 'boolean' } },
    run: cmd.inbox,
  },
};

function help(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    'rdv: Rendezvous agent CLI',
    '',
    'usage: rdv <command> [options]',
    '',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    '',
    'Common options:',
    '  --home <dir>       state directory (default ~/.rendezvous/<profile>, or $RDV_HOME)',
    '  --profile <name>   profile name (default "default", or $RDV_PROFILE)',
    '  --json             JSON lines on stdout instead of text',
    '  -h, --help         help for a command',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage error.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const wantsJson = argv.includes('--json');
  const fallbackOut = new Output(wantsJson);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(help() + '\n');
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === '--version') {
    process.stdout.write('0.1.0\n');
    return 0;
  }

  let name = argv[0];
  let rest = argv.slice(1);
  if (`${argv[0]} ${argv[1]}` in COMMANDS) {
    name = `${argv[0]} ${argv[1]}`;
    rest = argv.slice(2);
  }
  const command = COMMANDS[name];
  if (!command) {
    const subs = Object.keys(COMMANDS).filter((k) => k.startsWith(`${argv[0]} `));
    fallbackOut.error(
      subs.length ? `"${argv[0]}" needs a subcommand: ${subs.join(', ')}` : `unknown command "${argv[0]}" (see rdv --help)`,
    );
    return 2;
  }

  let values: cmd.Ctx['values'];
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { ...COMMON, ...command.options },
      allowPositionals: true,
      strict: true,
    }) as { values: cmd.Ctx['values']; positionals: string[] });
  } catch (err) {
    fallbackOut.error(`${(err as Error).message}\nusage: ${command.usage}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${command.usage}\n  ${command.summary}\n`);
    return 0;
  }
  // For `send`, --json carries the payload; using it also means JSON output.
  const out = new Output(values.json !== undefined && values.json !== false);
  if (positionals.length !== command.args) {
    out.error(`expected ${command.args} argument(s), got ${positionals.length}\nusage: ${command.usage}`);
    return 2;
  }

  try {
    const home = Home.resolve({ home: values.home as string | undefined, profile: values.profile as string | undefined });
    await command.run({ home, out, values, positionals });
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error((err as Error)?.message ?? String(err));
    return 1;
  }
}
