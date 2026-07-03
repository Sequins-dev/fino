---
weight: 39
---
# Format Command

`fino fmt` formats JavaScript and TypeScript-family source files:

```sh
fino fmt src
fino fmt --check 'src/**/*.ts'
```

With no file inputs, the command recursively scans the current working
directory. Explicit inputs can be files, directories, or glob patterns. Source
discovery skips hidden directories and common dependency, generated, cache, and
build-output directories such as `node_modules`, `dist`, `build`, `target`, and
`coverage`.

There is no project formatter config file or option matrix in this release
baseline. Missing explicit directories and explicit glob patterns that match no
supported source files are command errors.

Import the default task from `fino:commands/fmt` to reuse formatting.
