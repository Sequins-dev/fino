/**
* MessageEvent, MessagePort, MessageChannel, and ThreadPort globals.
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
* ThreadPort transport: cross-Isolate (cross-thread) Realms exchange messages
* via V8 ValueSerializer (internal:serializer) + Rust mpsc channels
* (internal:thread-port). The wake-pipe read fd is registered with
* loop.readable() so the event loop wakes when the partner sends a message.
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
import { nativeSend, nativeRecv, getWakeReadFd } from 'internal:thread-port';
import { threadPortSend, threadPortRecv } from 'internal:realm-native';
import { createTransitChannel, transitSend, transitRecv } from 'internal:transit-port';
import { readable, removeRead } from 'internal:runtime/loop';
import { resolveRpc, rejectRpc, pushChunk, endStream, errStream } from 'internal:parent-rpc';
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
  * Private property `#data` used by `MessageEvent`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #data = undefined;
  *
  *   readInternalState() {
  *     return this.#data;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #data: any;
  /**
  * Private property `#origin` used by `MessageEvent`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #origin = undefined;
  *
  *   readInternalState() {
  *     return this.#origin;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #origin: string;
  /**
  * Private property `#lastEventId` used by `MessageEvent`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #lastEventId = undefined;
  *
  *   readInternalState() {
  *     return this.#lastEventId;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #lastEventId: string;
  /**
  * Private property `#source` used by `MessageEvent`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #source = undefined;
  *
  *   readInternalState() {
  *     return this.#source;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #source: MessagePort | null;
  /**
  * Private property `#ports` used by `MessageEvent`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #ports = undefined;
  *
  *   readInternalState() {
  *     return this.#ports;
  *   }
  * }
  * ```
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
* Same-isolate messages are structured-cloned into the partner queue. Transit
* mode serializes messages through the runtime serializer and wake pipes.
*
* ```typescript no_run
* const { port1, port2 } = new MessageChannel();
* port2.onmessage = (event) => console.log(event.data);
* port1.postMessage('hello');
* ```
*/
export class MessagePort extends EventTarget {
  /**
  * Private property `#partner` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #partner = undefined;
  *
  *   readInternalState() {
  *     return this.#partner;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #partner: MessagePort | null = null;
  /**
  * Private property `#queue` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #queue = undefined;
  *
  *   readInternalState() {
  *     return this.#queue;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #queue: QueueItem[] = [];
  /**
  * Private property `#started` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #started = undefined;
  *
  *   readInternalState() {
  *     return this.#started;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #started = false;
  /**
  * Private property `#closed` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #closed = undefined;
  *
  *   readInternalState() {
  *     return this.#closed;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #closed = false;
  /**
  * Private property `#neutered` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #neutered = undefined;
  *
  *   readInternalState() {
  *     return this.#neutered;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #neutered = false;
  /**
  * Private property `#onmessage` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #onmessage = undefined;
  *
  *   readInternalState() {
  *     return this.#onmessage;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  /**
  * Private property `#onmessageerror` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #onmessageerror = undefined;
  *
  *   readInternalState() {
  *     return this.#onmessageerror;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;
  // Transit mode: set when this port is created from a cross-thread transit
  // half, or when its partner was transferred cross-Isolate (upgrade).
  /**
  * Private property `#transitHandle` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #transitHandle = undefined;
  *
  *   readInternalState() {
  *     return this.#transitHandle;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #transitHandle: number | null = null;
  /**
  * Private property `#transitWakeReadFd` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #transitWakeReadFd = undefined;
  *
  *   readInternalState() {
  *     return this.#transitWakeReadFd;
  *   }
  * }
  * ```
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
  * @internal
  * @param handle — transit half handle for this (P2) side
  * @param wakeReadFd — fd to watch for incoming messages from Q
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _upgradeToTransit() {
  *     return '_upgradeToTransit';
  *   },
  * };
  * includePrivateExample._upgradeToTransit();
  * ```
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
  *
  * @internal
  * @param p2Handle — transit half handle for the partner (P2) side
  * @param p2WakeReadFd — fd the partner will watch for incoming messages
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _transferCrossThread() {
  *     return '_transferCrossThread';
  *   },
  * };
  * includePrivateExample._transferCrossThread();
  * ```
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
  * Create a new MessagePort in transit mode (Q side after cross-Isolate
  * port transfer).
  *
  * @internal
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _fromTransit() {
  *     return '_fromTransit';
  *   },
  * };
  * includePrivateExample._fromTransit();
  * ```
  */
  static _fromTransit(handle: number, wakeReadFd: number): MessagePort {
    const p = new MessagePort();
    p.#transitHandle = handle;
    p.#transitWakeReadFd = wakeReadFd;
    return p;
  }
  /**
  * Generated-doc-visible method `postMessage`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   postMessage() {
  *     return 'postMessage';
  *   },
  * };
  * includePrivateExample.postMessage();
  * ```
  *
  * @internal
  */
  postMessage(message: any, transfer?: Transferable[]): void;
  /**
  * Generated-doc-visible method `postMessage`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   postMessage() {
  *     return 'postMessage';
  *   },
  * };
  * includePrivateExample.postMessage();
  * ```
  *
  * @internal
  */
  postMessage(message: any, options?: StructuredSerializeOptions): void;
  /**
  * Send a message to the entangled partner.
  *
  * Closed or neutered ports silently ignore sends. Transfer lists may contain
  * ArrayBuffers and MessagePorts. MessagePorts are neutered at the sending
  * side and reconstructed for the receiver.
  *
  * ```typescript no_run
  * const { port1, port2 } = new MessageChannel();
  * port2.start();
  * port1.postMessage({ ok: true });
  * ```
  */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this.#closed || this.#neutered) return;
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts) ? transferOrOpts as Transferable[] : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    // --- Transit mode: serialize and send cross-thread ---
    if (this.#transitHandle !== null) {
      const transferABs = rawTransfer ? rawTransfer.filter((t) => t instanceof ArrayBuffer) as ArrayBuffer[] : [];
      const serResult = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(message, transferABs.length > 0 ? transferABs : undefined);
      const data = serResult[0];
      const stores = serResult.length > 1 ? serResult.slice(1) : [] as Uint8Array[];
      (transitSend as (h: number, b: Uint8Array, s: Uint8Array[]) => void)(this.#transitHandle, data, stores);
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
          if (item.#closed) throw messagePortDataCloneError('Closed MessagePort cannot be transferred');
          if (item.#neutered) throw messagePortDataCloneError('Neutered MessagePort cannot be transferred');
          if (item === this) throw messagePortDataCloneError('MessagePort cannot transfer itself');
          transferPorts.push(item);
        } else if (item instanceof ArrayBuffer) {
          abTransfer.push(item);
        } else {
          throw messagePortDataCloneError('MessagePort transfer list only supports ArrayBuffer and MessagePort values');
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
    const cloned = _structuredCloneWithTransferMap(message, abTransfer.length > 0 || portTransferMap ? {
      transfer: abTransfer,
      transferMap: portTransferMap
    } : undefined);
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
        ports: item.transferredPorts
      });
      _markEventTrusted(event);
      this.dispatchEvent(event);
    }
  }
  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------
  /** Start the transit watch loop and drain incoming messages from it. */
  /**
  * Private method `#startTransitWatch` used by `MessagePort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #startTransitWatch() {
  *     return 'startTransitWatch';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#startTransitWatch();
  *   }
  * }
  * ```
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
        const msgs = ((transitRecv as (h: number) => [[Uint8Array[], [number, number][]]])(handle) as unknown) as [[Uint8Array[], [number, number][]]];
        for (const [byteArr, portArr] of msgs as any[]) {
          try {
            const [buf, ...stores] = byteArr as Uint8Array[];
            const value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(buf, stores.length > 0 ? stores : undefined);
            const ports = (portArr as [number, number][]).map(([h, wfd]) => MessagePort._fromTransit(h, wfd));
            const event = new MessageEvent('message', {
              data: value,
              ports
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
* ```typescript no_run
* const channel = new MessageChannel();
* channel.port1.postMessage('hello');
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
// BaseTransportPort — shared base for ThreadPort, ProcessPort, ClusterPort
// ---------------------------------------------------------------------------
/**
* Shared lifecycle and dispatch logic for transport-backed ports.
*
* Manages: started/closed state, the `onmessage` setter, `start()`/`close()`
* delegation, and the `__rpc_res` interception + `MessageEvent` dispatch that
* all three port types duplicate.
*
* Subclasses implement `postMessage()`, override `_onStart()`/`_onClose()`,
* and call `_dispatchMessage(buf, stores?, ports?)` from their drain logic.
*
* ```typescript no_run
* class Port extends BaseTransportPort {
*   postMessage() {}
* }
* ```
*/
export abstract class BaseTransportPort extends EventTarget {
  /**
  * Internal property `_started` used by `BaseTransportPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateShape = { _started: undefined };
  * console.log(includePrivateShape._started);
  * ```
  *
  * @internal
  */
  protected _started = false;
  /**
  * Internal property `_closed` used by `BaseTransportPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateShape = { _closed: undefined };
  * console.log(includePrivateShape._closed);
  * ```
  *
  * @internal
  */
  protected _closed = false;
  /**
  * Private property `#onmessage` used by `BaseTransportPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #onmessage = undefined;
  *
  *   readInternalState() {
  *     return this.#onmessage;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #onmessage: ((ev: Event) => void) | null = null;
  /**
  * Start delivery for this transport-backed port.
  *
  * Repeated calls and calls after close() are ignored. Subclasses are notified
  * through _onStart().
  *
  * ```typescript no_run
  * port.start();
  * ```
  */
  start(): void {
    if (this._started || this._closed) return;
    this._started = true;
    this._onStart();
  }
  /**
  * Close this port and stop delivery.
  *
  * The operation marks the port closed and calls _onClose() for subclass
  * cleanup such as removing wake-fd watchers.
  *
  * ```typescript no_run
  * port.close();
  * ```
  */
  close(): void {
    this._closed = true;
    this._started = false;
    this._onClose();
  }
  [Symbol.dispose](): void {
    this.close();
  }
  /**
  * Subclass hook invoked when start() transitions the port to started.
  *
  * ```typescript no_run
  * class Port extends BaseTransportPort {
  *   postMessage() {}
  *   protected _onStart() { console.log('started'); }
  * }
  * ```
  */
  protected _onStart(): void {}
  /**
  * Subclass hook invoked when close() runs.
  *
  * ```typescript no_run
  * class Port extends BaseTransportPort {
  *   postMessage() {}
  *   protected _onClose() { console.log('closed'); }
  * }
  * ```
  */
  protected _onClose(): void {}
  /**
  * Deserialize `buf`+`stores`, intercept `__rpc_res`, and dispatch a
  * MessageEvent. Subclasses call this from their per-message drain loop.
  *
  * Deserialize failures dispatch messageerror. Internal RPC protocol messages
  * are consumed and are not surfaced as MessageEvent objects.
  *
  * ```typescript no_run
  * this._dispatchMessage(serializedBytes);
  * ```
  */
  protected _dispatchMessage(buf: Uint8Array, stores?: Uint8Array[], ports: MessagePort[] = []): void {
    if (!this._started) return;
    let value: unknown;
    try {
      value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(buf, stores && stores.length > 0 ? stores : undefined);
    } catch (err) {
      const event = new MessageEvent('messageerror', { data: err });
      _markEventTrusted(event);
      this.dispatchEvent(event);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['__rpc_res'] === true) {
        const rpc = obj as {
          reqId: number;
          result?: unknown;
          error?: string;
        };
        if (rpc.error !== undefined) {
          // Try scalar pending first; if not found, try stream (handler threw before yielding).
          if (!rejectRpc(rpc.reqId, rpc.error)) errStream(rpc.reqId, rpc.error);
        } else {
          resolveRpc(rpc.reqId, rpc.result);
        }
        return;
      }
      if (obj['__rpc_chunk'] === true) {
        const m = obj as {
          reqId: number;
          chunk: unknown;
        };
        pushChunk(m.reqId, m.chunk);
        return;
      }
      if (obj['__rpc_end'] === true) {
        endStream((obj as {
          reqId: number;
        }).reqId);
        return;
      }
      if (obj['__rpc_err'] === true) {
        const m = obj as {
          reqId: number;
          error: string;
        };
        errStream(m.reqId, m.error);
        return;
      }
    }
    const event = new MessageEvent('message', {
      data: value,
      ports
    });
    _markEventTrusted(event);
    this.dispatchEvent(event);
  }
  /**
  * Message handler property for transport-backed ports.
  *
  * Assigning a function registers it and starts the port.
  *
  * ```typescript no_run
  * port.onmessage = (event) => console.log(event.type);
  * ```
  */
  get onmessage() {
    return this.#onmessage;
  }
  /**
  * Set or clear the message handler property.
  *
  * ```typescript no_run
  * port.onmessage = null;
  * ```
  */
  set onmessage(fn: ((ev: Event) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) {
      this.addEventListener('message', this.#onmessage);
      this.start();
    }
  }
}
// ---------------------------------------------------------------------------
// Native bridge helpers — typed wrappers for untyped Rust receive functions
// ---------------------------------------------------------------------------
/**
* Drain one batch of messages from a thread-port receive queue.
* Each item is `[byteArrays, portInfos]` where byteArrays = `[main, ...stores]`
* and portInfos = `[[qHandle, qWakeReadFd], ...]`.
*/
function _recvThreadMessages(handle: number | null): [Uint8Array[], [number, number][]][] {
  const raw = handle !== null ? (threadPortRecv as (h: number) => unknown)(handle) : (nativeRecv as () => unknown)();
  return raw as [Uint8Array[], [number, number][]][];
}
// ---------------------------------------------------------------------------
// ThreadPort — cross-Isolate (cross-thread) MessagePort transport
// ---------------------------------------------------------------------------
/**
* ThreadPort provides a MessagePort-compatible API for cross-thread Realm
* messaging via V8 ValueSerializer + Rust mpsc channels.
*
* Messages are serialized with `internal:serializer` (V8 wire format),
* sent via `internal:thread-port` (mpsc + wake pipe), and deserialized on
* the receiving side.
*
* The event loop is integrated via `loop.readable(wakeReadFd)`: the port
* continuously waits for the wake pipe to become readable, drains the
* channel when it does, and re-arms for the next message.
*
* Mirrors the public MessagePort API so existing realm bootstrap code
* (`internal/bootstrap.ts`) works with both IntraPort and ThreadPort.
*
* ```typescript no_run
* const port = new ThreadPort(wakeReadFd, handle);
* port.start();
* ```
*/
export class ThreadPort extends BaseTransportPort {
  /**
  * Private property `#wakeReadFd` used by `ThreadPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #wakeReadFd = undefined;
  *
  *   readInternalState() {
  *     return this.#wakeReadFd;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #wakeReadFd: number;
  /** Non-null on the parent side — use handle-indexed native ops. */
  /**
  * Private property `#handle` used by `ThreadPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #handle = undefined;
  *
  *   readInternalState() {
  *     return this.#handle;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #handle: number | null;
  /**
  * Private property `#onmessageerror` used by `ThreadPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #onmessageerror = undefined;
  *
  *   readInternalState() {
  *     return this.#onmessageerror;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #onmessageerror: ((ev: Event) => void) | null = null;
  /**
  * @internal
  * @param wakeReadFd — own wake-pipe read fd (for loop.readable)
  * @param handle — thread context handle (parent side only; omit on child side)
  *
  * ```typescript no_run
  * const port = new ThreadPort(wakeReadFd, handle);
  * ```
  */
  constructor(wakeReadFd: number, handle?: number) {
    super();
    this.#wakeReadFd = wakeReadFd;
    this.#handle = handle ?? null;
  }
  /**
  * Serialize and send a message to the opposite thread endpoint.
  *
  * Closed ports ignore sends. Transfer lists may include ArrayBuffers and
  * MessagePorts; transferred MessagePorts are converted to transit channels.
  *
  * ```typescript no_run
  * threadPort.postMessage({ type: 'ready' });
  * ```
  */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this._closed) return;
    // Extract ArrayBuffer elements from the transfer list.
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts) ? transferOrOpts as Transferable[] : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const transferABs: ArrayBuffer[] = [];
    const portInfos: [number, number][] = [];
    if (rawTransfer) {
      for (const item of rawTransfer) {
        if (item instanceof ArrayBuffer) {
          transferABs.push(item);
        } else if (item instanceof MessagePort) {
          // Cross-Isolate port transfer: create a transit channel pair, upgrade
          // the partner port (P2) to use the P2-half, and ship the Q-half info.
          const { p2Handle, p2WakeReadFd, qHandle, qWakeReadFd } = (createTransitChannel as () => {
            p2Handle: number;
            p2WakeReadFd: number;
            qHandle: number;
            qWakeReadFd: number;
          })();
          item._transferCrossThread(p2Handle, p2WakeReadFd);
          portInfos.push([qHandle, qWakeReadFd]);
        } else {
          throw new TypeError('ThreadPort transfer list only supports ArrayBuffer and MessagePort values');
        }
      }
    }
    // serialize() returns [mainBytes, store0, store1, ...].
    const serResult = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(message, transferABs.length > 0 ? transferABs : undefined);
    const data = serResult[0];
    const stores = serResult.length > 1 ? serResult.slice(1) : [] as Uint8Array[];
    if (this.#handle !== null) {
      // Parent side: route through handle-indexed send.
      (threadPortSend as (h: number, b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(this.#handle, data, stores, portInfos);
    } else {
      // Child side: send via FinoState channel.
      (nativeSend as (b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(data, stores, portInfos);
    }
  }
  /**
  * Start watching the wake fd for incoming messages.
  *
  * ```typescript no_run
  * threadPort.start();
  * ```
  */
  protected override _onStart(): void {
    this.#watchLoop();
  }
  /**
  * Remove the runtime read watcher for this port.
  *
  * ```typescript no_run
  * threadPort.close();
  * ```
  */
  protected override _onClose(): void {
    removeRead(this.#wakeReadFd);
  }
  /**
  * Message error handler property.
  *
  * ```typescript no_run
  * threadPort.onmessageerror = (event) => console.log(event.type);
  * ```
  */
  get onmessageerror() {
    return this.#onmessageerror;
  }
  /**
  * Set or clear the messageerror handler property.
  *
  * ```typescript no_run
  * threadPort.onmessageerror = null;
  * ```
  */
  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null) this.removeEventListener('messageerror', this.#onmessageerror);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror);
  }
  /**
  * Private method `#watchLoop` used by `ThreadPort`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #watchLoop() {
  *     return 'watchLoop';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#watchLoop();
  *   }
  * }
  * ```
  *
  * @internal
  */
  async #watchLoop(): Promise<void> {
    while (!this._closed) {
      await readable(this.#wakeReadFd);
      if (this._closed) break;
      this._drain();
    }
  }
  /**
  * Drain the mpsc channel and dispatch all buffered messages.
  *
  * Called by the wake-loop when the runtime marks the wake fd readable.
  *
  * ```typescript no_run
  * threadPort._drain();
  * ```
  *
  * @internal
  */
  _drain(): void {
    const messages = _recvThreadMessages(this.#handle);
    for (const [byteArr, portArr] of messages as any[]) {
      const [buf, ...stores] = byteArr as Uint8Array[];
      if (!buf) continue;
      const ports = (portArr as [number, number][]).map(([h, wfd]) => MessagePort._fromTransit(h, wfd));
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports);
    }
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
