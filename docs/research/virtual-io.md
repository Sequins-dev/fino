# Virtual I/O — Remaining Work

## Status

The framework-level virtual I/O story has changed.  All concrete provider
implementations (`MemoryFileSystem`, `RestrictedFileSystem`,
`VirtualNetworkProvider`, etc.) and the per-Realm loop factory are **not
built into the core**.  They are userland code, implemented as Facade
handlers using `Facade.sendStream()`, `facade.stream()`, and
`FacadeHandle`.

The abstract provider interfaces remain (`FileSystem`, `NetworkProvider`,
`DnsProvider`), but they are not wired into the Realm machinery via provider
injection.  Modules that want a virtual filesystem or network import
`fino:file` / `fino:net/socket` etc., and the parent Realm's import rules
remap those specifiers to a Facade.

---

## Open design questions for VirtualNetwork via Facade

When a parent implements a virtual TCP network as a Facade on `fino:net/socket`,
several design questions arise that do not yet have canonical answers.

### Q-VIO-2. connect() before accept() semantics

When Realm B calls `connect()` before Realm A has called `accept()`, two
options:

- **Synchronous pairing**: `connect()` parks the caller until `accept()` picks
  it up.  Clean, but the child realm stalls.
- **Buffered**: connection is established immediately; data buffers until
  accepted.  More complex but avoids stalling.

Leaning toward buffered for embedded realms (same thread) where stalling would
deadlock.

### Q-VIO-3. Peer-realm termination mid-connection

When one side of a virtual socket's Realm exits, the surviving Realm should
see EOF (graceful) or an error (crash).  The Facade handler on the parent
needs to propagate the termination event to any open virtual connections.

How the parent detects the termination: via the port `close` event or the
realm's `run()` promise rejecting.

### Q-VIO-5. Realm identity in the virtual network

Does a Realm have a stable name (e.g. `service-a`) at creation time, or only
a virtual IP?  Names survive restarts; IPs are simpler to route.

Both could be supported — the routing table maps names to IPs and IPs to the
active Realm's port.  Name registration would happen at realm creation via a
Facade call to the orchestrating parent.

---

## Items no longer tracked here

The following were removed because they are now userland or resolved:

- Concrete FS implementations (Memory, Overlay, Restricted, Zip, S3) — userland Facade
- Concrete network/DNS implementations — userland Facade
- Per-Realm loop factory — not needed; child loops wait on the parent-rpc channel
- `fino:realm/self` provider accessors — replaced by import rule remapping
- Incremental implementation path — superseded by the Facade approach
- Q-VIO-1 (provider accessor strategy) — resolved: use Facade import remapping
- Q-VIO-4 (overlay flush) — userland concern; nothing to spec in core
