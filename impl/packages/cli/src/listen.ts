// `rdv listen`: the only long-running command.
//
// It keeps one set of relay subscriptions open but does NOT hold the state
// lock while idle, so other `rdv` commands (e.g. a bot running
// `rdv contact grant` in reaction to a `request` event) can run against the
// same home. Each inbound item is handled in its own short critical section:
// take the lock, load state fresh from disk, feed the item to an Agent built
// on that state, save, release. Events are printed only after the state that
// produced them is on disk, so a reaction to an event always sees it.
//
// It is the home's one inbound consumer: it holds `listener.lock` while it
// runs (a second `rdv listen`, or an `rdv-mcp` that would consume, is
// refused or attaches), and appends what it handles to `events.jsonl`.
import { spawn } from 'node:child_process';
import { expire, isA2APayload, isTerminal, receive, type Step } from '@rendezvous/a2a';
import {
  Agent,
  type AgentKey,
  defaultTier,
  dtopic,
  type Envelope,
  openEnvelope,
  type Tier,
  TIERS,
  type Transport,
  verifyContactRequest,
} from '@rendezvous/core';
import { appendEvents } from './events.js';
import { LockTimeoutError, tryLongLock } from './fsutil.js';
import { CliError, type Home, type InboxEntry } from './home.js';
import { buildCtx, carryOut, dinnerText, dinnerView, inboundMeetingScope, type NegotiateOptions } from './negotiate.js';
import {
  candidateText,
  candidateView,
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
import { relayTransport } from './transport.js';

/** How often `listen --negotiate` checks pending negotiations for expiry. */
export const SWEEP_MS = 30_000;

/** Passes sends through to the real transport; inbound items are fed in by hand. */
export class FeedTransport implements Transport {
  private envHandler?: (e: unknown) => void;
  private topicHandler?: (doc: unknown, topic: string) => void;

  constructor(private readonly real: Transport) {}

  sendEnvelope(e: Envelope, relays?: string[]) {
    return this.real.sendEnvelope(e, relays);
  }
  publishTopic(topic: string, doc: object, extra?: string[]) {
    return this.real.publishTopic(topic, doc, extra);
  }
  fetchTopic(topic: string, maxWaitMs?: number) {
    return this.real.fetchTopic(topic, maxWaitMs);
  }
  onEnvelopes(_me: string, handler: (e: unknown) => void) {
    this.envHandler = handler;
    return () => (this.envHandler = undefined);
  }
  onTopics(_topics: string[], handler: (doc: unknown, topic: string) => void) {
    this.topicHandler = handler;
    return () => (this.topicHandler = undefined);
  }
  feedEnvelope(raw: unknown) {
    this.envHandler?.(raw);
  }
  feedTopic(doc: unknown, topic: string) {
    this.topicHandler?.(doc, topic);
  }
  close() {}
}

/**
 * Items that can't change state, judged without state: envelopes that don't
 * open for us (bad signature, wrong recipient, expired) and topic docs that
 * aren't valid contact requests from someone else. Callers drop them before
 * taking the lock, so junk from strangers costs no lock and no state write
 * (security review M1).
 */
export function isJunk(key: AgentKey, item: { envelope: unknown } | { doc: unknown }): boolean {
  if ('envelope' in item) return !openEnvelope(key, item.envelope).ok;
  return !verifyContactRequest(item.doc) || item.doc.from === key.id;
}

export interface Emitted {
  obj: { event: string } & Record<string, unknown>;
  human?: string;
}

export interface ListenOptions {
  autoGrant?: Tier;
  /** Without it, auto-grant never goes above the binding's default tier (`stranger` for `claimed`). */
  autoGrantAnyTier?: boolean;
  exec?: string;
  /** Run the dinner negotiation engine on inbound a2a/* payloads (PLAN §5.3). */
  negotiate?: NegotiateOptions;
}

/**
 * Handle one inbound item in its own critical section: take the lock, load
 * state fresh, feed the item to an Agent built on that state, save, release.
 * Returns the events it produced; the caller prints them after the save.
 *
 * Crash safety (issue #4): before any envelope leaves, the inbox entries so
 * far and then the agent state are saved, and negotiation state is saved
 * before its replies go out. A crash therefore never reuses a `seq`; at worst
 * an inbox entry is delivered twice.
 *
 * The MCP server runs the same loop in-process.
 */
export async function handleInbound(
  home: Home,
  real: Transport,
  feed: (t: FeedTransport) => void,
  opts: Pick<ListenOptions, 'autoGrant' | 'autoGrantAnyTier' | 'negotiate'>,
  sweep = false,
  lock: { timeoutMs: number; attempts: number } = INBOUND_LOCK,
): Promise<Emitted[]> {
  const events: Emitted[] = [];
  // A busy lock is not a reason to lose the item (security review L8): keep
  // trying past the 10-minute stale-lock threshold, then give up loudly.
  for (let attempt = 1; ; attempt++) {
    try {
      await handleLocked(home, real, feed, opts, sweep, events, lock.timeoutMs);
      return events;
    } catch (err) {
      if (!(err instanceof LockTimeoutError) || attempt >= lock.attempts) throw err;
    }
  }
}

/** Per attempt 60 s, 12 attempts: longer than acquireLock's 10-minute stale threshold. */
export const INBOUND_LOCK = { timeoutMs: 60_000, attempts: 12 };

async function handleLocked(
  home: Home,
  real: Transport,
  feed: (t: FeedTransport) => void,
  opts: Pick<ListenOptions, 'autoGrant' | 'autoGrantAnyTier' | 'negotiate'>,
  sweep: boolean,
  events: Emitted[],
  timeoutMs: number,
): Promise<void> {
  await home.locked(
    async () => {
      const t = new FeedTransport(real);
      const agent = Agent.fromJSON(home.readAgentState(), () => t);
      const loaded = JSON.stringify(agent.toJSON());
      const grants: Promise<unknown>[] = [];
      const inbox: InboxEntry[] = [];
      let flushed = 0;
      // Inbox first, then state: a crash in between re-delivers rather than loses.
      const save = () => {
        for (; flushed < inbox.length; flushed++) home.appendInbox(inbox[flushed]);
        home.writeAgentState(agent.toJSON());
      };
      agent.beforeSend = save;
      agent.on('request', (p) => {
        events.push({ obj: { event: 'request', ...requestView(p) }, human: `request ${requestText(p)}` });
        // Demo only: a human should normally decide (`rdv contact grant`).
        if (opts.autoGrant) {
          const cap = defaultTier(p.binding);
          const tier = opts.autoGrantAnyTier || TIERS.indexOf(opts.autoGrant) >= TIERS.indexOf(cap) ? opts.autoGrant : cap;
          grants.push(agent.grant(p.request.id, { tier }));
        }
      });
      agent.on('candidate', (c) => events.push({ obj: candidateView(c), human: `candidate ${candidateText(c)}` }));
      agent.on('pending-evicted', (total) =>
        events.push({
          obj: { event: 'pending-evicted', total },
          human: `pending requests full: dropped one (${total} so far). Someone may be flooding you; a dropped requester's retry is accepted.`,
        }),
      );
      agent.on('probe-overflow', (o) => events.push({ obj: overflowView(o), human: overflowText(o) }));
      agent.on('contact', (c) => events.push({ obj: { event: 'contact', ...contactView(c) }, human: `contact ${contactText(c)}` }));
      agent.on('message', (from, payload, env) => {
        const entry: InboxEntry = { ts: new Date().toISOString(), from, seq: env.seq, payload };
        inbox.push(entry);
        events.push({ obj: { event: 'message', ...entry }, human: `message ${inboxText(entry)}` });
      });
      agent.on('revoked', (peer) => events.push({ obj: { event: 'revoked', peer }, human: `revoked by ${clean(peer)}` }));
      agent.on('dropped', (reason, detail) => {
        const quiet = reason.includes('duplicate'); // relay replays on every restart
        events.push({
          obj: { event: 'dropped', reason, detail },
          human: quiet ? undefined : `dropped: ${clean(reason)}${detail === undefined ? '' : ` (${clean(JSON.stringify(detail))})`}`,
        });
      });
      agent.on('error', (err) => events.push({ obj: { event: 'error', message: err.message }, human: `error: ${clean(err.message)}` }));
      agent.start();
      feed(t);
      await agent.idle();
      for (const r of await Promise.allSettled(grants)) {
        if (r.status === 'rejected') {
          const message = `auto-grant failed: ${(r.reason as Error)?.message ?? r.reason}`;
          events.push({ obj: { event: 'error', message }, human: `error: ${clean(message)}` });
        }
      }
      await agent.idle();
      if (opts.negotiate) await negotiateInbound(home, opts.negotiate, agent, inbox, sweep, events);
      await agent.idle();
      agent.stop();
      // Replays and refused items usually change nothing: skip the rewrite then.
      if (flushed < inbox.length || JSON.stringify(agent.toJSON()) !== loaded) save();
      // The shared log, after the state is on disk (issue #9).
      await appendEvents(
        home,
        events.map((e) => e.obj),
        { negotiated: opts.negotiate !== undefined },
      );
    },
    { timeoutMs },
  );
}

// Inside the lock: feed this item's a2a payloads to the engine, save its state, then hold and send.
async function negotiateInbound(
  home: Home,
  n: NegotiateOptions,
  agent: Agent,
  inbox: InboxEntry[],
  sweep: boolean,
  events: Emitted[],
): Promise<void> {
  const a2a = inbox.filter((e) => isA2APayload(e.payload));
  if (a2a.length === 0 && !sweep) return;
  let state = home.readNegotiations();
  const before = JSON.stringify(state);
  const steps: Step[] = [];
  for (const e of a2a) {
    const ctx = await buildCtx(n, inboundMeetingScope(agent.book.contact(e.from), state, e.payload));
    const step = receive(state, e.from, e.payload, ctx);
    steps.push(step);
    state = step.state;
  }
  if (sweep) {
    const step = expire(state, { now: new Date() });
    steps.push(step);
    state = step.state;
  }
  if (JSON.stringify(state) !== before) home.writeNegotiations(state);
  for (const step of steps) {
    const errors = await carryOut(agent, home, n.calendar, step);
    for (const ev of step.events) events.push({ obj: dinnerView(ev), human: dinnerText(ev) });
    for (const message of errors) events.push({ obj: { event: 'error', message }, human: `error: ${clean(message)}` });
  }
}

/** Any pending negotiation that can expire? Unreadable state counts, so the sweep reports it. */
export function hasExpiring(home: Home): boolean {
  try {
    return Object.values(home.readNegotiations().tasks).some((t) => !isTerminal(t.state) && t.expires);
  } catch {
    return true;
  }
}

/**
 * Take the home's `listener.lock` for this process's lifetime, or refuse:
 * two consumers on one home would split inbound events between them (issue #9).
 */
export function claimListener(home: Home): () => void {
  home.ensureDir();
  const lock = tryLongLock(home.listenerLockPath, 'rdv listen');
  if (lock.release) return lock.release;
  throw new CliError(
    `another listener already receives for this home (${lock.owner}). Only one process per home may consume inbound ` +
      `events; stop it first, or follow its events another way (rdv-mcp attaches to a running listener and reads ${home.eventsPath}).`,
  );
}

export async function listen(home: Home, out: Output, opts: ListenOptions): Promise<void> {
  const releaseListener = claimListener(home);
  const config = home.readConfig();
  const boot = Agent.fromJSON(home.readAgentState(), (key) => relayTransport(key, config.relays));
  const real = boot.transport;
  const topics = (boot.card.discovery?.addresses ?? []).map(dtopic);

  const print = async (e: Emitted) => {
    out.emit(e.obj, e.human);
    if (opts.exec) await runExec(opts.exec, home, e.obj);
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (feed: (t: FeedTransport) => void, sweep = false) => {
    chain = chain
      .then(async () => {
        for (const e of await handleInbound(home, real, feed, opts, sweep)) await print(e);
      })
      .catch((err: Error) => out.emit({ event: 'error', message: err.message }, `error: ${clean(err.message)}`));
  };

  const unsubs = [
    real.onEnvelopes(boot.id, (raw) => {
      if (!isJunk(boot.key, { envelope: raw })) enqueue((t) => t.feedEnvelope(raw));
    }),
    real.onTopics(topics, (doc, topic) => {
      if (!isJunk(boot.key, { doc })) enqueue((t) => t.feedTopic(doc, topic));
    }),
  ];
  out.emit(
    { event: 'ready', id: boot.id, relays: config.relays, topics },
    `listening as ${boot.id} on ${config.relays.join(', ')} (Ctrl-C to stop)`,
  );

  // Relay sockets come and go (the transport re-subscribes); this timer keeps
  // the process alive in between instead of exiting with nothing left to do.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const sweeper = opts.negotiate
    ? setInterval(() => {
        if (hasExpiring(home)) enqueue(() => {}, true);
      }, SWEEP_MS)
    : undefined;
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(keepAlive);
  if (sweeper) clearInterval(sweeper);
  for (const u of unsubs) u();
  await chain;
  real.close();
  releaseListener();
}

/** Pipe one event (a JSON line on stdin) to the user's script; its stdout goes to our stderr. */
function runExec(command: string, home: Home, event: { event: string }): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', process.stderr, 'inherit'],
      env: { ...process.env, RDV_HOME: home.dir, RDV_EVENT: event.event },
    });
    child.on('error', (err) => {
      process.stderr.write(`rdv: --exec failed: ${err.message}\n`);
      resolve();
    });
    child.on('close', () => resolve());
    child.stdin?.on('error', () => {}); // script may exit without reading
    child.stdin?.end(JSON.stringify(event) + '\n');
  });
}
