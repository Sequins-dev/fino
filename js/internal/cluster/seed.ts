/**
* Seed-side cluster membership coordinator.
*
* The seed admits peers, distributes membership changes, and expires silent
* nodes. It does not place or host realms; that responsibility belongs to
* orchestration and its future distributed allocator adapter.
*
* @internal
*/
import type { ClusterSeedTransport } from './transport.ts';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, type ClusterMessage } from './protocol.ts';
import { env } from 'internal:process';

function envMs(name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Coordinates membership for nodes connected to the seed transport. */
export class SeedServer {
  #transport: ClusterSeedTransport;
  #peers = new Set<string>();
  #lastSeen = new Map<string, number>();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  constructor(transport: ClusterSeedTransport) {
    this.#transport = transport;
  }

  /** Start accepting peers and checking their heartbeats. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#transport.on((from, message) => this.#handle(from, message));
    await this.#transport.listen();
    this.#heartbeatTimer = setInterval(
      () => this.#checkHeartbeats(),
      envMs('FINO_CLUSTER_HEARTBEAT_INTERVAL_MS', HEARTBEAT_INTERVAL_MS)
    );
  }

  /** Stop membership coordination and close the seed transport. */
  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#started = false;
    this.#peers.clear();
    this.#lastSeen.clear();
    this.#transport.close();
  }

  /** Run one heartbeat sweep for deterministic tests. @internal */
  _checkHeartbeatsForTest(): void {
    this.#checkHeartbeats();
  }

  #handle(from: string, message: ClusterMessage): void {
    switch (message.t) {
      case 'HELLO': {
        this.#peers.add(from);
        this.#lastSeen.set(from, Date.now());
        this.#transport.send(from, {
          t: 'WELCOME',
          nodeId: this.#transport.nodeId,
          peers: [...this.#peers].map((nodeId) => ({ nodeId }))
        });
        this.#transport.broadcastExcept(from, {
          t: 'PEER_UP',
          peer: { nodeId: from }
        });
        break;
      }
      case 'PEER_DOWN':
        this.#removePeer(from);
        break;
      case 'HEARTBEAT':
        if (this.#peers.has(from)) this.#lastSeen.set(from, Date.now());
        break;
      default:
        break;
    }
  }

  #removePeer(nodeId: string): void {
    const existed = this.#peers.delete(nodeId);
    this.#lastSeen.delete(nodeId);
    if (existed) this.#transport.broadcastExcept(nodeId, { t: 'PEER_DOWN', nodeId });
  }

  #checkHeartbeats(): void {
    const now = Date.now();
    const timeout = envMs('FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS);
    for (const [nodeId, lastSeen] of this.#lastSeen) {
      if (now - lastSeen > timeout) this.#removePeer(nodeId);
    }
  }
}
