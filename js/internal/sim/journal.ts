/**
 * Project copied Realm RPC frames into journals and persistent cassettes.
 *
 * The live transport remains the sole owner of delivery. This module consumes
 * the independently owned serialized copies supplied by `observe()` and turns
 * the request, chunk, and terminal protocol frames into completed calls. A
 * recording retains those same copies and base64-encodes their bytes for JSON
 * persistence without serializing values again. Empty terminal payloads are
 * protocol signals only and are never exposed as data.
 *
 * @internal
 */
import { EnvelopeKind, type EnvelopeKindValue } from 'internal:realm/envelope';
import { deserialize } from 'internal:serializer';
import type {
  TransportFrame,
  TransportFrameDirection,
  TransportFrameMetadata,
  TransportObserver,
} from 'internal:realm/transport-port';

/** How a facade method crossed the Realm boundary. @internal */
export type SimCallKind = 'call' | 'stream' | 'sink';

/** One completed facade invocation. @internal */
export interface SimCall {
  /** Invocation order, starting at zero. */
  seq: number;
  specifier: string;
  method: string;
  kind: SimCallKind;
  /** Arguments copied before the parent handler can mutate them. */
  args: unknown[];
  outcome: 'ok' | 'error';
  /** Scalar or sink result. */
  result?: unknown;
  /** Read-stream or sink chunks in transport order. */
  chunks?: unknown[];
  error?: string;
}

/** JSON-safe storage form of one copied transport frame. @internal */
export interface CassetteFrame {
  direction: TransportFrameDirection;
  kind: EnvelopeKindValue;
  correlation: number;
  /** Base64 main payload followed by transferred backing stores. */
  parts: string[];
}

/** Versioned recording of Realm RPC traffic. @internal */
export interface Cassette {
  version: 1;
  frames: CassetteFrame[];
}

interface ObservableTransportPort {
  observe(observer: TransportObserver): () => void;
}

interface ReplayTransportPort extends ObservableTransportPort {
  _addControlHandler(
    handler: (
      envelope: { kind: EnvelopeKindValue; correlation: number },
      value: unknown,
    ) => boolean,
    options?: { first?: boolean },
  ): () => void;
  _postControl(kind: EnvelopeKindValue, correlation: number, value: unknown): void;
  _postSerializedControl(
    kind: EnvelopeKindValue,
    correlation: number,
    parts: readonly Uint8Array[],
  ): void;
}

interface PendingCall {
  seq: number;
  specifier: string;
  method: string;
  kind: SimCallKind;
  args: unknown[];
  chunks: unknown[];
}

const RPC_KINDS = new Set<EnvelopeKindValue>([
  EnvelopeKind.RpcRequest,
  EnvelopeKind.RpcStreamRequest,
  EnvelopeKind.RpcResponse,
  EnvelopeKind.RpcChunk,
  EnvelopeKind.RpcEnd,
  EnvelopeKind.RpcError,
  EnvelopeKind.SinkStart,
  EnvelopeKind.SinkChunk,
  EnvelopeKind.SinkEnd,
  EnvelopeKind.SinkError,
]);

function isObservablePort(value: unknown): value is ObservableTransportPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { observe?: unknown }).observe === 'function'
  );
}

function isReplayPort(value: unknown): value is ReplayTransportPort {
  return (
    isObservablePort(value) &&
    typeof (value as { _addControlHandler?: unknown })._addControlHandler === 'function' &&
    typeof (value as { _postControl?: unknown })._postControl === 'function' &&
    typeof (value as { _postSerializedControl?: unknown })._postSerializedControl === 'function'
  );
}

function isRpcFrame(metadata: TransportFrameMetadata): boolean {
  return RPC_KINDS.has(metadata.kind);
}

function frameValue(frame: TransportFrame): unknown {
  const primary = frame.parts[0];
  if (primary === undefined) return undefined;
  return deserialize(primary, frame.parts.slice(1));
}

function errorText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'error' in value) {
    return String((value as { error: unknown }).error);
  }
  return String(value);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isCanonicalBase64(text: string): boolean {
  return (
    text.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  );
}

function fromBase64(text: string): Uint8Array {
  if (!isCanonicalBase64(text)) {
    throw invalidCassette('frame parts must contain canonical base64');
  }
  const binary = atob(text);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function invalidCassette(reason: string): TypeError {
  return new TypeError(`Invalid simulation cassette: ${reason}`);
}

function parseCassette(value: unknown): Cassette {
  if (typeof value !== 'object' || value === null) {
    throw invalidCassette('expected an object');
  }
  const candidate = value as { version?: unknown; frames?: unknown };
  if (candidate.version !== 1) throw invalidCassette('version 1 is required');
  if (!Array.isArray(candidate.frames)) throw invalidCassette('frames must be an array');
  for (const [index, valueFrame] of candidate.frames.entries()) {
    if (typeof valueFrame !== 'object' || valueFrame === null) {
      throw invalidCassette(`frame ${index} must be an object`);
    }
    const frame = valueFrame as {
      direction?: unknown;
      kind?: unknown;
      correlation?: unknown;
      parts?: unknown;
    };
    if (frame.direction !== 'inbound' && frame.direction !== 'outbound') {
      throw invalidCassette(`frame ${index} has an invalid direction`);
    }
    if (typeof frame.kind !== 'number' || !RPC_KINDS.has(frame.kind as EnvelopeKindValue)) {
      throw invalidCassette(`frame ${index} has an invalid RPC kind`);
    }
    if (!Number.isSafeInteger(frame.correlation) || (frame.correlation as number) < 0) {
      throw invalidCassette(`frame ${index} has an invalid correlation`);
    }
    if (!Array.isArray(frame.parts) || frame.parts.length === 0) {
      throw invalidCassette(`frame ${index} must have serialized parts`);
    }
    for (const part of frame.parts) {
      if (typeof part !== 'string') {
        throw invalidCassette(`frame ${index} parts must be base64 strings`);
      }
      if (!isCanonicalBase64(part)) {
        throw invalidCassette(`frame ${index} parts must contain canonical base64`);
      }
    }
  }
  return candidate as Cassette;
}

/** Restore persisted frames to the runtime transport frame contract. @internal */
export function decodeCassette(value: unknown): TransportFrame[] {
  const cassette = parseCassette(value);
  return cassette.frames.map((frame, sequence) => {
    const parts = frame.parts.map(fromBase64);
    return {
      sequence,
      direction: frame.direction,
      kind: frame.kind,
      correlation: frame.correlation,
      payloadBytes: parts.reduce((sum, part) => sum + part.byteLength, 0),
      arrayBufferTransfers: parts.length - 1,
      portTransfers: 0,
      parts,
    };
  });
}

const REPLAY_INPUT_KINDS = new Set<EnvelopeKindValue>([
  EnvelopeKind.RpcRequest,
  EnvelopeKind.RpcStreamRequest,
  EnvelopeKind.SinkStart,
  EnvelopeKind.SinkChunk,
  EnvelopeKind.SinkEnd,
  EnvelopeKind.SinkError,
]);

function equalParts(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (part, index) =>
      part.byteLength === right[index]!.byteLength &&
      part.every((byte, offset) => byte === right[index]![offset]),
  );
}

function validateReplaySequence(frames: readonly TransportFrame[]): void {
  const requests = new Map<number, number>();
  const completed = new Set<number>();
  for (const [index, frame] of frames.entries()) {
    const startsRequest =
      frame.direction === 'inbound' &&
      (frame.kind === EnvelopeKind.RpcRequest ||
        frame.kind === EnvelopeKind.RpcStreamRequest ||
        frame.kind === EnvelopeKind.SinkStart);
    if (startsRequest) {
      if (requests.has(frame.correlation)) {
        throw invalidCassette(`frame ${index} reuses an active request correlation`);
      }
      requests.set(frame.correlation, index);
      continue;
    }
    if (!requests.has(frame.correlation)) {
      const traffic = frame.direction === 'outbound' ? 'output' : 'input';
      throw invalidCassette(`frame ${index} ${traffic} has no matching request`);
    }
    if (
      frame.direction === 'outbound' &&
      (frame.kind === EnvelopeKind.RpcResponse ||
        frame.kind === EnvelopeKind.RpcEnd ||
        frame.kind === EnvelopeKind.RpcError)
    ) {
      completed.add(frame.correlation);
    }
  }
  for (const [correlation, index] of requests) {
    if (!completed.has(correlation)) {
      throw invalidCassette(`incomplete request at frame ${index}`);
    }
  }
}

/** Serve recorded RPC frames over an ordinary Realm transport. @internal */
export class CassetteReplay {
  #frames: TransportFrame[];
  #position = 0;
  #recordedToLive = new Map<number, number>();
  #liveToRecorded = new Map<number, number>();
  #divergence: Error | null = null;
  #bound = false;

  constructor(cassette: unknown) {
    this.#frames = decodeCassette(cassette);
    validateReplaySequence(this.#frames);
  }

  /** Claim replayed RPC traffic before the live Facade dispatcher. */
  bind(port: unknown): () => void {
    if (!isReplayPort(port)) {
      throw new TypeError('CassetteReplay requires a replayable Realm transport port');
    }
    if (this.#bound) throw new TypeError('CassetteReplay is already bound');
    this.#bound = true;
    const stopObservation = port.observe({
      filter: (metadata) =>
        metadata.direction === 'inbound' && REPLAY_INPUT_KINDS.has(metadata.kind),
      next: (frame) => this.#accept(port, frame),
    });
    const stopControl = port._addControlHandler(
      (envelope) => REPLAY_INPUT_KINDS.has(envelope.kind),
      { first: true },
    );
    this.#drain(port);
    return () => {
      stopControl();
      stopObservation();
    };
  }

  /** Fail when replay diverged or the guest left recorded traffic unused. */
  assertComplete(): void {
    if (this.#divergence !== null) throw this.#divergence;
    if (this.#position === this.#frames.length) return;
    const frame = this.#frames[this.#position]!;
    throw new Error(
      `Simulation cassette diverged at frame ${this.#position}: the guest did not send recorded ${this.#describe(frame)}`,
    );
  }

  #accept(port: ReplayTransportPort, frame: TransportFrame): void {
    if (this.#divergence !== null) return;
    const expected = this.#frames[this.#position];
    if (expected === undefined) {
      this.#fail(port, frame, `the cassette ended before ${this.#describe(frame)}`);
      return;
    }
    if (expected.direction !== 'inbound') {
      this.#fail(port, frame, `the cassette expected ${this.#describe(expected)}`);
      return;
    }
    const recordedCorrelation = this.#liveToRecorded.get(frame.correlation);
    const liveCorrelation = this.#recordedToLive.get(expected.correlation);
    if (
      expected.kind !== frame.kind ||
      (recordedCorrelation !== undefined && recordedCorrelation !== expected.correlation) ||
      (liveCorrelation !== undefined && liveCorrelation !== frame.correlation) ||
      !equalParts(expected.parts, frame.parts)
    ) {
      this.#fail(
        port,
        frame,
        `expected ${this.#describe(expected)} but received ${this.#describe(frame)}`,
      );
      return;
    }
    this.#recordedToLive.set(expected.correlation, frame.correlation);
    this.#liveToRecorded.set(frame.correlation, expected.correlation);
    this.#position++;
    this.#drain(port);
  }

  #drain(port: ReplayTransportPort): void {
    while (this.#divergence === null) {
      const frame = this.#frames[this.#position];
      if (frame === undefined || frame.direction !== 'outbound') return;
      const liveCorrelation = this.#recordedToLive.get(frame.correlation);
      if (liveCorrelation === undefined) {
        this.#divergence = new Error(
          `Simulation cassette diverged at frame ${this.#position}: recorded output has no matching request`,
        );
        return;
      }
      port._postSerializedControl(frame.kind, liveCorrelation, frame.parts);
      this.#position++;
    }
  }

  #fail(port: ReplayTransportPort, frame: TransportFrame, reason: string): void {
    this.#divergence = new Error(
      `Simulation cassette diverged at frame ${this.#position}: ${reason}`,
    );
    const kind =
      frame.kind === EnvelopeKind.RpcStreamRequest
        ? EnvelopeKind.RpcError
        : EnvelopeKind.RpcResponse;
    port._postControl(kind, frame.correlation, { error: this.#divergence.message });
  }

  #describe(frame: TransportFrame): string {
    if (
      frame.kind === EnvelopeKind.RpcRequest ||
      frame.kind === EnvelopeKind.RpcStreamRequest ||
      frame.kind === EnvelopeKind.SinkStart
    ) {
      const request = frameValue(frame) as { specifier?: unknown; method?: unknown } | undefined;
      if (typeof request?.specifier === 'string' && typeof request.method === 'string') {
        return `${request.specifier}.${request.method}`;
      }
    }
    return `RPC kind ${frame.kind}`;
  }
}

/** Ordered record projected from a live Realm transport. @internal */
export class SimJournal {
  #entries: SimCall[] = [];
  #frames: TransportFrame[] = [];
  #recordingError: TypeError | null = null;
  #nextSequence = 0;

  get entries(): readonly SimCall[] {
    return this.#entries;
  }

  /**
   * Observe copied frames from a transport-backed Realm port.
   *
   * Detaching drops incomplete calls owned by this observation, releasing
   * their copied arguments and chunks. Calls completed before detachment stay
   * in the journal.
   */
  observe(port: unknown): () => void {
    return this.#attach(port, false);
  }

  /** Observe and retain exact copied RPC frames for cassette encoding. */
  record(port: unknown): () => void {
    return this.#attach(port, true);
  }

  /** Encode retained frame bytes without serializing their values again. */
  toCassette(): Cassette {
    if (this.#recordingError !== null) throw this.#recordingError;
    return {
      version: 1,
      frames: this.#frames.map((frame) => ({
        direction: frame.direction,
        kind: frame.kind,
        correlation: frame.correlation,
        parts: frame.parts.map(toBase64),
      })),
    };
  }

  #attach(port: unknown, recordFrames: boolean): () => void {
    if (!isObservablePort(port)) {
      throw new TypeError('SimJournal requires an observable Realm transport port');
    }
    const pending = new Map<number, PendingCall>();
    const detach = port.observe({
      filter: isRpcFrame,
      next: (frame) => {
        if (recordFrames) {
          if (frame.portTransfers > 0) {
            this.#recordingError ??= new TypeError(
              'MessagePort transfers cannot be persisted in a simulation cassette',
            );
          } else {
            this.#frames.push(frame);
          }
        }
        this.#project(frame, pending);
      },
    });
    return () => {
      detach();
      pending.clear();
    };
  }

  /** Completed calls matching an optional facade specifier and method. */
  calls(specifier?: string, method?: string): SimCall[] {
    return this.#entries.filter(
      (entry) =>
        (specifier === undefined || entry.specifier === specifier) &&
        (method === undefined || entry.method === method),
    );
  }

  #project(frame: TransportFrame, pending: Map<number, PendingCall>): void {
    const correlation = frame.correlation;
    switch (frame.kind) {
      case EnvelopeKind.RpcRequest:
      case EnvelopeKind.RpcStreamRequest:
      case EnvelopeKind.SinkStart: {
        if (frame.direction !== 'inbound') return;
        const request = frameValue(frame) as
          | { specifier?: unknown; method?: unknown; args?: unknown }
          | undefined;
        if (
          typeof request?.specifier !== 'string' ||
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
            frame.kind === EnvelopeKind.SinkStart
              ? 'sink'
              : frame.kind === EnvelopeKind.RpcStreamRequest
                ? 'stream'
                : 'call',
          args: request.args,
          chunks: [],
        });
        return;
      }
      case EnvelopeKind.SinkChunk:
        if (frame.direction === 'inbound') pending.get(correlation)?.chunks.push(frameValue(frame));
        return;
      case EnvelopeKind.SinkError: {
        if (frame.direction !== 'inbound') return;
        const call = pending.get(correlation);
        if (call !== undefined) {
          this.#finish(pending, correlation, call, {
            outcome: 'error',
            error: errorText(frameValue(frame)),
          });
        }
        return;
      }
      case EnvelopeKind.RpcChunk: {
        if (frame.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call !== undefined) call.chunks.push(frameValue(frame));
        return;
      }
      case EnvelopeKind.RpcEnd: {
        if (frame.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call !== undefined) this.#finish(pending, correlation, call, { outcome: 'ok' });
        return;
      }
      case EnvelopeKind.RpcError: {
        if (frame.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call !== undefined) {
          this.#finish(pending, correlation, call, {
            outcome: 'error',
            error: errorText(frameValue(frame)),
          });
        }
        return;
      }
      case EnvelopeKind.RpcResponse: {
        if (frame.direction !== 'outbound') return;
        const call = pending.get(correlation);
        if (call === undefined) return;
        const response = frameValue(frame) as { result?: unknown; error?: unknown } | undefined;
        this.#finish(
          pending,
          correlation,
          call,
          response?.error === undefined
            ? { outcome: 'ok', result: response?.result }
            : { outcome: 'error', error: String(response.error) },
        );
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
    this.#entries.push({
      seq: call.seq,
      specifier: call.specifier,
      method: call.method,
      kind: call.kind,
      args: call.args,
      outcome: completion.outcome,
      ...(call.kind === 'call' ? {} : { chunks: call.chunks }),
      ...('result' in completion ? { result: completion.result } : {}),
      ...('error' in completion ? { error: completion.error } : {}),
    });
    this.#entries.sort((left, right) => left.seq - right.seq);
  }
}
