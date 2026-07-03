---
weight: 40
---
# Lint Command

`fino lint` reports diagnostics for JavaScript and TypeScript-family source
files:

```sh
fino lint src
fino lint --fix 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns. `--fix`
applies supported safe fixes and does not run formatting.

The release baseline does not include a project lint config file, a per-project
ignore file, or a configurable rule set. Missing explicit directories and
explicit glob patterns that match no supported source files are command errors.

Import the default task from `fino:commands/lint` to reuse linting.
