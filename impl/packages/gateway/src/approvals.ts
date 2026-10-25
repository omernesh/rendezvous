// What the approval page shows, and the digest each approval is bound to.
//
// Every item the owner can approve is a snapshot of what the page showed:
// the digest covers every field shown (and what derives them), so the
// approve action can refuse when the item changed between the page and the
// click, checked again under the home lock (NOTES 59 pattern, as rdv_grant).
import { agreedSnapshot, awaitingHuman, describeSlot, meetingSnapshot, type NegotiationTask } from '@rendezvous/a2a';
import { type AgentState, defaultTier, fingerprint, type GrantCandidate, type PendingRequest, type Tier } from '@rendezvous/core';
import { candidateDigest, candidateLabel, clean, type Home, meetingDigest, requestSubject, TIERS } from '@rendezvous/cli/lib';
import type { ApprovalAsk } from '@rendezvous/mcp';
import { sha256 } from './http.js';

export type ItemKind = ApprovalAsk['kind'];

export interface ApprovalItem {
  kind: ItemKind;
  id: string;
  digest: string;
  title: string;
  /** Label / value rows, all ours or cleaned; escaped when rendered. */
  rows: Array<[string, string]>;
  /** Peer-written text, shown quoted and marked untrusted. */
  quoted?: { what: string; text: string };
  /** The editable fields, prefilled with what is proposed. */
  tier?: Tier;
  mayMeet?: boolean;
  label?: string;
  hasLabel: boolean;
  /** A remote client asked for this (its suggestions are prefilled). */
  asked: boolean;
}

const canon = (o: Record<string, unknown>) => sha256(JSON.stringify(o));

/** The digest of a pending request as the page shows it: the consent subject plus the shown hint and greeting. */
export function requestDigest(p: PendingRequest): string {
  return canon({ k: 'rdv1/gateway-request', subject: requestSubject(p), to_hint: p.request.to_hint, greeting: p.request.greeting ?? '' });
}

/** The digest of a probe answer as the page shows it. */
export function candidateShownDigest(c: GrantCandidate): string {
  return canon({ k: 'rdv1/gateway-candidate', subject: candidateDigest(c), tier: c.grant.tier ?? null });
}

const isAddress = (s: string) => s.includes('@') || s.startsWith('+');
const short = (s: unknown, n = 200) => {
  const t = clean(String(s ?? ''), true);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Asks from remote clients, bounded: the newest MAX_ASKS are kept. They only
 * prefill the page and mark items; nothing is approved from them.
 */
export class Asks {
  static readonly MAX = 256;
  private readonly map = new Map<string, ApprovalAsk>();

  add(a: ApprovalAsk): void {
    const key = `${a.kind}:${a.id}`;
    this.map.delete(key);
    this.map.set(key, a);
    while (this.map.size > Asks.MAX) this.map.delete(this.map.keys().next().value!);
  }

  get(kind: ItemKind, id: string): ApprovalAsk | undefined {
    return this.map.get(`${kind}:${id}`);
  }

  drop(kind: ItemKind, id: string): void {
    this.map.delete(`${kind}:${id}`);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Everything waiting for the owner, read under the home lock. */
export async function listApprovals(home: Home, asks: Asks): Promise<ApprovalItem[]> {
  return home.locked(async () => {
    const book = (home.readAgentState() as AgentState).book;
    const items: ApprovalItem[] = [];
    const pending = Object.values(book.pending ?? {}) as PendingRequest[];
    pending.sort((a, b) => a.received.localeCompare(b.received));
    for (const p of pending) {
      const ask = asks.get('request', p.request.id) as Extract<ApprovalAsk, { kind: 'request' }> | undefined;
      const hint = p.request.to_hint;
      items.push({
        kind: 'request',
        id: p.request.id,
        digest: requestDigest(p),
        title: 'Contact request',
        rows: [
          ['From agent', short(p.request.from)],
          ['Fingerprint', short(fingerprint(p.request.from))],
          [
            'Binding',
            p.binding === 'claimed'
              ? 'claimed: anyone can claim an address, so this does not prove who sent it. Compare the fingerprint with the person through another channel.'
              : short(p.binding),
          ],
          ['Arrived as', isAddress(hint) ? `a discovery probe for your address ${short(hint, 80)}` : 'a request sent straight to your card'],
          ['Received', short(p.received)],
        ],
        quoted: { what: 'Greeting, written by the requester (untrusted)', text: short(p.request.greeting ?? '', 600) },
        tier: ask?.tier && (TIERS as string[]).includes(ask.tier) ? ask.tier : defaultTier(p.binding),
        mayMeet: ask?.may_propose_meetings ?? true,
        label: ask?.label,
        hasLabel: true,
        asked: !!ask,
      });
    }
    const candidates = Object.values(book.candidates ?? {}) as GrantCandidate[];
    candidates.sort((a, b) => a.received.localeCompare(b.received));
    for (const c of candidates) {
      const ask = asks.get('candidate', c.grant.id) as Extract<ApprovalAsk, { kind: 'candidate' }> | undefined;
      items.push({
        kind: 'candidate',
        id: c.grant.id,
        digest: candidateShownDigest(c),
        title: 'Answer to your discovery probe',
        rows: [
          ['Probe for', short(c.to_hint, 80)],
          ['From agent', short(c.grant.from)],
          ['Fingerprint', short(fingerprint(c.grant.from))],
          ['Their tier for you', short(c.grant.tier ?? '')],
          ['Received', short(c.received)],
          ['Note', 'Anyone who saw the probe can answer it, and its card only claims the address. Compare the fingerprint with the person through another channel.'],
        ],
        label: ask?.label ?? candidateLabel(c, book.outstanding ?? {}),
        hasLabel: true,
        asked: !!ask,
      });
    }
    let tasks: NegotiationTask[] = [];
    try {
      tasks = Object.values(home.readNegotiations().tasks);
    } catch {
      // contact approvals keep working with a broken negotiations file
    }
    tasks.sort((a, b) => a.created.localeCompare(b.created));
    for (const t of tasks) {
      const snap = awaitingHuman(t) ? meetingSnapshot(t) : undefined;
      if (snap) {
        const slot = t.hold!.slot;
        items.push({
          kind: 'meeting',
          id: t.id,
          digest: meetingDigest(snap),
          title: 'Dinner held for you',
          rows: [
            ['With agent', short(t.peer)],
            ['Fingerprint', short(fingerprint(t.peer))],
            ['When', `${short(describeSlot(slot))} (${short(slot.start)} to ${short(slot.end)})`],
            ['Step', t.hold!.stage === 'human-accept' ? 'They offered this time; your agent will accept it.' : 'They accepted this time from your offer; your agent will confirm it.'],
          ],
          quoted: t.place ? { what: 'Place (untrusted, may be written by the peer)', text: short(JSON.stringify(t.place), 300) } : undefined,
          hasLabel: false,
          asked: !!asks.get('meeting', t.id),
        });
      }
      const agreed = agreedSnapshot(t);
      const cancelAsk = asks.get('cancel', t.id) as Extract<ApprovalAsk, { kind: 'cancel' }> | undefined;
      if (agreed && cancelAsk) {
        items.push({
          kind: 'cancel',
          id: t.id,
          digest: meetingDigest(agreed),
          title: 'Cancel an agreed dinner?',
          rows: [
            ['With agent', short(t.peer)],
            ['Fingerprint', short(fingerprint(t.peer))],
            ['When', `${short(describeSlot(t.agreed!))} (${short(t.agreed!.start)} to ${short(t.agreed!.end)})`],
            ['Effect', 'Canceling frees it in your calendar and tells their agent, which frees it in theirs.'],
          ],
          quoted: t.place ? { what: 'Place (untrusted, may be written by the peer)', text: short(JSON.stringify(t.place), 300) } : undefined,
          hasLabel: false,
          asked: true,
        });
      }
    }
    return items;
  });
}
