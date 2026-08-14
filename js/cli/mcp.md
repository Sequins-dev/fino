---
weight: 42
---
# mcp

`fino mcp` serves the Fino-specific development tools over the Model Context
Protocol so other coding agents and MCP-capable editors can develop with Fino.
It deliberately exposes only what a host cannot already do for itself: generic
file listing, reading, and searching stay with the client, while `fino mcp`
provides the Fino documentation index and Fino's own commands. Authored guides
from the docs build are listed as MCP resources under `fino-doc://` URIs.

By default the server speaks newline-delimited JSON-RPC over the process's
stdio, which is the transport MCP hosts use to launch server commands:

```json
{
  "mcpServers": {
    "fino": { "command": "fino", "args": ["mcp"] }
  }
}
```

```sh
fino mcp                             # stdio, read-only tools
fino mcp --allow-write --allow-shell # full tool set
fino mcp --http 8090                 # Streamable HTTP on 127.0.0.1:8090/mcp
```

## Tools

| Tool | Gate | Description |
| --- | --- | --- |
| `docs_search` | always | Full-text search the `fino doc build` index |
| `docs_show` | always | Generated API reference for one symbol |
| `fino_lint` | always | Lint the project and report diagnostics |
| `write_file` | `--allow-write` | Create or overwrite a file |
| `edit_file` | `--allow-write` | Replace text in a file |
| `fino_fmt` | `--allow-write` | Format sources, or `check` what would change |
| `fino_install` | `--allow-write` | Install npm packages into `.fino` |
| `fino_init` | `--allow-write` | Scaffold a `package.json` |
| `shell` | `--allow-shell` | Run a shell command |
| `fino_test` | `--allow-shell` | Run the test runner and return TAP output |
| `fino_bench` | `--allow-shell` | Run the benchmark runner |

`fino_lint` gains a `fix` parameter under `--allow-write`; without it the tool
is strictly read-only.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `--allow-write` | boolean | Expose the tools that change files: `write_file`, `edit_file`, `fino_fmt`, `fino_install`, `fino_init` |
| `--allow-shell` | boolean | Expose the tools that execute code: `shell`, `fino_test`, `fino_bench` |
| `--http` | number | Serve Streamable HTTP on this port instead of stdio |
| `--docs-dir` | string | Docs build directory (default `./docs`) |

## Behavior

- Tools run relative to the working directory the server was started in.
- Mutating tools are absent unless their flag is passed — MCP clients own
  their approval UX, so exposure is the policy boundary here.
- `fino_test` and `fino_bench` sit behind `--allow-shell` because importing and
  running project code is equivalent in risk to running a shell command.
- Each `fino_*` tool spawns the `fino` binary as a child process, so its full
  stdout and stderr come back as the tool result and every run gets a fresh
  isolate.
- Over stdio, the server exits when the host closes stdin; over HTTP it
  serves until the process is stopped.
- Documentation tools use the `fino doc build` index; without one they return
  instructions for creating it.
