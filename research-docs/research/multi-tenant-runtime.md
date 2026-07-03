# Fino as a Multi-Tenant Distributed Runtime

> Status: exploratory, direction-setting. No implementation is proposed for
> immediate start; this maps the territory for three connected ideas —
> load-aware realm scheduling, syscall-level I/O virtualization, and WASM
> realms — and argues they converge on one substrate.
>
> Supersedes the transport note in `cluster.md` (the release transport is now
> WebTransport over HTTP/3; the WebSocket transport no longer exists in-tree).

## 1. The thesis

The goal is a runtime a company can treat as one shared computer: every app
deployed into a single distributed fino cluster, placed automatically by
observed cost, isolated by capability rather than by VM. Three properties make
fino unusually well positioned for this, and all three already exist in
embryonic form:

1. **Placement is cheap and restartable.** Realms are spawned from serializable
   configs, communicate only through ports, and already have a remote spawn
   path (`Realm({ remote: true })` over `fino:cluster`). "Migration" never
   needs VM-style memory movement — it is drain, respawn elsewhere, rebind
   ports in the registry.
2. **The trust boundary is the module graph.** Import rules with
   Rust-enforced capability narrowing (`src/realm/native.rs`) mean a tenant's
   entire I/O surface is enumerable and substitutable at spawn time. This is
   the same lever that enables syscall virtualization (§5).
3. **The runtime owns the event loop.** Because the loop is JS
   (`js/internal/runtime/loop.ts`), fino can observe a load signal no external
   orchestrator can: loop saturation. A node at 40% CPU whose tick latency is
   climbing is *full* for latency-sensitive work; Kubernetes cannot see that,
   fino can.

What is missing, in order of severity: the scheduler's input is fake (§2), apps
cannot be delivered to nodes (§4), there is no CLI or auth story (§3), and none
of the isolation machinery meters resources (§2, §6).

## 2. Per-realm cost telemetry

### Where we actually are

The cluster protocol already carries a `NodeLoad { cpu, memory }` sample in
HELLO/HEARTBEAT, and the seed already places spawns on the lowest-CPU node
(`seed.ts:510`). But the sample is hardcoded — `cpu: 0` at
`webtransport-transport.ts:295` — so placement today is effectively arbitrary.
The scheduler's *shape* exists; its *senses* don't.

And the senses genuinely don't exist anywhere: no loop timing, no
rusage/getrusage binding, no heap statistics, no `process.memoryUsage`
equivalent. `v8::Isolate::get_heap_statistics()` is available in the v8 crate
(v139) and never called. The only timing in the codebase is realm-startup
phase timing behind `FINO_REALM_TIMING`.

### The three signals and how to get each one

**Loop idle ratio** — the JS-native signal, and the cheapest. Instrument
`loop.ts` `tick()`: time spent inside `_wait()` is idle, time outside is busy;
accumulate both and expose `idleRatio` over a sliding window. Thread and
process realms run their own loop, so this is per-realm attribution for free.
This also yields tick-latency (loop lag) as a health signal. Pure JS, no new
primitives.

**CPU time** — fidelity varies by realm kind, and that's fine:

- *Process realms*: `getrusage(RUSAGE_SELF)` self-reported via FFI. Full
  fidelity, includes RSS as a bonus.
- *Thread realms*: per-thread CPU clocks — `pthread_getcpuclockid` +
  `clock_gettime` on Linux, `thread_info(THREAD_BASIC_INFO)` on macOS. Both
  callable from JS inside the realm via FFI; no Rust needed.
- *Embedded realms*: no OS-level identity, so attribute wall-time spent in
  `step_child_context` (`src/realm/mod.rs:101`) with an `Instant` pair —
  Rust, but two lines in an existing choke point. This is a proxy, not truth
  (it charges the realm for time the parent spent stepping it), and a proxy
  is enough for scheduling.

**Memory** — again by kind:

- *Process realms*: RSS from rusage. Done.
- *Thread realms*: own isolate → `get_heap_statistics()` exposed through a
  small `internal:runtime/stats` native hook. One call, one binding.
- *Embedded realms*: shared isolate. Per-context attribution needs V8's
  `MeasureMemory` API, which the v8 crate does not bind — but
  `src/profiler/binding.cc` is precedent that a missing crate API is a small
  C++ shim, not a blocker. Defer; v1 can report embedded realms' memory as
  "shared" and schedule them on CPU/loop signals only.

### Architecture: self-reporting, not polling

Each realm samples itself and reports upward — this matches the established
child-initiated-lifecycle principle (children signal parents; parents don't
observe children externally). Concretely: an `internal:runtime/stats` module
that every realm's bootstrap runs, sampling on a timer, smoothing with an EWMA,
and pushing `{cpu, heapUsed, idleRatio, handleCounts}` over the existing realm
port. The node aggregates its realms plus node-level capacity (`sysconf`
cores, `sysctl`/`/proc/meminfo` totals — all FFI) into an extended `NodeLoad`:

```ts
interface NodeLoad {
  cpu: number;            // [0,1], node-wide
  memory: number;         // bytes in use
  capacity: { cores: number; memory: number };
  loopIdle: number;       // [0,1], root loop
  realms: Record<string, RealmLoad>;  // per-hosted-realm cost
}
```

The heartbeat already fires every 2500 ms; the extended sample rides it with
zero new connections. The seed keeps a decaying per-node, per-realm view —
that view *is* the cost model. The same stats module should register OTel
observable gauges (the meter API exists, no runtime instruments do), so
cluster scheduling and observability draw from one source.

## 3. Coordination, membership, and the CLI

### Keep the star, make the seed's state soft

The single-seed star topology is the right v1 and worth keeping longer than
instinct suggests — but the seed should be *restartable*, not *precious*. The
move: split seed state into two tiers.

- **Runtime state (soft)**: membership, port registry, load views. All of it
  is rebuildable if every worker re-announces its hosted realms and ports on
  reconnect. Add that re-announce message and seed restart becomes a
  reconnect storm, not an outage. No Raft, no election — deferred exactly as
  `cluster.md` already defers it, but now with a story for why that's safe.
- **Desired state (durable)**: deployments — "app X, version Y, N replicas,
  these grants, these limits." This is the one thing that must survive a seed
  restart, and fino has sqlite; the seed keeps a small sqlite database and
  reconciles observed state (which realms exist) against desired state
  (which should) on a loop. That reconcile loop is the deployment controller.

Seed HA proper (standby seeds, failover ordering shipped in the join config)
and cluster authentication should be designed together, as `cluster.md` says.
For auth, the kubeadm pattern fits fino's constraints well: `cluster start`
mints a join token and prints a join string embedding address, token, and the
seed's certificate hash — WebTransport already requires TLS, so cert pinning
via the join string closes the bootstrap loop without a CA:

```
fino cluster start --listen :4433 --state ./cluster.db
  → join with: fino cluster join fino://10.0.0.5:4433/#tok_9f3a…@sha256:ab12…

fino cluster join 'fino://10.0.0.5:4433/#tok_9f3a…@sha256:ab12…'
fino cluster status        # nodes, load, hosted realms
fino deploy ./my-app --replicas 3
fino ps                    # deployments and realm placement
```

All of this is thin: the commands infrastructure exists
(`js/internal/commands/`), and each command wraps the existing `fino:cluster`
API plus the seed's control protocol. Nothing goes in Rust.

### Data plane: get PORT_MSG off the seed

Today every inter-realm message relays through the seed — acceptable now,
fatal for a multi-tenant runtime where tenant traffic is the workload. The
deferred direct-peer work becomes load-bearing here: workers already learn of
peers via seed broadcasts, so the seed's remaining data-plane job is
introductions (peer address + cert hash), after which `PORT_MSG` flows over
direct WebTransport connections. The seed stays control-plane only:
membership, placement, desired state.

## 4. Packaging and deploy

### The gap

Remote spawn ships an entry *path*, resolved on the target's filesystem
(`client.ts:648`). The app must already be everywhere, which means there is no
deployment story at all. This is the single biggest blocker to the
multi-tenant vision.

### An archive, not a bundle

Fino runs TypeScript directly, so packaging needs no bundler and no build
step — a package is an archive (`js/archive.ts` already exists) of the app
directory plus a manifest:

```jsonc
// fino.pack.json
{
  "name": "billing-api",
  "version": "3.2.1",
  "entry": "src/main.ts",
  "capabilities": [                 // requested import grants
    { "pattern": "fino:net/*" },
    { "pattern": "fino:file", "scope": "/data/billing" }
  ],
  "resources": { "memory": "512Mi", "cpu": 0.5 },   // requests, not limits
  "constraints": { "libs": ["libsqlite3"] }          // node must satisfy
}
```

The flow: `fino deploy ./app` archives the directory, content-addresses it by
hash, uploads it to the seed over the cluster transport; the seed stores the
blob (sqlite again), records the deployment as desired state, schedules it;
chosen nodes fetch the archive by hash, unpack into a content-addressed cache
(`~/.fino/casks/<hash>/`), and spawn the realm with the entry path inside the
cache. The hash-addressed cache makes redeploys of unchanged versions free and
rollbacks instant.

Two design points worth settling early:

- **Capabilities are requests; the operator grants.** The manifest's
  `capabilities` list is the app saying what it needs; cluster policy decides
  what it gets, and the spawn uses `ImportMap.deny` plus the granted rules.
  The existing narrowing invariant then guarantees a tenant cannot escalate —
  the multi-tenant security model is already built, it just needs a policy
  layer feeding it.
- **`constraints.libs` is a real, fino-specific scheduling input.** The
  prefer-system-libs policy means nodes legitimately differ in what
  `dlopen` can satisfy. Nodes should probe their candidate paths at join time
  and advertise resolved libraries; the seed filters placement on manifest
  constraints. This turns the existing candidate-path machinery into a
  capability advertisement, and it composes with platform constraints
  (io_uring vs kqueue, arch — until WASM erases arch, §6).

Dependencies: v1 vendors `fino install` output into the archive (hermetic,
larger); a later optimization is lockfile-in-manifest with install-on-unpack
into the shared cache. Start hermetic.

### Scheduling with real senses

With §2's telemetry flowing, the seed's placement upgrades from
lowest-hardcoded-zero to the classic two-phase shape:

1. **Filter**: platform/arch/libs constraints, memory request fits node's
   remaining capacity, tenant anti-affinity if configured.
2. **Score**: weighted blend of projected CPU, memory headroom, and — the
   differentiator — loop idle ratio. Score should favor loop headroom for
   latency-sensitive apps and raw CPU headroom for batch work; a per-app
   `profile: "latency" | "throughput"` hint in the manifest picks the weights.

Because per-realm cost is tracked continuously, the seed accumulates an
empirical cost model per app version ("billing-api@3.2.1 costs ~0.3 cores,
~180 MB, ~20% loop at steady state"), which beats manifest requests for
second-and-later placements and enables rebalancing: when a node's loop idle
collapses, the seed picks its cheapest-to-move realm and respawns it
elsewhere. Restart-based rebalancing is honest about fino's model — realms
are cheap to restart, so don't build live migration; build fast, graceful
drain (child-initiated: node asks realm to finish in-flight work and exit
with a "relocating" code).

## 5. Syscall-level virtualization

### The insight: virtualize `dlopen`, not the call site

The question was whether the FFI substrate can be virtualized so syscalls can
be faked, just-bash-style. Exploration says yes, with one reframing: the choke
point is not the call, it is symbol acquisition. There is deliberately no
single Rust dispatch point — V8 fast-api trampolines bypass
`symbol_call_callback` entirely once TurboFan optimizes a call site — and libc
is dlopen'd independently by ~7 modules. But *every* symbol a realm can ever
call arrives through `dlopen` from `fino:ffi`, and `fino:ffi` is a module
specifier subject to per-realm import directives, resolved before the
synthetic-module cache (`loader.rs:1287`). One `Remap` rule therefore
virtualizes every libc consumer in the realm, present and future, including
tenant code that dlopens libc directly.

The shim's `dlopen(path, defs)` consults an interposition table keyed by
canonical library identity (libc, libssl, … — matched over the candidate-path
sets, since literal paths differ per platform) and symbol name:

- **Interposed symbols** return JS functions backed by the provider layer —
  `open/read/write/close` over a `FileSystem`, `socket/connect/send/recv`
  over a network provider or facade. These lose the fast path, which is
  correct: you pay only where you virtualize.
- **Passthrough symbols** return the *real* FFI symbol objects, preserving
  fast-api performance untouched. The shim gets real FFI through an
  importer-scoped rule — `ImportRule.from` already exists, so the parent can
  grant real `fino:ffi` *only when the importer is the shim module*. The
  child cannot import it directly; the shim can. No new mechanism.

There is a sharp caveat on passthrough: any realm holding one real symbol plus
`Pointer` arithmetic can do arbitrary memory operations in-process. So
passthrough mode is for *virtualization* (testing, determinism, I/O policy on
trusted-ish code), not *containment*. For hostile tenants the modes are: full
interposition (everything through providers/facades, slow but airtight),
module-level denial of `fino:ffi` entirely (the current model — the syscall
shim then exists to make denied realms *functional* rather than broken), or a
process realm inside an OS sandbox (seccomp / `sandbox_init`) as the outer
wall.

### The library-internal syscall question

The suspicion was right: syscalls made *inside* a native library (sqlite
calling `open` through its own libc linkage) never cross the FFI boundary and
cannot be intercepted there. No amount of FFI virtualization sees them. But
surveying what fino actually links changes how much this matters:

- nghttp2, nghttp3, ngtcp2 — sans-I/O by design; all I/O is already JS's.
- zlib, brotli — pure memory transforms; no syscalls of interest.
- sqlite — solved: the JS-implemented `sqlite3_vfs` (`vfs.ts`) routes all of
  sqlite's file I/O through `FileHandle.preadSync/pwriteSync`, i.e. through
  whatever `FileSystem` provider the realm has. This is the pattern, already
  shipped.
- OpenSSL/GnuTLS — used for crypto and TLS record processing with JS-owned
  transport (memory BIOs / ngtcp2 crypto callbacks), so likely no independent
  I/O; worth a one-time audit to confirm nothing (RAND, config loading, cert
  stores) opens files behind our back.

So the honest statement is: FFI virtualization covers everything *except*
library-internal I/O, and fino's library choices have almost eliminated
library-internal I/O. The durable policy that falls out: **a native library is
admissible only if its I/O is externalizable** — sans-I/O, or a VFS/BIO-style
plugin API we implement in JS. A library that insists on doing its own I/O is
confined to process realms under an OS sandbox, or not granted.

### The second lever: the loop backend

`internal:runtime/loop-backend` is an ordinary remappable builtin. A fake
backend that fabricates readiness/timer/completion events controls the
sandbox's entire notion of time and I/O readiness — combined with the dlopen
shim, that is a fully deterministic execution environment: seeded fake clock,
scripted I/O, reproducible interleavings. `net/simulated-provider.ts` is the
working precedent. This is the foundation for a deterministic-simulation
testing story (record/replay, FoundationDB-style fault injection) that falls
out of the same two remap rules, and it is also what makes "run this tenant's
I/O against cluster-remote storage" a config change rather than a feature.

## 6. WASM realms and a WASI on the same substrate

### It already runs

V8's `WebAssembly` global is on by default and fino never disables it; the
loop already pumps WASM background-compilation tasks and folds
`has_pending_background_tasks` into liveness (`async_context.rs:82-113`).
Within a realm, instantiation imports are plain JS functions — no new
mechanism needed for same-realm embedding.

### WASI: the async-only philosophy meets a sync ABI — JSPI resolves it

WASI preview1 is a synchronous ABI (`fd_read` returns, it doesn't promise),
which collides head-on with the async-I/O-only rule. The resolution is V8's
JS Promise Integration (JSPI): wrap imports in `WebAssembly.Suspending` and
the instance in `WebAssembly.promising`, and a sync-looking WASM import can
suspend on a JS promise. JSPI shipped enabled-by-default around V8 13.7; the
crate is v139 (13.9), so it should be available without flags — **verify with
a smoke test before designing further; this is the load-bearing assumption.**

With JSPI, a WASI preview1 shim is a pure-JS module: `fd_read` awaits
`FileHandle.pread` on whatever `FileSystem` the realm has; `sock_*` maps to
the network provider; the fd table is a JS Map. Which means WASI is not a new
subsystem — it is *another consumer of the same virtual provider substrate*
as the syscall shim in §5. The same import rules that decide what a JS tenant
can touch decide what a WASM tenant can touch.

And yes, the Facade mechanism composes directly: facade calls are async, JSPI
makes async acceptable at the import boundary, so a child realm's WASI can be
backed by parent facades with zero impedance mismatch. `facade.stream()` /
`sendStream()` map naturally onto fd read/write. Cross-realm WASI is facades
plus the JSPI shim, nothing more.

### Why WASM matters for the cluster specifically

- **Arch-independent deployment.** A WASM cask runs on macOS-arm64 and
  linux-x86 nodes identically, dissolving the arch constraint from §4 and
  making heterogeneous clusters (dev laptops + servers) real.
- **Cheapest strong tenant isolation.** A WASM instance inside an *embedded*
  realm has its own linear memory and only the imports it was handed — strong
  memory isolation without paying for a new isolate or thread, with a hard
  memory cap (WASM memory limits) that fino cannot currently impose on
  embedded JS realms at all.
- **Polyglot tenancy.** The multi-tenant runtime stops being JS-only: any
  language with a wasip1 target deploys into the same cluster under the same
  capability and cost model.

WASI preview2/component-model is the horizon (natively async, would delete
the JSPI dependency) — watch it, but preview1 is what toolchains emit today
and the shim is small. Don't build for preview2 yet.

## 7. Convergence

The three explorations end in the same place. The module graph is the one
mechanism: import rules already decide *what exists* for a realm; the dlopen
shim extends that to *what syscalls mean*; the WASI shim extends it to *what
non-JS code sees*; the capability manifest extends it *across the network*.
Telemetry prices each realm; the seed places by price; packages move the code.
Multi-tenancy is then the composition — narrowing for trust, metering for
cost, scheduling for placement — with no component that isn't also useful
alone.

## 8. Sequencing sketch

Ordered by unblocking power, each step independently shippable:

1. **`internal:runtime/stats` + real `NodeLoad`** — loop idle timing in
   `loop.ts`, rusage/thread-CPU via FFI, heap stats via one Rust call;
   replace the hardcoded `cpu: 0`. The existing lowest-CPU scheduler starts
   working the day this lands. Smallest step, immediate payoff.
2. **Cluster CLI** — `cluster start/join/status`, join-string auth with cert
   pinning. Thin JS over existing APIs; makes the cluster demoable.
3. **Cask format + `fino deploy`** — archive + manifest + content-addressed
   fetch/unpack + seed sqlite desired-state. Kills the shared-filesystem
   assumption; the reconcile loop makes deployments self-healing.
4. **Scheduler v2** — filter/score, lib/platform advertisement, empirical
   per-app cost model, drain-based rebalancing.
5. **dlopen shim prototype** — interposition table + importer-scoped
   passthrough; prove it on a virtual filesystem under `fino:file`-denied
   code, and audit OpenSSL's residual file access while there.
6. **JSPI smoke test, then WASI preview1 shim** — gate on the smoke test;
   the shim itself is small and pure JS.
7. **Direct peer data plane + seed soft-state rebuild** — when tenant traffic
   or seed restarts start to hurt, in that order.

Naming, when things need names (offered, not assumed): fino is a sherry, and
the sherry lexicon fits unusually well — *solera* for the scheduling/
distribution system (the solera literally distributes contents across barrels
over time), *cask* for the deployment archive, *bodega* for the seed's
package store. Each is honest about what the thing concretely does.
