// Files in tasks between two MCP servers (SPEC §7.7, issue #26). Omer's agent
// asks John's for a document review; John's result carries his file,
// encrypted, as a reference to a store (a local HTTPS server here). The
// release gate on John's side shows the file before it leaves; Omer's agent
// fetches it only when it chooses, verifies and decrypts it, and saves it in
// quarantine. Around it: a tampered file, a fetch before the start gate, SSRF
// through the tool, hostile names, and a direct-transfer request that is
// shown but never acted on.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { FILES_URI, REQUEST_URI } from '@rendezvous/a2a';
import { withAgent } from '@rendezvous/cli/lib';
import { encryptFile, fileRefPart, newTransferId, type Payload, transferMessage } from '@rendezvous/core';
import { startTestFileServer, startTestRelay, type TestFileServer, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rdvArgv } from '../../cli/scenarios/harness.js';
import { type ElicitHandler, INJECTION, makeSide, ok, phraseFromHumanLog, type Side, waitEvent } from './flow.js';

const T = 15_000;
const execFileAsync = promisify(execFile);
const REVIEW_TEXT = '# Q4 plan review\n\nSection 3: the totals do not add up. Two more comments inline.\n';

let relay: TestRelay;
let store: TestFileServer;
let root: string;
let sides: Side[] = [];
beforeAll(async () => {
  relay = await startTestRelay();
  store = await startTestFileServer();
});
afterAll(async () => {
  await relay.close();
  await store.close();
});
afterEach(async () => {
  for (const x of sides) await x.close().catch(() => {});
  sides = [];
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Forms: every one is recorded; contact grants and task gates are approved unless `onTask` says otherwise. */
function forms(onTask?: (p: ElicitRequest['params']) => ElicitResult | Promise<ElicitResult>): { handler: ElicitHandler; asked: string[] } {
  const asked: string[] = [];
  const handler: ElicitHandler = async (p) => {
    asked.push(p.message);
    if (p.message.includes('approve this contact request')) return { action: 'accept', content: { approve: true } };
    return onTask ? onTask(p) : { action: 'accept', content: { approve: true } };
  };
  return { handler, asked };
}

/** Omer and John, contacts, each granting the other request/v1. Omer's agent may fetch from the local store (`omerFetch`). */
async function connected(opts: { omerFetch?: boolean } = {}) {
  root = mkdtempSync(join(tmpdir(), 'rdv-files-'));
  const johnForms = forms();
  const omerForms = forms();
  const fetchOpts = opts.omerFetch === false ? undefined : { ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] };
  const omer = await makeSide('omer', join(root, 'omer'), { elicit: omerForms.handler, fileFetch: fetchOpts });
  const john = await makeSide('john', join(root, 'john'), { elicit: johnForms.handler, fileFetch: { ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] } });
  sides.push(omer, john);
  const tag = randomBytes(3).toString('hex');
  const o = await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
  const j = await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true });
  await ok(john, 'rdv_publish_card');
  await new Promise((r) => setTimeout(r, 300));
  const found = await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
  await ok(omer, 'rdv_request_contact', { target: found.cards[0].agent_id });
  const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
  await ok(john, 'rdv_grant', { request_id: req.request_id, invoke: [REQUEST_URI] });
  await waitEvent(omer, (e) => e.type === 'contact' && e.peer === j.agent_id, 'the grant', T);
  // Omer's human grants John request/v1 too, so John may also ask Omer for tasks.
  await ok(omer, 'rdv_grant', { agent_id: j.agent_id, invoke: [REQUEST_URI] });
  await waitEvent(john, (e) => e.type === 'reverse_grant' && e.peer === o.agent_id, 'the reverse grant', T);
  return { omer, john, omerId: o.agent_id as string, johnId: j.agent_id as string, johnForms, omerForms };
}

const taskEvent = (id: string, kind: string) => (e: { type: string; task_id: string; kind: string }) => e.type === 'task' && e.task_id === id && e.kind === kind;

/** Omer asks John for a review; John's human approves the start (form). Returns the task ID. */
async function startedReview(omer: Side, john: Side, johnId: string): Promise<string> {
  const r = await ok(omer, 'rdv_task', { action: 'request', agent_id: johnId, text: 'Could you review the Q4 plan and send your notes back as a file?' });
  const id = r.task_id as string;
  await waitEvent(john, taskEvent(id, 'start-needed'), 'the start gate', T);
  expect(await ok(john, 'rdv_task', { action: 'approve-start', task_id: id })).toMatchObject({ state: 'working' });
  await waitEvent(omer, (e) => e.type === 'task' && e.task_id === id && e.state === 'working', 'working (omer)', T);
  return id;
}

/** John prepares his review file (encrypted) and uploads the ciphertext to the store. */
async function prepareAndUpload(john: Side, text = REVIEW_TEXT, name = 'q4-review.md') {
  const src = join(root, name);
  writeFileSync(src, text);
  const p = await ok(john, 'rdv_file', { action: 'prepare', path: src, mime_type: 'text/markdown' });
  expect(p).toMatchObject({ encrypted: true, size: Buffer.byteLength(text) + 16 });
  expect(JSON.stringify(p)).not.toMatch(/"key"|nonce/);
  const cipher = new Uint8Array(readFileSync(p.upload_path));
  const url = store.put(`/store/${p.sha256}`, cipher);
  return { src, sha256: p.sha256 as string, url, cipher };
}

/** Send a raw payload from one side's home (a peer that does not run our software's checks). */
async function rawSend(from: Side, to: string, payload: unknown): Promise<void> {
  await withAgent(from.home, (agent) => agent.sendGated(to, payload as Payload));
}

const keyOf = (side: Side, sha: string): string => (JSON.parse(readFileSync(join(side.home.dir, 'files.json'), 'utf8')) as { outgoing: Record<string, { enc: { key: string } }> }).outgoing[sha].enc.key;

describe('a doc review with a file: release gate, then fetch, verify, decrypt (SPEC §7.7)', () => {
  it("John's result carries an encrypted reference; his human sees the file before it leaves; Omer's agent fetches it when it chooses", async () => {
    const { omer, john, johnId, omerId, johnForms } = await connected();
    // Both cards list the files extension.
    expect((john.home.readAgentState() as { card: { capabilities: string[] } }).card.capabilities).toContain(FILES_URI);
    const id = await startedReview(omer, john, johnId);
    const { src, sha256, url, cipher } = await prepareAndUpload(john);
    const key = keyOf(john, sha256);

    // Submitting holds the draft; nothing leaves before John's human releases it.
    const held = await ok(john, 'rdv_task', { action: 'submit', task_id: id, text: 'My notes are in the attached file.', name: 'review', files: [{ sha256, url }] });
    expect(held).toMatchObject({ held_for_release: true });
    expect(held.draft).toContain(sha256);
    await new Promise((r) => setTimeout(r, 300));
    expect((await ok(omer, 'rdv_inbox', { since: 0, limit: 200 })).events.some(taskEvent(id, 'artifact'))).toBe(false);
    expect(store.seen.filter((s) => s.path.includes(sha256))).toEqual([]);

    // The release form: the file's name, size, full hash, where it is stored, the local file it was read from, and who gets it.
    const sent = await ok(john, 'rdv_task', { action: 'approve-release', task_id: id });
    expect(sent).toMatchObject({ state: 'completed' });
    const form = johnForms.asked.at(-1)!;
    expect(form).toContain('send this to the other agent');
    for (const s of ['q4-review.md', `${cipher.length} bytes`, `sha256 ${sha256}`, `at ${url}`, `read from ${src}`, 'encrypted', omerId]) expect(form).toContain(s);
    expect(form).not.toContain(key);
    expect(john.home.readAudit().filter((a) => a.task === id).map((a) => a.gate)).toEqual(['start', 'release']);

    // Omer's side: the result's file is shown (sanitized, never the key) and NOT fetched on arrival.
    const art = await waitEvent(omer, taskEvent(id, 'artifact'), 'the artifact (omer)', T);
    expect(art.files).toHaveLength(1);
    expect(art.files[0]).toMatchObject({ index: 1, name: 'q4-review.md', mime_type: 'text/markdown', size: cipher.length, sha256, encrypted: true, inline: false, host: new URL(url).host });
    expect(art.files[0].url.untrusted_peer_text).toBe(url);
    await waitEvent(omer, taskEvent(id, 'completed'), 'completed (omer)', T);
    expect(store.seen.filter((s) => s.path.includes(sha256))).toEqual([]);
    const status = await ok(omer, 'rdv_task', { action: 'status', task_id: id });
    expect(status.result_files[0]).toMatchObject({ sha256, encrypted: true });

    // The agent chooses to fetch: verified, decrypted, quarantined; short text comes back marked untrusted.
    const got = await ok(omer, 'rdv_file', { action: 'fetch', task_id: id, file: 1 });
    expect(got).toMatchObject({ task_id: id, file: 1, verified: true, decrypted: true, size: Buffer.byteLength(REVIEW_TEXT), name: 'q4-review.md', mime_type: 'text/markdown' });
    expect(got.content.untrusted_peer_text).toContain('the totals do not add up');
    expect(readFileSync(got.saved_path, 'utf8')).toBe(REVIEW_TEXT);
    expect(dirname(got.saved_path)).toBe(join(omer.home.dir, 'files', 'incoming', id));
    expect(basename(got.saved_path)).toMatch(/^[0-9a-f]{12}-q4-review\.md$/);
    if (process.platform !== 'win32') expect(statSync(got.saved_path).mode & 0o777).toBe(0o600);
    // No credentials went to the store.
    const fetches = store.seen.filter((s) => s.path === `/store/${sha256}`);
    expect(fetches).toHaveLength(1);
    for (const h of ['cookie', 'authorization', 'proxy-authorization']) expect(fetches[0].headers[h]).toBeUndefined();

    // The key reached Omer only inside the envelope: never the relay, never either model.
    expect(relay.events.map((e) => e.content).join('')).not.toContain(key);
    const inbox = JSON.stringify((await ok(omer, 'rdv_inbox', { since: 0, limit: 200 })).events);
    expect([...omer.transcript, inbox].join('\n')).not.toContain(key);
    expect(john.transcript.join('\n')).not.toContain(key);
    // Omer's own listing shows the file without its key, too.
    const listed = execFileSync(process.execPath, rdvArgv(['task', 'list', '--json', '--home', omer.home.dir]), { encoding: 'utf8' });
    expect(listed).toContain(sha256);
    expect(listed).not.toContain(key);
  });

  it('a tampered file is refused: nothing saved', async () => {
    const { omer, john, johnId } = await connected();
    const id = await startedReview(omer, john, johnId);
    // The model cannot send the secret key or consent state, by inline_files or prepare, however it names them (security review).
    for (const p of [join(john.home.dir, 'agent.json'), join(john.home.dir, '..', 'john', 'consent.json'), join(john.home.dir, 'config.json'), join(omer.home.dir, 'agent.json')]) {
      const inl = await john.call('rdv_task', { action: 'submit', task_id: id, inline_files: [p] });
      expect(inl.isError, p).toBe(true);
      expect(inl.text).toContain('Rendezvous home');
      const prep = await john.call('rdv_file', { action: 'prepare', path: p });
      expect(prep.isError, p).toBe(true);
      expect(prep.text).toContain('Rendezvous home');
    }
    expect(john.home.readTasks().releases[id]).toBeUndefined();
    expect(existsSync(join(john.home.dir, 'files.json'))).toBe(false);
    const { sha256, url, cipher } = await prepareAndUpload(john);
    await ok(john, 'rdv_task', { action: 'submit', task_id: id, files: [{ sha256, url }] });
    await ok(john, 'rdv_task', { action: 'approve-release', task_id: id });
    await waitEvent(omer, taskEvent(id, 'artifact'), 'the artifact', T);
    const bad = new Uint8Array(cipher);
    bad[bad.length - 20] ^= 1;
    store.put(new URL(url).pathname, bad); // the store (or someone in between) changed the bytes
    const r = await omer.call('rdv_file', { action: 'fetch', task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('hash-mismatch');
    expect(existsSync(join(omer.home.dir, 'files', 'incoming', id))).toBe(false);
    // A shorter body is refused the same way.
    store.put(new URL(url).pathname, cipher.slice(0, 40));
    expect((await omer.call('rdv_file', { action: 'fetch', task_id: id })).text).toMatch(/size|length|mismatch/);
    store.put(new URL(url).pathname, cipher);
    expect((await ok(omer, 'rdv_file', { action: 'fetch', task_id: id })).verified).toBe(true);
  });
});

describe('fetching waits for the start gate', () => {
  it("a file in a peer's task request is not fetched before John's human approves the start, and its form shows the file", async () => {
    const { omer, john, johnId, johnForms, omerForms } = await connected();
    // Omer's human attaches a prepared file to a request from his own terminal.
    const src = join(root, 'brief.txt');
    writeFileSync(src, 'Brief: one page, three sections.');
    const prepared = JSON.parse(execFileSync(process.execPath, rdvArgv(['file', 'prepare', src, '--json', '--home', omer.home.dir]), { encoding: 'utf8' }).trim());
    const url = store.put(`/brief/${prepared.sha256}`, new Uint8Array(readFileSync(prepared.upload)));
    // Async: the test relay runs in this process, so a blocking exec would starve it.
    const { stdout: out } = await execFileAsync(process.execPath, rdvArgv(['task', 'request', johnId, '--text', 'Please read the brief.', '--file', `${prepared.sha256}=${url}`, '--json', '--home', omer.home.dir]), { encoding: 'utf8' });
    // Held for Omer's release (issue #53): nothing has left.
    const heldLine = JSON.parse(out.trim().split('\n')[0]);
    expect(heldLine).toMatchObject({ event: 'task-request-held', peer: johnId, release_code: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(heldLine.files[0]).toMatchObject({ name: 'brief.txt', sha256: prepared.sha256, source: src, uri: url });
    await new Promise((r) => setTimeout(r, 500));
    expect((await ok(john, 'rdv_task', { action: 'list' })).tasks).toEqual([]);
    expect((await ok(omer, 'rdv_task', { action: 'list' })).held_requests).toEqual([expect.objectContaining({ request_id: heldLine.hold, held_for_release: true })]);
    // Omer's human releases it through the approval form, which shows the recipient and the file.
    const released = await ok(omer, 'rdv_task', { action: 'approve-release', task_id: heldLine.hold });
    const relForm = omerForms.asked.at(-1)!;
    for (const s of [johnId, 'brief.txt', `sha256 ${prepared.sha256}`, `at ${url}`, `read from ${src}`]) expect(relForm).toContain(s);
    const id = released.task_id as string;
    expect(omer.home.readTasks().requests).toBeUndefined();
    const recv = await waitEvent(john, taskEvent(id, 'received'), 'the request', T);
    expect(recv.files[0]).toMatchObject({ name: 'brief.txt', sha256: prepared.sha256, encrypted: true });

    // The model tries to fetch first: refused, and nothing reached the store.
    const early = await john.call('rdv_file', { action: 'fetch', task_id: id });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('has not been started');
    expect(store.seen.filter((s) => s.path.startsWith('/brief/'))).toEqual([]);
    // The CLI refuses the same way.
    let cliErr = '';
    try {
      execFileSync(process.execPath, rdvArgv(['file', 'fetch', id, '--home', john.home.dir]), { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      cliErr = String((err as { stderr?: string }).stderr);
    }
    expect(cliErr).toContain('has not been started');

    // The start form shows the file (name, size, hash, URL); once approved, the agent may fetch.
    await ok(john, 'rdv_task', { action: 'approve-start', task_id: id });
    const form = johnForms.asked.at(-1)!;
    for (const s of ['brief.txt', `sha256 ${prepared.sha256}`, `at ${url}`, `${prepared.size} bytes`]) expect(form).toContain(s);
    const got = await ok(john, 'rdv_file', { action: 'fetch', task_id: id, sha256: prepared.sha256.slice(0, 12) });
    expect(readFileSync(got.saved_path, 'utf8')).toBe('Brief: one page, three sections.');

    // An inline file changed after the human saw it: the release is refused, in the form path and the terminal, and nothing leaves.
    const note = join(root, 'note.txt');
    writeFileSync(note, 'v1');
    const { stdout: out2 } = await execFileAsync(process.execPath, rdvArgv(['task', 'request', johnId, '--text', 'And this note.', '--inline', note, '--json', '--home', omer.home.dir]), { encoding: 'utf8' });
    const held2 = JSON.parse(out2.trim().split('\n')[0]);
    writeFileSync(note, 'v2, written after it was shown');
    const refused = await omer.call('rdv_task', { action: 'approve-release', task_id: held2.hold });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/changed since you reviewed it.*Nothing was sent/);
    const viaCli = await execFileAsync(process.execPath, rdvArgv(['task', 'release', held2.hold, '--code', held2.release_code, '--home', omer.home.dir]), { encoding: 'utf8' }).catch((e: { stderr: string }) => e);
    expect(String((viaCli as { stderr?: string }).stderr)).toContain('changed since you reviewed it');
    // A wrong code never sends either; dropping it is reduce-only.
    writeFileSync(note, 'v1');
    const wrong = await execFileAsync(process.execPath, rdvArgv(['task', 'release', held2.hold, '--code', '000000000000', '--home', omer.home.dir]), { encoding: 'utf8' }).catch((e: { stderr: string }) => e);
    expect(String((wrong as { stderr?: string }).stderr)).toContain('not the one you reviewed');
    expect((await ok(omer, 'rdv_task', { action: 'cancel', task_id: held2.hold })).state).toBe('dropped');
    expect(omer.home.readTasks().requests).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect((await ok(john, 'rdv_task', { action: 'list' })).tasks).toHaveLength(1);
  });
});

describe('SSRF through the tool path: a peer URL never reaches a private address', () => {
  it('loopback, metadata, private and credentialed URLs are refused, and nothing connects', async () => {
    const { omer, john, johnId } = await connected({ omerFetch: false });
    const id = await startedReview(omer, john, johnId);
    const { sha256, url } = await prepareAndUpload(john);
    // A URL with a user name is refused when John's agent attaches it (we never send credentials, nor ask a peer to).
    const cred = await john.call('rdv_task', { action: 'submit', task_id: id, files: [{ sha256, url: 'https://user:pw@files.example.com/x' }] });
    expect(cred.isError).toBe(true);
    expect(cred.text).toContain('file URL refused');
    const http = await john.call('rdv_task', { action: 'submit', task_id: id, files: [{ sha256, url: 'http://files.example.com/x' }] });
    expect(http.isError).toBe(true);
    // One result with five references: the real store on 127.0.0.1, a name for loopback, cloud metadata, a private and a mapped address.
    const targets = [url, url.replace('127.0.0.1', 'localhost'), 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.7/q4', 'https://[::ffff:127.0.0.1]/q4'];
    await ok(john, 'rdv_task', { action: 'submit', task_id: id, files: targets.map((u) => ({ sha256, url: u })) });
    await ok(john, 'rdv_task', { action: 'approve-release', task_id: id });
    const art = await waitEvent(omer, taskEvent(id, 'artifact'), 'the artifact', T);
    expect(art.files).toHaveLength(5);
    const before = store.seen.length;
    for (let i = 1; i <= 5; i++) {
      const r = await omer.call('rdv_file', { action: 'fetch', task_id: id, file: i });
      expect(r.isError, `file ${i}: ${r.text}`).toBe(true);
      expect(r.text).toMatch(/fetch refused \((blocked|blocked-address|address|resolve|private)[a-z-]*\)/);
    }
    expect(store.seen.length).toBe(before);
  });
});

describe('hostile file names and malformed parts from a peer', () => {
  it('names are sanitized and quarantined; the saved file gets a safe name; parts without a hash are refused', async () => {
    const { omer, john, johnId, omerId } = await connected();
    const id = await startedReview(omer, john, johnId);
    const contextId = omer.home.readTasks().engine.tasks[id].contextId;
    const plain = new TextEncoder().encode('MZ pretend binary');
    const { ciphertext, ref } = encryptFile(plain);
    const url = store.put(`/evil/${ref.sha256}`, ciphertext);
    const artifact = (parts: unknown[]) => ({ type: 'a2a/artifact-update', update: { kind: 'artifact-update', taskId: id, contextId, artifact: { artifactId: randomUUID(), parts } } });
    const evil = `../../.ssh/authorized_keys\u202egpj.exe`;
    const part = fileRefPart({ ...ref, uri: url, name: 'x' });
    (part.file as { name?: string }).name = evil; // a peer that skips sanitizing
    (part.file as { mimeType?: string }).mimeType = 'Application/X-MSDownload';
    await rawSend(john, omerId, artifact([part]));
    const ev = await waitEvent(omer, taskEvent(id, 'artifact'), 'the artifact', T);
    const shown = JSON.stringify(ev.files[0].name);
    expect(shown).not.toContain('/');
    expect(shown).not.toContain('\u202e');
    expect(ev.files[0].mime_type).toBe('application/x-msdownload');
    const got = await ok(omer, 'rdv_file', { action: 'fetch', task_id: id });
    const name = basename(got.saved_path);
    expect(dirname(got.saved_path)).toBe(join(omer.home.dir, 'files', 'incoming', id));
    expect(name).toMatch(/^[0-9a-f]{12}-[A-Za-z0-9._ -]+\.exe\.quarantine$/);
    expect(name).not.toMatch(/^\.|\.\./);
    if (process.platform !== 'win32') expect(statSync(got.saved_path).mode & 0o111).toBe(0);
    expect(readdirSync(join(omer.home.dir, 'files', 'incoming', id))).toEqual([name]);

    // A name that is a sentence (prose aimed at the model) is quarantined, not passed as structure.
    const prose = fileRefPart({ ...ref, uri: url, name: `${INJECTION} report.pdf` });
    await rawSend(john, omerId, artifact([prose]));
    const ev2 = await waitEvent(omer, (e) => taskEvent(id, 'artifact')(e) && String(e.files?.[0]?.name?.untrusted_peer_text).includes('report.pdf'), 'the prose-named artifact', T);
    expect(ev2.files[0].name.untrusted_peer_text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(ev2.files[0].name.untrusted_peer_text).not.toContain('\u001b');

    // Parts without a hash to check, with a bad hash, or with an unknown key are refused whole: nothing is stored.
    const n = (omer.home.readTasks().received ?? {})[id]?.files.length;
    for (const bad of [
      { kind: 'file', file: { uri: url, name: 'nohash.pdf' } },
      { kind: 'file', file: { uri: url }, metadata: { [FILES_URI]: { sha256: 'AB'.repeat(32), size: 10 } } },
      { kind: 'file', file: { uri: url }, metadata: { [FILES_URI]: { sha256: ref.sha256, size: ref.size, owner: 'x' } } },
      { kind: 'file', file: { uri: 'file:///etc/passwd' }, metadata: { [FILES_URI]: { sha256: ref.sha256, size: ref.size } } },
    ]) {
      await rawSend(john, omerId, artifact([bad]));
    }
    await new Promise((r) => setTimeout(r, 800));
    expect((omer.home.readTasks().received ?? {})[id]?.files.length).toBe(n);
    const events = (await ok(omer, 'rdv_inbox', { since: 0, limit: 200 })).events;
    expect(events.filter((e: { type: string; kind: string; task_id: string }) => e.type === 'task' && e.kind === 'invalid' && e.task_id === id).length).toBeGreaterThanOrEqual(4);
  });
});

describe('direct transfer: an offer is shown, never acted on automatically', () => {
  it('a p2p-only file is shown and not fetched; a transfer request is declined while the setting is off, and shown to the owner when on', async () => {
    const { omer, john, johnId, omerId } = await connected();
    const id = await startedReview(omer, john, johnId);
    const contextId = omer.home.readTasks().engine.tasks[id].contextId;
    const { ref } = encryptFile(new TextEncoder().encode('big file'));
    // A file offered only by direct transfer.
    await rawSend(john, omerId, {
      type: 'a2a/artifact-update',
      update: { kind: 'artifact-update', taskId: id, contextId, artifact: { artifactId: randomUUID(), parts: [fileRefPart({ ...ref, p2p: ['webrtc-datachannel/1'], name: 'big.iso' })] } },
    });
    const ev = await waitEvent(omer, taskEvent(id, 'artifact'), 'the p2p artifact', T);
    expect(ev.files[0]).toMatchObject({ direct_transfer_offered: ['webrtc-datachannel/1'], name: 'big.iso' });
    expect(ev.files[0].url).toBeUndefined();
    const r = await omer.call('rdv_file', { action: 'fetch', task_id: id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('offered only by direct transfer');
    // Nothing went back to John on its own: no rdv/transfer at all.
    await new Promise((r) => setTimeout(r, 500));
    const fromOmer = () => john.home.readInbox().filter((e) => e.from === omerId && (e.payload as { type?: string }).type === 'rdv/transfer');
    expect(fromOmer()).toEqual([]);

    // John asks Omer's agent for a direct transfer of one of Omer's files: declined at once (the setting is off by default).
    const t1 = newTransferId();
    await rawSend(john, omerId, transferMessage({ file: ref.sha256, transfer: t1, step: 'propose', protocols: ['webrtc-datachannel/1'], task: id }));
    const d = await waitEvent(omer, (e) => e.type === 'transfer' && e.transfer_id === t1, 'the declined transfer', T);
    expect(d).toMatchObject({ kind: 'declined', auto_declined: true, peer: johnId });
    const deadline = Date.now() + T;
    while (fromOmer().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(fromOmer().map((e) => e.payload)).toEqual([expect.objectContaining({ step: 'abort', transfer: t1, reason: 'direct transfer is off' })]);
    // The raw message is not shown to the model as well.
    expect((await ok(omer, 'rdv_inbox', { since: 0, limit: 200 })).events.filter((e: { type: string; payload_type?: string }) => e.type === 'message')).toEqual([]);

    // The model cannot turn the setting on: it is the human's (the consent guard blocks the command). The human does.
    // A setting written without the agent key (a model, a script) is ignored: the next request is still declined.
    writeFileSync(join(omer.home.dir, 'owner.json'), JSON.stringify({ v: 1, direct_transfer: true, mac: 'ab'.repeat(32) }));
    const t0 = newTransferId();
    await rawSend(john, omerId, transferMessage({ file: ref.sha256, transfer: t0, step: 'propose', protocols: ['webrtc-datachannel/1'] }));
    expect(await waitEvent(omer, (e) => e.type === 'transfer' && e.transfer_id === t0, 'the forged-setting transfer', T)).toMatchObject({ kind: 'declined', auto_declined: true });
    while (fromOmer().length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(fromOmer()[1].payload).toMatchObject({ step: 'abort', transfer: t0, reason: 'direct transfer is off' });
    expect(omer.humanLog.join('\n')).toContain('not signed by this agent');
    execFileSync(process.execPath, rdvArgv(['file', 'direct-transfer', 'on', '--home', omer.home.dir]), { encoding: 'utf8' });
    const t2 = newTransferId();
    await rawSend(john, omerId, transferMessage({ file: ref.sha256, transfer: t2, step: 'propose', protocols: ['webrtc-datachannel/1'] }));
    const p = await waitEvent(omer, (e) => e.type === 'transfer' && e.transfer_id === t2, 'the proposed transfer', T);
    expect(p).toMatchObject({ kind: 'proposed', protocols: ['webrtc-datachannel/1'] });
    expect(p.next_step).toContain('decline-transfer');
    await new Promise((r) => setTimeout(r, 500));
    expect(fromOmer()).toHaveLength(2); // nothing more sent, nothing connected
    expect((await ok(omer, 'rdv_file', { action: 'list' })).transfers).toEqual(expect.arrayContaining([expect.objectContaining({ transfer_id: t2, phase: 'proposed' })]));

    // The human says no through the model: the abort goes out.
    expect(await ok(omer, 'rdv_file', { action: 'decline-transfer', transfer_id: t2 })).toMatchObject({ declined: true });
    while (fromOmer().length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(fromOmer()[2].payload).toMatchObject({ step: 'abort', transfer: t2, reason: 'declined by the owner' });
    expect((await omer.call('rdv_file', { action: 'decline-transfer', transfer_id: t2 })).isError).toBe(true);
    // A message for an unknown transfer is ignored: no reply.
    await rawSend(john, omerId, transferMessage({ file: ref.sha256, transfer: newTransferId(), step: 'accept', protocol: 'webrtc-datachannel/1' }));
    await new Promise((r) => setTimeout(r, 500));
    expect(fromOmer()).toHaveLength(3);
  });
});

describe('phrases still never reach the model', () => {
  it('a release with a file by confirm phrase: the human log shows the file; the model never sees the phrase', async () => {
    // John without forms: the phrase path.
    root = mkdtempSync(join(tmpdir(), 'rdv-files-'));
    const omer = await makeSide('omer', join(root, 'omer'), { fileFetch: { ca: store.ca, unsafeAllowAddresses: ['127.0.0.1'] } });
    const john = await makeSide('john', join(root, 'john'));
    sides.push(omer, john);
    const tag = randomBytes(3).toString('hex');
    await ok(omer, 'rdv_init', { profile: 'omer', email: `omer+${tag}@example.com`, relays: [relay.url] });
    const j = await ok(john, 'rdv_init', { profile: 'john', email: `john+${tag}@doe.com`, relays: [relay.url], public_pointer: true });
    await ok(john, 'rdv_publish_card');
    await new Promise((r) => setTimeout(r, 300));
    const found = await ok(omer, 'rdv_discover', { address: `john+${tag}@doe.com` });
    await ok(omer, 'rdv_request_contact', { target: found.cards[0].agent_id });
    const req = await waitEvent(john, (e) => e.type === 'contact_request', 'the request', T);
    expect((await john.call('rdv_grant', { request_id: req.request_id, invoke: [REQUEST_URI] })).isError).toBe(true);
    await ok(john, 'rdv_grant', { request_id: req.request_id, invoke: [REQUEST_URI], confirm_phrase: phraseFromHumanLog(john, req.request_id) });
    await waitEvent(omer, (e) => e.type === 'contact' && e.peer === j.agent_id, 'the grant', T);
    const r = await ok(omer, 'rdv_task', { action: 'request', agent_id: j.agent_id, text: 'Review, please.' });
    const id = r.task_id as string;
    await waitEvent(john, taskEvent(id, 'start-needed'), 'the start gate', T);
    expect((await john.call('rdv_task', { action: 'approve-start', task_id: id })).isError).toBe(true);
    await ok(john, 'rdv_task', { action: 'approve-start', task_id: id, confirm_phrase: phraseFromHumanLog(john, id) });
    const { sha256, url, src } = await prepareAndUpload(john);
    await ok(john, 'rdv_task', { action: 'submit', task_id: id, files: [{ sha256, url }] });
    const line = john.humanLog.filter((l) => l.includes(id) && l.includes('confirm phrase')).at(-1)!;
    for (const s of [sha256, url, src, 'q4-review.md']) expect(line).toContain(s);
    const phrase = phraseFromHumanLog(john, id);
    await ok(john, 'rdv_task', { action: 'approve-release', task_id: id, confirm_phrase: phrase });
    await waitEvent(omer, taskEvent(id, 'artifact'), 'the artifact', T);
    expect((await ok(omer, 'rdv_file', { action: 'fetch', task_id: id })).verified).toBe(true);
    expect(john.transcript.join('\n')).not.toContain(phrase);
  });
});
