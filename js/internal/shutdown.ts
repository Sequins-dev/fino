/**
 * internal:shutdown — process shutdown hooks.
 *
 * Maintains the root realm's in-process shutdown hook stack. Hooks are used by
 * the CLI and runtime services that need deterministic cleanup after command
 * execution but before process exit. Hooks run in reverse registration order,
 * and hooks registered during shutdown are also drained.
 *
 * ```typescript no_run
 * import * as shutdown from 'internal:shutdown';
 *
 * const hook = shutdown.registerShutdownHook(async () => {
 *   // close resources
 * });
 * hook.dispose();
 * ```
 *
 * @internal
 */
/**
 * A shutdown callback: a function invoked once during `runShutdownHooks`.
 *
 * Hooks may be synchronous or return a promise; `runShutdownHooks` awaits each
 * one before moving to the next, so an async hook holds up shutdown until it
 * settles. A hook's return value is ignored, but a thrown error (or rejected
 * promise) is captured and surfaced after the remaining hooks have run.
 *
 * @internal
 */
type ShutdownHook = () => void | Promise<void>;
/**
 * The aggregate error thrown when more than one shutdown hook fails.
 *
 * When a single hook fails, `runShutdownHooks` re-throws that error unchanged.
 * When two or more fail, it throws a plain `Error` whose message joins the
 * individual failure messages and whose `errors` array holds the original
 * thrown values in the order they were caught (reverse-registration order,
 * batch by batch). Inspect `errors` to recover the underlying failures.
 *
 * @internal
 */
interface ShutdownError extends Error {
  errors?: unknown[];
}
const shutdownHooks: ShutdownHook[] = [];
/**
 * Register a function to run during runtime shutdown.
 *
 * The hook may be synchronous or async and runs once, in reverse-registration
 * order relative to its siblings — the last hook registered runs first. The
 * returned object has a `dispose()` method that removes the hook if shutdown
 * has not yet reached it; `dispose()` is idempotent, so calling it more than
 * once (or after the hook has already run) is a harmless no-op. Registering a
 * hook from inside another hook while shutdown is in progress is allowed — it
 * will be picked up in a later drain batch. Passing a non-function throws a
 * `TypeError`.
 *
 * ```typescript no_run
 * import { registerShutdownHook } from 'internal:shutdown';
 *
 * const registered = registerShutdownHook(() => {
 *   // flush metrics
 * });
 * registered.dispose();
 * ```
 *
 * @internal
 */
export function registerShutdownHook(fn: ShutdownHook) {
  if (typeof fn !== 'function') throw new TypeError('Shutdown hook must be a function');
  shutdownHooks.push(fn);
  let active = true;
  return {
    dispose() {
      if (!active) return;
      active = false;
      const index = shutdownHooks.indexOf(fn);
      if (index !== -1) shutdownHooks.splice(index, 1);
    },
  };
}
/**
 * Run all registered shutdown hooks and surface collected failures.
 *
 * Hooks execute in reverse-registration order. If one hook fails, that error is
 * re-thrown. If multiple hooks fail, an aggregate `Error` is thrown with an
 * `errors` array containing the original failures.
 *
 * ```typescript no_run
 * import { registerShutdownHook, runShutdownHooks } from 'internal:shutdown';
 *
 * registerShutdownHook(() => {});
 * await runShutdownHooks();
 * ```
 *
 * @internal
 */
export async function runShutdownHooks() {
  const errors: unknown[] = [];
  // Run in reverse-registration order. Loop until the array is empty so that
  // hooks registered *during* shutdown (e.g. by an async hook's cleanup) are
  // also executed rather than silently dropped.
  while (shutdownHooks.length > 0) {
    // Pop a snapshot of what's registered now, then run in reverse order.
    const batch = shutdownHooks.splice(0, shutdownHooks.length);
    for (let i = batch.length - 1; i >= 0; i--) {
      try {
        await batch[i]!();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const aggregate: ShutdownError = new Error(
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ') ||
        'Shutdown hooks failed',
    );
    aggregate.errors = errors;
    throw aggregate;
  }
}
