/**
* internal/commands/task — project-local task command loader.
*
* The `fino task` command loads application tasks from a directory at runtime.
* Each direct source file in the directory default-exports one `Task`; the
* command imports those files, mounts the tasks as children of a generated root,
* and delegates the remaining argv to that task tree.
*
* ```ts no_run
* import { createTaskCommand } from 'internal:commands/task';
*
* const command = createTaskCommand();
* await command.parse(['build']);
* ```
*
* @internal
*/
import { Task } from '../../task.ts';
import type { TaskOutputWriter } from '../../task.ts';
import { cwd, stdout } from '../../process.ts';
import { DiskFileSystem } from '../../file/fs.ts';
import { resolve } from '../../file/path.ts';
const TASK_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs'
]);
const TASK_BRAND = Symbol.for('fino.task');
const TEXT_ENCODER = new TextEncoder();
function fileUrlFromPath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let encoded = '';
  for (const byte of bytes) {
    if (byte === 47 || byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte === 45 || byte === 46 || byte === 95 || byte === 126) {
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
  return value !== null && typeof value === 'object' && (value as Record<PropertyKey, unknown>)[TASK_BRAND] === true;
}
function makeCliWriter(mode: 'text' | 'json', writer: TaskOutputWriter): TaskOutputWriter {
  if (mode === 'json') return writer;
  return {
    mode: 'text',
    async writeText(chunk: string) {
      const out = stdout();
      await out.write(TEXT_ENCODER.encode(chunk));
      await out.flush();
    }
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
  const mod = await import(fileUrlFromPath(path)) as {
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
    if (previous !== undefined) throw new Error(`fino task: Duplicate task "${task.name}" exported by ${previous} and ${file}`);
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
    }
  });
  return root;
}
/**
* Create the `task` subcommand used by the root Fino CLI.
*
* The command loads direct task files from `tasks/` by default. `--dir` can
* point at another directory, and all remaining argv is delegated to the
* generated task tree.
*
* @internal
*/
export function createTaskCommand(): Task {
  return new Task({
    name: 'task',
    description: 'Run project-local tasks from a tasks directory',
    outputMode: 'both',
    cli: {
      allowUnknown: true,
      allowHelp: false,
      options: [{
        flags: '--dir',
        type: 'string',
        description: 'Directory containing task modules'
      }],
      positionals: [{
        name: 'args',
        type: 'string',
        multiple: true,
        description: 'Task command and arguments'
      }]
    },
    run: async function runTaskCommand(input: {
      dir?: unknown;
      args?: unknown;
    }, ctx) {
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
        prompt: ctx.prompt
      });
    }
  });
}
