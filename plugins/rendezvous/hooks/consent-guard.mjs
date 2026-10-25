#!/usr/bin/env node
// PreToolUse hook: keeps the assistant away from the Rendezvous commands and
// files that belong to the human. Consent (granting a contact, confirming a
// probe answer or a meeting, canceling an agreed one, auto-grant/auto-confirm
// listeners), the commands that show confirm phrases (`rdv contact pending`,
// `rdv dinner list`), re-keying (`rdv init --force`), and the secret key and
// consent state (`agent.json`, `agent.json.bak`, `consent.json`) in the
// Rendezvous home, through any tool.
//
// Defence in depth, NOT a security boundary. It parses commands the way a
// shell would (quotes, escapes, comments, `$(...)`, backticks, `bash -c`,
// npx/pnpm/yarn) so that a drifting or prompt-injected assistant fails loudly,
// but a model with a shell can always build a command the guard can't see
// (a script file, another interpreter, an alias defined earlier). The
// security boundary is the MCP consent gate: rdv_grant and rdv_negotiate need
// the human's form or confirm phrase (NOTES 57, 62), and only a hash of each
// phrase is ever stored.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SECRET_FILES = ['agent.json', 'agent.json.bak', 'consent.json'];
const SECRET_MENTION = /agent\.json|consent\.json/i;
/** Stands for the output of a `$(...)` or backtick substitution: unknown when the hook runs. */
const SUB = '\u0000';
const MAX_DEPTH = 6;

const SECRET_REFUSAL =
  'That names the Rendezvous secret key or consent file (agent.json, agent.json.bak, consent.json). Never read, write, copy or print it; use rdv_status for the agent ID and fingerprint.';
const HOME_REFUSAL =
  'That reaches into a Rendezvous home, which holds the secret key and consent state. Do not search, glob, copy or read it as a whole; use rdv_status, rdv_pending_requests and rdv_inbox.';
const HUMAN_ONLY =
  'That Rendezvous command is for the human, in their own terminal. Use the MCP tools: rdv_grant and rdv_negotiate ask the human through an approval form or a confirm phrase they type to you.';
const PENDING =
  'rdv contact pending is for the human, in their own terminal (it shows confirm phrases meant only for them). Use the rdv_pending_requests tool.';
const DINNER_LIST =
  'rdv dinner list is for the human, in their own terminal (it shows confirm phrases meant only for them). Use rdv_negotiate with action "status".';
const OPAQUE =
  'That command builds a Rendezvous subcommand or path at run time, so the consent guard cannot check it. Spell it out, or use the rdv_* MCP tools.';
const NESTED = 'That command nests too deeply for the consent guard to check. Spell it out.';

class Refusal extends Error {}

// --- shell-style tokenizer ------------------------------------------------------

/** Index just past the `)` that closes the `(` before `start`, skipping quoted text. */
function closeParen(src, start, mode) {
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === (mode === 'ps' ? '`' : '\\')) i++;
    else if (c === "'") i = Math.max(i, src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1));
    else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === (mode === 'ps' ? '`' : '\\')) i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

/**
 * Split `src` into simple commands (arrays of words), as a POSIX shell
 * (`mode` "sh") or PowerShell ("ps") would: quotes removed, escapes applied,
 * comments dropped, and each `$(...)`, `@(...)`, `<(...)` or backtick
 * substitution parsed as commands of its own (its place in the word becomes SUB).
 */
export function parseCommands(src, mode = 'sh', depth = 0) {
  if (depth > MAX_DEPTH) throw new Refusal(NESTED);
  const esc = mode === 'ps' ? '`' : '\\';
  const cmds = [];
  let words = [];
  let cur = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  const sub = (inner) => {
    cmds.push(...parseCommands(inner, mode, depth + 1));
    cur += SUB;
    inWord = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === esc) {
      if (next === '\n') i++;
      else if (next === '\r' && src[i + 2] === '\n') i += 2;
      else if (next !== undefined) {
        cur += next;
        inWord = true;
        i++;
      }
      continue;
    }
    if ((c === '$' || c === '@' || c === '<' || c === '>') && next === '(') {
      const end = closeParen(src, i + 2, mode);
      sub(src.slice(i + 2, end));
      i = end;
      continue;
    }
    if (c === '`' && mode === 'sh') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      sub(src.slice(i + 1, j));
      i = j;
      continue;
    }
    if (c === '#' && !inWord) {
      const j = src.indexOf('\n', i);
      i = (j < 0 ? src.length : j) - 1;
      continue;
    }
    if (mode === 'ps' && c === '<' && next === '#') {
      const j = src.indexOf('#>', i + 2);
      i = j < 0 ? src.length : j + 1;
      continue;
    }
    if (c === "'") {
      inWord = true;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] !== "'") cur += src[j];
        else if (mode === 'ps' && src[j + 1] === "'") {
          cur += "'";
          j++;
        } else break;
      }
      i = j;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        const d = src[j];
        if (d === esc && j + 1 < src.length) {
          const e = src[j + 1];
          if (mode === 'ps' || '$`"\\\n'.includes(e)) {
            if (e !== '\n') cur += e;
          } else cur += d + e;
          j++;
        } else if (d === '$' && src[j + 1] === '(') {
          const end = closeParen(src, j + 2, mode);
          sub(src.slice(j + 2, end));
          j = end;
        } else if (d === '`' && mode === 'sh') {
          let k = j + 1;
          while (k < src.length && src[k] !== '`') k += src[k] === '\\' ? 2 : 1;
          sub(src.slice(j + 1, k));
          j = k;
        } else cur += d;
      }
      i = j;
      continue;
    }
    if (c === '$' && next === '{') {
      const j = src.indexOf('}', i);
      cur += src.slice(i, j < 0 ? src.length : j + 1);
      inWord = true;
      i = j < 0 ? src.length : j;
      continue;
    }
    // In PowerShell a comma separates array elements: `-ArgumentList contact,grant`.
    if (c === ' ' || c === '\t' || c === '\r' || c === '<' || c === '>' || (mode === 'ps' && c === ',')) {
      endWord();
      continue;
    }
    if ('\n;&|()'.includes(c) || (mode === 'ps' && '{}'.includes(c))) {
      endCmd();
      continue;
    }
    cur += c;
    inWord = true;
  }
  endCmd();
  return cmds;
}

// --- word matching ------------------------------------------------------------

/** sh brace expansion: `{grant,x}` -> both. */
function braces(w) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(w);
  if (!m) return [w];
  return m[1]
    .split(',')
    .flatMap((alt) => braces(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length)))
    .slice(0, 64);
}

const GLOB_CHARS = /[*?[]/;

function globRe(w) {
  let re = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && w.indexOf(']', i + 2) > i) {
      const j = w.indexOf(']', i + 2);
      re += `[${w.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`, 'i');
  } catch {
    return /^$/;
  }
}

/** Could `w` be `name` once the shell expands it (braces always; a glob only if `name` exists in `cwd`)? */
function couldBe(w, name, cwd) {
  return braces(w).some((x) => x.toLowerCase() === name || (GLOB_CHARS.test(x) && globRe(x).test(name) && existsSync(join(cwd, name))));
}

const dynamic = (w) => w.includes(SUB) || /\$[\w{(]|%\w+%/.test(w);

const progName = (w) =>
  basename(w.replace(/[\\/]+$/, ''))
    .toLowerCase()
    .replace(/\.(cmd|ps1|exe|bat|sh)$/, '');

/** The rdv CLI under any of its names: the shim, the built bin.js, the npm package. */
const isRdv = (w) =>
  braces(w).some((x) => {
    const p = progName(x);
    return p === 'rdv' || p === 'bin.js' || /^@rendezvous\/cli(@|$)/i.test(x);
  });

/** Programs that may name a home folder: they list it, enter it or print its path, but read no file in it. */
const LISTING = new Set(['ls', 'dir', 'gci', 'get-childitem', 'cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'test-path', 'stat', 'mkdir', 'md', 'echo', 'write-output', 'rdv', 'rdv-mcp']);

const CONTACT_SUBS = { grant: `rdv contact grant: ${HUMAN_ONLY}`, confirm: `rdv contact confirm: ${HUMAN_ONLY}`, resync: `rdv contact resync: ${HUMAN_ONLY}`, pending: PENDING };
const DINNER_SUBS = { confirm: `rdv dinner confirm: ${HUMAN_ONLY}`, cancel: `rdv dinner cancel: ${HUMAN_ONLY}`, list: DINNER_LIST };

// --- paths ----------------------------------------------------------------------

const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const RDV_HOME_REF = /^(\$\{?RDV_HOME\}?|\$env:RDV_HOME|%RDV_HOME%)(?=$|[\\/])/i;
const HOME_REF = /^(~|\$\{?HOME\}?|\$env:(HOME|USERPROFILE)|%USERPROFILE%)(?=$|[\\/])/i;
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** A directory that looks like a Rendezvous home on disk (any --home or profile dir). */
const looksLikeHome = (d) => existsSync(join(d, 'config.json')) && (existsSync(join(d, 'agent.json')) || existsSync(join(d, 'consent.json')));

/**
 * `w` with a leading `~`, $HOME or $RDV_HOME (in sh, PowerShell or cmd
 * spelling) expanded. An unset RDV_HOME stands for a home under ~/.rendezvous.
 */
function expandRefs(w) {
  const lit = (s) => s.replace(/\$/g, '$$$$');
  if (RDV_HOME_REF.test(w)) {
    return { text: w.replace(RDV_HOME_REF, lit(process.env.RDV_HOME || join(homedir(), '.rendezvous', 'RDV_HOME'))), viaRdvHome: true };
  }
  return { text: w.replace(HOME_REF, lit(homedir())), viaRdvHome: false };
}

/** `w` expanded (expandRefs) and resolved against `cwd`. */
function expandPath(w, cwd) {
  const { text, viaRdvHome } = expandRefs(w);
  return { path: isAbsolute(text) ? text : resolve(cwd, text), viaRdvHome };
}

/**
 * Where `p` is relative to a Rendezvous home: "home" (a home or ~/.rendezvous
 * itself), "inside" (a file or folder in one) or undefined. The installed
 * source in ~/.rendezvous/src is not a home.
 */
function classify(p) {
  const comps = p.split(/[\\/]+/).filter(Boolean);
  const at = comps.map((c) => c.toLowerCase()).lastIndexOf('.rendezvous');
  if (at >= 0) {
    const after = comps.slice(at + 1);
    if (after[0]?.toLowerCase() === 'src') return undefined;
    return after.length <= 1 ? 'home' : 'inside';
  }
  if (process.env.RDV_HOME) {
    const [n, h] = [norm(p), norm(process.env.RDV_HOME)];
    if (n === h) return 'home';
    if (under(n, h)) return 'inside';
  }
  if (isDir(p) && looksLikeHome(p)) return 'home';
  if (looksLikeHome(dirname(p))) return 'inside';
  return undefined;
}

const under = (child, parent) => child.startsWith(`${parent}${sep}`) || child.startsWith(`${parent}/`);

/** Is `p` a folder above a known Rendezvous home (searching it recursively would reach the key)? */
function containsHome(p) {
  const d = norm(p);
  return [join(homedir(), '.rendezvous'), process.env.RDV_HOME].filter(Boolean).some((h) => under(norm(h), d));
}

/** The part of a glob or dynamic word before its first wildcard or substitution. */
const staticPrefix = (w) => {
  const i = w.search(/[*?[{]|\u0000|\$[\w{(]|%\w+%/);
  return i < 0 ? w : w.slice(0, i);
};

// --- commands -------------------------------------------------------------------

function checkWords(words, ctx, depth) {
  const lw = words.map((w) => w.toLowerCase());
  // Programs that run a string as a command: check the string too.
  for (let i = 0; i < words.length; i++) {
    const p = progName(words[i]);
    const rest = () => words.slice(i + 1).join(' ');
    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'busybox'].includes(p)) {
      const j = lw.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
      if (j > 0 && words[j + 1] !== undefined) check(words[j + 1], ctx, depth + 1);
    } else if (p === 'cmd') {
      const j = lw.findIndex((w, k) => k > i && /^\/[ck]$/.test(w));
      if (j > 0) check(words.slice(j + 1).join(' '), ctx, depth + 1);
    } else if (p === 'pwsh' || p === 'powershell') {
      const j = lw.findIndex((w, k) => k > i && (w === '-ec' || (w.length >= 2 && '-encodedcommand'.startsWith(w))));
      if (j > 0 && words[j + 1]) check(Buffer.from(words[j + 1], 'base64').toString('utf16le'), ctx, depth + 1);
      check(rest(), ctx, depth + 1);
    } else if (p === 'eval' || p === 'iex' || p === 'invoke-expression' || p === 'source') {
      check(rest(), ctx, depth + 1);
    } else if (['node', 'bun', 'deno', 'python', 'python3', 'py', 'perl', 'ruby', 'php'].includes(p)) {
      const j = lw.findIndex((w, k) => k > i && /^(-e|-p|-c|-r|--eval|--print|-pe)$/.test(w));
      if (j > 0 && words[j + 1] !== undefined) checkCode(words[j + 1], ctx, depth + 1);
    }
  }

  // The subcommands themselves. rdv dispatches on its first two arguments, so
  // they are two adjacent words, after any wrapper (npx, pnpm, npm run rdv --, …).
  for (let i = 0; i + 1 < words.length; i++) {
    const [a, b] = [words[i], words[i + 1]];
    for (const [cmd, subs] of [
      ['contact', CONTACT_SUBS],
      ['dinner', DINNER_SUBS],
    ]) {
      const named = couldBe(a, cmd, ctx.cwd);
      for (const [s, why] of Object.entries(subs)) {
        if ((named || dynamic(a)) && couldBe(b, s, ctx.cwd)) throw new Refusal(why);
      }
      if (named && dynamic(b) && (i === 0 || isRdv(words[i - 1]) || dynamic(words[i - 1]) || words[i - 1] === '--')) throw new Refusal(OPAQUE);
    }
    if (isRdv(a) && dynamic(b)) throw new Refusal(OPAQUE);
  }
  // `… | xargs rdv contact`: the arguments come from stdin, unseen.
  const feeder = lw.findIndex((w) => ['xargs', 'parallel'].includes(progName(w)));
  if (feeder >= 0 && words.slice(feeder + 1).some(isRdv)) {
    const at = words.findIndex((w, k) => k > feeder && isRdv(w));
    const tail = words.slice(at + 1).filter((w) => !w.startsWith('-'));
    if (tail.length < 2 || ['contact', 'dinner'].includes(tail[tail.length - 1].toLowerCase())) throw new Refusal(OPAQUE);
  }
  const listenAt = words.findIndex((w) => couldBe(w, 'listen', ctx.cwd));
  if (listenAt >= 0 && words.slice(listenAt + 1).some((w) => braces(w).some((x) => /^--auto-(grant|confirm)/i.test(x)))) {
    throw new Refusal(`rdv listen --auto-grant/--auto-confirm approves without the human. ${HUMAN_ONLY}`);
  }
  const rdvAt = words.findIndex((w, k) => isRdv(w) || (k === 0 && dynamic(w)));
  if (rdvAt >= 0) {
    const initAt = words.findIndex((w, k) => k > rdvAt && couldBe(w, 'init', ctx.cwd));
    if (initAt > 0 && words.slice(initAt + 1).some((w) => braces(w).some((x) => /^--force(=|$)/i.test(x)))) {
      throw new Refusal('rdv init --force replaces the agent key. Only the human may do that, in their own terminal.');
    }
  }

  // Paths: the secret files by name (any directory), and the home itself.
  let prog = words.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w) && !['sudo', 'env', 'command', 'exec', 'nohup', 'time', '&', '.', 'call', '{', '!'].includes(w));
  if (prog < 0) prog = 0;
  const listing = LISTING.has(progName(words[prog] ?? ''));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (braces(w).some((x) => SECRET_MENTION.test(x))) throw new Refusal(SECRET_REFUSAL);
    const isHomeArg = /^-{1,2}home$/i.test(words[i - 1] ?? '') || /^-{1,2}home=|^RDV_HOME=/i.test(w);
    const value = w.replace(/^-{1,2}home=|^RDV_HOME=/i, '');
    for (const x of braces(value)) {
      const { text, viaRdvHome } = expandRefs(x);
      const glob = GLOB_CHARS.test(text);
      const dyn = dynamic(text);
      const pre = glob || dyn ? staticPrefix(text) : text;
      if (dyn && pre === '' && !viaRdvHome) continue; // starts with a variable we can't see: no path to judge
      const path = isAbsolute(pre) ? pre : resolve(ctx.cwd, pre || '.');
      const where = classify(path);
      if (!where) continue;
      if (glob) {
        // A wildcard in a home, or one whose last part could name the key or consent file.
        if (where === 'home' || GLOB_CHARS.test(dirname(text)) || SECRET_FILES.some((s) => globRe(basename(text)).test(s))) throw new Refusal(HOME_REFUSAL);
      } else if (dyn && !isHomeArg && i !== prog) throw new Refusal(OPAQUE);
      else if (where === 'home' && !listing && !isHomeArg && i !== prog) throw new Refusal(HOME_REFUSAL);
    }
  }

  // Track `cd` so a later relative glob is judged where it runs.
  if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(progName(words[prog] ?? ''))) {
    const target = words.slice(prog + 1).find((w) => !w.startsWith('-'));
    if (target && !dynamic(target)) ctx.cwd = expandPath(target, ctx.cwd).path;
  }
}

/** Code for another interpreter (`node -e`, `python -c`): check it as a command, and each string literal in it. */
function checkCode(code, ctx, depth) {
  check(code, ctx, depth);
  for (const mode of ['sh', 'ps']) {
    for (const words of parseCommands(code, mode, depth)) for (const w of words) if (/\s/.test(w)) check(w, ctx, depth + 1);
  }
  // Argument arrays: execFileSync('rdv', ['contact', 'grant', id]).
  checkWords(code.split(/[^\w@.\/\:+$-]+/).filter(Boolean), { cwd: ctx.cwd }, depth);
}

function check(src, ctx, depth) {
  if (depth > MAX_DEPTH) throw new Refusal(NESTED);
  if (SECRET_MENTION.test(src)) throw new Refusal(SECRET_REFUSAL);
  // Parse it both ways: the hook can't be sure which shell runs it, and a word
  // hidden from one parser (a backtick, a backslash) is plain to the other.
  for (const mode of ['sh', 'ps']) {
    const c = { cwd: ctx.cwd };
    for (const words of parseCommands(src, mode, depth)) checkWords(words, c, depth);
  }
}

/** Why `command` is refused, or undefined if it may run. */
export function checkCommand(command, opts = {}) {
  if (typeof command !== 'string') return undefined;
  try {
    check(command, { cwd: opts.cwd ?? process.cwd() }, 0);
    return undefined;
  } catch (err) {
    if (err instanceof Refusal) return err.message;
    return `The consent guard could not check that command (${err?.message ?? err}); spell it out more simply.`;
  }
}

// --- tool paths -------------------------------------------------------------------

/**
 * Why touching `path` is refused, or undefined. `kind` is "file" (read, edit,
 * write one file), "search" (a folder to search or list recursively) or
 * "glob" (a pattern of paths).
 */
export function checkPath(path, opts = {}) {
  if (typeof path !== 'string' || path === '') return undefined;
  const cwd = opts.cwd ?? process.cwd();
  const kind = opts.kind ?? 'file';
  if (kind === 'glob') {
    if (braces(path).some((x) => SECRET_MENTION.test(x))) return SECRET_REFUSAL;
    const comps = path.split(/[\\/]+/).map((c) => c.toLowerCase());
    const at = comps.lastIndexOf('.rendezvous');
    if (at >= 0 && comps[at + 1] !== 'src') return HOME_REFUSAL;
    const base = opts.base ? expandPath(opts.base, cwd).path : cwd;
    const { path: p, viaRdvHome } = expandPath(staticPrefix(path) || '.', base);
    if (classify(p, viaRdvHome) || (GLOB_CHARS.test(path) && path.includes('**') && containsHome(p))) return HOME_REFUSAL;
    return undefined;
  }
  const { path: p } = expandPath(path, cwd);
  const where = classify(p);
  if (SECRET_FILES.includes(basename(p).toLowerCase()) && (where || classify(dirname(p)))) return SECRET_REFUSAL;
  if (where === 'home') return HOME_REFUSAL;
  if (kind === 'search' && (where || containsHome(p))) return HOME_REFUSAL;
  return undefined;
}

const FILE_KEYS = ['file_path', 'notebook_path', 'path', 'paths', 'directory', 'dir', 'source', 'destination', 'target', 'cwd_path'];
const GLOB_KEYS = ['glob', 'pattern', 'include', 'exclude'];

/** Why this tool call is refused, or undefined. Every path-like field is checked, whatever the tool. */
export function checkToolInput(toolName, input, cwd = process.cwd()) {
  if (!input || typeof input !== 'object') return undefined;
  const name = String(toolName ?? '');
  const searching = /grep|glob|search|find|list|tree|directory|ls$/i.test(name);
  const reason = checkCommand(input.command, { cwd });
  if (reason) return reason;
  const values = (v) => (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string');
  for (const k of FILE_KEYS) {
    for (const v of values(input[k])) {
      const r = checkPath(v, { cwd, kind: searching ? 'search' : 'file' });
      if (r) return r;
    }
  }
  // Grep's `pattern` is a regex over file contents, not a path.
  for (const k of GLOB_KEYS) {
    if (k === 'pattern' && /grep/i.test(name)) continue;
    for (const v of values(input[k])) {
      const r = checkPath(v, { cwd, kind: 'glob', base: typeof input.path === 'string' ? input.path : undefined });
      if (r) return r;
    }
  }
  // Searching with no path searches the working directory.
  if (searching && input.path === undefined) return checkPath(cwd, { cwd, kind: 'file' });
  return undefined;
}

/** The hook decision for one PreToolUse input, or undefined to allow. */
export function decide(input) {
  let reason;
  try {
    reason = checkToolInput(input?.tool_name, input?.tool_input ?? {}, typeof input?.cwd === 'string' ? input.cwd : process.cwd());
  } catch (err) {
    reason = `The consent guard failed (${err?.message ?? err}), so it refuses rather than guess.`;
  }
  if (!reason) return undefined;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not a hook payload: allow, say nothing
  }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
