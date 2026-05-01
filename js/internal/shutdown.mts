type ShutdownHook = () => void | Promise<void>;

interface ShutdownError extends Error {
  errors?: unknown[];
}

const shutdownHooks: ShutdownHook[] = [];

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
