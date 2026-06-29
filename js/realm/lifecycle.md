---
weight: 11
---
# Realm Lifecycle

## Creating a realm

Construct a realm by pointing it at an entry module:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.ts' });
```

The constructor returns immediately. The child context is created and the module starts loading when you call `run()` or `call()`. Pass `root` to change the filesystem root used for module resolution inside the child:

```ts
const realm = new Realm({
  entry: './worker.ts',
  root: '/srv/plugin',
});
```

### In-memory source

`Realm.fromSource()` accepts TypeScript source text directly instead of a file path. The source is transpiled at construction time and the child can use static imports and top-level await just like a file-backed entry:

```ts
const realm = Realm.fromSource(`
  import { basename } from 'fino:file/path';
  const name = basename('/tmp/example.ts');
  if (name !== 'example.ts') throw new Error('unexpected: ' + name);
`);
await realm.run();
```

The optional `specifier` field in the options sets the synthetic URL assigned to the source module. Set this when the source text contains relative imports and you want them to resolve from a specific directory:

```ts
const realm = Realm.fromSource(
  `import helper from './helper.ts';`,
  { specifier: '/srv/app/entry.ts' },
);
```

Watch mode is not available for source realms — there is no file on disk to monitor.

## Running a realm

`run()` starts the child and returns a promise that settles when the child finishes:

```ts
await realm.run();
```

The promise resolves when the child's module evaluation completes normally, including draining any top-level awaits. It rejects if the child throws an uncaught error at the top level:

```ts
try {
  await realm.run();
} catch (err) {
  console.error('child failed:', err);
}
```

For long-running children such as servers or background workers, `run()` stays pending until you call `terminate()`.

## Calling a function

When the child's entry module default-exports a function, use `call()` instead of `run()`. The parent sends the arguments, the child invokes the function, and the result comes back as a resolved promise:

```ts
// worker.ts (child)
export default async function (name: string): Promise<string> {
  return `hello ${name}`;
}

// parent
const realm = new Realm<(name: string) => Promise<string>>({
  entry: './worker.ts',
});
const greeting = await realm.call('Ana');
```

Arguments and return values must be serializable by the active transport. Plain objects, arrays, typed arrays, and primitives work. Functions, symbols, and weak collections throw a `DataCloneError` at `call()` time.

Errors thrown by the child function propagate to the parent as a rejected promise with the original error message and name preserved.

`call()` closes the port after the first response, so a single `Realm` instance is one-shot when used this way. For repeated calls to a pool of workers, see `fino:realm/pool`.

## Terminating a realm

`terminate()` stops the child. For embedded realms the V8 context is torn down synchronously. For thread and process realms a `__terminate` message is sent and the parent-side port is closed. For remote realms the cluster is notified.

```ts
realm.terminate();
```

`terminate()` is synchronous and does not wait for the child to exit cleanly. If you called `run()` first, its promise resolves shortly after `terminate()` returns.

The `using` declaration triggers `terminate()` automatically when the block exits:

```ts
{
  using realm = new Realm({ entry: './worker.ts', thread: true });
  const result = await realm.call(payload);
} // realm.terminate() called here
```

## Watch mode

Setting `watch: true` makes the `Realm` object stable across child restarts. Whenever any file in the child's import graph changes on disk, the runtime tears down the current child context and spawns a fresh one using the same options. The `Realm` instance itself stays constant:

```ts
const realm = new Realm({ entry: './server.ts', watch: true });
const done = realm.run();  // stays pending; child restarts silently on file change
```

The watcher tracks transitive imports, not just the entry file. If a helper module changes, the child restarts. Multiple rapid edits within a 50 ms debounce window produce a single reload rather than a cascade.

`run()` stays pending across reloads and only resolves when you call `terminate()`:

```ts
const realm = new Realm({ entry: './plugin.ts', watch: true });
const done = realm.run();

// later, when you want to stop watching:
realm.terminate();
await done;
```

Watch mode works with embedded, thread, and process realms. It is not available with `remote: true`.
