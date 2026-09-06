/** SPIR-V lowering must preserve typed kernel structure and validate externally. */
import { describe, it } from 'fino:test/test';
import { E, KernelBuilder, vt } from 'internal:kernel/ir';
import { Op, countOp } from 'internal:spirv';
import { fixtures } from './fixtures.ts';
import { env, findValidator, run, withFile } from './tools.ts';
const validator = await findValidator();

describe('kernel SPIR-V lowering', () => {
  it('loads the standalone lowering', async (t) => {
    let loaded = false;
    try {
      loaded = typeof (await import('internal:kernel/spirv')).lowerToSPIRV === 'function';
    } catch {}
    t.ok(loaded, 'SPIR-V lowering is available');
  });
  it('emits deterministic words without mutating the IR', async (t) => {
    const { lowerToSPIRV } = await import('internal:kernel/spirv');
    for (const ir of fixtures()) {
      const before = structuredClone(ir);
      const words = lowerToSPIRV(ir);
      t.equal(words[0], 0x07230203);
      t.deepEqual(words, lowerToSPIRV(ir));
      t.deepEqual(ir, before);
    }
    const words = lowerToSPIRV(fixtures()[1]);
    t.ok(countOp(words, Op.LoopMerge) > 0);
    t.ok(countOp(words, Op.SelectionMerge) > 0);
    t.equal(countOp(words, Op.ControlBarrier), 1);
  });
  it('checks target limits and unsupported capabilities explicitly', async (t) => {
    const { lowerToSPIRV } = await import('internal:kernel/spirv');
    const b = new KernelBuilder('large', [2048, 1, 1]);
    t.throws(() => lowerToSPIRV(b.build()), /workgroup/);
    const p = new KernelBuilder('params');
    for (let i = 0; i < 33; i++) p.param(`p${i}`);
    t.throws(() => lowerToSPIRV(p.build()), /parameter/);
    const h = new KernelBuilder('half');
    h.buffer('input', vt('f16'), 'read');
    t.throws(() => lowerToSPIRV(h.build()), /f16|16-bit/);
    const s = new KernelBuilder('subgroup');
    s.let('sum', vt('f32'), E.subgroup('add', E.f32(1)));
    t.throws(() => lowerToSPIRV(s.build()), /subgroup/);
  });
  it('has the required Khronos validator', (t) => {
    t.ok(validator !== null || env.FINO_REQUIRE_SPIRV !== '1', 'install spirv-val when required');
  });
  for (const ir of fixtures()) {
    it(
      `validates ${ir.name}`,
      { skip: validator ? false : 'spirv-val is not installed' },
      async (t) => {
        const { lowerToSPIRV } = await import('internal:kernel/spirv');
        const words = lowerToSPIRV(ir, { names: true });
        await withFile('spv', new Uint8Array(words.buffer), async (path) => {
          const result = await run(validator!, ['--target-env', 'vulkan1.1', path]);
          t.equal(result.code, 0, result.output || 'valid SPIR-V');
        });
      },
    );
  }
});
