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
  NostrTransport,
  type Payload,
  type Tier,
  topicForHint,
  verifyCard,
} from '@rendezvous/core';
import { CliError, type Config, Home, type InboxEntry, parseJsonLines } from './home.js';
import { listen } from './listen.js';
import { contactText, contactView, inboxText, type Output, requestText, requestView } from './output.js';

export const TIERS: Tier[] = ['spouse', 'family', 'friend', 'colleague', 'business', 'stranger'];

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

/** Load the agent under the lock, run `fn`, save (unless `save: false`), close. */
async function withAgent<T>(
  home: Home,
  fn: (agent: Agent, config: Config) => Promise<T>,
  opts: { save?: boolean } = {},
): Promise<T> {
  home.requireInit();
  return home.locked(async () => {
    const config = home.readConfig();
    const agent = Agent.fromJSON(home.readAgentState(), (key) => new NostrTransport({ key, relays: config.relays }));
    agent.on('error', () => {}); // never started, but don't let a stray error crash us
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

export async function init({ home, out, values }: Ctx): Promise<void> {
  const relays = list(values.relay);
  if (relays.length === 0) throw new CliError('at least one --relay is required', 2);
  for (const r of relays) if (!/^wss?:\/\/\S+$/.test(r)) throw new CliError(`not a ws:// or wss:// relay URL: ${r}`, 2);
  const addresses: DiscoveryAddress[] = [];
  try {
    for (const e of list(values.email)) addresses.push({ type: 'email', value: canonAddress({ type: 'email', value: e }) });
    for (const p of list(values.phone)) addresses.push({ type: 'phone', value: canonAddress({ type: 'phone', value: p }) });
  } catch (err) {
    throw new CliError((err as Error).message, 2);
  }
  const publicPointer = values['public-pointer'] === true;
  const profile = str(values.profile) ?? process.env.RDV_PROFILE ?? 'default';
  if (home.initialized() && values.force !== true) {
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
    const a = Agent.create((key) => new NostrTransport({ key, relays }), {
      rendezvous: relays.map((relay, i) => ({ type: 'nostr' as const, relay, pref: i + 1 })),
      discovery: addresses.length ? { addresses, public_pointer: publicPointer } : undefined,
      policy: config.policy,
    });
    home.writeConfig(config);
    home.writeAgentState(a.toJSON());
    a.close();
    return a;
  });
  out.emit(
    { event: 'init', id: agent.id, fingerprint: fingerprint(agent.id), profile, home: home.dir },
    `initialized profile "${profile}" at ${home.dir}\nid:          ${agent.id}\nfingerprint: ${fingerprint(agent.id)}`,
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
  for (const card of cards) {
    const relays = card.rendezvous.flatMap((h) => (h.type === 'nostr' ? [h.relay] : []));
    out.emit(
      { event: 'card', id: card.id, fingerprint: fingerprint(card.id), card },
      `${card.id}  fingerprint ${fingerprint(card.id)}\n  addresses ${(card.discovery?.addresses ?? []).map((a) => a.value).join(', ')}  relays ${relays.join(', ')}`,
    );
  }
}

export async function contactRequest({ home, out, values, positionals }: Ctx): Promise<void> {
  const target = positionals[0];
  const inPerson = values['in-person'] === true;
  const res = await withAgent(home, async (agent, config) => {
    const greeting = str(values.greeting) ?? `${config.profile}'s agent would like to get in touch.`;
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
      if (inPerson) throw new CliError('--in-person needs a card (file or agent ID), not an address', 2);
      to = target;
      via = 'topic';
    } else {
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new CliError(`"${target}" is not an address, an agent ID, or a card file`, 2);
      }
      const check = verifyCard(readJsonFile(target, 'card file'));
      if (!check.ok) throw new CliError(`invalid card in ${target}: ${check.reason}`);
      to = check.card;
      via = 'card';
    }
    if (typeof to !== 'string' && to.id === agent.id) throw new CliError('that card is your own');
    const binding = inPerson ? ('in-person' as const) : ('claimed' as const);
    const req = await agent.requestContact(to, greeting, { binding });
    return { id: req.id, to: req.to_hint, via, binding };
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
  for (const p of pending) out.emit(requestView(p), requestText(p));
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
  const contact = await withAgent(home, async (agent) => {
    if (!agent.book.state.pending[positionals[0]]) throw new CliError(`no pending request ${positionals[0]}`);
    return agent.grant(positionals[0], { tier, scope });
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
  await listen(home, out, { autoGrant: tierOf(values['auto-grant']), exec: str(values.exec) });
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
