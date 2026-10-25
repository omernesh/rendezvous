// Confirm phrases: the fallback consent channel when the MCP client can't
// elicit (PLAN §6.1, demo-critical). A random phrase per pending request,
// kept in consent.json (mode 600) and shown only on human-facing channels:
// `rdv contact pending` in a terminal and this server's stderr. It is never
// part of a tool result, so the model can only learn it from its human.
//
// Phrases are scoped by action: request IDs, grant IDs and task IDs are all
// chosen by peers, so one peer could make them equal. A phrase is stored under
// `<action>:<id>` with its action, and checked only for that action: the
// phrase shown for "approve contact" can never confirm a dinner, or the
// reverse (security review of issue #8).
//
// A meeting phrase is also bound to the meeting itself: the digest of what
// the human was shown (meetingDigest of the MeetingSnapshot). The task ID is
// the peer's, and a task can change under it, so a phrase approves only the
// meeting it was issued for; a changed hold gets a new phrase.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { type ConsentAction, type ConsentEntry, consentKey, type Home } from '@rendezvous/cli/lib';

export interface PhraseTarget {
  action: ConsentAction;
  id: string;
  /** meeting: meetingDigest of the held meeting; the phrase approves only that. */
  digest?: string;
}

// 64 short, distinct, easy-to-say words: 6 bits each.
const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'aspen', 'badge', 'basil', 'beacon',
  'birch', 'bison', 'blaze', 'bloom', 'brook', 'cabin', 'canyon', 'cedar',
  'chalk', 'cliff', 'clover', 'comet', 'coral', 'crane', 'delta', 'dune',
  'ember', 'fable', 'fern', 'fjord', 'flint', 'forest', 'garnet', 'glade',
  'granite', 'harbor', 'hazel', 'heron', 'island', 'ivory', 'jasper', 'juniper',
  'kettle', 'lagoon', 'lantern', 'lemon', 'lotus', 'maple', 'meadow', 'mesa',
  'nectar', 'olive', 'orchid', 'otter', 'pebble', 'pine', 'quartz', 'raven',
  'river', 'saffron', 'summit', 'thistle', 'tundra', 'velvet', 'willow', 'zephyr',
];

/** Wrong guesses allowed per phrase; then it is replaced and the human must look again. */
export const MAX_ATTEMPTS = 5;

/** Three words and three digits, about 28 bits; with MAX_ATTEMPTS that is out of guessing range. */
export function newPhrase(): string {
  const w = () => WORDS[randomInt(WORDS.length)];
  return `${w()}-${w()}-${w()}-${String(randomInt(1000)).padStart(3, '0')}`;
}

export function normalizePhrase(p: string): string {
  return p
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(normalizePhrase(a));
  const y = Buffer.from(normalizePhrase(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The stored entry for this action and ID, only if it was issued for that action. */
function entryFor(consent: Record<string, ConsentEntry>, t: PhraseTarget): ConsentEntry | undefined {
  const key = consentKey(t.action, t.id);
  const e = Object.hasOwn(consent, key) ? consent[key] : undefined;
  return e?.action === t.action ? e : undefined;
}

function fresh(t: PhraseTarget, previous?: string): ConsentEntry {
  return {
    action: t.action,
    phrase: newPhrase(),
    ...(t.digest !== undefined ? { digest: t.digest } : {}),
    ...(previous !== undefined ? { previous } : {}),
    created: new Date().toISOString(),
    attempts: 0,
  };
}

/**
 * Make sure each target (pending request, probe answer, held meeting) has a
 * phrase, replace the phrase of a meeting that changed (other digest), and
 * drop phrases for targets that are gone. Call under the home lock. Returns
 * the phrases it created; `changed` marks a replacement.
 */
export function syncPhrases(home: Home, targets: PhraseTarget[]): Array<PhraseTarget & { phrase: string; changed?: boolean }> {
  const consent = home.readConsent();
  const created: Array<PhraseTarget & { phrase: string; changed?: boolean }> = [];
  const next: Record<string, ConsentEntry> = {};
  for (const t of targets) {
    const key = consentKey(t.action, t.id);
    const have = entryFor(consent, t);
    if (have && have.digest === t.digest) {
      next[key] = have;
      continue;
    }
    next[key] = fresh(t, have?.phrase);
    created.push({ ...t, phrase: next[key].phrase, ...(have ? { changed: true } : {}) });
  }
  const keys = Object.keys(consent);
  if (created.length || keys.length !== Object.keys(next).length || keys.some((k) => !next[k])) home.writeConsent(next);
  return created;
}

export type PhraseCheck = { ok: true } | { ok: false; reason: 'no-phrase' | 'wrong' | 'changed'; rotated?: string; left: number };

/**
 * Check a phrase for one action on one ID (and, for a meeting, the digest of
 * the meeting being confirmed). Call under the home lock. Only a phrase
 * issued for that same action and meeting counts: one issued for another
 * meeting, or replaced because the meeting changed, is 'changed' (the caller
 * re-syncs and asks the human again). A wrong guess counts; MAX_ATTEMPTS
 * replaces the phrase.
 */
export function checkPhrase(home: Home, target: PhraseTarget, given: string): PhraseCheck {
  const consent = home.readConsent();
  const entry = entryFor(consent, target);
  if (!entry) return { ok: false, reason: 'no-phrase', left: MAX_ATTEMPTS };
  if (entry.digest !== target.digest) return { ok: false, reason: 'changed', left: MAX_ATTEMPTS - entry.attempts };
  if (same(given, entry.phrase)) return { ok: true };
  if (entry.previous !== undefined && same(given, entry.previous)) return { ok: false, reason: 'changed', left: MAX_ATTEMPTS - entry.attempts };
  entry.attempts += 1;
  let rotated: string | undefined;
  if (entry.attempts >= MAX_ATTEMPTS) {
    const next = fresh(target);
    rotated = next.phrase;
    consent[consentKey(target.action, target.id)] = next;
  }
  home.writeConsent(consent);
  return { ok: false, reason: 'wrong', rotated, left: rotated ? MAX_ATTEMPTS : MAX_ATTEMPTS - entry.attempts };
}

export function dropPhrase(home: Home, target: PhraseTarget): void {
  const consent = home.readConsent();
  const key = consentKey(target.action, target.id);
  if (!Object.hasOwn(consent, key)) return;
  delete consent[key];
  home.writeConsent(consent);
}
