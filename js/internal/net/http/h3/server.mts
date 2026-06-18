import { Nghttp3Session } from './session.mts';
import type { H3SessionCallbacks } from './session.mts';
import { h3Available } from './bindings.mts';
import { QuicStreamEvent } from 'fino:net/quic';
import type { QuicConnection, QuicStream } from 'fino:net/quic';

export type H3Handler = (request: Request) => Response | Promise<Response>;

const _FORBIDDEN_RESP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);
const _FORBIDDEN_REQ  = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

interface H3ServerStream {
  streamId: bigint;
  method: string;
  path: string;
  scheme: string;
  authority: string;
  headers: Array<[string, string]>;
  trailerHeaders: Array<[string, string]>;
  inTrailers: boolean;
  bodyChunks: Uint8Array[];
  bodyDone: boolean;
  cancelled: boolean;
  badRequest: boolean;
  dispatched: boolean;
  seenPseudos: Set<string>;
  seenRegular: boolean;
}

function makeStream(streamId: bigint): H3ServerStream {
  return {
    streamId,
    method: '', path: '', scheme: '', authority: '',
    headers: [], trailerHeaders: [],
    inTrailers: false, bodyChunks: [],
    bodyDone: false, cancelled: false, badRequest: false, dispatched: false,
    seenPseudos: new Set(), seenRegular: false,
  };
}

export class H3ServerDriver {
  async run(conn: QuicConnection, handler: H3Handler): Promise<void> {
    if (!h3Available) throw new Error('libnghttp3 is not available');

    const streams = new Map<bigint, H3ServerStream>();
    const inFlight = new Set<Promise<void>>();
    let session: Nghttp3Session;

    const callbacks: H3SessionCallbacks = {
      onBeginHeaders(streamId) {
        if (!streams.has(streamId)) streams.set(streamId, makeStream(streamId));
      },

      onRecvHeader(streamId, _token, name, value) {
        const st = streams.get(streamId);
        if (!st || st.cancelled) return;
        if (st.inTrailers) {
          if (!name.startsWith(':')) st.trailerHeaders.push([name, value]);
          return;
        }
        if (name.startsWith(':')) {
          if (st.seenRegular || st.seenPseudos.has(name)) { st.cancelled = true; st.badRequest = true; return; }
          st.seenPseudos.add(name);
          if      (name === ':method')    st.method    = value;
          else if (name === ':path')      st.path      = value;
          else if (name === ':scheme')    st.scheme    = value;
          else if (name === ':authority') st.authority = value;
          else { st.badRequest = true; return; }  // response-only or unknown pseudo-header in request (RFC 9114 §4.3.1)
        } else {
          const lc = name.toLowerCase();
          if (lc !== name) { st.cancelled = true; st.badRequest = true; return; }
          if (_FORBIDDEN_REQ.has(lc)) { st.cancelled = true; st.badRequest = true; return; }
          if (lc === 'te') return; // nghttp3 enforces te: trailers-only; not an application header
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
        const noBody = fin || st.method === 'GET' || st.method === 'HEAD' || st.method === 'CONNECT';
        if (noBody) st.bodyDone = true;
        if (noBody) startDispatch(st);
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
        st.bodyDone = true;
        startDispatch(st);
      },

      onRecvData(streamId, data) {
        const st = streams.get(streamId);
        if (st && !st.cancelled) st.bodyChunks.push(data);
      },

      onEndStream(streamId) {
        const st = streams.get(streamId);
        if (!st) return;
        st.bodyDone = true;
        startDispatch(st);
      },

      onStreamClose(streamId) { streams.delete(streamId); },

      onResetStream(streamId) {
        const st = streams.get(streamId);
        if (st) { st.cancelled = true; st.bodyDone = true; }
      },

      onAckedStreamData() {},
    };

    session = Nghttp3Session.createServer(callbacks);

    // Dispatch a request to the handler once headers + body are complete.
    function startDispatch(st: H3ServerStream): void {
      if (st.dispatched) return;
      if (st.cancelled && !st.badRequest) return;
      st.dispatched = true;
      const p: Promise<void> = dispatch(st).catch(() => {}).then(() => { inFlight.delete(p); });
      inFlight.add(p);
    }

    async function dispatch(st: H3ServerStream): Promise<void> {
      if (st.badRequest) {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          await session.drainWrites();
        } catch { /* stream may already be closed by nghttp3 */ }
        return;
      }
      if (st.cancelled) return;
      if (st.method === 'CONNECT') {
        try {
          session.submitResponse(st.streamId, [[':status', '405'], ['allow', 'GET, HEAD, POST, PUT, DELETE, OPTIONS, PATCH']]);
          await session.drainWrites();
        } catch {}
        return;
      }
      if (!st.method || !st.path) {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          await session.drainWrites();
        } catch { /* stream may already be reset by nghttp3 */ }
        return;
      }

      const url = `${st.scheme || 'https'}://${st.authority || 'localhost'}${st.path}`;

      let bodyBytes: Uint8Array | undefined;
      if (st.bodyChunks.length > 0) {
        const total = st.bodyChunks.reduce((s, c) => s + c.length, 0);
        bodyBytes = new Uint8Array(total);
        let off = 0;
        for (const c of st.bodyChunks) { bodyBytes.set(c, off); off += c.length; }
      }

      const reqHeaders = new Headers(st.headers);
      if (st.authority) reqHeaders.set('host', st.authority);

      let req: Request;
      try {
        req = new Request(url, { method: st.method, headers: reqHeaders, body: bodyBytes });
      } catch {
        try {
          session.submitResponse(st.streamId, [[':status', '400']]);
          await session.drainWrites();
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

      let respBody: Uint8Array | undefined;
      try {
        if (response.body && st.method !== 'HEAD') {
          const ab = await response.arrayBuffer();
          if (ab.byteLength > 0) respBody = new Uint8Array(ab);
        }
      } catch {
        if (!st.cancelled) {
          try {
            session.submitResponse(st.streamId, [[':status', '500']]);
            await session.drainWrites();
          } catch { /* stream may already be closed */ }
        }
        return;
      }

      if (st.cancelled) return;

      let respTrailers: Array<[string, string]> | undefined;
      if ((response as any)._hasOutTrailers?.()) {
        const raw = (response as any)._getRawOutTrailers();
        let trailersOut: Headers;
        if (raw instanceof Headers) {
          trailersOut = raw;
        } else if (typeof raw === 'function') {
          try { trailersOut = await (raw as () => Headers | Promise<Headers>)(); }
          catch { trailersOut = new Headers(); }
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
      session.submitResponse(st.streamId, respHeaders, respBody, respTrailers);
      await session.drainWrites();
    }

    try {
    // Attach stream listener early so bidirectional streams from the client
    // are captured even if they arrive during local setup.
    conn.addEventListener('stream', (event) => {
      const stream = (event as QuicStreamEvent).stream;
      const sid = BigInt(stream.id);

      // Only bidirectional streams can be written to; unidirectional (control, QPACK) are receive-only.
      if (stream.direction === 'bidirectional') {
        session.addQuicStream(sid, stream.writer);
      }

      // Read loop — serialized through the session mutex.
      void (async () => {
        try {
          while (true) {
            const bytes = await stream.reader.read() as Uint8Array | null;
            const fin   = bytes === null;
            await session.readStream(sid, bytes ?? new Uint8Array(0), fin);
            if (fin) break;
          }
        } catch {
          const st = streams.get(sid);
          if (st && !st.cancelled) {
            st.cancelled = true;
            st.bodyDone = true;
          }
          if (session.isClosed) {
            conn.destroy();
          } else {
            // nghttp3_conn_close_stream does not send any H3 frames. Send RESET_STREAM
            // at the QUIC level so the client's pending request rejects instead of hanging.
            try { stream.reset(0x010e); } catch { /* connection may already be closing */ }
          }
        }
      })();
    });

    // Open the 3 mandatory local unidirectional streams.
    const [controlStream, qencStream, qdecStream] = await Promise.all([
      conn.openUnidirectionalStream(),
      conn.openUnidirectionalStream(),
      conn.openUnidirectionalStream(),
    ]);

    for (const s of [controlStream, qencStream, qdecStream] as QuicStream[]) {
      session.addQuicStream(BigInt(s.id), s.writer);
    }

    session.bindControlStream(BigInt(controlStream.id));
    session.bindQpackStreams(BigInt(qencStream.id), BigInt(qdecStream.id));
    await session.drainWrites();

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
