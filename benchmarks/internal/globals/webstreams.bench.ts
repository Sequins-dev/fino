/**
* Benchmarks for WHATWG Streams globals
*
* Run with: cargo run -- --bench benchmarks/webstreams.bench.mjs
*
* Note: WHATWG stream reading/piping operations require the event loop's
* microtask queue to settle synchronously between iterations. Some patterns
* trigger a Boa assertion in the synchronous spin loop. The benchmarks below
* cover constructors and sync-observable operations that remain stable under
* the adaptive benchmark loop.
*/
import { bench } from 'fino:bench';
const DATA_5 = [
  'a',
  'b',
  'c',
  'd',
  'e'
];
const DATA_10 = Array.from({ length: 10 }, (_, i) => `chunk${i}`);
const DATA_20 = Array.from({ length: 20 }, (_, i) => `chunk${i}`);
bench('ReadableStream.from()', (b) => {
  b.group('by size', (g) => {
    g.measure('from array 3', () => ReadableStream.from([
      'a',
      'b',
      'c'
    ]));
    g.measure('from array 10', () => ReadableStream.from(DATA_10));
    g.measure('from array 20', () => ReadableStream.from(DATA_20));
  });
});
bench('WritableStream construction', (b) => {
  b.measure('no-op sink', () => new WritableStream({ write(_chunk: unknown) {} }));
  b.measure('empty sink', () => new WritableStream());
});
bench('QueuingStrategy', (b) => {
  b.measure('CountQueuingStrategy', () => new CountQueuingStrategy({ highWaterMark: 10 }));
  b.measure('ByteLengthQueuingStrategy', () => new ByteLengthQueuingStrategy({ highWaterMark: 65536 }));
  b.measure('count size()', {
    setup: () => new CountQueuingStrategy({ highWaterMark: 10 }),
    fn: (s) => s.size('chunk')
  });
  b.measure('byteLen size()', {
    setup: () => new ByteLengthQueuingStrategy({ highWaterMark: 65536 }),
    fn: (s) => s.size(new Uint8Array(1024))
  });
});
// Note: TransformStream construction, stream piping, reading via getReader(),
// and for-await iteration all trigger VM memory pressure or assertion failures
// under sustained allocation in the adaptive bench loop. The focused tests
// cover those paths; this benchmark keeps to runnable release measurements.
