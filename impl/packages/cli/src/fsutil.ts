// Atomic writes and a cross-process lockfile (PLAN §8: state file races).
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
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
  /** What holds a long-lived lock (`rdv listen`, `rdv-mcp`). */
  role?: string;
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
 * Remove a stale lock without racing another waiter (security review L1).
 * Two waiters that both read the same stale content used to both unlink:
 * the second unlink removed the first one's fresh lock. Breaking now needs a
 * short-lived `<lock>.break` (O_EXCL), and the content is re-checked while
 * holding it, so at most one waiter removes a given stale lock and nobody
 * removes a fresh one. A `.break` left by a crash is cleared after 5 s.
 */
export function breakStale(path: string, stale: string): void {
  const breaker = `${path}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(breaker).mtimeMs > 5_000) unlinkSync(breaker);
    } catch {
      // gone meanwhile
    }
    return; // someone else is breaking it; retry the lock
  }
  try {
    if (readFileSync(path, 'utf8') === stale) unlinkSync(path);
  } catch {
    // gone already
  } finally {
    closeSync(fd);
    rmSync(breaker, { force: true });
  }
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
  const mine = lockContent();
  for (;;) {
    if (tryCreate(path, mine)) return releaser(path, mine);
    const stale = staleContent(path, staleMs);
    if (stale !== null) {
      breakStale(path, stale);
      continue;
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(`state is locked by ${describeOwner(path)} (${path})`);
    await sleep(40 + Math.floor(Math.random() * 40));
  }
}

/** Create `path` with O_EXCL holding `mine`; false if it exists. */
function tryCreate(path: string, mine: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, mine);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

/** Idempotent release that removes the lock only while it is still ours; also runs on process exit. */
function releaser(path: string, mine: string): () => void {
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
}

function lockContent(role?: string): string {
  return JSON.stringify({ pid: process.pid, host: hostname(), since: new Date().toISOString(), ...(role ? { role } : {}) } satisfies LockInfo);
}

/**
 * Who holds a long-lived lock now (read-only: nothing is broken or taken),
 * or undefined when it is free, unreadable, or held by a process on this host
 * that is gone. `here`: the holder runs on this host.
 */
export function longLockHolder(path: string): { role?: string; pid: number; host: string; since: string; here: boolean } | undefined {
  let info: LockInfo;
  try {
    info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
  if (typeof info?.pid !== 'number' || typeof info.host !== 'string') return undefined;
  const here = info.host === hostname();
  if (here && !pidAlive(info.pid)) return undefined;
  return { ...(typeof info.role === 'string' ? { role: info.role } : {}), pid: info.pid, host: info.host, since: String(info.since), here };
}

function describeOwner(path: string): string {
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return `${info.role ? `${info.role}, ` : ''}pid ${info.pid} on ${info.host} since ${info.since}`;
  } catch {
    return 'another process';
  }
}

/** How often a long-lived lock's owner touches it; others treat it as stale after LONG_LOCK_STALE_MS without a touch. */
export const LONG_LOCK_HEARTBEAT_MS = 60_000;
export const LONG_LOCK_STALE_MS = 10 * 60_000;

export type LongLock = { release: () => void; owner?: undefined } | { release?: undefined; owner: string };

/**
 * A long-lived exclusive lock (`listener.lock`, issue #9): one attempt, no
 * waiting. Same O_EXCL file and stale rules as `acquireLock` (the owner's pid
 * is gone on this host; or, for an owner on another host sharing the home, no
 * heartbeat for `staleMs`). While held, the file's mtime is touched every
 * `heartbeatMs`, so a live owner's lock never goes stale by age. Returns
 * `{ release }`, or `{ owner }` saying who holds it (`role` names the program).
 */
export function tryLongLock(path: string, role: string, opts: { staleMs?: number; heartbeatMs?: number } = {}): LongLock {
  const staleMs = opts.staleMs ?? LONG_LOCK_STALE_MS;
  const mine = lockContent(role);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreate(path, mine)) {
      const release = releaser(path, mine);
      const beat = setInterval(() => {
        try {
          if (readFileSync(path, 'utf8') === mine) {
            const now = new Date();
            utimesSync(path, now, now);
          }
        } catch {
          // gone: whoever tries next recreates it
        }
      }, opts.heartbeatMs ?? LONG_LOCK_HEARTBEAT_MS);
      beat.unref();
      return {
        release: () => {
          clearInterval(beat);
          release();
        },
      };
    }
    if (!existsSync(path)) continue; // released meanwhile
    const stale = staleContent(path, staleMs);
    if (stale === null) break;
    breakStale(path, stale);
  }
  return { owner: describeOwner(path) };
}
