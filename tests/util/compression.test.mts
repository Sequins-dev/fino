/**
 * Tests for boats:compression — gzip, deflate, brotli one-shot and streaming.
 */

import { describe, it } from 'boats:test/test';
import {
  gzip, gunzip,
  deflate, inflate,
  deflateRaw, inflateRaw,
  brotliCompress, brotliDecompress,
  brotliAvailable,
  createGzip, createGunzip,
  createDeflate, createInflate,
  createDeflateRaw, createInflateRaw,
  createBrotliCompress, createBrotliDecompress,
} from 'boats:util/compression';
const encodeUtf8 = s => new TextEncoder().encode(s);
const decodeUtf8 = b => new TextDecoder().decode(b);

function str(u8) { return decodeUtf8(u8); }
function bytes(s) { return encodeUtf8(s); }

async function collect(iter) {
  const parts = [];
  let total = 0;
  for await (const chunk of iter) { parts.push(chunk); total += chunk.byteLength; }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

const HELLO = bytes('Hello, boats:compression!');
const LONG  = bytes('A'.repeat(100_000));

describe('One-shot gzip / gunzip', () => {
  it('roundtrip', (t) => {
    const compressed = gzip(HELLO);
    t.ok(compressed instanceof Uint8Array, 'gzip returns Uint8Array');
    t.ok(compressed.byteLength > 0, 'compressed is not empty');
    const decompressed = gunzip(compressed);
    t.equal(str(decompressed), str(HELLO), 'gunzip recovers original data');
  });

  it('gzip with custom level', (t) => {
    const c0 = gzip(LONG, { level: 1 });
    const c9 = gzip(LONG, { level: 9 });
    t.equal(gunzip(c0).byteLength, LONG.byteLength, 'level 1 decompresses correctly');
    t.equal(gunzip(c9).byteLength, LONG.byteLength, 'level 9 decompresses correctly');
  });

  it('gzip produces valid gzip header (magic bytes 1f 8b)', (t) => {
    const c = gzip(HELLO);
    t.equal(c[0], 0x1f, 'first byte is 0x1f');
    t.equal(c[1], 0x8b, 'second byte is 0x8b');
  });

  it('gunzip rejects corrupt data', (t) => {
    t.throws(() => gunzip(new Uint8Array([0, 1, 2, 3])), /inflate error/, 'throws on corrupt data');
  });
});

describe('One-shot deflate / inflate / deflateRaw', () => {
  it('deflate/inflate roundtrip', (t) => {
    const c = deflate(HELLO);
    const d = inflate(c);
    t.equal(str(d), str(HELLO), 'inflate recovers original data');
  });

  it('inflate rejects corrupt data', (t) => {
    t.throws(() => inflate(new Uint8Array([0, 1, 2, 3])), /inflate error/, 'throws on corrupt data');
  });

  it('deflateRaw/inflateRaw roundtrip', (t) => {
    const c = deflateRaw(HELLO);
    const d = inflateRaw(c);
    t.equal(str(d), str(HELLO), 'inflateRaw recovers original data');
  });
});

describe('One-shot brotli', () => {
  const skipBrotli = !brotliAvailable && 'brotli not available';

  it('brotliCompress/brotliDecompress roundtrip', { skip: skipBrotli }, (t) => {
    const c = brotliCompress(HELLO);
    t.ok(c instanceof Uint8Array, 'returns Uint8Array');
    t.ok(c.byteLength > 0, 'not empty');
    t.equal(str(brotliDecompress(c)), str(HELLO), 'decompresses correctly');
  });

  it('brotliCompress with custom level', { skip: skipBrotli }, (t) => {
    const c = brotliCompress(LONG, { level: 1 });
    t.equal(brotliDecompress(c).byteLength, LONG.byteLength, 'level 1 decompresses correctly');
  });

  it('brotliDecompress rejects corrupt data', { skip: skipBrotli }, (t) => {
    t.throws(() => brotliDecompress(new Uint8Array([0, 1, 2, 3])), /brotliDecompress failed/, 'throws on corrupt data');
  });
});

describe('Streaming', () => {
  it('createGzip/createGunzip roundtrip (single chunk)', async (t) => {
    const gzipped = await collect(createGzip().transform([HELLO]));
    t.ok(gzipped.byteLength > 0, 'gzip produced output');
    const restored = await collect(createGunzip().transform([gzipped]));
    t.equal(str(restored), str(HELLO), 'gunzip recovers original');
  });

  it('createGzip/createGunzip roundtrip (multiple chunks)', async (t) => {
    const chunks = [bytes('Hello, '), bytes('streaming '), bytes('world!')];
    const gzipped = await collect(createGzip().transform(chunks));
    const restored = await collect(createGunzip().transform([gzipped]));
    t.equal(str(restored), 'Hello, streaming world!', 'multi-chunk roundtrip');
  });

  it('createGzip compresses large data', async (t) => {
    const gzipped = await collect(createGzip().transform([LONG]));
    t.ok(gzipped.byteLength < LONG.byteLength, 'gzip reduces size');
    const restored = await collect(createGunzip().transform([gzipped]));
    t.equal(restored.byteLength, LONG.byteLength, 'decompressed size matches');
    t.equal(restored[0], LONG[0], 'first byte matches');
  });

  it('createGzip output has valid gzip magic', async (t) => {
    const gzipped = await collect(createGzip().transform([HELLO]));
    t.equal(gzipped[0], 0x1f, 'gzip magic byte 0');
    t.equal(gzipped[1], 0x8b, 'gzip magic byte 1');
  });

  it('createDeflate/createInflate roundtrip', async (t) => {
    const compressed = await collect(createDeflate().transform([HELLO]));
    const restored   = await collect(createInflate().transform([compressed]));
    t.equal(str(restored), str(HELLO), 'deflate/inflate streaming roundtrip');
  });

  it('createDeflateRaw/createInflateRaw roundtrip', async (t) => {
    const compressed = await collect(createDeflateRaw().transform([HELLO]));
    const restored   = await collect(createInflateRaw().transform([compressed]));
    t.equal(str(restored), str(HELLO), 'deflateRaw/inflateRaw streaming roundtrip');
  });

  it('createBrotliCompress/createBrotliDecompress roundtrip', { skip: !brotliAvailable && 'brotli not available' }, async (t) => {
    const compressed = await collect(createBrotliCompress().transform([HELLO]));
    t.ok(compressed.byteLength > 0, 'brotli produced output');
    const restored = await collect(createBrotliDecompress().transform([compressed]));
    t.equal(str(restored), str(HELLO), 'brotli streaming roundtrip');
  });

  it('createBrotliCompress/createBrotliDecompress multiple chunks', { skip: !brotliAvailable && 'brotli not available' }, async (t) => {
    const chunks = [bytes('chunk one '), bytes('chunk two '), bytes('chunk three')];
    const compressed = await collect(createBrotliCompress().transform(chunks));
    const restored   = await collect(createBrotliDecompress().transform([compressed]));
    t.equal(str(restored), 'chunk one chunk two chunk three', 'multi-chunk brotli roundtrip');
  });
});

describe('Cross-format', () => {
  it('gzip and streaming createGzip produce compatible output', async (t) => {
    const oneShot   = gzip(HELLO);
    const streaming = await collect(createGzip().transform([HELLO]));
    t.equal(str(gunzip(oneShot)),   str(HELLO), 'one-shot decompresses');
    t.equal(str(gunzip(streaming)), str(HELLO), 'streaming decompresses');
  });

  it('empty input produces valid compressed output', (t) => {
    const empty = new Uint8Array(0);
    const c = gzip(empty);
    const d = gunzip(c);
    t.equal(d.byteLength, 0, 'empty gzip roundtrip');
  });
});
