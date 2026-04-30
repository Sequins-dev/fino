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
    this.#connections.get(to)?.send(encode(msg));
  }

  broadcast(msg: ClusterMessage): void {
    const data = encode(msg);
    for (const ws of this.#connections.values()) ws.send(data);
  }

  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void {
    const data = encode(msg);
    for (const [nodeId, ws] of this.#connections) {
      if (nodeId !== exceptNodeId) ws.send(data);
    }
  }

  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  close(): void {
    for (const ws of this.#connections.values()) ws.close();
    this.#connections.clear();
    this.#server?.close().catch(() => {});
  }

  #handleConnection(ws: WebSocketConnection): void {
    let peerNodeId: string | null = null;

    (ws as any).addEventListener('message', (ev: { data: unknown }) => {
      try {
        const msg = decode(ev.data as string);
        if (msg.t === 'HELLO') {
          peerNodeId = msg.nodeId;
          this.#connections.set(peerNodeId, ws);
        }
        const from = peerNodeId ?? '__unknown__';
        for (const h of this.#handlers) h(from, msg);
      } catch { /* malformed message — ignore */ }
    });

    (ws as any).addEventListener('close', () => {
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

      (ws as any).addEventListener('open', () => {
        ws.send(encode({ t: 'HELLO', nodeId: this.nodeId, load }));
        resolve();
      });

      (ws as any).addEventListener('message', (ev: { data: unknown }) => {
        try {
          const msg = decode(ev.data as string);
          if (msg.t === 'WELCOME') {
            this.#seedNodeId = msg.nodeId;
          }
          for (const h of this.#handlers) h(this.#seedNodeId, msg);
        } catch { /* malformed message — ignore */ }
      });

      (ws as any).addEventListener('close', () => {
        const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: this.#seedNodeId };
        for (const h of this.#handlers) h(this.#seedNodeId, synth);
      });

      (ws as any).addEventListener('error', () => {
        reject(new Error(`fino:cluster — failed to connect to seed at ${url}`));
      });
    });
  }

  send(_to: string, msg: ClusterMessage): void {
    // All outbound messages go through the seed; routing is done by the seed.
    this.#ws?.send(encode(msg));
  }

  broadcast(_msg: ClusterMessage): void {
    throw new Error('fino:cluster — broadcast is seed-only');
  }

  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }

  close(): void {
    this.#ws?.close();
    this.#ws = null;
  }
}
