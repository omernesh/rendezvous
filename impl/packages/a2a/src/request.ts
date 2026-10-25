// SPEC §7.6.3: `request/v1`, the general capability. A free-text request
// (text parts, no `input`), class `free-form`: each task needs its human's
// approval to start, and each result to be released (SPEC §5.5). Results are
// text and file parts; it defines no `data` shapes, so a data part in a
// result is refused as an unknown shape (SPEC §7.5).
//
// Registered here so a host can route and advertise tasks/v1 (issue #36). The
// quarantine guidance for the model that drafts the result is issue #27.
import type { Capability } from './capabilities.js';

/** The general capability: ask another agent for anything no specific capability covers. */
export const REQUEST_URI = 'https://rendezvous.nesher.co/ext/request/v1';

export const REQUEST_CAPABILITY: Capability = Object.freeze({ uri: REQUEST_URI, approval: 'free-form' });
