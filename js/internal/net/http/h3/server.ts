/**
 * internal:net/http/h3/server — HTTP/3 server driver over QUIC.
 *
 * This module turns a single established `QuicConnection` into an HTTP/3
 * request/response pump. It drives an `Nghttp3Session` in server mode: nghttp3
 * raises stream callbacks (begin headers, receive header, end headers, data,
 * trailers, stream close/reset), and the driver reassembles each request stream
 * into a Fetch-compatible `Request`, invokes the configured handler, and
 * serializes the returned `Response` — status, header fields, body, and
 * trailers — back over the QUIC stream via `session.submitResponse`.
 *
 * One `H3ServerDriver` instance handles one connection. The transport-level
 * server (`fino:net/http/h3`'s `serve()`) constructs a fresh driver per accepted
 * connection and calls `run()`, so this layer never touches listeners, TLS, or
 * ALPN — it assumes a connection whose ALPN already negotiated `h3`.
 *
 * Request validation follows RFC 9114 strictly: pseudo-headers must precede
 * regular fields, may not repeat, and must be a recognized set; regular field
 * names must be lowercase; connection-specific fields (`connection`,
 * `keep-alive`, `transfer-encoding`, `upgrade`, `proxy-connection`) are
 * rejected. A malformed control block yields a `400` without ever reaching the
 * handler. Bodies stream through an `H3BodyQueue` so the handler can consume the
 * request body incrementally while later frames are still arriving.
 *
 * Beyond plain request/response, the driver understands the `CONNECT` +
 * `:protocol: webtransport-h3` extended-CONNECT handshake. When an
 * `onWebTransport` option is supplied and peer SETTINGS confirm WebTransport
 * support, a matching CONNECT stream is surfaced to the handler as a
 * `WebTransport` session; incoming client-initiated QUIC streams are then routed
 * to the session by inspecting each stream's WebTransport frame prefix rather
 * than feeding it to nghttp3.
 *
 * This is an internal driver — application code should start an HTTP/3 server
 * through `fino:net/http/h3`'s `serve()` or the general `serve()` in
 * `fino:net/http`, both of which own the listener and wire drivers up for you.
 *
 * ```ts no_run
 * import { H3ServerDriver } from 'internal:net/http/h3/server';
 * import type { QuicConnection } from 'fino:net/quic';
 *
 * async function handleConnection(conn: QuicConnection) {
 *   const driver = new H3ServerDriver();
 *   await driver.run(conn, (request) => {
 *     return new Response(`Hello over ${request.url}`, {
 *       headers: { 'content-type': 'text/plain' },
 *     });
 *   });
 * }
 * ```
 *
 * Learn more:
 * - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 * - WebTransport over HTTP/3: https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
 *
 * @internal
 */
import { Nghttp3Session } from './session.ts';
import type { H3SessionCallbacks } from './session.ts';
import { H3BodyQueue } from './body-queue.ts';
import { h3Available } from './bindings.ts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';
import {
  WebTransport,
  _acceptIncomingQuicWebTransportStream,
  _fromHttp3WebTransport,
} from '../../../../net/http/webtransport.ts';
import { buildWireRequest } from '../../../../net/http/index.ts';
import { quicIncomingStreamHook } from '../../quic/endpoint.ts';
import { inspectWebTransportStreamPrefix } from './webtransport.ts';
/**
 * Request handler for an HTTP/3 server.
 *
 * Receives the reassembled request as a Fetch `Request` and returns the
 * `Response` to serialize back over the QUIC stream, either synchronously or as
 * a promise. If the handler throws, or returns a value that is not a `Response`,
 * the driver replies with `500 Internal Server Error` rather than tearing down
 * the connection, so a single failing request cannot take down the whole
 * session.
 */
export type H3Handler = (request: Request) => Response | Promise<Response>;
/**
 * Handler for extended-CONNECT WebTransport sessions over HTTP/3.
 *
 * Invoked when a client opens a `CONNECT` stream carrying
 * `:protocol: webtransport-h3` and the driver was configured with an
 * `onWebTransport` option. The first argument is the CONNECT request (its method
 * is normalized to `GET` for the handler's convenience, with the original
 * CONNECT method and protocol preserved on the request object); the second is a
 * live `WebTransport` session bound to the CONNECT stream.
 *
 * Return the `WebTransport` to accept the session — the driver responds `200`,
 * keeps the CONNECT stream open, and routes subsequent client streams to the
 * session. Return a `Response` instead to reject the upgrade with that status.
 */
export type H3WebTransportHandler = (
  request: Request,
  session: WebTransport,
) => WebTransport | Response | Promise<WebTransport | Response>;
/**
 * Options controlling optional HTTP/3 driver capabilities.
 *
 * Passed as the third argument to `H3ServerDriver.run`. With no options the
 * driver serves ordinary request/response traffic only; extended-CONNECT
 * upgrades are enabled by supplying handlers here.
 *
 * ```ts no_run
 * import { H3ServerDriver } from 'internal:net/http/h3/server';
 * import type { QuicConnection } from 'fino:net/quic';
 *
 * async function serve(conn: QuicConnection) {
 *   const driver = new H3ServerDriver();
 *   await driver.run(
 *     conn,
 *     () => new Response('ok'),
 *     {
 *       onWebTransport(request, session) {
 *         console.log('WebTransport session for', request.url);
 *         return session; // accept
 *       },
 *     },
 *   );
 * }
 * ```
 */
export interface H3ServerDriverOptions {
  /**
   * Handler invoked for `webtransport-h3` extended-CONNECT streams.
   *
   * When omitted, WebTransport CONNECT requests are rejected with `501`. When
   * present but the peer's SETTINGS do not advertise WebTransport support, the
   * driver replies `400` before calling the handler.
   */
  onWebTransport?: H3WebTransportHandler;
}
const _FORBIDDEN_RESP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);
const _FORBIDDEN_REQ = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);
const _PSEUDO_AUTHORITY = 1 << 0;
const _PSEUDO_METHOD = 1 << 1;
const _PSEUDO_PATH = 1 << 2;
const _PSEUDO_SCHEME = 1 << 3;
const _PSEUDO_PROTOCOL = 1 << 4;
interface H3ServerStream {
  streamId: bigint;
  method: string;
  path: string;
  scheme: string;
  authority: string;
  protocol: string;
  headers: Array<[string, string]>;
  trailerHeaders: Array<[string, string]>;
  inTrailers: boolean;
  body: H3BodyQueue;
  bodyDone: boolean;
  cancelled: boolean;
  badRequest: boolean;
  dispatched: boolean;
  dispatchDone: boolean;
  seenPseudos: number;
  seenRegular: boolean;
}
function pseudoHeaderBit(token: number, name: string): number {
  switch (token) {
    case 0:
      return _PSEUDO_AUTHORITY;
    case 1:
      return _PSEUDO_METHOD;
    case 8:
      return _PSEUDO_PATH;
    case 9:
      return _PSEUDO_SCHEME;
    case 1007:
      return _PSEUDO_PROTOCOL;
    default:
      if (name === ':authority') return _PSEUDO_AUTHORITY;
      if (name === ':method') return _PSEUDO_METHOD;
      if (name === ':path') return _PSEUDO_PATH;
      if (name === ':scheme') return _PSEUDO_SCHEME;
      if (name === ':protocol') return _PSEUDO_PROTOCOL;
      return 0;
  }
}
function makeStream(streamId: bigint): H3ServerStream {
  return {
    streamId,
    method: '',
    path: '',
    scheme: '',
    authority: '',
    protocol: '',
    headers: [],
    trailerHeaders: [],
    inTrailers: false,
    body: new H3BodyQueue(),
    bodyDone: false,
    cancelled: false,
    badRequest: false,
    dispatched: false,
    dispatchDone: false,
    seenPseudos: 0,
    seenRegular: false,
  };
}
function hasInvalidRequestControlData(st: H3ServerStream): boolean {
  if (st.method !== 'CONNECT' && (!st.method || !st.scheme || !st.path)) return true;
  if (st.protocol && st.method !== 'CONNECT') return true;
  return false;
}
function trustedHeaders(headers: Array<[string, string]>, authority: string): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (authority && name === 'host') continue;
    out._appendTrusted(name, value);
  }
  if (authority) out._appendTrusted('host', authority);
  return out;
}
/**
 * Drives HTTP/3 request/response exchange over one QUIC connection.
 *
 * A driver instance is single-use and connection-scoped: create one, call
 * `run()`, and let it live for the duration of the connection. It has no
 * configuration state of its own — everything is passed to `run()` — so the
 * class exists mainly to give the connection pump a stable identity that
 * `serve()` can spawn per connection.
 *
 * ```ts no_run
 * import { H3ServerDriver } from 'internal:net/http/h3/server';
 * import type { QuicConnection } from 'fino:net/quic';
 *
 * function onNewConnection(conn: QuicConnection) {
 *   const driver = new H3ServerDriver();
 *   // run() resolves when the connection closes; failures are swallowed so one
 *   // bad connection cannot crash the accept loop.
 *   void driver.run(conn, (request) => Response.json({ path: new URL(request.url).pathname }))
 *     .catch(() => {});
 * }
 * ```
 */
export class H3ServerDriver {
  /**
   * Serve HTTP/3 requests on `conn` until the connection closes.
   *
   * Opens the three mandatory local unidirectional streams (control plus the two
   * QPACK encoder/decoder streams), installs an incoming-stream hook that feeds
   * client request streams into the nghttp3 session, and dispatches each complete
   * request to `handler`. The returned promise resolves once the QUIC connection
   * closes and all in-flight request dispatches have finished; the session is
   * always drained to idle in a `finally` block, even on early return.
   *
   * Handler results are serialized with connection-specific header fields
   * stripped, response bodies extracted from the `Response`, and any declared
   * response trailers appended. `HEAD` requests suppress the response body; a
   * handler that throws or returns a non-`Response` yields a `500`.
   *
   * If `options.onWebTransport` is set, `CONNECT` streams negotiating
   * `webtransport-h3` are handed to that handler and — when accepted — the
   * connection switches to routing raw client streams to WebTransport sessions by
   * their frame prefix. Without the option such requests are answered `501`, and
   * plain `CONNECT` requests always receive `405`.
   *
   * Throws immediately if libnghttp3 is not available in this build. Per-request
   * handler errors do not propagate out of `run()`; they are converted into `500`
   * responses so the connection keeps serving other streams.
   *
   * ```ts no_run
   * import { H3ServerDriver } from 'internal:net/http/h3/server';
   * import type { QuicConnection } from 'fino:net/quic';
   *
   * async function serveConnection(conn: QuicConnection) {
   *   const driver = new H3ServerDriver();
   *   await driver.run(conn, async (request) => {
   *     if (request.method === 'POST') {
   *       const body = await request.text();
   *       return new Response(`echo: ${body}`);
   *     }
   *     return new Response('hello');
   *   });
   * }
   * ```
   */
  async run(
    conn: QuicConnection,
    handler: H3Handler,
    options: H3ServerDriverOptions = {},
  ): Promise<void> {
    if (!h3Available) throw new Error('libnghttp3 is not available');
    const streams = new Map<bigint, H3ServerStream>();
    const webTransports = new Map<bigint, WebTransport>();
    const inFlight = new Set<Promise<void>>();
    let resolvePeerSettingsReceived: (() => void) | null = null;
    const peerSettingsReceived = new Promise<void>((resolve) => {
      resolvePeerSettingsReceived = resolve;
    });
    let session: Nghttp3Session;
    const callbacks: H3SessionCallbacks = {
      onBeginHeaders(streamId) {
        if (!streams.has(streamId)) streams.set(streamId, makeStream(streamId));
      },
      onRecvHeader(streamId, token, name, value) {
        const st = streams.get(streamId);
        if (!st || st.cancelled) return;
        if (st.inTrailers) {
          if (!name.startsWith(':')) st.trailerHeaders.push([name, value]);
          return;
        }
        if (name.startsWith(':')) {
          const pseudo = pseudoHeaderBit(token, name);
          if (pseudo === 0 || st.seenRegular || (st.seenPseudos & pseudo) !== 0) {
            st.cancelled = true;
            st.badRequest = true;
            return;
          }
          st.seenPseudos |= pseudo;
          if (pseudo === _PSEUDO_METHOD) st.method = value;
          else if (pseudo === _PSEUDO_PATH) st.path = value;
          else if (pseudo === _PSEUDO_SCHEME) st.scheme = value;
          else if (pseudo === _PSEUDO_AUTHORITY) st.authority = value;
          else st.protocol = value;
        } else {
          const lc = name.toLowerCase();
          if (lc !== name) {
            st.cancelled = true;
            st.badRequest = true;
            return;
          }
          if (_FORBIDDEN_REQ.has(lc)) {
            st.cancelled = true;
            st.badRequest = true;
            return;
          }
          if (lc === 'te') return;
          st.seenRegular = true;
          st.headers.push([name, value]);
        }
      },
      onEndHeaders(streamId, fin) {
        const st = streams.get(streamId);
        if (!st) return;
        if (st.badRequest) {
          st.bodyDone = true;
          startDispatch(st);
          return;
        }
        if (hasInvalidRequestControlData(st)) {
          st.badRequest = true;
          st.bodyDone = true;
          st.body.close();
          startDispatch(st);
          return;
        }
        const noBody =
          fin || st.method === 'GET' || st.method === 'HEAD' || st.method === 'CONNECT';
        if (noBody) {
          st.bodyDone = true;
          st.body.close();
        }
        if (noBody) startDispatch(st);
        else startDispatch(st);
      },
      onBeginTrailers(streamId) {
        const st = streams.get(streamId);
        if (st) st.inTrailers = true;
      },
      onRecvTrailer(streamId, _token, name, value) {
        const st = streams.get(streamId);
        if (st && !name.startsWith(':')) st.trailerHeaders.push([name, value]);
      },
      onEndTrailers(streamId) {
        const st = streams.get(streamId);
        if (!st) return;
        st.body.close();
        st.bodyDone = true;
        startDispatch(st);
      },
      onRecvData(streamId, data) {
        const st = streams.get(streamId);
        if (st && !st.cancelled) st.body.push(data);
      },
      onEndStream(streamId) {
        const st = streams.get(streamId);
        if (!st) return;
        st.bodyDone = true;
        st.body.close();
        startDispatch(st);
      },
      onStreamClose(streamId, appErrorCode) {
        const st = streams.get(streamId);
        if (st && !st.bodyDone) {
          st.body.error(new Error(`H3 stream closed with error 0x${appErrorCode.toString(16)}`));
        }
        streams.delete(streamId);
      },
      onResetStream(streamId, appErrorCode) {
        const st = streams.get(streamId);
        if (st) {
          st.cancelled = true;
          st.bodyDone = true;
          st.body.error(new Error(`H3 stream reset with error 0x${appErrorCode.toString(16)}`));
        }
      },
      onRecvSettings() {
        resolvePeerSettingsReceived?.();
        resolvePeerSettingsReceived = null;
      },
    };
    session = Nghttp3Session.createServer(callbacks, { webTransport: true });
    // Dispatch a request to the handler once headers are complete.
    function startDispatch(st: H3ServerStream): void {
      if (st.dispatched) return;
      if (st.cancelled && !st.badRequest) return;
      st.dispatched = true;
      const p: Promise<void> = dispatch(st)
        .catch(() => {})
        .then(() => {
          inFlight.delete(p);
        });
      inFlight.add(p);
    }
    function cleanupStream(st: H3ServerStream): void {
      if (streams.get(st.streamId) !== st) return;
      if (!st.bodyDone || !st.dispatchDone) return;
      st.cancelled = true;
      st.bodyDone = true;
      st.seenPseudos = 0;
      st.body.close();
      streams.delete(st.streamId);
    }
    async function dispatch(st: H3ServerStream): Promise<void> {
      if (st.badRequest) {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          session.drainWrites();
        } catch {}
        return;
      }
      if (st.cancelled) return;
      if (st.method === 'CONNECT' && st.protocol === 'webtransport-h3') {
        if (!session.peerSettingsReceived) await peerSettingsReceived;
        if (!session.peerWebTransportReady) {
          try {
            session.submitResponse(
              st.streamId,
              [
                [':status', '400'],
                ['content-type', 'text/plain'],
              ],
              new TextEncoder().encode('WebTransport over HTTP/3 requires complete peer SETTINGS'),
            );
            session.drainWrites();
          } catch {}
          return;
        }
        if (options.onWebTransport !== undefined) {
          const url = `${st.scheme || 'https'}://${st.authority || 'localhost'}${st.path || '/'}`;
          const reqHeaders = trustedHeaders(st.headers, st.authority);
          const request = new Request(url, {
            method: 'GET',
            headers: reqHeaders,
          });
          (request as any).methodOverride = 'CONNECT';
          (request as any).protocol = 'webtransport-h3';
          const wt = _fromHttp3WebTransport(url, {
            connection: conn,
            sessionStreamId: st.streamId,
            routeIncomingStreams: false,
          });
          let result: WebTransport | Response;
          try {
            result = await options.onWebTransport(request, wt);
          } catch {
            result = new Response('Internal Server Error', { status: 500 });
          }
          if (result instanceof WebTransport) {
            webTransports.set(st.streamId, result);
            result.closed.finally(() => webTransports.delete(st.streamId)).catch(() => {});
            session.submitResponse(st.streamId, [[':status', '200']], keepConnectOpenBody());
            session.drainWrites();
            return;
          }
          session.submitResponse(
            st.streamId,
            [[':status', String(result.status)]],
            (result as any)._extractBytes?.() ?? (result.body as any) ?? undefined,
          );
          session.drainWrites();
          return;
        }
        try {
          session.submitResponse(
            st.streamId,
            [
              [':status', '501'],
              ['content-type', 'text/plain'],
            ],
            new TextEncoder().encode('WebTransport over HTTP/3 is not available yet'),
          );
          session.drainWrites();
        } catch {}
        return;
      }
      if (st.method === 'CONNECT') {
        try {
          session.submitResponse(st.streamId, [
            [':status', '405'],
            ['allow', 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH'],
          ]);
          session.drainWrites();
        } catch {}
        return;
      }
      if (!st.method || !st.path) {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          session.drainWrites();
        } catch {}
        return;
      }
      const url = `${st.scheme || 'https'}://${st.authority || 'localhost'}${st.path}`;
      const reqHeaders = trustedHeaders(st.headers, st.authority);
      let req: Request;
      try {
        const body = st.method === 'GET' || st.method === 'HEAD' ? null : st.body;
        req = buildWireRequest({
          version: 'HTTP/3',
          method: st.method,
          url,
          path: st.path,
          headers: reqHeaders,
          body: body as any,
        });
      } catch {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          session.drainWrites();
        } catch {}
        return;
      }
      (req as any).trailerHeaders = st.trailerHeaders;
      let response: Response;
      try {
        const result = await handler(req);
        if (!(result instanceof Response)) throw new TypeError('handler did not return a Response');
        response = result;
      } catch {
        response = new Response('Internal Server Error', { status: 500 });
      }
      if (st.cancelled) return;
      const respHeaders: Array<[string, string]> = [[':status', String(response.status)]];
      response.headers.forEach((value, name) => {
        const lc = name.toLowerCase();
        if (!_FORBIDDEN_RESP.has(lc)) respHeaders.push([lc, value]);
      });
      if (st.cancelled) return;
      let respTrailers: Array<[string, string]> | undefined;
      if ((response as any)._hasOutTrailers?.()) {
        const raw = (response as any)._getRawOutTrailers();
        let trailersOut: Headers;
        if (raw instanceof Headers) {
          trailersOut = raw;
        } else if (typeof raw === 'function') {
          try {
            trailersOut = await (raw as () => Headers | Promise<Headers>)();
          } catch {
            trailersOut = new Headers();
          }
        } else {
          trailersOut = new Headers();
        }
        const trailerList: Array<[string, string]> = [];
        for (const [k, v] of trailersOut.entries()) {
          const lc = k.toLowerCase();
          if (!_FORBIDDEN_RESP.has(lc)) trailerList.push([lc, v]);
        }
        if (trailerList.length > 0) respTrailers = trailerList;
      }
      let respBody: any;
      if (st.method !== 'HEAD') {
        respBody = (response as any)._extractBytes?.() ?? (response.body as any) ?? undefined;
      }
      session.submitResponse(st.streamId, respHeaders, respBody, respTrailers);
      session.drainWrites();
      st.dispatchDone = true;
      cleanupStream(st);
    }
    try {
      const connectionClosed =
        conn.state === 'closed'
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              conn.addEventListener('close', () => resolve(), { once: true });
              conn.addEventListener('error', () => resolve(), { once: true });
            });
      let resolveLocalStreamsReady!: () => void;
      const localStreamsReady = new Promise<void>((resolve) => {
        resolveLocalStreamsReady = resolve;
      });
      // Install the incoming-stream hook early so bidirectional streams from the
      // client are captured even if they arrive during local setup. The hook
      // bypasses the QuicStreamEvent/EventTarget/#streamQueue path (the driver is
      // the sole consumer of incoming streams here) and drains any streams that
      // arrived before installation.
      conn[quicIncomingStreamHook] = (stream) => {
        const sid = BigInt(stream.id);
        void (async () => {
          let first: Uint8Array | null = null;
          try {
            await localStreamsReady;
            if (webTransports.size === 0) {
              if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
              while (true) {
                const result = await stream.reader.read();
                const fin = result.done;
                session.readStream(sid, result.done ? new Uint8Array(0) : result.value, fin);
                if (fin) break;
              }
              return;
            }
            const routed = await readWebTransportPrefix(stream.reader);
            if (routed.buffer === null) {
              session.readStream(sid, new Uint8Array(0), true);
              return;
            }
            first = routed.buffer;
            if (routed.prefix?.kind === stream.direction && routed.prefix.sessionId !== undefined) {
              const wt = webTransports.get(routed.prefix.sessionId);
              if (wt !== undefined) {
                _acceptIncomingQuicWebTransportStream(wt, stream, first);
                return;
              }
            }
            if (stream.direction === 'bidirectional') {
              session.addQuicStream(sid, stream.writer);
            }
            session.readStream(sid, first, false);
            while (true) {
              const result = await stream.reader.read();
              const fin = result.done;
              session.readStream(sid, result.done ? new Uint8Array(0) : result.value, fin);
              if (fin) break;
            }
          } catch {
            const st = streams.get(sid);
            if (st && !st.cancelled) {
              st.cancelled = true;
              st.bodyDone = true;
              st.body.error(new Error('H3 stream closed: connection error'));
            }
            if (session.isClosed) {
              conn.destroy();
            } else {
              // nghttp3_conn_close_stream does not send any H3 frames. Send RESET_STREAM
              // at the QUIC level so the client's pending request rejects instead of hanging.
              try {
                stream.reset(270);
              } catch {}
            }
          }
        })();
      };
      // Open the 3 mandatory local unidirectional streams.
      const openedStreams = await Promise.race([
        Promise.all([
          conn.openUnidirectionalStream(),
          conn.openUnidirectionalStream(),
          conn.openUnidirectionalStream(),
        ]),
        connectionClosed.then(() => null),
      ]);
      if (openedStreams === null) {
        resolveLocalStreamsReady();
        return;
      }
      const [controlStream, qencStream, qdecStream] = openedStreams;
      for (const s of [controlStream, qencStream, qdecStream] as QuicStream[]) {
        session.addQuicStream(BigInt(s.id), s.writer);
      }
      session.bindControlStream(BigInt(controlStream.id));
      session.bindQpackStreams(BigInt(qencStream.id), BigInt(qdecStream.id));
      session.drainWrites();
      resolveLocalStreamsReady();
      // Wait for connection close.
      await connectionClosed;
      await Promise.all([...inFlight]);
    } finally {
      await session.closeWhenIdle();
    }
  }
}
async function* keepConnectOpenBody(): AsyncIterable<Uint8Array> {
  await new Promise<never>(() => {});
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
async function readWebTransportPrefix(reader: QuicStream['reader']): Promise<{
  buffer: Uint8Array | null;
  prefix: ReturnType<typeof inspectWebTransportStreamPrefix> | null;
}> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done)
      return {
        buffer: chunks.length === 0 ? null : concatBytes(chunks),
        prefix: null,
      };
    chunks.push(result.value);
    const buffer = concatBytes(chunks);
    const prefix = inspectWebTransportStreamPrefix(buffer);
    if (prefix.state !== 'incomplete')
      return {
        buffer,
        prefix,
      };
  }
}
