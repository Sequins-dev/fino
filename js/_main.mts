/**
 * _main.mjs — Fino's internal entry point and event loop driver.
 *
 * This file is the bridge between the Rust runtime and the JS world. It is
 * the very first JS module evaluated by the V8 runtime. It calls `runLoop`
 * from `internal:async-context` to hand the event loop functions
 * (isDone, tick, alive, onDone) to Rust, which then drives the loop
 * externally after this module finishes evaluating.
 */

import { argv, exit } from './runtime/process.mts';
import { tick, alive } from './runtime/loop.mts';
import { drainMicrotasks, runLoop } from 'internal:async-context';
import { createRootCommand } from './commands/root.mts';
import { runShutdownHooks } from './internal/shutdown.mts';
import './internal/loader.mts';
import { lookupOriginalPosition } from 'internal:loader-hooks';
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
} from './internal/globals/global.mts';

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

function driveLoop(isDone: () => boolean, onDone: () => void): void {
  let emptyTicks = 0;

  function step() {
    const commandDone = isDone();
    const loopAlive = alive();
    if (commandDone && !shutdownStarted) startShutdown();
    if (commandDone && shutdownStarted && shutdownDone && !loopAlive) return false;

    const timeout = emptyTicks >= 3 ? 50 : 0;
    const count = tick(timeout);
    drainMicrotasks();

    if (count === 0) {
      emptyTicks++;
    } else {
      emptyTicks = 0;
    }

    return true;
  }

  runLoop(step, onDone);
}

function normalizeCliArgv(args: string[]): string[] {
  if (args[0] === '--test') return ['test', ...args.slice(1)];
  if (args[0] === '--bench') return ['bench', ...args.slice(1)];
  return args;
}

const root = createRootCommand();
let done = false;
let caughtError: unknown = null;
let shutdownStarted = false;
let shutdownDone = false;
const cliArgv = normalizeCliArgv(argv.slice(1));

Promise.resolve(root.parse(cliArgv)).then(
  function onCommandDone(result) {
    if (typeof result === 'string' && result.length > 0) console.log(result);
    done = true;
  },
  function onCommandError(err) {
    caughtError = err;
    done = true;
  },
);

function startShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  Promise.resolve(runShutdownHooks()).then(
    function onShutdownDone() {
      shutdownDone = true;
    },
    function onShutdownError(err) {
      if (caughtError === null) caughtError = err;
      shutdownDone = true;
    },
  );
}

driveLoop(() => done, function onCliLoopDone() {
  if (caughtError) {
    console.error(caughtError);
    exit(1);
  }
});
