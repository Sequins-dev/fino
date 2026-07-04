---
weight: 31
---
# run

`fino run` executes one TypeScript or ESM entry module. The root shortcut
`fino <script>` uses the same command path, so these forms are equivalent:

```sh
fino run app.ts
fino app.ts
```

The command accepts a single module specifier. Relative and bare path-like
inputs are resolved from the current working directory and imported through the
runtime loader. Directories and glob patterns are not expanded.

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `script` | yes | Module specifier or path to execute. |
| `args...` | no | Arguments passed to the script after the script name. |

Arguments after the script name belong to the script. A `--` separator is not
required:

```sh
fino run app.ts --config ./config.toml
```

Use `--` only when you need to stop Fino option parsing before the entrypoint.
For example, `fino run -- --flag-shaped-file.ts` treats
`--flag-shaped-file.ts` as the script path instead of a Fino option.

The script can read the runtime argv through `fino:process`.

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| `--watch` | boolean | Run the script in a watched realm and restart when imported files change. |
| `--otlp-endpoint` | string | Install CLI OpenTelemetry bootstrap with the given OTLP/HTTP collector endpoint. |

`--otlp-endpoint` wins over `OTEL_EXPORTER_OTLP_ENDPOINT`. Set
`OTEL_SDK_DISABLED=true` to disable CLI OpenTelemetry bootstrap entirely. Realms
constructed by the script inherit the CLI endpoint by default. Pass
`otlpEndpoint` to `new Realm(...)` to override the collector for a child realm,
or pass `false` to disable CLI OpenTelemetry bootstrap for that child.

## Reuse

Import the default task from `fino:commands/run` to mount or invoke this command
from another task tree:

```ts no_run
import run from 'fino:commands/run';

await run.parse(['server.ts', '--port', '3000']);
```
