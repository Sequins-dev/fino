# JS Spec Conformance Audit

Documentation-only research pass over `js/` subsystems that claim, mirror, or
depend on external specifications. This audit reviews the current working tree
as-is and records deviations, incomplete areas, and missing test coverage for
prioritization. It does not include source fixes.

## Baseline

- WebTransport over HTTP/3 target: IETF
  `draft-ietf-webtrans-http3-15`, latest revision 2026-03-02, active Internet
  Draft in WG Last Call as of 2026-06-22:
  https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- HTTP target: RFC 9110 semantics, RFC 9112 HTTP/1.1, RFC 9113 HTTP/2,
  RFC 9114 HTTP/3, RFC 7541 HPACK, RFC 9208 QPACK, and related QUIC RFCs:
  https://www.rfc-editor.org/rfc/rfc9110
- Web platform target: WHATWG/W3C living standards such as Fetch, DOM, HTML,
  Streams, URL, Encoding, Web Crypto, File API, and WebSocket:
  https://fetch.spec.whatwg.org/
- OpenTelemetry target: official OpenTelemetry specification 1.57.0:
  https://opentelemetry.io/docs/specs/otel/
- Other targets include POSIX/SUS, ZIP APPNOTE, ustar/pax tar, RFC 1950/1951/1952,
  RFC 7932, TOML 1.0.0, YAML 1.2.2, XML 1.0 and Namespaces in XML, JOSE RFCs,
  RFC 9562 UUID, SemVer 2.0.0, JSON Schema subset, SQLite C/VFS APIs, W3C Trace
  Context, npm package metadata, and Subresource Integrity.

## Inventory

| Area | Files | Specs | Current coverage | Result |
| --- | --- | --- | --- | --- |
| Web globals | `js/globals/**`, `js/realm/messaging.mts` | DOM, HTML, Fetch, URL, Streams, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.mts`, `tests/net/websocket.test.mts` | Gaps WEB-001 to WEB-007 |
| Networking | `js/net/**`, `js/internal/net/**`, `js/security/cors.mts` | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*` | Gaps NET-001 to NET-005 |
| File/format/security | `js/file/**`, `js/archive.mts`, `js/compress.mts`, `js/format/**`, `js/security/**`, `js/uuid.mts`, `js/semver.mts`, `js/validate.mts` | POSIX, ZIP/tar/gzip, compression RFCs, CSV/TOML/YAML/XML, JOSE, UUID, SemVer, JSON Schema | `tests/file/**`, `tests/archive/**`, `tests/format/**`, `tests/security/**`, utility tests | Gaps FFS-001 to FFS-007 |
| Runtime/ecosystem | `js/process*`, `js/module.mts`, `js/internal/loader.mts`, `js/internal/package_manager.mts`, `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | POSIX, ESM/package/SRI, OpenTelemetry, SQLite, WebTransport, WHATWG messaging | runtime, internal, OTel, SQLite, cluster, realm tests | Gaps RTE-001 to RTE-005 |

Existing release notes already document broad intentional non-parity areas:
server-side Fetch/CORS/cookie behavior, Fino-native OpenTelemetry instead of
upstream package parity, trusted cluster assumptions, gated DNSSEC live coverage,
HTTP/3/WebTransport scope, QUIC external interop gates, WebSocket extensions,
and non-browser runtime behaviors. Those are treated as accepted divergences
unless a finding below calls out missing documentation or contradictory tests.

## Findings

### WEB-001: Event handler properties run outside `EventTarget` dispatch

- Files: `js/globals/broadcast-channel.mts`, `js/globals/eventsource.mts`,
  `js/globals/websocket.mts`
- Spec target: DOM `EventTarget` dispatch and HTML/WebSocket/EventSource event
  handler attributes.
- Expected behavior: `onmessage`, `onopen`, `onerror`, and similar handler
  properties should behave like listener-list event handler attributes, with
  `currentTarget`, `target`, `eventPhase`, ordering, and removal semantics
  matching dispatch.
- Current behavior: these classes dispatch an event and then manually invoke the
  handler property, so callbacks can observe post-dispatch event state and a
  separate ordering path.
- Coverage gap: no tests assert handler/listener ordering, `currentTarget`,
  `target`, or `eventPhase` for these handler properties.
- Priority: P1
- Follow-up: implement handler slots as listener-list entries and add parity
  tests for BroadcastChannel, EventSource, and WebSocket.

### WEB-002: `MessagePort.postMessage()` ignores invalid transfer-list ports

- Files: `js/globals/messaging.mts`
- Spec target: HTML channel messaging and structured serialize with transfer.
- Expected behavior: duplicate, closed, already-neutered, or invalid transfer
  entries should fail atomically with a DOM-style clone error.
- Current behavior: closed/neutered ports are skipped and duplicate ports can be
  collapsed after mutation.
- Coverage gap: no tests for duplicate ports, already-transferred ports, closed
  ports, or mixed valid/invalid atomic failure.
- Priority: P1
- Follow-up: pre-validate the whole transfer list before mutating port state.

### WEB-003: Transferred ports are not reconstructed inside `event.data`

- Files: `js/globals/messaging.mts`
- Spec target: HTML structured serialize with transfer.
- Expected behavior: if a transferred `MessagePort` appears inside the message
  graph, the receiver should observe the transferred endpoint in `event.data`.
- Current behavior: the implementation exposes transferred ports through
  `MessageEvent.ports`; the global structured clone path rejects MessagePort
  values inside the data graph.
- Coverage gap: no browser-parity test for `{ port }` plus `[port]`.
- Priority: P2
- Follow-up: decide whether message-graph port transfer is release scope; if so,
  add an internal transfer map for `MessagePort.postMessage()`.

### WEB-004: Closed `BroadcastChannel.postMessage()` throws generic `Error`

- Files: `js/globals/broadcast-channel.mts`
- Spec target: HTML BroadcastChannel.
- Expected behavior: posting after close should throw a DOM-style invalid state
  exception.
- Current behavior: throws `Error('BroadcastChannel is closed')`.
- Coverage gap: tests only match the message text.
- Priority: P2
- Follow-up: throw `DOMException` with name `InvalidStateError` if web parity is
  desired.

### WEB-005: `EventSource` omits `withCredentials`

- Files: `js/globals/eventsource.mts`
- Spec target: HTML `EventSource(url, init)` and readonly `withCredentials`.
- Expected behavior: constructor supports `withCredentials?: boolean` and exposes
  a readonly reflected property defaulting to `false`.
- Current behavior: init supports only `headers` and `tls`; there is no property.
- Coverage gap: no constructor/property tests.
- Priority: P2
- Follow-up: add reflected option/property while keeping browser credential
  policy as a documented server-side non-goal.

### WEB-006: `Blob` accepts explicit `null` as an empty part sequence

- Files: `js/globals/blob.mts`
- Spec target: File API `Blob(sequence<BlobPart> blobParts, ...)`.
- Expected behavior: omitted parts default to empty; explicit `null` should fail
  Web IDL sequence conversion.
- Current behavior: `parts == null` is treated as empty.
- Coverage gap: no `new Blob(null)` test.
- Priority: P2
- Follow-up: reject `null` and keep `undefined` as empty, unless permissiveness is
  documented as a Fino extension.

### WEB-007: `FormData(existingFormData)` is nonstandard

- Files: `js/globals/formdata.mts`
- Spec target: XMLHttpRequest/FormData constructor.
- Expected behavior: browser constructor accepts no argument or DOM form inputs,
  not another `FormData`.
- Current behavior: Fino supports a copy constructor and tests lock it in.
- Coverage gap: tests do not label this as a Fino extension.
- Priority: P3
- Follow-up: document as nonstandard extension or remove the overload.

### NET-001: HTTP/3 request pseudo-header validation is incomplete

- Files: `js/internal/net/http/h3/server.mts`
- Spec target: RFC 9114 request pseudo-headers, RFC 9110 request control data,
  and extended CONNECT rules.
- Expected behavior: non-CONNECT requests require valid `:method`, `:scheme`,
  and `:path`; `:protocol` applies only to extended CONNECT; duplicates,
  pseudo-after-regular, and context-invalid pseudo-headers should reject the
  stream before handler dispatch.
- Current behavior: dispatch rejects missing method/path, but missing `:scheme`
  falls back to `https`, and `:protocol` can be accepted on ordinary requests.
- Coverage gap: no raw H3 malformed pseudo-header tests comparable to H2.
- Priority: P1
- Follow-up: validate in H3 end-headers before dispatch and add raw malformed H3
  tests.

### NET-002: WebTransport over H3 does not enforce peer SETTINGS readiness

- Files: `js/internal/net/http/h3/session.mts`,
  `js/internal/net/http/h3/client.mts`, `js/internal/net/http/h3/server.mts`,
  `js/internal/net/http/h3/webtransport.mts`
- Spec target: WebTransport over HTTP/3 draft-15, RFC 9220, RFC 9297.
- Expected behavior: WebTransport sessions should be established only after the
  peer advertises required settings for extended CONNECT, H3 DATAGRAM, and
  WebTransport enablement.
- Current behavior: peer settings are tracked, but client/server setup does not
  appear to gate success on complete readiness.
- Coverage gap: no negative tests for missing/partial peer settings.
- Priority: P1
- Follow-up: gate setup on complete peer settings or explicitly document a
  temporary interop mode.

### NET-003: Incoming WebTransport unidirectional streams are not H3-routed

- Files: `js/internal/net/http/h3/server.mts`,
  `js/internal/net/http/h3/client.mts`, `js/net/http/webtransport.mts`
- Spec target: WebTransport over HTTP/3 stream mapping.
- Expected behavior: incoming bidirectional and unidirectional QUIC streams
  should be demultiplexed by WebTransport stream type/session ID and delivered
  to the correct WebTransport stream queues.
- Current behavior: public WebTransport can route both kinds once handed a stream,
  but H3 client/server paths appear to route only bidirectional WebTransport
  streams; remote unidirectional streams are passed to nghttp3 as H3/QPACK/control
  input.
- Coverage gap: no end-to-end H3 tests where either peer creates a WebTransport
  unidirectional stream and the other reads it from `incomingUnidirectionalStreams`.
- Priority: P1
- Follow-up: maintain a session map in H3 client/server drivers and demux
  unidirectional streams before nghttp3 processing.

### NET-004: HTTP/2 content-length mismatch can reach handlers before rejection

- Files: `js/internal/net/http/h2/server.mts`,
  `tests/integration/h2spec-allowed-failures.json`
- Spec target: RFC 9113/RFC 7540 request validity.
- Expected behavior: mismatched `content-length` and DATA length should reject
  without exposing a successful request body to application logic.
- Current behavior: source inspection suggests the handler is invoked before EOF
  validation; tests assert wire reset but not handler isolation. The h2spec
  allowlist rationale says the handler is not invoked, which appears inconsistent.
- Coverage gap: no regression test verifies handler non-invocation.
- Priority: P2
- Follow-up: decide whether early streaming is intentional; fix behavior or
  update documentation and tests.

### NET-005: h2spec baseline still carries allowlist and omitted coverage debt

- Files: `tests/integration/h2spec.test.mts`,
  `tests/integration/h2spec-allowed-failures.json`, `tests/net/http2.test.mts`
- Spec target: RFC 7540/7541 h2spec coverage, mapped to RFC 9113 where relevant.
- Expected behavior: runnable h2spec cases pass or have narrow source-backed
  exceptions; omitted sections have deterministic local equivalents.
- Current behavior: many allowlist entries are timing/harness related, and
  sections `6.6` and `6.9` are omitted with local coverage rationale.
- Coverage gap: h2spec `6.9` local equivalents are not clearly named by
  subsection, making regression tracking harder.
- Priority: P2
- Follow-up: rerun with newer h2spec/harness isolation, reduce allowlist, and map
  local flow-control tests to omitted subsections.

### FFS-001: ZIP central/local header consistency is not validated

- Files: `js/archive.mts`
- Spec target: ZIP APPNOTE local file header and central directory records.
- Expected behavior: central and local header fields should agree for supported
  entries, including flags, method, CRC, sizes, and filename when data
  descriptors are not used.
- Current behavior: parser trusts central metadata and uses local name/extra
  lengths mainly to locate payload bytes.
- Coverage gap: no fixtures for central/local metadata mismatch.
- Priority: P1
- Follow-up: compare local and central fields and reject unsupported local flags.

### FFS-002: Stored ZIP entries bypass decompressed-size guard

- Files: `js/archive.mts`
- Spec target: archive module safety contract and ZIP method 0.
- Expected behavior: size caps and size-equality checks apply to stored entries
  as well as deflated entries.
- Current behavior: stored entries verify CRC and return bytes without the same
  cap or `compressedSize === size` consistency check.
- Coverage gap: no large stored-ZIP or stored-size mismatch fixture.
- Priority: P1
- Follow-up: apply `MAX_DECOMPRESSED_BYTES` and stored-size consistency checks in
  the store branch.

### FFS-003: Tar numeric fields are parsed without octal validation

- Files: `js/archive.mts`
- Spec target: POSIX ustar header numeric fields.
- Expected behavior: numeric fields contain valid octal digits plus permitted
  terminators, or a declared supported alternative.
- Current behavior: values are passed to `parseInt(..., 8)` without ensuring all
  characters are valid octal.
- Coverage gap: no valid-checksum tar fixtures with invalid numeric fields.
- Priority: P2
- Follow-up: validate octal fields strictly and reject `NaN`.

### FFS-004: XML parser accepts invalid names and namespace errors

- Files: `js/format/xml.mts`
- Spec target: XML 1.0 Names/attributes and Namespaces in XML.
- Expected behavior: element/attribute names obey XML Name syntax; duplicate
  attributes and duplicate expanded attribute names are rejected; namespace
  prefixes are bound; reserved prefixes are constrained; close tags match the
  qualified or expanded name.
- Current behavior: names are parsed loosely, duplicate attributes overwrite in a
  plain object, unbound prefixes resolve to `null`, and namespaced close-tag
  comparison uses local names.
- Coverage gap: no tests for invalid names, duplicate attributes, unbound/reserved
  prefixes, duplicate expanded names, or qualified close-tag mismatch.
- Priority: P1
- Follow-up: add XML Name, namespace, duplicate, and close-tag validation.

### FFS-005: XML entity/reference handling is incomplete

- Files: `js/format/xml.mts`
- Spec target: XML 1.0 entity replacement text and character references.
- Expected behavior: internal entity replacement text recursively expands under
  cycle/depth limits, and numeric references are non-empty and XML-valid code
  points.
- Current behavior: internal entity values are returned raw, and numeric refs are
  weakly validated before `String.fromCodePoint()`.
- Coverage gap: no tests for nested/recursive entities, empty numeric refs,
  surrogates, or out-of-range XML characters.
- Priority: P2
- Follow-up: implement bounded recursive expansion and XML char validation, or
  document recursion as unsupported.

### FFS-006: JSON Schema `type` arrays are ignored

- Files: `js/validate.mts`
- Spec target: JSON Schema `type` keyword.
- Expected behavior: `type: ["string", "null"]` accepts either string or null and
  rejects other values.
- Current behavior: array-valued `type` becomes undefined and imposes no type
  check.
- Coverage gap: no tests for nullable/common type arrays.
- Priority: P2
- Follow-up: support string-array `type` or explicitly document and test it as
  outside the subset.

### FFS-007: SemVer numeric identifiers can exceed safe precision

- Files: `js/semver.mts`
- Spec target: SemVer 2.0.0 numeric precedence.
- Expected behavior: numeric identifiers compare exactly by integer value.
- Current behavior: identifiers are converted to `Number()`, so values beyond
  `Number.MAX_SAFE_INTEGER` can compare incorrectly.
- Coverage gap: no large numeric identifier tests.
- Priority: P2
- Follow-up: reject unsafe numeric identifiers or compare with exact string/BigInt
  logic.

### RTE-001: W3C `traceparent` extraction accepts invalid forms

- Files: `js/internal/opentelemetry/common.mts`
- Spec target: W3C Trace Context.
- Expected behavior: invalid version `ff` and invalid uppercase hex forms should
  be ignored rather than producing remote parent context.
- Current behavior: extraction uses a case-insensitive regex and lowercases IDs;
  it rejects all-zero IDs and some v00 trailing data but not version `ff` or
  uppercase IDs.
- Coverage gap: no negative propagation tests for version `ff`, uppercase IDs,
  malformed lengths, or trailing data variants.
- Priority: P2
- Follow-up: tighten parser to the W3C grammar and add negative tests.

### RTE-002: Multi-token SRI verification checks only the first token

- Files: `js/internal/package_manager.mts`
- Spec target: Subresource Integrity metadata and npm `dist.integrity`.
- Expected behavior: when multiple hash expressions exist, verification should
  select a supported strongest usable hash token.
- Current behavior: only the first token is parsed and verified; tests lock in
  ignoring garbage second tokens.
- Coverage gap: no tests for unsupported first plus valid second, or weaker valid
  first plus stronger invalid second.
- Priority: P2
- Follow-up: parse all SRI tokens, rank supported algorithms, and verify the
  strongest supported token.

### RTE-003: `import.meta` file URLs are raw path concatenations

- Files: `js/internal/loader.mts`
- Spec target: WHATWG file URL serialization and host `import.meta.url`.
- Expected behavior: paths with spaces, `#`, `?`, `%`, and reserved characters
  are percent-encoded in file URLs and round-trip through `new URL()`.
- Current behavior: URLs are built as `'file://' + filename` or canonical path;
  tests assert raw concatenation.
- Coverage gap: no imported module path with reserved URL characters.
- Priority: P2
- Follow-up: add a file URL serializer and update tests to expect encoded URLs
  while keeping `import.meta.filename` decoded.

### RTE-004: `startCluster()` self-join ignores configured hostname

- Files: `js/cluster.mts`
- Spec target: WebTransport URL authority and public `StartClusterOptions.hostname`.
- Expected behavior: seed self-connection uses a reachable authority for the
  configured listener or rejects invalid combinations clearly.
- Current behavior: seed transport receives `opts.hostname`, but local worker
  self-join always connects to `https://127.0.0.1:${port}${path}`.
- Coverage gap: no test for non-default hostname/self-join URL.
- Priority: P2
- Follow-up: build self-join URL from `opts.hostname` or document/validate
  loopback-only self-participation.

### RTE-005: Cluster heartbeat liveness trusts sender timestamps

- Files: `js/internal/cluster/seed.mts`
- Spec target: cluster membership/liveness semantics.
- Expected behavior: liveness is based on seed receive time, not worker-supplied
  timestamps.
- Current behavior: `HEARTBEAT` stores `msg.ts` and timeout compares local
  `Date.now()` against that sender value.
- Coverage gap: no tests for future timestamps, stale timestamps from healthy
  peers, or skewed workers.
- Priority: P1
- Follow-up: store `Date.now()` on receipt and treat `msg.ts` as diagnostic only.

## Test Coverage Priorities

- P1 web platform: event-handler attribute dispatch parity and MessagePort
  transfer-list validation.
- P1 networking: H3 malformed pseudo-header tests, WebTransport missing SETTINGS
  rejection, and end-to-end WebTransport unidirectional stream routing.
- P1 archive/XML: ZIP local/central mismatch, stored ZIP size guard, and XML name
  and namespace invalid cases.
- P1 cluster: heartbeat liveness based on seed receive time.
- P2 runtime/security: W3C trace-context negative cases, SRI multi-token ranking,
  encoded `import.meta.url` paths, JSON Schema `type` arrays, and SemVer unsafe
  numeric identifiers.

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
- YAML custom tags/object construction, TOML style preservation, XML prolog/node
  preservation, and JSON Schema advanced keywords are outside the current parser
  baselines.
- OpenTelemetry is Fino-native with OTLP/HTTP JSON export, not strict upstream
  package, OTLP protobuf, or OTLP/gRPC parity.
- Cluster assumes one trusted seed. Authentication, seed election, hostile-peer
  behavior, and direct peer-to-peer port delivery are deferred.
- QUIC external interop, advanced peer-controlled migration/VN, and some
  backend-specific TLS parity remain gated or deferred where existing research
  docs say so.

