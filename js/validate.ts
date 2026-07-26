/**
 * fino:validate - JSON Schema validation with fluent builders.
 *
 * JSON Schema specification: https://json-schema.org/specification
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
 * The supported JSON Schema subset is intentionally small and runtime-focused:
 * `type`, `const`, `enum`, `properties`, `required`, `additionalProperties`,
 * `items`, `prefixItems`, `anyOf`, string length/pattern/format constraints,
 * numeric minimum/maximum, and array length constraints. Unknown keywords are
 * preserved on schemas for tooling compatibility but ignored by validation.
 * Supported string formats are `email`, `url`, and `uri`.
 *
 * This is not a full JSON Schema implementation. `$ref`, `$defs`,
 * `definitions`, `oneOf`, `allOf`, `not`, pattern-property/dependency
 * keywords, unevaluated keywords, and unknown string formats are not resolved
 * or enforced in this release. Validate schemas with a full JSON Schema engine
 * first when unsupported keywords should be treated as application errors.
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
/**
 * JSON-Schema-shaped object accepted by validators and builders.
 *
 * This type is intentionally broad because callers can pass raw JSON Schema
 * objects or builder output. Unsupported JSON Schema keywords are preserved in
 * the object but ignored by this validator.
 *
 * ```ts no_run
 * import type { JsonSchema } from 'fino:validate';
 *
 * const schema: JsonSchema = { type: 'string', minLength: 1 };
 * ```
 */
export type JsonSchema = Record<string, unknown>;
/**
 * One validation failure at a concrete input path.
 *
 * Issues are collected during traversal and attached to `ValidationError`.
 * `safeParse()` also exposes the array directly for callers that do not want to
 * inspect the error object.
 *
 * ```ts no_run
 * import type { ValidationIssue } from 'fino:validate';
 *
 * const issue: ValidationIssue = { path: 'name', keyword: 'minLength', message: 'too short' };
 * ```
 */
export interface ValidationIssue {
  /**
   * Dotted path to the invalid value; empty string means the root value.
   *
   * Array indexes use bracket notation, such as `items[0]`.
   *
   * ```ts no_run
   * import type { ValidationIssue } from 'fino:validate';
   *
   * const issue: ValidationIssue = { path: 'items[0]', keyword: 'type', message: 'expected string' };
   * ```
   */
  path: string;
  /**
   * Human-readable diagnostic.
   *
   * Messages are intended for developer diagnostics and simple application
   * errors; localize or rewrite them before exposing them in user-facing UI.
   *
   * ```ts no_run
   * import type { ValidationIssue } from 'fino:validate';
   *
   * const issue: ValidationIssue = { path: 'age', keyword: 'minimum', message: 'must be >= 18' };
   * ```
   */
  message: string;
  /**
   * JSON Schema keyword or fino refinement that failed.
   *
   * Examples include `type`, `required`, `minimum`, `anyOf`, and `refine`.
   *
   * ```ts no_run
   * import type { ValidationIssue } from 'fino:validate';
   *
   * const issue: ValidationIssue = { path: '', keyword: 'required', message: 'is required' };
   * ```
   */
  keyword: string;
  /**
   * The received value, when useful for diagnostics.
   *
   * Some issues omit this field, such as missing required properties where the
   * value is `undefined`.
   *
   * ```ts no_run
   * import type { ValidationIssue } from 'fino:validate';
   *
   * const issue: ValidationIssue = { path: 'enabled', keyword: 'type', message: 'expected boolean', value: 'yes' };
   * ```
   */
  value?: unknown;
}
/**
 * Successful `safeParse()` result.
 *
 * The discriminant is `success: true`; `value` contains the parsed value with
 * defaults applied.
 *
 * ```ts no_run
 * import type { SafeParseSuccess } from 'fino:validate';
 *
 * const result: SafeParseSuccess<string> = { success: true, value: 'ok' };
 * ```
 */
export interface SafeParseSuccess<T = unknown> {
  /**
   * Success discriminant.
   *
   * Use it to narrow the union returned by `safeParse()`.
   *
   * ```ts no_run
   * import { safeParse, v } from 'fino:validate';
   *
   * const result = safeParse(v.string(), 'ok');
   * if (result.success) result.value.toUpperCase();
   * ```
   */
  success: true;
  /**
   * Parsed value, including applied defaults.
   *
   * The value may be cloned for defaulted objects and arrays so callers can
   * mutate it without changing the schema default.
   *
   * ```ts no_run
   * import type { SafeParseSuccess } from 'fino:validate';
   *
   * const result: SafeParseSuccess<number> = { success: true, value: 42 };
   * ```
   */
  value: T;
}
/**
 * Failed `safeParse()` result.
 *
 * The discriminant is `success: false`; `error` and `issues` describe all
 * validation failures found during traversal.
 *
 * ```ts no_run
 * import { safeParse, v } from 'fino:validate';
 *
 * const result = safeParse(v.integer(), 'nope');
 * if (!result.success) result.issues;
 * ```
 */
export interface SafeParseFailure {
  /**
   * Failure discriminant.
   *
   * Use it to narrow the union returned by `safeParse()`.
   *
   * ```ts no_run
   * import { safeParse, v } from 'fino:validate';
   *
   * const result = safeParse(v.boolean(), 'yes');
   * if (!result.success) result.error.message;
   * ```
   */
  success: false;
  /**
   * Error object containing the same issues.
   *
   * This is the same error shape thrown by `parse()`.
   *
   * ```ts no_run
   * import { safeParse, v } from 'fino:validate';
   *
   * const result = safeParse(v.number(), 'x');
   * if (!result.success) result.error.issues;
   * ```
   */
  error: ValidationError;
  /**
   * Individual validation issues.
   *
   * The array is exposed directly so callers can inspect failures without
   * touching the error object.
   *
   * ```ts no_run
   * import { safeParse, v } from 'fino:validate';
   *
   * const result = safeParse(v.string().min(2), 'a');
   * if (!result.success) result.issues[0]?.keyword;
   * ```
   */
  issues: ValidationIssue[];
}
type ValidatorFn = (
  value: unknown,
  path: string,
) => {
  value: unknown;
  issues: ValidationIssue[];
};
type Refinement = {
  fn: (value: unknown) => boolean;
  message: string;
};
const optionalSymbol = Symbol('fino.validate.optional');
const refinementsSymbol = Symbol('fino.validate.refinements');
/**
 * Error thrown by `parse()` when validation fails.
 *
 * The message summarizes all issues as `path: message` pairs. Use the `issues`
 * property for structured handling. `safeParse()` returns this error instead of
 * throwing it.
 *
 * ```ts no_run
 * import { ValidationError, parse, v } from 'fino:validate';
 *
 * try {
 *   parse(v.string(), 123);
 * } catch (error) {
 *   if (error instanceof ValidationError) error.issues;
 * }
 * ```
 */
export class ValidationError extends Error {
  /**
   * All validation issues found during traversal.
   *
   * The array is stored as provided to the constructor and is not deep-cloned.
   *
   * ```ts no_run
   * import { ValidationError } from 'fino:validate';
   *
   * const error = new ValidationError([{ path: '', keyword: 'type', message: 'expected string' }]);
   * error.issues;
   * ```
   */
  issues: ValidationIssue[];
  /**
   * Create a validation error from collected issues.
   *
   * The error name is set to `ValidationError`, and the message is built from
   * the issue paths and messages. An empty issue array creates a valid error
   * object but is not produced by the parser.
   *
   * ```ts no_run
   * import { ValidationError } from 'fino:validate';
   *
   * const error = new ValidationError([{ path: 'name', keyword: 'required', message: 'is required' }]);
   * ```
   */
  constructor(issues: ValidationIssue[]) {
    super(
      `Validation failed: ${issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ')}`,
    );
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
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !jsonEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}
function issue(path: string, keyword: string, message: string, value: unknown): ValidationIssue {
  return {
    path,
    keyword,
    message,
    value,
  };
}
function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}
function schemaType(schema: JsonSchema): string | string[] | undefined {
  const type = schema.type;
  if (Array.isArray(type) && type.every((item) => typeof item === 'string')) return type;
  return typeof type === 'string' ? type : undefined;
}
function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true;
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
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.map(String))
    : new Set<string>();
  const propertyValidators = new Map<string, ValidatorFn>();
  for (const key of Object.keys(properties))
    propertyValidators.set(key, compileSchema(schemaOf(properties[key])));
  const itemValidator = isRecord(schema.items) ? compileSchema(schema.items) : null;
  const prefixSchemas = Array.isArray(schema.prefixItems)
    ? schema.prefixItems.map((item) => compileSchema(schemaOf(item)))
    : Array.isArray(schema.items)
      ? schema.items.map((item) => compileSchema(schemaOf(item)))
      : null;
  const additionalPropertyValidator = isRecord(schema.additionalProperties)
    ? compileSchema(schema.additionalProperties)
    : null;
  const anyOf = Array.isArray(schema.anyOf)
    ? schema.anyOf.map((item) => compileSchema(schemaOf(item)))
    : null;
  const refinements =
    ((schema as Record<symbol, unknown>)[refinementsSymbol] as Refinement[] | undefined) ?? [];
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
        if (result.issues.length === 0)
          return {
            value: result.value,
            issues: [],
          };
        branchIssues.push(...result.issues);
      }
      issues.push(issue(path, 'anyOf', 'must match at least one schema', value));
      return {
        value,
        issues: issues.concat(branchIssues.slice(0, 3)),
      };
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const') && !jsonEqual(value, schema.const)) {
      issues.push(issue(path, 'const', `must equal ${JSON.stringify(schema.const)}`, value));
      return {
        value,
        issues,
      };
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonEqual(item, value))) {
      issues.push(
        issue(
          path,
          'enum',
          `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`,
          value,
        ),
      );
      return {
        value,
        issues,
      };
    }
    if (
      type !== undefined &&
      !(Array.isArray(type)
        ? type.some((item) => typeMatches(value, item))
        : typeMatches(value, type))
    ) {
      issues.push(
        issue(path, 'type', `expected ${Array.isArray(type) ? type.join(' or ') : type}`, value),
      );
      return {
        value,
        issues,
      };
    }
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength)
        issues.push(
          issue(path, 'minLength', `must be at least ${schema.minLength} characters`, value),
        );
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
        issues.push(
          issue(path, 'maxLength', `must be at most ${schema.maxLength} characters`, value),
        );
      if (pattern !== null && !pattern.test(value))
        issues.push(issue(path, 'pattern', `must match pattern ${schema.pattern}`, value));
      if (typeof schema.format === 'string' && !formatMatches(value, schema.format))
        issues.push(issue(path, 'format', `must match format ${schema.format}`, value));
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum)
        issues.push(issue(path, 'minimum', `must be >= ${schema.minimum}`, value));
      if (typeof schema.maximum === 'number' && value > schema.maximum)
        issues.push(issue(path, 'maximum', `must be <= ${schema.maximum}`, value));
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems)
        issues.push(
          issue(path, 'minItems', `must contain at least ${schema.minItems} items`, value),
        );
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
        issues.push(
          issue(path, 'maxItems', `must contain at most ${schema.maxItems} items`, value),
        );
      const out = value.slice();
      if (prefixSchemas !== null) {
        for (let i = 0; i < prefixSchemas.length; i++) {
          const result = prefixSchemas[i](out[i], childPath(path, i));
          out[i] = result.value;
          issues.push(...result.issues);
        }
        if (schema.maxItems === undefined && value.length > prefixSchemas.length) {
          issues.push(
            issue(path, 'maxItems', `must contain at most ${prefixSchemas.length} items`, value),
          );
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
          if (required.has(key))
            issues.push(issue(childPath(path, key), 'required', 'is required', undefined));
          continue;
        }
        const result = validateProperty(out[key], childPath(path, key));
        out[key] = result.value;
        issues.push(...result.issues);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(out)) {
          if (!propertyValidators.has(key))
            issues.push(
              issue(childPath(path, key), 'additionalProperties', 'is not allowed', out[key]),
            );
        }
      } else if (additionalPropertyValidator !== null) {
        for (const key of Object.keys(out)) {
          if (propertyValidators.has(key)) continue;
          const result = additionalPropertyValidator(out[key], childPath(path, key));
          out[key] = result.value;
          issues.push(...result.issues);
        }
      }
      value = out;
    }
    for (const refinement of refinements) {
      if (!refinement.fn(value)) issues.push(issue(path, 'refine', refinement.message, value));
    }
    return {
      value,
      issues,
    };
  };
}
// ---------------------------------------------------------------------------
// Public validator wrapper
// ---------------------------------------------------------------------------
/**
 * Reusable compiled validator for a builder or raw JSON Schema object.
 *
 * The constructor compiles the schema once into closure-based validators. Reuse
 * instances for repeated parsing of the same schema to avoid recompilation.
 *
 * ```ts no_run
 * import { CompiledValidator, v } from 'fino:validate';
 *
 * const validator = new CompiledValidator<string>(v.string().min(1));
 * const value = validator.parse('ok');
 * ```
 */
export class CompiledValidator<T = unknown> {
  /**
   * Private property `#schema` used by `CompiledValidator`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #schema = undefined;
   *
   *   readInternalState() {
   *     return this.#schema;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #schema: JsonSchema;
  /**
   * Private property `#validate` used by `CompiledValidator`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #validate = undefined;
   *
   *   readInternalState() {
   *     return this.#validate;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #validate: ValidatorFn;
  /**
   * Compile `schema` immediately.
   *
   * Accepts a `SchemaBuilder` or raw JSON Schema object. Non-object schemas
   * throw `Error`. The compiled validator keeps a reference to the schema
   * object, so avoid mutating builders after compiling them.
   *
   * ```ts no_run
   * import { CompiledValidator, v } from 'fino:validate';
   *
   * const validator = new CompiledValidator<number>(v.integer().min(1));
   * ```
   */
  constructor(schema: unknown) {
    this.#schema = schemaOf(schema);
    this.#validate = compileSchema(this.#schema);
  }
  /**
   * Original canonical JSON Schema object used by this validator.
   *
   * The returned object is the same object captured during construction, not a
   * clone. Mutating it after compilation does not rebuild the closure graph.
   *
   * ```ts no_run
   * import { compile, v } from 'fino:validate';
   *
   * const validator = compile(v.string());
   * const schema = validator.schema;
   * ```
   */
  get schema(): JsonSchema {
    return this.#schema;
  }
  /**
   * Parse `value` and return the validated value.
   *
   * Defaults are applied to missing values. Throws `ValidationError` when any
   * issue is found.
   *
   * ```ts no_run
   * import { compile, v } from 'fino:validate';
   *
   * const validator = compile<string>(v.string().min(1));
   * const value = validator.parse('name');
   * ```
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
   *
   * ```ts no_run
   * import { compile, v } from 'fino:validate';
   *
   * const validator = compile<number>(v.number());
   * const result = validator.safeParse('nope');
   * ```
   */
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure {
    const result = this.#validate(value, '');
    if (result.issues.length === 0)
      return {
        success: true,
        value: result.value as T,
      };
    const error = new ValidationError(result.issues);
    return {
      success: false,
      error,
      issues: result.issues,
    };
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
 *
 * @example
 * ```ts no_run
 * const documentedClass = 'SchemaBuilder';
 * console.log(documentedClass);
 * ```
 */
export class SchemaBuilder<T = unknown> {
  /**
   * Mutable JSON Schema object represented by this builder.
   *
   * Builder methods update this object and return the same builder. It can be
   * passed anywhere a raw JSON Schema object is accepted.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().schema;
   * ```
   */
  schema: JsonSchema;
  /**
   * Create a builder around an existing JSON Schema object.
   *
   * `optional` marks the schema as optional when it is used in `v.object()`.
   * The marker is stored as a non-enumerable symbol and is not emitted by
   * `JSON.stringify()`.
   *
   * ```ts no_run
   * import { SchemaBuilder } from 'fino:validate';
   *
   * const builder = new SchemaBuilder<string>({ type: 'string' });
   * ```
   */
  constructor(schema: JsonSchema, optional = false) {
    this.schema = schema;
    if (optional)
      Object.defineProperty(this.schema, optionalSymbol, {
        value: true,
        configurable: true,
      });
  }
  /**
   * Return the canonical JSON Schema object for `JSON.stringify()`.
   *
   * Custom refinements and optional markers are non-enumerable symbol metadata,
   * so they are intentionally omitted from serialized JSON Schema.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const json = JSON.stringify(v.string().min(1).toJSON());
   * ```
   */
  toJSON(): JsonSchema {
    return this.schema;
  }
  /**
   * Validate `value` with this schema and throw on failure.
   *
   * This compiles the builder for the call, applies defaults, and returns the
   * parsed value. Validation failures throw `ValidationError`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const value = v.integer().min(1).parse(3);
   * ```
   */
  parse(value: unknown): T {
    return parse<T>(this, value);
  }
  /**
   * Validate `value` with this schema and return a tagged result.
   *
   * This compiles the builder for the call. Success returns `{ success: true,
   * value }`; failure returns `{ success: false, error, issues }`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const result = v.string().safeParse(123);
   * ```
   */
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure {
    return safeParse<T>(this, value);
  }
  /**
   * Mark this schema as optional when used as an object property.
   *
   * Optional properties are omitted from the generated `required` array in
   * `v.object()`. The method mutates and returns the same builder.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.object({ nickname: v.string().optional() });
   * ```
   */
  optional(): this {
    Object.defineProperty(this.schema, optionalSymbol, {
      value: true,
      configurable: true,
    });
    return this;
  }
  /**
   * Accept this schema or `null`.
   *
   * Returns a new builder using `anyOf` with the current schema and
   * `{ type: 'null' }`. The original builder is not marked optional.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().nullable();
   * ```
   */
  nullable(): SchemaBuilder<T | null> {
    return new SchemaBuilder<T | null>({ anyOf: [this.schema, { type: 'null' }] });
  }
  /**
   * Apply this default when the input value is missing.
   *
   * Defaults are used when the input is `undefined`; object and array defaults
   * are recursively cloned before returning parsed output.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.integer().default(3000);
   * ```
   */
  default(value: unknown): this {
    this.schema.default = value;
    return this;
  }
  /**
   * Attach a human-readable description to the schema.
   *
   * The description surfaces in generated JSON Schema, OpenAPI 3.1 output,
   * and LLM tool parameter specs, so it doubles as documentation for both
   * machines and humans.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().describe('The user's display name');
   * ```
   */
  describe(text: string): this {
    this.schema.description = text;
    return this;
  }
  /**
   * Attach a custom in-process refinement.
   *
   * Refinements cannot be represented in JSON Schema. They are preserved on the
   * builder object for runtime validation, but they are intentionally omitted
   * when serialized with `toJSON()`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().refine((value) => value.startsWith('x-'), 'must start with x-');
   * ```
   */
  refine(fn: (value: T) => boolean, message = 'failed custom validation'): this {
    const refinements =
      ((this.schema as Record<symbol, unknown>)[refinementsSymbol] as Refinement[] | undefined) ??
      [];
    refinements.push({
      fn: fn as (value: unknown) => boolean,
      message,
    });
    Object.defineProperty(this.schema, refinementsSymbol, {
      value: refinements,
      configurable: true,
    });
    return this;
  }
}
/**
 * String schema builder.
 *
 * Created by `v.string()`. Methods mutate the underlying schema and return the
 * same builder for chaining.
 *
 * ```ts no_run
 * import { v } from 'fino:validate';
 *
 * const schema = v.string().min(1).max(64);
 * ```
 */
class StringBuilder extends SchemaBuilder<string> {
  /**
   * Require a minimum string length.
   *
   * Sets JSON Schema `minLength` to `n`. The validator checks JavaScript string
   * length; invalid lengths are reported as `minLength` issues.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().min(3);
   * ```
   */
  min(n: number): this {
    this.schema.minLength = n;
    return this;
  }
  /**
   * Require a maximum string length.
   *
   * Sets JSON Schema `maxLength` to `n`. The validator reports longer strings
   * as `maxLength` issues.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().max(255);
   * ```
   */
  max(n: number): this {
    this.schema.maxLength = n;
    return this;
  }
  /**
   * Require an exact string length.
   *
   * Sets both `minLength` and `maxLength` to `n`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().length(6);
   * ```
   */
  length(n: number): this {
    this.schema.minLength = n;
    this.schema.maxLength = n;
    return this;
  }
  /**
   * Require a string to match a regular expression pattern.
   *
   * `RegExp` values are stored by their `.source`; flags are not preserved in
   * JSON Schema. Strings are stored unchanged.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().pattern(/^[a-z0-9-]+$/);
   * ```
   */
  pattern(pattern: string | RegExp): this {
    this.schema.pattern = pattern instanceof RegExp ? pattern.source : pattern;
    return this;
  }
  /**
   * Require a string format.
   *
   * Built-in validation currently recognizes `email`, `url`, and `uri`.
   * Unknown formats are preserved in the schema but treated as valid.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().format('email');
   * ```
   */
  format(format: string): this {
    this.schema.format = format;
    return this;
  }
}
/**
 * Number and integer schema builder.
 *
 * Created by `v.number()` or `v.integer()`. Methods set numeric bounds and
 * return the same builder for chaining.
 *
 * ```ts no_run
 * import { v } from 'fino:validate';
 *
 * const schema = v.integer().min(1).max(65535);
 * ```
 */
class NumberBuilder extends SchemaBuilder<number> {
  /**
   * Require a minimum numeric value.
   *
   * Sets JSON Schema `minimum` to `n`. The validator reports smaller numbers as
   * `minimum` issues.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.number().min(0);
   * ```
   */
  min(n: number): this {
    this.schema.minimum = n;
    return this;
  }
  /**
   * Require a maximum numeric value.
   *
   * Sets JSON Schema `maximum` to `n`. The validator reports larger numbers as
   * `maximum` issues.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.number().max(100);
   * ```
   */
  max(n: number): this {
    this.schema.maximum = n;
    return this;
  }
}
/**
 * Array and tuple schema builder.
 *
 * Created by `v.array()` or `v.tuple()`. Methods set item-count bounds and
 * return the same builder for chaining.
 *
 * ```ts no_run
 * import { v } from 'fino:validate';
 *
 * const schema = v.array(v.string()).min(1);
 * ```
 */
class ArrayBuilder extends SchemaBuilder<unknown[]> {
  /**
   * Require at least `n` array items.
   *
   * Sets JSON Schema `minItems` to `n`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.array(v.string()).min(1);
   * ```
   */
  min(n: number): this {
    this.schema.minItems = n;
    return this;
  }
  /**
   * Require at most `n` array items.
   *
   * Sets JSON Schema `maxItems` to `n`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.array(v.string()).max(10);
   * ```
   */
  max(n: number): this {
    this.schema.maxItems = n;
    return this;
  }
}
/**
 * Object schema builder.
 *
 * Created by `v.object()`. Methods mutate object-specific schema keywords and
 * return the same builder for chaining.
 *
 * ```ts no_run
 * import { v } from 'fino:validate';
 *
 * const schema = v.object({ name: v.string() });
 * ```
 */
class ObjectBuilder extends SchemaBuilder<Record<string, unknown>> {
  /**
   * Control validation of properties not declared in the object shape.
   *
   * Passing `false` rejects unknown keys. Passing `true` accepts unknown keys.
   * Passing a schema validates each unknown key's value against that schema.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.object({ name: v.string() })
   *   .additionalProperties(v.integer().min(1).schema);
   * ```
   */
  additionalProperties(value: boolean | JsonSchema): this {
    this.schema.additionalProperties = value;
    return this;
  }
}
function isOptional(schema: unknown): boolean {
  const actual = schemaOf(schema);
  return (actual as Record<symbol, unknown>)[optionalSymbol] === true;
}
/**
 * Create an object schema from a property shape.
 *
 * Properties whose builders were marked with `optional()` are omitted from the
 * generated `required` list. Raw JSON Schema objects can be mixed with builder
 * instances.
 *
 * ```ts no_run
 * import { v } from 'fino:validate';
 *
 * const schema = v.object({ name: v.string(), age: v.integer().optional() });
 * ```
 */
function object(shape: Record<string, unknown>): ObjectBuilder {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const key of Object.keys(shape)) {
    properties[key] = schemaOf(shape[key]);
    if (!isOptional(shape[key])) required.push(key);
  }
  const schema: JsonSchema = {
    type: 'object',
    properties,
  };
  if (required.length > 0) schema.required = required;
  return new ObjectBuilder(schema);
}
/**
 * Fluent builder namespace.
 *
 * Every builder method returns a schema builder whose `toJSON()` result is a
 * JSON-Schema-shaped object. Raw JSON Schema objects can be mixed with builders
 * anywhere a child schema is accepted.
 *
 * @example
 * ```ts no_run
 * const documentedMember = 'v';
 * console.log(documentedMember);
 * ```
 */
export const v = {
  /**
   * Create a schema that accepts any value.
   *
   * The generated JSON Schema is `{}`. Use this for intentionally unvalidated
   * extension points or values that are validated elsewhere.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.any();
   * ```
   */
  any(): SchemaBuilder<unknown> {
    return new SchemaBuilder({});
  },
  /**
   * Create a string schema builder.
   *
   * Chain `min()`, `max()`, `length()`, `pattern()`, or `format()` to add
   * string constraints.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.string().min(1).max(64);
   * ```
   */
  string(): StringBuilder {
    return new StringBuilder({ type: 'string' });
  },
  /**
   * Create a number schema builder.
   *
   * The schema accepts finite JavaScript numbers. Chain `min()` and `max()` to
   * add numeric bounds.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.number().min(0);
   * ```
   */
  number(): NumberBuilder {
    return new NumberBuilder({ type: 'number' });
  },
  /**
   * Create an integer schema builder.
   *
   * The schema accepts JavaScript numbers that satisfy `Number.isInteger()`.
   * Chain `min()` and `max()` to add integer bounds.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.integer().min(1).max(65535);
   * ```
   */
  integer(): NumberBuilder {
    return new NumberBuilder({ type: 'integer' });
  },
  /**
   * Create a boolean schema builder.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.boolean().default(false);
   * ```
   */
  boolean(): SchemaBuilder<boolean> {
    return new SchemaBuilder({ type: 'boolean' });
  },
  /**
   * Create a schema that accepts only `null`.
   *
   * Use `someSchema.nullable()` when a non-null schema should also accept
   * `null`.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.null();
   * ```
   */
  null(): SchemaBuilder<null> {
    return new SchemaBuilder({ type: 'null' });
  },
  /**
   * Create a constant-value schema.
   *
   * The value is stored as JSON Schema `const` and must compare equal during
   * validation.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.literal('production');
   * ```
   */
  literal(value: unknown): SchemaBuilder<unknown> {
    return new SchemaBuilder({ const: value });
  },
  /**
   * Create an enum schema from allowed values.
   *
   * The `values` array is copied into JSON Schema `enum`, so later mutations to
   * the caller's array do not change the schema.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.enum(['dev', 'prod']);
   * ```
   */
  enum(values: unknown[]): SchemaBuilder<unknown> {
    return new SchemaBuilder({ enum: values.slice() });
  },
  /**
   * Create an array schema with one item schema.
   *
   * `item` may be another builder or a raw JSON Schema object. Chain `min()`
   * and `max()` to constrain item count.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.array(v.string()).min(1);
   * ```
   */
  array(item: unknown): ArrayBuilder {
    return new ArrayBuilder({
      type: 'array',
      items: schemaOf(item),
    });
  },
  /**
   * Create a fixed-length tuple schema.
   *
   * `items` may contain builders or raw JSON Schema objects. The generated
   * schema uses `prefixItems` and sets `minItems` and `maxItems` to the tuple
   * length.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.tuple([v.string(), v.integer()]);
   * ```
   */
  tuple(items: unknown[]): ArrayBuilder {
    return new ArrayBuilder({
      type: 'array',
      prefixItems: items.map(schemaOf),
      minItems: items.length,
      maxItems: items.length,
    });
  },
  /**
   * Create an object schema from a property shape.
   *
   * Shape values may be builders or raw JSON Schema objects. Properties are
   * required by default; call `.optional()` on a builder to omit that property
   * from the generated `required` list.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.object({
   *   name: v.string(),
   *   nickname: v.string().optional(),
   * });
   * ```
   */
  object,
  /**
   * Create a union schema.
   *
   * `items` may contain builders or raw JSON Schema objects. The generated
   * schema uses JSON Schema `anyOf`; validation succeeds when any branch
   * accepts the value.
   *
   * ```ts no_run
   * import { v } from 'fino:validate';
   *
   * const schema = v.union([v.string(), v.integer()]);
   * ```
   */
  union(items: unknown[]): SchemaBuilder<unknown> {
    return new SchemaBuilder({ anyOf: items.map(schemaOf) });
  },
};
/**
 * Compile a builder or raw JSON Schema object into a reusable validator.
 *
 * Use this when validating many values with the same schema. Non-object schemas
 * throw `Error`; validation failures occur later when calling `parse()` or
 * `safeParse()` on the returned validator.
 *
 * ```ts no_run
 * import { compile, v } from 'fino:validate';
 *
 * const validator = compile<{ name: string }>(v.object({ name: v.string() }));
 * ```
 */
export function compile<T = unknown>(schema: unknown): CompiledValidator<T> {
  return new CompiledValidator<T>(schema);
}
/**
 * Parse a value once with a builder or raw JSON Schema object.
 *
 * This compiles the schema for the call, applies defaults, and returns the
 * parsed value. Validation failures throw `ValidationError`.
 *
 * ```ts no_run
 * import { parse, v } from 'fino:validate';
 *
 * const value = parse<string>(v.string().min(1), 'ok');
 * ```
 */
export function parse<T = unknown>(schema: unknown, value: unknown): T {
  return compile<T>(schema).parse(value);
}
/**
 * Parse a value once and return a tagged result instead of throwing.
 *
 * This compiles the schema for the call. Success returns `{ success: true,
 * value }`; failure returns `{ success: false, error, issues }`.
 *
 * ```ts no_run
 * import { safeParse, v } from 'fino:validate';
 *
 * const result = safeParse<number>(v.integer(), 'not an integer');
 * ```
 */
export function safeParse<T = unknown>(
  schema: unknown,
  value: unknown,
): SafeParseSuccess<T> | SafeParseFailure {
  return compile<T>(schema).safeParse(value);
}
