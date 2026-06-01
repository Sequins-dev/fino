/**
 * internal:net/http/h2/client — H2ClientDriver.
 *
 * Sends one HTTP/2 request over an already-connected reader/writer pair.
 * Each call opens its own nghttp2 client session (no pooling; that is Step 13).
 * Response body is buffered in full before resolving.
 *
 * ## Flow
 *
 * 1. Create client Nghttp2Session → nghttp2 queues the connection preface.
 * 2. Submit SETTINGS (empty) and the request HEADERS.
 * 3. Drain write → preface + SETTINGS + HEADERS go on the wire.
 * 4. Loop recv(chunk) + drainWrite until the response stream END_STREAMs.
 * 5. Send GOAWAY, drain, close session, close writer.
 * 6. Resolve the returned Promise with the buffered Response.
 *
 * @internal
 */

import type { BufferedBytesReader, BytesWriter } from '../../../stream.mts';
import type { ClientDriver, ClientDriverOptions } from '../../../../net/http/driver.mts';
import { Request, Response, Headers } from '../../../../net/http/index.mts';
import { Scanner } from '../../../../parsing/scanner.mts';
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
  bodyChunks: Uint8Array[];
  done: boolean;
  resolve: (res: Response) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// H2ClientDriver
// ---------------------------------------------------------------------------

export class H2ClientDriver implements ClientDriver {
  readonly multiplexed = true;

  async send(
    req: Request,
    reader: BufferedBytesReader,
    writer: BytesWriter,
    _opts: ClientDriverOptions,
  ): Promise<Response> {
    const streams = new Map<number, H2ClientStream>();

    // Serialize all drainWrite calls — same race as server.mts.
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
          if (endStream) finishStream(s);
        }

        if (frameType === NGHTTP2_FRAME_TYPE_DATA && endStream) {
          finishStream(s);
        }
      },

      onDataChunk(streamId: number, data: Uint8Array): void {
        const s = streams.get(streamId);
        if (s) s.bodyChunks.push(data);
      },

      onStreamClose(streamId: number, errorCode: number): void {
        const s = streams.get(streamId);
        if (s && !s.done) {
          s.done = true;
          s.reject(new Error(`H2 stream ${streamId} closed with error ${errorCode}`));
        }
        streams.delete(streamId);
      },
    };

    function finishStream(s: H2ClientStream): void {
      if (s.done) return;
      s.done = true;

      // Assemble body.
      const total = s.bodyChunks.reduce((n, c) => n + c.byteLength, 0);
      let bodyInit: BodyInit | null = null;
      if (total > 0) {
        const all = new Uint8Array(total);
        let off = 0;
        for (const c of s.bodyChunks) { all.set(c, off); off += c.byteLength; }
        bodyInit = all.buffer;
      }

      const res = new Response(bodyInit, {
        status: s.status,
        headers: s.headers,
        trailers: s.trailerHeaders,
      } as any);
      s.resolve(res);
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

    // Submit the request — returns the stream ID.
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
        bodyChunks: [],
        done: false,
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

    // Receive the response.
    let response!: Response;
    try {
      for await (const chunk of reader) {
        await session.recv(chunk);
        await drainWrite();

        // Check if our stream finished.
        const s = streams.get(streamId);
        if (!s || s.done) break;
      }
      response = await responseDeferred;
    } finally {
      try { session.submitGoaway(0, 0); } catch {}
      try { await drainWrite(); } catch {}
      session.close();
      await writer.close();
    }

    return response;
  }
}
