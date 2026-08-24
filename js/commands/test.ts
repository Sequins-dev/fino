/**
 * fino:commands/test — reusable `fino test` command task.
 *
 * Builds the `fino test` command as a `Task` from `fino:task`, so the same
 * command definition backs the root Fino CLI and can be mounted by any other
 * interface (a custom CLI, a tool surface) that speaks the Task protocol.
 *
 * Positional arguments may be direct files, directories, or glob patterns.
 * Directories expand to every `.test.ts` file beneath them, globs are
 * resolved from the current working directory, and direct files are taken
 * as given. Each matched module is dynamically imported — `describe()` and
 * `it()` calls at module top level register tests as a side effect — and
 * then execution is delegated to `run()` from `fino:test/test`, which emits
 * TAP output.
 *
 * Before importing anything the command calls `allowInternalForTests()`,
 * lifting the loader's `internal:*` import restriction so test files can
 * exercise internal modules directly.
 *
 * ```ts no_run
 * import testCommand from 'fino:commands/test';
 *
 * // Run every test under tests/net whose describe path mentions "socket".
 * await testCommand.parse(['--filter', 'socket', 'tests/net']);
 * ```
 */
import { cwd } from '../process.ts';
import { Task } from '../task.ts';
import { DiskFileSystem } from 'fino:file';
import { allowInternalForTests } from 'internal:loader-hooks';
import { startCoverage } from 'internal:coverage';
/**
 * Convert an expanded test file path into an importable module specifier.
 *
 * Absolute and cwd-relative paths become `file://` URLs; anything already
 * carrying a scheme (`file://`, `fino:`, `internal:`) passes through
 * unchanged so built-in modules can be named directly on the command line.
 */
function normalizeModuleSpecifier(path: string): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${cwd()}/${path}`;
  if (path.includes(':')) return path;
  return `file://${cwd()}/./${path}`;
}
/**
 * Whether a path follows the `*.test.ts` naming convention for test modules.
 *
 * Used after expansion to prefer test modules over helper files that happen
 * to live alongside them.
 */
function isTestModuleFile(path: string): boolean {
  return path.endsWith('.test.ts');
}
/**
 * Expand a single CLI argument into a sorted list of file paths to import.
 *
 * - If the argument contains `*`, `?`, or `{` it is treated as a glob
 *   pattern resolved against the current working directory.
 * - If the argument ends with `/` or has no file extension it is treated as
 *   a directory and expanded to every `.test.ts` file beneath it.
 * - Otherwise it is returned as-is, a single direct file path.
 *
 * Glob and directory expansions are sorted so run order is deterministic; a
 * pattern that matches nothing yields an empty list rather than throwing —
 * the command reports the error after all arguments are expanded.
 */
async function expandArg(arg: string): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir = arg.endsWith('/') || !/\.[^/]+$/.test(arg);
  if (!isGlob && !isDir) {
    return [arg];
  }
  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.test.ts';
  const base = cwd();
  const results: string[] = [];
  for await (const entry of fs.glob(pattern, {
    cwd: base,
    onlyFiles: true,
  })) {
    results.push(entry.path.toString());
  }
  results.sort();
  return results;
}
/**
 * The `test` subcommand mounted by the root Fino CLI.
 *
 * The command requires at least one positional path. Each argument is
 * expanded (directories to their `.test.ts` files, globs from the current
 * working directory, direct files as given); when the expanded set contains
 * any `.test.ts` module, non-test helper files that also matched are dropped
 * so directory and glob inputs only import real test modules. Every surviving
 * file is imported for its registration side effects, then the run is handed
 * to `run()` from `fino:test/test`.
 *
 * Options map straight onto the runner: `--filter` keeps only `describe()`
 * groups whose full path contains the given substring, `--show-output`
 * controls when captured console output is printed (`failures` — the
 * default — `always`, or `never`), and `--durations` appends
 * `duration=<time>` metadata to every TAP result line. `--coverage` enables
 * native V8 precise coverage and writes `coverage/coverage.json`; use the
 * unambiguous inline form `--coverage=<path>` for another artifact location.
 *
 * Output is TAP text by default. When invoked with a `json` writer (for
 * example `fino test --json ...`) the command instead emits a single JSON
 * object describing the run: the raw inputs, the imported files, the
 * effective options, and the runner's output.
 *
 * Throws if no files are supplied, if expansion matches no files, or if
 * `--show-output` is given an unrecognized value. Test failures do not throw
 * here — they are reported through the runner's TAP output and exit code.
 *
 * ```ts no_run
 * import test from 'fino:commands/test';
 *
 * // Everything under tests/, with per-test durations.
 * await test.parse(['--durations', 'tests/']);
 *
 * // Just the socket suites, showing console output even on success.
 * await test.parse(['--filter', 'socket', '--show-output', 'always', 'tests/net']);
 *
 * // Collect original-source coverage while running the same tests.
 * await test.parse(['--coverage=artifacts/socket.json', 'tests/net']);
 * ```
 */
const command = new Task({
  name: 'test',
  description: 'Run test files',
  outputMode: 'both',
  run: async function runTestCommand(
    input: {
      files?: unknown[];
      filter?: unknown;
      'show-output'?: unknown;
      durations?: unknown;
      coverage?: unknown;
    },
    ctx,
  ) {
    const testFiles = Array.isArray(input.files) ? input.files : [];
    const filter = typeof input.filter === 'string' ? input.filter : undefined;
    const showOutput = typeof input['show-output'] === 'string' ? input['show-output'] : 'failures';
    const durations = input.durations === true;
    const coveragePath = typeof input.coverage === 'string' ? input.coverage : undefined;
    if (showOutput !== 'failures' && showOutput !== 'always' && showOutput !== 'never') {
      throw new Error(
        `Invalid --show-output value "${showOutput}" (expected failures, always, or never)`,
      );
    }
    if (testFiles.length === 0) {
      throw new Error('fino test: no test files specified');
    }
    if (coveragePath !== undefined) await startCoverage(coveragePath);
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
    const output = await run(
      filter === undefined
        ? {
            showOutput,
            durations,
          }
        : {
            filter,
            showOutput,
            durations,
          },
    );
    if (ctx.writer.mode === 'json') {
      const result = {
        command: 'test',
        ok: true,
        files: testFiles.map(String),
        imported: importFiles,
        filter,
        showOutput,
        durations,
        coverage: coveragePath,
        output,
      };
      await ctx.writer.writeJson(result);
      return result;
    }
    return output;
  },
  cli: {
    options: [
      {
        flags: '--filter',
        type: 'string',
        description: 'Run only describe groups whose full path contains the filter text',
      },
      {
        flags: '--show-output',
        type: 'string',
        description: 'Show captured console output: failures, always, or never',
      },
      {
        flags: '--durations',
        type: 'boolean',
        description: 'Annotate TAP result lines with duration metadata',
      },
      {
        flags: '--coverage',
        type: 'string',
        implicitValue: 'coverage/coverage.json',
        description: 'Collect native V8 coverage; use --coverage=<path> for a custom JSON artifact',
      },
    ],
    positionals: [
      {
        name: 'files',
        type: 'string',
        multiple: true,
        required: true,
        description: 'Test files to import and run',
      },
    ],
  },
});
export { command as default };
