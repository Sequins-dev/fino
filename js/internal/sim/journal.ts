/**
 * internal:sim/journal — the record of everything that crossed the boundary.
 *
 * A simulated realm's I/O crosses its facades, so the sequence of facade calls
 * records that interaction. The journal is that sequence: an assertion target
 * while testing, a behaviour report when analysing unknown code, and the
 * cassette a later run replays.
 *
 * Values are stored twice on purpose. The live object is what test code reads;
 * the structured-clone bytes are what a cassette persists, because the runtime
 * has no host-object hooks in its serializer, so those bytes are exactly what
 * crossed the realm boundary — `Map`, `Set`, `Date`, `BigInt`, typed arrays and
 * cycles all survive a round trip that JSON would quietly flatten.
 *
 * ```ts no_run
 * import { SimJournal } from 'internal:sim/journal';
 *
 * const journal = new SimJournal();
 * journal.record({ specifier: 'app:kv', method: 'get', kind: 'call', args: ['k'] });
 * console.log(journal.entries.length); // 1
 * ```
 *
 * @internal
 */
import { deserialize, serialize } from 'internal:serializer';
/**
 * How a facade method was invoked.
 *
 * @internal
 */
export type SimCallKind = 'call' | 'stream' | 'sink';
/**
 * One boundary crossing.
 *
 * @internal
 */
export interface SimCall {
  /** Position in the run, from 0. Stable across runs of the same simulation. */
  seq: number;
  /** Virtual milliseconds when the guest made the call, when it reported one. */
  virtualTime: number | null;
  /** Module specifier the guest imported. */
  specifier: string;
  /** Method it called. */
  method: string;
  /** Whether the call was scalar, a read stream, or a write stream. */
  kind: SimCallKind;
  /** Arguments as the parent saw them. */
  args: unknown[];
  /** Whether the handler returned or threw. */
  outcome: 'ok' | 'error';
  /** Return value, for a scalar call that returned. */
  result?: unknown;
  /** Chunks yielded, for a stream. */
  chunks?: unknown[];
  /** Message, for a handler that threw. */
  error?: string;
}
/**
 * A journal entry plus the bytes needed to replay it.
 *
 * @internal
 */
export interface CassetteEntry {
  seq: number;
  specifier: string;
  method: string;
  kind: SimCallKind;
  outcome: 'ok' | 'error';
  /** Base64 structured-clone bytes of the arguments. */
  args: string;
  /** Base64 structured-clone bytes of the result, or of the chunk array. */
  value?: string;
  error?: string;
}
/**
 * A recorded run, as written to disk.
 *
 * @internal
 */
export interface Cassette {
  version: 1;
  seed: number | string;
  startTime: number;
  entries: CassetteEntry[];
}
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/**
 * Encode a value as base64 structured-clone bytes.
 *
 * @internal
 */
export function encodeValue(value: unknown): string {
  return toBase64((serialize as (v: unknown) => Uint8Array[])(value)[0]!);
}
/**
 * Decode a value written by `encodeValue`.
 *
 * @internal
 */
export function decodeValue(text: string): unknown {
  return (deserialize as (b: Uint8Array) => unknown)(fromBase64(text));
}
/**
 * Fields a caller supplies when recording; `seq` is assigned by the journal.
 *
 * @internal
 */
export type SimCallInput = Omit<SimCall, 'seq' | 'outcome' | 'virtualTime'> &
  Partial<Pick<SimCall, 'outcome' | 'virtualTime'>>;
/**
 * The ordered record of a simulation run.
 *
 * @internal
 */
export class SimJournal {
  #entries: SimCall[] = [];
  /**
   * Every call so far, in the order the guest made them.
   */
  get entries(): readonly SimCall[] {
    return this.#entries;
  }
  /**
   * Append a call and return the stored entry.
   */
  record(call: SimCallInput): SimCall {
    const entry: SimCall = {
      seq: this.#entries.length,
      virtualTime: call.virtualTime ?? null,
      specifier: call.specifier,
      method: call.method,
      kind: call.kind,
      args: call.args,
      outcome: call.outcome ?? 'ok',
      ...(call.result !== undefined ? { result: call.result } : {}),
      ...(call.chunks !== undefined ? { chunks: call.chunks } : {}),
      ...(call.error !== undefined ? { error: call.error } : {}),
    };
    this.#entries.push(entry);
    return entry;
  }
  /**
   * Calls matching a specifier, and optionally a method.
   */
  calls(specifier?: string, method?: string): SimCall[] {
    return this.#entries.filter(
      (entry) =>
        (specifier === undefined || entry.specifier === specifier) &&
        (method === undefined || entry.method === method),
    );
  }
  /**
   * Encode the run as a cassette.
   */
  toCassette(seed: number | string, startTime: number): Cassette {
    return {
      version: 1,
      seed,
      startTime,
      entries: this.#entries.map((entry) => ({
        seq: entry.seq,
        specifier: entry.specifier,
        method: entry.method,
        kind: entry.kind,
        outcome: entry.outcome,
        args: encodeValue(entry.args),
        ...(entry.outcome === 'ok'
          ? { value: encodeValue(entry.kind === 'stream' ? (entry.chunks ?? []) : entry.result) }
          : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      })),
    };
  }
}
