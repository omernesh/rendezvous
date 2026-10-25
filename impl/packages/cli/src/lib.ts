// Library entry (`@rendezvous/cli/lib`) for the MCP server: the same home-dir
// format, lock, crash-safe send path and inbound loop as `rdv`, so `rdv` and
// `rdv-mcp` can share a profile.
export { type AddressChange, type AddressView, addressViews, changeAddress, initHome, type InitOptions, relayHealth, requestContactTo, TIERS, withAgent } from './commands.js';
export { appendEvents, EVENTS_FILE_KEPT, eventsStamp, isNoise, type LoggedEvent, readEvents, STRANGER_DROPS } from './events.js';
export { acquireLock, LockTimeoutError, type LongLock, tryLongLock, writeAtomic } from './fsutil.js';
export {
  candidateDigest,
  candidateLabel,
  candidateLabelDigest,
  candidateTarget,
  checkPhrase,
  describeApproval,
  describeLabel,
  describeTerms,
  dropPhrase,
  inboundAsks,
  inboundSubject,
  inboundTarget,
  type IssuedPhrase,
  issuePhrase,
  MAX_ATTEMPTS,
  newPhrase,
  normalizePhrase,
  type PhraseCheck,
  type PhraseTarget,
  reissueForDisplay,
  requestSubject,
  type ShownPhrase,
  requestTarget,
  syncPhrases,
  termsDigest,
} from './consent.js';
export {
  CliError,
  type Config,
  type ConsentAction,
  type ConsentEntry,
  type ConsentHash,
  type ConfigAddress,
  type ConsentTerms,
  consentKey,
  Home,
  type InboxEntry,
  parseJsonLines,
} from './home.js';
export { ADDRESS_POLL_MS, type Emitted, FeedTransport, handleInbound, hasExpiring, isJunk, type ListenOptions, SWEEP_MS, type TopicChange, watchTopics } from './listen.js';
export {
  agreedDigest,
  buildCtx,
  carryOut,
  DEFAULT_LISTEN_WINDOW,
  dinnerView,
  holdCode,
  inboundMeetingScope,
  meetingCode,
  meetingDigest,
  meetingScope,
  type NegotiateOptions,
  openCalendar,
  taskView,
  validateNegotiateOptions,
} from './negotiate.js';
export { candidateView, clean, contactView, overflowView, requestView } from './output.js';
export { type AuditEntry, AUDIT_KEPT, type PendingRelease, type ReleaseContent, type TaskHostState } from './home.js';
export {
  answerPeer,
  approveRelease,
  approveStart,
  cancelPeer,
  declineStart,
  describeDraft,
  discardDraft,
  type DraftInput,
  gateCode,
  HOST_CAPABILITIES,
  hostCardCapabilities,
  hostRegistry,
  inboundTaskCtx,
  pruneReleases,
  releaseDigest,
  releaseView,
  requestPeer,
  startDigest,
  startView,
  submitDraft,
  TaskChangedError,
  taskCtx,
  taskEventText,
  taskEventView,
  taskListView,
  taskPhraseTargets,
  type TaskRun,
} from './tasks.js';
export { relayTransport } from './transport.js';
export {
  type AutoApproveSubject,
  autoApproveStatus,
  autoApproved,
  autoApprovedCounts,
  checkAutoApprove,
  setAutoApprove,
  subjectOf,
  subjectOfState,
  sweepAutoApprove,
  turnOffAutoApprove,
} from './autoapprove.js';
export { type AutoApproveEntry, type AutoApproveOff } from './home.js';
