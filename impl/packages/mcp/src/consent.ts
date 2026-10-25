// Confirm phrases: the fallback consent channel when the MCP client can't
// elicit (PLAN §6.1, demo-critical). A random phrase per pending request,
// kept in consent.json (mode 600) and shown only on human-facing channels:
// `rdv contact pending` in a terminal and this server's stderr. It is never
// part of a tool result, so the model can only learn it from its human.
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { ConsentEntry, Home } from '@rendezvous/cli/lib';

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

/**
 * Make sure each pending request has a phrase and drop phrases for requests
 * that are gone. Call under the home lock. Returns the phrases it created.
 */
export function syncPhrases(home: Home, pendingIds: string[]): Array<{ id: string; phrase: string }> {
  const consent = home.readConsent();
  const created: Array<{ id: string; phrase: string }> = [];
  const next: Record<string, ConsentEntry> = {};
  for (const id of pendingIds) {
    next[id] = consent[id] ?? { phrase: newPhrase(), created: new Date().toISOString(), attempts: 0 };
    if (!consent[id]) created.push({ id, phrase: next[id].phrase });
  }
  if (created.length || Object.keys(consent).length !== pendingIds.length || Object.keys(consent).some((id) => !next[id])) {
    home.writeConsent(next);
  }
  return created;
}

export type PhraseCheck = { ok: true } | { ok: false; reason: 'no-phrase' | 'wrong'; rotated?: string; left: number };

/** Check a phrase for one request. Call under the home lock. A wrong guess counts; MAX_ATTEMPTS replaces the phrase. */
export function checkPhrase(home: Home, requestId: string, given: string): PhraseCheck {
  const consent = home.readConsent();
  const entry = consent[requestId];
  if (!entry) return { ok: false, reason: 'no-phrase', left: MAX_ATTEMPTS };
  if (same(given, entry.phrase)) return { ok: true };
  entry.attempts += 1;
  let rotated: string | undefined;
  if (entry.attempts >= MAX_ATTEMPTS) {
    rotated = newPhrase();
    consent[requestId] = { phrase: rotated, created: new Date().toISOString(), attempts: 0 };
  }
  home.writeConsent(consent);
  return { ok: false, reason: 'wrong', rotated, left: rotated ? MAX_ATTEMPTS : MAX_ATTEMPTS - entry.attempts };
}

export function dropPhrase(home: Home, requestId: string): void {
  const consent = home.readConsent();
  if (!consent[requestId]) return;
  delete consent[requestId];
  home.writeConsent(consent);
}
