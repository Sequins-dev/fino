/**
 * FormData global (WHATWG XHR / Fetch spec).
 *
 * Learn more:
 * - XMLHttpRequest FormData: https://xhr.spec.whatwg.org/#interface-formdata
 * - Fetch body handling: https://fetch.spec.whatwg.org/
 *
 * `FormData` is the standard representation of an HTML form submission. It
 * holds an ordered list of name/value entries where values are either strings
 * or `File` objects (Blobs with a filename). It is used as a request body in
 * the Fetch API and as the basis for multipart/form-data serialization.
 * This release supports outgoing `multipart/form-data` serialization only;
 * parsing incoming multipart request bodies into FormData is intentionally
 * outside the release scope.
 *
 * Fino also supports `new FormData(existingFormData)` as a nonstandard
 * convenience extension for shallow-copying entries. Browser constructors
 * accept an HTML form element instead.
 *
 *
 * ## Entry normalization (_normalizeEntry)
 *
 * The WHATWG spec requires that values be normalized on insertion:
 *
 * - **String values** are coerced via `String(value)`. Simple.
 * - **Blob values** are wrapped in a `File` object. If the caller provides a
 *   `filename` argument it is used; otherwise the filename defaults to `"blob"`
 *   (per spec), unless the value is already a `File`, in which case its
 *   `file.name` is used as the default. This ensures that every Blob entry
 *   in the FormData has a filename, which is required for multipart encoding.
 *
 * The wrapping-in-File step is non-obvious: even if the value is already a
 * `File`, it gets re-wrapped into a new `File` if a `filename` argument is
 * explicitly provided. This matches the spec and allows callers to override
 * the filename at append time.
 *
 *
 * ## Entry ordering and duplicates
 *
 * FormData is an ordered list, not a map. Multiple entries can share the same
 * name. `get()` returns only the first match; `getAll()` returns all matches.
 * `set()` replaces the first match and removes all subsequent ones, preserving
 * the position of the first occurrence. `delete()` removes all entries with
 * the given name.
 *
 *
 * ## Iteration
 *
 * The `[Symbol.iterator]()` method delegates to `entries()`, so FormData
 * instances can be iterated with `for...of` to get `[key, value]` pairs,
 * matching the browser API. Iterators are live and read from the current entry
 * list as they advance, so entries appended before completion can be observed
 * and entries deleted before their turn are skipped.
 *
 *
 * ```ts no_run
 * // FormData is available via globalThis
 *
 * const fd = new FormData();
 * fd.append('name', 'Alice');
 * fd.append('avatar', blob, 'avatar.png');
 *
 * fd.get('name');     // 'Alice'
 * fd.getAll('name');  // ['Alice']
 * fd.has('name');     // true
 * fd.set('name', 'Bob');
 * fd.delete('name');
 *
 * for (const [key, value] of fd) { ... }
 * fd.forEach((value, key, fd) => { ... });
 * ```
 *
 */

import { Blob, File } from './blob.mts';
import { encodeUtf8 } from './encoding.mts';
import { randBytes } from '../internal/openssl.mts';

// ---------------------------------------------------------------------------
// Multipart/form-data serialization
// ---------------------------------------------------------------------------

export function _createMultipartBoundary(): string {
  const bytes = new ArrayBuffer(18);
  randBytes(bytes, 18);
  return '----fino-formdata-' + _base64urlEncodeBytes(new Uint8Array(bytes));
}

function _base64urlEncodeBytes(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += chars[a >> 2]!;
    out += chars[((a & 0x03) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += chars[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += chars[c & 0x3f]!;
  }
  return out;
}

// Escape content-disposition parameter values so names cannot inject headers.
function _escapeParameter(s: string): string {
  return encodeURIComponent(s.replace(/\r\n|\r|\n/g, '\r\n'));
}

/**
 * Serialize a FormData instance to multipart/form-data wire format.
 *
 * Returns a content type with the chosen boundary and the combined body bytes.
 * The boundary is generated when omitted. File parts default to
 * application/octet-stream when their Blob type is empty. Callers should not
 * reuse untrusted boundary strings without validating that they cannot collide
 * with body content.
 *
 * Serialization builds a complete `Uint8Array` before returning. This keeps
 * fetch integration simple, but callers should avoid unbounded or very large
 * bodies until streaming multipart serialization is added.
 *
 * ```typescript no_run
 * const fd = new FormData();
 * fd.append('name', 'Alice');
 * const { contentType, body } = await _serializeFormData(fd, 'fixed');
 * contentType; // "multipart/form-data; boundary=fixed"
 * body.byteLength; // multipart payload size
 * ```
 *
 * @internal
 */
export async function _serializeFormData(fd: FormData, boundary?: string): Promise<{ contentType: string; body: Uint8Array }> {
  if (!boundary) boundary = _createMultipartBoundary();
  const parts: Uint8Array[] = [];
  let hasEntries = false;

  for (const [name, value] of fd) {
    hasEntries = true;
    parts.push(encodeUtf8(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      parts.push(encodeUtf8(`Content-Disposition: form-data; name="${_escapeParameter(name)}"\r\n\r\n`));
      parts.push(encodeUtf8(value));
    } else {
      const type = value.type || 'application/octet-stream';
      parts.push(encodeUtf8(`Content-Disposition: form-data; name="${_escapeParameter(name)}"; filename="${_escapeParameter(value.name)}"\r\nContent-Type: ${type}\r\n\r\n`));
      parts.push(new Uint8Array(await value.arrayBuffer()));
    }
    parts.push(encodeUtf8('\r\n'));
  }
  if (!hasEntries) {
    return { contentType: `multipart/form-data; boundary=${boundary}`, body: new Uint8Array(0) };
  }
  parts.push(encodeUtf8(`--${boundary}--\r\n`));

  // Concatenate all parts
  let totalLen = 0;
  for (let i = 0; i < parts.length; i++) totalLen += parts[i]!.byteLength;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    body.set(parts[i]!, offset);
    offset += parts[i]!.byteLength;
  }

  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type FormDataEntryValue = string | File;

// WHATWG spec: string values in FormData have line endings normalized to CRLF.
function _normalizeCRLF(s: string): string {
  return s.replace(/\r\n|\r|\n/g, '\r\n');
}

function _normalizeEntry(name: string, value: string | Blob, filename?: string): [string, FormDataEntryValue] {
  name = _normalizeCRLF(String(name));
  if (value instanceof Blob) {
    if (filename === undefined) {
      filename = value instanceof File ? value.name : 'blob';
    }
    return [name, new File([value], String(filename), { type: value.type })];
  } else {
    value = _normalizeCRLF(String(value));
  }
  return [name, value];
}

// ---------------------------------------------------------------------------
// FormData
// ---------------------------------------------------------------------------

/**
 * Ordered collection of string and File form entries.
 *
 * Duplicate names are allowed and insertion order is preserved. Blob values
 * are normalized into File entries so multipart serialization always has a
 * filename.
 *
 * ```typescript no_run
 * const form = new FormData();
 * form.append('name', 'Alice');
 * form.get('name'); // "Alice"
 * ```
 */
export class FormData {
  /**
   * Private property `#entries` used by `FormData`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #entries = undefined;
   *
   *   readInternalState() {
   *     return this.#entries;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #entries: [string, FormDataEntryValue][] = [];

  /**
   * Create an empty FormData or shallow-copy an existing FormData.
   *
   * The copy-constructor form is a nonstandard Fino extension. It preserves
   * entry order and does not deep-clone File objects.
   *
   * ```typescript no_run
   * const source = new FormData();
   * source.append('x', '1');
   * const copy = new FormData(source);
   * ```
   */
  constructor(init?: FormData) {
    if (init instanceof FormData) {
      // Copy constructor — clone entries from the source FormData.
      this.#entries = init.#entries.slice();
    }
  }

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new FormData()); // "[object FormData]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'FormData'; }

  /**
   * Append a new entry without removing existing entries with the same name.
   *
   * Names and string values are string-coerced and line endings are normalized
   * to CRLF. Blob values become File values, using filename or "blob".
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('tag', 'a');
   * form.append('tag', 'b');
   * form.getAll('tag'); // ["a", "b"]
   * ```
   */
  append(name: string, value: string | Blob, filename?: string): void {
    this.#entries.push(_normalizeEntry(name, value, filename));
  }

  /**
   * Remove every entry with the given name.
   *
   * Unknown names are ignored. The name is string-coerced before matching.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.delete('x');
   * form.has('x'); // false
   * ```
   */
  delete(name: string): void {
    name = String(name);
    const next: [string, FormDataEntryValue][] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i]![0] !== name) next.push(this.#entries[i]!);
    }
    this.#entries = next;
  }

  /**
   * Return the first value for a name, or null when absent.
   *
   * File entries are returned as File instances. Duplicate entries after the
   * first are ignored by this method.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.get('x'); // "1"
   * ```
   */
  get(name: string): FormDataEntryValue | null {
    name = String(name);
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i]![0] === name) return this.#entries[i]![1];
    }
    return null;
  }

  /**
   * Return all values for a name in insertion order.
   *
   * The returned array is new, so mutating it does not affect the FormData.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.append('x', '2');
   * form.getAll('x'); // ["1", "2"]
   * ```
   */
  getAll(name: string): FormDataEntryValue[] {
    name = String(name);
    const result: FormDataEntryValue[] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i]![0] === name) result.push(this.#entries[i]![1]);
    }
    return result;
  }

  /**
   * Return true when at least one entry exists for name.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.has('x'); // true
   * ```
   */
  has(name: string): boolean {
    name = String(name);
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i]![0] === name) return true;
    }
    return false;
  }

  /**
   * Replace entries for a name with a single normalized entry.
   *
   * The first matching position is preserved and later duplicates are removed.
   * If the name did not exist, the new entry is appended.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.set('x', '2');
   * form.getAll('x'); // ["2"]
   * ```
   */
  set(name: string, value: string | Blob, filename?: string): void {
    const entry = _normalizeEntry(name, value, filename);
    const n = entry[0];
    let replaced = false;
    const next: [string, FormDataEntryValue][] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i]![0] === n) {
        if (!replaced) { next.push(entry); replaced = true; }
      } else {
        next.push(this.#entries[i]!);
      }
    }
    if (!replaced) next.push(entry);
    this.#entries = next;
  }

  /**
   * Iterate over [name, value] pairs in insertion order.
   *
   * The iterator is live and reads the current entry list as it advances.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * [...form.entries()]; // [["x", "1"]]
   * ```
   */
  *entries(): IterableIterator<[string, FormDataEntryValue]> {
    for (let i = 0; i < this.#entries.length; i++) {
      const entry = this.#entries[i]!;
      yield [entry[0], entry[1]];
    }
  }

  /**
   * Iterate over entry names in insertion order.
   *
   * Duplicate names appear once for each entry.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * [...form.keys()]; // ["x"]
   * ```
   */
  *keys(): IterableIterator<string> {
    for (let i = 0; i < this.#entries.length; i++) {
      yield this.#entries[i]![0];
    }
  }

  /**
   * Iterate over values in insertion order.
   *
   * Values are strings or File objects.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * [...form.values()]; // ["1"]
   * ```
   */
  *values(): IterableIterator<FormDataEntryValue> {
    for (let i = 0; i < this.#entries.length; i++) {
      yield this.#entries[i]![1];
    }
  }

  /**
   * Call a callback for each entry in insertion order.
   *
   * The callback receives value, name, and the FormData object. thisArg is used
   * as the callback receiver when provided.
   *
   * ```typescript no_run
   * const form = new FormData();
   * form.append('x', '1');
   * form.forEach((value, name) => console.log(name, value));
   * ```
   */
  forEach(callback: (value: FormDataEntryValue, name: string, parent: FormData) => void, thisArg?: unknown): void {
    for (let i = 0; i < this.#entries.length; i++) {
      const entry = this.#entries[i]!;
      callback.call(thisArg, entry[1], entry[0], this);
    }
  }

  /**
   * Default iterator over [name, value] entries.
   *
   * This is equivalent to entries().
   *
   * ```typescript no_run
   * const form = new FormData();
   * for (const [name, value] of form) console.log(name, value);
   * ```
   */
  [Symbol.iterator]() {
    return this.entries();
  }
}
