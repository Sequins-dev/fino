# Load-testing command plan

## Goal

Add a first-party `fino load` command for repeatable HTTP/1.1, HTTP/2, and
HTTP/3 load tests. The command should be useful for a quick local throughput
check, while its engine and result model also support scripted, stateful
protocols such as SSE, WebSocket, WebTransport, and raw QUIC.

This is a living design and status document rather than a compatibility
specification. Option names can still evolve, but the workload and measurement
semantics should remain stable.

## Implementation status

The HTTP command and scripted scenario runtime are implemented by `fino:load`
and `fino load`. The shipped HTTP path has closed-loop or controlled-arrival
runs, warmup, explicit H1/H2/H3 selection, connection and multiplexed-stream
limits, bounded streaming response consumption, headers-only cancellation,
status/body expectations, timeouts, replay-safe retries, text output, and a
versioned JSON result.

The first implementation deliberately requires `h1`, `h2`, or `h3` instead of
offering `auto`: explicit selection preserves the requested workload and fails
when a peer cannot speak it. Safe automatic negotiation needs `HttpClient` to
adapt per-slot capacity after ALPN so an H1 fallback is never scheduled like a
multiplexed connection. Phase 2 now adds bounded fixed-rate and linear-ramp
scheduling, intended-arrival latency, reconnect cadence, streaming body
expectations, bailouts, and the TypeScript scenario API. Multi-target and
generated-data workloads deliberately belong in scenarios rather than the
maximum-throughput HTTP path. Phase 3 is available through controlled scenario
clients for SSE, WebSocket, WebTransport, and raw QUIC, with application framing
and success criteria kept inside the script. Cross-realm worker sharding remains
deferred until profiling shows the generator reactor is the bottleneck.

## Design principles

- Stream request and response bodies end to end. Never materialize a complete
  body unless a scenario explicitly asks to inspect it.
- Separate connection concurrency from protocol stream concurrency. They are
  different controls for HTTP/2, HTTP/3, WebTransport, and QUIC.
- Make full-response completion the default success boundary. Read chunks,
  count their bytes, and immediately drop them so memory remains bounded.
- Expose headers-only cancellation as a distinct mode. It changes the server
  workload and must not be presented as equivalent to consuming a response.
- Support both closed-loop concurrency and open-loop arrival rates. Fixed-rate
  tests must report offered, achieved, and dropped or late work so coordinated
  omission is visible.
- Keep measurement in a protocol-neutral core and put wire behavior behind
  adapters. Protocol-specific metrics remain available alongside the common
  summary.
- Make warmup, duration, timeouts, TLS identity, and protocol selection
  explicit in machine-readable output so runs can be reproduced.
- Prefer bounded queues and incremental histograms over per-request result
  retention. The generator must be able to sustain more load than the target.

## Prior art to retain

[`h2load`](https://nghttp2.org/documentation/h2load-howto.html) has the right
separation between total requests (`-n`), clients/connections (`-c`), and
concurrent streams per client (`-m`). Its duration and warmup modes, ALPN
selection, connection and stream flow-control settings, native worker threads,
round-robin URIs, and distinct connect/TTFB/request timing are useful models.

[`autocannon`](https://github.com/mcollina/autocannon) provides a friendlier
HTTP/1.1-oriented CLI model: connections, pipelining, duration versus amount,
warmup, worker threads, request and connection rate limits, reconnect cadence,
bailout thresholds, expected bodies, status-code summaries, percentile output,
and JSON output. Its open-loop rate support and coordinated-omission reporting
are especially important.

Fino should not clone either interface exactly. It needs one vocabulary that
continues to make sense for multiplexed and long-lived protocols.

## Proposed command shape

```text
fino load https://localhost:3000/users/123 \
  --protocol h2 \
  --connections 100 \
  --streams 10 \
  --duration 30s \
  --warmup 5s
```

Initial options:

| Concern | Proposed options | Notes |
| --- | --- | --- |
| Target | URL positional, `--method`, `--header`, `--body`, `--body-file` | Static mode repeats one request; TypeScript scenarios cover multiple or varying requests. |
| Protocol | `--protocol h1\|h2\|h3` | Explicit modes fail instead of silently falling back. Safe `auto` remains future work. |
| Load | `--connections`, `--streams` | `--streams` applies to multiplexed protocols; HTTP/1.1 pipelining is not currently exposed. |
| Stop condition | `--duration` or `--requests` | Mutually exclusive measured-run boundaries. |
| Arrival model | `--rate`, `--rate-to` | No rate means closed-loop saturation; `--rate-to` creates a linear ramp. |
| Lifecycle | `--warmup`, `--timeout`, `--connect-timeout`, `--reconnect-after` | Warmup data is excluded but warm connections may carry into the measured phase. |
| Response | `--response consume\|cancel`, `--expect-status`, `--expect-body` | `consume` streams and black-holes chunks. `cancel` stops after final headers and is labeled headers-only. Body matching is incremental. |
| TLS | `--ca`, `--cert`, `--key`, `--insecure` | Output records non-secret TLS policy without leaking key material. |
| Output | `--json`, `--quiet`, `--title` | JSON gets a versioned schema suitable for run-to-run comparison. |

`--response consume` should be the default. It measures final response
completion, maintains HTTP/1.1 connection framing, increments a byte counter
per chunk, and drops the chunk reference immediately. `--response cancel`
measures final-header latency and then performs protocol-aware cancellation:

- HTTP/1.1 closes the connection unless the known remaining body is deliberately
  drained; unread bytes cannot safely remain on a reusable connection.
- HTTP/2 sends `RST_STREAM` with `CANCEL` and keeps the connection available.
- HTTP/3 cancels the request stream with the corresponding H3/QUIC operation and
  keeps unrelated streams available.

Results must identify the response policy because cancellation can make a
server do substantially less work.

## Engine architecture

```text
CLI / TypeScript scenario
          |
          v
workload scheduler ---- connection workers
          |                    |
          |                    v
          |              protocol adapter
          |             h1 / h2 / h3 / ...
          v                    |
metrics recorder <------------+
          |
          v
text reporter / versioned JSON
```

1. **Workload scheduler** — owns warmup and measurement phases, closed-loop
   concurrency, open-loop arrival times, deadlines, and graceful shutdown.
2. **Connection workers** — own connection lifecycle and protocol concurrency.
   Start with several workers in one realm; add process or realm sharding after
   profiling proves the generator is CPU-bound.
3. **Protocol adapters** — expose connect, start operation, stream events,
   cancellation, and close. Adapters report protocol metadata without changing
   common success and latency definitions.
4. **Metrics recorder** — uses the shared internal running-statistics and
   logarithmic-histogram primitives alongside workload counters. Workers merge
   bounded interval summaries rather than sending one event per request to a
   coordinator.
5. **Reporters** — render a live terminal view, final summary, and a stable JSON
   document from the same result object.

The first implementation should use Fino's existing HTTP client stack. That
exercises the runtime users actually depend on and avoids introducing a second
HTTP implementation merely for benchmarks. A lower-level adapter can be added
later when the purpose is wire saturation rather than runtime benchmarking.

This plan assumes `HttpClient` is already ready to serve as that core: it can
hold a configured number of persistent connections, schedule multiplexed
streams, stream uploads and downloads with bounded memory, drain or cancel
responses with protocol-correct connection reuse, expose stable connection
identity and high-resolution phase timings, and apply abort and timeout policy
consistently across HTTP versions. Those capabilities are prerequisites being
addressed separately and are not phases of the load-generator project.

## Measurement contract

Common timestamps and outcomes:

- scheduled time, actual start time, queue delay, connection start, secure
  connection ready, request headers sent, final response headers received,
  first response body byte, and response end;
- connect, TLS/QUIC handshake, TTFB, download, and total latency histograms;
- offered, started, completed, successful, status-failed, timed-out, cancelled,
  transport-failed, and scheduler-dropped operation counts;
- requests/operations per second, wire or application body bytes per second,
  status distribution, active connections, and active streams;
- negotiated protocol/ALPN, connection reuse, reconnects, HTTP/2 resets and
  GOAWAY, and HTTP/3/QUIC resets and connection closes where available.

Use a mergeable high-dynamic-range histogram or equivalent bounded structure.
Report at least min, mean, standard deviation, p50, p75, p90, p95, p99, p99.9,
and max. For fixed-rate runs, latency begins at the scheduled arrival time so
queueing delay is not omitted.

A completed HTTP operation means the selected response policy completed:
body EOF in `consume` mode, or successful stream cancellation in `cancel` mode.
Status validation is separate from transport completion.

## TypeScript scenarios

Static CLI flags cover a single endpoint well, but application protocols need
state and event-driven behavior. Add `--scenario load.ts` after the core engine
is stable. A scenario module should export configuration plus lifecycle hooks,
using bounded per-virtual-user state:

```ts
import type { LoadScenario } from 'fino:load';

export default {
  protocol: 'websocket',
  async session(client, context) {
    const socket = await client.websocket('wss://localhost:3000/chat');
    await socket.send(JSON.stringify({ type: 'join', room: context.userId }));
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      await socket.send(JSON.stringify({ type: 'ping', sequence: i }));
      await new Promise((resolve) => {
        socket.addEventListener('message', resolve, { once: true });
      });
      context.metric('round_trip_ms', performance.now() - started);
    }
    await socket.close();
  },
} satisfies LoadScenario;
```

Hooks should receive controlled clients, timers, metrics, logging, and
cancellation. They should not receive engine internals.
The runner should cap queued events, per-session state, custom metric names,
and log volume. Scenario exceptions fail the virtual user and appear by error
class in the result.

## Stretch protocol adapters

### Server-Sent Events

SSE is one long-lived streaming HTTP response, so requests-per-second is not
the main metric. Model connect/reconnect behavior from the
[HTML SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)
and report connection success, time to open, time to first event, event rate,
event byte rate, inter-event gap, parse failures, disconnects, retry delay, and
last-event-id continuity. Scenarios define event predicates and a session
duration or event-count completion condition.

### WebSocket

Follow [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html) and model a
session as handshake, optional setup messages, a scripted send/receive loop,
and close. Report upgrade latency, active sockets, messages and bytes in each
direction, round-trip latency for correlated messages, unsolicited-message
rate, ping/pong latency, abnormal closes, and close-code distribution. The
script must define correlation and success because WebSocket itself does not.

### WebTransport

Use the [WebTransport specification](https://www.w3.org/TR/webtransport/)
surface: session establishment, bidirectional and unidirectional streams, and
datagrams. Scenarios choose stream counts, message framing, datagram loss or
expiry expectations, and whether streams are reused. Measure session setup,
stream-open latency, concurrent streams, per-direction throughput, message
round trips, datagram delivery/loss/reordering, resets, and session close data.

### Raw QUIC

Raw QUIC scenarios sit below HTTP semantics and follow
[RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html). They must supply an
ALPN value and application framing script. Support connection churn, 0-RTT as a
separate explicitly labeled mode, uni/bidirectional stream patterns, datagrams
when negotiated, flow-control pressure, stream resets, migration experiments,
and clean versus abrupt connection close. Report handshake/resumption outcome,
stream-open latency, goodput, datagram behavior, flow-control stalls, transport
errors, and close-code distribution. Never combine 0-RTT and 1-RTT results.

## Delivery phases

### Phase 1: HTTP command MVP — complete

- Add `fino:load` for engine types/results and `fino:commands/load` for CLI
  wiring, then register the command and add benchmark coverage-table entries.
- Implement duration/request-count closed-loop runs for H1, H2, and H3.
- Implement connection and stream concurrency, warmup, timeouts, streaming
  black-hole consumption, status counts, latency histograms, text output, and
  versioned JSON.
- Cross-check representative H1/H2 results against autocannon and h2load. Exact
  rates need not match, but workload shape and measurement boundaries must.

### Phase 2: controlled arrival and richer workloads — complete except sharding

- Fixed-rate scheduling, coordinated-omission-safe timestamps, linear ramps,
  reconnect cadence, streaming body expectations, bailouts, and the TypeScript
  scenario API are implemented.
- Static HTTP intentionally has one fixed target and no random-data generation;
  multi-target or varying workloads compose those primitives in a scenario.
- Worker sharding is explicitly deferred pending self-profiling. When added, it
  must preserve total connection/rate semantics and merge raw histogram buckets
  rather than average worker percentiles.

### Phase 3: long-lived protocols — complete as scripted adapters

- Scenario clients own SSE, WebSocket, WebTransport, and raw QUIC resources and
  close them when a session returns or throws.
- Scripts define event/message predicates, framing, correlation, datagram
  expectations, and success. They report application bytes/messages and custom
  bounded histograms through the scenario context.
- Scheduler queues, metric-name cardinality, error classes, and log calls are
  bounded. Raw QUIC still requires an explicit ALPN and 0-RTT remains an
  application policy that must be labeled separately by the scenario.

## Validation strategy

- Deterministic fake-clock unit tests for scheduler rate, warmup boundaries,
  stop conditions, timeout races, and histogram merging.
- Loopback integration tests for every supported protocol and response policy.
- Slow/gated streams proving headers and chunks are observable before EOF.
- Large and unconsumed bodies proving bounded memory and correct cancellation.
- Connection reuse, stream reset, GOAWAY, server close, malformed response,
  refused stream, and partial-body failure tests.
- Golden tests for text summaries and schema tests for versioned JSON output.
- Generator self-profiling under an intentionally trivial server, with a clear
  warning when CPU, event-loop lag, or achieved rate shows client saturation.
- Comparative smoke runs against h2load and autocannon in CI or a documented
  manual benchmark lane; avoid brittle assertions on absolute throughput.

## Decisions after Phase 1

- The stable engine API is public as `fino:load`; scheduling and recording
  helpers remain internal.
- Latencies use a fixed-size logarithmic histogram with exact count, minimum,
  mean, population standard deviation, and maximum.
- Phase 1 stays in one reactor. Realms or processes should follow profiling and
  worker-sharding requirements rather than being assumed upfront.
- `consume` counts decoded application bytes by default and encoded bytes with
  decompression disabled. The client does not yet expose both simultaneously.
- Protocol-specific flow-control tuning remains advanced future work; the
  common CLI currently exposes only connection, stream,
  pending-request, and unread-response bounds.
