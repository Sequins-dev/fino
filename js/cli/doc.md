---
weight: 38
---
# Doc Command

`fino doc` builds API references and guide pages from commented source files and
markdown guides:

```sh
fino doc build --types runtime-builtins.d.ts js
```

Use `--types runtime-builtins.d.ts` when documenting this repository so
synthetic public modules such as `fino:ffi` and `fino:profiler` are included.
Generated output is written under `docs/`, which is ignored by git.

Available subcommands:

```sh
fino doc build js
fino doc show default
fino doc search command
fino doc test js
```

`--format` accepts `markdown`, `html`, or `both`. `--include-private` includes
internal and private declarations for coverage audits.

Import the default task from `fino:commands/doc` to reuse the full docs command
tree.
