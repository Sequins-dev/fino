/**
* Worker-side cluster membership client.
*
* This layer deliberately owns no realm lifecycle. Realm placement and
* execution belong to orchestration; the cluster client only maintains the
* peer view that a future distributed allocator can consume.
*
* @internal
*/
import type { ClusterTransport } from './transport.ts';
import { type ClusterMessage, type PeerInfo } from './protocol.ts';
import { HEARTBEAT_INTERVAL_MS } from './protocol.ts';

/**
* Tracks cluster membership and sends liveness heartbeats to the seed.
*
* Construct the client after its transport has connected, then call `start()`.
* The `peers` getter returns a snapshot and never exposes the mutable map.
*
* @internal
*/
export class ClusterClient {
  readonly nodeId: string;
  #transport: ClusterTransport;
  #peers = new Map<string, PeerInfo>();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #started = false;

  constructor(transport: ClusterTransport, nodeId: string) {
    this.#transport = transport;
    this.nodeId = nodeId;
  }

  /** Current cluster members known through the seed. */
  get peers(): PeerInfo[] {
    return [...this.#peers.values()];
  }

  /** Start membership updates and periodic liveness heartbeats. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#transport.on((_from, message) => this.#handle(message));
    this.#heartbeatTimer = setInterval(() => {
      this.#transport.send('__seed__', {
        t: 'HEARTBEAT',
        ts: Date.now()
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Stop heartbeats, clear membership, and close the transport. */
  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#started = false;
    this.#peers.clear();
    this.#transport.close();
  }

  #handle(message: ClusterMessage): void {
    switch (message.t) {
      case 'WELCOME':
        this.#peers.clear();
        for (const peer of message.peers) this.#peers.set(peer.nodeId, peer);
        break;
      case 'PEER_UP':
        this.#peers.set(message.peer.nodeId, message.peer);
        break;
      case 'PEER_DOWN':
        this.#peers.delete(message.nodeId);
        break;
      default:
        break;
    }
  }
}
