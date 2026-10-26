// Confirm phrases: the fallback consent channel when an MCP client can't
// elicit (PLAN §6.1). `rdv-mcp` issues a random phrase per thing waiting for
// the human (a pending request, a probe answer, a held dinner, canceling an
// agreed one) and shows it
// only on human-facing channels: its stderr, and `rdv contact pending` /
// `rdv dinner list` in text mode. It is never part of a tool result, so the
// model can only learn it from its human.
//
// What is stored (consent.json, mode 600) is a salted scrypt hash, never the
// phrase (issue #12, NOTES 57): a model that can read files as the same user
// can no longer lift a phrase from disk. The terminal can't show a stored
// phrase again either, so `rdv contact pending` and `rdv dinner list` issue a
// new one when they show it (the latest phrase shown wins).
//
// A phrase approves exactly what the human was shown (`digest`), never just
// an ID: request IDs, grant IDs and task IDs are all peer-chosen.
// - Scoped by action: stored under `<action>:<id>` with its action, checked
//   only for that action (security review of issue #8).
// - A meeting phrase is bound to meetingDigest of the held meeting (NOTES 59),
//   a cancel phrase to that of the agreed one (NOTES 61).
// - A request phrase is bound to the request (id, sender, binding, how and
//   when it arrived: `subject`) and to the terms shown with it, tier and
//   scope (`terms`). A model that presents it with another tier or scope is
//   refused, and the human is shown a new phrase for the terms it asked for.
// - A probe answer phrase is bound to that answer (id, grantor, probe).
// - Both are bound to the local label the contact will get (`label`, NOTES
//   62): a label decides who "tell John" reaches, so the model can't pick
//   one the human never saw. Another label means another phrase, shown to
//   the human with that label.
// - An inbound phrase (issue #1: grant an existing contact rights towards us,
//   which also sends it a reverse grant) is bound to that contact as the
//   human saw it (`subject`: peer, founding grant, binding, since, local
//   label) and to the tier and scope shown (`terms`), like a request.
// - A task phrase (`task-start`, `task-release`, issue #24) is bound to the
//   startDigest of the task at its start gate, or the releaseDigest of the
//   draft waiting to leave (tasks.ts), like a meeting phrase.
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  allowedCapabilities,
  canonicalize,
  type Contact,
  docHash,
  type GrantCandidate,
  type GrantScope,
  type GroupRecord,
  memberOf,
  type ReceivedInvite,
  MEETING_CAPABILITIES,
  MEETINGS_CAPABILITY,
  type PendingRequest,
  scopeAllows,
  type Tier,
} from '@rendezvous/core';
import { type ConsentAction, type ConsentEntry, type ConsentHash, type ConsentTerms, consentKey, type GroupTerms, type Home } from './home.js';

export interface PhraseTarget {
  action: ConsentAction;
  id: string;
  /** Digest of everything the phrase approves (what the human is shown). */
  digest?: string;
  /**
   * The thing being approved, without the terms (requests only; defaults to
   * `digest`). A phrase whose subject still matches is kept by syncPhrases
   * even if it was issued for other terms.
   */
  subject?: string;
  /** request, inbound: the tier and scope the phrase approves, shown to the human. */
  terms?: ConsentTerms;
  /** request, candidate: the local label the contact gets (none if absent), shown to the human. */
  label?: string;
  /** group-join: the scope and newcomer policy the join approves, shown to the human. */
  group?: GroupTerms;
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

// scrypt, not a fast hash: the phrase has only ~28 bits, so an unsalted or
// fast hash on disk would be reversed in seconds. N = 2^14 (16 MiB, tens of ms).
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function phraseHash(salt: Buffer, action: ConsentAction, id: string, digest: string | undefined, phrase: string): Buffer {
  const input = `rdv1/consent-phrase\0${action}\0${id}\0${digest ?? ''}\0${normalizePhrase(phrase)}`;
  return scryptSync(input, salt, 32, SCRYPT);
}

function seal(action: ConsentAction, id: string, digest: string | undefined, phrase: string): ConsentHash {
  const salt = randomBytes(16);
  return { salt: salt.toString('base64url'), hash: phraseHash(salt, action, id, digest, phrase).toString('base64url'), ...(digest !== undefined ? { digest } : {}) };
}

function matches(h: ConsentHash, action: ConsentAction, id: string, given: string): boolean {
  const want = Buffer.from(h.hash, 'base64url');
  const got = phraseHash(Buffer.from(h.salt, 'base64url'), action, id, h.digest, given);
  return want.length === got.length && timingSafeEqual(want, got);
}

const sha256 = (tag: string, value: unknown): string => createHash('sha256').update(`${tag}\0${canonicalize(value)}`).digest('hex');

/**
 * A change to our listening relays the model asked for (rdv_relays): bound to
 * the change, the URL and the relays as they were when the human was asked,
 * so it approves nothing once the relays changed. One open ask at a time.
 */
export function relaysTarget(change: 'add' | 'remove', url: string, before: readonly string[]): PhraseTarget {
  const subject = `relays/v1\0${change}\0${url}\0${before.join('\0')}`;
  return { action: 'relays', id: 'listen', subject, digest: sha256('rdv1/relays-change', { change, url, before: [...before] }) };
}

/** The open relay-change ask, kept by a re-sync (it is issued only when the model asks). */
export function relaysAsk(home: Home): PhraseTarget | undefined {
  const raw = home.readConsent() as Record<string, unknown>;
  const e = raw[consentKey('relays', 'listen')] as ConsentEntry | undefined;
  if (!e || e.action !== 'relays' || typeof e.digest !== 'string' || typeof e.subject !== 'string') return undefined;
  return { action: 'relays', id: 'listen', digest: e.digest, subject: e.subject };
}

/** The relay change an ask approves, in words, from its subject (relaysTarget). */
export function describeRelaysAsk(t: PhraseTarget): string {
  const [, change, url, ...before] = (t.subject ?? '').split('\0');
  return `${change === 'remove' ? 'stop listening on' : 'listen on'} ${url} (your relays now: ${before.join(', ') || 'none'})`;
}

/** What a request phrase is about, apart from the terms: this request as it arrived. */
export function requestSubject(p: PendingRequest): string {
  return sha256('rdv1/request-consent', { id: p.request.id, from: p.request.from, binding: p.binding, direct: p.direct === true, received: p.received });
}

/**
 * The digest a request phrase approves: the request and the tier, scope and
 * local label shown with it. Without a label it is the digest of rev 1.
 */
export function termsDigest(subject: string, terms: ConsentTerms, label?: string): string {
  return sha256('rdv1/grant-terms', { subject, tier: terms.tier, scope: terms.scope, ...(label !== undefined ? { label } : {}) });
}

export function requestTarget(p: PendingRequest, tier: Tier, scope: GrantScope, label?: string): PhraseTarget {
  const subject = requestSubject(p);
  const terms: ConsentTerms = { tier, scope };
  return { action: 'request', id: p.request.id, subject, digest: termsDigest(subject, terms, label), terms, ...(label !== undefined ? { label } : {}) };
}

/** What a probe-answer phrase is about, apart from the label: this answer from this grantor to this probe. */
export function candidateDigest(c: GrantCandidate): string {
  return sha256('rdv1/candidate-consent', { id: c.grant.id, from: c.grant.from, request_ref: c.request_ref, to_hint: c.to_hint, received: c.received });
}

/** The digest a probe-answer phrase approves: the answer (`subject`, candidateDigest) and the local label shown with it. */
export function candidateLabelDigest(subject: string, label: string | undefined): string {
  return sha256('rdv1/candidate-label', { subject, label: label ?? null });
}

/**
 * The label a confirmed probe answer gets unless the human names it otherwise:
 * the one our human gave the probe, else the probed address (as
 * ContactBook.confirmCandidate). `outstanding` is the book's open requests.
 */
export function candidateLabel(c: GrantCandidate, outstanding: Record<string, { label?: string }>): string {
  const o = Object.hasOwn(outstanding, c.request_ref) ? outstanding[c.request_ref] : undefined;
  return o?.label ?? c.to_hint;
}

/** The phrase target for confirming `c` as a contact labeled `label` (the probed address by default: candidateLabel). */
export function candidateTarget(c: GrantCandidate, label: string | undefined): PhraseTarget {
  const subject = candidateDigest(c);
  return { action: 'candidate', id: c.grant.id, subject, digest: candidateLabelDigest(subject, label), ...(label !== undefined ? { label } : {}) };
}

/**
 * What an inbound phrase is about, apart from the terms: this contact as the
 * human saw it. A contact revoked and made again (another founding grant or
 * `since`), or renamed, is another subject, so the phrase approves nothing.
 */
export function inboundSubject(c: Contact): string {
  return sha256('rdv1/inbound-consent', { peer: c.peer, grant_id: c.grantId, binding: c.binding, since: c.since, label: c.label ?? null });
}

/** The phrase target for granting contact `c` exactly this tier and scope towards us (Agent.allowInbound). */
export function inboundTarget(c: Contact, tier: Tier, scope: GrantScope): PhraseTarget {
  const subject = inboundSubject(c);
  const terms: ConsentTerms = { tier, scope };
  return { action: 'inbound', id: c.peer, subject, digest: termsDigest(subject, terms), terms };
}

/**
 * The terms of each usable inbound phrase, by peer. Inbound phrases are issued
 * only when the model asks, so a re-sync keeps each one for its contact with
 * these terms (and drops it when the contact is gone).
 */
export function inboundAsks(home: Home): Map<string, ConsentTerms> {
  const asks = new Map<string, ConsentTerms>();
  for (const [k, e] of Object.entries(load(home).consent)) {
    const prefix = consentKey('inbound', '');
    if (e.action === 'inbound' && e.terms && k.startsWith(prefix)) asks.set(k.slice(prefix.length), e.terms);
  }
  return asks;
}

const ACTIONS: readonly string[] = ['request', 'candidate', 'meeting', 'cancel', 'inbound', 'task-start', 'task-release', 'relays', 'group-join', 'group-newcomer', 'group-invite'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isHash = (h: unknown): h is ConsentHash =>
  !!h && typeof h === 'object' && isStr((h as ConsentHash).salt) && isStr((h as ConsentHash).hash) && ((h as ConsentHash).digest === undefined || isStr((h as ConsentHash).digest));

/**
 * A usable stored entry (its key is checked against its action by entryFor).
 * Anything else approves nothing and is dropped on the next write: a plaintext `phrase` from an older consent.json (issue #12),
 * a missing hash, request terms or a label that don't hash to the stored digest, or a probe-answer phrase from before labels
 * were bound (no subject).
 */
function valid(e: unknown): e is ConsentEntry {
  if (!e || typeof e !== 'object' || 'phrase' in e) return false;
  const x = e as ConsentEntry;
  if (!ACTIONS.includes(x.action)) return false;
  if (!isStr(x.salt) || !isStr(x.hash) || !Number.isInteger(x.attempts)) return false;
  if (x.previous !== undefined && (!isHash(x.previous) || 'phrase' in x.previous)) return false;
  if (x.label !== undefined && !isStr(x.label)) return false;
  if (x.action === 'candidate') return isStr(x.subject) && x.digest === candidateLabelDigest(x.subject, x.label);
  // A join phrase is always bound to the invite as shown and to the join's terms (issue #77); it sets no label or tier.
  if (x.action === 'group-join') {
    try {
      return isStr(x.subject) && x.group !== undefined && x.terms === undefined && x.label === undefined && x.digest === joinTermsDigest(x.subject, x.group);
    } catch {
      return false;
    }
  }
  if (x.group !== undefined) return false;
  if (x.action === 'inbound' && (x.terms === undefined || x.label !== undefined)) return false; // always bound to terms; never sets a label
  if (x.terms !== undefined) {
    try {
      if (!isStr(x.subject) || x.digest !== termsDigest(x.subject, x.terms, x.label)) return false;
    } catch {
      return false; // terms that don't even canonicalize
    }
  } else if (x.label !== undefined) return false;
  return true;
}

/** consent.json without anything unusable; `dirty` when something had to be dropped. */
function load(home: Home): { consent: Record<string, ConsentEntry>; dirty: boolean } {
  const raw = home.readConsent() as Record<string, unknown>;
  const consent: Record<string, ConsentEntry> = {};
  let dirty = false;
  for (const [k, e] of Object.entries(raw)) {
    if (valid(e)) consent[k] = e;
    else dirty = true;
  }
  return { consent, dirty };
}

/** The stored entry for this action and ID, only if it was issued for that action. */
function entryFor(consent: Record<string, ConsentEntry>, t: PhraseTarget): ConsentEntry | undefined {
  const key = consentKey(t.action, t.id);
  const e = Object.hasOwn(consent, key) ? consent[key] : undefined;
  return e?.action === t.action ? e : undefined;
}

const subjectOf = (x: { subject?: string; digest?: string }) => x.subject ?? x.digest;

function fresh(t: PhraseTarget, previous?: ConsentEntry): { entry: ConsentEntry; phrase: string } {
  const phrase = newPhrase();
  const { salt, hash } = seal(t.action, t.id, t.digest, phrase);
  const entry: ConsentEntry = {
    action: t.action,
    ...(t.digest !== undefined ? { digest: t.digest } : {}),
    ...(t.subject !== undefined && t.subject !== t.digest ? { subject: t.subject } : {}),
    ...(t.terms !== undefined ? { terms: t.terms } : {}),
    ...(t.label !== undefined ? { label: t.label } : {}),
    ...(t.group !== undefined ? { group: t.group } : {}),
    salt,
    hash,
    ...(previous ? { previous: { salt: previous.salt, hash: previous.hash, ...(previous.digest !== undefined ? { digest: previous.digest } : {}) } } : {}),
    created: new Date().toISOString(),
    attempts: 0,
  };
  return { entry, phrase };
}

export type IssuedPhrase = PhraseTarget & { phrase: string; changed?: boolean };

/**
 * Make sure each target (pending request, probe answer, held meeting) has a
 * phrase, replace the phrase of a target that changed (other subject), and
 * drop phrases for targets that are gone. A request phrase issued for other
 * terms than the target's is kept: the terms are the model's ask, the
 * subject is what has to stay the same. Call under the home lock. Returns the
 * phrases it created (the only place a phrase exists in clear); `changed`
 * marks a replacement.
 */
export function syncPhrases(home: Home, targets: PhraseTarget[]): IssuedPhrase[] {
  const { consent, dirty } = load(home);
  const created: IssuedPhrase[] = [];
  const next: Record<string, ConsentEntry> = {};
  for (const t of targets) {
    const key = consentKey(t.action, t.id);
    const have = entryFor(consent, t);
    if (have && subjectOf(have) === subjectOf(t)) {
      next[key] = have;
      continue;
    }
    const { entry, phrase } = fresh(t, have);
    next[key] = entry;
    created.push({ ...t, phrase, ...(have ? { changed: true } : {}) });
  }
  const keys = Object.keys(consent);
  if (dirty || created.length || keys.length !== Object.keys(next).length || keys.some((k) => !next[k])) home.writeConsent(next);
  return created;
}

/**
 * Issue a new phrase for exactly this target, replacing the one stored under
 * its action and ID (which stops working). For a request whose phrase was
 * issued for other terms than the model asks for. Call under the home lock.
 */
export function issuePhrase(home: Home, t: PhraseTarget): IssuedPhrase {
  const { consent } = load(home);
  const have = entryFor(consent, t);
  const { entry, phrase } = fresh(t, have);
  consent[consentKey(t.action, t.id)] = entry;
  home.writeConsent(consent);
  return { ...t, phrase, ...(have ? { changed: true } : {}) };
}

/**
 * The terminal's view (`rdv contact pending`, `rdv dinner list`, text mode):
 * the stored phrase can't be shown again, so each target that has a current
 * phrase gets a new one for the same digest and terms, which replaces it.
 * Targets give `subject` (requests, probe answers) or `digest`; an entry for
 * another subject is stale and not shown. Call under the home lock.
 */
export function reissueForDisplay(home: Home, targets: PhraseTarget[]): Map<string, ShownPhrase> {
  const { consent, dirty } = load(home);
  const shown = new Map<string, ShownPhrase>();
  for (const t of targets) {
    const have = entryFor(consent, t);
    if (!have || subjectOf(have) !== subjectOf(t)) continue;
    const same: PhraseTarget = { action: have.action, id: t.id, digest: have.digest, subject: have.subject, terms: have.terms, label: have.label, group: have.group };
    const { entry, phrase } = fresh(same, have);
    consent[consentKey(t.action, t.id)] = entry;
    shown.set(consentKey(t.action, t.id), {
      phrase,
      ...(have.terms ? { terms: have.terms } : {}),
      ...(have.label !== undefined ? { label: have.label } : {}),
      ...(have.group ? { group: have.group } : {}),
    });
  }
  if (dirty || shown.size) home.writeConsent(consent);
  return shown;
}

/** A phrase the terminal shows, with what it approves. */
export interface ShownPhrase {
  phrase: string;
  terms?: ConsentTerms;
  label?: string;
  group?: GroupTerms;
}

export type PhraseCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       * no-phrase: none stored. changed: the target is not what the phrase was
       * issued for (re-sync, ask again). terms: the phrase approves other
       * terms or another label (`terms`, `label` say which). stale: a phrase
       * replaced by a newer one for the same thing. wrong: not the phrase
       * (counts as a try).
       */
      reason: 'no-phrase' | 'wrong' | 'changed' | 'terms' | 'stale';
      rotated?: string;
      terms?: ConsentTerms;
      label?: string;
      group?: GroupTerms;
      left: number;
    };

/**
 * Check a phrase for one action on one ID and digest (what the caller is
 * about to do: the meeting being confirmed, the request with the tier,
 * scope and label being granted, the probe answer with its label). Call under the home lock. Only a phrase issued for
 * that same action, subject and digest counts. A wrong guess counts;
 * MAX_ATTEMPTS replaces the phrase.
 */
export function checkPhrase(home: Home, target: PhraseTarget, given: string): PhraseCheck {
  const { consent } = load(home);
  const entry = entryFor(consent, target);
  if (!entry) return { ok: false, reason: 'no-phrase', left: MAX_ATTEMPTS };
  const left = MAX_ATTEMPTS - entry.attempts;
  if (subjectOf(entry) !== subjectOf(target)) return { ok: false, reason: 'changed', left };
  if (entry.digest !== target.digest) {
    return {
      ok: false,
      reason: 'terms',
      ...(entry.terms ? { terms: entry.terms } : {}),
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      ...(entry.group ? { group: entry.group } : {}),
      left,
    };
  }
  if (matches(entry, target.action, target.id, given)) return { ok: true };
  if (entry.previous && matches(entry.previous, target.action, target.id, given)) {
    return { ok: false, reason: entry.previous.digest === entry.digest ? 'stale' : 'changed', left };
  }
  entry.attempts += 1;
  let rotated: string | undefined;
  if (entry.attempts >= MAX_ATTEMPTS) {
    const next = fresh(target);
    rotated = next.phrase;
    consent[consentKey(target.action, target.id)] = next.entry;
  }
  home.writeConsent(consent);
  return { ok: false, reason: 'wrong', rotated, left: rotated ? MAX_ATTEMPTS : MAX_ATTEMPTS - entry.attempts };
}

export function dropPhrase(home: Home, target: PhraseTarget): void {
  const { consent, dirty } = load(home);
  const key = consentKey(target.action, target.id);
  if (!Object.hasOwn(consent, key) && !dirty) return;
  delete consent[key];
  home.writeConsent(consent);
}

/**
 * A capability's limits in words, " (at most 3/day, 2 open at once)", or ""
 * when it sets none (the defaults: no frequency of its own, 4 open).
 */
export function limitWords(l: unknown): string {
  if (!l || typeof l !== 'object') return '';
  const { max_frequency: f, max_open: o } = l as { max_frequency?: unknown; max_open?: unknown };
  const words = [...(typeof f === 'string' ? [`at most ${f}`] : []), ...(typeof o === 'number' ? [`${o} open at once`] : [])];
  return words.length ? ` (${words.join(', ')})` : '';
}

/** "tier friend, may propose meetings, calendar free_busy": the terms in words for the human. */
export function describeTerms(t: ConsentTerms): string {
  const s = t.scope;
  // Read like any grant (scope.invoke first, §5.3), so the words match what the peer will be allowed.
  const others = allowedCapabilities(s).filter((u) => !MEETING_CAPABILITIES.includes(u));
  // Per-capability limits are part of what the human approves (issue #63): named with their capability.
  const limited = (u: string) => `${u}${limitWords(s.invoke?.[u])}`;
  return [
    `tier ${t.tier}`,
    scopeAllows(s, MEETINGS_CAPABILITY) ? `may propose meetings${limitWords(s.invoke?.[MEETINGS_CAPABILITY])}` : 'no meetings',
    ...(others.length ? [`may invoke ${others.map(limited).join(' ')}`] : []),
    `calendar ${s.may_access_calendar ?? 'none'}`,
    ...(s.max_frequency ? [`up to ${s.max_frequency}`] : []),
  ].join(', ');
}

/** The local label a phrase approves, in words for the human. */
export function describeLabel(label: string | undefined): string {
  return label === undefined ? 'no local label' : `local label ${JSON.stringify(label)} (your assistant finds them by it: "tell ${label}")`;
}

/**
 * Everything a phrase approves, in words: the terms (requests) and the local
 * label (a request without one keeps the label an existing contact had).
 */
export function describeApproval(a: { terms?: ConsentTerms; label?: string }): string {
  return [...(a.terms ? [describeTerms(a.terms)] : []), ...(a.label !== undefined || !a.terms ? [describeLabel(a.label)] : [])].join(', ');
}

// --- groups (SPEC §7.8.2, issue #77) -------------------------------------------------

/** The terms of a join when nobody chose others: nothing members may invoke on us, newcomers asked about. */
export const DEFAULT_GROUP_TERMS: GroupTerms = Object.freeze({ scope: Object.freeze({ invoke: Object.freeze({}) }), newcomers: 'ask' }) as GroupTerms;

/**
 * What a join phrase is about, apart from the terms: this invite as it
 * arrived and as the human is shown it, including which members are our
 * contacts (the form says "your contact" or "not your contact" for each), so
 * a contact gone or made since is another subject and the phrase approves
 * nothing.
 */
export function inviteSubject(i: ReceivedInvite, isContact: (peer: string) => boolean): string {
  const inv = i.invite;
  const contacts = inv.state.members.map((m) => m.id).filter(isContact).sort();
  return sha256('rdv1/group-invite-consent', {
    id: inv.id,
    from: inv.from,
    group: inv.group,
    state: docHash(inv.state),
    greeting: inv.greeting,
    expires: inv.expires,
    received: i.received,
    contacts,
  });
}

/** The digest a join phrase approves: the invite (`subject`, inviteSubject) and the group scope and newcomer policy shown with it. */
export function joinTermsDigest(subject: string, terms: GroupTerms): string {
  return sha256('rdv1/group-join-terms', { subject, scope: terms.scope, newcomers: terms.newcomers });
}

export function joinTarget(i: ReceivedInvite, isContact: (peer: string) => boolean, terms: GroupTerms = DEFAULT_GROUP_TERMS): PhraseTarget {
  const subject = inviteSubject(i, isContact);
  return { action: 'group-join', id: i.invite.id, subject, digest: joinTermsDigest(subject, terms), group: terms };
}

/** Consent key id of a newcomer approval: the group and the member (both strict shapes, so the key is unambiguous). */
export const newcomerKey = (group: string, member: string): string => `${group}/${member}`;

/**
 * The digest a newcomer phrase (or `rdv group approve --code`) approves:
 * this member, with this card and admin-written name, in this group, as
 * added at that epoch. A member removed and added again (another card, name
 * or epoch) is another approval.
 */
export function newcomerDigest(r: GroupRecord, member: string): string {
  const m = memberOf(r.state, member);
  const n = Object.hasOwn(r.newcomers, member) ? r.newcomers[member] : undefined;
  return sha256('rdv1/group-newcomer-consent', { group: r.group, member, card: m?.card ?? null, name: m?.name ?? null, epoch: n?.epoch ?? null });
}

export function newcomerTarget(r: GroupRecord, member: string): PhraseTarget {
  return { action: 'group-newcomer', id: newcomerKey(r.group, member), digest: newcomerDigest(r, member) };
}

/** Every group decision waiting for the human: each pending invite (default terms; a model's other terms get their own phrase) and each newcomer. */
export function groupPhraseTargets(invites: ReceivedInvite[], records: GroupRecord[], isContact: (peer: string) => boolean): PhraseTarget[] {
  return [
    ...invites.map((i) => joinTarget(i, isContact)),
    ...records.filter((r) => r.status === 'active').flatMap((r) => Object.keys(r.newcomers).map((m) => newcomerTarget(r, m))),
  ];
}

/** "members may invoke on you: request/v1 (at most 5/day); newcomers: ask": a join's terms in words for the human. */
export function describeGroupTerms(t: GroupTerms): string {
  const caps = Object.keys(t.scope.invoke ?? {}).sort();
  const invoke = caps.length ? `members may invoke on you: ${caps.map((u) => `${u}${limitWords(t.scope.invoke?.[u])}`).join(', ')}` : 'members may invoke nothing on you';
  const rate = t.scope.max_frequency ? `, at most ${t.scope.max_frequency} in all` : '';
  const newcomers =
    t.newcomers === 'trust-admin'
      ? "newcomers the admin adds get your group messages at once (trust-admin)"
      : 'you are asked before each newcomer who is not your contact gets anything from you (ask)';
  return `${invoke}${rate}; ${newcomers}`;
}

/**
 * An invite the model asks to send (review of #80): inviting is the admin's
 * human's decision, since the invitee then learns the group's members and,
 * once it joins, gets their cards and terms. What the human approves: the
 * group, the contact (its ID, so its fingerprint, and our label for it), and
 * the name and greeting the invite carries.
 */
export interface InviteAsk {
  group: string;
  group_name: string;
  peer: string;
  label: string | null;
  name: string | null;
  greeting: string | null;
}

const INVITE_ASK = 'group-invite/v1\0';

export function inviteAskTarget(a: InviteAsk): PhraseTarget {
  const subject = INVITE_ASK + canonicalize(a);
  return { action: 'group-invite', id: newcomerKey(a.group, a.peer), subject, digest: sha256('rdv1/group-invite-ask', { subject }) };
}

/** The ask a stored invite phrase was issued for, from its subject. */
export function inviteAskOf(t: Pick<PhraseTarget, 'subject'>): InviteAsk | undefined {
  if (!t.subject?.startsWith(INVITE_ASK)) return undefined;
  try {
    return JSON.parse(t.subject.slice(INVITE_ASK.length)) as InviteAsk;
  } catch {
    return undefined;
  }
}

/** Open invite asks (issued only when the model asks): kept by a re-sync until used. */
export function inviteAsks(home: Home): PhraseTarget[] {
  return Object.values(load(home).consent).flatMap((e) => {
    const a = e.action === 'group-invite' ? inviteAskOf(e) : undefined;
    return a ? [inviteAskTarget(a)] : [];
  });
}

/** An invite ask in words, for the human. */
export function describeInviteAsk(a: InviteAsk, fingerprintOf: (id: string) => string): string {
  // Everything but the IDs was typed by someone (the model, for name and greeting): quoted as data, never as prose.
  const q = (v: string) => JSON.stringify(v);
  return (
    `invite your contact ${fingerprintOf(a.peer)}${a.label !== null ? ` (${q(a.label)})` : ''} to your group ${q(a.group_name)} (${a.group})` +
    `${a.name !== null ? `, shown to the members as ${q(a.name)}` : ''}${a.greeting !== null ? `, with the greeting ${q(a.greeting)}` : ''}. ` +
    'They see who is in the group, and if they join, every member\'s card and group terms'
  );
}
