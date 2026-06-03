# Standard Library DX — Backend-First Gap Analysis

> Status: exploratory. This document inventories valuable built-ins for fino's
> standard library and sequences the near-term developer-experience work. It is
> a product and API-shaping note, not an implementation commitment.

## 1. Current strengths

The runtime already has a credible backend foundation. The main gap is not
"can fino build servers?" but "does fino make the common backend path obvious,
typed, observable, and pleasant without sending users to npm first?"

Existing strengths:

- **HTTP and networking.** HTTP/1.1 server/client support, streaming bodies,
  WebSocket, SSE, DNS, TLS, connection takeover, and OpenTelemetry hooks.
- **Files and process basics.** File APIs, path helpers, process/runtime access,
  watch workflows, and enough primitives for local tools and server apps.
- **SQLite.** `fino:database/sqlite` provides embedded persistence, including a
  JS-driven VFS path and room for app-local data, migrations, queues, caches,
  and vector-backed features.
- **Formats.** Built-in structured formats reduce dependency pressure for common
  backend data exchange and config surfaces.
- **Tests and benchmarks.** The runtime has native test and benchmark entry
  points, making standard-library modules easy to validate in-tree.
- **Docs and examples.** Existing examples give entry points for server,
  profiling, and throughput workflows.
- **Realms.** Embedded, thread, process, and remote realms provide isolation and
  distribution primitives that most JS runtimes do not have.
- **Cluster.** Remote realms and cluster transport make multi-node placement a
  runtime concern instead of an application rewrite.
- **OpenTelemetry.** Traces, logs, metrics, and instrumentation are already part
  of the platform story.
- **Compression and archive support.** Backend file and transport workflows have
  local primitives available without immediately reaching for packages.
- **Package install path.** The runtime has a path toward package acquisition and
  compatibility, even if larger npm compatibility remains a separate track.

## 2. Product posture

fino should bias toward a **backend-first standard library**: practical APIs for
services, CLIs, data tools, jobs, and small deployable applications. The best
near-term posture is not a maximal Node clone or a frontend build platform. It
is a curated backend runtime that ships the boring pieces developers need before
their app-specific code starts.

The standard library should prefer high-level APIs where the user intent is
stable and repetitive:

- run database migrations;
- schedule background work;
- cache small values locally;
- manage project tasks and workflows.

Those high-level APIs should sit over solid lower-level primitives. Internals
can remain private while they are still settling. Expose the public modules only
when they are coherent enough to support, and keep `internal:*` surfaces private
until the API shape is stable.

## 3. Near-term build sequence

The immediate sequence should be:

1. `fino:database/migrate`
2. `fino:jobs`
3. `fino:cache` / `fino:kv`
4. `fino:task`

This order starts with the SQLite adjacency — turning embedded SQLite from
"available" into "ready for app state" — then layers on background work,
caching, and project workflows that build on those foundations.

### 3.1 `fino:database/migrate`

SQLite needs a first-class migration and seed workflow:

- ordered migrations;
- up/down or forward-only policy decided explicitly;
- migration table management;
- transactional application where SQLite permits it;
- seed scripts for local development and tests;
- CLI/test integration.

This would turn embedded SQLite from "available" into "ready for app state."

### 3.2 `fino:jobs`

Background work is a common backend need and SQLite makes a local durable queue
possible:

- SQLite-backed queues;
- retries with backoff;
- delayed jobs and schedules;
- job leases and recovery after process death;
- typed payload validation;
- worker concurrency controls;
- structured logging and OTel spans per job.

This can start local and later grow into realm/cluster-aware execution.

### 3.3 `fino:cache` / `fino:kv`

Small services need a simple key-value layer before they need an external cache:

- in-memory TTL cache;
- SQLite-backed TTL storage;
- namespaced keys;
- stale/delete semantics;
- optional serialization helpers;
- test-friendly deterministic clocks where practical.

Keep the first version honest: local process and local SQLite, not a distributed
cache promise.

### 3.4 `fino:task`

Project task scripts can give fino projects a native workflow without forcing a
package manager convention:

- named tasks;
- arguments and environment handling;
- dependency ordering;
- watch mode hooks;
- integration with tests, benchmarks, migrations, and local servers.

This should complement the runtime, not become a replacement shell language.

## 4. Future backlog

### Later AI modules

AI-related modules are valuable but should come after the backend base is
stronger:

- `fino:agent`;
- `fino:embedding`;
- `fino:rag`;
- eval tooling;
- capability-secured tool execution.

These should lean on the runtime's strongest differentiators: realms,
capability narrowing, SQLite/sqlite-vec, streaming, and OpenTelemetry. They will
also depend on the same boring foundations: logs, validation, config, jobs, and
storage.

## 5. Deferred items

These remain useful but are intentionally not the immediate backend-DX focus.

### Frontend app/build pipeline

A frontend build pipeline is outside the near-term posture. fino can eventually
serve static assets or support frontend workflows, but the primary wedge should
be backend services and tools first.

### Larger npm compatibility work

Node/npm compatibility matters for adoption, but the larger compatibility track
should remain separate except where it directly supports backend adoption. Do
not let broad compatibility work obscure the curated standard-library path.

## 6. Ordering principle

The standard library should earn trust in this order:

1. Make persistent state manageable (`fino:database/migrate`).
2. Make background work reliable (`fino:jobs`).
3. Make local caching practical (`fino:cache` / `fino:kv`).
4. Give projects a native workflow (`fino:task`).
5. Layer on AI and advanced capabilities once those foundations exist.

That sequence keeps fino's backend story coherent: services should start with
clear data shape, run background work reliably, cache where it helps, manage
local workflows, and scale into realms or clusters without rewriting their core
shape.
