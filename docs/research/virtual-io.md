# Virtual I/O — Remaining Work

## State of the Abstractions

The provider interfaces are in place:

- `FileSystem` abstract class — `js/file/provider.mts`
- `DiskFileSystem` implements it — `js/file/fs.mts`
- `NetworkProvider` abstract class — `js/net/provider.mts`
- `DnsProvider` abstract class — `js/net/dns-provider.mts`

What doesn't exist yet: the concrete virtual/restricted/memory implementations of those abstractions, and the per-Realm event loop backend.

---

## Remaining: FileSystem Implementations

```
FileSystem (exists)
  ├── DiskFileSystem         — exists
  ├── MemoryFileSystem       — in-memory Map<path, Uint8Array>
  ├── OverlayFileSystem      — copy-on-write: writable layer over a read-only base
  ├── RestrictedFileSystem   — wraps another provider; throws on unauthorized paths
  ├── ZipFileSystem          — read-only access to a zip archive in memory
  └── S3FileSystem           — reads/writes via fetch() to S3-compatible API
```

`RestrictedFileSystem` is the capability enforcement mechanism for `fs` capability (see [capabilities.md](./capabilities.md)). `MemoryFileSystem` enables fast deterministic tests. `OverlayFileSystem` enables per-Realm copy-on-write filesystem views.

---

## Remaining: NetworkProvider Implementations

```
NetworkProvider (exists)
  ├── DiskNetworkProvider      — exists (wraps current socket.mts)
  ├── VirtualNetworkProvider   — in-memory channels between Realms
  └── RestrictedNetworkProvider — wraps another provider; throws on disallowed hosts
```

`RestrictedNetworkProvider` enforces the `net` capability. `VirtualNetworkProvider` enables inter-Realm networking without real sockets.

### VirtualNetwork topology

The orchestrator creates a `VirtualNetwork` and assigns provider instances to Realms:

```ts
const net = new VirtualNetwork();
const realmA = new Realm({ module: './svc-a.mts', network: net.provider('10.0.0.1') });
const realmB = new Realm({ module: './svc-b.mts', network: net.provider('10.0.0.2') });
```

`VirtualNetwork` manages a routing table. When Realm B connects to `10.0.0.1:8080`, the `VirtualNetwork` pairs that outgoing stream with Realm A's accepted connection via in-memory channels. For embedded Realms (same thread) these are synchronous queues woken via the event loop; for thread Realms, Rust channels with wake pipes.

### TLS in virtual networks

OpenSSL uses `SSL_set_fd()` — it is coupled to real fds. Virtual sockets have no fds. Options:

1. **Memory BIOs** (`BIO_new_mem_buf` / `BIO_s_mem`): OpenSSL in memory with custom BIOs. Requires additional FFI wiring.
2. **Skip TLS for intra-process**: Connections within the same process are inherently trusted.

Starting with (2); (1) is a later option for scenarios requiring mutual identity verification between Realms.

---

## Remaining: DnsProvider Implementations

```
DnsProvider (exists)
  ├── SystemDnsProvider    — exists (current Resolver implementation)
  ├── StaticDnsProvider    — configurable Map<hostname, ip[]>
  ├── VirtualDnsProvider   — resolves within VirtualNetwork routing table
  └── RestrictedDnsProvider — allowlist/blocklist wrapping another provider
```

`VirtualDnsProvider` closes the service discovery loop: `fetch('http://service-a/')` resolves `service-a` to its virtual IP via the routing table, then the virtual network routes the connection.

---

## Remaining: Per-Realm Event Loop Backend

`loop.mts` is currently a process-wide singleton (one kqueue/io_uring handle for all Realms). This works as long as each fd is owned by exactly one Realm, but prevents giving a Realm a fully virtual event loop.

### Step 1: per-Realm loop factory

```ts
export function createLoop(backend?: LoopBackend): Loop
```

The default backend is the shared kqueue/io_uring handle. Each embedded Realm gets its own `Loop` instance wrapping that shared handle; they all register on the same kqueue fd but have separate dispatch maps.

### Step 2: virtual backend

For Realms that use only virtual I/O, a virtual loop backend avoids system calls entirely:

```ts
class VirtualLoopBackend implements LoopBackend {
  wait(handle, timeoutMs): LoopEvent[] {
    return handle.drainReady(); // returns synthetic events for ready virtual resources
  }
}
```

Virtual providers call `handle.notifyReady(ident)` when data is available, queuing a synthetic event. No kernel involvement.

### Practical hybrid

For Realms mixing real and virtual I/O: a single wake pipe per Realm. Virtual providers write a byte to the pipe; the real kqueue wakes; the loop drains virtual readiness. One real fd per Realm, not per virtual resource.

---

## Remaining: Provider Access in Modules

Currently `DiskFileSystem`, `DiskNetworkProvider`, and `SystemDnsProvider` are module-level singletons. For the provider abstraction to be usable by userland modules (`fino:file`, `fino:net/socket`, DNS), they need to receive their provider from the Realm rather than constructing one directly.

The cleanest approach (option b): Realm-scoped provider accessors via `fino:realm/self`:

```ts
import { fs, network, dns } from 'fino:realm/self';
```

Internal modules use the same accessor. `DiskFileSystem` etc. become the defaults when no provider override is set.

---

## Incremental Path (remaining steps)

1. Make `loop.mts` a per-Realm factory; thread the loop instance through each Realm's context.
2. Implement `MemoryFileSystem` — proves the `FileSystem` abstraction end-to-end; enables fast deterministic tests.
3. Implement `RestrictedFileSystem` and `RestrictedNetworkProvider` — capability enforcement (see capabilities.md).
4. Implement `VirtualNetworkProvider` + `VirtualNetwork` — inter-Realm networking.
5. Implement `OverlayFileSystem` — per-Realm copy-on-write filesystem layer.
6. Wire provider accessors in `fino:realm/self`; refactor `fino:file`, `fino:net/*`, DNS to use them.
7. `StaticDnsProvider` / `VirtualDnsProvider` — after VirtualNetwork exists.
8. `ZipFileSystem`, `S3FileSystem` — user code built on the `FileSystem` interface.

---

## Open Questions

**Q-VIO-1**: For the provider accessor approach (`import { fs } from 'fino:realm/self'`), how does a module that's a static builtin get the Realm's provider? Options:
- (a) Passed as argument: `readFile(path, { fs })` — explicit but verbose at every call site
- (b) Realm-scoped import: `import { fs } from 'fino:realm/self'` — clean, but requires module evaluation to see the live provider
- (c) Injected before evaluation: provider variable set on the context before the module body runs

Option (b) is cleanest for module authors. Whether V8's module evaluation order makes this safe needs verification.

**Q-VIO-2**: For the virtual network connection handshake, what happens when Realm B calls `connect()` before Realm A has called `accept()`?
- Synchronous pairing: `connect()` blocks until `accept()` picks it up
- Buffered: connection is established immediately; bytes buffer until accepted

**Q-VIO-3**: When a virtual socket's peer Realm terminates mid-connection, the surviving Realm should see EOF (graceful) or ECONNRESET (crash). The `VirtualNetwork` must propagate the termination event to open connections.

**Q-VIO-4**: Can an `OverlayFileSystem` flush its writable layer to the base? Useful for stateful functions that want to persist writes across invocations.

**Q-VIO-5**: For `VirtualDnsProvider`, does a Realm have a stable name (e.g. `service-a`) at creation time, or only a virtual IP? Names are more stable across restarts; IPs are simpler. Both could be supported via the routing table.
