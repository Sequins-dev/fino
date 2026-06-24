/**
 * Tests for fino:compress.
 */

import { describe, it } from 'fino:test/test';
import {
  compress,
  decompress,
  createCompressor,
  createDecompressor,
  brotliAvailable,
} from 'fino:compress';
import * as compression from 'fino:compress';

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | Uint8Array): string => new TextDecoder().decode(b);

type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli';

function str(u8: Uint8Array): string { return decodeUtf8(u8); }
function bytes(s: string): Uint8Array { return encodeUtf8(s); }

async function* asAsyncIterable(chunks: Array<Uint8Array | ArrayBuffer>): AsyncGenerator<Uint8Array | ArrayBuffer> {
  for (const chunk of chunks) yield chunk;
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of iter) { parts.push(chunk); total += chunk.byteLength; }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.byteLength; }
  return out;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function supportedFormats(): CompressionFormat[] {
  return brotliAvailable
    ? ['gzip', 'deflate', 'deflate-raw', 'brotli']
    : ['gzip', 'deflate', 'deflate-raw'];
}

const HELLO = bytes('Hello, fino:compress!');
const LONG  = bytes('A'.repeat(100_000));

describe('fino:compress layout', () => {
  it('resolves the new builtin specifier', async (t) => {
    t.equal(typeof compress, 'function', 'compress exported');
    t.equal(typeof createCompressor, 'function', 'createCompressor exported');
  });

  it('does not resolve the old util specifier', async (t) => {
    await t.rejects(() => import('fino:util/compression'), /dynamic import failed|Cannot resolve module|not found|unknown/i, 'legacy specifier removed');
  });
});

describe('one-shot compression', () => {
  for (const format of supportedFormats()) {
    it(`${format} roundtrip`, (t) => {
      const compressed = compress(HELLO, { format });
      t.ok(compressed instanceof Uint8Array, 'compress returns Uint8Array');
      t.ok(compressed.byteLength > 0, 'compressed is not empty');
      const decompressed = decompress(compressed, { format });
      t.equal(str(decompressed), str(HELLO), 'decompress recovers original data');
    });
  }

  it('gzip with custom level', (t) => {
    const c1 = compress(LONG, { format: 'gzip', level: 1 });
    const c9 = compress(LONG, { format: 'gzip', level: 9 });
    t.equal(decompress(c1, { format: 'gzip' }).byteLength, LONG.byteLength, 'level 1 decompresses correctly');
    t.equal(decompress(c9, { format: 'gzip' }).byteLength, LONG.byteLength, 'level 9 decompresses correctly');
  });

  it('gzip produces valid gzip header', (t) => {
    const compressed = compress(HELLO, { format: 'gzip' });
    t.equal(compressed[0], 0x1f, 'first byte is 0x1f');
    t.equal(compressed[1], 0x8b, 'second byte is 0x8b');
  });

  it('gzip produces a valid member frame', (t) => {
    const input = bytes('gzip framing '.repeat(25));
    const compressed = compress(input, { format: 'gzip' });
    t.ok(compressed.byteLength >= 18, 'gzip member includes header and trailer');
    t.equal(compressed[0], 0x1f, 'first magic byte is 0x1f');
    t.equal(compressed[1], 0x8b, 'second magic byte is 0x8b');
    t.equal(compressed[2], 8, 'compression method is DEFLATE');
    t.equal((compressed[3]! & 0xe0), 0, 'reserved flag bits are clear');
    t.equal(readU32LE(compressed, compressed.byteLength - 4), input.byteLength, 'ISIZE matches original input length');
  });

  it('rejects corrupt compressed data', (t) => {
    t.throws(() => decompress(new Uint8Array([0, 1, 2, 3]), { format: 'gzip' }), /inflate error/, 'throws on corrupt gzip');
    t.throws(() => decompress(new Uint8Array([0, 1, 2, 3]), { format: 'deflate' }), /inflate error/, 'throws on corrupt deflate');
  });

  it('rejects trailing junk after zlib-wrapped compressed data', (t) => {
    for (const format of ['gzip', 'deflate'] as const) {
      const compressed = compress(HELLO, { format });
      const extended = new Uint8Array(compressed.byteLength + 1);
      extended.set(compressed);
      t.throws(() => decompress(extended, { format }), /trailing/i, `${format} rejects trailing input`);
    }
  });

  it('rejects trailing junk after brotli compressed data', (t) => {
    if (!brotliAvailable) {
      t.ok(true, 'brotli not available');
      return;
    }

    const compressed = compress(HELLO, { format: 'brotli' });
    const extended = new Uint8Array(compressed.byteLength + 1);
    extended.set(compressed);
    t.throws(() => decompress(extended, { format: 'brotli' }), /trailing/i, 'brotli rejects trailing input');
  });

  it('validates format', (t) => {
    t.throws(() => compress(HELLO, { format: 'zip' as CompressionFormat }), /unsupported compression format/i, 'compress rejects invalid format');
    t.throws(() => decompress(HELLO, { format: 'zip' as CompressionFormat }), /unsupported compression format/i, 'decompress rejects invalid format');
  });

  it('reports brotli availability consistently', (t) => {
    if (brotliAvailable) {
      const compressed = compress(HELLO, { format: 'brotli' });
      t.equal(str(decompress(compressed, { format: 'brotli' })), str(HELLO), 'brotli works when available');
    } else {
      t.throws(() => compress(HELLO, { format: 'brotli' }), /brotli library not available/, 'brotli compress throws when unavailable');
      t.throws(() => decompress(HELLO, { format: 'brotli' }), /brotli library not available/, 'brotli decompress throws when unavailable');
    }
  });
});

describe('iterative compression', () => {
  for (const format of supportedFormats()) {
    it(`${format} write/finish roundtrip`, (t) => {
      const chunks = [bytes('chunk one '), bytes('chunk two '), bytes('chunk three')];
      const compressor = createCompressor({ format });
      const compressed = concat([
        ...compressor.write(chunks[0]!),
        ...compressor.write(chunks[1]!),
        ...compressor.write(chunks[2]!),
        ...compressor.finish(),
      ]);

      const decompressor = createDecompressor({ format });
      const restored = concat([
        ...decompressor.write(compressed.slice(0, Math.floor(compressed.byteLength / 2))),
        ...decompressor.write(compressed.slice(Math.floor(compressed.byteLength / 2))),
        ...decompressor.finish(),
      ]);

      t.equal(str(restored), 'chunk one chunk two chunk three', 'multi-chunk roundtrip');
    });
  }

  it('close prevents further writes', (t) => {
    const compressor = createCompressor({ format: 'gzip' });
    compressor.close();
    t.throws(() => compressor.write(HELLO), /closed/i, 'write after close rejected');
    t.throws(() => compressor.finish(), /closed/i, 'finish after close rejected');
  });

  for (const format of supportedFormats()) {
    it(`${format} rejects truncated input on finish`, (t) => {
      const compressed = compress(bytes(`truncated ${format} payload `.repeat(20)), { format });
      const truncated = compressed.slice(0, compressed.byteLength - 1);
      const decompressor = createDecompressor({ format });
      decompressor.write(truncated);
      t.throws(
        () => decompressor.finish(),
        /unexpected end|truncated|incomplete/i,
        'finish rejects incomplete compressed streams',
      );
    });
  }

  it('zlib streaming decompression rejects trailing junk', (t) => {
    for (const format of ['gzip', 'deflate'] as const) {
      const compressed = compress(HELLO, { format });
      const extended = new Uint8Array(compressed.byteLength + 1);
      extended.set(compressed);
      const decompressor = createDecompressor({ format });
      decompressor.write(extended);
      t.throws(() => decompressor.finish(), /trailing/i, `${format} streaming rejects trailing input`);
    }
  });

  it('brotli streaming decompression rejects trailing junk', (t) => {
    if (!brotliAvailable) {
      t.ok(true, 'brotli not available');
      return;
    }

    const compressed = compress(HELLO, { format: 'brotli' });
    const extended = new Uint8Array(compressed.byteLength + 1);
    extended.set(compressed);
    const decompressor = createDecompressor({ format: 'brotli' });
    decompressor.write(extended);
    t.throws(() => decompressor.finish(), /trailing/i, 'brotli streaming rejects trailing input');
  });
});

describe('async iterable transforms', () => {
  for (const format of supportedFormats()) {
    it(`${format} transform roundtrip`, async (t) => {
      const compressed = await collect(createCompressor({ format }).transform(asAsyncIterable([
        bytes('Hello, '),
        bytes('streaming '),
        bytes('world!').buffer,
      ])));
      const restored = await collect(createDecompressor({ format }).transform(asAsyncIterable([compressed])));
      t.equal(str(restored), 'Hello, streaming world!', 'transform recovers original data');
    });
  }

  it('empty input produces valid gzip output', (t) => {
    const compressed = compress(new Uint8Array(0), { format: 'gzip' });
    const decompressed = decompress(compressed, { format: 'gzip' });
    t.equal(decompressed.byteLength, 0, 'empty gzip roundtrip');
  });
});

describe('fino:compress release contract', () => {
  it('exposes a compact format/options surface without advanced zlib helpers', (t) => {
    for (const name of ['createGzip', 'createGunzip', 'constants', 'flush', 'dictionary', 'setOutputLimit']) {
      t.equal(Object.prototype.hasOwnProperty.call(compression, name), false, `${name} is not exported`);
    }
  });

  it('requires explicit formats and binary input', (t) => {
    t.throws(() => compress(HELLO, {} as any), /unsupported compression format/i, 'compress requires format');
    t.throws(() => decompress(HELLO, {} as any), /unsupported compression format/i, 'decompress requires format');
    t.throws(() => compress('hello' as any, { format: 'gzip' }), /binary input/i, 'compress rejects strings');
    t.throws(() => decompress('hello' as any, { format: 'gzip' }), /binary input/i, 'decompress rejects strings');

    const compressor = createCompressor({ format: 'gzip' });
    t.throws(() => compressor.write('hello' as any), /binary input/i, 'stream compressor rejects strings');
    compressor.close();
  });

  it('keeps one-shot decompression unconstrained by a public output cap option', (t) => {
    const input = bytes('expanded '.repeat(50_000));
    const packed = compress(input, { format: 'gzip' });
    const restored = decompress(packed, { format: 'gzip' });
    t.equal(restored.byteLength, input.byteLength, 'full output is returned');
    t.equal(str(restored), str(input), 'expanded payload roundtrips');
  });
});
