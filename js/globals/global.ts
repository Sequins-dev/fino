/**
 * internal:globals/global — web-standard globals registry.
 *
 * A barrel that collects every web-platform API fino installs on
 * `globalThis`. Runtime bootstrap (`js/internal/bootstrap.ts`) imports the
 * named exports and defines each one as a global property, so user scripts
 * can use `URL`, `fetch`, `ReadableStream`, and friends without an explicit
 * import — just like browsers. Each API is implemented in its own sibling
 * module under `js/globals/` (`Headers`, `Request`, and `Response` come from
 * `internal:net/http/wire`); the WHATWG/W3C spec links live with each
 * implementation.
 *
 *
 * ## Why a separate module?
 *
 * Separating global registration from the individual implementations keeps
 * each module self-contained. The URL implementation does not need to know
 * or care that `URL` ends up on `globalThis`; that is this registry's
 * concern. To add a global, export it here and add it to bootstrap's
 * registration table — the table is an explicit object literal, so a new
 * export is not picked up automatically.
 *
 *
 * ## What is NOT here
 *
 * - `setTimeout` / `setInterval` / `setImmediate` / `queueMicrotask` /
 *   `performance` — also set on globalThis by runtime bootstrap but sourced
 *   from `globals/time.ts`, because they are wired to a specific loop handle.
 * - `process` — available as `fino:process` but not on globalThis (fino is
 *   not Node.js; prefer explicit imports for process-level APIs).
 *
 * Not every export here becomes a global, either: `_flushPorts` is a
 * bootstrap-only hook that delivers queued `MessagePort` messages once per
 * loop turn, and is never assigned to `globalThis`.
 *
 * ```ts no_run
 * const url = new URL('https://example.com/');
 * const stream = ReadableStream.from(['chunk']);
 * const response = await fetch(url.href);
 * ```
 *
 */
/**
 * DOM event primitives — `Event`, `CustomEvent`, and the `EventTarget`
 * listener/dispatch interface (WHATWG DOM).
 */
export {
  Event,
  CustomEvent,
  EventTarget,
  type AddEventListenerOptions,
  type EventCallback,
} from './eventtarget.ts';
/**
 * WHATWG Streams — readable, writable, and transform streams plus their
 * controllers, readers, writers, and queuing strategies.
 */
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
} from './webstreams.ts';
/**
 * Cancellation primitives — `AbortController` and `AbortSignal` (WHATWG DOM).
 */
export { AbortController, AbortSignal } from './abort.ts';
/**
 * File API — immutable binary `Blob`/`File` values, `FileList`, and the
 * asynchronous `FileReader`.
 */
export { Blob, File, FileList, FileReader } from './blob.ts';
/**
 * Text and binary conversion plus web error types — UTF-8
 * `TextEncoder`/`TextDecoder`, base64 `atob`/`btoa`, `structuredClone`, and
 * the `DOMException`/`QuotaExceededError` classes kept for web compatibility.
 */
export {
  DOMException,
  QuotaExceededError,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  structuredClone,
} from './encoding.ts';
/**
 * `multipart/form-data` container consumed by `fetch` request bodies.
 */
export { FormData, type FormDataEntryValue } from './formdata.ts';
/**
 * WHATWG URL parsing — `URL` and `URLSearchParams`.
 */
export { URL, URLSearchParams } from './url.ts';
/**
 * Route-style URL matching (URLPattern standard).
 */
export { URLPattern } from './urlpattern.ts';
/**
 * The `console` logging namespace (WHATWG Console).
 */
export { default as console } from './console.ts';
/**
 * Web Crypto backed by OpenSSL, plus the fino-specific `cryptoAvailable` and
 * `tlsAvailable` flags reporting whether the libcrypto/libssl backends loaded.
 */
export { CryptoKey, crypto, cryptoAvailable, tlsAvailable } from './crypto.ts';
/**
 * The `fetch` HTTP client entry point (WHATWG Fetch).
 */
export { fetch, type FetchInit } from './fetch.ts';
/**
 * Fetch-compatible `Headers`, `Request`, and `Response`, shared with the HTTP
 * server stack via `internal:net/http/wire`.
 */
export { Headers, Request, Response } from 'internal:net/http/wire';
/**
 * Compression Streams — transform streams for gzip/deflate/deflate-raw, with
 * brotli as a runtime extension when the system library is available.
 */
export { CompressionStream, DecompressionStream } from './compression-streams.ts';
/**
 * Server-Sent Events client (HTML spec).
 */
export { EventSource } from './eventsource.ts';
/**
 * WebSocket client with standard `CloseEvent` and `ErrorEvent` companions.
 */
export { WebSocket, CloseEvent, ErrorEvent } from './websocket.ts';
/**
 * WebTransport client over fino's HTTP/3 and QUIC stack (W3C WebTransport).
 */
export { WebTransport, WebTransportDatagramDuplexStream } from './webtransport.ts';
/**
 * Structured-clone messaging — `MessageEvent`, `MessagePort`,
 * `MessageChannel`, and the bootstrap-only `_flushPorts` delivery hook.
 */
export { MessageEvent, MessagePort, MessageChannel, _flushPorts } from './messaging.ts';
/**
 * One-to-many pub/sub across realms addressed by channel name (HTML
 * BroadcastChannel).
 */
export { BroadcastChannel } from './broadcast-channel.ts';
