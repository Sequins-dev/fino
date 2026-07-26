/**
 * Benchmarks for fino:test/mock
 *
 * Run with: cargo run -- bench benchmarks/test/mock.bench.ts
 */
import { MockFetchScope } from 'fino:test/mock';
import { bench } from 'fino:bench';
bench('test/mock', (b) => {
  b.measure('scope expectation', () => {
    const scope = new MockFetchScope('https://example.test');
    scope.get('/ok').reply(200, '{"ok":true}', { headers: { 'content-type': 'application/json' } });
  });
});
