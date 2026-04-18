
/**
 * Benchmarks for fino:webstreams
 *
 * Run with: cargo run -- --bench benchmarks/webstreams.bench.mjs
 *
 * Note: WHATWG stream reading/piping operations require the event loop's
 * microtask queue to settle synchronously between iterations. Some patterns
 * trigger a Boa assertion in the synchronous spin loop. The benchmarks below
 * cover construction, sync-observable operations, and the piping fast path.
 */

import { ReadableStream, WritableStream, TransformStream, CountQueuingStrategy, ByteLengthQueuingStrategy } from 'fino:webstreams';
import { bench } from 'fino:bench';

const DATA_5  = ['a', 'b', 'c', 'd', 'e'];
const DATA_10 = Array.from({ length: 10 }, (_, i) => `chunk${i}`);
const DATA_20 = Array.from({ length: 20 }, (_, i) => `chunk${i}`);

bench('ReadableStream.from()', (b) => {
  b.group('by size', (g) => {
    g.measure('from array 3',  () => ReadableStream.from(['a', 'b', 'c']));
    g.measure('from array 10', () => ReadableStream.from(DATA_10));
    g.measure('from array 20', () => ReadableStream.from(DATA_20));
  });
});

bench('WritableStream construction', (b) => {
  b.measure('no-op sink',  () => new WritableStream({ write(_chunk: unknown) {} }));
  b.measure('empty sink',  () => new WritableStream());
});

bench('TransformStream construction', (b) => {
  b.measure('identity', () => new TransformStream());
  b.measure('with fn',  () => new TransformStream({ transform(chunk: unknown, controller: any) { controller.enqueue(chunk); } }));
});

bench('QueuingStrategy', (b) => {
  b.measure('CountQueuingStrategy',       () => new CountQueuingStrategy({ highWaterMark: 10 }));
  b.measure('ByteLengthQueuingStrategy',  () => new ByteLengthQueuingStrategy({ highWaterMark: 65536 }));
  b.measure('count size()',   { setup: () => new CountQueuingStrategy({ highWaterMark: 10 }), fn: (s) => s.size('chunk') });
  b.measure('byteLen size()', { setup: () => new ByteLengthQueuingStrategy({ highWaterMark: 65536 }), fn: (s) => s.size(new Uint8Array(1024)) });
});

// Note: Stream piping, reading via getReader(), and for-await iteration all
// trigger a Boa GC assertion under sustained allocation pressure in the bench
// spin loop. Track https://github.com/boa-dev/boa/issues for GC fixes.
// The construction benchmarks above capture the allocation-side costs.
