/**
 * internal:cluster/protocol - cluster wire types and JSON codec.
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
 * Decoding is strict and reconstructive: `decode()` rebuilds each message from
 * scratch, so fields that are not part of the protocol (auth tokens, transport
 * negotiation flags, anything a peer smuggles in) are silently dropped rather
 * than forwarded. Every validation failure throws a plain `Error` whose
 * message starts with `cluster protocol:`.
 *
 * ## Example
 *
 * ```ts no_run
 * import { encode, decode, nodeIdFromId } from 'internal:cluster/protocol';
 *
 * const frame = encode({
 *   t: 'PORT_MSG',
 *   fromPort: 'worker-a/p-parent',
 *   toPort: 'worker-b/p-child',
 *   payload: '[]',
 * });
 *
 * const message = decode(frame);
 * if (message.t === 'PORT_MSG') {
 *   const hostNode = nodeIdFromId(message.toPort);
 *   void hostNode;
 * }
 * ```
 *
 * @internal
 */
import { Scanner } from 'fino:parsing/scanner';
// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------
/**
 * Runtime load sample advertised by a cluster node.
 *
 * Load samples travel in `HELLO` messages and in the `PeerInfo` entries of
 * `WELCOME` and `PEER_UP`. The seed uses them as a routing hint when choosing
 * a target for remote realm spawns. Values are trusted only within the cluster
 * control plane; the decoder rejects malformed or out-of-range samples.
 *
 * ```ts no_run
 * import { encode } from 'internal:cluster/protocol';
 *
 * encode({
 *   t: 'HELLO',
 *   nodeId: 'worker-1',
 *   load: { cpu: 0.25, memory: 512 * 1024 * 1024 },
 * });
 * ```
 *
 * @internal
 */
export interface NodeLoad {
  /**
   * CPU utilisation in the inclusive range `[0, 1]`.
   *
   * `0` means idle and `1` means fully saturated. The protocol decoder throws
   * if the value is not finite or falls outside the range.
   *
   * ```ts
   * const load = { cpu: 0.25, memory: 32 * 1024 * 1024 };
   * load.cpu;
   * ```
   */
  cpu: number;
  /**
   * Resident memory in bytes.
   *
   * The value defaults only at the caller layer; the wire decoder requires a
   * finite, non-negative number and rejects missing or negative memory samples.
   *
   * ```ts
   * const load = { cpu: 0, memory: 0 };
   * load.memory;
   * ```
   */
  memory: number;
}
/**
 * Cluster membership record for one peer node.
 *
 * Peer lists are delivered in `WELCOME` messages and individual changes are
 * delivered as `PEER_UP` or `PEER_DOWN`. `nodeId` is validated as a bare handle
 * without `/`; malformed IDs cause `decode()` to throw.
 *
 * ```ts
 * const peer = { nodeId: 'worker-1', load: { cpu: 0.1, memory: 1024 } };
 * peer.nodeId;
 * ```
 *
 * @internal
 */
export interface PeerInfo {
  /**
   * Bare node identifier used for routing.
   *
   * The ID must contain only cluster handle characters and must not contain a
   * slash. It is not a realm or port ID.
   *
   * ```ts
   * const peer = { nodeId: 'node-a', load: { cpu: 0, memory: 0 } };
   * peer.nodeId;
   * ```
   */
  nodeId: string;
  /**
   * Last advertised resource load for the peer.
   *
   * The seed currently prefers the lowest `cpu` value for new remote spawns;
   * memory is carried for future policies and diagnostics.
   *
   * ```ts
   * const peer = { nodeId: 'node-a', load: { cpu: 0.5, memory: 4096 } };
   * peer.load.cpu;
   * ```
   */
  load: NodeLoad;
}
/**
 * Serialized realm spawn configuration carried by a `SPAWN` message.
 *
 * The object mirrors Rust's import-rule JSON layout. `decode()` validates only
 * the top-level shape because individual rules are opaque to the cluster layer
 * and are interpreted by the realm loader on the target node.
 *
 * ```ts
 * const config = { entry: '/app/main.ts', root: '/app', rules: [] };
 * config.rules.length;
 * ```
 *
 * @internal
 */
export interface SerializedSpawnConfig {
  /**
   * Entry module path for the child realm.
   *
   * The path is passed through unchanged to `createThreadContext`; resolution
   * failures happen when the target node starts the realm, not during protocol
   * decoding.
   *
   * ```ts
   * const config = { entry: '/app/main.ts', root: '/app', rules: [] };
   * config.entry;
   * ```
   */
  entry: string;
  /**
   * Root path used by the target realm loader.
   *
   * Empty strings are accepted by the protocol and have the same meaning as the
   * caller layer assigns when spawning a local realm.
   *
   * ```ts
   * const config = { entry: 'main.ts', root: '', rules: [] };
   * config.root;
   * ```
   */
  root: string;
  /**
   * Opaque serialized import-rule array.
   *
   * The protocol requires an array but does not inspect its members. Invalid
   * rule contents may still fail later when the child realm is created.
   *
   * ```ts
   * const config = { entry: 'main.ts', root: '.', rules: [] };
   * Array.isArray(config.rules);
   * ```
   */
  rules: unknown[];
  /**
   * Optional runtime bootstrap metadata for the target realm.
   *
   * The cluster layer treats this value as opaque JSON. The target node
   * serializes it for `internal:realm-bridge.getRealmBootstrapData()` when it
   * creates the child thread realm.
   *
   * ```ts
   * const config = { entry: 'main.ts', root: '.', rules: [], bootstrapData: { cliOtel: { endpoint: 'http://127.0.0.1:4318' } } };
   * config.bootstrapData;
   * ```
   */
  bootstrapData?: unknown;
}
// ---------------------------------------------------------------------------
// Message union
// ---------------------------------------------------------------------------
/**
 * Complete cluster control-plane and data-plane message union.
 *
 * The `t` discriminator identifies the message shape. Control messages manage
 * membership and realm lifecycle, while `PORT_MSG` carries an opaque serialized
 * payload between ports. `decode()` returns this union or throws a protocol
 * error when required fields are missing or malformed.
 *
 * Message roles:
 *
 * - `HELLO` — a joining node introduces itself to the seed with its node ID
 *   and current load sample.
 * - `WELCOME` — the seed's reply to `HELLO`, carrying the seed's own node ID
 *   and the current peer list.
 * - `PEER_UP` / `PEER_DOWN` — membership deltas broadcast by the seed when a
 *   node joins or leaves.
 * - `HEARTBEAT` — periodic liveness signal from each node to the seed; `ts`
 *   is the sender's clock in milliseconds.
 * - `SPAWN` — request to create a realm on another node, routed through the
 *   seed. `spawnReqId` correlates the eventual ack, and `parentPortId` tells
 *   the target's relay where to address child-to-parent `PORT_MSG` traffic.
 * - `SPAWN_ACK` — the target node's response to `SPAWN`. On success `ok` is
 *   true and `childPortId` identifies the child's port; on failure `ok` is
 *   false, `childPortId` is the empty string, and `error` explains why.
 * - `REALM_EXIT` — sent by the hosting node when a spawned realm terminates,
 *   with `error` set if it exited abnormally.
 * - `TERMINATE` — request to kill a realm on its hosting node; the seed also
 *   emits this to descendants when an ancestor realm exits.
 * - `PORT_MSG` — data-plane frame between two ports. `payload` is an opaque
 *   serialized string; the protocol layer never inspects it.
 *
 * ```ts
 * import { decode } from 'internal:cluster/protocol';
 * const msg = decode('{"t":"HEARTBEAT","ts":1}');
 * msg.t;
 * ```
 *
 * @internal
 */
export type ClusterMessage =
  | {
      t: 'HELLO';
      nodeId: string;
      load: NodeLoad;
    }
  | {
      t: 'WELCOME';
      nodeId: string;
      peers: PeerInfo[];
    }
  | {
      t: 'PEER_UP';
      peer: PeerInfo;
    }
  | {
      t: 'PEER_DOWN';
      nodeId: string;
    }
  | {
      t: 'HEARTBEAT';
      ts: number;
    }
  | {
      t: 'SPAWN';
      spawnReqId: string;
      parentPortId: string;
      config: SerializedSpawnConfig;
    }
  | {
      t: 'SPAWN_ACK';
      spawnReqId: string;
      childPortId: string;
      ok: boolean;
      error?: string;
    }
  | {
      t: 'REALM_EXIT';
      realmId: string;
      error?: string;
    }
  | {
      t: 'TERMINATE';
      realmId: string;
    }
  | {
      t: 'PORT_MSG';
      fromPort: string;
      toPort: string;
      payload: string;
    };
// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------
/**
 * Encode a validated cluster message object as JSON.
 *
 * This function intentionally performs no additional validation; callers that
 * need wire validation should round-trip through `decode()`. The return value
 * is a UTF-16 JavaScript string suitable for WebTransport JSON frames.
 *
 * ```ts
 * import { encode } from 'internal:cluster/protocol';
 * const text = encode({ t: 'HEARTBEAT', ts: 1 });
 * JSON.parse(text).t;
 * ```
 *
 * @internal
 */
export function encode(msg: ClusterMessage): string {
  return JSON.stringify(msg);
}
/**
 * Decode and validate a JSON cluster message.
 *
 * The function returns a narrowed `ClusterMessage` object on success and throws
 * `Error` with a `cluster protocol:` prefix for invalid JSON, unknown message
 * types, malformed IDs, invalid load samples, or missing fields. No defaults
 * are applied.
 *
 * The result is rebuilt field by field rather than returned as the parsed JSON
 * object, so any properties outside the protocol schema are discarded — a peer
 * cannot smuggle extra fields through the decoder. One shape-specific
 * exception applies to ID validation: a `SPAWN_ACK` may carry an empty
 * `childPortId`, which is how a failed spawn (`ok: false`) is represented.
 *
 * ```ts
 * import { decode } from 'internal:cluster/protocol';
 * const msg = decode('{"t":"PEER_DOWN","nodeId":"worker-1"}');
 * msg.t;
 * ```
 *
 * @internal
 */
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
      return {
        t,
        nodeId: parseNodeId(requireString(value, 'nodeId')),
        load: parseLoad(value.load),
      };
    case 'WELCOME':
      return {
        t,
        nodeId: parseNodeId(requireString(value, 'nodeId')),
        peers: parsePeers(value.peers),
      };
    case 'PEER_UP':
      return {
        t,
        peer: parsePeer(value.peer, 'peer'),
      };
    case 'PEER_DOWN':
      return {
        t,
        nodeId: parseNodeId(requireString(value, 'nodeId')),
      };
    case 'HEARTBEAT':
      return {
        t,
        ts: requireFiniteNumber(value, 'ts'),
      };
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
        childPortId:
          requireString(value, 'childPortId') === ''
            ? ''
            : parseClusterId(requireString(value, 'childPortId'), 'childPortId'),
        ok: requireBoolean(value, 'ok'),
      };
      if (value.error !== undefined) out.error = requireString(value, 'error');
      return out;
    }
    case 'REALM_EXIT': {
      const out: ClusterMessage = {
        t,
        realmId: parseClusterId(requireString(value, 'realmId'), 'realmId'),
      };
      if (value.error !== undefined) out.error = requireString(value, 'error');
      return out;
    }
    case 'TERMINATE':
      return {
        t,
        realmId: parseClusterId(requireString(value, 'realmId'), 'realmId'),
      };
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
/**
 * Extract the node ID prefix from a realm ID or port ID.
 *
 * The function scans until the first slash and returns the prefix. It does not
 * validate the rest of the ID and returns the full input when no slash is
 * present, so use `decode()` for strict wire validation.
 *
 * ```ts
 * import { nodeIdFromId } from 'internal:cluster/protocol';
 * nodeIdFromId('worker-1/p-2');
 * ```
 *
 * @internal
 */
export function nodeIdFromId(id: string): string {
  const sc = new Scanner(String(id), {
    encoding: 'utf-8',
    format: 'cluster-id',
  });
  const start = sc.mark();
  sc.eatWhile((code) => code !== 47);
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
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw protocolError(`${key} must be a finite number`);
  return value;
}
function parseLoad(value: unknown): NodeLoad {
  if (!isRecord(value)) throw protocolError('load must be an object');
  const cpu = requireFiniteNumber(value, 'cpu');
  const memory = requireFiniteNumber(value, 'memory');
  if (cpu < 0 || cpu > 1) throw protocolError('load.cpu must be in [0, 1]');
  if (memory < 0) throw protocolError('load.memory must be non-negative');
  return {
    cpu,
    memory,
  };
}
function parsePeer(value: unknown, key: string): PeerInfo {
  if (!isRecord(value)) throw protocolError(`${key} must be an object`);
  try {
    return {
      nodeId: parseNodeId(requireString(value, 'nodeId')),
      load: parseLoad(value.load),
    };
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
    ...('bootstrapData' in value ? { bootstrapData: value.bootstrapData } : {}),
  };
}
function isIdCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95 ||
    code === 46
  );
}
function parseHandleId(id: string, key: string): string {
  const sc = new Scanner(id, {
    encoding: 'utf-8',
    format: 'cluster-id',
  });
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
  const sc = new Scanner(id, {
    encoding: 'utf-8',
    format: 'cluster-id',
  });
  const nodeId = sc.eatWhile(isIdCode);
  if (nodeId === '' || !sc.eatChar('/')) throw protocolError(`${key} is malformed`);
  const local = sc.eatWhile((code) => isIdCode(code) || code === 47);
  if (local === '' || !sc.done) throw protocolError(`${key} is malformed`);
  return id;
}
