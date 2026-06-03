# Fino Feature Roadmap

## Tier 2 — Ecosystem Compatibility

The single largest practical barrier to adoption is the inability to use npm packages. These items collectively bootstrap that access. The lesson from Deno vs. Bun: **ship npm compat early or stall**.

### 2.1 node: Protocol Aliases

- **Why**: Modern npm packages use `import x from 'node:fs'` bare specifiers. Without resolution these imports throw immediately and no workaround exists. A necessary prerequisite for npm compatibility.
- **Approach**: In `src/loader.rs`, add a `starts_with("node:")` branch to the specifier matching block (alongside the existing `fino:` and `internal:` checks in `resolve_module_callback`). Map known `node:` specifiers to their `fino:` equivalents (`node:path` → `fino:file/path`, `node:crypto` → crypto globals, etc.). Unrecognized `node:` specifiers produce a clear error.
- **Complexity**: Trivial (1–2 days). The mapping table will be incomplete but directionally correct and immediately useful.

### 2.3 Buffer Class

- **Why**: `Buffer` is the most-used Node.js API in the npm ecosystem. Packages that do any I/O, encoding, hashing, or serialization depend on it. Without `Buffer`, most non-trivial npm packages fail immediately.
- **Approach**: Implement `Buffer` as a `Uint8Array` subclass with the Node.js static and instance API: `Buffer.from(string, encoding)`, `Buffer.from(arrayBuffer)`, `Buffer.alloc(size)`, `Buffer.allocUnsafe(size)`, `Buffer.concat(list)`, `Buffer.isBuffer(v)`, `.toString(encoding)`, `.write(string, offset, encoding)`, `.readUInt32BE/LE()`, etc. Expose as `globalThis.Buffer`. Encodings: `utf8`, `hex`, `base64`, `base64url`, `binary`/`latin1`, `ascii`.
- **Complexity**: Medium (1 week). Tedious API surface but no novel logic; all encoding primitives already exist in `TextEncoder`/`TextDecoder` and `crypto`.

### 2.4 globalThis.process Compat Shim

- **Why**: Virtually every npm package that touches Node.js APIs checks `process.env`, `process.platform`, `process.version`, `process.exit()`, or `process.argv`. Without a `process` global they fail at startup.
- **Approach**: In `js/_main.mts`, construct a `globalThis.process` object mapping to existing `fino:process` exports: `env`, `argv`, `platform`, `version` (static string matching a recent Node.js version for compat), `exit()`, `cwd()`, `chdir()`, `pid`, `ppid`, `stdin`, `stdout`, `stderr`. The signal handlers also hang off this object.
- **Complexity**: Small (1 day). Pure wiring of already-implemented capabilities.

---

## Tier 3 — Broader Compatibility

Larger investments that extend reach to the long tail of the npm ecosystem and improve developer experience.

---

## Tier 4 — Advanced Capabilities

Long-term, strategic investments. High value but very large effort.

### 4.1 HTTP/2

- **Why**: Performance and compatibility with modern infrastructure. Required for gRPC.
- **Depends on**: TLS (done, ALPN negotiation for `h2`).
- **Complexity**: Very large. HTTP/2 framing, HPACK header compression, stream multiplexing, and flow control are each substantial projects.

### 4.2 QUIC and HTTP/3

- **Why**: QUIC unlocks UDP-based multiplexed transport, lower connection setup latency, connection migration, and the foundation for HTTP/3, WebTransport, HTTP/3 WebSockets, and DATAGRAM-based real-time protocols.
- **Approach**: Build `fino:net/quic` first as a JS-first thin-FFI module over ngtcp2 and `ngtcp2_crypto_ossl` with OpenSSL 3.5+. Then layer `fino:net/http/h3` over nghttp3 and eventually refactor H1/H2/H3 around one HTTP session/stream model while keeping Fetch-compatible handlers as the default developer experience.
- **Phasing**: Phase 1 is QUIC only. HTTP/3, unified HTTP architecture, fetch pooling, Alt-Svc, 0-RTT, DATAGRAM, WebTransport, HTTP/3 WebSockets, migration, and qlog diagnostics are tracked separately in `research-docs/research/quic-http3.md`.
- **Complexity**: Extremely large. QUIC requires packet routing by connection ID, UDP event-loop integration, QUIC-specific TLS APIs, timers, ACK-driven buffer lifetime, flow control, stream cancellation, and interoperability testing.
