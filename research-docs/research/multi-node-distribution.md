# Multi-Node Distribution over the QUIC Mesh

> Status: reactor scheduling, node-local placement, live same-node isolate
> movement, and `RealmDeployment` scaling are implemented. The current
> QUIC/WebTransport cluster layer provides seed-backed membership and
> heartbeats only. Distributed
> admission, authenticated peer sessions, replicated intent, service routing,
> and cross-node replica reconciliation remain to be implemented.

## 1. One execution model

There is only one kind of ordinary realm. Every realm is one V8 isolate
attached to a reactor on some node. The reactor directly schedules its assigned
realms; node and cluster orchestration only decide placement and movement. A
realm does not know its reactor or node, and application code cannot request
local or remote placement.

```text
realm or replica request
        |
        v
cluster orchestration  chooses node and assignment epoch
        |
        v
node orchestration ---- chooses latency/batch reactor
        |
        v
reactor --------------- constructs isolate and schedules its work
```

The cluster layer must extend this model. It must not introduce a remote Realm
class, a cluster port type, or another realm-driving loop.

## 2. Current implementation

### Node-local substrate

- `NodeOrchestrator` is the node's realm lifecycle authority.
- `NodeRealmCollection` owns placement records, load summaries, capacity, and
  move reservations.
- `NodeOrchestrator` selects a local latency or batch reactor and owns reactor
  lifecycle.
- Reactor engines construct every scheduled unit through
  `setup_realm_workload` and the normal realm bootstrap.
- A selected isolate stays locked and entered until a different isolate
  outranks it, it moves, or it terminates.
- Same-node movement transfers the live isolate. Destination-compatible
  operations are rearmed; source-bound operations forward completions until
  they drain.
- Repeated blocking work moves to lower-priority batch reactors. Batch reactors
  have lower scheduling priority and retire when idle.
- Nested realms submit allocation back to the owning node over an internal
  control channel.
- A `Realm` is one physical execution container. `RealmDeployment` composes
  independent replicas with queue-pressure scale-out, quiet scale-down,
  affine sessions, broadcast, and `ref()`/`unref()` liveness.

### Cluster substrate

- `startCluster()` starts a WebTransport seed and joins it as a member.
- `joinCluster()` connects a worker to the seed.
- `ClusterClient` maintains the peer view and sends heartbeats.
- `SeedServer` admits peers, distributes `WELCOME`/`PEER_UP`/`PEER_DOWN`, and
  expires silent members.
- The wire protocol contains membership messages only.

The former `SPAWN`, `SPAWN_ACK`, `PORT_MSG`, `REALM_EXIT`, `ClusterPort`, and
`RealmRegistry` prototype has been removed. It bypassed node admission, called
the old reactor-context constructor directly, and stepped realms from the
cluster client. Retaining it would create a second, incompatible realm-driving
loop.

## 3. Placement policy

Placement uses different mechanisms for existing and new capacity.

### Existing live isolates

Prefer same-node movement while the node is not materially more loaded than
its peers. It is cheap and state preserving:

- no module reload;
- no heap copy;
- no logical-port replacement;
- no service-directory cutover;
- only in-flight source operations need temporary completion forwarding.

Thread priority and the batch pool contain slow or blocking realms without
requiring every mild imbalance to become a network migration.

### New realms and replica splits

Prefer a different node when its measured load is equal to or lower than the
best local candidate. For a split, first prefer an eligible failure domain that
does not already host the logical realm, then the least-pressured eligible node.
The destination's allocator independently chooses a local reactor.

This bias improves distribution and availability without paying cross-node
replacement cost for already-live heaps.

## 4. Scaling protocol

Scale on latency pressure, not only CPU saturation. Each replica reports:

- busy ratio;
- queue depth;
- age of the oldest queued activation;
- p95 runnable delay;
- reactor class and admission headroom.

One second of sustained leading pressure may create one successor, up to the
deployment's maximum. Only one scale action is in flight at a time.

Scale-out sequence:

1. Commit or fence a new replica attempt.
2. Select a node, preferring a different node at equal or lower load.
3. Ask that node to admit the serialized realm configuration.
4. Wait until the replica has loaded and its health/readiness check passes.
5. Publish the replica in the service directory and distributed DNS.
6. Complete the scale action only after routing observes the new generation.

Scale-down eligibility begins when an excess replica has no queue and remains
below 10% busy for 30 seconds by default.

Scale-down sequence:

1. Remove the replica from new-traffic routing and DNS.
2. Stop assigning new calls locally.
3. Let referenced active tasks drain. Unreferenced timers, listeners, and
   background handles do not block retirement.
4. Terminate the isolate and release its node assignment.

`min` is an availability guarantee while the logical realm is referenced.
A plain `Realm` remains one-to-one and is never implicitly split. Only a
`RealmDeployment` creates additional replicas.

## 5. Distributed control plane

Durable state needs a single fenced answer. Use a small Raft voter set (three
by default) for:

- deployment generations;
- logical realm specifications;
- replica assignments and attempt epochs;
- service-directory generations;
- controller membership and singleton fences.

High-rate observations remain soft state and do not enter the Raft log. Nodes
periodically publish reactor capacity, queue pressure, memory pressure, current
assignments, and readiness. Stale observations may cause an admission reject;
the reconciler then selects another node and commits a new attempt.

Loss of quorum freezes new durable assignments and routing generations. Ready
replicas continue serving from their last accepted routes where safe.

## 6. QUIC mesh

The seed is bootstrap, not the permanent application data path. Production
nodes need authenticated peer sessions over QUIC:

- stable `ClusterId` and public-key-derived `NodeId`;
- persisted node incarnation to reject messages from an old process instance;
- mutual proof of enrolled identity, not server certificate pinning alone;
- one bounded control stream plus persistent logical data streams;
- per-stream and per-peer byte/item limits;
- connection replacement rules that fence the older incarnation.

Discovery supplies candidate endpoints only. Static endpoints and mDNS are
appropriate first providers; membership begins only after authentication and
control-plane admission.

Application traffic, facade RPC, service calls, and artifacts should travel
directly between the participating nodes. Consensus and the seed stay off the
data path.

## 7. Service routing and DNS

The directory maps a logical service name to ready replica attempts and a
monotonic routing generation. DNS is a projection of that directory, not the
source of truth.

- publish only after readiness;
- withdraw before drain;
- attach assignment epoch/generation to cached routes;
- reject stale attempts at the destination;
- use short DNS TTLs, while direct clients can consume faster directory
  updates over the mesh;
- never advertise two attempts as the same fenced singleton unless the backing
  resource validates the fence token.

## 8. Cross-node replacement

A V8 isolate cannot be moved across machines. Cross-node relocation is a
make-before-break replacement:

1. serialize immutable realm configuration and optional application-level
   checkpoint;
2. create a fenced successor on the selected node;
3. wait for readiness;
4. advance directory/DNS generation;
5. drain the predecessor's referenced tasks;
6. terminate the predecessor.

Sockets, file descriptors, native pointers, submitted kernel operations, and
private heap state never cross this boundary. Stateful applications must use
external durable state or an explicit checkpoint contract.

## 9. Delivery stages

1. **Completed: reactor-only realms.** Remove embedded/reactor/remote kinds,
   child stepping, `RealmPool`, and cluster-driven realm construction.
2. **Completed: local movement.** Transfer live isolates at pump boundaries,
   rearm transferable operations, forward draining completions, and preserve
   the active isolate across reactor cycles.
3. **Completed: local deployment scaling.** Warm `min`, scale queued calls up,
   drain quiet excess replicas, and implement deployment `ref()`/`unref()`.
4. **Next: node observations and admission RPC.** Export reactor health and
   add an authenticated orchestration request/accept/reject protocol over the
   mesh.
5. **Next: durable reconciliation.** Add Raft-backed realm specs, replica
   attempts, epochs, and make-before-break recovery.
6. **Next: service directory and DNS.** Publish ready attempts, withdraw before
   drain, and test generation-aware routing.
7. **Next: direct data streams.** Route application traffic peer-to-peer with
   bounded persistent streams and backpressure.

## 10. Required tests for the next stages

- equal-load remote preference for a new realm;
- different-node preference for a replica split;
- destination admission rejection followed by safe retry;
- stale attempt and stale node-incarnation rejection;
- scale-out publishes only after readiness;
- scale-down withdraws before active-task drain;
- peer loss reconstructs only durable replicas;
- partition without quorum cannot advance assignment or routing generations;
- direct-stream queues remain bounded under a slow peer;
- local live movement never changes heap identity or logical port identity.
