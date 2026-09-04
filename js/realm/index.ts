/**
 * fino:realm - Realm construction and management.
 *
 * A Realm is an isolated V8 Context with its own global object, module graph,
 * microtask queue, and event loop. The parent's import rule list governs every
 * module resolution in the child; the child can layer overrides on top.
 *
 * Ordinary Realms in the current process run as movable isolates on the shared
 * reactor thread pool. Linux sandbox Realms instead own a fixed thread so
 * cgroup v2 threaded controls, Landlock, and seccomp can govern that workload.
 * Both local modes provide JavaScript/module isolation rather than a hostile
 * operating-system boundary: they share the process address space and
 * file-descriptor table. Process realms add hard crash isolation but do not
 * automatically restrict the child's access to the host. Remote realms run on
 * another node's reactor pool over the current trusted `fino:cluster`
 * WebTransport transport and require an active cluster before construction.
 * Cluster authentication, hostile-peer handling, and remote `watch` / `repl`
 * modes are outside this baseline.
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
import {
  createSandboxContext,
  stepSandboxContext,
  forceSandboxContext,
  getSandboxPortWakeReadFd,
  createProcessContext,
  stepProcessContext,
  getProcessCompletionFd,
  getSandboxCompletionFd,
  processPortSend,
  processPortRecv,
  getProcessSocketFd,
  killProcessContext,
} from 'internal:realm-native';
import { getRealmBootstrapData } from 'internal:realm-bridge';
import { os } from 'internal:process';
import { MessagePort, type MessageEvent } from '../globals/messaging.ts';
import {
  createSandboxPort,
  createScheduledPort,
  RealmPort,
  type RealmLink,
} from 'internal:realm/transport-port';
import type {
  ProcessSandboxNetworkRule,
  ProcessSandboxOptions,
  ProcessSandboxResources,
} from '../process.ts';
import { readable, removeRead } from 'internal:runtime/loop';
import {
  closeScheduledRealm,
  createScheduledRealm,
  forceScheduledRealm,
  registerReactorWake,
  takeScheduledRealmStatus,
  usesProcessReadiness,
} from 'internal:scheduler-native';
import { serialize } from 'internal:serializer';
import { EnvelopeKind } from 'internal:realm/envelope';
import type { ClusterClient } from 'internal:cluster/client';
import { ClusterPort, getCluster } from 'fino:cluster';
import { topic, otelRuntimeTopic, otelRuntimeEvent } from '../internal/opentelemetry/common.ts';
import { registerShutdownHook } from '../internal/shutdown.ts';
import { transpile as transpileTypeScript } from '../format/typescript.ts';
import { createChildCoverageContext, type CoverageRealmContext } from 'internal:coverage';
import { UnboundedChannel } from '../internal/stream.ts';
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
export type ImportDirectiveSer =
  | 'inherit'
  | 'block'
  | {
      type: 'inherit';
    }
  | {
      type: 'block';
    }
  | {
      type: 'remap';
      target: string;
    }
  | {
      type: 'source';
      code: string;
      source_map: string;
    }
  | {
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
  if (d instanceof Facade)
    return d.toDirective() as {
      type: string;
      [k: string]: unknown;
    };
  if (typeof d === 'object' && 'type' in d)
    return d as {
      type: string;
      [k: string]: unknown;
    };
  return { type: 'inherit' };
}
/** Normalize a rule array to the plain values accepted by native bridges. */
function normaliseRules(rules: ImportRule[]): Record<string, unknown>[] {
  return rules.map((r) => ({
    ...(r.from !== undefined ? { from: r.from } : {}),
    pattern: r.pattern,
    directive: normaliseDirective(r.directive),
  }));
}
/** Serialise a rule array to the JSON string used by process realm bridges. */
function serialiseRules(rules: ImportRule[]): string {
  return JSON.stringify(normaliseRules(rules));
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
  sandbox?: ProcessSandboxOptions;
  coverage?: CoverageRealmContext;
}
function currentRealmBootstrapData(): RealmBootstrapData | undefined {
  const raw = (getRealmBootstrapData as () => string | undefined)();
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RealmBootstrapData) : undefined;
  } catch {
    return undefined;
  }
}
function realmKind(opts: RealmOptions): 'remote' | 'sandbox' | 'process' | 'scheduled' {
  if (opts.remote) return 'remote';
  if (opts.sandbox !== undefined) return 'sandbox';
  if (opts.process) return 'process';
  return 'scheduled';
}
function realmBootstrapData(opts: RealmOptions): RealmBootstrapData | undefined {
  const data: RealmBootstrapData = {};
  const kind = realmKind(opts);
  if (opts.sandbox !== undefined) data.sandbox = opts.sandbox;
  if (kind !== 'remote') {
    const coverage = createChildCoverageContext(kind, opts.entry ?? null);
    if (coverage !== undefined) data.coverage = coverage;
  }
  const endpointOption = opts.otlpEndpoint;
  if (endpointOption === false) return Object.keys(data).length === 0 ? undefined : data;
  if (opts.sandbox !== undefined && endpointOption === undefined) return data;
  let endpoint = '';
  if (typeof endpointOption === 'string') {
    endpoint = endpointOption.trim();
    if (!endpoint) throw new Error('fino:realm — otlpEndpoint must be a non-empty string or false');
  }
  if (!endpoint) {
    const inherited = currentRealmBootstrapData()?.cliOtel?.endpoint;
    endpoint = typeof inherited === 'string' ? inherited.trim() : '';
  }
  if (endpoint) data.cliOtel = { endpoint };
  return Object.keys(data).length === 0 ? undefined : data;
}
function serializeRealmBootstrapData(opts: RealmOptions): string | undefined {
  const data = realmBootstrapData(opts);
  return data === undefined ? undefined : JSON.stringify(data);
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
    return new ImportMap([
      {
        pattern: '*',
        directive: 'block',
      },
      ...overrides,
    ]);
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
    return new ImportMap([
      {
        pattern: '*',
        directive: 'inherit',
      },
      ...overrides,
    ]);
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
  readonly #sinks: Map<
    string,
    (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>
  >;
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
  constructor(
    scalar: Record<string, (...args: unknown[]) => unknown> = {},
    streams: Record<string, (...args: unknown[]) => AsyncIterable<unknown>> = {},
    sinks: Record<
      string,
      (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>
    > = {},
  ) {
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
// creates an unbounded channel whose reader acts as the `source: AsyncIterable`
// argument to the handler. Subsequent __rpc_send_chunk messages write into the
// channel; __rpc_send_end / __rpc_send_err close its writer.
//
// This is the symmetric counterpart to _StreamQueue in parent-rpc.ts (which
// buffers chunks flowing parent->child).  The pairing maps directly onto QUIC:
//   UnboundedChannel <- QUIC client-initiated unidirectional stream (child sends)
//   _StreamQueue  <-  QUIC server-initiated unidirectional stream (parent sends)
// ---------------------------------------------------------------------------
// portObj -> (reqId -> channel) for active write streams on this port.
const _portWriteSources = new WeakMap<object, Map<number, UnboundedChannel<unknown>>>();
function _getOrCreateWriteSourceRegistry(
  port: MessagePort | RealmPort | ProcessPort | ClusterPort,
): Map<number, UnboundedChannel<unknown>> {
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
function _getOrCreateHandleRegistry(
  port: MessagePort | RealmPort | ProcessPort | ClusterPort,
): Map<string, _HandleEntry> {
  const key = port as object;
  let reg = _portHandleRegistries.get(key);
  if (reg) return reg;
  reg = new Map<string, _HandleEntry>();
  _portHandleRegistries.set(key, reg);
  const registry = reg;
  const wsSources = _getOrCreateWriteSourceRegistry(port);
  const control = port as unknown as {
    _addControlHandler?(
      handler: (envelope: { kind: number; correlation: number }, value: unknown) => boolean,
    ): () => void;
    _postControl?(kind: number, correlation: number, message: unknown): void;
  };
  const reply = (kind: number, correlation: number, message: unknown): void => {
    control._postControl?.(kind, correlation, message);
  };
  const fail = (correlation: number, error: unknown): void => {
    reply(EnvelopeKind.RpcResponse, correlation, { error: String(error) });
  };
  // One shared dispatcher per port serves every handle method call.
  control._addControlHandler?.((envelope, value) => {
    const reqId = envelope.correlation;
    const body = (value ?? {}) as {
      specifier?: string;
      method?: string;
      args?: unknown[];
    };
    const isRequest =
      envelope.kind === EnvelopeKind.RpcRequest || envelope.kind === EnvelopeKind.SinkStart;
    if (!isRequest) return false;
    const entry = registry.get(body.specifier ?? '');
    if (!entry) return false;
    const method = body.method ?? '';
    const args = body.args ?? [];
    if (envelope.kind === EnvelopeKind.SinkStart) {
      const sinkFn = entry.sinks.get(method);
      if (!sinkFn) {
        fail(reqId, `No sendStream method '${method}' on handle '${body.specifier}'`);
        return true;
      }
      const source = new UnboundedChannel<unknown>();
      wsSources.set(reqId, source);
      sinkFn(args, source.reader).then(
        (result) => {
          wsSources.delete(reqId);
          _sendResult(port, registry, reqId, result);
        },
        (err: unknown) => {
          wsSources.delete(reqId);
          fail(reqId, err);
        },
      );
      return true;
    }
    const streamFn = entry.streams.get(method);
    if (streamFn) {
      let iter: AsyncIterable<unknown>;
      try {
        iter = streamFn(...args);
      } catch (err: unknown) {
        fail(reqId, err);
        return true;
      }
      void (async () => {
        try {
          for await (const chunk of iter) reply(EnvelopeKind.RpcChunk, reqId, chunk);
          reply(EnvelopeKind.RpcEnd, reqId, null);
        } catch (err: unknown) {
          reply(EnvelopeKind.RpcError, reqId, { error: String(err) });
        }
      })().catch(() => {});
      return true;
    }
    const scalarFn = entry.scalar.get(method);
    if (!scalarFn) {
      fail(reqId, `No method '${method}' on handle '${body.specifier}'`);
      return true;
    }
    new Promise<unknown>((res) => res(scalarFn(...args))).then(
      (result) => _sendResult(port, registry, reqId, result),
      (err: unknown) => fail(reqId, err),
    );
    return true;
  });
  return reg;
}
function _registerHandle(
  reg: Map<string, _HandleEntry>,
  h: FacadeHandle,
): {
  __handle: string;
  streams?: string[];
  sinks?: string[];
} {
  const id = `__h${_nextHandleSeq++}`;
  reg.set(id, {
    scalar: h._scalar(),
    streams: h._streams(),
    sinks: h._sinks(),
  });
  const sn = h._streamNames();
  const sk = h._sinkNames();
  return {
    __handle: id,
    ...(sn.length > 0 ? { streams: sn } : {}),
    ...(sk.length > 0 ? { sinks: sk } : {}),
  };
}
function _sendResult(
  port: {
    _postControl?(kind: number, correlation: number, message: unknown): void;
  },
  reg: Map<string, _HandleEntry>,
  reqId: number,
  result: unknown,
): void {
  const payload =
    result instanceof FacadeHandle ? { result: _registerHandle(reg, result) } : { result };
  port._postControl?.(EnvelopeKind.RpcResponse, reqId, payload);
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
  readonly #sinkHandlers = new Map<
    string,
    (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>
  >();
  /**
   * Create a facade for a synthetic module specifier.
   *
   * `exports` may predeclare scalar method names visible in the child module.
   * `handle()` also declares its method automatically, so callers building a
   * facade entirely through handlers may pass an empty array. Stream and sink
   * names are declared by `stream()` and `sendStream()`.
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
  static from(
    obj: object,
    opts: {
      specifier: string;
    },
  ): Facade {
    // Collect callable methods from both own properties (plain objects) and
    // prototype (class instances), excluding Object.prototype built-ins.
    const proto = Object.getPrototypeOf(obj);
    const protoNames =
      proto && proto !== Object.prototype
        ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor')
        : [];
    const ownNames = Object.getOwnPropertyNames(obj);
    const allNames = [...new Set([...protoNames, ...ownNames])];
    const exports = allNames.filter(
      (k) => typeof (obj as Record<string, unknown>)[k] === 'function',
    );
    const f = new Facade(opts.specifier, exports);
    for (const name of exports) {
      f.handle(
        name,
        (...args) => (obj as Record<string, unknown>)[name](...args) as Promise<unknown>,
      );
    }
    return f;
  }
  /**
   * Create a capability-scoped proxy for a service resolved at call time.
   *
   * Only `methods` are visible to the child, even when the resolved service has
   * a larger API. The resolver runs for every call, which supports lazily
   * initialized or replaceable services without a hand-written forwarding
   * handler per method. The original service remains the receiver expression.
   *
   * ```ts no_run
   * import { Facade } from 'fino:realm';
   *
   * let service: { ping(): Promise<string> } | undefined;
   * const facade = Facade.proxy(
   *   () => service ??= { async ping() { return 'pong'; } },
   *   { specifier: 'app:service', methods: ['ping'] },
   * );
   * ```
   */
  static proxy(
    resolve: () => object,
    opts: {
      /** Synthetic module specifier imported by the child Realm. */
      specifier: string;
      /** Explicit allowlist of service methods exposed to the child. */
      methods: string[];
    },
  ): Facade {
    const facade = new Facade(opts.specifier, []);
    for (const name of opts.methods) {
      facade.handle(name, (...args) => {
        const target = resolve() as Record<string, unknown>;
        const method = target[name];
        if (typeof method !== 'function') {
          throw new TypeError(`Facade target has no callable method '${name}'`);
        }
        return Reflect.apply(method, target, args) as Promise<unknown>;
      });
    }
    return facade;
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
    if (!this.#exports.includes(method)) this.#exports.push(method);
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
  sendStream(
    method: string,
    fn: (args: unknown[], source: AsyncIterable<unknown>) => Promise<unknown>,
  ): this {
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
      sinks: this.#sinks,
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
  _bind(port: MessagePort | RealmPort | ProcessPort | ClusterPort): void {
    const specifier = this.#specifier;
    const handlers = this.#handlers;
    const streamHandlers = this.#streamHandlers;
    const sinkHandlers = this.#sinkHandlers;
    const reg = _getOrCreateHandleRegistry(port);
    const wsSources = _getOrCreateWriteSourceRegistry(port);
    const control = port as unknown as {
      _addControlHandler?(
        handler: (envelope: { kind: number; correlation: number }, value: unknown) => boolean,
      ): () => void;
      _postControl?(kind: number, correlation: number, message: unknown): void;
    };
    const reply = (kind: number, correlation: number, message: unknown): void => {
      control._postControl?.(kind, correlation, message);
    };
    const fail = (correlation: number, error: unknown): void => {
      reply(EnvelopeKind.RpcResponse, correlation, { error: String(error) });
    };
    const streamOut = async (correlation: number, iterable: AsyncIterable<unknown>) => {
      try {
        for await (const chunk of iterable) reply(EnvelopeKind.RpcChunk, correlation, chunk);
        reply(EnvelopeKind.RpcEnd, correlation, null);
      } catch (err: unknown) {
        reply(EnvelopeKind.RpcError, correlation, { error: String(err) });
      }
    };
    control._addControlHandler?.((envelope, value) => {
      const reqId = envelope.correlation;
      const body = (value ?? {}) as {
        specifier?: string;
        method?: string;
        args?: unknown[];
      };
      switch (envelope.kind) {
        case EnvelopeKind.SinkStart: {
          if (body.specifier !== specifier) return false;
          const method = body.method as string;
          const args = body.args ?? [];
          const fn = sinkHandlers.get(method);
          if (!fn) {
            fail(reqId, `No sendStream handler for ${specifier}#${method}`);
            return true;
          }
          const source = new UnboundedChannel<unknown>();
          wsSources.set(reqId, source);
          fn(args, source.reader).then(
            (result) => {
              wsSources.delete(reqId);
              _sendResult(port, reg, reqId, result);
            },
            (err: unknown) => fail(reqId, err),
          );
          return true;
        }
        case EnvelopeKind.SinkChunk: {
          const source = wsSources.get(reqId);
          if (!source) return false;
          void source.writer.write(value);
          return true;
        }
        case EnvelopeKind.SinkEnd: {
          const source = wsSources.get(reqId);
          if (!source) return false;
          wsSources.delete(reqId);
          void source.writer.close();
          return true;
        }
        case EnvelopeKind.SinkError: {
          const source = wsSources.get(reqId);
          if (!source) return false;
          wsSources.delete(reqId);
          void source.writer.close((value as { error: Error }).error);
          return true;
        }
        case EnvelopeKind.RpcRequest:
          break;
        default:
          return false;
      }
      if (body.specifier !== specifier) return false;
      const method = body.method as string;
      const args = body.args ?? [];
      const streamFn = streamHandlers.get(method);
      if (streamFn) {
        let iterable: AsyncIterable<unknown>;
        try {
          iterable = streamFn(...args);
        } catch (err: unknown) {
          fail(reqId, err);
          return true;
        }
        void streamOut(reqId, iterable).catch(() => {});
        return true;
      }
      const handler = handlers.get(method);
      if (!handler) {
        fail(reqId, `No handler for ${specifier}#${method}`);
        return true;
      }
      new Promise<unknown>((res) => res(handler(...args))).then(
        (result) => {
          if (result instanceof FacadeHandle) {
            reply(EnvelopeKind.RpcResponse, reqId, { result: _registerHandle(reg, result) });
          } else if (_isAsyncIterable(result)) {
            void streamOut(reqId, result as AsyncIterable<unknown>).catch(() => {});
          } else {
            reply(EnvelopeKind.RpcResponse, reqId, { result });
          }
        },
        (err: unknown) => fail(reqId, err),
      );
      return true;
    });
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
      ...this.options,
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
    return [
      {
        pattern: 'internal:file/bindings',
        directive: 'inherit',
      },
    ];
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
    return [
      {
        pattern: 'internal:net/provider',
        directive: 'inherit',
      },
    ];
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
    return [
      {
        pattern: 'internal:net/dns-provider',
        directive: 'inherit',
      },
    ];
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
 * Strict Linux policy installed on a dedicated sandbox Realm thread.
 *
 * This uses the same policy vocabulary as strict process sandboxing, with
 * thread-specific limits enforced by `RealmOptions.sandbox`: CPU quota,
 * cpuset affinity, and pids use cgroup v2 threaded controllers; filesystem
 * rules use Landlock; syscall/process/network rules use seccomp. Per-thread
 * memory limits, exec, fork, best-effort mode, and async FFI are unavailable.
 *
 * ```ts no_run
 * import type { RealmSandboxOptions } from 'fino:realm';
 *
 * const sandbox: RealmSandboxOptions = {
 *   mode: 'strict',
 *   resources: { cpu: 0.5, cpus: '0-1', pids: 32 },
 *   network: { outbound: [{ action: 'deny' }] },
 * };
 * ```
 */
export type RealmSandboxOptions = Omit<
  ProcessSandboxOptions,
  'mode' | 'resources' | 'network' | 'process'
> & {
  /** Sandbox Realm policy is always strict and fails closed. */
  mode: 'strict';
  /** Thread-compatible cgroup v2 resource controls. */
  resources?: Omit<ProcessSandboxResources, 'memoryBytes'> & {
    /** Memory is a cgroup domain controller and cannot govern one thread. */
    memoryBytes?: never;
    /** Linux CPU list assigned through cgroup v2 cpuset, for example `0-3,6`. */
    cpus?: string;
  };
  /** Coarse seccomp network policy without destination, port, or protocol filters. */
  network?: {
    /** Whether the sandbox thread may use outbound socket syscalls. */
    outbound?: Array<Pick<ProcessSandboxNetworkRule, 'action'>>;
    /** Whether the sandbox thread may use inbound socket syscalls. */
    inbound?: Array<Pick<ProcessSandboxNetworkRule, 'action'>>;
  };
  /** Process creation is always disabled for an in-process sandbox Realm. */
  process?: {
    /** Must remain false because fork copies the host process. */
    allowFork?: false;
    /** Must remain false because exec replaces the host process. */
    allowExec?: false;
    /** Executable allowlists are unavailable when exec is disabled. */
    allowedBinaries?: [];
  };
};
/**
 * Options for constructing and running a child realm.
 *
 * Realms normally run as movable isolates on the process-wide reactor pool.
 * `sandbox` selects a fixed Linux thread with strict OS governance,
 * `process: true` selects a separate process, and `remote: true` routes the
 * realm to another cluster node.
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
   * Run this Realm on a dedicated Linux thread and install the requested
   * cgroup v2 threaded controls, Landlock filesystem policy, and seccomp
   * syscall policy before importing its entry module.
   *
   * Sandbox Realms are strict-only and mutually exclusive with `process` and
   * `remote`. They share the host process address space and inherited file
   * descriptors, so use a process Realm for hostile-code isolation.
   *
   * `resources.memoryBytes`, process exec/fork permission, `watch`, and `repl`
   * are rejected because those controls cannot be safely scoped to this fixed
   * thread lifecycle.
   *
   * ```ts no_run
   * import { Realm } from 'fino:realm';
   *
   * const realm = new Realm({
   *   entry: './worker.ts',
   *   sandbox: {
   *     mode: 'strict',
   *     resources: { cpu: 0.5, cpus: '0-1', pids: 32 },
   *     filesystem: { readonly: ['/srv/app'], writable: ['/tmp/work'] },
   *     network: { outbound: [{ action: 'deny' }] },
   *   },
   * });
   * ```
   */
  sandbox?: RealmSandboxOptions;
  /**
   * If true, spawn the child Realm as a separate OS process for hard crash
   * isolation. Messaging uses framed binary over a Unix socketpair.
   * Mutually exclusive with `remote`.
   *
   * ```ts no_run
   * import type { RealmOptions } from 'fino:realm';
   *
   * const options: RealmOptions = { entry: './worker.ts', process: true };
   * ```
   */
  process?: boolean;
  /**
   * If true, spawn the child Realm on a remote cluster node. Requires a
   * prior call to `startCluster()` or `joinCluster()` from `fino:cluster`.
   * Messaging uses the cluster PORT_MSG protocol over WebTransport.
   * Mutually exclusive with `process`.
   *
   * ```ts no_run
   * import type { RealmOptions } from 'fino:realm';
   *
   * const options: RealmOptions = { entry: './worker.ts', remote: true };
   * ```
   */
  remote?: boolean;
  /**
   * If true, automatically restart the child Realm whenever any file it
   * imported changes on disk. The JS `Realm` instance is stable across
   * reloads; only the underlying V8 isolate or process is replaced.
   * Not supported with `remote: true`.
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
   * `{ __eval_result }` or `{ __eval_error }`. Not compatible with `process`,
   * `remote`, or `watch`.
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
   * separately and does not appear here. Not supported with `remote: true`.
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
// ProcessPort - cross-process transport
// ---------------------------------------------------------------------------
/**
 * ProcessPort wraps the process realm native functions, registers its wake fd
 * with `loop.readable()`, drains messages on each wake, and dispatches
 * MessageEvents.
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
/**
 * Link to a realm running in a separate OS process.
 *
 * A process boundary cannot carry a transit channel, so live `MessagePort`
 * transfer is refused rather than silently producing a dead port.
 *
 * @internal
 */
function processRealmLink(handle: number, wakeFd: number): RealmLink {
  return {
    transport: 'process',
    wakeFd,
    supportsPortTransfer: false,
    send: (header, data, stores) =>
      (processPortSend as (h: number, hdr: Uint8Array, b: Uint8Array, s: Uint8Array[]) => void)(
        handle,
        header,
        data,
        stores,
      ),
    drain: () => _recvProcessMessages(handle),
  };
}

/**
 * MessagePort-compatible endpoint for a realm running in a separate process.
 *
 * Process ports are created by `new Realm({ process: true })`; application code
 * reaches one through `realm.port` rather than constructing it directly.
 *
 * ```ts no_run
 * import { Realm } from 'fino:realm';
 *
 * const realm = new Realm({ entry: './worker.ts', process: true });
 * realm.port.postMessage({ job: 'start' });
 * ```
 */
export class ProcessPort extends RealmPort {
  constructor(wakeReadFd: number, handle: number) {
    super(processRealmLink(handle, wakeReadFd));
  }
}
// ---------------------------------------------------------------------------
// Active children tracking
// ---------------------------------------------------------------------------
type RealmKind = 'scheduled' | 'sandbox' | 'process' | 'remote';
let _nextPortHandle = 0;
let _nextSourceRealmId = 0;
/**
 * Wait for a process realm to exit, resolving or rejecting its `run()` promise.
 *
 * A process realm signals completion on its own descriptor, so the parent parks
 * on that rather than polling. This used to be a 1ms `setInterval` that called
 * `stepProcessContext` on every active child — which only read an atomic flag —
 * and remote realms were tracked by the same interval despite being driven
 * entirely by cluster transport events, so they kept a 1000Hz timer alive to do
 * nothing at all.
 */
async function _awaitThreadChild(
  realm: {
    handle: number;
    kind: 'process' | 'sandbox';
    drainMessages(): void;
    onReload?(): number | null;
  },
  resolve: () => void,
  reject: (err: unknown) => void,
): Promise<void> {
  let handle = realm.handle;
  for (;;) {
    const completionFd = (
      realm.kind === 'sandbox' ? getSandboxCompletionFd(handle) : getProcessCompletionFd(handle)
    ) as number;
    if (completionFd < 0) {
      resolve();
      return;
    }
    await readable(completionFd);
    removeRead(completionFd);
    // A short-lived child can queue its final response and exit before the
    // parent is scheduled again. Drain first so releasing the native handle
    // cannot discard that response.
    realm.drainMessages();
    let stepResult: boolean | null;
    try {
      stepResult =
        realm.kind === 'sandbox'
          ? (stepSandboxContext(handle) as boolean)
          : (stepProcessContext(handle) as boolean | null);
    } catch (err) {
      reject(err);
      return;
    }
    if (stepResult === true) continue;
    if (stepResult === null && realm.onReload !== undefined) {
      const next = realm.onReload();
      if (next === null) {
        resolve();
        return;
      }
      handle = next;
      continue;
    }
    resolve();
    return;
  }
}
function validateSandboxRealmOptions(opts: RealmOptions): void {
  const sandbox = opts.sandbox;
  if (sandbox === undefined) return;
  if (sandbox.mode !== 'strict') {
    throw new Error('fino:realm — sandbox Realms require sandbox.mode: strict');
  }
  if (opts.watch) {
    throw new Error('fino:realm — watch is not supported with sandbox Realms');
  }
  if (opts.repl) {
    throw new Error('fino:realm — repl is not supported with sandbox Realms');
  }
  if (typeof opts.otlpEndpoint === 'string') {
    throw new Error(
      'fino:realm — otlpEndpoint is not supported with sandbox Realms because telemetry background work is process-global',
    );
  }
  if (sandbox.resources?.memoryBytes !== undefined) {
    throw new Error(
      'fino:realm — sandbox.resources.memoryBytes is process-wide and cannot be isolated to a Realm thread',
    );
  }
  if (
    sandbox.resources?.cpus !== undefined &&
    (typeof sandbox.resources.cpus !== 'string' ||
      !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(sandbox.resources.cpus))
  ) {
    throw new Error(
      'fino:realm — sandbox.resources.cpus must use the Linux CPU list format, for example 0-3,6',
    );
  }
  if (sandbox.process?.allowExec === true) {
    throw new Error(
      'fino:realm — sandbox.process.allowExec must be false because exec replaces the host process',
    );
  }
  if ((sandbox.process?.allowedBinaries?.length ?? 0) > 0) {
    throw new Error(
      'fino:realm — sandbox.process.allowedBinaries is unavailable because sandbox Realm exec is always denied',
    );
  }
  if (sandbox.process?.allowFork === true) {
    throw new Error(
      'fino:realm — sandbox.process.allowFork must be false because fork copies the host process',
    );
  }
  for (const [direction, rules] of [
    ['outbound', sandbox.network?.outbound],
    ['inbound', sandbox.network?.inbound],
  ] as const) {
    for (let index = 0; index < (rules?.length ?? 0); index++) {
      const rule = rules![index]!;
      if (
        (rule.destination !== undefined && rule.destination !== '*') ||
        rule.port !== undefined ||
        rule.protocol !== undefined
      ) {
        throw new Error(
          `fino:realm — sandbox.network.${direction}[${index}] requires filtered networking; sandbox Realms currently enforce only coarse allow/deny`,
        );
      }
    }
  }
  if (os !== 'linux') {
    throw new Error('fino:realm — sandbox Realms require Linux');
  }
}
// ---------------------------------------------------------------------------
// Native bridge helpers
// ---------------------------------------------------------------------------
/** Drain one batch from a process-port receive queue: `[[mainBytes, ...stores], ...]`. */
function _recvProcessMessages(handle: number): [Uint8Array[], [number, number][], Uint8Array?][] {
  return (processPortRecv as (h: number) => unknown)(handle) as [
    Uint8Array[],
    [number, number][],
    Uint8Array?,
  ][];
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
  kind: number,
  data: unknown,
  resolve: (v: R) => void,
  reject: (err: unknown) => void,
): void {
  if (kind === EnvelopeKind.CallError) {
    const failure = (data ?? {}) as {
      message?: string;
      name?: string;
      stack?: string;
    };
    const err = new Error(failure.message ?? 'Realm call failed');
    if (failure.name !== undefined) err.name = failure.name;
    if (failure.stack !== undefined) err.stack = failure.stack;
    reject(err);
    return;
  }
  resolve(data as R);
}
// ---------------------------------------------------------------------------
// Realm class
// ---------------------------------------------------------------------------
/**
 * Isolated child realm with its own module graph and communication port.
 *
 * A realm runs as a movable isolate on the shared reactor pool, in a separate
 * process, or on a remote cluster node. Use `run()` for entry modules with side
 * effects and `call()` for entry modules that default-export a function.
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
  /**
   * Private property `#handle` used by `Realm`.
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
  #handle: number;
  /**
   * Private readonly property `#kind` used by `Realm`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #kind = undefined;
   *
   *   readInternalState() {
   *     return this.#kind;
   *   }
   * }
   * ```
   *
   * @internal
   */
  readonly #kind: RealmKind;
  /**
   * Parent-side port for general communication with the child realm.
   *
   * Reactor-pooled realms expose a `RealmPort`, process realms expose a
   * `ProcessPort`, and remote realms expose a `ClusterPort`. Start the port
   * before listening for messages.
   *
   * ```ts no_run
   * import { Realm } from 'fino:realm';
   *
   * const realm = new Realm({ entry: './worker.ts' });
   * realm.port.addEventListener('message', (event) => console.log(event.data));
   * realm.port.start();
   * ```
   */
  port: MessagePort | RealmPort | ProcessPort | ClusterPort;
  /** Completion driven by the process scheduler for a scheduled realm. @internal */
  #scheduledCompletion: Promise<void> | null = null;
  /**
   * Memoised exit promise for a process realm.
   *
   * `run()` and `call()` both need to observe the child exiting, but a realm can
   * hold only one readiness watch per descriptor — two independent waiters on
   * the completion pipe would displace each other and one would never settle.
   *
   * @internal
   */
  #processCompletion: Promise<void> | null = null;
  /** Construction data retained only while a scheduled watch realm may reload. @internal */
  #scheduledOpts: RealmOptions | null = null;
  /** Import rules rebound to a replacement scheduled watch port. @internal */
  #scheduledRules: ImportRule[] = [];
  /** Removes this realm from its owning workload's shutdown stack. @internal */
  #scheduledShutdownRegistration: { dispose(): void } | null = null;
  /** Calls whose response still owns this realm during shutdown. @internal */
  #activeCalls = 0;
  /** Pending spawn for remote realms; resolves to childPortId after SPAWN_ACK. */
  /**
   * Private property `#spawnPromise` used by `Realm`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #spawnPromise = undefined;
   *
   *   readInternalState() {
   *     return this.#spawnPromise;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #spawnPromise: Promise<string> | null = null;
  // Watch mode state
  /**
   * Private property `#watchOpts` used by `Realm`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #watchOpts = undefined;
   *
   *   readInternalState() {
   *     return this.#watchOpts;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #watchOpts: RealmOptions | null = null;
  /**
   * Private property `#watchSerializedRules` used by `Realm`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #watchSerializedRules = undefined;
   *
   *   readInternalState() {
   *     return this.#watchSerializedRules;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #watchSerializedRules = '[]';
  /**
   * Private property `#watchTerminated` used by `Realm`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #watchTerminated = undefined;
   *
   *   readInternalState() {
   *     return this.#watchTerminated;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #watchTerminated = false;
  // For process watch mode: tracks the current child's port so that
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
  static fromSource<F extends RealmFn = RealmFn>(
    source: string,
    options: RealmSourceOptions = {},
  ): Realm<F> {
    if (
      (
        options as RealmSourceOptions & {
          watch?: boolean;
        }
      ).watch !== undefined
    ) {
      throw new Error('fino:realm — watch is not supported for source entrypoints');
    }
    const specifier = options.specifier ?? `fino:realm/source/${_nextSourceRealmId++}.ts`;
    const transpiled = transpileTypeScript(source, {
      filename: specifier,
      sourceType: 'ts',
    });
    if (!transpiled.ok) {
      throw new Error(
        transpiled.errors.map((error) => error.message).join('\n') ||
          'Unable to transpile Realm source',
      );
    }
    const rules: ImportRule[] = [];
    if (options.overrides) {
      const src =
        options.overrides instanceof ImportMap ? options.overrides.toRules() : options.overrides;
      rules.push(...src);
    } else {
      if (options.providers) {
        const { fs, net, dns } = options.providers;
        if (fs) rules.push(...fs.toRules());
        if (net) rules.push(...net.toRules());
        if (dns) rules.push(...dns.toRules());
      }
      if (options.blocked) {
        for (const spec of options.blocked)
          rules.push({
            pattern: spec,
            directive: 'block',
          });
      }
    }
    rules.push({
      pattern: specifier,
      directive: {
        type: 'source',
        code: transpiled.code,
        source_map: options.sourceMap ?? transpiled.map ?? '',
      },
    });
    const {
      specifier: _specifier,
      sourceMap: _sourceMap,
      providers: _providers,
      blocked: _blocked,
      ...realmOptions
    } = options;
    return new Realm<F>({
      ...realmOptions,
      entry: specifier,
      overrides: rules,
    });
  }

  /** Create one movable isolate and await its scalar completion signal. @internal */
  #startScheduledRealm(
    opts: RealmOptions,
    rules: ImportRule[],
    reloading = false,
    bootstrapData = realmBootstrapData(opts),
  ): Promise<void> {
    const scheduled = createScheduledRealm(
      opts.root ?? '',
      opts.entry,
      normaliseRules(rules),
      opts.watch ?? false,
      opts.data,
      bootstrapData,
      opts.repl ?? false,
    );
    this.#handle = scheduled.handle;
    const port = createScheduledPort(scheduled.portWakeFd, scheduled.handle);
    this.port = port;
    registerReactorWake(scheduled.owner, scheduled.wakeFd);
    if (reloading) {
      for (const rule of rules) {
        if (rule.directive instanceof Facade) rule.directive._bind(port);
      }
    }
    return (async () => {
      let status: ReturnType<typeof takeScheduledRealmStatus>;
      do {
        await readable(scheduled.completionFd);
        status = takeScheduledRealmStatus(scheduled.handle);
      } while (status.kind === 'pending');
      port._drain();
      removeRead(scheduled.completionFd);
      port.close();
      closeScheduledRealm(scheduled.handle);
      if (status.kind === 'error') {
        const message = status.error ?? 'scheduled realm failed';
        const error = new Error(message.replace(/^Error:\s*/, '').split('\n', 1)[0]);
        error.stack = message;
        throw error;
      }
      if (status.kind === 'reload' && !this.#watchTerminated && this.#scheduledOpts !== null) {
        return this.#startScheduledRealm(this.#scheduledOpts, this.#scheduledRules, true);
      }
    })();
  }
  /** Stop retaining this realm in its owning workload's shutdown stack. @internal */
  #disposeScheduledShutdownRegistration(): void {
    this.#scheduledShutdownRegistration?.dispose();
    this.#scheduledShutdownRegistration = null;
  }

  /**
   * Create a child realm and its parent-side communication port.
   *
   * The constructor builds import rules, creates the selected execution mode,
   * and binds facade RPC dispatchers. It throws for invalid mode combinations,
   * remote realms without an active cluster, or native creation failures.
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
    const isolatedModes = [opts.sandbox !== undefined, opts.process, opts.remote].filter(
      Boolean,
    ).length;
    if (isolatedModes > 1) {
      throw new Error('fino:realm — sandbox, process, and remote execution are mutually exclusive');
    }
    validateSandboxRealmOptions(opts);
    if (opts.watch && opts.remote) {
      throw new Error('fino:realm — watch: true is not supported with remote: true');
    }
    const watch = opts.watch ?? false;
    const repl = opts.repl ?? false;
    if (repl && opts.sandbox) {
      throw new Error('fino:realm — repl: true is not supported with sandbox');
    }
    if (repl && (opts.process || opts.remote || opts.watch)) {
      throw new Error('fino:realm — repl: true is not supported with process, remote, or watch');
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
        for (const spec of opts.blocked)
          rules.push({
            pattern: spec,
            directive: 'block',
          });
      }
    }
    if (repl) {
      rules.push({
        pattern: 'internal:repl-handler',
        directive: 'inherit',
      });
    }
    const serializedRules = rules.length > 0 ? serialiseRules(rules) : '[]';
    const serializedData = serializeRealmData(opts.data);
    if (opts.remote && serializedData !== undefined) {
      throw new Error('fino:realm — data is not supported with remote: true');
    }
    if (opts.watch) {
      this.#watchOpts = opts;
      this.#watchSerializedRules = serializedRules;
    }
    if (opts.remote) {
      const cluster = getCluster();
      if (!cluster) {
        throw new Error(
          'fino:realm — remote: true requires an active cluster; call startCluster() or joinCluster() first',
        );
      }
      this.#kind = 'remote';
      this.#handle = -1;
      const portId = `${cluster.nodeId}/p-${_nextPortHandle++}`;
      const clusterPort = new ClusterPort(portId, cluster);
      this.port = clusterPort;
      const bootstrapData = realmBootstrapData(opts);
      const config = {
        entry: opts.entry,
        root: opts.root ?? '',
        rules: normaliseRules(rules),
        ...(bootstrapData === undefined ? {} : { bootstrapData }),
      };
      this.#spawnPromise = cluster.spawnRemote(portId, config).then((childPortId: string) => {
        clusterPort._setChildPortId(childPortId);
        return childPortId;
      });
    } else if (opts.sandbox !== undefined) {
      this.#kind = 'sandbox';
      const bootstrapData = realmBootstrapData(opts);
      const handle = createSandboxContext(
        opts.root ?? '',
        opts.entry,
        serializedRules,
        serializedData,
        bootstrapData === undefined ? undefined : JSON.stringify(bootstrapData),
      ) as number;
      this.#handle = handle;
      const wakeReadFd = getSandboxPortWakeReadFd(handle) as number;
      this.port = createSandboxPort(wakeReadFd, handle);
    } else if (opts.process) {
      this.#kind = 'process';
      const bootstrapData = realmBootstrapData(opts);
      const handle = createProcessContext(
        opts.root ?? '',
        opts.entry,
        serializedRules,
        watch,
        serializedData,
        bootstrapData === undefined ? undefined : JSON.stringify(bootstrapData),
      ) as number;
      this.#handle = handle;
      const wakeReadFd = getProcessSocketFd(handle) as number;
      this.port = new ProcessPort(wakeReadFd, handle);
    } else {
      if (!usesProcessReadiness()) {
        throw new Error(
          'fino:realm — realms can only be created from a realm scheduled on the process reactor',
        );
      }
      this.#kind = 'scheduled';
      const bootstrapData = realmBootstrapData(opts);
      this.#handle = -1;
      this.port = undefined as unknown as RealmPort;
      this.#scheduledOpts = opts.watch ? opts : null;
      this.#scheduledRules = rules;
      this.#scheduledCompletion = this.#startScheduledRealm(opts, rules, false, bootstrapData);
      this.#scheduledShutdownRegistration = registerShutdownHook(() => {
        if (this.#activeCalls === 0) this.terminate({ force: true });
        return this.#scheduledCompletion!.catch(() => {});
      });
      void this.#scheduledCompletion.then(
        () => this.#disposeScheduledShutdownRegistration(),
        () => this.#disposeScheduledShutdownRegistration(),
      );
    }
    // Bind any Facade overrides so the parent-side RPC dispatcher is wired up.
    if (rules.length > 0) {
      const port = this.port as MessagePort | RealmPort | ProcessPort | ClusterPort;
      for (const rule of rules) {
        if (rule.directive instanceof Facade) {
          (rule.directive as Facade)._bind(port);
        }
      }
    }
    // Emit OTel realm spawn event (gated on hasSubscribers to avoid cost in
    // the common case where no OTel subscriber is registered).
    if (_topicRealmSpawn.hasSubscribers) {
      _topicRealmSpawn.publish(
        otelRuntimeEvent('realm', 'spawn', 'start', {
          kind: this.#kind,
          entry: opts.entry,
        }),
      );
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
  #spawnChild(): number {
    const opts = this.#watchOpts!;
    const handle = createProcessContext(
      opts.root ?? '',
      opts.entry,
      this.#watchSerializedRules,
      true,
      serializeRealmData(opts.data),
      serializeRealmBootstrapData(opts),
    ) as number;
    this.#activeChildPort = new ProcessPort(getProcessSocketFd(handle) as number, handle);
    return handle;
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
    if (this.#kind === 'scheduled') {
      return this.#scheduledCompletion!;
    }
    if (this.#kind === 'remote') {
      const clusterPort = this.port as ClusterPort;
      const cluster = getCluster()!;
      return (this.#spawnPromise ?? Promise.resolve('')).then(
        (childPortId: string) =>
          new Promise<void>((resolve, reject) => {
            // A remote realm's lifecycle is entirely cluster transport events.
            cluster.onRealmExit(childPortId, (error?: string) => {
              if (error) reject(new Error(error));
              else resolve();
            });
          }),
      );
    }
    return this.#threadExit();
  }
  /**
   * Await a process or sandbox realm's exit, watching its completion pipe once.
   *
   * `run()` and `call()` both need the exit signal, and a realm can hold only
   * one readiness watch per descriptor, so the watcher is memoised rather than
   * started per caller.
   *
   * @internal
   */
  #threadExit(): Promise<void> {
    const self = this;
    const kind = this.#kind === 'sandbox' ? 'sandbox' : 'process';
    this.#processCompletion ??= new Promise<void>((resolve, reject) => {
      void _awaitThreadChild(
        {
          handle: self.#handle,
          kind,
          drainMessages: () =>
            kind === 'sandbox'
              ? (self.port as RealmPort)._drain()
              : (self.#activeChildPort ?? (self.port as ProcessPort))._drain(),
          onReload:
            self.#watchOpts !== null
              ? (): number | null => {
                  if (self.#watchTerminated) return null;
                  const newHandle = self.#spawnChild();
                  self.#handle = newHandle;
                  return newHandle;
                }
              : undefined,
        },
        resolve,
        reject,
      );
    });
    return this.#processCompletion;
  }
  /**
   * Call the child Realm's default-exported function with `args`.
   *
   * The call starts the realm, sends a Call envelope, and resolves
   * with the returned value. It rejects if the realm exits before returning, if
   * the child serializes a call error, or if the remote cluster reports exit.
   * The port is closed after the first response for non-streaming calls.
   *
   * ```ts no_run
   * import { Realm } from 'fino:realm';
   *
   * const realm = new Realm<(a: number, b: number) => number>({ entry: './add.ts' });
   * const sum = await realm.call(2, 3);
   * ```
   */
  call(...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> {
    const callStart = performance.now();
    const kind = this.#kind;
    this.#activeCalls++;
    // Capture at call time so the end event is always published when start was.
    const startPublished = _topicRealmCall.hasSubscribers;
    if (startPublished) {
      _topicRealmCall.publish(otelRuntimeEvent('realm', 'call', 'start', { kind }));
    }
    let base: Promise<Awaited<ReturnType<F>>>;
    if (kind === 'scheduled') {
      const port = this.port as RealmPort;
      base = new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
        let settled = false;
        const stop = port._addControlHandler((envelope, value) => {
          if (
            envelope.kind !== EnvelopeKind.CallResult &&
            envelope.kind !== EnvelopeKind.CallError
          ) {
            return false;
          }
          if (settled) return true;
          settled = true;
          stop();
          port.close();
          _resolveCallResponse(envelope.kind, value, resolve, reject);
          return true;
        });
        port.start();
        port._postControl(EnvelopeKind.Call, 0, { args });
        void this.#scheduledCompletion!.then(
          () => {
            if (settled) return;
            settled = true;
            reject(new Error('Realm exited before returning a call result'));
          },
          (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });
    } else if (kind === 'remote') {
      const clusterPort = this.port as ClusterPort;
      const cluster = getCluster()!;
      base = (this.#spawnPromise ?? Promise.resolve('')).then(
        (childPortId: string) =>
          new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
            let settled = false;
            cluster.onRealmExit(childPortId, (error?: string) => {
              if (settled) return;
              settled = true;
              if (error) reject(new Error(error));
              else reject(new Error('Realm exited before returning a call result'));
            });
            const handler = (ev: unknown) => {
              if (settled) return;
              settled = true;
              const data = (
                ev as {
                  data?: unknown;
                }
              ).data;
              clusterPort.removeEventListener('message', handler as any);
              clusterPort.close();
              _resolveCallResponse(EnvelopeKind.CallResult, data, resolve, reject);
            };
            const stopControl = clusterPort._addControlHandler((envelope, value) => {
              if (
                envelope.kind !== EnvelopeKind.CallResult &&
                envelope.kind !== EnvelopeKind.CallError
              ) {
                return false;
              }
              if (settled) return true;
              settled = true;
              stopControl();
              clusterPort.removeEventListener('message', handler as any);
              clusterPort.close();
              _resolveCallResponse(envelope.kind, value, resolve, reject);
              return true;
            });
            clusterPort.addEventListener('message', handler as any);
            clusterPort.start();
            clusterPort._postControl(EnvelopeKind.Call, 0, { args });
          }),
      );
    } else {
      base = new Promise<Awaited<ReturnType<F>>>((resolve, reject) => {
        void this.#threadExit().then(
          () => reject(new Error('Realm exited before returning a call result')),
          reject,
        );
        const port = this.port as ProcessPort;
        const stop = port._addControlHandler((envelope, value) => {
          if (
            envelope.kind !== EnvelopeKind.CallResult &&
            envelope.kind !== EnvelopeKind.CallError
          ) {
            return false;
          }
          stop();
          port.close();
          _resolveCallResponse(envelope.kind, value, resolve, reject);
          return true;
        });
        port.start();
        port._postControl(EnvelopeKind.Call, 0, { args });
      });
    }
    const tracked = base.finally(() => this.#activeCalls--);
    if (!startPublished && !_topicRealmCallEnd.hasSubscribers) return tracked;
    return tracked.then(
      (result) => {
        _topicRealmCallEnd.publish(
          otelRuntimeEvent('realm', 'call', 'end', {
            kind,
            durationMs: performance.now() - callStart,
          }),
        );
        return result;
      },
      (err: unknown) => {
        _topicRealmCallEnd.publish(
          otelRuntimeEvent('realm', 'call', 'end', {
            kind,
            durationMs: performance.now() - callStart,
            error: true,
          }),
        );
        throw err;
      },
    );
  }
  /**
   * Signal the child realm to stop.
   *
   * Process and sandbox Realms normally receive a cooperative termination
   * message. Pass `{ force: true }` to send `SIGKILL` to a process Realm or
   * terminate V8 execution on a sandbox Realm when synchronous code cannot
   * service that message. Other realm kinds ignore `force`.
   *
   * Embedded realms are terminated through the native child handle. Scheduled,
   * process, and remote realms receive a `__terminate` message. The method is
   * synchronous and does not wait for `run()` to settle.
   *
   * ```ts no_run
   * import { Realm } from 'fino:realm';
   *
   * const realm = new Realm({ entry: './worker.ts' });
   * realm.terminate();
   * ```
   */
  terminate(
    options: {
      force?: boolean;
    } = {},
  ): void {
    this.#watchTerminated = true;
    if (this.#kind === 'scheduled') {
      this.#disposeScheduledShutdownRegistration();
      (this.port as RealmPort)._postControl(EnvelopeKind.Terminate, 0, null);
      // A realm spinning in synchronous JavaScript never returns to its loop to
      // observe the request above, and holds its reactor thread until it does.
      // Forcing interrupts execution so the thread is released.
      if (options.force === true) forceScheduledRealm(this.#handle);
    } else if (this.#kind === 'remote') {
      (this.port as ClusterPort)._postControl(EnvelopeKind.Terminate, 0, null);
      this.port.close();
    } else if (this.#kind === 'sandbox' && options.force === true) {
      forceSandboxContext(this.#handle);
      this.port.close();
    } else if (this.#kind === 'sandbox') {
      (this.port as RealmPort)._postControl(EnvelopeKind.Terminate, 0, null);
      this.port.close();
    } else if (this.#kind === 'process' && options.force === true) {
      killProcessContext(this.#handle);
      const activePort = this.#activeChildPort ?? (this.port as ProcessPort);
      activePort.close();
    } else {
      // After a watch-mode reload, this.port still points to the first child's
      // port.  Use #activeChildPort when set (updated by #spawnChild on reload)
      // so the terminate message reaches the currently-running child.
      const activePort = this.#activeChildPort ?? (this.port as ProcessPort);
      activePort._postControl(EnvelopeKind.Terminate, 0, null);
      activePort.close();
    }
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
