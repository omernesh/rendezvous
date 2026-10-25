// Human text by default, one JSON object per line with --json. The secret
// key never goes through here: views below pick fields explicitly.
import {
  type AddressCard,
  allowedCapabilities,
  type Contact,
  fingerprint,
  MEETING_CAPABILITIES,
  MEETINGS_CAPABILITY,
  scopeAllows,
  type GrantCandidate,
  type PendingRequest,
  type ProbeOverflow,
  topicForHint,
} from '@rendezvous/core';
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
    /** Our human's name for the peer (local only); the addresses in its card are only its own claims. */
    label: c.label,
    tier: c.tier,
    binding: c.binding,
    since: c.since,
    expires: c.expires,
    /** The tier the peer's grant gave us (when we requested). */
    granted_tier: c.grantedTier,
    /** granted: our human set the peer's rights; default: the local default (no meetings, rate-limited). */
    inbound: c.inboundGranted === false ? 'default' : 'granted',
    /** The peer's grant (or reverse grant, NOTES 60) lets us propose meetings to it. */
    outbound_meetings: scopeAllows(c.outboundScope, MEETINGS_CAPABILITY),
    /** Capabilities the peer's grant lets us invoke on it (§5.3, meetings included; the migration rule applied). */
    outbound_invoke: allowedCapabilities(c.outboundScope),
    /** Capabilities our human lets the peer invoke on us. */
    inbound_invoke: allowedCapabilities(c.inboundScope),
  };
}

export function contactText(c: Contact): string {
  const v = contactView(c);
  const expires = v.expires ? `  expires ${safe(v.expires)}` : '';
  const theirs = v.granted_tier ? `  their tier for us ${safe(v.granted_tier)}` : '';
  const inbound = v.inbound === 'default' ? '  inbound: default (no meetings; "rdv contact grant <agent-id>" to allow more)' : '';
  const outbound = v.outbound_meetings ? '  you may propose meetings' : '';
  const others = (l: string[]) => l.filter((u) => !MEETING_CAPABILITIES.includes(u)).map(safe).join(', ');
  const theyInvoke = others(v.inbound_invoke) ? `  they may invoke ${others(v.inbound_invoke)}` : '';
  const youInvoke = others(v.outbound_invoke) ? `  you may invoke ${others(v.outbound_invoke)}` : '';
  const label = v.label ? `  label ${safe(v.label)}` : '';
  return `${safe(v.peer)}${label}  tier ${safe(v.tier)}  binding ${safe(v.binding)}  fingerprint ${safe(v.fingerprint)}  since ${safe(v.since)}${expires}${theirs}${inbound}${outbound}${youInvoke}${theyInvoke}`;
}

export function overflowView(o: ProbeOverflow) {
  return { event: 'probe-overflow', request_ref: o.request_ref, to_hint: o.to_hint, dropped: o.dropped };
}

export function overflowText(o: ProbeOverflow): string {
  return (
    `your probe ${safe(o.request_ref)} for ${safe(o.to_hint)} got too many answers: ${safe(o.dropped)} dropped. ` +
    'Someone may be flooding it, so the real one may be among the dropped: get their card in person (QR) or by a channel you trust, and use "rdv contact request <card-file> --in-person"'
  );
}

export function candidateView(c: GrantCandidate) {
  const g = c.grant;
  const probed = topicForHint(c.to_hint);
  return {
    event: 'candidate',
    grant_id: g.id,
    from: g.from,
    fingerprint: fingerprint(g.from),
    request_ref: c.request_ref,
    to_hint: c.to_hint,
    /** Always true (other grants are refused); it is the grantor's own claim, not proof. */
    claims_address: (g.card.discovery?.addresses ?? []).some((a) => topicForHint(a.value) === probed),
    granted_tier: g.tier,
    received: c.received,
  };
}

export function candidateText(c: GrantCandidate): string {
  const v = candidateView(c);
  return (
    `${safe(v.grant_id)}  answer to your probe for ${safe(v.to_hint)}  from ${safe(v.from)}\n` +
    `  fingerprint ${safe(v.fingerprint)}  card claims the address: ${v.claims_address ? 'yes (self-asserted)' : 'no'}  their tier for you ${safe(v.granted_tier)}\n` +
    `  anyone who saw the probe can answer: compare the fingerprint with the person, then "rdv contact confirm ${safe(v.grant_id)}" (or "rdv contact reject")`
  );
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
