/**
* Tests for encoding globals:
* TextEncoder, TextDecoder, btoa, atob, structuredClone.
*/
import { describe, it } from 'fino:test/test';
const { TextEncoder, TextDecoder, atob, btoa, structuredClone } = globalThis;
function isDataCloneError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DataCloneError';
}
// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------
describe('TextEncoder', () => {
  it('encoding property is "utf-8"', (t) => {
    const enc = new TextEncoder();
    t.equal(enc.encoding, 'utf-8');
  });
  it('[Symbol.toStringTag] is "TextEncoder"', (t) => {
    t.equal(((new TextEncoder() as unknown) as Record<symbol, unknown>)[Symbol.toStringTag], 'TextEncoder');
  });
  it('encode() with no argument returns empty Uint8Array', (t) => {
    const buf = new TextEncoder().encode();
    t.ok(buf instanceof Uint8Array, 'is Uint8Array');
    t.equal(buf.byteLength, 0, 'empty');
  });
  it('encode() ASCII string', (t) => {
    const buf = new TextEncoder().encode('ABC');
    t.equal(buf[0], 65);
    t.equal(buf[1], 66);
    t.equal(buf[2], 67);
    t.equal(buf.byteLength, 3);
  });
  it('encode() multi-byte UTF-8', (t) => {
    const buf = new TextEncoder().encode('é');
    t.equal(buf.byteLength, 2);
    t.equal(buf[0], 195);
    t.equal(buf[1], 169);
  });
  it('encode() emoji (4-byte)', (t) => {
    const buf = new TextEncoder().encode('🚀');
    t.equal(buf.byteLength, 4);
    t.equal(buf[0], 240);
  });
  it('encodeInto() fills destination buffer', (t) => {
    const enc = new TextEncoder();
    const dest = new Uint8Array(10);
    const result = enc.encodeInto('hello', dest);
    t.equal(result.read, 5, 'read 5 chars');
    t.equal(result.written, 5, 'wrote 5 bytes');
    t.equal(dest[0], 104);
    t.equal(dest[4], 111);
  });
  it('encodeInto() stops when buffer full', (t) => {
    const enc = new TextEncoder();
    const dest = new Uint8Array(3);
    const result = enc.encodeInto('hello', dest);
    t.equal(result.written, 3, 'wrote 3 bytes');
    t.equal(result.read, 3, 'read 3 chars');
  });
  it('encodeInto() handles multi-byte characters', (t) => {
    const enc = new TextEncoder();
    const dest = new Uint8Array(10);
    const result = enc.encodeInto('éàü', dest);
    t.equal(result.written, 6, 'wrote 6 bytes (3 × 2-byte chars)');
    t.equal(result.read, 3, 'read 3 code points');
  });
  it('encodeInto() requires a Uint8Array destination', (t) => {
    const enc = new TextEncoder();
    t.throws(() => enc.encodeInto('', (new Int8Array(1) as unknown) as Uint8Array), undefined, 'Int8Array rejected');
    t.throws(() => enc.encodeInto('', (new Uint8ClampedArray(1) as unknown) as Uint8Array), undefined, 'Uint8ClampedArray rejected');
    t.throws(() => enc.encodeInto('', (new DataView(new ArrayBuffer(1)) as unknown) as Uint8Array), undefined, 'DataView rejected');
    t.throws(() => enc.encodeInto('', (new ArrayBuffer(1) as unknown) as Uint8Array), undefined, 'ArrayBuffer rejected');
  });
});
// ---------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------
describe('TextDecoder', () => {
  it('[Symbol.toStringTag] is "TextDecoder"', (t) => {
    t.equal(((new TextDecoder() as unknown) as Record<symbol, unknown>)[Symbol.toStringTag], 'TextDecoder');
  });
  it('encoding property exposes the normalized decoder label', (t) => {
    t.equal(new TextDecoder().encoding, 'utf-8');
    t.equal(new TextDecoder('utf-8').encoding, 'utf-8');
    t.equal(new TextDecoder('UTF-8').encoding, 'utf-8');
    t.equal(new TextDecoder('utf-16').encoding, 'utf-16le');
    t.equal(new TextDecoder('UTF-16LE').encoding, 'utf-16le');
    t.equal(new TextDecoder('UTF-16BE').encoding, 'utf-16be');
  });
  it('fatal property', (t) => {
    t.equal(new TextDecoder().fatal, false, 'default false');
    t.equal(new TextDecoder('utf-8', { fatal: true }).fatal, true);
  });
  it('ignoreBOM property', (t) => {
    t.equal(new TextDecoder().ignoreBOM, false, 'default false');
    t.equal(new TextDecoder('utf-8', { ignoreBOM: true }).ignoreBOM, true);
  });
  it('decode() with no argument returns empty string', (t) => {
    t.equal(new TextDecoder().decode(), '');
    t.equal(new TextDecoder().decode(undefined), '');
  });
  it('decode() ASCII bytes', (t) => {
    const bytes = new Uint8Array([
      72,
      101,
      108,
      108,
      111
    ]);
    t.equal(new TextDecoder().decode(bytes), 'Hello');
  });
  it('decode() multi-byte UTF-8', (t) => {
    // 'é' is 0xC3 0xA9
    const bytes = new Uint8Array([195, 169]);
    t.equal(new TextDecoder().decode(bytes), 'é');
  });
  it('decode() UTF-16 little and big endian samples', (t) => {
    const sample = 'z¢水𝄞􏿽￾';
    const le = new Uint8Array([
      122,
      0,
      162,
      0,
      52,
      108,
      52,
      216,
      30,
      221,
      255,
      248,
      255,
      219,
      253,
      223,
      254,
      255
    ]);
    const be = new Uint8Array([
      0,
      122,
      0,
      162,
      108,
      52,
      216,
      52,
      221,
      30,
      248,
      255,
      219,
      255,
      223,
      253,
      255,
      254
    ]);
    t.equal(new TextDecoder('utf-16le').decode(le), sample);
    t.equal(new TextDecoder('utf-16be').decode(be), sample);
    t.equal(new TextDecoder('utf-16').decode(le), sample);
  });
  it('decode() from ArrayBuffer', (t) => {
    const buf = new Uint8Array([
      65,
      66,
      67
    ]).buffer;
    t.equal(new TextDecoder().decode(buf), 'ABC');
  });
  it('decode() strips UTF-8 BOM by default', (t) => {
    const bom = new Uint8Array([
      239,
      187,
      191,
      72,
      101,
      108,
      108,
      111
    ]);
    t.equal(new TextDecoder().decode(bom), 'Hello', 'BOM stripped');
  });
  it('decode() preserves BOM with ignoreBOM: true', (t) => {
    const bom = new Uint8Array([
      239,
      187,
      191,
      65
    ]);
    const dec = new TextDecoder('utf-8', { ignoreBOM: true });
    t.equal(dec.decode(bom), '﻿А'.replace('А', 'A'), 'BOM preserved');
    // Use explicit check:
    const result = dec.decode(bom);
    t.equal(result.charCodeAt(0), 65279, 'first char is BOM');
    t.equal(result[1], 'A');
  });
  it('invalid UTF-8 in non-fatal mode uses replacement char', (t) => {
    const invalid = new Uint8Array([255, 254]);
    const result = new TextDecoder().decode(invalid);
    t.ok(result.includes('�'), 'contains replacement char');
  });
  it('invalid UTF-8 in fatal mode throws', (t) => {
    const dec = new TextDecoder('utf-8', { fatal: true });
    const invalid = new Uint8Array([255]);
    t.throws(() => dec.decode(invalid), undefined, 'throws on invalid UTF-8');
  });
  it('decode() with stream: true merges across calls', (t) => {
    const dec = new TextDecoder();
    // 'é' split across two chunks: [0xC3] then [0xA9]
    const part1 = new Uint8Array([195]);
    const part2 = new Uint8Array([169]);
    const s1 = dec.decode(part1, { stream: true });
    const s2 = dec.decode(part2);
    t.equal(s1 + s2, 'é', 'multi-byte char split across chunks');
  });
  it('streaming UTF-8 emits invalid leading bytes immediately', (t) => {
    const dec = new TextDecoder();
    t.equal(dec.decode(new Uint8Array([193]), { stream: true }), '�');
    t.equal(dec.decode(), '');
    t.equal(dec.decode(new Uint8Array([224, 128]), { stream: true }), '��');
    t.equal(dec.decode(new Uint8Array([128])), '�');
    t.equal(dec.decode(new Uint8Array([
      240,
      144,
      65
    ]), { stream: true }), '�A');
    t.equal(dec.decode(new Uint8Array([66])), 'B');
    t.equal(dec.decode(new Uint8Array([
      240,
      159,
      146
    ]), { stream: true }), '');
    t.equal(dec.decode(new Uint8Array([169])), '💩');
  });
  it('streaming UTF-16 preserves split bytes and surrogate pairs', (t) => {
    const le = new TextDecoder('utf-16le');
    t.equal(le.decode(new Uint8Array([65]), { stream: true }), '');
    t.equal(le.decode(new Uint8Array([0])), 'A');
    t.equal(le.decode(new Uint8Array([0, 216]), { stream: true }), '');
    t.equal(le.decode(new Uint8Array([0, 220])), '𐀀');
    const be = new TextDecoder('utf-16be');
    t.equal(be.decode(new Uint8Array([0]), { stream: true }), '');
    t.equal(be.decode(new Uint8Array([65])), 'A');
    t.equal(be.decode(new Uint8Array([216, 0]), { stream: true }), '');
    t.equal(be.decode(new Uint8Array([220, 0])), '𐀀');
  });
  it('UTF-16 truncation and fatal UTF-8 stream state follow replacement rules', (t) => {
    t.equal(new TextDecoder('utf-16le').decode(new Uint8Array([
      0,
      216,
      0
    ])), '�');
    t.equal(new TextDecoder('utf-16be').decode(new Uint8Array([
      216,
      0,
      216
    ])), '�');
    const fatal = new TextDecoder('utf-8', { fatal: true });
    t.throws(() => fatal.decode(new Uint8Array([253, 239]), { stream: true }));
    t.equal(fatal.decode(), '');
  });
  it('streaming BOM: only stripped from first non-empty chunk', (t) => {
    // Non-streaming: BOM stripped on each independent call
    const dec = new TextDecoder();
    t.equal(dec.decode(new Uint8Array([
      239,
      187,
      191,
      65
    ])), 'A', 'BOM stripped in non-streaming call');
    t.equal(dec.decode(new Uint8Array([
      239,
      187,
      191,
      66
    ])), 'B', 'BOM stripped again on next non-streaming call');
    // Streaming: BOM only stripped from first non-empty chunk
    const dec2 = new TextDecoder();
    const r1 = dec2.decode(new Uint8Array([
      239,
      187,
      191,
      65
    ]), { stream: true });
    t.equal(r1, 'A', 'BOM stripped from first streaming chunk');
    // Second chunk contains BOM — should NOT be stripped
    const r2 = dec2.decode(new Uint8Array([
      239,
      187,
      191,
      66
    ]));
    t.equal(r2.charCodeAt(0), 65279, 'BOM preserved in second streaming chunk (not stripped again)');
    t.equal(r2[1], 'B', 'following char decoded correctly');
  });
});
// ---------------------------------------------------------------------------
// btoa / atob
// ---------------------------------------------------------------------------
describe('btoa', () => {
  it('encodes ASCII', (t) => {
    t.equal(btoa('Hello'), 'SGVsbG8=');
    t.equal(btoa(''), '');
    t.equal(btoa('a'), 'YQ==');
    t.equal(btoa('ab'), 'YWI=');
    t.equal(btoa('abc'), 'YWJj');
  });
  it('throws for non-Latin1 input', (t) => {
    t.throws(() => btoa('€'), undefined, 'throws for char > 255');
    t.throws(() => btoa('こ'), undefined, 'throws for char > 255');
  });
  it('handles all byte values', (t) => {
    // Build a string with all 256 byte values
    let all = '';
    for (let i = 0; i < 256; i++) all += String.fromCharCode(i);
    const encoded = btoa(all);
    t.ok(encoded.length > 0, 'produces non-empty output');
  });
});
describe('atob', () => {
  it('decodes standard base64', (t) => {
    t.equal(atob('SGVsbG8='), 'Hello');
    t.equal(atob(''), '');
    t.equal(atob('YQ=='), 'a');
    t.equal(atob('YWI='), 'ab');
    t.equal(atob('YWJj'), 'abc');
  });
  it('decodes unpadded base64 (length % 4 == 2)', (t) => {
    t.equal(atob('YQ'), 'a', 'no padding needed for 2-char group');
  });
  it('decodes unpadded base64 (length % 4 == 3)', (t) => {
    t.equal(atob('YWI'), 'ab', 'no padding needed for 3-char group');
  });
  it('strips ASCII whitespace', (t) => {
    t.equal(atob('SGVs bG8='), 'Hello', 'strips spaces');
    t.equal(atob('SGVs\nbG8='), 'Hello', 'strips newlines');
    t.equal(atob('SGVs	bG8='), 'Hello', 'strips tabs');
  });
  it('throws on invalid chars', (t) => {
    t.throws(() => atob('!!!!'), undefined, 'invalid chars');
  });
  it('throws on length % 4 == 1 (always invalid)', (t) => {
    t.throws(() => atob('a'), undefined, 'single char is invalid');
    t.throws(() => atob('abcda'), undefined, 'length 5 is invalid');
  });
  it('round-trips with btoa', (t) => {
    const s = 'Hello, World! \0ÿ«';
    t.equal(atob(btoa(s)), s);
  });
  it('throws when padding = appears at position 2 followed by non-=', (t) => {
    // 'AA=A' is invalid: = at position 2 must be paired with = at position 3
    t.throws(() => atob('AA=A'), undefined, '"AA=A" is invalid padding');
    t.throws(() => atob('A=AA'), undefined, '"A=AA" is invalid padding');
  });
});
// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------
describe('TextDecoder — invalid label', () => {
  it('TextDecoder with unsupported legacy labels throws RangeError', (t) => {
    t.throws(() => new TextDecoder('latin1'), undefined, 'latin1 throws RangeError');
    t.throws(() => new TextDecoder('windows-1252'), undefined, 'windows-1252 throws RangeError');
    t.throws(() => new TextDecoder('shift-jis'), undefined, 'shift-jis throws RangeError');
    t.throws(() => new TextDecoder('iso-8859-1'), undefined, 'iso-8859-1 throws RangeError');
  });
  it('TextDecoder accepts UTF-8 and UTF-16 aliases', (t) => {
    let threw = false;
    try {
      new TextDecoder('utf-8');
      new TextDecoder('UTF-8');
      new TextDecoder('utf8');
      new TextDecoder('unicode-1-1-utf-8');
      new TextDecoder('utf-16');
      new TextDecoder('utf-16le');
      new TextDecoder('utf-16be');
    } catch (_) {
      threw = true;
    }
    t.equal(threw, false, 'UTF-8 and UTF-16 aliases are accepted');
  });
  it('TextDecoder trims only ASCII whitespace around labels', (t) => {
    t.equal(new TextDecoder('	 utf-8 \r\n').encoding, 'utf-8');
    t.throws(() => new TextDecoder('\vutf-8'), undefined, 'vertical tab is not trimmed');
    t.throws(() => new TextDecoder('\xA0utf-8'), undefined, 'non-breaking space is not trimmed');
    t.throws(() => new TextDecoder('\u2028utf-8'), undefined, 'line separator is not trimmed');
    t.throws(() => new TextDecoder('utf-16le\u2029'), undefined, 'paragraph separator is not trimmed');
  });
});
describe('TextEncoder — lone surrogates', () => {
  it('encode() replaces lone high surrogate with U+FFFD replacement bytes', (t) => {
    const enc = new TextEncoder();
    // U+D800 is a lone high surrogate — should produce U+FFFD (EF BF BD)
    const buf = enc.encode('\ud800');
    t.equal(buf.byteLength, 3, 'lone surrogate replaced with 3-byte U+FFFD');
    t.equal(buf[0], 239, 'byte 0 = 0xEF');
    t.equal(buf[1], 191, 'byte 1 = 0xBF');
    t.equal(buf[2], 189, 'byte 2 = 0xBD');
  });
  it('encode() replaces lone low surrogate with U+FFFD', (t) => {
    const enc = new TextEncoder();
    const buf = enc.encode('\udc00');
    t.equal(buf.byteLength, 3, 'lone low surrogate replaced with 3-byte U+FFFD');
  });
});
describe('TextEncoder.encodeInto — small destination for multi-byte char', () => {
  it('encodeInto() does not write partial multi-byte char if dest too small', (t) => {
    const enc = new TextEncoder();
    // 'é' is 2 bytes; destination has only 1 byte
    const dest = new Uint8Array(1);
    const result = enc.encodeInto('é', dest);
    // Spec: should not write a partial sequence
    t.equal(result.written, 0, 'no bytes written when dest too small for first char');
    t.equal(result.read, 0, 'no chars read when dest too small for first char');
  });
});
describe('structuredClone', () => {
  it('clones primitives', (t) => {
    t.equal(structuredClone(42), 42, 'number');
    t.equal(structuredClone('hello'), 'hello', 'string');
    t.equal(structuredClone(true), true, 'boolean');
    t.equal(structuredClone(9007199254740993n), 9007199254740993n, 'bigint');
    t.equal(structuredClone(null), null, 'null');
    t.equal(structuredClone(undefined), undefined, 'undefined');
  });
  it('clones plain objects', (t) => {
    const src = {
      a: 1,
      b: { c: 2 }
    };
    const clone = structuredClone(src);
    t.deepEqual(clone, src, 'deep equal');
    t.ok(clone !== src, 'different reference');
    t.ok(clone.b !== src.b, 'nested object is new reference');
  });
  it('clones arrays', (t) => {
    const src = [
      1,
      'two',
      { three: 3 }
    ];
    const clone = structuredClone(src);
    t.deepEqual(clone, src);
    t.ok(clone !== src, 'different reference');
    t.ok(clone[2] !== src[2], 'nested object is new reference');
  });
  it('preserves sparse array holes', (t) => {
    const src = new Array(4);
    src[1] = 'one';
    src[3] = undefined;
    const clone = structuredClone(src);
    t.equal(clone.length, 4, 'length preserved');
    t.equal(0 in clone, false, 'hole at index 0 preserved');
    t.equal(1 in clone, true, 'present value preserved');
    t.equal(2 in clone, false, 'hole at index 2 preserved');
    t.equal(3 in clone, true, 'explicit undefined preserved');
  });
  it('clones Date', (t) => {
    const d = new Date(2024, 0, 15);
    const c = structuredClone(d);
    t.ok(c instanceof Date, 'is Date');
    t.equal(c.getTime(), d.getTime(), 'same time');
    t.ok(c !== d, 'different reference');
  });
  it('clones RegExp', (t) => {
    const r = /hello/gi;
    r.lastIndex = 3;
    const c = structuredClone(r);
    t.ok(c instanceof RegExp, 'is RegExp');
    t.equal(c.source, r.source);
    t.equal(c.flags, r.flags);
    t.equal(c.lastIndex, 0, 'RegExp lastIndex resets during clone');
  });
  it('clones Map', (t) => {
    const m = new Map([['a', 1], ['b', 2]]);
    const c = structuredClone(m);
    t.ok(c instanceof Map, 'is Map');
    t.equal(c.get('a'), 1);
    t.equal(c.get('b'), 2);
    t.ok(c !== m, 'different reference');
  });
  it('clones Map cycles', (t) => {
    const m = new Map<any, any>();
    m.set('self', m);
    const clone = structuredClone(m);
    t.ok(clone instanceof Map, 'is Map');
    t.equal(clone.get('self'), clone, 'map cycle points at clone');
  });
  it('clones Set', (t) => {
    const s = new Set([
      1,
      2,
      3
    ]);
    const c = structuredClone(s);
    t.ok(c instanceof Set, 'is Set');
    t.equal(c.has(1), true);
    t.equal(c.has(3), true);
    t.ok(c !== s, 'different reference');
  });
  it('clones Set cycles', (t) => {
    const s = new Set<any>();
    s.add(s);
    const clone = structuredClone(s);
    t.ok(clone instanceof Set, 'is Set');
    t.ok(clone.has(clone), 'set cycle points at clone');
  });
  it('clones ArrayBuffer', (t) => {
    const buf = new Uint8Array([
      1,
      2,
      3
    ]).buffer;
    const c = structuredClone(buf);
    t.ok(c instanceof ArrayBuffer, 'is ArrayBuffer');
    t.equal(c.byteLength, 3);
    t.ok(c !== buf, 'different reference');
  });
  it('clones TypedArrays', (t) => {
    const src = new Uint8Array([
      10,
      20,
      30
    ]);
    const c = structuredClone(src);
    t.ok(c instanceof Uint8Array, 'is Uint8Array');
    t.equal(c[0], 10);
    t.equal(c[2], 30);
    t.ok(c !== src, 'different reference');
    t.ok(c.buffer !== src.buffer, 'different backing buffer');
  });
  it('clones typed array views with byte offsets', (t) => {
    const buf = new ArrayBuffer(8);
    const full = new Uint8Array(buf);
    full.set([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8
    ]);
    const src = new Uint16Array(buf, 2, 2);
    const clone = structuredClone(src);
    t.ok(clone instanceof Uint16Array, 'is Uint16Array');
    t.equal(clone.byteOffset, src.byteOffset, 'byteOffset preserved');
    t.equal(clone.length, 2, 'length preserved');
    t.equal(clone[0], src[0], 'first offset value preserved');
    t.equal(clone[1], src[1], 'second offset value preserved');
    t.ok(clone.buffer !== src.buffer, 'backing buffer copied');
  });
  it('clones Error (message + name)', (t) => {
    const err = new TypeError('bad input');
    const c = structuredClone(err);
    t.ok(c instanceof Error, 'is Error');
    t.equal(c.message, err.message, 'same message');
    t.equal(c.name, err.name, 'same name');
    t.ok(c !== err, 'different reference');
  });
  it('handles circular references', (t) => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const c = structuredClone(obj);
    t.equal(c.a, 1);
    t.equal(c.self, c, 'circular ref is reproduced');
  });
  it('throws for non-cloneable types (functions)', (t) => {
    t.throws(() => structuredClone(() => {}), undefined, 'function not cloneable');
  });
  it('throws for non-cloneable types (Symbol)', (t) => {
    t.throws(() => structuredClone(Symbol('x')), undefined, 'Symbol not cloneable');
  });
  it('clones Error with .cause', (t) => {
    const cause = new Error('root cause');
    const err = new Error('outer error');
    (err as any).cause = cause;
    const clone = structuredClone(err);
    t.ok(clone instanceof Error, 'is Error');
    t.equal(clone.message, err.message, 'message cloned');
    t.ok((clone as any).cause instanceof Error, 'cause is also cloned as Error');
    t.equal((clone as any).cause.message, 'root cause', 'cause message matches');
    t.ok((clone as any).cause !== cause, 'cause is a new object (not same ref)');
  });
  it('clones Error with custom .name', (t) => {
    const err = new Error('custom error');
    err.name = 'CustomError';
    const clone = structuredClone(err);
    t.equal(clone.name, 'CustomError', 'custom name preserved');
    t.equal(clone.message, 'custom error', 'message preserved');
  });
  it('clones AggregateError errors, message, name, and cause', (t) => {
    const nested = new TypeError('nested failure');
    const cause = new Error('root cause');
    const err = new AggregateError([nested, { detail: 'bad input' }], 'many failures', { cause });
    err.name = 'CustomAggregateError';
    const clone = structuredClone(err);
    t.ok(clone instanceof AggregateError, 'is AggregateError');
    t.equal(clone.message, 'many failures', 'message preserved');
    t.equal(clone.name, 'CustomAggregateError', 'custom name preserved');
    t.ok((clone as any).cause instanceof Error, 'cause is cloned');
    t.equal((clone as any).cause.message, 'root cause', 'cause message preserved');
    t.ok((clone as any).cause !== cause, 'cause is a new object');
    t.equal(clone.errors.length, 2, 'errors length preserved');
    t.ok(clone.errors[0] instanceof TypeError, 'nested error cloned as TypeError');
    t.equal(clone.errors[0].message, 'nested failure', 'nested error message preserved');
    t.ok(clone.errors[0] !== nested, 'nested error is a new object');
    t.deepEqual(clone.errors[1], { detail: 'bad input' }, 'nested object cloned');
  });
  it('throws DataCloneError for URL and URLSearchParams', (t) => {
    t.throws(() => structuredClone(new URL('https://example.test/path?q=1#frag')), isDataCloneError, 'URL is not serializable');
    t.throws(() => structuredClone(new URLSearchParams('a=1&a=2&b=space+value')), isDataCloneError, 'URLSearchParams is not serializable');
  });
  it('clones DOMException name, message, and code', (t) => {
    const err = new DOMException('clone failed', 'DataCloneError');
    const clone = structuredClone(err);
    t.ok(clone instanceof DOMException, 'clone is DOMException');
    t.equal(clone.name, 'DataCloneError', 'name preserved');
    t.equal(clone.message, 'clone failed', 'message preserved');
    t.equal(clone.code, err.code, 'legacy code preserved');
    t.ok(clone !== err, 'different reference');
  });
  it('clones Blob', (t) => {
    const b = new Blob(['hello'], { type: 'text/plain' });
    const clone = structuredClone(b);
    t.ok(clone instanceof Blob, 'is Blob');
    t.ok(clone !== b, 'different reference');
    t.equal(clone.size, b.size, 'same size');
    t.equal(clone.type, b.type, 'same type');
  });
  it('cloned Blob has independent content', async (t) => {
    const b = new Blob(['world'], { type: 'text/plain' });
    const clone = structuredClone(b);
    t.equal(await clone.text(), 'world', 'content matches');
  });
  it('clones File preserves name and lastModified', (t) => {
    const f = new File(['data'], 'test.txt', {
      type: 'text/plain',
      lastModified: 1234567890
    });
    const clone = structuredClone(f);
    t.ok(clone instanceof File, 'is File');
    t.ok(clone instanceof Blob, 'File is also Blob');
    t.equal(clone.name, 'test.txt', 'name preserved');
    t.equal(clone.lastModified, 1234567890, 'lastModified preserved');
    t.equal(clone.type, 'text/plain', 'type preserved');
  });
  it('throws for WeakMap (not cloneable)', (t) => {
    t.throws(() => structuredClone(new WeakMap()), undefined, 'WeakMap not cloneable');
  });
  it('throws for WeakSet (not cloneable)', (t) => {
    t.throws(() => structuredClone(new WeakSet()), undefined, 'WeakSet not cloneable');
  });
  it('clones Boolean wrapper object', (t) => {
    const src = new Boolean(true);
    const clone = structuredClone(src);
    t.ok(clone instanceof Boolean, 'is Boolean wrapper');
    t.equal(clone.valueOf(), true, 'same primitive value');
    t.ok(clone !== src, 'different reference');
  });
  it('clones Number wrapper object', (t) => {
    const src = new Number(42);
    const clone = structuredClone(src);
    t.ok(clone instanceof Number, 'is Number wrapper');
    t.equal(clone.valueOf(), 42, 'same primitive value');
    t.ok(clone !== src, 'different reference');
  });
  it('clones String wrapper object', (t) => {
    const src = new String('hello');
    const clone = structuredClone(src);
    t.ok(clone instanceof String, 'is String wrapper');
    t.equal(clone.valueOf(), 'hello', 'same primitive value');
    t.ok(clone !== src, 'different reference');
  });
  it('clones DataView', (t) => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setInt32(0, 3735928559);
    const clone = structuredClone(view);
    t.ok(clone instanceof DataView, 'is DataView');
    t.equal(clone.getInt32(0), view.getInt32(0), 'data preserved');
    t.ok(clone.buffer !== buf, 'different backing buffer');
  });
  it('clones DataView offsets', (t) => {
    const buf = new ArrayBuffer(12);
    const full = new DataView(buf);
    full.setUint32(4, 305419896, true);
    const view = new DataView(buf, 4, 4);
    const clone = structuredClone(view);
    t.ok(clone instanceof DataView, 'is DataView');
    t.equal(clone.byteOffset, 4, 'byteOffset preserved');
    t.equal(clone.byteLength, 4, 'byteLength preserved');
    t.equal(clone.getUint32(0, true), 305419896, 'offset data preserved');
  });
  it('clones SharedArrayBuffer through the V8 serializer path', (t) => {
    const shared = new SharedArrayBuffer(4);
    const src = new Uint8Array(shared);
    src[0] = 7;
    const clone = structuredClone(shared);
    t.ok(clone instanceof SharedArrayBuffer, 'clone is SharedArrayBuffer');
    t.ok(clone !== shared, 'clone is a distinct wrapper');
    const cloned = new Uint8Array(clone);
    t.equal(cloned[0], 7, 'clone sees original data');
    cloned[1] = 9;
    t.equal(src[1], 9, 'clone shares backing memory');
  });
  it('transfer option copies ArrayBuffer and detaches fixed source', (t) => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([
      1,
      2,
      3,
      4
    ]);
    const clone = structuredClone({ buf }, { transfer: [buf] });
    t.deepEqual(Array.from(new Uint8Array(clone.buf)), [
      1,
      2,
      3,
      4
    ], 'clone has original data');
    t.equal(buf.byteLength, 0, 'source buffer is detached');
    t.throws(() => new Uint8Array(buf), undefined, 'detached source cannot be viewed');
  });
  it('transfer option rejects duplicate ArrayBuffer entries', (t) => {
    const buf = new ArrayBuffer(4);
    t.throws(() => structuredClone({ buf }, { transfer: [buf, buf] }), /DataCloneError|duplicate/i, 'duplicate transfer entry throws');
  });
  it('transfer option throws for non-ArrayBuffer', (t) => {
    t.throws(() => structuredClone({}, { transfer: ['not a buffer' as any] }), isDataCloneError, 'non-ArrayBuffer in transfer list throws');
  });
  it('transfer detaches source buffer (byteLength → 0 for resizable)', (t) => {
    const buf = new ArrayBuffer(4, { maxByteLength: 4 });
    new Uint8Array(buf).set([
      1,
      2,
      3,
      4
    ]);
    const clone = structuredClone(buf, { transfer: [buf] });
    t.deepEqual(Array.from(new Uint8Array(clone)), [
      1,
      2,
      3,
      4
    ], 'clone has the data');
    t.equal(buf.byteLength, 0, 'resizable source buffer is detached (byteLength = 0)');
  });
  it('cloning an instance of a custom class throws DataCloneError', (t) => {
    class Foo {
      x = 1;
    }
    t.throws(() => structuredClone(new Foo()), /DataCloneError|cannot be cloned/, 'class instance throws DataCloneError');
  });
  it('cloning a plain object with null prototype works', (t) => {
    const obj = Object.create(null) as any;
    obj.a = 1;
    const clone = structuredClone(obj);
    t.equal(clone.a, 1, 'null-prototype object is cloned');
    t.equal(Object.getPrototypeOf(clone), null, 'clone has null prototype');
  });
  it('BigInt64Array cloning', (t) => {
    const orig = new BigInt64Array([
      1n,
      -2n,
      9007199254740993n
    ]);
    const clone = structuredClone(orig);
    t.equal(clone[0], 1n, 'first element');
    t.equal(clone[1], -2n, 'second element');
    t.equal(clone[2], 9007199254740993n, 'large BigInt');
    t.ok(clone.buffer !== orig.buffer, 'different buffer');
  });
  it('BigUint64Array cloning', (t) => {
    const orig = new BigUint64Array([0n, 18446744073709551615n]);
    const clone = structuredClone(orig);
    t.equal(clone[0], 0n, 'first element');
    t.equal(clone[1], 18446744073709551615n, 'max u64');
  });
  it('Function is not cloneable', (t) => {
    t.throws(() => structuredClone(() => {}), /cannot be cloned/, 'function throws');
  });
  it('ReadableStream is not cloneable', (t) => {
    t.throws(() => structuredClone(new ReadableStream()), /DataCloneError|cannot be cloned/, 'ReadableStream throws');
  });
  it('ReadableStream transfer is explicitly unsupported', (t) => {
    t.throws(() => structuredClone({}, { transfer: [new ReadableStream() as any] }), isDataCloneError, 'stream transfer throws DataCloneError');
  });
  it('MessagePort clone and transfer are explicitly unsupported globally', (t) => {
    const { port1, port2 } = new MessageChannel();
    try {
      t.throws(() => structuredClone(port1), isDataCloneError, 'direct MessagePort value throws DataCloneError');
      t.throws(() => structuredClone({ port: port1 }, { transfer: [port1 as any] }), isDataCloneError, 'MessagePort transfer entry throws DataCloneError');
    } finally {
      port1.close();
      port2.close();
    }
  });
});
