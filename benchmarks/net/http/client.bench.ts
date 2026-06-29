/**
* Benchmarks for fino:net/http/client
*
* Run with: cargo run -- bench benchmarks/net/http/client.bench.ts
*/
import { HttpClient } from 'fino:net/http/client';
import { bench } from 'fino:bench';
bench('net/http client', (b) => {
  b.measure('construct default client', () => new HttpClient());
  const client = new HttpClient({
    baseUrl: 'https://example.test/api/',
    headers: { authorization: 'Bearer token' }
  });
  b.measure('fetch method reference', () => client.fetch);
});
