---
weight: 30
---
# CLI

The `fino` command runs scripts, tests, benchmarks, package installs, docs, and
interactive sessions.

## Run a Script

Run an given entrypoint:

```sh
fino app.mts
```

Accepts TypeScript or ESM files.

Arguments after the script path are passed to the script:

```sh
fino app.mts -- --config ./config.toml
```

Use `--` before option-like script arguments. Options before `--` belong to
the Fino command parser. The `run` command follows the same rule:

```sh
fino run app.mts -- --config ./config.toml
```

Use watch mode while editing. Fino watches the modules imported by the entry
program and restarts when one changes:

```sh
fino --watch app.mts
```

Enable OpenTelemetry export with an OTLP/HTTP collector endpoint:

```sh
fino --otlp-endpoint http://127.0.0.1:4318 app.mts
```

Script inputs are single module specifiers. The root shortcut and `run` command
do not expand directories or glob patterns.

## Test

Run a test file:

```sh
fino test tests/app.test.mts
```

Or many test files:

```sh
fino test tests/**/*.test.mts
```

Passing a directory expands to matching `*.test.mts` files:

```sh
fino test tests/net
```

Filter registered tests by name:

```sh
fino test --filter websocket tests/net
```

Console output is captured by default and printed for failures. Use
`--show-output=always` for live debugging output or `--show-output=never` to
suppress captured output in failure details:

```sh
fino test --show-output=always tests/app.test.mts
```

Tests emit TAP-13 so the output can be read directly or consumed by TAP
tooling. The command imports `.test.mts` files from direct file, directory, or
glob inputs and delegates to Fino's test framework; it is not a Node
`node:test` compatibility command.

## Bench

Run a benchmark file:

```sh
fino bench benchmarks/app.bench.mjs
```

Or many benchmark files:

```sh
fino bench benchmarks/**/*.bench.mjs
```

Filter measurements by name:

```sh
fino bench --filter parse benchmarks
```

Benchmarks run adaptive measurement loops and print operations-per-second style
results. Run them in the same environment when comparing performance:

```sh
fino bench benchmarks
```

Benchmark output is human, benc.h-style text with comparison lines for groups
that contain multiple measurements. Use stable machines for numbers you intend
to compare. `FINO_BENCH_MIN_NS` is an internal test knob for shortening fixture
runs; the command does not emit JSON, return machine-readable results, or
provide a CI regression gate.

## Init

Create a `package.json`:

```sh
fino init --yes
```

Set fields explicitly when you do not want the defaults:

```sh
fino init \
  --name my-app \
  --version 0.1.0 \
  --license MIT
```

Use `--force` to replace an existing package file.

## Install

Install dependencies into `.fino/` and generate the package map used by the
module loader:

```sh
fino install
fino install some-package
```

The install command reads `package.json`, fetches packages from the npm
registry, places package contents under `.fino/packages`, and writes
`.fino/package-map.json`.

## Docs

Build the generated API and guide documentation:

```sh
fino doc build src
```

Set the title shown in generated HTML:

```sh
fino doc build --title "My API" src
```

Include private entries when auditing docs coverage:

```sh
fino doc build --include-private src
```

Search generated docs from the command line:

```sh
fino doc search websocket
```

This provides a list of matching sections or symbols.

To view expanded docs of a specific symbol:

```sh
fino doc show bench.Group.measure
```

Run documentation tests:

```sh
fino doc test src
```

## REPL

Start an interactive runtime session:

```sh
fino repl
```

Use the REPL for small experiments with runtime APIs. Put repeatable examples in
scripts or tests once they become part of a workflow.
