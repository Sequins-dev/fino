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

- define and emit structured logs;
- validate runtime data at trust boundaries;
- load typed config from environment, files, and CLI overrides;
- route HTTP requests;
- run database migrations;
- schedule background work;
- cache small values locally;
- secure cookies, tokens, headers, and credentials.

Those high-level APIs should sit over solid lower-level primitives. Internals
can remain private while they are still settling. Expose the public modules only
when they are coherent enough to support, and keep `internal:*` surfaces private
until the API shape is stable.

## 3. Near-term build sequence

The immediate sequence should be:

1. `fino:log`
2. `fino:validate`
3. `fino:config`

This order keeps the first implementation focused on observability, then adds
the validation layer that config should depend on. Conceptually, validation is
foundational for config, even though logging should ship first.

### 3.1 `fino:log`

Structured logging is the first backend DX multiplier. Every server, CLI, job,
test fixture, and future standard-library module needs a consistent way to emit
machine-readable events.

Core goals:

- structured log records with level, message, timestamp, module/source, fields,
  error details, and optional span/request context;
- context-aware request IDs and correlation IDs, ideally flowing through async
  request handling and realm boundaries where practical;
- text output for local development and JSON output for production ingestion;
- OpenTelemetry correlation, so logs can connect to traces and metrics without
  every application rebuilding the bridge;
- simple logger construction for common cases and enough hooks for tests,
  custom sinks, and future runtime instrumentation.

Design pressure:

- The API should be useful from tiny scripts through multi-realm services.
- The default output should be readable locally without sacrificing structured
  production output.
- Hot paths should avoid unnecessary allocations when a level is disabled.

### 3.2 `fino:validate`

Validation should become the shared boundary layer for runtime data. It should
not be scoped only to HTTP. Backend applications need validation anywhere data
crosses from "untrusted or dynamic" into "application logic."

Primary use cases:

- request params, query strings, headers, and bodies;
- environment variables and config files;
- CLI inputs and tool arguments;
- database rows, migration inputs, and seed data;
- message payloads crossing realm, queue, or worker boundaries;
- AI/tool inputs later, where precise contracts are part of the safety model.

Core goals:

- define schemas in plain JavaScript/TypeScript-friendly code;
- parse and transform values, not merely check them;
- produce useful error trees for HTTP responses, config failures, and tests;
- infer or expose typed access patterns where the runtime's type story allows;
- support object, array, tuple, enum, literal, union, optional/defaulted,
  numeric/string/date/boolean, and custom refinement cases;
- compose cleanly with `fino:config`, HTTP routing, jobs, and database helpers.

Design pressure:

- Config should be built on validation, not the other way around.
- Error output needs to be stable enough for tests and user-facing diagnostics.
- The module should avoid becoming a full application framework by accident.

### 3.3 `fino:config`

Config should give backend apps a typed, validated startup boundary. Its job is
to make the common app lifecycle boring: collect values, merge sources, validate
once, and expose typed access.

Core goals:

- load `.env` files for local development;
- read TOML and JSON config files where appropriate;
- merge environment variables, config files, CLI overrides, and defaults using a
  clear precedence model;
- validate the final shape through `fino:validate`;
- provide typed access to required, optional, defaulted, secret, and derived
  values;
- emit useful startup errors without leaking secret values;
- integrate with `fino:log` for clear config-source diagnostics.

Design pressure:

- The module should make simple apps simple while still supporting deployment
  environments that inject everything through env vars.
- Precedence must be explicit and documented from the first public version.
- Secrets should have redaction semantics in errors and logs.

## 4. Broader future backlog

These modules are valuable, but they should not displace the first three. They
represent the rest of the backend-first standard-library surface.

### `fino:http/app`

A small application layer over the existing HTTP primitives:

- routing with params;
- middleware or layered request handling;
- cookies;
- static files;
- body parsing;
- typed validation integration for params, query, headers, and bodies;
- centralized error handling;
- predictable response helpers without hiding streaming primitives.

This should remain a backend app layer, not a full-stack framework.

### `fino:database/migrate`

SQLite needs a first-class migration and seed workflow:

- ordered migrations;
- up/down or forward-only policy decided explicitly;
- migration table management;
- transactional application where SQLite permits it;
- seed scripts for local development and tests;
- CLI/test integration.

This would turn embedded SQLite from "available" into "ready for app state."

### `fino:jobs`

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

### `fino:cache` / `fino:kv`

Small services need a simple key-value layer before they need an external cache:

- in-memory TTL cache;
- SQLite-backed TTL storage;
- namespaced keys;
- stale/delete semantics;
- optional serialization helpers;
- test-friendly deterministic clocks where practical.

Keep the first version honest: local process and local SQLite, not a distributed
cache promise.

### `fino:security`

Security helpers should cover the repetitive pieces that backend apps get wrong:

- secure cookie signing/encryption helpers;
- token generation and verification;
- CORS and security-header helpers;
- password hashing;
- JWT/JWK helpers;
- constant-time comparison and safe random helpers where not already exposed.

This module needs conservative API design because mistakes become security
footguns. Prefer small, boring, well-documented helpers over a broad framework.

### `fino:task`

Project task scripts can give fino projects a native workflow without forcing a
package manager convention:

- named tasks;
- arguments and environment handling;
- dependency ordering;
- watch mode hooks;
- integration with tests, benchmarks, migrations, and local servers.

This should complement the runtime, not become a replacement shell language.

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

### Formatting and linting

OXC-based formatting and linting would improve project polish, but it should not
preempt the first backend APIs. Revisit when the runtime has a clearer project
workflow story around `fino:task`.

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

1. Make runtime behavior observable (`fino:log`).
2. Make dynamic boundaries explicit and safe (`fino:validate`).
3. Make application startup deterministic (`fino:config`).
4. Add higher-level app primitives once those foundations exist.

That sequence keeps fino's backend story coherent: services should start with
clear config, validate their inputs, emit useful logs, persist locally when
needed, and scale into realms or clusters without rewriting their core shape.
