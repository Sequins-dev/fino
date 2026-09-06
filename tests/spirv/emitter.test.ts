/**
 * Tests for internal:spirv — the SPIR-V binary emitter.
 *
 * These assert module structure without a Vulkan driver: header words, section
 * order, interning, and the structured-control-flow block shapes the
 * specification requires. Execution coverage lives with the Vulkan backend.
 */
import { describe, it } from 'fino:test/test';
import {
  BuiltIn,
  Capability,
  Decoration,
  ExecutionMode,
  ExecutionModel,
  Glsl,
  MAGIC,
  Op,
  SpirvModule,
  StorageClass,
  VERSION_1_3,
  WordWriter,
  countOp,
  disassemble,
  f32Bits,
  formatDisassembly,
  literalString,
} from 'internal:spirv';

describe('WordWriter', () => {
  it('grows past its initial capacity', (t) => {
    const w = new WordWriter(16);
    for (let i = 0; i < 100; i++) w.word(i);
    t.equal(w.length, 100, 'all words retained');
    const out = w.finish();
    t.equal(out[0], 0, 'first word');
    t.equal(out[99], 99, 'last word');
  });
  it('frames instructions with a packed word count', (t) => {
    const w = new WordWriter();
    w.op(Op.Capability, [Capability.Shader]);
    const out = w.finish();
    t.equal(out.length, 2, 'header plus one operand');
    t.equal(out[0]! >>> 16, 2, 'word count includes the header');
    t.equal(out[0]! & 0xffff, Op.Capability, 'opcode in the low half');
    t.equal(out[1], Capability.Shader, 'operand follows');
  });
  it('finish() is a copy, not an alias', (t) => {
    const w = new WordWriter();
    w.word(1);
    const first = w.finish();
    w.word(2);
    t.equal(first.length, 1, 'earlier snapshot keeps its length');
  });
  it('NUL-terminates and word-pads literal strings', (t) => {
    t.deepEqual(literalString('abc'), [0x00636261], 'three bytes plus NUL fit one word');
    t.equal(literalString('abcd').length, 2, 'exact multiple still gets a NUL word');
    t.equal(literalString('abcd')[1], 0, 'padding word is zero');
  });
  it('f32Bits matches IEEE-754 encoding', (t) => {
    t.equal(f32Bits(1), 0x3f800000, '1.0');
    t.equal(f32Bits(0), 0, '0.0');
    t.equal(f32Bits(-2), 0xc0000000, '-2.0');
  });
});

describe('SpirvModule header and sections', () => {
  it('emits a well-formed header', (t) => {
    const m = new SpirvModule();
    const last = m.typeInt(32, false);
    const words = m.assemble();
    t.equal(words[0], MAGIC, 'magic number');
    t.equal(words[1], VERSION_1_3, 'version 1.3 by default');
    t.equal(words[2], 0, 'generator is the unregistered-tool value');
    t.equal(words[3], last + 1, 'id bound is one past the highest allocated id');
    t.equal(words[4], 0, 'reserved schema word is zero');
  });
  it('orders sections as the specification requires', (t) => {
    const m = new SpirvModule();
    const glsl = m.glsl();
    const u32 = m.typeInt(32, false);
    const voidT = m.typeVoid();
    const fn = m.beginFunction(voidT, m.typeFunction(voidT));
    fn.emitVoid(Op.Return);
    fn.end();
    m.entryPoint(ExecutionModel.GLCompute, fn.id, 'main', []);
    m.executionMode(fn.id, ExecutionMode.LocalSize, 64, 1, 1);
    m.decorate(u32, Decoration.RelaxedPrecision);

    const order = disassemble(m.assemble()).map((i) => i.opcode);
    const seq = [
      Op.Capability,
      Op.ExtInstImport,
      Op.MemoryModel,
      Op.EntryPoint,
      Op.ExecutionMode,
      Op.Decorate,
      Op.TypeInt,
      Op.Function,
    ];
    let cursor = -1;
    for (const opcode of seq) {
      const at = order.indexOf(opcode);
      t.ok(at > cursor, `${opcode} appears after the previous section (at ${at})`);
      cursor = at;
    }
    t.ok(glsl > 0, 'ext import allocated an id');
  });
  it('declares Shader capability without being asked', (t) => {
    const words = new SpirvModule().assemble();
    const caps = disassemble(words).filter((i) => i.opcode === Op.Capability);
    t.deepEqual(
      caps.map((c) => c.operands[0]),
      [Capability.Shader],
      'Shader is the only default capability',
    );
  });
  it('declares Float16 capability when an f16 type is used', (t) => {
    const m = new SpirvModule();
    m.typeFloat(16);
    const caps = disassemble(m.assemble())
      .filter((i) => i.opcode === Op.Capability)
      .map((i) => i.operands[0]);
    t.ok(caps.includes(Capability.Float16), 'Float16 declared automatically');
  });
});

describe('SpirvModule interning', () => {
  it('returns one id per distinct type', (t) => {
    const m = new SpirvModule();
    const a = m.typeInt(32, false);
    const b = m.typeInt(32, false);
    const c = m.typeInt(32, true);
    t.equal(a, b, 'identical int types share an id');
    t.notEqual(a, c, 'signedness distinguishes types');
    t.equal(countOp(m.assemble(), Op.TypeInt), 2, 'only two OpTypeInt emitted');
  });
  it('interns constants by bit pattern', (t) => {
    const m = new SpirvModule();
    m.constU32(7);
    m.constU32(7);
    m.constU32(8);
    t.equal(countOp(m.assemble(), Op.Constant), 2, 'duplicate constant collapses');
  });
  it('does not intern structs', (t) => {
    const m = new SpirvModule();
    const u32 = m.typeInt(32, false);
    const a = m.typeStruct([u32]);
    const b = m.typeStruct([u32]);
    t.notEqual(a, b, 'structs stay distinct so decorations cannot collide');
  });
  it('interns pointer and function types', (t) => {
    const m = new SpirvModule();
    const u32 = m.typeInt(32, false);
    t.equal(
      m.typePointer(StorageClass.Function, u32),
      m.typePointer(StorageClass.Function, u32),
      'pointer types intern',
    );
    t.notEqual(
      m.typePointer(StorageClass.Function, u32),
      m.typePointer(StorageClass.Workgroup, u32),
      'storage class distinguishes pointers',
    );
    const voidT = m.typeVoid();
    t.equal(m.typeFunction(voidT), m.typeFunction(voidT), 'function types intern');
  });
});

describe('FnBuilder structured control flow', () => {
  it('hoists Function-storage variables into the entry block', (t) => {
    const m = new SpirvModule();
    const voidT = m.typeVoid();
    const u32 = m.typeInt(32, false);
    const ptr = m.typePointer(StorageClass.Function, u32);
    const fn = m.beginFunction(voidT, m.typeFunction(voidT));
    // Ask for the variable *after* emitting body work; it must still land first.
    const zero = m.constU32(0);
    const v = fn.localVariable(ptr, zero);
    fn.store(v, zero);
    fn.emitVoid(Op.Return);
    fn.end();

    const body = disassemble(m.assemble());
    const fnAt = body.findIndex((i) => i.opcode === Op.Function);
    t.equal(body[fnAt + 1]!.opcode, Op.Label, 'entry label follows OpFunction');
    t.equal(body[fnAt + 2]!.opcode, Op.Variable, 'variable precedes other body work');
    t.equal(body[fnAt + 3]!.opcode, Op.Store, 'store comes after');
  });
  it('emits the five-block loop shape', (t) => {
    const m = new SpirvModule();
    const voidT = m.typeVoid();
    const u32 = m.typeInt(32, false);
    const boolT = m.typeBool();
    const ptr = m.typePointer(StorageClass.Function, u32);
    const fn = m.beginFunction(voidT, m.typeFunction(voidT));
    const zero = m.constU32(0);
    const ten = m.constU32(10);
    const one = m.constU32(1);
    const i = fn.localVariable(ptr, zero);
    fn.loop(
      () => fn.emit(Op.ULessThan, boolT, [fn.load(u32, i), ten]),
      () => {},
      () => fn.store(i, fn.emit(Op.IAdd, u32, [fn.load(u32, i), one])),
    );
    fn.emitVoid(Op.Return);
    fn.end();

    const words = m.assemble();
    t.equal(countOp(words, Op.LoopMerge), 1, 'exactly one OpLoopMerge');
    const insts = disassemble(words);
    const mergeAt = insts.findIndex((x) => x.opcode === Op.LoopMerge);
    t.equal(insts[mergeAt - 1]!.opcode, Op.Label, 'OpLoopMerge opens a header block');
    t.equal(insts[mergeAt + 1]!.opcode, Op.Branch, 'header branches to the condition block');
    const [mergeBlock, continueBlock] = insts[mergeAt]!.operands;
    t.notEqual(mergeBlock, continueBlock, 'merge and continue are distinct blocks');
    t.ok(
      insts.some((x) => x.opcode === Op.Label && x.operands[0] === mergeBlock),
      'merge block is defined',
    );
    t.ok(
      insts.some((x) => x.opcode === Op.Label && x.operands[0] === continueBlock),
      'continue block is defined',
    );
    t.equal(countOp(words, Op.BranchConditional), 1, 'condition block branches conditionally');
  });
  it('emits selection merge for a conditional', (t) => {
    const m = new SpirvModule();
    const voidT = m.typeVoid();
    const fn = m.beginFunction(voidT, m.typeFunction(voidT));
    fn.ifThen(m.constBool(true), () => {});
    fn.emitVoid(Op.Return);
    fn.end();
    const words = m.assemble();
    t.equal(countOp(words, Op.SelectionMerge), 1, 'one OpSelectionMerge');
    t.equal(countOp(words, Op.BranchConditional), 1, 'one conditional branch');
  });
  it('emits both arms when an else is supplied', (t) => {
    const m = new SpirvModule();
    const voidT = m.typeVoid();
    const fn = m.beginFunction(voidT, m.typeFunction(voidT));
    fn.ifThen(
      m.constBool(false),
      () => {},
      () => {},
    );
    fn.emitVoid(Op.Return);
    fn.end();
    const insts = disassemble(m.assemble());
    const cond = insts.find((x) => x.opcode === Op.BranchConditional)!;
    const merge = insts.find((x) => x.opcode === Op.SelectionMerge)!;
    t.notEqual(cond.operands[2], merge.operands[0], 'false edge targets an else block');
  });
});

describe('SpirvModule storage buffers', () => {
  it('builds a decorated storage-buffer binding', (t) => {
    const m = new SpirvModule();
    const f32 = m.typeFloat(32);
    const rt = m.typeRuntimeArray(f32);
    m.decorate(rt, Decoration.ArrayStride, 4);
    const block = m.typeStruct([rt]);
    m.decorate(block, Decoration.Block);
    m.memberDecorate(block, 0, Decoration.Offset, 0);
    const ptr = m.typePointer(StorageClass.StorageBuffer, block);
    const v = m.globalVariable(ptr, StorageClass.StorageBuffer);
    m.decorate(v, Decoration.DescriptorSet, 0);
    m.decorate(v, Decoration.Binding, 3);

    const insts = disassemble(m.assemble());
    const decorations = insts.filter((x) => x.opcode === Op.Decorate);
    t.ok(
      decorations.some((d) => d.operands[0] === rt && d.operands[1] === Decoration.ArrayStride),
      'runtime array carries ArrayStride',
    );
    t.ok(
      decorations.some((d) => d.operands[0] === v && d.operands[2] === 3),
      'variable carries its binding index',
    );
    t.ok(
      insts.some((x) => x.opcode === Op.Variable && x.operands[1] === v),
      'variable is declared at module scope',
    );
  });
  it('declares a builtin input variable', (t) => {
    const m = new SpirvModule();
    const u32 = m.typeInt(32, false);
    const v3 = m.typeVector(u32, 3);
    const ptr = m.typePointer(StorageClass.Input, v3);
    const gid = m.globalVariable(ptr, StorageClass.Input);
    m.decorate(gid, Decoration.BuiltIn, BuiltIn.GlobalInvocationId);
    const fn = m.beginFunction(m.typeVoid(), m.typeFunction(m.typeVoid()));
    fn.emitVoid(Op.Return);
    fn.end();
    m.entryPoint(ExecutionModel.GLCompute, fn.id, 'main', [gid]);
    const entry = disassemble(m.assemble()).find((x) => x.opcode === Op.EntryPoint)!;
    t.equal(entry.operands.at(-1), gid, 'builtin appears in the entry interface');
  });
});

describe('disassembler', () => {
  it('rejects a binary without the magic number', (t) => {
    t.throws(
      () => disassemble(new Uint32Array([1, 2, 3, 4, 5])),
      /magic mismatch/,
      'bad magic throws',
    );
  });
  it('rejects a truncated instruction', (t) => {
    const words = new Uint32Array([MAGIC, VERSION_1_3, 0, 1, 0, (9 << 16) | Op.Return]);
    t.throws(() => disassemble(words), /past end of module/, 'overlong word count throws');
  });
  it('renders names for readable output', (t) => {
    const m = new SpirvModule({ names: true });
    const fn = m.beginFunction(m.typeVoid(), m.typeFunction(m.typeVoid()));
    fn.emitVoid(Op.Return);
    fn.end();
    m.name(fn.id, 'my_kernel');
    const text = formatDisassembly(m.assemble());
    t.ok(text.includes('Capability'), 'opcode names rendered');
    t.ok(text.includes('"my_kernel"'), 'literal strings decoded');
  });
  it('omits names by default', (t) => {
    const m = new SpirvModule();
    const fn = m.beginFunction(m.typeVoid(), m.typeFunction(m.typeVoid()));
    fn.emitVoid(Op.Return);
    fn.end();
    m.name(fn.id, 'unused');
    t.equal(countOp(m.assemble(), Op.Name), 0, 'no OpName without the names option');
  });
});

describe('extended instructions', () => {
  it('calls into GLSL.std.450', (t) => {
    const m = new SpirvModule();
    const f32 = m.typeFloat(32);
    const glsl = m.glsl();
    const fn = m.beginFunction(m.typeVoid(), m.typeFunction(m.typeVoid()));
    const x = m.constF32(2);
    fn.extInst(f32, glsl, Glsl.Sqrt, [x]);
    fn.emitVoid(Op.Return);
    fn.end();
    const ext = disassemble(m.assemble()).find((i) => i.opcode === Op.ExtInst)!;
    t.equal(ext.operands[2], glsl, 'targets the imported set');
    t.equal(ext.operands[3], Glsl.Sqrt, 'names the instruction');
  });
});

describe('SPIR-V arithmetic opcode identities', () => {
  it('uses OpFRem rather than OpFMod for floating remainder', (t) => {
    // SPIR-V arithmetic instructions: these instructions differ for negative operands.
    t.equal(Op.FRem, 140, 'OpFRem is opcode 140; opcode 141 is OpFMod');
  });
});
