/**
 * fino:global — web-standard globals registry.
 *
 * This module is a barrel re-export that collects all web-platform APIs that
 * should be available as globals. It serves two purposes:
 *
 * 1. **globalThis registration** — `js/_main.mjs` imports `fino:global` and
 *    assigns each export onto `globalThis`, making them available without an
 *    explicit import in user scripts (just like browsers and Node.js).
 *
 * 2. **Explicit import** — userland code can import from `fino:global`
 *    directly if it needs a named import that is guaranteed to be the same
 *    object as the global, or if the script is running in a context where
 *    globals aren't set up yet.
 *
 *
 * ## Why a separate module?
 *
 * Separating global registration from the individual module implementations
 * keeps each module self-contained and independently importable. `fino:url`
 * doesn't know or care that `URL` ends up on `globalThis` — that is
 * `fino:global`'s concern. This also makes it easy to add or remove globals:
 * add an export here and `_main.mjs`'s assignment loop picks it up.
 *
 *
 * ## What is NOT here
 *
 * - `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` — also
 *   set on globalThis by `_main.mjs` but come from `fino:loop` directly, not
 *   this module, because they're wired to a specific loop handle.
 * - `process` — available as `fino:process` but not on globalThis (fino is
 *   not Node.js; prefer explicit imports for process-level APIs).
 */

export { Event, CustomEvent, EventTarget } from './eventtarget.mts';
export {
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
} from './webstreams.mts';
export { AbortController, AbortSignal } from './abort.mts';
export { Blob, File } from './blob.mts';
export { TextEncoder, TextDecoder, atob, btoa, structuredClone } from './encoding.mts';
export { FormData } from './formdata.mts';
export { URL, URLSearchParams } from './url.mts';
export { URLPattern } from './urlpattern.mts';
export { default as console } from './console.mts';
export { crypto, cryptoAvailable, tlsAvailable } from './crypto.mts';
export { fetch } from './fetch.mts';
export { Headers, Request, Response } from '../../net/http.mts';
export { CompressionStream, DecompressionStream } from './compression-streams.mts';
export { WebSocket, MessageEvent, CloseEvent, ErrorEvent } from '../../net/websocket.mts';
