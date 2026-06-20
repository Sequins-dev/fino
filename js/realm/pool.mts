/**
 * fino:realm/pool - RealmPool with load-based dispatch.
 *
 * A pool of warm thread realms that accept multiple concurrent tasks.  Tasks
 * are routed to the worker with the lowest predicted completion time, computed
 * from exponential moving averages of submission rate, completion rate, and
 * per-task latency.
 *
 * Correlation IDs are generated on the parent side and propagated via
 * fino:context so that all async operations inside a pool task inherit the
 * parent's trace context.
 *
 * Wire protocol (cross-Isolate via ThreadPort / ValueSerializer):
 *
 *   Parent -> Worker: { __pool_call: true, correlationId: number, args: unknown[] }
 *   Worker -> Parent: { __pool_result: true, correlationId: number, result: unknown }
 *                     { __pool_error: true, correlationId: number, message: string, stack?: string }
 *
 * The worker entry module simply default-exports a function.  The pool's
 * child-side bootstrap (in internal/bootstrap.mts) wraps it with the correlation ID
 * handling automatically when `__pool_call` messages arrive.
 *
 * @example
 * ```ts no_run
 * import { RealmPool } from 'fino:realm/pool';
 *
 * const pool = new RealmPool({ entry: './worker.mts', size: 4 });
 * const result = await pool.call({ id: 'task-1' });
 * await pool.close();
 * ```
 */

import { Realm, type RealmOptions, type RealmFn } from './index.mts';
import { Context } from 'fino:context';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../internal/opentelemetry/common.mts';

const _topicPoolCall    = topic(otelRuntimeTopic('realm_pool', 'call', 'start'));
const _topicPoolCallEnd = topic(otelRuntimeTopic('realm_pool', 'call', 'end'));

// ---------------------------------------------------------------------------
// Correlation ID context slot
// ---------------------------------------------------------------------------

/**
 * Carries the correlation ID for the current pool task.
 * All code within `pool.call()` - including async continuations - can read
 * this value via `correlationIdContext.get()`.
 *
 * ```ts no_run
 * import { correlationIdContext } from 'fino:realm/pool';
 * const id = correlationIdContext.get(); // string | undefined
 * ```
 */
export const correlationIdContext = new Context<string>('correlationId');

// ---------------------------------------------------------------------------
// EMA helper
// ---------------------------------------------------------------------------

const EMA_ALPHA = 2 / (10 + 1); // ~10-sample EMA

function ema(prev: number, next: number): number {
  return EMA_ALPHA * next + (1 - EMA_ALPHA) * prev;
}

// ---------------------------------------------------------------------------
// PoolWorker
// ---------------------------------------------------------------------------

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  submittedAt: number;
  /** Whether the call.start OTel event was published; gates call.end emission. */
  startPublished: boolean;
}

interface PoolWorker {
  realm: Realm;
  activeTasks: number;
  pending: Map<number, PendingCall>;
  /** EMA: tasks submitted per ms */
  submissionRate: number;
  /** EMA: tasks completed per ms */
  completionRate: number;
  /** EMA: ms per task */
  avgLatencyMs: number;
  lastSubmitTime: number;
  completedCount: number;
}

function estimatedCompletionMs(w: PoolWorker): number {
  if (w.completedCount === 0) return w.activeTasks; // cold: queue depth as proxy
  const queuePressure =
    w.submissionRate > 0
      ? w.submissionRate / Math.max(w.completionRate, 0.001)
      : 1;
  return w.activeTasks * w.avgLatencyMs * queuePressure;
}

// ---------------------------------------------------------------------------
// RealmPool options
// ---------------------------------------------------------------------------

/**
 * Generated-doc-visible interface `PoolOptions`.
 *
 * This implementation detail is included when documentation is built with
 * `--include-private`. It describes state or helper behavior used by the
 * owning module rather than a stable application-facing contract. Prefer the
 * public API around the owning type unless you are maintaining this runtime.
 *
 * @example
 * ```ts no_run
 * const documentedType = 'PoolOptions';
 * console.log(documentedType);
 * ```
 *
 * @internal
 */
export interface PoolOptions {
  /**
   * Path to the worker entry module.
   *
   * The module must default-export a function compatible with the pool's call
   * signature. The path is passed to each worker realm unchanged.
   *
   * ```ts no_run
   * import { RealmPool, type PoolOptions } from 'fino:realm/pool';
   *
   * const opts: PoolOptions = { entry: './worker.mts' };
   * const pool = new RealmPool(opts);
   * ```
   */
  entry: string;
  /**
   * Number of worker realms to keep warm.
   *
   * Defaults to `navigator.hardwareConcurrency`, or `4` when that value is not
   * available. A larger pool can improve parallel throughput but increases
   * memory and startup cost.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts', size: 8 });
   * ```
   */
  size?: number;
  /**
   * Base realm options forwarded to each worker.
   *
   * `entry` and `thread` are controlled by the pool and cannot be supplied
   * here. Use this to pass import rules, roots, providers, or other supported
   * realm settings shared by every worker.
   *
   * ```ts no_run
   * import { ImportMap } from 'fino:realm';
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({
   *   entry: './worker.mts',
   *   realm: { overrides: ImportMap.inherit([]) },
   * });
   * ```
   */
  realm?: Omit<RealmOptions, 'entry' | 'thread'>;
  /**
   * Per-task timeout in milliseconds.
   *
   * The default is `30000`. Set `0` to disable timeouts. On timeout, the call's
   * promise rejects and the worker may still finish the underlying task later.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts', timeout: 10_000 });
   * ```
   */
  timeout?: number;
  /**
   * Maximum ms to wait for in-flight tasks to settle during `close()`.
   * If the drain does not complete within this window, all remaining workers
   * are force-terminated. Default: 5 000.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts', closeTimeout: 1000 });
   * await pool.close();
   * ```
   */
  closeTimeout?: number;
}

// ---------------------------------------------------------------------------
// RealmPool
// ---------------------------------------------------------------------------

/**
 * Pool of warm thread realms with load-based task dispatch.
 *
 * Calls are sent to the worker predicted to complete soonest. Worker crashes
 * reject pending calls for that slot and trigger respawn while the pool is
 * open. `close()` must be called to stop workers when the pool is no longer
 * needed.
 *
 * ```ts no_run
 * import { RealmPool } from 'fino:realm/pool';
 *
 * const pool = new RealmPool<(value: number) => number>({ entry: './square.mts' });
 * const result = await pool.call(9);
 * await pool.close();
 * ```
 */
export class RealmPool<F extends RealmFn = RealmFn> {
  /**
   * Private property `#workers` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #workers = undefined;
   *
   *   readInternalState() {
   *     return this.#workers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #workers: PoolWorker[];
  /**
   * Private property `#timeout` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #timeout = undefined;
   *
   *   readInternalState() {
   *     return this.#timeout;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #timeout: number;
  /**
   * Private property `#closeTimeout` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closeTimeout = undefined;
   *
   *   readInternalState() {
   *     return this.#closeTimeout;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closeTimeout: number;
  /**
   * Private property `#nextCorrelation` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #nextCorrelation = undefined;
   *
   *   readInternalState() {
   *     return this.#nextCorrelation;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #nextCorrelation = 0;
  /**
   * Private property `#closed` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closed = undefined;
   *
   *   readInternalState() {
   *     return this.#closed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closed = false;
  /**
   * Private property `#entry` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #entry = undefined;
   *
   *   readInternalState() {
   *     return this.#entry;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #entry: string;
  /**
   * Private property `#baseRealm` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #baseRealm = undefined;
   *
   *   readInternalState() {
   *     return this.#baseRealm;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #baseRealm: Omit<RealmOptions, 'entry' | 'thread'>;

  /**
   * Create a pool of `size` warm thread-realm workers.
   *
   * Workers are spawned immediately in the constructor.  The pool is ready as
   * soon as `new RealmPool(...)` returns - no separate `await pool.ready()`
   * call is needed.
   *
   * Construction may throw if worker realm creation fails. The default timeout
   * is 30 seconds per task and the default close timeout is 5 seconds.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts', size: 2 });
   * console.log(pool.size);
   * ```
   */
  constructor(opts: PoolOptions) {
    const size = opts.size ?? (navigator.hardwareConcurrency || 4);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error('RealmPool size must be a positive integer');
    }
    this.#timeout = opts.timeout ?? 30_000;
    this.#closeTimeout = opts.closeTimeout ?? 5_000;
    this.#entry = opts.entry;
    this.#baseRealm = opts.realm ?? {};

    this.#workers = Array.from({ length: size }, (_, i) => this.#spawnWorker(i));
  }

  /**
   * Private method `#spawnWorker` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #spawnWorker() {
   *     return 'spawnWorker';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#spawnWorker();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #spawnWorker(slotIndex: number): PoolWorker {
    const realm = new Realm({ ...this.#baseRealm, entry: this.#entry, thread: true });

    const worker: PoolWorker = {
      realm,
      activeTasks: 0,
      pending: new Map(),
      submissionRate: 0,
      completionRate: 0,
      avgLatencyMs: 0,
      lastSubmitTime: 0,
      completedCount: 0,
    };

    // Wire up the response handler on the parent-side port.
    realm.port.addEventListener('message', (ev) => {
      const msg = (ev as MessageEvent).data as {
        __pool_result?: boolean;
        __pool_error?: boolean;
        correlationId?: number;
        result?: unknown;
        message?: string;
        stack?: string;
      };

      if (!msg || typeof msg !== 'object') return;

      const { correlationId } = msg;
      if (correlationId === undefined) return;

      const call = worker.pending.get(correlationId);
      if (!call) return;

      if (call.timer !== null) clearTimeout(call.timer);
      worker.pending.delete(correlationId);
      worker.activeTasks = Math.max(0, worker.activeTasks - 1);

      // Update completion rate / latency EMAs.
      const latencyMs = performance.now() - call.submittedAt;
      worker.avgLatencyMs = worker.completedCount === 0
        ? latencyMs
        : ema(worker.avgLatencyMs, latencyMs);
      // Rate as tasks per ms (avoid div-by-zero).
      if (latencyMs > 0) {
        worker.completionRate = ema(worker.completionRate, 1 / latencyMs);
      }
      worker.completedCount++;

      if (msg.__pool_result) {
        if (call.startPublished || _topicPoolCallEnd.hasSubscribers) {
          _topicPoolCallEnd.publish(otelRuntimeEvent('realm_pool', 'call', 'end', {
            correlationId,
            durationMs: latencyMs,
          }));
        }
        call.resolve(msg.result);
      } else if (msg.__pool_error) {
        const err = new Error(msg.message ?? 'Pool worker error');
        if (msg.stack !== undefined) err.stack = msg.stack;
        if (call.startPublished || _topicPoolCallEnd.hasSubscribers) {
          _topicPoolCallEnd.publish(otelRuntimeEvent('realm_pool', 'call', 'end', {
            correlationId,
            durationMs: latencyMs,
            error: true,
          }));
        }
        call.reject(err);
      }
    });

    realm.port.start();
    // Register realm for stepping so the parent event loop ticks it.
    realm.run().catch((crashErr: unknown) => {
      // Worker crashed - reject all pending calls for this slot.
      for (const call of worker.pending.values()) {
        if (call.timer !== null) clearTimeout(call.timer);
        call.reject(crashErr instanceof Error ? crashErr : new Error(String(crashErr)));
      }
      worker.pending.clear();
      worker.activeTasks = 0;

      // Respawn a replacement unless the pool is closed.
      if (!this.#closed) {
        this.#workers[slotIndex] = this.#spawnWorker(slotIndex);
      }
    });

    return worker;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Number of workers in the pool.
   *
   * This is the configured pool width and remains stable after construction.
   * It does not report temporary crash or respawn state.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts', size: 2 });
   * console.log(pool.size);
   * ```
   */
  get size(): number {
    return this.#workers.length;
  }

  /**
   * Total number of in-flight tasks across all workers.
   *
   * The value is a synchronous snapshot and may change as workers complete
   * calls. Timed-out calls are removed from this count when their timeout fires.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts' });
   * const pending = pool.pending;
   * ```
   */
  get pending(): number {
    let n = 0;
    for (const w of this.#workers) n += w.activeTasks;
    return n;
  }

  /**
   * Dispatch `args` to the least-loaded worker and return the result.
   *
   * The current `correlationIdContext` value is propagated as a new correlation
   * ID (derived from the parent's) so downstream operations can link traces.
   *
   * The promise resolves with the worker function's returned value. It rejects
   * when the worker reports an error, the pool is closed, a worker crashes, or
   * the per-task timeout elapses.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool<(name: string) => string>({ entry: './hello.mts' });
   * const greeting = await pool.call('Ana');
   * ```
   *
   * @throws If the worker throws, if the pool is closed, or on timeout.
   */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    if (this.#closed) return Promise.reject(new Error('RealmPool is closed'));

    const correlationId = this.#nextCorrelation++;
    const correlationStr = String(correlationId);

    return correlationIdContext.runWithValue(correlationStr, () => {
      return new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
        const worker = this.#selectWorker();
        const now = performance.now();

        // Update submission-rate EMA.
        if (worker.lastSubmitTime > 0) {
          const dt = now - worker.lastSubmitTime;
          if (dt > 0) worker.submissionRate = ema(worker.submissionRate, 1 / dt);
        }
        worker.lastSubmitTime = now;
        worker.activeTasks++;

        let timer: ReturnType<typeof setTimeout> | null = null;
        if (this.#timeout > 0) {
          timer = setTimeout(() => {
            if (!worker.pending.has(correlationId)) return;
            worker.pending.delete(correlationId);
            worker.activeTasks = Math.max(0, worker.activeTasks - 1);
            reject(new Error(`RealmPool call timed out after ${this.#timeout}ms`));
          }, this.#timeout);
        }

        // Capture whether start was published so end is always emitted when start was.
        const startPublished = _topicPoolCall.hasSubscribers;
        if (startPublished) {
          _topicPoolCall.publish(otelRuntimeEvent('realm_pool', 'call', 'start', {
            correlationId,
            poolSize: this.size,
            pendingTasks: this.#workers.reduce((n, w) => n + w.activeTasks, 0),
          }));
        }

        worker.pending.set(correlationId, {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer,
          submittedAt: now,
          startPublished,
        });

        worker.realm.port.postMessage({ __pool_call: true, correlationId, args });
      });
    });
  }

  /**
   * Stop dispatching new tasks, wait for all in-flight tasks to settle, then
   * terminate all workers.
   *
   * After `close()` starts, future `call()` attempts reject with
   * `RealmPool is closed`. If in-flight tasks do not settle before
   * `closeTimeout`, their promises are rejected and worker ports are closed.
   *
   * ```ts no_run
   * import { RealmPool } from 'fino:realm/pool';
   *
   * const pool = new RealmPool({ entry: './worker.mts' });
   * await pool.close();
   * ```
   */
  async close(): Promise<void> {
    this.#closed = true;
    // Wait for all pending calls to settle (resolve or reject).
    const drains: Promise<unknown>[] = [];
    for (const w of this.#workers) {
      for (const call of w.pending.values()) {
        drains.push(new Promise<void>((res) => {
          const orig = { resolve: call.resolve, reject: call.reject };
          call.resolve = (v) => { orig.resolve(v); res(); };
          call.reject = (e) => { orig.reject(e); res(); };
        }));
      }
    }
    // Wait for in-flight tasks to settle, but enforce a close timeout so a
    // wedged worker cannot block shutdown indefinitely.
    const drainResult = await Promise.race([
      Promise.allSettled(drains).then(() => 'settled' as const),
      new Promise<'timeout'>((res) =>
        setTimeout(() => res('timeout'), this.#closeTimeout),
      ),
    ]);
    if (drainResult === 'timeout') {
      // Force-reject any calls still pending so callers don't hang.
      for (const w of this.#workers) {
        for (const [, call] of w.pending) {
          if (call.timer !== null) clearTimeout(call.timer);
          call.reject(new Error('RealmPool.close() timed out waiting for in-flight calls'));
        }
        w.pending.clear();
      }
    }
    for (const w of this.#workers) {
      w.realm.terminate();
      // Close the parent-side port so its wake-pipe watcher is removed from
      // the event loop - otherwise alive() stays true after the thread exits.
      w.realm.port.close();
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Private method `#selectWorker` used by `RealmPool`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #selectWorker() {
   *     return 'selectWorker';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#selectWorker();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #selectWorker(): PoolWorker {
    let best = this.#workers[0]!;
    let bestTime = estimatedCompletionMs(best);

    for (let i = 1; i < this.#workers.length; i++) {
      const w = this.#workers[i]!;
      const t = estimatedCompletionMs(w);
      if (t < bestTime) {
        bestTime = t;
        best = w;
      }
    }
    return best;
  }
}
