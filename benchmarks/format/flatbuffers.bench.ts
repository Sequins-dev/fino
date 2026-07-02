/**
* Benchmarks for fino:format/flatbuffers
*/
import { Builder, FlatBuffer } from 'fino:format/flatbuffers';
import { bench } from 'fino:bench';
function buildScalarTable(): Uint8Array {
  const b = new Builder();
  b.startTable(6);
  b.addFieldInt32(0, 1234, 0);
  b.addFieldInt64(1, 9876543210n, 0n);
  b.addFieldFloat64(2, 3.14159, 0);
  b.addFieldBool(3, true, false);
  b.addFieldInt16(4, -42, 0);
  b.addFieldInt8(5, 7, 0);
  b.finish(b.endTable());
  return b.bytes();
}
function buildStringVectorTable(n: number): Uint8Array {
  const b = new Builder();
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) offsets.push(b.createString(`item-${i}`));
  b.startVector(4, n, 4);
  for (let i = n - 1; i >= 0; i--) b.addOffset(offsets[i]!);
  const vec = b.endVector();
  b.startTable(1);
  b.addFieldOffset(0, vec);
  b.finish(b.endTable());
  return b.bytes();
}
function buildNestedTables(n: number): Uint8Array {
  const b = new Builder();
  const children: number[] = [];
  for (let i = 0; i < n; i++) {
    b.startTable(2);
    b.addFieldInt32(0, i, -1);
    b.addFieldInt32(1, i * 2, -1);
    children.push(b.endTable());
  }
  b.startVector(4, n, 4);
  for (let i = n - 1; i >= 0; i--) b.addOffset(children[i]!);
  const vec = b.endVector();
  b.startTable(1);
  b.addFieldOffset(0, vec);
  b.finish(b.endTable());
  return b.bytes();
}
const SCALAR_TABLE = buildScalarTable();
const STRING_VEC = buildStringVectorTable(1e3);
const NESTED = buildNestedTables(1e3);
bench('build', (b) => {
  b.measure('scalar table', () => buildScalarTable());
  b.measure('1K string vector', () => buildStringVectorTable(1e3));
  b.measure('1K nested tables (dedup vtable)', () => buildNestedTables(1e3));
});
bench('read', (b) => {
  b.measure('scalar fields', () => {
    const t = FlatBuffer.from(SCALAR_TABLE).rootTable();
    return t.i32(0, 0) + Number(t.i64(1, 0n)) + t.f64(2, 0);
  });
  b.measure('1K string vector scan', () => {
    const v = FlatBuffer.from(STRING_VEC).rootTable().vector(0)!;
    let total = 0;
    for (let i = 0; i < v.length; i++) total += v.string(i).length;
    return total;
  });
  b.measure('1K nested table scan', () => {
    const v = FlatBuffer.from(NESTED).rootTable().vector(0)!;
    let total = 0;
    for (let i = 0; i < v.length; i++) total += v.table(i).i32(0, 0);
    return total;
  });
});
