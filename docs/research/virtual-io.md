# Virtual I/O

## Overview

A Realm's I/O layer is provided by injectable **providers**: a `FileSystem`, a `NetworkProvider`, and a `DnsProvider`. The providers are passed to the Realm at creation time. The Realm's code uses the same API regardless of what the providers are backed by — it calls `Socket.listen()`, `fs.open()`, `dns.lookup()` exactly as if it were the main thread. The providers determine what actually happens.

This transparency is the key design principle: **providers are not a restriction mechanism on top of the I/O API; they are the I/O API's implementation.** A `DiskFileSystem` reads from the local filesystem. A `MemoryFileSystem` reads from an in-memory store. A `RestrictedFileSystem` wraps another provider and throws on unauthorized paths. A Realm cannot tell which it has — it just calls `fs.open('/data/config.json')` and gets either bytes or an error.

This same mechanism is what enables capability enforcement (see [capabilities.md](./capabilities.md)): a `RestrictedNetworkProvider` that throws on connections to disallowed hosts is not a separate permission layer; it is the network provider.

---

## Current I/O Stack — The Coupling Problem

The entire I/O stack is implemented in JavaScript via `fino:ffi` (`dlopen` + libc). There are **eight or more independent `dlopen` calls at module load time** across the codebase, each binding specific syscalls:

| Module | Syscalls bound |
|---|---|
| `js/internal/stream.mts` | `read`, `write`, `writev`, `errno` |
| `js/file/bindings.mts` | `open`, `close`, `stat`, `lstat`, `fstat`, `opendir`, `readdir`, `closedir`, `mkdir`, `rmdir`, `unlink`, `rename`, `readlink`, `symlink`, `realpath`, `fchmod`, `read`, `write`, `lseek` |
| `js/net/socket.mts` | `socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `setsockopt`, `shutdown`, `fcntl`, `inet_pton`, `inet_ntop` |
| `js/internal/runtime/kqueue.mts` | `kqueue`, `kevent`, `close`, `signal` |
| `js/internal/openssl.mts` | Full OpenSSL API |
| `js/runtime/process.mts` | `fork`, `execve`, `pipe`, `dup2`, `waitpid`, `_exit` |
| `js/file/watch-bindings.mts` | File watching (kqueue EVFILT_VNODE / inotify) |
| `js/tty.mts` | `isatty`, `read` |

These are module-level constants loaded at import time. Virtualizing at the FFI level — intercepting `dlopen` to return a mock library — is impractical. The correct approach is to virtualize at the **provider level** (FileSystem, NetworkProvider, DNS), which sits above the FFI layer.

---

## Existing Abstraction Seams

Before discussing what needs to change, here is what already works in our favour:

1. **`BufferedBytesReader.doPull()` / `BufferedBytesWriter.doFlush()`** — template methods in `js/internal/stream.mts`. Explicitly designed for extension. Doc comment: *"To add a new I/O backend: extend BufferedBytesReader and implement doPull()."* Only `FdReader`/`FdWriter` are OS-coupled.

2. **`EntryFileSystem` interface** — `js/file/entry.mts` (lines 16–24) defines: `stat`, `lstat`, `open`, `entry`, `mkdir`, `rmdir`, `unlink`. All `Entry` objects delegate back to "their filesystem" via this interface.

3. **`DiskFileSystem` doc comment** — `js/file/fs.mts` explicitly says *"enables future alternative backends (in-memory, zip archive, overlay)"*.

4. **HTTP parser** — `js/net/http.mts` is pure JS operating on `BufferedBytesReader`/`BufferedBytesWriter` with no native bindings. Already decoupled from sockets.

5. **Event loop backend interface** — `create()`, `addRead()`, `addWrite()`, `addTimer()`, `wait()`, `destroy()` is a clean interface with an existing platform abstraction (kqueue vs io_uring).

---

## Virtual FileSystem

### Design

Extract an abstract `FileSystem` base class that `DiskFileSystem` implements. All file consumers (`fino:file`, the HTTP server's static file serving, DNS's resolv.conf reading, etc.) accept a `FileSystem` instead of using `DiskFileSystem` directly.

```ts
// js/file/fs.mts — abstract base, extracted from DiskFileSystem
abstract class FileSystem {
  abstract stat(path: string): Promise<Stat>;
  abstract lstat(path: string): Promise<Stat>;
  abstract open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  abstract readdir(path: string): Promise<AsyncIterable<Entry>>;
  abstract mkdir(path: string, mode?: number): Promise<void>;
  abstract rmdir(path: string): Promise<void>;
  abstract unlink(path: string): Promise<void>;
  abstract rename(src: string, dst: string): Promise<void>;
  abstract readlink(path: string): Promise<string>;
  abstract symlink(target: string, path: string): Promise<void>;
  abstract realpath(path: string): Promise<string>;
  // Convenience methods built on top (non-abstract):
  readFile(path: string): Promise<Uint8Array> { ... }
  writeFile(path: string, data: Uint8Array): Promise<void> { ... }
}

class DiskFileSystem extends FileSystem { /* current POSIX/FFI implementation */ }
```

`FileHandle` (currently `File` in `js/file/handle.mts`) is also made abstract. A disk handle wraps a raw fd; a memory handle wraps a cursor into a buffer. Both provide `reader()` → `BufferedBytesReader` and `writer()` → `BufferedBytesWriter`.

### Provider implementations

```
FileSystem (abstract)
  ├── DiskFileSystem         — real POSIX filesystem (current implementation)
  ├── MemoryFileSystem       — in-memory Map<path, Uint8Array>
  ├── S3FileSystem           — reads/writes via fetch() to S3 compatible API
  ├── ZipFileSystem          — read-only access to a zip archive in memory
  ├── OverlayFileSystem      — copy-on-write: writable layer over a read-only base
  └── RestrictedFileSystem   — wraps another provider; throws on unauthorized paths
```

**`RestrictedFileSystem`** is how path-based capability enforcement is implemented:

```ts
class RestrictedFileSystem extends FileSystem {
  #inner: FileSystem;
  #allowedPaths: string[];

  constructor(inner: FileSystem, allowedPaths: string[]) {
    this.#inner = inner;
    this.#allowedPaths = allowedPaths;
  }

  async open(path: string, flags: number): Promise<FileHandle> {
    const resolved = await this.realpath(path);
    if (!this.#allowedPaths.some(p => resolved.startsWith(p))) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
    }
    return this.#inner.open(path, flags);
  }
  // ... same pattern for all methods
}
```

This is not a separate "permission check" — it is the filesystem provider. A Realm configured with `new RestrictedFileSystem(new DiskFileSystem(), ['/app/data'])` experiences all access outside `/app/data` as `EACCES`, the same as on a real system where the process lacks permissions. No special handling needed in the Realm's code.

**`OverlayFileSystem`** enables per-Realm filesystem snapshots: a shared read-only base (e.g. the deployed function's files) with a writable per-Realm layer. Mutations in one Realm don't affect other Realms or the base.

---

## Virtual Network

### Design

A Realm with a real `NetworkProvider` calls `Socket.listen({ port: 8080 })` and gets a real TCP server on the machine. A Realm with a `VirtualNetworkProvider` calls the same API and gets a virtual server accessible to other Realms in the same virtual topology. The code does not change.

```ts
// js/net/provider.mts (new file)
abstract class NetworkProvider {
  abstract createSocket(family: AddressFamily, type: SocketType): Promise<SocketHandle>;
  abstract connect(handle: SocketHandle, addr: SocketAddress): Promise<void>;
  abstract listen(addr: SocketAddress): Promise<ServerHandle>;
  abstract accept(server: ServerHandle): AsyncIterable<SocketHandle>;
  abstract shutdown(handle: SocketHandle, how: ShutdownHow): void;
  abstract close(handle: SocketHandle): void;
  abstract getsockname(handle: SocketHandle): SocketAddress;
}

class DiskNetworkProvider extends NetworkProvider { /* wraps current socket.mts */ }
```

`SocketHandle.split()` → `[BufferedBytesReader, BufferedBytesWriter]` — same as current `Socket.split()`. For virtual sockets, these wrap in-memory byte channels instead of fd-backed streams.

### Provider implementations

```
NetworkProvider (abstract)
  ├── DiskNetworkProvider    — real POSIX sockets (current implementation)
  ├── VirtualNetworkProvider — in-memory channels between Realms
  └── RestrictedNetworkProvider — wraps another provider; throws on disallowed hosts
```

**`RestrictedNetworkProvider`** enforces network capability policies:

```ts
class RestrictedNetworkProvider extends NetworkProvider {
  async connect(handle: SocketHandle, addr: SocketAddress): Promise<void> {
    if (!this.#allowed(addr)) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return this.#inner.connect(handle, addr);
  }
}
```

Again, this is the provider, not a layer on top of it. The Realm code sees a connection error exactly as it would for a real network permission denial.

### Virtual Network Topology

The orchestrator defines a virtual network by assigning `VirtualNetworkProvider` instances to Realms with compatible routing. Realm A listening on `10.0.0.1:8080` within the virtual network can be connected to by Realm B calling `connect({ ip: '10.0.0.1', port: 8080 })` — both using their `VirtualNetworkProvider`.

Internally, a `VirtualNetwork` object manages a routing table. When Realm B connects to `10.0.0.1:8080`, the `VirtualNetwork` pairs Realm B's outgoing stream with Realm A's incoming accepted connection. Data flows through in-memory channels — for embedded Realms (same thread), these are synchronous queues woken via the event loop; for thread Realms, they're Rust channels with wake pipes.

```ts
// Orchestrator sets up virtual network:
const net = new VirtualNetwork();

const realmA = new Realm({
  module: './service-a.mts',
  network: net.provider('10.0.0.1'),  // Realm A's virtual NIC
});

const realmB = new Realm({
  module: './service-b.mts',
  network: net.provider('10.0.0.2'),  // Realm B's virtual NIC
});

// Inside service-a.mts:
import { Socket } from 'fino:net/socket';
// This starts a real server on the virtual network — Realm B can connect to it
const server = await Socket.listen({ family: 'ipv4', ip: '0.0.0.0', port: 8080 });

// Inside service-b.mts:
import { Socket } from 'fino:net/socket';
// This connects to Realm A's virtual server — no real OS socket involved
const socket = await Socket.connect({ family: 'ipv4', ip: '10.0.0.1', port: 8080 });
```

This enables cloud functions to network together without any real network traffic. An HTTP server in Realm A is a real HTTP server from Realm B's perspective — it uses `fetch()`, handles keep-alive, streams bodies — all over in-memory channels.

### TLS in virtual networks

TLS via OpenSSL uses `SSL_set_fd()` — it's coupled to real fds. Virtual network sockets don't have fds. Two options:

1. **Memory BIOs** (`BIO_new_mem_buf` / `BIO_s_mem`): OpenSSL can work entirely in memory with custom BIOs. Requires additional FFI wiring.
2. **No TLS for intra-process virtual networks**: Connections within the same process are inherently trusted. TLS is only needed for remote Realms over real networks.

Leaning toward (2) initially, with (1) as a later option for scenarios that require encryption even between Realms in the same process (e.g., verifying mutual identity).

---

## Virtual DNS

### Design

Each Realm gets a `DnsProvider`:

```ts
abstract class DnsProvider {
  abstract lookup(hostname: string, family?: 4 | 6): Promise<string[]>;
  abstract reverse(ip: string): Promise<string[]>;
}

class SystemDnsProvider extends DnsProvider { /* current Resolver implementation */ }
class StaticDnsProvider extends DnsProvider { /* configurable Map<hostname, ip[]> */ }
class VirtualDnsProvider extends DnsProvider { /* resolves within virtual network topology */ }
class RestrictedDnsProvider extends DnsProvider { /* allowlist + block list on top of another provider */ }
```

`VirtualDnsProvider` resolves Realm names to their virtual IP addresses within the `VirtualNetwork`'s routing table. This closes the loop for service discovery: Realm B can call `fetch('http://service-a/')`, DNS resolves `service-a` to `10.0.0.1`, and the virtual network routes the connection to Realm A.

DNS is the simplest I/O dimension to virtualize since `Resolver` is already a high-level pure-JS protocol implementation over UDP sockets. The refactor is: inject the provider into `Resolver` instead of using it as a process-level singleton.

---

## Virtual Event Loop Backend

### Embedded Realms — shared backend

For embedded Realms, the parent's kqueue fd is shared. Each Realm has its own dispatch Maps but registers on the same fd. This works because kqueue events are identified by `(ident, filter)`.

Convention: each fd is owned by exactly one Realm. The parent owns the accept socket; it hands accepted connection fds to the child Realm that will handle them.

`loop.mts` must be refactored from a process-level singleton to a per-Realm factory:

```ts
export function createLoop(backend?: LoopBackend): Loop {
  // backend defaults to the process-shared kqueue/io_uring handle
  // or is an explicitly provided virtual backend
}
```

### Virtual backend — for fully in-memory Realms

A Realm that uses only virtual I/O doesn't need to wake on kernel events. A virtual loop backend implements the same interface without system calls:

```ts
// js/internal/runtime/virtual-loop-backend.mts
class VirtualLoopBackend implements LoopBackend {
  wait(handle: VirtualHandle, timeoutMs: number): LoopEvent[] {
    // Check which virtual resources have pending data and return synthetic events
    return handle.drainReady();
  }
}
```

Virtual I/O providers call `handle.notifyReady(ident)` when data becomes available. This queues a synthetic event that the next `wait()` call returns. No kernel involvement.

### Hybrid — real loop + wake pipe

The more practical approach for mixed Realms (some real I/O, some virtual): a single wake pipe per Realm. Virtual providers signal readiness by writing a byte to the pipe. The real kqueue wakes, the loop dispatches the message, discovers which virtual resources are ready, and resolves their promises. One real fd per Realm, not per virtual resource.

---

## Incremental Refactoring Path

1. **Extract `FileSystem` interface** from `DiskFileSystem`. Thread it through all file consumers. No behavior change — `DiskFileSystem` is still the only implementation.

2. **Extract `NetworkProvider` interface** from `Socket`. Make `serve()`, `fetch()`, DNS accept a provider. `DiskNetworkProvider` is still the only implementation.

3. **Make `loop.mts` a per-Realm factory** — `createLoop(backend?)`. Required before embedded Realms can be created.

4. **Implement `MemoryFileSystem`** — proves the `FileSystem` abstraction end-to-end. Enables fast, deterministic tests.

5. **Implement `RestrictedFileSystem` and `RestrictedNetworkProvider`** — capability enforcement falls out naturally.

6. **Implement `VirtualNetworkProvider` + `VirtualNetwork`** — enables inter-Realm networking without real sockets.

7. **Implement `OverlayFileSystem`** — per-Realm copy-on-write filesystem layer.

8. **`S3FileSystem`** — user code built on `FileSystem` + `fetch()`. No Fino internals needed beyond the interface.

---

## Open Questions

**Q-VIO-1**: How does the `FileSystem` provider reach modules that use it? Options:
- (a) Passed as an argument to each `fino:file` function: `readFile(path, { fs })` — explicit but verbose
- (b) Stored in a Realm-scoped config, accessed via `import { fs } from 'fino:realm/self'` — clean for module authors
- (c) Injected at module evaluation time — the `DiskFileSystem` import in `fs.mts` becomes a variable set before evaluation

Option (b) is cleanest for user-facing modules. Internal modules can use a shared accessor.

**Q-VIO-2**: For the virtual network, what is the handshake when Realm B connects to Realm A's listener? The `VirtualNetwork` must coordinate the connection setup without a real TCP three-way handshake. Options:
- Synchronous pairing: `connect()` blocks until `accept()` picks it up
- Buffered: connection is established immediately, bytes buffer until accepted

**Q-VIO-3**: What happens when a virtual socket's peer Realm terminates mid-connection? The surviving Realm should see EOF (for graceful) or ECONNRESET (for crash). The `VirtualNetwork` must propagate this.

**Q-VIO-4**: Can an `OverlayFileSystem` flush its writable layer to the base? This would allow a Realm to "commit" its filesystem mutations. Useful for stateful functions that want to persist writes.

**Q-VIO-5**: For virtual DNS resolving Realm names: does the Realm have a name (like `service-a`) at creation time, or only a virtual IP? Names are more stable (survive restarts), IPs are simpler to implement. Both could be supported via the `VirtualNetwork`'s routing table.
