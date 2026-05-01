# Cluster — Architecture

## Overview

The cluster model extends fino's realm hierarchy across OS process boundaries and network nodes. The design draws from the BEAM VM: Realms behave like actors — lightweight, independently failing, recursively owned — and the runtime handles the distribution transparently so application code reads the same regardless of where a child Realm actually runs.

Three new realm types complement the existing embedded and thread realms:

| Type | Isolation | IPC |
|---|---|---|
| **Process** | Separate OS process | Unix socketpair |
| **Remote** | Separate machine | Cluster protocol over WebSocket / QUIC |

Underpinning all of them is a **generic import rule system** that replaces the current `providers` map and becomes the single surface for sandboxing, module remapping, and RPC-backed virtual I/O.

---

## Generic Import Rule System

Every module resolution in a Realm passes through a per-realm **import rule list** — an ordered sequence of `(from?, pattern, directive)` triples evaluated with **last-match-wins** semantics. The last rule whose pattern matches the import wins. This lets the rule list be written with a broad wildcard first (the default) followed by specific overrides that punch exceptions:

```ts
[
  { pattern: '*',                 directive: 'block'   },   // default: deny all
  { pattern: 'fino:file',         directive: fileFacade },  // override: virtual FS
  { pattern: 'fino:runtime/loop', directive: 'inherit' },   // override: allow event loop
]
```

### Five directives

| Directive | Meaning |
|---|---|
| `inherit` | Use whatever rule the parent has for this specifier. Root realm: built-in default. |
| `block` | Refuse to resolve — throws `ImportError`. |
| `remap(target)` | Resolve as if the import said `target` instead. |
| `source(code, map)` | Compile and use this JS source as the module. |
| `facade(spec)` | Generate a synthetic RPC-proxy module backed by the parent's live implementation. |

`source` is retained because it enables **self-contained deployment**: a remote child's module code travels inside the spawn configuration with no separate file transfer required.

### Pattern syntax

| Form | Example | Matches |
|---|---|---|
| Exact | `"fino:ffi"` | Only that specifier |
| Prefix | `"fino:*"` | Any specifier starting with `"fino:"` |
| Catch-all | `"*"` | Everything |

### The `from` clause: per-module access control

An optional `from` pattern restricts a rule to apply only when a specific module is doing the importing:

```ts
type ImportRule = {
  from?:     string;          // which module is importing (absent = all)
  pattern:   string;          // what is being imported
  directive: ImportDirective;
};
```

This unifies realm-level and per-module import control into one mechanism with one data shape, supporting all five directives in both dimensions. A specific module can have its own `remap`, `facade`, `block`, or `source` for any specifier, independently of what other modules in the same Realm see.

Example: only the cluster transport module may import `internal:net/socket`:

```ts
[
  { pattern: '*',                        directive: 'inherit' },
  { from: '*',    pattern: 'internal:net/socket', directive: 'block' },
  { from: 'internal:cluster/*', pattern: 'internal:net/socket', directive: 'inherit' },
]
```

### Convenience constructors

```ts
ImportMap.deny([...overrides])    // baseline: block; overrides layer specific allows
ImportMap.inherit([...overrides]) // baseline: inherit; overrides layer specific restrictions
```

### Security: capability narrowing and the inheritance model

The default for any unspecified entry is `inherit`, which copies the parent's resolved rule. There is no "fall through to built-in" escape for child realms — only the root realm's `inherit` resolves to the built-in default.

At realm creation time the runtime validates each child directive against the parent's resolved rule for the same specifier. A child cannot use `inherit`, `remap`, or `source` to gain access to something the parent has blocked. `facade` is always safe — it only creates an RPC adapter, not real access. A child can never be less restricted than its parent.

### Rust representation

```rust
pub struct ImportRule {
    pub from:      Option<ImportPattern>,
    pub pattern:   ImportPattern,            // Exact | Prefix | CatchAll
    pub directive: ImportDirective,
}

pub enum ImportDirective {
    Inherit,
    Block,
    Remap(String),
    Source { code: String, source_map: String },
    Facade(FacadeSpec),
}

// Replaces FinoState.providers: HashMap<…>
pub import_rules: Vec<ImportRule>
```

---

## Facade Module Mechanism

A **Facade** lets a parent realm define an interface that it implements. The child's imports of the named specifier resolve to a synthetic proxy that forwards all calls to the parent's live handlers over a back-channel. The child's code is transport-agnostic — it sees a normal ES module.

### FacadeSpec

```rust
pub struct FacadeSpec {
    pub specifier: String,       // which module is replaced, e.g. "fino:file"
    pub exports:   Vec<String>,  // exported function names — all treated as async
}
```

The spec is serialised into `SpawnConfig` at realm creation time. For remote realms it travels with the `SPAWN` cluster message so the target node can build the proxy synthetic module before the entry module's first import — no lazy construction, no race.

### Generated proxy (Rust-side synthetic module)

The proxy is a Rust-created synthetic V8 module. Its evaluation callback invokes the `internal:parent-rpc` mechanism directly — no ES module imports, no JS source code. Facade modules are **not** inserted into `builtin_script_ids`, so they have no `internal:*` access. A facade is an RPC adapter; it cannot be used to escalate privilege.

### `internal:parent-rpc` — the unified back-channel

One internal module, four transports selected at spawn time:

| Realm type | Transport |
|---|---|
| Embedded | `MessagePort` |
| Thread | `ThreadPort` / mpsc + wake-pipe |
| Process | Unix socketpair IPC |
| Remote | Cluster `RPC_REQ` / `RPC_RES` |

### RPC wire format (V8 ValueSerializer payloads)

```ts
// child → parent
{ __rpc_req: true;   specifier: string; method: string; reqId: number; args: Uint8Array }

// parent → child
{ __rpc_res: true;   reqId: number; result?: Uint8Array; error?: string }

// streaming (file reads, chunked bodies)
{ __rpc_chunk: true; reqId: number; chunk: Uint8Array }
{ __rpc_end:   true; reqId: number }
{ __rpc_err:   true; reqId: number; error: string }
```

### Parent-side API sketch

```ts
import { Facade, ImportMap } from 'fino:realm';

// Option A — bind an existing object
const facade = Facade.from(myFileSystem, { specifier: 'fino:file' });

// Option B — explicit handler registration
const facade = new Facade('fino:file', ['readFile', 'writeFile', 'stat']);
facade.handle('readFile', async (path) => myFileSystem.readFile(path));

const realm = new Realm({
  module: './worker.mts',
  overrides: ImportMap.deny([
    { pattern: 'fino:file',         directive: facade   },
    { pattern: 'fino:runtime/loop', directive: 'inherit' },
  ]),
});
```

---

## Process Realms

Process Realms provide hard crash isolation: a child crash cannot corrupt the parent's heap, and the OS enforces I/O separation.

**IPC**: `socketpair(AF_UNIX, SOCK_STREAM, 0)` before `fork()`. Parent keeps `fd[0]`, child keeps `fd[1]`. After fork the child execs `fino --realm-child <fd>`, reads `SpawnConfig` (entry path, serialised import rules including any `source` and `FacadeSpec` entries, capabilities) from the socket, and runs the bootstrap.

**Message framing**: 4-byte big-endian length prefix + `ThreadMessage` payload — identical to the thread realm wire format. The existing serialiser and deserialiser are reused without change.

**Event loop integration**: The parent registers the socket fd with `loop.readable()`, exactly like a thread realm's wake-pipe. Crash detection via `EVFILT_PROC` (macOS) or `pidfd` + `io_uring POLL` (Linux) on the child PID.

**JS API**: `process: true` flag on `RealmOptions` (parallel to `thread: true`).

**`main.rs`**: A new `--realm-child <fd>` entry path reads `SpawnConfig`, skips the CLI, and enters the bootstrap.

---

## Cluster Realms

### Node roles

All nodes are peers. One node acts as the **seed** (coordinator); the others are **workers**. Any node can spawn realms onto any other node. The seed maintains the authoritative cluster membership table and realm ownership tree.

### Topology

The seed handles **discovery, cataloging, and data-plane routing** in v1. All messages (control plane: SPAWN/ACK/TERMINATE, and data plane: PORT_MSG) are routed through the seed. This keeps the implementation simple and correct.

**Planned optimization (deferred):** once a peer connection is established via `PEER_UP`, nodes will open a direct WebSocket connection to each other and route PORT_MSG directly without going through the seed. This removes the seed as a bottleneck and SPOF for data-plane traffic.

A single seed suffices for now; election/promotion is deferred.

### Transport abstraction

All cluster logic is written against `ClusterTransport`. Swapping the underlying protocol requires no changes to the cluster layer.

```ts
interface ClusterTransport {
  readonly nodeId: string;
  send(to: string, msg: ClusterMessage): void;
  broadcast(msg: ClusterMessage): void;   // seed only
  on(handler: (from: string, msg: ClusterMessage) => void): void;
  close(): void;
}

class WebSocketTransport implements ClusterTransport { ... }   // initial implementation
class QuicTransport        implements ClusterTransport { ... } // future
```

### Cluster protocol (JSON)

```ts
type ClusterMessage =
  // membership
  | { t: 'HELLO';      nodeId: string; load: NodeLoad }
  | { t: 'WELCOME';    nodeId: string; peers: PeerInfo[] }
  | { t: 'PEER_UP';    peer: PeerInfo }
  | { t: 'PEER_DOWN';  nodeId: string }
  | { t: 'HEARTBEAT';  ts: number }
  // realm lifecycle
  | { t: 'SPAWN';     spawnReqId: string; parentPortId: string; config: SerializedSpawnConfig }
  | { t: 'SPAWN_ACK'; spawnReqId: string; childPortId: string; ok: boolean; error?: string }
  | { t: 'REALM_EXIT'; realmId: string; error?: string }
  | { t: 'TERMINATE';  realmId: string }
  // data plane — RPC is tunneled inside PORT_MSG payloads (no separate RPC_REQ/RPC_RES)
  | { t: 'PORT_MSG'; fromPort: string; toPort: string; payload: string }; // base64 V8 bytes
```

`SerializedSpawnConfig` carries the entry path and the full import rule list, including any `FacadeSpec` entries and inlined `source` modules, so the receiving node has everything it needs to start the realm without reaching back to the spawning node.

**Port IDs** use the format `{nodeId}/p-{handle}` (parent side) or `{nodeId}/{handle}` (child side) and are used for PORT_MSG routing. The seed maintains a `portId → nodeId` map for routing. RPC_REQ/RPC_RES from earlier designs are tunneled inside PORT_MSG payloads — the `__rpc_req`/`__rpc_res` objects are embedded in the base64 payload and handled at the endpoints, keeping the routing layer transparent.

### Port IDs

`{nodeId}/{suffix}` — globally unique, encodes the host node for O(1) seed routing.

### Public cluster API

```ts
import { startCluster, joinCluster } from 'fino:cluster';

// First node: starts the seed server and participates as a worker
await startCluster({ port: 9999 });

// Worker nodes: connect to the seed and accept realm spawns
await joinCluster({ seed: 'ws://coordinator:9999' });

// Spawn a remote realm from any node in the cluster
const realm = new Realm({ module: './fn.mts', remote: true });
await realm.call(args);
```

When a node calls `joinCluster` without running any application code, it acts as a pure execution target — accepting realm spawns and hosting them indefinitely.

---

## Structured Concurrency Across Nodes

The seed maintains a realm ownership tree. Every realm records its parent's ID at spawn time. Death propagates top-down:

1. **Graceful termination**: the dying realm sends `TERMINATE` for each of its direct children before exiting. Each child does the same, recursively.
2. **Node crash**: the seed detects a disconnected node and emits `TERMINATE` for every realm whose parent was on that node. Host nodes execute local termination and propagate downward.
3. **Heartbeat timeout**: if a node misses heartbeats for longer than a configurable threshold (default 5 s), the seed treats it as crashed and applies the crash path.

A realm that receives `TERMINATE` while it has active children always terminates its children first — the ownership tree unwinds depth-first.

---

## Facade Unification Across Realm Types

The same `Facade` API and `FacadeSpec` wire format work identically for all realm types. The only difference is which transport `internal:parent-rpc` uses underneath:

| Scenario | Transport | Facade proxy built |
|---|---|---|
| Embedded child | `MessagePort` | At create time (synchronous) |
| Thread child | `ThreadPort` + wake-pipe | At create time |
| Process child | Unix socketpair | At create time |
| Remote child | Cluster `RPC_REQ`/`RPC_RES` | At spawn time on the remote node, from `FacadeSpec` in `SerializedSpawnConfig` |

Virtual `FileSystem`, virtual `NetworkProvider`, custom loop delegation (from `virtual-io.md`), inter-realm streaming, and synthetic service-to-service connections are all applications of this one mechanism.

---

## Multi-Tenancy

| Isolation level | Heap | I/O | Crash | Minimum realm type for hard tenancy |
|---|---|---|---|---|
| Embedded | shared | import-rule boundary | none | Not suitable for untrusted code |
| Thread | separate Isolate | import-rule (strong) | partial | Suitable for trusted code |
| Process | separate process | OS boundary | full | ✓ |
| Remote | separate machine | OS + network | full | ✓ |

For multi-tenant deployments each tenant's root realm must be a **Process** or **Remote** realm. Capability narrowing ensures a tenant cannot spawn a child with more access than it has itself.

A typical fully-sandboxed tenant root:

```ts
// No real I/O; only the event loop and tenant-specific virtual providers pass through
const tenantRealm = new Realm({
  module: './tenant-entry.mts',
  process: true,
  overrides: ImportMap.deny([
    { pattern: 'fino:file',         directive: Facade.from(tenantFs)  },
    { pattern: 'fino:net/*',        directive: Facade.from(tenantNet) },
    { pattern: 'fino:runtime/loop', directive: 'inherit' },
    { pattern: 'fino:runtime/context', directive: 'inherit' },
  ]),
});
```

Within the tenant's own realm tree, the same import rule list propagates by inheritance. The tenant's children cannot escape the sandbox the tenant itself was given.

Per-module `from` rules can further restrict what individual modules within the tenant see — e.g., ensuring that even a legitimate builtin the tenant is allowed to import cannot transitively reach a blocked specifier.

---

## Open Questions

**Q-CLUS-1**: Seed election and cluster resilience. Deferred — single seed is acceptable for now. Revisit alongside auth (Q-CLUS-5) when both are ready to tackle together.

**Q-CLUS-5**: Cluster authentication. Deferred alongside seed election.
