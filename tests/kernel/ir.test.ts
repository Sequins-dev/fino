/** Contracts for the target-independent kernel IR. */
import { describe, it } from 'fino:test/test';
import { E, KernelBuilder, packParams, paramOffset, validateKernel, vt } from 'internal:kernel/ir';

const f32 = vt('f32');
const u32 = vt('u32');
function kernel() {
  const b = new KernelBuilder('copy', [32, 1, 1]);
  b.buffer('input', f32, 'read');
  b.buffer('output', f32, 'write');
  return b;
}

describe('kernel IR construction', () => {
  it('builds a typed grid-stride kernel without a target', (t) => {
    const b = kernel();
    const n = b.param('count');
    b.gridStride(n, (i) => b.store('output', i, E.load('input', i)));
    const ir = b.build();
    t.equal(ir.body[0].k, 'for');
    t.deepEqual(ir.wg, [32, 1, 1]);
    t.deepEqual(structuredClone(ir), ir, 'IR contains only transferable data');
    validateKernel(ir);
  });
  it('returns independent snapshots', (t) => {
    const b = kernel();
    const first = b.build();
    b.comment('later');
    first.buffers[0].name = 'changed';
    t.equal(first.body.length, 0);
    t.equal(b.build().buffers[0].name, 'input');
  });
  it('restores the block stack when a callback throws', (t) => {
    const b = kernel();
    t.throws(
      () =>
        b.if(E.bool(true), () => {
          throw new Error('fixture');
        }),
      /fixture/,
    );
    t.throws(
      () =>
        b.for('i', E.u32(0), E.u32(2), E.u32(1), () => {
          throw new Error('fixture');
        }),
      /fixture/,
    );
    b.comment('root');
    t.equal(b.build().body.length, 1);
  });
  it('does not impose one device workgroup or push-constant limit', (t) => {
    const b = new KernelBuilder('large', [2048, 1, 1]);
    for (let i = 0; i < 40; i++) b.param(`p${i}`);
    t.equal(b.build().params.length, 40);
  });
  it('packs typed parameters with explicit offsets', (t) => {
    const params = [
      { name: 'n', type: 'u32' as const },
      { name: 'x', type: 'f32' as const },
      { name: 's', type: 'i32' as const },
    ];
    const view = new DataView(packParams(params, { n: 7, x: 0.5, s: -3 }));
    t.equal(view.getUint32(0, true), 7);
    t.equal(view.getFloat32(4, true), 0.5);
    t.equal(view.getInt32(8, true), -3);
    t.equal(paramOffset(params, 's'), 8);
    t.throws(() => packParams(params, {}), /missing/);
    t.throws(() => packParams(params, { n: -1, x: 1, s: 1 }), /range|u32/);
    t.throws(() => paramOffset(params, 'absent'), /unknown/);
  });
});

describe('kernel IR validation', () => {
  it('rejects invalid workgroup dimensions and declaration names', (t) => {
    for (const n of [0, -1, 1.5, NaN, Infinity]) {
      t.throws(() => new KernelBuilder('bad', [n, 1, 1]).build(), /workgroup/);
    }
    const b = kernel();
    b.param('input');
    t.throws(() => b.build(), /duplicate|collid/);
    t.throws(() => new KernelBuilder('bad-name').build(), /identifier/);
  });
  it('rejects wrong expression and initializer types', (t) => {
    const b = kernel();
    b.let('x', f32, E.add(E.f32(1), E.u32(1)));
    t.throws(() => b.build(), /mixes|type/);
    const c = kernel();
    c.let('x', f32, E.u32(1));
    t.throws(() => c.build(), /type|expected/);
  });
  it('enforces binding access, index and store types', (t) => {
    for (const fill of [
      (b: KernelBuilder) => b.store('input', E.u32(0), E.f32(1)),
      (b: KernelBuilder) => b.store('output', E.f32(0), E.f32(1)),
      (b: KernelBuilder) => b.store('output', E.u32(0), E.u32(1)),
      (b: KernelBuilder) => b.let('x', f32, E.load('output', E.u32(0))),
    ]) {
      const b = kernel();
      fill(b);
      t.throws(() => b.build(), /read|write|index|type|expected/);
    }
  });
  it('keeps block-local bindings out of sibling and parent scopes', (t) => {
    const b = kernel();
    b.if(E.bool(true), () => b.let('hidden', f32, E.f32(1)));
    b.store('output', E.u32(0), E.let('hidden'));
    t.throws(() => b.build(), /scope/);
    const c = kernel();
    c.for('i', E.u32(0), E.u32(2), E.u32(1), () => {});
    c.let('x', u32, E.var('i'));
    t.throws(() => c.build(), /scope/);
  });
  it('rejects assignment to immutable bindings and duplicate locals', (t) => {
    const b = kernel();
    b.let('x', f32, E.f32(0));
    b.assign('x', E.f32(1));
    t.throws(() => b.build(), /mutable/);
    const c = kernel();
    c.let('x', f32, E.f32(0));
    c.let('x', f32, E.f32(1));
    t.throws(() => c.build(), /duplicate/);
  });
  it('validates shared memory and mutable loop state', (t) => {
    const b = kernel();
    b.shared('scratch', 'f32', 32);
    b.shstore('scratch', E.builtin('localId'), E.f32(2));
    b.barrier();
    b.var('sum', f32, E.f32(0));
    b.for('i', E.u32(0), E.u32(32), E.u32(1), (i) => {
      b.assign('sum', E.add(E.var('sum'), E.shload('scratch', i)));
    });
    b.store('output', E.u32(0), E.var('sum'));
    t.equal(b.build().shared[0].length, 32);
  });
  it('rejects invalid operators, vector lanes, selects, and casts', (t) => {
    const invalid = [
      E.bin('and', E.f32(1), E.f32(2)),
      E.call('pow', E.f32(1)),
      E.vec(vt('f32', 2), [E.u32(1), E.f32(2)]),
      E.select(E.bool(true), E.f32(1), E.const(vt('f32', 2), 2)),
      E.lane(E.f32(1), 1),
      E.bitcast(vt('u32', 2), E.f32(1)),
    ];
    for (const value of invalid) {
      const b = kernel();
      b.let('x', f32, value);
      t.throws(() => b.build(), /operator|argument|lane|type|select|width|expected/);
    }
  });
});
