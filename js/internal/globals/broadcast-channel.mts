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

export class BroadcastChannel extends EventTarget {
  readonly #name: string;
  readonly #handle: number;
  readonly #wakeReadFd: number;
  #closed = false;

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;

  constructor(name: string) {
    super();
    this.#name = String(name);
    const info = subscribe(this.#name) as { handle: number; wakeReadFd: number };
    this.#handle = info.handle;
    this.#wakeReadFd = info.wakeReadFd;
    this.#startListening();
  }

  get name(): string {
    return this.#name;
  }

  postMessage(message: unknown): void {
    if (this.#closed) throw new Error('BroadcastChannel is closed');
    // serialize() returns [mainBytes, ...transferStores]; BroadcastChannel
    // does not support transfer, so we only need the main bytes.
    const serResult = (serialize as (v: unknown) => Uint8Array[])(message);
    publish(this.#name, serResult[0]!, this.#handle);
  }

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

  #startListening(): void {
    // Kick off the async receive loop in a microtask so the constructor returns
    // before any delivery attempt.
    Promise.resolve().then(() => this.#receiveLoop());
  }

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
