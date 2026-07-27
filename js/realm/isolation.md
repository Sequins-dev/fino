---
weight: 12
---
# Isolation Levels

Fino realms support local reactor, process, and remote execution. Choosing the
right one is a trade-off between startup cost, messaging overhead, and the
strength of the isolation boundary.

## Reactor pool

The default mode. Each child gets its own movable V8 isolate, module graph, and
global object. The process-wide TypeScript scheduler places it on the shared
reactor thread pool:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './task.ts' });
await realm.run();
```

The scheduler keeps an isolate entered on its current thread while it remains
the highest-priority runnable workload. It moves the isolate only when another
workload has more pending readiness signals. Messages cross isolate boundaries
through V8 ValueSerializer and support `ArrayBuffer` and `MessagePort`
transfer.

## Process

`process: true` spawns the child as a separate OS process:

```ts
const realm = new Realm({ entry: './untrusted.ts', process: true });
await realm.run();
```

Process realms provide hard crash isolation: a crash or out-of-memory condition in the child cannot destabilize the parent. Messages use framed binary over a Unix socket pair. `ArrayBuffer` values are serialized by copy. Live `MessagePort` transfer is not supported — attempting it throws a `TypeError`.

Process startup is slower than pooled-isolate startup and messaging has higher
overhead. Use process realms when the child runs code you do not fully control,
or when crash isolation is a hard requirement.

## Remote

`remote: true` runs the child on a worker node in an established cluster. `startCluster()` or `joinCluster()` from `fino:cluster` must be called before constructing a remote realm:

```ts
import { startCluster } from 'fino:cluster';
import { Realm } from 'fino:realm';

await startCluster({ port: 9999 });

const realm = new Realm({ entry: './remote-task.ts', remote: true });
await realm.call('healthcheck');
realm.terminate();
```

Remote realms expose the same `run()`, `call()`, and `terminate()` interface as local realms. Messaging uses the cluster's WebTransport transport. Watch mode and REPL mode are not supported for remote realms. Live port transfer over the cluster transport has no stable contract — use only serializable payloads.

## How to choose

Use the default reactor pool for import isolation, module graph separation, and
parallel work. Move to process when you need crash isolation or are running
third-party code with elevated risk. Use remote only when work must run on a
cluster node you have already established with `startCluster()` or
`joinCluster()`.

## Trust and security

Import rules, facades, execution mode, OS process privileges, filesystem and network placement, and cluster authentication are all independent parts of a trust model. No single mechanism is a complete security boundary on its own.

Realms do not sandbox the child against the host operating system. A process realm with full filesystem access is isolated from the parent process, not from the host. Combine restrictions intentionally: narrow the import rule set, use `process: true` for adversarial code, restrict OS-level privileges at the process level, and place sensitive services behind facades rather than making them directly importable.
