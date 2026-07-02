/**
* Tests for fino:format/flatbuffers — schema-less reader/writer round-trips.
*/
import { describe, it } from 'fino:test/test';
import { Builder, FlatBuffer, FlatbufferError } from 'fino:format/flatbuffers';
describe('flatbuffers scalars', () => {
  it('round-trips scalar fields of every width', (t) => {
    const b = new Builder();
    b.startTable(8);
    b.addFieldBool(0, true, false);
    b.addFieldInt8(1, -12, 0);
    b.addFieldInt16(2, -1234, 0);
    b.addFieldInt32(3, -123456, 0);
    b.addFieldInt64(4, -123456789012n, 0n);
    b.addFieldFloat32(5, 1.5, 0);
    b.addFieldFloat64(6, 3.14159, 0);
    b.addFieldInt32(7, 999, 0);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.equal(table.bool(0, false), true, 'bool');
    t.equal(table.i8(1, 0), -12, 'i8');
    t.equal(table.i16(2, 0), -1234, 'i16');
    t.equal(table.i32(3, 0), -123456, 'i32');
    t.equal(table.i64(4, 0n), -123456789012n, 'i64');
    t.equal(table.f32(5, 0), 1.5, 'f32');
    t.ok(Math.abs(table.f64(6, 0) - 3.14159) < 1e-9, 'f64');
    t.equal(table.i32(7, 0), 999, 'trailing i32');
  });
  it('omits fields equal to their default and returns the default on read', (t) => {
    const b = new Builder();
    b.startTable(3);
    b.addFieldInt32(0, 0, 0);
    b.addFieldInt32(1, 7, 0);
    b.addFieldInt32(2, 5, 5);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.equal(table.fieldPos(0), 0, 'field 0 absent from vtable');
    t.equal(table.i32(0, -1), -1, 'absent field returns supplied default');
    t.equal(table.i32(1, -1), 7, 'present field returns its value');
    t.equal(table.i32(2, 5), 5, 'defaulted field returns default');
  });
  it('honors forceDefaults', (t) => {
    const b = new Builder();
    b.forceDefaults(true);
    b.startTable(1);
    b.addFieldInt32(0, 0, 0);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.notEqual(table.fieldPos(0), 0, 'field written despite equalling default');
    t.equal(table.i32(0, -1), 0, 'reads the forced value');
  });
});
describe('flatbuffers strings and vectors', () => {
  it('round-trips a string field', (t) => {
    const b = new Builder();
    const s = b.createString('fino runtime ✓');
    b.startTable(1);
    b.addFieldOffset(0, s);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.equal(table.string(0), 'fino runtime ✓', 'utf-8 string round-trips');
  });
  it('returns null for an absent string field', (t) => {
    const b = new Builder();
    b.startTable(1);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.equal(table.string(0), null, 'absent string is null');
  });
  it('round-trips a scalar vector', (t) => {
    const b = new Builder();
    b.startVector(4, 3, 4);
    b.writeInt32(30);
    b.writeInt32(20);
    b.writeInt32(10);
    const vec = b.endVector();
    b.startTable(1);
    b.addFieldOffset(0, vec);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    const v = table.vector(0)!;
    t.equal(v.length, 3, 'length');
    t.deepEqual([
      v.i32(0),
      v.i32(1),
      v.i32(2)
    ], [
      10,
      20,
      30
    ], 'elements in order');
  });
  it('round-trips a byte vector as a zero-copy view', (t) => {
    const b = new Builder();
    const data = new Uint8Array([
      1,
      2,
      3,
      4,
      5
    ]);
    const vec = b.createByteVector(data);
    b.startTable(1);
    b.addFieldOffset(0, vec);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    t.deepEqual(Array.from(table.vector(0)!.bytes()), [
      1,
      2,
      3,
      4,
      5
    ], 'byte contents');
  });
  it('round-trips a vector of strings', (t) => {
    const b = new Builder();
    const a = b.createString('alpha');
    const c = b.createString('gamma');
    const bb = b.createString('beta');
    b.startVector(4, 3, 4);
    b.addOffset(c);
    b.addOffset(bb);
    b.addOffset(a);
    const vec = b.endVector();
    b.startTable(1);
    b.addFieldOffset(0, vec);
    b.finish(b.endTable());
    const table = FlatBuffer.from(b.bytes()).rootTable();
    const v = table.vector(0)!;
    t.deepEqual([
      v.string(0),
      v.string(1),
      v.string(2)
    ], [
      'alpha',
      'beta',
      'gamma'
    ], 'string elements');
  });
});
describe('flatbuffers nested tables and vtable dedup', () => {
  it('round-trips nested tables', (t) => {
    const b = new Builder();
    // Build two inner tables first (bottom-up).
    b.startTable(1);
    b.addFieldInt32(0, 111, 0);
    const inner1 = b.endTable();
    b.startTable(1);
    b.addFieldInt32(0, 222, 0);
    const inner2 = b.endTable();
    b.startTable(2);
    b.addFieldOffset(0, inner1);
    b.addFieldOffset(1, inner2);
    b.finish(b.endTable());
    const root = FlatBuffer.from(b.bytes()).rootTable();
    t.equal(root.table(0)!.i32(0, 0), 111, 'first child');
    t.equal(root.table(1)!.i32(0, 0), 222, 'second child');
  });
  it('deduplicates identical vtables', (t) => {
    const b = new Builder();
    const inners: number[] = [];
    for (let i = 0; i < 5; i++) {
      b.startTable(1);
      b.addFieldInt32(0, i, -1);
      inners.push(b.endTable());
    }
    b.startVector(4, inners.length, 4);
    for (let i = inners.length - 1; i >= 0; i--) b.addOffset(inners[i]!);
    const vec = b.endVector();
    b.startTable(1);
    b.addFieldOffset(0, vec);
    b.finish(b.endTable());
    const bytes = b.bytes();
    const root = FlatBuffer.from(bytes).rootTable();
    const v = root.vector(0)!;
    t.equal(v.length, 5, 'all children present');
    for (let i = 0; i < 5; i++) {
      t.equal(v.table(i).i32(0, -1), i, `child ${i} value`);
    }
    // Five identical-shape tables must not each carry their own vtable; a
    // naive writer would be substantially larger.
    t.ok(bytes.byteLength < 120, `deduped buffer stays small (${bytes.byteLength} bytes)`);
  });
});
describe('flatbuffers inline structs', () => {
  it('round-trips an inline struct field', (t) => {
    // struct Vec3 { x:float; y:float; z:float; } → 12 bytes, align 4.
    const b = new Builder();
    b.startTable(1);
    b.prep(4, 12);
    b.writeFloat32(3);
    b.writeFloat32(2);
    b.writeFloat32(1);
    b.addFieldStruct(0, b.offset());
    b.finish(b.endTable());
    const fb = FlatBuffer.from(b.bytes());
    const table = fb.rootTable();
    const pos = table.struct(0)!;
    t.equal(fb.f32At(pos), 1, 'x');
    t.equal(fb.f32At(pos + 4), 2, 'y');
    t.equal(fb.f32At(pos + 8), 3, 'z');
  });
});
describe('flatbuffers file identifier and size prefix', () => {
  it('stores and detects a file identifier', (t) => {
    const b = new Builder();
    b.startTable(1);
    b.addFieldInt32(0, 1, 0);
    b.finish(b.endTable(), { fileIdentifier: 'ARR1' });
    const fb = FlatBuffer.from(b.bytes());
    t.equal(fb.identifier(), 'ARR1', 'identifier round-trips');
    t.ok(fb.hasIdentifier('ARR1'), 'hasIdentifier positive');
    t.ok(!fb.hasIdentifier('NOPE'), 'hasIdentifier negative');
    t.equal(fb.rootTable().i32(0, 0), 1, 'root still readable with identifier');
  });
  it('round-trips a size-prefixed buffer', (t) => {
    const b = new Builder();
    const s = b.createString('prefixed');
    b.startTable(1);
    b.addFieldOffset(0, s);
    b.finish(b.endTable(), { sizePrefixed: true });
    const fb = FlatBuffer.from(b.bytes(), { sizePrefixed: true });
    t.equal(fb.rootTable().string(0), 'prefixed', 'reads through the size prefix');
  });
  it('rejects a bad file identifier length at write time', (t) => {
    const b = new Builder();
    b.startTable(1);
    b.addFieldInt32(0, 1, 0);
    t.throws(() => b.finish(b.endTable(), { fileIdentifier: 'TOOLONG' }), /exactly 4/, 'identifier length validated');
  });
});
describe('flatbuffers error handling', () => {
  it('throws FlatbufferError on an out-of-bounds root', (t) => {
    t.throws(() => FlatBuffer.from(new Uint8Array([2, 3])).rootTable(), FlatbufferError, 'short buffer');
  });
  it('throws FlatbufferError on a truncated size prefix', (t) => {
    t.throws(() => FlatBuffer.from(new Uint8Array([
      255,
      255,
      255,
      255,
      0
    ]), { sizePrefixed: true }), FlatbufferError, 'size prefix exceeds buffer');
  });
  it('throws on vector index out of range', (t) => {
    const b = new Builder();
    b.startVector(4, 2, 4);
    b.writeInt32(2);
    b.writeInt32(1);
    const vec = b.endVector();
    b.startTable(1);
    b.addFieldOffset(0, vec);
    b.finish(b.endTable());
    const v = FlatBuffer.from(b.bytes()).rootTable().vector(0)!;
    t.throws(() => v.i32(5), FlatbufferError, 'index past end');
  });
  it('throws when bytes() is called before finish()', (t) => {
    const b = new Builder();
    b.startTable(1);
    b.addFieldInt32(0, 1, 0);
    b.endTable();
    t.throws(() => b.bytes(), /before finish/, 'unfinished builder');
  });
});
