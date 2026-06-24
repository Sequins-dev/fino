/**
 * Blob and File globals (WHATWG File API).
 *
 * `Blob` is an immutable byte sequence with an associated MIME type. It is
 * the standard way to carry binary data in web APIs: fetch Request/Response
 * bodies, FormData values, FileReader, and FileReaderSync all work in terms of
 * Blobs. `File` extends `Blob` with a `name` and `lastModified` timestamp.
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
 *
 * const syncReader = new FileReaderSync();
 * syncReader.readAsText(blob); // 'hello, world'
 * ```
 *
 */

import { btoa, DOMException, encodeUtf8, decodeUtf8, TextDecoder, _registerBlobCloneHelper } from './encoding.mts';
import { Event, EventTarget } from './eventtarget.mts';
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
        if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
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

// ---------------------------------------------------------------------------
// FileList
// ---------------------------------------------------------------------------

/**
 * Array-like list of File objects.
 *
 * FileList objects are produced by web APIs such as file inputs and drag/drop.
 * Fino exposes the interface for File API compatibility; there is no public
 * constructor, matching browsers.
 *
 * ```typescript no_run
 * try { new FileList(); } catch (err) { console.log(err instanceof TypeError); }
 * ```
 */
export interface FileList {
  readonly length: number;
  item(index: number): File | null;
}

type FileListConstructor = {
  readonly prototype: FileList;
  new(): FileList;
};

const _fileListItems = new WeakMap<FileList, File[]>();

export const FileList = (function FileList(): never {
  throw new TypeError('Illegal constructor');
}) as unknown as FileListConstructor;

function item(this: FileList, index: number): File | null {
  if (arguments.length < 1) throw new TypeError('FileList.item requires 1 argument');
  const items = _fileListItems.get(this);
  if (items === undefined) throw new TypeError('FileList receiver expected');
  return items[Number(index) >>> 0] ?? null;
}

const fileListLengthGetter = function(this: FileList): number {
  const items = _fileListItems.get(this);
  if (items === undefined) throw new TypeError('FileList receiver expected');
  return items.length;
};
Object.defineProperty(fileListLengthGetter, 'name', {
  value: 'get length',
  configurable: true,
});

Object.defineProperties(FileList.prototype, {
  item: {
    value: item,
    writable: true,
    enumerable: true,
    configurable: true,
  },
  length: {
    get: fileListLengthGetter,
    enumerable: true,
    configurable: true,
  },
  [Symbol.toStringTag]: {
    value: 'FileList',
    configurable: true,
  },
});

Object.defineProperty(FileList, 'length', {
  value: 0,
  configurable: true,
});
Object.defineProperty(FileList, 'prototype', {
  writable: false,
});

/**
 * Create a FileList for internal web API integrations.
 *
 * @internal
 */
export function _createFileList(files: Iterable<File> = []): FileList {
  const list = Object.create(FileList.prototype) as FileList;
  const items = Array.from(files);
  _fileListItems.set(list, items);
  for (let i = 0; i < items.length; i++) {
    Object.defineProperty(list, i, {
      value: items[i],
      enumerable: true,
      configurable: true,
    });
  }
  return list;
}

type FileReaderResult = string | ArrayBuffer | null;
type FileReaderReadKind = 'arrayBuffer' | 'binaryString' | 'dataURL' | 'text';
type FileReaderHandler = ((event: Event) => void) | null;
type FileReaderHandlerName = 'loadstart' | 'progress' | 'load' | 'abort' | 'error' | 'loadend';

function _bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

function _decodeFileReaderText(bytes: Uint8Array, blob: Blob, label?: string): string {
  let encoding = label;
  if (encoding === undefined) {
    const charset = /(?:^|;)\s*charset\s*=\s*([^;]+)/i.exec(blob.type)?.[1];
    encoding = charset?.trim().replace(/^"|"$/g, '');
  }
  if (encoding === undefined) {
    if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else encoding = 'utf-8';
  }
  return new TextDecoder(encoding).decode(bytes);
}

function _readBlobResult(blob: Blob, kind: FileReaderReadKind, label?: string): FileReaderResult {
  const bytes = _getBlobBytes(blob);
  if (kind === 'arrayBuffer') {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  if (kind === 'binaryString') return _bytesToBinaryString(bytes);
  if (kind === 'dataURL') {
    const type = blob.type.length === 0 ? 'application/octet-stream' : blob.type;
    return `data:${type};base64,${btoa(_bytesToBinaryString(bytes))}`;
  }
  return _decodeFileReaderText(bytes, blob, label);
}

/**
 * Asynchronous Blob reader from the File API.
 *
 * `FileReader` reads an in-memory `Blob` or `File` as text, an `ArrayBuffer`,
 * a binary string, or a data URL. Reads transition through `EMPTY`, `LOADING`,
 * and `DONE`, dispatching the standard `loadstart`, `progress`, `load`,
 * `abort`, `error`, and `loadend` events. Fino supports Blob-backed reads and
 * does not install filesystem-backed browser file handles.
 *
 * ```typescript no_run
 * const reader = new FileReader();
 * reader.onload = () => console.log(reader.result);
 * reader.readAsText(new Blob(['hello']));
 * ```
 */
export class FileReader extends EventTarget {
  /**
   * No read has started.
   *
   * ```typescript no_run
   * new FileReader().readyState === FileReader.EMPTY; // true
   * ```
   */
  static EMPTY = 0;
  /**
   * A read is currently in progress.
   *
   * ```typescript no_run
   * FileReader.LOADING; // 1
   * ```
   */
  static LOADING = 1;
  /**
   * The read completed, failed, or was aborted.
   *
   * ```typescript no_run
   * FileReader.DONE; // 2
   * ```
   */
  static DONE = 2;

  #eventHandlers: Record<FileReaderHandlerName, FileReaderHandler> = {
    loadstart: null,
    progress: null,
    load: null,
    abort: null,
    error: null,
    loadend: null,
  };
  #readyState = FileReader.EMPTY;
  #result: FileReaderResult = null;
  #error: DOMException | null = null;
  #readToken = 0;

  get [Symbol.toStringTag]() { return 'FileReader'; }
  get onloadstart() { return this.#eventHandlers.loadstart; }
  set onloadstart(value: FileReaderHandler) { this.#eventHandlers.loadstart = typeof value === 'function' ? value : null; }
  get onprogress() { return this.#eventHandlers.progress; }
  set onprogress(value: FileReaderHandler) { this.#eventHandlers.progress = typeof value === 'function' ? value : null; }
  get onload() { return this.#eventHandlers.load; }
  set onload(value: FileReaderHandler) { this.#eventHandlers.load = typeof value === 'function' ? value : null; }
  get onabort() { return this.#eventHandlers.abort; }
  set onabort(value: FileReaderHandler) { this.#eventHandlers.abort = typeof value === 'function' ? value : null; }
  get onerror() { return this.#eventHandlers.error; }
  set onerror(value: FileReaderHandler) { this.#eventHandlers.error = typeof value === 'function' ? value : null; }
  get onloadend() { return this.#eventHandlers.loadend; }
  set onloadend(value: FileReaderHandler) { this.#eventHandlers.loadend = typeof value === 'function' ? value : null; }
  get EMPTY() { return FileReader.EMPTY; }
  get LOADING() { return FileReader.LOADING; }
  get DONE() { return FileReader.DONE; }
  get readyState() { return this.#readyState; }
  get result() { return this.#result; }
  get error() { return this.#error; }

  dispatchEvent(event: Event): boolean {
    const ok = super.dispatchEvent(event);
    const handler = this.#eventHandlers[event.type as FileReaderHandlerName];
    if (typeof handler === 'function') {
      try { handler.call(this, event); } catch (_) {}
    }
    return ok;
  }

  readAsArrayBuffer(blob: Blob): void {
    this.#read(blob, 'arrayBuffer');
  }

  readAsBinaryString(blob: Blob): void {
    this.#read(blob, 'binaryString');
  }

  readAsDataURL(blob: Blob): void {
    this.#read(blob, 'dataURL');
  }

  readAsText(blob: Blob, encoding?: string): void {
    this.#read(blob, 'text', encoding);
  }

  abort(): void {
    if (this.#readyState === FileReader.EMPTY) {
      this.#result = null;
      return;
    }
    if (this.#readyState === FileReader.DONE) {
      this.#result = null;
      return;
    }

    this.#readToken++;
    this.#result = null;
    this.#error = null;
    this.#readyState = FileReader.DONE;
    this.dispatchEvent(new Event('abort'));
    this.dispatchEvent(new Event('loadend'));
  }

  #read(blob: Blob, kind: FileReaderReadKind, encoding?: string): void {
    if (!(blob instanceof Blob) || !_blobBytes.has(blob)) {
      throw new TypeError('FileReader: argument must be a Blob');
    }
    if (this.#readyState === FileReader.LOADING) {
      throw new DOMException('FileReader is already loading', 'InvalidStateError');
    }

    const token = ++this.#readToken;
    this.#readyState = FileReader.LOADING;
    this.#result = null;
    this.#error = null;

    queueMicrotask(() => {
      if (token !== this.#readToken || this.#readyState !== FileReader.LOADING) return;
      this.dispatchEvent(new Event('loadstart'));
      if (token !== this.#readToken || this.#readyState !== FileReader.LOADING) return;

      setTimeout(() => {
        this.#finishRead(blob, kind, token, encoding);
      }, 0);
    });
  }

  #finishRead(blob: Blob, kind: FileReaderReadKind, token: number, encoding?: string): void {
    if (token !== this.#readToken || this.#readyState !== FileReader.LOADING) return;
    const bytes = _getBlobBytes(blob);
    if (bytes.byteLength > 0) {
      this.dispatchEvent(new Event('progress'));
      if (token !== this.#readToken || this.#readyState !== FileReader.LOADING) return;
    }

    setTimeout(() => {
      this.#completeRead(blob, kind, token, encoding);
    }, 0);
  }

  #completeRead(blob: Blob, kind: FileReaderReadKind, token: number, encoding?: string): void {
    if (token !== this.#readToken || this.#readyState !== FileReader.LOADING) return;
    try {
      this.#result = _readBlobResult(blob, kind, encoding);
      this.#readyState = FileReader.DONE;
      this.dispatchEvent(new Event('load'));
    } catch (err) {
      this.#result = null;
      this.#error = err instanceof DOMException ? err : new DOMException(err instanceof Error ? err.message : String(err), 'NotReadableError');
      this.#readyState = FileReader.DONE;
      this.dispatchEvent(new Event('error'));
    }
    setTimeout(() => {
      if (token === this.#readToken && this.#readyState === FileReader.DONE) {
        this.dispatchEvent(new Event('loadend'));
      }
    }, 0);
  }
}

/**
 * Synchronous Blob reader from the File API.
 *
 * `FileReaderSync` exposes the worker-only synchronous read methods for
 * Blob-backed data. Fino does not install it on the normal global object; the
 * WPT worker harness installs it only for worker tests. Like `FileReader`,
 * reads are limited to in-memory `Blob` and `File` objects.
 *
 * ```typescript no_run
 * const reader = new FileReaderSync();
 * reader.readAsText(new Blob(['hello'])); // "hello"
 * ```
 */
export class FileReaderSync {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new FileReaderSync()); // "[object FileReaderSync]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'FileReaderSync'; }

  /**
   * Read Blob bytes into a new ArrayBuffer.
   *
   * The returned buffer is detached from Blob storage.
   */
  readAsArrayBuffer(blob: Blob): ArrayBuffer {
    return this.#read(blob, 'arrayBuffer') as ArrayBuffer;
  }

  /**
   * Read Blob bytes as a binary string.
   *
   * Each byte becomes one code unit with the same numeric value.
   */
  readAsBinaryString(blob: Blob): string {
    return this.#read(blob, 'binaryString') as string;
  }

  /**
   * Read Blob bytes as a data URL.
   *
   * Empty Blob types use `application/octet-stream`, matching FileReader.
   */
  readAsDataURL(blob: Blob): string {
    return this.#read(blob, 'dataURL') as string;
  }

  /**
   * Read Blob bytes as text.
   *
   * The optional encoding label follows the same decoding rules as
   * `FileReader.readAsText`.
   */
  readAsText(blob: Blob, encoding?: string): string {
    return this.#read(blob, 'text', encoding) as string;
  }

  #read(blob: Blob, kind: FileReaderReadKind, encoding?: string): Exclude<FileReaderResult, null> {
    if (!(blob instanceof Blob) || !_blobBytes.has(blob)) {
      throw new TypeError('FileReaderSync: argument must be a Blob');
    }
    return _readBlobResult(blob, kind, encoding) as Exclude<FileReaderResult, null>;
  }
}

function _setConstructorLength(ctor: Function, length: number): void {
  Object.defineProperty(ctor, 'length', {
    value: length,
    configurable: true,
  });
}

function _setPrototypeToStringTag(proto: object, tag: string): void {
  Object.defineProperty(proto, Symbol.toStringTag, {
    value: tag,
    configurable: true,
  });
}

function _makePrototypeMembersEnumerable(proto: object, names: PropertyKey[]): void {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor === undefined) continue;
    descriptor.enumerable = true;
    Object.defineProperty(proto, name, descriptor);
  }
}

function _setPrototypeMemberLength(proto: object, name: PropertyKey, length: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  if (descriptor === undefined || typeof descriptor.value !== 'function') return;
  Object.defineProperty(descriptor.value, 'length', {
    value: length,
    configurable: true,
  });
}

function _defineReadonlyConstant(target: object, name: string, value: number): void {
  Object.defineProperty(target, name, {
    value,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

_setConstructorLength(Blob, 0);
_setPrototypeToStringTag(Blob.prototype, 'Blob');
_makePrototypeMembersEnumerable(Blob.prototype, [
  'size',
  'type',
  'slice',
  'stream',
  'text',
  'arrayBuffer',
  'textStream',
  'bytes',
]);
_setPrototypeMemberLength(Blob.prototype, 'slice', 0);

_setConstructorLength(File, 2);
_setPrototypeToStringTag(File.prototype, 'File');
_makePrototypeMembersEnumerable(File.prototype, [
  'name',
  'lastModified',
]);

_setConstructorLength(FileReader, 0);
_setPrototypeToStringTag(FileReader.prototype, 'FileReader');
for (const [name, value] of [['EMPTY', 0], ['LOADING', 1], ['DONE', 2]] as const) {
  _defineReadonlyConstant(FileReader, name, value);
  _defineReadonlyConstant(FileReader.prototype, name, value);
}
_makePrototypeMembersEnumerable(FileReader.prototype, [
  'onloadstart',
  'onprogress',
  'onload',
  'onabort',
  'onerror',
  'onloadend',
  'readyState',
  'result',
  'error',
  'readAsArrayBuffer',
  'readAsBinaryString',
  'readAsDataURL',
  'readAsText',
  'abort',
]);
_setPrototypeMemberLength(FileReader.prototype, 'readAsText', 1);

_setConstructorLength(FileReaderSync, 0);
_setPrototypeToStringTag(FileReaderSync.prototype, 'FileReaderSync');
_makePrototypeMembersEnumerable(FileReaderSync.prototype, [
  'readAsArrayBuffer',
  'readAsBinaryString',
  'readAsDataURL',
  'readAsText',
]);
_setPrototypeMemberLength(FileReaderSync.prototype, 'readAsText', 1);

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
