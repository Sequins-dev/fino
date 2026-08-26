/**
 * internal:bootstrap — shared realm bootstrap.
 *
 * Evaluated in every Realm context — root and child alike — before any user
 * code runs. Uniform bootstrap is deliberate: a child realm sees exactly the
 * same environment as the root, and only its configuration (entry path, port,
 * watch/REPL flags read from `internal:realm-bridge`) differs.
 *
 * Evaluating this module has several side effects:
 *
 * - Installs the WHATWG globals on `globalThis`: events, streams, `URL`,
 *   `fetch`, `Blob`/`File`, encoders, timers, `console`, `crypto`,
 *   `WebSocket`, `WebTransport`, message ports, and friends. All are
 *   writable and configurable but non-enumerable (except `fetch`, which the
 *   spec requires to be enumerable). `performance` is installed as a
 *   replaceable accessor, and `self`, `navigator`, and `reportError` are
 *   defined.
 * - Wraps `Atomics.waitAsync` so pending async futex waits keep the event
 *   loop alive — V8's `has_pending_background_tasks()` does not cover futex
 *   waiters, so without the shim the loop could exit before a notify fires.
 * - Installs `Error.prepareStackTrace` so stack traces map through source
 *   maps (via `internal:loader-hooks`) back to original TypeScript positions.
 * - Imports `internal:loader` to register module-resolution and
 *   `import.meta` hooks, and registers the async-runtime wake pipe with the
 *   event loop backend so background FFI threads can interrupt a sleeping
 *   poll.
 *
 * The module's one export is `driveLoop`, which registers a step/onDone
 * callback pair with the Rust host loop. The root realm's entry
 * (`internal/main.ts`) imports this module and then runs the CLI; child
 * realms evaluate it as their first step and the bootstrap takes over from
 * there: when `getEntryPath()` reports an entry module, it is dynamically
 * imported, port-based call/pool invocation modes are wired up for
 * default-exported functions, watch-mode reloads and shutdown hooks are
 * handled, and `driveLoop` is called with the child's own isDone/onDone
 * callbacks — so user entry modules never call `driveLoop` themselves.
 * Realms created with `repl: true` instead load `internal:repl-handler` and
 * answer `__eval` messages until terminated.
 *
 * ## Example
 *
 * ```ts no_run
 * import { driveLoop } from 'internal:bootstrap';
 *
 * let finished = false;
 * queueMicrotask(() => { finished = true; });
 *
 * driveLoop(
 *   () => finished,
 *   () => {
 *     // Host loop has drained pending runtime work.
 *   },
 * );
 * ```
 *
 * @internal
 */
import {
  tick,
  alive,
  registerWakeSource,
  _trackAtomicsWaiter,
  _untrackAtomicsWaiter,
  _schedulerPollingRequired,
} from './runtime/loop.ts';
import { drainMicrotasks, runLoop } from 'internal:async-context';
import { setSchedulerPollingRequired, usesProcessReadiness } from 'internal:scheduler-native';
import { EnvelopeKind } from 'internal:realm/envelope';
import { wakeFd } from 'internal:async-runtime';
import { registerRealmProfiling } from 'internal:process-profiler';
import { env } from '../process.ts';
// A no-op unless the main Realm opened a process profile. Registration starts
// this Realm's isolate-local recording before its entry module is imported.
registerRealmProfiling();
// Register the async-runtime wake pipe with kqueue so background FFI threads
// can interrupt the event loop sleep immediately. Does not affect alive().
registerWakeSource(wakeFd);
import './loader.ts';
import { lookupOriginalPosition } from 'internal:loader-hooks';
import {
  getEntryPath,
  isTerminated,
  setEntryError,
  getLoadedFsPaths,
  requestReload,
  getWatchMode,
  getReplMode,
  getRealmData,
  getRealmBootstrapData,
} from 'internal:realm-bridge';
import { runShutdownHooks } from 'internal:shutdown';
import {
  finishRealmCoverage,
  startRealmCoverage,
  type CoverageRealmContext,
} from 'internal:coverage';
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  queueMicrotask,
  Performance,
  performance,
} from '../globals/time.ts';
import {
  Event,
  CustomEvent,
  EventTarget,
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
  ReadableStreamDefaultController,
  ReadableByteStreamController,
  ReadableStreamBYOBRequest,
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  WritableStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  TransformStreamDefaultController,
  TransformStream,
  AbortController,
  AbortSignal,
  Blob,
  File,
  FileList,
  FileReader,
  DOMException,
  QuotaExceededError,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  structuredClone,
  FormData,
  URL,
  URLSearchParams,
  URLPattern,
  console,
  CryptoKey,
  crypto,
  cryptoAvailable,
  tlsAvailable,
  fetch,
  Headers,
  Request,
  Response,
  CompressionStream,
  DecompressionStream,
  EventSource,
  WebSocket,
  WebTransport,
  WebTransportDatagramDuplexStream,
  CloseEvent,
  ErrorEvent,
  MessageEvent,
  MessagePort,
  MessageChannel,
  _flushPorts,
  BroadcastChannel,
} from '../globals/global.ts';
import { FileReaderSync } from '../globals/blob.ts';
import { createParentPort, type RealmPort } from 'internal:realm/transport-port';
import { getWakeReadFd } from 'internal:thread-port';
interface StackFrame {
  getFileName?(): string | null;
  getScriptNameOrSourceURL?(): string | null;
  getLineNumber?(): number | null;
  getColumnNumber?(): number | null;
  getFunctionName?(): string | null;
  getMethodName?(): string | null;
}
type RuntimeGlobalThis = typeof globalThis & {
  reportError: (err: unknown) => void;
};
type RuntimeErrorConstructor = ErrorConstructor & {
  prepareStackTrace?: (err: Error, callSites: StackFrame[]) => string;
};
const runtimeGlobalThis = globalThis as RuntimeGlobalThis;
setSchedulerPollingRequired(_schedulerPollingRequired);
const runtimeError = Error as RuntimeErrorConstructor;
// Wrap Atomics.waitAsync so alive() can track pending async waits and keep
// the event loop alive until they settle. V8 resolves waitAsync via foreground
// tasks (drained by drainMicrotasks/pump_message_loop), but
// has_pending_background_tasks() does not cover futex waiters, so without this
// shim the loop could exit before the notify fires.
if (typeof Atomics !== 'undefined' && typeof Atomics.waitAsync === 'function') {
  const _origWaitAsync = Atomics.waitAsync.bind(Atomics);
  Object.defineProperty(Atomics, 'waitAsync', {
    value: function waitAsync(
      typedArray: Parameters<typeof Atomics.waitAsync>[0],
      index: number,
      value: Parameters<typeof Atomics.waitAsync>[2],
      timeout?: number,
    ): ReturnType<typeof Atomics.waitAsync> {
      const result = _origWaitAsync(typedArray, index, value, timeout);
      if (result.async) {
        _trackAtomicsWaiter();
        result.value.then(
          () => {
            _untrackAtomicsWaiter();
          },
          () => {
            _untrackAtomicsWaiter();
          },
        );
      }
      return result;
    },
    writable: true,
    configurable: true,
  });
}
const globalEventTarget = new EventTarget();
function defineGlobal(name: string, value: unknown, enumerable = false): void {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    enumerable,
    configurable: true,
  });
}
for (const [name, value] of Object.entries({
  Event,
  CustomEvent,
  EventTarget,
  addEventListener: globalEventTarget.addEventListener.bind(globalEventTarget),
  removeEventListener: globalEventTarget.removeEventListener.bind(globalEventTarget),
  dispatchEvent: globalEventTarget.dispatchEvent.bind(globalEventTarget),
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
  ReadableStreamDefaultController,
  ReadableByteStreamController,
  ReadableStreamBYOBRequest,
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  WritableStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  TransformStreamDefaultController,
  TransformStream,
  AbortController,
  AbortSignal,
  Blob,
  File,
  FileList,
  FileReader,
  DOMException,
  QuotaExceededError,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  structuredClone,
  FormData,
  URL,
  URLSearchParams,
  URLPattern,
  console,
  CryptoKey,
  crypto,
  cryptoAvailable,
  tlsAvailable,
  fetch,
  Headers,
  Request,
  Response,
  CompressionStream,
  DecompressionStream,
  EventSource,
  WebSocket,
  WebTransport,
  WebTransportDatagramDuplexStream,
  CloseEvent,
  ErrorEvent,
  MessageEvent,
  MessagePort,
  MessageChannel,
  BroadcastChannel,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  queueMicrotask,
  Performance,
})) {
  defineGlobal(name, value, name === 'fetch');
}
const performanceGlobalDescriptor = Object.getOwnPropertyDescriptor(
  {
    get performance() {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      return performance;
    },
    set performance(value: unknown) {
      if (this !== globalThis && this !== undefined) throw new TypeError('Illegal invocation');
      Object.defineProperty(globalThis, 'performance', {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  },
  'performance',
)!;
Object.defineProperty(globalThis, 'performance', {
  ...performanceGlobalDescriptor,
  enumerable: true,
  configurable: true,
});
Object.defineProperty(globalThis, Symbol.for('fino.internal.FileReaderSync'), {
  value: FileReaderSync,
  writable: false,
  enumerable: false,
  configurable: false,
});
Object.defineProperty(globalThis, 'self', {
  value: globalThis,
  writable: true,
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Fino/0.1' },
  writable: true,
  configurable: true,
});
defineGlobal('reportError', function reportError(err: unknown) {
  runtimeGlobalThis.console?.error('Unhandled error:', err);
});
function formatCallSite(callSite: StackFrame): string {
  let source = callSite.getFileName?.() ?? callSite.getScriptNameOrSourceURL?.() ?? null;
  let line = callSite.getLineNumber?.() ?? null;
  let column = callSite.getColumnNumber?.() ?? null;
  if (typeof source === 'string' && typeof line === 'number' && typeof column === 'number') {
    const mapped = lookupOriginalPosition(source, line, column);
    if (mapped !== null) {
      source = mapped.source;
      line = mapped.line;
      column = mapped.column;
    }
  }
  const functionName = callSite.getFunctionName?.() ?? callSite.getMethodName?.() ?? null;
  const location = source && line && column ? `${source}:${line}:${column}` : '<anonymous>';
  return functionName ? `    at ${functionName} (${location})` : `    at ${location}`;
}
runtimeError.prepareStackTrace = function prepareStackTrace(
  err: Error,
  callSites: StackFrame[],
): string {
  const header = `${err.name}: ${err.message}`;
  if (!Array.isArray(callSites) || callSites.length === 0) return header;
  return header + '\n' + callSites.map(formatCallSite).join('\n');
};
/**
 * Registers a step/onDone callback pair with the Rust host loop.
 *
 * The host loop calls the registered step function once per iteration until it
 * reports that the realm is finished, then calls `onDone` (e.g. to surface
 * errors or clean up). Each step drains already-ready reactor completions
 * without blocking, flushes inter-realm message ports, and drains the microtask
 * queue.
 *
 * The step returns a **progress count**, which is the contract the reactor
 * scheduler runs on:
 *
 * - `-1` — the realm is finished and the host loop should stop.
 * - `0` — the realm is alive but had nothing to do this turn. Every source that
 *   can enqueue new microtasks is counted below, and a microtask checkpoint
 *   drains the queue to completion, so a zero-progress turn means the realm is
 *   genuinely quiescent and the reactor can park it until a readiness
 *   completion signals it again.
 * - `> 0` — the realm did work and should be stepped again.
 *
 * `isDone` reports whether the caller's own work is complete. By default the
 * loop still waits for live handles (pending timers, sockets, watchers, and
 * Atomics waiters). `finishWhenDone` may declare that the completed operation
 * owns the whole container, allowing isolate disposal to release ambient
 * handles instead of letting them retain a one-shot execution indefinitely.
 *
 * ```ts no_run
 * import { driveLoop } from 'internal:bootstrap';
 *
 * let complete = false;
 * Promise.resolve().then(() => { complete = true; });
 * driveLoop(
 *   () => complete,
 *   () => {
 *     // loop finished
 *   },
 * );
 * ```
 *
 * @internal
 */
export function driveLoop(
  isDone: () => boolean,
  onDone: () => void,
  finishWhenDone: () => boolean = () => false,
): void {
  const processScheduled = usesProcessReadiness();
  let emptyTicks = 0;
  function step(): number {
    const initiallyDone = isDone();
    if (initiallyDone && (finishWhenDone() || !alive())) return -1;
    // A reactor-scheduled realm never blocks here: its readiness completions
    // are delivered by the main thread, which owns the only backend.
    const count = tick(processScheduled || emptyTicks < 3 ? 0 : 25);
    const delivered = _flushPorts();
    drainMicrotasks();
    if (count === 0) emptyTicks++;
    else emptyTicks = 0;
    // Re-check completion before reporting quiescence. `isDone` is not a pure
    // predicate — a realm's implementation starts its asynchronous shutdown the
    // first time it observes that the entry finished — and the drain above can
    // run that shutdown to completion. Without this second check a realm could
    // finish during a turn that dispatched no events and be parked forever,
    // because nothing would ever step it again to notice.
    const done = isDone();
    if (done && (finishWhenDone() || !alive())) return -1;
    return count + delivered;
  }
  runLoop(step, onDone);
}
// ---------------------------------------------------------------------------
// Child Realm auto-setup
// ---------------------------------------------------------------------------
// When this module is evaluated inside a child Realm context, `getEntryPath()`
// returns the entry module path stored in the child's FinoState. We use it to
// dynamically import the entry module and wire up the child's driveLoop, so
// user entry modules don't need to call driveLoop themselves.
//
// If the child has a port, and the entry module default-exports a function,
// the bootstrap automatically wires up call-mode: it listens for a
// { __call, data } message, invokes the function, and posts the result back.
// If the entry has no default function export, the child stays alive (for
// multi-event messaging) until the parent calls terminate().
const _childEntry = getEntryPath() as string | undefined;
interface RuntimeBootstrapData {
  cliOtel?: {
    endpoint?: string;
    script?: string;
    debug?: boolean;
  };
  sandbox?: unknown;
  coverage?: CoverageRealmContext;
}
const _runtimeBootstrapData = (() => {
  const raw = (getRealmBootstrapData as () => string | undefined)();
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as RuntimeBootstrapData;
  } catch {
    return undefined;
  }
})();
// A realm reached over a wake pipe (every reactor-pooled and process realm)
// talks to its parent through a realm port. A root realm has none.
const _threadWakeReadFd = getWakeReadFd() as number;
const _childPort: RealmPort | undefined =
  _threadWakeReadFd >= 0 ? createParentPort(_threadWakeReadFd) : undefined;
// Expose the child port as `realmPort` on globalThis so entry modules can
// add their own message listeners (e.g. for port-transfer fixtures).
(globalThis as Record<string, unknown>).realmPort = _childPort;
if (_childEntry) {
  startRealmCoverage(_runtimeBootstrapData?.coverage);
  let _childDone = false;
  let _entryFailed = false;
  // Set when the parent sends { __terminate: true } via the port.  Used in
  // watch mode (where _childDone is not checked) so terminate() unblocks
  // _childIsDone() the same way requestReload() does.
  let _externalTerminate = false;
  // Start the port early so control frames — a termination request, or a call
  // that arrives before the entry module finishes loading — are observed during
  // module loading. An early call is queued and replayed once its handler is up.
  let _earlyCall: unknown[] | null = null;
  let _callHandlerInstalled = false;
  if (_childPort !== undefined) {
    _childPort.start();
    _childPort._addControlHandler((envelope, value) => {
      if (envelope.kind === EnvelopeKind.Terminate) {
        _childDone = true;
        _externalTerminate = true;
        return true;
      }
      if (envelope.kind === EnvelopeKind.Call && !_callHandlerInstalled) {
        _earlyCall = ((value ?? {}) as { args?: unknown[] }).args ?? [];
        return true;
      }
      return false;
    });
  }
  // CLI OTel providers are context-scoped, so the spawner cannot install them
  // across the realm boundary - the child must wrap its own entry import.
  // Runtime bootstrap metadata carries the endpoint without using user data.
  async function _loadChildEntry(): Promise<{
    default?: unknown;
  }> {
    let sandboxPolicy = _runtimeBootstrapData?.sandbox;
    let cliOtel = _runtimeBootstrapData?.cliOtel;
    if (sandboxPolicy !== undefined) {
      const { installSandboxRealmPolicy } = await import('internal:security/sandbox/realm');
      installSandboxRealmPolicy(
        sandboxPolicy as import('./security/sandbox/plan.ts').SandboxPolicy,
      );
    }
    const raw = (getRealmData as () => string | undefined)();
    if (sandboxPolicy === undefined && cliOtel === undefined && raw !== undefined) {
      try {
        cliOtel = (
          JSON.parse(raw) as {
            cliOtel?: typeof cliOtel;
          }
        ).cliOtel;
      } catch {}
    }
    if (cliOtel && typeof cliOtel.endpoint === 'string' && cliOtel.endpoint) {
      const { createCliOtelRuntime } = await import('internal:opentelemetry/bootstrap');
      const { runWithTracerProvider, runWithLoggerProvider, runWithMeterProvider } =
        await import('fino:opentelemetry');
      const debug =
        cliOtel.debug === true ||
        (typeof env.FINO_OTEL_DEBUG === 'string' && env.FINO_OTEL_DEBUG.trim() === '1');
      const rt = await createCliOtelRuntime(
        cliOtel.endpoint,
        cliOtel.script ?? _childEntry!,
        debug,
      );
      return runWithTracerProvider(rt.tracerProvider, () =>
        runWithLoggerProvider(rt.loggerProvider, () =>
          runWithMeterProvider(rt.meterProvider, () => import(_childEntry!)),
        ),
      );
    }
    return import(_childEntry!);
  }
  _loadChildEntry().then(
    function _onChildEntryDone(mod: { default?: unknown }) {
      // A default-exported Task (branded via Symbol.for('fino.task')) exposes
      // its worker dispatcher as the Realm.call() target.
      let _entryCallable: ((...args: unknown[]) => unknown) | undefined;
      if (typeof mod.default === 'function') {
        _entryCallable = mod.default as (...args: unknown[]) => unknown;
      } else if (
        mod.default !== null &&
        typeof mod.default === 'object' &&
        (mod.default as Record<PropertyKey, unknown>)[Symbol.for('fino.task')] === true
      ) {
        _entryCallable = (
          mod.default as {
            worker(): (...args: unknown[]) => unknown;
          }
        ).worker();
      }
      if (_childPort !== undefined && _entryCallable !== undefined) {
        // Call mode: answer a Call frame by invoking the default export once and
        // replying with its result. _childDone is set after the function
        // returns; do NOT set it here.
        const _fn = _entryCallable;
        const _invoke = (args: unknown[]): void => {
          new Promise<unknown>((res) => res(_fn(...args))).then(
            function _callOk(result: unknown) {
              _childPort!._postControl(EnvelopeKind.CallResult, 0, result);
              _childDone = true;
            },
            function _callErr(err: unknown) {
              _childPort!._postControl(EnvelopeKind.CallError, 0, {
                message: String(err),
                name: err instanceof Error ? err.name : undefined,
                stack: err instanceof Error ? err.stack : undefined,
              });
              _childDone = true;
            },
          );
        };
        _childPort._addControlHandler((envelope, value) => {
          if (envelope.kind !== EnvelopeKind.Call) return false;
          _invoke(((value ?? {}) as { args?: unknown[] }).args ?? []);
          return true;
        });
        // Stop the early-call queue and replay anything it captured.
        _callHandlerInstalled = true;
        if (_earlyCall !== null) {
          const replay = _earlyCall;
          _earlyCall = null;
          Promise.resolve().then(() => _invoke(replay));
        }
      } else {
        // Normal completion: entry module's top-level code (and any TLA) finished.
        // If an entry module wants to stay alive for multi-event messaging, it
        // must use a top-level `await` that doesn't resolve until done.
        _childDone = true;
      }
    },
    function _onChildEntryError(err: unknown) {
      _entryFailed = true;
      try {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        (setEntryError as (m: string) => void)(msg);
      } catch (e) {
        runtimeGlobalThis.console?.error('[_onChildEntryError] setEntryError threw:', e);
      }
      _childDone = true;
    },
  );
  const _watchMode = (getWatchMode as () => boolean)();
  // References held so _childIsDone() can tear them down on external terminate().
  let _watcherRef: {
    close(): void;
  } | null = null;
  let _watchPollRef: ReturnType<typeof setInterval> | null = null;
  let _portClosed = false;
  // Mirror the root CLI's shutdown semantics (main.ts startShutdown): when the
  // entry completes, run this realm's shutdown hooks so long-lived services
  // (e.g. an OTel SDK's periodic readers) stop keeping the loop alive.
  let _shutdownStarted = false;
  let _shutdownDone = false;
  function _startChildShutdown() {
    if (_shutdownStarted) return;
    _shutdownStarted = true;
    void (async function _finishChildRealm() {
      try {
        await runShutdownHooks();
      } catch (err) {
        // Root-CLI parity: a shutdown-hook failure fails the run, but never
        // displaces an earlier entry error.
        if (!_entryFailed) {
          try {
            const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
            (setEntryError as (m: string) => void)(msg);
          } catch {}
        }
      }
      try {
        await finishRealmCoverage();
      } catch (err) {
        if (!_entryFailed) {
          try {
            const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
            (setEntryError as (m: string) => void)(msg);
          } catch {}
        }
      }
      _shutdownDone = true;
    })();
  }
  driveLoop(
    function _childIsDone() {
      // In watch mode the realm stays alive after the entry completes so the
      // file-watcher loop can keep driving kqueue/inotify events.  Exit is
      // triggered by: requestReload() (sets state.terminated), or
      // { __terminate: true } over the port (sets _externalTerminate).
      const entryDone = _watchMode
        ? _externalTerminate || (isTerminated() as boolean)
        : _childDone || (isTerminated() as boolean);
      if (entryDone && !_shutdownStarted) _startChildShutdown();
      const done = entryDone && _shutdownDone;
      if (done) {
        // Tear down the watcher and poll interval so alive() drains to false
        // and the child's step loop can exit cleanly.  This handles both the
        // external-terminate path (parent called terminate()) and the
        // watcher-initiated reload path (watcher already cleared these itself).
        if (_watchPollRef !== null) {
          clearInterval(_watchPollRef);
          _watchPollRef = null;
        }
        if (_watcherRef !== null) {
          _watcherRef.close();
          _watcherRef = null;
        }
        if (!_portClosed && _childPort !== undefined) {
          // Close the port to cancel any pending loop.readable() so that
          // alive() can return false and the loop can exit cleanly.
          _portClosed = true;
          _childPort.close();
        }
      }
      return done;
    },
    function _childOnDone() {},
    // A call-mode Realm is a one-shot execution container. Once its call,
    // shutdown hooks, and coverage have completed, ambient handles cannot own
    // the container indefinitely; disposing the isolate releases them. Script
    // Realms retain ordinary event-loop liveness until explicitly terminated.
    () => _callHandlerInstalled,
  );
  // ---------------------------------------------------------------------------
  // Watch mode — file-change reload loop
  // ---------------------------------------------------------------------------
  // Started as a fire-and-forget task when the child realm has watch_mode=true.
  // The Watcher import is dynamic so non-watch realms never pay the module cost.
  // Lives inside if (_childEntry !== undefined) so it shares scope with
  // _watcherRef / _watchPollRef that _childIsDone() uses for teardown.
  if (_watchMode) {
    void (async function _watchLoop() {
      const { Watcher } = (await import('fino:file/watch')) as {
        Watcher: new () => {
          watch(p: string): Promise<void>;
          close(): void;
          [Symbol.asyncIterator](): AsyncIterator<{
            path: string;
            type: string;
          }>;
        };
      };
      const watcher = new Watcher();
      const watched = new Set<string>();
      function _refreshWatchPaths() {
        for (const p of (getLoadedFsPaths as () => string[])()) {
          if (!watched.has(p)) {
            watched.add(p);
            // Reload is edge-triggered on any later change, so the watch does
            // not have to be armed before this returns.
            void watcher.watch(p);
          }
        }
      }
      _refreshWatchPaths();
      const _poll = setInterval(_refreshWatchPaths, 200);
      // Expose to _childIsDone() for external-terminate cleanup.
      _watcherRef = watcher;
      _watchPollRef = _poll;
      let _pending: ReturnType<typeof setTimeout> | null = null;
      for await (const ev of watcher) {
        if (!watched.has(ev.path)) continue;
        if (_pending !== null) clearTimeout(_pending);
        _pending = setTimeout(function _doReload() {
          _pending = null;
          _watchPollRef = null;
          clearInterval(_poll);
          _watcherRef = null;
          watcher.close();
          (requestReload as () => void)();
        }, 50);
      }
    })();
  }
}
// ---------------------------------------------------------------------------
// REPL mode — activated when the child realm was created with `repl: true`.
// ---------------------------------------------------------------------------
// The parent drives the REPL by sending { __eval, id, code } messages and
// receives { __eval_result, id, value } or { __eval_error, id, ... } in reply.
// The realm stays alive until the parent sends { __terminate: true }.
if ((getReplMode as () => boolean)()) {
  let _replDone = false;
  const _earlyEvals: unknown[] = [];
  let _replHandlerInstalled = false;
  if (_childPort !== undefined) {
    _childPort.start();
    _childPort._addControlHandler((envelope) => {
      if (envelope.kind !== EnvelopeKind.Terminate) return false;
      _replDone = true;
      return true;
    });
    _childPort.addEventListener('message', function _replEarlyHandler(ev) {
      const msg = (ev as MessageEvent).data;
      if (!msg || typeof msg !== 'object') return;
      if (
        !_replHandlerInstalled &&
        (
          msg as {
            __eval?: boolean;
          }
        ).__eval === true
      ) {
        // Queue early __eval messages until the handler is ready; replay after install.
        _earlyEvals.push(msg);
      }
    });
  }
  // Lazily import the REPL handler so the inspector is only wired up in REPL realms.
  import('internal:repl-handler').then(
    function _replHandlerLoaded(mod: Record<string, unknown>) {
      const handleEval = mod['handleEval'] as (msg: {
        id: number;
        code: string;
        port: MessagePort;
      }) => void;
      if (_childPort !== undefined) {
        _childPort.addEventListener('message', function _replMessageHandler(ev) {
          const msg = (ev as MessageEvent).data;
          if (!msg || typeof msg !== 'object') return;
          if (
            (
              msg as {
                __eval?: boolean;
              }
            ).__eval === true
          ) {
            (ev as MessageEvent).stopImmediatePropagation?.();
            handleEval({
              id: (
                msg as {
                  id: number;
                }
              ).id,
              code: (
                msg as {
                  code: string;
                }
              ).code,
              port: _childPort as MessagePort,
            });
          }
        });
        _replHandlerInstalled = true;
        const _toReplay = _earlyEvals.splice(0);
        if (_toReplay.length > 0) {
          Promise.resolve().then(function _replReplay() {
            for (const m of _toReplay) {
              _childPort!.dispatchEvent(new MessageEvent('message', { data: m }));
            }
          });
        }
      }
    },
    function _replHandlerError(err: unknown) {
      runtimeGlobalThis.console?.error('[repl] failed to load handler:', err);
      _replDone = true;
    },
  );
  driveLoop(
    function _replIsDone() {
      const done = _replDone || (isTerminated() as boolean);
      if (done) _childPort?.close();
      return done;
    },
    function _replOnDone() {},
  );
}
