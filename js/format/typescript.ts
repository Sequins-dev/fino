/**
* fino:format/typescript - OXC-backed TypeScript and JavaScript tooling.
*
* This module exposes the runtime's OXC parser, transformer, formatter, and
* linter to JavaScript. Use it for tooling-oriented tasks such as inspecting
* TypeScript/JavaScript source, collecting comments and tokens, validating
* syntax, stripping TypeScript syntax before evaluation, normalizing source
* style, or running the default lint rule set. It is not a type checker.
*
* `parse()` returns OXC's serialized ESTree-compatible AST, comments, optional
* tokens, diagnostics, and the detected source mode. The AST shape follows the
* bundled OXC version and can change as OXC evolves. `transpile()` returns
* JavaScript code plus source map text and diagnostics for TypeScript/JSX
* syntax lowering. TSX and JSX use the automatic `fino:ui` runtime unless a
* file-level `@jsxImportSource` pragma selects another runtime. `format()`
* rewrites source with stable style defaults, and
* `lint()` reports diagnostics from the runtime's default rule set. For
* serving browser-side TypeScript directly from a Fino HTTP app,
* `transpileFiles()` provides transpile-on-request middleware.
*
* Source grammar is inferred from `filename` when possible, and TypeScript
* module grammar is assumed when neither `filename` nor `sourceType` selects
* one. Pass `sourceType` to force JavaScript, JSX, TypeScript, TSX,
* declaration-file, module, or script parsing behavior in `parse()`,
* `format()`, and `lint()`. `transpile()` derives grammar from `filename`
* alone, so give JSX or declaration input a filename with a matching
* extension such as `.tsx` or `.d.ts`.
*
* ```ts no_run
* import { parse } from 'fino:format/typescript';
*
* const result = parse('export const answer: number = 42;', {
*   sourceType: 'ts',
*   tokens: true,
* });
* if (!result.ok) throw new Error(result.errors[0]?.message);
* ```
*
* ```ts no_run
* import { transpile } from 'fino:format/typescript';
*
* const { code, map } = transpile('const x: number = 1;', {
*   filename: 'example.ts',
* });
* ```
*
* Useful references:
*   - OXC project: https://oxc.rs/
*   - ESTree specification: https://github.com/estree/estree
*   - TypeScript language: https://www.typescriptlang.org/docs/
*/
import { parse as parseNative, transpile as transpileNative, format as formatNative, lint as lintNative } from 'internal:format/typescript';
// internal:loader imports this module during bootstrap to register the
// TypeScript transpile hook, before globals and the fs/http stacks exist.
// Keep module scope free of runtime imports; transpileFiles() loads its
// dependencies lazily and imports only types eagerly.
import type { LayerMiddleware } from 'fino:net/http/app';
/**
* Options controlling source grammar detection and parser output.
*
* Filename and source type are used only for parser mode selection and
* diagnostics; this module does not read files from disk. Token collection is
* disabled by default to keep parsing output smaller.
*
* ```ts no_run
* import { parse, type ParseOptions } from 'fino:format/typescript';
*
* const options: ParseOptions = { filename: 'component.tsx', tokens: true };
* const result = parse('export const x = <div />;', options);
* ```
*/
export interface ParseOptions {
  /**
  * Filename used for syntax-mode inference and diagnostics.
  *
  * Extensions such as `.ts`, `.tsx`, `.jsx`, and `.d.ts` guide the parser
  * when `sourceType` is omitted. The value is also carried into source-map and
  * diagnostic metadata by the native parser.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('declare const x: string;', { filename: 'types.d.ts' });
  * ```
  */
  filename?: string;
  /**
  * Explicit source grammar. Defaults are inferred from `filename` when
  * possible, falling back to TypeScript module grammar when neither is given.
  *
  * Use this when parsing virtual source or when a filename extension does not
  * match the syntax. The parser still reports diagnostics rather than throwing
  * for syntax errors returned by OXC.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('const x: number = 1;', { sourceType: 'ts' });
  * ```
  */
  sourceType?: 'js' | 'javascript' | 'script' | 'jsx' | 'ts' | 'typescript' | 'tsx' | 'dts' | 'definition';
  /**
  * Include lexer tokens in the parse result. Defaults to `false`.
  *
  * Tokens increase result size but are useful for formatters, linters, and
  * source analysis that needs exact lexical spans.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const tokens = parse('let x = 1;', { tokens: true }).tokens;
  * ```
  */
  tokens?: boolean;
}
/**
* Token returned when `ParseOptions.tokens` is enabled.
*
* Offsets are byte offsets into the supplied JavaScript string as reported by
* OXC. No tokens are returned when token collection is disabled.
*
* ```ts no_run
* import { parse, type ParseToken } from 'fino:format/typescript';
*
* const token: ParseToken | undefined = parse('const x = 1;', {
*   tokens: true,
* }).tokens[0];
* ```
*/
export interface ParseToken {
  /**
  * OXC token kind name.
  *
  * The exact set of names follows the bundled OXC version and may grow as the
  * JavaScript grammar evolves.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('const x = 1;', { tokens: true }).tokens[0]?.kind;
  * ```
  */
  kind: string;
  /**
  * Source text matched by the token.
  *
  * The text is not normalized, so whitespace and escape spelling remain as
  * they appeared in the original source.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('const x = 1;', { tokens: true }).tokens[0]?.text;
  * ```
  */
  text: string;
  /**
  * Start offset of the token in the source string.
  *
  * Use this with `end` to slice the original source. The offset is zero-based.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const source = 'const x = 1;';
  * const token = parse(source, { tokens: true }).tokens[0]!;
  * source.slice(token.start, token.end);
  * ```
  */
  start: number;
  /**
  * End offset of the token in the source string.
  *
  * This is exclusive, matching JavaScript `String.prototype.slice()`.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const token = parse('const x = 1;', { tokens: true }).tokens[0]!;
  * token.end - token.start;
  * ```
  */
  end: number;
  /**
  * Whether OXC observed a line break before this token.
  *
  * This is useful for automatic-semicolon-insertion-sensitive tooling.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('a\nb', { tokens: true }).tokens.some((token) => token.onNewLine);
  * ```
  */
  onNewLine: boolean;
}
/**
* Source comment with attachment metadata from OXC.
*
* Comments are reported separately from the AST. Attachment fields describe
* OXC's best effort at associating comments with nearby nodes and may change
* as OXC changes its parser behavior.
*
* ```ts no_run
* import { parse, type ParseComment } from 'fino:format/typescript';
*
* const comment: ParseComment | undefined = parse('// docs\nconst x = 1;').comments[0];
* ```
*/
export interface ParseComment {
  /**
  * Comment syntax kind.
  *
  * `line` represents line comments and `block` represents block comments.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// hi\nx').comments[0]?.kind;
  * ```
  */
  kind: 'line' | 'block';
  /**
  * Comment body text without delimiters.
  *
  * The text is not HTML-escaped or otherwise sanitized.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// hello\nx').comments[0]?.text;
  * ```
  */
  text: string;
  /**
  * Start offset of the full comment in the source string.
  *
  * The offset includes the opening comment delimiter.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// hi\nx').comments[0]?.start;
  * ```
  */
  start: number;
  /**
  * End offset of the full comment in the source string.
  *
  * This is exclusive and includes the closing delimiter for block comments.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// hi\nx').comments[0]?.end;
  * ```
  */
  end: number;
  /**
  * OXC node attachment identifier.
  *
  * The value is parser metadata, not a stable public node ID. It may be `0`
  * when no useful attachment exists.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// doc\nconst x = 1;').comments[0]?.attachedTo;
  * ```
  */
  attachedTo: number;
  /**
  * Whether the comment is considered leading for its attached node.
  *
  * Leading comments appear before the associated syntax.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('// leading\nconst x = 1;').comments[0]?.leading;
  * ```
  */
  leading: boolean;
  /**
  * Whether the comment is considered trailing for its attached node.
  *
  * Trailing comments appear after nearby syntax on the same line or close
  * region according to OXC's attachment rules.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * parse('const x = 1; // trailing').comments[0]?.trailing;
  * ```
  */
  trailing: boolean;
  /**
  * Whether the comment is a JSDoc-style block comment.
  *
  * This is true only for block comments that OXC recognizes as documentation
  * comments (those opening with `/**`); line comments are never JSDoc.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const source = '/** docs *' + '/\nconst x = 1;';
  * parse(source).comments[0]?.jsdoc;
  * ```
  */
  jsdoc: boolean;
}
/**
* Parser or transpiler diagnostic.
*
* Diagnostics are returned in result objects instead of throwing for normal
* syntax errors. Native bridge failures may still throw before a result is
* created.
*
* ```ts no_run
* import { parse, type ParseDiagnostic } from 'fino:format/typescript';
*
* const diagnostic: ParseDiagnostic | undefined = parse('const =').errors[0];
* ```
*/
export interface ParseDiagnostic {
  /**
  * Stable diagnostic code from the parser, transformer, formatter, or linter.
  */
  code?: string;
  /**
  * Human-readable diagnostic message from OXC.
  *
  * The message is suitable for logs but should not be treated as a stable
  * machine-readable code.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const message = parse('const =').errors[0]?.message;
  * ```
  */
  message: string;
  /**
  * Diagnostic severity.
  */
  severity?: 'error' | 'warning';
  /**
  * One-based source line for the diagnostic start when available.
  */
  line?: number;
  /**
  * One-based source column for the diagnostic start when available.
  */
  column?: number;
  /**
  * One-based source line for the diagnostic end when available.
  */
  endLine?: number;
  /**
  * One-based source column for the diagnostic end when available.
  */
  endColumn?: number;
}
/**
* Complete parse result, including AST, comments, tokens, and diagnostics.
*
* Syntax errors are reported through `ok: false` and `errors`; callers should
* check `ok` before trusting the AST for semantic tooling.
*
* ```ts no_run
* import { parse, type ParseResult } from 'fino:format/typescript';
*
* const result: ParseResult = parse('export const x = 1;');
* if (result.ok) console.log(result.sourceType.moduleKind);
* ```
*/
export interface ParseResult {
  /**
  * Whether OXC parsed the source without diagnostics that mark failure.
  *
  * `false` means inspect `errors`. The AST may be incomplete or unsuitable for
  * downstream transformations when parsing failed.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * if (!parse('const =').ok) console.error('invalid source');
  * ```
  */
  ok: boolean;
  /**
  * Serialized ESTree-compatible AST from OXC.
  *
  * The exact node shape follows the bundled OXC version. Treat this as parser
  * output, not as a stable schema guaranteed by Fino.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const ast = parse('const x = 1;').ast;
  * ```
  */
  ast: any;
  /**
  * Comments collected from the source.
  *
  * Comments are always returned as an array, empty when none were found.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const comments = parse('// note\nconst x = 1;').comments;
  * ```
  */
  comments: ParseComment[];
  /**
  * Lexer tokens collected from the source.
  *
  * This array is empty unless `ParseOptions.tokens` is true.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const tokens = parse('const x = 1;', { tokens: true }).tokens;
  * ```
  */
  tokens: ParseToken[];
  /**
  * Parser diagnostics.
  *
  * The array is empty on a clean parse. Diagnostics are returned rather than
  * thrown for normal syntax errors.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const errors = parse('const =').errors;
  * ```
  */
  errors: ParseDiagnostic[];
  /**
  * Source mode detected or selected by OXC.
  *
  * The nested object describes language, module mode, JSX support, and
  * declaration-file parsing. It is useful when `filename` inference was used.
  *
  * ```ts no_run
  * import { parse } from 'fino:format/typescript';
  *
  * const mode = parse('export {}', { filename: 'x.ts' }).sourceType;
  * ```
  */
  sourceType: {
    /**
    * Detected source language.
    *
    * TypeScript mode is selected for TypeScript, TSX, and declaration-file
    * inputs; JavaScript mode is selected for JS and JSX inputs.
    *
    * ```ts no_run
    * import { parse } from 'fino:format/typescript';
    *
    * parse('const x: number = 1;', { sourceType: 'ts' }).sourceType.language;
    * ```
    */
    language: 'typescript' | 'javascript';
    /**
    * Detected module mode.
    *
    * OXC reports whether the source is a module, script, unambiguous input, or
    * CommonJS-shaped source according to parser mode and syntax.
    *
    * ```ts no_run
    * import { parse } from 'fino:format/typescript';
    *
    * parse('export const x = 1;').sourceType.moduleKind;
    * ```
    */
    moduleKind: 'module' | 'script' | 'unambiguous' | 'commonjs';
    /**
    * Whether JSX syntax was enabled for the parse.
    *
    * This is true for JSX and TSX source modes.
    *
    * ```ts no_run
    * import { parse } from 'fino:format/typescript';
    *
    * parse('const el = <div />;', { sourceType: 'tsx' }).sourceType.jsx;
    * ```
    */
    jsx: boolean;
    /**
    * Whether the source was parsed as a TypeScript declaration file.
    *
    * This is true for `dts` or definition-file modes inferred from filenames
    * such as `types.d.ts`.
    *
    * ```ts no_run
    * import { parse } from 'fino:format/typescript';
    *
    * parse('declare const x: string;', { filename: 'types.d.ts' }).sourceType.typescriptDefinition;
    * ```
    */
    typescriptDefinition: boolean;
  };
}
/**
* Options controlling TypeScript-to-JavaScript transpilation.
*
* These options select parser mode and source-map metadata. Transpilation does
* not type-check the program or perform bundling.
*
* ```ts no_run
* import { transpile, type TranspileOptions } from 'fino:format/typescript';
*
* const options: TranspileOptions = { filename: 'input.ts' };
* transpile('const value: number = 1;', options);
* ```
*/
export interface TranspileOptions {
  /**
  * Filename used for syntax-mode inference and source map metadata.
  *
  * The file is not read from disk. For `transpile()` this is the only grammar
  * control: use a `.tsx`, `.jsx`, or `.d.ts` extension to select those modes.
  * Without a filename, transpilation assumes TypeScript module grammar
  * (source maps then reference `module.ts`).
  *
  * ```ts no_run
  * import { transpile } from 'fino:format/typescript';
  *
  * transpile('const x: number = 1;', { filename: 'example.ts' });
  * ```
  */
  filename?: string;
  /**
  * Explicit source grammar for the functions that honor it.
  *
  * `format()` and `lint()` resolve grammar from this field before falling
  * back to `filename` inference. `transpile()` itself ignores this field and
  * derives grammar from `filename` alone, so pass a filename with a matching
  * extension to transpile JSX or declaration-file input.
  *
  * ```ts no_run
  * import { format, transpile } from 'fino:format/typescript';
  *
  * format('const el = <div />;', { sourceType: 'tsx' });
  * transpile('const el = <div />;', { filename: 'component.tsx' });
  * ```
  */
  sourceType?: ParseOptions['sourceType'];
}
/**
* JavaScript output, source map text, and diagnostics from transpilation.
*
* `code` and `map` are strings returned by OXC. Check `ok` before evaluating or
* writing the output; failed transpilation returns empty `code` and `map`
* strings alongside diagnostics in `errors`.
*
* ```ts no_run
* import { transpile, type TranspileResult } from 'fino:format/typescript';
*
* const result: TranspileResult = transpile('const x: number = 1;', {
*   filename: 'x.ts',
* });
* ```
*/
export interface TranspileResult {
  /**
  * Whether transpilation completed without failure diagnostics.
  *
  * `false` means inspect `errors` before using `code`.
  *
  * ```ts no_run
  * import { transpile } from 'fino:format/typescript';
  *
  * const ok = transpile('const x: number = 1;', { filename: 'x.ts' }).ok;
  * ```
  */
  ok: boolean;
  /**
  * Transpiled JavaScript source code.
  *
  * Type syntax is removed or lowered according to OXC's transformer behavior.
  * The result is not bundled or minified. Empty when transpilation failed.
  *
  * ```ts no_run
  * import { transpile } from 'fino:format/typescript';
  *
  * const code = transpile('const x: number = 1;', { filename: 'x.ts' }).code;
  * ```
  */
  code: string;
  /**
  * Source map text emitted by OXC.
  *
  * The map references `filename` (or the `module.ts` default) as its source.
  * Empty when transpilation failed.
  *
  * ```ts no_run
  * import { transpile } from 'fino:format/typescript';
  *
  * const map = transpile('const x: number = 1;', { filename: 'x.ts' }).map;
  * ```
  */
  map: string;
  /**
  * Transpiler diagnostics.
  *
  * The array is empty on success. Diagnostics use the same shape as parser
  * diagnostics and should not be treated as stable machine-readable codes.
  *
  * ```ts no_run
  * import { transpile } from 'fino:format/typescript';
  *
  * const errors = transpile('const =', { filename: 'x.ts' }).errors;
  * ```
  */
  errors: ParseDiagnostic[];
}
/**
* Options controlling source formatting.
*
* Formatting uses the same source grammar controls as `parse()`: an explicit
* `sourceType` wins, then `filename` inference, then the TypeScript module
* default. Invalid source returns `ok: false` with diagnostics instead of
* emitting partial formatted code.
*
* ```ts no_run
* import type { FormatOptions } from 'fino:format/typescript';
*
* const options: FormatOptions = { filename: 'app.ts', sourceType: 'ts' };
* ```
*/
export interface FormatOptions extends TranspileOptions {}
/**
* Result returned by `format()`.
*
* `code` contains the complete formatted source only when `ok` is `true`.
* `errors` contains parse or formatter diagnostics and is empty on success.
*
* ```ts no_run
* import { format, type FormatResult } from 'fino:format/typescript';
*
* const result: FormatResult = format('const value = "x";');
* ```
*/
export interface FormatResult {
  /** Whether formatting succeeded without diagnostics. */
  ok: boolean;
  /** Formatted source text, or the empty string on failure. */
  code: string;
  /** Parse or formatter diagnostics. */
  errors: ParseDiagnostic[];
}
/**
* Options controlling source linting.
*
* Linting shares the source grammar controls from `parse()`: explicit
* `sourceType` first, then `filename` inference. When `fix` is true, automatic
* fixes that the rule set can apply are returned in `fixedCode`; diagnostics
* without a safe fix never rewrite the input.
*
* ```ts no_run
* import type { LintOptions } from 'fino:format/typescript';
*
* const options: LintOptions = { filename: 'app.ts', fix: true };
* ```
*/
export interface LintOptions extends TranspileOptions {
  /**
  * Request automatically fixed source text in `fixedCode`.
  *
  * The input string is never modified. The default rule set currently has no
  * auto-fixable rules, so `fixedCode` comes back `null` even with `fix: true`.
  */
  fix?: boolean;
}
/**
* Result returned by `lint()`.
*
* `ok` is `true` only when no diagnostics remain. `fixedCode` carries a
* rewritten source string only when automatic fixes were applied; it is `null`
* otherwise, including whenever the rule set has nothing to fix.
*
* ```ts no_run
* import { lint, type LintResult } from 'fino:format/typescript';
*
* const result: LintResult = lint('debugger;');
* ```
*/
export interface LintResult {
  /** Whether linting completed with no diagnostics. */
  ok: boolean;
  /** Parse and lint diagnostics from the default rule set. */
  diagnostics: ParseDiagnostic[];
  /** Rewritten source when automatic fixes were applied; `null` otherwise. */
  fixedCode?: string;
}
/**
* Parse JavaScript or TypeScript source with OXC.
*
* Returns parser output and diagnostics without type-checking. Normal syntax
* errors are represented by `ok: false`; bridge-level failures may still throw.
*
* ```ts no_run
* import { parse } from 'fino:format/typescript';
*
* const result = parse('export const answer: number = 42;', { sourceType: 'ts' });
* if (!result.ok) throw new Error(result.errors[0]?.message);
* ```
*/
export function parse(source: string, options: ParseOptions = {}): ParseResult {
  return parseNative(String(source), options) as ParseResult;
}
/**
* Transpile TypeScript or JSX syntax to JavaScript.
*
* The native transformer removes TypeScript syntax and lowers supported syntax
* according to OXC. It does not perform type-checking, module resolution, or
* bundling. Grammar comes from `filename` alone — TypeScript module grammar
* when omitted — so JSX or declaration input needs a filename with a matching
* extension; `options.sourceType` is not consulted here. Check `ok` and
* `errors` before consuming `code`. JSX uses the automatic `fino:ui` runtime
* by default and honors file-level `@jsxImportSource` pragmas.
*
* ```ts no_run
* import { transpile } from 'fino:format/typescript';
*
* const { code } = transpile('const x: number = 1;', { filename: 'x.ts' });
* const jsx = transpile('const el = <div />;', { filename: 'component.tsx' });
* ```
*/
export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  return transpileNative(String(source), options) as TranspileResult;
}
function stripTrailingWhitespace(code: string): string {
  return code.replace(/[ \t]+$/gm, '');
}
/**
* Format JavaScript or TypeScript source with the runtime's OXC-backed tooling.
*
* Formatting normalizes quotes, indentation, and the trailing newline while
* preserving TypeScript and JSX syntax as written. Trailing whitespace is
* stripped from every line of successful output. Source grammar follows the
* same `sourceType` selection and `filename` inference as `parse()`.
*
* Invalid source does not throw: the result carries `ok: false`, an empty
* `code` string, and parse diagnostics in `errors`.
*
* ```ts no_run
* import { format } from 'fino:format/typescript';
*
* const result = format('const value = "hello";\nif (value) { console.log(value); }\n', {
*   filename: 'sample.ts',
* });
* if (result.ok) console.log(result.code);
* else console.error(result.errors[0]?.message);
* ```
*/
export function format(source: string, options: FormatOptions = {}): FormatResult {
  const result = formatNative(String(source), options) as FormatResult;
  if (result.ok) result.code = stripTrailingWhitespace(result.code);
  return result;
}
/**
* Lint JavaScript or TypeScript source with the runtime's default rule set.
*
* The result is `ok: true` only when no diagnostics remain. Syntax errors fail
* lint the same way rule violations do, so `lint()` can double as a validity
* check. Each diagnostic carries the rule `code` (for example `no-debugger`)
* and one-based `line`/`column` positions where available.
*
* With `fix: true`, automatically fixable diagnostics would produce a
* rewritten source string in `fixedCode`; the input is never modified, and
* `fixedCode` is `null` when no fixes apply — which is currently always, as
* the default rule set has no auto-fixable rules.
*
* ```ts no_run
* import { lint } from 'fino:format/typescript';
*
* const result = lint('debugger;\nconst el = <button />;\n', {
*   filename: 'component.tsx',
* });
* for (const diagnostic of result.diagnostics) {
*   console.log(`${diagnostic.code} at ${diagnostic.line}:${diagnostic.column}`);
* }
* ```
*/
export function lint(source: string, options: LintOptions = {}): LintResult {
  return lintNative(String(source), options) as LintResult;
}
interface ServeCacheEntry {
  mtimeMs: number;
  size: number;
  code: string;
}
/**
* Options for `transpileFiles()`.
*
* ```ts no_run
* import { transpileFiles, type TranspileFilesOptions } from 'fino:format/typescript';
*
* const options: TranspileFilesOptions = { prefix: '/client/' };
* ```
*/
export interface TranspileFilesOptions {
  /** URL path prefix to serve from. Defaults to `/`. */
  prefix?: string;
}
function requestPath(req: Request): string {
  const trusted = (req as Request & {
    _trustedPath?: () => string | null;
  })._trustedPath?.();
  const path = trusted ?? new URL(req.url).pathname;
  const query = path.indexOf('?');
  return query < 0 ? path : path.slice(0, query);
}
function isTypeScriptPath(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.tsx');
}
/**
* Serve TypeScript files under `root` as browser-loadable JavaScript modules.
*
* This middleware serves `.ts` and `.tsx` files as JavaScript ES modules using
* the same OXC-backed `transpile()` as the rest of this module. It is intended
* for small browser-side modules in Fino apps that do not need a bundler: it
* only strips TypeScript syntax, and does not bundle imports, rewrite package
* specifiers, minify, or hide source code.
*
* Requests outside `prefix`, non-TypeScript paths, and files missing from
* `root` fall through to the next middleware. Path traversal attempts return
* `403`, and source that fails to transpile returns `500` with the diagnostic
* messages as the body. Transpiled output is cached per file and invalidated
* when the file's mtime or size changes, so edits are picked up on the next
* request without restarting the server.
*
* ```ts no_run
* import { App } from 'fino:net/http/app';
* import { transpileFiles } from 'fino:format/typescript';
*
* const app = new App();
* app.layer(transpileFiles('./client', { prefix: '/client/' }));
* ```
*/
export function transpileFiles(root: string, opts: TranspileFilesOptions = {}): LayerMiddleware {
  const prefix = opts.prefix ?? '/';
  const cache = new Map<string, ServeCacheEntry>();
  const deps = async () => {
    const [{ DiskFileSystem }, { join, normalize }] = await Promise.all([import('fino:file'), import('fino:file/path')]);
    return {
      fs: new DiskFileSystem(),
      join,
      normalize
    };
  };
  let loaded: ReturnType<typeof deps> | undefined;
  return async (ctx, next) => {
    const pathname = requestPath(ctx.request);
    if (!pathname.startsWith(prefix)) return next();
    const rawRelative = pathname.slice(prefix.length).replace(/^\/+/, '');
    if (!isTypeScriptPath(rawRelative)) return next();
    const { fs, join, normalize } = await (loaded ??= deps());
    const decoded = decodeURIComponent(rawRelative);
    const normalized = normalize(decoded).toString();
    if (normalized.startsWith('..') || normalized.includes('/../')) return new Response('Forbidden', { status: 403 });
    const file = join(root, normalized).toString();
    let stat;
    try {
      stat = await fs.stat(file);
      if (!stat.isFile()) return next();
    } catch {
      return next();
    }
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return new Response(cached.code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    const handle = await fs.open(file);
    try {
      const source = await handle.text();
      const result = transpile(source, {
        filename: file,
        sourceType: file.endsWith('.tsx') ? 'tsx' : 'ts'
      });
      if (!result.ok) return new Response(result.errors.map((error) => error.message).join('\n'), { status: 500 });
      cache.set(file, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        code: result.code
      });
      return new Response(result.code, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    } finally {
      handle.close();
    }
  };
}
