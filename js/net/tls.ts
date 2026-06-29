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
 * There is no public TLS session cache or session-ticket reuse API here, and
 * server-side client-certificate authentication is not exposed by this socket
 * layer today. mTLS support that exists elsewhere, such as QUIC/HTTP server
 * integrations, is documented and tested at those higher-level APIs rather
 * than through `TlsSocket`.
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
import { BufferedBytesReader, BufferedBytesWriter } from '../internal/stream.ts';
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
  hostname?:           string;
  /** Path to a PEM CA bundle or file loaded with OpenSSL verify locations.
   *
   * ```ts no_run
   * await TlsSocket.connect(addr, { hostname: 'internal.test', ca: '/etc/ssl/internal-ca.pem' });
   * ```
   */
  ca?:                 string;
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
  alpn?:               string[];
}

function _checkTlsAvailable() {
  if (!openssl.tlsAvailable) {
    throw new Error(
      'tls: OpenSSL (libssl) is not available on this system. ' +
      'Install OpenSSL and ensure libssl is findable via the standard library paths.',
    );
  }
}

// ---------------------------------------------------------------------------
// Async TLS handshake helper
// ---------------------------------------------------------------------------

async function _doHandshake(ssl: object, fd: number, handshakeFn: (ssl: object) => number | Promise<number>): Promise<void> {
  // Ensure fd is non-blocking — required for the non-blocking SSL_connect/SSL_accept loop.
  // connectTcp and accept already set non-blocking mode, but upgrade() may receive an
  // externally-created socket that hasn't been set yet.
  setNonblocking(fd);
  let iter = 0;
  while (true) {
    iter++;
    const ret = await handshakeFn(ssl);
    if (ret === 1) { return; } // success

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
 * const bytes = await reader.read();
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
  #fd:  number;
  /**
   * Private property `#readBuf` used by `TlsReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readBuf = undefined;
   *
   *   readInternalState() {
   *     return this.#readBuf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readBuf: ArrayBuffer = new ArrayBuffer(65536);

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
    this.#fd  = fd;
  }

  /**
   * Underlying socket file descriptor.
   *
   * ```ts no_run
   * console.log(reader.fd);
   * ```
   */
  get fd(): number { return this.#fd; }

  /**
   * Generated-doc-visible method `doPull`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateExample = {
   *   doPull() {
   *     return 'doPull';
   *   },
   * };
   * includePrivateExample.doPull();
   * ```
   *
   * @internal
   */
  protected async doPull(): Promise<Uint8Array | null> {
    while (true) {
      if (this.closed) return null;
      const n = openssl.sslRead(this.#ssl, this.#readBuf, 65536);
      if (n > 0) {
        const out = new Uint8Array(n);
        out.set(new Uint8Array(this.#readBuf, 0, n));
        return out;
      }
      if (n === 0) return null;
      const err = openssl.sslGetError(this.#ssl, n);
      if (err === openssl.SSL_ERROR_ZERO_RETURN) return null;
      if (err === openssl.SSL_ERROR_WANT_READ) {
        await loop.readable(this.#fd);
        if (this.closed) return null;
        continue;
      }
      if (err === openssl.SSL_ERROR_WANT_WRITE) {
        await loop.writable(this.#fd); // TLS renegotiation
        continue;
      }
      // Fatal protocol or syscall error — throw so callers can distinguish
      // a truncation/MAC failure from a clean peer-initiated close.
      if (err === openssl.SSL_ERROR_SSL || err === openssl.SSL_ERROR_SYSCALL) {
        throw new Error('TLS read failed: ' + openssl.getErrorString());
      }
      return null; // unexpected code — treat as EOF
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
  #fd:  number;

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
    this.#fd  = fd;
  }

  /**
   * Underlying socket file descriptor.
   *
   * ```ts no_run
   * console.log(writer.fd);
   * ```
   */
  get fd(): number { return this.#fd; }

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
      if (n > 0) { off += n; continue; }
      const err = openssl.sslGetError(this.#ssl, n);
      if (err === openssl.SSL_ERROR_WANT_WRITE) {
        // Race writable with a 100ms timeout: on macOS, kqueue does not always
        // deliver EVFILT_WRITE when the peer RSTs while we're write-blocked.
        // The timeout ensures cleanup (sslWrite → SSL_ERROR_SYSCALL → throw)
        // rather than hanging and leaking the fd.
        const t = loop.timeout(100);
        await Promise.race([loop.writable(this.#fd), t]);
        t.cancel();
        loop.removeWrite(this.#fd); // no-op if writable fired; cleanup if timeout fired
        if (this.closed) throw new Error('TlsWriter closed during write');
        continue;
      }
      if (err === openssl.SSL_ERROR_WANT_READ) {
        await loop.readable(this.#fd); // TLS renegotiation
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
  // Bound reference to super.close() for use inside split() closures,
  // where `super` is not lexically accessible.
  /**
   * Private property `#superClose` used by `TlsSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #superClose = undefined;
   *
   *   readInternalState() {
   *     return this.#superClose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #superClose: () => void;

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
    this.#ssl    = ssl;
    this.#sslCtx = sslCtx;
    this.#negotiatedProtocol = openssl.sslGetAlpnSelected(ssl);
    this.#superClose = () => super.close();
  }

  /**
   * The ALPN protocol negotiated during the TLS handshake, or `null` if none.
   *
   * ```ts no_run
   * if (tls.negotiatedProtocol === 'h2') console.log('HTTP/2');
   * ```
   */
  get negotiatedProtocol(): string | null { return this.#negotiatedProtocol; }

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
    const ssl        = this.#ssl;
    const sslCtx     = this.#sslCtx;
    const superClose = this.#superClose;
    let closeCount = 0;

    const fd = this.fd;
    const onBothClosed = function onBothClosed() {
      if (++closeCount < 2) return;
      try { openssl.sslShutdown(ssl); } catch (_) {}
      openssl.sslFree(ssl);
      if (sslCtx) openssl.sslCtxFree(sslCtx);
      superClose(); // Socket.close() — sets #closed, closes fd
    };

    return [
      new TlsReader(ssl, this.fd, onBothClosed),
      new TlsWriter(ssl, this.fd, onBothClosed),
    ];
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
    if (this.closed) return;
    try { openssl.sslShutdown(this.#ssl); } catch (_) {}
    openssl.sslFree(this.#ssl);
    if (this.#sslCtx) openssl.sslCtxFree(this.#sslCtx);
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
    const fd = await connectTcp(addr);
    const hostname = opts.hostname
      ?? ((addr.family === 'ipv4' || addr.family === 'ipv6') ? addr.ip : null);
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
    const hostname = opts.hostname ?? null;
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
  static async _handshakeClient(fd: number, remoteAddr: Address | null, hostname: string | null, opts: TlsConnectOptions): Promise<TlsSocket> {
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
