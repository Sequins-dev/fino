/**
* fino:commands/bench — reusable `fino bench` command task.
*
* Builds the `fino bench` command. Positional arguments may be direct files,
* directories, or glob patterns: directory-like arguments (trailing `/` or no
* file extension) expand to descendant `.bench.ts` files, globs resolve from
* the current working directory, and direct paths or already-canonical
* specifiers pass through untouched. Every matched module is imported for its
* `bench()` registration side effects, then execution is delegated to
* `fino:bench`, which prints measurements to stdout.
*
* Paths are normalized to `file://` URLs before import so direct, relative,
* and absolute paths all resolve through the runtime loader. Import this
* module when another interface needs to mount the built-in benchmark runner
* as a `Task` — the root Fino CLI does exactly that.
*
* ```ts no_run
* import benchCommand from 'fino:commands/bench';
*
* // Run every benchmark under ./benchmarks, as `fino bench benchmarks/` would.
* await benchCommand.parse(['benchmarks/']);
* ```
*
*/
import { cwd } from '../process.ts';
import { Task } from '../task.ts';
import { DiskFileSystem } from '../file/fs.ts';
/**
* Convert a CLI path argument into a specifier the module loader accepts.
*
* `file://` URLs and specifiers that already carry a scheme (anything
* containing `:`) pass through unchanged. Absolute paths become `file://`
* URLs directly; relative and bare paths are resolved against the current
* working directory first.
*/
function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}
/**
* Expand a single CLI argument into benchmark files to import.
*
* Glob arguments (containing `*`, `?`, or `{`) resolve from cwd. Directory-like
* arguments — trailing `/` or no file extension — expand to descendant
* `.bench.ts` files. Direct file paths and non-file specifiers are returned
* unchanged so the loader keeps handling them. Expanded matches are sorted for
* a deterministic run order.
*/
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir = arg.endsWith('/') || !/\.[^/]+$/.test(arg);
  if (!isGlob && !isDir) {
    return [arg];
  }
  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.bench.ts';
  const base = cwd();
  const results: string[] = [];
  for await (const entry of fs.glob(pattern, {
    cwd: base,
    onlyFiles: true
  })) {
    results.push(entry.path.toString());
  }
  results.sort();
  return results;
}
/**
* The `bench` subcommand used by the root Fino CLI.
*
* Requires at least one positional benchmark file. Each argument is expanded
* (globs, directories) and imported for registration side effects, then
* `fino:bench`'s `run()` executes every registered benchmark group and prints
* measurements to stdout. `--filter` is optional; when provided, only
* benchmark groups whose full path contains the filter text are run.
*
* Throws when no files are supplied or when expansion finds no benchmark
* files. In JSON output mode the command writes a summary object recording
* the requested files, the modules actually imported, and the active filter;
* the measurements themselves are always printed by the runner rather than
* returned.
*
* ```ts no_run
* import bench from 'fino:commands/bench';
*
* // Equivalent to `fino bench --filter parser benchmarks/parser.bench.ts`
* await bench.parse(['--filter', 'parser', 'benchmarks/parser.bench.ts']);
* ```
*
*/
const command = new Task({
    name: 'bench',
    description: 'Run benchmark files',
    outputMode: 'both',
    run: async function runBenchCommand(input: {
      files?: unknown[];
      filter?: unknown;
    }, ctx) {
      const benchFiles = Array.isArray(input.files) ? input.files : [];
      const filter = typeof input.filter === 'string' ? input.filter : undefined;
      if (benchFiles.length === 0) {
        throw new Error('fino bench: no benchmark files specified');
      }
      const importedFiles: string[] = [];
      for (const raw of benchFiles) {
        const expanded = await expandArg(String(raw));
        for (const file of expanded) {
          await import(normalizeModuleSpecifier(file));
          importedFiles.push(file);
        }
      }
      if (importedFiles.length === 0) {
        throw new Error(`fino bench: no benchmark files matched ${benchFiles.map(String).join(', ')}`);
      }
      const { run } = await import('fino:bench');
      const output = await (filter === undefined ? run({}) : run({ filter }));
      if (ctx.writer.mode === 'json') {
        const result = {
          command: 'bench',
          ok: true,
          files: benchFiles.map(String),
          imported: importedFiles,
          filter,
          output
        };
        await ctx.writer.writeJson(result);
        return result;
      }
      return output;
    },
    cli: {
      options: [{
        flags: '--filter',
        type: 'string',
        description: 'Run only benchmark groups whose full path contains the filter text'
      }],
      positionals: [{
        name: 'files',
        type: 'string',
        multiple: true,
        required: true,
        description: 'Benchmark files to import and run'
      }]
    }
});
export { command as default };
