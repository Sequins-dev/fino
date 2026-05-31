/**
 * fino:messaging internals — MessageEvent, MessagePort, MessageChannel,
 * ThreadPort.
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
 * same-Isolate transfers the partner is captured in the queue item and a fresh
 * port is re-entangled on delivery. For cross-Isolate transfers a transit
 * channel is created (internal:transit-port) and the partner port is upgraded
 * in-place to use cross-thread messaging.
 *
 * @internal
 */

import { Event, EventTarget } from './eventtarget.mts';
import { structuredClone } from './encoding.mts';
import { serialize, deserialize } from 'internal:serializer';
import { nativeSend, nativeRecv, getWakeReadFd } from 'internal:thread-port';
import { threadPortSend, threadPortRecv } from 'internal:realm-native';
import { createTransitChannel, transitSend, transitRecv } from 'internal:transit-port';
import { readable, removeRead } from 'fino:runtime/loop';
import { resolveRpc, rejectRpc, pushChunk, endStream, errStream } from 'internal:parent-rpc';

// ---------------------------------------------------------------------------
// MessageEvent
// ---------------------------------------------------------------------------

export interface MessageEventInit {
  data?: any;
  origin?: string;
  lastEventId?: string;
  source?: MessagePort | null;
  ports?: MessagePort[];
}

export class MessageEvent extends Event {
  #data: any;
  #origin: string;
  #lastEventId: string;
  #source: MessagePort | null;
  #ports: readonly MessagePort[];

  constructor(type: string, init?: MessageEventInit) {
    super(type);
    this.#data        = init?.data        ?? null;
    this.#origin      = init?.origin      ?? '';
    this.#lastEventId = init?.lastEventId ?? '';
    this.#source      = init?.source      ?? null;
    this.#ports       = Object.freeze(init?.ports?.slice() ?? []);
  }

  get data()        { return this.#data; }
  get origin()      { return this.#origin; }
  get lastEventId() { return this.#lastEventId; }
  get source()      { return this.#source; }
  get ports()       { return this.#ports; }
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
  /** Ports captured during same-Isolate transfer — re-entangled on delivery. */
  transferredPortPartners?: MessagePort[];
}

export class MessagePort extends EventTarget {
  #partner: MessagePort | null = null;
  #queue: QueueItem[] = [];
  #started = false;
  #closed  = false;
  #neutered = false;
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;

  // Transit mode: set when this port is created from a cross-thread transit
  // half, or when its partner was transferred cross-Isolate (upgrade).
  #transitHandle: number | null = null;
  #transitWakeReadFd: number = -1;

  /** @internal — called by MessageChannel constructor */
  _entangle(partner: MessagePort): void {
    this.#partner = partner;
  }

  /** @internal — called when the partner is neutered during transfer */
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
   */
  static _fromTransit(handle: number, wakeReadFd: number): MessagePort {
    const p = new MessagePort();
    p.#transitHandle = handle;
    p.#transitWakeReadFd = wakeReadFd;
    return p;
  }

  postMessage(message: any, transfer?: Transferable[]): void;
  postMessage(message: any, options?: StructuredSerializeOptions): void;
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
        this.#transitHandle, data, stores,
      );
      return;
    }

    // --- Intra-Isolate mode ---
    if (!this.#partner) return;

    // Separate out any MessagePort instances from the transfer list.
    const portPartners: MessagePort[] = [];
    const abTransfer: Transferable[] = [];
    if (rawTransfer) {
      for (const item of rawTransfer) {
        if (item instanceof MessagePort) {
          if (item.#neutered || item.#closed) continue;
          const partner = item.#partner;
          item.#neutered = true;
          _activePorts.delete(item);
          item.#partner?._disentangle();
          item.#partner = null;
          if (partner !== null) portPartners.push(partner);
        } else {
          abTransfer.push(item);
        }
      }
    }

    const cloned = structuredClone(message, abTransfer.length > 0 ? { transfer: abTransfer } : undefined);
    const item: QueueItem = { data: cloned };
    if (portPartners.length > 0) item.transferredPortPartners = portPartners;
    this.#partner.#queue.push(item);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.#transitHandle !== null) {
      this.#startTransitWatch();
    } else {
      _activePorts.add(this);
    }
  }

  close(): void {
    this.#closed  = true;
    this.#started = false;
    _activePorts.delete(this);
    this.#partner = null;
    if (this.#transitWakeReadFd >= 0) {
      removeRead(this.#transitWakeReadFd);
    }
    this.#transitHandle = null;
    this.#transitWakeReadFd = -1;
  }

  get onmessage() { return this.#onmessage; }
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

  get onmessageerror() { return this.#onmessageerror; }
  set onmessageerror(fn: ((ev: MessageEvent) => void) | null) {
    if (this.#onmessageerror !== null) {
      this.removeEventListener('messageerror', this.#onmessageerror as EventListener);
    }
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) {
      this.addEventListener('messageerror', this.#onmessageerror as EventListener);
    }
  }

  /** @internal — called by _flushPorts for intra-Isolate ports */
  _drain(): void {
    if (!this.#started) return;
    if (this.#transitHandle !== null) return; // handled by #watchTransit
    const pending = this.#queue.splice(0);
    for (const item of pending) {
      const ports = this.#reconstructTransferredPorts(item.transferredPortPartners);
      this.dispatchEvent(new MessageEvent('message', { data: item.data, ports }));
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Re-entangle each captured partner with a fresh port for the recipient. */
  #reconstructTransferredPorts(partners?: MessagePort[]): MessagePort[] {
    if (!partners || partners.length === 0) return [];
    return partners.map((partner) => {
      const fresh = new MessagePort();
      fresh._entangle(partner);
      partner._entangle(fresh);
      return fresh;
    });
  }

  /** Start the transit watch loop and drain incoming messages from it. */
  #startTransitWatch(): void {
    const fd = this.#transitWakeReadFd;
    const handle = this.#transitHandle!;
    const self = this;
    (async () => {
      while (!self.#closed && self.#transitHandle !== null) {
        await readable(fd);
        if (self.#closed || self.#transitHandle === null) break;
        const msgs = (transitRecv as (h: number) => [[Uint8Array[], [number, number][]]]) (handle) as unknown as [[Uint8Array[], [number, number][]]];
        for (const [byteArr, portArr] of (msgs as any[])) {
          try {
            const [buf, ...stores] = byteArr as Uint8Array[];
            const value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
              buf,
              stores.length > 0 ? stores : undefined,
            );
            const ports = (portArr as [number, number][]).map(
              ([h, wfd]) => MessagePort._fromTransit(h, wfd),
            );
            self.dispatchEvent(new MessageEvent('message', { data: value, ports }));
          } catch (err) {
            self.dispatchEvent(new MessageEvent('messageerror', { data: err }));
          }
        }
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// MessageChannel
// ---------------------------------------------------------------------------

export class MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;

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
 */
export abstract class BaseTransportPort extends EventTarget {
  protected _started = false;
  protected _closed  = false;
  #onmessage: ((ev: Event) => void) | null = null;

  start(): void {
    if (this._started || this._closed) return;
    this._started = true;
    this._onStart();
  }

  close(): void {
    this._closed  = true;
    this._started = false;
    this._onClose();
  }

  protected _onStart(): void {}
  protected _onClose(): void {}

  /**
   * Deserialize `buf`+`stores`, intercept `__rpc_res`, and dispatch a
   * MessageEvent. Subclasses call this from their per-message drain loop.
   */
  protected _dispatchMessage(buf: Uint8Array, stores?: Uint8Array[], ports: MessagePort[] = []): void {
    if (!this._started) return;
    let value: unknown;
    try {
      value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
        buf, stores && stores.length > 0 ? stores : undefined,
      );
    } catch (err) {
      this.dispatchEvent(new MessageEvent('messageerror', { data: err }));
      return;
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['__rpc_res'] === true) {
        const rpc = obj as { reqId: number; result?: unknown; error?: string };
        if (rpc.error !== undefined) {
          // Try scalar pending first; if not found, try stream (handler threw before yielding).
          if (!rejectRpc(rpc.reqId, rpc.error)) errStream(rpc.reqId, rpc.error);
        } else {
          resolveRpc(rpc.reqId, rpc.result);
        }
        return;
      }
      if (obj['__rpc_chunk'] === true) {
        const m = obj as { reqId: number; chunk: unknown };
        pushChunk(m.reqId, m.chunk);
        return;
      }
      if (obj['__rpc_end'] === true) {
        endStream((obj as { reqId: number }).reqId);
        return;
      }
      if (obj['__rpc_err'] === true) {
        const m = obj as { reqId: number; error: string };
        errStream(m.reqId, m.error);
        return;
      }
    }
    this.dispatchEvent(new MessageEvent('message', { data: value, ports }));
  }

  get onmessage() { return this.#onmessage; }
  set onmessage(fn: ((ev: Event) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) { this.addEventListener('message', this.#onmessage); this.start(); }
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
  const raw = handle !== null
    ? (threadPortRecv as (h: number) => unknown)(handle)
    : (nativeRecv as () => unknown)();
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
 * (`_bootstrap.mts`) works with both IntraPort and ThreadPort.
 */
export class ThreadPort extends BaseTransportPort {
  #wakeReadFd: number;
  /** Non-null on the parent side — use handle-indexed native ops. */
  #handle: number | null;
  #onmessageerror: ((ev: Event) => void) | null = null;

  /**
   * @internal
   * @param wakeReadFd — own wake-pipe read fd (for loop.readable)
   * @param handle — thread context handle (parent side only; omit on child side)
   */
  constructor(wakeReadFd: number, handle?: number) {
    super();
    this.#wakeReadFd = wakeReadFd;
    this.#handle = handle ?? null;
  }

  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this._closed) return;
    // Extract ArrayBuffer elements from the transfer list.
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;

    const transferABs: ArrayBuffer[] = [];
    const portInfos: [number, number][] = []; // [qHandle, qWakeReadFd]

    if (rawTransfer) {
      for (const item of rawTransfer) {
        if (item instanceof ArrayBuffer) {
          transferABs.push(item);
        } else if (item instanceof MessagePort) {
          // Cross-Isolate port transfer: create a transit channel pair, upgrade
          // the partner port (P2) to use the P2-half, and ship the Q-half info.
          const { p2Handle, p2WakeReadFd, qHandle, qWakeReadFd } =
            (createTransitChannel as () => { p2Handle: number; p2WakeReadFd: number; qHandle: number; qWakeReadFd: number })();
          item._transferCrossThread(p2Handle, p2WakeReadFd);
          portInfos.push([qHandle, qWakeReadFd]);
        }
      }
    }

    // serialize() returns [mainBytes, store0, store1, ...].
    const serResult = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
      message,
      transferABs.length > 0 ? transferABs : undefined,
    );
    const data = serResult[0];
    const stores = serResult.length > 1 ? serResult.slice(1) : ([] as Uint8Array[]);

    if (this.#handle !== null) {
      // Parent side: route through handle-indexed send.
      (threadPortSend as (h: number, b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(
        this.#handle, data, stores, portInfos,
      );
    } else {
      // Child side: send via FinoState channel.
      (nativeSend as (b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(data, stores, portInfos);
    }
  }

  protected override _onStart(): void { this.#watchLoop(); }
  protected override _onClose(): void { removeRead(this.#wakeReadFd); }

  get onmessageerror() { return this.#onmessageerror; }
  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null) this.removeEventListener('messageerror', this.#onmessageerror);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror);
  }

  async #watchLoop(): Promise<void> {
    while (!this._closed) {
      await readable(this.#wakeReadFd);
      if (this._closed) break;
      this._drain();
    }
  }

  /** @internal — drain the mpsc channel and dispatch all buffered messages */
  _drain(): void {
    const messages = _recvThreadMessages(this.#handle);

    for (const [byteArr, portArr] of (messages as any[])) {
      const [buf, ...stores] = byteArr as Uint8Array[];
      if (!buf) continue;
      const ports = (portArr as [number, number][]).map(
        ([h, wfd]) => MessagePort._fromTransit(h, wfd),
      );
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
 * @internal
 */
export function _flushPorts(): void {
  for (const port of _activePorts) {
    port._drain();
  }
}
