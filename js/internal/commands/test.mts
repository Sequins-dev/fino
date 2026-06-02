/**
 * internal/commands/test — internal runtime module.
 *
 * Builds the `fino test` command. Arguments may be direct files, directories,
 * or simple glob patterns. Expanded test modules are imported for registration
 * side effects before execution is delegated to `fino:test/test`.
 *
 * ```js
 * import { createTestCommand } from 'internal:commands/test';
 * const command = createTestCommand();
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
 * Expand a single CLI argument into a list of absolute file paths to import.
 *
 * - If the argument contains `*` or `?` it is treated as a glob pattern
 *   rooted at cwd.
 * - If the argument ends with `/` or has no file extension it is treated as a
 *   directory and expanded to matching `.test.mts` files within it.
 * - Otherwise it is returned as-is (a direct file path).
 */
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir  = arg.endsWith('/') || !/\.[^/]+$/.test(arg);

  if (!isGlob && !isDir) {
    return [arg];
  }

  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.test.mts';
  const base    = cwd();
  const results: string[] = [];

  for await (const entry of fs.glob(pattern, { cwd: base, onlyFiles: true })) {
    results.push(entry.path.toString());
  }

  results.sort();
  return results;
}

/**
 * Create the `test` subcommand used by the root Fino CLI.
 *
 * The returned command requires at least one positional path. Directory inputs
 * expand to matching `.test.mts` files, glob inputs are resolved from the current working
 * directory, and direct files are imported as given. `--filter` is optional and
 * forwards a substring filter to the test runner. The command throws when no
 * files are supplied.
 *
 * ```js
 * import { createTestCommand } from 'internal:commands/test';
 * const test = createTestCommand();
 * await test.parse(['--filter', 'socket', 'tests/net']);
 * ```
 *
 * @returns A configured `Command` instance for `fino test`.
 * @internal
 */
export function createTestCommand(): Command {
  return new Command({
    name: 'test',
    description: 'Run test files',
    run: async function runTestCommand(ctx: CommandContext) {
      const testFiles = Array.isArray(ctx.args.files) ? ctx.args.files : [];
      const filter = typeof ctx.options.filter === 'string' ? ctx.options.filter : undefined;
      if (testFiles.length === 0) {
        throw new Error('fino test: no test files specified');
      }

      for (const raw of testFiles) {
        const expanded = await expandArg(String(raw));
        for (const file of expanded) await import(normalizeModuleSpecifier(file));
      }

      const { run } = await import('fino:test/test');
      return filter === undefined ? run({}) : run({ filter });
    },
    options: [
      { flags: '--filter', type: 'string', description: 'Run only describe groups whose full path contains the filter text' },
    ],
    positionals: [
      { name: 'files', type: 'string', multiple: true, required: true, description: 'Test files to import and run' },
    ],
  });
}
