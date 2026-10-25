// The state directory (`--home`, default ~/.rendezvous/<profile>):
//   agent.json   Agent.toJSON(), holds the secret key (mode 600)
//   config.json  relays, addresses, policy
//   inbox.jsonl  received payloads, one JSON object per line
//   cards.json   cards found by `rdv lookup` (so `contact request <agent-id>` works)
//   negotiations.json  dinner negotiations (@rendezvous/a2a engine state)
//   lock         held while a command reads and writes state
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptyState, type NegotiationState } from '@rendezvous/a2a';
import type { AddressCard, AgentState, DiscoveryAddress, InboundPolicy, Payload } from '@rendezvous/core';
import { acquireLock, writeAtomic } from './fsutil.js';

export interface Config {
  profile: string;
  relays: string[];
  addresses: DiscoveryAddress[];
  policy: { inbound: InboundPolicy; public: boolean };
  public_pointer: boolean;
}

export interface InboxEntry {
  ts: string;
  from: string;
  seq: number;
  payload: Payload;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export class Home {
  constructor(readonly dir: string) {}

  static resolve(opts: { home?: string; profile?: string }): Home {
    if (opts.home) return new Home(resolve(opts.home));
    if (process.env.RDV_HOME) return new Home(resolve(process.env.RDV_HOME));
    const profile = opts.profile ?? process.env.RDV_PROFILE ?? 'default';
    if (!PROFILE_RE.test(profile)) throw new CliError(`invalid profile name "${profile}"`, 2);
    return new Home(join(homedir(), '.rendezvous', profile));
  }

  get agentPath() {
    return join(this.dir, 'agent.json');
  }
  get configPath() {
    return join(this.dir, 'config.json');
  }
  get inboxPath() {
    return join(this.dir, 'inbox.jsonl');
  }
  get cardsPath() {
    return join(this.dir, 'cards.json');
  }
  get negotiationsPath() {
    return join(this.dir, 'negotiations.json');
  }
  get lockPath() {
    return join(this.dir, 'lock');
  }

  initialized(): boolean {
    return existsSync(this.agentPath);
  }

  requireInit(): void {
    if (!this.initialized()) throw new CliError(`no agent at ${this.dir} (run "rdv init" first, or pass --home/--profile)`);
  }

  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Run `fn` holding the state lock. */
  async locked<T>(fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
    this.ensureDir();
    const release = await acquireLock(this.lockPath, opts);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  readAgentState(): AgentState {
    return readJson<AgentState>(this.agentPath);
  }

  writeAgentState(state: AgentState): void {
    writeAtomic(this.agentPath, JSON.stringify(state, null, 2) + '\n', 0o600);
  }

  readConfig(): Config {
    return readJson<Config>(this.configPath);
  }

  writeConfig(config: Config): void {
    writeAtomic(this.configPath, JSON.stringify(config, null, 2) + '\n', 0o644);
  }

  readCards(): Record<string, AddressCard> {
    return existsSync(this.cardsPath) ? readJson(this.cardsPath) : {};
  }

  writeCards(cards: Record<string, AddressCard>): void {
    writeAtomic(this.cardsPath, JSON.stringify(cards, null, 2) + '\n', 0o644);
  }

  readNegotiations(): NegotiationState {
    if (!existsSync(this.negotiationsPath)) return emptyState();
    const s = readJson<NegotiationState>(this.negotiationsPath);
    if (s?.v !== 1 || typeof s.tasks !== 'object' || s.tasks === null) throw new CliError(`unrecognized ${this.negotiationsPath}`);
    return s;
  }

  writeNegotiations(state: NegotiationState): void {
    writeAtomic(this.negotiationsPath, JSON.stringify(state, null, 2) + '\n', 0o600);
  }

  appendInbox(entry: InboxEntry): void {
    appendFileSync(this.inboxPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  readInbox(): InboxEntry[] {
    if (!existsSync(this.inboxPath)) return [];
    return parseJsonLines(readFileSync(this.inboxPath, 'utf8'));
  }

  /** `rdv init --force`: drop everything derived from the old key. */
  reset(): void {
    for (const p of [this.agentPath, this.configPath, this.inboxPath, this.cardsPath, this.negotiationsPath]) rmSync(p, { force: true });
  }
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${(err as Error).message}`);
  }
}

export function parseJsonLines<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // a torn last line from a crash; skip it
    }
  }
  return out;
}
