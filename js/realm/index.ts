/**
* fino:realm - Realm construction and management.
*
* A Realm is an isolated V8 Context with its own global object, module graph,
* microtask queue, and event loop. The parent's import rule list governs every
* module resolution in the child; the child can layer overrides on top.
*
* Every ordinary realm is hosted by a reactor thread selected by node
* orchestration. `RealmDeployment` manages independent replicas without
* changing the one-container meaning of `Realm`. `process: true` adds an
* OS-process isolation boundary while preserving the same Realm API.
*
* The import rule list uses last-match-wins semantics. Declare a wildcard
* first as the baseline and more specific patterns afterwards as overrides.
* CLI OpenTelemetry bootstrap metadata follows realm construction separately
* from user data: children inherit a `fino run --otlp-endpoint` endpoint by
* default, `otlpEndpoint` overrides it for one subtree, and `false` disables it.
*
* @example
* ```ts no_run
* import { Realm, ImportMap } from 'fino:realm';
*
* const realm = new Realm({
*   entry: './worker.ts',
*   overrides: ImportMap.inherit([
*     { pattern: 'fino:process', directive: 'block' },
*   ]),
* });
* const result = await realm.call('job-1');
* await realm.terminate();
* ```
*/
import { mergeChildRules, createProcessContext, stepProcessContext } from 'internal:realm-native';
import { getRealmBootstrapData } from 'internal:realm-bridge';
import { placeScheduledRealm, type ScheduledRealmAllocation } from 'internal:realm/allocate';
import { MessagePort, type MessageEvent } from '../globals/messaging.ts';
import { ThreadPort, DeferredTransportPort, BaseTransportPort } from 'internal:realm/transport-port';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../internal/opentelemetry/common.ts';
import { transpile as transpileTypeScript } from '../format/typescript.ts';
import * as deployment from 'internal:orchestrator/deployment';
import type { ReplicaLease } from 'internal:orchestrator/deployment';
import { clusterOrchestrator } from 'internal:orchestrator/cluster-orchestrator';
// Pre-cache OTel topic instances for realm lifecycle events.
// Gated on hasSubscribers so realms that don't use OTel pay no cost.
const _topicRealmSpawn = topic(otelRuntimeTopic('realm', 'spawn', 'start'));
const _topicRealmCall = topic(otelRuntimeTopic('realm', 'call', 'start'));
const _topicRealmCallEnd = topic(otelRuntimeTopic('realm', 'call', 'end'));
// ---------------------------------------------------------------------------
// Import rule types
// ---------------------------------------------------------------------------
/**
* Wire-format representation of an import directive.
*
* Directives control how a child realm resolves an import that matches an
* `ImportRule`. String forms are accepted for convenience and normalized to
* the Rust serde layout before crossing the native bridge. `source` injects an
* in-memory module, `remap` redirects to another specifier, and `facade`
* exposes parent-side RPC handlers.
*
* ```ts no_run
* import type { ImportDirectiveSer } from 'fino:realm';
*
* const directive: ImportDirectiveSer = {
*   type: 'remap',
*   target: './sandboxed-logger.ts',
* };
* ```
*/
export type ImportDirectiveSer = 'inherit' | 'block' | {
  type: 'inherit';
} | {
  type: 'block';
} | {
  type: 'remap';
  target: string;
} | {
  type: 'source';
  code: string;
  source_map: string;
} | {
  type: 'facade';
  specifier: string;
  exports: string[];
  streams?: string[];
  sinks?: string[];
};
/**
* Import rule applied to module resolution inside a child realm.
*
* Rules are evaluated with last-match-wins semantics after the parent realm's
* inherited rules. A matching rule may inherit, block, remap, inject source,
* or expose a facade. Invalid patterns are rejected by the native loader when
* the child realm is created.
*
* ```ts no_run
* import type { ImportRule } from 'fino:realm';
*
* const rule: ImportRule = {
*   pattern: 'fino:process',
*   directive: 'block',
* };
* ```
*/
export interface ImportRule {
  /**
  * Optional pattern matching the importing module's specifier.
  *
  * When omitted, the rule can apply regardless of which module performs the
  * import. Use this for broad allow/deny lists, and provide `from` when only a
  * specific importer should receive an override.
  *
  * ```ts no_run
  * import type { ImportRule } from 'fino:realm';
  *
  * const rule: ImportRule = {
  *   from: './plugin-host.ts',
  *   pattern: './plugin-api.ts',
  *   directive: 'inherit',
  * };
  * ```
  */
  from?: string;
  /**
  * Pattern matching the specifier being imported.
  *
  * This field is required. `*` is commonly used as a baseline rule, with more
  * specific patterns appended later as overrides.
  *
  * ```ts no_run
  * import type { ImportRule } from 'fino:realm';
  *
  * const blockAll: ImportRule = { pattern: '*', directive: 'block' };
  * ```
  */
  pattern: string;
  /**
  * Resolution action to apply when the rule matches.
  *
  * `inherit` falls back to the parent rule set, `block` rejects resolution,
  * and object forms can remap, inject source, or expose a facade. Facade
  * instances are accepted and normalized during realm construction.
  *
  * ```ts no_run
  * import type { ImportRule } from 'fino:realm';
  *
  * const rule: ImportRule = {
  *   pattern: 'virtual:config',
  *   directive: { type: 'source', code: 'export const port = 8080;', source_map: '' },
  * };
  * ```
  */
  directive: ImportDirectiveSer;
}
/** Normalise a user-facing directive value to the Rust wire format. */
function normaliseDirective(d: ImportDirectiveSer): {
  type: string;
  [k: string]: unknown;
} {
  if (d === 'inherit') return { type: 'inherit' };
  if (d === 'block') return { type: 'block' };
  if (d instanceof Facade) return d.toDirective() as {
    type: string;
    [k: string]: unknown;
  };
  if (typeof d === 'object' && 'type' in d) return d as {
    type: string;
    [k: string]: unknown;
  };
  return { type: 'inherit' };
}
/** Serialise a rule array to the JSON string the Rust bridge expects. */
function serialiseRules(rules: ImportRule[]): string {
  return JSON.stringify(rules.map((r) => ({
    ...r.from !== undefined ? { from: r.from } : {},
    pattern: r.pattern,
    directive: normaliseDirective(r.directive)
  })));
}
/** Serialise `RealmOptions.data` to the JSON string the Rust bridge stores. */
function serializeRealmData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new Error('fino:realm — data must be JSON-serializable');
  }
  return json;
}
interface RealmBootstrapData {
  cliOtel?: {
    endpoint?: string;
  };
}
function currentRealmBootstrapData(): RealmBootstrapData | undefined {
  const raw = (getRealmBootstrapData as () => string | undefined)();
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as RealmBootstrapData : undefined;
  } catch {
    return undefined;
  }
}
function serializeRealmBootstrapData(opts: RealmOptions): string | undefined {
  const endpointOption = opts.otlpEndpoint;
  if (endpointOption === false) return undefined;
  let endpoint = '';
  if (typeof endpointOption === 'string') {
    endpoint = endpointOption.trim();
    if (!endpoint) throw new Error('fino:realm — otlpEndpoint must be a non-empty string or false');
  }
  if (!endpoint) {
    const inherited = currentRealmBootstrapData()?.cliOtel?.endpoint;
    endpoint = typeof inherited === 'string' ? inherited.trim() : '';
  }
  if (!endpoint) return undefined;
  return JSON.stringify({ cliOtel: { endpoint } });
}

// ---------------------------------------------------------------------------
// ImportMap - helper for building the child-specific rule list
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
*
* @example
* ```ts no_run
* const documentedClass = 'ImportMap';
* console.log(documentedClass);
* ```
*/
export class ImportMap {
  /**
  * Private readonly property `#rules` used by `ImportMap`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #rules = undefined;
  *
  *   readInternalState() {
  *     return this.#rules;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #rules: ImportRule[];
  /**
  * Create an ordered import map from explicit rules.
  *
  * The rules are stored as child-specific overrides and later appended after
  * parent rules. The constructor does not add a wildcard baseline; use
  * `ImportMap.deny()` or `ImportMap.inherit()` when you want that default.
  *
  * ```ts no_run
  * import { ImportMap } from 'fino:realm';
  *
  * const map = new ImportMap([{ pattern: 'fino:process', directive: 'block' }]);
  * ```
  *
  * @param rules Ordered child-specific import rules.
  */
  constructor(rules: ImportRule[]) {
    this.#rules = rules;
  }
  /**
  * Deny everything by default; allow/remap/facade specific specifiers.
  *
  * The wildcard `{ pattern: '*', directive: 'block' }` is prepended, then
  * the caller's overrides follow (each overrides the wildcard for its pattern).
  *
  * ```ts no_run
  * import { ImportMap, Realm } from 'fino:realm';
  *
  * const overrides = ImportMap.deny([
  *   { pattern: './worker-api.ts', directive: 'inherit' },
  * ]);
  * new Realm({ entry: './worker.ts', overrides });
  * ```
  */
  static deny(overrides: ImportRule[]): ImportMap {
    return new ImportMap([{
      pattern: '*',
      directive: 'block'
    }, ...overrides]);
  }
  /**
  * Inherit everything from the parent by default; restrict specific specifiers.
  *
  * The wildcard `{ pattern: '*', directive: 'inherit' }` is prepended; the
  * caller's overrides follow. Effectively a no-op wildcard (Inherit is
  * dropped on the Rust side), but makes the intent explicit in code.
  *
  * ```ts no_run
  * import { ImportMap, Realm } from 'fino:realm';
  *
  * const overrides = ImportMap.inherit([
  *   { pattern: 'fino:process', directive: 'block' },
  * ]);
  * new Realm({ entry: './worker.ts', overrides });
  * ```
  */
  static inherit(overrides: ImportRule[]): ImportMap {
    return new ImportMap([{
      pattern: '*',
      directive: 'inherit'
    }, ...overrides]);
  }
  /**
  * Return the ordered rules stored in this map.
  *
  * This exposes the internal representation used by `Realm` construction. The
  * returned array is the same rule list object captured by the map.
  *
  * ```ts no_run
  * import { ImportMap } from 'fino:realm';
  *
  * const rules = ImportMap.inherit([]).toRules();
  * ```
  *
  * @internal
  */
  toRules(): ImportRule[] {
    return this.#rules;
  }
}
// ---------------------------------------------------------------------------
// Facade - RPC-backed virtual module interface
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
// FacadeHandle - stateful handle returned from Facade handlers
// ---------------------------------------------------------------------------
/**
* A stateful object handle returned from a Facade handler.
*
* When a scalar handler returns a `FacadeHandle`, the parent registers its
* methods under a unique ID and sends `{ __handle: id, streams?: [...] }` to
* the child.  The child receives a Proxy that routes subsequent method calls
* back through `internal:parent-rpc` using the handle ID as the specifier.
*
* ```ts no_run
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
  /**
  * Private readonly property `#scalar` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #scalar = undefined;
  *
  *   readInternalState() {
  *     return this.#scalar;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #scalar: Map<string, (...args: unknown[]) => unknown>;
  /**
  * Private readonly property `#streams` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #streams = undefined;
  *
  *   readInternalState() {
  *     return this.#streams;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #streams: Map<string, (...args: unknown[]) => AsyncIterable<unknown>>;
  /**
  * Private readonly property `#sinks` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #sinks = undefined;
  *
  *   readInternalState() {
  *     return this.#sinks;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #sinks: Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>;
  /**
  * Create a stateful handle with scalar, read-stream, and write-stream methods.
  *
  * Scalar methods return one response, stream methods return an
  * `AsyncIterable`, and sink methods receive chunks from the child as an
  * `AsyncIterable`. Empty maps are allowed.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle(
  *   { stat: () => ({ size: 10 }) },
  *   { read: async function* () { yield new Uint8Array([1, 2, 3]); } },
  * );
  * ```
  *
  * @param scalar Methods that return a single RPC result.
  * @param streams Methods that return chunks to the child.
  * @param sinks Methods that consume chunks sent by the child.
  */
  constructor(scalar: Record<string, (...args: unknown[]) => unknown> = {}, streams: Record<string, (...args: unknown[]) => AsyncIterable<unknown>> = {}, sinks: Record<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>> = {}) {
    this.#scalar = new Map(Object.entries(scalar));
    this.#streams = new Map(Object.entries(streams));
    this.#sinks = new Map(Object.entries(sinks));
  }
  /**
  * Return scalar handle methods for parent-side RPC dispatch.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle({ close: () => undefined });
  * handle._scalar().get('close')?.();
  * ```
  *
  * @internal
  */
  /**
  * Internal method `_scalar` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _scalar() {
  *     return '_scalar';
  *   },
  * };
  * includePrivateExample._scalar();
  * ```
  *
  * @internal
  */
  _scalar() {
    return this.#scalar;
  }
  /**
  * Return read-stream handle methods for parent-side RPC dispatch.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle({}, { read: async function* () { yield 'x'; } });
  * console.log(handle._streams().has('read'));
  * ```
  *
  * @internal
  */
  /**
  * Internal method `_streams` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _streams() {
  *     return '_streams';
  *   },
  * };
  * includePrivateExample._streams();
  * ```
  *
  * @internal
  */
  _streams() {
    return this.#streams;
  }
  /**
  * Return write-stream handle methods for parent-side RPC dispatch.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle({}, {}, { write: async () => undefined });
  * console.log(handle._sinks().has('write'));
  * ```
  *
  * @internal
  */
  /**
  * Internal method `_sinks` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _sinks() {
  *     return '_sinks';
  *   },
  * };
  * includePrivateExample._sinks();
  * ```
  *
  * @internal
  */
  _sinks() {
    return this.#sinks;
  }
  /**
  * Return the names of read-stream methods exposed to the child proxy.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle({}, { read: async function* () {} });
  * console.log(handle._streamNames());
  * ```
  *
  * @internal
  */
  /**
  * Internal method `_streamNames` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _streamNames() {
  *     return '_streamNames';
  *   },
  * };
  * includePrivateExample._streamNames();
  * ```
  *
  * @internal
  */
  _streamNames() {
    return [...this.#streams.keys()];
  }
  /**
  * Return the names of write-stream methods exposed to the child proxy.
  *
  * ```ts no_run
  * import { FacadeHandle } from 'fino:realm';
  *
  * const handle = new FacadeHandle({}, {}, { write: async () => undefined });
  * console.log(handle._sinkNames());
  * ```
  *
  * @internal
  */
  /**
  * Internal method `_sinkNames` used by `FacadeHandle`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * const includePrivateExample = {
  *   _sinkNames() {
  *     return '_sinkNames';
  *   },
  * };
  * includePrivateExample._sinkNames();
  * ```
  *
  * @internal
  */
  _sinkNames() {
    return [...this.#sinks.keys()];
  }
}
// ---------------------------------------------------------------------------
// Per-port write-stream (sink) source queues
//
// When the child calls callSink(), it sends __rpc_send_start.  The parent
// creates a _WriteSource that acts as the `source: AsyncIterable` argument to
// the handler.  Subsequent __rpc_send_chunk messages push into the queue;
// __rpc_send_end / __rpc_send_err close or fail it.
//
// This is the symmetric counterpart to _StreamQueue in parent-rpc.ts (which
// buffers chunks flowing parent->child).  The pairing maps directly onto QUIC:
//   _WriteSource  <-  QUIC client-initiated unidirectional stream (child sends)
//   _StreamQueue  <-  QUIC server-initiated unidirectional stream (parent sends)
// ---------------------------------------------------------------------------
class _WriteSource {
  #queue: unknown[] = [];
  #waiters: Array<() => void> = [];
  #done = false;
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
    this.#done = true;
    const ws = this.#waiters.splice(0);
    for (const w of ws) w();
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const self = this;
    return { async next(): Promise<IteratorResult<unknown>> {
      while (self.#queue.length === 0 && !self.#done) {
        await new Promise<void>((resolve) => self.#waiters.push(resolve));
      }
      if (self.#queue.length > 0) return {
        value: self.#queue.shift()!,
        done: false
      };
      if (self.#error !== null) throw new Error(self.#error);
      return {
        value: undefined as unknown,
        done: true
      };
    } };
  }
}
// portObj -> (reqId -> _WriteSource) for active write streams on this port.
const _portWriteSources = new WeakMap<object, Map<number, _WriteSource>>();
function _getOrCreateWriteSourceRegistry(port: MessagePort | BaseTransportPort): Map<number, _WriteSource> {
  const key = port as object;
  let reg = _portWriteSources.get(key);
  if (!reg) {
    reg = new Map();
    _portWriteSources.set(key, reg);
  }
  return reg;
}
// ---------------------------------------------------------------------------
// Per-port handle registry
// ---------------------------------------------------------------------------
interface _HandleEntry {
  scalar: Map<string, (...args: unknown[]) => unknown>;
  streams: Map<string, (...args: unknown[]) => AsyncIterable<unknown>>;
  sinks: Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>;
}
// WeakMap: port -> (handleId -> HandleEntry). GC'd when the port is collected.
const _portHandleRegistries = new WeakMap<object, Map<string, _HandleEntry>>();
let _nextHandleSeq = 0;
function _getOrCreateHandleRegistry(port: MessagePort | BaseTransportPort): Map<string, _HandleEntry> {
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
      const reqId = obj['reqId'] as number ?? 0;
      const args = obj['args'] as unknown[] ?? [];
      const sinkFn = entry.sinks.get(method);
      if (!sinkFn) {
        port.postMessage({
          __rpc_res: true,
          reqId,
          error: `No sendStream method '${method}' on handle '${obj['specifier']}'`
        });
        return;
      }
      const source = new _WriteSource();
      wsSources.set(reqId, source);
      sinkFn(args, source).then((result) => {
        wsSources.delete(reqId);
        _sendResult(port, registry, reqId, result);
      }, (err: unknown) => {
        wsSources.delete(reqId);
        port.postMessage({
          __rpc_res: true,
          reqId,
          error: String(err)
        });
      });
      return;
    }
    if (obj['__rpc_req'] !== true) return;
    const entry = registry.get(obj['specifier'] as string ?? '');
    if (!entry) return;
    (ev as MessageEvent).stopImmediatePropagation?.();
    const method = obj['method'] as string ?? '';
    const reqId = obj['reqId'] as number ?? 0;
    const args = obj['args'] as unknown[] ?? [];
    const streamFn = entry.streams.get(method);
    if (streamFn) {
      let iter: AsyncIterable<unknown>;
      try {
        iter = streamFn(...args);
      } catch (err: unknown) {
        port.postMessage({
          __rpc_res: true,
          reqId,
          error: String(err)
        });
        return;
      }
      (async () => {
        try {
          for await (const chunk of iter) port.postMessage({
            __rpc_chunk: true,
            reqId,
            chunk
          });
          port.postMessage({
            __rpc_end: true,
            reqId
          });
        } catch (err: unknown) {
          port.postMessage({
            __rpc_err: true,
            reqId,
            error: String(err)
          });
        }
      })().catch(() => {});
      return;
    }
    const scalarFn = entry.scalar.get(method);
    if (!scalarFn) {
      port.postMessage({
        __rpc_res: true,
        reqId,
        error: `No method '${method}' on handle '${obj['specifier']}'`
      });
      return;
    }
    new Promise<unknown>((res) => res(scalarFn(...args))).then((result) => _sendResult(port, registry, reqId, result), (err: unknown) => port.postMessage({
      __rpc_res: true,
      reqId,
      error: String(err)
    }));
  } as EventListener);
  return reg;
}
function _registerHandle(reg: Map<string, _HandleEntry>, h: FacadeHandle): {
  __handle: string;
  streams?: string[];
  sinks?: string[];
} {
  const id = `__h${_nextHandleSeq++}`;
  reg.set(id, {
    scalar: h._scalar(),
    streams: h._streams(),
    sinks: h._sinks()
  });
  const sn = h._streamNames();
  const sk = h._sinkNames();
  return {
    __handle: id,
    ...sn.length > 0 ? { streams: sn } : {},
    ...sk.length > 0 ? { sinks: sk } : {}
  };
}
function _sendResult(port: {
  postMessage(m: unknown): void;
}, reg: Map<string, _HandleEntry>, reqId: number, result: unknown): void {
  if (result instanceof FacadeHandle) {
    port.postMessage({
      __rpc_res: true,
      reqId,
      result: _registerHandle(reg, result)
    });
  } else {
    port.postMessage({
      __rpc_res: true,
      reqId,
      result
    });
  }
}
/**
* Public facade exposed to a child realm as a synthetic module.
*
* A facade declares the names available to child imports and binds parent-side
* handlers for those names. Calls cross the realm boundary through RPC, so
* arguments and results must be serializable by the active realm transport
* unless they are represented as streams or `FacadeHandle` proxies.
*
* ```ts no_run
* import { Facade, ImportMap, Realm } from 'fino:realm';
*
* const api = new Facade('app:api', ['version'])
*   .handle('version', async () => '1.0.0');
*
* new Realm({
*   entry: './worker.ts',
*   overrides: ImportMap.inherit([{ pattern: 'app:api', directive: api }]),
* });
* ```
*/
export class Facade {
  /**
  * Private readonly property `#specifier` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #specifier = undefined;
  *
  *   readInternalState() {
  *     return this.#specifier;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #specifier: string;
  /**
  * Private readonly property `#exports` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #exports = undefined;
  *
  *   readInternalState() {
  *     return this.#exports;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #exports: string[];
  /**
  * Private readonly property `#streams` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #streams = undefined;
  *
  *   readInternalState() {
  *     return this.#streams;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #streams: string[];
  /**
  * Private readonly property `#sinks` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #sinks = undefined;
  *
  *   readInternalState() {
  *     return this.#sinks;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #sinks: string[];
  /**
  * Private readonly property `#handlers` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #handlers = undefined;
  *
  *   readInternalState() {
  *     return this.#handlers;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  /**
  * Private readonly property `#streamHandlers` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #streamHandlers = undefined;
  *
  *   readInternalState() {
  *     return this.#streamHandlers;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #streamHandlers = new Map<string, (...args: unknown[]) => AsyncIterable<unknown>>();
  /**
  * Private readonly property `#sinkHandlers` used by `Facade`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #sinkHandlers = undefined;
  *
  *   readInternalState() {
  *     return this.#sinkHandlers;
  *   }
  * }
  * ```
  *
  * @internal
  */
  readonly #sinkHandlers = new Map<string, (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>>();
  /**
  * Create a facade for a synthetic module specifier.
  *
  * `exports` declares the scalar method names visible in the child module.
  * Register matching handlers with `handle()`. Stream and sink names are
  * declared by `stream()` and `sendStream()`.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const facade = new Facade('app:math', ['double'])
  *   .handle('double', async (value) => Number(value) * 2);
  * ```
  *
  * @param specifier Module specifier the child imports.
  * @param exports Scalar export names exposed by the synthetic module.
  */
  constructor(specifier: string, exports: string[]) {
    this.#specifier = specifier;
    this.#exports = exports;
    this.#streams = [];
    this.#sinks = [];
  }
  /**
  * Create a facade from callable properties on an object or class instance.
  *
  * Own functions and prototype methods are exported. Non-function properties
  * are ignored. Each generated handler calls the original method with the
  * original object as the receiver expression.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const service = { ping: async () => 'pong' };
  * const facade = Facade.from(service, { specifier: 'app:service' });
  * ```
  *
  * @param obj Object whose callable members should be exposed.
  * @param opts Facade creation options.
  * @returns A facade with handlers for the object's callable members.
  */
  static from(obj: object, opts: {
    specifier: string;
  }): Facade {
    // Collect callable methods from both own properties (plain objects) and
    // prototype (class instances), excluding Object.prototype built-ins.
    const proto = Object.getPrototypeOf(obj);
    const protoNames = proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor') : [];
    const ownNames = Object.getOwnPropertyNames(obj);
    const allNames = [...new Set([...protoNames, ...ownNames])];
    const exports = allNames.filter((k) => typeof (obj as Record<string, unknown>)[k] === 'function');
    const f = new Facade(opts.specifier, exports);
    for (const name of exports) {
      f.handle(name, (...args) => (obj as Record<string, unknown>)[name](...args) as Promise<unknown>);
    }
    return f;
  }
  /**
  * Register a scalar handler.
  *
  * The handler receives the child call arguments and returns one result. A
  * thrown error or rejected promise is sent back as an RPC error. Returning a
  * `FacadeHandle` creates a stateful child-side proxy.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const facade = new Facade('app:math', ['add']);
  * facade.handle('add', async (a, b) => Number(a) + Number(b));
  * ```
  *
  * @param method Export name to handle.
  * @param fn Parent-side implementation.
  * @returns This facade for chaining.
  */
  handle(method: string, fn: (...args: unknown[]) => Promise<unknown>): this {
    this.#handlers.set(method, fn);
    return this;
  }
  /**
  * Register a read-stream handler - the AsyncIterable it returns is pumped
  * as `__rpc_chunk` / `__rpc_end` / `__rpc_err` envelopes (parent->child).
  *
  * The method name is added to the facade's stream export list if it is not
  * already present. Errors thrown while creating or consuming the iterable are
  * delivered to the child as stream errors.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const facade = new Facade('app:logs', []);
  * facade.stream('tail', async function* () {
  *   yield 'line one';
  * });
  * ```
  *
  * @param method Stream method name.
  * @param fn Function that returns chunks for the child to read.
  * @returns This facade for chaining.
  */
  stream(method: string, fn: (...args: unknown[]) => AsyncIterable<unknown>): this {
    if (!this.#streams.includes(method)) this.#streams.push(method);
    this.#streamHandlers.set(method, fn);
    return this;
  }
  /**
  * Register a write-stream (sink) handler - the child sends chunks to the
  * parent via `__rpc_send_chunk` envelopes (child->parent, no per-chunk ack).
  *
  * The handler receives `(args, source: AsyncIterable<unknown>)` and should
  * drain `source` to completion before returning the final result.
  *
  * Maps directly onto a QUIC client-initiated unidirectional stream when the
  * cluster transport is later upgraded to QUIC.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const facade = new Facade('app:upload', []);
  * facade.sendStream('write', async (_args, source) => {
  *   let total = 0;
  *   for await (const chunk of source) total += (chunk as Uint8Array).byteLength;
  *   return { bytesWritten: total };
  * });
  * ```
  *
  * @param method Sink method name.
  * @param fn Function that drains child-sent chunks and returns a final result.
  * @returns This facade for chaining.
  */
  sendStream(method: string, fn: (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>): this {
    if (!this.#sinks.includes(method)) this.#sinks.push(method);
    this.#sinkHandlers.set(method, fn);
    return this;
  }
  /**
  * Convert this facade to the import-rule directive sent to the native loader.
  *
  * The directive contains the specifier plus the current scalar, stream, and
  * sink export names. It does not include handler functions; handlers are
  * bound separately to the realm port.
  *
  * ```ts no_run
  * import { Facade } from 'fino:realm';
  *
  * const directive = new Facade('app:api', ['ping']).toDirective();
  * ```
  *
  * @internal
  */
  toDirective(): ImportDirectiveSer {
    return {
      type: 'facade',
      specifier: this.#specifier,
      exports: this.#exports,
      streams: this.#streams,
      sinks: this.#sinks
    };
  }
  /**
  * Wire up the parent-side RPC dispatcher on the given port.
  *
  * The dispatcher listens for child RPC envelopes matching this facade's
  * specifier and forwards them to registered handlers. Binding starts the
  * port. Missing handlers and thrown errors are returned as RPC errors.
  *
  * ```ts no_run
  * import { Facade, Realm } from 'fino:realm';
  *
  * const realm = new Realm({ entry: './worker.ts' });
  * new Facade('app:api', ['ping'])._bind(realm.port);
  * ```
  *
  * @internal
  */
  _bind(port: MessagePort | BaseTransportPort): void {
    const specifier = this.#specifier;
    const handlers = this.#handlers;
    const streamHandlers = this.#streamHandlers;
    const sinkHandlers = this.#sinkHandlers;
    const reg = _getOrCreateHandleRegistry(port);
    const wsSources = _getOrCreateWriteSourceRegistry(port);
    port.addEventListener('message', function onRpcRequest(ev: Event) {
      const msg = (ev as MessageEvent).data;
      if (msg === null || typeof msg !== 'object') return;
      const obj = msg as Record<string, unknown>;
      // --- write-stream chunk envelopes (child->parent) ---
      if (obj['__rpc_send_start'] === true && obj['specifier'] === specifier) {
        (ev as MessageEvent).stopImmediatePropagation?.();
        const { method, reqId, args } = obj as {
          method: string;
          reqId: number;
          args: unknown[];
        };
        const fn = sinkHandlers.get(method);
        if (!fn) {
          port.postMessage({
            __rpc_res: true,
            reqId,
            error: `No sendStream handler for ${specifier}#${method}`
          });
          return;
        }
        const source = new _WriteSource();
        wsSources.set(reqId, source);
        fn(args, source).then((result) => {
          wsSources.delete(reqId);
          _sendResult(port, reg, reqId, result);
        }, (err: unknown) => {
          port.postMessage({
            __rpc_res: true,
            reqId,
            error: String(err)
          });
        });
        return;
      }
      if (obj['__rpc_send_chunk'] === true) {
        const src = wsSources.get(obj['reqId'] as number);
        if (src) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          src.push(obj['chunk']);
        }
        return;
      }
      if (obj['__rpc_send_end'] === true) {
        const src = wsSources.get(obj['reqId'] as number);
        if (src) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          wsSources.delete(obj['reqId'] as number);
          src.end();
        }
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
      if (obj['__rpc_req'] !== true || obj['specifier'] !== specifier) {
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
          port.postMessage({
            __rpc_res: true,
            reqId,
            error: String(err)
          });
          return;
        }
        (async () => {
          try {
            for await (const chunk of iterable) {
              port.postMessage({
                __rpc_chunk: true,
                reqId,
                chunk
              });
            }
            port.postMessage({
              __rpc_end: true,
              reqId
            });
          } catch (err: unknown) {
            port.postMessage({
              __rpc_err: true,
              reqId,
              error: String(err)
            });
          }
        })().catch(() => {});
        return;
      }
      // --- scalar handler ---
      const handler = handlers.get(method);
      if (!handler) {
        port.postMessage({
          __rpc_res: true,
          reqId,
          error: `No handler for ${specifier}#${method}`
        });
        return;
      }
      new Promise<unknown>((res) => res(handler(...args))).then((result) => {
        if (result instanceof FacadeHandle) {
          // Register the handle and send its ID + stream-method list to the child.
          port.postMessage({
            __rpc_res: true,
            reqId,
            result: _registerHandle(reg, result)
          });
        } else if (_isAsyncIterable(result)) {
          (async () => {
            try {
              for await (const chunk of result) {
                port.postMessage({
                  __rpc_chunk: true,
                  reqId,
                  chunk
                });
              }
              port.postMessage({
                __rpc_end: true,
                reqId
              });
            } catch (err: unknown) {
              port.postMessage({
                __rpc_err: true,
                reqId,
                error: String(err)
              });
            }
          })().catch(() => {});
        } else {
          port.postMessage({
            __rpc_res: true,
            reqId,
            result
          });
        }
      }, (err: unknown) => port.postMessage({
        __rpc_res: true,
        reqId,
        error: String(err)
      }));
    } as EventListener);
    port.start();
  }
}
// ---------------------------------------------------------------------------
// Legacy provider config classes (kept for backwards compatibility)
// ---------------------------------------------------------------------------
/**
* Generated-doc-visible interface `DiskFsOptions`.
*
* This implementation detail is included when documentation is built with
* `--include-private`. It describes state or helper behavior used by the
* owning module rather than a stable application-facing contract. Prefer the
* public API around the owning type unless you are maintaining this runtime.
*
* @example
* ```ts no_run
* const documentedType = 'DiskFsOptions';
* console.log(documentedType);
* ```
*
* @internal
*/
export interface DiskFsOptions {
  /**
  * Filesystem root used by the disk provider.
  *
  * When omitted, the provider uses the realm's inherited/default filesystem
  * root. The value is interpreted by the file provider, not normalized by this
  * config class.
  *
  * ```ts no_run
  * import type { DiskFsOptions } from 'fino:realm';
  *
  * const options: DiskFsOptions = { root: '/srv/app' };
  * ```
  */
  root?: string;
}
/**
* Use the real on-disk filesystem for this realm.
*
* This legacy provider config is kept for backwards compatibility. New code
* should prefer explicit import rules where possible.
*
* ```ts no_run
* import { DiskFsConfig, Realm } from 'fino:realm';
*
* new Realm({
*   entry: './worker.ts',
*   providers: { fs: new DiskFsConfig({ root: '/srv/app' }) },
* });
* ```
*/
export class DiskFsConfig {
  /**
  * Provider discriminator serialized by `toJSON()`.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * console.log(new DiskFsConfig().type);
  * ```
  */
  readonly type = 'disk' as const;
  /**
  * Options supplied to the disk filesystem provider.
  *
  * The object is stored as provided by the constructor. Omitted options are
  * represented by an empty object.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * const config = new DiskFsConfig({ root: '/tmp/app' });
  * console.log(config.options.root);
  * ```
  */
  readonly options: DiskFsOptions;
  /**
  * Create a disk filesystem provider config.
  *
  * The default options object is empty. Construction does not verify that the
  * root exists; provider setup handles filesystem failures later.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * const config = new DiskFsConfig({ root: '/srv/app' });
  * ```
  *
  * @param options Disk filesystem provider options.
  */
  constructor(options: DiskFsOptions = {}) {
    this.options = options;
  }
  /**
  * Serialize this provider config.
  *
  * The result includes the provider type and any configured options. It is
  * suitable for legacy config persistence, not for direct import-rule use.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * const json = new DiskFsConfig({ root: '/srv/app' }).toJSON();
  * ```
  */
  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      ...this.options
    };
  }
  /**
  * Recreate a disk provider config from serialized data.
  *
  * Unknown keys are ignored. Missing `root` produces a config with default
  * options.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * const config = DiskFsConfig.fromJSON({ type: 'disk', root: '/srv/app' });
  * ```
  *
  * @param json Serialized provider data.
  */
  static fromJSON(json: Record<string, unknown>): DiskFsConfig {
    return new DiskFsConfig({ root: json['root'] as string | undefined });
  }
  /**
  * Convert this provider config into import rules.
  *
  * Disk filesystem config inherits the runtime file bindings, matching the
  * legacy system default behavior.
  *
  * ```ts no_run
  * import { DiskFsConfig } from 'fino:realm';
  *
  * const rules = new DiskFsConfig().toRules();
  * ```
  *
  * @internal
  */
  toRules(): ImportRule[] {
    // Empty source_map + empty code would have reset to BUILTINS in the old
    // system. In the new system we emit Inherit, which drops from the child
    // specific list so the parent's rule applies (same effect for root realms).
    return [{
      pattern: 'internal:file/bindings',
      directive: 'inherit'
    }];
  }
}
/**
* Use the system network stack for this realm.
*
* This legacy provider config maps the network provider import back to the
* inherited system provider.
*
* ```ts no_run
* import { Realm, SystemNetConfig } from 'fino:realm';
*
* new Realm({ entry: './worker.ts', providers: { net: new SystemNetConfig() } });
* ```
*/
export class SystemNetConfig {
  /**
  * Provider discriminator serialized by `toJSON()`.
  *
  * ```ts no_run
  * import { SystemNetConfig } from 'fino:realm';
  *
  * console.log(new SystemNetConfig().type);
  * ```
  */
  readonly type = 'system-net' as const;
  /**
  * Serialize this provider config.
  *
  * The result has no options because the system network provider has no
  * JS-visible configuration in this compatibility layer.
  *
  * ```ts no_run
  * import { SystemNetConfig } from 'fino:realm';
  *
  * const json = new SystemNetConfig().toJSON();
  * ```
  */
  toJSON(): Record<string, unknown> {
    return { type: this.type };
  }
  /**
  * Recreate a system network provider config from serialized data.
  *
  * The input is accepted for compatibility and otherwise ignored.
  *
  * ```ts no_run
  * import { SystemNetConfig } from 'fino:realm';
  *
  * const config = SystemNetConfig.fromJSON({ type: 'system-net' });
  * ```
  */
  static fromJSON(_json: Record<string, unknown>): SystemNetConfig {
    return new SystemNetConfig();
  }
  /**
  * Convert this provider config into import rules.
  *
  * System network config inherits the runtime network provider.
  *
  * ```ts no_run
  * import { SystemNetConfig } from 'fino:realm';
  *
  * const rules = new SystemNetConfig().toRules();
  * ```
  *
  * @internal
  */
  toRules(): ImportRule[] {
    return [{
      pattern: 'internal:net/provider',
      directive: 'inherit'
    }];
  }
}
/**
* Use the system DNS resolver for this realm.
*
* This legacy provider config maps DNS provider imports back to the inherited
* system resolver.
*
* ```ts no_run
* import { Realm, SystemDnsConfig } from 'fino:realm';
*
* new Realm({ entry: './worker.ts', providers: { dns: new SystemDnsConfig() } });
* ```
*/
export class SystemDnsConfig {
  /**
  * Provider discriminator serialized by `toJSON()`.
  *
  * ```ts no_run
  * import { SystemDnsConfig } from 'fino:realm';
  *
  * console.log(new SystemDnsConfig().type);
  * ```
  */
  readonly type = 'system-dns' as const;
  /**
  * Serialize this provider config.
  *
  * The result has no options because the system DNS provider has no
  * JS-visible configuration in this compatibility layer.
  *
  * ```ts no_run
  * import { SystemDnsConfig } from 'fino:realm';
  *
  * const json = new SystemDnsConfig().toJSON();
  * ```
  */
  toJSON(): Record<string, unknown> {
    return { type: this.type };
  }
  /**
  * Recreate a system DNS provider config from serialized data.
  *
  * The input is accepted for compatibility and otherwise ignored.
  *
  * ```ts no_run
  * import { SystemDnsConfig } from 'fino:realm';
  *
  * const config = SystemDnsConfig.fromJSON({ type: 'system-dns' });
  * ```
  */
  static fromJSON(_json: Record<string, unknown>): SystemDnsConfig {
    return new SystemDnsConfig();
  }
  /**
  * Convert this provider config into import rules.
  *
  * System DNS config inherits the runtime DNS provider.
  *
  * ```ts no_run
  * import { SystemDnsConfig } from 'fino:realm';
  *
  * const rules = new SystemDnsConfig().toRules();
  * ```
  *
  * @internal
  */
  toRules(): ImportRule[] {
    return [{
      pattern: 'internal:net/dns-provider',
      directive: 'inherit'
    }];
  }
}
// ---------------------------------------------------------------------------
// Realm options
// ---------------------------------------------------------------------------
/**
* Legacy provider overrides installed in a child realm.
*
* Prefer `RealmOptions.overrides` with explicit import rules for new code.
* Unspecified providers are inherited from the parent realm.
*
* ```ts no_run
* import { DiskFsConfig, type RealmProviders } from 'fino:realm';
*
* const providers: RealmProviders = {
*   fs: new DiskFsConfig({ root: '/srv/app' }),
* };
* ```
*/
export interface RealmProviders {
  /**
  * Filesystem provider override.
  *
  * When omitted, filesystem bindings are inherited. This compatibility field
  * currently supports the disk filesystem provider config.
  *
  * ```ts no_run
  * import { DiskFsConfig, type RealmProviders } from 'fino:realm';
  *
  * const providers: RealmProviders = { fs: new DiskFsConfig() };
  * ```
  */
  fs?: DiskFsConfig;
  /**
  * Network provider override.
  *
  * When omitted, network provider bindings are inherited.
  *
  * ```ts no_run
  * import { SystemNetConfig, type RealmProviders } from 'fino:realm';
  *
  * const providers: RealmProviders = { net: new SystemNetConfig() };
  * ```
  */
  net?: SystemNetConfig;
  /**
  * DNS provider override.
  *
  * When omitted, DNS provider bindings are inherited.
  *
  * ```ts no_run
  * import { SystemDnsConfig, type RealmProviders } from 'fino:realm';
  *
  * const providers: RealmProviders = { dns: new SystemDnsConfig() };
  * ```
  */
  dns?: SystemDnsConfig;
}
/**
* Options for constructing and running a child realm.
*
* `process: true` requests an OS-process isolation boundary. Without it, node
* orchestration places the realm on a reactor. Placement is intentionally not
* exposed as a construction option.
*
* ```ts no_run
* import { Realm, type RealmOptions } from 'fino:realm';
*
* const options: RealmOptions = { entry: './worker.ts' };
* const realm = new Realm(options);
* ```
*/
export interface RealmOptions {
  /**
  * Path to the entry module to evaluate in the child realm.
  *
  * The path is resolved by the runtime loader using the realm root and import
  * rules. The module may default-export a function for `Realm.call()`.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './worker.ts' };
  * ```
  */
  entry: string;
  /**
  * Filesystem root for module resolution.
  *
  * When omitted, the child inherits the parent's root. The root affects module
  * lookup and any providers that consult realm root state.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './worker.ts', root: '/srv/app' };
  * ```
  */
  root?: string;
  /**
  * Import rules for this Realm. Appended after the parent's rules;
  * last-match-wins. Use `ImportMap.deny([...])` or `ImportMap.inherit([...])`.
  *
  * ```ts no_run
  * import { ImportMap, type RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = {
  *   entry: './worker.ts',
  *   overrides: ImportMap.deny([{ pattern: './api.ts', directive: 'inherit' }]),
  * };
  * ```
  */
  overrides?: ImportMap | ImportRule[];
  /**
  * @deprecated Use `overrides` with explicit ImportRule entries instead.
  * Override specific I/O providers. Unspecified providers are inherited.
  *
  * ```ts no_run
  * import { DiskFsConfig, type RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = {
  *   entry: './worker.ts',
  *   providers: { fs: new DiskFsConfig() },
  * };
  * ```
  */
  providers?: RealmProviders;
  /**
  * @deprecated Use `overrides` with `{ pattern, directive: 'block' }` instead.
  * Module specifiers that should throw on import in the child Realm.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = {
  *   entry: './worker.ts',
  *   blocked: ['fino:process'],
  * };
  * ```
  */
  blocked?: string[];
  /**
  * If true, spawn the child Realm as a separate OS process for hard crash
  * isolation and OS-level sandbox enforcement. Messaging uses framed binary
  * over a Unix socketpair. This is an isolation boundary orchestration must
  * honor, not a placement hint — plain realms are placed on a reactor
  * automatically.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './worker.ts', process: true };
  * ```
  */
  process?: boolean;
  /**
  * If true, automatically restart the child Realm whenever any file it
  * imported changes on disk. The JS `Realm` instance is stable across
  * reloads; only the underlying V8 context / thread / process is replaced.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './worker.ts', watch: true };
  * ```
  */
  watch?: boolean;
  /**
  * If true, run this child Realm in REPL mode. The child listens for
  * `{ __eval, id, code }` messages on its port and responds with
  * `{ __eval_result }` or `{ __eval_error }`. It is not compatible with
  * process isolation or watch mode.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './repl-host.ts', repl: true };
  * ```
  */
  repl?: boolean;
  /**
  * Arbitrary JSON-serializable configuration delivered to the child realm.
  * The child reads it via `internal:realm-bridge.getRealmData()` before the
  * entry module is imported, so it can shape application-specific worker
  * configuration. Runtime bootstrap metadata such as `otlpEndpoint` is stored
  * separately and does not appear here.
  *
  * ```ts no_run
  * import type { RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = { entry: './worker.ts', data: { role: 'ingest' } };
  * ```
  */
  data?: unknown;
  /**
  * OTLP/HTTP collector endpoint for CLI OpenTelemetry bootstrap in this realm.
  *
  * When omitted, the child inherits the current realm's CLI endpoint, if one
  * was seeded by `fino run --otlp-endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT`.
  * Passing a non-empty string overrides that endpoint for this realm. Passing
  * `false` disables CLI OpenTelemetry bootstrap for this realm even when the
  * parent has an endpoint. The endpoint is runtime bootstrap metadata and does
  * not appear in `RealmOptions.data` or `getRealmData()`.
  *
  * ```ts no_run
  * import { Realm, type RealmOptions } from 'fino:realm';
  *
  * const options: RealmOptions = {
  *   entry: './worker.ts',
  *   otlpEndpoint: 'http://127.0.0.1:4318',
  * };
  * ```
  */
  otlpEndpoint?: string | false;
}

/** Replica bounds and stabilization windows for a `RealmDeployment`. */
export interface RealmDeploymentScalingOptions {
  /** Availability minimum. Defaults to one and must not exceed `max`. */
  min?: number;
  /** Replica ceiling. When omitted, follows aggregate eligible cluster capacity. */
  max?: number;
  /** Queue-pressure stabilization window before adding a replica. Defaults to 1 second. */
  scaleUpWindowMs?: number;
  /** Quiet stabilization window before draining an excess replica. Defaults to 30 seconds. */
  scaleDownWindowMs?: number;
}

/** Options for a replicated deployment of independent realms. */
export type RealmDeploymentOptions = Omit<RealmOptions, 'process' | 'watch' | 'repl'> & {
  /** Process isolation is one-to-one and therefore only supported by `Realm`. */
  process?: never;
  /** Replica-count and queue-pressure policy. */
  scaling?: RealmDeploymentScalingOptions;
};
/**
* Options for creating a Realm from in-memory entrypoint source.
*
* Source realms run the provided text as a normal ESM entry module, so static
* imports, type imports, and top-level await behave the same as file-backed
* entries. `watch` is intentionally unavailable because there is no entry file
* to monitor; use a file-backed `Realm` when entrypoint reloads are required.
*
* ```ts
* import { Realm } from 'fino:realm';
*
* const realm = Realm.fromSource(`
*   import { basename } from 'fino:file/path';
*
*   if (basename('/tmp/example.ts') !== 'example.ts') {
*     throw new Error('unexpected basename');
*   }
* `);
* await realm.run();
* ```
*/
export interface RealmSourceOptions extends Omit<RealmOptions, 'entry' | 'watch'> {
  /**
  * Module specifier assigned to the source entry.
  *
  * When omitted, Fino generates a unique `fino:realm/source/...` specifier.
  * Provide an absolute file path or `file://` URL when relative imports inside
  * the source should resolve from a specific directory.
  */
  specifier?: string;
  /**
  * Optional source map JSON for the provided source text.
  *
  * Invalid or empty source maps are ignored by the runtime. The value defaults
  * to an empty string, matching other source import directives.
  */
  sourceMap?: string;
}
// ---------------------------------------------------------------------------
// Entry function type constraint
// ---------------------------------------------------------------------------
/**
* Function shape used by `Realm.call()`.
*
* A child entry module should default-export a function compatible with this
* type when the parent intends to call it. Arguments and return values must be
* supported by the active transport serializer.
*
* ```ts no_run
* import type { RealmFn } from 'fino:realm';
*
* const worker: RealmFn = (name: string) => `hello ${name}`;
* export default worker;
* ```
*/
export type RealmFn = (...args: any[]) => any;
// ---------------------------------------------------------------------------
// ProcessPort - cross-process transport (mirrors ThreadPort)
// ---------------------------------------------------------------------------
/**
* ProcessPort wraps the process realm native functions with the same event-loop
* integration as ThreadPort: register the wake-fd with loop.readable(), drain
* messages on each wake, dispatch as MessageEvents.
*
* Process ports are created by `new Realm({ process: true })`; application code
* normally uses the port through `realm.port`. Posting to a closed port is a
* no-op. Only transferable `ArrayBuffer` values are extracted from transfer
* lists.
*
* ```ts no_run
* import { Realm } from 'fino:realm';
*
* const realm = new Realm({ entry: './worker.ts', process: true });
* realm.port.postMessage({ ready: true });
* realm.port.start();
* ```
*/
export class ProcessPort extends ThreadPort {
  /** Resolves when the process-hosted reactor exits or asks to reload. */
  readonly finished: Promise<'released' | 'reload'>;
  #resolveFinished!: (reason: 'released' | 'reload') => void;
  #rejectFinished!: (error: unknown) => void;
  #finished = false;
  #handle: number;
  /**
  * Create a process transport port from native process realm handles.
  *
  * This constructor is part of the runtime bridge. Prefer constructing a
  * process realm and using its `port`; invalid handles can break event-loop
  * integration or fail native sends.
  *
  * ```ts no_run
  * import { ProcessPort } from 'fino:realm';
  *
  * const port = new ProcessPort(wakeReadFd, transitHandle, nativeHandle);
  * port.start();
  * ```
  *
  * @param wakeReadFd Readable file descriptor used to wake the event loop.
  * @param transitHandle Parent-side transit endpoint.
  * @param handle Native process status handle.
  */
  constructor(wakeReadFd: number, transitHandle: number, handle: number) {
    super(wakeReadFd, transitHandle);
    this.#handle = handle;
    this.finished = new Promise((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });
  }
  /**
  * Serialize and send a message to the process realm.
  *
  * Messages use the runtime serializer. Transfer lists may include
  * `ArrayBuffer` instances. Other transferable values, including
  * `MessagePort`, are rejected because process-realm transport cannot move
  * live in-process handles across the process boundary. Calling after
  * `close()` returns without sending.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * const realm = new Realm({ entry: './worker.ts', process: true });
  * realm.port.postMessage({ job: 'start' });
  * ```
  *
  * @param message Value to serialize and send.
  * @param transferOrOpts Optional transfer list or structured serialize options.
  */
  postMessage(message: any, transferOrOpts?: Transferable[] | StructuredSerializeOptions): void {
    if (this._closed) return;
    const rawTransfer = Array.isArray(transferOrOpts) ? transferOrOpts as Transferable[] : (transferOrOpts as StructuredSerializeOptions | undefined)?.transfer;
    const unsupported = rawTransfer?.find((t) => !(t instanceof ArrayBuffer));
    if (unsupported !== undefined) {
      throw new TypeError('ProcessPort transfer list only supports ArrayBuffer values');
    }
    super.postMessage(message, transferOrOpts);
  }
  protected override _afterDrain(): void {
    this.#checkFinished();
  }
  #checkFinished(): void {
    if (this.#finished) return;
    try {
      const alive = stepProcessContext(this.#handle) as boolean | null;
      if (alive === true) return;
      this.#finished = true;
      this.#resolveFinished(alive === null ? 'reload' : 'released');
    } catch (error) {
      this.#finished = true;
      this.#rejectFinished(error);
    }
  }
}
let _nextSourceRealmId = 0;

interface ScheduledRealmInstance {
  allocation: ScheduledRealmAllocation;
  port: ThreadPort;
}

interface ProcessRealmConfig {
  root: string;
  entry: string;
  rules: string;
  watch: boolean;
  data?: string;
  bootstrapData?: string;
}
// ---------------------------------------------------------------------------
// call() response helpers
// ---------------------------------------------------------------------------
/**
* Decode a `{ __call_error, message?, stack? }` response or resolve with
* the raw data value. Centralised to avoid duplicating the error-extraction
* block across scheduled and process-isolated `call()` branches.
*/
function _resolveCallResponse<R>(data: unknown, resolve: (v: R) => void, reject: (err: unknown) => void): void {
  if (data && typeof data === 'object' && (data as {
    __call_error?: boolean;
  }).__call_error) {
    const d = data as {
      message?: string;
      name?: string;
      stack?: string;
    };
    const err = new Error(d.message ?? 'Realm call failed');
    if (d.name !== undefined) err.name = d.name;
    if (d.stack !== undefined) err.stack = d.stack;
    reject(err);
  } else {
    const result = data && typeof data === 'object' && (data as { __call_result?: boolean }).__call_result
      ? (data as { result?: unknown }).result
      : data;
    resolve(result as R);
  }
}

function _matchesCallResponse(data: unknown, correlationId: number): boolean {
  if (!data || typeof data !== 'object') return false;
  const message = data as { __call_result?: boolean; __call_error?: boolean; correlationId?: number };
  return (message.__call_result === true || message.__call_error === true) && message.correlationId === correlationId;
}

function _releaseFailure(reason: string): Error | null {
  if (reason.startsWith('failed')) return new Error(reason.replace(/^failed: ?/, '') || reason);
  if (/^(setup_failed|reactor-workload-panicked|reactor-recovery-failed)/.test(reason)) return new Error(reason);
  return null;
}

/** Run one correlated call over either physical Realm transport. */
function _callThroughPort<R>(
  port: BaseTransportPort,
  terminal: Promise<unknown>,
  correlationId: number,
  args: unknown[]
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    let settled = false;
    let terminalTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      port.removeEventListener('message', handler);
      if (terminalTimer !== null) clearTimeout(terminalTimer);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const handler = (event: Event) => {
      const data = (event as MessageEvent).data;
      if (!_matchesCallResponse(data, correlationId)) return;
      settle(() => _resolveCallResponse(data, resolve, reject));
    };
    terminal.then((value) => {
      terminalTimer = setTimeout(() => settle(() => {
        const failure = typeof value === 'string' ? _releaseFailure(value) : null;
        reject(failure ?? new Error('Realm exited before returning a call result'));
      }), 25);
    }, (error) => settle(() => reject(error)));
    port.addEventListener('message', handler);
    port.start();
    try {
      port.postMessage({ __call: true, correlationId, args });
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
// ---------------------------------------------------------------------------
// Realm class
// ---------------------------------------------------------------------------
/**
* Isolated child realm with its own module graph and communication port.
*
* Ordinary realms run on a reactor thread. Process-isolated
* realms use the same API with a separate OS process boundary. Use `run()` for
* entry modules with side effects and `call()` for callable entry modules.
*
* ```ts no_run
* import { Realm } from 'fino:realm';
*
* const realm = new Realm<(name: string) => string>({ entry: './worker.ts' });
* const message = await realm.call('Ana');
* realm.terminate();
* ```
*/
export class Realm<F extends RealmFn = RealmFn> {
  /** Whether this logical Realm should keep its owner alive while idle. */
  #referenced = true;
  #nextCallId = 0;
  #activeCalls = 0;
  #idleCallTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #processIsolated: boolean;
  /**
  * Parent-side port for general communication with the child realm.
  *
  * Reactor realms expose a `ThreadPort`; process-isolated realms expose a
  * `ProcessPort`. Start the port before listening for messages.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * const realm = new Realm({ entry: './worker.ts' });
  * realm.port.addEventListener('message', (event) => console.log(event.data));
  * realm.port.start();
  * ```
  */
  readonly port: MessagePort | BaseTransportPort;
  #watchMode = false;
  /** The one physical scheduled execution container owned by this Realm. */
  #scheduled: ScheduledRealmInstance | null = null;
  #scheduledReady: Promise<ScheduledRealmInstance> | null = null;
  #lastScheduledRelease: Promise<string> | null = null;
  #scheduledConfig: Parameters<typeof placeScheduledRealm>[0] | null = null;
  #terminated = false;
  #facades: Facade[] = [];
  #processConfig: ProcessRealmConfig | null = null;
  // For thread/process watch mode: tracks the current child's port so that
  // terminate() reaches the most-recently-spawned child, not the original one.
  /**
  * Private property `#activeChildPort` used by `Realm`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #activeChildPort = undefined;
  *
  *   readInternalState() {
  *     return this.#activeChildPort;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #activeChildPort: ProcessPort | null = null;
  /**
  * Resolves after this Realm's execution container has been allocated.
  *
  * Allocation failures reject this promise. Evaluation and call failures are
  * reported by `run()` and `call()` instead.
  */
  readonly ready: Promise<void>;
  /**
  * Create a Realm whose entrypoint is in-memory module source.
  *
  * The source is installed as an import-rule-backed entry module and then
  * evaluated by the same Realm machinery used for file entries. Caller import
  * rules, provider overrides, blocked specifiers, and execution mode options
  * are preserved. Source entries cannot use `watch` because there is no entry
  * file to monitor for changes.
  *
  * ```ts
  * import { Realm } from 'fino:realm';
  *
  * const realm = Realm.fromSource(`
  *   await Promise.resolve();
  *   globalThis.value = 42;
  * `);
  * await realm.run();
  * ```
  *
  * @param source Entrypoint module source text.
  * @param options Realm options excluding file entry and watch mode.
  */
  static fromSource<F extends RealmFn = RealmFn>(source: string, options: RealmSourceOptions = {}): Realm<F> {
    if ((options as RealmSourceOptions & {
      watch?: boolean;
    }).watch !== undefined) {
      throw new Error('fino:realm — watch is not supported for source entrypoints');
    }
    const specifier = options.specifier ?? `fino:realm/source/${_nextSourceRealmId++}.ts`;
    const transpiled = transpileTypeScript(source, {
      filename: specifier,
      sourceType: 'ts'
    });
    if (!transpiled.ok) {
      throw new Error(transpiled.errors.map((error) => error.message).join('\n') || 'Unable to transpile Realm source');
    }
    const rules: ImportRule[] = [];
    if (options.overrides) {
      const src = options.overrides instanceof ImportMap ? options.overrides.toRules() : options.overrides;
      rules.push(...src);
    } else {
      if (options.providers) {
        const { fs, net, dns } = options.providers;
        if (fs) rules.push(...fs.toRules());
        if (net) rules.push(...net.toRules());
        if (dns) rules.push(...dns.toRules());
      }
      if (options.blocked) {
        for (const spec of options.blocked) rules.push({
          pattern: spec,
          directive: 'block'
        });
      }
    }
    rules.push({
      pattern: specifier,
      directive: {
        type: 'source',
        code: transpiled.code,
        source_map: options.sourceMap ?? transpiled.map ?? ''
      }
    });
    const { specifier: _specifier, sourceMap: _sourceMap, providers: _providers, blocked: _blocked, ...realmOptions } = options;
    return new Realm<F>({
      ...realmOptions,
      entry: specifier,
      overrides: rules
    });
  }
  /**
  * Create a child realm and its parent-side communication port.
  *
  * The constructor builds import rules, creates the selected execution mode,
  * and binds facade RPC dispatchers. It throws for invalid option
  * combinations or native creation failures.
  *
  * ```ts no_run
  * import { ImportMap, Realm } from 'fino:realm';
  *
  * const realm = new Realm({
  *   entry: './worker.ts',
  *   overrides: ImportMap.inherit([]),
  * });
  * ```
  *
  * @param opts Realm construction and loader options.
  */
  constructor(opts: RealmOptions) {
    if ('scaling' in opts) {
      throw new TypeError('fino:realm — scaling belongs to RealmDeployment');
    }
    this.#processIsolated = opts.process === true;
    const watch = opts.watch ?? false;
    const repl = opts.repl ?? false;
    if (repl && (opts.process || opts.watch)) {
      throw new Error('fino:realm — repl: true is not supported with process or watch realms');
    }
    // Build the child-specific rule list from overrides / legacy providers+blocked.
    const rules: ImportRule[] = [];
    if (opts.overrides) {
      const src = opts.overrides instanceof ImportMap ? opts.overrides.toRules() : opts.overrides;
      rules.push(...src);
    } else {
      if (opts.providers) {
        const { fs, net, dns } = opts.providers;
        if (fs) rules.push(...fs.toRules());
        if (net) rules.push(...net.toRules());
        if (dns) rules.push(...dns.toRules());
      }
      if (opts.blocked) {
        for (const spec of opts.blocked) rules.push({
          pattern: spec,
          directive: 'block'
        });
      }
    }
    if (repl) {
      rules.push({
        pattern: 'internal:repl-handler',
        directive: 'inherit'
      });
    }
    this.#facades = [...new Set(rules.flatMap((rule) => rule.directive instanceof Facade ? [rule.directive] : []))];
    const serializedRules = rules.length > 0 ? serialiseRules(rules) : '[]';
    const serializedData = serializeRealmData(opts.data);
    const serializedBootstrapData = serializeRealmBootstrapData(opts);
    this.#watchMode = watch;
    if (opts.process) {
      this.#processConfig = {
        root: opts.root ?? '',
        entry: opts.entry,
        rules: serializedRules,
        watch,
        ...serializedData !== undefined ? { data: serializedData } : {},
        ...serializedBootstrapData !== undefined ? { bootstrapData: serializedBootstrapData } : {}
      };
      const processPort = this.#createProcessPort();
      this.#activeChildPort = processPort;
      this.port = new DeferredTransportPort(processPort);
      this.ready = Promise.resolve();
    } else {
      const mergedRules = mergeChildRules(serializedRules) as string;
      const scheduledConfig: Parameters<typeof placeScheduledRealm>[0] = {
        entry: opts.entry,
        rulesJson: mergedRules,
        ...serializedData !== undefined ? { realmData: serializedData } : {},
        ...serializedBootstrapData !== undefined ? { bootstrapData: serializedBootstrapData } : {},
        watch,
        repl
      };
      this.#scheduledConfig = scheduledConfig;
      const created = this.#createScheduledInstance();
      if (created instanceof Promise) {
        const pending = created.finally(() => { this.#scheduledReady = null; });
        this.#scheduledReady = pending;
        this.ready = pending.then(() => undefined);
        this.port = new DeferredTransportPort(pending.then((instance) => instance.port));
      } else {
        this.ready = Promise.resolve();
        this.port = new DeferredTransportPort(created.port);
      }
    }
    // Emit OTel realm spawn event (gated on hasSubscribers to avoid cost in
    // the common case where no OTel subscriber is registered).
    if (_topicRealmSpawn.hasSubscribers) {
      _topicRealmSpawn.publish(otelRuntimeEvent('realm', 'spawn', 'start', {
        entry: opts.entry
      }));
    }
  }
  /** Spawn a fresh child handle using the stored watch opts. @internal */
  /**
  * Private method `#spawnChild` used by `Realm`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #spawnChild() {
  *     return 'spawnChild';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#spawnChild();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #createProcessPort(): ProcessPort {
    const config = this.#processConfig!;
    const info = createProcessContext(config.root, config.entry, config.rules, config.watch, config.data, config.bootstrapData) as {
      handle: number;
      portHandle: number;
      portWakeFd: number;
    };
    const port = new ProcessPort(info.portWakeFd, info.portHandle, info.handle);
    this.#bindFacadePort(port);
    void port.finished.then(() => {
      port.close();
      if (this.#activeChildPort === port) this.#activeChildPort = null;
    }, () => {
      port.close();
      if (this.#activeChildPort === port) this.#activeChildPort = null;
    });
    return port;
  }

  #ensureProcessPort(): ProcessPort {
    if (this.#terminated) throw new Error('Realm has been terminated');
    if (this.#activeChildPort !== null) return this.#activeChildPort;
    const port = this.#createProcessPort();
    this.#activeChildPort = port;
    (this.port as DeferredTransportPort).replace(port);
    return port;
  }

  #bindFacadePort(port: MessagePort | BaseTransportPort): void {
    for (const facade of this.#facades) facade._bind(port);
  }
  /**
  * Run the child realm to completion.
  *
  * The returned promise resolves when the child exits cleanly and rejects when
  * the child reports a runtime error. Watch-mode realms keep the promise
  * pending across reloads until `terminate()` stops watching.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * const realm = new Realm({ entry: './worker.ts' });
  * await realm.run();
  * ```
  */
  run(): Promise<void> {
    if (!this.#processIsolated) {
      if (this.#terminated) {
        const released = this.#lastScheduledRelease;
        if (released === null) return Promise.resolve();
        return released.then((reason) => {
          const failure = _releaseFailure(reason);
          if (failure !== null) throw failure;
        });
      }
      return (async () => {
        while (true) {
          const instance = await this.#ensureScheduledInstance();
          const reason = await instance.allocation.released;
          // The terminal pump may post a final user message and release in the
          // same slice. Drain transit synchronously before closing the physical
          // endpoint so release cannot win that race.
          instance.port._drain();
          this.#detachScheduledInstance(instance);
          const failure = _releaseFailure(reason);
          if (failure !== null) throw failure;
          if (reason !== 'reload' || this.#terminated) return;
          const next = await this.#ensureScheduledInstance();
          (this.port as DeferredTransportPort).replace(next.port);
        }
      })();
    }
    if (this.#watchMode) {
      return (async () => {
        let port = this.#ensureProcessPort();
        while (true) {
          port.start();
          const reason = await port.finished;
          if (reason !== 'reload' || this.#terminated) return;
          this.#activeChildPort = null;
          port = this.#ensureProcessPort();
        }
      })();
    }
    const processPort = this.#ensureProcessPort();
    processPort.start();
    return processPort.finished.then(() => undefined);
  }

  #createScheduledInstance(): ScheduledRealmInstance | Promise<ScheduledRealmInstance> {
    const placement = placeScheduledRealm(this.#scheduledConfig!);
    if (placement === null) throw new Error('fino:realm — local reactor capacity is exhausted');
    if (placement instanceof Promise) return placement.then((allocation) => this.#attachScheduledAllocation(allocation));
    return this.#attachScheduledAllocation(placement);
  }

  #attachScheduledAllocation(allocation: ScheduledRealmAllocation): ScheduledRealmInstance {
    const instance: ScheduledRealmInstance = {
      allocation,
      port: new ThreadPort(allocation.portWakeFd, allocation.portHandle)
    };
    this.#bindFacadePort(instance.port);
    this.#scheduled = instance;
    this.#lastScheduledRelease = allocation.released;
    void allocation.released.then(() => this.#detachScheduledInstance(instance));
    return instance;
  }

  async #ensureScheduledInstance(): Promise<ScheduledRealmInstance> {
    if (this.#terminated) throw new Error('Realm has been terminated');
    if (this.#scheduled !== null) return this.#scheduled;
    if (this.#scheduledReady === null) {
      const created = this.#createScheduledInstance();
      if (!(created instanceof Promise)) {
        (this.port as DeferredTransportPort).replace(created.port);
        return created;
      }
      this.#scheduledReady = created.finally(() => { this.#scheduledReady = null; });
    }
    const instance = await this.#scheduledReady;
    (this.port as DeferredTransportPort).replace(instance.port);
    return instance;
  }

  #retireScheduledInstance(instance: ScheduledRealmInstance, reason: string): void {
    if (instance.port.closed) instance.allocation.revoke(reason);
    else {
      instance.port.postMessage({ __terminate: true });
      instance.port.close();
    }
    this.#detachScheduledInstance(instance);
  }

  #detachScheduledInstance(instance: ScheduledRealmInstance): void {
    instance.port.close();
    if (this.#scheduled === instance) this.#scheduled = null;
  }

  async #callScheduled(correlationId: number, args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    const instance = await this.#ensureScheduledInstance();
    return _callThroughPort(instance.port, instance.allocation.released, correlationId, args);
  }
  /**
  * Call the child Realm's default-exported function with `args`.
  *
  * The call starts the realm, sends `{ __call: true, args }`, and resolves
  * with the returned value. It rejects if the realm exits before returning, if
  * the child serializes a call error, or if its reactor exits.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * const realm = new Realm<(a: number, b: number) => number>({ entry: './add.ts' });
  * const sum = await realm.call(2, 3);
  * ```
  */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    const correlationId = this.#nextCallId++;
    this.#activeCalls++;
    if (this.#idleCallTimer !== null) {
      clearTimeout(this.#idleCallTimer);
      this.#idleCallTimer = null;
    }
    const callStart = performance.now();
    // Capture at call time so the end event is always published when start was.
    const startPublished = _topicRealmCall.hasSubscribers;
    if (startPublished) {
      _topicRealmCall.publish(otelRuntimeEvent('realm', 'call', 'start'));
    }
    let base: Promise<Awaited<ReturnType<F>>>;
    if (!this.#processIsolated) {
      base = this.#callScheduled(correlationId, args);
    } else {
      try {
        const processPort = this.#ensureProcessPort();
        base = _callThroughPort(processPort, processPort.finished, correlationId, args);
      } catch (error) {
        base = Promise.reject(error);
      }
    }
    const observed = base.then((result) => {
      this.#finishCall();
      if (!startPublished && !_topicRealmCallEnd.hasSubscribers) return result;
      _topicRealmCallEnd.publish(otelRuntimeEvent('realm', 'call', 'end', {
        durationMs: performance.now() - callStart
      }));
      return result;
    }, (err: unknown) => {
      this.#finishCall();
      if (!startPublished && !_topicRealmCallEnd.hasSubscribers) throw err;
      _topicRealmCallEnd.publish(otelRuntimeEvent('realm', 'call', 'end', {
        durationMs: performance.now() - callStart,
        error: true
      }));
      throw err;
    });
    return observed;
  }
  #finishCall(): void {
    this.#activeCalls = Math.max(0, this.#activeCalls - 1);
    this.#scheduleIdleRetirement();
  }
  #scheduleIdleRetirement(): void {
    if (this.#activeCalls !== 0 || this.#referenced || this.#watchMode) return;
    this.#idleCallTimer = setTimeout(() => {
      this.#idleCallTimer = null;
      if (this.#activeCalls === 0 && !this.#referenced) this.#drainIdleDeployment();
    }, 0);
  }
  #drainIdleDeployment(): void {
    if (!this.#processIsolated) {
      const instance = this.#scheduled;
      if (instance !== null) this.#retireScheduledInstance(instance, 'idle');
      return;
    }
    const port = this.#activeChildPort;
    this.#activeChildPort = null;
    port?.postMessage({ __terminate: true });
  }
  /**
  * Signal the child realm to stop.
  *
  * Reactor and process-isolated realms receive a `__terminate` message. The
  * method is synchronous and does not wait for `run()` to settle.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * const realm = new Realm({ entry: './worker.ts' });
  * realm.terminate();
  * ```
  */
  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    if (!this.#processIsolated) {
      const scheduled = this.#scheduled;
      if (scheduled !== null) this.#retireScheduledInstance(scheduled, 'terminated');
      else void this.#scheduledReady?.then((instance) => this.#retireScheduledInstance(instance, 'terminated'));
    } else {
      this.#activeChildPort?.postMessage({ __terminate: true });
    }
  }
  /**
  * Keep this Realm's otherwise-idle execution container warm. Active calls and
  * `run()` retain their own work independently.
  */
  ref(): this {
    this.#referenced = true;
    if (!this.#processIsolated && this.#scheduled === null && !this.#terminated) {
      void this.#ensureScheduledInstance();
    } else if (this.#processIsolated && this.#activeChildPort === null && !this.#terminated) {
      this.#ensureProcessPort();
    }
    return this;
  }
  /**
  * Allow this Realm's idle execution container to drain without keeping its
  * owner alive. In-flight calls and a pending `run()` still retain their work.
  */
  unref(): this {
    this.#referenced = false;
    this.#scheduleIdleRetirement();
    return this;
  }
  /** Return whether this Realm has an explicit idle-liveness reference. */
  hasRef(): boolean {
    return this.#referenced;
  }
  /**
  * Explicit resource management hook.
  *
  * Disposing a realm calls `terminate()`. Use this with `using` declarations
  * where supported, or call `terminate()` directly in older code.
  *
  * ```ts no_run
  * import { Realm } from 'fino:realm';
  *
  * using realm = new Realm({ entry: './worker.ts' });
  * realm.port.postMessage('start');
  * ```
  */
  [Symbol.dispose](): void {
    this.terminate();
  }
}

/**
* A stable, replica-affine connection to a `RealmDeployment`.
*
* The session exclusively retains one physical realm until `close()` is called.
* Local reactor migration does not change that realm or its module heap.
*/
export class RealmSession<F extends RealmFn = RealmFn> {
  #lease: ReplicaLease<Realm<F>> | null;

  /**
  * Constructed internally by `RealmDeployment.connect()`.
  *
  * @internal
  */
  constructor(lease: ReplicaLease<Realm<F>>) {
    this.#lease = lease;
  }

  /**
  * Invoke the connected replica's default export.
  *
  * Calls reject after `close()` and otherwise have the same failure behavior
  * as `Realm.call()`.
  */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    if (this.#lease === null) return Promise.reject(new Error('RealmSession is closed'));
    return this.#lease.value.call(...args);
  }

  /** Release the replica back to the deployment. Idempotent. */
  close(): void {
    this.#lease?.release();
    this.#lease = null;
  }

  /** Close this session when leaving a `using` scope. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/**
* A scalable deployment of independent `Realm` execution containers.
*
* `call()` load-balances across ready replicas, `broadcast()` posts to every
* ready replica, and `connect()` reserves one stable replica for an affine
* session. Replica heaps are independent; use a single `Realm` when state must
* remain one-to-one.
*
* ```ts no_run
* import { RealmDeployment } from 'fino:realm';
*
* using workers = new RealmDeployment({
*   entry: './worker.ts',
*   scaling: { min: 2, max: 8 },
* });
* const result = await workers.call({ job: 'thumbnail' });
* ```
*/
export class RealmDeployment<F extends RealmFn = RealmFn> {
  /**
  * Resolves when the deployment's minimum number of replicas is ready.
  *
  * It rejects if a minimum replica cannot be allocated or initialized.
  */
  readonly ready: Promise<void>;
  #controller: deployment.DeploymentController<Realm<F>>;
  #realmOptions: RealmOptions;
  #referenced = true;
  #terminated = false;

  /**
  * Create a referenced deployment and begin warming its minimum replicas.
  *
  * Process isolation, watch mode, and REPL mode are intentionally unavailable
  * because a deployment represents interchangeable independent replicas.
  */
  constructor(options: RealmDeploymentOptions) {
    if ((options as { process?: boolean }).process === true) {
      throw new TypeError('fino:realm — process isolation is only supported by Realm');
    }
    const { scaling, process: _process, ...realmOptions } = options;
    this.#realmOptions = realmOptions;
    this.#controller = clusterOrchestrator.createDeployment<Realm<F>>({
      scaling,
      create: async () => {
        const realm = new Realm<F>(this.#realmOptions);
        if (!this.#referenced) realm.unref();
        await realm.ready;
        return realm;
      },
      dispose: (realm) => realm.terminate()
    });
    this.ready = this.#controller.ready;
  }

  /**
  * Route one invocation to an available replica.
  *
  * The call waits when every replica is admitted. Sustained waiting may add a
  * replica up to `scaling.max`. It rejects after `terminate()` or when the
  * selected realm fails.
  */
  async call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    const lease = await this.#controller.acquire();
    try {
      return await lease.value.call(...args);
    } finally {
      lease.release();
    }
  }

  /**
  * Post an independently serialized message to every ready replica.
  *
  * This does not create replicas beyond those already ready and does not wait
  * for application-level acknowledgement.
  */
  async broadcast(message: unknown): Promise<void> {
    const leases = await this.#controller.acquireAll();
    try {
      for (const lease of leases) lease.value.port.postMessage(message);
    } finally {
      for (const lease of leases) lease.release();
    }
  }

  /**
  * Reserve one stable replica until the returned session is closed.
  *
  * The returned session remains attached to the same realm even if node
  * orchestration moves that realm between local reactor threads.
  */
  async connect(): Promise<RealmSession<F>> {
    return new RealmSession(await this.#controller.acquire());
  }

  /** Keep idle deployment replicas allocated. */
  ref(): this {
    this.#referenced = true;
    for (const realm of this.#controller.values()) realm.ref();
    return this;
  }

  /** Allow idle replicas to retire without cancelling active work. */
  unref(): this {
    this.#referenced = false;
    for (const realm of this.#controller.values()) realm.unref();
    return this;
  }

  /** Return whether the deployment retains idle replicas. */
  hasRef(): boolean {
    return this.#referenced;
  }

  /** Terminate every replica and reject future admission. */
  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#controller.terminate();
  }

  /** Terminate this deployment when leaving a `using` scope. */
  [Symbol.dispose](): void {
    this.terminate();
  }
}
