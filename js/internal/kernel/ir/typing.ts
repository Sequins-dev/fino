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
 * This module is re-exported through `internal:kernel/ir`; import from there.
 */
import type { Expr, KernelIR, ScalarDType, ValType, VecWidth } from './types.ts';
import { scalarBytes, typeKey, vt } from './types.ts';

/** Names in scope while walking a kernel body. */
export class TypeEnv {
  #buffers = new Map<string, ValType>();
  #params = new Map<string, ValType>();
  #shared = new Map<string, ScalarDType>();
  #values = new Map<string, ValType>();

  constructor(ir?: KernelIR) {
    for (const b of ir?.buffers ?? []) this.#buffers.set(b.name, b.elem);
    for (const p of ir?.params ?? []) this.#params.set(p.name, vt(p.type));
    for (const s of ir?.shared ?? []) this.#shared.set(s.name, s.elem);
  }

  /** Copy the lexical environment for a nested block. */
  fork(): TypeEnv {
    const copy = new TypeEnv();
    copy.#buffers = new Map(this.#buffers);
    copy.#params = new Map(this.#params);
    copy.#shared = new Map(this.#shared);
    copy.#values = new Map(this.#values);
    return copy;
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
const PREDICATE_OPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'logicalAnd', 'logicalOr']);

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
  const same = (a: ValType, b: ValType) => a.scalar === b.scalar && a.lanes === b.lanes;
  const integer = (t: ValType) => ['i32', 'u32', 'u8'].includes(t.scalar);
  const numeric = (t: ValType) => t.scalar !== 'bool';
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const validType = (t: ValType) => {
    if (
      !['f32', 'f16', 'bf16', 'i32', 'u32', 'u8', 'bool'].includes(t.scalar) ||
      ![1, 2, 4].includes(t.lanes)
    )
      fail('invalid value type');
    return t;
  };
  const check = (e: Expr): ValType => checkExpr(e, env);
  switch (expr.k) {
    case 'const': {
      validType(expr.type);
      if (typeof expr.value !== 'number') fail('literal must be a number');
      if (integer(expr.type)) {
        const min = expr.type.scalar === 'i32' ? -2147483648 : 0;
        const max =
          expr.type.scalar === 'i32' ? 2147483647 : expr.type.scalar === 'u8' ? 255 : 4294967295;
        if (!Number.isInteger(expr.value) || expr.value < min || expr.value > max)
          fail('integer literal outside type range');
      }
      if (expr.type.scalar === 'bool' && expr.value !== 0 && expr.value !== 1)
        fail('bool literal must be 0 or 1');
      return expr.type;
    }
    case 'builtin':
      if (
        ![
          'globalId',
          'localId',
          'groupId',
          'numGroups',
          'globalSize',
          'subgroupSize',
          'subgroupId',
          'laneId',
        ].includes(expr.which) ||
        ![0, 1, 2].includes(expr.dim)
      )
        fail('invalid builtin');
      return vt('u32');
    case 'bin': {
      const a = check(expr.a),
        b = check(expr.b);
      if (a.scalar !== b.scalar) fail(`operator '${expr.op}' mixes types; insert an explicit cast`);
      if (a.lanes !== b.lanes && a.lanes !== 1 && b.lanes !== 1)
        fail(`operator '${expr.op}' mixes lanes`);
      if (['logicalAnd', 'logicalOr'].includes(expr.op)) {
        if (a.scalar !== 'bool') fail('logical operator requires bool');
      } else if (['and', 'or', 'xor', 'shl', 'shr', 'mulhi'].includes(expr.op)) {
        if (!integer(a) || (expr.op === 'mulhi' && a.scalar !== 'u32'))
          fail('integer operator has invalid type');
      } else if (!['eq', 'ne'].includes(expr.op) && !numeric(a))
        fail('numeric operator requires a number');
      if (
        ![
          'add',
          'sub',
          'mul',
          'div',
          'mod',
          'min',
          'max',
          'and',
          'or',
          'xor',
          'shl',
          'shr',
          'mulhi',
          'eq',
          'ne',
          'lt',
          'le',
          'gt',
          'ge',
          'logicalAnd',
          'logicalOr',
        ].includes(expr.op)
      )
        fail('unknown binary operator');
      return typeOf(expr, env);
    }
    case 'select': {
      const cond = check(expr.cond),
        a = check(expr.a),
        b = check(expr.b);
      if (cond.scalar !== 'bool' || (cond.lanes !== 1 && cond.lanes !== a.lanes) || !same(a, b))
        fail('select condition or arm type mismatch');
      return a;
    }
    case 'lane': {
      const a = check(expr.a);
      if (!Number.isInteger(expr.i) || expr.i < 0 || expr.i >= a.lanes)
        fail('lane index out of range');
      return vt(a.scalar);
    }
    case 'vec':
      validType(expr.type);
      if (expr.lanes.length !== expr.type.lanes) fail('vector lane count mismatch');
      for (const lane of expr.lanes)
        if (!same(check(lane), vt(expr.type.scalar))) fail('vector lane type mismatch');
      return expr.type;
    case 'bitcast': {
      const a = check(expr.a),
        to = validType(expr.to);
      if (
        a.scalar === 'bool' ||
        to.scalar === 'bool' ||
        scalarBytes(a.scalar) * a.lanes !== scalarBytes(to.scalar) * to.lanes
      )
        fail('bitcast changes width or uses bool');
      return to;
    }
    case 'cast': {
      const a = check(expr.a),
        to = validType(expr.to);
      if (a.lanes !== to.lanes) fail('cast changes lane count');
      return to;
    }
    case 'un': {
      const a = check(expr.a);
      if (expr.op === 'not' ? a.scalar !== 'bool' : !numeric(a))
        fail('unary operator type mismatch');
      if (!['neg', 'not', 'abs'].includes(expr.op)) fail('unknown unary operator');
      return a;
    }
    case 'call': {
      const arity = {
        exp: 1,
        log: 1,
        sqrt: 1,
        rsqrt: 1,
        tanh: 1,
        sin: 1,
        cos: 1,
        pow: 2,
        fma: 3,
        floor: 1,
        ceil: 1,
        round: 1,
        clamp: 3,
      }[expr.fn];
      if (!arity || expr.args.length !== arity) fail('math argument count mismatch');
      const ts = expr.args.map(check),
        a = ts[0];
      if (!['f32', 'f16', 'bf16'].includes(a.scalar)) fail('math argument must be floating point');
      const width = Math.max(...ts.map((t) => t.lanes));
      if (ts.some((t) => t.scalar !== a.scalar || (t.lanes !== 1 && t.lanes !== width)))
        fail('math argument type mismatch');
      return typeOf(expr, env);
    }
    case 'load':
    case 'shload': {
      const index = check(expr.index);
      if (!integer(index) || index.lanes !== 1) fail('memory index must be a scalar integer');
      return expr.k === 'load' ? env.buffer(expr.buf) : vt(env.sharedElem(expr.sh));
    }
    case 'subgroup': {
      const a = check(expr.a);
      if (!numeric(a) || !['add', 'min', 'max'].includes(expr.op))
        fail('subgroup operator type mismatch');
      return a;
    }
    case 'param':
      return env.param(expr.name);
    case 'let':
    case 'var':
      return env.value(expr.name);
    default:
      return fail('unknown expression kind');
  }
}
