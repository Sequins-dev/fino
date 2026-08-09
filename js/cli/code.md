---
weight: 41
---
# code

`fino code` starts the Fino coding agent: an interactive terminal assistant
tuned for building applications with Fino and for developing Fino itself. It
discovers modules through the documentation index (`docs_search`, `docs_show`,
`read_doc`), reads and edits project files, runs shell commands behind
approval gates, and persists conversation threads in a SQLite store under
`.fino/code/`. With a positional prompt it runs one non-interactive turn and
prints the streamed answer instead of opening the TUI.

```sh
fino code                          # interactive TUI
fino code --plan                   # start in planning mode
fino code --continue               # resume the latest thread
fino code 'what serves HTTP?'      # one streamed turn, then exit
```

Provider credentials come from the environment: `ANTHROPIC_API_KEY` enables
Anthropic models, `OPENAI_API_KEY` and/or `OPENAI_BASE_URL` enable
OpenAI-compatible models (including local servers). `FINO_CODE_MODEL` sets the
default model id.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `prompt...` | string | Run one non-interactive turn with this prompt |
| `--model` | string | Initial model id, e.g. `claude-opus-4-8` |
| `--provider` | string | Provider for `--model` (`anthropic` or `openai`) |
| `--plan` | boolean | Start in planning mode (read-only tools) |
| `--auto` | boolean | Run gated tools without approval prompts |
| `--continue` | boolean | Continue the most recently updated thread |
| `--thread` | string | Continue a specific thread id |
| `--max-cost` | number | Abort once estimated spend exceeds this many USD |
| `--docs-dir` | string | Docs build directory (default `./docs`) |
| `--ephemeral` | boolean | Keep the session in memory instead of SQLite |

## Interactive Commands

Inside the TUI, plain text runs a turn; slash commands control the harness:

- `/model <id>` switches the model for subsequent turns; `/models` lists
  models discovered across configured providers.
- `/plan` and `/code` switch between planning mode (read-only tools, produces
  a plan) and code mode; `Shift+Tab` toggles the same.
- `/auto` toggles auto-approval of gated tools.
- `/new` starts a fresh thread; `/exit` quits.
- `Esc` cancels the running turn; the mouse wheel and `PgUp`/`PgDn` scroll.

When a gated tool (`write_file`, `edit_file`, `shell`) needs approval the turn
suspends durably and the TUI asks for a `y`/`n` decision inline.

## Documentation Index

The docs tools search the SQLite full-text index produced by `fino doc build`.
In a project without one, run:

```sh
fino doc build --types runtime-builtins.d.ts js   # in the fino repository
```

or point `--docs-dir` at an existing build. Without an index the agent still
works; the docs tools report how to create one.
