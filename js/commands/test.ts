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
 * TAP output. With `--parallel`, each file runs in an isolated Realm and
 * returns a structured result whose top-level entries are merged into the
 * ordinary root TAP document. Top-level group execution defaults to ten
 * groups per configured reactor thread. `FINO_TEST_CONCURRENCY` changes that
 * per-reactor multiplier. At most one group executes per file Realm. A
 * completed file admits the next file Realm into the bounded live window.
 *
 * Parallel output remains TAP 13 and has the same top-level shape as serial
 * execution. Completed groups emit atomically in completion order by default,
 * preventing output interleaving without hiding progress behind an earlier
 * long-running group. `--ordered` instead emits groups in deterministic
 * registration order. Both modes enforce the same in-flight cap.
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
import { cwd, env } from '../process.ts';
import { Task } from '../task.ts';
import { DiskFileSystem } from 'fino:file';
import { Realm } from 'fino:realm';
import { allowInternalForTests } from 'internal:loader-hooks';
import { startCoverage } from 'internal:coverage';
import { formatDurationMs } from 'internal:duration';
import { ConcurrentTaskChannel } from 'internal:concurrent-task-channel';
import { captureProcessOutput } from 'internal:runtime/output-capture';
import { timeout as loopTimeout } from 'internal:runtime/loop';
import { configuredReactorThreadCount } from 'internal:scheduler/readiness';
import type runTestFile from '../internal/test-worker.ts';
import type {
  TestFileCompletion,
  TestFileCompletionAck,
  TestFileRegistration,
  TestGroupCompletion,
  TestGroupResult,
  TestGroupStart,
} from '../internal/test-worker.ts';

type PreparedTestDiagnostic = TestGroupResult['diagnostics'][number];
type ParallelShowOutputMode = NonNullable<Parameters<typeof runTestFile>[1]['showOutput']>;
type ParallelLineWriter = (line?: string) => void;

const DEFAULT_PARALLEL_GROUPS_PER_REACTOR = 10;
const PARALLEL_REALM_EXIT_DIAGNOSTIC_MS = 5_000;

/**
 * Calculate the parallel test admission limit from the configured reactor pool
 * and an optional per-reactor override. There is intentionally no
 * system-independent cap.
 *
 */
function parallelTestConcurrency(reactorThreadCount: number): number {
  const configured = env.FINO_TEST_CONCURRENCY;
  const perReactor =
    configured === undefined ? DEFAULT_PARALLEL_GROUPS_PER_REACTOR : Number(configured);
  if (!Number.isSafeInteger(perReactor) || perReactor < 1) {
    throw new Error('FINO_TEST_CONCURRENCY must be a positive per-reactor integer');
  }
  const concurrency = reactorThreadCount * perReactor;
  if (!Number.isSafeInteger(concurrency)) {
    throw new Error('total parallel test concurrency exceeds the safe integer range');
  }
  return concurrency;
}

interface ParallelTestFile {
  display: string;
  specifier: string;
}

interface ParallelTestResult {
  file: ParallelTestFile;
  result: TestGroupResult;
}

interface ParallelFileCompletion extends TestFileCompletion {
  callError?: string;
  realmError?: string;
}

interface PreparedParallelTest {
  file: ParallelTestFile;
  registeredTests: TestFileRegistration['tests'];
  execute(index: number): Promise<ParallelTestResult>;
  completion: Promise<ParallelFileCompletion>;
  completionReported: Promise<TestFileCompletion>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function tapName(name: string): string {
  return name
    .replace(/\\/g, '\\\\')
    .replace(/#/g, '\\#')
    .replace(/[\r\n]/g, ' ');
}

async function prepareParallelFile(
  file: ParallelTestFile,
  options: Parameters<typeof runTestFile>[1],
  signal: AbortSignal,
): Promise<PreparedParallelTest> {
  const realm = new Realm<typeof runTestFile>({
    entry: 'internal:test-worker',
  });
  const completion = realm.run();
  const abort = () => realm.terminate({ force: true });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const call = realm.call(file.specifier, options);
  const completionOutcome = completion.then(
    () => undefined,
    (error) => errorText(error),
  );
  const callOutcome = call.then(
    (result) => ({ result }),
    (error) => ({ error: errorText(error) }),
  );

  let registered = false;
  let canStart = true;
  let workerCompletion: TestFileCompletion | undefined;
  let resolveCompletionReported!: (completion: TestFileCompletion) => void;
  const completionReported = new Promise<TestFileCompletion>((resolve) => {
    resolveCompletionReported = resolve;
  });
  let resolveRegistration!: (tests: TestFileRegistration['tests']) => void;
  const registration = new Promise<TestFileRegistration['tests']>((resolve) => {
    resolveRegistration = resolve;
  });
  const finishRegistration = (tests: TestFileRegistration['tests'], startable: boolean) => {
    if (registered) return;
    registered = true;
    canStart = startable;
    resolveRegistration(tests);
  };
  const resultWaiters = new Map<number, (result: TestGroupResult) => void>();
  const failPending = (error: string) => {
    for (const resolve of resultWaiters.values()) {
      resolve({
        output: [],
        diagnostics: [],
        tests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        error,
      });
    }
    resultWaiters.clear();
  };
  const onMessage = (event: Event) => {
    const message = (event as MessageEvent).data as
      | TestFileRegistration
      | TestGroupCompletion
      | TestFileCompletion
      | undefined;
    if (message?.kind === 'fino:test:registered') {
      finishRegistration(message.tests, true);
      return;
    }
    if (message?.kind === 'fino:test:complete') {
      workerCompletion = message;
      resolveCompletionReported(message);
      realm.port.postMessage({ kind: 'fino:test:complete-ack' } satisfies TestFileCompletionAck);
      return;
    }
    if (message?.kind !== 'fino:test:result') return;
    const resolve = resultWaiters.get(message.index);
    if (resolve === undefined) return;
    resultWaiters.delete(message.index);
    resolve(message.result);
  };
  realm.port.addEventListener('message', onMessage);
  realm.port.start();
  void callOutcome.then((outcome) => {
    if ('error' in outcome) {
      finishRegistration([{ exclusive: false }], false);
      failPending(outcome.error);
    }
  });
  void completionOutcome.then((error) => {
    if (error !== undefined) {
      finishRegistration([{ exclusive: false }], false);
      failPending(error);
    }
  });
  const registeredTests = await registration;
  const fileCompletion = Promise.all([callOutcome, completionOutcome]).then(
    ([callResult, realmError]): ParallelFileCompletion => {
      signal.removeEventListener('abort', abort);
      realm.port.removeEventListener('message', onMessage);
      if (workerCompletion !== undefined) {
        return {
          ...workerCompletion,
          ...(realmError === undefined ? {} : { realmError }),
        };
      }
      return {
        ...('result' in callResult ? callResult.result : { callError: callResult.error }),
        ...(realmError === undefined ? {} : { realmError }),
      };
    },
  );

  return {
    file,
    registeredTests,
    completion: fileCompletion,
    completionReported,
    async execute(index: number): Promise<ParallelTestResult> {
      if (!canStart) {
        const [callResult, realmError] = await Promise.all([callOutcome, completionOutcome]);
        const error =
          ('error' in callResult ? callResult.error : undefined) ??
          realmError ??
          `${file.display} stopped before test execution`;
        return {
          file,
          result: {
            output: [],
            diagnostics: [],
            tests: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            error,
          },
        };
      }
      const result = new Promise<TestGroupResult>((resolve) => {
        resultWaiters.set(index, resolve);
      });
      realm.port.postMessage({ kind: 'fino:test:start', index } satisfies TestGroupStart);
      return { file, result: await result };
    },
  };
}

function printSyntheticFailure(
  write: ParallelLineWriter,
  index: number,
  name: string,
  label: string,
): void {
  write(`not ok ${index} - ${tapName(name)} ${label}`);
}

function isTapLine(line: string): boolean {
  return line === '' || /^\s*(?:#|1\.\.|(?:not )?ok \d+)/.test(line) || /^\s*Bail out!/.test(line);
}

function printParallelResult(
  result: ParallelTestResult,
  offset: number,
  diagnostics: PreparedTestDiagnostic[],
  write: ParallelLineWriter,
): number {
  for (const record of result.result.output) {
    const match = /^(not )?ok (\d+)(\s+-\s.*)$/.exec(record.text);
    if (match === null) {
      write(isTapLine(record.text) ? record.text : `# ${record.text}`);
      continue;
    }
    write(`${match[1] ?? ''}ok ${offset + Number(match[2])}${match[3]}`);
  }
  let synthetic = 0;
  if (result.result.error !== undefined) {
    synthetic++;
    const label = 'failed to load or run';
    printSyntheticFailure(
      write,
      offset + result.result.tests + synthetic,
      result.file.display,
      label,
    );
    diagnostics.push({
      title: `${result.file.display} ${label}`,
      errors: [result.result.error.split('\n')],
      output: [],
    });
  }
  diagnostics.push(...result.result.diagnostics);
  return synthetic;
}

function printParallelFailureDetails(
  diagnostics: PreparedTestDiagnostic[],
  showOutput: ParallelShowOutputMode,
  write: ParallelLineWriter,
): void {
  if (diagnostics.length === 0) return;
  write('# Failure details');
  for (let index = 0; index < diagnostics.length; index++) {
    const diagnostic = diagnostics[index]!;
    write(`# ${index + 1}) ${diagnostic.title}`);
    if (diagnostic.errors.length > 0) {
      write('# Error:');
      for (const error of diagnostic.errors) {
        for (const line of error) write(`#   ${line}`);
      }
    }
    if (showOutput === 'failures') {
      const stdout = diagnostic.output.filter((entry) => entry.fd === 1);
      const stderr = diagnostic.output.filter((entry) => entry.fd === 2);
      if (stdout.length > 0) {
        write('# Captured stdout:');
        for (const entry of stdout) write(`#   ${entry.text}`);
      }
      if (stderr.length > 0) {
        write('# Captured stderr:');
        for (const entry of stderr) write(`#   ${entry.text}`);
      }
    }
    if (index < diagnostics.length - 1) write('#');
  }
}

function parallelResultPointCount(result: ParallelTestResult): number {
  return result.result.tests + (result.result.error === undefined ? 0 : 1);
}

async function runParallelTests(
  files: ParallelTestFile[],
  options: Parameters<typeof runTestFile>[1],
  signal: AbortSignal,
  ordered: boolean,
): Promise<void> {
  const started = performance.now();
  const capture = captureProcessOutput();
  const write = capture.writeStdoutLine;
  try {
    const concurrency = parallelTestConcurrency(configuredReactorThreadCount());
    const channel = new ConcurrentTaskChannel<ParallelTestResult>(concurrency, {
      outputOrder: ordered ? 'claim' : 'completion',
    });
    write('TAP version 13');
    const output = (async () => {
      let total = 0;
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      const diagnostics: PreparedTestDiagnostic[] = [];
      for await (const entry of channel) {
        const points = parallelResultPointCount(entry);
        if (points !== 1) {
          write(
            `Bail out! ${tapName(entry.file.display)} emitted ${points} points for one admitted test group`,
          );
          throw new Error(`${entry.file.display} emitted an invalid top-level test result`);
        }
        const synthetic = printParallelResult(entry, total, diagnostics, write);
        total += entry.result.tests + synthetic;
        passed += entry.result.passed;
        failed += entry.result.failed + synthetic;
        skipped += entry.result.skipped;
      }
      return { total, passed, failed, skipped, diagnostics };
    })();

    const activeFiles = new Set<Promise<void>>();
    const pendingFiles = new Map<string, PreparedParallelTest>();
    const fileCompletions: Promise<void>[] = [];
    const taskCompletions: Promise<void>[] = [];
    const lifecycleErrors: string[] = [];
    let registeredTests = 0;
    for (const file of files) {
      while (activeFiles.size >= concurrency) await Promise.race(activeFiles);
      const test = await prepareParallelFile(file, options, signal);
      registeredTests += test.registeredTests.length;
      let fileCompletion!: Promise<void>;
      fileCompletion = test.completion
        .then((completion) => {
          if (completion.shutdownError !== undefined) {
            lifecycleErrors.push(`${file.display} shutdown failed: ${completion.shutdownError}`);
          }
          if (completion.callError !== undefined) {
            lifecycleErrors.push(`${file.display} worker failed: ${completion.callError}`);
          }
          if (completion.realmError !== undefined) {
            lifecycleErrors.push(`${file.display} Realm shutdown failed: ${completion.realmError}`);
          }
        })
        .finally(() => activeFiles.delete(fileCompletion));
      activeFiles.add(fileCompletion);
      pendingFiles.set(file.display, test);
      void fileCompletion.finally(() => pendingFiles.delete(file.display));
      void test.completionReported.then((reported) => {
        const exitDiagnostic = loopTimeout(PARALLEL_REALM_EXIT_DIAGNOSTIC_MS);
        exitDiagnostic.unref();
        void exitDiagnostic.then(() => {
          if (!pendingFiles.has(file.display)) return;
          write(
            `# Waiting for ${tapName(file.display)} test Realm to exit; active handles at worker completion: ${reported.activeHandles ?? 'unavailable'}`,
          );
        });
        void fileCompletion.finally(() => exitDiagnostic.cancel());
      });
      fileCompletions.push(fileCompletion);

      let previous: Promise<void> | undefined;
      for (let index = 0; index < test.registeredTests.length; index++) {
        const { exclusive } = test.registeredTests[index]!;
        let release!: () => void;
        const settled = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = previous;
        previous = settled;
        const resolver = channel.claim();
        const task = (async () => {
          await resolver.schedule({ exclusive, ready });
          try {
            resolver.resolve(await test.execute(index));
          } catch (error) {
            resolver.resolve({
              file: test.file,
              result: {
                output: [],
                diagnostics: [],
                tests: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                error: errorText(error),
              },
            });
          } finally {
            release();
          }
        })();
        taskCompletions.push(task);
      }
    }
    channel.close();
    await Promise.all(taskCompletions);
    const totals = await output;
    await Promise.all(fileCompletions);
    await capture.finish();
    if (totals.total !== registeredTests) {
      write(`Bail out! registered ${registeredTests} test groups but emitted ${totals.total}`);
      throw new Error('parallel test registration count changed during execution');
    }
    write(`1..${registeredTests}`);
    write('');
    write(`# tests ${totals.total}`);
    write(`# pass  ${totals.passed}`);
    if (totals.skipped > 0) write(`# skip  ${totals.skipped}`);
    write(`# time  ${formatDurationMs(performance.now() - started)}`);
    if (totals.failed > 0) {
      write(`# fail  ${totals.failed}`);
      printParallelFailureDetails(totals.diagnostics, options.showOutput ?? 'failures', write);
    }
    if (lifecycleErrors.length > 0) {
      write('# Realm lifecycle errors');
      for (const error of lifecycleErrors) {
        for (const line of error.split('\n')) write(`# ${line}`);
      }
      write('Bail out! parallel test Realm lifecycle failed');
      throw new Error('parallel test Realm lifecycle failed');
    }
    if (totals.failed > 0) {
      throw new Error(`${totals.failed} test(s) failed`);
    }
  } finally {
    await capture.finish();
  }
}
/**
 * Convert an expanded test file path into an importable module specifier.
 *
 * Absolute and cwd-relative paths become `file://` URLs; anything already
 * carrying a scheme (`file://`, `fino:`, `internal:`) passes through
 * unchanged so built-in modules can be named directly on the command line.
 */
function normalizeModuleSpecifier(path: string, base = cwd()): string {
  if (path.startsWith('file://')) return path;
  if (path.startsWith('/')) return `file://${path}`;
  if (path.startsWith('./') || path.startsWith('../')) return `file://${base}/${path}`;
  if (path.includes(':')) return path;
  return `file://${base}/./${path}`;
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
async function expandArg(arg: string, base = cwd()): Promise<string[]> {
  const isGlob = arg.includes('*') || arg.includes('?') || arg.includes('{');
  const isDir = arg.endsWith('/') || !/\.[^/]+$/.test(arg);
  if (!isGlob && !isDir) {
    return [arg];
  }
  const fs = new DiskFileSystem();
  const pattern = isGlob ? arg : arg.replace(/\/$/, '') + '/**/*.test.ts';
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
 * `duration=<time>` metadata to every TAP result line. `--parallel` runs one
 * isolated Realm per file with up to ten executing top-level groups per reactor
 * thread by default and one active group per Realm. `FINO_TEST_CONCURRENCY`
 * changes the number of groups admitted per reactor. A settled group releases its slot
 * immediately and emits as one atomic TAP block. Results emit in completion
 * order by default; `--ordered` holds later results until all earlier registered
 * groups have completed.
 * `--coverage` enables native V8 precise coverage and writes
 * `coverage/coverage.json`; use the unambiguous inline form
 * `--coverage=<path>` for another artifact location.
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
 * // Multiplex isolated test files across the process reactor pool.
 * await test.parse(['--parallel', 'tests/']);
 *
 * // Keep parallel TAP groups in deterministic registration order.
 * await test.parse(['--parallel', '--ordered', 'tests/']);
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
      parallel?: unknown;
      ordered?: unknown;
      coverage?: unknown;
    },
    ctx,
  ) {
    const testFiles = Array.isArray(input.files) ? input.files : [];
    const filter = typeof input.filter === 'string' ? input.filter : undefined;
    const showOutput = typeof input['show-output'] === 'string' ? input['show-output'] : 'failures';
    const durations = input.durations === true;
    const parallel = input.parallel === true;
    const ordered = input.ordered === true;
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
    const base = ctx.cwd ?? cwd();
    const expandedFiles: string[] = [];
    for (const raw of testFiles) {
      const expanded = await expandArg(String(raw), base);
      expandedFiles.push(...expanded);
    }
    const importFiles = expandedFiles.some(isTestModuleFile)
      ? expandedFiles.filter(isTestModuleFile)
      : expandedFiles;
    if (importFiles.length === 0) {
      throw new Error(`fino test: no test files matched ${testFiles.map(String).join(', ')}`);
    }
    const runOptions =
      filter === undefined
        ? {
            showOutput,
            durations,
          }
        : {
            filter,
            showOutput,
            durations,
          };
    let output: unknown;
    if (parallel) {
      const seen = new Set<string>();
      const parallelFiles: ParallelTestFile[] = [];
      for (const file of importFiles) {
        const specifier = normalizeModuleSpecifier(file, base);
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        parallelFiles.push({
          display: file,
          specifier,
        });
      }
      output = await runParallelTests(parallelFiles, runOptions, ctx.signal, ordered);
    } else {
      for (const file of importFiles) await import(normalizeModuleSpecifier(file, base));
      const { run } = await import('fino:test/test');
      output = await run(runOptions);
    }
    if (ctx.writer.mode === 'json') {
      const result = {
        command: 'test',
        ok: true,
        files: testFiles.map(String),
        imported: importFiles,
        filter,
        showOutput,
        durations,
        parallel,
        ordered,
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
        flags: '--parallel',
        type: 'boolean',
        description: 'Run test files in isolated concurrent Realms',
      },
      {
        flags: '--ordered',
        type: 'boolean',
        description: 'Emit parallel test groups in deterministic registration order',
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
