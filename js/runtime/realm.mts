/**
 * fino:realm — Realm construction and management.
 *
 * A Realm is an isolated V8 Context with its own global object, module graph,
 * microtask queue, and event loop. Each Realm inherits the parent's I/O
 * provider configuration by default; explicit provider configs override or
 * reset individual providers.
 *
 * Provider config objects are serialisable builder classes so they can be
 * transmitted to remote Realms (cross-process / cross-machine) in a future step.
 */

import {
  createContext,
  stepContext,
  terminateChild,
  createThreadContext,
  stepThreadContext,
  threadPortSend,
  threadPortRecv,
  getThreadPortWakeReadFd,
} from 'internal:realm-native';
import {
  MessagePort,
  MessageChannel,
  ThreadPort,
  type MessageEvent,
} from '../internal/globals/messaging.mts';

// ---------------------------------------------------------------------------
// Provider config classes
// ---------------------------------------------------------------------------

export interface DiskFsOptions {
  root?: string;
}

/**
 * Use the real on-disk filesystem for this Realm.
 *
 * This is the system default — specifying it explicitly clears any virtual
 * filesystem the parent may have installed, resetting to the real disk.
 */
export class DiskFsConfig {
  readonly type = 'disk' as const;
  readonly options: DiskFsOptions;

  constructor(options: DiskFsOptions = {}) {
    this.options = options;
  }

  toJSON(): Record<string, unknown> {
    return { type: this.type, ...this.options };
  }

  static fromJSON(json: Record<string, unknown>): DiskFsConfig {
    return new DiskFsConfig({ root: json['root'] as string | undefined });
  }

  /** @internal */
  _toOverrideEntries(): [string, string, string][] {
    // An empty code string signals the Rust layer to *remove* the inherited
    // override for this specifier, falling back to the compiled-in default.
    return [['internal:file/bindings', '', '']];
  }
}

/**
 * Use the system network stack for this Realm.
 *
 * This is the system default — specifying it explicitly clears any virtual
 * network provider the parent may have installed.
 */
export class SystemNetConfig {
  readonly type = 'system-net' as const;

  toJSON(): Record<string, unknown> {
    return { type: this.type };
  }

  static fromJSON(_json: Record<string, unknown>): SystemNetConfig {
    return new SystemNetConfig();
  }

  /** @internal */
  _toOverrideEntries(): [string, string, string][] {
    return [['internal:net/provider', '', '']];
  }
}

/**
 * Use the system DNS resolver for this Realm.
 *
 * This is the system default — specifying it explicitly clears any virtual
 * DNS provider the parent may have installed.
 */
export class SystemDnsConfig {
  readonly type = 'system-dns' as const;

  toJSON(): Record<string, unknown> {
    return { type: this.type };
  }

  static fromJSON(_json: Record<string, unknown>): SystemDnsConfig {
    return new SystemDnsConfig();
  }

  /** @internal */
  _toOverrideEntries(): [string, string, string][] {
    return [['internal:net/dns-provider', '', '']];
  }
}

// ---------------------------------------------------------------------------
// Realm options
// ---------------------------------------------------------------------------

export interface RealmProviders {
  fs?: DiskFsConfig;
  net?: SystemNetConfig;
  dns?: SystemDnsConfig;
}

export interface RealmOptions {
  /** Path to the entry module to evaluate in the child Realm. */
  entry: string;
  /** Filesystem root for module resolution. Inherits from parent if omitted. */
  root?: string;
  /** Override specific I/O providers. Unspecified providers are inherited. */
  providers?: RealmProviders;
  /** Module specifiers that should throw on import in the child Realm. */
  blocked?: string[];
  /**
   * If true, spawn the child Realm on a separate OS thread with its own
   * V8 Isolate. Messaging uses V8 ValueSerializer over Rust mpsc channels
   * instead of same-Isolate structured clone.
   */
  thread?: boolean;
  /**
   * Parent-side MessagePort for communication with the child.
   * If omitted (along with `output`), a MessageChannel is created
   * automatically and `realm.port` is the parent-side end.
   * Ignored when `thread: true` — a ThreadPort is created automatically.
   */
  input?: MessagePort;
  /**
   * Child-side MessagePort passed into the child Realm.
   * Must be provided together with `input` if using custom ports.
   * If omitted, the auto-created channel's `port2` is used.
   * Ignored when `thread: true`.
   */
  output?: MessagePort;
}

// ---------------------------------------------------------------------------
// Entry function type constraint
// ---------------------------------------------------------------------------

/**
 * Constraint for the default-exported function of a Realm entry module.
 *
 * Pass this as the type parameter to `Realm<F>` or `RealmPool<F>` to connect
 * the entry module's signature to `call()`:
 *
 * ```ts
 * import type myWorker from './my-worker.mts';
 * const realm = new Realm<typeof myWorker>({ thread: true, entry: '...' });
 * await realm.call(1, 2);  // args and return type checked
 * ```
 */
export type RealmFn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Active children tracking
// ---------------------------------------------------------------------------

interface ActiveChild {
  handle: number;
  thread?: boolean;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const _activeChildren: ActiveChild[] = [];

/**
 * Step all active child Realms by one iteration.
 * Called by the parent's driveLoop on each tick.
 * @internal
 */
export function _stepChildren(): void {
  for (let i = _activeChildren.length - 1; i >= 0; i--) {
    const child = _activeChildren[i]!;
    let alive: boolean;
    let stepError: unknown = undefined;
    if (child.thread) {
      try {
        alive = stepThreadContext(child.handle) as boolean;
      } catch (err) {
        alive = false;
        stepError = err;
      }
    } else {
      alive = stepContext(child.handle) as boolean;
    }
    if (!alive) {
      if (stepError !== undefined) {
        child.reject(stepError);
      } else {
        child.resolve();
      }
      _activeChildren.splice(i, 1);
    }
  }
}

/**
 * Returns true if any child Realms are still running.
 * Used by driveLoop to decide whether to keep the parent alive.
 * @internal
 */
export function _childrenAlive(): boolean {
  return _activeChildren.length > 0;
}

// ---------------------------------------------------------------------------
// Realm class
// ---------------------------------------------------------------------------

export class Realm<F extends RealmFn = RealmFn> {
  readonly #handle: number;
  readonly #thread: boolean;
  /** Parent-side port for general communication with the child Realm. */
  readonly port: MessagePort | ThreadPort;

  /**
   * Create and bootstrap a new child Realm.
   *
   * For embedded realms (`thread` omitted or false): queues a deferred context
   * creation (the V8 Context is constructed between host-loop iterations).
   * For thread realms (`thread: true`): spawns an OS thread immediately with
   * its own V8 Isolate. Communication via `realm.port` uses ValueSerializer.
   *
   * A MessageChannel is always created for embedded realms (or the provided
   * `input`/`output` ports are used). For thread realms, a `ThreadPort` is
   * created automatically and exposed as `realm.port`.
   */
  constructor(opts: RealmOptions) {
    const overrideEntries: [string, string, string][] = [];

    if (opts.providers) {
      const { fs, net, dns } = opts.providers;
      if (fs) overrideEntries.push(...fs._toOverrideEntries());
      if (net) overrideEntries.push(...net._toOverrideEntries());
      if (dns) overrideEntries.push(...dns._toOverrideEntries());
    }

    const blockedSpecifiers: string[] = opts.blocked ?? [];

    this.#thread = opts.thread ?? false;

    if (this.#thread) {
      // Thread realm: spawn on a new OS thread with its own Isolate.
      const handle = createThreadContext(
        opts.root ?? '',
        opts.entry,
        overrideEntries,
        blockedSpecifiers,
      ) as number;
      this.#handle = handle;

      // Construct the parent-side ThreadPort backed by the native channel.
      const wakeReadFd = getThreadPortWakeReadFd(handle) as number;
      const parentPort = new ThreadPort(wakeReadFd, handle);
      this.port = parentPort;
    } else {
      // Embedded realm: deferred same-Isolate context creation.
      let parentPort: MessagePort;
      let childPort: MessagePort;
      if (opts.input !== undefined && opts.output !== undefined) {
        parentPort = opts.input;
        childPort  = opts.output;
      } else {
        const channel = new MessageChannel();
        parentPort = channel.port1;
        childPort  = channel.port2;
      }
      this.port = parentPort;

      this.#handle = createContext(
        opts.root ?? '',
        opts.entry,
        overrideEntries,
        blockedSpecifiers,
        childPort,
      ) as number;
    }
  }

  /**
   * Run the child Realm to completion.
   *
   * The parent's driveLoop will interleave child steps with each parent tick.
   * The Promise resolves once the child's event loop drains naturally or
   * `terminate()` is called.
   */
  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      _activeChildren.push({ handle: this.#handle, thread: this.#thread, resolve, reject });
    });
  }

  /**
   * Call the child Realm's default-exported function with `input`.
   *
   * Sends `{ __call: true, data: input }` via the realm's MessagePort and
   * waits for a single response message. The child's bootstrap automatically
   * wires this up when the entry module default-exports a function.
   *
   * Rejects if the child throws or if `terminate()` is called before the
   * response arrives.
   */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    return new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
      // Register child for stepping so it gets ticked.
      _activeChildren.push({
        handle: this.#handle,
        thread: this.#thread,
        resolve: () => {},
        reject: (err: unknown) => reject(err),
      });

      // Listen for the single response message.
      const handler = (ev: Event) => {
        const data = (ev as MessageEvent).data;
        this.port.removeEventListener('message', handler);
        // Close the port so its wake-pipe watcher is removed from the event
        // loop — otherwise alive() stays true after the thread exits.
        this.port.close();
        if (data && typeof data === 'object' && (data as { __call_error?: boolean }).__call_error) {
          const d = data as { message?: string; stack?: string };
          const err = new Error(d.message ?? 'Realm call failed');
          if (d.stack !== undefined) err.stack = d.stack;
          reject(err);
        } else {
          resolve(data as Awaited<ReturnType<F>>);
        }
      };
      this.port.addEventListener('message', handler);
      this.port.start();

      // Send the call request — args is a plain array, spread on the child side.
      this.port.postMessage({ __call: true, args });
    });
  }

  /**
   * Signal the child Realm to stop.
   *
   * For embedded realms: sets the `terminated` flag directly on the child's
   * FinoState (checked by `isTerminated()` from `internal:realm-bridge`).
   *
   * For thread realms: sends `{ __terminate: true }` via the port. The child's
   * bootstrap handles this message and sets its `_childDone` flag.
   */
  terminate(): void {
    if (this.#thread) {
      this.port.postMessage({ __terminate: true });
      // Close the parent-side port so its wake-pipe readable() watcher is
      // removed from the event loop — otherwise alive() stays true after
      // the thread exits and the process never exits cleanly.
      this.port.close();
    } else {
      terminateChild(this.#handle);
    }
  }

  /** Explicit resource management — same as `terminate()`. */
  [Symbol.dispose](): void {
    this.terminate();
  }
}
