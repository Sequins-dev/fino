/**
 * Type inference over kernel IR expressions.
 *
 * Both lowerings need every expression's type: MSL to declare locals, SPIR-V
 * because every instruction names its result type explicitly. Inferring once
 * here keeps the two dialects from disagreeing about what an expression means,
 * which is the failure mode that would make the IR quietly non-neutral.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import type { Expr, KernelIR, ScalarDType, ValType, VecWidth } from './types.ts';
import { typeKey, vt } from './types.ts';

/** Names in scope while walking a kernel body. */
export class TypeEnv {
  #buffers = new Map<string, ValType>();
  #params = new Map<string, ValType>();
  #shared = new Map<string, ScalarDType>();
  #values = new Map<string, ValType>();

  constructor(ir: KernelIR) {
    for (const b of ir.buffers) this.#buffers.set(b.name, b.elem);
    for (const p of ir.params) this.#params.set(p.name, vt(p.type));
    for (const s of ir.shared) this.#shared.set(s.name, s.elem);
  }

  /** Element type of a buffer binding. */
  buffer(name: string): ValType {
    const t = this.#buffers.get(name);
    if (!t) throw new Error(`unknown buffer binding '${name}'`);
    return t;
  }

  /** Element type of a shared array. */
  sharedElem(name: string): ScalarDType {
    const t = this.#shared.get(name);
    if (!t) throw new Error(`unknown shared array '${name}'`);
    return t;
  }

  /** Type of a scalar parameter. */
  param(name: string): ValType {
    const t = this.#params.get(name);
    if (!t) throw new Error(`unknown kernel parameter '${name}'`);
    return t;
  }

  /** Type of a `let` or `var` binding. */
  value(name: string): ValType {
    const t = this.#values.get(name);
    if (!t) throw new Error(`'${name}' is not in scope`);
    return t;
  }

  /** Introduce a `let` or `var` binding. */
  bind(name: string, type: ValType): void {
    this.#values.set(name, type);
  }

  /** Whether a name is bound as a value. */
  has(name: string): boolean {
    return this.#values.has(name);
  }
}

/** Operators whose result is `bool` regardless of operand type. */
const PREDICATE_OPS = new Set([
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'logicalAnd',
  'logicalOr',
]);

/** Infer the type of an expression. */
export function typeOf(expr: Expr, env: TypeEnv): ValType {
  switch (expr.k) {
    case 'const':
      return expr.type;
    case 'param':
      return env.param(expr.name);
    case 'builtin':
      // Every thread-index and subgroup built-in is an unsigned scalar.
      return vt('u32');
    case 'let':
    case 'var':
      return env.value(expr.name);
    case 'load':
      return env.buffer(expr.buf);
    case 'shload':
      return vt(env.sharedElem(expr.sh));
    case 'bin': {
      // A binary operation may legitimately mix a vector with a scalar, and when it does
      // the result is as wide as the wider side — reading the width off the left operand
      // alone called `scalarParam == vec4Literal` a scalar comparison, which MSL was
      // happy to broadcast and SPIR-V rejected outright once anything was vectorised.
      const lanes = Math.max(typeOf(expr.a, env).lanes, typeOf(expr.b, env).lanes) as VecWidth;
      if (PREDICATE_OPS.has(expr.op)) return vt('bool', lanes);
      if (expr.op === 'mulhi') return vt('u32', lanes);
      return vt(typeOf(expr.a, env).scalar, lanes);
    }
    case 'un':
      return typeOf(expr.a, env);
    case 'call': {
      if (expr.args.length === 0) throw new Error(`math call '${expr.fn}' needs an argument`);
      // As with a binary operation, an argument may be a scalar standing in for a vector
      // — `pow(vector, scalarExponent)` — so the call is as wide as its widest argument.
      const lanes = expr.args.reduce(
        (widest, arg) => Math.max(widest, typeOf(arg, env).lanes),
        1,
      ) as VecWidth;
      return vt(typeOf(expr.args[0]!, env).scalar, lanes);
    }
    case 'select':
      return typeOf(expr.a, env);
    case 'cast':
    case 'bitcast':
      return expr.to;
    case 'lane':
      return vt(typeOf(expr.a, env).scalar, 1);
    case 'vec':
      return expr.type;
    case 'subgroup':
      return typeOf(expr.a, env);
  }
}

/**
 * Check that an expression is well-typed, throwing with a readable path when it
 * is not.
 *
 * Lowerings call this so a malformed template fails at emit time with the
 * offending operator named, rather than producing a shader whose driver error
 * points nowhere useful.
 */
export function checkExpr(expr: Expr, env: TypeEnv): ValType {
  switch (expr.k) {
    case 'bin': {
      const a = checkExpr(expr.a, env);
      const b = checkExpr(expr.b, env);
      // Shifts and vector-by-scalar operations legitimately mix widths; equal
      // scalar types are required everywhere else.
      const shiftLike = expr.op === 'shl' || expr.op === 'shr';
      if (!shiftLike && a.scalar !== b.scalar) {
        throw new Error(
          `operator '${expr.op}' mixes ${typeKey(a)} and ${typeKey(b)}; insert an explicit cast`,
        );
      }
      if (a.lanes !== b.lanes && b.lanes !== 1 && a.lanes !== 1) {
        throw new Error(
          `operator '${expr.op}' mixes ${a.lanes} and ${b.lanes} lanes`,
        );
      }
      return typeOf(expr, env);
    }
    case 'select': {
      const cond = checkExpr(expr.cond, env);
      if (cond.scalar !== 'bool') {
        throw new Error(`select condition must be bool, got ${typeKey(cond)}`);
      }
      const a = checkExpr(expr.a, env);
      const b = checkExpr(expr.b, env);
      if (a.scalar !== b.scalar) {
        throw new Error(`select arms differ: ${typeKey(a)} and ${typeKey(b)}`);
      }
      return a;
    }
    case 'lane': {
      const a = checkExpr(expr.a, env);
      if (expr.i >= a.lanes) {
        throw new Error(`lane ${expr.i} is out of range for ${typeKey(a)}`);
      }
      return vt(a.scalar, 1);
    }
    case 'vec': {
      if (expr.lanes.length !== expr.type.lanes) {
        throw new Error(
          `vector of ${typeKey(expr.type)} needs ${expr.type.lanes} lanes, got ${expr.lanes.length}`,
        );
      }
      for (const lane of expr.lanes) checkExpr(lane, env);
      return expr.type;
    }
    case 'bitcast': {
      const a = checkExpr(expr.a, env);
      const from = scalarWidth(a.scalar) * a.lanes;
      const to = scalarWidth(expr.to.scalar) * expr.to.lanes;
      if (from !== to) {
        throw new Error(
          `bitcast changes width: ${typeKey(a)} (${from} bytes) to ${typeKey(expr.to)} (${to} bytes)`,
        );
      }
      return expr.to;
    }
    case 'un':
    case 'cast':
    case 'subgroup':
      checkExpr(expr.a, env);
      return typeOf(expr, env);
    case 'call':
      for (const arg of expr.args) checkExpr(arg, env);
      return typeOf(expr, env);
    case 'load':
      checkExpr(expr.index, env);
      return env.buffer(expr.buf);
    case 'shload':
      checkExpr(expr.index, env);
      return vt(env.sharedElem(expr.sh));
    default:
      return typeOf(expr, env);
  }
}

/**
 * Byte width of a scalar type.
 *
 * @internal
 */
function scalarWidth(s: ScalarDType): number {
  switch (s) {
    case 'f32':
    case 'i32':
    case 'u32':
      return 4;
    case 'f16':
    case 'bf16':
      return 2;
    case 'u8':
    case 'bool':
      return 1;
  }
}
