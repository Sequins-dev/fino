/**
 * Lower kernel IR to Metal Shading Language.
 *
 * MSL is a text dialect, so this is string assembly — the simplest of the
 * lowerings, and the reason Metal is a good first hardware target.
 *
 * Every Metal-specific decision lives in this file. A dialect conditional
 * anywhere in `../templates/` is a design bug: the templates exist to hold
 * numerics, and this file exists to hold Metal.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */
import type {
  BinOp,
  Expr,
  KernelIR,
  MathFn,
  ScalarDType,
  Stmt,
  ValType,
} from '../types.ts';
import { validateKernel } from '../types.ts';
import { TypeEnv, checkExpr, typeOf } from '../typing.ts';

/** Options for {@link lowerToMSL}. */
export interface MslOptions {
  /**
   * Language version to target.
   *
   * `bfloat` requires MSL 3.1 (macOS 14). Below that, bf16 is emitted as `ushort`
   * storage with explicit bit manipulation.
   */
  version?: '2.4' | '3.0' | '3.1';
  /**
   * Whether the compiler will run with fast math enabled.
   *
   * Recorded here only so the caller can key its kernel cache on it. Metal
   * enables fast math by default, and this engine turns it off, because
   * NaN/infinity relaxations make differential tests against SPIR-V flap.
   */
  fastMath?: boolean;
}

/** Scalar type spellings. */
function mslScalar(s: ScalarDType, version: string): string {
  switch (s) {
    case 'f32':
      return 'float';
    case 'f16':
      return 'half';
    case 'bf16':
      // Native bfloat is MSL 3.1+; older versions carry the bits in a ushort
      // and convert explicitly (see castExpr).
      return version === '3.1' ? 'bfloat' : 'ushort';
    case 'i32':
      return 'int';
    case 'u32':
      return 'uint';
    case 'u8':
      return 'uchar';
    case 'bool':
      return 'bool';
  }
}

/** Value type spellings, including vector widths. */
function mslType(t: ValType, version: string): string {
  const base = mslScalar(t.scalar, version);
  return t.lanes === 1 ? base : `${base}${t.lanes}`;
}

/**
 * Storage form of a buffer element type.
 *
 * Booleans occupy one byte holding exactly 0 or 1. Metal would accept `bool` in
 * device memory, but SPIR-V forbids it, and buffer layouts must match byte for
 * byte across backends for differential tests to compare device memory at all.
 */
function storageValType(t: ValType): ValType {
  return t.scalar === 'bool' ? { scalar: 'u8', lanes: t.lanes } : t;
}

/** Binary operator spellings; `undefined` means "emit as a function call". */
const BIN_INFIX: Partial<Record<BinOp, string>> = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
  mod: '%',
  and: '&',
  or: '|',
  xor: '^',
  shl: '<<',
  shr: '>>',
  eq: '==',
  ne: '!=',
  lt: '<',
  le: '<=',
  gt: '>',
  ge: '>=',
  logicalAnd: '&&',
  logicalOr: '||',
};

/** Math function spellings. */
const MATH_FN: Record<MathFn, string> = {
  exp: 'exp',
  log: 'log',
  sqrt: 'sqrt',
  rsqrt: 'rsqrt',
  tanh: 'tanh',
  sin: 'sin',
  cos: 'cos',
  pow: 'pow',
  fma: 'fma',
  floor: 'floor',
  ceil: 'ceil',
  round: 'rint',
  clamp: 'clamp',
};

/** Built-in thread-index arguments, added to the entry signature on demand. */
const BUILTIN_ARGS: Record<string, { name: string; attr: string; type: string }> = {
  globalId: { name: '_gid', attr: 'thread_position_in_grid', type: 'uint3' },
  localId: { name: '_lid', attr: 'thread_position_in_threadgroup', type: 'uint3' },
  groupId: { name: '_wgid', attr: 'threadgroup_position_in_grid', type: 'uint3' },
  numGroups: { name: '_nwg', attr: 'threadgroups_per_grid', type: 'uint3' },
  globalSize: { name: '_gsz', attr: 'threads_per_grid', type: 'uint3' },
  subgroupSize: { name: '_sgsz', attr: 'threads_per_simdgroup', type: 'uint' },
  subgroupId: { name: '_sgid', attr: 'simdgroup_index_in_threadgroup', type: 'uint' },
  laneId: { name: '_lane', attr: 'thread_index_in_simdgroup', type: 'uint' },
};

/** Lane suffix for the vector-valued built-ins. */
const DIM_SUFFIX = ['x', 'y', 'z'] as const;

/**
 * The MSL scalar name for a matrix's elements.
 *
 * @internal
 */
function matrixElem(type: ScalarDType): string {
  if (type === 'f32') return 'float';
  if (type === 'f16') return 'half';
  throw new Error(`cooperative matrices are only lowered for f32 and f16, not '${type}'`);
}

/**
 * The MSL type of an 8x8 matrix.
 *
 * @internal
 */
function matrixType(type: ScalarDType): string {
  return `simdgroup_${matrixElem(type)}8x8`;
}

/**
 * Lower a kernel to MSL source text.
 */
export function lowerToMSL(ir: KernelIR, options: MslOptions = {}): string {
  validateKernel(ir);
  const version = options.version ?? '3.0';
  const env = new TypeEnv(ir);
  const usedBuiltins = new Set<string>();

  /** Render an expression, parenthesising sub-expressions conservatively. */
  function expr(e: Expr): string {
    switch (e.k) {
      case 'const': {
        const t = e.type;
        if (t.scalar === 'bool') return e.value ? 'true' : 'false';
        if (t.scalar === 'f32' || t.scalar === 'f16' || t.scalar === 'bf16') {
          return floatLiteral(e.value, t, version);
        }
        if (t.scalar === 'u32') return `${e.value >>> 0}u`;
        return String(e.value | 0);
      }
      case 'param':
        return `p.${e.name}`;
      case 'builtin': {
        usedBuiltins.add(e.which);
        const arg = BUILTIN_ARGS[e.which]!;
        return arg.type === 'uint3' ? `${arg.name}.${DIM_SUFFIX[e.dim]}` : arg.name;
      }
      case 'let':
      case 'var':
        return e.name;
      case 'load': {
        const binding = ir.buffers.find((b) => b.name === e.buf);
        const raw = `${e.buf}[${expr(e.index)}]`;
        return binding?.elem.scalar === 'bool' ? `(${raw} != 0)` : raw;
      }
      case 'shload':
        return `${e.sh}[${expr(e.index)}]`;
      case 'bin': {
        if (e.op === 'mulhi') return `mulhi(${expr(e.a)}, ${expr(e.b)})`;
        if (e.op === 'min' || e.op === 'max') {
          return `${e.op}(${expr(e.a)}, ${expr(e.b)})`;
        }
        const infix = BIN_INFIX[e.op];
        if (!infix) throw new Error(`no MSL spelling for operator '${e.op}'`);
        return `(${expr(e.a)} ${infix} ${expr(e.b)})`;
      }
      case 'un': {
        if (e.op === 'abs') return `abs(${expr(e.a)})`;
        if (e.op === 'neg') return `(-${expr(e.a)})`;
        // `not` is logical for bool and bitwise otherwise.
        const t = typeOf(e.a, env);
        return t.scalar === 'bool' ? `(!${expr(e.a)})` : `(~${expr(e.a)})`;
      }
      case 'call': {
        const fn = MATH_FN[e.fn];
        return `${fn}(${e.args.map(expr).join(', ')})`;
      }
      case 'select':
        return `(${expr(e.cond)} ? ${expr(e.a)} : ${expr(e.b)})`;
      case 'cast':
        return castExpr(e.to, e.a);
      case 'bitcast':
        return `as_type<${mslType(e.to, version)}>(${expr(e.a)})`;
      case 'lane':
        return `${expr(e.a)}.${DIM_SUFFIX[e.i] ?? 'w'}`;
      case 'vec':
        return `${mslType(e.type, version)}(${e.lanes.map(expr).join(', ')})`;
      case 'subgroup': {
        const fn = e.op === 'add' ? 'simd_sum' : e.op === 'min' ? 'simd_min' : 'simd_max';
        return `${fn}(${expr(e.a)})`;
      }
    }
  }

  /**
   * Render a numeric conversion.
   *
   * bf16 without native support needs explicit bit work in both directions:
   * a bf16 value is the top 16 bits of the f32 with the same value.
   */
  function castExpr(to: ValType, from: Expr): string {
    const fromType = typeOf(from, env);
    const nativeBf16 = version === '3.1';
    if (!nativeBf16 && to.scalar === 'bf16' && fromType.scalar !== 'bf16') {
      const asF32 = fromType.scalar === 'f32' ? expr(from) : `float(${expr(from)})`;
      // Round to nearest even before truncating, so bf16 stores match the
      // reference implementation rather than always rounding down.
      return `ushort((as_type<uint>(${asF32}) + 0x7fffu + ((as_type<uint>(${asF32}) >> 16) & 1u)) >> 16)`;
    }
    if (!nativeBf16 && fromType.scalar === 'bf16' && to.scalar !== 'bf16') {
      const asF32 = `as_type<float>(uint(${expr(from)}) << 16)`;
      return to.scalar === 'f32' ? asF32 : `${mslType(to, version)}(${asF32})`;
    }
    return `${mslType(to, version)}(${expr(from)})`;
  }

  const lines: string[] = [];

  /** Render statements at an indentation depth. */
  function stmts(list: readonly Stmt[], depth: number): void {
    const pad = '  '.repeat(depth);
    for (const s of list) {
      switch (s.k) {
        case 'comment':
          lines.push(`${pad}// ${s.text}`);
          break;
        case 'let': {
          checkExpr(s.init, env);
          lines.push(`${pad}const ${mslType(s.type, version)} ${s.name} = ${expr(s.init)};`);
          env.bind(s.name, s.type);
          break;
        }
        case 'var': {
          checkExpr(s.init, env);
          lines.push(`${pad}${mslType(s.type, version)} ${s.name} = ${expr(s.init)};`);
          env.bind(s.name, s.type);
          break;
        }
        case 'assign':
          checkExpr(s.value, env);
          lines.push(`${pad}${s.name} = ${expr(s.value)};`);
          break;
        case 'store': {
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          const binding = ir.buffers.find((b) => b.name === s.buf);
          const value =
            binding?.elem.scalar === 'bool'
              ? `(${expr(s.value)} ? 1 : 0)`
              : expr(s.value);
          lines.push(`${pad}${s.buf}[${expr(s.index)}] = ${value};`);
          break;
        }
        case 'shstore':
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          lines.push(`${pad}${s.sh}[${expr(s.index)}] = ${expr(s.value)};`);
          break;
        case 'atomicAdd': {
          checkExpr(s.index, env);
          checkExpr(s.value, env);
          const binding = ir.buffers.find((b) => b.name === s.buf)!;
          const kind = binding.elem.scalar === 'f32' ? 'float' : 'uint';
          lines.push(
            `${pad}atomic_fetch_add_explicit((device atomic_${kind}*)&${s.buf}[${expr(s.index)}], ${expr(s.value)}, memory_order_relaxed);`,
          );
          break;
        }
        case 'barrier':
          lines.push(`${pad}threadgroup_barrier(mem_flags::mem_threadgroup);`);
          break;
        case 'matDecl':
          lines.push(`${pad}${matrixType(s.type)} ${s.name};`);
          break;
        case 'matFill':
          lines.push(
            `${pad}${s.name} = make_filled_simdgroup_matrix<${matrixElem(s.type)}, 8, 8>(${s.value.toFixed(1)});`,
          );
          break;
        case 'matLoad':
          lines.push(
            `${pad}simdgroup_load(${s.name}, ${s.sh} + ${expr(s.index, env)}, ${expr(s.stride, env)});`,
          );
          break;
        case 'matMulAdd':
          lines.push(
            `${pad}simdgroup_multiply_accumulate(${s.acc}, ${s.a}, ${s.b}, ${s.acc});`,
          );
          break;
        case 'matStore':
          lines.push(
            `${pad}simdgroup_store(${s.name}, ${s.sh} + ${expr(s.index, env)}, ${expr(s.stride, env)});`,
          );
          break;
        case 'for': {
          // The induction variable is a uint register visible to the body.
          env.bind(s.v, { scalar: 'u32', lanes: 1 });
          checkExpr(s.init, env);
          checkExpr(s.limit, env);
          checkExpr(s.step, env);
          lines.push(
            `${pad}for (uint ${s.v} = ${expr(s.init)}; ${s.v} < ${expr(s.limit)}; ${s.v} += ${expr(s.step)}) {`,
          );
          stmts(s.body, depth + 1);
          lines.push(`${pad}}`);
          break;
        }
        case 'if': {
          checkExpr(s.cond, env);
          lines.push(`${pad}if (${expr(s.cond)}) {`);
          stmts(s.then, depth + 1);
          if (s.else) {
            lines.push(`${pad}} else {`);
            stmts(s.else, depth + 1);
          }
          lines.push(`${pad}}`);
          break;
        }
      }
    }
  }

  // Render the body first so `usedBuiltins` is populated before the signature.
  stmts(ir.body, 1);
  const body = lines.join('\n');

  const out: string[] = ['#include <metal_stdlib>'];
  // Only when the kernel needs them: the header is cheap but its presence in every
  // kernel would say the engine uses matrices everywhere, which it does not.
  if (ir.caps?.matrix) out.push('#include <metal_simdgroup_matrix>');
  out.push('using namespace metal;', '');

  if (ir.params.length > 0) {
    out.push('struct Params {');
    for (const p of ir.params) {
      out.push(`  ${mslScalar(p.type === 'f32' ? 'f32' : p.type, version)} ${p.name};`);
    }
    out.push('};', '');
  }

  const args: string[] = [];
  ir.buffers.forEach((b, i) => {
    const qualifier = b.access === 'read' ? 'device const' : 'device';
    const elem = mslType(storageValType(b.elem), version);
    args.push(`    ${qualifier} ${elem}* ${b.name} [[buffer(${i})]]`);
  });
  if (ir.params.length > 0) {
    args.push(`    constant Params& p [[buffer(${ir.buffers.length})]]`);
  }
  for (const which of Object.keys(BUILTIN_ARGS)) {
    if (!usedBuiltins.has(which)) continue;
    const arg = BUILTIN_ARGS[which]!;
    args.push(`    ${arg.type} ${arg.name} [[${arg.attr}]]`);
  }

  out.push(`kernel void ${ir.name}(`);
  out.push(args.join(',\n'));
  out.push(') {');
  for (const s of ir.shared) {
    out.push(`  threadgroup ${mslScalar(s.elem, version)} ${s.name}[${s.length}];`);
  }
  if (body.length > 0) out.push(body);
  out.push('}');
  out.push('');
  return out.join('\n');
}

/**
 * Render a float literal with an explicit type, avoiding double-precision
 * promotion.
 *
 * @internal
 */
function floatLiteral(value: number, type: ValType, version: string): string {
  if (!Number.isFinite(value)) {
    const inf = value > 0 ? 'INFINITY' : '-INFINITY';
    return Number.isNaN(value) ? 'NAN' : inf;
  }
  const text = Number.isInteger(value) ? `${value}.0` : String(value);
  if (type.scalar === 'f32') return `${text}f`;
  return `${mslType(type, version)}(${text})`;
}
