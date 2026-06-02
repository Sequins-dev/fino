/**
 * fino:validate — JSON Schema validation with fluent builders.
 *
 * This module treats JSON Schema as the canonical schema representation. The
 * builder API is only a convenient way to construct JSON-Schema-shaped objects;
 * builders serialize directly with `toJSON()`, so they can be passed to
 * `JSON.stringify()` or stored on disk without a conversion step.
 *
 * Raw JSON Schema objects are accepted anywhere a builder is accepted. This is
 * intentional: applications can load schemas from disk, receive schemas from
 * tools, or build schemas fluently in code while using the same validator
 * pipeline.
 *
 * Validators are compiled into closure graphs. The implementation avoids
 * generated source and `eval`, but still avoids re-walking the schema metadata
 * for every input value.
 *
 * ```ts no_run
 * import { parse, v } from 'fino:validate';
 *
 * const schema = v.object({
 *   name: v.string().min(1),
 *   port: v.integer().min(1).max(65535).default(3000),
 * });
 *
 * const config = parse(schema, { name: 'api' });
 * JSON.stringify(schema); // valid JSON Schema
 * ```
 */

export type JsonSchema = Record<string, unknown>;

/** One validation failure at a concrete input path. */
export interface ValidationIssue {
  /** Dotted path to the invalid value; empty string means the root value. */
  path: string;
  /** Human-readable diagnostic. */
  message: string;
  /** JSON Schema keyword or fino refinement that failed. */
  keyword: string;
  /** The received value, when useful for diagnostics. */
  value?: unknown;
}

/** Successful `safeParse()` result. */
export interface SafeParseSuccess<T = unknown> {
  success: true;
  /** Parsed value, including applied defaults. */
  value: T;
}

/** Failed `safeParse()` result. */
export interface SafeParseFailure {
  success: false;
  /** Error object containing the same issues. */
  error: ValidationError;
  /** Individual validation issues. */
  issues: ValidationIssue[];
}

type ValidatorFn = (value: unknown, path: string) => { value: unknown; issues: ValidationIssue[] };
type Refinement = { fn: (value: unknown) => boolean; message: string };

const optionalSymbol = Symbol('fino.validate.optional');
const refinementsSymbol = Symbol('fino.validate.refinements');

/** Error thrown by `parse()` when validation fails. */
export class ValidationError extends Error {
  /** All validation issues found during traversal. */
  issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Validation failed: ${issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Schema and issue helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaOf(schema: unknown): JsonSchema {
  if (schema instanceof SchemaBuilder) return schema.schema;
  if (isRecord(schema)) return schema;
  throw new Error('Expected JSON Schema object');
}

function cloneDefault(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneDefault);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = cloneDefault((value as Record<string, unknown>)[key]);
  }
  return out;
}

function issue(path: string, keyword: string, message: string, value: unknown): ValidationIssue {
  return { path, keyword, message, value };
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function schemaType(schema: JsonSchema): string | undefined {
  const type = schema.type;
  return typeof type === 'string' ? type : undefined;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    default: return true;
  }
}

function formatMatches(value: string, format: string): boolean {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'url' || format === 'uri') {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Closure compiler
// ---------------------------------------------------------------------------

/**
 * Compile a JSON Schema node into a validator closure.
 *
 * Each closure captures preprocessed child validators, regexes, enum lists, and
 * refinements for its schema node. Runtime validation then walks only the input
 * value and the compiled closure graph.
 */
function compileSchema(schema: JsonSchema): ValidatorFn {
  const type = schemaType(schema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const propertyValidators = new Map<string, ValidatorFn>();
  for (const key of Object.keys(properties)) propertyValidators.set(key, compileSchema(schemaOf(properties[key])));
  const itemValidator = isRecord(schema.items) ? compileSchema(schema.items) : null;
  const prefixSchemas = Array.isArray(schema.prefixItems)
    ? schema.prefixItems.map((item) => compileSchema(schemaOf(item)))
    : Array.isArray(schema.items)
      ? schema.items.map((item) => compileSchema(schemaOf(item)))
      : null;
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf.map((item) => compileSchema(schemaOf(item))) : null;
  const refinements = ((schema as Record<symbol, unknown>)[refinementsSymbol] as Refinement[] | undefined) ?? [];
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern) : null;

  return function validateValue(input: unknown, path: string) {
    let value = input;
    const issues: ValidationIssue[] = [];

    if (value === undefined && Object.prototype.hasOwnProperty.call(schema, 'default')) {
      value = cloneDefault(schema.default);
    }

    if (anyOf !== null) {
      const branchIssues: ValidationIssue[] = [];
      for (const validateBranch of anyOf) {
        const result = validateBranch(value, path);
        if (result.issues.length === 0) return { value: result.value, issues: [] };
        branchIssues.push(...result.issues);
      }
      issues.push(issue(path, 'anyOf', 'must match at least one schema', value));
      return { value, issues: issues.concat(branchIssues.slice(0, 3)) };
    }

    if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
      issues.push(issue(path, 'const', `must equal ${JSON.stringify(schema.const)}`, value));
      return { value, issues };
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
      issues.push(issue(path, 'enum', `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`, value));
      return { value, issues };
    }

    if (type !== undefined && !typeMatches(value, type)) {
      issues.push(issue(path, 'type', `expected ${type}`, value));
      return { value, issues };
    }

    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(issue(path, 'minLength', `must be at least ${schema.minLength} characters`, value));
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(issue(path, 'maxLength', `must be at most ${schema.maxLength} characters`, value));
      if (pattern !== null && !pattern.test(value)) issues.push(issue(path, 'pattern', `must match pattern ${schema.pattern}`, value));
      if (typeof schema.format === 'string' && !formatMatches(value, schema.format)) issues.push(issue(path, 'format', `must match format ${schema.format}`, value));
    }

    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(issue(path, 'minimum', `must be >= ${schema.minimum}`, value));
      if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(issue(path, 'maximum', `must be <= ${schema.maximum}`, value));
    }

    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(issue(path, 'minItems', `must contain at least ${schema.minItems} items`, value));
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(issue(path, 'maxItems', `must contain at most ${schema.maxItems} items`, value));
      const out = value.slice();
      if (prefixSchemas !== null) {
        for (let i = 0; i < prefixSchemas.length; i++) {
          const result = prefixSchemas[i](out[i], childPath(path, i));
          out[i] = result.value;
          issues.push(...result.issues);
        }
        if (schema.maxItems === undefined && value.length > prefixSchemas.length) {
          issues.push(issue(path, 'maxItems', `must contain at most ${prefixSchemas.length} items`, value));
        }
      } else if (itemValidator !== null) {
        for (let i = 0; i < out.length; i++) {
          const result = itemValidator(out[i], childPath(path, i));
          out[i] = result.value;
          issues.push(...result.issues);
        }
      }
      value = out;
    }

    if (isRecord(value)) {
      const out: Record<string, unknown> = { ...value };
      for (const [key, validateProperty] of propertyValidators) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) {
          const propSchema = schemaOf(properties[key]);
          if (Object.prototype.hasOwnProperty.call(propSchema, 'default')) {
            const result = validateProperty(undefined, childPath(path, key));
            out[key] = result.value;
            issues.push(...result.issues);
            continue;
          }
          if (required.has(key)) issues.push(issue(childPath(path, key), 'required', 'is required', undefined));
          continue;
        }
        const result = validateProperty(out[key], childPath(path, key));
        out[key] = result.value;
        issues.push(...result.issues);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(out)) {
          if (!propertyValidators.has(key)) issues.push(issue(childPath(path, key), 'additionalProperties', 'is not allowed', out[key]));
        }
      }
      value = out;
    }

    for (const refinement of refinements) {
      if (!refinement.fn(value)) issues.push(issue(path, 'refine', refinement.message, value));
    }

    return { value, issues };
  };
}

// ---------------------------------------------------------------------------
// Public validator wrapper
// ---------------------------------------------------------------------------

/** Reusable compiled validator for a builder or raw JSON Schema object. */
export class CompiledValidator<T = unknown> {
  #schema: JsonSchema;
  #validate: ValidatorFn;

  /** Compile `schema` immediately. */
  constructor(schema: unknown) {
    this.#schema = schemaOf(schema);
    this.#validate = compileSchema(this.#schema);
  }

  /** Original canonical JSON Schema object used by this validator. */
  get schema(): JsonSchema {
    return this.#schema;
  }

  /**
   * Parse `value` and return the validated value.
   *
   * Defaults are applied to missing values. Throws `ValidationError` when any
   * issue is found.
   */
  parse(value: unknown): T {
    const result = this.#validate(value, '');
    if (result.issues.length > 0) throw new ValidationError(result.issues);
    return result.value as T;
  }

  /**
   * Parse `value` without throwing.
   *
   * The success branch contains the parsed value. The failure branch contains a
   * `ValidationError` plus the issue array for direct inspection.
   */
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure {
    const result = this.#validate(value, '');
    if (result.issues.length === 0) return { success: true, value: result.value as T };
    const error = new ValidationError(result.issues);
    return { success: false, error, issues: result.issues };
  }
}

// ---------------------------------------------------------------------------
// Fluent JSON Schema builders
// ---------------------------------------------------------------------------

/**
 * Base fluent builder.
 *
 * The `schema` property is the actual JSON Schema object. Builder methods mutate
 * and return the same builder so users can fluently compose constraints while
 * still preserving direct JSON serialization.
 */
export class SchemaBuilder<T = unknown> {
  schema: JsonSchema;

  /** Create a builder around an existing JSON Schema object. */
  constructor(schema: JsonSchema, optional = false) {
    this.schema = schema;
    if (optional) Object.defineProperty(this.schema, optionalSymbol, { value: true, configurable: true });
  }

  /** Return the canonical JSON Schema object for JSON.stringify(). */
  toJSON(): JsonSchema {
    return this.schema;
  }

  /** Validate `value` with this schema and throw on failure. */
  parse(value: unknown): T {
    return parse<T>(this, value);
  }

  /** Validate `value` with this schema and return a tagged result. */
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure {
    return safeParse<T>(this, value);
  }

  /** Mark this schema as optional when used as an object property. */
  optional(): this {
    Object.defineProperty(this.schema, optionalSymbol, { value: true, configurable: true });
    return this;
  }

  /** Accept this schema or `null`. */
  nullable(): SchemaBuilder<T | null> {
    return new SchemaBuilder<T | null>({ anyOf: [this.schema, { type: 'null' }] });
  }

  /** Apply this default when the input value is missing. */
  default(value: unknown): this {
    this.schema.default = value;
    return this;
  }

  /**
   * Attach a custom in-process refinement.
   *
   * Refinements cannot be represented in JSON Schema. They are preserved on the
   * builder object for runtime validation, but they are intentionally omitted
   * when serialized with `toJSON()`.
   */
  refine(fn: (value: T) => boolean, message = 'failed custom validation'): this {
    const refinements = ((this.schema as Record<symbol, unknown>)[refinementsSymbol] as Refinement[] | undefined) ?? [];
    refinements.push({ fn: fn as (value: unknown) => boolean, message });
    Object.defineProperty(this.schema, refinementsSymbol, { value: refinements, configurable: true });
    return this;
  }
}

/** String schema builder. */
class StringBuilder extends SchemaBuilder<string> {
  min(n: number): this { this.schema.minLength = n; return this; }
  max(n: number): this { this.schema.maxLength = n; return this; }
  length(n: number): this { this.schema.minLength = n; this.schema.maxLength = n; return this; }
  pattern(pattern: string | RegExp): this { this.schema.pattern = pattern instanceof RegExp ? pattern.source : pattern; return this; }
  format(format: string): this { this.schema.format = format; return this; }
}

/** Number and integer schema builder. */
class NumberBuilder extends SchemaBuilder<number> {
  min(n: number): this { this.schema.minimum = n; return this; }
  max(n: number): this { this.schema.maximum = n; return this; }
}

/** Array and tuple schema builder. */
class ArrayBuilder extends SchemaBuilder<unknown[]> {
  min(n: number): this { this.schema.minItems = n; return this; }
  max(n: number): this { this.schema.maxItems = n; return this; }
}

/** Object schema builder. */
class ObjectBuilder extends SchemaBuilder<Record<string, unknown>> {
  additionalProperties(value: boolean | JsonSchema): this {
    this.schema.additionalProperties = value;
    return this;
  }
}

function isOptional(schema: unknown): boolean {
  const actual = schemaOf(schema);
  return (actual as Record<symbol, unknown>)[optionalSymbol] === true;
}

function object(shape: Record<string, unknown>): ObjectBuilder {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape)) {
    properties[key] = schemaOf(shape[key]);
    if (!isOptional(shape[key])) required.push(key);
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return new ObjectBuilder(schema);
}

/**
 * Fluent builder namespace.
 *
 * Every builder method returns a schema builder whose `toJSON()` result is a
 * JSON-Schema-shaped object. Raw JSON Schema objects can be mixed with builders
 * anywhere a child schema is accepted.
 */
export const v = {
  any(): SchemaBuilder<unknown> { return new SchemaBuilder({}); },
  string(): StringBuilder { return new StringBuilder({ type: 'string' }); },
  number(): NumberBuilder { return new NumberBuilder({ type: 'number' }); },
  integer(): NumberBuilder { return new NumberBuilder({ type: 'integer' }); },
  boolean(): SchemaBuilder<boolean> { return new SchemaBuilder({ type: 'boolean' }); },
  null(): SchemaBuilder<null> { return new SchemaBuilder({ type: 'null' }); },
  literal(value: unknown): SchemaBuilder<unknown> { return new SchemaBuilder({ const: value }); },
  enum(values: unknown[]): SchemaBuilder<unknown> { return new SchemaBuilder({ enum: values.slice() }); },
  array(item: unknown): ArrayBuilder { return new ArrayBuilder({ type: 'array', items: schemaOf(item) }); },
  tuple(items: unknown[]): ArrayBuilder { return new ArrayBuilder({ type: 'array', prefixItems: items.map(schemaOf), minItems: items.length, maxItems: items.length }); },
  object,
  union(items: unknown[]): SchemaBuilder<unknown> { return new SchemaBuilder({ anyOf: items.map(schemaOf) }); },
};

/** Compile a builder or raw JSON Schema object into a reusable validator. */
export function compile<T = unknown>(schema: unknown): CompiledValidator<T> {
  return new CompiledValidator<T>(schema);
}

/** Parse a value once with a builder or raw JSON Schema object. */
export function parse<T = unknown>(schema: unknown, value: unknown): T {
  return compile<T>(schema).parse(value);
}

/** Parse a value once and return a tagged result instead of throwing. */
export function safeParse<T = unknown>(schema: unknown, value: unknown): SafeParseSuccess<T> | SafeParseFailure {
  return compile<T>(schema).safeParse(value);
}
