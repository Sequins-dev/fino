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
- HTTP/3 is release-scoped to request/response behavior over QUIC plus
  WebTransport over H3 when optional libnghttp3 bindings are available. Public
  `fetch()` resolves URL hostnames before QUIC connect and keeps the URL host
  as the default SNI name. Connection pooling, Capsule fallback, CONNECT
  tunnels outside the WebTransport path, and external interop remain deferred.
- QUIC exposes transport-level client/server endpoints, streams, DATAGRAM,
  migration coverage, Version Negotiation handling, diagnostics, and local
  HTTP/3 transport coverage. ngtcp2 HQ, Node QUIC interop, and loopback
  throughput comparison are gated release lanes. External DATAGRAM/resumption,
  active migration, and Version Negotiation peer-control interop remain out of
  scope until peer tooling exposes deterministic controls. OpenSSL-only SNI
  context and TLS group controls are release scope; GnuTLS parity for those
  controls is deferred.
