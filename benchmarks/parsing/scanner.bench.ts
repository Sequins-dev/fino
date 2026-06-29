/**
* Benchmarks for fino:parsing/scanner
*
* Run with: cargo run -- bench benchmarks/parsing/scanner.bench.ts
*/
import { Scanner } from 'fino:parsing/scanner';
import { bench } from 'fino:bench';
bench('scanner', (b) => {
  b.measure('readDelimitedList', () => new Scanner('text/html, application/json, */*').readDelimitedList(','));
  b.measure('readStrictInt', () => new Scanner('12345').readStrictInt());
});
