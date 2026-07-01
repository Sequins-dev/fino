# HTTP/2 Correctness Audit

Triggered by: `curl: (55) Send failure: Broken pipe` errors against the fino HTTP/2 server.

---

## Root cause — `async: true` on non-blocking nghttp2 functions

### What `async: true` does

In fino's FFI layer, `async: true` on a symbol dispatches the C call to a Rust blocking-thread pool and returns a Promise. The V8 thread does **not** block — it continues draining microtasks and running other JavaScript while the pool thread executes the C function.

### Why it is wrong here

`nghttp2_session_mem_recv2` and `nghttp2_session_mem_send2` are **pure in-memory functions**. They parse or serialize HTTP/2 frames from/into a caller-supplied buffer. No I/O, no syscalls, no sleeping. They are not blocking in any meaningful sense.

The only reason they were given `async: true` is the FfiCallback problem: nghttp2 invokes registered callbacks (on-begin-headers, on-header, on-data-chunk, etc.) synchronously during `recv2`. If `recv2` runs on a pool thread, those callbacks fire from that pool thread and need to cross back to the V8 thread via the condvar bridge. That bridge mechanism is the *only* motivation — not any inherent blocking in the functions themselves.

### The data race this creates

Because `async: true` dispatches to a pool thread, and the V8 thread remains free:

1. The recv loop calls `await session.recv(bytes)` — dispatches `recv2` to the pool.
2. The V8 event loop continues. A `dispatchStream` microtask wakes up (its handler `await` resolved).
3. That microtask calls `session.submitResponse(...)` → `nghttp2_submit_response2` synchronously on the V8 thread.
4. Simultaneously, the pool thread is inside `nghttp2_session_mem_recv2` parsing frames and updating session state.
5. Two OS threads are accessing the same `nghttp2_session*` struct. nghttp2 is not thread-safe. **Data race.**

The same applies to `nghttp2_session_mem_send2` racing with any submit call.

### Every unprotected synchronous nghttp2 call

All of these are called from the V8 thread with no serialization against pool-thread `recv2`/`send2`:

| Call site | Function |
|---|---|
| `submitResponse` | `nghttp2_submit_response2` |
| `submitRequest` | `nghttp2_submit_request2` |
| `submitSettings` | `nghttp2_submit_settings` |
| `submitTrailer` | `nghttp2_submit_trailer` |
| `submitGoaway` | `nghttp2_submit_goaway` |
| `submitRstStream` | `nghttp2_submit_rst_stream` |
| `resumeData` | `nghttp2_session_resume_data` |
| `wantWrite` | `nghttp2_session_want_write` |
| `wantRead` | `nghttp2_session_want_read` |
| `upgradeFromH1` | `nghttp2_session_upgrade2` |

### How this produces "Broken pipe"

When the race corrupts nghttp2's internal state, one of these follows:

- `recv2` returns a negative error code on the next call. `processValidatedBytes` sees `n < 0`, exits the recv loop, and the connection is torn down. curl, still sending the request body, gets EPIPE.
- nghttp2 emits a malformed or spurious RST_STREAM/GOAWAY. The client rejects it and resets the TCP connection. The server's next write gets EPIPE.
- The HPACK compression table is corrupted, producing headers the client cannot decode, causing a connection error on the client side.

### The fix

Remove `async: true` from both symbols in `bindings.ts`:

```ts
nghttp2_session_mem_recv2: {
  parameters: ['pointer', 'pointer', 'usize'],
  result: 'isize',
  // no async: true
},
nghttp2_session_mem_send2: {
  parameters: ['pointer', 'pointer'],
  result: 'isize',
  // no async: true
},
```

With synchronous calls, `recv2` runs on the V8 thread. JavaScript is single-threaded, so nothing else can execute during the call. FfiCallbacks fire inline on the same thread — no condvar bridge needed. All submit functions are also on the V8 thread and cannot interleave. The race disappears at its root without any mutex changes.

`recv()` and `flush()` on `Nghttp2Session` become synchronous. `drainWrite` no longer needs to `await` them. The session-level `#mu` mutex is no longer needed and can be removed.

**Performance:** A single `recv2` call parses one kernel read's worth of frames from an in-memory buffer. At typical HTTP/2 max-frame sizes (≤16 KiB per frame, one frame per read), this is microseconds of CPU — less than the cost of the condvar round-trip to the pool and back. The 16 KiB frame size limit already enforced by `H2ServerFrameValidator` bounds the worst case.

---

## Secondary bug — `drainChain` permanently poisoned after first write failure

**Files:** `server.ts:663`, `client.ts:122`

```ts
function drainWrite(): Promise<void> {
  drainChain = drainChain.then(async function drainH2Writes() {
    ...
    await writer.write(bytes);   // if this rejects, drainChain stays rejected forever
    ...
  });
  return drainChain;
}
```

If any `writer.write()` call rejects (e.g., the first broken-pipe error on the TCP socket), `drainChain` becomes a permanently rejected promise. Every subsequent `drainChain.then(fn)` skips `fn` — the callback never runs. For the rest of the connection lifetime, every `drainWrite()` call returns a pre-rejected promise silently.

Consequences:
- SETTINGS ACKs are never sent. Per RFC 9113 §6.5, the peer must treat an unacknowledged SETTINGS as a connection error (SETTINGS_TIMEOUT) and close. If curl times out waiting for an ACK and closes first, any concurrent server write then gets EPIPE.
- WINDOW_UPDATE frames are never sent after the first failure. The peer's send window stays exhausted. The peer stops sending and eventually times out or resets.
- The final GOAWAY at shutdown is silently dropped.

**Fix:** Run each drain task unconditionally whether the previous one resolved or rejected:

```ts
function drainWrite(): Promise<void> {
  drainChain = drainChain.then(drainH2Writes, drainH2Writes);
  return drainChain;
}
```

Or absorb rejections from the chain so the next entry always gets a clean start:

```ts
function drainWrite(): Promise<void> {
  drainChain = drainChain
    .catch(() => {})
    .then(drainH2Writes);
  return drainChain;
}
```

Either way, a write failure on one flush attempt should not prevent future attempts on the same connection.

---

## Minor issue — `buildNvArray` encodes header strings twice

**File:** `bindings.ts:1094–1130`

`buildNvArray` first maps headers to `Uint8Array` blobs to compute `totalData`, then re-encodes the same strings inside the main loop. The pre-computed `dataBlobs` array is allocated and then never read. Not a correctness issue — the re-encoded values are identical — but wastes two allocations per header.

---

## Non-issues considered

**`nghttp2_session_consume` inside `#lock`:** This call is made synchronously after `recv2` completes, still inside the `#lock` callback. It is safe — no concurrent pool access at that point.

**`close()` not behind `#mu`:** `session.close()` is called only in the finally block of `_recvLoop`, after `await Promise.all([...inFlight])` has drained all handler tasks and their `drainWrite` calls. By that point no pool operation is in progress. Safe by convention.

**Dual stream-limit counting:** `H2ServerFrameValidator` counts open streams via `#openStreams` (only 'open' state streams). The application callbacks count via `streams.size` (all active streams including 'halfClosedRemote'). The two can disagree on the exact limit boundary. In practice the validator gate fires first and is the binding check; the application gate is a second layer that may be slightly more conservative. No observed correctness failure from this.

**Flow-control stall:** When the outbound window is exhausted, `drainWrite` breaks early. WINDOW_UPDATE frames queued by `nghttp2_session_consume` are picked up by the next `drainWrite` call after the next `recv()`. Not a stall — just deferred by one recv/drain cycle.

---

## Summary

| Issue | Severity | Fix |
|---|---|---|
| `async: true` on `recv2`/`send2` → data race with all synchronous nghttp2 calls | Critical | Remove `async: true`; make `recv`/`flush` synchronous; remove `#mu` |
| `drainChain` permanently poisoned after first write error | High | Run drain tasks unconditionally past prior failures |
| `buildNvArray` double-encodes header strings | Cosmetic | Remove the unused `dataBlobs` pre-pass |
