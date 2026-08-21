/**
 * internal:sim/journal — the record of everything that crossed the boundary.
 *
 * A simulated realm's I/O crosses its facades, so the sequence of facade calls
 * records that interaction. The journal is that sequence: an assertion target
 * while testing, a behaviour report when analysing unknown code, and the
 * cassette a later run replays.
 *
 * The journal is a projection of the realm session's request, chunk,
 * completion, and error frames. Snapshot capture freezes values at the moment
 * they cross the boundary, before a handler or caller can mutate them. A
 * cassette later persists those snapshots with the same structured-clone
 * serializer, preserving `Map`, `Set`, `Date`, `BigInt`, typed arrays, and
 * cycles that JSON would flatten.
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
import { EnvelopeKind } from 'internal:realm/envelope';
import type { RealmFrameMetadata, RealmObservation, RealmObserver } from 'internal:realm/session';
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
  /** Chunks yielded by a read stream or written to a sink. */
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
  /** Base64 structured-clone bytes of the result, or of a read-stream chunk array. */
  value?: string;
  /** Base64 structured-clone bytes of read-stream or sink chunks. */
  chunks?: string;
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
 * Compare structured-clone values without assuming their wire bytes are
 * canonical.
 *
 * @internal
 */
export function equalValue(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, object> = new WeakMap(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const prior = seen.get(left);
  if (prior !== undefined) return prior === right;
  seen.set(left, right);
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())
    );
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return (
      left instanceof RegExp &&
      right instanceof RegExp &&
      left.source === right.source &&
      left.flags === right.flags
    );
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    const rightEntries = [...right];
    return [...left].every(
      ([key, value], index) =>
        equalValue(key, rightEntries[index]?.[0], seen) &&
        equalValue(value, rightEntries[index]?.[1], seen),
    );
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    const rightValues = [...right];
    return [...left].every((value, index) => equalValue(value, rightValues[index], seen));
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer)) return false;
    return equalBytes(new Uint8Array(left), new Uint8Array(right));
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    return (
      left.constructor === right.constructor &&
      equalBytes(
        new Uint8Array(left.buffer, left.byteOffset, left.byteLength),
        new Uint8Array(right.buffer, right.byteOffset, right.byteLength),
      )
    );
  }
  if (left instanceof Error || right instanceof Error) {
    return (
      left instanceof Error &&
      right instanceof Error &&
      left.name === right.name &&
      left.message === right.message
    );
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        equalValue(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          seen,
        ),
    )
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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
  #nextSequence = 0;
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
      seq: this.#nextSequence++,
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
    this.#entries.sort((left, right) => left.seq - right.seq);
    return entry;
  }
  /**
   * Project facade calls from a realm port's session traffic.
   *
   * The optional `specifier` narrows the projection for `recordFacade()`.
   * `simulate()` omits it and observes the whole realm boundary once.
   *
   * @internal
   */
  _observe(
    port: {
      _observe?(observer: RealmObserver): () => void;
    },
    specifier?: string,
  ): () => void {
    if (typeof port._observe !== 'function') {
      throw new TypeError('SimJournal requires a session-backed realm port');
    }
    const pending = new Map<number, PendingCall>();
    return port._observe({
      capture: 'snapshot',
      filter: isFacadeFrame,
      next: (observation) => this.#project(observation, pending, specifier),
    });
  }

  #project(
    observation: RealmObservation,
    pending: Map<number, PendingCall>,
    onlySpecifier?: string,
  ): void {
    if (observation.capture !== 'snapshot') return;
    const correlation = observation.correlation;
    switch (observation.kind) {
      case EnvelopeKind.RpcRequest:
      case EnvelopeKind.RpcStreamRequest:
      case EnvelopeKind.SinkStart: {
        if (observation.direction !== 'inbound') return;
        const request = (observation.value ?? {}) as {
          specifier?: unknown;
          method?: unknown;
          args?: unknown;
        };
        if (
          typeof request.specifier !== 'string' ||
          typeof request.method !== 'string' ||
          !Array.isArray(request.args) ||
          (onlySpecifier !== undefined && request.specifier !== onlySpecifier)
        ) {
          return;
        }
        pending.set(correlation, {
          seq: this.#nextSequence++,
          specifier: request.specifier,
          method: request.method,
          kind:
            observation.kind === EnvelopeKind.SinkStart
              ? 'sink'
              : observation.kind === EnvelopeKind.RpcStreamRequest
                ? 'stream'
                : 'call',
          args: request.args,
          chunks: [],
        });
        return;
      }
      case EnvelopeKind.SinkChunk:
        if (observation.direction === 'inbound') {
          pending.get(correlation)?.chunks.push(observation.value);
        }
        return;
      case EnvelopeKind.SinkError: {
        if (observation.direction !== 'inbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        this.#finish(pending, correlation, call, {
          outcome: 'error',
          error: String((observation.value as { error?: unknown })?.error ?? observation.value),
        });
        return;
      }
      case EnvelopeKind.RpcChunk: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        call.kind = 'stream';
        call.chunks.push(observation.value);
        return;
      }
      case EnvelopeKind.RpcEnd: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call !== undefined) this.#finish(pending, correlation, call, { outcome: 'ok' });
        return;
      }
      case EnvelopeKind.RpcError: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        this.#finish(pending, correlation, call, {
          outcome: 'error',
          error: String((observation.value as { error?: unknown })?.error ?? observation.value),
        });
        return;
      }
      case EnvelopeKind.RpcResponse: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        const response = (observation.value ?? {}) as { result?: unknown; error?: unknown };
        this.#finish(
          pending,
          correlation,
          call,
          response.error === undefined
            ? { outcome: 'ok', result: response.result }
            : { outcome: 'error', error: String(response.error) },
        );
        return;
      }
    }
  }

  #finish(
    pending: Map<number, PendingCall>,
    correlation: number,
    call: PendingCall,
    completion: { outcome: 'ok'; result?: unknown } | { outcome: 'error'; error: string },
  ): void {
    pending.delete(correlation);
    const entry: SimCall = {
      seq: call.seq,
      virtualTime: null,
      specifier: call.specifier,
      method: call.method,
      kind: call.kind,
      args: call.args,
      outcome: completion.outcome,
      ...(call.kind === 'call' ? {} : { chunks: call.chunks }),
      ...('result' in completion && completion.result !== undefined
        ? { result: completion.result }
        : {}),
      ...('error' in completion ? { error: completion.error } : {}),
    };
    this.#entries.push(entry);
    this.#entries.sort((left, right) => left.seq - right.seq);
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
        ...(entry.chunks !== undefined && (entry.kind === 'sink' || entry.outcome === 'error')
          ? { chunks: encodeValue(entry.chunks) }
          : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      })),
    };
  }
}

interface PendingCall {
  seq: number;
  specifier: string;
  method: string;
  kind: SimCallKind;
  args: unknown[];
  chunks: unknown[];
}

function isFacadeFrame(metadata: RealmFrameMetadata): boolean {
  return (
    metadata.kind === EnvelopeKind.RpcRequest ||
    metadata.kind === EnvelopeKind.RpcStreamRequest ||
    metadata.kind === EnvelopeKind.RpcResponse ||
    metadata.kind === EnvelopeKind.RpcChunk ||
    metadata.kind === EnvelopeKind.RpcEnd ||
    metadata.kind === EnvelopeKind.RpcError ||
    metadata.kind === EnvelopeKind.SinkStart ||
    metadata.kind === EnvelopeKind.SinkChunk ||
    metadata.kind === EnvelopeKind.SinkError
  );
}
