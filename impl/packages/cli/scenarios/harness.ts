// Drives real `rdv` processes (node dist/src/bin.js), each with its own home.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Works from scenarios/*.ts (vitest) and from dist/scenarios/*.js (node).
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = basename(dirname(here)) === 'dist' ? dirname(dirname(here)) : dirname(here);
export const RDV_BIN = join(pkgRoot, 'dist', 'src', 'bin.js');

export type Line = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RunResult {
  code: number;
  lines: Line[];
  stdout: string;
  stderr: string;
}

/** Run one `rdv` command with --json and --home, and parse its JSON lines. */
export function rdv(args: string[], home: string, opts: { timeoutMs?: number; check?: boolean } = {}): Promise<RunResult> {
  const full = [...args, '--home', home, ...(args.includes('--json') ? [] : ['--json'])];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [RDV_BIN, ...full],
      { timeout: opts.timeoutMs ?? 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const lines = stdout
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Line);
        const result = { code, lines, stdout, stderr };
        if (code !== 0 && opts.check !== false) {
          reject(new Error(`rdv ${args.join(' ')} exited ${code}: ${stderr.trim() || err?.message}`));
        } else resolve(result);
      },
    );
  });
}

/** A long-running `rdv listen --json` whose events can be awaited. */
export class Listener {
  readonly lines: Line[] = [];
  private waiters: Array<{ pred: (l: Line) => boolean; resolve: (l: Line) => void }> = [];
  private stderr = '';
  private exited: number | null = null;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(
    readonly name: string,
    home: string,
    extraArgs: string[] = [],
  ) {
    this.child = spawn(process.execPath, [RDV_BIN, 'listen', '--json', '--home', home, ...extraArgs], {
      windowsHide: true,
    });
    createInterface({ input: this.child.stdout }).on('line', (text) => {
      let line: Line;
      try {
        line = JSON.parse(text) as Line;
      } catch {
        return;
      }
      this.lines.push(line);
      this.waiters = this.waiters.filter((w) => (w.pred(line) ? (w.resolve(line), false) : true));
    });
    this.child.stderr.on('data', (d) => (this.stderr += String(d)));
    this.child.on('exit', (code) => (this.exited = code ?? -1));
  }

  waitFor(pred: (l: Line) => boolean, what: string, timeoutMs: number): Promise<Line> {
    const hit = this.lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        const status = this.exited !== null ? ` (listener exited ${this.exited})` : '';
        reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what}${status}\nstderr: ${this.stderr.trim()}`));
      }, timeoutMs);
      const done = (l: Line) => {
        clearTimeout(t);
        resolve(l);
      };
      this.waiters.push({ pred, resolve: done });
    });
  }

  stop(): Promise<void> {
    if (this.exited !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill();
    });
  }
}

/** Poll `fn` until it returns a value, or fail after `timeoutMs`. */
export async function until<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}
