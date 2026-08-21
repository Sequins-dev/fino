---
weight: 16
---
# Realm communication sessions

Status: staged implementation. Transport observation, the `SimJournal` call
projection, and cassette replay now use the shared session stream. Cassettes
still persist completed call summaries until the event-stream format lands.

## Goal

A realm should be a replicable execution container. Every value entering or
leaving it should cross one communication session that can run live, be
observed, be recorded, or be replayed without changing the application-facing
module or messaging APIs.

This session is not a new transport and not another RPC implementation. It is
the semantic event layer over the existing realm envelope protocol. Thread,
process, and cluster links continue to move bytes; facades continue to make
module-shaped RPC convenient; the session gives those systems one common place
for observation and replay.

## Constraints

- The import map is the only module-access policy. Do not add a parallel
  capability registry.
- Host services, including filesystem access, are ordinary facade modules
  delivered by import-map rules. A facade must be able to describe every
  module export shape needed by such services.
- The hot path with no observer performs no extra structured clone, encoding,
  or payload allocation.
- Filters run against envelope metadata before any observed payload is
  materialized.
- A matched observer explicitly asks for metadata, an in-memory snapshot, or a
  storage representation. Each requested representation is produced at most
  once per frame and shared by matching observers.
- Transfer remains explicit. The live receiver may take ownership of a
  transferred value; observation makes a copy only when an attached observer
  needs one.
- Same-process and remote/process realms use the same semantic events even
  though their transport costs differ.

## Event model

The existing envelope kinds are the canonical vocabulary. They already cover
application messages, realm calls, scalar facade requests and responses,
read-stream chunks, write-stream chunks, completion, and failure. A session
adds only boundary metadata:

- monotonically increasing sequence number;
- direction relative to the observed endpoint;
- envelope kind and correlation id;
- serialized payload size and transfer counts.

This is enough to derive higher-level views. A facade call is the request frame
plus correlated response, chunk, end, or error frames. `SimJournal.calls()` can
therefore become a projection over the event stream rather than a second
recorder embedded in facade handlers.

The three capture levels are:

1. `metadata`: routing and size only; never clones the payload.
2. `snapshot`: an independent structured-clone value for assertions and live
   inspection.
3. `storage`: stable structured-clone bytes for persistence and replay.

When there are no subscriptions, the port bypasses the session entirely. When
subscriptions exist but none match the metadata, the session does not invoke
either payload materializer. Multiple matching subscriptions share the one
snapshot and/or one byte copy produced for that frame.

## Recording and replay

A cassette should contain two sections:

- an execution manifest: entry and module-graph hashes, effective import map,
  runtime version, seed, clock configuration, and bootstrap data;
- the ordered session event stream.

Recording is a storage-capture subscription. Buffering for test assertions is
an optional snapshot-capture subscription. A replay peer consumes request-side
events, validates kind, correlation, arguments, and stream chunks, then emits
the recorded response-side events through the same session API.

Persistent recording of a transferred `ArrayBuffer` necessarily copies its
bytes because the live transfer detaches the sender. With no recorder attached,
there is no observer copy. Transferred `MessagePort` values cannot be flattened
into a portable cassette; they must become named child sessions or be rejected
when replayability is required. `SharedArrayBuffer` is incompatible with
deterministic replay and remains rejected.

The clone and transfer behavior follows the WHATWG structured-data model:
<https://html.spec.whatwg.org/multipage/structured-data.html#safe-passing-of-structured-data>.
Cross-realm cloning serializes and deserializes; transfer is explicit and may
reuse backing memory when both endpoints share a process.

## Isolation boundary

The completed session boundary must cover:

- realm calls and results;
- facade scalar, read-stream, write-stream, and handle traffic;
- `postMessage` and transferred child channels;
- initial realm data and lifecycle events;
- console and telemetry output when deterministic mode is enabled.

Strict deterministic mode will reject host-backed imports that are not
provided by facades, reject nested realms that do not inherit the parent
session, and disable direct external telemetry exporters. This is behavioral
isolation for reproducibility; import rules do not replace process or kernel
security boundaries.

## Implementation stages

1. Add lazy observation to the shared envelope boundary. This is implemented;
   it adds no serialization when unobserved.
2. Expose a session subscription at realm construction time so module
   evaluation and bootstrap traffic cannot race observer attachment.
3. Replace facade handler wrapping in `recordFacade()` with a session-stream
   projection. This is implemented; `SimJournal` remains as the compatibility
   call view while cassettes use their version-1 format.
4. Introduce the event-stream cassette and a replay peer. The replay peer is
   implemented and validates arguments, invocation kind, sink chunks, missing
   calls, partial streams, and errors. Persisting correlated frames instead of
   completed call summaries remains.
5. Route initial data, console, telemetry, lifecycle, and nested/transferred
   channels through sessions. Add execution-manifest verification.
6. Remove the version-1 journal/cassette compatibility layer after its migration
   window, leaving one RPC/event representation and one stream queue/producer
   implementation.

## Deletion targets

The migration should reduce code, not preserve both systems indefinitely. The
`recordFacade()` and replay handler wrappers are gone. Remaining targets are
delayed serialization in `SimJournal.toCassette()` and the version-1 cassette
compatibility layer. The read-stream and sink source queues now share
`RealmStreamQueue`, and facades and returned handles share one per-port
dispatcher. New abstractions must replace at least as much special-case
machinery as they add before the migration is considered complete.
