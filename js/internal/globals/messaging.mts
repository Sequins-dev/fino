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
 */

import { Event, EventTarget } from './eventtarget.mts';
import { structuredClone } from './encoding.mts';
import { serialize, deserialize } from 'internal:serializer';
import { nativeSend, nativeRecv, getWakeReadFd } from 'internal:thread-port';
import { threadPortSend, threadPortRecv } from 'internal:realm-native';
import { readable, removeRead } from 'fino:runtime/loop';

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

export class MessagePort extends EventTarget {
  #partner: MessagePort | null = null;
  #queue: { data: any }[] = [];
  #started = false;
  #closed  = false;
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;

  /** @internal — called by MessageChannel constructor */
  _entangle(partner: MessagePort): void {
    this.#partner = partner;
  }

  postMessage(message: any, transfer?: Transferable[]): void;
  postMessage(message: any, options?: StructuredSerializeOptions): void;
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this.#closed || !this.#partner) return;
    const transfer = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const cloned = structuredClone(message, transfer ? { transfer } : undefined);
    this.#partner.#queue.push({ data: cloned });
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    _activePorts.add(this);
  }

  close(): void {
    this.#closed  = true;
    this.#started = false;
    _activePorts.delete(this);
    this.#partner = null;
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

  /** @internal — called by _flushPorts */
  _drain(): void {
    if (!this.#started) return;
    const pending = this.#queue.splice(0);
    for (const msg of pending) {
      this.dispatchEvent(new MessageEvent('message', { data: msg.data }));
    }
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
export class ThreadPort extends EventTarget {
  #wakeReadFd: number;
  /** Non-null on the parent side — use handle-indexed native ops. */
  #handle: number | null;
  #started = false;
  #closed  = false;
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;

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

  postMessage(message: any, _transfer?: Transferable[] | StructuredSerializeOptions): void {
    if (this.#closed) return;
    const bytes = serialize(message);
    if (this.#handle !== null) {
      // Parent side: route through handle-indexed send.
      (threadPortSend as (h: number, b: Uint8Array) => void)(this.#handle, bytes);
    } else {
      // Child side: send via FinoState channel.
      nativeSend(bytes);
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#watchLoop();
  }

  close(): void {
    this.#closed  = true;
    this.#started = false;
    // Cancel any pending readable() so alive() can return false.
    removeRead(this.#wakeReadFd);
  }

  get onmessage() { return this.#onmessage; }
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    if (this.#onmessage !== null) {
      this.removeEventListener('message', this.#onmessage as EventListener);
    }
    this.#onmessage = typeof fn === 'function' ? fn : null;
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

  /** @internal — continuously watches the wake pipe and dispatches messages */
  async #watchLoop(): Promise<void> {
    while (!this.#closed) {
      await readable(this.#wakeReadFd);
      if (this.#closed) break;
      this._drain();
    }
  }

  /** @internal — drain the mpsc channel and dispatch all buffered messages */
  _drain(): void {
    const buffers: Uint8Array[] = this.#handle !== null
      ? (threadPortRecv as (h: number) => Uint8Array[])(this.#handle)
      : (nativeRecv() as Uint8Array[]);
    for (const buf of buffers) {
      try {
        const value = deserialize(buf);
        this.dispatchEvent(new MessageEvent('message', { data: value }));
      } catch (err) {
        this.dispatchEvent(new MessageEvent('messageerror', { data: err }));
      }
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
