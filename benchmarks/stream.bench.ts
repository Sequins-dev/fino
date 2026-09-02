/**
 * Benchmarks for fino:stream
 *
 * Run with: cargo run -- bench benchmarks/stream.bench.ts
 */
import {
  BufferedBytesReader,
  BufferedBytesWriter,
  BytesReader,
  BytesWriter,
  type ReadResult,
} from 'fino:stream';
import { bench } from 'fino:bench';
class MemoryReader extends BytesReader {
  protected async doReadInto(_buffer: Uint8Array): Promise<ReadResult<number>> {
    return { done: true, value: undefined };
  }
}
class MemoryWriter extends BytesWriter {
  protected async doWrite(buf: Uint8Array): Promise<void> {
    void buf;
  }
}
bench('stream', (b) => {
  b.measure('BytesReader subclass construction', () => {
    new MemoryReader();
  });
  b.measure('BytesWriter subclass construction', () => {
    new MemoryWriter();
  });
  b.measure('BufferedBytesReader.over', () => {
    BufferedBytesReader.over(new MemoryReader());
  });
  b.measure('BufferedBytesWriter.over', () => {
    BufferedBytesWriter.over(new MemoryWriter());
  });
});
