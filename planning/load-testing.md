# Load-testing command plan

## Goal

Add a first-party `fino load` command for repeatable HTTP/1.1, HTTP/2, and
HTTP/3 load tests. The command should be useful for a quick local throughput
check, but its engine and result model should also support scripted,
stateful protocols such as SSE, WebSocket, WebTransport, and raw QUIC later.

This is a plan, not an implementation specification. The exact option names
can change after a CLI prototype, but the workload and measurement semantics
should remain stable.

## Implementation status

Phase 1 is implemented by `fino:load` and `fino load`. The shipped command has
closed-loop duration or exact-request runs, warmup, explicit H1/H2/H3
selection, connection and multiplexed-stream limits, bounded streaming
response consumption, headers-only cancellation, status expectations,
timeouts, replay-safe retries, text output, and a versioned JSON result.

The first implementation deliberately requires `h1`, `h2`, or `h3` instead of
offering `auto`: explicit selection preserves the requested workload and fails
when a peer cannot speak it. Safe automatic negotiation needs `HttpClient` to
adapt per-slot capacity after ALPN so an H1 fallback is never scheduled like a
multiplexed connection. Open-loop rates, worker sharding, weighted requests,
TypeScript scenarios, SSE, WebSocket, WebTransport, and raw QUIC remain Phase 2
and Phase 3 work.

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
- Make warmup, duration, timeouts, TLS identity, protocol selection, and random
  seeds explicit in machine-readable output so runs can be reproduced.
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
| Target | URL positional, `--method`, `--header`, `--body`, `--body-file` | Multiple targets can be round-robin or weighted in a scenario file. |
| Protocol | `--protocol auto\|h1\|h2\|h3` | `auto` records the negotiated protocol; forced modes fail instead of silently falling back. |
| Load | `--connections`, `--streams`, `--pipelining` | `--streams` applies to multiplexed protocols; `--pipelining` is an explicit HTTP/1.1 expert option. |
| Stop condition | `--duration` or `--requests` | Mutually exclusive measured-run boundaries. |
| Arrival model | `--rate`, `--rate-model constant\|closed` | No rate means closed-loop saturation. A later phase can add ramp and step schedules. |
| Lifecycle | `--warmup`, `--timeout`, `--connect-timeout`, `--reconnect-after` | Warmup data is excluded but warm connections may carry into the measured phase. |
| Response | `--response consume\|cancel`, `--expect-status`, `--expect-body` | `consume` streams and black-holes chunks. `cancel` stops after final headers and is labeled headers-only. Body matching opts into buffering or a streaming matcher. |
| TLS | CA, client certificate/key, SNI, insecure-development flag | Output records TLS and negotiated ALPN without leaking key material. |
| Output | `--json`, `--output`, `--quiet`, `--title`, `--seed` | JSON gets a versioned schema suitable for run-to-run comparison. |

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
   concurrency, open-loop arrival times, request selection, deterministic
   randomization, deadlines, and graceful shutdown.
2. **Connection workers** — own connection lifecycle and protocol concurrency.
   Start with several workers in one realm; add process or realm sharding after
   profiling proves the generator is CPU-bound.
3. **Protocol adapters** — expose connect, start operation, stream events,
   cancellation, and close. Adapters report protocol metadata without changing
   common success and latency definitions.
4. **Metrics recorder** — keeps bounded histograms and counters. Workers merge
   interval snapshots rather than sending one event per request to a coordinator.
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
    const socket = await client.connect('/chat');
    await socket.send(JSON.stringify({ type: 'join', room: context.workerId }));
    for (let i = 0; i < 100; i++) {
      await socket.send(JSON.stringify({ type: 'ping', sequence: i }));
      const message = await socket.receive();
      context.metric('round_trip').observe(message.latency);
    }
    await socket.close();
  },
} satisfies LoadScenario;
```

Hooks should receive controlled clients, deterministic random data, timers,
metrics, logging, and cancellation. They should not receive engine internals.
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

### Phase 2: controlled arrival and richer workloads

- Add fixed-rate scheduling with coordinated-omission-safe timing, rate ramps,
  multiple weighted requests, deterministic data substitution, reconnect
  cadence, expectations, bailouts, and worker sharding.
- Add the TypeScript scenario API without exposing protocol-specific internals
  through the common HTTP path.

### Phase 3: long-lived protocols

- Implement SSE first because it reuses streaming HTTP and validates the
  session-oriented metric model.
- Add WebSocket, then WebTransport, reusing public Fino clients.
- Add raw QUIC last; its application framing and success criteria are entirely
  scenario-defined and need the strongest safety limits.

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
- Protocol-specific flow-control tuning remains an advanced-workload decision
  for Phase 2; the common CLI currently exposes only connection, stream,
  pending-request, and unread-response bounds.
