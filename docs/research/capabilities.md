# Capabilities — Remaining Work

## Overview

A Realm's capabilities are the set of privileged operations it is permitted to perform. Enforcement goes through the I/O provider layer — restricted providers throw on unauthorized operations exactly as the OS would (`EACCES`/`EPERM`), so Realm code sees normal errors rather than a distinct permission message.

Capabilities are only as strong as the isolation level. In a process or remote Realm, the provider is the only path to the OS — a restricted provider is a hard boundary. In an embedded Realm (shared V8 heap), a sufficiently motivated attacker can call FFI directly. Embedded Realms are for trusted code (plugins, test isolation, SSR); process/remote Realms are for untrusted code.

---

## Capability Interface

```ts
interface RealmCapabilities {
  /** Allow dlopen() and direct FFI access. Default: false */
  ffi: boolean;

  /**
   * Filesystem access.
   * - true: unrestricted DiskFileSystem
   * - false: no DiskFileSystem
   * - string[]: DiskFileSystem wrapped in RestrictedFileSystem with these path prefixes
   */
  fs: boolean | string[];

  /**
   * Network access.
   * - true: unrestricted
   * - false: no real network
   * - string[]: restricted to these host patterns
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

Default for an untrusted cloud function: `ffi: false`, `net: false`, `fs: false`, `spawn: false`, `realm: false`.

---

## What Needs to Be Built

### 1. Capabilities struct in FinoState

Add a `Capabilities` struct to `FinoState`. At child Realm creation, compute the intersection of the parent's capabilities and the requested capabilities (capability narrowing — a child cannot escalate). This must happen in Rust before any JS runs.

### 2. Module Gating

For `ffi` and `spawn`, there are no provider objects to intercept — the module itself must be blocked. The existing mechanism is the `providers` map: setting a provider entry to `None` blocks the specifier from loading in user code. This is already used for provider overrides. Capability enforcement should use the same hook:

```rust
// In realm creation, after intersecting capabilities:
if !capabilities.ffi {
    child_providers.insert("fino:ffi".to_string(), None);
}
if !capabilities.spawn {
    child_providers.insert("fino:runtime/process".to_string(), None);
}
```

### 3. Restricted Providers

`RestrictedFileSystem` and `RestrictedNetworkProvider` need to be implemented (see [virtual-io.md](./virtual-io.md)). Capability enforcement for `fs` and `net` falls out naturally once these exist:

- `fs: ['/app']` → `RestrictedFileSystem(DiskFileSystem, ['/app'])` as the realm's provider
- `net: ['api.example.com']` → `RestrictedNetworkProvider(DiskNetworkProvider, ['api.example.com'])`

### 4. Self-inspection

A Realm should be able to read its own capabilities:

```ts
import { capabilities } from 'fino:realm/self';
// returns a read-only RealmCapabilities object
```

---

## Open Questions

**Q-CAP-2**: What is the format for `net` allowlist entries? Options:
- Hostname only: `['api.example.com']`
- Host + port: `['api.example.com:443']`
- CIDR block: `['10.0.0.0/8']`
- All of the above in a unified matcher

CIDR support is needed for virtual networks where addresses are IPs. A unified matcher handling all three formats is likely the right answer.
