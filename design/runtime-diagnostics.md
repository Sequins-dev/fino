# Runtime diagnostics across Realms

Proposal, 2026-09-07. The public API below remains a follow-up design. The
branch now includes an opt-in, bounded readiness ledger, generation checks,
parallel-test failure snapshots, and an offline analyzer. See the test CLI
guide for `FINO_TRACE_READINESS=1`. These implement the first diagnostic slice;
they do not yet provide holistic tracing of every Realm operation.

## What a user should be able to learn

A developer should be able to ask what each Realm owns, what it is waiting
for, and where an operation last made progress. A useful report connects an
application request to its Realm RPC, the child operation, its I/O registration,
the kernel result, and delivery back to the origin. It also explains what keeps
an otherwise finished Realm alive.

The kqueue failure demonstrates why aggregate counters are insufficient. Other
Realms received thousands of completions while some registrations never reached
the kernel. A report should have identified pending operations whose registration
batch failed, rather than concluding that wake delivery was healthy because the
controller was active.

## Existing foundations to extend

| Foundation | Current capability | Missing capability |
| --- | --- | --- |
| `internal:runtime/loop` | Resolver ownership, referenced/unreferenced timers, `_activeHandleCounts()` | Per-operation identity, origin and lifecycle evidence |
| `internal:scheduler/reactor` | Main-thread registrations and owner-tagged completion routing | Installation results and per-owner reconciliation |
| `src/scheduler_native.rs` | Actual scheduling state, mailbox queues and aggregate diagnostic counters | Bounded snapshots correlated with operation identities |
| `internal:realm/transport-port` | Ordered frame metadata, isolated observers, lazy copied payloads | Metadata-only observation without copying payloads |
| `internal:sim/journal` | RPC journals and cassette replay using transport observation | Runtime operation events and shared analysis |
| `fino:context/topic` and OpenTelemetry integration | Local event publication, context and export adapters | Explicit cross-Realm collection and stable runtime identities |
| `internal:orchestrator` | Managed workload registry and retained workload signal | Complete descendant topology, including unmanaged children |

Topics use a module-local registry. Their module comment says process-wide,
but that is not an aggregation mechanism across isolated module graphs. A root
subscriber cannot be assumed to see child publication. Existing transport
observers copy frame payloads for matching observers; metadata-only diagnostics
should extend that mechanism, not create a second transport interceptor.

## Proposed layering

1. **Operation evidence at the owning boundary.** The runtime loop, readiness
   controller, transport and host scheduler publish their own transitions.
   Observation never performs delivery or owns application buffers.
2. **A bounded journal and reconciler.** A reusable TypeScript event reducer
   builds resource, operation and Realm views. It handles sequence gaps and
   partial snapshots explicitly. Live execution and simulation feed the same
   reducer; protocol adapters translate their existing events into this schema.
3. **A public `fino:diagnostics` module.** A session exposes snapshots, bounded
   event observation, and analysis scoped by an explicit diagnostic capability.
   Naming and signatures need review before implementation.
4. **Consumers.** Test-runner stall reports, application diagnostics, a CLI
   recorder, and OpenTelemetry export consume the same module. Simulation adds
   controlled inputs and faults; the diagnostics module explains observations.

Do not build a second scheduler, serializer, RPC transport or telemetry SDK.
Use the existing Topic, transport observation, context and export mechanisms.
Before implementing storage, inspect existing bounded collection primitives;
if none fit, the journal buffer should be generic and tested independently.

An illustrative end-user surface (not runnable yet):

```ts
import { observeRuntime, analyzeRuntime } from 'fino:diagnostics';

// The embedding host or CLI grants this scope; an import is not permission
// to inspect every Realm in a process or cluster.
const session = observeRuntime(diagnosticCapability, {
  history: { maxEvents: 100_000, maxBytes: 16 * 1024 * 1024 },
  captureStacks: false,
});
try {
  const snapshot = await session.snapshot({ timeoutMs: 200 });
  console.log(snapshot.realms, snapshot.missingSources);
  console.log(analyzeRuntime(snapshot));
} finally {
  await session.close();
}
```

The session can additionally expose a bounded async event stream. A CLI option
on `fino run` could create the session before application startup and save a
versioned recording on timeout or exit. An offline CLI report should consume
that recording through the same analyzer, making a bug report useful without
rerunning the application. Final naming should follow the existing CLI/task
and public-module conventions.

## Identity and lifecycle contract

Identify a runtime incarnation, logical Realm and its execution generation.
Reactor migration changes placement, not Realm identity. Restart changes the
generation. Process-local native owner numbers need an explicit mapping; an fd,
PID, thread index or pointer is not a stable identity across reuse or hosts.

A resource record must also track native borrowers. Owner-tagged routing cannot
protect a wake pipe if a stale native reader consumes its byte through a recycled
fd before the readiness controller sees it. Closing a logical owner must shut
down outstanding I/O, while actual descriptor release waits for its borrowers.
Record that distinction explicitly. The same rule applies to background FFI
completions and external-buffer finalizers: record the retained wake endpoint
and its originating generation, even after the logical Realm has retired.

The QUIC repair also demonstrates why logical closure must be visible: a packet
callback closed a transport, then the receive loop installed another read watch
on its released fd. Record attempts to register work after resource closure and
correlate them with the resource generation, even if the numeric fd now belongs
to a different Realm.

A readiness request now retains a separate descriptor while it crosses the
mailbox and remains installed. Track that controller borrower independently
from the caller's descriptor: they refer to the same open resource but have
different close points. The current internal pool snapshot reports
`readinessBorrowedFds`; a public analyzer should reconcile those borrowers with
pending and installed registrations. Kernel references count too: retiring a
JavaScript io_uring poll record does not cancel the kernel poll or release its
open-file reference.

Pending registration commands need their own visible state. A watch can be
created and cancelled before its batch reaches the kernel; submitting that
obsolete ADD after descriptor reuse can fail or attach to the wrong resource.
Record supersession and cancellation before installation, alongside actual
kernel receipts. Likewise, transport shutdown must distinguish stopping reads
from draining accepted outbound frames: retaining the descriptor alone does
not guarantee that a queued termination message can still be written.

Scheduler evidence must distinguish a recorded wake from a runnable queue entry
that can actually win admission. A stale high-priority heap entry can hide a
current lower-priority entry from preemption even while the signalled Realm is
correctly queued. Record queue generations and the reason a scheduling decision
keeps or switches the current Realm, with bounded sampling on hot paths.

Separate a resource from an operation on it. One socket can outlive many read
waits; one persistent signal watch can produce many notifications. An operation
ID includes its origin Realm generation and a local monotonic sequence. Each
re-arm carries a registration generation, and each persistent notification gets
its own delivery identity. Record optional parent operation, request/trace and
transport correlation identities where those causal relationships are known.

The I/O adapter reports:

```text
created -> registration queued -> installed -> ready
        -> completion queued -> completion consumed -> resolver invoked
```

Registration failure, cancellation and closure are explicit branches. A late
completion after cancellation is recorded as such, not automatically diagnosed
as a lost event. Installation must mean acceptance by the backend; merely
enqueuing a command cannot claim it. One-shot operations have one terminal
outcome; persistent resources have separate per-notification outcomes.

Resolver invocation is observable at the runtime boundary. It does not prove
that every downstream user Promise reaction ran. Arbitrary Promise graph
tracking should be an optional, separately costed V8 instrumentation feature,
not an implied capability of handle diagnostics.

Each source assigns monotonically increasing event sequences and monotonic
timestamps. Cross-process ordering comes from causal links, not wall-clock
comparison. Snapshots carry source watermarks, observation time and missing
sources. They are not advertised as an atomic global cut. Analysis must
reconcile races or mark the result inconclusive.

## Useful analyses

| Question | Required evidence | Classification |
| --- | --- | --- |
| Why will this Realm not exit? | Live referenced resources, ownership, pending runtime work | Observed liveness causes |
| Was this registration installed? | Correlated request and backend receipt | Pending, accepted, failed or unknown |
| Where did this response stop? | Per-operation route, enqueue, consume and resolver events | Last confirmed boundary |
| Did a completion go to the wrong execution? | Origin and destination Realm generations | Contract violation when evidence is complete |
| Was a resolver overwritten? | Two active registration generations on an exclusive key | Contract violation or explicit replacement policy |
| Is shutdown leaking work? | Ownership closure plus outstanding operations and terminal outcomes | Unreleased resources after the chosen grace period |
| Why did forced termination not finish? | Termination request, scheduler admission, interrupt observation and owner retirement | Last confirmed boundary; an idle owner with no queued wake is a scheduling violation |
| Is this operation stuck? | Deadline and last progress, plus collection freshness | Suspected stall, not proof from elapsed time alone |
| Is there a dependency cycle? | Explicit wait edges and possible external progress | Cycle evidence; deadlock only if progress is ruled out |

For the current defect, a report could say: a read operation is waiting; its
registration was submitted in batch B; a prior cancellation returned ENOENT;
there is no installation receipt for this operation. An active controller or
empty completion mailbox does not contradict that finding.

Counts remain useful for cheap monitoring. Exact correctness checks need an
unsampled capture or a reconciled authoritative snapshot. Event loss disables
negative claims such as "this operation never completed" until reconciled.

Call response, shutdown-hook completion and Realm retirement are distinct
milestones. A returned call must not be reported as a fully stopped Realm, and
normal asynchronous cleanup must not be mistaken for abandoned execution that
needs a forced stop. Lifecycle records should show active cleanup hooks and
whether termination was cooperative or forced, without retaining callback
closures or application data in the journal.

## Collection that still helps during a stall

Capture latest state at each boundary as work passes, rather than asking a
stranded Realm to reconstruct it after a watchdog fires. Store bounded recent
evidence outside the target Realm when possible. Every query has its own
deadline and reports missing or stale sources without hanging the caller.

Most instrumentation, aggregation and analysis belong in TypeScript. Native
changes are limited to exposing scheduler/mailbox state that only the host can
see, or retaining bounded scalar evidence at those boundaries. Never enter a
running isolate from another thread or read its JavaScript maps unsafely.

An ordinary diagnostic RPC may stall behind the same broken application path.
Controller/host snapshots therefore need to distinguish their own evidence from
unanswered Realm queries. For a blocked main thread or crashed process, an
external recorder/watchdog can retain the last published evidence and report
that collection stopped. A live in-process module cannot promise to diagnose
every failure of the process hosting it.

## Bounds, permissions and observer behavior

Observation is opt-in. The disabled path should avoid stack capture, object
allocation and serialization. Start with counts and resource metadata; add a
bounded detailed history and optional creation stacks for selected Realms or
operation kinds. Benchmark disabled and enabled overhead separately.

Do not capture user payloads, socket contents or RPC arguments by default.
Inspection authority narrows down the Realm tree just like import authority;
children cannot inspect siblings or parents without an explicit capability.
Remote collection uses the existing authenticated boundary with a separately
granted diagnostics capability and reports unsupported peers explicitly.

Bound event count, retained bytes, resource records and subscriber queues.
Report dropped sequences and truncation. A slow or throwing observer must not
block, throw into, or change application delivery. Diagnostic work is labelled
and excluded from application leak findings, avoids observing itself recursively,
and cannot keep a finished application alive. Detach releases all subscriptions,
timers and retained records. Identity fields can have high cardinality: keep
them in detailed records, not unbounded metric labels.

## Delivery order and proof

1. Define the schema and pure reducer with synthetic lifecycle tests, including
   replacement, cancellation races, duplicate delivery, event loss, partial
   snapshots, fd reuse, Realm restart and migration.
2. Instrument loop operations and readiness installation/routing; connect the
   test runner to the same analysis API. Use the kqueue batch regression as the
   first end-to-end demonstration of a useful diagnosis.
3. Add transport metadata and causal RPC links through existing observers,
   then cross-process and remote adapters with explicit completeness reporting.
4. Expose the reviewed public module and a bounded recording CLI. Add optional
   stacks and OpenTelemetry projections after measuring the base implementation.
5. Feed the same schema from simulation and run the same lifecycle assertions.
   Existing RPC cassettes do not reproduce arbitrary kernel or scheduler
   ordering; full deterministic runtime replay needs additional effect capture.

Prove observer isolation, bounded memory, disposal, capability narrowing,
collection failure and referenced-handle accounting in each supported Realm
mode. Repeat the full macOS/Linux suites with diagnostics disabled and enabled;
also benchmark allocation and latency under controlled release-build load.

Instrumentation inevitably changes timing. A recording is evidence of the run
that produced it, not proof that observation preserves a race's reproduction
rate. Keep external process/kernel snapshots available, compare enabled and
disabled runs, and use deterministic injected ordering to prove repairs when
possible. In particular, an extra diagnostic timer can wake a Realm whose
ordinary wake path is broken; do not count that run as an uninstrumented fix.
