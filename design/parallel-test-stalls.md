# Parallel test stalls: findings

Investigation of intermittent test execution and Realm teardown stalls on macOS
and Linux. The chronological sections retain failed hypotheses and their
measurements; later findings supersede earlier status statements.

## Current worktree state

The `t3code/diagnose-test-hangs` branch includes committed work from
`t3code/test-timeouts` at `159f522a`, plus the follow-up repairs described here.
The starting worktree's unfinished `noteWatchReplaced` edits were not copied or
modified. The branch preserves the original investigation commits.

| Boundary | Repair | Regression evidence |
| --- | --- | --- |
| kqueue registration | Consume per-change receipts so an absent cancellation cannot discard later registrations | The old code delivered only one of 64 timers; repaired code delivers all 64 |
| Process Realm native bridge | Shutdown the socket while retaining its descriptor until both bridge threads finish | Retained endpoint changes from EAGAIN to EOF; descriptor remains owned |
| Forced scheduled Realm termination | Signal the owning reactor after publishing the force request; honor the persistent flag on re-entry | A closed parent port no longer strands the idle child until an unrelated timer |
| Automatic Realm shutdown | Allow a returned one-shot call to complete its asynchronous shutdown hooks | Existing CLI cleanup marker regression passes |
| io_uring shared queue | Use atomic acquire/release-compatible ownership-counter accesses | Protocol audit plus 2,048 completion identities across wrapping slots; not a deterministic reordering reproduction |
| Native async wake lifetime | Retain the existing wake pipe with completion, callback and finalizer producers | Late notifications remain on the original pipe after Realm shutdown; none reach a successor |
| HTTP/3 port zero | Retry bounded TCP/UDP port selection only on UDP address conflict | Forced collision, explicit port, cancellation and cleanup cases |
| QUIC transport lifetime | Reject readiness registration and avoid native I/O after close; recheck closure after packet callbacks | Closed-transport regression fails before the repair; unexpected QUIC watch replacements disappear from focused Linux tracing |
| QUIC simulator assertion | Await peer receipt of the reordered close notification | Deterministic reordered delivery reproduces the old test race |

The final frozen-binary sequences, `macos-quic-final` and `linux-quic-final`,
each completed ten consecutive full parallel runs with zero hangs or failures.
Every run exited 0 with a root plan of 963, 959 passes and four root skips.
Full serial suites also pass on both targets with matching root plans and
summary counts (macOS 392.15 seconds, Linux 386.74 seconds). Source/test changes match between
worktrees, and temporary application tracing was removed before these sequences.
macOS runs took 206.62–233.20 seconds; Linux runs took 206.54–241.12 seconds.
Earlier failed sequences are retained below as investigation evidence, not counted
toward this result.

Focused readiness, FFI, stream and Realm validation passes on both platforms
(21 root groups), as do all 56 Rust unit tests. The repaired QUIC and simulator
files pass all nine root groups on both targets. TypeScript formatting/lint and
Rust formatting pass. macOS Clippy passes with 37 pre-existing warnings; Linux
Clippy is unavailable in the installed toolchain. Generated PTY documentation
includes the new timeout metadata.

The proposed end-user analysis module is described in
[`runtime-diagnostics.md`](runtime-diagnostics.md); it has not been implemented.

## The original symptom

CI's Linux `Tests` job hangs. The TAP log ends after the last test group,
nothing further is written, and the job is eventually cancelled at its own
timeout leaving an orphaned `fino` process behind. Every test had passed.

The shape matters: the run got all the way through execution and then stopped
during teardown, with no output naming what it was waiting for.

## What was wrong with the test runner

The runner had no deadline anywhere, so any worker Realm that stopped
responding took the whole run with it and nothing said which one. Five waits
could each hang a run on their own:

- posting a group to a worker and awaiting the reply;
- waiting for worker Realms to exit during teardown;
- `execute()` on a file that failed to load, which re-derived its error text by
  awaiting the Realm's *exit*. A Realm that failed to load but has not exited
  leaves that pending forever while holding an admission slot, and an exclusive
  group queued behind it then blocks every remaining task. This produced the
  `active=2, exclusiveWaiters=1, readyWaiters=25` deadlock seen in early runs;
- `prepareParallelFile` awaiting registration, which stops the file loop
  outright for a Realm that neither registers, fails, nor exits;
- serial-mode module imports.

Three further defects were found while fixing those:

**A deadline resting on one timer.** A stalled run was found holding exactly one
timer -- the watchdog's -- while a group sat in `awaiting-reply-90000ms`. Its
deadline timer had left the loop without ever firing. Deadlines are now enforced
a second time by the watchdog sweep, which is the one timer a stalled run proves
still fires.

**A stranded Realm cost the deadline once per group.** Groups within a file are
chained, so a Realm that stopped responding burned the full worker deadline for
every remaining group. Twelve groups is eighteen minutes, which is most of why a
degraded run took 931s against a 138s baseline. One missed reply now condemns
the whole file.

**The leak check never ran on a failing run.** `run()` throws when tests fail,
so the check after it was dead code in exactly the case that matters.
`fino test --timeout 250` against a test awaiting a 600s timer reported the
timeout in 258ms and then hung forever.

### Delivered

- Per-test deadlines. `--timeout` sets the run default (60s; `0` waits
  forever), and a test can raise its own with `{ timeout: 300_000 }`.
- All five waits bounded, each naming what it gave up on.
- A stall diagnosis: pending files, in-flight groups and the stage each is stuck
  in, admission channel state, loop handle counts, reactor pool state.
- Start retransmits past a quarter of the deadline. The worker dedupes group
  starts by index, so this is a no-op for a merely slow group.
- Failure reasons printed inline, not only in the end-of-run details that a
  bail-out never reaches.
- Abortable DNS. `lookup()` and `Resolver.resolve()` take an `AbortSignal`;
  `EventSource.close()` and the WebSocket teardown use it. An abandoned query
  previously held a UDP socket and retry timer for its whole schedule -- about
  30s per nameserver -- which is event-loop liveness that stops a Realm exiting.
- Docs corrected: `js/testing-and-benchmarking.md` had listed per-test timeouts
  among the `node:test` features fino deliberately omits.
- Three CLI regression tests covering the deadline contract.

**Result: runs no longer stall.** A run that previously hung now finishes and
names what failed.

## The remaining defect

Worker Realms intermittently stop making progress. The run still completes,
because every wait is now bounded, but the affected groups fail.

### Eliminated, with the measurement

| Hypothesis | Measurement | Verdict |
|---|---|---|
| CPU starvation | Sampled during a strand: all 18 reactor threads parked in `PoolShared::claim` → `Condvar::wait`, process at 0.3% CPU | No |
| Realm pressure | `FINO_TEST_CONCURRENCY=2` (34 live Realms vs 170) stranded identically -- 36 stranded groups | No |
| Lost message delivery | Retransmits are safe (worker dedupes by index). 4 of 7 retransmitted groups stayed stranded; only the 3 legitimately-slow ones completed | No |
| Lost receiver wake | A 250ms re-check in the receiver's watch loop did not rescue anything. The coordinator's own 57 pending timers never fired either | No |
| Ordering lost-wakeup | Both drains clear the wake pipe *before* taking the queue (`scheduler_native.rs`, `realm/thread.rs`), each with a comment explaining the hazard | No |
| Throwing listener killing the watch loop | `dispatchEvent` swallows listener exceptions (`globals/eventtarget.ts`) | No |
| `route()` failing to signal | Hard-codes `true` for the signal flag on every routed completion | No |
| Owner missing from `owner_pools` | `submit()` registers it; only `retire_owner` removes it, and both call sites are teardown paths | No |
| Stalled readiness controller | `controllerRouted` climbed 6512 → 7093 *during* a strand; registration count held at ~124 | No |
| Discarded wake signals | `signalsDropped` counter reads 0 through a strand | No |

The last two are the important ones. Wakes reach the pool and are delivered,
not lost and not discarded, so Realms *are* being marked runnable. That
collapses the scheduling-strand theory the earlier evidence pointed at.

### Representative pool state during a strand

```
{"parked":133,"residents":16,"ready":0,"waitingWorkers":16,"workers":17,
 "controllerRegistrations":124,"controllerRouted":17718,"signalsDropped":0,
 "mailboxChanges":0,"mailboxOwnersWithEvents":0,"mailboxEvents":0}
```

Caveats on reading this, both learned the hard way:

- `parkedWithNothingQueued` is **not** diagnostic on its own. A Realm waiting
  for its next message is legitimately parked with nothing queued.
- `mailboxChanges: 0` does **not** prove the controller is healthy. Parked
  Realms issue no new registration requests, so an empty mailbox is equally
  consistent with a controller that has stopped.
- Multiple identical dumps in one run are usually a single instant repeated:
  when the coordinator wakes, every expired deadline reports at once.

### Open question

Whether the start message reaches the worker's JavaScript at all.
`framesSent` (frames handed to a scheduled Realm's queue) and `framesDrained`
(frames its loop takes off) are instrumented for this. A growing gap means the
send never arrived despite the Realm running; counters that track each other
mean the message landed and the worker is stuck after receiving it, which moves
the search into group execution.

## Found along the way, not the cause

`wake_worker` left a notified worker in the `waiting` deque until it
re-acquired the queue lock. Both `wake_target` and `wake_any` pick
`waiting.front()`, so a burst of signals all targeted the same worker: N Realms
become runnable, one worker wakes, claims one, and the rest sit in the ready
heap with every other worker asleep.

This is a real defect and the fix is in, but it demonstrably did not fix the
strand -- runs stranded identically afterwards. It should not be credited as
the cause.

## Also open

- **`tests/tty.test.ts` child-process hang.** `readLine()` does a blocking
  `read(0, …)` via FFI, so the child hangs iff it never sees EOF on stdin. Ruled
  out: per-Realm `chdir`, and fd inheritance (`Process` passes
  `closeOnExecDefault`, and `POSIX_SPAWN_CLOEXEC_DEFAULT` is applied on darwin).
  Not root-caused.
- **Abandoned Realms leak coordinator-side reads.** Correlates perfectly across
  four runs: `strands=0 → leak=0`, `strands>0 → leak=1`, at roughly two leaked
  reads per abandoned file. `Realm.terminate()`'s `scheduled` branch is the only
  one of five that never calls `port.close()`. Not reproduced in isolation, so
  not patched on a correlation.
- **`create_pipe()` sets `O_NONBLOCK` but not `FD_CLOEXEC`** (`src/fdutil.rs`).
  Masked on macOS by `POSIX_SPAWN_CLOEXEC_DEFAULT`; on Linux every runtime wake
  pipe and Realm transport descriptor leaks into every spawned child. Not the
  cause of the strand, but a real fd leak on the platform CI runs on.
- **Diagnostic surface added for this investigation.** `reactorPoolStats()` and
  `setReadinessHeartbeat()` are roughly 40 lines of Rust exposing state that has
  no TypeScript-visible representation (the parked set, the ready heap, mailbox
  depth, the counters above). They are read-only and mutate nothing, but they
  cut against the repository's thin-Rust rule and should be reviewed for removal
  once the defect is closed.

## Methodology notes

Two mistakes worth not repeating:

- The soak harness originally did not grep for `Bail out!`, so stalls were
  classified as ordinary failures. Several early conclusions drawn from that
  data were wrong and had to be revisited.
- Running `cargo build` while a soak was in flight loaded the machine enough to
  produce a 105-failure run that looked like a regression and was not. Soak on a
  quiet machine or the numbers mean nothing.

Clean-run baseline is 146-153s. A degraded run is 200-500s. Duration alone is a
reliable first signal.

## Follow-up: confirmed kqueue batch loss (2026-09-07)

Continued on `t3code/diagnose-test-hangs` from the committed state above. The
two unfinished `noteWatchReplaced` edits remain untouched in the source
`t3code/test-timeouts` worktree.

`js/internal/runtime/kqueue.ts` flushed a full 64-change registration buffer
using `kevent(..., eventlist = NULL, nevents = 0)`. A cancellation of a watch
that was already absent returned ENOENT. The wrapper ignored this expected
cleanup error and reset the whole buffer, but the kernel had stopped processing
the batch at the failed change. Later read watches and timers were never
installed. Their JavaScript resolvers remained pending indefinitely.

The bounded regression in `tests/runtime/readiness-batch.test.ts` queues an
absent timer cancellation followed by 64 timers. Before the fix, **only one of
64 timers fired**: the timer in the next batch. After the fix, all 64 fire.
This reproduces loss at registration, before any completion can be routed or
consumed. Aggregate controller activity and zero dropped scheduler signals do
not rule this out: other registrations continue to work normally.

Registration-only flushes now use `EV_RECEIPT` and provide one result slot per
change. Each cancellation error has room to be reported, so later changes are
processed. Receipts also leave already-ready one-shot events queued for the
normal dispatch path; a second regression protects that contract. The fix stays
entirely in the existing TypeScript backend and adds no native scheduling policy.

Initial full parallel runs passed on macOS (154 seconds) and Linux (151 seconds):
962 root groups, 958 passed, four skipped, exit 0 on each. These are initial
checks, not the requested ten-run proof. Final serial and repeated parallel
validation is in progress. Logs and the independent 600-second process watchdog
are under `target/hang-diagnostics/`. The harness checks exit status, root TAP
plan and summary agreement, declared skips, failures, and bail-outs; it stops
at the first unsuccessful run. Its initial strict pass-count comparison omitted
declared skips and incorrectly classified both successful initial runs; that
bookkeeping error is corrected for subsequent runs.

### Additional reproduction and validation

Both full serial suites passed with the same 962 root groups (958 passed, four
skipped) as parallel mode: macOS 348 seconds, Linux 349 seconds. A later macOS
parallel sequence passed three runs and then exposed a QUIC simulator assertion
race. The STOP_SENDING test awaited ngtcp2's local read-shutdown callback, which
is not evidence that the peer received the frame. Adding a deterministic 10 ms
simulated packet delay reproduced the old assertion failure. The test now pumps
until the peer stream closes, checks that the connection remains open, and then
asserts that the peer writer rejects. Focused checks pass on both platforms and
the complete macOS QUIC simulator suite passes.

Linux has separately timed out in the OTEL CLI disabled-bootstrap test and the
FdReader pipe-read test, and failed the strict-sandbox process-tree cleanup time
bound. These are unresolved; passing reruns are not a diagnosis. Eight hundred
focused CLI subprocess launches and 100 separate focused pipe-test launches
passed. Temporary stage tracing is saved in
`target/hang-diagnostics/linux-stage-tracing.patch` and is removed from the
working test files. External `/proc` snapshots and per-stage file logs avoid
relying on a stalled Realm answering a query. Raw stderr writes are insufficient:
the parallel runner redirects the process descriptors and discards that captured
raw output when completing its capture session.

The first file-traced Linux full run passed in 152 seconds. The next was
interrupted by a restart of the shared Apple Container Machine, with output
through root group 904 but no root summary. Its process runner exited 137 and
VM uptime reset; this run is neither a test pass nor an observed runtime hang.
The restart cleared `/tmp/fino-ci-linux-target` and its protocol dependencies.
Rebuilding into `/var/tmp` avoids losing these artifacts on a normal reboot.
A fresh clean macOS ten-run sequence is in progress. No final ten-run claim has
been made for either platform.

The follow-up end-user analysis proposal is in `runtime-diagnostics.md`; it is a
design document, not an implemented public module.

### Confirmed shared TCP/UDP ephemeral-port collision

The next clean macOS sequence passed once, then failed cluster restart with
`bind() failed: address already in use (port 53553)`. This was not a shutdown
hang: HTTP bound TCP port zero, then HTTP/3 attempted UDP on the selected TCP
port. The two protocols have independent port namespaces.

`tests/net/serve-shared-port.test.ts` forces the collision by reserving UDP at
the first TCP candidate before QUIC binds. It fails on the prior implementation
and passes after the HTTP listener retries ephemeral selection, bounded to 16
candidates. Explicit ports still fail without reselection. Closing while startup
is pending prevents retry, and exhaustion releases every TCP candidate. Native
bind errors now retain their positive `errno` so the retry classifies EADDRINUSE
without parsing error messages. The accepting loop starts after requested
listeners are ready; HTTP/3 callers using port zero must await `ready` before
publishing the final shared port. Focused networking checks passed all ten root
groups. This adds one full-suite root group, for an expected plan of 963.

A standalone Linux syscall probe of logical io_uring write-poll cancellation did
not reproduce the suspected pipe-EOF retention: after draining the pipe, read
returned zero even before explicit kernel cancellation. No cancellation change
was made on that hypothesis. The pipe watchdog now also records FIONREAD,
POLLIN/POLLHUP, and all visible process fd holders of the pipe inode, without
consuming its contents. This should distinguish an unconsumed ready event from
an endpoint still held open when the pipe stall reproduces.

### Restored Linux environment and isolated diagnostics

A detached debugging checkout at `target/hang-diagnostics/linux-worktree`
contains the same runtime and test repairs. It permits Linux-only temporary
tracing without altering the macOS soak. Matching `git diff -- js src` hashes
were checked. The rebuilt Linux binary is
`/var/tmp/fino-hangs-target/debug/fino`; its V8 archive and protocol dependencies
are cached under `/var/tmp/fino-hangs-v8` and
`/var/tmp/fino-hangs-protocol-deps`. Its matching custom V8 archive was reused
from the separate completed PR121 build after comparing V8 version, Cargo
configuration and compiler/Ninja wrappers.

Sixteen focused Linux groups passed, then four instrumented full runs passed
with plan 963, 959 passes and four declared skips. The fourth process exited
zero, verified from `/proc/PID/stat` while its harness was stopped to prevent
starting another diagnostic iteration. Its root TAP summary is complete. The
three temporary tracing files have now been restored, and a fresh uninstrumented
Linux sequence is running. The current Rust/JS/test diff matches the macOS
checkout. Native backtrace tooling (gdb) is installed for a reproduced stall;
read-only external idle snapshots do not inject application timers or consume
pipe data. Earlier Linux timeouts are still unexplained.

### Confirmed process-Realm bridge descriptor lifetime race

The second uninstrumented Linux run reproduced a stall after all 963 groups
reported success. It eventually failed the 120-second file-Realm shutdown
limit for `tests/config.test.ts`, then exited with two remaining reads. A native
backtrace captured all eight reactor workers parked and a process-Realm reader
thread blocked in `poll()` through `read_exact(fd=178)`. Descriptor 178 was
already absent from `/proc/PID/fd`. Attaching/detaching gdb interrupted that poll;
the bridge then exited and reaped its child, but the configuration Realm still
failed shutdown. Artifacts are `linux-clean-02-main-live.json`,
`linux-clean-02-stack.log`, and `linux-clean-02.log`.

`ProcessRealmHandle::drop` closed the transport fd while reader/writer threads
retained only its integer value. A kernel poll may retain the old open socket
without waking when another thread closes the descriptor; a subsequent bridge
read/write can also target an unrelated descriptor after reuse. In particular,
a stray reader can consume another Realm's wake bytes before the owning loop
observes them. This bypasses owner-tagged completion routing entirely. The
captured closed-fd poll demonstrates the unsafe lifetime; it does not identify
which particular bytes the stranded configuration Realm lost.

The deterministic native regression retains an endpoint reference, drops the
handle, then checks that the endpoint reports shutdown. Before the change it
returned EAGAIN and would continue waiting. The handle now shuts down the
transport, and both bridge threads retain the same `Arc<OwnedFd>` until they
finish. The fd cannot be recycled beneath either thread. A second regression
checks that a retained bridge descriptor remains valid, observes EOF, and cannot
be allocated to another socket after handle shutdown. This is mechanical
ownership of the existing native bridge; no scheduling or I/O policy moved from
TypeScript into Rust. All 55 Rust unit tests passed on both platforms. Full
validation is restarting after this shared native repair.

### Forced termination must wake an idle owner

With bridge descriptor ownership fixed, macOS completed four full runs, then
run five again timed out shutting down `tests/config.test.ts`. The native sample
showed every reactor worker parked and no process-bridge reader. Linux completed
seven clean runs, then reproduced the separate FdReader EAGAIN timeout on run
eight. These results rule out treating bridge lifetime as the complete diagnosis.
Artifacts use the `macos-bridge-final` and `linux-bridge-final` prefixes.

The configuration test creates a nested Realm, awaits its call result, and then
finishes its file. `Realm.call()` closes the parent port. Its shutdown hook may
then force-terminate the nested Realm and await completion, but forced termination
only interrupted V8: it did not schedule an idle owner. The closed port discards
the cooperative termination frame, leaving no event to wake that owner.

The force-termination fixture now waits for an idle child, closes its parent
port, forces termination and requires prompt completion before an unrelated
10-second child timer fires. It deterministically failed before the repair.
`ScheduledRealmState::force` now publishes the interrupt and signals its existing
owner in the process pool. `drive_slice` also honors the persistent force flag
before entering JavaScript, even if a V8 TryCatch previously consumed the
interrupt. The fixture passes on both platforms; all 55 Rust tests and the
focused macOS Realm/configuration groups pass. Fresh macOS validation is running;
Linux is collecting file-backed pipe-stage evidence for its remaining timeout.

The external Linux idle watcher was corrected to discover children from process
parent IDs: this VM kernel does not expose `/proc/PID/task/PID/children`.

The first full runs after that repair exposed an automatic-shutdown policy bug
on both platforms: the existing CLI regression's child returned a call result,
then its asynchronous shutdown hook was interrupted before writing its marker.
`Realm` now records receipt of a one-shot call result/error and awaits that
child's normal completion instead of forcing it again. Uncalled abandoned
children and watch-mode termination retain their previous forced-stop policy.
The explicit closed-port force regression still passes, and the CLI cleanup,
configuration and reactor groups pass together on both platforms (four root
groups each). The current full-run prefixes are `macos-shutdown-final` and
`linux-shutdown-diagnostic`; Linux's stream test still has temporary stage
tracing, which must be removed before its final clean ten-run claim.

External Linux queue capture is now available in
`target/hang-diagnostics/linux-ring-watch.py`. The VM has no tracefs/kernel
tracepoints, so the helper reads the process's mapped SQ/CQ/SQE regions without
advancing queues or consuming pipe bytes. It keeps a bounded set of early and
latest snapshots once a recorded pipe stage stops advancing. Kernel layout was
queried from a separate ring: SQ head 0, tail 64, array 8512; CQ head 128, tail
192, CQEs 320, with 256 SQ and 512 CQ entries. This is diagnostic evidence of a
non-atomic observation, not a synchronized snapshot of all queue state.

The recorder self-test intentionally waits three seconds and produced artifacts
for PID 151653 (`linux-ring-stall-151653.json` and
`linux-pipe-stall-151653.json`). These are NOT runtime failures. The self-test
passed. Starting with Linux diagnostic run five, pipe-stage instrumentation uses
one atomic store into a shared file mapping per stage. An external reader emits
the human-readable stage file; the target no longer opens/writes/closes a file
between pipe write and close. All 12 stream groups passed with that recording.
The macOS nested-Facade stress fixture also completed 800 calls and natural exits
in 47.48 seconds.

### io_uring queue publication ordering

A source audit against the kernel's documented shared-ring protocol found plain
`Pointer.readU32`/`writeU32` accesses for SQ/CQ ownership counters. The kernel
requires acquire loads before consuming published payloads and release stores
before advertising initialized/reusable slots. Plain pointer accesses do not
provide that ordering on aarch64. This is a confirmed protocol gap, but no
captured pipe failure has yet been attributed specifically to reordered memory.
Reference: https://man7.org/linux/man-pages/man7/io_uring.7.html . Context7 found
liburing but no matching ordering documentation, so the authoritative manual and
local pinned V8 implementation were inspected.

The Linux backend now aliases its ring mappings through `Pointer.view` and uses
`Atomics.load`/`store` for head/tail counters. Pinned V8 152.2.0 implements these
integer-view operations with sequentially consistent AtomicLoad/AtomicStore,
which satisfies the kernel's acquire/release requirements. Views are detached
before unmapping. No Rust API or new library dependency was needed.

A focused eight-entry-ring test cycles 2,048 timer completions through queue
wrap and cancellation, checking for missing, duplicate and misidentified
responses. It passed before the repair: this is stress coverage, not a
reproducible memory-ordering failure. The native-alias atomic access/detachment
contract also passed independently. The tests are retained in the readiness
batch and Pointer.view suites. The updated Linux backend still needs its build,
focused checks and ten clean full runs; the in-progress diagnostic sequence is
using the previous binary.


### Late native wake borrowers

The async FFI completion, cross-thread callback and `Pointer.view` finalizer
paths also retained bare wake-pipe integers. Dropping `IsolateAsyncState` closed
both endpoints even while a native producer could still notify. Unlike the
process-bridge reader, this can write a stray wake byte into a successor's
reused descriptor. It is a proven ownership defect, not a captured explanation
of the earlier FdReader timeout.

A focused native test retained a completion handle across async-state shutdown;
its descriptor was already invalid before the repair (`wake-lifetime-red.log`).
The state and all three native producers now share the existing `WakePipe`
through `Arc`. The pipe uses `OwnedFd` for each endpoint, and final close waits
for the last producer. No extra scheduler, queue or public native API was added.
The regression verifies that late notifications from all three producers reach
the original pipe, that a successor receives none, and that releasing the last
borrower releases the pipe. All 56 macOS native tests pass.

### Validation after the shutdown and queue repairs

`macos-shutdown-final` completed ten consecutive full runs, each with 963 root
groups, 959 passes and four explicitly gated skips. Linux's diagnostic sequence
completed nine runs, then its tenth reached the documentation-types group's
90-second coordinator deadline. The pipe test completed all six recorded stages.
The documentation helper executes commands in-process, and this group contains
18 tests with repeated documentation builds. A standalone repeat passed in
18.97 seconds. The deadline remains unchanged; the captured evidence does not
distinguish a lost wake from a slow group in that failed full run.

The io_uring ordering build passed all 19 readiness/FFI/stream root groups on
both platforms. All temporary Linux stream-stage instrumentation was then
removed. The `macos-atomic-final` and `linux-atomic-final` sequences each passed
their first full run before the late-native-wake ownership defect above was
found. Their counters are superseded by a fresh validation of that repair.
An external recorder can now sample the main process's mapped queues without
requiring pipe-stage instrumentation (`linux-clean-ring-watch.py`).


While superseding the atomic-only sequences, rebuilding the Linux executable
invalidated `current_exe()` paths held by an already-running process. Its second
run reported `createProcessContext: spawn: No such file or directory` in process
Realm cases. This is a validation-harness error, not evidence of a runtime wake
failure. Final sequences use immutable executable copies and never replace the
running binary. The macOS superseded second run completed its full TAP plan.


### Remaining failures after retained native wake pipes

`macos-wake-final` passed six runs; run seven failed four root groups in PTY
startup/input tests (232.52 seconds). Multiple terminal screens remained blank.
The lifecycle fixture's cleanup then masked its initial error with ENOENT for a
ready marker that had never been created. Cleanup now tolerates only that missing
marker; it preserves the original failure. The four PTY groups passed together
in isolation. A subsequent full diagnostic run also passed in 245 seconds.

`linux-wake-final` passed seven runs; run eight reproduced the FdReader EAGAIN
60-second timeout (301.72 seconds total). Atomic queue publication and retained
native wake-pipe ownership are therefore not the complete repair. External ring
records use the `linux-wake-final-ring-*` prefix. No final serial check started,
because the automatic post-soak checks correctly refused failed sequences.

A macOS PTY/Realm churn fixture reproduced blank screens and retained live
samples under `macos-pty-live-*`. Some children were still compiling/loading
modules during the capture; this suggests investigating startup latency but
is not proof of the cause of every blank screen. The first fixture mistakenly
removed its script after one concurrent lane failed while other lanes were
still active; subsequent missing-module errors from that fixture are invalid
runtime evidence. It now awaits all lane outcomes. An 80-lifetime repeat with a
30-second diagnostic screen budget passed, with none taking more than four
seconds in that run. The ordinary PTY timeout remains unchanged at five seconds.

PTY timeout errors now include the child PID/status, output byte count and
read-pump state/errors. The regression failed against the previous binary and
passes with the new implementation; the four focused macOS PTY groups pass.
These are bounded scalar observations of existing work and add no polling or
runtime handles. They are an incremental diagnostic improvement, not the
proposed holistic `fino:diagnostics` module.

Pipe-only stress passed 8,000 operations in eight Realms, then 64,000 operations
in 64 Realms. Repeating the entire stream test file 100 times without tracing
also passed. Linux now has temporary failure-only stage reporting in its stream
test and logging when a pending read/write resolver is replaced. Replacement
is an explicit existing loop contract, including deliberate replacement tests;
these traces are intended to identify unexpected callers, not change that
contract. Remove both temporary modifications before final clean validation.


### QUIC rearming readiness after transport closure

The replacement trace immediately found non-test replacements in
`QuicConnection.#runSocketLoop`, during certificate rejection and mTLS cases.
Receiving a packet can synchronously close the connection and UDP transport,
but the receive loop then called `waitReadable()` unconditionally. The real
transport installed a new watch even when closed. Because fd release precedes
that late registration, another Realm may already own the number by the time
the main controller installs it. This is a concrete route for stale ownership
to interfere with a successor's readiness; the specific failed pipe has not
yet been correlated with such a registration.

The new transport regression demonstrated both read and write registrations
after close (`quic-closed-transport-red-bounded.log`). Real transports now reject
closed readiness waits, return closed/no-data results before batch I/O, and
remove both pending watch types during close. Connection and listener loops
also recheck owner closure after packet callbacks before waiting again. The
existing simulator already rejects closed readiness waits; no new native
primitive or parallel transport abstraction was introduced.

All nine QUIC/simulator root groups pass on both targets with this repair.
Linux's retained replacement trace reports no QUIC replacements in that focused
run. Native QUIC availability was checked separately. Fresh clean full-suite
validation is required after removing Linux's temporary tracing.


## Final validation after the QUIC lifetime repair

The final gate is complete on both targets: ten consecutive full parallel runs,
followed by a full serial run, all with exit 0 and no hangs or failures. All 22
runs report a root plan of 963, 959 passes and four root skips. The four root
skips are the existing opt-in Autobahn, h2spec, WPT and live DNSSEC suites;
additional optional leaf skips remain in the suite. Linux required H2, H3, TLS
and SQLite feature flags were enabled. macOS required SQLite, and native QUIC
availability was independently verified on both targets.

| Target | Consecutive parallel passes | Parallel duration range | Serial pass |
| --- | --- | --- | --- |
| macOS | 10/10 | 206.62–233.20 s | 392.15 s |
| Apple Container Machine Linux/aarch64 | 10/10 | 206.54–241.12 s | 386.74 s |

Commands, run from each platform's repository root, used immutable copies of
its current debug binary:

```sh
# macOS
FINO_REQUIRE_SQLITE=1 target/hang-diagnostics/macos-quic-bin/fino test --parallel tests
FINO_REQUIRE_SQLITE=1 target/hang-diagnostics/macos-quic-bin/fino test tests

# Linux, through container machine run in the Linux worktree
FINO_REQUIRE_SQLITE=1 FINO_REQUIRE_H2=1 FINO_REQUIRE_H3=1 FINO_REQUIRE_TLS=1 \
  /var/tmp/fino-hangs-quic-final/fino test --parallel tests
FINO_REQUIRE_SQLITE=1 FINO_REQUIRE_H2=1 FINO_REQUIRE_H3=1 FINO_REQUIRE_TLS=1 \
  /var/tmp/fino-hangs-quic-final/fino test tests
```

Local evidence lives under the ignored `target/hang-diagnostics/` directory:

- `macos-quic-final-summary.json` and `linux-quic-final-summary.json`, plus
  their ten individual TAP logs;
- `macos-quic-final-serial-summary.json` and
  `linux-quic-final-serial-summary.json`, plus their TAP logs;
- `quic-final-validation-manifest.json` records binary hashes, flags and commands;
- `quic-final-source-hashes.json` identifies the 25 changed source/test files;
  hashes and Linux worktree parity were rechecked after validation.

Temporary resolver/pipe-stage tracing was removed before the final builds.
External Linux queue snapshots did not consume I/O or advance queues; automatic
macOS debugger sampling was stopped. All diagnostic watchers are stopped after
validation. TypeScript formatting/lint, Rust formatting and `git diff --check`
pass. The unchanged native repair passes all 56 Rust tests on both platforms.
The new PTY timeout description was verified through generated docs build,
search and show.

This sequence satisfies the requested empirical gate. It does not retroactively
identify the exact lost event in every earlier timeout: the QUIC closed-fd
registration defect was reproduced and repaired, and its unexpected resolver
replacements disappeared, but no capture correlated a particular stale QUIC
watch with the exact pipe read that failed earlier. Likewise, io_uring atomic
publication addresses a protocol requirement without a deterministic hardware
reordering reproduction. Keep those limits distinct from the directly proven
kqueue, native ownership and forced-termination defects.

Performance overhead of the ownership and atomic-publication changes has not
been benchmarked; debug-suite durations are validation timings, not performance
measurements. Linux Clippy remains unavailable in the installed toolchain.
