// SPEC §7.6.3: capabilities. A capability is an extension URI that names what
// a task asks for. Its definition states the JSON shape of the task's `input`
// and of the `data` parts of its artifacts and status messages (`data.rdv`
// names the shape), and its approval class. The registry holds the
// capabilities this agent implements; later slices register theirs
// (`request/v1`, review, …). The task engine (tasks.ts) refuses a task whose
// capability is not registered as unsupported (SPEC §7.5).
//
// Shapes are checked by a tiny strict schema: known keys only, bounded
// strings, lists and integers. A schema never coerces; a value either matches
// exactly or is refused. Everything it checks is peer input.
import { parseInstant } from './time.js';

/** SPEC §7.6.3 approval classes, weakest to strongest gate. */
export type ApprovalClass = 'notify' | 'auto' | 'confirm' | 'free-form';
export const APPROVAL_CLASSES: readonly ApprovalClass[] = ['notify', 'auto', 'confirm', 'free-form'];

/** Classes whose tasks wait for the human before the executor acts on them (start gate, SPEC §5.5). */
export const needsStartGate = (c: ApprovalClass): boolean => c === 'confirm' || c === 'free-form';
/** Classes whose artifacts and free-text status messages wait for the human before they leave (release gate). */
export const needsReleaseGate = (c: ApprovalClass): boolean => c === 'confirm' || c === 'free-form';

// --- schema -------------------------------------------------------------

export class SchemaError extends Error {}

/** Validates `v` and returns it unchanged, or throws SchemaError naming `path`. */
export type Schema<T = unknown> = (v: unknown, path: string) => T;

const bad = (path: string, what: string): never => {
  throw new SchemaError(`${path}: ${what}`);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Longest key we accept in any object, and the most keys. */
const MAX_KEY_CHARS = 64;

export const s = {
  /** A string of 1–`max` characters (0–`max` with `allowEmpty`). */
  string:
    (max: number, opts: { allowEmpty?: boolean; pattern?: RegExp } = {}): Schema<string> =>
    (v, path) => {
      if (typeof v !== 'string') return bad(path, 'must be a string');
      if (v.length > max || (v.length === 0 && !opts.allowEmpty)) return bad(path, `must be 1–${max} characters`);
      if (opts.pattern && !opts.pattern.test(v)) return bad(path, 'has the wrong format');
      return v;
    },
  /** An integer in [min, max]. */
  int:
    (min: number, max: number): Schema<number> =>
    (v, path) => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : bad(path, `must be an integer ${min}–${max}`)),
  bool: (): Schema<boolean> => (v, path) => (typeof v === 'boolean' ? v : bad(path, 'must be true or false')),
  /** One of the listed strings. */
  oneOf:
    <T extends string>(values: readonly T[]): Schema<T> =>
    (v, path) => (typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : bad(path, `must be one of ${values.join(', ')}`)),
  /** An RFC 3339 date-time with an explicit offset. */
  instant: (): Schema<string> => (v, path) => (typeof v === 'string' && v.length <= 64 && parseInstant(v) !== null ? v : bad(path, 'must be an RFC 3339 date-time with an offset')),
  /** A list of 0–`max` items (at least `min`). */
  list:
    <T>(item: Schema<T>, max: number, min = 0): Schema<T[]> =>
    (v, path) => {
      if (!Array.isArray(v) || v.length < min || v.length > max) return bad(path, `must be a list of ${min}–${max} items`);
      return v.map((x, i) => item(x, `${path}[${i}]`));
    },
  /** An object with exactly these keys (`optional` ones may be absent); any other key is refused. */
  object:
    (required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema<Record<string, unknown>> =>
    (v, path) => {
      if (!isPlainObject(v)) return bad(path, 'must be an object');
      for (const k of Object.keys(v)) {
        if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k)) bad(path, `unknown field ${JSON.stringify(k.slice(0, MAX_KEY_CHARS))}`);
      }
      for (const [k, schema] of Object.entries(required)) {
        if (!Object.hasOwn(v, k)) bad(path, `missing "${k}"`);
        schema(v[k], `${path}.${k}`);
      }
      for (const [k, schema] of Object.entries(optional)) if (Object.hasOwn(v, k) && v[k] !== undefined) schema(v[k], `${path}.${k}`);
      return v;
    },
} as const;

// --- capabilities ---------------------------------------------------------

/** Data-part shapes: `data.rdv` → the schema of the whole data object (`rdv` included). */
export type DataShapes = Readonly<Record<string, Schema>>;

export interface Capability {
  /** The capability's extension URI (at most 200 characters, like every card entry). */
  uri: string;
  approval: ApprovalClass;
  /**
   * The schema of `task/request`'s `input`. Absent: the capability takes no
   * input, and a request that carries one is refused.
   */
  input?: Schema;
  /**
   * `input` (and a `task/input` answer) may be absent although a schema is
   * set. Default false: when a schema exists, absent input is refused.
   */
  inputOptional?: boolean;
  /** The schema of `task/input`'s `input` (the answer to input-required). Default: `input`. */
  answer?: Schema;
  /** Shapes of `data` parts in its artifacts and status messages. A data part of any other shape is refused. */
  data?: DataShapes;
  /** Open tasks per peer for this capability when the grant sets no `max_open` (default MAX_OPEN_DEFAULT). */
  maxOpen?: number;
}

/** `max_open` per capability when neither the grant nor the capability says (SPEC §7.4). */
export const MAX_OPEN_DEFAULT = 4;
/** The longest capability URI (SPEC §4.3: card entries are at most 200 characters). */
export const MAX_URI_CHARS = 200;

const URI_RE = /^https:\/\/[\x21-\x7e]+$/;
/** A capability URI: `https://…`, printable ASCII, at most 200 characters. */
export const isCapabilityUri = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_URI_CHARS && URI_RE.test(v);

export class CapabilityRegistry {
  readonly #byUri = new Map<string, Capability>();

  constructor(capabilities: readonly Capability[] = []) {
    for (const c of capabilities) this.register(c);
  }

  register(c: Capability): this {
    if (!isCapabilityUri(c.uri)) throw new TypeError(`capability URI must be https and at most ${MAX_URI_CHARS} characters: ${c.uri}`);
    if (!APPROVAL_CLASSES.includes(c.approval)) throw new TypeError(`unknown approval class ${String(c.approval)}`);
    if (c.inputOptional !== undefined && typeof c.inputOptional !== 'boolean') throw new TypeError('inputOptional must be a boolean');
    if (c.maxOpen !== undefined && !(Number.isSafeInteger(c.maxOpen) && c.maxOpen >= 1)) throw new TypeError('maxOpen must be a positive integer');
    if (this.#byUri.has(c.uri)) throw new TypeError(`capability ${c.uri} is already registered`);
    this.#byUri.set(c.uri, Object.freeze({ ...c }));
    return this;
  }

  get(uri: string): Capability | undefined {
    return this.#byUri.get(uri);
  }

  has(uri: string): boolean {
    return this.#byUri.has(uri);
  }

  /** The registered URIs, in registration order (for the card's `capabilities`). */
  uris(): string[] {
    return [...this.#byUri.keys()];
  }
}

/** Validate a task's `input` (or a `task/input` answer) against its capability. Throws SchemaError. */
export function checkInput(cap: Capability, input: unknown, answer = false): unknown {
  const schema = answer ? (cap.answer ?? cap.input) : cap.input;
  if (!schema) {
    if (input === undefined) return undefined;
    throw new SchemaError(`input: ${cap.uri} takes no input`);
  }
  // A capability with a schema always validates; absent input passes only when it says input is optional.
  if (input === undefined) {
    if (cap.inputOptional === true) return undefined;
    throw new SchemaError(`input: ${cap.uri} requires input`);
  }
  return schema(input, 'input');
}

/** Validate one `data` part of an artifact or status message against its capability's shapes. Throws SchemaError. */
export function checkData(cap: Capability, data: unknown, path = 'data'): Record<string, unknown> {
  if (!isPlainObject(data)) throw new SchemaError(`${path}: must be an object`);
  const shape = data.rdv;
  if (typeof shape !== 'string' || !cap.data || !Object.hasOwn(cap.data, shape)) {
    throw new SchemaError(`${path}: unknown data shape ${JSON.stringify(typeof shape === 'string' ? shape.slice(0, 40) : shape)} for ${cap.uri}`);
  }
  cap.data[shape](data, path);
  return data;
}
