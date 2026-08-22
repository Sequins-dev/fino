---
weight: 12
---
# Isolation Levels

Fino realms support local reactor, Linux sandbox-thread, process, and remote
execution. Choosing the right one is a trade-off between startup cost,
messaging overhead, resource governance, and the strength of the isolation
boundary.

## Reactor pool

The default mode. Each child gets its own movable V8 isolate, module graph, and
global object. The process-wide TypeScript scheduler places it on the shared
reactor thread pool:

```ts
import { Realm } from 'fino:realm';

const realm = new Realm({ entry: './task.ts' });
await realm.run();
```

The scheduler keeps an isolate entered on its current thread while it remains
the highest-priority runnable workload. It moves the isolate only when another
workload has more pending readiness signals. Messages cross isolate boundaries
through V8 ValueSerializer and support `ArrayBuffer` and `MessagePort`
transfer.

This is JavaScript and module-graph isolation, not operating-system
containment. Reactor realms share the process address space and file-descriptor
table. A realm can move between reactor workers, so it has no stable OS thread
to place in a cgroup, assign QoS, or restrict with a per-thread seccomp or
Landlock policy. Applying one of those controls to a worker would affect every
realm scheduled there, while async FFI can run on the process-wide blocking
pool instead.

Import maps are still useful boundaries for cooperating application code. They
are not substitutes for OS enforcement: native or FFI code running in the
process can bypass a facade-backed filesystem or network. macOS scheduling QoS
and Linux thread controls may govern reactor workers as a group, but Fino does
not expose them as per-realm security or resource limits.

## Linux sandbox thread

`sandbox` selects a dedicated, non-migrating Linux thread and installs a strict
policy before importing the entry module:

```ts
const realm = new Realm({
  entry: './task.ts',
  sandbox: {
    mode: 'strict',
    resources: { cpu: 0.5, cpus: '0-1', pids: 32 },
    filesystem: {
      readonly: ['/srv/app'],
      writable: ['/tmp/task'],
    },
    network: { outbound: [{ action: 'deny' }] },
  },
});
await realm.run();
```

CPU quota, CPU affinity (`cpus` in Linux CPU-list syntax), and pids use cgroup
v2's threaded `cpu`, `cpuset`, and `pids` controllers under the host process's
current cgroup domain. Filesystem policy uses Landlock; syscall, fork/exec, and
coarse network policy use seccomp. Each mechanism applies to the dedicated
thread and descendants it creates, so ordinary reactor workers do not inherit
the policy. The current cgroup must be writable and delegated when resource
limits are requested, and the kernel must expose each requested mechanism.
Strict mode fails closed instead of silently omitting a control.

This is governance and defense in depth for cooperating in-process workloads,
not containment for hostile code. The Realm still shares process memory and
inherited file descriptors. Linux has no threaded memory controller, so
`memoryBytes` is rejected. Fork and exec are always denied because they operate
on or copy the host process. Async FFI is rejected and inherited or data-driven
OpenTelemetry bootstrap is suppressed because process-global background
workers would execute outside the thread policy. Watch and REPL modes are not
supported. A non-yielding workload must be stopped with
`realm.terminate({ force: true })`, which terminates execution in that Realm's
V8 isolate and lets the dedicated thread and cgroup leaf exit.

## Process

`process: true` spawns the child as a separate OS process:

```ts
const realm = new Realm({ entry: './untrusted.ts', process: true });
await realm.run();
```

Process realms provide hard crash isolation: a crash or out-of-memory condition in the child cannot destabilize the parent. Messages use framed binary over a Unix socket pair. `ArrayBuffer` values are serialized by copy. Live `MessagePort` transfer is not supported — attempting it throws a `TypeError`.

Process startup is slower than pooled-isolate startup and messaging has higher
overhead. Use process realms when the child runs code you do not fully control,
or when crash isolation is a hard requirement.

## Remote

`remote: true` runs the child on a worker node in an established cluster. `startCluster()` or `joinCluster()` from `fino:cluster` must be called before constructing a remote realm:

```ts
import { startCluster } from 'fino:cluster';
import { Realm } from 'fino:realm';

await startCluster({ port: 9999 });

const realm = new Realm({ entry: './remote-task.ts', remote: true });
await realm.call('healthcheck');
realm.terminate();
```

Remote realms expose the same `run()`, `call()`, and `terminate()` interface as local realms. Messaging uses the cluster's WebTransport transport. Watch mode and REPL mode are not supported for remote realms. Live port transfer over the cluster transport has no stable contract — use only serializable payloads.

## How to choose

Use the default reactor pool for import isolation, module graph separation, and
parallel work. Use a Linux sandbox Realm when a cooperative workload needs
per-thread CPU/pids governance or filesystem/syscall defense in depth. Move to
process when you need crash isolation or are running third-party code with
elevated risk. Use remote only when work must run on a cluster node you have
already established with `startCluster()` or `joinCluster()`.

## Trust and security

Import rules, facades, execution mode, OS process privileges, filesystem and network placement, and cluster authentication are all independent parts of a trust model. No single mechanism is a complete security boundary on its own.

Realms do not sandbox the child against the host operating system. A process realm with full filesystem access is isolated from the parent process, not from the host. Combine restrictions intentionally: narrow the import rule set, use `process: true` for adversarial code, apply OS-level containment to the child process, and place sensitive services behind facades rather than making them directly importable.
