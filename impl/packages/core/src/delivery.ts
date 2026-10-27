// SPEC §6.4.2: delivery receipts (`rdv/ack`). The receiver tells a contact the
// highest `seq` of its chain it holds without a gap, in an envelope outside
// every chain (`seq` 0); the sender keeps what is not confirmed and
// republishes it from the outbox, with a capped backoff, and after a relay
// comes back. Pure bookkeeping here; the agent sends and receives.
import type { AddressCard } from './card.js';

/** The receipt payload: "I hold every envelope of your chain to me up to `seq`". */
export const ACK_TYPE = 'rdv/ack';

/** On a card's `capabilities`: this agent sends receipts and expects them (NOTES 98). */
export const RECEIPTS_EXTENSION = 'https://rendezvous.nesher.co/ext/receipts/v1';

/** Timing of receipts and resends. The defaults are the reference implementation's; tests shorten them. */
export interface ReceiptTiming {
  /** Quiet period after an inbound envelope before its ack goes out: acks batch. */
  ackDelayMs: number;
  /** At most one ack per contact per this, however busy the channel. */
  ackMinIntervalMs: number;
  /** Up to this much more, at random, on each ack's quiet period: its timing says less about the message's. */
  ackJitterMs: number;
  /** First republish of an unconfirmed envelope; each later one waits twice as long. */
  retryAfterMs: number;
  /** Republishes per envelope; after the last one has had its wait, it is reported as not confirmed. */
  maxRetries: number;
}

/** 60 s, 2, 4, 8 min, then 16 min more: reported after about 31 minutes, far inside the 48 h ttl. */
export const RECEIPT_TIMING: Readonly<ReceiptTiming> = Object.freeze({
  ackDelayMs: 2_000,
  ackMinIntervalMs: 10_000,
  ackJitterMs: 3_000,
  retryAfterMs: 60_000,
  maxRetries: 4,
});

/** An envelope of ours the peer has not confirmed yet. */
export interface PendingEnvelope {
  seq: number;
  /** Its hash: the outbox entry to republish. */
  hash: string;
  /** When it was first sent (ISO). */
  sent: string;
  /** Republishes so far (a reconnect's flush does not count). */
  tries: number;
  /** When it was last republished (ISO): the next wait counts from here. */
  last?: string;
  /** Retries spent and still no receipt: the owner was told. A late receipt still clears it. */
  unconfirmed?: true;
  /** Reconnects that republished it after it was reported (at most `maxRetries`). */
  flushes?: number;
}

/** Per contact: what we wait for, and what we owe it. */
export interface PeerDelivery {
  /** The first seq tracked here: an older one (sent before receipts, or by the copy a restore replaced) is not known. */
  from?: number;
  /** Highest seq of ours the peer confirmed (every one below it too). */
  acked: number;
  /** Envelopes not confirmed yet, by seq. */
  pending: PendingEnvelope[];
  /** Since when we owe the peer an ack (ISO): it goes out after the quiet period. */
  ack_owed?: string;
  /** Our last ack to the peer: when, and the seq it carried. */
  ack_sent?: { at: string; seq: number };
  /** Receipts a duplicate earned since the peer's last new envelope, and when the last one did (capped, review of #112). */
  reacks?: number;
  reack_at?: string;
  /** When a reconnect last republished to this peer (one per `retryAfterMs`). */
  flushed_at?: string;
}

/** Whether a card says its agent sends and expects receipts. */
export function confirmsDelivery(card: AddressCard | undefined): boolean {
  return !!card && Array.isArray(card.capabilities) && card.capabilities.includes(RECEIPTS_EXTENSION);
}

/** The seq a peer's `rdv/ack` confirms, or null when it is malformed (exactly `type`, `v` 1 and a positive integer `seq`). */
export function ackSeq(payload: Record<string, unknown>): number | null {
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'seq,type,v' || payload.v !== 1) return null;
  const seq = payload.seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 ? seq : null;
}

const ms = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso));

/** When a pending envelope is due again: republished, or reported once its retries are spent. Null once reported. */
export function retryDue(p: PendingEnvelope, timing: ReceiptTiming): number | null {
  if (p.unconfirmed) return null;
  const base = ms(p.last ?? p.sent);
  return Number.isFinite(base) ? base + timing.retryAfterMs * 2 ** Math.min(p.tries, 30) : 0;
}

/** When the ack we owe a peer is due, or null if we owe none. `ack_owed` already carries the jitter. */
export function ackDue(d: PeerDelivery, timing: ReceiptTiming): number | null {
  if (d.ack_owed === undefined) return null;
  const owed = ms(d.ack_owed);
  const sent = ms(d.ack_sent?.at);
  return Math.max(Number.isFinite(owed) ? owed + timing.ackDelayMs : 0, Number.isFinite(sent) ? sent + timing.ackMinIntervalMs : 0);
}

/**
 * The earliest moment anything in `delivery` is due (an ack, a republish, a
 * report), or null. A host that builds an agent per item reads it from the
 * saved state to know when to run `deliveryTick` again.
 */
export function nextDeliveryDue(delivery: Record<string, PeerDelivery> | undefined, timing: ReceiptTiming = RECEIPT_TIMING): number | null {
  let next: number | null = null;
  const take = (t: number | null) => {
    if (t !== null && (next === null || t < next)) next = t;
  };
  for (const d of Object.values(delivery ?? {})) {
    if (!d || typeof d !== 'object') continue;
    take(ackDue(d, timing));
    for (const p of Array.isArray(d.pending) ? d.pending : []) take(retryDue(p, timing));
  }
  return next;
}

/** One contact's delivery as the owner sees it. */
export interface DeliverySummary {
  /** The contact's card lists receipts: its agent confirms what it holds. */
  confirms_delivery: boolean;
  /** Highest seq it confirmed. */
  confirmed_seq: number;
  /** Sent, not confirmed yet, still being retried. */
  waiting: number;
  /** Retries spent and no receipt. */
  not_confirmed: number;
  /** When the oldest of those was sent (ISO), or null. */
  oldest_since: string | null;
}

export function deliverySummary(d: PeerDelivery | undefined, card: AddressCard | undefined): DeliverySummary {
  const pending = Array.isArray(d?.pending) ? d.pending : [];
  return {
    confirms_delivery: confirmsDelivery(card),
    confirmed_seq: typeof d?.acked === 'number' ? d.acked : 0,
    waiting: pending.filter((p) => !p.unconfirmed).length,
    not_confirmed: pending.filter((p) => p.unconfirmed).length,
    oldest_since: pending.length ? pending[0].sent : null,
  };
}

/** What became of one envelope we sent: confirmed, still waiting, not confirmed after every retry, or not tracked. */
export type DeliveryState = 'delivered' | 'pending' | 'not_confirmed' | 'untracked';

export function deliveryOf(d: PeerDelivery | undefined, seq: number): DeliveryState {
  if (!d) return 'untracked';
  const p = d.pending.find((x) => x.seq === seq);
  if (p) return p.unconfirmed ? 'not_confirmed' : 'pending';
  // Only what was tracked here: an envelope from before (another epoch, before receipts) is not known delivered.
  return seq <= d.acked && seq >= (d.from ?? 1) ? 'delivered' : 'untracked';
}
