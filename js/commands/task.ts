/**
 * fino:commands/task — reusable project-local task command loader.
 *
 * Implements the `fino task` subcommand: it turns a project's `tasks/`
 * directory into a CLI command tree at runtime. Every direct file in the
 * directory with a script extension (`.ts`, `.mts`, `.cts`, `.js`, `.mjs`,
 * `.cjs`) must default-export one `Task` from `fino:task`; dotfiles and
 * `.d.ts` declarations are skipped, and subdirectories are not searched.
 * Discovered tasks are mounted as children of a generated root whose CLI name
 * is `fino task`, and the remaining argv (task name, options, positionals) is
 * delegated to that tree — so `fino task build --watch` behaves as if `build`
 * were a built-in command. Running `fino task` with no arguments prints the
 * generated root's help, which lists every discovered task.
 *
 * Task files are imported in lexicographic path order, and each task name may
 * appear only once across the directory: a duplicate name is a hard error
 * naming both files. Default exports are recognized by the shared
 * `Symbol.for('fino.task')` brand rather than `instanceof`, so tasks
 * constructed by a different copy of the `fino:task` module still qualify.
 *
 * Output follows the standard task writer contract. When the invoking CLI
 * requested JSON (`--json`), the caller's JSON writer is passed through to the
 * project task unchanged; in text mode the loader substitutes a writer that
 * writes directly to process stdout and flushes after every chunk, so
 * long-running tasks stream output incrementally.
 *
 * ```ts no_run
 * // tasks/build.ts — one project task file, run as `fino task build`
 * import { task } from 'fino:task';
 *
 * export default task({
 *   name: 'build',
 *   description: 'Compile the project',
 *   cli: { options: [{ flags: '--watch', type: 'boolean' }] },
 *   run: async (input: { watch?: boolean }, ctx) => {
 *     await ctx.writer.writeText(`building (watch=${input.watch ?? false})\n`);
 *   },
 * });
 * ```
 *
 * ```ts no_run
 * // Embedding the command in another CLI surface.
 * import taskCommand from 'fino:commands/task';
 *
 * await taskCommand.parse(['build', '--watch']);
 * ```
 *
 */
import { Task } from '../task.ts';
import type { TaskOutputWriter } from '../task.ts';
import { cwd, stdout } from '../process.ts';
import { DiskFileSystem } from '../file/fs.ts';
import { resolve } from '../file/path.ts';
const TASK_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const TASK_BRAND = Symbol.for('fino.task');
const TEXT_ENCODER = new TextEncoder();
function fileUrlFromPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (const byte of bytes) {
    if (
      byte === 47 ||
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      byte === 45 ||
      byte === 46 ||
      byte === 95 ||
      byte === 126
    ) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return 'file://' + encoded;
}
function hasTaskExtension(name: string): boolean {
  if (name.startsWith('.') || name.endsWith('.d.ts')) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && TASK_EXTENSIONS.has(name.slice(dot));
}
function resolveTaskDirectory(raw: unknown): string {
  const value = typeof raw === 'string' && raw.length > 0 ? raw : 'tasks';
  return resolve(cwd(), value).toString();
}
function isTask(value: unknown): value is Task {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[TASK_BRAND] === true
  );
}
function makeCliWriter(mode: 'text' | 'json', writer: TaskOutputWriter): TaskOutputWriter {
  if (mode === 'json') return writer;
  return {
    mode: 'text',
    async writeText(chunk: string) {
      const out = stdout();
      await out.write(TEXT_ENCODER.encode(chunk));
      await out.flush();
    },
  };
}
async function discoverTaskFiles(dirPath: string): Promise<string[]> {
  const fs = new DiskFileSystem();
  let dir;
  try {
    dir = await fs.dir(dirPath);
  } catch {
    throw new Error(`fino task: no tasks directory found at ${dirPath}`);
  }
  const files: string[] = [];
  for await (const entry of dir) {
    if (entry.isFile() && hasTaskExtension(entry.name)) files.push(entry.path.toString());
  }
  files.sort();
  if (files.length === 0) throw new Error(`fino task: no task files found in ${dirPath}`);
  return files;
}
async function importTaskFile(path: string): Promise<Task> {
  const mod = (await import(fileUrlFromPath(path))) as {
    default?: unknown;
  };
  if (!isTask(mod.default)) throw new Error(`fino task: ${path} must default-export a Task`);
  return mod.default;
}
async function loadTaskRoot(dirPath: string): Promise<Task> {
  const files = await discoverTaskFiles(dirPath);
  const children: Task[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const task = await importTaskFile(file);
    const previous = seen.get(task.name);
    if (previous !== undefined)
      throw new Error(
        `fino task: Duplicate task "${task.name}" exported by ${previous} and ${file}`,
      );
    seen.set(task.name, file);
    children.push(task);
  }
  let root: Task;
  root = new Task({
    name: 'task',
    description: `Project tasks from ${dirPath}`,
    outputMode: 'both',
    cli: { name: 'fino task' },
    children,
    run: async function runGeneratedTaskRoot() {
      return root.help();
    },
  });
  return root;
}
/**
 * The `task` subcommand mounted by the root Fino CLI.
 *
 * Accepts `--dir` to select the directory containing task modules (default
 * `tasks`, resolved against the process working directory) and forwards every
 * remaining token to the loaded task tree. Unknown options are allowed at this
 * level and `--help` is not intercepted, so both flow through to the selected
 * project task — `fino task build --help` prints the help of `build`, not of
 * the loader.
 *
 * Execution fails with an error if the directory does not exist, contains no
 * task files, a file does not default-export a `Task`, or two files export
 * tasks with the same name.
 *
 * ```ts no_run
 * import taskCommand from 'fino:commands/task';
 *
 * // Equivalent to running `fino task deploy --env prod` from the shell.
 * await taskCommand.parse(['--dir', 'ops/tasks', 'deploy', '--env', 'prod']);
 * ```
 *
 */
const command = new Task({
  name: 'task',
  description: 'Run project-local tasks from a tasks directory',
  outputMode: 'both',
  cli: {
    allowUnknown: true,
    allowHelp: false,
    options: [
      {
        flags: '--dir',
        type: 'string',
        description: 'Directory containing task modules',
      },
    ],
    positionals: [
      {
        name: 'args',
        type: 'string',
        multiple: true,
        description: 'Task command and arguments',
      },
    ],
  },
  run: async function runTaskCommand(
    input: {
      dir?: unknown;
      args?: unknown;
    },
    ctx,
  ) {
    const dirPath = resolveTaskDirectory(input.dir);
    const root = await loadTaskRoot(dirPath);
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const writer = makeCliWriter(ctx.writer.mode, ctx.writer);
    return await root.parse(args, {
      outputMode: ctx.writer.mode,
      writer,
      signal: ctx.signal,
      env: ctx.env,
      cwd: ctx.cwd,
      prompt: ctx.prompt,
    });
  },
});
export { command as default };
