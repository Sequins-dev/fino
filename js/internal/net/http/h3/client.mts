import { Nghttp3Session } from './session.mts';
import type { H3SessionCallbacks } from './session.mts';
import { h3Available } from './bindings.mts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';

export interface H3RequestInit extends RequestInit {
  trailers?: Array<[string, string]>;
}

interface PendingRequest {
  status: string;
  responseHeaders: Array<[string, string]>;
  bodyChunks: Uint8Array[];
  trailerHeaders: Array<[string, string]>;
  inTrailers: boolean;
  done: boolean;
  resolve: (() => void) | null;
  reject: ((e: Error) => void) | null;
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
            status: '', responseHeaders: [], bodyChunks: [], trailerHeaders: [],
            inTrailers: false, done: false, resolve: null, reject: null,
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
        if (req) req.bodyChunks.push(data);
      },
      onEndStream(streamId) { instance.#markDone(streamId); },
      onStreamClose(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req && !req.done) {
          req.reject?.(new Error(`H3 stream closed with error 0x${appErrorCode.toString(16)}`));
          instance.#pending.delete(streamId);
        }
      },
      onResetStream(streamId, appErrorCode) {
        const req = instance.#pending.get(streamId);
        if (req) {
          req.reject?.(new Error(`H3 stream reset with error 0x${appErrorCode.toString(16)}`));
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
              req.reject?.(new Error(`H3 stream rejected: server GOAWAY (last accepted: ${lastStreamId})`));
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
          req.reject?.(new Error('H3 stream closed: connection closed'));
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
          pending.reject?.(new Error('H3 stream closed: connection error'));
          this.#pending.delete(sid);
        }
      }
    })();

    let bodyBytes: Uint8Array | undefined;
    if (init?.body) {
      if (init.body instanceof Uint8Array) {
        if (init.body.byteLength > 0) bodyBytes = init.body;
      } else {
        const ab = init.body instanceof ArrayBuffer
          ? init.body
          : await new Request(url, init).arrayBuffer();
        if (ab.byteLength > 0) bodyBytes = new Uint8Array(ab);
      }
    }

    const responsePromise = new Promise<Response>((resolve, reject) => {
      const pending: PendingRequest = {
        status: '', responseHeaders: [], bodyChunks: [], trailerHeaders: [],
        inTrailers: false, done: false,
        resolve: null, reject: null,
      };
      pending.resolve = () => {
        const statusNum = Number(pending.status);
        if (!pending.status || !Number.isInteger(statusNum) || statusNum < 100 || statusNum > 999) {
          reject(new Error(`H3: missing or invalid :status pseudo-header (got: "${pending.status}")`));
          this.#pending.delete(sid);
          return;
        }
        const headers = new Headers(pending.responseHeaders as HeadersInit);
        let body: BodyInit | undefined;
        if (pending.bodyChunks.length > 0) {
          const total = pending.bodyChunks.reduce((s, c) => s + c.length, 0);
          const buf = new Uint8Array(total);
          let off = 0;
          for (const c of pending.bodyChunks) { buf.set(c, off); off += c.length; }
          body = buf;
        }
        const trailerInit = pending.trailerHeaders.length > 0
          ? new Headers(pending.trailerHeaders as HeadersInit)
          : undefined;
        resolve(new Response(body, { status: statusNum, headers, trailers: trailerInit } as any));
      };
      pending.reject = reject;
      this.#pending.set(sid, pending);
    });

    try {
      this.#session.submitRequest(sid, reqHeaders, bodyBytes, init?.trailers);
      await this.#session.drainWrites();
    } catch (e) {
      this.#pending.delete(sid);
      throw e;
    }
    return responsePromise;
  }

  #markDone(streamId: bigint): void {
    const req = this.#pending.get(streamId);
    if (!req || req.done) return;
    req.done = true;
    req.resolve?.();
    this.#pending.delete(streamId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#session.closeWhenIdle();
  }

  [Symbol.dispose](): void { this.close(); }
}
