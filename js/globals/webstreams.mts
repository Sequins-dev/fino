/**
 * ReadableStream, WritableStream, TransformStream globals.
 *
 * WHATWG Streams specification: https://streams.spec.whatwg.org/
 *
 * ## Architecture
 *
 * Two internal representations per stream type allow an efficient fast path
 * for I/O-backed streams while remaining spec-compliant for user-defined
 * sources and sinks.
 *
 * ReadableStream (WeakMap `_rs`):
 *   - kind: 'iterable' — backed by an async iterable (Reader, generator, channel).
 *     No controller, no queue; reads delegate directly to the underlying iterator.
 *   - kind: 'source'   — backed by an UnderlyingSource with start/pull/cancel.
 *     Uses ReadableStreamDefaultController for default streams, or
 *     ReadableByteStreamController for type:'bytes' streams. Full HWM-driven
 *     pull algorithm, backpressure, BYOB support.
 *
 * WritableStream (WeakMap `_ws`):
 *   - kind: 'writer' — backed by a Fino Writer (write/close). Writes delegate
 *     directly through; no controller overhead.
 *   - kind: 'sink'   — backed by an UnderlyingSink with start/write/close/abort.
 *     Full serialized write queue, HWM-based backpressure, ready promise.
 *
 * ## Short-circuit piping
 *
 * ReadableStream.pipeTo(WritableStream) inspects internal kinds:
 *   iterable + writer → iterates source directly, writes via Writer —
 *                       equivalent to Writer.pipe(asyncIterable), zero overhead
 *   otherwise         → spec-compliant reader.read() / writer.write() pump
 *
 * ## Structured clone and transfer
 *
 * Streams are not structured-cloneable or transferable in this runtime. Passing
 * a stream to `structuredClone()` throws, and transfer lists are limited to
 * ArrayBuffer values. BYOB reads reject views whose backing buffer has become
 * unusable through the runtime's best-effort transfer limitations.
 *
 * ## Exports
 *
 * ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController
 * ReadableStreamBYOBReader, ReadableStreamBYOBRequest, ReadableByteStreamController
 * WritableStream, WritableStreamDefaultWriter, WritableStreamDefaultController
 * TransformStream, TransformStreamDefaultController
 * CountQueuingStrategy, ByteLengthQueuingStrategy
 *
 * ## Example
 *
 * ```typescript no_run
 * const stream = ReadableStream.from(['hello'])
 *   .pipeThrough(new TransformStream({
 *     transform(chunk, controller) {
 *       controller.enqueue(chunk.toUpperCase());
 *     },
 *   }));
 *
 * for await (const chunk of stream) console.log(chunk);
 * ```
 *
 */

import { Writer } from '../internal/stream.mts';
import { AbortController } from './abort.mts';

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface QueueEntry { value: any; size: number; }

interface PendingReadRequest {
  resolve: (r: { done: boolean; value: any }) => void;
  reject: (e: unknown) => void;
}

interface PendingWriteRequest {
  chunk: any;
  size: number;
  drain?: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface ReadableReaderState {
  rsState: ReadableStreamState;
  iter: AsyncIterator<any> | null;
  closedResolve: (() => void) | undefined;
  closedReject: ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
}

interface ByobReaderState {
  rsState: ReadableStreamState;
  closedResolve: (() => void) | undefined;
  closedReject: ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
}

interface WritableWriterState {
  wsState: WritableStreamState;
  closedResolve: (() => void) | undefined;
  closedReject: ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
}

interface QueuingStrategyLike {
  highWaterMark?: number;
  size?: (chunk: any) => number;
}

interface PullIntoDescriptor {
  view: ArrayBufferView;
  bytesFilled: number;
  minFill: number;
  resolve: (result: { done: boolean; value: Uint8Array }) => void;
  reject: (e: unknown) => void;
  request: ReadableStreamBYOBRequest | null;
}

interface ReadableStreamState {
  kind: 'iterable' | 'source';
  state: 'readable' | 'closed' | 'errored';
  storedError: unknown;
  locked: boolean;
  disturbed: boolean;
  reader: ReadableStreamDefaultReader | ReadableStreamBYOBReader | null;
  closedResolve: (() => void) | undefined;
  closedReject:  ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
  errorWaiters?: Array<(e: unknown) => void>;
  // iterable-kind fields
  source?: AsyncIterable<any>;
  _iter?: AsyncIterator<any>;
  // source-kind fields
  underlyingSource?: any;
  queue?: QueueEntry[];
  queueTotalSize?: number;
  pendingReads?: PendingReadRequest[];
  pendingByob?: PullIntoDescriptor[];
  demandCallbacks?: Array<() => void>;
  pulling?: boolean;
  pullAgain?: boolean;
  started?: boolean;
  closeRequested?: boolean;
  highWaterMark?: number;
  sizeAlgorithm?: ((chunk: any) => number) | null;
  isByteStream?: boolean;
  autoAllocateChunkSize?: number;
  controller?: ReadableStreamDefaultController | ReadableByteStreamController | null;
}

interface WritableStreamState {
  kind: 'writer' | 'sink';
  state: 'writable' | 'closing' | 'closed' | 'errored';
  storedError: unknown;
  locked: boolean;
  writer: WritableStreamDefaultWriter | null;
  closedResolve: (() => void) | undefined;
  closedReject:  ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
  errorWaiters?: Array<(e: unknown) => void>;
  readyPromise: Promise<void>;
  readyResolve: (() => void) | null;
  readyReject: ((e: unknown) => void) | null;
  // writer-kind fields
  sink?: any;
  // sink-kind fields
  underlyingSink?: any;
  pendingWrites?: PendingWriteRequest[];
  writing?: boolean;
  highWaterMark?: number;
  sizeAlgorithm?: ((chunk: any) => number) | null;
  queueTotalSize?: number;
  controller?: WritableStreamDefaultController | null;
}

interface WritableSinkAlgorithms {
  start?: (controller: WritableStreamDefaultController) => unknown;
  write?: (chunk: any, controller: WritableStreamDefaultController | null) => unknown;
  close?: () => unknown;
  abort?: (reason: unknown) => unknown;
}

interface Channel {
  enqueue(value: any): void;
  dequeue?(): { done: boolean; value: any } | null;
  close(): void;
  error(reason: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

// ---------------------------------------------------------------------------
// Internal state WeakMaps
// ---------------------------------------------------------------------------

const _rs  = new WeakMap<ReadableStream, ReadableStreamState>();  // ReadableStream                  → state
const _ws  = new WeakMap<WritableStream, WritableStreamState>();  // WritableStream                  → state
const _rr  = new WeakMap<ReadableStreamDefaultReader, ReadableReaderState>();     // ReadableStreamDefaultReader     → state
const _br  = new WeakMap<ReadableStreamBYOBReader, ByobReaderState>();            // ReadableStreamBYOBReader        → state
const _ww  = new WeakMap<WritableStreamDefaultWriter, WritableWriterState>();     // WritableStreamDefaultWriter     → state
const _rc  = new WeakMap<ReadableStreamDefaultController, ReadableStreamState>();  // ReadableStreamDefaultController → rs-state ref
const _rbc = new WeakMap<ReadableByteStreamController, ReadableStreamState>();    // ReadableByteStreamController    → rs-state ref
const _wc  = new WeakMap<WritableStreamDefaultController, WritableStreamState>(); // WritableStreamDefaultController → ws-state ref
const _tc  = new WeakMap<TransformStreamDefaultController, Channel>();            // TransformStreamDefaultController → channel
const _byobRequestCtorToken = {};

function _streamReadResult(done: boolean, value: any): { done: boolean; value: any } {
  const result = Object.create(null) as { done: boolean; value: any };
  result.done = done;
  result.value = value;
  return result;
}

function _publicReadResult(done: boolean, value: any): { done: boolean; value: any } {
  const result = { done, value };
  Object.defineProperty(result, 'then', {
    value: undefined,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return result;
}

function _waitAllVoid(promises: Promise<void>[]): Promise<void> {
  if (promises.length === 0) return Promise.resolve();
  return new Promise<void>(function waitForAll(resolve, reject) {
    let remaining = promises.length;
    for (const promise of promises) {
      promise.then(function oneDone() {
        remaining--;
        if (remaining === 0) resolve();
      }, reject);
    }
  });
}

function _transferByteStreamBuffer(buffer: ArrayBuffer): ArrayBuffer {
  const transferred = structuredClone(buffer, { transfer: [buffer] });
  if (!(buffer as unknown as { detached?: boolean }).detached) {
    throw new TypeError('ArrayBuffer is not transferable');
  }
  return transferred;
}

function _byteStreamViewOnBuffer(view: ArrayBufferView, buffer: ArrayBuffer, byteLength = view.byteLength, byteOffset = view.byteOffset): ArrayBufferView {
  if (view instanceof DataView) return new DataView(buffer, byteOffset, byteLength);
  const ctor = (view as unknown as { constructor: { new(buffer: ArrayBuffer, byteOffset: number, length: number): ArrayBufferView; BYTES_PER_ELEMENT?: number } }).constructor;
  const bytesPerElement = ctor.BYTES_PER_ELEMENT ?? 1;
  return new ctor(buffer, byteOffset, Math.floor(byteLength / bytesPerElement));
}

function _transferByteStreamView(view: ArrayBufferView): ArrayBufferView {
  const byteOffset = view.byteOffset;
  const byteLength = view.byteLength;
  const transferred = _transferByteStreamBuffer(view.buffer as ArrayBuffer);
  return _byteStreamViewOnBuffer(view, transferred, byteLength, byteOffset);
}

function _byteStreamFilledView(view: ArrayBufferView, bytesFilled: number): ArrayBufferView {
  return _byteStreamViewOnBuffer(view, view.buffer as ArrayBuffer, bytesFilled);
}

function _byteStreamBufferDetached(buffer: ArrayBuffer): boolean {
  return (buffer as unknown as { detached?: boolean }).detached === true;
}

function _byteStreamViewDetached(view: ArrayBufferView): boolean {
  return _byteStreamBufferDetached(view.buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Channel — promise-based async-iterable queue (used by TransformStream)
// ---------------------------------------------------------------------------

function createChannel(): Channel {
  const queue: any[] = [];
  let pending: { resolve: (r: { done: boolean; value: any }) => void; reject: (e: unknown) => void } | null = null;
  let closed  = false;
  let errored: unknown = null;

  return {
    enqueue(value: any) {
      if (errored != null || closed) return;
      if (pending) { const p = pending; pending = null; p.resolve(_streamReadResult(false, value)); }
      else queue.push(value);
    },
    dequeue() {
      if (queue.length > 0) return _streamReadResult(false, queue.shift()!);
      if (closed) return _streamReadResult(true, undefined);
      return null;
    },
    close() {
      if (errored != null || closed) return;
      closed = true;
      if (pending) { const p = pending; pending = null; p.resolve(_streamReadResult(true, undefined)); }
    },
    error(reason: unknown) {
      if (errored != null || closed) return;
      errored = reason;
      if (pending) { const p = pending; pending = null; p.reject(reason); }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve(_streamReadResult(false, queue.shift()!));
          if (errored != null) return Promise.reject(errored);
          if (closed) return Promise.resolve(_streamReadResult(true, undefined));
          return new Promise(function parkRead(resolve, reject) { pending = { resolve, reject }; });
        },
        return() {
          closed = true;
          if (pending) { const p = pending; pending = null; p.resolve(_streamReadResult(true, undefined)); }
          return Promise.resolve(_streamReadResult(true, undefined));
        },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Queuing strategies
// ---------------------------------------------------------------------------

/**
 * WHATWG count queuing strategy with constant chunk size of 1.
 *
 * highWaterMark is number-coerced and size() ignores the chunk value.
 *
 * ```typescript no_run
 * const strategy = new CountQueuingStrategy({ highWaterMark: 4 });
 * strategy.size({}); // 1
 * ```
 */
export class CountQueuingStrategy {
  /**
   * Queue size threshold where backpressure begins.
   *
   * ```typescript no_run
   * new CountQueuingStrategy({ highWaterMark: 2 }).highWaterMark; // 2
   * ```
   */
  highWaterMark: number;
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new CountQueuingStrategy({ highWaterMark: 1 }));
   * ```
   */
  get [Symbol.toStringTag]() { return 'CountQueuingStrategy'; }
  /**
   * Create a count strategy.
   *
   * ```typescript no_run
   * const strategy = new CountQueuingStrategy({ highWaterMark: 1 });
   * ```
   */
  constructor(init: { highWaterMark: number }) {
    if (init === null || (typeof init !== 'object' && typeof init !== 'function')) {
      throw new TypeError('CountQueuingStrategy requires an options object');
    }
    const highWaterMark = init.highWaterMark;
    if (highWaterMark === undefined) throw new TypeError('highWaterMark is required');
    this.highWaterMark = Number(highWaterMark);
  }

  /**
   * Return the size contribution for any chunk.
   *
   * ```typescript no_run
   * new CountQueuingStrategy({ highWaterMark: 1 }).size('x'); // 1
   * ```
   */
  size(): number { return 1; }
}

/**
 * WHATWG byte-length queuing strategy using chunk.byteLength as size.
 *
 * ```typescript no_run
 * const strategy = new ByteLengthQueuingStrategy({ highWaterMark: 1024 });
 * strategy.size(new Uint8Array(8)); // 8
 * ```
 */
export class ByteLengthQueuingStrategy {
  /**
   * Byte threshold where backpressure begins.
   *
   * ```typescript no_run
   * new ByteLengthQueuingStrategy({ highWaterMark: 16 }).highWaterMark; // 16
   * ```
   */
  highWaterMark: number;
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new ByteLengthQueuingStrategy({ highWaterMark: 1 }));
   * ```
   */
  get [Symbol.toStringTag]() { return 'ByteLengthQueuingStrategy'; }
  /**
   * Create a byte-length strategy.
   *
   * ```typescript no_run
   * const strategy = new ByteLengthQueuingStrategy({ highWaterMark: 4096 });
   * ```
   */
  constructor(init: { highWaterMark: number }) {
    if (init === null || (typeof init !== 'object' && typeof init !== 'function')) {
      throw new TypeError('ByteLengthQueuingStrategy requires an options object');
    }
    const highWaterMark = init.highWaterMark;
    if (highWaterMark === undefined) throw new TypeError('highWaterMark is required');
    this.highWaterMark = Number(highWaterMark);
  }

  /**
   * Return chunk.byteLength.
   *
   * Passing a value without byteLength returns undefined at runtime through
   * normal property access, so callers should pass ArrayBuffer views.
   *
   * ```typescript no_run
   * new ByteLengthQueuingStrategy({ highWaterMark: 1 }).size(new Uint8Array(3)); // 3
   * ```
   */
  size(chunk: ArrayBufferView): number { return chunk.byteLength; }
}

function _validateQueueSize(size: unknown): number {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0) throw new RangeError('Queue size must be a finite, non-negative number');
  return n;
}

function _extractStrategy(strategy: QueuingStrategyLike | null | undefined, defaultHWM: number): { highWaterMark: number; sizeAlgorithm: (chunk: any) => number } {
  if (strategy == null) return { highWaterMark: defaultHWM, sizeAlgorithm: () => 1 };
  const strategySize = strategy.size;
  let size: (chunk: any) => number = () => 1;
  if (strategySize !== undefined) {
    if (typeof strategySize !== 'function') throw new TypeError('strategy.size must be a function');
    size = (chunk: any) => _validateQueueSize(strategySize.call(strategy, chunk));
  }
  const hwm = (strategy.highWaterMark !== undefined) ? Number(strategy.highWaterMark) : defaultHWM;
  if (Number.isNaN(hwm) || hwm < 0) throw new RangeError('highWaterMark must be a non-negative number');
  return { highWaterMark: hwm, sizeAlgorithm: size };
}

function _extractSinkMethod(sink: any, name: 'start' | 'write' | 'close' | 'abort'): Function | undefined {
  const method = sink[name];
  if (method === undefined) return undefined;
  if (typeof method !== 'function') throw new TypeError(`${name} must be a function or undefined`);
  return method;
}

// ---------------------------------------------------------------------------
// ReadableStream internal helpers
// ---------------------------------------------------------------------------

function _rsMakeState(kind: ReadableStreamState['kind'], extra: Partial<ReadableStreamState>): ReadableStreamState {
  let closedResolve: (() => void) | undefined;
  let closedReject: ((e: unknown) => void) | undefined;
  const closedPromise = new Promise<void>(function captureRsClosed(res, rej) { closedResolve = res; closedReject = rej; });
  return {
    kind,
    state: 'readable',
    storedError: null,
    locked: false,
    disturbed: false,
    reader: null,
    closedResolve, closedReject, closedPromise,
    ...extra,
  };
}

function _rsMarkClosed(s: ReadableStreamState): void {
  if (s.state === 'closed') return;
  s.state = 'closed';
  s.closedResolve?.();
  if (s.pendingReads) {
    while (s.pendingReads.length > 0)
      s.pendingReads.shift()!.resolve(_streamReadResult(true, undefined));
  }
  // Resolve pending BYOB reads with done:true and whatever was filled
  if (s.pendingByob) {
    while (s.pendingByob.length > 0) {
      const desc = s.pendingByob.shift()!;
      desc.request = null;
      desc.resolve({
        done: true,
        value: new Uint8Array(desc.view.buffer, desc.view.byteOffset, desc.bytesFilled),
      });
    }
    // Resolve the BYOB reader's closed promise now that all reads are done
    if (s.reader) _br.get(s.reader)?.closedResolve?.();
  }
}

function _rsMarkErrored(s: ReadableStreamState, e: unknown): void {
  if (s.state === 'errored' || s.state === 'closed') return;
  s.state = 'errored';
  s.storedError = e;
  s.closedReject?.(e);
  if (s.errorWaiters) {
    while (s.errorWaiters.length > 0) s.errorWaiters.shift()!(e);
  }
  if (s.pendingReads) {
    while (s.pendingReads.length > 0) s.pendingReads.shift()!.reject(e);
  }
  if (s.pendingByob) {
    while (s.pendingByob.length > 0) {
      const desc = s.pendingByob.shift()!;
      desc.request = null;
      desc.reject(e);
    }
  }
}

function _rsErrorPromise(s: ReadableStreamState): Promise<never> {
  if (s.state === 'errored') return Promise.reject(s.storedError);
  return new Promise<never>(function waitForReadableError(_, reject) {
    if (!s.errorWaiters) s.errorWaiters = [];
    s.errorWaiters.push(reject);
  });
}

function _rsCancel(s: ReadableStreamState, reason: unknown): Promise<void> {
  s.disturbed = true;
  if (s.state === 'closed') return Promise.resolve();
  if (s.state === 'errored') return Promise.reject(s.storedError);
  // Clear any queued data
  if (s.queue) { s.queue.length = 0; s.queueTotalSize = 0; }
  _rsMarkClosed(s);
  if (s.kind === 'iterable') {
    // Lazily initialize the iterator so that cancel() can call return() even if
    // the stream was never read (e.g., cancelled immediately after tee()).
    if (!s._iter) _rsIterableIterator(s);
    if (s._iter?.return) {
      return Promise.resolve(s._iter.return(reason)).then(function voidResult() {});
    }
  }
  if (s.kind === 'source' && s.underlyingSource?.cancel) {
    return Promise.resolve(s.underlyingSource.cancel(reason));
  }
  return Promise.resolve();
}

function _rsDesiredSize(s: ReadableStreamState): number | null {
  if (s.state === 'errored') return null;
  if (s.state === 'closed')  return 0;
  return s.highWaterMark! - s.queueTotalSize!;
}

// Pull algorithm — calls pull when the stream has capacity or pending reads.
// Spec: ReadableStreamDefaultControllerCallPullIfNeeded /
//       ReadableByteStreamControllerCallPullIfNeeded
function _rsPullIfNeeded(s: ReadableStreamState): void {
  if (!s.started || s.state !== 'readable') return;
  if (s.closeRequested) return;
  if (s.pulling) { s.pullAgain = true; return; }

  // Should pull if desiredSize > 0 (fill queue) OR there are pending consumers
  const hasPendingReads = s.pendingReads && s.pendingReads.length > 0;
  const hasPendingByob  = s.pendingByob  && s.pendingByob.length  > 0;
  const desiredSize = _rsDesiredSize(s);
  if (desiredSize !== null && desiredSize <= 0 && !hasPendingReads && !hasPendingByob) return;

  if (s.demandCallbacks && s.demandCallbacks.length > 0) {
    while (s.demandCallbacks.length > 0) s.demandCallbacks.shift()!();
  }

  s.pulling    = true;
  s.pullAgain  = false;
  Promise.resolve()
    .then(function rsCallPull() { return s.underlyingSource.pull ? s.underlyingSource.pull(s.controller) : undefined; })
    .then(function rsAfterPull() {
      s.pulling = false;
      if (s.pullAgain) { s.pullAgain = false; _rsPullIfNeeded(s); }
    })
    .catch(function rsPullError(e) { s.controller!.error(e); });
}

// Read the next {done, value} from a source-backed stream's queue/pending list.
function _rsIterableIterator(s: ReadableStreamState): AsyncIterator<any> {
  if (!s._iter) {
    const source = s.source as (AsyncIterable<any> & Iterable<any>);
    const asyncIterator = source[Symbol.asyncIterator] as (() => AsyncIterator<any>) | undefined;
    const syncIterator = source[Symbol.iterator] as (() => Iterator<any>) | undefined;
    if (asyncIterator) {
      s._iter = asyncIterator.call(source);
    } else if (syncIterator) {
      const syncIter = syncIterator.call(source);
      s._iter = {
        next: () => Promise.resolve(syncIter.next()),
        ...(syncIter.return ? { return: (v: unknown) => Promise.resolve(syncIter.return!(v)) } : {}),
      };
    } else {
      throw new TypeError('ReadableStream.from: argument must be iterable');
    }
  }
  return s._iter!;
}

function _rsNextChunk(s: ReadableStreamState): Promise<{ done: boolean; value: any }> {
  s.disturbed = true;
  if (s.kind === 'iterable') {
    const iter = _rsIterableIterator(s);
    return iter.next().then(function rsIterNext(r): { done: boolean; value: any } {
      if (r.done) _rsMarkClosed(s);
      return _streamReadResult(Boolean(r.done), r.value);
    }, function rsIterError(e) { _rsMarkErrored(s, e); return Promise.reject(e); });
  }

  // Source path: dequeue or park a pending read
  if (s.queue!.length > 0) {
    const entry = s.queue!.shift()!;
    s.queueTotalSize! -= entry.size;
    if (s.queueTotalSize! < 0) s.queueTotalSize = 0;
    if (s.closeRequested && s.queue!.length === 0) {
      _rsMarkClosed(s);
    } else {
      _rsPullIfNeeded(s);
    }
    return Promise.resolve(_streamReadResult(false, entry.value));
  }

  if (s.state === 'closed')   return Promise.resolve(_streamReadResult(true, undefined));
  if (s.state === 'errored')  return Promise.reject(s.storedError);

  return new Promise(function parkDefaultRead(resolve, reject) {
    if (s.isByteStream && s.autoAllocateChunkSize !== undefined) {
      const size = s.autoAllocateChunkSize;
      if (!Number.isFinite(size) || size <= 0) {
        reject(new TypeError('autoAllocateChunkSize must be a positive finite number'));
        return;
      }
      s.pendingByob!.push({
        view: new Uint8Array(new ArrayBuffer(size)),
        bytesFilled: 0,
        minFill: 1,
        resolve: (result) => resolve(_streamReadResult(result.done, result.value)),
        reject,
        request: null,
      });
      _rsPullIfNeeded(s);
      return;
    }
    s.pendingReads!.push({ resolve, reject });
    _rsPullIfNeeded(s);
  });
}

/**
 * Return whether a readable stream has been read from or canceled.
 *
 * This is an internal hook for Fetch body `bodyUsed` semantics.
 *
 * ```typescript no_run
 * const disturbed = isReadableStreamDisturbed(new ReadableStream());
 * ```
 *
 * @internal
 */
export function isReadableStreamDisturbed(stream: ReadableStream): boolean {
  const state = _rs.get(stream);
  if (!state) throw new TypeError('ReadableStream receiver expected');
  return state.disturbed || state.locked;
}

// Fill a BYOB view from queued Uint8Array chunks. Returns filled Uint8Array slice or null.
function _rsByobFillFromQueue(s: ReadableStreamState, view: ArrayBufferView, min: number): Uint8Array | null {
  const dest = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let bytesFilled = 0;
  while (bytesFilled < view.byteLength && s.queue!.length > 0) {
    const entry = s.queue![0]!;
    const available = entry.value.byteLength;
    const needed    = view.byteLength - bytesFilled;
    const toCopy    = Math.min(available, needed);
    dest.set(entry.value.subarray(0, toCopy), bytesFilled);
    bytesFilled += toCopy;
    if (toCopy === available) {
      s.queue!.shift();
      s.queueTotalSize! -= entry.size;
      if (s.queueTotalSize! < 0) s.queueTotalSize = 0;
    } else {
      entry.value = entry.value.subarray(toCopy);
      entry.size  = entry.value.byteLength;
      s.queueTotalSize! -= toCopy;
      if (s.queueTotalSize! < 0) s.queueTotalSize = 0;
    }
  }
  if (bytesFilled === 0) return null;
  if (bytesFilled < min) return null; // need at least min bytes
  if (s.closeRequested && s.queue!.length === 0) {
    _rsMarkClosed(s);
  } else {
    _rsPullIfNeeded(s);
  }
  return new Uint8Array(view.buffer, view.byteOffset, bytesFilled);
}

// ---------------------------------------------------------------------------
// ReadableStreamDefaultController
// ---------------------------------------------------------------------------

/**
 * Controller passed to non-byte ReadableStream underlying sources.
 *
 * It lets a source enqueue chunks, close the stream, or error it.
 *
 * ```typescript no_run
 * const stream = new ReadableStream({
 *   start(controller) { controller.enqueue('x'); controller.close(); },
 * });
 * ```
 */
export class ReadableStreamDefaultController {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(controller); // "[object ReadableStreamDefaultController]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableStreamDefaultController'; }

  /**
   * Internal constructor bound to a ReadableStream state record.
   *
   * User code receives controllers from underlying source callbacks.
   *
   * ```typescript no_run
   * new ReadableStream({ start(controller) { console.log(controller.desiredSize); } });
   * ```
   *
   * @internal
   */
  constructor(rsState: ReadableStreamState) {
    _rc.set(this, rsState);
  }

  /**
   * Desired queue size before backpressure applies.
   *
   * Returns null when the stream is errored, 0 when closed, or highWaterMark
   * minus queued size while readable.
   *
   * ```typescript no_run
   * new ReadableStream({ start(controller) { controller.desiredSize; } });
   * ```
   */
  get desiredSize() {
    return _rsDesiredSize(_rc.get(this)!);
  }

  /**
   * Enqueue a chunk into the readable stream.
   *
   * Throws if close() has already been requested or the stream is not readable.
   * Pending reads are fulfilled immediately before queueing.
   *
   * ```typescript no_run
   * const stream = new ReadableStream({ start(controller) { controller.enqueue('x'); } });
   * ```
   */
  enqueue(chunk: any) {
    const s = _rc.get(this)!;
    if (s.closeRequested)        throw new TypeError('Cannot enqueue after close()');
    if (s.state !== 'readable')  throw new TypeError('Stream is not readable');
    if (s.pendingReads!.length > 0) {
      // Fulfill already-waiting reads directly. No readable queue entry is
      // created, so the readable strategy size algorithm is not consulted.
      s.pendingReads!.shift()!.resolve(_streamReadResult(false, chunk));
      _rsPullIfNeeded(s);
      return;
    }
    let size: number;
    try {
      size = s.sizeAlgorithm ? s.sizeAlgorithm(chunk) : 1;
    } catch (e) {
      _rsMarkErrored(s, e);
      throw e;
    }
    if (s.closeRequested || s.state !== 'readable') return;
    if (s.pendingReads!.length > 0) {
      // Reads created reentrantly by size() are demand for future pulls, not
      // for the chunk whose size is still being computed.
      _rsPullIfNeeded(s);
    } else {
      s.queue!.push({ value: chunk, size });
      s.queueTotalSize! += size;
    }
  }

  /**
   * Request stream closure after queued chunks are consumed.
   *
   * Calling close() twice throws. If the queue is empty, the stream closes
   * immediately.
   *
   * ```typescript no_run
   * new ReadableStream({ start(controller) { controller.close(); } });
   * ```
   */
  close() {
    const s = _rc.get(this)!;
    if (s.state !== 'readable') return;
    if (s.closeRequested)       throw new TypeError('close() already called');
    s.closeRequested = true;
    if (s.queue!.length === 0) _rsMarkClosed(s);
  }

  /**
   * Error the stream and reject pending reads.
   *
   * ```typescript no_run
   * new ReadableStream({ start(controller) { controller.error(new Error('stop')); } });
   * ```
   */
  error(reason: unknown) {
    _rsMarkErrored(_rc.get(this)!, reason);
  }
}

// ---------------------------------------------------------------------------
// ReadableByteStreamController (for type: 'bytes' underlying sources)
// ---------------------------------------------------------------------------

/**
 * Controller passed to byte ReadableStream underlying sources.
 *
 * It supports Uint8Array enqueueing and BYOB request fulfillment.
 *
 * ```typescript no_run
 * const stream = new ReadableStream({
 *   type: 'bytes',
 *   pull(controller) { controller.enqueue(new Uint8Array([1])); },
 * });
 * ```
 */
export class ReadableByteStreamController {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(controller); // "[object ReadableByteStreamController]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableByteStreamController'; }

  /**
   * Internal constructor bound to a byte stream state record.
   *
   * User code receives this controller from byte underlying source callbacks.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', start(controller) { controller.desiredSize; } });
   * ```
   *
   * @internal
   */
  constructor(rsState: ReadableStreamState) {
    _rbc.set(this, rsState);
  }

  /**
   * Desired byte queue size before backpressure applies.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', start(controller) { controller.desiredSize; } });
   * ```
   */
  get desiredSize() {
    return _rsDesiredSize(_rbc.get(this)!);
  }

  /**
   * Current BYOB request, or null when no BYOB read is pending.
   *
   * The same request object is reused for the pending descriptor until
   * respond() or respondWithNewView() resolves it.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', pull(controller) { controller.byobRequest; } });
   * ```
   */
  get byobRequest() {
    const s = _rbc.get(this)!;
    if (!s.pendingByob || s.pendingByob.length === 0) return null;
    const desc = s.pendingByob[0]!;
    if (!desc.request) desc.request = new ReadableStreamBYOBRequest(_byobRequestCtorToken, this, desc);
    return desc.request;
  }

  /**
   * Enqueue bytes into the stream.
   *
   * Accepts ArrayBuffer or ArrayBufferView and normalizes to Uint8Array. Throws
   * if the stream is closed, errored, or close() was requested.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(new Uint8Array([1])); } });
   * ```
   */
  enqueue(chunk: ArrayBuffer | ArrayBufferView) {
    const s = _rbc.get(this)!;
    if (s.state !== 'readable') throw new TypeError('Stream is not readable');
    if (s.closeRequested)       throw new TypeError('Cannot enqueue after close()');
    if ((ArrayBuffer.isView(chunk) && chunk.byteLength === 0) ||
        (chunk instanceof ArrayBuffer && chunk.byteLength === 0)) {
      throw new TypeError('chunk byteLength must be > 0');
    }

    // Normalise to Uint8Array while transferring the backing buffer.
    let bytes: Uint8Array;
    if (chunk instanceof Uint8Array) {
      const view = _transferByteStreamView(chunk);
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else if (ArrayBuffer.isView(chunk)) {
      const view = _transferByteStreamView(chunk);
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    } else if (chunk instanceof ArrayBuffer) {
      bytes = new Uint8Array(_transferByteStreamBuffer(chunk));
    } else {
      throw new TypeError('chunk must be an ArrayBufferView or ArrayBuffer');
    }

    // Fill pending BYOB descriptors first
    let offset = 0;
    const byobCompletions: Array<() => void> = [];
    while (offset < bytes.length && s.pendingByob!.length > 0) {
      const desc     = s.pendingByob![0]!;
      if (_byteStreamViewDetached(desc.view)) throw new TypeError('BYOB request view is detached');
      const available = bytes.length - offset;
      const needed    = desc.view.byteLength - desc.bytesFilled;
      const toCopy    = Math.min(available, needed);
      new Uint8Array(desc.view.buffer, desc.view.byteOffset + desc.bytesFilled, toCopy)
        .set(bytes.subarray(offset, offset + toCopy));
      desc.bytesFilled += toCopy;
      offset           += toCopy;

      if (desc.bytesFilled >= desc.minFill) {
        s.pendingByob!.shift();
        desc.request = null;
        const value = _byteStreamFilledView(desc.view, desc.bytesFilled);
        byobCompletions.push(function resolveByobRead() {
          desc.resolve({ done: false, value: value as Uint8Array });
        });
      }
    }
    while (byobCompletions.length > 0) byobCompletions.shift()!();

    // Fill pending default (non-BYOB) reads
    if (offset < bytes.length && s.pendingReads!.length > 0) {
      const remaining = bytes.slice(offset);
      offset = bytes.length;
      s.pendingReads!.shift()!.resolve({ done: false, value: remaining });
    }

    // Any leftover bytes go into the queue
    if (offset < bytes.length) {
      const leftover = bytes.slice(offset);
      s.queue!.push({ value: leftover, size: leftover.byteLength });
      s.queueTotalSize! += leftover.byteLength;
    }

    if (s.closeRequested && s.queue!.length === 0 && s.pendingByob!.length === 0) {
      _rsMarkClosed(s);
    }
    _rsPullIfNeeded(s);
  }

  /**
   * Request byte stream closure after queued and pending BYOB bytes complete.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', start(controller) { controller.close(); } });
   * ```
   */
  close() {
    const s = _rbc.get(this)!;
    if (s.state !== 'readable') return;
    if (s.closeRequested)       throw new TypeError('close() already called');
    s.closeRequested = true;
    if (s.queue!.length === 0 && s.pendingByob!.length === 0) {
      _rsMarkClosed(s);
    }
  }

  /**
   * Error the byte stream and reject pending reads.
   *
   * ```typescript no_run
   * new ReadableStream({ type: 'bytes', start(controller) { controller.error('stop'); } });
   * ```
   */
  error(reason: unknown) {
    _rsMarkErrored(_rbc.get(this)!, reason);
  }

  // Called by ReadableStreamBYOBRequest.respond(bytesWritten)
  /**
   * Fulfill the active BYOB request with bytes written into its view.
   *
   * This internal method is called by ReadableStreamBYOBRequest.respond().
   *
   * ```typescript no_run
   * controller._byobRespond(4, view);
   * ```
   *
   * @internal
   */
  _byobRespond(bytesWritten: number, view: ArrayBufferView) {
    const s = _rbc.get(this)!;
    if (!s.pendingByob || s.pendingByob.length === 0) return;
    const desc = s.pendingByob[0]!;
    if (_byteStreamViewDetached(desc.view)) throw new TypeError('BYOB request view is detached');
    desc.bytesFilled += bytesWritten;
    desc.request      = null;

    if (s.state === 'closed') {
      s.pendingByob.shift()!;
      desc.resolve({
        done:  true,
        value: _byteStreamFilledView(desc.view, 0) as Uint8Array,
      });
      return;
    }

    if (desc.bytesFilled >= desc.minFill) {
      s.pendingByob.shift()!;
      desc.resolve({
        done:  false,
        value: _byteStreamFilledView(desc.view, desc.bytesFilled) as Uint8Array,
      });
    }
    _rsPullIfNeeded(s);
  }

  // Called by ReadableStreamBYOBRequest.respondWithNewView(view)
  /**
   * Fulfill the active BYOB request with a replacement view.
   *
   * This internal method is called by respondWithNewView().
   *
   * ```typescript no_run
   * controller._byobRespondWithNewView(new Uint8Array(4));
   * ```
   *
   * @internal
   */
  _byobRespondWithNewView(view: ArrayBufferView) {
    const s = _rbc.get(this)!;
    if (!s.pendingByob || s.pendingByob.length === 0) return;
    const desc = s.pendingByob[0]!;
    const current = desc.view;
    if (_byteStreamViewDetached(current) || _byteStreamViewDetached(view)) {
      throw new TypeError('BYOB request view is detached');
    }
    if (s.closeRequested || s.state === 'closed') {
      if (view.byteOffset !== current.byteOffset) throw new RangeError('view byteOffset must match the BYOB request');
      if (view.buffer.byteLength !== current.buffer.byteLength) {
        throw new RangeError('view buffer byteLength must match the BYOB request');
      }
      if (view.byteLength !== 0) throw new TypeError('view byteLength must be 0 after close');
    } else {
      if (view.byteLength === 0) throw new TypeError('view byteLength must be > 0');
      if (view.byteOffset !== current.byteOffset) throw new RangeError('view byteOffset must match the BYOB request');
      if (view.buffer.byteLength !== current.buffer.byteLength) {
        throw new RangeError('view buffer byteLength must match the BYOB request');
      }
      if (view.byteLength > current.byteLength) throw new RangeError('view byteLength must not exceed the BYOB request');
    }
    const transferredView = _transferByteStreamView(view);
    desc.view        = transferredView;
    desc.bytesFilled = transferredView.byteLength;
    desc.request     = null;

    s.pendingByob.shift()!;
    desc.resolve({
      done: s.state === 'closed',
      value: transferredView as Uint8Array,
    });
    _rsPullIfNeeded(s);
  }
}

// ---------------------------------------------------------------------------
// ReadableStreamBYOBRequest
// ---------------------------------------------------------------------------

/**
 * Active bring-your-own-buffer request for byte streams.
 *
 * Underlying byte sources use this to report how many bytes were written into
 * the caller-provided view.
 *
 * ```typescript no_run
 * new ReadableStream({ type: 'bytes', pull(controller) {
 *   const request = controller.byobRequest;
 *   if (request) request.respond(0);
 * } });
 * ```
 */
export class ReadableStreamBYOBRequest {
  /**
   * Private property `#controller` used by `ReadableStreamBYOBRequest`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #controller = undefined;
   *
   *   readInternalState() {
   *     return this.#controller;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #controller: ReadableByteStreamController;
  /**
   * Private property `#desc` used by `ReadableStreamBYOBRequest`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #desc = undefined;
   *
   *   readInternalState() {
   *     return this.#desc;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #desc: PullIntoDescriptor;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(request); // "[object ReadableStreamBYOBRequest]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableStreamBYOBRequest'; }

  /**
   * Internal constructor for a pending BYOB pull descriptor.
   *
   * Direct construction throws. Active requests are created by
   * `ReadableByteStreamController.byobRequest`.
   *
   * ```typescript no_run
   * const request = controller.byobRequest;
   * ```
   *
   * @internal
   */
  constructor(token: object, controller: ReadableByteStreamController, desc: PullIntoDescriptor) {
    if (token !== _byobRequestCtorToken) {
      throw new TypeError('ReadableStreamBYOBRequest constructor is not public');
    }
    this.#controller = controller;
    this.#desc       = desc;
  }

  /**
   * View supplied by the BYOB reader.
   *
   * ```typescript no_run
   * const view = request.view;
   * ```
   */
  get view() { return this.#desc.view; }

  /**
   * Report how many bytes were written into view.
   *
   * Resolves the pending BYOB read once the requested minimum has been filled.
   *
   * ```typescript no_run
   * request.respond(8);
   * ```
   */
  respond(bytesWritten: number) {
    this.#controller._byobRespond(Number(bytesWritten), this.#desc.view);
  }

  /**
   * Respond with a replacement ArrayBufferView.
   *
   * Passing a non-view throws TypeError.
   *
   * ```typescript no_run
   * request.respondWithNewView(new Uint8Array([1, 2]));
   * ```
   */
  respondWithNewView(view: ArrayBufferView) {
    if (!ArrayBuffer.isView(view)) throw new TypeError('view must be an ArrayBufferView');
    this.#controller._byobRespondWithNewView(view);
  }
}

// ---------------------------------------------------------------------------
// ReadableStream
// ---------------------------------------------------------------------------

/**
 * WHATWG ReadableStream implementation with source and iterable backends.
 *
 * Source-backed streams use controllers and queues. Iterable-backed streams are
 * created with ReadableStream.from() and read directly from the iterable.
 *
 * ```typescript no_run
 * const stream = new ReadableStream({ start(controller) { controller.close(); } });
 * ```
 */
export class ReadableStream {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new ReadableStream()); // "[object ReadableStream]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableStream'; }

  /**
   * Create a source-backed ReadableStream.
   *
   * The underlying source may define start, pull, cancel, and type: "bytes".
   * Queuing strategy defaults to highWaterMark 1 for default streams and 0 for
   * byte streams.
   *
   * ```typescript no_run
   * const stream = new ReadableStream({
   *   pull(controller) { controller.enqueue('chunk'); controller.close(); },
   * });
   * ```
   */
  constructor(underlyingSource?: any, queuingStrategy?: QueuingStrategyLike) {
    const src         = underlyingSource ?? {};
    const isByteStream = src.type === 'bytes';
    const defaultHWM   = isByteStream ? 0 : 1;
    const { highWaterMark, sizeAlgorithm } = _extractStrategy(queuingStrategy, defaultHWM);

    let s: ReadableStreamState;
    let controller: ReadableStreamDefaultController | ReadableByteStreamController;
    let startResult: Promise<unknown>;
    if (isByteStream) {
      s = _rsMakeState('source', {
        underlyingSource: src,
        queue: [],
        queueTotalSize: 0,
        pendingReads: [],   // default (non-BYOB) pending reads
        pendingByob: [],    // pull-into descriptors for BYOB reads
        pulling: false,
        pullAgain: false,
        started: false,
        closeRequested: false,
        highWaterMark,
        sizeAlgorithm,
        isByteStream: true,
        autoAllocateChunkSize: src.autoAllocateChunkSize === undefined ? undefined : Number(src.autoAllocateChunkSize),
        controller: null,
      });
      controller = new ReadableByteStreamController(s);
      s.controller = controller;
      _rs.set(this, s);
      startResult = src.start
        ? Promise.resolve(src.start(controller))
        : Promise.resolve();
    } else {
      s = _rsMakeState('source', {
        underlyingSource: src,
        queue: [],
        queueTotalSize: 0,
        pendingReads: [],
        pendingByob: [],
        demandCallbacks: [],
        pulling: false,
        pullAgain: false,
        started: false,
        closeRequested: false,
        highWaterMark,
        sizeAlgorithm,
        isByteStream: false,
        controller: null,
      });
      controller = new ReadableStreamDefaultController(s);
      s.controller = controller;
      _rs.set(this, s);
      startResult = src.start
        ? Promise.resolve(src.start(controller))
        : Promise.resolve();
    }
    startResult.then(function rsOnStarted() { s.started = true; _rsPullIfNeeded(s); })
               .catch(function rsStartError(e) { controller.error(e); });
  }

  /**
   * Create a ReadableStream from an iterable or async iterable.
   *
   * The iterable is consumed lazily. Non-iterable inputs throw TypeError.
   *
   * ```typescript no_run
   * const stream = ReadableStream.from([1, 2, 3]);
   * ```
   */
  static from(asyncIterable: AsyncIterable<any> | Iterable<any>) {
    const source = asyncIterable as (AsyncIterable<any> & Iterable<any>);
    if (asyncIterable == null ||
        (typeof source[Symbol.asyncIterator] !== 'function' &&
         typeof source[Symbol.iterator] !== 'function')) {
      throw new TypeError('ReadableStream.from: argument must be an async iterable or iterable');
    }
    const rs = Object.create(ReadableStream.prototype);
    _rs.set(rs, _rsMakeState('iterable', { source }));
    return rs;
  }

  /**
   * Whether the stream is locked to a reader, pipe, or async iterator.
   *
   * ```typescript no_run
   * const stream = new ReadableStream();
   * stream.locked; // false
   * ```
   */
  get locked() {
    const s = _rs.get(this);
    if (!s) throw new TypeError('ReadableStream receiver expected');
    return s.locked;
  }

  /**
   * Cancel the stream with a reason.
   *
   * Rejects when the stream is locked. Iterable streams call the iterator
   * return() method when available; source streams call underlyingSource.cancel.
   *
   * ```typescript no_run
   * const stream = new ReadableStream();
   * await stream.cancel('done');
   * ```
   */
  cancel(reason: unknown) {
    const s = _rs.get(this)!;
    if (s.locked) return Promise.reject(new TypeError('ReadableStream is locked to a reader'));
    return _rsCancel(s, reason);
  }

  /**
   * Acquire a reader and lock the stream.
   *
   * mode: "byob" requires a byte stream and returns a ReadableStreamBYOBReader.
   * Without mode, this returns a ReadableStreamDefaultReader.
   *
   * ```typescript no_run
   * const reader = new ReadableStream().getReader();
   * reader.releaseLock();
   * ```
   */
  getReader(options?: { mode?: 'byob' }) {
    const s    = _rs.get(this)!;
    const mode = options?.mode;
    if (s.locked) throw new TypeError('ReadableStream is already locked to a reader');
    if (mode === 'byob') {
      if (!s.isByteStream)
        throw new TypeError('getReader({mode:"byob"}) requires a byte stream (type:"bytes")');
      const reader = new ReadableStreamBYOBReader(this);
      s.locked = true;
      s.reader = reader;
      return reader;
    }
    const reader = new ReadableStreamDefaultReader(this);
    s.locked = true;
    s.reader = reader;
    return reader;
  }

  /**
   * Async iterator over stream chunks.
   *
   * Iteration locks the stream until completion, error, or iterator return().
   * Calling return() cancels the stream unless `preventCancel` is true.
   *
   * ```typescript no_run
   * const iter = stream.values({ preventCancel: true });
   * await iter.return?.(); // releases the lock without canceling the source
   * ```
   */
  values(options?: { preventCancel?: boolean }) {
    const s = _rs.get(this)!;
    if (s.locked) throw new TypeError('ReadableStream is locked');
    s.locked = true;
    const preventCancel = options?.preventCancel === true;

    const iter = s.kind === 'iterable'
      ? _rsIterableIterator(s)
      : null;

    return {
      next() {
        const read = iter ? iter.next() : _rsNextChunk(s);
        return read.then(function rsAsyncIterNext(r) {
          if (r.done) { s.locked = false; _rsMarkClosed(s); }
          return r;
        }, function rsAsyncIterError(e: unknown) {
          s.locked = false;
          _rsMarkErrored(s, e);
          return Promise.reject(e);
        });
      },
      return(value: unknown) {
        s.locked = false;
        if (preventCancel) return Promise.resolve({ done: true, value });
        return _rsCancel(s, value).then(function rsAsyncIterReturn() {
          return { done: true, value };
        });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  /**
   * Default async iterator over stream chunks.
   *
   * Equivalent to `values()` with default options, so early exit cancels the
   * stream. Use `values({ preventCancel: true })` when early exit should only
   * release the iterator lock.
   *
   * ```typescript no_run
   * for await (const chunk of ReadableStream.from(['a'])) console.log(chunk);
   * ```
   */
  [Symbol.asyncIterator]() {
    return this.values();
  }

  /**
   * Pipe this readable stream into a writable stream.
   *
   * Rejects if either stream is locked. preventClose, preventAbort, and
   * preventCancel suppress the corresponding propagation steps. signal aborts
   * the pipe and propagates according to those flags.
   *
   * ```typescript no_run
   * const source = ReadableStream.from(['a']);
   * const sink = new WritableStream({ write(chunk) { console.log(chunk); } });
   * await source.pipeTo(sink);
   * ```
   */
  async pipeTo(destination: WritableStream, options?: { preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean; signal?: AbortSignal | null }) {
    const src = _rs.get(this);
    if (!src) return Promise.reject(new TypeError('ReadableStream receiver expected'));
    const dst = _ws.get(destination);
    if (!dst) return Promise.reject(new TypeError('WritableStream expected'));
    if (src.locked) return Promise.reject(new TypeError('ReadableStream is locked'));
    if (dst.locked) return Promise.reject(new TypeError('WritableStream is locked'));

    const preventAbort  = Boolean(options?.preventAbort);
    const preventCancel = Boolean(options?.preventCancel);
    const preventClose  = Boolean(options?.preventClose);
    const signal        = options?.signal ?? null;

    if (signal?.aborted) {
      if (!preventCancel) _rsCancel(src, signal.reason).catch(function swallowCancelErr() {});
      if (!preventAbort)  _wsAbort(dst, signal.reason).catch(function swallowAbortErr() {});
      throw signal.reason;
    }

    src.locked = true;
    dst.locked = true;

    // Fast path: iterable-readable + writer-writable — zero Web Streams overhead
    if (src.kind === 'iterable' && dst.kind === 'writer') {
      try {
        const iter = src._iter ??= src.source![Symbol.asyncIterator]();
        while (true) {
          if (signal?.aborted) throw signal.reason;
          const { done, value } = await iter.next();
          if (done) break;
          if (signal?.aborted) throw signal.reason;
          await dst.sink.write(value);
        }
        if (!preventClose) { dst.sink.close(); _wsMarkClosed(dst); }
        _rsMarkClosed(src);
      } catch (e) {
        _rsMarkErrored(src, e);
        if (!preventAbort)  await _wsAbort(dst, e).catch(function swallowAbortErr() {});
        if (!preventCancel) await _rsCancel(src, e).catch(function swallowCancelErr() {});
        src.locked = false;
        dst.locked = false;
        throw e;
      }
      src.locked = false;
      dst.locked = false;
      return;
    }

    // General pump
    let abortListener: ((this: AbortSignal, ev: Event) => any) | null = null;
    let abortReject: ((reason?: unknown) => void) | null = null;
    let abortPromise: Promise<never> | null = null;
    if (signal) {
      abortPromise  = new Promise<never>(function captureAbortReject(_, reject) { abortReject = reject; });
      abortListener = function onAbortPipe() { abortReject?.(signal.reason); };
      signal.addEventListener('abort', abortListener, { once: true });
    }

    class PipeDestinationError {
      reason: unknown;

      constructor(reason: unknown) {
        this.reason = reason;
      }
    }

    const pump = async () => {
      const writePromises: Promise<void>[] = [];
      const destinationErrorPromise = () => _wsErrorPromise(dst).catch(function wrapDestinationError(reason) {
        throw new PipeDestinationError(reason);
      });
      const waitForWritableDemand = async () => {
        const desiredSize = _wsDesiredSize(dst);
        if (desiredSize === null) throw new PipeDestinationError(dst.storedError);
        if (desiredSize <= 0) {
          await Promise.race([
            dst.readyPromise,
            _rsErrorPromise(src).catch(function sourceErroredWhileWaiting() {}),
            destinationErrorPromise(),
          ]);
        }
        if (dst.state === 'errored') throw new PipeDestinationError(dst.storedError);
        if (src.state === 'errored') {
          await _waitAllVoid(writePromises).catch(function convertPipeWriteError(reason) {
            throw new PipeDestinationError(reason);
          });
          throw src.storedError;
        }
      };

      while (true) {
        await waitForWritableDemand();
        const { done, value } = await _rsNextChunk(src);
        if (done) break;
        const writePromise = _wsWriteInternal(dst, value);
        writePromise.catch(function observePipeWriteError() {});
        writePromises.push(writePromise);
      }
      await _waitAllVoid(writePromises).catch(function convertPipeWriteError(reason) {
        throw new PipeDestinationError(reason);
      });
      if (!preventClose) await _wsCloseInternal(dst);
    };

    try {
      await (abortPromise ? Promise.race([pump(), abortPromise]) : pump());
      _rsMarkClosed(src);
    } catch (e) {
      if (e instanceof PipeDestinationError) {
        const reason = e.reason;
        if (!preventCancel) await _rsCancel(src, reason).catch(function swallowCancelErr() {});
        throw reason;
      }
      _rsMarkErrored(src, e);
      if (!preventAbort)  await _wsAbort(dst, e);
      if (!preventCancel) await _rsCancel(src, e).catch(function swallowCancelErr() {});
      throw e;
    } finally {
      src.locked = false;
      dst.locked = false;
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
    }
  }

  /**
   * Pipe through a transform and return its readable side.
   *
   * Starts pipeTo(transform.writable) in the background. Throws if either side
   * is invalid or locked.
   *
   * ```typescript no_run
   * const transform = new TransformStream();
   * const readable = ReadableStream.from(['a']).pipeThrough(transform);
   * ```
   */
  pipeThrough(transform: { readable: ReadableStream; writable: WritableStream }, options?: { preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean; signal?: AbortSignal | null }) {
    const s = _rs.get(this);
    if (!s) throw new TypeError('ReadableStream receiver expected');
    if (transform == null) throw new TypeError('transform must be an object');

    const readable = transform.readable;
    if (!_rs.get(readable))
      throw new TypeError('transform.readable must be a ReadableStream');
    const writable = transform.writable;
    const dstState = _ws.get(writable);
    if (!dstState) throw new TypeError('transform.writable must be a WritableStream');

    let pipeOptions: { preventClose?: boolean; preventAbort?: boolean; preventCancel?: boolean; signal?: AbortSignal } | undefined;
    if (options != null) {
      const preventAbort = Boolean(options.preventAbort);
      const preventCancel = Boolean(options.preventCancel);
      const preventClose = Boolean(options.preventClose);
      const signal = options.signal;
      if (signal !== undefined) {
        if (!(signal instanceof AbortSignal)) throw new TypeError('options.signal must be an AbortSignal');
        try {
          void signal.aborted;
        } catch (_) {
          throw new TypeError('options.signal must be an AbortSignal');
        }
      }
      pipeOptions = { preventClose, preventAbort, preventCancel, ...(signal === undefined ? {} : { signal }) };
    }

    if (s.locked) throw new TypeError('ReadableStream is locked');
    if (dstState.locked) throw new TypeError('transform.writable is locked');

    Promise.resolve(_rsPipeToMethod.call(this, writable, pipeOptions)).catch(function swallowPipeError() {});
    return readable;
  }

  /**
   * Split this stream into two readable branches.
   *
   * The original stream is locked while teeing. If both branches cancel, the
   * original source is cancelled with both reasons.
   *
   * ```typescript no_run
   * const [a, b] = ReadableStream.from([1, 2]).tee();
   * ```
   */
  tee() {
    const s = _rs.get(this)!;
    if (s.locked) throw new TypeError('ReadableStream is locked');
    s.locked = true;

    if (s.isByteStream) {
      const branchControllers: Array<ReadableByteStreamController | undefined> = [];
      const cancelled = [false, false];
      let cancelledCount = 0;
      let cancelReason1: unknown;
      let cancelReason2: unknown;
      let reading = false;
      let readAgain = false;

      const cloneChunk = (chunk: ArrayBuffer | ArrayBufferView) => {
        if (ArrayBuffer.isView(chunk)) {
          return new Uint8Array(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        }
        return new Uint8Array(new Uint8Array(chunk));
      };

      const cancelOriginalIfNeeded = () => {
        if (cancelledCount < 2) return;
        _rsCancel(s, [cancelReason1, cancelReason2]).catch(function swallowByteTeeCancelErr() {});
        s.locked = false;
      };

      const pullFromOriginal = async () => {
        if (cancelledCount >= 2) return;
        if (reading) {
          readAgain = true;
          return;
        }
        reading = true;
        try {
          while (true) {
            readAgain = false;
            const { done, value } = await _rsNextChunk(s);
            if (done) {
              if (!cancelled[0]) branchControllers[0]?.close();
              if (!cancelled[1]) branchControllers[1]?.close();
              s.locked = false;
              return;
            }
            if (!cancelled[0]) branchControllers[0]?.enqueue(cloneChunk(value));
            if (!cancelled[1]) branchControllers[1]?.enqueue(cloneChunk(value));
            if (!readAgain) return;
          }
        } catch (e) {
          if (!cancelled[0]) branchControllers[0]?.error(e);
          if (!cancelled[1]) branchControllers[1]?.error(e);
          s.locked = false;
        } finally {
          reading = false;
        }
      };

      const makeBranch = (index: 0 | 1) => new ReadableStream({
        type: 'bytes',
        start(controller: ReadableByteStreamController) {
          branchControllers[index] = controller;
        },
        pull() {
          return pullFromOriginal();
        },
        cancel(reason: unknown) {
          if (!cancelled[index]) {
            cancelled[index] = true;
            cancelledCount++;
            if (index === 0) cancelReason1 = reason;
            else cancelReason2 = reason;
          }
          cancelOriginalIfNeeded();
        },
      });

      return [makeBranch(0), makeBranch(1)];
    }

    const ch1 = createChannel();
    const ch2 = createChannel();

    // Track cancellation from both branches. When both cancel, cancel the source
    // with a composite reason [reason1, reason2] per the WHATWG Streams spec.
    let cancelledCount = 0;
    let cancelReason1: unknown;
    let cancelReason2: unknown;
    function onBranchCancel(branchIndex: number, reason: unknown) {
      if (branchIndex === 0) cancelReason1 = reason;
      else cancelReason2 = reason;
      cancelledCount++;
      if (cancelledCount >= 2) {
        _rsCancel(s, [cancelReason1, cancelReason2]).catch(function swallowTeeCancelErr() {});
        s.locked = false;
      }
    }

    // Wrap a channel in an iterable that intercepts return() to notify tee.
    function makeTeeIterable(ch: Channel, branchIndex: number): AsyncIterable<any> {
      return {
        [Symbol.asyncIterator]() {
          const iter = ch[Symbol.asyncIterator]();
          return {
            next() { return iter.next(); },
            return(value: unknown) {
              onBranchCancel(branchIndex, value);
              return iter.return ? iter.return(value) : Promise.resolve(_streamReadResult(true, value));
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
      };
    }

    const feed = async function teeFeed() {
      try {
        // Use _rsNextChunk directly to bypass the public locked check — tee() holds
        // the lock itself and must read through the internal API, not for-await-of.
        while (true) {
          if (cancelledCount >= 2) break;
          const { done, value } = await _rsNextChunk(s);
          if (done) break;
          ch1.enqueue(value);
          ch2.enqueue(value);
        }
        ch1.close();
        ch2.close();
      } catch (e) {
        ch1.error(e);
        ch2.error(e);
      } finally {
        if (cancelledCount < 2) s.locked = false;
      }
    };

    feed();
    return [ReadableStream.from(makeTeeIterable(ch1, 0)), ReadableStream.from(makeTeeIterable(ch2, 1))];
  }
}

const _rsPipeToMethod = ReadableStream.prototype.pipeTo;

// ---------------------------------------------------------------------------
// ReadableStreamDefaultReader
// ---------------------------------------------------------------------------

/**
 * Default reader for non-BYOB stream reads.
 *
 * Acquiring a reader locks the stream until releaseLock(), cancel(), or stream
 * completion.
 *
 * ```typescript no_run
 * const reader = ReadableStream.from(['x']).getReader();
 * await reader.read();
 * ```
 */
export class ReadableStreamDefaultReader {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(reader); // "[object ReadableStreamDefaultReader]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableStreamDefaultReader'; }

  /**
   * Create a default reader and lock the stream.
   *
   * Throws if the argument is not a ReadableStream or is already locked.
   *
   * ```typescript no_run
   * const reader = new ReadableStreamDefaultReader(new ReadableStream());
   * ```
   */
  constructor(stream: ReadableStream) {
    const s = _rs.get(stream);
    if (!s) throw new TypeError('Argument must be a ReadableStream');
    if (s.locked) throw new TypeError('ReadableStream is already locked to a reader');

    let closedResolve: (() => void) | undefined;
    let closedReject: ((e: unknown) => void) | undefined;
    const closedPromise = new Promise<void>(function captureRrClosed(res, rej) { closedResolve = res; closedReject = rej; });

    _rr.set(this, {
      rsState: s,
      iter: s.kind === 'iterable' ? _rsIterableIterator(s) : null,
      closedResolve, closedReject, closedPromise,
    });

    s.locked = true;
    s.reader = this;
  }

  /**
   * Promise resolved when the stream closes and rejected on error or release.
   *
   * ```typescript no_run
   * const reader = new ReadableStream().getReader();
   * reader.closed.catch(() => {});
   * ```
   */
  get closed() {
    const rr = _rr.get(this);
    if (!rr) throw new TypeError('ReadableStreamDefaultReader receiver expected');
    return rr.closedPromise;
  }

  /**
   * Read the next chunk.
   *
   * Resolves to { done, value }. Rejects if the reader was released or the
   * stream errors.
   *
   * ```typescript no_run
   * const result = await ReadableStream.from(['x']).getReader().read();
   * result.value; // "x"
   * ```
   */
  read() {
    const rr = _rr.get(this);
    if (!rr) return Promise.reject(new TypeError('Reader is released'));
    const s    = rr.rsState;
    if (rr.iter) s.disturbed = true;
    const read = rr.iter ? rr.iter.next() : _rsNextChunk(s);
    return read.then(function rrReadNext(r) {
      if (r.done) { _rsMarkClosed(s); rr.closedResolve?.(); }
      return _publicReadResult(Boolean(r.done), r.value);
        }, function rrReadError(e: unknown) {
      _rsMarkErrored(s, e);
      rr.closedReject?.(e);
      return Promise.reject(e);
    });
  }

  /**
   * Cancel the associated stream.
   *
   * Rejects if the reader has been released.
   *
   * ```typescript no_run
   * const reader = new ReadableStream().getReader();
   * await reader.cancel('done');
   * ```
   */
  cancel(reason: unknown) {
    const rr = _rr.get(this);
    if (!rr) return Promise.reject(new TypeError('Reader is released'));
    return _rsCancel(rr.rsState, reason).then(function rrCancelled() { rr.closedResolve?.(); });
  }

  /**
   * Release the reader lock.
   *
   * Pending reads are rejected and the closed promise rejects because the reader
   * was released before stream closure.
   *
   * ```typescript no_run
   * const reader = new ReadableStream().getReader();
   * reader.releaseLock();
   * ```
   */
  releaseLock() {
    const rr = _rr.get(this);
    if (!rr) return;
    const s = rr.rsState;
    if (s.reader !== this) return;
    const e = new TypeError('Reader was released before the stream closed');
    // Reject any in-flight read requests queued against this reader
    if (s.pendingReads) {
      while (s.pendingReads.length > 0) s.pendingReads.shift()!.reject(e);
    }
    s.locked = false;
    s.reader = null;
    rr.closedReject?.(e);
    _rr.delete(this);
  }
}

// ---------------------------------------------------------------------------
// ReadableStreamBYOBReader
// ---------------------------------------------------------------------------

/**
 * BYOB reader for byte streams.
 *
 * read(view) fills caller-provided buffers and can wait for a minimum byte
 * count when options.min is supplied.
 *
 * ```typescript no_run
 * const stream = new ReadableStream({ type: 'bytes' });
 * const reader = stream.getReader({ mode: 'byob' });
 * ```
 */
export class ReadableStreamBYOBReader {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(reader); // "[object ReadableStreamBYOBReader]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'ReadableStreamBYOBReader'; }

  /**
   * Create a BYOB reader and lock a byte stream.
   *
   * Throws if the stream is not a byte stream or is already locked.
   *
   * ```typescript no_run
   * const reader = new ReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' });
   * ```
   */
  constructor(stream: ReadableStream) {
    const s = _rs.get(stream);
    if (!s) throw new TypeError('Argument must be a ReadableStream');
    if (s.locked) throw new TypeError('ReadableStream is already locked to a reader');
    if (!s.isByteStream) throw new TypeError('ReadableStreamBYOBReader requires a byte stream (type:"bytes")');

    let closedResolve: (() => void) | undefined;
    let closedReject: ((e: unknown) => void) | undefined;
    const closedPromise = new Promise<void>(function captureBrClosed(res, rej) { closedResolve = res; closedReject = rej; });

    _br.set(this, { rsState: s, closedResolve, closedReject, closedPromise });
    s.locked = true;
    s.reader = this;
  }

  /**
   * Promise resolved when the byte stream closes and rejected on error/release.
   *
   * ```typescript no_run
   * const reader = new ReadableStream({ type: 'bytes' }).getReader({ mode: 'byob' });
   * reader.closed.catch(() => {});
   * ```
   */
  get closed() {
    const br = _br.get(this);
    if (!br) throw new TypeError('ReadableStreamBYOBReader receiver expected');
    return br.closedPromise;
  }

  /**
   * Read bytes into a supplied ArrayBufferView.
   *
   * Rejects for released readers, non-views, zero-length views, or invalid min.
   * Resolves to a Uint8Array view over the filled region.
   *
   * ```typescript no_run
   * const result = await reader.read(new Uint8Array(16), { min: 1 });
   * ```
   */
  read(view: ArrayBufferView, options?: { min?: number }) {
    const br = _br.get(this);
    if (!br) return Promise.reject(new TypeError('Reader is released'));
    if (!ArrayBuffer.isView(view)) return Promise.reject(new TypeError('view must be an ArrayBufferView'));
    if (view.byteLength === 0) return Promise.reject(new TypeError('view byteLength must be > 0'));

    const min = (options?.min != null) ? Number(options.min) : 1;
    if (min < 1)              return Promise.reject(new RangeError('min must be >= 1'));
    if (min > view.byteLength) return Promise.reject(new RangeError('min must be <= view.byteLength'));

    const s = br.rsState;
    let transferredView: ArrayBufferView;
    try {
      transferredView = _transferByteStreamView(view);
    } catch (e) {
      return Promise.reject(e);
    }

    if (s.state === 'closed') {
      br.closedResolve?.();
      return Promise.resolve({
        done:  true,
        value: _byteStreamFilledView(transferredView, 0) as Uint8Array,
      });
    }
    if (s.state === 'errored') return Promise.reject(s.storedError);

    // Try to fill from queued bytes
    if (s.queue!.length > 0) {
      const filled = _rsByobFillFromQueue(s, transferredView, min);
      if (filled !== null) return Promise.resolve({ done: false, value: filled });
    }

    // Park a pull-into descriptor
    return new Promise(function parkByobRead(resolve, reject) {
      s.pendingByob!.push({ view: transferredView, bytesFilled: 0, minFill: min, resolve, reject, request: null });
      _rsPullIfNeeded(s);
    });
  }

  /**
   * Cancel the associated byte stream.
   *
   * ```typescript no_run
   * await reader.cancel('done');
   * ```
   */
  cancel(reason: unknown) {
    const br = _br.get(this);
    if (!br) return Promise.reject(new TypeError('Reader is released'));
    return _rsCancel(br.rsState, reason).then(function brCancelled() { br.closedResolve?.(); });
  }

  /**
   * Release the BYOB reader lock.
   *
   * Pending BYOB reads are rejected.
   *
   * ```typescript no_run
   * reader.releaseLock();
   * ```
   */
  releaseLock() {
    const br = _br.get(this);
    if (!br) return;
    const s = br.rsState;
    if (s.reader !== this) return;
    // Reject any pending BYOB reads before releasing the lock.
    const releaseErr = new TypeError('Reader was released before the read completed');
    while (s.pendingByob!.length > 0) {
      const desc = s.pendingByob!.shift()!;
      desc.reject(releaseErr);
    }
    s.locked = false;
    s.reader = null;
    br.closedReject?.(new TypeError('Reader was released before the stream closed'));
  }
}

// ---------------------------------------------------------------------------
// WritableStream internal helpers
// ---------------------------------------------------------------------------

function _wsMakeState(kind: WritableStreamState['kind'], extra: Partial<WritableStreamState>): WritableStreamState {
  let closedResolve: (() => void) | undefined;
  let closedReject: ((e: unknown) => void) | undefined;
  const closedPromise = new Promise<void>(function captureWsClosed(res, rej) { closedResolve = res; closedReject = rej; });
  return {
    kind,
    state: 'writable',
    storedError: null,
    locked: false,
    writer: null,
    closedResolve, closedReject, closedPromise,
    // ready promise (backpressure) — starts resolved; only meaningful for 'sink' kind
    readyPromise: Promise.resolve(),
    readyResolve: null, // non-null while ready is pending (backpressure active)
    readyReject: null,
    ...extra,
  };
}

function _wsMarkClosed(s: WritableStreamState): void {
  if (s.state === 'closed') return;
  s.state = 'closed';
  s.closedResolve?.();
  // Resolve ready if it was pending (stream is done, no more writes)
  _wsResolveReady(s);
}

function _wsMakeReadyPending(s: WritableStreamState): void {
  if (s.readyResolve !== null) return; // already pending
  s.readyPromise = new Promise(function captureWsReady(resolve, reject) { s.readyResolve = resolve; s.readyReject = reject; });
}

function _wsResolveReady(s: WritableStreamState): void {
  if (s.readyResolve === null) return; // already resolved
  s.readyResolve();
  s.readyResolve = null;
  s.readyReject = null;
  s.readyPromise = Promise.resolve();
}

function _wsRejectReadyForRelease(s: WritableStreamState, reason: unknown): void {
  if (s.readyReject === null) return;
  s.readyReject(reason);
  s.readyResolve = null;
  s.readyReject = null;
  s.readyPromise = Promise.resolve();
  if (s.kind === 'sink' && s.state === 'writable' && s.queueTotalSize! > s.highWaterMark!) {
    _wsMakeReadyPending(s);
  }
}

function _wsDesiredSize(s: WritableStreamState): number | null {
  if (s.kind === 'writer') return 1;
  if (s.state === 'errored') return null;
  if (s.state === 'closed') return 0;
  return s.highWaterMark! - s.queueTotalSize!;
}

function _wsError(s: WritableStreamState, reason: unknown): void {
  if (s.state === 'closed' || s.state === 'errored') return;
  s.state       = 'errored';
  s.storedError = reason;
  if (s.pendingWrites) {
    while (s.pendingWrites.length > 0) s.pendingWrites.shift()!.reject(reason);
  }
  s.closedReject?.(reason);
  if (s.errorWaiters) {
    while (s.errorWaiters.length > 0) s.errorWaiters.shift()!(reason);
  }
  if (s.readyReject) {
    s.readyReject(reason);
    s.readyResolve = null;
    s.readyReject = null;
  } else {
    s.readyPromise = Promise.reject(reason);
    s.readyPromise.catch(function observeErroredReady() {});
  }
}

function _wsErrorPromise(s: WritableStreamState): Promise<never> {
  if (s.state === 'errored') return Promise.reject(s.storedError);
  return new Promise<never>(function waitForWritableError(_, reject) {
    if (!s.errorWaiters) s.errorWaiters = [];
    s.errorWaiters.push(reject);
  });
}

function _wsAbort(s: WritableStreamState, reason: unknown): Promise<void> {
  if (s.state === 'closed' || s.state === 'errored') return Promise.resolve();
  s.controller?._abort(reason);
  _wsError(s, reason);
  if (s.kind === 'sink' && s.underlyingSink?.abort) {
    return Promise.resolve()
      .then(function wsCallAbort() { return s.underlyingSink.abort(reason); })
      .catch(function wsAbortFailed(e) { throw e; });
  }
  return Promise.resolve();
}

function _wsWriteInternal(s: WritableStreamState, chunk: any, writer?: WritableStreamDefaultWriter): Promise<void> {
  if (s.state === 'errored')  return Promise.reject(s.storedError);
  if (s.state !== 'writable') return Promise.reject(new TypeError('WritableStream is not writable'));
  if (s.kind === 'writer')    return Promise.resolve(s.sink.write(chunk));

  // Sink path: compute size, apply backpressure
  let size: number;
  try {
    size = s.sizeAlgorithm ? s.sizeAlgorithm(chunk) : 1;
  } catch (e) {
    _wsError(s, e);
    return Promise.reject(e);
  }
  if (writer && s.writer !== writer) {
    return Promise.reject(new TypeError('Writer was released before write() completed'));
  }
  if (s.state === 'errored') return Promise.reject(s.storedError);
  if (s.state !== 'writable') return Promise.reject(new TypeError('WritableStream is not writable'));
  s.queueTotalSize! += size;
  if (s.queueTotalSize! >= s.highWaterMark!) {
    _wsMakeReadyPending(s);
  }

  // Serialise writes: run immediately if idle, queue otherwise
  if (!s.writing) {
    s.writing = true;
    return _wsDoSinkWrite(s, chunk, size);
  }
  return new Promise(function parkWrite(resolve, reject) {
    s.pendingWrites!.push({ chunk, size, resolve, reject });
  });
}

function _wsDoSinkWrite(s: WritableStreamState, chunk: any, size: number, deferAfterWrite = false): Promise<void> {
  let writeResult: unknown;
  try {
    writeResult = s.underlyingSink.write
      ? s.underlyingSink.write(chunk, s.controller)
      : undefined;
  } catch (e) {
    writeResult = Promise.reject(e);
  }
  const p = Promise.resolve(writeResult);
  const settled = deferAfterWrite ? Promise.resolve().then(function wsDeferAfterWrite() { return p; }) : p;
  return settled.then(function wsAfterWrite() {
    s.queueTotalSize! -= size;
    if (s.queueTotalSize! < 0) s.queueTotalSize = 0;

    // Resolve backpressure if we're back below HWM
    if (s.queueTotalSize! < s.highWaterMark!) _wsResolveReady(s);

    if (s.pendingWrites!.length > 0) {
      const entry = s.pendingWrites!.shift()!;
      if (entry.drain) {
        s.writing = false;
        entry.resolve();
      } else {
        _wsDoSinkWrite(s, entry.chunk, entry.size, true).then(entry.resolve).catch(entry.reject);
      }
    } else {
      s.writing = false;
    }
  }).catch(function wsWriteError(e) {
    s.queueTotalSize! -= size;
    if (s.queueTotalSize! < 0) s.queueTotalSize = 0;
    s.writing = false;
    _wsError(s, e);
    throw e;
  });
}

async function _wsCloseInternal(s: WritableStreamState): Promise<void> {
  if (s.state === 'closed')   return;
  if (s.state === 'closing')  throw new TypeError('WritableStream is already closing');
  if (s.state === 'errored')  throw s.storedError;
  s.state = 'closing';

  // Wait for all in-flight writes to drain
  if (s.kind === 'sink' && s.writing) {
    await new Promise<void>(function drainWrites(resolve, reject) {
      s.pendingWrites!.push({ drain: true, size: 0, chunk: null, resolve, reject });
    });
  }

  if (s.kind === 'writer') {
    s.sink.close();
  } else if (s.underlyingSink?.close) {
    try {
      await Promise.resolve().then(function wsCallClose() { return s.underlyingSink.close(); });
    } catch (e) {
      _wsError(s, e);
      throw e;
    }
  }
  _wsMarkClosed(s);
}

// ---------------------------------------------------------------------------
// WritableStreamDefaultController
// ---------------------------------------------------------------------------

/**
 * Controller passed to WritableStream underlying sinks.
 *
 * It exposes an abort signal and lets the sink error the stream.
 *
 * ```typescript no_run
 * const stream = new WritableStream({ start(controller) { controller.signal; } });
 * ```
 */
export class WritableStreamDefaultController {
  /**
   * Private property `#abortCtrl` used by `WritableStreamDefaultController`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #abortCtrl = undefined;
   *
   *   readInternalState() {
   *     return this.#abortCtrl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #abortCtrl: AbortController;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(controller); // "[object WritableStreamDefaultController]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'WritableStreamDefaultController'; }

  /**
   * Internal constructor bound to a WritableStream state record.
   *
   * ```typescript no_run
   * new WritableStream({ start(controller) { controller.signal; } });
   * ```
   *
   * @internal
   */
  constructor(wsState: WritableStreamState) {
    this.#abortCtrl = new AbortController();
    _wc.set(this, wsState);
  }

  /**
   * AbortSignal that fires when the writable stream aborts.
   *
   * ```typescript no_run
   * new WritableStream({ start(controller) { controller.signal.aborted; } });
   * ```
   */
  get signal()      { return this.#abortCtrl.signal; }

  /**
   * Abort reason from the controller signal.
   *
   * Undefined before the stream aborts.
   *
   * ```typescript no_run
   * new WritableStream({ start(controller) { controller.abortReason; } });
   * ```
   */
  get abortReason() { return this.#abortCtrl.signal.reason; }

  /**
   * Error the writable stream.
   *
   * Pending and future writes reject with the reason.
   *
   * ```typescript no_run
   * new WritableStream({ start(controller) { controller.error('stop'); } });
   * ```
   */
  error(reason: unknown) {
    _wsError(_wc.get(this)!, reason);
  }

  /**
   * Abort this controller's signal.
   *
   * Called by the writable abort path after stream state is updated.
   *
   * ```typescript no_run
   * controller._abort('stop');
   * ```
   *
   * @internal
   */
  _abort(reason: unknown) { this.#abortCtrl.abort(reason); }
}

// ---------------------------------------------------------------------------
// WritableStream
// ---------------------------------------------------------------------------

/**
 * WHATWG WritableStream implementation with sink and Fino Writer backends.
 *
 * Sink-backed streams serialize writes through an underlyingSink. Writer-backed
 * streams delegate directly to a Fino Writer for low overhead.
 *
 * ```typescript no_run
 * const stream = new WritableStream({ write(chunk) { console.log(chunk); } });
 * ```
 */
export class WritableStream {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new WritableStream()); // "[object WritableStream]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'WritableStream'; }

  /**
   * Create a writable stream from an underlying sink or Fino Writer.
   *
   * start(controller), write(chunk, controller), close(), and abort(reason)
   * hooks are supported for sink objects.
   *
   * ```typescript no_run
   * const stream = new WritableStream({ write(chunk) { console.log(chunk); } });
   * ```
   */
  constructor(underlyingSink?: any, queuingStrategy?: QueuingStrategyLike) {
    // Fast path: if the sink is a Fino Writer, bypass all controller machinery.
    if (underlyingSink instanceof Writer) {
      _ws.set(this, _wsMakeState('writer', { sink: underlyingSink }));
      return;
    }

    const sink = underlyingSink ?? {};
    const startMethod = _extractSinkMethod(sink, 'start');
    const writeMethod = _extractSinkMethod(sink, 'write');
    const closeMethod = _extractSinkMethod(sink, 'close');
    const abortMethod = _extractSinkMethod(sink, 'abort');
    const sinkAlgorithms: WritableSinkAlgorithms = {
      ...(startMethod ? { start: (controller) => startMethod.call(sink, controller) } : {}),
      ...(writeMethod ? { write: (chunk, controller) => writeMethod.call(sink, chunk, controller) } : {}),
      ...(closeMethod ? { close: () => closeMethod.call(sink) } : {}),
      ...(abortMethod ? { abort: (reason) => abortMethod.call(sink, reason) } : {}),
    };
    const { highWaterMark, sizeAlgorithm } = _extractStrategy(queuingStrategy, 1);
    const s = _wsMakeState('sink', {
      underlyingSink: sinkAlgorithms,
      pendingWrites: [],
      writing: false,
      highWaterMark,
      sizeAlgorithm,
      queueTotalSize: 0,
      controller: null,
    });
    const controller = new WritableStreamDefaultController(s);
    s.controller = controller;
    _ws.set(this, s);
    if (highWaterMark <= 0) _wsMakeReadyPending(s);

    const startResult = s.underlyingSink.start
      ? Promise.resolve(s.underlyingSink.start(controller))
      : Promise.resolve();
    startResult.catch(function wsStartError(e) { controller.error(e); });
  }

  /**
   * Whether the stream is locked to a writer or pipe operation.
   *
   * ```typescript no_run
   * new WritableStream().locked; // false
   * ```
   */
  get locked() {
    const s = _ws.get(this);
    if (!s) throw new TypeError('WritableStream receiver expected');
    return s.locked;
  }

  /**
   * Close the writable stream after queued writes finish.
   *
   * Rejects when locked, already closing, or errored.
   *
   * ```typescript no_run
   * const stream = new WritableStream();
   * await stream.close();
   * ```
   */
  close() {
    const s = _ws.get(this)!;
    if (s.locked) return Promise.reject(new TypeError('WritableStream is locked'));
    return _wsCloseInternal(s);
  }

  /**
   * Abort the writable stream with a reason.
   *
   * Rejects if the stream is locked. Calls underlyingSink.abort when provided.
   *
   * ```typescript no_run
   * const stream = new WritableStream();
   * await stream.abort('stop');
   * ```
   */
  abort(reason: unknown) {
    const s = _ws.get(this)!;
    if (s.locked) return Promise.reject(new TypeError('Cannot abort a locked WritableStream'));
    return _wsAbort(s, reason);
  }

  /**
   * Acquire a default writer and lock the stream.
   *
   * Throws when the stream is already locked.
   *
   * ```typescript no_run
   * const writer = new WritableStream().getWriter();
   * writer.releaseLock();
   * ```
   */
  getWriter() {
    const s = _ws.get(this)!;
    if (s.locked) throw new TypeError('WritableStream is already locked to a writer');
    const writer = new WritableStreamDefaultWriter(this);
    s.locked = true;
    s.writer = writer;
    return writer;
  }
}

// ---------------------------------------------------------------------------
// WritableStreamDefaultWriter
// ---------------------------------------------------------------------------

/**
 * Default writer for WritableStream.
 *
 * Writers expose backpressure through ready and desiredSize and release the
 * stream lock with releaseLock().
 *
 * ```typescript no_run
 * const writer = new WritableStream().getWriter();
 * await writer.write('x');
 * ```
 */
export class WritableStreamDefaultWriter {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(writer); // "[object WritableStreamDefaultWriter]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'WritableStreamDefaultWriter'; }

  /**
   * Create a writer and lock the stream.
   *
   * Throws if the argument is not a WritableStream or is already locked.
   *
   * ```typescript no_run
   * const writer = new WritableStreamDefaultWriter(new WritableStream());
   * ```
   */
  constructor(stream: WritableStream) {
    const s = _ws.get(stream);
    if (!s) throw new TypeError('Argument must be a WritableStream');
    if (s.locked) throw new TypeError('WritableStream is already locked to a writer');

    let closedResolve: (() => void) | undefined;
    let closedReject: ((e: unknown) => void) | undefined;
    const closedPromise = new Promise<void>(function captureWwClosed(res, rej) { closedResolve = res; closedReject = rej; });

    _ww.set(this, { wsState: s, closedResolve, closedReject, closedPromise });
    s.locked = true;
    s.writer = this;
  }

  /**
   * Promise resolved when the stream closes and rejected on error/release.
   *
   * ```typescript no_run
   * const writer = new WritableStream().getWriter();
   * writer.closed.catch(() => {});
   * ```
   */
  get closed() {
    const ww = _ww.get(this);
    if (!ww) throw new TypeError('WritableStreamDefaultWriter receiver expected');
    return ww.closedPromise;
  }

  /**
   * Remaining queue capacity before backpressure applies.
   *
   * Returns null for errored streams and 0 for closed streams.
   *
   * ```typescript no_run
   * const writer = new WritableStream().getWriter();
   * writer.desiredSize;
   * ```
   */
  get desiredSize() {
    const ww = _ww.get(this);
    if (!ww) return null;
    const s = ww.wsState;
    if (s.kind === 'writer') return 1;
    if (s.state === 'errored') return null;
    if (s.state === 'closed')  return 0;
    return s.highWaterMark! - s.queueTotalSize!;
  }

  /**
   * Promise that resolves when backpressure clears.
   *
   * ```typescript no_run
   * await writer.ready;
   * ```
   */
  get ready() {
    const ww = _ww.get(this);
    if (!ww) return Promise.resolve();
    return ww.wsState.readyPromise;
  }

  /**
   * Write a chunk to the stream.
   *
   * Rejects if the writer is released or the stream is not writable.
   *
   * ```typescript no_run
   * const writer = new WritableStream().getWriter();
   * await writer.write('chunk');
   * ```
   */
  write(chunk: any) {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsWriteInternal(ww.wsState, chunk, this);
  }

  /**
   * Close the stream through this writer.
   *
   * Resolves writer.closed on success and rejects it on close failure.
   *
   * ```typescript no_run
   * await writer.close();
   * ```
   */
  close() {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsCloseInternal(ww.wsState)
      .then(function wwClosed() { ww.closedResolve?.(); })
      .catch(function wwCloseFailed(e) { ww.closedReject?.(e); throw e; });
  }

  /**
   * Abort the stream through this writer.
   *
   * ```typescript no_run
   * await writer.abort('stop');
   * ```
   */
  abort(reason: unknown) {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsAbort(ww.wsState, reason);
  }

  /**
   * Release the writer lock.
   *
   * The writer's closed promise rejects because the writer no longer observes
   * stream closure.
   *
   * ```typescript no_run
   * writer.releaseLock();
   * ```
   */
  releaseLock() {
    const ww = _ww.get(this);
    if (!ww) return;
    const s = ww.wsState;
    if (s.writer !== this) return;
    s.locked = false;
    s.writer = null;
    const releaseErr = new TypeError('Writer was released before the stream closed');
    _wsRejectReadyForRelease(s, releaseErr);
    ww.closedReject?.(releaseErr);
    _ww.delete(this);
  }
}

// ---------------------------------------------------------------------------
// TransformStreamDefaultController
// ---------------------------------------------------------------------------

/**
 * Controller passed to TransformStream transformer callbacks.
 *
 * It can enqueue transformed chunks, terminate the readable side, or error the
 * transform output.
 *
 * ```typescript no_run
 * const stream = new TransformStream({
 *   transform(chunk, controller) { controller.enqueue(chunk); },
 * });
 * ```
 */
export class TransformStreamDefaultController {
  /**
   * Private property `#rsState` used by `TransformStreamDefaultController`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rsState = undefined;
   *
   *   readInternalState() {
   *     return this.#rsState;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #rsState: ReadableStreamState | null = null;
  #errorAlgorithm: ((reason: unknown) => void) | null = null;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(controller); // "[object TransformStreamDefaultController]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'TransformStreamDefaultController'; }

  /**
   * Internal constructor bound to the transform output channel.
   *
   * User code receives controllers from transformer callbacks.
   *
   * ```typescript no_run
   * new TransformStream({ start(controller) { controller.desiredSize; } });
   * ```
   *
   * @internal
   */
  constructor(channel: Channel) {
    _tc.set(this, channel);
  }

  /**
   * Attach readable state so desiredSize reflects readable backpressure.
   *
   * Used when a readable strategy creates a source-backed readable side.
   *
   * ```typescript no_run
   * controller._setReadableState(undefined);
   * ```
   *
   * @internal
   */
  _setReadableState(rsState: ReadableStreamState | undefined) { this.#rsState = rsState ?? null; }

  /**
   * Attach the owning TransformStream's error propagation hook.
   *
   * ```typescript no_run
   * controller._setErrorAlgorithm(undefined);
   * ```
   *
   * @internal
   */
  _setErrorAlgorithm(algorithm: ((reason: unknown) => void) | undefined) {
    this.#errorAlgorithm = algorithm ?? null;
  }

  /**
   * Desired readable-side queue size.
   *
   * Returns 1 before a readable state is attached.
   *
   * ```typescript no_run
   * new TransformStream({ transform(chunk, controller) { controller.desiredSize; } });
   * ```
   */
  get desiredSize() {
    if (this.#rsState) return _rsDesiredSize(this.#rsState);
    return 1;
  }

  /**
   * Enqueue a transformed chunk to the readable side.
   *
   * ```typescript no_run
   * new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } });
   * ```
   */
  enqueue(chunk: any)  {
    if (this.#rsState?.controller instanceof ReadableStreamDefaultController) {
      try {
        this.#rsState.controller.enqueue(chunk);
      } catch (e) {
        this.#errorAlgorithm?.(e);
        throw e;
      }
      return;
    }
    _tc.get(this)!.enqueue(chunk);
  }

  /**
   * Close the readable side immediately.
   *
   * ```typescript no_run
   * new TransformStream({ transform(_chunk, controller) { controller.terminate(); } });
   * ```
   */
  terminate()     {
    if (this.#rsState?.controller instanceof ReadableStreamDefaultController) {
      this.#rsState.controller.close();
      return;
    }
    _tc.get(this)!.close();
  }

  /**
   * Error the readable side with a reason.
   *
   * ```typescript no_run
   * new TransformStream({ transform(_chunk, controller) { controller.error('stop'); } });
   * ```
   */
  error(reason: unknown)   {
    if (this.#rsState?.controller instanceof ReadableStreamDefaultController) {
      this.#rsState.controller.error(reason);
    } else {
      _tc.get(this)!.error(reason);
    }
    this.#errorAlgorithm?.(reason);
  }
}

// ---------------------------------------------------------------------------
// TransformStream
// ---------------------------------------------------------------------------

/**
 * WHATWG TransformStream composed of writable and readable sides.
 *
 * Transformer callbacks can start, transform chunks, and flush before closing.
 * Without a transform callback, chunks pass through unchanged.
 *
 * ```typescript no_run
 * const upper = new TransformStream({
 *   transform(chunk, controller) { controller.enqueue(String(chunk).toUpperCase()); },
 * });
 * ```
 */
export class TransformStream {
  /**
   * Private property `#readable` used by `TransformStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readable = undefined;
   *
   *   readInternalState() {
   *     return this.#readable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readable: ReadableStream;
  /**
   * Private property `#writable` used by `TransformStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writable = undefined;
   *
   *   readInternalState() {
   *     return this.#writable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writable: WritableStream;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new TransformStream()); // "[object TransformStream]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'TransformStream'; }

  /**
   * Create a transform stream.
   *
   * transformer.start receives the controller, transformer.transform handles
   * each written chunk, and transformer.flush runs before readable closure.
   * Strategies apply to the writable and readable sides respectively.
   *
   * ```typescript no_run
   * const stream = new TransformStream({
   *   transform(chunk, controller) { controller.enqueue(chunk); },
   * });
   * ```
   */
  constructor(transformer?: any, writableStrategy?: QueuingStrategyLike, readableStrategy?: QueuingStrategyLike) {
    const channel    = createChannel();
    const controller = new TransformStreamDefaultController(channel);

    const transform = transformer?.transform ?? null;
    const flush     = transformer?.flush     ?? null;
    const cancel    = transformer?.cancel    ?? null;
    let writableState: WritableStreamState | undefined;
    let controllerErrored = false;
    let controllerErrorReason: unknown;
    let cancelStarted = false;
    let cancelPromise: Promise<void> | null = null;
    let cancelOverride: unknown;
    let hasCancelOverride = false;
    let readableState: ReadableStreamState | undefined;
    const backpressureWaiters: Array<() => void> = [];

    controller._setErrorAlgorithm(function transformControllerErrored(reason) {
      controllerErrored = true;
      controllerErrorReason = reason;
      if (writableState) _wsError(writableState, reason);
    });

    const runCancel = (reason: unknown): Promise<void> => {
      if (cancelPromise) return cancelPromise;
      cancelStarted = true;
      let result: unknown;
      try {
        result = cancel ? cancel.call(transformer, reason) : undefined;
      } catch (e) {
        channel.error(e);
        if (writableState) _wsError(writableState, e);
        cancelPromise = Promise.reject(e);
        return cancelPromise;
      }
      cancelPromise = Promise.resolve(result).then(function transformCancelDone() {
        if (hasCancelOverride) throw cancelOverride;
        if (controllerErrored) throw controllerErrorReason;
      }).catch(function transformCancelFailed(e) {
        channel.error(e);
        if (writableState) _wsError(writableState, e);
        throw e;
      });
      return cancelPromise;
    };

    const waitForReadableDemand = (): Promise<void> | null => {
      if (!readableState || readableState.state !== 'readable') return null;
      if (readableState.pendingReads!.length > 0) return null;
      const desiredSize = _rsDesiredSize(readableState);
      if (desiredSize !== null && desiredSize > 0) return null;
      return new Promise<void>(function waitForTransformReadableDemand(resolve) {
        backpressureWaiters.push(resolve);
        readableState!.demandCallbacks!.push(resolve);
      });
    };

    const transformChunk = (chunk: any): Promise<void> => {
      if (transform) {
        let result: unknown;
        try {
          result = transform.call(transformer, chunk, controller);
        } catch (e) {
          controller.error(e);
          return Promise.reject(e);
        }
        return Promise.resolve(result).catch(function tsTransformFailed(e) {
          controller.error(e);
          throw e;
        });
      }
      try {
        controller.enqueue(chunk); // identity pass-through
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.resolve();
    };

    this.#writable = new WritableStream({
      start(ctrl: WritableStreamDefaultController) {
      },
      write(chunk: any) {
        const wait = waitForReadableDemand();
        if (!wait) return transformChunk(chunk);
        return wait.then(function transformAfterBackpressure() { return transformChunk(chunk); });
      },
      close() {
        if (cancelPromise) return cancelPromise;
        if (cancelStarted || controllerErrored) {
          return Promise.reject(controllerErrored ? controllerErrorReason : undefined);
        }
        let result: unknown;
        try {
          result = flush ? flush.call(transformer, controller) : undefined;
        } catch (e) {
          controller.error(e);
          return Promise.reject(e);
        }
        return Promise.resolve(result)
          .then(function tsCloseChannel() { channel.close(); })
          .catch(function tsFlushFailed(e) {
            controller.error(e);
            throw e;
          });
      },
      abort(reason: unknown) {
        if (cancelStarted && cancelPromise) {
          hasCancelOverride = true;
          cancelOverride = reason;
          channel.error(reason);
          return Promise.reject(reason);
        }
        return runCancel(reason).then(function transformAbortDone() {
          if (!controllerErrored) channel.error(reason);
        });
      },
    }, writableStrategy);
    writableState = _ws.get(this.#writable);

    // Use a source-backed readable side so cancel(reason), strategies, and
    // desiredSize all flow through the TransformStream algorithms.
    const chIter = channel[Symbol.asyncIterator]();
    this.#readable = new ReadableStream({
      pull(ctrl: ReadableStreamDefaultController) {
        const queued = channel.dequeue?.();
        if (queued !== null && queued !== undefined) {
          if (queued.done) ctrl.close();
          else ctrl.enqueue(queued.value);
          return;
        }
        if (backpressureWaiters.length > 0) {
          while (backpressureWaiters.length > 0) backpressureWaiters.shift()!();
          return;
        }
        return chIter.next().then(function tsChannelPull({ done, value }: IteratorResult<any, any>) {
          if (done) ctrl.close();
          else ctrl.enqueue(value);
        });
      },
      cancel(reason: unknown) {
        return runCancel(reason);
      },
    }, readableStrategy ?? { highWaterMark: 0 });
    readableState = _rs.get(this.#readable);
    controller._setReadableState(readableState);

    if (transformer?.start) {
      try {
        Promise.resolve(transformer.start.call(transformer, controller))
          .catch(function transformStartFailed(e) { controller.error(e); });
      } catch (e) {
        controller.error(e);
      }
    }
  }

  /**
   * Readable side that emits transformed chunks.
   *
   * ```typescript no_run
   * const stream = new TransformStream();
   * stream.readable;
   * ```
   */
  get readable() { return this.#readable; }

  /**
   * Writable side that accepts input chunks.
   *
   * ```typescript no_run
   * const stream = new TransformStream();
   * stream.writable;
   * ```
   */
  get writable() { return this.#writable; }
}
