# HttpClient load-generator readiness

## Purpose

This is the prerequisite workstream for using `HttpClient` as the sole HTTP
transport at the core of the proposed load generator. It is intentionally
separate from [the load-testing command plan](./load-testing.md), which assumes
these capabilities already exist.

The objective is not to add benchmark-specific shortcuts to `HttpClient`.
Each item should become a generally useful client capability with focused
protocol tests; the load engine should only configure and observe those public
capabilities.

## Implementation status

The readiness work described below is implemented. `HttpClient` now provides:

- header-first, bounded response streaming and protocol-local cancellation for
  HTTP/1.1, HTTP/2, and HTTP/3;
- `discard('consume' | 'cancel')`, with black-hole byte counting in consume mode;
- reusable non-pipelined HTTP/1.1 slots and bounded multiplexed H2/H3 slots;
- flow-control-coupled HTTP/2 streaming uploads (64 KiB maximum staged chunk);
- configurable connection count, per-connection stream concurrency, pending
  queue bound, and per-stream unread response bound;
- stable physical connection IDs, reuse flags, multiplexed stream IDs, capacity
  snapshots, and monotonic queue/header/first-byte/body-end timing marks;
- explicit `null` values for transport phases the current adapter cannot observe,
  rather than fabricated DNS/connect/TLS/request-flush timestamps;
- headers, body-idle, and total deadlines; replay-safe idempotent retries; and a
  transparent decompression switch;
- HTTP/3 cancellation using H3 cancellation plus QUIC STOP_SENDING/RESET_STREAM,
  without closing unrelated streams or their connection.

The native H3 lane is active on Linux with libnghttp3 and ngtcp2. Library
discovery accepts the Fedora/Nobara `libnghttp3.so.9` runtime soname, and the
forced H3 suites run without availability skips.

## Required work, in order

### 1. Finish response lifecycle parity — complete

- Apply the shared bounded response queue and cancellation contract to every
  persistent protocol path.
- For HTTP/3, translate early response disposal to stream-local
  `STOP_SENDING`/`RESET_STREAM` with `H3_REQUEST_CANCELLED`; remove the pending
  request without closing the QUIC connection. Reset unread responses when the
  body queue reaches its configured bound.
- Make abort after final headers behave like explicit body cancellation on H2
  and H3. Abort before headers must reject the request and release its stream.
- Specify and test trailer behavior after EOF, cancellation, reset, GOAWAY, and
  transport failure.
- Add a `discard()` convenience with explicit `consume` and `cancel` policies,
  or equivalently document a small stable helper. `consume` must count/drop each
  chunk and preserve reuse; `cancel` must expose that it can reduce server work.

Exit criteria: gated-stream tests prove header-first resolution and chunk-first
delivery for H1/H2/H3; cancellation and overflow tests prove bounded memory,
prompt resource release, and reuse of unaffected multiplexed streams.

### 2. Add real HTTP/1.1 pooling — complete

- Replace unconditional `Connection: close` with an origin- and TLS-identity
  keyed pool.
- Lease one request at a time per H1 connection by default. Keep pipelining an
  explicit later option because response ordering and cancellation make its
  failure model materially different.
- Return a connection only after the response reaches EOF. Cancelling an unread
  H1 body closes that physical connection unless the client deliberately drains
  the known remainder.
- Bound idle connections, total connections, acquisition waiters, idle time,
  and connection lifetime. Define deterministic eviction and shutdown.

Exit criteria: sequential requests demonstrably reuse a connection, configured
parallel requests use no more than the requested connection count, malformed or
cancelled responses poison only their connection, and queued acquisition obeys
abort and timeout signals.

### 3. Stream HTTP/2 uploads — complete

- Replace `Request.arrayBuffer()` in the pooled H2 sender with an async body
  producer coupled to nghttp2's DATA-provider and flow-control callbacks.
- Bound queued outbound data and stop pulling while the peer or connection
  window is exhausted.
- Propagate source errors and aborts as stream-local resets. Ensure early final
  responses can stop a still-running upload without damaging other streams.
- Preserve request trailers by submitting them only after body EOF.

Exit criteria: a gated server observes the first upload chunk before the source
finishes; large uploads stay within the configured queue bound; cancellation,
source failure, trailers, and multiplexed concurrent upload/download cases are
covered.

### 4. Expose deterministic capacity controls — complete

- Add client/session options for physical connections per origin, maximum
  concurrent streams per H2/H3 connection, H1 acquisition concurrency, pending
  queue capacity, and queue-overflow policy.
- Respect peer-advertised H2/H3 stream limits. Queue fairly when local or peer
  capacity is exhausted and wake exactly one eligible waiter when capacity
  returns.
- Expose current capacity and queue depth as snapshots or low-overhead events so
  a load scheduler can distinguish client queueing from network latency.

Exit criteria: deterministic tests cover saturation, fairness, peer limit
changes, cancellation while queued, GOAWAY replacement, and graceful shutdown
with queued and active work.

### 5. Report real connection identity and high-resolution timings — complete

- Assign IDs when physical TCP/TLS/QUIC connections are created, not when a
  response wrapper is constructed. Reused responses must report the same ID.
- Use a monotonic high-resolution clock and expose scheduled/start, queue wait,
  DNS, connect, TLS/QUIC handshake, request headers end, request body end, final
  response headers, first response byte, and response end where meaningful.
- Mark phases unavailable or reused rather than fabricating timestamps. Record
  negotiated ALPN, connection reuse, and stream ID separately from the logical
  session ID.
- Keep the observation path allocation-conscious: immutable per-response marks
  plus optional batched lifecycle events are preferable to a general event for
  every body chunk.

Exit criteria: timing-order invariants are tested with a fake clock where
possible, connection IDs remain stable across reuse and change on reconnect,
and each protocol reports unsupported phases explicitly.

### 6. Normalize timeout, retry, and content policies — complete

- Apply connect, headers, body-idle, and total deadlines consistently to queued
  acquisition and all three HTTP versions.
- Keep automatic retry above the transport and require both idempotence and a
  replayable body. Surface refused streams and GOAWAY distinctly so callers can
  make that decision.
- Add an option to disable automatic decompression. A load test needs to choose
  whether it measures encoded wire bytes, decoded application bytes, or both.
- Preserve current redirect controls and make every implicit replay visible in
  response metadata.

Exit criteria: a protocol matrix proves equivalent error categories and cleanup
for each deadline and abort point, and retries never replay a one-shot body.

## Verification matrix

| Contract | H1 | H2 | H3 |
| --- | --- | --- | --- |
| Resolve at final headers | regression test | regression test | regression test |
| Deliver chunks before EOF | regression test | regression test | regression test |
| Bounded unread response | connection close | stream reset | stream reset |
| Consume/drop and reuse | connection reuse | stream reuse | stream reuse |
| Cancel and release | close connection | `RST_STREAM(CANCEL)` | H3 cancel + QUIC reset |
| Streaming upload | chunked/fixed framing | DATA provider | QUIC/H3 body source |
| Abort while queued/headers/body | required | required | required |
| Stable physical connection ID | required | required | present; verify |
| High-resolution phase timings | required | required | required |

Run the narrow protocol suites after each stage, then run
`tests/net/http-client.test.ts`, `tests/net/http-pool.test.ts`, and
`tests/internal/globals/fetch.test.ts` together. Platform-gated H3 coverage must
also run in an environment with QUIC, nghttp3, and TLS support before the
readiness workstream is declared complete.
