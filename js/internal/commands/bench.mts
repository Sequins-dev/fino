/**
 * internal/commands/bench — internal runtime module.
 *
 * Builds the `fino bench` command. The command imports one or more benchmark
 * modules, then delegates execution to `fino:bench`. Paths are normalized to
 * file URLs so direct paths, relative paths, absolute paths, and already
 * canonical specifiers all resolve through the runtime loader.
 *
 * This module is CLI-only and is not intended for application imports.
 *
 * ```js
 * import { createBenchCommand } from 'internal:commands/bench';
 * const command = createBenchCommand();
 * console.log(command.name);
 * ```
 *
 * @internal
 */

import { cwd } from '../../process.mts';
import { Task } from '../../task.mts';
import { DiskFileSystem } from '../../file/fs.mts';

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
 * Glob arguments resolve from cwd. Directory-like arguments expand to
 * descendant `.bench.mts` files. Direct file paths and non-file specifiers are
 * returned unchanged so the loader keeps handling them.
 */
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir  = arg.endsWith('/') || !/\.[^/]+$/.test(arg);

  if (!isGlob && !isDir) {
    return [arg];
  }

  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.bench.mts';
  const base    = cwd();
  const results: string[] = [];

  for await (const entry of fs.glob(pattern, { cwd: base, onlyFiles: true })) {
    results.push(entry.path.toString());
  }

  results.sort();
  return results;
}

/**
 * Create the `bench` subcommand used by the root Fino CLI.
 *
 * The returned command requires at least one positional benchmark file. It
 * imports each file for registration side effects and then calls
 * `fino:bench.run()`. `--filter` is optional; when provided, only benchmark
 * groups whose full path contains the filter text are run. The command throws
 * when no files are supplied or expansion finds no benchmark files and
 * otherwise returns the result of the benchmark runner.
 *
 * ```js
 * import { createBenchCommand } from 'internal:commands/bench';
 * const bench = createBenchCommand();
 * await bench.parse(['--filter', 'parser', 'benchmarks/parser.bench.mjs']);
 * ```
 *
 * @returns A configured `Task` instance for `fino bench`.
 * @internal
 */
export function createBenchCommand(): Task {
  return new Task({
    name: 'bench',
    description: 'Run benchmark files',
    outputMode: 'both',
    run: async function runBenchCommand(input: { files?: unknown[]; filter?: unknown }, ctx) {
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
        const result = { command: 'bench', ok: true, files: benchFiles.map(String), imported: importedFiles, filter, output };
        await ctx.writer.writeJson(result);
        return result;
      }
      return output;
    },
    cli: {
      options: [
        { flags: '--filter', type: 'string', description: 'Run only benchmark groups whose full path contains the filter text' },
      ],
      positionals: [
        { name: 'files', type: 'string', multiple: true, required: true, description: 'Benchmark files to import and run' },
      ],
    },
  });
}
