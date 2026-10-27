// Encrypted identity backup and restore in the hosts (issue #88, NOTES 91):
// `rdv backup <file>` / `rdv restore <file>` in the owner's terminal, and
// rdv-mcp's `rdv_backup`, whose passphrase is typed only into an approval
// form. Core (backup.ts) has the bundle format; this file has what goes in it
// and how it is written to and read from disk.
//
// In the bundle: the agent state (seed, card, contacts and grants, channels,
// groups; never open approvals, the outbox or the buffer), config.json, and
// the owner files a restore needs for the human's standing decisions to hold:
// owner-secret.json (the owner passphrase record, as stored: salt and scrypt
// hash, never the passphrase) and its marker, autoapprove.json (entries MACed
// with the agent key and bound to that record, so they verify after the
// restore exactly as before), owner.json and cards.json. Never consent.json
// (confirm phrases), tasks, negotiations, files, the inbox, events or audit.
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Agent,
  type Transport,
  type AgentState,
  type BackupFile,
  type BackupHeader,
  backupAgentState,
  BackupError,
  fingerprint,
  isAgentId,
  MAX_BACKUP_BYTES,
  parseTimestamp,
  openBackup,
  parseBackup,
  restoredAgentState,
  pendingInBackup,
  sealBackup,
  verifyCard,
} from '@rendezvous/core';
import { inAnyHome } from './files.js';
import { tryLongLock, writeAtomic } from './fsutil.js';
import { CliError, type Config, type Home } from './home.js';
import { markOwnerSecretRestored } from './ownersecret.js';

/** The home files that travel in a bundle besides agent.json and config.json, and their mode when written back. */
const BUNDLED: Record<string, number> = {
  'owner-secret.json': 0o600,
  'owner-secret.marker': 0o600,
  'autoapprove.json': 0o600,
  'owner.json': 0o600,
  'cards.json': 0o644,
};

export interface BundleContents {
  v: 1;
  agent: AgentState;
  config: Config;
  files: Record<string, string>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The bundle's contents for this home (inside the lock): see the file header for what is in it, and what never is. */
function bundleContents(home: Home): BundleContents {
  const files: Record<string, string> = {};
  for (const name of Object.keys(BUNDLED)) {
    const p = resolve(home.dir, name);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    try {
      JSON.parse(text);
    } catch {
      throw new CliError(`${p} is unreadable, so it cannot go into a backup; fix or remove it first`);
    }
    files[name] = text;
  }
  return { v: 1, agent: backupAgentState(home.readAgentState()), config: home.readConfig(), files };
}

/** Make the encrypted bundle of this home (the caller checked the passphrase's strength). */
export async function createBackup(home: Home, passphrase: string, now = new Date(), expectAgent?: string): Promise<BackupFile> {
  home.requireInit();
  const contents = await home.locked(async () => {
    const c = bundleContents(home);
    // The agent the human was shown (the MCP form), checked under the lock: another one is refused, not flagged.
    if (expectAgent !== undefined && c.agent.card.id !== expectAgent) throw new CliError('the agent in this home changed since it was shown; no backup was written');
    return c;
  });
  return sealBackup(contents.agent.card.id, passphrase, contents as unknown as BundleContents & { agent: AgentState } & Record<string, unknown>, { now });
}

/**
 * Write a bundle to `path`, which must not exist yet (never replaced, never
 * through a link: O_EXCL), mode 600, and not inside a Rendezvous home (a
 * backup on the same disk as the agent is no backup).
 */
export function writeBackupFile(home: Home, path: string, bundle: BackupFile): string {
  const abs = resolve(path);
  if (/[\u0000-\u001f\u007f]/.test(abs)) throw new CliError('the backup path holds control characters', 2);
  if (inAnyHome(home, abs)) throw new CliError(`refused: ${abs} is inside a Rendezvous home; keep the backup somewhere else (a password manager, a cloud drive, a USB stick)`);
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CliError(code === 'EEXIST' ? `${abs} already exists: choose a new file name (a backup never replaces a file)` : `cannot create ${abs} (${code ?? 'error'})`);
  }
  try {
    const data = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off, data.length - off);
  } finally {
    closeSync(fd);
  }
  return abs;
}

/**
 * Read a bundle file: opened once, never through a last-component symlink
 * (POSIX), a regular file of at most MAX_BACKUP_BYTES, not inside a
 * Rendezvous home. The bytes read are the bytes later decrypted, so what the
 * human approved (its header) is what is restored.
 */
export function readBackupFile(home: Home, path: string): { abs: string; bytes: Buffer; header: BackupHeader } {
  const abs = resolve(path);
  if (/[\u0000-\u001f\u007f]/.test(abs)) throw new CliError('the backup path holds control characters', 2);
  if (inAnyHome(home, abs)) throw new CliError(`refused: ${abs} is inside a Rendezvous home, which is not where a backup lives`);
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new CliError(`cannot open ${abs}`);
  }
  let bytes: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CliError(`not a regular file: ${abs}`);
    if (st.size > MAX_BACKUP_BYTES) throw new CliError(`${abs} is too large to be a Rendezvous backup`);
    bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < bytes.length) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== bytes.length) throw new CliError(`${abs} changed while it was read`);
  } finally {
    closeSync(fd);
  }
  let header: BackupHeader;
  try {
    const { ciphertext: _c, ...h } = parseBackup(new Uint8Array(bytes));
    header = h;
  } catch (err) {
    throw new CliError(err instanceof BackupError ? err.message : `${abs} is not a Rendezvous backup`);
  }
  return { abs, bytes, header };
}

/** What a restore shows before asking for the passphrase: the identity in the bundle's header (unconfirmed until it decrypts). */
export function describeBackup(header: BackupHeader, file?: string): string {
  return [
    ...(file ? [`  File:         ${file}`] : []),
    `  Agent ID:     ${header.agent}`,
    `  Fingerprint:  ${fingerprint(header.agent)}`,
    `  Backup made:  ${header.created}`,
  ].join('\n');
}

/** Strictly the contents a bundle of ours holds; anything else restores nothing. */
function checkContents(contents: Record<string, unknown>, agentId: string): BundleContents {
  const bad = (why: string) => new CliError(`the backup opened but is not usable (${why}); nothing was restored`);
  if (contents.v !== 1 || Object.keys(contents).sort().join(',') !== 'agent,config,files,v') throw bad('unknown layout');
  const agent = contents.agent as AgentState;
  if (!isObj(agent) || !isObj(agent.book) || !isObj(agent.channels) || !isObj(agent.card)) throw bad('agent state');
  const int = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!Object.values(agent.channels).every((ch) => isObj(ch) && int(ch.outSeq) && int(ch.inSeq))) throw bad('channels');
  if (agent.groups !== undefined && !(isObj(agent.groups) && isObj(agent.groups.groups))) throw bad('groups');
  if (!isObj(agent.book.contacts)) throw bad('contacts');
  const card = verifyCard(agent.card);
  if (!card.ok || card.card.id !== agentId) throw bad('its card is not signed by its key');
  const config = contents.config as Config;
  if (
    !isObj(config) ||
    typeof config.profile !== 'string' ||
    !Array.isArray(config.relays) ||
    config.relays.length === 0 ||
    !config.relays.every((r) => typeof r === 'string' && /^wss?:\/\/\S+$/.test(r)) ||
    !Array.isArray(config.addresses) ||
    !isObj(config.policy)
  ) {
    throw bad('config');
  }
  const files = contents.files;
  if (!isObj(files)) throw bad('files');
  for (const [name, text] of Object.entries(files)) {
    if (!Object.hasOwn(BUNDLED, name) || typeof text !== 'string') throw bad(`unexpected file ${JSON.stringify(name).slice(0, 80)}`);
    try {
      JSON.parse(text);
    } catch {
      throw bad(name);
    }
  }
  return { v: 1, agent, config, files: files as Record<string, string> };
}

/** The restored agent state, proven to load as an agent and save again; anything odd in it restores nothing. */
function loadableState(agent: AgentState, backupCreated: string, now: Date): AgentState {
  try {
    const state = restoredAgentState(agent, { backupCreated, now });
    const noop: Transport = { async sendEnvelope() {}, onEnvelopes: () => () => {}, async publishTopic() {}, onTopics: () => () => {}, fetchTopic: async () => [], close() {} };
    const a = Agent.fromJSON(state, () => noop);
    const again = JSON.parse(JSON.stringify(a.toJSON())) as AgentState;
    a.restoreStatus();
    a.close();
    if (again.card.id !== agent.card.id) throw new Error('key');
    return state;
  } catch {
    throw new CliError('the backup opened but its agent state is not usable; nothing was restored');
  }
}

export interface RestoreResult {
  id: string;
  fingerprint: string;
  backup_created: string;
  contacts: number;
  groups: number;
  /** Contacts on auto-approve again, as at backup time: shown to the human, who can turn any off. */
  auto_approve: string[];
  /** When the owner passphrase record in the backup was set (null: none). */
  owner_passphrase_set: string | null;
  /** Messages that were still waiting for a contact's receipt in the backup: they cannot be confirmed now (NOTES 98). */
  unconfirmed_before_backup: number;
  replaced?: string;
}

/**
 * Restore a bundle (its bytes, as read and shown) into `home`. Refused when
 * the home already holds an agent, unless `replace` (the human's explicit
 * flag, in their terminal); refused while another process listens for the
 * home. Writes the restored agent state (a new epoch per channel, each owing
 * its peer an `rdv/restored` notice) and the bundled files, after clearing
 * what the old home held, and audits it.
 */
export async function restoreBackup(home: Home, bytes: Uint8Array, passphrase: string, opts: { replace?: boolean; now?: Date; via?: 'cli' | 'mcp'; expectAgent?: string } = {}): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  let opened: Awaited<ReturnType<typeof openBackup>>;
  try {
    opened = await openBackup(new Uint8Array(bytes), passphrase);
  } catch (err) {
    if (err instanceof BackupError) throw new CliError(`${err.message}; nothing was restored`);
    throw err;
  }
  const { header } = opened;
  if (opts.expectAgent !== undefined && header.agent !== opts.expectAgent) throw new CliError('the backup is not the one that was shown; nothing was restored');
  const c = checkContents(opened.contents, header.agent);
  // The state to write, built and loaded once before anything on disk is touched: a bundle that decrypts but
  // does not make a working agent replaces nothing (review of #92).
  const state = loadableState(c.agent, header.created, now);
  home.ensureDir();
  const listener = tryLongLock(home.listenerLockPath, 'rdv restore');
  if (!listener.release) throw new CliError(`${listener.owner} is running for ${home.dir}: stop it first, then restore`);
  try {
    return await home.locked(async () => {
      let replaced: string | undefined;
      if (home.initialized()) {
        if (opts.replace !== true) {
          throw new CliError(`an agent already exists at ${home.dir}: restoring would replace it, and its key, for good (only you can do that, in your own terminal: rdv restore <file> --replace)`);
        }
        try {
          replaced = home.readAgentState().card.id;
        } catch {
          replaced = 'unreadable';
        }
      }
      // The new key first: the old agent.json becomes agent.json.bak, so until the new one is durable the old key
      // is still there; once it is, the backup copy is the new state too (the replaced key is gone for good).
      home.writeAgentState(state);
      home.writeAgentState(state);
      home.reset({ keepAgent: true });
      for (const name of Object.keys(BUNDLED)) rmSync(resolve(home.dir, name), { force: true });
      home.writeConfig(c.config);
      for (const [name, text] of Object.entries(c.files)) writeAtomic(resolve(home.dir, name), text.endsWith('\n') ? text : `${text}\n`, BUNDLED[name]);
      // The audit log does not travel: the marker keeps a later deleted passphrase file counting as a reset.
      markOwnerSecretRestored(home, now);
      let auto: string[] = [];
      try {
        auto = Object.keys(home.readAutoApprove());
      } catch {
        auto = [];
      }
      let ownerSet: string | null = null;
      try {
        const o = JSON.parse(c.files['owner-secret.json'] ?? 'null') as { set?: unknown; hash?: unknown } | null;
        ownerSet = o && typeof o.hash === 'string' && typeof o.set === 'string' && parseTimestamp(o.set) !== null ? o.set : null;
      } catch {
        ownerSet = null;
      }
      home.appendAudit([{ ts: now.toISOString(), peer: 'owner', gate: 'backup', by: 'human', action: 'restore', via: opts.via ?? 'cli' }]);
      return {
        id: header.agent,
        fingerprint: fingerprint(header.agent),
        backup_created: header.created,
        contacts: Object.keys(state.book.contacts ?? {}).length,
        groups: Object.keys(state.groups?.groups ?? {}).length,
        auto_approve: auto.filter((p) => isAgentId(p)).slice(0, 64),
        owner_passphrase_set: ownerSet,
        unconfirmed_before_backup: pendingInBackup(c.agent),
        ...(replaced ? { replaced } : {}),
      };
    });
  } finally {
    listener.release();
  }
}

/** Audit a backup the human made (inside nothing: it takes the lock). */
export async function auditBackup(home: Home, via: 'cli' | 'mcp', now = new Date()): Promise<void> {
  await home.locked(async () => home.appendAudit([{ ts: now.toISOString(), peer: 'owner', gate: 'backup', by: 'human', action: 'create', via }]));
}
