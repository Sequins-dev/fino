# Distributed realms: deferred research and staged roadmap

Status: research only

## Decision

Fino should first make one process an efficient, understandable runtime for
many Realm isolates across several reactor threads. Network distribution is a
later layer, not a requirement that the local scheduler must simulate today.

The first local slice is deliberately narrow: a submitted workload remains an
isolate-free, process-local `PendingWorkload` until one reactor claims it. That
reactor constructs and bootstraps the isolate. This removes serialized isolate
construction from the submitting thread without adding a cluster protocol,
durable ledger, system Realm, deployment format, or remote port proxy.

`PendingWorkload` is not a wire format. It contains channels, file descriptors,
and shared process state. Calling it serializable or portable would hide the
most important boundary the distributed design still needs to establish.

## What the previous attempts established

Three open prototypes contain useful prior art, but each crossed too many
architectural boundaries for one review.

| Attempt | Useful result | Why it is not the next merge unit |
| --- | --- | --- |
| [#1](https://github.com/Sequins-dev/fino/pull/1) | Explored a complete node-local orchestrator, scheduler, tenant lifecycle, placement, budgets, handoff, and recovery model. | 176 files and more than 27,000 changed lines couple scheduler mechanics to new orchestration, I/O facades, security, deployment, and recovery policy. |
| [#7](https://github.com/Sequins-dev/fino/pull/7) | Demonstrated that readiness routing can stay scalar and native while promises, buffers, syscalls, and retry policy remain in TypeScript. It also showed the value of keeping a resident isolate entered. | The prototype stops short of replacing the public Realm lifecycle and was built against an older scheduler shape. Its responsibility boundary is prior art, not a branch to merge wholesale. |
| [#27](https://github.com/Sequins-dev/fino/pull/27) | Demonstrated deferred isolate initialization and explored load sensing, cluster membership, peer transport, workload placement, shedding, deployment artifacts, reconciliation, draining, and watchdog enforcement. | 73 files and more than 13,000 changed lines combine a local lifecycle optimization with nearly the whole distributed control and data plane. Review cannot establish which invariant caused which complexity. |

The reusable lesson is a boundary, not a body of code:

- Rust owns unavoidable isolate/thread transitions and scalar readiness routing.
- TypeScript owns pool policy, lifecycle coordination, and observable APIs.
- A local pending allocation may contain process resources.
- A future portable descriptor must contain only stable data.
- Network coordination must consume the portable descriptor without leaking
  distributed policy into the reactor claim path.

## Local roadmap

Each stage should be independently reviewable, measurable, and removable.

### L1. Defer isolate initialization

Queue a process-local pending allocation and let the claiming reactor perform
the one-way `Pending -> Live` transition.

Required invariants:

- removing a pending allocation from the queue grants one worker exclusive
  initialization ownership;
- initialization failure settles the same parent-visible result as a failure
  from a live Realm;
- the async wake descriptor exists before submission, so readiness cannot be
  missed while initialization is pending;
- every file descriptor has one owner on success, failure, and pool shutdown;
- a forced stop requested before the isolate exists is applied when its handle
  becomes available;
- public JavaScript APIs and the scheduler-native export surface do not change.

Exit evidence:

- the focused Realm and bootstrap-error suites pass;
- a contention test creates a burst of sibling Realms and observes one result
  from each;
- Rust tests and formatting pass;
- a repeatable benchmark compares concurrent Realm construction before and
  after the change.

The checked-in `realm scheduler` benchmark provides that comparison. On a
12-logical-CPU Linux host using release builds on 2026-08-24, three runs of 16
concurrent Realm constructions and calls ranged from 1.14 to 1.18 seconds on
`origin/main` (1.15-second median) and 199 to 207 milliseconds with deferred
initialization (200-millisecond median), a 5.75x median improvement. A later
current-only repeat ranged from 198 to 255 milliseconds with a 207-millisecond
median. Every run returned all 16 values. This is directional local evidence,
not a statistical CI threshold; it measures the complete public lifecycle
rather than an isolated native setup function.

### L2. Bound local admission and cancellation

Deferred initialization lets submissions arrive faster than reactors can
bootstrap them. That is the intended throughput improvement, but the current
process queue has no admission bound and every pending scheduled Realm already
owns channels and several pipe descriptors. A large enough local burst can
therefore move the bottleneck from serialized V8 setup to unbounded memory and
descriptor retention without involving a cluster at all.

Define a TypeScript-owned admission policy with a small native mechanism for
an atomic bounded submit. The observable outcome must be explicit: immediate
rejection, caller-selected waiting, or another documented backpressure mode.
Do not silently drop a Realm or create a parent handle that can never settle.

Cover cancellation and shutdown while work is still pending, direct descriptor
counts across rejection and initialization failure, and the ability to accept
new work after pressure clears. Distributed tail shedding is not required to
prove any of these local invariants.

### L3. Measure and tune pool sizing

Keep this separate from L1. The current pool starts a configured number of
threads based on online processors. The alternative from #27 starts small and
grows with submitted work. Neither policy should be selected from intuition.

Measure at least:

- sequential Realm startup latency;
- concurrent Realm startup throughput at several burst sizes;
- steady-state I/O throughput with one, many, and oversubscribed Realms;
- CPU-bound overlap and main-loop responsiveness;
- idle thread memory and wake-up cost;
- behavior under container CPU quotas and explicit thread overrides.

Only then decide whether the default should be fixed, demand-scaled, or a small
warm pool with bounded growth. Preserve `FINO_REACTOR_THREADS` as a diagnostic
override. Core reservation is part of this decision and should not arrive as an
unrelated scheduler constant.

### L4. Fairness and runaway containment

Review queue locking, priority decay, preemption, and automatic watchdogs as one
local hardening slice. A mutex-to-`RwLock` rewrite is justified only if profiles
show queue contention after targeted worker wakes. System-only priority and
tail-shedding do not belong in this stage.

Required cases include equal-priority progress, a runnable waiter behind a
resident Realm, synchronous runaway code, top-level evaluation, force during
initialization, shutdown during pending work, and recovery of usable reactor
capacity after a forced stop.

### L5. Local observability

Add stable measurements only when a local policy consumes them or an operator
can act on them. Candidate signals are queue delay, active and pending counts,
slice time, loop turns, and isolate heap use. Keep process RSS/CPU fixes as
small standalone correctness changes. Do not introduce a `NodeLoad` protocol
type before there are nodes.

### Existing local validation debt

The focused sandbox suite can print a complete passing TAP result and then
leave the runtime parked during shutdown. The same behavior occurs on untouched
`origin/main`, so it is not part of deferred isolate initialization; it should
be isolated as a small lifecycle/test-runner investigation. Several existing
one-second concurrency assertions also fail when another worktree saturates the
host compiling V8, then pass independently when contention clears. Those tests
need a deliberate policy for performance assertions in shared development and
CI environments.

### Independent local memory track

[PR #42](https://github.com/Sequins-dev/fino/pull/42) is also single-node work:
pointer compression and isolate groups directly affect how many Realm isolates
one process can host. It is independent of queue policy and should stay out of
the scheduler iterations above. Because it overlaps the native isolate and
scheduler boundaries changed by L1, rebase it after L1 and require an explicit
per-Realm memory and handoff benchmark in addition to its correctness tests.
Its V8 upgrade, build changes, isolate wrapper, and SharedArrayBuffer behavior
should be reviewed as one runtime-substrate change, not as clustering support.

## The future portability boundary

Distribution needs two distinct values that #27 initially treated as one:

```text
PortableRealmSpec (stable data)
  + LocalRealmAttachments (process resources)
  = PendingWorkload (one process)
  -> LiveWorkload (one initialized V8 isolate)
```

A `PortableRealmSpec` might eventually contain:

- artifact identity and entry module;
- import and sandbox policy identifiers;
- serializable Realm and bootstrap data;
- resource class and placement constraints;
- parent Realm identity and a logical port identity;
- an idempotency key or desired-workload identity.

It must not contain file descriptors, V8 handles, Rust channels, local wake
pipes, callbacks, borrowed paths, or an in-memory parent port. The receiving
node resolves the artifact and policy, creates new local attachments, and only
then submits a local pending workload.

The first portable format should be versioned and round-trip tested without any
networking. Its schema should not be derived from native scheduler structs.

## Distributed research questions

### Identity, discovery, and routing

Realm traffic needs a stable logical destination independent of the current
socket or node. A plausible directory record is:

```text
RealmId -> { nodeId, nodeIncarnation, assignmentEpoch, state, endpoints }
```

The design must answer who is authoritative for this mapping, how updates are
fenced, what caches may retain, and what happens during expiry or partition.
"Distributed DNS" should mean a defined naming and cache-invalidation contract,
not merely putting Realm IDs into hostnames. Research should cover positive and
negative TTLs, stale-route retries, authenticated updates, split-brain behavior,
and whether external ingress resolves a service/deployment name before a Realm.

### Placement and claims

Initially, only workloads without an initialized isolate should move between
nodes. A durable coordinator may grant a claim over a portable descriptor, but
the local reactor queue should receive work only after that node owns the claim.
The protocol needs assignment epochs, node incarnations, lease expiry, and an
explicit commit point between "accepted remotely" and "initialized locally."

Exactly-once execution is not a realistic transport promise. The design should
state which operations are idempotent, which may be retried, and where durable
desired state or application-level deduplication is required.

Live isolate migration is a separate research project. It requires heap and
host-resource migration or application checkpoints and must not be implied by
moving an isolate-free descriptor.

### Ports and message delivery

A logical MessagePort crossing nodes needs defined ordering, backpressure,
bounded buffering, disconnect semantics, and ownership transfer. Sequence
numbers alone do not decide whether delivery is at-most-once or at-least-once.
Proxying through the old node preserves a local object identity but creates an
availability dependency; rebinding directly requires route updates and a
handoff protocol. Both options need failure tests before one becomes the base
abstraction.

### Artifacts and policy

Remote execution requires content-addressed application artifacts, verified
fetch, import-policy compatibility, and cache lifecycle. Packaging, deployment
generations, rolling replacement, and rollback are product layers above
scheduler portability. They should follow a portable-spec prototype, not land
in the same PR.

### Security and operations

Cluster identity, node admission, certificate rotation, authorization, audit,
drain, reconciliation, and disaster recovery are mandatory before untrusted
networks are in scope. They should use established transports and storage
primitives where possible. Building custom TLS and peer-mesh machinery is not a
prerequisite for validating Realm identity or placement semantics.

## Proposed distributed sequence

1. Specify and round-trip `PortableRealmSpec` with no networking.
2. Build an in-process fake directory and claim service; prove fencing and
   failure transitions deterministically.
3. Exercise the same contracts across multiple local processes using a standard
   authenticated transport; keep execution on one machine.
4. Add artifact transfer and cache verification.
5. Add logical port routing with bounded backpressure and explicit delivery
   semantics.
6. Add multi-node discovery, ingress resolution, leases, reconciliation, and
   operational lifecycle.
7. Add placement optimization and pre-initialization shedding only after the
   correctness path has soak and fault-injection coverage.

Every stage should have a protocol-independent state-machine test, a bounded
integration test, and an explicit failure matrix. A later stage may replace an
implementation, but it must not weaken the contracts established before it.

## Scope filter for scheduler PRs

A change belongs in a local scheduler PR only when it improves execution inside
one process without requiring a second node to justify it. "Useful eventually
for distribution" is supporting context, not sufficient scope. If a change
introduces membership, remote transport, durable placement, deployment state,
remote port proxying, cluster CLI, or node-wide control services, it belongs in
the distributed sequence above.
