/**
 * boats:serve — HTTP/1.1 server convenience.
 *
 * `serve()` wraps `Socket.listen()` and the HTTP parser/serialiser from
 * `boats:http` into a ready-to-use HTTP server that handles keep-alive,
 * Content-Length injection, per-request error isolation, and concurrent
 * connections out of the box.
 *
 *
 * ## Usage
 *
 *   import { serve } from 'boats:net/serve';
 *
 *   const server = serve(lp, { port: 3000 }, async (req) => {
 *     return new Response('hello');
 *   });
 *
 *   // Graceful shutdown:
 *   await server.close();
 *
 *
 * ## Keep-alive
 *
 * HTTP/1.1 connections are kept alive by default. The server loops over
 * requests on the same TCP connection until the client sends
 * `Connection: close`, the handler returns a response with that header, or
 * the connection is reset. The `connectionParser()` helper from `boats:http`
 * shares a single buffered reader across all requests on a connection —
 * required to correctly forward leftover bytes between pipelined requests.
 *
 *
 * ## Content-Length
 *
 * If the handler's Response does not include a `Content-Length` or
 * `Transfer-Encoding` header, `serve()` eagerly buffers the body and injects
 * `Content-Length`. For truly streaming responses, set one of those headers
 * yourself.
 *
 *
 * ## Error handling
 *
 * If the handler throws an unhandled error, `serve()` sends a bare
 * `500 Internal Server Error` response and closes the connection. The handler
 * is responsible for catching its own application errors and returning
 * appropriate responses.
 */

import {
  Headers,
  Response,
  serializeResponse,
  connectionParser,
  buildWireResponse,
  _iterableFromBytes,
  _concat,
} from 'boats:net/http';
import { Socket } from 'boats:net/socket';
import type { LoopHandle } from 'boats:runtime/loop';
import type { Request, Response } from 'boats:net/http';

interface ServeOptions {
  port:      number;
  hostname?: string;
}

interface ServeServer {
  address: { family: string; ip: string; port: number };
  readonly port: number;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether to keep the connection alive after this request.
 * HTTP/1.1 defaults to keep-alive; HTTP/1.0 defaults to close.
 */
function _shouldKeepAlive(reqHeaders: { get(name: string): string | null }, version: string): boolean {
  const conn = (reqHeaders.get('connection') || '').toLowerCase().trim();
  return version === 'HTTP/1.0' ? conn === 'keep-alive' : conn !== 'close';
}

/**
 * Drain any unconsumed request body so the reader advances past the body
 * bytes before the next request's headers are parsed.
 */
async function _drainBody(req: Request): Promise<void> {
  if (!req.hasBody || req.bodyUsed) return;
  for await (const _ of req.body) {}
}

/**
 * Prepare a response for the wire:
 *   - Injects `Content-Length` if the body is not already framed.
 *   - Injects `Connection: keep-alive` or `Connection: close`.
 *   - Sets the HTTP version to match the request.
 *
 * The original `res.body` is consumed here (setting bodyUsed = true).
 */
async function _prepareResponse(res: Response, keepAlive: boolean, reqVersion: string): Promise<Response> {
  const version    = reqVersion || 'HTTP/1.1';
  const connHeader = keepAlive ? 'keep-alive' : 'close';

  const alreadyFramed = res.headers.has('content-length') ||
                        res.headers.has('transfer-encoding');

  const rawBody = res.body; // access body — sets bodyUsed = true; null or async iterable

  if (rawBody === null || alreadyFramed) {
    const headers = new Headers(res.headers);
    headers.set('connection', connHeader);
    return buildWireResponse({
      version, status: res.status, statusText: res.statusText, headers, body: rawBody,
    });
  }

  // Buffer the entire body so we can inject Content-Length.
  const parts = [];
  let total = 0;
  for await (const chunk of rawBody) {
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    parts.push(u8);
    total += u8.byteLength;
  }
  const bytes = total === 0 ? new Uint8Array(0) : _concat(parts, total);
  const headers = new Headers(res.headers);
  headers.set('content-length', String(bytes.byteLength));
  headers.set('connection', connHeader);
  return buildWireResponse({
    version,
    status:     res.status,
    statusText: res.statusText,
    headers,
    body:       _iterableFromBytes(bytes),
  });
}

/**
 * Handle a single accepted TCP connection: parse requests, call the handler,
 * send responses, loop on keep-alive until the client closes.
 */
async function _handleConnection(conn: InstanceType<typeof Socket>, handler: (req: Request) => Response | Promise<Response>): Promise<void> {
  const [reader, writer] = conn.split();
  const parser = connectionParser(reader);
  try {
    while (true) {
      // Parse the next request. Any throw here means the client disconnected
      // or sent malformed headers — either way, we close the connection.
      let req;
      try {
        req = await parser.parseNext();
      } catch (e) {
        break;
      }

      let keepAlive = _shouldKeepAlive(req.headers, req.version);

      let res;
      try {
        res = await handler(req);
      } catch (e) {
        res = new Response('Internal Server Error', { status: 500 });
        keepAlive = false;
      }

      // Advance the reader past the request body before writing the response,
      // so that pipelined requests on the same connection parse correctly.
      await _drainBody(req);

      let prepared;
      try {
        prepared = await _prepareResponse(res, keepAlive, req.version);
      } catch (e) {
        prepared = buildWireResponse({
          version:    req.version || 'HTTP/1.1',
          status:     500,
          statusText: 'Internal Server Error',
          headers:    new Headers({ connection: 'close' }),
          body:       null,
        });
        keepAlive = false;
      }

      try {
        await writer.pipe(serializeResponse(prepared));
      } catch (e) {
        break; // client disconnected during write
      }

      if (!keepAlive) break;
    }
  } finally {
    writer.close();
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start an HTTP/1.1 server.
 *
 * Each incoming connection is handled concurrently. The event loop is
 * implicitly kept alive as long as the server is open.
 *
 * @param {object} lp — loop handle from boats:loop
 * @param {{ port: number, hostname?: string }} options
 * @param {(req: Request) => Response | Promise<Response>} handler
 * @returns {{ address: object, port: number, close(): Promise<void> }}
 *
 * @example
 * import { serve } from 'boats:net/serve';
 * import * as loop from 'boats:runtime/loop';
 *
 * const lp = loop.create();
 * const server = serve(lp, { port: 3000 }, async (req) => new Response('hello'));
 * // ... handle some requests ...
 * await server.close();
 * loop.destroy(lp);
 */
export function serve(lp: LoopHandle, options: ServeOptions, handler: (req: Request) => Response | Promise<Response>): ServeServer {
  const hostname = options.hostname ?? '0.0.0.0';
  const port     = options.port ?? 0;

  const addr      = { family: 'ipv4', ip: hostname, port };
  const tcpServer = Socket.listen(lp, addr);

  const inFlight = new Set();
  let acceptLoopDone = false;
  let finishResolve;
  const finished = new Promise((resolve) => { finishResolve = resolve; });

  // Close signal — resolved by close() to unblock any pending loop.readable()
  // inside acceptOne(). Without this, closing the server fd leaves the accept
  // loop suspended at loop.readable(lp, serverFd) forever.
  let closeSignalResolve;
  const closeSignal = new Promise((resolve) => { closeSignalResolve = resolve; });

  function _checkDone() {
    if (acceptLoopDone && inFlight.size === 0) finishResolve();
  }

  // Accept loop — runs concurrently; each connection is fire-and-forget.
  (async () => {
    try {
      while (true) {
        const conn = await Promise.race([tcpServer.accept(), closeSignal]);
        if (conn === null || conn === undefined) break; // closed
        const p = _handleConnection(conn, handler);
        inFlight.add(p);
        p.finally(() => { inFlight.delete(p); _checkDone(); });
      }
    } finally {
      acceptLoopDone = true;
      _checkDone();
    }
  })().catch(() => {}); // swallow unhandled rejections from the accept loop

  return {
    /** The address the server is listening on. */
    address: tcpServer.address,
    /** Convenience shortcut for server.address.port. */
    get port() { return tcpServer.address.port; },
    /**
     * Stop accepting new connections and wait for all in-flight connections
     * to finish. Returns a Promise that resolves when the server is fully shut down.
     */
    close() {
      closeSignalResolve(); // wake the accept loop
      tcpServer.close();
      return finished;
    },
  };
}
