/**
* Benchmarks for internal:net/http/h1
*
* Run with: cargo run -- bench benchmarks/net/http/h1.bench.ts
*/
import { H1ClientDriver, H1ServerDriver } from '../../../js/net/http/h1.ts';
import { bench } from 'fino:bench';
bench('net/http h1', (b) => {
  b.measure('H1 drivers construct', () => {
    new H1ServerDriver();
    new H1ClientDriver();
  });
});
