/**
 * boats:webstreams — ReadableStream, WritableStream, TransformStream
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
 *   - kind: 'writer' — backed by a Boats Writer (write/close). Writes delegate
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
 * ## Exports
 *
 * ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController
 * ReadableStreamBYOBReader, ReadableStreamBYOBRequest, ReadableByteStreamController
 * WritableStream, WritableStreamDefaultWriter, WritableStreamDefaultController
 * TransformStream, TransformStreamDefaultController
 * CountQueuingStrategy, ByteLengthQueuingStrategy
 */

import { Writer } from 'internal:stream';
import { AbortController } from 'internal:globals/abort';

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface QueueEntry { value: any; size: number; }

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
  reader: ReadableStreamDefaultReader | ReadableStreamBYOBReader | null;
  closedResolve: (() => void) | undefined;
  closedReject:  ((e: unknown) => void) | undefined;
  closedPromise: Promise<void>;
  // iterable-kind fields
  source?: AsyncIterable<any>;
  _iter?: AsyncIterator<any>;
  // source-kind fields
  underlyingSource?: any;
  queue?: QueueEntry[];
  queueTotalSize?: number;
  pendingReads?: Array<{ resolve: (r: { done: boolean; value: any }) => void; reject: (e: unknown) => void }>;
  pendingByob?: PullIntoDescriptor[];
  pulling?: boolean;
  pullAgain?: boolean;
  started?: boolean;
  closeRequested?: boolean;
  highWaterMark?: number;
  sizeAlgorithm?: ((chunk: any) => number) | null;
  isByteStream?: boolean;
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
  readyPromise: Promise<void>;
  readyResolve: (() => void) | null;
  // writer-kind fields
  sink?: any;
  // sink-kind fields
  underlyingSink?: any;
  pendingWrites?: Array<{ chunk: any; size: number; drain?: boolean; resolve: () => void; reject: (e: unknown) => void }>;
  writing?: boolean;
  highWaterMark?: number;
  sizeAlgorithm?: ((chunk: any) => number) | null;
  queueTotalSize?: number;
  controller?: WritableStreamDefaultController | null;
}

interface Channel {
  enqueue(value: any): void;
  close(): void;
  error(reason: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

// ---------------------------------------------------------------------------
// Internal state WeakMaps
// ---------------------------------------------------------------------------

const _rs  = new WeakMap<ReadableStream, ReadableStreamState>();  // ReadableStream                  → state
const _ws  = new WeakMap<WritableStream, WritableStreamState>();  // WritableStream                  → state
const _rr  = new WeakMap<ReadableStreamDefaultReader, any>();     // ReadableStreamDefaultReader     → state
const _br  = new WeakMap<ReadableStreamBYOBReader, any>();        // ReadableStreamBYOBReader        → state
const _ww  = new WeakMap<WritableStreamDefaultWriter, any>();     // WritableStreamDefaultWriter     → state
const _rc  = new WeakMap<ReadableStreamDefaultController, ReadableStreamState>();  // ReadableStreamDefaultController → rs-state ref
const _rbc = new WeakMap<ReadableByteStreamController, ReadableStreamState>();    // ReadableByteStreamController    → rs-state ref
const _wc  = new WeakMap<WritableStreamDefaultController, WritableStreamState>(); // WritableStreamDefaultController → ws-state ref
const _tc  = new WeakMap<TransformStreamDefaultController, Channel>();            // TransformStreamDefaultController → channel

// ---------------------------------------------------------------------------
// Channel — promise-based async-iterable queue (used by TransformStream)
// ---------------------------------------------------------------------------

function createChannel() {
  const queue = [];
  let pending = null;
  let closed  = false;
  let errored = null;

  return {
    enqueue(value) {
      if (errored != null || closed) return;
      if (pending) { const p = pending; pending = null; p.resolve({ done: false, value }); }
      else queue.push(value);
    },
    close() {
      if (errored != null || closed) return;
      closed = true;
      if (pending) { const p = pending; pending = null; p.resolve({ done: true, value: undefined }); }
    },
    error(reason) {
      if (errored != null || closed) return;
      errored = reason;
      if (pending) { const p = pending; pending = null; p.reject(reason); }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() });
          if (errored != null) return Promise.reject(errored);
          if (closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => { pending = { resolve, reject }; });
        },
        return() {
          closed = true;
          if (pending) { const p = pending; pending = null; p.resolve({ done: true, value: undefined }); }
          return Promise.resolve({ done: true, value: undefined });
        },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Queuing strategies
// ---------------------------------------------------------------------------

export class CountQueuingStrategy {
  highWaterMark: number;
  get [Symbol.toStringTag]() { return 'CountQueuingStrategy'; }
  constructor({ highWaterMark }: { highWaterMark: number }) {
    this.highWaterMark = Number(highWaterMark);
  }

  size(): number { return 1; }
}

export class ByteLengthQueuingStrategy {
  highWaterMark: number;
  get [Symbol.toStringTag]() { return 'ByteLengthQueuingStrategy'; }
  constructor({ highWaterMark }: { highWaterMark: number }) {
    this.highWaterMark = Number(highWaterMark);
  }

  size(chunk: ArrayBufferView): number { return chunk.byteLength; }
}

function _extractStrategy(strategy, defaultHWM) {
  if (strategy == null) return { highWaterMark: defaultHWM, sizeAlgorithm: () => 1 };
  const hwm = (strategy.highWaterMark != null) ? Number(strategy.highWaterMark) : defaultHWM;
  const size = (typeof strategy.size === 'function') ? strategy.size.bind(strategy) : () => 1;
  return { highWaterMark: hwm, sizeAlgorithm: size };
}

// ---------------------------------------------------------------------------
// ReadableStream internal helpers
// ---------------------------------------------------------------------------

function _rsMakeState(kind, extra) {
  let closedResolve, closedReject;
  const closedPromise = new Promise((res, rej) => { closedResolve = res; closedReject = rej; });
  return {
    kind,
    state: 'readable',
    storedError: null,
    locked: false,
    reader: null,
    closedResolve, closedReject, closedPromise,
    ...extra,
  };
}

function _rsMarkClosed(s) {
  if (s.state === 'closed') return;
  s.state = 'closed';
  s.closedResolve?.();
  if (s.pendingReads) {
    while (s.pendingReads.length > 0)
      s.pendingReads.shift().resolve({ done: true, value: undefined });
  }
  // Resolve pending BYOB reads with done:true and whatever was filled
  if (s.pendingByob) {
    while (s.pendingByob.length > 0) {
      const desc = s.pendingByob.shift();
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

function _rsMarkErrored(s, e) {
  if (s.state === 'errored' || s.state === 'closed') return;
  s.state = 'errored';
  s.storedError = e;
  s.closedReject?.(e);
  if (s.pendingReads) {
    while (s.pendingReads.length > 0) s.pendingReads.shift().reject(e);
  }
  if (s.pendingByob) {
    while (s.pendingByob.length > 0) {
      const desc = s.pendingByob.shift();
      desc.request = null;
      desc.reject(e);
    }
  }
}

function _rsCancel(s, reason) {
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
      return Promise.resolve(s._iter.return(reason)).then(() => {});
    }
  }
  if (s.kind === 'source' && s.underlyingSource?.cancel) {
    return Promise.resolve(s.underlyingSource.cancel(reason));
  }
  return Promise.resolve();
}

function _rsDesiredSize(s) {
  if (s.state === 'errored') return null;
  if (s.state === 'closed')  return 0;
  return s.highWaterMark - s.queueTotalSize;
}

// Pull algorithm — calls pull when the stream has capacity or pending reads.
// Spec: ReadableStreamDefaultControllerCallPullIfNeeded /
//       ReadableByteStreamControllerCallPullIfNeeded
function _rsPullIfNeeded(s) {
  if (!s.started || s.state !== 'readable') return;
  if (s.closeRequested) return;
  if (s.pulling) { s.pullAgain = true; return; }

  // Should pull if desiredSize > 0 (fill queue) OR there are pending consumers
  const hasPendingReads = s.pendingReads && s.pendingReads.length > 0;
  const hasPendingByob  = s.pendingByob  && s.pendingByob.length  > 0;
  if (_rsDesiredSize(s) <= 0 && !hasPendingReads && !hasPendingByob) return;

  s.pulling    = true;
  s.pullAgain  = false;
  Promise.resolve(s.underlyingSource.pull ? s.underlyingSource.pull(s.controller) : undefined)
    .then(() => {
      s.pulling = false;
      if (s.pullAgain) { s.pullAgain = false; _rsPullIfNeeded(s); }
    })
    .catch(e => s.controller.error(e));
}

// Read the next {done, value} from a source-backed stream's queue/pending list.
function _rsIterableIterator(s) {
  if (!s._iter) {
    if (s.source[Symbol.asyncIterator]) {
      s._iter = s.source[Symbol.asyncIterator]();
    } else if (s.source[Symbol.iterator]) {
      const syncIter = s.source[Symbol.iterator]();
      s._iter = { next: () => Promise.resolve(syncIter.next()), return: syncIter.return ? (v) => Promise.resolve(syncIter.return(v)) : undefined };
    } else {
      throw new TypeError('ReadableStream.from: argument must be iterable');
    }
  }
  return s._iter;
}

function _rsNextChunk(s) {
  if (s.kind === 'iterable') {
    const iter = _rsIterableIterator(s);
    return iter.next().then(r => {
      if (r.done) _rsMarkClosed(s);
      return r;
    }, e => { _rsMarkErrored(s, e); return Promise.reject(e); });
  }

  // Source path: dequeue or park a pending read
  if (s.queue.length > 0) {
    const entry = s.queue.shift();
    s.queueTotalSize -= entry.size;
    if (s.queueTotalSize < 0) s.queueTotalSize = 0;
    if (s.closeRequested && s.queue.length === 0) {
      _rsMarkClosed(s);
    } else {
      _rsPullIfNeeded(s);
    }
    return Promise.resolve({ done: false, value: entry.value });
  }

  if (s.state === 'closed')   return Promise.resolve({ done: true,  value: undefined });
  if (s.state === 'errored')  return Promise.reject(s.storedError);

  return new Promise((resolve, reject) => {
    s.pendingReads.push({ resolve, reject });
    _rsPullIfNeeded(s);
  });
}

// Fill a BYOB view from queued Uint8Array chunks. Returns filled Uint8Array slice or null.
function _rsByobFillFromQueue(s, view, min) {
  const dest = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let bytesFilled = 0;
  while (bytesFilled < view.byteLength && s.queue.length > 0) {
    const entry = s.queue[0];
    const available = entry.value.byteLength;
    const needed    = view.byteLength - bytesFilled;
    const toCopy    = Math.min(available, needed);
    dest.set(entry.value.subarray(0, toCopy), bytesFilled);
    bytesFilled += toCopy;
    if (toCopy === available) {
      s.queue.shift();
      s.queueTotalSize -= entry.size;
      if (s.queueTotalSize < 0) s.queueTotalSize = 0;
    } else {
      entry.value = entry.value.subarray(toCopy);
      entry.size  = entry.value.byteLength;
      s.queueTotalSize -= toCopy;
      if (s.queueTotalSize < 0) s.queueTotalSize = 0;
    }
  }
  if (bytesFilled === 0) return null;
  if (bytesFilled < min) return null; // need at least min bytes
  if (s.closeRequested && s.queue.length === 0) {
    _rsMarkClosed(s);
  } else {
    _rsPullIfNeeded(s);
  }
  return new Uint8Array(view.buffer, view.byteOffset, bytesFilled);
}

// ---------------------------------------------------------------------------
// ReadableStreamDefaultController
// ---------------------------------------------------------------------------

export class ReadableStreamDefaultController {
  get [Symbol.toStringTag]() { return 'ReadableStreamDefaultController'; }

  constructor(rsState) {
    _rc.set(this, rsState);
  }

  get desiredSize() {
    return _rsDesiredSize(_rc.get(this));
  }

  enqueue(chunk) {
    const s = _rc.get(this);
    if (s.closeRequested)        throw new TypeError('Cannot enqueue after close()');
    if (s.state !== 'readable')  throw new TypeError('Stream is not readable');
    const size = s.sizeAlgorithm ? s.sizeAlgorithm(chunk) : 1;
    if (s.pendingReads.length > 0) {
      // Fulfill the waiting read directly — no queue needed
      s.pendingReads.shift().resolve({ done: false, value: chunk });
      _rsPullIfNeeded(s);
    } else {
      s.queue.push({ value: chunk, size });
      s.queueTotalSize += size;
    }
  }

  close() {
    const s = _rc.get(this);
    if (s.state !== 'readable') return;
    if (s.closeRequested)       throw new TypeError('close() already called');
    s.closeRequested = true;
    if (s.queue.length === 0) _rsMarkClosed(s);
  }

  error(reason) {
    _rsMarkErrored(_rc.get(this), reason);
  }
}

// ---------------------------------------------------------------------------
// ReadableByteStreamController (for type: 'bytes' underlying sources)
// ---------------------------------------------------------------------------

export class ReadableByteStreamController {
  get [Symbol.toStringTag]() { return 'ReadableByteStreamController'; }

  constructor(rsState) {
    _rbc.set(this, rsState);
  }

  get desiredSize() {
    return _rsDesiredSize(_rbc.get(this));
  }

  get byobRequest() {
    const s = _rbc.get(this);
    if (!s.pendingByob || s.pendingByob.length === 0) return null;
    const desc = s.pendingByob[0];
    if (!desc.request) desc.request = new ReadableStreamBYOBRequest(this, desc);
    return desc.request;
  }

  enqueue(chunk) {
    const s = _rbc.get(this);
    if (s.state !== 'readable') throw new TypeError('Stream is not readable');
    if (s.closeRequested)       throw new TypeError('Cannot enqueue after close()');

    // Normalise to Uint8Array
    let bytes;
    if (chunk instanceof Uint8Array) {
      bytes = chunk;
    } else if (ArrayBuffer.isView(chunk)) {
      bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else if (chunk instanceof ArrayBuffer) {
      bytes = new Uint8Array(chunk);
    } else {
      throw new TypeError('chunk must be an ArrayBufferView or ArrayBuffer');
    }

    // Fill pending BYOB descriptors first
    let offset = 0;
    while (offset < bytes.length && s.pendingByob.length > 0) {
      const desc     = s.pendingByob[0];
      const available = bytes.length - offset;
      const needed    = desc.view.byteLength - desc.bytesFilled;
      const toCopy    = Math.min(available, needed);
      new Uint8Array(desc.view.buffer, desc.view.byteOffset + desc.bytesFilled, toCopy)
        .set(bytes.subarray(offset, offset + toCopy));
      desc.bytesFilled += toCopy;
      offset           += toCopy;

      if (desc.bytesFilled >= desc.minFill) {
        s.pendingByob.shift();
        desc.request = null;
        desc.resolve({
          done:  false,
          value: new Uint8Array(desc.view.buffer, desc.view.byteOffset, desc.bytesFilled),
        });
      }
    }

    // Fill pending default (non-BYOB) reads
    if (offset < bytes.length && s.pendingReads.length > 0) {
      const remaining = bytes.slice(offset);
      offset = bytes.length;
      s.pendingReads.shift().resolve({ done: false, value: remaining });
    }

    // Any leftover bytes go into the queue
    if (offset < bytes.length) {
      const leftover = bytes.slice(offset);
      s.queue.push({ value: leftover, size: leftover.byteLength });
      s.queueTotalSize += leftover.byteLength;
    }

    if (s.closeRequested && s.queue.length === 0 && s.pendingByob.length === 0) {
      _rsMarkClosed(s);
    }
    _rsPullIfNeeded(s);
  }

  close() {
    const s = _rbc.get(this);
    if (s.state !== 'readable') return;
    if (s.closeRequested)       throw new TypeError('close() already called');
    s.closeRequested = true;
    if (s.queue.length === 0 && s.pendingByob.length === 0) {
      _rsMarkClosed(s);
    }
  }

  error(reason) {
    _rsMarkErrored(_rbc.get(this), reason);
  }

  // Called by ReadableStreamBYOBRequest.respond(bytesWritten)
  _byobRespond(bytesWritten, view) {
    const s = _rbc.get(this);
    if (!s.pendingByob || s.pendingByob.length === 0) return;
    const desc = s.pendingByob[0];
    desc.bytesFilled += bytesWritten;
    desc.request      = null;

    if (s.state === 'closed') {
      s.pendingByob.shift();
      desc.resolve({
        done:  true,
        value: new Uint8Array(desc.view.buffer, desc.view.byteOffset, 0),
      });
      return;
    }

    if (desc.bytesFilled >= desc.minFill) {
      s.pendingByob.shift();
      desc.resolve({
        done:  false,
        value: new Uint8Array(desc.view.buffer, desc.view.byteOffset, desc.bytesFilled),
      });
    }
    _rsPullIfNeeded(s);
  }

  // Called by ReadableStreamBYOBRequest.respondWithNewView(view)
  _byobRespondWithNewView(view) {
    const s = _rbc.get(this);
    if (!s.pendingByob || s.pendingByob.length === 0) return;
    const desc = s.pendingByob[0];
    desc.view        = view;
    desc.bytesFilled = view.byteLength;
    desc.request     = null;

    s.pendingByob.shift();
    desc.resolve({ done: s.state === 'closed', value: view });
    _rsPullIfNeeded(s);
  }
}

// ---------------------------------------------------------------------------
// ReadableStreamBYOBRequest
// ---------------------------------------------------------------------------

export class ReadableStreamBYOBRequest {
  #controller: ReadableByteStreamController;
  #desc: PullIntoDescriptor;

  get [Symbol.toStringTag]() { return 'ReadableStreamBYOBRequest'; }

  constructor(controller, desc) {
    this.#controller = controller;
    this.#desc       = desc;
  }

  get view() { return this.#desc.view; }

  respond(bytesWritten) {
    this.#controller._byobRespond(Number(bytesWritten), this.#desc.view);
  }

  respondWithNewView(view) {
    if (!ArrayBuffer.isView(view)) throw new TypeError('view must be an ArrayBufferView');
    this.#controller._byobRespondWithNewView(view);
  }
}

// ---------------------------------------------------------------------------
// ReadableStream
// ---------------------------------------------------------------------------

export class ReadableStream {
  get [Symbol.toStringTag]() { return 'ReadableStream'; }

  constructor(underlyingSource, queuingStrategy) {
    const src         = underlyingSource ?? {};
    const isByteStream = src.type === 'bytes';
    const defaultHWM   = isByteStream ? 0 : 1;
    const { highWaterMark, sizeAlgorithm } = _extractStrategy(queuingStrategy, defaultHWM);

    // Boa 0.21.1 bug workaround: Boa panics with "index out of bounds: the len is 0
    // but the index is 0" (PutLexicalValue) when a class constructor has an if/else
    // where BOTH branches declare block-scoped variables (const/let) that are captured
    // by arrow function closures. The compiler under-allocates the lexical environment
    // for the second block. Fix: hoist s/controller/startResult to constructor scope
    // so closures capture function-level bindings, not block-level ones.
    // See docs/boa-0.21.1-bug-putlexicalvalue.md for the full reproducer.
    let s, controller, startResult;
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
    startResult.then(() => { s.started = true; _rsPullIfNeeded(s); })
               .catch(e => controller.error(e));
  }

  static from(asyncIterable) {
    if (asyncIterable == null ||
        (typeof asyncIterable[Symbol.asyncIterator] !== 'function' &&
         typeof asyncIterable[Symbol.iterator] !== 'function')) {
      throw new TypeError('ReadableStream.from: argument must be an async iterable or iterable');
    }
    const rs = Object.create(ReadableStream.prototype);
    _rs.set(rs, _rsMakeState('iterable', { source: asyncIterable }));
    return rs;
  }

  get locked() { return _rs.get(this).locked; }

  cancel(reason) {
    const s = _rs.get(this);
    if (s.locked) return Promise.reject(new TypeError('ReadableStream is locked to a reader'));
    return _rsCancel(s, reason);
  }

  getReader(options) {
    const s    = _rs.get(this);
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

  [Symbol.asyncIterator]() {
    const s = _rs.get(this);
    if (s.locked) throw new TypeError('ReadableStream is locked');
    s.locked = true;

    const iter = s.kind === 'iterable'
      ? _rsIterableIterator(s)
      : null;

    return {
      next() {
        const read = iter ? iter.next() : _rsNextChunk(s);
        return read.then(r => {
          if (r.done) { s.locked = false; _rsMarkClosed(s); }
          return r;
        }, e => {
          s.locked = false;
          _rsMarkErrored(s, e);
          return Promise.reject(e);
        });
      },
      return(value) {
        s.locked = false;
        if (iter?.return) return iter.return(value);
        return Promise.resolve({ done: true, value });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  async pipeTo(destination, options) {
    const src = _rs.get(this);
    const dst = _ws.get(destination);
    if (!src) return Promise.reject(new TypeError('ReadableStream expected'));
    if (!dst) return Promise.reject(new TypeError('WritableStream expected'));
    if (src.locked) return Promise.reject(new TypeError('ReadableStream is locked'));
    if (dst.locked) return Promise.reject(new TypeError('WritableStream is locked'));

    const preventClose  = Boolean(options?.preventClose);
    const preventAbort  = Boolean(options?.preventAbort);
    const preventCancel = Boolean(options?.preventCancel);
    const signal        = options?.signal ?? null;

    if (signal?.aborted) {
      if (!preventCancel) _rsCancel(src, signal.reason).catch(() => {});
      if (!preventAbort)  _wsAbort(dst, signal.reason).catch(() => {});
      throw signal.reason;
    }

    src.locked = true;
    dst.locked = true;

    // Fast path: iterable-readable + writer-writable — zero Web Streams overhead
    if (src.kind === 'iterable' && dst.kind === 'writer') {
      try {
        const iter = src._iter ??= src.source[Symbol.asyncIterator]();
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
        if (!preventAbort)  await _wsAbort(dst, e).catch(() => {});
        if (!preventCancel) await _rsCancel(src, e).catch(() => {});
        src.locked = false;
        dst.locked = false;
        throw e;
      }
      src.locked = false;
      dst.locked = false;
      return;
    }

    // General pump
    let abortListener = null;
    let abortReject   = null;
    let abortPromise  = null;
    if (signal) {
      abortPromise  = new Promise((_, reject) => { abortReject = reject; });
      abortListener = () => abortReject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
    }

    const pump = async () => {
      while (true) {
        const { done, value } = await _rsNextChunk(src);
        if (done) break;
        await _wsWriteInternal(dst, value);
      }
      if (!preventClose) await _wsCloseInternal(dst);
    };

    try {
      await (abortPromise ? Promise.race([pump(), abortPromise]) : pump());
      _rsMarkClosed(src);
    } catch (e) {
      _rsMarkErrored(src, e);
      if (!preventAbort)  await _wsAbort(dst, e).catch(() => {});
      if (!preventCancel) await _rsCancel(src, e).catch(() => {});
      throw e;
    } finally {
      src.locked = false;
      dst.locked = false;
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  pipeThrough(transform, options) {
    const { readable, writable } = transform ?? {};
    if (!(readable instanceof ReadableStream))
      throw new TypeError('transform.readable must be a ReadableStream');
    const dstState = _ws.get(writable);
    if (!dstState) throw new TypeError('transform.writable must be a WritableStream');
    const s = _rs.get(this);
    if (s.locked) throw new TypeError('ReadableStream is locked');
    if (dstState.locked) throw new TypeError('transform.writable is locked');

    this.pipeTo(writable, options).catch(() => {});
    return readable;
  }

  tee() {
    const s = _rs.get(this);
    if (s.locked) throw new TypeError('ReadableStream is locked');
    s.locked = true;

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
        _rsCancel(s, [cancelReason1, cancelReason2]).catch(() => {});
        s.locked = false;
      }
    }

    // Wrap a channel in an iterable that intercepts return() to notify tee.
    function makeTeeIterable(ch, branchIndex: number) {
      return {
        [Symbol.asyncIterator]() {
          const iter = ch[Symbol.asyncIterator]();
          return {
            next() { return iter.next(); },
            return(value) {
              onBranchCancel(branchIndex, value);
              return iter.return(value);
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
      };
    }

    const feed = async () => {
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

// ---------------------------------------------------------------------------
// ReadableStreamDefaultReader
// ---------------------------------------------------------------------------

export class ReadableStreamDefaultReader {
  get [Symbol.toStringTag]() { return 'ReadableStreamDefaultReader'; }

  constructor(stream) {
    const s = _rs.get(stream);
    if (!s) throw new TypeError('Argument must be a ReadableStream');
    if (s.locked) throw new TypeError('ReadableStream is already locked to a reader');

    let closedResolve, closedReject;
    const closedPromise = new Promise((res, rej) => { closedResolve = res; closedReject = rej; });

    _rr.set(this, {
      rsState: s,
      iter: s.kind === 'iterable' ? (s._iter ??= s.source[Symbol.asyncIterator]()) : null,
      closedResolve, closedReject, closedPromise,
    });

    s.locked = true;
    s.reader = this;
  }

  get closed() { return _rr.get(this).closedPromise; }

  read() {
    const rr = _rr.get(this);
    if (!rr) return Promise.reject(new TypeError('Reader is released'));
    const s    = rr.rsState;
    const read = rr.iter ? rr.iter.next() : _rsNextChunk(s);
    return read.then(r => {
      if (r.done) { _rsMarkClosed(s); rr.closedResolve?.(); }
      return r;
    }, e => {
      _rsMarkErrored(s, e);
      rr.closedReject?.(e);
      return Promise.reject(e);
    });
  }

  cancel(reason) {
    const rr = _rr.get(this);
    if (!rr) return Promise.reject(new TypeError('Reader is released'));
    return _rsCancel(rr.rsState, reason).then(() => rr.closedResolve?.());
  }

  releaseLock() {
    const rr = _rr.get(this);
    if (!rr) return;
    const s = rr.rsState;
    if (s.reader !== this) return;
    const e = new TypeError('Reader was released before the stream closed');
    // Reject any in-flight read requests queued against this reader
    if (s.pendingReads) {
      while (s.pendingReads.length > 0) s.pendingReads.shift().reject(e);
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

export class ReadableStreamBYOBReader {
  get [Symbol.toStringTag]() { return 'ReadableStreamBYOBReader'; }

  constructor(stream) {
    const s = _rs.get(stream);
    if (!s) throw new TypeError('Argument must be a ReadableStream');
    if (s.locked) throw new TypeError('ReadableStream is already locked to a reader');
    if (!s.isByteStream) throw new TypeError('ReadableStreamBYOBReader requires a byte stream (type:"bytes")');

    let closedResolve, closedReject;
    const closedPromise = new Promise((res, rej) => { closedResolve = res; closedReject = rej; });

    _br.set(this, { rsState: s, closedResolve, closedReject, closedPromise });
    s.locked = true;
    s.reader = this;
  }

  get closed() { return _br.get(this).closedPromise; }

  read(view, options) {
    const br = _br.get(this);
    if (!br) return Promise.reject(new TypeError('Reader is released'));
    if (!ArrayBuffer.isView(view)) return Promise.reject(new TypeError('view must be an ArrayBufferView'));
    if (view.byteLength === 0) return Promise.reject(new RangeError('view byteLength must be > 0'));

    const min = (options?.min != null) ? Number(options.min) : 1;
    if (min < 1)              return Promise.reject(new RangeError('min must be >= 1'));
    if (min > view.byteLength) return Promise.reject(new RangeError('min must be <= view.byteLength'));

    const s = br.rsState;

    if (s.state === 'closed') {
      br.closedResolve?.();
      return Promise.resolve({
        done:  true,
        value: new Uint8Array(view.buffer, view.byteOffset, 0),
      });
    }
    if (s.state === 'errored') return Promise.reject(s.storedError);

    // Try to fill from queued bytes
    if (s.queue.length > 0) {
      const filled = _rsByobFillFromQueue(s, view, min);
      if (filled !== null) return Promise.resolve({ done: false, value: filled });
    }

    // Park a pull-into descriptor
    return new Promise((resolve, reject) => {
      s.pendingByob.push({ view, bytesFilled: 0, minFill: min, resolve, reject, request: null });
      _rsPullIfNeeded(s);
    });
  }

  cancel(reason) {
    const br = _br.get(this);
    if (!br) return Promise.reject(new TypeError('Reader is released'));
    return _rsCancel(br.rsState, reason).then(() => br.closedResolve?.());
  }

  releaseLock() {
    const br = _br.get(this);
    if (!br) return;
    const s = br.rsState;
    if (s.reader !== this) return;
    // Reject any pending BYOB reads before releasing the lock.
    const releaseErr = new TypeError('Reader was released before the read completed');
    while (s.pendingByob.length > 0) {
      const desc = s.pendingByob.shift();
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

function _wsMakeState(kind, extra) {
  let closedResolve, closedReject;
  const closedPromise = new Promise((res, rej) => { closedResolve = res; closedReject = rej; });
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
    ...extra,
  };
}

function _wsMarkClosed(s) {
  if (s.state === 'closed') return;
  s.state = 'closed';
  s.closedResolve?.();
  // Resolve ready if it was pending (stream is done, no more writes)
  _wsResolveReady(s);
}

function _wsMakeReadyPending(s) {
  if (s.readyResolve !== null) return; // already pending
  s.readyPromise = new Promise(resolve => { s.readyResolve = resolve; });
}

function _wsResolveReady(s) {
  if (s.readyResolve === null) return; // already resolved
  s.readyResolve();
  s.readyResolve = null;
  s.readyPromise = Promise.resolve();
}

function _wsAbort(s, reason) {
  if (s.state === 'closed' || s.state === 'errored') return Promise.resolve();
  s.state       = 'errored';
  s.storedError = reason;
  s.controller?._abort(reason);
  if (s.pendingWrites) {
    while (s.pendingWrites.length > 0) s.pendingWrites.shift().reject(reason);
  }
  s.closedReject?.(reason);
  _wsResolveReady(s); // ready resolves (permanently) once the stream is errored
  if (s.kind === 'sink' && s.underlyingSink?.abort) {
    return Promise.resolve(s.underlyingSink.abort(reason));
  }
  return Promise.resolve();
}

function _wsWriteInternal(s, chunk) {
  if (s.state === 'errored')  return Promise.reject(s.storedError);
  if (s.state !== 'writable') return Promise.reject(new TypeError('WritableStream is not writable'));
  if (s.kind === 'writer')    return Promise.resolve(s.sink.write(chunk));

  // Sink path: compute size, apply backpressure
  const size = s.sizeAlgorithm ? s.sizeAlgorithm(chunk) : 1;
  s.queueTotalSize += size;
  if (s.queueTotalSize > s.highWaterMark) {
    _wsMakeReadyPending(s);
  }

  // Serialise writes: run immediately if idle, queue otherwise
  if (!s.writing) {
    s.writing = true;
    return _wsDoSinkWrite(s, chunk, size);
  }
  return new Promise((resolve, reject) => {
    s.pendingWrites.push({ chunk, size, resolve, reject });
  });
}

function _wsDoSinkWrite(s, chunk, size) {
  const p = s.underlyingSink.write
    ? Promise.resolve(s.underlyingSink.write(chunk, s.controller))
    : Promise.resolve();
  return p.then(() => {
    s.queueTotalSize -= size;
    if (s.queueTotalSize < 0) s.queueTotalSize = 0;

    // Resolve backpressure if we're back below HWM
    if (s.queueTotalSize <= s.highWaterMark) _wsResolveReady(s);

    if (s.pendingWrites.length > 0) {
      const entry = s.pendingWrites.shift();
      if (entry.drain) {
        s.writing = false;
        entry.resolve();
      } else {
        _wsDoSinkWrite(s, entry.chunk, entry.size).then(entry.resolve).catch(entry.reject);
      }
    } else {
      s.writing = false;
    }
  }).catch(e => {
    s.queueTotalSize -= size;
    if (s.queueTotalSize < 0) s.queueTotalSize = 0;
    s.writing      = false;
    s.state        = 'errored';
    s.storedError  = e;
    s.closedReject?.(e);
    _wsResolveReady(s);
    while (s.pendingWrites.length > 0) s.pendingWrites.shift().reject(e);
    throw e;
  });
}

async function _wsCloseInternal(s) {
  if (s.state === 'closed')   return;
  if (s.state === 'closing')  throw new TypeError('WritableStream is already closing');
  if (s.state === 'errored')  throw s.storedError;
  s.state = 'closing';

  // Wait for all in-flight writes to drain
  if (s.kind === 'sink' && s.writing) {
    await new Promise((resolve, reject) => {
      s.pendingWrites.push({ drain: true, size: 0, chunk: null, resolve, reject });
    });
  }

  if (s.kind === 'writer') {
    s.sink.close();
  } else if (s.underlyingSink?.close) {
    await Promise.resolve(s.underlyingSink.close());
  }
  _wsMarkClosed(s);
}

// ---------------------------------------------------------------------------
// WritableStreamDefaultController
// ---------------------------------------------------------------------------

export class WritableStreamDefaultController {
  #abortCtrl: AbortController;

  get [Symbol.toStringTag]() { return 'WritableStreamDefaultController'; }

  constructor(wsState) {
    this.#abortCtrl = new AbortController();
    _wc.set(this, wsState);
  }

  get signal()      { return this.#abortCtrl.signal; }
  get abortReason() { return this.#abortCtrl.signal.reason; }

  error(reason) {
    _wsAbort(_wc.get(this), reason);
  }

  _abort(reason) { this.#abortCtrl.abort(reason); }
}

// ---------------------------------------------------------------------------
// WritableStream
// ---------------------------------------------------------------------------

export class WritableStream {
  get [Symbol.toStringTag]() { return 'WritableStream'; }

  constructor(underlyingSink, queuingStrategy) {
    // Fast path: if the sink is a Boats Writer, bypass all controller machinery.
    if (underlyingSink instanceof Writer) {
      _ws.set(this, _wsMakeState('writer', { sink: underlyingSink }));
      return;
    }

    const { highWaterMark, sizeAlgorithm } = _extractStrategy(queuingStrategy, 1);
    const s = _wsMakeState('sink', {
      underlyingSink: underlyingSink ?? {},
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

    const startResult = s.underlyingSink.start
      ? Promise.resolve(s.underlyingSink.start(controller))
      : Promise.resolve();
    startResult.catch(e => controller.error(e));
  }

  get locked() { return _ws.get(this).locked; }

  close() {
    const s = _ws.get(this);
    if (s.locked) return Promise.reject(new TypeError('WritableStream is locked'));
    return _wsCloseInternal(s);
  }

  abort(reason) {
    const s = _ws.get(this);
    if (s.locked) return Promise.reject(new TypeError('Cannot abort a locked WritableStream'));
    return _wsAbort(s, reason);
  }

  getWriter() {
    const s = _ws.get(this);
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

export class WritableStreamDefaultWriter {
  get [Symbol.toStringTag]() { return 'WritableStreamDefaultWriter'; }

  constructor(stream) {
    const s = _ws.get(stream);
    if (!s) throw new TypeError('Argument must be a WritableStream');
    if (s.locked) throw new TypeError('WritableStream is already locked to a writer');

    let closedResolve, closedReject;
    const closedPromise = new Promise((res, rej) => { closedResolve = res; closedReject = rej; });

    _ww.set(this, { wsState: s, closedResolve, closedReject, closedPromise });
    s.locked = true;
    s.writer = this;
  }

  get closed()      { return _ww.get(this).closedPromise; }

  get desiredSize() {
    const ww = _ww.get(this);
    if (!ww) return null;
    const s = ww.wsState;
    if (s.kind === 'writer') return 1;
    if (s.state === 'errored') return null;
    if (s.state === 'closed')  return 0;
    return s.highWaterMark - s.queueTotalSize;
  }

  get ready() {
    const ww = _ww.get(this);
    if (!ww) return Promise.resolve();
    return ww.wsState.readyPromise;
  }

  write(chunk) {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsWriteInternal(ww.wsState, chunk);
  }

  close() {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsCloseInternal(ww.wsState)
      .then(() => ww.closedResolve?.())
      .catch(e => { ww.closedReject?.(e); throw e; });
  }

  abort(reason) {
    const ww = _ww.get(this);
    if (!ww) return Promise.reject(new TypeError('Writer is released'));
    return _wsAbort(ww.wsState, reason);
  }

  releaseLock() {
    const ww = _ww.get(this);
    if (!ww) return;
    const s = ww.wsState;
    if (s.writer !== this) return;
    s.locked = false;
    s.writer = null;
    ww.closedReject?.(new TypeError('Writer was released before the stream closed'));
    _ww.delete(this);
  }
}

// ---------------------------------------------------------------------------
// TransformStreamDefaultController
// ---------------------------------------------------------------------------

export class TransformStreamDefaultController {
  #rsState = null;

  get [Symbol.toStringTag]() { return 'TransformStreamDefaultController'; }

  constructor(channel) {
    _tc.set(this, channel);
  }

  _setReadableState(rsState) { this.#rsState = rsState; }

  get desiredSize() {
    if (this.#rsState) return _rsDesiredSize(this.#rsState);
    return 1;
  }

  enqueue(chunk)  { _tc.get(this).enqueue(chunk); }
  terminate()     { _tc.get(this).close(); }
  error(reason)   { _tc.get(this).error(reason); }
}

// ---------------------------------------------------------------------------
// TransformStream
// ---------------------------------------------------------------------------

export class TransformStream {
  #readable: ReadableStream;
  #writable: WritableStream;

  get [Symbol.toStringTag]() { return 'TransformStream'; }

  constructor(transformer, writableStrategy, readableStrategy) {
    const channel    = createChannel();
    const controller = new TransformStreamDefaultController(channel);

    const transform = transformer?.transform ?? null;
    const flush     = transformer?.flush     ?? null;

    this.#writable = new WritableStream({
      start(ctrl) {
        if (transformer?.start) return transformer.start(controller);
      },
      write(chunk) {
        if (transform) return Promise.resolve(transform(chunk, controller));
        controller.enqueue(chunk); // identity pass-through
        return Promise.resolve();
      },
      close() {
        const result = flush ? Promise.resolve(flush(controller)) : Promise.resolve();
        return result.then(() => channel.close());
      },
      abort(reason) {
        channel.error(reason);
      },
    }, writableStrategy);

    if (readableStrategy) {
      // Use a source-backed ReadableStream so the strategy's queue and
      // backpressure are respected, and desiredSize reflects the real queue.
      const chIter = channel[Symbol.asyncIterator]();
      this.#readable = new ReadableStream({
        pull(ctrl) {
          return chIter.next().then(({ done, value }) => {
            if (done) ctrl.close();
            else ctrl.enqueue(value);
          });
        },
        cancel(reason) {
          channel.error(reason);
        },
      }, readableStrategy);
      controller._setReadableState(_rs.get(this.#readable));
    } else {
      this.#readable = ReadableStream.from(channel);
    }
  }

  get readable() { return this.#readable; }
  get writable() { return this.#writable; }
}
