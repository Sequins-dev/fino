# Release Readiness

Every release must pass the ordinary Linux and macOS CI suites plus the
explicit `Release Readiness` CI job.

## Public builtin benchmark inventory

Review [`benchmarks/COVERAGE.md`](benchmarks/COVERAGE.md) whenever a public
`fino:*` builtin is added or removed from `src/loader.rs`. Every registered
builtin must have exactly one table row naming either:

- a checked-in `benchmarks/**/*.bench.ts` file; or
- the exact marker `not yet benchmarked`.

The release-readiness test rejects missing builtins, malformed markers, and
benchmark paths that do not exist.

## Intentional non-parity review

Review intentional differences from Node.js, browsers, and third-party SDKs
for every release. At minimum, check:

- JOSE algorithms and key formats;
- CORS policy and cookie parsing/serialization;
- Fetch redirects, streaming, decompression, and connection reuse;
- OpenTelemetry lifecycle and exporter failure behavior;
- cluster APIs and remote realms;
- DNSSEC validation and trust anchors;
- HTTP/3 and QUIC availability, interoperability, and failure behavior.

Record newly accepted differences in public module documentation and add a
regression test or benchmark where the behavior is measurable.

## DNSSEC release verification

DNSSEC live verification is opt-in so ordinary local runs stay hermetic. Run
`FINO_DNS_LIVE=1 ./target/debug/fino test tests/net/dns-live.test.ts`; set
`FINO_DNS_SERVER` to exercise the resolver intended for the release lane.

The trust policy tracks the
[IANA root anchors](https://data.iana.org/root-anchors/root-anchors.xml).
Release review must check root trust anchor rollover notices. The rule that
unsupported DNSSEC algorithms and digests fail closed must remain covered by
the hermetic corpus.

As checked on 25 July 2026, the embedded trust set contains active KSK-2017
(key tag 20326) and pre-published KSK-2024 (key tag 38696). IANA schedules
KSK-2024 to begin signing on 11 October 2026, when KSK-2017 is expected to stop
signing. Verify IANA's rollover page and XML again before that date and on each
release; update both the embedded DNSKEY material and the asserted key tags
together if the published trust set changes.
