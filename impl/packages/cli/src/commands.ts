// One function per row of the command table in PLAN.md §4.2. Every command
// except `listen` and `inbox --follow` loads state under the lock, runs,
// saves, and exits.
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  type AddressCard,
  Agent,
  canonAddress,
  type DiscoveryAddress,
  dtopic,
  fingerprint,
  type GrantScope,
  isAgentId,
  type Payload,
  type Tier,
  TIERS as CORE_TIERS,
  topicForHint,
  verifyCard,
} from '@rendezvous/core';
import { awaitingHuman, cancel, confirmMeeting, NegotiationError, parseInstant, propose, type Step } from '@rendezvous/a2a';
import { CliError, type Config, Home, type InboxEntry, parseJsonLines } from './home.js';
import { listen } from './listen.js';
import { relayTransport } from './transport.js';
import {
  buildCtx,
  carryOut,
  DEFAULT_LISTEN_WINDOW,
  dinnerText,
  dinnerView,
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
    const agent = Agent.fromJSON(home.readAgentState(), (key) => relayTransport(key, config.relays));
    agent.on('error', () => {}); // never started, but don't let a stray error crash us
    agent.beforeSend = (a) => home.writeAgentState(a.toJSON());
    try {
      const result = await fn(agent, config);
      if (opts.save !== false) home.writeAgentState(agent.toJSON());
      return result;
    } finally {
      agent.close();
    }
  });
}

// ---------------------------------------------------------------------------

export interface InitOptions {
  profile: string;
  relays: string[];
  emails?: string[];
  phones?: string[];
  publicPointer?: boolean;
  force?: boolean;
}

/** `rdv init` without the output: validate, generate key and card, write state. Shared with the MCP server. */
export async function initHome(home: Home, opts: InitOptions): Promise<{ id: string; fingerprint: string; config: Config }> {
  const { relays, profile } = opts;
  if (relays.length === 0) throw new CliError('at least one --relay is required', 2);
  for (const r of relays) if (!/^wss?:\/\/\S+$/.test(r)) throw new CliError(`not a ws:// or wss:// relay URL: ${r}`, 2);
  const addresses: DiscoveryAddress[] = [];
  try {
    for (const e of opts.emails ?? []) addresses.push({ type: 'email', value: canonAddress({ type: 'email', value: e }) });
    for (const p of opts.phones ?? []) addresses.push({ type: 'phone', value: canonAddress({ type: 'phone', value: p }) });
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
    });
    home.writeConfig(config);
    home.writeAgentState(a.toJSON());
    a.close();
    return a;
  });
  return { id: agent.id, fingerprint: fingerprint(agent.id), config };
}

export async function init({ home, out, values }: Ctx): Promise<void> {
  const profile = str(values.profile) ?? process.env.RDV_PROFILE ?? 'default';
  const r = await initHome(home, {
    profile,
    relays: list(values.relay),
    emails: list(values.email),
    phones: list(values.phone),
    publicPointer: values['public-pointer'] === true,
    force: values.force === true,
  });
  out.emit(
    { event: 'init', id: r.id, fingerprint: r.fingerprint, profile, home: home.dir },
    `initialized profile "${profile}" at ${home.dir}\nid:          ${r.id}\nfingerprint: ${r.fingerprint}`,
  );
}

export async function whoami({ home, out }: Ctx): Promise<void> {
  const { agent, config } = await withAgent(home, async (agent, config) => ({ agent, config }), { save: false });
  const fp = fingerprint(agent.id);
  out.emit(
    { id: agent.id, fingerprint: fp, profile: config.profile, home: home.dir, card: agent.card },
    [
      `id:          ${agent.id}`,
      `fingerprint: ${fp}`,
      `profile:     ${config.profile} (${home.dir})`,
      `addresses:   ${config.addresses.map((a) => a.value).join(', ') || '(none)'}`,
      `relays:      ${config.relays.join(', ')}`,
      `public pointer: ${config.public_pointer ? 'on' : 'off'}`,
      'card:',
      JSON.stringify(agent.card, null, 2),
    ].join('\n'),
  );
}

export async function cardPublish({ home, out }: Ctx): Promise<void> {
  const topics = await withAgent(
    home,
    async (agent) => {
      const addrs = agent.card.discovery?.addresses ?? [];
      if (!agent.card.discovery?.public_pointer || !agent.card.policy.public || addrs.length === 0) {
        throw new CliError('public pointer is off for this agent (re-run "rdv init" with --public-pointer and an address)');
      }
      await agent.publishPointers();
      return addrs.map(dtopic);
    },
    { save: false },
  );
  out.emit({ event: 'published', topics }, `published card on ${topics.length} topic(s): ${topics.join(', ')}`);
}

export async function lookup({ home, out, positionals }: Ctx): Promise<void> {
  const address = positionals[0];
  if (!topicForHint(address)) throw new CliError(`not an email address or +phone number: ${address}`, 2);
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

/**
 * Send a contact request to an address (topic probe), an agent ID whose card
 * we know (contact, pending requester, or `rdv lookup` cache), or, with
 * `allowFile` (the CLI only), a card file. Call inside `withAgent`. The MCP
 * server leaves `allowFile` off so a model can't probe or read local files.
 */
export async function requestContactTo(
  home: Home,
  agent: Agent,
  target: string,
  greeting: string,
  opts: { inPerson?: boolean; allowFile?: boolean } = {},
): Promise<{ id: string; to: string; via: 'topic' | 'card'; binding: 'in-person' | 'claimed' }> {
  let to: AddressCard | string;
  let via: 'topic' | 'card';
  if (isAgentId(String(target))) {
    const card =
      agent.book.state.contacts[target]?.card ??
      agent.pendingRequests().find((p) => p.request.from === target)?.request.card ??
      home.readCards()[target];
    if (!card) throw new CliError(`no card known for ${target}: run "rdv lookup <address>" or pass a card file`);
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
  const req = await agent.requestContact(to, greeting, { binding });
  return { id: req.id, to: req.to_hint, via, binding };
}

export async function contactRequest({ home, out, values, positionals }: Ctx): Promise<void> {
  const res = await withAgent(home, async (agent, config) => {
    const greeting = str(values.greeting) ?? `${config.profile}'s agent would like to get in touch.`;
    return requestContactTo(home, agent, positionals[0], greeting, { inPerson: values['in-person'] === true, allowFile: true });
  });
  out.emit(
    { event: 'request-sent', ...res },
    `request ${res.id} sent to ${res.to} (${res.via === 'topic' ? 'topic probe' : 'direct to card'}, binding ${res.binding})`,
  );
}

export async function contactPending({ home, out }: Ctx): Promise<void> {
  const pending = await withAgent(home, async (agent) => agent.pendingRequests(), { save: false });
  pending.sort((a, b) => a.received.localeCompare(b.received));
  if (pending.length === 0 && !out.json) out.emit({}, 'no pending requests');
  // The MCP server's confirm phrases (see packages/mcp README) are shown in text mode only: they are for the human at a terminal.
  const consent = home.readConsent();
  const phraseLine = (id: string) => {
    const phrase = consent[id]?.phrase;
    return phrase ? `\n  confirm phrase (tell it to your MCP client to approve): ${clean(phrase)}` : '';
  };
  for (const p of pending) out.emit(requestView(p), requestText(p) + phraseLine(p.request.id));
  // Answers to our own topic probes: anyone who saw the probe could have sent one.
  const { candidates, overflows, evicted } = await withAgent(
    home,
    async (agent) => ({
      candidates: agent.grantCandidates(),
      overflows: agent.book.probeOverflows(),
      evicted: agent.book.state.pendingEvicted ?? 0,
    }),
    { save: false },
  );
  candidates.sort((a, b) => a.received.localeCompare(b.received));
  for (const c of candidates) out.emit(candidateView(c), candidateText(c) + phraseLine(c.grant.id));
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

export async function contactGrant({ home, out, values, positionals }: Ctx): Promise<void> {
  const tier = tierOf(values.tier);
  const scopeFile = str(values['scope-file']);
  let scope: GrantScope | undefined;
  if (scopeFile) {
    const s = readJsonFile(scopeFile, 'scope file');
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new CliError('scope file must hold a JSON object', 2);
    scope = s as GrantScope;
  }
  const target = positionals[0];
  const contact = await withAgent(home, async (agent) => {
    // An agent ID: the owner grants an existing contact (one we requested) rights towards us.
    if (isAgentId(target)) {
      if (!agent.book.contact(target)) throw new CliError(`no active contact ${target}`);
      return agent.allowInbound(target, { tier, scope });
    }
    if (!agent.book.state.pending[target]) throw new CliError(`no pending request ${target}`);
    return agent.grant(target, { tier, scope });
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

export async function contactList({ home, out }: Ctx): Promise<void> {
  const contacts = await withAgent(home, async (agent) => agent.contacts(), { save: false });
  if (contacts.length === 0 && !out.json) out.emit({}, 'no contacts');
  for (const c of contacts) out.emit(contactView(c), contactText(c));
}

export async function contactRevoke({ home, out, positionals }: Ctx): Promise<void> {
  const peer = positionals[0];
  await withAgent(home, async (agent) => {
    if (!agent.book.contact(peer)) throw new CliError(`no active contact ${peer}`);
    await agent.revoke(peer);
  });
  out.emit({ event: 'revoked', peer }, `revoked ${peer}`);
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

export async function dinnerCancel({ home, out, values, positionals }: Ctx): Promise<void> {
  await ownerStep(home, out, str(values.calendar), () => cancel(home.readNegotiations(), positionals[0], { now: new Date() }, str(values.reason)));
}

/** The human confirms the meeting a negotiation waits on (issue #8): sends meeting/accept or meeting/confirm. */
export async function dinnerConfirm({ home, out, values, positionals }: Ctx): Promise<void> {
  await ownerStep(home, out, str(values.calendar), () => confirmMeeting(home.readNegotiations(), positionals[0], { now: new Date() }));
}

export async function dinnerList({ home, out }: Ctx): Promise<void> {
  home.requireInit();
  const { tasks, consent } = await home.locked(async () => ({ tasks: Object.values(home.readNegotiations().tasks), consent: home.readConsent() }));
  tasks.sort((a, b) => a.created.localeCompare(b.created));
  if (tasks.length === 0 && !out.json) out.emit({}, 'no negotiations');
  // The MCP server's confirm phrase for a meeting, like `contact pending`: text mode only, for the human.
  const phraseLine = (id: string) => {
    const phrase = consent[id]?.phrase;
    return phrase ? `\n  confirm phrase (tell it to your MCP client to confirm this dinner): ${clean(phrase)}` : '';
  };
  for (const t of tasks) out.emit(taskView(t), taskText(t) + (awaitingHuman(t) ? phraseLine(t.id) : ''));
}

