/**
 * internal:parent-rpc — RPC channel from a child Realm to its parent's Facade handlers.
 *
 * When a facade proxy module calls `call(specifier, method, args)`, this module:
 *   1. Allocates a request id and stores a Promise resolver in `_pending`.
 *   2. Sends the request through the child realm's shared session port.
 *   3. Returns the Promise.
 *
 * When the parent sends back `{__rpc_res, reqId, result|error}`, the port drain
 * loop in `internal:realm/transport-port` calls `resolveRpc` or `rejectRpc` here
 * to settle the pending Promise.
 *
 * Streaming calls use `callStream(specifier, method, args)` which returns an
 * `AsyncIterable<unknown>` directly.  The parent sends `__rpc_chunk` / `__rpc_end` /
 * `__rpc_err` envelopes instead of a single `__rpc_res`; the transport-port drain
 * routes those to `pushChunk` / `endStream` / `errStream` below.
 *
 * Write-streams (`callSink`) run in the opposite direction: the child pushes
 * chunks to the parent through a `WriteSink` handle, and the parent's terminal
 * result settles the sink via `resolveSink` / `rejectSink`.
 *
 * This module keeps all pending state in module-level registries, so a child
 * Realm has exactly one shared RPC channel to its parent. Request ids are
 * allocated from a single monotonic counter across scalar, stream, and sink
 * calls, which lets one drain path disambiguate a response by its id.
 *
 * This is an internal transport primitive; application code should use the
 * `fino:realm` Facade proxy modules, which build on top of it.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const result = await rpc.call('facade:kv', 'get', ['users:42']);
 *
 * for await (const chunk of rpc.callStream('facade:kv', 'scan', ['users:'])) {
 *   console.log(chunk);
 * }
 *
 * console.log(result);
 * ```
 *
 * @internal
 */
import { EnvelopeKind } from 'internal:realm/envelope';
import { UnboundedChannel } from 'internal:stream';
// ---------------------------------------------------------------------------
// Pending scalar call registry
// ---------------------------------------------------------------------------
let _nextId = 0;
let _realmPort:
  | {
      _postControl(kind: number, correlation: number, message: unknown): void;
    }
  | undefined;
const _pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }
>();
// ---------------------------------------------------------------------------
// Pending stream registry
// ---------------------------------------------------------------------------
const _pendingStreams = new Map<number, UnboundedChannel<unknown>>();
// ---------------------------------------------------------------------------
// Internal send helper
// ---------------------------------------------------------------------------
/**
 * Send an RPC request to the parent under its envelope kind.
 *
 * The request id rides in the header rather than the payload, so the receiving
 * side classifies and correlates the frame without trusting anything the
 * payload claims about itself.
 */
/** Install the bootstrap-owned session endpoint used by every facade proxy. @internal */
export function _installRealmPort(port: typeof _realmPort): void {
  _realmPort = port;
}

function _sendControl(kind: number, reqId: number, payload: unknown): void {
  if (_realmPort === undefined) {
    throw new Error('Facade RPC requires a realm session port');
  }
  _realmPort._postControl(kind, reqId, payload);
}
let _responseDelay: (() => Promise<void>) | null = null;
/**
 * Hold every settled response for a delay before delivering it.
 *
 * A simulation uses this to give facade calls virtual latency. The delay is
 * applied here, in the child, rather than by the parent, because only the child
 * owns the virtual clock — a parent-side wait would be real seconds, and would
 * stall the very clock it was trying to advance.
 *
 * Pass `null` to deliver responses as soon as they arrive.
 *
 * @internal
 */
export function _installResponseDelay(delay: (() => Promise<void>) | null): void {
  _responseDelay = delay;
}
/**
 * Run `settle` now, or after the installed delay.
 *
 * Callers must already have removed the request from its pending registry, so
 * that the call no longer counts as outstanding: a simulated realm refuses to
 * advance virtual time while it is waiting on the parent, and the delay itself
 * is measured in that same virtual time.
 */
function _afterResponseDelay(settle: () => void): void {
  if (_responseDelay === null) {
    settle();
    return;
  }
  void _responseDelay().then(settle, settle);
}
/**
 * Per-stream delivery chains, so delayed chunks cannot reorder.
 *
 * Each chunk draws and schedules its latency after the preceding frame is
 * delivered. This makes virtual deadlines independent of how the host batches
 * transport arrivals, while preserving chunk order and keeping end-of-stream
 * behind every chunk.
 */
const _streamDelays = new Map<number, Promise<void>>();
function _afterStreamDelay(reqId: number, drawDelay: boolean, deliver: () => void): void {
  if (_responseDelay === null) {
    deliver();
    return;
  }
  const responseDelay = _responseDelay;
  const prev = _streamDelays.get(reqId) ?? Promise.resolve();
  const next = prev.then(() => (drawDelay ? responseDelay() : undefined)).then(deliver, deliver);
  _streamDelays.set(reqId, next);
}
/**
 * Number of request/response calls still awaiting the parent.
 *
 * Counts scalar calls and sinks, whose answers are due back promptly. Read
 * streams are deliberately excluded: a subscription stays open for as long as
 * the guest iterates it, so counting one would stall a simulated realm's clock
 * forever rather than merely holding it while a reply is in flight.
 *
 * ```typescript no_run
 * import { outstandingCalls } from 'internal:parent-rpc';
 *
 * if (outstandingCalls() === 0) console.log('nothing in flight');
 * ```
 *
 * @internal
 */
export function outstandingCalls(): number {
  return _pending.size + _pendingSinks.size;
}
// ---------------------------------------------------------------------------
// Public API — scalar calls
// ---------------------------------------------------------------------------
/**
 * Make an RPC call to the parent's registered Facade handler.
 * Returns a Promise that settles when the parent sends back `__rpc_res`.
 *
 * Rejections are wrapped as `Error` objects by `rejectRpc`. When the parent's
 * handler returns an opaque handle (a `{ __handle }` object), the result is
 * automatically wrapped in a method proxy whose property accesses dispatch
 * further calls back through this module (see `resolveRpc`).
 *
 * The returned Promise never resolves on its own; it only settles once the
 * transport-port drain delivers the matching `__rpc_res` for this request id, so
 * a call outlives the turn in which it was made.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const value = await rpc.call('facade:kv', 'get', ['users:42']);
 * console.log(value);
 * ```
 */
export function call(specifier: string, method: string, args: unknown[]): Promise<unknown> {
  const reqId = _nextId++;
  return new Promise<unknown>((resolve, reject) => {
    _pending.set(reqId, {
      resolve,
      reject,
    });
    _sendControl(EnvelopeKind.RpcRequest, reqId, { specifier, method, args });
  });
}
/**
 * Settle a pending scalar call with a successful result.
 *
 * Called by the transport-port drain loop on an incoming `__rpc_res` envelope.
 * Returns `true` if the request id matched a pending scalar call; `false` means
 * the id was not a scalar call, in which case it is forwarded to `resolveSink`
 * (the id may belong to a write-stream whose handler has just returned).
 *
 * When `result` carries `{ __handle: id, streams?: [...], sinks?: [...] }`, the
 * pending promise resolves with a Proxy instead of the raw object: reading a
 * property named in `streams` yields a function that calls `callStream`, one in
 * `sinks` yields a function that calls `callSink`, and any other property yields
 * a function that calls `call` — all using the handle id as the specifier. This
 * is what makes a remote handle behave like a local object.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * // Invoked by the drain path, not usually by application code.
 * const handled = rpc.resolveRpc(1, { ok: true });
 * if (!handled) console.log('reqId 1 was not a pending scalar call');
 * ```
 */
export function resolveRpc(reqId: number, result: unknown): boolean {
  const entry = _pending.get(reqId);
  if (entry) {
    _pending.delete(reqId);
    _afterResponseDelay(() => {
      // Auto-wrap handle results in a transparent method proxy.
      if (
        result !== null &&
        typeof result === 'object' &&
        typeof (
          result as {
            __handle?: unknown;
          }
        ).__handle === 'string'
      ) {
        const h = result as {
          __handle: string;
          streams?: string[];
          sinks?: string[];
        };
        entry.resolve(_makeHandleProxy(h.__handle, h.streams ?? [], h.sinks ?? []));
      } else {
        entry.resolve(result);
      }
    });
    return true;
  }
  // Fall through: the __rpc_res may be the final result of a write-stream (sink).
  return resolveSink(reqId, result);
}
/**
 * Create a Proxy for a handle returned from a Facade handler.
 *
 * Any property access on the proxy returns a function that dispatches
 * through parent-rpc using the handle ID as the specifier.  Methods listed
 * in `streams` call `callStream()`; all others call `call()`.
 */
function _makeHandleProxy(handleId: string, streams: string[], sinks: string[]): object {
  const streamSet = new Set(streams);
  const sinkSet = new Set(sinks);
  return new Proxy(Object.create(null) as object, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      // Prevent the proxy from appearing thenable — if 'then' returns a function,
      // V8 treats the object as a Promise and calls .then(), causing infinite chains.
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (streamSet.has(prop)) return (...args: unknown[]) => callStream(handleId, prop, args);
      if (sinkSet.has(prop)) return (...args: unknown[]) => callSink(handleId, prop, args);
      return (...args: unknown[]) => call(handleId, prop, args);
    },
  });
}
/**
 * Settle a pending scalar call with an error.
 *
 * The `error` string is wrapped in a fresh `Error` and used to reject the
 * pending promise. Returns `true` if the request id matched a pending scalar
 * call; `false` means the id was not a scalar call, and the caller should try
 * `errStream` (for a read-stream) or `rejectSink` (for a write-stream) next.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * if (!rpc.rejectRpc(1, 'handler failed')) {
 *   rpc.errStream(1, 'handler failed');
 * }
 * ```
 */
export function rejectRpc(reqId: number, error: string): boolean {
  const entry = _pending.get(reqId);
  if (entry) {
    _pending.delete(reqId);
    _afterResponseDelay(() => entry.reject(new Error(error)));
    return true;
  }
  // Fall through: error may belong to a write-stream (sink).
  return rejectSink(reqId, error);
}
// ---------------------------------------------------------------------------
// Public API — streaming calls
// ---------------------------------------------------------------------------
/**
 * Make a streaming (parent-to-child) RPC call.
 *
 * Returns an `AsyncIterable` immediately, before any chunk has arrived. The
 * returned queue buffers `__rpc_chunk` payloads delivered by the drain path and
 * the consumer pulls them with `for await`. The iterator completes when the
 * parent sends `__rpc_end`, and throws when it sends `__rpc_err` (or an
 * `__rpc_res` carrying an error, which is routed here when the handler threw
 * before yielding). Chunks that arrive before the consumer starts iterating are
 * held in the buffer rather than dropped.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * for await (const row of rpc.callStream('facade:kv', 'scan', ['users:'])) {
 *   console.log(row);
 * }
 * ```
 */
export function callStream(
  specifier: string,
  method: string,
  args: unknown[],
): AsyncIterable<unknown> {
  const reqId = _nextId++;
  const channel = new UnboundedChannel<unknown>();
  _pendingStreams.set(reqId, channel);
  _sendControl(EnvelopeKind.RpcStreamRequest, reqId, { specifier, method, args });
  return channel.reader;
}
/**
 * Deliver a chunk to a pending streaming call.
 *
 * Called by the transport-port drain loop on an `__rpc_chunk` envelope. The
 * chunk is appended to the stream's buffer and wakes any consumer currently
 * awaiting the next value. Request ids with no live stream are ignored, so a
 * late chunk that arrives after `endStream` or `errStream` is a harmless no-op.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * rpc.pushChunk(1, new Uint8Array([1, 2, 3]));
 * ```
 */
export function pushChunk(reqId: number, chunk: unknown): void {
  const channel = _pendingStreams.get(reqId);
  if (channel === undefined) return;
  _afterStreamDelay(reqId, true, () => void channel.writer.write(chunk));
}
/**
 * Signal end-of-stream for a pending streaming call.
 *
 * Called by the transport-port drain loop on an `__rpc_end` envelope. The stream
 * is removed from the pending registry and its consumer's `for await` loop
 * completes normally after draining any buffered chunks. Unknown request ids are
 * ignored.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * rpc.endStream(1);
 * ```
 */
export function endStream(reqId: number): void {
  const channel = _pendingStreams.get(reqId);
  if (channel === undefined) return;
  _pendingStreams.delete(reqId);
  // End-of-stream draws no latency of its own — it is the FIN riding behind
  // the last chunk — but it must still queue behind the chunks in flight.
  _afterStreamDelay(reqId, false, () => {
    _streamDelays.delete(reqId);
    void channel.writer.close();
  });
}
/**
 * Signal an error on a pending streaming call.
 *
 * Called by the transport-port drain loop on an `__rpc_err` envelope, or on an
 * `__rpc_res` carrying an error when the request id turns out to belong to a
 * stream (the handler threw before yielding its first chunk). The stream is
 * removed from the registry and the consumer's next `for await` step throws an
 * `Error` built from `error`. Unknown request ids are ignored.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * rpc.errStream(1, 'stream failed');
 * ```
 */
export function errStream(reqId: number, error: string): void {
  const channel = _pendingStreams.get(reqId);
  if (channel === undefined) return;
  _pendingStreams.delete(reqId);
  _afterStreamDelay(reqId, false, () => {
    _streamDelays.delete(reqId);
    void channel.writer.close(new Error(error));
  });
}
// ---------------------------------------------------------------------------
// Public API — write-stream (sink) calls  [QUIC: client-initiated unidirectional stream]
//
// `callSink` is the symmetric counterpart to `callStream`:
//
//   callStream  — parent pushes chunks to child   (QUIC: server-initiated stream)
//   callSink    — child pushes chunks to parent   (QUIC: client-initiated stream)
//
// Wire protocol maps onto QUIC framing:
//   __rpc_send_start  →  OPEN_STREAM + metadata
//   __rpc_send_chunk  →  stream DATA frame (no per-chunk ack)
//   __rpc_send_end    →  FIN
//   __rpc_send_err    →  RESET_STREAM
//   __rpc_res         →  response (on response stream / same bidi stream)
// ---------------------------------------------------------------------------
/**
 * A write-stream handle returned by `callSink`.
 *
 * A `WriteSink` lets a child push a sequence of chunks up to a parent handler
 * without a round-trip per chunk. `write()`, `close()`, and `abort()` are
 * synchronous fire-and-forget: each just enqueues a wire envelope. The only
 * asynchronous signal is `result`, a Promise that settles once the parent's
 * handler finishes and its terminal response is routed back through
 * `resolveSink` / `rejectSink`.
 *
 * Because there is no per-chunk acknowledgement or backpressure, a sink is best
 * suited to bounded uploads where the parent consumes chunks as fast as they
 * arrive. Instances also implement `Symbol.dispose`, so a `using` binding closes
 * the stream when it leaves scope.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const sink = rpc.callSink('facade:blob', 'upload', ['avatar.png']);
 * sink.write(new Uint8Array([0x89, 0x50]));
 * sink.write(new Uint8Array([0x4e, 0x47]));
 * sink.close();
 * const stored = await sink.result;
 * console.log(stored);
 * ```
 *
 * @internal
 */
export class WriteSink {
  /**
   * Result returned by the parent sink handler.
   *
   * Resolves on `__rpc_res` and rejects on an error response.
   *
   * ```typescript no_run
   * const result = await sink.result;
   * ```
   */
  readonly result: Promise<unknown>;
  /**
   * The request id this sink was opened with.
   *
   * Every wire envelope the sink emits (`__rpc_send_chunk`, `__rpc_send_end`,
   * `__rpc_send_err`) carries this id so the parent can correlate the chunk
   * stream, and so the matching `resolveSink` / `rejectSink` finds this instance.
   *
   * @internal
   */
  readonly #reqId: number;
  /**
   * Resolver captured from the `result` promise's executor.
   *
   * Invoked by `_resolve` when the parent's terminal response arrives, settling
   * `result` with the handler's return value.
   *
   * @internal
   */
  #resolve!: (v: unknown) => void;
  /**
   * Rejecter captured from the `result` promise's executor.
   *
   * Invoked by `_reject` when the parent reports a failure, rejecting `result`
   * with an `Error` built from the reported message.
   *
   * @internal
   */
  #reject!: (e: Error) => void;
  /**
   * Create a sink bound to a request ID.
   *
   * Usually constructed by `callSink`, not by application code.
   *
   * ```typescript no_run
   * const sink = new WriteSink(1);
   * ```
   *
   * @internal
   */
  constructor(reqId: number) {
    this.#reqId = reqId;
    this.result = new Promise<unknown>((res, rej) => {
      this.#resolve = res;
      this.#reject = rej;
    });
  }
  /**
   * Push a chunk to the parent.
   *
   * This is fire-and-forget: there is no per-chunk acknowledgement or
   * backpressure signal. The final handler result is exposed through `result`.
   *
   * ```typescript no_run
   * sink.write('chunk');
   * ```
   */
  write(chunk: unknown): void {
    _sendControl(EnvelopeKind.SinkChunk, this.#reqId, chunk);
  }
  /**
   * Signal end-of-stream.
   *
   * After closing, no more chunks should be written. The parent may still send a
   * final result that settles `result`.
   *
   * ```typescript no_run
   * sink.close();
   * ```
   */
  close(): void {
    _sendControl(EnvelopeKind.SinkEnd, this.#reqId, null);
  }
  /**
   * Close the stream when a `using` binding leaves scope.
   *
   * This is an alias for `close()`, letting a sink participate in explicit
   * resource management. It does not abort: any chunks already written are still
   * delivered and the parent may still settle `result`.
   *
   * ```typescript no_run
   * import * as rpc from 'internal:parent-rpc';
   *
   * {
   *   using sink = rpc.callSink('facade:blob', 'upload', ['log.txt']);
   *   sink.write(new Uint8Array([0x68, 0x69]));
   * } // sink.close() runs here
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
  /**
   * Abort the stream with an error.
   *
   * Sends a reset-style envelope to the parent. The local `result` promise is
   * settled only when the parent response is routed back.
   *
   * ```typescript no_run
   * sink.abort(new Error('cancelled'));
   * ```
   */
  abort(error: Error): void {
    if (!(error instanceof Error)) throw new TypeError('sink abort requires an Error');
    _sendControl(EnvelopeKind.SinkError, this.#reqId, { error });
  }
  /**
   * Settle `result` with a value.
   *
   * Called only by `resolveSink` from the drain path; not part of the sink's
   * public surface.
   *
   * @internal
   */
  _resolve(v: unknown) {
    this.#resolve(v);
  }
  /**
   * Settle `result` with an `Error` built from `e`.
   *
   * Called only by `rejectSink` from the drain path; not part of the sink's
   * public surface.
   *
   * @internal
   */
  _reject(e: string) {
    this.#reject(new Error(e));
  }
}
const _pendingSinks = new Map<number, WriteSink>();
/**
 * Open a write stream to the parent.
 *
 * Returns a `WriteSink` immediately, having sent only the `__rpc_send_start`
 * envelope; subsequent chunks written to the sink flow child-to-parent without a
 * round-trip per chunk. On the parent side the handler is invoked as
 * `(args, source)` where `source` is an `AsyncIterable<unknown>` of the chunks
 * the child writes, and its return value settles `sink.result`.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const sink = rpc.callSink('facade:blob', 'upload', ['name']);
 * sink.write(new Uint8Array([1, 2, 3]));
 * sink.close();
 * await sink.result;
 * ```
 */
export function callSink(specifier: string, method: string, args: unknown[]): WriteSink {
  const reqId = _nextId++;
  const sink = new WriteSink(reqId);
  _pendingSinks.set(reqId, sink);
  _sendControl(EnvelopeKind.SinkStart, reqId, { specifier, method, args });
  return sink;
}
/**
 * Settle a sink's result promise with a successful value.
 *
 * Called from `resolveRpc` when an incoming `__rpc_res` did not match a pending
 * scalar call — the request id may instead belong to a write-stream whose
 * handler has just returned. Returns `false` when the id does not match a
 * pending sink either, so `resolveRpc` can report the response as unhandled.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const handled = rpc.resolveSink(1, { stored: true });
 * ```
 *
 * @internal
 */
export function resolveSink(reqId: number, result: unknown): boolean {
  const sink = _pendingSinks.get(reqId);
  if (!sink) return false;
  _pendingSinks.delete(reqId);
  _afterResponseDelay(() => sink._resolve(result));
  return true;
}
/**
 * Reject a sink's result promise with an error.
 *
 * Called from `rejectRpc` when an error response did not match a pending scalar
 * call. The `error` string is wrapped in a fresh `Error` and used to reject the
 * sink's `result`. Returns `false` when the id does not match a pending sink, so
 * `rejectRpc` can report the error as unhandled.
 *
 * ```typescript no_run
 * import * as rpc from 'internal:parent-rpc';
 *
 * const handled = rpc.rejectSink(1, 'upload rejected');
 * ```
 *
 * @internal
 */
export function rejectSink(reqId: number, error: string): boolean {
  const sink = _pendingSinks.get(reqId);
  if (!sink) return false;
  _pendingSinks.delete(reqId);
  _afterResponseDelay(() => sink._reject(error));
  return true;
}
