/**
 * internal:net/http/driver — protocol driver contracts shared by the HTTP stack.
 *
 * This module holds no logic of its own: it defines the interfaces and helper
 * predicate that let `serve()` and `fetch()` treat HTTP/1, HTTP/2, and HTTP/3
 * uniformly. Concrete drivers (H1/H2 server and client implementations) live in
 * sibling modules and satisfy these contracts; keeping the contracts in one
 * type-only module avoids a cyclic dependency between the dispatchers and the
 * per-protocol code.
 *
 * On the server side, a `ServerDriver` owns one accepted connection for its
 * whole lifetime, invoking a `ServerHandler` per request and honoring the
 * limits in `ServerDriverOptions`. `serve()` chooses the driver from ALPN
 * negotiation, and the H1 driver additionally sniffs the h2c upgrade preface
 * when `allowH2cUpgrade` is set. On the client side, a `ClientDriver` sends one
 * logical request over an already-open reader/writer pair and leaves the
 * connection open so the caller can pool it; `multiplexed` reports whether the
 * connection can carry concurrent streams, and a `CancelSignal` races the send
 * against abort without binding to any particular `AbortSignal` global.
 *
 * `ConnectionTakeover` is the escape hatch for protocol upgrades such as
 * WebSocket. A handler returns one in place of a `Response`; the driver detects
 * it with `isConnectionTakeover()` (a duck-type check, since it is an interface
 * rather than a class), writes any handshake response, then hands the raw
 * reader/writer to `_takeOver()`. The H1 driver accepts any takeover, while the
 * H2 driver rejects one whose `compatibleProtocols` omits `'h2'` with an
 * RST_STREAM / INTERNAL_ERROR.
 *
 * HTTP semantics specification: https://www.rfc-editor.org/rfc/rfc9110
 *
 * @example
 * ```ts no_run
 * import { isConnectionTakeover } from 'internal:net/http/driver';
 *
 * const takeover = {
 *   compatibleProtocols: new Set(['http/1.1']),
 *   async _takeOver(reader, writer) {
 *     await writer.flush();
 *   },
 * };
 * if (isConnectionTakeover(takeover)) {
 *   console.log('takeover is compatible');
 * }
 * ```
 *
 * @internal
 */
import type { BytesReader, BytesWriter } from '../../internal/stream.ts';
import type { Request, Response } from './index.ts';
// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------
/**
 * Value returned from an HTTP server handler.
 *
 * A normal `Response` is serialized by the active protocol driver. A
 * `ConnectionTakeover` transfers the underlying connection to another protocol
 * such as WebSocket.
 *
 * ```ts no_run
 * const result: ServerResult = new Response('ok');
 * ```
 */
export type ServerResult = Response | ConnectionTakeover;
/**
 * HTTP protocol name used by server-side logical streams.
 */
export type HttpProtocol = 'http/1.1' | 'h2' | 'h3';
/**
 * Function invoked for each server-side HTTP request.
 *
 * The handler may be async. Throwing lets the driver produce a generic 500 for
 * HTTP/1; application-level error shaping should happen in middleware.
 *
 * ```ts no_run
 * const handler: ServerHandler = async (req) => new Response(req.method);
 * ```
 */
export type ServerHandler = (req: Request) => ServerResult | Promise<ServerResult>;
/**
 * Shared server driver options supplied by `serve`.
 *
 * ```ts no_run
 * const opts: ServerDriverOptions = { maxConcurrent: 32, allowH2cUpgrade: true };
 * ```
 */
export interface ServerDriverOptions {
  /** Max concurrent in-flight requests or HTTP/2 streams.
   *
   * ```ts no_run
   * const opts = { maxConcurrent: 16 };
   * ```
   */
  maxConcurrent: number;
  /** If true, recognize the h2c Upgrade dance in the H1 driver.
   *
   * ```ts no_run
   * const opts = { maxConcurrent: 32, allowH2cUpgrade: true };
   * ```
   */
  allowH2cUpgrade?: boolean;
  /** Milliseconds allowed for a complete HTTP/1 request header block.
   *
   * `0` or `undefined` disables the timeout.
   *
   * ```ts no_run
   * const opts = { maxConcurrent: 32, headersTimeoutMs: 30_000 };
   * ```
   */
  headersTimeoutMs?: number;
  /** Milliseconds an HTTP/1 keep-alive connection may sit idle.
   *
   * `0` or `undefined` disables the timeout.
   *
   * ```ts no_run
   * const opts = { maxConcurrent: 32, idleTimeoutMs: 60_000 };
   * ```
   */
  idleTimeoutMs?: number;
}
/**
 * Server protocol driver contract for HTTP/1 and HTTP/2.
 *
 * Drivers own one accepted connection until it is closed, upgraded, or fails.
 *
 * ```ts no_run
 * await driver.run(reader, writer, handler, { maxConcurrent: 32 });
 * ```
 */
export interface ServerDriver {
  /**
   * Process one accepted connection. Resolves when the connection is fully
   * closed (all in-flight requests done, buffers flushed).
   *
   * ```ts no_run
   * await driver.run(reader, writer, async () => new Response('ok'), { maxConcurrent: 8 });
   * ```
   */
  run(
    reader: BytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
  ): Promise<void>;
}
// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------
/**
 * Minimal abort signal contract accepted by client drivers.
 *
 * This mirrors the `AbortSignal` surface used by HTTP client code without
 * depending on a specific global implementation.
 *
 * ```ts no_run
 * const signal: CancelSignal | null = controller.signal;
 * ```
 */
export interface CancelSignal {
  /** True once cancellation has been requested.
   *
   * ```ts no_run
   * if (signal.aborted) throw signal.reason;
   * ```
   */
  readonly aborted: boolean;
  /** Cancellation reason propagated to rejected driver operations.
   *
   * ```ts no_run
   * console.log(signal.reason);
   * ```
   */
  readonly reason: unknown;
  /** Subscribe to cancellation events.
   *
   * ```ts no_run
   * signal.addEventListener('abort', onAbort, { once: true });
   * ```
   */
  addEventListener(
    type: string,
    fn: () => void,
    opts?: {
      once?: boolean;
    },
  ): void;
  /** Remove a cancellation listener.
   *
   * ```ts no_run
   * signal.removeEventListener('abort', onAbort);
   * ```
   */
  removeEventListener(type: string, fn: () => void): void;
}
/**
 * Shared client driver options supplied by fetch and pool callers.
 *
 * ```ts no_run
 * const opts: ClientDriverOptions = { signal: null };
 * ```
 */
export interface ClientDriverOptions {
  /** Optional cancellation signal; `null` disables abort racing.
   *
   * ```ts no_run
   * await driver.send(req, reader, writer, { signal: null });
   * ```
   */
  signal: CancelSignal | null;
}
/**
 * Client protocol driver contract for HTTP/1 and HTTP/2.
 *
 * Drivers send one logical request over an already-open connection. Connection
 * pooling, DNS, TLS, redirects, and retries are handled by callers.
 *
 * ```ts no_run
 * const res = await driver.send(req, reader, writer, { signal: null });
 * ```
 */
export interface ClientDriver {
  /**
   * Send one logical request on an already-connected reader/writer pair.
   * Resolves with the parsed Response. Does NOT close the connection — the
   * caller decides lifetime (for pooling).
   *
   * ```ts no_run
   * const response = await driver.send(request, reader, writer, { signal: null });
   * ```
   */
  send(
    req: Request,
    reader: BytesReader,
    writer: BytesWriter,
    opts: ClientDriverOptions,
  ): Promise<Response>;
  /** True if the underlying connection supports multiple concurrent streams.
   *
   * ```ts no_run
   * if (driver.multiplexed) console.log('can share connection');
   * ```
   */
  readonly multiplexed: boolean;
}
// ---------------------------------------------------------------------------
// Connection takeover (WebSocket, etc.)
// ---------------------------------------------------------------------------
/**
 * Interface for anything that hijacks a connection at the protocol level.
 * serve() detects `result instanceof ConnectionTakeover` via isConnectionTakeover()
 * and calls _takeOver(reader, writer).
 *
 * Implementors declare compatibleProtocols. The h2 driver rejects takeovers
 * that do not include 'h2' with a stream RST_STREAM + INTERNAL_ERROR.
 *
 * ```ts no_run
 * const takeover: ConnectionTakeover = WebSocketConnection.accept(req);
 * ```
 */
export interface ConnectionTakeover {
  /** Set of HTTP protocol versions this takeover is compatible with.
   *
   * ```ts no_run
   * if (takeover.compatibleProtocols.has('http/1.1')) return takeover;
   * ```
   */
  readonly compatibleProtocols: ReadonlySet<string>;
  /**
   * Take ownership of the connection's reader/writer. Called by the server
   * driver after it has written any handshake response (e.g. "101 Switching
   * Protocols"). Resolves when the takeover is fully closed.
   *
   * @internal
   *
   * ```ts no_run
   * await takeover._takeOver(reader, writer);
   * ```
   */
  _takeOver(reader: BytesReader, writer: BytesWriter): Promise<void>;
}
/**
 * Duck-type check for ConnectionTakeover. Use instead of instanceof
 * since ConnectionTakeover is an interface.
 *
 * Returns `true` only for objects with a function `_takeOver` and a Set-valued
 * `compatibleProtocols`. It does not validate protocol names.
 *
 * ```ts no_run
 * if (isConnectionTakeover(result)) return result;
 * ```
 */
export function isConnectionTakeover(v: unknown): v is ConnectionTakeover {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>)['_takeOver'] === 'function' &&
    (v as Record<string, unknown>)['compatibleProtocols'] instanceof Set
  );
}
