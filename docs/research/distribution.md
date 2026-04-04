# Distribution — Pool Model and Orchestration

## Overview

The long-term goal is a cloud functions platform where a main JS thread **orchestrates** many untrusted JS functions across a shared, distributed environment. This document describes the distribution model: how Realm pools are organized and scaled, and how the orchestrator pattern works.

---

## Realm Topology

A Realm is fully functional — it can run HTTP servers, accept TCP connections, read files, and do everything the main thread can. The virtual I/O layer determines what those operations are backed by (see [virtual-io.md](./virtual-io.md)).

This opens up two distinct deployment topologies:

**Topology A — Handler Dispatch (Stateless)**

The orchestrator Realm owns the real TCP socket. Worker Realms never see real sockets — their networking is either disabled or virtual. The orchestrator accepts connections, parses HTTP, serializes the request to a MessagePort message, dispatches to a worker, and sends the response back.

This is good for pure functions where state between requests is undesirable. Workers are simple, stateless, easily replaceable.

**Topology B — Full Realm Servers (Stateful)**

Each worker Realm runs its own HTTP server on a virtual network interface. The orchestrator routes real incoming connections into the virtual network, directing traffic to the correct Realm by hostname or path. Workers see full request/response streams via their virtual network. Workers can maintain state between requests.

This is good for stateful functions, WebSocket handlers, streaming responses, and long-lived services.

Both topologies use the same Realm and provider infrastructure. The difference is in how the orchestrator configures the virtual network.

---

## Handler Dispatch (Topology A)

The orchestrator owns TCP. Worker Realms receive serialized requests via MessagePort.

```
Client → TCP → [Orchestrator: accept + parseHttp]
                     │ postMessage
                     ▼
              [Worker Realm: handler.mts]
              onmessage = async ({ data: req }) => {
                const res = await handle(req);
                port.postMessage(res);
              }
                     │ postMessage response
                     ▼
              [Orchestrator: write(socket) → Client]
```

### What gets serialized?

The request payload sent to a worker Realm:

```ts
interface WorkerRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;         // pre-read by orchestrator
  // Optional: tracing context, request ID, etc.
}
```

The response returned by the worker:

```ts
interface WorkerResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;         // fully buffered response body
}
```

**Limitation**: Streaming request/response bodies are not supported in this model — the orchestrator must buffer the full body before dispatch, and the worker must return a complete response. For most serverless use cases this is fine. Streaming can be added later via a more complex protocol.

---

## Full Realm Servers (Topology B)

Each worker Realm runs a real server — from its own perspective — on its virtual network interface. The orchestrator connects real incoming traffic into the virtual network.

```
Client → TCP → [Orchestrator: accept socket]
                     │
          [VirtualNetwork: route to Realm by host/path]
                     │
              [Worker Realm: full HTTP server]
              // Realm sees a real connection on its virtual NIC
              serve({ port: 8080 }, async (req) => {
                return new Response(await handle(req));
              });
```

The orchestrator's virtual network acts as a reverse proxy at the byte-stream level. It accepts the real TCP connection, determines which Realm should handle it (by hostname, path prefix, etc.), and wires the real socket's read/write streams to the Realm's virtual network channel. From the Realm's perspective, it accepted a connection from a client.

This topology supports:
- **Streaming request/response bodies** — no need to buffer the entire body before dispatch
- **WebSocket upgrades** — the Realm handles the full upgrade handshake; the orchestrator just routes
- **Long-lived connections** — the Realm maintains the connection state across many messages
- **Stateful servers** — module-level state persists and is meaningful

The VirtualNetwork routing table can be static (configured at startup) or dynamic (updated while the pool is running, enabling hot-swap of Realm code).

---

## RealmPool

A `RealmPool` manages a set of local and remote workers behind a uniform interface.

```ts
// fino:realm/pool (public)

interface PoolOptions {
  module: string;                           // worker entry module
  size?: number;                            // local workers (default: navigator.hardwareConcurrency)
  realm?: RealmOptions;                     // options applied to each worker Realm
  timeout?: number;                         // dispatch timeout in ms (default: 30000)
}

class RealmPool extends EventTarget {
  constructor(options: PoolOptions);

  /**
   * Dispatch a request to an available worker.
   * Returns a Promise that resolves with the worker's response.
   * Rejects on timeout or worker failure.
   */
  dispatch<T = unknown>(message: any, transfer?: Transferable[]): Promise<T>;

  /** Add a remote worker endpoint to the pool. */
  addRemote(url: string | URL): Promise<void>;

  /** Remove a remote worker endpoint. */
  removeRemote(url: string | URL): void;

  /** Gracefully shut down all workers. */
  close(): Promise<void>;

  readonly size: number;        // total workers (local + remote)
  readonly available: number;   // currently idle workers
  readonly pending: number;     // queued dispatches waiting for a worker
}
```

### Worker entry module protocol

Workers use a simple request/response protocol over their MessagePort:

```ts
// handler.mts — worker entry module
import { port } from 'fino:realm/self';

port.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  try {
    const result = await handle(ev.data);
    port.postMessage(result);
  } catch (err) {
    port.postMessage({ error: err.message, stack: err.stack });
  }
};
```

The pool wraps each dispatch in a correlation ID to match responses to pending requests when multiple dispatches are in flight to the same worker.

---

## Dispatch Strategies

### Round-Robin (default)

Each new dispatch goes to the next worker in rotation, regardless of load. Simple and fair under uniform workload. Breaks down if some requests take much longer than others.

### Least-Loaded

Dispatch to the worker with the fewest in-flight requests. Requires the pool to track in-flight count per worker. Better under variable workload.

### Content-Based Routing

Dispatch based on message content — e.g., tenant ID, function name, URL path. Enables sticky routing (same tenant always goes to the same worker, warm cache) or fan-out (broadcast to multiple workers). More complex, but necessary for stateful function patterns.

For the initial implementation, **round-robin** is sufficient.

---

## Local vs Remote Workers

The pool treats local and remote workers identically — both are accessed via MessagePort. The difference is the transport (IntraPort/ThreadPort/PipePort for local; NetPort for remote).

### Local workers

Spawned by the pool as thread or process Realms (see [realms.md](./realms.md)). Live in the same machine. Communication is fast (Rust channels or unix sockets).

### Remote workers

Connected via WebSocket. The remote machine runs a `RealmPoolServer` — a fino process that:
1. Accepts WebSocket connections from orchestrators
2. Maintains a local pool of Realm workers
3. Routes dispatched messages to available workers
4. Returns responses over the WebSocket

From the orchestrator's perspective, a remote worker is just another entry in the pool's worker list — it speaks the same MessagePort protocol.

```
[Orchestrator Machine]              [Remote Machine]
  RealmPool                           RealmPoolServer
    ├── local worker (thread)           ├── worker Realm
    ├── local worker (thread)           ├── worker Realm
    └── NetPort ─────────────────────── └── worker Realm
         WebSocket
```

### Adding remote workers

```ts
const pool = new RealmPool({ module: './handler.mts', size: 2 });
await pool.addRemote('wss://worker-host-1.example.com:9090');
await pool.addRemote('wss://worker-host-2.example.com:9090');
// Now pool has 2 local + 2 remote workers
```

The orchestrator does not need to know whether a worker is local or remote. Dispatch is uniform.

---

## Worker Lifecycle — Warm vs Cold

### Warm workers (default)

Workers are long-lived. They start once when the pool initializes, handle many requests in sequence, and are only restarted on failure. Module-level state persists between requests.

Pros: Fast — no Realm creation overhead per request. Module-level caches (compiled routes, connection pools, etc.) survive across requests.

Cons: Module-level state can accumulate between requests (memory leaks, stale caches). A bug in one request's state can affect subsequent requests.

### Cold workers

A fresh Realm is created for each request and discarded after the response is sent. The worker module is re-evaluated on every request.

Pros: Perfect isolation between requests. No state leakage. Deterministic behavior.

Cons: Slow without V8 snapshots. With snapshots, the cost is: snapshot restore + module evaluation of user code + request handling.

**V8 Snapshots for cold start acceleration**: A snapshot of the fully-initialized Realm state (all builtins loaded, globals installed) is taken once. New cold Realms restore from the snapshot instead of re-evaluating builtins. The user's entry module is still evaluated fresh each time, but that's typically small.

See [realms.md](./realms.md) for the snapshot design.

### Hybrid pool

The pool could maintain a mix: a fixed set of warm workers for high throughput, plus a reserve of cold workers for burst or isolated execution. The pool selects based on request metadata (e.g., tenant trust level).

---

## Failure Handling

### Worker crash detection

- **Thread Realm**: Rust `JoinHandle` — if the thread panics, the handle's `join()` returns an error. The pool's Rust side monitors thread health.
- **Process Realm**: `EVFILT_PROC` (macOS) / `pidfd` (Linux) — the event loop detects process exit. The pool's JS side receives an `exit` event on the Realm object.
- **Remote worker**: WebSocket disconnect — the NetPort's EventTarget fires a `close` event.

In all cases, the pool marks the worker as unavailable and spawns a replacement.

### In-flight request handling

If a worker crashes while handling a request, the pending `dispatch()` Promise rejects with an error. The pool surfaces the rejection to the caller. The pool does **not** transparently retry — retrying could cause duplicate side effects if the handler was partially executed.

The caller can implement retry logic at the application level.

### Graceful shutdown

`pool.close()`:
1. Stops accepting new dispatches (pending calls reject with `PoolClosedError`)
2. Waits for all in-flight requests to complete (up to a configurable drain timeout)
3. Sends termination signals to all workers
4. Waits for all workers to exit

---

## Sub-Orchestrator Pattern (Future)

The initial design uses a centralized orchestrator. A future optimization: remote workers run their own sub-orchestrators with local Realm pools. The central orchestrator dispatches to remote sub-orchestrators, which route to their local workers.

```
[Central Orchestrator]
       │
       ├── dispatch ──► [Remote Sub-Orchestrator A] ──► worker, worker, worker
       └── dispatch ──► [Remote Sub-Orchestrator B] ──► worker, worker, worker
```

This reduces the central orchestrator's hot path (no serialization overhead for routing within a remote machine) and enables hierarchical scaling. It's a later optimization — the flat model is simpler to reason about and implement first.

---

## Open Questions

**Q-DIST-1**: Should `pool.addRemote()` authenticate the connection? If so: shared secret, mTLS, or signed JWT?
- The connection is over TLS (WebSocket Secure). Authentication adds another layer. Shared secret is simplest for initial implementation. mTLS is better for production.

**Q-DIST-2**: Should the pool expose health metrics? e.g., worker queue depth, request latency percentiles, error rates.
- Yes, eventually. This integrates with `fino:telemetry` (OTel). Not needed for the initial pool implementation.

**Q-DIST-3**: How should the pool handle slow workers? A worker that takes 60 seconds while others finish in milliseconds starves the pool.
- Timeout per dispatch (the `timeout` option). After the deadline, the pool rejects the dispatch Promise. The worker's Realm is not terminated — the next dispatch goes to an available worker.
- More sophisticated: the pool tracks per-worker latency and can route away from consistently slow workers.

**Q-DIST-4**: Can a pool worker itself create a sub-pool? Workers have the `realm` capability by default (can create sub-Realms). A worker could spawn its own workers for recursive parallelism.
- This should work naturally since Realms nest. The sub-pool uses the same dispatch protocol. No special handling needed.

**Q-DIST-5**: Should the pool support priority queues? Some requests (interactive user requests vs background batch jobs) have different urgency.
- Not in the initial design. Application-level prioritization can be achieved by using separate pools.
