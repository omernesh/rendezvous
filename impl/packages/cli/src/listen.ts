// `rdv listen`: the only long-running command.
//
// It keeps one set of relay subscriptions open but does NOT hold the state
// lock while idle, so other `rdv` commands (e.g. a bot running
// `rdv contact grant` in reaction to a `request` event) can run against the
// same home. Each inbound item is handled in its own short critical section:
// take the lock, load state fresh from disk, feed the item to an Agent built
// on that state, save, release. Events are printed only after the state that
// produced them is on disk, so a reaction to an event always sees it.
import { spawn } from 'node:child_process';
import { expire, isA2APayload, isTerminal, receive, type Step } from '@rendezvous/a2a';
import { Agent, dtopic, type Envelope, type Tier, type Transport } from '@rendezvous/core';
import type { Home, InboxEntry } from './home.js';
import { buildCtx, carryOut, dinnerText, dinnerView, inboundMeetingScope, type NegotiateOptions } from './negotiate.js';
import {
  candidateText,
  candidateView,
  clean,
  contactText,
  contactView,
  inboxText,
  type Output,
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

export interface Emitted {
  obj: { event: string } & Record<string, unknown>;
  human?: string;
}

export interface ListenOptions {
  autoGrant?: Tier;
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
  opts: Pick<ListenOptions, 'autoGrant' | 'negotiate'>,
  sweep = false,
): Promise<Emitted[]> {
  const events: Emitted[] = [];
  await home.locked(
    async () => {
      const t = new FeedTransport(real);
      const agent = Agent.fromJSON(home.readAgentState(), () => t);
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
        if (opts.autoGrant) grants.push(agent.grant(p.request.id, { tier: opts.autoGrant }));
      });
      agent.on('candidate', (c) => events.push({ obj: candidateView(c), human: `candidate ${candidateText(c)}` }));
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
      save();
    },
    { timeoutMs: 60_000 },
  );
  return events;
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
    const errors = await carryOut(agent, n.calendar, step);
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

export async function listen(home: Home, out: Output, opts: ListenOptions): Promise<void> {
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
    real.onEnvelopes(boot.id, (raw) => enqueue((t) => t.feedEnvelope(raw))),
    real.onTopics(topics, (doc, topic) => enqueue((t) => t.feedTopic(doc, topic))),
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
