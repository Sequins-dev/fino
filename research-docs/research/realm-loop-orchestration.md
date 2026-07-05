# Realm Loop Orchestration and Node-Local Multi-Tenancy

> Status: concrete node-local design. This document defines how one Fino node
> hosts many tenant workloads, virtualizes I/O through facades, and fairly pumps
> work across V8 isolates and scheduler threads. Cross-node membership, quorum
> state, deployments, and cluster ingress remain in `multi-tenant-runtime.md`.

## 1. Design target

A Fino node is a set of OS threads with distinct roles. **Scheduler threads**
each run a tiny, thread-local scheduler that powers the event loops of every V8
isolate assigned to that thread. One or more **system-services threads** run the
orchestrator and the runtime's core services. The hot path is entirely local to
a scheduler thread: readiness arrives on the thread, the thread-local scheduler
turns it into runnable tenant work, and native host code enters the selected
tenant isolate and pumps it. Placement, supervision, and node-global registries
are the orchestrator's job and are deliberately kept off the hot path.

The split is the central design commitment:

- the **scheduler** is minimal, fast, and thread-local, so tenant work has good
  data locality and needs no cross-thread communication in steady state;
- the **orchestrator** owns the heavier management duties and the node-global
  view, and talks to schedulers only through coarse, infrequent coordination.

The first reliable design is deliberately conservative:

- plain V8 isolates are the scheduling, accounting, and lease unit;
- a tenant isolate may contain multiple same-tenant cooperative realm contexts;
- different tenants always run in different isolates;
- sandboxed same-tenant realms run in a separate isolate;
- hostile code, strict native-library risk, or strong policy isolation uses a
  process realm;
- app code never chooses thread placement; it asks the orchestrator, which
  schedules the realm context onto a scheduler thread;
- the orchestrator and core services *may* pin a realm to a specific thread —
  this is how scheduler threads themselves are booted (explicit-thread realms);
- parent/child realm contexts are colocated on one scheduler thread by default
  and split only by policy;
- cross-thread movement happens only at a quiescent handoff point or by
  reconstruction after failure.

This keeps correctness independent of context pooling, live arbitrary isolate
migration, or global readiness routing. Those can become optimizations after the
basic scheduler is observable and testable.

## 2. Runtime objects

The design uses a small set of explicit objects, reusing existing runtime
primitives rather than inventing parallel ones.

**Orchestrator** runs on a system-services thread and owns coarse node-local
policy: the node isolate collection, placement decisions, workload leases, shard
load summaries, lifecycle/deployment, and rebalancing commands. It extends the
existing `internal:orchestrator` (which already owns supervised workloads, a
lazy service registry, and the `runApp` single-tenant path). It is **not** in the
loop hot path.

**Node isolate collection** is the node-global registry of live tenant isolate
handles and their `TenantWorkloadRecord` metadata, owned by the orchestrator.
Scheduler threads do not own tenant isolates permanently; they claim operational
ownership by acquiring a lease handle from this collection. Dropping the handle
returns the isolate to the collection as claimable, unless it has been
terminated or explicitly transferred.

**Scheduler** is the tiny, thread-local loop on one scheduler thread. It owns
that thread's single readiness driver (kqueue on macOS, io_uring on Linux), one
shared wake pipe, timers, facade providers, the runnable set, budget accounting,
and the operational lease handles for the tenant isolates it is currently
allowed to pump. It does no placement and no management. Its only cross-thread
traffic is coarse orchestrator coordination and inter-realm messages.

**Tenant isolate** is one V8 isolate representing one tenant trust domain and one
scheduler workload lease. It has **no OS thread of its own**: it is hosted on a
scheduler thread and driven by that thread's scheduler loop. It is the unit for
CPU budget, heap budget, failure handling, and thread ownership. It is a
primitive of the realm system (§3), not a separate mechanism.

**Realm context** is a same-tenant execution context inside a tenant isolate.
Realm contexts form the structured-concurrency graph the app sees. A realm may
be split into another isolate when it requests sandboxing or when policy detects
that sharing harms fairness.

**Isolate (TS construct)** is the internal TypeScript handle for a tenant
isolate. It is distinct from `Realm`: internals hold `Isolate` handles and
decide scheduling, while a `Realm` placement resolves onto an `Isolate` on some
scheduler thread. App code sees only `Realm`; the orchestrator maps a placement
onto an `Isolate`.

**Facade operation** is data owned by the scheduler for a privileged operation
on behalf of a tenant realm. It records the operation ID, target realm, provider,
request payload, completion target, cancellation token, deadline, and
handoff-safe provider metadata. It is serialized with `internal:serializer`, not
ad-hoc JSON.

**Environment service** synthesizes the environment visible to tenant code. In
single-tenant development mode it can pass the host environment through directly.
In multi-tenant mode it constructs a scoped environment from deployment config,
tenant secrets, runtime metadata, and policy. Tenant realms should not read the
host process environment directly.

## 3. The pump: loop-fd nesting, wake-driven

TypeScript owns scheduling policy and almost all node-local orchestration. Rust
owns only the V8-unsafe operations: creating and storing isolate handles,
entering isolates, performing microtask checkpoints, requesting interrupts,
terminating execution, and waking scheduler threads.

The pump is **not** a bespoke dispatch loop. It reuses the runtime's existing
loop-fd nesting: one thread's event loop can own readiness for many child
isolates, block once in `tick()`, and pump a child only when it has work — with
no busy-sleep. The scheduled tenant isolate is built by decomposing
`run_child_isolate` into two pieces: **create-isolate** (V8 init, per-isolate
async state, root context, bootstrap — shared with thread realms) and **drive**
(thread realms spawn a thread and self-loop; tenant isolates do neither). A
tenant isolate is driven only when the scheduler calls the native pump.

Each scheduler thread repeatedly runs this loop:

```text
scheduler tick:
  1. block once in the thread's readiness driver (tick), covering:
       - the shared tenant wake pipe (a background completion for any isolate)
       - real I/O fds for facade ops the scheduler is performing for tenants
       - tenant timers
       - the orchestrator coordination channel
  2. drain completions into their target isolates' per-isolate queues;
     an isolate with a non-empty queue becomes runnable
  3. update the runnable set by priority, budget debt, deadline, backlog age
  4. choose one runnable tenant isolate
  5. enter it with a budget token and pump_and_checkpoint to quiescence
  6. record PumpResult and resource counters
  7. repeat while runnable work remains and budget allows, else go to 1
```

An isolate is entered and pumped **only when it actually has completions to turn
into microtasks** (or a due timer or an inbound message). An isolate whose
promises are all parked on outstanding facade ops is never entered until one of
those ops completes. The thread never `thread::sleep`s and never spins over
inactive isolates; the only blocking is the single kernel wait in step 1, cut
short the instant any source becomes ready.

A tenant isolate becomes runnable only through a concrete wake reason:

- inbound port or facade message;
- scheduler-owned I/O completion injected into the isolate;
- due timer;
- stream backpressure change;
- child realm exit or supervision event;
- V8 foreground/background task wake;
- explicit interrupt, terminate, reload, or debugger wake;
- future gateway request delivered as a trusted facade message.

`PumpResult` is one of:

- `idle`: no immediate host completion, due timer, queued message, or microtask
  can make progress (the isolate is parked, typically on a facade op);
- `runnable`: work remains and the isolate should stay runnable;
- `budget_yield`: the isolate yielded because its tick budget expired;
- `terminated`: policy or shutdown terminated the isolate;
- `failed`: execution failed and the workload needs scheduler handling.

**Per-isolate async state.** `IsolateAsyncState` is currently thread-local. To
host many isolates per scheduler thread cleanly, each tenant isolate gets its own
executor and completion/resolution queues keyed by isolate, while the scheduler
thread keeps a single shared wake pipe registered on its loop. A background
completion enqueues into its target isolate's queue and writes the shared pipe;
the scheduler drains, sees which per-isolate queues are non-empty, and pumps
exactly those isolates. This is what makes "only schedule an isolate when it has
completions" true at the mechanism level.

## 4. Quiescence and budget interruption

Run to quiescence means all scheduler-observable immediate work for the selected
tenant isolate has been made visible and all resulting explicit microtasks have
been drained:

```text
pump tenant isolate:
  apply pending facade completions
  deliver queued port messages
  expose due timers
  perform explicit microtask checkpoint
  repeat while progress is made and budget remains
  stop when idle, budget_yield, terminated, or failed
```

This reuses `pump_and_checkpoint`'s existing fixed-point convergence
(executor-tick → drain → microtask-checkpoint until quiescent). Because all host
asynchrony enters through scheduler-owned readiness, an idle tenant isolate does
not become runnable again until its scheduler observes another host wake or V8
task wake.

Budget interruption has two paths:

- normal fairness uses V8 `IsolateHandle::request_interrupt` to run an interrupt
  callback that marks the current budget token expired;
- hard cancellation, shutdown, or runaway synchronous JavaScript uses
  `terminate_execution`.

The normal path is cooperative at V8 safepoints. It should yield without marking
the tenant failed. The hard path is policy-visible and may require
`cancel_terminate_execution` before reusing the isolate, or full isolate
disposal if the runtime cannot prove reuse is safe. OS signals are not part of
tenant fairness.

Hard cancellation must come from a thread *other* than the one blocked in the
runaway, so it is a **system service on the orchestrator thread, written in
TypeScript** (`internal:orchestrator/budget-watchdog`), not a native thread. The
native surface is deliberately minimal: a process-global registry holds each
workload's thread-safe isolate handle and its currently-armed pump deadline; the
scheduler arms a deadline just before a synchronous pump and clears it just
after (cheap, in-process, no cross-thread traffic); and a single `sweepBudgets()`
primitive terminates every workload whose deadline has elapsed. The watchdog
service simply calls `sweepBudgets()` on a loop timer. Containment granularity is
the sweep interval — a runaway is broken within its hard budget plus at most one
interval, which is the right trade for catching infinite loops.

Long synchronous JavaScript cannot be given instruction-level fairness. The
scheduler response is detection and containment: count hard-budget violations,
lower priority, ask the orchestrator to split the realm into its own isolate,
promote to a process realm when policy requires, or reject further work for that
tenant.

## 5. State records

The scheduler state should be represented as data records, not hidden closures.
That makes simulation, handoff, recovery, and inspection possible. These records
also reconcile the two prior "workload" notions: the orchestrator's coarse
`Workload` (id/kind/status/handle) is the supervisory face of the same record
whose fine-grained scheduling half is `TenantWorkloadRecord`.

```ts
type TenantWorkloadState =
  | 'unclaimed'
  | 'claimed'
  | 'idle'
  | 'runnable'
  | 'running'
  | 'draining'
  | 'handoff_ready'
  | 'failed'
  | 'terminating'
  | 'dead';

type PumpResult =
  | 'idle'
  | 'runnable'
  | 'budget_yield'
  | 'terminated'
  | 'failed';

interface TenantWorkloadRecord {
  tenantId: string;
  workloadId: string;
  isolateId: string;
  threadId: string | null;
  leaseEpoch: number;
  state: TenantWorkloadState;
  priority: 'interactive' | 'service' | 'background';
  budget: {
    tickMicros: number;
    debtMicros: number;
    heapBytes: number;
  };
  runnableReasons: TenantWake[];
  lastPumpResult: PumpResult | null;
  counters: {
    recentCpuMicros: number;
    recentWakeCount: number;
    hardBudgetViolations: number;
    mailboxDepth: number;
  };
}

interface TenantWake {
  tenantId: string;
  workloadId: string;
  reason:
    | 'message'
    | 'facade_completion'
    | 'timer'
    | 'io'
    | 'backpressure'
    | 'child_event'
    | 'v8_task'
    | 'control';
  deadlineNanos: number | null;
  priorityBoost: number;
  sourceId: string;
}

interface FacadeOperationRecord {
  operationId: string;
  tenantId: string;
  workloadId: string;
  realmId: string;
  provider: string;
  request: Uint8Array;
  completionTarget: string;
  cancelToken: string;
  deadlineNanos: number | null;
  providerState: Uint8Array;
}

interface HandoffSnapshot {
  workload: TenantWorkloadRecord;
  wakes: TenantWake[];
  facadeOperations: FacadeOperationRecord[];
  timers: Uint8Array;
  mailboxes: Uint8Array;
  routeSubscriptions: Uint8Array;
  counters: Uint8Array;
}
```

The exact wire encoding is `internal:serializer` output. The rule is that handoff
state must be data-only and rehydratable by the destination scheduler thread.
Facade providers must not require JavaScript closures from the source thread to
continue an operation.

## 6. Workload state machine and leases

Tenant workload ownership is controlled by a lease handle from the node isolate
collection, which the orchestrator owns. A scheduler only has authority to enter
or mutate a tenant isolate while it holds the workload's operational lease
handle.

```text
unclaimed
  -> claimed
  -> idle
  -> runnable
  -> running
  -> idle | runnable | draining | failed | terminating

draining
  -> handoff_ready
  -> unclaimed | claimed

failed
  -> unclaimed | terminating

terminating
  -> dead
```

`unclaimed` means no scheduler currently owns the workload. `claimed` means a
scheduler acquired the lease epoch and is preparing local state. `idle` has no
immediate runnable work. `runnable` is in the local runnable set. `running`
means native code has entered the isolate. `draining` refuses new local work and
waits for a quiescent handoff point. `handoff_ready` has a `HandoffSnapshot`
prepared. `failed` requires reconstruction or termination. `dead` means no live
local state remains.

Leases work like controlled work stealing, but the placement decision is the
orchestrator's:

- the node isolate collection stores all claimable tenant isolate handles and
  their `TenantWorkloadRecord` metadata;
- claiming returns an operational lease handle that grants exclusive scheduler
  authority over that isolate;
- dropping the lease handle returns the isolate to the collection as claimable,
  unless the isolate is terminated or the lease is transferred as part of
  handoff;
- every scheduler publishes a compact load summary to the orchestrator;
- the orchestrator assigns unclaimed workloads to schedulers with capacity, or a
  scheduler with capacity may claim by compare-and-set on the workload lease
  epoch;
- an overloaded scheduler selects its largest movable workload and marks it
  `draining`;
- once the workload reaches quiescence, the source creates a `HandoffSnapshot`
  and releases or transfers the lease;
- the destination claims the new epoch, rehydrates readiness ownership, and
  resumes the workload;
- if a scheduler fails to renew, the orchestrator reassigns the workload and
  reconstructs from deployment metadata plus durable facade metadata.

Ordinary capacity-based moves are cheap coordination with the orchestrator, not a
global decision per claim.

The tenant isolate's heap is never migrated across threads — its host state is
thread-bound (`!Send`), so a move is drain → data-only `HandoffSnapshot` (the
workload record plus undelivered messages, unfired timers, and in-flight facade
operations) → reconstruct on the destination from the snapshot. A clean drain
preserves that pending work; a hard scheduler-thread crash preserves whatever was
last checkpointed, and otherwise respawns the workload from its record and entry.
This is exactly what makes later cross-node drain+respawn replication possible
without memory migration.

## 7. Facade-owned I/O

Tenant realms do not own real FFI I/O readiness by default. Their I/O modules
(`fino:file`, timers, later `fino:net`) are remapped at spawn time to
scheduler-backed providers:

```text
tenant realm:
  await fs.read(...)
    -> facade request over a tenant port

scheduler:
  validate capability
  start or attach to native operation on the scheduler's own loop
  store FacadeOperationRecord
  on readiness/completion, inject completion into the tenant isolate + wake it

tenant isolate pump:
  deliver completion as a message/microtask
```

This makes the scheduler the source of truth for readiness, gives handoff a
concrete data-only object to move (the facade operation record plus provider
state), and is the concrete first step of the syscall-virtualization vision in
`multi-tenant-runtime.md` §6. Direct native APIs remain possible only for trusted
runtime modules or explicit grants, and native-library passthrough is
incompatible with strong in-process containment.

Cross-thread calls use facade RPC over the existing per-port channel (mpsc +
wake pipe). A call to another thread is an explicit service message with bounded
queues, cancellation, overload errors, and priority metadata accepted by the
callee. Tenant isolates must not share mutable state across threads.

Gateway integration is intentionally deferred. Once a gateway exists, ingress
traffic should enter tenant scheduling as trusted facade messages that create
`TenantWake` records.

## 8. Fairness, priority, and memory

Runnable selection should be weighted by tenant priority and recent debt rather
than simple FIFO (`js/internal/scheduler/selection.ts` already implements
priority → deadline → debt → deterministic tie-break). The scheduler should
account at tenant-isolate granularity:

- priority class: `interactive`, `service`, or `background`;
- tick budget and accumulated debt;
- backlog age and mailbox depth;
- recent CPU time and wake count;
- heap usage and heap budget;
- hard budget violations;
- migration and sandbox eligibility.

Local responses happen before cluster replacement:

1. lower per-tick budget or priority;
2. ask the orchestrator to split a same-tenant realm into another isolate;
3. hand off the isolate to a less busy scheduler thread;
4. promote to a process realm when policy requires hard isolation;
5. report node-local pressure to the cluster control plane.

Memory pressure is also scheduler input. Soft pressure can trigger GC, idle
context eviction, tenant splitting, or lower background priority. Hard pressure
rejects new work, terminates background isolates first, or marks the node unable
to accept more replicas.

V8 foreground/background task wakes must enter the same readiness path as facade
completions and timers. If V8 schedules work for an isolate, the owning scheduler
receives a wake and records the isolate as runnable.

## 9. Node-local locality and spread

Within a node, the analog of the cluster's colocation-vs-replication tension is
locality-vs-spread across scheduler threads:

- **colocate** linked same-tenant realm contexts on one scheduler thread, so
  their messaging is cheap in-thread traffic rather than cross-thread RPC;
- **spread** across scheduler threads for parallelism and fairness when a single
  thread would saturate;
- **split / hand off** on overload, at a quiescent point (§6).

Cross-node replication stays deferred to `multi-tenant-runtime.md`. The
workload-record plus handoff-snapshot design is exactly what makes later
drain+respawn replication possible without VM-style memory migration.

## 10. Prior art and rationale

Cloudflare Workers/workerd is useful prior art, but the design should adopt the
principles rather than copy an implementation shape:

- V8 isolates are stronger boundaries than contexts:
  <https://v8.dev/docs/embed>.
- Cloudflare describes isolate-based Workers execution:
  <https://developers.cloudflare.com/workers/reference/how-workers-works/>.
- workerd documents script/isolate/context reuse and thread-use constraints:
  <https://github.com/cloudflare/workerd/blob/main/src/workerd/io/worker.h>.
- Cloudflare pairs isolates with process supervision and sandboxing for its
  security model:
  <https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/>.

The takeaway for Fino is density through isolate/context reuse where safe.
Contexts are useful for same-tenant realm structure, but they are not a hard
tenant boundary because GC, synchronous execution, and heap ownership are shared
inside the isolate.

## 11. Implementation phases

Implementation builds isolatable components first and wires the new scheduler
into normal app execution only at the end. Each component has a deterministic
test harness. Most work lives in TypeScript under `js/internal`; Rust appears
only where a V8-unsafe host primitive is required.

**Phase 0 — Doc retarget + term reconciliation.** This document. Define the
scheduler/orchestrator split and the `Isolate` construct; reconcile `Workload`
with `TenantWorkloadRecord`.

**Phase 1 — Scheduled-isolate primitive + non-blocking pump (native).**
Decompose `run_child_isolate` (create vs drive). Per-isolate async state keyed by
isolate with a shared per-thread wake pipe. Fold the standalone scheduler-native
prototype into the realm module: create a tenant isolate on the caller's thread,
`pumpIsolate(handle, budget) -> PumpResult` (never sleeps), `requestBudgetInterrupt`,
`terminateIsolate`. Remove the `thread::sleep` loop. Deterministic synthetic-isolate
tests.

**Phase 2 — Thread-local scheduler loop (TS).** Rewrite the scheduler as the tiny
thread-local pump: own the thread's loop, register each tenant isolate's wake
source (generalizing the child-loop watch), select via `selection.ts`, pump via
Phase 1, account budget/debt. Drop the per-tick `pollWakes` parent RPC — readiness
is local. Introduce the `Isolate` TS construct.

**Phase 3 — Facade-owned I/O via provider remap.** Replace the bespoke host-op
shim with import-remapped scheduler-backed providers (`fino:file` + timers first).
Emit `FacadeOperationRecord`s; run ops on the scheduler loop; inject completions
via Phase 1; serialize with `internal:serializer`.

**Phase 4 — Workload records + state machine (TS).** Implement `TenantWorkloadRecord`
plus the state machine as pure data with transition validation; drive the loop by
it; reconcile with `internal:orchestrator` `Workload`.

**Phase 5 — Orchestrator + node isolate collection + multi-thread.** Extend
`internal:orchestrator` into the node isolate collection + placement + load
aggregation; boot N scheduler threads via explicit-thread realms; real leases
(compare-and-set on epoch). App placement flows through the orchestrator; core
services may pin threads.

**Phase 6 — Budget enforcement + fairness.** Wire `request_interrupt` cooperative
expiry and `terminate_execution` runaway containment; real debt accounting,
priority classes, starvation guards.

**Phase 7 — Handoff + recovery + locality/spread.** `HandoffSnapshot` (data-only),
`draining` → `handoff_ready`, cross-thread lease transfer at quiescence,
reconstruction on scheduler-thread failure; colocation and split policy.

**Phase 8 — Runtime integration.** Multi-tenant deploy entrypoint routes through
the orchestrator; keep single-tenant `runApp` as the fast path; orchestrator-services
thread policy. Cluster stays deferred.

## 12. Test plan

The scheduler is validated as isolated components first, then as a composition
harness, then as native runtime integration.

- Scheduler-selection tests use only metadata and assert runnable ordering,
  tenant debt accounting, starvation prevention, wake coalescing, and
  deterministic tie-breaking.
- State-machine tests cover every legal transition and reject invalid direct
  transitions.
- Lease-registry tests prove exclusive claim, Drop-based return to the
  collection, epoch changes, transfer, and termination removal using fake
  handles.
- Facade-registry tests prove pending operations snapshot and rehydrate as pure
  data without closures.
- Environment-service tests cover host passthrough for single-tenant mode and
  synthesized tenant env for multi-tenant mode.
- Native primitive tests prove `pumpIsolate` never wall-clock sleeps, returns
  `idle` when parked on a facade op, and makes a parked isolate runnable when its
  injected completion arrives; `request_interrupt` cooperative budget yield and
  `terminate_execution` hard cancellation with synthetic isolates.
- Composition tests simulate timers, I/O completions, V8 task wakes, facade
  responses, stream backpressure, lease movement, and overload.
- Runtime harness tests prove idle isolates are not pumped, targeted wakes mark
  only the target isolate runnable, and a busy isolate cannot starve an
  I/O-ready isolate — on one thread and across threads.
- Handoff tests verify pending timers, messages, facade operations, and route
  subscriptions survive quiescent transfer.
- Run schedulers, fake tenant isolates, fake facades, and orchestrator services
  as contained realms where possible so the runtime can test its own scheduling
  model.

## 13. Native surface

The v1 native surface is small and explicit, and reuses the realm module rather
than a parallel mechanism:

```ts
createTenantIsolate(options);          // create-isolate on the caller's thread
createRealmContext(isolateId, options);
injectCompletion(isolateId, completion);
markRunnable(isolateId, wake);
pumpIsolate(isolateId, budget);        // enter + pump_and_checkpoint; never sleeps
requestBudgetInterrupt(isolateId);
terminateTenantIsolate(isolateId);
wakeScheduler(threadId);
```

Later primitives can add live isolate handoff, context pooling, per-context
accounting, fd ownership migration, and stronger memory controls. Those should be
added only after the v1 scheduler can prove fairness, recovery, and handoff with
deterministic tests.
