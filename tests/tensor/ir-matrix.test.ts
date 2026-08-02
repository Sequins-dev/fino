/**
 * The cooperative-matrix statements, and the dialect split they exist for.
 *
 * These lower to Metal's simdgroup matrices and to nothing at all on SPIR-V. That
 * asymmetry is the point: the fallback for a device without the capability is a
 * different kernel, not different code for the same one, so the SPIR-V lowering refuses
 * instead of approximating.
 */
import { describe, it } from 'fino:test/test';
import { E, KernelBuilder, lowerToMSL, lowerToSPIRV } from 'internal:tensor/ir';

/** A kernel that uses every matrix statement once. */
function matrixKernel() {
  const b = new KernelBuilder('mat_probe', [32, 1, 1]);
  const staged = b.shared('staged', 'f16', 64);
  const out = b.shared('out', 'f32', 64);
  b.matDecl('acc', 'f32');
  b.matDecl('lhs', 'f16');
  b.matDecl('rhs', 'f16');
  b.matFill('acc', 0);
  b.matLoad('lhs', staged, E.u32(0), E.u32(8));
  b.matLoad('rhs', staged, E.u32(0), E.u32(8));
  b.matMulAdd('acc', 'lhs', 'rhs');
  b.matStore('acc', out, E.u32(0), E.u32(8));
  return b.build();
}

describe('cooperative matrix in the IR', () => {
  it('marks the kernel as needing the capability', (t) => {
    const ir = matrixKernel();
    t.equal(ir.caps?.matrix, true, 'declaring a matrix sets the requirement');
    // Read off the kernel rather than passed alongside it, so a template cannot use the
    // statements and forget to declare that it did.
    const plain = new KernelBuilder('plain', [32, 1, 1]).build();
    t.ok(!plain.caps?.matrix, 'and a kernel without them does not claim it');
  });

  it('lowers to simdgroup matrices in MSL', (t) => {
    const msl = lowerToMSL(matrixKernel());
    t.ok(msl.includes('#include <metal_simdgroup_matrix>'), 'includes the header');
    t.ok(msl.includes('simdgroup_float8x8 acc;'), 'declares the f32 accumulator');
    t.ok(msl.includes('simdgroup_half8x8 lhs;'), 'declares the f16 operand');
    t.ok(
      msl.includes('make_filled_simdgroup_matrix<float, 8, 8>'),
      'fills with the declared element type',
    );
    t.ok(msl.includes('simdgroup_load(lhs,'), 'loads');
    t.ok(
      msl.includes('simdgroup_multiply_accumulate(acc, lhs, rhs, acc)'),
      'multiplies into the accumulator',
    );
    t.ok(msl.includes('simdgroup_store(acc,'), 'stores');
  });

  it('leaves the header out of kernels that do not need it', (t) => {
    const b = new KernelBuilder('plain', [32, 1, 1]);
    const sh = b.shared('sh', 'f32', 8);
    b.shstore(sh, E.u32(0), E.f32(1));
    t.ok(
      !lowerToMSL(b.build()).includes('metal_simdgroup_matrix'),
      'the header appears only where the statements do',
    );
  });

  it('refuses to lower to SPIR-V', (t) => {
    t.throws(
      () => lowerToSPIRV(matrixKernel()),
      /no SPIR-V lowering/,
      'and says what to do instead rather than emitting something undefined',
    );
  });
});
