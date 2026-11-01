// What waits for the owner: each step a remote client asked for that needs
// them, with the form they would have seen (RdvMcpServer remote mode). Kept
// in memory and bounded; a restart drops them (the client asks again). The
// page shows exactly the stored form, and an answer is bound to its digest.
import { type ApprovalAsk, type ApprovalForm, ToolError } from '@rendezvous/mcp';
import { randomToken, sha256 } from './http.js';

export const MAX_APPROVALS = 64;
/** Pending approvals across every agent of one gateway (NOTES 104): one page holds them all. */
export const MAX_APPROVALS_TOTAL = 256;
/** Pending approvals one token may have open, so one client can't fill the page. */
export const MAX_APPROVALS_PER_PRINCIPAL = 16;
export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export interface PendingApproval extends ApprovalAsk {
  id: string;
  /** Who asked, for the page: the token's name and id. */
  askedBy?: string;
  created: number;
  /** The form was rebuilt (the item changed since it was asked). */
  changed?: boolean;
  /** An answer is running: a second submit is refused, not run twice. */
  busy?: boolean;
}

export class Approvals {
  private readonly byId = new Map<string, PendingApproval>();

  constructor(
    private readonly urlFor: (id: string) => string,
    private readonly now: () => number = Date.now,
    /** Whether the token that asked still exists: a revoked token's asks are dropped. */
    private readonly alive: (principal: string | undefined) => boolean = () => true,
    /** How many wait across every agent of the gateway (this one's included). */
    private readonly total: () => number = () => this.byId.size,
  ) {}

  /** How many wait here now (expired ones not yet swept may count until the next ask). */
  get size(): number {
    return this.byId.size;
  }

  /** Record an ask (the same call asked again reuses its entry) and return its approval page URL. */
  ask(a: ApprovalAsk, askedBy?: string): string {
    this.sweep();
    // Keyed by who asked too (re-review of PR #120): another token asking the same call gets its own entry, so it can
    // never take over one (its "Asked by", or a result held for the asker, such as an invite link).
    const key = callKey(a.tool, a.args, a.principal);
    for (const p of this.byId.values()) {
      if (callKey(p.tool, p.args, p.principal) === key) {
        Object.assign(p, { form: a.form, suggestions: a.suggestions, askedBy, changed: false });
        return this.urlFor(p.id);
      }
    }
    // Full: refuse the new ask, never drop one the owner may be about to answer (only expired or decided ones go).
    const mine = [...this.byId.values()].filter((p) => p.principal === a.principal).length;
    if (mine >= MAX_APPROVALS_PER_PRINCIPAL) {
      throw new ToolError(`${mine} approvals you asked for already wait for your user; nothing new was asked. Let them decide those first (or wait until they expire after a day).`);
    }
    if (this.byId.size >= MAX_APPROVALS || this.total() >= MAX_APPROVALS_TOTAL) {
      throw new ToolError('too many approvals already wait for your user; nothing new was asked. Let them decide those first.');
    }
    const id = `apr_${randomToken(18)}`;
    this.byId.set(id, { ...a, id, askedBy, created: this.now() });
    return this.urlFor(id);
  }

  get(id: string): PendingApproval | undefined {
    this.sweep();
    return this.byId.get(id);
  }

  list(): PendingApproval[] {
    this.sweep();
    return [...this.byId.values()].sort((x, y) => x.created - y.created);
  }

  /** Decided (or failed): gone, so the same answer can never run again. */
  drop(id: string): void {
    this.byId.delete(id);
  }

  /** The item changed since the page showed it: show the form for it now. */
  replaceForm(id: string, form: ApprovalForm): void {
    const p = this.byId.get(id);
    if (p) Object.assign(p, { form, changed: true });
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, p] of this.byId) if (t - p.created > APPROVAL_TTL_MS || !this.alive(p.principal)) this.byId.delete(id);
  }
}

const callKey = (tool: string, args: Record<string, unknown>, principal: string | undefined) =>
  sha256(`${tool}\u0000${principal ?? ''}\u0000${JSON.stringify(args)}`);

export class FormInputError extends Error {}

/**
 * The page's fields, typed by the form's own schema (the elicitation subset
 * the gates use: boolean, string with enum or length, integer). A field type
 * the page cannot show approves nothing.
 */
export function typeContent(properties: Record<string, Record<string, unknown>>, posted: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(properties)) {
    if (name === 'approve') continue;
    const raw = posted.get(`f_${name}`);
    const title = String(p.title ?? name);
    if (p.type === 'boolean') {
      out[name] = raw === '1';
    } else if (p.type === 'string') {
      const v = raw ?? '';
      if (/[\p{Cc}\p{Cf}]/u.test(v)) throw new FormInputError(`${title}: no control characters`);
      if (Array.isArray(p.enum)) {
        if (!(p.enum as unknown[]).includes(v)) throw new FormInputError(`${title}: pick one of the choices`);
      } else {
        if (typeof p.maxLength === 'number' && v.length > p.maxLength) throw new FormInputError(`${title}: at most ${p.maxLength} characters`);
        if (typeof p.minLength === 'number' && v.length < p.minLength) throw new FormInputError(`${title}: at least ${p.minLength} characters`);
      }
      out[name] = v;
    } else if (p.type === 'integer' || p.type === 'number') {
      const v = (raw ?? '').trim();
      if (v === '') {
        out[name] = null; // cleared: no value (a limit field left blank sets no limit)
        continue;
      }
      if (!/^-?\d{1,9}$/.test(v)) throw new FormInputError(`${title}: a whole number`);
      const n = Number(v);
      if ((typeof p.minimum === 'number' && n < p.minimum) || (typeof p.maximum === 'number' && n > p.maximum)) {
        throw new FormInputError(`${title}: from ${p.minimum ?? '…'} to ${p.maximum ?? '…'}`);
      }
      out[name] = n;
    } else {
      throw new FormInputError('this approval has a field the page cannot show; decide it in your own terminal');
    }
  }
  return out;
}
