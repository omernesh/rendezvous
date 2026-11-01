// The agents one gateway serves (NOTES 104). The gateway's root (`--home`,
// /data in the container) holds its own state (gateway.json: the owner's PIN
// and the tokens; gateway-oauth.json: the OAuth key, clients and grants) and
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Home, tryLongLock } from '@rendezvous/cli/lib';
import { fingerprint } from '@rendezvous/core';

/** An agent's name: the URL segment (/a/<name>/mcp) and its folder. Lowercase, so it means one folder on every filesystem. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const AGENTS_DIR = 'agents';
/** The gateway's own files in its root: never an agent's, never migrated. */
export const GATEWAY_FILES = ['gateway.json', 'gateway.lock', 'gateway-oauth.json', 'gateway-oauth.lock'];
/** A home's lock files: held by whoever runs, never copied. */
const LOCK_FILES = ['lock', 'listener.lock', 'events.lock'];

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
   * `rdv-gateway agent migrate`: move the root agent into agents/<name>/, so
   * the root holds only the gateway's state. Copy first, check the copy is
   * the same agent (the same agent.json, byte for byte), put it in place,
   * then move the originals into .premigrate-<time>/ in the root (kept, not
   * deleted). Refused while anything listens for the root home; done under
   * its state lock. `rebind` moves tokens and grants to the new name once the
   * copy is in place.
   */
  async migrate(name: string | undefined, rebind: (from: string, to: string) => Promise<void>, now = new Date()): Promise<{ name: string; id: string; dir: string; kept: string; files: string[] }> {
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
        const files = readdirSync(this.dir).filter((f) => !GATEWAY_FILES.includes(f) && !LOCK_FILES.includes(f) && f !== AGENTS_DIR && !f.startsWith('.'));
        mkdirSync(this.agentsDir, { recursive: true, mode: 0o700 });
        // A stage left by an earlier run that stopped is only ever a copy: the originals move last.
        const stage = join(this.agentsDir, `.${to}.migrating`);
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { mode: 0o700 });
        for (const f of files) cpSync(join(this.dir, f), join(stage, f), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        const copy = new Home(stage);
        if (!readFileSync(copy.agentPath).equals(readFileSync(this.home.agentPath)) || copy.readAgentState().card.id !== id) {
          rmSync(stage, { recursive: true, force: true });
          throw new AgentError('the copy did not read back as the same agent; nothing was moved');
        }
        renameSync(stage, target.dir);
        await rebind(from, to);
        const kept = join(this.dir, `.premigrate-${stamp(now)}`);
        mkdirSync(kept, { mode: 0o700 });
        for (const f of files) renameSync(join(this.dir, f), join(kept, f));
        return { name: to, id, dir: target.dir, kept, files };
      });
    } finally {
      lock.release();
    }
  }
}
