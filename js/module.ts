/**
* fino:module — runtime module registration utilities.
*
* Registers in-memory modules whose exports come from a plain object rather
* than a file on disk. Once installed, a synthetic module resolves through the
* normal dynamic `import()` machinery, so any code in the runtime can import
* the specifier as if it were a real file. This is useful for test fixtures,
* plugins, and generated module graphs where writing source to disk would be
* awkward or impossible.
*
* Installation mutates the runtime's module registry and therefore only
* affects imports that happen after `install()` returns. It does not rewrite
* namespace objects that were already imported, and it is scoped to the current
* runtime — a synthetic module installed in a parent Realm is not visible to a
* child Realm running in its own isolate. Always pair `install()` with a later
* `uninstall()` so fixtures do not leak into unrelated code.
*
* Specifiers must be application-owned bare or path-like strings. Prefixed
* URI-like schemes such as `fino:`, `internal:`, or `app:` are rejected because
* they are reserved for builtins and runtime providers.
*
* ```ts no_run
* import { SyntheticModule } from 'fino:module';
*
* const fixture = new SyntheticModule('fixture-config', {
*   default: { port: 8080 },
*   mode: 'test',
* });
* fixture.install();
* const config = await import('fixture-config');
* console.log(config.default.port, config.mode); // 8080 test
* fixture.uninstall();
* ```
*/
import { _installSyntheticModule, _uninstallSyntheticModule } from 'internal:synthetic-install';
import { _register, _unregister } from 'internal:synthetic-direct';
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;
/**
* A module specifier backed by an object of named exports, resolvable through
* dynamic `import()` once installed.
*
* Construction is inert: it merely records the specifier and export object.
* Nothing becomes importable until `install()` is called, and the module stays
* importable until `uninstall()` removes it. Each export key becomes a named
* export of the module; a `default` key becomes the default export. Because
* installation targets the current runtime's registry, a synthetic module is
* not shared across Realms that run in separate isolates.
*
* Reinstalling the same specifier replaces the previous entry, which is a
* convenient way to swap a fixture's exports between tests. Prefer a bare or
* path-like specifier; scheme-prefixed specifiers are rejected by `install()`.
*
* ```ts no_run
* import { SyntheticModule } from 'fino:module';
* import { describe, it } from 'fino:test/test';
*
* describe('feature flags', () => {
*   it('reads the injected config', async (t) => {
*     const flags = new SyntheticModule('app-flags', { betaSearch: true });
*     flags.install();
*     try {
*       const { betaSearch } = await import('app-flags');
*       t.equal(betaSearch, true);
*     } finally {
*       flags.uninstall();
*     }
*   });
* });
* ```
*/
export class SyntheticModule {
  /**
  * The application-owned specifier this module registers under. Captured at
  * construction and used as the registry key for both install and uninstall.
  *
  * @internal
  */
  readonly #specifier: string;
  /**
  * The named export values exposed by the module. Its keys become the module's
  * export names when `install()` binds them into the synthetic namespace.
  *
  * @internal
  */
  readonly #exports: Record<string, unknown>;
  /**
  * Records the specifier and export object without touching the module
  * registry.
  *
  * Construction has no side effects; call `install()` afterwards to make the
  * module resolvable. The keys of `exports` become the module's named exports,
  * and a `default` key becomes the default export — there is no implicit
  * default otherwise.
  *
  * ```ts no_run
  * import { SyntheticModule } from 'fino:module';
  *
  * const fixture = new SyntheticModule('fixture-config', {
  *   default: { port: 8080 },
  *   mode: 'test',
  * });
  * ```
  */
  constructor(specifier: string, exports: Record<string, unknown>) {
    this.#specifier = specifier;
    this.#exports = exports;
  }
  /**
  * Install this synthetic module so future dynamic imports can resolve it.
  *
  * Throws when the specifier has a URI-like scheme, because prefixed schemes
  * are reserved for builtins and runtime providers. Reinstalling the same
  * specifier replaces the direct registry entry used by future imports.
  *
  * ```ts no_run
  * import { SyntheticModule } from 'fino:module';
  *
  * const module = new SyntheticModule('fixture-config', { port: 8080 });
  * module.install();
  * console.log((await import('fixture-config')).port);
  * ```
  */
  install(): void {
    if (SCHEME_RE.test(this.#specifier)) {
      throw new Error(`SyntheticModule.install: prefixed specifiers (e.g. 'fino:', 'app:') are reserved for builtins`);
    }
    _installSyntheticModule(this.#specifier, Object.keys(this.#exports));
    _register(this.#specifier, this.#exports);
  }
  /**
  * Remove this synthetic module from the runtime registry.
  *
  * Uninstalling prevents future resolution of the specifier. It does not
  * mutate namespace objects that were already imported while the module was
  * installed.
  *
  * ```ts no_run
  * import { SyntheticModule } from 'fino:module';
  *
  * const module = new SyntheticModule('fixture-config', { port: 8080 });
  * module.install();
  * module.uninstall();
  * ```
  */
  uninstall(): void {
    _uninstallSyntheticModule(this.#specifier);
    _unregister(this.#specifier);
  }
}
