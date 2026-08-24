/**
 * internal:cluster/webtransport-transport - WebTransport implementations of ClusterTransport.
 *
 * Two transports connect a fino cluster over HTTP/3: `WebTransportSeedTransport`
 * hosts the seed endpoint that workers dial, and `WebTransportWorkerTransport`
 * maintains a worker's single session to that seed. Both implement the
 * `ClusterTransport` contract from `internal:cluster/transport`; the seed
 * variant additionally satisfies `ClusterSeedTransport` (`listen()` plus
 * `broadcastExcept()`) so `SeedServer` can route on it. Sessions negotiate the
 * `fino-cluster-v1` WebTransport protocol.
 *
 * Each connection carries its messages on two long-lived reliable bidirectional
 * streams — lanes — one for control-plane traffic and one for `PORT_MSG` data.
 * The first frame on a lane is a `ClusterStreamMetadata` protobuf frame (see
 * `internal:cluster/webtransport-framing`) declaring which kind it is; message
 * frames follow for the life of the connection. Lanes are one-way: a peer
 * answers on lanes it opens itself. Each lane serializes its own writes, so a
 * large payload cannot delay a heartbeat, and stream count stays constant
 * rather than scaling with traffic.
 *
 * A stream per message is what this used to do, and it wedged: nothing closed
 * the write half, so streams accrued against the peer's `initial_max_streams_bidi`
 * (100) until `createBidirectionalStream()` blocked forever on credit that only
 * returns as lingering streams are reaped. Realm messaging stopped dead at
 * ~100 messages per direction.
 *
 * `fino:cluster` composes these transports with `SeedServer` and
 * `ClusterClient`; use this module directly only when wiring cluster plumbing
 * by hand.
 *
 * ```ts no_run
 * import { WebTransportSeedTransport, WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
 *
 * const seed = new WebTransportSeedTransport('__seed__', {
 *   port: 9999,
 *   tls: { cert: './cert.pem', key: './key.pem' },
 * });
 * await seed.listen();
 * seed.on((from, msg) => console.log(`seed saw ${msg.t} from ${from}`));
 *
 * const worker = new WebTransportWorkerTransport('worker-1');
 * await worker.connect('https://127.0.0.1:9999', { cpu: 0, memory: 0 }, {
 *   tls: { rejectUnauthorized: false },
 * });
 * ```
 *
 * @internal
 */
import { serve } from 'fino:net/http/server';
import { HttpClient } from 'fino:net/http/client';
import type {
  WebTransport,
  WebTransportBidirectionalStream,
  WebTransportHash,
} from 'fino:net/http/webtransport';
import { Response } from 'internal:net/http/wire';
import type { ClusterTransport } from './transport.ts';
import { decode, encode, nodeIdFromId, type ClusterMessage } from './protocol.ts';
import {
  ClusterStreamFrameReader,
  decodeClusterStreamMetadata,
  encodeClusterStreamFrame,
  encodeClusterStreamMetadata,
  type ClusterStreamMetadata,
} from './webtransport-framing.ts';
/**
 * Default HTTP/3 path the cluster WebTransport endpoint is served and dialed on.
 *
 * The seed transport mounts its WebTransport handler here unless
 * `WebTransportSeedOptions.path` overrides it, and `normalizeSeedUrl` fills this
 * in for worker seed URLs that carry only an origin (a bare `/` pathname). Using
 * an obscure, namespaced path keeps the cluster endpoint from colliding with an
 * application's own routes when a seed shares its HTTP/3 server.
 *
 * ```ts no_run
 * import { DEFAULT_CLUSTER_PATH } from 'internal:cluster/webtransport-transport';
 *
 * const seedUrl = new URL('https://seed.internal:4433');
 * seedUrl.pathname = DEFAULT_CLUSTER_PATH; // https://seed.internal:4433/__fino_cluster
 * ```
 */
export const DEFAULT_CLUSTER_PATH = '/__fino_cluster';
const CLUSTER_PROTOCOL = 'fino-cluster-v1';
type ServerHandle = {
  ready: Promise<void>;
  /** The actual bound port, which is the only way to learn it after `port: 0`. */
  readonly port: number;
  close(): Promise<void>;
};
type Handler = (from: string, msg: ClusterMessage) => void;
type LoadInfo = {
  cpu: number;
  memory: number;
};
type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;
/**
 * Configuration for a `WebTransportSeedTransport`'s HTTP/3 listener.
 *
 * These options are forwarded almost verbatim to `serve()` when `listen()` is
 * called. TLS is mandatory because WebTransport runs over HTTP/3, which requires
 * QUIC and therefore a certificate and key — there is no cleartext mode. The
 * `path` narrows which request URL is accepted as a cluster session; requests to
 * any other path are rejected with a plain HTTP response so the same server can
 * still host unrelated routes.
 *
 * ```ts no_run
 * import { WebTransportSeedTransport, type WebTransportSeedOptions } from 'internal:cluster/webtransport-transport';
 *
 * const options: WebTransportSeedOptions = {
 *   port: 4433,
 *   hostname: '0.0.0.0',
 *   tls: { cert: '/etc/cluster/cert.pem', key: '/etc/cluster/key.pem' },
 *   path: '/__fino_cluster',
 *   h3: { quic: { maxIdleTimeout: 30_000 } },
 * };
 * const seed = new WebTransportSeedTransport('__seed__', options);
 * await seed.listen();
 * ```
 */
export interface WebTransportSeedOptions {
  /**
   * TCP/UDP port the HTTP/3 seed listener binds to.
   */
  port: number;
  /**
   * Interface address to bind on; defaults to the `serve()` default when
   * omitted. Set `'0.0.0.0'` to accept workers from other hosts.
   */
  hostname?: string;
  /**
   * PEM certificate and private key paths for the QUIC/TLS listener. Required —
   * WebTransport has no cleartext transport. `listen()` rejects if the material
   * is missing or invalid.
   */
  tls: {
    cert: string;
    key: string;
  };
  /**
   * Request path accepted as a cluster session. Defaults to
   * `DEFAULT_CLUSTER_PATH`; a leading slash is added if absent. Requests to any
   * other path receive a plain HTTP response instead of a WebTransport upgrade.
   */
  path?: string;
  /**
   * HTTP/3 enablement passed to `serve()`. `true` (the default when omitted)
   * turns on HTTP/3 with defaults; the object form additionally passes
   * per-connection QUIC tuning through to the listener.
   */
  h3?:
    | true
    | {
        quic?: Record<string, unknown>;
      };
}
/**
 * Per-connection options for `WebTransportWorkerTransport.connect()`.
 *
 * All fields are optional; the defaults dial the seed with the platform's
 * standard HTTP/3 client trust settings. Supply `tls` to point at a private CA
 * or, for development, to disable certificate verification. For self-signed
 * seeds that publish a certificate fingerprint out of band,
 * `serverCertificateHashes` pins the expected certificate directly, mirroring
 * the browser WebTransport API.
 *
 * ```ts no_run
 * import { WebTransportWorkerTransport, type WebTransportWorkerConnectOptions } from 'internal:cluster/webtransport-transport';
 *
 * const options: WebTransportWorkerConnectOptions = {
 *   tls: { ca: '/etc/cluster/ca.pem' },
 *   quic: { maxIdleTimeout: 30_000 },
 * };
 * const worker = new WebTransportWorkerTransport('worker-1');
 * await worker.connect('https://seed.internal:4433', { cpu: 0, memory: 0 }, options);
 * ```
 */
export interface WebTransportWorkerConnectOptions {
  /**
   * TLS trust configuration for the HTTP/3 client. `ca` supplies a private
   * root; `rejectUnauthorized: false` disables verification for development
   * against self-signed seeds. Omit for the platform default trust store.
   */
  tls?: {
    ca?: string;
    rejectUnauthorized?: boolean;
  };
  /**
   * QUIC transport tuning passed through to the underlying connection, matching
   * the seed's `h3.quic` knobs.
   */
  quic?: Record<string, unknown>;
  /**
   * Expected server certificate fingerprints. When present the connection is
   * accepted only if the seed presents a matching certificate, allowing
   * self-signed seeds to be pinned without a CA. Mirrors the browser
   * WebTransport `serverCertificateHashes` option.
   */
  serverCertificateHashes?: readonly WebTransportHash[];
  /**
   * Join token presented in the HELLO frame. Required when the seed was
   * started with join authentication; wrong or missing tokens receive
   * JOIN_DENIED instead of WELCOME.
   */
  token?: string;
  /**
   * Announce as an observer: the seed answers with WELCOME (peer list and
   * cluster identity) but never registers the connection as a member.
   */
  observer?: boolean;
  /** Process incarnation announced in HELLO; the seed fences older ones. */
  incarnation?: number;
  /** Directly dialable endpoint advertised for peer introductions. */
  endpoint?: string;
  /** Hex sha-256 of this node's own listener certificate. */
  certHash?: string;
}
/**
 * A long-lived outbound stream carrying every message of one kind.
 *
 * One QUIC stream per message looks harmless and is not: nothing ever closes
 * the write half (`closeWriter` only releases the lock), so streams accumulate
 * against the peer's `initial_max_streams_bidi` — 100 by default. The 101st
 * `createBidirectionalStream()` then waits for credit that arrives only as
 * lingering streams are reaped, which across a real connection is indistinct
 * from never. Realm traffic stalled dead at ~100 messages.
 *
 * A lane opens once, writes its metadata frame once, and then carries an
 * unbounded number of messages. Two lanes per connection — control and port —
 * keep a heartbeat from queueing behind a large payload while bounding stream
 * count at a constant instead of scaling it with traffic.
 */
interface OutboundLane {
  writer: StreamWriter | null;
  queue: Promise<void>;
  /** Set by `closeLanes`, so writes already queued behind it do not run. */
  closed: boolean;
}
interface PeerConnection {
  wt: WebTransport;
  /** Write half of the stream the peer opened; retained so `close()` releases it. */
  control: StreamWriter | null;
  /** Our own outbound lanes. The peer answers on lanes it opens itself. */
  lanes: { control: OutboundLane; port: OutboundLane };
}
function newLanes(): { control: OutboundLane; port: OutboundLane } {
  return {
    control: { writer: null, queue: Promise.resolve(), closed: false },
    port: { writer: null, queue: Promise.resolve(), closed: false },
  };
}
/**
 * Write one message on a lane, opening the underlying stream on first use.
 *
 * The open runs inside the lane's queue, so concurrent sends cannot race to
 * create two streams for the same lane. A write failure drops the writer so the
 * next message opens a fresh stream rather than inheriting a broken one.
 */
function laneSend(
  lane: OutboundLane,
  wt: WebTransport,
  kind: 'control' | 'port',
  msg: ClusterMessage,
): Promise<void> {
  const task = async (): Promise<void> => {
    if (lane.closed) return;
    if (lane.writer === null) {
      const stream = await wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writeMetadata(writer, { v: 1, kind });
      // Lanes are one-way: a peer answers on lanes it opens itself, so nothing
      // will ever be read from this one. Cancelling releases the loop
      // registration that would otherwise outlive every message on it.
      try {
        await stream.readable.cancel();
      } catch {
        // Already gone; nothing to release.
      }
      lane.writer = writer;
    }
    try {
      await writeMessage(lane.writer, msg);
    } catch (error) {
      lane.writer = null;
      throw error;
    }
  };
  const next = lane.queue.catch(() => {}).then(task);
  lane.queue = next.catch(() => {});
  return next;
}
function closeLanes(lanes: { control: OutboundLane; port: OutboundLane }): void {
  for (const lane of [lanes.control, lanes.port]) {
    lane.closed = true;
    if (lane.writer !== null) closeWriter(lane.writer);
    lane.writer = null;
  }
}
function normalizePath(path: string | undefined): string {
  if (path === undefined || path === '') return DEFAULT_CLUSTER_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}
function normalizeSeedUrl(seed: string | URL): URL {
  const url = new URL(String(seed));
  if (url.protocol !== 'https:')
    throw new TypeError('WebTransport cluster seeds must use https: URLs');
  if (url.pathname === '/') url.pathname = DEFAULT_CLUSTER_PATH;
  return url;
}
function isPortMessage(msg: ClusterMessage): msg is Extract<
  ClusterMessage,
  {
    t: 'PORT_MSG';
  }
> {
  return msg.t === 'PORT_MSG';
}
function frameMessage(msg: ClusterMessage): Uint8Array {
  return encodeClusterStreamFrame(encode(msg));
}
function decodeMessage(value: Uint8Array): ClusterMessage {
  return decode(value);
}
async function writeMetadata(writer: StreamWriter, value: ClusterStreamMetadata): Promise<void> {
  await writer.write(encodeClusterStreamFrame(encodeClusterStreamMetadata(value)));
}
async function writeMessage(writer: StreamWriter, msg: ClusterMessage): Promise<void> {
  await writer.write(frameMessage(msg));
}
function closeWriter(writer: StreamWriter): void {
  try {
    writer.releaseLock();
  } catch {}
}
function isExpectedCloseError(error: unknown): boolean {
  return /connection is closed|stream is closed|transport is closed/i.test(String(error));
}
function closeConnection(conn: PeerConnection): void {
  if (conn.control !== null) closeWriter(conn.control);
  closeLanes(conn.lanes);
  conn.wt.close();
}
async function readClusterStream(
  stream: WebTransportBidirectionalStream,
  onMetadata: (metadata: ClusterStreamMetadata, writer: StreamWriter) => void | Promise<void>,
  onMessage: (metadata: ClusterStreamMetadata, msg: ClusterMessage) => void,
  onClose: (metadata: ClusterStreamMetadata | null) => void,
  existingWriter?: StreamWriter,
  initialMetadata: ClusterStreamMetadata | null = null,
): Promise<void> {
  const writer = existingWriter ?? stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const frames = new ClusterStreamFrameReader();
  let metadata: ClusterStreamMetadata | null = initialMetadata;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const chunk = read.value;
      if (!(chunk instanceof Uint8Array)) continue;
      for (const value of frames.push(chunk)) {
        if (metadata === null) {
          metadata = decodeClusterStreamMetadata(value);
          await onMetadata(metadata, writer);
          continue;
        }
        onMessage(metadata, decodeMessage(value));
      }
    }
    frames.assertComplete();
  } finally {
    try {
      reader.releaseLock();
    } catch {}
    onClose(metadata);
  }
}
/**
 * Seed-side cluster transport: the HTTP/3 hub that workers dial into.
 *
 * Implements `ClusterSeedTransport` — the base `ClusterTransport` contract plus
 * `listen()` and `broadcastExcept()` — so `SeedServer` can host the star
 * topology on it. `listen()` stands up an HTTP/3 server that accepts
 * WebTransport sessions on the configured path; each accepted session is tracked
 * by the worker's node ID once the worker sends its `HELLO`. Messages to a
 * specific worker route directly to that worker's connection, and per-connection
 * sends are serialized so writes land in submission order.
 *
 * When a worker's session closes, the transport synthesizes a `PEER_DOWN`
 * message for that node and delivers it to every registered handler, so
 * membership loss is observed through the same channel as any other message.
 *
 * Construct one per seed node, register a handler, then `listen()`; dispose it
 * (or call `close()`) to tear down every session and the HTTP/3 server.
 *
 * ```ts no_run
 * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
 *
 * const seed = new WebTransportSeedTransport('__seed__', {
 *   port: 4433,
 *   tls: { cert: '/etc/cluster/cert.pem', key: '/etc/cluster/key.pem' },
 * });
 * seed.on((from, msg) => console.log(`${from} -> seed: ${msg.t}`));
 * await seed.listen();
 * // ... later
 * seed.close();
 * ```
 */
export class WebTransportSeedTransport implements ClusterTransport {
  /**
   * This seed's node identifier, advertised to workers and used as the `from`
   * value for control-plane messages the seed originates.
   */
  readonly nodeId: string;
  readonly #options: WebTransportSeedOptions;
  readonly #path: string;
  #connections = new Map<string, PeerConnection>();
  #handlers: Handler[] = [];
  #server: ServerHandle | null = null;
  /**
   * Create a seed transport bound to `nodeId` with the given listener options.
   *
   * Nothing is opened until `listen()` is called; the constructor only records
   * configuration and normalizes the session path.
   */
  constructor(nodeId: string, options: WebTransportSeedOptions) {
    this.nodeId = nodeId;
    this.#options = options;
    this.#path = normalizePath(options.path);
  }
  /**
   * Start the HTTP/3 server and begin accepting worker WebTransport sessions.
   *
   * The returned promise resolves once the listener is ready. Incoming requests
   * are accepted only when they are WebTransport upgrades on the configured
   * path and negotiate the `fino-cluster-v1` protocol; everything else is
   * answered with a plain HTTP response (404 for other WebTransport paths, 200
   * otherwise). Rejects if the server cannot bind — for example a port already
   * in use or invalid TLS material. Call once per transport.
   *
   * ```ts no_run
   * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
   *
   * const seed = new WebTransportSeedTransport('__seed__', {
   *   port: 4433,
   *   tls: { cert: './cert.pem', key: './key.pem' },
   * });
   * await seed.listen();
   * ```
   */
  async listen(): Promise<void> {
    this.#server = serve(
      {
        port: this.#options.port,
        hostname: this.#options.hostname,
        tls: this.#options.tls,
        h3: this.#options.h3 ?? true,
      },
      async (incoming) => {
        const url = new URL(incoming.request.url);
        if (incoming.kind !== 'webtransport' || url.pathname !== this.#path) {
          await incoming.reject(
            new Response('fino cluster seed', {
              status: incoming.kind === 'webtransport' ? 404 : 200,
            }),
          );
          return;
        }
        const wt = await incoming.accept({ protocols: [CLUSTER_PROTOCOL] });
        void this.#handleSession(wt).catch((err: unknown) => {
          console.error(`fino:cluster seed WebTransport session error: ${err}`);
        });
      },
    );
    await this.#server.ready;
  }
  /**
   * Send a message to the connected worker identified by `to`.
   *
   * Resolves once the message has been written on a fresh bidirectional stream.
   * `PORT_MSG` values travel on their own stream tagged with the canonical
   * logical port pair; all other messages go on a control-tagged stream. If no
   * worker with that node ID is currently connected the send is dropped
   * silently and resolves immediately — peer loss is reported separately via a
   * synthetic `PEER_DOWN`. Control-write failures are logged rather than
   * surfaced to the caller so a single bad connection cannot reject the router's
   * send loop.
   *
   * ```ts no_run
   * await seed.send('worker-1', { t: 'HEARTBEAT', ts: Date.now() });
   * ```
   */
  send(to: string, msg: ClusterMessage): Promise<void> {
    const conn = this.#connections.get(to);
    if (conn === undefined) return Promise.resolve();
    if (isPortMessage(msg)) {
      return laneSend(conn.lanes.port, conn.wt, 'port', msg);
    }
    return laneSend(conn.lanes.control, conn.wt, 'control', msg).catch((err: unknown) => {
      console.error(`fino:cluster seed control write failed: ${err}`);
    });
  }
  /**
   * Send a message to every connected worker.
   *
   * Iterates the current connections and delegates to `send()` for each, so the
   * same per-connection ordering and drop-on-missing semantics apply. Fire and
   * forget: the individual sends run concurrently and their promises are not
   * awaited.
   *
   * ```ts no_run
   * seed.broadcast({ t: 'TERMINATE' });
   * ```
   */
  broadcast(msg: ClusterMessage): void {
    for (const nodeId of this.#connections.keys()) this.send(nodeId, msg);
  }
  /**
   * Broadcast to every connected worker except `exceptNodeId`.
   *
   * Used by the seed router to gossip membership changes without echoing the
   * event back to the node it concerns. An `exceptNodeId` that matches no
   * connected peer makes this equivalent to `broadcast`.
   *
   * ```ts no_run
   * seed.broadcastExcept('worker-a', {
   *   t: 'PEER_UP',
   *   peer: { nodeId: 'worker-a', load: { cpu: 0, memory: 0 } },
   * });
   * ```
   */
  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void {
    for (const nodeId of this.#connections.keys()) {
      if (nodeId !== exceptNodeId) this.send(nodeId, msg);
    }
  }
  /**
   * Register a handler invoked for every message received from any worker.
   *
   * Handlers are called in registration order. The first argument is the
   * sending worker's node ID (or `'__unknown__'` for a message that arrives
   * before that worker's `HELLO` has identified it), and the second is the
   * decoded `ClusterMessage`. Synthetic `PEER_DOWN` messages for dropped
   * workers are delivered through the same handlers.
   *
   * ```ts no_run
   * seed.on((from, msg) => {
   *   if (msg.t === 'HELLO') console.log(`worker ${from} joined`);
   * });
   * ```
   */
  on(handler: Handler): void {
    this.#handlers.push(handler);
  }
  /**
   * Close every worker session and shut down the HTTP/3 server.
   *
   * All tracked connections are closed and forgotten, and the underlying server
   * is torn down asynchronously (any close error is logged, not thrown). The
   * transport is unusable afterward; construct a new one to listen again.
   *
   * ```ts no_run
   * seed.close();
   * ```
   */
  close(): void {
    for (const conn of this.#connections.values()) closeConnection(conn);
    this.#connections.clear();
    this.#server?.close().catch((err: unknown) => {
      console.error(`fino:cluster seed server close error: ${err}`);
    });
    this.#server = null;
  }
  /**
   * Dispose support: calls `close()` so the transport can be managed with
   * `using`.
   *
   * ```ts no_run
   * import { WebTransportSeedTransport } from 'internal:cluster/webtransport-transport';
   *
   * {
   *   using seed = new WebTransportSeedTransport('__seed__', {
   *     port: 4433,
   *     tls: { cert: './cert.pem', key: './key.pem' },
   *   });
   *   await seed.listen();
   * } // seed.close() runs at scope exit
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
  async #handleSession(wt: WebTransport): Promise<void> {
    await wt.ready;
    let peerNodeId: string | null = null;
    const streams = wt.incomingBidirectionalStreams.getReader();
    wt.closed
      .finally(() => {
        if (peerNodeId !== null) this.#emitPeerDown(peerNodeId);
      })
      .catch(() => {});
    try {
      while (true) {
        const read = await streams.read();
        if (read.done) break;
        const stream = read.value;
        if (stream === undefined) continue;
        let streamWriter: StreamWriter | null = null;
        void readClusterStream(
          stream,
          async (metadata, writer) => {
            if (metadata.kind === 'control') streamWriter = writer;
          },
          (metadata, msg) => {
            if (metadata.kind === 'control' && msg.t === 'HELLO') {
              peerNodeId = msg.nodeId;
              this.#connections.set(peerNodeId, {
                wt,
                control: streamWriter,
                lanes: newLanes(),
              });
            }
            const from = peerNodeId ?? (msg.t === 'HELLO' ? msg.nodeId : '__unknown__');
            for (const handler of this.#handlers) handler(from, msg);
          },
          (metadata) => {
            void metadata;
          },
        ).catch((err: unknown) => {
          // One bad stream is not a dead peer: messages ride short-lived
          // streams, and a stray reset or idle timeout on one of them must
          // not deregister a member whose session is healthy. Session death
          // is detected by wt.closed above.
          if (!isExpectedCloseError(err))
            console.error(`fino:cluster seed received malformed WebTransport stream: ${err}`);
        });
      }
    } finally {
      try {
        streams.releaseLock();
      } catch {}
    }
  }
  #emitPeerDown(peerNodeId: string): void {
    const conn = this.#connections.get(peerNodeId);
    if (conn === undefined) return;
    this.#connections.delete(peerNodeId);
    closeConnection(conn);
    const synth: ClusterMessage = {
      t: 'PEER_DOWN',
      nodeId: peerNodeId,
    };
    for (const handler of this.#handlers) handler(peerNodeId, synth);
  }
}
/**
 * Worker-side cluster transport: a single WebTransport session to the seed.
 *
 * Implements the base `ClusterTransport` contract. Unlike the seed, a worker has
 * exactly one upstream connection, so `send()` ignores its destination argument
 * and always writes to the seed, and `broadcast()` throws — fanning out is a
 * seed-only capability. After `connect()` opens the session it announces itself
 * with a `HELLO` carrying the worker's node ID and load, then reads inbound
 * streams for the life of the connection.
 *
 * Messages that arrive before any handler is registered are buffered and
 * flushed to the first handler passed to `on()`, so registering a handler right
 * after `connect()` never loses the seed's early `WELCOME`. When the session
 * closes, a synthetic `PEER_DOWN` for the seed is delivered to all handlers.
 *
 * ```ts no_run
 * import { WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
 *
 * const worker = new WebTransportWorkerTransport('worker-1');
 * worker.on((from, msg) => console.log(`${from} -> worker: ${msg.t}`));
 * await worker.connect('https://seed.internal:4433', { cpu: 0, memory: 0 });
 * await worker.send('__seed__', { t: 'HEARTBEAT', ts: Date.now() });
 * ```
 */
export class WebTransportWorkerTransport implements ClusterTransport {
  /**
   * This worker's node identifier, sent to the seed in the `HELLO` frame and
   * used to tag outbound port messages.
   */
  readonly nodeId: string;
  #wt: WebTransport | null = null;
  #lanes = newLanes();
  #handlers: Handler[] = [];
  #pending: Array<{
    from: string;
    msg: ClusterMessage;
  }> = [];
  #queue: Promise<void> = Promise.resolve();
  #seedNodeId = '__seed__';
  /**
   * Create a worker transport bound to `nodeId`. No connection is opened until
   * `connect()` is called.
   */
  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }
  /**
   * Dial the seed, open the session, and announce this worker with a `HELLO`.
   *
   * `seed` may be an origin (`https://host:port`) or a full URL; a bare `/`
   * pathname is replaced with `DEFAULT_CLUSTER_PATH`. The scheme must be
   * `https:` — a non-https seed URL throws a `TypeError`. Resolves once the
   * session is established and the `HELLO` (carrying `load`) has been sent;
   * after that, inbound streams from the seed drive the registered handlers.
   * Rejects if the HTTP/3 connection or WebTransport handshake fails.
   *
   * ```ts no_run
   * const worker = new WebTransportWorkerTransport('worker-1');
   * await worker.connect('https://seed.internal:4433', { cpu: 0.2, memory: 0.5 }, {
   *   tls: { ca: '/etc/cluster/ca.pem' },
   * });
   * ```
   */
  async connect(
    seed: string | URL,
    load: LoadInfo = {
      cpu: 0,
      memory: 0,
    },
    options: WebTransportWorkerConnectOptions = {},
  ): Promise<void> {
    const url = normalizeSeedUrl(seed);
    const client = new HttpClient({
      baseUrl: url.origin,
      protocols: ['h3'],
      tls: options.tls,
    });
    const wt = await client.webtransport(url.pathname + url.search, {
      protocols: [CLUSTER_PROTOCOL],
      serverCertificateHashes: options.serverCertificateHashes,
      quic: options.quic as any,
    });
    await wt.ready;
    this.#wt = wt;
    wt.closed.finally(() => this.#emitSeedDown()).catch(() => {});
    void this.#readIncomingStreams(wt);
    const control = await wt.createBidirectionalStream();
    const writer = control.writable.getWriter();
    // HELLO's stream is the control lane: every later control message rides it
    // instead of opening one of its own.
    this.#lanes.control.writer = writer;
    await writeMetadata(writer, {
      v: 1,
      kind: 'control',
    } satisfies ClusterStreamMetadata);
    this.#readStream(control, writer, {
      v: 1,
      kind: 'control',
    });
    await writeMessage(writer, {
      t: 'HELLO',
      nodeId: this.nodeId,
      load,
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.observer === true ? { observer: true } : {}),
      ...(options.incarnation !== undefined ? { incarnation: options.incarnation } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.certHash !== undefined ? { certHash: options.certHash } : {}),
    });
    // The writer is NOT released here: HELLO's stream is the control lane, and
    // every later control message rides it. Releasing it was correct only while
    // each send opened a stream of its own.
  }
  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.catch(() => {}).then(task);
    this.#queue = next.catch(() => {});
    return this.#queue;
  }
  /**
   * Send a message to the seed. The `_to` argument is ignored.
   *
   * A worker has a single upstream connection, so every send goes to the seed
   * regardless of the destination passed. `PORT_MSG` values travel on their own
   * port-tagged stream; other messages go on a control stream. Sends are
   * serialized through a per-transport queue so writes complete in order. If the
   * session is not connected the send is dropped and resolves immediately.
   * Control-write failures are logged rather than surfaced to the caller.
   *
   * ```ts no_run
   * await worker.send('__seed__', { t: 'HEARTBEAT', ts: Date.now() });
   * ```
   */
  send(_to: string, msg: ClusterMessage): Promise<void> {
    const wt = this.#wt;
    if (wt === null) return Promise.resolve();
    if (isPortMessage(msg)) {
      return laneSend(this.#lanes.port, wt, 'port', msg);
    }
    return laneSend(this.#lanes.control, wt, 'control', msg).catch((err: unknown) => {
      console.error(`fino:cluster worker control write failed: ${err}`);
    });
  }
  /**
   * Always throws: broadcasting is a seed-only capability.
   *
   * A worker has a single upstream connection and no peers to fan out to.
   * `send()` to the seed is the only outbound path.
   *
   * ```ts no_run
   * const worker = new WebTransportWorkerTransport('worker-1');
   * try {
   *   worker.broadcast({ t: 'TERMINATE' });
   * } catch (err) {
   *   // Error: fino:cluster — broadcast is seed-only
   * }
   * ```
   */
  broadcast(_msg: ClusterMessage): void {
    throw new Error('fino:cluster — broadcast is seed-only');
  }
  /**
   * Register a handler for messages received from the seed.
   *
   * Handlers are called in registration order. Messages that arrived before any
   * handler was registered are buffered and flushed to the first handler this
   * method receives, so a handler added immediately after `connect()` still
   * sees the seed's initial `WELCOME`. The `from` value is the originating node
   * ID for port messages and the seed's node ID for control-plane messages.
   *
   * ```ts no_run
   * worker.on((from, msg) => {
   *   if (msg.t === 'WELCOME') console.log(`joined cluster via ${from}`);
   * });
   * ```
   */
  on(handler: Handler): void {
    this.#handlers.push(handler);
    if (this.#pending.length > 0) {
      const pending = this.#pending.splice(0);
      for (const { from, msg } of pending) handler(from, msg);
    }
  }
  /**
   * Close the session to the seed and release the transport's resources.
   *
   * Releases the control writer and closes the WebTransport connection. The
   * transport is unusable afterward; construct and `connect()` a new one to
   * rejoin.
   *
   * ```ts no_run
   * worker.close();
   * ```
   */
  close(): void {
    closeLanes(this.#lanes);
    this.#wt?.close();
    this.#wt = null;
  }
  /**
   * Dispose support: calls `close()` so the transport can be managed with
   * `using`.
   *
   * ```ts no_run
   * import { WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
   *
   * {
   *   using worker = new WebTransportWorkerTransport('worker-1');
   *   await worker.connect('https://seed.internal:4433', { cpu: 0, memory: 0 });
   * } // worker.close() runs at scope exit
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
  async #readIncomingStreams(wt: WebTransport): Promise<void> {
    const reader = wt.incomingBidirectionalStreams.getReader();
    try {
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        if (read.value !== undefined) this.#readStream(read.value);
      }
    } catch {
      this.#emitSeedDown();
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
  #readStream(
    stream: WebTransportBidirectionalStream,
    writer?: StreamWriter,
    initialMetadata: ClusterStreamMetadata | null = null,
  ): void {
    void readClusterStream(
      stream,
      () => {},
      (metadata, msg) => {
        if (msg.t === 'WELCOME') this.#seedNodeId = msg.nodeId;
        const from =
          metadata.kind === 'port' && isPortMessage(msg)
            ? nodeIdFromId(msg.fromPort)
            : this.#seedNodeId;
        if (this.#handlers.length === 0) {
          this.#pending.push({
            from,
            msg,
          });
        } else {
          for (const handler of this.#handlers) handler(from, msg);
        }
      },
      () => {},
      writer,
      initialMetadata,
    ).catch((err: unknown) => {
      if (!isExpectedCloseError(err))
        console.error(`fino:cluster worker received malformed WebTransport stream: ${err}`);
    });
  }
  #emitSeedDown(): void {
    const synth: ClusterMessage = {
      t: 'PEER_DOWN',
      nodeId: this.#seedNodeId,
    };
    for (const handler of this.#handlers) handler(this.#seedNodeId, synth);
  }
}

// ---------------------------------------------------------------------------
// Direct peer mesh
// ---------------------------------------------------------------------------
/** Configuration for one node's participation in the direct peer mesh. */
export interface PeerMeshOptions {
  /** This node's identity, sent in the peer handshake. */
  nodeId: string;
  /** Cluster identity; a dialer from another cluster is refused. */
  clusterId: string | null;
  /** Join token presented and required on peer handshakes. */
  token?: string;
  /** This process incarnation, so a listener can fence a replaced peer. */
  incarnation: number;
  /** Listener configuration; omit to participate dial-only. */
  listen?: {
    port: number;
    hostname?: string;
    path?: string;
    tls: { cert: string; key: string };
    h3?: unknown;
  };
}

/**
 * Direct node-to-node sessions, so realm traffic bypasses the seed.
 *
 * The control plane introduces peers (endpoint plus certificate hash); this
 * class dials them, authenticates with the same join token over a
 * certificate-pinned WebTransport session, and carries `PORT_MSG` frames
 * straight between nodes. The seed remains the fallback path: a node without
 * a listener, or a pair that has not connected yet, keeps relaying through
 * it, so direct sessions are a pure optimization rather than a requirement.
 *
 * Exactly one session exists per pair: the node with the smaller identity
 * dials and the larger one accepts, so simultaneous introductions cannot
 * produce two sessions.
 *
 * @internal
 */
export class PeerMesh {
  #options: PeerMeshOptions;
  #server: ServerHandle | null = null;
  #sessions = new Map<string, PeerConnection>();
  /**
   * Every session this node accepted, including ones refused before they
   * became a peer. Tracked so `close()` can tear down refused sessions too —
   * an untracked open session keeps the listener from shutting down.
   */
  #inbound = new Set<WebTransport>();
  /**
   * HTTP clients backing dialed sessions. Each owns a QUIC connection that
   * outlives its WebTransport session, so closing the session alone would
   * leave the loop alive; they are closed with the mesh.
   */
  #clients = new Set<HttpClient>();
  #incarnations = new Map<string, number>();
  #dialing = new Set<string>();
  #handlers: Handler[] = [];
  /**
   * Streams this node has accepted across every session.
   *
   * Exposed so a test can assert the invariant that matters — messages ride
   * long-lived lanes — rather than the symptom. A transport that opens a
   * stream per message passes a delivery test right up until it exhausts
   * stream credit, which is exactly how that bug survived.
   */
  #inboundStreams = 0;
  #path: string;
  #closed = false;

  constructor(options: PeerMeshOptions) {
    this.#options = options;
    this.#path = normalizePath(options.listen?.path);
  }

  /** Node IDs with a live direct session. */
  get connected(): string[] {
    return Array.from(this.#sessions.keys());
  }

  /**
   * The port the listener actually bound, or `null` when this node has none.
   *
   * A node that asked for port `0` cannot advertise an endpoint until this is
   * readable, so the join sequence listens before it announces itself.
   */
  get port(): number | null {
    return this.#server?.port ?? null;
  }

  /** Total streams accepted from peers; see `#inboundStreams`. */
  get inboundStreams(): number {
    return this.#inboundStreams;
  }

  /** Register a handler for messages arriving over direct sessions. */
  on(handler: Handler): void {
    this.#handlers.push(handler);
  }

  /**
   * Start the listener, if this node was configured with one. Returns nothing;
   * the caller already knows the endpoint and certificate hash it advertises.
   */
  async listen(): Promise<void> {
    const config = this.#options.listen;
    if (config === undefined) return;
    this.#server = serve(
      {
        port: config.port,
        hostname: config.hostname,
        tls: config.tls,
        h3: config.h3 ?? true,
      },
      async (incoming) => {
        const url = new URL(incoming.request.url);
        if (incoming.kind !== 'webtransport' || url.pathname !== this.#path) {
          await incoming.reject(
            new Response('fino cluster peer', {
              status: incoming.kind === 'webtransport' ? 404 : 200,
            }),
          );
          return;
        }
        const wt = await incoming.accept({ protocols: [CLUSTER_PROTOCOL] });
        void this.#acceptSession(wt).catch((err: unknown) => {
          if (!isExpectedCloseError(err)) {
            console.error(`fino:cluster peer session error: ${err}`);
          }
        });
      },
    );
    await this.#server.ready;
  }

  /**
   * Dial a peer introduced by the control plane. No-op when the peer has no
   * endpoint, a session already exists, or this node should be the acceptor.
   */
  async dial(peer: {
    nodeId: string;
    endpoint?: string;
    certHash?: string;
    incarnation?: number;
  }): Promise<boolean> {
    if (this.#closed) return false;
    const { nodeId, endpoint, certHash } = peer;
    if (endpoint === undefined || nodeId === this.#options.nodeId) return false;
    // One session per pair: the smaller identity dials, the larger accepts.
    if (this.#options.nodeId > nodeId) return false;
    if (this.#sessions.has(nodeId) || this.#dialing.has(nodeId)) return false;
    this.#dialing.add(nodeId);
    try {
      const url = new URL(endpoint);
      const client = new HttpClient({ baseUrl: url.origin, protocols: ['h3'] });
      this.#clients.add(client);
      const wt = await client.webtransport(url.pathname + url.search, {
        protocols: [CLUSTER_PROTOCOL],
        ...(certHash !== undefined
          ? {
              serverCertificateHashes: [
                {
                  algorithm: 'sha-256' as const,
                  value: Uint8Array.from(
                    certHash.match(/../g)!.map((byte) => parseInt(byte, 16)),
                  ),
                },
              ],
            }
          : {}),
      });
      await wt.ready;
      const control = await wt.createBidirectionalStream();
      const writer = control.writable.getWriter();
      await writeMetadata(writer, { v: 1, kind: 'control' });
      this.#readSessionStream(control, writer, nodeId);
      await writeMessage(writer, {
        t: 'HELLO',
        nodeId: this.#options.nodeId,
        load: { cpu: 0, memory: 0 },
        incarnation: this.#options.incarnation,
        ...(this.#options.token !== undefined ? { token: this.#options.token } : {}),
        ...(this.#options.clusterId !== null ? { clusterId: this.#options.clusterId } : {}),
      });
      const lanes = newLanes();
      // HELLO already opened a control stream and wrote its metadata; adopt it
      // as the control lane rather than opening a second one alongside it.
      lanes.control.writer = writer;
      const conn: PeerConnection = { wt, control: writer, lanes };
      this.#sessions.set(nodeId, conn);
      wt.closed.finally(() => this.#dropSession(nodeId, conn)).catch(() => {});
      void this.#readIncoming(wt, nodeId);
      return true;
    } catch {
      // A failed dial is not fatal: traffic keeps flowing through the seed.
      return false;
    } finally {
      this.#dialing.delete(nodeId);
    }
  }

  /**
   * Send over the direct session to `to`. Returns false when no session
   * exists, so the caller can fall back to the seed path.
   */
  send(to: string, msg: ClusterMessage): boolean {
    const conn = this.#sessions.get(to);
    if (conn === undefined) return false;
    const lane = isPortMessage(msg) ? conn.lanes.port : conn.lanes.control;
    void laneSend(lane, conn.wt, isPortMessage(msg) ? 'port' : 'control', msg).catch((err: unknown) => {
      if (!isExpectedCloseError(err)) {
        console.error(`fino:cluster peer write failed: ${err}`);
      }
      this.#dropSession(to, conn);
    });
    return true;
  }

  /**
   * Resolve once everything already queued for `to` has been written.
   *
   * A realm's exit must not overtake its own last messages. When those went
   * over a direct session and the exit goes through the seed, the only thing
   * keeping them ordered is that the frames are on the wire first — so the
   * sender waits for this before announcing the exit.
   */
  flush(to: string): Promise<void> {
    return this.#sessions.get(to)?.queue ?? Promise.resolve();
  }

  /** Close every session and the listener. */
  close(): void {
    this.#closed = true;
    for (const [nodeId, conn] of this.#sessions) {
      this.#sessions.delete(nodeId);
      closeConnection(conn);
    }
    for (const wt of this.#inbound) {
      try {
        wt.close();
      } catch {}
    }
    this.#inbound.clear();
    for (const client of this.#clients) {
      void client.close().catch(() => {});
    }
    this.#clients.clear();
    this.#server?.close().catch(() => {});
    this.#server = null;
    this.#handlers = [];
  }

  async #acceptSession(wt: WebTransport): Promise<void> {
    await wt.ready;
    let peerNodeId: string | null = null;
    this.#inbound.add(wt);
    const streams = wt.incomingBidirectionalStreams.getReader();
    wt.closed
      .finally(() => {
        this.#inbound.delete(wt);
        if (peerNodeId !== null) {
          const conn = this.#sessions.get(peerNodeId);
          if (conn !== undefined) this.#dropSession(peerNodeId, conn);
        }
      })
      .catch(() => {});
    try {
      while (true) {
        const read = await streams.read();
        if (read.done) break;
        const stream = read.value;
        if (stream === undefined) continue;
        this.#inboundStreams++;
        let streamWriter: StreamWriter | null = null;
        void readClusterStream(
          stream,
          async (metadata, writer) => {
            if (metadata.kind === 'control') streamWriter = writer;
          },
          (metadata, msg) => {
            if (msg.t === 'HELLO') {
              if (!this.#admit(msg)) {
                // Refused: drop the whole session rather than the stream, so
                // an unauthenticated dialer holds no resources here. The
                // session stays tracked until its close handler fires, so a
                // teardown that races the refusal still reaps it.
                if (streamWriter !== null) closeWriter(streamWriter);
                wt.close();
                return;
              }
              peerNodeId = msg.nodeId;
              this.#incarnations.set(msg.nodeId, msg.incarnation ?? 0);
              this.#sessions.set(peerNodeId, {
                wt,
                control: streamWriter,
                lanes: newLanes(),
              });
              return;
            }
            if (peerNodeId === null) return;
            for (const handler of this.#handlers) handler(peerNodeId, msg);
          },
          (metadata) => {
            void metadata;
          },
        ).catch((err: unknown) => {
          if (!isExpectedCloseError(err)) {
            console.error(`fino:cluster peer received malformed stream: ${err}`);
          }
        });
      }
    } finally {
      try {
        streams.releaseLock();
      } catch {}
    }
  }

  /** Authenticate and fence one inbound peer handshake. */
  #admit(msg: Extract<ClusterMessage, { t: 'HELLO' }>): boolean {
    if (this.#options.token !== undefined && msg.token !== this.#options.token) return false;
    if (
      this.#options.clusterId !== null &&
      msg.clusterId !== undefined &&
      msg.clusterId !== this.#options.clusterId
    ) {
      return false;
    }
    const known = this.#incarnations.get(msg.nodeId);
    if (known !== undefined && msg.incarnation !== undefined && msg.incarnation < known) {
      // A replaced process must not reclaim the session it lost.
      return false;
    }
    return true;
  }

  async #readIncoming(wt: WebTransport, nodeId: string): Promise<void> {
    const streams = wt.incomingBidirectionalStreams.getReader();
    try {
      while (true) {
        const read = await streams.read();
        if (read.done) break;
        const stream = read.value;
        if (stream === undefined) continue;
        this.#inboundStreams++;
        void readClusterStream(
          stream,
          async () => {},
          (metadata, msg) => {
            void metadata;
            for (const handler of this.#handlers) handler(nodeId, msg);
          },
          () => {},
        ).catch((err: unknown) => {
          if (!isExpectedCloseError(err)) {
            console.error(`fino:cluster peer stream error: ${err}`);
          }
        });
      }
    } catch {
      // Session teardown is handled by the closed promise.
    } finally {
      try {
        streams.releaseLock();
      } catch {}
    }
  }

  #readSessionStream(
    stream: { readable: unknown; writable: unknown },
    writer: StreamWriter,
    nodeId: string,
  ): void {
    void readClusterStream(
      stream as never,
      async () => {},
      (metadata, msg) => {
        void metadata;
        for (const handler of this.#handlers) handler(nodeId, msg);
      },
      () => {},
      // dial() already holds this stream's writer. Without passing it the
      // reader tried to take a second one and threw on every dial, so a
      // dialer never read anything the peer sent back on its own stream.
      writer,
      { v: 1, kind: 'control' },
    ).catch((err: unknown) => {
      if (!isExpectedCloseError(err)) {
        console.error(`fino:cluster peer control stream error: ${err}`);
      }
    });
  }

  #dropSession(nodeId: string, conn: PeerConnection): void {
    const current = this.#sessions.get(nodeId);
    if (current !== conn) return;
    this.#sessions.delete(nodeId);
    closeConnection(conn);
  }
}
