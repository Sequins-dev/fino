/**
 * Two-tier kernel cache.
 *
 * Sits above the backends: the framework asks the cache for a kernel, and the
 * cache asks a backend to compile one only on a miss. Entries are promise-valued so
 * that two dispatches needing the same kernel at once produce one compilation
 * rather than two.
 *
 * The in-memory tier is what matters for a training loop, where the same handful of
 * kernels are launched thousands of times. A disk tier would save the first
 * compilation of each process; it is deliberately absent until measurement says the
 * emission plus driver compile is worth persisting, since for SPIR-V the emission
 * *is* ours and takes microseconds.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import { cacheKeyText } from './ir/index.ts';

/** What a cache lookup needs to identify and, on a miss, build a kernel. */
export interface KernelRequest<T> {
  /** The template's specialization key. */
  spec: string;
  /** Target dialect and capability bits. */
  target: string;
  /** Build the kernel. Called at most once per distinct key. */
  compile: () => Promise<T>;
}

/** Cache counters, for tests and diagnostics. */
export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
}

/**
 * A cache of compiled kernels for one backend.
 */
export class KernelCache<T> {
  /**
   * Keyed by the full key text.
   *
   * Not by a hash of it: a lookup happens on every launch, and hashing was doing
   * 64-bit arithmetic per byte to produce something a string map compares directly.
   * A hash is only needed to name a file, which is a concern for a disk tier that does
   * not exist yet — and keying on the text means a collision cannot happen at all
   * rather than being detected and recovered from.
   *
   * @internal
   */
  #entries = new Map<string, { kernel: Promise<T>; ready: T | null }>();
  #hits = 0;
  #misses = 0;

  /** Fetch a kernel, compiling it on a miss. */
  get(request: KernelRequest<T>): Promise<T> {
    const key = cacheKeyText({ spec: request.spec, target: request.target });
    const existing = this.#entries.get(key);
    if (existing) {
      this.#hits++;
      return existing.kernel;
    }
    this.#misses++;
    const kernel = request.compile();
    const entry = { kernel, ready: null as T | null };
    // Remember the resolved kernel as well as its promise. A launch is synchronous,
    // so being able to answer "is this compiled?" without awaiting is what lets a
    // repeat launch skip the microtask queue entirely.
    kernel.then(
      (value) => {
        entry.ready = value;
      },
      () => {},
    );
    this.#entries.set(key, entry);
    return kernel;
  }

  /**
   * A kernel already compiled, or null.
   *
   * Dispatch is synchronous, so it needs a way to ask without awaiting. A miss here
   * means the caller must fall back to the asynchronous path.
   */
  peek(spec: string, target: string): Promise<T> | null {
    return this.#lookup(spec, target)?.kernel ?? null;
  }

  /**
   * A kernel that has finished compiling, or null.
   *
   * Unlike {@link peek} this yields the kernel itself rather than a promise for it, so
   * a launch can proceed without a microtask turn. Null covers both "never compiled"
   * and "still compiling"; the caller falls back to the asynchronous path for either.
   */
  peekReady(spec: string, target: string): T | null {
    const ready = this.#lookup(spec, target)?.ready ?? null;
    // Counted as a hit: this is how a repeat launch finds its kernel, so leaving it out
    // would make the counters describe only the launches that took the slow path.
    if (ready !== null) this.#hits++;
    return ready;
  }

  /**
   * @internal
   */
  #lookup(spec: string, target: string) {
    return this.#entries.get(cacheKeyText({ spec, target }));
  }

  /** Current counters. */
  stats(): CacheStats {
    return { entries: this.#entries.size, hits: this.#hits, misses: this.#misses };
  }

  /** Forget everything, disposing each kernel through `release`. */
  async clear(release?: (kernel: T) => void): Promise<void> {
    const kernels = [...this.#entries.values()].map((entry) => entry.kernel);
    this.#entries.clear();
    if (!release) return;
    for (const promise of kernels) {
      try {
        release(await promise);
      } catch {
        // A kernel that failed to compile has nothing to release.
      }
    }
  }
}
