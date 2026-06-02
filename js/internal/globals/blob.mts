/**
 * fino:blob — Blob and File (WHATWG File API)
 *
 * `Blob` is an immutable byte sequence with an associated MIME type. It is
 * the standard way to carry binary data in web APIs: fetch Request/Response
 * bodies, FormData values, and FileReader all work in terms of Blobs. `File`
 * extends `Blob` with a `name` and `lastModified` timestamp.
 *
 *
 * ## Internal byte storage
 *
 * All Blob content is eagerly concatenated into a single `Uint8Array` on
 * construction. The WHATWG spec allows lazy concatenation (Blob objects can
 * reference other Blobs by ref), but eager flattening is simpler and correct
 * for our use case where Blobs are typically small-to-medium in-memory
 * values rather than multi-GB file handles.
 *
 *
 * ## The BYTES_INIT sentinel
 *
 * `slice()` needs to construct a Blob directly from raw bytes, bypassing the
 * normal `parts` iteration and normalization logic. Rather than adding a
 * public constructor overload or a static factory, we use a module-private
 * `Symbol('bytes-init')` as a sentinel first argument. When the constructor
 * sees `parts === BYTES_INIT`, it treats the second argument as
 * `{ bytes: Uint8Array, type: string }` and uses those values directly.
 * This keeps the fast path clean and invisible to external callers.
 *
 *
 * ## The _blobBytes WeakMap
 *
 * `_normalizePart()` needs to read the internal bytes of a Blob (or File)
 * that appears as a part in another Blob's constructor. Since `#bytes` is a
 * private field only accessible within the class body, module-level helpers
 * can't reach it directly. The `_blobBytes` WeakMap is populated in the
 * constructor (`_blobBytes.set(this, this.#bytes)`) to give module-level
 * code read access to internal bytes without exposing a public getter.
 *
 *
 * ## arrayBuffer() returns a copy
 *
 * `blob.arrayBuffer()` returns a copy of the internal buffer (via
 * `buffer.slice()`), not a view into it. This prevents callers from mutating
 * the Blob's internal state through the returned ArrayBuffer. `bytes()`
 * similarly returns a fresh `new Uint8Array(this.#bytes)` copy. The `stream()`
 * method yields a single chunk (also a copy) as an async iterable — sufficient
 * for piping to a Writer without requiring a streaming infrastructure.
 *
 *
 * ## slice() semantics
 *
 * `slice(start, end, contentType)` follows the WHATWG spec: negative indices
 * are resolved relative to the blob size, values are clamped to [0, size],
 * and `end < start` produces an empty Blob. The content type of the resulting
 * Blob is the provided `contentType` (lowercased), or empty string if omitted.
 *
 *
 * ```ts no_run
 * // Blob and File are available via globalThis
 *
 * const blob = new Blob(['hello, ', 'world'], { type: 'text/plain' });
 * blob.size;                // 12
 * await blob.text();        // 'hello, world'
 * await blob.bytes();       // Uint8Array
 * await blob.arrayBuffer(); // ArrayBuffer
 * blob.slice(0, 5);         // new Blob containing 'hello'
 *
 * const file = new File([blob], 'hello.txt', { type: 'text/plain' });
 * file.name;                // 'hello.txt'
 * file.lastModified;        // number (ms since epoch)
 * ```
 *
 * @internal
 */

import { encodeUtf8, decodeUtf8, _registerBlobCloneHelper } from './encoding.mts';
import { ReadableStream } from './webstreams.mts';

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

// Sentinel to allow slice() to construct a Blob from raw bytes without
// going through the normal parts-processing path.
const BYTES_INIT = Symbol('bytes-init');

// WeakMap exposing internal bytes to module-level helpers (e.g. _normalizePart).
// All Blob and File instances register here on construction.
const _blobBytes = new WeakMap<Blob, Uint8Array>();

/** Friend-function: returns the internal byte store of a Blob/File for cloning. */
export function _getBlobBytes(blob: Blob): Uint8Array {
  return _blobBytes.get(blob)!;
}

type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;

function _normalizePart(part: BlobPart): Uint8Array {
  if (typeof part === 'string') {
    return encodeUtf8(part);
  }
  if (part instanceof Blob && _blobBytes.has(part)) {
    // Blob or File — grab its internal bytes
    return _blobBytes.get(part)!;
  }
  if (part instanceof ArrayBuffer) {
    return new Uint8Array(part);
  }
  if (ArrayBuffer.isView(part)) {
    return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  }
  return encodeUtf8(String(part));
}

function _concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i]!.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i]!, offset);
    offset += chunks[i]!.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blob
// ---------------------------------------------------------------------------

/** Web `Blob` facade backed by an immutable in-memory byte store. */
export class Blob {
  #bytes: Uint8Array;
  #type: string;

  get [Symbol.toStringTag]() { return 'Blob'; }

  constructor(parts?: Iterable<BlobPart> | typeof BYTES_INIT | null, options?: { type?: string; bytes?: Uint8Array } | null) {
    if (parts === BYTES_INIT) {
      // Internal path: options is { bytes: Uint8Array, type: string }
      this.#bytes = options!.bytes!;
      this.#type  = options!.type ?? '';
      _blobBytes.set(this, this.#bytes);
      return;
    }

    const rawType = options != null && options.type != null ? String(options.type) : '';
    const lowered = rawType.toLowerCase();
    // Per WHATWG: if any char is outside U+0020–U+007E, set type to empty string
    this.#type = /[^\x20-\x7e]/.test(lowered) ? '' : lowered;

    if (parts == null) {
      this.#bytes = new Uint8Array(0);
      _blobBytes.set(this, this.#bytes);
      return;
    }
    if (typeof (parts as any)[Symbol.iterator] !== 'function') {
      throw new TypeError('Failed to construct Blob: The provided value cannot be converted to a sequence.');
    }

    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      chunks.push(_normalizePart(part));
    }
    this.#bytes = _concat(chunks);
    _blobBytes.set(this, this.#bytes);
  }

  get size() { return this.#bytes.byteLength; }
  get type() { return this.#type; }

  slice(start?: number, end?: number, contentType?: string): Blob {
    const size = this.#bytes.byteLength;
    let s = start === undefined ? 0 : Math.trunc(Number(start));
    let e = end   === undefined ? size : Math.trunc(Number(end));
    if (s < 0) s = Math.max(size + s, 0); else s = Math.min(s, size);
    if (e < 0) e = Math.max(size + e, 0); else e = Math.min(e, size);
    const len = Math.max(e - s, 0);
    const sliced = this.#bytes.slice(s, s + len);
    const rawType = contentType != null ? String(contentType).toLowerCase() : '';
    // Per spec: if contentType contains chars outside 0x20–0x7E, use empty string
    const type = /[^\x20-\x7E]/.test(rawType) ? '' : rawType;
    return new Blob(BYTES_INIT, { bytes: sliced, type });
  }

  async text(): Promise<string> {
    return decodeUtf8(this.#bytes);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    // Return a copy to prevent mutation of internal state.
    return this.#bytes.buffer.slice(
      this.#bytes.byteOffset,
      this.#bytes.byteOffset + this.#bytes.byteLength
    ) as ArrayBuffer;
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.#bytes);
  }

  stream(): ReadableStream {
    const bytes = this.#bytes;
    return new ReadableStream({
      type: 'bytes',
      pull(controller: ReadableByteStreamController) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }, undefined);
  }
}

// ---------------------------------------------------------------------------
// File (extends Blob)
// ---------------------------------------------------------------------------

export class File extends Blob {
  #name: string;
  #lastModified: number;

  get [Symbol.toStringTag]() { return 'File'; }

  constructor(parts: Iterable<BlobPart> | null, name: string, options?: { type?: string; lastModified?: number } | null) {
    super(parts, options);
    this.#name = String(name);
    this.#lastModified = options != null && options.lastModified != null
      ? Math.trunc(Number(options.lastModified))
      : Date.now();
  }

  get name()         { return this.#name; }
  get lastModified() { return this.#lastModified; }
}

// Register the Blob clone helper with encoding.mts so structuredClone can
// clone Blob/File instances synchronously without a circular import.
_registerBlobCloneHelper({
  getBlobBytes: (b) => _blobBytes.get(b as Blob)!,
  BlobCtor: Blob as unknown as new (parts: Iterable<unknown>, opts?: { type?: string }) => object,
  FileCtor: File as unknown as new (parts: Iterable<unknown>, name: string, opts?: { type?: string; lastModified?: number }) => object,
  isBlob: (v) => v instanceof Blob,
  isFile: (v) => v instanceof File,
  getName: (v) => (v as File).name,
  getLastModified: (v) => (v as File).lastModified,
});
