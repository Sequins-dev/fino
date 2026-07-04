---
weight: 40
---
# lint

`fino lint` reports diagnostics for JavaScript and TypeScript-family source
files:

```sh
fino lint src
fino lint --fix 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns.

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `files...` | no | Files, directories, or glob patterns to lint. |

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| `--fix` | boolean | Apply supported safe lint fixes without running formatting. |

Source discovery accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
and `.tsx`. Hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `docs`,
`target`, and `coverage` are skipped.

The release baseline does not include a project lint config file, a
per-project ignore file, or a configurable rule set. Missing explicit
directories and explicit glob patterns that match no supported source files are
command errors.

## Reuse

Import the default task from `fino:commands/lint` to reuse linting:

```ts no_run
import lint from 'fino:commands/lint';

await lint.parse(['--fix', 'src']);
```
