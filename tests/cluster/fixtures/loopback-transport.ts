/**
 * In-memory ClusterTransport for cluster tests.
 *
 * LoopbackTransport pairs two transport instances so that messages sent
 * on one are delivered to the other synchronously (via a queued task),
 * with no real network or file descriptors. This lets cluster tests run
 * fully in-process without spawning OS processes or WebTransport servers.
 *
 * Usage:
 *   const [a, b] = LoopbackTransport.pair('nodeA', 'nodeB');
 *   // a.send('nodeB', msg) delivers to b's handlers
 *   // b.send('nodeA', msg) delivers to a's handlers
 */
import type { ClusterTransport } from 'internal:cluster/transport';
import type { ClusterMessage } from 'internal:cluster/protocol';
export class LoopbackTransport implements ClusterTransport {
  readonly nodeId: string;
  #peer: LoopbackTransport | null = null;
  #handlers: ((from: string, msg: ClusterMessage) => void)[] = [];
  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }
  static pair(nodeIdA: string, nodeIdB: string): [LoopbackTransport, LoopbackTransport] {
    const a = new LoopbackTransport(nodeIdA);
    const b = new LoopbackTransport(nodeIdB);
    a.#peer = b;
    b.#peer = a;
    return [a, b];
  }
  send(_to: string, msg: ClusterMessage): void {
    const peer = this.#peer;
    if (!peer) return;
    const from = this.nodeId;
    const handlers = peer.#handlers.slice();
    // Deliver via a microtask so the call stack unwinds first.
    Promise.resolve().then(() => {
      for (const h of handlers) h(from, msg);
    });
  }
  broadcast(msg: ClusterMessage): void {
    this.send('__all__', msg);
  }
  on(handler: (from: string, msg: ClusterMessage) => void): void {
    this.#handlers.push(handler);
  }
  async close(): Promise<void> {
    this.#handlers = [];
    this.#peer = null;
  }
}
