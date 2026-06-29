/**
* Benchmarks for Blob and File globals
*
* Run with: cargo run -- --bench benchmarks/blob.bench.mjs
*/
import { bench } from 'fino:bench';
const KB_STR = 'x'.repeat(1024);
const LARGE_STR = 'x'.repeat(65536);
const KB_BUF = new Uint8Array(1024);
const LARGE_BUF = new Uint8Array(65536);
bench('Blob construction', (b) => {
  b.measure('empty', () => new Blob([]));
  b.measure('small string', () => new Blob(['hello, world']));
  b.measure('1KB string', () => new Blob([KB_STR]));
  b.measure('64KB string', () => new Blob([LARGE_STR]));
  b.measure('from Uint8Array 1KB', () => new Blob([KB_BUF]));
  b.measure('from Uint8Array 64KB', () => new Blob([LARGE_BUF]));
  b.measure('multiple string parts', () => new Blob([
    'hello',
    ' ',
    'world',
    '!'
  ]));
  b.measure('nested Blob', {
    setup: () => new Blob(['inner']),
    fn: (inner) => new Blob([inner, ' outer'])
  });
  b.measure('with type', () => new Blob(['{"ok":true}'], { type: 'application/json' }));
});
bench('Blob.slice', (b) => {
  const blob4KB = new Blob([new Uint8Array(4096)]);
  const blob64KB = new Blob([new Uint8Array(65536)]);
  b.measure('slice 1KB from 4KB', () => blob4KB.slice(0, 1024));
  b.measure('slice 32KB from 64KB', () => blob64KB.slice(1024, 33792));
  b.measure('slice no args', () => blob4KB.slice());
  b.measure('slice with type', () => blob4KB.slice(0, 1024, 'text/plain'));
});
bench('Blob body reading', (b) => {
  b.measure('text() 16 bytes', {
    setup: () => new Blob(['hello, world!!!!!']),
    fn: async (blob) => await blob.text()
  });
  b.measure('text() 1KB', {
    setup: () => new Blob([KB_STR]),
    fn: async (blob) => await blob.text()
  });
  b.measure('text() 64KB', {
    setup: () => new Blob([LARGE_STR]),
    fn: async (blob) => await blob.text()
  });
  b.measure('arrayBuffer() 1KB', {
    setup: () => new Blob([KB_BUF]),
    fn: async (blob) => await blob.arrayBuffer()
  });
  b.measure('arrayBuffer() 64KB', {
    setup: () => new Blob([LARGE_BUF]),
    fn: async (blob) => await blob.arrayBuffer()
  });
  b.measure('bytes() 1KB', {
    setup: () => new Blob([KB_BUF]),
    fn: async (blob) => await blob.bytes()
  });
});
bench('Blob properties', (b) => {
  const blob = new Blob([KB_STR], { type: 'text/plain' });
  b.measure('size', () => blob.size);
  b.measure('type', () => blob.type);
});
bench('File construction', (b) => {
  b.measure('empty File', () => new File([], 'empty.txt'));
  b.measure('File with string', () => new File(['content'], 'data.txt', { type: 'text/plain' }));
  b.measure('File with lastModified', () => new File(['data'], 'file.bin', { lastModified: Date.now() }));
  b.measure('File properties', {
    setup: () => new File(['data'], 'file.txt', { type: 'text/plain' }),
    fn: (f) => f.name + f.size + f.type
  });
});
