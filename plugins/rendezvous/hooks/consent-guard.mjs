#!/usr/bin/env node
// PreToolUse hook: keeps the assistant away from the Rendezvous commands that
// belong to the human. Consent (granting a contact, confirming a probe answer
// or a meeting, canceling an agreed one, auto-grant/auto-confirm listeners),
// the commands that print confirm phrases (`rdv contact pending` and
// `rdv dinner list` in text mode), re-keying (`rdv init --force`), and reading
// the secret key or consent file.
//
// It is a tripwire against an assistant that drifts or follows injected text,
// not a sandbox: a model with a shell can obfuscate a command past any
// pattern. The real boundary is the MCP consent gate (NOTES 57, 62).
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RDV = String.raw`(?:^|[\s"'/\\&(])(?:rdv(?:\.cmd|\.ps1)?|bin\.js|npm\s+run\s+rdv)["']?\s+(?:--\s+)?((?:-{1,2}[\w-]+(?:[= ](?!-)\S+)?\s+)*)(contact|dinner|listen|init)\b(.*)`;
const SECRET_FILES = new Set(['agent.json', 'agent.json.bak', 'consent.json']);

const SECRET_REFUSAL = 'That file holds the Rendezvous secret key or consent state. Never read or print it; use rdv_status for the agent ID and fingerprint.';
const HUMAN_ONLY = 'That Rendezvous command is for the human, in their own terminal. Use the MCP tools: rdv_grant and rdv_negotiate ask the human through an approval form or a confirm phrase they type to you.';

/** Why `command` is refused, or undefined if it may run. */
export function checkCommand(command) {
  if (typeof command !== 'string') return undefined;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const m = new RegExp(RDV, 'i').exec(segment);
    if (m) {
      const cmd = m[2].toLowerCase();
      const rest = m[3];
      const sub = (/^\s+([a-z-]+)/i.exec(rest)?.[1] ?? '').toLowerCase();
      const json = /(^|\s)--json\b/i.test(rest);
      if (cmd === 'contact' && ['grant', 'confirm', 'resync'].includes(sub)) return `rdv contact ${sub}: ${HUMAN_ONLY}`;
      if (cmd === 'contact' && sub === 'pending' && !json) {
        return 'rdv contact pending shows confirm phrases meant for the human only. Use rdv_pending_requests, or "rdv contact pending --json", which shows no phrases.';
      }
      if (cmd === 'dinner' && ['confirm', 'cancel'].includes(sub)) return `rdv dinner ${sub}: ${HUMAN_ONLY}`;
      if (cmd === 'dinner' && sub === 'list' && !json) {
        return 'rdv dinner list shows confirm phrases meant for the human only. Use rdv_negotiate with action "status", or "rdv dinner list --json".';
      }
      if (cmd === 'listen' && /(^|\s)--auto-(grant|confirm)\b/i.test(rest)) return `rdv listen --auto-grant/--auto-confirm approves without the human. ${HUMAN_ONLY}`;
      if (cmd === 'init' && /(^|\s)--force\b/i.test(rest)) return 'rdv init --force replaces the agent key. Only the human may do that, in their own terminal.';
    }
    if (/\.rendezvous[\\/]\S*\b(agent\.json(\.bak)?|consent\.json)\b/i.test(segment)) return SECRET_REFUSAL;
  }
  return undefined;
}

/** Why reading `path` is refused, or undefined. */
export function checkPath(path) {
  if (typeof path !== 'string' || !SECRET_FILES.has(basename(path).toLowerCase())) return undefined;
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const inRendezvous = dirname(path).split(/[\\/]/).some((p) => p.toLowerCase() === '.rendezvous');
  const inHome = !!process.env.RDV_HOME && norm(dirname(path)) === norm(process.env.RDV_HOME);
  return inRendezvous || inHome ? SECRET_REFUSAL : undefined;
}

/** The hook decision for one PreToolUse input, or undefined to allow. */
export function decide(input) {
  const ti = input?.tool_input ?? {};
  const reason = checkCommand(ti.command) ?? checkPath(ti.file_path) ?? checkPath(ti.path);
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
