# Realm Allocation: Reactors Schedule, Orchestration Places

## Status

The node-local design is implemented on this branch. Every ordinary `Realm`
is exactly one execution container: a V8 isolate owned and pumped by a reactor
thread. There are no embedded realms, caller-selected thread realms, child
steppers, or separate scheduling layer above the reactor.

`process: true` is the only alternate execution boundary. It requests
one-to-one OS-process isolation; it is not a reactor or node placement hint.

## Public model

`Realm` is one container and preserves one module heap:

```ts
const realm = new Realm({ entry: './worker.ts' });
const result = await realm.call(input);
```

`RealmDeployment` owns a scalable set of independent realms:

```ts
const workers = new RealmDeployment({
  entry: './worker.ts',
  scaling: { min: 1, max: 4 },
});

const result = await workers.call(input);
```

Callers describe execution and isolation requirements. They never select a
reactor or node. A `Realm` does not contain replica policy, admission queues,
load observations, or placement state. A deployment does not schedule realm
pump slices; it only decides when independent capacity is needed.

## Node-local responsibilities

The layers have intentionally narrow ownership:

1. `Realm` serializes its entry, import rules, data, bootstrap metadata, watch
   mode, and local-mobility constraint.
2. `internal:realm/allocate` submits that description to the node's single
   `NodeOrchestrator`. A realm already running on a reactor sends the request
   back to the owning node rather than creating nested orchestration.
3. `NodeOrchestrator` owns reactor lifecycle and uses `NodeRealmCollection` to
   record placement, admission capacity, load summaries, and move reservations.
4. The selected reactor constructs the isolate and directly schedules pump
   slices across its assigned realms. TypeScript orchestration is never in this
   hot path.
5. Reactor lifecycle, load, movement, and containment reports return to the
   node orchestrator.

The reactor keeps its selected isolate locked and entered across consecutive
slices. It exits only when another isolate wins, ownership moves, or the
isolate is disposed.

## Same-node movement

Same-node offload transfers the live isolate rather than reconstructing it. At
a pump boundary, the source reactor detaches the workload and transfers
exclusive isolate ownership to the destination. Destination-compatible
operations are rearmed there. Source-bound operations retain safe backing
storage and forward plain completion results until they drain.

This preserves module state, promises, the logical port, and heap identity.
Local movement is therefore preferred while node imbalance remains tolerable.
Repeatedly blocking isolates move to lower-priority batch reactors, which are
also given lower OS scheduling priority and can retire when idle.

`localMobility: 'pinned'` is reserved for audited native integrations with real
OS-thread affinity. It is not a performance tuning hint.

## Deployment admission and liveness

`RealmDeployment` owns independent replicas and admits at most one call or
affine session to each replica at a time:

- `min` replicas warm during construction;
- sustained call-queue delay creates one replica at a time, up to `max`;
- an excess replica with no admitted work retires after the quiet window;
- `connect()` reserves a stable replica until its session closes;
- `broadcast()` sends to every ready replica.

Realms and deployments are referenced by default, but referenced status does
not prevent natural completion. `unref()` allows otherwise-idle capacity to
drain. Active calls, affine sessions, `run()`, and referenced resources inside
the child keep their own work alive.

## Failure semantics

A hard reactor loss destroys its isolates. The orchestrator releases affected
allocations and restores reactor capacity; it does not replay calls whose
completion is unknown. A later `Realm.call()` can reconstruct its one physical
container, while a deployment can admit later work to a surviving or newly
created replica.

Moving a live isolate within the node is state preserving. Moving work across
nodes is not: it must create a successor from serialized configuration, switch
routing after readiness, and drain the predecessor.

See `multi-node-distribution.md` for the future distributed control and data
planes.
