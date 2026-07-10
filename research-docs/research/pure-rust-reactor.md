# Native Reactor Architecture

> Status: implemented on the reactor-orchestration branch. This note describes
> the current node-local execution substrate. Cluster placement and routing are
> specified in `multi-node-distribution.md`.

## Ownership model

Every reactor thread owns one Cherenkov completion reactor, its hosted realm
isolates, their owner-tagged I/O and timers, and the runnable queue. TypeScript
orchestration chooses a reactor and sends coarse place, move, revoke, and
shutdown controls; it is not in the pump hot path.

`internal:runtime/loop` is unconditionally backed by
`fino:net/loop-reactor`. There is no legacy-loop feature flag or per-realm
opt-in. The root reactor stores V8 resolver globals directly. Tenant reactor
engines retain isolate-owned resolver identifiers and backing stores because
their completions may arrive while another isolate is active.

## Sticky active isolate

A tenant reactor keeps at most one isolate entered. It computes the next
priority winner before changing V8 ownership:

1. If the active isolate is still the winner, the reactor creates fresh
   pump-local handle/context scopes and runs another slice without exiting,
   unlocking, swapping async state, or re-entering.
2. If another isolate wins, the reactor drops every pump-local scope, saves the
   active isolate's async state, exits it, and releases its locker before
   activating the winner.
3. If nothing is runnable, the reactor may retain its active isolate while it
   waits for completions. Exclusive ownership remains with that reactor.

Priority and accumulated CPU debt are recalculated after every slice. Sticky
ownership is therefore not scheduling affinity: another runnable isolate still
wins as soon as the scheduler ordering places it first.

## Live movement

Same-node movement transfers the live isolate rather than reconstructing it.
The source first deactivates it, detaches transferable operations, installs
forwarding for operations that must drain on the source, and sends exclusive
ownership through the single audited native transfer channel. The destination
installs its notifier and operation ownership before entering under V8's
cross-thread locker contract.

Module state, promises, the realm transit port, and isolate-owned async tables
survive the move. Submitted pointer-backed operations keep their backing stores
alive and forward only plain completion results if they finish on the source.
Workloads using unaudited thread-affine native state must remain pinned.

## Lifetime and liveness

Pump-local V8 scopes never survive a slice. Async runtime state remains
installed while an isolate is active and is swapped only on an actual isolate
switch. Referenced timers and resources keep the realm alive; unreferenced work
may continue to run but does not prevent quiescence or replica draining.

Reactor shutdown first deactivates the active isolate, cancels and harvests
owned operations, and only then disposes hosted isolates. A moved isolate takes
one final external V8 lock and runs the normal `OwnedIsolate` cleanup while that
lock remains held. The locker is neutralized before disposal and only its
allocation is freed afterward, because its C++ destructor would dereference the
already-freed isolate.

## Deliberate boundaries

- Node-local scheduling does not know about remote nodes.
- Cluster placement chooses a node; `SchedulerNode` admits it to a local
  reactor.
- Scaling policy and placement decisions are pure contracts today. Replica
  construction, distributed directory publication, and DNS cutover belong to
  the future cluster reconciler.
- Root and tenant reactors share Cherenkov, but retain separate operation
  representations because their V8 ownership and completion lifetimes differ.
