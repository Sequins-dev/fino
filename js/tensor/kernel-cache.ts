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
import { cacheKeyHash, cacheKeyText } from './ir/index.ts';

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
   * Keyed by hash, holding both the promise and the full key text.
   *
   * The full key is compared on a hit, which makes a hash collision produce a
   * recompile rather than the wrong kernel.
   *
   * @internal
   */
  #entries = new Map<string, { key: string; kernel: Promise<T> }>();
  #hits = 0;
  #misses = 0;

  /** Fetch a kernel, compiling it on a miss. */
  get(request: KernelRequest<T>): Promise<T> {
    const key = cacheKeyText({ spec: request.spec, target: request.target });
    const hash = cacheKeyHash({ spec: request.spec, target: request.target });
    const existing = this.#entries.get(hash);
    if (existing && existing.key === key) {
      this.#hits++;
      return existing.kernel;
    }
    this.#misses++;
    const kernel = request.compile();
    this.#entries.set(hash, { key, kernel });
    return kernel;
  }

  /**
   * A kernel already compiled, or null.
   *
   * Dispatch is synchronous, so it needs a way to ask without awaiting. A miss here
   * means the caller must fall back to the asynchronous path.
   */
  peek(spec: string, target: string): Promise<T> | null {
    const hash = cacheKeyHash({ spec, target });
    const key = cacheKeyText({ spec, target });
    const existing = this.#entries.get(hash);
    return existing && existing.key === key ? existing.kernel : null;
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
