/**
 * internal:scheduler/isolate — opaque movable V8 isolate handle.
 *
 * Scheduling policy lives in TypeScript. This wrapper exposes only the native
 * capabilities TypeScript cannot implement: creating an isolate, identifying
 * its readiness owner and wake descriptor, transferring it into the process
 * worker pool, and disposing an untransferred isolate.
 *
 * @internal
 */
import {
  createWorkload,
  terminateWorkload,
  workloadOwner,
  workloadWakeFd,
} from 'internal:scheduler-native';

/** One V8 isolate that can be transferred into the process worker pool. */
export class Isolate {
  #handle: number;

  constructor(entryPath: string) {
    this.#handle = createWorkload(entryPath);
  }

  /** Readiness-routing owner captured by operations created in this isolate. */
  get owner(): number {
    return workloadOwner(this.#handle);
  }

  /** Async-runtime wake descriptor watched by the TypeScript scheduler. */
  get wakeFd(): number {
    return workloadWakeFd(this.#handle);
  }

  /** Opaque handle consumed when the isolate enters a native worker pool. */
  get nativeHandle(): number {
    return this.#handle;
  }

  /** Dispose the isolate if it has not already transferred into a pool. */
  terminate(): void {
    terminateWorkload(this.#handle);
  }
}
