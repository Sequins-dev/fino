---
weight: 35
---
# Project Tasks

`fino task` loads project-local task modules and delegates the remaining argv to
that task tree:

```sh
fino task build --name api
```

By default it reads direct source files from `tasks/`. Use `--dir` before the
task name to load another directory:

```sh
fino task --dir scripts deploy
```

Each direct task file must default-export a `Task`:

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

Supported extensions are `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, and `.cjs`.
Hidden files, declaration files, and subdirectories are ignored. Duplicate task
names, invalid default exports, missing directories, and empty task directories
are command errors.

Import the default task from `fino:commands/task` to mount the loader in another
command tree.
