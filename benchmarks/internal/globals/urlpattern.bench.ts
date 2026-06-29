/**
* Benchmarks for the URLPattern global
*
* Run with: cargo run -- --bench benchmarks/urlpattern.bench.mjs
*/
import { bench } from 'fino:bench';
bench('URLPattern construction', (b) => {
  b.group('object form', (g) => {
    g.measure('pathname only simple', () => new URLPattern({ pathname: '/users/:id' }));
    g.measure('pathname multi-param', () => new URLPattern({ pathname: '/:org/:repo/issues/:num' }));
    g.measure('pathname wildcard', () => new URLPattern({ pathname: '/api/*' }));
    g.measure('pathname + hostname', () => new URLPattern({
      pathname: '/api/:version',
      hostname: '*.example.com'
    }));
    g.measure('full spec', () => new URLPattern({
      protocol: 'https',
      hostname: 'example.com',
      pathname: '/users/:id',
      search: '?tab=:tab'
    }));
  });
  b.group('string form', (g) => {
    g.measure('simple path', () => new URLPattern('https://example.com/users/:id'));
    g.measure('wildcard', () => new URLPattern('https://*.example.com/api/*'));
  });
});
bench('URLPattern.test()', (b) => {
  const simple = new URLPattern({ pathname: '/users/:id' });
  const multi = new URLPattern({ pathname: '/:org/:repo/issues/:num' });
  const wildcard = new URLPattern({ pathname: '/api/*' });
  const full = new URLPattern({
    hostname: '*.example.com',
    pathname: '/v:ver/users/:id'
  });
  b.group('simple pathname', (g) => {
    g.measure('match', () => simple.test('https://example.com/users/42'));
    g.measure('no match', () => simple.test('https://example.com/posts/42'));
  });
  b.group('multi-param pathname', (g) => {
    g.measure('match', () => multi.test('https://github.com/nicolo/proposal/issues/123'));
    g.measure('no match', () => multi.test('https://github.com/nicolo/proposal'));
  });
  b.group('wildcard', (g) => {
    g.measure('match', () => wildcard.test('https://example.com/api/v1/users/42'));
    g.measure('no match', () => wildcard.test('https://example.com/other'));
  });
  b.measure('full pattern match', () => full.test('https://app.example.com/v2/users/99'));
});
bench('URLPattern.exec()', (b) => {
  const simple = new URLPattern({ pathname: '/users/:id' });
  const multi = new URLPattern({ pathname: '/:org/:repo/issues/:num' });
  b.group('exec + group extraction', (g) => {
    g.measure('simple 1 param', () => simple.exec('https://example.com/users/42'));
    g.measure('multi 3 params', () => multi.exec('https://github.com/foo/bar/issues/99'));
    g.measure('exec no match', () => simple.exec('https://example.com/nope'));
  });
});
