/**
* fino:database/sql — typed SQL file functions.
*
* This module turns directive-style `.sql` files into callable JavaScript
* functions. It layers OXC-backed TypeScript syntax validation onto the
* `-- function` directive format and supports structural placeholders such as
* `{{ user.id }}`.
*
* A SQL module is plain SQL annotated with two directives. `-- import type
* ... from '...'` preserves TypeScript type imports for the generated module,
* and `-- function name(params): ReturnType` starts a named function whose
* body is every SQL line up to the next directive. Comment lines between the
* directive and the first SQL line become the function's description; both
* parameter types and the return type default to `string` when omitted.
* Positional `?` markers in the body are rewritten to named placeholders in
* parameter order.
*
* Placeholders come in two forms. `{{ path }}` resolves a dotted or bracketed
* path (`input.id`, `rows[0]`, `opts['key']`) against the call arguments and
* escapes string values as SQL literals. `{{! path }}` splices the value raw
* and is intended only for trusted SQL fragments such as `ORDER BY` clauses —
* never user input.
*
* The parser validates TypeScript syntax but does not type-check imported
* declarations. The pipeline has two consumers: `compileSqlModule()` produces
* live functions at runtime, and `toSqlModuleSource()` emits TypeScript source
* — the module loader uses the latter so `.sql` files can be imported
* directly, and `fino:database/migrate` builds its migration engine on the
* same parser.
*
* ```ts no_run
* import { compileSqlModule, parseSqlModule } from 'fino:database/sql';
*
* const queries = compileSqlModule(parseSqlModule(`
* -- import type { User } from './types.ts'
*
* -- function findUser(input: User): string
* -- Find one user by id.
* SELECT * FROM users WHERE id = '{{ input.id }}'
*
* -- function listUsers(order: string)
* SELECT * FROM users ORDER BY {{! order }}
* `));
*
* queries.findUser({ id: "O'Brien" });        // quotes escaped safely
* queries.listUsers('created_at DESC');       // raw fragment, trusted input only
* ```
*/
import { parse as parseTypeScript } from 'fino:format/typescript';
/**
* Error thrown when a SQL module cannot be parsed.
*
* Raised for invalid TypeScript syntax in an import or function directive,
* malformed parameter names, and placeholder problems such as unbalanced
* braces or empty `{{ }}` slots. The message is prefixed with
* `source:lineNum` so parse failures point at the offending line of the
* original `.sql` text. Also re-exported from `fino:database/migrate`.
*
* ```ts no_run
* import { MigrationParseError, parseSqlModule } from 'fino:database/sql';
*
* try {
*   parseSqlModule('-- function bad(input: )\nSELECT 1', { source: 'bad.sql' });
* } catch (err) {
*   if (err instanceof MigrationParseError) {
*     console.error(err.source, err.lineNum, err.message); // 'bad.sql' 1 'bad.sql:1 ...'
*   }
* }
* ```
*/
export class MigrationParseError extends Error {
  /**
  * Label of the SQL module that failed to parse — the `source` option given
  * to `parseSqlModule()`, or `(unknown)` when none was provided.
  */
  source: string;
  /**
  * One-based line number within the SQL text where parsing failed.
  */
  lineNum: number;
  /**
  * Builds the error, prefixing `message` with the `source:lineNum` location.
  */
  constructor(message: string, source: string, lineNum: number) {
    super(`${source}:${lineNum} ${message}`);
    this.name = 'MigrationParseError';
    this.source = source;
    this.lineNum = lineNum;
  }
}
/**
* Parameter parsed from a `-- function` directive.
*
* One entry per parameter in the signature. A parameter written without a
* type annotation defaults to `string`.
*
* ```ts no_run
* import { parseSqlModule } from 'fino:database/sql';
*
* const ir = parseSqlModule('-- function q(id: number, name)\nSELECT 1');
* ir.functions[0].params;
* // [{ name: 'id', type: 'number' }, { name: 'name', type: 'string' }]
* ```
*/
export interface SqlParamIR {
  /**
  * Parameter name as written in the directive signature.
  */
  name: string;
  /**
  * TypeScript type annotation text, or `string` when the directive omitted
  * one.
  */
  type: string;
}
/**
* One SQL function parsed from a module.
*
* Produced by `parseSqlModule()` for each `-- function` directive and
* consumed by `compileSqlModule()` and `toSqlModuleSource()`.
*
* ```ts no_run
* import { parseSqlModule } from 'fino:database/sql';
*
* const [fn] = parseSqlModule(`-- function findUser(input: { id: string })
* -- Look up a single user.
* SELECT * FROM users WHERE id = '{{ input.id }}'
* `).functions;
*
* fn.name;        // 'findUser'
* fn.returnType;  // 'string'
* fn.description; // ['Look up a single user.']
* ```
*/
export interface SqlFunctionIR {
  /**
  * Function name from the directive; becomes the exported/compiled function
  * name.
  */
  name: string;
  /**
  * Parameters in declaration order; positional `?` markers in the body are
  * bound to these by index.
  */
  params: SqlParamIR[];
  /**
  * TypeScript return type annotation, defaulting to `string` when the
  * directive has none.
  */
  returnType: string;
  /**
  * SQL body with comment lines removed, positional `?` markers already
  * rewritten to named placeholders, and lines joined with `\n`.
  */
  sql: string;
  /**
  * Comment lines found between the directive and the first SQL line; emitted
  * as a doc comment by `toSqlModuleSource()`.
  */
  description: string[];
}
/**
* Parsed SQL module with preserved type imports and named functions.
*
* The intermediate representation shared by every consumer of the SQL module
* pipeline: `compileSqlModule()` turns it into live functions,
* `toSqlModuleSource()` renders it back out as a TypeScript module.
*
* ```ts no_run
* import { parseSqlModule, type SqlModuleIR } from 'fino:database/sql';
*
* const ir: SqlModuleIR = parseSqlModule('-- function ping()\nSELECT 1', { source: 'queries.sql' });
* for (const fn of ir.functions) console.log(fn.name);
* ```
*/
export interface SqlModuleIR {
  /**
  * Normalized `import type ...;` statements collected from `-- import type`
  * directives, in file order.
  */
  imports: string[];
  /**
  * Parsed functions in the order their directives appear.
  */
  functions: SqlFunctionIR[];
  /**
  * Source label the module was parsed under, carried along so downstream
  * consumers such as `fino:database/migrate` can report errors against the
  * original file.
  */
  source: string;
}
/**
* Options for parsing a SQL module.
*
* ```ts no_run
* import { parseSqlModule } from 'fino:database/sql';
*
* parseSqlModule('-- function up()\nCREATE TABLE t (id TEXT)', { source: 'migrations/001-init.sql' });
* ```
*/
export interface ParseSqlModuleOptions {
  /**
  * Label used in `MigrationParseError` messages, typically the file path of
  * the SQL text. Defaults to `(unknown)`.
  */
  source?: string;
}
/**
* Options for compiling SQL functions.
*
* ```ts no_run
* import { compileSqlModule, parseSqlModule, escapeSqlLiteral } from 'fino:database/sql';
*
* const queries = compileSqlModule(parseSqlModule("-- function q(id)\nSELECT * FROM t WHERE id = '{{ id }}'"), {
*   escape: (value) => escapeSqlLiteral(value, 'postgres'),
* });
* ```
*/
export interface CompileSqlModuleOptions {
  /**
  * Escape function applied to every `{{ path }}` placeholder value before
  * interpolation. Defaults to `escapeSqlLiteral` in its SQLite dialect.
  */
  escape?: (value: unknown) => unknown;
}
const META_RE = /^\s*--\s*function\s+([A-Za-z_][A-Za-z0-9_]*)(\(.*\)(?::\s*.+?)?)\s*$/;
const IMPORT_RE = /^\s*--\s*(import\s+type\s+.+?)\s*;?\s*$/;
const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|'[^']+'|"[^"]+")\])*$/;
function parseTsOrThrow(source: string, filename: string, lineNum: number, original: string): void {
  const parsed = parseTypeScript(source, {
    filename,
    sourceType: 'ts'
  });
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
      return {
        name,
        type
      };
    }
  }
  const name = param.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new MigrationParseError(`invalid parameter name: ${JSON.stringify(name)}`, source, lineNum);
  return {
    name,
    type: 'string'
  };
}
function parseSignature(name: string, raw: string, source: string, lineNum: number): {
  params: SqlParamIR[];
  returnType: string;
} {
  parseTsOrThrow(`function ${name}${raw} {}`, `${source}.ts`, lineNum, source);
  const close = raw.lastIndexOf(')');
  const params = splitParams(raw.slice(1, close)).map((param) => splitParam(param, source, lineNum));
  const rest = raw.slice(close + 1).trim();
  const returnType = rest.startsWith(':') ? rest.slice(1).trim() || 'string' : 'string';
  return {
    params,
    returnType
  };
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
*
* A function's body runs from its directive to the next directive or end of
* input. Comment lines before the first SQL line are captured as the
* function's description; comment lines and blank lines never become part of
* the SQL body. Positional `?` markers are rewritten to `{{ param }}`
* placeholders in declaration order, and any `?` beyond the parameter count
* is left untouched. Lines outside any directive are ignored, so a plain SQL
* file with no directives parses to an empty module.
*
* Throws `MigrationParseError` when a directive fails TypeScript validation,
* a parameter name is invalid, or a SQL line has unbalanced or empty
* placeholder braces.
*
* ```ts no_run
* import { parseSqlModule } from 'fino:database/sql';
*
* const ir = parseSqlModule(`-- import type { User } from './types.ts'
*
* -- function findUser(input: User): string
* -- Find a user by id.
* SELECT * FROM users WHERE id = '{{ input.id }}'
*
* -- function byStatus(status)
* SELECT * FROM users WHERE status = '?'
* `, { source: 'queries.sql' });
*
* ir.functions[1].sql; // "SELECT * FROM users WHERE status = '{{ status }}'"
* ```
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
  return {
    imports,
    functions,
    source
  };
}
/**
* Escape a value for SQL literal interpolation.
*
* Strings use backslash escaping by default: the SQLite dialect prefixes
* single quotes and backslashes with `\`. PostgreSQL mode doubles single
* quotes and leaves backslashes untouched. Non-string values (numbers,
* booleans, `null`) pass through unchanged.
*
* This is the default escape function for `compileSqlModule()`; pass a bound
* dialect through `CompileSqlModuleOptions.escape` to switch databases.
*
* ```ts no_run
* import { escapeSqlLiteral } from 'fino:database/sql';
*
* escapeSqlLiteral("O'Brien");             // "O\\'Brien"
* escapeSqlLiteral("O'Brien", 'postgres'); // "O''Brien"
* escapeSqlLiteral(42);                    // 42
* ```
*/
export function escapeSqlLiteral(value: unknown, dialect: 'sqlite' | 'postgres' = 'sqlite'): unknown {
  if (typeof value !== 'string') return value;
  if (dialect === 'postgres') return value.replaceAll('\'', '\'\'');
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
  return sqlText.replace(/\{\{!\s*([^}]+?)\s*\}\}/g, (_, rawPath: string) => {
    const path = rawPath.trim();
    if (!path.includes('.') && !path.includes('[') && functions[path] && params.every((p) => p.name !== path)) return String(functions[path]());
    return String(readPath(values, path) ?? '');
  }).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, rawPath: string) => String(escapeFn(readPath(values, rawPath.trim()))));
}
/**
* Compile a parsed SQL module into callable JavaScript functions.
*
* Each generated function takes positional arguments matching the directive's
* parameter list and returns the rendered SQL string. `{{ path }}`
* placeholders resolve dotted or bracketed paths against those arguments and
* are escaped; `{{! path }}` placeholders are raw and must only receive
* trusted SQL fragments. A raw placeholder whose path is a bare name of
* another function in the same module (and not a parameter) calls that
* function with no arguments and splices its output, which allows shared SQL
* fragments to be composed.
*
* Rendering throws if a placeholder path is malformed or if any segment of
* the path is missing from the arguments. Nullish raw values render as an
* empty string.
*
* ```ts no_run
* import { compileSqlModule, parseSqlModule } from 'fino:database/sql';
*
* const queries = compileSqlModule(parseSqlModule(`-- function userColumns()
* id, name, status
*
* -- function findUser(input: { id: string })
* SELECT {{! userColumns }} FROM users WHERE id = '{{ input.id }}'
* `));
*
* queries.findUser({ id: "O'Brien" });
* // "SELECT id, name, status FROM users WHERE id = 'O\\'Brien'"
* ```
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
* Type imports are preserved, named functions are exported with their
* declared parameter and return types, and the default export contains every
* generated function by name. Function descriptions become doc comments on
* the exports. The generated source is self-contained: placeholder path
* reading and SQLite-style literal escaping are inlined as private helpers,
* so the output has no runtime dependency on this module. Unlike
* `compileSqlModule()`, raw placeholders in generated code only read argument
* values — they do not splice sibling functions.
*
* This is how the module loader supports importing `.sql` files directly: the
* file is parsed, converted with this function, and transpiled like any other
* TypeScript module.
*
* ```ts no_run
* import { parseSqlModule, toSqlModuleSource } from 'fino:database/sql';
*
* const source = toSqlModuleSource(parseSqlModule(`-- import type { User } from './types.ts'
* -- function up(input: User)
* CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
*
* -- function down()
* DROP TABLE users;
* `));
*
* source.includes('export function up(input: User): string'); // true
* source.includes('export default { up, down };');            // true
* ```
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
