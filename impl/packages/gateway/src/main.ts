// rdv-gateway (bin.js runs gatewayMain): your Rendezvous agent behind your own HTTPS endpoint, for
// cloud assistants. Run it on your own machine, behind your own tunnel.
//
//   rdv-gateway serve [--home <dir> | --profile <name>] [--port 8787] [--public-url https://…] [--host 127.0.0.1 --allow-remote-bind]
//                     [--calendar cal.json] [--calendar-dir <dir>]… [--window "…"] [--tz +02:00]
//   rdv-gateway pin set                      the approval page's PIN, in a terminal: the current one first, then the new one twice, never echoed
//                                            (--stdin: the same lines on stdin, current first when one is set; still only in your own terminal)
//   rdv-gateway pin unlock                   clear the wait after wrong PINs
//   rdv-gateway token create --name <n> --scope read,send[,contact:request,negotiate]
//   rdv-gateway token list | token revoke <id>
//   rdv-gateway oauth list | oauth revoke <client-id|grant-id>   OAuth clients the owner connected on the page
//   rdv-gateway agent list | agent add <name> (new … | --restore <file>) | agent remove <name> [--force] | agent migrate [--name <n>]
//                                            the agents this gateway serves (NOTES 104): --home is the gateway's root
//   rdv-gateway notify set <agent> --url <url> --secret-file <path> [--events a,b] [--allow-insecure-host <host>]…
//   rdv-gateway notify show [<agent>] | notify clear <agent> | notify dead-letter <agent> [--retry]
//                                            signed outbound webhooks per agent (NOTES 106)
//
// Every command here is the owner's, in their own terminal: an assistant
// never runs them. Those that change who or what reaches the agent (pin,
// token create/revoke, oauth revoke, agent add/remove/migrate, notify
// set/clear/dead-letter) refuse without an interactive terminal (issue #126).
// Home resolution is the same as rdv and rdv-mcp.
// First: stdout carries the command's output, never a dependency's console text (review of PR #120).
import '@rendezvous/core/safe-console';
import { describeBackup, Home, initHome, processIsInteractive, readBackupFile, readEvents, restoreBackup, terminalRefusal, tryLongLock } from '@rendezvous/cli/lib';
import { AgentError, AgentRoot, checkAgentName, isRootBinding, ROOT_BINDING } from './agents.js';
import { checkInsecureHost, checkNotifyUrl, DEFAULT_NOTIFY_EVENTS, NOTIFY_EVENTS, type NotifyEvent, NotifyError, NotifyStore, readSecretFile, receiverName, secretFileName } from './notify.js';
import { DEFAULT_PORT, Gateway } from './gateway.js';
import { gatewayHumanOnly, type GatewayValues, parseGatewayArgs } from './args.js';
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
  rdv-gateway agent migrate --resume <name>  finish a migrate that stopped before its tokens, grants and webhook followed it
  serve --calendar <agent>=<file> (repeatable) when the gateway serves several agents
  rdv-gateway notify set <agent> --url https://… --secret-file <path> [--events a,b] [--allow-insecure-host <host>]…
                                             POST a signed event when it happens (default events: ${DEFAULT_NOTIFY_EVENTS.join(', ')})
  rdv-gateway notify show [<agent>]          the webhook settings, and how many events wait or are dead letters
  rdv-gateway notify clear <agent>           stop: its settings, secret and waiting events go (dead letters stay)
  rdv-gateway notify dead-letter <agent> [--retry]   events given up on; --retry queues them again (same ids)
  notify events: ${NOTIFY_EVENTS.join(', ')}
Scopes (none of them can approve anything; approvals happen only on the PIN-locked page):
${SCOPES.map((s) => `  ${s.padEnd(16)} ${SCOPE_TEXT[s]}`).join('\n')}
`;

// One command per process: set once, by gatewayMain.
let values: GatewayValues;
let positionals: string[];

export interface GatewayMainOptions {
  /**
   * Is this an interactive terminal (issue #126)? Default: stdin and stdout are both a TTY. An in-process seam for
   * tests only: bin.js never passes it, and no flag, environment variable or file sets it.
   */
  interactive?: () => boolean;
}

/** rdv-gateway with these arguments (bin.js: process.argv.slice(2)). */
export async function gatewayMain(argv: string[], opts: GatewayMainOptions = {}): Promise<void> {
  try {
    ({ values, positionals } = parseGatewayArgs(argv));
  } catch (err) {
    die(`${(err as Error).message}\n${USAGE}`, 2);
  }
  const [cmd, sub] = positionals;
  // Refused before the home is resolved or anything is read or written.
  if (!values.help && gatewayHumanOnly(cmd, sub) && !(opts.interactive ?? processIsInteractive)()) {
    die(terminalRefusal(`rdv-gateway ${cmd} ${sub}`, undefined), 1);
  }
  await main().catch((err) =>
    die(err instanceof StoreError || err instanceof OAuthStoreError || err instanceof AgentError || err instanceof NotifyError ? err.message : (err as Error).message),
  );
}

const die = (msg: string, code = 1): never => {
  process.stderr.write(`rdv-gateway: ${msg}\n`);
  process.exit(code);
};

/** --stdin reads piped lines; on a terminal it would echo the secret, so there the hidden prompt is used (issue #126). */
const pipedStdin = (): boolean => values.stdin === true && process.stdin.isTTY !== true;

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
  if (pipedStdin()) return (await pipedLines()).shift() ?? '';
  if (!stdin.isTTY) die('this needs your own terminal');
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
  if (cmd === 'notify') return notifyCommand(root, sub, arg);

  if (cmd === 'pin' && sub === 'set') {
    // Changing a PIN needs the current one, so whoever reaches this terminal can't take over the approval page.
    const current = store.hasPin() ? await secretLine('Current approval PIN: ') : undefined;
    const pin = await secretLine('New approval PIN (6 or more characters): ');
    if (!pipedStdin() && (await secretLine('Again: ')) !== pin) die('the two PINs differ; nothing changed');
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
    // Every new token records the identity it is for; one that cannot be read gets no token.
    let agentId: string | undefined;
    try {
      agentId = root.find(agent!)?.home.readAgentState().card.id;
    } catch (err) {
      die(`agent ${agent}'s state cannot be read (${(err as Error).message}); no token was made`);
    }
    if (!agentId) die(`agent ${agent}'s identity cannot be read; no token was made`);
    const { token, info } = await store.createToken(values.name!, values.scope!.split(',').map((s) => s.trim()).filter(Boolean), root.bindingOf(agent!), agentId);
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
  const notify = new NotifyStore(root.home);
  const tokensOf = (n: string) => store.listTokens().filter((t) => root.nameOf(t.agent) === n);
  const grantsOf = (n: string) => oauth.list().grants.filter((g) => root.nameOf(g.agent) === n);
  /**
   * Tokens and grants that store this name: `remove`, `add` and `migrate --name` refuse while there are any, unless
   * --force revokes them. Root bindings store the marker, so for a new name these can only be stale.
   */
  const bound = (n: string, then: string): void => {
    const tokens = store.listTokens().filter((t) => t.agent === n);
    const grants = oauth.list().grants.filter((g) => g.agent === n);
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
    // Webhook settings left under this name would carry the new agent's events to the old one's receiver.
    if ((await notify.clear(name!, { dead: true })).had) process.stderr.write(`Cleared the webhook settings left under "${name}".\n`);
    if (fresh) {
      const r = await initHome(home, { profile: name!, relays: values.relay, emails: values.email, phones: values.phone, publicPointer: values['public-pointer'] === true });
      process.stderr.write(`Added agent ${name} at ${home.dir}\nid:          ${r.id}\nfingerprint: ${r.fingerprint}\n`);
    } else {
      const { abs, bytes, header } = readBackupFile(home, restore!);
      // One identity, one agent: a second copy of an agent here would be two receivers for one key.
      const twin = root.holdsIdentity(header.agent);
      if (twin) die(`that backup is agent "${twin}", which this gateway serves already; nothing was restored`);
      if (!pipedStdin()) process.stderr.write(['', `Restore this agent as "${name}":`, describeBackup(header, abs), ''].join('\n') + '\n');
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
    if ((await notify.clear(name!, { dead: true })).had) process.stderr.write('Cleared its webhook settings (rdv-gateway notify).\n');
    process.stderr.write(
      `Removed agent ${name} from this gateway${t.length || g.length ? `, and revoked ${t.length} token(s) and ${g.length} OAuth grant(s)` : ''}.\n` +
        `Its folder, WITH ITS KEY, is now ${kept}. Back it up (rdv backup --home ${kept}) or keep it; delete it yourself only once you are sure.\n` +
        'Restart the gateway so it stops serving it.\n',
    );
    return;
  }
  if (sub === 'migrate') {
    // Everything still bound to the root agent: tokens, OAuth grants, its webhook. Each records the identity it was
    // made for (older ones only their time), so a migrate or a resume moves only what belongs to that identity.
    const rootBound = () => [
      ...store.listTokens().filter((t) => isRootBinding(t.agent)).map((t) => ({ what: `token ${t.id}`, created: t.created, agentId: t.agentId })),
      ...oauth.list().grants.filter((g) => isRootBinding(g.agent)).map((g) => ({ what: `OAuth grant ${g.id}`, created: g.created, agentId: g.agentId })),
      ...(notify.config(ROOT_BINDING) ? [{ what: 'the webhook', created: notify.config(ROOT_BINDING)!.created, agentId: notify.config(ROOT_BINDING)!.agentId }] : []),
    ];
    const rebindAll = async (from: string, to: string) => {
      await store.rebindAgent(from, to);
      await oauth.rebindAgent(from, to);
      await notify.rebind(ROOT_BINDING, to);
    };
    const pending = root.newestPremigrate();
    // A migrate killed between moving the files and the rebind left the bindings on a root with no agent. Never
    // finished on its own: the owner names the agent, and only the newest kept folder counts (narrow review of PR #131).
    if (values.resume === undefined && pending && rootBound().length) {
      const holders = pending.id ? root.holdersOf(pending.id) : [];
      die(
        `an earlier migrate stopped before its tokens, grants or webhook (${rootBound().length}) followed the agent it moved (originals kept in ${pending.dir}). ` +
          `Check which agent that is (rdv-gateway agent list), then run: rdv-gateway agent migrate --resume ${holders.length === 1 ? holders[0] : '<name>'}`,
      );
    }
    if (values.resume !== undefined) {
      const name = checkAgentName(values.resume);
      if (!pending) die('nothing to resume: the root holds an agent, or no .premigrate-* folder is there');
      if (!pending!.id) die(`the newest kept folder ${pending!.dir} does not read as an agent; nothing to resume`);
      const target = root.find(name);
      let targetId: string | undefined;
      try {
        targetId = target && !target.root ? target.home.readAgentState().card.id : undefined;
      } catch {
        targetId = undefined;
      }
      if (targetId !== pending!.id) die(`agents/${name} is not the agent the newest migrate moved (${fingerprint(pending!.id!)}); nothing changed`);
      const holders = root.holdersOf(pending!.id!);
      if (holders.length !== 1) die(`${holders.length} agents hold that identity (${holders.join(', ')}); remove the extra ones first; nothing changed`);
      const bound = rootBound();
      if (!bound.length) die('nothing to resume: no token, grant or webhook is bound to the root agent');
      // What could not have belonged to that migrate: another identity's, or (recording no identity) made after it.
      // The root holds no agent now, so a legacy binding with no kept folder after it belongs to nobody known.
      const why = (x: { agentId?: string; created: string }): string | undefined => {
        if (x.agentId !== undefined) return x.agentId === pending!.id ? undefined : 'another identity';
        const r = root.legacyRootIdentity(x.created, undefined);
        if (r.unknown) return `made ${x.created}; the kept folder after it cannot be read`;
        if (r.id === undefined) return `made ${x.created}, after that migrate`;
        return r.id === pending!.id ? undefined : `made ${x.created}, before an earlier migrate of another agent`;
      };
      const foreign = bound.filter((x) => why(x) !== undefined);
      if (foreign.length) {
        die(
          `refused: ${foreign.map((x) => `${x.what} (${why(x)})`).join(', ')} cannot belong to the agent that migrate moved. ` +
            'Revoke or clear them (rdv-gateway token revoke, oauth revoke, notify clear), then resume; nothing changed',
        );
      }
      // Like migrate itself: never while the gateway (or anything else) listens for that agent.
      const lock = tryLongLock(target!.home.listenerLockPath, 'rdv-gateway agent migrate --resume');
      if (!lock.release) die(`${lock.owner} is running for ${target!.home.dir}: stop the gateway (and any rdv listen or rdv-mcp for it) first; nothing changed`);
      try {
        await rebindAll(pending!.from, name);
      } finally {
        lock.release!();
      }
      process.stderr.write(`Finished the migrate that stopped halfway: ${bound.map((x) => x.what).join(', ')} now reach agent "${name}" (originals kept in ${pending!.dir}).\n`);
      return;
    }
    // A plain migrate moves only what belongs to the root agent's identity.
    let rootId: string | undefined;
    try {
      rootId = root.home.readAgentState().card.id;
    } catch {
      rootId = undefined;
    }
    // A legacy binding (no identity) made no later than an earlier migrate of another identity is that agent's, not this one's.
    const others = rootBound().filter((x) => {
      if (x.agentId !== undefined) return rootId !== undefined && x.agentId !== rootId;
      const r = root.legacyRootIdentity(x.created, rootId);
      return r.unknown === true || r.id !== rootId;
    });
    if (others.length) die(`refused: ${others.map((x) => x.what).join(', ')} were made for another identity than the root agent's; revoke or clear them first; nothing changed`);
    const to = values.name ?? root.rootAgentName();
    if (to !== undefined) {
      // Stale bindings to the new name would reach the root agent once it takes that name.
      bound(to, 'before the root agent takes the name');
      if (root.find(to)?.root === false) die(`agent "${to}" exists already; pick another name with --name`);
      const t = await store.revokeAgent(to);
      const g = await oauth.revokeAgent(to);
      if (t.length || g.length) process.stderr.write(`Revoked ${t.length} token(s) and ${g.length} OAuth grant(s) left bound to "${to}".\n`);
      await notify.clear(to, { dead: true });
    }
    const r = await root.migrate(
      values.name,
      rebindAll,
      new Date(),
      // A failure after the rebind started puts every binding back on the root agent.
      async (from, to) => {
        await store.unbindAgent(to);
        await oauth.unbindAgent(from, to);
        await notify.rebind(to, ROOT_BINDING);
      },
    );
    process.stderr.write(
      `Moved the root agent (${fingerprint(r.id)}) into ${r.dir} as "${r.name}"; its tokens and OAuth grants follow it.\n` +
        `The original files (${r.files.length}, the key among them) are kept in ${r.kept}: delete that folder yourself once the gateway runs well.\n`,
    );
    return;
  }
  die('agent: list, add, remove or migrate', 2);
}

/**
 * `rdv-gateway notify …`: signed outbound webhooks per agent (NOTES 106). The owner's, like every command here: the
 * consent guard keeps an assistant from running set, clear and dead-letter.
 */
async function notifyCommand(root: AgentRoot, sub: string | undefined, name: string | undefined): Promise<void> {
  const notify = new NotifyStore(root.home);
  const agentNamed = (n: string | undefined) => {
    if (!n) die(`notify ${sub} needs the agent's name (rdv-gateway agent list)`, 2);
    const a = root.find(n!);
    if (!a) die(`no agent "${n}" here (rdv-gateway agent list)`, 2);
    return a!;
  };
  /** The agent's identity now: dead letters count, show and retry only for it. */
  const identity = (a: { home: Home }) => {
    try {
      return a.home.readAgentState().card.id;
    } catch {
      return '';
    }
  };
  if (sub === 'set') {
    const a = agentNamed(name);
    if (!values.url) die('notify set needs --url https://…', 2);
    if (!values['secret-file']) die('notify set needs --secret-file <path> (a file only you can read: openssl rand -hex 32 > notify.secret; chmod 600 notify.secret)', 2);
    const insecureHosts = [...new Set((values['allow-insecure-host'] ?? []).map(checkInsecureHost))];
    const url = checkNotifyUrl(values.url!, insecureHosts);
    const events = values.events === undefined ? [...DEFAULT_NOTIFY_EVENTS] : [...new Set(values.events.split(',').map((e) => e.trim()).filter(Boolean))];
    const bad = events.filter((e) => !(NOTIFY_EVENTS as readonly string[]).includes(e));
    if (bad.length || events.length === 0) die(`--events: one or more of ${NOTIFY_EVENTS.join(', ')}${bad.length ? ` (not ${bad.join(', ')})` : ''}`, 2);
    // Copied into the gateway root under a fixed name (the consent guard protects it there); the file given may go.
    const secret = readSecretFile(values['secret-file']!);
    const ev = readEvents(a.home);
    const b = root.bindingOf(a.name);
    const cfg = await notify.set(b, { url, events: events as NotifyEvent[], insecureHosts }, secret, ev.length ? ev[ev.length - 1].n : 0, new Date(), identity(a) || undefined);
    process.stderr.write(
      `Agent ${a.name} now posts ${cfg.events.join(', ')} to ${receiverName(url)}, signed with the secret now kept in ${secretFileName(b)} in the gateway root` +
        `${cfg.previousUntil ? ` (the previous secret signs too until ${cfg.previousUntil})` : ''}.\n` +
        'A serving gateway picks this up within seconds; only events from now on are sent. Check it with: rdv-gateway notify show\n',
    );
    return;
  }
  if (sub === 'show') {
    const d = notify.read();
    const agents = name ? [agentNamed(name)] : root.list();
    for (const a of agents) {
      const b = root.bindingOf(a.name);
      const id = identity(a);
      const cfg = Object.hasOwn(d.agents, b) ? d.agents[b] : undefined;
      const waiting = d.outbox.filter((i) => i.agent === b && i.agentId === id).length;
      const dead = d.dead.filter((i) => i.agent === b && i.agentId === id).length;
      if (!cfg) {
        process.stdout.write(`${a.name}  (no webhook)${dead ? `  dead letters ${dead}` : ''}\n`);
        continue;
      }
      // Scheme and host only: a path or query may hold the receiver's own token.
      process.stdout.write(
        `${a.name}  ${receiverName(cfg.url)}  events ${cfg.events.join(',')}${cfg.insecureHosts.length ? `  insecure hosts ${cfg.insecureHosts.join(',')}` : ''}  since ${cfg.created}  waiting ${waiting}  dead letters ${dead}\n`,
      );
    }
    return;
  }
  if (sub === 'clear') {
    const a = agentNamed(name);
    const r = await notify.clear(root.bindingOf(a.name));
    process.stderr.write(r.had ? `Agent ${a.name} posts nothing now${r.dropped ? ` (${r.dropped} waiting event(s) dropped)` : ''}; its secret file is deleted.\n` : `agent ${a.name} had no webhook\n`);
    return;
  }
  if (sub === 'dead-letter') {
    const a = agentNamed(name);
    const b = root.bindingOf(a.name);
    const id = identity(a);
    if (values.retry) {
      const r = await notify.retryDead(b, id);
      process.stderr.write(
        `${r.queued} event(s) of agent ${a.name} queued again, with the same ids; a serving gateway sends them within seconds.\n` +
          (r.refused ? `${r.refused} dead letter(s) of an earlier agent under that name were not queued.\n` : ''),
      );
      return;
    }
    const dead = notify.deadLetters(b, id);
    if (!dead.length) process.stderr.write(`no dead letters for agent ${a.name}\n`);
    for (const x of dead) process.stdout.write(`${x.id}  ${x.event}  ${x.deadAt}  tries ${x.attempts}  ${x.reason}\n`);
    return;
  }
  die('notify: set, show, clear or dead-letter', 2);
}
