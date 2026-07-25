# Multi-Tenant Runtime — Remaining Extensions

> Status: exploratory, direction-setting. Node-local realm scheduling,
> capability narrowing, process containment, and local replica scaling are
> implemented. Distributed placement and routing are tracked in
> [multi-node-distribution.md](./multi-node-distribution.md). This note owns the
> tenant-specific work that remains around deployment, policy, virtualized
> native access, and WASI.

## 1. Current Baseline

Every ordinary `Realm` is one V8 isolate placed on a reactor by node
orchestration. `RealmDeployment` composes independent replicas and handles
node-local admission, queue-driven scale-out, quiet scale-down, affine
sessions, and liveness. Application code declares execution intent rather than
selecting a reactor or node.

The module graph is the capability boundary. Import rules narrow what a child
can load, provider rule builders scope common filesystem/network access, and
children cannot restore authority denied by their parent. `process: true` adds
an OS-process boundary; strict `Process` sandbox policy supplies OS-enforced
resource, filesystem, network, process, and syscall controls for contained
subprocesses.

Reactors report coarse runnable/debt load, enforce synchronous-slice budgets,
and terminate realms approaching their heap cap. These controls are enough for
node-local placement and noisy-neighbour containment. They are not yet the
cluster-wide cost model, deployment policy, or tenant accounting surface.

## 2. Distributed Substrate Dependency

Multi-tenancy depends on, but should not duplicate, the cluster work in
`multi-node-distribution.md`:

- authenticated node identities and direct peer sessions;
- remote node admission through the existing asynchronous `ClusterNode`
  contract;
- durable desired state, fenced replica attempts, and reconciliation;
- readiness-aware service routing, DNS projection, drain, and replacement;
- bounded peer data streams that stay off the seed path.

Tenant policy consumes those mechanisms. It does not add another remote realm
kind, port type, scheduler, or execution loop.

## 3. Casks And Deployment

Apps need a transportable unit before a cluster can place them. Fino runs
TypeScript directly, so the unit should be a content-addressed archive rather
than a JavaScript bundle.

A deployment cask contains:

- a manifest with application name/version and one or more entrypoints;
- the application sources and installed dependencies needed at runtime;
- requested capability grants and resource profile;
- platform, architecture, and system-library constraints;
- content hashes for verification and cache identity.

The control plane stores the cask by digest, commits the desired deployment
generation, and assigns replicas. Nodes fetch and verify missing casks, unpack
them into a content-addressed cache, and start the selected entrypoint through
the ordinary realm admission path.

Without `--wait`, deploy success means the cask is durably available and the
desired generation is committed. With `--wait`, it additionally means the
requested healthy replicas are ready and published in routing. Interrupted or
failed rollouts reconcile from committed state and preserve the previous
healthy generation.

V1 should vendor the resolved install output into the archive. Lockfile-driven
install-on-node can follow only after the hermetic path is proven.

## 4. Tenant Grants And Resource Policy

Manifest capabilities are requests; an operator or cluster policy decides the
grants. The resulting realm configuration starts from a deny baseline and
contains only the approved import/provider rules. The existing narrowing check
then prevents a tenant from escalating in descendants.

The remaining policy layer must define:

- tenant/application namespace identity;
- read, write, watch, network, native-library, and process-execution grants;
- resource requests for placement versus hard containment limits;
- grant audit records and OTel attribution for facade/service calls;
- secret delivery as explicit deployment/realm grants rather than ambient
  process-global state;
- tighten-only composition between cluster ceilings, deployment policy, and
  per-realm restrictions.

Current heap and synchronous-slice controls remain node-local containment
signals. Cluster scheduling additionally needs summarized capacity and load,
including queue/runnable pressure, memory headroom, and readiness. That metric
wire shape belongs to the multi-node observation/admission stage.

## 5. Native I/O Virtualization

Import denial is safe but can make native-dependent code unusable. A separate,
explicit virtualization mode could remap `fino:ffi` to a shim whose
`dlopen(path, defs)` interposes selected symbols:

- filesystem functions route through a granted `FileSystem`;
- socket functions route through a network provider or facade;
- explicitly permitted symbols pass through to real FFI objects.

Importer-scoped rules allow the shim itself to receive real FFI without
granting it directly to tenant code. Passthrough is virtualization for trusted
or semi-trusted code, never containment: a real pointer-capable FFI symbol can
reach process memory. Hostile code must receive full interposition, no FFI, or
a process boundary with OS sandbox policy.

Native libraries that perform internal I/O do not cross this shim. The
admission rule should therefore remain: a granted library is sans-I/O, exposes
a VFS/BIO-style hook that Fino controls, or runs behind a contained process
boundary. The existing SQLite VFS and memory-BIO networking integrations are
the patterns to follow.

Before committing a public surface, prototype the shim with a filesystem-only
realm, verify importer scoping and capability narrowing, and audit residual
file access in crypto/TLS libraries.

## 6. WASI On The Same Capability Model

V8 already runs WebAssembly modules inside an ordinary realm. The open question
is a useful async WASI implementation, not a new realm kind.

First run a JS Promise Integration smoke test against the V8 build that Fino
actually ships. If `WebAssembly.Suspending` and `WebAssembly.promising` work as
required, a WASI preview1 shim can map sync-looking imports onto promises:

- `fd_*` operations use a granted `FileSystem` and a JS-owned descriptor table;
- socket operations use the granted network provider;
- time/random/process imports are explicit capabilities;
- facade-backed providers work across realm and, later, node boundaries;
- linear-memory bounds provide the module's memory ceiling.

WASI preview2/component-model remains a later compatibility track. Do not
design around it until supported toolchains and Fino's runtime needs justify
the change.

## 7. Delivery Order

1. Land the authenticated distributed admission, reconciliation, routing, and
   peer-data stages in `multi-node-distribution.md`.
2. Define the cask manifest and prove hermetic content-addressed deployment on
   a single-node controller before adding replicated control-plane storage.
3. Add operator-approved tenant grants, audit attribution, and tighten-only
   policy composition to deployment admission.
4. Prototype FFI interposition over a virtual filesystem and complete the
   native-library I/O audit.
5. Gate a WASI preview1 shim on the JSPI smoke test and capability-parity tests.

## 8. Required Tests

- cask hashes are stable, verified before execution, and reused across nodes;
- failed or interrupted rollouts preserve/recover the last healthy generation;
- requested capabilities never exceed operator grants, including descendants;
- placement requests and hard resource limits remain distinct in reports;
- FFI remapping cannot expose real FFI to an unauthorized importer;
- fully interposed native I/O observes the granted providers only;
- WASI filesystem/network imports obey the same grants as JavaScript modules;
- unsupported JSPI/WASI capability fails explicitly rather than falling back.
