/**
 * Web-standard globals registry.
 *
 * This module is a barrel re-export that collects all web-platform APIs that
 * should be available as globals. It serves two purposes:
 *
 * Web platform globals are defined across the WHATWG and W3C standards linked
 * from each implementation module re-exported here.
 *
 * 1. **globalThis registration** — runtime bootstrap imports this module and
 *    assigns each export onto `globalThis`, making them available without an
 *    explicit import in user scripts (just like browsers and Node.js).
 *
 * 2. **Internal collection** — runtime bootstrap imports this module to keep
 *    global registration centralized without exposing duplicate public module
 *    names for APIs that are already globals.
 *
 *
 * ## Why a separate module?
 *
 * Separating global registration from the individual module implementations
 * keeps each module self-contained. The URL implementation does not need to
 * know or care that `URL` ends up on `globalThis`; that is this registry's
 * concern. This also makes it easy to add or remove globals: add an export
 * here and bootstrap's assignment loop picks it up.
 *
 *
 * ## What is NOT here
 *
 * - `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` — also
 *   set on globalThis by runtime bootstrap but come from the loop directly,
 *   not this module, because they're wired to a specific loop handle.
 * - `process` — available as `fino:process` but not on globalThis (fino is
 *   not Node.js; prefer explicit imports for process-level APIs).
 *
 * ```typescript no_run
 * const url = new URL('https://example.com/');
 * const stream = ReadableStream.from(['chunk']);
 * const response = await fetch(url.href);
 * ```
 *
 */

export { Event, CustomEvent, EventTarget } from './eventtarget.ts';
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
export { AbortController, AbortSignal } from './abort.ts';
export { Blob, File, FileList, FileReader } from './blob.ts';
export { DOMException, QuotaExceededError, TextEncoder, TextDecoder, atob, btoa, structuredClone } from './encoding.ts';
export { FormData } from './formdata.ts';
export { URL, URLSearchParams } from './url.ts';
export { URLPattern } from './urlpattern.ts';
export { default as console } from './console.ts';
export { crypto, cryptoAvailable, tlsAvailable } from './crypto.ts';
export { fetch, FetchLaterResult, fetchLater } from './fetch.ts';
export { Headers, Request, Response } from 'internal:net/http/wire';
export { CompressionStream, DecompressionStream } from './compression-streams.ts';
export { EventSource } from './eventsource.ts';
export { WebSocket, WebSocketError, CloseEvent, ErrorEvent } from './websocket.ts';
export { WebTransport } from 'fino:net/http/webtransport';
export { MessageEvent, MessagePort, MessageChannel, ThreadPort, _flushPorts } from './messaging.ts';
export { BroadcastChannel } from './broadcast-channel.ts';
