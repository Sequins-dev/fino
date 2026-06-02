# module

fino:module - runtime module registration utilities.

Use this module when a Realm needs to provide an in-memory module to code it
evaluates. Synthetic modules are scoped to the current runtime and are useful
for tests, plugins, and generated module graphs that do not have a backing
file on disk.

```ts
import { SyntheticModule } from 'fino:module';

const fixture = new SyntheticModule('fixture-config', {
  default: { port: 8080 },
  mode: 'test',
});
fixture.install();
import * as config from 'fixture-config';
fixture.uninstall();
```

## SyntheticModule

```ts
class SyntheticModule {
```

Register a module specifier backed by an object of named exports.

Synthetic modules intentionally cannot use prefixed builtin schemes such as
`fino:` or `internal:`. Use an application-owned bare or relative-like
specifier instead.

Installed modules affect future dynamic imports in the current runtime. They
do not rewrite already-loaded module namespace objects, and they should be
uninstalled when a test or plugin fixture is no longer needed.

```ts
import { SyntheticModule } from 'fino:module';

const module = new SyntheticModule('fixtures:config', { port: 8080 });
module.install();
import * as config from 'fixtures:config';
module.uninstall();
```

### constructor

```ts
constructor(specifier: string, exports: Record<string, unknown>)
```

Create a synthetic module descriptor.

The constructor only records the specifier and export object. Call
`install()` to make the module resolvable. Export keys become the module's
named exports; there is no implicit default export unless the object
contains a `default` key.

```ts
import { SyntheticModule } from 'fino:module';

const fixture = new SyntheticModule('fixture-config', {
  default: { port: 8080 },
  mode: 'test',
});
```

### install

```ts
install(): void
```

Install this synthetic module so future dynamic imports can resolve it.

Throws when the specifier has a URI-like scheme, because prefixed schemes
are reserved for builtins and runtime providers. Reinstalling the same
specifier replaces the direct registry entry used by future imports.

```ts
import { SyntheticModule } from 'fino:module';

const module = new SyntheticModule('fixture-config', { port: 8080 });
module.install();
console.log((await import('fixture-config')).port);
```

### uninstall

```ts
uninstall(): void
```

Remove this synthetic module from the runtime registry.

Uninstalling prevents future resolution of the specifier. It does not
mutate namespace objects that were already imported while the module was
installed.

```ts
import { SyntheticModule } from 'fino:module';

const module = new SyntheticModule('fixture-config', { port: 8080 });
module.install();
module.uninstall();
```
