---
weight: 12
---
# Isolation Levels

Fino realms support four execution modes. Choosing the right one is a trade-off between startup cost, messaging overhead, and the strength of the isolation boundary.

## Embedded

The default mode. The child runs in the current V8 isolate on the current OS thread, in its own V8 context with its own module graph and global object:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './task.mts' });
await realm.run();
```

Embedded realms are the cheapest option — no thread or process startup, no cross-isolate serialization. Messages between parent and child use the runtime's structured-clone subset. An uncaught exception in the child rejects `run()` but does not affect the parent.

Use embedded realms when you want import isolation or a reloadable module graph and do not need CPU parallelism.

## Thread

`thread: true` spawns the child in a new V8 isolate on a separate OS thread:

```ts
const realm = new Realm({ entry: './cpu-task.mts', thread: true });
const result = await realm.call(payload);
await realm.terminate();
```

The child runs concurrently with the parent. Messages cross the thread boundary through V8 ValueSerializer. Thread realms support `ArrayBuffer` transfer and `MessagePort` transfer.

Use thread realms for CPU-bound work, for situations where you need a completely separate module graph, or anywhere you need real parallelism without process-level startup cost.

## Process

`process: true` spawns the child as a separate OS process:

```ts
const realm = new Realm({ entry: './untrusted.mts', process: true });
await realm.run();
```

Process realms provide hard crash isolation: a crash or out-of-memory condition in the child cannot destabilize the parent. Messages use framed binary over a Unix socket pair. `ArrayBuffer` values are serialized by copy. Live `MessagePort` transfer is not supported — attempting it throws a `TypeError`.

Process startup is slower than thread startup and messaging has higher overhead. Use process realms when the child runs code you do not fully control, or when crash isolation is a hard requirement.

## Remote

`remote: true` runs the child on a worker node in an established cluster. `startCluster()` or `joinCluster()` from `fino:cluster` must be called before constructing a remote realm:

```ts
import { startCluster } from 'fino:cluster';
import { Realm } from 'fino:realm';

await startCluster({ port: 9999 });

const realm = new Realm({ entry: './remote-task.mts', remote: true });
await realm.call('healthcheck');
realm.terminate();
```

Remote realms expose the same `run()`, `call()`, and `terminate()` interface as local realms. Messaging uses the cluster's WebTransport transport. Watch mode and REPL mode are not supported for remote realms. Live port transfer over the cluster transport has no stable contract — use only serializable payloads.

## How to choose

Start with embedded for import isolation or module graph separation. Move to thread when you need parallelism or CPU throughput. Move to process when you need crash isolation or are running third-party code with elevated risk. Use remote only when work must run on a cluster node you have already established with `startCluster()` or `joinCluster()`.

For repeated parallel tasks across many calls, consider `fino:realm/pool` instead of constructing individual thread realms. Pools keep workers warm and handle crash recovery automatically.

## Trust and security

Import rules, facades, execution mode, OS process privileges, filesystem and network placement, and cluster authentication are all independent parts of a trust model. No single mechanism is a complete security boundary on its own.

Realms do not sandbox the child against the host operating system. A process realm with full filesystem access is isolated from the parent process, not from the host. Combine restrictions intentionally: narrow the import rule set, use `process: true` for adversarial code, restrict OS-level privileges at the process level, and place sensitive services behind facades rather than making them directly importable.
