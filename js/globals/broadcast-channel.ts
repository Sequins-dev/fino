/**
* BroadcastChannel global for one-to-many pub/sub across Realms.
*
* HTML BroadcastChannel API:
* https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts
*
* Same-Realm and cross-Isolate delivery both flow through the Rust-side global
* registry (`internal:broadcast`).  The registry fans out serialised message
* bytes to every subscriber on the same channel name, excluding the sender.
*
* Delivery is always asynchronous: a wake pipe registered with `loop.readable`
* is used to defer delivery to the next event-loop turn.
*
* BroadcastChannel does not accept a transfer list. Messages are serialized
* through the runtime serializer, so functions, symbols, weak collections, and
* other unsupported structured-clone values fail synchronously in
* `postMessage()`. Deserialization failures from a peer are reported as
* `messageerror` events with `data === null`.
*
* ## Example
*
* ```typescript no_run
*
* const channel = new BroadcastChannel('cache-invalidations');
* channel.onmessage = (event) => {
*   console.log('invalidate', event.data.key);
* };
*
* channel.postMessage({ key: 'users:42' });
* channel.close();
* ```
*
*/
import { Event, EventTarget, _markEventTrusted } from './eventtarget.ts';
import { DOMException } from './encoding.ts';
import { serialize, deserialize } from 'internal:serializer';
import { subscribe, publish, receive, unsubscribe, wakeSubscriber } from 'internal:broadcast';
import { readable, removeRead } from 'internal:runtime/loop';
import { MessageEvent } from './messaging.ts';
// ---------------------------------------------------------------------------
// BroadcastChannel
// ---------------------------------------------------------------------------
function broadcastDataCloneError(message: string): DOMException {
  return new DOMException(message, 'DataCloneError');
}
function currentOrigin(): string {
  const location = (globalThis as {
    location?: {
      origin?: unknown;
    };
  }).location;
  return location?.origin === undefined ? '' : String(location.origin);
}
const BROADCAST_ENVELOPE = '__finoBroadcastChannel';
const REALM_ID = `${Date.now()}-${Math.random()}`;
const localChannels = new Map<string, Set<BroadcastChannel>>();
const pendingLocalTasks: Array<{
  target: BroadcastChannel;
  bytes: Uint8Array;
}> = [];
let localFlushScheduled = false;
function enqueueLocalBroadcast(target: BroadcastChannel, bytes: Uint8Array): void {
  pendingLocalTasks.push({
    target,
    bytes
  });
  if (localFlushScheduled) return;
  localFlushScheduled = true;
  setTimeout(flushLocalBroadcasts, 0);
}
function flushLocalBroadcasts(): void {
  localFlushScheduled = false;
  const tasks = pendingLocalTasks.splice(0);
  for (const task of tasks) {
    task.target._deliverSerialized(task.bytes);
  }
  if (pendingLocalTasks.length > 0) {
    localFlushScheduled = true;
    setTimeout(flushLocalBroadcasts, 0);
  }
}
/**
* One-to-many channel scoped by name across Fino realms and isolates.
*
* Messages are serialized through the internal broadcast registry and delivered
* asynchronously to other subscribers with the same channel name. The sender
* does not receive its own message.
*
* ```typescript no_run
* const channel = new BroadcastChannel('updates');
* channel.onmessage = (event) => console.log(event.data);
* channel.postMessage({ ok: true });
* ```
*/
export class BroadcastChannel extends EventTarget {
  /**
  * Private readonly property `#name` used by `BroadcastChannel`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #name = undefined;
  *
  *   readInternalState() {
  *     return this.#name;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #name: string;
  /**
  * Private readonly property `#handle` used by `BroadcastChannel`.
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
  readonly #handle: number;
  /**
  * Private readonly property `#wakeReadFd` used by `BroadcastChannel`.
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
  readonly #wakeReadFd: number;
  /**
  * Private property `#closed` used by `BroadcastChannel`.
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
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;
  /**
  * Handler invoked for successfully deserialized message events.
  *
  * Assign null to clear it. addEventListener('message', ...) can be used in
  * parallel with this property.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('events');
  * bc.onmessage = (event) => console.log(event.data);
  * ```
  */
  get onmessage() {
    return this.#onmessage;
  }
  set onmessage(fn: ((ev: MessageEvent) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage as any);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) this.addEventListener('message', this.#onmessage as any);
  }
  /**
  * Handler invoked when received bytes cannot be deserialized.
  *
  * The MessageEvent data is null for these failures. This is most likely when
  * versions or serializers disagree across isolates.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('events');
  * bc.onmessageerror = (event) => console.log(event.data);
  * ```
  */
  get onmessageerror() {
    return this.#onmessageerror;
  }
  set onmessageerror(fn: ((ev: MessageEvent) => void) | null) {
    if (this.#onmessageerror !== null) this.removeEventListener('messageerror', this.#onmessageerror as any);
    this.#onmessageerror = typeof fn === 'function' ? fn : null;
    if (this.#onmessageerror !== null) this.addEventListener('messageerror', this.#onmessageerror as any);
  }
  /**
  * Subscribe to a named BroadcastChannel.
  *
  * The name is string-coerced. Construction registers a Rust-side subscriber
  * and starts an asynchronous receive loop that is cleaned up by close().
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('cache-invalidations');
  * bc.name; // "cache-invalidations"
  * ```
  */
  constructor(name: string) {
    if (arguments.length < 1) {
      throw new TypeError('Failed to construct \'BroadcastChannel\': 1 argument required, but only 0 present.');
    }
    super();
    this.#name = String(name);
    const info = subscribe(this.#name) as {
      handle: number;
      wakeReadFd: number;
    };
    this.#handle = info.handle;
    this.#wakeReadFd = info.wakeReadFd;
    let channels = localChannels.get(this.#name);
    if (channels === undefined) {
      channels = new Set();
      localChannels.set(this.#name, channels);
    }
    channels.add(this);
    this.#startListening();
  }
  /**
  * Channel name used for subscription and publishing.
  *
  * This value is read-only and is the string-coerced constructor argument.
  *
  * ```typescript no_run
  * new BroadcastChannel(123 as any).name; // "123"
  * ```
  */
  get name(): string {
    return this.#name;
  }
  /**
  * Publish a structured-clone-serializable message to peer subscribers.
  *
  * Transfer lists are not supported by BroadcastChannel. Calling this after
  * close() throws `InvalidStateError`. Serialization failures propagate to the
  * caller.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('jobs');
  * bc.postMessage({ id: 1, state: 'ready' });
  * ```
  */
  postMessage(message: unknown): void {
    if (arguments.length < 1) {
      throw new TypeError('Failed to execute \'postMessage\' on \'BroadcastChannel\': 1 argument required, but only 0 present.');
    }
    if (this.#closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
    // serialize() returns [mainBytes, ...transferStores]; BroadcastChannel
    // does not support transfer, so we only need the main bytes.
    let serResult: Uint8Array[];
    try {
      serResult = (serialize as (v: unknown) => Uint8Array[])({
        [BROADCAST_ENVELOPE]: true,
        senderRealmId: REALM_ID,
        data: message
      });
    } catch (err) {
      throw broadcastDataCloneError(err instanceof Error ? err.message : String(err));
    }
    const bytes = serResult[0]!;
    const channels = localChannels.get(this.#name);
    if (channels !== undefined) {
      for (const channel of channels) {
        if (channel !== this) enqueueLocalBroadcast(channel, bytes);
      }
    }
    publish(this.#name, bytes, this.#handle);
  }
  /**
  * Close the channel and unregister the subscriber.
  *
  * The operation is idempotent. Pending delivery waits are woken so the receive
  * loop can remove its read watcher and unsubscribe from the registry.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('jobs');
  * bc.close();
  * bc.close();
  * ```
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const channels = localChannels.get(this.#name);
    if (channels !== undefined) {
      channels.delete(this);
      if (channels.size === 0) localChannels.delete(this.#name);
    }
    // Write a byte to our own wake pipe so that any pending readable() call
    // in #receiveLoop resolves immediately.  The loop checks #closed after
    // waking and exits, then calls unsubscribe() to clean up the Rust side.
    wakeSubscriber(this.#handle);
  }
  [Symbol.dispose](): void {
    this.close();
  }
  // ---------------------------------------------------------------------------
  // Internal loop
  // ---------------------------------------------------------------------------
  /**
  * Private method `#startListening` used by `BroadcastChannel`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #startListening() {
  *     return 'startListening';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#startListening();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #startListening(): void {
    // Kick off the async receive loop in a microtask so the constructor returns
    // before any delivery attempt.
    Promise.resolve().then(() => this.#receiveLoop());
  }
  /**
  * Private method `#receiveLoop` used by `BroadcastChannel`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #receiveLoop() {
  *     return 'receiveLoop';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#receiveLoop();
  *   }
  * }
  * ```
  *
  * @internal
  */
  async #receiveLoop(): Promise<void> {
    while (!this.#closed) {
      // Wait until the wake pipe signals that a message has arrived (or that
      // close() was called — it writes a byte to unblock us).
      await readable(this.#wakeReadFd);
      if (this.#closed) break;
      const blobs = receive(this.#handle) as Uint8Array[];
      for (const bytes of blobs) {
        this.#deliverSerializedFromNative(bytes);
      }
    }
    // Loop exited — clean up the Rust subscription and any residual watcher.
    removeRead(this.#wakeReadFd);
    unsubscribe(this.#handle);
  }
  /**
  * Deliver serialized local broadcast bytes.
  *
  * @internal
  */
  _deliverSerialized(bytes: Uint8Array): void {
    if (this.#closed) return;
    const data = this.#deserializeEnvelope(bytes, true);
    if (data === undefined) return;
    const ev = new MessageEvent('message', {
      data,
      origin: currentOrigin()
    });
    _markEventTrusted(ev);
    this.dispatchEvent(ev);
  }
  #deliverSerializedFromNative(bytes: Uint8Array): void {
    if (this.#closed) return;
    const data = this.#deserializeEnvelope(bytes, false);
    if (data === undefined) return;
    const ev = new MessageEvent('message', {
      data,
      origin: currentOrigin()
    });
    _markEventTrusted(ev);
    this.dispatchEvent(ev);
  }
  #deserializeEnvelope(bytes: Uint8Array, local: boolean): unknown | undefined {
    let value: unknown;
    try {
      value = deserialize(bytes);
    } catch {
      const ev = new MessageEvent('messageerror', {
        data: null,
        origin: currentOrigin()
      });
      _markEventTrusted(ev);
      this.dispatchEvent(ev);
      return undefined;
    }
    if (value !== null && typeof value === 'object') {
      const envelope = value as Record<string, unknown>;
      if (envelope[BROADCAST_ENVELOPE] === true) {
        if (!local && envelope.senderRealmId === REALM_ID) return undefined;
        return envelope.data;
      }
    }
    return value;
  }
}
