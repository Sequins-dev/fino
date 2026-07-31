/**
 * internal:cluster/protocol - cluster wire types and protobuf codec.
 *
 * Cluster messages use the Protocol Buffers binary wire format. The schema is
 * defined here alongside the TypeScript message union, so the transport sends
 * numeric field tags and raw byte payloads rather than property names, JSON
 * text, or base64 wrappers.
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
 *   payload: [new Uint8Array([1, 2, 3])],
 *   seq: 1,
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
import { defineMessage } from 'fino:format/protobuf';
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
  /**
   * Fraction of wall time the sender's loop spent blocked waiting, in the
   * inclusive range `[0, 1]`.
   *
   * A node at moderate CPU whose loop idle is collapsing is saturated for
   * latency-sensitive work — this is the signal external orchestrators cannot
   * see. Optional: realms whose idle time is attributed by the reactor pool
   * omit it rather than reporting a misleading zero.
   *
   * ```ts
   * const load = { cpu: 0.25, memory: 1024, loopIdle: 0.9 };
   * load.loopIdle;
   * ```
   */
  loopIdle?: number;
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
 * Import rules and runtime bootstrap metadata are encoded as nested protobuf
 * messages. The target node reconstructs the Rust-facing rule object only
 * after decoding the typed cluster envelope.
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
   * The path is passed through unchanged to the target node's reactor
   * scheduler; resolution failures happen when the target node starts the
   * realm, not during protocol decoding.
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
   * Normalized import-rule array.
   *
   * The protocol validates and encodes the supported directive variants.
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
   * The cluster layer currently defines the CLI OpenTelemetry bootstrap
   * fields used by realm startup. Unknown fields are not forwarded.
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
 * - `REALM_EXIT` — sent by the hosting node when a spawned realm terminates.
 *   `lastPortSeq` fences the exit behind every preceding `PORT_MSG`, and
 *   `error` is set if the realm exited abnormally.
 * - `TERMINATE` — request to kill a realm on its hosting node; the seed also
 *   emits this to descendants when an ancestor realm exits.
 * - `PORT_MSG` — data-plane frame between two ports. `payload` contains the
 *   structured-clone byte parts unchanged; `seq` preserves source-port
 *   ordering across streams.
 *
 * ```ts
 * import { decode } from 'internal:cluster/protocol';
 * const msg = decode(encode({ t: 'HEARTBEAT', ts: 1 }));
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
      load?: NodeLoad;
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
      lastPortSeq: number;
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
      payload: Uint8Array[];
      seq: number;
    };
// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------
const enum MessageKind {
  HELLO = 1,
  WELCOME = 2,
  PEER_UP = 3,
  PEER_DOWN = 4,
  HEARTBEAT = 5,
  SPAWN = 6,
  SPAWN_ACK = 7,
  REALM_EXIT = 8,
  TERMINATE = 9,
  PORT_MSG = 10,
}

const enum DirectiveKind {
  INHERIT = 1,
  BLOCK = 2,
  REMAP = 3,
  SOURCE = 4,
  FACADE = 5,
}

interface WireLoad {
  cpu?: number;
  memory?: number;
  loopIdle?: number;
}

interface WirePeer {
  nodeId?: string;
  load?: WireLoad;
}

interface WireDirective {
  kind: number;
  target?: string;
  code?: string;
  sourceMap?: string;
  specifier?: string;
  exports: string[];
  streams: string[];
  sinks: string[];
}

interface WireRule {
  from?: string;
  pattern?: string;
  directive?: WireDirective;
}

interface WireCliOtel {
  endpoint?: string;
  script?: string;
  debug?: boolean;
}

interface WireBootstrapData {
  cliOtel?: WireCliOtel;
}

interface WireSpawnConfig {
  entry?: string;
  root?: string;
  rules: WireRule[];
  bootstrapData?: WireBootstrapData;
}

interface WireEnvelope {
  kind: number;
  nodeId?: string;
  load?: WireLoad;
  peers: WirePeer[];
  peer?: WirePeer;
  ts?: number;
  spawnReqId?: string;
  parentPortId?: string;
  config?: WireSpawnConfig;
  childPortId?: string;
  ok?: boolean;
  error?: string;
  realmId?: string;
  lastPortSeq?: bigint;
  fromPort?: string;
  toPort?: string;
  payload: Uint8Array[];
  seq?: bigint;
}

const LoadMessage = defineMessage<WireLoad>({
  cpu: { number: 1, type: 'double', optional: true },
  memory: { number: 2, type: 'double', optional: true },
  loopIdle: { number: 3, type: 'double', optional: true },
});
const PeerMessage = defineMessage<WirePeer>({
  nodeId: { number: 1, type: 'string', optional: true },
  load: { number: 2, type: LoadMessage, optional: true },
});
const DirectiveMessage = defineMessage<WireDirective>({
  kind: { number: 1, type: 'enum' },
  target: { number: 2, type: 'string', optional: true },
  code: { number: 3, type: 'string', optional: true },
  sourceMap: { number: 4, type: 'string', optional: true },
  specifier: { number: 5, type: 'string', optional: true },
  exports: { number: 6, type: 'string', repeated: true },
  streams: { number: 7, type: 'string', repeated: true },
  sinks: { number: 8, type: 'string', repeated: true },
});
const RuleMessage = defineMessage<WireRule>({
  from: { number: 1, type: 'string', optional: true },
  pattern: { number: 2, type: 'string', optional: true },
  directive: { number: 3, type: DirectiveMessage, optional: true },
});
const CliOtelMessage = defineMessage<WireCliOtel>({
  endpoint: { number: 1, type: 'string', optional: true },
  script: { number: 2, type: 'string', optional: true },
  debug: { number: 3, type: 'bool', optional: true },
});
const BootstrapDataMessage = defineMessage<WireBootstrapData>({
  cliOtel: { number: 1, type: CliOtelMessage, optional: true },
});
const SpawnConfigMessage = defineMessage<WireSpawnConfig>({
  entry: { number: 1, type: 'string', optional: true },
  root: { number: 2, type: 'string', optional: true },
  rules: { number: 3, type: RuleMessage, repeated: true },
  bootstrapData: { number: 4, type: BootstrapDataMessage, optional: true },
});
const EnvelopeMessage = defineMessage<WireEnvelope>({
  kind: { number: 1, type: 'enum' },
  nodeId: { number: 2, type: 'string', optional: true },
  load: { number: 3, type: LoadMessage, optional: true },
  peers: { number: 4, type: PeerMessage, repeated: true },
  peer: { number: 5, type: PeerMessage, optional: true },
  ts: { number: 6, type: 'double', optional: true },
  spawnReqId: { number: 7, type: 'string', optional: true },
  parentPortId: { number: 8, type: 'string', optional: true },
  config: { number: 9, type: SpawnConfigMessage, optional: true },
  childPortId: { number: 10, type: 'string', optional: true },
  ok: { number: 11, type: 'bool', optional: true },
  error: { number: 12, type: 'string', optional: true },
  realmId: { number: 13, type: 'string', optional: true },
  lastPortSeq: { number: 14, type: 'uint64', optional: true },
  fromPort: { number: 15, type: 'string', optional: true },
  toPort: { number: 16, type: 'string', optional: true },
  payload: { number: 17, type: 'bytes', repeated: true },
  seq: { number: 18, type: 'uint64', optional: true },
});

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw protocolError(`${key} must be an array of strings`);
  }
  return value.slice();
}

function encodeDirective(value: unknown): WireDirective {
  if (value === 'inherit' || value === 'block') {
    return {
      kind: value === 'inherit' ? DirectiveKind.INHERIT : DirectiveKind.BLOCK,
      exports: [],
      streams: [],
      sinks: [],
    };
  }
  if (!isRecord(value)) throw protocolError('rule directive must be an object');
  const type = requireString(value, 'type');
  const base = { exports: [] as string[], streams: [] as string[], sinks: [] as string[] };
  if (type === 'inherit') return { kind: DirectiveKind.INHERIT, ...base };
  if (type === 'block') return { kind: DirectiveKind.BLOCK, ...base };
  if (type === 'remap') {
    return { kind: DirectiveKind.REMAP, target: requireString(value, 'target'), ...base };
  }
  if (type === 'source') {
    return {
      kind: DirectiveKind.SOURCE,
      code: requireString(value, 'code'),
      sourceMap: requireString(value, 'source_map'),
      ...base,
    };
  }
  if (type === 'facade') {
    return {
      kind: DirectiveKind.FACADE,
      specifier: requireString(value, 'specifier'),
      exports: stringArray(value.exports, 'directive.exports'),
      streams: value.streams === undefined ? [] : stringArray(value.streams, 'directive.streams'),
      sinks: value.sinks === undefined ? [] : stringArray(value.sinks, 'directive.sinks'),
    };
  }
  throw protocolError(`unknown rule directive '${type}'`);
}

function decodeDirective(value: WireDirective): Record<string, unknown> {
  if (value.kind === DirectiveKind.INHERIT) return { type: 'inherit' };
  if (value.kind === DirectiveKind.BLOCK) return { type: 'block' };
  if (value.kind === DirectiveKind.REMAP) {
    return { type: 'remap', target: requiredWireString(value.target, 'directive.target') };
  }
  if (value.kind === DirectiveKind.SOURCE) {
    return {
      type: 'source',
      code: requiredWireString(value.code, 'directive.code'),
      source_map: requiredWireString(value.sourceMap, 'directive.source_map'),
    };
  }
  if (value.kind === DirectiveKind.FACADE) {
    return {
      type: 'facade',
      specifier: requiredWireString(value.specifier, 'directive.specifier'),
      exports: value.exports,
      ...(value.streams.length > 0 ? { streams: value.streams } : {}),
      ...(value.sinks.length > 0 ? { sinks: value.sinks } : {}),
    };
  }
  throw protocolError(`unknown rule directive ${value.kind}`);
}

function encodeRule(value: unknown): WireRule {
  if (!isRecord(value)) throw protocolError('config rule must be an object');
  return {
    ...(value.from === undefined ? {} : { from: requireString(value, 'from') }),
    pattern: requireString(value, 'pattern'),
    directive: encodeDirective(value.directive),
  };
}

function decodeRule(value: WireRule): Record<string, unknown> {
  if (value.directive === undefined) throw protocolError('rule directive is missing');
  return {
    ...(value.from === undefined ? {} : { from: value.from }),
    pattern: requiredWireString(value.pattern, 'rule.pattern'),
    directive: decodeDirective(value.directive),
  };
}

function encodeBootstrapData(value: unknown): WireBootstrapData {
  if (!isRecord(value)) throw protocolError('config.bootstrapData must be an object');
  if (value.cliOtel === undefined) return {};
  if (!isRecord(value.cliOtel))
    throw protocolError('config.bootstrapData.cliOtel must be an object');
  const cliOtel = value.cliOtel;
  return {
    cliOtel: {
      ...(cliOtel.endpoint === undefined ? {} : { endpoint: requireString(cliOtel, 'endpoint') }),
      ...(cliOtel.script === undefined ? {} : { script: requireString(cliOtel, 'script') }),
      ...(cliOtel.debug === undefined ? {} : { debug: requireBoolean(cliOtel, 'debug') }),
    },
  };
}

function encodeSpawnConfig(value: unknown): WireSpawnConfig {
  const config = parseSpawnConfig(value);
  return {
    entry: config.entry,
    root: config.root,
    rules: config.rules.map(encodeRule),
    ...(config.bootstrapData === undefined
      ? {}
      : { bootstrapData: encodeBootstrapData(config.bootstrapData) }),
  };
}

function decodeSpawnConfig(value: WireSpawnConfig): SerializedSpawnConfig {
  return {
    entry: requiredWireString(value.entry, 'config.entry'),
    root: requiredWireString(value.root, 'config.root'),
    rules: value.rules.map(decodeRule),
    ...(value.bootstrapData === undefined ? {} : { bootstrapData: value.bootstrapData }),
  };
}

function encodeSequence(value: number, key: string, allowZero: boolean): bigint {
  const sequence = requireSequence({ [key]: value }, key, allowZero);
  if (!Number.isSafeInteger(sequence)) throw protocolError(`${key} exceeds the safe integer range`);
  return BigInt(sequence);
}

function decodeSequence(value: bigint | undefined, key: string, allowZero: boolean): number {
  if (value === undefined) throw protocolError(`${key} is missing`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw protocolError(`${key} exceeds the safe integer range`);
  }
  return requireSequence({ [key]: Number(value) }, key, allowZero);
}

function requiredWireString(value: string | undefined, key: string): string {
  if (value === undefined) throw protocolError(`${key} must be a string`);
  return value;
}

function encodePeer(value: PeerInfo): WirePeer {
  const peer = parsePeer(value, 'peer');
  return { nodeId: peer.nodeId, load: peer.load };
}

function decodePeer(value: WirePeer, key: string): PeerInfo {
  return parsePeer(value, key);
}

function toWire(msg: ClusterMessage): WireEnvelope {
  const base = { peers: [] as WirePeer[], payload: [] as Uint8Array[] };
  switch (msg.t) {
    case 'HELLO':
      return {
        kind: MessageKind.HELLO,
        nodeId: parseNodeId(msg.nodeId),
        load: parseLoad(msg.load),
        ...base,
      };
    case 'WELCOME':
      return {
        kind: MessageKind.WELCOME,
        nodeId: parseNodeId(msg.nodeId),
        peers: parsePeers(msg.peers).map(encodePeer),
        payload: [],
      };
    case 'PEER_UP':
      return { kind: MessageKind.PEER_UP, peer: encodePeer(msg.peer), ...base };
    case 'PEER_DOWN':
      return { kind: MessageKind.PEER_DOWN, nodeId: parseNodeId(msg.nodeId), ...base };
    case 'HEARTBEAT':
      return {
        kind: MessageKind.HEARTBEAT,
        ts: requireFiniteNumber({ ts: msg.ts }, 'ts'),
        ...(msg.load !== undefined ? { load: parseLoad(msg.load) } : {}),
        ...base,
      };
    case 'SPAWN':
      return {
        kind: MessageKind.SPAWN,
        spawnReqId: parseHandleId(msg.spawnReqId, 'spawnReqId'),
        parentPortId: parseClusterId(msg.parentPortId, 'parentPortId'),
        config: encodeSpawnConfig(msg.config),
        ...base,
      };
    case 'SPAWN_ACK':
      return {
        kind: MessageKind.SPAWN_ACK,
        spawnReqId: parseHandleId(msg.spawnReqId, 'spawnReqId'),
        childPortId: msg.childPortId === '' ? '' : parseClusterId(msg.childPortId, 'childPortId'),
        ok: msg.ok,
        ...(msg.error === undefined ? {} : { error: msg.error }),
        ...base,
      };
    case 'REALM_EXIT':
      return {
        kind: MessageKind.REALM_EXIT,
        realmId: parseClusterId(msg.realmId, 'realmId'),
        lastPortSeq: encodeSequence(msg.lastPortSeq, 'lastPortSeq', true),
        ...(msg.error === undefined ? {} : { error: msg.error }),
        ...base,
      };
    case 'TERMINATE':
      return {
        kind: MessageKind.TERMINATE,
        realmId: parseClusterId(msg.realmId, 'realmId'),
        ...base,
      };
    case 'PORT_MSG':
      if (
        !Array.isArray(msg.payload) ||
        msg.payload.some((part) => !(part instanceof Uint8Array))
      ) {
        throw protocolError('payload must be an array of Uint8Array values');
      }
      return {
        kind: MessageKind.PORT_MSG,
        fromPort: parseClusterId(msg.fromPort, 'fromPort'),
        toPort: parseClusterId(msg.toPort, 'toPort'),
        payload: msg.payload,
        seq: encodeSequence(msg.seq, 'seq', false),
        peers: [],
      };
    default:
      throw protocolError(`unknown message type '${(msg as { t?: unknown }).t}'`);
  }
}

/**
 * Encode one validated cluster message as protobuf binary data.
 *
 * Raw port payload parts remain bytes on the wire; no base64 or JSON layer is
 * introduced.
 *
 * @internal
 */
export function encode(msg: ClusterMessage): Uint8Array {
  return EnvelopeMessage.encode(toWire(msg));
}

/**
 * Decode and strictly validate one protobuf cluster message.
 *
 * Unknown protobuf fields are ignored for forward compatibility. The returned
 * object is reconstructed from the shared schema, so unknown application
 * properties cannot pass through the cluster control plane.
 *
 * @internal
 */
export function decode(bytes: Uint8Array | ArrayBuffer): ClusterMessage {
  let value: WireEnvelope;
  try {
    value = EnvelopeMessage.decode(bytes);
  } catch (error) {
    throw protocolError(`invalid protobuf: ${error}`);
  }
  switch (value.kind) {
    case MessageKind.HELLO:
      return {
        t: 'HELLO',
        nodeId: parseNodeId(requiredWireString(value.nodeId, 'nodeId')),
        load: parseLoad(value.load),
      };
    case MessageKind.WELCOME:
      return {
        t: 'WELCOME',
        nodeId: parseNodeId(requiredWireString(value.nodeId, 'nodeId')),
        peers: value.peers.map((peer, index) => decodePeer(peer, `peer ${index}`)),
      };
    case MessageKind.PEER_UP:
      if (value.peer === undefined) throw protocolError('peer is missing');
      return { t: 'PEER_UP', peer: decodePeer(value.peer, 'peer') };
    case MessageKind.PEER_DOWN:
      return {
        t: 'PEER_DOWN',
        nodeId: parseNodeId(requiredWireString(value.nodeId, 'nodeId')),
      };
    case MessageKind.HEARTBEAT:
      if (value.ts === undefined) throw protocolError('ts must be a finite number');
      return {
        t: 'HEARTBEAT',
        ts: requireFiniteNumber({ ts: value.ts }, 'ts'),
        ...(value.load !== undefined ? { load: parseLoad(value.load) } : {}),
      };
    case MessageKind.SPAWN:
      if (value.config === undefined) throw protocolError('config is missing');
      return {
        t: 'SPAWN',
        spawnReqId: parseHandleId(requiredWireString(value.spawnReqId, 'spawnReqId'), 'spawnReqId'),
        parentPortId: parseClusterId(
          requiredWireString(value.parentPortId, 'parentPortId'),
          'parentPortId',
        ),
        config: decodeSpawnConfig(value.config),
      };
    case MessageKind.SPAWN_ACK: {
      const childPortId = requiredWireString(value.childPortId, 'childPortId');
      if (value.ok === undefined) throw protocolError('ok must be a boolean');
      return {
        t: 'SPAWN_ACK',
        spawnReqId: parseHandleId(requiredWireString(value.spawnReqId, 'spawnReqId'), 'spawnReqId'),
        childPortId: childPortId === '' ? '' : parseClusterId(childPortId, 'childPortId'),
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    }
    case MessageKind.REALM_EXIT:
      return {
        t: 'REALM_EXIT',
        realmId: parseClusterId(requiredWireString(value.realmId, 'realmId'), 'realmId'),
        lastPortSeq: decodeSequence(value.lastPortSeq, 'lastPortSeq', true),
        ...(value.error === undefined ? {} : { error: value.error }),
      };
    case MessageKind.TERMINATE:
      return {
        t: 'TERMINATE',
        realmId: parseClusterId(requiredWireString(value.realmId, 'realmId'), 'realmId'),
      };
    case MessageKind.PORT_MSG:
      return {
        t: 'PORT_MSG',
        fromPort: parseClusterId(requiredWireString(value.fromPort, 'fromPort'), 'fromPort'),
        toPort: parseClusterId(requiredWireString(value.toPort, 'toPort'), 'toPort'),
        payload: value.payload,
        seq: decodeSequence(value.seq, 'seq', false),
      };
    default:
      throw protocolError(`unknown message type ${value.kind}`);
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
function requireSequence(obj: Record<string, unknown>, key: string, allowZero: boolean): number {
  const value = requireFiniteNumber(obj, key);
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw protocolError(`${key} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}
function parseLoad(value: unknown): NodeLoad {
  if (!isRecord(value)) throw protocolError('load must be an object');
  const cpu = requireFiniteNumber(value, 'cpu');
  const memory = requireFiniteNumber(value, 'memory');
  if (cpu < 0 || cpu > 1) throw protocolError('load.cpu must be in [0, 1]');
  if (memory < 0) throw protocolError('load.memory must be non-negative');
  if (value.loopIdle === undefined) {
    return { cpu, memory };
  }
  const loopIdle = requireFiniteNumber(value, 'loopIdle');
  if (loopIdle < 0 || loopIdle > 1) throw protocolError('load.loopIdle must be in [0, 1]');
  return { cpu, memory, loopIdle };
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
