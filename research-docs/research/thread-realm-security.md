# Thread-Realm Security

> Goal: figure out whether fino's **thread realms** — a child that gets its own
> V8 isolate on its own OS thread, but shares the parent process's memory — can
> be given any useful OS-level security or resource controls, and if so, which
> ones are worth building and which would be dishonest to ship.

This is an exploration, not a plan to build. It records what is possible, what it
would buy you, and where the sharp edges are, so the build-or-not decision can be
made from the analysis rather than from a hunch.

## The one fact that governs everything: a thread is not a wall

A process realm is a real boundary. It has its own address space, so even if the
code inside it goes fully hostile, it cannot reach out and corrupt the parent —
it can only do what the OS lets its own process do, which is exactly what the
process sandbox (Landlock/seccomp/cgroups/Seatbelt) now constrains.

A thread realm is different. It runs on its own OS thread with its own isolate,
but every thread in a process shares one address space and one file-descriptor
table. Two things follow, and they set the ceiling on everything below:

- **Shared memory means no wall against hostile code.** A thread realm can, in
  principle, reach into memory that another realm — or the host runtime — is
  using. V8 isolates are not a security boundary; a bug in the JIT or in a native
  binding lets one isolate read or write another's memory. So no per-thread OS
  control can *contain* code that is actively trying to escape, because the code
  can sidestep the control by manipulating shared state that some other,
  unrestricted thread will act on.

- **Therefore per-thread controls are governance and defense-in-depth, never
  containment.** They are good for keeping a *cooperative but heavy* realm from
  hurting its neighbours, and for *shrinking the blast radius* of a bug in a
  realm you mostly trust. They are not good for running someone else's malware.

The runtime already says as much: "Realms do not sandbox the child against the
host operating system" (`js/realm/isolation.md:77`). If you need a boundary
against untrusted code, the answer is a **process realm**, which already has the
full sandbox. Everything in this document is about the softer goals.

## Which thread runs what (this decides what any control can even see)

A per-thread control only affects syscalls made *on that thread*. So the first
question is: when a thread realm does something, where does it actually happen?

Each `Realm({ thread: true })` gets exactly one dedicated OS thread, spawned with
`std::thread::spawn` (`src/realm/thread.rs:214`) — there is no thread pool at this
layer; even the warm-worker `fino:realm/pool` is just kept-alive thread realms,
each still its own thread and isolate. That thread creates its own V8 isolate
(`src/realm/child.rs:87`) and runs its own event loop — the kqueue/io_uring loop
is JavaScript (`js/internal/runtime/loop.ts`) executing on the realm's own thread
(`src/realm/child.rs:225`). (The "virtualized loop" that hands I/O back to the
parent is for *embedded*, same-thread realms only; a thread realm blocks in its
own loop.)

The upshot:

| What the realm does | Runs on… | A per-thread filter on the realm's thread sees it? |
|---|---|---|
| Its JS, timers, and event loop (socket/file `read`/`write`/`connect`) | the realm's own thread | **Yes** |
| Synchronous FFI (`async: false`) — runs inline in the V8 call (`src/ffi/mod.rs:310` → `ffi/call.rs:78`) | the realm's own thread | **Yes** |
| **Asynchronous FFI (`async: true`)** — offloaded (`ffi/call.rs:401`) | a **shared, process-wide** pool thread | **No** |
| An *embedded* (same-thread) realm's I/O | the parent's thread | n/a — can't be isolated per-thread |

So a control installed on a thread realm's own thread would cover its I/O and its
synchronous FFI. The gap is asynchronous FFI — see the next section.

## The shared blocking pool: a future consideration, not a bug today

It is worth being explicit, because it is easy to misread: **today this is not a
defect.** There are currently *zero* per-thread security controls in fino, so
there is nothing for anything to bypass. fino offloads `async: true` FFI (and
other blocking work) onto a single process-wide thread pool that reuses its
worker threads — "the pool is global (one per process), grows on demand up to
`BLOCKING_MAX_THREADS` (default 500)" (`src/async_rt/blocking.rs:1-7`). That is
exactly the right design: it caps thread creation and keeps offload cheap.

It only *becomes* something to think about if we later add per-thread syscall
filtering. A seccomp or Landlock filter installed on a thread realm's own thread
would not cover work that realm hands to a shared pool thread — so a filtered
realm could still make a forbidden syscall by routing it through an `async: true`
FFI call. It also lightly touches CPU budgeting: time a realm spends in offloaded
async FFI runs on pool threads that sit *outside* the realm's cgroup, so it would
not count against that realm's CPU quota. Neither of these is a correctness
problem in what exists — they are design considerations that only surface if the
corresponding control is built. If it ever is, the fix is one of: forbid
`async: true` FFI inside a sandboxed thread realm, or give a sandboxed realm its
*own* small blocking pool whose threads inherit its filter (seccomp and Landlock
are inherited by threads created after the filter is installed, so a pool spawned
*by* the already-filtered realm thread would carry the same restrictions).

## What the operating systems actually offer per thread

### Linux — quite a lot

Linux tracks most of its security and resource state per *task* (its word for a
thread), even where POSIX pretends it is per-process:

- **Syscall filtering per thread.** You can tell a single thread "you may never
  call these syscalls" — the filter applies only to that thread (`seccomp` with a
  per-thread `PR_SET_NO_NEW_PRIVS`, without the "sync to all threads" flag). It is
  add-only and permanent for that thread's lifetime.
- **Filesystem confinement per thread** (`landlock_restrict_self`) — but files
  already open anywhere in the process keep working through the shared descriptor
  table, so it leaks.
- **Dropping privileges per thread** — a thread can shed user-id or Linux
  capabilities for itself alone (the raw syscalls are per-thread; glibc adds the
  cross-thread sync to fake POSIX semantics).
- **CPU, cores, and process-count budgets per thread** via cgroup v2's "threaded"
  mode: a threaded cgroup subtree accounts individual threads, and the `cpu`,
  `cpuset`, and `pids` controllers work at that granularity. Crucially, the
  **`memory` and `io` controllers do not** — they only work at whole-process
  granularity — so per-thread *memory* limits are simply not a thing.
- **Network placement per thread** — a thread can join a different network
  namespace than its siblings (`setns`), which is how you would give one realm
  "no network."
- **Scheduling knobs per thread** — priority, CPU affinity, I/O priority. Pure
  governance.

### macOS — almost nothing

macOS's sandbox (`sandbox_init`, the thing behind `sandbox-exec`) applies to the
**whole process** and can only be tightened, never scoped to one thread. There is
no per-thread sandbox, no per-thread uid. What is left is scheduling-flavoured:
per-thread **QoS class** and priority, and the Apple-Silicon per-thread toggle
for making JIT memory writable. In short: on macOS you can *govern* a thread
realm's CPU behaviour, but you cannot *confine* what it is allowed to do.

## Where realm security lives today (and where new controls would hook in)

Realm security in fino is currently entirely at the JavaScript module-import
layer: `ImportMap.deny`, facades, and provider overrides, with a
narrowing check that stops a child from re-granting what a parent blocked
(`src/realm/native.rs:93,165`). There is no OS-level per-realm control anywhere —
no rlimits, cgroups, thread priorities, or syscall filters attached at the
thread-realm boundary.

If any of the options below were built, the natural place to install a per-thread
control is right after the realm's isolate is created and before any user JS runs
— `crate::async_rt::init()` at `src/realm/child.rs:96`, or `run_thread_isolate`
at `src/realm/thread.rs:254`, which still has the realm's config in hand to decide
the policy. No thread naming or scheduling is set there today, so it is a clean
hook.

## The options, and what each one actually buys you

### A — Give each thread realm its own CPU budget *(the one worth considering)*

**What it buys you:** one thread realm doing heavy work — a plugin crunching data
in a tight loop, or a runaway `while (true)` — can no longer hog the machine and
make everything else (your HTTP handlers, the main app) stutter. You cap it, say,
at half a core, and the rest of the app stays responsive; the greedy realm just
runs slower in its own lane. You could also pin a realm to specific cores or cap
how many threads it is allowed to spawn.

**Scenario:** an app hosts fifty plugin realms. One ships a bad build with an
accidental busy-loop. Without CPU budgeting it starves the other forty-nine and
the whole app goes unresponsive; with it, that one realm is throttled and nobody
else notices.

**How, briefly:** cgroup v2 threaded mode on Linux (`cpu`/`cpuset`/`pids`),
reusing the cgroup machinery already written for the process sandbox
(`js/internal/security/sandbox/cgroup.ts`); QoS class as the best-effort analog on
macOS.

**The honest caveat:** you can cap CPU time, cores, and process count per realm,
but **not memory** — Linux only limits memory per whole process, so a per-realm
memory cap is not achievable this way. Say so plainly rather than implying a
memory limit that cannot exist. (And per the pool note above, CPU spent in a
realm's async FFI would not count against its quota.)

This is the only option that is both clearly valuable and completely honest: it
is resource *governance*, it never pretends to be a security boundary, and it maps
onto a real, common pain point (noisy-neighbour realms).

### B — Shrink the blast radius of a semi-trusted plugin *(Linux only, defense-in-depth)*

**What it buys you:** for a plugin you *mostly* trust, you can pre-declare that
its thread is simply not allowed to do dangerous things — no launching other
programs, no opening raw network sockets, no attaching a debugger to other
processes. If a bug in that plugin is exploited, the attacker who lands code
execution finds most of the interesting doors already locked.

**The limit, stated first so nobody is misled:** this is seatbelts, not a vault.
Because every thread realm shares memory, it does **not** stop code that is
actively hostile and knows what it is doing — that code can reach into shared
state to get its way. Use it to reduce the damage from an *accident* or a
*single bug*, not to host an adversary. For an adversary, use a process realm.

**Scenario:** an image-resizing plugin should only ever read and write pixels and
never spawn a shell. Deny its thread the "launch a program" syscall and it
cannot, even if a malformed image triggers a bug in it.

**How, briefly:** a per-thread seccomp denylist installed at the realm's startup
hook. It is only meaningful if the shared-pool consideration (§3) is handled —
otherwise a forbidden call just gets routed through async FFI onto an unfiltered
pool thread, and the filter is theatre.

### C — "No network" or "no disk" thread realms *(weak; note but don't pursue)*

**What it buys you:** a thread realm that has no business touching the network or
the filesystem could be told so (per-thread network namespace; Landlock).

**Why it is weak:** sockets and files opened elsewhere in the process still work
through the shared descriptor table, so the restriction leaks in practice. Niche
and easy to get wrong; not recommended over A or B.

### Non-goal

Selling any of the above as "safe to run untrusted or hostile code in a thread."
It is not, and claiming so would be dishonest given the shared address space. That
job belongs to process realms, which already have the real sandbox.

## If B is ever pursued, this is the decision that matters

The private-versus-shared blocking pool is the load-bearing choice. A per-thread
syscall filter on a realm whose async FFI still lands on the global pool is
theatre for any workload that uses async FFI. Closing it means one of:

- **Forbid `async: true` FFI in a sandboxed thread realm.** Simplest and fully
  honest: the realm's syscalls are then genuinely all on its own filtered thread.
  Costs the realm the ability to offload blocking FFI (it can still do sync FFI
  and async I/O through the event loop).
- **Give a sandboxed realm its own blocking pool.** The pool's threads, spawned
  by the already-filtered realm thread, inherit its seccomp/Landlock restrictions,
  so offloaded work stays contained. More machinery, and it trades the global
  pool's efficiency for isolation — worth it only if sandboxed thread realms
  become a real use case.

A being independent of this — CPU governance does not need the pool solved — is
another reason A is the cleaner first step if anything here is built at all.
