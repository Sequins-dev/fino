/**
 * Ergonomic construction of kernel IR.
 *
 * TypeScript has no operator overloading, so IR is built from small helper
 * calls. `E.*` builds expressions, `KernelBuilder` accumulates statements and
 * declarations, and `unroll` is how templates emit repeated statements — that is
 * where GEMM's register blocking comes from, rather than from IR array types.
 *
 * @internal
 *
 * This module is re-exported through `internal:kernel/ir`; import from there.
 */
import type {
  BinOp,
  BufferBinding,
  Builtin,
  Expr,
  KernelCaps,
  KernelIR,
  MathFn,
  ScalarDType,
  ScalarParam,
  SharedDecl,
  Stmt,
  UnOp,
  ValType,
  VecWidth,
} from './types.ts';
import { validateKernel, vt } from './types.ts';

const F32 = vt('f32');
const U32 = vt('u32');
const I32 = vt('i32');
const BOOL = vt('bool');

/** Expression constructors. */
export const E = {
  /** A typed literal. */
  const: (type: ValType, value: number): Expr => ({ k: 'const', type, value }),
  /** An `f32` literal. */
  f32: (value: number): Expr => ({ k: 'const', type: F32, value }),
  /** A `u32` literal. */
  u32: (value: number): Expr => ({ k: 'const', type: U32, value }),
  /** An `i32` literal. */
  i32: (value: number): Expr => ({ k: 'const', type: I32, value }),
  /** A `bool` literal. */
  bool: (value: boolean): Expr => ({ k: 'const', type: BOOL, value: value ? 1 : 0 }),
  /** Read a scalar kernel parameter. */
  param: (name: string): Expr => ({ k: 'param', name }),
  /** Read a thread-index or subgroup built-in. */
  builtin: (which: Builtin, dim: 0 | 1 | 2 = 0): Expr => ({ k: 'builtin', which, dim }),
  /** Reference a `let` binding. */
  let: (name: string): Expr => ({ k: 'let', name }),
  /** Read a mutable `var`. */
  var: (name: string): Expr => ({ k: 'var', name }),
  /** Load from a buffer binding at an element index. */
  load: (buf: string, index: Expr): Expr => ({ k: 'load', buf, index }),
  /** Load from a workgroup-shared array. */
  shload: (sh: string, index: Expr): Expr => ({ k: 'shload', sh, index }),
  /** A binary operation. */
  bin: (op: BinOp, a: Expr, b: Expr): Expr => ({ k: 'bin', op, a, b }),
  /** A unary operation. */
  un: (op: UnOp, a: Expr): Expr => ({ k: 'un', op, a }),
  /** A math-function call. */
  call: (fn: MathFn, ...args: Expr[]): Expr => ({ k: 'call', fn, args }),
  /** Ternary select. */
  select: (cond: Expr, a: Expr, b: Expr): Expr => ({ k: 'select', cond, a, b }),
  /** Numeric conversion. */
  cast: (to: ValType, a: Expr): Expr => ({ k: 'cast', to, a }),
  /** Same-width reinterpretation. */
  bitcast: (to: ValType, a: Expr): Expr => ({ k: 'bitcast', to, a }),
  /** Extract one lane of a vector. */
  lane: (a: Expr, i: 0 | 1 | 2 | 3): Expr => ({ k: 'lane', a, i }),
  /** Construct a vector from lane values. */
  vec: (type: ValType, lanes: Expr[]): Expr => ({ k: 'vec', type, lanes }),
  /** A subgroup reduction across the active lanes. */
  subgroup: (op: 'add' | 'min' | 'max', a: Expr): Expr => ({ k: 'subgroup', op, a }),

  // Arithmetic shorthands, since `E.bin('add', a, b)` reads poorly when nested.
  add: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'add', a, b }),
  sub: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'sub', a, b }),
  mul: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'mul', a, b }),
  div: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'div', a, b }),
  mod: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'mod', a, b }),
  min: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'min', a, b }),
  max: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'max', a, b }),
  lt: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'lt', a, b }),
  le: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'le', a, b }),
  gt: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'gt', a, b }),
  ge: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'ge', a, b }),
  eq: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'eq', a, b }),
  ne: (a: Expr, b: Expr): Expr => ({ k: 'bin', op: 'ne', a, b }),
} as const;

/**
 * Accumulates one kernel's declarations and body.
 *
 * Statement helpers append to the innermost open block, so `for` and `if` bodies
 * are written with a callback rather than by juggling arrays.
 */
export class KernelBuilder {
  #name: string;
  #wg: [number, number, number];
  #buffers: BufferBinding[] = [];
  #params: ScalarParam[] = [];
  #shared: SharedDecl[] = [];
  #caps: KernelCaps = {};

  /**
   * Block stack; the last entry is where statements land.
   *
   * @internal
   */
  #stack: Stmt[][] = [[]];
  #temps = 0;

  constructor(name: string, wg: [number, number, number] = [256, 1, 1]) {
    this.#name = name;
    this.#wg = wg;
  }

  /** Declare a buffer binding and return its name. */
  buffer(name: string, elem: ValType, access: BufferBinding['access']): string {
    this.#buffers.push({ name, elem, access });
    if (elem.scalar === 'f16') this.#caps.f16 = true;
    return name;
  }

  /** Declare a scalar parameter and return an expression reading it. */
  param(name: string, type: ScalarParam['type'] = 'u32'): Expr {
    this.#params.push({ name, type });
    return E.param(name);
  }

  /** Declare a workgroup-shared array and return its name. */
  shared(name: string, elem: ScalarDType, length: number): string {
    this.#shared.push({ name, elem, length });
    return name;
  }

  /** Require a target capability. */
  require(caps: KernelCaps): void {
    Object.assign(this.#caps, caps);
  }

  /**
   * Current block, for statement helpers.
   *
   * @internal
   */
  #here(): Stmt[] {
    return this.#stack[this.#stack.length - 1]!;
  }

  /** Generate a unique temporary name with the given prefix. */
  temp(prefix = 't'): string {
    return `${prefix}${this.#temps++}`;
  }

  /** Bind an immutable value; returns an expression referencing it. */
  let(name: string, type: ValType, init: Expr): Expr {
    this.#here().push({ k: 'let', name, type, init });
    return E.let(name);
  }

  /** Bind an immutable value under a generated name. */
  letTemp(type: ValType, init: Expr, prefix = 'v'): Expr {
    return this.let(this.temp(prefix), type, init);
  }

  /** Declare a mutable register; returns an expression reading it. */
  var(name: string, type: ValType, init: Expr): Expr {
    this.#here().push({ k: 'var', name, type, init });
    return E.var(name);
  }

  /** Assign to a mutable register. */
  assign(name: string, value: Expr): void {
    this.#here().push({ k: 'assign', name, value });
  }

  /** Store to a buffer binding. */
  store(buf: string, index: Expr, value: Expr): void {
    this.#here().push({ k: 'store', buf, index, value });
  }

  /** Store to a workgroup-shared array. */
  shstore(sh: string, index: Expr, value: Expr): void {
    this.#here().push({ k: 'shstore', sh, index, value });
  }

  /** Atomically add to a buffer element. */
  atomicAdd(buf: string, index: Expr, value: Expr): void {
    const binding = this.#buffers.find((b) => b.name === buf);
    if (binding && binding.elem.scalar === 'f32') this.#caps.atomicFloat = true;
    this.#here().push({ k: 'atomicAdd', buf, index, value });
  }

  /** Emit a workgroup barrier. */
  barrier(): void {
    this.#here().push({ k: 'barrier' });
  }

  /** Attach a comment; MSL renders it, SPIR-V drops it. */
  comment(text: string): void {
    this.#here().push({ k: 'comment', text });
  }

  /**
   * Emit a counted loop `for (v = init; v < limit; v += step)`.
   *
   * The callback receives an expression reading the induction variable.
   */
  for(v: string, init: Expr, limit: Expr, step: Expr, body: (i: Expr) => void): void {
    const block: Stmt[] = [];
    this.#stack.push(block);
    try {
      body(E.var(v));
    } finally {
      this.#stack.pop();
    }
    this.#here().push({ k: 'for', v, init, limit, step, body: block });
  }

  /**
   * Emit a grid-stride loop over `count` elements.
   *
   * The canonical shape for every elementwise and reduction kernel: each thread
   * starts at its global index and strides by the total grid size, so one kernel
   * handles any element count without an edge-case branch.
   */
  gridStride(count: Expr, body: (i: Expr) => void, name = 'i'): void {
    this.for(name, E.builtin('globalId', 0), count, E.builtin('globalSize', 0), body);
  }

  /** Emit a conditional. */
  if(cond: Expr, then: () => void, otherwise?: () => void): void {
    const thenBlock: Stmt[] = [];
    this.#stack.push(thenBlock);
    try {
      then();
    } finally {
      this.#stack.pop();
    }
    let elseBlock: Stmt[] | undefined;
    if (otherwise) {
      elseBlock = [];
      this.#stack.push(elseBlock);
      try {
        otherwise();
      } finally {
        this.#stack.pop();
      }
    }
    this.#here().push({ k: 'if', cond, then: thenBlock, else: elseBlock });
  }

  /** Finish and validate the kernel. */
  build(): KernelIR {
    if (this.#stack.length !== 1) throw new Error('unbalanced block stack');
    const ir: KernelIR = {
      name: this.#name,
      wg: this.#wg,
      buffers: this.#buffers,
      params: this.#params,
      shared: this.#shared,
      body: this.#stack[0]!,
      caps: this.#caps,
    };
    validateKernel(ir);
    return structuredClone(ir);
  }
}

/**
 * Run `body` for each index in `[0, n)`.
 *
 * This is how templates unroll: the loop runs at emit time in TypeScript, so the
 * IR receives `n` repeated statements with constant indices. Register blocking
 * and fixed-size reduction trees both come from here.
 */
export function unroll(n: number, body: (i: number) => void): void {
  for (let i = 0; i < n; i++) body(i);
}

/** Run `body` for each index pair in `[0, m) x [0, n)`. */
export function unroll2(m: number, n: number, body: (i: number, j: number) => void): void {
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) body(i, j);
}
