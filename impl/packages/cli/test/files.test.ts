// Files in the hosts (SPEC §7.7, issue #26): validation of peer file parts,
// hostile names, the quarantine, the start gate on fetching, prepared files
// and the release view, and the `rdv file` commands.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { emptyTaskState, type FilePart, FILES_URI, type TaskRecord } from '@rendezvous/a2a';
import { b64encode, encryptFile, fileRefPart, generateKey, inlineFilePart, plainFileRef, sha256Hex } from '@rendezvous/core';
import { startTestFileServer, startTestRelay, type TestFileServer, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rdv } from '../scenarios/harness.js';
import {
  attachFiles,
  describeFile,
  fetchableFiles,
  fetchIncoming,
  fileSummary,
  normalizeTaskFiles,
  prepareFile,
  quarantineName,
  rememberReceived,
} from '../src/files.js';
import { Home, type TaskHostState } from '../src/home.js';
import { describeDraft, pruneReleases, taskListText, taskListView } from '../src/tasks.js';

const PEER = generateKey().id;
const SHA = 'ab'.repeat(32);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'rdv-files-cli-'));
  dirs.push(d);
  return d;
};

describe('quarantine names for peer files (hostile names)', () => {
  const table: Array<[string | undefined, RegExp]> = [
    ['q4-plan.pdf', /^[0-9a-f]{12}-q4-plan\.pdf$/],
    ['../../etc/passwd', /^[0-9a-f]{12}-etc_passwd$/],
    ['..\\..\\Windows\\System32\\evil.dll', /\.dll\.quarantine$/],
    ['invoice\u202efdp.exe', /^[0-9a-f]{12}-invoicefdp\.exe\.quarantine$/],
    ['setup.EXE', /\.EXE\.quarantine$/],
    ['run.ps1', /\.ps1\.quarantine$/],
    ['page.html', /\.html\.quarantine$/],
    ['CON', /^[0-9a-f]{12}-_CON$/],
    ['nul.txt', /^[0-9a-f]{12}-_nul\.txt$/],
    ['.bashrc', /^[0-9a-f]{12}-bashrc$/],
    ['report.pdf.   ', /^[0-9a-f]{12}-report\.pdf$/],
    ['résumé ½.pdf', /^[0-9a-f]{12}-r_sum_ 1_2\.pdf$|^[0-9a-f]{12}-r_sum_ 1⁄2\.pdf$|^[0-9a-f]{12}-r_sum_ [0-9_]+\.pdf$/],
    ['a\u0000b\u0007c.txt', /^[0-9a-f]{12}-abc\.txt$/],
    ['\u200b\u200b', /^[0-9a-f]{12}-file$/],
    [undefined, /^[0-9a-f]{12}-file$/],
    ['x'.repeat(300) + '.pdf', /^[0-9a-f]{12}-x{100}$/], // core keeps the first 255 characters
    ['x'.repeat(200) + '.pdf', /^[0-9a-f]{12}-x{96}\.pdf$/],
  ];
  it.each(table)('%j', (name, re) => {
    const q = quarantineName(name, sha256Hex(new Uint8Array([1])));
    expect(q).toMatch(re);
    expect(q).not.toMatch(/[/\\:*?"<>|\u0000-\u001f\u202e]/);
    expect(q.length).toBeLessThanOrEqual(12 + 1 + 100 + '.quarantine'.length);
  });
});

describe('peer file parts are validated with parseFilePart before the engine (normalizeTaskFiles)', () => {
  const { ciphertext, ref } = encryptFile(new TextEncoder().encode('hello'));
  const good = fileRefPart({ ...ref, uri: 'https://files.example.com/x', name: 'x.txt' });
  const msg = (parts: unknown[]) => ({ type: 'a2a/message', message: { kind: 'message', messageId: U(1), taskId: U(2), contextId: U(3), role: 'agent', parts: [{ kind: 'data', data: { rdv: 'task/request', capability: 'x' } }, ...parts] } });
  const art = (parts: unknown[]) => ({ type: 'a2a/artifact-update', update: { kind: 'artifact-update', taskId: U(2), contextId: U(3), artifact: { artifactId: U(4), parts } } });
  void ciphertext;

  it('a valid reference passes, sanitized: hostile name cleaned, MIME lowercased, other metadata dropped', () => {
    const hostile = structuredClone(good) as { file: Record<string, string>; metadata: Record<string, unknown> };
    hostile.file.name = '../secret\u202e.txt';
    hostile.file.mimeType = 'Text/Plain';
    hostile.metadata['https://example.com/other'] = { x: 1 };
    const r = normalizeTaskFiles(art([hostile]));
    expect(r.ok).toBe(true);
    const part = (r as { payload: { update: { artifact: { parts: FilePart[] } } } }).payload.update.artifact.parts[0];
    expect(part.file).toEqual({ uri: 'https://files.example.com/x', mimeType: 'text/plain', name: '_secret.txt' });
    expect(Object.keys(part.metadata!)).toEqual([FILES_URI]);
    // The payload itself was not changed.
    expect(hostile.file.name).toBe('../secret\u202e.txt');
  });

  it('refuses a part without a hash, a tampered or unknown field, a non-https URL, oversized inline bytes', () => {
    const meta = { sha256: ref.sha256, size: ref.size };
    for (const [why, bad] of [
      ['no metadata', { kind: 'file', file: { uri: 'https://f.example/x' } }],
      ['bad hash', { kind: 'file', file: { uri: 'https://f.example/x' }, metadata: { [FILES_URI]: { ...meta, sha256: 'AB'.repeat(32) } } }],
      ['unknown key', { kind: 'file', file: { uri: 'https://f.example/x' }, metadata: { [FILES_URI]: { ...meta, owner: 'x' } } }],
      ['http', { kind: 'file', file: { uri: 'http://f.example/x' }, metadata: { [FILES_URI]: meta } }],
      ['userinfo', { kind: 'file', file: { uri: 'https://a:b@f.example/x' }, metadata: { [FILES_URI]: meta } }],
      ['javascript', { kind: 'file', file: { uri: 'javascript:alert(1)' }, metadata: { [FILES_URI]: meta } }],
      ['enc key short', { kind: 'file', file: { uri: 'https://f.example/x' }, metadata: { [FILES_URI]: { ...ref, enc: { ...ref.enc!, key: b64encode(new Uint8Array(16)) } } } }],
      ['inline too big', { kind: 'file', file: { bytes: b64encode(new Uint8Array(16 * 1024 + 1)) } }],
      ['inline with a uri', { kind: 'file', file: { bytes: 'AAAA', uri: 'https://f.example/x' } }],
    ] as const) {
      const r = normalizeTaskFiles(msg([bad]));
      expect(r.ok, why).toBe(false);
      expect((r as { taskId: string }).taskId, why).toBe(U(2));
    }
    // Payloads without file parts are untouched, malformed ones are the engine's to refuse.
    const plain = msg([{ kind: 'text', text: 'hi' }]);
    expect(normalizeTaskFiles(plain)).toEqual({ ok: true, payload: plain });
    expect(normalizeTaskFiles({ type: 'rdv/transfer' })).toEqual({ ok: true, payload: { type: 'rdv/transfer' } });
  });

  it('summaries show everything but the key and nonce; inline files are hashed', () => {
    const s = fileSummary(good as unknown as FilePart, 1);
    expect(s).toEqual({ index: 1, name: 'x.txt', size: ref.size, sha256: ref.sha256, encrypted: true, inline: false, uri: 'https://files.example.com/x', host: 'files.example.com' });
    expect(JSON.stringify(s)).not.toContain(ref.enc!.key);
    const inl = fileSummary(inlineFilePart(new TextEncoder().encode('hi'), { name: 'a.txt' }) as FilePart, 2);
    expect(inl).toMatchObject({ index: 2, inline: true, size: 2, sha256: sha256Hex(new TextEncoder().encode('hi')) });
    expect(describeFile(s)).toContain(`sha256 ${ref.sha256}`);
    expect(fileSummary({ kind: 'file', file: { uri: 'x' } } as FilePart, 3)).toMatchObject({ invalid: true });
  });
});

function task(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: U(9),
    contextId: U(8),
    peer: PEER,
    role: 'executor',
    capability: 'https://rendezvous.nesher.co/ext/request/v1',
    approval: 'free-form',
    state: 'submitted',
    expires: null,
    seen: [],
    inputs: 0,
    updates: 0,
    artifacts: [],
    chunks: 0,
    created: '2026-10-25T10:00:00.000Z',
    updated: '2026-10-25T10:00:00.000Z',
    ...over,
  };
}

describe('fetching: only after the start gate, verified, quarantined', () => {
  let store: TestFileServer;
  beforeAll(async () => {
    store = await startTestFileServer();
  });
  afterAll(() => store.close());

  function homeWith(t: TaskRecord, received?: FilePart[]): Home {
    const home = new Home(tmp());
    home.ensureDir();
    writeFileSync(home.agentPath, '{}'); // fetchIncoming only checks that a home exists
    const s: TaskHostState = { v: 1, engine: { ...emptyTaskState(), tasks: { [t.id]: t } }, releases: {} };
    if (received) rememberReceived(s, t.id, t.peer, received);
    home.writeTasks(s);
    return home;
  }
  const opts = () => ({ ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] });

  it("a peer's task: refused at the start gate and before it, allowed once working, refused once it ended", async () => {
    const plain = new TextEncoder().encode('the brief');
    const { ciphertext, ref } = encryptFile(plain);
    const url = store.put(`/t/${ref.sha256}`, ciphertext);
    const part = fileRefPart({ ...ref, uri: url, name: 'brief.txt', mimeType: 'text/plain' }) as unknown as FilePart;
    const gated = homeWith(task({ files: [part], gate: { kind: 'start', step: 'request', since: '2026-10-25T10:00:00.000Z' } }));
    await expect(fetchIncoming(gated, U(9), {}, opts())).rejects.toThrow(/has not been started/);
    expect(store.seen.filter((x) => x.path.startsWith('/t/'))).toEqual([]);

    const working = homeWith(task({ files: [part], state: 'working' }));
    const v = await fetchIncoming(working, U(9), {}, opts());
    expect(v).toMatchObject({ index: 1, size: plain.length, sha256: sha256Hex(plain), fetched_sha256: ref.sha256, encrypted: true, name: 'brief.txt', text: 'the brief' });
    expect(readFileSync(v.path, 'utf8')).toBe('the brief');
    expect(v.path.startsWith(join(working.filesDir, 'incoming', U(9)))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(v.path).mode & 0o777).toBe(0o600);
    // Again: the same verified file, not a second copy.
    expect((await fetchIncoming(working, U(9), { index: 1 }, opts())).path).toBe(v.path);
    expect(readdirSync(join(working.filesDir, 'incoming', U(9)))).toEqual([basename(v.path)]);

    const ended = homeWith(task({ state: 'completed' }));
    await expect(fetchIncoming(ended, U(9), {}, opts())).rejects.toThrow(/no longer held/);
    const tomb = homeWith(task({ tombstone: true, state: 'canceled' }));
    await expect(fetchIncoming(tomb, U(9), {}, opts())).rejects.toThrow(/no task/);
  });

  it('a task we requested: only the files of its results; the default options refuse the local store (SSRF)', async () => {
    const bytes = new TextEncoder().encode('public notes');
    const meta = plainFileRef(bytes);
    const url = store.put(`/r/${meta.sha256}`, bytes);
    const part = fileRefPart({ ...meta, uri: url, name: 'notes.txt' }) as unknown as FilePart;
    const home = homeWith(task({ role: 'requester', state: 'completed' }), [part]);
    await expect(fetchIncoming(home, U(9), {})).rejects.toThrow(/fetch refused \(blocked/);
    expect(store.seen.filter((x) => x.path.startsWith('/r/'))).toEqual([]);
    const v = await fetchIncoming(home, U(9), { sha256: meta.sha256.slice(0, 10) }, opts());
    expect(v).toMatchObject({ encrypted: false, text: 'public notes' });
    // Another peer's results are not ours to fetch; an unknown index or hash is a usage error.
    const s = home.readTasks();
    s.received![U(9)].peer = generateKey().id;
    pruneReleases(s);
    expect(s.received).toBeUndefined();
    await expect(fetchIncoming(home, U(9), { index: 2 }, opts())).rejects.toThrow(/1\.\.1/);
    await expect(fetchIncoming(home, U(9), { sha256: 'ffffffff' }, opts())).rejects.toThrow(/no file/);
  });

  it('inline files are saved without any fetch; binary content is not returned as text', async () => {
    const bin = new Uint8Array([0x4d, 0x5a, 0, 1, 2, 3]);
    const part = inlineFilePart(bin, { name: 'tool.exe' }) as FilePart;
    const home = homeWith(task({ files: [part], state: 'working' }));
    const before = store.seen.length;
    const v = await fetchIncoming(home, U(9), {}, opts());
    expect(store.seen.length).toBe(before);
    expect(v).toMatchObject({ inline: true, size: 6 });
    expect(v.text).toBeUndefined();
    expect(basename(v.path)).toMatch(/-tool\.exe\.quarantine$/);
    expect(new Uint8Array(readFileSync(v.path))).toEqual(bin);
  });

  it('fetchableFiles is the gate both hosts use', () => {
    const s: TaskHostState = { v: 1, engine: { ...emptyTaskState(), tasks: { [U(9)]: task({ state: 'input-required', files: [] }) } }, releases: {} };
    expect(fetchableFiles(s, U(9)).files).toEqual([]);
    s.engine.tasks[U(9)].gate = { kind: 'start', step: 'input', since: 'x' };
    expect(() => fetchableFiles(s, U(9))).toThrow(/has not been started/);
  });
});

describe('outgoing files: prepared, attached, shown at the release gate', () => {
  it('prepare writes only ciphertext under the home and keeps the key local; the draft view shows name, size, hash, URL and source', () => {
    const home = new Home(tmp());
    home.ensureDir();
    const src = join(tmp(), 'plan.pdf');
    writeFileSync(src, 'PDF-1.7 the secret plan');
    const f = prepareFile(home, src, { mimeType: 'Application/PDF' });
    expect(f).toMatchObject({ name: 'plan.pdf', mimeType: 'application/pdf', source: src, size: 'PDF-1.7 the secret plan'.length + 16 });
    const up = readFileSync(f.upload);
    expect(up.toString('latin1')).not.toContain('secret plan');
    expect(sha256Hex(new Uint8Array(up))).toBe(f.sha256);
    if (process.platform !== 'win32') expect(statSync(home.filesPath).mode & 0o777).toBe(0o600);
    // A fresh key every time, even for the same file.
    const g = prepareFile(home, src);
    expect(g.enc!.key).not.toBe(f.enc!.key);
    expect(g.sha256).not.toBe(f.sha256);

    const { parts, notes } = attachFiles(home, [{ sha256: f.sha256.slice(0, 12), uri: 'https://files.example.com/plan' }], []);
    expect(parts).toHaveLength(1);
    expect(notes).toEqual([{ sha256: f.sha256, size: f.size, name: 'plan.pdf', mimeType: 'application/pdf', source: src, uri: 'https://files.example.com/plan', encrypted: true }]);
    const text = describeDraft({ kind: 'artifact', artifact: { artifactId: U(1), parts: [{ kind: 'text', text: 'see file' }, ...parts] }, files: notes });
    for (const s of ['plan.pdf', `${f.size} bytes`, `sha256 ${f.sha256}`, 'at https://files.example.com/plan', `read from ${src}`, 'encrypted']) expect(text).toContain(s);
    expect(text).not.toContain(f.enc!.key);

    // The listing redacts the key from the draft; the text view still describes the file.
    const t = task({ state: 'working' });
    const s: TaskHostState = { v: 1, engine: { ...emptyTaskState(), tasks: { [t.id]: t } }, releases: { [t.id]: { taskId: t.id, peer: PEER, created: 'x', content: { kind: 'artifact', artifact: { artifactId: U(1), parts }, files: notes } } } };
    expect(JSON.stringify(taskListView(t, s))).not.toContain(f.enc!.key);
    expect(taskListText(t, s)).toContain(`sha256 ${f.sha256}`);
    expect(taskListText(t, s)).not.toContain(f.enc!.key);

    // Refused: an unknown or ambiguous prepared file, a non-https URL, an inline file over 16 KiB, a directory.
    expect(() => attachFiles(home, [{ sha256: 'ffffffffffff', uri: 'https://x.example/' }], [])).toThrow(/no prepared file/);
    expect(() => attachFiles(home, [{ sha256: f.sha256, uri: 'http://x.example/' }], [])).toThrow(/file URL refused/);
    expect(() => attachFiles(home, [{ sha256: f.sha256, uri: 'https://u:p@x.example/' }], [])).toThrow(/file URL refused/);
    const big = join(tmp(), 'big.bin');
    writeFileSync(big, Buffer.alloc(16 * 1024 + 1));
    expect(() => attachFiles(home, [], [big])).toThrow(/inline file is at most/);
    expect(() => prepareFile(home, tmp())).toThrow(/not a regular file/);
    expect(() => prepareFile(home, src, { mimeType: 'not a type' })).toThrow(/MIME/);
  });

  it('never sends a file from inside the Rendezvous home (the secret key), by path, by `..` or through a symlink', () => {
    const home = new Home(tmp());
    home.ensureDir();
    writeFileSync(home.agentPath, '{"secretKey":"not really"}');
    const outside = tmp();
    for (const p of [home.agentPath, join(outside, '..', basename(home.dir), 'agent.json')]) {
      expect(() => prepareFile(home, p)).toThrow(/inside a Rendezvous home/);
      expect(() => attachFiles(home, [], [p])).toThrow(/inside a Rendezvous home/);
    }
    const link = join(outside, 'innocent.pdf');
    let linked = false;
    try {
      symlinkSync(home.agentPath, link);
      linked = true;
    } catch {
      /* Windows without the symlink privilege */
    }
    if (linked) {
      expect(() => prepareFile(home, link)).toThrow(/inside a Rendezvous home/);
      expect(() => attachFiles(home, [], [link])).toThrow(/inside a Rendezvous home/);
    }
    expect(existsSync(home.filesPath)).toBe(false);
    // The secret files by name anywhere, and any other folder that looks like a home (another profile).
    const loose = join(tmp(), 'consent.json');
    writeFileSync(loose, '{}');
    expect(() => prepareFile(home, loose)).toThrow(/Rendezvous file/);
    const other = tmp();
    for (const f of ['config.json', 'agent.json', 'tasks.json']) writeFileSync(join(other, f), '{}');
    expect(() => attachFiles(home, [], [join(other, 'tasks.json')])).toThrow(/inside a Rendezvous home/);
    expect(() => prepareFile(home, join(other, 'config.json'))).toThrow(/inside a Rendezvous home/);
  });
});

describe('rdv file (commands)', () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  });
  afterAll(() => relay.close());

  it('prepare, list, the direct-transfer setting, and usage errors; JSON never carries a key', async () => {
    const home = tmp();
    await rdv(['init', '--profile', 'omer', '--email', 'omer@example.com', '--relay', relay.url], home);
    const src = join(tmp(), 'notes.md');
    writeFileSync(src, '# notes');
    const p = (await rdv(['file', 'prepare', src, '--mime', 'text/markdown'], home)).lines[0];
    expect(p).toMatchObject({ event: 'file-prepared', name: 'notes.md', encrypted: true, source: src });
    expect(existsSync(p.upload)).toBe(true);
    const key = JSON.parse(readFileSync(join(home, 'files.json'), 'utf8')).outgoing[p.sha256].enc.key;
    const list = await rdv(['file', 'list'], home);
    expect(list.stdout).not.toContain(key);
    expect(list.lines[0]).toEqual({ event: 'direct-transfer', enabled: false });
    expect(list.lines[1]).toMatchObject({ event: 'file-prepared', sha256: p.sha256 });
    expect((await rdv(['file', 'direct-transfer', 'on'], home)).lines[0]).toEqual({ event: 'direct-transfer', enabled: true });
    expect(JSON.parse(readFileSync(join(home, 'owner.json'), 'utf8')).direct_transfer).toBe(true);
    await rdv(['file', 'direct-transfer', 'off'], home);
    expect(JSON.parse(readFileSync(join(home, 'owner.json'), 'utf8')).direct_transfer).toBeUndefined();
    expect((await rdv(['file', 'direct-transfer', 'maybe'], home, { check: false })).code).toBe(2);
    expect((await rdv(['file', 'fetch', U(5)], home, { check: false })).stderr).toContain(`no task ${U(5)}`);
    expect((await rdv(['file', 'decline-transfer', U(5)], home, { check: false })).stderr).toContain('no direct-transfer request');
    expect((await rdv(['task', 'submit', U(5)], home, { check: false })).code).toBe(2);
    expect((await rdv(['task', 'submit', U(5), '--file', 'nohash'], home, { check: false })).code).toBe(2);
  });
});
