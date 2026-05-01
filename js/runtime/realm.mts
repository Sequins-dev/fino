/**
 * fino:realm — Realm construction and management.
 *
 * A Realm is an isolated V8 Context with its own global object, module graph,
 * microtask queue, and event loop. The parent's import rule list governs every
 * module resolution in the child; the child can layer overrides on top.
 *
 * The import rule list uses last-match-wins semantics. Declare a wildcard
 * first as the baseline and more specific patterns afterwards as overrides.
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
  createProcessContext,
  stepProcessContext,
  processPortSend,
  processPortRecv,
  getProcessSocketFd,
} from 'internal:realm-native';
import {
  MessagePort,
  MessageChannel,
  ThreadPort,
  BaseTransportPort,
  type MessageEvent,
} from '../internal/globals/messaging.mts';
import { readable, removeRead } from 'fino:runtime/loop';
import { serialize as _ser } from 'internal:serializer';
import type { ClusterClient } from 'internal:cluster/client';
import { ClusterPort, getCluster } from 'fino:cluster';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../opentelemetry/common.mts';

// Pre-cache OTel topic instances for realm lifecycle events.
// Gated on hasSubscribers so realms that don't use OTel pay no cost.
const _topicRealmSpawn    = topic(otelRuntimeTopic('realm', 'spawn', 'start'));
const _topicRealmCall     = topic(otelRuntimeTopic('realm', 'call',  'start'));
const _topicRealmCallEnd  = topic(otelRuntimeTopic('realm', 'call',  'end'));

// ---------------------------------------------------------------------------
// Import rule types
// ---------------------------------------------------------------------------

/** Wire-format representation of an ImportDirective, matching Rust's serde layout. */
export type ImportDirectiveSer =
  | 'inherit'
  | 'block'
  | { type: 'inherit' }
  | { type: 'block' }
  | { type: 'remap'; target: string }
  | { type: 'source'; code: string; source_map: string }
  | { type: 'facade'; specifier: string; exports: string[] };

export interface ImportRule {
  /** Pattern matching the importing module's specifier. Absent = all modules. */
  from?: string;
  /** Pattern matching the specifier being imported. */
  pattern: string;
  directive: ImportDirectiveSer;
}

/** Normalise a user-facing directive value to the Rust wire format. */
function normaliseDirective(d: ImportDirectiveSer): { type: string; [k: string]: unknown } {
  if (d === 'inherit') return { type: 'inherit' };
  if (d === 'block')   return { type: 'block' };
  if (typeof d === 'object' && 'type' in d) return d as { type: string; [k: string]: unknown };
  return { type: 'inherit' };
}

/** Serialise a rule array to the JSON string the Rust bridge expects. */
function serialiseRules(rules: ImportRule[]): string {
  return JSON.stringify(rules.map(r => ({
    ...(r.from !== undefined ? { from: r.from } : {}),
    pattern: r.pattern,
    directive: normaliseDirective(r.directive),
  })));
}

// ---------------------------------------------------------------------------
// ImportMap — helper for building the child-specific rule list
// ---------------------------------------------------------------------------

/**
 * An ordered list of import rules to apply to a child Realm.
 *
 * Rules are last-match-wins. Use `ImportMap.deny([...overrides])` to start
 * with a block-all baseline and punch specific exceptions, or
 * `ImportMap.inherit([...overrides])` to inherit all and restrict specifics.
 *
 * The rules in this object are the *child-specific* overrides that are appended
 * after the parent's rules. The parent's rules always form the baseline.
 */
export class ImportMap {
  readonly #rules: ImportRule[];

  constructor(rules: ImportRule[]) {
    this.#rules = rules;
  }

  /**
   * Deny everything by default; allow/remap/facade specific specifiers.
   *
   * The wildcard `{ pattern: '*', directive: 'block' }` is prepended, then
   * the caller's overrides follow (each overrides the wildcard for its pattern).
   */
  static deny(overrides: ImportRule[]): ImportMap {
    return new ImportMap([{ pattern: '*', directive: 'block' }, ...overrides]);
  }

  /**
   * Inherit everything from the parent by default; restrict specific specifiers.
   *
   * The wildcard `{ pattern: '*', directive: 'inherit' }` is prepended; the
   * caller's overrides follow. Effectively a no-op wildcard (Inherit is
   * dropped on the Rust side), but makes the intent explicit in code.
   */
  static inherit(overrides: ImportRule[]): ImportMap {
    return new ImportMap([{ pattern: '*', directive: 'inherit' }, ...overrides]);
  }

  /** @internal */
  toRules(): ImportRule[] { return this.#rules; }
}

// ---------------------------------------------------------------------------
// Facade — RPC-backed virtual module interface
// ---------------------------------------------------------------------------

/**
 * Describes a module interface backed by the parent's live implementation.
 *
 * When a child Realm imports the named specifier, it gets a synthetic proxy
 * whose calls forward to the parent's registered handlers via `internal:parent-rpc`.
 *
 * Supported for thread and process realms. Handler dispatch is wired in the
 * `Realm` constructor via `_bind()`, which registers a `message` listener on
 * the realm's port that intercepts `__rpc_req` envelopes.
 */
export class Facade {
  readonly #specifier: string;
  readonly #exports: string[];
  readonly #handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  constructor(specifier: string, exports: string[]) {
    this.#specifier = specifier;
    this.#exports = exports;
  }

  static from(obj: object, opts: { specifier: string }): Facade {
    const exports = Object.getOwnPropertyNames(Object.getPrototypeOf(obj))
      .filter(k => k !== 'constructor' && typeof (obj as Record<string, unknown>)[k] === 'function');
    const f = new Facade(opts.specifier, exports);
    for (const name of exports) {
      f.handle(name, (...args) => (obj as Record<string, unknown>)[name](...args) as Promise<unknown>);
    }
    return f;
  }

  handle(method: string, fn: (...args: unknown[]) => Promise<unknown>): this {
    this.#handlers.set(method, fn);
    return this;
  }

  /** @internal */
  toDirective(): ImportDirectiveSer {
    return { type: 'facade', specifier: this.#specifier, exports: this.#exports };
  }

  /**
   * Wire up the parent-side RPC dispatcher on the given port.
   *
   * Registers a `message` listener that intercepts `__rpc_req` messages from
   * the child and dispatches them to the registered handlers.  The response
   * (`__rpc_res`) is sent back via `port.postMessage`.
   *
   * @internal
   */
  _bind(port: MessagePort | ThreadPort | ProcessPort | ClusterPort): void {
    const specifier = this.#specifier;
    const handlers  = this.#handlers;

    port.addEventListener('message', function onRpcRequest(ev: Event) {
      const msg = (ev as MessageEvent).data;
      if (
        msg === null ||
        typeof msg !== 'object' ||
        (msg as any).__rpc_req !== true ||
        (msg as any).specifier !== specifier
      ) {
        return;
      }

      // Prevent other listeners from seeing this RPC message.
      (ev as MessageEvent).stopImmediatePropagation?.();

      const { method, reqId, args } = msg as {
        method: string;
        reqId: number;
        args: unknown[];
      };

      const handler = handlers.get(method);
      if (!handler) {
        port.postMessage({ __rpc_res: true, reqId, error: `No handler for ${specifier}#${method}` });
        return;
      }

      (new Promise<unknown>((res) => res(handler(...args)))).then(
        (result) => port.postMessage({ __rpc_res: true, reqId, result }),
        (err: unknown) => port.postMessage({ __rpc_res: true, reqId, error: String(err) }),
      );
    } as EventListener);

    port.start();
  }
}

// ---------------------------------------------------------------------------
// Legacy provider config classes (kept for backwards compatibility)
// ---------------------------------------------------------------------------

export interface DiskFsOptions {
  root?: string;
}

/** Use the real on-disk filesystem for this Realm (system default). */
export class DiskFsConfig {
  readonly type = 'disk' as const;
  readonly options: DiskFsOptions;

  constructor(options: DiskFsOptions = {}) { this.options = options; }

  toJSON(): Record<string, unknown> { return { type: this.type, ...this.options }; }
  static fromJSON(json: Record<string, unknown>): DiskFsConfig {
    return new DiskFsConfig({ root: json['root'] as string | undefined });
  }

  /** @internal */
  toRules(): ImportRule[] {
    // Empty source_map + empty code would have reset to BUILTINS in the old
    // system. In the new system we emit Inherit, which drops from the child
    // specific list so the parent's rule applies (same effect for root realms).
    return [{ pattern: 'internal:file/bindings', directive: 'inherit' }];
  }
}

/** Use the system network stack for this Realm (system default). */
export class SystemNetConfig {
  readonly type = 'system-net' as const;

  toJSON(): Record<string, unknown> { return { type: this.type }; }
  static fromJSON(_json: Record<string, unknown>): SystemNetConfig { return new SystemNetConfig(); }

  /** @internal */
  toRules(): ImportRule[] {
    return [{ pattern: 'internal:net/provider', directive: 'inherit' }];
  }
}

/** Use the system DNS resolver for this Realm (system default). */
export class SystemDnsConfig {
  readonly type = 'system-dns' as const;

  toJSON(): Record<string, unknown> { return { type: this.type }; }
  static fromJSON(_json: Record<string, unknown>): SystemDnsConfig { return new SystemDnsConfig(); }

  /** @internal */
  toRules(): ImportRule[] {
    return [{ pattern: 'internal:net/dns-provider', directive: 'inherit' }];
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
  /**
   * Import rules for this Realm. Appended after the parent's rules;
   * last-match-wins. Use `ImportMap.deny([...])` or `ImportMap.inherit([...])`.
   */
  overrides?: ImportMap | ImportRule[];
  /**
   * @deprecated Use `overrides` with explicit ImportRule entries instead.
   * Override specific I/O providers. Unspecified providers are inherited.
   */
  providers?: RealmProviders;
  /**
   * @deprecated Use `overrides` with `{ pattern, directive: 'block' }` instead.
   * Module specifiers that should throw on import in the child Realm.
   */
  blocked?: string[];
  /**
   * If true, spawn the child Realm on a separate OS thread with its own
   * V8 Isolate. Messaging uses V8 ValueSerializer over Rust mpsc channels
   * instead of same-Isolate structured clone.
   */
  thread?: boolean;
  /**
   * If true, spawn the child Realm as a separate OS process for hard crash
   * isolation. Messaging uses framed binary over a Unix socketpair.
   * Mutually exclusive with `thread`.
   */
  process?: boolean;
  /**
   * If true, spawn the child Realm on a remote cluster node. Requires a
   * prior call to `startCluster()` or `joinCluster()` from `fino:cluster`.
   * Messaging uses the cluster PORT_MSG protocol over WebSocket.
   * Mutually exclusive with `thread` and `process`.
   */
  remote?: boolean;
  /**
   * Parent-side MessagePort for communication with the child.
   * Ignored when `thread: true` or `process: true`.
   */
  input?: MessagePort;
  /**
   * Child-side MessagePort passed into the child Realm.
   * Must be provided together with `input`.
   * Ignored when `thread: true` or `process: true`.
   */
  output?: MessagePort;
}

// ---------------------------------------------------------------------------
// Entry function type constraint
// ---------------------------------------------------------------------------

export type RealmFn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// ProcessPort — cross-process transport (mirrors ThreadPort)
// ---------------------------------------------------------------------------

/**
 * ProcessPort wraps the process realm native functions with the same event-loop
 * integration as ThreadPort: register the wake-fd with loop.readable(), drain
 * messages on each wake, dispatch as MessageEvents.
 */
export class ProcessPort extends BaseTransportPort {
  #wakeReadFd: number;
  #handle: number;

  constructor(wakeReadFd: number, handle: number) {
    super();
    this.#wakeReadFd = wakeReadFd;
    this.#handle     = handle;
  }

  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this._closed) return;
    const rawTransfer = Array.isArray(transferOrOpts)
      ? (transferOrOpts as Transferable[])
      : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const transferABs = (rawTransfer?.filter((t) => t instanceof ArrayBuffer) ?? []) as ArrayBuffer[];
    const serResult = (_ser as (v: unknown, t?: ArrayBuffer[]) => Uint8Array[])(
      message, transferABs.length > 0 ? transferABs : undefined,
    );
    const data   = serResult[0];
    const stores = serResult.length > 1 ? serResult.slice(1) : ([] as Uint8Array[]);
    (processPortSend as (h: number, b: Uint8Array, s: Uint8Array[]) => void)(this.#handle, data, stores);
  }

  protected override _onStart(): void { this.#watchLoop(); }
  protected override _onClose(): void { removeRead(this.#wakeReadFd); }

  async #watchLoop(): Promise<void> {
    while (!this._closed) {
      await readable(this.#wakeReadFd);
      if (this._closed) break;
      this._drain();
    }
  }

  _drain(): void {
    for (const byteArr of _recvProcessMessages(this.#handle)) {
      const [buf, ...stores] = byteArr;
      if (!buf) continue;
      this._dispatchMessage(buf, stores.length > 0 ? stores : undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Active children tracking
// ---------------------------------------------------------------------------

type RealmKind = 'embedded' | 'thread' | 'process' | 'remote';

let _nextPortHandle = 0;

interface ActiveChild {
  handle: number;
  kind: RealmKind;
  resolve: () => void;
  reject: (err: unknown) => void;
  clusterPort?: ClusterPort;
}

const _activeChildren: ActiveChild[] = [];

/** Step all active child Realms by one iteration. @internal */
export function _stepChildren(): void {
  for (let i = _activeChildren.length - 1; i >= 0; i--) {
    const child = _activeChildren[i]!;
    if (child.kind === 'remote') continue; // driven by cluster transport, not stepped
    let alive: boolean;
    let stepError: unknown = undefined;
    if (child.kind === 'thread') {
      try { alive = stepThreadContext(child.handle) as boolean; }
      catch (err) { alive = false; stepError = err; }
    } else if (child.kind === 'process') {
      try { alive = stepProcessContext(child.handle) as boolean; }
      catch (err) { alive = false; stepError = err; }
    } else {
      alive = stepContext(child.handle) as boolean;
    }
    if (!alive) {
      if (stepError !== undefined) { child.reject(stepError); } else { child.resolve(); }
      _activeChildren.splice(i, 1);
    }
  }
}

/** Returns true if any child Realms are still running. @internal */
export function _childrenAlive(): boolean {
  return _activeChildren.length > 0;
}

// ---------------------------------------------------------------------------
// Native bridge helpers
// ---------------------------------------------------------------------------

/** Drain one batch from a process-port receive queue: `[[mainBytes, ...stores], ...]`. */
function _recvProcessMessages(handle: number): Uint8Array[][] {
  return (processPortRecv as (h: number) => unknown)(handle) as Uint8Array[][];
}

// ---------------------------------------------------------------------------
// call() response helpers
// ---------------------------------------------------------------------------

/**
 * Decode a `{ __call_error, message?, stack? }` response or resolve with
 * the raw data value. Centralised to avoid duplicating the error-extraction
 * block across the remote and non-remote `call()` branches.
 */
function _resolveCallResponse<R>(
  data: unknown,
  resolve: (v: R) => void,
  reject: (err: unknown) => void,
): void {
  if (data && typeof data === 'object' && (data as { __call_error?: boolean }).__call_error) {
    const d = data as { message?: string; stack?: string };
    const err = new Error(d.message ?? 'Realm call failed');
    if (d.stack !== undefined) err.stack = d.stack;
    reject(err);
  } else {
    resolve(data as R);
  }
}

// ---------------------------------------------------------------------------
// Realm class
// ---------------------------------------------------------------------------

export class Realm<F extends RealmFn = RealmFn> {
  readonly #handle: number;
  readonly #kind: RealmKind;
  /** Parent-side port for general communication with the child Realm. */
  readonly port: MessagePort | ThreadPort | ProcessPort | ClusterPort;
  /** Pending spawn for remote realms; resolves to childPortId after SPAWN_ACK. */
  #spawnPromise: Promise<string> | null = null;

  constructor(opts: RealmOptions) {
    // Build the child-specific rule list from overrides / legacy providers+blocked.
    const rules: ImportRule[] = [];
    if (opts.overrides) {
      const src = opts.overrides instanceof ImportMap ? opts.overrides.toRules() : opts.overrides;
      rules.push(...src);
    } else {
      if (opts.providers) {
        const { fs, net, dns } = opts.providers;
        if (fs)  rules.push(...fs.toRules());
        if (net) rules.push(...net.toRules());
        if (dns) rules.push(...dns.toRules());
      }
      if (opts.blocked) {
        for (const spec of opts.blocked) rules.push({ pattern: spec, directive: 'block' });
      }
    }
    const serializedRules = rules.length > 0 ? serialiseRules(rules) : '[]';

    if (opts.remote) {
      const cluster = getCluster();
      if (!cluster) {
        throw new Error('fino:realm — remote: true requires an active cluster; call startCluster() or joinCluster() first');
      }
      this.#kind   = 'remote';
      this.#handle = -1;
      const portId      = `${cluster.nodeId}/p-${_nextPortHandle++}`;
      const clusterPort = new ClusterPort(portId, cluster);
      this.port = clusterPort;
      const config = { entry: opts.entry, root: opts.root ?? '', rules: JSON.parse(serializedRules) };
      this.#spawnPromise = cluster.spawnRemote(portId, config).then((childPortId: string) => {
        clusterPort._setChildPortId(childPortId);
        return childPortId;
      });
    } else if (opts.process) {
      this.#kind = 'process';
      const handle = createProcessContext(opts.root ?? '', opts.entry, serializedRules) as number;
      this.#handle = handle;
      const wakeReadFd = getProcessSocketFd(handle) as number;
      this.port = new ProcessPort(wakeReadFd, handle);
    } else if (opts.thread) {
      this.#kind = 'thread';
      const handle = createThreadContext(opts.root ?? '', opts.entry, serializedRules) as number;
      this.#handle = handle;
      const wakeReadFd = getThreadPortWakeReadFd(handle) as number;
      this.port = new ThreadPort(wakeReadFd, handle);
    } else {
      this.#kind = 'embedded';
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
      this.#handle = createContext(opts.root ?? '', opts.entry, serializedRules, childPort) as number;
    }

    // Bind any Facade overrides so the parent-side RPC dispatcher is wired up.
    if (this.#kind !== 'embedded' && rules.length > 0) {
      const port = this.port as ThreadPort | ProcessPort | ClusterPort;
      for (const rule of rules) {
        if (rule.directive instanceof Facade) {
          (rule.directive as Facade)._bind(port);
        }
      }
    }

    // Emit OTel realm spawn event (gated on hasSubscribers to avoid cost in
    // the common case where no OTel subscriber is registered).
    if (_topicRealmSpawn.hasSubscribers) {
      _topicRealmSpawn.publish(otelRuntimeEvent('realm', 'spawn', 'start', {
        kind: this.#kind,
        entry: opts.entry,
      }));
    }
  }

  /** Run the child Realm to completion. */
  run(): Promise<void> {
    if (this.#kind === 'remote') {
      const clusterPort = this.port as ClusterPort;
      const cluster = getCluster()!;
      return (this.#spawnPromise ?? Promise.resolve('')).then(
        (childPortId: string) => new Promise<void>((resolve, reject) => {
          const entry: ActiveChild = {
            handle: -1,
            kind: 'remote',
            resolve,
            reject,
            clusterPort,
          };
          _activeChildren.push(entry);
          cluster.onRealmExit(childPortId, (error?: string) => {
            const idx = _activeChildren.indexOf(entry);
            if (idx >= 0) _activeChildren.splice(idx, 1);
            if (error) reject(new Error(error)); else resolve();
          });
        }),
      );
    }
    return new Promise<void>((resolve, reject) => {
      _activeChildren.push({ handle: this.#handle, kind: this.#kind, resolve, reject });
    });
  }

  /**
   * Call the child Realm's default-exported function with `args`.
   */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    const callStart = performance.now();
    const kind = this.#kind;
    // Capture at call time so the end event is always published when start was.
    const startPublished = _topicRealmCall.hasSubscribers;
    if (startPublished) {
      _topicRealmCall.publish(otelRuntimeEvent('realm', 'call', 'start', { kind }));
    }

    let base: Promise<Awaited<ReturnType<F>>>;
    if (kind === 'remote') {
      const clusterPort = this.port as ClusterPort;
      const cluster = getCluster()!;
      base = (this.#spawnPromise ?? Promise.resolve('')).then(
        (childPortId: string) => new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
          const entry: ActiveChild = {
            handle: -1,
            kind: 'remote',
            resolve: () => {},
            reject: (err: unknown) => reject(err),
            clusterPort,
          };
          _activeChildren.push(entry);
          cluster.onRealmExit(childPortId, (error?: string) => {
            const idx = _activeChildren.indexOf(entry);
            if (idx >= 0) _activeChildren.splice(idx, 1);
            if (error) reject(new Error(error));
          });
          const handler = (ev: unknown) => {
            const data = (ev as { data?: unknown }).data;
            clusterPort.removeEventListener('message', handler as any);
            clusterPort.close();
            _resolveCallResponse(data, resolve, reject);
          };
          clusterPort.addEventListener('message', handler as any);
          clusterPort.start();
          clusterPort.postMessage({ __call: true, args });
        }),
      );
    } else {
      base = new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
        _activeChildren.push({
          handle: this.#handle,
          kind,
          resolve: () => {},
          reject: (err: unknown) => reject(err),
        });
        const handler = (ev: Event) => {
          const data = (ev as MessageEvent).data;
          this.port.removeEventListener('message', handler);
          this.port.close();
          _resolveCallResponse(data, resolve, reject);
        };
        this.port.addEventListener('message', handler);
        this.port.start();
        this.port.postMessage({ __call: true, args });
      });
    }

    if (!startPublished && !_topicRealmCallEnd.hasSubscribers) return base;
    return base.then(
      (result) => {
        _topicRealmCallEnd.publish(otelRuntimeEvent('realm', 'call', 'end', { kind, durationMs: performance.now() - callStart }));
        return result;
      },
      (err: unknown) => {
        _topicRealmCallEnd.publish(otelRuntimeEvent('realm', 'call', 'end', { kind, durationMs: performance.now() - callStart, error: true }));
        throw err;
      },
    );
  }

  /** Signal the child Realm to stop. */
  terminate(): void {
    if (this.#kind === 'remote') {
      this.port.postMessage({ __terminate: true });
      this.port.close();
    } else if (this.#kind === 'thread' || this.#kind === 'process') {
      this.port.postMessage({ __terminate: true });
      this.port.close();
    } else {
      terminateChild(this.#handle);
    }
  }

  /** Explicit resource management. */
  [Symbol.dispose](): void { this.terminate(); }
}
