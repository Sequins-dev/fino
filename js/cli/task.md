---
weight: 35
---
# task

`fino task` is for project-specific automation that should use the same `Task`
model as the built-in CLI. Use it for workflows such as builds, deploy steps,
fixture generation, migrations, or maintenance jobs where each command should
have typed CLI metadata, help output, and a normal task context:

```sh
fino task build --name api
```

By default it reads direct source files from `tasks/`. Each direct task file
must default-export a `Task`. The loaded tasks become children of a generated
`fino task` root, and the remaining argv is parsed by that generated task tree.

## Command Reference

| Name | Kind | Value | Required | Description |
| --- | --- | --- | --- | --- |
| `args...` | argument | strings | no | Project task name and arguments delegated to the generated task tree. |
| `--dir` | flag | string | no | Directory containing task modules. Defaults to `tasks`. |

Use `--dir` before the project task name:

```sh
fino task --dir scripts deploy
```

## Task Files

Supported extensions are `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs`.
Hidden files, declaration files, and subdirectories are ignored. Files are
sorted before import. Duplicate task names, invalid default exports, missing
directories, and empty task directories are command errors.

Task files are imported before help or execution, so they should be cheap to
load and should avoid top-level side effects beyond defining the task.

```ts no_run
import { task } from 'fino:task';

export default task({
  name: 'build',
  cli: {
    options: [{ flags: '--name', type: 'string', required: true }],
  },
  run: async (input: { name: string }, ctx) => {
    await ctx.writer.writeText(`building ${input.name}\n`);
  },
});
```

`fino task --help` imports the configured task directory and lists the loaded
tasks. `fino task build --help` shows help for the selected project task.
Importing task files executes project code, just like running an entry module.
