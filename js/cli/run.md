---
weight: 31
---
# Run Scripts

Use `fino run` when you want the explicit script command, or use the root
shortcut `fino <script>` for the same execution path.

```sh
fino run app.ts
fino app.ts
```

Scripts can be TypeScript or ESM modules. The command accepts one module
specifier; it does not expand directories or globs.

## Script Arguments

Arguments after the script name belong to the script:

```sh
fino run app.ts --config ./config.toml
```

The script can read the full runtime argv through `fino:process`.

## Watch And Telemetry

`--watch` runs the script in a watched realm and restarts when imported files
change:

```sh
fino run --watch server.ts
```

`--otlp-endpoint` installs CLI OpenTelemetry bootstrap around the child entry
module:

```sh
fino --otlp-endpoint http://127.0.0.1:4318 app.ts
```

Realms constructed by the script inherit the CLI endpoint by default. Pass
`otlpEndpoint` to `new Realm(...)` to override the collector for a child realm,
or pass `false` to disable CLI OpenTelemetry bootstrap for that child.

Import the default task from `fino:commands/run` to reuse this command.
