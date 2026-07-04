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

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | no | Files, directories, or glob patterns to format. |
| `--check` | flag | boolean | no | Report files that would change without writing them. |

Source discovery accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
and `.tsx`. Hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `docs`,
`target`, and `coverage` are skipped.

There is no project formatter config file or option matrix in this release
baseline. Missing explicit directories and explicit glob patterns that match no
supported source files are command errors.

