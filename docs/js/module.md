# module

fino:module — runtime module registration utilities.

Use this module when a Realm needs to provide an in-memory module to code it
evaluates. Synthetic modules are scoped to the current runtime and are useful
for tests, plugins, and generated module graphs that do not have a backing
file on disk.

## SyntheticModule

```ts
class SyntheticModule {
```

Register a module specifier backed by an object of named exports.

Synthetic modules intentionally cannot use prefixed builtin schemes such as
`fino:` or `internal:`. Use an application-owned bare or relative-like
specifier instead.

```ts
import { SyntheticModule } from 'fino:module';

const module = new SyntheticModule('fixtures:config', { port: 8080 });
module.install();
const config = await import('fixtures:config');
module.uninstall();
```

### constructor

```ts
constructor(specifier: string, exports: Record<string, unknown>)
```

### install

```ts
install(): void
```

Install this synthetic module so future dynamic imports can resolve it.

### uninstall

```ts
uninstall(): void
```

Remove this synthetic module from the runtime registry.
