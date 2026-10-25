// SPEC §7.7: file references, their encryption and `rdv/transfer` (issue #26).
import { describe, expect, it } from 'vitest';
import {
  FILES_EXT,
  FileRefError,
  MAX_INLINE_FILE_BYTES,
  MAX_TRANSFER_DATA_BYTES,
  MAX_TRANSFER_MESSAGES,
  b64decode,
  b64encode,
  checkFileUri,
  encryptFile,
  fileRefPart,
  inlineFilePart,
  isBlockedAddress,
  newTransferId,
  parseFilePart,
  parseFileRef,
  parseTransfer,
  plainFileRef,
  sanitizeFileName,
  sha256Hex,
  stepTransfer,
  transferMessage,
  utf8ToBytes,
  verifyAndDecrypt,
  type FileRef,
  type TransferMessage,
  type TransferState,
} from '../src/index.js';

const HASH = 'ab'.repeat(32);
const text = (s: string) => utf8ToBytes(s);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof FileRefError ? e.code : `other: ${(e as Error).message}`;
  }
  return undefined;
}

describe('file encryption and verification', () => {
  const plain = text("Omer's Q4 plan, draft 3");

  it('round-trips: encrypt, then verify and decrypt', () => {
    const { ciphertext, ref } = encryptFile(plain);
    expect(ref.size).toBe(ciphertext.length);
    expect(ref.size).toBe(plain.length + 16);
    expect(ref.sha256).toBe(sha256Hex(ciphertext));
    expect(ref.enc!.alg).toBe('aes256gcm');
    expect(b64decode(ref.enc!.key)).toHaveLength(32);
    expect(b64decode(ref.enc!.nonce)).toHaveLength(12);
    expect(ref.enc!.plain_sha256).toBe(sha256Hex(plain));
    expect(verifyAndDecrypt(ref, ciphertext)).toEqual(plain);
    expect(parseFileRef({ ...ref, uri: 'https://files.example.com/q4' }).ok).toBe(true);
  });

  it('uses a fresh key and nonce for every file', () => {
    const a = encryptFile(plain).ref.enc!;
    const b = encryptFile(plain).ref.enc!;
    expect(a.key).not.toBe(b.key);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('refuses a tampered byte, whether or not the hash was updated', () => {
    const { ciphertext, ref } = encryptFile(plain);
    for (const i of [0, 5, ciphertext.length - 1]) {
      const bad = ciphertext.slice();
      bad[i] ^= 1;
      expect(code(() => verifyAndDecrypt(ref, bad))).toBe('hash-mismatch');
      // An attacker who also controls the reference's hash still fails the GCM tag.
      expect(code(() => verifyAndDecrypt({ ...ref, sha256: sha256Hex(bad) }, bad))).toBe('decrypt-failed');
    }
  });

  it('refuses a wrong hash, length, key, nonce or plaintext hash', () => {
    const { ciphertext, ref } = encryptFile(plain);
    const enc = ref.enc!;
    expect(code(() => verifyAndDecrypt({ ...ref, sha256: HASH }, ciphertext))).toBe('hash-mismatch');
    expect(code(() => verifyAndDecrypt(ref, ciphertext.slice(0, -1)))).toBe('size-mismatch');
    expect(code(() => verifyAndDecrypt({ ...ref, size: ref.size + 1 }, ciphertext))).toBe('size-mismatch');
    const otherKey = b64encode(new Uint8Array(32).fill(7));
    expect(code(() => verifyAndDecrypt({ ...ref, enc: { ...enc, key: otherKey } }, ciphertext))).toBe('decrypt-failed');
    const otherNonce = b64encode(new Uint8Array(12).fill(7));
    expect(code(() => verifyAndDecrypt({ ...ref, enc: { ...enc, nonce: otherNonce } }, ciphertext))).toBe('decrypt-failed');
    expect(code(() => verifyAndDecrypt({ ...ref, enc: { ...enc, plain_sha256: HASH } }, ciphertext))).toBe('plain-hash-mismatch');
    expect(code(() => verifyAndDecrypt({ ...ref, enc: { ...enc, alg: 'aes128gcm' as 'aes256gcm' } }, ciphertext))).toBe('malformed');
  });

  it('binds the associated data: plain AES-GCM without "rdv1/blob" does not open', async () => {
    const { gcm } = await import('@noble/ciphers/aes');
    const { ciphertext, ref } = encryptFile(plain);
    const open = (ad?: Uint8Array) => gcm(b64decode(ref.enc!.key), b64decode(ref.enc!.nonce), ad).decrypt(ciphertext);
    expect(() => open()).toThrow();
    expect(() => open(text('rdv1/envelope'))).toThrow();
    expect(open(text('rdv1/blob'))).toEqual(plain);
  });

  it('verifies a plaintext reference and an empty file', () => {
    expect(verifyAndDecrypt(plainFileRef(plain), plain)).toEqual(plain);
    expect(code(() => verifyAndDecrypt(plainFileRef(plain), text('another file entirely')))).toBe('size-mismatch');
    const empty = encryptFile(new Uint8Array(0));
    expect(verifyAndDecrypt(empty.ref, empty.ciphertext)).toEqual(new Uint8Array(0));
  });
});

describe('file reference validation', () => {
  const good: FileRef = { uri: 'https://files.example.com/q4/3f9a', sha256: HASH, size: 412817, mimeType: 'application/pdf', name: 'q4-plan.pdf' };

  it('accepts the design example, with mirrors, p2p and expires', () => {
    const r = parseFileRef({
      ...good,
      mirrors: ['https://mirror.example.org/3f9a'],
      p2p: ['webrtc-datachannel/1'],
      expires: '2026-11-01T00:00:00Z',
      enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH },
    });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['file:///etc/passwd'],
    ['data:text/plain;base64,aGk='],
    ['javascript:alert(1)'],
    ['http://files.example.com/x'],
    ['ftp://files.example.com/x'],
    ['ws://files.example.com/x'],
    ['blob:https://files.example.com/x'],
    ['https://user:pass@files.example.com/x'],
    ['https://token@files.example.com/x'],
    ['https:\\\\files.example.com\\x'],
    ['https://files.example.com/a b'],
    ['https://files.example.com/x\n'],
    [' https://files.example.com/x'],
    ['https://files.example.com/' + 'a'.repeat(2048)],
    ['//files.example.com/x'],
    ['files.example.com/x'],
    ['https://'],
    [''],
  ])('refuses the uri %s', (uri) => {
    expect(checkFileUri(uri).ok).toBe(false);
    expect(parseFileRef({ ...good, uri }).ok).toBe(false);
  });

  it('accepts https URIs with ports, queries, IP literals and IDNs (the fetch checks the address)', () => {
    for (const uri of ['https://files.example.com:8443/x?sig=abc', 'HTTPS://Files.Example.com/x', 'https://203.0.113.9/x', 'https://[2001:db8::1]/x', 'https://bücher.example/x']) {
      expect(checkFileUri(uri).ok).toBe(true);
    }
  });

  it.each([
    ['sha256 uppercase', { sha256: HASH.toUpperCase() }],
    ['sha256 short', { sha256: 'ab'.repeat(31) }],
    ['sha256 missing', { sha256: undefined }],
    ['size negative', { size: -1 }],
    ['size fractional', { size: 1.5 }],
    ['size string', { size: '10' }],
    ['size huge', { size: 2 ** 41 }],
    ['size missing', { size: undefined }],
    ['mimeType with parameters', { mimeType: 'text/plain; charset=utf-8' }],
    ['mimeType no subtype', { mimeType: 'text' }],
    ['mimeType number', { mimeType: 5 }],
    ['name number', { name: 5 }],
    ['mirrors empty', { mirrors: [] }],
    ['mirrors http', { mirrors: ['http://mirror.example.org/x'] }],
    ['mirrors too many', { mirrors: Array.from({ length: 9 }, (_, i) => `https://m${i}.example.org/x`) }],
    ['mirrors duplicate', { mirrors: ['https://m.example.org/x', 'https://m.example.org/x'] }],
    ['p2p bad name', { p2p: ['WebRTC'] }],
    ['p2p no version', { p2p: ['webrtc-datachannel'] }],
    ['p2p not a list', { p2p: 'webrtc-datachannel/1' }],
    ['expires garbage', { expires: 'next week' }],
    ['unknown key', { extra: true }],
    ['enc alg', { enc: { alg: 'aes-256-gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH } }],
    ['enc short key', { enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(16)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH } }],
    ['enc long nonce', { enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(16)), plain_sha256: HASH } }],
    ['enc no plain hash', { enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)) } }],
    ['enc extra key', { enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH, aad: 'x' } }],
    ['enc key not base64', { enc: { alg: 'aes256gcm', key: '!'.repeat(44), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH } }],
    ['enc on a file shorter than the tag', { size: 15, enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH } }],
  ])('refuses %s', (_label, patch) => {
    expect(parseFileRef({ ...good, ...patch }).ok).toBe(false);
  });

  it('needs a uri unless a direct transfer is offered', () => {
    const { uri: _u, ...noUri } = good;
    expect(parseFileRef(noUri)).toMatchObject({ ok: false, reason: 'neither uri nor p2p' });
    expect(parseFileRef({ ...noUri, p2p: ['webrtc-datachannel/1'] }).ok).toBe(true);
  });

  it('sanitizes file names for display', () => {
    const bidi = String.fromCharCode(0x202e);
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('..\\boot.ini')).toBe('_boot.ini');
    expect(sanitizeFileName(`invoice${bidi}fdp.exe`)).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a\u0000b\u0007c\u001b[31m')).toBe('abc[31m');
    expect(sanitizeFileName('...')).toBeUndefined();
    expect(sanitizeFileName('x'.repeat(5000))).toHaveLength(255);
    expect(sanitizeFileName(42)).toBeUndefined();
    expect(parseFileRef({ ...good, name: '../secret' })).toMatchObject({ ok: true, value: { name: '_secret' } });
    expect(parseFileRef({ ...good, mimeType: 'Application/PDF' })).toMatchObject({ ok: true, value: { mimeType: 'application/pdf' } });
  });

  it('survives a fuzzed reference: never throws, and whatever passes is sound', () => {
    let seed = 0x2026_1025;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    const junk = [
      undefined, null, true, 0, -1, 1.5, NaN, Infinity, 2 ** 53, '', 'x', 'https://ok.example/x', 'file:///x', 'javascript:x',
      HASH, HASH.toUpperCase(), [], [1], ['https://ok.example/x'], {}, { a: 1 }, 'a'.repeat(5000), '\u0000', '../..',
      b64encode(new Uint8Array(32)), b64encode(new Uint8Array(12)), 'webrtc-datachannel/1', ['webrtc-datachannel/1'],
    ];
    const keys = ['uri', 'sha256', 'size', 'mimeType', 'name', 'mirrors', 'p2p', 'expires', 'enc', 'zzz'];
    const base = { ...good, enc: { alg: 'aes256gcm', key: b64encode(new Uint8Array(32)), nonce: b64encode(new Uint8Array(12)), plain_sha256: HASH } };
    for (let i = 0; i < 3000; i++) {
      const ref: Record<string, unknown> = structuredClone(base);
      for (let n = 1 + Math.floor(rand() * 3); n > 0; n--) {
        const k = pick(keys);
        if (k === 'enc' && rand() < 0.5 && typeof ref.enc === 'object' && ref.enc !== null) (ref.enc as Record<string, unknown>)[pick(['alg', 'key', 'nonce', 'plain_sha256', 'x'])] = pick(junk);
        else ref[k] = pick(junk);
      }
      const r = parseFileRef(ref);
      // The same reference as a wire FilePart, through JSON as it arrives.
      const { uri, mimeType, name, ...meta } = ref;
      const p = parseFilePart(JSON.parse(JSON.stringify({ kind: 'file', file: { uri, mimeType, name }, metadata: { [FILES_EXT]: meta } }) ?? 'null'));
      const viaJson = parseFileRef(JSON.parse(JSON.stringify(ref)));
      if (r.ok) {
        expect(r.value.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isSafeInteger(r.value.size) && r.value.size >= 0).toBe(true);
        expect(r.value.uri === undefined || r.value.uri.startsWith('https://')).toBe(true);
        expect(r.value.uri !== undefined || (r.value.p2p ?? []).length > 0).toBe(true);
        expect(() => fileRefPart(r.value)).not.toThrow();
      }
      expect(p.ok).toBe(viaJson.ok);
      if (p.ok && viaJson.ok) expect(p.value).toEqual({ kind: 'ref', ref: viaJson.value });
    }
  });
});

describe('file parts', () => {
  const ref: FileRef = { uri: 'https://files.example.com/q4', sha256: HASH, size: 100, name: 'q4.pdf' };

  it('round-trips a reference through its wire FilePart', () => {
    const part = fileRefPart(ref);
    expect(part).toEqual({ kind: 'file', file: { uri: ref.uri, name: 'q4.pdf' }, metadata: { [FILES_EXT]: { sha256: HASH, size: 100 } } });
    expect(parseFilePart(JSON.parse(JSON.stringify(part)))).toEqual({ ok: true, value: { kind: 'ref', ref } });
  });

  it('ignores other extensions in metadata, but not unknown keys in the file object', () => {
    const part = fileRefPart(ref);
    expect(parseFilePart({ ...part, metadata: { ...part.metadata, 'https://other.example/ext': { anything: 1 } } }).ok).toBe(true);
    expect(parseFilePart({ ...part, file: { ...part.file, path: '/etc' } }).ok).toBe(false);
    expect(parseFilePart({ ...part, extra: 1 }).ok).toBe(false);
  });

  it('refuses a file part with neither inline bytes nor files metadata', () => {
    expect(parseFilePart({ kind: 'file', file: { uri: 'https://files.example.com/q4' } })).toMatchObject({ ok: false });
    expect(parseFilePart({ kind: 'file', file: { uri: 'https://files.example.com/q4' }, metadata: {} })).toMatchObject({ ok: false });
    expect(parseFilePart({ kind: 'file', file: {} })).toMatchObject({ ok: false });
  });

  it('carries small files inline, up to 16 KiB', () => {
    const small = new Uint8Array(MAX_INLINE_FILE_BYTES).fill(1);
    const part = inlineFilePart(small, { mimeType: 'text/plain', name: '/notes.txt' });
    expect(part.file.name).toBe('_notes.txt');
    expect(parseFilePart(part)).toMatchObject({ ok: true, value: { kind: 'inline', bytes: small, mimeType: 'text/plain' } });
    expect(() => inlineFilePart(new Uint8Array(MAX_INLINE_FILE_BYTES + 1))).toThrow(FileRefError);
    const big = b64encode(new Uint8Array(MAX_INLINE_FILE_BYTES + 1));
    expect(parseFilePart({ kind: 'file', file: { bytes: big } })).toMatchObject({ ok: false, reason: 'inline file too large' });
    expect(parseFilePart({ kind: 'file', file: { bytes: '%%%' } }).ok).toBe(false);
    expect(parseFilePart({ kind: 'file', file: { bytes: 'aGk=', uri: 'https://x.example/' } }).ok).toBe(false);
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.168.1.120', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1',
    '64:ff9b:1::1', '2002:7f00:1::', '2002:a00:1::1', '2001::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0',
    'fec0::1', 'ff02::1', '100::1', 'not-an-ip', '', '1.2.3', '01.2.3.4.5',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['1.1.1.1', '8.8.8.8', '93.184.215.14', '100.63.255.255', '172.32.0.1', '192.169.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111', '2a00:1450:4001::200e'])(
    'allows %s',
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('rdv/transfer', () => {
  const id = newTransferId();
  const base = { file: HASH, transfer: id };
  const propose = transferMessage({ ...base, step: 'propose', protocols: ['webrtc-datachannel/1', 'quic-stream/1'] });
  const accept = transferMessage({ ...base, step: 'accept', protocol: 'webrtc-datachannel/1' });
  const signal = transferMessage({ ...base, step: 'signal', data: { sdp: 'v=0 ...', type: 'offer' } });
  const done = transferMessage({ ...base, step: 'done' });

  it('validates each step strictly', () => {
    for (const m of [propose, accept, signal, done, transferMessage({ ...base, step: 'abort', reason: 'owner declined' })]) {
      expect(parseTransfer(JSON.parse(JSON.stringify(m)))).toEqual({ ok: true, message: m });
    }
    expect(parseTransfer({ ...propose, task: 'task-1', expires: '2026-11-01T00:00:00Z', data: {} }).ok).toBe(true);
  });

  it.each([
    ['wrong type', { ...propose, type: 'rdv/transfers' }],
    ['unknown step', { ...propose, step: 'offer' }],
    ['file not a hash', { ...propose, file: 'q4.pdf' }],
    ['transfer not a uuid', { ...propose, transfer: '1' }],
    ['task malformed', { ...propose, task: 'a b' }],
    ['expires malformed', { ...propose, expires: 'soon' }],
    ['propose without protocols', { ...base, type: 'rdv/transfer', step: 'propose' }],
    ['propose with 9 protocols', { ...propose, protocols: Array.from({ length: 9 }, (_, i) => `p${i}/1`) }],
    ['propose with a duplicate', { ...propose, protocols: ['a/1', 'a/1'] }],
    ['propose with a bad name', { ...propose, protocols: ['WebRTC'] }],
    ['propose with protocol', { ...propose, protocol: 'a/1' }],
    ['accept without protocol', { ...base, type: 'rdv/transfer', step: 'accept' }],
    ['accept with protocols', { ...accept, protocols: ['a/1'] }],
    ['signal without data', { ...base, type: 'rdv/transfer', step: 'signal' }],
    ['signal with array data', { ...signal, data: [1] }],
    ['signal with string data', { ...signal, data: 'sdp' }],
    ['done with data', { ...done, data: {} }],
    ['done with reason', { ...done, reason: 'x' }],
    ['abort with data', { ...base, type: 'rdv/transfer', step: 'abort', data: {} }],
    ['abort with a long reason', { ...base, type: 'rdv/transfer', step: 'abort', reason: 'x'.repeat(201) }],
    ['unknown key', { ...done, extra: 1 }],
  ])('refuses %s', (_label, m) => {
    expect(parseTransfer(m).ok).toBe(false);
  });

  it('bounds data at 16 KiB of canonical JSON and limits its depth', () => {
    const fits = { sdp: 'x'.repeat(MAX_TRANSFER_DATA_BYTES - 10) };
    expect(parseTransfer({ ...signal, data: fits }).ok).toBe(true);
    expect(parseTransfer({ ...signal, data: { sdp: 'x'.repeat(MAX_TRANSFER_DATA_BYTES) } })).toMatchObject({ ok: false, reason: 'data too large' });
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i++) deep = { d: deep };
    expect(parseTransfer({ ...signal, data: deep }).ok).toBe(false);
    expect(parseTransfer({ ...signal, data: { n: Infinity } }).ok).toBe(false);
    expect(parseTransfer({ ...signal, data: { d: new Date() } }).ok).toBe(false);
  });

  it('strips control characters from an abort reason', () => {
    const r = parseTransfer({ ...base, type: 'rdv/transfer', step: 'abort', reason: 'no\u0000thanks' + String.fromCharCode(0x202e) });
    expect(r).toMatchObject({ ok: true, message: { reason: 'nothanks' } });
  });

  describe('state machine', () => {
    const supported = ['webrtc-datachannel/1'];
    const run = (msgs: TransferMessage[], sup: readonly string[] = supported) => {
      let s: TransferState | undefined;
      let last;
      for (const m of msgs) {
        last = stepTransfer(s, m, sup);
        if (last.ok) s = last.state;
        else if (last.state) s = last.state;
      }
      return { state: s, last: last! };
    };

    it('runs propose, accept, signals, done', () => {
      const { state, last } = run([propose, accept, signal, signal, done]);
      expect(last.ok).toBe(true);
      expect(state).toMatchObject({ phase: 'done', protocol: 'webrtc-datachannel/1', messages: 5 });
    });

    it('aborts a propose with no protocol in common', () => {
      const r = stepTransfer(undefined, transferMessage({ ...base, step: 'propose', protocols: ['carrier-pigeon/1'] }), supported);
      expect(r).toMatchObject({ ok: false, reason: 'unsupported protocol', state: { phase: 'aborted' }, abort: { step: 'abort', file: HASH, transfer: id } });
    });

    it('aborts an accept of a protocol that was not proposed or is not supported', () => {
      const s = (stepTransfer(undefined, propose, supported) as { state: TransferState }).state;
      expect(stepTransfer(s, transferMessage({ ...base, step: 'accept', protocol: 'other/1' }), supported)).toMatchObject({ ok: false, abort: { step: 'abort' } });
      expect(stepTransfer(s, transferMessage({ ...base, step: 'accept', protocol: 'quic-stream/1' }), supported)).toMatchObject({ ok: false, reason: 'unsupported protocol' });
    });

    it('aborts out-of-order steps', () => {
      expect(run([propose, signal]).last).toMatchObject({ ok: false, reason: 'out of order', abort: { step: 'abort' } });
      expect(run([propose, done]).last).toMatchObject({ ok: false, reason: 'out of order' });
      expect(run([propose, accept, accept]).last).toMatchObject({ ok: false, reason: 'out of order' });
      expect(run([propose, propose]).last).toMatchObject({ ok: false, reason: 'out of order' });
    });

    it('refuses, without a reply, a message for an unknown or finished transfer', () => {
      const r = stepTransfer(undefined, accept, supported);
      expect(r).toEqual({ ok: false, reason: 'unknown transfer' });
      const after = run([propose, accept, done, signal]).last;
      expect(after).toEqual({ ok: false, reason: 'transfer finished' });
      const other = run([propose, transferMessage({ ...base, transfer: newTransferId(), step: 'abort' })]).last;
      expect(other).toEqual({ ok: false, reason: 'not this transfer' });
    });

    it('either side may abort at any open step', () => {
      const abort = transferMessage({ ...base, step: 'abort', reason: 'owner declined' });
      expect(run([propose, abort]).state).toMatchObject({ phase: 'aborted', reason: 'owner declined' });
      expect(run([propose, accept, signal, abort]).state).toMatchObject({ phase: 'aborted' });
    });

    it(`aborts at message ${MAX_TRANSFER_MESSAGES + 1}`, () => {
      const msgs = [propose, accept, ...Array<TransferMessage>(MAX_TRANSFER_MESSAGES - 2).fill(signal)];
      expect(run(msgs).last.ok).toBe(true);
      expect(run([...msgs, signal]).last).toMatchObject({ ok: false, reason: 'too many messages', abort: { step: 'abort' } });
    });
  });
});
