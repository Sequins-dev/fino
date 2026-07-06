/**
* internal:synthetic-direct - runtime registry of synthetic module export tables.
*
* A synthetic module is one whose exports are supplied as live JavaScript
* values rather than compiled from source. This module is the process-wide
* backing store that holds those export tables, keyed by module specifier, so
* the loader can resolve them when the specifier is imported.
*
* The store is never imported directly by application code. It sits behind two
* higher layers. `fino:module`'s `SyntheticModule` class calls `_register` from
* its `install()` and `_unregister` from its `uninstall()` to publish and
* retract an application-owned export table. Separately, when the loader
* materializes a synthetic module it generates a tiny source module whose every
* binding forwards into this registry — one `export const NAME = __direct(spec,
* "NAME")` line per export (see `src/realm/synthetic.rs`). That indirection is
* why `_register` stores the table by reference and why the export names are
* fixed at install time: the generated bindings are evaluated once and read
* their values straight out of the map.
*
* Registration is exclusive — re-registering a live specifier throws rather
* than silently shadowing an existing table — so `SyntheticModule.install()`
* uninstalls before it reinstalls when replacing a module.
*
* ```ts no_run
* import * as direct from 'internal:synthetic-direct';
*
* direct._register('synthetic:demo', { value: 1 });
* direct.__direct('synthetic:demo', 'value'); // 1
* direct._unregister('synthetic:demo');
* ```
*
* @internal
*/
const _registry = new Map<string, Record<string, unknown>>();
/**
* Publish an export table so the specifier resolves to a synthetic module.
*
* The table is stored by reference. Callers should treat it as immutable after
* registration, because the generated module bindings read their values out of
* the very same object every time they are evaluated — mutating it after the
* fact silently changes what importers observe.
*
* Throws when the specifier is already registered; registration is exclusive so
* that a stale table can never be shadowed unnoticed. To replace a live module,
* `_unregister` it first (this is what `SyntheticModule.install()` does).
*
* ```ts no_run
* import * as direct from 'internal:synthetic-direct';
*
* direct._register('synthetic:math', { answer: 42, add: (a: number, b: number) => a + b });
* ```
*
* @internal
*/
export function _register(spec: string, exports: Record<string, unknown>): void {
  if (_registry.has(spec)) throw new Error(`SyntheticModule already installed: ${spec}`);
  _registry.set(spec, exports);
}
/**
* Retract a previously registered synthetic module.
*
* Deletes the specifier's entry so future imports of it fail to resolve.
* It does not retroactively affect anything: values already read through
* `__direct` and namespace objects already imported while the module was live
* keep working, since they hold their own references to the exported values.
*
* Throws when the specifier is not present, mirroring the exclusivity of
* `_register` — unregistering something that was never installed is a bug, not
* a no-op.
*
* ```ts no_run
* import * as direct from 'internal:synthetic-direct';
*
* direct._register('synthetic:once', { ready: true });
* direct._unregister('synthetic:once');
* ```
*
* @internal
*/
export function _unregister(spec: string): void {
  if (!_registry.delete(spec)) throw new Error(`SyntheticModule not installed: ${spec}`);
}
/**
* Read one named value out of a registered synthetic module's export table.
*
* This is the resolver behind the generated module bindings: each synthetic
* module the loader materializes emits `export const NAME = __direct(spec,
* "NAME")` lines, so evaluating the module funnels every binding through here.
*
* Throws when the specifier is not registered, which surfaces an attempt to
* evaluate a module whose backing table was never installed (or was already
* unregistered). A missing export *name* on a live table is not an error — it
* returns `undefined`, exactly like ordinary property access, so extra binding
* names degrade gracefully rather than throwing.
*
* ```ts no_run
* import * as direct from 'internal:synthetic-direct';
*
* direct._register('synthetic:flags', { enabled: true });
* const enabled = direct.__direct('synthetic:flags', 'enabled'); // true
* const missing = direct.__direct('synthetic:flags', 'nope');    // undefined
* ```
*
* @internal
*/
export function __direct(spec: string, name: string): unknown {
  const r = _registry.get(spec);
  if (r === undefined) throw new Error(`SyntheticModule not installed: ${spec}`);
  return r[name];
}
