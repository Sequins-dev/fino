# Messaging — Communication Model

## Overview

MessagePort is the universal channel between Realms. The same API works regardless of whether the Realm is embedded in the same thread, running on a different OS thread, in a child process, or on a remote machine. The transport layer is an implementation detail hidden behind the MessagePort interface.

This matches how browsers communicate between the main thread and Workers — the WHATWG MessagePort/MessageChannel spec is already the web standard for exactly this use case.

---

## Current State

**What exists:**
- `structuredClone` — pure JS implementation in `js/internal/globals/encoding.mts` (lines 385–549). Supports primitives, Date, RegExp, ArrayBuffer (with transfer), TypedArrays, Map, Set, Error, Blob/File.
- `MessageEvent` — defined locally in `js/net/websocket.mts`. Has `data` and `origin` properties. Not a global.

**What does not exist:**
- `MessagePort`, `MessageChannel`, `BroadcastChannel`
- `postMessage` on any object
- V8 `ValueSerializer`/`ValueDeserializer` usage
- SharedArrayBuffer wiring

---

## MessagePort / MessageChannel — Spec Design

Pure WHATWG spec types. Registered as globals alongside `EventTarget`, `AbortController`, etc.

```ts
// fino:messaging (public) — also registered on globalThis

class MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;
}

class MessagePort extends EventTarget {
  // Sending
  postMessage(message: any, transfer?: Transferable[]): void;
  postMessage(message: any, options?: StructuredSerializeOptions): void;

  // Control
  start(): void;   // begin dispatching queued messages (implicit when onmessage is set)
  close(): void;

  // Events: 'message', 'messageerror'
  onmessage: ((ev: MessageEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
}

class MessageEvent extends Event {
  readonly data: any;
  readonly origin: string;
  readonly lastEventId: string;
  readonly source: MessagePort | null;
  readonly ports: readonly MessagePort[];
}
```

**Spec semantics:**
- `new MessageChannel()` creates two entangled ports — messages sent to `port1` are received on `port2` and vice versa.
- Messages are dispatched asynchronously (queued microtasks for same-thread; async delivery for cross-thread/process).
- Messages queue until `start()` is called or `onmessage` is assigned (implicit start).
- `close()` permanently severs the connection. Subsequent `postMessage` calls are silently dropped.
- `MessagePort` is itself transferable — it can be sent through another `postMessage` and re-entangled in the destination.

**Note on `MessageEvent`**: The current `MessageEvent` in `websocket.mts` should be extracted into a shared module (`js/internal/globals/messaging.mts`) and used by both WebSocket and MessagePort. The same class also appears (implicitly) in EventSource. Unifying these avoids three separate definitions.

---

## Transport Layer

The transport is selected at Realm creation time and encapsulated behind MessagePort. User code never sees which transport is in use.

### IntraPort — Same-Thread

For embedded Realms (same V8 Isolate/thread).

- `postMessage(msg, transfer)` calls `structuredClone(msg, { transfer })` synchronously, then queues a microtask on the receiving port.
- Zero serialization overhead — the cloned value is a live JS object passed directly.
- Entanglement via direct JS object reference (or `WeakRef` to allow GC if one side is dropped).

This is the simplest transport and is also the foundation for testing the messaging API before more complex transports are built.

### ThreadPort — Cross-Thread

For thread Realms (separate V8 Isolates).

- Sender: `postMessage(msg, transfer)` → `ValueSerializer.serialize(msg, transfer)` → send bytes through Rust `mpsc` channel → write a byte to the receiver's wake pipe
- Receiver: kqueue event on wake pipe → drain channel → `ValueDeserializer.deserialize(bytes)` → queue microtask

The wake pipe is a real OS pipe registered with the receiver's kqueue/io_uring. When the sender writes a byte, the receiver's `_wait()` call returns with a pipe-readable event. This integrates naturally with the existing event loop without any special threading machinery in JS.

```
Sender thread:                    Receiver thread:
  JS postMessage()                   kqueue polls wake pipe
  → ValueSerializer → bytes          ← byte arrives
  → mpsc::send(bytes)                → drain channel
  → write(wake_pipe, 1)              → ValueDeserializer
                                     → queue microtask
                                     → port.dispatchEvent('message')
```

### PipePort — Cross-Process

For process Realms.

- Backed by a unix socket pair (created before `fork(2)`, one fd per side).
- Wire format: 4-byte LE length prefix + V8-serialized payload.
- Both sides use the event loop's `readable()`/`writable()` for async delivery.
- The child's MessagePort is connected to fd 3 (passed by convention at process start).

Using `ValueSerializer` bytes over a pipe means the same wire format works for both PipePort and NetPort — the framing is identical, only the transport fd differs.

### NetPort — Remote Realms

For Realms on other machines.

- Backed by a WebSocket connection (binary frames).
- Same 4-byte LE length prefix + V8-serialized payload as PipePort.
- WebSocket binary frames provide natural framing without additional length prefixing (redundant but harmless).
- TLS for encryption. Authentication via shared secret or mTLS.

---

## V8 ValueSerializer / ValueDeserializer

Cross-Isolate message passing requires V8's native binary serialization. The existing pure-JS `structuredClone` produces live JS objects — these cannot cross Isolate boundaries.

V8's `ValueSerializer` and `ValueDeserializer` are the underlying mechanism browsers use for `postMessage`. They handle all the same types as `structuredClone` plus:
- `SharedArrayBuffer` (as a shared buffer reference)
- `MessagePort` transfer (detach + serialize the port identity)
- True `ArrayBuffer` detachment (not the `resize(0)` approximation in the current JS implementation)

New file: `src/serializer.rs` — exposes `serialize(value, transferList)` → `Uint8Array` and `deserialize(bytes, portMap?)` → `any` as a synthetic builtin module `internal:serializer`.

This module is used by `ThreadPort`, `PipePort`, and `NetPort`. `IntraPort` continues to use the JS-level `structuredClone`.

---

## MessagePort Transferability

The spec requires `MessagePort` to be transferable via `postMessage(msg, [port])`. This means:
1. The port is **detached** from its current entanglement in the sender
2. The port identity is serialized (for cross-thread/process: as an index into a transfer map)
3. The port is **re-entangled** at the destination with the appropriate transport backing

For IntraPort (same-thread): detaching means the port's reference to its partner is removed in the sender's context and a new entanglement is established in the receiver's context.

For ThreadPort/PipePort: the port identity (a unique ID) is serialized. The Rust layer maps port IDs to channel endpoints. When the port arrives at the destination, a new channel is established or an existing one is re-pointed.

This is the most complex part of the MessagePort spec. It can be deferred — the initial implementation can support `postMessage` without port transfer in the transfer list.

---

## SharedArrayBuffer + Atomics

V8 provides `SharedArrayBuffer` and `Atomics` natively across Isolates when both Isolates use the same `SharedArrayBufferAllocator`. No custom implementation required.

**Constraints**:
- `Atomics.wait()` blocks the calling thread. This must not be allowed on the main orchestrator thread (would block the event loop and all embedded Realms).
- `Atomics.notify()` is non-blocking and can be called from any thread.
- `Atomics.waitAsync()` (spec proposal) is non-blocking and is the correct form for event loop threads.

**Enforcement**: On the main thread, `Atomics.wait()` returns `"not-allowed"` (matching browser behavior). In thread Realms, `Atomics.wait()` works normally because each thread has its own event loop.

**When**: Enable with thread Realms. Not needed for embedded Realms (same Isolate, no `SharedArrayBuffer` across contexts needed) or process Realms (separate processes cannot share memory).

---

## Wire Protocol (Cross-Process + Remote)

```
┌─────────────────┬─────────────────────────────────────────────┐
│  Length (4 bytes│  Payload (N bytes)                           │
│  LE uint32)     │  V8-serialized value                         │
└─────────────────┴─────────────────────────────────────────────┘
```

Simple and symmetric. No channel multiplexing in the initial design — each port connection gets its own socket/pipe. Multiplexing can be added later if the overhead of many file descriptors becomes a concern.

**Versioning**: The first 4 bytes of the payload (within the V8 serialized data) contain V8's serialization format version. No additional versioning needed unless Fino-specific extensions are added to the framing.

---

## Open Questions

**Q5**: The existing `structuredClone` approximates `ArrayBuffer` detachment by zeroing or resizing the buffer. With `ValueSerializer`, true detachment is available. Should the JS-level `structuredClone` be reimplemented on top of `internal:serializer` for correctness? Or keep them separate (JS clone for same-Realm use, ValueSerializer for cross-Realm)?
- Leaning: Keep separate. `structuredClone` in the spec is defined to work synchronously on the current Realm. The encoding.mts implementation is correct for its use case. Cross-Realm transfer uses the ValueSerializer path exclusively.

**Q6**: `BroadcastChannel` — broadcast to all Realms sharing the same origin. Is this needed?
- Not needed initially. The pool pattern covers the primary use cases. Can be added later.

**Q7**: How does `MessagePort` transfer work when the port's backing is `ThreadPort` or `PipePort`? The transport endpoint needs to move, not just the port identity.
- This requires a protocol for "re-binding" a port to a new owner. The Rust layer maintains a registry of port ID → channel endpoint. When a port is transferred, the endpoint is moved in the registry. This is non-trivial and should be deferred after the basic MessagePort works.

**Q8**: Should the wire format include a message type byte to distinguish data messages from control messages (port transfer, close signal, error)?
- Yes. A 1-byte type field should precede the V8 payload to avoid ambiguity. This can be established as part of the protocol definition.
