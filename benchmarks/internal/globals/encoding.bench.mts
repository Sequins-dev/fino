
/**
 * Benchmarks for fino:encoding
 *
 * Run with: cargo run -- --bench benchmarks/encoding.bench.mjs
 */

import { encodeUtf8, decodeUtf8, TextEncoder, TextDecoder, btoa, atob, structuredClone } from 'fino:encoding';
import { bench } from 'fino:bench';

const SMALL_ASCII  = 'hello, world!!!';                     // 15 bytes
const KB_ASCII     = 'a'.repeat(1024);
const LARGE_ASCII  = 'a'.repeat(65536);
const MIXED        = 'Hello Ã©Ã¨ä¸–ç•Œí ½í¸€'.repeat(50);

const SMALL_BYTES  = encodeUtf8(SMALL_ASCII);
const KB_BYTES     = encodeUtf8(KB_ASCII);
const LARGE_BYTES  = encodeUtf8(LARGE_ASCII);
const MIXED_BYTES  = encodeUtf8(MIXED);

bench('encodeUtf8 by size', (b) => {
  b.measure('ascii 15 bytes',  () => encodeUtf8(SMALL_ASCII));
  b.measure('ascii 1KB',       () => encodeUtf8(KB_ASCII));
  b.measure('ascii 64KB',      () => encodeUtf8(LARGE_ASCII));
  b.measure('mixed unicode',   () => encodeUtf8(MIXED));
});

bench('decodeUtf8 by size', (b) => {
  b.measure('ascii 15 bytes',  () => decodeUtf8(SMALL_BYTES));
  b.measure('ascii 1KB',       () => decodeUtf8(KB_BYTES));
  b.measure('ascii 64KB',      () => decodeUtf8(LARGE_BYTES));
  b.measure('mixed unicode',   () => decodeUtf8(MIXED_BYTES));
});

bench('TextEncoder vs encodeUtf8', (b) => {
  const enc = new TextEncoder();
  b.group('1KB string', (g) => {
    g.measure('encodeUtf8', () => encodeUtf8(KB_ASCII));
    g.measure('TextEncoder.encode', () => enc.encode(KB_ASCII));
  });

  b.group('TextEncoder.encodeInto', (g) => {
    const dest = new Uint8Array(65536);
    g.measure('encodeInto 1KB',  () => enc.encodeInto(KB_ASCII, dest));
    g.measure('encodeInto 64KB', () => enc.encodeInto(LARGE_ASCII, dest));
  });
});

bench('TextDecoder', (b) => {
  const dec = new TextDecoder();
  b.measure('decode 1KB',    () => dec.decode(KB_BYTES));
  b.measure('decode 64KB',   () => dec.decode(LARGE_BYTES));
  b.measure('decode unicode', () => dec.decode(MIXED_BYTES));
});

bench('base64', (b) => {
  // btoa requires a binary string (latin-1 range only)
  const bin256  = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i % 256));
  const bin1024 = bin256.repeat(4);
  const b64small = btoa(bin256);
  const b64large = btoa(bin1024);

  b.group('btoa', (g) => {
    g.measure('256 bytes',  () => btoa(bin256));
    g.measure('1024 bytes', () => btoa(bin1024));
  });

  b.group('atob', (g) => {
    g.measure('256 bytes',  () => atob(b64small));
    g.measure('1024 bytes', () => atob(b64large));
  });
});

bench('structuredClone', (b) => {
  const primitive    = 42;
  const smallObj     = { a: 1, b: 'hello', c: true };
  const nestedObj    = { a: { b: { c: [1, 2, 3] } } };
  const arr100       = Array.from({ length: 100 }, (_, i) => i);
  const complexObj   = {
    id: 1,
    name: 'test',
    tags: ['a', 'b', 'c'],
    nested: { x: 1, y: [2, 3] },
    active: true,
  };

  b.measure('number',          () => structuredClone(primitive));
  b.measure('small flat obj',  () => structuredClone(smallObj));
  b.measure('nested obj',      () => structuredClone(nestedObj));
  b.measure('array 100',       () => structuredClone(arr100));
  b.measure('complex obj',     () => structuredClone(complexObj));
});
