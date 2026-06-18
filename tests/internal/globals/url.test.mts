/**
 * Tests for URL and URLSearchParams globals.
 */

import { describe, it } from 'fino:test/test';
type SymbolRecord = Record<symbol, unknown>;
const { URL, URLSearchParams } = globalThis;

describe('URLSearchParams construction', () => {
  it('empty constructor', (t) => {
    const p = new URLSearchParams();
    t.equal(p.size, 0);
    t.equal(p.toString(), '');
  });

  it('string init', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    t.equal(p.get('a'), '1');
    t.equal(p.get('b'), '2');
    t.equal(p.size, 2);
  });

  it('string with leading ?', (t) => {
    const p = new URLSearchParams('?x=hello');
    t.equal(p.get('x'), 'hello');
  });

  it('object init', (t) => {
    const p = new URLSearchParams({ foo: 'bar', num: '42' });
    t.equal(p.get('foo'), 'bar');
    t.equal(p.get('num'), '42');
  });

  it('array of pairs init', (t) => {
    const p = new URLSearchParams([['k', 'v'], ['k', 'v2']]);
    t.equal(p.getAll('k').length, 2);
    t.equal(p.getAll('k')[0], 'v');
    t.equal(p.getAll('k')[1], 'v2');
  });

  it('copy constructor', (t) => {
    const a = new URLSearchParams('x=1');
    const b = new URLSearchParams(a);
    b.set('x', '2');
    t.equal(a.get('x'), '1', 'original unchanged');
    t.equal(b.get('x'), '2');
  });
});

describe('URLSearchParams methods', () => {
  it('append allows duplicates', (t) => {
    const p = new URLSearchParams();
    p.append('a', '1');
    p.append('a', '2');
    t.equal(p.getAll('a').length, 2);
    t.equal(p.size, 2);
  });

  it('set removes duplicates', (t) => {
    const p = new URLSearchParams('a=1&a=2');
    p.set('a', 'new');
    t.equal(p.get('a'), 'new');
    t.equal(p.getAll('a').length, 1);
  });

  it('delete', (t) => {
    const p = new URLSearchParams('a=1&b=2&a=3');
    p.delete('a');
    t.equal(p.has('a'), false);
    t.equal(p.has('b'), true);
    t.equal(p.size, 1);
  });

  it('has', (t) => {
    const p = new URLSearchParams('x=1');
    t.equal(p.has('x'), true);
    t.equal(p.has('y'), false);
  });

  it('sort', (t) => {
    const p = new URLSearchParams('c=3&a=1&b=2');
    p.sort();
    t.deepEqual([...p.keys()], ['a', 'b', 'c']);
  });

  it('toString encodes spaces as +', (t) => {
    const p = new URLSearchParams({ q: 'hello world' });
    t.equal(p.toString(), 'q=hello+world');
  });

  it('decodes + as space', (t) => {
    const p = new URLSearchParams('q=hello+world');
    t.equal(p.get('q'), 'hello world');
  });

  it('percent encoding round-trip', (t) => {
    const p = new URLSearchParams({ emoji: 'café' });
    const p2 = new URLSearchParams(p.toString());
    t.equal(p2.get('emoji'), 'café');
  });

  it('getAll', (t) => {
    const p = new URLSearchParams('a=1&a=2');
    t.deepEqual(p.getAll('a'), ['1', '2']);
  });
});

describe('URLSearchParams iteration', () => {
  it('entries iterator', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    t.deepEqual([...p.entries()], [['a', '1'], ['b', '2']]);
  });

  it('keys and values', (t) => {
    const p = new URLSearchParams('x=1&y=2');
    t.deepEqual([...p.keys()],   ['x', 'y']);
    t.deepEqual([...p.values()], ['1', '2']);
  });

  it('forEach', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    const seen: Array<[string, string]> = [];
    p.forEach((value, name) => seen.push([name, value]));
    t.deepEqual(seen, [['a', '1'], ['b', '2']]);
  });

  it('for-of (Symbol.iterator)', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    const pairs = [];
    for (const pair of p) pairs.push(pair);
    t.deepEqual(pairs, [['a', '1'], ['b', '2']]);
  });
});

describe('URL construction', () => {
  it('basic http', (t) => {
    const u = new URL('http://example.com/path?q=1#frag');
    t.equal(u.protocol,  'http:');
    t.equal(u.hostname,  'example.com');
    t.equal(u.port,      '');
    t.equal(u.pathname,  '/path');
    t.equal(u.search,    '?q=1');
    t.equal(u.hash,      '#frag');
    t.equal(u.origin,    'http://example.com');
  });

  it('https with explicit port', (t) => {
    const u = new URL('https://example.com:8443/api');
    t.equal(u.protocol, 'https:');
    t.equal(u.hostname, 'example.com');
    t.equal(u.port,     '8443');
    t.equal(u.origin,   'https://example.com:8443');
  });

  it('default ports are stripped', (t) => {
    t.equal(new URL('http://example.com:80/').port,   '');
    t.equal(new URL('https://example.com:443/').port, '');
    t.equal(new URL('ws://example.com:80/').port,     '');
    t.equal(new URL('wss://example.com:443/').port,   '');
  });

  it('credentials', (t) => {
    const u = new URL('http://user:pass@example.com/');
    t.equal(u.username, 'user');
    t.equal(u.password, 'pass');
  });

  it('no path defaults to /', (t) => {
    const u = new URL('http://example.com');
    t.equal(u.pathname, '/');
  });

  it('href reconstruction', (t) => {
    const raw = 'https://user:pw@example.com:8080/path?q=1#frag';
    const u = new URL(raw);
    t.equal(u.href, raw);
  });

  it('case-normalises scheme and host', (t) => {
    const u = new URL('HTTP://Example.COM/Path');
    t.equal(u.protocol, 'http:');
    t.equal(u.hostname, 'example.com');
    t.equal(u.pathname, '/Path');
  });

  it('throws on invalid input', (t) => {
    t.throws(() => new URL('not a url'), null, 'no scheme throws');
    t.throws(() => new URL(''), null, 'empty string throws');
  });
});

describe('URL relative resolution', () => {
  it('relative path', (t) => {
    const u = new URL('page', 'http://example.com/a/b/');
    t.equal(u.href, 'http://example.com/a/b/page');
  });

  it('relative with ..', (t) => {
    const u = new URL('../other', 'http://example.com/a/b/c');
    t.equal(u.href, 'http://example.com/a/other');
  });

  it('absolute path on same host', (t) => {
    const u = new URL('/new/path', 'http://example.com/old/path?q=1');
    t.equal(u.href, 'http://example.com/new/path');
  });

  it('query-only relative', (t) => {
    const u = new URL('?x=2', 'http://example.com/page?x=1');
    t.equal(u.href, 'http://example.com/page?x=2');
  });

  it('fragment-only relative', (t) => {
    const u = new URL('#section', 'http://example.com/page');
    t.equal(u.href, 'http://example.com/page#section');
  });

  it('URL object as base', (t) => {
    const base = new URL('http://example.com/a/');
    const u = new URL('b', base);
    t.equal(u.href, 'http://example.com/a/b');
  });

  it('throws with relative input and no base', (t) => {
    t.throws(() => new URL('/relative/path'), null, 'relative without base throws');
  });
});

describe('URL setters', () => {
  it('href setter reparses', (t) => {
    const u = new URL('http://a.com/');
    u.href = 'https://b.com/path';
    t.equal(u.protocol, 'https:');
    t.equal(u.hostname, 'b.com');
    t.equal(u.pathname, '/path');
  });

  it('protocol setter', (t) => {
    const u = new URL('http://example.com/');
    u.protocol = 'https';
    t.equal(u.protocol, 'https:');
    t.equal(u.href.startsWith('https://'), true);
  });

  it('hostname setter', (t) => {
    const u = new URL('http://example.com/path');
    u.hostname = 'other.com';
    t.equal(u.hostname, 'other.com');
    t.equal(u.pathname, '/path');
  });

  it('port setter', (t) => {
    const u = new URL('http://example.com/');
    u.port = '3000';
    t.equal(u.port, '3000');
    t.equal(u.host, 'example.com:3000');
  });

  it('port setter strips default port', (t) => {
    const u = new URL('http://example.com:3000/');
    u.port = '80';
    t.equal(u.port, '');
  });

  it('pathname setter', (t) => {
    const u = new URL('http://example.com/old');
    u.pathname = '/new/path';
    t.equal(u.pathname, '/new/path');
  });

  it('search setter', (t) => {
    const u = new URL('http://example.com/');
    u.search = '?a=1&b=2';
    t.equal(u.search, '?a=1&b=2');
    t.equal(u.searchParams.get('a'), '1');
  });

  it('hash setter', (t) => {
    const u = new URL('http://example.com/');
    u.hash = '#section';
    t.equal(u.hash, '#section');
    u.hash = '';
    t.equal(u.hash, '');
  });
});

describe('URL searchParams sync', () => {
  it('searchParams.append updates search', (t) => {
    const u = new URL('http://example.com/?a=1');
    u.searchParams.append('b', '2');
    t.ok(u.search.includes('b=2'), 'search updated after append');
  });

  it('searchParams.set updates search', (t) => {
    const u = new URL('http://example.com/?a=old');
    u.searchParams.set('a', 'new');
    t.equal(u.searchParams.get('a'), 'new');
    t.ok(u.search.includes('a=new'), 'search reflects new value');
  });

  it('search setter updates searchParams', (t) => {
    const u = new URL('http://example.com/?a=1');
    u.search = 'x=42';
    t.equal(u.searchParams.get('x'), '42');
    t.equal(u.searchParams.has('a'), false);
  });

  it('searchParams mutation reflected in href', (t) => {
    const u = new URL('http://example.com/');
    u.searchParams.set('hello', 'world');
    t.ok(u.href.includes('hello=world'));
  });
});

describe('URL static methods', () => {
  it('URL.canParse — valid URL', (t) => {
    t.equal(URL.canParse('http://example.com/'), true);
  });

  it('URL.canParse — invalid URL', (t) => {
    t.equal(URL.canParse('not a url'), false);
    t.equal(URL.canParse(''), false);
  });

  it('URL.canParse — with base', (t) => {
    t.equal(URL.canParse('/path', 'http://example.com'), true);
    t.equal(URL.canParse('/path', 'not-a-url'), false);
  });

  it('URL.parse — returns URL on success', (t) => {
    const u = URL.parse('http://example.com/');
    t.ok(u instanceof URL);
    if (u === null) throw new Error('expected URL');
    t.equal(u.hostname, 'example.com');
  });

  it('URL.parse — returns null on failure', (t) => {
    t.equal(URL.parse('not a url'), null);
    t.equal(URL.parse(''), null);
  });
});

describe('URL misc', () => {
  it('toString equals href', (t) => {
    const u = new URL('https://example.com/path?q=1');
    t.equal(u.toString(), u.href);
  });

  it('toJSON equals href', (t) => {
    const u = new URL('https://example.com/');
    t.equal(u.toJSON(), u.href);
  });

  it('origin is null for non-special schemes', (t) => {
    const u = new URL('mailto:user@example.com');
    t.equal(u.origin, 'null');
  });

  it('path normalization resolves . and ..', (t) => {
    const u = new URL('http://example.com/a/./b/../c');
    t.equal(u.pathname, '/a/c');
  });
});

describe('URL additional construction', () => {
  it('IPv6 URL — hostname is [::1]', (t) => {
    const u = new URL('http://[::1]/path');
    t.equal(u.hostname, '[::1]');
    t.equal(u.pathname, '/path');
  });

  it('IPv6 URL with custom port — port is preserved', (t) => {
    const u = new URL('http://[::1]:9000/path');
    t.equal(u.hostname, '[::1]', 'hostname is bracketed IPv6');
    t.equal(u.port, '9000', 'port is preserved');
    t.equal(u.pathname, '/path', 'pathname correct');
    t.equal(u.origin, 'http://[::1]:9000', 'origin includes port');
    t.equal(u.host, '[::1]:9000', 'host includes brackets and port');
  });

  it('file: URL — protocol and pathname', (t) => {
    const u = new URL('file:///etc/hosts');
    t.equal(u.protocol, 'file:');
    t.equal(u.pathname, '/etc/hosts');
  });

  it('username and password setters', (t) => {
    const u = new URL('http://example.com/');
    u.username = 'alice';
    u.password = 's3cr3t';
    t.equal(u.username, 'alice');
    t.equal(u.password, 's3cr3t');
  });

  it('URL.host setter changes hostname and port', (t) => {
    const u = new URL('http://example.com/');
    u.host = 'other.com:9000';
    t.equal(u.hostname, 'other.com');
    t.equal(u.port, '9000');
  });

  it('URL.port setter with non-numeric value is ignored', (t) => {
    const u = new URL('http://example.com:3000/');
    u.port = 'abc';
    t.equal(u.port, '3000');
  });

  it('URL [Symbol.toStringTag] is "URL"', (t) => {
    const u = new URL('http://example.com/');
    t.equal((u as unknown as SymbolRecord)[Symbol.toStringTag], 'URL');
  });
});

describe('URLSearchParams.delete — two-argument form', () => {
  it('delete(name, value) removes only the matching name+value pair', (t) => {
    const p = new URLSearchParams('a=1&a=2&b=3');
    p.delete('a', '1'); // spec: should only delete a=1, not a=2
    t.deepEqual(p.getAll('a'), ['2'], 'only a=1 removed, a=2 preserved');
    t.equal(p.has('b'), true, 'b entry preserved');
  });
});

describe('URLSearchParams.has — two-argument form', () => {
  it('has(name, value) returns false when value does not match', (t) => {
    const p = new URLSearchParams('a=1&a=2');
    t.equal(p.has('a', '99'), false, 'no a=99 entry');
    t.equal(p.has('a', '1'), true, 'a=1 exists');
  });
});

describe('URL.port setter edge cases', () => {
  it('port setter strips leading zeros and removes default port', (t) => {
    const u = new URL('http://example.com/');
    u.port = '0080';
    // Per spec: leading zeros are stripped; 80 is the default http port so it is removed.
    t.equal(u.port, '', 'port "0080" normalizes to 80 which is the default http port, so it is stripped');

    const u2 = new URL('http://example.com/');
    u2.port = '0443';
    // 443 is not the default port for http, so it is kept (without leading zeros)
    t.equal(u2.port, '443', 'port "0443" normalizes to "443"');
  });

  it('port setter with out-of-range value (> 65535) is ignored', (t) => {
    const u = new URL('http://example.com:3000/');
    u.port = '65536';
    t.equal(u.port, '3000', 'out-of-range port is ignored, original preserved');
  });

  it('port setter with value 0 sets port to "0"', (t) => {
    const u = new URL('http://example.com/');
    u.port = '0';
    // Port 0 is not the default for http, so it should be set
    t.equal(u.port, '0', 'port 0 is set');
  });
});

describe('URL.parse — with base argument', () => {
  it('URL.parse with relative input and base', (t) => {
    const u = URL.parse('/path', 'http://example.com');
    t.ok(u instanceof URL, 'returns URL');
    if (u === null) throw new Error('expected URL');
    t.equal(u.href, 'http://example.com/path', 'resolves relative against base');
  });

  it('URL.parse with invalid relative input and invalid base returns null', (t) => {
    const result = URL.parse('/path', 'not-a-url');
    t.equal(result, null, 'returns null when base is invalid');
  });
});

describe('URL protocol setter — special to non-special scheme', () => {
  it('protocol setter from http to data: — documents current behavior', (t) => {
    const u = new URL('http://example.com/');
    // Spec says switching from special to non-special is a no-op
    // Test what this implementation actually does
    const before = u.protocol;
    u.protocol = 'data';
    // Document current behavior (may or may not change):
    t.ok(typeof u.protocol === 'string', 'protocol is still a string after setter');
    t.ok(u.href.length > 0, 'href is still valid after setter');
  });
});

describe('URL credentials with special characters', () => {
  it('username with @ character is percent-encoded', (t) => {
    const u = new URL('http://example.com/');
    u.username = 'us@er';
    // @ in username must be percent-encoded
    t.ok(!u.href.includes('us@er'), 'raw @ not in href');
    t.equal(u.username, 'us%40er', 'username percent-encodes @');
  });

  it('password with : character is percent-encoded', (t) => {
    const u = new URL('http://example.com/');
    u.password = 'pa:ss';
    // The implementation percent-encodes : in passwords
    t.equal(u.password, 'pa%3Ass', 'password percent-encodes colon');
  });
});

describe('URLSearchParams additional', () => {
  it('empty values — ?a=&b= → get returns empty string', (t) => {
    const p = new URLSearchParams('a=&b=');
    t.equal(p.get('a'), '');
    t.equal(p.get('b'), '');
  });

  it('keys without = sign — ?a&b → get returns empty string', (t) => {
    const p = new URLSearchParams('a&b');
    t.equal(p.get('a'), '');
    t.equal(p.get('b'), '');
  });

  it('forEach with thisArg', (t) => {
    const p = new URLSearchParams('x=1&y=2');
    const ctx = { results: [] as string[] };
    p.forEach(function(this: typeof ctx, value, name) {
      this.results.push(name + '=' + value);
    }, ctx);
    t.deepEqual(ctx.results, ['x=1', 'y=2']);
  });

  it('delete then has returns false', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    p.delete('a');
    t.equal(p.has('a'), false);
    t.equal(p.has('b'), true);
  });

  it('URLSearchParams [Symbol.toStringTag] is "URLSearchParams"', (t) => {
    const p = new URLSearchParams();
    t.equal((p as unknown as SymbolRecord)[Symbol.toStringTag], 'URLSearchParams');
  });
});

describe('URLSearchParams two-arg delete and has', () => {
  it('delete(name, value) removes only matching name+value pair', (t) => {
    const p = new URLSearchParams('a=1&a=2&a=3');
    p.delete('a', '2');
    t.deepEqual(p.getAll('a'), ['1', '3'], 'only a=2 was removed');
  });

  it('delete(name, value) is a no-op when value does not match', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    p.delete('a', '99');
    t.deepEqual(p.getAll('a'), ['1'], 'a=1 still present');
  });

  it('delete(name) without value removes all matching names', (t) => {
    const p = new URLSearchParams('a=1&a=2&b=3');
    p.delete('a');
    t.deepEqual(p.getAll('a'), [], 'all a removed');
    t.equal(p.get('b'), '3', 'b unaffected');
  });

  it('has(name, value) returns true only when both name and value match', (t) => {
    const p = new URLSearchParams('a=1&a=2&b=3');
    t.equal(p.has('a', '1'), true, 'has a=1');
    t.equal(p.has('a', '2'), true, 'has a=2');
    t.equal(p.has('a', '99'), false, 'no a=99');
    t.equal(p.has('b', '3'), true, 'has b=3');
    t.equal(p.has('b', '4'), false, 'no b=4');
  });

  it('has(name) without value checks only name', (t) => {
    const p = new URLSearchParams('a=1');
    t.equal(p.has('a'), true, 'has a');
    t.equal(p.has('b'), false, 'no b');
  });
});

describe('URLSearchParams — consecutive ampersands', () => {
  it('consecutive && produces empty-string entry', (t) => {
    // Per WHATWG spec, 'a=1&&b=2' produces 3 entries, the middle being ["",""]
    const p = new URLSearchParams('a=1&&b=2');
    t.equal(p.getAll('a').length, 1, 'a has one entry');
    t.equal(p.get(''), '', 'empty key has empty value');
    t.equal(p.get('b'), '2', 'b=2 is present');
    const entries = [...p.entries()];
    t.equal(entries.length, 3, 'three entries total');
    t.deepEqual(entries[1], ['', ''], 'middle entry is ["",""]');
  });

  it('leading & produces empty-string entry at start', (t) => {
    const p = new URLSearchParams('&a=1');
    const entries = [...p.entries()];
    t.equal(entries.length, 2, 'two entries');
    t.deepEqual(entries[0], ['', ''], 'first entry is ["",""]');
    t.deepEqual(entries[1], ['a', '1'], 'second entry is a=1');
  });
});

describe('URL pathname setter — dot-segment normalization', () => {
  it('pathname setter resolves single dot', (t) => {
    const u = new URL('http://example.com/a/b/c');
    u.pathname = '/a/./b';
    t.equal(u.pathname, '/a/b', '. segment resolved');
  });

  it('pathname setter resolves double dot', (t) => {
    const u = new URL('http://example.com/a/b/c');
    u.pathname = '/a/b/../c';
    t.equal(u.pathname, '/a/c', '.. segment resolved');
  });
});

describe('URL protocol setter — special to non-special switching', () => {
  it('switching http to data: is a no-op', (t) => {
    const u = new URL('http://example.com/');
    u.protocol = 'data';
    t.equal(u.protocol, 'http:', 'protocol unchanged — cannot switch special to non-special');
  });

  it('switching between special schemes is allowed', (t) => {
    const u = new URL('http://example.com/');
    u.protocol = 'https';
    t.equal(u.protocol, 'https:', 'http → https is allowed');
  });

  it('non-special URL: switching to another non-special scheme is allowed', (t) => {
    const u = new URL('custom://example.com/');
    u.protocol = 'other';
    t.equal(u.protocol, 'other:', 'non-special → non-special is allowed');
  });
});

describe('URL hostname setter forbidden chars', () => {
  it('hostname setter ignores values containing #', (t) => {
    const u = new URL('http://example.com/');
    u.hostname = 'other#host';
    t.equal(u.hostname, 'example.com', 'hostname unchanged when # present');
  });

  it('hostname setter ignores values containing ?', (t) => {
    const u = new URL('http://example.com/');
    u.hostname = 'other?host';
    t.equal(u.hostname, 'example.com', 'hostname unchanged when ? present');
  });

  it('hostname setter ignores values containing /', (t) => {
    const u = new URL('http://example.com/');
    u.hostname = 'other/host';
    t.equal(u.hostname, 'example.com', 'hostname unchanged when / present');
  });

  it('hostname setter allows normal hostnames', (t) => {
    const u = new URL('http://example.com/');
    u.hostname = 'newhost.com';
    t.equal(u.hostname, 'newhost.com', 'valid hostname accepted');
  });
});

describe('URL path percent-encoding of < and >', () => {
  it('< in pathname is percent-encoded', (t) => {
    const u = new URL('http://example.com/');
    u.pathname = '/fo<o>';
    t.ok(!u.pathname.includes('<'), '< is percent-encoded in pathname');
    t.ok(!u.pathname.includes('>'), '> is percent-encoded in pathname');
    t.ok(u.pathname.includes('%3C') || u.pathname.includes('%3c'), '< encoded as %3C');
    t.ok(u.pathname.includes('%3E') || u.pathname.includes('%3e'), '> encoded as %3E');
  });

  it('< and > in URL constructor are percent-encoded in pathname', (t) => {
    // Construct by setting individual parts
    const u = new URL('http://example.com/a<b>c');
    t.ok(!u.pathname.includes('<'), '< percent-encoded');
    t.ok(!u.pathname.includes('>'), '> percent-encoded');
  });
});

describe('URL — C0 controls stripped from input', () => {
  it('leading/trailing C0 controls are stripped before parsing', (t) => {
    const u = new URL('\x00http://example.com/');
    t.equal(u.hostname, 'example.com', 'leading NUL stripped');
  });

  it('tab characters are stripped from input', (t) => {
    const u = new URL('http://exa\x09mple.com/');
    t.equal(u.hostname, 'example.com', 'embedded tab stripped');
  });

  it('newlines are stripped from input', (t) => {
    const u = new URL('http://exa\nmple.com/');
    t.equal(u.hostname, 'example.com', 'embedded newline stripped');
  });
});
