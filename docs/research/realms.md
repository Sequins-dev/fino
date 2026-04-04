# Realms — Execution Model and Lifecycle

## What is a Realm?

The term "Realm" comes from the TC39/WHATWG specification, where it means a distinct JS execution environment with:
- Its own **global object** (no prototype leakage from other Realms)
- Its own **module graph** (independent evaluation, independent module-level state)
- Its own **I/O layer** (see [virtual-io.md](./virtual-io.md))

In Fino, a Realm is the unified abstraction for isolated JS execution. It replaces the separate "VM context" and "Worker thread" concepts from the roadmap — both are special cases of Realm at different isolation levels.

**A Realm is fully functional — equivalent to the main thread.** It can start TCP servers, accept connections, read and write files, spawn processes, open WebSocket connections, and do everything else the main thread can do. The difference is only in what the I/O layer is backed by. A Realm with a real `NetworkProvider` binds actual ports and connects to the real network. A Realm with a `VirtualNetworkProvider` does the same API calls against an in-memory channel layer. The Realm's code does not change — only the I/O provider it was initialized with.

This has a direct consequence: Realms are not inherently "workers" in the sense of passive message handlers. A Realm can equally well be an HTTP server, a background job processor, a test harness, or a full application. The `RealmPool` dispatch pattern (see [distribution.md](./distribution.md)) is one way to use Realms, not the defining model.

---

## Isolation Levels

A Realm can be instantiated at four isolation levels. The API is identical across all four — the isolation level is an implementation detail.

| Level | V8 Mechanism | JS Heap | I/O Loop | When to Use |
|---|---|---|---|---|
| **Embedded** | New `v8::Context`, same `Isolate` | Shared with parent (weak isolation) | Shared kqueue fd, own dispatch maps + `MicrotaskQueue` | Plugins, SSR, REPL, test isolation, untrusted code with virtual I/O |
| **Thread** | New `v8::Isolate` on OS thread | Separate (strong isolation) | Own kqueue fd + loop | CPU-bound tasks, strong memory isolation |
| **Process** | `fork(2)` + `execve(2)` new fino process | Complete isolation | Own everything | Untrusted code with crash isolation, per-request cold starts |
| **Remote** | Different machine | Complete isolation | Own everything | Distributed cloud functions |

All four levels communicate via `MessagePort` — see [messaging.md](./messaging.md).

---

## Current Architecture

The current runtime creates a single Realm implicitly:

- **`src/runtime.rs`** — creates one `v8::Isolate` and one `v8::Context`, assigns a single `MicrotaskQueue`, initializes `FinoState`
- **`src/state.rs`** — `FinoState` holds module caches (`builtin_cache`, `fs_cache`), async context slots, the microtask queue, and all JS callbacks
- **`js/runtime/loop.mts`** — module-level singleton: one kqueue/io_uring backend handle, one set of dispatch Maps
- **`js/_main.mts`** — bootstrap: installs globals, parses args, calls `driveLoop()`

The key insight: `FinoState` is already stored in the **V8 context slot** (not in a global), which means the pattern for per-Realm state is already established. Adding a second Realm means adding a second context with its own `FinoState`.

---

## Embedded Realms — Multi-Context within One Isolate

This is the VM context equivalent from roadmap §3.2.

### V8 mechanics

```rust
// In src/enclave.rs (new file)
pub fn create_realm_context(
    scope: &mut v8::HandleScope,
    capabilities: Capabilities,
    snapshot: Option<&v8::StartupData>,
) -> v8::Global<v8::Context> {
    let context = if let Some(snap) = snapshot {
        v8::Context::new_from_template(scope, snap)  // fast path
    } else {
        v8::Context::new(scope, Default::default())
    };

    let queue = v8::MicrotaskQueue::new(scope, v8::MicrotasksPolicy::Explicit);
    context.set_microtask_queue(&queue);

    let state = FinoState {
        capabilities,
        root_queue: queue,
        // ... fresh caches, etc.
    };
    context.set_slot(Rc::new(RefCell::new(state)));

    v8::Global::new(scope, context)
}
```

### Event loop integration

The parent's `step()` must also drain embedded Realm microtasks. Each iteration:

1. Call `tick(timeout)` — poll kqueue, dispatch events to the correct Realm's dispatch maps
2. Call `drainMicrotasks()` — drain parent's microtask queue
3. For each embedded Realm: call `drainMicrotasks()` on its queue (round-robin)

The parent shares its kqueue fd with embedded Realms. Each Realm's `loop.mts` instance registers its own handlers on the shared fd — events are distinguished by `(ident, filter)`. The backend handle is shared; the dispatch Maps are per-Realm.

`loop.mts` must be refactored from a process-level singleton to a per-Realm factory:

```ts
// Instead of module-level singletons:
export function createLoop(backend?: LoopBackend): Loop {
  const _raw = backend ?? defaultBackend.create();
  const _reads: Map<...> = new Map();
  // ...
  return { readable, writable, timeout, tick, alive, spin };
}
```

### Module graph isolation

Each embedded Realm gets a fresh `FinoState` with empty `builtin_cache` and `fs_cache`. V8 modules are context-bound, so builtins must be compiled into each Context — but the source text is `include_str!` static data, so only compilation cost is repeated. V8 snapshots eliminate this cost.

**Module-level singletons** (like the event loop handle in `loop.mts`) are naturally per-Realm because each Realm evaluates its own module instances with their own module-level state.

---

## Thread Realms — Multi-Isolate

This is the Worker threads equivalent from roadmap §4.2.

### V8 mechanics

V8 is single-threaded per Isolate but supports multiple Isolates in the same process (standard pattern in Node.js, Deno, Bun). Each thread:

1. Creates its own `v8::Isolate` with `v8::Isolate::new(params)`
2. Creates its own `MicrotaskQueue` and `Context`
3. Initializes its own `FinoState`
4. Runs its own instance of `runtime::run_isolate()` (extracted from `runtime::run()`)

Key constraint: `v8::Isolate` and V8 handles are not `Send`. All V8 interactions must happen on the Isolate's own thread. Communication between Isolates uses `ValueSerializer` bytes passed through Rust channels — see [messaging.md](./messaging.md).

```rust
// src/thread_realm.rs (new file)
pub fn spawn_thread_realm(config: RealmConfig) -> ThreadRealmHandle {
    let (tx, rx) = std::sync::mpsc::channel::<MessageBytes>();
    let (wake_write, wake_read) = create_pipe();

    std::thread::spawn(move || {
        let isolate = &mut v8::Isolate::new(Default::default());
        // ... full Realm bootstrap ...
        runtime::run_isolate(isolate, config, rx, wake_read);
    });

    ThreadRealmHandle { tx, wake_write }
}
```

---

## Process Realms

Fork a new fino process via `fork(2)` + `execve(2)`. The parent passes configuration via a unix socket pair on fd 3. The child bootstraps as a Realm, connects its MessagePort to the socket, and enters its event loop.

Process Realms provide the strongest isolation: crashes don't affect the parent, memory is completely separate, and the OS enforces the separation. Combined with virtual I/O, they can run fully sandboxed.

---

## Lifecycle — Structured Concurrency

Realms are owned by their creator. The parent-child relationship is strict:

- Creating a Realm returns a handle with a `MessagePort` and a `ready` Promise
- `realm.ready` resolves when the Realm's entry module finishes evaluating (TLA complete)
- `realm.terminate()` terminates the Realm gracefully (signals the loop to exit, drains pending work)
- Parent Realm termination terminates all child Realms recursively
- Realm `exit` event fires on the parent when the Realm exits (normally or on error)

This matches structured concurrency semantics: a Realm cannot outlive its parent.

---

## V8 Snapshots — Fast Realm Creation

**Problem**: Creating an embedded Realm requires re-compiling and re-evaluating all 60+ builtin TypeScript modules. This is unacceptably slow for per-request Realm creation in the cloud functions use case.

**Solution**: Create a V8 snapshot after the first Realm is fully initialized (all builtins compiled, globals installed, but before user code runs). Subsequent Realm creation restores from the snapshot instead of re-evaluating builtins.

```rust
// After first Realm initialization:
let snapshot_data: v8::StartupData = v8::Isolate::take_heap_snapshot(isolate);

// New Realm creation:
let context = v8::Context::new_from_template(scope, &snapshot_data);
```

**Design questions**:

**Q: What is included in the snapshot?**
All evaluated builtin modules and their module-level state. The event loop handle (`_raw`) must NOT be in the snapshot — it's created fresh per-Realm. This requires the loop factory pattern mentioned above.

**Q: When is the snapshot invalidated?**
The snapshot captures compiled builtin state. If builtins change (i.e., fino is rebuilt), the snapshot must be regenerated. Snapshots are stored in memory for the process lifetime, not on disk.

**Q: Can snapshots work for thread/process Realms?**
Thread Realms have their own Isolate — the snapshot would need to be regenerated per-Isolate, which is expensive. For process Realms, the fork approach is inherently snapshotted (COW memory from parent). For the cloud functions cold start use case, process Realms with fork are likely faster than snapshot-based embedded Realms.

**Spike needed**: Measure actual Realm creation time with and without snapshots. The answer determines whether snapshots are worth the complexity.

---

## Open Questions

**Q1**: Should embedded Realm microtask queues be drained round-robin after every I/O tick, or only when the Realm's MessagePort has pending messages?
- Round-robin is simpler and fairer. Demand-driven is more efficient for idle Realms.

**Q2**: Can an embedded Realm register I/O directly with the parent's kqueue fd? What happens if it calls `loop.readable(fd)` for an fd the parent also watches?
- Currently the dispatch maps key on fd number. Two Realms watching the same fd would conflict. Need either a (Realm ID, fd) key or a policy that one Realm owns each fd.

**Q3**: Should the `Realm` class (user-facing) be exported from `fino:realm`? Or is it a platform primitive that lives at a lower level?

**Q4**: How do embedded Realms interact with the `fino:profiler`? The current profiler is per-Isolate in `FinoState`. Profiling across Realms in the same Isolate needs consideration.
