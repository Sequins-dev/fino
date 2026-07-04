/**
* fino:serve — HTTP server convenience.
*
* Learn more:
* - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
* - HTTP/1.1 messaging: https://www.rfc-editor.org/rfc/rfc9112
* - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
* - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
*
* `serve()` wraps `Socket.listen()` and dispatches each accepted connection to
* the HTTP/1.1 driver, the HTTP/2 driver for prior-knowledge h2c prefaces, or
* the HTTP/2 driver for TLS connections that negotiate `h2` through ALPN. The
* selected driver owns the per-connection keep-alive, pipelining, and
* protocol-upgrade logic.
*
*
* ## Usage
*
* ```ts no_run
*   import { serveHttp } from 'fino:net/http/server';
*
*   const server = serveHttp({ port: 3000 }, async (req) => {
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
import { Socket } from '../socket.ts';
import { TlsSocket, createTlsServerContext } from '../tls.ts';
import { sslCtxFree } from '../../internal/openssl.ts';
import type { TlsPeerInfo } from '../tls.ts';
import { H1ServerDriver } from 'internal:net/http/h1';
import { H2ServerDriver } from '../../internal/net/http/h2/server.ts';
import { h2Available } from '../../internal/net/http/h2/bindings.ts';
import { serve as serveH3, requireH3 } from './h3.ts';
import type { H3Server, H3ServeOptions } from './h3.ts';
import { _headerTokenList } from './index.ts';
import { WebSocketConnection } from '../../globals/websocket.ts';
import type { WebSocketAcceptOptions } from '../../globals/websocket.ts';
import { WebTransport } from '../../globals/webtransport.ts';
import type { WebTransportOptions } from '../../globals/webtransport.ts';
import type { H3WebTransportHandler } from '../../internal/net/http/h3/server.ts';
import type { ConnectionTakeover, ServerHandler, ServerResult } from 'internal:net/http/driver';
import type { Request, Response } from './index.ts';
import { Response as HttpResponse } from './index.ts';
import type { Address, ListenOptions } from '../socket.ts';
// H2 client preface: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
const _H2_PREFACE = new Uint8Array([
  80,
  82,
  73,
  32,
  42,
  32,
  72,
  84,
  84,
  80,
  47,
  50,
  46,
  48,
  13,
  10,
  13,
  10,
  83,
  77,
  13,
  10,
  13,
  10
]);
function _isH2Preface(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  for (let i = 0; i < 24; i++) {
    if (bytes[i] !== _H2_PREFACE[i]) return false;
  }
  return true;
}
export type HttpProtocol = 'http/1.1' | 'h2' | 'h3';
export interface ServeOptions {
  port: number;
  hostname?: string;
  /** Explicit IP family for the listening socket. Defaults from hostname. */
  family?: 'ipv4' | 'ipv6';
  /** Listen backlog passed through to Socket.listen(). */
  backlog?: number;
  /** Set SO_REUSEADDR before bind. Defaults to Socket.listen() behavior. */
  reuseAddr?: boolean;
  /** Set SO_REUSEPORT before bind where supported. */
  reusePort?: boolean;
  tls?: {
    cert: string;
    key: string;
    /** PEM CA bundle used to verify client certificates. */
    ca?: string;
    /** Client certificate policy. Defaults to not requesting a certificate. */
    clientAuth?: 'none' | 'request' | 'require';
    /** Whether client certificate verification failures abort the handshake. Defaults to true. */
    rejectUnauthorized?: boolean;
    /** TLS ALPN protocols to offer. Defaults to ['h2', 'http/1.1'] when HTTP/2 is available. */
    protocols?: readonly Extract<HttpProtocol, 'http/1.1' | 'h2'>[];
  };
  /** Enable the HTTP/1.1 → h2c Upgrade dance (RFC 7540 §3.2) on plain TCP. */
  allowH2cUpgrade?: boolean;
  /** HTTP/1 header timeout in milliseconds. `0` or undefined disables it. */
  headersTimeoutMs?: number;
  /** HTTP/1 keep-alive idle timeout in milliseconds. `0` or undefined disables it. */
  idleTimeoutMs?: number;
  /** Enable an HTTP/3 UDP listener on the same host and port. Requires `tls`. */
  h3?: boolean | {
    quic?: Partial<Omit<H3ServeOptions, 'port' | 'hostname' | 'certificateFile' | 'privateKeyFile'>>;
  };
}
export interface ServeServer {
  address: {
    family: string;
    ip: string;
    port: number;
  };
  readonly port: number;
  /** Resolves when all requested listeners, including optional H3, are ready. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export type HttpTransport = 'tcp' | 'tls' | 'quic';
export type HttpHandlerResult = Response | WebSocketConnection | WebTransport;
export type HttpRequestHandler = (request: Request, session: HttpSession) => HttpHandlerResult | Promise<HttpHandlerResult>;
export interface HttpSession {
  readonly id: string;
  readonly protocol: HttpProtocol;
  readonly transport: HttpTransport;
  readonly secure: boolean;
  readonly localAddress: unknown | null;
  readonly remoteAddress: unknown | null;
  /** TLS peer metadata for secure transports, or `null` for plain TCP. */
  readonly tls: TlsPeerInfo | null;
  readonly closed: Promise<void>;
}
export type HttpTlsPeerInfo = TlsPeerInfo;
interface IncomingBase<TKind extends string> {
  readonly kind: TKind;
  readonly request: Request;
  readonly protocol: HttpProtocol;
  readonly session: HttpSession;
  readonly tls: TlsPeerInfo | null;
  reject(response?: Response): Promise<void>;
}
export interface IncomingHttpRequest extends IncomingBase<'request'> {
  accept(): Promise<AcceptedHttpRequest>;
}
export interface AcceptedHttpRequest {
  readonly kind: 'request';
  readonly request: Request;
  readonly protocol: HttpProtocol;
  readonly session: HttpSession;
  respond(response: HttpHandlerResult): Promise<void>;
}
export interface IncomingWebSocketRequest extends IncomingBase<'websocket'> {
  readonly subprotocols: readonly string[];
  accept(options?: WebSocketAcceptOptions): Promise<WebSocketConnection>;
}
/**
* Incoming HTTP/3 extended CONNECT request for WebTransport.
*/
export interface IncomingWebTransportRequest extends IncomingBase<'webtransport'> {
  /** Application protocol tokens requested by the client. */
  readonly protocols: readonly string[];
  /** Accept the WebTransport session and take over the request stream. */
  accept(options?: WebTransportOptions): Promise<WebTransport>;
}
export type IncomingHttp = IncomingHttpRequest | IncomingWebSocketRequest | IncomingWebTransportRequest;
export type ServerAcceptHandler = (incoming: IncomingHttp, session: HttpSession) => void | Promise<void>;
let _sessionSeq = 0;
function _makeSession(protocol: HttpProtocol, transport: HttpTransport, addresses?: {
  localAddress?: unknown;
  remoteAddress?: unknown;
  tls?: TlsPeerInfo | null;
}): HttpSession {
  return {
    id: `http-session-${++_sessionSeq}`,
    protocol,
    transport,
    secure: transport !== 'tcp',
    localAddress: addresses?.localAddress ?? null,
    remoteAddress: addresses?.remoteAddress ?? null,
    tls: addresses?.tls ?? null,
    closed: Promise.resolve()
  };
}
function _isWebSocketUpgradeAttempt(request: Request, protocol: HttpProtocol): boolean {
  if (protocol !== 'http/1.1') return false;
  return (request.headers.get('upgrade') ?? '').toLowerCase().trim() === 'websocket';
}
function _defaultReject(kind: IncomingHttp['kind']): Response {
  return kind === 'websocket' ? new HttpResponse('Bad Request', { status: 400 }) : new HttpResponse('Not Found', { status: 404 });
}
function _makeAcceptAdapter(handler: ServerAcceptHandler, protocol: HttpProtocol, transport: HttpTransport, addresses?: {
  localAddress?: unknown;
  remoteAddress?: unknown;
}): ServerHandler {
  return async (request: Request): Promise<ServerResult> => {
    const session = _makeSession(protocol, transport, addresses);
    const kind = _isWebSocketUpgradeAttempt(request, protocol) ? 'websocket' : 'request';
    let decision: 'pending' | 'accepted' | 'rejected' = 'pending';
    let responded = false;
    let result: ServerResult | null = null;
    function assertPending(action: string): void {
      if (decision !== 'pending') throw new TypeError(`HTTP incoming already ${decision}; cannot ${action}`);
    }
    const base = {
      kind,
      request,
      protocol,
      session,
      tls: session.tls,
      reject(response?: Response): Promise<void> {
        assertPending('reject');
        decision = 'rejected';
        result = response ?? _defaultReject(kind);
        return Promise.resolve();
      }
    };
    const incoming: IncomingHttp = kind === 'websocket' ? {
      ...base,
      kind: 'websocket',
      subprotocols: _headerTokenList(request.headers.get('sec-websocket-protocol')),
      accept(options?: WebSocketAcceptOptions): Promise<WebSocketConnection> {
        assertPending('accept');
        const socket = WebSocketConnection.accept(request, options);
        decision = 'accepted';
        result = socket;
        return Promise.resolve(socket);
      }
    } : {
      ...base,
      kind: 'request',
      accept(): Promise<AcceptedHttpRequest> {
        assertPending('accept');
        decision = 'accepted';
        const accepted: AcceptedHttpRequest = {
          kind: 'request',
          request,
          protocol,
          session,
          respond(response: ServerResult): Promise<void> {
            if (responded) throw new TypeError('HTTP request already responded');
            responded = true;
            result = response;
            return Promise.resolve();
          }
        };
        return Promise.resolve(accepted);
      }
    };
    await handler(incoming, session);
    if (decision === 'pending') throw new Error('HTTP incoming handler did not accept or reject');
    if (decision === 'accepted' && kind === 'request' && !responded) throw new Error('Accepted HTTP request did not respond');
    if (result === null) throw new Error('HTTP incoming handler did not produce a response');
    return result;
  };
}
function _makeWebTransportAcceptAdapter(handler: ServerAcceptHandler, protocol: HttpProtocol, transport: HttpTransport, addresses?: {
  localAddress?: unknown;
  remoteAddress?: unknown;
}): H3WebTransportHandler {
  return async (request: Request, webtransport: WebTransport): Promise<WebTransport | Response> => {
    const session = _makeSession(protocol, transport, addresses);
    let decision: 'pending' | 'accepted' | 'rejected' = 'pending';
    let result: WebTransport | Response | null = null;
    function assertPending(action: string): void {
      if (decision !== 'pending') throw new TypeError(`HTTP incoming already ${decision}; cannot ${action}`);
    }
    const incoming: IncomingWebTransportRequest = {
      kind: 'webtransport',
      request,
      protocol,
      session,
      tls: session.tls,
      protocols: _headerTokenList(request.headers.get('sec-webtransport-protocol')),
      reject(response?: Response): Promise<void> {
        assertPending('reject');
        decision = 'rejected';
        result = response ?? _defaultReject('webtransport');
        return Promise.resolve();
      },
      accept(_options?: WebTransportOptions): Promise<WebTransport> {
        assertPending('accept');
        decision = 'accepted';
        result = webtransport;
        return Promise.resolve(webtransport);
      }
    };
    await handler(incoming, session);
    if (decision === 'pending') throw new Error('HTTP incoming handler did not accept or reject');
    if (result === null) throw new Error('HTTP incoming handler did not produce a response');
    return result;
  };
}
const _h1Driver = new H1ServerDriver();
const _h2Driver = new H2ServerDriver();
function _listenAddress(options: ServeOptions): Address {
  const family = options.family ?? ((options.hostname ?? '').includes(':') ? 'ipv6' : 'ipv4');
  const hostname = options.hostname ?? (family === 'ipv6' ? '::' : '0.0.0.0');
  return {
    family,
    ip: hostname,
    port: options.port ?? 0
  };
}
function _listenOptions(options: ServeOptions): ListenOptions {
  return {
    backlog: options.backlog,
    reuseAddr: options.reuseAddr,
    reusePort: options.reusePort
  };
}
function _quicCaFromTls(ca: string | undefined): { file: string } | undefined {
  return ca === undefined ? undefined : { file: ca };
}
/**
* Start an accept-based HTTP server.
*
* Each incoming connection is handled concurrently. The event loop is
* implicitly kept alive as long as the server is open.
*
* `hostname` defaults to `0.0.0.0` for IPv4 and `::` for explicit IPv6, and
* `port` may be `0` to request an ephemeral port. When `tls` is present, the
* server loads the certificate and key paths and advertises HTTP/2 through ALPN
* when libnghttp2 is available.
* `close()` stops accepting, closes the listening socket, releases TLS state,
* and resolves after in-flight connections finish. `backlog`, `reuseAddr`, and
* `reusePort` are passed to the underlying socket listener.
*
* ```ts no_run
* import { serve } from 'fino:net/http/server';
*
* const server = serve({ port: 3000 }, async (incoming) => {
*   const accepted = await incoming.accept();
*   await accepted.respond(new Response('hello'));
* });
* console.log(server.port);
* await server.close();
* ```
*/
export function serve(options: ServeOptions, handler: ServerAcceptHandler): ServeServer {
  if (options.h3 !== undefined && options.h3 !== false) {
    if (options.tls === undefined) throw new Error('serve: h3 requires tls certificate and key');
    requireH3();
  }
  const tcpServer = Socket.listen(_listenAddress(options), _listenOptions(options));
  const tlsProtocols = options.tls?.protocols ?? (h2Available ? ['h2', 'http/1.1'] : ['http/1.1']);
  const alpnProtocols = tlsProtocols.filter((protocol): protocol is 'h2' | 'http/1.1' => {
    return protocol === 'http/1.1' || protocol === 'h2' && h2Available;
  });
  const tlsContext = options.tls ? createTlsServerContext({
    cert: options.tls.cert,
    key: options.tls.key,
    ca: options.tls.ca,
    clientAuth: options.tls.clientAuth,
    rejectUnauthorized: options.tls.rejectUnauthorized,
    alpn: alpnProtocols
  }) : null;
  let sslCtx = tlsContext?.ctx ?? null;
  let tlsCallbacks = tlsContext?.callbacks ?? [];
  const inFlight = new Set<Promise<void>>();
  let acceptLoopDone = false;
  let finishResolve: (() => void) | null = null;
  const finished = new Promise<void>(function captureFinishResolve(resolve) {
    finishResolve = resolve;
  });
  let closeSignalResolve: (() => void) | null = null;
  const closeSignal = new Promise<null>(function captureCloseResolve(resolve) {
    closeSignalResolve = () => resolve(null);
  });
  const boundAddress = tcpServer.address;
  if (boundAddress.family !== 'ipv4' && boundAddress.family !== 'ipv6') {
    for (const callback of tlsCallbacks) {
      try {
        (callback as { close?: () => void }).close?.();
      } catch {}
    }
    tlsCallbacks = [];
    if (sslCtx !== null) {
      sslCtxFree(sslCtx);
      sslCtx = null;
    }
    throw new TypeError('serve: expected an IP server address');
  }
  function _checkDone() {
    if (acceptLoopDone && inFlight.size === 0 && finishResolve) finishResolve();
  }
  function _driverOptions() {
    return {
      maxConcurrent: 32,
      allowH2cUpgrade: options.allowH2cUpgrade,
      headersTimeoutMs: options.headersTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs
    };
  }
  function _handlerFor(protocol: HttpProtocol, transport: HttpTransport, addresses?: {
    localAddress?: unknown;
    remoteAddress?: unknown;
    tls?: TlsPeerInfo | null;
  }): ServerHandler {
    return _makeAcceptAdapter(handler, protocol, transport, addresses);
  }
  function _webTransportHandlerFor(protocol: HttpProtocol, transport: HttpTransport, addresses?: {
    localAddress?: unknown;
    remoteAddress?: unknown;
    tls?: TlsPeerInfo | null;
  }): H3WebTransportHandler {
    return _makeWebTransportAcceptAdapter(handler, protocol, transport, addresses);
  }
  const h3Options = options.h3;
  let h3Server: H3Server | null = null;
  const h3ClientAuth = options.tls?.clientAuth ?? 'none';
  const h3TlsOptions = h3ClientAuth !== 'none' ? {
    clientAuth: h3ClientAuth,
    ca: _quicCaFromTls(options.tls?.ca),
    rejectUnauthorized: options.tls?.rejectUnauthorized
  } : {};
  const h3Ready: Promise<void> = h3Options !== undefined && h3Options !== false ? serveH3({
    ...(typeof h3Options === 'object' ? h3Options.quic : undefined) ?? {},
    ...h3TlsOptions,
    port: boundAddress.port,
    hostname: boundAddress.ip,
    certificateFile: options.tls!.cert,
    privateKeyFile: options.tls!.key
  }, _handlerFor('h3', 'quic') as any, { onWebTransport: _webTransportHandlerFor('h3', 'quic') }).then((server) => {
    h3Server = server;
  }) : Promise.resolve();
  h3Ready.catch(() => {
    if (closeSignalResolve) closeSignalResolve();
    tcpServer.close();
  });
  (async function acceptLoop() {
    try {
      while (true) {
        const tcpConn: Awaited<ReturnType<typeof tcpServer.accept>> | null = await Promise.race([tcpServer.accept(), closeSignal]);
        if (tcpConn === null || tcpConn === undefined) break;
        let connPromise: Promise<void>;
        if (sslCtx !== null) {
          connPromise = TlsSocket.accept(tcpConn.fd, sslCtx).then(async function handleTlsConn(tlsConn) {
            const proto = tlsConn.negotiatedProtocol;
            const tls = tlsConn.getPeerInfo();
            if (options.tls?.clientAuth === 'require' && tls.peerCertificate === null) {
              tlsConn.close();
              return;
            }
            const [reader, writer] = tlsConn.split();
            try {
              if (h2Available && proto === 'h2') {
                await _h2Driver.run(reader, writer, _handlerFor('h2', 'tls', {
                  localAddress: tcpConn.localAddress,
                  remoteAddress: tcpConn.remoteAddress,
                  tls
                }), { maxConcurrent: 32 });
              } else {
                await _h1Driver.run(reader, writer, _handlerFor('http/1.1', 'tls', {
                  localAddress: tcpConn.localAddress,
                  remoteAddress: tcpConn.remoteAddress,
                  tls
                }), _driverOptions());
              }
            } catch {
              try {
                await reader.close();
              } catch {}
              try {
                await writer.close();
              } catch {}
            }
          }, function tlsHandshakeError(_err: unknown) {
            tcpConn.close();
          });
        } else {
          connPromise = (async function handleConn() {
            const [reader, writer] = tcpConn.split();
            if (h2Available) {
              const preface = await reader.peek(24);
              if (_isH2Preface(preface)) {
                await _h2Driver.run(reader, writer, _handlerFor('h2', 'tcp', {
                  localAddress: tcpConn.localAddress,
                  remoteAddress: tcpConn.remoteAddress
                }), { maxConcurrent: 32 });
                return;
              }
            }
            await _h1Driver.run(reader, writer, _handlerFor('http/1.1', 'tcp', {
              localAddress: tcpConn.localAddress,
              remoteAddress: tcpConn.remoteAddress
            }), _driverOptions());
          })();
        }
        inFlight.add(connPromise);
        connPromise.finally(function cleanupConnection() {
          inFlight.delete(connPromise);
          _checkDone();
        });
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
    get port() {
      return boundAddress.port;
    },
    get ready() {
      return h3Ready;
    },
    async close(): Promise<void> {
      if (closeSignalResolve) closeSignalResolve();
      tcpServer.close();
      for (const callback of tlsCallbacks) {
        try {
          (callback as { close?: () => void }).close?.();
        } catch {}
      }
      tlsCallbacks = [];
      if (sslCtx !== null) {
        sslCtxFree(sslCtx);
        sslCtx = null;
      }
      await h3Ready.catch(() => {});
      await h3Server?.close();
      await finished;
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close();
    }
  };
}
export function serveHttp(options: ServeOptions, handler: HttpRequestHandler): ServeServer {
  return serve(options, async (incoming) => {
    if (incoming.kind !== 'request') {
      await incoming.reject();
      return;
    }
    const accepted = await incoming.accept();
    await accepted.respond(await handler(accepted.request, accepted.session));
  });
}
