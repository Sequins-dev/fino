/**
 * _main.mjs — Boats's internal entry point and event loop driver.
 *
 * This file is the bridge between the Rust runtime and the JS world. It is
 * the very first JS module evaluated by `runtime.rs` via Boa's
 * `load_link_evaluate`. Because of how Boa works, this module **must remain
 * synchronous** (no top-level `await`). A top-level await would suspend the
 * module mid-evaluation, which Boa does not support in a way that allows the
 * surrounding Rust code to resume it correctly.
 *
 *
 * ## What it does
 *
 * 1. **Global setup** — Registers web-standard globals (`URL`, `console`,
 *    `Blob`, etc.) onto `globalThis`. These exist in `internal:globals/global`
 *    to keep the implementation modular; users access them via `globalThis`.
 *
 * 2. **Mode dispatch** — Checks `argv[1]` to decide which mode to run:
 *    - Normal: dynamically `import()`s the user's script.
 *    - `--test`: imports each test file, then calls `boats:test/test`'s `run()`.
 *    - `--bench`: imports each bench file, then calls `boats:test/bench`'s `run()`.
 *
 * 3. **Event loop** — Calls `runLoop()`, a synchronous `while(true)` that
 *    alternates between draining the job queue and calling `tick()`
 *    to dispatch I/O events from kqueue/io_uring. The tick also polls child
 *    loops when the root loop is idle (structured concurrency).
 *
 *
 * ## The event loop in detail
 *
 * Boats's event loop model is unusual: instead of Rust managing a native async
 * executor, the loop is a plain synchronous JS `while` loop. Each iteration:
 *
 *   1. `drainMicrotasks()` — flushes all pending Boa promise continuations
 *      (microtasks). This is what makes `await` work: a resolved promise
 *      queues a microtask to resume its caller. Draining the queue runs those
 *      continuations to their next suspension point.
 *
 *   2. `tick(timeoutMs)` — calls `loop.tick(timeoutMs)` from `boats:runtime/loop`,
 *      which calls `kqueue.wait()` / `io_uring.wait()` to collect ready events,
 *      then resolves the corresponding JS Promises. It also recursively ticks child
 *      loops when the root loop has no pending I/O of its own. Those resolutions
 *      queue more microtasks for the next `drainMicrotasks()` call.
 *
 *   3. The loop exits when `isDone()` (the user's script finished) AND
 *      `loop.alive()` returns false (no live I/O loop handles remain).
 *
 * The "smart timeout" avoids busy-spinning: if no events have arrived for
 * 3 consecutive ticks, we block for up to 50 ms waiting for I/O. The moment
 * any event arrives (or a timer fires) the kernel wakes us immediately. This
 * keeps CPU near zero during idle periods while maintaining low latency.
 *
 *
 * ## Event loop integration
 *
 * `boats:runtime/loop` exports `tick()` and `alive()` which are imported
 * statically. `tick()` returns 0 and `alive()` returns false when no loop
 * handles exist, so `runLoop()` exits immediately after microtasks drain in
 * that case.
 *
 *
 * ## Contributing
 *
 * - Do not add `await` at the top level of this file.
 * - Do not statically import modules that have top-level `await` (e.g.
 *   `boats:runtime/loop`), as that would make this module implicitly async.
 * - The `runLoop` function is deliberately simple — keep it that way. If you
 *   need a new run mode, follow the pattern of `--test` and `--bench`.
 * - Error handling: unhandled promise rejections propagate through `caughtError`
 *   and are rethrown after the loop, causing a non-zero exit code via Boa.
 */

import { argv, exit } from 'boats:runtime/process';
import { drainMicrotasks } from 'internal:async-context';
import { tick, alive } from 'boats:runtime/loop';
import 'internal:loader';
import {
  Event, CustomEvent, EventTarget,
  CountQueuingStrategy, ByteLengthQueuingStrategy,
  ReadableStreamDefaultController, ReadableByteStreamController,
  ReadableStreamBYOBRequest,
  ReadableStream, ReadableStreamDefaultReader, ReadableStreamBYOBReader,
  WritableStreamDefaultController, WritableStream, WritableStreamDefaultWriter,
  TransformStreamDefaultController, TransformStream,
  AbortController, AbortSignal,
  Blob, File,
  TextEncoder, TextDecoder,
  atob, btoa, structuredClone,
  FormData,
  URL, URLSearchParams,
  URLPattern,
  console,
  crypto, cryptoAvailable, tlsAvailable,
  fetch,
  Headers, Request, Response,
  CompressionStream, DecompressionStream,
} from 'internal:globals/global';

globalThis.Event                          = Event;
globalThis.CustomEvent                    = CustomEvent;
globalThis.EventTarget                    = EventTarget;
globalThis.CountQueuingStrategy           = CountQueuingStrategy;
globalThis.ByteLengthQueuingStrategy      = ByteLengthQueuingStrategy;
globalThis.ReadableStreamDefaultController = ReadableStreamDefaultController;
globalThis.ReadableByteStreamController   = ReadableByteStreamController;
globalThis.ReadableStreamBYOBRequest      = ReadableStreamBYOBRequest;
globalThis.ReadableStream                 = ReadableStream;
globalThis.ReadableStreamDefaultReader    = ReadableStreamDefaultReader;
globalThis.ReadableStreamBYOBReader       = ReadableStreamBYOBReader;
globalThis.WritableStreamDefaultController = WritableStreamDefaultController;
globalThis.WritableStream                 = WritableStream;
globalThis.WritableStreamDefaultWriter    = WritableStreamDefaultWriter;
globalThis.TransformStreamDefaultController = TransformStreamDefaultController;
globalThis.TransformStream                = TransformStream;
globalThis.AbortController                = AbortController;
globalThis.AbortSignal                    = AbortSignal;
globalThis.Blob                           = Blob;
globalThis.File                           = File;
globalThis.TextEncoder                    = TextEncoder;
globalThis.TextDecoder                    = TextDecoder;
globalThis.atob                           = atob;
globalThis.btoa                           = btoa;
globalThis.structuredClone                = structuredClone;
globalThis.FormData                       = FormData;
globalThis.URL                            = URL;
globalThis.URLSearchParams                = URLSearchParams;
globalThis.URLPattern                     = URLPattern;
globalThis.console                        = console;
globalThis.crypto                         = crypto;
globalThis.cryptoAvailable                = cryptoAvailable;
globalThis.tlsAvailable                   = tlsAvailable;
globalThis.fetch                          = fetch;
globalThis.Headers                        = Headers;
globalThis.Request                        = Request;
globalThis.Response                       = Response;
globalThis.CompressionStream              = CompressionStream;
globalThis.DecompressionStream            = DecompressionStream;

// Web-compat globals
globalThis.self = globalThis;
(globalThis as any).navigator = { userAgent: 'Boats/0.1' };
(globalThis as any).reportError = function reportError(err: unknown): void {
  // Report an error to the global error handler (console.error as fallback).
  (globalThis as any).console?.error('Unhandled error:', err);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drive the event loop until `isDone` returns true and no active I/O loops remain.
 * Uses a smart timeout: polls quickly when active, blocks (50 ms) when idle.
 */
function runLoop(isDone: () => boolean): void {
  let emptyTicks = 0;
  while (true) {
    drainMicrotasks();
    if (isDone() && !alive()) break;
    const timeout = emptyTicks >= 3 ? 50 : 0;
    const count = tick(timeout);
    emptyTicks = count === 0 ? emptyTicks + 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (argv.length < 2) {
  console.error('Usage: boats <script.mjs>');
  console.error('       boats --test  <file.mjs>...');
  console.error('       boats --bench <file.mjs>...');
} else if (argv[1] === '--test') {
  // --test mode: import each file, then run all registered tests.
  // Shell glob-expands patterns before boats sees them (argv[2..] are paths).
  const testFiles = [];
  for (let i = 2; i < argv.length; i++) testFiles.push(argv[i]);

  if (testFiles.length === 0) {
    console.error('boats --test: no test files specified');
  } else {
    let done = false;
    let caughtError = null;
    (async () => {
      await import('internal:globals/time');
      for (const f of testFiles) await import(f);
      const { run } = await import('boats:test/test');
      await run();
    })().then(
      () => { done = true; },
      (e) => { caughtError = e; done = true; },
    );

    // Drive microtasks (tests may be purely async, no I/O loop needed).
    runLoop(() => done);
    if (caughtError) { console.error(caughtError); exit(1); }
  }
} else if (argv[1] === '--bench') {
  // --bench mode: import each file, then run all registered benchmarks.
  const benchFiles = [];
  for (let i = 2; i < argv.length; i++) benchFiles.push(argv[i]);

  if (benchFiles.length === 0) {
    console.error('boats --bench: no bench files specified');
  } else {
    let done = false;
    let caughtError = null;
    (async () => {
      await import('internal:globals/time');
      for (const f of benchFiles) await import(f);
      const { run } = await import('boats:test/bench');
      await run();
    })().then(
      () => { done = true; },
      (e) => { caughtError = e; done = true; },
    );

    runLoop(() => done);
    if (caughtError) { console.error(caughtError); exit(1); }
  }
} else {
  // Normal mode: import and evaluate the user's script.
  let done = false;
  let caughtError = null;
  import('internal:globals/time').then(() => import(argv[1])).then(
    () => { done = true; },
    (e) => { caughtError = e; done = true; },
  );

  runLoop(() => done);
  if (caughtError) { console.error(caughtError); exit(1); }
}
