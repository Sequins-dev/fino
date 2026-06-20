# JS Release Notes

This note records the release baseline for intentional non-parity areas that
are not expected to match browser or upstream ecosystem behavior exactly.

## Benchmarks And Generated Docs

`benchmarks/COVERAGE.md` is the release benchmark inventory for public
`fino:*` builtins. Regenerate docs into `docs/` as needed for review; generated
docs are ignored and are not committed as release source.

## Intentional Non-Parity

- JOSE covers JWK/JWKS, JWT, and compact JWE helpers for the supported runtime
  algorithms. Full JOSE ecosystem compatibility remains outside this release.
- CORS and cookie helpers build and parse explicit server-side headers. They do
  not make Fetch enforce browser CORS or maintain a browser cookie jar.
- Fetch is a server-side HTTP/HTTPS transport baseline. It supports redirects,
  aborts, integrity, decompression, explicit referrer policy handling, and H2
  pooling, but not browser cache, credentials, keepalive lifetime, default
  referrer, opaque response, or implicit cookie behavior.
- OpenTelemetry provides Fino-native API, SDK, signal, propagation, runtime
  instrumentation, and OTLP/HTTP JSON export coverage. Strict upstream package
  parity, OTLP protobuf, and OTLP/gRPC are deferred.
- Cluster and remote realms are trusted-cluster features. Hostile-peer and
  authentication-failure behavior waits for cluster authentication support.
- DNSSEC validates signed responses from embedded root trust anchors with
  deterministic and gated live coverage. Root-anchor rollover policy and full
  ecosystem parity remain deferred.
- HTTP/3 is release-scoped to request/response behavior over QUIC when optional
  libnghttp3 bindings are available. Connection pooling, WebTransport, Capsule,
  H3 DATAGRAM, CONNECT tunnels, and external interop remain deferred.
- QUIC exposes transport-level client/server endpoints, streams, DATAGRAM,
  migration coverage, and diagnostics. Advanced external interop lanes,
  backend-specific TLS parity, active migration edge coverage, and version
  negotiation ecosystem parity remain tracked separately.
