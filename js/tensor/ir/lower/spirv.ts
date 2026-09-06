/**
 * Lower kernel IR to SPIR-V words.
 *
 * The counterpart to the MSL lowering, and the reason the IR is structured:
 * every `for` becomes an `OpLoopMerge` block quad and every `if` an
 * `OpSelectionMerge` pair, both of which `internal:spirv` builds correctly from
 * the same structured shape.
 *
 * Every Vulkan/SPIR-V-specific decision lives in this file.
 *
 * Layout conventions, which the Vulkan backend must match:
 * - Buffers are storage buffers in descriptor set 0, binding = array position.
 * - Scalar parameters are one push-constant block, each field at a 4-byte offset.
 * - Workgroup size is baked with `OpExecutionMode LocalSize`.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import {
  BuiltIn,
  Capability,
  Decoration,
  ExecutionMode,
  ExecutionModel,
  Glsl,
  type Id,
  MemorySemantics,
  Op,
  Scope,
  SpirvModule,
  StorageClass,
  GroupOperation,
} from 'internal:spirv';
import type {
  BinOp,
  Expr,
  KernelIR,
  MathFn,
  ScalarDType,
  Stmt,
  ValType,
  VecWidth,
} from '../types.ts';
import { scalarBytes, validateKernel } from '../types.ts';
import { TypeEnv, checkExpr, typeOf } from '../typing.ts';

/** Options for {@link lowerToSPIRV}. */
export interface SpirvOptions {
  /** Emit debug names. Useful with `spirv-dis`, costs words. */
  names?: boolean;
  /**
   * Target capabilities.
   *
   * Anything absent forces a portable fallback rather than an error: float
   * atomics degrade to a compare-and-swap loop, and 16-bit storage is only
   * declared when the kernel actually needs it.
   */
  caps?: {
    /** `VK_KHR_shader_float16_int8` plus 16-bit storage access. */
    f16?: boolean;
    /** `VK_EXT_shader_atomic_float`. */
    atomicFloat?: boolean;
    /** Subgroup arithmetic. */
    subgroups?: boolean;
  };
}

/**
 * Bit width of a scalar type, for deciding between a convert and a bitcast.
 *
 * @internal
 */
function intWidth(scalar: ScalarDType): number {
  switch (scalar) {
    case 'u8':
    case 'bool':
      return 8;
    case 'f16':
    case 'bf16':
      return 16;
    default:
      return 32;
  }
}

/** GLSL.std.450 instruction for each math function. */
const GLSL_FN: Record<MathFn, number> = {
  exp: Glsl.Exp,
  log: Glsl.Log,
  sqrt: Glsl.Sqrt,
  rsqrt: Glsl.InverseSqrt,
  tanh: Glsl.Tanh,
  sin: Glsl.Sin,
  cos: Glsl.Cos,
  pow: Glsl.Pow,
  fma: Glsl.Fma,
  floor: Glsl.Floor,
  ceil: Glsl.Ceil,
  round: Glsl.RoundEven,
  clamp: Glsl.FClamp,
};

/** Built-in variables the entry point may need. */
const BUILTIN_IDS: Record<string, { builtin: number; vector: boolean }> = {
  globalId: { builtin: BuiltIn.GlobalInvocationId, vector: true },
  localId: { builtin: BuiltIn.LocalInvocationId, vector: true },
  groupId: { builtin: BuiltIn.WorkgroupId, vector: true },
  numGroups: { builtin: BuiltIn.NumWorkgroups, vector: true },
  subgroupSize: { builtin: BuiltIn.SubgroupSize, vector: false },
  subgroupId: { builtin: BuiltIn.SubgroupId, vector: false },
  laneId: { builtin: BuiltIn.SubgroupLocalInvocationId, vector: false },
};

/**
 * Lower a kernel to a SPIR-V binary.
 */
export function lowerToSPIRV(ir: KernelIR, options: SpirvOptions = {}): Uint32Array {
  validateKernel(ir);
  // Checked before anything else, because it is a fact about the kernel rather than
  // about one statement: a kernel needing matrices cannot exist on this dialect at all,
  // and reporting that is more useful than a complaint about the first f16 buffer it
  // happens to touch on the way to the same conclusion.
  if (ir.caps?.matrix) {
    throw new Error(
      `kernel '${ir.name}' needs cooperative matrices, which have no SPIR-V lowering ` +
        'here; select a kernel that does not require the matrix capability',
    );
  }
  const caps = options.caps ?? {};
  const m = new SpirvModule({ names: options.names });
  const env = new TypeEnv(ir);

  const u32 = m.typeInt(32, false);
  const i32 = m.typeInt(32, true);
  const f32 = m.typeFloat(32);
  const boolT = m.typeBool();
  const voidT = m.typeVoid();
  const v3u32 = m.typeVector(u32, 3);

  /** Resolve a scalar IR type to its SPIR-V type id. */
  function scalarType(s: ScalarDType): Id {
    switch (s) {
      case 'f32':
        return f32;
      case 'f16':
        if (!caps.f16) {
          throw new Error(
            'kernel needs f16 but the target lacks 16-bit storage; lower with caps.f16 or specialize to f32',
          );
        }
        m.capability(Capability.StorageBuffer16BitAccess);
        return m.typeFloat(16);
      case 'bf16':
        // No portable SPIR-V bfloat arithmetic exists, so bf16 lives in a u16
        // and conversions are explicit bit work (see castTo).
        return m.typeInt(16, false);
      case 'i32':
        return i32;
      case 'u32':
        return u32;
      case 'u8':
        return m.typeInt(8, false);
      case 'bool':
        return boolT;
    }
  }

  /** Resolve a value type, including vectors. */
  function valType(t: ValType): Id {
    const base = scalarType(t.scalar);
    return t.lanes === 1 ? base : m.typeVector(base, t.lanes);
  }

  /**
   * Storage form of an element type.
   *
   * `OpTypeBool` is not permitted in externally visible storage classes, and the
   * contract specifies booleans occupy one byte holding exactly 0 or 1, so a
   * boolean buffer is a `u8` buffer with conversions at the load/store boundary.
   */
  function storageValType(t: ValType): ValType {
    return t.scalar === 'bool' ? { scalar: 'u8', lanes: t.lanes } : t;
  }

  /**
   * Buffers that a float `atomicAdd` targets while the target lacks
   * `VK_EXT_shader_atomic_float`.
   *
   * Such a buffer is declared as `u32` and its float values are bitcast on every
   * access. The alternative — declaring it as `f32` and bitcasting the *pointer* for
   * the compare-and-swap loop — is invalid under the Logical addressing model, which
   * has no pointer arithmetic to reinterpret. `spirv-val` accepted it; MoltenVK
   * rejected the module outright, which is the more honest answer.
   *
   * @internal
   */
  const atomicFloatBuffers = new Set<string>();
  if (!caps.atomicFloat) {
    const scan = (statements: readonly Stmt[]): void => {
      for (const statement of statements) {
        if (statement.k === 'atomicAdd') {
          const binding = ir.buffers.find((b) => b.name === statement.buf);
          if (binding && binding.elem.scalar === 'f32') atomicFloatBuffers.add(binding.name);
        } else if (statement.k === 'for') {
          scan(statement.body);
        } else if (statement.k === 'if') {
          scan(statement.then);
          if (statement.else) scan(statement.else);
        }
      }
    };
    scan(ir.body);
  }

  // -- storage buffers ----------------------------------------------------
  const bufferVars = new Map<
    string,
    { variable: Id; elem: ValType; storage: ValType; pointee: Id; asFloatBits: boolean }
  >();
  ir.buffers.forEach((b, index) => {
    const asFloatBits = atomicFloatBuffers.has(b.name);
    const storage = asFloatBits
      ? { scalar: 'u32' as const, lanes: b.elem.lanes }
      : storageValType(b.elem);
    const elemType = valType(storage);
    const runtime = m.typeRuntimeArray(elemType);
    m.decorate(runtime, Decoration.ArrayStride, scalarBytes(storage.scalar) * storage.lanes);
    const block = m.typeStruct([runtime]);
    m.decorate(block, Decoration.Block);
    m.memberDecorate(block, 0, Decoration.Offset, 0);
    const ptr = m.typePointer(StorageClass.StorageBuffer, block);
    const variable = m.globalVariable(ptr, StorageClass.StorageBuffer);
    m.decorate(variable, Decoration.DescriptorSet, 0);
    m.decorate(variable, Decoration.Binding, index);
    if (b.access === 'read') m.decorate(variable, Decoration.NonWritable);
    m.name(variable, b.name);
    bufferVars.set(b.name, {
      variable,
      elem: b.elem,
      storage,
      pointee: m.typePointer(StorageClass.StorageBuffer, elemType),
      asFloatBits,
    });
  });

  // -- push constants -----------------------------------------------------
  let paramsVar: Id = 0;
  if (ir.params.length > 0) {
    const members = ir.params.map((p) => scalarType(p.type === 'f32' ? 'f32' : p.type));
    const block = m.typeStruct(members);
    m.decorate(block, Decoration.Block);
    ir.params.forEach((p, i) => {
      m.memberDecorate(block, i, Decoration.Offset, i * 4);
      m.memberName(block, i, p.name);
    });
    const ptr = m.typePointer(StorageClass.PushConstant, block);
    paramsVar = m.globalVariable(ptr, StorageClass.PushConstant);
  }

  // -- shared arrays ------------------------------------------------------
  const sharedVars = new Map<string, { variable: Id; elem: ScalarDType; pointee: Id }>();
  for (const s of ir.shared) {
    const elemType = scalarType(s.elem);
    const arrayType = m.typeArray(elemType, m.constU32(s.length));
    const ptr = m.typePointer(StorageClass.Workgroup, arrayType);
    const variable = m.globalVariable(ptr, StorageClass.Workgroup);
    m.name(variable, s.name);
    sharedVars.set(s.name, {
      variable,
      elem: s.elem,
      pointee: m.typePointer(StorageClass.Workgroup, elemType),
    });
  }

  // -- built-in inputs ----------------------------------------------------
  const builtinVars = new Map<string, Id>();
  const iface: Id[] = [];
  function builtinVar(which: string): Id {
    const existing = builtinVars.get(which);
    if (existing !== undefined) return existing;
    const spec = BUILTIN_IDS[which];
    if (!spec) throw new Error(`built-in '${which}' has no SPIR-V variable`);
    if (which === 'subgroupSize' || which === 'subgroupId' || which === 'laneId') {
      m.capability(Capability.GroupNonUniform);
    }
    const type = spec.vector ? v3u32 : u32;
    const ptr = m.typePointer(StorageClass.Input, type);
    const variable = m.globalVariable(ptr, StorageClass.Input);
    m.decorate(variable, Decoration.BuiltIn, spec.builtin);
    m.name(variable, `_${which}`);
    builtinVars.set(which, variable);
    iface.push(variable);
    return variable;
  }

  const fn = m.beginFunction(voidT, m.typeFunction(voidT));

  /** Load a built-in, resolving `globalSize` to numGroups * workgroup size. */
  function readBuiltin(which: string, dim: 0 | 1 | 2): Id {
    if (which === 'globalSize') {
      // SPIR-V has no threads-per-grid built-in; derive it. The workgroup size
      // is a compile-time constant here because it is baked into the kernel.
      const groups = readBuiltin('numGroups', dim);
      return fn.emit(Op.IMul, u32, [groups, m.constU32(ir.wg[dim])]);
    }
    const variable = builtinVar(which);
    const spec = BUILTIN_IDS[which]!;
    if (!spec.vector) return fn.load(u32, variable);
    const ptr = m.typePointer(StorageClass.Input, u32);
    const chain = fn.accessChain(ptr, variable, [m.constU32(dim)]);
    return fn.load(u32, chain);
  }

  /** Value bindings in scope, mapped to either an SSA id or a variable pointer. */
  const lets = new Map<string, Id>();
  const vars = new Map<string, { pointer: Id; type: ValType }>();

  /** A typed zero, for `var` initialisation and accumulators. */
  function zeroOf(t: ValType): Id {
    const scalar =
      t.scalar === 'f32'
        ? m.constF32(0)
        : t.scalar === 'bool'
          ? m.constBool(false)
          : t.scalar === 'i32'
            ? m.constI32(0)
            : m.constU32(0);
    if (t.lanes === 1) return scalar;
    return m.constComposite(valType(t), new Array(t.lanes).fill(scalar));
  }

  /**
   * Emit an operand widened to `lanes`, splatting it when it is a scalar.
   *
   * The IR permits a binary operation to mix a vector with a scalar, following MSL, where
   * `x * 2` means the same thing whatever width `x` has. SPIR-V requires both operands to
   * have exactly the same type, so the scalar side is broadcast here. Nothing needed this
   * until the elementwise kernels became four lanes wide and `pow` started comparing a
   * scalar exponent against a vector literal.
   */
  function widen(e: Expr, lanes: VecWidth): Id {
    const id = expr(e);
    const t = typeOf(e, env);
    if (t.lanes === lanes) return id;
    return fn.emit(
      Op.CompositeConstruct,
      valType({ scalar: t.scalar, lanes }),
      Array.from({ length: lanes }, () => id),
    );
  }

  /** Emit a constant of a value type. */
  function constant(t: ValType, value: number): Id {
    let scalar: Id;
    switch (t.scalar) {
      case 'f32':
        scalar = m.constF32(value);
        break;
      case 'f16':
      case 'bf16':
        // Both are 16-bit storage; the bit pattern is produced by the cast path,
        // so a literal here is only ever an integer bit pattern.
        scalar = m.constantBits(scalarType(t.scalar), value & 0xffff);
        break;
      case 'i32':
        scalar = m.constI32(value);
        break;
      case 'u32':
        scalar = m.constU32(value);
        break;
      case 'u8':
        scalar = m.constantBits(scalarType('u8'), value & 0xff);
        break;
      case 'bool':
        scalar = m.constBool(value !== 0);
        break;
    }
    if (t.lanes === 1) return scalar;
    return m.constComposite(valType(t), new Array(t.lanes).fill(scalar));
  }

  /** Select the arithmetic opcode for an operator at a scalar type. */
  function binOpcode(op: BinOp, s: ScalarDType): number {
    const float = s === 'f32' || s === 'f16';
    const signed = s === 'i32';
    switch (op) {
      case 'add':
        return float ? Op.FAdd : Op.IAdd;
      case 'sub':
        return float ? Op.FSub : Op.ISub;
      case 'mul':
        return float ? Op.FMul : Op.IMul;
      case 'div':
        return float ? Op.FDiv : signed ? Op.SDiv : Op.UDiv;
      case 'mod':
        return float ? Op.FRem : signed ? Op.SRem : Op.UMod;
      case 'and':
        return Op.BitwiseAnd;
      case 'or':
        return Op.BitwiseOr;
      case 'xor':
        return Op.BitwiseXor;
      case 'shl':
        return Op.ShiftLeftLogical;
      case 'shr':
        return signed ? Op.ShiftRightArithmetic : Op.ShiftRightLogical;
      case 'eq':
        return float ? Op.FOrdEqual : Op.IEqual;
      case 'ne':
        return float ? Op.FOrdNotEqual : Op.INotEqual;
      case 'lt':
        return float ? Op.FOrdLessThan : signed ? Op.SLessThan : Op.ULessThan;
      case 'le':
        return float ? Op.FOrdLessThanEqual : signed ? Op.SLessThanEqual : Op.ULessThanEqual;
      case 'gt':
        return float ? Op.FOrdGreaterThan : signed ? Op.SGreaterThan : Op.UGreaterThan;
      case 'ge':
        return float
          ? Op.FOrdGreaterThanEqual
          : signed
            ? Op.SGreaterThanEqual
            : Op.UGreaterThanEqual;
      case 'logicalAnd':
        return Op.LogicalAnd;
      case 'logicalOr':
        return Op.LogicalOr;
      default:
        throw new Error(`operator '${op}' needs a dedicated lowering`);
    }
  }

  /** Emit a numeric conversion, including the bf16 bit path. */
  function castTo(to: ValType, from: Expr): Id {
    const fromType = typeOf(from, env);
    const value = expr(from);
    if (to.scalar === fromType.scalar && to.lanes === fromType.lanes) return value;

    // bf16 is stored as u16 holding the high half of the f32 bit pattern.
    if (to.scalar === 'bf16' && fromType.scalar !== 'bf16') {
      const asF32 = fromType.scalar === 'f32' ? value : convert(f32, 'f32', fromType, value);
      const bits = fn.emit(Op.Bitcast, u32, [asF32]);
      // Round to nearest even: add 0x7fff plus the low bit of the retained half.
      const shifted = fn.emit(Op.ShiftRightLogical, u32, [bits, m.constU32(16)]);
      const lowBit = fn.emit(Op.BitwiseAnd, u32, [shifted, m.constU32(1)]);
      const bias = fn.emit(Op.IAdd, u32, [m.constU32(0x7fff), lowBit]);
      const rounded = fn.emit(Op.IAdd, u32, [bits, bias]);
      const high = fn.emit(Op.ShiftRightLogical, u32, [rounded, m.constU32(16)]);
      return fn.emit(Op.UConvert, scalarType('bf16'), [high]);
    }
    if (fromType.scalar === 'bf16' && to.scalar !== 'bf16') {
      const widened = fn.emit(Op.UConvert, u32, [value]);
      const shifted = fn.emit(Op.ShiftLeftLogical, u32, [widened, m.constU32(16)]);
      const asF32 = fn.emit(Op.Bitcast, f32, [shifted]);
      return to.scalar === 'f32'
        ? asF32
        : convert(valType(to), to.scalar, { scalar: 'f32', lanes: 1 }, asF32);
    }
    return convert(valType(to), to.scalar, fromType, value);
  }

  /** Emit the plain numeric conversion opcode between two scalar kinds. */
  function convert(resultType: Id, toScalar: ScalarDType, fromType: ValType, value: Id): Id {
    const toFloat = toScalar === 'f32' || toScalar === 'f16';
    const fromFloat = fromType.scalar === 'f32' || fromType.scalar === 'f16';
    const fromSigned = fromType.scalar === 'i32';
    const toSigned = toScalar === 'i32';

    if (fromType.scalar === 'bool') {
      // Booleans are not numeric in SPIR-V; select between typed constants.
      const one = constant({ scalar: toScalar, lanes: fromType.lanes }, 1);
      const zero = constant({ scalar: toScalar, lanes: fromType.lanes }, 0);
      return fn.emit(Op.Select, resultType, [value, one, zero]);
    }
    if (toScalar === 'bool') {
      const zero = constant(fromType, 0);
      return fn.emit(binOpcode('ne', fromType.scalar), resultType, [value, zero]);
    }
    if (toFloat && fromFloat) return fn.emit(Op.FConvert, resultType, [value]);
    if (toFloat && !fromFloat) {
      return fn.emit(fromSigned ? Op.ConvertSToF : Op.ConvertUToF, resultType, [value]);
    }
    if (!toFloat && fromFloat) {
      return fn.emit(toSigned ? Op.ConvertFToS : Op.ConvertFToU, resultType, [value]);
    }
    // Integer to integer. `OpSConvert` and `OpUConvert` require the widths to
    // differ, so a same-width change of signedness is a reinterpretation instead.
    if (fromType.scalar === toScalar) return value;
    if (intWidth(fromType.scalar) === intWidth(toScalar)) {
      return fn.emit(Op.Bitcast, resultType, [value]);
    }
    return fn.emit(toSigned ? Op.SConvert : Op.UConvert, resultType, [value]);
  }

  /** Emit an expression, returning its result id. */
  function expr(e: Expr): Id {
    switch (e.k) {
      case 'const':
        return constant(e.type, e.value);
      case 'param': {
        const index = ir.params.findIndex((p) => p.name === e.name);
        if (index < 0) throw new Error(`unknown kernel parameter '${e.name}'`);
        const p = ir.params[index]!;
        const scalar = scalarType(p.type === 'f32' ? 'f32' : p.type);
        const ptr = m.typePointer(StorageClass.PushConstant, scalar);
        const chain = fn.accessChain(ptr, paramsVar, [m.constU32(index)]);
        return fn.load(scalar, chain);
      }
      case 'builtin':
        return readBuiltin(e.which, e.dim);
      case 'let': {
        const id = lets.get(e.name);
        if (id === undefined) throw new Error(`'${e.name}' is not in scope`);
        return id;
      }
      case 'var': {
        const slot = vars.get(e.name);
        if (!slot) throw new Error(`'${e.name}' is not a mutable binding in scope`);
        return fn.load(valType(slot.type), slot.pointer);
      }
      case 'load': {
        const buf = bufferVars.get(e.buf);
        if (!buf) throw new Error(`unknown buffer binding '${e.buf}'`);
        const chain = fn.accessChain(buf.pointee, buf.variable, [m.constU32(0), expr(e.index)]);
        const raw = fn.load(valType(buf.storage), chain);
        if (buf.asFloatBits) return fn.emit(Op.Bitcast, valType(buf.elem), [raw]);
        if (buf.elem.scalar !== 'bool') return raw;
        // Booleans are stored as bytes; widen back to a usable bool.
        return fn.emit(Op.INotEqual, valType(buf.elem), [raw, constant(buf.storage, 0)]);
      }
      case 'shload': {
        const sh = sharedVars.get(e.sh);
        if (!sh) throw new Error(`unknown shared array '${e.sh}'`);
        const chain = fn.accessChain(sh.pointee, sh.variable, [expr(e.index)]);
        return fn.load(scalarType(sh.elem), chain);
      }
      case 'bin': {
        const aType = typeOf(e.a, env);
        const resultType = valType(typeOf(e, env));
        // Both operands have to reach the wider side's width. The IR follows MSL in
        // letting a scalar stand in for a vector, and MSL broadcasts it silently where
        // SPIR-V requires the types to match exactly.
        const lanes = Math.max(aType.lanes, typeOf(e.b, env).lanes) as VecWidth;
        const left = () => widen(e.a, lanes);
        const right = () => widen(e.b, lanes);
        if (e.op === 'min' || e.op === 'max') {
          const float = aType.scalar === 'f32' || aType.scalar === 'f16';
          const signed = aType.scalar === 'i32';
          const inst =
            e.op === 'min'
              ? float
                ? Glsl.FMin
                : signed
                  ? Glsl.SMin
                  : Glsl.UMin
              : float
                ? Glsl.FMax
                : signed
                  ? Glsl.SMax
                  : Glsl.UMax;
          return fn.extInst(resultType, m.glsl(), inst, [left(), right()]);
        }
        if (e.op === 'mulhi') {
          // OpUMulExtended yields a struct of { low, high }.
          const pair = m.typeStruct([u32, u32]);
          const product = fn.emit(Op.UMulExtended, pair, [left(), right()]);
          return fn.emit(Op.CompositeExtract, u32, [product, 1]);
        }
        return fn.emit(binOpcode(e.op, aType.scalar), resultType, [left(), right()]);
      }
      case 'un': {
        const t = typeOf(e.a, env);
        const resultType = valType(t);
        if (e.op === 'neg') {
          const float = t.scalar === 'f32' || t.scalar === 'f16';
          return fn.emit(float ? Op.FNegate : Op.SNegate, resultType, [expr(e.a)]);
        }
        if (e.op === 'abs') {
          const float = t.scalar === 'f32' || t.scalar === 'f16';
          return fn.extInst(resultType, m.glsl(), float ? Glsl.FAbs : Glsl.SAbs, [expr(e.a)]);
        }
        return fn.emit(t.scalar === 'bool' ? Op.LogicalNot : Op.Not, resultType, [expr(e.a)]);
      }
      case 'call': {
        const t = typeOf(e, env);
        // Every argument at the result's width: `GLSL.std.450` requires all operands to
        // match the result type exactly, where MSL takes a scalar and broadcasts it.
        return fn.extInst(
          valType(t),
          m.glsl(),
          GLSL_FN[e.fn],
          e.args.map((arg) => widen(arg, t.lanes)),
        );
      }
      case 'select': {
        const result = typeOf(e.a, env);
        const condition = expr(e.cond);
        // `OpSelect` wants a condition with as many components as the result. A scalar
        // boolean choosing between vectors is only legal from SPIR-V 1.4, above what
        // these modules target, so a scalar condition is broadcast. A comparison between
        // vectors already yields a vector and passes straight through — which, since the
        // typing rule started widening mixed-width operations, is now the common case.
        const selector =
          result.lanes > 1 && typeOf(e.cond, env).lanes === 1
            ? fn.emit(
                Op.CompositeConstruct,
                valType({ scalar: 'bool', lanes: result.lanes }),
                Array.from({ length: result.lanes }, () => condition),
              )
            : condition;
        return fn.emit(Op.Select, valType(result), [selector, expr(e.a), expr(e.b)]);
      }
      case 'cast':
        return castTo(e.to, e.a);
      case 'bitcast':
        return fn.emit(Op.Bitcast, valType(e.to), [expr(e.a)]);
      case 'lane':
        return fn.emit(Op.CompositeExtract, scalarType(typeOf(e.a, env).scalar), [expr(e.a), e.i]);
      case 'vec':
        return fn.emit(Op.CompositeConstruct, valType(e.type), e.lanes.map(expr));
      case 'subgroup': {
        if (!caps.subgroups) {
          throw new Error('kernel uses subgroup reductions but the target lacks them');
        }
        m.capability(Capability.GroupNonUniform);
        m.capability(Capability.GroupNonUniformArithmetic);
        const t = typeOf(e.a, env);
        const float = t.scalar === 'f32' || t.scalar === 'f16';
        const opcode =
          e.op === 'add'
            ? float
              ? Op.GroupNonUniformFAdd
              : Op.GroupNonUniformIAdd
            : e.op === 'min'
              ? float
                ? Op.GroupNonUniformFMin
                : Op.GroupNonUniformUMin
              : float
                ? Op.GroupNonUniformFMax
                : Op.GroupNonUniformUMax;
        return fn.emit(opcode, valType(t), [
          m.constU32(Scope.Subgroup),
          GroupOperation.Reduce,
          expr(e.a),
        ]);
      }
    }
  }

  /** Emit statements. */
  function stmts(list: readonly Stmt[]): void {
    for (const s of list) {
      switch (s.k) {
        case 'comment':
          // SPIR-V has no comments; names are the debug channel.
          break;
        case 'let': {
          checkExpr(s.init, env);
          lets.set(s.name, expr(s.init));
          env.bind(s.name, s.type);
          break;
        }
        case 'var': {
          checkExpr(s.init, env);
          const ptr = m.typePointer(StorageClass.Function, valType(s.type));
          const pointer = fn.localVariable(ptr);
          fn.store(pointer, expr(s.init));
          vars.set(s.name, { pointer, type: s.type });
          env.bind(s.name, s.type);
          break;
        }
        case 'assign': {
          const slot = vars.get(s.name);
          if (!slot) throw new Error(`'${s.name}' is not a mutable binding`);
          checkExpr(s.value, env);
          fn.store(slot.pointer, expr(s.value));
          break;
        }
        case 'store': {
          const buf = bufferVars.get(s.buf);
          if (!buf) throw new Error(`unknown buffer binding '${s.buf}'`);
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          const chain = fn.accessChain(buf.pointee, buf.variable, [m.constU32(0), expr(s.index)]);
          let value = expr(s.value);
          if (buf.asFloatBits) {
            value = fn.emit(Op.Bitcast, valType(buf.storage), [value]);
          } else if (buf.elem.scalar === 'bool') {
            value = fn.emit(Op.Select, valType(buf.storage), [
              value,
              constant(buf.storage, 1),
              constant(buf.storage, 0),
            ]);
          }
          fn.store(chain, value);
          break;
        }
        case 'shstore': {
          const sh = sharedVars.get(s.sh);
          if (!sh) throw new Error(`unknown shared array '${s.sh}'`);
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          const chain = fn.accessChain(sh.pointee, sh.variable, [expr(s.index)]);
          fn.store(chain, expr(s.value));
          break;
        }
        case 'atomicAdd': {
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          const buf = bufferVars.get(s.buf);
          if (!buf) throw new Error(`unknown buffer binding '${s.buf}'`);
          const chain = fn.accessChain(buf.pointee, buf.variable, [m.constU32(0), expr(s.index)]);
          const elemType = valType(buf.elem);
          const scope = m.constU32(Scope.Device);
          const semantics = m.constU32(MemorySemantics.None);
          if (buf.elem.scalar === 'f32') {
            if (caps.atomicFloat) {
              m.capability(Capability.AtomicFloat32AddEXT);
              m.extension('SPV_EXT_shader_atomic_float_add');
              fn.emit(Op.AtomicFAddEXT, elemType, [chain, scope, semantics, expr(s.value)]);
            } else {
              // The chain already points at u32 storage, so no pointer needs
              // reinterpreting — only the values do.
              atomicFloatAddByCas(chain, expr(s.value));
            }
          } else {
            fn.emit(Op.AtomicIAdd, elemType, [chain, scope, semantics, expr(s.value)]);
          }
          break;
        }
        case 'matDecl':
        case 'matFill':
        case 'matLoad':
        case 'matMulAdd':
        case 'matStore':
          // Refused rather than approximated. SPIR-V has cooperative matrices, but no
          // form of them that both MoltenVK and lavapipe accept — the two targets this
          // engine actually validates against — so emitting anything here would produce
          // a module that works on one driver and is undefined on the next. A kernel
          // that needs matrices needs a different kernel on this dialect, which is what
          // the capability is for, and saying so loudly is better than a shader that
          // compiles and computes something else.
          throw new Error(
            `cooperative matrix statement '${s.k}' has no SPIR-V lowering; ` +
              'select a kernel that does not require the matrix capability',
          );
        case 'barrier':
          fn.emitVoid(Op.ControlBarrier, [
            m.constU32(Scope.Workgroup),
            m.constU32(Scope.Workgroup),
            m.constU32(MemorySemantics.AcquireRelease | MemorySemantics.WorkgroupMemory),
          ]);
          break;
        case 'for': {
          env.bind(s.v, { scalar: 'u32', lanes: 1 });
          checkExpr(s.init, env);
          checkExpr(s.limit, env);
          checkExpr(s.step, env);
          const ptr = m.typePointer(StorageClass.Function, u32);
          const pointer = fn.localVariable(ptr);
          fn.store(pointer, expr(s.init));
          vars.set(s.v, { pointer, type: { scalar: 'u32', lanes: 1 } });
          fn.loop(
            () => fn.emit(Op.ULessThan, boolT, [fn.load(u32, pointer), expr(s.limit)]),
            () => stmts(s.body),
            () => {
              const next = fn.emit(Op.IAdd, u32, [fn.load(u32, pointer), expr(s.step)]);
              fn.store(pointer, next);
            },
          );
          break;
        }
        case 'if': {
          checkExpr(s.cond, env);
          const cond = expr(s.cond);
          fn.ifThen(cond, () => stmts(s.then), s.else ? () => stmts(s.else!) : undefined);
          break;
        }
      }
    }
  }

  /**
   * Emulate a floating-point atomic add with a compare-and-swap loop.
   *
   * `OpAtomicFAddEXT` needs an extension many drivers lack, so correctness never
   * depends on it — only speed does. The buffer is already declared as `u32` when
   * this path is taken, so the loop reinterprets *values* rather than the pointer;
   * the Logical addressing model has no pointer arithmetic to reinterpret.
   *
   * @internal
   */
  function atomicFloatAddByCas(chain: Id, addend: Id): void {
    const asU32 = chain;
    const scope = m.constU32(Scope.Device);
    const semantics = m.constU32(MemorySemantics.None);
    const donePtr = m.typePointer(StorageClass.Function, boolT);
    const done = fn.localVariable(donePtr);
    fn.store(done, m.constBool(false));
    fn.loop(
      () => fn.emit(Op.LogicalNot, boolT, [fn.load(boolT, done)]),
      () => {
        const old = fn.emit(Op.AtomicLoad, u32, [asU32, scope, semantics]);
        const oldF = fn.emit(Op.Bitcast, f32, [old]);
        const sum = fn.emit(Op.FAdd, f32, [oldF, addend]);
        const sumBits = fn.emit(Op.Bitcast, u32, [sum]);
        const seen = fn.emit(Op.AtomicCompareExchange, u32, [
          asU32,
          scope,
          semantics,
          semantics,
          sumBits,
          old,
        ]);
        const won = fn.emit(Op.IEqual, boolT, [seen, old]);
        fn.store(done, won);
      },
      () => {},
    );
  }

  stmts(ir.body);
  fn.emitVoid(Op.Return);
  fn.end();

  m.entryPoint(ExecutionModel.GLCompute, fn.id, ir.name, iface);
  m.executionMode(fn.id, ExecutionMode.LocalSize, ir.wg[0], ir.wg[1], ir.wg[2]);
  m.name(fn.id, ir.name);
  return m.assemble();
}
