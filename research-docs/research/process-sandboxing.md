# Child Process Containment

> Goal: make child processes launched by `fino:process` containable by
> default-deny, OS-enforced policy, while preserving the normal `Process`
> contract: piped stdio, `pid`, `kill()`, `wait()`, cwd/env support, and clear
> spawn-time errors.

This document is specifically about **child process containment**. It is not
about realm import rules, reactor-realm isolation, code-generation product
surfaces, or broad multi-tenant runtime architecture.

The unit being contained is a native child process launched by:

```ts
new Process(command, args, { sandbox });
```

The parent is the fino runtime process. The child may be a normal Unix program,
a shell command, a helper binary, an interpreter, or a future process-backed
runtime worker. The containment boundary must be established before the child
executes user-controlled code.

The two workloads that motivate this are agent `bash` tool calls (a model given
a shell it should not be able to escape) and the scheduler spawning untrusted
services or process realms. Both need a boundary that holds against a hostile
subprocess, not merely a reporting layer.

## 1. Target Contract

The intended API is:

```ts
const proc = new Process("/usr/bin/tool", ["--input", "job.json"], {
  cwd: workDir,
  env: { PATH: "/usr/bin:/bin" },
  sandbox: {
    mode: "strict",
    resources: { memoryBytes: 256 * 1024 * 1024, pids: 16 },
    filesystem: { readonly: ["/usr", "/bin"], writable: [workDir] },
    network: { outbound: [{ action: "deny", destination: "*" }] },
    process: { allowFork: false, allowedBinaries: ["/usr/bin/tool"] },
    syscalls: { mode: "denylist", names: ["ptrace", "bpf"] }
  }
});
```

Strict mode means:

- requested policy is enforced before child code runs;
- unsupported requested policy throws before spawn;
- the runtime never silently falls back to an unsandboxed spawn;
- stdio pipes still work;
- `wait()` still reaps the child through the existing platform wait path;
- `sandboxReport` describes what backend was selected and what was enforced.

Best-effort mode means:

- the process may spawn without a security boundary;
- the report explains what was not enforced;
- callers must not treat it as containment.

## 2. Why This Exists

fino already has an ergonomic child process API. The missing capability is
trustworthy containment for commands that are useful but not fully trusted:

- shell commands issued by an agent through a `bash` tool;
- user-supplied scripts run through `/bin/sh`, Python, or another interpreter;
- compiler, formatter, linter, and build helper subprocesses;
- conversion tools and native CLIs;
- local model or data-processing helpers;
- third-party binaries invoked by higher-level fino modules;
- process-backed realms the scheduler spawns from untrusted code.

The containment problem is: a subprocess is not a JS object. Once it execs, it
can use libc, direct syscalls, dynamically loaded libraries, and helper
processes. JS-level wrappers cannot reliably constrain it. The OS must enforce
the boundary.

## 3. Threat Model

The child process may try to:

- read host files outside its input set;
- write outside its output directory;
- open network sockets;
- bind/listen for inbound connections;
- fork recursively;
- exec another binary;
- call dangerous syscalls such as `ptrace` or `bpf`;
- exceed memory, pid, or CPU budget;
- keep descendants alive after the direct child exits;
- crash, hang, or emit large stdout/stderr.

Containment should protect the parent runtime and the host policy boundary
from those behaviors.

Containment does not attempt to solve:

- kernel vulnerabilities;
- side channels;
- malicious behavior through resources explicitly granted to the child;
- perfect cross-OS semantic equivalence;
- replacing full containers or microVMs for workloads that require those.

## 4. Direction

The whole sandbox is established **inside the fino process**, by fino, on the
child it is about to run — before that child executes user-controlled code.
There is no separate privileged daemon and no eBPF in the core. This keeps the
architecture coherent with fino's "thin Rust, single process" model, and it is
complete for the threat model above: filesystem confinement, binary
allowlisting, syscall policy, fork control, resource limits, and descendant
cleanup are all reachable with unprivileged, in-process mechanisms.

The mechanisms, one per concern:

- **Filesystem confinement and binary allowlisting** use Landlock, including the
  `LANDLOCK_ACCESS_FS_EXECUTE` right. Execute is granted only on allowlisted
  paths, so `process.allowExec` and `process.allowedBinaries` become real
  kernel-enforced policy rather than a spawn-time name check. Landlock is
  unprivileged and needs no namespace. A stronger filesystem *view* (bind
  mounts, hidden paths, a private root) is available through a mount namespace
  when a workload needs it, but Landlock alone covers the agent-`bash` case.

- **Syscalls, fork control, and coarse network denial** use seccomp-BPF.

- **Resources (cpu, memory, pids) and reliable descendant cleanup** use a
  per-spawn cgroup v2 that the child joins; `cgroup.kill` reaps the whole tree.
  This needs a **delegated cgroup** — a subtree fino may write to, provided by
  systemd delegation, running as root, or an explicit `FINO_SANDBOX_CGROUP_ROOT`
  — not a daemon. Where no delegated cgroup exists, memory and pids fall back to
  rlimits and descendant containment falls back to a PID namespace (child as
  pid 1) or a process group. These fallback tiers are reported honestly, not
  presented as equivalent.

- **Stronger isolation (pid, ipc, mount, and user namespaces)** is created by
  the child unsharing them itself through **unprivileged user namespaces** — the
  same mechanism rootless containers use. Where a host disables unprivileged
  user namespaces, the namespace tiers fail closed and Landlock still provides
  filesystem confinement, so the system degrades cleanly rather than silently
  weakening.

macOS is capability-based on Seatbelt (§6). Where the host cannot apply the
required policy, strict mode fails closed.

### Implementation shape: TypeScript over FFI, thin native

Today the sandbox lives almost entirely in native Rust (`src/sandbox.rs`, on the
order of 4,700 lines). The direction moves the bulk of that logic into
TypeScript, calling the kernel through FFI, consistent with the rest of fino.

There is exactly one hard constraint that dictates the shape: **JavaScript
cannot run between `fork()` and `execve()`.** A forked-but-not-yet-exec'd child
of a live V8 process may only call async-signal-safe functions; running even a
single line of JS to drive the next FFI call is unsafe, because other threads
that held locks and allocator state no longer exist in the child. This is
precisely why today's policy application is a native `pre_exec` closure.

The **self-sandboxing launcher** pattern removes the constraint. Rather than
apply policy in the forbidden post-`fork` window, fino spawns itself in a
launcher mode through the ordinary pipe/spawn path. That launcher is a normal,
live fino process — V8 is fully available — so TypeScript can apply the sandbox
to *itself* over FFI: `setrlimit`, write `cgroup.procs`, the `landlock_*`
syscalls, `prctl(PR_SET_NO_NEW_PRIVS)` and `seccomp`, `unshare`, `mount`,
`pivot_root`. It then `execve`s the target. Because `execve` keeps the same pid,
`pid`, `kill()`, `wait()`, and the inherited stdio pipes all keep working, and
the target inherits every restriction the launcher installed.

The one tier that still needs a `fork` is the PID namespace, where the target
must be pid 1 of the new namespace. The launcher `unshare`s and then reuses
fino's existing generic spawn primitive, whose fork-and-exec is already native
and async-signal-safe, so the target lands as pid 1 with everything inherited —
no new native code and no JS in the forbidden window.

Because the launcher is a dedicated, short-lived process whose only job is to
sandbox itself and exec, its synchronous setup FFI does not run on the main
runtime's event loop and does not violate the async-only rule.

The resulting split:

- **Native, thin and generic:** FFI-reachable access to the syscalls that have
  no libc wrapper (`seccomp`, the `landlock_*` family, `unshare`, `pivot_root`,
  reached through the `syscall(2)` symbol; the rest are plain libc), plus the
  existing generic spawn primitive. None of this is sandbox-specific — it is
  platform surface any FFI caller could use.
- **TypeScript:** policy parsing and validation, capability matching, backend
  selection, seccomp-BPF program construction, Landlock ruleset construction,
  Seatbelt profile generation, report generation, and the launcher
  orchestration itself. This is the bulk of the current native module.

The kernel enforces the boundary regardless of which language issued the
syscall, so moving construction into TypeScript does not weaken it. This
document describes direction; the port itself is a separate implementation
effort, and the now-orphaned native sandbox module is cleanup to be scheduled,
not performed here.

## 5. Architecture

`Process` has two spawn paths:

1. **Normal path** — the current spawn implementation for unsandboxed and
   best-effort children.
2. **Strict path** — the self-sandboxing launcher (§4) that installs OS policy
   before exec and hands parent-side pipe fds back to JS.

The strict path must not regress stdout/stderr streaming, stdin writing and
close, `pid`, `kill()`, `wait()`, cwd/env setup, or cleanup on failed spawn.

### Backends

Backends are collapsed to an honest set, named for what they are:

| Backend | Mechanism | Enforces |
|---|---|---|
| `linuxNative` (in-process) | launcher applies rlimits + seccomp + Landlock (incl. `FS_EXECUTE`) + delegated cgroup + optional unprivileged namespaces | resources, filesystem, exec-allowlisting, syscalls, fork, coarse network, descendant cleanup |
| `macosSeatbelt` (in-process) | generated Seatbelt profile via `sandbox-exec` + rlimits + process group | resources (memory, pids), filesystem (readonly/writable), coarse and directional network, allowedBinaries |
| `none` | best-effort reporting only | nothing |

There is no `linuxSandboxd` backend; the current in-process path must be renamed
away from that misleading label, which implies a daemon it never used.

Backend selection:

- choose the strongest available backend that can enforce **every** requested
  category at the **requested granularity**;
- if no available backend can enforce a requested category at its granularity,
  reject before spawn with a diagnostic naming the unsatisfiable category;
- generate `sandboxReport` from what was **actually installed**, never from
  which option keys were present;
- never emit Linux-worded reasons on macOS or vice versa.

## 6. Policy Categories

### Resources

Policy: `memoryBytes`, `pids`, `cpu`.

Mechanism: a per-spawn cgroup v2 the launcher joins before exec, when a
delegated cgroup root is available — enforcing `memory.max`, `pids.max`, and
`cpu.max`. Without a delegated cgroup, `memoryBytes` and `pids` fall back to
`RLIMIT_AS` / `RLIMIT_NPROC`, and `cpu` is rejected before spawn (fractional CPU
quota has no rlimit equivalent). The report states which mechanism was used.

Done when: memory and pid limits are demonstrably enforced on the child; cpu
quota is enforced under a delegated cgroup and rejected with a probe-based
reason otherwise.

### Filesystem

Policy: readonly path list, writable path list, everything else denied.

Mechanism: Landlock path-beneath rules — readonly paths get read access,
writable paths get write access, and nothing else is reachable. A mount
namespace with `pivot_root` is the stronger option for workloads needing a
private root or hidden paths, created by the launcher under an unprivileged user
namespace. Landlock is the default because it needs no namespace and covers the
agent-`bash` case.

Done when: allowed reads succeed; denied reads fail; writable paths permit
writes; readonly paths reject writes; symlink-escape attempts fail safely.

### Network

Policy: outbound rules, inbound rules, with destination / port / protocol
detail.

Coarse network is the v1 surface and is free in-process:

- "no network" is an empty network namespace (loopback only);
- "full network" shares the host network namespace;
- both are created by the launcher with no external component.

Fine-grained **filtered egress** (allow specific destinations / ports /
protocols, deny the rest) is a **roadmap** item, not v1. An empty namespace has
no route out, so per-destination filtering needs a userspace network stack. The
planned approach stays single-process: the child's network namespace is created
with a `tun` device, its fd is handed back to the fino parent, and fino runs a
filtering network stack on its own event loop — on-brand with fino's async I/O
model. Until that lands, strict mode **rejects any rule carrying destination,
port, or protocol detail before spawn**, rather than accepting it and enforcing
nothing. (This is a change from the current behavior, which parses such rules
and silently ignores them.)

Hostname / SNI rules — `*.anthropic.com` and the like — sit beyond filtered
egress. They require in-kernel TLS ClientHello parsing, which is the one
capability that genuinely justifies eBPF. They are a documented future option,
explicitly out of the core.

Done when: coarse deny blocks all sockets; coarse allow permits them; every
finer rule is rejected before spawn until the filtered-egress stack exists, at
which point denied and allowed connects, binds, and destination/port mismatches
behave as specified.

### Process Creation

Policy: `allowedBinaries`, `allowFork`, `allowExec`.

Mechanism: `allowFork: false` denies fork/clone via seccomp. `allowExec` and
`allowedBinaries` are enforced by Landlock execute-access — execute is granted
only on the allowlisted paths (and the initial binary), so an attempt to exec
anything else fails in-kernel. This replaces the current state, where
`allowExec: false` is accepted but never enforced. Descendant cleanup is the
cgroup's `cgroup.kill`, or a PID namespace / process group in the fallback
tiers.

Done when: a disallowed initial binary fails before spawn; a fork attempt fails
under `allowFork: false`; an exec of a non-allowlisted binary fails under
`allowExec: false`; descendants do not survive cleanup.

### Syscalls

Policy: denylist, allowlist.

Mechanism: seccomp-BPF — denylist entries return `EPERM`, allowlist mode kills
on any unlisted syscall. Unsupported syscall names are rejected before spawn.
The architecture syscall-number map is maintained only for the names the API
actually exposes.

Done when: a denylisted syscall returns the expected failure; allowlist mode
blocks every unspecified syscall; unsupported names fail before spawn.

## 7. Why No Daemon

An earlier direction leaned on a `fino-sandboxd` daemon as the eventual home of
privileged enforcement — cgroups, namespaces, eBPF. That was inherited from the
reference project (`ebpf-sandbox`), where the daemon is load-bearing: its client
runs unprivileged under Kubernetes Pod Security Standards, so a separate
privileged daemon in the init user namespace has to perform the operations the
client is forbidden from doing (uid/gid-map writes, mounts from a child user
namespace blocked by AppArmor, fresh procfs installation).

**That constraint does not apply to fino.** fino forks its own children, so it
can establish every restriction on them directly, before exec. The mechanisms it
needs are unprivileged: user namespaces are created by the child itself, and
cgroup limits need only a delegated subtree fino can write to — not a privileged
helper. There is no unprivileged-client-in-a-locked-pod problem to work around,
so there is no daemon.

The `fino-sandboxd` code that exists today (a protocol, a state machine, cgroup
writes, and namespace *planning* that is never executed) is unwired — nothing in
JS or the product Rust path opens its socket. Under this direction it is
orphaned. Removing it is cleanup to be scheduled separately; this document only
records that it is not part of the design.

## 8. Testing Matrix

Required environments:

- macOS host for `Process` behavior, fail-closed strict policy, and Seatbelt
  filesystem and network enforcement;
- Linux host (or `container machine run`) for seccomp, rlimit, Landlock, and
  cgroup behavior;
- Linux host with unprivileged user namespaces enabled for the namespace tiers;
- delegated cgroup v2 environment for cpu quota and `cgroup.kill` descendant
  cleanup.

Test discipline:

- if a feature is unavailable, strict mode must fail before spawn;
- tests assert fail-closed behavior rather than skipping silently;
- every advertised supported category has a positive enforcement test;
- every rejected category has a pre-spawn error test.

## 9. Completion Criteria

Child process containment is complete when:

1. `Process` strict mode is the only public API needed for contained children.
2. Every supported category in the capability report has a passing enforcement
   test.
3. Every unsupported strict category fails before spawn.
4. On Linux, resources, filesystem, exec-allowlisting, coarse network, process
   creation, and syscall policy are enforced with real in-process OS mechanisms,
   and the launcher applies them from TypeScript over FFI.
5. macOS supports a documented Seatbelt subset (filesystem readonly/writable,
   coarse and directional network, resources, allowedBinaries) and rejects the
   rest.
6. Descendant cleanup is reliable under a delegated cgroup and honestly
   downgraded in its absence.
7. The docs, tests, and `sandboxReport` describe the same backend reality —
   including honest wording per mechanism and per OS.

## 10. Immediate Work Items

1. Rename the `linuxSandboxd` backend and report label to `linuxNative`, and
   remove stale JS comments claiming strict mode still falls back to
   `posix_spawnp`.
2. Generate `sandboxReport` from what was actually installed; stop hardcoding
   `securityBoundary` / mechanism wording and stop emitting Linux-worded reasons
   on macOS.
3. Enforce `allowExec` / `allowedBinaries` through Landlock execute-access,
   closing the current fail-open.
4. Reject network rules carrying destination / port / protocol detail before
   spawn until filtered egress exists.
5. Add cgroup-backed cpu quota and `cgroup.kill` descendant cleanup under a
   delegated cgroup, with rlimit / PID-namespace / process-group fallback tiers
   reported honestly.
6. Bring up real macOS Seatbelt filesystem profiles (readonly/writable) with a
   reproducible `sandbox-exec` probe, alongside the existing coarse network
   support.
7. Port policy construction, backend selection, and launcher orchestration to
   TypeScript over FFI (self-sandboxing launcher), reducing the native surface
   to generic syscall access plus the existing spawn primitive.
8. Retire the orphaned `fino-sandboxd` code once the launcher path is the sole
   strict backend.

## Appendix: Policy Vocabulary Notes

These are forward-looking design intents, not committed v1 surface, borrowed
from the reference project where they proved out:

- **Network rules** evaluate first-match-wins with implicit deny once any rule
  exists, and carry an optional `note` for human documentation. Destinations may
  be a hostname, a `*.wildcard`, an IPv4 address, a CIDR, or `*`.
- **Presets** (for example a read-only POSIX profile, or a no-network profile)
  expand in TypeScript into the same policy object before validation, so callers
  such as the agent harness and scheduler need not enumerate low-level rules.
- **Tighten-only policy merge** lets a global ceiling policy be narrowed but
  never widened by a child policy — deny-only network additions, denylist union,
  fork/exec that cannot be re-enabled, `allowedBinaries` intersection, resource
  minimums, filesystem subset. This is the model for the multi-tenant realm and
  scheduler cases, where an outer policy must bound every inner one.
