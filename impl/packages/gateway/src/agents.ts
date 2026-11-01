// The agents one gateway serves (NOTES 104). The gateway's root (`--home`,
// /data in the container) holds its own state (gateway.json: the owner's PIN
// and the tokens; gateway-oauth.json: the OAuth key, clients and grants;
// gateway-notify.json: the outbound webhooks, NOTES 106) and
// the agents:
//
//   <root>/                    the root agent, when the root is itself a home (every gateway before NOTES 104)
//   <root>/agents/<name>/      one normal rdv home per further agent
//   <root>/agents/.removed/    agents taken off the gateway, kept with their key (`agent remove`)
//   <root>/.premigrate-<time>/ the root agent's files after `agent migrate` copied them to agents/<name>/
//
// Nothing here moves a key on its own: `agent migrate` and `agent remove`
// are the owner's commands, refused while anything listens for that home,
// and both keep the old files instead of deleting them.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Home, tryLongLock } from '@rendezvous/cli/lib';
import { fingerprint } from '@rendezvous/core';

/** An agent's name: the URL segment (/a/<name>/mcp) and its folder. Lowercase, so it means one folder on every filesystem. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AGENTS_DIR = 'agents';
/**
 * What a token or grant of the root agent stores as its agent: a marker, never the root's name, which follows its
 * profile and so changes when a backup with another profile is restored over the root. A token or grant with no
 * agent at all (made before NOTES 104) means the same.
 */
export const ROOT_BINDING = ':root';
/** Whether a stored binding means the root agent. */
export const isRootBinding = (b: string | undefined): boolean => b === undefined || b === ROOT_BINDING;
/** The gateway's own files in its root: never an agent's, never migrated. */
export const GATEWAY_FILES = ['gateway.json', 'gateway.lock', 'gateway-oauth.json', 'gateway-oauth.lock', 'gateway-notify.json', 'gateway-notify.lock'];
/** A home's lock files: held by whoever runs, never copied. */
const LOCK_FILES = ['lock', 'listener.lock', 'events.lock'];
/** A gateway webhook secret in the root (notify.ts): the gateway's, never an agent's, so never migrated (rebind renames it). */
export const NOTIFY_SECRET_RE = /^notify-[a-z0-9_][a-z0-9_-]{0,31}\.secret(\.prev)?$/;

export class AgentError extends Error {}

export function checkAgentName(name: string): string {
  if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
    throw new AgentError(`invalid agent name ${JSON.stringify(name)}: 1 to 32 lowercase letters, digits, "-" or "_", starting with a letter or digit`);
  }
  return name;
}

export interface AgentEntry {
  name: string;
  home: Home;
  /** The root itself is this agent's home (a gateway from before NOTES 104, not migrated). */
  root: boolean;
}

export interface AgentIdentity extends AgentEntry {
  id: string;
  fingerprint: string;
}

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-');

export class AgentRoot {
  readonly home: Home;

  constructor(readonly dir: string) {
    this.home = new Home(dir);
  }

  get agentsDir(): string {
    return join(this.dir, AGENTS_DIR);
  }

  /** The folder an agent of this name lives in (under agents/). */
  homeFor(name: string): Home {
    return new Home(join(this.agentsDir, checkAgentName(name)));
  }

  /**
   * The root agent's name, when the root is itself a home: its profile,
   * lowercased, with anything a name cannot hold made "-"; "default" when
   * that is not a name.
   */
  rootAgentName(): string | undefined {
    if (!this.home.initialized()) return undefined;
    let profile = 'default';
    try {
      profile = String(this.home.readConfig().profile ?? 'default');
    } catch {
      // unreadable config: the agent is still there
    }
    const n = profile.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
    return AGENT_NAME_RE.test(n) ? n : 'default';
  }

  /** What a token or grant for this agent stores: the root marker for the root agent, else its name. */
  bindingOf(name: string): string {
    return name === this.rootAgentName() ? ROOT_BINDING : name;
  }

  /**
   * The agent a stored binding names now (the root marker: the root agent, if the root holds one). A binding that
   * is the root's current name is stale (root bindings store the marker; that name belonged to an agent since
   * removed), so it names nothing.
   */
  nameOf(binding: string | undefined): string | undefined {
    const rootName = this.rootAgentName();
    if (isRootBinding(binding)) return rootName;
    return binding === rootName ? undefined : binding;
  }

  /** Every agent here: the root agent first, then agents/<name>/ by name. Only folders that hold an agent count. */
  list(): AgentEntry[] {
    const out: AgentEntry[] = [];
    const rootName = this.rootAgentName();
    if (rootName) out.push({ name: rootName, home: this.home, root: true });
    let names: string[] = [];
    try {
      names = readdirSync(this.agentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && AGENT_NAME_RE.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const home = new Home(join(this.agentsDir, name));
      if (!home.initialized()) continue;
      if (name === rootName) {
        throw new AgentError(`two agents are named "${name}": the root home (${this.dir}) and ${home.dir}. Move one of them away (or finish "rdv-gateway agent migrate").`);
      }
      out.push({ name, home, root: false });
    }
    return out;
  }

  find(name: string): AgentEntry | undefined {
    return this.list().find((a) => a.name === name);
  }

  /**
   * Every agent with its identity. Two folders holding one identity would be
   * two agents receiving for one key (their channels fork), so that is refused.
   */
  identities(): AgentIdentity[] {
    const seen = new Map<string, string>();
    return this.list().map((a) => {
      const id = a.home.readAgentState().card.id;
      const other = seen.get(id);
      if (other !== undefined) {
        throw new AgentError(
          `agents "${other}" and "${a.name}" are the same identity (${fingerprint(id)}): only one may run. Remove one of them (rdv-gateway agent remove), or finish a migration.`,
        );
      }
      seen.set(id, a.name);
      return { ...a, id, fingerprint: fingerprint(id) };
    });
  }

  /** Is an agent with this identity here already (under any name)? */
  holdsIdentity(id: string): string | undefined {
    for (const a of this.list()) {
      try {
        if (a.home.readAgentState().card.id === id) return a.name;
      } catch {
        // unreadable: not this one
      }
    }
    return undefined;
  }

  /** A name a new agent may take: valid, and no agent, folder or root agent has it. */
  checkNewName(name: string): Home {
    const home = this.homeFor(name);
    if (this.rootAgentName() === name) throw new AgentError(`the root agent is named "${name}" already; pick another name`);
    if (existsSync(home.dir)) throw new AgentError(`${home.dir} exists already; pick another name (or remove that folder yourself)`);
    return home;
  }

  /**
   * `rdv-gateway agent remove`: take an agent off the gateway. Its folder
   * moves, whole and with its key, to agents/.removed/<name>-<time>/, never
   * deleted: the owner deletes it after a backup. Refused for the root agent
   * (its files are the root's; migrate it first) and while anything listens
   * for it.
   */
  remove(name: string, now = new Date()): { kept: string } {
    const a = this.find(checkAgentName(name));
    if (!a) throw new AgentError(`no agent "${name}" here (rdv-gateway agent list)`);
    if (a.root) throw new AgentError(`"${name}" is the root agent: its files are the gateway root's. Run "rdv-gateway agent migrate" first, then remove it`);
    const lock = tryLongLock(a.home.listenerLockPath, 'rdv-gateway agent remove');
    if (!lock.release) throw new AgentError(`${lock.owner} is running for ${a.home.dir}: stop the gateway (and any rdv listen for it) first`);
    const removed = join(this.agentsDir, '.removed');
    const kept = join(removed, `${name}-${stamp(now)}`);
    try {
      mkdirSync(removed, { recursive: true, mode: 0o700 });
      renameSync(a.home.dir, kept);
    } finally {
      lock.release();
    }
    rmSync(join(kept, 'listener.lock'), { force: true });
    return { kept };
  }

  /**
   * A migrate that stopped after moving the files and before the rebind (killed): the root holds no agent, and the
   * newest .premigrate-<time>/ that reads as an agent is the identity of exactly one agent under agents/. Returns the
   * old root name (`from`, for grant resources) and that agent's name (`to`), so `agent migrate` can finish the rebind.
   */
  interruptedMigrate(): { from: string; to: string; kept: string } | undefined {
    if (this.home.initialized()) return undefined;
    let kepts: string[] = [];
    try {
      kepts = readdirSync(this.dir).filter((f) => f.startsWith('.premigrate-')).sort().reverse();
    } catch {
      return undefined;
    }
    for (const k of kepts) {
      const old = new AgentRoot(join(this.dir, k));
      let id: string;
      try {
        id = old.home.readAgentState().card.id;
      } catch {
        continue;
      }
      const same = this.list().filter((a) => {
        try {
          return !a.root && a.home.readAgentState().card.id === id;
        } catch {
          return false;
        }
      });
      if (same.length === 1) return { from: old.rootAgentName() ?? 'default', to: same[0].name, kept: old.dir };
    }
    return undefined;
  }

  /**
   * `rdv-gateway agent migrate`: move the root agent into agents/<name>/, so
   * the root holds only the gateway's state. All or nothing: it plans the
   * file list first (the gateway's own files, locks, agents/, dot folders and
   * the webhook secrets stay: rebind renames those), checks every planned file
   * is there, copies them to a stage, checks the copy is the same agent (the
   * same key file, byte for byte), puts it in place, moves the originals into
   * .premigrate-<time>/ in the root (kept, not deleted), and only then calls
   * `rebind` (tokens, grants, webhooks to the new name). On any failure every
   * step is undone (`unbind` reverses a rebind that started) and one error
   * says so. Refused while anything listens for the root home; done under its
   * state lock.
   */
  async migrate(
    name: string | undefined,
    rebind: (from: string, to: string) => Promise<void>,
    now = new Date(),
    unbind?: (from: string, to: string) => Promise<void>,
  ): Promise<{ name: string; id: string; dir: string; kept: string; files: string[] }> {
    const from = this.rootAgentName();
    if (!from) throw new AgentError(`no agent in the root ${this.dir} to migrate`);
    const to = checkAgentName(name ?? from);
    const target = this.homeFor(to);
    if (existsSync(target.dir)) throw new AgentError(`${target.dir} exists already; pick another name with --name`);
    const lock = tryLongLock(this.home.listenerLockPath, 'rdv-gateway agent migrate');
    if (!lock.release) throw new AgentError(`${lock.owner} is running for ${this.dir}: stop the gateway (and any rdv listen or rdv-mcp for it) first`);
    try {
      return await this.home.locked(async () => {
        const id = this.home.readAgentState().card.id;
        const files = readdirSync(this.dir).filter(
          (f) => !GATEWAY_FILES.includes(f) && !LOCK_FILES.includes(f) && f !== AGENTS_DIR && !f.startsWith('.') && !NOTIFY_SECRET_RE.test(f),
        );
        if (!files.includes(basename(this.home.agentPath))) throw new AgentError(`no agent key file in ${this.dir}; nothing was moved`);
        const stage = join(this.agentsDir, `.${to}.migrating`);
        const kept = join(this.dir, `.premigrate-${stamp(now)}`);
        const moved: string[] = [];
        let placed = false;
        let bound = false;
        let madeAgents = false;
        const undo = async (): Promise<string[]> => {
          const left: string[] = [];
          const step = async (what: string, fn: () => unknown) => {
            try {
              await fn();
            } catch (err) {
              left.push(`${what}: ${(err as Error).message}`);
            }
          };
          if (bound && unbind) await step('tokens, grants and webhooks', () => unbind(from, to));
          // The originals go back first; only then is the copy removed.
          for (const f of [...moved].reverse()) await step(f, () => renameSync(join(kept, f), join(this.dir, f)));
          if (!left.length) {
            await step(kept, () => rmSync(kept, { recursive: true, force: true }));
            if (placed) await step(target.dir, () => rmSync(target.dir, { recursive: true, force: true }));
          }
          await step(stage, () => rmSync(stage, { recursive: true, force: true }));
          if (madeAgents && !left.length) await step(this.agentsDir, () => rmdirSync(this.agentsDir));
          return left;
        };
        try {
          const missing = files.filter((f) => !existsSync(join(this.dir, f)));
          if (missing.length) throw new Error(`${missing.join(', ')} went missing while planning`);
          madeAgents = !existsSync(this.agentsDir);
          mkdirSync(this.agentsDir, { recursive: true, mode: 0o700 });
          // A stage left by an earlier run that stopped is only ever a copy: the originals move last.
          rmSync(stage, { recursive: true, force: true });
          mkdirSync(stage, { mode: 0o700 });
          for (const f of files) cpSync(join(this.dir, f), join(stage, f), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          const copy = new Home(stage);
          if (!readFileSync(copy.agentPath).equals(readFileSync(this.home.agentPath)) || copy.readAgentState().card.id !== id) {
            throw new Error('the copy did not read back as the same agent');
          }
          renameSync(stage, target.dir);
          placed = true;
          mkdirSync(kept, { mode: 0o700 });
          for (const f of files) {
            renameSync(join(this.dir, f), join(kept, f));
            moved.push(f);
          }
          bound = true;
          await rebind(from, to);
          return { name: to, id, dir: target.dir, kept, files };
        } catch (err) {
          const left = await undo();
          throw new AgentError(
            left.length
              ? `agent migrate failed (${(err as Error).message}) and could not put everything back: ${left.join('; ')}. The originals that did not go back are in ${kept}; the copy is in ${target.dir}. Fix this by hand before starting the gateway.`
              : `agent migrate failed (${(err as Error).message}); everything was put back as it was`,
          );
        }
      });
    } finally {
      lock.release();
    }
  }
}
