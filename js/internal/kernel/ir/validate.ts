/**
 * Lexical and memory-access validation for internal:kernel/ir.
 *
 * This checks a complete snapshot before either target sees it. It does not
 * prove runtime index bounds, uniform barrier participation, or termination.
 * @internal
 */
import type { Expr, KernelIR, Stmt, ValType } from './types.ts';
import { sameType, vt } from './types.ts';
import { TypeEnv, checkExpr } from './typing.ts';

/** Validate statement scopes, access declarations, and types. */
export function validateBody(ir: KernelIR): void {
  const globals = new Set([
    ir.name,
    ...ir.buffers.map((b) => b.name),
    ...ir.params.map((p) => p.name),
    ...ir.shared.map((s) => s.name),
  ]);
  const buffers = new Map(ir.buffers.map((b) => [b.name, b]));
  const exact = (actual: ValType, expected: ValType) => {
    if (!sameType(actual, expected))
      throw new Error(`type mismatch: expected ${expected.scalar}x${expected.lanes}`);
  };
  const index = (type: ValType) => {
    if (type.lanes !== 1 || !['u32', 'i32'].includes(type.scalar))
      throw new Error('index must be i32 or u32');
  };
  // Validate declaration types even when the body never uses them.
  const env = new TypeEnv(ir);
  for (const b of ir.buffers) {
    checkExpr({ k: 'const', type: b.elem, value: 0 }, env);
    if (!['read', 'write', 'readwrite'].includes(b.access))
      throw new Error('invalid buffer access');
  }
  for (const p of ir.params)
    if (!['u32', 'i32', 'f32'].includes(p.type)) throw new Error('invalid parameter type');
  for (const s of ir.shared) checkExpr({ k: 'const', type: vt(s.elem), value: 0 }, env);

  function block(stmts: Stmt[], scope: TypeEnv, mutable: Set<string>): void {
    const declared = new Set<string>();
    const bind = (name: string, type: ValType, isMutable: boolean) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid identifier '${name}'`);
      // No shadowing: both lowerings may assign implementation names to locals.
      if (globals.has(name) || scope.has(name) || declared.has(name))
        throw new Error(`duplicate local '${name}'`);
      checkExpr({ k: 'const', type, value: 0 }, scope);
      declared.add(name);
      scope.bind(name, type);
      if (isMutable) mutable.add(name);
    };
    const expression = (e: Expr): ValType => {
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const node = value as Expr;
        if (node.k === 'load' && buffers.get(node.buf)?.access === 'write')
          throw new Error(`cannot read write-only buffer '${node.buf}'`);
        if (
          (node.k === 'let' || node.k === 'var') &&
          scope.has(node.name) &&
          (node.k === 'var') !== mutable.has(node.name)
        )
          throw new Error(`mutable reference mismatch '${node.name}'`);
        for (const child of Object.values(value)) {
          if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
      };
      visit(e);
      return checkExpr(e, scope);
    };
    for (const s of stmts) {
      switch (s.k) {
        case 'let':
        case 'var':
          exact(expression(s.init), s.type);
          bind(s.name, s.type, s.k === 'var');
          break;
        case 'assign':
          if (!mutable.has(s.name)) throw new Error(`'${s.name}' is not mutable`);
          exact(expression(s.value), scope.value(s.name));
          break;
        case 'store':
        case 'atomicAdd': {
          const b = buffers.get(s.buf);
          if (!b) throw new Error(`unknown buffer '${s.buf}'`);
          if (b.access === 'read') throw new Error(`cannot write read-only buffer '${s.buf}'`);
          index(expression(s.index));
          exact(expression(s.value), b.elem);
          if (
            s.k === 'atomicAdd' &&
            (b.access !== 'readwrite' ||
              b.elem.lanes !== 1 ||
              !['u32', 'f32'].includes(b.elem.scalar))
          )
            throw new Error('atomicAdd requires a scalar u32/f32 readwrite binding');
          break;
        }
        case 'shstore':
          index(expression(s.index));
          exact(expression(s.value), vt(scope.sharedElem(s.sh)));
          break;
        case 'if':
          exact(expression(s.cond), vt('bool'));
          block(s.then, scope.fork(), new Set(mutable));
          if (s.else) block(s.else, scope.fork(), new Set(mutable));
          break;
        case 'for': {
          exact(expression(s.init), vt('u32'));
          exact(expression(s.limit), vt('u32'));
          exact(expression(s.step), vt('u32'));
          if (globals.has(s.v) || scope.has(s.v) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.v))
            throw new Error('duplicate or invalid loop identifier');
          const child = scope.fork();
          child.bind(s.v, vt('u32'));
          block(s.body, child, new Set([...mutable, s.v]));
          break;
        }
        case 'barrier':
        case 'comment':
          break;
        default:
          throw new Error('unsupported kernel statement');
      }
    }
  }
  block(ir.body, env, new Set());
}
