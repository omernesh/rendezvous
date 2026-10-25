// Confirm phrases: the fallback consent channel when the MCP client can't
// elicit (PLAN §6.1, demo-critical). The implementation lives in the CLI
// (`@rendezvous/cli/lib`, packages/cli/src/consent.ts) because `rdv contact
// pending` and `rdv dinner list` read and re-issue the same consent.json.
//
// In short: a random phrase per pending request, probe answer or held
// dinner, shown only on human-facing channels and never in a tool result.
// consent.json stores only a salted scrypt hash of it (issue #12). Each
// phrase is scoped by action and bound to the digest of what the human was
// shown: the meeting, the probe answer with the local label it gets, or the
// request together with the tier, scope and label it grants. Another tier,
// scope or label, another meeting under the same task ID, or another
// request under the same ID approves nothing.
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
  type IssuedPhrase,
  issuePhrase,
  MAX_ATTEMPTS,
  newPhrase,
  normalizePhrase,
  type PhraseCheck,
  type PhraseTarget,
  reissueForDisplay,
  requestSubject,
  requestTarget,
  syncPhrases,
  termsDigest,
} from '@rendezvous/cli/lib';
