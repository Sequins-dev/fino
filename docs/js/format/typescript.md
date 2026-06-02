# typescript

fino:format/typescript - OXC-backed TypeScript and JavaScript parser.

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

Filename and source type are used only for parser mode selection and
diagnostics; this module does not read files from disk. Token collection is
disabled by default to keep parsing output smaller.

```ts
import { parse, type ParseOptions } from 'fino:format/typescript';

const options: ParseOptions = { filename: 'component.tsx', tokens: true };
const result = parse('export const x = <div />;', options);
```

### filename

```ts
filename?: string
```

Filename used for syntax-mode inference and diagnostics.

Extensions such as `.ts`, `.tsx`, `.jsx`, and `.d.ts` guide the parser
when `sourceType` is omitted. The value is also carried into source-map and
diagnostic metadata by the native parser.

```ts
import { parse } from 'fino:format/typescript';

parse('declare const x: string;', { filename: 'types.d.ts' });
```

### sourceType

```ts
sourceType?: 'js' | 'javascript' | 'script' | 'jsx' | 'ts' | 'typescript' | 'tsx' | 'dts' | 'definition'
```

Explicit source grammar. Defaults are inferred from `filename` when possible.

Use this when parsing virtual source or when a filename extension does not
match the syntax. The parser still reports diagnostics rather than throwing
for syntax errors returned by OXC.

```ts
import { parse } from 'fino:format/typescript';

parse('const x: number = 1;', { sourceType: 'ts' });
```

### tokens

```ts
tokens?: boolean
```

Include lexer tokens in the parse result. Defaults to `false`.

Tokens increase result size but are useful for formatters, linters, and
source analysis that needs exact lexical spans.

```ts
import { parse } from 'fino:format/typescript';

const tokens = parse('let x = 1;', { tokens: true }).tokens;
```

## ParseToken

```ts
interface ParseToken {
```

Token returned when `ParseOptions.tokens` is enabled.

Offsets are byte offsets into the supplied JavaScript string as reported by
OXC. No tokens are returned when token collection is disabled.

```ts
import { parse, type ParseToken } from 'fino:format/typescript';

const token: ParseToken | undefined = parse('const x = 1;', {
  tokens: true,
}).tokens[0];
```

### kind

```ts
kind: string
```

OXC token kind name.

The exact set of names follows the bundled OXC version and may grow as the
JavaScript grammar evolves.

```ts
import { parse } from 'fino:format/typescript';

parse('const x = 1;', { tokens: true }).tokens[0]?.kind;
```

### text

```ts
text: string
```

Source text matched by the token.

The text is not normalized, so whitespace and escape spelling remain as
they appeared in the original source.

```ts
import { parse } from 'fino:format/typescript';

parse('const x = 1;', { tokens: true }).tokens[0]?.text;
```

### start

```ts
start: number
```

Start offset of the token in the source string.

Use this with `end` to slice the original source. The offset is zero-based.

```ts
import { parse } from 'fino:format/typescript';

const source = 'const x = 1;';
const token = parse(source, { tokens: true }).tokens[0]!;
source.slice(token.start, token.end);
```

### end

```ts
end: number
```

End offset of the token in the source string.

This is exclusive, matching JavaScript `String.prototype.slice()`.

```ts
import { parse } from 'fino:format/typescript';

const token = parse('const x = 1;', { tokens: true }).tokens[0]!;
token.end - token.start;
```

### onNewLine

```ts
onNewLine: boolean
```

Whether OXC observed a line break before this token.

This is useful for automatic-semicolon-insertion-sensitive tooling.

```ts
import { parse } from 'fino:format/typescript';

parse('a\nb', { tokens: true }).tokens.some((token) => token.onNewLine);
```

## ParseComment

```ts
interface ParseComment {
```

Source comment with attachment metadata from OXC.

Comments are reported separately from the AST. Attachment fields describe
OXC's best effort at associating comments with nearby nodes and may change
as OXC changes its parser behavior.

```ts
import { parse, type ParseComment } from 'fino:format/typescript';

const comment: ParseComment | undefined = parse('// docs\nconst x = 1;').comments[0];
```

### kind

```ts
kind: 'line' | 'block'
```

Comment syntax kind.

`line` represents line comments and `block` represents block comments.

```ts
import { parse } from 'fino:format/typescript';

parse('// hi\nx').comments[0]?.kind;
```

### text

```ts
text: string
```

Comment body text without delimiters.

The text is not HTML-escaped or otherwise sanitized.

```ts
import { parse } from 'fino:format/typescript';

parse('// hello\nx').comments[0]?.text;
```

### start

```ts
start: number
```

Start offset of the full comment in the source string.

The offset includes the opening comment delimiter.

```ts
import { parse } from 'fino:format/typescript';

parse('// hi\nx').comments[0]?.start;
```

### end

```ts
end: number
```

End offset of the full comment in the source string.

This is exclusive and includes the closing delimiter for block comments.

```ts
import { parse } from 'fino:format/typescript';

parse('// hi\nx').comments[0]?.end;
```

### attachedTo

```ts
attachedTo: number
```

OXC node attachment identifier.

The value is parser metadata, not a stable public node ID. It may be `0`
when no useful attachment exists.

```ts
import { parse } from 'fino:format/typescript';

parse('// doc\nconst x = 1;').comments[0]?.attachedTo;
```

### leading

```ts
leading: boolean
```

Whether the comment is considered leading for its attached node.

Leading comments appear before the associated syntax.

```ts
import { parse } from 'fino:format/typescript';

parse('// leading\nconst x = 1;').comments[0]?.leading;
```

### trailing

```ts
trailing: boolean
```

Whether the comment is considered trailing for its attached node.

Trailing comments appear after nearby syntax on the same line or close
region according to OXC's attachment rules.

```ts
import { parse } from 'fino:format/typescript';

parse('const x = 1; // trailing').comments[0]?.trailing;
```

### jsdoc

```ts
jsdoc: boolean
```

Whether the comment is a JSDoc-style block comment.

This is true for comments that OXC recognizes as documentation comments.

```ts
import { parse } from 'fino:format/typescript';

parse('// docs\nconst x = 1;').comments[0]?.jsdoc;
```

## ParseDiagnostic

```ts
interface ParseDiagnostic {
```

Parser or transpiler diagnostic.

Diagnostics are returned in result objects instead of throwing for normal
syntax errors. Native bridge failures may still throw before a result is
created.

```ts
import { parse, type ParseDiagnostic } from 'fino:format/typescript';

const diagnostic: ParseDiagnostic | undefined = parse('const =').errors[0];
```

### message

```ts
message: string
```

Human-readable diagnostic message from OXC.

The message is suitable for logs but should not be treated as a stable
machine-readable code.

```ts
import { parse } from 'fino:format/typescript';

const message = parse('const =').errors[0]?.message;
```

## ParseResult

```ts
interface ParseResult {
```

Complete parse result, including AST, comments, tokens, and diagnostics.

Syntax errors are reported through `ok: false` and `errors`; callers should
check `ok` before trusting the AST for semantic tooling.

```ts
import { parse, type ParseResult } from 'fino:format/typescript';

const result: ParseResult = parse('export const x = 1;');
if (result.ok) console.log(result.sourceType.moduleKind);
```

### ok

```ts
ok: boolean
```

Whether OXC parsed the source without diagnostics that mark failure.

`false` means inspect `errors`. The AST may be incomplete or unsuitable for
downstream transformations when parsing failed.

```ts
import { parse } from 'fino:format/typescript';

if (!parse('const =').ok) console.error('invalid source');
```

### ast

```ts
ast: any
```

Serialized ESTree-compatible AST from OXC.

The exact node shape follows the bundled OXC version. Treat this as parser
output, not as a stable schema guaranteed by Fino.

```ts
import { parse } from 'fino:format/typescript';

const ast = parse('const x = 1;').ast;
```

### comments

```ts
comments: ParseComment[]
```

Comments collected from the source.

Comments are always returned as an array, empty when none were found.

```ts
import { parse } from 'fino:format/typescript';

const comments = parse('// note\nconst x = 1;').comments;
```

### tokens

```ts
tokens: ParseToken[]
```

Lexer tokens collected from the source.

This array is empty unless `ParseOptions.tokens` is true.

```ts
import { parse } from 'fino:format/typescript';

const tokens = parse('const x = 1;', { tokens: true }).tokens;
```

### errors

```ts
errors: ParseDiagnostic[]
```

Parser diagnostics.

The array is empty on a clean parse. Diagnostics are returned rather than
thrown for normal syntax errors.

```ts
import { parse } from 'fino:format/typescript';

const errors = parse('const =').errors;
```

### sourceType

```ts
sourceType: { /** * Detected source language. * * TypeScript mode is selected for TypeScript, TSX, and declaration-file * inputs; JavaScript mode is selected for JS and JSX inputs. * * ```ts no_run * import { parse } from 'fino:format/typescript'; * * parse('const x: number = 1;', { sourceType: 'ts' }).sourceType.language; * ``` */ language: 'typescript' | 'javascript'; /** * Detected module mode. * * OXC reports whether the source is a module, script, unambiguous input, or * CommonJS-shaped source according to parser mode and syntax. * * ```ts no_run * import { parse } from 'fino:format/typescript'; * * parse('export const x = 1;').sourceType.moduleKind; * ``` */ moduleKind: 'module' | 'script' | 'unambiguous' | 'commonjs'; /** * Whether JSX syntax was enabled for the parse. * * This is true for JSX and TSX source modes. * * ```ts no_run * import { parse } from 'fino:format/typescript'; * * parse('const el = <div />;', { sourceType: 'tsx' }).sourceType.jsx; * ``` */ jsx: boolean; /** * Whether the source was parsed as a TypeScript declaration file. * * This is true for `dts` or definition-file modes inferred from filenames * such as `types.d.ts`. * * ```ts no_run * import { parse } from 'fino:format/typescript'; * * parse('declare const x: string;', { filename: 'types.d.ts' }).sourceType.typescriptDefinition; * ``` */ typescriptDefinition: boolean; }
```

Source mode detected or selected by OXC.

The nested object describes language, module mode, JSX support, and
declaration-file parsing. It is useful when `filename` inference was used.

```ts
import { parse } from 'fino:format/typescript';

const mode = parse('export {}', { filename: 'x.ts' }).sourceType;
```

## TranspileOptions

```ts
interface TranspileOptions {
```

Options controlling TypeScript-to-JavaScript transpilation.

These options select parser mode and source-map metadata. Transpilation does
not type-check the program or perform bundling.

```ts
import { transpile, type TranspileOptions } from 'fino:format/typescript';

const options: TranspileOptions = { filename: 'input.ts' };
transpile('const value: number = 1;', options);
```

### filename

```ts
filename?: string
```

Filename used for syntax-mode inference and source map metadata.

The file is not read from disk. Use this to get `.tsx` or `.d.ts` behavior
without passing `sourceType` directly.

```ts
import { transpile } from 'fino:format/typescript';

transpile('const x: number = 1;', { filename: 'example.ts' });
```

### sourceType

```ts
sourceType?: ParseOptions['sourceType']
```

Explicit source grammar. Defaults are inferred from `filename` when possible.

Use this for virtual source or when extension-based detection would choose
the wrong grammar.

```ts
import { transpile } from 'fino:format/typescript';

transpile('const el = <div />;', { sourceType: 'tsx' });
```

## TranspileResult

```ts
interface TranspileResult {
```

JavaScript output, source map text, and diagnostics from transpilation.

`code` and `map` are strings returned by OXC. Check `ok` before evaluating or
writing the output; failed transpilation may contain diagnostics and partial
output.

```ts
import { transpile, type TranspileResult } from 'fino:format/typescript';

const result: TranspileResult = transpile('const x: number = 1;', {
  sourceType: 'ts',
});
```

### ok

```ts
ok: boolean
```

Whether transpilation completed without failure diagnostics.

`false` means inspect `errors` before using `code`.

```ts
import { transpile } from 'fino:format/typescript';

const ok = transpile('const x: number = 1;', { sourceType: 'ts' }).ok;
```

### code

```ts
code: string
```

Transpiled JavaScript source code.

Type syntax is removed or lowered according to OXC's transformer behavior.
The result is not bundled or minified.

```ts
import { transpile } from 'fino:format/typescript';

const code = transpile('const x: number = 1;', { sourceType: 'ts' }).code;
```

### map

```ts
map: string
```

Source map text emitted by OXC.

The string may be empty when the native transformer does not emit a map for
the selected input and options.

```ts
import { transpile } from 'fino:format/typescript';

const map = transpile('const x: number = 1;', { filename: 'x.ts' }).map;
```

### errors

```ts
errors: ParseDiagnostic[]
```

Transpiler diagnostics.

The array is empty on success. Diagnostics use the same shape as parser
diagnostics and should not be treated as stable machine-readable codes.

```ts
import { transpile } from 'fino:format/typescript';

const errors = transpile('const =', { sourceType: 'ts' }).errors;
```

## parse

```ts
function parse(source: string, options: ParseOptions = {}): ParseResult
```

Parse JavaScript or TypeScript source with OXC.

Returns parser output and diagnostics without type-checking. Normal syntax
errors are represented by `ok: false`; bridge-level failures may still throw.

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

The native transformer removes TypeScript syntax and lowers supported syntax
according to OXC. It does not perform type-checking, module resolution, or
bundling. Check `ok` and `errors` before consuming `code`.

```ts
import { transpile } from 'fino:format/typescript';

const { code } = transpile('const x: number = 1;', { sourceType: 'ts' });
```
