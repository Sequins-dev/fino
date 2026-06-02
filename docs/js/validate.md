# validate

fino:validate — JSON Schema validation with fluent builders.

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

fino:validate — JSON Schema validation with fluent builders.

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

## ValidationIssue

```ts
interface ValidationIssue {
```

One validation failure at a concrete input path.

### path

```ts
path: string
```

Dotted path to the invalid value; empty string means the root value.

### message

```ts
message: string
```

Human-readable diagnostic.

### keyword

```ts
keyword: string
```

JSON Schema keyword or fino refinement that failed.

### value

```ts
value?: unknown
```

The received value, when useful for diagnostics.

## SafeParseSuccess

```ts
interface SafeParseSuccess<T = unknown> {
```

Successful `safeParse()` result.

### success

```ts
success: true
```

### value

```ts
value: T
```

Parsed value, including applied defaults.

## SafeParseFailure

```ts
interface SafeParseFailure {
```

Failed `safeParse()` result.

### success

```ts
success: false
```

### error

```ts
error: ValidationError
```

Error object containing the same issues.

### issues

```ts
issues: ValidationIssue[]
```

Individual validation issues.

## ValidationError

```ts
class ValidationError extends Error {
```

Error thrown by `parse()` when validation fails.

### issues

```ts
issues: ValidationIssue[]
```

All validation issues found during traversal.

### constructor

```ts
constructor(issues: ValidationIssue[])
```

## CompiledValidator

```ts
class CompiledValidator<T = unknown> {
```

Reusable compiled validator for a builder or raw JSON Schema object.

### constructor

```ts
constructor(schema: unknown)
```

Compile `schema` immediately.

### schema

```ts
get schema(): JsonSchema
```

Original canonical JSON Schema object used by this validator.

### parse

```ts
parse(value: unknown): T
```

Parse `value` and return the validated value.

Defaults are applied to missing values. Throws `ValidationError` when any
issue is found.

### safeParse

```ts
safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Parse `value` without throwing.

The success branch contains the parsed value. The failure branch contains a
`ValidationError` plus the issue array for direct inspection.

## SchemaBuilder

```ts
class SchemaBuilder<T = unknown> {
```

Base fluent builder.

The `schema` property is the actual JSON Schema object. Builder methods mutate
and return the same builder so users can fluently compose constraints while
still preserving direct JSON serialization.

### schema

```ts
schema: JsonSchema
```

### constructor

```ts
constructor(schema: JsonSchema, optional = false)
```

Create a builder around an existing JSON Schema object.

### toJSON

```ts
toJSON(): JsonSchema
```

Return the canonical JSON Schema object for JSON.stringify().

### parse

```ts
parse(value: unknown): T
```

Validate `value` with this schema and throw on failure.

### safeParse

```ts
safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Validate `value` with this schema and return a tagged result.

### optional

```ts
optional(): this
```

Mark this schema as optional when used as an object property.

### nullable

```ts
nullable(): SchemaBuilder<T | null>
```

Accept this schema or `null`.

### default

```ts
default(value: unknown): this
```

Apply this default when the input value is missing.

### refine

```ts
refine(fn: (value: T) => boolean, message = 'failed custom validation'): this
```

Attach a custom in-process refinement.

Refinements cannot be represented in JSON Schema. They are preserved on the
builder object for runtime validation, but they are intentionally omitted
when serialized with `toJSON()`.

## v

```ts
const v
```

Fluent builder namespace.

Every builder method returns a schema builder whose `toJSON()` result is a
JSON-Schema-shaped object. Raw JSON Schema objects can be mixed with builders
anywhere a child schema is accepted.

### any

```ts
any(): SchemaBuilder<unknown>
```

### string

```ts
string(): StringBuilder
```

### number

```ts
number(): NumberBuilder
```

### integer

```ts
integer(): NumberBuilder
```

### boolean

```ts
boolean(): SchemaBuilder<boolean>
```

### null

```ts
null(): SchemaBuilder<null>
```

### literal

```ts
literal(value: unknown): SchemaBuilder<unknown>
```

### enum

```ts
enum(values: unknown[]): SchemaBuilder<unknown>
```

### array

```ts
array(item: unknown): ArrayBuilder
```

### tuple

```ts
tuple(items: unknown[]): ArrayBuilder
```

### object

```ts
object
```

### union

```ts
union(items: unknown[]): SchemaBuilder<unknown>
```

## compile

```ts
function compile<T = unknown>(schema: unknown): CompiledValidator<T>
```

Compile a builder or raw JSON Schema object into a reusable validator.

## parse

```ts
function parse<T = unknown>(schema: unknown, value: unknown): T
```

Parse a value once with a builder or raw JSON Schema object.

## safeParse

```ts
function safeParse<T = unknown>(schema: unknown, value: unknown): SafeParseSuccess<T> | SafeParseFailure
```

Parse a value once and return a tagged result instead of throwing.
