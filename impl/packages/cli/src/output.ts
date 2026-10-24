// Human text by default, one JSON object per line with --json. The secret
// key never goes through here: views below pick fields explicitly.
import { type Contact, fingerprint, type PendingRequest } from '@rendezvous/core';
import type { InboxEntry } from './home.js';

export class Output {
  constructor(readonly json: boolean) {}

  /** One result or event: `obj` in JSON mode, `human` otherwise (omit to print nothing). */
  emit(obj: object, human?: string): void {
    if (this.json) process.stdout.write(JSON.stringify(obj) + '\n');
    else if (human !== undefined) process.stdout.write(human + '\n');
  }

  error(message: string): void {
    if (this.json) process.stderr.write(JSON.stringify({ error: message }) + '\n');
    else process.stderr.write(`rdv: ${message}\n`);
  }
}

/**
 * Peer-supplied text (greetings, payload text) is untrusted: strip control
 * and bidi-override characters before it reaches a terminal.
 */
export function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '�');
}

export function requestView(p: PendingRequest) {
  return {
    id: p.request.id,
    from: p.request.from,
    fingerprint: fingerprint(p.request.from),
    binding: p.binding,
    to_hint: p.request.to_hint,
    greeting: p.request.greeting,
    received: p.received,
  };
}

export function requestText(p: PendingRequest): string {
  const v = requestView(p);
  return `${v.id}  from ${v.from}\n  fingerprint ${v.fingerprint}  binding ${v.binding}  received ${v.received}\n  greeting (untrusted): ${clean(JSON.stringify(v.greeting))}`;
}

export function contactView(c: Contact) {
  return {
    peer: c.peer,
    fingerprint: fingerprint(c.peer),
    tier: c.tier,
    binding: c.binding,
    since: c.since,
    expires: c.expires,
  };
}

export function contactText(c: Contact): string {
  const v = contactView(c);
  return `${v.peer}  tier ${v.tier}  binding ${v.binding}  fingerprint ${v.fingerprint}  since ${v.since}${v.expires ? `  expires ${v.expires}` : ''}`;
}

export function inboxText(e: InboxEntry): string {
  const { type, ...rest } = e.payload;
  return `${e.ts}  ${e.from}  #${e.seq}  ${clean(String(type))}  ${clean(JSON.stringify(rest))}`;
}
