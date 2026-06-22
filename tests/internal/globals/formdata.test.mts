/**
 * Tests for the FormData global.
 */

import { describe, it } from 'fino:test/test';
import { _serializeFormData } from 'internal:globals/formdata';

type SymbolRecord = Record<symbol, unknown>;
type FormDataConstructor = {
  new (): FormData;
  new (formData: FormData): FormData;
};
const FormDataWithCopy = FormData as unknown as FormDataConstructor;
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('append / get', () => {
  it('FormData -- append and get string value', (t) => {
    const fd = new FormData();
    fd.append('name', 'Alice');
    t.equal(fd.get('name'), 'Alice');
  });

  it('FormData -- get returns null for missing key', (t) => {
    const fd = new FormData();
    t.equal(fd.get('missing'), null);
  });

  it('FormData -- append coerces non-string values', (t) => {
    const fd = new FormData();
    (fd as any).append('n', 42);
    t.equal(fd.get('n'), '42', 'number coerced to string');
  });

  it('FormData -- append multiple values for same key', (t) => {
    const fd = new FormData();
    fd.append('x', 'a');
    fd.append('x', 'b');
    t.equal(fd.get('x'), 'a', 'get returns first');
  });
});

describe('getAll', () => {
  it('FormData -- getAll returns all values for key', (t) => {
    const fd = new FormData();
    fd.append('x', 'a');
    fd.append('x', 'b');
    fd.append('y', 'c');
    t.deepEqual(fd.getAll('x'), ['a', 'b']);
    t.deepEqual(fd.getAll('y'), ['c']);
    t.deepEqual(fd.getAll('z'), []);
  });
});

describe('has', () => {
  it('FormData -- has returns true/false', (t) => {
    const fd = new FormData();
    fd.append('k', 'v');
    t.equal(fd.has('k'), true);
    t.equal(fd.has('missing'), false);
  });
});

describe('set', () => {
  it('FormData -- set replaces existing entries for that key', (t) => {
    const fd = new FormData();
    fd.append('x', 'a');
    fd.append('x', 'b');
    fd.set('x', 'c');
    t.deepEqual(fd.getAll('x'), ['c'], 'only one entry remains');
  });

  it('FormData -- set appends when key not present', (t) => {
    const fd = new FormData();
    fd.set('x', 'v');
    t.equal(fd.get('x'), 'v');
  });

  it('FormData -- set preserves other keys', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.set('a', '3');
    t.equal(fd.get('a'), '3');
    t.equal(fd.get('b'), '2');
  });
});

describe('delete', () => {
  it('FormData -- delete removes all entries for key', (t) => {
    const fd = new FormData();
    fd.append('x', 'a');
    fd.append('x', 'b');
    fd.append('y', 'c');
    fd.delete('x');
    t.equal(fd.has('x'), false);
    t.equal(fd.has('y'), true);
  });

  it('FormData -- delete non-existent key is a no-op', (t) => {
    const fd = new FormData();
    fd.delete('nope'); // should not throw
    t.ok(true, 'no throw');
  });
});

describe('Blob and File values', () => {
  it('FormData -- append Blob wraps to File', (t) => {
    const fd = new FormData();
    const b = new Blob(['data'], { type: 'text/plain' });
    fd.append('file', b);
    const v = fd.get('file');
    t.ok(v instanceof File, 'value is File');
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'blob', 'default filename is "blob"');
    t.equal(v.type, 'text/plain');
  });

  it('FormData -- append Blob with explicit filename', (t) => {
    const fd = new FormData();
    const b = new Blob(['data']);
    fd.append('file', b, 'upload.txt');
    const v = fd.get('file');
    t.ok(v instanceof File, 'is File');
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'upload.txt');
  });

  it('FormData -- append File keeps original name', (t) => {
    const fd = new FormData();
    const f = new File(['data'], 'original.txt');
    fd.append('file', f);
    const v = fd.get('file');
    t.ok(v instanceof File);
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'original.txt');
  });

  it('FormData -- append File with override filename', (t) => {
    const fd = new FormData();
    const f = new File(['data'], 'original.txt');
    fd.append('file', f, 'override.txt');
    const v = fd.get('file');
    t.ok(v instanceof File, 'is File');
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'override.txt');
  });
});

describe('iteration', () => {
  it('FormData -- entries() iterates [name, value] pairs', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    const pairs: Array<[string, FormDataEntryValue]> = [];
    for (const pair of fd.entries()) pairs.push(pair);
    t.deepEqual(pairs, [['a', '1'], ['b', '2']]);
  });

  it('FormData -- keys() iterates names', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    const ks: string[] = [];
    for (const k of fd.keys()) ks.push(k);
    t.deepEqual(ks, ['a', 'b']);
  });

  it('FormData -- values() iterates values', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    const vs: FormDataEntryValue[] = [];
    for (const v of fd.values()) vs.push(v);
    t.deepEqual(vs, ['1', '2']);
  });

  it('FormData -- for...of uses entries()', (t) => {
    const fd = new FormData();
    fd.append('x', 'hello');
    const pairs: Array<[string, FormDataEntryValue]> = [];
    for (const pair of fd) pairs.push(pair);
    t.deepEqual(pairs, [['x', 'hello']]);
  });

  it('FormData -- forEach iterates (value, key, fd)', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    const results: Array<[string, FormDataEntryValue, boolean]> = [];
    fd.forEach((value, key, ref) => {
      results.push([key, value, ref === fd]);
    });
    t.deepEqual(results, [['a', '1', true], ['b', '2', true]]);
  });

  it('FormData -- entries() observes entries appended during iteration', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');

    const iterator = fd.entries();
    t.deepEqual(iterator.next().value, ['a', '1'], 'first entry returned');
    fd.append('c', '3');

    t.deepEqual(iterator.next().value, ['b', '2'], 'existing second entry returned');
    t.deepEqual(iterator.next().value, ['c', '3'], 'appended entry is visible');
    t.equal(iterator.next().done, true, 'iterator completes after live entries');
  });

  it('FormData -- keys() and values() observe deleted entries during iteration', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.append('c', '3');

    const keys = fd.keys();
    const values = fd.values();
    t.equal(keys.next().value, 'a', 'first key returned');
    t.equal(values.next().value, '1', 'first value returned');

    fd.delete('b');

    t.equal(keys.next().value, 'c', 'deleted key is skipped');
    t.equal(values.next().value, '3', 'deleted value is skipped');
    t.equal(keys.next().done, true, 'keys iterator completes');
    t.equal(values.next().done, true, 'values iterator completes');
  });

  it('FormData -- default iterator observes live mutations', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');

    const iterator = fd[Symbol.iterator]();
    t.deepEqual(iterator.next().value, ['a', '1'], 'first entry returned');
    fd.delete('b');
    fd.append('c', '3');

    t.deepEqual(iterator.next().value, ['c', '3'], 'default iterator uses current entries');
    t.equal(iterator.next().done, true, 'default iterator completes');
  });

  it('FormData -- forEach observes live append and delete mutations', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');

    const seen: Array<[string, FormDataEntryValue]> = [];
    fd.forEach((value, key) => {
      seen.push([key, value]);
      if (key === 'a') {
        fd.delete('b');
        fd.append('c', '3');
      }
    });

    t.deepEqual(seen, [['a', '1'], ['c', '3']], 'forEach follows the current entry list');
  });
});

describe('set() with Blob/File values', () => {
  it('set() with a Blob value creates a File entry', (t) => {
    const fd = new FormData();
    const b = new Blob(['data'], { type: 'text/plain' });
    fd.set('f', b);
    const v = fd.get('f');
    t.ok(v instanceof File, 'set Blob entry is a File');
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'blob', 'default filename is "blob"');
    t.equal(v.type, 'text/plain', 'type preserved');
  });

  it('set() with a File value and no filename preserves the File and its name', (t) => {
    const fd = new FormData();
    const f = new File(['data'], 'myfile.txt', { type: 'application/octet-stream' });
    fd.set('upload', f);
    const v = fd.get('upload');
    t.ok(v instanceof File, 'value is File');
    if (!(v instanceof File)) throw new Error('expected File');
    t.equal(v.name, 'myfile.txt', 'original name preserved');
  });

  it('multiple set() calls for the same key: only the last value remains', (t) => {
    const fd = new FormData();
    fd.set('x', 'first');
    fd.set('x', 'second');
    fd.set('x', 'third');
    t.deepEqual(fd.getAll('x'), ['third'], 'only last value kept');
  });
});

describe('forEach with thisArg', () => {
  it('forEach respects thisArg parameter', (t) => {
    const fd = new FormData();
    fd.append('k', 'v');
    const ctx = { count: 0 };
    fd.forEach(function(this: typeof ctx) { this.count++; }, ctx);
    t.equal(ctx.count, 1, 'thisArg used as `this` in callback');
  });
});

describe('name coercion', () => {
  it('numeric name is coerced to string: fd.append(123, "val")', (t) => {
    const fd = new FormData();
    (fd as any).append(123, 'val');
    t.equal(fd.get('123'), 'val', 'numeric name coerced to string');
  });
});

describe('empty FormData iteration', () => {
  it('[...new FormData()] is an empty array', (t) => {
    const fd = new FormData();
    const entries = [...fd];
    t.deepEqual(entries, [], 'no entries in empty FormData');
  });
});

describe('set() position preservation', () => {
  it('set() replaces at the position of the first match, preserving order of other keys', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    fd.append('b', '2');
    fd.append('a', '3'); // duplicate a
    fd.append('c', '4');
    fd.set('a', 'new');
    // Expected: a is replaced at position 0, duplicate a=3 removed, b and c preserved
    const keys: string[] = [];
    for (const [k] of fd) keys.push(k);
    t.deepEqual(keys, ['a', 'b', 'c'], 'a replaced at first position, order preserved');
    t.equal(fd.get('a'), 'new', 'a has new value');
    t.equal(fd.get('b'), '2', 'b preserved');
    t.equal(fd.get('c'), '4', 'c preserved');
  });
});

describe('FormData iteration completeness', () => {
  it('iterating FormData with multiple values for same key preserves all', (t) => {
    const fd = new FormData();
    fd.append('x', '1');
    fd.append('y', '2');
    fd.append('x', '3');
    const all: [string, string][] = [];
    for (const [k, v] of fd) all.push([k, v as string]);
    t.deepEqual(all, [['x', '1'], ['y', '2'], ['x', '3']], 'all entries in insertion order');
  });
});

describe('[Symbol.toStringTag]', () => {
  it('FormData has correct toStringTag', (t) => {
    const fd = new FormData();
    t.equal((fd as unknown as SymbolRecord)[Symbol.toStringTag], 'FormData', 'FormData toStringTag');
  });
});

describe('CRLF normalization', () => {
  it('lone \\n is normalized to \\r\\n', (t) => {
    const fd = new FormData();
    fd.append('k', 'line1\nline2');
    t.equal(fd.get('k'), 'line1\r\nline2', 'lone LF → CRLF');
  });

  it('lone \\r is normalized to \\r\\n', (t) => {
    const fd = new FormData();
    fd.append('k', 'line1\rline2');
    t.equal(fd.get('k'), 'line1\r\nline2', 'lone CR → CRLF');
  });

  it('\\r\\n is kept as \\r\\n (not doubled)', (t) => {
    const fd = new FormData();
    fd.append('k', 'line1\r\nline2');
    t.equal(fd.get('k'), 'line1\r\nline2', 'CRLF unchanged');
  });

  it('set() also normalizes string values', (t) => {
    const fd = new FormData();
    fd.set('k', 'a\nb');
    t.equal(fd.get('k'), 'a\r\nb', 'set() also normalizes');
  });

  it('Blob values are not CRLF-normalized', (t) => {
    const fd = new FormData();
    const b = new Blob(['line1\nline2'], { type: 'text/plain' });
    fd.append('f', b);
    // Blob values are stored as File — content is not modified
    const v = fd.get('f') as File;
    t.ok(v instanceof File, 'is File');
    t.equal(v.size, 11, 'Blob content not normalized');
  });

  it('entry names are CRLF-normalized too', (t) => {
    const fd = new FormData();
    fd.append('key\nname', 'value');
    // Per spec, the name is CRLF-normalized
    t.equal(fd.get('key\r\nname'), 'value', 'name with \\n normalized to \\r\\n');
    t.equal(fd.get('key\nname'), null, 'original non-normalized name not found');
  });
});

describe('FormData — forEach validation', () => {
  it('forEach throws TypeError for non-function callback', (t) => {
    const fd = new FormData();
    fd.append('a', '1');
    t.throws(() => (fd.forEach as any)('not a function'), undefined, 'non-function throws');
  });
});

describe('FormData [Symbol.toStringTag]', () => {
  it('[Symbol.toStringTag] is "FormData"', (t) => {
    const fd = new FormData();
    t.equal((fd as unknown as SymbolRecord)[Symbol.toStringTag], 'FormData', '[Symbol.toStringTag] correct');
  });
});

describe('FormData copy constructor Fino extension', () => {
  it('new FormData(existingFormData) copies all entries as a Fino extension', (t) => {
    const src = new FormData();
    src.append('a', '1');
    src.append('b', '2');
    src.append('a', '3');
    const copy = new FormDataWithCopy(src);
    t.deepEqual(copy.getAll('a'), ['1', '3'], 'all a values copied');
    t.equal(copy.get('b'), '2', 'b copied');
  });

  it('Fino extension copy is independent when mutating copy', (t) => {
    const src = new FormData();
    src.append('x', 'original');
    const copy = new FormDataWithCopy(src);
    copy.set('x', 'modified');
    t.equal(src.get('x'), 'original', 'source unchanged');
    t.equal(copy.get('x'), 'modified', 'copy has new value');
  });

  it('Fino extension copy is independent when mutating source', (t) => {
    const src = new FormData();
    src.append('x', 'original');
    const copy = new FormDataWithCopy(src);
    src.set('x', 'changed');
    t.equal(copy.get('x'), 'original', 'copy unaffected by source mutation');
  });

  it('new FormData() with no arg creates empty instance', (t) => {
    const fd = new FormData();
    t.deepEqual([...fd], [], 'empty FormData from no-arg constructor');
  });
});

describe('multipart serialization', () => {
  it('escapes field names and filenames without injecting headers', async (t) => {
    const fd = new FormData();
    fd.append('field"\r\nX-Injected: yes', 'value');
    fd.append('upload', new File(['file'], 'avatar"\nContent-Type: text/html\r\nx.txt', { type: 'text/plain' }));

    const { contentType, body } = await _serializeFormData(fd, 'fixed-boundary');
    const wire = decodeUtf8(body);

    t.equal(contentType, 'multipart/form-data; boundary=fixed-boundary', 'content type uses supplied boundary');
    t.ok(wire.includes('name="field%22%0D%0AX-Injected%3A%20yes"'), 'field name is parameter-escaped');
    t.ok(wire.includes('filename="avatar%22%0D%0AContent-Type%3A%20text%2Fhtml%0D%0Ax.txt"'), 'filename is parameter-escaped');
    t.equal(wire.includes('X-Injected: yes'), false, 'field name cannot inject a header line');
    t.equal(wire.includes('Content-Type: text/html'), false, 'filename cannot inject a header line');
    t.ok(wire.includes('Content-Type: text/plain\r\n\r\nfile'), 'actual file content type remains intact');
  });

  it('generates strong unique multipart boundaries when omitted', async (t) => {
    const first = await _serializeFormData(new FormData());
    const second = await _serializeFormData(new FormData());
    const prefix = 'multipart/form-data; boundary=----fino-formdata-';

    t.ok(first.contentType.startsWith(prefix), 'first boundary uses fino multipart prefix');
    t.ok(second.contentType.startsWith(prefix), 'second boundary uses fino multipart prefix');
    t.notEqual(first.contentType, second.contentType, 'generated boundaries are unique');
    t.equal(/Math|random|undefined/.test(first.contentType), false, 'boundary does not expose weak generator details');
  });
});
