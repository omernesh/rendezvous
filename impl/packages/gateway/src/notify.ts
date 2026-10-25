// Notices to the owner's phone: "something is waiting", with a link to the
// approval page and nothing else. No peer text ever goes out (a stranger
// writes the greeting, and it must not reach a lock screen unescaped), and
// no fingerprint or ID either: the page shows those once unlocked. A notice
// that times out or fails is dropped; it never blocks the agent.
import type { McpEvent } from '@rendezvous/mcp';
import { isLoopbackHost } from './http.js';

export interface NotifyTarget {
  kind: 'ntfy' | 'webhook';
  url: URL;
}

/** `ntfy:https://ntfy.sh/<topic>` or `webhook:https://…`; https only (http only to this machine). */
export function parseNotify(spec: string): NotifyTarget {
  const i = spec.indexOf(':');
  const kind = spec.slice(0, i);
  if (i < 0 || (kind !== 'ntfy' && kind !== 'webhook')) throw new Error(`--notify takes ntfy:<url> or webhook:<url>, not ${JSON.stringify(spec.slice(0, 40))}`);
  let url: URL;
  try {
    url = new URL(spec.slice(i + 1));
  } catch {
    throw new Error(`--notify ${kind}: not a URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`--notify ${kind}: use https:// (plain http only to this machine)`);
  }
  if (url.username || url.password) throw new Error(`--notify ${kind}: put credentials in the topic or path, not user:pass@`);
  return { kind, url };
}

export type NoticeKind = 'approval' | 'message';

/** Fixed texts: nothing in them comes from a peer. */
export function noticeText(kind: NoticeKind, count: number): string {
  if (kind === 'approval') return count === 1 ? 'Rendezvous: something is waiting for your approval.' : `Rendezvous: ${count} things are waiting for your approval.`;
  return count === 1 ? 'Rendezvous: a new message.' : `Rendezvous: ${count} new messages.`;
}

/** Which events call for a notice. */
export function classify(e: McpEvent): NoticeKind | undefined {
  if (e.type === 'contact_request' || e.type === 'contact_candidate') return 'approval';
  if (e.type === 'dinner' && e.kind === 'confirm-needed') return 'approval';
  if (e.type === 'message') return 'message';
  return undefined;
}

export class Notifier {
  /** Notices in flight are capped, so a flood of events can't pile up connections. */
  private inflight = 0;
  static readonly MAX_INFLIGHT = 8;

  constructor(
    private readonly targets: NotifyTarget[],
    private readonly approveUrl: string,
    private readonly log: (line: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  get enabled(): boolean {
    return this.targets.length > 0;
  }

  /** Send one notice per kind for a batch of new events. Never throws, never waits for the targets. */
  events(events: McpEvent[]): void {
    const counts = new Map<NoticeKind, number>();
    for (const e of events) {
      const k = classify(e);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) this.send(k, n);
  }

  send(kind: NoticeKind, count: number): Promise<void>[] {
    return this.targets.map((t) => this.post(t, kind, count));
  }

  private async post(t: NotifyTarget, kind: NoticeKind, count: number): Promise<void> {
    if (this.inflight >= Notifier.MAX_INFLIGHT) return;
    this.inflight++;
    const text = noticeText(kind, count);
    const init: RequestInit =
      t.kind === 'ntfy'
        ? { method: 'POST', body: text, headers: { Title: 'Rendezvous', Click: this.approveUrl, Tags: kind === 'approval' ? 'bell' : 'envelope', 'Content-Type': 'text/plain; charset=utf-8' } }
        : {
            method: 'POST',
            body: JSON.stringify({ source: 'rendezvous-gateway', event: kind, count, text, url: this.approveUrl }),
            headers: { 'Content-Type': 'application/json' },
          };
    try {
      const res = await this.fetchImpl(t.url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) this.log(`notify ${t.kind} ${t.url.host}: HTTP ${res.status}`);
    } catch (err) {
      this.log(`notify ${t.kind} ${t.url.host}: ${(err as Error).name}`);
    } finally {
      this.inflight--;
    }
  }
}
