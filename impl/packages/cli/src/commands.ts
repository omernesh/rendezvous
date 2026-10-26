// One function per row of the command table in PLAN.md §4.2. Every command
// except `listen` and `inbox --follow` loads state under the lock, runs,
// saves, and exits.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  type CardUpdateReport,
  type AddressCard,
  Agent,
  isDocId,
  b64decode,
  canonAgentId,
  cleanLabel,
  DEFAULT_GRANT_SCOPE,
  DEFAULT_RELAYS,
  type DiscoveryAddress,
  dtopic,
  fingerprint,
  type GrantScope,
  grantScope,
  GROUPS_EXTENSION,
  isAgentId,
  isCapabilityUri,
  MEETING_CAPABILITIES,
  MEETINGS_CAPABILITY,
  MAX_ADDRESSES,
  NoRelayAcceptedError,
  type MirrorOptions,
  type MirrorRelayResult,
  type MirrorReport,
  normalizeAddresses,
  parseAddress,
  type Payload,
  type RelayStatus,
  type Tier,
  TIERS as CORE_TIERS,
  topicForHint,
  parseTimestamp,
  verifyCard,
} from '@rendezvous/core';
import { cancel, cancelMeeting, confirmMeeting, REQUEST_URI, describeSlot, meetingSnapshot, NegotiationError, type NegotiationTask, parseInstant, propose, type Step } from '@rendezvous/a2a';
import {
  autoApproveStatus,
  autoApproveTarget,
  autoApproveWarning,
  autoApprovedCounts,
  parseUntil,
  scopeDigest,
  setAutoApprove,
  subjectOf,
  sweepAutoApprove,
  turnOffAutoApprove,
} from './autoapprove.js';
import {
  checkOwnerSecret,
  clearOwnerSecret,
  hasOwnerSecret,
  NO_OWNER_SECRET_NOTE,
  OWNER_SECRET_MIN,
  ownerSecretInfo,
  ownerSecretLock,
  readTerminalSecret,
  RESET_COOLDOWN_MS,
  storeOwnerSecret,
  terminalAvailable,
  weakOwnerSecret,
} from './ownersecret.js';
import { candidateDigest, describeApproval, describeRelaysAsk, dropPhrase, inboundSubject, relaysAsk, reissueForDisplay, requestSubject, type ShownPhrase } from './consent.js';
import { type AuditEntry, CliError, type Config, type ConfigAddress, type RelayFailure, RelayPublishError, type ConsentAction, consentKey, Home, type InboxEntry, parseJsonLines, type PendingRelease } from './home.js';
import {
  answerPeer,
  approveHeldRequest,
  approveRelease,
  approveStart,
  cancelPeer,
  declineStart,
  describeDraft,
  describeHeldRequest,
  discardHeldRequest,
  gateCode,
  groupTaskKey,
  groupViewOf,
  heldRequest,
  heldRequestDigest,
  heldRequestView,
  holdRequest,
  hostCardCapabilities,
  hostRegistry,
  releaseView,
  requestPeer,
  startView,
  submitDraft,
  taskEventText,
  taskEventView,
  taskListText,
  taskListView,
  taskPhraseTargets,
  type TaskRun,
} from './tasks.js';

import { type Attachment, attachFiles, declineTransfer, describeFile, fetchIncoming, fileSummaries, outgoingView, prepareFile, transferEventText, transferView } from './files.js';
import { cardSyncText } from './cardupdate.js';
import { groupTaskEventText, groupTaskEventView } from './grouptasks.js';
import { listen } from './listen.js';
import { checkRelayUrl, MAX_MIRROR_RELAYS, MAX_RELAYS, mirrorRelaysOf, relaySets, relayTransport } from './transport.js';
import {
  buildCtx,
  carryOut,
  DEFAULT_LISTEN_WINDOW,
  dinnerText,
  dinnerView,
  meetingCode,
  agreedDigest,
  meetingDigest,
  meetingScope,
  type NegotiateOptions,
  taskText,
  taskView,
  validateNegotiateOptions,
} from './negotiate.js';
import {
  candidateText,
  candidateView,
  cardText,
  clean,
  contactText,
  contactView,
  inboxText,
  type Output,
  overflowText,
  overflowView,
  requestText,
  requestView,
} from './output.js';

export const TIERS: Tier[] = [...CORE_TIERS];

export interface Ctx {
  home: Home;
  out: Output;
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** The owner's terminal, for the commands only a human may run (default: this process's, if it is one). */
  tty?: Tty;
}

/** An interactive terminal: the warning goes to it, and the owner's answer comes from it. */
export interface Tty {
  interactive: boolean;
  say(text: string): void;
  ask(question: string): Promise<string>;
  /** A secret (the owner passphrase): from the controlling terminal itself, not stdin, never echoed (issue #47). */
  secret(question: string): Promise<string>;
}

/** This process's terminal: interactive only when both stdin and stderr are a TTY and the terminal device opens. */
export function processTty(): Tty {
  return {
    // And a terminal device to read the owner passphrase from (/dev/tty, CONIN$): without one nothing human-only runs.
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true && terminalAvailable(),
    say: (text) => void process.stderr.write(`${clean(text, true)}\n`),
    secret: (question) => readTerminalSecret(question, (t) => void process.stderr.write(t)),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);

function tierOf(v: unknown): Tier | undefined {
  const t = str(v);
  if (t === undefined) return undefined;
  if (!TIERS.includes(t as Tier)) throw new CliError(`unknown tier "${t}" (one of: ${TIERS.join(', ')})`, 2);
  return t as Tier;
}

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CliError(`cannot read ${what} ${path}: ${(err as Error).message}`);
  }
}

/**
 * Load the agent under the lock, run `fn`, save (unless `save: false`), close.
 * State is also saved right before each envelope leaves (issue #4), so a crash
 * after a send can't reuse its `seq`.
 */
export async function withAgent<T>(
  home: Home,
  fn: (agent: Agent, config: Config) => Promise<T>,
  opts: { save?: boolean } = {},
): Promise<T> {
  home.requireInit();
  return home.locked(async () => {
    const config = home.readConfig();
    const sets = relaySets(config);
    const agent = Agent.fromJSON(home.readAgentState(), (key) => relayTransport(key, sets.relays, home, sets.mirror));
    agent.on('error', () => {}); // never started, but don't let a stray error crash us
    agent.beforeSend = (a) => home.writeAgentState(a.toJSON());
    try {
      const result = await fn(agent, config);
      if (opts.save !== false) {
        home.writeAgentState(agent.toJSON());
        // A revoke, block or new grant ends a contact's auto-approve: say so in the audit log now (issue #25).
        sweepAutoApprove(home, subjectOf(agent));
      }
      return result;
    } finally {
      agent.close();
    }
  });
}

// ---------------------------------------------------------------------------

export interface InitOptions {
  profile: string;
  /** None: DEFAULT_RELAYS (the public set, NOTES 69). */
  relays?: string[];
  emails?: string[];
  phones?: string[];
  publicPointer?: boolean;
  force?: boolean;
  /** The card's `capabilities` (default: what this host routes, hostCardCapabilities). */
  capabilities?: string[];
}

/** `rdv init` without the output: validate, generate key and card, write state. Shared with the MCP server. */
export async function initHome(home: Home, opts: InitOptions): Promise<{ id: string; fingerprint: string; config: Config }> {
  const { profile } = opts;
  // Copied, so the frozen default never ends up shared with config or card.
  const relays = opts.relays?.length ? [...new Set(opts.relays)] : [...DEFAULT_RELAYS];
  for (const r of relays) if (!/^wss?:\/\/\S+$/.test(r)) throw new CliError(`not a ws:// or wss:// relay URL: ${r}`, 2);
  let addresses: DiscoveryAddress[];
  try {
    // Canonical, repeats dropped, at most MAX_ADDRESSES (as `rdv address add`).
    addresses = normalizeAddresses([
      ...(opts.emails ?? []).map((value) => ({ type: 'email' as const, value })),
      ...(opts.phones ?? []).map((value) => ({ type: 'phone' as const, value })),
    ]);
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  const publicPointer = opts.publicPointer === true;
  if (home.initialized() && opts.force !== true) {
    throw new CliError(`an agent already exists at ${home.dir} (--force replaces it, and its key, for good)`);
  }
  const config: Config = {
    profile,
    relays,
    addresses,
    policy: { inbound: 'prompt', public: publicPointer },
    public_pointer: publicPointer,
  };
  const agent = await home.locked(async () => {
    home.reset();
    const a = Agent.create((key) => relayTransport(key, relays), {
      rendezvous: relays.map((relay, i) => ({ type: 'nostr' as const, relay, pref: i + 1 })),
      discovery: addresses.length ? { addresses, public_pointer: publicPointer } : undefined,
      policy: config.policy,
      // The extensions we route (meetings, tasks/v1 and its capabilities), so contacts learn them from the card (SPEC §4.3, §7.5).
      capabilities: opts.capabilities ?? hostCardCapabilities(),
    });
    home.writeConfig(config);
    home.writeAgentState(a.toJSON());
    a.close();
    return a;
  });
  return { id: agent.id, fingerprint: fingerprint(agent.id), config };
}

/** What to run after `rdv init`: publishing only when a public pointer is on, otherwise just check and listen. */
function initNextSteps(profile: string, publishable: boolean): { cmd: string; why: string }[] {
  const p = profile === 'default' ? '' : ` --profile ${profile}`;
  return [
    ...(publishable
      ? [
          { cmd: `rdv card publish${p}`, why: 'make your address findable on your relays' },
          { cmd: `rdv card publish --mirror${p}`, why: 'optional: also put it on the discovery mirrors' },
        ]
      : []),
    { cmd: `rdv whoami${p}`, why: 'check your id, addresses and relays' },
    { cmd: `rdv listen${p}`, why: 'receive contact requests and messages' },
  ];
}

export async function init({ home, out, values, tty }: Ctx): Promise<void> {
  const profile = str(values.profile) ?? process.env.RDV_PROFILE ?? 'default';
  const r = await initHome(home, {
    profile,
    relays: list(values.relay),
    emails: list(values.email),
    phones: list(values.phone),
    publicPointer: values['public-pointer'] === true,
    force: values.force === true,
  });
  const next = initNextSteps(profile, r.config.public_pointer && r.config.addresses.some((a) => !a.private));
  out.emit(
    { event: 'init', id: r.id, fingerprint: r.fingerprint, profile, home: home.dir, next_steps: next.map((n) => n.cmd) },
    `initialized profile "${profile}" at ${home.dir}\nid:          ${r.id}\nfingerprint: ${r.fingerprint}\n\nNext steps:\n${next.map((n) => `  ${n.cmd.padEnd(34)} # ${n.why}`).join('\n')}`,
  );
  // Setup is where the owner is surely at their own terminal: offer the owner passphrase now (issue #47), so it
  // is theirs before any assistant could set the first one. Only in a real interactive terminal; Enter skips.
  const term = tty ?? processTty();
  if (term.interactive && !hasOwnerSecret(home)) {
    term.say(OWNER_SECRET_INTRO);
    const first = await term.secret('Owner passphrase (not shown), or press Enter to skip and set it later with "rdv owner-secret set": ');
    if (first === '') return;
    try {
      const { autoApproveOff } = await newOwnerSecret(term, home, first, 'set');
      out.emit({ event: 'owner-secret', action: 'set', auto_approve_off: autoApproveOff }, `owner passphrase set${ownerSecretOffText(autoApproveOff)}`);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      term.say(`${err.message}; set it later with "rdv owner-secret set"`);
    }
  }
}

/**
 * Our relays' diagnostics from relays.json, in configured order: the last OK,
 * the last error (relay text, never peer text) and any cooldown. A relay we
 * never published to has nulls.
 */
export function relayHealth(home: Home, config: Config): RelayStatus[] {
  const saved = new Map(home.readRelayStatus().map((r) => [r.url, r]));
  return config.relays.map((url) => {
    const r = saved.get(url);
    return {
      url,
      last_ok: typeof r?.last_ok === 'string' ? r.last_ok : null,
      last_error: r?.last_error && typeof r.last_error === 'object' ? r.last_error : null,
      cooldown_until: typeof r?.cooldown_until === 'string' && Date.parse(r.cooldown_until) > Date.now() ? r.cooldown_until : null,
      // Set by the process that listens (rdv listen, rdv-mcp); null when up or when nothing listens.
      down_since: typeof r?.down_since === 'string' ? r.down_since : null,
    };
  });
}

function relayHealthLine(r: RelayStatus): string {
  const parts = [r.last_ok ? `last ok ${r.last_ok}` : 'not published yet'];
  if (r.last_error) parts.push(`last error ${r.last_error.at} (${r.last_error.kind}): ${clean(r.last_error.message)}`);
  if (r.cooldown_until) parts.push(`cooling down until ${r.cooldown_until}`);
  if (r.down_since) parts.push(`listening connection DOWN since ${r.down_since}`);
  return `  ${r.url}: ${parts.join('; ')}`;
}

export async function whoami({ home, out }: Ctx): Promise<void> {
  const { agent, config } = await withAgent(home, async (agent, config) => ({ agent, config }), { save: false });
  const fp = fingerprint(agent.id);
  const health = relayHealth(home, config);
  const owner = ownerSecretInfo(home);
  out.emit(
    {
      id: agent.id,
      fingerprint: fp,
      profile: config.profile,
      home: home.dir,
      addresses: addressViews(config),
      relay_health: health,
      owner_passphrase: owner,
      card: agent.card,
    },
    [
      // First, where the owner sees it: the first passphrase is trust on first use (issue #47). A fresh install has
      // none and nothing to warn about (auto-approve simply cannot be on), so that case is a calm line further down;
      // every other state (set, reset, deleted, unreadable) keeps the notice up here.
      ...(owner.note === NO_OWNER_SECRET_NOTE ? [] : [`OWNER PASSPHRASE: ${owner.note}${owner.locked_until ? ` (locked until ${owner.locked_until} after wrong answers)` : ''}`]),
      `id:          ${agent.id}`,
      `fingerprint: ${fp}`,
      `profile:     ${config.profile} (${home.dir})`,
      `addresses:   ${config.addresses.map((a) => (a.private ? `${a.value} (private)` : a.value)).join(', ') || '(none)'}`,
      `relays:      ${config.relays.join(', ')}`,
      ...health.map(relayHealthLine),
      `mirrors:     ${mirrorRelaysOf(config).length} discovery mirror(s) (rdv relays list)`,
      `public pointer: ${config.public_pointer ? 'on' : 'off'}`,
      ...(owner.note === NO_OWNER_SECRET_NOTE ? ['owner passphrase: not set (optional; only needed to turn on auto-approve, with "rdv owner-secret set" in your own terminal)'] : []),
      'card:',
      JSON.stringify(agent.card, null, 2),
    ].join('\n'),
  );
}

// --- our own addresses (the owner's setup, not a consent decision) ----------

export interface AddressView {
  type: 'email' | 'phone';
  value: string;
  /** Listed on the card, so a probe or lookup for it finds this agent. */
  public: boolean;
  /** Its discovery topic, for a public address. */
  topic?: string;
}

export function addressViews(config: Config): AddressView[] {
  return config.addresses.map((a) => ({
    type: a.type,
    value: a.value,
    public: !a.private,
    ...(a.private ? {} : { topic: dtopic(a) }),
  }));
}

export interface AddressChange {
  change: 'added' | 'removed';
  address: AddressView;
  addresses: AddressView[];
  /** The card's new `created`, when the change re-signed it (a public address). */
  card_created?: string;
  /** Topics the new card was published on (public pointer on): our addresses, plus a removed one, so the new card replaces the old there. */
  published: string[];
  /** The new card sent to contacts (`rdv/card-update`, NOTES 82); absent when no contact was due. */
  card_sent?: CardUpdateReport;
}

/**
 * Add or remove one of our addresses, under the lock. A public address is
 * listed on the card: the card is re-signed (later `created`), and with the
 * public pointer on, published on our topics and on a removed one first, so
 * a relay failure changes nothing (try again). A private address changes
 * config.json only. A running `rdv listen` / rdv-mcp re-subscribes when it
 * sees the new card (watchTopics). Contacts are never touched.
 */
export async function changeAddress(
  home: Home,
  op: { add: string; public?: boolean } | { remove: string },
): Promise<AddressChange> {
  let addr: DiscoveryAddress;
  try {
    addr = parseAddress('add' in op ? op.add : op.remove);
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  return withAgent(home, async (agent, config) => {
    const same = (a: DiscoveryAddress) => a.type === addr.type && a.value === addr.value;
    const had = config.addresses.find(same);
    let next: ConfigAddress[];
    let entry: ConfigAddress;
    if ('add' in op) {
      if (had) throw new CliError(`${addr.value} is already one of this agent's addresses (${had.private ? 'private' : 'public'}); to change that, remove it and add it again`);
      if (config.addresses.length >= MAX_ADDRESSES) throw new CliError(`this agent already has ${config.addresses.length} addresses, the most it may hold; remove one first`);
      entry = op.public === false ? { ...addr, private: true } : { ...addr };
      next = [...config.addresses, entry];
    } else {
      if (!had) throw new CliError(`${addr.value} is not one of this agent's addresses`);
      entry = had;
      next = config.addresses.filter((a) => !same(a));
    }
    const result: AddressChange = {
      change: 'add' in op ? 'added' : 'removed',
      address: addressViews({ ...config, addresses: [entry] })[0],
      addresses: addressViews({ ...config, addresses: next }),
      published: [],
    };
    if (!entry.private) {
      const { removed } = agent.setAddresses(next.filter((a) => !a.private), { publicPointer: config.public_pointer });
      result.card_created = agent.card.created;
      try {
        result.published = await agent.publishPointers(removed);
      } catch (err) {
        throw publishFailure(err);
      }
    }
    // The card, then the config, both under the lock: a listener follows the card (watchTopics).
    home.writeAgentState(agent.toJSON());
    home.writeConfig({ ...config, addresses: next });
    // Then the contacts, which keep the old card until they get this one (issue #45).
    if (!entry.private) withCardSent(result, await agent.sendCardUpdates());
    return result;
  });
}

function addressText(a: AddressView): string {
  return `${a.value}  ${a.type}  ${a.public ? `public (topic ${a.topic})` : 'private (not on the card)'}`;
}

export async function addressList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const views = addressViews(home.readConfig());
  if (views.length === 0) out.emit({ event: 'addresses', addresses: [] }, '(no addresses)');
  for (const a of views) out.emit({ event: 'address', ...a }, addressText(a));
}

function visibility(values: Ctx['values']): boolean | undefined {
  if (values.public === true && values.private === true) throw new CliError('give --public or --private, not both', 2);
  return values.private === true ? false : true;
}

export async function addressAdd({ home, out, values, positionals }: Ctx): Promise<void> {
  const r = await changeAddress(home, { add: positionals[0], public: visibility(values) });
  out.emit(
    { event: 'address-added', ...r },
    `added ${addressText(r.address)}${r.published.length ? `
published the new card on ${r.published.length} topic(s)` : ''}`,
  );
}

export async function addressRemove({ home, out, positionals }: Ctx): Promise<void> {
  const r = await changeAddress(home, { remove: positionals[0] });
  out.emit(
    { event: 'address-removed', ...r },
    `removed ${r.address.value}${r.address.public ? ': probes on it are no longer answered' : ''}` +
      (r.published.length ? `
published the new card on ${r.published.length} topic(s), replacing the old one there` : ''),
  );
}

export async function cardPublish({ home, out, values }: Ctx): Promise<void> {
  if (values.mirror === true) {
    const report = await mirrorCard(home);
    for (const r of report.relays) out.emit({ event: 'mirror-relay', ...r }, mirrorRelayText(r));
    out.emit({ event: 'mirrored', ...mirrorSummary(report) }, mirrorSummaryText(report));
    return;
  }
  const { topics, sent } = await withAgent(
    home,
    async (agent) => {
      requirePublicPointer(agent);
      const topics = await agent.publishPointers();
      // Contacts that do not hold this card yet get it too (issue #45); saved only if one did.
      const sent = await agent.sendCardUpdates();
      if (sent.sent.length || sent.failed.length) home.writeAgentState(agent.toJSON());
      return { topics, sent };
    },
    { save: false },
  );
  const sentText = cardSyncText(sent);
  out.emit(
    { event: 'published', topics, ...(sent.sent.length || sent.failed.length ? { card_sent: sent } : {}) },
    `published card on ${topics.length} topic(s) (your public addresses and your agent ID): ${topics.join(', ')}${sentText ? `
${sentText}` : ''}`,
  );
}

function requirePublicPointer(agent: Agent): void {
  const addrs = agent.card.discovery?.addresses ?? [];
  if (!agent.card.discovery?.public_pointer || !agent.card.policy.public || addrs.length === 0) {
    throw new CliError('public pointer is off for this agent (re-run "rdv init" with --public-pointer and an address)');
  }
}

/**
 * `rdv card publish --mirror` / `rdv_publish_card` with `mirror: true`
 * (NOTES 81): our card, on each address topic, to our relays and then each
 * discovery mirror, one relay at a time, paced, one try each, then read back.
 * Throws only when no relay took it.
 */
export async function mirrorCard(home: Home, opts: Partial<MirrorOptions> = {}): Promise<MirrorReport> {
  const report = await withAgent(
    home,
    async (agent, config) => {
      requirePublicPointer(agent);
      return agent.mirrorPointers({ ...opts, relays: opts.relays ?? mirrorRelaysOf(config) });
    },
    { save: false },
  );
  if (report.accepted === 0) {
    throw new RelayPublishError(
      'no relay accepted the card',
      report.relays.map((r) => ({ url: r.url, kind: r.kind ?? r.result, message: r.message ?? r.result })),
    );
  }
  return report;
}

export function mirrorSummary(r: MirrorReport) {
  return { topics: r.topics, relays: r.relays.length, accepted: r.accepted, rejected: r.rejected, timeout: r.timeout, skipped: r.skipped, served: r.served };
}

function mirrorRelayText(r: MirrorRelayResult): string {
  const served = r.served === null ? '' : r.served ? ', served back' : ', NOT served back';
  return `  ${r.url} (${r.role}): ${r.result}${r.message ? ` (${clean(r.message)})` : ''}${served}`;
}

function mirrorSummaryText(r: MirrorReport): string {
  return (
    `mirrored the card on ${r.topics.length} topic(s) to ${r.relays.length} relay(s): ${r.accepted} accepted, ` +
    `${r.rejected} rejected, ${r.timeout} timed out, ${r.skipped} skipped (cooling down); ${r.served} serve it back`
  );
}

// --- our own relays (the owner's setup) -------------------------------------

/**
 * A card publish that failed: our own words for the message (it may reach a
 * model through rdv-mcp), each relay's text kept apart (RelayPublishError).
 */
export function publishFailure(err: unknown): RelayPublishError {
  const relays: RelayFailure[] =
    err instanceof NoRelayAcceptedError
      ? [
          ...err.report.rejected.map((r) => ({ url: r.url, kind: r.kind, message: r.message })),
          ...err.report.skipped.map((url) => ({ url, kind: 'skipped', message: 'cooling down' })),
        ]
      : [];
  return new RelayPublishError('could not publish the new card on any relay, so nothing changed (try again later)', relays);
}

export type RelaySet = 'listen' | 'mirror';

export interface RelayChange {
  change: 'added' | 'removed';
  set: RelaySet;
  url: string;
  relays: string[];
  mirror_relays: string[];
  /** The card's new `created`, when the change re-signed it (a listening relay). */
  card_created?: string;
  /** Topics the new card was published on (public pointer on). */
  published: string[];
  /** Removing a listening relay: contacts that hold the old card may still send there (they keep it until they get a newer one). */
  warning?: string;
  /** The new card sent to contacts (`rdv/card-update`, NOTES 82); absent when no contact was due. */
  card_sent?: CardUpdateReport;
}

function withCardSent(result: { card_sent?: CardUpdateReport }, report: CardUpdateReport): void {
  if (report.sent.length || report.failed.length) result.card_sent = report;
}

/** Validate a relay URL for `rdv relays` / `rdv_relays` (usage error otherwise). */
export function parseRelayUrl(raw: string): string {
  const r = checkRelayUrl(raw);
  if ('problem' in r) throw new CliError(r.problem, 2);
  return r.url;
}

/**
 * Add or remove a relay, under the lock. A listening relay (the default set)
 * is on the card: the card is re-signed with the new relays, and with the
 * public pointer on, published on our topics through the new set (and the
 * dropped relay, so it serves the newer card) before anything is saved, so a
 * relay failure changes nothing. The last listening relay cannot be removed.
 * A mirror changes config.json only. A running `rdv listen` / rdv-mcp moves
 * to the new relays when it sees config.json change (watchRelays).
 */
export async function changeRelays(
  home: Home,
  op: { add: string } | { remove: string },
  set: RelaySet = 'listen',
  opts: { expectRelays?: readonly string[] } = {},
): Promise<RelayChange> {
  return withAgent(home, async (agent, config) => {
    // What the human approved (rdv_relays): the change on the relays as they were then.
    const want = opts.expectRelays;
    if (want && (want.length !== config.relays.length || want.some((r, i) => r !== config.relays[i]))) {
      throw new CliError('the relays changed since your user approved this change, so nothing changed; ask them again');
    }
    const { url, relays, mirror } = planRelayChange(config, op, set);
    const result: RelayChange = { change: 'add' in op ? 'added' : 'removed', set, url, relays, mirror_relays: mirror, published: [] };
    if (set === 'listen') {
      agent.setRelays(relays, { mirrorRelays: mirror });
      result.card_created = agent.card.created;
      try {
        result.published = await agent.publishPointers([], 'remove' in op ? [url] : []);
      } catch (err) {
        throw publishFailure(err);
      }
      if ('remove' in op) {
        result.warning =
          'contacts keep the card they hold until the new one reaches them (it was just sent), so one that is offline or runs an older version may still send to the removed relay; keep it for a while if you can';
      }
      home.writeAgentState(agent.toJSON());
    }
    // The mirror list is written once the owner changed either set, so the default no longer decides it.
    home.writeConfig({ ...config, relays, mirror_relays: mirror });
    // Contacts keep the old card until they get this one (issue #45). The envelopes go to the old relays
    // too (and, as always, to the new ones and the contact's), so a contact still on the old set gets it.
    if (set === 'listen') withCardSent(result, await agent.sendCardUpdates({ alsoRelays: config.relays }));
    return result;
  });
}

/**
 * The relay sets after a change, or a usage error (bad URL, duplicate,
 * unknown, the last listening relay, a full set). Pure: rdv_relays checks it
 * before asking the human, changeRelays again under the lock.
 */
export function planRelayChange(
  config: Pick<Config, 'relays' | 'mirror_relays'>,
  op: { add: string } | { remove: string },
  set: RelaySet,
): { url: string; relays: string[]; mirror: string[] } {
  const url = parseRelayUrl('add' in op ? op.add : op.remove);
  {
    const listenNow = [...config.relays];
    const mirrorNow = mirrorRelaysOf(config);
    let relays = listenNow;
    let mirror = mirrorNow;
    if (set === 'listen') {
      if ('add' in op) {
        if (listenNow.includes(url)) throw new CliError(`${url} is already one of this agent's relays`);
        if (listenNow.length >= MAX_RELAYS) throw new CliError(`this agent already listens on ${listenNow.length} relays, the most it may; remove one first (or add it as a discovery mirror with --mirror)`);
        relays = [...listenNow, url];
      } else {
        if (!listenNow.includes(url)) throw new CliError(`${url} is not one of this agent's relays`);
        if (listenNow.length === 1) throw new CliError('that is the last relay this agent listens on; add another first');
        relays = listenNow.filter((r) => r !== url);
      }
      mirror = mirror.filter((r) => !relays.includes(r));
    } else {
      if ('add' in op) {
        if (listenNow.includes(url)) throw new CliError(`${url} is one of this agent's listening relays; the card goes there anyway`);
        if (mirrorNow.includes(url)) throw new CliError(`${url} is already a discovery mirror`);
        if (mirrorNow.length >= MAX_MIRROR_RELAYS) throw new CliError(`this agent already has ${mirrorNow.length} discovery mirrors, the most it may`);
        mirror = [...mirrorNow, url];
      } else {
        if (!mirrorNow.includes(url)) throw new CliError(`${url} is not a discovery mirror`);
        mirror = mirrorNow.filter((r) => r !== url);
      }
    }
    return { url, relays, mirror };
  }
}

export async function relaysList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const config = home.readConfig();
  const health = relayHealth(home, config);
  const mirror = mirrorRelaysOf(config);
  // Text mode only (the human's terminal): a change the assistant asked for, with its confirm phrase.
  const ask = out.json ? undefined : await home.locked(async () => {
    const t = relaysAsk(home);
    const shown = t ? reissueForDisplay(home, [t]).get(consentKey('relays', 'listen')) : undefined;
    return t && shown ? { t, phrase: shown.phrase } : undefined;
  });
  if (ask) {
    process.stdout.write(
      `Your assistant asks to change your relays: ${describeRelaysAsk(ask.t)}.\n` +
        `  To allow it, tell your assistant this confirm phrase (relays): ${ask.phrase}\n` +
        '  Or make the change yourself with rdv relays add|remove; or ignore it.\n\n',
    );
  }
  out.emit(
    { event: 'relays', relays: config.relays, relay_health: health, mirror_relays: mirror, mirror_default: !Array.isArray(config.mirror_relays) },
    [
      `listening relays (envelopes and the card): ${config.relays.length}`,
      ...health.map(relayHealthLine),
      `discovery mirrors (the card only${Array.isArray(config.mirror_relays) ? '' : ', the default set'}): ${mirror.length}`,
      ...mirror.map((r) => `  ${r}`),
    ].join('\n'),
  );
}

function relayChangeText(r: RelayChange): string {
  const what = r.set === 'listen' ? 'listening relay' : 'discovery mirror';
  return [
    `${r.change} ${what} ${r.url}`,
    ...(r.set === 'listen' ? [`now listening on ${r.relays.join(', ')}`] : [`${r.mirror_relays.length} discovery mirror(s)`]),
    ...(r.published.length ? [`published the new card on ${r.published.length} topic(s)`] : []),
    ...(r.warning ? [`note: ${r.warning}`] : []),
  ].join('\n');
}

export async function relaysAdd({ home, out, values, positionals }: Ctx): Promise<void> {
  const r = await changeRelays(home, { add: positionals[0] }, values.mirror === true ? 'mirror' : 'listen');
  out.emit({ event: 'relay-added', ...r }, relayChangeText(r));
}

export async function relaysRemove({ home, out, values, positionals }: Ctx): Promise<void> {
  const r = await changeRelays(home, { remove: positionals[0] }, values.mirror === true ? 'mirror' : 'listen');
  out.emit({ event: 'relay-removed', ...r }, relayChangeText(r));
}

export async function lookup({ home, out, positionals }: Ctx): Promise<void> {
  const target = positionals[0];
  if (looksLikeAgentId(target)) {
    const id = agentIdArg(target);
    const card = await withAgent(home, (agent) => fetchCardById(home, agent, id), { save: false });
    if (!card) throw new CliError(notFoundById(id));
    out.emit({ event: 'card', id: card.id, fingerprint: fingerprint(card.id), card }, cardText(card));
    return;
  }
  const address = target;
  if (!topicForHint(address)) throw new CliError(`not an email address, +phone number or agent ID (rdv1:…): ${address}`, 2);
  const cards = await withAgent(
    home,
    async (agent) => {
      const found = await agent.lookup(address);
      if (found.length) {
        const cache = home.readCards();
        for (const c of found) cache[c.id] = c;
        home.writeCards(cache);
      }
      return found;
    },
    { save: false },
  );
  if (cards.length === 0) throw new CliError(`no public pointer found for ${address}`);
  for (const card of cards) out.emit({ event: 'card', id: card.id, fingerprint: fingerprint(card.id), card }, cardText(card));
}

/** Whether a target is meant as an agent ID (it may still be malformed: then `agentIdArg` says so). */
export function looksLikeAgentId(target: string): boolean {
  return String(target).trim().startsWith('rdv1:');
}

/** A pasted agent ID in canonical form, or a usage error (exit 2) that says what is wrong with it. */
export function agentIdArg(target: string): string {
  try {
    return canonAgentId(target);
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
}

/** Why a fetch by agent ID found nothing, with what a human can do about it (NOTES 83). */
export function notFoundById(id: string): string {
  return (
    `no card for ${fingerprint(id)} on your relays or the discovery mirrors. ` +
    'Their agent publishes its card under its ID only with the public pointer on, and only from a version with contact by ID: ' +
    'ask them to upgrade and republish their card ("rdv card publish"), or request contact by their email or phone instead'
  );
}

/**
 * Fetch a card by agent ID from the relays and the mirrors (Agent.lookupById)
 * and cache it, as `rdv lookup` caches cards found by address, so a later
 * request by that ID needs no fetch. Call inside `withAgent`.
 */
export async function fetchCardById(home: Home, agent: Agent, id: string): Promise<AddressCard | null> {
  const card = await agent.lookupById(id);
  if (card) {
    const cache = home.readCards();
    cache[card.id] = card;
    home.writeCards(cache);
  }
  return card;
}

/**
 * Send a contact request to an address (topic probe), an agent ID (its card
 * from a contact, a pending requester or the `rdv lookup` cache, else fetched
 * by ID from the relays, NOTES 83), or, with `allowFile` (the CLI only), a
 * card file. Call inside `withAgent`. The MCP server leaves `allowFile` off
 * so a model can't probe or read local files.
 */
export async function requestContactTo(
  home: Home,
  agent: Agent,
  target: string,
  greeting: string,
  opts: { inPerson?: boolean; allowFile?: boolean; label?: string } = {},
): Promise<{ id: string; to: string; via: 'topic' | 'card'; binding: 'in-person' | 'claimed'; label?: string; fetched?: boolean }> {
  let to: AddressCard | string;
  let via: 'topic' | 'card';
  let fetched = false;
  if (looksLikeAgentId(target)) {
    const id = agentIdArg(target);
    if (id === agent.id) throw new CliError('that agent ID is your own');
    let card: AddressCard | undefined =
      agent.book.state.contacts[id]?.card ??
      agent.pendingRequests().find((p) => p.request.from === id)?.request.card ??
      home.readCards()[id];
    if (!card) {
      card = (await fetchCardById(home, agent, id)) ?? undefined;
      if (!card) throw new CliError(notFoundById(id));
      fetched = true;
    }
    to = card;
    via = 'card';
  } else if (target.includes('@') || target.startsWith('+')) {
    if (!topicForHint(target)) throw new CliError(`not an email address or +phone number: ${target}`, 2);
    if (opts.inPerson) throw new CliError('--in-person needs a card (file or agent ID), not an address', 2);
    to = target;
    via = 'topic';
  } else {
    if (!opts.allowFile) throw new CliError('target must be an email address, a +phone number, or an agent ID (rdv1:…)', 2);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new CliError(`"${target}" is not an address, an agent ID, or a card file`, 2);
    }
    const check = verifyCard(readJsonFile(target, 'card file'));
    if (!check.ok) throw new CliError(`invalid card in ${target}: ${check.reason}`);
    to = check.card;
    via = 'card';
  }
  if (typeof to !== 'string' && to.id === agent.id) throw new CliError('that card is your own');
  const binding = opts.inPerson ? ('in-person' as const) : ('claimed' as const);
  const req = await agent.requestContact(to, greeting, { binding, label: labelOf(opts.label) });
  const label = agent.book.state.outstanding[req.id]?.label;
  return { id: req.id, to: req.to_hint, via, binding, ...(label ? { label } : {}), ...(fetched ? { fetched } : {}) };
}

export async function contactRequest({ home, out, values, positionals }: Ctx): Promise<void> {
  const res = await withAgent(home, async (agent, config) => {
    const greeting = str(values.greeting) ?? `${config.profile}'s agent would like to get in touch.`;
    return requestContactTo(home, agent, positionals[0], greeting, {
      inPerson: values['in-person'] === true,
      allowFile: true,
      label: str(values.label),
    });
  });
  out.emit(
    { event: 'request-sent', ...res },
    `request ${res.id} sent to ${res.to} (${res.via === 'topic' ? 'topic probe' : res.fetched ? 'direct to the card fetched by agent ID' : 'direct to card'}, binding ${res.binding})`,
  );
}

export async function contactPending({ home, out }: Ctx): Promise<void> {
  const { pending, candidates, contacts, overflows, evicted } = await withAgent(
    home,
    async (agent) => ({
      pending: agent.pendingRequests(),
      candidates: agent.grantCandidates(),
      contacts: agent.contacts(),
      overflows: agent.book.probeOverflows(),
      evicted: agent.book.state.pendingEvicted ?? 0,
    }),
    { save: false },
  );
  pending.sort((a, b) => a.received.localeCompare(b.received));
  candidates.sort((a, b) => a.received.localeCompare(b.received));
  if (pending.length === 0 && !out.json) out.emit({}, 'no pending requests');
  // The MCP server's confirm phrases (see packages/mcp README) are shown in text mode only: they are for the human at a terminal.
  // Only their hashes are stored (issue #12), so showing one issues a new phrase for the same request and terms, which replaces it.
  // An existing contact has a phrase only while the assistant asks to grant it more (rdv_grant agent_id, issue #1).
  const shown =
    out.json || (pending.length === 0 && candidates.length === 0 && contacts.length === 0)
      ? new Map<string, ShownPhrase>()
      : await home.locked(async () =>
          reissueForDisplay(home, [
            ...pending.map((p) => ({ action: 'request' as const, id: p.request.id, subject: requestSubject(p) })),
            ...candidates.map((c) => ({ action: 'candidate' as const, id: c.grant.id, subject: candidateDigest(c) })),
            ...contacts.map((c) => ({ action: 'inbound' as const, id: c.peer, subject: inboundSubject(c) })),
          ]),
        );
  const phraseLine = (action: ConsentAction, id: string) => {
    const s = shown.get(consentKey(action, id));
    if (!s) return '';
    // What it approves, including the local label the contact will get (NOTES 62): the model may have asked for one.
    const terms = `\n  it approves: ${clean(describeApproval(s))}`;
    return `\n  confirm phrase (tell it to your MCP client to approve): ${clean(s.phrase)}  (replaces any phrase shown before)${terms}`;
  };
  for (const p of pending) out.emit(requestView(p), requestText(p) + phraseLine('request', p.request.id));
  // Answers to our own topic probes: anyone who saw the probe could have sent one.
  for (const c of candidates) out.emit(candidateView(c), candidateText(c) + phraseLine('candidate', c.grant.id));
  // Text mode only (shown is empty with --json): the assistant asked to let an existing contact do more, e.g. propose meetings.
  for (const c of contacts.filter((x) => shown.has(consentKey('inbound', x.peer)))) {
    out.emit(
      { event: 'inbound-ask', ...contactView(c) },
      `your assistant asks to grant contact ${contactText(c)}` + phraseLine('inbound', c.peer) + '\n  your agent also tells theirs (a reverse grant), so it can use these rights',
    );
  }
  for (const o of overflows) out.emit(overflowView(o), overflowText(o));
  if (evicted > 0) {
    out.emit(
      { event: 'pending-evicted', total: evicted },
      `${evicted} inbound request(s) were dropped because the pending list was full (weakest first: probes before requests to your card). ` +
        'Someone may be flooding you; a dropped requester can simply ask again.',
    );
  }
}

/** `rdv contact confirm <grant-id>`: the owner picks which answer to a topic probe is the real peer. */
export async function contactConfirm({ home, out, positionals }: Ctx): Promise<void> {
  const contact = await withAgent(home, async (agent) => {
    if (!agent.book.state.candidates[positionals[0]]) throw new CliError(`no grant candidate ${positionals[0]} (see "rdv contact pending")`);
    try {
      return agent.confirmCandidate(positionals[0]);
    } catch (err) {
      throw new CliError((err as Error).message);
    }
  });
  out.emit({ event: 'confirmed', ...contactView(contact) }, `confirmed: ${contactText(contact)}`);
}

/** `rdv contact reject <grant-id> [--block]`: not the peer we probed for. The probe stays open for others. */
export async function contactReject({ home, out, values, positionals }: Ctx): Promise<void> {
  const block = values.block === true;
  const from = await withAgent(home, async (agent) => {
    const c = agent.rejectCandidate(positionals[0], { block });
    if (!c) throw new CliError(`no grant candidate ${positionals[0]}`);
    return c.grant.from;
  });
  out.emit({ event: 'rejected', id: positionals[0], from, blocked: block }, `rejected ${positionals[0]}${block ? ` and blocked ${from}` : ''}`);
}

/** Our human's name for a contact (`--label`, local only), checked before anything is sent. */
function labelOf(v: unknown): string | undefined {
  const l = str(v);
  if (l === undefined) return undefined;
  try {
    return cleanLabel(l);
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
}

/**
 * The scope the contact-grant command grants (§5.3): the scope file, or the
 * default (meetings), plus each `--invoke <capability-uri>`, minus the meeting
 * capabilities with `--no-meetings`. Deny by default: nothing else is allowed.
 * Checked (and both meeting fields made consistent) before anything is sent.
 */
function invokeScope(scope: GrantScope | undefined, invoke: unknown, noMeetings: boolean): GrantScope | undefined {
  const uris = Array.isArray(invoke) ? (invoke as unknown[]) : invoke === undefined ? [] : [invoke];
  try {
    if (uris.length === 0 && !noMeetings) return scope === undefined ? undefined : grantScope(scope);
    const base = grantScope(scope ?? DEFAULT_GRANT_SCOPE);
    const inv = { ...base.invoke };
    for (const u of uris) {
      if (!isCapabilityUri(u)) throw new Error(`--invoke takes a capability URI (https, at most 200 characters, no wildcard): ${clean(String(u))}`);
      if (MEETING_CAPABILITIES.includes(u)) throw new Error('meetings are granted by default; leave them out with --no-meetings');
      if (u === GROUPS_EXTENSION) throw new Error('groups are not granted: a contact invites you, and you join with rdv group join');
      inv[u] = inv[u] ?? {};
    }
    if (noMeetings) for (const u of MEETING_CAPABILITIES) delete inv[u];
    return grantScope({ ...base, invoke: inv, may_propose_meetings: Object.hasOwn(inv, MEETINGS_CAPABILITY) });
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
}

export async function contactGrant({ home, out, values, positionals }: Ctx): Promise<void> {
  const tier = tierOf(values.tier);
  const scopeFile = str(values['scope-file']);
  let scope: GrantScope | undefined;
  if (scopeFile) {
    const s = readJsonFile(scopeFile, 'scope file');
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new CliError('scope file must hold a JSON object', 2);
    scope = s as GrantScope;
  }
  scope = invokeScope(scope, values.invoke, values['no-meetings'] === true);
  const label = labelOf(values.label);
  const target = positionals[0];
  const contact = await withAgent(home, async (agent) => {
    // An agent ID: the owner grants an existing contact (one we requested) rights towards us,
    // and the agent sends the peer a reverse grant so it can use them (NOTES 60).
    if (isAgentId(target)) {
      if (!agent.book.contact(target)) throw new CliError(`no active contact ${target}`);
      if (label !== undefined) throw new CliError('--label goes with a request ID; to name an existing contact use "rdv contact label <agent-id> <label>"', 2);
      return agent.allowInbound(target, { tier, scope });
    }
    if (!agent.book.state.pending[target]) throw new CliError(`no pending request ${target}`);
    return agent.grant(target, { tier, scope, label });
  });
  out.emit({ event: 'granted', ...contactView(contact) }, `granted: ${contactText(contact)}`);
}

export async function contactDecline({ home, out, values, positionals }: Ctx): Promise<void> {
  const block = values.block === true;
  const from = await withAgent(home, async (agent) => {
    const p = agent.book.state.pending[positionals[0]];
    if (!p) throw new CliError(`no pending request ${positionals[0]}`);
    agent.decline(positionals[0], { block });
    return p.request.from;
  });
  out.emit(
    { event: 'declined', id: positionals[0], from, blocked: block },
    `declined ${positionals[0]}${block ? ` and blocked ${from}` : ''}`,
  );
}

/** Our human names a contact (local only): the name "tell John" resolves through, unlike the addresses its card claims. */
export async function contactLabel({ home, out, positionals }: Ctx): Promise<void> {
  const [peer, given] = positionals;
  const label = labelOf(given);
  const contact = await withAgent(home, async (agent) => {
    if (!agent.book.contact(peer)) throw new CliError(`no active contact ${peer}`);
    return agent.book.setLabel(peer, label!);
  });
  out.emit({ event: 'labeled', ...contactView(contact) }, `labeled: ${contactText(contact)}`);
}

export async function contactList({ home, out }: Ctx): Promise<void> {
  const { contacts, auto } = await withAgent(home, async (agent) => ({ contacts: agent.contacts(), auto: autoApproveStatus(home, subjectOf(agent)) }), { save: false });
  if (contacts.length === 0 && !out.json) out.emit({}, 'no contacts');
  for (const c of contacts) {
    const a = auto.get(c.peer);
    out.emit(
      { ...contactView(c), ...(a ? { auto_approve: { mode: 'all', until: a.until, since: a.set } } : {}) },
      contactText(c) + (a ? `  AUTO-APPROVE all until ${a.until ? clean(a.until) : 'you turn it off'}` : ''),
    );
  }
}

/** An agent ID, or a contact's local label (exactly one contact). */
export function contactFor(agent: Agent, target: string): string {
  if (isAgentId(target)) return target;
  const m = agent.book.byLabel(target);
  if (m.length === 1) return m[0].peer;
  throw new CliError(m.length ? `more than one contact is labeled ${clean(target)}: use the agent ID` : `no contact ${clean(target)} (an agent ID, or a label from "rdv contact list")`);
}

/**
 * `rdv contact auto-approve <contact> all [--until <time|duration>]` and
 * `... off` (SPEC §5.5.1, issue #25). Turning it on is the owner's alone: an
 * interactive terminal, the warning, and the owner passphrase (issue #47),
 * read from the terminal itself and never shown, so the prompt holds no answer.
 * Off needs nothing (reduce-only).
 */
export async function contactAutoApprove({ home, out, values, positionals, tty }: Ctx): Promise<void> {
  const [target, mode] = positionals;
  if (mode === 'off') {
    const peer = isAgentId(target) ? target : await withAgent(home, async (agent) => contactFor(agent, target), { save: false });
    home.requireInit();
    const was = await home.locked(async () => turnOffAutoApprove(home, peer));
    out.emit({ event: 'auto-approve', peer, auto_approve: 'off', was_on: was }, was ? `auto-approve is off for ${peer}` : `auto-approve was not on for ${peer}`);
    return;
  }
  if (mode !== 'all') throw new CliError('the second argument is "all" (turn it on) or "off"', 2);
  const term = tty ?? processTty();
  if (!term.interactive) {
    throw new CliError('turning auto-approve on needs an interactive terminal: only you may do it, in your own terminal (an assistant, a script or a pipe cannot)');
  }
  const until = str(values.until) !== undefined ? parseUntil(str(values.until)!) : null;
  home.requireInit();
  if (!hasOwnerSecret(home)) {
    throw new CliError('set your owner passphrase first, in your own terminal: rdv owner-secret set (turning auto-approve on asks for it, so an assistant cannot)');
  }
  const lock = ownerSecretLock(home);
  if (lock) throw new CliError(`too many wrong owner passphrases: try again after ${lock.toISOString()}`);
  // Look, warn and ask outside the lock: the listener keeps running while the owner reads.
  const seen = await withAgent(
    home,
    async (agent) => {
      const peer = contactFor(agent, target);
      const { contact, capabilities } = autoApproveTarget(subjectOf(agent), peer);
      return { peer, contact, capabilities, scope: scopeDigest(contact.inboundScope) };
    },
    { save: false },
  );
  term.say(autoApproveWarning(seen.contact, seen.capabilities, until));
  // The answer is never in this command's output (issue #47): the owner's own passphrase, read from the terminal, not echoed.
  const typed = await term.secret('To turn it on, type your owner passphrase (not shown), or press Enter to cancel: ');
  if (typed === '') throw new CliError('canceled: auto-approve was not turned on');
  await ownerPassphrase(home, typed, 'auto-approve was not turned on');
  const r = await withAgent(
    home,
    async (agent) => {
      const { contact } = autoApproveTarget(subjectOf(agent), seen.peer);
      if (contact.grantId !== seen.contact.grantId || scopeDigest(contact.inboundScope) !== seen.scope) {
        throw new CliError('the contact changed while you read the warning (another grant): nothing was turned on; run the command again');
      }
      return setAutoApprove(home, subjectOf(agent), seen.peer, until);
    },
    { save: false },
  );
  out.emit(
    { event: 'auto-approve', peer: seen.peer, auto_approve: 'all', action: r.action, until: r.entry.until, capabilities: r.capabilities },
    `auto-approve is ON for ${seen.peer} until ${r.entry.until ?? 'you turn it off'} (${r.action === 'extend' ? 'extended' : 'set'}; audited). Off: rdv contact auto-approve ${seen.peer} off`,
  );
}

/** Refuse unless `typed` is the owner passphrase (a miss counts toward the lockout). */
async function ownerPassphrase(home: Home, typed: string, what: string): Promise<void> {
  const r = await checkOwnerSecret(home, typed);
  if (r.ok) return;
  if (r.reason === 'none') throw new CliError(`no owner passphrase is set: ${what}`);
  if (r.reason === 'locked') throw new CliError(`wrong owner passphrase, too many times: ${what}; try again after ${r.lockedUntil}`);
  throw new CliError(`wrong owner passphrase: ${what} (${r.triesLeft} more ${r.triesLeft === 1 ? 'try' : 'tries'} before a lockout)`);
}

/**
 * `rdv owner-secret set`: the owner passphrase that turns auto-approve on
 * (issue #47). Only in an interactive terminal; read from the terminal itself,
 * never echoed, never an argument. Changing it asks for the current one.
 */
export async function ownerSecretSet({ home, out, tty }: Ctx): Promise<void> {
  home.requireInit();
  const term = tty ?? processTty();
  if (!term.interactive) {
    throw new CliError('setting the owner passphrase needs an interactive terminal: only you may do it, in your own terminal (an assistant, a script or a pipe cannot)');
  }
  const had = hasOwnerSecret(home);
  if (had) {
    const lock = ownerSecretLock(home);
    if (lock) throw new CliError(`too many wrong owner passphrases: try again after ${lock.toISOString()}`);
    const current = await term.secret('Current owner passphrase (not shown; Enter cancels): ');
    if (current === '') throw new CliError('canceled: the owner passphrase was not changed');
    await ownerPassphrase(home, current, 'the owner passphrase was not changed');
  }
  term.say(OWNER_SECRET_INTRO);
  const first = await term.secret('New owner passphrase (not shown): ');
  const action = had ? 'changed' : 'set';
  const { autoApproveOff } = await newOwnerSecret(term, home, first, action);
  out.emit({ event: 'owner-secret', action, auto_approve_off: autoApproveOff }, `owner passphrase ${action} (audited; rdv whoami shows when)${ownerSecretOffText(autoApproveOff)}`);
}

const OWNER_SECRET_INTRO = [
  '',
  'The owner passphrase is what you type to turn auto-approve on for a contact.',
  'Never give it to an assistant, and never put it in a command, a file or a chat.',
  `At least ${OWNER_SECRET_MIN} characters. Forgot it, or did not set it yourself: rdv owner-secret reset.`,
  '',
].join('\n');

/** Check `first`, ask for it again, store it (audited). */
async function newOwnerSecret(term: Tty, home: Home, first: string, action: 'set' | 'changed' | 'reset'): Promise<{ autoApproveOff: string[] }> {
  const weak = weakOwnerSecret(first);
  if (weak) throw new CliError(`the passphrase needs ${weak}: nothing was changed`, 2);
  const again = await term.secret('Type it again: ');
  if (again !== first) throw new CliError('the two did not match: nothing was changed', 2);
  return storeOwnerSecret(home, first, action);
}

/** A new passphrase ends every auto-approve set under the old one (or none): say which, and how to turn each back on. */
function ownerSecretOffText(peers: string[]): string {
  return peers.length
    ? `; auto-approve set under the old passphrase is now off for ${peers.join(', ')} (audited). To turn one back on: rdv contact auto-approve <contact> all`
    : '';
}

/**
 * `rdv owner-secret reset`: for a passphrase the owner forgot, or did not set
 * (the first one is trust on first use, so `rdv whoami` shows when it was
 * set). It needs no current passphrase, so it is refused while the passphrase
 * is locked after wrong answers, it turns auto-approve off for every contact
 * (audited), and it only clears: a new passphrase is a separate
 * `rdv owner-secret set` after RESET_COOLDOWN_MS, with a banner in `rdv whoami`
 * and `rdv_status` until then.
 */
export async function ownerSecretReset({ home, out, tty }: Ctx): Promise<void> {
  home.requireInit();
  const term = tty ?? processTty();
  if (!term.interactive) {
    throw new CliError('resetting the owner passphrase needs an interactive terminal: only you may do it, in your own terminal (an assistant, a script or a pipe cannot)');
  }
  if (!hasOwnerSecret(home)) throw new CliError('no owner passphrase is set: nothing to reset');
  const lock = ownerSecretLock(home);
  if (lock) throw new CliError(`too many wrong owner passphrases: reset is refused until ${lock.toISOString()}`);
  term.say(
    [
      '',
      'Reset the owner passphrase: every contact on auto-approve is turned off, and the',
      `passphrase is forgotten. A new one can be set ${RESET_COOLDOWN_MS / 60_000} minutes later, with rdv owner-secret set.`,
      '',
    ].join('\n'),
  );
  const ok = await term.ask('Type RESET to go on, or press Enter to cancel: ');
  if (ok.trim().toUpperCase() !== 'RESET') throw new CliError('canceled: nothing was changed');
  const ended = await home.locked(async () => {
    const peers = Object.keys(safeAutoApprove(home));
    for (const p of peers) turnOffAutoApprove(home, p);
    return peers;
  });
  await clearOwnerSecret(home);
  out.emit(
    { event: 'owner-secret', action: 'reset', auto_approve_off: ended },
    `owner passphrase reset (audited)${ended.length ? `; auto-approve turned off for ${ended.join(', ')}` : ''}; set a new one in ${RESET_COOLDOWN_MS / 60_000} minutes: rdv owner-secret set`,
  );
}

/** Contacts in autoapprove.json, or none if it can't be read. */
function safeAutoApprove(home: Home): Record<string, unknown> {
  try {
    return home.readAutoApprove();
  } catch {
    return {};
  }
}

const SINCE_UNITS: Record<string, number> ={ m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

function auditText(a: AuditEntry): string {
  const parts = [safeTs(a.ts), a.gate + (a.action ? ` ${a.action}` : ''), `by ${a.by}`, a.peer];
  if (a.capability) parts.push(a.capability);
  if (a.task) parts.push(`task ${a.task}`);
  if (a.approval) parts.push(`class ${a.approval}`);
  if (a.digest) parts.push(`digest ${a.digest.slice(0, 12)}`);
  if (a.sent?.length) parts.push(`sent ${a.sent.map((x) => `${x.sha256.slice(0, 12)} (${x.bytes} bytes)`).join(', ')}`);
  if (a.reason) parts.push(`reason ${a.reason}`);
  if (a.until !== undefined) parts.push(`until ${a.until ?? 'turned off'}`);
  if (a.capabilities?.length) parts.push(`covers ${a.capabilities.join(', ')}`);
  if (a.meeting) parts.push(`meeting ${a.meeting}`);
  if (a.via) parts.push(`via ${a.via}`);
  return parts.map((x) => clean(x)).join('  ');
}

const safeTs = (ts: unknown) => (typeof ts === 'string' ? ts : '?');

/** `rdv audit [--contact <agent-id|label>] [--since <time|duration>]`: what passed a gate without asking, every approval, and every auto-approve change. */
export async function audit({ home, out, values }: Ctx): Promise<void> {
  home.requireInit();
  const target = str(values.contact);
  const peer = target === undefined ? undefined : isAgentId(target) ? target : await withAgent(home, async (agent) => contactFor(agent, target), { save: false });
  const since = str(values.since);
  let from: number | null = null;
  if (since !== undefined) {
    const m = /^\s*(\d{1,4})\s*([mhdw])\s*$/i.exec(since);
    from = m ? Date.now() - Number(m[1]) * SINCE_UNITS[m[2].toLowerCase()] : parseTimestamp(since.trim());
    if (from === null) throw new CliError('--since takes a duration back (30m, 12h, 7d, 2w) or an RFC 3339 time with an offset', 2);
  }
  const lines = await home.locked(async () => home.readAudit());
  const shown = lines.filter((a) => (peer === undefined || a.peer === peer) && (from === null || (Date.parse(a.ts) || 0) >= from));
  if (shown.length === 0 && !out.json) out.emit({}, 'no audit entries');
  for (const a of shown) out.emit(a, auditText(a));
  if (!out.json && peer === undefined) {
    const counts = await home.locked(async () => autoApprovedCounts(home));
    if (counts.size) out.emit({}, `passed by auto-approve (as far back as the log goes): ${[...counts].map(([p, n]) => `${clean(p)} ${n}`).join(', ')}`);
  }
}

export async function contactRevoke({ home, out, positionals }: Ctx): Promise<void> {
  const peer = positionals[0];
  await withAgent(home, async (agent) => {
    if (!agent.book.contact(peer)) throw new CliError(`no active contact ${peer}`);
    await agent.revoke(peer);
  });
  out.emit({ event: 'revoked', peer }, `revoked ${peer}`);
}

/** The owner's re-sync after a fork or rollback (issue #13); the library never does this by itself. */
export async function contactResync({ home, out, positionals }: Ctx): Promise<void> {
  const peer = positionals[0];
  const refused = await withAgent(home, async (agent) => {
    const r = agent.refusedChannels().find((c) => c.peer === peer);
    if (!r) throw new CliError(`the channel with ${peer} is not refused`);
    agent.resyncChannel(peer);
    return r;
  });
  out.emit(
    { event: 'resync', peer, kind: refused.kind, seq: refused.seq, accepted: refused.accepted },
    `resync ${peer}: its next new envelope becomes the chain head`,
  );
}

export async function send({ home, out, values, positionals }: Ctx): Promise<void> {
  const raw = str(values.json) ?? str(values.payload);
  if (raw === undefined) throw new CliError('give the payload with --json \'{"type":"…"}\' (or --payload)', 2);
  let payload: Payload;
  try {
    payload = JSON.parse(raw) as Payload;
  } catch (err) {
    throw new CliError(`payload is not JSON: ${(err as Error).message}`, 2);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string') {
    throw new CliError('payload must be a JSON object with a string "type"', 2);
  }
  const peer = positionals[0];
  const env = await withAgent(home, (agent) => agent.send(peer, payload));
  out.emit({ event: 'sent', to: peer, seq: env.seq, type: payload.type }, `sent ${payload.type} to ${peer} (#${env.seq})`);
}

export async function listenCmd({ home, out, values }: Ctx): Promise<void> {
  home.requireInit();
  let negotiate: NegotiateOptions | undefined;
  if (values.negotiate === true) {
    negotiate = { ...negotiateOpts(values, DEFAULT_LISTEN_WINDOW), autoConfirm: values['auto-confirm'] === true };
    await validateNegotiateOptions(negotiate);
  } else if (values.calendar !== undefined || values.window !== undefined || values['auto-confirm'] !== undefined) {
    throw new CliError('--calendar, --window and --auto-confirm go with --negotiate', 2);
  }
  const autoGrant = tierOf(values['auto-grant']);
  const anyTier = values['auto-grant-any-tier'] === true;
  // Every inbound binding is `claimed` (anyone can claim an address): auto-granting closer than
  // `stranger` hands that tier to whoever asks first, so it needs an explicit flag (security review L7).
  if (autoGrant && autoGrant !== 'stranger' && !anyTier) {
    throw new CliError(
      `--auto-grant ${autoGrant} would give that tier to anyone who claims your address; requests are capped at "stranger" by default. ` +
        'Pass --auto-grant-any-tier if you really mean it (demos only).',
      2,
    );
  }
  if (anyTier && !autoGrant) throw new CliError('--auto-grant-any-tier goes with --auto-grant <tier>', 2);
  await listen(home, out, { autoGrant, autoGrantAnyTier: anyTier, exec: str(values.exec), negotiate });
}

export async function inbox({ home, out, values }: Ctx): Promise<void> {
  home.requireInit();
  const show = (e: InboxEntry) => out.emit(e, inboxText(e));
  const entries = home.readInbox();
  if (entries.length === 0 && !out.json && values.follow !== true) out.emit({}, 'inbox is empty');
  for (const e of entries) show(e);
  if (values.follow !== true) return;

  // Tail the file. Appends are line-sized, so no lock is needed to read.
  let offset = existsSync(home.inboxPath) ? statSync(home.inboxPath).size : 0;
  let partial = '';
  const poll = () => {
    if (!existsSync(home.inboxPath)) return;
    const size = statSync(home.inboxPath).size;
    if (size < offset) offset = 0; // truncated (re-init)
    if (size === offset) return;
    const buf = readFileSync(home.inboxPath).subarray(offset, size);
    offset = size;
    const text = partial + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    for (const e of parseJsonLines<InboxEntry>(text.slice(0, cut + 1))) show(e);
  };
  const timer = setInterval(poll, 300);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(timer);
}

// --- dinner negotiation (PLAN §5.3) ----------------------------------------

function negotiateOpts(values: Ctx['values'], defaultWindow?: string): NegotiateOptions {
  const calendar = str(values.calendar);
  if (!calendar) throw new CliError('--calendar <file.json> is required', 2);
  const window = str(values.window) ?? defaultWindow;
  if (!window) throw new CliError('--window "<when>" is required (e.g. "next week evenings")', 2);
  const m = str(values.minutes);
  const minutes = m === undefined ? undefined : Number(m);
  if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= 15 && minutes <= 720)) {
    throw new CliError('--minutes must be a whole number of minutes, 15–720', 2);
  }
  return { calendar, window, tz: str(values.tz), minutes };
}

export async function dinnerPropose({ home, out, values, positionals }: Ctx): Promise<void> {
  const peer = positionals[0];
  const opts = negotiateOpts(values);
  const place = { ...(str(values.place) ? { name: str(values.place) } : {}), ...(str(values.area) ? { area: str(values.area) } : {}) };
  const expires = str(values.expires);
  if (expires !== undefined && parseInstant(expires) === null) throw new CliError('--expires must be an RFC 3339 date-time with an offset', 2);
  const step = await withAgent(home, async (agent) => {
    const contact = agent.book.contact(peer);
    if (!contact) throw new CliError(`no active contact ${peer}`);
    const ctx = await buildCtx(opts, meetingScope(contact, 'outbound'));
    let s;
    try {
      s = propose(home.readNegotiations(), peer, ctx, { place: Object.keys(place).length ? place : undefined, expires });
    } catch (err) {
      if (err instanceof NegotiationError) throw new CliError(err.message);
      throw err;
    }
    // Task state first: a crash mid-send leaves a task that expires, not a reply to an unknown task.
    home.writeNegotiations(s.state);
    for (const o of s.outgoing) await agent.send(o.to, o.payload as unknown as Payload);
    return s;
  });
  for (const e of step.events) out.emit(dinnerView(e), dinnerText(e));
}

/** Run an owner action on the negotiations under the lock: save state, release/hold in the calendar, then send. */
async function ownerStep(home: Home, out: Ctx['out'], calendar: string | undefined, act: () => Step): Promise<void> {
  const { step, errors } = await withAgent(home, async (agent) => {
    let s;
    try {
      s = act();
    } catch (err) {
      if (err instanceof NegotiationError) throw new CliError(err.message);
      throw err;
    }
    // Task state first: a crash mid-send leaves a task that expires, not a reply to an unknown task.
    home.writeNegotiations(s.state);
    return { step: s, errors: await carryOut(agent, home, calendar, s) };
  });
  for (const e of step.events) out.emit(dinnerView(e), dinnerText(e));
  for (const message of errors) out.emit({ event: 'error', message }, `error: ${clean(message)}`);
}

/**
 * The human cancels a dinner: a pending negotiation (rdv/cancel, releases its
 * tentative hold) or an agreed meeting (meeting/cancel, issue #20: releases
 * the final hold and tells the peer, whose agent releases its own).
 */
export async function dinnerCancel({ home, out, values, positionals }: Ctx): Promise<void> {
  const taskId = positionals[0];
  const reason = str(values.reason);
  await ownerStep(home, out, str(values.calendar), () => {
    const state = home.readNegotiations();
    const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
    if (task?.state !== 'completed') return cancel(state, taskId, { now: new Date() }, reason);
    // The peer's card says whether its agent understands meeting/cancel (SPEC §7.5).
    const { contacts } = home.readAgentState().book;
    const peerCapabilities = Object.hasOwn(contacts, task.peer) ? contacts[task.peer].card?.capabilities : undefined;
    return cancelMeeting(state, taskId, { now: new Date() }, { reason, peerCapabilities });
  });
}

/**
 * The human confirms the meeting a negotiation waits on (issue #8): sends
 * meeting/accept or meeting/confirm. Only the meeting they reviewed: --hold
 * is the code `rdv dinner list` showed, checked under the lock, so a peer
 * that changed the task since (same ID, other slot or peer) gets nothing.
 */
export async function dinnerConfirm({ home, out, values, positionals }: Ctx): Promise<void> {
  const taskId = positionals[0];
  const code = (str(values.hold) ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!code) throw new CliError('--hold <code> is required: the code "rdv dinner list" shows for this dinner, so you confirm the meeting you reviewed', 2);
  await ownerStep(home, out, str(values.calendar), () => {
    const state = home.readNegotiations();
    const task = Object.hasOwn(state.tasks, taskId) ? state.tasks[taskId] : undefined;
    const snap = task ? meetingSnapshot(task) : undefined;
    if (task && snap && meetingCode(snap) !== code) {
      throw new CliError(
        `dinner ${clean(taskId)} is not the meeting you reviewed (now ${clean(describeSlot(task.hold!.slot))} with ${clean(task.peer)}). ` +
          'Nothing was confirmed: run "rdv dinner list", check it again, and confirm with its current --hold code.',
      );
    }
    return confirmMeeting(state, taskId, { now: new Date() }, snap);
  });
}

export async function dinnerList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  // The MCP server's confirm phrase for a meeting, like `contact pending`: text mode only, for the human.
  // Only a phrase issued for the meeting (or the agreement, for a cancel phrase) as it is now is re-issued
  // and shown: a stale one approves nothing.
  const { tasks, shown } = await home.locked(async () => {
    const tasks = Object.values(home.readNegotiations().tasks);
    const targets = out.json
      ? []
      : tasks.flatMap((t) => {
          const snap = meetingSnapshot(t);
          const agreed = agreedDigest(t);
          return [
            ...(snap ? [{ action: 'meeting' as const, id: t.id, digest: meetingDigest(snap) }] : []),
            ...(agreed ? [{ action: 'cancel' as const, id: t.id, digest: agreed }] : []),
          ];
        });
    return { tasks, shown: targets.length ? reissueForDisplay(home, targets) : new Map<string, { phrase: string }>() };
  });
  tasks.sort((a, b) => a.created.localeCompare(b.created));
  if (tasks.length === 0 && !out.json) out.emit({}, 'no negotiations');
  const phraseLine = (t: NegotiationTask) => {
    const s = shown.get(consentKey('meeting', t.id));
    if (s) return `\n  confirm phrase (tell it to your MCP client to confirm this dinner): ${clean(s.phrase)}  (replaces any phrase shown before)`;
    // A phrase to cancel an agreed dinner, once the MCP client asked for one (issue #20).
    const c = shown.get(consentKey('cancel', t.id));
    return c ? `\n  cancel phrase (tell it to your MCP client to cancel this agreed dinner): ${clean(c.phrase)}  (replaces any phrase shown before)` : '';
  };
  for (const t of tasks) out.emit(taskView(t), taskText(t) + phraseLine(t));
}

// --- general tasks (tasks/v1, SPEC §7.6; issues #24, #36) -------------------------

function emitRun(out: Output, run: TaskRun): void {
  if (run.group !== undefined) {
    const group = run.group;
    for (const e of run.events) out.emit(groupTaskEventView({ ...e, group }), groupTaskEventText({ ...e, group }));
  } else for (const e of run.events) out.emit(taskEventView(e), taskEventText(e));
  for (const message of run.errors) out.emit({ event: 'error', message }, `error: ${clean(message)}`);
}

function jsonArg(v: unknown, what: string): unknown {
  const raw = str(v);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`${what} is not JSON: ${(err as Error).message}`, 2);
  }
}

/** The code `rdv task list` showed, normalized: the human approves the task or result they reviewed. */
function codeArg(v: unknown, cmd: string): string {
  const code = (str(v) ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!code) throw new CliError(`--code <code> is required: the code "rdv task list" shows for this task, so you ${cmd} what you reviewed`, 2);
  return code;
}

/** `--file <sha256>=<https-url>` (repeatable): a prepared file and where the owner uploaded its copy. */
function fileArgs(v: unknown): Attachment[] {
  return list(v).map((x) => {
    const i = x.indexOf('=');
    if (i <= 0) throw new CliError(`--file takes <sha256>=<https-url> (prepare the file first with rdv file prepare): ${JSON.stringify(x)}`, 2);
    return { sha256: x.slice(0, i), uri: x.slice(i + 1) };
  });
}

/** `rdv task request <agent-id>`: ask a contact's agent for a task (default capability request/v1). */
export async function taskRequest({ home, out, values, positionals }: Ctx): Promise<void> {
  const capability = str(values.capability) ?? REQUEST_URI;
  const input = jsonArg(values.input, '--input');
  const refs = fileArgs(values.file);
  const inline = list(values.inline);
  if (refs.length || inline.length) {
    // The owner's files leave only after the human releases them, shown with name, size, hash, source and recipient
    // (issue #53): whoever runs this command (a model with a shell, too) only gets it held.
    const { held, digest } = await withAgent(home, (agent) => {
      const files = attachFiles(home, refs, inline);
      return holdRequest(home, agent, hostRegistry(), positionals[0], capability, { text: list(values.text), input, expires: str(values.expires), files: files.parts, notes: files.notes });
    });
    out.emit(
      { event: 'task-request-held', hold: held.id, peer: held.peer, fingerprint: fingerprint(held.peer), capability: held.capability, files: held.notes, release_code: gateCode(digest) },
      `held for your release, nothing sent: ${clean(describeHeldRequest(held))}\n  to send it: rdv task release ${held.id} --code ${gateCode(digest)}  (to drop it: rdv task cancel ${held.id})`,
    );
    return;
  }
  const run = await withAgent(home, (agent) =>
    requestPeer(home, agent, hostRegistry(), positionals[0], capability, { text: list(values.text), input, expires: str(values.expires) }),
  );
  emitRun(out, run);
}

/**
 * `rdv task list`: every task, and what waits for the human. Like `rdv dinner
 * list`, text mode re-issues and shows the MCP server's confirm phrases for
 * the start and release gates (only hashes are stored), so it is the human's
 * command; `--json` shows the codes only.
 */
export async function taskList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const { s, shown, views } = await withAgent(
    home,
    async (agent) => {
      const s = home.readTasks();
      // Tasks in groups (issue #79): shown with who asks in the group and what the task refers to on the board.
      const views = new Map(Object.keys(s.groups ?? {}).map((g) => [g, groupViewOf(agent, s, g)]));
      const targets = out.json ? [] : taskPhraseTargets(s, (g) => views.get(g));
      return { s, views, shown: targets.length ? reissueForDisplay(home, targets) : new Map<string, ShownPhrase>() };
    },
    { save: false },
  );
  const tasks = Object.values(s.engine.tasks).sort((a, b) => a.created.localeCompare(b.created));
  const held = Object.values(s.requests ?? {}).sort((a, b) => a.created.localeCompare(b.created));
  const inGroups = Object.entries(s.groups ?? {}).flatMap(([g, h]) => Object.values(h.engine.tasks).map((t) => ({ g, t })));
  if (tasks.length === 0 && held.length === 0 && inGroups.length === 0 && !out.json) out.emit({}, 'no tasks');
  // Our requests with the owner's files, waiting for release (issue #53).
  for (const h of held) {
    const code = gateCode(heldRequestDigest(h));
    const rel = shown.get(consentKey('task-release', h.id));
    out.emit(
      { event: 'task-request-held', hold: h.id, peer: h.peer, fingerprint: fingerprint(h.peer), capability: h.capability, files: h.notes, created: h.created, release_code: code },
      `${clean(h.id)}  request held for YOUR release (nothing sent): ${clean(describeHeldRequest(h))}\n  to send it: rdv task release ${clean(h.id)} --code ${code}  (to drop it: rdv task cancel ${clean(h.id)})` +
        (rel ? `\n  confirm phrase (tell it to your MCP client to send this request): ${clean(rel.phrase)}  (replaces any phrase shown before)` : ''),
    );
  }
  for (const t of tasks) {
    const start = shown.get(consentKey('task-start', t.id));
    const rel = shown.get(consentKey('task-release', t.id));
    const phrases =
      (start ? `\n  confirm phrase (tell it to your MCP client to let your agent start this task): ${clean(start.phrase)}  (replaces any phrase shown before)` : '') +
      (rel ? `\n  confirm phrase (tell it to your MCP client to send this result): ${clean(rel.phrase)}  (replaces any phrase shown before)` : '');
    out.emit(taskListView(t, s), taskListText(t, s) + phrases);
  }
  for (const { g, t } of inGroups.sort((a, b) => a.t.created.localeCompare(b.t.created))) {
    const v = views.get(g)!;
    const start = shown.get(consentKey('task-start', groupTaskKey(g, t.id)));
    const rel = shown.get(consentKey('task-release', groupTaskKey(g, t.id)));
    const phrases =
      (start ? `\n  confirm phrase (tell it to your MCP client to let your agent start this task): ${clean(start.phrase)}  (replaces any phrase shown before)` : '') +
      (rel ? `\n  confirm phrase (tell it to your MCP client to send this result): ${clean(rel.phrase)}  (replaces any phrase shown before)` : '');
    out.emit(taskListView(t, s, v), taskListText(t, s, v) + phrases);
  }
  const dropped = Object.entries(s.engine.dropped).filter(([, n]) => (n ?? 0) > 0);
  if (dropped.length) {
    out.emit(
      { event: 'tasks-dropped', dropped: Object.fromEntries(dropped) },
      `peer tasks refused or dropped without asking you: ${dropped.map(([k, n]) => `${k} ${n}`).join(', ')}`,
    );
  }
}

/** `--group <group-id>`: a task in that group's lane (SPEC §7.8.4), else the pairwise one. */
function groupArg(v: unknown): string | undefined {
  const g = str(v);
  if (g !== undefined && !isDocId(g)) throw new CliError('--group takes a group ID (a UUID, see "rdv group list")', 2);
  return g;
}

/** The consent key ID of a task's gates: the task, or for a task in a group, the group and the task. */
const gateId = (id: string, group: string | undefined) => (group === undefined ? id : groupTaskKey(group, id));

/** `rdv task approve <task-id> --code <code> [--group <group-id>]`: the human lets the agent act on a peer's task (start gate). */
export async function taskApprove({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const group = groupArg(values.group);
  const code = codeArg(values.code, 'approve');
  const run = await withAgent(home, async (agent) => {
    const { digest } = startView(home, id, group !== undefined ? { group, agent } : undefined);
    if (gateCode(digest) !== code) {
      throw new CliError(`task ${clean(id)} is not the task you reviewed (it changed, or the code is wrong). Nothing was started: run "rdv task list" and check it again.`);
    }
    const r = await approveStart(home, agent, hostRegistry(), id, digest, group);
    dropPhrase(home, { action: 'task-start', id: gateId(id, group) });
    return r;
  });
  emitRun(out, run);
}

/** `rdv task decline <task-id> [--group <group-id>]`: refuse a peer's task before it starts (reduce-only). */
export async function taskDecline({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const group = groupArg(values.group);
  const run = await withAgent(home, async (agent) => {
    const r = await declineStart(home, agent, hostRegistry(), id, undefined, group);
    dropPhrase(home, { action: 'task-start', id: gateId(id, group) });
    return r;
  });
  emitRun(out, run);
}

function draftOut(out: Output, id: string, r: { held?: PendingRelease; digest?: string; run: TaskRun; autoReleased?: boolean }, group?: string): void {
  emitRun(out, r.run);
  if (r.autoReleased) out.emit({ event: 'task-auto-released', task: id }, `sent without asking: you put this contact on auto-approve (audited; rdv audit)`);
  if (r.held && r.digest) {
    const flag = group !== undefined ? ` --group ${clean(group)}` : '';
    out.emit(
      { event: 'task-draft', task: id, ...(group !== undefined ? { group } : {}), draft: r.held.content, release_code: gateCode(r.digest) },
      `held for your release: ${clean(describeDraft(r.held.content))}${group !== undefined ? ' (to the group: "rdv task list" shows who gets it)' : ''}\n  to send it: rdv task release ${clean(id)}${flag} --code ${gateCode(r.digest)}`,
    );
  }
}

/** `rdv task submit <task-id> --text …`: a result for a peer's task, held for the release gate. */
export async function taskSubmit({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const text = list(values.text);
  // A structured data part beside the text, shaped by the capability (request/v1: {"rdv": "request/data", "data": {…}}); the engine checks it.
  const data = list(values.data).map((d) => {
    const v = jsonArg(d, '--data');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CliError('--data takes a JSON object', 2);
    return v as Record<string, unknown>;
  });
  const refs = fileArgs(values.file);
  const inline = list(values.inline);
  if (text.length === 0 && data.length === 0 && refs.length === 0 && inline.length === 0) {
    throw new CliError('give the result with --text "…", --data \'{…}\', --file <sha256>=<url> or --inline <path> (each repeatable)', 2);
  }
  const name = str(values.name);
  const group = groupArg(values.group);
  const r = await withAgent(home, (agent) => {
    // The owner's files leave only in a draft the human releases, shown with their name, size, hash, URL and source.
    const files = attachFiles(home, refs, inline);
    return submitDraft(home, agent, hostRegistry(), id, {
      kind: 'artifact',
      parts: [...text.map((t) => ({ kind: 'text' as const, text: t })), ...data.map((d) => ({ kind: 'data' as const, data: d })), ...files.parts],
      ...(name !== undefined ? { name } : {}),
      complete: values.complete === true,
      ...(files.notes.length ? { files: files.notes } : {}),
    }, group);
  });
  draftOut(out, id, r, group);
}

/** `rdv task ask <task-id> --text …`: ask the requester for more (input-required), held for the release gate. */
export async function taskAsk({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const text = str(values.text);
  if (text === undefined) throw new CliError('give the question with --text "…"', 2);
  const group = groupArg(values.group);
  draftOut(out, id, await withAgent(home, (agent) => submitDraft(home, agent, hostRegistry(), id, { kind: 'question', text }, group)), group);
}

/** `rdv task finish <task-id> [--failed] [--text …]`: end a started task; a message is held for the release gate. */
export async function taskFinish({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const outcome = values.failed === true ? 'failed' : 'completed';
  const text = str(values.text);
  const group = groupArg(values.group);
  draftOut(out, id, await withAgent(home, (agent) => submitDraft(home, agent, hostRegistry(), id, { kind: 'finish', outcome, ...(text !== undefined ? { text } : {}) }, group)), group);
}

/** `rdv task release <task-id> --code <code>`: the human sends the result they reviewed (release gate). */
export async function taskRelease({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const code = codeArg(values.code, 'release');
  const group = groupArg(values.group);
  const run = await withAgent(home, async (agent) => {
    if (group === undefined && heldRequest(home.readTasks(), id)) {
      // A request of ours with the owner's files (issue #53).
      const { digest } = heldRequestView(home, id);
      if (gateCode(digest) !== code) {
        throw new CliError(`request ${clean(id)} is not the one you reviewed (it changed, or the code is wrong). Nothing was sent: run "rdv task list" and check it again.`);
      }
      const r = await approveHeldRequest(home, agent, hostRegistry(), id, digest);
      dropPhrase(home, { action: 'task-release', id });
      return r;
    }
    const { digest } = releaseView(home, id, group !== undefined ? { group, agent } : undefined);
    if (gateCode(digest) !== code) {
      throw new CliError(`the result for task ${clean(id)} is not the one you reviewed (it changed, or the code is wrong). Nothing was sent: run "rdv task list" and check it again.`);
    }
    const r = await approveRelease(home, agent, hostRegistry(), id, digest, group);
    dropPhrase(home, { action: 'task-release', id: gateId(id, group) });
    return r;
  });
  emitRun(out, run);
}

/** `rdv task cancel <task-id>`: withdraw a task we requested. */
export async function taskCancel({ home, out, values, positionals }: Ctx): Promise<void> {
  const id = positionals[0];
  const dropped = await withAgent(
    home,
    async () => {
      if (!discardHeldRequest(home, id)) return false;
      dropPhrase(home, { action: 'task-release', id });
      return true;
    },
    { save: false },
  );
  if (dropped) {
    out.emit({ event: 'task-request-dropped', hold: id }, `request ${clean(id)} dropped: nothing was sent`);
    return;
  }
  emitRun(out, await withAgent(home, (agent) => cancelPeer(home, agent, hostRegistry(), id, str(values.reason))));
}

/** `rdv task input <task-id> --text …`: answer the executor's input-required on a task we requested. */
export async function taskInput({ home, out, values, positionals }: Ctx): Promise<void> {
  const input = jsonArg(values.input, '--input');
  emitRun(out, await withAgent(home, (agent) => answerPeer(home, agent, hostRegistry(), positionals[0], { text: list(values.text), ...(input !== undefined ? { input } : {}) })));
}

// --- files (SPEC §7.7, issue #26) --------------------------------------------------------

/** `rdv file prepare <path>`: encrypt one of your files for a peer (nothing is sent). */
export async function filePrepare({ home, out, values, positionals }: Ctx): Promise<void> {
  home.requireInit();
  const f = await home.locked(async () => prepareFile(home, positionals[0], { name: str(values.name), mimeType: str(values.mime), plain: values.plain === true }));
  out.emit(
    { event: 'file-prepared', ...outgoingView(f) },
    [
      `prepared ${clean(JSON.stringify(f.name ?? 'unnamed'))} (${f.size} bytes${f.enc ? ', encrypted under a fresh key' : ', NOT encrypted'}), sha256 ${f.sha256}`,
      `  upload this file anywhere the peer can fetch over https (it is ${f.enc ? 'ciphertext' : 'the plain file'}): ${clean(f.upload)}`,
      `  then attach it: rdv task submit <task-id> --file ${f.sha256.slice(0, 12)}=<https-url>  (it leaves only when you release it${f.enc ? '; the key goes only inside the message' : ''})`,
    ].join('\n'),
  );
}

/** `rdv file list`: prepared files, files peers sent for your tasks, direct-transfer requests, and the setting. */
export async function fileList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const { files, tasks, owner } = await home.locked(async () => ({ files: home.readFiles(), tasks: home.readTasks(), owner: home.readOwner(b64decode(home.readAgentState().secretKey)) }));
  const direct = owner.direct_transfer === true;
  if (owner.forged) out.emit({ event: 'warning', message: 'owner.json is not signed by this agent: ignored' }, `warning: ${clean(home.ownerPath)} is not signed by this agent (written by something else?): ignored, direct transfer is off`);
  out.emit({ event: 'direct-transfer', enabled: direct }, `direct transfer: ${direct ? 'on (requests are shown to you; this agent implements no transfer protocol, so nothing connects)' : 'off (requests are declined)'}`);
  for (const f of Object.values(files.outgoing).sort((a, b) => a.created.localeCompare(b.created))) {
    out.emit({ event: 'file-prepared', ...outgoingView(f) }, `prepared ${f.sha256}  ${clean(JSON.stringify(f.name ?? 'unnamed'))}  ${f.size} bytes  ${f.enc ? 'encrypted' : 'plain'}  from ${clean(f.source)}  upload ${clean(f.upload)}`);
  }
  for (const t of Object.values(tasks.engine.tasks).sort((a, b) => a.created.localeCompare(b.created))) {
    const got = t.role === 'executor' ? t.files : tasks.received && Object.hasOwn(tasks.received, t.id) ? tasks.received[t.id].files : undefined;
    for (const f of fileSummaries(got) ?? []) {
      out.emit(
        { event: 'file-received', task: t.id, peer: t.peer, role: t.role, state: t.state, ...f },
        `task ${clean(t.id)} (${t.role}, ${clean(t.state)}) from ${clean(t.peer)}: ${clean(describeFile(f))}  [untrusted; fetch: rdv file fetch ${clean(t.id)} --file ${f.index}]`,
      );
    }
  }
  for (const [id, r] of Object.entries(files.transfers)) {
    out.emit(
      { event: 'transfer-request', ...transferView(id, r) },
      `direct transfer ${clean(id)} with ${clean(r.peer)}: file ${clean(r.state.file)}  ${clean(r.state.phase)}${r.state.phase === 'proposed' ? `  (decline: rdv file decline-transfer ${clean(id)})` : ''}`,
    );
  }
}

/** `rdv file fetch <task-id> [--file <n|sha256>]`: fetch, verify and quarantine one file a peer sent (after the start gate). */
export async function fileFetch({ home, out, values, positionals }: Ctx): Promise<void> {
  const which = str(values.file);
  const sel = which === undefined ? {} : /^\d{1,3}$/.test(which) ? { index: Number(which) } : { sha256: which };
  const v = await fetchIncoming(home, positionals[0], sel);
  out.emit(
    { event: 'file-fetched', ...v },
    [
      `fetched and verified file #${v.index} of task ${clean(v.task)} from ${clean(v.peer)}: ${v.size} bytes, sha256 ${v.sha256}${v.encrypted ? ' (decrypted)' : ''}`,
      `  saved in quarantine (untrusted content written by the peer; do not run it): ${clean(v.path)}`,
      ...(v.name ? [`  the peer calls it (untrusted): ${clean(JSON.stringify(v.name))}${v.mimeType ? ` ${clean(v.mimeType)}` : ''}`] : []),
    ].join('\n'),
  );
}

/** `rdv file decline-transfer <transfer-id>`: say no to a peer's direct-transfer request. */
export async function fileDeclineTransfer({ home, out, positionals }: Ctx): Promise<void> {
  const r = await withAgent(home, (agent) => declineTransfer(home, agent, positionals[0]));
  for (const e of r.events) out.emit(e, transferEventText(e, clean));
  for (const message of r.errors) out.emit({ event: 'error', message }, `error: ${clean(message)}`);
}

/** `rdv file direct-transfer <on|off>`: the owner's setting (off by default). On shows requests to the owner; nothing connects on its own. */
export async function fileDirectTransfer({ home, out, positionals }: Ctx): Promise<void> {
  const v = positionals[0].toLowerCase();
  if (v !== 'on' && v !== 'off') throw new CliError('rdv file direct-transfer takes on or off', 2);
  home.requireInit();
  await home.locked(async () => {
    const key = b64decode(home.readAgentState().secretKey);
    home.writeOwner(v === 'on' ? { direct_transfer: true } : {}, key);
  });
  out.emit(
    { event: 'direct-transfer', enabled: v === 'on' },
    v === 'on'
      ? 'direct transfer on: a contact asking to receive a file directly is shown to you (it would see your network address). This agent implements no transfer protocol yet, so nothing connects; you can decline.'
      : 'direct transfer off: requests for one are declined.',
  );
}
