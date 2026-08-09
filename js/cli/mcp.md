---
weight: 42
---
# mcp

`fino mcp` serves the Fino coding tool set over the Model Context Protocol so
other coding agents and MCP-capable editors can develop with Fino. It exposes
the same tools that power [`fino code`](./code.md): documentation search and
symbol lookup, guide reading, and file listing/reading/searching — plus,
behind explicit flags, file writing and shell execution. Authored guides from
the docs build are also listed as MCP resources under `fino-doc://` URIs.

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

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `--allow-write` | boolean | Expose `write_file` and `edit_file` |
| `--allow-shell` | boolean | Expose the `shell` tool |
| `--http` | number | Serve Streamable HTTP on this port instead of stdio |
| `--docs-dir` | string | Docs build directory (default `./docs`) |

## Behavior

- Tools run relative to the working directory the server was started in.
- Mutating tools are absent unless their flag is passed — MCP clients own
  their approval UX, so exposure is the policy boundary here.
- Over stdio, the server exits when the host closes stdin; over HTTP it
  serves until the process is stopped.
- Documentation tools use the `fino doc build` index; without one they return
  instructions for creating it.
