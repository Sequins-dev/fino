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
} from '../../internal/globals/messaging.mts';
import { readable, removeRead } from 'fino:runtime/loop';
import { serialize as _ser } from 'internal:serializer';
import type { ClusterClient } from 'internal:cluster/client';
import { ClusterPort, getCluster } from 'fino:cluster';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../../internal/opentelemetry/common.mts';

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
  | { type: 'facade'; specifier: string; exports: string[]; streams?: string[]; sinks?: string[] };

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
  if (d instanceof Facade) return d.toDirective() as { type: string; [k: string]: unknown };
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
 */
function _isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return v != null && typeof v === 'object' && Symbol.asyncIterator in (v as object);
}

// ---------------------------------------------------------------------------
// FacadeHandle — stateful handle returned from Facade handlers
// ---------------------------------------------------------------------------

/**
 * A stateful object handle returned from a Facade handler.
 *
 * When a scalar handler returns a `FacadeHandle`, the parent registers its
 * methods under a unique ID and sends `{ __handle: id, streams?: [...] }` to
 * the child.  The child receives a Proxy that routes subsequent method calls
 * back through `internal:parent-rpc` using the handle ID as the specifier.
 *
 * ```ts
 * facade.handle('open', async (path) => {
 *   const fh = await realFs.open(path, 'r');
 *   return new FacadeHandle(
 *     { stat: () => fh.stat(), close: () => fh.close() },
 *     { read: (_size) => fh.reader() },   // streaming method
 *   );
 * });
 * ```
 */
export class FacadeHandle {
  readonly #scalar:  Map<string, (...args: unknown[]) => unknown>;
  readonly #streams: Map<string, (...args: unknown[]) => AsyncIterable<unknown>>;
  readonly #sinks:   Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>;

  constructor(
    scalar:  Record<string, (...args: unknown[]) => unknown>                                         = {},
    streams: Record<string, (...args: unknown[]) => AsyncIterable<unknown>>                          = {},
    sinks:   Record<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>   = {},
  ) {
    this.#scalar  = new Map(Object.entries(scalar));
    this.#streams = new Map(Object.entries(streams));
    this.#sinks   = new Map(Object.entries(sinks));
  }

  /** @internal */ _scalar()     { return this.#scalar;  }
  /** @internal */ _streams()    { return this.#streams; }
  /** @internal */ _sinks()      { return this.#sinks;   }
  /** @internal */ _streamNames() { return [...this.#streams.keys()]; }
  /** @internal */ _sinkNames()   { return [...this.#sinks.keys()]; }
}

// ---------------------------------------------------------------------------
// Per-port write-stream (sink) source queues
//
// When the child calls callSink(), it sends __rpc_send_start.  The parent
// creates a _WriteSource that acts as the `source: AsyncIterable` argument to
// the handler.  Subsequent __rpc_send_chunk messages push into the queue;
// __rpc_send_end / __rpc_send_err close or fail it.
//
// This is the symmetric counterpart to _StreamQueue in parent-rpc.mts (which
// buffers chunks flowing parent→child).  The pairing maps directly onto QUIC:
//   _WriteSource  ←  QUIC client-initiated unidirectional stream (child sends)
//   _StreamQueue  ←  QUIC server-initiated unidirectional stream (parent sends)
// ---------------------------------------------------------------------------

class _WriteSource {
  #queue:   unknown[] = [];
  #waiters: Array<() => void> = [];
  #done  = false;
  #error: string | null = null;

  push(chunk: unknown): void {
    this.#queue.push(chunk);
    this.#waiters.shift()?.();
  }

  end(): void {
    this.#done = true;
    const ws = this.#waiters.splice(0);
    for (const w of ws) w();
  }

  fail(msg: string): void {
    this.#error = msg;
    this.#done  = true;
    const ws = this.#waiters.splice(0);
    for (const w of ws) w();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const self = this;
    return {
      async next(): Promise<IteratorResult<unknown>> {
        while (self.#queue.length === 0 && !self.#done) {
          await new Promise<void>(resolve => self.#waiters.push(resolve));
        }
        if (self.#queue.length > 0) return { value: self.#queue.shift()!, done: false };
        if (self.#error !== null) throw new Error(self.#error);
        return { value: undefined as unknown, done: true };
      },
    };
  }
}

// portObj → (reqId → _WriteSource) for active write streams on this port.
const _portWriteSources = new WeakMap<object, Map<number, _WriteSource>>();

function _getOrCreateWriteSourceRegistry(
  port: MessagePort | ThreadPort | ProcessPort | ClusterPort,
): Map<number, _WriteSource> {
  const key = port as object;
  let reg = _portWriteSources.get(key);
  if (!reg) { reg = new Map(); _portWriteSources.set(key, reg); }
  return reg;
}

// ---------------------------------------------------------------------------
// Per-port handle registry
// ---------------------------------------------------------------------------

interface _HandleEntry {
  scalar:  Map<string, (...args: unknown[]) => unknown>;
  streams: Map<string, (...args: unknown[]) => AsyncIterable<unknown>>;
  sinks:   Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>;
}

// WeakMap: port → (handleId → HandleEntry). GC'd when the port is collected.
const _portHandleRegistries = new WeakMap<object, Map<string, _HandleEntry>>();
let _nextHandleSeq = 0;

function _getOrCreateHandleRegistry(
  port: MessagePort | ThreadPort | ProcessPort | ClusterPort,
): Map<string, _HandleEntry> {
  const key = port as object;
  let reg = _portHandleRegistries.get(key);
  if (reg) return reg;

  reg = new Map<string, _HandleEntry>();
  _portHandleRegistries.set(key, reg);
  const registry = reg;
  const wsSources = _getOrCreateWriteSourceRegistry(port);

  // One shared dispatcher per port handles all handle method calls.
  port.addEventListener('message', function _handleDispatcher(ev: Event) {
    const msg = (ev as MessageEvent).data;
    if (!msg || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;

    // Write-stream envelopes for handle sink methods
    if (obj['__rpc_send_start'] === true) {
      const entry = registry.get(obj['specifier'] as string ?? '');
      if (!entry) return;
      (ev as MessageEvent).stopImmediatePropagation?.();
      const method = obj['method'] as string ?? '';
      const reqId  = obj['reqId']  as number ?? 0;
      const args   = obj['args']   as unknown[] ?? [];
      const sinkFn = entry.sinks.get(method);
      if (!sinkFn) {
        port.postMessage({ __rpc_res: true, reqId, error: `No sendStream method '${method}' on handle '${obj['specifier']}'` });
        return;
      }
      const source = new _WriteSource();
      wsSources.set(reqId, source);
      sinkFn(args, source).then(
        (result) => { wsSources.delete(reqId); _sendResult(port, registry, reqId, result); },
        (err: unknown) => { wsSources.delete(reqId); port.postMessage({ __rpc_res: true, reqId, error: String(err) }); },
      );
      return;
    }

    if (obj['__rpc_req'] !== true) return;

    const entry = registry.get(obj['specifier'] as string ?? '');
    if (!entry) return;

    (ev as MessageEvent).stopImmediatePropagation?.();
    const method = obj['method'] as string ?? '';
    const reqId  = obj['reqId']  as number ?? 0;
    const args   = obj['args']   as unknown[] ?? [];

    const streamFn = entry.streams.get(method);
    if (streamFn) {
      let iter: AsyncIterable<unknown>;
      try { iter = streamFn(...args); } catch (err: unknown) {
        port.postMessage({ __rpc_res: true, reqId, error: String(err) });
        return;
      }
      (async () => {
        try {
          for await (const chunk of iter) port.postMessage({ __rpc_chunk: true, reqId, chunk });
          port.postMessage({ __rpc_end: true, reqId });
        } catch (err: unknown) { port.postMessage({ __rpc_err: true, reqId, error: String(err) }); }
      })().catch(() => {});
      return;
    }

    const scalarFn = entry.scalar.get(method);
    if (!scalarFn) {
      port.postMessage({ __rpc_res: true, reqId, error: `No method '${method}' on handle '${obj['specifier']}'` });
      return;
    }
    (new Promise<unknown>(res => res(scalarFn(...args)))).then(
      (result) => _sendResult(port, registry, reqId, result),
      (err: unknown) => port.postMessage({ __rpc_res: true, reqId, error: String(err) }),
    );
  } as EventListener);

  return reg;
}

function _registerHandle(
  reg: Map<string, _HandleEntry>, h: FacadeHandle,
): { __handle: string; streams?: string[]; sinks?: string[] } {
  const id = `__h${_nextHandleSeq++}`;
  reg.set(id, { scalar: h._scalar(), streams: h._streams(), sinks: h._sinks() });
  const sn = h._streamNames();
  const sk = h._sinkNames();
  return {
    __handle: id,
    ...(sn.length > 0 ? { streams: sn } : {}),
    ...(sk.length > 0 ? { sinks: sk }   : {}),
  };
}

function _sendResult(
  port: { postMessage(m: unknown): void },
  reg: Map<string, _HandleEntry>,
  reqId: number,
  result: unknown,
): void {
  if (result instanceof FacadeHandle) {
    port.postMessage({ __rpc_res: true, reqId, result: _registerHandle(reg, result) });
  } else {
    port.postMessage({ __rpc_res: true, reqId, result });
  }
}

export class Facade {
  readonly #specifier: string;
  readonly #exports: string[];
  readonly #streams: string[];
  readonly #sinks: string[];
  readonly #handlers       = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  readonly #streamHandlers = new Map<string, (...args: unknown[]) => AsyncIterable<unknown>>();
  readonly #sinkHandlers   = new Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>();

  constructor(specifier: string, exports: string[]) {
    this.#specifier = specifier;
    this.#exports = exports;
    this.#streams = [];
    this.#sinks = [];
  }

  static from(obj: object, opts: { specifier: string }): Facade {
    // Collect callable methods from both own properties (plain objects) and
    // prototype (class instances), excluding Object.prototype built-ins.
    const proto = Object.getPrototypeOf(obj);
    const protoNames = (proto && proto !== Object.prototype)
      ? Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor')
      : [];
    const ownNames = Object.getOwnPropertyNames(obj);
    const allNames = [...new Set([...protoNames, ...ownNames])];
    const exports = allNames
      .filter(k => typeof (obj as Record<string, unknown>)[k] === 'function');
    const f = new Facade(opts.specifier, exports);
    for (const name of exports) {
      f.handle(name, (...args) => (obj as Record<string, unknown>)[name](...args) as Promise<unknown>);
    }
    return f;
  }

  /** Register a scalar handler — result is returned as a single `__rpc_res`. */
  handle(method: string, fn: (...args: unknown[]) => Promise<unknown>): this {
    this.#handlers.set(method, fn);
    return this;
  }

  /**
   * Register a read-stream handler — the AsyncIterable it returns is pumped
   * as `__rpc_chunk` / `__rpc_end` / `__rpc_err` envelopes (parent→child).
   */
  stream(method: string, fn: (...args: unknown[]) => AsyncIterable<unknown>): this {
    if (!this.#streams.includes(method)) this.#streams.push(method);
    this.#streamHandlers.set(method, fn);
    return this;
  }

  /**
   * Register a write-stream (sink) handler — the child sends chunks to the
   * parent via `__rpc_send_chunk` envelopes (child→parent, no per-chunk ack).
   *
   * The handler receives `(args, source: AsyncIterable<unknown>)` and should
   * drain `source` to completion before returning the final result.
   *
   * Maps directly onto a QUIC client-initiated unidirectional stream when the
   * cluster transport is later upgraded to QUIC.
   *
   * ```ts
   * facade.sendStream('write', async (_args, source) => {
   *   let total = 0;
   *   for await (const chunk of source) total += (chunk as Uint8Array).byteLength;
   *   return { bytesWritten: total };
   * });
   * ```
   */
  sendStream(method: string, fn: (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>): this {
    if (!this.#sinks.includes(method)) this.#sinks.push(method);
    this.#sinkHandlers.set(method, fn);
    return this;
  }

  /** @internal */
  toDirective(): ImportDirectiveSer {
    return {
      type: 'facade',
      specifier: this.#specifier,
      exports: this.#exports,
      streams: this.#streams,
      sinks: this.#sinks,
    };
  }

  /**
   * Wire up the parent-side RPC dispatcher on the given port.
   * @internal
   */
  _bind(port: MessagePort | ThreadPort | ProcessPort | ClusterPort): void {
    const specifier      = this.#specifier;
    const handlers       = this.#handlers;
    const streamHandlers = this.#streamHandlers;
    const sinkHandlers   = this.#sinkHandlers;
    const reg            = _getOrCreateHandleRegistry(port);
    const wsSources      = _getOrCreateWriteSourceRegistry(port);

    port.addEventListener('message', function onRpcRequest(ev: Event) {
      const msg = (ev as MessageEvent).data;
      if (msg === null || typeof msg !== 'object') return;
      const obj = msg as Record<string, unknown>;

      // --- write-stream chunk envelopes (child→parent) ---
      if (obj['__rpc_send_start'] === true && obj['specifier'] === specifier) {
        (ev as MessageEvent).stopImmediatePropagation?.();
        const { method, reqId, args } = obj as { method: string; reqId: number; args: unknown[] };
        const fn = sinkHandlers.get(method);
        if (!fn) {
          port.postMessage({ __rpc_res: true, reqId, error: `No sendStream handler for ${specifier}#${method}` });
          return;
        }
        const source = new _WriteSource();
        wsSources.set(reqId, source);
        fn(args, source).then(
          (result) => { wsSources.delete(reqId); _sendResult(port, reg, reqId, result); },
          (err: unknown) => { port.postMessage({ __rpc_res: true, reqId, error: String(err) }); },
        );
        return;
      }
      if (obj['__rpc_send_chunk'] === true) {
        const src = wsSources.get(obj['reqId'] as number);
        if (src) { (ev as MessageEvent).stopImmediatePropagation?.(); src.push(obj['chunk']); }
        return;
      }
      if (obj['__rpc_send_end'] === true) {
        const src = wsSources.get(obj['reqId'] as number);
        if (src) { (ev as MessageEvent).stopImmediatePropagation?.(); wsSources.delete(obj['reqId'] as number); src.end(); }
        return;
      }
      if (obj['__rpc_send_err'] === true) {
        const src = wsSources.get(obj['reqId'] as number);
        if (src) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          wsSources.delete(obj['reqId'] as number);
          src.fail(String(obj['error'] ?? 'sink aborted'));
        }
        return;
      }

      // --- standard request dispatch (__rpc_req) ---
      if (
        obj['__rpc_req'] !== true ||
        obj['specifier'] !== specifier
      ) {
        return;
      }

      (ev as MessageEvent).stopImmediatePropagation?.();

      const { method, reqId, args } = msg as {
        method: string;
        reqId: number;
        args: unknown[];
      };

      // --- streaming handler ---
      const streamFn = streamHandlers.get(method);
      if (streamFn) {
        let iterable: AsyncIterable<unknown>;
        try {
          iterable = streamFn(...args);
        } catch (err: unknown) {
          port.postMessage({ __rpc_res: true, reqId, error: String(err) });
          return;
        }
        (async () => {
          try {
            for await (const chunk of iterable) {
              port.postMessage({ __rpc_chunk: true, reqId, chunk });
            }
            port.postMessage({ __rpc_end: true, reqId });
          } catch (err: unknown) {
            port.postMessage({ __rpc_err: true, reqId, error: String(err) });
          }
        })().catch(() => {});
        return;
      }

      // --- scalar handler ---
      const handler = handlers.get(method);
      if (!handler) {
        port.postMessage({ __rpc_res: true, reqId, error: `No handler for ${specifier}#${method}` });
        return;
      }

      (new Promise<unknown>((res) => res(handler(...args)))).then(
        (result) => {
          if (result instanceof FacadeHandle) {
            // Register the handle and send its ID + stream-method list to the child.
            port.postMessage({ __rpc_res: true, reqId, result: _registerHandle(reg, result) });
          } else if (_isAsyncIterable(result)) {
            (async () => {
              try {
                for await (const chunk of result) {
                  port.postMessage({ __rpc_chunk: true, reqId, chunk });
                }
                port.postMessage({ __rpc_end: true, reqId });
              } catch (err: unknown) {
                port.postMessage({ __rpc_err: true, reqId, error: String(err) });
              }
            })().catch(() => {});
          } else {
            port.postMessage({ __rpc_res: true, reqId, result });
          }
        },
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
   * If true, automatically restart the child Realm whenever any file it
   * imported changes on disk. The JS `Realm` instance is stable across
   * reloads; only the underlying V8 context / thread / process is replaced.
   * Not supported with `remote: true`.
   */
  watch?: boolean;
  /**
   * If true, run this child Realm in REPL mode. The child listens for
   * `{ __eval, id, code }` messages on its port and responds with
   * `{ __eval_result }` or `{ __eval_error }`. Embedded-only — not
   * compatible with `thread`, `process`, `remote`, or `watch`.
   */
  repl?: boolean;
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
    for (const [byteArr] of (_recvProcessMessages(this.#handle) as any[])) {
      const [buf, ...stores] = byteArr as Uint8Array[];
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
  /** Called when the child exits with reload_requested. Returns the new handle
   *  to keep running, or null to stop watching (after terminate()). */
  onReload?: () => number | null;
}

const _activeChildren: ActiveChild[] = [];

/** Step all active child Realms by one iteration. @internal */
export function _stepChildren(): void {
  for (let i = _activeChildren.length - 1; i >= 0; i--) {
    const child = _activeChildren[i]!;
    if (child.kind === 'remote') continue; // driven by cluster transport, not stepped
    // Step returns: true = alive, false = clean exit, null = reload requested
    let stepResult: boolean | null;
    let stepError: unknown = undefined;
    if (child.kind === 'thread') {
      try { stepResult = stepThreadContext(child.handle) as boolean | null; }
      catch (err) { stepResult = false; stepError = err; }
    } else if (child.kind === 'process') {
      try { stepResult = stepProcessContext(child.handle) as boolean | null; }
      catch (err) { stepResult = false; stepError = err; }
    } else {
      try { stepResult = stepContext(child.handle) as boolean | null; }
      catch (err) { stepResult = false; stepError = err; }
    }
    if (stepResult !== true) {
      if (stepError !== undefined) {
        child.reject(stepError);
        _activeChildren.splice(i, 1);
      } else if (stepResult === null && child.onReload !== undefined) {
        const newHandle = child.onReload();
        if (newHandle !== null) {
          child.handle = newHandle;
        } else {
          child.resolve();
          _activeChildren.splice(i, 1);
        }
      } else {
        child.resolve();
        _activeChildren.splice(i, 1);
      }
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
    const d = data as { message?: string; name?: string; stack?: string };
    const err = new Error(d.message ?? 'Realm call failed');
    if (d.name !== undefined) err.name = d.name;
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
  #handle: number;
  readonly #kind: RealmKind;
  /** Parent-side port for general communication with the child Realm. */
  readonly port: MessagePort | ThreadPort | ProcessPort | ClusterPort;
  /** Pending spawn for remote realms; resolves to childPortId after SPAWN_ACK. */
  #spawnPromise: Promise<string> | null = null;

  // Watch mode state
  #watchOpts: RealmOptions | null = null;
  #watchSerializedRules = '[]';
  #watchTerminated = false;
  // For thread/process watch mode: tracks the current child's port so that
  // terminate() reaches the most-recently-spawned child, not the original one.
  #activeChildPort: ThreadPort | ProcessPort | null = null;

  constructor(opts: RealmOptions) {
    if (opts.watch && opts.remote) {
      throw new Error('fino:realm — watch: true is not supported with remote: true');
    }

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

    if (opts.watch) {
      this.#watchOpts = opts;
      this.#watchSerializedRules = serializedRules;
    }

    const watch = opts.watch ?? false;
    const repl  = opts.repl  ?? false;

    if (repl && (opts.thread || opts.process || opts.remote || opts.watch)) {
      throw new Error('fino:realm — repl: true is only supported for embedded realms (not thread, process, remote, or watch)');
    }

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
      const handle = createProcessContext(opts.root ?? '', opts.entry, serializedRules, watch) as number;
      this.#handle = handle;
      const wakeReadFd = getProcessSocketFd(handle) as number;
      this.port = new ProcessPort(wakeReadFd, handle);
    } else if (opts.thread) {
      this.#kind = 'thread';
      const handle = createThreadContext(opts.root ?? '', opts.entry, serializedRules, watch) as number;
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
      this.#handle = createContext(opts.root ?? '', opts.entry, serializedRules, childPort, watch, repl) as number;
    }

    // Bind any Facade overrides so the parent-side RPC dispatcher is wired up.
    if (rules.length > 0) {
      const port = this.port as MessagePort | ThreadPort | ProcessPort | ClusterPort;
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

  /** Spawn a fresh child handle using the stored watch opts. @internal */
  #spawnChild(): number {
    const opts = this.#watchOpts!;
    const rules = this.#watchSerializedRules;
    if (opts.process) {
      const h = createProcessContext(opts.root ?? '', opts.entry, rules, true) as number;
      this.#activeChildPort = new ProcessPort(getProcessSocketFd(h) as number, h);
      return h;
    } else if (opts.thread) {
      const h = createThreadContext(opts.root ?? '', opts.entry, rules, true) as number;
      this.#activeChildPort = new ThreadPort(getThreadPortWakeReadFd(h) as number, h);
      return h;
    } else {
      const { port2: childPort } = new MessageChannel();
      return createContext(opts.root ?? '', opts.entry, rules, childPort, true) as number;
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

    if (this.#watchOpts !== null) {
      return new Promise<void>((resolve, reject) => {
        const self = this;
        const entry: ActiveChild = {
          handle: this.#handle,
          kind: this.#kind,
          resolve,
          reject,
          onReload(): number | null {
            if (self.#watchTerminated) return null;
            const newHandle = self.#spawnChild();
            self.#handle = newHandle;
            return newHandle;
          },
        };
        _activeChildren.push(entry);
      });
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
          resolve: () => reject(new Error('Realm exited before returning a call result')),
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
    this.#watchTerminated = true;
    if (this.#kind === 'remote') {
      this.port.postMessage({ __terminate: true });
      this.port.close();
    } else if (this.#kind === 'thread' || this.#kind === 'process') {
      // After a watch-mode reload, this.port still points to the first child's
      // port.  Use #activeChildPort when set (updated by #spawnChild on reload)
      // so the terminate message reaches the currently-running child.
      const activePort = this.#activeChildPort ?? (this.port as ThreadPort | ProcessPort);
      activePort.postMessage({ __terminate: true });
      activePort.close();
    } else {
      terminateChild(this.#handle);
    }
  }

  /** Explicit resource management. */
  [Symbol.dispose](): void { this.terminate(); }
}
