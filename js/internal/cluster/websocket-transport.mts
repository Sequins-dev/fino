/**
 * internal:cluster/websocket-transport - WebSocket implementations of ClusterTransport.
 *
 * Two classes cover the two node roles:
 *
 * `WebSocketSeedTransport`   - seed node; accepts incoming WebSocket connections
 *                              from workers; broadcasts to all peers; routes
 *                              send(to) by nodeId.
 *
 * `WebSocketWorkerTransport` - worker node; connects to the seed URL; all
 *                              outbound messages go to the seed which routes them.
 *
 * Both classes emit synthetic PEER_DOWN messages when a connection drops so
 * the routing and registry layers can react without understanding the transport.
 *
 * ## Example
 *
 * ```ts no_run
 * import {
 *   WebSocketSeedTransport,
 *   WebSocketWorkerTransport,
 * } from 'internal:cluster/websocket-transport';
 *
 * const seed = new WebSocketSeedTransport('__seed__', 8787);
 * seed.listen();
 *
 * const worker = new WebSocketWorkerTransport('worker-a');
 * await worker.connect('ws://127.0.0.1:8787');
 * ```
 *
 * @internal
 */

import { serve } from 'fino:net/http/server';
import { WebSocketConnection } from 'fino:net/http/websocket';
import type { Request } from 'fino:net/http';
import { Response } from 'fino:net/http';

// Minimal typed interface for WebSocket event handling that avoids the DOM/fino
// EventTarget mismatch. WebSocketConnection extends fino's EventTarget, but
// TypeScript resolves addEventListener's callback type against the DOM ambient
// lib. Casting to this interface suppresses the mismatch without losing safety.
interface WSEventTarget {
  addEventListener(type: string, listener: (ev: { data?: unknown; code?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}
function asWS(ws: WebSocketConnection): WSEventTarget {
  return ws as unknown as WSEventTarget;
}
import type { ClusterTransport } from './transport.mts';
import { encode, decode, type ClusterMessage } from './protocol.mts';

// ---------------------------------------------------------------------------
// Seed transport
// ---------------------------------------------------------------------------

/**
 * Seed-side WebSocket transport for cluster workers.
 *
 * The transport accepts WebSocket upgrades, records each peer after its
 * `HELLO`, and emits decoded messages to registered handlers. Malformed
 * incoming frames are logged and dropped rather than thrown through the server
 * loop.
 *
 * ```ts no_run
 * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
 * const seedTransport = new WebSocketSeedTransport('__seed__', 8787);
 * seedTransport.listen();
 * ```
 *
 * @internal
 */
export class WebSocketSeedTransport implements ClusterTransport {
  /**
   * Local seed node ID.
   *
   * This value is sent in `WELCOME` messages by the seed server and used by
   * workers as the source ID for control-plane messages.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * new WebSocketSeedTransport('__seed__', 8787).nodeId;
   * ```
   */
  readonly nodeId: string;

  /**
   * Private property `#port` used by `WebSocketSeedTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #port = undefined;
   *
   *   readInternalState() {
   *     return this.#port;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #port: number;
  /**
   * Private property `#connections` used by `WebSocketSeedTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #connections = undefined;
   *
   *   readInternalState() {
   *     return this.#connections;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #connections = new Map<string, WebSocketConnection>();
  /**
   * Private property `#handlers` used by `WebSocketSeedTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handlers = undefined;
   *
   *   readInternalState() {
   *     return this.#handlers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  /**
   * Private property `#server` used by `WebSocketSeedTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #server = undefined;
   *
   *   readInternalState() {
   *     return this.#server;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #server: { close(): Promise<void> } | null = null;

  /**
   * Create a seed transport bound to a TCP port.
   *
   * Construction does not bind the port. Call `listen()` to start the HTTP
   * server that accepts WebSocket upgrades.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * ```
   */
  constructor(nodeId: string, port: number) {
    this.nodeId = nodeId;
    this.#port  = port;
  }

  /**
   * Start accepting WebSocket connections.
   *
   * Non-WebSocket requests receive a plain `200` response. The method is
   * non-blocking because the HTTP serve loop runs asynchronously; repeated
   * calls replace the stored server handle without closing the previous one.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.listen();
   * ```
   */
  listen(): void {
    this.#server = serve({ port: this.#port }, (req: Request) => {
      const upgrade = req.headers.get('upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('fino cluster seed', { status: 200 });
      }
      const ws = WebSocketConnection.accept(req as any);
      this.#handleConnection(ws);
      return ws;
    });
  }

  /**
   * Send one cluster message to a connected worker node.
   *
   * If the peer is missing or the socket closes during send, the message is
   * dropped. Connection-close handling emits a synthetic `PEER_DOWN` separately.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.send('worker-1', { t: 'HEARTBEAT', ts: Date.now() });
   * ```
   */
  send(to: string, msg: ClusterMessage): void {
    const ws = this.#connections.get(to);
    if (!ws) return;
    try { asWS(ws).send(encode(msg)); }
    catch (_) { /* socket closed between lookup and send - ignore */ }
  }

  /**
   * Broadcast one encoded message to all connected workers.
   *
   * Closed sockets are skipped and do not stop delivery to remaining peers.
   * The seed itself does not receive the broadcast.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.broadcast({ t: 'PEER_DOWN', nodeId: 'worker-1' });
   * ```
   */
  broadcast(msg: ClusterMessage): void {
    const data = encode(msg);
    for (const ws of this.#connections.values()) {
      try { asWS(ws).send(data); }
      catch (_) { /* closed socket - continue to remaining peers */ }
    }
  }

  /**
   * Broadcast to every connected worker except one node ID.
   *
   * This helper is seed-specific and is used for membership notifications so a
   * joining or leaving peer does not receive its own event.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.broadcastExcept('worker-1', { t: 'PEER_UP', peer: { nodeId: 'worker-2', load: { cpu: 0, memory: 0 } } });
   * ```
   *
   * @internal
   */
  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void {
    const data = encode(msg);
    for (const [nodeId, ws] of this.#connections) {
      if (nodeId !== exceptNodeId) {
        try { asWS(ws).send(data); }
        catch (_) { /* closed socket - continue */ }
      }
    }
  }

  /**
   * Register an incoming-message handler.
   *
   * Handlers are retained for the life of the transport and are called in
   * registration order. There is no unregister operation.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.on((from, msg) => { void from; void msg; });
   * ```
   */
  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  /**
   * Close all worker sockets and the underlying HTTP server.
   *
   * Server close errors are logged. The method clears the connection map
   * synchronously and should be treated as terminal for this transport.
   *
   * ```ts no_run
   * import { WebSocketSeedTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketSeedTransport('__seed__', 8787);
   * transport.close();
   * ```
   */
  close(): void {
    for (const ws of this.#connections.values()) asWS(ws).close();
    this.#connections.clear();
    this.#server?.close().catch((err: unknown) => {
      console.error(`fino:cluster seed server close error: ${err}`);
    });
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /**
   * Private method `#handleConnection` used by `WebSocketSeedTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handleConnection() {
   *     return 'handleConnection';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#handleConnection();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handleConnection(ws: WebSocketConnection): void {
    let peerNodeId: string | null = null;
    const typed = asWS(ws);

    typed.addEventListener('message', (ev) => {
      try {
        const msg = decode(ev.data as string);
        if (msg.t === 'HELLO') {
          peerNodeId = msg.nodeId;
          this.#connections.set(peerNodeId, ws);
        }
        const from = peerNodeId ?? '__unknown__';
        for (const h of this.#handlers) h(from, msg);
      } catch (err: unknown) {
        console.error(`fino:cluster seed received malformed message: ${err}`);
      }
    });

    typed.addEventListener('close', () => {
      if (peerNodeId) {
        this.#connections.delete(peerNodeId);
        const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: peerNodeId };
        for (const h of this.#handlers) h(peerNodeId, synth);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Worker transport
// ---------------------------------------------------------------------------

/**
 * Worker-side WebSocket transport that connects to the cluster seed.
 *
 * A worker has exactly one WebSocket connection. All `send()` calls write to
 * the seed; the seed is responsible for routing messages onward to the target
 * node. On close, the transport emits a synthetic `PEER_DOWN` for the seed.
 *
 * ```ts no_run
 * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
 * const transport = new WebSocketWorkerTransport('worker-1');
 * await transport.connect('ws://127.0.0.1:8787');
 * ```
 *
 * @internal
 */
export class WebSocketWorkerTransport implements ClusterTransport {
  /**
   * Local worker node ID sent in the initial `HELLO`.
   *
   * The constructor stores this value as-is. It should be a bare cluster node
   * ID with no slash so protocol validation succeeds.
   *
   * ```ts
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * new WebSocketWorkerTransport('worker-1').nodeId;
   * ```
   */
  readonly nodeId: string;

  /**
   * Private property `#ws` used by `WebSocketWorkerTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ws = undefined;
   *
   *   readInternalState() {
   *     return this.#ws;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ws: WebSocketConnection | null = null;
  /**
   * Private property `#handlers` used by `WebSocketWorkerTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handlers = undefined;
   *
   *   readInternalState() {
   *     return this.#handlers;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  /**
   * Private property `#seedNodeId` used by `WebSocketWorkerTransport`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #seedNodeId = undefined;
   *
   *   readInternalState() {
   *     return this.#seedNodeId;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #seedNodeId = '__seed__';

  /**
   * Create an unconnected worker transport.
   *
   * Call `connect()` before sending messages. Until connected, `send()` is a
   * no-op and `broadcast()` still throws because workers cannot broadcast.
   *
   * ```ts
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * ```
   */
  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /**
   * Connect to the seed at the given URL and send `HELLO`.
   *
   * `load` defaults to `{ cpu: 0, memory: 0 }`. The returned promise resolves
   * when the WebSocket opens and the `HELLO` frame is sent; it rejects on the
   * socket error event. The seed node ID is updated after `WELCOME`.
   *
   * ```ts no_run
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * await transport.connect('ws://127.0.0.1:8787', { cpu: 0.2, memory: 1024 });
   * ```
   */
  connect(url: string, load: { cpu: number; memory: number } = { cpu: 0, memory: 0 }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = WebSocketConnection.connect(url);
      this.#ws = ws;
      const typed = asWS(ws);

      typed.addEventListener('open', () => {
        asWS(ws).send(encode({ t: 'HELLO', nodeId: this.nodeId, load }));
        resolve();
      });

      typed.addEventListener('message', (ev) => {
        try {
          const msg = decode(ev.data as string);
          if (msg.t === 'WELCOME') {
            this.#seedNodeId = msg.nodeId;
          }
          for (const h of this.#handlers) h(this.#seedNodeId, msg);
        } catch (err: unknown) {
          console.error(`fino:cluster worker received malformed message: ${err}`);
        }
      });

      typed.addEventListener('close', () => {
        this.#ws = null; // prevent send() on a closed socket
        const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: this.#seedNodeId };
        for (const h of this.#handlers) h(this.#seedNodeId, synth);
      });

      typed.addEventListener('error', () => {
        reject(new Error(`fino:cluster — failed to connect to seed at ${url}`));
      });
    });
  }

  /**
   * Send a message through the seed connection.
   *
   * The `to` argument is ignored by this implementation because the seed reads
   * the message and routes it. If the socket is closed or closing, the send is
   * dropped.
   *
   * ```ts no_run
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * transport.send('__seed__', { t: 'HEARTBEAT', ts: Date.now() });
   * ```
   */
  send(_to: string, msg: ClusterMessage): void {
    // All outbound messages go through the seed; routing is done by the seed.
    if (!this.#ws) return;
    try { asWS(this.#ws).send(encode(msg)); }
    catch (_) { /* connection dropped - ignore; close handler will emit PEER_DOWN */ }
  }

  /**
   * Reject worker-side broadcast attempts.
   *
   * Workers have a single upstream connection and cannot enumerate peers, so
   * this method always throws `Error`.
   *
   * ```ts
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * try { transport.broadcast({ t: 'HEARTBEAT', ts: 1 }); } catch (error) { void error; }
   * ```
   */
  broadcast(_msg: ClusterMessage): void {
    throw new Error('fino:cluster — broadcast is seed-only');
  }

  /**
   * Register an incoming-message handler.
   *
   * Handlers receive the seed node ID as `from` for all messages. Before
   * `WELCOME`, the placeholder source is `__seed__`.
   *
   * ```ts
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * transport.on((from, msg) => { void from; void msg; });
   * ```
   */
  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  /**
   * Close the worker WebSocket if it is open.
   *
   * The method clears the stored socket reference immediately. Registered
   * handlers may also receive a synthetic `PEER_DOWN` from the close event.
   *
   * ```ts
   * import { WebSocketWorkerTransport } from 'internal:cluster/websocket-transport';
   * const transport = new WebSocketWorkerTransport('worker-1');
   * transport.close();
   * ```
   */
  close(): void {
    if (this.#ws) asWS(this.#ws).close();
    this.#ws = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
