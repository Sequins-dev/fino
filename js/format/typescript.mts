/**
 * fino:format/typescript — OXC-backed TypeScript and JavaScript parser.
 *
 * This module exposes the runtime's OXC parser and transformer to JavaScript.
 * Use it for tooling-oriented tasks such as inspecting TypeScript/JavaScript
 * source, collecting comments and tokens, validating syntax, or stripping
 * TypeScript syntax before evaluation. It is not a type checker.
 *
 * `parse()` returns OXC's serialized ESTree-compatible AST, comments, optional
 * tokens, diagnostics, and the detected source mode. The AST shape follows the
 * bundled OXC version and can change as OXC evolves. `transpile()` returns
 * JavaScript code plus source map text and diagnostics for TypeScript/JSX
 * syntax lowering.
 *
 * Source grammar is inferred from `filename` when possible. Pass `sourceType`
 * to force JavaScript, JSX, TypeScript, TSX, declaration-file, module, or
 * script parsing behavior.
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

import { parse as parseNative, transpile as transpileNative } from 'internal:format/typescript';

/** Options controlling source grammar detection and parser output. */
export interface ParseOptions {
  /** Filename used for syntax-mode inference and diagnostics. */
  filename?: string;
  /** Explicit source grammar. Defaults are inferred from filename when possible. */
  sourceType?: 'js' | 'javascript' | 'script' | 'jsx' | 'ts' | 'typescript' | 'tsx' | 'dts' | 'definition';
  /** Include lexer tokens in the parse result. */
  tokens?: boolean;
}

/** Token returned when ParseOptions.tokens is enabled. */
export interface ParseToken {
  kind: string;
  text: string;
  start: number;
  end: number;
  onNewLine: boolean;
}

/** Source comment with attachment metadata from OXC. */
export interface ParseComment {
  kind: 'line' | 'block';
  text: string;
  start: number;
  end: number;
  attachedTo: number;
  leading: boolean;
  trailing: boolean;
  jsdoc: boolean;
}

/** Parser or transpiler diagnostic. */
export interface ParseDiagnostic {
  message: string;
}

/** Complete parse result, including AST, comments, tokens, and diagnostics. */
export interface ParseResult {
  ok: boolean;
  ast: any;
  comments: ParseComment[];
  tokens: ParseToken[];
  errors: ParseDiagnostic[];
  sourceType: {
    language: 'typescript' | 'javascript';
    moduleKind: 'module' | 'script' | 'unambiguous' | 'commonjs';
    jsx: boolean;
    typescriptDefinition: boolean;
  };
}

/** Options controlling TypeScript-to-JavaScript transpilation. */
export interface TranspileOptions {
  /** Filename used for syntax-mode inference and source map metadata. */
  filename?: string;
  /** Explicit source grammar. Defaults are inferred from filename when possible. */
  sourceType?: ParseOptions['sourceType'];
}

/** JavaScript output, source map text, and diagnostics from transpilation. */
export interface TranspileResult {
  ok: boolean;
  code: string;
  map: string;
  errors: ParseDiagnostic[];
}

/**
 * Parse JavaScript or TypeScript source with OXC.
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
 * ```ts no_run
 * import { transpile } from 'fino:format/typescript';
 *
 * const { code } = transpile('const x: number = 1;', { sourceType: 'ts' });
 * ```
 */
export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  return transpileNative(String(source), options) as TranspileResult;
}
