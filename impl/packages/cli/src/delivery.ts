// Delivery receipts in the hosts (issue #104, NOTES 98).
//
// The hosts build an Agent per inbound item, so no agent lives long enough to
// keep a timer. The home's inbound consumer (`rdv listen` or `rdv-mcp`)
// instead reads the saved state for the next due receipt or resend
// (`nextDeliveryDue`) and runs an empty item then: `handleInbound` ends every
// item with `deliveryTick`. A relay that comes back runs a reconnect item
// (`FeedTransport.feedReconnect`), which republishes what is unconfirmed.
import { type DeliveryNews, type DeliveryResent, type DeliveryUnconfirmed, fingerprint, nextDeliveryDue, RECEIPT_TIMING, type ReceiptTiming } from '@rendezvous/core';
import type { Home } from './home.js';
import { clean } from './output.js';

/**
 * `RDV_ACK_DELAY_MS` and `RDV_RECEIPT_RETRY_MS` shorten the receipt timing
 * (tests); anything that is not a positive number is ignored. The minimum
 * interval between two acks follows the delay.
 */
export function receiptTiming(env: NodeJS.ProcessEnv = process.env): ReceiptTiming {
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const delay = num(env.RDV_ACK_DELAY_MS);
  const retry = num(env.RDV_RECEIPT_RETRY_MS);
  return {
    ...RECEIPT_TIMING,
    ...(delay ? { ackDelayMs: delay, ackMinIntervalMs: delay * 2, ackJitterMs: 0 } : {}),
    ...(retry ? { retryAfterMs: retry } : {}),
  };
}

/**
 * For the echo check (NOTES 98): whether `from` is one of the home's contacts,
 * from the saved state (the transport asks at most about once a second per
 * relay). Unreadable state counts as no, which only makes an echo go out.
 */
export function contactFilter(home: Home): (from: string) => boolean {
  return (from) => {
    try {
      return Object.hasOwn(home.readAgentState().book.contacts ?? {}, from);
    } catch {
      return false;
    }
  };
}

/** The owner turned receipts off (config.json `"receipts": false`). An unreadable config leaves them on. */
export function receiptsOff(home: Home): boolean {
  try {
    return home.readConfig().receipts === false;
  } catch {
    return false;
  }
}

/**
 * Arms one timer for the next due receipt or resend in the saved state. The
 * consumer calls `check()` after each item it handled and on its sweep (a
 * one-shot `rdv send` from a terminal changes the state behind its back).
 */
export class DeliveryClock {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly home: Home,
    private readonly fire: () => void,
    private readonly timing: ReceiptTiming = receiptTiming(),
  ) {}

  check(): void {
    if (this.stopped) return;
    let due: number | null;
    try {
      due = nextDeliveryDue(this.home.readAgentState().delivery, this.timing);
    } catch {
      return; // mid-write: the next check looks again
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (due === null) return;
    // Never sooner than 250 ms: the tick moves every due time past now, this only keeps a slow disk from spinning us.
    const wait = Math.min(Math.max(250, due - Date.now()), 2 ** 31 - 1);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fire();
    }, wait);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const who = (peer: string, label?: string) => `${label ? clean(label) : clean(peer)} (${clean(fingerprint(peer))})`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export function resentView(r: DeliveryResent, label?: string) {
  return { event: 'delivery-resent', peer: r.peer, label, seqs: r.seqs, reason: r.reason };
}

/** Only a reconnect's resend is worth a line; the backoff's are routine. */
export function resentText(r: DeliveryResent, label?: string): string | undefined {
  if (r.reason !== 'reconnect') return undefined;
  return `relay back: resent ${plural(r.seqs.length, 'message')} that ${who(r.peer, label)} had not confirmed yet`;
}

export function unconfirmedView(u: DeliveryUnconfirmed, label?: string) {
  return { event: 'delivery-unconfirmed', peer: u.peer, label, seqs: u.seqs, since: u.since };
}

export function unconfirmedText(u: DeliveryUnconfirmed, label?: string): string {
  return (
    `not confirmed delivered: ${plural(u.seqs.length, 'message')} to ${who(u.peer, label)} (first sent ${clean(u.since)}), after every retry. ` +
    'Their agent may be offline: the relays keep it for 48 hours, and a later receipt is reported.'
  );
}

export function confirmedView(c: DeliveryNews, label?: string) {
  return { event: 'delivery-confirmed', peer: c.peer, label, seqs: c.seqs };
}

export function confirmedText(c: DeliveryNews, label?: string): string {
  return `delivered after all: ${who(c.peer, label)} confirmed ${plural(c.seqs.length, 'message')} reported as not confirmed`;
}
