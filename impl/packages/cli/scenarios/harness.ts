// Drives real `rdv` processes (node dist/src/bin.js), each with its own home.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { humanOnlyArgv } from '../src/main.js';

// Works from scenarios/*.ts (vitest) and from dist/scenarios/*.js (node).
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = basename(dirname(here)) === 'dist' ? dirname(dirname(here)) : dirname(here);
export const RDV_BIN = join(pkgRoot, 'dist', 'src', 'bin.js');
const RDV_MAIN = pathToFileURL(join(pkgRoot, 'dist', 'src', 'main.js')).href;
const SAFE_CONSOLE = pathToFileURL(createRequire(import.meta.url).resolve('@rendezvous/core/safe-console')).href;

/**
 * The human-only commands need an interactive terminal (issue #126), and a spawned rdv has none. The scenarios and
 * tests stand in for the human at a terminal: those commands run, in a process of their own like any other, through
 * `main`'s in-process `interactive` option (what bin.js does, plus that option). It is code in this file, passed to
 * `node -e`: no flag, variable or file of rdv's turns the check off. Every other command runs bin.js itself.
 */
const AS_HUMAN = [
  '--input-type=module',
  '-e',
  [
    `await import(${JSON.stringify(SAFE_CONSOLE)});`,
    `const { main } = await import(${JSON.stringify(RDV_MAIN)});`,
    'const code = await main(process.argv.slice(1), { interactive: () => true });',
    "await new Promise((r) => process.stdout.write('', () => r()));",
    "await new Promise((r) => process.stderr.write('', () => r()));",
    'process.exit(code);',
  ].join(' '),
  '--',
];

/** node's arguments for `rdv <args>`: bin.js, or for a human-only command the stand-in for the human's terminal (AS_HUMAN). */
export function rdvArgv(args: string[]): string[] {
  if (humanOnlyArgv(args) === undefined) return [RDV_BIN, ...args];
  assertTempHome(args);
  return [...AS_HUMAN, ...args];
}

/** The real path of the nearest existing ancestor of `p`, with the rest appended (the home may not exist yet). */
function realish(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realish(parent), basename(abs));
  }
}

/**
 * This file ships in @rendezvous/cli and stands in for the human's terminal, so it must never act on a real home:
 * the gated path refuses any --home (or $RDV_HOME) that is not under os.tmpdir() (issue #126).
 */
function assertTempHome(args: string[]): void {
  const i = args.lastIndexOf('--home');
  const home = i >= 0 ? args[i + 1] : process.env.RDV_HOME;
  if (!home) throw new Error('the scenario harness runs human-only commands only on an explicit temporary --home');
  const tmp = realish(tmpdir());
  const real = realish(home);
  if (real !== tmp && !real.startsWith(tmp.endsWith(sep) ? tmp : tmp + sep)) {
    throw new Error(`the scenario harness refuses a home outside ${tmp}: ${home}`);
  }
}

export type Line = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RunResult {
  code: number;
  lines: Line[];
  stdout: string;
  stderr: string;
}

/** Run one `rdv` command with --json and --home, and parse its JSON lines. */
export function rdv(
  args: string[],
  home: string,
  opts: { timeoutMs?: number; check?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const full = [...args, '--home', home, ...(args.includes('--json') ? [] : ['--json'])];
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      rdvArgv(full),
      { timeout: opts.timeoutMs ?? 30_000, windowsHide: true, env: opts.env ? { ...process.env, ...opts.env } : undefined },
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
  private exitCode: number | null = null;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(
    readonly name: string,
    home: string,
    extraArgs: string[] = [],
    env?: NodeJS.ProcessEnv,
  ) {
    this.child = spawn(process.execPath, rdvArgv(['listen', '--json', '--home', home, ...extraArgs]), {
      windowsHide: true,
      env: env ? { ...process.env, ...env } : undefined,
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
    this.child.on('exit', (code) => (this.exitCode = code ?? -1));
  }

  waitFor(pred: (l: Line) => boolean, what: string, timeoutMs: number): Promise<Line> {
    const hit = this.lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        const status = this.exitCode !== null ? ` (listener exited ${this.exitCode})` : '';
        reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what}${status}\nstderr: ${this.stderr.trim()}`));
      }, timeoutMs);
      const done = (l: Line) => {
        clearTimeout(t);
        resolve(l);
      };
      this.waiters.push({ pred, resolve: done });
    });
  }

  /** Resolves with the exit code once the process has exited. */
  exited(timeoutMs: number): Promise<number> {
    if (this.exitCode !== null) return Promise.resolve(this.exitCode);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: still running after ${timeoutMs} ms`)), timeoutMs);
      this.child.once('exit', (code) => {
        clearTimeout(t);
        resolve(code ?? -1);
      });
    });
  }

  stop(): Promise<void> {
    if (this.exitCode !== null) return Promise.resolve();
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
