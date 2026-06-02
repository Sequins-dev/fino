/**
 * fino:module — runtime module registration utilities.
 *
 * Use this module when a Realm needs to provide an in-memory module to code it
 * evaluates. Synthetic modules are scoped to the current runtime and are useful
 * for tests, plugins, and generated module graphs that do not have a backing
 * file on disk.
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
 * ```ts no_run
 * import { SyntheticModule } from 'fino:module';
 *
 * const module = new SyntheticModule('fixtures:config', { port: 8080 });
 * module.install();
 * const config = await import('fixtures:config');
 * module.uninstall();
 * ```
 */
export class SyntheticModule {
  readonly #specifier: string;
  readonly #exports: Record<string, unknown>;

  constructor(specifier: string, exports: Record<string, unknown>) {
    this.#specifier = specifier;
    this.#exports = exports;
  }

  /** Install this synthetic module so future dynamic imports can resolve it. */
  install(): void {
    if (SCHEME_RE.test(this.#specifier)) {
      throw new Error(
        `SyntheticModule.install: prefixed specifiers (e.g. 'fino:', 'app:') are reserved for builtins`
      );
    }
    _installSyntheticModule(this.#specifier, Object.keys(this.#exports));
    _register(this.#specifier, this.#exports);
  }

  /** Remove this synthetic module from the runtime registry. */
  uninstall(): void {
    _uninstallSyntheticModule(this.#specifier);
    _unregister(this.#specifier);
  }
}
