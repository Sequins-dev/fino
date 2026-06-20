/**
 * Tests for the URLPattern global.
 */

import { describe, it } from 'fino:test/test';

type SymbolRecord = Record<symbol, unknown>;

describe('constructor — object form', () => {
  it('URLPattern -- object form, pathname only', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    t.equal(p.pathname, '/users/:id');
    t.equal(p.protocol, '*');
    t.equal(p.hostname, '*');
  });

  it('URLPattern -- object form, all components', (t) => {
    const p = new URLPattern({
      protocol: 'https',
      hostname: 'example.com',
      pathname: '/api/:version',
      search: 'key=:val',
    });
    t.equal(p.protocol, 'https');
    t.equal(p.hostname, 'example.com');
    t.equal(p.pathname, '/api/:version');
    t.equal(p.search, 'key=:val');
  });
});

describe('constructor — string form', () => {
  it('URLPattern -- string form, full URL', (t) => {
    const p = new URLPattern('https://example.com/users/:id');
    t.equal(p.protocol, 'https');
    t.equal(p.hostname, 'example.com');
    t.equal(p.pathname, '/users/:id');
  });

  it('URLPattern -- string form, pathname only', (t) => {
    const p = new URLPattern('/posts/:slug');
    t.equal(p.pathname, '/posts/:slug');
  });

  it('URLPattern -- string form, with search', (t) => {
    const p = new URLPattern('https://example.com/search?q=:query');
    t.equal(p.pathname, '/search');
    t.equal(p.search, 'q=:query');
  });
});

describe('test()', () => {
  it('URLPattern -- test() matches full URL', (t) => {
    const p = new URLPattern({ hostname: 'example.com', pathname: '/users/:id' });
    t.equal(p.test('https://example.com/users/42'), true);
    t.equal(p.test('https://example.com/posts/42'), false);
    t.equal(p.test('https://other.com/users/42'), false);
  });

  it('URLPattern -- test() wildcard matches anything', (t) => {
    const p = new URLPattern({ pathname: '/users/*' });
    t.equal(p.test('https://example.com/users/'), true);
    t.equal(p.test('https://example.com/users/42'), true);
    t.equal(p.test('https://example.com/users/a/b/c'), true);
    t.equal(p.test('https://example.com/posts/1'), false);
  });

  it('URLPattern -- test() all-wildcard matches any URL', (t) => {
    const p = new URLPattern({ pathname: '*' });
    t.equal(p.test('https://example.com/anything'), true);
    t.equal(p.test('http://foo.bar/x/y/z'), true);
  });

  it('URLPattern -- test() literal pathname', (t) => {
    const p = new URLPattern({ pathname: '/about' });
    t.equal(p.test('https://example.com/about'), true);
    t.equal(p.test('https://example.com/about/'), false);
    t.equal(p.test('https://example.com/contact'), false);
  });
});

describe('exec()', () => {
  it('URLPattern -- exec() returns null on no match', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    t.equal(p.exec('https://example.com/posts/1'), null);
  });

  it('URLPattern -- exec() returns match with named groups', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    const m = p.exec('https://example.com/users/42');
    t.ok(m !== null, 'match is not null');
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.input, '/users/42');
    t.equal(m.pathname.groups.id, '42');
  });

  it('URLPattern -- exec() multiple named groups', (t) => {
    const p = new URLPattern({ pathname: '/blog/:year/:month/:slug' });
    const m = p.exec('https://example.com/blog/2024/03/hello-world');
    t.ok(m !== null);
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.groups.year, '2024');
    t.equal(m.pathname.groups.month, '03');
    t.equal(m.pathname.groups.slug, 'hello-world');
  });

  it('URLPattern -- exec() hostname groups', (t) => {
    const p = new URLPattern({ hostname: ':sub.example.com' });
    const m = p.exec('https://api.example.com/foo');
    t.ok(m !== null);
    if (m === null) throw new Error('expected match');
    t.equal(m.hostname.groups.sub, 'api');
  });

  it('URLPattern -- exec() protocol captured', (t) => {
    const p = new URLPattern({ protocol: ':proto', hostname: 'example.com', pathname: '/' });
    const m = p.exec('https://example.com/');
    t.ok(m !== null);
    if (m === null) throw new Error('expected match');
    t.equal(m.protocol.groups.proto, 'https');
  });

  it('URLPattern -- exec() search groups', (t) => {
    const p = new URLPattern({ pathname: '/search', search: 'q=:query' });
    const m = p.exec('https://example.com/search?q=hello');
    t.ok(m !== null);
    if (m === null) throw new Error('expected match');
    t.equal(m.search.groups.query, 'hello');
  });
});

describe('advanced patterns', () => {
  it('URLPattern -- optional named param (:id?)', (t) => {
    const p = new URLPattern({ pathname: '/users/:id?' });
    t.equal(p.test('https://example.com/users/42'), true);
    t.equal(p.test('https://example.com/users/'), true);
  });

  it('URLPattern -- custom regex group (\\d+)', (t) => {
    const p = new URLPattern({ pathname: '/users/(\\d+)' });
    t.equal(p.test('https://example.com/users/42'), true);
    t.equal(p.test('https://example.com/users/abc'), false);
  });

  it('URLPattern -- named param with custom regex :id(\\d+)', (t) => {
    const p = new URLPattern({ pathname: '/items/:id(\\d+)' });
    const m = p.exec('https://example.com/items/99');
    t.ok(m !== null);
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.groups.id, '99');
    t.equal(p.test('https://example.com/items/abc'), false);
  });

  it('URLPattern -- wildcard hostname', (t) => {
    const p = new URLPattern({ hostname: '*.example.com', pathname: '/' });
    t.equal(p.test('https://api.example.com/'), true);
    t.equal(p.test('https://cdn.example.com/'), true);
    t.equal(p.test('https://example.com/'), false);
  });

  it('URLPattern -- exec() inputs contains original input', (t) => {
    const p = new URLPattern({ pathname: '/:id' });
    const m = p.exec('https://example.com/42');
    if (m === null) throw new Error('expected match');
    t.ok(Array.isArray(m.inputs), 'inputs is array');
    t.equal(m.inputs[0], 'https://example.com/42');
  });

  it('URLPattern -- throws on null input', (t) => {
    t.throws(() => new URLPattern(null as never), null, 'throws on null');
  });
});

describe('exec() and test() with baseURL', () => {
  it('exec() with baseURL string resolves relative URL', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    const m = p.exec('/users/42', 'https://example.com');
    t.ok(m !== null, 'match is not null');
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.groups.id, '42');
  });

  it('test() with baseURL string resolves relative URL', (t) => {
    const p = new URLPattern({ hostname: 'example.com', pathname: '/api/:version' });
    t.equal(p.test('/api/v1', 'https://example.com'), true);
    t.equal(p.test('/api/v1', 'https://other.com'), false);
  });

  it('exec() with baseURL — inputs array contains both input and baseURL', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    const m = p.exec('/users/7', 'https://example.com');
    if (m === null) throw new Error('expected match');
    t.ok(Array.isArray(m.inputs), 'inputs is array');
    t.equal(m.inputs[0], '/users/7');
    t.equal(m.inputs[1], 'https://example.com');
  });
});

describe('string form with port pattern', () => {
  it('URLPattern string form with explicit port — properties', (t) => {
    const p = new URLPattern('http://example.com:8080/path');
    t.equal(p.protocol, 'http');
    t.equal(p.hostname, 'example.com');
    t.equal(p.port, '8080');
    t.equal(p.pathname, '/path');
  });

  it('URLPattern string form with explicit port — test()', (t) => {
    const p = new URLPattern('http://example.com:8080/path');
    t.equal(p.test('http://example.com:8080/path'), true);
    t.equal(p.test('http://example.com/path'), false);
  });
});

describe('{group} non-capturing groups', () => {
  it('URLPattern -- {/api} prefix group matches literal', (t) => {
    const p = new URLPattern({ pathname: '{/api}/users' });
    t.equal(p.test('https://example.com/api/users'), true);
    t.equal(p.test('https://example.com/users'), false);
  });
});

describe('unnamed (regex) groups in exec()', () => {
  it('URLPattern -- unnamed group gets numeric key "0"', (t) => {
    const p = new URLPattern({ pathname: '/users/(\\d+)' });
    const m = p.exec('https://example.com/users/99');
    t.ok(m !== null, 'match is not null');
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.groups['0'], '99');
  });

  it('URLPattern -- multiple unnamed groups get numeric keys', (t) => {
    const p = new URLPattern({ pathname: '/(\\w+)/(\\d+)' });
    const m = p.exec('https://example.com/posts/42');
    t.ok(m !== null, 'match is not null');
    if (m === null) throw new Error('expected match');
    t.equal(m.pathname.groups['0'], 'posts');
    t.equal(m.pathname.groups['1'], '42');
  });
});

describe('repeat modifiers', () => {
  it(':name+ (one-or-more) matches one segment', (t) => {
    const p = new URLPattern({ pathname: '/:name+' });
    t.equal(p.test('https://example.com/foo'), true, 'matches single segment');
    t.equal(p.exec('https://example.com/foo')?.pathname.groups.name, 'foo', 'captures the single segment');
  });

  it(':name+ (one-or-more) matches multiple segments', (t) => {
    const p = new URLPattern({ pathname: '/:name+' });
    const result = p.exec('https://example.com/a/b');
    t.ok(result !== null, 'matches multiple slash-separated segments');
    t.equal(result?.pathname.groups.name, 'a/b', 'captures all repeated segments');
  });

  it(':name* (zero-or-more) matches empty', (t) => {
    const p = new URLPattern({ pathname: '/:name*' });
    const result = p.exec('https://example.com/');
    t.ok(result !== null, 'matches zero segments');
    t.equal(result?.pathname.groups.name, undefined, 'empty repeat capture is undefined');
  });

  it(':name* (zero-or-more) matches one segment', (t) => {
    const p = new URLPattern({ pathname: '/:name*' });
    const result = p.exec('https://example.com/foo');
    t.ok(result !== null, 'matches one segment');
    t.equal(result?.pathname.groups.name, 'foo', 'captures one segment');
  });

  it(':name? (optional) matches present and absent segments', (t) => {
    const p = new URLPattern({ pathname: '/users/:id?' });
    t.equal(p.exec('https://example.com/users/42')?.pathname.groups.id, '42', 'captures present optional segment');
    t.equal(p.exec('https://example.com/users/')?.pathname.groups.id, undefined, 'absent optional segment is undefined');
  });
});

describe('escaped characters in patterns', () => {
  it('\\: matches literal colon', (t) => {
    const p = new URLPattern({ pathname: '/users\\:action' });
    t.equal(p.test('https://example.com/users:action'), true, 'literal colon matched');
    t.equal(p.test('https://example.com/usersXaction'), false, 'non-colon not matched');
  });

  it('\\/ matches literal slash', (t) => {
    const p = new URLPattern({ pathname: '/files\\/path' });
    t.equal(p.test('https://example.com/files/path'), true, 'escaped slash matches a literal slash');
    t.equal(p.test('https://example.com/filesXpath'), false, 'escaped slash does not match another character');
  });

  it('captures named groups beside escaped literals', (t) => {
    const p = new URLPattern({ pathname: '/files\\/:name\\:raw' });
    const result = p.exec('https://example.com/files/report:raw');
    t.ok(result !== null, 'matches escaped slash and colon around a named group');
    t.equal(result?.pathname.groups.name, 'report', 'captures the named segment');
  });
});

describe('protocol case sensitivity', () => {
  it('protocol matching is case-insensitive', (t) => {
    const p = new URLPattern({ protocol: 'https', hostname: 'example.com', pathname: '/' });
    // Protocol in URL is lowercased by URL parser so this should match
    t.equal(p.test('https://example.com/'), true, 'lowercase https matches');
    // If we provide HTTPS (uppercase), the URL parser normalizes it
    t.equal(p.test('HTTPS://example.com/'), true, 'uppercase HTTPS also matches (URL normalizes)');
  });
});

describe('URLPattern [Symbol.toStringTag]', () => {
  it('URLPattern [Symbol.toStringTag] is "URLPattern"', (t) => {
    const p = new URLPattern({ pathname: '/test' });
    t.equal((p as unknown as SymbolRecord)[Symbol.toStringTag], 'URLPattern');
  });
});

describe('URLPattern :name+ modifier (multi-segment)', () => {
  it(':name+ matches a single segment', (t) => {
    const p = new URLPattern({ pathname: '/:path+' });
    t.equal(p.test('https://x.com/foo'), true, 'single segment matches');
    const r = p.exec('https://x.com/foo');
    t.equal(r?.pathname.groups.path, 'foo', 'captures single segment');
  });

  it(':name+ matches multiple /-separated segments', (t) => {
    const p = new URLPattern({ pathname: '/:path+' });
    t.equal(p.test('https://x.com/foo/bar/baz'), true, 'multi-segment matches');
    const r = p.exec('https://x.com/foo/bar/baz');
    t.equal(r?.pathname.groups.path, 'foo/bar/baz', 'captures full multi-segment path');
  });

  it(':name+ requires at least one segment', (t) => {
    const p = new URLPattern({ pathname: '/:path+' });
    t.equal(p.test('https://x.com/'), false, 'empty path does not match');
  });
});

describe('URLPattern :name* modifier (zero-or-more segments)', () => {
  it(':name* matches zero segments (optional)', (t) => {
    const p = new URLPattern({ pathname: '/:path*' });
    t.equal(p.test('https://x.com/'), true, 'zero segments matches');
  });

  it(':name* matches one segment', (t) => {
    const p = new URLPattern({ pathname: '/:path*' });
    const r = p.exec('https://x.com/foo');
    t.ok(r !== null, 'matches single segment');
    t.equal(r?.pathname.groups.path, 'foo', 'captures single segment');
  });

  it(':name* matches multiple segments', (t) => {
    const p = new URLPattern({ pathname: '/:path*' });
    const r = p.exec('https://x.com/a/b/c');
    t.ok(r !== null, 'matches multiple segments');
    t.equal(r?.pathname.groups.path, 'a/b/c', 'captures full path');
  });
});

describe('URLPattern hasRegExpGroups', () => {
  it('is false for patterns with only named params', (t) => {
    const p = new URLPattern({ pathname: '/:id' });
    t.equal(p.hasRegExpGroups, false, 'named param only → false');
  });

  it('is false for wildcard patterns', (t) => {
    const p = new URLPattern({ pathname: '/*' });
    t.equal(p.hasRegExpGroups, false, 'wildcard → false');
  });

  it('is true when an explicit regexp group is present', (t) => {
    const p = new URLPattern({ pathname: '/(foo|bar)' });
    t.equal(p.hasRegExpGroups, true, 'explicit regexp group → true');
  });

  it('is true when named param has explicit regexp', (t) => {
    const p = new URLPattern({ pathname: '/:id(\\d+)' });
    t.equal(p.hasRegExpGroups, true, 'named param with custom regexp → true');
  });
});

describe('URLPattern hash pattern', () => {
  it('matches on hash component', (t) => {
    const p = new URLPattern({ hash: 'section-*' });
    t.equal(p.test('https://x.com/#section-one'), true, 'hash matches');
    t.equal(p.test('https://x.com/#other'), false, 'hash mismatch');
  });
});

describe('URLPattern exec with object input', () => {
  it('exec with URL object input', (t) => {
    const p = new URLPattern({ pathname: '/users/:id' });
    const url = new URL('https://example.com/users/42');
    const r = p.exec(url);
    t.ok(r !== null, 'exec matches URL object');
    t.equal(r?.pathname.groups.id, '42', 'captured id');
  });
});

describe('URLPattern wildcard group names', () => {
  it('wildcard * produces numeric group key "0"', (t) => {
    const p = new URLPattern({ pathname: '/files/*' });
    const r = p.exec('https://example.com/files/foo/bar');
    t.ok(r !== null, 'matches');
    t.equal(r?.pathname.groups['0'], 'foo/bar', 'wildcard group key is "0"');
  });

  it('multiple wildcards produce sequential numeric keys', (t) => {
    const p = new URLPattern({ pathname: '/*/*/*' });
    const r = p.exec('https://example.com/a/b/c');
    t.ok(r !== null, 'matches');
    t.equal(r?.pathname.groups['0'], 'a', 'first wildcard is "0"');
    t.equal(r?.pathname.groups['1'], 'b', 'second wildcard is "1"');
    t.equal(r?.pathname.groups['2'], 'c', 'third wildcard is "2"');
  });

  it('hasRegExpGroups is false for plain wildcard', (t) => {
    const p = new URLPattern({ pathname: '/files/*' });
    t.equal(p.hasRegExpGroups, false, 'plain wildcard is not a regexp group');
  });
});

describe('URLPattern — named param in search component', () => {
  it(':name in search matches values containing /', (t) => {
    const p = new URLPattern({ search: ':q' });
    const r = p.exec('https://example.com/?foo/bar');
    t.ok(r !== null, 'matches search with / in value');
    t.equal(r?.search.groups.q, 'foo/bar', 'captures value with /');
  });
});

describe('URLPattern percent-encoding boundaries', () => {
  it('percent-encoded tokenizer characters in pathname patterns are literal text', (t) => {
    const p = new URLPattern({ pathname: '/files/%3Aid/%28raw%29' });

    t.equal(p.test('https://example.com/files/%3Aid/%28raw%29'), true, 'encoded colon and parens match literally');
    t.equal(p.test('https://example.com/files/:id/(raw)'), false, 'encoded tokenizer characters do not match decoded characters');
  });

  it('percent-encoded path delimiters stay inside named captures', (t) => {
    const p = new URLPattern({ pathname: '/files/:name' });
    const r = p.exec('https://example.com/files/a%2Fb');

    t.ok(r !== null, 'encoded slash does not split the pathname segment');
    t.equal(r?.pathname.groups.name, 'a%2Fb', 'capture preserves percent-encoded slash');
  });

  it('string patterns do not split search on percent-encoded question marks', (t) => {
    const p = new URLPattern('https://example.com/a%3Fb');

    t.equal(p.pathname, '/a%3Fb', 'encoded question mark remains in pathname pattern');
    t.equal(p.search, '*', 'encoded question mark does not start a search pattern');
    t.equal(p.test('https://example.com/a%3Fb'), true, 'encoded question mark pathname matches');
    t.equal(p.test('https://example.com/a?b'), false, 'decoded question mark is a URL delimiter, not pathname text');
  });
});
