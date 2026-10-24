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
import { Agent, dtopic, type Envelope, NostrTransport, type Tier, type Transport } from '@rendezvous/core';
import type { Home, InboxEntry } from './home.js';
import { clean, contactText, contactView, inboxText, type Output, requestText, requestView } from './output.js';

/** Passes sends through to the real transport; inbound items are fed in by hand. */
class FeedTransport implements Transport {
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

interface Emitted {
  obj: { event: string } & Record<string, unknown>;
  human?: string;
}

export interface ListenOptions {
  autoGrant?: Tier;
  exec?: string;
}

export async function listen(home: Home, out: Output, opts: ListenOptions): Promise<void> {
  const config = home.readConfig();
  const boot = Agent.fromJSON(home.readAgentState(), (key) => new NostrTransport({ key, relays: config.relays }));
  const real = boot.transport;
  const topics = (boot.card.discovery?.addresses ?? []).map(dtopic);

  const print = async (e: Emitted) => {
    out.emit(e.obj, e.human);
    if (opts.exec) await runExec(opts.exec, home, e.obj);
  };

  const processOne = async (feed: (t: FeedTransport) => void): Promise<void> => {
    const events: Emitted[] = [];
    await home.locked(
      async () => {
        const t = new FeedTransport(real);
        const agent = Agent.fromJSON(home.readAgentState(), () => t);
        const grants: Promise<unknown>[] = [];
        const inbox: InboxEntry[] = [];
        agent.on('request', (p) => {
          events.push({ obj: { event: 'request', ...requestView(p) }, human: `request ${requestText(p)}` });
          // Demo only: a human should normally decide (`rdv contact grant`).
          if (opts.autoGrant) grants.push(agent.grant(p.request.id, { tier: opts.autoGrant }));
        });
        agent.on('contact', (c) => events.push({ obj: { event: 'contact', ...contactView(c) }, human: `contact ${contactText(c)}` }));
        agent.on('message', (from, payload, env) => {
          const entry: InboxEntry = { ts: new Date().toISOString(), from, seq: env.seq, payload };
          inbox.push(entry);
          events.push({ obj: { event: 'message', ...entry }, human: `message ${inboxText(entry)}` });
        });
        agent.on('revoked', (peer) => events.push({ obj: { event: 'revoked', peer }, human: `revoked by ${peer}` }));
        agent.on('dropped', (reason, detail) => {
          const quiet = reason.includes('duplicate'); // relay replays on every restart
          events.push({
            obj: { event: 'dropped', reason, detail },
            human: quiet ? undefined : `dropped: ${clean(reason)}`,
          });
        });
        agent.on('error', (err) => events.push({ obj: { event: 'error', message: err.message }, human: `error: ${err.message}` }));
        agent.start();
        feed(t);
        await agent.idle();
        for (const r of await Promise.allSettled(grants)) {
          if (r.status === 'rejected') {
            const message = `auto-grant failed: ${(r.reason as Error)?.message ?? r.reason}`;
            events.push({ obj: { event: 'error', message }, human: `error: ${message}` });
          }
        }
        await agent.idle();
        agent.stop();
        // Inbox first, then state: a crash in between re-delivers rather than loses.
        for (const e of inbox) home.appendInbox(e);
        home.writeAgentState(agent.toJSON());
      },
      { timeoutMs: 60_000 },
    );
    for (const e of events) await print(e);
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (feed: (t: FeedTransport) => void) => {
    chain = chain
      .then(() => processOne(feed))
      .catch((err: Error) => out.emit({ event: 'error', message: err.message }, `error: ${err.message}`));
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
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(keepAlive);
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
