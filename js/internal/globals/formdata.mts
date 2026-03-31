/**
 * boats:formdata — FormData (WHATWG XHR / Fetch spec)
 *
 * `FormData` is the standard representation of an HTML form submission. It
 * holds an ordered list of name/value entries where values are either strings
 * or `File` objects (Blobs with a filename). It is used as a request body in
 * the Fetch API and as the basis for multipart/form-data serialization.
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
 * matching the browser API.
 *
 *
 * @example
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
 */

import { Blob, File } from 'internal:globals/blob';
import { encodeUtf8 } from 'internal:globals/encoding';

// ---------------------------------------------------------------------------
// Multipart/form-data serialization
// ---------------------------------------------------------------------------

// Escape double-quotes in content-disposition parameter values.
function _escapeQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Serialize a FormData instance to multipart/form-data wire format.
 * Returns the boundary string and the combined body bytes.
 */
export async function _serializeFormData(fd: FormData, boundary?: string): Promise<{ contentType: string; body: Uint8Array }> {
  if (!boundary) boundary = 'boundary' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const parts: Uint8Array[] = [];

  for (const [name, value] of fd) {
    parts.push(encodeUtf8(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      parts.push(encodeUtf8(`Content-Disposition: form-data; name="${_escapeQuotes(name)}"\r\n\r\n`));
      parts.push(encodeUtf8(value));
    } else {
      const type = value.type || 'application/octet-stream';
      parts.push(encodeUtf8(`Content-Disposition: form-data; name="${_escapeQuotes(name)}"; filename="${_escapeQuotes(value.name)}"\r\nContent-Type: ${type}\r\n\r\n`));
      parts.push(new Uint8Array(await value.arrayBuffer()));
    }
    parts.push(encodeUtf8('\r\n'));
  }
  parts.push(encodeUtf8(`--${boundary}--\r\n`));

  // Concatenate all parts
  let totalLen = 0;
  for (let i = 0; i < parts.length; i++) totalLen += parts[i].byteLength;
  const body = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    body.set(parts[i], offset);
    offset += parts[i].byteLength;
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
    value = new File([value], String(filename), { type: value.type });
  } else {
    value = _normalizeCRLF(String(value));
  }
  return [name, value];
}

// ---------------------------------------------------------------------------
// FormData
// ---------------------------------------------------------------------------

export class FormData {
  #entries: [string, FormDataEntryValue][] = [];

  constructor(init?: FormData) {
    if (init instanceof FormData) {
      // Copy constructor — clone entries from the source FormData.
      this.#entries = init.#entries.slice();
    }
  }

  get [Symbol.toStringTag]() { return 'FormData'; }

  append(name: string, value: string | Blob, filename?: string): void {
    this.#entries.push(_normalizeEntry(name, value, filename));
  }

  delete(name: string): void {
    name = String(name);
    const next = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i][0] !== name) next.push(this.#entries[i]);
    }
    this.#entries = next;
  }

  get(name: string): FormDataEntryValue | null {
    name = String(name);
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i][0] === name) return this.#entries[i][1];
    }
    return null;
  }

  getAll(name: string): FormDataEntryValue[] {
    name = String(name);
    const result = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i][0] === name) result.push(this.#entries[i][1]);
    }
    return result;
  }

  has(name: string): boolean {
    name = String(name);
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i][0] === name) return true;
    }
    return false;
  }

  set(name: string, value: string | Blob, filename?: string): void {
    const entry = _normalizeEntry(name, value, filename);
    const n = entry[0];
    let replaced = false;
    const next = [];
    for (let i = 0; i < this.#entries.length; i++) {
      if (this.#entries[i][0] === n) {
        if (!replaced) { next.push(entry); replaced = true; }
      } else {
        next.push(this.#entries[i]);
      }
    }
    if (!replaced) next.push(entry);
    this.#entries = next;
  }

  entries() {
    return this.#entries.slice()[Symbol.iterator]();
  }

  keys() {
    const ks = [];
    for (let i = 0; i < this.#entries.length; i++) ks.push(this.#entries[i][0]);
    return ks[Symbol.iterator]();
  }

  values() {
    const vs = [];
    for (let i = 0; i < this.#entries.length; i++) vs.push(this.#entries[i][1]);
    return vs[Symbol.iterator]();
  }

  forEach(callback: (value: FormDataEntryValue, name: string, parent: FormData) => void, thisArg?: unknown): void {
    const entries = this.#entries.slice();
    for (let i = 0; i < entries.length; i++) {
      callback.call(thisArg, entries[i][1], entries[i][0], this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}
