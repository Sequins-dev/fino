/**
 * Project copied Realm RPC frames into an ordered simulation journal.
 *
 * The live transport remains the sole owner of delivery. This module consumes
 * the independently owned serialized copies supplied by `observe()` and turns
 * the request, chunk, and terminal protocol frames into completed calls. Empty
 * terminal payloads are protocol signals only and are never exposed as data.
 *
 * @internal
 */
import { EnvelopeKind, type EnvelopeKindValue } from 'internal:realm/envelope';
import { deserialize } from 'internal:serializer';
import type {
  TransportFrame,
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

interface ObservableTransportPort {
  observe(observer: TransportObserver): () => void;
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
  EnvelopeKind.SinkError,
]);

function isObservablePort(value: unknown): value is ObservableTransportPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { observe?: unknown }).observe === 'function'
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

/** Ordered record projected from a live Realm transport. @internal */
export class SimJournal {
  #entries: SimCall[] = [];
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
    if (!isObservablePort(port)) {
      throw new TypeError('SimJournal requires an observable Realm transport port');
    }
    const pending = new Map<number, PendingCall>();
    const detach = port.observe({
      filter: isRpcFrame,
      next: (frame) => this.#project(frame, pending),
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
