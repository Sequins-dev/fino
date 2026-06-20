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

`Realm.run()` resolves when the child exits normally or after `terminate()`.
Top-level child errors reject `run()`. `Realm.fromSource()` can install an
in-memory module as the entrypoint while preserving caller import rules.

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

Core realm transfers intentionally cover a small set. `ArrayBuffer` values can
be transferred where the active transport supports transfer stores, and
`MessagePort` transfer is supported for same-isolate and thread realms. Stream
transfer and other structured-clone transferables are outside the current realm
core contract and reject explicitly on thread/process transport ports.

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

Prefer explicit `overrides` for new code. The legacy `providers` and `blocked`
options are compatibility shims that are converted into import rules only when
`overrides` is absent. When `overrides` is present, legacy provider and blocked
settings are ignored so the explicit rule list is the complete child policy.

Import rules are evaluated in order with last-match-wins semantics, including
duplicate and wildcard rules. Put broad defaults first and the exceptions after
them. `ImportMap.deny([...])` prepends a `*` block rule, while
`ImportMap.inherit([...])` prepends a `*` inherit rule.

Realms are isolation and capability-shaping tools, but they are not a complete
security boundary by themselves. Treat import rules, facades, execution mode,
process privileges, filesystem/network placement, and cluster authentication as
parts of a larger trust model for untrusted workloads.

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

## Remote Realms

Remote realms run on a worker node in an active `fino:cluster`:

```ts
import { startCluster, leaveCluster } from 'fino:cluster';
import { Realm } from 'fino:realm';

await startCluster({ port: 9999 });

const realm = new Realm({
  entry: './worker.mts',
  remote: true,
});

await realm.call('healthcheck');
realm.terminate();
leaveCluster();
```

`remote: true` requires a prior `startCluster()` or `joinCluster()` call. The
seed routes the spawn to an eligible worker, owns the parent/child port mapping,
and forwards cluster `PORT_MSG` frames between the parent and child. Import
rules, facades, read streams, write streams, `run()`, `call()`, bootstrap
errors, call errors, and `terminate()` follow the same parent-facing contracts
as thread and process realms.

Remote realms isolate execution in another process and usually another host,
but they use the current WebSocket cluster transport and single-seed control
plane. They are not a security boundary by themselves: use import rules,
facades, network placement, and future cluster authentication together for
untrusted workloads. `watch: true` and `repl: true` are intentionally unsupported
for remote realms.

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

`RealmPool` is intentionally local: it keeps thread realms in the current
process and does not schedule work across cluster workers. Use `Realm({
remote: true })` directly when a specific task should run on another cluster
node. A distributed pool abstraction needs separate placement, authentication,
and slow-worker policy design before it can be part of the public API.

## Choosing an Isolation Level

- Use an embedded realm for import isolation and reloadable module graphs.
- Use a thread realm for CPU work or parent responsiveness.
- Use a process realm for stronger crash isolation.
- Use a remote realm when work should run on another cluster worker.
- Use import rules and facades to make child capabilities explicit.
- Use a pool when many similar calls should be distributed across warm workers.
