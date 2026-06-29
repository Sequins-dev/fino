import { describe, it } from 'fino:test/test';
import { Scanner, ParseError } from 'fino:parsing/scanner';
// ── Binary ops ────────────────────────────────────────────────────────────
describe('Scanner — binary ops', () => {
  it('peekByte reads without advancing', (t) => {
    const s = new Scanner(new Uint8Array([
      1,
      2,
      3
    ]));
    t.equal(s.peekByte(), 1, 'peekByte() at 0');
    t.equal(s.peekByte(1), 2, 'peekByte(1)');
    t.equal(s.peekByte(2), 3, 'peekByte(2)');
    t.equal(s.peekByte(3), -1, 'peekByte past end');
    t.equal(s.offset, 0, 'offset unchanged');
  });
  it('eatByte advances and returns byte', (t) => {
    const s = new Scanner(new Uint8Array([171, 205]));
    t.equal(s.eatByte(), 171);
    t.equal(s.eatByte(), 205);
    t.equal(s.done, true);
    t.throws(() => s.eatByte(), /unexpected end of input/, 'throws at EOF');
  });
  it('eatBytes returns subarray and advances', (t) => {
    const s = new Scanner(new Uint8Array([
      1,
      2,
      3,
      4,
      5
    ]));
    const slice = s.eatBytes(3);
    t.deepEqual(Array.from(slice), [
      1,
      2,
      3
    ]);
    t.equal(s.offset, 3);
    t.throws(() => s.eatBytes(3), /expected 3 bytes, got 2/, 'throws on underflow');
  });
  it('matchBytes consumes iff prefix matches', (t) => {
    const s = new Scanner(new Uint8Array([
      72,
      84,
      84,
      80
    ]));
    t.equal(s.matchBytes([72, 84]), true, 'matched HT');
    t.equal(s.offset, 2);
    t.equal(s.matchBytes([84, 80]), true, 'matched TP');
    t.equal(s.done, true);
    const s2 = new Scanner(new Uint8Array([1, 2]));
    t.equal(s2.matchBytes([1, 3]), false, 'no match');
    t.equal(s2.offset, 0, 'offset unchanged on no match');
  });
  it('eatUntilByte stops before delimiter', (t) => {
    const s = new Scanner(new Uint8Array([
      97,
      98,
      10,
      99
    ]));
    const before = s.eatUntilByte(10);
    t.deepEqual(Array.from(before), [97, 98]);
    t.equal(s.peekByte(), 10, 'delimiter not consumed');
  });
  it('eatUntilByte respects max', (t) => {
    const s = new Scanner(new Uint8Array([
      1,
      2,
      3,
      4,
      5
    ]));
    const chunk = s.eatUntilByte(255, 3);
    t.equal(chunk.length, 3);
    t.equal(s.offset, 3);
  });
  it('bytesSlice returns correct subarray', (t) => {
    const s = new Scanner(new Uint8Array([
      10,
      20,
      30,
      40,
      50
    ]));
    const m1 = s.mark();
    s.eatBytes(3);
    const m2 = s.mark();
    const slice = s.bytesSlice(m1, m2);
    t.deepEqual(Array.from(slice), [
      10,
      20,
      30
    ]);
  });
  it('readU8 / readI8', (t) => {
    const s = new Scanner(new Uint8Array([255, 127]));
    t.equal(s.readU8(), 255);
    const s2 = new Scanner(new Uint8Array([255]));
    t.equal(s2.readI8(), -1);
    const s3 = new Scanner(new Uint8Array([127]));
    t.equal(s3.readI8(), 127);
  });
  it('readU16BE / readU16LE', (t) => {
    const s = new Scanner(new Uint8Array([
      1,
      2,
      1,
      2
    ]));
    t.equal(s.readU16BE(), 258);
    t.equal(s.readU16LE(), 513);
  });
  it('readU32BE / readU32LE', (t) => {
    const s = new Scanner(new Uint8Array([
      222,
      173,
      190,
      239,
      222,
      173,
      190,
      239
    ]));
    t.equal(s.readU32BE(), 3735928559);
    t.equal(s.readU32LE(), 4022250974);
  });
  it('readI32BE handles negative values', (t) => {
    const s = new Scanner(new Uint8Array([
      255,
      255,
      255,
      255
    ]));
    t.equal(s.readI32BE(), -1);
  });
  it('readU64BE / readU64LE', (t) => {
    const s = new Scanner(new Uint8Array([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      5,
      5,
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ]));
    t.equal(s.readU64BE(), 5n);
    t.equal(s.readU64LE(), 5n);
  });
  it('readF64BE round-trips', (t) => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, Math.PI, false);
    const s = new Scanner(new Uint8Array(buf));
    t.equal(s.readF64BE(), Math.PI);
  });
  it('fixed-width reads throw at EOF', (t) => {
    const s = new Scanner(new Uint8Array([1]));
    s.readU8();
    t.throws(() => s.readU16BE(), /unexpected end of input/, 'readU16BE at EOF');
  });
  it('eatText decodes byteLength bytes as text', (t) => {
    const enc = new TextEncoder();
    const buf = enc.encode('hello');
    const s = new Scanner(buf);
    t.equal(s.eatText(5), 'hello');
    t.equal(s.done, true);
  });
});
// ── Text ops in binary-only mode throw ────────────────────────────────────
describe('Scanner — text ops require encoding', () => {
  const OPS: Array<[string, (s: Scanner) => void]> = [
    ['peek', (s) => s.peek()],
    ['peekCode', (s) => s.peekCode()],
    ['eat', (s) => s.eat()],
    ['eatChar', (s) => s.eatChar('a')],
    ['match', (s) => s.match('a')],
    ['eatWhile', (s) => s.eatWhile(() => true)],
    ['eatUntil', (s) => s.eatUntil(() => true)],
    ['expect', (s) => s.expect('a')],
    ['text', (s) => s.text({ offset: 0 })],
    ['line', (s) => void s.line],
    ['column', (s) => void s.column]
  ];
  for (const [name, fn] of OPS) {
    it(`${name} throws without encoding`, (t) => {
      const s = new Scanner(new Uint8Array([97]));
      t.throws(() => fn(s), /require encoding/i, `${name} throws`);
    });
  }
});
// ── Text ops ──────────────────────────────────────────────────────────────
describe('Scanner — text ops (utf-8)', () => {
  it('peek reads n chars without advancing', (t) => {
    const s = new Scanner('hello', { encoding: 'utf-8' });
    t.equal(s.peek(3), 'hel');
    t.equal(s.offset, 0, 'no advance');
    t.equal(s.peek(0), '', 'peek(0) is empty');
  });
  it('peekCode returns codepoint at n chars ahead', (t) => {
    const s = new Scanner('ABC', { encoding: 'utf-8' });
    t.equal(s.peekCode(), 65, 'A at 0');
    t.equal(s.peekCode(1), 66, 'B at 1');
    t.equal(s.peekCode(2), 67, 'C at 2');
    t.equal(s.peekCode(3), -1, 'EOF');
  });
  it('eat consumes n chars', (t) => {
    const s = new Scanner('hello', { encoding: 'utf-8' });
    t.equal(s.eat(2), 'he');
    t.equal(s.offset, 2);
    t.equal(s.eat(), 'l');
    t.equal(s.offset, 3);
  });
  it('eatChar matches single char', (t) => {
    const s = new Scanner('abc', { encoding: 'utf-8' });
    t.equal(s.eatChar('a'), true);
    t.equal(s.eatChar('a'), false, 'does not consume on mismatch');
    t.equal(s.eatChar('b'), true);
  });
  it('match consumes multi-char literal', (t) => {
    const s = new Scanner('---foo', { encoding: 'utf-8' });
    t.equal(s.match('---'), true);
    t.equal(s.offset, 3);
    t.equal(s.match('---'), false, 'no match, no advance');
    t.equal(s.offset, 3);
  });
  it('eatWhile consumes while predicate holds', (t) => {
    const s = new Scanner('abc123', { encoding: 'utf-8' });
    const letters = s.eatWhile((c) => c >= 97 && c <= 122);
    t.equal(letters, 'abc');
    t.equal(s.offset, 3);
  });
  it('eatUntil consumes until predicate holds', (t) => {
    const s = new Scanner('hello world', { encoding: 'utf-8' });
    const word = s.eatUntil((c) => c === 32);
    t.equal(word, 'hello');
    t.equal(s.peekCode(), 32);
  });
  it('expect succeeds or throws', (t) => {
    const s = new Scanner('foo', { encoding: 'utf-8' });
    s.expect('fo');
    t.equal(s.offset, 2);
    t.throws(() => s.expect('x'), /expected 'x'/);
  });
  it('text decodes a span', (t) => {
    const s = new Scanner('hello world', { encoding: 'utf-8' });
    const start = s.mark();
    s.eat(5);
    t.equal(s.text(start), 'hello');
  });
  it('tracks line and column', (t) => {
    const s = new Scanner('a\nbc\nd', { encoding: 'utf-8' });
    t.equal(s.line, 1);
    t.equal(s.column, 1);
    s.eat();
    t.equal(s.line, 1);
    t.equal(s.column, 2);
    s.eat();
    t.equal(s.line, 2);
    t.equal(s.column, 1);
    s.eat(2);
    t.equal(s.line, 2);
    t.equal(s.column, 3);
    s.eat();
    t.equal(s.line, 3);
    t.equal(s.column, 1);
    s.eat();
    t.equal(s.line, 3);
    t.equal(s.column, 2);
  });
  it('handles multi-byte UTF-8 (emoji)', (t) => {
    const s = new Scanner('A😀B', { encoding: 'utf-8' });
    t.equal(s.eat(), 'A');
    t.equal(s.offset, 1);
    t.equal(s.peekCode(), 128512, 'emoji codepoint');
    const emoji = s.eat();
    t.equal(emoji, '😀');
    t.equal(s.offset, 5, '4 bytes for emoji');
    t.equal(s.eat(), 'B');
    t.equal(s.done, true);
  });
  it('handles 3-byte UTF-8 sequences', (t) => {
    const s = new Scanner('€', { encoding: 'utf-8' });
    t.equal(s.peekCode(), 8364);
    t.equal(s.eat(), '€');
    t.equal(s.offset, 3);
  });
  it('eatWhile ASCII fast path vs multi-byte', (t) => {
    const s = new Scanner('abc😀def', { encoding: 'utf-8' });
    const part = s.eatWhile((c) => c < 128);
    t.equal(part, 'abc');
    t.equal(s.peekCode(), 128512);
  });
});
describe('Scanner — text encodings and malformed boundaries', () => {
  it('decodes and matches utf-16be text', (t) => {
    const bytes = new Uint8Array([
      0,
      65,
      0,
      10,
      32,
      172,
      216,
      61,
      222,
      0
    ]);
    const s = new Scanner(bytes, { encoding: 'utf-16be' });
    t.equal(s.peek(), 'A', 'peek decodes first BE code unit');
    t.equal(s.eat(), 'A', 'eat decodes first BE code unit');
    t.equal(s.line, 1, 'line starts at 1');
    t.equal(s.column, 2, 'column advances by text character');
    t.equal(s.eat(), '\n', 'newline decodes');
    t.equal(s.line, 2, 'newline advances line');
    t.equal(s.column, 1, 'newline resets column');
    t.equal(s.match('€'), true, 'match encodes utf-16be literal');
    t.equal(s.peekCode(), 128512, 'surrogate pair codepoint is decoded');
    t.equal(s.eat(), '😀', 'surrogate pair text is decoded');
    t.equal(s.done, true, 'scanner consumed full utf-16be input');
  });
  it('handles partial utf-16 code units at byte boundaries', (t) => {
    const s = new Scanner(new Uint8Array([
      0,
      65,
      0
    ]), { encoding: 'utf-16be' });
    t.equal(s.eatText(3), 'A', 'fixed-byte decode ignores dangling byte');
    t.equal(s.done, true, 'eatText still consumes requested bytes');
    const textScanner = new Scanner(new Uint8Array([
      0,
      65,
      0
    ]), { encoding: 'utf-16be' });
    t.equal(textScanner.eat(), 'A', 'complete code unit decodes');
    t.equal(textScanner.peekCode(), -1, 'dangling byte is not exposed as a codepoint');
  });
  it('replaces partial utf-8 sequences at byte boundaries', (t) => {
    const s = new Scanner(new Uint8Array([226, 130]), { encoding: 'utf-8' });
    t.equal(s.peekCode(), 65533, 'partial sequence peeks as replacement');
    t.equal(s.eat(), '�', 'partial sequence consumes replacement');
    t.equal(s.eat(), '�', 'remaining continuation byte consumes replacement');
    t.equal(s.done, true, 'partial sequence bytes are consumed');
  });
});
// ── Spans + backtracking ───────────────────────────────────────────────────
describe('Scanner — spans and backtracking', () => {
  it('mark captures byte offset', (t) => {
    const s = new Scanner(new Uint8Array([
      1,
      2,
      3
    ]));
    const m = s.mark();
    t.equal(m.offset, 0);
    s.eatBytes(2);
    const m2 = s.mark();
    t.equal(m2.offset, 2);
  });
  it('mark in text mode captures line and column', (t) => {
    const s = new Scanner('line1\nline2', { encoding: 'utf-8' });
    s.eat(6);
    const m = s.mark();
    t.equal(m.offset, 6);
    t.equal(m.line, 2);
    t.equal(m.column, 1);
  });
  it('snapshot and restore preserves position', (t) => {
    const s = new Scanner('abcdef', { encoding: 'utf-8' });
    s.eat(3);
    const snap = s.snapshot();
    s.eat(3);
    t.equal(s.offset, 6);
    s.restore(snap);
    t.equal(s.offset, 3);
    t.equal(s.eat(), 'd');
  });
  it('snapshot and restore preserves line/col', (t) => {
    const s = new Scanner('a\nb', { encoding: 'utf-8' });
    s.eat(2);
    const snap = s.snapshot();
    t.equal(snap.line, 2);
    t.equal(snap.column, 1);
    s.eat();
    s.restore(snap);
    t.equal(s.line, 2);
    t.equal(s.column, 1);
  });
  it('byte ops in text mode invalidate line/col', (t) => {
    const s = new Scanner(new Uint8Array([65, 66]), { encoding: 'utf-8' });
    s.eat();
    t.equal(s.line, 1);
    s.eatByte();
    t.throws(() => s.line, /invalidated by byte op/);
  });
  it('restoring a text snapshot re-validates line/col after byte ops', (t) => {
    const s = new Scanner('hello', { encoding: 'utf-8' });
    s.eat(2);
    const snap = s.snapshot();
    s.eatByte();
    t.throws(() => s.line);
    s.restore(snap);
    t.equal(s.line, 1);
    t.equal(s.column, 3);
  });
});
// ── ParseError and render ──────────────────────────────────────────────────
describe('Scanner — error and ParseError', () => {
  it('error() returns a ParseError instance', (t) => {
    const s = new Scanner('foo', {
      encoding: 'utf-8',
      format: 'myformat'
    });
    s.eat(2);
    const err = s.error('unexpected char');
    t.ok(err instanceof ParseError, 'is ParseError');
    t.equal(err.format, 'myformat');
    t.equal(err.offset, 2);
    t.equal(err.line, 1);
    t.equal(err.column, 3);
  });
  it('error message includes format and position', (t) => {
    const s = new Scanner('abc\ndef', {
      encoding: 'utf-8',
      format: 'toml'
    });
    s.eat(4);
    const err = s.error('bad value');
    t.ok(err.message.includes('toml'), 'includes format name');
    t.ok(err.message.includes('line 2'), 'includes line');
  });
  it('binary mode error includes offset', (t) => {
    const s = new Scanner(new Uint8Array([
      0,
      1,
      2
    ]), { format: 'http2' });
    s.eatBytes(2);
    const err = s.error('bad byte');
    t.ok(err.message.includes('0x'), 'includes hex offset');
    t.equal(err.line, undefined, 'no line in binary mode');
  });
  it('render() produces text snippet for text errors', (t) => {
    const s = new Scanner('foo = + 1', {
      encoding: 'utf-8',
      format: 'toml'
    });
    s.eat(6);
    const err = s.error('unexpected char');
    const rendered = err.render();
    t.ok(rendered.includes('foo = + 1'), 'includes source line');
    t.ok(rendered.includes('^'), 'includes caret');
    t.ok(rendered.includes('toml'), 'includes format name');
  });
  it('render() with color wraps in ANSI codes', (t) => {
    const s = new Scanner('bad', {
      encoding: 'utf-8',
      format: 'test'
    });
    const err = s.error('oops');
    const colored = err.render({ color: true });
    t.ok(colored.includes('\x1B['), 'contains ANSI escape');
  });
  it('render() produces hex dump for binary errors', (t) => {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = i;
    const s = new Scanner(buf, { format: 'http2' });
    s.eatBytes(18);
    const err = s.error('bad frame type');
    const rendered = err.render();
    t.ok(rendered.includes('http2'), 'includes format');
    t.ok(rendered.includes('0x'), 'includes hex offset');
    t.ok(rendered.includes('^'), 'includes pointer arrow');
  });
  it('render() truncates long lines', (t) => {
    const longLine = 'a'.repeat(200) + 'X' + 'b'.repeat(200);
    const s = new Scanner(longLine, {
      encoding: 'utf-8',
      format: 'test'
    });
    s.eat(200);
    const err = s.error('here');
    const rendered = err.render();
    t.ok(rendered.includes('…'), 'contains ellipsis for truncation');
    t.ok(rendered.includes('^'), 'still has caret');
  });
  it('render() with contextLines shows surrounding lines', (t) => {
    const src = 'line1\nline2\nline3\nline4\nline5';
    const s = new Scanner(src, {
      encoding: 'utf-8',
      format: 'test'
    });
    s.eat(12);
    const err = s.error('problem');
    const rendered = err.render({ contextLines: 1 });
    t.ok(rendered.includes('line2'), 'shows line before');
    t.ok(rendered.includes('line3'), 'shows error line');
    t.ok(rendered.includes('line4'), 'shows line after');
  });
});
// ── Mixed binary + text ────────────────────────────────────────────────────
describe('Scanner — mixed binary/text (HTTP/1-style)', () => {
  it('reads ASCII headers then binary body', (t) => {
    // Simulated HTTP/1 response: status line + one header + CRLF + binary body
    const header = 'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n';
    const body = new Uint8Array([
      222,
      173,
      190,
      239
    ]);
    const enc = new TextEncoder();
    const hdrBuf = enc.encode(header);
    const full = new Uint8Array(hdrBuf.length + body.length);
    full.set(hdrBuf, 0);
    full.set(body, hdrBuf.length);
    const s = new Scanner(full, {
      encoding: 'utf-8',
      format: 'http'
    });
    // Read status line
    const statusLine = s.eatUntil((c) => c === 13 || c === 10);
    t.ok(statusLine.startsWith('HTTP/1.1'));
    s.match('\r\n');
    // Read header field
    const field = s.eatUntil((c) => c === 13 || c === 10);
    t.ok(field.includes('Content-Length'), 'header parsed');
    s.match('\r\n');
    // End of headers
    s.expect('\r\n');
    // Switch to byte ops for body
    const bodySlice = s.eatBytes(4);
    t.deepEqual(Array.from(bodySlice), [
      222,
      173,
      190,
      239
    ]);
    t.equal(s.done, true);
  });
});
// ── Parser toolkit helpers ─────────────────────────────────────────────────
describe('Scanner — parser toolkit helpers', () => {
  it('readLineCRLF reads CRLF-terminated lines and rejects bare LF', (t) => {
    const s = new Scanner('alpha\r\nbeta\r\n', {
      encoding: 'ascii',
      format: 'lines'
    });
    t.equal(s.readLineCRLF(), 'alpha');
    t.equal(s.readLineCRLF(), 'beta');
    t.equal(s.done, true);
    const bad = new Scanner('alpha\n', {
      encoding: 'ascii',
      format: 'lines'
    });
    t.throws(() => bad.readLineCRLF(), /expected CRLF/);
  });
  it('readHeaderBlock reads until an empty CRLF line', (t) => {
    const s = new Scanner('GET / HTTP/1.1\r\nHost: example.com\r\n\r\nbody', { encoding: 'ascii' });
    t.deepEqual(s.readHeaderBlock(), ['GET / HTTP/1.1', 'Host: example.com']);
    t.equal(s.eat(4), 'body');
  });
  it('readAsciiSpanUntilByte returns a zero-copy byte span', (t) => {
    const bytes = new TextEncoder().encode('token:value');
    const s = new Scanner(bytes, { encoding: 'ascii' });
    const span = s.readAsciiSpanUntilByte(58);
    t.equal(new TextDecoder().decode(span), 'token');
    t.equal(span.buffer, bytes.buffer, 'span shares backing buffer');
    t.equal(s.peekByte(), 58, 'delimiter is not consumed by default');
  });
  it('readDelimitedList trims and omits empty values', (t) => {
    const s = new Scanner(' keep-alive, Upgrade, , close ', { encoding: 'ascii' });
    t.deepEqual(s.readDelimitedList(','), [
      'keep-alive',
      'Upgrade',
      'close'
    ]);
    t.equal(s.done, true);
  });
  it('readToken and expectToken parse protocol tokens', (t) => {
    const s = new Scanner('HTTP/1.1 200', { encoding: 'ascii' });
    t.equal(s.readToken('version'), 'HTTP/1.1');
    s.expect(' ');
    t.equal(s.readStrictInt({
      name: 'status',
      min: 100,
      max: 999
    }), 200);
    const bad = new Scanner('20x', { encoding: 'ascii' });
    t.throws(() => bad.readStrictInt({ name: 'status' }), /invalid status/);
  });
  it('subScanner bounds nested reads and advances parent', (t) => {
    const s = new Scanner(new Uint8Array([
      0,
      4,
      1,
      2,
      3,
      4,
      9
    ]));
    const len = s.readU16BEField('length');
    const sub = s.subScanner(len, { format: 'field' });
    t.deepEqual(Array.from(sub.eatBytes(4)), [
      1,
      2,
      3,
      4
    ]);
    t.equal(sub.done, true);
    t.equal(s.readU8(), 9);
  });
  it('jump moves to absolute offsets for pointer-based protocols', (t) => {
    const s = new Scanner(new Uint8Array([
      192,
      4,
      3,
      1,
      2,
      3
    ]));
    const pointer = s.readU16BEField('pointer') & 16383;
    const back = s.snapshot();
    s.jump(pointer);
    t.deepEqual(Array.from(s.eatBytes(2)), [2, 3]);
    s.restore(back);
    t.equal(s.offset, 2);
  });
});
// ── Encodings ─────────────────────────────────────────────────────────────
describe('Scanner — latin1 encoding', () => {
  it('reads latin1 bytes as codepoints directly', (t) => {
    const buf = new Uint8Array([
      97,
      233,
      99
    ]);
    const s = new Scanner(buf, { encoding: 'latin1' });
    t.equal(s.peekCode(), 97);
    t.equal(s.eat(), 'a');
    t.equal(s.peekCode(), 233);
    t.equal(s.eat(), 'é');
    t.equal(s.eat(), 'c');
  });
});
describe('Scanner — utf-16le encoding', () => {
  it('reads UTF-16LE codepoints', (t) => {
    // 'AB' in UTF-16LE: 0x41 0x00 0x42 0x00
    const buf = new Uint8Array([
      65,
      0,
      66,
      0
    ]);
    const s = new Scanner(buf, { encoding: 'utf-16le' });
    t.equal(s.eat(), 'A');
    t.equal(s.eat(), 'B');
    t.equal(s.done, true);
  });
});
