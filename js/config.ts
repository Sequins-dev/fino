/**
 * fino:config — explicit ordered config loading over fino:validate.
 *
 * JSON Schema specification: https://json-schema.org/specification
 *
 * Config loading is intentionally explicit. Callers provide a `sources` list,
 * and that list is both the set of enabled source types and the precedence
 * order. Earlier sources are lower precedence; later sources override them.
 *
 * The final merged value is validated through `fino:validate`, so config can
 * use fluent builders or raw JSON Schema loaded from disk. Environment and argv
 * sources produce strings by default, then the loader coerces scalar values
 * according to the validation schema before parsing.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 * import { v } from 'fino:validate';
 *
 * const loaded = await loadConfig({
 *   schema: v.object({
 *     server: v.object({ port: v.integer().default(3000) }),
 *   }),
 *   sources: [
 *     { type: 'defaults', value: { server: { port: 3000 } } },
 *     { type: 'file', path: './app.toml' },
 *     { type: 'env', prefix: 'APP_' },
 *     { type: 'argv', args: ['--server.port', '8080'] },
 *   ],
 * });
 *
 * loaded.value.server.port; // 8080
 * ```
 */

import { DiskFileSystem } from './file/fs.ts';
import { parse as parseToml } from './format/toml.ts';
import { argv as processArgv, env as processEnv } from './process.ts';
import { ValidationError, parse as validateParse } from './validate.ts';
import type { JsonSchema, ValidationIssue } from './validate.ts';

type ConfigValue = Record<string, unknown>;

/**
 * One config input source.
 *
 * Sources are loaded in array order. The merged result from each source
 * overrides values from all earlier sources.
 *
 * Each union arm is selected by its `type` field. File-backed sources throw
 * when the file cannot be read or parsed. Env-like sources produce string
 * values first; `loadConfig()` performs schema-guided scalar coercion before
 * validation.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 *
 * const loaded = await loadConfig({
 *   schema: { type: 'object' },
 *   sources: [
 *     { type: 'defaults', value: { server: { port: 3000 } } },
 *     { type: 'env', values: { APP_SERVER_PORT: '8080' }, prefix: 'APP_' },
 *   ],
 * });
 * loaded.value;
 * ```
 */
export type ConfigSource =
  | {
      /**
       * Select an inline default-value source.
       *
       * Defaults are usually placed early in the source list so later sources
       * can override them.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'defaults', value: { debug: false } }],
       * });
       * ```
       */
      type: 'defaults';
      /**
       * Inline default values to merge into the config object.
       *
       * The value is cloned before merging, so later loader work does not mutate
       * the caller's object. Non-object nested values are replaced by later
       * sources.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * const loaded = await loadConfig<{ server: { port: number } }>({
       *   schema: {
       *     type: 'object',
       *     properties: { server: { type: 'object', properties: { port: { type: 'integer' } } } },
       *   },
       *   sources: [{ type: 'defaults', value: { server: { port: 3000 } } }],
       * });
       * loaded.value.server.port;
       * ```
       */
      value: ConfigValue;
    }
  | {
      /**
       * Select a JSON or TOML file source.
       *
       * File sources are parsed into objects and then merged. A missing file,
       * invalid JSON, or invalid TOML causes `loadConfig()` to reject.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'file', path: './app.toml' }],
       * });
       * ```
       */
      type: 'file';
      /**
       * Path to the JSON or TOML config file.
       *
       * Relative paths are resolved by the runtime filesystem provider in the
       * usual way. The loader reads the entire file as UTF-8 text.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * const loaded = await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'file', path: './config.json' }],
       * });
       * loaded.sources[0].path;
       * ```
       */
      path: string;
      /**
       * Optional file format override.
       *
       * When omitted, `.toml` selects TOML and all other extensions default to
       * JSON. Use this when a file extension does not match its contents.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'file', path: './settings', format: 'json' }],
       * });
       * ```
       */
      format?: 'json' | 'toml';
    }
  | {
      /**
       * Select a dotenv file source.
       *
       * The loader supports common `.env` syntax with comments, blank lines,
       * and quoted values. Parsed keys are mapped into nested config paths.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'dotenv', path: './.env', prefix: 'APP_' }],
       * });
       * ```
       */
      type: 'dotenv';
      /**
       * Path to the dotenv file.
       *
       * The file is read as UTF-8. Missing files or read errors reject
       * `loadConfig()`.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * const loaded = await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'dotenv', path: './.env.local' }],
       * });
       * loaded.sources[0].path;
       * ```
       */
      path: string;
      /**
       * Explicit source-key to config-path mapping.
       *
       * Map keys are raw dotenv variable names. Values are dotted config paths,
       * such as `server.port`. Explicit mappings take precedence over prefix
       * based default mapping.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{
       *     type: 'dotenv',
       *     path: './.env',
       *     map: { PORT: 'server.port' },
       *   }],
       * });
       * ```
       */
      map?: Record<string, string>;
      /**
       * Optional variable prefix for default dotenv mapping.
       *
       * Variables outside the prefix are ignored. Matching names have the
       * prefix removed, are lowercased, and `_` separators become dotted path
       * separators.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'dotenv', path: './.env', prefix: 'APP_' }],
       * });
       * ```
       */
      prefix?: string;
    }
  | {
      /**
       * Select an environment variable source.
       *
       * When `values` is omitted, the process environment is used. Values are
       * strings until schema-guided coercion runs during `loadConfig()`.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'env', prefix: 'APP_' }],
       * });
       * ```
       */
      type: 'env';
      /**
       * Environment-like key/value object to read instead of process env.
       *
       * Supplying this is useful for tests or embedding. Keys and values are
       * treated the same way as real environment variables.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'env', values: { APP_PORT: '8080' }, prefix: 'APP_' }],
       * });
       * ```
       */
      values?: Record<string, string>;
      /**
       * Explicit environment-key to config-path mapping.
       *
       * Map keys are raw environment names. Values are dotted config paths.
       * Explicit mappings are applied before prefix-based default mapping.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{
       *     type: 'env',
       *     values: { DATABASE_URL: 'sqlite://app.db' },
       *     map: { DATABASE_URL: 'database.url' },
       *   }],
       * });
       * ```
       */
      map?: Record<string, string>;
      /**
       * Optional variable prefix for default environment mapping.
       *
       * Variables without the prefix are ignored. For matching variables, the
       * prefix is stripped, names are lowercased, and underscores become dots.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'env', values: { APP_DEBUG: 'true' }, prefix: 'APP_' }],
       * });
       * ```
       */
      prefix?: string;
    }
  | {
      /**
       * Select a command-line argument source.
       *
       * The parser accepts `--path value`, `--path=value`, and bare boolean
       * flags. Parsed values are merged as strings or booleans before schema
       * coercion.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'argv', args: ['--server.port', '8080'] }],
       * });
       * ```
       */
      type: 'argv';
      /**
       * Argument tokens to parse instead of process arguments.
       *
       * When omitted, `loadConfig()` uses process arguments after the executable
       * and script name. Supplying tokens is useful for tests.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'argv', args: ['--debug'] }],
       * });
       * ```
       */
      args?: string[];
      /**
       * Explicit flag to config-path mapping.
       *
       * Map keys include the leading `--`, for example `--port`. Values are
       * dotted config paths. Unmapped flags use their flag name without `--`.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'argv', args: ['--port', '8080'], map: { '--port': 'server.port' } }],
       * });
       * ```
       */
      map?: Record<string, string>;
    }
  | {
      /**
       * Select an inline override source.
       *
       * Overrides are usually placed last because later sources take
       * precedence over earlier sources.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * await loadConfig({
       *   schema: { type: 'object' },
       *   sources: [{ type: 'override', value: { debug: true } }],
       * });
       * ```
       */
      type: 'override';
      /**
       * Inline override values to merge into the config object.
       *
       * Values are cloned before merging. Since source order controls
       * precedence, this object replaces earlier scalar and array values at the
       * same paths.
       *
       * ```ts no_run
       * import { loadConfig } from 'fino:config';
       *
       * const loaded = await loadConfig<{ server: { port: number } }>({
       *   schema: { type: 'object' },
       *   sources: [
       *     { type: 'defaults', value: { server: { port: 3000 } } },
       *     { type: 'override', value: { server: { port: 0 } } },
       *   ],
       * });
       * loaded.value.server.port;
       * ```
       */
      value: ConfigValue;
    };

/**
 * Options for `loadConfig()`.
 *
 * Provide a validation schema and the ordered list of enabled sources. The
 * loader rejects with `ConfigError` when validation fails.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 *
 * const loaded = await loadConfig({
 *   schema: { type: 'object' },
 *   sources: [{ type: 'defaults', value: {} }],
 * });
 * loaded.sources;
 * ```
 */
export interface LoadConfigOptions<T = unknown> {
  /**
   * Fluent builder or raw JSON Schema object used for final validation.
   *
   * Builders with `toJSON()` are converted before scalar coercion. Schema
   * defaults are applied by `fino:validate` when supported by the provided
   * schema.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * await loadConfig({
   *   schema: {
   *     type: 'object',
   *     properties: { port: { type: 'integer' } },
   *   },
   *   sources: [{ type: 'defaults', value: { port: 3000 } }],
   * });
   * ```
   */
  schema: unknown;
  /**
   * Ordered source list. Later entries override earlier entries.
   *
   * The array also controls which source types are enabled; there is no
   * implicit loading from files, env, or argv.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [
   *     { type: 'defaults', value: { debug: false } },
   *     { type: 'override', value: { debug: true } },
   *   ],
   * });
   * loaded.value;
   * ```
   */
  sources: ConfigSource[];
  /**
   * Config paths whose received values should be redacted in validation errors.
   *
   * Paths use the same dotted form as source mappings. Redaction affects the
   * rendered error message; the original `ValidationIssue` objects are still
   * exposed on `ConfigError.issues`.
   *
   * ```ts no_run
   * import { ConfigError, loadConfig } from 'fino:config';
   *
   * try {
   *   await loadConfig({
   *     schema: { type: 'object', required: ['database'] },
   *     sources: [{ type: 'defaults', value: { database: { password: 'secret' } } }],
   *     secrets: ['database.password'],
   *   });
   * } catch (error) {
   *   if (error instanceof ConfigError) error.message;
   * }
   * ```
   */
  secrets?: string[];
}

/**
 * Metadata describing values loaded from a source.
 *
 * Reports are returned in the same order as the input `sources` array. They
 * include source type, optional file path, and flattened keys produced by the
 * source after mapping.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 *
 * const loaded = await loadConfig({
 *   schema: { type: 'object' },
 *   sources: [{ type: 'env', values: { APP_SERVER_PORT: '8080' }, prefix: 'APP_' }],
 * });
 * loaded.sources[0].keys;
 * ```
 */
export interface ConfigSourceReport {
  /**
   * Source type, matching the input source discriminant.
   *
   * This is a string so reports can describe future source types without a type
   * change.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [{ type: 'env', values: { APP_DEBUG: 'true' }, prefix: 'APP_' }],
   * });
   * loaded.sources.find((source) => source.type === 'env');
   * ```
   */
  type: string;
  /**
   * File path for file-backed sources.
   *
   * This is present for `file` and `dotenv` reports and omitted for inline,
   * environment, and argv sources.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [{ type: 'file', path: './app.toml' }],
   * });
   * loaded.sources[0].path;
   * ```
   */
  path?: string;
  /**
   * Flattened config paths produced by this source.
   *
   * Nested objects are represented as dotted paths. Empty sources produce an
   * empty array.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [{ type: 'defaults', value: { server: { port: 3000 } } }],
   * });
   * loaded.sources[0].keys.includes('server.port');
   * ```
   */
  keys: string[];
}

/**
 * Result returned from `loadConfig()`.
 *
 * The value has already been merged, coerced, and validated. Source reports
 * describe what each source contributed.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 *
 * const loaded = await loadConfig<{ debug: boolean }>({
 *   schema: { type: 'object', properties: { debug: { type: 'boolean' } } },
 *   sources: [{ type: 'override', value: { debug: true } }],
 * });
 * loaded.value.debug;
 * ```
 */
export interface LoadedConfig<T = unknown> {
  /**
   * Validated config value, including defaults applied by the schema.
   *
   * Its type is the generic `T` supplied to `loadConfig<T>()`.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig<{ port: number }>({
   *   schema: { type: 'object', properties: { port: { type: 'integer' } } },
   *   sources: [{ type: 'defaults', value: { port: 3000 } }],
   * });
   * loaded.value.port;
   * ```
   */
  value: T;
  /**
   * Per-source load metadata in the same order as `sources`.
   *
   * Reports are useful for diagnostics and for explaining where configuration
   * came from. They do not include secret redaction metadata.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [
   *     { type: 'defaults', value: { port: 3000 } },
   *     { type: 'argv', args: ['--port', '8080'] },
   *   ],
   * });
   * loaded.sources.map((source) => source.type);
   * ```
   */
  sources: ConfigSourceReport[];
  /**
   * Read a dotted path from the validated config value.
   *
   * Missing paths return `undefined`. Array indexes can be used as dotted path
   * segments when the underlying value is represented with numeric keys.
   *
   * @param {string} path Dotted config path.
   * @returns {unknown} Value at `path`, or `undefined` when missing.
   *
   * ```ts no_run
   * import { loadConfig } from 'fino:config';
   *
   * const loaded = await loadConfig({
   *   schema: { type: 'object' },
   *   sources: [{ type: 'defaults', value: { server: { port: 3000 } } }],
   * });
   * loaded.get('server.port');
   * ```
   */
  get(path: string): unknown;
}

/**
 * Error thrown when loading or validating config fails.
 *
 * Validation failures include the original `ValidationIssue` objects in
 * `issues`. Source parsing and unknown-source errors may throw `ConfigError`
 * without issues.
 *
 * ```ts no_run
 * import { ConfigError, loadConfig } from 'fino:config';
 *
 * try {
 *   await loadConfig({
 *     schema: { type: 'object', required: ['port'] },
 *     sources: [{ type: 'defaults', value: {} }],
 *   });
 * } catch (error) {
 *   if (error instanceof ConfigError) error.issues;
 * }
 * ```
 */
export class ConfigError extends Error {
  /**
   * Validation issues when the failure came from `fino:validate`.
   *
   * This array is empty for loader errors that are not validation failures.
   * Secret redaction applies to the error message, not to issue objects.
   *
   * ```ts no_run
   * import { ConfigError, loadConfig } from 'fino:config';
   *
   * try {
   *   await loadConfig({
   *     schema: { type: 'object', required: ['port'] },
   *     sources: [{ type: 'defaults', value: {} }],
   *   });
   * } catch (error) {
   *   if (error instanceof ConfigError) error.issues.map((issue) => String(issue));
   * }
   * ```
   */
  issues: ValidationIssue[];

  /**
   * Create a config error.
   *
   * The default issue list is empty. The `name` property is set to
   * `'ConfigError'` for callers that distinguish config failures from other
   * exceptions.
   *
   * @param {string} message Error message.
   * @param {ValidationIssue[]} [issues=[]] Validation issues, when available.
   *
   * ```ts no_run
   * import { ConfigError } from 'fino:config';
   *
   * throw new ConfigError('Invalid config');
   * ```
   */
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Object/path helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) out[key] = clone((value as Record<string, unknown>)[key]);
  return out;
}

function deepMerge(base: unknown, next: unknown): unknown {
  if (!isRecord(base) || !isRecord(next)) return clone(next);
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(next)) {
    out[key] = key in out ? deepMerge(out[key], next[key]) : clone(next[key]);
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  let cursor = target;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!isRecord(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
}

function getPath(target: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cursor = target;
  for (const part of parts) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function sourceKeys(value: unknown, prefix = ''): string[] {
  if (!isRecord(value)) return prefix ? [prefix] : [];
  const keys: string[] = [];
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value[key])) keys.push(...sourceKeys(value[key], path));
    else keys.push(path);
  }
  return keys;
}

function inferFormat(path: string): 'json' | 'toml' {
  if (path.endsWith('.toml')) return 'toml';
  return 'json';
}

// ---------------------------------------------------------------------------
// Source parsers and mappers
// ---------------------------------------------------------------------------

/**
 * Parse a dotenv file into raw key/value strings.
 *
 * This parser deliberately covers the common `.env` subset used for local
 * development: comments, blank lines, and single/double-quoted values.
 */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Convert an environment variable name into a dotted config path.
 *
 * With a prefix, variables outside that prefix are ignored. For example,
 * `APP_SERVER_PORT` with prefix `APP_` becomes `server.port`.
 */
function defaultEnvPath(key: string, prefix?: string): string | null {
  let name = key;
  if (prefix !== undefined) {
    if (!name.startsWith(prefix)) return null;
    name = name.slice(prefix.length);
  }
  return name.toLowerCase().split('_').filter(Boolean).join('.');
}

/** Map env-like key/value strings into a nested config object. */
function mapEnvLike(values: Record<string, string>, options: { map?: Record<string, string>; prefix?: string } = {}): ConfigValue {
  const out: ConfigValue = {};
  for (const key of Object.keys(values)) {
    const target = options.map?.[key] ?? defaultEnvPath(key, options.prefix);
    if (target !== null && target !== undefined && target.length > 0) setPath(out, target, values[key]);
  }
  return out;
}

/**
 * Parse simple CLI flag arguments into a nested config object.
 *
 * Supports `--path value`, `--path=value`, and boolean flags. The optional map
 * lets callers remap external flags such as `--port` to nested paths such as
 * `server.port`.
 */
function parseArgv(args: string[], map: Record<string, string> = {}): ConfigValue {
  const out: ConfigValue = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) continue;
    const equals = token.indexOf('=');
    const flag = equals === -1 ? token : token.slice(0, equals);
    const target = map[flag] ?? flag.slice(2);
    let value: unknown;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      value = args[++i];
    } else {
      value = true;
    }
    setPath(out, target, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema-guided scalar coercion
// ---------------------------------------------------------------------------

function schemaObject(schema: unknown): JsonSchema {
  if (schema !== null && typeof schema === 'object' && typeof (schema as { toJSON?: unknown }).toJSON === 'function') {
    return (schema as { toJSON(): JsonSchema }).toJSON();
  }
  return schema as JsonSchema;
}

/** Coerce a single string according to the matching JSON Schema scalar type. */
function coerceValue(value: unknown, schema: JsonSchema | null): unknown {
  if (typeof value !== 'string' || schema === null) return value;
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'integer') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (type === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(value)) return true;
    if (/^(false|0|no|off)$/i.test(value)) return false;
  }
  return value;
}

/** Return the child property schema for an object schema. */
function childSchema(schema: unknown, key: string): JsonSchema | null {
  const actual = schemaObject(schema);
  if (!isRecord(actual.properties)) return null;
  const child = actual.properties[key];
  return child === undefined ? null : schemaObject(child);
}

/** Return the item schema for an array or tuple schema. */
function arrayItemSchema(schema: unknown, index: number): JsonSchema | null {
  const actual = schemaObject(schema);
  if (Array.isArray(actual.prefixItems)) {
    const child = actual.prefixItems[index];
    return child === undefined ? null : schemaObject(child);
  }
  if (isRecord(actual.items)) return actual.items;
  return null;
}

/**
 * Walk a merged config object and coerce env/argv strings before validation.
 *
 * Coercion is intentionally conservative: only schema-backed integer, number,
 * and boolean values are converted. Everything else remains unchanged and is
 * left for validation to accept or reject.
 */
function coerceScalars(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) return value.map((item, index) => coerceScalars(item, arrayItemSchema(schema, index) ?? {}));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = coerceScalars(value[key], childSchema(schema, key) ?? {});
    }
    return out;
  }
  return coerceValue(value, schemaObject(schema));
}

// ---------------------------------------------------------------------------
// Error reporting and source loading
// ---------------------------------------------------------------------------

/** Render a validation issue while redacting configured secret paths. */
function redactIssue(issue: ValidationIssue, secretPaths: Set<string>): string {
  const secret = secretPaths.has(issue.path);
  const received = secret ? '[redacted]' : JSON.stringify(issue.value);
  return `${issue.path || '<root>'}: ${issue.message} (received ${received})`;
}

/** Load one configured source into a nested object plus a source report. */
async function loadSource(source: ConfigSource, fs: DiskFileSystem): Promise<{ value: ConfigValue; report: ConfigSourceReport }> {
  if (source.type === 'defaults' || source.type === 'override') {
    return {
      value: clone(source.value) as ConfigValue,
      report: { type: source.type, keys: sourceKeys(source.value) },
    };
  }

  if (source.type === 'file') {
    const text = await fs.readFile(source.path);
    const format = source.format ?? inferFormat(source.path);
    const value = format === 'toml' ? parseToml(text) as ConfigValue : JSON.parse(text) as ConfigValue;
    return { value, report: { type: 'file', path: source.path, keys: sourceKeys(value) } };
  }

  if (source.type === 'dotenv') {
    const values = parseDotenv(await fs.readFile(source.path));
    const value = mapEnvLike(values, source);
    return { value, report: { type: 'dotenv', path: source.path, keys: sourceKeys(value) } };
  }

  if (source.type === 'env') {
    const values = source.values ?? processEnv;
    const value = mapEnvLike(values, source);
    return { value, report: { type: 'env', keys: sourceKeys(value) } };
  }

  if (source.type === 'argv') {
    const args = source.args ?? processArgv.slice(2);
    const value = parseArgv(args, source.map);
    return { value, report: { type: 'argv', keys: sourceKeys(value) } };
  }

  throw new ConfigError(`Unknown config source type '${(source as { type?: unknown }).type}'`);
}

/**
 * Load, merge, coerce, and validate config from an explicit source list.
 *
 * Source order is the precedence model: later sources override earlier sources.
 * The returned `value` is the post-validation object.
 *
 * The loader reads each source in order, deep-merges object values, performs
 * conservative schema-guided coercion for strings from env and argv sources,
 * and validates through `fino:validate`. Validation failures throw
 * `ConfigError` with `issues`; file parse errors and unsupported sources also
 * reject. There are no implicit defaults beyond what you provide in `sources`
 * or the validation schema.
 *
 * @param {LoadConfigOptions<T>} options Schema, sources, and optional secret paths.
 * @returns {Promise<LoadedConfig<T>>} Validated config plus source reports.
 *
 * ```ts no_run
 * import { loadConfig } from 'fino:config';
 *
 * const loaded = await loadConfig<{ server: { port: number } }>({
 *   schema: {
 *     type: 'object',
 *     properties: {
 *       server: {
 *         type: 'object',
 *         properties: { port: { type: 'integer' } },
 *       },
 *     },
 *   },
 *   sources: [
 *     { type: 'defaults', value: { server: { port: 3000 } } },
 *     { type: 'argv', args: ['--server.port', '8080'] },
 *   ],
 * });
 * loaded.value.server.port;
 * ```
 */
export async function loadConfig<T = unknown>(options: LoadConfigOptions<T>): Promise<LoadedConfig<T>> {
  const fs = new DiskFileSystem();
  let merged: unknown = {};
  const reports: ConfigSourceReport[] = [];

  for (const source of options.sources) {
    const loaded = await loadSource(source, fs);
    merged = deepMerge(merged, loaded.value);
    reports.push(loaded.report);
  }

  const coerced = coerceScalars(merged, options.schema);

  try {
    const value = validateParse<T>(options.schema, coerced);
    return {
      value,
      sources: reports,
      get(path: string): unknown {
        return getPath(value, path);
      },
    };
  } catch (err) {
    if (err instanceof ValidationError) {
      const secretPaths = new Set(options.secrets ?? []);
      throw new ConfigError(`Invalid config: ${err.issues.map((issue) => redactIssue(issue, secretPaths)).join('; ')}`, err.issues);
    }
    throw err;
  }
}
