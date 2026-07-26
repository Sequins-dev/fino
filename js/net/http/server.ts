/**
 * fino:net/http/server — HTTP server with negotiated protocol dispatch.
 *
 * This module is the low-level entry point for standing up an HTTP server in
 * Fino. It binds a listening socket, terminates TLS when configured, sniffs or
 * negotiates the wire protocol per connection, and hands each request to one of
 * two handler shapes you supply. Everything above this — routing, middleware,
 * OpenAPI — lives in `fino:net/http/app`, which is built on top of `serve()`.
 *
 * There are two entry points. `serveHttp()` is the request/response
 * convenience: your handler receives a `Request` and returns a
 * `HttpHandlerResult` (a `Response`, or an upgraded `WebSocketConnection` /
 * `WebTransport`). `serve()` is the accept-based form: your handler receives an
 * `IncomingHttp` describing the connection attempt and must explicitly
 * `accept()` or `reject()` it before returning, which is what makes protocol
 * upgrades (WebSocket, WebTransport) first-class rather than bolted on. Both
 * return the same `ServeServer` handle.
 *
 * Protocol selection is automatic. `serve()` wraps `Socket.listen()` and routes
 * each accepted connection to the HTTP/1.1 driver, to the HTTP/2 driver when a
 * plaintext connection opens with the HTTP/2 client preface (prior-knowledge
 * h2c), or to the HTTP/2 driver when a TLS connection negotiates `h2` through
 * ALPN. Setting `h3` additionally opens an HTTP/3 (QUIC) listener on the same
 * host and port. The selected driver owns per-connection keep-alive, pipelining,
 * and protocol-upgrade logic.
 *
 * HTTP/1.1 connections are kept alive by default: the driver loops over requests
 * on the same TCP connection until the client sends `Connection: close`, the
 * handler returns a response carrying that header, or the connection is reset.
 * If a response includes neither `Content-Length` nor `Transfer-Encoding`, the
 * driver buffers the body eagerly and injects `Content-Length`; set one of those
 * headers yourself for a truly streaming response. If a handler throws an
 * unhandled error the driver replies with a bare `500 Internal Server Error` and
 * closes the connection, so application-level error handling is the handler's
 * responsibility.
 *
 * ```ts no_run
 * import { serveHttp } from 'fino:net/http/server';
 *
 * const server = serveHttp({ port: 3000 }, async (req) => {
 *   return new Response('hello');
 * });
 * console.log(`listening on ${server.port}`);
 *
 * // Graceful shutdown drains in-flight connections:
 * await server.close();
 * ```
 *
 * Learn more:
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 * - HTTP/1.1 messaging: https://www.rfc-editor.org/rfc/rfc9112
 * - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
 * - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
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
import { WebSocketConnection } from './websocket.ts';
import type { WebSocketAcceptOptions } from './websocket.ts';
import { WebTransport } from './webtransport.ts';
import type { WebTransportOptions } from './webtransport.ts';
import type { H3WebTransportHandler } from '../../internal/net/http/h3/server.ts';
import type { ConnectionTakeover, ServerHandler, ServerResult } from 'internal:net/http/driver';
import type { Request, Response } from './index.ts';
import { Response as HttpResponse } from './index.ts';
import type { Address, ListenOptions } from '../socket.ts';
// H2 client preface: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
const _H2_PREFACE = new Uint8Array([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
]);
function _isH2Preface(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  for (let i = 0; i < 24; i++) {
    if (bytes[i] !== _H2_PREFACE[i]) return false;
  }
  return true;
}
/**
 * Wire protocol negotiated for a connection.
 *
 * `'http/1.1'` covers both plain TCP and TLS connections that did not negotiate
 * a newer protocol, `'h2'` is HTTP/2 (via the plaintext preface or ALPN), and
 * `'h3'` is HTTP/3 over QUIC. The value is surfaced on `HttpSession.protocol`
 * and on each `IncomingHttp`, so a handler can branch on it without inspecting
 * the transport directly.
 */
export type HttpProtocol = 'http/1.1' | 'h2' | 'h3';
/**
 * Configuration for `serve()` and `serveHttp()`.
 *
 * Only `port` is required. Leaving `hostname` unset binds all interfaces
 * (`0.0.0.0` for IPv4, `::` for explicit IPv6), and `port: 0` requests an
 * ephemeral port whose value you read back from `ServeServer.port`. Supplying
 * `tls` upgrades the listener to HTTPS and, when libnghttp2 is available,
 * advertises HTTP/2 through ALPN. Supplying `h3` additionally opens an HTTP/3
 * listener on the same address and requires `tls`.
 *
 * ```ts no_run
 * import { serveHttp } from 'fino:net/http/server';
 *
 * const server = serveHttp({
 *   port: 8443,
 *   hostname: '127.0.0.1',
 *   tls: { cert: '/etc/tls/cert.pem', key: '/etc/tls/key.pem' },
 *   h3: true,
 *   idleTimeoutMs: 30_000,
 * }, async () => new Response('ok'));
 * await server.ready;
 * ```
 */
export interface ServeOptions {
  /** TCP/UDP port to bind. Use `0` to request an ephemeral port. */
  port: number;
  /** Host or interface to bind. Defaults to all interfaces (`0.0.0.0` / `::`). */
  hostname?: string;
  /** Explicit IP family for the listening socket. Defaults from hostname. */
  family?: 'ipv4' | 'ipv6';
  /** Listen backlog passed through to Socket.listen(). */
  backlog?: number;
  /** Set SO_REUSEADDR before bind. Defaults to Socket.listen() behavior. */
  reuseAddr?: boolean;
  /** Set SO_REUSEPORT before bind where supported. */
  reusePort?: boolean;
  /** Enable TLS. Presence upgrades the listener to HTTPS and enables ALPN-negotiated HTTP/2. */
  tls?: {
    /** Filesystem path to the PEM-encoded server certificate (chain). */
    cert: string;
    /** Filesystem path to the PEM-encoded private key for `cert`. */
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
  h3?:
    | boolean
    | {
        quic?: Partial<
          Omit<H3ServeOptions, 'port' | 'hostname' | 'certificateFile' | 'privateKeyFile'>
        >;
      };
}
/**
 * Handle to a running server returned by `serve()` and `serveHttp()`.
 *
 * The server begins accepting connections immediately and keeps the event loop
 * alive until it is closed. It implements `Symbol.asyncDispose`, so an
 * `await using` binding closes it automatically when the scope exits.
 *
 * ```ts no_run
 * import { serveHttp } from 'fino:net/http/server';
 *
 * await using server = serveHttp({ port: 0 }, async () => new Response('hi'));
 * console.log(server.address.ip, server.port);
 * await server.ready;
 * // server.close() runs at scope exit via asyncDispose
 * ```
 */
export interface ServeServer {
  /** The bound socket address (IP family, IP, and actual port). */
  address: {
    family: string;
    ip: string;
    port: number;
  };
  /** The actual bound port. Read this after `port: 0` to learn the ephemeral port. */
  readonly port: number;
  /** Resolves when all requested listeners, including the optional HTTP/3 listener, are ready. */
  readonly ready: Promise<void>;
  /**
   * Stop accepting, close the listener, release TLS state, and resolve once
   * in-flight connections finish. Safe to call more than once.
   */
  close(): Promise<void>;
  /** Closes the server; enables `await using` disposal. */
  [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Underlying transport carrying a connection.
 *
 * `'tcp'` is plaintext TCP, `'tls'` is a TLS-terminated TCP connection, and
 * `'quic'` is the UDP/QUIC transport used by HTTP/3. `HttpSession.secure` is
 * `true` for everything except `'tcp'`.
 */
export type HttpTransport = 'tcp' | 'tls' | 'quic';
/**
 * A value a handler may return for a single request.
 *
 * Returning a `Response` sends an ordinary HTTP reply. Returning a
 * `WebSocketConnection` or `WebTransport` completes a protocol upgrade and hands
 * ownership of the connection to that object instead of writing a response body.
 */
export type HttpHandlerResult = Response | WebSocketConnection | WebTransport;
/**
 * Request/response handler for `serveHttp()`.
 *
 * Called once per request with the parsed `Request` and the connection's
 * `HttpSession`. It returns (or resolves to) a `HttpHandlerResult`. An unhandled
 * rejection is turned into a bare `500` by the driver, so catch application
 * errors and return an explicit `Response` for them.
 *
 * ```ts no_run
 * import { serveHttp, type HttpRequestHandler } from 'fino:net/http/server';
 *
 * const handler: HttpRequestHandler = async (req, session) => {
 *   return Response.json({ path: new URL(req.url).pathname, proto: session.protocol });
 * };
 * serveHttp({ port: 3000 }, handler);
 * ```
 */
export type HttpRequestHandler = (
  request: Request,
  session: HttpSession,
) => HttpHandlerResult | Promise<HttpHandlerResult>;
/**
 * Per-connection metadata shared by every request on that connection.
 *
 * A session is created when a connection is dispatched and is passed to the
 * handler alongside each request. For accepted requests the same session object
 * is reachable through `AcceptedHttpRequest.session`, so all requests
 * multiplexed over one HTTP/2 or HTTP/3 connection observe an identical session.
 *
 * ```ts no_run
 * import { serveHttp } from 'fino:net/http/server';
 *
 * serveHttp({ port: 3000 }, async (_req, session) => {
 *   const who = session.tls?.peerCertificate ? 'mTLS client' : 'anonymous';
 *   return new Response(`${session.protocol} over ${session.transport} (${who})`);
 * });
 * ```
 */
export interface HttpSession {
  /** Process-unique identifier for this connection, e.g. `http-session-7`. */
  readonly id: string;
  /** Negotiated wire protocol for the connection. */
  readonly protocol: HttpProtocol;
  /** Underlying transport carrying the connection. */
  readonly transport: HttpTransport;
  /** `true` for TLS and QUIC connections, `false` for plaintext TCP. */
  readonly secure: boolean;
  /** Local socket address the connection was accepted on, or `null` if unavailable. */
  readonly localAddress: unknown | null;
  /** Remote peer's socket address, or `null` if unavailable. */
  readonly remoteAddress: unknown | null;
  /** TLS peer metadata for secure transports, or `null` for plain TCP. */
  readonly tls: TlsPeerInfo | null;
  /** Resolves when the connection is closed. */
  readonly closed: Promise<void>;
}
/**
 * TLS peer information exposed on `HttpSession.tls`.
 *
 * This is an alias for the `TlsPeerInfo` produced by `fino:net/tls`, re-exported
 * here so consumers of the server API can name the type without importing the
 * TLS module directly. It carries details such as the negotiated protocol and,
 * under client-certificate authentication, the peer certificate.
 */
export type HttpTlsPeerInfo = TlsPeerInfo;
/**
 * Fields shared by every kind of incoming connection attempt.
 *
 * Each variant of `IncomingHttp` extends this base, discriminated by `kind`. An
 * incoming must be resolved exactly once — either by calling the variant's
 * `accept()` or by calling `reject()` — before the handler returns.
 */
export interface IncomingBase<TKind extends string> {
  /** Discriminant identifying the variant: `'request'`, `'websocket'`, or `'webtransport'`. */
  readonly kind: TKind;
  /** The parsed request that opened this connection attempt. */
  readonly request: Request;
  /** Negotiated wire protocol for the connection. */
  readonly protocol: HttpProtocol;
  /** Metadata for the connection this request arrived on. */
  readonly session: HttpSession;
  /** TLS peer metadata for secure transports, or `null` for plain TCP. */
  readonly tls: TlsPeerInfo | null;
  /**
   * Decline the connection attempt. With no argument a default response is sent
   * (`404` for requests, `400` for WebSocket upgrades); pass a `Response` to
   * control the reply. Throws if the incoming was already accepted or rejected.
   */
  reject(response?: Response): Promise<void>;
}
/**
 * A plain HTTP request awaiting a decision in a `serve()` handler.
 *
 * Call `accept()` to obtain an `AcceptedHttpRequest` you then `respond()` on, or
 * `reject()` to decline. This is the `kind === 'request'` variant of
 * `IncomingHttp` and is the common case for ordinary GET/POST traffic.
 *
 * ```ts no_run
 * import { serve } from 'fino:net/http/server';
 *
 * serve({ port: 3000 }, async (incoming) => {
 *   if (incoming.kind !== 'request') return incoming.reject();
 *   const accepted = await incoming.accept();
 *   await accepted.respond(new Response('hello'));
 * });
 * ```
 */
export interface IncomingHttpRequest extends IncomingBase<'request'> {
  /**
   * Accept the request, yielding a handle on which exactly one `respond()` must
   * be called. Throws if the incoming was already accepted or rejected.
   */
  accept(): Promise<AcceptedHttpRequest>;
}
/**
 * An accepted plain request, obtained from `IncomingHttpRequest.accept()`.
 *
 * Call `respond()` exactly once with the reply. The `session` here is the same
 * object passed to the handler, so metadata observed during acceptance stays
 * consistent through the response.
 *
 * ```ts no_run
 * import { serve } from 'fino:net/http/server';
 *
 * serve({ port: 3000 }, async (incoming) => {
 *   if (incoming.kind !== 'request') return incoming.reject();
 *   const accepted = await incoming.accept();
 *   await accepted.respond(Response.json({ ok: true, proto: accepted.protocol }));
 * });
 * ```
 */
export interface AcceptedHttpRequest {
  /** Always `'request'`; identifies this as an accepted plain request. */
  readonly kind: 'request';
  /** The request that was accepted. */
  readonly request: Request;
  /** Negotiated wire protocol for the connection. */
  readonly protocol: HttpProtocol;
  /** The connection's session; identical to the one handed to the handler. */
  readonly session: HttpSession;
  /**
   * Send the reply for this request. Must be called exactly once; throws if
   * called again.
   */
  respond(response: HttpHandlerResult): Promise<void>;
}
/**
 * A WebSocket upgrade request awaiting a decision in a `serve()` handler.
 *
 * Produced for HTTP/1.1 requests carrying `Upgrade: websocket`. Call `accept()`
 * to complete the handshake and obtain a `WebSocketConnection`, or `reject()` to
 * refuse (default `400`). This is the `kind === 'websocket'` variant.
 *
 * ```ts no_run
 * import { serve } from 'fino:net/http/server';
 *
 * serve({ port: 3000 }, async (incoming) => {
 *   if (incoming.kind !== 'websocket') return incoming.reject();
 *   const ws = await incoming.accept({ protocol: incoming.subprotocols[0] });
 *   ws.send('welcome');
 * });
 * ```
 */
export interface IncomingWebSocketRequest extends IncomingBase<'websocket'> {
  /** Subprotocol tokens the client offered via `Sec-WebSocket-Protocol`. */
  readonly subprotocols: readonly string[];
  /**
   * Complete the WebSocket handshake and take over the connection. `options` can
   * pick a negotiated subprotocol. Throws if already accepted or rejected.
   */
  accept(options?: WebSocketAcceptOptions): Promise<WebSocketConnection>;
}
/**
 * An HTTP/3 extended-CONNECT request opening a WebTransport session, awaiting a
 * decision in a `serve()` handler.
 *
 * Produced only for HTTP/3 connections. Call `accept()` to establish the
 * session and take over the request stream, or `reject()` to refuse. This is the
 * `kind === 'webtransport'` variant.
 *
 * ```ts no_run
 * import { serve } from 'fino:net/http/server';
 *
 * serve({ port: 8443, tls: { cert: 'c.pem', key: 'k.pem' }, h3: true }, async (incoming) => {
 *   if (incoming.kind !== 'webtransport') return incoming.reject();
 *   const wt = await incoming.accept();
 *   const stream = await wt.createBidirectionalStream();
 *   void stream;
 * });
 * ```
 */
export interface IncomingWebTransportRequest extends IncomingBase<'webtransport'> {
  /** Application protocol tokens requested by the client. */
  readonly protocols: readonly string[];
  /** Accept the WebTransport session and take over the request stream. */
  accept(options?: WebTransportOptions): Promise<WebTransport>;
}
/**
 * The discriminated union of connection attempts delivered to a `serve()`
 * handler.
 *
 * Branch on `kind` (`'request'`, `'websocket'`, or `'webtransport'`) to narrow
 * to the concrete variant, then accept or reject it.
 */
export type IncomingHttp =
  | IncomingHttpRequest
  | IncomingWebSocketRequest
  | IncomingWebTransportRequest;
/**
 * Accept-based handler passed to `serve()`.
 *
 * Invoked once per incoming connection attempt with the `IncomingHttp` and its
 * `HttpSession`. The handler must resolve the incoming exactly once — accept and
 * respond, or reject — before it returns; failing to decide, or accepting a
 * request without responding, is turned into a `500` by the driver.
 *
 * ```ts no_run
 * import { serve, type ServerAcceptHandler } from 'fino:net/http/server';
 *
 * const onIncoming: ServerAcceptHandler = async (incoming) => {
 *   switch (incoming.kind) {
 *     case 'websocket': { const ws = await incoming.accept(); ws.send('hi'); break; }
 *     case 'webtransport': await incoming.reject(); break;
 *     default: await (await incoming.accept()).respond(new Response('ok'));
 *   }
 * };
 * serve({ port: 3000 }, onIncoming);
 * ```
 */
export type ServerAcceptHandler = (
  incoming: IncomingHttp,
  session: HttpSession,
) => void | Promise<void>;
let _sessionSeq = 0;
function _makeSession(
  protocol: HttpProtocol,
  transport: HttpTransport,
  addresses?: {
    localAddress?: unknown;
    remoteAddress?: unknown;
    tls?: TlsPeerInfo | null;
  },
): HttpSession {
  return {
    id: `http-session-${++_sessionSeq}`,
    protocol,
    transport,
    secure: transport !== 'tcp',
    localAddress: addresses?.localAddress ?? null,
    remoteAddress: addresses?.remoteAddress ?? null,
    tls: addresses?.tls ?? null,
    closed: Promise.resolve(),
  };
}
function _isWebSocketUpgradeAttempt(request: Request, protocol: HttpProtocol): boolean {
  if (protocol !== 'http/1.1') return false;
  return (request.headers.get('upgrade') ?? '').toLowerCase().trim() === 'websocket';
}
function _defaultReject(kind: IncomingHttp['kind']): Response {
  return kind === 'websocket'
    ? new HttpResponse('Bad Request', { status: 400 })
    : new HttpResponse('Not Found', { status: 404 });
}
function _makeAcceptAdapter(
  handler: ServerAcceptHandler,
  protocol: HttpProtocol,
  transport: HttpTransport,
  addresses?: {
    localAddress?: unknown;
    remoteAddress?: unknown;
  },
): ServerHandler {
  return async (request: Request): Promise<ServerResult> => {
    const session = _makeSession(protocol, transport, addresses);
    const kind = _isWebSocketUpgradeAttempt(request, protocol) ? 'websocket' : 'request';
    let decision: 'pending' | 'accepted' | 'rejected' = 'pending';
    let responded = false;
    let result: ServerResult | null = null;
    function assertPending(action: string): void {
      if (decision !== 'pending')
        throw new TypeError(`HTTP incoming already ${decision}; cannot ${action}`);
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
      },
    };
    const incoming: IncomingHttp =
      kind === 'websocket'
        ? {
            ...base,
            kind: 'websocket',
            subprotocols: _headerTokenList(request.headers.get('sec-websocket-protocol')),
            accept(options?: WebSocketAcceptOptions): Promise<WebSocketConnection> {
              assertPending('accept');
              const socket = WebSocketConnection.accept(request, options);
              decision = 'accepted';
              result = socket;
              return Promise.resolve(socket);
            },
          }
        : {
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
                },
              };
              return Promise.resolve(accepted);
            },
          };
    await handler(incoming, session);
    if (decision === 'pending') throw new Error('HTTP incoming handler did not accept or reject');
    if (decision === 'accepted' && kind === 'request' && !responded)
      throw new Error('Accepted HTTP request did not respond');
    if (result === null) throw new Error('HTTP incoming handler did not produce a response');
    return result;
  };
}
function _makeWebTransportAcceptAdapter(
  handler: ServerAcceptHandler,
  protocol: HttpProtocol,
  transport: HttpTransport,
  addresses?: {
    localAddress?: unknown;
    remoteAddress?: unknown;
  },
): H3WebTransportHandler {
  return async (request: Request, webtransport: WebTransport): Promise<WebTransport | Response> => {
    const session = _makeSession(protocol, transport, addresses);
    let decision: 'pending' | 'accepted' | 'rejected' = 'pending';
    let result: WebTransport | Response | null = null;
    function assertPending(action: string): void {
      if (decision !== 'pending')
        throw new TypeError(`HTTP incoming already ${decision}; cannot ${action}`);
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
      },
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
    port: options.port ?? 0,
  };
}
function _listenOptions(options: ServeOptions): ListenOptions {
  return {
    backlog: options.backlog,
    reuseAddr: options.reuseAddr,
    reusePort: options.reusePort,
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
    return protocol === 'http/1.1' || (protocol === 'h2' && h2Available);
  });
  const tlsContext = options.tls
    ? createTlsServerContext({
        cert: options.tls.cert,
        key: options.tls.key,
        ca: options.tls.ca,
        clientAuth: options.tls.clientAuth,
        rejectUnauthorized: options.tls.rejectUnauthorized,
        alpn: alpnProtocols,
      })
    : null;
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
      idleTimeoutMs: options.idleTimeoutMs,
    };
  }
  function _handlerFor(
    protocol: HttpProtocol,
    transport: HttpTransport,
    addresses?: {
      localAddress?: unknown;
      remoteAddress?: unknown;
      tls?: TlsPeerInfo | null;
    },
  ): ServerHandler {
    return _makeAcceptAdapter(handler, protocol, transport, addresses);
  }
  function _webTransportHandlerFor(
    protocol: HttpProtocol,
    transport: HttpTransport,
    addresses?: {
      localAddress?: unknown;
      remoteAddress?: unknown;
      tls?: TlsPeerInfo | null;
    },
  ): H3WebTransportHandler {
    return _makeWebTransportAcceptAdapter(handler, protocol, transport, addresses);
  }
  const h3Options = options.h3;
  let h3Server: H3Server | null = null;
  const h3ClientAuth = options.tls?.clientAuth ?? 'none';
  const h3TlsOptions =
    h3ClientAuth !== 'none'
      ? {
          clientAuth: h3ClientAuth,
          ca: _quicCaFromTls(options.tls?.ca),
          rejectUnauthorized: options.tls?.rejectUnauthorized,
        }
      : {};
  const h3Ready: Promise<void> =
    h3Options !== undefined && h3Options !== false
      ? serveH3(
          {
            ...((typeof h3Options === 'object' ? h3Options.quic : undefined) ?? {}),
            ...h3TlsOptions,
            port: boundAddress.port,
            hostname: boundAddress.ip,
            certificateFile: options.tls!.cert,
            privateKeyFile: options.tls!.key,
          },
          _handlerFor('h3', 'quic') as any,
          { onWebTransport: _webTransportHandlerFor('h3', 'quic') },
        ).then((server) => {
          h3Server = server;
        })
      : Promise.resolve();
  h3Ready.catch(() => {
    if (closeSignalResolve) closeSignalResolve();
    tcpServer.close();
  });
  (async function acceptLoop() {
    try {
      while (true) {
        const tcpConn: Awaited<ReturnType<typeof tcpServer.accept>> | null = await Promise.race([
          tcpServer.accept(),
          closeSignal,
        ]);
        if (tcpConn === null || tcpConn === undefined) break;
        let connPromise: Promise<void>;
        if (sslCtx !== null) {
          connPromise = TlsSocket.accept(tcpConn.fd, sslCtx).then(
            async function handleTlsConn(tlsConn) {
              const proto = tlsConn.negotiatedProtocol;
              const tls = tlsConn.getPeerInfo();
              if (options.tls?.clientAuth === 'require' && tls.peerCertificate === null) {
                tlsConn.close();
                return;
              }
              const [reader, writer] = tlsConn.split();
              try {
                if (h2Available && proto === 'h2') {
                  await _h2Driver.run(
                    reader,
                    writer,
                    _handlerFor('h2', 'tls', {
                      localAddress: tcpConn.localAddress,
                      remoteAddress: tcpConn.remoteAddress,
                      tls,
                    }),
                    { maxConcurrent: 32 },
                  );
                } else {
                  await _h1Driver.run(
                    reader,
                    writer,
                    _handlerFor('http/1.1', 'tls', {
                      localAddress: tcpConn.localAddress,
                      remoteAddress: tcpConn.remoteAddress,
                      tls,
                    }),
                    _driverOptions(),
                  );
                }
              } catch {
                try {
                  await reader.close();
                } catch {}
                try {
                  await writer.close();
                } catch {}
              }
            },
            function tlsHandshakeError(_err: unknown) {
              tcpConn.close();
            },
          );
        } else {
          connPromise = (async function handleConn() {
            const [reader, writer] = tcpConn.split();
            if (h2Available) {
              const preface = await reader.peek(24);
              if (_isH2Preface(preface)) {
                await _h2Driver.run(
                  reader,
                  writer,
                  _handlerFor('h2', 'tcp', {
                    localAddress: tcpConn.localAddress,
                    remoteAddress: tcpConn.remoteAddress,
                  }),
                  { maxConcurrent: 32 },
                );
                return;
              }
            }
            await _h1Driver.run(
              reader,
              writer,
              _handlerFor('http/1.1', 'tcp', {
                localAddress: tcpConn.localAddress,
                remoteAddress: tcpConn.remoteAddress,
              }),
              _driverOptions(),
            );
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
    },
  };
}
/**
 * Start a request/response HTTP server.
 *
 * This is the convenience wrapper over `serve()`: instead of the accept-based
 * protocol, your handler receives the parsed `Request` and the connection's
 * `HttpSession` and returns a `HttpHandlerResult`. Ordinary requests are
 * accepted and responded to automatically; anything that arrives as a WebSocket
 * or WebTransport upgrade attempt is rejected with a default response, since
 * those flows require the accept-based `serve()` API. All listener, TLS, HTTP/2,
 * and HTTP/3 options behave exactly as they do for `serve()`, and the same
 * `ServeServer` handle is returned.
 *
 * Returning a `WebSocketConnection` or `WebTransport` from the handler for a
 * request that was itself an upgrade is not possible here; use `serve()` when
 * you need to accept upgrades.
 *
 * ```ts no_run
 * import { serveHttp } from 'fino:net/http/server';
 *
 * const server = serveHttp({ port: 3000 }, async (req, session) => {
 *   const url = new URL(req.url);
 *   if (url.pathname === '/health') return new Response('ok');
 *   return Response.json({ method: req.method, protocol: session.protocol });
 * });
 * console.log(`listening on ${server.port}`);
 * await server.close();
 * ```
 */
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
