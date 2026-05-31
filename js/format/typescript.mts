/**
 * fino:format/typescript — OXC-backed TypeScript and JavaScript parser.
 *
 * Exposes OXC parse results to JavaScript. The AST shape intentionally mirrors
 * OXC's serialized ESTree output and may change when the bundled OXC version
 * changes.
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
 * ```ts
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
 * ```ts
 * import { transpile } from 'fino:format/typescript';
 *
 * const { code } = transpile('const x: number = 1;', { sourceType: 'ts' });
 * ```
 */
export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  return transpileNative(String(source), options) as TranspileResult;
}
