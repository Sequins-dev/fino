/**
 * Internal transport-backed realm communication.
 *
 * `TransportPort` is the one ordered duplex stream at a realm boundary. It
 * owns serialization, explicit transfer, physical-link readiness, control
 * routing, application messages, and lazy observation. `observe()` tees the
 * stream at its serialized boundary; it is not a second session layered over
 * the channel.
 *
 * Tee filters see frame metadata before payload materialization. Matching
 * branches can request an independent structured-clone snapshot or stable
 * storage bytes, each produced at most once and shared for that frame. With no
 * matching branch, live delivery performs no observation clone or byte copy.
 *
 * Clone and transfer behavior follows WHATWG safe passing of structured data:
 * <https://html.spec.whatwg.org/multipage/structured-data.html#safe-passing-of-structured-data>.
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
import { sandboxPortRecv, sandboxPortSend } from 'internal:realm-native';
import { scheduledRealmRecv, scheduledRealmSend } from 'internal:scheduler-native';
import { createTransitChannel } from 'internal:transit-port';
import { readable, removeRead } from 'internal:runtime/loop';
import { resolveRpc, rejectRpc, pushChunk, endStream, errStream } from 'internal:parent-rpc';

/** Direction relative to the observed transport endpoint. @internal */
export type TransportFrameDirection = 'outbound' | 'inbound';

/** Payload representation requested by a transport tee. @internal */
export type TransportCapture = 'metadata' | 'snapshot' | 'storage';

/** Frame data available without cloning or copying its payload. @internal */
export interface TransportFrameMetadata extends Envelope {
  /** Order among frames seen while this port has tee branches. */
  sequence: number;
  /** Whether the frame is leaving or entering this endpoint. */
  direction: TransportFrameDirection;
  /** Serialized payload and transfer-store bytes. */
  payloadBytes: number;
  /** Transferred `ArrayBuffer` backing stores. */
  arrayBufferTransfers: number;
  /** Transferred `MessagePort` channels. */
  portTransfers: number;
}

/** A metadata-only tee item. @internal */
export interface TransportMetadataFrame extends TransportFrameMetadata {
  capture: 'metadata';
}

/** A tee item with an independent structured-clone value. @internal */
export interface TransportSnapshotFrame extends TransportFrameMetadata {
  capture: 'snapshot';
  value: unknown;
}

/** A tee item with stable structured-clone bytes. @internal */
export interface TransportStorageFrame extends TransportFrameMetadata {
  capture: 'storage';
  parts: readonly Uint8Array[];
}

/** One item emitted by a transport tee branch. @internal */
export type TransportFrame =
  | TransportMetadataFrame
  | TransportSnapshotFrame
  | TransportStorageFrame;

/** One lazy branch split from a `TransportPort` frame stream. @internal */
export interface TransportObserver {
  /** Representation needed by this branch. Defaults to metadata. */
  capture?: TransportCapture;
  /** Match inexpensive metadata before a payload representation is made. */
  filter?(metadata: TransportFrameMetadata): boolean;
  /** Consume each matching frame. */
  next(frame: TransportFrame): void;
  /** Receive branch failures without affecting live channel delivery. */
  error?(error: unknown): void;
  /** Reject live child-channel transfer because the branch must be portable. */
  portable?: boolean;
}

interface TransportTeeInput {
  direction: TransportFrameDirection;
  envelope: Envelope;
  payloadBytes: number;
  arrayBufferTransfers: number;
  portTransfers: number;
  snapshot(): unknown;
  storage(): readonly Uint8Array[];
}

/**
 * One MessagePort-compatible endpoint over a {@link RealmLink}.
 *
 * All realm transports use this implementation with a different physical link.
 * Readiness only wakes the link drain; every drained frame then follows the
 * same decode, tee, and routing path.
 *
 * @internal
 */
export class TransportPort extends EventTarget {
  #link: RealmLink;
  #observers = new Set<TransportObserver>();
  #sequence = 0;
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
  #onmessageerror: ((ev: Event) => void) | null = null;
  /**
   * Handlers for runtime protocol frames.
   *
   * @internal
   */
  #controlHandlers = new Set<(envelope: Envelope, value: unknown) => boolean>();

  constructor(link: RealmLink) {
    super();
    this.#link = link;
  }

  /** Which physical link carries this channel. */
  get transport(): RealmLink['transport'] {
    return this.#link.transport;
  }
  /**
   * Start delivery for this transport-backed port.
   *
   * Repeated calls and calls after close() are ignored.
   */
  start(): void {
    if (this._started || this._closed) return;
    this._started = true;
    if (this.#link.wakeFd >= 0) void this.#watchLoop();
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
    if (this._closed) return;
    this._closed = true;
    this._started = false;
    if (this.#link.wakeFd >= 0) removeRead(this.#link.wakeFd);
    this.#link.close?.();
    this.#pendingMessages.length = 0;
  }
  /**
   * Close the port when it leaves a `using` declaration's scope.
   */
  [Symbol.dispose](): void {
    this.close();
  }
  /**
   * Split a lazy observation branch from this channel's ordered frame stream.
   * The returned function removes the branch.
   */
  observe(observer: TransportObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  /** Offer one live frame to matching tee branches. */
  #tee(input: TransportTeeInput): void {
    const metadata: TransportFrameMetadata = {
      sequence: this.#sequence++,
      direction: input.direction,
      kind: input.envelope.kind,
      correlation: input.envelope.correlation,
      payloadBytes: input.payloadBytes,
      arrayBufferTransfers: input.arrayBufferTransfers,
      portTransfers: input.portTransfers,
    };
    const groups: [TransportObserver[], TransportObserver[], TransportObserver[]] = [[], [], []];
    for (const observer of this.#observers) {
      let matched = true;
      try {
        matched = observer.filter?.(metadata) ?? true;
      } catch (error) {
        this.#report(observer, error);
        matched = false;
      }
      if (!matched) continue;
      const index = observer.capture === 'snapshot' ? 1 : observer.capture === 'storage' ? 2 : 0;
      groups[index].push(observer);
    }
    this.#deliver(groups[0], { ...metadata, capture: 'metadata' });
    if (groups[1].length > 0) {
      try {
        this.#deliver(groups[1], { ...metadata, capture: 'snapshot', value: input.snapshot() });
      } catch (error) {
        for (const observer of groups[1]) this.#report(observer, error);
      }
    }
    if (groups[2].length > 0) {
      try {
        this.#deliver(groups[2], { ...metadata, capture: 'storage', parts: input.storage() });
      } catch (error) {
        for (const observer of groups[2]) this.#report(observer, error);
      }
    }
  }

  #deliver(observers: TransportObserver[], frame: TransportFrame): void {
    for (const observer of observers) {
      try {
        observer.next(frame);
      } catch (error) {
        this.#report(observer, error);
      }
    }
  }

  #report(observer: TransportObserver, error: unknown): void {
    try {
      observer.error?.(error);
    } catch {
      // A tee branch cannot break primary channel delivery.
    }
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
          [...this.#observers].some((observer) => observer.portable === true) ||
          (globalThis as Record<PropertyKey, unknown>)[Symbol.for('fino.sim.active')] === true
        ) {
          throw new TypeError(
            'Portable realm channels cannot transfer MessagePort values; expose a facade channel instead',
          );
        }
        if (!this.#link.supportsPortTransfer) {
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
    this.#link.send(encodeEnvelope(envelope), data!, stores, portInfos);
    if (this.#observers.size > 0) {
      this.#tee({
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
    if (this.#observers.size > 0) {
      const parts = stores === undefined ? [buf] : [buf, ...stores];
      this.#tee({
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

  /** Message error handler property. */
  get onmessageerror() {
    return this.#onmessageerror;
  }

  /** Set or clear the message error handler. */
  set onmessageerror(fn: ((ev: Event) => void) | null) {
    if (this.#onmessageerror !== null)
      this.removeEventListener('messageerror', this.#onmessageerror);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror);
  }

  /** Drain every wire frame currently queued by the physical link. @internal */
  _drain(): void {
    for (const [byteArr, portArr, header] of this.#link.drain()) {
      const [buf, ...stores] = byteArr;
      if (!buf) continue;
      const ports = portArr.map(([handle, wakeFd]) => MessagePort._fromTransit(handle, wakeFd));
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined, ports, header);
    }
  }

  /** Route physical readiness back into the channel drain. */
  async #watchLoop(): Promise<void> {
    while (!this._closed) {
      await readable(this.#link.wakeFd);
      if (this._closed) break;
      this._drain();
    }
  }
}

/**
 * One frame as it arrives from a link: payload bytes, transferred port
 * descriptors, and the envelope header when the transport carries one.
 *
 * @internal
 */
export type RealmWireFrame = [bytes: Uint8Array[], ports: [number, number][], header?: Uint8Array];

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
   * Which transport moves this link's bytes. Reported by `TransportPort.transport`
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
  drain(): RealmWireFrame[];
  /** Release transport-owned resources when the port closes. */
  close?(): void;
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
    drain: () => (nativeRecv as () => RealmWireFrame[])(),
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
    drain: () => scheduledRealmRecv(handle) as RealmWireFrame[],
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
    drain: () => (sandboxPortRecv as (handle: number) => RealmWireFrame[])(handle),
  };
}

/**
 * Port for a parent realm talking to a Linux sandbox realm.
 *
 * @internal
 */
export function createSandboxPort(wakeFd: number, handle: number): TransportPort {
  return new TransportPort(sandboxRealmLink(handle, wakeFd));
}

/**
 * Port for a child realm talking back to its creator.
 *
 * @internal
 */
export function createParentPort(wakeFd: number): TransportPort {
  return new TransportPort(parentRealmLink(wakeFd));
}

/**
 * Port for a parent realm talking to a reactor-pooled child.
 *
 * @internal
 */
export function createScheduledPort(wakeFd: number, handle: number): TransportPort {
  return new TransportPort(scheduledRealmLink(handle, wakeFd));
}
