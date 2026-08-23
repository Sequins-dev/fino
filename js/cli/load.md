---
weight: 35
---
# load

`fino load` runs a bounded closed-loop load test through Fino's `HttpClient`.
It supports explicit HTTP/1.1, HTTP/2, and HTTP/3 workloads and fails when the
target cannot speak the requested protocol instead of silently changing the
workload. H2 and H3 targets must use `https:`; the client does not currently
offer h2c load generation.

```sh
fino load --connections 100 --duration 30s http://127.0.0.1:3000/
fino load -p h2 -c 20 -m 10 --warmup 5s -d 30s https://localhost:3000/
fino load -p h3 -c 10 -m 50 -n 100000 --insecure https://localhost:4433/
```

The default response policy is `consume`: chunks are counted and immediately
dropped, so complete bodies are never retained and connections remain reusable.
`--response cancel` stops after final headers. That closes an HTTP/1.1
connection, sends `RST_STREAM` for HTTP/2, or cancels the request stream for
HTTP/3. Because cancellation can reduce server work, output always labels it as
headers-only.

## Load model

The first release uses closed-loop concurrency. HTTP/1.1 runs one operation per
connection; HTTP/2 and HTTP/3 run `connections * streams` operations. A worker
starts its next request only after the previous response has been consumed or
cancelled.

Use either `--duration` or `--requests`. With neither, measurement lasts 10
seconds. `--warmup` runs unmeasured work first and carries the same client and
any surviving connections into measurement. Duration boundaries stop new work
and abort operations still active at the boundary; those appear as cancelled.

Open-loop arrival rates, ramps, worker sharding, weighted targets, and scripted
SSE/WebSocket/WebTransport/raw-QUIC sessions remain later phases. They are not
silently approximated by this command.

## Command reference

| Name | Value | Description |
| --- | --- | --- |
| `url` | URL | Required absolute target; H1 accepts `http:` or `https:`, while H2/H3 require `https:`. |
| `-p`, `--protocol` | `h1`, `h2`, `h3` | Required wire protocol; defaults to `h1`. |
| `-c`, `--connections` | integer | Physical connections; defaults to 10. |
| `-m`, `--streams` | integer | Concurrent streams per H2/H3 connection; defaults to 1 and must remain 1 for H1. |
| `-d`, `--duration` | duration | Measured duration (`ms`, `s`, `m`, `h`); defaults to 10s. |
| `-n`, `--requests` | integer | Exact measured operation count; mutually exclusive with duration. |
| `--warmup` | duration | Unmeasured warmup; defaults to 0ms. |
| `-X`, `--method` | string | Request method; defaults to GET. |
| `-H`, `--header` | `name:value` | Repeatable request header. |
| `--body` | string | Static body replayed for every request. |
| `--body-file` | path | Binary body read once and replayed; mutually exclusive with `--body`. |
| `--response` | `consume`, `cancel` | Stream/drop bodies or stop after final headers. |
| `--expect-status` | status | Repeatable successful status; defaults to any 200-399 response. |
| `--timeout` | duration | Total per-request timeout; defaults to 30s. |
| `--connect-timeout` | duration | DNS plus new-connection timeout. |
| `--headers-timeout` | duration | Local queue plus final-headers timeout. |
| `--body-idle-timeout` | duration | Maximum gap between response chunks. |
| `--max-pending-requests` | integer | Bound requests waiting inside `HttpClient`. |
| `--max-buffered-response-bytes` | integer | Bound unread H2/H3 bytes per response; defaults to 1 MiB. |
| `--retry` | integer | Total safe attempts for replayable idempotent requests; defaults to 1. |
| `--no-decompress` | flag | Count encoded body bytes instead of decoded application bytes. |
| `--redirect` | `follow`, `error`, `manual` | Redirect policy; defaults to follow. |
| `--ca`, `--cert`, `--key` | path | TLS trust and client-identity PEM files. |
| `--insecure` | flag | Disable peer verification for local development. |
| `--title` | string | Run label included in text and JSON. |
| `-q`, `--quiet` | flag | Suppress text output. Explicit JSON is still emitted. |
| `--json` | flag | Emit the versioned machine-readable result. |

## Output contract

Text and JSON come from the same result. Counters distinguish offered, started,
completed, status-failed, timed-out, cancelled, transport-failed, and
headers-only operations. Results also include decoded or encoded response bytes,
status and negotiated-protocol distributions, stable connection reuse counts,
and bounded histograms for queue, final-header (TTFB), download, and total
latency. Connect and TLS distributions appear only when the transport exposes
those phase timestamps. Machine output records header names, request body size,
redirect/retry policy, and a non-secret TLS summary, but never header values,
certificate paths, or key material.

For comparable runs, keep the release/debug build, machine, target, TLS policy,
protocol, response policy, warmup, and content-decoding policy stable.
