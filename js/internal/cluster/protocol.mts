/**
 * internal:cluster/protocol — cluster wire types and JSON codec.
 *
 * All cluster messages are JSON-encoded ClusterMessage values. The codec
 * layer is deliberately thin: encode/decode are just JSON.stringify/parse
 * so the transport can switch to binary (QUIC, CBOR) later without changing
 * the protocol layer.
 *
 * Realm IDs use the format `{nodeId}/{localHandle}`, which encodes the host
 * node for O(1) routing: extract the nodeId prefix to find the host.
 *
 * Port IDs use the format `{nodeId}/p-{handle}` and are used for PORT_MSG
 * routing. Each ClusterPort on the parent side has a unique portId; the
 * SPAWN message carries `parentPortId` so the child relay knows where to
 * address PORT_MSG.
 */

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface NodeLoad {
  /** CPU utilisation in [0, 1]. */
  cpu: number;
  /** Resident memory in bytes. */
  memory: number;
}

export interface PeerInfo {
  nodeId: string;
  load: NodeLoad;
}

/** Serialized rule list + entry path sent with SPAWN. Matches Rust's ImportRule JSON layout. */
export interface SerializedSpawnConfig {
  entry: string;
  root: string;
  rules: unknown[];
}

// ---------------------------------------------------------------------------
// Message union
// ---------------------------------------------------------------------------

export type ClusterMessage =
  // Membership
  | { t: 'HELLO';      nodeId: string; load: NodeLoad }
  | { t: 'WELCOME';    nodeId: string; peers: PeerInfo[] }
  | { t: 'PEER_UP';    peer: PeerInfo }
  | { t: 'PEER_DOWN';  nodeId: string }
  | { t: 'HEARTBEAT';  ts: number }
  // Realm lifecycle
  | { t: 'SPAWN';      spawnReqId: string; parentPortId: string; config: SerializedSpawnConfig }
  | { t: 'SPAWN_ACK';  spawnReqId: string; childPortId: string; ok: boolean; error?: string }
  | { t: 'REALM_EXIT'; realmId: string; error?: string }
  | { t: 'TERMINATE';  realmId: string }
  // Data plane: all inter-realm messages (PORT_MSG carries __rpc_req/__rpc_res payloads too)
  | { t: 'PORT_MSG'; fromPort: string; toPort: string; payload: string };

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export function encode(msg: ClusterMessage): string {
  return JSON.stringify(msg);
}

export function decode(s: string): ClusterMessage {
  return JSON.parse(s) as ClusterMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the nodeId prefix from a realmId or portId (`{nodeId}/...`). */
export function nodeIdFromId(id: string): string {
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(0, slash);
}
