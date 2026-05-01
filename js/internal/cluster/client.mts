/**
 * internal:cluster/client — worker node cluster client.
 *
 * A ClusterClient:
 * - Connects to the seed, sends HELLO, waits for WELCOME.
 * - Accepts SPAWN messages and creates local realm instances for them.
 * - Bridges each local realm's ThreadPort ↔ cluster PORT_MSG transport
 *   (the relay pattern — the relay is transparent to all message content,
 *   so __rpc_req / __rpc_res travel as opaque PORT_MSG payloads).
 * - Sends HEARTBEAT every 2.5 s.
 * - Exposes spawnRemote() so the cluster public API can spawn realms onto
 *   remote nodes by sending SPAWN through the seed.
 * - Exposes registerPort() so ClusterPort instances can receive PORT_MSG.
 */

import type { ClusterTransport } from './transport.mts';
import {
  type ClusterMessage,
  type SerializedSpawnConfig,
  type PeerInfo,
  encode,
  decode,
  nodeIdFromId,
} from './protocol.mts';
import { serialize, deserialize } from 'internal:serializer';
import { createThreadContext, stepThreadContext, getThreadPortWakeReadFd, threadPortSend, threadPortRecv } from 'internal:realm-native';
import { readable, removeRead } from 'fino:runtime/loop';
import { BaseTransportPort } from '../globals/messaging.mts';

const HEARTBEAT_MS = 2500;

// ---------------------------------------------------------------------------
// Base64 helpers for payload encoding
// ---------------------------------------------------------------------------

function uint8ToBase64(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return btoa(s);
}

function base64ToUint8(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// PORT_MSG payload is a JSON array of base64 strings: [main, ...stores].
// Encoding all parts preserves ArrayBuffer transfer stores end-to-end.
function encodePayload(parts: Uint8Array[]): string {
  return JSON.stringify(parts.map(uint8ToBase64));
}

function decodePayload(payload: string): Uint8Array[] {
  return (JSON.parse(payload) as string[]).map(base64ToUint8);
}

// ---------------------------------------------------------------------------
// Local relay — bridges a ThreadPort to cluster PORT_MSG
// ---------------------------------------------------------------------------

interface RealmRelay {
  childPortId: string;
  parentPortId: string;
  threadHandle: number;
  wakeReadFd: number;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// ClusterClient
// ---------------------------------------------------------------------------

export class ClusterClient {
  readonly nodeId: string;

  #transport: ClusterTransport;
  #peers = new Map<string, PeerInfo>();
  #relays = new Map<string, RealmRelay>();         // childPortId → relay
  #portHandlers = new Map<string, ClusterPort>();  // portId → ClusterPort (parent side)
  #exitHandlers = new Map<string, (error?: string) => void>(); // childPortId → exit callback
  #pendingSpawns = new Map<string, {
    resolve: (childPortId: string) => void;
    reject: (err: Error) => void;
  }>();
  #localHandle = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(transport: ClusterTransport, nodeId: string) {
    this.nodeId    = nodeId;
    this.#transport = transport;
  }

  get peers(): PeerInfo[] { return [...this.#peers.values()]; }

  /** Register a ClusterPort so it receives incoming PORT_MSG. */
  registerPort(portId: string, port: ClusterPort): void {
    this.#portHandlers.set(portId, port);
  }

  unregisterPort(portId: string): void {
    this.#portHandlers.delete(portId);
  }

  /**
   * Register a one-shot callback for when the realm identified by childPortId exits.
   * Used by Realm.run() and Realm.call() to await remote realm completion.
   */
  onRealmExit(childPortId: string, handler: (error?: string) => void): void {
    this.#exitHandlers.set(childPortId, handler);
  }

  /** @internal — called by ClusterPort.postMessage */
  sendPortMsg(fromPort: string, toPort: string, parts: Uint8Array[]): void {
    const targetNodeId = nodeIdFromId(toPort);
    const payload = encodePayload(parts);
    this.#transport.send(targetNodeId, { t: 'PORT_MSG', fromPort, toPort, payload });
  }

  /**
   * Spawn a realm on a remote node by sending SPAWN through the seed.
   * Returns the assigned childPortId on success.
   */
  spawnRemote(parentPortId: string, config: SerializedSpawnConfig): Promise<string> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise<string>((resolve, reject) => {
      this.#pendingSpawns.set(spawnReqId, { resolve, reject });
      this.#transport.send('__seed__', {
        t: 'SPAWN',
        spawnReqId,
        parentPortId,
        config,
      });
    });
  }

  start(): void {
    this.#transport.on((from, msg) => this.#handle(from, msg));
    this.#heartbeatTimer = setInterval(() => {
      this.#transport.send('__seed__', { t: 'HEARTBEAT', ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    for (const relay of this.#relays.values()) {
      relay.closed = true;
      // Cancel any pending readable() on the relay's wake-fd so the
      // event-loop registration is released before the relay map is cleared.
      removeRead(relay.wakeReadFd);
    }
    this.#relays.clear();
    // Reject all pending realm-exit waiters so Realm.run() / Realm.call() settle.
    const err = new Error('fino:cluster — cluster connection closed');
    for (const handler of this.#exitHandlers.values()) {
      try { handler(err.message); } catch { /* ignore */ }
    }
    this.#exitHandlers.clear();
    for (const pending of this.#pendingSpawns.values()) {
      pending.reject(err);
    }
    this.#pendingSpawns.clear();
    this.#transport.close();
  }

  #handle(from: string, msg: ClusterMessage): void {
    switch (msg.t) {
      case 'WELCOME': {
        for (const p of msg.peers) this.#peers.set(p.nodeId, p);
        break;
      }

      case 'PEER_UP': {
        this.#peers.set(msg.peer.nodeId, msg.peer);
        break;
      }

      case 'PEER_DOWN': {
        this.#peers.delete(msg.nodeId);
        break;
      }

      case 'SPAWN_ACK': {
        const pending = this.#pendingSpawns.get(msg.spawnReqId);
        this.#pendingSpawns.delete(msg.spawnReqId);
        if (!pending) break;
        if (msg.ok) {
          pending.resolve(msg.childPortId);
        } else {
          pending.reject(new Error(msg.error ?? 'Spawn failed'));
        }
        break;
      }

      case 'SPAWN': {
        this.#handleSpawn(msg).catch((err: unknown) => {
          this.#transport.send('__seed__', {
            t: 'SPAWN_ACK',
            spawnReqId: msg.spawnReqId,
            childPortId: '',
            ok: false,
            error: String(err),
          });
        });
        break;
      }

      case 'TERMINATE': {
        const relay = this.#relays.get(msg.realmId);
        if (relay && !relay.closed) {
          relay.closed = true;
          this.#sendToThread(relay.threadHandle, { __terminate: true });
        }
        break;
      }

      case 'REALM_EXIT': {
        // A remote realm we spawned has exited — notify the parent-side waiter.
        const handler = this.#exitHandlers.get(msg.realmId);
        if (handler) {
          this.#exitHandlers.delete(msg.realmId);
          handler(msg.error);
        }
        break;
      }

      case 'PORT_MSG': {
        const localPort = this.#portHandlers.get(msg.toPort);
        if (localPort) {
          // Deliver to parent-side ClusterPort — pass raw parts so stores are preserved.
          try {
            localPort._deliver(decodePayload(msg.payload));
          } catch (err: unknown) {
            console.error(`fino:cluster PORT_MSG decode error (parent port): ${err}`);
          }
          break;
        }
        const relay = this.#relays.get(msg.toPort);
        if (relay && !relay.closed) {
          // Deliver to child thread realm. Deserialize with stores so transferred
          // ArrayBuffers are reconstructed before being forwarded.
          try {
            const parts = decodePayload(msg.payload);
            const [mainBuf, ...stores] = parts;
            if (mainBuf) {
              const value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
                mainBuf, stores.length > 0 ? stores : undefined,
              );
              this.#sendToThread(relay.threadHandle, value);
            }
          } catch (err: unknown) {
            console.error(`fino:cluster PORT_MSG decode error (relay): ${err}`);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  async #handleSpawn(msg: Extract<ClusterMessage, { t: 'SPAWN' }>): Promise<void> {
    const childPortId = `${this.nodeId}/${this.#localHandle++}`;

    const handle = createThreadContext(
      msg.config.root ?? '',
      msg.config.entry,
      JSON.stringify(msg.config.rules),
    ) as number;

    const wakeReadFd = getThreadPortWakeReadFd(handle) as number;

    const relay: RealmRelay = {
      childPortId,
      parentPortId: msg.parentPortId,
      threadHandle: handle,
      wakeReadFd,
      closed: false,
    };
    this.#relays.set(childPortId, relay);

    // Send SPAWN_ACK so the parent's ClusterPort gets the childPortId
    this.#transport.send('__seed__', {
      t: 'SPAWN_ACK',
      spawnReqId: msg.spawnReqId,
      childPortId,
      ok: true,
    });

    // Start relay loop: forward thread port messages to the parent via PORT_MSG
    this.#runRelayLoop(relay);
  }

  async #runRelayLoop(relay: RealmRelay): Promise<void> {
    const { wakeReadFd, threadHandle } = relay;
    let stepError: string | undefined;

    const finalize = () => {
      if (relay.closed) return;
      relay.closed = true;
      removeRead(wakeReadFd);
      this.#relays.delete(relay.childPortId);
      const msg: ClusterMessage = stepError !== undefined
        ? { t: 'REALM_EXIT', realmId: relay.childPortId, error: stepError }
        : { t: 'REALM_EXIT', realmId: relay.childPortId };
      this.#transport.send('__seed__', msg);
    };

    // Drive the child realm on every event-loop tick so that timers, microtasks,
    // and outbound port writes advance even when no inbound message arrives.
    // This mirrors how _stepChildren() works for embedded/thread realms.
    const stepInterval = setInterval(() => {
      if (relay.closed) { clearInterval(stepInterval); return; }
      try {
        const alive = (stepThreadContext(threadHandle) as boolean) !== false;
        if (!alive) finalize();
      } catch (err: unknown) {
        stepError = String(err);
        finalize();
      }
    }, 0);

    // Drain inbound messages from the parent whenever the wake-fd fires.
    // Use try-finally so finalize() always runs even if readable() throws
    // (e.g., fd closed externally), ensuring REALM_EXIT is always sent.
    try {
      while (!relay.closed) {
        await readable(wakeReadFd);
        if (relay.closed) break;
        this.#drainInbound(relay, finalize);
      }
    } finally {
      finalize();
      clearInterval(stepInterval);
    }
  }

  #drainInbound(relay: RealmRelay, finalize: () => void): void {
    // threadPortRecv returns [[Uint8Array[], portInfos[]], ...]
    const messages = (threadPortRecv as (h: number) => unknown)(relay.threadHandle) as any[];
    for (const [byteArr] of messages) {
      try {
        const parts = byteArr as Uint8Array[];
        const mainBuf = parts[0];
        if (!mainBuf) continue;

        // Quick peek to detect __terminate without a full deserialize+reserialize cycle.
        let isTerminate = false;
        try {
          const peeked = (deserialize as (b: Uint8Array) => unknown)(mainBuf);
          isTerminate = peeked !== null && typeof peeked === 'object' && (peeked as any).__terminate === true;
        } catch { /* not a terminate signal — forward as normal */ }

        if (isTerminate) { finalize(); return; }

        // Forward raw serialized bytes (preserves stores for ArrayBuffer transfers).
        const payload = encodePayload(parts);
        this.#transport.send('__seed__', {
          t: 'PORT_MSG',
          fromPort: relay.childPortId,
          toPort: relay.parentPortId,
          payload,
        });
      } catch (err: unknown) {
        console.error(`fino:cluster relay drain error: ${err}`);
      }
    }
  }

  #sendToThread(handle: number, value: unknown): void {
    const bytes = (serialize as (v: unknown) => Uint8Array[])(value)[0]!;
    (threadPortSend as (h: number, b: Uint8Array, s: Uint8Array[], p: unknown[]) => void)(
      handle, bytes, [], [],
    );
  }
}

// ---------------------------------------------------------------------------
// ClusterPort — parent-side port for communicating with a remote child realm
// ---------------------------------------------------------------------------

/**
 * ClusterPort provides a MessagePort-compatible API for cross-node Realm
 * messaging. Outbound messages are serialized and sent as PORT_MSG cluster
 * messages; inbound PORT_MSG payloads are deserialized and dispatched.
 *
 * __rpc_res messages are intercepted and routed to internal:parent-rpc,
 * matching the pattern used by ThreadPort and ProcessPort.
 */
export class ClusterPort extends BaseTransportPort {
  readonly portId: string;

  #client: ClusterClient;
  #childPortId: string | null = null;

  constructor(portId: string, client: ClusterClient) {
    super();
    this.portId  = portId;
    this.#client = client;
    client.registerPort(portId, this);
  }

  /** Called after SPAWN_ACK to set the routing target. */
  _setChildPortId(childPortId: string): void {
    this.#childPortId = childPortId;
  }

  postMessage(message: unknown, transfer?: ArrayBuffer[]): void {
    if (this._closed || this.#childPortId === null) return;
    const parts = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
      message, transfer && transfer.length > 0 ? transfer : undefined,
    );
    this.#client.sendPortMsg(this.portId, this.#childPortId, parts);
  }

  protected override _onClose(): void {
    this.#client.unregisterPort(this.portId);
  }

  /** @internal — called by ClusterClient when a PORT_MSG arrives for this port. */
  _deliver(parts: Uint8Array[]): void {
    const [mainBuf, ...stores] = parts;
    if (!mainBuf) return;
    this._dispatchMessage(mainBuf, stores.length > 0 ? stores : undefined);
  }
}
