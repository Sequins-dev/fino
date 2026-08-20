/**
 * Lower kernel IR to CUDA C++ for runtime compilation with NVRTC.
 *
 * CUDA C++ is a third text target beside MSL and SPIR-V. The lowering uses only
 * device-language facilities shipped in NVRTC, so compiling kernels does not invoke
 * `nvcc` or require a host C++ compiler.
 *
 * @internal
 */
import type { BinOp, Expr, KernelIR, MathFn, ScalarDType, Stmt, ValType } from '../types.ts';
import { validateKernel } from '../types.ts';
import { TypeEnv, checkExpr, typeOf } from '../typing.ts';

/** CUDA-C lowering options recorded in kernel cache identities. */
export interface CudaOptions {
  /** Compute architecture passed to NVRTC, such as `compute_89`. */
  architecture?: string;
  /** Whether NVRTC may contract and approximate floating-point operations. */
  fastMath?: boolean;
}

function scalarName(s: ScalarDType): string {
  switch (s) {
    case 'f32':
      return 'float';
    case 'f16':
      return '__half';
    case 'bf16':
      return '__nv_bfloat16';
    case 'i32':
      return 'int';
    case 'u32':
      return 'unsigned int';
    case 'u8':
      return 'unsigned char';
    case 'bool':
      return 'bool';
  }
}

function storageType(t: ValType): ValType {
  return t.scalar === 'bool' ? { scalar: 'u8', lanes: t.lanes } : t;
}

function typeName(t: ValType): string {
  const scalar = scalarName(t.scalar);
  if (t.lanes === 1) return scalar;
  if (t.scalar === 'f32') return `float${t.lanes}`;
  if (t.scalar === 'i32') return `int${t.lanes}`;
  if (t.scalar === 'u32') return `uint${t.lanes}`;
  return `FinoVec<${scalar}, ${t.lanes}>`;
}

const INFIX: Partial<Record<BinOp, string>> = {
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

const FN: Record<MathFn, string> = {
  exp: 'expf',
  log: 'logf',
  sqrt: 'sqrtf',
  rsqrt: 'rsqrtf',
  tanh: 'tanhf',
  sin: 'sinf',
  cos: 'cosf',
  pow: 'powf',
  fma: 'fmaf',
  floor: 'floorf',
  ceil: 'ceilf',
  round: 'rintf',
  clamp: 'fino_clamp',
};

const LANE = ['x', 'y', 'z', 'w'] as const;

/** Lower a kernel to NVRTC-compatible CUDA C++ source. */
export function lowerToCUDA(ir: KernelIR, _options: CudaOptions = {}): string {
  validateKernel(ir);
  if (ir.caps.matrix) throw new Error(`CUDA cooperative-matrix lowering is not implemented`);
  const env = new TypeEnv(ir);
  const body: string[] = [];
  const temporaries = new Map<Expr, string>();
  let expressionPad = '  ';
  let nextTemporary = 0;

  const construct = (t: ValType, lanes: readonly string[]): string => {
    if (t.lanes === 1) return `${typeName(t)}(${lanes[0]})`;
    if (t.scalar === 'f32' || t.scalar === 'i32' || t.scalar === 'u32') {
      return `make_${typeName(t)}(${lanes.join(', ')})`;
    }
    return `${typeName(t)}{${lanes.join(', ')}}`;
  };

  const map = (t: ValType, fn: (lane: number) => string): string =>
    t.lanes === 1
      ? fn(0)
      : construct(
          t,
          Array.from({ length: t.lanes }, (_, i) => fn(i)),
        );

  const lane = (text: string, t: ValType, i: number): string =>
    t.lanes === 1 ? text : `${text}.${LANE[i]}`;

  function expression(e: Expr): string {
    const found = temporaries.get(e);
    if (found) return found;
    const rendered = renderExpression(e);
    const type = typeOf(e, env);
    if (
      type.lanes === 1 ||
      e.k === 'const' ||
      e.k === 'param' ||
      e.k === 'builtin' ||
      e.k === 'let' ||
      e.k === 'var' ||
      e.k === 'load' ||
      e.k === 'shload'
    )
      return rendered;
    const name = `_v${nextTemporary++}`;
    body.push(`${expressionPad}const ${typeName(type)} ${name} = ${rendered};`);
    temporaries.set(e, name);
    return name;
  }

  function renderExpression(e: Expr): string {
    switch (e.k) {
      case 'const': {
        let value: string;
        if (e.type.scalar === 'bool') value = e.value ? 'true' : 'false';
        else if (e.type.scalar === 'f32')
          value = Number.isFinite(e.value)
            ? `${Number.isInteger(e.value) ? `${e.value}.0` : e.value}f`
            : Number.isNaN(e.value)
              ? '__int_as_float(0x7fc00000)'
              : e.value > 0
                ? '__int_as_float(0x7f800000)'
                : '__int_as_float(0xff800000)';
        else if (e.type.scalar === 'f16') value = `__float2half_rn(${e.value}f)`;
        else if (e.type.scalar === 'bf16') value = `__float2bfloat16_rn(${e.value}f)`;
        else if (e.type.scalar === 'u32') value = `${e.value >>> 0}u`;
        else value = String(e.value | 0);
        return e.type.lanes === 1
          ? value
          : construct(
              e.type,
              Array.from({ length: e.type.lanes }, () => value),
            );
      }
      case 'param':
        return e.name;
      case 'builtin': {
        const d = LANE[e.dim];
        if (e.which === 'globalId') return `(blockIdx.${d} * blockDim.${d} + threadIdx.${d})`;
        if (e.which === 'localId') return `threadIdx.${d}`;
        if (e.which === 'groupId') return `blockIdx.${d}`;
        if (e.which === 'numGroups') return `gridDim.${d}`;
        if (e.which === 'globalSize') return `(gridDim.${d} * blockDim.${d})`;
        if (e.which === 'subgroupSize') return 'warpSize';
        if (e.which === 'subgroupId')
          return '((threadIdx.x + blockDim.x * (threadIdx.y + blockDim.y * threadIdx.z)) / warpSize)';
        return '((threadIdx.x + blockDim.x * (threadIdx.y + blockDim.y * threadIdx.z)) & (warpSize - 1))';
      }
      case 'let':
      case 'var':
        return e.name;
      case 'load': {
        const b = ir.buffers.find((item) => item.name === e.buf)!;
        const raw = `${e.buf}[${expression(e.index)}]`;
        if (b.elem.scalar !== 'bool') return raw;
        return map(b.elem, (i) => `(${lane(raw, storageType(b.elem), i)} != 0)`);
      }
      case 'shload':
        return `${e.sh}[${expression(e.index)}]`;
      case 'bin': {
        const at = typeOf(e.a, env);
        const bt = typeOf(e.b, env);
        const result = typeOf(e, env);
        const a = expression(e.a),
          b = expression(e.b);
        return map(result, (i) => {
          const av = lane(a, at, Math.min(i, at.lanes - 1));
          const bv = lane(b, bt, Math.min(i, bt.lanes - 1));
          if (e.op === 'mulhi') return `__umulhi(${av}, ${bv})`;
          if (e.op === 'min' || e.op === 'max') return `${e.op}(${av}, ${bv})`;
          return `(${av} ${INFIX[e.op]} ${bv})`;
        });
      }
      case 'un': {
        const t = typeOf(e.a, env),
          a = expression(e.a);
        return map(t, (i) => {
          const v = lane(a, t, i);
          if (e.op === 'abs') return t.scalar === 'f32' ? `fabsf(${v})` : `abs(${v})`;
          if (e.op === 'neg') return `(-${v})`;
          return t.scalar === 'bool' ? `(!${v})` : `(~${v})`;
        });
      }
      case 'call': {
        const t = typeOf(e, env);
        const args = e.args.map((a) => ({ text: expression(a), type: typeOf(a, env) }));
        return map(
          t,
          (i) =>
            `${FN[e.fn]}(${args.map((a) => lane(a.text, a.type, Math.min(i, a.type.lanes - 1))).join(', ')})`,
        );
      }
      case 'select': {
        const t = typeOf(e.a, env),
          ct = typeOf(e.cond, env);
        const c = expression(e.cond),
          a = expression(e.a),
          b = expression(e.b);
        return map(
          t,
          (i) =>
            `(${lane(c, ct, Math.min(i, ct.lanes - 1))} ? ${lane(a, t, i)} : ${lane(b, t, i)})`,
        );
      }
      case 'cast': {
        const from = typeOf(e.a, env),
          text = expression(e.a);
        return map(e.to, (i) => {
          const v = lane(text, from, Math.min(i, from.lanes - 1));
          if (e.to.scalar === 'f16') return `__float2half_rn((float)(${v}))`;
          if (e.to.scalar === 'bf16') return `__float2bfloat16_rn((float)(${v}))`;
          if (from.scalar === 'f16')
            return `(${typeName({ ...e.to, lanes: 1 })})__half2float(${v})`;
          if (from.scalar === 'bf16')
            return `(${typeName({ ...e.to, lanes: 1 })})__bfloat162float(${v})`;
          return `(${typeName({ ...e.to, lanes: 1 })})(${v})`;
        });
      }
      case 'bitcast': {
        const from = typeOf(e.a, env),
          text = expression(e.a);
        return map(
          e.to,
          (i) => `fino_bitcast<${typeName({ ...e.to, lanes: 1 })}>(${lane(text, from, i)})`,
        );
      }
      case 'lane':
        return lane(expression(e.a), typeOf(e.a, env), e.i);
      case 'vec':
        return construct(e.type, e.lanes.map(expression));
      case 'subgroup':
        return `fino_warp_${e.op}(${expression(e.a)})`;
    }
  }

  function statements(list: readonly Stmt[], depth: number): void {
    const pad = '  '.repeat(depth);
    expressionPad = pad;
    for (const s of list) {
      switch (s.k) {
        case 'comment':
          body.push(`${pad}// ${s.text}`);
          break;
        case 'let':
          checkExpr(s.init, env);
          body.push(`${pad}const ${typeName(s.type)} ${s.name} = ${expression(s.init)};`);
          env.bind(s.name, s.type);
          break;
        case 'var':
          checkExpr(s.init, env);
          body.push(`${pad}${typeName(s.type)} ${s.name} = ${expression(s.init)};`);
          env.bind(s.name, s.type);
          break;
        case 'assign':
          body.push(`${pad}${s.name} = ${expression(s.value)};`);
          break;
        case 'store': {
          const binding = ir.buffers.find((b) => b.name === s.buf)!;
          const value = expression(s.value);
          if (binding.elem.scalar === 'bool') {
            const t = binding.elem;
            body.push(
              `${pad}${s.buf}[${expression(s.index)}] = ${map(storageType(t), (i) => `(${lane(value, t, i)} ? 1 : 0)`)};`,
            );
          } else body.push(`${pad}${s.buf}[${expression(s.index)}] = ${value};`);
          break;
        }
        case 'shstore':
          body.push(`${pad}${s.sh}[${expression(s.index)}] = ${expression(s.value)};`);
          break;
        case 'atomicAdd':
          body.push(`${pad}atomicAdd(&${s.buf}[${expression(s.index)}], ${expression(s.value)});`);
          break;
        case 'barrier':
          body.push(`${pad}__syncthreads();`);
          break;
        case 'for':
          env.bind(s.v, { scalar: 'u32', lanes: 1 });
          body.push(
            `${pad}for (unsigned int ${s.v} = ${expression(s.init)}; ${s.v} < ${expression(s.limit)}; ${s.v} += ${expression(s.step)}) {`,
          );
          statements(s.body, depth + 1);
          body.push(`${pad}}`);
          break;
        case 'if':
          body.push(`${pad}if (${expression(s.cond)}) {`);
          statements(s.then, depth + 1);
          if (s.else) {
            body.push(`${pad}} else {`);
            statements(s.else, depth + 1);
          }
          body.push(`${pad}}`);
          break;
        default:
          throw new Error(`CUDA lowering does not support '${s.k}'`);
      }
    }
  }
  statements(ir.body, 1);

  const out = [
    '#include <cuda_fp16.h>',
    '#include <cuda_bf16.h>',
    'template <typename T, int N> struct FinoVec;',
    'template <typename T> struct FinoVec<T, 2> { T x, y; };',
    'template <typename T> struct FinoVec<T, 4> { T x, y, z, w; };',
    'template <typename To, typename From> __device__ __forceinline__ To fino_bitcast(From v) { static_assert(sizeof(To) == sizeof(From), "bitcast width"); union { From from; To to; } u; u.from = v; return u.to; }',
    'template <typename T> __device__ __forceinline__ T fino_clamp(T v, T lo, T hi) { return min(max(v, lo), hi); }',
    'template <typename T> __device__ __forceinline__ T fino_warp_add(T v) { for (int d = warpSize / 2; d; d /= 2) v += __shfl_down_sync(0xffffffffu, v, d); return v; }',
    'template <typename T> __device__ __forceinline__ T fino_warp_min(T v) { for (int d = warpSize / 2; d; d /= 2) v = min(v, __shfl_down_sync(0xffffffffu, v, d)); return v; }',
    'template <typename T> __device__ __forceinline__ T fino_warp_max(T v) { for (int d = warpSize / 2; d; d /= 2) v = max(v, __shfl_down_sync(0xffffffffu, v, d)); return v; }',
    '',
  ];
  const args = ir.buffers.map(
    (b) => `${b.access === 'read' ? 'const ' : ''}${typeName(storageType(b.elem))}* ${b.name}`,
  );
  for (const p of ir.params)
    args.push(
      `${p.type === 'f32' ? 'float' : p.type === 'i32' ? 'int' : 'unsigned int'} ${p.name}`,
    );
  out.push(`extern "C" __global__ void ${ir.name}(${args.join(', ')}) {`);
  for (const s of ir.shared) out.push(`  __shared__ ${scalarName(s.elem)} ${s.name}[${s.length}];`);
  out.push(...body, '}', '');
  return out.join('\n');
}
