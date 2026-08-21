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
import {
  EventTarget,
  _markEventTrusted,
  type AddEventListenerOptions,
  type EventCallback,
} from '../../globals/eventtarget.ts';
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
import { RealmSession, type RealmObserver } from 'internal:realm/session';
import { sandboxPortRecv, sandboxPortSend } from 'internal:realm-native';
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
  /** Observation boundary shared by every concrete realm transport. */
  #session = new RealmSession();
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
  #messagesPaused = false;
  #pendingMessages: MessageEvent[] = [];
  #portable = false;
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
  /** Register a listener and release bootstrap-held messages to its first consumer. */
  override addEventListener(
    type: string,
    callback: EventCallback | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, callback, options);
    if (type === 'message' && callback !== null) this._resumeMessages();
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
   * Observe semantic frames crossing this endpoint.
   *
   * @internal
   */
  _observe(observer: RealmObserver): () => void {
    return this.#session.observe(observer);
  }
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
        if (
          this.#portable ||
          this.#session.portable ||
          (globalThis as Record<PropertyKey, unknown>)[Symbol.for('fino.sim.active')] === true
        ) {
          throw new TypeError(
            'Replayable realm sessions cannot transfer MessagePort values; expose a facade channel instead',
          );
        }
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
    if (this.#session.observed) {
      this.#session._capture({
        direction: 'outbound',
        envelope,
        payloadBytes: parts.reduce((total, part) => total + part.byteLength, 0),
        arrayBufferTransfers: stores.length,
        portTransfers: portInfos.length,
        snapshot: () =>
          (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(
            data!,
            stores.length > 0 ? stores : undefined,
          ),
        storage: () => parts.map((part) => part.slice()),
      });
    }
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
    if (this.#session.observed) {
      const parts = stores === undefined ? [buf] : [buf, ...stores];
      this.#session._capture({
        direction: 'inbound',
        envelope,
        payloadBytes: parts.reduce((total, part) => total + part.byteLength, 0),
        arrayBufferTransfers: stores?.length ?? 0,
        portTransfers: ports.length,
        snapshot: () => (deserialize as (b: Uint8Array, s?: Uint8Array[]) => unknown)(buf, stores),
        storage: () => parts.map((part) => part.slice()),
      });
    }
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
    if (this.#messagesPaused) {
      this.#pendingMessages.push(event);
      return;
    }
    this.dispatchEvent(event);
  }
  /** Hold application messages while bootstrap evaluates the entry module. @internal */
  _pauseMessages(): void {
    this.#messagesPaused = true;
  }

  /** Deliver application messages held during bootstrap in arrival order. @internal */
  _resumeMessages(): void {
    if (!this.#messagesPaused) return;
    this.#messagesPaused = false;
    for (const event of this.#pendingMessages.splice(0)) this.dispatchEvent(event);
  }

  /** Require values on both sides of this link to remain cassette-portable. @internal */
  _requirePortable(): void {
    this.#portable = true;
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
 * One frame as it arrives from a link: payload bytes, transferred port
 * descriptors, and the envelope header when the transport carries one.
 *
 * @internal
 */
export type RealmFrame = [bytes: Uint8Array[], ports: [number, number][], header?: Uint8Array];

/**
 * One end of a realm message channel.
 *
 * A link owns nothing but the movement of bytes. Serialization, transfer-list
 * rules, envelope handling and event dispatch all live in the port, so adding a
 * transport means describing how its bytes travel — not reimplementing a port.
 *
 * @internal
 */
export interface RealmLink {
  /**
   * Which transport moves this link's bytes. Reported by `RealmPort.transport`
   * so a port's channel stays identifiable now that every transport shares one
   * port class.
   */
  readonly transport: 'parent' | 'scheduled' | 'sandbox' | 'process' | 'cluster';
  /**
   * Descriptor that becomes readable when frames arrive, or `-1` for links that
   * are pushed to from elsewhere rather than polled.
   */
  readonly wakeFd: number;
  /** Whether a live `MessagePort` can cross this link. */
  readonly supportsPortTransfer: boolean;
  send(header: Uint8Array, data: Uint8Array, stores: Uint8Array[], ports: [number, number][]): void;
  /** Take every frame currently queued. */
  drain(): RealmFrame[];
  /** Release transport-owned resources when the port closes. */
  close?(): void;
}

/**
 * MessagePort-compatible endpoint over a {@link RealmLink}.
 *
 * Every realm transport — reactor-pooled, process, cluster — is this one class
 * with a different link. It is not a web global; application code should treat
 * `Realm.port` as a port-like object and use `MessagePort`/`MessageChannel` for
 * web-compatible channel messaging.
 *
 * @internal
 */
export class RealmPort extends BaseTransportPort {
  #link: RealmLink;
  #onmessageerror: ((ev: Event) => void) | null = null;

  constructor(link: RealmLink) {
    super();
    this.#link = link;
  }

  /** Which transport carries this port's messages. */
  get transport(): RealmLink['transport'] {
    return this.#link.transport;
  }

  /** @internal */
  protected override _send(
    header: Uint8Array,
    data: Uint8Array,
    stores: Uint8Array[],
    ports: [number, number][],
  ): void {
    this.#link.send(header, data, stores, ports);
  }

  /** @internal */
  protected override _supportsPortTransfer(): boolean {
    return this.#link.supportsPortTransfer;
  }

  /** @internal */
  protected override _onStart(): void {
    if (this.#link.wakeFd >= 0) void this.#watchLoop();
  }

  /** @internal */
  protected override _onClose(): void {
    if (this.#link.wakeFd >= 0) removeRead(this.#link.wakeFd);
    this.#link.close?.();
  }

  /** Message error handler property. */
  get onmessageerror() {
    return this.#onmessageerror;
  }

  /** Set or clear the messageerror handler property. */
  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null)
      this.removeEventListener('messageerror', this.#onmessageerror);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror);
  }

  /**
   * Await readable() on the link's descriptor and drain on each signal.
   *
   * @internal
   */
  async #watchLoop(): Promise<void> {
    while (!this._closed) {
      await readable(this.#link.wakeFd);
      if (this._closed) break;
      this._drain();
    }
  }

  /**
   * Dispatch every frame currently queued on the link.
   *
   * Realm completion drains synchronously before closing the port, so a final
   * response cannot lose a race with the separate completion signal.
   *
   * @internal
   */
  _drain(): void {
    for (const [byteArr, portArr, header] of this.#link.drain()) {
      const [buf, ...stores] = byteArr;
      if (!buf) continue;
      const ports = portArr.map(([handle, wakeFd]) => MessagePort._fromTransit(handle, wakeFd));
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports, header);
    }
  }
}

/**
 * Link from a child realm back to whichever realm created it.
 *
 * @internal
 */
export function parentRealmLink(wakeFd: number): RealmLink {
  return {
    transport: 'parent',
    wakeFd,
    supportsPortTransfer: true,
    send: (header, data, stores, ports) =>
      (
        nativeSend as (h: Uint8Array, b: Uint8Array, s: Uint8Array[], p: [number, number][]) => void
      )(header, data, stores, ports),
    drain: () => (nativeRecv as () => RealmFrame[])(),
  };
}

/**
 * Link from a parent realm to one of its reactor-pooled children.
 *
 * @internal
 */
export function scheduledRealmLink(handle: number, wakeFd: number): RealmLink {
  return {
    transport: 'scheduled',
    wakeFd,
    supportsPortTransfer: true,
    send: (header, data, stores, ports) => scheduledRealmSend(handle, header, data, stores, ports),
    drain: () => scheduledRealmRecv(handle) as RealmFrame[],
  };
}

/**
 * Link from a parent realm to a Linux sandbox realm.
 *
 * A sandbox realm owns a dedicated OS thread so its thread-scoped Landlock,
 * seccomp and cgroup controls never touch the reactor pool, but it is still in
 * this process — so a transit channel can cross it like any other same-process
 * transport.
 *
 * @internal
 */
export function sandboxRealmLink(handle: number, wakeFd: number): RealmLink {
  return {
    transport: 'sandbox',
    wakeFd,
    supportsPortTransfer: true,
    send: (header, data, stores, ports) =>
      (
        sandboxPortSend as (
          handle: number,
          h: Uint8Array,
          b: Uint8Array,
          s: Uint8Array[],
          p: [number, number][],
        ) => void
      )(handle, header, data, stores, ports),
    drain: () => (sandboxPortRecv as (handle: number) => RealmFrame[])(handle),
  };
}

/**
 * Port for a parent realm talking to a Linux sandbox realm.
 *
 * @internal
 */
export function createSandboxPort(wakeFd: number, handle: number): RealmPort {
  return new RealmPort(sandboxRealmLink(handle, wakeFd));
}

/**
 * Port for a child realm talking back to its creator.
 *
 * @internal
 */
export function createParentPort(wakeFd: number): RealmPort {
  return new RealmPort(parentRealmLink(wakeFd));
}

/**
 * Port for a parent realm talking to a reactor-pooled child.
 *
 * @internal
 */
export function createScheduledPort(wakeFd: number, handle: number): RealmPort {
  return new RealmPort(scheduledRealmLink(handle, wakeFd));
}
