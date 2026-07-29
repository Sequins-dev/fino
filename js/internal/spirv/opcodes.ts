/**
 * SPIR-V numeric enumerants.
 *
 * Hand-transcribed from the SPIR-V specification's unified grammar, restricted
 * to what a compute-only emitter needs. Values are fixed by the specification
 * and never change; adding an entry means reading the spec, not regenerating.
 *
 * Reference: https://registry.khronos.org/SPIR-V/
 *
 * @internal
 *
 * This module is re-exported through `internal:spirv`; import from there.
 */

/** SPIR-V magic number, the first word of every module. */
export const MAGIC = 0x07230203;

/** Version word for SPIR-V 1.3 (Vulkan 1.1), the baseline this emitter targets. */
export const VERSION_1_3 = 0x00010300;

/** Version word for SPIR-V 1.0 (Vulkan 1.0). */
export const VERSION_1_0 = 0x00010000;

/**
 * Generator magic number.
 *
 * The high 16 bits identify the tool. Khronos maintains a registry of assigned
 * values; 0 is the reserved "unknown" generator, which is valid and what an
 * unregistered emitter should use.
 */
export const GENERATOR = 0x00000000;

/** Instruction opcodes. */
export const Op = {
  Nop: 0,
  Name: 5,
  MemberName: 6,
  Extension: 10,
  ExtInstImport: 11,
  ExtInst: 12,
  MemoryModel: 14,
  EntryPoint: 15,
  ExecutionMode: 16,
  Capability: 17,
  TypeVoid: 19,
  TypeBool: 20,
  TypeInt: 21,
  TypeFloat: 22,
  TypeVector: 23,
  TypeArray: 28,
  TypeRuntimeArray: 29,
  TypeStruct: 30,
  TypePointer: 32,
  TypeFunction: 33,
  ConstantTrue: 41,
  ConstantFalse: 42,
  Constant: 43,
  ConstantComposite: 44,
  Function: 54,
  FunctionEnd: 56,
  Variable: 59,
  Load: 61,
  Store: 62,
  AccessChain: 65,
  Decorate: 71,
  MemberDecorate: 72,
  CompositeConstruct: 80,
  CompositeExtract: 81,
  Bitcast: 124,
  SNegate: 126,
  FNegate: 127,
  IAdd: 128,
  FAdd: 129,
  ISub: 130,
  FSub: 131,
  IMul: 132,
  FMul: 133,
  UDiv: 134,
  SDiv: 135,
  FDiv: 136,
  UMod: 137,
  SRem: 138,
  FRem: 141,
  UMulExtended: 151,
  ConvertFToU: 109,
  ConvertFToS: 110,
  ConvertSToF: 111,
  ConvertUToF: 112,
  UConvert: 113,
  SConvert: 114,
  FConvert: 115,
  LogicalOr: 166,
  LogicalAnd: 167,
  LogicalNot: 168,
  Select: 169,
  IEqual: 170,
  INotEqual: 171,
  UGreaterThan: 172,
  SGreaterThan: 173,
  UGreaterThanEqual: 174,
  SGreaterThanEqual: 175,
  ULessThan: 176,
  SLessThan: 177,
  ULessThanEqual: 178,
  SLessThanEqual: 179,
  FOrdEqual: 180,
  FOrdNotEqual: 182,
  FOrdLessThan: 184,
  FOrdGreaterThan: 186,
  FOrdLessThanEqual: 188,
  FOrdGreaterThanEqual: 190,
  ShiftRightLogical: 194,
  ShiftRightArithmetic: 195,
  ShiftLeftLogical: 196,
  BitwiseOr: 197,
  BitwiseXor: 198,
  BitwiseAnd: 199,
  Not: 200,
  ControlBarrier: 224,
  MemoryBarrier: 225,
  AtomicIAdd: 234,
  AtomicCompareExchange: 230,
  AtomicLoad: 227,
  AtomicStore: 228,
  Phi: 245,
  LoopMerge: 246,
  SelectionMerge: 247,
  Label: 248,
  Branch: 249,
  BranchConditional: 250,
  Return: 253,
  Unreachable: 255,
  GroupNonUniformIAdd: 349,
  GroupNonUniformFAdd: 350,
  GroupNonUniformIMul: 351,
  GroupNonUniformFMul: 352,
  GroupNonUniformSMin: 353,
  GroupNonUniformUMin: 354,
  GroupNonUniformFMin: 355,
  GroupNonUniformSMax: 356,
  GroupNonUniformUMax: 357,
  GroupNonUniformFMax: 358,
  AtomicFAddEXT: 6035,
} as const;

/** Reverse map from opcode number to spec name, for diagnostics. */
export const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Op).map(([name, value]) => [value, name]),
);

/** Capabilities declared in the module header. */
export const Capability = {
  Matrix: 0,
  Shader: 1,
  Float16: 9,
  Float64: 10,
  Int64: 11,
  Int16: 22,
  Int8: 39,
  GroupNonUniform: 61,
  GroupNonUniformArithmetic: 63,
  StorageBuffer16BitAccess: 4433,
  UniformAndStorageBuffer16BitAccess: 4434,
  StorageBuffer8BitAccess: 4448,
  VulkanMemoryModel: 5345,
  AtomicFloat32AddEXT: 6033,
} as const;

/** Addressing models. */
export const AddressingModel = { Logical: 0, Physical32: 1, Physical64: 2 } as const;

/** Memory models. */
export const MemoryModel = { Simple: 0, GLSL450: 1, OpenCL: 2, Vulkan: 3 } as const;

/** Execution models; compute shaders are `GLCompute`. */
export const ExecutionModel = { Vertex: 0, Fragment: 4, GLCompute: 5, Kernel: 6 } as const;

/** Execution modes. */
export const ExecutionMode = { LocalSize: 17, LocalSizeId: 38 } as const;

/** Storage classes. */
export const StorageClass = {
  UniformConstant: 0,
  Input: 1,
  Uniform: 2,
  Output: 3,
  Workgroup: 4,
  CrossWorkgroup: 5,
  Private: 6,
  Function: 7,
  PushConstant: 9,
  StorageBuffer: 12,
} as const;

/** Decorations. */
export const Decoration = {
  Block: 2,
  RowMajor: 4,
  ColMajor: 5,
  ArrayStride: 6,
  MatrixStride: 7,
  BuiltIn: 11,
  NoPerspective: 13,
  Flat: 14,
  NonWritable: 24,
  NonReadable: 25,
  Uniform: 26,
  Location: 30,
  Binding: 33,
  DescriptorSet: 34,
  Offset: 35,
  SpecId: 1,
  RelaxedPrecision: 0,
  Coherent: 23,
} as const;

/** Built-in variable kinds. */
export const BuiltIn = {
  WorkgroupSize: 25,
  NumWorkgroups: 24,
  WorkgroupId: 26,
  LocalInvocationId: 27,
  GlobalInvocationId: 28,
  LocalInvocationIndex: 29,
  SubgroupSize: 36,
  NumSubgroups: 38,
  SubgroupId: 40,
  SubgroupLocalInvocationId: 41,
} as const;

/** Memory-ordering semantics bitmask for barriers and atomics. */
export const MemorySemantics = {
  None: 0x0,
  Acquire: 0x2,
  Release: 0x4,
  AcquireRelease: 0x8,
  UniformMemory: 0x40,
  WorkgroupMemory: 0x100,
  ImageMemory: 0x800,
} as const;

/** Execution/memory scopes. */
export const Scope = {
  CrossDevice: 0,
  Device: 1,
  Workgroup: 2,
  Subgroup: 3,
  Invocation: 4,
} as const;

/** Group operation kinds for subgroup reductions. */
export const GroupOperation = {
  Reduce: 0,
  InclusiveScan: 1,
  ExclusiveScan: 2,
} as const;

/** Function control bitmask. */
export const FunctionControl = { None: 0, Inline: 1, DontInline: 2, Pure: 4, Const: 8 } as const;

/** Loop control bitmask. */
export const LoopControl = { None: 0, Unroll: 1, DontUnroll: 2 } as const;

/** Selection control bitmask. */
export const SelectionControl = { None: 0, Flatten: 1, DontFlatten: 2 } as const;

/**
 * `GLSL.std.450` extended-instruction numbers.
 *
 * Transcendental math in SPIR-V lives in this extended instruction set rather
 * than in core opcodes, so every call goes through `OpExtInst`.
 */
export const Glsl = {
  Round: 1,
  RoundEven: 2,
  Trunc: 3,
  FAbs: 4,
  SAbs: 5,
  FSign: 6,
  Floor: 8,
  Ceil: 9,
  Fract: 10,
  Sin: 13,
  Cos: 14,
  Tan: 15,
  Asin: 16,
  Acos: 17,
  Atan: 18,
  Sinh: 19,
  Cosh: 20,
  Tanh: 21,
  Atan2: 25,
  Pow: 26,
  Exp: 27,
  Log: 28,
  Exp2: 29,
  Log2: 30,
  Sqrt: 31,
  InverseSqrt: 32,
  Fma: 50,
  FMin: 37,
  UMin: 38,
  SMin: 39,
  FMax: 40,
  UMax: 41,
  SMax: 42,
  FClamp: 43,
  FMix: 46,
  Step: 48,
} as const;

/** The extended instruction set name imported for {@link Glsl}. */
export const GLSL_STD_450 = 'GLSL.std.450';
