// The state directory (`--home`, default ~/.rendezvous/<profile>):
//   agent.json   Agent.toJSON(), holds the secret key (mode 600)
//   agent.json.bak  the previous good agent.json (mode 600), read if agent.json is torn
//   config.json  relays, addresses, policy
//   inbox.jsonl  received payloads, one JSON object per line
//   cards.json   cards found by `rdv lookup` (so `contact request <agent-id>` works)
//   negotiations.json  dinner negotiations (@rendezvous/a2a engine state)
//   consent.json  confirm phrases for pending requests (written by the MCP server)
//   events.jsonl  inbound events written by the home's one listener, plus rdv-mcp's own (behind rdv_inbox)
//   events.lock  held while appending to events.jsonl
//   lock         held while a command reads and writes state
//   listener.lock  held for its lifetime by the one inbound consumer (`rdv listen` or `rdv-mcp`)
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

/** A confirm phrase the MCP server issued for a pending request; only a human should ever see it. */
export interface ConsentEntry {
  phrase: string;
  created: string;
  attempts: number;
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
  get agentBackupPath() {
    return join(this.dir, 'agent.json.bak');
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
  get consentPath() {
    return join(this.dir, 'consent.json');
  }
  get lockPath() {
    return join(this.dir, 'lock');
  }
  get listenerLockPath() {
    return join(this.dir, 'listener.lock');
  }
  get eventsPath() {
    return join(this.dir, 'events.jsonl');
  }
  get eventsLockPath() {
    return join(this.dir, 'events.lock');
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

  /** agent.json, or its backup if agent.json is missing, empty or torn (the key must never be lost). */
  readAgentState(): AgentState {
    try {
      const s = readJson<AgentState>(this.agentPath);
      if (isAgentState(s)) return s;
    } catch (err) {
      if (!existsSync(this.agentBackupPath)) throw err;
    }
    const bak = readJson<AgentState>(this.agentBackupPath);
    if (!isAgentState(bak)) throw new CliError(`cannot read ${this.agentPath} or its backup`);
    process.stderr.write(`rdv: ${this.agentPath} was unreadable; using ${this.agentBackupPath}\n`);
    return bak;
  }

  /** Keep the current good state as agent.json.bak, then replace agent.json (both durable). */
  writeAgentState(state: AgentState): void {
    let prev: string | undefined;
    try {
      prev = readFileSync(this.agentPath, 'utf8');
    } catch {
      // first write
    }
    if (prev !== undefined) {
      let good = false;
      try {
        good = isAgentState(JSON.parse(prev));
      } catch {
        // torn: keep the old backup
      }
      if (good) writeAtomic(this.agentBackupPath, prev, 0o600);
    }
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

  readConsent(): Record<string, ConsentEntry> {
    return existsSync(this.consentPath) ? readJson(this.consentPath) : {};
  }

  writeConsent(consent: Record<string, ConsentEntry>): void {
    writeAtomic(this.consentPath, JSON.stringify(consent, null, 2) + '\n', 0o600);
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
    for (const p of [this.agentPath, this.agentBackupPath, this.configPath, this.inboxPath, this.cardsPath, this.negotiationsPath, this.consentPath, this.eventsPath]) {
      rmSync(p, { force: true });
    }
  }
}

function isAgentState(s: unknown): s is AgentState {
  const x = s as AgentState | null;
  return !!x && typeof x === 'object' && typeof x.secretKey === 'string' && !!x.card && !!x.book;
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
