import { describe, it } from 'fino:test/test';
import { parse, transpile, format, lint } from 'fino:format/typescript';

describe('fino:format/typescript', () => {
  it('parses TypeScript and exposes the full AST, comments, and tokens', (t) => {
    const source = `/**
 * Adds one.
 */
export function add(value: number): Promise<Response> {
  return fetch(String(value));
}
`;
    const parsed = parse(source, { filename: 'sample.mts', tokens: true });

    t.equal(parsed.ok, true, 'valid source parses successfully');
    t.equal(parsed.errors.length, 0, 'valid source has no parse errors');
    t.equal(parsed.ast.type, 'Program', 'result exposes OXC AST JSON');
    t.equal(parsed.ast.body[0].type, 'ExportNamedDeclaration', 'AST includes module declaration nodes');
    t.equal(parsed.comments.length, 1, 'comments are exposed separately');
    t.ok(parsed.comments[0]!.text.includes('Adds one.'), 'comment text is preserved');
    t.ok(parsed.tokens.some((token) => token.text === 'export' && token.kind === 'export'), 'tokens include keyword text');
    t.ok(parsed.tokens.some((token) => token.text === 'Promise' && token.kind === 'Identifier'), 'tokens include identifier text');
    t.ok(parsed.tokens.every((token) => typeof token.start === 'number' && token.end > token.start), 'tokens expose source spans');
  });

  it('returns recoverable parse diagnostics instead of throwing', (t) => {
    const parsed = parse('export function broken( {', { filename: 'broken.ts' });

    t.equal(parsed.ok, false, 'invalid source is marked unsuccessful');
    t.ok(parsed.errors.length > 0, 'parse diagnostics are returned');
    t.ok(parsed.errors[0]!.message.length > 0, 'diagnostics include messages');
    t.equal(parsed.ast.type, 'Program', 'recoverable parse still returns AST JSON');
  });

  it('transpiles TypeScript to JavaScript and source maps', (t) => {
    const source = `export interface Shape { value: number }
export function read<T extends Shape>(shape: T): number {
  return shape.value;
}
`;
    const result = transpile(source, { filename: 'sample.mts' });

    t.equal(result.ok, true, 'valid source transpiles successfully');
    t.equal(result.errors.length, 0, 'valid source has no transpile errors');
    t.ok(result.code.includes('export function read(shape)'), 'function parameter type is stripped');
    t.equal(result.code.includes('interface Shape'), false, 'interface declaration is stripped');
    t.ok(result.map.includes('"version"'), 'source map JSON is returned');
    t.ok(result.map.includes('sample.mts'), 'source map references the original filename');
  });

  it('returns transpile diagnostics for invalid TypeScript', (t) => {
    const result = transpile('export function broken( {', { filename: 'broken.ts' });

    t.equal(result.ok, false, 'invalid source is marked unsuccessful');
    t.equal(result.code, '', 'invalid source does not emit code');
    t.equal(result.map, '', 'invalid source does not emit a source map');
    t.ok(result.errors.length > 0, 'transpile diagnostics are returned');
  });

  it('formats TypeScript source with stable defaults', (t) => {
    const result = format('const value = "hello";\nif (value) { console.log(value); }\n', { filename: 'sample.ts' });

    t.equal(result.ok, true, 'valid source formats successfully');
    t.equal(result.errors.length, 0, 'valid source has no format errors');
    t.equal(result.code, "const value = 'hello';\nif (value) {\n  console.log(value);\n}\n", 'formatter normalizes quotes, indentation, and final newline');
  });

  it('returns format diagnostics for invalid TypeScript', (t) => {
    const result = format('export function broken( {', { filename: 'broken.ts' });

    t.equal(result.ok, false, 'invalid source is marked unsuccessful');
    t.equal(result.code, '', 'invalid source does not emit formatted code');
    t.ok(result.errors.length > 0, 'format diagnostics are returned');
    t.ok(result.errors[0]!.line !== undefined, 'diagnostics include a line');
    t.ok(result.errors[0]!.column !== undefined, 'diagnostics include a column');
  });

  it('lints parse errors and default suspicious rules', (t) => {
    const parsed = lint('export function broken( {', { filename: 'broken.ts' });
    const suspicious = lint('debugger;\n', { filename: 'debugger.ts' });

    t.equal(parsed.ok, false, 'parse errors fail lint');
    t.ok(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'parse'), 'parse diagnostics are included');
    t.equal(suspicious.ok, false, 'suspicious source fails lint');
    t.ok(suspicious.diagnostics.some((diagnostic) => diagnostic.code === 'no-debugger'), 'default rules include no-debugger');
  });
});
