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
  const hooks = shutdownHooks.splice(0, shutdownHooks.length);
  const errors: unknown[] = [];
  for (let i = hooks.length - 1; i >= 0; i--) {
    try {
      await hooks[i]!();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const aggregate: ShutdownError = new Error(errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ') || 'Shutdown hooks failed');
    aggregate.errors = errors;
    throw aggregate;
  }
}
