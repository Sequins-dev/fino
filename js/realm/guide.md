---
weight: 10
---
# Realm Guide

Realms run modules in isolated JavaScript environments. Use them when code
should have its own module graph, its own global object, restricted imports,
restartable state, or worker-style execution.

## Create a Realm

A realm starts from an entry module:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({
  entry: './worker.mts',
});

await realm.run();
```

The child module runs independently from the parent. The parent remains
responsible for creating the realm, deciding what it can import, and terminating
it when needed.

## Send Messages

Each realm has a message port:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './worker.mts' });

realm.port.addEventListener('message', (event) => {
  console.log('from child', event.data);
});

realm.port.start();
realm.port.postMessage({ type: 'ping' });

await realm.run();
```

In the child, use the child-side messaging APIs provided by the runtime to
listen for parent messages and post responses. Use messages for simple commands,
notifications, and structured data.

## Restrict Imports

Use import maps to control what the child can load:

```ts
import { ImportMap, Realm } from 'fino:realm';

const realm = new Realm({
  entry: './worker.mts',
  overrides: ImportMap.deny([
    { pattern: './worker.mts', directive: 'inherit' },
    { pattern: './worker-utils.mts', directive: 'inherit' },
    { pattern: 'fino:format/*', directive: 'inherit' },
  ]),
});
```

Rules are last-match-wins. Start with a broad baseline, then add specific
allow, block, remap, source, or facade rules after it.

Use `ImportMap.deny` for sandboxed children that should only see an explicit
allowlist. Use `ImportMap.inherit` for trusted children where only a few imports
need special handling.

## Expose a Facade

Facades create virtual modules in the child backed by parent-side handlers:

```ts
import { Facade, ImportMap, Realm } from 'fino:realm';

const secrets = new Facade('app:secrets', ['get']);

secrets.handle('get', async (name) => {
  if (name === 'api-key') return process.env.API_KEY ?? null;
  return null;
});

const realm = new Realm({
  entry: './worker.mts',
  overrides: ImportMap.deny([
    { pattern: './worker.mts', directive: 'inherit' },
    { pattern: 'app:secrets', directive: secrets },
  ]),
});
```

The child imports the facade as if it were a normal module:

```ts
import { get } from 'app:secrets';

const apiKey = await get('api-key');
```

Use facades when the child needs a narrow, auditable capability instead of broad
access to the parent's modules or process environment.

## Threads and Processes

Embedded realms share the parent process. Thread realms run in another OS
thread. Process realms run in a separate OS process:

```ts
const threaded = new Realm({
  entry: './worker.mts',
  thread: true,
});

const isolated = new Realm({
  entry: './worker.mts',
  process: true,
});
```

Use threads for CPU-bound work that should not block the parent. Use processes
when crash isolation matters more than startup cost and messaging overhead.

## Watch Mode

Watch mode restarts the child when an imported file changes:

```ts
const app = new Realm({
  entry: './app.mts',
  watch: true,
});

await app.run();
```

The JavaScript `Realm` object remains stable while the underlying child context
is replaced. Use this for development servers, plugin runners, and reloadable
application shells.

## Pools

Use `RealmPool` for repeated calls into a set of warm thread realms:

```ts
import { RealmPool } from 'fino:realm/pool';

const pool = new RealmPool({
  entry: './worker.mts',
  size: 4,
});

const result = await pool.call({ id: 123 });

await pool.close();
```

Pools are useful when tasks are independent, repeated, and expensive enough that
keeping workers warm is worthwhile.

## Choosing an Isolation Level

- Use an embedded realm for import isolation and reloadable module graphs.
- Use a thread realm for CPU work or parent responsiveness.
- Use a process realm for stronger crash isolation.
- Use import rules and facades to make child capabilities explicit.
- Use a pool when many similar calls should be distributed across warm workers.
