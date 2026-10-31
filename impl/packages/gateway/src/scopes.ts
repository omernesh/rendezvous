// What each scope of a gateway token may call. No scope approves anything:
// a call that needs the owner only asks (`awaiting_human`), and the owner
// decides on the gateway's PIN-locked page. Deny by default: a tool or an
// action missing from this table is refused for every token.

export const SCOPES = ['read', 'send', 'contact:request', 'negotiate'] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

export const SCOPE_TEXT: Record<Scope, string> = {
  read: 'status, contacts, pending requests, the inbox, task and group lists',
  send: 'messages, tasks and group posts to your contacts, as you, and fetching files a contact sent for a task you started',
  'contact:request':
    'asking people for contact (by address, agent ID or an invite link) and asking you to approve, or to make an invite link (only you approve, on the page); also revoking, declining and blocking, which only ever reduce access; ' +
    "and asking you to rename a contact, take a contact's or a group's messages again after a fork, or turn direct file transfers on (only you decide, on the page; turning them off needs no one)",
  negotiate: 'proposing dinner times (only you confirm a meeting, on the page)',
};

/** Per tool: the scope each action needs ("*" for a tool without actions). */
const TABLE: Record<string, Record<string, Scope>> = {
  rdv_status: { '*': 'read' },
  rdv_inbox: { '*': 'read' },
  rdv_pending_requests: { '*': 'read' },
  rdv_discover: { '*': 'read' },
  rdv_addresses: { '*': 'read' },
  rdv_relays: { '*': 'read' },
  rdv_publish_card: { '*': 'contact:request' },
  rdv_request_contact: { '*': 'contact:request' },
  // Invite links (NOTES 101): making one is asked on the page; accepting one is a contact request.
  rdv_accept_invite: { '*': 'contact:request' },
  rdv_invite: { list: 'read', create: 'contact:request', revoke: 'contact:request' },
  rdv_grant: { '*': 'contact:request' },
  rdv_revoke: { '*': 'contact:request' },
  rdv_label: { '*': 'contact:request' },
  rdv_resync: { '*': 'contact:request' },
  rdv_auto_approve: { off: 'contact:request' },
  rdv_send: { '*': 'send' },
  rdv_negotiate: { status: 'read', propose: 'negotiate', confirm: 'negotiate', cancel: 'negotiate' },
  rdv_task: {
    list: 'read',
    status: 'read',
    read: 'read',
    request: 'send',
    input: 'send',
    cancel: 'send',
    'approve-start': 'send',
    decline: 'send',
    submit: 'send',
    'approve-release': 'send',
  },
  rdv_file: { list: 'read', fetch: 'send', 'decline-transfer': 'send', 'direct-transfer': 'contact:request' },
  rdv_group: {
    list: 'read',
    board: 'read',
    create: 'send',
    post: 'send',
    request: 'send',
    claim: 'send',
    assign: 'send',
    unassign: 'send',
    cancel: 'send',
    input: 'send',
    invite: 'contact:request',
    join: 'contact:request',
    decline: 'contact:request',
    approve: 'contact:request',
    leave: 'contact:request',
    remove: 'contact:request',
    terms: 'contact:request',
  },
};

const DEFAULT_ACTION: Record<string, string> = { rdv_negotiate: 'propose', rdv_addresses: 'list', rdv_relays: 'list' };

/** The scope a call needs, or undefined when no token may make it. */
export function requiredScope(tool: string, args: Record<string, unknown>): Scope | undefined {
  if (!Object.hasOwn(TABLE, tool)) return undefined;
  const t = TABLE[tool];
  if (Object.hasOwn(t, '*')) return t['*'];
  const action = typeof args.action === 'string' ? args.action : DEFAULT_ACTION[tool];
  return action !== undefined && Object.hasOwn(t, action) ? t[action] : undefined;
}

/** Every scope some call of the tool needs (a session lists the tool if its token has one of them). */
export function toolScopes(tool: string): Scope[] {
  return Object.hasOwn(TABLE, tool) ? [...new Set(Object.values(TABLE[tool]))] : [];
}

/** The refusal for a call this token's scopes don't cover (undefined: allowed). */
export function authorizeCall(scopes: readonly Scope[], tool: string, args: Record<string, unknown>): string | undefined {
  const need = requiredScope(tool, args);
  if (!need) return `${tool}${typeof args.action === 'string' ? ` "${args.action}"` : ''} is not available through the gateway`;
  if (!scopes.includes(need)) return `this token lacks the "${need}" scope needed for ${tool}${typeof args.action === 'string' ? ` "${args.action}"` : ''}`;
  return undefined;
}
