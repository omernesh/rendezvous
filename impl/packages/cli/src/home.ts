// The state directory (`--home`, default ~/.rendezvous/<profile>):
//   agent.json   Agent.toJSON(), holds the secret key (mode 600)
//   agent.json.bak  the previous good agent.json (mode 600), read if agent.json is torn
//   config.json  relays, addresses (public and private), policy
//   inbox.jsonl  received payloads, one JSON object per line
//   cards.json   cards found by `rdv lookup` (so `contact request <agent-id>` works)
//   negotiations.json  dinner negotiations (@rendezvous/a2a engine state)
//   tasks.json   general tasks (tasks/v1 engine state) and results waiting for release (mode 600)
//   audit.jsonl  gates passed without asking the human (an `auto` start, a `notify`, auto-approve), every approval,
//                and every auto-approve set/extend/off (bounded)
//   owner.json   owner-only settings (direct transfer), MACed with the agent key; never written by the assistant (consent guard)
//   files.json   files the owner prepared to send (key, upload copy, source path) and direct-transfer requests (mode 600)
//   files/       outgoing/: upload copies (ciphertext); incoming/<task>/: fetched peer files, quarantined (mode 600)
//   autoapprove.json  contacts our human put on auto-approve (issue #25; mode 600, MACed with the agent key, local only)
//   owner-secret.json  the owner passphrase that turns auto-approve on (issue #47; scrypt hash and failure count, mode 600)
//   consent.json  confirm phrases for pending requests and meetings (written by the MCP server)
//   holds.json   which calendar file holds each dinner hold, tentative or agreed (to release or finalize it)
//   relays.json  per-relay diagnostics and cooldowns (last OK, last error), written after each publish
//   events.jsonl  inbound events written by the home's one listener, plus rdv-mcp's own (behind rdv_inbox)
//   events.lock  held while appending to events.jsonl
//   lock         held while a command reads and writes state
//   listener.lock  held for its lifetime by the one inbound consumer (`rdv listen` or `rdv-mcp`)
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { emptyState, emptyTaskState, type FilePart, type NegotiationState, type TaskEngineState, type TaskPart } from '@rendezvous/a2a';
import type { AddressCard, AgentState, DiscoveryAddress, FileEnc, GrantScope, InboundPolicy, Payload, RelayStatus, Tier, TransferState } from '@rendezvous/core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { acquireLock, writeAtomic } from './fsutil.js';
import { stable } from './hash.js';

/**
 * One of our addresses. A public one (no `private`) is listed on the card and
 * opens its probe topic (SPEC §4.3); a private one is kept here only, for the
 * owner's own reference, and nobody can find the agent by it.
 */
export interface ConfigAddress extends DiscoveryAddress {
  private?: true;
}

export interface Config {
  profile: string;
  /** The relays we listen on: envelopes and our card go there (keep it small). */
  relays: string[];
  /**
   * Discovery mirrors (NOTES 81): our card only, for lookups and `rdv card
   * publish --mirror`. Absent until the owner changes it: then the default
   * set applies (mirrorRelaysOf).
   */
  mirror_relays?: string[];
  /** All our addresses; the card lists the public ones, in this order. */
  addresses: ConfigAddress[];
  policy: { inbound: InboundPolicy; public: boolean };
  public_pointer: boolean;
}

/**
 * owner.json: settings only the owner changes, kept out of config.json (which
 * the assistant may read and, through file tools, write). The plugin's consent
 * guard refuses any tool access to the file, and it is MACed with the agent's
 * secret key (as autoapprove.json), so a file written by anything that cannot
 * read agent.json is ignored: the settings stay at their defaults.
 */
export interface OwnerSettings {
  /**
   * Direct transfers (SPEC §7.7, `rdv/transfer`): off (absent) by default.
   * Off, a peer's request for one is declined at once; on, it is shown to the
   * owner, who decides. Nothing ever connects on its own.
   */
  direct_transfer?: boolean;
}

export interface InboxEntry {
  ts: string;
  from: string;
  seq: number;
  payload: Payload;
}

/**
 * What a confirm phrase approves: a contact request, a probe answer, a held
 * dinner, canceling an agreed one, or granting an existing contact rights
 * towards us (`inbound`, issue #1: a reverse grant).
 */
export type ConsentAction = 'request' | 'candidate' | 'meeting' | 'cancel' | 'inbound' | 'task-start' | 'task-release' | 'relays';

/**
 * One of the owner's files in a draft, as the release gate shows it: what
 * leaves (name, size, the hash of the bytes the peer fetches, where it is
 * stored) and where it was read from. `source` is local only, never sent.
 */
export interface FileNote {
  sha256: string;
  size: number;
  name?: string;
  mimeType?: string;
  source: string;
  uri?: string;
  encrypted: boolean;
  inline?: true;
}

/**
 * What our side wants to send for a peer's task, held until our human
 * releases it (the release gate, SPEC §5.5): exactly the arguments the engine
 * is called with again once released.
 */
export type ReleaseContent =
  | {
      kind: 'artifact';
      artifact: { artifactId: string; name?: string; description?: string; parts: TaskPart[]; append?: boolean; lastChunk?: boolean };
      /** Also end the task `completed` once the artifact has left. */
      complete?: boolean;
      /** The owner's files among its parts, as the human is shown them (covered by the release digest). */
      files?: FileNote[];
    }
  | { kind: 'question'; text?: string; data?: Record<string, unknown> }
  | { kind: 'finish'; outcome: 'completed' | 'failed'; text?: string; data?: Record<string, unknown> };

export interface PendingRelease {
  taskId: string;
  peer: string;
  content: ReleaseContent;
  created: string;
}

/** tasks.json: the tasks engine's state and, per task, at most one draft waiting for release. */
export interface TaskHostState {
  v: 1;
  engine: TaskEngineState;
  releases: Record<string, PendingRelease>;
  /**
   * File parts the executor sent in artifacts for tasks we requested, by task
   * ID, so the owner's agent can fetch them later (never on arrival). Pruned
   * with their task.
   */
  received?: Record<string, { peer: string; files: FilePart[] }>;
  /**
   * Requests of ours that carry the owner's files, by hold ID, held for the
   * release gate (issue #53): nothing leaves until the human releases exactly
   * what they were shown.
   */
  requests?: Record<string, HeldRequest>;
}

/** A task request with the owner's files, waiting for the human's release: exactly the arguments requestTask gets once released. */
export interface HeldRequest {
  /** The hold's own ID (not the task's: the engine picks that when it is sent). */
  id: string;
  peer: string;
  capability: string;
  text?: string[];
  input?: unknown;
  expires?: string;
  /** The file parts as they will leave. */
  files: FilePart[];
  /** Each file as the human is shown it: name, size, hash, source, URL (covered by the digest). */
  notes: FileNote[];
  created: string;
}

/** A file the owner prepared to send (`rdv file prepare`): encrypted under a fresh key unless sent plain. */
export interface OutgoingFile {
  /** SHA-256 of the bytes a peer fetches (the ciphertext when encrypted). */
  sha256: string;
  size: number;
  name?: string;
  mimeType?: string;
  /** Where the owner's file was read from: shown at the release gate, never sent. */
  source: string;
  /** The copy to upload wherever the owner likes (under files/outgoing/). */
  upload: string;
  /** Key, nonce and plaintext hash. The key leaves only inside an envelope. */
  enc?: FileEnc;
  plain_sha256: string;
  created: string;
}

/** A peer's request to transfer one of our files directly (`rdv/transfer`). */
export interface TransferRecord {
  peer: string;
  state: TransferState;
  created: string;
  updated: string;
}

/** files.json. */
export interface FilesState {
  v: 1;
  outgoing: Record<string, OutgoingFile>;
  transfers: Record<string, TransferRecord>;
}

/**
 * Why auto-approve for a contact ended (issue #25). `owner`: our human turned
 * it off. `owner-secret`: the owner passphrase it was set under was changed,
 * reset or deleted, or none is set.
 */
export type AutoApproveOff = 'owner' | 'expired' | 'revoked' | 'blocked' | 'grant-changed' | 'fork' | 'invalid' | 'owner-secret';

/** One line of audit.jsonl. Never peer text: IDs, URIs, digests and hashes only. */
export interface AuditEntry {
  ts: string;
  peer: string;
  /** Gate lines: the task's capability and ID. */
  capability?: string;
  task?: string;
  /** A gate (start, release, notify), a change to the contact's auto-approve setting, or to the owner passphrase (peer `owner`). */
  gate: 'start' | 'release' | 'notify' | 'auto-approve' | 'owner-secret';
  /** Who let it pass: the grant (class `auto`/`notify`), the human (form, phrase, terminal), or the human's standing auto-approve. */
  by: 'grant' | 'human' | 'auto-approve';
  approval?: string;
  digest?: string;
  /** Release lines: SHA-256 and size of each payload that left (ours, never the peer's). */
  sent?: Array<{ sha256: string; bytes: number }>;
  /** gate `auto-approve`: what changed (`set`, `extend`, `off`); gate `owner-secret`: `set`, `changed` or `reset`. */
  action?: 'set' | 'extend' | 'off' | 'changed' | 'reset';
  /** gate `auto-approve`, action `off`: why. */
  reason?: AutoApproveOff;
  /** gate `auto-approve`, set/extend: the expiry (null: until turned off) and the capabilities it covered then. */
  until?: string | null;
  capabilities?: string[];
}

/** One contact on auto-approve (autoapprove.json). Bound to the grant it was set on; `mac` keys it to this agent. */
export interface AutoApproveEntry {
  v: 1;
  peer: string;
  mode: 'all';
  /** When our human set (or last extended) it. */
  set: string;
  /** Expiry, or null: until turned off. */
  until: string | null;
  /** The contact's grant and inbound scope when it was set: another grant (revoked and re-made, widened) ends it. */
  grantId: string;
  since: string;
  scope: string;
  /** The owner passphrase record it was set under (ownerSecretBinding): another passphrase, or none, ends it. */
  owner: string;
  mac: string;
}

/**
 * `consent.json` key: IDs are peer-chosen and may collide across actions, so
 * every phrase lives under its action (security review of issue #8).
 */
export const consentKey = (action: ConsentAction, id: string): string => `${action}:${id}`;

/** A salted scrypt hash of a confirm phrase (consent.ts); the phrase itself is never stored. */
export interface ConsentHash {
  salt: string;
  hash: string;
  /** What the phrase was issued for; part of the hash input. */
  digest?: string;
}

/** The tier and scope a request (or inbound) phrase approves, as shown to the human. */
export interface ConsentTerms {
  tier: Tier;
  scope: GrantScope;
}

/** A confirm phrase the MCP server issued for one action (hashed); only a human ever sees the phrase. */
export interface ConsentEntry extends ConsentHash {
  /** The only action this phrase approves. */
  action: ConsentAction;
  /**
   * The digest of what the human was shown: the meeting (meetingDigest), the
   * probe answer (candidateDigest), or the request or contact with its
   * terms (termsDigest). The phrase approves that only.
   */
  digest?: string;
  /** request: the request itself, without the terms (requestSubject); inbound: the contact (inboundSubject). */
  subject?: string;
  /** request, inbound: the tier and scope this phrase approves. */
  terms?: ConsentTerms;
  /** request, candidate: the local label it approves for the contact (none if absent; part of `digest`). */
  label?: string;
  /** The phrase this one replaced, so a stale phrase is reported as such. */
  previous?: ConsentHash;
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

/** One relay's answer to a publish that failed everywhere: its text is the relay's, not ours. */
export interface RelayFailure {
  url: string;
  kind: string;
  message: string;
}

/**
 * A publish no relay took. The message is ours alone (it may reach a model);
 * the relays' own text is in `relays`, for the terminal to print and the MCP
 * server to quarantine (untrusted_peer_text).
 */
export class RelayPublishError extends CliError {
  constructor(
    message: string,
    readonly relays: RelayFailure[],
  ) {
    super(message, 1);
  }

  /** For the human's terminal: the message, then each relay's reason. */
  detailed(clean: (s: string) => string): string {
    return [this.message, ...this.relays.map((r) => `  ${clean(r.url)}: ${r.kind}: ${clean(r.message)}`)].join('\n');
  }
}

/** Lines audit.jsonl keeps after compaction. */
export const AUDIT_KEPT = 1000;

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
  get tasksPath() {
    return join(this.dir, 'tasks.json');
  }
  get ownerPath() {
    return join(this.dir, 'owner.json');
  }

  /**
   * The owner's settings, verified with the agent's secret key. A file that is
   * missing, unreadable or not MACed by this key gives the defaults (all off);
   * `forged` says the file was there but did not verify (warn the human).
   */
  readOwner(secretKey: Uint8Array): OwnerSettings & { forged?: true } {
    if (!existsSync(this.ownerPath)) return {};
    let s: { v?: unknown; direct_transfer?: unknown; mac?: unknown };
    try {
      s = JSON.parse(readFileSync(this.ownerPath, 'utf8'));
    } catch {
      return { forged: true };
    }
    if (typeof s !== 'object' || s === null || s.v !== 1 || typeof s.mac !== 'string' || !/^[0-9a-f]{64}$/.test(s.mac)) return { forged: true };
    const body: OwnerSettings = s.direct_transfer === true ? { direct_transfer: true } : {};
    const want = Buffer.from(ownerMac(secretKey, body), 'hex');
    if (!timingSafeEqual(Buffer.from(s.mac, 'hex'), want) || (s.direct_transfer !== undefined && s.direct_transfer !== true)) return { forged: true };
    return body;
  }

  writeOwner(s: OwnerSettings, secretKey: Uint8Array): void {
    const body: OwnerSettings = s.direct_transfer === true ? { direct_transfer: true } : {};
    writeAtomic(this.ownerPath, JSON.stringify({ v: 1, ...body, mac: ownerMac(secretKey, body) }, null, 2) + '\n', 0o600);
  }

  get filesPath() {
    return join(this.dir, 'files.json');
  }

  /** Upload copies (outgoing/) and quarantined downloads (incoming/). */
  get filesDir() {
    return join(this.dir, 'files');
  }

  get auditPath() {
    return join(this.dir, 'audit.jsonl');
  }

  get autoApprovePath() {
    return join(this.dir, 'autoapprove.json');
  }
  /** The owner passphrase (issue #47): a scrypt hash and the failure count, mode 600. */
  get ownerSecretPath() {
    return join(this.dir, 'owner-secret.json');
  }
  /** That an owner passphrase was set here once, MACed with the agent key: a deleted owner-secret.json then counts as a reset. */
  get ownerSecretMarkerPath() {
    return join(this.dir, 'owner-secret.marker');
  }
  get holdsPath() {
    return join(this.dir, 'holds.json');
  }
  get relaysPath() {
    return join(this.dir, 'relays.json');
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

  readTasks(): TaskHostState {
    if (!existsSync(this.tasksPath)) return { v: 1, engine: emptyTaskState(), releases: {} };
    const s = readJson<TaskHostState>(this.tasksPath);
    const ok = (o: unknown) => typeof o === 'object' && o !== null && !Array.isArray(o);
    if (s?.v !== 1 || !ok(s.engine) || s.engine.v !== 1 || !ok(s.engine.tasks) || !ok(s.releases) || (s.received !== undefined && !ok(s.received)) || (s.requests !== undefined && !ok(s.requests))) {
      throw new CliError(`unrecognized ${this.tasksPath}`);
    }
    s.engine.dropped ??= {};
    return s;
  }

  readFiles(): FilesState {
    if (!existsSync(this.filesPath)) return { v: 1, outgoing: {}, transfers: {} };
    const s = readJson<FilesState>(this.filesPath);
    const ok = (o: unknown) => typeof o === 'object' && o !== null && !Array.isArray(o);
    if (s?.v !== 1 || !ok(s.outgoing) || !ok(s.transfers)) throw new CliError(`unrecognized ${this.filesPath}`);
    return s;
  }

  writeFiles(state: FilesState): void {
    writeAtomic(this.filesPath, JSON.stringify(state, null, 2) + '\n', 0o600);
  }

  writeTasks(state: TaskHostState): void {
    writeAtomic(this.tasksPath, JSON.stringify(state, null, 2) + '\n', 0o600);
  }

  /** Append to audit.jsonl, keeping its last AUDIT_KEPT lines (compacted at twice that). */
  appendAudit(entries: AuditEntry[]): void {
    if (entries.length === 0) return;
    const text = existsSync(this.auditPath) ? readFileSync(this.auditPath, 'utf8') : '';
    const lines = text.split('\n').filter((l) => l.trim());
    const add = entries.map((e) => JSON.stringify(e));
    if (lines.length + add.length > 2 * AUDIT_KEPT) {
      writeAtomic(this.auditPath, [...lines, ...add].slice(-AUDIT_KEPT).join('\n') + '\n', 0o600);
    } else {
      // A crash can leave a torn last line: start on a fresh one so ours stays readable.
      const sep = text && !text.endsWith('\n') ? '\n' : '';
      appendFileSync(this.auditPath, sep + add.join('\n') + '\n', { mode: 0o600 });
    }
  }

  readAudit(): AuditEntry[] {
    if (!existsSync(this.auditPath)) return [];
    return parseJsonLines(readFileSync(this.auditPath, 'utf8'));
  }

  /** Contacts on auto-approve. Unreadable fails closed: nobody is (the caller reports it). */
  readAutoApprove(): Record<string, AutoApproveEntry> {
    if (!existsSync(this.autoApprovePath)) return {};
    const s = readJson<unknown>(this.autoApprovePath);
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new CliError(`unrecognized ${this.autoApprovePath}`);
    return s as Record<string, AutoApproveEntry>;
  }

  writeAutoApprove(entries: Record<string, AutoApproveEntry>): void {
    if (Object.keys(entries).length === 0) rmSync(this.autoApprovePath, { force: true });
    else writeAtomic(this.autoApprovePath, JSON.stringify(entries, null, 2) + '\n', 0o600);
  }

  readConsent(): Record<string, ConsentEntry> {
    return existsSync(this.consentPath) ? readJson(this.consentPath) : {};
  }

  writeConsent(consent: Record<string, ConsentEntry>): void {
    writeAtomic(this.consentPath, JSON.stringify(consent, null, 2) + '\n', 0o600);
  }

  /** Task ID → calendar file of its hold (tentative or agreed). */
  readHolds(): Record<string, string> {
    return existsSync(this.holdsPath) ? readJson(this.holdsPath) : {};
  }

  writeHolds(holds: Record<string, string>): void {
    writeAtomic(this.holdsPath, JSON.stringify(holds, null, 2) + '\n', 0o600);
  }

  appendInbox(entry: InboxEntry): void {
    appendFileSync(this.inboxPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  readInbox(): InboxEntry[] {
    if (!existsSync(this.inboxPath)) return [];
    return parseJsonLines(readFileSync(this.inboxPath, 'utf8'));
  }

  /** Relay diagnostics saved by earlier processes; empty when missing or unreadable (they are diagnostics only). */
  readRelayStatus(): RelayStatus[] {
    try {
      const s = JSON.parse(readFileSync(this.relaysPath, 'utf8')) as unknown;
      return Array.isArray(s) ? s.filter((x): x is RelayStatus => !!x && typeof (x as RelayStatus).url === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Merge `status` into relays.json: per relay, the newer record wins (another
   * process, e.g. the listener, may have published since). Never throws: a
   * lost diagnostic must not fail a send.
   */
  saveRelayStatus(status: RelayStatus[]): void {
    const stamp = (r: RelayStatus) => Math.max(Date.parse(r.last_ok ?? '') || 0, Date.parse(r.last_error?.at ?? '') || 0);
    try {
      const merged = new Map(this.readRelayStatus().map((r) => [r.url, r]));
      for (const r of status) {
        const old = merged.get(r.url);
        if (!old || stamp(r) >= stamp(old)) merged.set(r.url, r);
      }
      writeAtomic(this.relaysPath, JSON.stringify([...merged.values()].slice(-64), null, 2) + '\n', 0o644);
    } catch {
      // diagnostics only
    }
  }

  /** `rdv init --force`: drop everything derived from the old key. */
  reset(): void {
    for (const p of [
      this.agentPath,
      this.agentBackupPath,
      this.configPath,
      this.inboxPath,
      this.cardsPath,
      this.negotiationsPath,
      this.tasksPath,
      this.ownerPath,
      this.filesPath, // keys of files prepared under the old identity; downloads in files/ are kept
      this.auditPath,
      this.autoApprovePath,
      this.consentPath,
      this.eventsPath,
      this.holdsPath,
      this.relaysPath, // bans and cooldowns were earned by the old key's carrier pubkey
    ]) {

      rmSync(p, { force: true });
    }
  }
}

function ownerMac(secretKey: Uint8Array, body: OwnerSettings): string {
  return createHmac('sha256', secretKey).update(`rdv1/owner-settings\0${stable({ v: 1, ...body })}`).digest('hex');
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
