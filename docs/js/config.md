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
type ConfigSource = /** Inline default values. */ | { type: 'defaults'; value: ConfigValue } /** JSON or TOML file. Format is inferred from extension unless provided. */ | { type: 'file'; path: string; format?: 'json' | 'toml' } /** Dotenv file mapped into nested config paths. */ | { type: 'dotenv'; path: string; map?: Record<string, string>; prefix?: string } /** Environment object or process environment mapped into nested config paths. */ | { type: 'env'; values?: Record<string, string>; map?: Record<string, string>; prefix?: string } /** Command-line arguments mapped into nested config paths. */ | { type: 'argv'; args?: string[]; map?: Record<string, string> } /** Inline highest-precedence override values. */ | { type: 'override'; value: ConfigValue }
```

One config input source.

Sources are loaded in array order. The merged result from each source
overrides values from all earlier sources.

## LoadConfigOptions

```ts
interface LoadConfigOptions<T = unknown> {
```

Options for `loadConfig()`.

### schema

```ts
schema: unknown
```

Fluent builder or raw JSON Schema object used for final validation.

### sources

```ts
sources: ConfigSource[]
```

Ordered source list. Later entries override earlier entries.

### secrets

```ts
secrets?: string[]
```

Config paths whose received values should be redacted in errors.

## ConfigSourceReport

```ts
interface ConfigSourceReport {
```

Metadata describing values loaded from a source.

### type

```ts
type: string
```

Source type, matching the input source discriminant.

### path

```ts
path?: string
```

File path for file-backed sources.

### keys

```ts
keys: string[]
```

Flattened config paths produced by this source.

## LoadedConfig

```ts
interface LoadedConfig<T = unknown> {
```

Result returned from `loadConfig()`.

### value

```ts
value: T
```

Validated config value, including defaults applied by the schema.

### sources

```ts
sources: ConfigSourceReport[]
```

Per-source load metadata in the same order as `sources`.

### get

```ts
get(path: string): unknown
```

Read a dotted path from the validated config value.

## ConfigError

```ts
class ConfigError extends Error {
```

Error thrown when loading or validating config fails.

### issues

```ts
issues: ValidationIssue[]
```

Validation issues when the failure came from `fino:validate`.

### constructor

```ts
constructor(message: string, issues: ValidationIssue[] = [])
```

## loadConfig

```ts
async function loadConfig<T = unknown>(options: LoadConfigOptions<T>): Promise<LoadedConfig<T>>
```

Load, merge, coerce, and validate config from an explicit source list.

Source order is the precedence model: later sources override earlier sources.
The returned `value` is the post-validation object.
