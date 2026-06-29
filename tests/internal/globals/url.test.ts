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
    const p = new URLSearchParams({
      foo: 'bar',
      num: '42'
    });
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
  it('constructs from iterable objects', (t) => {
    const form = new FormData();
    form.append('a', 'b');
    const p = new URLSearchParams(form as any);
    t.equal(p.get('a'), 'b');
    const source = new URLSearchParams();
    (source as any)[Symbol.iterator] = function* customURLSearchParamsIterator() {
      yield ['custom', 'value'];
    };
    const copy = new URLSearchParams(source);
    t.equal(copy.get('custom'), 'value');
  });
  it('requires constructor sequence entries to contain exactly two items', (t) => {
    t.throws(() => new URLSearchParams([[1] as any]), TypeError);
    t.throws(() => new URLSearchParams([[
      1,
      2,
      3
    ] as any]), TypeError);
  });
  it('record constructor uses USVString keys and overwrites duplicate converted names', (t) => {
    const params = new URLSearchParams({
      '\ud835x': '1',
      xx: '2',
      '\ud83dx': '3'
    } as any);
    const entries = [...params.entries()];
    t.deepEqual(entries[0], ['�x', '3']);
    t.deepEqual(entries[1], ['xx', '2']);
    t.equal(entries.length, 2);
  });
  it('constructs from DOMException legacy constants', (t) => {
    const params = new URLSearchParams(DOMException as any);
    t.equal(params.get('INDEX_SIZE_ERR'), '1');
    t.equal(params.get('DATA_CLONE_ERR'), '25');
    t.throws(() => new URLSearchParams(DOMException.prototype as any), TypeError);
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
    t.deepEqual([...p.keys()], [
      'a',
      'b',
      'c'
    ]);
  });
  it('toString encodes spaces as +', (t) => {
    const p = new URLSearchParams({ q: 'hello world' });
    t.equal(p.toString(), 'q=hello+world');
  });
  it('decodes + as space', (t) => {
    const p = new URLSearchParams('q=hello+world');
    t.equal(p.get('q'), 'hello world');
  });
  it('decodes percent bytes with UTF-8 replacement', (t) => {
    t.equal(new URLSearchParams('%C2').get('�'), '');
    t.equal(new URLSearchParams('%C2x').get('�x'), '');
    t.equal(new URLSearchParams('b=%2sf%2a').get('b'), '%2sf*');
  });
  it('percent encoding round-trip', (t) => {
    const p = new URLSearchParams({ emoji: 'café' });
    const p2 = new URLSearchParams(p.toString());
    t.equal(p2.get('emoji'), 'café');
  });
  it('toString percent-encodes surrogate pairs as UTF-8', (t) => {
    const p = new URLSearchParams();
    p.append('a', 'b💩c');
    t.equal(p.toString(), 'a=b%F0%9F%92%A9c');
    p.delete('a');
    p.append('a💩b', 'c');
    t.equal(p.toString(), 'a%F0%9F%92%A9b=c');
  });
  it('sort syncs emoji search params back to URL', (t) => {
    const url = new URL('?a🌈&a💩', 'https://example.test/');
    url.searchParams.sort();
    t.deepEqual([...url.searchParams], [['a🌈', ''], ['a💩', '']]);
    t.equal(url.search, '?a%F0%9F%8C%88=&a%F0%9F%92%A9=');
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
    t.deepEqual([...p.keys()], ['x', 'y']);
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
    t.equal(u.protocol, 'http:');
    t.equal(u.hostname, 'example.com');
    t.equal(u.port, '');
    t.equal(u.pathname, '/path');
    t.equal(u.search, '?q=1');
    t.equal(u.hash, '#frag');
    t.equal(u.origin, 'http://example.com');
  });
  it('https with explicit port', (t) => {
    const u = new URL('https://example.com:8443/api');
    t.equal(u.protocol, 'https:');
    t.equal(u.hostname, 'example.com');
    t.equal(u.port, '8443');
    t.equal(u.origin, 'https://example.com:8443');
  });
  it('default ports are stripped', (t) => {
    t.equal(new URL('http://example.com:80/').port, '');
    t.equal(new URL('https://example.com:443/').port, '');
    t.equal(new URL('ws://example.com:80/').port, '');
    t.equal(new URL('wss://example.com:443/').port, '');
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
  it('throws on non-numeric parse-time ports', (t) => {
    t.throws(() => new URL('https://test:test/'), TypeError);
  });
});
describe('Blob object URLs', () => {
  it('createObjectURL returns unique blob: URLs with the current origin', (t) => {
    const previousLocation = (globalThis as any).location;
    (globalThis as any).location = new URL('https://example.test/path');
    const first = URL.createObjectURL(new Blob(['a']));
    const second = URL.createObjectURL(new Blob(['b']));
    try {
      t.notEqual(first, second, 'object URLs are unique');
      t.ok(first.startsWith('blob:https://example.test/'), 'blob URL embeds current origin');
      const parsed = new URL(first);
      t.equal(parsed.protocol, 'blob:');
      t.equal(parsed.origin, 'https://example.test');
      t.equal(parsed.host, '');
      t.ok(/\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.pathname), 'path ends with UUID');
    } finally {
      URL.revokeObjectURL(first);
      URL.revokeObjectURL(second);
      (globalThis as any).location = previousLocation;
    }
  });
  it('revokeObjectURL accepts unknown URLs without throwing', (t) => {
    URL.revokeObjectURL('blob:https://example.test/not-present');
    t.ok(true, 'unknown blob URL revocation is a no-op');
  });
  it('createObjectURL rejects non-Blob values', (t) => {
    t.throws(() => URL.createObjectURL('not a blob' as any), TypeError);
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
  it('URL constructor stringifies URL object arguments', (t) => {
    const input = new URL('http://example.com/a/');
    input.toString = () => {
      throw 1;
    };
    t.throws(() => new URL(input), (err) => err === 1, 'input URL toString error propagates');
    const base = new URL('http://example.com/a/');
    base.toString = () => {
      throw 2;
    };
    t.throws(() => new URL('b', base), (err) => err === 2, 'base URL toString error propagates');
  });
  it('URL constructor treats an undefined base as omitted', (t) => {
    t.equal(new URL('aaa:b', undefined).href, 'aaa:b');
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
  it('URL setters strip ASCII tab and newline before parsing', (t) => {
    const u = new URL('https://host:8000/path?query#hash');
    u.protocol = '\nhttp';
    t.equal(u.protocol, 'http:');
    u.host = 'te	st:9000';
    t.equal(u.host, 'test:9000');
    u.pathname = 'te\rst';
    t.equal(u.pathname, '/test');
    u.search = 'te\nst';
    t.equal(u.search, '?test');
    u.hash = 'te	st';
    t.equal(u.hash, '#test');
  });
  it('port setter consumes leading digits before invalid controls', (t) => {
    const u = new URL('https://host:8000/');
    u.port = '90\0' + '00';
    t.equal(u.port, '90');
    u.port = '\0' + '9000';
    t.equal(u.port, '90');
    u.port = '9000\0';
    t.equal(u.port, '9000');
  });
  it('host setters reject or encode C0 controls by scheme', (t) => {
    const special = new URL('https://host:8000/');
    special.host = '\0test';
    t.equal(special.host, 'host:8000');
    special.hostname = 'test';
    t.equal(special.hostname, 'host');
    const nonSpecial = new URL('wpt++://host:8000/');
    nonSpecial.host = 'test';
    t.equal(nonSpecial.host, 'te%1Fst:8000');
    nonSpecial.hostname = 'test';
    t.equal(nonSpecial.hostname, '%1Ftest');
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
  it('URL searchParams preserves query data that starts with ?', (t) => {
    const u = new URL('http://example.com/file??a=b&c=d');
    t.equal(u.search, '??a=b&c=d');
    t.equal(u.searchParams.toString(), '%3Fa=b&c=d');
    u.href = 'http://example.com/file??a=b';
    t.equal(u.search, '??a=b');
    t.equal(u.searchParams.toString(), '%3Fa=b');
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
  it('URL.canParse treats an undefined base as omitted', (t) => {
    t.equal(URL.canParse('https://test:test', undefined), false);
    t.equal(URL.canParse(undefined as any, 'https://test:test/'), false);
    t.equal(URL.canParse('aaa:b', undefined), true);
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
  it('URL.parse treats an undefined base as omitted', (t) => {
    t.equal(URL.parse('https://test:test', undefined), null);
    t.equal(URL.parse('aaa:b', undefined)?.href, 'aaa:b');
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
    t.equal(((u as unknown) as SymbolRecord)[Symbol.toStringTag], 'URL');
  });
});
describe('URLSearchParams.delete — two-argument form', () => {
  it('delete(name, value) removes only the matching name+value pair', (t) => {
    const p = new URLSearchParams('a=1&a=2&b=3');
    p.delete('a', '1');
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
    t.equal(((p as unknown) as SymbolRecord)[Symbol.toStringTag], 'URLSearchParams');
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
  it('consecutive && skips empty entries', (t) => {
    const p = new URLSearchParams('a=1&&b=2');
    t.equal(p.getAll('a').length, 1, 'a has one entry');
    t.equal(p.has(''), false, 'empty field is skipped');
    t.equal(p.get('b'), '2', 'b=2 is present');
    const entries = [...p.entries()];
    t.equal(entries.length, 2, 'two entries total');
    t.deepEqual(entries[1], ['b', '2'], 'second entry is b=2');
  });
  it('leading & skips the empty entry', (t) => {
    const p = new URLSearchParams('&a=1');
    const entries = [...p.entries()];
    t.equal(entries.length, 1, 'one entry');
    t.deepEqual(entries[0], ['a', '1'], 'first entry is a=1');
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
    const u = new URL('\0http://example.com/');
    t.equal(u.hostname, 'example.com', 'leading NUL stripped');
  });
  it('tab characters are stripped from input', (t) => {
    const u = new URL('http://exa	mple.com/');
    t.equal(u.hostname, 'example.com', 'embedded tab stripped');
  });
  it('newlines are stripped from input', (t) => {
    const u = new URL('http://exa\nmple.com/');
    t.equal(u.hostname, 'example.com', 'embedded newline stripped');
  });
});
describe('URL release corpus', () => {
  it('IDNA hostnames are serialized as punycode', (t) => {
    const u = new URL('https://café.example/über');
    t.equal(u.hostname, 'xn--caf-dma.example', 'unicode hostname is punycoded');
    t.equal(u.href, 'https://xn--caf-dma.example/%C3%BCber', 'unicode path is percent-encoded');
  });
  it('IPv6 addresses are normalized and keep brackets in host-facing properties', (t) => {
    const u = new URL('http://[0000:0000:0000:0000:0000:0000:0000:0001]:8080/');
    t.equal(u.hostname, '[::1]', 'IPv6 hostname is compressed');
    t.equal(u.host, '[::1]:8080', 'host includes brackets and port');
    t.equal(u.origin, 'http://[::1]:8080', 'origin uses normalized IPv6');
  });
  it('special and non-special schemes preserve different path shapes', (t) => {
    const special = new URL('http://example.com//a///b');
    const nonspecial = new URL('custom:opaque/path');
    t.equal(special.pathname, '//a///b', 'special scheme keeps leading path slashes after authority');
    t.equal(special.origin, 'http://example.com', 'special scheme has tuple origin');
    t.equal(nonspecial.pathname, 'opaque/path', 'non-special scheme has opaque path without inserted slash');
    t.equal(nonspecial.origin, 'null', 'non-special scheme has null origin');
  });
  it('opaque paths preserve dot segments while slash paths normalize them', (t) => {
    const opaque = new URL('custom:opaque/./x/../y');
    const slashPath = new URL('custom:/a/./b/../c');
    const special = new URL('https://example.com/a/./b/../c');
    t.equal(opaque.pathname, 'opaque/./x/../y', 'opaque non-special path preserves dot segments');
    t.equal(slashPath.pathname, '/a/c', 'non-special slash path normalizes dot segments');
    t.equal(special.pathname, '/a/c', 'special path normalizes dot segments');
  });
  it('opaque path query removal preserves trailing-space encoding boundary', (t) => {
    const url = new URL('data:space    ?test');
    url.searchParams.delete('test');
    t.equal(url.search, '');
    t.equal(url.pathname, 'space   %20');
    t.equal(url.href, 'data:space   %20');
  });
  it('relative resolution rejects opaque bases and resolves non-special slash bases', (t) => {
    t.throws(() => new URL('child', 'custom:opaque/path'), null, 'relative path cannot resolve against opaque base');
    t.equal(new URL('child', 'custom:/base/path').href, 'custom:/base/child', 'relative path resolves against slash-path non-special base');
  });
  it('file URL host and path edge cases follow file-origin serialization', (t) => {
    const local = new URL('file://localhost/etc/hosts');
    const unc = new URL('file://server/share/file.txt');
    const drive = new URL('file:///C:/path/..//file.txt');
    t.equal(local.href, 'file:///etc/hosts', 'localhost file host serializes away');
    t.equal(local.host, '', 'localhost file host becomes empty');
    t.equal(local.origin, 'null', 'file URLs have null origin');
    t.equal(unc.host, 'server', 'non-local file host is preserved');
    t.equal(unc.pathname, '/share/file.txt', 'non-local file path is preserved');
    t.equal(drive.pathname, '/C://file.txt', 'file URL drive path normalizes dot segments');
  });
  it('numeric IPv4 forms normalize to dotted decimal for special URLs', (t) => {
    t.equal(new URL('http://127.1/').hostname, '127.0.0.1', 'short IPv4 form expands missing pieces');
    t.equal(new URL('http://0177.0.0.1/').hostname, '127.0.0.1', 'octal IPv4 form normalizes');
    t.equal(new URL('http://0x7f.1/').hostname, '127.0.0.1', 'hex IPv4 form normalizes');
    t.equal(new URL('http://2130706433/').hostname, '127.0.0.1', 'single-number IPv4 form normalizes');
  });
  it('percent-encodes credentials, path, search, and hash through setters', (t) => {
    const u = new URL('https://example.com/');
    u.username = 'u@ser';
    u.password = 'p:ss';
    u.pathname = '/a b/<tag>';
    u.searchParams.set('q', 'a b&c');
    u.hash = 'frag ment';
    t.equal(u.username, 'u%40ser', 'username encodes @');
    t.equal(u.password, 'p%3Ass', 'password encodes colon');
    t.equal(u.pathname, '/a%20b/%3Ctag%3E', 'pathname encodes space and angle brackets');
    t.equal(u.search, '?q=a+b%26c', 'search params encode space as plus and ampersand as percent');
    t.equal(u.hash, '#frag%20ment', 'hash encodes space');
  });
  it('relative resolution handles empty, current-directory, parent, query, and hash inputs', (t) => {
    const base = 'https://example.com/a/b/c?old=1#old';
    t.equal(new URL('', base).href, 'https://example.com/a/b/c?old=1#old', 'empty relative preserves base href');
    t.equal(new URL('./d', base).href, 'https://example.com/a/b/d', './ resolves against containing directory');
    t.equal(new URL('../../d', base).href, 'https://example.com/d', '../ segments cannot climb above root');
    t.equal(new URL('?new=1', base).href, 'https://example.com/a/b/c?new=1', 'query-only relative replaces query and clears hash');
    t.equal(new URL('#new', base).href, 'https://example.com/a/b/c?old=1#new', 'hash-only relative preserves query');
  });
});
describe('URLSearchParams mutation and iteration corpus', () => {
  it('iteration observes appends made during traversal', (t) => {
    const p = new URLSearchParams('a=1&b=2');
    const seen: string[] = [];
    for (const [name, value] of p) {
      seen.push(name + '=' + value);
      if (name === 'a') p.append('c', '3');
    }
    t.deepEqual(seen, [
      'a=1',
      'b=2',
      'c=3'
    ], 'iterator sees appended pairs');
  });
  it('iterator observes URL search replacement without rewinding', (t) => {
    const url = new URL('http://a.test/path?a=1&b=2&c=3&d=4');
    const seen: [string, string][] = [];
    for (const entry of url.searchParams) {
      url.search = 'x=1&y=2&z=3';
      seen.push(entry);
    }
    t.deepEqual(seen[0], ['a', '1']);
    t.deepEqual(seen[1], ['y', '2']);
    t.deepEqual(seen[2], ['z', '3']);
    t.equal(seen.length, 3);
  });
  it('iterator skips entries deleted before their turn', (t) => {
    const params = new URLSearchParams('param0=0&param1=1&param2=2');
    const seen: [string, string][] = [];
    for (const entry of params) {
      if (entry[0] === 'param0') params.delete('param1');
      seen.push(entry);
    }
    t.deepEqual(seen[0], ['param0', '0']);
    t.deepEqual(seen[1], ['param2', '2']);
    t.equal(seen.length, 2);
  });
  it('deleting current entry during iteration advances over shifted entry', (t) => {
    const params = new URLSearchParams('param0=0&param1=1&param2=2');
    const seen: [string, string][] = [];
    for (const entry of params) {
      if (entry[0] === 'param0') params.delete('param0');
      else seen.push(entry);
    }
    t.deepEqual(seen[0], ['param2', '2']);
    t.equal(seen.length, 1);
  });
  it('set keeps the first position and removes later duplicates', (t) => {
    const p = new URLSearchParams('b=2&a=1&b=3&c=4');
    p.set('b', '9');
    t.deepEqual([...p.entries()], [
      ['b', '9'],
      ['a', '1'],
      ['c', '4']
    ], 'set preserves first matching position');
  });
  it('sort is stable for duplicate names', (t) => {
    const p = new URLSearchParams('b=1&a=first&b=2&a=second');
    p.sort();
    t.deepEqual([...p.entries()], [
      ['a', 'first'],
      ['a', 'second'],
      ['b', '1'],
      ['b', '2']
    ], 'sort keeps duplicate value order');
  });
});
