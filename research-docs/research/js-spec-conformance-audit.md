# JS Spec Conformance Audit

Documentation-only research pass over `js/` subsystems that claim, mirror, or
depend on external specifications. This audit reviews the current working tree
as-is and records material deviations, incomplete areas, missing conformance
coverage, and accepted subset boundaries. It does not include source fixes.

## Baseline

- WebTransport over HTTP/3 target: IETF `draft-ietf-webtrans-http3-15`:
  https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- HTTP target: RFC 9110 semantics, RFC 9112 HTTP/1.1, RFC 9113 HTTP/2,
  RFC 9114 HTTP/3, RFC 7541 HPACK, RFC 9208 QPACK, RFC 9297 HTTP Datagrams,
  and QUIC RFCs 9000, 9001, 9002, and 9221.
- Web platform target: WHATWG/W3C Fetch, DOM, HTML messaging, Streams, URL,
  Encoding, Web Crypto, File API, WebSocket, and Server-Sent Events.
- Formats and security targets: RFC 4180 CSV, TOML 1.0.0, YAML 1.2.2 core
  schema, XML 1.0, Namespaces in XML, ZIP APPNOTE, POSIX ustar/pax tar,
  RFCs 1950/1951/1952/7932 compression, JOSE RFCs 7515/7516/7517/7519/7638,
  RFC 9562 UUID, SemVer 2.0.0, JSON Schema, and Subresource Integrity.
- Runtime and ecosystem targets: POSIX/SUS command-line conventions, ECMA
  module semantics where claimed by the loader, npm package metadata, SQLite C
  and VFS APIs, OpenTelemetry specs, W3C Trace Context, and W3C Baggage.

## Inventory

| Area | Files | Classification | Specs | Coverage reviewed | Result |
| --- | --- | --- | --- | --- | --- |
| Web globals | `js/globals/**`, `js/stream.mts`, `js/realm/messaging.mts` | Spec-backed web APIs plus Fino adapters | Fetch, DOM, HTML messaging, Streams, URL, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.mts`, `tests/net/websocket.test.mts` | Findings `JS-SPEC-001`, `JS-SPEC-002`, and `JS-SPEC-004` |
| Networking protocols | `js/net/**`, `js/internal/net/**`, `js/security/cors.mts` | Spec-backed protocols; provider internals are spec-adjacent | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*`, QUIC research docs | Findings `JS-SPEC-005`, `JS-SPEC-006`, and `JS-SPEC-008` |
| Formats, files, archives, compression | `js/format/**`, `js/file/**`, `js/archive.mts`, `js/compress.mts` | Format parsers are spec-backed; file helpers are POSIX-adjacent | CSV, TOML, YAML, XML, ZIP, tar, compression RFCs, POSIX | `tests/format/**`, `tests/archive/**`, `tests/compress.test.mts`, `tests/file/**` | Findings `JS-SPEC-009` and `JS-SPEC-010` |
| Security, crypto, identifiers, validation | `js/security/**`, `js/globals/crypto.mts`, `js/uuid.mts`, `js/validate.mts` | Spec-backed crypto/security formats with documented subsets | WebCrypto, JOSE/JWK/JWT/JWE, UUID, JSON Schema, Fetch CORS | `tests/internal/globals/crypto*.test.mts`, `tests/security/**`, `tests/uuid.test.mts`, `tests/validate.test.mts` | Finding `JS-SPEC-012` |
| Runtime, modules, process, packaging | `js/process*`, `js/module.mts`, `js/internal/loader.mts`, `js/internal/package_manager.mts`, `js/tty/**` | Spec-adjacent runtime APIs and package metadata | POSIX/SUS CLI, ECMA modules, npm metadata, SRI | `tests/process/**`, `tests/runtime/**`, `tests/internal/package-manager-integrity.test.mts`, `tests/tty.test.mts` | No open findings |
| Observability, database, cluster, realm | `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | Spec-backed where protocol/wire/API claims exist; Fino orchestration is spec-adjacent | OpenTelemetry, W3C Trace Context/Baggage, SQLite C/VFS, WebTransport, HTML messaging | `tests/opentelemetry*`, `tests/sqlite*`, `tests/cluster/**`, `tests/realm/**` | Findings `JS-SPEC-016` and `JS-SPEC-018` |

## Findings

### JS-SPEC-001

- Subsystem/files: Web globals, `js/globals/websocket.mts`.
- Spec target and section: WHATWG WebSocket API and RFC 6455 opening handshake.
- Expected behavior: The WebSocket facade should expose browser-compatible
  constructor, ready-state, event, close, and send behavior wherever it claims
  "Strict spec-compliant global".
- Observed implementation/test gap: The module documents unsupported extensions
  and H2/H3 WebSocket as accepted limits, but the global facade also documents
  runtime-specific behavior such as no buffering before `OPEN` and relies mainly
  on local protocol tests. There is no WPT-backed or WPT-derived API matrix for
  constructor validation, event ordering, `bufferedAmount`, close reason limits,
  and binary type edge cases.
- Priority: P1.
- Suggested follow-up: Add a WebSocket API conformance matrix tied to WHATWG
  sections and extend `tests/net/websocket.test.mts` with facade-level edge
  cases. Keep extension and RFC 8441 deferrals documented as intentional limits.

### JS-SPEC-002

- Subsystem/files: Web globals, `js/globals/webstreams.mts`, `js/stream.mts`.
- Spec target and section: WHATWG Streams default reader, BYOB reader,
  backpressure, tee, pipe, transfer, and queuing strategy algorithms.
- Expected behavior: Supported stream surfaces should match locking, promise
  timing, cancellation, close/error propagation, BYOB view handling, and
  backpressure algorithms for the claimed API subset.
- Observed implementation/test gap: The implementation is broad and includes
  BYOB, transform, queuing strategies, and pipe operations, but the documented
  conformance evidence is local focused tests rather than a section-by-section
  Streams map. Transfer and structured clone are explicitly unsupported, but
  remaining algorithmic differences such as microtask timing and BYOB detached
  buffer behavior are not enumerated.
- Priority: P1.
- Suggested follow-up: Build a Streams requirement map from the WHATWG spec and
  add focused tests for promise timing, release-lock behavior, BYOB edge cases,
  pipe abort/prevent flags, and tee cancellation.

### JS-SPEC-004

- Subsystem/files: Web globals and realm messaging,
  `js/globals/encoding.mts`, `js/globals/messaging.mts`,
  `js/realm/messaging.mts`, `js/realm/index.mts`.
- Spec target and section: HTML structured clone and channel messaging.
- Expected behavior: `structuredClone()`, `MessagePort`, and `MessageChannel`
  should clone and transfer every supported platform object according to the
  HTML algorithms, or document the supported subset precisely.
- Observed implementation/test gap: Same-isolate and realm messaging support
  ArrayBuffer and MessagePort transfer in selected paths, while global
  structured clone rejects MessagePort and streams. Tests cover unsupported
  payload rejection, but the docs do not provide a durable cloneability matrix
  for Blob, File, CryptoKey, URL, Error, Map/Set, typed arrays, and port
  transfer across same-isolate, thread, process, and remote realms.
- Priority: P1.
- Suggested follow-up: Add a structured-clone support table and cross-link it
  from messaging docs. Add focused tests for every supported built-in and every
  intentionally rejected transferable per realm mode.

### JS-SPEC-005

- Subsystem/files: Networking, `js/internal/net/http/h2/**`,
  `tests/integration/h2spec-allowed-failures.json`.
- Spec target and section: RFC 9113 HTTP/2 framing, stream state, SETTINGS,
  and request header validation.
- Expected behavior: External h2spec cases should pass or have narrowly
  justified, tracked release exceptions that still prove equivalent wire
  behavior locally.
- Observed implementation/test gap: The allowed-failures file still contains
  many h2spec cases across preface, frame size, stream states, SETTINGS, PING,
  CONTINUATION, pseudo-header validation, and content-length mismatch behavior.
  Several entries cite timing-sensitive EOF before GOAWAY/RST frames. Local raw
  tests cover representative cases, but the external conformance lane still
  reports visible failures.
- Priority: P0.
- Suggested follow-up: Keep each allowed h2spec failure as an open conformance
  item until either h2spec passes or the external harness records the exact
  expected frame before close. Group the failures by RFC 9113 section in the
  h2spec audit so release gates can burn them down independently.

### JS-SPEC-006

- Subsystem/files: Networking, `js/internal/net/http/h3/**`,
  `js/net/http/webtransport.mts`, `js/internal/net/http/h3/webtransport.mts`,
  `research-docs/research/webtransport-http3.md`.
- Spec target and section: WebTransport over HTTP/3 draft 15, RFC 9114, RFC
  9297, and W3C WebTransport.
- Expected behavior: WebTransport sessions should enforce SETTINGS negotiation,
  Extended CONNECT semantics, HTTP Datagrams, stream prefixes, session close,
  GOAWAY handling, server certificate hash validation, and mixed H3 traffic
  behavior.
- Observed implementation/test gap: The implementation has progressed through
  public API shape, H3 SETTINGS, Extended CONNECT, datagrams, streams, and basic
  lifecycle, but the research doc still lists native callback confirmation,
  H3 GOAWAY session behavior, H2 capsule fallback, and ngtcp2 reset-at
  availability as blockers or out-of-scope areas. These are not reflected as
  open gaps in the previous spec audit.
- Priority: P0.
- Suggested follow-up: Add a WebTransport conformance matrix tied to draft-15
  sections and mark GOAWAY, DATAGRAM callback proof, reset-at support, and
  capsule fallback as `missing-test`, `missing-implementation`, or
  `intentional-limit` explicitly.

### JS-SPEC-008

- Subsystem/files: Networking, `js/net/dns.mts`,
  `js/internal/net/dnssec.mts`, `tests/net/dns-live.test.mts`.
- Spec target and section: RFC 1035 DNS, RFC 4034/4035 DNSSEC, EDNS(0), NSEC,
  and NSEC3 denial proofs.
- Expected behavior: DNSSEC validation should prove positive answers, bogus
  signatures, insecure delegations, and denial-of-existence behavior against
  representative signed zones.
- Observed implementation/test gap: Static tests and gated live smoke tests
  exist, but live validation is skipped unless `FINO_DNS_LIVE=1` is set. The
  smoke lane covers one signed domain and one bogus domain by default; it does
  not visibly cover NSEC and NSEC3 denial proof variants, unsupported algorithm
  fallback with an alternate supported signature, or insecure delegation proofs.
- Priority: P1.
- Suggested follow-up: Add deterministic DNSSEC fixtures for chain and denial
  cases, then keep the live lane as an external smoke test rather than the only
  proof of resolver conformance.

### JS-SPEC-009

- Subsystem/files: Formats, `js/format/yaml.mts`,
  `tests/format/yaml.test.mts`, `tests/fixtures/yaml/**`.
- Spec target and section: YAML 1.2.2 core schema and processor directives.
- Expected behavior: A YAML 1.2 core-schema parser should either process or
  explicitly reject every YAML syntax class it advertises, including directives,
  tags, anchors, aliases, merge keys, complex keys, block scalars, flow
  collections, and multi-document streams.
- Observed implementation/test gap: The module documents directives and custom
  tags as outside the baseline, but also says it supports the "full YAML 1.2
  core schema". Fixtures cover many core constructs and security limits, yet
  there is no durable per-production map explaining which YAML 1.2 syntax
  classes are implemented, normalized, rejected, or security-excluded.
- Priority: P1.
- Suggested follow-up: Convert the YAML fixture list into a spec map and add
  negative fixtures for directives, `%TAG`, unsupported local tags, recursive
  aliases, and ambiguous core-schema scalars.

### JS-SPEC-010

- Subsystem/files: Formats, `js/format/xml.mts`, `tests/format/xml.test.mts`,
  `tests/fixtures/xml/**`.
- Spec target and section: XML 1.0, Namespaces in XML, and XML well-formedness
  constraints.
- Expected behavior: XML parsing should enforce well-formedness, namespace
  constraints, entity handling, and character validity for the claimed subset.
- Observed implementation/test gap: The module states that it enforces XML
  well-formedness and namespace rules, disables external entities by default,
  and is not a validating DTD processor. Existing fixtures cover common
  malformed XML and XXE/security cases, but the audit found no explicit tests or
  matrix for XML character validity, duplicate attributes after namespace
  expansion, reserved `xml`/`xmlns` namespace binding errors, or standalone/XML
  declaration constraints.
- Priority: P1.
- Suggested follow-up: Add XML namespace and character-validity conformance
  fixtures, with every unsupported DTD validation rule recorded as an
  intentional limit.

### JS-SPEC-012

- Subsystem/files: Security/crypto, `js/globals/crypto.mts`,
  `tests/internal/globals/crypto*.test.mts`.
- Spec target and section: W3C Web Cryptography API algorithm normalization,
  key import/export, usages, and DOMException error names.
- Expected behavior: For every supported algorithm, WebCrypto should match the
  spec's normalization, key usage checks, extractability checks, error names,
  and input conversions.
- Observed implementation/test gap: The module documents a useful subset and
  explicitly excludes AES-CTR, AES-KW, full WPT coverage, and full algorithm
  parity. However, several unsupported paths throw generic `Error` in code
  paths while the module-level contract says unsupported algorithms and key
  formats reject with `NotSupportedError`, malformed key material with
  `DataError`, and backend failures with `OperationError`.
- Priority: P0.
- Suggested follow-up: Audit every `throw new Error` in `SubtleCrypto` methods
  against WebCrypto error names and add tests asserting named errors for
  unsupported algorithms, invalid key usages, non-extractable export/wrap, and
  malformed import material.

### JS-SPEC-016

- Subsystem/files: Observability, `js/opentelemetry/**`,
  `js/internal/opentelemetry/**`, `tests/opentelemetry*.test.mts`.
- Spec target and section: OpenTelemetry API/SDK, OTLP/HTTP JSON, W3C Trace
  Context, and W3C Baggage.
- Expected behavior: Fino-native OpenTelemetry should be clear about where it
  conforms to wire formats and where it intentionally does not match upstream
  package APIs or OTLP transports.
- Observed implementation/test gap: The module documents Fino-native scope and
  excludes OTLP protobuf/gRPC and full package parity. The remaining gap is a
  signal-by-signal conformance table: traces, logs, metrics, resources,
  baggage, trace context propagation, retry, compression, and partial success
  handling are implemented, but tests are not mapped to OpenTelemetry spec
  requirement sections.
- Priority: P1.
- Suggested follow-up: Add an OpenTelemetry spec matrix and mark OTLP JSON wire
  fields as covered, package API differences as intentional limits, and
  protobuf/gRPC as out of scope.

### JS-SPEC-018

- Subsystem/files: Cluster and realm, `js/cluster.mts`, `js/realm/**`,
  `js/internal/cluster/**`, `tests/cluster/**`, `tests/realm/**`.
- Spec target and section: WebTransport security/lifecycle expectations and
  HTML messaging semantics used by remote realm ports.
- Expected behavior: Remote realm messaging over WebTransport should preserve
  message ordering, clone/transfer limits, close/error behavior, and security
  boundaries promised by the public API.
- Observed implementation/test gap: The cluster module documents a trusted seed
  and no authentication, seed election, hostile-peer handling, or direct
  peer-to-peer port delivery. Realm docs also state that import rules and
  facades are not security boundaries by themselves. Tests cover current
  routing and rejection behavior, but the audit should not describe this area
  as fully spec-conformant WebTransport or HTML messaging parity.
- Priority: P1.
- Suggested follow-up: Keep trusted-cluster assumptions prominent, add a
  remote-message conformance table for ordering, failure, and transfer limits,
  and ensure future tests distinguish HTML messaging semantics from Fino cluster
  routing policy.

## Test Coverage Priorities

| Priority | Subsystem | Coverage to add or strengthen |
| --- | --- | --- |
| P0 | HTTP/2 | Burn down `tests/integration/h2spec-allowed-failures.json`; capture exact GOAWAY/RST behavior for timing-sensitive failures. |
| P0 | WebTransport/H3 | Add draft-15 conformance tests for GOAWAY, DATAGRAM callback proof, reset-at support, SETTINGS negotiation failures, and session cleanup. |
| P0 | WebCrypto | Assert WebCrypto named errors and key-usage checks for every supported algorithm and unsupported path. |
| P1 | Web Streams | Add WHATWG Streams algorithm coverage for BYOB, lock release, promise timing, `tee()`, and pipe abort/prevent flags. |
| P1 | Structured clone/messaging | Add cloneability and transferability matrix tests across same-isolate, thread, process, and remote realm modes. |
| P1 | DNSSEC | Add deterministic fixtures for NSEC/NSEC3 denial, insecure delegation, unsupported algorithm fallback, and bogus signatures. |
| P1 | YAML/XML | Turn fixture corpora into spec-production maps and add missing negative fixtures for directives, namespace errors, and character validity. |
| P1 | OpenTelemetry | Map tests to traces, logs, metrics, resources, propagation, OTLP/HTTP JSON, retry, compression, and partial-success spec sections. |

## Accepted Divergences And Non-Goals

- `fetch()` and `EventSource` are server-side transports, not browser policy
  engines. Browser CORS enforcement, implicit cookies, opaque responses, cache
  modes, and default credential/referrer behavior are intentionally absent.
- WebSocket extensions and RFC 8441 WebSocket-over-H2/H3 are deferred.
- `TextDecoder` is UTF-8-only in the current release scope.
- Streams and `MessagePort` transfer through global `structuredClone()` are not
  general-purpose transferable surfaces in this runtime.
- ZIP64, ZIP data descriptors, tar PAX/GNU long-name entries, tar symlink and
  hardlink restoration, and streaming archive APIs are outside the archive
  baseline.
- YAML custom tags/object construction, YAML directives, TOML style
  preservation, XML validation/prolog round-tripping, and JSON Schema advanced
  keywords are outside the current parser baselines.
- OpenTelemetry is Fino-native with OTLP/HTTP JSON export, not strict upstream
  package, OTLP protobuf, or OTLP/gRPC parity.
- Cluster assumes one trusted seed. Authentication, seed election,
  hostile-peer behavior, and direct peer-to-peer port delivery are deferred.
- QUIC optional peer lanes, advanced peer-controlled migration/VN, and some
  backend-specific TLS parity remain gated or deferred where existing research
  docs say so.
