/**
 * BroadcastChannel — WHATWG-compatible one-to-many pub/sub across Realms.
 *
 * Same-Realm and cross-Isolate delivery both flow through the Rust-side global
 * registry (`internal:broadcast`).  The registry fans out serialised message
 * bytes to every subscriber on the same channel name, excluding the sender.
 *
 * Delivery is always asynchronous: a wake pipe registered with `loop.readable`
 * is used to defer delivery to the next event-loop turn.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { BroadcastChannel } from 'internal:globals/broadcast-channel';
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
 * @internal
 */

import { Event, EventTarget } from './eventtarget.mts';
import { serialize, deserialize } from 'internal:serializer';
import { subscribe, publish, receive, unsubscribe, wakeSubscriber } from 'internal:broadcast';
import { readable, removeRead } from 'internal:runtime/loop';
import { MessageEvent } from './messaging.mts';

// ---------------------------------------------------------------------------
// BroadcastChannel
// ---------------------------------------------------------------------------

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
  onmessage: ((ev: MessageEvent) => void) | null = null;

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
  onmessageerror: ((ev: MessageEvent) => void) | null = null;

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
    super();
    this.#name = String(name);
    const info = subscribe(this.#name) as { handle: number; wakeReadFd: number };
    this.#handle = info.handle;
    this.#wakeReadFd = info.wakeReadFd;
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
   * close() throws an Error. Serialization failures propagate to the caller.
   *
   * ```typescript no_run
   * const bc = new BroadcastChannel('jobs');
   * bc.postMessage({ id: 1, state: 'ready' });
   * ```
   */
  postMessage(message: unknown): void {
    if (this.#closed) throw new Error('BroadcastChannel is closed');
    // serialize() returns [mainBytes, ...transferStores]; BroadcastChannel
    // does not support transfer, so we only need the main bytes.
    const serResult = (serialize as (v: unknown) => Uint8Array[])(message);
    publish(this.#name, serResult[0]!, this.#handle);
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
    // Write a byte to our own wake pipe so that any pending readable() call
    // in #receiveLoop resolves immediately.  The loop checks #closed after
    // waking and exits, then calls unsubscribe() to clean up the Rust side.
    wakeSubscriber(this.#handle);
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
        let data: unknown;
        let deserError = false;
        try {
          data = deserialize(bytes);
        } catch {
          deserError = true;
        }

        if (deserError) {
          const ev = new MessageEvent('messageerror', { data: null });
          this.dispatchEvent(ev);
          this.onmessageerror?.(ev);
          continue;
        }

        const ev = new MessageEvent('message', { data });
        this.dispatchEvent(ev);
        this.onmessage?.(ev);
      }
    }
    // Loop exited — clean up the Rust subscription and any residual watcher.
    removeRead(this.#wakeReadFd);
    unsubscribe(this.#handle);
  }
}
