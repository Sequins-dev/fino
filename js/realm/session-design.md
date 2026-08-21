---
weight: 16
---
# Realm communication sessions

Status: implemented. Realm transport, facade RPC, bootstrap, deterministic
diagnostics, recording, replay, and journal projections share the session
stream. There is no separate capability gate or call-summary cassette.

## Goal

A realm should be a replicable execution container. Every value entering or
leaving it should cross one communication session that can run live, be
observed, be recorded, or be replayed without changing the application-facing
module or messaging APIs.

This semantic layer observes the existing envelope protocol; transport and
module-shaped facade RPC remain unchanged.

## Constraints

- The import map is the only module-access policy. Do not add a parallel
  capability registry.
- Host services, including filesystem access, are ordinary facade modules
  delivered by import-map rules. A facade must be able to describe every
  module export shape needed by such services.
- The hot path with no observer performs no extra structured clone, encoding,
  or payload allocation.
- Filters run before payload materialization. Matching observers choose
  metadata, snapshot, or storage capture; each representation is produced at
  most once per frame.
- Transfer remains explicit, and observation copies only when requested.
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

Facade calls are projections of request frames and their correlated response,
chunk, end, or error frames; they need no second recorder.

The three capture levels are:

1. `metadata`: routing and size only; never clones the payload.
2. `snapshot`: an independent structured-clone value for assertions and live
   inspection.
3. `storage`: stable structured-clone bytes for persistence and replay.

With no matching subscription, the port invokes no payload materializer.
Matching subscriptions share any snapshot or byte copy.

## Recording and replay

A version-2 cassette contains two sections:

- an execution manifest: entry and module-graph hashes, effective import map,
  runtime identity, seed, and clock/latency configuration;
- the ordered session event stream.

Recording is a storage-capture subscription. Buffering for test assertions is
an optional snapshot-capture subscription. A replay peer consumes request-side
events, validates kind, correlation, arguments, and stream chunks, then emits
the recorded response-side events through the same session API.

Persistent recording of a transferred `ArrayBuffer` necessarily copies its
bytes because the live transfer detaches the sender. With no recorder attached,
there is no observer copy. Transferred `MessagePort` values cannot be flattened
into a portable cassette, so portable observers reject them on both endpoints
before transfer. A future named child session can relax that limit without
changing the frame format. `SharedArrayBuffer` is incompatible with
deterministic replay and remains rejected.

The clone and transfer behavior follows the WHATWG structured-data model:
<https://html.spec.whatwg.org/multipage/structured-data.html#safe-passing-of-structured-data>.
Cross-realm cloning serializes and deserializes; transfer is explicit and may
reuse backing memory when both endpoints share a process.

## Isolation boundary

The completed session boundary must cover:

- realm calls and results;
- facade scalar, read-stream, write-stream, and handle traffic;
- `postMessage`, with transferred child channels rejected for portable sessions;
- initial realm data and lifecycle events;
- console and telemetry output when deterministic mode is enabled.

Strict deterministic mode rejects host-backed imports that are not provided by
facades, nested realms that could escape the root session, transferred child
ports, and direct external telemetry exporters. This is behavioral isolation
for reproducibility; import rules do not replace process or kernel security
boundaries.

## Implementation stages

1. Lazy observation at the shared envelope boundary, with no observation work
   on an unobserved port.
2. Construction-time `RealmOptions.observe`, attached before the port starts.
3. `SimJournal` as a snapshot/storage projection over session frames.
4. Version-2 event cassettes and a replay peer that consumes the same correlated
   RPC frames produced by live facades.
5. Channel bootstrap for user data and runtime settings, plus console,
   telemetry, and lifecycle envelope kinds and verified execution manifests.
6. Portable-session enforcement: deterministic nested realms and live port
   transfer reject rather than creating an unrecorded side channel.

## Deletion targets

The migration does not preserve both systems. Handler wrappers, delayed
call-summary serialization, direct facade native-send fallback, and the
version-1 cassette are gone. Read streams and sinks share `RealmStreamQueue`;
facades and returned handles share one per-port dispatcher; recording and
replay use the port session itself.
