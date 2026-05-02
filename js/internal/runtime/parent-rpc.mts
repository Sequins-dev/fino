/**
 * internal:parent-rpc — RPC channel from a child Realm to its parent's Facade handlers.
 *
 * When a facade proxy module calls `call(specifier, method, args)`, this module:
 *   1. Allocates a request id and stores a Promise resolver in `_pending`.
 *   2. Serialises `{__rpc_req, specifier, method, reqId, args}` and sends it to
 *      the parent via the realm's native channel (nativeSend).
 *   3. Returns the Promise.
 *
 * When the parent sends back `{__rpc_res, reqId, result|error}`, the port drain
 * function in messaging.mts calls `resolveRpc` or `rejectRpc` here to settle the
 * pending Promise.
 *
 * Streaming calls use `callStream(specifier, method, args)` which returns an
 * `AsyncIterable<unknown>` directly.  The parent sends `__rpc_chunk` / `__rpc_end` /
 * `__rpc_err` envelopes instead of a single `__rpc_res`; messaging.mts routes
 * those to `pushChunk` / `endStream` / `errStream` below.
 *
 * Only available in thread and process child Realms (where `nativeSend` has a live
 * channel_tx). Embedded child Realms are not a primary facade target.
 */

import { nativeSend } from 'internal:thread-port';
import { serialize } from 'internal:serializer';

// ---------------------------------------------------------------------------
// Transport selection
//
// For thread and process child realms, `globalThis.realmPort` is a ThreadPort
// whose `.postMessage()` routes through the Rust native channel (same as
// calling nativeSend directly).  For embedded realms it is a MessagePort
// backed by an in-process IntraPort queue.  Using `.postMessage()` uniformly
// means parent-rpc works for all realm kinds without special-casing.
//
// Fallback: if realmPort is not set yet (shouldn't happen in normal operation),
// we call nativeSend directly so thread/process realms always work.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pending scalar call registry
// ---------------------------------------------------------------------------

let _nextId = 0;
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

// ---------------------------------------------------------------------------
// Pending stream registry
// ---------------------------------------------------------------------------

/** Simple async queue used to buffer chunks until the consumer iterates. */
class _StreamQueue {
  #queue: unknown[] = [];
  #waiters: Array<() => void> = [];
  #done = false;
  #error: string | null = null;

  push(chunk: unknown): void {
    this.#queue.push(chunk);
    this.#waiters.shift()?.();
  }

  end(): void {
    this.#done = true;
    const ws = this.#waiters.splice(0);
    for (const w of ws) w();
  }

  fail(msg: string): void {
    this.#error = msg;
    this.#done = true;
    const ws = this.#waiters.splice(0);
    for (const w of ws) w();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<unknown>> {
        while (self.#queue.length === 0 && !self.#done) {
          await new Promise<void>(resolve => self.#waiters.push(resolve));
        }
        if (self.#queue.length > 0) {
          return { value: self.#queue.shift()!, done: false };
        }
        if (self.#error !== null) throw new Error(self.#error);
        return { value: undefined as unknown, done: true };
      },
    };
  }
}

const _pendingStreams = new Map<number, _StreamQueue>();

// ---------------------------------------------------------------------------
// Lazy locals (avoid import-time side-effects)
// ---------------------------------------------------------------------------

const _ser  = serialize;
const _send = nativeSend;

// ---------------------------------------------------------------------------
// Internal send helper
// ---------------------------------------------------------------------------

function _sendMsg(msg: unknown): void {
  // Prefer the realm port (works for all realm types including embedded).
  const port = (globalThis as Record<string, unknown>).realmPort as
    { postMessage(m: unknown): void } | undefined;
  if (port) {
    port.postMessage(msg);
    return;
  }
  // Fallback: direct native send for thread/process realms before realmPort is set.
  const bytes = (_ser as (v: unknown) => Uint8Array[])(msg)[0]!;
  (_send as (b: Uint8Array, s: Uint8Array[], p: unknown[]) => void)(bytes, [], []);
}

// ---------------------------------------------------------------------------
// Public API — scalar calls
// ---------------------------------------------------------------------------

/**
 * Make an RPC call to the parent's registered Facade handler.
 * Returns a Promise that settles when the parent sends back `__rpc_res`.
 */
export function call(specifier: string, method: string, args: unknown[]): Promise<unknown> {
  const reqId = _nextId++;
  return new Promise<unknown>((resolve, reject) => {
    _pending.set(reqId, { resolve, reject });
    _sendMsg({ __rpc_req: true, specifier, method, reqId, args });
  });
}

/**
 * Settle a pending scalar call with a successful result.
 * Called by `ThreadPort._drain()` / `ProcessPort._drain()` on `__rpc_res`.
 * Returns true if the reqId was found (false = it belonged to a stream).
 *
 * When `result` carries `{ __handle: id, streams?: [...] }`, the pending
 * promise is resolved with a Proxy that routes further method calls back
 * through parent-rpc using the handle ID as the specifier.
 */
export function resolveRpc(reqId: number, result: unknown): boolean {
  const entry = _pending.get(reqId);
  if (entry) {
    _pending.delete(reqId);
    // Auto-wrap handle results in a transparent method proxy.
    if (result !== null && typeof result === 'object' &&
        typeof (result as { __handle?: unknown }).__handle === 'string') {
      const h = result as { __handle: string; streams?: string[]; sinks?: string[] };
      entry.resolve(_makeHandleProxy(h.__handle, h.streams ?? [], h.sinks ?? []));
    } else {
      entry.resolve(result);
    }
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
  const sinkSet   = new Set(sinks);
  return new Proxy(Object.create(null) as object, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== 'string') return undefined;
      if (streamSet.has(prop)) return (...args: unknown[]) => callStream(handleId, prop, args);
      if (sinkSet.has(prop))   return (...args: unknown[]) => callSink(handleId, prop, args);
      return (...args: unknown[]) => call(handleId, prop, args);
    },
  });
}

/**
 * Settle a pending scalar call with an error.
 * Returns true if the reqId was found; false means try errStream() instead.
 */
export function rejectRpc(reqId: number, error: string): boolean {
  const entry = _pending.get(reqId);
  if (entry) {
    _pending.delete(reqId);
    entry.reject(new Error(error));
    return true;
  }
  // Fall through: error may belong to a write-stream (sink).
  return rejectSink(reqId, error);
}

// ---------------------------------------------------------------------------
// Public API — streaming calls
// ---------------------------------------------------------------------------

/**
 * Make a streaming RPC call. Returns an AsyncIterable that yields chunks as
 * the parent sends `__rpc_chunk` envelopes, and completes on `__rpc_end`.
 * The parent sends `__rpc_err` (or `__rpc_res` with error) on failure.
 */
export function callStream(specifier: string, method: string, args: unknown[]): AsyncIterable<unknown> {
  const reqId = _nextId++;
  const q = new _StreamQueue();
  _pendingStreams.set(reqId, q);
  _sendMsg({ __rpc_req: true, specifier, method, reqId, args });
  return q;
}

/**
 * Deliver a chunk to a pending streaming call.
 * Called by the drain path in messaging.mts on `__rpc_chunk`.
 */
export function pushChunk(reqId: number, chunk: unknown): void {
  _pendingStreams.get(reqId)?.push(chunk);
}

/**
 * Signal end-of-stream for a pending streaming call.
 * Called by the drain path in messaging.mts on `__rpc_end`.
 */
export function endStream(reqId: number): void {
  const q = _pendingStreams.get(reqId);
  if (!q) return;
  _pendingStreams.delete(reqId);
  q.end();
}

/**
 * Signal an error on a pending streaming call.
 * Called by the drain path on `__rpc_err` OR on `__rpc_res` with an error
 * when the reqId belongs to a stream (handler threw before yielding).
 */
export function errStream(reqId: number, error: string): void {
  const q = _pendingStreams.get(reqId);
  if (!q) return;
  _pendingStreams.delete(reqId);
  q.fail(error);
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
 * `write()` and `close()` are synchronous fire-and-forget — no round-trip per
 * chunk.  `result` is a Promise that settles when the parent's handler returns.
 */
export class WriteSink {
  readonly result: Promise<unknown>;
  readonly #reqId: number;
  #resolve!: (v: unknown) => void;
  #reject!:  (e: Error) => void;

  /** @internal */
  constructor(reqId: number) {
    this.#reqId = reqId;
    this.result = new Promise<unknown>((res, rej) => {
      this.#resolve = res;
      this.#reject  = rej;
    });
  }

  /** Push a chunk to the parent — no await, no backpressure acknowledgement. */
  write(chunk: unknown): void {
    _sendMsg({ __rpc_send_chunk: true, reqId: this.#reqId, chunk });
  }

  /** Signal end-of-stream (FIN). */
  close(): void {
    _sendMsg({ __rpc_send_end: true, reqId: this.#reqId });
  }

  /** Abort the stream with an error (RESET_STREAM). */
  abort(error: string): void {
    _sendMsg({ __rpc_send_err: true, reqId: this.#reqId, error });
  }

  /** @internal */ _resolve(v: unknown) { this.#resolve(v); }
  /** @internal */ _reject(e: string)   { this.#reject(new Error(e)); }
}

const _pendingSinks = new Map<number, WriteSink>();

/**
 * Open a write stream to the parent.  Returns a `WriteSink` immediately;
 * chunks written to it flow child→parent without a round-trip per chunk.
 * The parent handler receives `(args, source: AsyncIterable<unknown>)`.
 */
export function callSink(specifier: string, method: string, args: unknown[]): WriteSink {
  const reqId = _nextId++;
  const sink = new WriteSink(reqId);
  _pendingSinks.set(reqId, sink);
  _sendMsg({ __rpc_send_start: true, specifier, method, reqId, args });
  return sink;
}

/** @internal — settle a sink's result promise on `__rpc_res`. */
export function resolveSink(reqId: number, result: unknown): boolean {
  const sink = _pendingSinks.get(reqId);
  if (!sink) return false;
  _pendingSinks.delete(reqId);
  sink._resolve(result);
  return true;
}

/** @internal — reject a sink's result promise on `__rpc_res` with error. */
export function rejectSink(reqId: number, error: string): boolean {
  const sink = _pendingSinks.get(reqId);
  if (!sink) return false;
  _pendingSinks.delete(reqId);
  sink._reject(error);
  return true;
}
