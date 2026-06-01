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
 *
 * @internal
 */

import { Scanner } from 'fino:parsing/scanner';

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
  let value: unknown;
  try {
    value = JSON.parse(s);
  } catch (error) {
    throw protocolError('invalid JSON');
  }
  if (!isRecord(value)) throw protocolError('protocol envelope must be an object');
  const t = requireString(value, 't');
  switch (t) {
    case 'HELLO':
      return { t, nodeId: parseNodeId(requireString(value, 'nodeId')), load: parseLoad(value.load) };
    case 'WELCOME':
      return { t, nodeId: parseNodeId(requireString(value, 'nodeId')), peers: parsePeers(value.peers) };
    case 'PEER_UP':
      return { t, peer: parsePeer(value.peer, 'peer') };
    case 'PEER_DOWN':
      return { t, nodeId: parseNodeId(requireString(value, 'nodeId')) };
    case 'HEARTBEAT':
      return { t, ts: requireFiniteNumber(value, 'ts') };
    case 'SPAWN':
      return {
        t,
        spawnReqId: parseHandleId(requireString(value, 'spawnReqId'), 'spawnReqId'),
        parentPortId: parseClusterId(requireString(value, 'parentPortId'), 'parentPortId'),
        config: parseSpawnConfig(value.config),
      };
    case 'SPAWN_ACK': {
      const out: ClusterMessage = {
        t,
        spawnReqId: parseHandleId(requireString(value, 'spawnReqId'), 'spawnReqId'),
        childPortId: requireString(value, 'childPortId') === '' ? '' : parseClusterId(requireString(value, 'childPortId'), 'childPortId'),
        ok: requireBoolean(value, 'ok'),
      };
      if (value.error !== undefined) out.error = requireString(value, 'error');
      return out;
    }
    case 'REALM_EXIT': {
      const out: ClusterMessage = { t, realmId: parseClusterId(requireString(value, 'realmId'), 'realmId') };
      if (value.error !== undefined) out.error = requireString(value, 'error');
      return out;
    }
    case 'TERMINATE':
      return { t, realmId: parseClusterId(requireString(value, 'realmId'), 'realmId') };
    case 'PORT_MSG':
      return {
        t,
        fromPort: parseClusterId(requireString(value, 'fromPort'), 'fromPort'),
        toPort: parseClusterId(requireString(value, 'toPort'), 'toPort'),
        payload: requireString(value, 'payload'),
      };
    default:
      throw protocolError(`unknown message type '${t}'`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the nodeId prefix from a realmId or portId (`{nodeId}/...`). */
export function nodeIdFromId(id: string): string {
  const sc = new Scanner(String(id), { encoding: 'utf-8', format: 'cluster-id' });
  const start = sc.mark();
  sc.eatWhile((code) => code !== 0x2F);
  return sc.text(start);
}

function protocolError(message: string): Error {
  return new Error(`cluster protocol: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw protocolError(`${key} must be a string`);
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw protocolError(`${key} must be a boolean`);
  return value;
}

function requireFiniteNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw protocolError(`${key} must be a finite number`);
  return value;
}

function parseLoad(value: unknown): NodeLoad {
  if (!isRecord(value)) throw protocolError('load must be an object');
  const cpu = requireFiniteNumber(value, 'cpu');
  const memory = requireFiniteNumber(value, 'memory');
  if (cpu < 0 || cpu > 1) throw protocolError('load.cpu must be in [0, 1]');
  if (memory < 0) throw protocolError('load.memory must be non-negative');
  return { cpu, memory };
}

function parsePeer(value: unknown, key: string): PeerInfo {
  if (!isRecord(value)) throw protocolError(`${key} must be an object`);
  try {
    return { nodeId: parseNodeId(requireString(value, 'nodeId')), load: parseLoad(value.load) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw protocolError(`${key} is malformed: ${message}`);
  }
}

function parsePeers(value: unknown): PeerInfo[] {
  if (!Array.isArray(value)) throw protocolError('peers must be an array');
  return value.map((peer, index) => parsePeer(peer, `peer ${index}`));
}

function parseSpawnConfig(value: unknown): SerializedSpawnConfig {
  if (!isRecord(value)) throw protocolError('config must be an object');
  const rules = value.rules;
  if (!Array.isArray(rules)) throw protocolError('config.rules must be an array');
  return {
    entry: requireString(value, 'entry'),
    root: requireString(value, 'root'),
    rules,
  };
}

function isIdCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5A) ||
    (code >= 0x61 && code <= 0x7A) ||
    code === 0x2D || code === 0x5F || code === 0x2E;
}

function parseHandleId(id: string, key: string): string {
  const sc = new Scanner(id, { encoding: 'utf-8', format: 'cluster-id' });
  const part = sc.eatWhile(isIdCode);
  if (part === '' || !sc.done) throw protocolError(`${key} is malformed`);
  return id;
}

function parseNodeId(id: string): string {
  parseHandleId(id, 'nodeId');
  if (id.includes('/')) throw protocolError('nodeId must not contain "/"');
  return id;
}

function parseClusterId(id: string, key: string): string {
  const sc = new Scanner(id, { encoding: 'utf-8', format: 'cluster-id' });
  const nodeId = sc.eatWhile(isIdCode);
  if (nodeId === '' || !sc.eatChar('/')) throw protocolError(`${key} is malformed`);
  const local = sc.eatWhile((code) => isIdCode(code) || code === 0x2F);
  if (local === '' || !sc.done) throw protocolError(`${key} is malformed`);
  return id;
}
