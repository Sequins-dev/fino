/**
 * fino:tls — TLS socket layer.
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
 *   }
 *
 *
 * ## Close coordination
 *
 * When `split()` is used, both TlsReader and TlsWriter share the SSL* pointer.
 * When both halves close, SSL is shut down and freed, then the fd is closed via
 * `super.close()`. When `close()` is called directly (without splitting), SSL
 * teardown happens before calling `super.close()`.
 */

import * as openssl from '../internal/openssl.mts';
import * as loop from '../runtime/loop.mts';
import { BufferedBytesReader, BufferedBytesWriter } from '../internal/stream.mts';
import { Socket, connectTcp, close as closeFd, setNonblocking } from './socket.mts';
import type { Address } from './socket.mts';
import type { ConnectOptions } from './socket.mts';

export interface TlsConnectOptions extends ConnectOptions {
  hostname?:           string;
  ca?:                 string;
  rejectUnauthorized?: boolean;
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

async function _doHandshake(ssl: object, fd: number, handshakeFn: (ssl: object) => number): Promise<void> {
  // Ensure fd is non-blocking — required for the non-blocking SSL_connect/SSL_accept loop.
  // connectTcp and accept already set non-blocking mode, but upgrade() may receive an
  // externally-created socket that hasn't been set yet.
  setNonblocking(fd);
  while (true) {
    const ret = handshakeFn(ssl);
    if (ret === 1) return; // success

    const err = openssl.sslGetError(ssl, ret);
    if (err === openssl.SSL_ERROR_WANT_READ) {
      await loop.readable(fd);
    } else if (err === openssl.SSL_ERROR_WANT_WRITE) {
      await loop.writable(fd);
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
 */
export class TlsReader extends BufferedBytesReader {
  #ssl: object;
  #fd:  number;
  #readBuf: ArrayBuffer = new ArrayBuffer(65536);

  constructor(ssl: object, fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#ssl = ssl;
    this.#fd  = fd;
  }

  get fd(): number { return this.#fd; }

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
        // No data yet — wait for fd readability, then retry.
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
 */
export class TlsWriter extends BufferedBytesWriter {
  #ssl: object;
  #fd:  number;

  constructor(ssl: object, fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#ssl = ssl;
    this.#fd  = fd;
  }

  get fd(): number { return this.#fd; }

  protected async doFlush(buf: Uint8Array): Promise<void> {
    let off = 0;
    while (off < buf.byteLength) {
      const slice = off === 0 ? buf : buf.subarray(off);
      const n = openssl.sslWrite(this.#ssl, slice, slice.byteLength);
      if (n > 0) { off += n; continue; }
      const err = openssl.sslGetError(this.#ssl, n);
      if (err === openssl.SSL_ERROR_WANT_WRITE) {
        await loop.writable(this.#fd);
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
 *   const tls = await TlsSocket.connect(lp, { family: 'ipv4', ip: '…', port: 443 });
 *   const [reader, writer] = tls.split();
 */
export class TlsSocket extends Socket {
  #ssl: object;
  #sslCtx: object | null;
  // Bound reference to super.close() for use inside split() closures,
  // where `super` is not lexically accessible.
  #superClose: () => void;

  constructor(fd: number, remoteAddr: Address | null, ssl: object, sslCtx: object | null) {
    super(fd, remoteAddr, null);
    this.#ssl    = ssl;
    this.#sslCtx = sslCtx;
    this.#superClose = () => super.close();
  }

  /**
   * Split into a [TlsReader, TlsWriter] pair. SSL cleanup and fd close happen
   * automatically when both halves have been closed.
   *
   * Note: TLS does not support half-close (no SHUT_RD/SHUT_WR per half).
   * Both sides must close before SSL_shutdown is issued.
   *
   * @returns {[TlsReader, TlsWriter]}
   */
  split(): [TlsReader, TlsWriter] {
    const ssl        = this.#ssl;
    const sslCtx     = this.#sslCtx;
    const superClose = this.#superClose;
    let closeCount = 0;

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
   * @param {object} lp — loop handle from fino:loop
   * @param {{ family: 'ipv4'|'ipv6', ip: string, port: number }} addr
   * @param {{ hostname?: string, ca?: string, rejectUnauthorized?: boolean }} [opts]
   * @returns {Promise<TlsSocket>}
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
   * @param {Socket} socket — existing connected Socket
   * @param {object} lp — loop handle
   * @param {{ hostname?: string, ca?: string, rejectUnauthorized?: boolean }} [opts]
   * @returns {Promise<TlsSocket>}
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
   * @param {number} fd — accepted socket fd (non-blocking)
   * @param {object} lp — loop handle
   * @param {object} sslCtx — server SSL_CTX* (pre-configured with cert/key; not owned)
   * @returns {Promise<TlsSocket>}
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
