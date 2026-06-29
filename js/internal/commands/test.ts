/**
 * internal/commands/test — internal runtime module.
 *
 * Builds the `fino test` command. Arguments may be direct files, directories,
 * or simple glob patterns. Matching test modules are imported for registration
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

import { cwd } from '../../process.ts';
import { Task } from '../../task.ts';
import { DiskFileSystem } from 'fino:file';
import { allowInternalForTests } from 'internal:loader-hooks';

function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}

function isTestModuleFile(path: string): boolean {
  return path.endsWith('.test.ts');
}

/**
 * Expand a single CLI argument into a list of absolute file paths to import.
 *
 * - If the argument contains `*` or `?` it is treated as a glob pattern
 *   rooted at cwd.
 * - If the argument ends with `/` or has no file extension it is treated as a
 *   directory and expanded to matching `.test.ts` files within it.
 * - Otherwise it is returned as a direct file path.
 */
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir  = arg.endsWith('/') || !/\.[^/]+$/.test(arg);

  if (!isGlob && !isDir) {
    return [arg];
  }

  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.test.ts';
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
 * expand to matching `.test.ts` files, glob inputs are resolved from the
 * current working directory, and direct files are imported as given. When an
 * expanded input set contains `.test.ts` modules, non-test helper modules are
 * ignored. `--filter` is optional and forwards a substring filter to the test
 * runner. `--durations` adds TAP duration metadata to every result line. The
 * command throws when no files are supplied or expansion finds no test files.
 *
 * ```js
 * import { createTestCommand } from 'internal:commands/test';
 * const test = createTestCommand();
 * await test.parse(['--filter', 'socket', 'tests/net']);
 * ```
 *
 * @returns A configured `Task` instance for `fino test`.
 * @internal
 */
export function createTestCommand(): Task {
  return new Task({
    name: 'test',
    description: 'Run test files',
    outputMode: 'both',
    run: async function runTestCommand(input: { files?: unknown[]; filter?: unknown; 'show-output'?: unknown; durations?: unknown }, ctx) {
      const testFiles = Array.isArray(input.files) ? input.files : [];
      const filter = typeof input.filter === 'string' ? input.filter : undefined;
      const showOutput = typeof input['show-output'] === 'string' ? input['show-output'] : 'failures';
      const durations = input.durations === true;
      if (showOutput !== 'failures' && showOutput !== 'always' && showOutput !== 'never') {
        throw new Error(`Invalid --show-output value "${showOutput}" (expected failures, always, or never)`);
      }
      if (testFiles.length === 0) {
        throw new Error('fino test: no test files specified');
      }

      allowInternalForTests();

      const expandedFiles: string[] = [];
      for (const raw of testFiles) {
        const expanded = await expandArg(String(raw));
        expandedFiles.push(...expanded);
      }
      const importFiles = expandedFiles.some(isTestModuleFile)
        ? expandedFiles.filter(isTestModuleFile)
        : expandedFiles;
      for (const file of importFiles) await import(normalizeModuleSpecifier(file));
      if (importFiles.length === 0) {
        throw new Error(`fino test: no test files matched ${testFiles.map(String).join(', ')}`);
      }

      const { run } = await import('fino:test/test');
      const output = await run(filter === undefined ? { showOutput, durations } : { filter, showOutput, durations });
      if (ctx.writer.mode === 'json') {
        const result = { command: 'test', ok: true, files: testFiles.map(String), imported: importFiles, filter, showOutput, durations, output };
        await ctx.writer.writeJson(result);
        return result;
      }
      return output;
    },
    cli: {
      options: [
        { flags: '--filter', type: 'string', description: 'Run only describe groups whose full path contains the filter text' },
        { flags: '--show-output', type: 'string', description: 'Show captured console output: failures, always, or never' },
        { flags: '--durations', type: 'boolean', description: 'Annotate TAP result lines with duration metadata' },
      ],
      positionals: [
        { name: 'files', type: 'string', multiple: true, required: true, description: 'Test files to import and run' },
      ],
    },
  });
}
