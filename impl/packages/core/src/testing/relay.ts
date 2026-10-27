// A tiny in-memory Nostr relay (NIP-01 subset: EVENT, REQ, CLOSE, OK, EOSE)
// for tests and local demos. Not for production use.
import { type Event, verifyEvent } from 'nostr-tools/pure';
import { type WebSocket, WebSocketServer } from 'ws';

type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
};

/** NIP-40: `ev` carries an `expiration` at or before `now` (Unix seconds). */
export function expiredAt(ev: Event, now: number): boolean {
  const at = Number(ev.tags.find((t) => t[0] === 'expiration')?.[1]);
  return Number.isFinite(at) && at <= now;
}

export function matches(ev: Event, f: Filter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  for (const [k, values] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(values)) continue;
    const wanted = values as string[];
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && wanted.includes(t[1]))) return false;
  }
  return true;
}

/** Failure modes for transport tests; change them on a running relay. */
export interface RelayFaults {
  /** Answer `OK false` with this message instead of storing the event. */
  okFalse?: string;
  /** Only for this many more EVENTs, then accept again; unset: every EVENT. */
  okFalseTimes?: number;
  /** Drop the connection on this many more EVENTs, without an OK. */
  dropOnEvent?: number;
  /** Wait this long before answering an EVENT. */
  ackDelayMs?: number;
}

export interface TestRelay {
  url: string;
  events: Event[];
  /** Ephemeral events (kinds 20000-29999) it passed on: never stored, so not in `events`. */
  ephemeral: Event[];
  /** Every REQ filter received, in order (tests check `since`). */
  requests: Filter[];
  /** Arrival time (ms) of every EVENT message, accepted or not. */
  received: number[];
  /** WebSocket connections accepted so far. */
  readonly connections: number;
  faults: RelayFaults;
  /**
   * Go half-open: every connection open now stops reading (so it never answers
   * a ping) and gets nothing more, and nothing closes. Connections made later
   * work normally, like a relay that came back.
   */
  stall(): void;
  /**
   * Go deaf: every connection open now stays healthy (it answers pings and
   * takes EVENTs with `OK true`) but its subscriptions get nothing more, as
   * when a relay loses a subscription without telling us (NOTES 98).
   * Connections made later work normally.
   */
  deafen(): void;
  close(): Promise<void>;
}

export async function startTestRelay(port = 0, faults: RelayFaults = {}): Promise<TestRelay> {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const events: Event[] = [];
  const requests: Filter[] = [];
  const received: number[] = [];
  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  let connections = 0;
  const stalled = new Set<WebSocket>();
  const deaf = new Set<WebSocket>();
  const ephemeral: Event[] = [];

  const store = (ws: WebSocket, ev: Event) => {
    if (!verifyEvent(ev)) {
      ws.send(JSON.stringify(['OK', ev?.id, false, 'invalid: bad signature']));
      return;
    }
    // NIP-01 ephemeral kinds: passed to live subscriptions, never stored (so never replayed).
    if (ev.kind >= 20000 && ev.kind < 30000) {
      ephemeral.push(ev);
      for (const [client, clientSubs] of subs) {
        for (const [id, filters] of clientSubs) {
          if (!stalled.has(client) && !deaf.has(client) && filters.some((f) => matches(ev, f))) client.send(JSON.stringify(['EVENT', id, ev]));
        }
      }
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      return;
    }
    // NIP-01 addressable kinds: keep only the newest per (pubkey, kind, d); a tie keeps the lower id.
    const d = (e: Event) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const addressable = ev.kind >= 30000 && ev.kind < 40000;
    const older = addressable ? events.findIndex((e) => e.kind === ev.kind && e.pubkey === ev.pubkey && d(e) === d(ev)) : -1;
    const superseded =
      older >= 0 &&
      (events[older].created_at > ev.created_at || (events[older].created_at === ev.created_at && events[older].id <= ev.id));
    if (!events.some((e) => e.id === ev.id) && !superseded) {
      if (older >= 0) events.splice(older, 1);
      events.push(ev);
      for (const [client, clientSubs] of subs) {
        for (const [id, filters] of clientSubs) {
          if (!stalled.has(client) && !deaf.has(client) && filters.some((f) => matches(ev, f))) client.send(JSON.stringify(['EVENT', id, ev]));
        }
      }
    }
    ws.send(JSON.stringify(['OK', ev.id, true, '']));
  };

  const onEvent = (ws: WebSocket, ev: Event) => {
    received.push(Date.now());
    if (faults.dropOnEvent) {
      faults.dropOnEvent--;
      ws.terminate();
      return;
    }
    let answer: () => void;
    if (faults.okFalse !== undefined && (faults.okFalseTimes === undefined || faults.okFalseTimes > 0)) {
      if (faults.okFalseTimes !== undefined) faults.okFalseTimes--;
      const reason = faults.okFalse;
      answer = () => ws.send(JSON.stringify(['OK', ev?.id, false, reason]));
    } else {
      answer = () => store(ws, ev);
    }
    if (faults.ackDelayMs) {
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) answer();
      }, faults.ackDelayMs);
    } else answer();
  };

  wss.on('connection', (ws) => {
    connections++;
    subs.set(ws, new Map());
    ws.on('close', () => {
      subs.delete(ws);
      stalled.delete(ws);
      deaf.delete(ws);
    });
    ws.on('message', (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const [type, ...rest] = msg as [string, ...unknown[]];
      if (type === 'EVENT') {
        onEvent(ws, rest[0] as Event);
      } else if (type === 'REQ') {
        const [id, ...filters] = rest as [string, ...Filter[]];
        subs.get(ws)?.set(id, filters);
        requests.push(...filters);
        for (const f of filters) {
          // NIP-40: an event whose expiration has passed is not served any more.
          let hits = events.filter((e) => matches(e, f) && !expiredAt(e, Math.floor(Date.now() / 1000)));
          if (f.limit !== undefined) hits = hits.slice(-f.limit);
          for (const ev of hits) ws.send(JSON.stringify(['EVENT', id, ev]));
        }
        ws.send(JSON.stringify(['EOSE', id]));
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0] as string);
      }
    });
  });

  const addr = wss.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `ws://127.0.0.1:${actualPort}`,
    events,
    ephemeral,
    requests,
    received,
    get connections() {
      return connections;
    },
    faults,
    stall() {
      for (const client of wss.clients) {
        stalled.add(client);
        // The socket stays open but is never read: no pong, no close, as when the network path dies.
        (client as unknown as { _socket: { pause(): void } })._socket.pause();
      }
    },
    deafen() {
      for (const client of wss.clients) deaf.add(client);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

export { selfSignedCert, startTestFileServer, type TestFileServer } from './fileserver.js';
