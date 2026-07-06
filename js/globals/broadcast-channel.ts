/**
* BroadcastChannel global for one-to-many pub/sub across Realms.
*
* Channels are addressed purely by name: every `BroadcastChannel` constructed
* with the same name — in this Realm, in a sibling Realm on the same thread,
* or in a thread/process Realm with its own Isolate — receives every message
* posted to that name, except that a sender never receives its own message.
*
* Delivery is always asynchronous and takes one of two paths. Peers in the
* same Realm are handed the serialized bytes through an in-realm task queue
* flushed on a subsequent event-loop turn. Peers in other Realms receive them
* through the Rust-side global registry (`internal:broadcast`), which fans the
* bytes out to every subscriber on the channel name and signals each one over
* a wake pipe registered with `loop.readable`. Registry echoes of a Realm's
* own messages carry the sending Realm's id and are silently dropped on
* receipt, so each peer sees each message exactly once.
*
* BroadcastChannel does not accept a transfer list. Messages are serialized
* through the runtime serializer, so functions, symbols, weak collections, and
* other unsupported structured-clone values fail synchronously in
* `postMessage()` with a `DataCloneError`. Deserialization failures from a
* peer are reported as `messageerror` events with `data === null`.
*
* `BroadcastChannel` is installed as a global — no import is needed. Each
* instance holds a live registry subscription until `close()` is called (or a
* `using` declaration disposes it), so long-lived programs should close
* channels they no longer need.
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
* HTML BroadcastChannel API:
* https://html.spec.whatwg.org/multipage/web-messaging.html#broadcasting-to-other-browsing-contexts
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
* One-to-many channel scoped by name across Fino Realms and Isolates.
*
* Constructing an instance subscribes it to the named channel; every other
* live, unclosed subscriber with the same name receives messages posted to it,
* delivered asynchronously as `message` events. The sender never receives its
* own message. Payloads that a peer fails to deserialize surface as
* `messageerror` events with `data === null` instead.
*
* Instances are `EventTarget`s, so `addEventListener('message', ...)` works
* alongside the `onmessage` / `onmessageerror` handler properties. Each
* instance owns a registry subscription and a wake-pipe watcher until
* `close()` runs; the class also implements `Symbol.dispose`, so a `using`
* declaration closes it automatically at end of scope.
*
* ```typescript no_run
* const channel = new BroadcastChannel('updates');
* channel.onmessage = (event) => console.log(event.data);
* channel.postMessage({ ok: true });
* channel.close();
* ```
*/
export class BroadcastChannel extends EventTarget {
  /**
  * String-coerced channel name captured at construction; the subscription key
  * for both the local channel map and the Rust-side registry.
  *
  * @internal
  */
  readonly #name: string;
  /**
  * Subscriber handle returned by `internal:broadcast`'s `subscribe()`. Passed
  * to `publish` (so the registry can skip echoing to the sender), `receive`,
  * `wakeSubscriber`, and finally `unsubscribe` on close.
  *
  * @internal
  */
  readonly #handle: number;
  /**
  * Read end of this subscriber's wake pipe. The receive loop awaits
  * `readable(#wakeReadFd)` between deliveries; the registry writes to the
  * pipe when message bytes arrive, and `close()` writes to it (via
  * `wakeSubscriber`) so the loop can observe `#closed` and exit.
  *
  * @internal
  */
  readonly #wakeReadFd: number;
  /**
  * Set once by `close()` and never reset. Gates `postMessage()` (which throws
  * `InvalidStateError` when true), suppresses delivery of any bytes still in
  * flight, and tells the receive loop to exit and unsubscribe.
  *
  * @internal
  */
  #closed = false;
  #onmessage: ((ev: MessageEvent) => void) | null = null;
  #onmessageerror: ((ev: MessageEvent) => void) | null = null;
  /**
  * Handler invoked for successfully deserialized message events.
  *
  * Assigning a function registers it as an ordinary `message` listener, so it
  * runs in registration order relative to `addEventListener('message', ...)`
  * listeners and is skipped if an earlier listener calls
  * `stopImmediatePropagation()`. Assigning `null` (or any non-function)
  * clears it; reassigning replaces the previous handler.
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
  * The `MessageEvent` dispatched for these failures has `data === null` — the
  * original payload is unrecoverable. This is most likely when serializer
  * versions disagree across Isolates or a raw publisher sends malformed
  * bytes. Assignment semantics match `onmessage`: the handler is a regular
  * `messageerror` listener, and `null` clears it.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('events');
  * bc.onmessageerror = () => console.warn('dropped an undecodable message');
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
  * Subscribe to a named broadcast channel.
  *
  * The name is string-coerced and matched exactly against peer channel names.
  * Construction registers a Rust-side subscriber and starts an asynchronous
  * receive loop on the next microtask, so messages published by peers can
  * arrive as soon as the current turn yields to the event loop; the loop and
  * the subscription are cleaned up by `close()`.
  *
  * Throws a `TypeError` if called with no arguments.
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
  * Read-only; this is the string-coerced constructor argument and remains
  * available after `close()`.
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
  * The message is serialized once, synchronously, then fanned out to every
  * other unclosed channel with the same name — same-Realm peers via the local
  * task queue, cross-Realm peers via the Rust registry. Delivery is always
  * asynchronous, and this channel never receives its own message. Mutating
  * the original value after `postMessage()` returns cannot affect what peers
  * observe.
  *
  * Transfer lists are not supported by BroadcastChannel. Throws
  * `InvalidStateError` if the channel is closed, `TypeError` if called with
  * no arguments, and `DataCloneError` if the value cannot be serialized
  * (functions, symbols, weak collections, and other unsupported
  * structured-clone values).
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
  * After close the channel stops receiving: messages already in flight are
  * discarded on arrival, no further `message` or `messageerror` events fire,
  * and any subsequent `postMessage()` throws `InvalidStateError`. The receive
  * loop is woken so it can remove its read watcher and unsubscribe from the
  * Rust registry. The operation is idempotent — extra calls are no-ops.
  *
  * ```typescript no_run
  * const bc = new BroadcastChannel('jobs');
  * bc.close();
  * bc.close(); // no-op
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
  /**
  * Disposes the channel by calling `close()`.
  *
  * This makes a channel usable with `using` declarations: the subscription is
  * released automatically when the block exits, even on early return or
  * throw. Behavior is identical to calling `close()` directly.
  *
  * ```typescript no_run
  * {
  *   using bc = new BroadcastChannel('scoped');
  *   bc.postMessage('hello');
  * } // closed here
  * ```
  */
  [Symbol.dispose](): void {
    this.close();
  }
  // ---------------------------------------------------------------------------
  // Internal loop
  // ---------------------------------------------------------------------------
  /**
  * Starts `#receiveLoop` from a resolved-promise microtask.
  *
  * Called once by the constructor. Deferring to a microtask guarantees the
  * constructor returns a fully initialized instance before the loop's first
  * `readable()` await can run, while still arming the subscription before the
  * current turn yields to the event loop.
  *
  * @internal
  */
  #startListening(): void {
    // Kick off the async receive loop in a microtask so the constructor returns
    // before any delivery attempt.
    Promise.resolve().then(() => this.#receiveLoop());
  }
  /**
  * Receive loop for messages arriving through the Rust registry.
  *
  * Each iteration awaits the wake pipe via `readable(#wakeReadFd)`, drains
  * every pending payload with `receive(#handle)`, and dispatches each one —
  * dropping registry echoes of this Realm's own messages by sender-id. The
  * loop exits when `close()` sets `#closed` and writes the wake byte, at
  * which point it removes the read watcher and unsubscribes the Rust-side
  * handle. Same-Realm deliveries bypass this loop entirely via the local
  * task queue.
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
  * Deliver serialized bytes queued by a same-Realm peer's `postMessage()`.
  *
  * Invoked by the local flush queue on a later event-loop turn. Bytes are
  * silently dropped if the channel closed while they were queued; envelope
  * deserialization failures dispatch `messageerror` instead of `message`.
  * Same-Realm senders are excluded at enqueue time, so no sender-id check is
  * needed here.
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
