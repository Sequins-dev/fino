import { describe, it } from 'fino:test/test';
import { parse, transpile, format, lint } from 'fino:format/typescript';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
describe('fino:format/typescript', () => {
  it('parses TypeScript and exposes the full AST, comments, and tokens', (t) => {
    const source = `/**
 * Adds one.
 */
export function add(value: number): Promise<Response> {
  return fetch(String(value));
}
`;
    const parsed = parse(source, {
      filename: 'sample.ts',
      tokens: true
    });
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
  it('parses string literals that use hex escapes', (t) => {
    const parsed = parse('const s = \'Hello, World! \\x00\\xFF\\xAB\';\n', {
      filename: 'hex-escape.ts',
      tokens: true
    });
    t.equal(parsed.ok, true, 'hex-escaped string source parses successfully');
    t.equal(parsed.errors.length, 0, 'hex-escaped string has no parse diagnostics');
    t.equal(parsed.ast.type, 'Program', 'AST JSON is materialized');
  });
  it('parses source files with mixed unicode and hex escapes for docs extraction', async (t) => {
    const source = String(await fs.readFile('tests/internal/globals/encoding.test.ts'));
    const parsed = parse(source, {
      filename: 'tests/internal/globals/encoding.test.ts',
      tokens: true
    });
    t.equal(parsed.ok, true, 'encoding test source parses successfully');
    t.equal(parsed.errors.length, 0, 'encoding test source has no parse diagnostics');
    t.ok(parsed.tokens.length > 0, 'tokens are materialized for doc extraction');
  });
  it('transpiles TypeScript to JavaScript and source maps', (t) => {
    const source = `export interface Shape { value: number }
export function read<T extends Shape>(shape: T): number {
  return shape.value;
}
`;
    const result = transpile(source, { filename: 'sample.ts' });
    t.equal(result.ok, true, 'valid source transpiles successfully');
    t.equal(result.errors.length, 0, 'valid source has no transpile errors');
    t.ok(result.code.includes('export function read(shape)'), 'function parameter type is stripped');
    t.equal(result.code.includes('interface Shape'), false, 'interface declaration is stripped');
    t.ok(result.map.includes('"version"'), 'source map JSON is returned');
    t.ok(result.map.includes('sample.ts'), 'source map references the original filename');
  });
  it('emits valid source-map JSON with filename metadata', (t) => {
    const result = transpile('export const value: number = 1;\n', { filename: 'src/value.ts' });
    const map = JSON.parse(result.map) as Record<string, unknown>;
    t.equal(result.ok, true, 'transpile succeeds');
    t.equal(map['version'], 3, 'source map has a version');
    t.deepEqual(map['sources'], ['src/value.ts'], 'source map records the input filename');
    t.ok(typeof map['mappings'] === 'string', 'source map has mappings');
  });
  it('parses JSX, TSX, and declaration files', (t) => {
    const jsx = parse('const el = <section data-kind="jsx" />;', { filename: 'view.jsx' });
    const tsx = parse('type Props = { name: string };\nconst el = <h1>{props.name}</h1>;', { filename: 'view.tsx' });
    const dts = parse('declare module "pkg" { export const value: string; }\n', { filename: 'pkg/index.d.ts' });
    t.equal(jsx.ok, true, 'jsx parses successfully');
    t.equal(jsx.sourceType.language, 'javascript', 'jsx filename infers JavaScript');
    t.equal(jsx.sourceType.jsx, true, 'jsx filename enables JSX');
    t.equal(tsx.ok, true, 'tsx parses successfully');
    t.equal(tsx.sourceType.language, 'typescript', 'tsx filename infers TypeScript');
    t.equal(tsx.sourceType.jsx, true, 'tsx filename enables JSX');
    t.equal(dts.ok, true, 'declaration file parses successfully');
    t.equal(dts.sourceType.typescriptDefinition, true, '.d.ts filename enables declaration mode');
  });
  it('honors explicit sourceType modes', (t) => {
    const js = parse('const value = 1;', { sourceType: 'js' });
    const script = parse('return 1;', { sourceType: 'script' });
    const jsx = parse('const el = <span />;', { sourceType: 'jsx' });
    const ts = parse('const value: number = 1;', { sourceType: 'ts' });
    const tsx = parse('const el: JSX.Element = <span />;', { sourceType: 'tsx' });
    const dts = parse('declare const value: string;', { sourceType: 'dts' });
    t.equal(js.sourceType.language, 'javascript', 'js sourceType selects JavaScript');
    t.equal(js.sourceType.moduleKind, 'module', 'js sourceType selects module mode');
    t.equal(script.sourceType.moduleKind, 'script', 'script sourceType selects script mode');
    t.equal(jsx.ok, true, 'jsx sourceType parses JSX');
    t.equal(jsx.sourceType.jsx, true, 'jsx sourceType enables JSX');
    t.equal(ts.ok, true, 'ts sourceType parses TypeScript');
    t.equal(ts.sourceType.language, 'typescript', 'ts sourceType selects TypeScript');
    t.equal(tsx.ok, true, 'tsx sourceType parses TSX');
    t.equal(tsx.sourceType.jsx, true, 'tsx sourceType enables JSX');
    t.equal(dts.sourceType.typescriptDefinition, true, 'dts sourceType enables declaration mode');
  });
  it('returns transpile diagnostics for invalid TypeScript', (t) => {
    const result = transpile('export function broken( {', { filename: 'broken.ts' });
    t.equal(result.ok, false, 'invalid source is marked unsuccessful');
    t.equal(result.code, '', 'invalid source does not emit code');
    t.equal(result.map, '', 'invalid source does not emit a source map');
    t.ok(result.errors.length > 0, 'transpile diagnostics are returned');
  });
  it('formats TypeScript source with stable defaults', (t) => {
    const result = format('const value = "hello";\nif (value) {\nconsole.log(value);\n}\n', { filename: 'sample.ts' });
    t.equal(result.ok, true, 'valid source formats successfully');
    t.equal(result.errors.length, 0, 'valid source has no format errors');
    t.equal(result.code, 'const value = \'hello\';\nif (value) {\n  console.log(value);\n}\n', 'formatter normalizes quotes, indentation, and final newline');
  });
  it('preserves numeric literal notation and unicode escapes', (t) => {
    const source = String.raw`const mask = 0xFF;
const timeout = 1000;
const largeTimeout = 100000;
const divisionSlash = '\u2215';
`;
    const result = format(source, { filename: 'literals.ts' });
    t.equal(result.ok, true, 'literal source formats successfully');
    t.ok(result.code.includes('0xFF'), 'hexadecimal notation is preserved');
    t.ok(result.code.includes('1000'), 'decimal powers of ten stay decimal');
    t.ok(result.code.includes('100000'), 'large decimal powers of ten stay decimal');
    t.ok(result.code.includes(String.raw`'\u2215'`), 'unicode escape spelling is preserved');
  });
  it('preserves documentation and statement comments', (t) => {
    const source = `const schema = {
  /**
   * Route parameter documentation.
   */
  params: {},
};
try {
  run();
} catch {
  // Recovery is intentionally best effort.
  recover();
}
`;
    const result = format(source, { filename: 'comments.ts' });
    t.equal(result.ok, true, 'commented source formats successfully');
    t.ok(result.code.includes('Route parameter documentation.'), 'property documentation is preserved');
    t.ok(result.code.includes('Recovery is intentionally best effort.'), 'statement comments are preserved');
  });
  it('wraps chains, callbacks, imports, and exports near 100 columns', (t) => {
    const source = `import { extraordinarilyLongImportedNameOne, extraordinarilyLongImportedNameTwo, extraordinarilyLongImportedNameThree } from './long-module-name.ts';
export { extraordinarilyLongExportedNameOne, extraordinarilyLongExportedNameTwo, extraordinarilyLongExportedNameThree } from './long-module-name.ts';
const result = extraordinarilyLongCollectionName.filter((extraordinarilyLongRecordName) => extraordinarilyLongRecordName.isEligibleForFormatting).map((extraordinarilyLongRecordName) => extraordinarilyLongRecordName.convertToFormattedResult()).reduce((accumulator, extraordinarilyLongRecordName) => accumulator.concat(extraordinarilyLongRecordName), []);
`;
    const result = format(source, { filename: 'wrapping.ts' });
    t.equal(result.ok, true, 'long source formats successfully');
    const longestLine = Math.max(...result.code.split('\n').map((line) => line.length));
    t.ok(longestLine <= 100, `formatted lines stay within 100 columns (got ${longestLine})`);
    t.ok(/\n\s+\.(?:filter|map|reduce)\(/.test(result.code), 'fluent chains may break onto indented lines');
  });
  it('is idempotent when wrapping fluent chains', (t) => {
    const source = `function contentType(response: Response): string {
  return (response.headers.get('content-type') ?? 'application/json').split(';')[0]!.trim().toLowerCase();
}
`;
    const first = format(source, { filename: 'chain.ts' });
    const second = format(first.code, { filename: 'chain.ts' });
    t.equal(first.ok, true, 'first formatting pass succeeds');
    t.equal(second.ok, true, 'second formatting pass succeeds');
    t.equal(second.code, first.code, 'a second formatting pass makes no changes');
  });
  it('is idempotent for a full module after layout changes', async (t) => {
    const source = String(await fs.readFile('js/net/mdns.ts'));
    const first = format(source, { filename: 'js/net/mdns.ts' });
    const second = format(first.code, { filename: 'js/net/mdns.ts' });
    t.equal(first.ok, true, 'first module formatting pass succeeds');
    t.equal(second.ok, true, 'second module formatting pass succeeds');
    t.equal(second.code, first.code, 'module formatting reaches a stable layout in one call');
  });
  it('does not emit trailing whitespace', (t) => {
    const result = format('export type { /** docs */ Value } from "./value.ts";\n', { filename: 'sample.ts' });
    t.equal(result.ok, true, 'valid source formats successfully');
    t.equal(/[ \t]$/m.test(result.code), false, 'formatted output has no line-end whitespace');
  });
  it('formats source using filename inference and explicit source mode', (t) => {
    const inferred = format('const el = <main className="app">{value}</main>;\n', { filename: 'component.tsx' });
    const explicit = format('const value: number = 1;\n', {
      filename: 'virtual.js',
      sourceType: 'ts'
    });
    const script = format('const value = "ok";\n', { sourceType: 'script' });
    t.equal(inferred.ok, true, 'formatter infers TSX from filename');
    t.ok(inferred.code.includes('<main className="app">{value}</main>'), 'formatter preserves JSX attribute quotes');
    t.equal(explicit.ok, true, 'formatter accepts explicit TypeScript source mode');
    t.equal(explicit.code, 'const value: number = 1;\n', 'formatter preserves TypeScript syntax');
    t.equal(script.ok, true, 'formatter accepts script source mode');
    t.equal(script.code, 'const value = \'ok\';\n', 'formatter formats script bodies');
  });
  it('formats standalone declaration signatures in declaration mode', (t) => {
    const source = 'declare class Example { configure(options: { enabled: boolean }): { enabled: boolean }; }\n';
    const explicit = format(source, { sourceType: 'dts' });
    const inferred = format(source, { filename: 'pkg/index.d.ts' });
    t.equal(explicit.ok, true, 'explicit declaration signature formats successfully');
    t.equal(inferred.ok, true, 'filename-inferred declaration signature formats successfully');
    t.ok(explicit.code.includes('declare class Example'), 'declaration syntax is retained');
    t.ok(inferred.code.includes('configure('), 'declaration member is retained');
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
  it('lints TSX source and reports diagnostic locations', (t) => {
    const result = lint('debugger;\nconst el = <button />;\n', { filename: 'component.tsx' });
    t.equal(result.ok, false, 'tsx lint reports diagnostics');
    t.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'no-debugger' && diagnostic.line === 1 && diagnostic.column === 1), 'diagnostics include rule code and one-based location');
    t.equal(result.fixedCode as unknown, null, 'lint fix output is null when no fixes exist');
  });
});
