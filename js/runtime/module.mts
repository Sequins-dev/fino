import { _installSyntheticModule, _uninstallSyntheticModule } from 'internal:synthetic-install';
import { _register, _unregister } from 'internal:synthetic-direct';

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

export class SyntheticModule {
  readonly #specifier: string;
  readonly #exports: Record<string, unknown>;

  constructor(specifier: string, exports: Record<string, unknown>) {
    this.#specifier = specifier;
    this.#exports = exports;
  }

  install(): void {
    if (SCHEME_RE.test(this.#specifier)) {
      throw new Error(
        `SyntheticModule.install: prefixed specifiers (e.g. 'fino:', 'app:') are reserved for builtins`
      );
    }
    _installSyntheticModule(this.#specifier, Object.keys(this.#exports));
    _register(this.#specifier, this.#exports);
  }

  uninstall(): void {
    _uninstallSyntheticModule(this.#specifier);
    _unregister(this.#specifier);
  }
}
