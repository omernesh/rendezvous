// Encrypted identity backup (issue #88, NOTES 91): a bundle that holds an
// agent's seed and the state it needs to go on, under the owner's passphrase.
//
// Format (JSON, strict): a header and the ciphertext.
//
//   { "format": "rdv-backup", "v": 1, "agent": "rdv1:…", "created": "<RFC 3339>",
//     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64, 16 bytes>" },
//     "cipher": { "name": "aes-256-gcm", "nonce": "<b64, 12 bytes>" },
//     "ciphertext": "<b64>" }
//
// key = scrypt(NFC("rdv1/backup\0" ‖ passphrase), salt, N, r, p, 32 bytes).
// AES-256-GCM with the canonical JSON of the header (everything but
// `ciphertext`) as associated data, so the format, version, agent ID, time and
// KDF parameters cannot be changed without the decryption failing. The
// plaintext is the canonical JSON of what the host put in (its own shape); its
// `agent.secretKey` must be the key of `agent` in the header.
//
// The header is in the clear on purpose: the restore form shows the agent ID
// and fingerprint before anything is decrypted. It is confirmed only by the
// decryption (the AD), and the secret key inside must match it.
import { scrypt as scryptCb } from 'node:crypto';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { AgentState } from './agent.js';
import { b64decode, b64encode, canonicalBytes, canonicalize, parseTimestamp } from './encoding.js';
import { isAgentId, keyFromSecret } from './identity.js';

export const BACKUP_FORMAT = 'rdv-backup';
export const BACKUP_VERSION = 1;
/** scrypt cost for new bundles: 2^17 (128 MiB, about a second). A bundle may end up in cloud storage. */
export const BACKUP_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
/** The costs a bundle may name: never weaker than new bundles, and never so high that opening one exhausts memory. */
const N_MIN = 2 ** 17;
const N_MAX = 2 ** 18;
/** Largest bundle we read (text). Agent state without outbox or buffer is far smaller. */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
export const BACKUP_PASSPHRASE_MAX = 1024;

export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  v: typeof BACKUP_VERSION;
  /** The agent ID whose seed is inside. Shown before decrypting; confirmed by the AD and the key. */
  agent: string;
  created: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; nonce: string };
}

export interface BackupFile extends BackupHeader {
  ciphertext: string;
}

/** Thrown for a bundle that is not one, is damaged, or does not open with the passphrase. Its message holds nothing secret. */
export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: 'malformed' | 'unsupported' | 'decrypt' | 'mismatch',
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64Bytes(v: unknown, len?: number): Uint8Array | null {
  if (typeof v !== 'string' || !B64.test(v) || v.length % 4 !== 0) return null;
  try {
    const b = b64decode(v);
    return len === undefined || b.length === len ? b : null;
  } catch {
    return null;
  }
}

/**
 * The bundle's header, checked strictly (exact keys, known format, bounded KDF
 * costs), from parsed JSON or text. Throws BackupError. Reads nothing secret.
 */
export function parseBackup(input: unknown): BackupFile {
  let doc = input;
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (text.length > MAX_BACKUP_BYTES) throw new BackupError('the backup file is too large', 'malformed');
    try {
      doc = JSON.parse(text);
    } catch {
      throw new BackupError('not a Rendezvous backup file (not JSON)', 'malformed');
    }
  }
  if (!isObj(doc) || doc.format !== BACKUP_FORMAT) throw new BackupError('not a Rendezvous backup file', 'malformed');
  if (doc.v !== BACKUP_VERSION) throw new BackupError(`unsupported backup version ${JSON.stringify(doc.v)} (this rdv reads version ${BACKUP_VERSION})`, 'unsupported');
  if (!exactKeys(doc, ['format', 'v', 'agent', 'created', 'kdf', 'cipher', 'ciphertext'])) throw new BackupError('malformed backup file (unexpected fields)', 'malformed');
  if (!isAgentId(doc.agent)) throw new BackupError('malformed backup file (agent ID)', 'malformed');
  if (parseTimestamp(doc.created) === null) throw new BackupError('malformed backup file (created)', 'malformed');
  const kdf = doc.kdf;
  if (!isObj(kdf) || !exactKeys(kdf, ['name', 'N', 'r', 'p', 'salt']) || kdf.name !== 'scrypt') throw new BackupError('unsupported backup key derivation', 'unsupported');
  const N = kdf.N;
  if (typeof N !== 'number' || !Number.isSafeInteger(N) || N < N_MIN || N > N_MAX || (N & (N - 1)) !== 0 || kdf.r !== 8 || kdf.p !== 1) {
    throw new BackupError('unsupported backup key derivation parameters', 'unsupported');
  }
  if (!b64Bytes(kdf.salt, 16)) throw new BackupError('malformed backup file (salt)', 'malformed');
  const cipher = doc.cipher;
  if (!isObj(cipher) || !exactKeys(cipher, ['name', 'nonce']) || cipher.name !== 'aes-256-gcm') throw new BackupError('unsupported backup cipher', 'unsupported');
  if (!b64Bytes(cipher.nonce, 12)) throw new BackupError('malformed backup file (nonce)', 'malformed');
  const ct = b64Bytes(doc.ciphertext);
  if (!ct || ct.length < 17) throw new BackupError('malformed backup file (ciphertext)', 'malformed');
  return doc as unknown as BackupFile;
}

/** The header alone (what the restore form shows). */
export function backupHeader(b: BackupFile): BackupHeader {
  const { ciphertext: _c, ...header } = b;
  return header;
}

function deriveKey(passphrase: string, salt: Uint8Array, N: number): Promise<Uint8Array> {
  if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > BACKUP_PASSPHRASE_MAX) {
    return Promise.reject(new BackupError('the passphrase is empty or too long', 'decrypt'));
  }
  const input = Buffer.concat([Buffer.from('rdv1/backup\0', 'utf8'), Buffer.from(passphrase.normalize('NFC'), 'utf8')]);
  return new Promise((resolve, reject) =>
    scryptCb(input, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 16 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key)))),
  );
}

/**
 * Encrypt `contents` (any JSON the host chooses; its `agent.secretKey` must be
 * the key of `agentId`) under `passphrase`. The caller checks the
 * passphrase's strength (backupPassphraseProblem) before.
 */
export async function sealBackup(agentId: string, passphrase: string, contents: { agent: AgentState } & Record<string, unknown>, opts: { now?: Date } = {}): Promise<BackupFile> {
  if (!isAgentId(agentId)) throw new BackupError('not an agent ID', 'malformed');
  if (keyFromSecret(b64decode(contents.agent.secretKey)).id !== agentId) throw new BackupError('the state does not hold this agent key', 'mismatch');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    agent: agentId,
    created: (opts.now ?? new Date()).toISOString(),
    kdf: { name: 'scrypt', ...BACKUP_SCRYPT, salt: b64encode(salt) },
    cipher: { name: 'aes-256-gcm', nonce: b64encode(nonce) },
  };
  const key = await deriveKey(passphrase, salt, header.kdf.N);
  const ct = gcm(key, nonce, canonicalBytes(header)).encrypt(utf8ToBytes(canonicalize(contents)));
  key.fill(0);
  return { ...header, ciphertext: b64encode(ct) };
}

/**
 * Decrypt a bundle (parseBackup first). Throws BackupError: a wrong passphrase
 * and a changed header or ciphertext are the same error (`decrypt`), and the
 * contents must hold the header's agent key (`mismatch`). The caller validates
 * the rest of the contents' shape.
 */
export async function openBackup(input: unknown, passphrase: string): Promise<{ header: BackupHeader; contents: { agent: AgentState } & Record<string, unknown> }> {
  const b = parseBackup(input);
  const header = backupHeader(b);
  const key = await deriveKey(passphrase, b64decode(b.kdf.salt), b.kdf.N);
  let plain: Uint8Array;
  try {
    plain = gcm(key, b64decode(b.cipher.nonce), canonicalBytes(header)).decrypt(b64decode(b.ciphertext));
  } catch {
    throw new BackupError('the backup does not open: wrong passphrase, or the file was changed or damaged', 'decrypt');
  } finally {
    key.fill(0);
  }
  let contents: unknown;
  try {
    contents = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new BackupError('the backup opened but its contents are not readable', 'malformed');
  }
  if (!isObj(contents) || !isObj(contents.agent) || typeof contents.agent.secretKey !== 'string') throw new BackupError('the backup holds no agent state', 'malformed');
  let id: string;
  try {
    id = keyFromSecret(b64decode(contents.agent.secretKey)).id;
  } catch {
    throw new BackupError('the backup holds a malformed agent key', 'malformed');
  }
  if (id !== header.agent) throw new BackupError('the key inside the backup is not the agent its header names', 'mismatch');
  return { header, contents: contents as { agent: AgentState } & Record<string, unknown> };
}

/** Minimum strength for a backup passphrase: the file may end up in cloud storage. Why it is too weak, or undefined. */
export const BACKUP_PASSPHRASE_MIN = 12;
/** The passphrase rules in plain words, shown BEFORE the user types one (forms, CLI intro). Keep in step with backupPassphraseProblem. */
export const BACKUP_PASSPHRASE_RULES =
  `At least ${BACKUP_PASSPHRASE_MIN} characters, at least 6 different ones, no spaces at the start or end, and no common words or runs such as password, qwerty, 1234, abcd, backup or the same character three times. ` +
  'Four or more random words, like lamp-orbit-cedar-whisk, work well.';
export function backupPassphraseProblem(p: string): string | undefined {
  if (typeof p !== 'string') return 'a passphrase';
  const chars = [...p.normalize('NFC')];
  if (chars.length < BACKUP_PASSPHRASE_MIN) return `at least ${BACKUP_PASSPHRASE_MIN} characters (four or more random words work well)`;
  if (p.length > BACKUP_PASSPHRASE_MAX) return `at most ${BACKUP_PASSPHRASE_MAX} characters`;
  if (p.trim() !== p) return 'no spaces at the start or end';
  if (new Set(chars.map((c) => c.toLowerCase())).size < 6) return 'more variety (at least 6 different characters)';
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/[0-9]/.test(p)) pool += 10;
  if (/[^A-Za-z0-9]/.test(p)) pool += 33;
  // A rough upper bound: random characters from the classes used. Under 64 bits it is too guessable for a file anyone may copy.
  if (chars.length * Math.log2(Math.max(pool, 2)) < 64) return 'more length or more kinds of characters (it must resist offline guessing)';
  // The estimate above trusts the characters to be random; a short one built on a common word or run is not (security review).
  if (chars.length < 20 && COMMON.test(p.replace(/[\s_.-]+/g, ''))) return 'no common words or runs like "password", "qwerty" or "1234" (four or more random words work well)';
  return undefined;
}

const COMMON = /pass(word|wort|phrase)?|qwert|azert|asdf|zxcv|1234|abcd|letmein|welcome|iloveyou|admin|monkey|dragon|sunshine|princess|football|baseball|secret|rendezvous|backup|(.)\2\2/i;

// ---------------------------------------------------------------------------
// Agent state in a bundle, and after a restore (NOTES 91).

/**
 * What goes into a bundle of the agent state: everything it needs to go on,
 * minus what must not travel: approvals still open (pending requests, probe
 * answers, group invites), the outbox and the gap buffer (envelopes of the
 * chain the restore replaces), and any earlier restore's bookkeeping.
 */
export function backupAgentState(state: AgentState): AgentState {
  const s = JSON.parse(JSON.stringify(state)) as AgentState;
  s.book.pending = {};
  s.book.candidates = {};
  s.outbox = {};
  delete s.buffer;
  delete s.restored;
  if (s.groups) s.groups.invites = {};
  for (const c of Object.values(s.channels ?? {})) delete c.restoreNotice;
  return s;
}

/**
 * The agent state to write on the machine we restore to (NOTES 91). Every
 * channel starts a new outbound epoch: its next `seq` jumps past the restore
 * time in ms, beyond anything the lost copy can have sent after the backup,
 * so a peer never reads our new envelopes as a rollback; and each channel
 * owes its peer an `rdv/restored` notice, sent before anything else to it
 * (Agent.deliver), which lets the peer re-base our chain instead of refusing
 * it. Inbound state is kept: the peer's newer envelopes arrive as a gap,
 * which the peer's `rdv/restored-ack` closes.
 */
export function restoredAgentState(state: AgentState, opts: { backupCreated: string; now?: Date }): AgentState {
  const now = opts.now ?? new Date();
  const s = backupAgentState(state);
  for (const c of Object.values(s.channels ?? {})) {
    c.outSeq = Math.max(c.outSeq, now.getTime());
    c.restoreNotice = 'due';
    delete c.resync;
  }
  s.restored = { at: now.toISOString(), backup_created: opts.backupCreated };
  // Receipts (NOTES 98): what was waiting for one cannot be resent (the outbox is not backed up), and in the new
  // epoch the peer's first receipt would cover it all as "delivered" (review of #112). Dropped; the owner is told
  // how many (pendingInBackup) once, in the restore's result.
  delete s.delivery;
  return s;
}

/** Messages in an agent state still waiting for a contact's receipt: what a restore from it cannot confirm. */
export function pendingInBackup(state: AgentState): number {
  return Object.values(state.delivery ?? {}).reduce((n, d) => n + (Array.isArray(d?.pending) ? d.pending.length : 0), 0);
}
