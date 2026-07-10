# Realm Allocation: one generic realm, placed by the allocator

## The change

A realm today is constructed *at* a location: `new Realm({...})` picks embedded,
`thread: true` picks a fresh OS thread, `remote: true` picks a cluster node, and
`process: true` picks a child process. Placement is the caller's decision, made
at the API surface, and each choice runs different construction code.

This design removes placement from the API. A realm becomes a singular generic
thing — a serializable configuration — and an **allocator** decides which
reactor constructs and executes it. `thread` and `remote` disappear from
`RealmOptions`. There is no `reactor:` hint either (deferred until the
orchestrator interface is exposed to realms as a typed construct). The caller
says *what* to run; the system decides *where*.

```ts
const realm = new Realm({ entry: './worker.ts', overrides });
await realm.run();          // executes wherever the allocator placed it
```

The reactor work now implements this model: realm configs are serializable,
every scheduler thread runs the same native reactor loop, realm liveness and
I/O are owner-tagged, and all realm communication flows through one
MessagePort-shaped transit channel. Placement is owned by
`internal:orchestrator/allocator`'s `WorkloadAllocator`, the node's single
placement authority with capacity, affinity, and colocation policy. It was
deliberately kept node-local so a cluster allocator can choose a node without
learning its reactor IDs.

## Placement becomes an outcome, not an option

The current kinds survive as *allocation outcomes* the caller no longer names:

| Today's API | Tomorrow's allocator decision |
|---|---|
| `thread: true` | dedicated pooled reactor thread (own isolate) |
| embedded (default) | shared-reactor placement: own context multiplexed on an existing reactor thread |
| `remote: true` | cross-node: ship the config to a peer node's allocator (cluster active) |
| `process: true` | **stays an explicit option** — it is an isolation boundary, not a placement |

`process` is the one deliberate exception. It exists for OS-level sandboxing
(seatbelt/Landlock enforcement needs a process to confine), which is a security
property the caller must be able to demand — the allocator may not silently
substitute a thread for it. It is renamed in spirit from "where" to "how
isolated"; the option keeps working unchanged until the cluster model gives
processes a home as single-realm micro-nodes.

Embedded same-isolate realms (`opts.input`/`opts.output` port pairs, REPL
children) remain reachable internally — the REPL and a few fixtures construct
them via an internal path — but they leave the public option surface. Nothing
observable through `Realm`'s API distinguishes the outcomes: `port`, `run()`,
`call()`, `terminate()`, provider overrides, and facade binding behave
identically, which is precisely why the option can disappear.

## The allocator

The main thread starts its own reactor and is itself just the first realm. The
first allocation lazily starts the node's allocation service on that reactor —
the orchestrator — which owns a bounded pool of reactor threads and deploys
realm configs into them.

Current placement and offload policy:

1. **The lazy realm pool** starts two latency reactors with capacity one and
   falls back to a dedicated reactor when the pool cannot admit a realm.
2. **Replicated by default.** `RealmOptions.scaling` defaults to independent
   replicable heaps with `min: 1`; `mode: 'bound'` fixes the realm at one
   caller-state-bound isolate and places it directly on a lower-priority batch
   reactor.
3. **Fresh replicated realms** go to the least-loaded latency reactor with
   capacity. Cluster selection prefers another node when its load is equal or
   lower, and replica splits spread across nodes before filling more reactors.
4. **Local mobility defaults on.** `localMobility: 'pinned'` and hard affinity
   opt out; otherwise a pooled realm may move between reactor threads.
5. **Blocking isolation** uses repeated native slice reports, actual debt, and
   capacity reservations. A lower-priority batch reactor is created on demand,
   receives the same live V8 isolate, and retires after its idle timeout.
6. **The caller's thread is never a target.** Parents stay latency-clean; a
   parent that wants sync coupling with a child is the internal embedded path,
   not an allocator outcome.

The `WorkloadAllocator` already models this: shards with capacity and class
(`latency`/`batch`), occupancy read-back, affinity/preference requests. Realm
allocation introduces one new workload kind (`realm`) beside `app`/`job-pool`/
`tenant`, and the pool's shard roster *is* the reactor-thread pool. The
orchestrator's load reports drive rebalancing now: a blocking-heavy realm exits
its isolate at a pump boundary, transfers exclusive ownership under V8's
cross-thread locking contract, and resumes on a `batch` shard without module
re-evaluation or port replacement. Pending readiness and timers are rearmed on
the destination; already-submitted pointer-backed operations may drain on the
source and forward their plain completion result.

When a cluster is active, cluster placement chooses a node and that node's
allocator independently chooses a local shard. Reactor IDs and live-isolate
transfer remain node-private. Cross-node movement therefore uses a replacement
attempt from serialized configuration or an explicit application checkpoint;
it never treats a remote node as another `WorkloadAllocator` shard.

The executable autoscaling policy uses queue age and runnable delay as leading
signals, not CPU exhaustion: one second of sustained loop pressure may add one
ready replica; below 10% busy with no queue for 30 seconds may drain one. Route
withdrawal precedes listener closure, and referenced active tasks—not idle
listeners or unreferenced timers—control final realm disposal.

## What converges

**`Realm`** keeps its whole surface (`run`, `call`, `terminate`, `port`,
provider overrides, watch/reload) but its constructor stops branching on
placement. It builds the config, asks the allocator for a placement, and wires
the port to wherever the realm landed. `RealmKind` becomes internal state
reported by diagnostics, not API.

**`RealmPool`** stops constructing `thread: true` realms. It constructs N
generic realms; the allocator spreads them (pool-sibling anti-affinity is a
one-line preference in the placement request). The pool remains what it really
is: a dispatch/queue/timeout layer over N realms, with no placement opinion.

**The orchestrator engine's tenants** and thread realms stop being parallel
worlds. A tenant is a realm allocated with multiplexed placement plus facade
I/O; a thread realm is a realm allocated with dedicated placement. Phase 2
merges their construction so `NodeIsolateCollection` records are the only
lifecycle registry, and "step children" disappears into "the reactor drives
whatever realms it hosts."

## Phases

1. **Allocator seam without behavior change.** Introduce
   `internal:realm/allocate`: `allocate(config) → placement`, with v1 policy
   hardcoded to "dedicated reactor thread" (what `thread: true` does today).
   `Realm`'s constructor calls it; `thread`/`remote` are removed from
   `RealmOptions` (remote spawn stays reachable through the cluster API it
   already requires). All ~55 `thread: true` call sites in js/ and tests drop
   the flag. Suite must stay green with identical timing characteristics.
2. **Pooling + multiplexed placement.** Teach the native layer to create a
   realm context on an *existing* reactor thread (today each
   `createThreadContext` spawns a fresh thread). Pool width cap + least-loaded
   placement + `RealmPool` anti-affinity. This is where the allocator starts
   earning its keep.
3. **Orchestrator unification — implemented.** Realm workloads are records in
   `NodeIsolateCollection`; all engine tenants use the realm construction path;
   blocking-heavy realms move live to batch shards.
4. **Cross-node — pending.** The cluster control plane assigns a node and ships
   configuration; the destination admits through its unchanged local allocator.

Phases 1–3 are represented on the current branch. Phase 4 follows
`multi-node-distribution.md` and deliberately uses replacement across nodes
while preferring live transfer within a reasonably balanced node.

## Open questions

- **Eager vs lazy spawn.** Today `new Realm()` synchronously creates the
  context (thread spawn included) and `run()` starts it. Keeping construction
  eager preserves error timing (bad entry path throws at `new`), so v1 keeps
  it; a future queue-until-capacity allocator would shift errors to `run()`
  and needs a decision then.
- **`process: true` naming.** Keeping the flag as-is is the least-churn v1.
  If it should read as isolation rather than placement (`isolation:
  'process'`), the rename belongs in phase 1 while we're already touching
  every option site.
- **Nested allocation.** A realm creating realms goes through *its* node
  allocator (children of pooled realms allocate from the same pool, not from
  a per-realm sub-pool). This matches "structured concurrency = ownership
  bookkeeping, not nesting", but means a realm's children can outlive-ish its
  thread — lifecycle stays owned by the parent realm record either way.
