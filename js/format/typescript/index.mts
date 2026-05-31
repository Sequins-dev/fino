/**
 * fino:format/typescript — OXC-backed TypeScript and JavaScript parser.
 *
 * Exposes OXC parse results to JavaScript. The AST shape intentionally mirrors
 * OXC's serialized ESTree output and may change when the bundled OXC version
 * changes.
 */

import { parse as parseNative, transpile as transpileNative } from 'internal:format/typescript';

export interface ParseOptions {
  filename?: string;
  sourceType?: 'js' | 'javascript' | 'script' | 'jsx' | 'ts' | 'typescript' | 'tsx' | 'dts' | 'definition';
  tokens?: boolean;
}

export interface ParseToken {
  kind: string;
  text: string;
  start: number;
  end: number;
  onNewLine: boolean;
}

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

export interface ParseDiagnostic {
  message: string;
}

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

export interface TranspileOptions {
  filename?: string;
  sourceType?: ParseOptions['sourceType'];
}

export interface TranspileResult {
  ok: boolean;
  code: string;
  map: string;
  errors: ParseDiagnostic[];
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  return parseNative(String(source), options) as ParseResult;
}

export function transpile(source: string, options: TranspileOptions = {}): TranspileResult {
  return transpileNative(String(source), options) as TranspileResult;
}
