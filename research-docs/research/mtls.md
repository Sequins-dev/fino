# mTLS Support Research

> Status: research and implementation-shaping note. This document describes
> what it would take to expose mutual TLS across Fino's TLS, HTTP, fetch, and
> QUIC-facing APIs. It is not an implementation commitment and does not freeze
> exact TypeScript names.

## 1. Goal

Add certificate-based client authentication so Fino applications can:

- present a client certificate when connecting to a TLS server;
- require or request client certificates on TLS servers;
- inspect peer certificate and verification state when needed;
- use the same conceptual TLS options across `TlsSocket`, `serveHttp`,
  `fetch()`, `HttpClient`, and QUIC/H3 surfaces.

The recommended model is **shared option semantics with transport-specific
implementation**. mTLS is valid across all of these surfaces, but it should not
land as one monolithic change because TCP OpenSSL, HTTP request plumbing, and
QUIC/H3 already have different mechanics.

## 2. Authoritative Requirements

Primary references:

- TLS 1.3: https://www.rfc-editor.org/rfc/rfc8446
- OpenSSL verification API:
  https://docs.openssl.org/3.0/man3/SSL_CTX_set_verify/
- OpenSSL certificate/key loading API:
  https://docs.openssl.org/3.0/man3/SSL_CTX_use_certificate/

Important TLS requirements from RFC 8446:

- Client authentication is requested by the server with `CertificateRequest`.
- A client sends a Certificate message if and only if the server requested
  client authentication.
- If the server requests client authentication and the client has no suitable
  certificate, the client sends an empty certificate list and still sends
  Finished.
- The server may continue without client authentication or abort when the client
  does not provide an acceptable certificate.
- Certificate-based client authentication is not available in PSK-only
  handshake flows, including 0-RTT.
- TLS 1.3 post-handshake client authentication exists, but it requires client
  support and a separate server request after the initial handshake.

Important OpenSSL behavior:

- `SSL_CTX_use_certificate_file`, `SSL_CTX_use_PrivateKey_file`, and
  `SSL_CTX_check_private_key` load and validate PEM certificate/key material.
- `SSL_VERIFY_PEER` in server mode sends a client certificate request and
  verifies any returned certificate.
- `SSL_VERIFY_FAIL_IF_NO_PEER_CERT` makes absence of a client certificate abort
  the handshake and must be used with `SSL_VERIFY_PEER`.
- `SSL_VERIFY_PEER` in client mode verifies the server certificate.
- Verification status can be read after the handshake with
  `SSL_get_verify_result`.

## 3. Current Repo State

Useful existing pieces:

- `js/internal/openssl.mts` already exposes most OpenSSL primitives needed for
  TCP mTLS:
  - `sslCtxUseCertKey()`
  - `sslCtxLoadCertKey()`
  - `sslCtxLoadVerifyLocations()`
  - `sslCtxSetDefaultVerifyPaths()`
  - `sslCtxAddCaCertificates()`
  - `sslCtxSetVerify()`
  - `sslCtxSetPermissiveVerify()`
  - `sslGetVerifyResult()`
  - `sslGetPeerCertificate()`
  - `SSL_VERIFY_PEER`
  - `SSL_VERIFY_FAIL_IF_NO_PEER_CERT`
- `js/net/tls.mts` has client TLS connection support with `hostname`, `ca`,
  `rejectUnauthorized`, and `alpn`.
- `js/net/tls.mts` can accept server-side TLS over an existing fd using a
  caller-owned `SSL_CTX`.
- `js/net/http/server.mts` supports TLS servers with `cert`, `key`, and ALPN
  protocols.
- `js/globals/fetch.mts`, `js/net/http/client.mts`, and
  `js/globals/eventsource.mts` already expose client trust options: `ca` and
  `rejectUnauthorized`.
- QUIC/H3 already has internal mTLS-adjacent options:
  `verifyClient`, `rejectUnauthorized`, `ca`, `certificateFile`, and
  `privateKeyFile` in the ngtcp2 crypto layer.

Main gaps:

- `TlsConnectOptions` has no client `cert` or `key` option.
- `TlsSocket.accept()` only accepts a prebuilt `SSL_CTX`; public server TLS
  options do not expose client certificate request/require modes.
- `serveHttp()` TLS options do not expose client CA configuration or client
  authentication policy.
- `fetch()` and `HttpClient` TLS options do not expose client certificates.
- Peer certificate and verification result helpers exist internally, but are
  not exposed on public TLS or HTTP request objects.
- `sslCtxLoadCertKey()` loads only the first certificate file with
  `SSL_CTX_use_certificate_file`; certificate-chain loading may need
  `SSL_CTX_use_certificate_chain_file` for production mTLS deployments.
- Existing tests intentionally assert that public `TlsSocket` does not expose
  mTLS helpers. Those tests will need to be revised once mTLS becomes public.

## 4. Recommended API Model

Use consistent TLS option names across surfaces, while preserving the existing
`ca` and `rejectUnauthorized` behavior.

Client-side candidate:

```ts
type ClientTlsOptions = {
  ca?: string | { file?: string; directory?: string; pem?: string | Uint8Array | Array<string | Uint8Array> };
  rejectUnauthorized?: boolean;
  cert?: string;
  key?: string;
  servername?: string;
  alpn?: readonly string[];
};
```

Server-side candidate:

```ts
type ServerTlsOptions = {
  cert: string;
  key: string;
  ca?: string | { file?: string; directory?: string; pem?: string | Uint8Array | Array<string | Uint8Array> };
  clientAuth?: 'none' | 'request' | 'require';
  rejectUnauthorized?: boolean;
  protocols?: readonly ('http/1.1' | 'h2')[];
};
```

Semantics:

- `clientAuth: 'none'`: do not request a client certificate.
- `clientAuth: 'request'`: request and verify a client certificate if one is
  provided, but allow the handshake without one.
- `clientAuth: 'require'`: request a client certificate and fail the handshake
  if none is provided.
- `rejectUnauthorized: false` should be treated as a development/testing escape
  hatch. On servers it can record verification failure while allowing the
  handshake, matching the existing QUIC permissive verify helper.
- `cert` and `key` should be validated as a pair before the handshake.

Open naming decision: Node uses `requestCert` and `rejectUnauthorized`; QUIC
internals already use `verifyClient`. A single `clientAuth` enum is clearer for
new public APIs because it avoids invalid combinations like `requestCert: false`
with `requireClientCertificate: true`.

## 5. Transport Integration

### 5.1 `TlsSocket`

Add client certificate loading in `_handshakeClient()`:

- if `opts.cert` and `opts.key` are provided, call `sslCtxUseCertKey()`;
- reject partial cert/key configuration before opening or handshaking;
- preserve existing server verification behavior for `ca` and
  `rejectUnauthorized`;
- add public methods for peer inspection:
  - `getPeerCertificate(): Uint8Array | null`
  - `getVerifyResult(): { code: number; reason: string | null }`

Add a server context helper instead of making callers assemble OpenSSL flags:

```ts
createTlsServerContext({
  cert,
  key,
  ca,
  clientAuth,
  rejectUnauthorized,
  alpn,
});
```

That helper can be internal first and later public if low-level server authors
need it.

### 5.2 HTTP server

Extend `serveHttp()` TLS options with the server-side model. During server
startup:

- load server cert/key;
- configure ALPN as today;
- load client CA trust if provided;
- set verify mode based on `clientAuth`;
- keep permissive verify callbacks alive for the server lifetime when
  `rejectUnauthorized: false`.

Expose peer identity carefully. Options:

- minimal: expose `incoming.tls` metadata with peer certificate DER and verify
  result;
- richer later: parse certificate subject/SAN/issuer into structured fields.

Start with DER plus verification status because the OpenSSL wrapper already has
those pieces and parsing X.509 names correctly is its own project.

### 5.3 `fetch()` and `HttpClient`

Extend TLS options with client `cert` and `key`, then pass them into
`TlsSocket.connect()` for HTTP/1.1 and HTTP/2 TLS setup.

Connection pooling must include client certificate identity in the pool key.
Two requests to the same origin but with different client certificates cannot
reuse the same authenticated TLS connection.

`HttpClient` should accept default client cert/key options, and per-request
options should override them in the same way `ca` and `rejectUnauthorized`
already do.

### 5.4 QUIC and H3

QUIC internals already have most of the conceptual model:

- server-side client verification through `verifyClient`;
- CA configuration;
- client certificate/private key files;
- OpenSSL and GnuTLS backend branches.

The work here is alignment:

- adapt public HTTP/H3 options to the shared naming model;
- map `clientAuth: 'require'` to existing QUIC server verification behavior;
- decide whether `clientAuth: 'request'` can be supported equally by both
  OpenSSL and GnuTLS backends or should be documented as unsupported for H3
  until backend parity exists;
- ensure QUIC connection pooling/session identity includes client cert options.

## 6. Implementation Effort

Estimated complexity is medium. The cryptographic primitives mostly exist, but
the public API surface, pooling identity, and peer metadata need careful design.

Likely work items:

- Add shared TLS option types or local equivalents that keep names consistent.
- Add OpenSSL helper support for certificate chains if production chain files
  are required.
- Add client cert/key loading to `TlsSocket.connect()` and `TlsSocket.upgrade()`.
- Add server TLS context configuration for client auth modes.
- Extend HTTP server TLS options and request metadata.
- Extend `fetch()` and `HttpClient` TLS options and connection-pool keys.
- Align H3/QUIC public option naming with existing internal `verifyClient`,
  `certificateFile`, and `privateKeyFile` support.
- Update documentation comments and generated docs for any public symbols.

Potential risks:

- Accidentally reusing pooled TLS connections across different client
  certificates.
- Treating unverified peer certificates as authenticated identity when
  `rejectUnauthorized: false`.
- Certificate chain loading differences between leaf-only and chain-file APIs.
- Backend differences between OpenSSL and GnuTLS for QUIC server-side optional
  client authentication.
- Exposing too much parsed certificate structure before X.509 parsing rules are
  well specified.

## 7. Test Plan

Certificate fixtures:

- Generate a local CA, server cert, valid client cert, untrusted client cert,
  and mismatched key fixture.
- Keep fixtures local to tests or generated in a temp directory to avoid
  committing private keys unless the repo already has a fixture convention.

`TlsSocket`:

- Client presents `cert`/`key` when the server requests a certificate.
- Missing client cert succeeds for `clientAuth: 'request'` and fails for
  `clientAuth: 'require'`.
- Invalid client cert fails when verification is strict.
- `rejectUnauthorized: false` records verification failure but allows the
  handshake where that mode is supported.
- Partial `cert` without `key`, or `key` without `cert`, throws before
  handshaking.
- `getPeerCertificate()` returns DER when a peer certificate exists and `null`
  when it does not.

HTTP server:

- `serveHttp({ tls: { clientAuth: 'require', ca } })` rejects requests without
  client certs.
- Valid client certs can complete a request.
- Request metadata exposes peer certificate and verification result.
- HTTP/2 ALPN still works with client auth enabled.

`fetch()` and `HttpClient`:

- `fetch(url, { tls: { cert, key, ca } })` succeeds against an mTLS server.
- The same request without cert/key fails against a required-client-auth
  server.
- Pooling test proves different client cert options do not share a connection.
- Per-request TLS options override `HttpClient` defaults.

QUIC/H3:

- Existing QUIC verify-client behavior remains covered.
- Public H3 options map to existing internal mTLS configuration.
- Backend-specific unsupported optional-auth cases are skipped or reported with
  explicit messages.

Commands once implemented:

- `./target/release/fino --test tests/net/tls.test.mts`
- `./target/release/fino --test tests/net/https.test.mts`
- `./target/release/fino --test tests/net/http-client.test.mts`
- Relevant H3/QUIC tests when public H3 options are changed.

## 8. Assumptions and Defaults

- The first implementation should support handshake-time client authentication,
  not TLS 1.3 post-handshake authentication.
- Public peer certificate metadata should start with DER bytes and verification
  status rather than parsed X.509 fields.
- `clientAuth: 'require'` is the main production server mode; `request` is
  useful for mixed anonymous/authenticated deployments but needs careful docs.
- mTLS identity is only trustworthy when verification succeeds against the
  configured trust roots.
- QUIC/H3 should align with the shared option model, but backend parity should
  be verified before promising every mode on every platform.
