// SPEC §7.6.3: `request/v1`, the general capability: ask another agent for
// anything no specific capability covers. Class `free-form`: each task needs
// its human's approval to start, and each result to be released (SPEC §5.5),
// and no per-capability standing policy may waive the start gate.
//
// Shapes (issue #27), all strict and bounded:
//
//   request   text parts: what is asked, in words (the request itself).
//             `input` (optional): `{ data: <JSON object> }`, structured data
//             that goes with the text (a list of items, a form to fill).
//   answer    `task/input` (optional input): the same `{ data }` shape.
//   results   artifacts of text parts, data parts of shape `request/data`
//             (`{ rdv: "request/data", data: <JSON object> }`), and file parts.
//   questions an input-required status may carry the same data shape.
//
// The data is free-form: it is validated only for size and shape (JSON,
// bounded depth, count and length), never interpreted. Everything in it, as
// in the text, is untrusted peer content (SPEC §5.6): hosts show it as
// `untrusted_peer_text`, and the model that drafts the answer treats it as
// data, never as instructions.
//
// Attachments: file parts in the request and in results follow §7.7 (files
// extension, issue #26). request/v1 adds no rule of its own to them, so the
// engine's file handling is the one place to change when it lands.
import { type Capability, s, type Schema } from './capabilities.js';

/** The general capability: ask another agent for anything no specific capability covers. */
export const REQUEST_URI = 'https://rendezvous.nesher.co/ext/request/v1';

/** Bounds on request/v1's free-form data (`input.data`, an answer's `data`, a `request/data` part). */
export const REQUEST_DATA_BOUNDS = Object.freeze({ maxDepth: 4, maxNodes: 256, maxString: 2000, maxChars: 8192 });

const data: Schema = s.json(REQUEST_DATA_BOUNDS);

/** `input` of a request (and of a `task/input` answer): structured data beside the text. */
export const REQUEST_INPUT: Schema = s.object({ data });

/** The data-part shape of request/v1 results and questions. */
export const REQUEST_DATA_SHAPE = 'request/data';

export const REQUEST_CAPABILITY: Capability = Object.freeze({
  uri: REQUEST_URI,
  approval: 'free-form',
  input: REQUEST_INPUT,
  inputOptional: true,
  data: Object.freeze({ [REQUEST_DATA_SHAPE]: s.object({ rdv: s.oneOf([REQUEST_DATA_SHAPE] as const), data }) }),
});
