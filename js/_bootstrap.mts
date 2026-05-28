/**
 * _bootstrap.mts — Shared realm bootstrap.
 *
 * Evaluated in every Realm context (root and child) before any user code runs.
 * Sets up web globals, source map stack traces, the module loader hooks, and
 * exports `driveLoop` — the function that registers a step/onDone callback pair
 * with the Rust host loop.
 *
 * The root realm's entry (`_main.mts`) imports this module, then runs the CLI.
 * Child realms also evaluate this module as their first step; the child's entry
 * module is then dynamically imported and driveLoop is called with the child's
 * own isDone/onDone callbacks.
 */

import { tick, alive, registerWakeSource, _trackAtomicsWaiter, _untrackAtomicsWaiter } from './runtime/loop.mts';
import { drainMicrotasks, runLoop } from 'internal:async-context';
import { wakeFd } from 'internal:async-runtime';

// Register the async-runtime wake pipe with kqueue so background FFI threads
// can interrupt the event loop sleep immediately. Does not affect alive().
registerWakeSource(wakeFd);
import './internal/loader.mts';
import { lookupOriginalPosition } from 'internal:loader-hooks';
import { getEntryPath, isTerminated, getPort, setEntryError } from 'internal:realm-bridge';
// fino:realm/pool is imported lazily (inside __pool_call handlers only) so that
// non-pool realms — the vast majority — do not pay the module-evaluation cost.
import {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
} from './internal/globals/time.mts';
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
  crypto,
  cryptoAvailable,
  tlsAvailable,
  fetch,
  Headers,
  Request,
  Response,
  CompressionStream,
  DecompressionStream,
  MessageEvent,
  MessagePort,
  MessageChannel,
  ThreadPort,
  _flushPorts,
  BroadcastChannel,
} from './internal/globals/global.mts';
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
          () => { _untrackAtomicsWaiter(); },
          () => { _untrackAtomicsWaiter(); },
        );
      }
      return result;
    },
    writable: true,
    configurable: true,
  });
}

Object.assign(globalThis, {
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
  crypto,
  cryptoAvailable,
  tlsAvailable,
  fetch,
  Headers,
  Request,
  Response,
  CompressionStream,
  DecompressionStream,
  MessageEvent,
  MessagePort,
  MessageChannel,
  ThreadPort,
  BroadcastChannel,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  performance,
});

Object.defineProperty(globalThis, 'self', { value: globalThis, writable: true, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Fino/0.1' }, writable: true, configurable: true });
runtimeGlobalThis.reportError = function reportError(err: unknown) {
  runtimeGlobalThis.console?.error('Unhandled error:', err);
};

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

runtimeError.prepareStackTrace = function prepareStackTrace(err: Error, callSites: StackFrame[]): string {
  const header = `${err.name}: ${err.message}`;
  if (!Array.isArray(callSites) || callSites.length === 0) return header;
  return header + '\n' + callSites.map(formatCallSite).join('\n');
};

interface DriveLoopOptions {
  stepChildren?: () => void;
  childrenAlive?: () => boolean;
  /** If true, always poll with timeout=0 (non-blocking). Used for child realms
   *  that are driven by a parent loop — the parent controls sleeping. */
  nonBlocking?: boolean;
}

/**
 * Register step and onDone callbacks with the Rust host loop.
 *
 * The host loop calls `step()` repeatedly until it returns false, then calls
 * `onDone()`. The step function polls I/O events, drains microtasks, and
 * optionally steps any active child Realms.
 *
 * @param isDone  Returns true when the caller's work is complete.
 * @param onDone  Called after the loop exits (e.g. to handle errors).
 * @param opts    Optional hooks for child Realm stepping.
 */
export function driveLoop(isDone: () => boolean, onDone: () => void, opts?: DriveLoopOptions): void {
  let emptyTicks = 0;

  function step() {
    const loopAlive = alive();
    const hasChildren = opts?.childrenAlive?.() ?? false;
    if (isDone() && !loopAlive && !hasChildren) return false;

    const timeout = opts?.nonBlocking ? 0 : emptyTicks >= 3 ? 50 : 0;
    const count = tick(timeout);
    _flushPorts();
    drainMicrotasks();
    opts?.stepChildren?.();

    if (count === 0) {
      emptyTicks++;
    } else {
      emptyTicks = 0;
    }

    return true;
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
// If the child has a port (via getPort()), and the entry module default-exports
// a function, the bootstrap automatically wires up call-mode: it listens for a
// { __call, data } message, invokes the function, and posts the result back.
// If the entry has no default function export, the child stays alive (for
// multi-event messaging) until the parent calls terminate().

const _childEntry = getEntryPath() as string | undefined;

// Construct the correct port type for this realm context:
// - Thread realms: wake_read_fd >= 0 → construct a ThreadPort backed by native channels
// - Embedded realms: use the IntraPort passed by the parent via realm-bridge
const _threadWakeReadFd = getWakeReadFd() as number;
const _childPort: MessagePort | ThreadPort | undefined =
  _threadWakeReadFd >= 0
    ? new ThreadPort(_threadWakeReadFd)
    : (getPort() as MessagePort | undefined);

// Expose the child port as `realmPort` on globalThis so entry modules can
// add their own message listeners (e.g. for port-transfer fixtures).
(globalThis as Record<string, unknown>).realmPort = _childPort;

// Embedded realms (MessagePort) need an RPC-response interceptor on _childPort so
// that __rpc_res / __rpc_chunk / __rpc_end / __rpc_err envelopes from the parent
// reach the pending-call registry in internal:parent-rpc.
// Thread/process realms get this for free from BaseTransportPort._dispatchMessage.
// We use a dynamic import so this is a no-op for realms that have no facades
// (import will fail → catch handler, which is fine).
if (_threadWakeReadFd < 0 && _childPort !== undefined) {
  const _embeddedPort = _childPort as MessagePort;
  import('internal:parent-rpc').then(
    function _rpcInterceptorSetup(rpcMod: Record<string, unknown>) {
      const resolveRpc = rpcMod['resolveRpc'] as (id: number, v: unknown) => boolean;
      const rejectRpc  = rpcMod['rejectRpc']  as (id: number, e: string) => boolean;
      const pushChunk  = rpcMod['pushChunk']  as (id: number, c: unknown) => void;
      const endStream  = rpcMod['endStream']  as (id: number) => void;
      const errStream  = rpcMod['errStream']  as (id: number, e: string) => void;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_embeddedPort as any).addEventListener('message', function _rpcResponseHandler(ev: Event) {
        const msg = (ev as MessageEvent).data;
        if (!msg || typeof msg !== 'object') return;
        const obj = msg as Record<string, unknown>;
        if (obj['__rpc_res'] === true) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          const rpc = obj as { reqId: number; result?: unknown; error?: string };
          if (rpc.error !== undefined) {
            if (!rejectRpc(rpc.reqId, rpc.error)) errStream(rpc.reqId, rpc.error);
          } else { resolveRpc(rpc.reqId, rpc.result); }
        } else if (obj['__rpc_chunk'] === true) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          pushChunk((obj as { reqId: number }).reqId, (obj as { chunk: unknown }).chunk);
        } else if (obj['__rpc_end'] === true) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          endStream((obj as { reqId: number }).reqId);
        } else if (obj['__rpc_err'] === true) {
          (ev as MessageEvent).stopImmediatePropagation?.();
          errStream((obj as { reqId: number; error: string }).reqId,
                    (obj as { reqId: number; error: string }).error);
        }
      });
    },
    function _noFacades() { /* realm has no facades — silently skip */ },
  );
}

if (_childEntry !== undefined) {
  let _childDone = false;

  // Start the port early so messages (including __terminate) arrive during
  // module loading, before the entry module's own listener is added.
  // __call and __pool_call messages that arrive before the entry module finishes
  // loading are queued here and replayed once the _callHandler is installed.
  const _earlyPoolCalls: unknown[] = [];
  let _earlyCall: unknown = null;
  let _callHandlerInstalled = false;

  if (_childPort !== undefined) {
    _childPort.start();
    _childPort.addEventListener('message', function _terminateHandler(ev) {
      const msg = (ev as MessageEvent).data;
      if (!msg || typeof msg !== 'object') return;
      if ((msg as { __terminate?: boolean }).__terminate === true) {
        _childDone = true;
      } else if (!_callHandlerInstalled && (msg as { __call?: boolean }).__call) {
        // Queue early __call until _callHandler is ready; flag prevents re-queuing during replay.
        _earlyCall = msg;
      } else if (!_callHandlerInstalled && (msg as { __pool_call?: boolean }).__pool_call) {
        // Queue early pool calls until _callHandler is ready; flag prevents re-queuing during replay.
        _earlyPoolCalls.push(msg);
      }
    });
  }

  import(_childEntry).then(
    function _onChildEntryDone(mod: { default?: unknown }) {
      if (_childPort !== undefined && typeof mod.default === 'function') {
        // Call mode: wait for { __call, args }, invoke default export, post result.
        // _childDone is set after the function returns; do NOT set it here.
        const _fn = mod.default as (...args: unknown[]) => unknown;
        // Track which invocation mode this worker is in so the two modes cannot
        // interfere with each other.
        let _isPoolMode = false;

        _childPort.addEventListener('message', function _callHandler(ev) {
          const msg = (ev as MessageEvent).data;
          if (!msg || typeof msg !== 'object') return;

          if ((msg as { __call?: boolean }).__call && !_isPoolMode) {
            // Single-invocation call() mode: invoke once, post result, terminate.
            // Stop propagation so user code never sees internal __call envelopes.
            (ev as MessageEvent).stopImmediatePropagation?.();
            const _args = (msg as { args?: unknown[] }).args ?? [];
            new Promise<unknown>((res) => res(_fn(..._args))).then(
              function _callOk(result: unknown) {
                _childPort!.postMessage(result);
                _childDone = true;
              },
              function _callErr(err: unknown) {
                _childPort!.postMessage({
                  __call_error: true,
                  message: String(err),
                  name: (err instanceof Error) ? err.name : undefined,
                  stack: (err instanceof Error) ? err.stack : undefined,
                });
                _childDone = true;
              },
            );
          } else if ((msg as { __pool_call?: boolean }).__pool_call) {
            // Pool mode: multi-invocation with correlation ID. Worker stays alive.
            // Stop propagation so user code never sees internal __pool_call envelopes.
            (ev as MessageEvent).stopImmediatePropagation?.();
            _isPoolMode = true;
            const _pmsg = msg as { __pool_call: boolean; correlationId: number; args?: unknown[] };
            const _corrId = _pmsg.correlationId;
            const _args = _pmsg.args ?? [];
            // Lazily import fino:realm/pool so non-pool realms avoid the evaluation cost.
            import('fino:realm/pool').then(
              function _poolImport({ correlationIdContext }) {
                correlationIdContext.runWithValue(String(_corrId), function _poolInvoke() {
                  new Promise<unknown>((res) => res(_fn(..._args))).then(
                    function _poolCallOk(result: unknown) {
                      _childPort!.postMessage({ __pool_result: true, correlationId: _corrId, result });
                    },
                    function _poolCallErr(err: unknown) {
                      _childPort!.postMessage({
                        __pool_error: true,
                        correlationId: _corrId,
                        message: String(err),
                        stack: (err instanceof Error) ? err.stack : undefined,
                      });
                    },
                  );
                });
              },
              // If the pool module itself fails to load, surface the error as __pool_error
              // so the parent dispatcher rejects rather than hanging indefinitely.
              function _poolImportFailed(err: unknown) {
                _childPort!.postMessage({
                  __pool_error: true,
                  correlationId: _corrId,
                  message: 'fino:realm/pool module failed to load: ' + String(err),
                });
              },
            );
          }
          // Other messages (not __call / __pool_call / __terminate) pass through
          // to user-registered listeners unchanged.
        });

        // Mark the handler as installed so _terminateHandler stops queuing early messages.
        // Replay any messages that arrived before installation via a microtask.
        _callHandlerInstalled = true;
        const _toReplay: unknown[] = [];
        if (_earlyCall !== null) { _toReplay.push(_earlyCall); _earlyCall = null; }
        _toReplay.push(..._earlyPoolCalls.splice(0));
        if (_toReplay.length > 0) {
          Promise.resolve().then(() => {
            for (const m of _toReplay) {
              _childPort!.dispatchEvent(new MessageEvent('message', { data: m }));
            }
          });
        }
      } else {
        // Normal completion: entry module's top-level code (and any TLA) finished.
        // If an entry module wants to stay alive for multi-event messaging, it
        // must use a top-level `await` that doesn't resolve until done.
        _childDone = true;
      }
    },
    function _onChildEntryError(err: unknown) {
      try {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        (setEntryError as (m: string) => void)(msg);
      } catch (e) {
        runtimeGlobalThis.console?.error('[_onChildEntryError] setEntryError threw:', e);
      }
      _childDone = true;
    },
  );

  let _portClosed = false;
  driveLoop(
    function _childIsDone() {
      const done = _childDone || (isTerminated() as boolean);
      if (done && !_portClosed && _childPort !== undefined) {
        // Close the port to cancel any pending loop.readable() so that
        // alive() can return false and the loop can exit cleanly.
        _portClosed = true;
        (_childPort as MessagePort | ThreadPort).close();
      }
      return done;
    },
    function _childOnDone() {},
    { nonBlocking: true },
  );
}
