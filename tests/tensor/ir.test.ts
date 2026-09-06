/**
 * Tests for internal:tensor/ir — the dialect-neutral kernel IR.
 *
 * The load-bearing assertion in this file is that the *same* IR value lowers to
 * both dialects. That is the property the whole two-layer design rests on, and
 * the one that quietly stops being true if a template ever reaches for a
 * dialect-specific escape hatch.
 */
import { describe, it } from 'fino:test/test';
import {
  DEFAULT_TILING,
  E,
  KernelBuilder,
  SMALL_TILING,
  binaryKernel,
  broadcastShapes,
  cacheKeyHash,
  cacheKeyText,
  castKernel,
  classifyOperands,
  collapseAxes,
  contiguousStrides,
  fnv1a64,
  gemmGrid,
  gemmIsExact,
  gemmKernel,
  lowerToMSL,
  lowerToSPIRV,
  packParams,
  specKey,
  unaryKernel,
  vt,
} from 'internal:tensor/ir';
import { Op, countOp, disassemble } from 'internal:spirv';

describe('shape and layout analysis', () => {
  it('computes contiguous strides', (t) => {
    t.deepEqual(contiguousStrides([2, 3, 4]), [12, 4, 1], 'row-major strides');
    t.deepEqual(contiguousStrides([]), [], 'rank 0 has no strides');
  });
  it('broadcasts shapes per NumPy rules', (t) => {
    t.deepEqual(broadcastShapes([3, 1], [3, 4]), [3, 4], 'size-1 axis stretches');
    t.deepEqual(broadcastShapes([4], [3, 4]), [3, 4], 'rank is left-padded');
    t.deepEqual(broadcastShapes([], [2, 2]), [2, 2], 'scalar broadcasts to anything');
  });
  it('names the axis when shapes are incompatible', (t) => {
    t.throws(
      () => broadcastShapes([3, 2], [3, 4]),
      /axis 1 has sizes 2 and 4/,
      'error identifies the offending axis and sizes',
    );
  });
  it('collapses contiguous axes', (t) => {
    const out = collapseAxes([2, 3, 4], [contiguousStrides([2, 3, 4])]);
    t.deepEqual(out.shape, [24], 'fully contiguous collapses to one axis');
  });
  it('keeps axes separate when an operand breaks contiguity', (t) => {
    // Second operand is broadcast along the middle axis.
    const out = collapseAxes(
      [2, 3, 4],
      [
        [12, 4, 1],
        [4, 0, 1],
      ],
    );
    t.ok(out.shape.length > 1, `broadcast axis prevents a full collapse (${out.shape})`);
  });
  it('classifies matching shapes as contiguous', (t) => {
    const { layouts, count } = classifyOperands(
      [2, 3],
      [
        [2, 3],
        [2, 3],
      ],
    );
    t.equal(count, 6, 'element count');
    t.deepEqual(
      layouts.map((l) => l.class),
      ['cont', 'cont'],
      'both operands are contiguous',
    );
  });
  it('classifies a full broadcast as scalar', (t) => {
    const { layouts } = classifyOperands([4, 5], [[4, 5], []]);
    t.equal(layouts[1]!.class, 'scalar', 'rank-0 operand is scalar');
  });
  it('classifies a trailing-axis broadcast as outer', (t) => {
    // [N,1] against [N,M]: each element of the first spans M outputs.
    const { layouts } = classifyOperands(
      [4, 5],
      [
        [4, 5],
        [4, 1],
      ],
    );
    t.equal(layouts[1]!.class, 'outerBroadcast', 'column vector is an outer broadcast');
    t.equal(layouts[1]!.inner, 5, 'inner span is the row length');
  });
  it('classifies a leading-axis broadcast as inner', (t) => {
    // [1,M] against [N,M]: the row repeats, so index is i % M.
    const { layouts } = classifyOperands(
      [4, 5],
      [
        [4, 5],
        [1, 5],
      ],
    );
    t.equal(layouts[1]!.class, 'innerBroadcast', 'row vector is an inner broadcast');
    t.equal(layouts[1]!.inner, 5, 'inner span is the row length');
  });
});

describe('kernel parameter packing', () => {
  it('lays parameters out at 4-byte offsets', (t) => {
    const params = [
      { name: 'n', type: 'u32' as const },
      { name: 'alpha', type: 'f32' as const },
      { name: 'shift', type: 'i32' as const },
    ];
    const buf = packParams(params, { n: 7, alpha: 0.5, shift: -3 });
    t.equal(buf.byteLength, 12, 'three 4-byte fields');
    const view = new DataView(buf);
    t.equal(view.getUint32(0, true), 7, 'u32 field');
    t.equal(view.getFloat32(4, true), 0.5, 'f32 field');
    t.equal(view.getInt32(8, true), -3, 'i32 field');
  });
  it('rejects a missing value', (t) => {
    t.throws(
      () => packParams([{ name: 'n', type: 'u32' }], {}),
      /missing value for kernel parameter 'n'/,
      'missing parameter throws by name',
    );
  });
  it('rejects a block over the push-constant limit', (t) => {
    const params = Array.from({ length: 40 }, (_, i) => ({
      name: `p${i}`,
      type: 'u32' as const,
    }));
    const values = Object.fromEntries(params.map((p) => [p.name, 0]));
    t.throws(() => packParams(params, values), /over the 128-byte limit/, '160 bytes rejected');
  });
});

describe('kernel validation', () => {
  it('rejects an oversized workgroup', (t) => {
    const b = new KernelBuilder('too_big', [1024, 2, 1]);
    t.throws(() => b.build(), /exceeds 1024/, 'workgroup size is checked');
  });
  it('rejects duplicate binding names', (t) => {
    const b = new KernelBuilder('dup');
    b.buffer('x', vt('f32'), 'read');
    b.buffer('x', vt('f32'), 'write');
    t.throws(() => b.build(), /duplicate binding name 'x'/, 'duplicate names are caught');
  });
  it('rejects a parameter colliding with a binding', (t) => {
    const b = new KernelBuilder('collide');
    b.buffer('n', vt('f32'), 'read');
    b.param('n');
    t.throws(() => b.build(), /collides with a binding/, 'namespace collision is caught');
  });
});

describe('type checking', () => {
  it('rejects mixing scalar types without a cast', (t) => {
    const b = new KernelBuilder('mixed');
    b.buffer('f', vt('f32'), 'read');
    b.buffer('o', vt('f32'), 'write');
    b.store('o', E.u32(0), E.add(E.load('f', E.u32(0)), E.u32(1)));
    const ir = b.build();
    t.throws(() => lowerToMSL(ir), /mixes f32 and u32/, 'implicit promotion is refused');
  });
  it('rejects a width-changing bitcast', (t) => {
    const b = new KernelBuilder('badcast');
    b.buffer('o', vt('f32'), 'write');
    b.store('o', E.u32(0), E.bitcast(vt('f32'), E.const(vt('u8'), 1)));
    t.throws(() => lowerToMSL(b.build()), /bitcast changes width/, 'width mismatch is caught');
  });
  it('rejects a non-boolean select condition', (t) => {
    const b = new KernelBuilder('badsel');
    b.buffer('o', vt('f32'), 'write');
    b.store('o', E.u32(0), E.select(E.u32(1), E.f32(1), E.f32(2)));
    t.throws(() => lowerToMSL(b.build()), /select condition must be bool/, 'condition is typed');
  });
});

describe('cache keys', () => {
  it('hashes to 16 stable hex digits', (t) => {
    const a = fnv1a64('hello');
    t.equal(a.length, 16, 'full 64 bits rendered');
    t.equal(a, fnv1a64('hello'), 'deterministic');
    t.notEqual(a, fnv1a64('hellp'), 'sensitive to input');
  });
  it('matches the published FNV-1a 64 test vector', (t) => {
    // The reference basis hashed against the empty string is the offset basis.
    t.equal(fnv1a64(''), 'cbf29ce484222325', 'empty string is the offset basis');
  });
  it('drops absent and false fields from a spec key', (t) => {
    t.equal(specKey('ew', { op: 'add', vec: undefined }), 'ew|op=add', 'undefined omitted');
    t.equal(specKey('ew', { guards: false }), 'ew', 'false omitted');
    t.equal(specKey('ew', { guards: true }), 'ew|guards', 'true is bare');
  });
  it('sorts spec fields so key text is order-independent', (t) => {
    t.equal(specKey('t', { b: 1, a: 2 }), specKey('t', { a: 2, b: 1 }), 'field order ignored');
  });
  it('separates cache-key fields unambiguously', (t) => {
    const a = cacheKeyText({ spec: 'x', target: 'yz' });
    const b = cacheKeyText({ spec: 'xy', target: 'z' });
    t.notEqual(a, b, 'field boundaries cannot be forged by concatenation');
    t.notEqual(
      cacheKeyHash({ spec: 'x', target: 'yz' }),
      cacheKeyHash({ spec: 'xy', target: 'z' }),
      'hashes differ too',
    );
  });
  it('changes the key when the target changes', (t) => {
    t.notEqual(
      cacheKeyHash({ spec: 'ew|op=add', target: 'msl-3.0' }),
      cacheKeyHash({ spec: 'ew|op=add', target: 'spirv-1.3' }),
      'one spec compiles to two artifacts',
    );
  });
});

describe('elementwise template', () => {
  it('emits MSL for a broadcast add', (t) => {
    const { ir, key } = binaryKernel(
      'add',
      [
        { dtype: 'f32', layout: 'cont' },
        { dtype: 'f32', layout: 'outerBroadcast' },
      ],
      'f32',
    );
    const msl = lowerToMSL(ir);
    t.ok(msl.includes('#include <metal_stdlib>'), 'has the MSL prelude');
    t.ok(msl.includes('kernel void ew_add_f32_f32_to_f32('), 'declares the entry point');
    t.ok(msl.includes('device const float* in0 [[buffer(0)]]'), 'read operand is const');
    t.ok(msl.includes('device float* out0 [[buffer(2)]]'), 'output at the next index');
    t.ok(msl.includes('constant Params& p [[buffer(3)]]'), 'params follow the buffers');
    t.ok(msl.includes('[[thread_position_in_grid]]'), 'requests the global index');
    t.ok(msl.includes('[[threads_per_grid]]'), 'requests the grid size for striding');
    t.ok(msl.includes('(in0[i] + in1[(i / p.inner1)])'), 'broadcast index divides');
    t.ok(key.includes('op=add'), `key names the operation (${key})`);
  });
  it('emits valid SPIR-V for the same kernel', (t) => {
    const { ir } = binaryKernel(
      'add',
      [
        { dtype: 'f32', layout: 'cont' },
        { dtype: 'f32', layout: 'outerBroadcast' },
      ],
      'f32',
    );
    const words = lowerToSPIRV(ir);
    const insts = disassemble(words);
    t.ok(words.length > 40, `emitted ${words.length} words`);
    t.equal(countOp(words, Op.EntryPoint), 1, 'one entry point');
    t.equal(countOp(words, Op.LoopMerge), 1, 'the grid-stride loop is structured');
    t.equal(countOp(words, Op.FAdd), 1, 'the addition is emitted once');
    t.equal(countOp(words, Op.UDiv), 1, 'the broadcast divide is emitted');
    const modes = insts.filter((x) => x.opcode === Op.ExecutionMode);
    t.equal(modes.length, 1, 'one execution mode');
    t.deepEqual(modes[0]!.operands.slice(2), [256, 1, 1], 'workgroup size is baked in');
    const bindings = insts.filter(
      (x) => x.opcode === Op.Decorate && x.operands[1] === 33 /* Binding */,
    );
    t.deepEqual(bindings.map((d) => d.operands[2]).sort(), [0, 1, 2], 'three sequential bindings');
  });
  it('rounds 16-bit stores through the compute type', (t) => {
    const { ir } = unaryKernel('relu', { dtype: 'f16', layout: 'cont' }, 'f16');
    const msl = lowerToMSL(ir);
    t.ok(msl.includes('float(in0[i])'), 'loads widen to the compute type');
    t.ok(msl.includes('half('), 'stores narrow back to storage');
  });
  it('carries bf16 as bits when the dialect lacks bfloat', (t) => {
    const { ir } = castKernel('bf16', 'f32');
    const msl24 = lowerToMSL(ir, { version: '2.4' });
    t.ok(msl24.includes('ushort'), 'bf16 is a ushort before MSL 3.1');
    t.ok(msl24.includes('as_type<float>'), 'converts by shifting into an f32');
    const msl31 = lowerToMSL(ir, { version: '3.1' });
    t.ok(msl31.includes('bfloat'), 'native bfloat used when available');
  });
  it('lowers bf16 conversion to bit work in SPIR-V', (t) => {
    const { ir } = castKernel('bf16', 'f32');
    const words = lowerToSPIRV(ir);
    t.ok(countOp(words, Op.Bitcast) >= 1, 'reinterprets the shifted bits');
    t.ok(countOp(words, Op.ShiftLeftLogical) >= 1, 'shifts into the high half');
  });
  it('emits comparison kernels that store booleans', (t) => {
    const { ir } = binaryKernel(
      'lt',
      [
        { dtype: 'f32', layout: 'cont' },
        { dtype: 'f32', layout: 'cont' },
      ],
      'bool',
    );
    const msl = lowerToMSL(ir);
    // Booleans occupy one byte per the contract, and SPIR-V forbids OpTypeBool
    // in a storage buffer, so both dialects use a byte buffer.
    t.ok(msl.includes('device uchar* out0'), 'output is a byte buffer');
    t.ok(msl.includes('? 1 : 0'), 'store narrows the bool to 0/1');
    t.ok(msl.includes('<'), 'comparison is emitted');
    const words = lowerToSPIRV(ir);
    t.equal(countOp(words, Op.FOrdLessThan), 1, 'ordered comparison in SPIR-V');
    t.ok(countOp(words, Op.Select) >= 1, 'SPIR-V selects a byte value to store');
  });
  it('composes gelu from ordinary IR nodes', (t) => {
    const { ir } = unaryKernel('gelu', { dtype: 'f32', layout: 'cont' }, 'f32');
    const msl = lowerToMSL(ir);
    t.ok(msl.includes('tanh('), 'uses the tanh approximation');
    const words = lowerToSPIRV(ir);
    t.equal(countOp(words, Op.ExtInst), 1, 'tanh comes from GLSL.std.450');
  });
  it('refuses strided operands, directing callers to the right template', (t) => {
    t.throws(
      () => unaryKernel('neg', { dtype: 'f32', layout: 'strided' }, 'f32'),
      /stridedCopy template/,
      'strided elementwise is explicitly out of scope',
    );
  });
});

describe('gemm template', () => {
  it('emits MSL with shared tiles and barriers', (t) => {
    const { ir, key } = gemmKernel({ dtype: 'f32' });
    const msl = lowerToMSL(ir);
    t.ok(msl.includes('threadgroup float tileA[1024]'), 'A tile is 64x16');
    t.ok(msl.includes('threadgroup float tileB[1024]'), 'B tile is 16x64');
    t.ok(msl.includes('threadgroup_barrier'), 'stages behind a barrier');
    t.ok(msl.includes('fma('), 'accumulates with fma');
    t.ok(msl.includes('float acc0_0 = 0.0f;'), 'register accumulators are declared');
    t.ok(msl.includes('acc3_3'), '4x4 register block is fully unrolled');
    t.ok(key.includes('tile=64x64x16'), `key records the tiling (${key})`);
  });
  it('emits structurally valid SPIR-V for the same kernel', (t) => {
    const { ir } = gemmKernel({ dtype: 'f32' });
    const words = lowerToSPIRV(ir);
    t.ok(words.length > 500, `emitted ${words.length} words`);
    t.equal(countOp(words, Op.ControlBarrier), 2, 'two barriers per K step');
    // The K-tile loop and the inner kk loop.
    t.equal(countOp(words, Op.LoopMerge), 2, 'both loops are structured');
    t.equal(countOp(words, Op.ExtInst), 16, '4x4 fma calls');
    const insts = disassemble(words);
    const workgroupVars = insts.filter(
      (x) => x.opcode === Op.Variable && x.operands[2] === 4 /* Workgroup */,
    );
    t.equal(workgroupVars.length, 2, 'two shared arrays');
  });
  it('drops edge guards when the tiling divides the problem', (t) => {
    const guarded = lowerToMSL(gemmKernel({ dtype: 'f32' }).ir);
    const exact = lowerToMSL(gemmKernel({ dtype: 'f32', noEdgeGuards: true }).ir);
    t.ok(exact.length < guarded.length, 'the exact variant emits less code');
    t.ok(guarded.includes('if ('), 'guarded variant tests bounds');
  });
  it('changes the key for every geometry field', (t) => {
    const a = gemmKernel({ dtype: 'f32' }).key;
    const b = gemmKernel({ dtype: 'f32', tiling: SMALL_TILING }).key;
    const c = gemmKernel({ dtype: 'f32', transB: true }).key;
    const d = gemmKernel({ dtype: 'f32', withBeta: true }).key;
    t.equal(new Set([a, b, c, d]).size, 4, 'four distinct kernels, four keys');
  });
  it('indexes transposed operands without a copy', (t) => {
    const plain = lowerToMSL(gemmKernel({ dtype: 'f32' }).ir);
    const transB = lowerToMSL(gemmKernel({ dtype: 'f32', transB: true }).ir);
    t.notEqual(plain, transB, 'transposition changes the emitted indexing');
    t.ok(transB.includes('p.K'), 'transposed B strides by K');
  });
  it('accumulates 16-bit inputs in f32', (t) => {
    const { ir, key } = gemmKernel({ dtype: 'f16' });
    t.ok(key.includes('acc=f32'), 'accumulator type is in the key');
    const msl = lowerToMSL(ir);
    t.ok(msl.includes('threadgroup float tileA'), 'tiles are staged in f32');
    t.ok(msl.includes('device const half* matA'), 'storage stays 16-bit');
  });
  it('adds a beta term only when asked', (t) => {
    const withBeta = lowerToMSL(gemmKernel({ dtype: 'f32', withBeta: true }).ir);
    t.ok(withBeta.includes('device float* matC'), 'C becomes readable');
    t.ok(withBeta.includes('p.beta'), 'beta is a kernel parameter');
    const plain = lowerToMSL(gemmKernel({ dtype: 'f32' }).ir);
    t.ok(!plain.includes('beta'), 'plain variant has no beta at all');
  });
  it('computes launch geometry and exactness', (t) => {
    t.deepEqual(gemmGrid(128, 256), [4, 2, 1], '256/64 by 128/64 workgroups');
    t.deepEqual(gemmGrid(65, 65), [2, 2, 1], 'partial tiles round up');
    t.ok(gemmIsExact(128, 128, 64), 'multiples of the tiling are exact');
    t.ok(!gemmIsExact(129, 128, 64), 'a ragged M is not');
    t.ok(!gemmIsExact(128, 128, 65), 'a ragged K is not');
  });
  it('rejects a tiling that does not divide evenly', (t) => {
    t.throws(
      () => gemmKernel({ dtype: 'f32', tiling: { bm: 64, bn: 64, bk: 16, tm: 3, tn: 4 } }),
      /does not divide/,
      'inconsistent geometry is caught at emit time',
    );
  });
});

describe('two-dialect neutrality', () => {
  it('lowers one IR value to both dialects without mutating it', (t) => {
    // The gate: same object, both lowerings, no dialect-specific preparation.
    const { ir } = gemmKernel({ dtype: 'f32', tiling: SMALL_TILING });
    const before = JSON.stringify(ir);
    const msl = lowerToMSL(ir);
    const afterMsl = JSON.stringify(ir);
    const spirv = lowerToSPIRV(ir);
    const afterSpirv = JSON.stringify(ir);
    t.equal(afterMsl, before, 'MSL lowering does not mutate the IR');
    t.equal(afterSpirv, before, 'SPIR-V lowering does not mutate the IR');
    t.ok(msl.length > 0 && spirv.length > 0, 'both dialects produced output');
  });
  it('covers every template through both dialects', (t) => {
    const kernels = [
      unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32'),
      unaryKernel('gelu', { dtype: 'f32', layout: 'cont' }, 'f32'),
      unaryKernel('exp', { dtype: 'f16', layout: 'cont' }, 'f16'),
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'scalar' },
        ],
        'f32',
      ),
      binaryKernel(
        'mul',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'innerBroadcast' },
        ],
        'f32',
      ),
      binaryKernel(
        'ge',
        [
          { dtype: 'i32', layout: 'cont' },
          { dtype: 'i32', layout: 'cont' },
        ],
        'bool',
      ),
      castKernel('f32', 'i32'),
      castKernel('bool', 'f32'),
      gemmKernel({ dtype: 'f32', tiling: SMALL_TILING }),
      gemmKernel({ dtype: 'f32', tiling: SMALL_TILING, transA: true }),
      gemmKernel({ dtype: 'f32', tiling: SMALL_TILING, noEdgeGuards: true, withBeta: true }),
    ];
    for (const { ir } of kernels) {
      const msl = lowerToMSL(ir, { fastMath: false });
      t.ok(msl.includes(`kernel void ${ir.name}(`), `${ir.name}: MSL entry point`);
      const words = lowerToSPIRV(ir, { caps: { f16: true } });
      t.equal(countOp(words, Op.EntryPoint), 1, `${ir.name}: SPIR-V entry point`);
    }
  });
  it('keeps keys distinct across every kernel it can emit', (t) => {
    const keys = [
      unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32').key,
      unaryKernel('relu', { dtype: 'f16', layout: 'cont' }, 'f16').key,
      unaryKernel('exp', { dtype: 'f32', layout: 'cont' }, 'f32').key,
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'cont' },
        ],
        'f32',
      ).key,
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'scalar' },
        ],
        'f32',
      ).key,
      gemmKernel({ dtype: 'f32' }).key,
    ];
    t.equal(new Set(keys).size, keys.length, 'no two distinct kernels share a key');
  });
});

describe('subgroup and atomic fallbacks', () => {
  it('refuses subgroup reductions when the target lacks them', (t) => {
    const b = new KernelBuilder('sg');
    b.buffer('x', vt('f32'), 'read');
    b.buffer('o', vt('f32'), 'write');
    b.require({ subgroups: true });
    b.store('o', E.u32(0), E.subgroup('add', E.load('x', E.u32(0))));
    const ir = b.build();
    t.throws(() => lowerToSPIRV(ir), /lacks them/, 'missing capability is an explicit error');
    const words = lowerToSPIRV(ir, { caps: { subgroups: true } });
    t.equal(countOp(words, Op.GroupNonUniformFAdd), 1, 'emitted when the capability is present');
  });
  it('emulates float atomics with compare-and-swap when unsupported', (t) => {
    const b = new KernelBuilder('at');
    b.buffer('o', vt('f32'), 'readwrite');
    b.atomicAdd('o', E.u32(0), E.f32(1));
    const ir = b.build();
    const fallback = lowerToSPIRV(ir);
    t.equal(countOp(fallback, Op.AtomicCompareExchange), 1, 'falls back to a CAS loop');
    t.equal(countOp(fallback, Op.AtomicFAddEXT), 0, 'no extension instruction used');
    const native = lowerToSPIRV(ir, { caps: { atomicFloat: true } });
    t.equal(countOp(native, Op.AtomicFAddEXT), 1, 'uses the extension when available');
    t.equal(countOp(native, Op.AtomicCompareExchange), 0, 'no CAS loop needed');
  });
  it('uses relaxed ordering for Metal atomics', (t) => {
    const b = new KernelBuilder('at2');
    b.buffer('o', vt('f32'), 'readwrite');
    b.atomicAdd('o', E.u32(0), E.f32(1));
    const msl = lowerToMSL(b.build());
    t.ok(msl.includes('atomic_fetch_add_explicit'), 'Metal has a native float atomic');
    t.ok(msl.includes('memory_order_relaxed'), 'relaxed ordering is sufficient here');
  });
  it('rejects f16 buffers when the target lacks 16-bit storage', (t) => {
    const { ir } = unaryKernel('relu', { dtype: 'f16', layout: 'cont' }, 'f16');
    t.throws(() => lowerToSPIRV(ir), /16-bit storage/, 'missing capability is explicit');
  });
});
