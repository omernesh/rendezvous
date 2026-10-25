#!/usr/bin/env node
// PreToolUse hook: keeps the assistant away from the Rendezvous commands and
// files that belong to the human. Consent (granting a contact, confirming a
// probe answer or a meeting, canceling an agreed one, starting a peer's task
// or releasing a result to it, auto-grant/auto-confirm listeners, the direct-transfer setting), naming a contact (`rdv contact label`: a label decides who
// "tell John" reaches), putting a contact on auto-approve (`rdv contact auto-approve`, SPEC §5.5.1), the commands
// that show confirm phrases (`rdv contact pending`, `rdv dinner list`, `rdv task list`), re-keying (`rdv init --force`),
// the owner passphrase that turns auto-approve on (`rdv owner-secret`, issue #47),
// and the secret key, consent and auto-approve state (`agent.json`, `agent.json.bak`, `consent.json`,
// `autoapprove.json`, `owner-secret.json`) in the Rendezvous home, through any tool. A command naming
// `contact` and `auto-approve` is refused under any wrapper, quoted string or spelling (pty wrappers included).
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

export const SECRET_FILES = ['agent.json', 'agent.json.bak', 'consent.json', 'autoapprove.json', 'owner.json', 'owner-secret.json'];
/** Files in a home that hold file keys and drafts (files.json, tasks.json): refused by path when they are in a home. */
export const OWNER_FILES = ['files.json', 'tasks.json'];
/** Names distinctive enough to refuse in any folder, not only in a home: writing either one by hand is setting auto-approve. */
const ANYWHERE_FILES = ['autoapprove.json', 'owner-secret.json'];
const SECRET_MENTION = /agent\.json|consent\.json|autoapprove\.json|owner\.json|owner-secret\.json/i;
/**
 * `src` with quoting, escapes, string concatenation and whitespace removed
 * (sh, PowerShell, cmd and script-language spellings alike), so that a word
 * split or quoted to hide it is plain again: `"auto-"+'appr\ove'` -> `auto-approve`.
 */
const flatten = (src) => src.replace(/[\s'"`\\^+]/g, '').toLowerCase();
const AUTO_APPROVE_WORD = /auto[-_]?approve/i;
const OWNER_SECRET_WORD = /owner[-_]?secret/i;
/** Stands for the output of a `$(...)` or backtick substitution: unknown when the hook runs. */
const SUB = '\u0000';
const MAX_DEPTH = 6;

const SECRET_REFUSAL =
  'That names the Rendezvous secret key, consent, auto-approve, owner-settings or owner passphrase file (agent.json, agent.json.bak, consent.json, autoapprove.json, owner.json, owner-secret.json). Never read, write, copy or print it; use rdv_status for the agent ID, fingerprint and auto-approve status, and ask your user to change a setting in their own terminal.';
const OWNER_REFUSAL =
  'That names a Rendezvous file that holds file keys and drafts (files.json, tasks.json). Never read or write it; use rdv_file and rdv_task.';
const HOME_REFUSAL =
  'That reaches into a Rendezvous home, which holds the secret key and consent state. Do not search, glob, copy or read it as a whole; use rdv_status, rdv_pending_requests and rdv_inbox.';
const HUMAN_ONLY =
  'That Rendezvous command is for the human, in their own terminal. Use the MCP tools: rdv_grant and rdv_negotiate ask the human through an approval form or a confirm phrase they type to you.';
const PENDING =
  'rdv contact pending is for the human, in their own terminal (it shows confirm phrases meant only for them). Use the rdv_pending_requests tool.';
const LABEL =
  'rdv contact label is for the human, in their own terminal: a local label decides who "tell John" reaches. Ask your user to run it, or send by agent_id after showing them the fingerprint.';
const LABEL_REQUEST =
  'rdv contact request --label with an agent ID or card names a contact without the human ever seeing the label (a request by card needs no approval on your side). Leave out --label, or probe the address: the human then confirms the answer and its label.';
const DINNER_LIST =
  'rdv dinner list is for the human, in their own terminal (it shows confirm phrases meant only for them). Use rdv_negotiate with action "status".';
const TASK_LIST =
  'rdv task list is for the human, in their own terminal (it shows confirm phrases meant only for them). Use rdv_task with action "list".';
const TASK_GATE =
  'That Rendezvous command is for the human, in their own terminal. Use the MCP tools: rdv_task "approve-start" and "approve-release" ask the human through an approval form or a confirm phrase they type to you.';
const AUTO_APPROVE =
  "rdv contact auto-approve is for the human, in their own terminal: it lets a contact's tasks run and their results leave without asking anyone. You may never set, extend or turn it on, and never suggest it to get past a gate; to have it turned off, ask your user (rdv_status shows it).";
const DIRECT_TRANSFER =
  'rdv file direct-transfer is the human\'s setting, in their own terminal: turning it on shows their network address to contacts who ask for a direct transfer. Tell your user; rdv_file "decline-transfer" can only say no.';
const OWNER_SECRET =
  'The owner passphrase (rdv owner-secret, owner-secret.json) is for the human alone: it is what they type to turn auto-approve on. Never set, change, read, write or ask for it.';
const PTY_RDV =
  'That opens a pseudo-terminal (script, expect, unbuffer, winpty, node-pty, pty.spawn, pexpect), which nothing here needs but answering a prompt meant for the human. Run the command directly, or use the rdv_* MCP tools.';
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

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

/** The text of a bash `$'…'` string starting at `start` (just past the quote), and the index of its closing quote. */
function ansiC(src, start) {
  let out = '';
  let i = start;
  for (; i < src.length && src[i] !== "'"; i++) {
    if (src[i] !== '\\' || i + 1 >= src.length) {
      out += src[i];
      continue;
    }
    const e = src[++i];
    let m;
    if (Object.hasOwn(ANSI_C, e)) out += ANSI_C[e];
    else if ((m = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(i)))) {
      out += String.fromCharCode(parseInt(m[1], 16));
      i += m[0].length - 1;
    } else if ((m = /^(u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/.exec(src.slice(i)))) {
      out += String.fromCodePoint(Math.min(parseInt(m[1].slice(1), 16), 0x10ffff));
      i += m[0].length - 1;
    } else if ((m = /^[0-7]{1,3}/.exec(src.slice(i)))) {
      out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
      i += m[0].length - 1;
    } else if (e === 'c' && i + 1 < src.length) {
      out += String.fromCharCode(src.charCodeAt(++i) & 0x1f);
    } else out += `\\${e}`;
  }
  return [out, i];
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
    // bash ANSI-C quoting: $'\x63ontact' is "contact" (issue #47). Decoded, so the word is judged as the shell runs it.
    if (mode === 'sh' && c === '$' && next === "'") {
      const [text, end] = ansiC(src, i + 2);
      cur += text;
      inWord = true;
      i = end;
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

const CONTACT_SUBS = {
  grant: `rdv contact grant: ${HUMAN_ONLY}`,
  confirm: `rdv contact confirm: ${HUMAN_ONLY}`,
  resync: `rdv contact resync: ${HUMAN_ONLY}`,
  label: LABEL,
  pending: PENDING,
  // auto_approve: all (SPEC §5.5.1, issue #25): on, extend and off alike, so no spelling of "all" slips through.
  'auto-approve': AUTO_APPROVE,
};
const DINNER_SUBS = { confirm: `rdv dinner confirm: ${HUMAN_ONLY}`, cancel: `rdv dinner cancel: ${HUMAN_ONLY}`, list: DINNER_LIST };
// The two task gates (SPEC §5.5): starting a peer's task, and releasing what goes back to it.
const TASK_SUBS = { approve: `rdv task approve: ${TASK_GATE}`, release: `rdv task release: ${TASK_GATE}`, list: TASK_LIST };
// The owner's direct-transfer setting (SPEC §7.7): widening it is the human's.
const FILE_SUBS = { 'direct-transfer': DIRECT_TRANSFER };
// The owner passphrase (issue #47): setting or resetting it is what would let a wrapper answer the auto-approve prompt.
const OWNER_SUBS = { set: OWNER_SECRET, reset: OWNER_SECRET };

/**
 * Programs that run their arguments as another command, in a pseudo-terminal (`script`, `expect`, `unbuffer`,
 * `winpty`) or not (`stdbuf`, `timeout`, `nohup`, `env`, …). A string argument to one is a command line of its own.
 */
const WRAPPERS = new Set(['script', 'expect', 'unbuffer', 'winpty', 'stdbuf', 'timeout', 'nohup', 'env', 'setsid', 'nice', 'ionice', 'watch', 'sudo', 'doas', 'xvfb-run', 'faketime', 'chronic', 'empty', 'ptyrun', 'conpty']);
/** Is `rdv` (any of its names) invoked somewhere in this text? `rdv1:` IDs and `rdv-mcp` are not. */
const mentionsRdv = (s) => /(^|[^\w-])rdv(\.cmd|\.ps1|\.exe)?($|[^\w-])|bin\.js|@rendezvous\/cli/i.test(s);
/** Programs that run a command in a pseudo-terminal: refused outright (issue #47). */
const PTY_WRAPPERS = new Set(['script', 'expect', 'unbuffer', 'winpty', 'empty', 'ptyrun', 'conpty', 'socat', 'tmux', 'screen', 'dtach', 'abduco']);
/** A pseudo-terminal opened from a script: node-pty, Python's pty module, a ConPTY or winpty binding. */
const PTY_CODE = /node-pty|\bpty\s*\.\s*(spawn|fork|openpty)|\b(openpty|forkpty|ptyprocess|pexpect|conpty|winpty)\b/i;

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
  // A quoted string that names auto-approve is a command for some other program to run (`script -c "…"`,
  // `expect -c 'spawn …'`, `pty.spawn(…)`): refused whatever else it holds (issue #47).
  if (words.some((w) => /\s/.test(w) && AUTO_APPROVE_WORD.test(flatten(w)))) throw new Refusal(AUTO_APPROVE);
  // A string handed to a wrapper is run as a command line: check it with the whole parser (subcommands, dynamic
  // words, paths). One that runs rdv and holds a `$`, a backtick or a Tcl `[…]` (expect) is built at run time: refused.
  // A pty wrapper as the program, or run by another wrapper (`timeout 60 script …`): refused, whatever it runs.
  const firstProg = words.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
  if (words.some((w, k) => PTY_WRAPPERS.has(progName(w)) && (k === firstProg || words.slice(0, k).some((x) => WRAPPERS.has(progName(x)))))) {
    throw new Refusal(PTY_RDV);
  }
  const wrapAt = words.findIndex((w) => WRAPPERS.has(progName(w)));
  if (wrapAt >= 0) {
    for (const w of words.slice(wrapAt + 1)) {
      if (!/\s/.test(w)) continue;
      if (mentionsRdv(w) && /[$`[\u0000]/.test(w)) throw new Refusal(OPAQUE);
      check(w, { cwd: ctx.cwd }, depth + 1);
    }
  }
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
      ['task', TASK_SUBS],
      ['file', FILE_SUBS],
      ['owner-secret', OWNER_SUBS],
    ]) {
      const named = couldBe(a, cmd, ctx.cwd);
      for (const [s, why] of Object.entries(subs)) {
        if ((named || dynamic(a)) && couldBe(b, s, ctx.cwd)) throw new Refusal(why);
      }
      // `file` is also a common program (`file "$f"`): only after rdv is it a subcommand.
      if (named && dynamic(b) && (i === 0 ? cmd !== 'file' : isRdv(words[i - 1]) || dynamic(words[i - 1]) || words[i - 1] === '--')) throw new Refusal(OPAQUE);
    }
    // rdv's next word must be a literal: not built at run time, and no wildcard the shell could expand into a subcommand.
    if (isRdv(a) && (dynamic(b) || GLOB_CHARS.test(b))) throw new Refusal(OPAQUE);
  }
  // `… | xargs rdv contact`: the arguments come from stdin, unseen.
  const feeder = lw.findIndex((w) => ['xargs', 'parallel'].includes(progName(w)));
  if (feeder >= 0 && words.slice(feeder + 1).some(isRdv)) {
    const at = words.findIndex((w, k) => k > feeder && isRdv(w));
    const tail = words.slice(at + 1).filter((w) => !w.startsWith('-'));
    if (tail.length < 2 || ['contact', 'dinner', 'task', 'file'].includes(tail[tail.length - 1].toLowerCase())) throw new Refusal(OPAQUE);
  }
  const listenAt = words.findIndex((w) => couldBe(w, 'listen', ctx.cwd));
  if (listenAt >= 0 && words.slice(listenAt + 1).some((w) => braces(w).some((x) => /^--auto-(grant|confirm)/i.test(x)))) {
    throw new Refusal(`rdv listen --auto-grant/--auto-confirm approves without the human. ${HUMAN_ONLY}`);
  }
  // `rdv contact request <agent-id|card> --label x`: labeled with no step where the human sees it. A probe (an address)
  // may carry a label: the human confirms the answer, label shown (NOTES 62).
  const reqAt = words.findIndex((w, k) => k + 1 < words.length && couldBe(w, 'contact', ctx.cwd) && couldBe(words[k + 1], 'request', ctx.cwd));
  if (reqAt >= 0 && words.slice(reqAt + 2).some((w) => braces(w).some((x) => /^--label(=|$)/i.test(x)))) {
    let target;
    for (let k = reqAt + 2; k < words.length && target === undefined; k++) {
      if (/^--(greeting|label|home|profile)$/i.test(words[k])) k++;
      else if (!words[k].startsWith('-')) target = words[k];
    }
    if (target === undefined || dynamic(target) || !/^[^\s{}*?]+@[^\s{}*?]+$|^\+[\d\s().-]+$/.test(target)) throw new Refusal(LABEL_REQUEST);
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
      else if (where === 'inside' && OWNER_FILES.includes(basename(path).toLowerCase())) throw new Refusal(OWNER_REFUSAL);
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
  // A pseudo-terminal opened by the script itself (node-pty, pty.spawn): what it runs can be built in any way the
  // guard can't follow, and nothing but answering a human-only prompt needs one (issue #47). Refused, whatever it names.
  if (PTY_CODE.test(code)) throw new Refusal(PTY_RDV);
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
  // Auto-approve and the owner passphrase (issue #47), whatever runs them: a pseudo-terminal wrapper (`script -c`,
  // `expect -c`, `unbuffer`, `winpty`), a prefix (`stdbuf`, `timeout`, `nohup`, `env`), node-pty or Python's pty.spawn,
  // a here-string or heredoc. Any command that names `contact` and `auto-approve` anywhere, in any spelling, is
  // refused; so is any mention of `owner-secret`.
  const flat = flatten(src);
  if (OWNER_SECRET_WORD.test(flat)) throw new Refusal(OWNER_SECRET);
  if (AUTO_APPROVE_WORD.test(flat) && flat.includes('contact')) throw new Refusal(AUTO_APPROVE);
  // A script (inline, or fed by a heredoc) that opens a pseudo-terminal, whatever it names: the guard can't follow
  // a name built by string operations (concatenation, chr(), join), so it doesn't try.
  if (PTY_CODE.test(src)) throw new Refusal(PTY_RDV);
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
  if (OWNER_FILES.includes(basename(p).toLowerCase()) && where === 'inside') return OWNER_REFUSAL;
  if (ANYWHERE_FILES.includes(basename(p).toLowerCase())) return SECRET_REFUSAL;
  if (where === 'home') return HOME_REFUSAL;
  if (kind === 'search' && (where || containsHome(p))) return HOME_REFUSAL;
  return undefined;
}

const FILE_KEYS = ['file_path', 'notebook_path', 'path', 'paths', 'directory', 'dir', 'source', 'destination', 'target', 'cwd_path', 'inline_files', 'calendar'];
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
  if (searching && input.path === undefined) return checkPath(cwd, { cwd, kind: 'search' });
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
