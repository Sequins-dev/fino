/**
* internal:cluster/client - worker node cluster client.
*
* A `ClusterClient` is the worker-side half of the cluster protocol. It sits
* on top of a `ClusterTransport` — the transport owns the connection and the
* HELLO handshake — and:
*
* - Tracks peer membership from the seed's WELCOME / PEER_UP / PEER_DOWN
*   messages.
* - Accepts SPAWN messages and creates local thread realms for them.
* - Bridges each spawned realm's ThreadPort <-> cluster PORT_MSG transport
*   (the relay pattern - the relay is transparent to all message content,
*   so __rpc_req / __rpc_res travel as opaque PORT_MSG payloads).
* - Sends HEARTBEAT to the seed every 2.5 s.
* - Exposes spawnRemote() so the cluster public API can spawn realms onto
*   remote nodes by sending SPAWN through the seed.
* - Exposes registerPort() so ClusterPort instances can receive PORT_MSG.
*
* `ClusterPort` is the parent-side handle for a remotely spawned realm: a
* `BaseTransportPort` whose messages travel as PORT_MSG cluster frames
* instead of an in-process channel. Ports register themselves with the
* client on construction, queue outbound messages until SPAWN_ACK assigns
* the child port ID, and preserve transferred ArrayBuffers end-to-end as
* base64-encoded serializer store parts.
*
* ## Example
*
* ```ts no_run
* import { ClusterClient, ClusterPort } from 'internal:cluster/client';
*
* const transport = {
*   nodeId: 'worker-a',
*   send(to, msg) { void to; void msg; },
*   broadcast(msg) { void msg; },
*   on(handler) { void handler; },
*   close() {},
* };
*
* const client = new ClusterClient(transport, 'worker-a');
* client.start();
*
* // Spawn a realm on another node and talk to it through a port.
* const port = new ClusterPort('worker-a/p-1', client);
* const childPortId = await client.spawnRemote(port.portId, {
*   entry: '/app/child.ts',
*   root: '/app',
*   rules: [],
* });
* port._setChildPortId(childPortId);
* port.postMessage({ hello: 'child' });
* ```
*
* @internal
*/
import type { ClusterTransport } from './transport.ts';
import { type ClusterMessage, type SerializedSpawnConfig, type PeerInfo, encode, decode, nodeIdFromId } from './protocol.ts';
import { serialize, deserialize } from 'internal:serializer';
import { createThreadContext, stepThreadContext, getThreadPortWakeReadFd, threadPortSend, threadPortRecv } from 'internal:realm-native';
import { readable, removeRead } from 'internal:runtime/loop';
import { BaseTransportPort } from 'internal:realm/transport-port';
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
// Local relay - bridges a ThreadPort to cluster PORT_MSG
// ---------------------------------------------------------------------------
interface RealmRelay {
  childPortId: string;
  parentPortId: string;
  threadHandle: number;
  wakeReadFd: number;
  closed: boolean;
  pendingSends: Promise<void>[];
  lastCallError?: string;
}
// ---------------------------------------------------------------------------
// ClusterClient
// ---------------------------------------------------------------------------
/**
* Worker-side cluster coordinator.
*
* `ClusterClient` tracks peer membership, sends heartbeats, forwards local
* `ClusterPort` messages, and starts child thread realms when the seed routes
* a `SPAWN` message to this node. It assumes its transport has already been
* connected when required by the transport implementation.
*
* ```ts no_run
* import { ClusterClient } from 'internal:cluster/client';
* import { WebTransportWorkerTransport } from 'internal:cluster/webtransport-transport';
* const transport = new WebTransportWorkerTransport('worker-1');
* const client = new ClusterClient(transport, 'worker-1');
* client.start();
* ```
*
* @internal
*/
export class ClusterClient {
  /**
  * Local node ID used to generate spawn request and port IDs.
  *
  * The value should match `transport.nodeId`. The client does not validate or
  * normalize it, so callers must pass a bare cluster node ID.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.nodeId;
  * ```
  */
  readonly nodeId: string;
  /**
  * Transport used to reach the seed and peers. The client assumes it is
  * already connected where the implementation requires it, and closes it in
  * `stop()`.
  *
  * @internal
  */
  #transport: ClusterTransport;
  /**
  * Peer membership keyed by node ID, populated from the seed's WELCOME
  * message and kept current by PEER_UP / PEER_DOWN.
  *
  * @internal
  */
  #peers = new Map<string, PeerInfo>();
  /**
  * Active child-realm relays keyed by childPortId. Each relay bridges a
  * locally spawned thread realm's ThreadPort to cluster PORT_MSG traffic;
  * entries are removed when the realm exits or `stop()` runs.
  *
  * @internal
  */
  #relays = new Map<string, RealmRelay>();
  /**
  * Parent-side `ClusterPort` instances keyed by portId, consulted first when
  * routing an inbound PORT_MSG.
  *
  * @internal
  */
  #portHandlers = new Map<string, ClusterPort>();
  /**
  * One-shot realm-exit callbacks keyed by childPortId, registered through
  * `onRealmExit()` and consumed on REALM_EXIT, TERMINATE, PEER_DOWN, or
  * `stop()`.
  *
  * @internal
  */
  #exitHandlers = new Map<string, (error?: string) => void>();
  /**
  * Exit results (error string or undefined for clean exit) for realms that
  * exited before any `onRealmExit()` handler was registered, replayed once a
  * handler arrives.
  */
  #exitedRealms = new Map<string, string | undefined>();
  /**
  * In-flight `spawnRemote()` requests keyed by spawnReqId, settled by the
  * matching SPAWN_ACK or rejected en masse by `stop()`.
  *
  * @internal
  */
  #pendingSpawns = new Map<string, {
    resolve: (childPortId: string) => void;
    reject: (err: Error) => void;
  }>();
  /**
  * Monotonic counter used to mint node-unique spawn-request IDs and child
  * port IDs.
  *
  * @internal
  */
  #localHandle = 0;
  /**
  * Interval handle for the 2.5 s HEARTBEAT to the seed; null before `start()`
  * and after `stop()`.
  *
  * @internal
  */
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
  * Create a worker-side cluster client.
  *
  * Construction only stores references and initializes maps. Call `start()` to
  * register transport handlers and heartbeat timers; call `stop()` to release
  * relays and reject pending work.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const transport = { nodeId: 'worker-1', send() {}, broadcast() {}, on() {}, close() {} };
  * const client = new ClusterClient(transport, 'worker-1');
  * ```
  */
  constructor(transport: ClusterTransport, nodeId: string) {
    this.nodeId = nodeId;
    this.#transport = transport;
  }
  /**
  * Snapshot of peers currently known to this client.
  *
  * The returned array is copied from the internal map, so mutating it does not
  * affect membership state. Before a `WELCOME` message arrives the array is
  * empty.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.peers.length;
  * ```
  */
  get peers(): PeerInfo[] {
    return [...this.#peers.values()];
  }
  /**
  * Register a parent-side port for inbound `PORT_MSG` delivery.
  *
  * Later registrations for the same `portId` replace earlier entries. The
  * client does not validate the ID; malformed IDs may fail when the seed or
  * transport attempts to route a message.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-1', client);
  * client.registerPort('n/p-1', port);
  * ```
  */
  registerPort(portId: string, port: ClusterPort): void {
    this.#portHandlers.set(portId, port);
  }
  /**
  * Remove a parent-side port registration.
  *
  * Unknown IDs are ignored. This is called automatically by `ClusterPort` when
  * it closes so subsequent `PORT_MSG` deliveries for the ID are dropped.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.unregisterPort('n/p-1');
  * ```
  */
  unregisterPort(portId: string): void {
    this.#portHandlers.delete(portId);
  }
  /**
  * Register a one-shot callback for when the realm identified by childPortId exits.
  * Used by Realm.run() and Realm.call() to await remote realm completion.
  *
  * A later handler for the same `childPortId` replaces the previous one. The
  * handler receives an optional error string from the remote realm; missing
  * error means normal completion. If the realm already exited before the
  * handler was registered, the buffered exit result is replayed and the
  * handler fires asynchronously on the microtask queue.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.onRealmExit('remote/p-2', (error) => { void error; });
  * ```
  */
  onRealmExit(childPortId: string, handler: (error?: string) => void): void {
    if (this.#exitedRealms.has(childPortId)) {
      const error = this.#exitedRealms.get(childPortId);
      this.#exitedRealms.delete(childPortId);
      Promise.resolve().then(() => handler(error));
      return;
    }
    this.#exitHandlers.set(childPortId, handler);
  }
  /**
  * Send serialized port payload parts to a remote port.
  *
  * The payload parts are base64-encoded as a JSON array so ArrayBuffer transfer
  * stores survive the cluster hop. Routing uses the node prefix extracted from
  * `toPort`; invalid IDs may be sent to an unusable target.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.sendPortMsg('n/p-1', 'remote/p-2', [new Uint8Array([1, 2])]);
  * ```
  *
  * @internal
  */
  sendPortMsg(fromPort: string, toPort: string, parts: Uint8Array[]): void {
    const targetNodeId = nodeIdFromId(toPort);
    const payload = encodePayload(parts);
    this.#transport.send(targetNodeId, {
      t: 'PORT_MSG',
      fromPort,
      toPort,
      payload
    });
  }
  /**
  * Spawn a realm on a remote node by sending SPAWN through the seed.
  * Returns the assigned childPortId on success.
  *
  * The returned promise rejects if the seed reports failure, if `stop()` closes
  * the client while the spawn is pending, or if the target fails to create the
  * child realm. No timeout is applied by this layer.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * await client.spawnRemote('n/p-parent', { entry: 'main.ts', root: '.', rules: [] });
  * ```
  */
  spawnRemote(parentPortId: string, config: SerializedSpawnConfig): Promise<string> {
    const spawnReqId = `${this.nodeId}-${this.#localHandle++}`;
    return new Promise<string>((resolve, reject) => {
      this.#pendingSpawns.set(spawnReqId, {
        resolve,
        reject
      });
      this.#transport.send('__seed__', {
        t: 'SPAWN',
        spawnReqId,
        parentPortId,
        config
      });
    });
  }
  /**
  * Register the transport message handler and start periodic heartbeats.
  *
  * The heartbeat interval is 2500 ms and messages are sent to `__seed__`.
  * Calling `start()` more than once adds another handler and timer; callers
  * should treat it as a single-use lifecycle method.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.start();
  * ```
  */
  start(): void {
    this.#transport.on((from, msg) => this.#handle(from, msg));
    this.#heartbeatTimer = setInterval(() => {
      this.#transport.send('__seed__', {
        t: 'HEARTBEAT',
        ts: Date.now()
      });
    }, HEARTBEAT_MS);
  }
  /**
  * Stop heartbeats, close relays, reject pending spawns, and close transport.
  *
  * Realm-exit waiters are invoked with an error message so `Realm.run()` and
  * `Realm.call()` settle instead of hanging. Calling `stop()` repeatedly is
  * tolerated, but the closed transport cannot be reused.
  *
  * ```ts no_run
  * import { ClusterClient } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * client.stop();
  * ```
  */
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
      try {
        handler(err.message);
      } catch {}
    }
    this.#exitHandlers.clear();
    for (const pending of this.#pendingSpawns.values()) {
      pending.reject(err);
    }
    this.#pendingSpawns.clear();
    this.#transport.close();
  }
  /**
  * Dispatch one inbound cluster message.
  *
  * Membership messages update `#peers` (PEER_DOWN also fails exit waiters
  * for realms on the lost node), SPAWN_ACK settles the matching pending
  * spawn, SPAWN creates a local child realm (failures are reported back as a
  * failed SPAWN_ACK), TERMINATE forwards `__terminate` into a live relay or
  * settles/buffers the exit waiter, REALM_EXIT notifies or buffers the
  * parent-side waiter, and PORT_MSG routes to a registered `ClusterPort`
  * first, then to a child-realm relay. Unknown message types are ignored.
  *
  * @internal
  */
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
        const error = `fino:cluster — peer ${msg.nodeId} disconnected`;
        for (const [realmId, handler] of [...this.#exitHandlers.entries()]) {
          if (nodeIdFromId(realmId) !== msg.nodeId) continue;
          this.#exitHandlers.delete(realmId);
          try {
            handler(error);
          } catch {}
        }
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
            error: String(err)
          });
        });
        break;
      }
      case 'TERMINATE': {
        const relay = this.#relays.get(msg.realmId);
        if (relay && !relay.closed) {
          relay.closed = true;
          this.#sendToThread(relay.threadHandle, { __terminate: true });
          break;
        }
        const handler = this.#exitHandlers.get(msg.realmId);
        if (handler) {
          this.#exitHandlers.delete(msg.realmId);
          handler(`remote realm ${msg.realmId} terminated by cluster`);
        } else {
          this.#exitedRealms.set(msg.realmId, `remote realm ${msg.realmId} terminated by cluster`);
        }
        break;
      }
      case 'REALM_EXIT': {
        // A remote realm we spawned has exited - notify the parent-side waiter.
        const handler = this.#exitHandlers.get(msg.realmId);
        if (handler) {
          this.#exitHandlers.delete(msg.realmId);
          handler(msg.error);
        } else {
          this.#exitedRealms.set(msg.realmId, msg.error);
        }
        break;
      }
      case 'PORT_MSG': {
        const localPort = this.#portHandlers.get(msg.toPort);
        if (localPort) {
          // Deliver to parent-side ClusterPort - pass raw parts so stores are preserved.
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
              const value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(mainBuf, stores.length > 0 ? stores : undefined);
              this.#sendToThread(relay.threadHandle, value);
            }
          } catch (err: unknown) {
            console.error(`fino:cluster PORT_MSG decode error (relay): ${err}`);
          }
        }
        break;
      }
      default: break;
    }
  }
  /**
  * Create a child thread realm for an inbound SPAWN.
  *
  * Mints a childPortId, starts the realm via `createThreadContext`, registers
  * a relay for it, acknowledges with a successful SPAWN_ACK, and kicks off
  * the relay loop. Errors thrown here are converted to a failed SPAWN_ACK by
  * the caller.
  *
  * @internal
  */
  async #handleSpawn(msg: Extract<ClusterMessage, {
    t: 'SPAWN';
  }>): Promise<void> {
    const childPortId = `${this.nodeId}/${this.#localHandle++}`;
    const bootstrapData = msg.config.bootstrapData === undefined ? undefined : JSON.stringify(msg.config.bootstrapData);
    const handle = createThreadContext(msg.config.root ?? '', msg.config.entry, JSON.stringify(msg.config.rules), false, undefined, bootstrapData) as number;
    const wakeReadFd = getThreadPortWakeReadFd(handle) as number;
    const relay: RealmRelay = {
      childPortId,
      parentPortId: msg.parentPortId,
      threadHandle: handle,
      wakeReadFd,
      closed: false,
      pendingSends: []
    };
    this.#relays.set(childPortId, relay);
    // Send SPAWN_ACK so the parent's ClusterPort gets the childPortId
    this.#transport.send('__seed__', {
      t: 'SPAWN_ACK',
      spawnReqId: msg.spawnReqId,
      childPortId,
      ok: true
    });
    // Start relay loop: forward thread port messages to the parent via PORT_MSG
    this.#runRelayLoop(relay);
  }
  /**
  * Drive a child realm's relay until the realm finishes.
  *
  * Two mechanisms run concurrently: a zero-delay interval steps the thread
  * context each tick (so the child's timers and microtasks advance even with
  * no traffic), and an async loop awaits the realm's wake-fd to drain
  * outbound thread-port messages promptly. `finalize` runs exactly once —
  * on realm completion, step error, `__terminate`, or wake-fd failure — and
  * sends REALM_EXIT to the seed after any in-flight PORT_MSG sends settle,
  * carrying the step error or a recorded `__call_error` message if present.
  *
  * @internal
  */
  async #runRelayLoop(relay: RealmRelay): Promise<void> {
    const { wakeReadFd, threadHandle } = relay;
    let stepError: string | undefined;
    const finalize = () => {
      if (relay.closed) return;
      this.#drainInbound(relay, () => {});
      relay.closed = true;
      removeRead(wakeReadFd);
      this.#relays.delete(relay.childPortId);
      const msg: ClusterMessage = stepError !== undefined ? {
        t: 'REALM_EXIT',
        realmId: relay.childPortId,
        error: stepError
      } : relay.lastCallError !== undefined ? {
        t: 'REALM_EXIT',
        realmId: relay.childPortId,
        error: relay.lastCallError
      } : {
        t: 'REALM_EXIT',
        realmId: relay.childPortId
      };
      const pending = relay.pendingSends.splice(0);
      Promise.allSettled(pending).then(() => {
        this.#transport.send('__seed__', msg);
      }).catch(() => {
        this.#transport.send('__seed__', msg);
      });
    };
    // Drive the child realm on every event-loop tick so that timers, microtasks,
    // and outbound port writes advance even when no inbound message arrives.
    // This mirrors how _stepChildren() works for embedded/thread realms.
    const stepInterval = setInterval(() => {
      if (relay.closed) {
        clearInterval(stepInterval);
        return;
      }
      try {
        const alive = stepThreadContext(threadHandle) as boolean !== false;
        if (!relay.closed) this.#drainInbound(relay, finalize);
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
        const n = await readable(wakeReadFd);
        if (relay.closed) break;
        if (typeof n === 'number' && n < 0) break;
        this.#drainInbound(relay, finalize);
      }
    } finally {
      finalize();
      clearInterval(stepInterval);
    }
  }
  /**
  * Drain messages the child realm has written to its thread port and forward
  * them to the parent as PORT_MSG frames.
  *
  * Raw serialized bytes are forwarded unmodified so ArrayBuffer transfer
  * stores survive the hop. Each message is peeked (deserialized without
  * stores) to detect the `__terminate` sentinel, which triggers `finalize`
  * instead of forwarding, and to record `__call_error` messages for the
  * eventual REALM_EXIT. Per-message errors are logged and skipped so one bad
  * frame cannot stall the relay.
  *
  * @internal
  */
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
          if (peeked !== null && typeof peeked === 'object' && (peeked as any).__call_error === true) {
            relay.lastCallError = String((peeked as {
              message?: unknown;
            }).message ?? 'Realm call failed');
          }
        } catch {}
        if (isTerminate) {
          finalize();
          return;
        }
        // Forward raw serialized bytes (preserves stores for ArrayBuffer transfers).
        const payload = encodePayload(parts);
        const sent = this.#transport.send('__seed__', {
          t: 'PORT_MSG',
          fromPort: relay.childPortId,
          toPort: relay.parentPortId,
          payload
        });
        if (sent instanceof Promise) relay.pendingSends.push(sent);
      } catch (err: unknown) {
        console.error(`fino:cluster relay drain error: ${err}`);
      }
    }
  }
  /**
  * Serialize a value and push it into a child thread realm's inbound thread
  * port. Used for control messages like `__terminate` and for delivering
  * inbound PORT_MSG payloads after transferred buffers have been
  * reconstructed; the value is re-serialized as a single part with no
  * separate transfer stores.
  *
  * @internal
  */
  #sendToThread(handle: number, value: unknown): void {
    const bytes = (serialize as (v: unknown) => Uint8Array[])(value)[0]!;
    (threadPortSend as (h: number, b: Uint8Array, s: Uint8Array[], p: unknown[]) => void)(handle, bytes, [], []);
  }
}
// ---------------------------------------------------------------------------
// ClusterPort - parent-side port for communicating with a remote child realm
// ---------------------------------------------------------------------------
/**
* Parent-side port for communicating with a remote clustered child realm.
*
* Outbound messages are serialized and sent as `PORT_MSG` cluster messages;
* inbound payloads are deserialized and dispatched through the shared
* `BaseTransportPort` machinery. Messages posted before the child port ID is
* assigned are queued and flushed once `SPAWN_ACK` delivers the ID.
*
* ```ts no_run
* import { ClusterClient, ClusterPort } from 'internal:cluster/client';
* const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
* const port = new ClusterPort('n/p-parent', client);
* port.postMessage({ ready: true });
* ```
*
* @internal
*/
export class ClusterPort extends BaseTransportPort {
  /**
  * Parent-side port ID used for seed routing and inbound lookup.
  *
  * The value is assigned by the caller and is not parsed by the constructor.
  * It should include a node prefix, for example `node-a/p-1`.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * new ClusterPort('n/p-parent', client).portId;
  * ```
  */
  readonly portId: string;
  /**
  * Owning `ClusterClient`, used for registration and outbound `sendPortMsg()`
  * calls.
  *
  * @internal
  */
  #client: ClusterClient;
  /**
  * Remote child port ID assigned by SPAWN_ACK via `_setChildPortId()`; null
  * until then, during which outbound messages accumulate in the pre-spawn
  * queue.
  *
  * @internal
  */
  #childPortId: string | null = null;
  /**
  * Outbound messages serialized before `_setChildPortId()` ran, flushed in
  * order once the child port ID arrives. Spawn is asynchronous (SPAWN_ACK),
  * so early sends — including a prompt `terminate()` — must not be lost.
  *
  * @internal
  */
  #preSpawnQueue: Uint8Array[][] = [];
  /**
  * Create and register a cluster port with its owning client.
  *
  * The constructor immediately calls `client.registerPort()`. Close the port
  * to unregister it; until `_setChildPortId()` runs, outbound `postMessage()`
  * calls are queued and flushed on assignment.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-parent', client);
  * ```
  */
  constructor(portId: string, client: ClusterClient) {
    super();
    this.portId = portId;
    this.#client = client;
    client.registerPort(portId, this);
  }
  /**
  * Set the remote child port ID after a successful `SPAWN_ACK`.
  *
  * This internal method enables future `postMessage()` calls to route to the
  * child realm. It may be called again to retarget the port, though normal
  * spawn flow calls it exactly once.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-parent', client);
  * port._setChildPortId('remote/p-child');
  * ```
  *
  * @internal
  */
  _setChildPortId(childPortId: string): void {
    this.#childPortId = childPortId;
    for (const parts of this.#preSpawnQueue.splice(0)) {
      this.#client.sendPortMsg(this.portId, childPortId, parts);
    }
  }
  /**
  * Serialize and send a message to the remote child realm.
  *
  * If the port is closed the call is a no-op. If the child port ID has not
  * arrived yet, the serialized message is queued and flushed in order once
  * `_setChildPortId()` runs. Transferable `ArrayBuffer`s are preserved as
  * serialized store parts and forwarded through the cluster payload.
  * MessagePort transfer is not supported by the cluster relay and
  * non-ArrayBuffer transfer entries throw.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-parent', client);
  * port._setChildPortId('remote/p-child');
  * port.postMessage({ ok: true });
  * ```
  */
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void {
    if (this._closed) return;
    if (transfer !== undefined && !transfer.every((item) => item instanceof ArrayBuffer)) {
      throw new TypeError('ClusterPort transfer list only supports ArrayBuffer values');
    }
    const parts = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(message, transfer && transfer.length > 0 ? transfer : undefined);
    if (this.#childPortId === null) {
      this.#preSpawnQueue.push(parts);
      return;
    }
    this.#client.sendPortMsg(this.portId, this.#childPortId, parts);
  }
  /**
  * Unregister this port from the owning client during close.
  *
  * The base transport port calls this hook once close processing reaches the
  * subclass. Unknown or already-unregistered IDs are ignored by the client.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-parent', client);
  * port.close();
  * ```
  *
  * @internal
  */
  protected override _onClose(): void {
    this.#client.unregisterPort(this.portId);
  }
  /**
  * Deliver raw serialized payload parts from an incoming `PORT_MSG`.
  *
  * Empty payload arrays are ignored. When store parts are present they are
  * passed to `_dispatchMessage()` so transferred buffers are reconstructed.
  *
  * ```ts no_run
  * import { ClusterClient, ClusterPort } from 'internal:cluster/client';
  * const client = new ClusterClient({ nodeId: 'n', send() {}, broadcast() {}, on() {}, close() {} }, 'n');
  * const port = new ClusterPort('n/p-parent', client);
  * port._deliver([new Uint8Array()]);
  * ```
  *
  * @internal
  */
  _deliver(parts: Uint8Array[]): void {
    const [mainBuf, ...stores] = parts;
    if (!mainBuf) return;
    this._dispatchMessage(mainBuf, stores.length > 0 ? stores : undefined);
  }
}
