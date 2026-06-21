/**
 * internal:net/http/h2/client - H2ClientDriver.
 *
 * Sends one HTTP/2 request over an already-connected reader/writer pair.
 * Each call opens its own nghttp2 client session (no pooling; that is Step 13).
 * Response headers resolve before the response body finishes. Body bytes are
 * exposed through the shared HTTP stream queue.
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
 * ## Example
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
 *   {},
 * );
 *
 * response.status;
 * ```
 *
 * @internal
 */

import type { BufferedBytesReader, BytesWriter } from '../../../stream.mts';
import type { ClientDriver, ClientDriverOptions } from 'internal:net/http/driver';
import { Request, Response, Headers } from '../../../../net/http/index.mts';
import { Scanner } from '../../../../parsing/scanner.mts';
import { HttpBodyQueue, HttpStreamError } from '../stream.mts';
import {
  NGHTTP2_FLAG_END_STREAM,
  NGHTTP2_FLAG_END_HEADERS,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
} from './bindings.mts';
import { Nghttp2Session } from './session.mts';
import type { H2StreamCallbacks } from './session.mts';

function _parseStatus(value: string): number {
  const scanner = new Scanner(value, { encoding: 'ascii', format: 'http2' });
  const digits = scanner.eatWhile((code) => code >= 0x30 && code <= 0x39);
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
 * ```ts no_run
 * import { H2ClientDriver } from 'internal:net/http/h2/client';
 * const driver = new H2ClientDriver();
 * driver.multiplexed;
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
   * Send one HTTP request over an already connected HTTP/2 stream pair.
   *
   * The request body is buffered before submission. The returned promise
   * resolves when response headers are complete, with the body exposed as a
   * streaming async iterable. A background receive loop drains DATA frames and
   * always attempts GOAWAY, session close, and writer close when complete.
   *
   * ```ts no_run
   * import { Request } from 'internal:net/http/wire';
   * import { H2ClientDriver } from 'internal:net/http/h2/client';
   * const driver = new H2ClientDriver();
   * const res = await driver.send(new Request('https://example.test/'), reader, writer, {});
   * res.status;
   * ```
   */
  async send(
    req: Request,
    reader: BufferedBytesReader,
    writer: BytesWriter,
    _opts: ClientDriverOptions,
  ): Promise<Response> {
    const streams = new Map<number, H2ClientStream>();

    // Serialize all drainWrite calls - same race as server.mts.
    let drainChain: Promise<void> = Promise.resolve();
    function drainWrite(): Promise<void> {
      drainChain = drainChain.then(async () => {
        while (session.wantWrite()) {
          const bytes = await session.flush();
          if (bytes && bytes.byteLength > 0) await writer.write(bytes);
        }
        await writer.flush();
      });
      return drainChain;
    }

    const callbacks: H2StreamCallbacks = {
      onBeginHeaders(streamId: number, isTrailers: boolean): void {
        const s = streams.get(streamId);
        if (!s) return;
        if (isTrailers) { s.inTrailers = true; }
      },

      onHeader(streamId: number, name: string, value: string, _flags: number): void {
        const s = streams.get(streamId);
        if (!s) return;
        if (s.inTrailers) {
          if (!name.startsWith(':')) s.trailerHeaders.append(name, value);
          return;
        }
        if (name === ':status') { s.status = _parseStatus(value); }
        else if (!name.startsWith(':')) { s.headers.append(name, value); }
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
          const err = new HttpStreamError('closed', `H2 stream ${streamId} closed with error ${errorCode}`, {
            streamId,
            protocolCode: errorCode,
          });
          s.body.error(err);
          if (!s.responseResolved) s.reject(err);
        }
        streams.delete(streamId);
      },
    };

    function resolveResponse(s: H2ClientStream): void {
      if (s.responseResolved) return;
      s.responseResolved = true;
      const res = new Response(s.body as any, {
        status: s.status,
        headers: s.headers,
        trailers: s.trailerHeaders,
      } as any);
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
      [':method',    req.method],
      [':path',      url.pathname + url.search],
      [':scheme',    url.protocol.replace(':', '')],
      [':authority', url.host],
    ];
    for (const [k, v] of req.headers.entries()) {
      if (k === 'host' || k === 'connection' || k === 'keep-alive' ||
          k === 'transfer-encoding' || k === 'upgrade') continue;
      requestHeaders.push([k, v]);
    }

    // Buffer request body.
    let bodyBytes: Uint8Array | null = null;
    if (req.body) {
      try {
        const buf = await req.arrayBuffer();
        bodyBytes = buf.byteLength > 0 ? new Uint8Array(buf) : null;
      } catch { bodyBytes = null; }
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
      session.setStreamData(streamId, bodyBytes);
      await drainWrite();
      session.setStreamData(streamId, null); // EOF
      await drainWrite();
    }

    async function receiveResponse(): Promise<void> {
      try {
        for await (const chunk of reader) {
          await session.recv(chunk);
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
        try { session.submitGoaway(0, 0); } catch {}
        try { await drainWrite(); } catch {}
        session.close();
        await writer.close();
      }
    }

    void receiveResponse();
    return await responseDeferred;
  }
}
