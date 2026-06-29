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
type ShutdownHook = () => void | Promise<void>;
interface ShutdownError extends Error {
  errors?: unknown[];
}
const shutdownHooks: ShutdownHook[] = [];
/**
* Register a function to run during runtime shutdown.
*
* The hook may be synchronous or async. The returned disposable removes the
* hook if shutdown has not reached it yet. Passing a non-function throws a
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
  return { dispose() {
    if (!active) return;
    active = false;
    const index = shutdownHooks.indexOf(fn);
    if (index !== -1) shutdownHooks.splice(index, 1);
  } };
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
    const aggregate: ShutdownError = new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ') || 'Shutdown hooks failed');
    aggregate.errors = errors;
    throw aggregate;
  }
}
