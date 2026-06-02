# config

fino:config — explicit ordered config loading over fino:validate.

Config loading is intentionally explicit. Callers provide a `sources` list,
and that list is both the set of enabled source types and the precedence
order. Earlier sources are lower precedence; later sources override them.

The final merged value is validated through `fino:validate`, so config can
use fluent builders or raw JSON Schema loaded from disk. Environment and argv
sources produce strings by default, then the loader coerces scalar values
according to the validation schema before parsing.

```ts
import { loadConfig } from 'fino:config';
import { v } from 'fino:validate';

const loaded = await loadConfig({
  schema: v.object({
    server: v.object({ port: v.integer().default(3000) }),
  }),
  sources: [
    { type: 'defaults', value: { server: { port: 3000 } } },
    { type: 'file', path: './app.toml' },
    { type: 'env', prefix: 'APP_' },
    { type: 'argv', args: ['--server.port', '8080'] },
  ],
});

loaded.value.server.port; // 8080
```

## ConfigSource

```ts
type ConfigSource = | { /** * Select an inline default-value source. * * Defaults are usually placed early in the source list so later sources * can override them. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'defaults', value: { debug: false } }], * }); * ``` */ type: 'defaults'; /** * Inline default values to merge into the config object. * * The value is cloned before merging, so later loader work does not mutate * the caller's object. Non-object nested values are replaced by later * sources. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * const loaded = await loadConfig<{ server: { port: number } }>({ * schema: { * type: 'object', * properties: { server: { type: 'object', properties: { port: { type: 'integer' } } } }, * }, * sources: [{ type: 'defaults', value: { server: { port: 3000 } } }], * }); * loaded.value.server.port; * ``` */ value: ConfigValue; } | { /** * Select a JSON or TOML file source. * * File sources are parsed into objects and then merged. A missing file, * invalid JSON, or invalid TOML causes `loadConfig()` to reject. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'file', path: './app.toml' }], * }); * ``` */ type: 'file'; /** * Path to the JSON or TOML config file. * * Relative paths are resolved by the runtime filesystem provider in the * usual way. The loader reads the entire file as UTF-8 text. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * const loaded = await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'file', path: './config.json' }], * }); * loaded.sources[0].path; * ``` */ path: string; /** * Optional file format override. * * When omitted, `.toml` selects TOML and all other extensions default to * JSON. Use this when a file extension does not match its contents. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'file', path: './settings', format: 'json' }], * }); * ``` */ format?: 'json' | 'toml'; } | { /** * Select a dotenv file source. * * The loader supports common `.env` syntax with comments, blank lines, * and quoted values. Parsed keys are mapped into nested config paths. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'dotenv', path: './.env', prefix: 'APP_' }], * }); * ``` */ type: 'dotenv'; /** * Path to the dotenv file. * * The file is read as UTF-8. Missing files or read errors reject * `loadConfig()`. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * const loaded = await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'dotenv', path: './.env.local' }], * }); * loaded.sources[0].path; * ``` */ path: string; /** * Explicit source-key to config-path mapping. * * Map keys are raw dotenv variable names. Values are dotted config paths, * such as `server.port`. Explicit mappings take precedence over prefix * based default mapping. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ * type: 'dotenv', * path: './.env', * map: { PORT: 'server.port' }, * }], * }); * ``` */ map?: Record<string, string>; /** * Optional variable prefix for default dotenv mapping. * * Variables outside the prefix are ignored. Matching names have the * prefix removed, are lowercased, and `_` separators become dotted path * separators. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'dotenv', path: './.env', prefix: 'APP_' }], * }); * ``` */ prefix?: string; } | { /** * Select an environment variable source. * * When `values` is omitted, the process environment is used. Values are * strings until schema-guided coercion runs during `loadConfig()`. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'env', prefix: 'APP_' }], * }); * ``` */ type: 'env'; /** * Environment-like key/value object to read instead of process env. * * Supplying this is useful for tests or embedding. Keys and values are * treated the same way as real environment variables. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'env', values: { APP_PORT: '8080' }, prefix: 'APP_' }], * }); * ``` */ values?: Record<string, string>; /** * Explicit environment-key to config-path mapping. * * Map keys are raw environment names. Values are dotted config paths. * Explicit mappings are applied before prefix-based default mapping. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ * type: 'env', * values: { DATABASE_URL: 'sqlite://app.db' }, * map: { DATABASE_URL: 'database.url' }, * }], * }); * ``` */ map?: Record<string, string>; /** * Optional variable prefix for default environment mapping. * * Variables without the prefix are ignored. For matching variables, the * prefix is stripped, names are lowercased, and underscores become dots. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'env', values: { APP_DEBUG: 'true' }, prefix: 'APP_' }], * }); * ``` */ prefix?: string; } | { /** * Select a command-line argument source. * * The parser accepts `--path value`, `--path=value`, and bare boolean * flags. Parsed values are merged as strings or booleans before schema * coercion. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'argv', args: ['--server.port', '8080'] }], * }); * ``` */ type: 'argv'; /** * Argument tokens to parse instead of process arguments. * * When omitted, `loadConfig()` uses process arguments after the executable * and script name. Supplying tokens is useful for tests. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'argv', args: ['--debug'] }], * }); * ``` */ args?: string[]; /** * Explicit flag to config-path mapping. * * Map keys include the leading `--`, for example `--port`. Values are * dotted config paths. Unmapped flags use their flag name without `--`. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'argv', args: ['--port', '8080'], map: { '--port': 'server.port' } }], * }); * ``` */ map?: Record<string, string>; } | { /** * Select an inline override source. * * Overrides are usually placed last because later sources take * precedence over earlier sources. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * await loadConfig({ * schema: { type: 'object' }, * sources: [{ type: 'override', value: { debug: true } }], * }); * ``` */ type: 'override'; /** * Inline override values to merge into the config object. * * Values are cloned before merging. Since source order controls * precedence, this object replaces earlier scalar and array values at the * same paths. * * ```ts no_run * import { loadConfig } from 'fino:config'; * * const loaded = await loadConfig<{ server: { port: number } }>({ * schema: { type: 'object' }, * sources: [ * { type: 'defaults', value: { server: { port: 3000 } } }, * { type: 'override', value: { server: { port: 0 } } }, * ], * }); * loaded.value.server.port; * ``` */ value: ConfigValue; }
```

One config input source.

Sources are loaded in array order. The merged result from each source
overrides values from all earlier sources.

Each union arm is selected by its `type` field. File-backed sources throw
when the file cannot be read or parsed. Env-like sources produce string
values first; `loadConfig()` performs schema-guided scalar coercion before
validation.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [
    { type: 'defaults', value: { server: { port: 3000 } } },
    { type: 'env', values: { APP_SERVER_PORT: '8080' }, prefix: 'APP_' },
  ],
});
loaded.value;
```

## LoadConfigOptions

```ts
interface LoadConfigOptions<T = unknown> {
```

Options for `loadConfig()`.

Provide a validation schema and the ordered list of enabled sources. The
loader rejects with `ConfigError` when validation fails.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'defaults', value: {} }],
});
loaded.sources;
```

### schema

```ts
schema: unknown
```

Fluent builder or raw JSON Schema object used for final validation.

Builders with `toJSON()` are converted before scalar coercion. Schema
defaults are applied by `fino:validate` when supported by the provided
schema.

```ts
import { loadConfig } from 'fino:config';

await loadConfig({
  schema: {
    type: 'object',
    properties: { port: { type: 'integer' } },
  },
  sources: [{ type: 'defaults', value: { port: 3000 } }],
});
```

### sources

```ts
sources: ConfigSource[]
```

Ordered source list. Later entries override earlier entries.

The array also controls which source types are enabled; there is no
implicit loading from files, env, or argv.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [
    { type: 'defaults', value: { debug: false } },
    { type: 'override', value: { debug: true } },
  ],
});
loaded.value;
```

### secrets

```ts
secrets?: string[]
```

Config paths whose received values should be redacted in validation errors.

Paths use the same dotted form as source mappings. Redaction affects the
rendered error message; the original `ValidationIssue` objects are still
exposed on `ConfigError.issues`.

```ts
import { ConfigError, loadConfig } from 'fino:config';

try {
  await loadConfig({
    schema: { type: 'object', required: ['database'] },
    sources: [{ type: 'defaults', value: { database: { password: 'secret' } } }],
    secrets: ['database.password'],
  });
} catch (error) {
  if (error instanceof ConfigError) error.message;
}
```

## ConfigSourceReport

```ts
interface ConfigSourceReport {
```

Metadata describing values loaded from a source.

Reports are returned in the same order as the input `sources` array. They
include source type, optional file path, and flattened keys produced by the
source after mapping.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'env', values: { APP_SERVER_PORT: '8080' }, prefix: 'APP_' }],
});
loaded.sources[0].keys;
```

### type

```ts
type: string
```

Source type, matching the input source discriminant.

This is a string so reports can describe future source types without a type
change.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'env', values: { APP_DEBUG: 'true' }, prefix: 'APP_' }],
});
loaded.sources.find((source) => source.type === 'env');
```

### path

```ts
path?: string
```

File path for file-backed sources.

This is present for `file` and `dotenv` reports and omitted for inline,
environment, and argv sources.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'file', path: './app.toml' }],
});
loaded.sources[0].path;
```

### keys

```ts
keys: string[]
```

Flattened config paths produced by this source.

Nested objects are represented as dotted paths. Empty sources produce an
empty array.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'defaults', value: { server: { port: 3000 } } }],
});
loaded.sources[0].keys.includes('server.port');
```

## LoadedConfig

```ts
interface LoadedConfig<T = unknown> {
```

Result returned from `loadConfig()`.

The value has already been merged, coerced, and validated. Source reports
describe what each source contributed.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig<{ debug: boolean }>({
  schema: { type: 'object', properties: { debug: { type: 'boolean' } } },
  sources: [{ type: 'override', value: { debug: true } }],
});
loaded.value.debug;
```

### value

```ts
value: T
```

Validated config value, including defaults applied by the schema.

Its type is the generic `T` supplied to `loadConfig<T>()`.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig<{ port: number }>({
  schema: { type: 'object', properties: { port: { type: 'integer' } } },
  sources: [{ type: 'defaults', value: { port: 3000 } }],
});
loaded.value.port;
```

### sources

```ts
sources: ConfigSourceReport[]
```

Per-source load metadata in the same order as `sources`.

Reports are useful for diagnostics and for explaining where configuration
came from. They do not include secret redaction metadata.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [
    { type: 'defaults', value: { port: 3000 } },
    { type: 'argv', args: ['--port', '8080'] },
  ],
});
loaded.sources.map((source) => source.type);
```

### get

```ts
get(path: string): unknown
```

Read a dotted path from the validated config value.

Missing paths return `undefined`. Array indexes can be used as dotted path
segments when the underlying value is represented with numeric keys.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig({
  schema: { type: 'object' },
  sources: [{ type: 'defaults', value: { server: { port: 3000 } } }],
});
loaded.get('server.port');
```

## ConfigError

```ts
class ConfigError extends Error {
```

Error thrown when loading or validating config fails.

Validation failures include the original `ValidationIssue` objects in
`issues`. Source parsing and unknown-source errors may throw `ConfigError`
without issues.

```ts
import { ConfigError, loadConfig } from 'fino:config';

try {
  await loadConfig({
    schema: { type: 'object', required: ['port'] },
    sources: [{ type: 'defaults', value: {} }],
  });
} catch (error) {
  if (error instanceof ConfigError) error.issues;
}
```

### issues

```ts
issues: ValidationIssue[]
```

Validation issues when the failure came from `fino:validate`.

This array is empty for loader errors that are not validation failures.
Secret redaction applies to the error message, not to issue objects.

```ts
import { ConfigError, loadConfig } from 'fino:config';

try {
  await loadConfig({
    schema: { type: 'object', required: ['port'] },
    sources: [{ type: 'defaults', value: {} }],
  });
} catch (error) {
  if (error instanceof ConfigError) error.issues.map((issue) => String(issue));
}
```

### constructor

```ts
constructor(message: string, issues: ValidationIssue[] = [])
```

Create a config error.

The default issue list is empty. The `name` property is set to
`'ConfigError'` for callers that distinguish config failures from other
exceptions.

```ts
import { ConfigError } from 'fino:config';

throw new ConfigError('Invalid config');
```

## loadConfig

```ts
async function loadConfig<T = unknown>(options: LoadConfigOptions<T>): Promise<LoadedConfig<T>>
```

Load, merge, coerce, and validate config from an explicit source list.

Source order is the precedence model: later sources override earlier sources.
The returned `value` is the post-validation object.

The loader reads each source in order, deep-merges object values, performs
conservative schema-guided coercion for strings from env and argv sources,
and validates through `fino:validate`. Validation failures throw
`ConfigError` with `issues`; file parse errors and unsupported sources also
reject. There are no implicit defaults beyond what you provide in `sources`
or the validation schema.

```ts
import { loadConfig } from 'fino:config';

const loaded = await loadConfig<{ server: { port: number } }>({
  schema: {
    type: 'object',
    properties: {
      server: {
        type: 'object',
        properties: { port: { type: 'integer' } },
      },
    },
  },
  sources: [
    { type: 'defaults', value: { server: { port: 3000 } } },
    { type: 'argv', args: ['--server.port', '8080'] },
  ],
});
loaded.value.server.port;
```
