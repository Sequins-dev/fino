/**
 * fino:net/http/driver — shared interfaces for HTTP server and client drivers.
 *
 * Both H1ServerDriver and H2ServerDriver implement ServerDriver. Both
 * H1ClientDriver and H2ClientDriver implement ClientDriver. serve() and
 * fetch() dispatch to the right driver based on ALPN negotiation or h2c
 * preface detection.
 *
 * ConnectionTakeover is the base class for protocol-level connection hijacks
 * (e.g. WebSocket). The h1 driver checks `result instanceof ConnectionTakeover`
 * and calls _takeOver(reader, writer). The h2 driver additionally checks
 * compatibleProtocols before allowing the upgrade.
 */

import type { BytesReader, BytesWriter } from '../../internal/stream.mts';
import type { Request, Response, Headers } from './index.mts';

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

export type ServerResult = Response | ConnectionTakeover;

export type ServerHandler = (req: Request) => ServerResult | Promise<ServerResult>;

export interface ServerDriverOptions {
  /** Max concurrent in-flight requests / streams. */
  maxConcurrent: number;
  /** If true, recognise the h2c Upgrade dance in H1 driver. */
  allowH2cUpgrade?: boolean;
}

export interface ServerDriver {
  /**
   * Process one accepted connection. Resolves when the connection is fully
   * closed (all in-flight requests done, buffers flushed).
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

export interface CancelSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface ClientDriverOptions {
  signal: CancelSignal | null;
}

export interface ClientDriver {
  /**
   * Send one logical request on an already-connected reader/writer pair.
   * Resolves with the parsed Response. Does NOT close the connection — the
   * caller decides lifetime (for pooling).
   */
  send(
    req: Request,
    reader: BytesReader,
    writer: BytesWriter,
    opts: ClientDriverOptions,
  ): Promise<Response>;

  /** True if the underlying connection supports multiple concurrent streams. */
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
 */
export interface ConnectionTakeover {
  /** Set of HTTP protocol versions this takeover is compatible with. */
  readonly compatibleProtocols: ReadonlySet<string>;

  /**
   * Take ownership of the connection's reader/writer. Called by the server
   * driver after it has written any handshake response (e.g. "101 Switching
   * Protocols"). Resolves when the takeover is fully closed.
   *
   * @internal
   */
  _takeOver(reader: BytesReader, writer: BytesWriter): Promise<void>;
}

/**
 * Duck-type check for ConnectionTakeover. Use instead of instanceof
 * since ConnectionTakeover is an interface.
 */
export function isConnectionTakeover(v: unknown): v is ConnectionTakeover {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>)['_takeOver'] === 'function' &&
    (v as Record<string, unknown>)['compatibleProtocols'] instanceof Set
  );
}
