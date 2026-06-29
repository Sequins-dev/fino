---
weight: 14
---
# Facades

A facade is a virtual module that a child realm can import as if it were a real module, but whose exports are backed by parent-side handlers. Every call from the child crosses the realm boundary through RPC. This lets you expose a clean API surface to the child without the child needing to understand port protocols or message envelopes — from the child's perspective, it imports a module and calls functions.

## Basic setup

Create a `Facade`, register handlers, then reference it in the child's import rules at construction time:

```ts
import { Realm, Facade, ImportMap } from 'fino:realm';

const config = new Facade('app:config', ['getDatabaseUrl'])
  .handle('getDatabaseUrl', async () => process.env.DATABASE_URL ?? '');

const realm = new Realm({
  entry: './worker.mts',
  thread: true,
  overrides: ImportMap.inherit([
    { pattern: 'app:config', directive: config },
  ]),
});

await realm.run();
```

The child imports the module by the specifier you chose:

```ts
// worker.mts (child)
import { getDatabaseUrl } from 'app:config';

const url = await getDatabaseUrl();
```

The constructor declares the export names the child will see. `handle()` registers the parent-side implementation for each name. Calls are request/response: the child awaits the result, and errors thrown in the handler propagate back as rejected promises.

## Scalar handlers

Register one handler per export name. Handlers receive the child's arguments and return a single value:

```ts
const math = new Facade('app:math', ['add', 'multiply'])
  .handle('add',      async (a, b) => Number(a) + Number(b))
  .handle('multiply', async (a, b) => Number(a) * Number(b));
```

`handle()` returns `this`, so calls chain. Arguments and return values must be serializable by the active transport.

## Streaming from parent to child

`stream()` registers a handler that yields chunks to the child. Use it for log tailing, paginated data, or any situation where the parent produces an unbounded or lazy sequence:

```ts
const logs = new Facade('app:logs', [])
  .stream('tail', async function* (since: unknown) {
    for await (const line of readLogs(Number(since))) {
      yield line;
    }
  });
```

In the child the stream method behaves as an async iterable:

```ts
import { tail } from 'app:logs';

for await (const line of tail(Date.now() - 60_000)) {
  console.log(line);
}
```

Errors thrown during iteration propagate to the child's `for await` loop.

## Streaming from child to parent

`sendStream()` registers a sink: the child pushes chunks to the parent, and the parent handler receives them as an async iterable. The handler returns a single final result after draining the stream:

```ts
const uploader = new Facade('app:upload', [])
  .sendStream('write', async (_args, source) => {
    let total = 0;
    for await (const chunk of source) {
      total += (chunk as Uint8Array).byteLength;
      await store.append(chunk as Uint8Array);
    }
    return { bytesWritten: total };
  });
```

In the child, calling the sink method sends chunks one by one and resolves when the parent's handler returns:

```ts
import { write } from 'app:upload';

const result = await write(async function* () {
  yield chunk1;
  yield chunk2;
});
```

## Stateful handles

When a scalar handler needs to return an object with further callable methods, it can return a `FacadeHandle`. The child receives a proxy whose subsequent method calls come back to the parent through the same channel:

```ts
import { Facade, FacadeHandle } from 'fino:realm';

const fileApi = new Facade('app:fs', ['open'])
  .handle('open', async (path: unknown) => {
    const fh = await realFs.open(String(path), 'r');
    return new FacadeHandle(
      {
        stat:  async () => fh.stat(),
        close: async () => fh.close(),
      },
      {
        // read-stream: parent yields chunks to child
        read: async function* (size: unknown) {
          yield* fh.readChunks(Number(size));
        },
      },
    );
  });
```

`FacadeHandle` takes three arguments: scalar methods, read-stream methods (parent → child), and sink methods (child → parent). Any argument can be omitted or passed as an empty object.

## Wrapping an existing object

`Facade.from()` inspects an object's own and prototype methods and creates a facade with handlers for each callable member. Use this when you already have a service object and want to expose its full API without listing methods manually:

```ts
class ConfigService {
  async get(key: string): Promise<string | undefined> { return config[key]; }
  async set(key: string, val: string): Promise<void>   { config[key] = val; }
}

const service = new ConfigService();
const facade = Facade.from(service, { specifier: 'app:config' });
```

Non-function properties and `constructor` are excluded. The original object is the handler receiver for every call.

## Wiring a facade into an import map

Pass the `Facade` instance directly as the `directive` value in an import rule. The runtime normalizes it to the wire format:

```ts
overrides: ImportMap.inherit([
  { pattern: 'app:config', directive: facade },
]),
```

This is equivalent to `directive: facade.toDirective()` but shorter. The facade may appear as the directive for any pattern, including ones with wildcards or the `deny` baseline.

## When to use facades

Facades are the right tool when the child needs a module-level API and should not know it is running inside a realm. The indirection is invisible to the child; it just imports a specifier and calls functions.

Use raw messaging (`realm.port` / `realm.port.postMessage`) when the parent needs to push unsolicited events to the child, or when communication is event-driven rather than request/response. Use `BroadcastChannel` when multiple realms need to receive the same notifications without a direct parent/child relationship.
