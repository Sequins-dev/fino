---
weight: 39
---
# fmt

`fino fmt` applies Fino's built-in formatter to JavaScript and
TypeScript-family source files. Use it before committing code or in CI with
`--check` when you want formatting drift reported without modifying files:

```sh
fino fmt src
fino fmt --check 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns. A
directory input formats supported source files below that directory using the
same discovery rules as the default scan.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `files...` | strings | Files, directories, or glob patterns to format. |
| `--check` | boolean | Report files that would change without writing them. |

Source discovery accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
and `.tsx`. Hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `docs`,
`target`, and `coverage` are skipped.

There is no project formatter config file or option matrix in this release
baseline. Missing explicit directories and explicit glob patterns that match no
supported source files are command errors.

Use `--check` in scripts that should fail on unformatted code:

```sh
fino fmt --check src tests
```
