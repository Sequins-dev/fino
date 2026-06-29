/**
 * internal:runtime/synthetic-direct - synthetic module registry.
 *
 * Stores direct export tables for synthetic modules that are installed by the
 * runtime rather than loaded from source files. Consumers normally reach this
 * through generated module bindings; direct access is for loader internals.
 *
 * ```typescript no_run
 * import * as direct from 'internal:runtime/synthetic-direct';
 * direct._register('synthetic:demo', { value: 1 });
 * direct.__direct('synthetic:demo', 'value'); // 1
 * direct._unregister('synthetic:demo');
 * ```
 *
 * @internal
 */

const _registry = new Map<string, Record<string, unknown>>();

/**
 * Register a synthetic module export table by specifier.
 *
 * Throws when the specifier is already registered. The table is stored by
 * reference, so callers should treat it as immutable after registration.
 *
 * ```typescript no_run
 * import * as direct from 'internal:runtime/synthetic-direct';
 * direct._register('synthetic:math', { answer: 42 });
 * ```
 *
 * @internal
 */
export function _register(spec: string, exports: Record<string, unknown>): void {
  if (_registry.has(spec)) throw new Error(`SyntheticModule already installed: ${spec}`);
  _registry.set(spec, exports);
}

/**
 * Remove a previously registered synthetic module.
 *
 * Throws when the specifier is not present. Removing a module does not clean up
 * values that were already returned by `__direct`.
 *
 * ```typescript no_run
 * import * as direct from 'internal:runtime/synthetic-direct';
 * direct._register('synthetic:once', {});
 * direct._unregister('synthetic:once');
 * ```
 *
 * @internal
 */
export function _unregister(spec: string): void {
  if (!_registry.delete(spec)) throw new Error(`SyntheticModule not installed: ${spec}`);
}

/**
 * Return a named export from a registered synthetic module.
 *
 * Throws when the module specifier is missing. Missing export names return
 * `undefined`, matching ordinary JavaScript property access.
 *
 * ```typescript no_run
 * import * as direct from 'internal:runtime/synthetic-direct';
 * direct._register('synthetic:flags', { enabled: true });
 * const enabled = direct.__direct('synthetic:flags', 'enabled');
 * ```
 *
 * @internal
 */
export function __direct(spec: string, name: string): unknown {
  const r = _registry.get(spec);
  if (r === undefined) throw new Error(`SyntheticModule not installed: ${spec}`);
  return r[name];
}
