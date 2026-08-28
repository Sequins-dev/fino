/**
 * Benchmarks for Encoding globals
 *
 * Run with: cargo run -- --bench benchmarks/encoding.bench.mjs
 */
import { bench } from 'fino:bench';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SMALL_ASCII = 'hello, world!!!';
const KB_ASCII = 'a'.repeat(1024);
const LARGE_ASCII = 'a'.repeat(65536);
const MIXED = 'Hello e-world'.repeat(50);
const SMALL_BYTES = encoder.encode(SMALL_ASCII);
const KB_BYTES = encoder.encode(KB_ASCII);
const LARGE_BYTES = encoder.encode(LARGE_ASCII);
const MIXED_BYTES = encoder.encode(MIXED);
bench('TextEncoder.encode by size', (b) => {
  b.measure('ascii 15 bytes', () => encoder.encode(SMALL_ASCII));
  b.measure('ascii 1KB', () => encoder.encode(KB_ASCII));
  b.measure('ascii 64KB', () => encoder.encode(LARGE_ASCII));
  b.measure('mixed unicode', () => encoder.encode(MIXED));
});
bench('TextDecoder.decode by size', (b) => {
  b.measure('ascii 15 bytes', () => decoder.decode(SMALL_BYTES));
  b.measure('ascii 1KB', () => decoder.decode(KB_BYTES));
  b.measure('ascii 64KB', () => decoder.decode(LARGE_BYTES));
  b.measure('mixed unicode', () => decoder.decode(MIXED_BYTES));
});
bench('TextEncoder', (b) => {
  const enc = new TextEncoder();
  b.group('1KB string', (g) => {
    g.measure('TextEncoder.encode', () => enc.encode(KB_ASCII));
  });
  b.group('TextEncoder.encodeInto', (g) => {
    const dest = new Uint8Array(65536);
    g.measure('encodeInto 1KB', () => enc.encodeInto(KB_ASCII, dest));
    g.measure('encodeInto 64KB', () => enc.encodeInto(LARGE_ASCII, dest));
  });
});
bench('TextDecoder', (b) => {
  const dec = new TextDecoder();
  b.measure('decode 1KB', () => dec.decode(KB_BYTES));
  b.measure('decode 64KB', () => dec.decode(LARGE_BYTES));
  b.measure('decode unicode', () => dec.decode(MIXED_BYTES));
});
bench('base64', (b) => {
  // btoa requires a binary string (latin-1 range only)
  const bin256 = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i % 256));
  const bin1024 = bin256.repeat(4);
  const b64small = btoa(bin256);
  const b64large = btoa(bin1024);
  b.group('btoa', (g) => {
    g.measure('256 bytes', () => btoa(bin256));
    g.measure('1024 bytes', () => btoa(bin1024));
  });
  b.group('atob', (g) => {
    g.measure('256 bytes', () => atob(b64small));
    g.measure('1024 bytes', () => atob(b64large));
  });
});
bench('structuredClone', (b) => {
  const primitive = 42;
  const smallObj = {
    a: 1,
    b: 'hello',
    c: true,
  };
  const nestedObj = { a: { b: { c: [1, 2, 3] } } };
  const arr100 = Array.from({ length: 100 }, (_, i) => i);
  const complexObj = {
    id: 1,
    name: 'test',
    tags: ['a', 'b', 'c'],
    nested: {
      x: 1,
      y: [2, 3],
    },
    active: true,
  };
  b.measure('number', () => structuredClone(primitive));
  b.measure('small flat obj', () => structuredClone(smallObj));
  b.measure('nested obj', () => structuredClone(nestedObj));
  b.measure('array 100', () => structuredClone(arr100));
  b.measure('complex obj', () => structuredClone(complexObj));
});
bench('structuredClone session records', (b) => {
  const sessionRecord = {
    id: 'f3912457-c02d-4337-99d8-3c749d5ac940',
    data: {
      user: 'ada',
      roles: ['admin', 'editor'],
      preferences: {
        locale: 'en-GB',
        theme: 'dark',
      },
    },
    createdAt: 1_725_000_000_000,
    updatedAt: 1_725_000_001_000,
    expiresAt: 1_725_003_600_000,
  };
  b.measure('structuredClone session record', () => structuredClone(sessionRecord));
});
