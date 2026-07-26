/**
 * MessageEvent, MessagePort, and MessageChannel globals.
 *
 * HTML channel messaging model:
 * https://html.spec.whatwg.org/multipage/web-messaging.html#channel-messaging
 *
 * Message payloads use the structured-clone subset documented on
 * `structuredClone()` in `js/globals/encoding.ts`. That subset is intentionally
 * narrower than the complete HTML structured clone algorithm: functions,
 * symbols, weak collections, custom prototypes, streams, and direct
 * `MessagePort` values without transfer reject with `DataCloneError`.
 *
 * IntraPort transport: same-Isolate Realms exchange messages via direct JS
 * object references + structuredClone. postMessage clones the value and pushes
 * it to the partner port's queue. _flushPorts() dispatches all queued messages
 * on started ports; called from driveLoop between tick() and drainMicrotasks().
 *
 * MessagePort transfer: a MessagePort can be transferred via postMessage. For
 * same-Isolate transfers a fresh receiver-side port replaces matching
 * MessagePort references in the cloned message data and is also exposed through
 * MessageEvent.ports. For cross-Isolate transfers a transit channel is created
 * (internal:transit-port) and the partner port is upgraded in-place to use
 * cross-thread messaging.
 *
 * Realm transport matrix:
 *
 * | Transport | Clone path | Transfer support |
 * | --- | --- | --- |
 * | Same-isolate `MessagePort` | Runtime structured-clone subset. | `ArrayBuffer` and `MessagePort`. |
 * | Thread `ThreadPort` | Serializer transport. | `ArrayBuffer` and `MessagePort`. |
 * | Process `ProcessPort` | Serializer transport over process realm handles. | `ArrayBuffer`; `MessagePort` rejects. |
 * | Remote/cluster calls | Cluster transport serialization. | No live `MessagePort` transfer contract. |
 *
 * ## Example
 *
 * ```typescript no_run
 *
 * const channel = new MessageChannel();
 * channel.port2.onmessage = (event) => {
 *   console.log(event.data);
 * };
 *
 * channel.port2.start();
 * channel.port1.postMessage({ type: 'ready' });
 * ```
 *
 */
import { Event, EventTarget, _markEventTrusted } from './eventtarget.ts';
import { DOMException, _structuredCloneWithTransferMap } from './encoding.ts';
import { serialize, deserialize } from 'internal:serializer';
import { getWakeReadFd } from 'internal:thread-port';
import { transitSend, transitRecv } from 'internal:transit-port';
import { readable, removeRead } from 'internal:runtime/loop';
// ---------------------------------------------------------------------------
// MessageEvent
// ---------------------------------------------------------------------------
/**
 * Initialization object for MessageEvent.
 *
 * ```typescript no_run
 * const init: MessageEventInit = { data: 'hello', origin: 'fino' };
 * new MessageEvent('message', init);
 * ```
 */
export interface MessageEventInit {
  /**
   * Message payload exposed by event.data.
   *
   * ```typescript no_run
   * const init: MessageEventInit = { data: { ok: true } };
   * ```
   */
  data?: any;
  /**
   * Origin string for browser-compatible APIs.
   *
   * Fino messaging usually leaves this as the empty string.
   *
   * ```typescript no_run
   * const init: MessageEventInit = { origin: 'https://example.com' };
   * ```
   */
  origin?: string;
  /**
   * Last event id for EventSource-compatible payloads.
   *
   * ```typescript no_run
   * const init: MessageEventInit = { lastEventId: '42' };
   * ```
   */
  lastEventId?: string;
  /**
   * Source MessagePort, or null when there is no source.
   *
   * ```typescript no_run
   * const init: MessageEventInit = { source: null };
   * ```
   */
  source?: MessagePort | null;
  /**
   * Transferred MessagePort objects attached to this message.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * const init: MessageEventInit = { ports: [channel.port1] };
   * ```
   */
  ports?: MessagePort[];
}
/**
 * Event subclass used for message and messageerror delivery.
 *
 * Data defaults to null, string fields default to empty string, source defaults
 * to null, and ports is a frozen copy of the supplied array.
 *
 * ```typescript no_run
 * const event = new MessageEvent('message', { data: 'hello' });
 * event.data; // "hello"
 * ```
 */
export class MessageEvent extends Event {
  /**
   * Message payload backing the `data` getter; defaults to null.
   *
   * @internal
   */
  #data: any;
  /**
   * Origin string backing the `origin` getter; defaults to the empty string.
   *
   * @internal
   */
  #origin: string;
  /**
   * Id backing the `lastEventId` getter; defaults to the empty string.
   *
   * @internal
   */
  #lastEventId: string;
  /**
   * Source port backing the `source` getter; defaults to null.
   *
   * @internal
   */
  #source: MessagePort | null;
  /**
   * Frozen copy of the transferred ports supplied at construction, backing the
   * `ports` getter.
   *
   * @internal
   */
  #ports: readonly MessagePort[];
  /**
   * Create a MessageEvent.
   *
   * The event type is usually "message" or "messageerror".
   *
   * ```typescript no_run
   * new MessageEvent('message', { data: 1 }).type; // "message"
   * ```
   */
  constructor(type: string, init?: MessageEventInit) {
    super(type);
    this.#data = init?.data ?? null;
    this.#origin = init?.origin ?? '';
    this.#lastEventId = init?.lastEventId ?? '';
    this.#source = init?.source ?? null;
    this.#ports = Object.freeze(init?.ports?.slice() ?? []);
  }
  /**
   * Message payload.
   *
   * ```typescript no_run
   * new MessageEvent('message', { data: 1 }).data; // 1
   * ```
   */
  get data() {
    return this.#data;
  }
  /**
   * Origin string for compatibility with browser MessageEvent.
   *
   * ```typescript no_run
   * new MessageEvent('message').origin; // ""
   * ```
   */
  get origin() {
    return this.#origin;
  }
  /**
   * Last event id string.
   *
   * ```typescript no_run
   * new MessageEvent('message').lastEventId; // ""
   * ```
   */
  get lastEventId() {
    return this.#lastEventId;
  }
  /**
   * Source MessagePort or null.
   *
   * ```typescript no_run
   * new MessageEvent('message').source; // null
   * ```
   */
  get source() {
    return this.#source;
  }
  /**
   * Frozen transferred ports array.
   *
   * ```typescript no_run
   * const ports = new MessageEvent('message').ports;
   * ports.length; // 0
   * ```
   */
  get ports() {
    return this.#ports;
  }
}
// ---------------------------------------------------------------------------
// MessagePort
// ---------------------------------------------------------------------------
// Module-level set of ports that have been start()ed and are awaiting drain.
const _activePorts = new Set<MessagePort>();
// Counter used to assign unique IDs to ports (for same-Isolate transfer).
let _nextPortId = 0;
interface QueueItem {
  data: any;
  /** Receiver-side ports created during same-Isolate transfer. */
  transferredPorts?: MessagePort[];
}
function messagePortDataCloneError(message: string): DOMException {
  return new DOMException(message, 'DataCloneError');
}
/**
 * MessagePort for same-isolate and transit cross-isolate messaging.
 *
 * Same-isolate messages are structured-cloned into the partner's queue and
 * dispatched as `message` events on the next loop step. Transit mode — entered
 * when the port's partner has been transferred to another Isolate — serializes
 * messages through the runtime serializer and delivers them via wake pipes.
 *
 * A port holds incoming messages until it starts: call `start()` explicitly
 * when using `addEventListener`, or assign `onmessage`, which starts the port
 * implicitly. `close()` (or `using` disposal) permanently stops delivery, and
 * transferring a port via another port's `postMessage` neuters the local
 * endpoint.
 *
 * ```typescript no_run
 * const { port1, port2 } = new MessageChannel();
 * port2.onmessage = (event) => console.log(event.data);
 * port1.postMessage('hello');
 * ```
 */
export class MessagePort extends EventTarget {
  /**
   * Same-isolate entangled partner port. Null while unentangled, after
   * close()/neutering, and in transit mode.
   *
   * @internal
   */
  #partner: MessagePort | null = null;
  /**
   * Messages pushed by the partner's postMessage, held until _drain()
   * dispatches them on this (started) port.
   *
   * @internal
   */
  #queue: QueueItem[] = [];
  /**
   * True once start() has run; queued messages are only dispatched on started
   * ports.
   *
   * @internal
   */
  #started = false;
  /**
   * True after close(); closed ports ignore postMessage, cannot be transferred,
   * and dispatch nothing.
   *
   * @internal
   */
  #closed = false;
  /**
   * True after this endpoint has been transferred away. A neutered port is
   * permanently dead: sends are ignored and it can never be transferred again.
   *
   * @internal
   */
  #neutered = false;
  /**
   * Current onmessage handler, kept so reassignment can remove the previously
   * registered listener.
   *
   * @internal
   */
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  /**
   * Current onmessageerror handler, kept so reassignment can remove the
   * previously registered listener.
   *
   * @internal
   */
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;
  // Transit mode: set when this port is created from a cross-thread transit
  // half, or when its partner was transferred cross-Isolate (upgrade).
  /**
   * Transit half handle when this port operates in cross-Isolate transit mode;
   * null in same-isolate mode.
   *
   * @internal
   */
  #transitHandle: number | null = null;
  /**
   * Wake-pipe read fd watched by the transit loop; -1 when not in transit
   * mode.
   *
   * @internal
   */
  #transitWakeReadFd: number = -1;
  /**
   * Entangle this port with a same-isolate partner.
   *
   * Called by MessageChannel construction and by transfer reconstruction.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port1._entangle(channel.port2);
   * ```
   *
   * @internal
   */
  _entangle(partner: MessagePort): void {
    this.#partner = partner;
  }
  /**
   * Remove the same-isolate partner link.
   *
   * Used when a partner is transferred and the old endpoint becomes neutered.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port1._disentangle();
   * ```
   *
   * @internal
   */
  _disentangle(): void {
    this.#partner = null;
  }
  /**
   * Upgrade this port from intra-Isolate to cross-thread mode after its
   * partner has been transferred to another Isolate.
   *
   * `handle` is the transit half handle for this (P2) side, and `wakeReadFd`
   * is the fd that becomes readable when the transferred (Q) side sends. The
   * same-isolate partner link is dropped, and if the port had already started,
   * the transit watch loop begins immediately.
   *
   * @internal
   */
  _upgradeToTransit(handle: number, wakeReadFd: number): void {
    this.#partner = null;
    this.#transitHandle = handle;
    this.#transitWakeReadFd = wakeReadFd;
    if (this.#started) {
      this.#startTransitWatch();
    }
  }
  /**
   * Neuter this port and upgrade its partner (P2) to cross-thread transit
   * mode in preparation for cross-Isolate transfer.
   *
   * Called by ThreadPort.postMessage when this port is in the transfer list.
   * `p2Handle` is the transit half handle for the partner (P2) side, and
   * `p2WakeReadFd` is the fd the partner will watch for incoming messages.
   * Already-neutered or closed ports are left untouched.
   *
   * @internal
   */
  _transferCrossThread(p2Handle: number, p2WakeReadFd: number): void {
    if (this.#neutered || this.#closed) return;
    const partner = this.#partner;
    this.#neutered = true;
    _activePorts.delete(this);
    this.#partner = null;
    partner?._upgradeToTransit(p2Handle, p2WakeReadFd);
  }
  /**
   * Create a new MessagePort in transit mode (the receiving Q side after a
   * cross-Isolate port transfer).
   *
   * The returned port is not started; delivery begins once start() runs or an
   * onmessage handler is assigned.
   *
   * @internal
   */
  static _fromTransit(handle: number, wakeReadFd: number): MessagePort {
    const p = new MessagePort();
    p.#transitHandle = handle;
    p.#transitWakeReadFd = wakeReadFd;
    return p;
  }
  /**
   * Overload signature accepting a transfer array as the second argument,
   * matching the classic HTML MessagePort form.
   *
   * @internal
   */
  postMessage(message: any, transfer?: Transferable[]): void;
  /**
   * Overload signature accepting a `{ transfer }` options bag, matching the
   * structuredClone-style form.
   *
   * @internal
   */
  postMessage(message: any, options?: StructuredSerializeOptions): void;
  /**
   * Send a structured-clone copy of `message` to the entangled partner.
   *
   * The second argument may be a transfer array or a `{ transfer }` options
   * bag. Transfer lists may contain ArrayBuffers (detached at the sender) and
   * MessagePorts: a transferred MessagePort is neutered at the sending side,
   * reconstructed as a fresh port for the receiver, replaces matching
   * references inside the cloned data, and also appears on
   * `MessageEvent.ports`. Delivery is queued on the partner and dispatched on
   * the next loop step once the partner has started.
   *
   * Closed or neutered ports silently ignore sends. The transfer list is
   * validated before anything is cloned or neutered, so a failed call leaves
   * every port untouched. Throws a `DataCloneError` DOMException for duplicate
   * transfer entries, closed or neutered ports in the transfer list, an
   * attempt to transfer this port through itself, transfer values other than
   * ArrayBuffer/MessagePort, or a payload outside the runtime's
   * structured-clone subset.
   *
   * ```ts no_run
   * const { port1, port2 } = new MessageChannel();
   * port2.onmessage = (event) => event.ports[0]?.postMessage('got it');
   *
   * const inner = new MessageChannel();
   * inner.port2.onmessage = (event) => console.log(event.data);
   * port1.postMessage({ reply: inner.port1 }, [inner.port1]);
   * ```
   */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this.#closed || this.#neutered) return;
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    // --- Transit mode: serialize and send cross-thread ---
    if (this.#transitHandle !== null) {
      const transferABs = rawTransfer
        ? (rawTransfer.filter((t) => t instanceof ArrayBuffer) as ArrayBuffer[])
        : [];
      const serResult = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
        message,
        transferABs.length > 0 ? transferABs : undefined,
      );
      const data = serResult[0];
      const stores = serResult.length > 1 ? serResult.slice(1) : ([] as Uint8Array[]);
      (transitSend as (h: number, b: Uint8Array, s: Uint8Array[]) => void)(
        this.#transitHandle,
        data,
        stores,
      );
      return;
    }
    // --- Intra-Isolate mode ---
    if (!this.#partner) return;
    // Validate the whole transfer list before cloning or neutering so failure
    // leaves ports and queued messages unchanged.
    const transferPorts: MessagePort[] = [];
    const abTransfer: ArrayBuffer[] = [];
    const seenTransfer = new Set<Transferable>();
    if (rawTransfer) {
      for (const item of rawTransfer) {
        if (seenTransfer.has(item)) {
          throw messagePortDataCloneError('Duplicate value in MessagePort transfer list');
        }
        seenTransfer.add(item);
        if (item instanceof MessagePort) {
          if (item.#closed)
            throw messagePortDataCloneError('Closed MessagePort cannot be transferred');
          if (item.#neutered)
            throw messagePortDataCloneError('Neutered MessagePort cannot be transferred');
          if (item === this) throw messagePortDataCloneError('MessagePort cannot transfer itself');
          transferPorts.push(item);
        } else if (item instanceof ArrayBuffer) {
          abTransfer.push(item);
        } else {
          throw messagePortDataCloneError(
            'MessagePort transfer list only supports ArrayBuffer and MessagePort values',
          );
        }
      }
    }
    const transferredPorts: MessagePort[] = [];
    const portTransferMap = transferPorts.length > 0 ? new WeakMap<object, unknown>() : undefined;
    for (const port of transferPorts) {
      const fresh = new MessagePort();
      transferredPorts.push(fresh);
      portTransferMap!.set(port, fresh);
    }
    const cloned = _structuredCloneWithTransferMap(
      message,
      abTransfer.length > 0 || portTransferMap
        ? {
            transfer: abTransfer,
            transferMap: portTransferMap,
          }
        : undefined,
    );
    const portPartners: (MessagePort | null)[] = [];
    for (const port of transferPorts) {
      const partner = port.#partner;
      portPartners.push(partner);
      port.#neutered = true;
      _activePorts.delete(port);
      port.#partner?._disentangle();
      port.#partner = null;
    }
    for (let i = 0; i < transferredPorts.length; i++) {
      const partner = portPartners[i];
      if (partner !== null) {
        transferredPorts[i]._entangle(partner);
        partner._entangle(transferredPorts[i]);
      }
    }
    const item: QueueItem = { data: cloned };
    if (transferredPorts.length > 0) item.transferredPorts = transferredPorts;
    this.#partner.#queue.push(item);
  }
  /**
   * Begin dispatching queued messages.
   *
   * Setting onmessage also starts the port. Repeated calls are no-ops.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port1.start();
   * ```
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#transitHandle !== null) {
      this.#startTransitWatch();
    } else {
      _activePorts.add(this);
    }
  }
  /**
   * Close this port and release runtime read watchers.
   *
   * After close(), postMessage is ignored and pending same-isolate messages are
   * not dispatched.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port1.close();
   * ```
   */
  close(): void {
    this.#closed = true;
    this.#started = false;
    _activePorts.delete(this);
    this.#partner = null;
    if (this.#transitWakeReadFd >= 0) {
      removeRead(this.#transitWakeReadFd);
    }
    this.#transitHandle = null;
    this.#transitWakeReadFd = -1;
  }
  /**
   * Close the port when it leaves a `using` declaration's scope.
   *
   * ```ts no_run
   * {
   *   using port = new MessageChannel().port1;
   *   port.postMessage('scoped');
   * } // port.close() runs automatically here
   * ```
   */
  [Symbol.dispose](): void {
    this.close();
  }
  /**
   * Message event handler property.
   *
   * Assigning a function registers it as a message listener and starts the
   * port. Assigning null clears the previous handler.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.onmessage = (event) => console.log(event.data);
   * ```
   */
  get onmessage() {
    return this.#onmessage;
  }
  /**
   * Set or clear the message handler property.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.onmessage = null;
   * ```
   */
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    // Remove old listener if any
    if (this.#onmessage !== null) {
      this.removeEventListener('message', this.#onmessage as EventListener);
    }
    this.#onmessage = typeof fn === 'function' ? fn : null;
    // Add new listener and start (implicit start per spec)
    if (this.#onmessage !== null) {
      this.addEventListener('message', this.#onmessage as EventListener);
      this.start();
    }
  }
  /**
   * Message error handler property.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.onmessageerror = (event) => console.log(event.data);
   * ```
   */
  get onmessageerror() {
    return this.#onmessageerror;
  }
  /**
   * Set or clear the messageerror handler property.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.onmessageerror = null;
   * ```
   */
  set onmessageerror(fn: ((ev: MessageEvent) => void) | null) {
    if (this.#onmessageerror !== null) {
      this.removeEventListener('messageerror', this.#onmessageerror as EventListener);
    }
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) {
      this.addEventListener('messageerror', this.#onmessageerror as EventListener);
    }
  }
  /**
   * Dispatch queued same-isolate messages for this port.
   *
   * Called by _flushPorts during the runtime task step. Transit ports use their
   * own wake-loop path instead.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.start();
   * channel.port2._drain();
   * ```
   *
   * @internal
   */
  _drain(): void {
    if (!this.#started) return;
    if (this.#transitHandle !== null) return;
    const pending = this.#queue.splice(0);
    for (const item of pending) {
      const event = new MessageEvent('message', {
        data: item.data,
        ports: item.transferredPorts,
      });
      _markEventTrusted(event);
      this.dispatchEvent(event);
    }
  }
  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
  /**
   * Start the transit watch loop: await readable() on the wake fd, drain
   * serialized messages with transitRecv, deserialize each, and dispatch a
   * message event (or messageerror when deserialization throws). Transferred
   * ports arrive as [handle, wakeReadFd] pairs and are reconstructed with
   * _fromTransit. The loop exits when the port closes.
   *
   * @internal
   */
  #startTransitWatch(): void {
    const fd = this.#transitWakeReadFd;
    const handle = this.#transitHandle!;
    const self = this;
    (async () => {
      while (!self.#closed && self.#transitHandle !== null) {
        await readable(fd);
        if (self.#closed || self.#transitHandle === null) break;
        const msgs = (transitRecv as (h: number) => [[Uint8Array[], [number, number][]]])(
          handle,
        ) as unknown as [[Uint8Array[], [number, number][]]];
        for (const [byteArr, portArr] of msgs as any[]) {
          try {
            const [buf, ...stores] = byteArr as Uint8Array[];
            const value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
              buf,
              stores.length > 0 ? stores : undefined,
            );
            const ports = (portArr as [number, number][]).map(([h, wfd]) =>
              MessagePort._fromTransit(h, wfd),
            );
            const event = new MessageEvent('message', {
              data: value,
              ports,
            });
            _markEventTrusted(event);
            self.dispatchEvent(event);
          } catch (err) {
            const event = new MessageEvent('messageerror', { data: err });
            _markEventTrusted(event);
            self.dispatchEvent(event);
          }
        }
      }
    })();
  }
}
// ---------------------------------------------------------------------------
// MessageChannel
// ---------------------------------------------------------------------------
/**
 * Pair of entangled MessagePort endpoints.
 *
 * Anything posted on `port1` arrives on `port2` and vice versa. A common
 * pattern is to keep one port locally and hand the other to another component
 * (or transfer it to another Realm) as a private two-way channel.
 *
 * ```typescript no_run
 * const { port1, port2 } = new MessageChannel();
 * port2.onmessage = (event) => console.log('received', event.data);
 * port1.postMessage({ hello: 'world' });
 * ```
 */
export class MessageChannel {
  /**
   * First endpoint of the channel.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port1.start();
   * ```
   */
  readonly port1: MessagePort;
  /**
   * Second endpoint of the channel.
   *
   * ```typescript no_run
   * const channel = new MessageChannel();
   * channel.port2.start();
   * ```
   */
  readonly port2: MessagePort;
  /**
   * Create two entangled MessagePort instances.
   *
   * ```typescript no_run
   * const { port1, port2 } = new MessageChannel();
   * ```
   */
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._entangle(this.port2);
    this.port2._entangle(this.port1);
  }
}
// ---------------------------------------------------------------------------
// _flushPorts — called from driveLoop step
// ---------------------------------------------------------------------------
/**
 * Dispatch all queued messages on every started MessagePort in this context.
 * Called from driveLoop between tick() and drainMicrotasks() so that port
 * messages are treated as tasks that run before the microtask checkpoint.
 *
 * ```typescript no_run
 * _flushPorts();
 * ```
 *
 * @internal
 */
export function _flushPorts(): void {
  for (const port of _activePorts) {
    port._drain();
  }
}
