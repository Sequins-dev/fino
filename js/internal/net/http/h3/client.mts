import { Nghttp3Session } from './session.mts';
import type { H3BodySource, H3SessionCallbacks } from './session.mts';
import { H3BodyQueue } from './body-queue.mts';
import { h3Available } from './bindings.mts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';

export interface H3RequestInit extends RequestInit {
  trailers?: Array<[string, string]>;
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

export class H3ClientSession {
  #conn: QuicConnection;
  #session: Nghttp3Session;
  #pending = new Map<bigint, PendingRequest>();
  #closed = false;
  #goawayLastStreamId: bigint | null = null;

  private constructor(conn: QuicConnection, session: Nghttp3Session) {
    this.#conn = conn;
    this.#session = session;
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
            status: '', responseHeaders: [], body: new H3BodyQueue(), trailerHeaders: [],
            inTrailers: false, done: false, responseResolved: false,
            resolve: null, reject: null, trailers: Promise.resolve(new Headers()),
            trailerResolve: null, trailerReject: null,
          });
        }
      },
      onRecvHeader(streamId, _token, name, value) {
        const req = instance.#pending.get(streamId);
        if (!req) return;
        if (req.inTrailers) { req.trailerHeaders.push([name, value]); return; }
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
      onEndTrailers(streamId) { instance.#markDone(streamId); },
      onRecvData(streamId, data) {
        const req = instance.#pending.get(streamId);
        if (req) req.body.push(data);
      },
      onEndStream(streamId) { instance.#markDone(streamId); },
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
    };

    session = Nghttp3Session.createClient(callbacks);
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

    // Attach stream listener early so remote unidirectional streams
    // (server control/QPACK) are captured as soon as they arrive.
    conn.addEventListener('stream', (event) => {
      const stream = (event as QuicStreamEvent).stream;
      const sid = BigInt(stream.id);
      if (stream.direction === 'unidirectional') {
        void (async () => {
          try {
            while (true) {
              const bytes = await stream.reader.read() as Uint8Array | null;
              const fin = bytes === null;
              await session.readStream(sid, bytes ?? new Uint8Array(0), fin);
              if (fin) break;
            }
          } catch { /* session closed or connection error */ }
        })();
      }
    });

    // Bind the 3 mandatory local unidirectional streams.
    try {
      const [controlStream, qencStream, qdecStream] = await Promise.all([
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
        conn.openUnidirectionalStream(),
      ]) as QuicStream[];

      for (const s of [controlStream, qencStream, qdecStream]) {
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

    const reqHeaders: Array<[string, string]> = [
      [':method',    method],
      [':path',      parsed.pathname + parsed.search],
      [':scheme',    parsed.protocol.replace(':', '')],
      [':authority', parsed.host],
    ];

    if (init?.headers) {
      new Headers(init.headers as HeadersInit).forEach((value, name) => {
        reqHeaders.push([name.toLowerCase(), value]);
      });
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
        status: '', responseHeaders: [], body: new H3BodyQueue(), trailerHeaders: [],
        inTrailers: false, done: false, responseResolved: false,
        resolve: null, reject: null, trailers, trailerResolve, trailerReject,
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
    pending.resolve?.(new Response(pending.body as any, {
      status: statusNum,
      headers,
      trailers: () => pending.trailers,
    } as any));
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

  [Symbol.dispose](): void { this.close(); }
}
