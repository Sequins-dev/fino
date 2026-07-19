/**
* Cluster membership wire protocol.
*
* Realm scheduling is intentionally absent. These messages establish a live
* peer view over the QUIC/WebTransport mesh; distributed orchestration messages
* will be introduced with the cluster allocator rather than as a second Realm
* implementation.
*
* @internal
*/

/** Default membership heartbeat interval. @internal */
export const HEARTBEAT_INTERVAL_MS = 2500;
/** Default timeout for a silent member. @internal */
export const HEARTBEAT_TIMEOUT_MS = 7500;

/** One node in the seed's membership view. */
export interface PeerInfo {
  /** Stable node identifier without `/`. */
  nodeId: string;
}

/** Messages exchanged by cluster membership transports. */
export type ClusterMessage = {
  t: 'HELLO';
  nodeId: string;
} | {
  t: 'WELCOME';
  nodeId: string;
  peers: PeerInfo[];
} | {
  t: 'PEER_UP';
  peer: PeerInfo;
} | {
  t: 'PEER_DOWN';
  nodeId: string;
} | {
  t: 'HEARTBEAT';
  ts: number;
};

/** Encode a cluster membership message as JSON. */
export function encode(message: ClusterMessage): string {
  return JSON.stringify(message);
}

/**
* Decode and validate a cluster membership message.
*
* The result is reconstructed field by field so unknown wire properties are
* not propagated to higher layers.
*/
export function decode(source: string): ClusterMessage {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw protocolError('invalid JSON');
  }
  if (!isRecord(value)) throw protocolError('protocol envelope must be an object');
  const type = requireString(value, 't');
  switch (type) {
    case 'HELLO':
      return {
        t: type,
        nodeId: parseNodeId(requireString(value, 'nodeId'))
      };
    case 'WELCOME':
      return {
        t: type,
        nodeId: parseNodeId(requireString(value, 'nodeId')),
        peers: parsePeers(value.peers)
      };
    case 'PEER_UP':
      return { t: type, peer: parsePeer(value.peer) };
    case 'PEER_DOWN':
      return { t: type, nodeId: parseNodeId(requireString(value, 'nodeId')) };
    case 'HEARTBEAT':
      return { t: type, ts: requireFiniteNumber(value, 'ts') };
    default:
      throw protocolError(`unknown message type '${type}'`);
  }
}

function protocolError(message: string): Error {
  return new Error(`cluster protocol: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw protocolError(`${key} must be a string`);
  return field;
}

function requireFiniteNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field)) {
    throw protocolError(`${key} must be a finite number`);
  }
  return field;
}

function parseNodeId(value: string): string {
  if (value.length === 0 || value.includes('/')) {
    throw protocolError('nodeId must be a non-empty bare identifier');
  }
  return value;
}

function parsePeer(value: unknown): PeerInfo {
  if (!isRecord(value)) throw protocolError('peer must be an object');
  return {
    nodeId: parseNodeId(requireString(value, 'nodeId'))
  };
}

function parsePeers(value: unknown): PeerInfo[] {
  if (!Array.isArray(value)) throw protocolError('peers must be an array');
  return value.map(parsePeer);
}
