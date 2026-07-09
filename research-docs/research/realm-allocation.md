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

Everything the reactor migration built points here: realm configs are already
serializable (builder classes with toJSON/fromJSON), every thread already runs
the same reactor loop, realm liveness is already owner-tagged bookkeeping on a
shared per-thread reactor, and all realm communication already flows through
one MessagePort-shaped channel regardless of kind. Placement is the last
API-visible seam, and the allocator that should own it already exists:
`internal:orchestrator/allocator`'s `WorkloadAllocator` is the node's single
placement authority, with capacity, affinity, and colocation policy, and was
deliberately shaped so a cluster-level allocator can federate node-local ones.

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

Placement policy, v1 (deliberately boring):

1. **Pool width** defaults to `min(navigator.hardwareConcurrency, 8)` reactor
   threads, spawned on demand, never on the caller's thread.
2. **Fresh realms** go to the least-occupied pooled reactor. Under-cap that
   means a dedicated thread per realm — exactly what `thread: true` produced,
   so existing behavior and performance are preserved by default.
3. **Over cap**, realms multiplex: a pooled reactor thread hosts several realm
   contexts, each its own isolate-independent context with owner-tagged
   liveness on the shared reactor. (Same-thread multi-realm hosting is what
   the reactor's per-realm accounting was built for.)
4. **The caller's thread is never a target.** Parents stay latency-clean; a
   parent that wants sync coupling with a child is the internal embedded path,
   not an allocator outcome.

The `WorkloadAllocator` already models this: shards with capacity and class
(`latency`/`batch`), occupancy read-back, affinity/preference requests. Realm
allocation introduces one new workload kind (`realm`) beside `app`/`job-pool`/
`tenant`, and the pool's shard roster *is* the reactor-thread pool. The
orchestrator's existing load reports drive rebalancing later: a realm that
turns out blocking-heavy gets drained and respawned onto a `batch` shard —
and eventually onto another node — using the same child-initiated
drain+respawn machinery watch-mode reloads use.

When a cluster is active, the allocator gains remote shards: placement can pick
a peer node, serialize the config (it already is serializable), and allocate it
to that node's allocator, which runs it on one of *its* reactors. `remote:
true` stops being an API option because it stops being special: it is the same
decision with a longer wire.

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
3. **Orchestrator unification.** Realm workloads become records in
   `NodeIsolateCollection`; load reports feed rebalancing; blocking-heavy
   realms drain to batch shards. Engine tenants construct through the same
   path.
4. **Cross-node.** Cluster-active allocators exchange load and ship configs —
   the multi-node-distribution design's pull-based claiming, with the realm
   config as the unit shipped.

Phase 1 is small and mechanical; phase 2 is the first real native work
(context-on-existing-thread); phases 3–4 ride designs that already exist
(realm-loop-orchestration.md, multi-node-distribution.md).

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
