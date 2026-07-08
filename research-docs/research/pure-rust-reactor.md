# Pure-Rust Isolate Reactor and Unified Native I/O

> Status: performance design, for iteration before implementation. Proposes moving
> only the hot path — the event-loop reactor and isolate pumping — into Rust, while
> keeping the stdlib, protocols, and app code in TypeScript. Supersedes the pump and
> facade-I/O mechanics of `realm-loop-orchestration.md` (§3, §4, §7); that document's
> orchestration, leases, and cross-node story still stand. Cross-node membership
> remains in `multi-tenant-runtime.md`.

## 0. Phase 0 results (measured 2026-07-07, macOS/kqueue, release)

Phase 0 is **implemented and proven correct**, with a **negative performance
result worth stating plainly**. What shipped:

- `internal:reactor-native` (`src/reactor/`) — a per-isolate native kqueue reactor
  that owns the resolvers for fd readiness, fused `readAsync`/`writeAsync`, timers,
  proc/vnode/signal, and wake sources; `tick()` polls AND resolves inline.
- `fino:net/loop-reactor` — a drop-in for `internal:runtime/loop` over that reactor.
- A realm opts in by remapping `internal:runtime/loop` → `fino:net/loop-reactor`
  via an `ImportMap` `remap` override (transitive; covers all sockets, TLS
  readiness, files, and timers in that realm). All other realms keep `loop.ts`.
- `FdReader.doPull`/`FdWriter.doFlush` (`js/internal/stream.ts`) feature-detect
  `loop.readAsync`/`writeAsync` and use the fused native path when present — the
  default `loop.ts` path is byte-for-byte unchanged.

**Correctness is solid**: a direct-drive test (timer, readable/writable echo, fused
readAsync/writeAsync echo) and an ImportMap-remap thread realm (timer + file read +
socket echo) both pass, and the remapped realm **self-exits** — the reactor's
`alive()` reports exact quiescence with no linger.

**Single-tenant performance: parity (after fixing a reactor inefficiency).**
Trivial-handler HTTP/1.1 (`Hello, World!`, 100 conns), same server in a **plain
thread realm** — which does *direct* I/O, **with no facade in either arm**:

| | req/s |
|---|---|
| baseline realm (`loop.ts`) | ~106–110k |
| reactor realm, first cut (per-I/O Promise+Global+8 KiB zero) | ~107k (marginally slower) |
| reactor realm, after fix (sync fast-path return) | ~106–107k (parity; runs overlap) |

The first cut was *slower*, which was suspicious and turned out to be a real
inefficiency: `readAsync`/`writeAsync` allocated a `PromiseResolver` + `Global<AB>`
on **every** call and `tick()` zeroed an 8 KiB event buffer per poll. Fixed: the
fused ops now return the byte count **synchronously** (a plain number, no
Promise/resolver/Global) when the syscall completes without blocking — the common
case — and only allocate a resolver + retain the buffer when the op actually
`EAGAIN`s. This mirrors `loop.ts`'s `#avail` gate but avoids even the readiness
Promise. Result: **genuine parity**, not slower.

But still not *faster*, and that is the finding: the single-tenant loop + I/O path is
**not the bottleneck**. `loop.ts` already batches one `kevent` per tick, gates
`readable()` on a byte-available count, and issues `read`/`write` through the FFI
**fast-call** path (`src/ffi/fast.rs` — no HandleScope, args in registers), which is
already ~native. A native reactor can match it but not beat it here. This **confirms
§8's honest limit with data**: the Node h1 gap (~110k → ~145k) lives in the **JS HTTP
framing/per-request path**, not the event loop.

**The facade tax, measured (2026-07-07).** A 3000× file-read loop (1 KB file),
direct in a plain realm vs. a scheduler tenant whose `fino:file` is the facade:

| | throughput | |
|---|---|---|
| direct (non-scheduler realm) | ~72,600 reads/s | baseline |
| facade (scheduler tenant) | ~23,000 reads/s | **3.2× slower, +30 µs/op** |

That ~30 µs/op is the per-op scheduler tax the reactor is meant to erase — the gap
to close back to the direct baseline. It is *all* facade round-trip (serialize args
→ cross-isolate → real read on the scheduler loop → `internal:serializer`-clone the
bytes back → re-pump). Note the facade currently covers **file I/O only**; there is no
socket facade — that is *unfinished work*, not a design choice. The always-intended
goal is complete separation of *all* asynchrony into the external scheduler layer,
driven outside the originating isolate, so the shard can switch isolates the moment
the current one has no ready microtasks.

**Closing the gap is Phase 2, and the current shard can't do it yet.** The blocker: the
shard re-pumps a parked tenant by watching the tenant's **async-runtime wake pipe**
(`shard.ts` `#armWatch`), which fires on FFI completions — *not* on loop/reactor
readiness. A tenant doing direct I/O today would park on its own loop and never be
re-pumped. Phase 2 makes the **shard own the reactor** (one per shard thread, shared
across its N tenant isolates, each registration tagged by owning isolate); tenants do
direct reads/writes; the shard polls the reactor, resolves the owning tenant's I/O, and
pumps exactly that tenant. Capability moves to `open()`/`connect()` + OS sandbox. That
is the build that turns the 3.2× tax back toward 1×.

**The facade win (lever C) is untested here — by construction.** The facade's per-I/O
serialization tax (§2.3: 4 structured-clone passes, 2 cross-isolate hops, 2
redispatches) only exists on the **multi-tenant scheduler shard** path, where a tenant
isolate proxies I/O through the scheduler. A plain thread realm never touches it, so
this benchmark cannot show it. Eliminating it requires **Phase 2** — tenants call the
reactor's `internal:io` directly, with capability enforced at `open()`/`connect()` +
OS sandbox instead of per-op — which is where the reactor's decisive win is expected.
The single-tenant result does **not** predict the multi-tenant one; they are different
cost structures. Next: measure the facade tax directly (scheduler tenant I/O vs
direct), then wire Phase 2 and re-measure.

## 1. Design target

Fino is a JS/TypeScript runtime on V8 built "thin Rust, everything in JS": Rust
provides V8 bindings, an FFI layer, and a module loader; all I/O, networking, and the
standard library are implemented in JS by calling libc via FFI. That philosophy is
excellent for surface area and iteration speed, but on a like-for-like HTTP benchmark
it costs throughput. On an 18-core machine, release build, 100 connections:

| | HTTP/1.1 | HTTP/2 (TLS) | HTTP/3 (QUIC) |
|---|---|---|---|
| fino "Hello World" | ~104k req/s | ~59k | ~53k |
| Node "Hello World" | ~145k | ~195k | — (no built-in h3) |
| fino app router (`/users/:id`→JSON) | ~69k | ~51k | ~43k |
| Fastify (schema router) | ~126k | — | — |

Node is 1.4× ahead on h1 and **3.3× ahead on h2**, and for Node h2 is *faster* than
h1 (multiplexing pays off) while for fino h2 is *slower* than h1 (the JS framing layer
outweighs multiplexing). The multi-tenant scheduler adds a further per-I/O tax on top.

The goal: **match Node for I/O-bound workloads despite a TS core**, by moving the two
things Node does in C (the event loop + async I/O, and — for us — the multi-isolate
scheduler) into Rust, and leaving protocols and app logic in JS. This is not a
"rewrite everything in Rust" plan; it is "find the smallest hot core that must be
native, make it native, delete the layers above it."

## 2. Where the time goes today

Grounded in an exploration of `scheduler_native.rs`, `async_rt/`, `runtime.rs`,
`realm/child.rs`, the facade (`js/internal/scheduler/*`), the loop
(`js/internal/runtime/*`), and the FFI layer (`src/ffi/*`). One theme below matters for
§4/§5: today asynchrony comes from *several* places — the JS loop (`loop.ts` timers +
fds), the per-isolate wake pipe + completions queue (`async_rt`), per-realm pending
resolutions, and port channels — and the pump *infers* quiescence structurally. Routing
all of them through one reactor makes quiescence exact.

**2.1 The isolate pump is already native.** `dispatch_parked → dispatch_entered_parked`
enters a tenant isolate, runs an activation, and calls `pump_and_checkpoint` — a
fixed-point loop of `executor.try_tick` → `drain_all` (FFI completions, JS-call
trampolines, pending resolutions) → per-context `MicrotaskQueue::perform_checkpoint`,
repeated until a round makes no progress. Microtasks use `MicrotasksPolicy::Explicit`
with a per-context queue, so the host owns every checkpoint. "Quiesced" is then read
structurally: `active_promise.state() == Pending` with nothing left to drain means
"parked on external I/O." No V8 pending-task API is consulted; the only queries are
`promise.state()`, `is_execution_terminating()`, `has_terminated()`. **This is exactly
the "pump until microtasks stop" primitive the redesign is built around — it already
exists in Rust.**

**2.2 The TS `ShardScheduler` is orchestration wrapped around that native pump,** and
it is not free per slice: a `JSON.stringify` request in and `JSON.parse` inside the
isolate; the outcome comes back as `serialize`d bytes → `Uint8Array` → `deserialize`;
plus `runnableFromHeld`/candidate-array churn in `#pickRunnable`, a fresh `Signal`
Promise on every park, a `timeout(0)` macrotask per batch, and `readable(wakeFd)`
Promise wrappers. Every slice crosses the JS/native boundary at least twice with a
double serialization.

**2.3 The facade tax, per tenant I/O.** A tenant `readFile` that is physically one
`open`/`read`/`close` on the scheduler pays, on top of that syscall: 1 Promise + 1 Map
insert + 1 Map delete; **4 structured-clone passes** — request args serialize +
deserialize, and result serialize + deserialize where the latter two *copy the whole
file body twice* (scheduler heap → serialized bytes → tenant heap); 2 native
cross-isolate hops (`dispatchWorkload` drain, `completeHostOperation` inject); and 2+
scheduler dispatch-loop re-marks plus a `timeout(0)` yield. Handle-based streaming
repeats the entire round trip *per 64 KiB chunk*.

**2.4 All I/O already reduces to one primitive.** `js/file/fs.ts`,
`js/internal/file/handle.ts`, and `js/net/socket.ts` all bottom out in the same shape:
register an fd on the loop (`loop.readable`/`writable`/`submit`), await readiness, then
issue a read/write syscall via libc FFI. On Linux the two steps fuse into one
`io_uring` op; on macOS it is "await `EVFILT_READ` + synchronous `read(2)`." The loop
(`loop.ts` + `kqueue.ts`/`io_uring.ts`) is a **per-isolate JS singleton** whose `kevent`
is batched to roughly one FFI call per tick.

**2.5 FFI is not the main villain.** `src/ffi/fast.rs` has a near-native fast-call path
(no HandleScope, no `Vec<Local>`, args in registers) for int/pointer/buffer signatures —
which covers `read`/`write`/`recv`/`send`. So raw syscall marshalling is cheap-ish. The
dominant costs are elsewhere: the **JS loop-dispatch layer** (tick → `_dispatch` →
resolve Promise → microtask, per readiness), the **Promise+microtask per I/O**, and —
for tenants — the **facade + per-slice serialize round-trips**. `async: true` FFI *is*
heavy (owned-arg copy, resolver global, `Cif` clone, thread-pool handoff, two mutex
locks, a pipe write+read, a re-pump) and is only worth it when the C call genuinely
blocks.

## 3. The unifying insight

The main-realm loop (`runtime.rs`), the child/thread-realm loop (`realm/child.rs`), the
JS `driveLoop` (`bootstrap.ts`) + `loop.ts`, the TS `ShardScheduler`, and the facade are
all variants of one thing:

> pump an isolate to quiescence, block on a shared event loop when idle, wake isolates
> on I/O readiness.

Collapse them into **one native reactor** that hosts `N` isolates per OS thread —
`N = 1` for a normal realm, `N = many` for a scheduler shard. The main-realm fast path
and the multi-tenant scheduler become the same code with a different `N`. Everything
above the reactor (`loop.ts`, `driveLoop`, `ShardScheduler`, the facade, the host-op
protocol) is deleted.

And the reactor's remit is not just I/O — it is **every host behavior that can produce
asynchrony**: timers, fd readiness/completion, async FFI/blocking-pool completions, FFI
callback trampolines, cross-realm/port messages, Rust-future→promise resolutions,
`Atomics.waitAsync` notifications, and file-watch/proc/signal events. If *all*
asynchrony originates in the reactor, the reactor is the single authority on which
isolates have pending async work and which have a completion ready to run — so
quiescence becomes an **exact** fact the reactor already holds, not something the pump
has to infer (see §4.1, §5).

## 4. Architecture

### 4.1 The reactor is the sole source of asynchrony
Make it an invariant: **nothing in JS creates asynchrony out-of-band; every async
completion originates in the reactor.** Concretely, all of these register with the
reactor, tagged by owning isolate, and their completion marks that isolate runnable:

- **Timers** — `setTimeout`/`setInterval` become reactor registrations (a native timer
  wheel / heap), not JS `loop.timeout` + `EVFILT_TIMER`.
- **fd readiness & completion** — `readable`/`writable` and io_uring completions (§4.2).
- **Async FFI / blocking-pool completions** — instead of the per-isolate self-pipe +
  `Mutex<Vec<FfiCompletion>>` (`async_rt`), a completed blocking job posts directly into
  the reactor's ready set for its isolate.
- **FFI callback trampolines, `Pointer.view` deleters** — same path.
- **Rust-future→promise resolutions** (`future_to_promise`) and **cross-realm/port
  messages** (`ThreadPort`/`MessagePort`) — reactor events, not a separate drain.
- **`Atomics.waitAsync`, file-watch (`EVFILT_VNODE`), proc-exit, signals.**

The payoff is **exact quiescence and precise rescheduling** (developed in §5): because
the reactor holds every registration and every completion, it knows, per isolate,
*whether async work is outstanding* and *whether any of it is ready to run* — with no
inference. This also **deletes a whole class of bug** we just spent effort fixing. The
recent scheduler spin/hang defects — a leaked JS heartbeat timer keeping `alive()` true;
the `nonBlocking` busy-spin; a wake-source fd re-firing on EOF — were all artifacts of
the *split* model: JS timers and a JS `alive()` handle-count living outside the native
pump. When the reactor owns all async, "alive" is "has registrations," a timer cannot
leak into a separate JS layer, and idle is structurally zero-CPU.

### 4.2 `internal:io` — the fd facet of that surface
The fd-shaped part of the reactor's surface, a synthetic module of **V8 callbacks (not
FFI-to-libc)** exposing:

- lifecycle: `open`, `socket`, `bind`, `listen`, `accept`, `connect`, `close`;
- transfer: `read`, `write`, `pread`, `pwrite`, `recv`, `send`, `recvfrom`, `sendto`;
- readiness: `readable(fd)` / `writable(fd)`, and a **fused** `readAsync(fd, buf)` /
  `writeAsync(fd, buf)` that performs readiness+syscall in Rust and resolves a single
  promise when the buffer is filled/drained;
- blocking-only ops (`getaddrinfo`, `stat`, directory metadata) offloaded to the
  existing blocking pool with wake-pipe completion.

This one module backs `fino:file`, `fino:net`, the QUIC UDP socket — everything —
replacing the scattered libc-FFI bindings (`js/file/bindings.ts`, `js/net/socket.ts`'s
symbol table) and the JS loop. Because it is a native V8 callback rather than a
dlopen'd libc symbol, it skips even the FFI fast-call envelope, and because readiness
lives in Rust it needs no JS `_dispatch` layer.

### 4.3 Per-thread native reactor
One Rust-owned `kqueue`/`io_uring` per thread plus a **priority run-queue of runnable
isolates**. The loop:

```
loop {
    while let Some(iso) = run_queue.pop_highest_priority() {
        pump_to_quiescence(iso);          // existing pump_and_checkpoint fixed point
        // parked (only loop registrations left) → drop from run queue;
        // still-runnable (ready microtasks/timers) → re-queue with fairness debt;
        // settled/terminated → finalize.
    }
    // nothing runnable: block until an fd fires or the next timer is due — zero CPU idle
    for ev in loop.wait(next_timer_timeout) {
        let iso = ev.owner_isolate;        // fds are tagged with their isolate at registration
        resolve_io(iso, ev);               // fill buffer / resolve the promise, natively
        run_queue.mark_runnable(iso);
    }
}
```

fds are tagged with their owning isolate on registration, so a single shared loop
multiplexes all isolates and routes each readiness event to the right one. Selection
(priority → fairness debt → age) and load accounting become native struct ops instead
of the current JS candidate-array churn. The blocking-when-idle behavior is the same
property we recently had to fix in the JS loop, but native and correct by construction.

### 4.4 No facade
Tenant isolates call `internal:io` directly (through `fino:file`/`fino:net`). There is
no host-op queue, no cross-isolate serialization, no scheduler-side proxy. What was a
4-serialize, 2-hop, 2-redispatch round trip per I/O becomes: the tenant issues a native
`readAsync` (a V8 callback), the reactor completes it and marks the isolate runnable.

### 4.5 One reactor type, every thread: main reactor + worker pool
There is exactly **one** reactor implementation, and every OS thread that hosts isolates
*is* one — there is no separate "engine" vs "reactor". The reactor is the per-thread
substrate (§4.3); the orchestrator is only the cold-path policy that decides which
reactor an isolate lives on.

- The **main thread runs a reactor** whose hosted isolates are the orchestrator and its
  service isolates. The orchestrator (cold-path TS) does not sit outside the model — it
  is an isolate on the main reactor like any other.
- It allocates workloads to a **pool of worker reactor threads**, each a reactor hosting
  tenant isolates, and migrates a workload between them when a thread is overloaded or a
  workload is sync-heavy.
- Dispatch (place / wake / revoke / drain) crosses threads over a control channel; from
  then on the *target* reactor owns that isolate's execution and all of its I/O.

So the whole node is a set of identical reactors, one per thread, differing only in which
isolates they host and whether one of those isolates happens to be the orchestrator.

## 5. Exact quiescence and rescheduling

Because the reactor is the sole source of asynchrony (§4.1), it can maintain, per
isolate, two exact numbers: **`outstanding`** (async registrations that have not yet
completed) and a **`ready`** set (completions delivered but not yet consumed by the
isolate). From those, an isolate's state is a fact, not an inference:

- **runnable** — `ready` is non-empty (a timer fired, an fd is ready, an FFI job
  finished, a message arrived), *or* the isolate still has queued microtasks/executor
  work from its last activation;
- **parked** — `ready` is empty but `outstanding > 0` (waiting, will be woken by a
  future completion);
- **done** — `ready` empty and `outstanding == 0` and no queued microtasks: the isolate
  has no possible future work, so its entry has completed and it can be finalized.

The loop is then: pump the highest-priority **runnable** isolate — drain its microtask
queue to a fixed point (the existing `pump_and_checkpoint`, which turns delivered
completions into resolved promises and runs the microtasks they queue) — then reclassify
it from the two numbers and pick the next. When any completion lands, the reactor moves
it into the owning isolate's `ready` set and marks the isolate runnable. When nothing is
runnable, the reactor blocks with a timeout equal to its own **next-timer deadline** —
so it wakes exactly when the earliest timer is due, and otherwise only on a real
completion. No structural probing of a single `active_promise`, no
`has_pending_background_tasks`, no JS `alive()` handle-count, no per-isolate wake pipe,
no spurious wakeups, no polling.

This is why the maintainer's framing — "we only care about when microtasks stop, to pick
the next isolate" — is not just correct but *cheaper* than today: the hard part
(detecting quiescence) is already solved by `pump_and_checkpoint`, and making the reactor
own all asynchrony turns the runnable/parked/done decision into arithmetic the reactor
already has. The redesign is mostly subtraction.

The pump itself is unchanged in spirit. It never preempts mid-microtask (V8 can't be,
short of `terminate_execution`). The hard budget stays a *backstop*: a watchdog
`terminate_execution` kills a single synchronous slice that overruns; sync-heavy
workloads migrate to batch threads (existing behavior). Long-lived async workloads parked
on I/O forever remain first-class and cost nothing.

## 6. Performance levers (ranked)

- **A. Native reactor replaces `loop.ts` + `driveLoop`.** Removes the JS
  tick → `_dispatch` → Promise-resolution layer and the per-tick `kevent` slow-callback
  envelope. Helps *all* I/O; this is the single-tenant Node-parity lever — fino's loop is
  JS where Node's is libuv/C.
- **B. Fused native I/O (`readAsync`).** One Rust op does readiness+syscall and resolves
  one promise, versus a JS `readable()` Promise + microtask + FFI `read`. Removes the
  intermediate Promise/microtask per streaming op and stays a tight V8 callback.
- **C. Facade elimination + Rust scheduler.** Removes the 4 serialize passes, 2
  full-payload copies, and 2 cross-isolate hops per tenant I/O, plus the per-slice
  `JSON`/`serialize` round-trip and object churn. Largest per-op win for I/O-heavy
  tenants.

Levers A and B raise the single-tenant ceiling (the HTTP benchmarks above); lever C is
what makes the multi-tenant scheduler's I/O approach direct-syscall speed.

## 7. Capability and isolation

**Do we still need to isolate I/O from app threads? No — not per operation.** The only
thing that must be centralized is the *reactor* (so the scheduler owns readiness and
can pick the next isolate); that is not a facade. Isolation is enforced in two cheaper
places:

- **At `open()`/`connect()`** — a per-isolate capability check (path/host allowlist,
  fd-class policy). This is once per fd, not once per byte, matching how OS security
  actually works.
- **At the OS boundary** — the process/thread sandbox (Landlock on Linux, Seatbelt on
  macOS) already built for the sandboxing work is the real containment.

Reads/writes on an already-open fd are unrestricted and fast. This is a deliberate
trade: it is right for the trusted / agent-density target, and weaker than the per-op
facade for genuinely hostile multi-tenancy — which we accept, backed by the OS sandbox.
The `internal:io` module remains an `internal:*` capability boundary (only importable by
other builtins), so app code still reaches it only through `fino:file`/`fino:net`.

## 8. Honest limits and risks

- **HTTP parsing/framing stays JS.** The h2 3.3× gap will not fully close without a
  native framing layer (nghttp2-equivalent) — explicitly out of scope here, a possible
  later lever. h1 should approach Node; I/O-bound real apps benefit most, trivial-handler
  microbenchmarks least. Be honest that the microbenchmark gap is partly protocol code we
  are *not* moving.
- **GC blocks the shard thread.** A garbage collection in one isolate stalls the thread
  and its co-located isolates. Inherent to sharing a thread; the sync-heavy→batch
  migration mitigates CPU hogging but not GC pauses. Density has this cost.
- **This is a rewrite of the runtime loop model** every realm uses. It must be built
  alongside the current path and cut over incrementally with the existing
  scheduler/orchestrator/realm suites staying green — not a big-bang replacement.
- **io_uring vs kqueue asymmetry.** Fused `readAsync` is a true `IORING_OP_READ` on
  Linux but "readiness + syscall" on macOS; the module must present one contract over
  both. The current `loop.submit` (io_uring) vs `loop.readable` (kqueue) split already
  proves this is tractable.
- **Backpressure / partial I/O semantics** must be re-expressed natively (short reads,
  `EAGAIN`, vectored writes) — today they live in `js/internal/stream.ts`'s `FdWriter`.

## 9. Native surface sketch

`internal:reactor` (or fold into `internal:io`): `spawnIsolate(entry, caps) → id`,
`wakeIsolate(id)`, `revokeIsolate(id)`, priority/affinity setters — the pieces the TS
orchestrator (allocator) drives from the cold path. The orchestrator, allocator, and
cross-thread/cross-node assignment **stay in TS** — they are not hot.

Async-substrate surface (the reactor, exposed to JS where needed): `internal:io` (the
fd facet from §4.2), a native timer API backing `setTimeout`/`setInterval`, and the
resolution paths for async FFI / ports / Rust-futures that today flow through the wake
pipe and per-realm drains. All of them are reactor registrations tagged by isolate;
async ops return promises the reactor resolves. Capability config is passed at isolate
spawn and checked at `open`/`connect`.

The reactor absorbs today's `pump_and_checkpoint` (already native), the JS `driveLoop`
step (`bootstrap.ts`), the JS `loop.ts` backend **including its timers**, the
`async_rt` wake pipe + completions queue, the per-realm pending-resolution drains, and
the TS `ShardScheduler` loop — becoming the single async substrate under every isolate.

## 10. Phased path

### Status: corrections landed via cherenkov (2026-07-09)

All three deviations below are resolved. The poller was extracted into the
standalone **cherenkov** crate (`~/Code/rust/cherenkov` — completion reactor
with kqueue/io_uring/IOCP backends, Notifier cross-thread posts, fs/signal
watch subsystem), and fino migrated onto it:

1. **One reactor type everywhere.** `src/reactor/engine.rs` and
   `src/reactor/mod.rs` both run on `cherenkov::Reactor`; the in-tree
   `poll.rs`/`io_uring.rs` are deleted.
2. **Cross-platform.** `internal:reactor-native` is `#[cfg(unix)]` — Linux
   gets the reactor loop through the same code path as macOS.
3. **Wake pipes eliminated.** Every cross-thread wake is a Notifier post: the
   isolate wake sink (`async_rt::WakeSink`) upgrades from its self-pipe to a
   post when a reactor claims it (remapped realms at bootstrap; engine tenants
   at placement, tagged by workload id); the engine's control pipe became a
   `POST_CONTROL` post and its report pipe a sequence counter + orchestrator
   wake surfaced as `nextReport(reactorId)`. Pipes remain only where they
   carry data (ThreadPort messaging) and as the default-loop realms' wake
   channel.

Benchmarks after the swap (2026-07-09, macOS): h1 trivial-handler at parity in
both the baseline realm (~98k req/s old vs new) and the reactor realm (~84k
both); h2 40.1k → 39.7k req/s; h3 44.0k → 43.3k req/s — parity within noise.

### Next: no standalone realms — every isolate-hosting thread IS a reactor

The remaining gap to §4.5, made explicit (2026-07-09): the current tree still
has two hosting models. Engine threads are the target model — a pure-Rust pump
loop (`engine.rs::loop_forever`) drives hosted isolates to quiescence, routes
completions by owner, and picks the next runnable tenant; tenant code never
drives anything. But the root realm and `Realm({thread:true})` realms are
still **JS-stepped**: bootstrap's `driveLoop` hands a step function to the
host loop (`runLoop` → `runtime.rs` calls it each iteration), the step calls
`loop.tick()`, checks `alive()`, steps embedded children, and decides
doneness — even when the loop underneath is the reactor. `spin()`/`run()` are
the fully-manual corner of that mode (test-only), and carry an inherent
silent-deadlock hazard (drain-inside-drain is a V8 re-entrancy no-op) that the
engine model cannot even express.

**Target restated:** there is no such thing as a standalone realm. The main
thread starts a reactor; the root realm (which hosts the orchestrator) is an
isolate deployed onto it; the orchestrator creates a pool of further reactor
threads and deploys workloads into them. One reactor-thread loop type
everywhere, differing only in which isolates it hosts.

**Design for the cutover (builds on what exists — mostly subtraction):**

1. **Two workload styles on one reactor-thread loop.** Generalize the engine's
   loop to host both the existing dispatch tenants (`pump_native` activation
   protocol) and *module realms*: evaluate an entry module as the first
   activation, then pump by the §5 arithmetic — runnable while completions or
   microtasks are pending, parked while `outstanding > 0`, done when both hit
   zero (plus fino-level liveness: atomics waiters, open ports). The engine's
   `OpRecord.owner` bookkeeping already provides the per-isolate `ready`/
   `outstanding` numbers; embedded children share the parent isolate and pump
   with it (per-context Globals + the existing child-context drains route
   correctly).
2. **Main-thread inversion.** `runtime.rs::run` stops calling a JS step fn and
   becomes the main reactor loop hosting the root isolate: wait → dispatch →
   `pump_and_checkpoint` → reclassify → block until the next timer deadline.
   `alive()` moves fully native (the reactor's own handle counters +
   `hasPendingV8Tasks` + a native atomics-waiter counter replacing the JS one).
   The idle-exit / onDone protocol moves into the loop.
3. **Thread realms become deployments.** `Realm({thread:true})` spawns (or is
   placed onto) a reactor thread running the same loop, hosting one module
   realm. `realm/thread.rs`'s bespoke host loop is deleted; ThreadPort keeps
   its data pipes, wakes become Notifier posts.
4. **Bootstrap stops driving.** When the realm's loop is native-driven, the
   bootstrap never registers a step function — `driveLoop`, `runLoop`,
   `tick`, `alive`, `registerWakeSource`, `spin`, and `run` disappear from the
   reactor loop's surface (the loop contract keeps only the I/O/timer/watch
   registration API that stream/file/watch/process consume). The
   `scheduleSync` shim (which exists to hoist test bodies out of the microtask
   checkpoint so `spin` could work) loses its reason to exist.
5. **Retirement (Phase 3 proper).** `loop.ts` + the kqueue/io_uring/linux/poll
   JS backends, the raw-ring `submit()` contract, and the wake-source pipe
   path all become dead once the default flips. During transition the legacy
   JS-stepped path stays behind the existing loop module seam: a realm whose
   loop is `loop.ts` keeps registering its step fn; a native-driven realm
   simply never does.

**Order (prove-in-isolation, then flip):** (a) native-drive thread realms that
are already reactor-remapped — delete their JS stepping; (b) boot the root
realm on the main reactor behind a flag, run the full suite, flip the default;
(c) converge `Realm({thread:true})` and the orchestrator pool onto one
reactor-thread spawn; (d) retire the legacy loop stack.

### Original status and correction (2026-07-07)

Phase 0 shipped (`src/reactor/mod.rs`, kqueue, JS-driven). A first cut of Phase 2 shipped
as `src/reactor/engine.rs` — a native per-thread multi-isolate scheduler with direct
tenant I/O, the facade retired, and a full HTTP h1/h2/h3 server served *as a reactor
tenant* (h2 ~4.7× faster than the main realm; h1/h3 at parity). But it **deviated from
§4.3/§4.5** in three ways that must be corrected before it is *the* reactor:

1. **Two pollers.** `engine.rs` grew its own `kqueue` (`ReactorThread`) instead of being
   the one reactor; `reactor/mod.rs` still holds a second, near-identical one. There must
   be ONE poller per thread (§4.3), backend-abstracted over kqueue and io_uring, that both
   the main-thread reactor and the worker reactors *are*.
2. **kqueue-only — no io_uring.** The engine's `mod imp` is `#[cfg(macos)]` with a
   non-functional non-macOS stub, so the reactor is **useless on Linux** — the server
   target. io_uring is a **required, co-equal backend from the start** (§4.3 always read
   `kqueue`/`io_uring`), not deferred. Verified on Linux via the Apple `container` image
   (root `Dockerfile`), matching `js/internal/runtime/io_uring.ts`'s raw-syscall approach
   (no liburing).
3. **Per-isolate wake pipes retained.** The engine still watches a self-pipe per isolate
   for background completions; §5 eliminates these — the reactor is the sole completion
   source and marks isolates runnable directly.

**Corrected build:** extract one backend-abstracted `Poller` (`submit_read`/`submit_write`
fused, `poll_readiness`, `add_timer`/`cancel_timer`; `wait(timeout) → [(user_data,
result)]`) with kqueue and io_uring backends that hide the readiness-vs-completion
difference; make the reactor own the Poller + the isolate run-queue + the pump loop and
route `internal:io` dispatch to it; delete the second poller and the per-isolate wake
pipes. Then the main thread runs a reactor hosting the orchestrator, and the worker pool
are reactors of the same type (§4.5).

### Original phase outline

Each phase is independently valuable and de-risks the big cut.

- **Phase 0 — `internal:io` + reactor skeleton, one consumer.** Build the native fd
  module and a Rust reactor; rewrite the HTTP server socket path (and `fino:file`) onto
  it in the *main* realm only. Prove the single-tenant win against the Node baseline.
  Does not touch the scheduler.
- **Phase 1 — native reactor drives the main/child realm loop.** Replace `loop.ts` +
  `driveLoop` with the reactor at `N = 1`. Single-tenant Node-parity on the loop.
- **Phase 2 — multi-isolate native scheduler.** Generalize the reactor to `N` isolates
  per shard; isolates use `internal:io` directly; retire the facade, the TS
  `ShardScheduler`, and the host-op serialize protocol. The orchestrator/allocator stay
  TS.
- **Phase 3 — retire the old libc-FFI I/O bindings, `loop.ts`, facade, and TS
  scheduler.**

## 11. Verification

- Re-run the autocannon / h2load / h3load harness (`scripts/profile-http-load.sh`, plus
  the plaintext autocannon path) after each phase against the baselines in §1. Targets:
  h1 within ~1.2× of Node after Phases 0–1; scheduler tenant I/O within ~2× of direct
  after Phase 2.
- Correctness: the existing scheduler/orchestrator/realm suites stay green through the
  cutover; add reactor and `internal:io` unit tests plus a multi-isolate reactor stress
  test (many isolates, mixed parked/runnable, fairness under load).
- Profile each phase with `fino:profiler` + the native `pprofessor` hook to confirm the
  removed layers actually leave the hot path (no residual JS `_dispatch`/serialize
  frames).

## 12. Open questions for iteration

- Does the reactor own isolate *creation* (subsuming `setup_workload`) or just pumping?
  Owning creation lets it drop the `__finoSchedulerDispatch` JSON contract entirely.
- Fused `readAsync` vs `readable`+`read`: keep both (fused for hot streaming, split for
  odd cases like EOF-on-`EVFILT_READ`), or force fused everywhere?
- Timers live in the reactor (decided); the open part is *representation* — a hashed
  timer wheel vs a binary heap vs one `EVFILT_TIMER`/`io_uring` timeout per timer. Node
  uses a heap in libuv; measure before choosing. `setInterval` re-arms inside the reactor
  rather than as a self-rescheduling JS timer (which is exactly the shape that leaked
  before).
- Where to draw the "all asynchrony" line precisely: `queueMicrotask` and promise
  reactions are intra-isolate and stay V8 microtasks (not reactor events) — the invariant
  is about *cross-boundary* completions (anything that would otherwise resolve a promise
  from outside the current microtask drain). Stating this boundary crisply is what keeps
  the exactness argument in §5 airtight.
- How much of `js/internal/stream.ts` backpressure logic moves into the native write
  path vs stays JS over `writeAsync`.
- Whether the main realm and shards literally share one reactor type or two thin
  variants; the ambition is one.
