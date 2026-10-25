// Library entry (`@rendezvous/cli/lib`) for the MCP server: the same home-dir
// format, lock, crash-safe send path and inbound loop as `rdv`, so `rdv` and
// `rdv-mcp` can share a profile.
export { initHome, type InitOptions, requestContactTo, TIERS, withAgent } from './commands.js';
export { acquireLock, LockTimeoutError, writeAtomic } from './fsutil.js';
export { CliError, type Config, type ConsentEntry, Home, type InboxEntry, parseJsonLines } from './home.js';
export { type Emitted, FeedTransport, handleInbound, hasExpiring, type ListenOptions, SWEEP_MS } from './listen.js';
export {
  buildCtx,
  carryOut,
  DEFAULT_LISTEN_WINDOW,
  dinnerView,
  inboundMeetingScope,
  meetingScope,
  type NegotiateOptions,
  openCalendar,
  taskView,
  validateNegotiateOptions,
} from './negotiate.js';
export { candidateView, clean, contactView, requestView } from './output.js';
export { relayTransport } from './transport.js';
