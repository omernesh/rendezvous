// The human-only commands need an interactive terminal (issue #126).
//
// The plugin's consent guard reads shell text and is best effort: a model with
// a shell can always spell a command it does not see. This is the boundary
// behind it. A shell tool without a terminal (Claude Code's Bash and PowerShell
// tools, MCP clients), a script and a pipe are refused when they run the `rdv`
// or `rdv-gateway` commands. This raises the bar; it is not a proof: another
// interpreter calling the library directly (e.g. `node -e` importing
// dist/src/main.js), or a launcher that opens a new console (Windows
// `Start-Process`, `cmd /c start`) or a pseudo-terminal (tmux, screen, python
// `pty`) passes isTTY, an accepted limit under #51 that the consent guard names. An assistant whose
// shell runs in a real terminal (some IDE agent modes) is not stopped here and
// must use the approval-form tools.
//
// No switch turns it off, on purpose: no flag, no environment
// variable, no config file. Tests drive the allowed path through `main`'s
// in-process `interactive` option, which bin.js never passes.

/** stdin and stdout are both a terminal (the same check on Windows: Windows Terminal, PowerShell and cmd consoles report isTTY). */
export const processIsInteractive = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

/** Text of the refusal: what to run instead, through the assistant (`tool`), or nothing (`undefined`: only in your own terminal). */
export function terminalRefusal(command: string, tool: string | undefined): string {
  return (
    `${command} is for you, in your own terminal: it needs an interactive terminal (stdin and stdout), and an assistant's shell, a script or a pipe has none. Nothing was changed. ` +
    (tool
      ? `If your assistant asked you to run it, ask it to use ${tool} instead: you decide in its approval form.`
      : 'Run it yourself, in your own terminal.')
  );
}

type Values = Record<string, string | boolean | string[] | undefined>;

/** rdv commands that are the human's, and the chat tool that asks the human for the same thing. */
const RDV_HUMAN: Record<string, string | undefined> = {
  'contact grant': 'rdv_grant',
  'contact confirm': 'rdv_grant',
  'contact resync': 'rdv_resync',
  'contact label': 'rdv_label',
  'contact alias add': 'rdv_label',
  'contact alias remove': 'rdv_label',
  // They print confirm phrases meant only for the human.
  'contact pending': 'rdv_pending_requests',
  'dinner list': 'rdv_negotiate (action "status")',
  'task list': 'rdv_task (action "list")',
  'group pending': 'rdv_group (action "list")',
  'relays list': 'rdv_relays',
  'contact auto-approve': 'rdv_auto_approve',
  'dinner confirm': 'rdv_negotiate',
  'dinner cancel': 'rdv_negotiate',
  'task approve': 'rdv_task ("approve-start")',
  'task release': 'rdv_task ("approve-release")',
  'file direct-transfer': 'rdv_file ("direct-transfer")',
  'owner-secret set': 'rdv_owner_passphrase',
  'owner-secret reset': 'rdv_owner_passphrase',
  'relays add': 'rdv_relays',
  'relays remove': 'rdv_relays',
  'group invite': 'rdv_group ("invite")',
  'group join': 'rdv_group ("join")',
  'group approve': 'rdv_group ("approve")',
  'group resync': 'rdv_resync',
  'group leave': 'rdv_group ("leave")',
  'group remove': 'rdv_group ("remove")',
  'group terms': 'rdv_group ("terms")',
  'group promote': undefined,
  'service install': 'rdv_service ("install")',
  'invite create': 'rdv_invite ("create")',
  'agent-name set': 'rdv_agent_name',
  'agent-name clear': 'rdv_agent_name',
  backup: 'rdv_backup',
  restore: 'rdv_backup',
};

/** An address a probe goes to (the human then confirms the answer, label shown), as the consent guard reads it. */
const ADDRESS = /^[^\s{}*?]+@[^\s{}*?]+$|^\+[\d\s().-]+$/;

/**
 * Is `rdv <name>` with these options the human's? Returns what to say instead of running it, or undefined when
 * anyone may run it. The same list as the plugin's consent guard (plugins/rendezvous/hooks/consent-guard.mjs),
 * except read-only commands that show no secret (`contact alias list`, `service install --dry-run`).
 */
export function rdvHumanOnly(name: string, values: Values, positionals: string[]): string | undefined {
  const refuse = (tool: string | undefined, what = `rdv ${name}`) => terminalRefusal(what, tool);
  if (Object.hasOwn(RDV_HUMAN, name)) {
    if (name === 'service install' && values['dry-run'] === true) return undefined;
    return refuse(RDV_HUMAN[name]);
  }
  if (name === 'init' && values.force === true) return refuse('rdv_init with replace: true', 'rdv init --force');
  if (name === 'init' && values['agent-name'] !== undefined) return refuse('rdv_agent_name', 'rdv init --agent-name');
  if (name === 'listen' && (values['auto-grant'] !== undefined || values['auto-confirm'] === true)) {
    return refuse('rdv_grant and rdv_negotiate', 'rdv listen --auto-grant/--auto-confirm');
  }
  // A label on a request by agent ID or card names a contact with no step where the human sees it.
  if (name === 'contact request' && values.label !== undefined && !ADDRESS.test(positionals[0] ?? '')) {
    return refuse('rdv_request_contact (a probe of the address: you confirm the answer and its label)', 'rdv contact request --label');
  }
  // The owner's files in a request we send (issue #53).
  if (name === 'task request' && (values.file !== undefined || values.inline !== undefined)) {
    return refuse('rdv_task "request" (no files)', 'rdv task request --file/--inline');
  }
  return undefined;
}
