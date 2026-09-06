/**
 * SPIR-V binary emitter.
 *
 * Assembles SPIR-V compute modules from TypeScript. SPIR-V is a stream of
 * 32-bit words with a specified layout and no grammar to satisfy, which makes
 * emitting it the same category of work as this runtime's other binary codecs
 * (`internal:format/thrift`, `fino:format/flatbuffers`, the Arrow IPC writer) —
 * and it removes any need for an external shader compiler in the toolchain.
 *
 * The emitter is tensor-agnostic. Kernel lowering and GPU execution belong
 * in consumers. The default output version is SPIR-V 1.3. Callers supply valid
 * operand ids, types, and capabilities; this builder is not a full validator.
 * Validate complete modules with the Khronos tools before driver execution.
 *
 * ## Boundary
 *
 * Not exposed as a public `fino:*` builtin. A SPIR-V emitter is broadly useful
 * and this module is a candidate for promotion, but its surface should be
 * exercised by in-tree consumers first.
 *
 * ```ts no_run
 * import { SpirvModule, Op, ExecutionModel, ExecutionMode } from 'internal:spirv';
 *
 * const m = new SpirvModule();
 * const voidT = m.typeVoid();
 * const main = m.beginFunction(voidT, m.typeFunction(voidT));
 * main.emitVoid(Op.Return);
 * main.end();
 * m.entryPoint(ExecutionModel.GLCompute, main.id, 'main', []);
 * m.executionMode(main.id, ExecutionMode.LocalSize, 64, 1, 1);
 * const words = m.assemble();
 * ```
 *
 * Specification: [SPIR-V](https://registry.khronos.org/SPIR-V/specs/unified1/SPIRV.html),
 * sections 2.3, 2.4, and 2.11 (binary layout, module layout, structured control flow).
 *
 * @internal
 */
export {
  MAGIC,
  VERSION_1_0,
  VERSION_1_3,
  GENERATOR,
  GLSL_STD_450,
  Op,
  OP_NAMES,
  Capability,
  AddressingModel,
  MemoryModel,
  ExecutionModel,
  ExecutionMode,
  StorageClass,
  Decoration,
  BuiltIn,
  MemorySemantics,
  Scope,
  GroupOperation,
  FunctionControl,
  LoopControl,
  SelectionControl,
  Glsl,
} from './opcodes.ts';
export { WordWriter, literalString, decodeLiteralString, f32Bits, f64Bits } from './writer.ts';
export { SpirvModule, FnBuilder } from './module.ts';
export type { Id, SpirvModuleOptions } from './module.ts';
export { disassemble, formatDisassembly, countOp } from './disasm.ts';
export type { DisasmInstruction } from './disasm.ts';
