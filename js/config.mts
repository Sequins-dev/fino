/**
 * fino:config — explicit ordered config loading over fino:validate.
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
 * ```ts
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

import { DiskFileSystem } from './file/fs.mts';
import { parse as parseToml } from './format/toml.mts';
import { argv as processArgv, env as processEnv } from './runtime/process.mts';
import { ValidationError, parse as validateParse } from './validate.mts';
import type { JsonSchema, ValidationIssue } from './validate.mts';

type ConfigValue = Record<string, unknown>;

/**
 * One config input source.
 *
 * Sources are loaded in array order. The merged result from each source
 * overrides values from all earlier sources.
 */
export type ConfigSource =
  /** Inline default values. */
  | { type: 'defaults'; value: ConfigValue }
  /** JSON or TOML file. Format is inferred from extension unless provided. */
  | { type: 'file'; path: string; format?: 'json' | 'toml' }
  /** Dotenv file mapped into nested config paths. */
  | { type: 'dotenv'; path: string; map?: Record<string, string>; prefix?: string }
  /** Environment object or process environment mapped into nested config paths. */
  | { type: 'env'; values?: Record<string, string>; map?: Record<string, string>; prefix?: string }
  /** Command-line arguments mapped into nested config paths. */
  | { type: 'argv'; args?: string[]; map?: Record<string, string> }
  /** Inline highest-precedence override values. */
  | { type: 'override'; value: ConfigValue };

/** Options for `loadConfig()`. */
export interface LoadConfigOptions<T = unknown> {
  /** Fluent builder or raw JSON Schema object used for final validation. */
  schema: unknown;
  /** Ordered source list. Later entries override earlier entries. */
  sources: ConfigSource[];
  /** Config paths whose received values should be redacted in errors. */
  secrets?: string[];
}

/** Metadata describing values loaded from a source. */
export interface ConfigSourceReport {
  /** Source type, matching the input source discriminant. */
  type: string;
  /** File path for file-backed sources. */
  path?: string;
  /** Flattened config paths produced by this source. */
  keys: string[];
}

/** Result returned from `loadConfig()`. */
export interface LoadedConfig<T = unknown> {
  /** Validated config value, including defaults applied by the schema. */
  value: T;
  /** Per-source load metadata in the same order as `sources`. */
  sources: ConfigSourceReport[];
  /** Read a dotted path from the validated config value. */
  get(path: string): unknown;
}

/** Error thrown when loading or validating config fails. */
export class ConfigError extends Error {
  /** Validation issues when the failure came from `fino:validate`. */
  issues: ValidationIssue[];

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
