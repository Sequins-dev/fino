/**
 * internal:net/http/h2/client — one-shot HTTP/2 client driver over a connected reader/writer pair.
 *
 * This module exposes `H2ClientDriver`, a `ClientDriver`
 * implementation that speaks HTTP/2 by driving an nghttp2 client session
 * (`Nghttp2Session`) over an already-connected byte stream. It performs no
 * connection setup of its own: DNS, TCP, TLS, and ALPN negotiation are the
 * caller's responsibility, and the driver simply exchanges frames on the reader
 * and writer it is handed.
 *
 * Each `send()` call opens its own fresh nghttp2 client session and carries a
 * single request/response exchange — there is no stream multiplexing or
 * connection reuse at this layer even though the protocol supports it; that is
 * the job of the separate HTTP/2 connection pool. Unlike the general
 * `ClientDriver` contract (which leaves connection lifetime to the
 * caller), this one-shot driver deliberately sends GOAWAY and closes both the
 * session and the writer once the exchange completes, so the connection is not
 * reusable afterward.
 *
 * Response headers are surfaced as soon as the HEADERS frame with END_HEADERS
 * arrives, so the returned promise resolves before the response body has
 * finished streaming. Body DATA frames are pushed into an `HttpBodyQueue` that
 * backs the `Response` body as an async iterable, and trailers (a second
 * HEADERS block after DATA) are collected into the response's trailer headers.
 *
 * ## Flow
 *
 * 1. Create client Nghttp2Session -> nghttp2 queues the connection preface.
 * 2. Submit SETTINGS (empty) and the request HEADERS.
 * 3. Drain write -> preface + SETTINGS + HEADERS go on the wire.
 * 4. Loop recv(chunk) + drainWrite in the background until END_STREAM.
 * 5. Resolve the returned Promise when response headers are complete.
 * 6. Send GOAWAY, drain, close session, close writer after stream completion.
 *
 * ```ts no_run
 * import { H2ClientDriver } from 'internal:net/http/h2/client';
 * import { Request } from 'internal:net/http/wire';
 *
 * const driver = new H2ClientDriver();
 * const response = await driver.send(
 *   new Request('https://example.test/'),
 *   reader,
 *   writer,
 *   { signal: null },
 * );
 *
 * response.status;
 * ```
 *
 * Learn more:
 * - HTTP/2 (RFC 9113): https://www.rfc-editor.org/rfc/rfc9113
 * - nghttp2: https://nghttp2.org/documentation/
 *
 * @internal
 */
import { Channel, type BufferedBytesReader, type BytesWriter } from '../../../stream.ts';
import type { ClientDriver, ClientDriverOptions } from 'internal:net/http/driver';
import { Request, Response, Headers } from '../../../../net/http/index.ts';
import { Scanner } from '../../../../parsing/scanner.ts';
import { HttpBodyQueue, HttpStreamError } from '../stream.ts';
import {
  NGHTTP2_FLAG_END_STREAM,
  NGHTTP2_FLAG_END_HEADERS,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
} from './bindings.ts';
import { Nghttp2Session } from './session.ts';
import type { H2StreamCallbacks } from './session.ts';
function _parseStatus(value: string): number {
  const scanner = new Scanner(value, {
    encoding: 'ascii',
    format: 'http2',
  });
  const digits = scanner.eatWhile((code) => code >= 48 && code <= 57);
  if (digits.length !== 3 || !scanner.done) throw new Error('invalid :status header');
  return Number(digits);
}
// ---------------------------------------------------------------------------
// Per-stream state (client side: one stream per send() call)
// ---------------------------------------------------------------------------
interface H2ClientStream {
  streamId: number;
  status: number;
  headers: Headers;
  trailerHeaders: Headers;
  inTrailers: boolean;
  body: HttpBodyQueue;
  done: boolean;
  responseResolved: boolean;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}
// ---------------------------------------------------------------------------
// H2ClientDriver
// ---------------------------------------------------------------------------
/**
 * HTTP/2 client driver for a single connected reader/writer pair.
 *
 * Each `send()` call creates a fresh nghttp2 client session and resolves when
 * response headers are complete. Response DATA is streamed into the returned
 * body. Connection pooling is handled by the separate HTTP/2 pool layer, not
 * this one-shot driver.
 *
 * The driver is stateless between calls: it holds no configuration and can be
 * constructed once and reused for many independent connections, since every
 * `send()` builds its own session, stream map, and receive loop. A single
 * instance is therefore safe to share across concurrent requests, each running
 * against its own reader/writer.
 *
 * ```ts no_run
 * import { H2ClientDriver } from 'internal:net/http/h2/client';
 * import { Request } from 'internal:net/http/wire';
 *
 * const driver = new H2ClientDriver();
 * const res = await driver.send(
 *   new Request('https://example.test/api'),
 *   reader,
 *   writer,
 *   { signal: null },
 * );
 * for await (const chunk of res.body) {
 *   // stream response DATA frames as they arrive
 * }
 * ```
 *
 * @internal
 */
export class H2ClientDriver implements ClientDriver {
  /**
   * Whether this driver supports multiplexed protocol semantics.
   *
   * The flag is `true` for HTTP/2. This one-shot driver still sends one request
   * per session, but the protocol itself supports multiplexing and the pool
   * uses that capability.
   *
   * ```ts
   * import { H2ClientDriver } from 'internal:net/http/h2/client';
   * new H2ClientDriver().multiplexed;
   * ```
   */
  readonly multiplexed = true;
  /**
   * Send one HTTP request over an already connected HTTP/2 reader/writer pair.
   *
   * The request URL is split into `:method`, `:path`, `:scheme`, and
   * `:authority` pseudo-headers, and the request's regular headers are appended
   * after connection-management headers (`host`, `connection`, `keep-alive`,
   * `transfer-encoding`, `upgrade`) are dropped, since they are meaningless in
   * HTTP/2. The request body is fully buffered before submission — a body that
   * cannot be read is treated as empty rather than fatal — and sent with
   * END_STREAM when present.
   *
   * The returned promise resolves when response headers are complete (the
   * HEADERS frame carrying END_HEADERS), before the body has finished, with the
   * body exposed as a streaming async iterable. A background receive loop reads
   * from `reader`, feeds bytes into the session, and streams DATA frames into
   * the body; trailers arriving after the body are attached to the response's
   * trailer headers. When the exchange finishes (or the loop errors) it always
   * attempts GOAWAY, drains pending writes, closes the session, and closes the
   * writer, so the connection is not reusable after `send()` returns.
   *
   * The `opts` argument matches the `ClientDriverOptions` contract but is not
   * consulted by this driver; cancellation is not wired up here.
   *
   * Rejects if the stream is reset or closed with an nghttp2 error code before
   * response headers arrive (surfaced as an `HttpStreamError`), or if reading
   * from `reader` throws before headers complete. Errors that occur after the
   * response has already resolved surface on the body's async iterator instead
   * of on the returned promise.
   *
   * ```ts no_run
   * import { Request } from 'internal:net/http/wire';
   * import { H2ClientDriver } from 'internal:net/http/h2/client';
   *
   * const driver = new H2ClientDriver();
   * const res = await driver.send(
   *   new Request('https://example.test/', { method: 'POST', body: 'hello' }),
   *   reader,
   *   writer,
   *   { signal: null },
   * );
   * res.status;
   * const text = await res.text();
   * ```
   */
  async send(
    req: Request,
    reader: BufferedBytesReader,
    writer: BytesWriter,
    _opts: ClientDriverOptions,
  ): Promise<Response> {
    const streams = new Map<number, H2ClientStream>();
    const drains = new Channel<() => Promise<void>>();
    void (async () => {
      for await (const drain of drains.reader) await drain();
    })();
    function drainWrite(): Promise<void> {
      async function drainH2Writes() {
        do {
          const bytes = session.flush();
          if (bytes && bytes.byteLength > 0) await writer.write(bytes);
          else break;
        } while (session.wantWrite());
        await writer.flush();
      }
      return new Promise<void>((resolve, reject) => {
        const accepted = drains.writer.write(async () => {
          try {
            await drainH2Writes();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        void accepted.catch(reject);
      });
    }
    const callbacks: H2StreamCallbacks = {
      onBeginHeaders(streamId: number, isTrailers: boolean): void {
        const s = streams.get(streamId);
        if (!s) return;
        if (isTrailers) {
          s.inTrailers = true;
        }
      },
      onHeader(streamId: number, name: string, value: string, _flags: number): void {
        const s = streams.get(streamId);
        if (!s) return;
        if (s.inTrailers) {
          if (!name.startsWith(':')) s.trailerHeaders.append(name, value);
          return;
        }
        if (name === ':status') {
          s.status = _parseStatus(value);
        } else if (!name.startsWith(':')) {
          s.headers.append(name, value);
        }
      },
      onFrameRecv(streamId: number, frameType: number, frameFlags: number): void {
        const s = streams.get(streamId);
        if (!s) return;
        const endStream = (frameFlags & NGHTTP2_FLAG_END_STREAM) !== 0;
        if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) {
          if ((frameFlags & NGHTTP2_FLAG_END_HEADERS) === 0) return;
          if (!s.inTrailers) resolveResponse(s);
          if (endStream) finishStream(s);
        }
        if (frameType === NGHTTP2_FRAME_TYPE_DATA && endStream) {
          finishStream(s);
        }
      },
      onDataChunk(streamId: number, data: Uint8Array): void {
        const s = streams.get(streamId);
        if (s && !s.done) s.body.push(data);
      },
      onStreamClose(streamId: number, errorCode: number): void {
        const s = streams.get(streamId);
        if (s && !s.done) {
          s.done = true;
          const err = new HttpStreamError(
            'closed',
            `H2 stream ${streamId} closed with error ${errorCode}`,
            {
              streamId,
              protocolCode: errorCode,
            },
          );
          s.body.error(err);
          if (!s.responseResolved) s.reject(err);
        }
        streams.delete(streamId);
      },
    };
    function resolveResponse(s: H2ClientStream): void {
      if (s.responseResolved) return;
      s.responseResolved = true;
      const res = new Response(
        s.body as any,
        {
          status: s.status,
          headers: s.headers,
          trailers: s.trailerHeaders,
        } as any,
      );
      s.resolve(res);
    }
    function finishStream(s: H2ClientStream): void {
      if (s.done) return;
      s.done = true;
      s.body.close();
      resolveResponse(s);
    }
    const session = Nghttp2Session.createClient(callbacks);
    session.submitSettings([]);
    // Build request HEADERS: pseudo-headers first, then regular.
    const url = new URL(req.url);
    const requestHeaders: Array<[string, string]> = [
      [':method', req.method],
      [':path', url.pathname + url.search],
      [':scheme', url.protocol.replace(':', '')],
      [':authority', url.host],
    ];
    for (const [k, v] of req.headers.entries()) {
      if (
        k === 'host' ||
        k === 'connection' ||
        k === 'keep-alive' ||
        k === 'transfer-encoding' ||
        k === 'upgrade'
      )
        continue;
      requestHeaders.push([k, v]);
    }
    // Buffer request body.
    let bodyBytes: Uint8Array | null = null;
    if (req.body) {
      try {
        const buf = await req.arrayBuffer();
        bodyBytes = buf.byteLength > 0 ? new Uint8Array(buf) : null;
      } catch {
        bodyBytes = null;
      }
    }
    // Submit the request - returns the stream ID.
    const hasBody = bodyBytes !== null;
    const streamId = session.submitRequest(requestHeaders, hasBody);
    // Register the stream state + response deferred.
    const responseDeferred = new Promise<Response>((resolve, reject) => {
      streams.set(streamId, {
        streamId,
        status: 200,
        headers: new Headers(),
        trailerHeaders: new Headers(),
        inTrailers: false,
        body: new HttpBodyQueue(),
        done: false,
        responseResolved: false,
        resolve,
        reject,
      });
    });
    // Drain writes: preface + SETTINGS + HEADERS leave the runtime.
    await drainWrite();
    // Feed request body if any.
    if (hasBody && bodyBytes) {
      session.setStreamData(streamId, bodyBytes, { endStream: true });
      await drainWrite();
    }
    async function receiveResponse(): Promise<void> {
      try {
        for await (const chunk of reader) {
          session.recv(chunk);
          await drainWrite();
          // Check if our stream finished.
          const s = streams.get(streamId);
          if (!s || s.done) break;
        }
        const s = streams.get(streamId);
        if (s && !s.done) finishStream(s);
      } catch (e) {
        const s = streams.get(streamId);
        const err = e instanceof Error ? e : new Error(String(e));
        if (s && !s.done) {
          s.done = true;
          s.body.error(err);
          if (!s.responseResolved) s.reject(err);
        }
      } finally {
        try {
          session.submitGoaway(0, 0);
        } catch {}
        try {
          await drainWrite();
        } catch {}
        session.close();
        await writer.close();
      }
    }
    void receiveResponse();
    return await responseDeferred;
  }
}
