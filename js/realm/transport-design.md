---
weight: 16
---
# Realm transport channels

Status: implemented. `TransportPort` is the single communication mechanism for
realm messages, facade RPC, bootstrap, diagnostics, recording, replay, and
simulation faults. There is no separate session or capability layer.

## Goal

A realm is a replicable execution container. Every value entering or leaving
it crosses one ordered, duplex channel that can run live, be observed, be
recorded, or be replayed without changing module or messaging APIs.

The import map is the only module-access policy. Host services, including
filesystem access, are ordinary facade modules selected by import rules.

## Channel core

`TransportPort` owns:

- structured-clone serialization and explicit transfer;
- the physical link and its readiness/drain loop;
- envelope decoding and ordered control routing;
- application `postMessage` delivery;
- lazy tee branches attached with `observe()`.

A physical link only moves wire frames. Scheduled, sandbox, process, and
cluster realms therefore share the same port behavior instead of implementing
parallel communication stacks. Readiness is an implementation detail that
triggers a drain; it is not a deterministic event worth recording.

Facade RPC is a channel route. Replay and seeded fault injection install routes
on the same port before live facade routes, so neither feature wraps or mutates
facade definitions. `SimJournal` is only a consumer that projects frames into
human-friendly calls and optional cassette bytes.

## Lazy tee observation

Each port has zero or more tee branches. The no-observer hot path performs no
observation clone, encoding, or byte copy. For an observed frame:

1. The port constructs inexpensive envelope metadata.
2. Branch filters run against that metadata.
3. Only the representations requested by matching branches are materialized.
4. One snapshot and one storage copy are shared by all matching branches.

The capture levels are:

- `metadata`: direction, sequence, kind, correlation, byte size, and transfer
  counts;
- `snapshot`: an independent in-memory structured clone for assertions or live
  inspection;
- `storage`: stable structured-clone parts for persistence and replay.

An observer callback or filter cannot interrupt primary channel delivery.
Attaching a storage recorder necessarily copies transferred buffer bytes;
without that branch, the live transfer incurs no observer copy.

## Recording and replay

A version-2 cassette contains an execution manifest and the ordered storage
frames emitted by the channel tee. The manifest records the entry, effective
import map, module hashes, runtime identity, seed, and time configuration.

Replay claims facade request frames at the channel router, validates them
against the recording, and sends recorded response, chunk, completion, and
error frames back through that same port. Live facade implementations remain
bound as the declared module shape but are never reached for claimed frames.

Transferred `MessagePort` values cannot be flattened into a portable cassette,
so a portable branch rejects them before transfer. A future named subchannel
can relax that constraint without introducing a second recorder. Shared memory
remains unsuitable for deterministic replay.

Clone and transfer behavior follows the WHATWG structured-data model:
<https://html.spec.whatwg.org/multipage/structured-data.html#safe-passing-of-structured-data>.
Serialization creates a realm-independent representation; transfer is explicit
and detaches the sender-side resource.

## Isolation boundary

The channel covers:

- realm calls and results;
- facade scalar, read-stream, write-stream, and returned-handle traffic;
- application messages;
- initial realm data and lifecycle events;
- console and telemetry output in deterministic mode;
- child coverage submissions when native V8 coverage is active.

Strict simulation rejects host-backed imports not supplied through the import
map, nested realms that could escape the root channel, portable recordings with
live port transfer, and direct external telemetry exporters. These rules provide
behavioral isolation for reproducibility; process and kernel controls remain a
separate security boundary.

## Completed implementation plan

1. Put serialization, transfer, routing, and readiness in one `TransportPort`.
2. Integrate lazy tee branches at its serialized boundary.
3. Route all facade traffic, bootstrap, lifecycle, console, telemetry, and
   coverage submission through channel envelopes.
4. Make journals projections and cassettes storage-tee buffers.
5. Attach replay and seeded faults as channel routes, before live facade routes.
6. Delete `RealmSession`, facade bind wrappers, the capability gate, legacy
   provider options, and call-summary recording.
7. Keep `ImportMap` as the only module-policy vocabulary, including in
   simulation; services are facade directives and pure inherited modules use
   explicit rules.
8. Reuse `Facade.from()` for scalar and streaming object modules, with custom
   facade source reserved for module shapes such as `fino:file` classes.
9. Separate pure filesystem constants and value types from lazy libc access so
   memory and facade-backed filesystems do not initialize host bindings.
