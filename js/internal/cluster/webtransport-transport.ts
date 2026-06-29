/**
 * internal:cluster/webtransport-transport - WebTransport implementations of ClusterTransport.
 *
 * Cluster control messages run on reliable bidirectional streams attached to
 * the worker WebTransport session. Each `PORT_MSG` uses a separate reliable
 * bidirectional stream tagged with the canonical logical port pair, so one
 * noisy realm link does not share stream ordering with the control plane.
 *
 * @internal
 */

import { serve } from 'fino:net/http/server';
import { HttpClient } from 'fino:net/http/client';
import type { WebTransport, WebTransportBidirectionalStream, WebTransportHash } from 'fino:net/http/webtransport';
import { Response } from 'internal:net/http/wire';
import type { ClusterTransport } from './transport.ts';
import { decode, encode, nodeIdFromId, type ClusterMessage } from './protocol.ts';
import {
  canonicalPortPair,
  ClusterStreamFrameReader,
  encodeClusterStreamFrame,
  type ClusterStreamMetadata,
} from './webtransport-framing.ts';

export const DEFAULT_CLUSTER_PATH = '/__fino_cluster';
const CLUSTER_PROTOCOL = 'fino-cluster-v1';

type ServerHandle = { ready: Promise<void>; close(): Promise<void> };
type Handler = (from: string, msg: ClusterMessage) => void;
type LoadInfo = { cpu: number; memory: number };
type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;

export interface WebTransportSeedOptions {
  port: number;
  hostname?: string;
  tls: { cert: string; key: string };
  path?: string;
  h3?: true | { quic?: Record<string, unknown> };
}

export interface WebTransportWorkerConnectOptions {
  tls?: { ca?: string; rejectUnauthorized?: boolean };
  quic?: Record<string, unknown>;
  serverCertificateHashes?: readonly WebTransportHash[];
}

interface PeerConnection {
  wt: WebTransport;
  control: StreamWriter | null;
  queue: Promise<void>;
}

function normalizePath(path: string | undefined): string {
  if (path === undefined || path === '') return DEFAULT_CLUSTER_PATH;
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeSeedUrl(seed: string | URL): URL {
  const url = new URL(String(seed));
  if (url.protocol !== 'https:') throw new TypeError('WebTransport cluster seeds must use https: URLs');
  if (url.pathname === '/') url.pathname = DEFAULT_CLUSTER_PATH;
  return url;
}

function isPortMessage(msg: ClusterMessage): msg is Extract<ClusterMessage, { t: 'PORT_MSG' }> {
  return msg.t === 'PORT_MSG';
}

function frameMessage(msg: ClusterMessage): Uint8Array {
  return encodeClusterStreamFrame(encode(msg));
}

function decodeMessage(value: unknown): ClusterMessage {
  if (typeof value !== 'string') throw new Error('cluster WebTransport message frame must contain encoded JSON');
  return decode(value);
}

async function writeFrame(writer: StreamWriter, value: unknown): Promise<void> {
  await writer.write(encodeClusterStreamFrame(value));
}

async function writeMessage(writer: StreamWriter, msg: ClusterMessage): Promise<void> {
  await writer.write(frameMessage(msg));
}

function closeWriter(writer: StreamWriter): void {
  try { writer.releaseLock(); } catch { /* already released */ }
}

function isExpectedCloseError(error: unknown): boolean {
  return /connection is closed|stream is closed|transport is closed/i.test(String(error));
}

function closeConnection(conn: PeerConnection): void {
  if (conn.control !== null) closeWriter(conn.control);
  conn.wt.close();
}

function enqueueConnectionSend(conn: PeerConnection, task: () => Promise<void>): Promise<void> {
  const next = conn.queue.catch(() => {}).then(task);
  conn.queue = next.catch(() => {});
  return conn.queue;
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
          if (!isMetadata(value)) throw new Error('cluster WebTransport stream missing metadata frame');
          metadata = value;
          await onMetadata(metadata, writer);
          continue;
        }
        onMessage(metadata, decodeMessage(value));
      }
    }
    frames.assertComplete();
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    onClose(metadata);
  }
}

function isMetadata(value: unknown): value is ClusterStreamMetadata {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return false;
  if (record.kind === 'control') return true;
  return record.kind === 'port'
    && typeof record.pair === 'string'
    && typeof record.a === 'string'
    && typeof record.b === 'string';
}

async function sendPortMessage(wt: WebTransport, msg: Extract<ClusterMessage, { t: 'PORT_MSG' }>): Promise<void> {
  const fromPort = msg.fromPort;
  const toPort = msg.toPort;
  const pair = canonicalPortPair(fromPort, toPort);
  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  const metadata = { v: 1, kind: 'port', pair, a: fromPort, b: toPort } satisfies ClusterStreamMetadata;
  await writeFrame(writer, metadata);
  await writeMessage(writer, msg);
  closeWriter(writer);
}

async function sendControlMessage(wt: WebTransport, msg: ClusterMessage): Promise<void> {
  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  await writeFrame(writer, { v: 1, kind: 'control' } satisfies ClusterStreamMetadata);
  await writeMessage(writer, msg);
  closeWriter(writer);
}

export class WebTransportSeedTransport implements ClusterTransport {
  readonly nodeId: string;
  readonly #options: WebTransportSeedOptions;
  readonly #path: string;
  #connections = new Map<string, PeerConnection>();
  #handlers: Handler[] = [];
  #server: ServerHandle | null = null;

  constructor(nodeId: string, options: WebTransportSeedOptions) {
    this.nodeId = nodeId;
    this.#options = options;
    this.#path = normalizePath(options.path);
  }

  async listen(): Promise<void> {
    this.#server = serve({
      port: this.#options.port,
      hostname: this.#options.hostname,
      tls: this.#options.tls,
      h3: this.#options.h3 ?? true,
    }, async (incoming) => {
      const url = new URL(incoming.request.url);
      if (incoming.kind !== 'webtransport' || url.pathname !== this.#path) {
        await incoming.reject(new Response('fino cluster seed', { status: incoming.kind === 'webtransport' ? 404 : 200 }));
        return;
      }
      const wt = await incoming.accept({ protocols: [CLUSTER_PROTOCOL] });
      void this.#handleSession(wt).catch((err: unknown) => {
        console.error(`fino:cluster seed WebTransport session error: ${err}`);
      });
    });
    await this.#server.ready;
  }

  send(to: string, msg: ClusterMessage): Promise<void> {
    const conn = this.#connections.get(to);
    if (conn === undefined) return Promise.resolve();
    if (isPortMessage(msg)) {
      return enqueueConnectionSend(conn, () => sendPortMessage(conn.wt, msg));
    }
    return enqueueConnectionSend(conn, () => sendControlMessage(conn.wt, msg)).catch((err: unknown) => {
      console.error(`fino:cluster seed control write failed: ${err}`);
    });
  }

  broadcast(msg: ClusterMessage): void {
    for (const nodeId of this.#connections.keys()) this.send(nodeId, msg);
  }

  broadcastExcept(exceptNodeId: string, msg: ClusterMessage): void {
    for (const nodeId of this.#connections.keys()) {
      if (nodeId !== exceptNodeId) this.send(nodeId, msg);
    }
  }

  on(handler: Handler): void {
    this.#handlers.push(handler);
  }

  close(): void {
    for (const conn of this.#connections.values()) closeConnection(conn);
    this.#connections.clear();
    this.#server?.close().catch((err: unknown) => {
      console.error(`fino:cluster seed server close error: ${err}`);
    });
    this.#server = null;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async #handleSession(wt: WebTransport): Promise<void> {
    await wt.ready;
    let peerNodeId: string | null = null;
    const streams = wt.incomingBidirectionalStreams.getReader();
    wt.closed.finally(() => {
      if (peerNodeId !== null) this.#emitPeerDown(peerNodeId);
    }).catch(() => {});
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
                queue: Promise.resolve(),
              });
            }
            const from = peerNodeId ?? (msg.t === 'HELLO' ? msg.nodeId : '__unknown__');
            for (const handler of this.#handlers) handler(from, msg);
          },
          (metadata) => {
            void metadata;
          },
        ).catch((err: unknown) => {
          if (!isExpectedCloseError(err)) console.error(`fino:cluster seed received malformed WebTransport stream: ${err}`);
          if (peerNodeId !== null) this.#emitPeerDown(peerNodeId);
        });
      }
    } finally {
      try { streams.releaseLock(); } catch { /* already released */ }
    }
  }

  #emitPeerDown(peerNodeId: string): void {
    const conn = this.#connections.get(peerNodeId);
    if (conn === undefined) return;
    this.#connections.delete(peerNodeId);
    closeConnection(conn);
    const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: peerNodeId };
    for (const handler of this.#handlers) handler(peerNodeId, synth);
  }
}

export class WebTransportWorkerTransport implements ClusterTransport {
  readonly nodeId: string;
  #wt: WebTransport | null = null;
  #control: StreamWriter | null = null;
  #handlers: Handler[] = [];
  #pending: Array<{ from: string; msg: ClusterMessage }> = [];
  #queue: Promise<void> = Promise.resolve();
  #seedNodeId = '__seed__';

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  async connect(
    seed: string | URL,
    load: LoadInfo = { cpu: 0, memory: 0 },
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
    this.#control = writer;
    await writeFrame(writer, { v: 1, kind: 'control' } satisfies ClusterStreamMetadata);
    this.#readStream(control, writer, { v: 1, kind: 'control' });
    await writeMessage(writer, { t: 'HELLO', nodeId: this.nodeId, load });
    closeWriter(writer);
    this.#control = null;
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.catch(() => {}).then(task);
    this.#queue = next.catch(() => {});
    return this.#queue;
  }

  send(_to: string, msg: ClusterMessage): Promise<void> {
    if (isPortMessage(msg)) {
      const wt = this.#wt;
      if (wt === null) return Promise.resolve();
      return this.#enqueue(() => sendPortMessage(wt, msg));
    }
    const wt = this.#wt;
    if (wt === null) return Promise.resolve();
    return this.#enqueue(() => sendControlMessage(wt, msg)).catch((err: unknown) => {
      console.error(`fino:cluster worker control write failed: ${err}`);
    });
  }

  broadcast(_msg: ClusterMessage): void {
    throw new Error('fino:cluster — broadcast is seed-only');
  }

  on(handler: Handler): void {
    this.#handlers.push(handler);
    if (this.#pending.length > 0) {
      const pending = this.#pending.splice(0);
      for (const { from, msg } of pending) handler(from, msg);
    }
  }

  close(): void {
    if (this.#control !== null) closeWriter(this.#control);
    this.#control = null;
    this.#wt?.close();
    this.#wt = null;
  }

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
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  #readStream(stream: WebTransportBidirectionalStream, writer?: StreamWriter, initialMetadata: ClusterStreamMetadata | null = null): void {
    void readClusterStream(
      stream,
      () => {},
      (metadata, msg) => {
        if (msg.t === 'WELCOME') this.#seedNodeId = msg.nodeId;
        const from = metadata.kind === 'port' && isPortMessage(msg) ? nodeIdFromId(msg.fromPort) : this.#seedNodeId;
        if (this.#handlers.length === 0) {
          this.#pending.push({ from, msg });
        } else {
          for (const handler of this.#handlers) handler(from, msg);
        }
      },
      () => {},
      writer,
      initialMetadata,
    ).catch((err: unknown) => {
      if (!isExpectedCloseError(err)) console.error(`fino:cluster worker received malformed WebTransport stream: ${err}`);
    });
  }

  #emitSeedDown(): void {
    const synth: ClusterMessage = { t: 'PEER_DOWN', nodeId: this.#seedNodeId };
    for (const handler of this.#handlers) handler(this.#seedNodeId, synth);
  }
}
