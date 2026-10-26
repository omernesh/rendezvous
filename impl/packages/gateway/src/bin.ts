#!/usr/bin/env node
// rdv-gateway: your Rendezvous agent behind your own HTTPS endpoint, for
// cloud assistants. Run it on your own machine, behind your own tunnel.
//
//   rdv-gateway serve [--home <dir> | --profile <name>] [--port 8787] [--public-url https://…] [--host 127.0.0.1 --allow-remote-bind]
//                     [--calendar cal.json] [--calendar-dir <dir>]… [--window "…"] [--tz +02:00]
//   rdv-gateway pin set                      the approval page's PIN, in a terminal: the current one first, then the new one twice, never echoed
//                                            (--stdin: the same lines on stdin, current first when one is set)
//   rdv-gateway pin unlock                   clear the wait after wrong PINs
//   rdv-gateway token create --name <n> --scope read,send[,contact:request,negotiate]
//   rdv-gateway token list | token revoke <id>
//
// Every command here is the owner's, in their own terminal: an assistant
// never runs them. Home resolution is the same as rdv and rdv-mcp.
import { parseArgs } from 'node:util';
import { Home } from '@rendezvous/cli/lib';
import { DEFAULT_PORT, Gateway } from './gateway.js';
import { SCOPE_TEXT, SCOPES } from './scopes.js';
import { GatewayStore, StoreError } from './store.js';

const USAGE = `usage:
  rdv-gateway serve [--home <dir> | --profile <name>] [--port ${DEFAULT_PORT}] [--public-url https://rdv.example.com]
                    [--client-ip-header cf-connecting-ip] [--host 127.0.0.1] [--allow-remote-bind] [--calendar cal.json] [--calendar-dir <dir>]… [--window "next week evenings"] [--tz +02:00]
  rdv-gateway pin set [--home <dir>] [--stdin]   asks the current PIN first when one is set
  rdv-gateway pin unlock [--home <dir>]      clear the wait after wrong PINs
  rdv-gateway token create --name <name> --scope <scope,…> [--home <dir>]
  rdv-gateway token list [--home <dir>]
  rdv-gateway token revoke <id> [--home <dir>]
Scopes (none of them can approve anything; approvals happen only on the PIN-locked page):
${SCOPES.map((s) => `  ${s.padEnd(16)} ${SCOPE_TEXT[s]}`).join('\n')}
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    profile: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    'public-url': { type: 'string' },
    'allow-remote-bind': { type: 'boolean' },
    'client-ip-header': { type: 'string' },
    calendar: { type: 'string' },
    'calendar-dir': { type: 'string', multiple: true },
    window: { type: 'string' },
    tz: { type: 'string' },
    name: { type: 'string' },
    scope: { type: 'string' },
    stdin: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

const die = (msg: string, code = 1): never => {
  process.stderr.write(`rdv-gateway: ${msg}\n`);
  process.exit(code);
};

/** stdin's lines, for --stdin. */
let piped: Promise<string[]> | undefined;
const pipedLines = (): Promise<string[]> =>
  (piped ??= (async () => {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    return buf.split(/\r?\n/);
  })());

/** A line from the terminal without echo, or (only with --stdin) the next line of stdin. */
async function secretLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (values.stdin) return (await pipedLines()).shift() ?? '';
  if (!stdin.isTTY) die('this needs your own terminal (or --stdin, from a script you run yourself)');
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(s);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1);
        else s += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (values.help || positionals.length === 0) {
    process.stderr.write(USAGE);
    process.exit(positionals.length === 0 && !values.help ? 2 : 0);
  }
  const home = Home.resolve({ home: values.home, profile: values.profile });
  const store = new GatewayStore(home);
  const [cmd, sub, arg] = positionals;

  if (cmd === 'pin' && sub === 'set') {
    // Changing a PIN needs the current one, so whoever reaches this terminal can't take over the approval page.
    const current = store.hasPin() ? await secretLine('Current approval PIN: ') : undefined;
    const pin = await secretLine('New approval PIN (6 or more characters): ');
    if (!values.stdin && (await secretLine('Again: ')) !== pin) die('the two PINs differ; nothing changed');
    await store.changePin(current, pin, Date.now());
    process.stderr.write(`PIN set for ${home.dir}. A serving gateway uses it at once.\n`);
    return;
  }
  if (cmd === 'pin' && sub === 'unlock') {
    await store.clearLockout();
    process.stderr.write(`Wrong-PIN wait cleared for ${home.dir}. A serving gateway accepts the PIN again at once (a client's own wait ends within the hour, or on a restart).
`);
    return;
  }
  if (cmd === 'token' && sub === 'create') {
    if (!values.name) die('token create needs --name', 2);
    if (!values.scope) die(`token create needs --scope (${SCOPES.join(', ')})`, 2);
    const { token, info } = await store.createToken(values.name!, values.scope!.split(',').map((s) => s.trim()).filter(Boolean));
    process.stderr.write(`Token ${info.id} ("${info.name}", scopes ${info.scopes.join(', ')}). It is shown once; give it only to the assistant you mean:\n`);
    process.stdout.write(`${token}\n`);
    return;
  }
  if (cmd === 'token' && sub === 'list') {
    for (const t of store.listTokens()) process.stdout.write(`${t.id}  ${t.name}  ${t.scopes.join(',')}  ${t.created}\n`);
    return;
  }
  if (cmd === 'token' && sub === 'revoke') {
    if (!arg) die('token revoke needs the token id (rdv-gateway token list)', 2);
    process.stderr.write((await store.revokeToken(arg!)) ? `revoked ${arg}\n` : `no token ${arg}\n`);
    return;
  }
  if (cmd === 'serve') {
    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port is a port number', 2);
    const gw = new Gateway({
      home,
      host: values.host,
      port,
      allowRemoteBind: values['allow-remote-bind'] === true,
      clientIpHeader: values['client-ip-header'],
      publicUrl: values['public-url'] ?? process.env.RDV_GATEWAY_PUBLIC_URL,
      calendar: values.calendar ?? process.env.RDV_CALENDAR,
      calendarDirs: [...(values['calendar-dir'] ?? []), ...(process.env.RDV_CALENDAR_DIR ? [process.env.RDV_CALENDAR_DIR] : [])],
      window: values.window ?? process.env.RDV_WINDOW,
      tz: values.tz ?? process.env.RDV_TZ,
    });
    await gw.start();
    if (store.listTokens().length === 0) process.stderr.write('[rdv-gateway] no API tokens yet: make one with "rdv-gateway token create --name … --scope read,send"\n');
    const shutdown = async () => {
      await gw.close().catch(() => {});
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  die(`unknown command\n${USAGE}`, 2);
}

main().catch((err) => die(err instanceof StoreError ? err.message : (err as Error).message));
