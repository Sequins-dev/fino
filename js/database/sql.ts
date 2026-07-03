/**
* fino:database/sql — typed SQL file functions.
*
* This module turns directive-style `.sql` files into callable JavaScript
* functions. It keeps the Oink `-- function` format, adds OXC-backed
* TypeScript syntax validation for imports and function signatures, and
* supports structural placeholders such as `{{ user.id }}`.
*
* The parser validates TypeScript syntax but does not type-check imported
* declarations. Escaped placeholders use SQL-literal escaping; raw placeholders
* with `{{! value }}` are intended only for trusted SQL fragments.
*
* ```ts no_run
* import { compileSqlModule, parseSqlModule } from 'fino:database/sql';
*
* const queries = compileSqlModule(parseSqlModule(`
* -- function findUser(input: { id: string })
* SELECT * FROM users WHERE id = '{{ input.id }}'
* `));
*
* queries.findUser({ id: 'u_123' });
* ```
*/
import { parse as parseTypeScript } from 'fino:format/typescript';

/**
* Error thrown when a SQL module cannot be parsed.
*
* `source` and `lineNum` identify the directive or SQL line that caused the
* failure.
*/
export class MigrationParseError extends Error {
  source: string;
  lineNum: number;
  constructor(message: string, source: string, lineNum: number) {
    super(`${source}:${lineNum} ${message}`);
    this.name = 'MigrationParseError';
    this.source = source;
    this.lineNum = lineNum;
  }
}

/**
* Parameter parsed from a `-- function` directive.
*/
export interface SqlParamIR {
  name: string;
  type: string;
}

/**
* One SQL function parsed from a module.
*/
export interface SqlFunctionIR {
  name: string;
  params: SqlParamIR[];
  returnType: string;
  sql: string;
  description: string[];
}

/**
* Parsed SQL module with preserved type imports and named functions.
*/
export interface SqlModuleIR {
  imports: string[];
  functions: SqlFunctionIR[];
  source: string;
}

/**
* Options for parsing a SQL module.
*/
export interface ParseSqlModuleOptions {
  source?: string;
}

/**
* Options for compiling SQL functions.
*/
export interface CompileSqlModuleOptions {
  escape?: (value: unknown) => unknown;
}

const META_RE = /^\s*--\s*function\s+([A-Za-z_][A-Za-z0-9_]*)(\(.*\)(?::\s*.+?)?)\s*$/;
const IMPORT_RE = /^\s*--\s*(import\s+type\s+.+?)\s*;?\s*$/;
const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|'[^']+'|"[^"]+")\])*$/;

function parseTsOrThrow(source: string, filename: string, lineNum: number, original: string): void {
  const parsed = parseTypeScript(source, { filename, sourceType: 'ts' });
  if (!parsed.ok) throw new MigrationParseError(parsed.errors[0]?.message ?? 'invalid TypeScript syntax', original, lineNum);
}

function splitParams(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote !== null) {
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '<' || ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function splitParam(param: string, source: string, lineNum: number): SqlParamIR {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const ch = param[i]!;
    if (ch === '<' || ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === '}' || ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) {
      const name = param.slice(0, i).trim();
      const type = param.slice(i + 1).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new MigrationParseError(`invalid parameter name: ${JSON.stringify(name)}`, source, lineNum);
      if (!type) throw new MigrationParseError(`missing type for parameter: ${JSON.stringify(name)}`, source, lineNum);
      return { name, type };
    }
  }
  const name = param.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new MigrationParseError(`invalid parameter name: ${JSON.stringify(name)}`, source, lineNum);
  return { name, type: 'string' };
}

function parseSignature(name: string, raw: string, source: string, lineNum: number): { params: SqlParamIR[]; returnType: string } {
  parseTsOrThrow(`function ${name}${raw} {}`, `${source}.ts`, lineNum, source);
  const close = raw.lastIndexOf(')');
  const params = splitParams(raw.slice(1, close)).map((param) => splitParam(param, source, lineNum));
  const rest = raw.slice(close + 1).trim();
  const returnType = rest.startsWith(':') ? rest.slice(1).trim() || 'string' : 'string';
  return { params, returnType };
}

function validateSqlLine(sqlLine: string, source: string, lineNum: number): void {
  const opening = (sqlLine.match(/\{\{/g) ?? []).length;
  const closing = (sqlLine.match(/\}\}/g) ?? []).length;
  if (opening !== closing) throw new MigrationParseError('unbalanced placeholder braces', source, lineNum);
  if (/\{\{!?\s*\}\}/.test(sqlLine)) throw new MigrationParseError('empty placeholder', source, lineNum);
}

function normalizePositional(sqlText: string, params: SqlParamIR[]): string {
  let index = 0;
  return sqlText.replace(/\?/g, () => {
    const param = params[index++];
    return param ? `{{ ${param.name} }}` : '?';
  });
}

/**
* Parse SQL directives into a typed SQL module IR.
*
* The parser accepts `-- import type ...` and `-- function name(...)`
* directives. TypeScript syntax in imports and signatures is validated with
* OXC, while SQL bodies remain plain text except for placeholder validation.
*/
export function parseSqlModule(text: string, options: ParseSqlModuleOptions = {}): SqlModuleIR {
  const source = options.source ?? '(unknown)';
  const lines = text.split('\n');
  const imports: string[] = [];
  const functions: SqlFunctionIR[] = [];
  let i = 0;
  while (i < lines.length) {
    const importMatch = IMPORT_RE.exec(lines[i]!);
    if (importMatch) {
      const statement = importMatch[1]!.replace(/;$/, '') + ';';
      parseTsOrThrow(statement, `${source}.ts`, i + 1, source);
      imports.push(statement);
      i++;
      continue;
    }
    const meta = META_RE.exec(lines[i]!);
    if (!meta) {
      i++;
      continue;
    }
    const name = meta[1]!;
    const { params, returnType } = parseSignature(name, meta[2]!, source, i + 1);
    const description: string[] = [];
    const sqlLines: string[] = [];
    let seenSql = false;
    i++;
    while (i < lines.length) {
      if (META_RE.test(lines[i]!) || IMPORT_RE.test(lines[i]!)) break;
      if (!seenSql && /^\s*--/.test(lines[i]!)) {
        const comment = lines[i]!.replace(/^\s*--\s?/, '').trim();
        if (comment) description.push(comment);
      } else if (!/^\s*--/.test(lines[i]!) && /\S/.test(lines[i]!)) {
        seenSql = true;
        const sqlLine = lines[i]!.trimEnd();
        validateSqlLine(sqlLine, source, i + 1);
        sqlLines.push(sqlLine);
      }
      i++;
    }
    functions.push({
      name,
      params,
      returnType,
      description,
      sql: normalizePositional(sqlLines.join('\n'), params)
    });
  }
  return { imports, functions, source };
}

/**
* Escape a value for SQL literal interpolation.
*
* Strings use backslash escaping by default. PostgreSQL mode doubles single
* quotes and leaves backslashes untouched. Non-string values pass through.
*/
export function escapeSqlLiteral(value: unknown, dialect: 'sqlite' | 'postgres' = 'sqlite'): unknown {
  if (typeof value !== 'string') return value;
  if (dialect === 'postgres') return value.replaceAll("'", "''");
  return value.replace(/['\\]/g, (ch) => '\\' + ch);
}

function pathParts(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  path.replace(/([A-Za-z_$][\w$]*)|\[(\d+|'[^']+'|"[^"]+")\]/g, (_, ident: string | undefined, bracket: string | undefined) => {
    if (ident !== undefined) parts.push(ident);
    else if (/^\d+$/.test(bracket!)) parts.push(Number(bracket));
    else parts.push(bracket!.slice(1, -1));
    return '';
  });
  return parts;
}

function readPath(values: Record<string, unknown>, path: string): unknown {
  if (!PATH_RE.test(path)) throw new Error(`Invalid SQL placeholder path: ${path}`);
  let cur: unknown = values;
  for (const part of pathParts(path)) {
    if (cur === null || cur === undefined || !(part in Object(cur))) throw new Error(`Missing SQL placeholder value: ${path}`);
    cur = (cur as Record<string | number, unknown>)[part];
  }
  return cur;
}

function renderFunctionBody(sqlText: string, params: SqlParamIR[], functions: Record<string, (...args: unknown[]) => string>, args: unknown[], escapeFn: (value: unknown) => unknown): string {
  const values = Object.fromEntries(params.map((param, index) => [param.name, args[index]]));
  return sqlText
    .replace(/\{\{!\s*([^}]+?)\s*\}\}/g, (_, rawPath: string) => {
      const path = rawPath.trim();
      if (!path.includes('.') && !path.includes('[') && functions[path] && params.every((p) => p.name !== path)) return String(functions[path]());
      return String(readPath(values, path) ?? '');
    })
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawPath: string) => String(escapeFn(readPath(values, rawPath.trim()))));
}

/**
* Compile a parsed SQL module into callable JavaScript functions.
*
* Each generated function returns a SQL string. `{{ value }}` placeholders are
* escaped; `{{! value }}` placeholders are raw and must only receive trusted
* SQL fragments.
*/
export function compileSqlModule(ir: SqlModuleIR, options: CompileSqlModuleOptions = {}): Record<string, (...args: unknown[]) => string> {
  const escapeFn = options.escape ?? escapeSqlLiteral;
  const functions: Record<string, (...args: unknown[]) => string> = {};
  for (const fn of ir.functions) {
    functions[fn.name] = (...args: unknown[]) => renderFunctionBody(fn.sql, fn.params, functions, args, escapeFn);
    Object.defineProperty(functions[fn.name], 'name', { value: fn.name });
  }
  return functions;
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
* Generate a TypeScript module from parsed SQL functions.
*
* Type imports are preserved, named functions are exported, and the default
* export contains every generated function by name.
*/
export function toSqlModuleSource(ir: SqlModuleIR): string {
  const out: string[] = [];
  out.push(...ir.imports);
  if (ir.imports.length > 0) out.push('');
  out.push('function __escape(value: unknown): unknown {');
  out.push('  if (typeof value !== "string") return value;');
  out.push('  return value.replace(/[\'\\\\]/g, (ch) => "\\\\" + ch);');
  out.push('}');
  out.push('function __read(values: Record<string, unknown>, path: string): unknown {');
  out.push('  const parts: Array<string | number> = [];');
  out.push('  path.replace(/([A-Za-z_$][\\w$]*)|\\[(\\d+|\\\'[^\\\']+\\\'|"[^"]+")\\]/g, (_: string, ident: string | undefined, bracket: string | undefined) => {');
  out.push('    if (ident !== undefined) parts.push(ident);');
  out.push('    else if (/^\\d+$/.test(bracket!)) parts.push(Number(bracket));');
  out.push('    else parts.push(bracket!.slice(1, -1));');
  out.push('    return "";');
  out.push('  });');
  out.push('  let cur: any = values;');
  out.push('  for (const part of parts) {');
  out.push('    if (cur === null || cur === undefined || !(part in Object(cur))) throw new Error(`Missing SQL placeholder value: ${path}`);');
  out.push('    cur = cur[part];');
  out.push('  }');
  out.push('  return cur;');
  out.push('}');
  for (const fn of ir.functions) {
    const params = fn.params.map((param) => `${param.name}: ${param.type}`).join(', ');
    out.push('');
    if (fn.description.length > 0) out.push('/**', ...fn.description.map((line) => ` * ${line}`), ' */');
    out.push(`export function ${fn.name}(${params}): ${fn.returnType} {`);
    out.push(`  const __values: Record<string, unknown> = { ${fn.params.map((p) => p.name).join(', ')} };`);
    out.push(`  return ${jsString(fn.sql)}.replace(/\\{\\{!\\s*([^}]+?)\\s*\\}\\}/g, (_, p) => String(__read(__values, String(p).trim()) ?? "")).replace(/\\{\\{\\s*([^}]+?)\\s*\\}\\}/g, (_, p) => String(__escape(__read(__values, String(p).trim())))) as ${fn.returnType};`);
    out.push('}');
  }
  out.push('');
  out.push(`export default { ${ir.functions.map((fn) => fn.name).join(', ')} };`);
  out.push('');
  return out.join('\n');
}
