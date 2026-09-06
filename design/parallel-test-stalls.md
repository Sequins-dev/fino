# Parallel test stalls: findings

Investigation notes for the CI hang in the Linux `Tests` job, the work done to
make the test runner fail instead of hang, and the state of the underlying
runtime defect that is still open.

Written while the investigation is in progress. The eliminations below are
recorded with the measurement that produced them, so that anyone picking this
up does not repeat them.

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
