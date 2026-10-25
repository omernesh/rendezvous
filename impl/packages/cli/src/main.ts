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
    usage: 'rdv init --profile omer --email omer@example.com [--email …] [--relay wss://… [--relay …]] [--phone +…] [--phone …] [--public-pointer] [--force]',
    summary: 'Generate a key and card, write state (no --relay: the default public relays)',
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
  'address list': {
    usage: 'rdv address list',
    summary: "List this agent's addresses: public ones are on the card and findable, private ones are kept locally",
    args: 0,
    run: cmd.addressList,
  },
  'address add': {
    usage: 'rdv address add <email|+phone> [--public|--private]',
    summary: 'Add an address (default --public: listed on the card, answers probes); re-signs and republishes the card',
    args: 1,
    options: { public: { type: 'boolean' }, private: { type: 'boolean' } },
    run: cmd.addressAdd,
  },
  'address remove': {
    usage: 'rdv address remove <email|+phone>',
    summary: 'Remove an address: probes on it are no longer answered; re-signs and republishes the card (contacts are kept)',
    args: 1,
    run: cmd.addressRemove,
  },
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
    usage: 'rdv contact request <email|card-file|agent-id> [--greeting "…"] [--in-person] [--label john@doe.com]',
    summary: 'Topic probe by email, or direct by card (--in-person: the card came from a QR/in person)',
    args: 1,
    options: { greeting: { type: 'string' }, 'in-person': { type: 'boolean' }, label: { type: 'string' } },
    run: cmd.contactRequest,
  },
  'contact pending': {
    usage: 'rdv contact pending',
    summary: 'List pending inbound requests, and answers to your topic probes awaiting confirmation',
    args: 0,
    run: cmd.contactPending,
  },
  'contact grant': {
    usage:
      'rdv contact grant <request-id|agent-id> [--tier friend] [--scope-file s.json] [--invoke <capability-uri>]... [--no-meetings] [--label john@doe.com]',
    summary: 'Approve a pending request, or give a contact rights towards you (meetings, capabilities it may invoke; the contact is told)',
    args: 1,
    options: {
      tier: { type: 'string' },
      'scope-file': { type: 'string' },
      invoke: { type: 'string', multiple: true },
      'no-meetings': { type: 'boolean' },
      label: { type: 'string' },
    },
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
  'contact label': {
    usage: 'rdv contact label <agent-id> <label>',
    summary: 'Name a contact locally (e.g. the address you know them by); sending by name uses this, never the addresses its card claims',
    args: 2,
    run: cmd.contactLabel,
  },
  'contact revoke': {
    usage: 'rdv contact revoke <agent-id>',
    summary: 'Revoke a contact',
    args: 1,
    run: cmd.contactRevoke,
  },
  'contact auto-approve': {
    usage: 'rdv contact auto-approve <agent-id|label> all [--until <time|duration>]   |   rdv contact auto-approve <agent-id|label> off',
    summary:
      "Let a trusted contact's tasks start and their results leave without asking you (\"dangerous mode\": shows a warning, needs your own terminal and your owner passphrase; audited). off turns it off at once",
    args: 2,
    options: { until: { type: 'string' } },
    run: cmd.contactAutoApprove,
  },
  'owner-secret set': {
    usage: 'rdv owner-secret set',
    summary: 'Set or change your owner passphrase, which turning auto-approve on asks for (your own terminal only; never shown, never an argument)',
    args: 0,
    run: cmd.ownerSecretSet,
  },
  'owner-secret reset': {
    usage: 'rdv owner-secret reset',
    summary: "Forgot your owner passphrase, or rdv whoami shows one you didn't set: turns auto-approve off for every contact, forgets it, offers a new one (your own terminal only; audited)",
    args: 0,
    run: cmd.ownerSecretReset,
  },
  'contact resync': {
    usage: 'rdv contact resync <agent-id>',
    summary: "Accept a contact's current chain after a fork or rollback was reported (check with them first)",
    args: 1,
    run: cmd.contactResync,
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
    usage: 'rdv dinner cancel <task-id> [--reason "…"] [--calendar cal.json]',
    summary:
      "Cancel a dinner: a pending negotiation (rdv/cancel, releases its tentative hold) or an agreed one (meeting/cancel: releases it in your calendar, and the peer's agent releases its own)",
    args: 1,
    options: { reason: { type: 'string' }, calendar: { type: 'string' } },
    run: cmd.dinnerCancel,
  },
  'dinner confirm': {
    usage: 'rdv dinner confirm <task-id> --hold <code> [--calendar cal.json]',
    summary:
      'Confirm the dinner a negotiation is holding for you (sends meeting/accept or meeting/confirm). --hold is the code "rdv dinner list" shows: it is refused if the meeting changed since',
    args: 1,
    options: { hold: { type: 'string' }, calendar: { type: 'string' } },
    run: cmd.dinnerConfirm,
  },
  'dinner list': { usage: 'rdv dinner list', summary: 'List dinner negotiations and their state', args: 0, run: cmd.dinnerList },
  'task request': {
    usage:
      'rdv task request <agent-id> --text "…" [--text …] [--capability <uri>] [--input \'{…}\'] [--expires <rfc3339>] [--file <sha256>=<https-url>]... [--inline <path>]...',
    summary: "Ask a contact's agent for a task (default: request/v1, a free-text request); its human approves it before anything is done",
    args: 1,
    options: {
      text: { type: 'string', multiple: true },
      capability: { type: 'string' },
      input: { type: 'string' },
      expires: { type: 'string' },
      file: { type: 'string', multiple: true },
      inline: { type: 'string', multiple: true },
    },
    run: cmd.taskRequest,
  },
  'task list': {
    usage: 'rdv task list',
    summary: 'List tasks, with the codes (and confirm phrases) for what waits for your approval',
    args: 0,
    run: cmd.taskList,
  },
  'task approve': {
    usage: 'rdv task approve <task-id> --code <code>',
    summary: 'Let your agent act on a peer\'s task (start gate). --code is the one "rdv task list" shows: refused if the task changed since',
    args: 1,
    options: { code: { type: 'string' } },
    run: cmd.taskApprove,
  },
  'task decline': {
    usage: 'rdv task decline <task-id>',
    summary: "Refuse a peer's task before it starts",
    args: 1,
    run: cmd.taskDecline,
  },
  'task submit': {
    usage: 'rdv task submit <task-id> [--text "…"]... [--file <sha256>=<https-url>]... [--inline <path>]... [--name "…"] [--complete]',
    summary: "Draft a result for a peer's task, with your files if any (rdv file prepare); it leaves only when you release it (rdv task release)",
    args: 1,
    options: {
      text: { type: 'string', multiple: true },
      file: { type: 'string', multiple: true },
      inline: { type: 'string', multiple: true },
      name: { type: 'string' },
      complete: { type: 'boolean' },
    },
    run: cmd.taskSubmit,
  },
  'task ask': {
    usage: 'rdv task ask <task-id> --text "…"',
    summary: 'Draft a question for the requester (input-required); it leaves only when you release it',
    args: 1,
    options: { text: { type: 'string' } },
    run: cmd.taskAsk,
  },
  'task finish': {
    usage: 'rdv task finish <task-id> [--failed] [--text "…"]',
    summary: 'End a started task (completed, or --failed); a message with it leaves only when you release it',
    args: 1,
    options: { failed: { type: 'boolean' }, text: { type: 'string' } },
    run: cmd.taskFinish,
  },
  'task release': {
    usage: 'rdv task release <task-id> --code <code>',
    summary: 'Send the result you reviewed (release gate). --code is the one "rdv task list" shows: refused if the result changed since',
    args: 1,
    options: { code: { type: 'string' } },
    run: cmd.taskRelease,
  },
  'task cancel': {
    usage: 'rdv task cancel <task-id> [--reason "…"]',
    summary: 'Withdraw a task you requested',
    args: 1,
    options: { reason: { type: 'string' } },
    run: cmd.taskCancel,
  },
  'task input': {
    usage: 'rdv task input <task-id> --text "…" [--input \'{…}\']',
    summary: "Answer the peer's question (input-required) on a task you requested",
    args: 1,
    options: { text: { type: 'string', multiple: true }, input: { type: 'string' } },
    run: cmd.taskInput,
  },
  'file prepare': {
    usage: 'rdv file prepare <path> [--name "…"] [--mime type/subtype] [--plain]',
    summary: 'Encrypt one of your files under a fresh key for a peer, and write the copy to upload anywhere (nothing is sent; --plain: not encrypted)',
    args: 1,
    options: { name: { type: 'string' }, mime: { type: 'string' }, plain: { type: 'boolean' } },
    run: cmd.filePrepare,
  },
  'file list': {
    usage: 'rdv file list',
    summary: 'List prepared files, files peers sent for your tasks (not fetched), direct-transfer requests and the setting',
    args: 0,
    run: cmd.fileList,
  },
  'file fetch': {
    usage: 'rdv file fetch <task-id> [--file <n|sha256>]',
    summary: 'Fetch one file a peer sent for a task (only after its start gate): https only, no credentials, size cap, hash checked; saved in quarantine',
    args: 1,
    options: { file: { type: 'string' } },
    run: cmd.fileFetch,
  },
  'file decline-transfer': {
    usage: 'rdv file decline-transfer <transfer-id>',
    summary: "Decline a contact's request to transfer a file directly",
    args: 1,
    run: cmd.fileDeclineTransfer,
  },
  'file direct-transfer': {
    usage: 'rdv file direct-transfer <on|off>',
    summary: 'Your setting for direct transfers (default off: declined). On: requests are shown to you; nothing ever connects on its own',
    args: 1,
    run: cmd.fileDirectTransfer,
  },
  listen: {
    usage:
      'rdv listen [--auto-grant <tier> [--auto-grant-any-tier]] [--exec <script>] [--negotiate --calendar cal.json [--window "next week evenings"] [--tz +02:00] [--auto-confirm]]',
    summary: 'Long-running: print events; optionally auto-grant (demo only), pipe events to a script, or negotiate dinner',
    args: 0,
    options: {
      'auto-grant': { type: 'string' },
      'auto-grant-any-tier': { type: 'boolean' },
      exec: { type: 'string' },
      negotiate: { type: 'boolean' },
      'auto-confirm': { type: 'boolean' },

      calendar: { type: 'string' },
      window: { type: 'string' },
      tz: { type: 'string' },
    },
    run: cmd.listenCmd,
  },
  audit: {
    usage: 'rdv audit [--contact <agent-id|label>] [--since <time|duration>]',
    summary: 'Show the audit log: gates passed without asking you (auto, notify, auto-approve), your approvals, and auto-approve changes',
    args: 0,
    options: { contact: { type: 'string' }, since: { type: 'string' } },
    run: cmd.audit,
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
