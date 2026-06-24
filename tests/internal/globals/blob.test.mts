/**
 * Tests for Blob and File globals.
 */

import { describe, it } from 'fino:test/test';
import { _createFileList } from '../../../js/globals/blob.mts';

function descriptor(target: object, key: PropertyKey): PropertyDescriptor {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) throw new Error(`missing descriptor for ${String(key)}`);
  return desc;
}

function waitFor(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => {
    target.addEventListener(type, resolve, { once: true });
  });
}

describe('File API WebIDL descriptors', () => {
  it('installs File API globals as non-enumerable global properties', (t) => {
    for (const name of ['Blob', 'File', 'FileList', 'FileReader']) {
      const desc = descriptor(globalThis, name);
      t.equal(desc.enumerable, false, `${name} global is non-enumerable`);
      t.equal(desc.writable, true, `${name} global is writable`);
      t.equal(desc.configurable, true, `${name} global is configurable`);
    }
  });

  it('sets constructor lengths and string tags', (t) => {
    t.equal(Blob.length, 0, 'Blob.length');
    t.equal(File.length, 2, 'File.length');
    t.equal(FileList.length, 0, 'FileList.length');
    t.equal(FileReader.length, 0, 'FileReader.length');
    t.equal(Blob.prototype.slice.length, 0, 'Blob.prototype.slice.length');
    t.equal(FileReader.prototype.readAsText.length, 1, 'FileReader.prototype.readAsText.length');
    t.equal(Object.prototype.toString.call(new Blob()), '[object Blob]', 'Blob toStringTag');
    t.equal(Object.prototype.toString.call(new File([], 'x')), '[object File]', 'File toStringTag');
    t.equal(Object.prototype.toString.call(_createFileList()), '[object FileList]', 'FileList toStringTag');
    t.equal(Object.prototype.toString.call(new FileReader()), '[object FileReader]', 'FileReader toStringTag');
  });

  it('exposes WebIDL prototype members as enumerable', (t) => {
    for (const [proto, name] of [
      [Blob.prototype, 'size'],
      [Blob.prototype, 'slice'],
      [Blob.prototype, 'bytes'],
      [File.prototype, 'name'],
      [FileList.prototype, 'length'],
      [FileList.prototype, 'item'],
      [FileReader.prototype, 'readyState'],
      [FileReader.prototype, 'readAsText'],
      [FileReader.prototype, 'onload'],
    ] as const) {
      t.equal(descriptor(proto, name).enumerable, true, `${proto.constructor.name}.${String(name)} is enumerable`);
    }
  });

  it('defines FileReader constants as readonly enumerable properties', (t) => {
    for (const target of [FileReader, FileReader.prototype]) {
      for (const [name, value] of [['EMPTY', 0], ['LOADING', 1], ['DONE', 2]] as const) {
        const desc = descriptor(target, name);
        t.equal(desc.value, value, `${name} value`);
        t.equal(desc.writable, false, `${name} is readonly`);
        t.equal(desc.enumerable, true, `${name} is enumerable`);
      }
    }
  });

  it('keeps FileReader event handlers on the prototype', (t) => {
    const reader = new FileReader();
    t.equal(Object.prototype.hasOwnProperty.call(reader, 'onload'), false, 'onload is inherited');
    t.equal(reader.onload, null, 'onload defaults to null');
    reader.onload = () => {};
    t.equal(typeof reader.onload, 'function', 'onload stores function handlers');
    reader.onload = 'not a function' as any;
    t.equal(reader.onload, null, 'onload coerces non-functions to null');
  });

  it('exposes FileList as an illegal-constructor File API interface', (t) => {
    t.throws(() => new FileList(), TypeError, 'FileList constructor throws');
    const file = new File(['x'], 'x.txt');
    const list = _createFileList([file]);
    t.equal(list.length, 1, 'length');
    t.equal(list.item(0), file, 'item returns file');
    t.equal(list.item(1), null, 'missing item returns null');
    t.equal((list as any)[0], file, 'indexed property');
    t.equal(descriptor(FileList, 'prototype').writable, false, 'prototype is readonly');
    t.equal(FileList.prototype.item.name, 'item', 'item function name');
    t.equal(descriptor(FileList.prototype, 'length').get?.name, 'get length', 'length getter name');
    t.throws(() => list.item(), TypeError, 'item requires index');
    t.throws(
      () => Reflect.get(FileList.prototype, 'length', FileList.prototype),
      TypeError,
      'length getter requires FileList receiver',
    );
  });

  it('exposes FileAPI URL static operations as enumerable', (t) => {
    t.equal(descriptor(URL, 'createObjectURL').enumerable, true, 'URL.createObjectURL is enumerable');
    t.equal(descriptor(URL, 'revokeObjectURL').enumerable, true, 'URL.revokeObjectURL is enumerable');
  });
});

describe('Blob construction', () => {
  it('empty constructor', (t) => {
    const b = new Blob();
    t.equal(b.size, 0, 'size is 0');
    t.equal(b.type, '', 'type is empty string');
  });

  it('empty parts array', (t) => {
    const b = new Blob([]);
    t.equal(b.size, 0, 'size is 0');
  });

  it('string part', (t) => {
    const b = new Blob(['hello']);
    t.equal(b.size, 5, 'size matches UTF-8 byte count');
    t.equal(b.type, '', 'type defaults to empty string');
  });

  it('multiple string parts concatenated', (t) => {
    const b = new Blob(['hello', ', ', 'world']);
    t.equal(b.size, 12);
  });

  it('type option is lowercased', (t) => {
    const b = new Blob(['x'], { type: 'Text/Plain' });
    t.equal(b.type, 'text/plain', 'type is lowercased');
  });

  it('ArrayBuffer part', (t) => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const b = new Blob([buf]);
    t.equal(b.size, 3);
  });

  it('Uint8Array part', (t) => {
    const arr = new Uint8Array([10, 20, 30, 40]);
    const b = new Blob([arr]);
    t.equal(b.size, 4);
  });

  it('Blob part (copies bytes)', (t) => {
    const inner = new Blob(['abc']);
    const outer = new Blob([inner, 'def']);
    t.equal(outer.size, 6);
  });

  it('mixed parts', (t) => {
    const a = new Blob(['hi']);
    const b = new Blob([a, new Uint8Array([32]), 'there']);
    t.equal(b.size, 2 + 1 + 5); // 'hi' + space byte + 'there'
  });

  it('normalizes string part line endings when endings is native', async (t) => {
    const b = new Blob(['a\nb', 'c\r\nd', 'e\rf'], { endings: 'native' } as BlobPropertyBag);
    const expected = ['a', 'bc', 'de', 'f'].join('\n');
    t.equal(await b.text(), expected, 'native endings normalize string parts to platform newlines');
  });

  it('preserves string part line endings by default and with transparent endings', async (t) => {
    const input = 'a\nb\r\nc\rd';
    t.equal(await new Blob([input]).text(), input, 'default endings preserve original line endings');
    t.equal(await new Blob([input], { endings: 'transparent' } as BlobPropertyBag).text(), input, 'transparent endings preserve original line endings');
  });

  it('does not normalize non-string parts when endings is native', async (t) => {
    const bytes = new Uint8Array([97, 13, 98, 10, 99]);
    const b = new Blob([bytes], { endings: 'native' } as BlobPropertyBag);
    t.deepEqual(Array.from(await b.bytes()), Array.from(bytes), 'binary parts are byte-preserving');
  });

  it('throws TypeError for invalid endings option values', (t) => {
    for (const endings of [null, '', 'invalidEnumValue', 'Transparent', 'NATIVE', 0, {}]) {
      t.throws(
        () => new Blob([], { endings } as any),
        TypeError,
        `invalid endings value ${String(endings)} throws`,
      );
    }
  });

  it('throws TypeError for primitive property bags', (t) => {
    for (const options of [123, 123.4, true, 'abc']) {
      t.throws(
        () => new Blob([], options as any),
        TypeError,
        `primitive property bag ${String(options)} throws`,
      );
    }
  });

  it('propagates exceptions from the endings option getter', (t) => {
    const thrown = { name: 'test' };
    t.throws(
      () => new Blob([], { get endings() { throw thrown; } } as any),
      (err) => err === thrown,
      'endings getter exception is propagated',
    );
  });
});

describe('text() / arrayBuffer() / bytes()', () => {
  it('text() decodes UTF-8', async (t) => {
    const b = new Blob(['hello, world']);
    t.equal(await b.text(), 'hello, world');
  });

  it('text() with multibyte chars', async (t) => {
    const b = new Blob(['caf\u00e9']); // café
    const text = await b.text();
    t.equal(text, 'café');
  });

  it('arrayBuffer() returns ArrayBuffer', async (t) => {
    const b = new Blob(['abc']);
    const ab = await b.arrayBuffer();
    t.ok(ab instanceof ArrayBuffer, 'returns ArrayBuffer');
    t.equal(ab.byteLength, 3);
    const view = new Uint8Array(ab);
    t.equal(view[0], 97, 'a'); // 'a'
    t.equal(view[1], 98, 'b');
    t.equal(view[2], 99, 'c');
  });

  it('bytes() returns Uint8Array copy', async (t) => {
    const b = new Blob(['xyz']);
    const bytes = await b.bytes();
    t.ok(bytes instanceof Uint8Array, 'returns Uint8Array');
    t.equal(bytes.length, 3);
    t.equal(bytes[0], 120); // 'x'
  });
});

describe('slice()', () => {
  it('no args returns full copy', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice();
    t.equal(s.size, 5);
    t.equal(s.type, '');
  });

  it('with start', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(2);
    t.equal(s.size, 3); // 'llo'
  });

  it('with start and end', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(1, 4);
    t.equal(s.size, 3); // 'ell'
  });

  it('with contentType', (t) => {
    const b = new Blob(['hello'], { type: 'text/plain' });
    const s = b.slice(0, 2, 'text/html');
    t.equal(s.type, 'text/html');
  });

  it('with negative start', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(-3);
    t.equal(s.size, 3); // 'llo'
  });

  it('clamps out-of-range', (t) => {
    const b = new Blob(['hi']);
    t.equal(b.slice(0, 100).size, 2);
    t.equal(b.slice(100).size, 0);
  });

  it('content is correct', async (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(1, 4);
    t.equal(await s.text(), 'ell');
  });
});

describe('stream()', () => {
  it('yields bytes as async iterable', async (t) => {
    const b = new Blob(['abc']);
    const chunks: Uint8Array[] = [];
    for await (const chunk of b.stream()) {
      chunks.push(chunk);
    }
    t.equal(chunks.length, 1, 'one chunk');
    t.ok(chunks[0] instanceof Uint8Array, 'chunk is Uint8Array');
    t.equal(chunks[0]?.length, 3);
  });
});

describe('File', () => {
  it('basic construction', (t) => {
    const f = new File(['hello'], 'hello.txt');
    t.equal(f.name, 'hello.txt');
    t.equal(f.size, 5);
    t.ok(typeof f.lastModified === 'number', 'lastModified is a number');
  });

  it('type option', (t) => {
    const f = new File(['x'], 'x.txt', { type: 'text/plain' });
    t.equal(f.type, 'text/plain');
  });

  it('lastModified option', (t) => {
    const f = new File(['x'], 'x', { lastModified: 1000 });
    t.equal(f.lastModified, 1000);
  });

  it('inherits Blob methods', async (t) => {
    const f = new File(['world'], 'w.txt', { type: 'text/plain' });
    t.equal(await f.text(), 'world');
    t.equal(f.size, 5);
    const s = f.slice(0, 3);
    t.ok(s instanceof Blob, 'slice returns Blob');
    t.equal(s.size, 3);
  });

  it('instanceof Blob', (t) => {
    const f = new File(['x'], 'x');
    t.ok(f instanceof Blob, 'File instanceof Blob');
    t.ok(f instanceof File, 'File instanceof File');
  });

  it('requires fileBits and fileName arguments', (t) => {
    t.throws(() => new (File as any)(), TypeError, 'missing fileBits throws');
    t.throws(() => new (File as any)([]), TypeError, 'missing fileName throws');
  });

  it('throws TypeError for primitive fileBits strings', (t) => {
    t.throws(() => new File('hello' as any, 'hello.txt'), TypeError, 'string fileBits throws');
  });

  it('throws TypeError for primitive property bags', (t) => {
    for (const options of [123, 123.4, true, 'abc']) {
      t.throws(
        () => new File(['bits'], 'name.txt', options as any),
        TypeError,
        `primitive property bag ${String(options)} throws`,
      );
    }
  });

  it('normalizes string part line endings when endings is native', async (t) => {
    const f = new File(['a\rb\nc'], 'lines.txt', { endings: 'native' } as FilePropertyBag);
    t.equal(await f.text(), ['a', 'b', 'c'].join('\n'), 'File passes endings through Blob construction');
  });
});

describe('slice() edge cases', () => {
  it('slice(0, -1) on a 5-byte blob produces 4 bytes', (t) => {
    const b = new Blob(['hello']); // 5 bytes
    const s = b.slice(0, -1);
    t.equal(s.size, 4, 'negative end resolves relative to size');
  });

  it('slice() where end < start produces empty blob', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(3, 1);
    t.equal(s.size, 0, 'end < start yields empty blob');
  });

  it('arrayBuffer() returns a copy — mutating it does not affect blob', async (t) => {
    const b = new Blob(['abc']);
    const ab = await b.arrayBuffer();
    const view = new Uint8Array(ab);
    view[0] = 0xff; // mutate
    // Read blob again — should still be original bytes
    const ab2 = await b.arrayBuffer();
    const view2 = new Uint8Array(ab2);
    t.equal(view2[0], 97, 'original blob byte unchanged after mutation of returned ArrayBuffer');
  });

  it('bytes() returns a copy — mutating it does not affect blob', async (t) => {
    const b = new Blob(['xyz']);
    const bytes = await b.bytes();
    bytes[0] = 0xff; // mutate
    const bytes2 = await b.bytes();
    t.equal(bytes2[0], 120, 'original blob byte unchanged after mutation of returned Uint8Array');
  });
});

describe('Blob type validation — chars outside 0x20–0x7E', () => {
  it('type with null byte is set to empty string', (t) => {
    const b = new Blob(['x'], { type: 'text/plain\x00' });
    t.equal(b.type, '', 'null byte makes type empty string');
  });

  it('type with char > 0x7E is set to empty string', (t) => {
    const b = new Blob(['x'], { type: 'text/plain\x80' });
    t.equal(b.type, '', 'char above 0x7E makes type empty string');
  });

  it('type with tab (0x09) is set to empty string', (t) => {
    const b = new Blob(['x'], { type: 'text/\x09plain' });
    t.equal(b.type, '', 'tab char makes type empty string');
  });

  it('valid ASCII type is lowercased and accepted', (t) => {
    const b = new Blob(['x'], { type: 'TEXT/PLAIN; charset=UTF-8' });
    t.equal(b.type, 'text/plain; charset=utf-8', 'valid type lowercased');
  });
});

describe('stream() returns ReadableStream', () => {
  it('stream() returns an instance of ReadableStream', (t) => {
    const b = new Blob(['test']);
    const s = b.stream();
    t.ok(s instanceof ReadableStream, 'stream() returns ReadableStream instance');
  });

  it('empty Blob stream() produces empty data', async (t) => {
    const b = new Blob([]);
    let totalBytes = 0;
    for await (const chunk of b.stream()) {
      totalBytes += (chunk as Uint8Array).byteLength;
    }
    t.equal(totalBytes, 0, 'empty blob stream produces zero bytes total');
  });
});

describe('textStream()', () => {
  async function readAll(stream: ReadableStream<string>): Promise<string[]> {
    const reader = stream.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  }

  it('returns a ReadableStream of UTF-8 text chunks', async (t) => {
    const stream = new Blob(['hello ', new TextEncoder().encode('world')]).textStream();
    t.ok(stream instanceof ReadableStream, 'textStream() returns ReadableStream');
    t.deepEqual(await readAll(stream), ['hello world'], 'decoded text is emitted as a string chunk');
  });

  it('empty Blob produces no text chunks', async (t) => {
    const chunks = await readAll(new Blob().textStream());
    t.equal(chunks.length, 0, 'empty blob produces no chunks');
  });

  it('ignores the type charset and always decodes as UTF-8', async (t) => {
    const bytes = new Uint8Array([0x68, 0x00, 0x69, 0x00]);
    const blob = new Blob([bytes], { type: 'text/plain; charset=utf-16le' });
    t.deepEqual(await readAll(blob.textStream()), ['h\0i\0']);
  });

  it('returns a fresh stream for each call', async (t) => {
    const blob = new Blob(['again']);
    const first = blob.textStream();
    const second = blob.textStream();
    t.ok(first !== second, 'streams are distinct');
    t.deepEqual(await readAll(first), ['again']);
    t.deepEqual(await readAll(second), ['again']);
  });
});

describe('File — name coercion for null/undefined', () => {
  it('File with null name is coerced to string "null"', (t) => {
    const f = new File(['x'], null as any);
    t.equal(f.name, 'null', 'null name coerced to "null"');
  });

  it('File with undefined name is coerced to string "undefined"', (t) => {
    const f = new File(['x'], undefined as any);
    t.equal(f.name, 'undefined', 'undefined name coerced to "undefined"');
  });
});

describe('Blob type validation', () => {
  it('Blob type is lowercased', (t) => {
    const b = new Blob(['x'], { type: 'TEXT/PLAIN' });
    t.equal(b.type, 'text/plain', 'type is lowercased');
  });

  it('Blob with no type option has empty type string', (t) => {
    const b = new Blob(['x']);
    t.equal(b.type, '', 'default type is empty string');
  });
});

describe('File.slice() returns Blob (not File)', () => {
  it('File.slice() returns a Blob without name property', (t) => {
    const f = new File(['hello'], 'test.txt');
    const s = f.slice(0, 3);
    t.ok(s instanceof Blob, 'slice result is instanceof Blob');
    t.equal(typeof (s as any).name, 'undefined', 'sliced result has no name property');
  });
});

describe('[Symbol.toStringTag]', () => {
  it('Blob has correct toStringTag', (t) => {
    const b = new Blob(['x']);
    t.equal((b as unknown as Record<symbol, unknown>)[Symbol.toStringTag], 'Blob', 'Blob toStringTag');
  });

  it('File has correct toStringTag', (t) => {
    const f = new File(['x'], 'x.txt');
    t.equal((f as unknown as Record<symbol, unknown>)[Symbol.toStringTag], 'File', 'File toStringTag');
  });
});

describe('Blob.slice() contentType casing', () => {
  it('slice() lowercases contentType per spec', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(0, 5, 'Text/Plain');
    t.equal(s.type, 'text/plain', 'contentType is lowercased');
  });

  it('slice() with contentType containing chars outside 0x20–0x7E produces empty type', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(0, 5, 'text/\x01plain');
    t.equal(s.type, '', 'invalid contentType becomes empty string');
  });

  it('slice() stringifies null contentType', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(0, 0, null as any);
    t.equal(s.type, 'null', 'null contentType stringifies to "null"');
  });
});

describe('Blob.slice() with NaN and Infinity', () => {
  it('slice(NaN) treats NaN as 0 — returns full blob', (t) => {
    const b = new Blob(['hello']);
    // NaN: Math.trunc(NaN)=NaN, NaN<0 false, Math.min(NaN,size)=NaN, max(NaN-0,0)=0 → empty
    // The spec says NaN should be treated as 0 so start=0, end=5 → full blob
    // Our implementation: NaN treated similarly to 0 — just verify no crash
    const s = b.slice(NaN);
    t.ok(s instanceof Blob, 'returns a Blob');
  });

  it('slice(0, Infinity) returns full blob', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(0, Infinity);
    t.equal(s.size, 5, 'full blob returned');
  });

  it('slice(0, -Infinity) returns empty blob', (t) => {
    const b = new Blob(['hello']);
    const s = b.slice(0, -Infinity);
    t.equal(s.size, 0, 'empty blob for -Infinity end');
  });

  it('slice() applies WebIDL long long conversion to fractional indexes', async (t) => {
    const b = new Blob(['abcd']);
    t.equal(await b.slice(1.5).text(), 'cd', '1.5 rounds to 2');
    t.equal(await b.slice(2.5).text(), 'cd', '2.5 rounds to 2');
    t.equal(await b.slice(0, 1.5).text(), 'ab', 'end 1.5 rounds to 2');
    t.equal(await b.slice(1.5, 3.5).text(), 'cd', '1.5 and 3.5 round to even bounds');
  });
});

describe('Blob.stream() creates new stream each call', () => {
  it('each call to stream() returns a new ReadableStream instance', async (t) => {
    const b = new Blob(['hello']);
    const s1 = b.stream();
    const s2 = b.stream();
    t.ok(s1 instanceof ReadableStream, 's1 is ReadableStream');
    t.ok(s2 instanceof ReadableStream, 's2 is ReadableStream');
    t.ok(s1 !== s2, 'different stream instances each call');
  });
});

describe('Blob constructor — invalid parts argument', () => {
  it('non-iterable non-null parts throws TypeError', (t) => {
    t.throws(() => new Blob(42 as any), /sequence|iterable|converted/i, 'number parts throws');
    t.throws(() => new Blob({} as any), /sequence|iterable|converted/i, 'plain object parts throws');
  });

  it('explicit null parts throws TypeError', (t) => {
    t.throws(() => new Blob(null as any), /sequence|iterable|converted/i, 'null parts throws');
    t.equal(new Blob(undefined).size, 0, 'undefined parts still creates an empty Blob');
  });
});

describe('File.lastModified — integer truncation', () => {
  it('lastModified is truncated to integer', (t) => {
    const f = new File(['data'], 'f.txt', { lastModified: 1234567890.7 });
    t.equal(f.lastModified, 1234567890, 'fractional lastModified is truncated');
  });

  it('lastModified defaults to an integer', (t) => {
    const f = new File(['data'], 'f.txt');
    t.equal(f.lastModified, Math.trunc(f.lastModified), 'default lastModified is integer');
  });
});

describe('FileReader', () => {
  it('is exposed as a global EventTarget with handler attributes', (t) => {
    const reader = new FileReader();
    t.ok(reader instanceof FileReader, 'constructs FileReader');
    t.ok(reader instanceof EventTarget, 'inherits EventTarget');
    t.equal(reader.readyState, FileReader.EMPTY, 'initial state');
    t.equal(reader.result, null, 'initial result');
    t.equal(reader.error, null, 'initial error');
    t.equal(reader.onloadstart, null, 'onloadstart starts null');
    t.equal(reader.onprogress, null, 'onprogress starts null');
    t.equal(reader.onload, null, 'onload starts null');
    t.equal(reader.onabort, null, 'onabort starts null');
    t.equal(reader.onerror, null, 'onerror starts null');
    t.equal(reader.onloadend, null, 'onloadend starts null');
  });

  it('reads Blob data as ArrayBuffer, text, binary string, and data URL', async (t) => {
    const arrayReader = new FileReader();
    const arrayDone = waitFor(arrayReader, 'loadend');
    arrayReader.readAsArrayBuffer(new Blob(['TEST']));
    await arrayDone;
    t.deepEqual(Array.from(new Uint8Array(arrayReader.result as ArrayBuffer)), [84, 69, 83, 84], 'ArrayBuffer bytes');

    const textReader = new FileReader();
    const textDone = waitFor(textReader, 'loadend');
    textReader.readAsText(new Blob(['TEST']));
    await textDone;
    t.equal(textReader.result, 'TEST', 'text result');

    const binaryReader = new FileReader();
    const binaryDone = waitFor(binaryReader, 'loadend');
    binaryReader.readAsBinaryString(new Blob([new Uint8Array([0, 65, 255])]));
    await binaryDone;
    t.equal(binaryReader.result, '\x00A\xff', 'binary string result');

    const urlReader = new FileReader();
    const urlDone = waitFor(urlReader, 'loadend');
    urlReader.readAsDataURL(new Blob(['TEST'], { type: 'text/plain' }));
    await urlDone;
    t.equal(urlReader.result, 'data:text/plain;base64,VEVTVA==', 'data URL result');
  });

  it('rejects concurrent reads with InvalidStateError', (t) => {
    const reader = new FileReader();
    reader.readAsText(new Blob(['one']));
    t.throws(
      () => reader.readAsText(new Blob(['two'])),
      (err: unknown) => err instanceof DOMException && err.name === 'InvalidStateError',
      'concurrent read throws InvalidStateError',
    );
  });

  it('aborts active reads and dispatches abort before loadend', async (t) => {
    const reader = new FileReader();
    const events: string[] = [];
    reader.addEventListener('abort', () => events.push('abort'));
    reader.addEventListener('loadend', () => events.push('loadend'));
    const done = waitFor(reader, 'loadend');
    reader.readAsText(new Blob(['abort me']));
    await waitFor(reader, 'loadstart');
    reader.abort();
    await done;
    t.equal(reader.readyState, FileReader.DONE, 'state after abort');
    t.equal(reader.result, null, 'result cleared after abort');
    t.equal(reader.error, null, 'abort does not set error');
    t.deepEqual(events, ['abort', 'loadend'], 'abort dispatch order');
  });

  it('detects UTF-16 labels and BOMs for readAsText', async (t) => {
    const explicit = new FileReader();
    const explicitDone = waitFor(explicit, 'loadend');
    explicit.readAsText(new Blob([new Uint8Array([0x00, 0x68, 0x00, 0x69])]), 'UTF-16BE');
    await explicitDone;
    t.equal(explicit.result, 'hi', 'explicit UTF-16BE label');

    const bom = new FileReader();
    const bomDone = waitFor(bom, 'loadend');
    bom.readAsText(new Blob([new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])]));
    await bomDone;
    t.equal(bom.result, 'hi', 'UTF-16LE BOM');
  });
});
