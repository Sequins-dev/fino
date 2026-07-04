---
weight: 40
---
# lint

`fino lint` runs Fino's built-in lint diagnostics over JavaScript and
TypeScript-family source files. Use it to catch supported style and correctness
issues without wiring a separate linter into the project:

```sh
fino lint src
fino lint --fix 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns. A
directory input lints supported source files below that directory using the same
discovery rules as `fino fmt`.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | no | Files, directories, or glob patterns to lint. |
| `--fix` | flag | boolean | no | Apply supported safe lint fixes without running formatting. |

Source discovery accepts `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`,
and `.tsx`. Hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `docs`,
`target`, and `coverage` are skipped.

The release baseline does not include a project lint config file, a
per-project ignore file, or a configurable rule set. Missing explicit
directories and explicit glob patterns that match no supported source files are
command errors.

Use `--fix` for fixes the linter can apply safely. It does not run formatting,
so run `fino fmt` separately when you want formatting changes too:

```sh
fino lint --fix src
fino fmt src
```
