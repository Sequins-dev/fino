/**
 * External validation of standalone compute modules, without a GPU or tensor IR.
 * Set FINO_REQUIRE_SPIRV=1 to require the Khronos validator instead of skipping.
 */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, env } from 'fino:process';
import {
  Decoration,
  ExecutionMode,
  ExecutionModel,
  Glsl,
  Op,
  SpirvModule,
  StorageClass,
} from 'internal:spirv';

const fs = new DiskFileSystem();
let validator: string | null = null;
for (const path of [
  '/opt/homebrew/bin/spirv-val',
  '/usr/local/bin/spirv-val',
  '/usr/bin/spirv-val',
]) {
  try {
    await fs.stat(path);
    validator = path;
    break;
  } catch {
    /* Try the next installation location. */
  }
}

async function drain(pipe: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const bytes of pipe) text += decoder.decode(bytes, { stream: true });
  return text + decoder.decode();
}

function moduleWords(structured: boolean): Uint32Array {
  const m = new SpirvModule({ names: true });
  const u32 = m.typeInt(32, false);
  const f32 = m.typeFloat(32);
  const array = m.typeRuntimeArray(f32);
  m.decorate(array, Decoration.ArrayStride, 4);
  const block = m.typeStruct([array]);
  m.decorate(block, Decoration.Block);
  m.memberDecorate(block, 0, Decoration.Offset, 0);
  const output = m.globalVariable(
    m.typePointer(StorageClass.StorageBuffer, block),
    StorageClass.StorageBuffer,
  );
  m.decorate(output, Decoration.DescriptorSet, 0);
  m.decorate(output, Decoration.Binding, 0);
  const fn = m.beginFunction(m.typeVoid(), m.typeFunction(m.typeVoid()));
  const zero = m.constU32(0);
  const result = fn.extInst(f32, m.glsl(), Glsl.Sqrt, [m.constF32(4)]);
  // Deliberately requested after body instructions: the builder must hoist it.
  const counter = fn.localVariable(m.typePointer(StorageClass.Function, u32), zero);
  const store = () =>
    fn.store(
      fn.accessChain(m.typePointer(StorageClass.StorageBuffer, f32), output, [zero, zero]),
      result,
    );
  if (structured) {
    fn.loop(
      () => fn.emit(Op.ULessThan, m.typeBool(), [fn.load(u32, counter), m.constU32(4)]),
      () => fn.ifThen(m.constBool(true), store, () => {}),
      () => fn.store(counter, fn.emit(Op.IAdd, u32, [fn.load(u32, counter), m.constU32(1)])),
    );
  } else {
    store();
  }
  fn.emitVoid(Op.Return);
  fn.end();
  m.name(fn.id, 'main');
  m.entryPoint(ExecutionModel.GLCompute, fn.id, 'main', []);
  m.executionMode(fn.id, ExecutionMode.LocalSize, 1, 1, 1);
  return m.assemble();
}

describe('SPIR-V external validation', () => {
  it('has the required validator', (t) => {
    t.ok(
      validator !== null || env.FINO_REQUIRE_SPIRV !== '1',
      'install spirv-val when FINO_REQUIRE_SPIRV=1',
    );
  });
  for (const structured of [false, true]) {
    it(
      structured
        ? 'validates nested structured control flow'
        : 'validates storage and extended math',
      { skip: validator ? false : 'spirv-val is not installed' },
      async (t) => {
        const path = `/tmp/fino-spirv-${Date.now()}-${Math.random().toString(36).slice(2)}.spv`;
        const words = moduleWords(structured);
        try {
          await fs.writeFile(
            path,
            new Uint8Array(words.buffer, words.byteOffset, words.byteLength),
          );
          const proc = new Process(validator!, ['--target-env', 'vulkan1.1', path], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [out, err, result] = await Promise.all([
            drain(proc.stdout),
            drain(proc.stderr),
            proc.wait(),
          ]);
          t.equal(result.code, 0, out + err || 'Khronos validator accepts the module');
        } finally {
          await fs.unlink(path);
        }
      },
    );
  }
});
