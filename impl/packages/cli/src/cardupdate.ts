// `rdv/card-update` in the hosts (SPEC §4.3, NOTES 82, issue #45): our card
// goes to our contacts when it changes, and a contact's newer card replaces
// the one we hold. Receiving runs in handleInbound (listen.ts); this file has
// the sending at a listener's start and the views.
import { Agent, type CardUpdate, type CardUpdateReport, fingerprint, type Transport } from '@rendezvous/core';
import type { Home } from './home.js';
import { clean } from './output.js';

/**
 * Send our current card to every contact that has not had it (a contact made
 * before card updates existed, or one whose send failed), under the home
 * lock, saving before each envelope leaves (beforeSend) and after. Nothing to
 * send: the state is not even rewritten. `transport` is the listener's own
 * connection (left open).
 */
export async function syncContactCards(home: Home, transport: Transport): Promise<CardUpdateReport> {
  return home.locked(async () => {
    const agent = Agent.fromJSON(home.readAgentState(), () => transport);
    if (agent.cardUpdatesDue().length === 0) return { sent: [], failed: [] };
    agent.beforeSend = (a) => home.writeAgentState(a.toJSON());
    const report = await agent.sendCardUpdates();
    home.writeAgentState(agent.toJSON());
    return report;
  });
}

/** The card updates we sent, in words (null when none went out or failed). */
export function cardSyncText(r: CardUpdateReport): string | null {
  if (r.sent.length === 0 && r.failed.length === 0) return null;
  const failed = r.failed.length ? `; ${r.failed.length} failed (retried at the next start or card change)` : '';
  return `sent our current card to ${r.sent.length} contact(s)${failed}`;
}

/** A contact's new card, for events.jsonl and `rdv listen --json`. Relays and capabilities are the peer's text. */
export function cardUpdateView(u: CardUpdate) {
  return {
    event: 'card-update',
    peer: u.contact.peer,
    fingerprint: fingerprint(u.contact.peer),
    // Our own human's name for the peer (local, never from the card).
    label: u.contact.label,
    created: u.contact.card.created,
    previous_created: u.previous.created,
    relays_added: u.change.relays.added,
    relays_removed: u.change.relays.removed,
    capabilities_added: u.change.capabilities.added,
    capabilities_removed: u.change.capabilities.removed,
    addresses_changed: u.change.addresses_changed,
  };
}

export function cardUpdateText(u: CardUpdate): string {
  const v = cardUpdateView(u);
  const list = (label: string, xs: string[]) => (xs.length ? `  ${label} ${xs.map((x) => clean(x)).join(', ')}` : '');
  const label = v.label ? ` (${clean(v.label)})` : '';
  return (
    `card updated by ${clean(v.peer)}${label} fingerprint ${clean(v.fingerprint)}` +
    list('relays +', v.relays_added) +
    list('relays -', v.relays_removed) +
    list('capabilities +', v.capabilities_added) +
    list('capabilities -', v.capabilities_removed) +
    (v.addresses_changed ? '  its claimed addresses changed' : '') +
    '; your grant, its grant and the label are unchanged'
  );
}
