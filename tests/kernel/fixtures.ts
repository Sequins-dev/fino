/** Shared handwritten kernels: no tensor templates or device driver dependencies. */
import { E, KernelBuilder, vt } from 'internal:kernel/ir';

export function fixtures() {
  const copy = new KernelBuilder('copy_values', [32, 1, 1]);
  copy.buffer('input', vt('f32'), 'read');
  copy.buffer('output', vt('f32'), 'write');
  copy.gridStride(copy.param('count'), (i) =>
    copy.store('output', i, E.add(E.load('input', i), E.f32(2))),
  );

  const structured = new KernelBuilder('shared_sum', [32, 1, 1]);
  structured.buffer('output', vt('f32'), 'write');
  structured.shared('scratch', 'f32', 32);
  structured.shstore('scratch', E.builtin('localId'), E.f32(1));
  structured.barrier();
  structured.if(E.eq(E.builtin('localId'), E.u32(0)), () => {
    structured.var('sum', vt('f32'), E.f32(0));
    structured.for('i', E.u32(0), E.u32(32), E.u32(1), (i) => {
      structured.if(E.lt(i, E.u32(16)), () => {
        structured.assign('sum', E.add(E.var('sum'), E.shload('scratch', i)));
      });
    });
    structured.store('output', E.builtin('groupId'), E.var('sum'));
  });

  const vector = new KernelBuilder('vector_math', [32, 1, 1]);
  vector.buffer('input', vt('f32', 4), 'read');
  vector.buffer('output', vt('f32', 4), 'write');
  const x = vector.let('x', vt('f32', 4), E.load('input', E.builtin('globalId')));
  const y = E.call('sqrt', E.add(E.mul(x, x), E.f32(1)));
  vector.store('output', E.builtin('globalId'), E.select(E.gt(x, E.f32(0)), y, x));

  const math = new KernelBuilder('scalar_math', [1, 1, 1]);
  math.buffer('output', vt('f32'), 'write');
  math.store('output', E.u32(0), E.mod(E.call('pow', E.f32(-3.5), E.f32(2)), E.f32(2)));
  math.store('output', E.u32(1), E.bitcast(vt('f32'), E.u32(1065353216)));
  math.store('output', E.u32(2), E.cast(vt('f32'), E.i32(-3)));

  const vectors = new KernelBuilder('vector_values', [1, 1, 1]);
  vectors.buffer('output', vt('f32', 2), 'write');
  vectors.store('output', E.u32(0), E.const(vt('f32', 2), 2));
  vectors.store('output', E.u32(1), E.vec(vt('f32', 2), [E.f32(1), E.f32(2)]));

  const atomic = new KernelBuilder('atomic_sum', [32, 1, 1]);
  atomic.buffer('output', vt('u32'), 'readwrite');
  atomic.atomicAdd('output', E.u32(0), E.u32(1));
  return [
    copy.build(),
    structured.build(),
    vector.build(),
    math.build(),
    vectors.build(),
    atomic.build(),
  ];
}
