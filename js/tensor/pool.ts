/**
 * Stream-ordered device buffer pool.
 *
 * Allocation sits on the dispatch hot path, so a device allocator call per
 * operation is not viable. Buffers are bucketed by power-of-two size and reused;
 * reuse is safe without a fence when it happens on the same stream, because a
 * release is ordered behind its last reader there.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DeviceBackend, DeviceBuffer, Stream } from './backend.ts';

/** Smallest bucket. Below this, rounding up costs nothing worth saving. */
const MIN_BUCKET = 256;

/**
 * Above this, allocations are exact-size and returned to the device on release.
 *
 * Pooling multi-megabyte buffers by rounded size wastes more memory than the
 * allocator call costs.
 */
const LARGE_THRESHOLD = 64 * 1024 * 1024;

/** Pool counters, which are how the engine decides whether it needs a better pool. */
export interface PoolStats {
  /** Bytes held, in use or free. */
  held: number;
  /** Bytes currently handed out. */
  inUse: number;
  /** Buffers currently handed out. */
  liveBuffers: number;
  /** Requests served from a free list. */
  hits: number;
  /** Requests that needed a device allocation. */
  misses: number;
  /** Buffers reclaimed by the finalizer rather than an explicit release. */
  leaked: number;
}

/** Round up to the bucket a request falls in. */
function bucketFor(bytes: number): number {
  if (bytes > LARGE_THRESHOLD) return bytes;
  let size = MIN_BUCKET;
  while (size < bytes) size <<= 1;
  return size;
}

/**
 * A pooled device allocation.
 *
 * Carries the stream it was last used on, so the pool knows when reuse needs an
 * event rather than nothing.
 */
export interface PooledBuffer {
  readonly buffer: DeviceBuffer;
  /** Bucket size, which may exceed the requested size. */
  readonly bytes: number;
  /** Bytes the requester asked for. */
  readonly requested: number;
  /** Stream the buffer was most recently used on. */
  stream: Stream;
}

/**
 * Per-backend buffer pool.
 */
export class BufferPool {
  #backend: DeviceBackend;
  #free = new Map<number, PooledBuffer[]>();
  #held = 0;
  #inUse = 0;
  #live = 0;
  #hits = 0;
  #misses = 0;
  #leaked = 0;

  constructor(backend: DeviceBackend) {
    this.#backend = backend;
  }

  /** Take a buffer of at least `bytes`, ordered on `stream`. */
  take(bytes: number, stream: Stream): PooledBuffer {
    const size = bucketFor(Math.max(bytes, 1));
    const list = this.#free.get(size);
    const reused = list?.pop();
    if (reused) {
      this.#hits++;
      this.#inUse += size;
      this.#live++;
      if (reused.stream.id !== stream.id) {
        // Crossing streams: the previous reader must finish before the new
        // producer writes, so order the streams rather than assuming.
        const event = this.#backend.createEvent();
        this.#backend.record(event, reused.stream);
        this.#backend.streamWait(stream, event);
      }
      reused.stream = stream;
      return { ...reused, requested: bytes, stream };
    }
    this.#misses++;
    const buffer = this.#backend.alloc(size, stream);
    this.#held += size;
    this.#inUse += size;
    this.#live++;
    return { buffer, bytes: size, requested: bytes, stream };
  }

  /** Return a buffer for reuse. */
  give(pooled: PooledBuffer): void {
    this.#inUse -= pooled.bytes;
    this.#live--;
    if (pooled.bytes > LARGE_THRESHOLD) {
      this.#backend.free(pooled.buffer, pooled.stream);
      this.#held -= pooled.bytes;
      return;
    }
    let list = this.#free.get(pooled.bytes);
    if (!list) {
      list = [];
      this.#free.set(pooled.bytes, list);
    }
    list.push(pooled);
  }

  /** Note that a buffer was reclaimed without an explicit release. */
  noteLeak(): void {
    this.#leaked++;
  }

  /** Release free buffers back to the device. */
  trim(): void {
    for (const [, list] of this.#free) {
      for (const pooled of list) {
        this.#backend.free(pooled.buffer, pooled.stream);
        this.#held -= pooled.bytes;
      }
      list.length = 0;
    }
  }

  /** Current counters. */
  stats(): PoolStats {
    return {
      held: this.#held,
      inUse: this.#inUse,
      liveBuffers: this.#live,
      hits: this.#hits,
      misses: this.#misses,
      leaked: this.#leaked,
    };
  }
}

/**
 * Pools, one per backend.
 *
 * @internal
 */
const pools = new WeakMap<DeviceBackend, BufferPool>();

/** The pool serving a backend, created on first use. */
export function poolFor(backend: DeviceBackend): BufferPool {
  let pool = pools.get(backend);
  if (!pool) {
    pool = new BufferPool(backend);
    pools.set(backend, pool);
  }
  return pool;
}
