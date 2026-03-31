/**
 * boats:global — web-standard globals registry.
 *
 * This module is a barrel re-export that collects all web-platform APIs that
 * should be available as globals. It serves two purposes:
 *
 * 1. **globalThis registration** — `js/_main.mjs` imports `boats:global` and
 *    assigns each export onto `globalThis`, making them available without an
 *    explicit import in user scripts (just like browsers and Node.js).
 *
 * 2. **Explicit import** — userland code can import from `boats:global`
 *    directly if it needs a named import that is guaranteed to be the same
 *    object as the global, or if the script is running in a context where
 *    globals aren't set up yet.
 *
 *
 * ## Why a separate module?
 *
 * Separating global registration from the individual module implementations
 * keeps each module self-contained and independently importable. `boats:url`
 * doesn't know or care that `URL` ends up on `globalThis` — that is
 * `boats:global`'s concern. This also makes it easy to add or remove globals:
 * add an export here and `_main.mjs`'s assignment loop picks it up.
 *
 *
 * ## What is NOT here
 *
 * - `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` — also
 *   set on globalThis by `_main.mjs` but come from `boats:loop` directly, not
 *   this module, because they're wired to a specific loop handle.
 * - `process` — available as `boats:process` but not on globalThis (boats is
 *   not Node.js; prefer explicit imports for process-level APIs).
 */

export { Event, CustomEvent, EventTarget } from 'internal:globals/eventtarget';
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
} from 'internal:globals/webstreams';
export { AbortController, AbortSignal } from 'internal:globals/abort';
export { Blob, File } from 'internal:globals/blob';
export { TextEncoder, TextDecoder, atob, btoa, structuredClone } from 'internal:globals/encoding';
export { FormData } from 'internal:globals/formdata';
export { URL, URLSearchParams } from 'internal:globals/url';
export { URLPattern } from 'internal:globals/urlpattern';
export { default as console } from 'internal:globals/console';
export { crypto, cryptoAvailable, tlsAvailable } from 'internal:globals/crypto';
export { fetch } from 'internal:globals/fetch';
export { Headers, Request, Response } from 'boats:net/http';
export { CompressionStream, DecompressionStream } from 'internal:globals/compression-streams';
