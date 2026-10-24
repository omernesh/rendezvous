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

export interface TestRelay {
  url: string;
  events: Event[];
  close(): Promise<void>;
}

export async function startTestRelay(port = 0): Promise<TestRelay> {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const events: Event[] = [];
  const subs = new Map<WebSocket, Map<string, Filter[]>>();

  wss.on('connection', (ws) => {
    subs.set(ws, new Map());
    ws.on('close', () => subs.delete(ws));
    ws.on('message', (data) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const [type, ...rest] = msg as [string, ...unknown[]];
      if (type === 'EVENT') {
        const ev = rest[0] as Event;
        if (!verifyEvent(ev)) {
          ws.send(JSON.stringify(['OK', ev?.id, false, 'invalid: bad signature']));
          return;
        }
        if (!events.some((e) => e.id === ev.id)) {
          events.push(ev);
          for (const [client, clientSubs] of subs) {
            for (const [id, filters] of clientSubs) {
              if (filters.some((f) => matches(ev, f))) client.send(JSON.stringify(['EVENT', id, ev]));
            }
          }
        }
        ws.send(JSON.stringify(['OK', ev.id, true, '']));
      } else if (type === 'REQ') {
        const [id, ...filters] = rest as [string, ...Filter[]];
        subs.get(ws)?.set(id, filters);
        for (const f of filters) {
          let hits = events.filter((e) => matches(e, f));
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
