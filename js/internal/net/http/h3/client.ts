/**
* internal:net/http/h3/client - HTTP/3 client session over QUIC.
*
* HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
*
* Owns request submission, response header/body/trailer assembly, and stream
* close/error propagation for an already-established QUIC connection. Public
* client APIs reach this through `fetch()` or `HttpClient`.
*
* @internal
*/
import { Nghttp3Session } from './session.ts';
import type { H3BodySource, H3SessionCallbacks } from './session.ts';
import { H3BodyQueue } from './body-queue.ts';
import { h3Available } from './bindings.ts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';
import { WebTransport } from '../../../../net/http/webtransport.ts';
import type { WebTransportOptions } from '../../../../net/http/webtransport.ts';
import { inspectWebTransportStreamPrefix } from './webtransport.ts';
export interface H3RequestInit extends RequestInit {
  trailers?: Array<[string, string]>;
  webTransportOptions?: WebTransportOptions;
}
interface PendingRequest {
  status: string;
  responseHeaders: Array<[string, string]>;
  body: H3BodyQueue;
  trailerHeaders: Array<[string, string]>;
  inTrailers: boolean;
  done: boolean;
  responseResolved: boolean;
  resolve: ((response: Response) => void) | null;
  reject: ((e: Error) => void) | null;
  trailers: Promise<Headers>;
  trailerResolve: ((headers: Headers) => void) | null;
  trailerReject: ((reason: unknown) => void) | null;
}
function bodySourceFromInit(url: string | URL, init?: H3RequestInit): H3BodySource | undefined {
  if (init?.body == null) return undefined;
  if (init.body instanceof Uint8Array) return init.body.byteLength > 0 ? init.body : undefined;
  if (init.body instanceof ArrayBuffer) {
    return init.body.byteLength > 0 ? new Uint8Array(init.body) : undefined;
  }
  const stream = new Request(url, init).body;
  return stream === null ? undefined : stream as any;
}
function getPseudoHeader(init: H3RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  if (headers instanceof Headers) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  }
  const value = (headers as Record<string, string>)[name];
  return value === undefined ? null : String(value);
}
export class H3ClientSession {
  #conn: QuicConnection;
  #session: Nghttp3Session;
  #pending = new Map<bigint, PendingRequest>();
  #webTransports = new Map<bigint, WebTransport>();
  #closed = false;
  #goawayLastStreamId: bigint | null = null;
  #peerSettingsReceived: Promise<void>;
  #resolvePeerSettingsReceived: (() => void) | null = null;
  private constructor(conn: QuicConnection, session: Nghttp3Session) {
    this.#conn = conn;
    this.#session = session;
    this.#peerSettingsReceived = new Promise((resolve) => {
      this.#resolvePeerSettingsReceived = resolve;
    });
  }
  static async create(conn: QuicConnection): Promise<H3ClientSession> {
    if (!h3Available) throw new Error('libnghttp3 is not available');
    let session: Nghttp3Session;
    let instance: H3ClientSession;
    const callbacks: H3SessionCallbacks = {
      onBeginHeaders(streamId) {
        const existing = instance.#pending.get(streamId);
        if (existing) {
          // 1xx interim response — reset header state but keep promise handles and body.
          existing.status = '';
          existing.responseHeaders = [];
          existing.trailerHeaders = [];
          existing.inTrailers = false;
        } else {
          instance.#pending.set(streamId, {
            status: '',
            responseHeaders: [],
            body: new H3BodyQueue(),
            trailerHeaders: [],
            inTrailers: false,
            done: false,
            responseResolved: false,
            resolve: null,
            reject: null,
            trailers: Promise.resolve(new Headers()),
            trailerResolve: null,
            trailerReject: null
          });
        }
      },
      onRecvHeader(streamId, _token, name, value) {
        const req = instance.#pending.get(streamId);
        if (!req) return;
        if (req.inTrailers) {
          req.trailerHeaders.push([name, value]);
          return;
        }
        if (name === ':status') req.status = value;
        else if (!name.startsWith(':')) req.responseHeaders.push([name, value]);
      },
      onEndHeaders(streamId, fin) {
        instance.#resolveResponse(streamId);
        if (fin) instance.#markDone(streamId);
      },
      onBeginTrailers(streamId) {
        const req = instance.#pending.get(streamId);
        if (req) req.inTrailers = true;
      },
      onRecvTrailer(streamId, _token, name, value) {
        const req = instance.#pending.get(streamId);
        if (req && !name.startsWith(':')) req.trailerHeaders.push([name, value]);
      },
      onEndTrailers(streamId) {
        instance.#markDone(streamId);
      },
      onRecvData(streamId, data) {
        const req = instance.#pending.get(streamId);
        if (req) req.body.push(data);
      },
      onEndStream(streamId) {
        instance.#markDone(streamId);
      },
      onStreamClose(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req && !req.done) {
          const error = new Error(`H3 stream closed with error 0x${appErrorCode.toString(16)}`);
          req.body.error(error);
          req.trailerReject?.(error);
          req.reject?.(error);
          instance.#pending.delete(streamId);
        }
      },
      onResetStream(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req) {
          const error = new Error(`H3 stream reset with error 0x${appErrorCode.toString(16)}`);
          req.body.error(error);
          req.trailerReject?.(error);
          req.reject?.(error);
          instance.#pending.delete(streamId);
        }
      },
      onAckedStreamData() {},
      onShutdown(lastStreamId: bigint) {
        if (instance.#goawayLastStreamId === null || lastStreamId < instance.#goawayLastStreamId) {
          instance.#goawayLastStreamId = lastStreamId;
        }
        for (const [sid, req] of instance.#pending) {
          if (sid > lastStreamId) {
            if (!req.done) {
              req.done = true;
              const error = new Error(`H3 stream rejected: server GOAWAY (last accepted: ${lastStreamId})`);
              req.body.error(error);
              req.trailerReject?.(error);
              req.reject?.(error);
            }
            instance.#pending.delete(sid);
          }
        }
      },
      onRecvSettings() {
        instance.#markPeerSettingsReceived();
      }
    };
    session = Nghttp3Session.createClient(callbacks, { webTransport: true });
    instance = new H3ClientSession(conn, session);
    conn.addEventListener('close', () => {
      for (const [, req] of instance.#pending) {
        if (!req.done) {
          req.done = true;
          const error = new Error('H3 stream closed: connection closed');
          req.body.error(error);
          req.trailerReject?.(error);
          req.reject?.(error);
        }
      }
      instance.#pending.clear();
      void instance.#session.closeWhenIdle();
    }, { once: true });
    // Attach stream listener early so remote control/QPACK and WebTransport
    // streams are captured as soon as they arrive.
    conn.addEventListener('stream', (event) => {
      const stream = (event as QuicStreamEvent).stream;
      const sid = BigInt(stream.id);
      void (async () => {
        try {
          if (instance.#webTransports.size === 0) {
            if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await session.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
            return;
          }
          const routed = await readWebTransportPrefix(stream.reader);
          if (routed.buffer === null) {
            await session.readStream(sid, new Uint8Array(0), true);
            return;
          }
          if (routed.prefix?.kind === stream.direction && routed.prefix.sessionId !== undefined) {
            const wt = instance.#webTransports.get(routed.prefix.sessionId);
            if (wt !== undefined) {
              (wt as any)._acceptIncomingQuicStream(stream, routed.buffer);
              return;
            }
          }
          if (stream.direction === 'bidirectional') session.addQuicStream(sid, stream.writer);
          await session.readStream(sid, routed.buffer, false);
          while (true) {
            const bytes = await stream.reader.read() as Uint8Array | null;
            const fin = bytes === null;
            await session.readStream(sid, bytes ?? new Uint8Array(0), fin);
            if (fin) break;
          }
        } catch {}
      })();
    });
    // Bind the 3 mandatory local unidirectional streams.
    try {
      const [controlStream, qencStream, qdecStream] = await Promise.all([
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream()
      ]) as QuicStream[];
      for (const s of [
        controlStream,
        qencStream,
        qdecStream
      ]) {
        session.addQuicStream(BigInt(s.id), s.writer);
      }
      session.bindControlStream(BigInt(controlStream.id));
      session.bindQpackStreams(BigInt(qencStream.id), BigInt(qdecStream.id));
      await session.drainWrites();
    } catch (e) {
      session.close();
      throw e;
    }
    return instance;
  }
  async request(url: string | URL, init?: H3RequestInit): Promise<Response> {
    if (this.#closed) throw new Error('H3 session is closed');
    if (this.#goawayLastStreamId !== null) {
      throw new Error(`H3 stream rejected: server GOAWAY (last accepted: ${this.#goawayLastStreamId})`);
    }
    const parsed = typeof url === 'string' ? new URL(url) : url;
    const method = init?.method ?? 'GET';
    const authority = getPseudoHeader(init, ':authority') ?? parsed.host;
    const reqHeaders: Array<[string, string]> = [
      [':method', method],
      [':path', parsed.pathname + parsed.search],
      [':scheme', parsed.protocol.replace(':', '')],
      [':authority', authority]
    ];
    const protocol = getPseudoHeader(init, ':protocol');
    if (protocol !== null) reqHeaders.push([':protocol', protocol]);
    const headers = init?.headers;
    if (headers instanceof Headers) {
      headers.forEach((value, name) => {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), value]);
      });
    } else if (Array.isArray(headers)) {
      for (const [name, value] of headers) {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), value]);
      }
    } else if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers as Record<string, string>)) {
        if (!name.startsWith(':')) reqHeaders.push([name.toLowerCase(), String(value)]);
      }
    }
    const quicStream = await this.#conn.openBidirectionalStream();
    const sid = BigInt(quicStream.id);
    // If a GOAWAY arrived while we were waiting to open the stream, reject it
    // immediately rather than letting it linger until connection close.
    if (this.#goawayLastStreamId !== null && sid > this.#goawayLastStreamId) {
      void quicStream.writer.close();
      throw new Error(`H3 stream rejected: server GOAWAY (last accepted: ${this.#goawayLastStreamId})`);
    }
    this.#session.addQuicStream(sid, quicStream.writer);
    // Start reading the response on this stream.
    void (async () => {
      try {
        while (true) {
          const bytes = await quicStream.reader.read() as Uint8Array | null;
          const fin = bytes === null;
          await this.#session.readStream(sid, bytes ?? new Uint8Array(0), fin);
          if (fin) break;
        }
      } catch {
        // Connection was closed with an error before the response arrived.
        const pending = this.#pending.get(sid);
        if (pending && !pending.done) {
          pending.done = true;
          const error = new Error('H3 stream closed: connection error');
          pending.body.error(error);
          pending.trailerReject?.(error);
          pending.reject?.(error);
          this.#pending.delete(sid);
        }
      }
    })();
    const body = bodySourceFromInit(url, init);
    const responsePromise = new Promise<Response>((resolve, reject) => {
      let trailerResolve!: (headers: Headers) => void;
      let trailerReject!: (reason: unknown) => void;
      const trailers = new Promise<Headers>((trResolve, trReject) => {
        trailerResolve = trResolve;
        trailerReject = trReject;
      });
      const pending: PendingRequest = {
        status: '',
        responseHeaders: [],
        body: new H3BodyQueue(),
        trailerHeaders: [],
        inTrailers: false,
        done: false,
        responseResolved: false,
        resolve: null,
        reject: null,
        trailers,
        trailerResolve,
        trailerReject
      };
      pending.resolve = (response) => resolve(response);
      pending.reject = reject;
      this.#pending.set(sid, pending);
    });
    try {
      this.#session.submitRequest(sid, reqHeaders, body, init?.trailers);
      await this.#session.drainWrites();
    } catch (e) {
      this.#pending.delete(sid);
      throw e;
    }
    return responsePromise;
  }
  async webtransport(url: string | URL, init: H3RequestInit = {}): Promise<WebTransport> {
    if (this.#closed) throw new Error('H3 session is closed');
    await this.#waitForPeerSettings();
    if (!this.#session.peerWebTransportReady) {
      throw new Error('WebTransport over HTTP/3 requires peer SETTINGS for Extended CONNECT, H3 DATAGRAM, and WebTransport readiness');
    }
    const headers: Array<[string, string]> = [];
    const sourceHeaders = init.headers;
    if (sourceHeaders instanceof Headers) {
      sourceHeaders.forEach((value, name) => headers.push([name, value]));
    } else if (Array.isArray(sourceHeaders)) {
      headers.push(...sourceHeaders);
    } else if (sourceHeaders !== undefined) {
      for (const [name, value] of Object.entries(sourceHeaders as Record<string, string>)) {
        headers.push([name, String(value)]);
      }
    }
    headers.push([':protocol', 'webtransport-h3']);
    const response = await this.request(url, {
      ...init,
      method: 'CONNECT',
      headers
    } as H3RequestInit);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`WebTransport over HTTP/3 rejected with status ${response.status}`);
    }
    const streamId = (response as any).__h3StreamId as bigint | undefined;
    if (streamId === undefined) throw new Error('WebTransport over HTTP/3 response did not expose a CONNECT stream id');
    const wt = WebTransport._fromHttp3(String(url), {
      connection: this.#conn,
      sessionStreamId: streamId,
      responseHeaders: response.headers,
      protocol: response.headers.get('sec-webtransport-protocol') ?? '',
      options: init.webTransportOptions,
      routeIncomingStreams: false
    });
    this.#webTransports.set(streamId, wt);
    wt.closed.finally(() => this.#webTransports.delete(streamId)).catch(() => {});
    return wt;
  }
  #markPeerSettingsReceived(): void {
    this.#resolvePeerSettingsReceived?.();
    this.#resolvePeerSettingsReceived = null;
  }
  async #waitForPeerSettings(): Promise<void> {
    if (this.#session.peerSettingsReceived) return;
    await this.#peerSettingsReceived;
  }
  #resolveResponse(streamId: bigint): void {
    const pending = this.#pending.get(streamId);
    if (!pending || pending.responseResolved) return;
    pending.responseResolved = true;
    const statusNum = Number(pending.status);
    if (!pending.status || !Number.isInteger(statusNum) || statusNum < 100 || statusNum > 999) {
      pending.reject?.(new Error(`H3: missing or invalid :status pseudo-header (got: "${pending.status}")`));
      this.#pending.delete(streamId);
      return;
    }
    const headers = new Headers(pending.responseHeaders as HeadersInit);
    const body = statusNum === 204 || statusNum === 205 || statusNum === 304 ? null : pending.body as any;
    const response = new Response(body, {
      status: statusNum,
      headers,
      trailers: () => pending.trailers
    } as any);
    (response as any).__h3StreamId = streamId;
    pending.resolve?.(response);
  }
  #markDone(streamId: bigint): void {
    const req = this.#pending.get(streamId);
    if (!req || req.done) return;
    req.done = true;
    this.#resolveResponse(streamId);
    req.body.close();
    req.trailerResolve?.(new Headers(req.trailerHeaders as HeadersInit));
    this.#pending.delete(streamId);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#session.closeWhenIdle();
  }
  [Symbol.dispose](): void {
    this.close();
  }
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
