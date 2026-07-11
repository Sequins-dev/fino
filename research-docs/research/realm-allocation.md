# Realm Allocation: One Realm, One Scheduler

## Status

The node-local design is implemented on this branch. Every ordinary `Realm`
is a full V8 isolate owned and pumped by a scheduler reactor. There are no
embedded realms, caller-selected thread realms, remote realm kinds, child
steppers, or `RealmPool` execution path.

The only explicit execution boundary is `process: true`. It requests OS-level
isolation; it is not a node or reactor placement hint.

## Public model

```ts
const realm = new Realm({
  entry: './worker.ts',
  scaling: { min: 1, max: 4 },
});

const result = await realm.call(input);
```

Callers describe the workload and its isolation requirements. They do not
select a thread, shard, or node. `run()`, `call()`, `port`, watch, REPL,
facades, import rules, and termination use the same scheduled construction
path.

## Node-local architecture

1. `Realm` serializes its entry, import rules, data, bootstrap metadata, watch
   mode, mobility, and scaling policy.
2. `internal:realm/allocate` submits that configuration to the node's single
   `SchedulerNode`. A realm already running on an engine thread sends the
   request back to the owning node rather than creating a nested scheduler.
3. `SchedulerNode` creates a `NodeIsolateCollection` workload record and asks
   `WorkloadAllocator` for an eligible latency or batch reactor.
4. The reactor constructs the isolate with `setup_realm_workload`, owns its
   async state and transit port, and pumps it through the native loop.
5. Release, movement, containment, and load reports return to the same node
   controller.

The reactor keeps its current isolate locked and entered while it remains the
highest-priority runnable workload. It exits only to switch isolates, transfer
ownership, or dispose the isolate.

## Same-node movement

Same-node offload transfers the live isolate rather than reconstructing it.
At a pump boundary the source reactor removes the workload from its runnable
and ownership maps, transfers exclusive isolate ownership under V8 locking,
and attaches it to the destination.

Transferable timers and readiness registrations are rearmed on the destination.
Already-submitted source operations retain safe backing storage, forward their
plain completion result to the new owner, and then detach. The forwarding route
is removed once the source has no outstanding operations for that workload.

This preserves module state, promises, the logical port, and heap identity, so
local movement is preferred while node imbalance remains tolerable. Blocking
or CPU-heavy isolates move to lower-priority batch reactors; OS thread priority
also keeps those reactors from competing equally with latency reactors.

## Replicas and liveness

`RealmOptions.scaling` describes independent isolate replicas:

- `mode: 'replicated'` is the default;
- `mode: 'bound'` fixes the logical realm at one isolate;
- `min` replicas warm eagerly while the realm is referenced;
- a queued call that remains unhealthy for the scale-up window adds one
  replica, up to `max`;
- an excess idle replica drains after the scale-down window (30 seconds by
  default; the cluster policy's quiet threshold is below 10% busy with no
  queued work).

Each call is assigned to one idle replica. Replicas have independent heaps; a
workload that depends on private mutable heap state must use `bound`.

`ref()`, `unref()`, and `hasRef()` control idle deployment liveness. Active
calls and `run()` keep their own work alive. An unreferenced realm withdraws
idle capacity and can be reconstructed by a later call; referencing it again
rehydrates its availability minimum.

## Cluster boundary

The cluster allocator will choose a node, not a reactor. The destination node
then runs the unchanged local admission path above. Reactor IDs, live isolate
handles, native operations, and transit handles never cross the machine
boundary.

New workloads and new replicas should prefer a different node when that node's
load is equal or lower. Existing live isolates should remain local or move
between local reactors unless node imbalance or availability policy justifies
the more expensive cross-node replacement.

Cross-node movement therefore means construct successor, wait for readiness,
switch routing, and drain predecessor. It cannot transparently transfer a V8
heap, socket, file descriptor, or submitted kernel operation.

See `multi-node-distribution.md` for the distributed control and data planes.
