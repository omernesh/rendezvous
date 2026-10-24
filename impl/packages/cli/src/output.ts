// Human text by default, one JSON object per line with --json. The secret
// key never goes through here: views below pick fields explicitly.
import { type AddressCard, type Contact, fingerprint, type PendingRequest } from '@rendezvous/core';
import type { InboxEntry } from './home.js';

export class Output {
  constructor(readonly json: boolean) {}

  /** One result or event: `obj` in JSON mode, `human` otherwise (omit to print nothing). */
  emit(obj: object, human?: string): void {
    if (this.json) process.stdout.write(JSON.stringify(obj) + '\n');
    // Backstop: the views clean each peer field; this catches anything they missed.
    else if (human !== undefined) process.stdout.write(clean(human, true) + '\n');
  }

  error(message: string): void {
    if (this.json) process.stderr.write(JSON.stringify({ error: message }) + '\n');
    else process.stderr.write(`rdv: ${clean(message, true)}\n`);
  }
}

// C0 controls (incl. ESC), DEL, C1 controls (incl. single-byte CSI), bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Peer-supplied text is untrusted: replace control, escape and bidi-override
 * characters with U+FFFD before it reaches a terminal. By default newlines go
 * too, so a field can't fake extra output lines.
 */
export function clean(text: unknown, keepNewlines = false): string {
  return String(text).replace(keepNewlines ? UNSAFE_KEEP_NL : UNSAFE, '\ufffd');
}

const safe = (v: unknown) => clean(v);

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
  return (
    `${safe(v.id)}  from ${safe(v.from)}  to ${safe(v.to_hint)}\n` +
    `  fingerprint ${safe(v.fingerprint)}  binding ${safe(v.binding)}  received ${safe(v.received)}\n` +
    `  greeting (untrusted): ${safe(JSON.stringify(v.greeting))}`
  );
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
  const expires = v.expires ? `  expires ${safe(v.expires)}` : '';
  return `${safe(v.peer)}  tier ${safe(v.tier)}  binding ${safe(v.binding)}  fingerprint ${safe(v.fingerprint)}  since ${safe(v.since)}${expires}`;
}

export function inboxText(e: InboxEntry): string {
  const { type, ...rest } = e.payload;
  return `${safe(e.ts)}  ${safe(e.from)}  #${safe(e.seq)}  ${safe(type)}  ${safe(JSON.stringify(rest))}`;
}

export function cardText(card: AddressCard): string {
  const relays = card.rendezvous.flatMap((h) => (h.type === 'nostr' ? [h.relay] : []));
  const addrs = (card.discovery?.addresses ?? []).map((a) => a.value);
  return (
    `${safe(card.id)}  fingerprint ${safe(fingerprint(card.id))}\n` +
    `  addresses ${addrs.map(safe).join(', ')}  relays ${relays.map(safe).join(', ')}`
  );
}
