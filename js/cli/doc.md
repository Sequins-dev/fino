---
weight: 38
---
# doc

`fino doc` builds API references and guide pages from commented source files and
markdown guides. The command also searches generated docs, displays individual
symbols, and runs documentation examples.

```sh
fino doc build --types runtime-builtins.d.ts js
```

Use `--types runtime-builtins.d.ts` when documenting this repository so
synthetic public modules such as `fino:ffi` and `fino:profiler` are included.
Generated output is written under `docs/`, which is ignored by git.

Invoking `fino doc` without a subcommand runs the same build path as
`fino doc build`.

## Shared Build Flags

These flags apply to `fino doc` and `fino doc build`.

| Flag | Value | Description |
| --- | --- | --- |
| `--format` | `markdown`, `html`, or `both` | Output format. Defaults to `markdown`. |
| `--title` | string | Title used for generated HTML pages. |
| `--include-private` | boolean | Include private and internal declarations. |
| `--types` | string, repeatable | Additional declaration files, directories, or globs to merge into API docs. |

## build

Build generated documentation from source files, source directories, glob
patterns, and markdown guides:

```sh
fino doc build js
fino doc build --format html --title "Fino Runtime" js
fino doc build --include-private --types runtime-builtins.d.ts js
```

| Argument | Required | Description |
| --- | --- | --- |
| `files...` | yes | Source files, directories, or glob patterns to document. |

`--format=html` writes browsable HTML plus the search database. `--format=both`
writes both markdown and HTML output. `--include-private` is useful for docs
coverage audits but should not be used for public docs output.

## show

Print one documented symbol as Markdown:

```sh
fino doc show bench.Group.measure
```

| Argument | Required | Description |
| --- | --- | --- |
| `symbol` | yes | Symbol id or name to display. |

`show` reads generated docs data, so run `fino doc build` first when source
comments have changed.

## search

Search generated docs from the command line:

```sh
fino doc search websocket
fino doc search task parse
```

| Argument | Required | Description |
| --- | --- | --- |
| `query...` | yes | Search terms. Multiple words are joined into one query. |

Search returns matching modules, symbols, guides, and sections from the
generated docs database.

## test

Run runnable fenced examples from documentation comments:

```sh
fino doc test js
```

| Argument | Required | Description |
| --- | --- | --- |
| `files...` | yes | Source files, directories, or glob patterns whose documentation examples should be tested. |

Runnable examples are imported into isolated realms. Examples marked with
non-runnable metadata are ignored, and examples marked as throwing are expected
to reject.

## Reuse

Import the default task from `fino:commands/doc` to reuse the full docs command
tree:

```ts no_run
import doc from 'fino:commands/doc';

await doc.parse(['build', '--format', 'markdown', 'js']);
```
