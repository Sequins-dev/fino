/**
 * internal:sim/journal — the record of everything that crossed the boundary.
 *
 * A simulated realm's I/O crosses one transport channel. The cassette stores
 * that channel's serialized frames directly; the human-friendly facade call
 * list is only a projection used for assertions and reports.
 *
 * The journal is a projection of the transport's request, chunk,
 * completion, and error frames. Snapshot capture freezes values at the moment
 * they cross the boundary, before a handler or caller can mutate them. A
 * Recording asks the channel tee for its storage representation, preserving
 * `Map`, `Set`, `Date`, `BigInt`, typed arrays, and cycles without serializing
 * completed calls a second time.
 *
 * ```ts no_run
 * import { SimJournal } from 'internal:sim/journal';
 *
 * const journal = new SimJournal();
 * console.log(journal.entries.length); // projected calls observed so far
 * ```
 *
 * @internal
 */
import { deserialize, serialize } from 'internal:serializer';
import { EnvelopeKind } from 'internal:realm/envelope';
import type {
  TransportFrameMetadata,
  TransportFrame,
  TransportObserver,
  TransportStorageFrame,
} from 'internal:realm/transport-port';
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
/** One module loaded by the recorded guest. @internal */
export interface CassetteModule {
  /** Absolute loader path. */
  path: string;
  /** SHA-256 of the loaded file bytes, when the module came from disk. */
  sha256?: string;
}

/** Inputs that must agree before a session can be replayed. @internal */
export interface CassetteManifest {
  /** Guest entry specifier. */
  entry: string;
  /** Effective import rules after facades are normalized to module shapes. */
  imports: readonly unknown[];
  /** Seed used by deterministic random sources. */
  seed: number | string;
  /** Initial wall-clock milliseconds. */
  startTime: number;
  /** Whether the realm clock advanced virtually. */
  virtualTime: boolean;
  /** Seeded facade latency range, or `null` when responses are immediate. */
  latency: [number, number] | null;
  /** Runtime identity recorded by the parent environment. */
  runtime: string;
  /** Loaded filesystem modules and their content hashes. */
  modules: CassetteModule[];
}

/** One exact serialized frame from the realm transport. @internal */
export interface CassetteFrame {
  /** Direction relative to the parent endpoint. */
  direction: 'outbound' | 'inbound';
  /** Realm envelope kind. */
  kind: number;
  /** Correlation identifier recorded on the wire. */
  correlation: number;
  /** Base64 structured-clone main payload followed by transfer stores. */
  parts: string[];
}
/**
 * A recorded run, as written to disk.
 *
 * @internal
 */
export interface Cassette {
  version: 2;
  manifest: CassetteManifest;
  frames: CassetteFrame[];
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
/** Decode the payload carried by one recorded frame. @internal */
export function decodeFrame(frame: CassetteFrame): unknown {
  const [data, ...stores] = frame.parts.map(fromBase64);
  if (data === undefined) throw new Error('fino:sim — cassette frame has no payload');
  return (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
    data,
    stores.length === 0 ? undefined : stores,
  );
}
/**
 * Compare values through the same structured-clone representation used by the
 * transport recorder.
 *
 * @internal
 */
export function equalValue(left: unknown, right: unknown): boolean {
  const leftParts = serialize(left);
  const rightParts = serialize(right);
  return (
    leftParts.length === rightParts.length &&
    leftParts.every((part, index) => equalBytes(part, rightParts[index]!))
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
/**
 * The ordered record of a simulation run.
 *
 * @internal
 */
export class SimJournal {
  #entries: SimCall[] = [];
  #frames: CassetteFrame[] = [];
  #nextSequence = 0;
  /**
   * Every call so far, in the order the guest made them.
   */
  get entries(): readonly SimCall[] {
    return this.#entries;
  }
  /** Exact frames captured for a cassette. Empty for snapshot-only journals. @internal */
  get frames(): readonly CassetteFrame[] {
    return this.#frames;
  }

  /** Files reported by the guest after its entry module graph loaded. @internal */
  modulePaths(): string[] {
    for (let index = this.#frames.length - 1; index >= 0; index--) {
      const frame = this.#frames[index]!;
      if (frame.direction !== 'inbound' || frame.kind !== EnvelopeKind.Lifecycle) continue;
      const event = decodeFrame(frame) as { modules?: unknown };
      if (Array.isArray(event?.modules)) {
        return event.modules.filter((path): path is string => typeof path === 'string').sort();
      }
    }
    return [];
  }
  /** Build an observer suitable for `RealmOptions.observe`. @internal */
  _observer(
    recordFrames = false,
    pending: Map<number, PendingCall> = new Map(),
  ): TransportObserver {
    return {
      capture: recordFrames ? 'storage' : 'snapshot',
      portable: recordFrames,
      filter: recordFrames ? undefined : isFacadeFrame,
      next: (observation) => {
        if (recordFrames && observation.capture === 'storage') this.#recordFrame(observation);
        this.#project(observation, pending);
      },
    };
  }

  #recordFrame(observation: TransportStorageFrame): void {
    this.#frames.push({
      direction: observation.direction,
      kind: observation.kind,
      correlation: observation.correlation,
      parts: observation.parts.map(toBase64),
    });
  }

  #project(observation: TransportFrame, pending: Map<number, PendingCall>): void {
    if (observation.capture === 'metadata') return;
    const value =
      observation.capture === 'snapshot' ? observation.value : decodeStoredObservation(observation);
    const correlation = observation.correlation;
    switch (observation.kind) {
      case EnvelopeKind.RpcRequest:
      case EnvelopeKind.RpcStreamRequest:
      case EnvelopeKind.SinkStart: {
        if (observation.direction !== 'inbound') return;
        const request = (value ?? {}) as {
          specifier?: unknown;
          method?: unknown;
          args?: unknown;
        };
        if (
          typeof request.specifier !== 'string' ||
          typeof request.method !== 'string' ||
          !Array.isArray(request.args)
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
          pending.get(correlation)?.chunks.push(value);
        }
        return;
      case EnvelopeKind.SinkError: {
        if (observation.direction !== 'inbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        this.#finish(pending, correlation, call, {
          outcome: 'error',
          error: String((value as { error?: unknown })?.error ?? value),
        });
        return;
      }
      case EnvelopeKind.RpcChunk: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        call.kind = 'stream';
        call.chunks.push(value);
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
          error: String((value as { error?: unknown })?.error ?? value),
        });
        return;
      }
      case EnvelopeKind.RpcResponse: {
        if (observation.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        const response = (value ?? {}) as { result?: unknown; error?: unknown };
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
  toCassette(manifest: CassetteManifest): Cassette {
    return {
      version: 2,
      manifest,
      frames: [...this.#frames],
    };
  }
}

function decodeStoredObservation(observation: TransportStorageFrame): unknown {
  const [data, ...stores] = observation.parts;
  if (data === undefined) throw new Error('fino:sim — observed frame has no payload');
  return (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
    data,
    stores.length === 0 ? undefined : stores,
  );
}

interface PendingCall {
  seq: number;
  specifier: string;
  method: string;
  kind: SimCallKind;
  args: unknown[];
  chunks: unknown[];
}

function isFacadeFrame(metadata: TransportFrameMetadata): boolean {
  return isFacadeFrameKind(metadata.kind);
}

/** Whether an envelope kind belongs to facade or handle RPC. @internal */
export function isFacadeFrameKind(kind: number): boolean {
  return (
    kind === EnvelopeKind.RpcRequest ||
    kind === EnvelopeKind.RpcStreamRequest ||
    kind === EnvelopeKind.RpcResponse ||
    kind === EnvelopeKind.RpcChunk ||
    kind === EnvelopeKind.RpcEnd ||
    kind === EnvelopeKind.RpcError ||
    kind === EnvelopeKind.SinkStart ||
    kind === EnvelopeKind.SinkChunk ||
    kind === EnvelopeKind.SinkEnd ||
    kind === EnvelopeKind.SinkError
  );
}
