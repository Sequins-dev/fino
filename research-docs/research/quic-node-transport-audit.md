# QUIC Node Transport Audit

This note records the verified deltas from the current comparison with
`~/Code/cpp/node`. Each item includes the source proof used for implementation
so future audits can distinguish fixed behavior from open work.

## Release Lanes And Deferred Node Scope

Required QUIC release evidence comes from local loopback, simulator, recovery,
raw-packet, stream, and HTTP/3 tests. External lanes are intentionally gated:
`tests/net/quic-hq.test.mts` runs when ngtcp2 HQ tools are installed,
`tests/net/quic-node-interop.test.mts` runs when `NODE_QUIC_BIN` points at a
Node build exposing `node:quic`, and the loopback throughput benchmark runs
when benchmark binaries are configured.

Node comparison gaps that remain release-acceptable:

- DATAGRAM interop parity depends on Node's experimental QUIC DATAGRAM API
  exposing real send/status controls; the current fixture records this as a
  gap rather than claiming proof from stream sentinels.
- Resumed-session external interop is not proven by the Node lane yet, even
  though local session-ticket and 0-RTT behavior is covered.
- Active migration and external Version Negotiation interop are deferred until
  Node or another peer exposes deterministic controls for those scenarios.
- Backend-specific TLS limits remain explicit: OpenSSL-only SNI context and TLS
  group controls are release scope and tested; GnuTLS parity for those controls
  is deferred.

## Endpoint Packet Accounting

- Node proof: `src/quic/endpoint.cc:1358-1369` filters block-listed packets
  before packet accounting and increments only `packets_blocked`.
- Node proof: `src/quic/endpoint.cc:1372-1394` increments endpoint
  `packets_received` and `bytes_received` only when `Session::ReadPacket()`
  succeeds.
- Node proof: `src/quic/endpoint.cc:1512-1519`, `1592`, `1632`, `1661`, and
  `1816` increment packet-only accounting for busy/limit immediate close,
  invalid Retry-token close, Retry, invalid regular token Retry, and Version
  Negotiation paths.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts:3071-3073`
  incremented packet and byte stats at datagram entry.
- Resolution: Fino now records packet+bytes only after successful connection
  reads and records packet-only stats for Retry, Version Negotiation, and
  immediate close processing.
- Tests: `tests/net/quic-sim.test.mts` covers source filtering, malformed
  Initial drops, Version Negotiation, Retry, busy/limit refusal, and
  session-creation rate-limit drops.

## NEW_TOKEN Versus TLS Session Tickets

- Node proof: `lib/internal/quic/quic.js:3767-3800` separates
  `onsessionticket` from `onnewtoken`.
- Node proof: `src/quic/session.cc:3628-3670` emits TLS session-ticket payloads
  through a dedicated session-ticket callback.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts:5286-5299`
  persisted NEW_TOKEN but dispatched `sessionticket`.
- Resolution: Fino now dispatches `newtoken` with `QuicNewTokenEvent` for QUIC
  address-validation tokens and keeps `sessionticket` for TLS tickets.
- Tests: `tests/net/quic.test.mts` asserts NEW_TOKEN persistence, event
  separation, and topic payloads.

## Diagnostics-Channel Parity Via Fino Topics

- Node proof: `lib/internal/quic/diagnostics.js:6-45` defines QUIC lifecycle
  diagnostics channels, and `lib/internal/quic/quic.js:4268-4277` publishes
  endpoint busy changes when subscribers exist.
- Fino equivalent: `fino:context/topic` topics.
- Latest verified gap: Fino previously published only five QUIC topics:
  endpoint busy changes, session tickets, NEW_TOKEN, DATAGRAM status, and stream
  close.
- Resolution: Fino now publishes Node transport diagnostics-channel equivalents
  through topics for endpoint lifecycle, session lifecycle, handshake, key
  update, received Version Negotiation, streams, DATAGRAM send/receive/status,
  path validation, token/ticket, and close/error paths. Publication is gated by
  `topic(name).hasSubscribers`.
- Tests: `tests/net/quic.test.mts` subscribes to the transport topic set and
  verifies production QUIC objects or existing internal callback hooks publish
  the expected payloads.

## Handshake Diagnostics TLS Metadata

- Node proof: `lib/internal/quic/quic.js:3869-3908` publishes
  `quic.session.handshake` with local/remote addresses, `servername`,
  `protocol`, `cipher`, `cipherVersion`, verification error details, and
  early-data booleans.
- Node proof: `test/parallel/test-quic-diagnostics-channel-session.mjs:19-27`
  asserts handshake diagnostics fire on both peers and include standard TLS
  fields.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts:4622-4628`
  published only connection, local/remote addresses, ALPN, and QUIC version.
- Resolution: Fino now keeps its `connection` and `alpnProtocol` fields, adds
  Node-aligned `protocol`, TLS metadata, verification status, and early-data
  booleans, and reports backend-unavailable TLS metadata as `null`.
- Tests: `tests/net/quic.test.mts` asserts the handshake topic includes the
  Node-aligned TLS metadata fields while preserving Fino naming.

## Diagnostics Payload Owner/Error Context

- Node proof: `lib/internal/quic/quic.js:2482-2489` publishes
  `quic.stream.closed` with `stream`, owning `session`, `error`, and `stats`.
- Node proof: `lib/internal/quic/quic.js:2550-2556` publishes
  `quic.stream.reset` with `stream`, owning `session`, and `error`.
- Node proof: `lib/internal/quic/quic.js:3574-3580` publishes
  `quic.session.closed` with `session`, `error`, and `stats`.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts:5819-5823`
  published stream reset topics without the owning connection;
  `js/internal/net/quic/endpoint.mts:5887-5893` published stream close topics
  with only the stream; and `js/internal/net/quic/endpoint.mts:4350-4352`
  published session close topics without the close error.
- Resolution: Fino topics now keep Fino naming (`connection` instead of
  Node's `session`) while preserving owner, error, and stats context for stream
  reset, stream close, and session close payloads.
- Tests: `tests/net/quic.test.mts` asserts `quic.stream.reset`,
  `quic.stream.closed`, and `quic.session.closed` expose owner connection,
  error, and stats payloads where Node does.

## DATAGRAM Send IDs And Source Types

- Node proof: `lib/internal/quic/quic.js:3272-3343` documents that
  `sendDatagram()` returns the sent DATAGRAM ID and accepts strings,
  `ArrayBufferView` sources, and promises.
- Node proof: `test/parallel/test-quic-datagram-status.mjs:50-73` asserts
  status callbacks report the same ID returned by `sendDatagram()`.
- Node proof: `test/parallel/test-quic-datagram-sources.mjs:22-220` covers
  encoded string sources, promises, shared-buffer-backed views, partial views,
  and `DataView`.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts:4139-4176`
  accepted only `Uint8Array`, generated an internal ID, and returned `void`,
  leaving applications unable to correlate status events with sends.
- Resolution: Fino `sendDatagram()` now returns the generated numeric ID,
  accepts Node-covered byte source shapes, copies the exact source view before
  queueing, and keeps existing Fino rejection policy for local validation
  failures.
- Intentional divergence preserved: zero-length DATAGRAMs still return a real
  ID and are delivered because RFC 9221 permits them, even though Node returns
  its nil DATAGRAM ID for zero-length sources.
- Tests: `tests/net/quic.test.mts` asserts returned IDs correlate with Fino
  status events/topics, drop policies report returned IDs, zero-length
  DATAGRAMs return IDs, and source encodings/views preserve expected bytes.

## Received Version Negotiation Diagnostics

- Node proof: `src/quic/session.cc::on_receive_version_negotiation` calls
  `Session::EmitVersionNegotiation()`, and
  `lib/internal/quic/quic.js:[kVersionNegotiation]` publishes
  `quic.session.version.negotiation`.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts` installed a no-op
  `CB_RECV_VERSION_NEGOTIATION` callback and delegated only the crypto
  `CB_VERSION_NEGOTIATION` helper to ngtcp2_crypto, so no Fino topic could
  observe received session Version Negotiation.
- Resolution: Fino now keeps the crypto helper delegated and adds a receive
  callback that publishes `quic.session.version.negotiation` through topics with
  raw wire-version arrays.
- Tests: `tests/net/quic.test.mts` asserts the lifecycle topic set includes the
  received Version Negotiation topic and payload.

## Draining Period Multiplier

- Node proof: `lib/internal/quic/quic.js` documents and validates
  `drainingPeriodMultiplier` as a `3..255` multiplier, and
  `src/quic/session.cc::UpdateTimer()` computes draining expiry as
  `now + multiplier * ngtcp2_conn_get_pto()`.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts` accepted
  `connection.drainingPeriodMultiplier`, but endpoint route/CID cleanup used a
  fixed `CONNECTION_DRAINING_TIMEOUT_MS` value of 3000 ms.
- Resolution: Fino now binds `ngtcp2_conn_get_pto()`, snapshots
  multiplier-based route retention before freeing the native connection, and
  uses that value when removing CIDs from the endpoint route table.
- Tests: `tests/net/quic-sim.test.mts` proves a custom multiplier retains the
  route past the old fixed 3000 ms timeout and eventually removes it.

## Peer-Initiated Key Update Coverage

- Node proof: `test/parallel/test-quic-key-update-peer.mjs` initiates key
  update from the server and verifies client stream traffic continues.
- Fino proof: `CB_RECV_RX_KEY` and `CB_RECV_TX_KEY` are wired, and simulator
  traffic continues after a server-initiated key update.
- Resolution: no implementation change was needed; this was a missing proof.
- Tests: `tests/net/quic-sim.test.mts` covers peer-initiated key update.

## Stream Flow-Control Blocked Events

- Node proof: `lib/internal/quic/diagnostics.js` defines
  `quic.stream.blocked`; `lib/internal/quic/quic.js:[kBlocked]` publishes the
  diagnostic and invokes `stream.onblocked`; and
  `test/parallel/test-quic-stream-onblocked.mjs` proves the callback fires when
  stream-level flow control blocks sender progress.
- Fino proof before fix: `js/internal/net/quic/endpoint.mts` published
  `quic.stream.blocked` when `NGTCP2_ERR_STREAM_DATA_BLOCKED` was returned, but
  `QuicStream` had no corresponding EventTarget `blocked` event.
- Resolution: Fino now dispatches a typed `QuicStreamBlockedEvent` on the
  blocked stream while preserving the existing Fino topic payload.
- Tests: `tests/net/quic-sim.test.mts` asserts blocked topics and blocked
  stream events both carry the affected connection and stream.

## Stream Reset Error-Code Events

- Node proof: `test/parallel/test-quic-stream-reset-before-data.mjs` and
  `test-quic-stream-reset-stop.mjs` assert reset callbacks expose QUIC
  application error codes.
- Fino proof before fix: `quic.stream.reset` topic payload included
  `errorCode`, but the public EventTarget `reset` event was a generic
  `QuicErrorEvent` with only `error`.
- Resolution: Fino now dispatches `QuicStreamResetEvent` with both `error` and
  `errorCode`.
- Tests: `tests/net/quic.test.mts` covers the event class and
  `tests/net/quic-sim.test.mts` asserts peer RESET_STREAM code propagation.

## Callback Error Semantics

- Node proof: `lib/internal/quic/quic.js:4635-4665` routes server-session
  callbacks through `safeCallbackInvoke`, and the callback-error tests under
  `test/parallel/test-quic-callback-error-*.mjs` assert lifecycle handling for
  callback throws.
- Fino proof: `js/internal/globals/eventtarget.mts` catches listener exceptions
  during `dispatchEvent()` so later EventTarget listeners still run.
- Resolution: this remains an intentional Fino API divergence. The public model
  is EventTarget rather than Node callback properties, so listener throws are
  isolated instead of becoming transport lifecycle errors.
- Tests: `tests/net/quic.test.mts` documents the behavior with a throwing QUIC
  stream listener followed by a second listener.

## Evidence Matrix

- Issue: `research-docs/research/quic-conformance-matrix.md` used `Direct`
  for more rows than `tests/net/fixtures/quic/spec-fixtures.json` mapped.
- Latest verified gap: the test only checked that evidence fields were non-empty;
  stale test names could still pass, and original alignment-plan rows could be
  omitted from the matrix entirely.
- Resolution: `spec-fixtures.json` has top-level `evidence` entries for every
  Direct matrix row, and `tests/net/quic.test.mts` now verifies that each
  referenced test file exists and contains the named test or benchmark marker.
  The same meta-test carries an explicit completeness list for the remaining
  original-plan rows so omissions fail even when no row is present.

## Transport Batching And ECN

- Node proof: `src/quic/endpoint.cc` batches UDP writes through the endpoint send
  path and keeps packet metadata attached to individual sends.
- Fino proof before fix: QUIC writes sent one datagram per native call from the
  write loop and discarded ngtcp2 ECN packet-info metadata.
- Resolution: Fino transports now expose `sendBatch`/`recvBatch`; Linux real
  UDP transports use `sendmmsg`/`recvmmsg` with per-message buffers and
  ancillary-data slots, while Darwin and other platforms retain loop fallbacks.
  The QUIC write drain queues encoded packets into reusable buffers before
  flushing, and the simulator carries per-datagram ECN metadata through ngtcp2
  `ngtcp2_pkt_info`. Real UDP transports keep ECN off by default; when enabled
  they request receive traffic-class control messages, parse `recvmsg`/`recvmmsg`
  ECN metadata, and apply ngtcp2's outbound ECN marks with per-packet
  `sendmsg`/`sendmmsg` traffic-class control messages.
- Tests: `tests/net/quic-sim.test.mts` proves multi-packet `sendBatch` use and
  ECT(0) metadata propagation with DATAGRAM delivery intact.
  `tests/net/quic.test.mts` proves the real UDP ECN receive path preserves
  DATAGRAM delivery on IPv4 loopback. `tests/net/quic.test.mts` also exposes
  the larger batched receive turn limit through `__inspectQuicRuntimeTuning()`.
- Benchmark: `benchmarks/net/quic-loopback-transfer.bench.mts` is a bounded
  loopback bulk-transfer benchmark that emits JSON throughput results outside
  the adaptive `fino:bench` runner. It also supports
  `QUIC_BENCH_BASELINE_BIN` and `QUIC_BENCH_CANDIDATE_BIN` comparison mode,
  emitting baseline, candidate, and throughput ratio in one JSON object.
  Current release baseline on this worktree: 8 MiB in 333 ms, 24.02 MiB/s,
  64 KiB chunks, `fino-bench` ALPN. Earlier candidate measurement on this
  worktree was 8 MiB in 329 ms, 24.32 MiB/s.

## Stream Stats And DATAGRAM Migration Cross-Checks

- Latest verified gap: stream objects could be inspected after local FIN and
  peer read completion while `bytesAcked` still reported zero, because native
  ACK accounting may arrive after the stream object leaves the active map.
- Resolution: Fino keeps closed stream objects available for late ACK accounting
  and exposes terminal sent bytes in immutable stream stats once a writer is
  closed and no ACK callback has populated the field.
- Latest verified gap: DATAGRAM-only sends after active migration could use a
  stale path cache unless another write path synchronized active path state.
- Resolution: `sendDatagram()` now refreshes the active path from ngtcp2 before
  enqueueing the DATAGRAM frame.
- Tests: `tests/net/quic-streams.test.mts` covers half-close final-size and
  ACK stats, RESET_STREAM before data / crossing data / after FIN,
  stream-level `MAX_STREAM_DATA` unblock, unidirectional `MAX_STREAMS`
  exhaustion and credit return, plus STOP_SENDING crossing data.
  `tests/net/quic-sim-recovery.test.mts` covers repeated key updates under
  deterministic loss, persistent-congestion stats with RTT tolerance and cwnd
  collapse, path-validation abort on close, and DATAGRAM delivery plus ACK
  status before and after active migration.

## TLS Context Parity

- Node proof: Node's QUIC TLS options support per-server-name context selection,
  CA pinning, client-certificate verification, and supported group constraints.
- Resolution: Fino now supports in-memory PEM CA trust, mTLS peer certificate DER
  exposure, OpenSSL per-SNI contexts with wildcard matching (including runtime
  `setSNIContexts()` to rebuild contexts mid-listener), and `tlsGroups`
  through OpenSSL's `SSL_CTX_ctrl(..., SSL_CTRL_SET_GROUPS_LIST, ...)`. The
  `rejectUnauthorized: false` server option allows the TLS handshake to complete
  when a client cert fails CA verification while still surfacing the cert.
- Remaining divergence: per-SNI contexts and group constraints are
  **OpenSSL-only by design** — see Dual-Backend Design below.
- Tests: `tests/net/quic.test.mts` covers CA PEM, mTLS DER exposure, per-SNI
  ALPN selection, runtime `setSNIContexts`, `rejectUnauthorized: false` mTLS,
  and a constrained `X25519` QUIC TLS handshake.

## Dual-Backend TLS Design

- Node's approach: Node vendors OpenSSL 3.5.x and links against it exclusively.
  This gives Node the OpenSSL 3.5 QUIC TLS API (`SSL_set_quic_tls_*`,
  `OSSL_QUIC_*`) unconditionally.
- Fino's approach: Fino uses **system-installed** libraries (dlopen with
  candidate-path search). System OpenSSL on current Linux LTS targets (Ubuntu
  22.04/24.04, Debian 12, RHEL 9) is OpenSSL 3.0, which predates the QUIC TLS
  API. Those distributions ship `libngtcp2_crypto_gnutls` via GnuTLS instead.
- Decision: **Keep both backends** — prefer the OpenSSL ngtcp2 backend when
  system OpenSSL ≥3.5 is present, fall back to GnuTLS on older LTS where only
  GnuTLS is available. This is cheap because `crypto.mts` is already a single
  facade with ~12 `if (backend==='ossl')…else…` branches. Phasing out GnuTLS
  later means deleting the leaf module and `else` arms with no endpoint changes.
- OpenSSL-only features (documented limitations, not bugs):
  - Per-SNI TLS contexts (`sni` listen option + `setSNIContexts()`).
  - TLS `groups` (`tlsGroups` option).
- GnuTLS parity additions: mTLS (`gnutls_certificate_server_set_request`
  with REQUEST/REQUIRE mode per `rejectUnauthorized`), CA trust
  (`gnutls_certificate_set_x509_trust_file/dir/mem`), peer certificate DER
  exposure (`gnutls_certificate_get_peers`), peer verification result
  (`gnutls_certificate_verify_peers3`), cipher/protocol metadata, keylog.
- Tests: `tests/net/quic.test.mts` gates per-SNI and `tlsGroups` tests on
  `cryptoBackend === 'ossl'`. The "QUIC GnuTLS backend parity" describe block
  gates four tests on `cryptoBackend === 'gnutls'` and skips cleanly when the
  active backend is OpenSSL.

## Remaining Alignment Proof Gaps

- Node interop `datagram` and `resume` scenarios are release `Out of Scope`,
  not `Missing`. The current fixtures prove gated raw QUIC stream exchange with
  scenario labels but do not claim QUIC DATAGRAM frames/status callbacks
  (Node's experimental QUIC DATAGRAM API is not exposed) or two-connection
  external session resumption/0-RTT. Local DATAGRAM and resumed-session behavior
  is covered directly.
- Node interop `keyupdate` and `retry` scenarios are now `Direct`: Fino
  initiates a key update in both interop directions (proving the Node partner
  processed it without failure), and the Fino server's default Retry policy
  means every Node interop handshake completes through an actual Retry packet.
- Node interop migration and external Version Negotiation remain release
  `Out of Scope` until the configured Node experimental QUIC API exposes enough
  control to force those wire events or the fixtures grow a documented
  alternative. Local migration and Version Negotiation coverage is direct.
- Previously open local proof rows are now direct in the conformance matrix for
  bad-CID client Version Negotiation rejection, incompatible Version Negotiation
  typed failure without bogus CONNECTION_CLOSE, ACK-frequency threshold effects,
  and active-CID-limit rotation/retirement under migration.
- Keylog evidence now parses a `CLIENT_HANDSHAKE_TRAFFIC_SECRET` line and
  validates the SSLKEYLOGFILE field shape instead of checking only for a
  substring.
