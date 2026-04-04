# Capabilities — Security Model

## Overview

A Realm's capabilities are the set of privileged operations it is permitted to perform. Capabilities are enforced through the I/O provider layer (see [virtual-io.md](./virtual-io.md)) — restricted providers throw on unauthorized operations exactly as the OS would, so the Realm's code sees normal `EACCES` / `EPERM` errors rather than a distinct "permission denied" message.

This is not a separate permission check layer bolted on top of the I/O API. It is the implementation of the I/O providers themselves. A `RestrictedFileSystem(inner, ['/app/data'])` is just a filesystem that happens to return `EACCES` for paths outside `/app/data`. A `RestrictedNetworkProvider(inner, ['api.example.com'])` is just a network provider that returns `EACCES` for connections to other hosts.

The consequence: **capabilities are only as strong as the isolation level of the Realm**. In a process or remote Realm, the provider is the only way to reach the OS — restricted providers are a hard boundary. In an embedded Realm (same V8 Isolate), a sufficiently motivated attacker could call the underlying FFI directly through the shared heap. Embedded Realms are therefore suitable for trusted code (plugins, test isolation, SSR) where the restriction is a convenience boundary, not a security boundary.

---

## Capability Set

```ts
interface RealmCapabilities {
  /** Allow dlopen() and direct FFI access. Default: false */
  ffi: boolean;

  /**
   * Filesystem access.
   * - true: unrestricted DiskFileSystem
   * - false: no DiskFileSystem (MemoryFileSystem or VirtualFS only)
   * - string[]: DiskFileSystem wrapped in RestrictedFileSystem with these path prefixes
   */
  fs: boolean | string[];

  /**
   * Network access.
   * - true: unrestricted DiskNetworkProvider
   * - false: no real network (VirtualNetworkProvider only, or no network)
   * - string[]: DiskNetworkProvider wrapped in RestrictedNetworkProvider with these host patterns
   */
  net: boolean | string[];

  /** Environment variable access. true = all, string[] = key allowlist, false = none */
  env: boolean | string[];

  /** Allow spawning child processes. Default: false */
  spawn: boolean;

  /** Allow creating sub-Realms. Default: true (sub-Realms inherit narrowed capabilities) */
  realm: boolean;
}
```

The **default** for an untrusted cloud function Realm: `ffi: false`, `net: false`, `fs: false`, `spawn: false`, `realm: false`. The only I/O is through virtual providers injected by the orchestrator.

The **orchestrator** runs with full capabilities — same as the current runtime.

---

## How Capabilities Map to Providers

Capabilities determine which concrete providers are constructed for a Realm:

| Capability | Provider constructed |
|---|---|
| `fs: true` | `DiskFileSystem` |
| `fs: false` | Realm receives no DiskFileSystem. If no virtual FS is provided, file operations throw. |
| `fs: ['/app']` | `RestrictedFileSystem(DiskFileSystem, ['/app'])` |
| `net: true` | `DiskNetworkProvider` |
| `net: false` | Realm receives no real NetworkProvider. If no virtual net is provided, connect/listen throw. |
| `net: ['api.example.com']` | `RestrictedNetworkProvider(DiskNetworkProvider, ['api.example.com'])` |
| `ffi: false` | `fino:ffi` module is not loadable in this Realm |
| `spawn: false` | `fino:runtime/process` is not loadable (or its spawn functions throw) |

Virtual providers (injected by the orchestrator independently of capabilities) can supplement or replace real providers:

```ts
new Realm({
  module: './fn.mts',
  capabilities: { net: false, fs: false },  // no real I/O
  fs: new OverlayFileSystem(sharedBase, new MemoryFileSystem()),  // but has a virtual FS
  network: virtualNet.provider('10.0.0.3'),  // and a virtual network interface
});
```

---

## Capability Narrowing

A child Realm can only be granted a **subset** of the parent's capabilities. Mandatory — a Realm cannot escalate privileges.

```ts
// Parent has: { net: ['api.example.com'], fs: ['/data'] }
// Child request: { net: true, fs: ['/data', '/tmp'] }
// Actual child capabilities: { net: ['api.example.com'], fs: ['/data'] }
//   (intersection: net restricted to parent's allowlist, fs uses narrower set)
```

Enforcement is in Rust at Realm creation time, before any JS runs. The `Capabilities` struct on `FinoState` is the intersection of the parent's capabilities and the child's requested capabilities. It cannot be modified at runtime.

---

## Module Gating (Hard Enforcement for FFI)

For filesystem and network capabilities, enforcement goes through providers — they throw `EACCES` on unauthorized access. For FFI and spawn, there are no provider objects to intercept. Instead, the module is simply not loadable:

```rust
// In src/loader.rs, resolve_module_callback:
if specifier == "fino:ffi" && !state.capabilities.ffi {
    return Err("Permission denied: ffi capability not granted");
}
if specifier == "fino:runtime/process" && !state.capabilities.spawn {
    return Err("Permission denied: spawn capability not granted");
}
```

This extends the existing `internal:*` access restriction pattern in `src/loader.rs` (lines ~26–42). The Rust-side resolution callback checks capabilities before returning the module.

For `fs` and `net`, modules are loadable — the restriction is in the provider, not the module loader. This is correct because the same modules (`fino:file`, `fino:net/socket`) are used with both real and virtual providers.

---

## Security Boundaries by Isolation Level

| Isolation | FS/Net restriction | FFI restriction | Security guarantee |
|---|---|---|---|
| Embedded | JS-only (shared heap can bypass) | Module gating only (shared heap) | Convenience boundary, not security |
| Thread | Separate heap, provider checked | Module gating (separate module graph) | Strong for FS/net; FFI prevented by module gating |
| Process | Separate process, provider is OS | Module gating (separate process) | Hard security boundary |
| Remote | Separate machine | Hard security boundary | Hard security boundary |

For untrusted code that must be strongly isolated, use process or remote Realms. Embedded Realms are suitable for trusted plugins, test isolation, SSR, and REPLs — situations where the author of the code is trusted but isolation is still desirable for correctness.

---

## Open Questions

**Q-CAP-1**: Should capabilities also constrain the use of `fetch()` (which uses the network provider internally)? Currently `fetch()` would respect `RestrictedNetworkProvider` automatically since it goes through the socket layer. But should there be a distinct `fetch` capability for clarity?
- Leaning: No. `fetch()` uses `NetworkProvider` — net capability covers it. No need for a separate capability.

**Q-CAP-2**: What is the granularity of `net` allowlists? Options:
- Hostname only: `['api.example.com']`
- Host + port: `['api.example.com:443']`
- CIDR: `['10.0.0.0/8']`
- All of the above, unified format

CIDR support is necessary for virtual networks where addresses are IPs. Hostname + port covers the common web API use case. A unified matcher that handles all three formats is likely the right answer.

**Q-CAP-3**: For `net: ['api.example.com']`, should DNS resolution be checked against the allowlist? If a Realm resolves `api.example.com` → `1.2.3.4` and then connects directly to `1.2.3.4`, the hostname check is bypassed.
- The allowlist should be enforced at the hostname level (before DNS), not the IP level. The `RestrictedNetworkProvider` resolves the hostname first, checks against the allowlist, then connects. Direct IP connections without a hostname are also checked against any CIDR entries in the allowlist.

**Q-CAP-4**: Should a Realm be able to inspect its own capabilities? e.g., `import { capabilities } from 'fino:realm/self'`.
- Yes — a Realm should be able to read its own capabilities to gracefully degrade or report errors. The object is read-only.

**Q-CAP-5**: Can virtual providers override capability restrictions? For example, a Realm with `net: false` but injected with `VirtualNetworkProvider` — does it get network access?
- Yes, by design. `net: false` means "no real network." A virtual network is a separate thing provided by the orchestrator. The orchestrator controls what virtual I/O the Realm gets, independently of the capabilities (which are about real OS access).
