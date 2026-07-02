/**
* Benchmarks for fino:data/arrow (build, IPC, C Data Interface).
*/
import * as arrow from 'fino:data/arrow';
import { exportVector, importVector } from 'fino:data/arrow/cdata';
import { Field } from 'fino:data/arrow';
import { bench } from 'fino:bench';
const N = 1e5;
const ints = Array.from({ length: N }, (_, i) => i);
const strings = Array.from({ length: N }, (_, i) => `item-${i % 1e3}`);
const intVec = arrow.vectorFromArray(ints, arrow.int32());
const strVec = arrow.vectorFromArray(strings, arrow.utf8());
const batch = new arrow.RecordBatch(arrow.Schema.from({
  id: arrow.int32(),
  name: arrow.utf8()
}), [intVec, strVec]);
const rawBuffers: arrow.VectorData = {
  type: arrow.int32(),
  length: N,
  values: new Uint8Array(new Int32Array(ints).buffer)
};
const streamBytes = arrow.tableToIPC(batch);
bench('build', (b) => {
  b.measure('vectorFromArray int32 (100K)', () => arrow.vectorFromArray(ints, arrow.int32()));
  b.measure('makeVector int32 from raw buffers (100K)', () => arrow.makeVector(rawBuffers));
  b.measure('vectorFromArray utf8 (100K)', () => arrow.vectorFromArray(strings, arrow.utf8()));
});
bench('ipc', (b) => {
  b.measure('write stream (100K × 2 cols)', () => arrow.tableToIPC(batch));
  b.measure('read stream (100K × 2 cols)', () => arrow.tableFromIPC(streamBytes));
});
bench('scan', (b) => {
  b.measure('get() over 100K int32', () => {
    let sum = 0;
    for (let i = 0; i < intVec.length; i++) sum += intVec.get(i) as number;
    return sum;
  });
});
bench('cdata', (b) => {
  b.measure('export + import int32 (100K)', () => {
    const { schema, array } = exportVector(intVec, new Field('c', arrow.int32(), false));
    const imported = importVector(schema, array);
    const v = imported.value.get(0);
    imported.release();
    return v;
  });
});
