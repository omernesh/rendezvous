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
//   rdv-gateway oauth list | oauth revoke <client-id|grant-id>   OAuth clients the owner connected on the page
//   rdv-gateway agent list | agent add <name> (new … | --restore <file>) | agent remove <name> [--force] | agent migrate [--name <n>]
//                                            the agents this gateway serves (NOTES 104): --home is the gateway's root
//
// Every command here is the owner's, in their own terminal: an assistant
// never runs them. Home resolution is the same as rdv and rdv-mcp.
// First: stdout carries the command's output, never a dependency's console text (review of PR #120).
import '@rendezvous/core/safe-console';
import { parseArgs } from 'node:util';
import { describeBackup, Home, initHome, readBackupFile, restoreBackup } from '@rendezvous/cli/lib';
import { AgentError, AgentRoot, checkAgentName } from './agents.js';
import { DEFAULT_PORT, Gateway } from './gateway.js';
import { SCOPE_TEXT, SCOPES } from './scopes.js';
import { OAuthStore, OAuthStoreError } from './oauth-store.js';
import { GatewayStore, StoreError } from './store.js';
import { fingerprint } from '@rendezvous/core';

const USAGE = `usage:
  rdv-gateway serve [--home <dir> | --profile <name>] [--port ${DEFAULT_PORT}] [--public-url https://rdv.example.com]
                    [--client-ip-header cf-connecting-ip] [--host 127.0.0.1] [--allow-remote-bind] [--calendar cal.json] [--calendar-dir <dir>]… [--window "next week evenings"] [--tz +02:00]
  rdv-gateway pin set [--home <dir>] [--stdin]   asks the current PIN first when one is set
  rdv-gateway pin unlock [--home <dir>]      clear the wait after wrong PINs
  rdv-gateway token create --name <name> --scope <scope,…> [--agent <name>] [--home <dir>]   --agent: which agent it reaches (needed with several)
  rdv-gateway token list [--home <dir>]
  rdv-gateway token revoke <id> [--home <dir>]
  rdv-gateway oauth list [--home <dir>]      OAuth clients (ChatGPT, claude.ai, …) and the grants you approved
  rdv-gateway oauth revoke <cli_…|grt_…> [--home <dir>]   a client and all its grants, or one grant
  rdv-gateway agent list [--home <dir>]      the agents this gateway serves (--home is the gateway's root)
  rdv-gateway agent add <name> new [--email <a>]… [--phone <p>]… [--relay <url>]… [--public-pointer]
  rdv-gateway agent add <name> --restore <backup-file> [--stdin]   a new agent under <root>/agents/<name>/
  rdv-gateway agent remove <name> [--force]  moves it to agents/.removed/ (key kept); --force also revokes its tokens and OAuth grants
  rdv-gateway agent migrate [--name <name>]  move the root's own agent into agents/<name>/ (gateway stopped; originals kept)
  serve --calendar <agent>=<file> (repeatable) when the gateway serves several agents
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
  const root = new AgentRoot(home.dir);
  const [cmd, sub, arg] = positionals;

  if (cmd === 'agent') return agentCommand(root, store, sub, arg);

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
    // Every new token reaches exactly one agent: the one named, or the only one.
    const agents = root.list();
    let agent = values.agent;
    if (agent === undefined) {
      if (agents.length > 1) die(`this gateway serves ${agents.length} agents (${agents.map((a) => a.name).join(', ')}): say which one the token reaches with --agent <name>`, 2);
      agent = agents[0]?.name;
      if (agent === undefined) die('no agent here yet: add one first (rdv-gateway agent add <name> new)', 2);
    } else if (!agents.some((a) => a.name === agent)) die(`no agent "${agent}" here (rdv-gateway agent list)`, 2);
    // The root agent is stored as the root marker, never its name (which follows its profile, NOTES 104).
    const { token, info } = await store.createToken(values.name!, values.scope!.split(',').map((s) => s.trim()).filter(Boolean), root.bindingOf(agent!));
    process.stderr.write(`Token ${info.id} ("${info.name}", agent ${agent}, scopes ${info.scopes.join(', ')}). It is shown once; give it only to the assistant you mean:\n`);
    process.stdout.write(`${token}\n`);
    return;
  }
  if (cmd === 'token' && sub === 'list') {
    for (const t of store.listTokens()) process.stdout.write(`${t.id}  ${t.name}  agent ${root.nameOf(t.agent) ?? '(none)'}  ${t.scopes.join(',')}  ${t.created}\n`);
    return;
  }
  if (cmd === 'token' && sub === 'revoke') {
    if (!arg) die('token revoke needs the token id (rdv-gateway token list)', 2);
    process.stderr.write((await store.revokeToken(arg!)) ? `revoked ${arg}\n` : `no token ${arg}\n`);
    return;
  }
  if (cmd === 'oauth' && sub === 'list') {
    const o = new OAuthStore(home).list();
    for (const c of o.clients) {
      const grants = o.grants.filter((g) => g.clientId === c.id);
      const hosts = c.redirectUris.map((u) => new URL(u).host).join(',');
      process.stdout.write(`${c.id}  ${JSON.stringify(c.name)}  returns to ${hosts}  registered ${c.created}${grants.length ? '' : c.approved ? '  (no grant left)' : '  (never approved)'}\n`);
      for (const g of grants) {
        process.stdout.write(`  ${g.id}  agent ${root.nameOf(g.agent) ?? '(none)'}  ${g.scopes.join(',')}  since ${g.created}  last refresh ${new Date(g.lastUsed).toISOString()}\n`);
      }
    }
    return;
  }
  if (cmd === 'oauth' && sub === 'revoke') {
    if (!arg || !/^(cli|grt)_/.test(arg)) die('oauth revoke needs a client id (cli_…) or a grant id (grt_…) from rdv-gateway oauth list', 2);
    const r = await new OAuthStore(home).revoke(arg!);
    process.stderr.write(
      r
        ? `revoked ${r.client ? `client ${r.client.id} (${JSON.stringify(r.client.name)}) and ` : ''}${r.grants.length} grant(s); a serving gateway refuses their tokens at once\n`
        : `no client or grant ${arg}\n`,
    );
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
      calendar: calendarOption(values.calendar ?? (process.env.RDV_CALENDAR ? [process.env.RDV_CALENDAR] : [])),
      calendarDirs: [...(values['calendar-dir'] ?? []), ...(process.env.RDV_CALENDAR_DIR ? [process.env.RDV_CALENDAR_DIR] : [])],
      window: values.window ?? process.env.RDV_WINDOW,
      tz: values.tz ?? process.env.RDV_TZ,
    });
    await gw.start();
    if (store.listTokens().length === 0 && !values['public-url'] && !process.env.RDV_GATEWAY_PUBLIC_URL) {
      process.stderr.write('[rdv-gateway] no API tokens yet: make one with "rdv-gateway token create --name … --scope read,send" (OAuth clients connect through --public-url)\n');
    }
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

/** --calendar: one file (a gateway of one agent), or <agent>=<file> per agent. */
function calendarOption(given: string[]): string | Record<string, string> | undefined {
  if (given.length === 0) return undefined;
  const named = given.filter((c) => /^[a-z0-9][a-z0-9_-]{0,31}=/.test(c));
  if (named.length === 0 && given.length === 1) return given[0];
  if (named.length !== given.length) die('--calendar: one file for a gateway of one agent, or <agent>=<file> for each agent', 2);
  const out: Record<string, string> = {};
  for (const c of named) {
    const i = c.indexOf('=');
    if (Object.hasOwn(out, c.slice(0, i))) die(`--calendar names ${c.slice(0, i)} twice`, 2);
    out[c.slice(0, i)] = c.slice(i + 1);
  }
  return out;
}

/** `rdv-gateway agent …`: the agents this gateway serves. The owner's, in their own terminal, like every command here. */
async function agentCommand(root: AgentRoot, store: GatewayStore, sub: string | undefined, name: string | undefined): Promise<void> {
  const oauth = new OAuthStore(root.home);
  const tokensOf = (n: string) => store.listTokens().filter((t) => root.nameOf(t.agent) === n);
  const grantsOf = (n: string) => oauth.list().grants.filter((g) => root.nameOf(g.agent) === n);
  /** Tokens and grants still bound to a name: `remove` and `add` refuse while there are any, unless --force revokes them. */
  const bound = (n: string, then: string): void => {
    const tokens = tokensOf(n);
    const grants = grantsOf(n);
    if ((tokens.length || grants.length) && !values.force) {
      die(
        `agent "${n}" still has ${tokens.length} token(s) (${tokens.map((t) => t.id).join(', ') || 'none'}) and ${grants.length} OAuth grant(s) (${grants.map((g) => g.id).join(', ') || 'none'}): ` +
          `revoke them first, or pass --force to revoke them ${then}; nothing changed`,
      );
    }
  };
  if (sub === 'list') {
    const agents = root.list();
    if (agents.length === 0) process.stderr.write(`no agent in ${root.dir} yet: rdv-gateway agent add <name> new\n`);
    for (const a of agents) {
      let who = 'unreadable';
      try {
        const id = a.home.readAgentState().card.id;
        who = `${id}  ${fingerprint(id)}`;
      } catch {
        // shown as unreadable
      }
      process.stdout.write(`${a.name}  ${who}  ${a.root ? '(the root home)' : a.home.dir}  tokens ${tokensOf(a.name).length}  oauth grants ${grantsOf(a.name).length}\n`);
    }
    return;
  }
  if (sub === 'add') {
    if (!name) die('agent add needs a name: rdv-gateway agent add <name> new | --restore <file>', 2);
    const restore = values.restore;
    const fresh = positionals[3] === 'new';
    if (fresh === (restore !== undefined)) die('agent add needs exactly one of "new" (a new identity) or --restore <backup-file>', 2);
    const home = root.checkNewName(checkAgentName(name!));
    // Tokens or grants left bound to this name (an agent of that name removed by hand) would reach the new agent.
    bound(name!, 'before the new agent takes the name');
    const t = await store.revokeAgent(name!);
    const g = await oauth.revokeAgent(name!);
    if (t.length || g.length) process.stderr.write(`Revoked ${t.length} token(s) and ${g.length} OAuth grant(s) left bound to "${name}".\n`);
    if (fresh) {
      const r = await initHome(home, { profile: name!, relays: values.relay, emails: values.email, phones: values.phone, publicPointer: values['public-pointer'] === true });
      process.stderr.write(`Added agent ${name} at ${home.dir}\nid:          ${r.id}\nfingerprint: ${r.fingerprint}\n`);
    } else {
      const { abs, bytes, header } = readBackupFile(home, restore!);
      // One identity, one agent: a second copy of an agent here would be two receivers for one key.
      const twin = root.holdsIdentity(header.agent);
      if (twin) die(`that backup is agent "${twin}", which this gateway serves already; nothing was restored`);
      if (!values.stdin) process.stderr.write(['', `Restore this agent as "${name}":`, describeBackup(header, abs), ''].join('\n') + '\n');
      const pass = await secretLine('Backup passphrase (not shown; Enter cancels): ');
      if (pass === '') die('canceled: nothing was restored');
      const r = await restoreBackup(home, bytes, pass, { via: 'cli', expectAgent: header.agent });
      process.stderr.write(`Restored ${r.id} (${r.fingerprint}) as agent ${name} at ${home.dir}: ${r.contacts} contact(s), ${r.groups} group(s). Its contacts are told when it starts.\n`);
    }
    process.stderr.write(
      [
        'Next, in your own terminal:',
        '  restart the gateway, so it serves the new agent (it reads its agents when it starts)',
        `  rdv-gateway token create --agent ${name} --name … --scope read,send   or connect an OAuth client and pick "${name}" on the consent page`,
        `  its MCP address: <public-url>/a/${name}/mcp (or /mcp with its own token)`,
        '',
      ].join('\n'),
    );
    return;
  }
  if (sub === 'remove') {
    if (!name) die('agent remove needs a name (rdv-gateway agent list)', 2);
    bound(name!, 'with it');
    const { kept } = root.remove(name!);
    const t = await store.revokeAgent(name!);
    const g = await oauth.revokeAgent(name!);
    process.stderr.write(
      `Removed agent ${name} from this gateway${t.length || g.length ? `, and revoked ${t.length} token(s) and ${g.length} OAuth grant(s)` : ''}.\n` +
        `Its folder, WITH ITS KEY, is now ${kept}. Back it up (rdv backup --home ${kept}) or keep it; delete it yourself only once you are sure.\n` +
        'Restart the gateway so it stops serving it.\n',
    );
    return;
  }
  if (sub === 'migrate') {
    const r = await root.migrate(values.name, async (from, to) => {
      await store.rebindAgent(from, to);
      await oauth.rebindAgent(from, to);
    });
    process.stderr.write(
      `Moved the root agent (${fingerprint(r.id)}) into ${r.dir} as "${r.name}"; its tokens and OAuth grants follow it.\n` +
        `The original files (${r.files.length}, the key among them) are kept in ${r.kept}: delete that folder yourself once the gateway runs well.\n`,
    );
    return;
  }
  die('agent: list, add, remove or migrate', 2);
}

main().catch((err) => die(err instanceof StoreError || err instanceof OAuthStoreError || err instanceof AgentError ? err.message : (err as Error).message));
