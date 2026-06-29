/**
* Benchmarks for fino:stream
*
* Run with: cargo run -- bench benchmarks/stream.bench.ts
*/
import { BufferedBytesReader, BufferedBytesWriter, BytesReader, BytesWriter } from 'fino:stream';
import { bench } from 'fino:bench';
class MemoryReader extends BytesReader {
  protected async doRead(_maxBytes: number): Promise<Uint8Array | null> {
    return null;
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
