# QUIC Conformance & Node-Alignment Plan

## Context

fino's Phase 1 QUIC transport (`js/internal/net/quic/endpoint.ts` over libngtcp2 FFI) is substantially complete: handshake (v1/v2), streams, flow control, datagrams (RFC 9221), retry/tokens/stateless-reset/rate-limiting, migration + preferred address, 0-RTT/resumption, key update, qlog/keylog, busy mode, connection limits. The companion docs (`quic-conformance-matrix.md`, `quic-node-transport-audit.md`) record already-resolved Node deltas and intentional divergences (boolean `verifyPeer`, EventTarget isolation, zero-length DATAGRAM delivery).

This plan covers what remains to be **fully conformant with RFC 8999/9000/9001/9002/9221 (+9368)** and **significantly aligned with Node.js's QUIC design** (`src/quic/*`, `lib/internal/quic/quic.js` in Node core, also built on ngtcp2), plus a test-expansion program so every behavior has an explicit proof. h3 ALPN negotiation is in scope; an HTTP/3 (nghttp3) application layer is not (future task).

**Decisions:**
- `close()` becomes **graceful** close; add `destroy()`; clean break (update existing call sites/tests).
- **ECN included** as the final phase (off by default, behind a transport option) — exceeds Node parity.
- **TLS backend: keep both OpenSSL ≥3.5 (preferred) and GnuTLS (Linux fallback).** Node vendors OpenSSL 3.5.x and therefore always has the OpenSSL 3.5 QUIC TLS API. Fino uses system-installed libraries (dlopen with candidate-path search); current Linux LTS targets (Ubuntu 22.04/24.04, Debian 12, RHEL 9) ship system OpenSSL 3.0 and rely on `libngtcp2_crypto_gnutls` instead. Keeping both backends is cheap because `crypto.ts` is a single facade. Phase GnuTLS out later when target distros ship ≥3.5 — that means deleting the leaf module and `else` arms with no endpoint changes. OpenSSL-only features (per-SNI contexts, TLS `groups`) are documented limitations of the GnuTLS arm, not bugs. GnuTLS implements: mTLS (`gnutls_certificate_server_set_request` with REQUEST/REQUIRE), `rejectUnauthorized: false`, CA trust (`gnutls_certificate_set_x509_trust_file/dir/mem`), peer cert DER exposure (`gnutls_certificate_get_peers`), peer verification result (`gnutls_certificate_verify_peers3`), cipher/protocol metadata, SSLKEYLOGFILE-compatible keylog.

**Verified non-gaps** (no work needed; assumptions corrected during review):
- Compatible-VN settings (`preferred_versions`/`available_versions`) already written in `makeSettings` (endpoint.ts:2186-2189), matching Node session.cc:484-487.
- NEW_TOKEN issuance exists (`ngtcp2_conn_submit_new_token`, endpoint.ts:4731-4737).
- `read_pkt` error codes (RETRY/DROP_CONN/DRAINING/CLOSING/CRYPTO) are all handled; the gap is closing-*period* semantics (P0-1), not code coverage.
- Settings parity is good: `no_pmtud=1`, ack_thresh, cc_algo, max_window/max_stream_window, handshake timeout all match Node session.cc:460-531.
- Initial ≥1200, anti-amplification, Retry integrity, key-update timing, persistent congestion math: correctly delegated to ngtcp2 (consistent with the conformance matrix).

---

## Part A — Implementation work

### Phase 1 (P0): Spec-conformance correctness

#### P0-1. RFC 9000 §10.2 closing/draining period semantics
**Problem:** `#close()` (endpoint.ts:4319) writes one CONNECTION_CLOSE then immediately `ngtcp2_conn_del`s the conn (teardown ~4365); `_receivePacket` returns instantly when `#closed` (endpoint.ts:4976-4977). Routes are retained for `drainingPeriodMultiplier × PTO` but arriving packets are silently dropped — §10.2.1 requires the closing endpoint to re-send CONNECTION_CLOSE (with backoff). Also `canSendConnectionClose` requires `state === 'connected'` (4321-4324), so close during handshake is always silent (Node sends close in any state, session.cc:3076-3132). And on `NGTCP2_ERR_DRAINING` the peer's close error is discarded for connected sessions (4994-4996); Node extracts it via `QuicError::FromConnectionClose`.

**Changes (endpoint.ts):**
- Capture the serialized close packet into `#closePacket: { data, remoteAddress, fd }` before `ngtcp2_conn_del`.
- Drop the `state === 'connected'` precondition — ngtcp2 writes Initial/Handshake-level close packets mid-handshake; guard on bytes-written > 0 instead.
- Route packets that hit a closed (locally-closing) connection to a new `_receiveClosingPacket()`: increment a counter, resend `#closePacket` when a doubling threshold is crossed (§10.2.1 backoff). Peer-initiated draining stays silent (correct today).
- On `NGTCP2_ERR_DRAINING`, read `ngtcp2_conn_get_ccerr` before teardown; surface the decoded peer error in the `close` event / `quic.session.closed` topic, and add `connection.closeInfo: { errorCode, reason, type: 'transport'|'application', remote: boolean } | null`.
- Bind `ngtcp2_conn_in_closing_period` / `ngtcp2_conn_in_draining_period` in `bindings.ts`.

#### P0-2. Client first-flight version + incompatible VN handling (RFC 9000 §6 / RFC 9368)
**Problem:** `normalizeVersions` defaults `['v2','v1']` and `selectWireVersion` picks the first (endpoint.ts:1292, 1642-1648) → first flight is v2. Node defaults the wire version to v1 and lets compatible VN upgrade to v2. Worse, `NGTCP2_ERR_RECV_VERSION_NEGOTIATION` (-222) is not in `bindings.ts`, so a client receiving a Version Negotiation packet falls into the generic `rc !== 0` branch (endpoint.ts:4999-5004) and emits a bogus CONNECTION_CLOSE + error instead of retrying or failing cleanly.

**Changes:**
- Choose the client first-flight wire version as v1 when both versions are allowed (`versions` stays the allowed set; `preferred_versions` is already v2-first so compatible VN upgrades automatically). `versions: ['v2']` ⇒ first flight v2.
- Add `NGTCP2_ERR_RECV_VERSION_NEGOTIATION = -222` to bindings. In `_receivePacket`: on this code do **not** write CONNECTION_CLOSE; if the VN packet (already captured via `CB_RECV_VERSION_NEGOTIATION`, endpoint.ts:5491-5511) lists a mutually supported version and we haven't retried yet, recreate the native conn via `#createNative` with the new version and write `SETTINGS_ORIGINAL_VERSION` (offset exists at bindings.ts:373, never written) with the originally attempted version. Cap at one retry (RFC 9368 §2.3); otherwise fail with a typed `QuicVersionNegotiationError`.

#### P0-3. Hygiene: unbounded `#rejectedInitialCids`
Entries only added (endpoint.ts:3608) / checked (3252), cleared only on endpoint close. Convert to a size-capped LRU (reuse the `QuicAddressValidationCache` shape) or timestamp-pruned set.

### Phase 2 (P1): Close API + TLS capabilities

#### P1-1. Close API surface (graceful / destroy / silent) — clean break
Node reference: `gracefulClose` (session.cc:1924-1986 — refuse new streams, drain, then close), `destroy`, internal SILENT method, `closing`/`closed` getters.

```ts
export type QuicCloseOptions = { errorCode?: number; type?: 'transport' | 'application'; reason?: string };

class QuicConnection {
  close(options?: QuicCloseOptions): Promise<void>;   // NOW graceful: stop new streams, drain existing, then CONNECTION_CLOSE
  destroy(error?: Error, options?: QuicCloseOptions): void; // immediate: abort streams, send close frame, settle waiters
  get closing(): boolean;
  get closed(): Promise<void>;
  get closeInfo(): QuicCloseInfo | null;  // from P0-1
}
```
- `#gracefulClose` flag gates `openBidirectionalStream`/`openUnidirectionalStream`/`acceptStream`/`sendDatagram` and refuses new peer streams; when `#streams` empty and pending writes/datagrams drained, run the existing immediate-close path with `sendConnectionClose=true`. Mirror Node's half-closed nudge: `ngtcp2_conn_shutdown_stream_write` for writable-but-read-ended streams (session.cc:1964-1979).
- Keep the silent path internal. Add `QuicEndpoint.closeGracefully()` (Node endpoint.cc:1045) closing all connections gracefully and stopping listeners.
- **Update all existing call sites/tests** that use `close(code, reason)` → `destroy(undefined, { errorCode, reason })` or `close({ errorCode, reason })` as semantically appropriate.

#### P1-2. mTLS: `verifyClient` + peer certificate exposure (OpenSSL first)
- `js/internal/openssl.ts`: add `SSL_VERIFY_FAIL_IF_NO_PEER_CERT`, `sslGetPeerCertificate(ssl)` (SSL_get1_peer_certificate → i2d_X509 DER → X509_free); `sslGetVerifyResult` already exists (openssl.ts:2589).
- `crypto.ts`: `newServerContext(..., tlsOptions?: { verifyClient?: boolean; rejectUnauthorized?: boolean; ca? })`. With `rejectUnauthorized: false`, complete the handshake and surface the verify result instead of failing (Node tlscontext.h:204-210).
- `crypto-gnutls.ts` (straightforward subset): `gnutls_certificate_server_set_request` (REQUEST/REQUIRE), `gnutls_certificate_verify_peers3`, `gnutls_certificate_get_peers`.
- `endpoint.ts`: `QuicListenOptions += { verifyClient?, rejectUnauthorized?, ca? }`; on `QuicConnection`: `peerCertificate: Uint8Array | null` (DER) and `peerVerification: { verified, errorCode, reason } | null`, populated at `_onHandshakeCompleted` (~4679) and added to the `quic.session.handshake` topic.

#### P1-3. TLS trust options (`ca`)
- `QuicConnectOptions` (and listener options for mTLS): `ca?: { file?: string; directory?: string; pem?: string | Uint8Array | Array<…> }`.
- OpenSSL: `sslCtxLoadVerifyLocations` (exists unused, openssl.ts:2643) for file/dir; add `sslCtxAddCaCertificates` (BIO_new_mem_buf + PEM_read_bio_X509 + X509_STORE_add_cert) for in-memory PEM. When `ca` given, skip `sslCtxSetDefaultVerifyPaths` (pinned-roots semantics, same as Node). GnuTLS: `gnutls_certificate_set_x509_trust_file/_dir/_mem`. CRL deferred — document as divergence.

#### P1-4. Per-SNI server TLS contexts (OpenSSL-only initially)
- `openssl.ts`: `sslCtxSetServernameCallback` (SSL_CTX_callback_ctrl with SSL_CTRL_SET_TLSEXT_SERVERNAME_CB=53/ARG=54) + `sslSetSslCtx` (SSL_set_SSL_CTX); callback reads `SSL_get_servername`, swaps ctx, returns SSL_TLSEXT_ERR_OK/NOACK.
- `crypto.ts`: `setSNIContexts(ctx, entries)`, entries built via `newServerContext`.
- `endpoint.ts`: `QuicListenOptions.sni?: Record<string, { certificateFile, privateKeyFile, alpnProtocols?, verifyClient?, ca? }>` + `QuicListener.setSNIContexts()`; wildcard (`*.example.com`) matching like Node; free per-SNI contexts in `QuicListener.close()` (~3647). Mark OpenSSL-only in the conformance matrix.

### Phase 3 (P1): Option-surface parity (mechanical, independent)

#### P1-5. Configurable transport parameters
Currently hardcoded: `INITIAL_MAX_STREAM_DATA`/`INITIAL_MAX_DATA`/`INITIAL_MAX_STREAMS_BIDI/UNI`, `MAX_IDLE_TIMEOUT=10s`, `ACTIVE_CONNECTION_ID_LIMIT=2` (endpoint.ts:831-838, `makeTransportParams` 2199-2243). Node exposes all (transportparams.h:55-112). Add to `QuicConnectionOptions` (+ resolved options + snapshot): `maxIdleTimeoutMs`, `initialMaxData`, `initialMaxStreamDataBidiLocal/BidiRemote/Uni`, `initialMaxStreamsBidi/Uni`, `activeConnectionIdLimit` (clamp 2..8), `maxAckDelayMs`, `ackDelayExponent`, `disableActiveMigration` (server; currently always written 0 at 2213).

#### P1-6. Preferred address: both families + client policy
`preferredAddress?: { ipv4?: QuicAddress; ipv6?: QuicAddress }` (back-compat: accept bare `QuicAddress`); bind both transports in `listen()` (~2916-2935) and write both TP fields (offsets exist, bindings.ts:380-383). Client: `migration.usePreferredAddress?: boolean` (default false = ignore, Node's default) checked in `_selectPreferredAddress` (~5603).

#### P1-7. Endpoint UDP socket options
`QuicEndpointOptions.socket?: { ipv6Only?, reusePort?, receiveBufferSize?, sendBufferSize?, ttl? }` via `setsockopt` in `js/net/socket.ts` (IPV6_V6ONLY, SO_REUSEPORT, SO_RCVBUF, SO_SNDBUF, IP_TTL/IPV6_UNICAST_HOPS). Node parity: endpoint.h:135-152.

### Phase 4 (P2): Performance parity — prove with benchmarks before/after

#### P2-1. Send-path batching (sendmmsg/recvmmsg)
Today: one `sendto` + fresh `out.slice(0, n)` copy per packet (endpoint.ts:4294-4299; budget = min(quantum/maxPayload, 32)). Node batches via `uv_udp_try_send2`/sendmmsg with async fallback (endpoint.cc:615-631, 1020-1063).
- Extend `QuicDatagramTransport` with optional `sendBatch(packets)` / `recvBatch(max)`.
- `js/net/socket.ts`: bind `sendmmsg`/`recvmmsg` on Linux (mmsghdr/iovec/msghdr layouts in JS ArrayBuffers, same style as existing sockaddr encoding); Darwin fallback loops `sendto` inside `sendBatch` (still amortizes buffer prep).
- `_driveWrites`: accumulate packets into rotating preallocated buffers (kill the per-packet slice), flush once per drain; partial send (EAGAIN at packet k) parks the remainder in a generalized `#blockedSend` queue + `waitWritable()`. Stays within the async-I/O-only constraint.
- Read side: raise `MAX_READ_PACKETS_PER_TURN` (5, endpoint.ts:846) when recvmmsg available; one cached `now()` per burst (Node session.cc:2299).
- Simulated transport implements `sendBatch` trivially so the batched path is sim-testable.
- Design `sendBatch` with per-packet ancillary data in mind (ECN comes next). GSO (`UDP_SEGMENT`) deferred unless benchmarks justify.

#### P2-2. ECN (final phase; off by default, `transport.ecn?: boolean`)
- Recv: `setsockopt(IP_RECVTOS/IPV6_RECVTCLASS)`, switch to `recvmsg` + cmsg parse, populate a real `ngtcp2_pkt_info` buffer instead of `null` (endpoint.ts:4986 etc.).
- Send: pass a pkt_info out-buffer to `write_pkt/writev_stream/write_datagram/write_connection_close`, apply returned ECN per packet via `sendmsg` cmsg (mmsghdr supports per-message cmsgs).
- Simulator: per-datagram `ecn` field + trace support, so ngtcp2's ECN validation/blackhole-fallback is deterministically testable.

### Phase 5 (P3): Nice-to-have
- `connection.cidLength?: number` (8..20; NGTCP2_MIN_INITIAL_DCIDLEN=8); skip pluggable CID factories.
- GnuTLS keylog (`gnutls_session_set_keylog_function`) + cipher info so `getHandshakeInfo` stops returning nulls on that backend (crypto.ts:261-268).
- TLS `groups` option (`SSL_CTX_set1_groups_list`).
- Document remaining intentional divergences in `quic-node-transport-audit.md` (boolean `verifyPeer` and its default-false vs Node's verify-by-default; EventTarget vs callbacks; zero-length DATAGRAM delivery; Web Streams bodies).

---

## Part B — Test expansion

Harness selection rule: timing/loss/path-dependent → simulator (`QuicPipe`, deterministic clock); public API/real sockets/file outputs → loopback; wire compat → Node-interop fixtures (gated on `NODE_QUIC_BIN`, skip-friendly).

### B1. Shared infrastructure first (pure refactor; existing tests stay green)
- `tests/net/fixtures/quic/packet-craft.ts` — extract VN/Initial/short-header builders currently inlined in quic.test.ts.
- `tests/net/fixtures/quic/packet-parse.ts` — minimal header parser (form, version, DCID) for `pipe.trace()` assertions.
- `tests/net/fixtures/quic/interop-harness.ts` — extract spawn/ready/collect plumbing from quic-node-interop.test.ts; scenario-parameterize `quic-node-server.mjs`/`quic-node-client.mjs`/`quic-node-fino-*.ts` (`--scenario=echo|datagram|resume|keyupdate|large|retry|alpn-mismatch`).
- `sim-harness.ts`: add `rawDatagramSocket()` + trace packet-count helpers.

### B2. P0 test gaps (spec behavior with no proof today)
| Behavior | Harness | Assert |
|---|---|---|
| Stream half-close states; RESET_STREAM after FIN / before data / with data in flight; STOP_SENDING crossing in-flight data | sim (crossing frames) + loopback (API) | peer event + errorCode per case, reader EOF/reject mode, `finalSize`/`bytesAcked` stats, no data after stopSending |
| Stream-level MAX_STREAM_DATA blocked → `blocked` event → resume (only connection-level proven today) | sim | blocked event/topic with stream-level cause; write resolves after peer reads |
| Uni MAX_STREAMS exhaustion (limit 3) + credit return | sim | 4th `openUnidirectionalStream()` pends, resolves after peer closes one |
| Client receives VN from the wire (real path, not `_onVersionNegotiationForTest`); downgrade protection (VN listing current version ignored; bad CIDs ignored) | sim raw-socket injection | connect rejects with typed error + topic; no state change on forged VN |
| Expired Retry token | sim (manual clock) | `retryTokenRejected` increments, immediate close sent |
| Keep-alive PINGs prevent idle timeout; then blackhole → idle close; server-side idle timeout | sim | connection survives past idle window with keep-alive; closes without |
| Closing-period CONNECTION_CLOSE retransmit (lands with P0-1) | sim | trace shows close packet resent with backoff after peer packets arrive post-close |
| Close code/reason propagation to peer (code 42 + reason string; transport vs application distinction) | loopback | peer `close` event / `quic.session.closed` payload |
| Sustained-loss recovery: ≥4MB transfer at seeded 5–10% bidirectional loss | sim (new file) | completes; `packetsLost`/`bytesLost` populated |
| Congestion algorithm selection proof (cubic/reno/bbr) | sim | transfer completes per algo; settings reach ngtcp2 (add `@internal` resolved-settings snapshot hook, mirroring `__inspectQuicRuntimeTuning`) |
| Node interop: DATAGRAM exchange + status callbacks both directions | interop | delivery + ack/lost statuses |

### B3. P1 test gaps
- CID retirement/rotation under `active_connection_id_limit=2` across migration; `migrate()` rejected when migration disabled; path-validation abort on close mid-validation.
- Persistent congestion observable via stats (blackhole window mid-transfer → cwnd collapse below ssthresh → recovery); RTT stats ≈ simulated latency.
- Repeated key updates during bulk transfer under loss.
- Malformed-packet fuzz corpus: seeded truncations of a valid Initial at every boundary, zero-length UDP payload, garbage versions, short-header 1..20 bytes; endpoint stays usable afterward, counters monotone, seed logged on failure.
- API behaviors: `[Symbol.asyncDispose]` (endpoint/listener/connection, idempotent with close); `AbortSignal` on `reader.read()` (pre-aborted + mid-wait); events fire exactly once under races (idle-timeout vs explicit close); stats population after traffic.
- RFC 9368 compatible-upgrade proof: client v1+v2 vs server preferring v2 → negotiated version asserted via transport snapshot (or documented Delegated row with integration observation).
- Node interop scenarios: resumption + 0-RTT both directions; key update mid-stream; fino server with Retry vs Node client; ≥8MB transfers both directions; ALPN mismatch clean failure + explicit h3 ALPN assertion.
- Keylog content validity (parse `CLIENT_HANDSHAKE_TRAFFIC_SECRET` lines), `unacknowledgedPacketThreshold` ACK-frequency effect, zero-length 0-RTT DATAGRAM, DATAGRAM across migration, interop migration/VN (P2).

### B4. Tests landing WITH implementation work (mark `Missing` in matrix until then)
Graceful close semantics; mTLS/CA/per-SNI; configurable idle timeout + `disableActiveMigration` advertisement; dual-family preferred address + client ignore policy; closing-period retransmit; client-VN retry path; send batching (instrumented fake transport asserting multi-packet `sendBatch` calls + before/after benchmark); ECN (sim ECT(0) marking, ACK-ECN counts, stripped-path fallback).

### B5. File organization
```
tests/net/
  quic.test.ts               # extend close-code + dispose/signal tests only
  quic-streams.test.ts       # NEW: stream state machine + flow control
  quic-sim.test.ts           # stays the RFC 9000 core sim suite
  quic-sim-recovery.test.ts  # NEW: RFC 9002 loss/cc/persistent-congestion/ack-threshold
  quic-raw-packets.test.ts   # NEW: crafted packets — client VN, downgrade, expired Retry token, fuzz
  quic-node-interop.test.ts  # expanded: one it() per scenario
  fixtures/quic/{packet-craft,packet-parse,interop-harness}.ts  # NEW
  fixtures/quic/spec-fixtures.json  # evidence entries for every new Direct row
```

### B6. Conformance matrix updates
The meta-test in quic.test.ts already enforces that every `Direct` row has an `evidence` entry in `spec-fixtures.json` pointing at an existing `it(...)`. For each change: edit matrix + fixtures + test **together**.
- Split coarse rows into per-behavior rows (streams → half-close / reset-after-FIN / STOP_SENDING crossing / stream-level blocked / MAX_STREAMS; close → closing-period retransmit / code propagation; idle → keep-alive / server-side).
- New sections: RFC 9002 rows (sustained loss, persistent congestion, cc selection), RFC 9368, client-VN receipt + downgrade protection, expired Retry token, "Node API Parity" (asyncDispose, AbortSignal, once-only events, stats), per-scenario interop rows.
- Use `Missing` status for B4 items; flip to `Direct` + evidence when implementation lands.
- Update `quic-node-transport-audit.md` when new Node deltas surface during interop work.

---

## Sequencing

1. **B1 infra refactor** (no behavior change) → **Phase 1 P0 fixes** (P0-2, P0-3, then P0-1) each with their B2 tests + matrix rows.
2. **Phase 2** close API (P1-1, clean break incl. call-site migration) → mTLS (P1-2) → CA (P1-3) → SNI (P1-4), each layering on the previous `openssl.ts`/`crypto.ts` work, tests in the same change.
3. **Phase 3** option parity (P1-5/6/7, mechanical, parallelizable) + remaining B2/B3 test gaps (recovery suite, raw-packets suite, interop scenarios).
4. **Phase 4** batching (P2-1, with benchmark proof) then ECN (P2-2, batch design already cmsg-aware).
5. **Phase 5** P3 items + divergence documentation pass.

## Key files
- `js/internal/net/quic/endpoint.ts` — most implementation work
- `js/internal/net/quic/ngtcp2/bindings.ts` — new constants/bindings (ERR_RECV_VERSION_NEGOTIATION, in_closing/draining_period, ccerr access)
- `js/internal/net/quic/ngtcp2/crypto.ts`, `crypto-gnutls.ts`, `js/internal/openssl.ts` — TLS features
- `js/net/socket.ts` — setsockopt, sendmmsg/recvmmsg, recvmsg/sendmsg+cmsg
- `js/internal/net/simulated-provider.ts` — ECN modeling
- `tests/net/*` + `tests/net/fixtures/quic/*` + `research-docs/research/quic-conformance-matrix.md` — per B5/B6

## Verification
- Each phase: `cargo run -- test 'tests/net/quic*.test.ts'` and `tests/internal/stream.test.ts` green; matrix meta-test enforces evidence mapping.
- Interop scenarios run when `NODE_QUIC_BIN` points at the Node checkout's binary; otherwise skip cleanly.
- P2-1 requires a before/after throughput benchmark (loopback bulk transfer) — no perf claims without data.
- Final pass: conformance matrix has zero `Missing` rows except documented deferrals (CRL, GSO, pluggable CID factories, per-SNI on GnuTLS).
