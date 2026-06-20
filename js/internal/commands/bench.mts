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
import { Command, type CommandContext } from '../../process/argv.mts';
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
 * @returns A configured `Command` instance for `fino bench`.
 * @internal
 */
export function createBenchCommand(): Command {
  return new Command({
    name: 'bench',
    description: 'Run benchmark files',
    run: async function runBenchCommand(ctx: CommandContext) {
      const benchFiles = Array.isArray(ctx.args.files) ? ctx.args.files : [];
      const filter = typeof ctx.options.filter === 'string' ? ctx.options.filter : undefined;
      if (benchFiles.length === 0) {
        throw new Error('fino bench: no benchmark files specified');
      }

      let imported = 0;
      for (const raw of benchFiles) {
        const expanded = await expandArg(String(raw));
        for (const file of expanded) {
          await import(normalizeModuleSpecifier(file));
          imported++;
        }
      }
      if (imported === 0) {
        throw new Error(`fino bench: no benchmark files matched ${benchFiles.map(String).join(', ')}`);
      }

      const { run } = await import('fino:bench');
      return filter === undefined ? run({}) : run({ filter });
    },
    options: [
      { flags: '--filter', type: 'string', description: 'Run only benchmark groups whose full path contains the filter text' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, required: true, description: 'Benchmark files to import and run' },
    ],
  });
}
