# Multi-Node Distribution: Reactor Nodes over an Authenticated QUIC Mesh

> Status: concrete end-state design with staged delivery. This document defines
> how Fino nodes discover and authenticate one another, replicate durable
> cluster intent, place reactor and process workloads, and route application
> traffic directly over QUIC. The first production target is a VPC or LAN where
> every node can accept inbound UDP/QUIC traffic.
>
> This document aligns with the durable-intent versus soft-observation split in
> `multi-tenant-runtime.md`. It replaces this document's earlier leaderless
> DHT/SWIM design: durable deployment and fencing state use a small Raft quorum,
> while high-rate workload traffic remains peer-to-peer and does not traverse
> the control leader.

Useful references:

- [W3C WebTransport](https://www.w3.org/TR/webtransport/)
- [WebTransport over HTTP/3, draft-15](https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-http3)
- [QUIC, RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html)
- [Multicast DNS, RFC 6762](https://www.rfc-editor.org/rfc/rfc6762.html)
- [DNS-Based Service Discovery, RFC 6763](https://www.rfc-editor.org/rfc/rfc6763.html)
- [Raft](https://raft.github.io/raft.pdf)

## 1. The thesis

The cluster and the node-local scheduler are **two layers, not the same
scheduler repeated twice**.

The cluster control plane chooses a node for a workload. That node admits the
serialized workload through its existing `SchedulerNode`,
`NodeIsolateCollection`, and `WorkloadAllocator`, which choose a reactor thread.
Cluster code never addresses a reactor shard, and the node-local allocator never
needs a remote backend.

```text
durable desired state
        │
        ▼
Raft leader's PlacementReconciler ── chooses node + commits assignment epoch
        │
        ▼
destination ClusterAgent ─────────── admits or rejects locally
        │
        ▼
SchedulerNode ── NodeIsolateCollection ── WorkloadAllocator ── reactor thread
```

This boundary matters:

- cluster placement reasons about node capacity, failure domains, capabilities,
  and replica policy;
- node placement reasons about shard capacity, latency/batch class, affinity,
  runnable load, and budget debt;
- the destination may reject an assignment if its observation was stale, in
  which case the leader commits a new attempt elsewhere;
- a node's internal shard IDs, leases, transit handles, and reactor operations
  never become distributed state.

Raft gives the few state transitions that require a single answer—deploy
generations, assignments, controller membership, and singleton fences—a clear
quorum boundary. QUIC/WebTransport gives the data plane independent streams and
direct peer sessions. Discovery only supplies connection candidates; it is not
membership and it is never trust.

## 2. Current branch: what exists now

The design starts from the implementation on this branch, not the older
node-local sketches.

### 2.1 Reactor and allocation state

- The native reactor is the only event loop. Both the root runtime and child
  realms use the `cherenkov`-backed reactor path; the legacy JS poller stack is
  gone.
- A scheduler shard is a native reactor engine thread. It owns its completion
  reactor, runnable set, timers, owner-tagged I/O, budgets, and hosted V8
  isolates.
- Every scheduled unit is constructed as a full realm through
  `placeRealm` → `setup_realm_workload`: one bootstrap, one import-rule path,
  one transit channel, and one native pump path. The former parallel
  scheduler-tenant construction path has been removed.
- Every in-process cross-isolate realm port uses a transit half. Process realms
  bridge an unregistered half across their socket while the child exposes the
  same registered transit endpoint; pooled, dedicated-thread, and transferred
  ports otherwise share the mechanism.
- `Realm` no longer exposes thread placement. Normal realms pass through
  `internal:realm/allocate`; the lazy node pool currently has two shards with
  capacity one and falls back to a dedicated reactor thread when full or when a
  configuration cannot yet be pooled.
- `SchedulerNode` receives push reports for release, repeated sync-heavy
  detection, and load with actual accumulated budget debt.
  `NodeIsolateCollection` owns node-local records, placement, and atomic move
  reservations; `WorkloadAllocator` chooses only a local shard and excludes
  full destinations.
- A pooled realm is locally movable unless `localMobility: 'pinned'` or hard
  affinity says otherwise. A reactor keeps its selected isolate entered across
  slices and waits; it exits only when another isolate wins, the workload moves,
  or it terminates. Movement transfers exclusive ownership under V8's `Locker`
  contract, preserving module memory, pending promises, realm identity, and the
  existing transit port.
- Isolate-owned async resolver and FFI callback tables move with the isolate.
  Pending readiness and timer registrations are rearmed on the destination;
  pointer-backed operations retain thread-safe backing stores and may finish on
  the source, forwarding only their plain completion result before detaching.
- Blocking workloads move to lower-priority batch reactors. Batch capacity is
  created on demand within a configured bound, runs with lower OS scheduling
  priority as well as batch run-queue policy, and retires after its idle
  timeout.
- Realm scaling has a deterministic policy core. Realms default to
  `scaling.mode: 'replicated'`; `bound` realms are fixed at one isolate and are
  admitted directly to the lower-priority batch pool. The policy expresses the
  one-second loop-pressure scale-up threshold, 10%-for-30-seconds scale-down
  window, one pending action, and availability bounds. Replica construction,
  directory/DNS cutover, and referenced-task draining remain cluster work.
- `fino:runtime` exposes `ref(handle)`, `unref(handle)`, and `hasRef(handle)`.
  Numeric web timer IDs retain their web-compatible shape while native reactor
  liveness counts only referenced timers; refable resource objects use the same
  contract.

### 2.2 Cluster prototype state

The cluster implementation is a working remote-realm prototype, not yet the
substrate above:

- one trusted seed accepts WebTransport sessions from workers;
- workers have one outbound session to the seed and ignore the destination
  argument passed to `ClusterTransport.send`;
- the seed owns membership, remote-spawn selection, the global realm-port tree,
  heartbeats, failure cascades, and every `PORT_MSG` relay;
- each message opens a new bidirectional WebTransport stream, and a single
  per-connection promise queue serializes all sends;
- payload byte parts are base64-encoded into JSON, then the protocol JSON is
  encoded into another length-prefixed JSON frame;
- an inbound `SPAWN` calls `createThreadContext` directly and drives the realm
  with a zero-delay stepping interval, bypassing `SchedulerNode` and the node
  allocator;
- `NodeLoad` is sent as `{ cpu: 0, memory: 0 }`, so current remote placement is
  not based on live resource information;
- v1 spawn selection now includes the requesting node: a remote peer wins when
  its advertised load is equal or lower, while a strictly healthier requester
  remains local. This makes the desired bias observable today, but the zero/stale
  HELLO samples still require the v2 observation stream before it is reliable;
- `spawnRealm()` reaches a hidden internal remote `Realm` kind even though
  `remote` has been removed from the public `RealmOptions` surface.

The current tests strongly cover this star topology and node-local reactor
behavior. They do not yet cover authenticated peer sessions, distributed
placement, consensus, partitions, bounded network backpressure, or direct
node-to-node routing.

### 2.3 Corrections to the previous design

Several earlier claims are deliberately removed:

- `RealmRegistry` cannot be instantiated independently over hash-partitioned
  port keys while preserving parent/child edges that cross partitions. The
  distributed design instead keeps each ownership edge at its two endpoints.
- A Dynamo-style last-writer-wins ledger cannot also provide a single safe
  answer for deployment generations and singleton fences during a partition.
- A directory epoch cannot fence writes by an isolated old primary. Fencing is
  safe only when the stateful resource validates the token.
- The old tenant drain/snapshot protocol is not the node-local movement
  mechanism. Same-node movement transfers the live isolate and its reactor
  ownership. A future cross-node checkpoint remains application data only and
  cannot transparently preserve V8 heap state, sockets, file descriptors, or
  submitted kernel operations.
- Opening a stream per message does not create a persistent logical channel,
  and a global send queue defeats the concurrency that QUIC streams provide.
- Certificate hash pinning authenticates a WebTransport server, not its client.
  Node-to-node sessions need an additional client identity proof.

## 3. Design invariants

- **One binary, dynamic roles.** Every node runs a `ClusterAgent` and a local
  execution substrate. Configured nodes additionally host Raft voters; one
  voter is the current leader.
- **Three voters by default.** A production cluster normally uses three voters;
  five is available where two simultaneous voter failures must be tolerated. A
  one-voter bootstrap is allowed but reported as degraded.
- **Consensus is off the data path.** Application messages, facade RPC, service
  calls, streams, and artifact transfers go directly between the nodes involved.
- **Cluster placement stops at the node.** The cluster never chooses or names a
  reactor thread. Local admission and shard placement remain node-private.
- **Discovery is replaceable and untrusted.** Static endpoints and mDNS ship
  first. Kubernetes, cloud registries, WAN rendezvous, and relays can implement
  the same provider contract later.
- **Every production node listens.** The initial network model assumes stable,
  mutually routable private addresses and inbound QUIC reachability.
- **Durable and ephemeral work differ.** Deployment replicas are reconciled
  desired state. `spawnRealm()` children are parent-owned, non-durable work.
- **Movement depends on the boundary.** Same-node relocation transfers the live
  isolate between reactor threads. Cross-node relocation starts a new attempt,
  makes it ready, switches routing, and drains the predecessor; heap migration
  never crosses a process or machine boundary.
- **Fences are end-to-end.** A singleton is safe only if every state mutation
  reaches a resource that rejects stale fence tokens.
- **Serving degrades more gracefully than mutation.** Loss of quorum pauses
  deploys and new assignments; existing workloads and cached direct routes keep
  serving where possible.
- **Queues are bounded.** No network, control, port, or retry queue may grow
  without a byte and item limit.

## 4. Identity, enrollment, and discovery

### 4.1 Stable identity

Each node owns a persisted signing key under its cluster state directory.

- `NodeId` is derived from the public-key fingerprint and is stable across
  restarts.
- `nodeName` is an optional human-readable alias and is never used as an
  authorization identity.
- `NodeIncarnation` is a persisted counter incremented before each start. It
  makes messages, endpoints, and attempts from a previous process instance
  stale even when the `NodeId` is unchanged.
- `ClusterId` is minted when the cluster is formed and included in every
  discovery record, authentication transcript, durable record, and wire hello.

The control state stores each enrolled node's public identity key, permitted
roles, current/next TLS certificate hashes, and revocation state. Addresses and
health remain soft observations.

### 4.2 Bootstrap and enrollment

`startCluster()` creates the cluster identity, initial voter state, node
identity, and one-time join credentials. The returned join material contains:

```text
cluster id
one or more controller candidates
one-time or short-lived join token
expected controller certificate hash(es)
```

`joinCluster()` first establishes a certificate-pinned WebTransport session to
a controller candidate. It presents the join token and its public identity key,
then signs a controller nonce to prove possession of the corresponding private
key. The leader commits enrollment before returning the node record and current
controller/directory snapshot. Join tokens are never advertised by discovery.

Adding a Raft voter is a second, explicit operation using Raft joint-consensus
membership change. An enrolled worker cannot promote itself merely by setting a
local flag.

### 4.3 Discovery provider

Discovery supplies candidates through one interface:

```ts
interface ClusterDiscoveryProvider {
  watch(query: {
    clusterId?: string;
    role?: 'controller' | 'node';
    signal?: AbortSignal;
  }): AsyncIterable<ClusterDiscoveryEvent>;

  publish?(record: ClusterDiscoveryRecord): Promise<AsyncDisposable>;
}

type ClusterDiscoveryEvent =
  | { type: 'up' | 'update'; record: ClusterDiscoveryRecord }
  | { type: 'down'; nodeId: string };

interface ClusterDiscoveryRecord {
  clusterId: string;
  nodeId: string;
  role: 'controller' | 'node';
  host: string;
  port: number;
  path: string;
  protocol: 'fino-cluster-v2';
  certificateHashes: readonly string[];
}
```

The initial providers are:

- **Static discovery** from join material or configuration. This is always
  supported and is the dependable baseline when multicast is unavailable.
- **mDNS/DNS-SD discovery** using `_fino-cluster._udp.local`, backed by the
  existing `Mdns.publish()` and continuous resolved `Mdns.browse()` APIs. SRV
  carries the endpoint; TXT carries cluster ID, node ID, role, path, protocol,
  and certificate hashes.

Discovery events do not directly add or remove members. A candidate becomes a
peer only after authentication and an enrolled node becomes unavailable only
through the control plane's liveness policy. A future Kubernetes provider may
watch Services, EndpointSlices, or pods, but Kubernetes never becomes a core
runtime dependency.

## 5. Authenticated QUIC/WebTransport mesh

### 5.1 Session classes

The design uses three session classes so tenant load cannot starve consensus:

1. **Agent control session** — every worker maintains a persistent session to
   the current leader for observations, assignments, acknowledgements, and
   directory watches.
2. **Raft session** — voters maintain persistent sessions to one another for log
   replication, elections, and snapshots.
3. **Peer data session** — opened on demand between nodes that exchange realm
   port, service, artifact, or process-control traffic.

Each session class uses a separate WebTransport session and, in Fino's client,
a separately owned HTTP/3 connection. WebTransport streams have independent
stream flow control, but QUIC also has connection-level flow and congestion
control; merely adding another stream is not sufficient isolation for Raft.

The peer session manager keeps at most one live session for a `(peer, class)`
pair. If both nodes dial simultaneously, both authenticate first and then keep
the session initiated by the lexicographically smaller `NodeId`; if only one
valid session exists, it is used regardless of dial direction. Reconnect uses
exponential backoff with jitter and a configured maximum.

### 5.2 Mutual authentication

TLS and `serverCertificateHashes` authenticate the accepting endpoint. The
application protocol then authenticates the dialer:

1. the acceptor sends a fresh random challenge plus its node ID, incarnation,
   session class, and negotiated protocol/features;
2. the dialer returns its own nonce and signs a canonical transcript containing
   both nonces, both node IDs and incarnations, cluster ID, session class,
   protocol version, and the acceptor certificate hash;
3. the acceptor verifies the enrolled public key and returns its own signature
   over the same transcript;
4. both sides reject a wrong cluster, revoked identity, stale incarnation,
   unsupported version, replayed nonce, wrong session role, or mismatched
   certificate hash before accepting application streams.

This does not rely on `WebTransport.exportKeyingMaterial()`, which the current
Fino QUIC TLS backend does not support.

Certificate rotation publishes current and next hashes together in committed
node identity state. After peers acknowledge the next certificate, the leader
commits removal of the old hash.

### 5.3 Streams and framing

`fino-cluster-v2` replaces the seed-oriented v1 protocol. A session starts with
one persistent control stream and opens additional streams by purpose:

```ts
type ClusterStreamKind =
  | 'control'
  | 'raft'
  | 'raft-snapshot'
  | 'port'
  | 'service'
  | 'artifact';
```

- `control` is long-lived, ordered, and limited to small lifecycle messages.
- `raft` is long-lived and never shares a queue with node observations or tenant
  data.
- `raft-snapshot` and `artifact` use dedicated bulk streams.
- `port` is one ordered stream for one logical realm-port pair. It lives until
  either port closes, the owning attempt ends, or the session fails.
- `service` is one stream per streaming call or bounded request group, according
  to the service protocol.
- WebTransport datagrams are optional and carry only disposable observations
  such as latency probes. Assignments, heartbeats, exits, and route invalidation
  always use reliable streams.

Frames contain a fixed version/kind prefix, a bounded JSON control header, and
zero or more raw length-prefixed byte parts. Realm serializer output is carried
without base64 or a second JSON encoding. Initial limits are operator-tunable
with conservative defaults:

- 1 MiB maximum control frame;
- 16 MiB maximum data message;
- 16 MiB queued per logical channel;
- 64 MiB queued across one peer data session.

An oversized frame resets its stream. Repeated malformed or unauthorized
frames close the session. Every decoder reconstructs known fields rather than
forwarding unknown properties.

### 5.4 Ordering, backpressure, and failure

QUIC guarantees reliable ordered bytes within a stream, not across streams.
Contracts that require order therefore use one stream. Independent ports and
bulk transfers do not share application ordering.

The current global connection queue is removed. Each logical channel awaits its
own writer and accounts queued bytes. `ClusterPort.postMessage()` remains
synchronous but throws a typed `ClusterBackpressureError` when accepting the
serialized message would exceed its bound. Promise-based service calls expose
backpressure by awaiting their writes.

Session or stream loss rejects unacknowledged work. The transport never silently
replays an arbitrary `PORT_MSG` or non-idempotent request. A service layer may
retry only when its method contract is idempotent and the request ID supports
deduplication.

The seed relay may remain temporarily while v2 direct sessions are introduced,
but it is not a production fallback or a permanent controller responsibility.
NAT traversal and a dedicated relay service are future discovery/transport
providers.

## 6. Raft control plane

### 6.1 Why consensus is narrow

Raft is used only for state where two accepted answers would violate the API.
It does not store heartbeats, queue depth, every port, every route sample, or
application messages.

Durable replicated state includes:

```ts
interface ClusterState {
  identity: ClusterIdentityRecord;
  nodes: Record<NodeId, NodeIdentityRecord>;
  controllers: ControllerMembership;
  deployments: Record<DeploymentKey, DeployRecord>;
  assignments: Record<WorkloadKey, AssignmentRecord>;
  singletonFences: Record<ResourceKey, FenceRecord>;
  policy: ClusterPolicyRecord;
}
```

- `DeployRecord` carries a monotonic revision and complete desired component
  state.
- `AssignmentRecord` carries the active and optional pending attempt for one
  stable replica slot.
- `FenceRecord` carries a token derived from a committed Raft term/index and the
  active attempt allowed to use it.
- node identity and controller membership are durable; node addresses, load,
  and health are not.

Each voter persists its Raft log, term/vote state, and snapshots under its local
cluster state path. The exact Raft library and storage adapter require a
separate implementation ADR; the semantics in this document are independent of
that choice.

### 6.2 Soft observation state

Every agent streams a full observation on leader connection and deltas
afterward:

```ts
interface NodeObservation {
  nodeId: NodeId;
  incarnation: number;
  addresses: readonly PeerEndpoint[];
  capacity: NodeCapacity;
  capabilities: NodeCapabilities;
  load: {
    assigned: number;
    runnable: number;
    debtBand: number;
  };
  attempts: readonly AttemptObservation[];
  sequence: number;
}
```

The leader holds these observations in memory and publishes snapshots/deltas to
agents, gateways, and diagnostics. A new leader starts empty; nodes reannounce
without requiring a durable replay. Observations are accepted only from the
authenticated node and only for its current incarnation and increasing
sequence.

The initial load model uses signals the reactor actually reports. CPU and RSS
join only after real measurement exists; no protocol field is populated with a
placeholder zero and then treated as placement truth.

### 6.3 Failure and quorum behavior

The agent control session supplies heartbeats and carries observations. A broken
session is first `suspect`; reconnect within the grace window preserves the
node's assignments. After the leader's monotonic timeout expires, the leader
marks the node unavailable and proposes replacement assignments. Wall clocks
are never compared between machines.

On leader failure, agents discover or learn the new leader, reconnect, and send
full observations. During election:

- existing attempts continue running;
- cached service routes continue carrying traffic;
- direct peer sessions remain valid;
- deploys, new assignments, membership changes, and singleton transitions wait
  for a leader and quorum.

A minority partition cannot commit new desired state or fences. Stateless work
already running in that partition may continue serving through routes that can
still reach it. A stateful old primary can be made safe only by presenting its
fence to a store that rejects stale tokens.

## 7. Workloads and placement

### 7.1 Two workload lifetimes

**Ephemeral realm allocation** is the behavior behind `spawnRealm()`:

- it explicitly permits cluster placement but does not require a remote node;
- the parent mints a stable `SpawnRequestId`; the leader chooses a node from
  current observations and returns a short-lived, signed allocation ticket
  without adding a durable deployment record;
- the destination deduplicates that request ID for the ticket lifetime. An
  uncertain or failed allocation rejects rather than transparently selecting a
  second node, so user entry code is not accidentally started twice;
- the destination admits it through `SchedulerNode.deployRealm()` and returns
  the parent-side cluster port endpoint;
- the parent owns a local lease renewed over the peer session using the host's
  monotonic receipt time;
- parent exit sends `OWNER_RELEASE`; loss of renewal or confirmed parent-node
  death terminates the child;
- it is never automatically restarted after host failure.

Each host maintains a reverse index of ephemeral children by parent attempt or
parent node. A child that terminates releases its own children, so structured
concurrency cascades edge-by-edge without a global port tree.

**Durable deployment replicas** come from committed `DeployRecord`s:

- each component owns stable replica slots;
- the reconciler ensures the requested number of healthy active attempts;
- failed attempts are replaced according to restart and rollout policy;
- their readiness endpoints materialize the service directory;
- they may be realm workloads initially and process-sandbox workloads later.

### 7.2 Execution specification

The deployment schema is extensible over local executors:

```ts
type ExecutionSpec = {
  kind: 'realm';
  entry: string;
  data?: unknown;
  importRules: readonly unknown[];
  isolation?: 'reactor' | 'process';
} | {
  kind: 'process';
  command: string;
  args?: readonly string[];
  sandbox: ProcessSandboxSpec;
};

interface ComponentSpec {
  execution: ExecutionSpec;
  scaling?: {
    mode?: 'replicated' | 'bound';
    min?: number;
    max?: number;
  };
  resources: { memoryBytes?: number; cpuWeight?: number; slots?: number };
  placement?: {
    require?: readonly string[];
    spreadBy?: readonly ('node' | 'zone')[];
    colocateWith?: readonly string[];
    antiAffinity?: readonly string[];
  };
  restart: 'never' | 'on-failure' | 'always';
}
```

The first distributed executor is `kind: 'realm', isolation: 'reactor'`.
Process isolation and arbitrary sandboxed process execution reuse the same
node-level assignment protocol later, but use a local process executor rather
than a reactor shard.

Omitted scaling means replicated, `min: 1`, and a dynamic maximum equal to the
eligible reactor-thread count across the cluster. A configured maximum may be
lower but never raises that physical ceiling. `bound` means exactly one
caller-state-bound isolate; it may move live within its node but never splits.

### 7.3 Placement algorithm

The leader's `PlacementReconciler` evaluates candidates in two stages:

1. hard filters: enrolled and live node, protocol compatibility, execution
   kind, OS/architecture, required capabilities/native libraries, sandbox
   support, memory/slot availability, and failure-domain constraints;
2. spread replicas to nodes without a copy, then to reactors without a copy;
3. score: loop pressure, existing assignments, remaining slots, locality,
   colocation, anti-affinity, and deterministic `NodeId` tie-break. For an
   ordinary new allocation, a remote node wins whenever its score is equal to
   or lower than the requester.

The leader commits:

```ts
interface AttemptId {
  workloadKey: WorkloadKey;
  nodeId: NodeId;
  nodeIncarnation: number;
  epoch: number;
}

interface AssignmentRecord {
  active?: AttemptId;
  pending?: AttemptId;
  deploymentRevision: number;
}
```

The destination agent checks the assignment against its current local capacity
and either:

- admits the serialized spec to `SchedulerNode` and reports `starting`; or
- returns an admission NACK with a typed reason and a fresh observation.

A NACK never causes local overcommit. The leader clears the stale pending
attempt, increments the slot epoch, and chooses again. Once admitted, the node's
allocator chooses the reactor shard exactly as it does for local work.

## 8. Readiness, replacement, and fencing

### 8.1 Attempt lifecycle

```text
assigned → admitted → starting → ready → active → draining → stopped
                  └──────────────→ failed ────────────────┘
```

Every report names the full `AttemptId`. Reports from an old node incarnation,
deployment revision, or epoch are ignored. A host may stop an attempt after
learning it is stale, but stale cleanup is not required for correctness.

### 8.2 Rolling replacement

Relocation, rollout, and node drain all use replacement:

1. commit `pending = successor AttemptId` while the predecessor remains active;
2. the destination admits and starts the successor;
3. readiness is observed and the leader commits the successor as active;
4. directory watchers remove the predecessor from new routing and mark it
   draining;
5. the predecessor closes accepting handles, completes all referenced in-flight
   work, and terminates. Scale-down has no automatic force timeout; explicit
   operator cancellation remains available for stuck application work.

If the successor fails before cutover, the predecessor remains active and a new
pending epoch is selected. If the predecessor fails first, readiness policy
decides whether the successor may be promoted immediately or another attempt is
needed.

This mechanism replaces the earlier cross-node handoff promise. Compatible
tenant workloads may still use their mailbox snapshot during node-local shard
movement. Cross-node continuity requires an explicit application checkpoint
whose version and storage semantics are part of the component contract.

### 8.3 Singleton/stateful-primary workloads

The active primary receives a committed `FenceToken { term, index }`. The token
must be included with every mutation to a fence-aware Fino service or external
store. That resource remembers the greatest token it has accepted and rejects
smaller tokens.

Without such enforcement, Fino can provide best-effort single routing but must
not claim split-brain-safe singleton execution. A network-isolated old primary
can continue running after a new leader commits a replacement; only the stateful
resource can make its writes harmless.

## 9. Directory and data routing

### 9.1 Service directory

The service directory is a materialized soft view of:

- committed active assignments and deployment revision;
- current ready/health observations;
- node peer endpoints and certificate hashes;
- drain state and attempt epoch.

```ts
interface RouteTarget {
  service: ServiceKey;
  attempt: AttemptId;
  endpoint: PeerEndpoint;
  portId?: string;
  health: 'ready' | 'degraded';
  drain: 'active' | 'draining';
  zone?: string;
}
```

Agents watch a leader-provided directory snapshot and ordered deltas. They keep
the last valid snapshot across elections. Cutover, drain, revocation, and
confirmed node loss push invalidations; TTL is only a fallback for missed
non-safety-critical updates.

### 9.2 Route selection

The route picker filters to the current deployment revision and attempt epoch,
then prefers:

1. same reactor/node when the target is local;
2. same node through transit when it is in another local isolate;
3. same zone through a peer data session;
4. any ready non-draining replica.

It spills when a target is draining, over its bounded queue, or unhealthy. If
all targets are overloaded, promise-based RPC returns `ClusterOverloaded` or
waits in a caller-bounded queue; fire-and-forget messages never enter an
unbounded buffer.

An in-flight failure retries only an idempotent operation with a stable request
ID and receiver-side deduplication. Non-idempotent calls surface the failure.

### 9.3 Logical names and DNS

Logical service identity remains:

```text
fino://<tenant>/<app>/<component>
<component>.<app>.<tenant>.fino
```

The first routing phase exposes logical service ports over the in-process
directory API. DNS projection follows later, after `fino:net/dns` and `fetch`
delegate through an injectable provider. `.fino` handling then projects the same
directory rather than creating another source of truth. Capability denial is
shaped like not-found and physical topology is hidden unless explicitly granted.

## 10. Resource reporting, balancing, and scaling

The initial scheduler uses real capacity and current reactor summaries:

- configured realm/process slots;
- assigned workload count;
- runnable workload count;
- accumulated scheduling debt in microseconds;
- supported execution/isolation modes and native capabilities.

Later telemetry adds process RSS, per-attempt heap, thread CPU, loop idle, queue
depth, and request-rate EWMAs. Only measured fields participate in scoring.

Autoscaling uses loop health as a leading signal rather than waiting for CPU
saturation. Each replica reports active tasks, queue depth, oldest queue age,
p95 runnable delay, and interval busy ratio. Sustained queued/runnable delay at
half of the default 5 ms target for one second creates one successor. The
successor must be ready before the service directory publishes it. Continuing
pressure can request another replica only after that action completes.

Scale-down selects one replica only after it has no queued work and remains
below 10% busy for 30 seconds, while preserving `min`. Directory withdrawal is
synchronous and authoritative; DNS is a projection of that same route set.
Listener handles then stop accepting, admitted tasks retain references until
completion, and unreferenced background resources do not delay disposal.

Rebalancing first asks whether live same-node movement can isolate the offender
on a less-busy latency reactor or a lower-priority batch reactor. This preserves
the heap and avoids network transfer. A future cluster allocator should keep
that local preference while the node is within roughly 20% of the least-loaded
eligible node. Stronger node imbalance or unavailable local capacity escalates
to the replacement protocol: a node may report pressure and stop accepting new
work, but the leader commits the successor before the node drains a durable
replica.

Autoscaling is an output contract rather than a built-in cloud dependency:

```ts
type CapacitySignal =
  | { type: 'deficit'; constraints: NodeRequirements; pending: number }
  | { type: 'surplus'; candidates: readonly NodeId[] };
```

A provisioner plugin may translate the signal into cloud, bare-metal, or
Kubernetes actions. The default is observability only. Nodes still join through
the same discovery, enrollment, and control protocols.

## 11. Public and internal surface changes

The design permits breaking changes because no cluster API has been released.

- `joinCluster()` gains a required listen/advertise endpoint, persisted identity
  state path, bootstrap credential, and discovery-provider list. Every joined
  production node is peer-dialable.
- `startCluster()` forms the cluster and initial voter. It may publish mDNS and
  returns join material. Additional voters are added through an explicit
  committed operation.
- `spawnRealm()` means "allow cluster placement," not "force another node."
  The result may be local when local placement wins.
- Durable applications use `deploy(manifest)`/CLI deployment rather than
  `spawnRealm()`.
- The v1 `ClusterMessage` union and seed-broadcast transport are retired.
  Protocol v2 separates authentication, controller, Raft, allocation,
  lifecycle, directory, and data-stream messages.
- `ClusterTransport` remains injectable for deterministic tests, but its
  contract becomes session-oriented and destination-aware; broadcasting is not
  a seed-only primitive.
- `ClusterAgent` becomes an orchestrator service that owns discovery, identity,
  controller connection, peer sessions, directory cache, and local admission.
- There is no `ClusterAllocator` that federates `WorkloadAllocator`s or exports
  `node/shard` IDs. `PlacementReconciler` chooses a node and the destination
  allocator stays unchanged behind admission.

## 12. Implementation phases

Each phase is independently testable and leaves a useful runtime state.

### P0 — This document

- replace the DHT/SWIM design;
- record the reactor, allocation, transit, and cluster prototype accurately;
- lock the consistency, identity, discovery, workload, routing, and failure
  semantics above.

### P1 — Discovery, identity, and protocol v2

- add persisted node identities and cluster enrollment;
- define the discovery-provider contract, static provider, and mDNS provider;
- make joined nodes listen for WebTransport sessions;
- implement certificate pinning plus signed peer authentication;
- add protocol/feature negotiation, bounded v2 framing, session classes,
  deduplication, and reconnect behavior.

The existing seed remains the single controller during this phase, but it no
longer establishes trust merely from `HELLO.nodeId`.

### P2 — Direct peer ports and allocator convergence

- replace per-message streams with persistent logical port streams and raw
  binary serializer parts;
- route `PORT_MSG` directly by authenticated node endpoint;
- make inbound ephemeral allocations call `SchedulerNode.deployRealm()`;
- delete cluster use of `createThreadContext`, `stepThreadContext`, the
  zero-delay relay interval, and seed-owned port routing;
- implement parent ownership renewal/release and edge-local death cascades;
- retain seed relay only behind a temporary compatibility flag.

### P3 — Raft quorum and control watches

- integrate a proven Raft engine through a separately reviewed ADR;
- persist log, vote/term state, and snapshots;
- implement three-voter bootstrap expansion and joint membership change;
- replicate cluster identity, node enrollment, deployments, assignments,
  fences, and policy;
- add agent observations, leader discovery, reconnect/reannounce, and directory
  watches;
- prove fail-closed mutation and continued direct serving during elections.

### P4 — Durable deployment reconciliation

- add manifest validation and stable component/replica identities;
- implement node filtering/scoring, committed attempt epochs, local admission,
  NACK/retry, readiness, restart policy, and under-replication recovery;
- implement rolling replacement for deploys, moves, and node drain;
- expose cluster status, nodes, deployments, attempts, and degraded quorum.

### P5 — Service directory and routing

- materialize service routes from assignments and observations;
- implement attempt-aware cache invalidation, locality routing, drain behavior,
  overload errors, and idempotent retry/deduplication;
- add service-targeted ports/facades;
- refactor DNS/fetch through the provider seam, then add `.fino` projection.

### P6 — Telemetry, balancing, autoscaling, and process execution

- replace coarse load with measured CPU/RSS/heap/idle/queue telemetry;
- add pressure-aware replacement and autoscaling signals;
- add `process` execution through the existing sandbox planning/launcher
  substrate;
- add optional provisioner and discovery plugins without changing core
  scheduling.

### P7 — Stateful services and explicit checkpoints

- integrate fence validation into Fino-owned state services;
- expose fence tokens to stateful workload APIs;
- define an opt-in, versioned application checkpoint contract;
- do not claim singleton safety or resumable migration until their end-to-end
  tests pass.

## 13. Verification and coverage map

### 13.1 Existing baseline

The current branch already covers the behavior it implements:

| Requirement | Existing evidence | Status | Required action |
|---|---|---|---|
| v1 codec rejects malformed/extra fields | `tests/cluster/protocol.test.ts` | covered-v1 | replace with v2 family and limit tests |
| seed spawn/port/death routing | `tests/cluster/seed.test.ts` | covered-v1 | retire as P2 removes the star router |
| remote Realm call over WebTransport | `tests/cluster/public.test.ts`, `tests/realm/remote.test.ts` | partial | rerun through allocator-backed direct peers |
| stream metadata framing | `tests/cluster/webtransport-framing.test.ts` | covered-v1 | add partial-frame, size, binary-part, and stream-kind coverage |
| node-local placement/capacity | `tests/internal/orchestrator-node.test.ts` | covered | reuse unchanged behind admission |
| live isolate movement, reservations, batch lifecycle, budgets | `tests/internal/scheduler-node.test.ts` | covered-local | retain as the preferred local pressure response |
| cross-thread V8 state, timer/readiness/socket migration | `tests/internal/reactor-engine.test.ts` | covered-local | prove remote admission reaches this same execution path |
| mDNS browse/publish/update/down | `tests/net/mdns.test.ts` | covered-substrate | add discovery-record filtering and secret-absence tests |
| peer identity and session deduplication | none | missing | P1 focused security/session suite |
| Raft election/quorum/persistence | none | missing | P3 deterministic network/storage harness |
| direct peer ordering/backpressure | none | missing | P2 transport and slow-reader suite |
| durable attempt recovery/cutover | none | missing | P4 reconciliation suite |

### 13.2 Required focused tests

- **Discovery:** static and mDNS `up/update/down`, wrong-cluster filtering,
  duplicate suppression, cancellation, multicast unavailable fallback, and no
  token/secret in published TXT data.
- **Authentication:** correct join, wrong pin, wrong cluster, revoked node,
  stale incarnation, replayed challenge, forged signature, role mismatch,
  rotation overlap, protocol downgrade, simultaneous dial, reconnect, and
  cleanup after failed authentication.
- **Framing/transport:** fragmented/coalesced frames, unknown kind, oversized
  header/data, raw ArrayBuffer parts, per-port order, independent port progress,
  slow receiver bounds, stream reset, session loss, and no non-idempotent replay.
- **Consensus:** election, leader loss, quorum loss, stale term, duplicate
  request, log persistence, snapshot install, restart recovery, joint voter
  change, and fail-closed mutation.
- **Admission:** remote realm appears in `NodeIsolateCollection`, lands on a
  reactor shard, respects capacity/capabilities, deduplicates an ephemeral
  `SpawnRequestId`, fails an uncertain spawn without cross-node replay, NACKs
  stale placement, rejects stale attempt reports, and never starts the legacy
  stepping loop.
- **Lifecycle:** parent release, missed ownership renewal, parent-node death,
  multi-level cascade, durable host loss, restart policy, successor failure,
  readiness cutover, drain timeout, and stale predecessor cleanup.
- **Routing:** leader election with cached routes, pushed invalidation, locality,
  drain exclusion, all-target overload, idempotent retry/dedupe, and
  non-idempotent failure.
- **Security/fencing:** stale route rejection and a partitioned old primary whose
  write is rejected by a fence-aware test store.

### 13.3 Specification dependency map

| Specification requirement | Fino dependency | Design status |
|---|---|---|
| A WebTransport session can carry concurrent bidirectional/unidirectional streams and datagrams | existing `fino:net/http/webtransport` | implemented substrate; cluster v2 still missing |
| Reliable stream bytes are ordered within a stream, while independent streams do not share ordering | port/control/Raft stream layout | adopted explicitly; requires P2 ordering tests |
| QUIC applies both stream-level and connection-level flow control | separate controller/Raft/data connections | design requirement; requires saturation test |
| Certificate hashes authenticate the server but not the client | pin plus signed peer transcript | client proof missing until P1 |
| WebTransport over HTTP/3 uses negotiated session support and stream prefixes | existing HTTP/3 WebTransport stack | covered by network suites; v2 must not bypass it |
| DNS-SD uses PTR discovery plus SRV/TXT service metadata | existing `Mdns.browse`/`publish` | implemented substrate; cluster record mapping missing |

The cluster protocol itself has no external specification. Its v2 framing,
authentication transcript, message families, limits, and failure behavior are
therefore Fino-defined contracts and require direct protocol tests rather than
an interoperability claim.

### 13.4 Integration and performance gates

A multi-process harness boots three voters plus multiple workers on unique
loopback QUIC ports and proves:

- join, enrollment, leader election, and direct peer connection;
- workloads spread across nodes but use local reactor placement;
- port and service traffic does not pass through the leader;
- one controller can fail without ending application traffic;
- loss of quorum blocks mutation while existing routes continue;
- worker loss creates a new attempt and invalidates the old route;
- graceful drain starts the successor before removing the predecessor.

Performance gates compare direct versus v1-relayed port latency/throughput,
verify that a tenant flood does not delay Raft heartbeats/elections, count
sessions and streams, and hold memory within configured queue bounds under slow
receivers.

## 14. Explicit non-goals and later extensions

- No production NAT traversal or always-available relay in the first network
  model. Those belong behind future discovery and transport providers.
- No dependency on Kubernetes. Kubernetes-aware discovery/provisioning is an
  optional integration over the same contracts.
- No DHT, SWIM, consistent-hash ring, Merkle anti-entropy, or per-key lease
  authority in this design.
- No transparent V8 heap, live handle, fd, socket, timer, or in-flight-I/O
  migration.
- No split-brain-safe singleton without a fence-aware state resource.
- No cloud-specific autoscaler in core.
- No CPU-cost placement based on hints or placeholder metrics.
- No guarantee that an ephemeral `spawnRealm()` survives parent, host, or
  control-plane loss.

The existing sherry-flavored names remain optional user-facing vocabulary:
`cask` for a content-addressed deployment archive and `bodega` for its replicated
artifact store. Core implementation types remain descriptive (`ClusterAgent`,
`PlacementReconciler`, `PeerSessionManager`, `DirectorySnapshot`) so the
architecture is legible without the metaphor.
