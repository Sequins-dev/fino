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

import { tick, alive, _trackAtomicsWaiter, _untrackAtomicsWaiter } from './runtime/loop.mts';
import { drainMicrotasks, runLoop } from 'internal:async-context';
import './internal/loader.mts';
import { lookupOriginalPosition } from 'internal:loader-hooks';
import { getEntryPath, isTerminated, getPort } from 'internal:realm-bridge';
import { correlationIdContext as _poolCorrelationCtx } from 'fino:realm/pool';
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
if (typeof Atomics !== 'undefined' && typeof (Atomics as any).waitAsync === 'function') {
  const _origWaitAsync: typeof Atomics.waitAsync = (Atomics as any).waitAsync.bind(Atomics);
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
        (result.value as Promise<string>).then(
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

if (_childEntry !== undefined) {
  let _childDone = false;

  // Start the port early so messages (including __terminate) arrive during
  // module loading, before the entry module's own listener is added.
  if (_childPort !== undefined) {
    _childPort.start();
    _childPort.addEventListener('message', function _terminateHandler(ev) {
      const msg = (ev as MessageEvent).data;
      if (msg && typeof msg === 'object' && (msg as { __terminate?: boolean }).__terminate === true) {
        _childDone = true;
      }
    });
  }

  import(_childEntry).then(
    function _onChildEntryDone(mod: { default?: unknown }) {
      if (_childPort !== undefined && typeof mod.default === 'function') {
        // Call mode: wait for { __call, args }, invoke default export, post result.
        // _childDone is set after the function returns; do NOT set it here.
        const _fn = mod.default as (...args: unknown[]) => unknown;
        _childPort.addEventListener('message', function _callHandler(ev) {
          const msg = (ev as MessageEvent).data;
          if (msg && typeof msg === 'object' && (msg as { __call?: boolean }).__call) {
            // Single-invocation call() mode: invoke once, post result, terminate.
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
                  stack: (err instanceof Error) ? err.stack : undefined,
                });
                _childDone = true;
              },
            );
          } else if (msg && typeof msg === 'object' && (msg as { __pool_call?: boolean }).__pool_call) {
            // Pool mode: multi-invocation with correlation ID. Worker stays alive.
            const _pmsg = msg as { __pool_call: boolean; correlationId: number; args?: unknown[] };
            const _corrId = _pmsg.correlationId;
            const _args = _pmsg.args ?? [];
            _poolCorrelationCtx.runWithValue(String(_corrId), function _poolInvoke() {
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
          }
          // Non-__call / non-__pool_call / non-__terminate messages are passed through.
        });
      } else {
        // Normal completion: entry module's top-level code (and any TLA) finished.
        // If an entry module wants to stay alive for multi-event messaging, it
        // must use a top-level `await` that doesn't resolve until done.
        _childDone = true;
      }
    },
    function _onChildEntryError(err: unknown) {
      runtimeGlobalThis.console?.error('Realm entry error:', err);
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
