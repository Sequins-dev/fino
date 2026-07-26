/**
 * Benchmarks for fino:net/http/eventsource
 *
 * Run with: cargo run -- bench benchmarks/net/http/eventsource.bench.ts
 */
import { EventSourceReader, EventSourceWriter } from 'fino:net/http/eventsource';
import { bench } from 'fino:bench';
const sseBytes = new TextEncoder().encode('event: update\ndata: hello\nid: 1\n\n');
const source = {
  async *[Symbol.asyncIterator]() {
    yield sseBytes;
  },
};
bench('net/http eventsource', (b) => {
  b.measure('EventSourceReader construct', () => new EventSourceReader(source));
  b.measure(
    'EventSourceWriter construct',
    () =>
      new EventSourceWriter({
        write(chunk: Uint8Array) {
          return Promise.resolve(chunk.byteLength);
        },
      }),
  );
});
