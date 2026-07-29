/**
 * SPIR-V module builder.
 *
 * Owns the three things that are easy to get wrong by hand and impossible to
 * debug afterwards: the specification's mandatory section order, deduplication
 * of types and constants (declaring the same type twice is invalid), and the
 * rule that `Function`-storage variables must appear in a function's first
 * block before any other instruction.
 *
 * Structured control flow is emitted through {@link FnBuilder.loop} and
 * {@link FnBuilder.ifThen} rather than by hand-rolling merge blocks, because
 * SPIR-V's rules about which block may be a merge or continue target are
 * unforgiving and a validator failure gives little clue which quad went wrong.
 *
 * @internal
 *
 * This module is re-exported through `internal:spirv`; import from there.
 */
import {
  AddressingModel,
  Capability,
  Decoration,
  FunctionControl,
  GENERATOR,
  GLSL_STD_450,
  LoopControl,
  MAGIC,
  MemoryModel,
  Op,
  SelectionControl,
  StorageClass,
  VERSION_1_3,
} from './opcodes.ts';
import { WordWriter, f32Bits, f64Bits, literalString } from './writer.ts';

/** A SPIR-V result id. */
export type Id = number;

/** Options for {@link SpirvModule}. */
export interface SpirvModuleOptions {
  /** Version word; defaults to SPIR-V 1.3. */
  version?: number;
  /**
   * Emit `OpName`/`OpMemberName` debug names.
   *
   * Off by default: names cost words in every compiled kernel and only help
   * when reading a disassembly.
   */
  names?: boolean;
}

/**
 * Builds one SPIR-V module.
 *
 * Instructions are accumulated into per-section writers and concatenated in
 * specification order by {@link assemble}.
 */
export class SpirvModule {
  #version: number;
  #emitNames: boolean;
  #nextId: Id = 1;

  #capabilities = new Set<number>();
  #extensions = new Set<string>();
  #extImports = new Map<string, Id>();
  #entryPoints = new WordWriter(32);
  #executionModes = new WordWriter(32);
  #debugNames = new WordWriter(32);
  #decorations = new WordWriter(64);
  #types = new WordWriter(128);
  #functions = new WordWriter(512);

  /**
   * Interning table for types, constants, and pointer types, keyed by a
   * canonical string. Emitting `OpTypeInt 32 0` twice is invalid SPIR-V, so
   * every declaration goes through here.
   *
   * @internal
   */
  #interned = new Map<string, Id>();

  constructor(options: SpirvModuleOptions = {}) {
    this.#version = options.version ?? VERSION_1_3;
    this.#emitNames = options.names ?? false;
    this.#capabilities.add(Capability.Shader);
  }

  /** Allocate a fresh result id. */
  id(): Id {
    return this.#nextId++;
  }

  /** Declare a capability. Repeated declarations collapse. */
  capability(value: number): void {
    this.#capabilities.add(value);
  }

  /** Declare an extension by name. Repeated declarations collapse. */
  extension(name: string): void {
    this.#extensions.add(name);
  }

  /** Import an extended instruction set, returning its id. Interned by name. */
  extInstImport(name: string): Id {
    const existing = this.#extImports.get(name);
    if (existing !== undefined) return existing;
    const id = this.id();
    this.#extImports.set(name, id);
    return id;
  }

  /** Import `GLSL.std.450`, the set holding transcendental math. */
  glsl(): Id {
    return this.extInstImport(GLSL_STD_450);
  }

  /**
   * Look up or create an interned declaration.
   *
   * @internal
   */
  #intern(key: string, emit: (id: Id) => void): Id {
    const existing = this.#interned.get(key);
    if (existing !== undefined) return existing;
    const id = this.id();
    emit(id);
    this.#interned.set(key, id);
    return id;
  }

  /** Attach a name to an id, when names are enabled. */
  name(target: Id, text: string): void {
    if (!this.#emitNames) return;
    this.#debugNames.op(Op.Name, [target, ...literalString(text)]);
  }

  /** Attach a name to a struct member, when names are enabled. */
  memberName(structType: Id, member: number, text: string): void {
    if (!this.#emitNames) return;
    this.#debugNames.op(Op.MemberName, [structType, member, ...literalString(text)]);
  }

  /** Decorate an id. */
  decorate(target: Id, decoration: number, ...literals: number[]): void {
    this.#decorations.op(Op.Decorate, [target, decoration, ...literals]);
  }

  /** Decorate a struct member. */
  memberDecorate(
    structType: Id,
    member: number,
    decoration: number,
    ...literals: number[]
  ): void {
    this.#decorations.op(Op.MemberDecorate, [structType, member, decoration, ...literals]);
  }

  // -- types ---------------------------------------------------------------

  /** `OpTypeVoid`. */
  typeVoid(): Id {
    return this.#intern('void', (id) => this.#types.op(Op.TypeVoid, [id]));
  }

  /** `OpTypeBool`. */
  typeBool(): Id {
    return this.#intern('bool', (id) => this.#types.op(Op.TypeBool, [id]));
  }

  /** `OpTypeInt`. Declares the matching width capability for 8/16/64-bit. */
  typeInt(bits: number, signed: boolean): Id {
    if (bits === 8) this.capability(Capability.Int8);
    if (bits === 16) this.capability(Capability.Int16);
    if (bits === 64) this.capability(Capability.Int64);
    return this.#intern(`int:${bits}:${signed ? 1 : 0}`, (id) =>
      this.#types.op(Op.TypeInt, [id, bits, signed ? 1 : 0]),
    );
  }

  /** `OpTypeFloat`. Declares `Float16`/`Float64` when needed. */
  typeFloat(bits: number): Id {
    if (bits === 16) this.capability(Capability.Float16);
    if (bits === 64) this.capability(Capability.Float64);
    return this.#intern(`float:${bits}`, (id) => this.#types.op(Op.TypeFloat, [id, bits]));
  }

  /** `OpTypeVector`. */
  typeVector(component: Id, count: number): Id {
    return this.#intern(`vec:${component}:${count}`, (id) =>
      this.#types.op(Op.TypeVector, [id, component, count]),
    );
  }

  /** `OpTypeArray` with a constant length id. */
  typeArray(element: Id, lengthConst: Id): Id {
    return this.#intern(`arr:${element}:${lengthConst}`, (id) =>
      this.#types.op(Op.TypeArray, [id, element, lengthConst]),
    );
  }

  /**
   * `OpTypeRuntimeArray`, the tail of a storage-buffer block.
   *
   * Not interned. A runtime array carries an `ArrayStride` decoration, and
   * decorating one id twice is invalid even when both decorations agree, so two
   * bindings of the same element type need two array types.
   */
  typeRuntimeArray(element: Id): Id {
    const id = this.id();
    this.#types.op(Op.TypeRuntimeArray, [id, element]);
    return id;
  }

  /**
   * `OpTypeStruct`.
   *
   * Structs are *not* interned: two structs with identical members may carry
   * different decorations (`Block`, member `Offset`s), so sharing one id would
   * conflate them.
   */
  typeStruct(members: readonly Id[]): Id {
    const id = this.id();
    this.#types.op(Op.TypeStruct, [id, ...members]);
    return id;
  }

  /** `OpTypePointer`. */
  typePointer(storageClass: number, pointee: Id): Id {
    return this.#intern(`ptr:${storageClass}:${pointee}`, (id) =>
      this.#types.op(Op.TypePointer, [id, storageClass, pointee]),
    );
  }

  /** `OpTypeFunction`. */
  typeFunction(returnType: Id, params: readonly Id[] = []): Id {
    return this.#intern(`fn:${returnType}:${params.join(',')}`, (id) =>
      this.#types.op(Op.TypeFunction, [id, returnType, ...params]),
    );
  }

  // -- constants -----------------------------------------------------------

  /** `OpConstant` from a raw bit pattern. */
  constantBits(type: Id, ...bits: number[]): Id {
    return this.#intern(`const:${type}:${bits.join(':')}`, (id) =>
      this.#types.op(Op.Constant, [type, id, ...bits]),
    );
  }

  /** A `u32` constant. */
  constU32(value: number): Id {
    return this.constantBits(this.typeInt(32, false), value >>> 0);
  }

  /** An `i32` constant. */
  constI32(value: number): Id {
    return this.constantBits(this.typeInt(32, true), value | 0);
  }

  /** An `f32` constant. */
  constF32(value: number): Id {
    return this.constantBits(this.typeFloat(32), f32Bits(value));
  }

  /** An `f64` constant, which occupies two literal words. */
  constF64(value: number): Id {
    const [lo, hi] = f64Bits(value);
    return this.constantBits(this.typeFloat(64), lo, hi);
  }

  /** `OpConstantTrue` / `OpConstantFalse`. */
  constBool(value: boolean): Id {
    const type = this.typeBool();
    return this.#intern(`constbool:${value ? 1 : 0}`, (id) =>
      this.#types.op(value ? Op.ConstantTrue : Op.ConstantFalse, [type, id]),
    );
  }

  /** `OpConstantComposite`. */
  constComposite(type: Id, members: readonly Id[]): Id {
    return this.#intern(`composite:${type}:${members.join(',')}`, (id) =>
      this.#types.op(Op.ConstantComposite, [type, id, ...members]),
    );
  }

  /**
   * A module-scope `OpVariable`.
   *
   * Module-scope variables live in the types/constants section, not in a
   * function body.
   */
  globalVariable(pointerType: Id, storageClass: number): Id {
    const id = this.id();
    this.#types.op(Op.Variable, [pointerType, id, storageClass]);
    return id;
  }

  // -- entry points and functions -----------------------------------------

  /** `OpEntryPoint`. `iface` lists every `Input`/`Output` variable used. */
  entryPoint(executionModel: number, fn: Id, name: string, iface: readonly Id[]): void {
    this.#entryPoints.op(Op.EntryPoint, [
      executionModel,
      fn,
      ...literalString(name),
      ...iface,
    ]);
  }

  /** `OpExecutionMode`. */
  executionMode(fn: Id, mode: number, ...literals: number[]): void {
    this.#executionModes.op(Op.ExecutionMode, [fn, mode, ...literals]);
  }

  /**
   * Begin a function. Call {@link FnBuilder.end} to close it.
   *
   * The returned builder starts an entry block automatically, since every
   * SPIR-V function needs at least one.
   */
  beginFunction(returnType: Id, fnType: Id, control = FunctionControl.None): FnBuilder {
    const id = this.id();
    return new FnBuilder(this, this.#functions, id, returnType, fnType, control);
  }

  /** Assemble the module. */
  assemble(): Uint32Array {
    const out = new WordWriter(
      64 + this.#types.length + this.#functions.length + this.#decorations.length,
    );
    out.word(MAGIC);
    out.word(this.#version);
    out.word(GENERATOR);
    // Patched below once the final id bound is known.
    const boundIndex = out.length;
    out.word(0);
    out.word(0);

    // Section order is mandated by the specification.
    for (const cap of [...this.#capabilities].sort((a, b) => a - b)) {
      out.op(Op.Capability, [cap]);
    }
    for (const ext of this.#extensions) {
      out.op(Op.Extension, literalString(ext));
    }
    for (const [name, id] of this.#extImports) {
      out.op(Op.ExtInstImport, [id, ...literalString(name)]);
    }
    out.op(Op.MemoryModel, [AddressingModel.Logical, MemoryModel.GLSL450]);
    out.append(this.#entryPoints);
    out.append(this.#executionModes);
    out.append(this.#debugNames);
    out.append(this.#decorations);
    out.append(this.#types);
    out.append(this.#functions);

    const words = out.finish();
    words[boundIndex] = this.#nextId;
    return words;
  }
}

/**
 * Builds one function body.
 *
 * `Function`-storage variables are collected separately and spliced into the
 * entry block on {@link end}, because SPIR-V requires them to precede every
 * other instruction in the first block regardless of where the caller asked for
 * them.
 */
export class FnBuilder {
  #module: SpirvModule;
  #out: WordWriter;
  #id: Id;
  #returnType: Id;
  #fnType: Id;
  #control: number;
  #entryLabel: Id;
  #locals = new WordWriter(16);
  #body = new WordWriter(256);
  #ended = false;

  constructor(
    module: SpirvModule,
    out: WordWriter,
    id: Id,
    returnType: Id,
    fnType: Id,
    control: number,
  ) {
    this.#module = module;
    this.#out = out;
    this.#id = id;
    this.#returnType = returnType;
    this.#fnType = fnType;
    this.#control = control;
    this.#entryLabel = module.id();
  }

  /** The function's result id. */
  get id(): Id {
    return this.#id;
  }

  /** The owning module, for allocating types and constants mid-body. */
  get module(): SpirvModule {
    return this.#module;
  }

  /**
   * Declare a `Function`-storage variable.
   *
   * Hoisted to the entry block automatically; safe to call at any point.
   */
  localVariable(pointerType: Id, initializer?: Id): Id {
    const id = this.#module.id();
    const operands = [pointerType, id, StorageClass.Function];
    if (initializer !== undefined) operands.push(initializer);
    this.#locals.op(Op.Variable, operands);
    return id;
  }

  /** Start a new block with a fresh label, returning the label id. */
  label(id?: Id): Id {
    const labelId = id ?? this.#module.id();
    this.#body.op(Op.Label, [labelId]);
    return labelId;
  }

  /** Emit an instruction with a result id. */
  emit(opcode: number, resultType: Id, operands: readonly number[] = []): Id {
    const id = this.#module.id();
    this.#body.op(opcode, [resultType, id, ...operands]);
    return id;
  }

  /** Emit an instruction with no result. */
  emitVoid(opcode: number, operands: readonly number[] = []): void {
    this.#body.op(opcode, operands);
  }

  /** `OpExtInst` into an imported set. */
  extInst(resultType: Id, set: Id, instruction: number, args: readonly Id[]): Id {
    return this.emit(Op.ExtInst, resultType, [set, instruction, ...args]);
  }

  /** `OpLoad`. */
  load(resultType: Id, pointer: Id): Id {
    return this.emit(Op.Load, resultType, [pointer]);
  }

  /** `OpStore`. */
  store(pointer: Id, value: Id): void {
    this.emitVoid(Op.Store, [pointer, value]);
  }

  /** `OpAccessChain`. */
  accessChain(resultType: Id, base: Id, indices: readonly Id[]): Id {
    return this.emit(Op.AccessChain, resultType, [base, ...indices]);
  }

  /** `OpBranch`. */
  branch(target: Id): void {
    this.emitVoid(Op.Branch, [target]);
  }

  /** `OpBranchConditional`. */
  branchConditional(condition: Id, whenTrue: Id, whenFalse: Id): void {
    this.emitVoid(Op.BranchConditional, [condition, whenTrue, whenFalse]);
  }

  /**
   * Emit a structured loop.
   *
   * Produces the five-block shape SPIR-V requires: a header carrying
   * `OpLoopMerge`, a condition block, the body, a continue block, and the merge
   * block. `condition` runs in the condition block and must return a `bool`;
   * `body` runs in the body block; `latch` runs in the continue block.
   *
   * Callers get correct merge/continue targets without knowing the rules.
   */
  loop(
    condition: () => Id,
    body: () => void,
    latch: () => void,
    control = LoopControl.None,
  ): void {
    const header = this.#module.id();
    const condBlock = this.#module.id();
    const bodyBlock = this.#module.id();
    const continueBlock = this.#module.id();
    const mergeBlock = this.#module.id();

    this.branch(header);
    this.label(header);
    this.emitVoid(Op.LoopMerge, [mergeBlock, continueBlock, control]);
    this.branch(condBlock);

    this.label(condBlock);
    const cond = condition();
    this.branchConditional(cond, bodyBlock, mergeBlock);

    this.label(bodyBlock);
    body();
    this.branch(continueBlock);

    this.label(continueBlock);
    latch();
    this.branch(header);

    this.label(mergeBlock);
  }

  /**
   * Emit a structured conditional.
   *
   * `OpSelectionMerge` plus the branch pair. When `whenFalse` is omitted the
   * false edge goes straight to the merge block.
   */
  ifThen(
    condition: Id,
    whenTrue: () => void,
    whenFalse?: () => void,
    control = SelectionControl.None,
  ): void {
    const thenBlock = this.#module.id();
    const elseBlock = whenFalse ? this.#module.id() : 0;
    const mergeBlock = this.#module.id();

    this.emitVoid(Op.SelectionMerge, [mergeBlock, control]);
    this.branchConditional(condition, thenBlock, whenFalse ? elseBlock : mergeBlock);

    this.label(thenBlock);
    whenTrue();
    this.branch(mergeBlock);

    if (whenFalse) {
      this.label(elseBlock);
      whenFalse();
      this.branch(mergeBlock);
    }

    this.label(mergeBlock);
  }

  /** Close the function, splicing hoisted locals into the entry block. */
  end(): Id {
    if (this.#ended) return this.#id;
    this.#ended = true;
    this.#out.op(Op.Function, [this.#returnType, this.#id, this.#control, this.#fnType]);
    this.#out.op(Op.Label, [this.#entryLabel]);
    this.#out.append(this.#locals);
    this.#out.append(this.#body);
    this.#out.op(Op.FunctionEnd, []);
    return this.#id;
  }
}
