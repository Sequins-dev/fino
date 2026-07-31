/**
 * Internal transport-backed realm ports.
 *
 * Thread, process, and cluster realms expose MessagePort-compatible endpoints,
 * but their implementations are runtime transports rather than web messaging
 * globals. This module owns the shared transport lifecycle and the thread-realm
 * port used by realm bootstrap.
 *
 * @internal
 */
import { EventTarget, _markEventTrusted } from '../../globals/eventtarget.ts';
import { MessageEvent, MessagePort } from '../../globals/messaging.ts';
import { serialize, deserialize } from 'internal:serializer';
import {
  decodeEnvelope,
  encodeEnvelope,
  EnvelopeKind,
  messageEnvelope,
  type Envelope,
} from 'internal:realm/envelope';
import { nativeSend, nativeRecv } from 'internal:thread-port';
import { sandboxPortSend, sandboxPortRecv } from 'internal:realm-native';
import { scheduledRealmRecv, scheduledRealmSend } from 'internal:scheduler-native';
import { createTransitChannel } from 'internal:transit-port';
import { readable, removeRead } from 'internal:runtime/loop';
import { resolveRpc, rejectRpc, pushChunk, endStream, errStream } from 'internal:parent-rpc';

/**
 * Shared lifecycle and dispatch logic for transport-backed realm ports.
 *
 * This is an internal base for thread, process, and cluster realm ports.
 * Subclasses implement `postMessage()`, override `_onStart()` and `_onClose()`,
 * and call `_dispatchMessage()` from their drain logic.
 *
 * @internal
 */
export abstract class BaseTransportPort extends EventTarget {
  /**
   * True once start() has run; _dispatchMessage drops messages while the port
   * is unstarted.
   *
   * @internal
   */
  protected _started = false;
  /**
   * True after close(); subclass postMessage implementations check this to
   * silently ignore sends, and drain loops use it as their exit condition.
   *
   * @internal
   */
  protected _closed = false;
  /**
   * Current onmessage handler, kept so reassignment can remove the previously
   * registered listener.
   *
   * @internal
   */
  #onmessage: ((ev: Event) => void) | null = null;
  /**
   * Handlers for runtime protocol frames.
   *
   * @internal
   */
  #controlHandlers = new Set<(envelope: Envelope, value: unknown) => boolean>();
  /**
   * Start delivery for this transport-backed port.
   *
   * Repeated calls and calls after close() are ignored. Subclasses are notified
   * through _onStart().
   */
  start(): void {
    if (this._started || this._closed) return;
    this._started = true;
    this._onStart();
  }
  /**
   * Close this port and stop delivery.
   */
  close(): void {
    this._closed = true;
    this._started = false;
    this._onClose();
  }
  /**
   * Close the port when it leaves a `using` declaration's scope.
   */
  [Symbol.dispose](): void {
    this.close();
  }
  /**
   * Subclass hook invoked when start() transitions the port to started.
   *
   * @internal
   */
  protected _onStart(): void {}
  /**
   * Subclass hook invoked when close() runs.
   *
   * @internal
   */
  protected _onClose(): void {}
  /**
   * Hand an encoded message to the concrete transport.
   *
   * @internal
   */
  protected abstract _send(
    header: Uint8Array,
    data: Uint8Array,
    stores: Uint8Array[],
    ports: [number, number][],
  ): void;
  /**
   * Whether this transport can move a live `MessagePort` to the far side.
   *
   * A transit channel is a pair of descriptors in one process, so only
   * transports that stay inside it can carry one. Declaring this up front means
   * the port is rejected before a channel is created for it, rather than after.
   *
   * @internal
   */
  protected _supportsPortTransfer(): boolean {
    return true;
  }
  /**
   * Serialize `message` and send it under `envelope`.
   *
   * Every transport shares this: the structured clone, the transfer-list rules,
   * and the envelope header are identical regardless of which channel carries
   * the bytes, so only `_send` differs between port types.
   *
   * @internal
   */
  protected _postEnvelope(
    envelope: Envelope,
    message: unknown,
    transferOrOpts?: Transferable[] | StructuredSerializeOptions,
  ): void {
    if (this._closed) return;
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const transferABs: ArrayBuffer[] = [];
    const portInfos: [number, number][] = [];
    for (const item of rawTransfer ?? []) {
      if (item instanceof ArrayBuffer) {
        transferABs.push(item);
      } else if (item instanceof MessagePort) {
        if (!this._supportsPortTransfer()) {
          throw new TypeError(
            `${this.constructor.name} transfer list only supports ArrayBuffer values`,
          );
        }
        const { p2Handle, p2WakeReadFd, qHandle, qWakeReadFd } = (
          createTransitChannel as () => {
            p2Handle: number;
            p2WakeReadFd: number;
            qHandle: number;
            qWakeReadFd: number;
          }
        )();
        item._transferCrossThread(p2Handle, p2WakeReadFd);
        portInfos.push([qHandle, qWakeReadFd]);
      } else {
        throw new TypeError(
          `${this.constructor.name} transfer list only supports ArrayBuffer and MessagePort values`,
        );
      }
    }
    const parts = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
      message,
      transferABs.length > 0 ? transferABs : undefined,
    );
    const [data, ...stores] = parts;
    this._send(encodeEnvelope(envelope), data!, stores, portInfos);
  }
  /**
   * Send runtime control traffic — a call, a result, a termination request, or
   * an RPC frame — rather than application data.
   *
   * The kind travels in the header, never in the payload, so a realm cannot
   * fabricate one by posting a plain object with the right property on it.
   *
   * @internal
   */
  _postControl(
    kind: Envelope['kind'],
    correlation: number,
    message: unknown,
    transfer?: Transferable[],
  ): void {
    this._postEnvelope({ kind, correlation }, message, transfer);
  }
  /**
   * Send an application message.
   */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    this._postEnvelope(messageEnvelope(), message, transferOrOpts);
  }
  /**
   * Decode one incoming message and route it by envelope kind.
   *
   * RPC frames are settled against the pending-request registry and never
   * surface as events; everything else is dispatched to listeners. Subclasses
   * call this from their per-message drain loop.
   *
   * @internal
   */
  protected _dispatchMessage(
    buf: Uint8Array,
    stores?: Uint8Array[],
    ports: MessagePort[] = [],
    header?: Uint8Array,
  ): void {
    if (!this._started) return;
    const envelope = decodeEnvelope(header);
    let value: unknown;
    try {
      value = (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
        buf,
        stores && stores.length > 0 ? stores : undefined,
      );
    } catch (err) {
      const event = new MessageEvent('messageerror', { data: err });
      _markEventTrusted(event);
      this.dispatchEvent(event);
      return;
    }
    switch (envelope.kind) {
      case EnvelopeKind.RpcResponse: {
        const response = value as { result?: unknown; error?: string };
        if (response?.error !== undefined) {
          if (!rejectRpc(envelope.correlation, response.error)) {
            errStream(envelope.correlation, response.error);
          }
        } else {
          resolveRpc(envelope.correlation, response?.result);
        }
        return;
      }
      case EnvelopeKind.RpcChunk:
        pushChunk(envelope.correlation, value);
        return;
      case EnvelopeKind.RpcEnd:
        endStream(envelope.correlation);
        return;
      case EnvelopeKind.RpcError:
        errStream(envelope.correlation, String((value as { error?: unknown })?.error ?? value));
        return;
      default:
        break;
    }
    if (envelope.kind !== EnvelopeKind.Message) {
      for (const handler of this.#controlHandlers) {
        if (handler(envelope, value)) return;
      }
      // Unclaimed runtime protocol is dropped rather than surfaced. Delivering
      // it as a message would let application listeners see frames they have no
      // business seeing, and would resurrect the payload sniffing this replaced.
      return;
    }
    const event = new MessageEvent('message', {
      data: value,
      ports,
    });
    _markEventTrusted(event);
    this.dispatchEvent(event);
  }
  /**
   * Register a handler for runtime protocol frames on this port.
   *
   * The handler returns true once it has claimed the frame. Control traffic is
   * routed only to these handlers and never reaches `message` listeners, so
   * application code cannot observe — or be confused by — the runtime's own
   * protocol, and cannot forge it either.
   *
   * @internal
   */
  _addControlHandler(handler: (envelope: Envelope, value: unknown) => boolean): () => void {
    this.#controlHandlers.add(handler);
    return () => {
      this.#controlHandlers.delete(handler);
    };
  }
  /**
   * Message handler property for transport-backed ports.
   *
   * Assigning a function registers it and starts the port.
   */
  get onmessage() {
    return this.#onmessage;
  }
  /**
   * Set or clear the message handler property.
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

/**
 * Drain one batch of messages from a thread-port receive queue.
 */
function _recvThreadMessages(handle?: number): [Uint8Array[], [number, number][], Uint8Array?][] {
  const raw =
    handle === undefined
      ? (nativeRecv as () => unknown)()
      : (sandboxPortRecv as (handle: number) => unknown)(handle);
  return raw as [Uint8Array[], [number, number][], Uint8Array?][];
}

/**
 * MessagePort-compatible endpoint for cross-thread realm messaging.
 *
 * ThreadPort is constructed by realm bootstrap and realm internals. It is not a
 * web global; application code should treat `Realm.port` as a port-like object
 * and use the public `MessagePort`/`MessageChannel` types for web-compatible
 * channel messaging.
 *
 * @internal
 */
export class ThreadPort extends BaseTransportPort {
  /**
   * Wake-pipe read fd registered with loop.readable(); becomes readable when
   * the partner thread sends a message.
   *
   * @internal
   */
  #wakeReadFd: number;
  /** Parent-side native sandbox handle; absent inside the child isolate. */
  #handle?: number;
  /**
   * Current onmessageerror handler.
   *
   * @internal
   */
  #onmessageerror: ((ev: Event) => void) | null = null;
  /**
   * Create a ThreadPort over an existing wake pipe.
   *
   * @internal
   */
  constructor(wakeReadFd: number, handle?: number) {
    super();
    this.#wakeReadFd = wakeReadFd;
    this.#handle = handle;
  }
  /**
   * Hand encoded bytes to the cross-isolate channel.
   *
   * @internal
   */
  protected override _send(
    header: Uint8Array,
    data: Uint8Array,
    stores: Uint8Array[],
    ports: [number, number][],
  ): void {
    if (this.#handle === undefined) {
      (nativeSend as (h: Uint8Array, b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(
        header,
        data,
        stores,
        ports,
      );
      return;
    }
    (
      sandboxPortSend as (
        handle: number,
        h: Uint8Array,
        b: Uint8Array,
        s: Uint8Array[],
        p: [number, number][],
      ) => void
    )(this.#handle, header, data, stores, ports);
  }
  /**
   * Start watching the wake fd for incoming messages.
   *
   * @internal
   */
  protected override _onStart(): void {
    this.#watchLoop();
  }
  /**
   * Remove the runtime read watcher for this port.
   *
   * @internal
   */
  protected override _onClose(): void {
    removeRead(this.#wakeReadFd);
  }
  /**
   * Message error handler property.
   */
  get onmessageerror() {
    return this.#onmessageerror;
  }
  /**
   * Set or clear the messageerror handler property.
   */
  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null)
      this.removeEventListener('messageerror', this.#onmessageerror);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror);
  }
  /**
   * Await readable() on the wake fd and drain each time the partner signals.
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
   * @internal
   */
  _drain(): void {
    for (const [byteArr, portArr, header] of _recvThreadMessages(this.#handle)) {
      const [buf, ...stores] = byteArr;
      if (!buf) continue;
      const ports = portArr.map(([handle, wakeFd]) => MessagePort._fromTransit(handle, wakeFd));
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports, header);
    }
  }
}

/**
 * Parent-side transport for a realm scheduled on the process reactor pool.
 *
 * @internal
 */
export class ScheduledPort extends BaseTransportPort {
  #wakeReadFd: number;
  #handle: number;
  #onmessageerror: ((ev: Event) => void) | null = null;

  constructor(wakeReadFd: number, handle: number) {
    super();
    this.#wakeReadFd = wakeReadFd;
    this.#handle = handle;
  }

  /**
   * Hand encoded bytes to the reactor-pooled realm's channel.
   *
   * @internal
   */
  protected override _send(
    header: Uint8Array,
    data: Uint8Array,
    stores: Uint8Array[],
    ports: [number, number][],
  ): void {
    scheduledRealmSend(this.#handle, header, data, stores, ports);
  }

  protected override _onStart(): void {
    void this.#watchLoop();
  }

  protected override _onClose(): void {
    removeRead(this.#wakeReadFd);
  }

  get onmessageerror() {
    return this.#onmessageerror;
  }

  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null)
      this.removeEventListener('messageerror', this.#onmessageerror);
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

  /**
   * Drain every currently queued message synchronously.
   *
   * Realm completion uses this before closing the port so a final response
   * cannot lose a race with the independent completion readiness signal.
   *
   * @internal
   */
  _drain(): void {
    for (const [byteArr, portArr, header] of scheduledRealmRecv(this.#handle)) {
      const [buf, ...stores] = byteArr;
      if (!buf) continue;
      const ports = portArr.map(([handle, wakeFd]) => MessagePort._fromTransit(handle, wakeFd));
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports, header);
    }
  }
}
