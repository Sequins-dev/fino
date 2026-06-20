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
  deterministic coverage and a release-required live lane:
  `FINO_DNS_LIVE=1 FINO_DNS_SERVER=1.1.1.1 ./target/debug/fino test tests/net/dns-live.test.mts`.
  Override the signed and bogus domains with `FINO_DNS_SIGNED_DOMAIN` and
  `FINO_DNS_BOGUS_DOMAIN` when release infrastructure needs local policy
  targets. Root trust anchors are embedded from
  https://data.iana.org/root-anchors/root-anchors.xml; root trust anchor rollover
  requires refreshing the source/date comment with the IANA XML,
  retaining active valid anchors during overlap, applying add/remove/revoke
  changes in the same commit as deterministic and live validation evidence, and
  treating unsupported DNSSEC algorithms and digests fail closed as intentional
  non-parity rather than ecosystem-complete DNSSEC support.
- HTTP/3 is release-scoped to request/response behavior over QUIC when optional
  libnghttp3 bindings are available. Public `fetch()` resolves URL hostnames
  before QUIC connect and keeps the URL host as the default SNI name. Connection
  pooling, WebTransport, Capsule, H3 DATAGRAM, CONNECT tunnels, and external
  interop remain deferred.
- QUIC exposes transport-level client/server endpoints, streams, DATAGRAM,
  migration coverage, and diagnostics. Advanced external interop lanes,
  backend-specific TLS parity, active migration edge coverage, and version
  negotiation ecosystem parity remain tracked separately.
