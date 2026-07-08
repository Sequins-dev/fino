# Multi-Node Distribution: The Cluster as a Lifted Node Scheduler

> Status: concrete cluster-level design. This document defines how many Fino
> nodes form one symmetric, self-organizing runtime that replicates tenants
> across nodes, balances them by resource cost, and routes traffic to the right
> replica. It is the cluster-level analog of `realm-loop-orchestration.md`:
> where that document defines how one node fairly hosts many tenant isolates
> across scheduler threads, this one defines how many nodes host many tenants
> across the cluster.
>
> It **supersedes** the single-leader control-plane sketch in
> `multi-tenant-runtime.md` §3 (a small seed quorum with one elected leader that
> schedules). The converged model here has **no steady-state leader**: nodes are
> identical binaries that self-organize through a distributed hash table (DHT),
> and the owner of a key is the authority for that key. The durable-vs-soft
> state split from §3 is kept verbatim — it maps onto DHT key namespaces (§4).

## 1. The thesis

The whole design rests on one observation: **the cluster is the node-local
scheduler lifted exactly one level.** Fino already has a maturing node-local
multi-tenant scheduler (`realm-loop-orchestration.md`, implemented under
`js/internal/orchestrator` and `js/internal/scheduler`). It places tenant
*workloads* onto scheduler-thread *shards*, leases them with epoch-CAS, moves
them between threads by drain → data-only snapshot → reconstruct, and recovers a
dead thread's workloads onto survivors. Every one of those primitives has a
cluster analog obtained by substituting *node* for *thread* and *DHT* for
*single-writer registry*:

| Node-local | Cluster analog |
|---|---|
| `NodeIsolateCollection` records + leases (`node.ts`) | DHT ledger, sharded across nodes |
| `WorkloadAllocator` placement chokepoint (`allocator.ts`) | `ClusterAllocator` federating node allocators by `node/shard` |
| shard = scheduler thread | node |
| `claim()` mints an epoch lease (`node.ts:183`) | key-owner CAS grant + fencing epoch |
| `renew()` / `revoke()` epoch CAS | lease renew/revoke against the key owner |
| `release('rebalanced')` re-places (`node.ts:255`) | return slot to `unclaimed`; a cooler node pulls it |
| drain / handoff / snapshot-on-`claim` (`node.ts:312`/`330`/`358`) | cross-node drain → snapshot → respawn |
| `recoverShard` + heartbeat supervision (`node.ts:378`, `scheduler-node.ts:228`) | node-down membership + K-replica re-pull |
| sync-heavy latency→batch `handoff` (`scheduler-node.ts:266`) | escalation rung 1 (already local); cluster adds rung 2 |
| least-loaded-of-class score (`allocator.ts:166`) | cost divergence vs the gossiped cluster mean |

The design goal is therefore not to invent a distributed scheduler; it is to
lift primitives that already work and are already tested. The bias throughout,
per repo convention, is **reuse and extend, never duplicate.**

The `WorkloadAllocator` doc comment already names the seam this document builds
into (`allocator.ts:12-14`): *"a future cluster-level allocator federates one
node-local allocator per node and routes by a node-qualified shard id, with this
class unchanged as a backend."* This document is that federation.

## 2. Design target and invariants

- **Symmetric nodes, identical binaries.** No node has a special standing role.
  There is no elected leader in steady state. The existing single seed
  (`js/internal/cluster/seed.ts`) degrades to a *bootstrap rendezvous* — a way
  for a brand-new node to find any one existing member — and is never on the
  steady-state path.
- **One DHT is the unified ledger and directory.** "What deployments exist,"
  "what runs where," "which nodes exist and where they are," and "who holds this
  singleton lease" are all keys in one distributed map, partitioned across nodes
  so no node holds the whole dataset.
- **The key owner is the authority for its key.** Placement, leasing, and the
  claim-set arbitration for a key are done by the K nodes that own that key's
  slice of the ring — the exact analog of the node-local collection being the
  single writer for its workloads.
- **Placement is pull, not push.** Desired state is written to the ledger; nodes
  with spare capacity *claim* replica slots they are eligible for. No node
  schedules another. This is `NodeIsolateCollection.claim()` (`node.ts:183`) one
  level up.
- **Per-component independent replication.** A tenant app is a set of
  components; each component has its own replica policy and scales on its own.
- **Cost-aware local shedding for balance.** Colocate linked realms by default;
  a node whose cost-weighted load diverges from the cluster mean sheds its
  costliest work, which a cooler node then pulls. Balance is emergent, not
  centrally computed.
- **Cross-node movement is drain + respawn, never memory migration.** Reuse the
  node-local handoff snapshot verbatim.
- **Capability narrowing stays Rust-enforced.** A tenant's I/O surface is its
  import rules, and children can only narrow, never widen (`src/realm/native.rs`
  `narrowing_check`). Cross-node placement and routing respect this boundary;
  the resolver is capability-gated.

The first reliable design is deliberately conservative in the same spirit as the
node-local one: correctness must not depend on live memory migration, global
consensus on the hot path, or a central scheduler. Those are explicitly out.

## 3. Composition: federate the allocator, wrap the node

Each node keeps its `SchedulerNode` unchanged: a private `NodeIsolateCollection`
(records, leases, entries), a `WorkloadAllocator` (thread placement chokepoint),
and N supervised scheduler threads (`latency` and optional `batch` classes),
already long-lived, push-driven, heartbeat-supervised, and crash-recovering.

Above it, a new per-node **`ClusterAgent`** runs as an ordinary orchestrator
service (`provideService('cluster-agent', …)`, `js/internal/orchestrator/index.ts:189`),
exactly like the jobs service, and supervises its claimed workloads through the
existing `registerWorkload`/`releaseWorkload`. It owns membership, this node's
DHT partition, the reconcile loop, and the cost/shed logic — the heavy
management duties, deliberately off the node's hot path, mirroring how the
orchestrator sits off the scheduler-thread hot path node-locally.

Placement composes as a two-level allocator. A cluster-level **`ClusterAllocator`**
federates the node-local `WorkloadAllocator`s and routes by a **node-qualified
shard id** (`node/shard`), with `WorkloadAllocator` unchanged as the per-node
backend. The pipeline for admitting one replica:

```
DHT replica-slot claim   →   ClusterAllocator   →   ClusterAgent   →   SchedulerNode.deploy(spec)   →   WorkloadAllocator
  (this node eligible?)         (which node?)         (translate)         (admit the workload)             (which thread?)
```

The collection and allocator stay oblivious to the network. The cluster decides
node granularity; the node-local allocator decides thread granularity. Crucially,
one vocabulary serves both tiers:

- `colocateWith` on `NodeWorkloadSpec` (`node.ts:56`) expresses "keep this near
  its sibling" at both the node tier (place the replica on the same node) and the
  thread tier (place it on the same thread — ideally the same isolate for
  same-tenant linked realms).
- `profile: 'latency' | 'throughput'` from the deployment manifest maps onto the
  node-local `ShardClass` (`latency` / `batch`), so a throughput component's
  replicas naturally land on batch threads and a latency component's on latency
  threads.

`deployNode({detach})` remains the single-node fast path unchanged. A new
`deployCluster(manifest)` writes a `DeployRecord` to the ledger and returns; the
reconcile loops on every node do the rest. `runApp` (single embedded tenant)
stays the development fast path and is untouched.

## 4. The DHT / ledger

### 4.1 Ring and ownership

A consistent-hash ring keyed by `nodeId`, with virtual nodes per physical node
for balance. For any key, `hash(key)` walks the ring clockwise; the first **K**
distinct *physical* nodes are the key's **preference list**, and the head of that
list is the **primary owner**. K is the ledger replication factor (default 3; 5
for large clusters). Because records are small JSON, a membership change moves
*records*, not workloads, and touches only ~K/N of the keyspace — the standard
consistent-hashing property.

There is no stable cross-node hash in the tree today (`Scanner`,
`protocol.ts:44`, is a lexer). A small deterministic `hash.ts` (FNV-1a /
xxhash-class) is a prerequisite (§13).

### 4.2 Key namespaces and the durable/soft split

The `multi-tenant-runtime.md` §3 distinction between *durable desired intent* and
*soft observed state* maps directly onto namespaces:

- `node:<id>` → `NodeRecord { addresses[], certHash, incarnation, load:
  NodeLoad(extended §9), capacity{cores,memory}, capabilities[] (resolved native
  libs), failureDomain{zone,node}, heartbeatSeq }`. **Soft**, LWW by
  `incarnation`/`heartbeatSeq`. This is also the membership record and the DNS
  A/AAAA equivalent.
- `deploy:<tenant>/<app>` → `DeployRecord { version, generation, components{…} }`
  (schema §7.1). **Durable desired intent**: monotonic `generation`,
  quorum-committed, fail-closed on partition.
- `service:<tenant>/<app>/<component>` → `ServiceRecord { generation, replicas:
  [{ nodeId, portEndpoint, epoch, health, drainState, load }] }`. **Soft** —
  this record *is* the route table / service directory (§11).
- `lease:<…>` → `ClusterLeaseRecord { holder, epoch, kind: 'ordinary'|'singleton',
  claimSet }` (§6).
- `port:<id>` → realm ownership-tree entry, replacing the seed's centralized
  `#portNodes` (`seed.ts:170`).

### 4.3 Reusing `RealmRegistry` as a per-partition library

The seed's `RealmRegistry` (`registry.ts`) is a port-ownership tree with exactly
the algorithms the DHT still needs: `register`, recursive `exit`, and a
`nodeDown` cascade that captures parent edges before removal
(`registry.ts:118-153`). It is kept as-is and instantiated **once per node over
the `port:` keys that node owns** — the centralized seed tree becomes a
per-partition tree. Death propagation (top-down) survives untouched; only its
ownership scope narrows from "the whole cluster" to "this node's keyspace slice."

### 4.4 Replication, anti-entropy, and consistency per namespace

Each key is replicated to its K preference-list nodes. Reconciliation between
replicas is Dynamo-style Merkle-range **anti-entropy** (periodic digest exchange
reconciles divergent ranges), with a per-namespace merge rule:

- `deploy:` — LWW by monotonic `generation` (desired intent; a multi-component
  deploy spans keys, so it carries a per-`deploy:` generation and is
  quorum-committed so two partitions cannot accept conflicting intent).
- `service:` / `node:` — LWW by `epoch` / `incarnation` (observed state).

Read-repair on lookup keeps hot keys consistent between anti-entropy rounds.

### 4.5 Ownership rebalancing on join / leave

- **Join**: new virtual nodes insert into the ring; for each range the joining
  node becomes newly responsible for, it pulls those records from the prior
  owner. The prior owner stays authoritative until the pull completes
  (read-repair covers the gap), so there is no availability hole.
- **Leave / failure** (SWIM `CONFIRM`, §5): the next preference-list node
  promotes to owner. For K-covered keys it *already holds a replica*, so no pull
  is needed — this is exactly the node-local `recoverShard` recovering from a
  checkpoint instead of a cold respawn (`node.ts:378`), one level up.

### 4.6 Bootstrap

`joinCluster` (`cluster.ts:328`) keeps its WebTransport connect, cert-pinning,
and join-string flow. `HELLO`/`WELCOME` (`seed.ts:272`) become the *bootstrap
handshake only*: `WELCOME` returns a membership seed set plus a ring snapshot,
after which the node switches to SWIM gossip and never depends on the seed again.
Steady state has no seed.

## 5. Membership: SWIM

Replace the seed-centric `HELLO`/`HEARTBEAT`/`PEER_UP`/`PEER_DOWN`
(`seed.ts:270`; client heartbeat `client.ts:356`) with SWIM:

- periodic randomized-peer `PING`; on timeout, indirect `PING_REQ` through *k*
  relays; `SUSPECT` → `CONFIRM` gated by **incarnation numbers** so a node can
  refute a false suspicion with `ALIVE`;
- **dissemination piggybacked** on ping/ack (infection style), not seed
  broadcast;
- the extended `NodeLoad` (§9) rides `ACK`s — this is what finally retires the
  hardcoded `cpu: 0` (`webtransport-transport.ts:295`).

New protocol messages extend the `ClusterMessage` union (`protocol.ts:242`):
`PING`, `PING_REQ`, `ACK`, `SUSPECT`, `ALIVE`, `CONFIRM`. Locally-derived
`PEER_UP`/`PEER_DOWN` are still emitted so `ClusterClient`'s membership map
(`client.ts:419`) needs no change. SWIM needs direct peer sessions — the same
direct-peer path the framing layer already scaffolds (`canonicalPortPair`,
`webtransport-framing.ts:105`) and that the data plane builds in §11. A
`CONFIRM(dead)` is the trigger that both promotes a successor owner (§4.5) and
wakes every node's reconcile loop (§7).

## 6. Leases, fencing, and quorum

`ClusterLeaseRecord` mirrors the node-local `LeaseRecord` (`scheduler/types.ts:69`)
one level up. The **key owner is the lease authority**, in two tiers:

- **Ordinary workload leases** — the lifted `claim()`: the owner mints
  `epoch = ++counter`, grants unilaterally, records the holder, and
  async-replicates the directory record to the K list. `renew` is a CAS on the
  epoch; `revoke` bumps it; a stale holder's next `service:` write is rejected on
  epoch mismatch — identical to `renew()` returning `false` after a `revoke()`
  (`node.ts` lease methods). A brief cross-partition double-grant is *safe*
  because ordinary components are active-active by design and the `service:`
  directory plus fencing epoch prevent stale routing.
- **Singleton / stateful-primary leases** — the owner performs a **quorum write**
  to the preference list (R+W>K, e.g. W=2, R=2, K=3) before granting. Failover
  reads the maximum epoch from a read quorum and grants `epoch+1`, fencing the
  old holder the instant its next write presents a stale epoch. This is the only
  place the cluster is more than the node-local mechanism, and it is contained to
  the singleton tier.

Prefer fencing epochs over wall-clock lease expiry — the node-local design uses
pure epoch-CAS with no clock, and preserving that property avoids clock-skew
correctness bugs.

New messages: `LEASE_CLAIM`, `LEASE_RENEW`, `LEASE_REVOKE`, `LEASE_GRANT` (names
deliberately echo the node-local methods).

## 7. Pull-based claiming: the reconcile loop

### 7.1 Desired-state schema

`DeployRecord.components[name]` follows the manifest shape from
`multi-tenant-runtime.md` §4, stored per-component so each scales independently:

```jsonc
{
  "entry": "src/api.ts",
  "replicas": { "min": 2, "max": 20, "minHealthy": 2 },
  "profile": "latency",                    // -> node-local ShardClass
  "links": ["worker"],                     // colocation preference
  "colocateWith": ["worker"],
  "spread": { "failureDomains": ["node", "zone"] },
  "antiAffinity": ["other-tenant-heavy"],
  "grants": [{ "pattern": "fino:net/*" }], // requested capabilities
  "ingress": [{ "host": "api.acme.example", "path": "/", "protocols": ["h2","h3"] }],
  "costHints": { "baselineMicros": 200, "perRequestMicros": 40 },
  "singleton": false
}
```

### 7.2 The loop (every node, every tick)

```text
for each component whose service: record shows healthy < minHealthy:
  if this node satisfies the constraints (§7.3)
     and has cost-weighted spare capacity (§9):
    CAS-claim a replica slot against the claim-set key owner:
      the owner atomically verifies { slot still open,
        spread still satisfied if I join, anti-affinity ok }
        -> assigns an epoch, adds me to the claimSet
      success -> SchedulerNode.deploy(spec); write the service: replica
                 endpoint, fenced by the epoch
      CAS failure (raced) -> exponential backoff + jitter, re-read, retry
```

The **owner is the atomic CAS arbiter of the whole claim-set**: two nodes racing
for the last failure-domain slot cannot both win, so spread and anti-affinity
resolve atomically and losers back off. This is precisely node-local `claim()`
sorting and capping candidates under one writer (`node.ts:183`), lifted to the
cluster. **Under-replication** is detected by the `service:` key owner
(`healthy < minHealthy` after SWIM removes a dead replica) and re-advertised as
an open slot. **Backpressure** is honest: if no node has capacity, the slot stays
`pending` — the direct analog of a node-local workload staying `unclaimed` when
no thread has room. The aggregate `pending` backlog is the autoscale-up signal
(§9).

### 7.3 Constraint evaluation

- **libs / capabilities**: `NodeRecord.capabilities ⊇ component.grants`. This ties
  into the loader's import-rule dispatch (`src/loader.rs`) and native
  `narrowing_check` (`src/realm/native.rs`): a node lacking a granted native
  library cannot host the component and simply never claims it. Nodes probe their
  candidate-path libraries at join and advertise the resolved set.
- **memory**: `capacity.memory − in-use ≥ profile estimate` (from the cost
  baseline, §9).
- **spread / anti-affinity**: evaluated atomically at the owner (§7.2).
- **cask / entry present**: gate the claim on "entry resolvable or cask
  fetchable," so a later drain+respawn never targets a node lacking the code
  (packaging is a separate concern — `multi-tenant-runtime.md` §5 — flagged, not
  built here).

After the cluster picks the node, the node-local allocator applies its own
`affinity`/`preferShard`/`ShardClass` policy (`allocator.ts:128`) to pick the
thread, honoring `colocateWith` at the thread tier.

## 8. Cross-node drain + respawn

Reuse the node-local handoff path verbatim (this is why realms are cheap to
relocate):

1. Source `ClusterAgent`: `collection.drainForHandoff(workloadId)` →
   `completeHandoff(...)` yields a data-only `HandoffSnapshot` (`node.ts:312`/`330`;
   `workload.ts:109`) — the record plus undelivered messages, unfired timers, and
   in-flight facade ops, all serializable, no live handles.
2. Ship it to the puller as a `HANDOFF_OFFER` payload over a direct-peer stream.
3. Puller: inject the snapshot into `#snapshots` (a sibling of `placeHandoff`,
   `node.ts:358`) and `deploy(spec)`; the first `claim()` hands the snapshot to
   the destination thread for reconstruction — the collection already supports
   snapshot-on-`claim`.

The heap is never migrated: a clean drain preserves pending work; a hard node
crash preserves whatever was last checkpointed and otherwise respawns from the
record and entry — identical to the node-local `recoverShard` policy.

## 9. Cost model, local shedding, and autoscaling

### 9.1 Cost model

Per component, `CostModel { baselineMicros (standing), perRequestMicros
(marginal), empiricalCpuMicros (EWMA from telemetry), heapBytes }`, seeded from
`costHints` and refined by the `multi-tenant-runtime.md` §2 telemetry (loop-idle
timing, `getrusage`/thread-CPU via FFI, `get_heap_statistics()`). Stored in
`service:` replica entries and aggregated into `node:` load.

### 9.2 Extended `NodeLoad` (prerequisite)

Extend the protocol `NodeLoad` (`protocol.ts:68`) to the §2 shape:
`{ cpu, memory, capacity{cores,memory}, loopIdle, realms: Record<id, RealmLoad> }`.
The node already push-reports its per-thread load on change
(`scheduler-node.ts` `#onReport` load/heartbeat) — this feeds straight up onto
SWIM acks. Until the §2 telemetry lands, the cost model runs on manifest hints
only and divergence-based shedding is disabled; the reconcile loop still enforces
`min`/`minHealthy` (graceful degradation).

### 9.3 The escalation ladder

As a node's load rises, response escalates:

1. **Spread across threads — already built node-locally.** A workload overrunning
   `syncSliceThresholdMicros` on a latency thread is migrated to a batch thread
   (`scheduler-node.ts:266`), and a heap-cap overrun terminates rather than OOMs
   the process. This rung ships today; the cluster inherits it for free.
2. **Spread across nodes.** When a node's `costWeightedLoad − clusterMean >
   threshold` (with hysteresis to prevent thrash), it picks its **highest
   cost-per-traffic replica** (worst locality payoff), drains it via §8, and
   returns the slot to `unclaimed`. A cooler node's reconcile loop then pulls it.
   This is the node-local least-loaded-of-class logic (`allocator.ts:166`) at
   cluster scale, and it is *local*: each node compares itself to the gossiped
   mean and acts alone. Balance is emergent.

### 9.4 Cluster autoscaling

The same signals drive node-count autoscaling:

- **Scale up**: a sustained aggregate `pending` slot backlog (no node could
  satisfy `minHealthy`) means the cluster is out of capacity.
- **Scale down**: sustained low ring-wide cost-weighted utilization means nodes
  are idle; drain a node via §8 and remove it.

Creating or destroying a node is environment-specific, so the agent emits a
`CapacityDeficit` / `CapacitySurplus` signal to a pluggable **node-provisioner**
hook (cloud API, k8s, bare-metal pool). The runtime ships the signal and a no-op
default provisioner, not a cloud integration.

## 10. Data plane, part 1: virtual DNS and the resolver

Application realms should never use public DNS or raw node addresses to find
cluster peers. They resolve virtual names through a capability-gated runtime
resolver backed by the DHT directory (§4.2). One DHT serves both service and node
location, so a full resolution is two cached hops.

### 10.1 Name grammar

Two surface forms, one canonical identity:

- **URI form** (facade/port routing): `fino://<tenant>/<app>/<component>[/<instance>]`.
- **DNS form** (HTTP/fetch): `<component>.<app>.<tenant>.fino` (reverse-label so
  `.fino` is a pseudo-TLD zone). `fetch('http://api.billing.acme.fino/…')` →
  component `api`, app `billing`, tenant `acme`.

Both normalize to the DHT key `service:<tenant>/<app>/<component>`. Label parsing
reuses the existing `Scanner` (a new `fino-name` format, mirroring the
`cluster-id` format at `protocol.ts:413`) so validation is Rust-backed.

### 10.2 Lookup and the two artifacts

`resolveService(name, caller)` does the two-hop DHT read
(`service → nodeIds → node → addresses`) behind an injectable
`DirectorySnapshot` interface (so it stays deterministically testable) and
produces:

- a **`RouteTarget`** (`{ nodeId, portId, address, certHash, zone, cost,
  drainState }`) for facade/port routing (§12) and the route picker (§11.1);
- an **SRV projection** for the DNS surface. `SrvRecord` (`js/net/dns.ts:326`) is
  reused unchanged: each replica maps to `{ priority: localityTier, weight:
  spareCapacity, port: internalHttpPort, name: <nodeId>.node.fino }`, and the
  node record projects to an A/AAAA `<nodeId>.node.fino → address`. Because the
  tier is the SRV `priority`, the stock RFC-2782 consumer ordering *already*
  prefers local replicas — the resolver emits standard records and the existing
  `Resolver`/fetch path does the rest.

### 10.3 Caching and invalidation

A per-resolver LRU keyed by canonical service key, with a short soft TTL (1–2 s,
serve-stale-and-refresh) and a hard TTL (10 s). **Drain and death beat cache
freshness**: safety transitions are pushed as `ROUTE_INVALIDATE`/`ROUTE_DRAIN`
(§11.2) that evict the entry *before* a caller can observe a draining replica.
TTL only bounds non-safety-critical load/latency reordering. Negative results
(unknown/denied) get a very short TTL and are shaped identically to
not-found (§10.4).

### 10.4 Capability gating

The resolver is constructed with the caller realm's granted-name set (a token
derived from its Rust-enforced import rules / tenant boundary). It rejects names
outside the grant with an error **indistinguishable from not-found** (no tenant
enumeration through names), returns a *logical* endpoint by default, and only
populates physical topology fields (`nodeId`, `zone`) when the realm holds an
explicit `cluster:topology` capability (operators, diagnostics). Trusting a
caller with topology is opt-in, never the default programming model.

## 11. Data plane, part 2: routing and direct-peer transport

### 11.1 The route picker

`pickRoute(serviceKey, caller)` chooses the cheapest healthy target in ascending
locality-cost tiers, which map onto the SRV priority so the DNS and port surfaces
make the same choice:

1. **Same-thread** — a replica in the caller's own realm/thread: short-circuit
   entirely, an in-process handle, no serialization. (The node-local colocation
   from §3 makes this common for linked realms.)
2. **Same-node** — a replica on the caller's node: the in-process thread-port
   relay, never touching QUIC.
3. **Same-zone** — direct peer WebTransport (§11.3).
4. **Any healthy replica** — cross-zone direct peer.

Health and cost inputs reuse the existing `NodeLoad` and per-replica
`ShardLoadSummary` telemetry. **Spill**: if the cheapest replica is over budget
(queue depth, loop-idle, draining), advance within the tier, then across tiers,
bounded by hysteresis so a transient blip does not cascade cross-zone.
**Backpressure**: if all replicas are over budget, apply the caller policy —
`reject` (a typed `ClusterOverloaded` error) for RPC, a short bounded queue for
fire-and-forget — never an unbounded buffer. Draining replicas are last-resort
and only for idempotent retries; dead replicas are removed before the picker sees
them (§11.2).

### 11.2 Route-table maintenance

- **Pull** the authoritative replica set from the DHT `service:` record (the
  control plane owns the writes; the data plane reads and caches).
- **Gossip** fast-changing, non-authoritative load (queue depth, loop-idle,
  latency) by piggybacking `ShardLoadSummary` on heartbeats; best-effort,
  TTL-bounded, never safety-critical.
- **Push** safety transitions: `ROUTE_DRAIN` (two-phase: control plane marks
  `draining` → push → callers stop picking it → after in-flight drains, remove)
  and death via the existing `PEER_DOWN` cascade (`seed.ts:294`,
  `#handleNodeDown`), reusing the `RealmRegistry` node→ports reverse index for
  O(1) "which services just lost a replica."

### 11.3 Direct-peer transport (getting `PORT_MSG` off the seed)

Today every `PORT_MSG` relays through the seed even though the addressing is
already peer-routable: `ClusterPort.sendPortMsg` computes `nodeIdFromId(toPort)`
(`client.ts:305`) but the worker transport ignores it and writes to the seed
(`webtransport-transport.ts:675`). The framing already anticipates direct peers:
`canonicalPortPair` + `ClusterStreamMetadata {kind:'port', pair, a, b}`
(`webtransport-framing.ts:80`) open one stream per port pair, demuxable without
the seed.

Add a `WebTransportPeerTransport`: one authenticated WebTransport session per peer
pair (reusing the seed transport's `PeerConnection` map and per-connection send
serialization), multiplexing logical channels over streams by extending
`ClusterStreamMetadata` with `rpc` and `repl` kinds alongside `control` and
`port`. The seed's remaining data-plane job shrinks to **introductions**
(`PEER_INTRO_REQ` → `PEER_INTRO {nodeId, address, certHash}`) — and even those can
come straight from the `node:` DHT record, making the seed a fallback rather than
a requirement. The requester dials the peer directly with cert-hash pinning
(exactly as `joinCluster`), completes a `HELLO`, and thereafter `PORT_MSG`/RPC
flow peer-to-peer. **The seed relay stays as the correctness fallback** during
session setup and for NAT'd peers, so the migration is incremental and lossless.

### 11.4 Internal TLS authority

Internal `fetch('http://…acme.fino/…')` resolves to a node address, then connects
over the same authenticated transport: authority = `<nodeId>.node.fino`, verified
against the DHT-published `certHash` (reuse `serverCertificateHashes` pinning),
not a public CA. The `.fino` name is validated by cert-hash pinning from the node
record. Cert rotation adds a rotation/epoch field to `node:` records (§13).

## 12. Wiring into the existing DNS/fetch and facade paths

### 12.1 The provider seam (a pure-refactor prerequisite)

`fetch` imports `lookup` directly from `fino:net/dns`, which uses a module-private
`_defaultResolver` (`js/globals/fetch.ts:107`; `js/net/dns.ts`), so the bound
`internal:net/dns-provider` is never consulted today. Before any cluster routing
can reach HTTP, refactor `lookup`/fetch to delegate to a bound `SystemDnsProvider`
(a thin `DnsProvider` over the existing `Resolver` — no behavior change). This is
the seam that makes "override the provider → reroute HTTP" true, and it is
independently shippable.

### 12.2 The cluster provider and its injection

`ClusterDnsProvider extends DnsProvider` handles `*.fino` names via the resolver
(§10) and delegates everything else to the wrapped `SystemDnsProvider` (so a
tenant reaches both internal services and the public internet, gated by its net
capability). It is injected at spawn via a `ClusterDnsConfig.toRules()` remap of
`internal:net/dns-provider` (the loader dispatches that builtin and enforces
narrowing in `src/realm/native.rs`, so a tenant physically cannot import a
different provider). The capability grant (§10.4) is threaded through the config
into the provider constructor.

### 12.3 Facade / port routing over services

A `ServiceClusterPort` (a variant of `ClusterPort`, `client.ts:712`) resolves its
target lazily via the route picker instead of a fixed `_setChildPortId`. Because
Facade RPC already rides `PORT_MSG` as opaque `__rpc_req`/`__rpc_res` payloads and
`Facade._bind` accepts any port type, **service-targeted facade RPC needs no
RPC-layer change** — the frames simply flow to whichever replica the picker chose.
On `PEER_DOWN`/`REALM_EXIT`/`ROUTE_INVALIDATE` the port drops its cached target
and re-resolves. In-flight RPC on a lost replica is retried against a new replica
only if the facade method is flagged idempotent; non-idempotent calls surface the
failure (at-most-once). That idempotency contract is a public-API decision worth
settling explicitly.

## 13. Risks and open questions

- **Ring hash**: no stable cross-node hash exists in-tree — pick one
  (FNV-1a/xxhash-class) in `hash.ts`.
- **Desired-state consistency across keys**: a multi-component deploy spans keys;
  guard with a per-`deploy:` monotonic generation + quorum so two partitions
  cannot accept conflicting intent (`multi-tenant-runtime.md` §3).
- **Split-brain**: singletons are protected by quorum (a minority cannot grant);
  ordinary leases are owner-unilateral and may briefly double-grant across a
  partition — acceptable because ordinary components are active-active and the
  `service:` directory + fencing epoch prevent stale routing.
- **Reconcile stampede**: many nodes chasing one open slot — the CAS arbiter plus
  jittered backoff handles correctness; add owner-side rate limiting to blunt the
  herd.
- **Clock**: prefer fencing epochs over wall-clock lease expiry (node-local uses
  no clock — preserve that property; bound skew only where singleton timeouts are
  unavoidable).
- **Prerequisites**: telemetry (`multi-tenant-runtime.md` §2) gates the cost
  model and cross-node shedding; packaging/cask (§5) gates cross-node respawn and
  the CLI deploy path.
- **Data plane**: internal-TLS cert rotation (rotation/epoch on `node:` records);
  cache-staleness vs drain (resolved by push-invalidation, not TTL);
  capability-leakage through names (grant checks must be constant-ish time vs a
  DHT miss); direct-peer NAT traversal (is seed-relay the permanent fallback, or
  is a relay node elected?).
- **Anti-entropy cost** at scale (Merkle over a large keyspace) — the standard
  Dynamo tradeoff; tune range granularity.

## 14. Implementation phases

Each phase is independently shippable with a deterministic test harness over the
loopback transport and a controlled clock, following `realm-loop-orchestration.md`
§11–12. Control-plane and data-plane tracks are largely parallel.

**Control plane**

- **P0 — This document.** Retarget; note it supersedes `multi-tenant-runtime.md`
  §3's leader model; pin the node-local→cluster mapping (§1).
- **P1 — Ring + hash** (pure): stable ownership, K-preference list, minimal
  reshuffle on join/leave.
- **P2 — Ledger core** (single-owner, in-proc): namespaces, schemas, CAS, fencing
  epoch; `RealmRegistry` per-partition for `port:`.
- **P3 — SWIM membership** over loopback; convert bootstrap (HELLO/WELCOME) to
  gossip, keep the join flow.
- **P4 — Distributed ledger**: replicate to K, anti-entropy, join pulls range /
  leave promotes successor, read-repair, partition behavior.
- **P5 — Two-tier leases**: ordinary CAS + singleton quorum + failover
  epoch-learning + fencing.
- **P6 — Reconcile loop + pull claiming + `ClusterAllocator`**: `DeployRecord`,
  claim-set CAS arbiter, constraint eval, backoff, under-replication;
  `ClusterAllocator` federates node `WorkloadAllocator`s by `node/shard`;
  `ClusterAgent` hosts it and drives `SchedulerNode.deploy`; `deployCluster`.
- **P7 — Real `NodeLoad` telemetry** (depends on `multi-tenant-runtime.md` §2):
  extended `NodeLoad` on gossip; feed up the node's push-reported load.
- **P8 — Cost model + cross-node shedding + autoscale signal**: rung 2 of the
  ladder (rung 1 already ships node-locally); `pending`-backlog →
  `CapacityDeficit`, low-utilization → `CapacitySurplus`; pluggable
  node-provisioner hook + no-op default.
- **P9 — Cross-node drain + respawn**: `HANDOFF_OFFER`/`ACCEPT`, inbound-snapshot
  injection, reconstruct; reuse the node-local handoff tests one level up.

**Data plane** (DP0 lands anytime as a pure refactor; DP1–DP3 are pure logic with
fakes; DP4–DP6 need P4's directory and P3's peer sessions)

- **DP0 — Provider seam**: route `fino:net/dns`/fetch through a bound
  `SystemDnsProvider` (no behavior change).
- **DP1 — `ServiceResolver`** over an injectable `DirectorySnapshot`: name
  grammar, two-hop, cache/TTL/invalidation, capability gate (denial ≡ not-found).
- **DP2 — `ClusterDnsProvider` + `ClusterDnsConfig` injection** (`.fino`
  resolves; else system DNS).
- **DP3 — Route picker**: tiers + spill/hysteresis + backpressure over load fakes.
- **DP4 — Direct-peer transport**: `WebTransportPeerTransport` + `PEER_INTRO` +
  stream-kind demux, seed fallback retained; `PORT_MSG` parity relayed vs direct.
- **DP5 — `ServiceClusterPort` + facade over service routing**: lazy resolution,
  re-resolve on failure, idempotency policy.
- **DP6 — Route-table maintenance**: load gossip + push invalidation + drain
  handshake (draining replica evicted before the next pick; dead-node cascade).

**P10 — CLI + surfacing**: `fino cluster start/join/status/nodes/deployments`,
`fino deploy --replicas`; cask/packaging integration (flagged — separate
concern).

## 15. Naming

Offered, not assumed, in the sherry lexicon `multi-tenant-runtime.md` already
proposes (fino is a sherry; the vocabulary is honest about what each thing does):

- **solera** — the scheduling/distribution system as a whole (a solera literally
  distributes contents across barrels over time): the `ClusterAgent` +
  `ClusterAllocator` + reconcile layer.
- **cask** — the content-addressed deployment archive.
- **bodega** — the replicated package store the casks live in.

The DHT ledger, the resolver, and the route picker keep descriptive names in code
for readability; the sherry names are for the user-facing surfaces if adopted.
