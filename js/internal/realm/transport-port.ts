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
import { nativeSend, nativeRecv } from 'internal:thread-port';
import { threadPortSend, threadPortRecv } from 'internal:realm-native';
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
   * Deserialize `buf`+`stores`, intercept internal RPC envelopes, and dispatch
   * a MessageEvent. Subclasses call this from their per-message drain loop.
   *
   * @internal
   */
  protected _dispatchMessage(
    buf: Uint8Array,
    stores?: Uint8Array[],
    ports: MessagePort[] = [],
  ): void {
    if (!this._started) return;
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
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj['__rpc_res'] === true) {
        const rpc = obj as {
          reqId: number;
          result?: unknown;
          error?: string;
        };
        if (rpc.error !== undefined) {
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
        endStream(
          (
            obj as {
              reqId: number;
            }
          ).reqId,
        );
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
      ports,
    });
    _markEventTrusted(event);
    this.dispatchEvent(event);
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
function _recvThreadMessages(handle: number | null): [Uint8Array[], [number, number][]][] {
  const raw =
    handle !== null
      ? (threadPortRecv as (h: number) => unknown)(handle)
      : (nativeRecv as () => unknown)();
  return raw as [Uint8Array[], [number, number][]][];
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
  /**
   * Thread context handle. Non-null on the parent side, which routes through
   * handle-indexed native ops; null on the child side, which uses the FinoState
   * channel.
   *
   * @internal
   */
  #handle: number | null;
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
    this.#handle = handle ?? null;
  }
  /**
   * Serialize and send a message to the opposite thread endpoint.
   */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this._closed) return;
    const rawTransfer: Transferable[] | undefined = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const transferABs: ArrayBuffer[] = [];
    const portInfos: [number, number][] = [];
    if (rawTransfer) {
      for (const item of rawTransfer) {
        if (item instanceof ArrayBuffer) {
          transferABs.push(item);
        } else if (item instanceof MessagePort) {
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
            'ThreadPort transfer list only supports ArrayBuffer and MessagePort values',
          );
        }
      }
    }
    const serResult = (serialize as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
      message,
      transferABs.length > 0 ? transferABs : undefined,
    );
    const data = serResult[0];
    const stores = serResult.length > 1 ? serResult.slice(1) : ([] as Uint8Array[]);
    if (this.#handle !== null) {
      (
        threadPortSend as (h: number, b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void
      )(this.#handle, data, stores, portInfos);
    } else {
      (nativeSend as (b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void)(
        data,
        stores,
        portInfos,
      );
    }
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
    const messages = _recvThreadMessages(this.#handle);
    for (const [byteArr, portArr] of messages as any[]) {
      const [buf, ...stores] = byteArr as Uint8Array[];
      if (!buf) continue;
      const ports = (portArr as [number, number][]).map(([h, wfd]) =>
        MessagePort._fromTransit(h, wfd),
      );
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports);
    }
  }
}
