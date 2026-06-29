/**
* Benchmarks for fino:ffi
*
* Run with: cargo run -- bench benchmarks/ffi.bench.ts
*/
import { Pointer } from 'fino:ffi';
import { bench } from 'fino:bench';
const payload = new TextEncoder().encode('hello '.repeat(128));
bench('ffi pointers', (b) => {
  b.measure('Pointer.of', () => Pointer.of(payload));
  b.measure('Pointer read/write', () => {
    const buf = new ArrayBuffer(8);
    const ptr = Pointer.of(buf);
    Pointer.writeU32(ptr, 0, 305419896);
    Pointer.readU32(ptr, 0);
  });
});
