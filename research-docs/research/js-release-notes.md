# JavaScript Runtime Release Notes

This release lane keeps the public JavaScript builtin inventory tied to
`benchmarks/COVERAGE.md`. Every public `fino:*` builtin registered in the
loader must appear in that coverage map, either with a concrete benchmark file
or an explicit `not yet benchmarked` marker.

Intentional non-parity areas remain documented for release review: JOSE, CORS,
cookie handling, Fetch behavior, OpenTelemetry integration, cluster APIs,
distributed realm scheduling, DNSSEC, HTTP/3, and QUIC.

## DNSSEC Release Verification

DNSSEC live verification is gated so normal local test runs remain hermetic.
Run `FINO_DNS_LIVE=1` to enable `tests/net/dns-live.test.ts`; set
`FINO_DNS_SERVER` when the release lane must exercise a specific resolver.

The resolver trust policy tracks the IANA root anchors at
https://data.iana.org/root-anchors/root-anchors.xml. Release review must check
root trust anchor rollover notes and keep unsupported DNSSEC algorithms and digests fail closed.
