/**
 * Word-granular writer for SPIR-V binaries.
 *
 * SPIR-V is a stream of 32-bit words rather than bytes, so this is the
 * word-oriented counterpart to `internal:format/thrift`'s `ByteWriter`: grow by
 * doubling, hand back an aliasing view, and let the caller copy if it needs to
 * outlive further writes.
 *
 * Words are written in host order. `vkCreateShaderModule` takes a `uint32_t*`
 * and reads it in host order too, so no byte swapping is correct here. The
 * on-disk kernel cache is machine-local, so the endianness never travels.
 *
 * @internal
 *
 * This module is re-exported through `internal:spirv`; import from there.
 */

/**
 * Growable `Uint32Array` with SPIR-V instruction framing.
 */
export class WordWriter {
  /**
   * Backing buffer; written words are `#buf.subarray(0, #len)`.
   *
   * @internal
   */
  #buf: Uint32Array;
  /**
   * Number of words written.
   *
   * @internal
   */
  #len = 0;

  /**
   * Create an empty writer with `initialWords` words of capacity.
   *
   * Capacity is only a hint — the buffer doubles as needed — but a good estimate
   * avoids reallocation. Values below 16 are clamped up to 16.
   */
  constructor(initialWords = 256) {
    this.#buf = new Uint32Array(Math.max(16, initialWords));
  }

  /** Number of words written so far (the logical length, not the capacity). */
  get length(): number {
    return this.#len;
  }

  /**
   * Ensure `n` more words fit, doubling as needed.
   *
   * @internal
   */
  #ensure(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length;
    while (size < this.#len + n) size <<= 1;
    const next = new Uint32Array(size);
    next.set(this.#buf.subarray(0, this.#len), 0);
    this.#buf = next;
  }

  /** Append one word. */
  word(value: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = value >>> 0;
  }

  /** Append several words. */
  words(values: ArrayLike<number>): void {
    const n = values.length;
    this.#ensure(n);
    for (let i = 0; i < n; i++) this.#buf[this.#len + i] = values[i]! >>> 0;
    this.#len += n;
  }

  /**
   * Append one instruction: the packed `(wordCount << 16) | opcode` header
   * followed by `operands`.
   *
   * The word count includes the header itself, which is why it cannot be
   * computed until the operands are known.
   */
  op(opcode: number, operands: ArrayLike<number> = []): void {
    const count = operands.length + 1;
    this.#ensure(count);
    this.#buf[this.#len++] = ((count << 16) | opcode) >>> 0;
    for (let i = 0; i < operands.length; i++) this.#buf[this.#len + i] = operands[i]! >>> 0;
    this.#len += operands.length;
  }

  /** Append every word another writer holds. */
  append(other: WordWriter): void {
    this.words(other.words_());
  }

  /**
   * Aliasing view of the written words.
   *
   * @internal
   */
  words_(): Uint32Array {
    return this.#buf.subarray(0, this.#len);
  }

  /**
   * Copy of the written words, safe to keep after further writes.
   */
  finish(): Uint32Array {
    return this.#buf.slice(0, this.#len);
  }
}

/**
 * Encode a string as SPIR-V literal words: UTF-8 bytes, NUL-terminated, padded
 * with zeros to a word boundary.
 *
 * A string whose length is an exact multiple of 4 still gets a full extra word
 * of padding, because the NUL is mandatory.
 */
export function literalString(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  const wordCount = Math.floor(bytes.length / 4) + 1;
  const out = new Array<number>(wordCount).fill(0);
  for (let i = 0; i < bytes.length; i++) {
    out[i >> 2]! |= bytes[i]! << ((i & 3) * 8);
  }
  return out;
}

/**
 * Decode a NUL-terminated literal string starting at `offset` in `words`.
 *
 * Returns the text and the number of words it occupied.
 */
export function decodeLiteralString(
  words: Uint32Array,
  offset: number,
): { text: string; words: number } {
  const bytes: number[] = [];
  let index = offset;
  for (;;) {
    const word = words[index++]!;
    let done = false;
    for (let shift = 0; shift < 4; shift++) {
      const byte = (word >>> (shift * 8)) & 0xff;
      if (byte === 0) {
        done = true;
        break;
      }
      bytes.push(byte);
    }
    if (done || index >= words.length) break;
  }
  return {
    text: new TextDecoder().decode(new Uint8Array(bytes)),
    words: index - offset,
  };
}

/** Reinterpret an f32 value as the `u32` bit pattern `OpConstant` needs. */
export function f32Bits(value: number): number {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setFloat32(0, value, true);
  return buf.getUint32(0, true);
}

/** Reinterpret an f64 value as the low and high `u32` words of its bit pattern. */
export function f64Bits(value: number): [number, number] {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, value, true);
  return [buf.getUint32(0, true), buf.getUint32(4, true)];
}
