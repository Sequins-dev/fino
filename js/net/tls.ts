/**
 * fino:tls — TLS socket layer.
 *
 * TLS 1.3 specification: https://www.rfc-editor.org/rfc/rfc8446
 *
 * `TlsSocket` extends `Socket` from `fino:socket`. TCP connection setup is
 * shared via `connectTcp()` — no duplication. TlsSocket overrides `split()`
 * to return `TlsReader`/`TlsWriter` (which handle SSL_read/SSL_write), and
 * overrides `close()` to perform SSL teardown before the fd close.
 *
 * `TlsReader` and `TlsWriter` extend the base `Reader`/`Writer` from
 * `fino:stream`, implementing the template methods with SSL-specific I/O.
 * All loop machinery (readability waiting, retry, backpressure, async
 * iteration, pipe) is inherited — no duplication.
 *
 *
 * ## TLS options
 *
 *   {
 *     hostname: 'example.com',    // SNI + hostname verification
 *     ca: '/path/to/ca.pem',      // custom CA file (optional)
 *     cert: '/path/client.pem',   // client certificate (optional)
 *     key: '/path/client.key',    // client private key (optional)
 *     rejectUnauthorized: true,   // verify peer cert (default: true)
 *     alpn: ['h2', 'http/1.1'],   // client protocol preference (optional)
 *   }
 *
 * ## Release policy
 *
 * This module is release-supported in an OpenSSL-enabled build. Release CI
 * must include a lane where `tlsAvailable` is true; builds without libssl may
 * still run, but TLS tests and TLS-dependent HTTP features are expected to be
 * skipped or gated explicitly.
 *
 * Protocol selection is exposed through ALPN only. Callers may offer client
 * protocol preferences with `alpn`, and servers that use this socket layer
 * publish their supported protocols through their own listener configuration.
 * Cipher-suite, minimum/maximum protocol version, and session-reuse controls
 * intentionally use OpenSSL defaults in this API. If a deployment needs a
 * stricter TLS policy, configure the OpenSSL installation or use a higher-level
 * server API that exposes a narrower audited knob.
 *
 * There is no public TLS session cache or session-ticket reuse API here.
 * Mutual TLS uses handshake-time client certificates only; post-handshake
 * client authentication is intentionally outside this module.
 *
 *
 * ## Close coordination
 *
 * When `split()` is used, both TlsReader and TlsWriter share the SSL* pointer.
 * When both halves close, SSL is shut down and freed, then the fd is closed via
 * `super.close()`. When `close()` is called directly (without splitting), SSL
 * teardown happens before calling `super.close()`.
 *
 * @example
 * ```ts no_run
 * import { TlsSocket } from 'fino:tls';
 *
 * const socket = await TlsSocket.connect(
 *   { family: 'ipv4', ip: '93.184.216.34', port: 443 },
 *   { hostname: 'example.com', alpn: ['h2', 'http/1.1'] },
 * );
 * const [reader, writer] = socket.split();
 * ```
 */
import * as openssl from '../internal/openssl.ts';
import * as loop from '../internal/runtime/loop.ts';
import { BufferedBytesReader, BufferedBytesWriter, type ReadResult } from '../internal/stream.ts';
import { Socket, connectTcp, close as closeFd, setNonblocking } from './socket.ts';
import type { Address } from './socket.ts';
import type { ConnectOptions } from './socket.ts';
/**
 * Options for opening or upgrading a TLS socket.
 *
 * `rejectUnauthorized` defaults to `true`; pass `false` only for local testing
 * or explicitly trusted endpoints. `hostname` is used for SNI and certificate
 * verification when provided.
 *
 * ```ts no_run
 * const tls = await TlsSocket.connect(addr, {
 *   hostname: 'example.com',
 *   alpn: ['h2', 'http/1.1'],
 * });
 * ```
 */
export interface TlsConnectOptions extends ConnectOptions {
  /** Hostname used for SNI and peer certificate checks.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { hostname: 'example.com' });
   * ```
   */
  hostname?: string;
  /** Alias for `hostname`, matching other TLS option surfaces.
   *
   * If both names are provided they must be identical.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { servername: 'example.com' });
   * ```
   */
  servername?: string;
  /** Path to a PEM CA bundle or file loaded with OpenSSL verify locations.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { hostname: 'internal.test', ca: '/etc/ssl/internal-ca.pem' });
   * ```
   */
  ca?: string;
  /** Path to the PEM client certificate chain presented when requested.
   *
   * Must be paired with `key`; partial certificate configuration throws before
   * the TCP connection is opened.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { cert: './client.pem', key: './client.key' });
   * ```
   */
  cert?: string;
  /** Path to the PEM private key matching `cert`.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { cert: './client.pem', key: './client.key' });
   * ```
   */
  key?: string;
  /** Whether to verify the peer certificate; defaults to `true`.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { rejectUnauthorized: false });
   * ```
   */
  rejectUnauthorized?: boolean;
  /** ALPN protocol list offered by the client in preference order.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { hostname: 'example.com', alpn: ['h2', 'http/1.1'] });
   * ```
   */
  alpn?: string[];
}
/** Client-certificate policy for server-side TLS handshakes. */
export type TlsClientAuth = 'none' | 'request' | 'require';
/** Options for creating a server-side TLS context.
 *
 * `clientAuth: 'request'` asks clients for a certificate but allows anonymous
 * handshakes. `clientAuth: 'require'` fails the handshake when no acceptable
 * client certificate is provided.
 */
export interface TlsServerContextOptions {
  /** PEM certificate chain presented by the server. */
  cert: string;
  /** PEM private key matching `cert`. */
  key: string;
  /** PEM CA bundle used to verify client certificates. */
  ca?: string;
  /** Client certificate policy. Defaults to `'none'`. */
  clientAuth?: TlsClientAuth;
  /** Whether verification failures abort the handshake. Defaults to `true`. */
  rejectUnauthorized?: boolean;
  /** ALPN protocols offered by the server. */
  alpn?: readonly string[];
}
/** Verification status reported by OpenSSL after a TLS handshake. */
export interface TlsVerifyResult {
  /** OpenSSL verification code. `0` means success. */
  code: number;
  /** Human-readable OpenSSL reason, or `null` when verification succeeded. */
  reason: string | null;
}
/** Peer TLS identity metadata.
 *
 * The certificate is the DER-encoded leaf certificate when one was presented.
 * Treat it as authenticated identity only when `authorized` is true.
 */
export interface TlsPeerInfo {
  /** Leaf peer certificate in DER form, or `null` when none was presented. */
  peerCertificate: Uint8Array | null;
  /** Verification status from OpenSSL. */
  verify: TlsVerifyResult;
  /** True when OpenSSL verification succeeded. */
  authorized: boolean;
}
const _serverVerifyModes = new WeakMap<object, number>();
function _checkTlsAvailable() {
  if (!openssl.tlsAvailable) {
    throw new Error(
      'tls: OpenSSL (libssl) is not available on this system. ' +
        'Install OpenSSL and ensure libssl is findable via the standard library paths.',
    );
  }
}
function _validateClientCertPair(opts: TlsConnectOptions): void {
  const hasCert = opts.cert !== undefined;
  const hasKey = opts.key !== undefined;
  if (hasCert !== hasKey)
    throw new TypeError('TLS client certificate options require both cert and key');
}
function _resolveServername(opts: TlsConnectOptions, fallback: string | null): string | null {
  if (
    opts.hostname !== undefined &&
    opts.servername !== undefined &&
    opts.hostname !== opts.servername
  ) {
    throw new TypeError('TLS options hostname and servername must match when both are provided');
  }
  return opts.servername ?? opts.hostname ?? fallback;
}
/** Create a server-side OpenSSL context for accepting TLS connections.
 *
 * The returned context owns OpenSSL state and must be freed with
 * `openssl.sslCtxFree()` by the caller. When ALPN or permissive verification
 * installs callbacks, they are returned in `callbacks` and must be retained for
 * the same lifetime as the context.
 *
 * @internal
 */
export function createTlsServerContext(opts: TlsServerContextOptions): {
  ctx: object;
  callbacks: object[];
} {
  _checkTlsAvailable();
  const ctx = openssl.sslCtxLoadCertKey(opts.cert, opts.key);
  const callbacks: object[] = [];
  try {
    const clientAuth = opts.clientAuth ?? 'none';
    if (clientAuth !== 'none') {
      const mode =
        openssl.SSL_VERIFY_PEER |
        (clientAuth === 'require' ? openssl.SSL_VERIFY_FAIL_IF_NO_PEER_CERT : 0);
      if (opts.rejectUnauthorized === false)
        callbacks.push(openssl.sslCtxSetPermissiveVerify(ctx, mode));
      else {
        _serverVerifyModes.set(ctx, mode);
        openssl.sslCtxSetVerify(ctx, mode);
      }
      if (opts.ca) openssl.sslCtxLoadVerifyLocations(ctx, opts.ca, null);
      else openssl.sslCtxSetDefaultVerifyPaths(ctx);
    }
    if (opts.alpn && opts.alpn.length > 0) {
      callbacks.push(openssl.sslCtxSetAlpnServerProtos(ctx, [...opts.alpn]));
    }
    return { ctx, callbacks };
  } catch (e) {
    for (const callback of callbacks) {
      try {
        (callback as { close?: () => void }).close?.();
      } catch (_) {}
    }
    openssl.sslCtxFree(ctx);
    throw e;
  }
}
// ---------------------------------------------------------------------------
// Async TLS handshake helper
// ---------------------------------------------------------------------------
async function _doHandshake(
  ssl: object,
  fd: number,
  handshakeFn: (ssl: object) => number | Promise<number>,
): Promise<void> {
  // Ensure fd is non-blocking — required for the non-blocking SSL_connect/SSL_accept loop.
  // connectTcp and accept already set non-blocking mode, but upgrade() may receive an
  // externally-created socket that hasn't been set yet.
  setNonblocking(fd);
  let iter = 0;
  while (true) {
    iter++;
    const ret = await handshakeFn(ssl);
    if (ret === 1) {
      return;
    }
    const err = openssl.sslGetError(ssl, ret);
    if (err === openssl.SSL_ERROR_WANT_READ) {
      await loop.readable(fd);
    } else if (err === openssl.SSL_ERROR_WANT_WRITE) {
      // Use a timeout fallback: on macOS, kqueue may not deliver EVFILT_WRITE
      // when the peer RSTs while we're write-blocked during handshake. Without
      // this, the fd leaks (sslFree and fd close never happen).
      const t = loop.timeout(100);
      await Promise.race([loop.writable(fd), t]);
      t.cancel();
      loop.removeWrite(fd);
    } else {
      throw new Error('TLS handshake failed (error=' + err + '): ' + openssl.getErrorString());
    }
  }
}
// ---------------------------------------------------------------------------
// TlsReader — extends Reader with SSL_read / SSL_pending
// ---------------------------------------------------------------------------
/**
 * Read half of a TLS connection. Extends BufferedBytesReader with SSL-specific
 * I/O: uses SSL_read instead of read(2), checks SSL_pending before waiting
 * for fd readability, and classifies SSL error codes correctly.
 *
 * Buffering, structural reads (readExactly, readUntil, etc.), and the async
 * iterator protocol are all inherited from BufferedBytesReader.
 *
 * ```ts no_run
 * const [reader] = tls.split();
 * const result = await reader.read();
 * ```
 */
export class TlsReader extends BufferedBytesReader {
  /**
   * Private property `#ssl` used by `TlsReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ssl = undefined;
   *
   *   readInternalState() {
   *     return this.#ssl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ssl: object;
  /**
   * Private property `#fd` used by `TlsReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fd = undefined;
   *
   *   readInternalState() {
   *     return this.#fd;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fd: number;
  #needsReadable = false;
  /**
   * Wrap OpenSSL state and a non-blocking fd as a TLS reader.
   *
   * The reader does not own the SSL pointer by itself; the close callback
   * coordinates cleanup with the paired `TlsWriter`.
   *
   * ```ts no_run
   * const reader = new TlsReader(ssl, fd, onClose);
   * ```
   */
  constructor(ssl: object, fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#ssl = ssl;
    this.#fd = fd;
  }
  /**
   * Underlying socket file descriptor.
   *
   * ```ts no_run
   * console.log(reader.fd);
   * ```
   */
  get fd(): number {
    return this.#fd;
  }
  override async close(): Promise<void> {
    loop.removeRead(this.#fd);
    loop.removeWrite(this.#fd);
    await super.close();
  }
  /**
   * Generated-doc-visible method `doPullInto`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   doPullInto() {
   *     return { done: true, value: undefined };
   *   },
   * };
   * includePrivateExample.doPullInto(new Uint8Array(1));
   * ```
   *
   * @internal
   */
  protected async doPullInto(buffer: Uint8Array): Promise<ReadResult<number>> {
    while (true) {
      if (this.closed) return { done: true, value: undefined };
      if (this.#needsReadable && openssl.sslPending(this.#ssl) <= 0) {
        await loop.readable(this.#fd);
        if (this.closed) return { done: true, value: undefined };
      }
      this.#needsReadable = false;
      const n = openssl.sslRead(this.#ssl, buffer, buffer.byteLength);
      if (n > 0) {
        this.#needsReadable = openssl.sslPending(this.#ssl) <= 0;
        return { done: false, value: n };
      }
      if (n === 0) return { done: true, value: undefined };
      const err = openssl.sslGetError(this.#ssl, n);
      if (err === openssl.SSL_ERROR_ZERO_RETURN) return { done: true, value: undefined };
      if (err === openssl.SSL_ERROR_WANT_READ) {
        this.#needsReadable = true;
        continue;
      }
      if (err === openssl.SSL_ERROR_WANT_WRITE) {
        await loop.writable(this.#fd);
        continue;
      }
      // Fatal protocol or syscall error — throw so callers can distinguish
      // a truncation/MAC failure from a clean peer-initiated close.
      if (err === openssl.SSL_ERROR_SSL || err === openssl.SSL_ERROR_SYSCALL) {
        throw new Error('TLS read failed: ' + openssl.getErrorString());
      }
      return { done: true, value: undefined };
    }
  }
}
// ---------------------------------------------------------------------------
// TlsWriter — extends Writer with SSL_write
// ---------------------------------------------------------------------------
/**
 * Write half of a TLS connection. Extends BufferedBytesWriter with SSL-specific
 * I/O: uses SSL_write instead of write(2) and handles SSL_ERROR_WANT_READ
 * during TLS renegotiation.
 *
 * Write coalescing, pipe(), and async close() are inherited from
 * BufferedBytesWriter.
 *
 * ```ts no_run
 * const [, writer] = tls.split();
 * await writer.write(new TextEncoder().encode('hello'));
 * await writer.flush();
 * ```
 */
export class TlsWriter extends BufferedBytesWriter {
  /**
   * Private property `#ssl` used by `TlsWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ssl = undefined;
   *
   *   readInternalState() {
   *     return this.#ssl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ssl: object;
  /**
   * Private property `#fd` used by `TlsWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fd = undefined;
   *
   *   readInternalState() {
   *     return this.#fd;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fd: number;
  /**
   * Wrap OpenSSL state and a non-blocking fd as a TLS writer.
   *
   * The writer shares SSL ownership with a `TlsReader`; cleanup runs through
   * the supplied close callback.
   *
   * ```ts no_run
   * const writer = new TlsWriter(ssl, fd, onClose);
   * ```
   */
  constructor(ssl: object, fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#ssl = ssl;
    this.#fd = fd;
  }
  /**
   * Underlying socket file descriptor.
   *
   * ```ts no_run
   * console.log(writer.fd);
   * ```
   */
  get fd(): number {
    return this.#fd;
  }
  /**
   * Generated-doc-visible method `doFlush`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   doFlush() {
   *     return 'doFlush';
   *   },
   * };
   * includePrivateExample.doFlush();
   * ```
   *
   * @internal
   */
  protected async doFlush(buf: Uint8Array): Promise<void> {
    let off = 0;
    while (off < buf.byteLength) {
      const slice = off === 0 ? buf : buf.subarray(off);
      const n = openssl.sslWrite(this.#ssl, slice, slice.byteLength);
      if (n > 0) {
        off += n;
        continue;
      }
      const err = openssl.sslGetError(this.#ssl, n);
      if (err === openssl.SSL_ERROR_WANT_WRITE) {
        // Race writable with a 100ms timeout: on macOS, kqueue does not always
        // deliver EVFILT_WRITE when the peer RSTs while we're write-blocked.
        // The timeout ensures cleanup (sslWrite → SSL_ERROR_SYSCALL → throw)
        // rather than hanging and leaking the fd.
        const t = loop.timeout(100);
        await Promise.race([loop.writable(this.#fd), t]);
        t.cancel();
        loop.removeWrite(this.#fd);
        if (this.closed) throw new Error('TlsWriter closed during write');
        continue;
      }
      if (err === openssl.SSL_ERROR_WANT_READ) {
        await loop.readable(this.#fd);
        if (this.closed) throw new Error('TlsWriter closed during write');
        continue;
      }
      throw new Error('TLS write failed');
    }
  }
}
// ---------------------------------------------------------------------------
// TlsSocket — extends Socket with SSL state
// ---------------------------------------------------------------------------
/**
 * A connected TLS socket. Extends `Socket` with SSL state.
 * TCP connection setup is shared with `Socket` via `connectTcp()`.
 * `split()` and `close()` are overridden to handle SSL teardown.
 *
 * `tls instanceof Socket` is true.
 *
 * Use the static factories rather than the constructor directly:
 * ```ts no_run
 * const tls = await TlsSocket.connect({ family: 'ipv4', ip: '93.184.216.34', port: 443 }, { hostname: 'example.com' });
 * const [reader, writer] = tls.split();
 * ```
 */
export class TlsSocket extends Socket {
  /**
   * Private property `#ssl` used by `TlsSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ssl = undefined;
   *
   *   readInternalState() {
   *     return this.#ssl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ssl: object;
  /**
   * Private property `#sslCtx` used by `TlsSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sslCtx = undefined;
   *
   *   readInternalState() {
   *     return this.#sslCtx;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #sslCtx: object | null;
  /**
   * Private property `#negotiatedProtocol` used by `TlsSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #negotiatedProtocol = undefined;
   *
   *   readInternalState() {
   *     return this.#negotiatedProtocol;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #negotiatedProtocol: string | null;
  #tlsClosed = false;
  /**
   * Wrap an established TLS session.
   *
   * The constructor takes ownership of `ssl` and, when non-null, `sslCtx`.
   * Prefer `connect()`, `upgrade()`, or `accept()` so handshakes and cleanup
   * are coordinated.
   *
   * ```ts no_run
   * const tls = new TlsSocket(fd, remoteAddr, ssl, sslCtx);
   * ```
   */
  constructor(fd: number, remoteAddr: Address | null, ssl: object, sslCtx: object | null) {
    super(fd, remoteAddr, null);
    this.#ssl = ssl;
    this.#sslCtx = sslCtx;
    this.#negotiatedProtocol = openssl.sslGetAlpnSelected(ssl);
  }
  /**
   * The ALPN protocol negotiated during the TLS handshake, or `null` if none.
   *
   * ```ts no_run
   * if (tls.negotiatedProtocol === 'h2') console.log('HTTP/2');
   * ```
   */
  get negotiatedProtocol(): string | null {
    return this.#negotiatedProtocol;
  }
  /** Return the peer leaf certificate as DER bytes, or `null`.
   *
   * This is raw certificate material. Treat it as authenticated identity only
   * when `getPeerInfo().authorized` is true.
   *
   * ```ts no_run
   * const cert = tls.getPeerCertificate();
   * if (cert) console.log(cert.byteLength);
   * ```
   */
  getPeerCertificate(): Uint8Array | null {
    return openssl.sslGetPeerCertificate(this.#ssl);
  }
  /** Return OpenSSL's peer verification result for this session.
   *
   * Code `0` means verification succeeded. When verification was disabled,
   * OpenSSL may still report the peer certificate's validation state, but the
   * result must not be treated as application authentication by itself.
   *
   * ```ts no_run
   * const verify = tls.getVerifyResult();
   * console.log(verify.code, verify.reason);
   * ```
   */
  getVerifyResult(): TlsVerifyResult {
    return openssl.sslGetVerifyResult(this.#ssl);
  }
  /** Return peer certificate and verification metadata together.
   *
   * ```ts no_run
   * const info = tls.getPeerInfo();
   * if (info.authorized) console.log(info.peerCertificate?.byteLength);
   * ```
   */
  getPeerInfo(): TlsPeerInfo {
    const verify = this.getVerifyResult();
    return {
      peerCertificate: this.getPeerCertificate(),
      verify,
      authorized: verify.code === 0,
    };
  }
  /**
   * Split into a [TlsReader, TlsWriter] pair. SSL cleanup and fd close happen
   * automatically when both halves have been closed.
   *
   * Note: TLS does not support half-close (no SHUT_RD/SHUT_WR per half).
   * Both sides must close before SSL_shutdown is issued.
   *
   * ```ts no_run
   * const [reader, writer] = tls.split();
   * await writer.close();
   * await reader.close();
   * ```
   */
  split(): [TlsReader, TlsWriter] {
    const ssl = this.#ssl;
    let closeCount = 0;
    const onBothClosed = () => {
      if (++closeCount < 2) return;
      this.#closeTls();
    };
    return [new TlsReader(ssl, this.fd, onBothClosed), new TlsWriter(ssl, this.fd, onBothClosed)];
  }
  /**
   * Close both directions immediately. Performs SSL teardown, then delegates
   * fd cleanup to `Socket.close()`. Idempotent.
   *
   * ```ts no_run
   * tls.close();
   * ```
   */
  close() {
    this.#closeTls();
  }
  /** Release the shared SSL session, context, and descriptor exactly once. */
  #closeTls(): void {
    if (this.#tlsClosed) return;
    this.#tlsClosed = true;
    try {
      openssl.sslShutdown(this.#ssl);
    } catch (_) {}
    openssl.sslFree(this.#ssl);
    if (this.#sslCtx) {
      openssl.sslCtxFree(this.#sslCtx);
      this.#sslCtx = null;
    }
    super.close();
  }
  /**
   * Connect to a remote address over TLS.
   * Uses `connectTcp()` for the TCP layer (same helper as `Socket.connect()`),
   * then performs the TLS handshake.
   *
   * Throws when OpenSSL is unavailable, TCP connection fails, certificate
   * verification fails, or the TLS handshake fails.
   *
   * ```ts no_run
   * const tls = await TlsSocket.connect(addr, { hostname: 'example.com' });
   * ```
   */
  static async connect(addr: Address, opts: TlsConnectOptions = {}): Promise<TlsSocket> {
    _checkTlsAvailable();
    _validateClientCertPair(opts);
    const hostname = _resolveServername(
      opts,
      addr.family === 'ipv4' || addr.family === 'ipv6' ? addr.ip : null,
    );
    const fd = await connectTcp(addr);
    try {
      return await TlsSocket._handshakeClient(fd, addr, hostname, opts);
    } catch (e) {
      closeFd(fd);
      throw e;
    }
  }
  /**
   * Upgrade an existing connected Socket to TLS (client side).
   * The original Socket should not be used after this call.
   *
   * On failure, the original socket fd remains caller-owned. This allows the
   * caller to decide whether to close or recover it.
   *
   * ```ts no_run
   * const raw = await Socket.connect(addr);
   * const tls = await TlsSocket.upgrade(raw, { hostname: 'example.com' });
   * ```
   */
  static async upgrade(socket: Socket, opts: TlsConnectOptions = {}): Promise<TlsSocket> {
    _checkTlsAvailable();
    _validateClientCertPair(opts);
    const hostname = _resolveServername(opts, null);
    try {
      return await TlsSocket._handshakeClient(socket.fd, null, hostname, opts);
    } catch (e) {
      // Don't close socket.fd here — caller owns it
      throw e;
    }
  }
  /**
   * Accept a TLS connection (server side) on an already-accepted TCP fd.
   *
   * `sslCtx` is borrowed from the server and is not freed by the returned
   * socket. On handshake failure, the SSL object is freed and the fd remains
   * caller-owned.
   *
   * ```ts no_run
   * const tls = await TlsSocket.accept(fd, sslCtx);
   * ```
   */
  static async accept(fd: number, sslCtx: object): Promise<TlsSocket> {
    _checkTlsAvailable();
    const ssl = openssl.sslNew(sslCtx);
    const verifyMode = _serverVerifyModes.get(sslCtx);
    if (verifyMode !== undefined) openssl.sslSetVerify(ssl, verifyMode);
    openssl.sslSetFd(ssl, fd);
    try {
      await _doHandshake(ssl, fd, openssl.sslAccept);
    } catch (e) {
      openssl.sslFree(ssl);
      throw e;
    }
    // sslCtx is owned by the caller (server); pass null so close() won't free it.
    return new TlsSocket(fd, null, ssl, null);
  }
  // ---------------------------------------------------------------------------
  // Private helper: shared client-side TLS setup + handshake
  // ---------------------------------------------------------------------------
  /**
   * Internal static method `_handshakeClient` used by `TlsSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   _handshakeClient() {
   *     return '_handshakeClient';
   *   },
   * };
   * includePrivateExample._handshakeClient();
   * ```
   *
   * @internal
   */
  static async _handshakeClient(
    fd: number,
    remoteAddr: Address | null,
    hostname: string | null,
    opts: TlsConnectOptions,
  ): Promise<TlsSocket> {
    const sslCtx = openssl.sslCtxNewClient();
    const rejectUnauthorized = opts.rejectUnauthorized !== false;
    if (rejectUnauthorized) {
      openssl.sslCtxSetVerify(sslCtx, openssl.SSL_VERIFY_PEER);
      if (opts.ca) {
        openssl.sslCtxLoadVerifyLocations(sslCtx, opts.ca, null);
      } else {
        openssl.sslCtxSetDefaultVerifyPaths(sslCtx);
      }
    }
    if (opts.alpn && opts.alpn.length > 0) {
      openssl.sslCtxSetAlpnProtos(sslCtx, opts.alpn);
    }
    if (opts.cert !== undefined && opts.key !== undefined) {
      openssl.sslCtxUseCertKey(sslCtx, opts.cert, opts.key);
    }
    const ssl = openssl.sslNew(sslCtx);
    openssl.sslSetFd(ssl, fd);
    if (hostname) {
      openssl.sslSetHostname(ssl, hostname);
    }
    try {
      await _doHandshake(ssl, fd, openssl.sslConnect);
    } catch (e) {
      openssl.sslFree(ssl);
      openssl.sslCtxFree(sslCtx);
      throw e;
    }
    return new TlsSocket(fd, remoteAddr, ssl, sslCtx);
  }
}
