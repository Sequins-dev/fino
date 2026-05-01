/**
 * internal:cluster/websocket-transport — WebSocket implementations of ClusterTransport.
 *
 * Two classes cover the two node roles:
 *
 * `WebSocketSeedTransport`   — seed node; accepts incoming WebSocket connections
 *                              from workers; broadcasts to all peers; routes
 *                              send(to) by nodeId.
 *
 * `WebSocketWorkerTransport` — worker node; connects to the seed URL; all
 *                              outbound messages go to the seed which routes them.
 *
 * Both classes emit synthetic PEER_DOWN messages when a connection drops so
 * the routing and registry layers can react without understanding the transport.
 */

import { serve } from 'fino:net/serve';
import { WebSocketConnection } from 'fino:net/websocket';
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

export class WebSocketSeedTransport implements ClusterTransport {
  readonly nodeId: string;

  #port: number;
  #connections = new Map<string, WebSocketConnection>();
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  #server: { close(): Promise<void> } | null = null;

  constructor(nodeId: string, port: number) {
    this.nodeId = nodeId;
    this.#port  = port;
  }

  /** Start accepting WebSocket connections. Non-blocking (serve loop is async). */
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

  send(to: string, msg: ClusterMessage): void {
    const ws = this.#connections.get(to);
    if (ws) asWS(ws).send(encode(msg));
  }

  broadcast(msg: ClusterMessage): void {
    const data = encode(msg);
    for (const ws of this.#connections.values()) asWS(ws).send(data);
  }

  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void {
    const data = encode(msg);
    for (const [nodeId, ws] of this.#connections) {
      if (nodeId !== exceptNodeId) asWS(ws).send(data);
    }
  }

  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  close(): void {
    for (const ws of this.#connections.values()) asWS(ws).close();
    this.#connections.clear();
    this.#server?.close().catch((err: unknown) => {
      console.error(`fino:cluster seed server close error: ${err}`);
    });
  }

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

export class WebSocketWorkerTransport implements ClusterTransport {
  readonly nodeId: string;

  #ws: WebSocketConnection | null = null;
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  #seedNodeId = '__seed__';

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  /** Connect to the seed at the given URL and send HELLO. */
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
        const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: this.#seedNodeId };
        for (const h of this.#handlers) h(this.#seedNodeId, synth);
      });

      typed.addEventListener('error', () => {
        reject(new Error(`fino:cluster — failed to connect to seed at ${url}`));
      });
    });
  }

  send(_to: string, msg: ClusterMessage): void {
    // All outbound messages go through the seed; routing is done by the seed.
    if (this.#ws) asWS(this.#ws).send(encode(msg));
  }

  broadcast(_msg: ClusterMessage): void {
    throw new Error('fino:cluster — broadcast is seed-only');
  }

  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  close(): void {
    if (this.#ws) asWS(this.#ws).close();
    this.#ws = null;
  }
}
