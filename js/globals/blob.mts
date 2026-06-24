/**
 * Blob and File globals (WHATWG File API).
 *
 * `Blob` is an immutable byte sequence with an associated MIME type. It is
 * the standard way to carry binary data in web APIs: fetch Request/Response
 * bodies, FormData values, and FileReader all work in terms of Blobs. `File`
 * extends `Blob` with a `name` and `lastModified` timestamp.
 *
 * WHATWG File API: https://w3c.github.io/FileAPI/
 *
 *
 * ## Internal byte storage
 *
 * All Blob content is eagerly concatenated into a single `Uint8Array` on
 * construction. String parts honor `endings: 'native'` by normalizing CRLF,
 * CR, and LF sequences to the runtime's native newline before UTF-8 encoding;
 * non-string parts remain byte-preserving. The WHATWG spec allows lazy
 * concatenation (Blob objects can reference other Blobs by ref), but eager
 * flattening is simpler and correct for our use case where Blobs are typically
 * small-to-medium in-memory values rather than multi-GB file handles.
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

/**
 * Return the internal byte store for a Blob or File.
 *
 * This helper is exported for other internal modules, notably structuredClone.
 * It returns the module-owned Uint8Array, so callers must treat it as read-only
 * and copy before exposing bytes to user code.
 *
 * ```typescript no_run
 * const blob = new Blob(['hello']);
 * const bytes = _getBlobBytes(blob);
 * bytes.byteLength; // 5
 * ```
 *
 * @internal
 */
export function _getBlobBytes(blob: Blob): Uint8Array {
  return _blobBytes.get(blob)!;
}

type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob;
type EndingType = 'transparent' | 'native';

interface BlobOptions {
  type?: string;
  endings?: EndingType;
  bytes?: Uint8Array;
}

interface FileOptions extends BlobOptions {
  lastModified?: number;
}

function _normalizeLineEndings(value: string, endings: EndingType): string {
  if (endings !== 'native') return value;
  return value.replace(/\r\n|\r|\n/g, '\n');
}

function _normalizeOptions(options: BlobOptions | null | undefined): BlobOptions | null | undefined {
  if (options == null) return options;
  const kind = typeof options;
  if (kind !== 'object' && kind !== 'function') {
    throw new TypeError('Blob options must be an object or null.');
  }
  return options;
}

function _normalizeEndings(options: BlobOptions | null | undefined): EndingType {
  if (options == null) return 'transparent';
  const value = options.endings;
  if (value === undefined) return 'transparent';
  const endings = String(value);
  if (endings === 'transparent' || endings === 'native') return endings;
  throw new TypeError(`Invalid Blob endings value: ${endings}`);
}

function _toWebIdlLongLong(value: unknown): number {
  const number = Number(value);
  if (Number.isNaN(number)) return 0;
  if (!Number.isFinite(number)) return number;
  const sign = number < 0 ? -1 : 1;
  const abs = Math.abs(number);
  const floor = Math.floor(abs);
  const fraction = abs - floor;
  if (fraction < 0.5) return sign * floor;
  if (fraction > 0.5) return sign * (floor + 1);
  return sign * (floor % 2 === 0 ? floor : floor + 1);
}

function _normalizePart(part: BlobPart, endings: EndingType): Uint8Array {
  if (typeof part === 'string') {
    return encodeUtf8(_normalizeLineEndings(part, endings));
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

/**
 * Web Blob facade backed by an immutable in-memory byte store.
 *
 * Blob parts are eagerly normalized and concatenated during construction.
 * MIME types are lowercased and rejected to the empty string when they contain
 * non-ASCII printable characters. Methods that expose bytes return copies.
 *
 * ```typescript no_run
 * const blob = new Blob(['hello'], { type: 'TEXT/PLAIN' });
 * blob.type; // "text/plain"
 * await blob.text(); // "hello"
 * ```
 */
export class Blob {
  /**
   * Private property `#bytes` used by `Blob`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bytes = undefined;
   *
   *   readInternalState() {
   *     return this.#bytes;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bytes: Uint8Array;
  /**
   * Private property `#type` used by `Blob`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #type = undefined;
   *
   *   readInternalState() {
   *     return this.#type;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #type: string;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new Blob()); // "[object Blob]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'Blob'; }

  /**
   * Create a Blob from strings, buffers, views, or other Blobs.
   *
   * Omitted parts create an empty Blob. Non-iterable parts, including `null`,
   * throw a TypeError. `endings: 'native'` normalizes string-part line endings
   * before encoding; the default `transparent` preserves them. The internal
   * BYTES_INIT path is private to this module and is used by slice() to avoid
   * re-normalizing already-owned bytes.
   *
   * ```typescript no_run
   * const bytes = new Uint8Array([104, 105]);
   * const blob = new Blob(['prefix-', bytes], { type: 'text/plain' });
   * blob.size; // 9
   * ```
   */
  constructor(parts?: Iterable<BlobPart> | typeof BYTES_INIT | null, options?: BlobOptions | null) {
    if (parts === BYTES_INIT) {
      // Internal path: options is { bytes: Uint8Array, type: string }
      this.#bytes = options!.bytes!;
      this.#type  = options!.type ?? '';
      _blobBytes.set(this, this.#bytes);
      return;
    }

    options = _normalizeOptions(options);
    const rawType = options != null && options.type != null ? String(options.type) : '';
    const lowered = rawType.toLowerCase();
    // Per WHATWG: if any char is outside U+0020–U+007E, set type to empty string
    this.#type = /[^\x20-\x7e]/.test(lowered) ? '' : lowered;
    const endings = _normalizeEndings(options);

    if (parts === undefined) {
      this.#bytes = new Uint8Array(0);
      _blobBytes.set(this, this.#bytes);
      return;
    }
    if (typeof parts === 'string' || parts === null || typeof (parts as any)[Symbol.iterator] !== 'function') {
      throw new TypeError('Failed to construct Blob: The provided value cannot be converted to a sequence.');
    }

    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      chunks.push(_normalizePart(part, endings));
    }
    this.#bytes = _concat(chunks);
    _blobBytes.set(this, this.#bytes);
  }

  /**
   * Number of bytes in the Blob.
   *
   * The value is computed from the immutable internal byte store.
   *
   * ```typescript no_run
   * new Blob(['abc']).size; // 3
   * ```
   */
  get size() { return this.#bytes.byteLength; }

  /**
   * Normalized MIME type for the Blob.
   *
   * The value is lowercased. Invalid type strings containing characters outside
   * U+0020 through U+007E become the empty string.
   *
   * ```typescript no_run
   * new Blob([], { type: 'Application/JSON' }).type; // "application/json"
   * ```
   */
  get type() { return this.#type; }

  /**
   * Return a new Blob containing a byte range from this Blob.
   *
   * Negative indexes are resolved from the end, bounds are clamped to the Blob
   * size, and end values before start produce an empty Blob. The contentType
   * argument becomes the returned Blob type after the same normalization rules.
   *
   * ```typescript no_run
   * const blob = new Blob(['abcdef']);
   * await blob.slice(1, 4).text(); // "bcd"
   * ```
   */
  slice(start?: number, end?: number, contentType?: string): Blob {
    const size = this.#bytes.byteLength;
    let s = start === undefined ? 0 : _toWebIdlLongLong(start);
    let e = end   === undefined ? size : _toWebIdlLongLong(end);
    if (s < 0) s = Math.max(size + s, 0); else s = Math.min(s, size);
    if (e < 0) e = Math.max(size + e, 0); else e = Math.min(e, size);
    const len = Math.max(e - s, 0);
    const sliced = this.#bytes.slice(s, s + len);
    const rawType = contentType !== undefined ? String(contentType).toLowerCase() : '';
    // Per spec: if contentType contains chars outside 0x20–0x7E, use empty string
    const type = /[^\x20-\x7E]/.test(rawType) ? '' : rawType;
    return new Blob(BYTES_INIT, { bytes: sliced, type });
  }

  /**
   * Decode the Blob bytes as UTF-8 text.
   *
   * Invalid UTF-8 sequences follow the internal decoder's replacement behavior.
   * The method resolves to a string and does not mutate the Blob.
   *
   * ```typescript no_run
   * const text = await new Blob(['hello']).text();
   * ```
   */
  async text(): Promise<string> {
    return decodeUtf8(this.#bytes);
  }

  /**
   * Create a ReadableStream that emits the Blob contents as UTF-8 text.
   *
   * The MIME type charset parameter is ignored, matching the File API text
   * decoding rules used by text(). Empty blobs close without emitting chunks.
   *
   * ```typescript no_run
   * const chunks = [];
   * for await (const chunk of new Blob(['hi']).textStream()) chunks.push(chunk);
   * ```
   */
  textStream(): ReadableStream<string> {
    const text = decodeUtf8(this.#bytes);
    return new ReadableStream({
      pull(controller: ReadableStreamDefaultController<string>) {
        if (text.length > 0) controller.enqueue(text);
        controller.close();
      },
    }, undefined);
  }

  /**
   * Copy the Blob bytes into a new ArrayBuffer.
   *
   * The returned buffer is detached from Blob storage, so modifications to a
   * view over it cannot change the Blob.
   *
   * ```typescript no_run
   * const buffer = await new Blob(['hi']).arrayBuffer();
   * new Uint8Array(buffer).byteLength; // 2
   * ```
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    // Return a copy to prevent mutation of internal state.
    return this.#bytes.buffer.slice(
      this.#bytes.byteOffset,
      this.#bytes.byteOffset + this.#bytes.byteLength
    ) as ArrayBuffer;
  }

  /**
   * Copy the Blob bytes into a new Uint8Array.
   *
   * This is a convenience over arrayBuffer() when callers want a typed array.
   * The returned array is safe to mutate.
   *
   * ```typescript no_run
   * const bytes = await new Blob(['hi']).bytes();
   * bytes[0]; // 104
   * ```
   */
  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.#bytes);
  }

  /**
   * Create a ReadableStream for the Blob contents.
   *
   * The current implementation emits one copied Uint8Array chunk and then
   * closes. It is suitable for piping Blob bodies without exposing storage.
   *
   * ```typescript no_run
   * const stream = new Blob(['hi']).stream();
   * const reader = stream.getReader();
   * await reader.read();
   * ```
   */
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

/**
 * File extends Blob with a filename and lastModified timestamp.
 *
 * File contents use the same eager in-memory byte store as Blob. The name is
 * string-coerced and lastModified defaults to Date.now() when omitted.
 *
 * ```typescript no_run
 * const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
 * file.name; // "hello.txt"
 * ```
 */
export class File extends Blob {
  /**
   * Private property `#name` used by `File`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #name = undefined;
   *
   *   readInternalState() {
   *     return this.#name;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #name: string;
  /**
   * Private property `#lastModified` used by `File`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #lastModified = undefined;
   *
   *   readInternalState() {
   *     return this.#lastModified;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #lastModified: number;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new File([], 'x')); // "[object File]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'File'; }

  /**
   * Create a File from Blob parts and metadata.
   *
   * The options type and endings are passed through Blob normalization.
   * lastModified is truncated to an integer millisecond timestamp; when absent,
   * Date.now() is captured at construction time.
   *
   * ```typescript no_run
   * const file = new File(['data'], 'data.bin', { lastModified: 0 });
   * file.lastModified; // 0
   * ```
   */
  constructor(parts: Iterable<BlobPart> | null, name: string, options?: FileOptions | null) {
    if (arguments.length < 2) {
      throw new TypeError('Failed to construct File: 2 arguments required.');
    }
    super(parts, options);
    this.#name = String(name);
    this.#lastModified = options != null && options.lastModified != null
      ? Math.trunc(Number(options.lastModified))
      : Date.now();
  }

  /**
   * File name supplied at construction.
   *
   * The name is not path-normalized or sanitized; callers should validate it
   * before using it on a filesystem.
   *
   * ```typescript no_run
   * new File([], 'avatar.png').name; // "avatar.png"
   * ```
   */
  get name()         { return this.#name; }

  /**
   * Last modified time in Unix epoch milliseconds.
   *
   * The value is an integer and defaults to the construction time.
   *
   * ```typescript no_run
   * new File([], 'x', { lastModified: 123 }).lastModified; // 123
   * ```
   */
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
