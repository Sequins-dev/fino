---
weight: 30
---
# CLI

The `fino` command is built from reusable `Task` objects. The executable uses
the root task from `fino:commands/root`; applications can import individual
command tasks from `fino:commands/*` when they need to mount the same behavior
in another CLI, MCP server, agent tool set, or test harness.

## Command Map

- [`fino <script>` and `fino run`](./cli/run.md) execute TypeScript or ESM entry
  modules.
- [`fino repl`](./cli/repl.md) starts an interactive evaluation session.
- [`fino test`](./cli/test.md) imports test modules and emits TAP-13.
- [`fino bench`](./cli/bench.md) runs adaptive benchmark measurements.
- [`fino load`](./cli/load.md) load tests HTTP/1.1, HTTP/2, and HTTP/3 endpoints.
- [`fino task`](./cli/task.md) loads project-local `Task` modules.
- [`fino init`](./cli/init.md) creates a package manifest.
- [`fino install`](./cli/install.md) installs npm packages into `.fino/`.
- [`fino doc`](./cli/doc.md) builds, searches, displays, and tests docs.
- [`fino fmt`](./cli/fmt.md) formats JS and TS source.
- [`fino lint`](./cli/lint.md) reports lint diagnostics and safe fixes.

## Reuse Command Tasks

Each built-in command module default-exports a `Task`:

```ts no_run
import rootCommand from 'fino:commands/root';

await rootCommand.parse(['test', 'tests']);
```

Command tasks use the same `Task` model as application tasks from `fino:task`.
They can be listed, mounted as children, exposed as tools, or invoked directly
with a custom writer/prompt context. The `internal:commands/*` specifiers remain
compatibility aliases for the runtime itself; new code should import
`fino:commands/*`.

## Shared Behavior

`--help` is handled by the task parser and is available on the root command and
subcommands. Root-level `--otlp-endpoint` enables CLI OpenTelemetry bootstrap for
script execution, and root-level `--watch` re-runs script workloads when watched
imports change.

The root command keeps two shortcuts: bare `fino` starts the REPL, and
`fino app.ts` is equivalent to `fino run app.ts`. Tokens after the script name
belong to the script, so `fino app.ts --config app.toml` passes `--config` to
`app.ts`.
