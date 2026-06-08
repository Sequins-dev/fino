/**
 * fino:serve — HTTP server convenience.
 *
 * `serve()` wraps `Socket.listen()` and dispatches each accepted connection to
 * an H1ServerDriver (or, in future, an H2ServerDriver based on ALPN/preface
 * detection). The driver owns the per-connection keep-alive, pipelining, and
 * protocol-upgrade logic.
 *
 *
 * ## Usage
 *
 * ```ts no_run
 *   import { serve } from 'fino:net/http/server';
 *
 *   const server = serve({ port: 3000 }, async (req) => {
 *     return new Response('hello');
 *   });
 *
 *   // Graceful shutdown:
 *   await server.close();
 * ```
 *
 *
 * ## Keep-alive
 *
 * HTTP/1.1 connections are kept alive by default. The driver loops over
 * requests on the same TCP connection until the client sends
 * `Connection: close`, the handler returns a response with that header, or
 * the connection is reset.
 *
 *
 * ## Content-Length
 *
 * If the handler's Response does not include a `Content-Length` or
 * `Transfer-Encoding` header, the driver eagerly buffers the body and injects
 * `Content-Length`. For truly streaming responses, set one of those headers
 * yourself.
 *
 *
 * ## Error handling
 *
 * If the handler throws an unhandled error, the driver sends a bare
 * `500 Internal Server Error` response and closes the connection. The handler
 * is responsible for catching its own application errors and returning
 * appropriate responses.
 */

import { Socket } from '../socket.mts';
import { TlsSocket } from '../tls.mts';
import { sslCtxLoadCertKey, sslCtxFree, sslCtxSetAlpnServerProtos } from '../../internal/openssl.mts';
import { H1ServerDriver } from './h1.mts';
import { H2ServerDriver } from '../../internal/net/http/h2/server.mts';
import { h2Available } from '../../internal/net/http/h2/bindings.mts';
import type { ConnectionTakeover } from './driver.mts';
import type { Request } from './index.mts';
import type { IPv4Address } from '../socket.mts';

// H2 client preface: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
const _H2_PREFACE = new Uint8Array([
  0x50, 0x52, 0x49, 0x20, 0x2A, 0x20, 0x48, 0x54, 0x54, 0x50, 0x2F, 0x32,
  0x2E, 0x30, 0x0D, 0x0A, 0x0D, 0x0A, 0x53, 0x4D, 0x0D, 0x0A, 0x0D, 0x0A,
]);

function _isH2Preface(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  for (let i = 0; i < 24; i++) {
    if (bytes[i] !== _H2_PREFACE[i]) return false;
  }
  return true;
}

interface ServeOptions {
  port:      number;
  hostname?: string;
  tls?: {
    cert: string;  // path to PEM certificate file
    key:  string;  // path to PEM private key file
  };
  /** Enable the HTTP/1.1 → h2c Upgrade dance (RFC 7540 §3.2) on plain TCP. */
  allowH2cUpgrade?: boolean;
}

interface ServeServer {
  address: { family: string; ip: string; port: number };
  readonly port: number;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const _h1Driver = new H1ServerDriver();
const _h2Driver = new H2ServerDriver();

/**
 * Start an HTTP server.
 *
 * Each incoming connection is handled concurrently. The event loop is
 * implicitly kept alive as long as the server is open.
 *
 * `hostname` defaults to `0.0.0.0`, and `port` may be `0` to request an
 * ephemeral port. When `tls` is present, the server loads the certificate and
 * key paths and advertises HTTP/2 through ALPN when libnghttp2 is available.
 * `close()` stops accepting, closes the listening socket, releases TLS state,
 * and resolves after in-flight connections finish.
 *
 * ```ts no_run
 * import { serve } from 'fino:net/http/server';
 *
 * const server = serve({ port: 3000 }, async (req) => new Response('hello'));
 * console.log(server.port);
 * await server.close();
 * ```
 */
export function serve(
  options: ServeOptions,
  handler: (req: Request) => Response | ConnectionTakeover | Promise<Response | ConnectionTakeover>,
): ServeServer {
  const hostname = options.hostname ?? '0.0.0.0';
  const port     = options.port ?? 0;

  const addr: IPv4Address = { family: 'ipv4', ip: hostname, port };
  const tcpServer = Socket.listen(addr);

  let sslCtx = options.tls ? sslCtxLoadCertKey(options.tls.cert, options.tls.key) : null;
  // Register ALPN select callback so TLS clients can negotiate h2.
  // The returned FfiCallback is retained alongside sslCtx and closed on server.close().
  let alpnCb: object | null = (sslCtx !== null && h2Available)
    ? sslCtxSetAlpnServerProtos(sslCtx, ['h2', 'http/1.1'])
    : null;

  const inFlight = new Set<Promise<void>>();
  let acceptLoopDone = false;
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>(function captureFinishResolve(resolve) { finishResolve = resolve; });

  let closeSignalResolve: (() => void) | null = null;
  const closeSignal = new Promise<null>(function captureCloseResolve(resolve) { closeSignalResolve = () => resolve(null); });

  const boundAddress = tcpServer.address;
  if (boundAddress.family !== 'ipv4' && boundAddress.family !== 'ipv6') {
    if (alpnCb !== null) { (alpnCb as any).close(); alpnCb = null; }
    if (sslCtx !== null) { sslCtxFree(sslCtx); sslCtx = null; }
    throw new TypeError('serve: expected an IP server address');
  }

  function _checkDone() {
    if (acceptLoopDone && inFlight.size === 0 && finishResolve) finishResolve();
  }

  (async function acceptLoop() {
    try {
      while (true) {
        const tcpConn: Awaited<ReturnType<typeof tcpServer.accept>> | null = await Promise.race([tcpServer.accept(), closeSignal]);
        if (tcpConn === null || tcpConn === undefined) break;

        let connPromise: Promise<void>;
        if (sslCtx !== null) {
          connPromise = TlsSocket.accept(tcpConn.fd, sslCtx).then(
            async function handleTlsConn(tlsConn) {
              const proto = tlsConn.negotiatedProtocol;
              const [reader, writer] = tlsConn.split();
              try {
                if (h2Available && proto === 'h2') {
                  await _h2Driver.run(reader, writer, handler, { maxConcurrent: 32 });
                } else {
                  await _h1Driver.run(reader, writer, handler, { maxConcurrent: 32, allowH2cUpgrade: options.allowH2cUpgrade });
                }
              } catch {
                try { await reader.close(); } catch {}
                try { await writer.close(); } catch {}
              }
            },
            function tlsHandshakeError(err: unknown) {
              tcpConn.close();
              if (typeof console !== 'undefined') {
                console.error('fino:serve TLS handshake failed:', err);
              }
            },
          );
        } else {
          connPromise = (async function handleConn() {
            const [reader, writer] = tcpConn.split();
            if (h2Available) {
              const preface = await reader.peek(24);
              if (_isH2Preface(preface)) {
                await _h2Driver.run(reader, writer, handler, { maxConcurrent: 32 });
                return;
              }
            }
            await _h1Driver.run(reader, writer, handler, { maxConcurrent: 32, allowH2cUpgrade: options.allowH2cUpgrade });
          })();
        }

        inFlight.add(connPromise);
        connPromise.finally(function cleanupConnection() { inFlight.delete(connPromise); _checkDone(); });
      }
    } finally {
      acceptLoopDone = true;
      _checkDone();
    }
  })().catch(function swallowAcceptError(err: unknown) {
    console.error('[serve] acceptLoop DIED:', err);
  });

  return {
    address: boundAddress,
    get port() { return boundAddress.port; },
    close(): Promise<void> {
      if (closeSignalResolve) closeSignalResolve();
      tcpServer.close();
      if (alpnCb !== null) { (alpnCb as any).close(); alpnCb = null; }
      if (sslCtx !== null) { sslCtxFree(sslCtx); sslCtx = null; }
      return finished;
    },

    /** Explicit resource-management hook for `await using` declarations. */
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    },
  };
}
