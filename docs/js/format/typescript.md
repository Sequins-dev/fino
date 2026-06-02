# typescript

fino:format/typescript — OXC-backed TypeScript and JavaScript parser.

This module exposes the runtime's OXC parser and transformer to JavaScript.
Use it for tooling-oriented tasks such as inspecting TypeScript/JavaScript
source, collecting comments and tokens, validating syntax, or stripping
TypeScript syntax before evaluation. It is not a type checker.

`parse()` returns OXC's serialized ESTree-compatible AST, comments, optional
tokens, diagnostics, and the detected source mode. The AST shape follows the
bundled OXC version and can change as OXC evolves. `transpile()` returns
JavaScript code plus source map text and diagnostics for TypeScript/JSX
syntax lowering.

Source grammar is inferred from `filename` when possible. Pass `sourceType`
to force JavaScript, JSX, TypeScript, TSX, declaration-file, module, or
script parsing behavior.

```ts
import { parse } from 'fino:format/typescript';

const result = parse('export const answer: number = 42;', {
  sourceType: 'ts',
  tokens: true,
});
if (!result.ok) throw new Error(result.errors[0]?.message);
```

```ts
import { transpile } from 'fino:format/typescript';

const { code, map } = transpile('const x: number = 1;', {
  filename: 'example.ts',
});
```

Useful references:
  - OXC project: https://oxc.rs/
  - ESTree specification: https://github.com/estree/estree
  - TypeScript language: https://www.typescriptlang.org/docs/

## ParseOptions

```ts
interface ParseOptions {
```

Options controlling source grammar detection and parser output.

### filename

```ts
filename?: string
```

Filename used for syntax-mode inference and diagnostics.

### sourceType

```ts
sourceType?: 'js' | 'javascript' | 'script' | 'jsx' | 'ts' | 'typescript' | 'tsx' | 'dts' | 'definition'
```

Explicit source grammar. Defaults are inferred from filename when possible.

### tokens

```ts
tokens?: boolean
```

Include lexer tokens in the parse result.

## ParseToken

```ts
interface ParseToken {
```

Token returned when ParseOptions.tokens is enabled.

### kind

```ts
kind: string
```

### text

```ts
text: string
```

### start

```ts
start: number
```

### end

```ts
end: number
```

### onNewLine

```ts
onNewLine: boolean
```

## ParseComment

```ts
interface ParseComment {
```

Source comment with attachment metadata from OXC.

### kind

```ts
kind: 'line' | 'block'
```

### text

```ts
text: string
```

### start

```ts
start: number
```

### end

```ts
end: number
```

### attachedTo

```ts
attachedTo: number
```

### leading

```ts
leading: boolean
```

### trailing

```ts
trailing: boolean
```

### jsdoc

```ts
jsdoc: boolean
```

## ParseDiagnostic

```ts
interface ParseDiagnostic {
```

Parser or transpiler diagnostic.

### message

```ts
message: string
```

## ParseResult

```ts
interface ParseResult {
```

Complete parse result, including AST, comments, tokens, and diagnostics.

### ok

```ts
ok: boolean
```

### ast

```ts
ast: any
```

### comments

```ts
comments: ParseComment[]
```

### tokens

```ts
tokens: ParseToken[]
```

### errors

```ts
errors: ParseDiagnostic[]
```

### sourceType

```ts
sourceType: { language: 'typescript' | 'javascript'; moduleKind: 'module' | 'script' | 'unambiguous' | 'commonjs'; jsx: boolean; typescriptDefinition: boolean; }
```

## TranspileOptions

```ts
interface TranspileOptions {
```

Options controlling TypeScript-to-JavaScript transpilation.

### filename

```ts
filename?: string
```

Filename used for syntax-mode inference and source map metadata.

### sourceType

```ts
sourceType?: ParseOptions['sourceType']
```

Explicit source grammar. Defaults are inferred from filename when possible.

## TranspileResult

```ts
interface TranspileResult {
```

JavaScript output, source map text, and diagnostics from transpilation.

### ok

```ts
ok: boolean
```

### code

```ts
code: string
```

### map

```ts
map: string
```

### errors

```ts
errors: ParseDiagnostic[]
```

## parse

```ts
function parse(source: string, options: ParseOptions = {}): ParseResult
```

Parse JavaScript or TypeScript source with OXC.

```ts
import { parse } from 'fino:format/typescript';

const result = parse('export const answer: number = 42;', { sourceType: 'ts' });
if (!result.ok) throw new Error(result.errors[0]?.message);
```

## transpile

```ts
function transpile(source: string, options: TranspileOptions = {}): TranspileResult
```

Transpile TypeScript or JSX syntax to JavaScript.

```ts
import { transpile } from 'fino:format/typescript';

const { code } = transpile('const x: number = 1;', { sourceType: 'ts' });
```
