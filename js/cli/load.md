---
weight: 35
---
# load

`fino load` runs bounded HTTP or scripted stateful load through Fino's public
protocol clients. Static workloads support explicit HTTP/1.1, HTTP/2, and
HTTP/3 and fail when the target cannot speak the requested protocol instead of
silently changing the workload. H2 and H3 targets must use `https:`; h2c is not
supported.

```sh
fino load --connections 100 --duration 30s http://127.0.0.1:3000/
fino load -p h2 -c 20 -m 10 --warmup 5s -d 30s https://localhost:3000/
fino load --rate 1000 --rate-to 5000 -d 30s http://127.0.0.1:3000/
fino load --scenario ./chat.load.ts --users 100 --duration 30s
```

The default response policy is `consume`: chunks are counted and immediately
dropped, so complete bodies are never retained and connections remain reusable.
`--response cancel` stops after final headers. That closes an HTTP/1.1
connection, sends `RST_STREAM` for HTTP/2, or cancels the HTTP/3 request stream.
Because cancellation can reduce server work, output always labels it as
headers-only.

## Load model

Without `--rate`, the command is closed-loop. HTTP/1.1 runs one operation per
connection; HTTP/2 and HTTP/3 run `connections * streams` operations. A worker
starts its next request after the previous response has been consumed or
cancelled.

`--rate` selects open-loop arrivals per second. `--rate-to` adds a linear ramp
over the measured duration or exact request count. Arrivals retain their
intended monotonic timestamp while waiting, so queue and total latency include
generator delay rather than hiding coordinated omission. If
`--max-queued-operations` is full, excess arrivals are counted as dropped.

Use either `--duration` or `--requests`. With neither, measurement lasts 10
seconds. `--warmup` runs unmeasured work first and carries the same client and
surviving connections into measurement.

Static HTTP mode repeats one normalized request without target selection or
generated data in its hot path. Put multi-endpoint, stateful, or varying
request behavior in a TypeScript scenario, where the workload contract is
explicit.

`--expect-body` compares an exact UTF-8 value while streaming and dropping the
response. It never buffers the received body and cannot be combined with
`--response cancel`. Bailout thresholds stop scheduling after status/body
failures or timeout/transport errors reach the configured count.

## TypeScript scenarios

Use `--scenario` for protocols whose load behavior is not defined by a URL and
concurrency alone. The module default-exports a `LoadScenario`. Each virtual
user receives controlled HTTP, SSE, WebSocket, WebTransport, and raw QUIC
constructors plus cancellation, counters, and bounded custom metrics. Resources
opened through the controlled client are closed when the hook returns or
throws.

```ts
import type { LoadScenario } from 'fino:load';

export default {
  protocol: 'websocket',
  async session(client, context) {
    const socket = await client.websocket('wss://localhost:3000/chat');
    const response = new Promise<MessageEvent>((resolve) => {
      socket.addEventListener('message', (event) => resolve(event as MessageEvent), {
        once: true,
      });
    });
    const start = performance.now();
    await socket.send(`ping:${context.sequence}`);
    context.messages('sent');
    const message = await response;
    context.messages('received');
    context.bytes('received', String(message.data).length);
    context.metric('round_trip_ms', performance.now() - start);
    await socket.close();
  },
} satisfies LoadScenario;
```

SSE scenarios define event predicates and completion. WebSocket scenarios
define message correlation. WebTransport and raw QUIC scenarios define stream
or datagram framing, delivery expectations, and whether 0-RTT is valid. The
runner does not invent those application contracts or combine 0-RTT and 1-RTT
measurements.

## Command reference

| Name | Value | Description |
| --- | --- | --- |
| `url` | URL | Static HTTP target unless `--scenario` is used; H2/H3 require `https:`. |
| `--scenario` | path | TypeScript module default-exporting a `LoadScenario`. |
| `--users` | integer | Concurrent virtual users for a scenario. |
| `--sessions` | integer | Exact scenario-session count; mutually exclusive with duration. |
| `-p`, `--protocol` | `h1`, `h2`, `h3` | Required HTTP wire protocol; defaults to `h1`. |
| `-c`, `--connections` | integer | Physical HTTP connections; defaults to 10. |
| `-m`, `--streams` | integer | Streams per H2/H3 connection; must be 1 for H1. |
| `-d`, `--duration` | duration | Measured duration (`ms`, `s`, `m`, `h`); defaults to 10s. |
| `-n`, `--requests` | integer | Exact HTTP operation count; mutually exclusive with duration. |
| `--warmup` | duration | Unmeasured HTTP warmup; defaults to 0ms. |
| `--rate` | number | Fixed arrivals/second or ramp start. |
| `--rate-to` | number | Linear arrival-rate ramp endpoint. |
| `--max-queued-operations` | integer | Bound waiting HTTP operations or scenario sessions. |
| `--reconnect-after` | integer | Recreate pooled sessions after this many starts. |
| `-X`, `--method` | string | HTTP method; defaults to GET. |
| `-H`, `--header` | `name:value` | Repeatable request header. |
| `--body` | string | Static body replayed for every request. |
| `--body-file` | path | Body read once and replayed; mutually exclusive with `--body`. |
| `--response` | `consume`, `cancel` | Stream/drop bodies or stop after final headers. |
| `--expect-status` | status | Repeatable successful status; defaults to 200-399. |
| `--expect-body` | string | Exact UTF-8 body matched incrementally. |
| `--bailout-failures` | integer | Stop after status/body failures reach this count. |
| `--bailout-errors` | integer | Stop after timeout/transport errors reach this count. |
| `--timeout` | duration | Total per-request timeout; defaults to 30s. |
| `--connect-timeout` | duration | DNS plus new-connection timeout. |
| `--headers-timeout` | duration | Local queue plus final-headers timeout. |
| `--body-idle-timeout` | duration | Maximum gap between response chunks. |
| `--max-pending-requests` | integer | Bound requests waiting inside `HttpClient`. |
| `--max-buffered-response-bytes` | integer | Bound unread H2/H3 bytes per response; defaults to 1 MiB. |
| `--retry` | integer | Total safe replay attempts; defaults to 1. |
| `--no-decompress` | flag | Count encoded rather than decoded body bytes. |
| `--redirect` | `follow`, `error`, `manual` | Redirect policy; defaults to follow. |
| `--ca`, `--cert`, `--key` | path | TLS trust and client-identity PEM files. |
| `--insecure` | flag | Disable TLS peer verification for local development. |
| `--title` | string | Run label included in text and JSON. |
| `-q`, `--quiet` | flag | Suppress text output; explicit JSON is still emitted. |
| `--json` | flag | Emit the versioned machine-readable result. |

## Output contract

HTTP text and JSON come from the schema-version-2 result. Counters distinguish
offered, started, completed, scheduler-dropped, status/body-failed, timed-out,
cancelled, transport-failed, and headers-only work. Results include response
bytes, status/protocol distributions, connection reuse, bailout reason, and
bounded histograms for queue, final-header (TTFB), download, and total latency.
Machine output records header names and non-secret TLS configuration, never
header values, certificate paths, or key material.

Scenario output has a separate versioned result: session outcomes, peak active
sessions, application bytes/messages reported by the script, bounded error
classes, and fixed-size logarithmic histograms for custom metrics. Metric names
are limited to 64 safe ASCII characters. Defaults cap distinct metrics at 64
and diagnostic log calls at 1000.

For comparable runs, keep the build mode, machine, target, TLS policy, protocol,
response policy, warmup, and content-decoding policy stable.
