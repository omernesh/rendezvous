// Atomic writes and a cross-process lockfile (PLAN §8: state file races).
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write to a temp file in the same directory, fsync it, then rename over the
 * target and fsync the directory, so a reader (or a crash, or a power cut)
 * never sees a half-written or empty file (security review M3). `mode` is
 * applied where the OS supports POSIX permissions; on Windows it is best
 * effort.
 */
export function writeAtomic(path: string, data: string, mode = 0o644): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    // Windows can refuse the rename briefly while another process (or an
    // antivirus scanner) has the target open.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
        sleepSync(25);
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dirname(path));
  try {
    chmodSync(path, mode);
  } catch {
    // not supported (e.g. some Windows filesystems)
  }
}

/** Make a rename durable (POSIX). Windows can't open a directory for fsync; NTFS journals the rename. */
function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // some filesystems refuse directory fsync
  }
}

export class LockTimeoutError extends Error {}

interface LockInfo {
  pid: number;
  host: string;
  since: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock is stale if its owner on this host is gone, or it is older than `staleMs`. */
function staleContent(path: string, staleMs: number): string | null {
  let raw: string;
  let age: number;
  try {
    raw = readFileSync(path, 'utf8');
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return null; // vanished meanwhile: just retry
  }
  let info: LockInfo | undefined;
  try {
    info = JSON.parse(raw) as LockInfo;
  } catch {
    // Empty or partial: the owner may be between open and write. Give it a moment.
    return age > 5_000 ? raw : null;
  }
  if (info.host === hostname() && !pidAlive(info.pid)) return raw;
  return age > staleMs ? raw : null;
}

/**
 * Take an exclusive lock by creating `path` with O_EXCL. Waits up to
 * `timeoutMs`, breaking locks left behind by dead processes. Returns a
 * release function (idempotent; also runs on process exit).
 */
export async function acquireLock(
  path: string,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const deadline = Date.now() + timeoutMs;
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString() } satisfies LockInfo);
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try {
          if (readFileSync(path, 'utf8') === mine) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const stale = staleContent(path, staleMs);
    if (stale !== null) {
      // Re-check right before removing so we don't delete a lock someone else just took.
      try {
        if (readFileSync(path, 'utf8') === stale) unlinkSync(path);
      } catch {
        // gone already
      }
      continue;
    }
    if (Date.now() >= deadline) {
      let owner = 'another process';
      try {
        const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
        owner = `pid ${info.pid} on ${info.host} since ${info.since}`;
      } catch {
        // unreadable
      }
      throw new LockTimeoutError(`state is locked by ${owner} (${path})`);
    }
    await sleep(40 + Math.floor(Math.random() * 40));
  }
}
