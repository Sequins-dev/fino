/**
 * Benchmarks for URL and URLSearchParams globals
 *
 * Run with: cargo run -- --bench benchmarks/url.bench.mjs
 */
import { bench } from 'fino:bench';
bench('URL parsing', (b) => {
  b.measure('simple', () => new URL('https://example.com/path'));
  b.measure('full', () => new URL('https://user:pass@example.com:8080/a/b/c?q=1&r=2#frag'));
  b.measure('relative', () => new URL('../other', 'http://example.com/a/b/'));
  b.measure('no path', () => new URL('https://example.com'));
  b.measure('IP host', () => new URL('http://127.0.0.1:3000/api'));
});
bench('URL property access', (b) => {
  const url = new URL('https://user:pass@example.com:8080/a/b/c?q=1&r=2#frag');
  b.group('getters', (g) => {
    g.measure('href', () => url.href);
    g.measure('origin', () => url.origin);
    g.measure('host', () => url.host);
    g.measure('hostname', () => url.hostname);
    g.measure('pathname', () => url.pathname);
    g.measure('search', () => url.search);
    g.measure('hash', () => url.hash);
    g.measure('port', () => url.port);
  });
});
bench('URL setters', (b) => {
  b.measure('pathname', {
    setup: () => new URL('https://example.com/old'),
    fn: (u) => {
      u.pathname = '/new/path';
    },
  });
  b.measure('hostname', {
    setup: () => new URL('https://old.com/path'),
    fn: (u) => {
      u.hostname = 'new.com';
    },
  });
  b.measure('search', {
    setup: () => new URL('https://example.com/path'),
    fn: (u) => {
      u.search = '?a=1&b=2';
    },
  });
});
bench('URLSearchParams', (b) => {
  b.group('construction', (g) => {
    g.measure('from string', () => new URLSearchParams('a=1&b=2&c=3&d=4&e=5'));
    g.measure(
      'from object',
      () =>
        new URLSearchParams({
          a: '1',
          b: '2',
          c: '3',
        }),
    );
    g.measure(
      'from entries',
      () =>
        new URLSearchParams([
          ['a', '1'],
          ['b', '2'],
        ]),
    );
    g.measure('empty', () => new URLSearchParams());
  });
  const params = new URLSearchParams('a=1&b=2&c=3&d=hello+world&e=%C3%A9');
  b.group('lookup', (g) => {
    g.measure('get first', () => params.get('a'));
    g.measure('get middle', () => params.get('c'));
    g.measure('get missing', () => params.get('z'));
    g.measure('has true', () => params.has('b'));
    g.measure('has false', () => params.has('z'));
    g.measure('getAll', () => params.getAll('a'));
  });
  b.group('mutation', (g) => {
    g.measure('append', {
      setup: () => new URLSearchParams(),
      fn: (p) => p.append('k', 'v'),
    });
    g.measure('set', {
      setup: () => new URLSearchParams('k=old'),
      fn: (p) => p.set('k', 'new'),
    });
    g.measure('delete', {
      setup: () => new URLSearchParams('k=v'),
      fn: (p) => {
        p.append('k', 'v2');
        p.delete('k');
      },
    });
  });
  b.group('serialization', (g) => {
    const p5 = new URLSearchParams('a=1&b=2&c=3&d=4&e=5');
    const p10 = new URLSearchParams(Array.from({ length: 10 }, (_, i) => [`k${i}`, `v${i}`]));
    g.measure('toString 5 params', () => p5.toString());
    g.measure('toString 10 params', () => p10.toString());
  });
  b.group('iteration', (g) => {
    g.measure('for-of 5 params', () => {
      for (const [k, v] of params) {
      }
    });
    g.measure('keys', () => {
      for (const k of params.keys()) {
      }
    });
    g.measure('values', () => {
      for (const v of params.values()) {
      }
    });
  });
});
