/**
* internal:net/http/h3/server - HTTP/3 server driver over QUIC.
*
* Learn more:
* - HTTP/3: https://www.rfc-editor.org/rfc/rfc9114
* - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
*
* Converts nghttp3 stream callbacks into Fetch-compatible `Request` objects,
* dispatches the configured handler, and serializes `Response` headers, body,
* and trailers back over QUIC streams.
*
* @internal
*/
import { Nghttp3Session } from './session.ts';
import type { H3SessionCallbacks } from './session.ts';
import { H3BodyQueue } from './body-queue.ts';
import { h3Available } from './bindings.ts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';
import { WebTransport } from '../../../../net/http/webtransport.ts';
import { buildWireRequest } from '../../../../net/http/index.ts';
import { inspectWebTransportStreamPrefix } from './webtransport.ts';
export type H3Handler = (request: Request) => Response | Promise<Response>;
export type H3WebTransportHandler = (request: Request, session: WebTransport) => WebTransport | Response | Promise<WebTransport | Response>;
export interface H3ServerDriverOptions {
  onWebTransport?: H3WebTransportHandler;
}
const _FORBIDDEN_RESP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade'
]);
const _FORBIDDEN_REQ = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade'
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
    case 0: return _PSEUDO_AUTHORITY;
    case 1: return _PSEUDO_METHOD;
    case 8: return _PSEUDO_PATH;
    case 9: return _PSEUDO_SCHEME;
    case 1007: return _PSEUDO_PROTOCOL;
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
    seenRegular: false
  };
}
function hasInvalidRequestControlData(st: H3ServerStream): boolean {
  if (st.method !== 'CONNECT' && (!st.method || !st.scheme || !st.path)) return true;
  if (st.protocol && st.method !== 'CONNECT') return true;
  return false;
}
export class H3ServerDriver {
  async run(conn: QuicConnection, handler: H3Handler, options: H3ServerDriverOptions = {}): Promise<void> {
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
        const noBody = fin || st.method === 'GET' || st.method === 'HEAD' || st.method === 'CONNECT';
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
      }
    };
    session = Nghttp3Session.createServer(callbacks, { webTransport: true });
    // Dispatch a request to the handler once headers are complete.
    function startDispatch(st: H3ServerStream): void {
      if (st.dispatched) return;
      if (st.cancelled && !st.badRequest) return;
      st.dispatched = true;
      const p: Promise<void> = dispatch(st).catch(() => {}).then(() => {
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
            session.submitResponse(st.streamId, [[':status', '400'], ['content-type', 'text/plain']], new TextEncoder().encode('WebTransport over HTTP/3 requires complete peer SETTINGS'));
            session.drainWrites();
          } catch {}
          return;
        }
        if (options.onWebTransport !== undefined) {
          const url = `${st.scheme || 'https'}://${st.authority || 'localhost'}${st.path || '/'}`;
          const reqHeaders = new Headers(st.headers);
          if (st.authority) reqHeaders.set('host', st.authority);
          const request = new Request(url, {
            method: 'GET',
            headers: reqHeaders
          });
          (request as any).methodOverride = 'CONNECT';
          (request as any).protocol = 'webtransport-h3';
          const wt = WebTransport._fromHttp3(url, {
            connection: conn,
            sessionStreamId: st.streamId,
            routeIncomingStreams: false
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
          session.submitResponse(st.streamId, [[':status', String(result.status)]], (result as any)._extractBytes?.() ?? result.body as any ?? undefined);
          session.drainWrites();
          return;
        }
        try {
          session.submitResponse(st.streamId, [[':status', '501'], ['content-type', 'text/plain']], new TextEncoder().encode('WebTransport over HTTP/3 is not available yet'));
          session.drainWrites();
        } catch {}
        return;
      }
      if (st.method === 'CONNECT') {
        try {
          session.submitResponse(st.streamId, [[':status', '405'], ['allow', 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH']]);
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
      const reqHeaders = new Headers(st.headers);
      if (st.authority) reqHeaders.set('host', st.authority);
      let req: Request;
      try {
        const body = st.method === 'GET' || st.method === 'HEAD' ? null : st.body;
        req = buildWireRequest({
          version: 'HTTP/3',
          method: st.method,
          url,
          headers: reqHeaders,
          body: body as any
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
        respBody = (response as any)._extractBytes?.() ?? response.body as any ?? undefined;
      }
      session.submitResponse(st.streamId, respHeaders, respBody, respTrailers);
      session.drainWrites();
      st.dispatchDone = true;
      cleanupStream(st);
    }
    try {
      // Attach stream listener early so bidirectional streams from the client
      // are captured even if they arrive during local setup.
      conn.addEventListener('stream', (event) => {
        const stream = (event as QuicStreamEvent).stream;
        const sid = BigInt(stream.id);
        void (async () => {
          let first: Uint8Array | null = null;
          try {
            if (webTransports.size === 0) {
              if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
              while (true) {
                const bytes = await stream.reader.read() as Uint8Array | null;
                const fin = bytes === null;
                session.readStream(sid, bytes ?? new Uint8Array(0), fin);
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
                (wt as any)._acceptIncomingQuicStream(stream, first);
                return;
              }
            }
            if (stream.direction === 'bidirectional') {
              session.addQuicStream(sid, stream.writer);
            }
            session.readStream(sid, first, false);
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              session.readStream(sid, bytes ?? new Uint8Array(0), fin);
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
      });
      // Open the 3 mandatory local unidirectional streams.
      const [controlStream, qencStream, qdecStream] = await Promise.all([
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream()
      ]);
      for (const s of [
        controlStream,
        qencStream,
        qdecStream
      ] as QuicStream[]) {
        session.addQuicStream(BigInt(s.id), s.writer);
      }
      session.bindControlStream(BigInt(controlStream.id));
      session.bindQpackStreams(BigInt(qencStream.id), BigInt(qdecStream.id));
      session.drainWrites();
      // Wait for connection close.
      await new Promise<void>((resolve) => {
        conn.addEventListener('close', () => resolve(), { once: true });
        conn.addEventListener('error', () => resolve(), { once: true });
      });
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
async function readWebTransportPrefix(reader: {
  read(): Promise<Uint8Array | null>;
}): Promise<{
  buffer: Uint8Array | null;
  prefix: ReturnType<typeof inspectWebTransportStreamPrefix> | null;
}> {
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk === null) return {
      buffer: chunks.length === 0 ? null : concatBytes(chunks),
      prefix: null
    };
    chunks.push(chunk);
    const buffer = concatBytes(chunks);
    const prefix = inspectWebTransportStreamPrefix(buffer);
    if (prefix.state !== 'incomplete') return {
      buffer,
      prefix
    };
  }
}
