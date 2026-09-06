/**
 * Validates emitted SPIR-V with the Khronos validator.
 *
 * Structural tests can only check what this emitter believes about SPIR-V.
 * `spirv-val` checks what the specification actually requires — decoration
 * completeness, structured-CFG legality, type rules — so it catches the class of
 * mistake that would otherwise surface as an opaque driver failure much later.
 *
 * Skips when `spirv-val` is not installed, since it comes from the Vulkan SDK
 * and is a development tool rather than a build dependency.
 */
import { describe, it } from 'fino:test/test';
import { Process } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import {
  SMALL_TILING,
  arangeKernel,
  argReduceKernel,
  binaryKernel,
  castKernel,
  fillKernel,
  gemmKernel,
  indexSelectKernel,
  layerNormKernel,
  lowerToSPIRV,
  optimizerKernel,
  randomKernel,
  reduceKernel,
  scatterAddKernel,
  softmaxKernel,
  stridedCopyKernel,
  unaryKernel,
} from 'internal:tensor/ir';
import { formatDisassembly } from 'internal:spirv';

const fs = new DiskFileSystem();

/** Locate `spirv-val`, or null when it is not installed. */
async function findValidator(): Promise<string | null> {
  for (const path of [
    '/usr/local/bin/spirv-val',
    '/opt/homebrew/bin/spirv-val',
    '/usr/bin/spirv-val',
  ]) {
    try {
      await fs.stat(path);
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

/** Read a pipe to end-of-stream as text. */
async function drain(reader: { read(): Promise<Uint8Array | null> }): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk === null) break;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Run the validator over a module, returning its diagnostics. */
async function validate(
  tool: string,
  name: string,
  words: Uint32Array,
): Promise<{ ok: boolean; output: string }> {
  const path = `/tmp/fino-spirv-${name}.spv`;
  await fs.writeFile(path, new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
  const proc = new Process(tool, ['--target-env', 'vulkan1.1', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  const result = await proc.wait();
  const output = out + err;
  await fs.unlink(path).catch(() => {});
  return { ok: result.code === 0, output };
}

/** Every kernel the templates can currently emit, with f16 enabled. */
function allKernels(): { name: string; words: Uint32Array }[] {
  const specs = [
    ['relu_f32', unaryKernel('relu', { dtype: 'f32', layout: 'cont' }, 'f32')],
    ['gelu_f32', unaryKernel('gelu', { dtype: 'f32', layout: 'cont' }, 'f32')],
    ['sigmoid_f32', unaryKernel('sigmoid', { dtype: 'f32', layout: 'cont' }, 'f32')],
    ['exp_f16', unaryKernel('exp', { dtype: 'f16', layout: 'cont' }, 'f16')],
    ['neg_i32', unaryKernel('neg', { dtype: 'i32', layout: 'cont' }, 'i32')],
    [
      'add_cont',
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'cont' },
        ],
        'f32',
      ),
    ],
    [
      'add_outer',
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'outerBroadcast' },
        ],
        'f32',
      ),
    ],
    [
      'mul_inner',
      binaryKernel(
        'mul',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'innerBroadcast' },
        ],
        'f32',
      ),
    ],
    [
      'add_scalar',
      binaryKernel(
        'add',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'scalar' },
        ],
        'f32',
      ),
    ],
    [
      'lt_bool',
      binaryKernel(
        'lt',
        [
          { dtype: 'f32', layout: 'cont' },
          { dtype: 'f32', layout: 'cont' },
        ],
        'bool',
      ),
    ],
    ['cast_f32_i32', castKernel('f32', 'i32')],
    ['cast_bf16_f32', castKernel('bf16', 'f32')],
    ['cast_bool_f32', castKernel('bool', 'f32')],
    ['gemm_small', gemmKernel({ dtype: 'f32', tiling: SMALL_TILING })],
    ['gemm_default', gemmKernel({ dtype: 'f32' })],
    ['gemm_transA', gemmKernel({ dtype: 'f32', tiling: SMALL_TILING, transA: true })],
    ['gemm_transB', gemmKernel({ dtype: 'f32', tiling: SMALL_TILING, transB: true })],
    [
      'gemm_exact_beta',
      gemmKernel({ dtype: 'f32', tiling: SMALL_TILING, noEdgeGuards: true, withBeta: true }),
    ],
    ['gemm_f16', gemmKernel({ dtype: 'f16', tiling: SMALL_TILING })],
    ['reduce_sum', reduceKernel({ op: 'sum', dtype: 'f32' })],
    ['reduce_mean', reduceKernel({ op: 'mean', dtype: 'f32' })],
    ['reduce_max', reduceKernel({ op: 'max', dtype: 'f32' })],
    ['reduce_prod', reduceKernel({ op: 'prod', dtype: 'f32' })],
    ['reduce_any', reduceKernel({ op: 'any', dtype: 'f32' })],
    ['argmax', argReduceKernel({ op: 'argmax', dtype: 'f32' })],
    ['softmax', softmaxKernel({ dtype: 'f32' })],
    ['logsoftmax', softmaxKernel({ dtype: 'f32', log: true })],
    ['layernorm', layerNormKernel({ dtype: 'f32', weight: true, bias: true })],
    ['rmsnorm', layerNormKernel({ dtype: 'f32', rms: true })],
    ['fill', fillKernel({ dtype: 'f32' })],
    ['arange', arangeKernel({ dtype: 'i32' })],
    ['stridedcopy_r1', stridedCopyKernel({ rank: 1, from: 'f32' })],
    ['stridedcopy_r4', stridedCopyKernel({ rank: 4, from: 'f32' })],
    ['stridedcopy_cast', stridedCopyKernel({ rank: 2, from: 'f32', to: 'i32' })],
    ['indexselect', indexSelectKernel({ dtype: 'f32' })],
    ['scatteradd', scatterAddKernel({ dtype: 'f32' })],
    ['sgd', optimizerKernel({ kind: 'sgd', dtype: 'f32' })],
    [
      'sgd_momentum',
      optimizerKernel({ kind: 'sgd', dtype: 'f32', momentum: true, weightDecay: true }),
    ],
    ['adam', optimizerKernel({ kind: 'adam', dtype: 'f32' })],
    ['adamw', optimizerKernel({ kind: 'adam', dtype: 'f32', weightDecay: true, decoupled: true })],
    ['random_uniform', randomKernel({ kind: 'uniform', dtype: 'f32' })],
    ['random_normal', randomKernel({ kind: 'normal', dtype: 'f32' })],
    ['random_bernoulli', randomKernel({ kind: 'bernoulli', dtype: 'f32' })],
    ['random_randint', randomKernel({ kind: 'randint', dtype: 'i32' })],
  ] as const;
  return specs.map(([name, k]) => ({
    name,
    words: lowerToSPIRV(k.ir, { caps: { f16: true }, names: true }),
  }));
}

describe('spirv-val conformance', () => {
  it('validates every emitted kernel', async (t) => {
    const tool = await findValidator();
    if (!tool) {
      t.ok(true, 'SKIP: install the Vulkan SDK to enable spirv-val checks');
      return;
    }
    for (const { name, words } of allKernels()) {
      const { ok, output } = await validate(tool, name, words);
      if (!ok) {
        // A disassembly makes the validator's word offsets actionable.
        t.ok(false, `${name} failed validation:\n${output}\n${formatDisassembly(words)}`);
        return;
      }
      t.ok(true, `${name} is valid SPIR-V (${words.length} words)`);
    }
  });
  it('validates the float-atomic fallback and the extension path', async (t) => {
    const tool = await findValidator();
    if (!tool) {
      t.ok(true, 'SKIP: install the Vulkan SDK to enable spirv-val checks');
      return;
    }
    const { KernelBuilder, E, vt } = await import('internal:tensor/ir');
    const build = () => {
      const b = new KernelBuilder('atomic_probe');
      b.buffer('out0', vt('f32'), 'readwrite');
      const n = b.param('n');
      b.gridStride(n, (i) => {
        b.atomicAdd('out0', i, E.f32(1));
      });
      return b.build();
    };
    const cas = await validate(tool, 'atomic_cas', lowerToSPIRV(build()));
    t.ok(cas.ok, `compare-and-swap fallback validates: ${cas.output}`);
    const ext = await validate(
      tool,
      'atomic_ext',
      lowerToSPIRV(build(), { caps: { atomicFloat: true } }),
    );
    t.ok(ext.ok, `atomic-float extension path validates: ${ext.output}`);
  });
  it('validates a vectorised kernel that mixes a scalar parameter with a vector', async (t) => {
    const tool = await findValidator();
    if (!tool) {
      t.ok(true, 'SKIP: install the Vulkan SDK to enable spirv-val checks');
      return;
    }
    const { BINARY, ewKernel } = await import('internal:tensor/ir');
    // `pow` with a scalar exponent, four lanes wide. This shape shipped broken: the
    // exponent is a push constant and `ctx.lit` is vector-typed, so comparing them
    // produced `OpFOrdEqual %bool %float %v4float`. MSL broadcasts a scalar into a
    // comparison silently, SPIR-V does not, and the two dialects disagreed the moment
    // anything became wider than one lane. Metal compiled it; lavapipe refused the
    // pipeline; only the validator names the reason, which is why the check lives here
    // rather than waiting for a driver that happens to be strict.
    const build = (vec: 1 | 4) =>
      ewKernel({
        op: 'pow_scalar',
        inputs: [{ dtype: 'f32', layout: 'cont' }],
        out: 'f32',
        vec,
        scalars: [{ name: 'operand', type: 'f32' }],
        body: ([value], ctx) => BINARY.pow!(value!, ctx.scalar('operand'), ctx),
      }).ir;
    for (const vec of [1, 4] as const) {
      const result = await validate(tool, `pow_scalar_x${vec}`, lowerToSPIRV(build(vec)));
      t.ok(result.ok, `scalar-exponent pow at ${vec} lane(s) validates: ${result.output}`);
    }
  });

  it('validates the subgroup reduction path', async (t) => {
    const tool = await findValidator();
    if (!tool) {
      t.ok(true, 'SKIP: install the Vulkan SDK to enable spirv-val checks');
      return;
    }
    const { KernelBuilder, E, vt } = await import('internal:tensor/ir');
    const b = new KernelBuilder('subgroup_probe');
    b.buffer('in0', vt('f32'), 'read');
    b.buffer('out0', vt('f32'), 'write');
    b.require({ subgroups: true });
    const n = b.param('n');
    b.gridStride(n, (i) => {
      b.store('out0', i, E.subgroup('add', E.load('in0', i)));
    });
    const { ok, output } = await validate(
      tool,
      'subgroup',
      lowerToSPIRV(b.build(), { caps: { subgroups: true } }),
    );
    t.ok(ok, `subgroup reduction validates: ${output}`);
  });
});
