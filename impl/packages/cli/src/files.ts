// Files in tasks (SPEC §7.7, issue #26), shared by `rdv` and `rdv-mcp`.
//
// Outgoing: `prepareFile` encrypts one of the owner's files under a fresh key
// (core's `encryptFile`) and writes the ciphertext under the home, for the
// owner to upload wherever they like; `attachFiles` turns prepared files (and
// small ones carried inline) into file parts for a draft. A draft with the
// owner's files passes the release gate like any other (tasks.ts), and the
// human is shown each file's name, size, hash, URL and where it was read
// from. The key travels only inside the end-to-end envelope.
//
// Incoming: every file part a peer sends is validated with core's
// `parseFilePart` (`normalizeTaskFiles`) before the tasks engine sees it, and
// stored in its sanitized wire form. Nothing is fetched on arrival.
// `fetchIncoming` fetches one only when the agent asks, only for a task that
// passed its start gate (a peer's task our human approved, or a task we
// requested), with core's `fetchFileRef` (https only, no special addresses,
// no credentials, a size cap, hash checked, then decrypted and checked). The
// bytes go to a quarantine folder under the home, under a safe name, mode 600
// (no exec bit), and only metadata and the path come back.
//
// Direct transfers (`rdv/transfer`): this host implements no transfer
// protocol. A peer's request is declined at once while the owner's
// `direct_transfer` setting is off (the default); with it on, the request is
// shown to the owner, who can decline it. Nothing connects on its own.
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { type FilePart, isFinished, type TaskPart, type TaskRecord } from '@rendezvous/a2a';
import {
  type Agent,
  checkFileUri,
  DEFAULT_MAX_FILE_BYTES,
  encryptFile,
  type FetchFileRefOptions,
  fetchFileRef,
  type FileRef,
  FileRefError,
  fileRefPart,
  inlineFilePart,
  MAX_INLINE_FILE_BYTES,
  type ParsedFilePart,
  type Payload,
  parseFilePart,
  parseTransfer,
  plainFileRef,
  sanitizeFileName,
  sha256Hex,
  stepTransfer,
  TRANSFER_TYPE,
  type TransferMessage,
  transferMessage,
  type TransferState,
} from '@rendezvous/core';
import { CliError, type FileNote, type FilesState, type Home, type InboxEntry, type OutgoingFile, type TaskHostState, type TransferRecord } from './home.js';

/** Prepared files kept in files.json (the oldest go first, with their upload copy). */
export const MAX_OUTGOING_FILES = 256;
/** Direct-transfer requests kept (finished ones go first). */
export const MAX_TRANSFERS = 64;
/** File parts kept per task we requested (8 artifacts of 8 parts). */
export const MAX_RECEIVED_PER_TASK = 64;
/** Fetched text this short (characters) is returned inline, marked untrusted. */
export const SMALL_TEXT_CHARS = 2000;

const HEX64 = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// --- incoming: validation ---------------------------------------------------------

/** The sanitized wire form of a validated file part. */
function wirePart(v: ParsedFilePart): FilePart {
  if (v.kind === 'inline') return inlineFilePart(v.bytes, { ...(v.mimeType ? { mimeType: v.mimeType } : {}), ...(v.name ? { name: v.name } : {}) }) as FilePart;
  return fileRefPart(v.ref) as unknown as FilePart;
}

/**
 * Validate every file part of a tasks/v1 payload with `parseFilePart` (SPEC
 * §7.7) and put each in its sanitized wire form (display names cleaned, MIME
 * types lowercased, other extensions' metadata dropped). A payload with any
 * file part that fails is refused whole: an agent never holds a URL without a
 * hash to check. Payloads without file parts are returned as they are.
 */
export function normalizeTaskFiles(payload: unknown): { ok: true; payload: unknown } | { ok: false; reason: string; taskId: string | null } {
  if (!isObject(payload)) return { ok: true, payload };
  const body = payload.type === 'a2a/message' ? payload.message : payload.type === 'a2a/artifact-update' ? payload.update : undefined;
  if (!isObject(body)) return { ok: true, payload };
  const holder = payload.type === 'a2a/message' ? body : body.artifact;
  if (!isObject(holder) || !Array.isArray(holder.parts) || !holder.parts.some((p) => isObject(p) && p.kind === 'file')) return { ok: true, payload };
  const taskId = typeof body.taskId === 'string' && UUID.test(body.taskId) ? body.taskId : null;
  const parts: unknown[] = [];
  for (const p of holder.parts) {
    if (!isObject(p) || p.kind !== 'file') {
      parts.push(p);
      continue;
    }
    const r = parseFilePart(p);
    if (!r.ok) return { ok: false, reason: `file part refused: ${r.reason}`, taskId };
    try {
      parts.push(wirePart(r.value));
    } catch (err) {
      return { ok: false, reason: `file part refused: ${(err as Error).message}`, taskId };
    }
  }
  const out = structuredClone(payload) as Record<string, Record<string, unknown>>;
  const target = payload.type === 'a2a/message' ? out.message : (out.update.artifact as Record<string, unknown>);
  target.parts = parts;
  return { ok: true, payload: out };
}

// --- views ------------------------------------------------------------------------------

/** What the human and the model are shown of a file part: everything but the key and nonce. */
export interface FileSummary {
  /** 1-based position, as `rdv file fetch --file` takes it. */
  index: number;
  name?: string;
  mimeType?: string;
  size: number;
  /** For a reference, the hash of the bytes fetched; for an inline file, of its bytes. */
  sha256: string;
  encrypted: boolean;
  inline: boolean;
  uri?: string;
  host?: string;
  mirrors?: string[];
  /** Direct-transfer protocols the sender offers. This host implements none, so they are shown only. */
  p2p?: string[];
  expires?: string;
  /** The part no longer validates (state from an older version): never fetched. */
  invalid?: true;
}

export function fileSummary(part: FilePart, index: number): FileSummary {
  const r = parseFilePart(part);
  if (!r.ok) return { index, size: 0, sha256: '', encrypted: false, inline: false, invalid: true };
  const v = r.value;
  if (v.kind === 'inline') {
    return { index, ...(v.name ? { name: v.name } : {}), ...(v.mimeType ? { mimeType: v.mimeType } : {}), size: v.bytes.length, sha256: sha256Hex(v.bytes), encrypted: false, inline: true };
  }
  const ref = v.ref;
  return {
    index,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
    size: ref.size,
    sha256: ref.sha256,
    encrypted: ref.enc !== undefined,
    inline: false,
    ...(ref.uri ? { uri: ref.uri, host: new URL(ref.uri).host } : {}),
    ...(ref.mirrors ? { mirrors: ref.mirrors } : {}),
    ...(ref.p2p ? { p2p: ref.p2p } : {}),
    ...(ref.expires ? { expires: ref.expires } : {}),
  };
}

export const fileSummaries = (parts: readonly FilePart[] | undefined): FileSummary[] | undefined => (parts?.length ? parts.map((p, i) => fileSummary(p, i + 1)) : undefined);

/** One file in words: name, type, size, the full hash, encryption, where it is. Every field is shown. */
export function describeFile(f: Omit<FileSummary, 'index'> & { index?: number; source?: string }): string {
  const bits = [
    f.mimeType ?? 'no type',
    `${f.size} bytes`,
    `sha256 ${f.sha256 || '?'}`,
    f.inline ? 'inline in the message' : f.encrypted ? 'encrypted (the key travels only in the message)' : 'NOT encrypted',
    ...(f.uri ? [`at ${f.uri}`] : []),
    ...(f.mirrors?.length ? [`mirrors ${f.mirrors.join(', ')}`] : []),
    ...(f.p2p?.length ? [`direct transfer offered: ${f.p2p.join(', ')} (not supported here)`] : []),
    ...(f.expires ? [`expires ${f.expires}`] : []),
    ...(f.source ? [`read from ${f.source}`] : []),
    ...(f.invalid ? ['INVALID, never fetched'] : []),
  ];
  return `${f.index !== undefined ? `#${f.index} ` : ''}${JSON.stringify(f.name ?? 'unnamed')} (${bits.join(', ')})`;
}

/** A file note (an outgoing file in a draft), as the release gate shows it. */
export const describeNote = (n: FileNote): string => describeFile({ ...n, inline: n.inline === true });

/** A file part with its key and nonce replaced: for listings, where the rest is shown in full. */
export function redactFilePart(part: FilePart): unknown {
  const md = part.metadata;
  const ext = isObject(md) ? md['https://rendezvous.nesher.co/ext/files/v1'] : undefined;
  if (!isObject(ext) || !isObject(ext.enc)) return part;
  return { ...part, metadata: { ...md, 'https://rendezvous.nesher.co/ext/files/v1': { ...ext, enc: { ...ext.enc, key: '(secret, not shown)', nonce: '(not shown)' } } } };
}

// --- outgoing -----------------------------------------------------------------------

function writeBinary(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function checkMime(m: string | undefined): string | undefined {
  if (m === undefined) return undefined;
  const v = m.toLowerCase();
  if (!MIME.test(v)) throw new CliError(`not a MIME type (type/subtype): ${JSON.stringify(m)}`, 2);
  return v;
}

/** Files that hold a Rendezvous key or consent state: never sent, wherever they are. */
export const SECRET_FILE_NAMES = ['agent.json', 'agent.json.bak', 'consent.json', 'autoapprove.json', 'owner.json'];

/** Homes we can name: this one, $RDV_HOME, and every profile under ~/.rendezvous. */
function knownHomes(home: Home): string[] {
  const out = [home.dir, ...(process.env.RDV_HOME ? [process.env.RDV_HOME] : [])];
  const base = join(homedir(), '.rendezvous');
  try {
    for (const d of readdirSync(base)) if (d !== 'src') out.push(join(base, d));
  } catch {
    /* none */
  }
  return out;
}

/** dev:ino of every secret file in the known homes, so a hard link to one is caught whatever its path. */
function secretIdentities(home: Home): Set<string> {
  const ids = new Set<string>();
  for (const h of knownHomes(home)) {
    for (const f of SECRET_FILE_NAMES) {
      try {
        const st = statSync(join(h, f), { bigint: true });
        ids.add(`${st.dev}:${st.ino}`);
      } catch {
        /* absent */
      }
    }
  }
  return ids;
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const realOr = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Is `p` (an absolute path) a secret file by name, or inside a Rendezvous
 * home: this one, $RDV_HOME, anything under a `.rendezvous` folder (but its
 * installed source, `src`), or any folder that looks like a home
 * (config.json beside agent.json or consent.json)?
 */
function inAnyHome(home: Home, p: string): boolean {
  if (SECRET_FILE_NAMES.includes(basename(p).toLowerCase())) return true;
  const comps = p.split(/[\\/]+/).filter(Boolean).map((c) => c.toLowerCase());
  const at = comps.lastIndexOf('.rendezvous');
  if (at >= 0 && comps[at + 1] !== 'src') return true;
  const homes = [home.dir, process.env.RDV_HOME].filter((x): x is string => !!x).flatMap((h) => [resolve(h), realOr(h)]);
  for (let d = dirname(p); ; d = dirname(d)) {
    if (homes.some((h) => samePath(d, h))) return true;
    if (existsSync(join(d, 'config.json')) && (existsSync(join(d, 'agent.json')) || existsSync(join(d, 'consent.json')))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * Read one of the owner's files to send. Never a secret file by name, nor
 * anything inside a Rendezvous home (the secret key, consent state, other
 * peers' files): both the given path and the real one (symlinks and
 * junctions followed) are checked, so a link or a `..` cannot reach them.
 */
function readOwnerFile(home: Home, path: string, max: number, what: string): { abs: string; bytes: Uint8Array } {
  const abs = resolve(path);
  const refused = () => new CliError(`refused: ${abs} is a Rendezvous file or inside a Rendezvous home (secret key, consent state, peers' files); nothing there is sent`);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new CliError(`no such file: ${abs}`);
  }
  if (inAnyHome(home, abs) || inAnyHome(home, real)) throw refused();
  // Open the checked path once, never following a last-component symlink swapped in since (O_NOFOLLOW; POSIX only),
  // then judge and read that same descriptor: what is read is what was checked.
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new CliError(`cannot open ${abs} (it changed while it was checked, or is not readable)`);
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new CliError(`not a regular file: ${abs}`);
    // A hard link to a secret file has another path but the same identity; refuse it, and any file with more links.
    if (secretIdentities(home).has(`${st.dev}:${st.ino}`)) throw refused();
    if (st.nlink > 1n) throw new CliError(`refused: ${abs} has ${st.nlink} hard links; copy it to a file of its own to send it`);
    if (st.size > BigInt(max)) throw new CliError(`${abs} is ${st.size} bytes; ${what} at most ${max}`);
    const bytes = new Uint8Array(Number(st.size));
    let off = 0;
    while (off < bytes.length) {
      const n = readSync(fd, bytes, off, bytes.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== bytes.length) throw new CliError(`${abs} changed while it was read; nothing was sent`);
    return { abs, bytes };
  } finally {
    closeSync(fd);
  }
}

/** The view of a prepared file: never the key. */
export function outgoingView(f: OutgoingFile) {
  return { sha256: f.sha256, size: f.size, name: f.name, mimeType: f.mimeType, encrypted: f.enc !== undefined, plain_sha256: f.plain_sha256, source: f.source, upload: f.upload, created: f.created };
}

/**
 * Prepare one of the owner's files to send (inside the lock): encrypted with
 * a fresh key and nonce unless `plain`, written under files/outgoing/ for the
 * owner to upload wherever they like. Nothing is sent: the file goes out only
 * in a draft the human releases, and the key only inside that envelope.
 */
export function prepareFile(home: Home, path: string, opts: { name?: string; mimeType?: string; plain?: boolean } = {}): OutgoingFile {
  const { abs, bytes } = readOwnerFile(home, path, DEFAULT_MAX_FILE_BYTES, 'a file sent by reference is');
  const mimeType = checkMime(opts.mimeType);
  const name = sanitizeFileName(opts.name ?? basename(abs));
  const { upload, meta } = opts.plain ? { upload: bytes, meta: plainFileRef(bytes) } : (({ ciphertext, ref }) => ({ upload: ciphertext, meta: ref }))(encryptFile(bytes));
  const s = home.readFiles();
  const uploadPath = join(home.filesDir, 'outgoing', `${meta.sha256}.bin`);
  writeBinary(uploadPath, upload);
  const rec: OutgoingFile = {
    sha256: meta.sha256,
    size: meta.size,
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    source: abs,
    upload: uploadPath,
    ...(meta.enc ? { enc: meta.enc } : {}),
    plain_sha256: sha256Hex(bytes),
    created: new Date().toISOString(),
  };
  s.outgoing[rec.sha256] = rec;
  const all = Object.values(s.outgoing).sort((a, b) => a.created.localeCompare(b.created));
  for (const old of all.slice(0, Math.max(0, all.length - MAX_OUTGOING_FILES))) {
    delete s.outgoing[old.sha256];
    rmSync(old.upload, { force: true });
  }
  home.writeFiles(s);
  return rec;
}

/** A prepared file by its sha256, or a unique prefix of at least 8 hex characters. */
function findOutgoing(s: FilesState, sha: string): OutgoingFile {
  const k = sha.toLowerCase();
  if (HEX64.test(k) && Object.hasOwn(s.outgoing, k)) return s.outgoing[k];
  const hits = /^[0-9a-f]{8,64}$/.test(k) ? Object.keys(s.outgoing).filter((x) => x.startsWith(k)) : [];
  if (hits.length === 1) return s.outgoing[hits[0]];
  throw new CliError(hits.length > 1 ? `${sha} matches more than one prepared file: give more of its sha256` : `no prepared file ${sha}: prepare it first (rdv file prepare <path>, or rdv_file "prepare")`);
}

export interface Attachment {
  /** A prepared file (by sha256 or a unique prefix) and the https URL where the owner put its upload copy. */
  sha256: string;
  uri: string;
}

/**
 * File parts for a draft or a request, and the notes the release gate shows:
 * prepared files by reference (`refs`), small files inline (`inline` paths,
 * at most 16 KiB, carried inside the envelope). Inside the lock.
 */
export function attachFiles(home: Home, refs: readonly Attachment[], inline: readonly string[]): { parts: TaskPart[]; notes: FileNote[] } {
  const parts: TaskPart[] = [];
  const notes: FileNote[] = [];
  const s = refs.length ? home.readFiles() : undefined;
  for (const a of refs) {
    const f = findOutgoing(s!, a.sha256);
    const u = checkFileUri(a.uri);
    if (!u.ok) throw new CliError(`file URL refused (${u.reason}): it must be https, with a host and no user name or password`, 2);
    const ref: FileRef = { sha256: f.sha256, size: f.size, uri: a.uri, ...(f.enc ? { enc: f.enc } : {}), ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.name ? { name: f.name } : {}) };
    parts.push(fileRefPart(ref) as unknown as FilePart);
    notes.push({ sha256: f.sha256, size: f.size, ...(f.name ? { name: f.name } : {}), ...(f.mimeType ? { mimeType: f.mimeType } : {}), source: f.source, uri: a.uri, encrypted: f.enc !== undefined });
  }
  for (const path of inline) {
    const { abs, bytes } = readOwnerFile(home, path, MAX_INLINE_FILE_BYTES, 'an inline file is');
    const name = sanitizeFileName(basename(abs));
    parts.push(inlineFilePart(bytes, name ? { name } : {}) as FilePart);
    notes.push({ sha256: sha256Hex(bytes), size: bytes.length, ...(name ? { name } : {}), source: abs, encrypted: false, inline: true });
  }
  return { parts, notes };
}

// --- incoming: what may be fetched, and fetching -------------------------------------------

/** File parts a peer sent for task `t`, with the gate rule (SPEC §7.7: only after the start gate). Throws CliError. */
export function fetchableFiles(s: TaskHostState, taskId: string): { task: TaskRecord; files: FilePart[] } {
  const t = Object.hasOwn(s.engine.tasks, taskId) ? s.engine.tasks[taskId] : undefined;
  if (!t || t.tombstone) throw new CliError(`no task ${taskId}`);
  if (t.role === 'executor') {
    if (t.gate || t.state === 'submitted') {
      throw new CliError(`task ${taskId} has not been started: its files are fetched only after your user approves the start (rdv task approve, or rdv_task "approve-start"). Nothing was fetched.`);
    }
    if (isFinished(t.state)) throw new CliError(`task ${taskId} is ${t.state}: its files are no longer held. Nothing was fetched.`);
    return { task: t, files: t.files ?? [] };
  }
  // A task we requested: our side started it. Only what its executor sent in artifacts.
  const got = s.received && Object.hasOwn(s.received, taskId) ? s.received[taskId] : undefined;
  return { task: t, files: got && got.peer === t.peer ? got.files : [] };
}

/** Pick one file: by 1-based index, by sha256 (or a unique prefix of 8+ hex), or the only one. */
export function pickFile(files: readonly FilePart[], sel: { index?: number; sha256?: string }, taskId: string): { part: FilePart; index: number } {
  if (files.length === 0) throw new CliError(`task ${taskId} has no files from the peer`);
  if (sel.index !== undefined) {
    if (!Number.isSafeInteger(sel.index) || sel.index < 1 || sel.index > files.length) throw new CliError(`task ${taskId} has ${files.length} file(s): give --file 1..${files.length}`, 2);
    return { part: files[sel.index - 1], index: sel.index };
  }
  if (sel.sha256 !== undefined) {
    const k = sel.sha256.toLowerCase();
    if (!/^[0-9a-f]{8,64}$/.test(k)) throw new CliError('give the file by its index or by its sha256 (at least 8 hex characters)', 2);
    const hits = files.map((p, i) => ({ p, i, s: fileSummary(p, i + 1) })).filter((x) => x.s.sha256.startsWith(k));
    if (hits.length === 1) return { part: hits[0].p, index: hits[0].i + 1 };
    throw new CliError(hits.length ? `${sel.sha256} matches more than one file of task ${taskId}` : `task ${taskId} has no file ${sel.sha256}`, 2);
  }
  if (files.length === 1) return { part: files[0], index: 1 };
  throw new CliError(`task ${taskId} has ${files.length} files: say which (by index or sha256)`, 2);
}

/** Extensions that run (or open as active content) when a file is opened on some system: saved with `.quarantine` after them. */
const ACTIVE_EXT = new Set(
  (
    'exe com bat cmd ps1 psm1 psd1 vbs vbe js jse mjs cjs wsf wsh msi msp mst scr pif lnk url hta cpl jar sh bash zsh ksh csh fish command app ' +
    'desktop reg dll so dylib py pyw pl rb php appimage deb rpm apk dmg pkg iso img vhd vhdx html htm xhtml mht mhtml svg xml xsl chm inf ' +
    'scf application gadget msc ws library-ms settingcontent-ms appref-ms jnlp workflow action'
  ).split(' '),
);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * A local name for a peer's file (§5.6: display only): core's sanitizing,
 * then ASCII letters, digits, `.`, `_`, `-` and spaces only, no leading or
 * trailing dots or spaces, no Windows device names, at most 100 characters,
 * prefixed with the first 12 hex of its hash, and `.quarantine` appended to
 * any extension that runs or renders active content.
 */
export function quarantineName(name: string | undefined, sha: string): string {
  let base = (sanitizeFileName(name) ?? '').normalize('NFKC').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/_+/g, '_');
  base = base.replace(/^[.\s_-]+/, '').replace(/[.\s]+$/, '');
  if (base.length > 100) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
    base = base.slice(0, 100 - ext.length).replace(/[.\s]+$/, '') + ext;
  }
  if (!base) base = 'file';
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext && ACTIVE_EXT.has(ext)) base = `${base}.quarantine`;
  return `${sha.slice(0, 12)}-${base}`;
}

export interface FetchedFileView {
  task: string;
  peer: string;
  index: number;
  /** Where the verified file was saved (under the home's files/incoming/<task>/). */
  path: string;
  size: number;
  /** SHA-256 of the saved (verified, decrypted) bytes. */
  sha256: string;
  /** The reference's hash of what was fetched (the ciphertext when encrypted). */
  fetched_sha256?: string;
  encrypted: boolean;
  inline: boolean;
  /** The peer's display name and type, sanitized; peer data. */
  name?: string;
  mimeType?: string;
  /** Which URL served it. */
  source?: string;
  /** The content, when it is short text (at most SMALL_TEXT_CHARS): peer data, untrusted. */
  text?: string;
}

/** Options a test may pass to the fetch (a local test server's CA and address); never from peer data. */
export type FetchTestOptions = Pick<FetchFileRefOptions, 'ca' | 'unsafeAllowAddresses' | 'timeoutMs' | 'resolve'>;

function smallText(bytes: Uint8Array, mimeType: string | undefined): string | undefined {
  if (bytes.length > SMALL_TEXT_CHARS * 4) return undefined;
  if (mimeType !== undefined && !mimeType.startsWith('text/') && mimeType !== 'application/json') return undefined;
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (s.length > SMALL_TEXT_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return undefined;
  return s;
}

function save(dir: string, name: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  if (!resolve(path).startsWith(resolve(dir) + sep)) throw new CliError('internal: unsafe file name'); // quarantineName never allows it
  const hash = sha256Hex(bytes);
  if (existsSync(path)) {
    if (sha256Hex(new Uint8Array(readFileSync(path))) === hash) return path;
    throw new CliError(`${path} already exists with other content; nothing was overwritten`);
  }
  // `wx`: never follows or replaces an existing file. Mode 600: no exec bit, owner only.
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  if (process.platform === 'win32') {
    // Mark of the Web: Windows treats it as downloaded from the internet (best effort, NTFS only).
    try {
      writeFileSync(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    } catch {
      /* not NTFS */
    }
  }
  return path;
}

/**
 * Fetch one file a peer sent for a task, verify it and save it in
 * quarantine. Refused before the task's start gate (fetchableFiles). The state
 * is read under the lock; the fetch itself runs outside it. Throws CliError
 * (FileRefError codes in the message; never peer text).
 */
export async function fetchIncoming(
  home: Home,
  taskId: string,
  sel: { index?: number; sha256?: string },
  opts: FetchTestOptions = {},
): Promise<FetchedFileView> {
  home.requireInit();
  const { task, part, index } = await home.locked(async () => {
    const { task, files } = fetchableFiles(home.readTasks(), taskId);
    return { task, ...pickFile(files, sel, taskId) };
  });
  const parsed = parseFilePart(part);
  if (!parsed.ok) throw new CliError(`file #${index} of task ${taskId} is not a valid file part (${parsed.reason}); nothing was fetched`);
  const v = parsed.value;
  let bytes: Uint8Array;
  let fetchedSha: string | undefined;
  let source: string | undefined;
  if (v.kind === 'inline') {
    bytes = v.bytes;
  } else {
    if (!v.ref.uri && !v.ref.mirrors?.length) {
      throw new CliError(`file #${index} is offered only by direct transfer (${(v.ref.p2p ?? []).join(', ')}), which this agent does not implement; nothing was fetched`);
    }
    try {
      const got = await fetchFileRef(v.ref, { maxBytes: DEFAULT_MAX_FILE_BYTES, ...opts });
      bytes = got.bytes;
      source = got.source;
    } catch (err) {
      if (err instanceof FileRefError) throw new CliError(`fetch refused (${err.code}): ${err.message}. Nothing was saved.`);
      // Anything else may quote a peer-chosen host name: no details.
      throw new CliError('fetch failed (network error). Nothing was saved.');
    }
    fetchedSha = v.ref.sha256;
  }
  const name = v.kind === 'inline' ? v.name : v.ref.name;
  const mimeType = v.kind === 'inline' ? v.mimeType : v.ref.mimeType;
  const sha = sha256Hex(bytes);
  const path = save(join(home.filesDir, 'incoming', task.id), quarantineName(name, sha), bytes);
  const text = smallText(bytes, mimeType);
  return {
    task: task.id,
    peer: task.peer,
    index,
    path,
    size: bytes.length,
    sha256: sha,
    ...(fetchedSha ? { fetched_sha256: fetchedSha } : {}),
    encrypted: v.kind === 'ref' && v.ref.enc !== undefined,
    inline: v.kind === 'inline',
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(source ? { source } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/** Keep the file parts an executor sent for a task we requested (they are fetched later, if at all). */
export function rememberReceived(s: TaskHostState, taskId: string, peer: string, files: readonly FilePart[]): void {
  const t = Object.hasOwn(s.engine.tasks, taskId) ? s.engine.tasks[taskId] : undefined;
  if (!t || t.role !== 'requester' || t.peer !== peer || files.length === 0) return;
  const all = (s.received ??= {});
  const got = Object.hasOwn(all, taskId) && all[taskId].peer === peer ? all[taskId] : (all[taskId] = { peer, files: [] });
  for (const f of files) {
    const sha = fileSummary(f, 0).sha256;
    if (got.files.some((g) => fileSummary(g, 0).sha256 === sha && JSON.stringify(g) === JSON.stringify(f))) continue;
    if (got.files.length < MAX_RECEIVED_PER_TASK) got.files.push(f);
  }
}

/** Drop received files whose task is gone. */
export function pruneReceived(s: TaskHostState): void {
  if (!s.received) return;
  for (const [id, r] of Object.entries(s.received)) {
    const t = Object.hasOwn(s.engine.tasks, id) ? s.engine.tasks[id] : undefined;
    if (!t || t.role !== 'requester' || t.peer !== r.peer) delete s.received[id];
  }
  if (Object.keys(s.received).length === 0) delete s.received;
}

// --- direct transfer (rdv/transfer) -------------------------------------------------------

export interface TransferEvent {
  event: 'transfer';
  /** proposed: waits for the owner; declined: we said no (auto: the setting is off); aborted: the peer ended it; invalid, ignored. */
  kind: 'proposed' | 'declined' | 'aborted' | 'invalid' | 'ignored';
  transfer?: string;
  peer: string;
  file?: string;
  task?: string;
  protocols?: string[];
  /** Peer text (an abort's reason), display only. */
  reason?: string;
  auto?: boolean;
}

export const isTransferPayload = (p: unknown): boolean => isObject(p) && p.type === TRANSFER_TYPE;

function boundTransfers(s: FilesState): void {
  const all = Object.entries(s.transfers).sort(([, a], [, b]) => {
    const fa = a.state.phase === 'done' || a.state.phase === 'aborted' ? 0 : 1;
    const fb = b.state.phase === 'done' || b.state.phase === 'aborted' ? 0 : 1;
    return fa - fb || a.updated.localeCompare(b.updated);
  });
  for (const [id] of all.slice(0, Math.max(0, all.length - MAX_TRANSFERS))) delete s.transfers[id];
}

function abortOf(st: TransferState, reason: string): TransferMessage {
  return transferMessage({ file: st.file, transfer: st.transfer, step: 'abort', reason, ...(st.task ? { task: st.task } : {}) });
}

async function sendTransfers(agent: Agent, out: Array<{ to: string; msg: TransferMessage }>): Promise<string[]> {
  const errors: string[] = [];
  for (const o of out) {
    if (!agent.book.contact(o.to)) continue;
    try {
      await agent.send(o.to, o.msg as unknown as Payload);
    } catch (err) {
      errors.push(`sending rdv/transfer to ${o.to} failed: ${(err as Error).message}`);
    }
  }
  return errors;
}

/**
 * Inbound `rdv/transfer` messages (inside the lock, with an Agent from it).
 * Only contacts. A propose: declined at once (an abort) unless the owner's
 * `direct_transfer` is on; then held for the owner, nothing sent. An abort for
 * a transfer we hold ends it. Anything else for a transfer we hold aborts it
 * (we never accept: no protocol is implemented); for an unknown or finished
 * one it is ignored. State is saved before any reply leaves.
 */
export async function transfersInbound(home: Home, agent: Agent, entries: readonly InboxEntry[], directTransfer: boolean): Promise<{ events: TransferEvent[]; errors: string[] }> {
  const events: TransferEvent[] = [];
  if (entries.length === 0) return { events, errors: [] };
  const s = home.readFiles();
  const before = JSON.stringify(s);
  const out: Array<{ to: string; msg: TransferMessage }> = [];
  const now = new Date().toISOString();
  for (const e of entries) {
    const p = parseTransfer(e.payload);
    if (!p.ok) {
      events.push({ event: 'transfer', kind: 'invalid', peer: e.from, reason: p.reason });
      continue;
    }
    const m = p.message;
    const base = { transfer: m.transfer, peer: e.from, file: m.file, ...(m.task ? { task: m.task } : {}) };
    if (!agent.book.contact(e.from)) {
      events.push({ event: 'transfer', kind: 'ignored', ...base, reason: 'not a contact' });
      continue;
    }
    const rec = Object.hasOwn(s.transfers, m.transfer) ? s.transfers[m.transfer] : undefined;
    if (rec && rec.peer !== e.from) {
      events.push({ event: 'transfer', kind: 'ignored', ...base, reason: 'another peer’s transfer' });
      continue;
    }
    if (!rec) {
      if (m.step !== 'propose') {
        events.push({ event: 'transfer', kind: 'ignored', ...base, reason: 'unknown transfer' });
        continue;
      }
      const st: TransferState = { transfer: m.transfer, file: m.file, ...(m.task ? { task: m.task } : {}), phase: 'proposed', protocols: m.protocols!, messages: 1 };
      if (!directTransfer) {
        const abort = abortOf(st, 'direct transfer is off');
        const r = stepTransfer(st, abort, []);
        s.transfers[m.transfer] = { peer: e.from, state: r.ok ? r.state : { ...st, phase: 'aborted' }, created: now, updated: now };
        out.push({ to: e.from, msg: abort });
        events.push({ event: 'transfer', kind: 'declined', ...base, protocols: m.protocols, auto: true });
      } else {
        s.transfers[m.transfer] = { peer: e.from, state: st, created: now, updated: now };
        events.push({ event: 'transfer', kind: 'proposed', ...base, protocols: m.protocols });
      }
      continue;
    }
    const r = stepTransfer(rec.state, m, []);
    if (r.ok) {
      rec.state = r.state;
      rec.updated = now;
      events.push({ event: 'transfer', kind: r.state.phase === 'aborted' ? 'aborted' : 'ignored', ...base, ...(m.reason ? { reason: m.reason } : {}) });
    } else if (r.state && r.abort) {
      rec.state = r.state;
      rec.updated = now;
      out.push({ to: e.from, msg: r.abort });
      events.push({ event: 'transfer', kind: 'declined', ...base, reason: r.reason, auto: true });
    } else {
      events.push({ event: 'transfer', kind: 'ignored', ...base, reason: r.reason });
    }
  }
  boundTransfers(s);
  if (JSON.stringify(s) !== before) home.writeFiles(s);
  return { events, errors: await sendTransfers(agent, out) };
}

/** The owner declines a peer's pending direct-transfer request (sends the abort). Reduce-only. */
export async function declineTransfer(home: Home, agent: Agent, transferId: string): Promise<{ events: TransferEvent[]; errors: string[] }> {
  const s = home.readFiles();
  const rec = Object.hasOwn(s.transfers, transferId) ? s.transfers[transferId] : undefined;
  if (!rec || rec.state.phase !== 'proposed') throw new CliError(`no direct-transfer request ${transferId} waiting for you`);
  const abort = abortOf(rec.state, 'declined by the owner');
  const r = stepTransfer(rec.state, abort, []);
  rec.state = r.ok ? r.state : { ...rec.state, phase: 'aborted' };
  rec.updated = new Date().toISOString();
  home.writeFiles(s);
  const errors = await sendTransfers(agent, [{ to: rec.peer, msg: abort }]);
  return { events: [{ event: 'transfer', kind: 'declined', transfer: transferId, peer: rec.peer, file: rec.state.file, ...(rec.state.task ? { task: rec.state.task } : {}) }], errors };
}

export function transferView(id: string, r: TransferRecord) {
  return { transfer: id, peer: r.peer, file: r.state.file, task: r.state.task, phase: r.state.phase, protocols: r.state.protocols, reason: r.state.reason, created: r.created, updated: r.updated };
}

export function transferEventText(e: TransferEvent, clean: (v: unknown) => string): string | undefined {
  if (e.kind === 'ignored' || e.kind === 'invalid') return undefined;
  const what = `direct transfer ${clean(e.transfer ?? '-')} of file ${clean(e.file ?? '-')} with ${clean(e.peer)}`;
  if (e.kind === 'proposed')
    return `${what}: the peer asks to receive it directly (${clean((e.protocols ?? []).join(', '))}). It would show each side's network address. This agent implements no direct-transfer protocol, so nothing connects; decline it with: rdv file decline-transfer ${clean(e.transfer)}`;
  if (e.kind === 'declined') return `${what}: declined${e.auto ? ' (direct transfer is off, or the peer broke the protocol)' : ''}; nothing connected`;
  return `${what}: ended by the peer${e.reason ? ` (untrusted: ${clean(JSON.stringify(e.reason))})` : ''}`;
}
