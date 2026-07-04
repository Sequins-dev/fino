---
weight: 39
---
# fmt

`fino fmt` formats JavaScript and TypeScript-family source files:

```sh
fino fmt src
fino fmt --check 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns.

## Arguments

| Argument | Required | Description |
| --- | --- | --- |
| `files...` | no | Files, directories, or glob patterns to format. |

## Flags

| Flag | Value | Description |
| --- | --- | --- |
| `--check` | boolean | Report files that would change without writing them. |

Source discovery accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
and `.tsx`. Hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `docs`,
`target`, and `coverage` are skipped.

There is no project formatter config file or option matrix in this release
baseline. Missing explicit directories and explicit glob patterns that match no
supported source files are command errors.

## Reuse

Import the default task from `fino:commands/fmt` to reuse formatting:

```ts no_run
import fmt from 'fino:commands/fmt';

await fmt.parse(['--check', 'src']);
```
