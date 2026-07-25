/**
* internal:net/quic/ngtcp2/crypto — selectable ngtcp2 TLS crypto backend.
*
* QUIC runs the TLS 1.3 handshake inside the transport rather than over a
* TCP-style record layer, so ngtcp2 ships two interchangeable crypto helper
* libraries — one bound to OpenSSL (`libngtcp2_crypto_ossl`) and one to GnuTLS
* (`libngtcp2_crypto_gnutls`). This module hides that choice behind a single
* adapter: it probes both at load time, prefers the OpenSSL backend when it is
* present, and falls back to GnuTLS otherwise. The QUIC endpoint imports only
* this file, so which native package a platform happens to install never leaks
* into the public QUIC API.
*
* The selected backend is fixed for the process. `cryptoBackend` names it (or is
* `null` when neither library is installed), and `cryptoAvailable` is the
* boolean gate the endpoint checks before attempting QUIC at all. Every function
* here branches on `session.backend` / `ctx.backend` internally and dispatches to
* the matching `crypto-ossl` or `crypto-gnutls` helper, so callers work with the
* opaque `QuicTlsContext` and `QuicTlsSession` shapes without knowing which
* library backs them.
*
* Lifecycle is manual and ordered: call `initCrypto()` once, build a context
* with `newServerContext` / `newClientContext`, spawn a per-connection session
* with `newServerSession` / `newClientSession`, hand its native handle to ngtcp2
* via `newNativeHandle`, and free everything in reverse (`freeNativeHandle`,
* `freeSession`, `freeContext`) to release the underlying `SSL`/`SSL_CTX` or
* GnuTLS session/credential objects. Because contexts and sessions own native
* memory and registered FFI callbacks, skipping a free leaks.
*
* Not all features exist on both backends. TLS group selection and per-SNI
* server contexts are OpenSSL-only and throw on GnuTLS; the functions document
* those gaps individually.
*
* ```ts no_run
* import {
*   cryptoAvailable, initCrypto, newServerContext, newServerSession,
*   newNativeHandle, freeNativeHandle, freeSession, freeContext,
* } from 'internal:net/quic/ngtcp2/crypto';
*
* if (!cryptoAvailable) throw new Error('QUIC needs an ngtcp2 crypto backend');
* initCrypto();
*
* const ctx = newServerContext('/etc/tls/cert.pem', '/etc/tls/key.pem', ['h3']);
* const session = newServerSession(ctx, ['h3']);
* const nativeHandle = newNativeHandle(session); // pass to ngtcp2_conn_*
*
* // ... run the connection ...
*
* freeNativeHandle(session.backend, nativeHandle);
* freeSession(session);
* freeContext(ctx);
* ```
*
* ngtcp2 crypto helpers: https://nghttp2.org/ngtcp2/
*
* @internal
*/
import { getErrorString, sslCtxAddCaCertificates, sslCtxFree, sslCtxNewClient, sslCtxNewServer, sslCtxSetAlpnServerProtos, sslCtxSetCipherSuites, sslCtxSetDefaultVerifyPaths, sslCtxLoadVerifyLocations, sslCtxSetGroups, sslCtxSetMaxEarlyData, sslCtxSetKeylogCallback, sslCtxSetPermissiveVerify, sslCtxSetRecvMaxEarlyData, sslCtxSetServernameCallback, sslCtxSetVerify, sslCtxUseCertKey, sslEnableQuicEarlyData, sslFree, sslGetAlpnSelected, sslGetCurrentCipherInfo, sslGetPeerCertificate, sslExportKeyingMaterial, sslGetServername, sslGetVerifyResult, sslExportSession, sslImportSession, sslNew, sslNewSessionTicket, sslSetAlpnProtos, sslSetAppData, sslSetConnectState, sslSetMaxEarlyData, sslSetRecvMaxEarlyData, sslSetVerify, sslSetHostname, sslSetAcceptState, SSL_VERIFY_FAIL_IF_NO_PEER_CERT, SSL_VERIFY_PEER } from '../../../openssl.ts';
import { Pointer } from './bindings.ts';
import { cryptoBackend as osslBackend, cryptoOsslAvailable, newCryptoOsslContext, requireCryptoOssl, sym as osslSym, ptr as osslPtr } from './crypto-ossl.ts';
import { cryptoBackend as gnutlsBackend, configureGnutlsServerMtls, configureGnutlsSession, cryptoGnutlsAvailable, freeGnutlsCredentials, freeGnutlsSession, getGnutlsAlpnSelected, getGnutlsPeerCertificate, getGnutlsServername, getGnutlsVerifyResult, exportGnutlsSession, exportGnutlsKeyingMaterial, getGnutlsCipherInfo, importGnutlsSession, initCryptoGnutls, newGnutlsCredentials, newGnutlsSession, requireCryptoGnutls, sendGnutlsSessionTicket, setGnutlsConnectionRef, setGnutlsSessionTicketCallback, sym as gnutlsSym, ptr as gnutlsPtr, type GnutlsCredentials, type GnutlsSession } from './crypto-gnutls.ts';
/**
* Names which ngtcp2 crypto helper library backs the runtime.
*
* `'ossl'` is the OpenSSL binding and `'gnutls'` the GnuTLS one. It appears on
* every `QuicTlsContext` and `QuicTlsSession` so the dispatching functions in
* this module can pick the right native path, and it is the value
* `freeNativeHandle` needs to know how to release a bare native handle.
*/
export type QuicCryptoBackend = 'ossl' | 'gnutls';
/**
* An opaque, backend-tagged TLS configuration shared by every connection an
* endpoint accepts or dials.
*
* A context wraps one native configuration object — an OpenSSL `SSL_CTX` (stored
* in `handle` as an opaque `object`) or a GnuTLS credential set — plus the
* long-lived state needed to tear it down cleanly. It is produced by
* `newServerContext` / `newClientContext`, consumed by `newServerSession` /
* `newClientSession`, and must be released with `freeContext`. Treat every field
* as internal bookkeeping owned by this module; do not mutate them directly.
*/
export type QuicTlsContext = {
  /** Which backend produced `handle`; selects the native code path everywhere. */
  backend: QuicCryptoBackend;
  /** The native config object: an opaque OpenSSL `SSL_CTX` or `GnutlsCredentials`. */
  handle: object | GnutlsCredentials;
  /** Configured TLS 1.3 cipher suites, or `null` to use the backend default. */
  cipherSuites: readonly string[] | null;
  /** Configured key-exchange groups (OpenSSL only), or `null` for the default. */
  groups: readonly string[] | null;
  /** Closable handle for the registered ALPN-selection FFI callback (OpenSSL server). */
  alpnCallback?: {
    close(): void;
  } | null;
  /** Closable handle for the registered TLS keylog FFI callback (OpenSSL). */
  keylogCallback?: {
    close(): void;
  } | null;
  /** Keylog line sink carried through to GnuTLS sessions, which register it per-session. */
  keylogLine?: ((line: string) => void) | null;
  /** Closable handle for the registered SNI-selection callback set by `setSNIContexts`. */
  sniCallback?: {
    close(): void;
  } | null;
  /** Closable handle for the permissive-verify callback used when `rejectUnauthorized` is false. */
  verifyCallback?: {
    close(): void;
  } | null;
  /** Backend-specific peer-verification mode flag applied to spawned sessions. */
  verifyMode?: number;
  /** Resolved client-certificate policy: `'none'`, `'request'`, or `'require'`. */
  clientAuth?: 'none' | 'request' | 'require';
};
/**
* An opaque, backend-tagged TLS handshake state for a single QUIC connection.
*
* Each session wraps one native handshake object — an OpenSSL `SSL` (in `handle`
* as an opaque `object`) or a `GnutlsSession`. It is created per connection by
* `newServerSession` / `newClientSession`, queried with the accessor functions
* (`getHandshakeInfo`, `getPeerCertificate`, `getAlpnSelected`, …), and released
* with `freeSession`. Before it can drive a connection, hand its native handle
* to ngtcp2 via `newNativeHandle`.
*/
export type QuicTlsSession = {
  /** Which backend produced `handle`; selects the native code path everywhere. */
  backend: QuicCryptoBackend;
  /** The native handshake object: an opaque OpenSSL `SSL` or `GnutlsSession`. */
  handle: object | GnutlsSession;
};
/**
* Outcome of resuming a TLS session from serialized state via `importSession`.
*
* `resumed` reports whether the backend accepted the ticket and will attempt an
* abbreviated (resumption) handshake. `maxEarlyData` is the number of 0-RTT
* early-data bytes the resumed session permits; GnuTLS reports no explicit cap
* and returns `Number.MAX_SAFE_INTEGER`.
*/
export type QuicImportedSession = {
  /** True when the serialized ticket was accepted and resumption will be attempted. */
  resumed: boolean;
  /** Bytes of 0-RTT early data the resumed session allows; effectively unbounded on GnuTLS. */
  maxEarlyData: number;
};
/**
* Snapshot of negotiated TLS parameters read after a QUIC handshake completes.
*
* Returned by `getHandshakeInfo`. Every field degrades gracefully: string fields
* are empty or `null` and `validationErrorCode` is `0` when a session is absent
* or a value could not be determined, so callers can render the info without
* null-guarding each access.
*/
export type QuicTlsHandshakeInfo = {
  /** Server name the peer requested via SNI, or the caller's fallback when unset. */
  servername: string | null;
  /** ALPN protocol selected for the connection (e.g. `'h3'`), or `''` if none. */
  protocol: string;
  /** Negotiated cipher suite name, or `null` when unavailable. */
  cipher: string | null;
  /** Negotiated TLS protocol version string, or `null` when unavailable. */
  cipherVersion: string | null;
  /** Human-readable reason a peer certificate failed validation, or `null` if it passed. */
  validationErrorReason: string | null;
  /** Backend verification result code; `0` means the certificate validated successfully. */
  validationErrorCode: number;
};
/**
* Sources of trusted CA certificates for peer verification.
*
* Any combination may be supplied. `file` and `directory` point at PEM bundles
* on disk (OpenSSL's `X509_STORE` load paths); `pem` supplies in-memory
* certificate material as a PEM string, raw bytes, or an array mixing both.
* When none are given and verification is enabled, the OpenSSL backend falls
* back to the system default verify paths.
*/
export type QuicCaOptions = {
  /** Path to a PEM file of one or more CA certificates. */
  file?: string;
  /** Path to a directory of hashed CA certificates. */
  directory?: string;
  /** In-memory CA material: a PEM string, DER/PEM bytes, or an array of either. */
  pem?: string | Uint8Array | Array<string | Uint8Array>;
};
/**
* Optional TLS knobs shared by `newServerContext` and `newClientContext`.
*
* Not every field applies to both roles: `verifyClient` / `clientAuth` shape a
* server's demand for client certificates, while `certificateFile` /
* `privateKeyFile` supply a client's certificate for mutual TLS (a server takes
* its cert/key as required positional arguments instead). `groups` is honored
* only by the OpenSSL backend and throws on GnuTLS.
*/
export type QuicTlsContextOptions = {
  /** Server shorthand: `true` maps to `clientAuth: 'require'` when `clientAuth` is unset. */
  verifyClient?: boolean;
  /** Client-certificate policy for a server context: `'none'`, `'request'`, or `'require'`. */
  clientAuth?: 'none' | 'request' | 'require';
  /** When `false`, verification runs but failures are tolerated (permissive verify). */
  rejectUnauthorized?: boolean;
  /** Trusted CA sources used to verify the peer certificate. */
  ca?: QuicCaOptions;
  /** Client mutual-TLS certificate path (paired with `privateKeyFile`). */
  certificateFile?: string;
  /** Client mutual-TLS private key path (paired with `certificateFile`). */
  privateKeyFile?: string;
  /** Key-exchange groups to offer (OpenSSL only); throws on the GnuTLS backend. */
  groups?: readonly string[] | null;
};
/**
* The crypto backend selected at load time, or `null` when neither library is
* installed.
*
* OpenSSL wins when available; GnuTLS is the fallback. Read this to branch on
* capabilities that differ between backends (for example, TLS groups and per-SNI
* contexts exist only under `'ossl'`).
*/
export const cryptoBackend: QuicCryptoBackend | null = cryptoOsslAvailable ? osslBackend : gnutlsBackend;
/**
* Whether any ngtcp2 crypto backend is present, i.e. whether QUIC can run at
* all.
*
* The endpoint checks this before doing anything QUIC-related; when it is
* `false`, `requireCrypto` and `initCrypto` throw.
*
* ```ts no_run
* import { cryptoAvailable } from 'internal:net/quic/ngtcp2/crypto';
* if (!cryptoAvailable) throw new Error('QUIC unavailable: no ngtcp2 crypto backend');
* ```
*/
export const cryptoAvailable = cryptoOsslAvailable || cryptoGnutlsAvailable;
/**
* FFI symbol table of the selected backend's ngtcp2 crypto library.
*
* Exposed so the endpoint can call backend `ngtcp2_crypto_*` entry points
* directly. It is `null` when no backend is available; call `requireCrypto`
* first to guarantee it is non-null.
*/
export const sym = cryptoOsslAvailable ? osslSym : gnutlsSym;
/**
* The FFI pointer helper (`Pointer`-style constructor) matching the selected
* backend.
*
* Used to build native argument pointers for the `sym` calls above; it always
* pairs with the same backend `sym` refers to.
*/
export const ptr = cryptoOsslAvailable ? osslPtr : gnutlsPtr;
/**
* Asserts that a crypto backend is present, loading its symbols on demand.
*
* Delegates to the selected backend's own requirement check so its native
* library is resolved and `sym`/`ptr` become usable. Call this before touching
* `sym`, or rely on `initCrypto` which calls it for you.
*
* Throws if neither `libngtcp2_crypto_ossl` nor `libngtcp2_crypto_gnutls` is
* installed.
*
* ```ts no_run
* import { requireCrypto } from 'internal:net/quic/ngtcp2/crypto';
* requireCrypto(); // throws with an install hint when no backend is found
* ```
*/
export function requireCrypto(): void {
  if (cryptoOsslAvailable) requireCryptoOssl();
  else if (cryptoGnutlsAvailable) requireCryptoGnutls();
  else throw new Error('no ngtcp2 crypto backend found. Install libngtcp2_crypto_ossl or libngtcp2_crypto_gnutls');
}
/**
* Initializes the selected crypto backend; call once before creating contexts.
*
* Runs `requireCrypto` and then the backend's one-time global setup —
* `ngtcp2_crypto_ossl_init()` for OpenSSL or the GnuTLS initializer. Safe and
* cheap to gate behind your own once-flag; the endpoint calls it lazily the
* first time a QUIC endpoint is created.
*
* Throws if no crypto backend is installed.
*
* ```ts no_run
* import { initCrypto } from 'internal:net/quic/ngtcp2/crypto';
* initCrypto(); // must precede newServerContext / newClientContext
* ```
*/
export function initCrypto(): void {
  requireCrypto();
  if (cryptoBackend === 'ossl') sym!.ngtcp2_crypto_ossl_init();
  else initCryptoGnutls();
}
/**
* Applies CA trust settings to an OpenSSL `SSL_CTX` before verification.
*
* In-memory `pem` material is always added; explicit `file`/`directory` load
* paths override the defaults, and when neither is given but `verifyPeer` is
* true the system default verify paths are used so verification has a trust
* anchor.
*/
function configureOpenSslCa(ctx: object, ca: QuicCaOptions | undefined, verifyPeer: boolean): void {
  if (ca?.pem !== undefined) sslCtxAddCaCertificates(ctx, ca.pem);
  if (ca?.file !== undefined || ca?.directory !== undefined) {
    sslCtxLoadVerifyLocations(ctx, ca.file ?? null, ca.directory ?? null);
  } else if (verifyPeer) {
    sslCtxSetDefaultVerifyPaths(ctx);
  }
}
/**
* Builds a server-side TLS context from a certificate and private key.
*
* The context loads `certFile`/`keyFile`, advertises `alpnProtocols` during
* negotiation, and encodes the client-authentication policy: `tlsOptions.clientAuth`
* wins if set, otherwise `verifyClient: true` maps to `'require'` and the default
* is `'none'`. When a client certificate is demanded, `tlsOptions.ca` supplies
* the trust anchors and `rejectUnauthorized: false` switches to permissive
* verification (failures are reported but tolerated). `cipherSuites` and, on
* OpenSSL, `tlsOptions.groups` override the backend defaults. Pass `onKeylogLine`
* to capture NSS-format keylog lines for debugging.
*
* The returned context owns native memory and any registered FFI callbacks;
* release it with `freeContext`. On the OpenSSL backend the partially built
* `SSL_CTX` is freed automatically if configuration fails midway.
*
* Throws if `tlsOptions.groups` is supplied while the GnuTLS backend is active,
* and propagates any certificate/key load error from the backend.
*
* ```ts no_run
* import { newServerContext } from 'internal:net/quic/ngtcp2/crypto';
*
* const ctx = newServerContext(
*   '/etc/tls/cert.pem',
*   '/etc/tls/key.pem',
*   ['h3'],
*   null,
*   undefined,
*   { clientAuth: 'require', ca: { file: '/etc/tls/client-ca.pem' } },
* );
* ```
*/
export function newServerContext(certFile: string, keyFile: string, alpnProtocols: string[], cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void, tlsOptions: QuicTlsContextOptions = {}): QuicTlsContext {
  const clientAuth = tlsOptions.clientAuth ?? (tlsOptions.verifyClient === true ? 'require' : 'none');
  if (cryptoBackend === 'ossl') {
    const ctx = sslCtxNewServer();
    try {
      if (cipherSuites !== null) sslCtxSetCipherSuites(ctx, cipherSuites);
      if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) sslCtxSetGroups(ctx, tlsOptions.groups);
      sslCtxUseCertKey(ctx, certFile, keyFile);
      const verifyMode = clientAuth === 'none' ? 0 : SSL_VERIFY_PEER | (clientAuth === 'require' ? SSL_VERIFY_FAIL_IF_NO_PEER_CERT : 0);
      const verifyCallback = verifyMode !== 0 && tlsOptions.rejectUnauthorized === false ? sslCtxSetPermissiveVerify(ctx, verifyMode) : null;
      if (verifyMode !== 0 && verifyCallback === null) sslCtxSetVerify(ctx, verifyMode);
      configureOpenSslCa(ctx, tlsOptions.ca, verifyMode !== 0);
      const alpnCallback = sslCtxSetAlpnServerProtos(ctx, alpnProtocols);
      const keylogCallback = onKeylogLine === undefined ? null : sslCtxSetKeylogCallback(ctx, onKeylogLine);
      return {
        backend: 'ossl',
        handle: ctx,
        cipherSuites,
        groups: tlsOptions.groups ?? null,
        alpnCallback,
        keylogCallback,
        keylogLine: null,
        sniCallback: null,
        verifyCallback,
        verifyMode,
        clientAuth
      };
    } catch (error) {
      sslCtxFree(ctx);
      throw error;
    }
  }
  if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) throw new Error('QUIC TLS groups are only supported by the OpenSSL crypto backend');
  const cred = newGnutlsCredentials('server', certFile, keyFile);
  configureGnutlsServerMtls(cred, clientAuth, tlsOptions.ca, tlsOptions.rejectUnauthorized !== false);
  return {
    backend: 'gnutls',
    handle: cred,
    cipherSuites,
    groups: null,
    alpnCallback: null,
    keylogCallback: null,
    keylogLine: onKeylogLine ?? null,
    sniCallback: null,
    verifyCallback: null,
    verifyMode: clientAuth === 'none' ? 0 : 1,
    clientAuth
  };
}
/**
* Builds a client-side TLS context for dialing QUIC servers.
*
* `verifyPeer` decides whether the server certificate is validated against the
* configured trust anchors (`tlsOptions.ca`, falling back to the system default
* verify paths). Supply `tlsOptions.certificateFile` and
* `tlsOptions.privateKeyFile` together to present a client certificate for
* mutual TLS. `cipherSuites` and, on OpenSSL, `tlsOptions.groups` override the
* defaults, and `onKeylogLine` captures keylog output.
*
* The context owns native memory; release it with `freeContext`. A single
* client context can back many `newClientSession` connections.
*
* Throws if `tlsOptions.groups` is supplied while the GnuTLS backend is active.
*
* ```ts no_run
* import { newClientContext } from 'internal:net/quic/ngtcp2/crypto';
*
* const ctx = newClientContext(true, null, undefined, {
*   ca: { file: '/etc/tls/ca-bundle.pem' },
* });
* ```
*/
export function newClientContext(verifyPeer: boolean, cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void, tlsOptions: QuicTlsContextOptions = {}): QuicTlsContext {
  if (cryptoBackend === 'ossl') {
    const ctx = sslCtxNewClient();
    if (cipherSuites !== null) sslCtxSetCipherSuites(ctx, cipherSuites);
    if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) sslCtxSetGroups(ctx, tlsOptions.groups);
    if (tlsOptions.certificateFile !== undefined && tlsOptions.privateKeyFile !== undefined) {
      sslCtxUseCertKey(ctx, tlsOptions.certificateFile, tlsOptions.privateKeyFile);
    }
    sslCtxSetVerify(ctx, verifyPeer ? SSL_VERIFY_PEER : 0);
    configureOpenSslCa(ctx, tlsOptions.ca, verifyPeer);
    const keylogCallback = onKeylogLine === undefined ? null : sslCtxSetKeylogCallback(ctx, onKeylogLine);
    return {
      backend: 'ossl',
      handle: ctx,
      cipherSuites,
      groups: tlsOptions.groups ?? null,
      alpnCallback: null,
      keylogCallback,
      keylogLine: null,
      sniCallback: null,
      verifyCallback: null,
      verifyMode: verifyPeer ? SSL_VERIFY_PEER : 0
    };
  }
  if (tlsOptions.groups !== undefined && tlsOptions.groups !== null) throw new Error('QUIC TLS groups are only supported by the OpenSSL crypto backend');
  return {
    backend: 'gnutls',
    handle: newGnutlsCredentials('client', tlsOptions.certificateFile, tlsOptions.privateKeyFile, verifyPeer, tlsOptions.ca),
    cipherSuites,
    groups: null,
    alpnCallback: null,
    keylogCallback: null,
    keylogLine: onKeylogLine ?? null,
    sniCallback: null,
    verifyCallback: null,
    verifyMode: verifyPeer ? 1 : 0
  };
}
/**
* Registers per-hostname server contexts for SNI-based virtual hosting.
*
* Installs a servername callback on `ctx` so incoming connections whose SNI
* matches a key in `entries` hand off to that entry's `SSL_CTX`, while unmatched
* names fall through to `ctx` itself. Replacing an existing SNI map closes the
* previously registered callback first, so it is safe to call repeatedly.
*
* This is OpenSSL-only. It throws if `ctx` or any entry uses the GnuTLS backend.
* The entry contexts remain owned by the caller and must still be freed with
* `freeContext`.
*
* ```ts no_run
* import { newServerContext, setSNIContexts } from 'internal:net/quic/ngtcp2/crypto';
*
* const base = newServerContext('/etc/tls/default.pem', '/etc/tls/default.key', ['h3']);
* const api = newServerContext('/etc/tls/api.pem', '/etc/tls/api.key', ['h3']);
* setSNIContexts(base, new Map([['api.example.com', api]]));
* ```
*/
export function setSNIContexts(ctx: QuicTlsContext, entries: ReadonlyMap<string, QuicTlsContext>): void {
  if (ctx.backend !== 'ossl') throw new Error('QUIC per-SNI TLS contexts are only supported by the OpenSSL crypto backend');
  const handles = new Map<string, object>();
  for (const [name, entry] of entries) {
    if (entry.backend !== 'ossl') throw new Error('QUIC per-SNI TLS contexts are only supported by the OpenSSL crypto backend');
    handles.set(name, entry.handle as object);
  }
  ctx.sniCallback?.close();
  ctx.sniCallback = sslCtxSetServernameCallback(ctx.handle as object, handles);
}
/**
* Releases a TLS context and every FFI callback registered against it.
*
* Closes the ALPN, keylog, SNI, and permissive-verify callbacks (each holds a
* native trampoline), then frees the underlying `SSL_CTX` or GnuTLS credentials.
* Free sessions spawned from the context before freeing the context itself.
* Idempotency is not guaranteed — call exactly once per context.
*
* ```ts no_run
* import { newClientContext, freeContext } from 'internal:net/quic/ngtcp2/crypto';
*
* const ctx = newClientContext(true);
* try {
*   // ... dial connections from this context ...
* } finally {
*   freeContext(ctx);
* }
* ```
*/
export function freeContext(ctx: QuicTlsContext): void {
  if (ctx.alpnCallback) ctx.alpnCallback.close();
  if (ctx.keylogCallback) ctx.keylogCallback.close();
  if (ctx.sniCallback) ctx.sniCallback.close();
  if (ctx.verifyCallback) ctx.verifyCallback.close();
  if (ctx.backend === 'ossl') sslCtxFree(ctx.handle as object);
  else freeGnutlsCredentials(ctx.handle as GnutlsCredentials);
}
/**
* Returns the peer's leaf certificate as DER bytes, or `null` when there is
* none.
*
* Accepts a `null` session (before or without a handshake) and returns `null`
* rather than throwing. `null` is also returned when the peer presented no
* certificate — common for a server talking to a client that was not asked to
* authenticate.
*
* ```ts no_run
* import { getPeerCertificate } from 'internal:net/quic/ngtcp2/crypto';
*
* const der = getPeerCertificate(session);
* if (der) console.log('peer cert bytes:', der.byteLength);
* ```
*/
export function getPeerCertificate(session: QuicTlsSession | null): Uint8Array | null {
  if (session === null) return null;
  if (session.backend === 'ossl') return sslGetPeerCertificate(session.handle as object);
  return getGnutlsPeerCertificate(session.handle as GnutlsSession);
}
/**
* Derives exported keying material (RFC 5705 / RFC 8446) from a completed
* handshake.
*
* Runs the TLS exporter with the given `label` and `context` bytes to produce
* `length` bytes of key material bound to the session — useful for channel
* binding or application-layer keying. Requires a completed handshake.
*
* Throws if `session` is `null`, and propagates a backend error if the exporter
* fails (for example, called before the handshake finishes).
*
* ```ts no_run
* import { exportKeyingMaterial } from 'internal:net/quic/ngtcp2/crypto';
*
* const context = new TextEncoder().encode('example-binding');
* const key = exportKeyingMaterial(session, 'EXPORTER-my-app', context, 32);
* ```
*/
export function exportKeyingMaterial(session: QuicTlsSession | null, label: string, context: Uint8Array, length: number): ArrayBuffer {
  if (session === null) throw new Error('QUIC TLS session is not available');
  if (session.backend === 'ossl') {
    return sslExportKeyingMaterial(session.handle as object, label, context, length);
  }
  return exportGnutlsKeyingMaterial(session.handle as GnutlsSession, label, context, length);
}
/**
* Spawns a per-connection server handshake session from a server context.
*
* Creates the native handshake object, applies the context's verification mode,
* runs the backend's ngtcp2 server-session configuration, and puts it into TLS
* accept state. Pass `earlyDataMax > 0` to enable 0-RTT early data up to that
* byte budget. Each accepted connection needs its own session; free it with
* `freeSession`.
*
* Throws if the backend's `configure_server_session` step fails (the partially
* built `SSL` is freed first, and the error message includes the backend error
* string).
*
* ```ts no_run
* import { newServerContext, newServerSession } from 'internal:net/quic/ngtcp2/crypto';
*
* const ctx = newServerContext('/etc/tls/cert.pem', '/etc/tls/key.pem', ['h3']);
* const session = newServerSession(ctx, ['h3'], 16 * 1024); // allow 0-RTT
* ```
*/
export function newServerSession(ctx: QuicTlsContext, alpnProtocols: string[], earlyDataMax = 0): QuicTlsSession {
  if (ctx.backend === 'ossl') {
    if (earlyDataMax > 0) {
      sslCtxSetMaxEarlyData(ctx.handle as object, earlyDataMax);
      sslCtxSetRecvMaxEarlyData(ctx.handle as object, earlyDataMax);
    }
    const ssl = sslNew(ctx.handle as object);
    if ((ctx.verifyMode ?? 0) !== 0) sslSetVerify(ssl, ctx.verifyMode!);
    const rc = sym!.ngtcp2_crypto_ossl_configure_server_session(ssl) as number;
    if (rc !== 0) {
      sslFree(ssl);
      throw new Error('ngtcp2_crypto_ossl_configure_server_session failed: ' + getErrorString());
    }
    if ((ctx.verifyMode ?? 0) !== 0) sslSetVerify(ssl, ctx.verifyMode!);
    if (earlyDataMax > 0) {
      sslSetMaxEarlyData(ssl, earlyDataMax);
      sslSetRecvMaxEarlyData(ssl, earlyDataMax);
      sslEnableQuicEarlyData(ssl, true);
    }
    sslSetAcceptState(ssl);
    return {
      backend: 'ossl',
      handle: ssl
    };
  }
  return {
    backend: 'gnutls',
    handle: newGnutlsSession('server', ctx.handle as GnutlsCredentials, alpnProtocols, undefined, false, earlyDataMax, ctx.cipherSuites, ctx.keylogLine ?? undefined)
  };
}
/**
* Spawns a per-connection client handshake session from a client context.
*
* Creates the native handshake object, sets the SNI `serverName` and the ALPN
* list, runs the backend's ngtcp2 client-session configuration, and puts it into
* TLS connect state. `verifyPeer` mirrors the context's verification intent for
* the GnuTLS backend; `earlyDataMax > 0` opts the connection into sending 0-RTT
* early data. Free the session with `freeSession`.
*
* Throws if the backend's `configure_client_session` step fails; the partially
* built native session is freed before the error propagates.
*
* ```ts no_run
* import { newClientContext, newClientSession } from 'internal:net/quic/ngtcp2/crypto';
*
* const ctx = newClientContext(true);
* const session = newClientSession(ctx, ['h3'], 'example.com', true);
* ```
*/
export function newClientSession(ctx: QuicTlsContext, alpnProtocols: string[], serverName: string, verifyPeer: boolean, earlyDataMax = 0): QuicTlsSession {
  if (ctx.backend === 'ossl') {
    const ssl = sslNew(ctx.handle as object);
    try {
      sslSetHostname(ssl, serverName);
      sslSetAlpnProtos(ssl, alpnProtocols);
      if (earlyDataMax > 0) sslSetMaxEarlyData(ssl, earlyDataMax);
      const rc = sym!.ngtcp2_crypto_ossl_configure_client_session(ssl) as number;
      if (rc !== 0) throw new Error('ngtcp2_crypto_ossl_configure_client_session failed: ' + getErrorString());
      sslSetConnectState(ssl);
      return {
        backend: 'ossl',
        handle: ssl
      };
    } catch (error) {
      sslFree(ssl);
      throw error;
    }
  }
  const session = newGnutlsSession('client', ctx.handle as GnutlsCredentials, alpnProtocols, serverName, verifyPeer, earlyDataMax, ctx.cipherSuites, ctx.keylogLine ?? undefined);
  try {
    configureGnutlsSession('client', session);
    return {
      backend: 'gnutls',
      handle: session
    };
  } catch (error) {
    freeGnutlsSession(session);
    throw error;
  }
}
/**
* Serializes a resumable TLS session (ticket state) to bytes for later reuse.
*
* Returns the opaque blob to persist and later feed to `importSession` on a
* fresh session to attempt 0-RTT/resumption, or `null` when the backend has no
* resumable state to export yet (for example, no session ticket has arrived).
* The bytes are backend-specific and not portable across backends.
*
* ```ts no_run
* import { exportSession } from 'internal:net/quic/ngtcp2/crypto';
*
* const ticket = exportSession(session);
* if (ticket) await saveTicketForHost('example.com', ticket);
* ```
*/
export function exportSession(session: QuicTlsSession): Uint8Array | null {
  if (session.backend === 'ossl') return sslExportSession(session.handle as object);
  return exportGnutlsSession(session.handle as GnutlsSession);
}
/**
* Loads previously exported session state into a fresh client session to enable
* resumption.
*
* Feeds `data` (from a prior `exportSession`) to the new session before its
* handshake. On OpenSSL, when the ticket is accepted and permits early data, QUIC
* 0-RTT is enabled automatically up to the ticket's limit; `earlyDataMax` caps
* the amount the caller is willing to send. The returned `QuicImportedSession`
* reports whether resumption was accepted and how much early data is allowed
* (GnuTLS reports no explicit cap).
*
* ```ts no_run
* import { newClientSession, importSession } from 'internal:net/quic/ngtcp2/crypto';
*
* const session = newClientSession(ctx, ['h3'], 'example.com', true, 16 * 1024);
* const result = importSession(session, savedTicket, 16 * 1024);
* if (result.resumed) console.log('resuming, early data:', result.maxEarlyData);
* ```
*/
export function importSession(session: QuicTlsSession, data: Uint8Array, earlyDataMax = 0): QuicImportedSession {
  if (session.backend === 'ossl') {
    const imported = sslImportSession(session.handle as object, data, earlyDataMax);
    if (imported.imported && imported.maxEarlyData > 0) sslEnableQuicEarlyData(session.handle as object, true);
    return {
      resumed: imported.imported,
      maxEarlyData: imported.maxEarlyData
    };
  }
  return {
    resumed: importGnutlsSession(session.handle as GnutlsSession, data),
    maxEarlyData: Number.MAX_SAFE_INTEGER
  };
}
/**
* Frees a connection's TLS session and its native handshake object.
*
* Call once per session when the connection closes. Free the native handle with
* `freeNativeHandle` before this if you created one with `newNativeHandle`, then
* free the parent context with `freeContext` after all its sessions are gone.
*
* ```ts no_run
* import { freeSession } from 'internal:net/quic/ngtcp2/crypto';
* freeSession(session);
* ```
*/
export function freeSession(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslFree(session.handle as object);
  else freeGnutlsSession(session.handle as GnutlsSession);
}
/**
* Returns the ALPN protocol negotiated for the connection, or `''` when none.
*
* Accepts a `null` session and returns `''`, so it is safe to call before a
* handshake completes or when no ALPN was agreed.
*
* ```ts no_run
* import { getAlpnSelected } from 'internal:net/quic/ngtcp2/crypto';
* if (getAlpnSelected(session) !== 'h3') throw new Error('expected HTTP/3');
* ```
*/
export function getAlpnSelected(session: QuicTlsSession | null): string {
  if (session === null) return '';
  return session.backend === 'ossl' ? sslGetAlpnSelected(session.handle as object) ?? '' : getGnutlsAlpnSelected(session.handle as GnutlsSession);
}
/**
* Collects negotiated TLS parameters into a single snapshot after the
* handshake.
*
* Reads the selected ALPN protocol, SNI servername, cipher suite and version,
* and the peer-certificate validation result in one pass. When `session` is
* `null` or the servername is unavailable, `fallbackServername` fills the
* `servername` field. Every other field degrades to an empty string, `null`, or
* `0` rather than throwing, so the result is always safe to read directly.
*
* ```ts no_run
* import { getHandshakeInfo } from 'internal:net/quic/ngtcp2/crypto';
*
* const info = getHandshakeInfo(session, 'example.com');
* if (info.validationErrorCode !== 0) {
*   console.warn('cert rejected:', info.validationErrorReason);
* }
* console.log(`${info.protocol} over ${info.cipherVersion} (${info.cipher})`);
* ```
*/
export function getHandshakeInfo(session: QuicTlsSession | null, fallbackServername: string | null = null): QuicTlsHandshakeInfo {
  if (session === null) {
    return {
      servername: fallbackServername,
      protocol: '',
      cipher: null,
      cipherVersion: null,
      validationErrorReason: null,
      validationErrorCode: 0
    };
  }
  const protocol = getAlpnSelected(session);
  if (session.backend === 'ossl') {
    const cipher = sslGetCurrentCipherInfo(session.handle as object);
    const validation = sslGetVerifyResult(session.handle as object);
    return {
      servername: sslGetServername(session.handle as object) ?? fallbackServername,
      protocol,
      cipher: cipher.cipher,
      cipherVersion: cipher.cipherVersion,
      validationErrorReason: validation.reason,
      validationErrorCode: validation.code
    };
  }
  const gSession = session.handle as GnutlsSession;
  const cipher = getGnutlsCipherInfo(gSession);
  const verification = getGnutlsVerifyResult(gSession);
  return {
    servername: getGnutlsServername(gSession) ?? fallbackServername,
    protocol,
    cipher: cipher.cipher,
    cipherVersion: cipher.cipherVersion,
    validationErrorReason: verification.reason,
    validationErrorCode: verification.code
  };
}
/**
* Issues a new TLS session ticket to the client for future resumption.
*
* Called on the server side after the handshake to let the peer resume later
* (and potentially use 0-RTT). Pair it with `setSessionTicketCallback` on the
* GnuTLS backend to observe the emitted ticket bytes.
*
* ```ts no_run
* import { sendSessionTicket } from 'internal:net/quic/ngtcp2/crypto';
* sendSessionTicket(session); // server-side, post-handshake
* ```
*/
export function sendSessionTicket(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslNewSessionTicket(session.handle as object);
  else sendGnutlsSessionTicket(session.handle as GnutlsSession);
}
/**
* Registers a callback invoked with each session ticket the backend emits.
*
* This is a GnuTLS-only hook: OpenSSL surfaces ticket state through
* `exportSession` instead, so on the OpenSSL backend this is a no-op. Pass
* `null` to clear a previously registered callback. Use it to persist tickets
* for later resumption.
*
* ```ts no_run
* import { setSessionTicketCallback } from 'internal:net/quic/ngtcp2/crypto';
*
* setSessionTicketCallback(session, (ticket) => saveTicket('example.com', ticket));
* ```
*/
export function setSessionTicketCallback(session: QuicTlsSession, callback: ((ticket: Uint8Array) => void) | null): void {
  if (session.backend === 'gnutls') setGnutlsSessionTicketCallback(session.handle as GnutlsSession, callback);
}
/**
* Associates ngtcp2's connection reference with the TLS session.
*
* Stores `connRef` where the backend's crypto callbacks can reach it (OpenSSL's
* app-data slot, or the GnuTLS connection-ref hook), so TLS events can be mapped
* back to the owning QUIC connection during the handshake. Clear it with
* `clearConnectionRef` before the connection object goes away.
*
* ```ts no_run
* import { setConnectionRef } from 'internal:net/quic/ngtcp2/crypto';
* setConnectionRef(session, connRef); // connRef is ngtcp2's conn ref buffer
* ```
*/
export function setConnectionRef(session: QuicTlsSession, connRef: ArrayBuffer): void {
  if (session.backend === 'ossl') sslSetAppData(session.handle as object, Pointer.of(connRef));
  else setGnutlsConnectionRef(session.handle as GnutlsSession, connRef);
}
/**
* Detaches ngtcp2's connection reference from the TLS session.
*
* The inverse of `setConnectionRef`: nulls the stored reference so a lingering
* callback cannot dereference a freed connection. Call it during connection
* teardown, before `freeSession`.
*
* ```ts no_run
* import { clearConnectionRef } from 'internal:net/quic/ngtcp2/crypto';
* clearConnectionRef(session); // during connection teardown
* ```
*/
export function clearConnectionRef(session: QuicTlsSession): void {
  if (session.backend === 'ossl') sslSetAppData(session.handle as object, null);
  else setGnutlsConnectionRef(session.handle as GnutlsSession, null);
}
/**
* Produces the native crypto handle ngtcp2 needs to drive the handshake.
*
* On OpenSSL this allocates an `ngtcp2_crypto_ossl_ctx` wrapping the session's
* `SSL` (which must later be freed with `freeNativeHandle`); on GnuTLS it returns
* the session's existing native handle, which is owned by the session and needs
* no separate free. Pass the result into the ngtcp2 connection's crypto setup.
*
* ```ts no_run
* import { newNativeHandle, freeNativeHandle } from 'internal:net/quic/ngtcp2/crypto';
*
* const handle = newNativeHandle(session); // hand to ngtcp2_conn_*
* // later, only meaningful on the OpenSSL backend:
* freeNativeHandle(session.backend, handle);
* ```
*/
export function newNativeHandle(session: QuicTlsSession): ArrayBuffer {
  if (session.backend === 'ossl') return newCryptoOsslContext(session.handle as object);
  return (session.handle as GnutlsSession).handle;
}
/**
* Applies role-specific handshake configuration once a session is bound to a
* connection.
*
* This is a GnuTLS-only step (re-running the client/server session setup after
* the connection reference is in place); on OpenSSL it is a no-op because that
* configuration happens at session creation. `role` selects the client or server
* setup path.
*
* ```ts no_run
* import { configureSessionForConnection } from 'internal:net/quic/ngtcp2/crypto';
* configureSessionForConnection('server', session);
* ```
*/
export function configureSessionForConnection(role: 'client' | 'server', session: QuicTlsSession): void {
  if (session.backend === 'gnutls') configureGnutlsSession(role, session.handle as GnutlsSession);
}
/**
* Frees a native handle created by `newNativeHandle`.
*
* Only meaningful on the OpenSSL backend, which allocated an
* `ngtcp2_crypto_ossl_ctx`; it deletes that context. On GnuTLS the handle is
* owned by the session, so this is a no-op — which is why the `backend` tag is
* passed explicitly rather than read from a session object. Call it before
* `freeSession`.
*
* ```ts no_run
* import { freeNativeHandle } from 'internal:net/quic/ngtcp2/crypto';
* freeNativeHandle(session.backend, nativeHandle);
* ```
*/
export function freeNativeHandle(backend: QuicCryptoBackend, nativeHandle: ArrayBuffer): void {
  if (backend === 'ossl') sym!.ngtcp2_crypto_ossl_ctx_del(nativeHandle);
}
