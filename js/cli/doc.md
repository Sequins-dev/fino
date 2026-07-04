---
weight: 38
---
# doc

`fino doc` is the documentation workflow for Fino-style modules and guide
pages. Use it to turn markdown guides and markdown-first TypeScript comments
into generated API references, searchable HTML, and example tests. The same
command also searches generated docs and displays individual symbols from the
generated database.

```sh
fino doc build --types runtime-builtins.d.ts js
```

Use `--types runtime-builtins.d.ts` when documenting this repository so
synthetic public modules such as `fino:ffi` and `fino:profiler` are included.
Generated output is written under `docs/`, which is ignored by git. Build the
docs before using `show`, `search`, or reviewing rendered guide structure.

Invoking `fino doc` without a subcommand runs the same build path as
`fino doc build`.

## build

Build generated documentation from source files, source directories, glob
patterns, and markdown guides. This is the command to run after changing public
comments, guide pages, or declaration files:

```sh
fino doc build js
fino doc build --format html --title "Fino Runtime" js
fino doc build --include-private --types runtime-builtins.d.ts js
```

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | yes | Source files, directories, or glob patterns to document. |
| `--format` | flag | `markdown`, `html`, or `both` | no | Output format. Defaults to `markdown`. |
| `--title` | flag | string | no | Title used for generated HTML pages. |
| `--include-private` | flag | boolean | no | Include private and internal declarations. |
| `--types` | flag | string, repeatable | no | Additional declaration files, directories, or globs to merge into API docs. |

`--format=html` writes browsable HTML plus the search database. `--format=both`
writes both markdown and HTML output. `--include-private` is useful for docs
coverage audits but should not be used for public docs output.

## show

Print one documented symbol as Markdown. Use this to inspect how a module,
class, method, or generated symbol will read without opening the full HTML
site:

```sh
fino doc show bench.Group.measure
```

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `symbol` | argument | string | yes | Symbol id or name to display. |

`show` reads generated docs data, so run `fino doc build` first when source
comments have changed.

## search

Search generated docs from the command line. Use this when checking whether a
concept is discoverable by the words users are likely to type:

```sh
fino doc search websocket
fino doc search task parse
```

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `query...` | argument | strings | yes | Search terms. Multiple words are joined into one query. |

Search returns matching modules, symbols, guides, and sections from the
generated docs database.

## test

Run runnable fenced examples from documentation comments. This keeps examples
in API comments honest without requiring each snippet to be duplicated in a
hand-written test file:

```sh
fino doc test js
```

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `files...` | argument | strings | yes | Source files, directories, or glob patterns whose documentation examples should be tested. |

Runnable examples are imported into isolated realms. Examples marked with
non-runnable metadata are ignored, and examples marked as throwing are expected
to reject.
