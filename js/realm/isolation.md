---
weight: 12
---
# Isolation and Placement

Ordinary Fino realms always run as scheduler-owned V8 isolates on reactor
threads. The allocator chooses the node and reactor; application code does not
select embedded, thread, or remote modes.

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './task.ts' });
const result = await realm.call(payload);
```

This gives every realm an independent heap, module graph, global object,
microtask queue, and event-loop ownership. The scheduler may move the live
isolate between reactor threads on the same node without rebuilding it.

Use `localMobility: 'pinned'` only for native integrations that truly require
OS-thread affinity. It prevents local movement and may reduce the scheduler's
ability to contain blocking work.

## Process isolation

`process: true` adds an OS-process boundary:

```ts
const realm = new Realm({ entry: './untrusted.ts', process: true });
await realm.run();
```

This is an isolation requirement, not a placement hint. It provides stronger
crash containment and enables OS sandbox policy, at the cost of process startup
and copied IPC payloads. Live `MessagePort` transfer is not supported across
the process boundary.

Import capabilities and process isolation solve different problems. Import
rules limit which runtime capabilities code can request. A process boundary
contains crashes and can carry OS restrictions. Use both for adversarial code.

Cluster placement is transparent. Joining a cluster does not change the Realm
API or expose a remote mode; the distributed scheduler will place serializable
realm configurations through the same node admission path.
