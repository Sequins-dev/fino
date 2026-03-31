/**
 * Tests for CompressionStream and DecompressionStream globals.
 *
 * Verifies:
 *   - Format support: 'gzip', 'deflate', 'deflate-raw'
 *   - Invalid format rejection
 *   - Roundtrip identity (compress → decompress recovers original data)
 *   - Interop with boats:compression one-shot API
 *   - pipeThrough integration with ReadableStream
 */

import { describe, it } from 'boats:test/test';
import { gzip, gunzip, deflate, inflate } from 'boats:util/compression';
import * as loop from 'boats:runtime/loop';

/** Encode a string to Uint8Array. */
function enc(str) {
  return new TextEncoder().encode(str);
}

/** Decode a Uint8Array to string. */
function dec(u8) {
  return new TextDecoder().decode(u8);
}

/** Collect all chunks from a ReadableStream into a single Uint8Array. */
async function collect(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Pipe data through a compression/decompression stream and collect output. */
async function pipe(stream, data) {
  const writer = stream.writable.getWriter();
  await writer.write(data instanceof Uint8Array ? data : enc(data));
  await writer.close();
  return collect(stream.readable);
}

describe('basic shape', () => {
  it('CompressionStream: has .readable and .writable', (t) => {
    const cs = new CompressionStream('gzip');
    t.ok(cs.readable instanceof ReadableStream, 'readable is ReadableStream');
    t.ok(cs.writable instanceof WritableStream, 'writable is WritableStream');
  });

  it('DecompressionStream: has .readable and .writable', (t) => {
    const ds = new DecompressionStream('gzip');
    t.ok(ds.readable instanceof ReadableStream, 'readable is ReadableStream');
    t.ok(ds.writable instanceof WritableStream, 'writable is WritableStream');
  });

  it('CompressionStream: throws TypeError for unknown format', (t) => {
    t.throws(() => new CompressionStream('brotli'),   /unsupported format/i, 'brotli rejected');
    t.throws(() => new CompressionStream('lz4'),      /unsupported format/i, 'lz4 rejected');
    t.throws(() => new CompressionStream(''),         /unsupported format/i, 'empty rejected');
  });

  it('DecompressionStream: throws TypeError for unknown format', (t) => {
    t.throws(() => new DecompressionStream('brotli'), /unsupported format/i, 'brotli rejected');
    t.throws(() => new DecompressionStream(''),       /unsupported format/i, 'empty rejected');
  });
});

describe('roundtrips', () => {
  it('CompressionStream / DecompressionStream: gzip roundtrip', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('Hello, gzip world! '.repeat(100));

      const compressed   = await pipe(new CompressionStream('gzip'), original);
      const decompressed = await pipe(new DecompressionStream('gzip'), compressed);

      t.equal(decompressed.byteLength, original.byteLength, 'roundtrip length matches');
      t.equal(dec(decompressed), dec(original), 'roundtrip content matches');
      t.ok(compressed.byteLength < original.byteLength, 'compressed is smaller');
    } finally {
      loop.destroy(lp);
    }
  });

  it('CompressionStream / DecompressionStream: deflate roundtrip', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('deflate me! '.repeat(50));
      const compressed   = await pipe(new CompressionStream('deflate'), original);
      const decompressed = await pipe(new DecompressionStream('deflate'), compressed);

      t.equal(dec(decompressed), dec(original), 'deflate roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });

  it('CompressionStream / DecompressionStream: deflate-raw roundtrip', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('raw deflate '.repeat(50));
      const compressed   = await pipe(new CompressionStream('deflate-raw'), original);
      const decompressed = await pipe(new DecompressionStream('deflate-raw'), compressed);

      t.equal(dec(decompressed), dec(original), 'deflate-raw roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('interop', () => {
  it('CompressionStream gzip output is valid gzip (interop with gunzip)', async (t) => {
    const lp = loop.create();
    try {
      const original   = enc('interop test data');
      const compressed = await pipe(new CompressionStream('gzip'), original);

      const decompressed = gunzip(compressed);
      t.equal(dec(decompressed), dec(original), 'gunzip() can decode CompressionStream output');
    } finally {
      loop.destroy(lp);
    }
  });

  it('DecompressionStream gzip decodes one-shot gzip() output', async (t) => {
    const lp = loop.create();
    try {
      const original   = enc('one-shot gzip then streaming decompress');
      const compressed = gzip(original);

      const decompressed = await pipe(new DecompressionStream('gzip'), compressed);
      t.equal(dec(decompressed), dec(original), 'DecompressionStream can decode gzip() output');
    } finally {
      loop.destroy(lp);
    }
  });

  it('pipeThrough CompressionStream then DecompressionStream', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('pipeThrough test '.repeat(30));

      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(original);
          controller.close();
        },
      });

      const result = await collect(
        source
          .pipeThrough(new CompressionStream('gzip'))
          .pipeThrough(new DecompressionStream('gzip'))
      );

      t.equal(dec(result), dec(original), 'pipeThrough roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });

  it('CompressionStream handles multiple write() calls', async (t) => {
    const lp = loop.create();
    try {
      const parts = ['hello ', 'world', ', this ', 'is ', 'multi-chunk'];
      const original = enc(parts.join(''));

      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      for (const part of parts) await writer.write(enc(part));
      await writer.close();

      const compressed   = await collect(cs.readable);
      const decompressed = gunzip(compressed);
      t.equal(dec(decompressed), dec(original), 'multi-chunk compress roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('empty input', () => {
  it('CompressionStream: empty input produces valid compressed output that decompresses to empty', async (t) => {
    const lp = loop.create();
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await writer.close();

      const compressed   = await collect(cs.readable);
      // The compressed output should be valid gzip (non-empty header/footer)
      t.ok(compressed.byteLength > 0, 'compressed output is non-empty');

      // Decompressing should yield empty result
      const decompressed = await pipe(new DecompressionStream('gzip'), compressed);
      t.equal(decompressed.byteLength, 0, 'decompressed is empty');
    } finally {
      loop.destroy(lp);
    }
  });

  it('CompressionStream: deflate-raw empty input roundtrip', async (t) => {
    const lp = loop.create();
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      await writer.close();

      const compressed   = await collect(cs.readable);
      const decompressed = await pipe(new DecompressionStream('deflate-raw'), compressed);
      t.equal(decompressed.byteLength, 0, 'empty deflate-raw roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('ArrayBuffer input', () => {
  it('CompressionStream accepts ArrayBuffer (not Uint8Array) input', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('ArrayBuffer input test');
      // Pass raw ArrayBuffer instead of Uint8Array
      const ab = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength);

      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await writer.write(ab);
      await writer.close();

      const compressed   = await collect(cs.readable);
      const decompressed = gunzip(compressed);
      t.equal(dec(decompressed), dec(original), 'ArrayBuffer input roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('invalid/truncated compressed data', () => {
  it('DecompressionStream: non-gzip data propagates an error on readable', async (t) => {
    const lp = loop.create();
    try {
      // Bytes that are clearly not gzip (no 0x1f 0x8b magic number)
      const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(garbage);
      writer.close();

      let threw = false;
      try {
        await collect(ds.readable);
      } catch (_) {
        threw = true;
      }
      t.ok(threw, 'error propagated for non-gzip data');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('non-buffer data written to writable side', () => {
  it('writing a string to CompressionStream throws TypeError', async (t) => {
    const lp = loop.create();
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await t.rejects(
        () => writer.write('this is a string, not a buffer' as any),
        /BufferSource/,
        'string input throws TypeError',
      );
    } finally {
      loop.destroy(lp);
    }
  });

  it('DataView input is accepted', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('DataView input test');
      const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await writer.write(view as any);
      await writer.close();
      const compressed   = await collect(cs.readable);
      const decompressed = gunzip(compressed);
      t.equal(dec(decompressed), dec(original), 'DataView input roundtrip');
    } finally {
      loop.destroy(lp);
    }
  });

  it('Int32Array input is accepted', async (t) => {
    const lp = loop.create();
    try {
      const original = enc('Int32Array input');
      // Pad to multiple of 4 for Int32Array
      const padded = new Uint8Array(Math.ceil(original.byteLength / 4) * 4);
      padded.set(original);
      const i32 = new Int32Array(padded.buffer);
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await writer.write(i32 as any);
      await writer.close();
      const compressed   = await collect(cs.readable);
      const decompressed = gunzip(compressed);
      t.equal(dec(decompressed.slice(0, original.byteLength)), dec(original), 'Int32Array input accepted');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('truncated compressed data', () => {
  it('DecompressionStream: truncated gzip data — documents current behavior', async (t) => {
    const lp = loop.create();
    try {
      // Create valid gzip data then truncate it
      const original = enc('some data to truncate');
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      await writer.write(original);
      await writer.close();
      const compressed = await collect(cs.readable);
      // Truncate the last 10 bytes (removes end of gzip stream)
      const truncated = compressed.slice(0, Math.max(1, compressed.byteLength - 10));

      const ds = new DecompressionStream('gzip');
      const dsWriter = ds.writable.getWriter();
      dsWriter.write(truncated);
      dsWriter.close();

      let threw = false;
      try {
        await collect(ds.readable);
      } catch (_) {
        threw = true;
      }
      // Document current behavior: does NOT propagate error for truncated data (spec gap)
      t.equal(threw, false, 'truncated gzip does not currently propagate error (spec gap)');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('[Symbol.toStringTag]', () => {
  it('CompressionStream has correct toStringTag', (t) => {
    const cs = new CompressionStream('gzip');
    t.equal(cs[Symbol.toStringTag], 'CompressionStream', 'CompressionStream toStringTag');
  });

  it('DecompressionStream has correct toStringTag', (t) => {
    const ds = new DecompressionStream('gzip');
    t.equal(ds[Symbol.toStringTag], 'DecompressionStream', 'DecompressionStream toStringTag');
  });
});
