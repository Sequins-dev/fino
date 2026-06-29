/**
* fino:module - runtime module registration utilities.
*
* Use this module when a Realm needs to provide an in-memory module to code it
* evaluates. Synthetic modules are scoped to the current runtime and are useful
* for tests, plugins, and generated module graphs that do not have a backing
* file on disk.
*
* @example
* ```ts no_run
* import { SyntheticModule } from 'fino:module';
*
* const fixture = new SyntheticModule('fixture-config', {
*   default: { port: 8080 },
*   mode: 'test',
* });
* fixture.install();
* import * as config from 'fixture-config';
* fixture.uninstall();
* ```
*/
import { _installSyntheticModule, _uninstallSyntheticModule } from 'internal:synthetic-install';
import { _register, _unregister } from 'internal:synthetic-direct';
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;
/**
* Register a module specifier backed by an object of named exports.
*
* Synthetic modules intentionally cannot use prefixed builtin schemes such as
* `fino:` or `internal:`. Use an application-owned bare or relative-like
* specifier instead.
*
* Installed modules affect future dynamic imports in the current runtime. They
* do not rewrite already-loaded module namespace objects, and they should be
* uninstalled when a test or plugin fixture is no longer needed.
*
* ```ts no_run
* import { SyntheticModule } from 'fino:module';
*
* const module = new SyntheticModule('fixtures:config', { port: 8080 });
* module.install();
* import * as config from 'fixtures:config';
* module.uninstall();
* ```
*/
export class SyntheticModule {
  /**
  * Private readonly property `#specifier` used by `SyntheticModule`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #specifier = undefined;
  *
  *   readInternalState() {
  *     return this.#specifier;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #specifier: string;
  /**
  * Private readonly property `#exports` used by `SyntheticModule`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #exports = undefined;
  *
  *   readInternalState() {
  *     return this.#exports;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #exports: Record<string, unknown>;
  /**
  * Create a synthetic module descriptor.
  *
  * The constructor only records the specifier and export object. Call
  * `install()` to make the module resolvable. Export keys become the module's
  * named exports; there is no implicit default export unless the object
  * contains a `default` key.
  *
  * ```ts no_run
  * import { SyntheticModule } from 'fino:module';
  *
  * const fixture = new SyntheticModule('fixture-config', {
  *   default: { port: 8080 },
  *   mode: 'test',
  * });
  * ```
  *
  * @param specifier Application-owned module specifier to register.
  * @param exports Named export values exposed by the synthetic module.
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
