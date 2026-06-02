# validate

fino:validate - JSON Schema validation with fluent builders.

This module treats JSON Schema as the canonical schema representation. The
builder API is only a convenient way to construct JSON-Schema-shaped objects;
builders serialize directly with `toJSON()`, so they can be passed to
`JSON.stringify()` or stored on disk without a conversion step.

Raw JSON Schema objects are accepted anywhere a builder is accepted. This is
intentional: applications can load schemas from disk, receive schemas from
tools, or build schemas fluently in code while using the same validator
pipeline.

Validators are compiled into closure graphs. The implementation avoids
generated source and `eval`, but still avoids re-walking the schema metadata
for every input value.

```ts
import { parse, v } from 'fino:validate';

const schema = v.object({
  name: v.string().min(1),
  port: v.integer().min(1).max(65535).default(3000),
});

const config = parse(schema, { name: 'api' });
JSON.stringify(schema); // valid JSON Schema
```

## JsonSchema

```ts
type JsonSchema = Record<string, unknown>
```

JSON-Schema-shaped object accepted by validators and builders.

This type is intentionally broad because callers can pass raw JSON Schema
objects or builder output. Unsupported JSON Schema keywords are preserved in
the object but ignored by this validator.

```ts
import type { JsonSchema } from 'fino:validate';

const schema: JsonSchema = { type: 'string', minLength: 1 };
```

## ValidationIssue

```ts
interface ValidationIssue {
```

One validation failure at a concrete input path.

Issues are collected during traversal and attached to `ValidationError`.
`safeParse()` also exposes the array directly for callers that do not want to
inspect the error object.

```ts
import type { ValidationIssue } from 'fino:validate';

const issue: ValidationIssue = { path: 'name', keyword: 'minLength', message: 'too short' };
```

### path

```ts
path: string
```

Dotted path to the invalid value; empty string means the root value.

Array indexes use bracket notation, such as `items[0]`.

```ts
import type { ValidationIssue } from 'fino:validate';

const issue: ValidationIssue = { path: 'items[0]', keyword: 'type', message: 'expected string' };
```

### message

```ts
message: string
```

Human-readable diagnostic.

Messages are intended for developer diagnostics and simple application
errors; localize or rewrite them before exposing them in user-facing UI.

```ts
import type { ValidationIssue } from 'fino:validate';

const issue: ValidationIssue = { path: 'age', keyword: 'minimum', message: 'must be >= 18' };
```

### keyword

```ts
keyword: string
```

JSON Schema keyword or fino refinement that failed.

Examples include `type`, `required`, `minimum`, `anyOf`, and `refine`.

```ts
import type { ValidationIssue } from 'fino:validate';

const issue: ValidationIssue = { path: '', keyword: 'required', message: 'is required' };
```

### value

```ts
value?: unknown
```

The received value, when useful for diagnostics.

Some issues omit this field, such as missing required properties where the
value is `undefined`.

```ts
import type { ValidationIssue } from 'fino:validate';

const issue: ValidationIssue = { path: 'enabled', keyword: 'type', message: 'expected boolean', value: 'yes' };
```

## SafeParseSuccess

```ts
interface SafeParseSuccess<T = unknown> {
```

Successful `safeParse()` result.

The discriminant is `success: true`; `value` contains the parsed value with
defaults applied.

```ts
import type { SafeParseSuccess } from 'fino:validate';

const result: SafeParseSuccess<string> = { success: true, value: 'ok' };
```

### success

```ts
success: true
```

Success discriminant.

Use it to narrow the union returned by `safeParse()`.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse(v.string(), 'ok');
if (result.success) result.value.toUpperCase();
```

### value

```ts
value: T
```

Parsed value, including applied defaults.

The value may be cloned for defaulted objects and arrays so callers can
mutate it without changing the schema default.

```ts
import type { SafeParseSuccess } from 'fino:validate';

const result: SafeParseSuccess<number> = { success: true, value: 42 };
```

## SafeParseFailure

```ts
interface SafeParseFailure {
```

Failed `safeParse()` result.

The discriminant is `success: false`; `error` and `issues` describe all
validation failures found during traversal.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse(v.integer(), 'nope');
if (!result.success) result.issues;
```

### success

```ts
success: false
```

Failure discriminant.

Use it to narrow the union returned by `safeParse()`.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse(v.boolean(), 'yes');
if (!result.success) result.error.message;
```

### error

```ts
error: ValidationError
```

Error object containing the same issues.

This is the same error shape thrown by `parse()`.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse(v.number(), 'x');
if (!result.success) result.error.issues;
```

### issues

```ts
issues: ValidationIssue[]
```

Individual validation issues.

The array is exposed directly so callers can inspect failures without
touching the error object.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse(v.string().min(2), 'a');
if (!result.success) result.issues[0]?.keyword;
```

## ValidationError

```ts
class ValidationError extends Error {
```

Error thrown by `parse()` when validation fails.

The message summarizes all issues as `path: message` pairs. Use the `issues`
property for structured handling. `safeParse()` returns this error instead of
throwing it.

```ts
import { ValidationError, parse, v } from 'fino:validate';

try {
  parse(v.string(), 123);
} catch (error) {
  if (error instanceof ValidationError) error.issues;
}
```

### issues

```ts
issues: ValidationIssue[]
```

All validation issues found during traversal.

The array is stored as provided to the constructor and is not deep-cloned.

```ts
import { ValidationError } from 'fino:validate';

const error = new ValidationError([{ path: '', keyword: 'type', message: 'expected string' }]);
error.issues;
```

### constructor

```ts
constructor(issues: ValidationIssue[])
```

Create a validation error from collected issues.

The error name is set to `ValidationError`, and the message is built from
the issue paths and messages. An empty issue array creates a valid error
object but is not produced by the parser.

```ts
import { ValidationError } from 'fino:validate';

const error = new ValidationError([{ path: 'name', keyword: 'required', message: 'is required' }]);
```

## CompiledValidator

```ts
class CompiledValidator<T = unknown> {
```

Reusable compiled validator for a builder or raw JSON Schema object.

The constructor compiles the schema once into closure-based validators. Reuse
instances for repeated parsing of the same schema to avoid recompilation.

```ts
import { CompiledValidator, v } from 'fino:validate';

const validator = new CompiledValidator<string>(v.string().min(1));
const value = validator.parse('ok');
```

### constructor

```ts
constructor(schema: unknown)
```

Compile `schema` immediately.

Accepts a `SchemaBuilder` or raw JSON Schema object. Non-object schemas
throw `Error`. The compiled validator keeps a reference to the schema
object, so avoid mutating builders after compiling them.

```ts
import { CompiledValidator, v } from 'fino:validate';

const validator = new CompiledValidator<number>(v.integer().min(1));
```

### schema

```ts
get schema(): JsonSchema
```

Original canonical JSON Schema object used by this validator.

The returned object is the same object captured during construction, not a
clone. Mutating it after compilation does not rebuild the closure graph.

```ts
import { compile, v } from 'fino:validate';

const validator = compile(v.string());
const schema = validator.schema;
```

### parse

```ts
parse(value: unknown): T
```

Parse `value` and return the validated value.

Defaults are applied to missing values. Throws `ValidationError` when any
issue is found.

```ts
import { compile, v } from 'fino:validate';

const validator = compile<string>(v.string().min(1));
const value = validator.parse('name');
```

### safeParse

```ts
safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Parse `value` without throwing.

The success branch contains the parsed value. The failure branch contains a
`ValidationError` plus the issue array for direct inspection.

```ts
import { compile, v } from 'fino:validate';

const validator = compile<number>(v.number());
const result = validator.safeParse('nope');
```

## SchemaBuilder

```ts
class SchemaBuilder<T = unknown> {
```

Base fluent builder.

The `schema` property is the actual JSON Schema object. Builder methods mutate
and return the same builder so users can fluently compose constraints while
still preserving direct JSON serialization.

```ts
const documentedClass = 'SchemaBuilder';
console.log(documentedClass);
```

### schema

```ts
schema: JsonSchema
```

Mutable JSON Schema object represented by this builder.

Builder methods update this object and return the same builder. It can be
passed anywhere a raw JSON Schema object is accepted.

```ts
import { v } from 'fino:validate';

const schema = v.string().schema;
```

### constructor

```ts
constructor(schema: JsonSchema, optional = false)
```

Create a builder around an existing JSON Schema object.

`optional` marks the schema as optional when it is used in `v.object()`.
The marker is stored as a non-enumerable symbol and is not emitted by
`JSON.stringify()`.

```ts
import { SchemaBuilder } from 'fino:validate';

const builder = new SchemaBuilder<string>({ type: 'string' });
```

### toJSON

```ts
toJSON(): JsonSchema
```

Return the canonical JSON Schema object for `JSON.stringify()`.

Custom refinements and optional markers are non-enumerable symbol metadata,
so they are intentionally omitted from serialized JSON Schema.

```ts
import { v } from 'fino:validate';

const json = JSON.stringify(v.string().min(1).toJSON());
```

### parse

```ts
parse(value: unknown): T
```

Validate `value` with this schema and throw on failure.

This compiles the builder for the call, applies defaults, and returns the
parsed value. Validation failures throw `ValidationError`.

```ts
import { v } from 'fino:validate';

const value = v.integer().min(1).parse(3);
```

### safeParse

```ts
safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Validate `value` with this schema and return a tagged result.

This compiles the builder for the call. Success returns `{ success: true,
value }`; failure returns `{ success: false, error, issues }`.

```ts
import { v } from 'fino:validate';

const result = v.string().safeParse(123);
```

### optional

```ts
optional(): this
```

Mark this schema as optional when used as an object property.

Optional properties are omitted from the generated `required` array in
`v.object()`. The method mutates and returns the same builder.

```ts
import { v } from 'fino:validate';

const schema = v.object({ nickname: v.string().optional() });
```

### nullable

```ts
nullable(): SchemaBuilder<T | null>
```

Accept this schema or `null`.

Returns a new builder using `anyOf` with the current schema and
`{ type: 'null' }`. The original builder is not marked optional.

```ts
import { v } from 'fino:validate';

const schema = v.string().nullable();
```

### default

```ts
default(value: unknown): this
```

Apply this default when the input value is missing.

Defaults are used when the input is `undefined`; object and array defaults
are recursively cloned before returning parsed output.

```ts
import { v } from 'fino:validate';

const schema = v.integer().default(3000);
```

### refine

```ts
refine(fn: (value: T) => boolean, message = 'failed custom validation'): this
```

Attach a custom in-process refinement.

Refinements cannot be represented in JSON Schema. They are preserved on the
builder object for runtime validation, but they are intentionally omitted
when serialized with `toJSON()`.

```ts
import { v } from 'fino:validate';

const schema = v.string().refine((value) => value.startsWith('x-'), 'must start with x-');
```

## v

```ts
const v
```

Fluent builder namespace.

Every builder method returns a schema builder whose `toJSON()` result is a
JSON-Schema-shaped object. Raw JSON Schema objects can be mixed with builders
anywhere a child schema is accepted.

```ts
const documentedMember = 'v';
console.log(documentedMember);
```

### any

```ts
any(): SchemaBuilder<unknown>
```

Create a schema that accepts any value.

The generated schema is `{}` and performs no validation unless refinements
are added. Defaults and optional markers can still be applied.

```ts
import { v } from 'fino:validate';

const schema = v.any();
```

### string

```ts
string(): StringBuilder
```

Create a string schema builder.

The validator accepts JavaScript strings and can enforce length, pattern,
and recognized format constraints.

```ts
import { v } from 'fino:validate';

const schema = v.string().min(1);
```

### number

```ts
number(): NumberBuilder
```

Create a finite number schema builder.

The validator accepts finite JavaScript numbers and rejects `NaN` and
infinities through the `type` check.

```ts
import { v } from 'fino:validate';

const schema = v.number().min(0);
```

### integer

```ts
integer(): NumberBuilder
```

Create an integer schema builder.

The validator uses `Number.isInteger()` and can enforce numeric bounds.

```ts
import { v } from 'fino:validate';

const schema = v.integer().min(1);
```

### boolean

```ts
boolean(): SchemaBuilder<boolean>
```

Create a boolean schema builder.

The validator accepts only `true` and `false`.

```ts
import { v } from 'fino:validate';

const schema = v.boolean();
```

### null

```ts
null(): SchemaBuilder<null>
```

Create a null schema builder.

The validator accepts only `null`.

```ts
import { v } from 'fino:validate';

const schema = v.null();
```

### literal

```ts
literal(value: unknown): SchemaBuilder<unknown>
```

Create a schema that accepts exactly one literal value.

The value is stored as JSON Schema `const` and compared with strict
equality during validation.

```ts
import { v } from 'fino:validate';

const schema = v.literal('ready');
```

### enum

```ts
enum(values: unknown[]): SchemaBuilder<unknown>
```

Create a schema that accepts one of the provided values.

Values are copied into JSON Schema `enum` with `slice()`. Validation uses
strict equality against each enum member.

```ts
import { v } from 'fino:validate';

const schema = v.enum(['small', 'medium', 'large']);
```

### array

```ts
array(item: unknown): ArrayBuilder
```

Create an array schema with one item schema for all elements.

`item` may be a builder or raw JSON Schema object. Defaults in item schemas
are applied per array element during validation.

```ts
import { v } from 'fino:validate';

const schema = v.array(v.string()).min(1);
```

### tuple

```ts
tuple(items: unknown[]): ArrayBuilder
```

Create a fixed-length tuple schema.

The generated schema uses `prefixItems`, `minItems`, and `maxItems` set to
the tuple length. Each item may be a builder or raw JSON Schema object.

```ts
import { v } from 'fino:validate';

const schema = v.tuple([v.string(), v.integer()]);
```

### object

```ts
object
```

Create an object schema from a property shape.

Builder properties are required by default. Mark a property builder with
`optional()` to omit it from the generated `required` array.

```ts
import { v } from 'fino:validate';

const schema = v.object({ name: v.string(), nickname: v.string().optional() });
```

### union

```ts
union(items: unknown[]): SchemaBuilder<unknown>
```

Create a union schema from several alternatives.

The generated schema uses `anyOf`. Validation succeeds with the first
branch that has no issues; otherwise the result includes an `anyOf` issue
and a small sample of branch issues.

```ts
import { v } from 'fino:validate';

const schema = v.union([v.string(), v.number()]);
```

## compile

```ts
function compile<T = unknown>(schema: unknown): CompiledValidator<T>
```

Compile a builder or raw JSON Schema object into a reusable validator.

Use this when validating many values with the same schema. Non-object schemas
throw `Error`; validation failures occur later when calling `parse()` or
`safeParse()` on the returned validator.

```ts
import { compile, v } from 'fino:validate';

const validator = compile<{ name: string }>(v.object({ name: v.string() }));
```

## parse

```ts
function parse<T = unknown>(schema: unknown, value: unknown): T
```

Parse a value once with a builder or raw JSON Schema object.

This compiles the schema for the call, applies defaults, and returns the
parsed value. Validation failures throw `ValidationError`.

```ts
import { parse, v } from 'fino:validate';

const value = parse<string>(v.string().min(1), 'ok');
```

## safeParse

```ts
function safeParse<T = unknown>(schema: unknown, value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Parse a value once and return a tagged result instead of throwing.

This compiles the schema for the call. Success returns `{ success: true,
value }`; failure returns `{ success: false, error, issues }`.

```ts
import { safeParse, v } from 'fino:validate';

const result = safeParse<number>(v.integer(), 'not an integer');
```
